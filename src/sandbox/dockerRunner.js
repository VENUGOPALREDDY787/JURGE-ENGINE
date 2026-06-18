const config = require('../config');
const containerManager = require('./containerManager');

const LANGUAGE_CONFIG = {
  java: {
    file: 'Main.java',
    compile: 'javac Main.java',
    run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /opt/java/openjdk/bin/java Main'
  },
  python: {
    file: 'main.py',
    compile: '',
    run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- python main.py'
  },
  javascript: {
    file: 'index.js',
    compile: '',
    run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /usr/local/bin/node /workspace/index.js'
  },
  c: {
    file: 'main.c',
    compile: 'gcc main.c -o main',
    run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main'
  },
  cpp: {
    file: 'main.cpp',
    compile: 'g++ main.cpp -o main main.cpp',
    run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main'
  },
  go: {
    file: 'main.go',
    compile: 'go build -o main main.go',
    run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main'
  }
};

function parseMemory(value) {
  if (!value) return undefined;
  if (typeof value === 'number') return value;
  const parsed = parseInt(value.replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(parsed) ? undefined : parsed * 1024 * 1024;
}

async function runSandbox({ language, sourceCode, stdin }) {
  const lang = LANGUAGE_CONFIG[language];
  if (!lang) throw new Error(`Unsupported language: ${language}`);

  await containerManager.ensurePool(language);

  const memoryBytes = parseMemory(config.sandbox.memory) || 512 * 1024 * 1024;
  const cpuCores = parseFloat(config.sandbox.cpu || '0.5');

  const containerName = await containerManager.acquireContainer(language, {
    memory: memoryBytes,
    cpus: cpuCores
  });

  if (!containerName) {
    throw new Error('no_available_container');
  }

  const files = [{ name: lang.file, content: sourceCode }];
  const command = lang.compile ? `${lang.compile} && ${lang.run} < input.txt` : `${lang.run} < input.txt`;
  const startTime = Date.now();
  let shouldRecycle = false;

  try {
    console.time("cleanup-before");
    await containerManager.cleanupWorkspace(containerName);
    console.timeEnd("cleanup-before");
    console.time("copy-source");
    await containerManager.copyFilesToContainer(containerName, files);
    console.timeEnd("copy-source");
    console.time("copy-stdin");
    await containerManager.copyFilesToContainer(containerName, [{ name: 'input.txt', content: stdin || '' }]);
    console.timeEnd("copy-stdin");
    console.time("compile-run");
    const execRes = await containerManager.execInContainer(containerName, command, { timeout: config.sandbox.timeoutMs });
    console.timeEnd("compile-run");
    console.time("cleanup-after");
    await containerManager.cleanupWorkspace(containerName);
    console.timeEnd("cleanup-after");

    shouldRecycle = await containerManager.incrementUsage(containerName);

    return {
      stdout: execRes.stdout || '',
      stderr: execRes.stderr || '',
      compileOutput: '',
      verdict: 'Accepted',
      timeMs: Date.now() - startTime,
      memory: 0
    };
  } catch (err) {
    await containerManager.cleanupWorkspace(containerName).catch(() => {});
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      compileOutput: '',
      verdict: err.message && err.message.includes('timeout') ? 'Time Limit Exceeded' : 'Runtime Error',
      timeMs: Date.now() - startTime,
      memory: 0
    };
  } finally {
    if (containerName) {
      await containerManager.releaseContainer(containerName, {
        recycle: shouldRecycle,
        opts: {
          memory: memoryBytes,
          cpus: cpuCores
        }
      }).catch((releaseErr) => {
        console.error(`Failed to release container ${containerName}:`, releaseErr.message);
      });
    }
  }
}

module.exports = { runSandbox };
