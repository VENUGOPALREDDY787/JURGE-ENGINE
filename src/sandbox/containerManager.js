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

// ---------------------------------------------------------------------------
// getMinPoolSize / getMaxPoolSize
// Replaces the old single getPoolSize(). Supports per-language overrides:
//   JAVA_MIN_POOL_SIZE / JAVA_MAX_POOL_SIZE take highest priority,
//   then global MIN_POOL_SIZE / MAX_POOL_SIZE,
//   then existing JAVA_POOL_SIZE / POOL_SIZE for backward compatibility.
// ---------------------------------------------------------------------------
function getMinPoolSize(language) {
  const envName = `${language.toUpperCase()}_MIN_POOL_SIZE`;
  const raw = process.env[envName] || process.env.MIN_POOL_SIZE || '1';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
}

function getMaxPoolSize(language) {
  const envName = `${language.toUpperCase()}_MAX_POOL_SIZE`;
  // Fallback chain: per-lang max → global max → existing per-lang size → global size → 10
  const raw = process.env[envName]
    || process.env.MAX_POOL_SIZE
    || process.env[`${language.toUpperCase()}_POOL_SIZE`]
    || process.env.POOL_SIZE
    || '10';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 10 : parsed;
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
    let info = await container.inspect();

    if (!info.State.Running) {
      console.log(`STARTING STOPPED CONTAINER: ${containerName}`);
      await container.start();
      info = await container.inspect();
    }

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

    if (!containerName) {
      return null;
    }

    const metaExists = await redis.exists(getMetaKey(containerName));

    if (!metaExists) {
      await removeContainerRecords(containerName);
      continue;
    }

    const now = new Date().toISOString();

    await redis.hmset(getMetaKey(containerName), {
      status: "busy",
      lastUsed: now
    });

    return { name: containerName };
  }
}

async function ensurePool(language) {
  if (!LANGUAGE_IMAGE_MAP[language]) {
    throw new Error(`Unsupported language: ${language}`);
  }

  return {
    minPoolSize: getMinPoolSize(language),
    maxPoolSize: getMaxPoolSize(language),
    image: LANGUAGE_IMAGE_MAP[language]
  };
}

async function acquireContainer(language, opts = {}) {
  const poolConfig = await ensurePool(language);
  const now = new Date().toISOString();

  while (true) {
    // Try to get free container first
    let info = await popFreeContainer(language);
    if (info) return info.name;

    // Lock creation/recycle for this language
    let lock = await acquireLock(
      getLockKey(`acquire:${language}`),
      5000
    );

    if (!lock) {
      await new Promise(r => setTimeout(r, 100));
      continue;
    }

    try {
      // Recheck after lock
      info = await popFreeContainer(language);
      if (info) return info.name;

 const existingCount = await redis.scard(
  getContainersSetKey(language)
);

console.log("MAX POOL SIZE:", poolConfig.maxPoolSize);
console.log("EXISTING:", existingCount);

if (existingCount < poolConfig.maxPoolSize) {
  const rawExisting = await redis.smembers(
    getContainersSetKey(language)
  );

  const index = getFirstAvailableIndex(
    rawExisting,
    poolConfig.maxPoolSize
  );

  const containerName = containerNameFor(language, index);

  console.log("CREATING:", containerName);

  const created = await createContainer(
    containerName,
    poolConfig.image,
    opts
  );

  await redis.hmset(getMetaKey(containerName), {
    status: "busy",
    lastUsed: now
  });

  return created.name;
}
      console.log("MAX POOL SIZE:", poolConfig.maxPoolSize);
      console.log("EXISTING:", existing.length);

      if (existing.length < poolConfig.maxPoolSize) {
        const index = getFirstAvailableIndex(
          existing,
          poolConfig.maxPoolSize
        );

        const containerName = containerNameFor(language, index);

        console.log("CREATING:", containerName);

        const created = await createContainer(
          containerName,
          poolConfig.image,
          opts
        );

        await redis.hmset(getMetaKey(containerName), {
          status: "busy",
          lastUsed: now
        });

        return created.name;
      }
    } finally {
      await releaseLock(lock);
    }

    // Pool full -> wait instead of fail
    await new Promise(r => setTimeout(r, 100));
  }
}

