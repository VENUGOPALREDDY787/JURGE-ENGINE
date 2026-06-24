const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/admin.controller');

// ── Feature 1: Real-time metrics ──────────────────────────────────────────
router.get('/metrics/queues',      ctrl.getQueueMetrics);
router.get('/metrics/containers',  ctrl.getContainerMetrics);
router.get('/metrics/submissions', ctrl.getSubmissionMetrics);

// ── Feature 1: Language listing ────────────────────────────────────────────
// NOTE: GET /admin/languages must be registered BEFORE POST /admin/languages
// to avoid Express ambiguity (both are on the same path).
router.get('/languages',  ctrl.getLanguages);

// ── Feature 2: Runtime image management ───────────────────────────────────
// NOTE: /:language/status must come BEFORE /:language to prevent Express
// from matching the literal string 'status' as a :language param.
router.get('/runtime/:language/status', ctrl.getRuntimeStatus);
router.put('/runtime/:language',        ctrl.updateRuntime);

// ── Feature 3: Dynamic language registration ──────────────────────────────
router.post('/languages', ctrl.addLanguage);

module.exports = router;
