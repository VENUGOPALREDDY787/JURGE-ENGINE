const ExecutionService = require('../services/execution.service.js');
const { getSubmissionModel, getUnifiedModel } = require('../models/Submission');
const langRegistry   = require('../utils/languageRegistry');
const { resolveLanguageId } = require('../config/judge0LanguageMap');

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
    memory:         doc.memory          ?? null,   // peak bytes
    memoryUsedKB:   doc.memoryUsedKB    ?? null,
    memoryUsedMB:   doc.memoryUsedMB    ?? null,
    status:         doc.status,
  };
}

// ---------------------------------------------------------------------------
// normalizeSubmission(raw)
//
// Accepts EITHER the native jurge-engine format OR the Judge0 format and
// returns a unified internal object. Both formats can be mixed freely in
// batch requests — each item is normalized independently.
//
// Native format:   { language, sourceCode, stdin, expected_output? }
// Judge0 format:   { language_id, source_code, stdin?, expected_output? }
//
// If both language and language_id are present, language takes priority.
// Returns { _unknownLanguageId } when language_id is unrecognized, so the
// caller can surface a clear 400 error before any DB write.
// ---------------------------------------------------------------------------
function normalizeSubmission(raw) {
  const isJudge0 = raw.source_code !== undefined || raw.language_id !== undefined;

  if (!isJudge0) {
    // Native format — pass through unchanged
    return {
      sourceCode:      raw.sourceCode,
      language:        raw.language,
      stdin:           raw.stdin           || '',
      expected_output: raw.expected_output || null,
      callback_url:    raw.callback_url    || null,
      metadata:        raw.metadata        || null,
    };
  }

  // Judge0 format
  let language = raw.language; // explicit override always wins
  if (!language && raw.language_id != null) {
    language = resolveLanguageId(raw.language_id);
    if (!language) {
      if (typeof raw.language_id === 'string' && langRegistry.isSupported(raw.language_id)) {
        language = raw.language_id;
      } else {
        return { _unknownLanguageId: raw.language_id };
      }
    }
  }

  return {
    sourceCode:      raw.source_code      || raw.sourceCode || '',
    language,
    stdin:           raw.stdin            || '',
    expected_output: raw.expected_output  || null,
    callback_url:    raw.callback_url    || null,
    metadata:        raw.metadata        || null,
  };
}

