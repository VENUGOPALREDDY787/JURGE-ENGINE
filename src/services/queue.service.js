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

module.exports = {
  initQueues: async () => {
    const result = await initQueues();
    // expose router and queues
    module.exports.bullBoardRouter = result.router;
    module.exports.queues = queues;
  },
  getQueueForLanguage,
  bullBoardRouter: null,
};
