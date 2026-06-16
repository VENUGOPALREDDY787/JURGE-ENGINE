require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../config');
const { startWorkerForLanguage } = require('./generic.worker');

const LANGS = Object.values(config.supportedLanguages);

async function launch() {
  const mongoUri =
    process.env.MONGODB_URI ||
    'mongodb://127.0.0.1:27017/judge';

  await mongoose.connect(mongoUri);

  console.log('Worker MongoDB connected');

  LANGS.forEach((lang) => {
    startWorkerForLanguage(lang);
  });
}

launch().catch((e) => {
  console.error('Worker launcher failed', e);
  process.exit(1);
});