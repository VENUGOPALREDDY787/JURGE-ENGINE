const { Queue, Worker, QueueScheduler } = require('bullmq');
const { createBullBoard } = require('@bull-board/api');
const { ExpressAdapter } = require('@bull-board/express');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const config = require('../config');
const path = require('path');

const connection = { connection: { host: config.redis.host, port: config.redis.port, password: config.redis.password } };

const queues = {};

const LANGS = Object.values(config.supportedLanguages);

async function initQueues() {
  // Create queue schedulers and queues for each language
  LANGS.forEach((lang) => {
    const name = `${lang}-queue`;
    queues[lang] = new Queue(name, connection);
    // A scheduler is recommended for delayed jobs / retries
    new QueueScheduler(name, connection);
  });

  // Optionally create bull-board router
  try {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    const adapters = LANGS.map((lang) => new BullMQAdapter(queues[lang]));
    const { router } = createBullBoard({ queues: adapters, serverAdapter });
    return { router: serverAdapter.getRouter(), queues };
  } catch (err) {
    console.warn('Bull board unavailable', err.message);
    return { router: null, queues };
  }
}

function getQueueForLanguage(lang) {
  return queues[lang];
}

/**
 * createQueue(lang)
 * Creates a BullMQ Queue + QueueScheduler for a dynamically added language.
 * Idempotent — returns the existing queue if already created.
 * Called by admin.service.addLanguage() after a successful image build.
 */
function createQueue(lang) {
  if (queues[lang]) return queues[lang]; // already exists — no-op
  const name = `${lang}-queue`;
  queues[lang] = new Queue(name, connection);
  new QueueScheduler(name, connection);
  console.log(`[queue] Created queue for new language: ${lang}`);
  return queues[lang];
}

/**
 * getAllQueues()
 * Returns a snapshot object { lang: Queue } for all currently known queues.
 * Used by admin.service.getQueueMetrics().
 */
function getAllQueues() {
  return { ...queues };
}

module.exports = {
  initQueues: async () => {
    const result = await initQueues();
    module.exports.bullBoardRouter = result.router;
    module.exports.queues = queues;
    return result;
  },
  getQueueForLanguage,
  createQueue,
  getAllQueues,
  bullBoardRouter: null,
};
