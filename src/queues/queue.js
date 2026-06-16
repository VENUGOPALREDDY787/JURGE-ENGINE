const { Queue } = require('bullmq');

const javaQueue = new Queue('java-queue', {
  connection: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379
  }
});

module.exports = { javaQueue };