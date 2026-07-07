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
    const container = await containerManager.getContainerHandle(containerName);

    // ── Unified Compile + Run + Cleanup Execution ─────────────────────────
    console.time('run');
    await resetPeakMemory(containerName).catch(() => {});

    // Encode sourceCode and stdin to base64 to write files inline in the exec script safely
    const base64Source = Buffer.from(sourceCode).toString('base64');
    const base64Stdin  = Buffer.from(stdin || '').toString('base64');

    let cmd = `echo '${base64Source}' | base64 -d > /workspace/${lang.file}
echo '${base64Stdin}' | base64 -d > /workspace/input.txt
`;

    if (lang.compile) {
      cmd += `if ${lang.compile} > /tmp/compile.out 2>&1; then
  ${lang.run} < /workspace/input.txt
  status=$?
else
  cat /tmp/compile.out >&2
  status=254
fi
find /workspace -mindepth 1 -delete 2>/dev/null || true
exit $status`;
    } else {
      cmd += `${lang.run} < /workspace/input.txt
status=$?
find /workspace -mindepth 1 -delete 2>/dev/null || true
exit $status`;
    }

    let execRes;
    runStartTime = Date.now();
    execRes = await containerManager._execWithHandle(container, cmd);
    const runDurationMs = Date.now() - runStartTime;
    console.timeEnd('run');

    peakMemoryBytes = await readPeakMemory(containerName).catch(() => 0);

    shouldRecycle = await containerManager.incrementUsage(containerName);

    return {
      stdout:         execRes.stdout || null,
      stderr:         execRes.stderr || null,
      compile_output: null,
      message:        null,
      verdict:        'Accepted',
      timeMs:         runDurationMs,
      ...memFields(peakMemoryBytes),
    };

  } catch (err) {
    // Guarantee cleanup in case of unexpected execution failures
    await containerManager.cleanupWorkspace(containerName).catch(() => {});
    shouldRecycle = await containerManager.incrementUsage(containerName);

    if (err.exitCode === 254) {
      return {
        stdout:         null,
        stderr:         null,
        compile_output: err.stderr || err.message || 'Compilation failed',
        message:        null,
        verdict:        'Compilation Error',
        timeMs:         0,
        ...memFields(0),
      };
    }

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
