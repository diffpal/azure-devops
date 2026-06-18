const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const handler = path.join(root, "dist", "index.js");

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runHandler(name, env) {
  const result = spawnSync(process.execPath, [handler], {
    cwd: root,
    env: {
      ...process.env,
      INPUT_BASE: "base-sha",
      INPUT_HEAD: "head-sha",
      INPUT_BLOCKON: "high",
      INPUT_FEEDBACK: "balanced",
      ...env
    },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${name} failed with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (result.stdout.includes("result=Failed") || result.stdout.includes("type=error")) {
    throw new Error(`${name} reported Azure task failure\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function runHandlerExpectFailure(name, env) {
  const result = spawnSync(process.execPath, [handler], {
    cwd: root,
    env: {
      ...process.env,
      INPUT_BASE: "base-sha",
      INPUT_HEAD: "head-sha",
      INPUT_BLOCKON: "high",
      INPUT_FEEDBACK: "balanced",
      ...env
    },
    encoding: "utf8"
  });
  if (result.status === 0) {
    throw new Error(`${name} unexpectedly succeeded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function makeFakeDiffPal(file, argvFile) {
  writeExecutable(file, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "${argvFile}"
`);
}

function makeFakeNpm(file, npmArgvFile, diffpalArgvFile) {
  writeExecutable(file, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(npmArgvFile)}, args.join("\\n"));
const prefixIndex = args.indexOf("--prefix");
if (prefixIndex === -1 || !args[prefixIndex + 1]) {
  process.exit(2);
}
const root = args[prefixIndex + 1];
const bin = path.join(root, "bin", "diffpal");
fs.mkdirSync(path.dirname(bin), { recursive: true });
fs.writeFileSync(bin, '#!/usr/bin/env bash\\nset -euo pipefail\\nprintf "%s\\\\n" "$@" > ${JSON.stringify(diffpalArgvFile)}\\n', { mode: 0o755 });
`);
}

function testDefaultInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-install-"));
  const fakeBin = path.join(dir, "bin");
  const npmArgv = path.join(dir, "npm-argv");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const agentTemp = path.join(dir, "agent-temp");
  fs.mkdirSync(agentTemp, { recursive: true });
  makeFakeNpm(path.join(fakeBin, "npm"), npmArgv, diffpalArgv);

  runHandler("default install", {
    AGENT_TEMPDIRECTORY: agentTemp,
    INPUT_INSTALL: "true",
    INPUT_DIFFPALVERSION: "0.1.2",
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
  });

  assert(read(npmArgv).includes("@diffpal/diffpal@0.1.2"), "default install did not request the configured package version");
  assert(read(diffpalArgv).includes("review\nado"), "default install did not run diffpal review ado");
}

function testCustomPathSkipsInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-custom-"));
  const fakeBin = path.join(dir, "bin");
  const npmArgv = path.join(dir, "npm-argv");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const agentTemp = path.join(dir, "agent-temp");
  fs.mkdirSync(agentTemp, { recursive: true });
  makeFakeNpm(path.join(fakeBin, "npm"), npmArgv, diffpalArgv);
  const customDiffPal = path.join(dir, "custom-diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  runHandler("custom path", {
    INPUT_INSTALL: "true",
    INPUT_DIFFPALPATH: customDiffPal,
    AGENT_TEMPDIRECTORY: agentTemp,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
  });

  assert(!fs.existsSync(npmArgv), "custom diffpalPath should skip npm install");
  assert(read(diffpalArgv).includes("review\nado"), "custom path did not run diffpal review ado");
}

function testInstallDisabledUsesPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-path-"));
  const fakeBin = path.join(dir, "bin");
  const npmArgv = path.join(dir, "npm-argv");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const agentTemp = path.join(dir, "agent-temp");
  fs.mkdirSync(agentTemp, { recursive: true });
  makeFakeNpm(path.join(fakeBin, "npm"), npmArgv, diffpalArgv);
  makeFakeDiffPal(path.join(fakeBin, "diffpal"), diffpalArgv);

  runHandler("install disabled", {
    INPUT_INSTALL: "false",
    AGENT_TEMPDIRECTORY: agentTemp,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
  });

  assert(!fs.existsSync(npmArgv), "install=false should skip npm install");
  assert(read(diffpalArgv).includes("review\nado"), "install=false did not run diffpal from PATH");
}

function testDefaultInstructionsFileDirectoryIsIgnored() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-instructions-default-"));
  const sourceDir = path.join(dir, "s");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  fs.mkdirSync(sourceDir, { recursive: true });
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  runHandler("default instructionsFile directory", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_INSTRUCTIONSFILE: sourceDir,
    BUILD_SOURCESDIRECTORY: sourceDir
  });

  assert(!read(diffpalArgv).includes("--instructions-file"), "default instructionsFile workspace directory should be ignored");
}

