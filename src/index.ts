import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tl from "azure-pipelines-task-lib/task";

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type PullRequestContext = {
  id: string;
  sourceBranch: string;
  targetBranch: string;
  sourceCommit: string;
  targetCommit: string;
};

type ReviewRange = {
  base: string;
  head: string;
  mergeBase: string;
  targetRef: string;
  pullRequest: PullRequestContext;
};

const DEFAULT_DIFFPAL_VERSION = "0.1.32";
const TRANSIENT_REVIEW_EXIT_CODE = 3;
const REVIEW_BLOCKED_EXIT_CODE = 10;

function input(name: string): string {
  return (tl.getInput(name, false) ?? "").trim();
}

function requireValue(name: string, value: string): string {
  if (!value) {
    throw new Error(`Required value is empty: ${name}`);
  }
  return value;
}

function firstEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function isProbablySecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.includes("TOKEN") || upper.includes("SECRET") || upper.includes("PASSWORD") || upper.includes("KEY");
}

function redact(value: string): string {
  if (!value) {
    return value;
  }

  let redacted = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 4 || !isProbablySecretName(name)) {
      continue;
    }
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}

function hydrateSystemAccessToken(): void {
  if (process.env.SYSTEM_ACCESSTOKEN) {
    return;
  }
  const token = tl.getVariable("System.AccessToken");
  if (token) {
    process.env.SYSTEM_ACCESSTOKEN = token;
  }
}

function addOptional(args: string[], flag: string, value: string): void {
  if (value) {
    args.push(flag, value);
  }
}

function pathKind(filePath: string): string {
  const stat = fs.statSync(filePath);
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  return "non-file path";
}

function suppliedPathInput(name: string, value: string): string {
  if (!value) {
    return "";
  }

  if (!tl.filePathSupplied(name)) {
    tl.debug(`Ignoring default ${name} path: ${value}`);
    return "";
  }

  return value;
}

function resolveConfigDir(value: string): string {
  const supplied = suppliedPathInput("configDir", value);
  if (!supplied) {
    return "";
  }

  const resolved = path.resolve(supplied);
  if (!fs.existsSync(resolved)) {
    throw new Error(`configDir must point to an existing directory: ${supplied}`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`configDir must point to a directory, not a ${pathKind(resolved)}: ${supplied}`);
  }

  return supplied;
}

function resolveInstructionsFile(value: string): string {
  const supplied = suppliedPathInput("instructionsFile", value);
  if (!supplied) {
    return "";
  }

  const resolved = path.resolve(supplied);
  if (!fs.existsSync(resolved)) {
    throw new Error(`instructionsFile must point to an existing file: ${supplied}`);
  }

  if (fs.statSync(resolved).isFile()) {
    return supplied;
  }

  throw new Error(`instructionsFile must point to a file, not a ${pathKind(resolved)}: ${supplied}`);
}

function resolveOut(value: string): string {
  const supplied = suppliedPathInput("out", value);
  if (!supplied) {
    return "";
  }

  const resolved = path.resolve(supplied);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    throw new Error(`out must point to a file path, not a directory: ${supplied}`);
  }

  return supplied;
}

function normalizeTargetRef(targetBranch: string, targetCommit: string): string {
  if (targetBranch.startsWith("refs/heads/")) {
    return `origin/${targetBranch.slice("refs/heads/".length)}`;
  }
  if (targetBranch.startsWith("refs/remotes/")) {
    return targetBranch.slice("refs/remotes/".length);
  }
  if (targetBranch) {
    return targetBranch.startsWith("origin/") ? targetBranch : `origin/${targetBranch}`;
  }
  return targetCommit;
}

function targetFetchRef(targetBranch: string): string {
  if (targetBranch.startsWith("refs/heads/")) {
    const branch = targetBranch.slice("refs/heads/".length);
    return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  }
  if (targetBranch.startsWith("origin/")) {
    const branch = targetBranch.slice("origin/".length);
    return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  }
  if (targetBranch && !targetBranch.startsWith("refs/")) {
    return `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`;
  }
  return targetBranch;
}

function boolInput(name: string, defaultValue: boolean): boolean {
  const value = input(name).toLowerCase();
  if (!value) {
    return defaultValue;
  }
  return ["1", "true", "yes", "y", "on"].includes(value);
}

