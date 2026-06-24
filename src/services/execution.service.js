const { getSubmissionModel, STATUS } = require('../models/Submission');
const queueService = require('./queue.service');
const langRegistry = require('../utils/languageRegistry');

async function createAndEnqueue({ sourceCode, language, stdin, expected_output }) {
  if (!langRegistry.isSupported(language)) throw new Error('unsupported_language');

  // Route to the language-specific collection via the factory
  const SubmissionModel = getSubmissionModel(language);
  const submission = await SubmissionModel.create({
    sourceCode,
    language,
    stdin,
    expected_output: expected_output || null,
    status: STATUS.IN_QUEUE,
  });

  const q = queueService.getQueueForLanguage(language);
  if (!q) throw new Error('queue_not_ready');

  // Store only the submissionId in Redis — sourceCode and stdin live in MongoDB.
  // This keeps Redis memory usage minimal regardless of payload size.
  await q.add(
    'execute',
    { submissionId: submission._id.toString() },
    { attempts: 2, backoff: { type: 'exponential', delay: 2000 } }
  );

  return submission;
}

module.exports = { createAndEnqueue };
