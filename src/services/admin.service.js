/**
 * admin.service.js
 *
 * Business logic for all admin portal features.
 * Composes existing services (runtimeService, containerManager, queueService)
 * and the new languageRegistry — the execution pipeline is never touched.
 */

const Redis = require('ioredis');
const config          = require('../config');
const langRegistry    = require('../utils/languageRegistry');
const queueService    = require('./queue.service');
const runtimeService  = require('./runtime.service');
const containerManager = require('../sandbox/containerManager');
const { getSubmissionModel } = require('../models/Submission');
const { Runtime }            = require('../models/Runtime');
const LanguageConfig         = require('../models/LanguageConfig');

// Dedicated Redis publisher used only for worker notifications.
const publisher = new Redis({
  host:     config.redis.host,
  port:     config.redis.port,
  password: config.redis.password,
  lazyConnect: true,
});

// ── Feature 1: Metrics ─────────────────────────────────────────────────────

/**
 * Returns BullMQ job counts per language plus a _global aggregate.
 * Uses Promise.all so all queue queries run in parallel.
 */
async function getQueueMetrics() {
  const languages = langRegistry.getAll();
  const metrics   = {};

  let gWaiting = 0, gActive = 0, gCompleted = 0, gFailed = 0, gDelayed = 0;

  await Promise.all(
    languages.map(async (lang) => {
      const q = queueService.getQueueForLanguage(lang);
      if (!q) {
        metrics[lang] = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, note: 'queue_not_ready' };
        return;
      }

      const [waiting, active, completed, failed, delayed] = await Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getCompletedCount(),
        q.getFailedCount(),
        q.getDelayedCount(),
      ]);

      metrics[lang] = { waiting, active, completed, failed, delayed };
      gWaiting   += waiting;
      gActive    += active;
      gCompleted += completed;
      gFailed    += failed;
      gDelayed   += delayed;
    })
  );

  metrics._global = {
    waiting: gWaiting, active: gActive,
    completed: gCompleted, failed: gFailed, delayed: gDelayed,
  };

  return metrics;
}

/**
 * Returns Redis-based container pool state per language.
 * Calls containerManager.getPoolMetrics() — pure Redis reads, no Docker API calls.
 */
async function getContainerMetrics() {
  const languages = langRegistry.getAll();
  const metrics   = {};

  await Promise.all(
    languages.map(async (lang) => {
      metrics[lang] = await containerManager.getPoolMetrics(lang);
    })
  );

  return metrics;
}

/**
 * Returns MongoDB submission aggregates across all per-language collections.
 * Runs all language queries in parallel (Promise.all).
 */
async function getSubmissionMetrics() {
  const languages = langRegistry.getAll();

  const result = {
    total:             0,
    byLanguage:        {},
    statusCounts:      {},
    avgTimeByLanguage: {},
  };

  await Promise.all(
    languages.map(async (lang) => {
      const Model = getSubmissionModel(lang);

      const [total, statusAgg, timeAgg] = await Promise.all([
        Model.countDocuments(),

        Model.aggregate([
          { $group: { _id: '$status.description', count: { $sum: 1 } } },
        ]),

        Model.aggregate([
          { $match: { time: { $ne: null } } },
          { $group: { _id: null, avgTime: { $avg: '$time' } } },
        ]),
      ]);

      result.total += total;
      result.byLanguage[lang] = { total, statusCounts: {} };

      for (const { _id: desc, count } of statusAgg) {
        if (!desc) continue;
        result.statusCounts[desc] = (result.statusCounts[desc] || 0) + count;
        result.byLanguage[lang].statusCounts[desc] = count;
      }

      result.avgTimeByLanguage[lang] =
        timeAgg[0]?.avgTime != null
          ? Number(timeAgg[0].avgTime.toFixed(4))
          : null;
    })
  );

  return result;
}

// ── Feature 2: Runtime management ─────────────────────────────────────────

/**
 * Triggers an async Docker image rebuild for an existing language runtime.
 * Parses the version from baseImage (e.g. "python:3.13" → "3.13") and
 * delegates to the existing runtimeService.upgradeRuntime() so all safety
 * checks (pool drain, busy-container guard) remain identical.
 *
 * @param {string} language  e.g. 'python'
 * @param {string} baseImage e.g. 'python:3.13'
 */
