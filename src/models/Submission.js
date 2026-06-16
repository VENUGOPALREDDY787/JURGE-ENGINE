const mongoose = require('mongoose');

const SubmissionSchema = new mongoose.Schema({
  sourceCode: { type: String, required: true },
  language: { type: String, required: true, index: true },
  stdin: { type: String, default: '' },
  status: { type: String, enum: ['queued','running','completed','failed'], default: 'queued', index: true },
  stdout: { type: String, default: '' },
  stderr: { type: String, default: '' },
  compileOutput: { type: String, default: '' },
  executionTime: { type: Number, default: 0 },
  memoryUsage: { type: Number, default: 0 },
  verdict: { type: String, default: 'Queued' },
}, { timestamps: true });

SubmissionSchema.index({ createdAt: 1 });

module.exports = mongoose.model('Submission', SubmissionSchema);
// cleaned: removed duplicate ES module schema definitions