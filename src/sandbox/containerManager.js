const Docker = require('dockerode');
const Redis = require('ioredis');
const crypto = require('crypto');
const tar = require('tar-stream');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const config = require('../config');

const docker = new Docker();
const redis = new Redis({ host: config.redis.host, port: config.redis.port, password: config.redis.password });
// Simple Redis lock helper using SET NX PX

async function acquireLock(key, ttl = 30000) {
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
  } catch (e) {}
}

const CONTAINER_PREFIX = 'judge-';
const RECYCLE_THRESHOLD = parseInt(process.env.CONTAINER_RECYCLE_THRESHOLD || '20', 10);

// In-memory cache for quick lookups in single-process mode
const containers = new Map();

function containerNameFor(lang) {
  return `${CONTAINER_PREFIX}${lang}`;
}

async function getContainerInfo(lang) {
  const name = containerNameFor(lang);
  if (containers.has(lang)) return containers.get(lang);
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    const meta = {
      name,
      container,
      usageCount: parseInt(await redis.hget(`container:meta:${lang}`, 'usageCount') || '0', 10),
      status: info.State.Status,
      lastUsed: await redis.hget(`container:meta:${lang}`, 'lastUsed') || null,
      healthStatus: info.State.Health ? info.State.Health.Status : 'unknown'
    };
    containers.set(lang, meta);
    return meta;
  } catch (e) {
    return null;
  }
}

async function createContainer(lang, image, opts = {}) {
  const name = containerNameFor(lang);
  // create with a persistent workspace directory inside container
  const createOpts = {
    Image: image,
    name,
    Cmd: ['tail', '-f', '/dev/null'],
    Tty: false,
    HostConfig: {
      AutoRemove: false,
      NetworkMode: 'none',
      ReadonlyRootfs: false,
      SecurityOpt: ['no-new-privileges'],
      Privileged: true,
    }
  };
 if (opts.memory) {
  const mem =
    typeof opts.memory === "string"
      ? parseInt(opts.memory.replace("m", "")) * 1024 * 1024
      : opts.memory;

  createOpts.HostConfig.Memory = mem;
}
  if (opts.cpus) createOpts.HostConfig.NanoCpus = Math.floor(opts.cpus * 1e9);

  // Pull image if needed
  try {
    await new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, onFinished, onProgress);
        function onFinished(err) { if (err) reject(err); else resolve(); }
        function onProgress() { }
      });
    });
  } catch (e) {
    // ignore pull error and try to create
  }

  const container = await docker.createContainer(createOpts);
  await container.start();

  const meta = { name, container, usageCount: 0, status: 'running', lastUsed: null, healthStatus: 'unknown' };
  containers.set(lang, meta);
  await redis.hmset(`container:meta:${lang}`, { usageCount: '0', lastUsed: '', status: 'running' });
  return meta;
}

async function ensureContainer(lang, image, opts = {}) {
  const lockKey = `locks:container:create:${lang}`;
  const lock = await acquireLock(lockKey, 30000);
  if (!lock) {
    // couldn't acquire lock within ttl; wait for creator to finish
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const info = await getContainerInfo(lang);
if (
  info &&
  info.container &&
  info.status !== 'exited'
) {
  return info;
}      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('lock_timeout');
  }

  try {
    // check existing
    let info = await getContainerInfo(lang);
   if (
  info &&
  info.container &&
  info.status !== "exited"
) {
  await releaseLock(lock);
  return info;
}
    // create
    const meta = await createContainer(lang, image, opts);
    await releaseLock(lock);
    return meta;
  } catch (err) {
    await releaseLock(lock);
    const info = await getContainerInfo(lang);
    if (info && info.status === 'running') return info;
    throw err;
  }
}

async function incrementUsage(lang) {
  const meta = containers.get(lang);
  const current = (meta && meta.usageCount) || parseInt(await redis.hget(`container:meta:${lang}`, 'usageCount') || '0', 10);
  const next = current + 1;
  if (meta) meta.usageCount = next;
  await redis.hset(`container:meta:${lang}`, 'usageCount', String(next));
  await redis.hset(`container:meta:${lang}`, 'lastUsed', new Date().toISOString());
  if (next >= RECYCLE_THRESHOLD) {
    // schedule recycle
    await recycleContainer(lang);
  }
}

async function recycleContainer(lang) {
  // Stop and remove existing container and create a fresh one
  const meta = await getContainerInfo(lang);
  if (!meta) return null;
  try {
    await meta.container.stop({ t: 1 });
  } catch (e) {}
  try { await meta.container.remove({ force: true }); } catch (e) {}
  containers.delete(lang);
  await redis.del(`container:meta:${lang}`);
  // create new container lazily on next ensureContainer call
  return null;
}

async function copyFilesToContainer(lang, files) {
  // files: [{ name, content }]
  const meta = await getContainerInfo(lang);
  if (!meta) throw new Error('container_missing');
  const pack = tar.pack();
  for (const f of files) {
    pack.entry({ name: f.name, mode: 0o644 }, f.content);
  }
  pack.finalize();
  await meta.container.putArchive(pack, { path: '/workspace' });
}

async function execInContainer(lang, cmd, opts = {}) {
  const meta = await getContainerInfo(lang);
  if (!meta) throw new Error('container_missing');
  const execInstance = await meta.container.exec({ Cmd: ['sh', '-lc', cmd], AttachStdout: true, AttachStderr: true, Tty: false, WorkingDir: '/workspace' });
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
  const stdoutText =
    Buffer.concat(stdout).toString('utf8');

  const stderrText =
    Buffer.concat(stderr).toString('utf8');

  const inspect =
    await execInstance.inspect();

  if (inspect.ExitCode !== 0) {
    return reject(
      new Error(stderrText || `Exit code ${inspect.ExitCode}`)
    );
  }
  console.log("EXIT CODE:", inspect.ExitCode);
console.log("STDOUT:", stdoutText);
console.log("STDERR:", stderrText);

  resolve({
    stdout: stdoutText,
    stderr: stderrText
  });
});
    stream.on('error', reject);
  });
}
async function cleanupWorkspace(lang) {
  try {
    await execInContainer(
  lang,
  "rm -rf /workspace/* || true"
);
  } catch (e) {
    console.error(
      `Cleanup failed for ${lang}`,
      e.message
    );
  }
}

module.exports = {
  ensureContainer,
  getContainerInfo,
  copyFilesToContainer,
  execInContainer,
  recycleContainer,
  incrementUsage,
  cleanupWorkspace,
};
