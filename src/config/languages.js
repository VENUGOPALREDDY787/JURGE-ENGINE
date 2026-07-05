/**
 * languages.js — Single Source of Truth for Language Configuration
 *
 * Adding a new STATIC language requires only:
 *   1. Adding one entry to LANGUAGE_DEFINITIONS below.
 *   2. Building the corresponding Docker image.
 *
 * All other modules (config/index.js, dockerRunner.js, containerManager.js,
 * languageRegistry.js) derive their data from this file automatically.
 *
 * Dynamic languages (added via POST /admin/languages) are NOT listed here —
 * they are stored in MongoDB and loaded at runtime via registerLanguage().
 *
 * Shape of each entry:
 * {
 *   languageId:     string   — internal engine key (e.g. 'python')
 *   dockerImage:    string   — Docker image name for the container pool
 *   fileName:       string   — source file name written into /workspace
 *   compileCommand: string   — compile step; empty/null for interpreted langs
 *   runCommand:     string   — nsjail-wrapped command to execute the program
 * }
 */

const LANGUAGE_DEFINITIONS = [
  {
    languageId:     'java',
    dockerImage:    'judge-java-nsjail',
    fileName:       'Main.java',
    compileCommand: 'javac -J-XX:TieredStopAtLevel=1 -J-XX:+UseSerialGC Main.java',
    runCommand:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /opt/java/openjdk/bin/java -XX:TieredStopAtLevel=1 -Xshare:on -XX:+UseSerialGC -Xms8m -Xmx128m Main',
  },
  {
    languageId:     'python',
    dockerImage:    'judge-python-nsjail',
    fileName:       'main.py',
    compileCommand: '',
    runCommand:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- python main.py',
  },
  {
    languageId:     'javascript',
    dockerImage:    'judge-node-nsjail',
    fileName:       'index.js',
    compileCommand: '',
    runCommand:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /usr/local/bin/node /workspace/index.js',
  },
  {
    languageId:     'c',
    dockerImage:    'judge-c-nsjail',
    fileName:       'main.c',
    compileCommand: 'gcc main.c -o main',
    runCommand:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main',
  },
  {
    languageId:     'cpp',
    dockerImage:    'judge-cpp-nsjail',
    fileName:       'main.cpp',
    compileCommand: 'g++ main.cpp -o main',
    runCommand:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main',
  },
  {
    languageId:     'go',
    dockerImage:    'judge-go-nsjail',
    fileName:       'main.go',
    compileCommand: 'go build -o main main.go',
    runCommand:     '/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main',
  },
];

// ── Derived lookup maps (built once at startup) ───────────────────────────────

/**
 * Set of all supported language IDs.
 * e.g. Set { 'java', 'python', 'javascript', 'c', 'cpp', 'go' }
 */
const SUPPORTED_LANGUAGE_IDS = new Set(LANGUAGE_DEFINITIONS.map((l) => l.languageId));

/**
 * Map: languageId → { file, compile, run }
 * Used by dockerRunner.js for compile/run command lookup.
 * e.g. { java: { file: 'Main.java', compile: 'javac Main.java', run: '...' }, ... }
 */
const LANGUAGE_EXEC_CONFIG = {};

/**
 * Map: languageId → dockerImage
 * Used by containerManager.js for image-name lookup.
 * e.g. { java: 'judge-java-nsjail', python: 'judge-python-nsjail', ... }
 */
const LANGUAGE_IMAGE_MAP = {};

for (const lang of LANGUAGE_DEFINITIONS) {
  LANGUAGE_EXEC_CONFIG[lang.languageId] = {
    file:    lang.fileName,
    compile: lang.compileCommand,
    run:     lang.runCommand,
  };
  LANGUAGE_IMAGE_MAP[lang.languageId] = lang.dockerImage;
}

module.exports = {
  LANGUAGE_DEFINITIONS,
  SUPPORTED_LANGUAGE_IDS,
  LANGUAGE_EXEC_CONFIG,
  LANGUAGE_IMAGE_MAP,
};
