const { Runtime, seedRuntimeDefaults } = require('../models/Runtime');
const runtimeService = require('../services/runtime.service');
const config = require('../config');

const VALID_LANGS = Object.values(config.supportedLanguages);

// ---------------------------------------------------------------------------
// GET /api/runtimes
// Returns all runtime entries. Seeds defaults on first call.
// ---------------------------------------------------------------------------
exports.listRuntimes = async (req, res) => {
  try {
    await seedRuntimeDefaults();
    const runtimes = await Runtime.find(
      {},
      { language: 1, version: 1, imageName: 1, status: 1, updatedAt: 1, _id: 0 }
    ).lean();
    return res.json(runtimes);
  } catch (err) {
    console.error('[runtime] listRuntimes error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/runtimes/:language
// Returns a single runtime entry.
// ---------------------------------------------------------------------------
exports.getRuntime = async (req, res) => {
  try {
    const { language } = req.params;
    if (!VALID_LANGS.includes(language)) {
      return res.status(400).json({ error: 'unsupported_language' });
    }

    await seedRuntimeDefaults();
    const runtime = await Runtime.findOne(
      { language },
      { language: 1, version: 1, imageName: 1, status: 1, updatedAt: 1, _id: 0 }
    ).lean();
    if (!runtime) return res.status(404).json({ error: 'not_found' });
    return res.json(runtime);
  } catch (err) {
    console.error('[runtime] getRuntime error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/runtimes/:language
// Triggers an async runtime version upgrade.
// Returns 202 immediately — client polls GET /:language/status for progress.
// ---------------------------------------------------------------------------
exports.updateRuntime = async (req, res) => {
  try {
    const { language } = req.params;
    const { version }  = req.body;

    // Validate language
    if (!VALID_LANGS.includes(language)) {
      return res.status(400).json({ error: 'unsupported_language' });
    }

    // Validate version string
    if (!version || typeof version !== 'string' || !version.trim()) {
      return res.status(400).json({ error: 'version_required', message: '"version" field is required' });
    }
    const newVersion = version.trim();

    await seedRuntimeDefaults();

    // Guard: reject if a build is already running
    const runtime = await Runtime.findOne({ language });
    if (!runtime) return res.status(404).json({ error: 'not_found' });
    if (runtime.status === 'building') {
      return res.status(409).json({
        error:   'already_building',
        message: `A build is already in progress for "${language}". Poll GET /api/runtimes/${language}/status for updates.`,
      });
    }

    // Safety check: reject if any container for this language is currently executing a job
    const busyCount = await runtimeService.getBusyContainerCount(language);
    if (busyCount > 0) {
      return res.status(409).json({
        error:   'active_jobs',
        message: `${busyCount} container(s) are currently busy for "${language}". Wait for active jobs to finish before upgrading.`,
      });
    }

    // Fire-and-forget — the build runs in the background.
    // Errors are caught inside upgradeRuntime and persisted to MongoDB (status:'failed').
    runtimeService.upgradeRuntime(language, newVersion).catch((err) => {
      console.error(`[runtime] Background upgrade failed for ${language}@${newVersion}:`, err.message);
    });

    return res.status(202).json({
      message:   'Build started successfully',
      language,
      version:   newVersion,
      statusUrl: `/api/runtimes/${language}/status`,
    });
  } catch (err) {
    console.error('[runtime] updateRuntime error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/runtimes/:language/status
// Returns build progress — poll this after PUT until status returns to 'idle'.
// ---------------------------------------------------------------------------
exports.getRuntimeStatus = async (req, res) => {
  try {
    const { language } = req.params;
    if (!VALID_LANGS.includes(language)) {
      return res.status(400).json({ error: 'unsupported_language' });
    }

    const runtime = await Runtime.findOne(
      { language },
      { language: 1, version: 1, status: 1, buildLog: 1, updatedAt: 1, _id: 0 }
    ).lean();

    if (!runtime) return res.status(404).json({ error: 'not_found' });
    return res.json(runtime);
  } catch (err) {
    console.error('[runtime] getRuntimeStatus error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
