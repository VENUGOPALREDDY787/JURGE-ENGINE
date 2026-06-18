const Docker = require('dockerode');
const Redis = require('ioredis');
const crypto = require('crypto');
const tar = require('tar-stream');
const config = require('../config');

const docker = new Docker();
const redis = new Redis({ host: config.redis.host, port: config.redis.port, password: config.redis.password });
const CONTAINER_PREFIX = 'judge-';
const LOCK_TTL = 30000;
const RECYCLE_THRESHOLD = config.containerRecycleThreshold || parseInt(process.env.CONTAINER_RECYCLE_THRESHOLD || '20', 10);

const LANGUAGE_IMAGE_MAP = {
  java: 'judge-java-nsjail',
  python: 'judge-python-nsjail',
  javascript: 'judge-node-nsjail',
  c: 'judge-c-nsjail',
  cpp: 'judge-cpp-nsjail',
  go: 'judge-go-nsjail'
};

function getPoolSize(language) {
  const envName = `${language.toUpperCase()}_POOL_SIZE`;
  const raw = process.env[envName] || process.env.POOL_SIZE || '1';
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 10);
}

function getFreeKey(language) {
  return `free:${language}`;
}

function getContainersSetKey(language) {
  return `containers:${language}`;
}

function getMetaKey(containerName) {
  return `container:meta:${containerName}`;
}

function getLockKey(key) {
  return `locks:container:${key}`;
}

function containerNameFor(language, index) {
  return `${CONTAINER_PREFIX}${language}-${index}`;
}

function parseLanguageFromContainerName(containerName) {
  const match = containerName.match(/^judge-([a-zA-Z]+)-\d+$/);
  return match ? match[1] : null;
}

async function acquireLock(key, ttl = LOCK_TTL) {
  const value = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const start = Date.now();
  while (Date.now() - start < ttl) {
    const res = await redis.set(key, value, 'PX', ttl, 'NX');
    if (res === 'OK') return { key, value };
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function releaseLock(lock) {
  if (!lock) return;
  const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
  try {
    await redis.eval(script, 1, lock.key, lock.value);
  } catch (e) {
    // ignore release failures
  }
}

async function removeContainerRecords(containerName) {
  const language = parseLanguageFromContainerName(containerName);
  if (!language) return;
  await redis.srem(getContainersSetKey(language), containerName);
  await redis.lrem(getFreeKey(language), 0, containerName);
  await redis.del(getMetaKey(containerName));
}

async function inspectContainer(containerName) {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    return { container, info };
  } catch (e) {
    return null;
  }
}

async function getContainerInfo(containerName) {
  const inspected = await inspectContainer(containerName);
  if (!inspected) return null;
  const meta = await redis.hgetall(getMetaKey(containerName));
  return {
    name: containerName,
    container: inspected.container,
    usageCount: parseInt(meta.usageCount || '0', 10),
    status: inspected.info.State.Status,
    lastUsed: meta.lastUsed || null,
    healthStatus: inspected.info.State.Health ? inspected.info.State.Health.Status : 'unknown'
  };
}

async function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (pullErr) => {
        if (pullErr) return reject(pullErr);
        resolve();
      }, () => {});
    });
  });
}

async function cleanupStaleContainer(containerName) {
  const inspected = await inspectContainer(containerName);
  if (!inspected) {
    await removeContainerRecords(containerName);
    return;
  }

  try {
    await inspected.container.stop({ t: 1 });
  } catch (e) {
    // ignore stop errors
  }

  try {
    await inspected.container.remove({ force: true });
  } catch (e) {
    // ignore remove errors
  }

  await removeContainerRecords(containerName);
}

function getFirstAvailableIndex(existingNames, poolSize) {
  const used = new Set();
  for (const name of existingNames) {
    const match = name.match(/-(\d+)$/);
    if (match) used.add(parseInt(match[1], 10));
  }
  for (let index = 1; index <= poolSize; index += 1) {
    if (!used.has(index)) return index;
  }
  return poolSize + 1;
}

async function createContainer(containerName, image, opts = {}) {
  const language = parseLanguageFromContainerName(containerName);
  if (!language) throw new Error('invalid_container_name');

  await cleanupStaleContainer(containerName);

  const createOpts = {
    Image: image,
    name: containerName,
    Cmd: ['tail', '-f', '/dev/null'],
    Tty: false,
    HostConfig: {
      AutoRemove: false,
      NetworkMode: 'none',
      ReadonlyRootfs: false,
      SecurityOpt: ['no-new-privileges'],
      Privileged: true
    }
  };

  if (opts.memory) {
    createOpts.HostConfig.Memory = opts.memory;
  }

  if (opts.cpus) {
    createOpts.HostConfig.NanoCpus = Math.floor(opts.cpus * 1e9);
  }

  try {
    await pullImage(image);
  } catch (e) {
    // allow create to proceed even if pull fails
  }

  let container;
  try {
    container = await docker.createContainer(createOpts);
  } catch (err) {
    if (err.statusCode === 409) {
      await cleanupStaleContainer(containerName);
      container = await docker.createContainer(createOpts);
    } else {
      throw err;
    }
  }

  await container.start();
  const now = new Date().toISOString();
  await redis.sadd(getContainersSetKey(language), containerName);
  await redis.hmset(getMetaKey(containerName), { usageCount: '0', status: 'running', lastUsed: now });

  return { name: containerName, container, usageCount: 0, status: 'running', lastUsed: now };
}