function resolvePullRequestContext(): PullRequestContext {
  const ctx = {
    id: firstEnv([
      "SYSTEM_PULLREQUEST_PULLREQUESTID",
      "SYSTEM_PULLREQUEST_PULLREQUESTNUMBER"
    ]),
    sourceBranch: firstEnv(["SYSTEM_PULLREQUEST_SOURCEBRANCH"]),
    targetBranch: firstEnv(["SYSTEM_PULLREQUEST_TARGETBRANCH"]),
    sourceCommit: firstEnv([
      "SYSTEM_PULLREQUEST_SOURCECOMMITID",
      "BUILD_SOURCEVERSION"
    ]),
    targetCommit: firstEnv(["SYSTEM_PULLREQUEST_TARGETCOMMITID"])
  };

  if (!ctx.id || !ctx.sourceCommit || (!ctx.targetBranch && !ctx.targetCommit)) {
    throw new Error("DiffPalReview@1 requires an Azure pull request build. Configure this pipeline as PR validation or a branch policy.");
  }
  return ctx;
}

function validateAuth(): void {
  if (firstEnv(["SYSTEM_ACCESSTOKEN", "AZURE_DEVOPS_EXT_PAT"])) {
    return;
  }
  throw new Error("SYSTEM_ACCESSTOKEN is required for Azure PR feedback. Enable 'Allow scripts to access the OAuth token' and pass SYSTEM_ACCESSTOKEN: $(System.AccessToken), or set AZURE_DEVOPS_EXT_PAT.");
}

function spawnCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: false,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function spawnCommandWithCapture(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? 1,
      stdout,
      stderr
    }));
  });
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? 1,
      stdout,
      stderr
    }));
  });
}

function isReviewBlockedFailure(code: number): boolean {
  return code === REVIEW_BLOCKED_EXIT_CODE;
}

function isTransientReviewFailure(code: number): boolean {
  return code === TRANSIENT_REVIEW_EXIT_CODE;
}

function hasStructuredOutputFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes("structured output") ||
    normalized.includes("output is empty") ||
    normalized.includes("no json object");
}

function diffPalFailureMessage(result: CommandResult, gate: boolean, blockOn: string): string {
  if (gate && isReviewBlockedFailure(result.code)) {
    return `DiffPal code review found blocking issues at or above the ${blockOn} threshold.`;
  }
  if (isTransientReviewFailure(result.code)) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (hasStructuredOutputFailure(output)) {
      return "DiffPal review could not complete because the provider returned an empty or invalid structured response after retries. Rerun the pipeline or check provider availability, auth, and quota.";
    }
    return "DiffPal review could not complete because the provider failed transiently after retries. Rerun the pipeline or check provider availability, auth, and quota.";
  }
  return `diffpal exited with code ${result.code}`;
}

async function fetchTargetBranch(targetBranch: string): Promise<void> {
  if (!targetBranch) {
    return;
  }

  const fetchRef = targetFetchRef(targetBranch);
  if (!fetchRef) {
    return;
  }

  const git = tl.which("git", true);
  const result = await runCommand(git, ["fetch", "--no-tags", "origin", fetchRef]);
  if (result.code !== 0) {
    throw new Error(`Unable to fetch Azure PR target ref ${targetBranch}. Ensure checkout uses fetchDepth: 0 or that the target branch is fetchable. git fetch stderr: ${redact(result.stderr.trim())}`);
  }
}

async function computeMergeBase(targetRef: string, head: string): Promise<string> {
  const git = tl.which("git", true);
  const result = await runCommand(git, ["merge-base", targetRef, head]);
  if (result.code !== 0) {
    throw new Error(`Unable to compute PR merge-base for target ${targetRef} and head ${head}. Ensure checkout uses fetchDepth: 0 and the target ref was fetched. git merge-base stderr: ${redact(result.stderr.trim())}`);
  }
  const mergeBase = result.stdout.trim();
  if (!mergeBase) {
    throw new Error(`git merge-base returned an empty result for target ${targetRef} and head ${head}. Ensure checkout uses fetchDepth: 0.`);
  }
  return mergeBase;
}

async function resolveReviewRange(inputBase: string, inputHead: string): Promise<ReviewRange> {
  const explicitBase = inputBase.trim();
  const explicitHead = inputHead.trim();
  if (explicitBase && explicitHead) {
    return {
      base: explicitBase,
      head: explicitHead,
      mergeBase: explicitBase,
      targetRef: "",
      pullRequest: {
        id: "",
        sourceBranch: "",
        targetBranch: "",
        sourceCommit: "",
        targetCommit: ""
      }
    };
  }

  const pullRequest = resolvePullRequestContext();
  const head = explicitHead || pullRequest.sourceCommit;
  const targetRef = normalizeTargetRef(pullRequest.targetBranch, pullRequest.targetCommit);
  if (!targetRef) {
    throw new Error("Azure PR target branch or target commit was not available. Ensure this task runs in PR validation.");
  }

  await fetchTargetBranch(pullRequest.targetBranch);
  const mergeBase = await computeMergeBase(targetRef, head);
  return {
    base: explicitBase || mergeBase,
    head,
    mergeBase,
    targetRef,
    pullRequest
  };
}

