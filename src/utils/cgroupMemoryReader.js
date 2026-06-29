'use strict';

/**
 * cgroupMemoryReader.js
 *
 * Reads peak memory usage for a Docker container from the Linux cgroup
 * filesystem in a SINGLE read — no polling, no intervals, no loops.
 *
 * Strategy (tried in order, first success wins):
 *
 *   1. cgroup v2  — /sys/fs/cgroup/<docker-path>/memory.peak
 *        High-watermark maintained by the kernel since cgroup creation (or last reset).
 *        Reset to 0 before each run so pool containers get per-run accuracy.
 *
 *   2. cgroup v1  — /sys/fs/cgroup/memory/<docker-path>/memory.max_usage_in_bytes
 *        Same semantics on cgroup v1.
 *        Reset by writing 0 to the file before each run.
 *
 *   3. Docker stats API  — container.stats({ stream: false })
 *        Single HTTP call, no stream. Returns CURRENT usage (not peak),
 *        but is the best we can do when host cgroup paths are inaccessible
 *        (e.g., running inside Docker-in-Docker or on macOS/Windows hosts).
 *
 * Read timing:
 *   Must be called AFTER execInContainer(run) finishes but BEFORE
 *   cleanupWorkspace() — the container stays alive so the cgroup path is valid.
 */

const fs     = require('fs/promises');
const path   = require('path');
const Docker = require('dockerode');

const docker = new Docker();

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Find the host-side cgroup path for the given container.
 *
 * Uses the container's PID read from Docker inspect, then parses
 * /proc/<pid>/cgroup to get the actual cgroup path in use.
 * This works for both cgroup v1 and cgroup v2.
 *
 * Returns { version, cgroupPath } or null if unavailable.
 */
