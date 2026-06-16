const ExecutionService = require('../services/execution.service.js');
const Submission = require('../models/Submission');

exports.createSubmission = async (req, res) => {
  try {
    const { sourceCode, language, stdin } = req.body;
    if (!sourceCode || !language) return res.status(400).json({ error: 'sourceCode and language required' });

    const submission = await ExecutionService.createAndEnqueue({ sourceCode, language, stdin });
    return res.status(202).json({ id: submission._id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
};

exports.getSubmission = async (req, res) => {
  try {
    const id = req.params.id;
    const submission = await Submission.findById(id).lean();
    if (!submission) return res.status(404).json({ error: 'not_found' });
    return res.json(submission);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
};
// (Removed older ES module duplicate exports.)