const mongoose = require('mongoose');

/**
 * LanguageConfig — persists dynamically added language configurations.
 *
 * When a new language is registered via POST /admin/languages, an entry is
 * created here so it survives server/worker restarts. On startup, launchWorkers
 * reads this collection to resume workers for all active dynamic languages.
 */
const languageConfigSchema = new mongoose.Schema(
  {
    language:       { type: String, required: true, unique: true, index: true },
    imageName:      { type: String, required: true },
    fileName:       { type: String, required: true },
    compileCommand: { type: String, default: '' },
    runCommand:     { type: String, required: true },

    // Build lifecycle
    status:   { type: String, enum: ['building', 'active', 'failed'], default: 'building' },
    buildLog: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LanguageConfig', languageConfigSchema, 'language_configs');
