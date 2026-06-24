const express = require('express');
const router = express.Router();
const SubmissionController = require('../controllers/submission.controller');

router.post('/', SubmissionController.createSubmission);

// IMPORTANT: batch routes must be registered BEFORE /:id
// so Express does not match the string 'batch' as an id param.
router.post('/batch', SubmissionController.createBatch);
router.get('/batch',  SubmissionController.getBatch);

router.get('/:id', SubmissionController.getSubmission);

module.exports = router;
// kept CommonJS router and exports; removed duplicate ES module code