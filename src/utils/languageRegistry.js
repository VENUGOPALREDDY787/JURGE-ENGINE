/**
 * languageRegistry.js
 *
 * Shared singleton registry of supported languages.
 * Starts with the static languages from config/index.js and grows at runtime
 * when new languages are added via POST /admin/languages.
 *
 * Both the API process and the worker process maintain their own in-memory
 * copy. The worker process syncs via Redis pub/sub (jurge:new-language channel)
 * and MongoDB persistence on restart.
 */
const { SUPPORTED_LANGUAGE_IDS } = require('../config/languages');

// Start with all statically configured languages.
// Grows at runtime when new languages are added via POST /admin/languages.
const _registry = new Set(SUPPORTED_LANGUAGE_IDS);

/**
 * Check whether a language is currently supported.
 * @param {string} language
 * @returns {boolean}
 */
function isSupported(language) {
  return _registry.has(language);
}

/**
 * Return all currently supported languages as an array.
 * @returns {string[]}
 */
function getAll() {
  return Array.from(_registry);
}

/**
 * Register a new language at runtime (no restart required).
 * Safe to call multiple times with the same language (idempotent).
 * @param {string} language
 */
function register(language) {
  _registry.add(language);
}

module.exports = { isSupported, getAll, register };
