/**
 * cgroupMemoryTracker.js
 *
 * Tracks peak memory usage of a running Docker container by polling
 * `docker stats` via the Docker daemon API (Dockerode).
 *
 * Why this approach instead of reading /sys/fs/cgroup directly:
 *   - Works on any host OS (Linux, macOS, Windows) — no cgroup path required
 *   - Docker daemon reads cgroup memory.current internally and exposes it
 *     through the stats stream, so this is equivalent to polling memory.current
 *   - No extra npm dependencies
 *
 * Usage:
 *   const tracker = new CgroupMemoryTracker(containerName, { intervalMs: 30 });
 *   await tracker.start();
 *   // ... run the submission ...
 *   const peakBytes = await tracker.stop();
 */

'use strict';

const Docker = require('dockerode');

const docker = new Docker();

class CgroupMemoryTracker {
  /**
   * @param {string} containerName  Docker container name or ID
   * @param {object} [opts]
   * @param {number} [opts.intervalMs=30]  Polling interval in milliseconds
   */
  constructor(containerName, { intervalMs = 30 } = {}) {
    this._name       = containerName;
    this._intervalMs = intervalMs;
    this._peakBytes  = 0;
    this._timer      = null;
    this._running    = false;
  }

  /**
   * Start polling peak memory in the background.
   * Resolves immediately — does NOT block.
   */
  async start() {
    this._running    = true;
    this._peakBytes  = 0;

    // Fire-and-forget polling loop — errors are caught per-tick so a single
    // failure (e.g. container momentarily not ready) does not stop tracking.
    this._poll();
  }

  _poll() {
    if (!this._running) return;

    this._readMemory()
      .then((bytes) => {
        if (bytes > this._peakBytes) this._peakBytes = bytes;
      })
      .catch(() => {
        // Silently ignore — container may have just exited during a tick
      })
      .finally(() => {
        if (this._running) {
          this._timer = setTimeout(() => this._poll(), this._intervalMs);
        }
      });
  }

  /**
   * Read the current memory usage from Docker stats (one-shot, no-stream).
   * Docker daemon translates cgroup memory.current into MemoryStats.usage.
   *
   * @returns {Promise<number>}  bytes used, or 0 on error
   */
  async _readMemory() {
    try {
      const container = docker.getContainer(this._name);
      const stats     = await container.stats({ stream: false });

      // stats.memory_stats.usage = bytes used by the container cgroup
      // stats.memory_stats.stats.cache = page cache (file-backed pages)
      // "working set" = usage - cache  (mirrors kubectl top / cgroup v2 rss)
      const usage = stats?.memory_stats?.usage   || 0;
      const cache = stats?.memory_stats?.stats?.cache || 0;
      return Math.max(0, usage - cache);
    } catch {
      return 0;
    }
  }

  /**
   * Stop polling and return the peak bytes observed.
   * Safe to call even if start() was never called.
   *
   * @returns {Promise<number>}  peak bytes
   */
  async stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    // Do one final read after the process exits to capture the last snapshot
    const lastRead = await this._readMemory().catch(() => 0);
    if (lastRead > this._peakBytes) this._peakBytes = lastRead;

    return this._peakBytes;
  }

  /**
   * Current peak in kilobytes (rounded to 2 decimal places).
   */
  get peakKB() {
    return parseFloat((this._peakBytes / 1024).toFixed(2));
  }

  /**
   * Current peak in megabytes (rounded to 2 decimal places).
   */
  get peakMB() {
    return parseFloat((this._peakBytes / (1024 * 1024)).toFixed(2));
  }
}

module.exports = CgroupMemoryTracker;
