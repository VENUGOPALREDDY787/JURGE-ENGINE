const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/runtime.controller');

// IMPORTANT: /:language/status must be registered BEFORE /:language
// to prevent Express from matching 'status' as a language param.

router.get('/',                    ctrl.listRuntimes);
router.get('/:language/status',    ctrl.getRuntimeStatus);
router.get('/:language',           ctrl.getRuntime);
router.put('/:language',           ctrl.updateRuntime);

module.exports = router;