async function releaseContainer(containerName, options = {}) {
  const language = parseLanguageFromContainerName(containerName);
  if (!language) return;

  let lock = null;

  while (!lock) {
    lock = await acquireLock(
      getLockKey(`release:${containerName}`),
      5000
    );

    if (!lock) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  try {
    const freeKey = getFreeKey(language);
    const metaKey = getMetaKey(containerName);
    const now = new Date().toISOString();

    const usageCount = parseInt(
      (await redis.hget(metaKey, "usageCount")) || "0",
      10
    );

    const shouldRecycle =
      options.recycle || usageCount >= RECYCLE_THRESHOLD;

    if (shouldRecycle) {
      console.log("CALLING RECYCLE:", containerName);
      await recycleContainer(containerName, options.opts);
      return;
    }

    await redis.hmset(metaKey, {
      status: "free",
      lastUsed: now
    });

    // prevent duplicates
    await redis.lrem(freeKey, 0, containerName);
    await redis.lpush(freeKey, containerName);

  } finally {
    await releaseLock(lock);
  }
}

async function recycleContainer(containerName, opts = {}) {
  const language = parseLanguageFromContainerName(containerName);
  if (!language) return null;

  const freeKey = getFreeKey(language);

  // IMPORTANT:
  // Use SAME lock as acquireContainer
  let lock = null;

  while (!lock) {
    lock = await acquireLock(
      getLockKey(`acquire:${language}`),
      5000
    );

    if (!lock) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  try {
    const inspected = await inspectContainer(containerName);

    if (inspected) {
      try {
        await inspected.container.stop({ t: 1 });
      } catch (e) {}

      try {
        await inspected.container.remove({ force: true });
      } catch (e) {}
    }

    await removeContainerRecords(containerName);

    const created = await createContainer(
      containerName,
      LANGUAGE_IMAGE_MAP[language],
      opts
    );

    const now = new Date().toISOString();

    await redis.hmset(getMetaKey(containerName), {
      usageCount: "0",
      status: "free",
      lastUsed: now
    });

    await redis.lrem(freeKey, 0, containerName);
    await redis.lpush(freeKey, containerName);

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

// ---------------------------------------------------------------------------
// drainLanguagePool(language)
// Called by runtime.service after a successful image rebuild.
// Stops and removes every Docker container belonging to this language and
// clears all associated Redis state so the pool starts fresh.
//
// Uses the SAME acquire-lock as acquireContainer so no new container can
// be created in between — incoming jobs will queue in BullMQ and retry.
// ---------------------------------------------------------------------------
async function drainLanguagePool(language) {
  let lock = null;

  // Spin until we hold the acquire-lock for this language
  while (!lock) {
    lock = await acquireLock(getLockKey(`acquire:${language}`), 10000);
    if (!lock) await new Promise((r) => setTimeout(r, 100));
  }

  try {
    const containerSetKey = getContainersSetKey(language);
    const freeKey         = getFreeKey(language);
    const containerNames  = await redis.smembers(containerSetKey);

    console.log(`[drain] Stopping and removing ${containerNames.length} container(s) for ${language}`);

    for (const name of containerNames) {
      const inspected = await inspectContainer(name);
      if (inspected) {
        try { await inspected.container.stop({ t: 1 }); }   catch (e) { /* ignore */ }
        try { await inspected.container.remove({ force: true }); } catch (e) { /* ignore */ }
      }
      // Remove all Redis records for this container
      await removeContainerRecords(name);
    }

    // Belt-and-braces: delete the top-level set and free-list keys
    // in case any stale entries remain after individual removals.
    await redis.del(freeKey);
    await redis.del(containerSetKey);

    console.log(`[drain] Pool fully cleared for ${language}`);
  } finally {
    await releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// scaleDownPool(language)
// Called by the background idle watcher in launchWorkers.js.
// Fires only when BullMQ reports 0 waiting + 0 active jobs for a language.
//
// Removes free containers above MIN_POOL_SIZE, keeping the lowest-indexed
// containers alive (judge-<lang>-1 … judge-<lang>-MIN).
//
// Safety guarantees:
//   - Holds the same acquire-lock used by acquireContainer → mutual exclusion
//   - Aborts immediately if any container is found busy (never removes active)
//   - Non-blocking: skips this cycle if lock is unavailable (jobs being acquired)
// ---------------------------------------------------------------------------
async function scaleDownPool(language) {
  const minSize = getMinPoolSize(language);

  // Non-blocking lock attempt — if acquireContainer holds the lock, skip cycle
  const lock = await acquireLock(getLockKey(`acquire:${language}`), 5000);
  if (!lock) {
    console.log(`[autoscale] ${language}: lock busy, skipping scale-down cycle`);
    return;
  }

  try {
    const containerSetKey = getContainersSetKey(language);
    const containerNames  = await redis.smembers(containerSetKey);

    if (containerNames.length <= minSize) return; // already at or below min — nothing to do

    // Classify containers by current Redis status
    const freeContainers = [];
    for (const name of containerNames) {
      const status = await redis.hget(getMetaKey(name), 'status');
      if (status === 'busy') {
        // A job started between the queue-idle check and now — abort entirely
        console.log(`[autoscale] ${language}: found busy container ${name}, aborting scale-down`);
        return;
      }
      if (status === 'free') freeContainers.push(name);
    }

    if (freeContainers.length <= minSize) return;

    // Sort ascending by numeric suffix → keeps lowest-indexed containers alive
    freeContainers.sort((a, b) => {
      const idxA = parseInt(a.match(/-(\d+)$/)?.[1] || '0', 10);
      const idxB = parseInt(b.match(/-(\d+)$/)?.[1] || '0', 10);
      return idxA - idxB;
    });

    const toRemove = freeContainers.slice(minSize); // drop everything above minSize
    if (toRemove.length === 0) return;

    console.log(
      `[autoscale] ${language}: scaling down ${containerNames.length} → ` +
      `${containerNames.length - toRemove.length} containers (min=${minSize})`
    );

    for (const name of toRemove) {
      const inspected = await inspectContainer(name);
      if (inspected) {
        try { await inspected.container.stop({ t: 1 }); }          catch (e) { /* ignore */ }
        try { await inspected.container.remove({ force: true }); } catch (e) { /* ignore */ }
      }
      await removeContainerRecords(name); // clears Redis set + free-list entry + meta key
    }

    console.log(`[autoscale] ${language} pool settled at ${containerNames.length - toRemove.length} containers`);
  } finally {
    await releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------
// getPoolMetrics(language)
// Returns Redis-backed pool state for the admin metrics API.
// Pure read — no Docker API calls, no locks acquired.
// ---------------------------------------------------------------------------
async function getPoolMetrics(language) {
  const containerNames = await redis.smembers(getContainersSetKey(language));
  let busyCount = 0;
  let freeCount = 0;

  for (const name of containerNames) {
    const status = await redis.hget(getMetaKey(name), 'status');
    if (status === 'busy') busyCount += 1;
    else if (status === 'free') freeCount += 1;
  }

  return {
    total:   containerNames.length,
    busy:    busyCount,
    free:    freeCount,
    minSize: getMinPoolSize(language),
    maxSize: getMaxPoolSize(language),
  };
}

// ---------------------------------------------------------------------------
// registerLanguage(language, imageName)
// Expands LANGUAGE_IMAGE_MAP at runtime for dynamically added languages.
// Called by admin.service.addLanguage() after a successful image build.
// Idempotent — safe to call multiple times.
// ---------------------------------------------------------------------------
function registerLanguage(language, imageName) {
  LANGUAGE_IMAGE_MAP[language] = imageName;
}

module.exports = {
  ensurePool,
  acquireContainer,
  releaseContainer,
  copyFilesToContainer,
  execInContainer,
  cleanupWorkspace,
  incrementUsage,
  drainLanguagePool,
  scaleDownPool,
  getPoolMetrics,
  registerLanguage,
};
