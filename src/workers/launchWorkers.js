require('dotenv').config();

const mongoose      = require('mongoose');
const { Queue }     = require('bullmq');
const config        = require('../config');
const { startWorkerForLanguage } = require('./generic.worker');
const { scaleDownPool }          = require('../sandbox/containerManager');

const LANGS = Object.values(config.supportedLanguages);

async function launch() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/judge';

  await mongoose.connect(mongoUri);
  console.log('Worker MongoDB connected');

  // ── Start one BullMQ worker per language (unchanged) ──────────────────────
  LANGS.forEach((lang) => {
    startWorkerForLanguage(lang);
  });

  // ── Background idle-based auto scale-down watcher ─────────────────────────
  // Every SCALE_DOWN_INTERVAL_MS milliseconds, check each language queue.
  // If there are ZERO waiting jobs AND ZERO active jobs, shrink the container
  // pool for that language back to MIN_POOL_SIZE.
  //
  // The scaleDownPool() function holds the same acquire-lock used by
  // acquireContainer(), so scale-down and job acquisition are mutually
  // exclusive — no race conditions possible.
  //
  // Errors are caught and logged; they never propagate to the execution path.
  const redisConn = {
    host:     config.redis.host,
    port:     config.redis.port,
    password: config.redis.password,
  };
  const scaleDownInterval = config.pool.scaleDownInterval;

  LANGS.forEach((lang) => {
    // Lightweight read-only Queue instance used only for queue-depth checks.
    // Does NOT interfere with the Queue instances in queue.service.js.
    const monitorQueue = new Queue(`${lang}-queue`, { connection: redisConn });

    const timer = setInterval(async () => {
      try {
        const [waiting, active] = await Promise.all([
          monitorQueue.getWaitingCount(),
          monitorQueue.getActiveCount(),
        ]);

        if (waiting === 0 && active === 0) {
          await scaleDownPool(lang);
        }
      } catch (err) {
        // Non-fatal — log and continue; watcher fires again next interval
        console.warn(`[autoscale] Scale-down check failed for ${lang}:`, err.message);
      }
    }, scaleDownInterval);

    // Prevent this timer from keeping the process alive after workers shut down
    timer.unref();
  });

  console.log(`[autoscale] Idle scale-down watcher active (interval: ${scaleDownInterval}ms, min: ${config.pool.minSize})`);
}

launch().catch((e) => {
  console.error('Worker launcher failed', e);
  process.exit(1);
});