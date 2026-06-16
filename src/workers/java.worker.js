const { Worker } = require('bullmq');

const worker = new Worker(
  'java-queue',
  async (job) => {
    console.log('Executing Submission', job.data.submissionId);
    // TODO: implement execution steps: fetch submission, compile, run, save
  },
  {
    connection: { host: process.env.REDIS_HOST || '127.0.0.1', port: process.env.REDIS_PORT || 6379 }
  }
);

worker.on('completed', () => console.log('Job Completed'));
worker.on('failed', (job, err) => console.error('Job failed', err));