async function updateRuntime(language, baseImage) {
  // Extract version tag from baseImage (e.g. "python:3.13" → "3.13")
  const colonIdx = baseImage.lastIndexOf(':');
  if (colonIdx === -1 || colonIdx === baseImage.length - 1) {
    throw new Error('Invalid baseImage format. Expected "image:tag" (e.g. "python:3.13").');
  }
  const version = baseImage.slice(colonIdx + 1).trim();

  // Guard: reject if already building
  const runtime = await Runtime.findOne({ language }).lean();
  if (runtime && runtime.status === 'building') {
    throw new Error('already_building');
  }

  // Guard: reject if containers are busy
  const busyCount = await runtimeService.getBusyContainerCount(language);
  if (busyCount > 0) {
    throw new Error('active_jobs');
  }

  // Fire async — same pipeline as /api/runtimes/:language PUT
  runtimeService.upgradeRuntime(language, version).catch((err) => {
    console.error(`[admin] Background runtime upgrade failed for ${language}:`, err.message);
  });

  return {
    message:   'Runtime upgrade started',
    language,
    baseImage,
    version,
    statusUrl: `/admin/runtime/${language}/status`,
  };
}

// ── Feature 3: Dynamic language registration ───────────────────────────────

/**
 * Registers a new language at runtime without requiring a server restart.
 *
 * API process steps (synchronous from HTTP perspective):
 *   1. Persist LanguageConfig (status=building)
 *   2. Build Docker image — BLOCKS until complete (image must exist before pool)
 *   3. Register Runtime metadata in MongoDB
 *   4. Expand containerManager's LANGUAGE_IMAGE_MAP
 *   5. Create BullMQ queue for the new language
 *   6. Register in languageRegistry (so execution.service accepts submissions)
 *   7. Mark LanguageConfig active
 *   8. Publish 'jurge:new-language' on Redis → worker process starts a Worker
 *
 * @param {{ language, fileName, compileCommand, runCommand, dockerfile }} opts
 */
async function addLanguage({ language, fileName, compileCommand, runCommand, dockerfile }) {
  const imageName = `judge-${language}-nsjail`;
  let buildLog    = '';

  // 1. Persist with building status (allows progress tracking)
  await LanguageConfig.create({
    language, imageName, fileName, compileCommand, runCommand, status: 'building',
  });

  try {
    // 2. Build Docker image from the provided Dockerfile string (blocking)
    console.log(`[admin] Building Docker image ${imageName} for new language: ${language}`);
    buildLog = await runtimeService.buildDockerImage(imageName, dockerfile);
    console.log(`[admin] Image build complete for ${language}`);

    // 3. Register Runtime document for status/version tracking
    const existingRuntime = await Runtime.findOne({ language });
    if (!existingRuntime) {
      await Runtime.create({
        language, version: 'custom', imageName, status: 'idle', buildLog,
      });
    }

    // 4. Register in containerManager (so acquireContainer knows the image name)
    containerManager.registerLanguage(language, imageName);

    // 5. Create BullMQ queue + scheduler so submissions can be enqueued
    queueService.createQueue(language);

    // 6. Add to languageRegistry (so execution.service.isSupported() passes)
    langRegistry.register(language);

    // 7. Mark LanguageConfig active
    await LanguageConfig.findOneAndUpdate(
      { language },
      { status: 'active', buildLog }
    );

    // 8. Notify worker process to start a BullMQ Worker for this queue
    await publisher.publish('jurge:new-language', language);
    console.log(`[admin] Published 'jurge:new-language' for ${language}`);

    return {
      message:   `Language "${language}" registered successfully.`,
      language,
      imageName,
      note:      'Worker process has been notified via pub/sub. Submissions are accepted immediately.',
    };
  } catch (err) {
    // Persist failure so the operator can see what went wrong
    const errorLog = buildLog
      ? `${buildLog}\n\nFAILED: ${err.message}`
      : `FAILED: ${err.message}`;

    await LanguageConfig.findOneAndUpdate(
      { language },
      { status: 'failed', buildLog: errorLog }
    ).catch(() => {});

    console.error(`[admin] addLanguage failed for ${language}:`, err.message);
    throw err;
  }
}

module.exports = {
  getQueueMetrics,
  getContainerMetrics,
  getSubmissionMetrics,
  updateRuntime,
  addLanguage,
};
