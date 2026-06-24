const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Status constants — mirrors Judge0 numeric status codes
// ---------------------------------------------------------------------------
const STATUS = {
  IN_QUEUE:          { id: 1,  description: 'In Queue' },
  PROCESSING:        { id: 2,  description: 'Processing' },
  ACCEPTED:          { id: 3,  description: 'Accepted' },
  WRONG_ANSWER:      { id: 4,  description: 'Wrong Answer' },
  TLE:               { id: 5,  description: 'Time Limit Exceeded' },
  COMPILATION_ERROR: { id: 6,  description: 'Compilation Error' },
  RUNTIME_ERROR:     { id: 11, description: 'Runtime Error' },
  INTERNAL_ERROR:    { id: 13, description: 'Internal Error' },
};

// ---------------------------------------------------------------------------
// Schema — shared across all per-language collections
// ---------------------------------------------------------------------------
const submissionSchema = new mongoose.Schema(
  {
    sourceCode:     { type: String, required: true },
    language:       { type: String, required: true, index: true },
    stdin:          { type: String, default: '' },

    // Output fields (Judge0-style)
    stdout:          { type: String, default: null },
    stderr:          { type: String, default: null },
    compile_output:  { type: String, default: null },
    message:         { type: String, default: null },

    // Optional Judge0-style output validator.
    // When set, the worker compares stdout.trim() against this value and
    // sets status = ACCEPTED or WRONG_ANSWER accordingly.
    // Null means no comparison — verdict comes directly from the sandbox.
    expected_output: { type: String, default: null },

    // Metrics
    time:   { type: Number, default: null },  // seconds (float)
    memory: { type: Number, default: null },  // kilobytes

    // Status object — { id: Number, description: String }
    status: {
      id:          { type: Number, default: 1 },
      description: { type: String, default: 'In Queue' },
    },
  },
  { timestamps: true }
);

submissionSchema.index({ createdAt: 1 });

// ---------------------------------------------------------------------------
// Per-language model factory
// Caches models so mongoose doesn't re-compile the schema on every call.
// Collection name format:  <language>_submissions
//   e.g. java → java_submissions, python → python_submissions
// ---------------------------------------------------------------------------
const modelCache = {};

function getSubmissionModel(language) {
  if (modelCache[language]) return modelCache[language];
  const collectionName = `${language}_submissions`;
  // 3rd arg to mongoose.model() forces the collection name
  modelCache[language] = mongoose.model(collectionName, submissionSchema, collectionName);
  return modelCache[language];
}

module.exports = { getSubmissionModel, STATUS };