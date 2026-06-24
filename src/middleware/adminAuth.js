/**
 * adminAuth.js
 *
 * Middleware that protects all /admin routes.
 * Uses API key strategy — no extra npm dependencies required.
 *
 * Usage: set ADMIN_API_KEY in .env
 * Clients: send  x-admin-api-key: <key>  header
 */
const config = require('../config');

module.exports = function adminAuth(req, res, next) {
  // Warn loudly if the key was never configured
  if (!config.adminApiKey) {
    return res.status(503).json({
      error:   'admin_not_configured',
      message: 'ADMIN_API_KEY environment variable is not set. Admin access is disabled.',
    });
  }

  const provided = req.headers['x-admin-api-key'];

  if (!provided || provided !== config.adminApiKey) {
    return res.status(401).json({
      error:   'unauthorized',
      message: 'Missing or invalid x-admin-api-key header.',
    });
  }

  next();
};
