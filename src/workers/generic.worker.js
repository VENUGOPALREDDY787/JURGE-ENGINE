/**
 * Generic worker template.
 * One worker instance is started per language by launchWorkers.js.
 * Each worker reads from its language-specific BullMQ queue and executes
 * submissions inside the Docker/nsjail sandbox, then persists results to
 * the corresponding per-language MongoDB collection.
 */
const { Worker } = require('bullmq');
const config = require('../config');
const { getSubmissionModel, getUnifiedModel, STATUS } = require('../models/Submission');
const dockerRunner = require('../sandbox/dockerRunner');

// ---------------------------------------------------------------------------
// Concurrency — mirrors getMaxPoolSize() fallback chain in containerManager.js
// so worker concurrency always matches the max container pool for this language.
// Fallback order:
//   1. <LANG>_MAX_POOL_SIZE  (e.g. JAVA_MAX_POOL_SIZE)
//   2. MAX_POOL_SIZE          (global max)
//   3. <LANG>_POOL_SIZE       (legacy per-language, backward compat)
//   4. POOL_SIZE              (legacy global, backward compat)
//   5. '1'                    (safe default)
// ---------------------------------------------------------------------------
function getConcurrencyForLanguage(lang) {
  const perLangMax    = `${lang.toUpperCase()}_MAX_POOL_SIZE`;
  const perLangLegacy = `${lang.toUpperCase()}_POOL_SIZE`;
  const raw = process.env[perLangMax]
    || process.env.MAX_POOL_SIZE
    || process.env[perLangLegacy]
    || process.env.POOL_SIZE
    || '1';
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
}

// ---------------------------------------------------------------------------
// Map sandbox verdict string → Judge0-style status object
// ---------------------------------------------------------------------------
function verdictToStatus(verdict) {
  switch (verdict) {
    case 'Accepted':            return STATUS.ACCEPTED;
    case 'Time Limit Exceeded': return STATUS.TLE;
    case 'Compilation Error':   return STATUS.COMPILATION_ERROR;
    case 'Runtime Error':       return STATUS.RUNTIME_ERROR;
    default:                    return STATUS.INTERNAL_ERROR;
  }
}

// ---------------------------------------------------------------------------
// Trigger Webhook Callback
// ---------------------------------------------------------------------------
async function triggerCallback(submission) {
  if (!submission.callback_url) return;
  try {
    const response = await fetch(submission.callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token:          submission._id.toString(),
        stdout:         submission.stdout          || null,
        stderr:         submission.stderr          || null,
        compile_output: submission.compile_output  || null,
        message:        submission.message         || null,
        time:           submission.time != null ? String(Number(submission.time).toFixed(3)) : null,
        memory:         submission.memory          ?? null,
        status:         submission.status,
        metadata:       submission.metadata        || null
      })
    });
    console.log(`📡 Webhook sent to ${submission.callback_url} for submission ${submission._id}. Status: ${response.status}`);
  } catch (err) {
    console.error(`❌ Webhook callback failed for submission ${submission._id}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Start a BullMQ worker for the given language
// ---------------------------------------------------------------------------
function startWorkerForLanguage(lang) {
  const queueName = `${lang}-queue`;
  const concurrency = getConcurrencyForLanguage(lang);

  // Obtain the unified model for fast O(1) submission lookup
  const UnifiedModel = getUnifiedModel();

  const worker = new Worker(
    queueName,
    async (job) => {
      // job.data contains only submissionId — full payload is fetched from MongoDB.
      const { submissionId } = job.data;

      // Try unified collection first (new submissions), fall back to per-language
      // collection for submissions created before the unified collection existed.
      let submission = await UnifiedModel.findById(submissionId);
      if (!submission) {
        const PerLangModel = getSubmissionModel(lang);
        submission = await PerLangModel.findById(submissionId);
      }
      if (!submission) throw new Error('submission_missing');

      // Read execution payload from the persisted document (not from Redis)
      const { sourceCode, stdin } = submission;

      // Mark as processing
      submission.status = STATUS.PROCESSING;
      await submission.save();

      try {
        const result = await dockerRunner.runSandbox({ language: lang, sourceCode, stdin });

        submission.stdout         = result.stdout         ?? null;
        submission.stderr         = result.stderr         ?? null;
        submission.compile_output = result.compile_output ?? null;
        submission.message        = result.message        ?? null;
        // timeMs from sandbox is milliseconds; store as fractional seconds
        submission.time           = result.timeMs != null ? result.timeMs / 1000 : null;
        // memory fields — all come from cgroup peak-memory tracker in dockerRunner
        submission.memory         = result.memory         ?? null;  // bytes
        submission.memoryUsedKB   = result.memoryUsedKB   ?? null;
        submission.memoryUsedMB   = result.memoryUsedMB   ?? null;
        submission.status         = verdictToStatus(result.verdict);

        // Judge0 expected_output comparison.
        // Only runs when the client provided expected_output AND the sandbox
        // itself produced a clean execution (no compile/runtime/TLE error).
        // Error verdicts are never silently overridden — they surface as-is.
        if (
          submission.expected_output != null &&
          submission.status.id === STATUS.ACCEPTED.id
        ) {
          const actual   = (submission.stdout || '').trim();
          const expected = submission.expected_output.trim();
          submission.status = actual === expected ? STATUS.ACCEPTED : STATUS.WRONG_ANSWER;
        }

        await submission.save();
        await triggerCallback(submission);
      } catch (err) {
        submission.status  = STATUS.INTERNAL_ERROR;
        submission.message = (err && err.message) || String(err);
        await submission.save();
        await triggerCallback(submission);
        throw err; // re-throw so BullMQ records the failure and can retry
      }
    },
    {
      concurrency,
      connection: {
        host:     config.redis.host,
        port:     config.redis.port,
        password: config.redis.password,
      },
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error(`Worker error for ${lang}:`, err.message);
  });

  console.log(`Worker started for ${lang} with concurrency ${concurrency}`);
  return worker;
}

module.exports = { startWorkerForLanguage };
