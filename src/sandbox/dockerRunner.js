const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");

const execAsync = util.promisify(exec);

const config = require("../config");

const LANGUAGE_CONFIG = {
java: {
  image: "eclipse-temurin:21",
    file: "Main.java",
    compile: "javac Main.java",
    run: "java Main",
  },

  python: {
    image: "python:3.12",
    file: "main.py",
    compile: "",
    run: "python main.py",
  },

  javascript: {
    image: "node:20",
    file: "index.js",
    compile: "",
    run: "node index.js",
  },

  c: {
    image: "gcc:12",
    file: "main.c",
    compile: "gcc main.c -o main",
    run: "./main",
  },

  cpp: {
    image: "gcc:12",
    file: "main.cpp",
    compile: "g++ main.cpp -o main",
    run: "./main",
  },

  go: {
    image: "golang:1.22",
    file: "main.go",
    compile: "go build -o main main.go",
    run: "./main",
  },
};

async function runSandbox({ language, sourceCode }) {
  const lang = LANGUAGE_CONFIG[language];

  if (!lang) {
    throw new Error(`Unsupported language: ${language}`);
  }

  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "exec-")
  );

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

    const dockerCommand = [
      "docker run --rm",
      `--memory=${config.sandbox.memory || "256m"}`,
      `--cpus=${config.sandbox.cpu || "0.5"}`,
      "--network none",
      `-v "${tmpDir}:/workspace"`,
      "-w /workspace",
      lang.image,
      `sh -c "${innerCommand}"`,
    ].join(" ");

    console.log("\n=== Docker Command ===");
    console.log(dockerCommand);
    console.log("======================\n");

    const { stdout, stderr } =
      await execAsync(dockerCommand, {
        timeout:
          (config.sandbox.timeoutMs || 5000) + 2000,
      });

    return {
      stdout,
      stderr,
      compileOutput: "",
      verdict:
        stderr && stderr.length > 0
          ? "Runtime Error"
          : "Accepted",
      timeMs: 0,
      memory: 0,
    };
  }catch (err) {
  return {
    stdout: err.stdout || "",
    stderr: err.stderr || err.message,
    compileOutput: "",
    verdict: "Runtime Error",
    timeMs: 0,
    memory: 0,
  };
} finally {
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
};