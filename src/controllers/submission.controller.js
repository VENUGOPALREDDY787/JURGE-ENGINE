const ExecutionService = require('../services/execution.service.js');
const { getSubmissionModel } = require('../models/Submission');
const config = require('../config');

const ALL_LANGS = Object.values(config.supportedLanguages);

// ---------------------------------------------------------------------------
// Serialize a Mongoose document to the Judge0-style response shape.
// `_id` is returned as `token` (ObjectId → string handled by JSON.stringify).
// `time` is formatted as a 3-decimal-place string (e.g. "0.038").
// ---------------------------------------------------------------------------
function toResponse(doc) {
  return {
    token:          doc._id,
    stdout:         doc.stdout          || null,
    stderr:         doc.stderr          || null,
    compile_output: doc.compile_output  || null,
    message:        doc.message         || null,
    time:           doc.time != null ? String(Number(doc.time).toFixed(3)) : null,
    memory:         doc.memory          ?? null,
    status:         doc.status,
  };
}

// ---------------------------------------------------------------------------
// POST /api/submissions
// ---------------------------------------------------------------------------
exports.createSubmission = async (req, res) => {
  try {
    const { sourceCode, language, stdin } = req.body;
    if (!sourceCode || !language) {
      return res.status(400).json({ error: 'sourceCode and language required' });
    }

    const submission = await ExecutionService.createAndEnqueue({ sourceCode, language, stdin });
    // Return `token` (= _id) so the client can poll via GET /:id
    return res.status(202).json({ token: submission._id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/submissions/:id
// Searches across all per-language collections sequentially (at most 6
// indexed findById calls). Returns the first match serialized as Judge0 shape.
// ---------------------------------------------------------------------------
exports.getSubmission = async (req, res) => {
  try {
    const { id } = req.params;

    for (const lang of ALL_LANGS) {
      const Model = getSubmissionModel(lang);
      // eslint-disable-next-line no-await-in-loop
      const submission = await Model.findById(id).lean();
      if (submission) return res.json(toResponse(submission));
    }

    return res.status(404).json({ error: 'not_found' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
};