// ---------------------------------------------------------------------------
// POST /api/submissions
// ---------------------------------------------------------------------------
exports.createSubmission = async (req, res) => {
  try {
    const normalized = normalizeSubmission(req.body);

    if (normalized._unknownLanguageId !== undefined) {
      return res.status(400).json({
        error:       'unknown_language_id',
        language_id: normalized._unknownLanguageId,
        message:     `language_id ${normalized._unknownLanguageId} is not recognized. See /src/config/judge0LanguageMap.js for supported IDs.`,
      });
    }

    const { sourceCode, language, stdin, expected_output, callback_url, metadata } = normalized;
    if (!sourceCode || !language) {
      return res.status(400).json({ error: 'sourceCode (or source_code) and language (or language_id) are required' });
    }

    const submission = await ExecutionService.createAndEnqueue({ sourceCode, language, stdin, expected_output, callback_url, metadata });
    return res.status(202).json({ token: submission._id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/submissions/:id
// Checks the unified 'submissions' collection first (O(1) indexed _id lookup).
// Falls back to per-language collections for tokens created before the unified
// collection existed, ensuring zero regression for existing tokens.
// ---------------------------------------------------------------------------
exports.getSubmission = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Try unified collection first — fast single indexed lookup
    const unified = getUnifiedModel();
    const unifiedDoc = await unified.findById(id).lean();
    if (unifiedDoc) return res.json(toResponse(unifiedDoc));

    // 2. Fallback: search per-language collections for pre-migration tokens
    const ALL_LANGS = langRegistry.getAll();
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

// ---------------------------------------------------------------------------
// POST /api/submissions/batch
// Judge0-compatible batch submission.
//
// Body: { "submissions": [{ language, sourceCode, stdin }, ...] }
//
// Strategy:
//   1. Validate all items up-front (fail fast before any DB writes)
//   2. Fan out to createAndEnqueue() in parallel via Promise.allSettled
//      so one bad submission does not block others
//   3. Return array of { token } objects in the same order as input
// ---------------------------------------------------------------------------
exports.createBatch = async (req, res) => {
  try {
    const { submissions } = req.body;

    if (!Array.isArray(submissions) || submissions.length === 0) {
      return res.status(400).json({ error: 'submissions must be a non-empty array' });
    }
    if (submissions.length > 500) {
      return res.status(400).json({ error: 'batch size exceeds maximum of 500' });
    }

    // Validate all items before touching the DB
    for (let i = 0; i < submissions.length; i++) {
      const norm = normalizeSubmission(submissions[i]);
      if (norm._unknownLanguageId !== undefined) {
        return res.status(400).json({
          error:       `submissions[${i}]: unknown language_id`,
          language_id: norm._unknownLanguageId,
        });
      }
      if (!norm.sourceCode || !norm.language) {
        return res.status(400).json({
          error: `submissions[${i}]: sourceCode (or source_code) and language (or language_id) are required`,
        });
      }
      submissions[i] = norm; // replace raw item with normalized form in-place
    }

    // Fan out in parallel — each call is independent (own DB doc + queue job).
    // Promise.allSettled so one failure does not abort the others.
    const results = await Promise.allSettled(
      submissions.map(({ sourceCode, language, stdin, expected_output, callback_url, metadata }) =>
        ExecutionService.createAndEnqueue({ sourceCode, language, stdin, expected_output, callback_url, metadata })
      )
    );

    // Build response preserving input order.
    // Fulfilled → { token: id }
    // Rejected  → { token: null, error: message }  (caller knows which one failed)
    const response = results.map((result) => {
      if (result.status === 'fulfilled') {
        return { token: result.value._id };
      }
      return { token: null, error: result.reason?.message || 'enqueue_failed' };
    });

    return res.status(202).json(response);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/submissions/batch
// Judge0-compatible batch result polling.
//
// Query: ?tokens=token1,token2,token3
//
// Strategy:
//   - Query the unified 'submissions' collection with $in in ONE round-trip.
//   - Fall back to per-language collections for any tokens not found (old tokens).
//   - Results re-ordered to match original token order.
// ---------------------------------------------------------------------------
exports.getBatch = async (req, res) => {
  try {
    const { tokens: tokensParam } = req.query;

    if (!tokensParam) {
      return res.status(400).json({ error: 'tokens query param is required' });
    }

    const tokens = tokensParam.split(',').map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) {
      return res.status(400).json({ error: 'no valid tokens provided' });
    }
    if (tokens.length > 500) {
      return res.status(400).json({ error: 'token count exceeds maximum of 500' });
    }

    // 1. Single round-trip to unified collection
    const unified = getUnifiedModel();
    const unifiedDocs = await unified.find({ _id: { $in: tokens } }).lean();

    // Index by _id string for O(1) lookup
    const docById = {};
    for (const doc of unifiedDocs) {
      docById[String(doc._id)] = doc;
    }

    // 2. Find any tokens not in unified collection (pre-migration tokens)
    const missing = tokens.filter((t) => !docById[t]);
    if (missing.length > 0) {
      const perLangResults = await Promise.all(
        langRegistry.getAll().map((lang) =>
          getSubmissionModel(lang)
            .find({ _id: { $in: missing } })
            .lean()
        )
      );
      for (const docs of perLangResults) {
        for (const doc of docs) {
          docById[String(doc._id)] = doc;
        }
      }
    }

    // Re-order to match the original token order requested by the client
    const submissions = tokens.map((token) => {
      const doc = docById[token];
      if (!doc) {
        return { token, status: { id: 0, description: 'Not Found' } };
      }
      return toResponse(doc);
    });

    return res.json({ submissions });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
};