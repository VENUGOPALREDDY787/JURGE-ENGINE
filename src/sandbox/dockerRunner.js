const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const config = require('../config');
const containerManager = require('./containerManager');

const LANGUAGE_CONFIG = {
  java: { image: 'judge-java-nsjail', file: 'Main.java', compile: 'javac Main.java', run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /opt/java/openjdk/bin/java Main' },
  python: { image: 'judge-python-nsjail', file: 'main.py', compile: '', run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- python main.py' },
  javascript: { image: 'judge-node-nsjail', file: 'index.js', compile: '', run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /usr/local/bin/node /workspace/index.js' },
  c: { image: 'judge-c-nsjail', file: 'main.c', compile: 'gcc main.c -o main', run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main' },
  cpp: { image: 'judge-cpp-nsjail', file: 'main.cpp', compile: 'g++ main.cpp -o main', run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main' },
  go: { image: 'judge-go-nsjail', file: 'main.go', compile: 'go build -o main main.go', run: '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main' }
};

async function runSandbox({ language, sourceCode, stdin }) {
  const lang = LANGUAGE_CONFIG[language];
  if (!lang) throw new Error(`Unsupported language: ${language}`);

  // Ensure reusable container exists
const memoryBytes =
  parseInt(config.sandbox.memory || "256") *
  1024 *
  1024;
console.time('1.ensureContainer');
const meta = await containerManager.ensureContainer(
  language,
  lang.image,
  {
    memory: memoryBytes,
    cpus: parseFloat(config.sandbox.cpu || "0.5")
  }
);
console.timeEnd('1.ensureContainer');
  // Prepare workspace files and copy into container
console.time('2.cleanup-before');
  const files = [{ name: lang.file, content: sourceCode }];
  await containerManager.cleanupWorkspace(
  language
);
console.timeEnd('2.cleanup-before');
console.time('3.copy-source');
  await containerManager.copyFilesToContainer(language, files);
console.timeEnd('3.copy-source');
console.time('4.copy-stdin');
await containerManager.copyFilesToContainer(
  language,
  [{ name: 'input.txt', content: stdin || '' }]
);
console.timeEnd('4.copy-stdin');
  // Build command
const inner = lang.compile? `${lang.compile} && ${lang.run} < input.txt` : `${lang.run} < input.txt`;
  // write stdin to input.txt inside container
  await containerManager.copyFilesToContainer(language, [{ name: 'input.txt', content: stdin || '' }]);

  const startTime = Date.now();
  try {
    console.time('5.compile-run');
    const execRes = await containerManager.execInContainer(language, inner, { timeout: config.sandbox.timeoutMs });
    console.timeEnd('5.compile-run');
    console.time('6.cleanup-after');
    await containerManager.cleanupWorkspace(language);
    console.timeEnd('6.cleanup-after');
    await containerManager.incrementUsage(language);

    const stdout = execRes.stdout || '';
    const stderr = execRes.stderr || '';

    // read compile.err and runtime.err if needed
    // For simplicity, return captured stdout/stderr
    const executionTime = Date.now() - startTime;
    return { stdout, stderr, compileOutput: '', verdict: 'Accepted', timeMs: executionTime, memory: 0 };
  } catch (err) {
     await containerManager.cleanupWorkspace(language);
    const executionTime = Date.now() - startTime;
    let verdict = 'Runtime Error';
    if (err.message && err.message.includes('timeout')) verdict = 'Time Limit Exceeded';
    return { stdout: err.stdout || '', stderr: err.stderr || err.message || '', compileOutput: '', verdict, timeMs: executionTime, memory: 0 };
  }
}



module.exports = { runSandbox };

