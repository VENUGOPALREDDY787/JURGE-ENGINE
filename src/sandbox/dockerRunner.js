const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");

const execAsync = util.promisify(exec);

const config = require("../config");

const LANGUAGE_CONFIG = {
java: {
  image: "judge-java-nsjail",
  file: "Main.java",
  compile: "javac Main.java",
  run: "/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /opt/java/openjdk/bin/java Main",
},
  python: {
    image: "python:3.12",
    file: "main.py",
    compile: "",
    run: "python main.py",
  },

  javascript: {
    image: "judge-node-nsjail",
    file: "index.js",
    compile: "",
   run: "/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- /usr/local/bin/node /workspace/index.js"
  },

  c: {
    image: "gcc:12",
    file: "main.c",
    compile: "gcc main.c -o main",
    run: "./main",
  },

  cpp: {
  image: "judge-cpp-nsjail",
  file: "main.cpp",
  compile: "g++ main.cpp -o main",
  run: "/opt/nsjail/nsjail -Q --disable_clone_newns --cwd /workspace -- ./main",
},

  go: {
    image: "golang:1.22",
    file: "main.go",
    compile: "go build -o main main.go",
    run: "./main",
  },
};

async function runSandbox({ language, sourceCode ,stdin}) {
  const lang = LANGUAGE_CONFIG[language];

  if (!lang) {
    throw new Error(`Unsupported language: ${language}`);
  }

  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "exec-")
  );

const startTime = Date.now();

try {

  const sourceFile = path.join(tmpDir, lang.file);

  await fs.writeFile(
    sourceFile,
    sourceCode,
    "utf8"
  );

  let innerCommand = "";

  if (lang.compile) {
    innerCommand =
      `${lang.compile} && ${lang.run}`;
  } else {
    innerCommand = lang.run;
  }
const escapedInput = (stdin || "")
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n');
  const dockerCommand = [
    `echo "${escapedInput}" |`,
    "docker run --rm",
    "--privileged",
    `--memory=${config.sandbox.memory || "256m"}`,
    `--cpus=${config.sandbox.cpu || "0.5"}`,
    "--network none",
    `-v "${tmpDir}:/workspace"`,
    "-w /workspace",
    lang.image,
    `sh -c "${innerCommand}"`,
  ].join(" ");

  console.log("\n=== Docker Command ===");
  console.log("STDIN:", JSON.stringify(stdin));
  console.log(dockerCommand);
  console.log("======================\n");

  const { stdout, stderr } =
    await execAsync(dockerCommand, {
      timeout:
        (config.sandbox.timeoutMs || 5000) + 2000,
    });

  const executionTime = Date.now() - startTime;

  return {
    stdout,
    stderr,
    compileOutput: "",
    verdict: "Accepted",
    timeMs: executionTime,
    memory: 0,
  };

} catch (err) {
  const executionTime = Date.now() - startTime;

  let verdict = "Runtime Error";

  if (err.killed) {
    verdict = "Time Limit Exceeded";
    err.stdout = "";
    err.stderr = "Time Limit Exceeded";;
  }

  if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    verdict = "Output Limit Exceeded";
    err.stdout = "";
    err.stderr = "Output limit exceeded";
  }

  return {
    stdout: err.stdout || "",
    stderr: err.stderr || err.message,
    compileOutput: "",
    verdict,
    timeMs: executionTime,
    memory: 0,
  };
}
finally {

  try {
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
    });
  } catch (e) {}
}
}

module.exports = {
  runSandbox,
}

