/**
 * runtime.service.js
 *
 * Orchestrates the full runtime version upgrade pipeline:
 *   1. Load Dockerfile template → inject new version
 *   2. Build new Docker image via dockerode (same image name, overwrites old)
 *   3. Drain the old container pool (via containerManager.drainLanguagePool)
 *   4. Pre-warm fresh containers so the pool is ready immediately
 *   5. Persist result to MongoDB Runtime model
 *
 * All existing execution code (dockerRunner, workers, queues) is untouched.
 * containerManager.drainLanguagePool() is the only new function added there.
 */

const path   = require('path');
const fs     = require('fs');
const Docker = require('dockerode');
const tar    = require('tar-stream');
const Redis  = require('ioredis');

const { Runtime }       = require('../models/Runtime');
const containerManager  = require('../sandbox/containerManager');
const config            = require('../config');

// ---------------------------------------------------------------------------
// Internal constants — mirrors containerManager's LANGUAGE_IMAGE_MAP exactly
// so existing image names are never changed.
// ---------------------------------------------------------------------------
const LANGUAGE_IMAGE_MAP = {
  java:       'judge-java-nsjail',
  python:     'judge-python-nsjail',
  javascript: 'judge-node-nsjail',
  c:          'judge-c-nsjail',
  cpp:        'judge-cpp-nsjail',
  go:         'judge-go-nsjail',
};

const TEMPLATES_DIR = path.join(__dirname, '../../docker/templates');

// Single shared Redis connection for busy-check queries.
// Uses the same host/port/password as the rest of the system.
const redis = new Redis({
  host:     config.redis.host,
  port:     config.redis.port,
  password: config.redis.password,
  lazyConnect: true,
});

const docker = new Docker();

// ---------------------------------------------------------------------------
// getBusyContainerCount(language)
// Inspects Redis metadata to count containers currently processing a job.
// Called by the controller before allowing an upgrade.
// ---------------------------------------------------------------------------
async function getBusyContainerCount(language) {
  const containerSetKey = `containers:${language}`;
  const containerNames  = await redis.smembers(containerSetKey);

  let busyCount = 0;
  for (const name of containerNames) {
    const status = await redis.hget(`container:meta:${name}`, 'status');
    if (status === 'busy') busyCount += 1;
  }
  return busyCount;
}

// ---------------------------------------------------------------------------
// buildDockerImage(imageName, dockerfileContent)
// Wraps dockerode's buildImage in a Promise and captures the full log stream.
// Uses the same image name as the existing image — Docker replaces it in-place.
// ---------------------------------------------------------------------------
async function buildDockerImage(imageName, dockerfileContent) {
  return new Promise((resolve, reject) => {
    // dockerode requires a tar archive containing the Dockerfile
    const pack = tar.pack();
    pack.entry({ name: 'Dockerfile' }, dockerfileContent, (entryErr) => {
      if (entryErr) return reject(entryErr);
      pack.finalize();
    });

    docker.buildImage(pack, { t: imageName, rm: true, forcerm: true }, (err, stream) => {
      if (err) return reject(err);

      const logLines = [];

      docker.modem.followProgress(
        stream,
        // onFinish callback
        (buildErr, _output) => {
          if (buildErr) return reject(buildErr);
          resolve(logLines.join('\n'));
        },
        // onProgress callback — collect each stream event
        (event) => {
          if (event && event.stream) {
            const line = event.stream.replace(/\n$/, '');
            if (line) logLines.push(line);
          } else if (event && event.error) {
            logLines.push(`ERROR: ${event.error}`);
          }
        }
      );
    });
  });
}