async function popFreeContainer(language) {
  const freeKey = getFreeKey(language);
  while (true) {
    const containerName = await redis.rpop(freeKey);
    if (!containerName) return null;

    const info = await getContainerInfo(containerName);
    if (!info) {
      await removeContainerRecords(containerName);
      continue;
    }

    const now = new Date().toISOString();
    await redis.hmset(getMetaKey(containerName), { status: 'busy', lastUsed: now });
    return info;
  }
}

async function ensurePool(language) {
  if (!LANGUAGE_IMAGE_MAP[language]) {
    throw new Error(`Unsupported language: ${language}`);
  }

  return {
    poolSize: getPoolSize(language),
    image: LANGUAGE_IMAGE_MAP[language]
  };
}

async function acquireContainer(language, opts = {}) {
  const poolConfig = await ensurePool(language);
  const now = new Date().toISOString();

  let info = await popFreeContainer(language);
  if (info) {
    return info.name;
  }

  const lock = await acquireLock(getLockKey(`acquire:${language}`));
  if (!lock) {
    info = await popFreeContainer(language);
    return info ? info.name : null;
  }

  try {
    info = await popFreeContainer(language);
    if (info) {
      return info.name;
    }

    const existing = await redis.smembers(getContainersSetKey(language));
    if (existing.length >= poolConfig.poolSize) {
      return null;
    }

    const index = getFirstAvailableIndex(existing, poolConfig.poolSize);
    const containerName = containerNameFor(language, index);
    console.log(
  "POOL SIZE:",
  poolConfig.poolSize
);

console.log(
  "EXISTING:",
  existing.length
);

console.log(
  "CREATING:",
  containerName
);
    const created = await createContainer(containerName, poolConfig.image, opts);
    await redis.hmset(getMetaKey(containerName), { status: 'busy', lastUsed: now });
    return created.name;
  } finally {
    await releaseLock(lock);
  }
}

async function releaseContainer(containerName, options = {}) {
  const language = parseLanguageFromContainerName(containerName);
  if (!language) return;

  const lock = await acquireLock(getLockKey(`release:${containerName}`));
  if (!lock) return;

  try {
    const freeKey = getFreeKey(language);
    const metaKey = getMetaKey(containerName);
    const now = new Date().toISOString();
    const usageCount = parseInt(await redis.hget(metaKey, 'usageCount') || '0', 10);
    const shouldRecycle = options.recycle || usageCount >= RECYCLE_THRESHOLD;

    if (shouldRecycle) {
      await recycleContainer(containerName, options.opts);
      return;
    }

    await redis.hmset(metaKey, { status: 'free', lastUsed: now });
    await redis.lpush(freeKey, containerName);
  } finally {
    await releaseLock(lock);
  }
}

async function recycleContainer(containerName, opts = {}) {
  const language = parseLanguageFromContainerName(containerName);
  if (!language) return null;

  const lock = await acquireLock(getLockKey(`recycle:${containerName}`));
  if (!lock) return null;

  try {
    const inspected = await inspectContainer(containerName);
    if (inspected) {
      try {
        await inspected.container.stop({ t: 1 });
      } catch (e) {
        // ignore stop errors
      }
      try {
        await inspected.container.remove({ force: true });
      } catch (e) {
        // ignore remove errors
      }
    }

    await removeContainerRecords(containerName);
    const created = await createContainer(containerName, LANGUAGE_IMAGE_MAP[language], opts);
    const now = new Date().toISOString();
    await redis.hmset(getMetaKey(containerName), { usageCount: '0', status: 'free', lastUsed: now });
    await redis.lpush(getFreeKey(language), containerName);
    return created.name;
  } finally {
    await releaseLock(lock);
  }
}

async function incrementUsage(containerName) {
  const metaKey = getMetaKey(containerName);
  const next = await redis.hincrby(metaKey, 'usageCount', 1);
  await redis.hset(metaKey, 'lastUsed', new Date().toISOString());
  return next >= RECYCLE_THRESHOLD;
}

async function copyFilesToContainer(containerName, files) {
  const meta = await getContainerInfo(containerName);
  if (!meta) throw new Error('container_missing');

  const pack = tar.pack();
  for (const f of files) {
    pack.entry({ name: f.name, mode: 0o644 }, f.content);
  }
  pack.finalize();
  await meta.container.putArchive(pack, { path: '/workspace' });
}

async function execInContainer(containerName, cmd, opts = {}) {
  const meta = await getContainerInfo(containerName);
  if (!meta) throw new Error('container_missing');

  const execInstance = await meta.container.exec({
    Cmd: ['sh', '-lc', cmd],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: '/workspace'
  });

  const stream = await execInstance.start({ hijack: true, stdin: false });

  return await new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];

    meta.container.modem.demuxStream(stream, {
      write: (chunk) => stdout.push(chunk)
    }, {
      write: (chunk) => stderr.push(chunk)
    });

    stream.on('end', async () => {
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      const inspect = await execInstance.inspect();

      if (inspect.ExitCode !== 0) {
        const error = new Error(stderrText || `Exit code ${inspect.ExitCode}`);
        error.stdout = stdoutText;
        error.stderr = stderrText;
        return reject(error);
      }

      resolve({ stdout: stdoutText, stderr: stderrText });
    });

    stream.on('error', reject);
  });
}

async function cleanupWorkspace(containerName) {
  try {
    await execInContainer(containerName, 'rm -rf /workspace/* || true');
  } catch (e) {
    console.error(`Cleanup failed for ${containerName}:`, e.message);
  }
}

module.exports = {
  ensurePool,
  acquireContainer,
  releaseContainer,
  copyFilesToContainer,
  execInContainer,
  cleanupWorkspace,
  incrementUsage
};
