const express = require('express');
const router = express.Router();
const SubmissionController = require('../controllers/submission.controller');

router.post('/', SubmissionController.createSubmission);
router.get('/:id', SubmissionController.getSubmission);

module.exports = router;
// kept CommonJS router and exports; removed duplicate ES module code