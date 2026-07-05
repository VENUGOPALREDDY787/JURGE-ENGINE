require('dotenv').config();

// Import language definitions from the single source of truth.
// supportedLanguages is derived automatically — no manual sync needed.
const { SUPPORTED_LANGUAGE_IDS } = require('./languages');

// Build the { key: key } map that the rest of the codebase expects.
// e.g. { java: 'java', python: 'python', ... }
const SUPPORTED_LANGUAGES = {};
for (const id of SUPPORTED_LANGUAGE_IDS) {
  SUPPORTED_LANGUAGES[id] = id;
}

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
    java:              parseInt(process.env.JAVA_POOL_SIZE || '5',  10),
    default:           parseInt(process.env.POOL_SIZE      || '1',  10),
    // Dynamic autoscaling — min/max per language (or global fallback)
    minSize:           parseInt(process.env.MIN_POOL_SIZE  || '1',  10),
    maxSize:           parseInt(process.env.MAX_POOL_SIZE  || process.env.POOL_SIZE || '10', 10),
    scaleDownInterval: parseInt(process.env.SCALE_DOWN_INTERVAL_MS || '60000', 10),
  },
  containerRecycleThreshold: parseInt(process.env.CONTAINER_RECYCLE_THRESHOLD || '20', 10),
  adminApiKey:               process.env.ADMIN_API_KEY || null,
  supportedLanguages: SUPPORTED_LANGUAGES
};
