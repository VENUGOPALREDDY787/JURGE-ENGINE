/**
 * admin.controller.js
 *
 * Thin HTTP handlers for all /admin routes.
 * All heavy logic lives in admin.service.js — this layer only deals with
 * request parsing, response shaping, and error → HTTP status mapping.
 */

const adminService = require('../services/admin.service');
const langRegistry = require('../utils/languageRegistry');
const { Runtime }  = require('../models/Runtime');

// ── Feature 1: Metrics ─────────────────────────────────────────────────────

/**
 * GET /admin/metrics/queues
 * Returns BullMQ job counts (waiting/active/completed/failed/delayed)
 * for each language + a _global aggregate.
 */
exports.getQueueMetrics = async (req, res) => {
  try {
    const metrics = await adminService.getQueueMetrics();
    return res.json(metrics);
  } catch (err) {
    console.error('[admin] getQueueMetrics:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};

/**
 * GET /admin/metrics/containers
 * Returns Redis-backed pool state per language (total/free/busy/min/max).
 */
exports.getContainerMetrics = async (req, res) => {
  try {
    const metrics = await adminService.getContainerMetrics();
    return res.json(metrics);
  } catch (err) {
    console.error('[admin] getContainerMetrics:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};

/**
 * GET /admin/metrics/submissions
 * Returns MongoDB aggregation across all per-language collections:
 * total count, per-language counts, status distribution, avg execution time.
 */
exports.getSubmissionMetrics = async (req, res) => {
  try {
    const metrics = await adminService.getSubmissionMetrics();
    return res.json(metrics);
  } catch (err) {
    console.error('[admin] getSubmissionMetrics:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};

/**
 * GET /admin/languages
 * Returns the current set of supported languages (static + dynamically added).
 */
exports.getLanguages = async (req, res) => {
  try {
    return res.json({ languages: langRegistry.getAll() });
  } catch (err) {
    console.error('[admin] getLanguages:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// ── Feature 2: Runtime management ─────────────────────────────────────────

/**
 * PUT /admin/runtime/:language
 * Triggers an async Docker image rebuild for an existing language.
 * Body: { "baseImage": "python:3.13" }
 * Returns 202 immediately — poll GET /admin/runtime/:language/status.
 */
exports.updateRuntime = async (req, res) => {
  try {
    const { language }  = req.params;
    const { baseImage } = req.body;

    if (!baseImage || typeof baseImage !== 'string') {
      return res.status(400).json({
        error:   'baseImage_required',
        message: 'Provide "baseImage" in the request body (e.g. "python:3.13")',
      });
    }

    if (!langRegistry.isSupported(language)) {
      return res.status(400).json({ error: 'unsupported_language' });
    }

    const result = await adminService.updateRuntime(language, baseImage.trim());
    return res.status(202).json(result);
  } catch (err) {
    if (err.message === 'already_building') {
      return res.status(409).json({
        error:   'already_building',
        message: 'A build is already in progress for this language.',
      });
    }
    if (err.message === 'active_jobs') {
      return res.status(409).json({
        error:   'active_jobs',
        message: 'Containers are busy. Wait for active jobs to finish before upgrading.',
      });
    }
    console.error('[admin] updateRuntime:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};

/**
 * GET /admin/runtime/:language/status
 * Returns the current build status and log for a language runtime.
 */
exports.getRuntimeStatus = async (req, res) => {
  try {
    const { language } = req.params;

    const runtime = await Runtime.findOne(
      { language },
      { language: 1, version: 1, status: 1, buildLog: 1, updatedAt: 1, _id: 0 }
    ).lean();

    if (!runtime) return res.status(404).json({ error: 'not_found' });
    return res.json(runtime);
  } catch (err) {
    console.error('[admin] getRuntimeStatus:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// ── Feature 3: Dynamic language registration ───────────────────────────────

/**
 * POST /admin/languages
 * Registers a new language at runtime — no server restart required.
 * Body: { language, fileName, compileCommand, runCommand, dockerfile }
 *
 * Flow:
 *   1. Validate + check for duplicates
 *   2. Build Docker image (async — this call blocks until image is ready)
 *   3. Register in MongoDB, containerManager, queueService, languageRegistry
 *   4. Notify worker process via Redis pub/sub
 * Returns 201 when ready.
 */
exports.addLanguage = async (req, res) => {
  try {
    const { language, fileName, compileCommand, runCommand, dockerfile, baseImage } = req.body;

    // Validate required fields
    const missing = [];
    if (!language)   missing.push('language');
    if (!fileName)   missing.push('fileName');
    if (!runCommand) missing.push('runCommand');
    if (missing.length > 0) {
      return res.status(400).json({
        error:   'missing_fields',
        message: `Required fields missing: ${missing.join(', ')}`,
      });
    }

    // Reject if already registered
    if (langRegistry.isSupported(language)) {
      return res.status(409).json({
        error:   'language_exists',
        message: `Language "${language}" is already registered.`,
      });
    }

    const result = await adminService.addLanguage({
      language,
      fileName,
      compileCommand: compileCommand || '',
      runCommand,
      dockerfile,
      baseImage,
    });

    return res.status(201).json(result);
  } catch (err) {
    console.error('[admin] addLanguage:', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
