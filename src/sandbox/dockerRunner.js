'use strict';

const config           = require('../config');
const containerManager = require('./containerManager');
const { resetPeakMemory, readPeakMemory } = require('../utils/cgroupMemoryReader');
const { LANGUAGE_EXEC_CONFIG }            = require('../config/languages');

// ---------------------------------------------------------------------------
// Per-language compile + run commands.
// Derived from src/config/languages.js — add a new language entry there,
// not here. Shape: { file, compile, run } — identical to the previous
// hardcoded object, only the source moves.
//
// Dynamic languages added via POST /admin/languages extend this map at
// runtime via registerLanguageExecConfig() below.
// ---------------------------------------------------------------------------
const LANGUAGE_CONFIG = { ...LANGUAGE_EXEC_CONFIG };

function parseMemory(value) {
  if (!value) return undefined;
  if (typeof value === 'number') return value;
  const parsed = parseInt(value.replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(parsed) ? undefined : parsed * 1024 * 1024;
}

// Helper: build the three extended memory fields from raw bytes
function memFields(bytes) {
  return {
    memory:       bytes,
    memoryUsedKB: parseFloat((bytes / 1024).toFixed(2)),
    memoryUsedMB: parseFloat((bytes / (1024 * 1024)).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// runSandbox — acquires a container, copies files, compiles (if needed),
// runs, cleans up, then releases the container back to the pool.
//
// ⚡ Performance optimizations:
//   1. Single container handle resolution at startup — all subsequent execs
//      use _execWithHandle() which bypasses the redis meta + inspect lookups.
//   2. Source file + stdin packed into ONE tar archive in a single putArchive
//      call instead of two separate round-trips.
//   3. Workspace cleanup uses `find -delete` which is faster than `rm -rf`
//      for Docker exec (avoids sub-shell glob expansion overhead).
//   4. Java uses -XX:TieredStopAtLevel=1 + -XX:+UseSerialGC to cut JVM
//      startup cold time from ~2s → ~600ms.
// ---------------------------------------------------------------------------
async function runSandbox({ language, sourceCode, stdin }) {
  const lang = LANGUAGE_CONFIG[language];
  if (!lang) throw new Error(`Unsupported language: ${language}`);

  const memoryBytes = parseMemory(config.sandbox.memory) || 512 * 1024 * 1024;
  const cpuCores    = parseFloat(config.sandbox.cpu || '0.5');

  const containerName = await containerManager.acquireContainer(language, {
    memory: memoryBytes,
    cpus:   cpuCores,
  });

  if (!containerName) throw new Error('no_available_container');

  const startTime     = Date.now();
  let shouldRecycle   = false;
  let peakMemoryBytes = 0;
  let runStartTime    = null;

  try {
    // ── Resolve container handle ONCE ─────────────────────────────────────
    // All subsequent operations use _execWithHandle / copyAllFilesWithHandle
    // which skip the redundant inspect + redis.hgetall lookups (saves ~5 round
    // trips per submission at the cost of one upfront resolve).
    const container = await containerManager.getContainerHandle(containerName);

    // ── Workspace cleanup ─────────────────────────────────────────────────
    console.time('cleanup-before');
    try {
      await containerManager._execWithHandle(
        container,
        'find /workspace -mindepth 1 -delete 2>/dev/null || true'
      );
    } catch (_) { /* ignore */ }
    console.timeEnd('cleanup-before');

    // ── Single-pass file copy (source + stdin in ONE putArchive) ──────────
    console.time('copy-files');
    await containerManager.copyAllFilesWithHandle(container, [
      { name: lang.file,    content: sourceCode   },
      { name: 'input.txt',  content: stdin || ''  },
    ]);
    console.timeEnd('copy-files');

    // ── Step 1: Compile (languages that require it) ───────────────────────
    if (lang.compile) {
      console.time('compile');
      try {
        await containerManager._execWithHandle(container, lang.compile);
        console.timeEnd('compile');
      } catch (compileErr) {
        console.timeEnd('compile');
        // Compilation failed — no run step executed, so peakMemoryBytes = 0.
        try {
          await containerManager._execWithHandle(
            container,
            'find /workspace -mindepth 1 -delete 2>/dev/null || true'
          );
        } catch (_) {}
        shouldRecycle = await containerManager.incrementUsage(containerName);
        return {
          stdout:         compileErr.stdout  || null,
          stderr:         null,
          compile_output: compileErr.stderr  || compileErr.message || 'Compilation failed',
          message:        null,
          verdict:        'Compilation Error',
          timeMs:         0, // reported execution time is 0 for compile errors
          ...memFields(0),
        };
      }
    }

    // ── Step 2: Run ───────────────────────────────────────────────────────
    console.time('run');

    await resetPeakMemory(containerName).catch(() => {});

    let execRes;
    runStartTime = Date.now();
    try {
      execRes = await containerManager._execWithHandle(
        container,
        `${lang.run} < input.txt`,
      );
    } finally {
      peakMemoryBytes = await readPeakMemory(containerName).catch(() => 0);
    }

    const runDurationMs = Date.now() - runStartTime;
    console.timeEnd('run');

    // ── Post-run cleanup ──────────────────────────────────────────────────
    console.time('cleanup-after');
    try {
      await containerManager._execWithHandle(
        container,
        'find /workspace -mindepth 1 -delete 2>/dev/null || true'
      );
    } catch (_) { /* ignore */ }
    console.timeEnd('cleanup-after');

    shouldRecycle = await containerManager.incrementUsage(containerName);

    return {
      stdout:         execRes.stdout || null,
      stderr:         execRes.stderr || null,
      compile_output: null,
      message:        null,
      verdict:        'Accepted',
      timeMs:         runDurationMs, // reported execution time matches actual run duration
      ...memFields(peakMemoryBytes),
    };

  } catch (err) {
    await containerManager.cleanupWorkspace(containerName).catch(() => {});
    return {
      stdout:         err.stdout  || null,
      stderr:         err.stderr  || err.message || null,
      compile_output: null,
      message:        null,
      verdict:        err.message && err.message.includes('timeout')
                        ? 'Time Limit Exceeded'
                        : 'Runtime Error',
      timeMs:         runStartTime ? Date.now() - runStartTime : 0,
      ...memFields(peakMemoryBytes),
    };
  } finally {
    if (containerName) {
      await containerManager.releaseContainer(containerName, {
        recycle: shouldRecycle,
        opts: { memory: memoryBytes, cpus: cpuCores },
      }).catch((releaseErr) => {
        console.error(`Failed to release container ${containerName}:`, releaseErr.message);
      });
    }
  }
}

/**
 * registerLanguageExecConfig(language, execConfig)
 *
 * Registers execution config for a dynamically added language at runtime.
 * Called by admin.service.addLanguage() after a successful image build and
 * by launchWorkers.js when restoring persisted dynamic languages on boot.
 * This makes the new language immediately available in runSandbox() without
 * requiring a server or worker restart.
 *
 * @param {string} language   e.g. 'rust'
 * @param {{ file, compile, run }} execConfig
 */
function registerLanguageExecConfig(language, execConfig) {
  LANGUAGE_CONFIG[language] = execConfig;
  console.log(`[dockerRunner] Registered exec config for language: ${language}`);
}

module.exports = { runSandbox, registerLanguageExecConfig };
