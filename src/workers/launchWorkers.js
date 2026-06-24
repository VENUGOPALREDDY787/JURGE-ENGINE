require('dotenv').config();

const mongoose      = require('mongoose');
const { Queue }     = require('bullmq');
const Redis         = require('ioredis');
const config        = require('../config');
const { startWorkerForLanguage } = require('./generic.worker');
const { scaleDownPool }          = require('../sandbox/containerManager');
const containerManager           = require('../sandbox/containerManager');
const queueService               = require('../services/queue.service');
const langRegistry               = require('../utils/languageRegistry');
const LanguageConfig             = require('../models/LanguageConfig');

const LANGS = Object.values(config.supportedLanguages);

const redisConn = {
  host:     config.redis.host,
  port:     config.redis.port,
  password: config.redis.password,
};

async function launch() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/judge';

  await mongoose.connect(mongoUri);
  console.log('Worker MongoDB connected');

  // ── Start one BullMQ worker per statically configured language ────────────
  LANGS.forEach((lang) => {
    startWorkerForLanguage(lang);
  });

  // ── Load dynamically registered languages from MongoDB ────────────────────
  // Any language added via POST /admin/languages while this process was offline
  // is persisted in language_configs. We restore them here on startup so no
  // jobs are left unprocessed.
  try {
    const dynamicLangs = await LanguageConfig.find({ status: 'active' }).lean();
    for (const lc of dynamicLangs) {
      const { language, imageName } = lc;
      if (langRegistry.isSupported(language)) continue; // already in static config

      containerManager.registerLanguage(language, imageName);
      queueService.createQueue(language);
      langRegistry.register(language);
      startWorkerForLanguage(language);
      console.log(`[dynamic] Restored worker for persisted language: ${language}`);
    }
  } catch (err) {
    console.warn('[dynamic] Failed to load dynamic languages from DB:', err.message);
    // Non-fatal — statically configured languages continue working normally
  }

  // ── Background idle-based auto scale-down watcher ─────────────────────────
  const scaleDownInterval = config.pool.scaleDownInterval;

  LANGS.forEach((lang) => {
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
        console.warn(`[autoscale] Check failed for ${lang}:`, err.message);
      }
    }, scaleDownInterval);

    timer.unref();
  });

  console.log(`[autoscale] Idle scale-down watcher active (interval: ${scaleDownInterval}ms)`);

  // ── Redis pub/sub — real-time dynamic language registration ──────────────
  // When admin.service.addLanguage() publishes 'jurge:new-language', this
  // subscriber starts a new BullMQ Worker for that language immediately.
  // No worker restart required.
  const sub = new Redis(redisConn);

  sub.on('error', (err) => {
    console.warn('[dynamic] Redis subscriber error:', err.message);
  });

  sub.subscribe('jurge:new-language', (err) => {
    if (err) {
      console.warn('[dynamic] Failed to subscribe to jurge:new-language:', err.message);
    } else {
      console.log('[dynamic] Subscribed to jurge:new-language channel');
    }
  });

  sub.on('message', async (channel, language) => {
    if (channel !== 'jurge:new-language') return;
    if (langRegistry.isSupported(language)) {
      console.log(`[dynamic] Worker for '${language}' already running — skipping`);
      return;
    }

    console.log(`[dynamic] Received pub/sub: starting worker for '${language}'`);

    try {
      // Fetch the image name from MongoDB (set by admin.service.addLanguage)
      const lc = await LanguageConfig.findOne({ language, status: 'active' }).lean();
      if (!lc) {
        console.warn(`[dynamic] No active LanguageConfig for '${language}' — cannot start worker`);
        return;
      }

      containerManager.registerLanguage(language, lc.imageName);
      queueService.createQueue(language);
      langRegistry.register(language);
      startWorkerForLanguage(language);

      console.log(`[dynamic] Worker started for new language: ${language}`);
    } catch (err) {
      console.error(`[dynamic] Failed to start worker for '${language}':`, err.message);
      // Non-fatal — jobs queue in BullMQ and will be processed on next worker restart
    }
  });
}

launch().catch((e) => {
  console.error('Worker launcher failed', e);
  process.exit(1);
});