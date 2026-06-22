const config = require('../config');
const containerManager = require('./containerManager');

// ---------------------------------------------------------------------------
// Per-language compile + run commands
// containerManager.js is NOT modified — all pool/lock/recycle logic is intact.
// ---------------------------------------------------------------------------
const LANGUAGE_CONFIG = {
  java: {
    file:    'Main.java',
    compile: 'javac Main.java',
    run:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /opt/java/openjdk/bin/java Main',
  },
  python: {
    file:    'main.py',
    compile: '',
    run:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- python main.py',
  },
  javascript: {
    file:    'index.js',
    compile: '',
    run:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /usr/local/bin/node /workspace/index.js',
  },
  c: {
    file:    'main.c',
    compile: 'gcc main.c -o main',
    run:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main',
  },
  cpp: {
    file:    'main.cpp',
    compile: 'g++ main.cpp -o main main.cpp',
    run:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main',
  },
  go: {
    file:    'main.go',
    compile: 'go build -o main main.go',
    run:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main',
  },
};

function parseMemory(value) {
  if (!value) return undefined;
  if (typeof value === 'number') return value;
  const parsed = parseInt(value.replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(parsed) ? undefined : parsed * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// runSandbox — acquires a container, copies files, compiles (if needed),
// runs, cleans up, then releases the container back to the pool.
//
// Compile and run are now TWO separate execInContainer calls so that
// compile errors are captured in `compile_output` and runtime errors
// are captured in `stderr`, matching the Judge0 response schema.
// ---------------------------------------------------------------------------
async function runSandbox({ language, sourceCode, stdin }) {
  const lang = LANGUAGE_CONFIG[language];
  if (!lang) throw new Error(`Unsupported language: ${language}`);

  // await containerManager.ensurePool(language);

  const memoryBytes = parseMemory(config.sandbox.memory) || 512 * 1024 * 1024;
  const cpuCores    = parseFloat(config.sandbox.cpu || '0.5');

  const containerName = await containerManager.acquireContainer(language, {
    memory: memoryBytes,
    cpus:   cpuCores,
  });

  if (!containerName) throw new Error('no_available_container');

  const startTime    = Date.now();
  let shouldRecycle  = false;

  try {
    // ── Workspace setup ───────────────────────────────────────────────────
    console.time('cleanup-before');
    await containerManager.cleanupWorkspace(containerName);
    console.timeEnd('cleanup-before');

    console.time('copy-source');
    await containerManager.copyFilesToContainer(containerName, [{ name: lang.file, content: sourceCode }]);
    console.timeEnd('copy-source');

    console.time('copy-stdin');
    await containerManager.copyFilesToContainer(containerName, [{ name: 'input.txt', content: stdin || '' }]);
    console.timeEnd('copy-stdin');

    // ── Step 1: Compile (languages that require it) ───────────────────────
    if (lang.compile) {
      console.time('compile');
      try {
        await containerManager.execInContainer(containerName, lang.compile, {
          timeout: config.sandbox.timeoutMs,
        });
        console.timeEnd('compile');
      } catch (compileErr) {
        console.timeEnd('compile');
        // Compilation failed — capture error, clean up, return early.
        // The outer `finally` will still run and call releaseContainer().
        await containerManager.cleanupWorkspace(containerName).catch(() => {});
        shouldRecycle = await containerManager.incrementUsage(containerName);
        return {
          stdout:         compileErr.stdout  || null,
          stderr:         null,
          compile_output: compileErr.stderr  || compileErr.message || 'Compilation failed',
          message:        null,
          verdict:        'Compilation Error',
          timeMs:         Date.now() - startTime,
          memory:         0,
        };
      }
    }

    // ── Step 2: Run ───────────────────────────────────────────────────────
    console.time('run');
    const execRes = await containerManager.execInContainer(
      containerName,
      `${lang.run} < input.txt`,
      { timeout: config.sandbox.timeoutMs }
    );
    console.timeEnd('run');

    console.time('cleanup-after');
    await containerManager.cleanupWorkspace(containerName);
    console.timeEnd('cleanup-after');

    shouldRecycle = await containerManager.incrementUsage(containerName);

    return {
      stdout:         execRes.stdout || null,
      stderr:         execRes.stderr || null,
      compile_output: null,
      message:        null,
      verdict:        'Accepted',
      timeMs:         Date.now() - startTime,
      memory:         0,
    };

  } catch (err) {
    // Runtime error path
    await containerManager.cleanupWorkspace(containerName).catch(() => {});
    return {
      stdout:         err.stdout  || null,
      stderr:         err.stderr  || err.message || null,
      compile_output: null,
      message:        null,
      verdict:        err.message && err.message.includes('timeout')
                        ? 'Time Limit Exceeded'
                        : 'Runtime Error',
      timeMs:         Date.now() - startTime,
      memory:         0,
    };
  } finally {
    // Always release — whether compile failed, runtime errored, or succeeded.
    // containerManager.js is completely untouched.
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

module.exports = { runSandbox };
