/**
 * judge0LanguageMap.js
 *
 * Maps Judge0 numeric language_id values to the internal language strings
 * used by jurge-engine.
 *
 * Only IDs whose target language is registered in supportedLanguages will
 * successfully enqueue — unknown targets are rejected by execution.service
 * with 'unsupported_language'. Add new entries here as new languages are
 * registered via POST /admin/languages.
 *
 * Source: https://judge0.com/
 */

const JUDGE0_LANGUAGE_MAP = {
  // Bash
  1:  'bash',

  // C / C++
  50: 'c',
  54: 'cpp',

  // C# / F#  (not yet in default engine — will return unsupported_language)
  51: 'csharp',
  52: 'fsharp',

  // Go
  60: 'go',
  95: 'go',

  // Java
  62: 'java',

  // JavaScript (Node.js)
  63: 'javascript',
  93: 'javascript',

  // Kotlin  (unsupported by default)
  78: 'kotlin',

  // Python (2 / 3 variants — all map to 'python' in this engine)
  70: 'python',
  71: 'python',
  92: 'python',
  100: 'python',

  // R  (unsupported by default)
  80: 'r',

  // Ruby  (unsupported by default)
  82: 'ruby',

  // Rust  (unsupported by default)
  73: 'rust',

  // Swift  (unsupported by default)
  83: 'swift',

  // TypeScript  (unsupported by default)
  74: 'typescript',
};

/**
 * Resolve a Judge0 language_id to the internal engine language string.
 * Returns null if the ID is unknown.
 *
 * @param {number|string} languageId
 * @returns {string|null}
 */
function resolveLanguageId(languageId) {
  return JUDGE0_LANGUAGE_MAP[Number(languageId)] || null;
}

module.exports = { JUDGE0_LANGUAGE_MAP, resolveLanguageId };
