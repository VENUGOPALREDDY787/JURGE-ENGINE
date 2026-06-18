const { Worker } = require('bullmq');
const config = require('../config');
const Submission = require('../models/Submission');
const dockerRunner = require('../sandbox/dockerRunner');

function getConcurrency() {
  const raw = process.env.JAVA_POOL_SIZE || '5';
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 10);
}

const worker = new Worker(
  'java-queue',
  async (job) => {
    const { submissionId, sourceCode, stdin } = job.data;
    const submission = await Submission.findById(submissionId);
    if (!submission) throw new Error('submission_missing');

    submission.status = 'running';
    submission.verdict = 'Running';
    await submission.save();

    try {
      const result = await dockerRunner.runSandbox({ language: 'java', sourceCode, stdin });
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
  },
  {
    concurrency: getConcurrency(),
    connection: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password
    }
  }
);

worker.on('completed', () => console.log('Job Completed'));
worker.on('failed', (job, err) => console.error('Job failed', err));

console.log(`Java worker started with concurrency ${getConcurrency()}`);