async function detectCgroupInfo(containerName) {
  try {
    const container = docker.getContainer(containerName);
    const info      = await container.inspect();
    const pid       = info?.State?.Pid;

    if (!pid || pid === 0) {
      console.log(`[memory] Container ${containerName} has no PID (not running?)`);
      return null;
    }

    // /proc/<pid>/cgroup lines:
    //   cgroup v2:  "0::/docker/<id>"
    //   cgroup v1:  "6:memory:/docker/<id>"
    const cgroupFile = `/proc/${pid}/cgroup`;
    let raw;
    try {
      raw = await fs.readFile(cgroupFile, 'utf8');
    } catch {
      console.log(`[memory] Cannot read ${cgroupFile} — not on Linux host or PID gone`);
      return null;
    }

    const lines = raw.trim().split('\n');

    // --- cgroup v2 detection ---
    // A cgroup v2-only system has exactly one line starting with "0::/"
    const v2Line = lines.find(l => l.startsWith('0::'));
    if (v2Line) {
      const relative = v2Line.split('::')[1] || '';          // e.g. "/docker/abc123..."
      const absolute = path.join('/sys/fs/cgroup', relative); // /sys/fs/cgroup/docker/abc123...
      console.log(`[memory] cgroup v2 detected — path: ${absolute}`);
      return { version: 2, cgroupPath: absolute };
    }

    // --- cgroup v1 detection ---
    // Find the memory controller line: "<n>:memory:<path>"
    const v1Line = lines.find(l => /^\d+:memory:/.test(l));
    if (v1Line) {
      const relative = v1Line.split(':')[2] || '';
      const absolute = path.join('/sys/fs/cgroup/memory', relative);
      console.log(`[memory] cgroup v1 detected — path: ${absolute}`);
      return { version: 1, cgroupPath: absolute };
    }

    console.log(`[memory] Could not parse cgroup version from:\n${raw}`);
    return null;
  } catch (err) {
    console.log(`[memory] detectCgroupInfo error: ${err.message}`);
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * resetPeakMemory(containerName)
 *
 * Writes 0 to the high-watermark file so the next readPeakMemory() reflects
 * only the current submission — not accumulated usage across pool reuse.
 *
 * Call BEFORE execInContainer(run) starts.
 * Silently no-ops on cgroup v1 kernels < 4.18 or when /proc is inaccessible.
 */
async function resetPeakMemory(containerName) {
  const info = await detectCgroupInfo(containerName);
  if (!info) return;

  const { version, cgroupPath } = info;

  try {
    if (version === 2) {
      await fs.writeFile(path.join(cgroupPath, 'memory.peak'), '0\n');
      console.log(`[memory] Reset memory.peak (cgroup v2) at ${cgroupPath}`);
    } else {
      // cgroup v1: write 0 to max_usage_in_bytes to reset
      await fs.writeFile(
        path.join(cgroupPath, 'memory.max_usage_in_bytes'),
        '0\n'
      );
      console.log(`[memory] Reset memory.max_usage_in_bytes (cgroup v1) at ${cgroupPath}`);
    }
  } catch (err) {
    // Silently ignore — kernel may not support resetting (older cgroup v1)
    console.log(`[memory] Peak reset not supported: ${err.message}`);
  }
}

/**
 * readPeakMemory(containerName)
 *
 * Reads the high-watermark memory from cgroup files — ONE read, no polling.
 * Call AFTER execInContainer(run) finishes, BEFORE cleanupWorkspace().
 *
 * Returns peak bytes as a number (0 on any failure — never throws).
 */
async function readPeakMemory(containerName) {
  const info = await detectCgroupInfo(containerName);

  if (info) {
    const { version, cgroupPath } = info;

    // ── Strategy 1: cgroup v2  memory.peak ───────────────────────────────
    if (version === 2) {
      try {
        const raw   = await fs.readFile(path.join(cgroupPath, 'memory.peak'), 'utf8');
        const bytes = parseInt(raw.trim(), 10);
        if (!Number.isNaN(bytes) && bytes > 0) {
          console.log(`[memory] cgroup v2 memory.peak = ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MB)`);
          return bytes;
        }
        console.log(`[memory] cgroup v2 memory.peak was 0 or invalid: "${raw.trim()}"`);
      } catch (err) {
        console.log(`[memory] Cannot read memory.peak: ${err.message}`);
      }
    }

    // ── Strategy 2: cgroup v1  memory.max_usage_in_bytes ─────────────────
    if (version === 1) {
      try {
        const raw   = await fs.readFile(
          path.join(cgroupPath, 'memory.max_usage_in_bytes'),
          'utf8'
        );
        const bytes = parseInt(raw.trim(), 10);
        if (!Number.isNaN(bytes) && bytes > 0) {
          console.log(`[memory] cgroup v1 max_usage_in_bytes = ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MB)`);
          return bytes;
        }
        console.log(`[memory] cgroup v1 max_usage_in_bytes was 0 or invalid: "${raw.trim()}"`);
      } catch (err) {
        console.log(`[memory] Cannot read max_usage_in_bytes: ${err.message}`);
      }
    }
  }

  // ── Strategy 3: Docker stats API (single call, no polling) ───────────────
  // Last resort — reads CURRENT memory (not peak), but better than 0.
  // On cgroup v2 hosts where the host cgroup path is inaccessible (e.g. running
  // the engine inside Docker itself) this is the only usable fallback.
  console.log('[memory] Falling back to Docker stats API (single read, current usage)');
  try {
    const container = docker.getContainer(containerName);
    const stats     = await container.stats({ stream: false });

    const usage     = stats?.memory_stats?.usage || 0;

    // cgroup v2: the working-set excludes inactive file-backed pages
    // cgroup v1: the working-set excludes the page cache field "cache"
    // We try inactive_file first (v2), then cache (v1), then 0
    const inactive = stats?.memory_stats?.stats?.inactive_file || 0;
    const cache    = stats?.memory_stats?.stats?.cache         || 0;
    const deduct   = inactive || cache;

    const bytes = Math.max(0, usage - deduct);
    console.log(
      `[memory] Docker stats: usage=${usage}, inactive_file=${inactive}, cache=${cache}, net=${bytes}`
    );
    return bytes;
  } catch (err) {
    console.log(`[memory] Docker stats API failed: ${err.message}`);
  }

  console.log('[memory] All strategies failed — returning 0');
  return 0;
}

module.exports = { resetPeakMemory, readPeakMemory };
