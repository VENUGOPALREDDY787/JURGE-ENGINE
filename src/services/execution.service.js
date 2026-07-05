const { getSubmissionModel, getUnifiedModel, STATUS } = require('../models/Submission');
const queueService = require('./queue.service');
const langRegistry = require('../utils/languageRegistry');

async function createAndEnqueue({ sourceCode, language, stdin, expected_output, callback_url, metadata }) {
  if (!langRegistry.isSupported(language)) throw new Error('unsupported_language');

  const payload = {
    sourceCode,
    language,
    stdin,
    expected_output: expected_output || null,
    status: STATUS.IN_QUEUE,
    callback_url: callback_url || null,
    metadata: metadata || null,
  };

  // ── Primary write: unified 'submissions' collection (Task 3) ─────────────
  // All new submissions land here regardless of language. A single indexed
  // _id lookup is all that's needed to fetch any token from this point on.
  const unified    = getUnifiedModel();
  const submission = await unified.create(payload);

  // ── Secondary write: per-language collection (backward compatibility) ─────
  // Preserves existing per-language collections so any external tooling or
  // admin queries that read java_submissions / python_submissions still work.
  // Written asynchronously — failure here does NOT fail the submission.
  const PerLangModel = getSubmissionModel(language);
  PerLangModel.create({ ...payload, _id: submission._id }).catch((err) => {
    console.warn(`[execution] Per-lang write failed for ${language}:`, err.message);
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