// ---------------------------------------------------------------------------
// warmUpPool(language)
// After draining, pre-creates N containers using the new image and marks them
// as free so workers have a hot pool immediately — no cold-start penalty.
// Reuses containerManager.acquireContainer (which creates + registers the
// container) followed by releaseContainer (which marks it free).
// ---------------------------------------------------------------------------
async function warmUpPool(language) {
  const poolSize    = getPoolSizeForLanguage(language);
  const memoryBytes = parseMemoryString(config.sandbox.memory) || 512 * 1024 * 1024;
  const cpuCores    = parseFloat(config.sandbox.cpu || '0.5');

  console.log(`[runtime] Pre-warming ${poolSize} container(s) for ${language}...`);

  // Acquire all slots sequentially — acquireContainer holds the acquire-lock
  // internally so no race conditions occur.
  for (let i = 0; i < poolSize; i += 1) {
    try {
      const containerName = await containerManager.acquireContainer(language, {
        memory: memoryBytes,
        cpus:   cpuCores,
      });
      // Release immediately → marks container free and pushes to free-list
      await containerManager.releaseContainer(containerName, {});
    } catch (err) {
      // Non-fatal — the pool will fill lazily on the first incoming job
      console.warn(`[runtime] Warm-up slot ${i + 1} failed:`, err.message);
    }
  }

  console.log(`[runtime] Warm-up complete for ${language}`);
}

// ---------------------------------------------------------------------------
// upgradeRuntime(language, version)
// Full upgrade pipeline — runs entirely in the background.
// Status is tracked in MongoDB so the client can poll GET /:language/status.
// ---------------------------------------------------------------------------
async function upgradeRuntime(language, version) {
  const imageName = LANGUAGE_IMAGE_MAP[language];
  if (!imageName) throw new Error(`unsupported_language: ${language}`);

  // Mark as building
  await Runtime.findOneAndUpdate(
    { language },
    { status: 'building', buildLog: `Build started at ${new Date().toISOString()}\n` }
  );

  let buildLog = '';

  try {
    // ── Step 1: Load and render the Dockerfile template ───────────────────
    const templatePath = path.join(TEMPLATES_DIR, `${language}.Dockerfile`);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Dockerfile template not found: ${templatePath}`);
    }
    const template        = fs.readFileSync(templatePath, 'utf8');
    const dockerfileContent = template.replace(/\{\{VERSION\}\}/g, version);

    // ── Step 2: Build new Docker image (overwrites the existing image) ────
    console.log(`[runtime] Building ${imageName} with ${language}@${version} ...`);
    buildLog = await buildDockerImage(imageName, dockerfileContent);
    console.log(`[runtime] Image build complete for ${language}@${version}`);

    // ── Step 3: Drain old container pool ─────────────────────────────────
    console.log(`[runtime] Draining old pool for ${language} ...`);
    await containerManager.drainLanguagePool(language);
    console.log(`[runtime] Pool drained for ${language}`);

    // ── Step 4: Pre-warm fresh containers from the new image ─────────────
    await warmUpPool(language);

    // ── Step 5: Persist success ───────────────────────────────────────────
    await Runtime.findOneAndUpdate(
      { language },
      {
        version,
        status:   'idle',
        buildLog: buildLog + `\nBuild completed successfully at ${new Date().toISOString()}`,
      }
    );

    console.log(`[runtime] ✓ Upgrade complete: ${language} → ${version}`);

  } catch (err) {
    // Persist failure so the operator can inspect the log
    const errLog = buildLog
      ? `${buildLog}\n\nFAILED: ${err.message}`
      : `FAILED: ${err.message}`;

    await Runtime.findOneAndUpdate(
      { language },
      { status: 'failed', buildLog: errLog }
    ).catch(() => {}); // swallow secondary DB error

    console.error(`[runtime] ✗ Upgrade failed for ${language}:`, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPoolSizeForLanguage(language) {
  const envName = `${language.toUpperCase()}_POOL_SIZE`;
  const raw     = process.env[envName] || process.env.POOL_SIZE || '1';
  const parsed  = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 10);
}

function parseMemoryString(value) {
  if (!value) return undefined;
  if (typeof value === 'number') return value;
  const parsed = parseInt(value.replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(parsed) ? undefined : parsed * 1024 * 1024;
}

module.exports = { upgradeRuntime, getBusyContainerCount, buildDockerImage };
