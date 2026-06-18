require('dotenv').config();

const SUPPORTED_LANGUAGES = {
  java: 'java',
  python: 'python',
  javascript: 'javascript',
  c: 'c',
  cpp: 'cpp',
  go: 'go'
};

module.exports = {
  port: process.env.PORT || 3000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/judge',
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined
  },
  sandbox: {
    cpu: process.env.SANDBOX_CPU || '2',
    memory: process.env.SANDBOX_MEMORY || '512m',
    timeoutMs: parseInt(process.env.SANDBOX_TIMEOUT_MS || '5000', 10)
  },
  pool: {
    java: parseInt(process.env.JAVA_POOL_SIZE || '5', 10),
    default: parseInt(process.env.POOL_SIZE || '1', 10)
  },
  containerRecycleThreshold: parseInt(process.env.CONTAINER_RECYCLE_THRESHOLD || '20', 10),
  supportedLanguages: SUPPORTED_LANGUAGES
};