function printExplain(range: ReviewRange, args: string[]): void {
  const lines = [
    "DiffPal Azure task explain:",
    `  PR id: ${range.pullRequest.id}`,
    `  source branch: ${range.pullRequest.sourceBranch || "(unknown)"}`,
    `  target branch: ${range.pullRequest.targetBranch || "(unknown)"}`,
    `  source commit: ${range.pullRequest.sourceCommit || "(unknown)"}`,
    `  target commit: ${range.pullRequest.targetCommit || "(unknown)"}`,
    `  target ref: ${range.targetRef || "(explicit base/head)"}`,
    `  merge-base: ${range.mergeBase}`,
    `  final base: ${range.base}`,
    `  final head: ${range.head}`,
    `  final CLI args: ${redact(args.join(" "))}`
  ];
  for (const line of lines) {
    console.log(line);
  }
}

async function installDiffPal(version: string): Promise<string> {
  const npm = tl.which("npm", true);
  const tempDir = tl.getVariable("Agent.TempDirectory") || process.env.AGENT_TEMPDIRECTORY || process.env.RUNNER_TEMP || process.cwd();
  const installRoot = path.join(tempDir, "diffpal-task");
  fs.mkdirSync(installRoot, { recursive: true });

  const packageSpec = `@diffpal/diffpal@${version || DEFAULT_DIFFPAL_VERSION}`;
  tl.debug(`Installing ${packageSpec} into ${installRoot}`);
  const code = await spawnCommand(npm, [
    "install",
    "--global",
    "--prefix",
    installRoot,
    packageSpec,
    "--omit=dev",
    "--no-audit",
    "--no-fund"
  ]);
  if (code !== 0) {
    throw new Error(`npm install ${packageSpec} exited with code ${code}`);
  }

  const candidates = process.platform === "win32"
    ? [
        path.join(installRoot, "diffpal.cmd"),
        path.join(installRoot, "diffpal"),
        path.join(installRoot, "bin", "diffpal.cmd")
      ]
    : [
        path.join(installRoot, "bin", "diffpal"),
        path.join(installRoot, "diffpal")
      ];

  const diffpal = candidates.find((candidate) => fs.existsSync(candidate));
  if (!diffpal) {
    throw new Error(`installed diffpal binary was not found in ${installRoot}`);
  }
  tl.debug(`Installed DiffPal binary: ${diffpal}`);
  return diffpal;
}

async function resolveDiffPalCommand(): Promise<string> {
  const diffpalPath = input("diffpalPath") || "diffpal";
  if (diffpalPath !== "diffpal") {
    return tl.which(diffpalPath, true);
  }
  if (!boolInput("install", true)) {
    return tl.which(diffpalPath, true);
  }
  return installDiffPal(input("diffpalVersion") || DEFAULT_DIFFPAL_VERSION);
}

async function run(): Promise<void> {
  hydrateSystemAccessToken();
  validateAuth();

  const command = await resolveDiffPalCommand();
  const range = await resolveReviewRange(input("base"), input("head"));
  const base = requireValue("base", range.base);
  const head = requireValue("head", range.head);
  const blockOn = input("blockOn") || "high";
  const gate = tl.getBoolInput("gate", false);

  const args: string[] = [];
  addOptional(args, "--config-dir", resolveConfigDir(input("configDir")));
  addOptional(args, "--profile", input("profile"));
  args.push("review", "ado", "--base", base, "--head", head, "--block-on", blockOn);

  if (gate) {
    args.push("--gate");
  }
  const mode = input("mode");
  addOptional(args, "--mode", mode);
  if (!mode) {
    addOptional(args, "--feedback", input("feedback") || "balanced");
  }
  addOptional(args, "--language", input("language"));
  addOptional(args, "--instructions", input("instructions"));
  addOptional(args, "--instructions-file", resolveInstructionsFile(input("instructionsFile")));
  addOptional(args, "--out", resolveOut(input("out")));
  addOptional(args, "--repo", input("repo"));
  addOptional(args, "--review-id", input("reviewId"));

  if (boolInput("explain", false)) {
    printExplain(range, args);
  }

  tl.debug(`Running ${command} ${args.join(" ")}`);
  const result = await spawnCommandWithCapture(command, args);
  if (result.code !== 0) {
    process.exitCode = result.code;
    tl.setResult(tl.TaskResult.Failed, diffPalFailureMessage(result, gate, blockOn));
    return;
  }
  tl.setResult(tl.TaskResult.Succeeded, "DiffPal review completed");
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  tl.setResult(tl.TaskResult.Failed, message);
});
