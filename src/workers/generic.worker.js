/**
 * Generic worker template. In production you should run workers as separate processes
 * and scale them per-language. This file is a template that shows how to
 * consume jobs and call the sandbox runner, then update MongoDB.
 */
const { Worker } = require('bullmq');
const config = require('../config');
const queueService = require('../services/queue.service');
const Submission = require('../models/Submission');
const dockerRunner = require('../sandbox/dockerRunner');

function startWorkerForLanguage(lang) {
  const queueName = `${lang}-queue`;
  const worker = new Worker(queueName, async (job) => {
    const { submissionId, sourceCode, stdin } = job.data;
    const submission = await Submission.findById(submissionId);
    if (!submission) throw new Error('submission_missing');

    submission.status = 'running';
    submission.verdict = 'Running';
    await submission.save();

    try {
      const result = await dockerRunner.runSandbox({ language: lang, sourceCode, stdin });
      submission.stdout = result.stdout || '';
      submission.stderr = result.stderr || '';
      submission.compileOutput = result.compileOutput || '';
      submission.executionTime = result.timeMs || 0;
      submission.memoryUsage = result.memory || 0;
      submission.status = 'completed';
      submission.verdict = result.verdict || 'Accepted';
      await submission.save();
    } catch (err) {
      submission.status = 'failed';
      submission.verdict = 'Internal Error';
      submission.stderr = (err && err.message) || String(err);
      await submission.save();
      throw err;
    }
  }, { connection: { host: config.redis.host, port: config.redis.port, password: config.redis.password } });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed:`, err.message);
  });

  console.log(`Worker started for ${lang}`);
  return worker;
}

module.exports = { startWorkerForLanguage };
