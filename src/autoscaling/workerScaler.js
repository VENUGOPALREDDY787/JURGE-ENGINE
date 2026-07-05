/**
 * workerScaler.js
 *
 * Worker Autoscaling Module — Architecture-Ready Stub
 *
 * Current behavior (Phase 1):
 *   Idle-based scale-DOWN only. When a language queue has zero waiting and
 *   zero active jobs, the container pool is scaled down to its minimum size.
 *   This is the same logic previously inlined inside launchWorkers.js, now
 *   extracted here so it is independently testable and extensible.
 *
 * Future autoscaling policies (Phase 2+) can be added here without touching
 * worker or launcher code:
 *   - Backlog-based scale-UP:  if waiting > threshold, create more containers.
 *   - CPU-based scale-UP:      if avg CPU > X%, spawn more worker instances.
 *   - Throughput-based:        track jobs/sec and pre-warm when trending up.
 *   - Cross-node coordination: publish scale events on Redis pub/sub so
 *     all worker nodes act in concert.
 *
 * Architecture contract:
 *   - startScaleWatcher(lang, queue, options) → starts the background watcher.
 *   - stopScaleWatcher(lang)                 → cancels a running watcher.
 *   - Workers remain fully STATELESS — this module only adjusts the container
 *     pool; workers themselves are unaffected.
 */

const { scaleDownPool } = require('../sandbox/containerManager');

// Internal registry of active watchers { lang → TimerRef }
const _watchers = {};

/**
 * startScaleWatcher(lang, monitorQueue, options)
 *
 * Starts a background idle-scale-down timer for the given language.
 * Idempotent — calling for an already-watched language is a no-op.
 *
 * @param {string}   lang         — e.g. 'java'
 * @param {Queue}    monitorQueue — A BullMQ Queue instance for this language
 * @param {object}   options
 * @param {number}   options.intervalMs — polling interval (default: 60 000ms)
 */
function startScaleWatcher(lang, monitorQueue, { intervalMs = 60000 } = {}) {
  if (_watchers[lang]) return; // already watching

  const timer = setInterval(async () => {
    try {
      const [waiting, active] = await Promise.all([
        monitorQueue.getWaitingCount(),
        monitorQueue.getActiveCount(),
      ]);

      if (waiting === 0 && active === 0) {
        // Queue is idle — scale pool down to its minimum
        await scaleDownPool(lang);
      }

      // ── Future Phase 2: Scale-up hook (not yet implemented) ──────────────
      // if (waiting > SCALE_UP_THRESHOLD) {
      //   await scaleUpPool(lang, waiting);
      // }
    } catch (err) {
      console.warn(`[autoscale] Check failed for ${lang}:`, err.message);
    }
  }, intervalMs);

  // Allow the Node.js process to exit even if this timer is still running
  timer.unref();
  _watchers[lang] = timer;
}

/**
 * stopScaleWatcher(lang)
 *
 * Cancels a running scale watcher. Useful during graceful shutdown or
 * when draining a language pool for an upgrade.
 *
 * @param {string} lang
 */
function stopScaleWatcher(lang) {
  if (_watchers[lang]) {
    clearInterval(_watchers[lang]);
    delete _watchers[lang];
    console.log(`[autoscale] Scale watcher stopped for: ${lang}`);
  }
}

/**
 * getActiveWatchers()
 *
 * Returns the list of language IDs currently being monitored.
 * Useful for health checks and debugging.
 *
 * @returns {string[]}
 */
function getActiveWatchers() {
  return Object.keys(_watchers);
}

module.exports = { startScaleWatcher, stopScaleWatcher, getActiveWatchers };
