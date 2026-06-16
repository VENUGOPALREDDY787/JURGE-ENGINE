const Submission = require('../models/Submission');
const queueService = require('./queue.service');
const config = require('../config');

const VALID_LANGS = Object.values(config.supportedLanguages);

async function createAndEnqueue({ sourceCode, language, stdin }) {
  if (!VALID_LANGS.includes(language)) throw new Error('unsupported_language');

  const submission = await Submission.create({ sourceCode, language, stdin, status: 'queued', verdict: 'Queued' });

  
  const q = queueService.getQueueForLanguage(language);
  if (!q) throw new Error('queue_not_ready');

  await q.add('execute', { submissionId: submission._id.toString(), sourceCode, language, stdin }, { attempts: 2, backoff: { type: 'exponential', delay: 2000 } });

  return submission;
}

module.exports = { createAndEnqueue };
// (Removed duplicate legacy code.)
