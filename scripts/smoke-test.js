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
      SYSTEM_ACCESSTOKEN: "system-token",
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
      SYSTEM_ACCESSTOKEN: "system-token",
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

function makeFakeDiffPal(file, argvFile, options = {}) {
  const exitCode = options.exitCode ?? 0;
  const stdout = options.stdout ?? "";
  const stderr = options.stderr ?? "";
  writeExecutable(file, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "${argvFile}"
printf '%b' ${JSON.stringify(stdout)}
printf '%b' ${JSON.stringify(stderr)} >&2
exit ${exitCode}
`);
}

function makeFakeGit(file, argvFile, options = {}) {
  const fetchExit = options.fetchExit ?? 0;
  const fetchStderr = options.fetchStderr ?? "";
  const mergeBaseExit = options.mergeBaseExit ?? 0;
  const mergeBaseStdout = options.mergeBaseStdout ?? "merge-base-sha\n";
  const mergeBaseStderr = options.mergeBaseStderr ?? "";
  writeExecutable(file, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "${argvFile}"
case "$1" in
  fetch)
    printf '%b' ${JSON.stringify(fetchStderr)} >&2
    exit ${fetchExit}
    ;;
  merge-base)
    printf '%b' ${JSON.stringify(mergeBaseStderr)} >&2
    printf '%b' ${JSON.stringify(mergeBaseStdout)}
    exit ${mergeBaseExit}
    ;;
  *)
    echo "unexpected git command: $*" >&2
    exit 2
    ;;
esac
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

function testDefaultPinnedVersionIsUsedWhenInputIsUnset() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-default-version-"));
  const fakeBin = path.join(dir, "bin");
  const npmArgv = path.join(dir, "npm-argv");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const agentTemp = path.join(dir, "agent-temp");
  fs.mkdirSync(agentTemp, { recursive: true });
  makeFakeNpm(path.join(fakeBin, "npm"), npmArgv, diffpalArgv);

  runHandler("default pinned version", {
    AGENT_TEMPDIRECTORY: agentTemp,
    INPUT_INSTALL: "true",
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
  });

  assert(read(npmArgv).includes("@diffpal/diffpal@0.1.31"), "default install did not request the pinned DiffPal version");
  assert(read(diffpalArgv).includes("review\nado"), "default pinned version did not run diffpal review ado");
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

function testNonPrRunFailsWithoutExplicitRange() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-non-pr-"));
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  const result = runHandlerExpectFailure("non PR run", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_BASE: "",
    INPUT_HEAD: ""
  });

  assert(result.stdout.includes("requires an Azure pull request build"), "non-PR failure should explain PR validation requirement");
  assert(!fs.existsSync(diffpalArgv), "diffpal should not run outside PR context without explicit base/head");
}

function testMissingTokenFailsBeforeCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-missing-token-"));
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);

  const result = runHandlerExpectFailure("missing token", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    SYSTEM_ACCESSTOKEN: "",
    AZURE_DEVOPS_EXT_PAT: ""
  });

  assert(result.stdout.includes("SYSTEM_ACCESSTOKEN is required"), "missing token failure should explain OAuth setup");
  assert(!fs.existsSync(diffpalArgv), "diffpal should not run without Azure feedback token");
}

function testPrContextComputesMergeBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-pr-range-"));
  const fakeBin = path.join(dir, "bin");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const gitArgv = path.join(dir, "git-argv");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);
  makeFakeGit(path.join(fakeBin, "git"), gitArgv, { mergeBaseStdout: "merge-base-sha\n" });

  runHandler("PR merge-base", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_BASE: "",
    INPUT_HEAD: "",
    SYSTEM_PULLREQUEST_PULLREQUESTID: "123",
    SYSTEM_PULLREQUEST_SOURCEBRANCH: "refs/heads/feature",
    SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
    SYSTEM_PULLREQUEST_SOURCECOMMITID: "source-sha",
    SYSTEM_PULLREQUEST_TARGETCOMMITID: "target-sha",
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
  });

  const gitArgs = read(gitArgv);
  assert(gitArgs.includes("fetch\n--no-tags\norigin\n+refs/heads/main:refs/remotes/origin/main"), "target branch should be fetched before merge-base");
  assert(gitArgs.includes("merge-base\norigin/main\nsource-sha"), "merge-base should use fetched target and source commit");
  assert(read(diffpalArgv).includes("--base\nmerge-base-sha\n--head\nsource-sha"), "diffpal should use merge-base and source commit");
}

function testExplicitRangeBypassesGitResolution() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-explicit-range-"));
  const fakeBin = path.join(dir, "bin");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const gitArgv = path.join(dir, "git-argv");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);
  makeFakeGit(path.join(fakeBin, "git"), gitArgv);

  runHandler("explicit range", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
  });

  assert(!fs.existsSync(gitArgv), "explicit base/head should not run git resolution");
  assert(read(diffpalArgv).includes("--base\nbase-sha\n--head\nhead-sha"), "explicit base/head should be forwarded");
}

function testMissingTargetRefExplainsFetchFailure() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-fetch-fail-"));
  const fakeBin = path.join(dir, "bin");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);
  makeFakeGit(path.join(fakeBin, "git"), path.join(dir, "git-argv"), {
    fetchExit: 128,
    fetchStderr: "fatal: couldn't find remote ref refs/heads/main\n"
  });

  const result = runHandlerExpectFailure("fetch target failure", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_BASE: "",
    INPUT_HEAD: "",
    SYSTEM_PULLREQUEST_PULLREQUESTID: "123",
    SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
    SYSTEM_PULLREQUEST_SOURCECOMMITID: "source-sha",
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
  });

  assert(result.stdout.includes("Unable to fetch Azure PR target ref refs/heads/main"), "fetch failure should name target ref");
  assert(result.stdout.includes("fetchDepth: 0"), "fetch failure should mention checkout depth guidance");
  assert(!fs.existsSync(diffpalArgv), "diffpal should not run after target fetch failure");
}

function testExplainPrintsResolvedContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-explain-"));
  const fakeBin = path.join(dir, "bin");
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv);
  makeFakeGit(path.join(fakeBin, "git"), path.join(dir, "git-argv"), { mergeBaseStdout: "merge-base-sha\n" });

  const result = spawnSync(process.execPath, [handler], {
    cwd: root,
    env: {
      ...process.env,
      INPUT_INSTALL: "false",
      INPUT_DIFFPALPATH: customDiffPal,
      INPUT_BASE: "",
      INPUT_HEAD: "",
      INPUT_BLOCKON: "high",
      INPUT_FEEDBACK: "balanced",
      INPUT_EXPLAIN: "true",
      SYSTEM_ACCESSTOKEN: "secret-token-value",
      SYSTEM_PULLREQUEST_PULLREQUESTID: "123",
      SYSTEM_PULLREQUEST_SOURCEBRANCH: "refs/heads/feature",
      SYSTEM_PULLREQUEST_TARGETBRANCH: "refs/heads/main",
      SYSTEM_PULLREQUEST_SOURCECOMMITID: "source-sha",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
    },
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`explain failed with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  assert(result.stdout.includes("DiffPal Azure task explain:"), "explain output should be printed");
  assert(result.stdout.includes("PR id: 123"), "explain output should include PR id");
  assert(result.stdout.includes("merge-base: merge-base-sha"), "explain output should include merge-base");
  assert(result.stdout.includes("final CLI args:"), "explain output should include CLI args");
  assert(!result.stdout.includes("secret-token-value"), "explain output should redact secrets");
}

function testGateFailureUsesHumanMessageForReviewBlockedExitCode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-gate-blocked-"));
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv, {
    exitCode: 10,
    stderr: "review blocked: blocking findings detected: 2\n"
  });

  const result = runHandlerExpectFailure("gate blocked exit code", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_GATE: "true"
  });

  assert(result.status === 10, `gate blocked exit code should be preserved, got ${result.status}`);
  assert(result.stdout.includes("DiffPal code review found blocking issues at or above the high threshold."), "gate failure should be human-readable");
  assert(!result.stdout.includes("diffpal exited with code 10"), "gate failure should not fall back to the generic exit code message");
}