function testInstructionsFileIsForwarded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-instructions-file-"));
  const sourceDir = path.join(dir, "s");
  const instructionsFile = path.join(sourceDir, "instructions.md");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(instructionsFile, "review carefully\n");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  runHandler("instructionsFile file", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_INSTRUCTIONSFILE: instructionsFile,
    BUILD_SOURCESDIRECTORY: sourceDir
  });

  assert(read(diffpalArgv).includes(`--instructions-file\n${instructionsFile}`), "instructionsFile file should be forwarded");
}

function testInstructionsFileDirectoryFails() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-instructions-dir-"));
  const sourceDir = path.join(dir, "s");
  const instructionsDir = path.join(sourceDir, "docs");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  fs.mkdirSync(instructionsDir, { recursive: true });
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  const result = runHandlerExpectFailure("instructionsFile directory", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_INSTRUCTIONSFILE: instructionsDir,
    BUILD_SOURCESDIRECTORY: sourceDir
  });

  assert(result.stdout.includes("instructionsFile must point to a file, not a directory"), "directory failure should explain instructionsFile validation");
  assert(!fs.existsSync(diffpalArgv), "diffpal should not run when instructionsFile is a directory");
}

function testDefaultOutDirectoryIsIgnored() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-out-default-"));
  const sourceDir = path.join(dir, "s");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  fs.mkdirSync(sourceDir, { recursive: true });
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  runHandler("default out directory", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_OUT: sourceDir,
    BUILD_SOURCESDIRECTORY: sourceDir
  });

  assert(!read(diffpalArgv).includes("--out"), "default out workspace directory should be ignored");
}

function testOutFilePathIsForwarded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-out-file-"));
  const sourceDir = path.join(dir, "s");
  const outFile = path.join(sourceDir, ".artifacts", "diffpal", "review.json");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  runHandler("out file", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_OUT: outFile,
    BUILD_SOURCESDIRECTORY: sourceDir
  });

  assert(read(diffpalArgv).includes(`--out\n${outFile}`), "out file path should be forwarded");
}

function testOutDirectoryFails() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-out-dir-"));
  const sourceDir = path.join(dir, "s");
  const outDir = path.join(sourceDir, ".artifacts");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  fs.mkdirSync(outDir, { recursive: true });
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  const result = runHandlerExpectFailure("out directory", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_OUT: outDir,
    BUILD_SOURCESDIRECTORY: sourceDir
  });

  assert(result.stdout.includes("out must point to a file path, not a directory"), "directory failure should explain out validation");
  assert(!fs.existsSync(diffpalArgv), "diffpal should not run when out is a directory");
}

function testDefaultConfigDirDirectoryIsIgnored() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-config-default-"));
  const sourceDir = path.join(dir, "s");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  fs.mkdirSync(sourceDir, { recursive: true });
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  runHandler("default configDir directory", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_CONFIGDIR: sourceDir,
    BUILD_SOURCESDIRECTORY: sourceDir
  });

  assert(!read(diffpalArgv).includes("--config-dir"), "default configDir workspace directory should be ignored");
}

function testConfigDirDirectoryIsForwarded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-config-dir-"));
  const sourceDir = path.join(dir, "s");
  const configDir = path.join(sourceDir, ".config", "diffpal");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  fs.mkdirSync(configDir, { recursive: true });
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  runHandler("configDir directory", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_CONFIGDIR: configDir,
    BUILD_SOURCESDIRECTORY: sourceDir
  });

  assert(read(diffpalArgv).includes(`--config-dir\n${configDir}`), "configDir directory should be forwarded");
}

testDefaultInstall();
testCustomPathSkipsInstall();
testInstallDisabledUsesPath();
testDefaultInstructionsFileDirectoryIsIgnored();
testInstructionsFileIsForwarded();
testInstructionsFileDirectoryFails();
testDefaultOutDirectoryIsIgnored();
testOutFilePathIsForwarded();
testOutDirectoryFails();
testDefaultConfigDirDirectoryIsIgnored();
testConfigDirDirectoryIsForwarded();
console.log("Azure DevOps task smoke tests passed");