function testTransientStructuredOutputFailureUsesHumanMessage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-transient-structured-"));
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv, {
    exitCode: 3,
    stderr: [
      "diffpal: transient: validate structured output: structured output schema validation error\n",
      "structured I/O schema validation error\n",
      "extract output JSON: output is empty\n"
    ].join("")
  });

  const result = runHandlerExpectFailure("transient structured output failure", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_GATE: "true"
  });

  assert(result.status === 3, `transient failure exit code should be preserved, got ${result.status}`);
  assert(result.stdout.includes("DiffPal review could not complete because the provider returned an empty or invalid structured response after retries."), "transient structured output failure should be human-readable");
  assert(!result.stdout.includes("diffpal exited with code 3"), "transient structured output failure should not use the generic exit code message");
}

function testNonGateFailureStaysGeneric() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffpal-ado-generic-failure-"));
  const diffpalArgv = path.join(dir, "diffpal-argv");
  const customDiffPal = path.join(dir, "diffpal");
  makeFakeDiffPal(customDiffPal, diffpalArgv, {
    exitCode: 4,
    stderr: "platform publish failed\n"
  });

  const result = runHandlerExpectFailure("generic failure", {
    INPUT_INSTALL: "false",
    INPUT_DIFFPALPATH: customDiffPal,
    INPUT_GATE: "true"
  });

  assert(result.status === 4, `generic failure exit code should be preserved, got ${result.status}`);
  assert(result.stdout.includes("diffpal exited with code 4"), "non-gate failure should keep the generic task message");
}

testDefaultInstall();
testDefaultPinnedVersionIsUsedWhenInputIsUnset();
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
testNonPrRunFailsWithoutExplicitRange();
testMissingTokenFailsBeforeCli();
testPrContextComputesMergeBase();
testExplicitRangeBypassesGitResolution();
testMissingTargetRefExplainsFetchFailure();
testExplainPrintsResolvedContext();
testGateFailureUsesHumanMessageForReviewBlockedExitCode();
testTransientStructuredOutputFailureUsesHumanMessage();
testNonGateFailureStaysGeneric();
console.log("Azure DevOps task smoke tests passed");
