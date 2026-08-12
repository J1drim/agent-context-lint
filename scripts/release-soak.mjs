#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseArtifactBundle } from "./release-artifacts.mjs";

const FORMAT = "agent-context-release-soak-rehearsal-v1";
const MAX_ITERATIONS = 32;
const DEFAULT_ITERATIONS = 3;
const MAX_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const MAX_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_FINDINGS_BYTES = 64 * 1024;
const MAX_CLI_BYTES = 128 * 1024 * 1024;
const MAX_TREE_FILES = 10_000;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const FINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// eslint-disable-next-line no-control-regex -- owner metadata rejects terminal controls.
const OWNER_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const SMOKE_CASES = Object.freeze([
  Object.freeze({ id: "help", arguments: ["--help"], output: "text" }),
  Object.freeze({ id: "list-json", arguments: ["list", ".", "--format", "json"], output: "json" }),
  Object.freeze({
    id: "scan-json",
    arguments: ["scan", ".", "--format", "json", "--fail-on", "never"],
    output: "json",
  }),
]);

const compareUtf8 = (left, right) =>
  Math.sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => [key, canonicalize(value[key])]),
    );
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(`release soak rehearsal: ${message}`);
}

function safeErrorCode(error) {
  if (error?.code === "ENOENT") return "not-found";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "permission-denied";
  if (error?.code === "EADDRINUSE") return "address-in-use";
  return "spawn-error";
}

function validateAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value))
    fail(`${label} must be an absolute path`);
  if (value.includes("\0")) fail(`${label} contains a NUL`);
  return value;
}

function parseBoundedInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/u.test(value))
    fail(`${label} must be a decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    fail(`${label} must be between ${minimum} and ${maximum}`);
  return parsed;
}

export function parseSoakArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "run") fail("usage: release-soak.mjs run [options]");
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!option.startsWith("--") || values.has(option)) fail("options are duplicated or malformed");
    if (value === undefined || value.startsWith("--")) fail(`${option} requires a value`);
    values.set(option, value);
    index += 1;
  }
  const known = new Set([
    "--candidate-bundle",
    "--previous-bundle",
    "--candidate-cli",
    "--previous-cli",
    "--workspace",
    "--output",
    "--findings",
    "--iterations",
    "--command-timeout-ms",
    "--total-timeout-ms",
  ]);
  for (const option of values.keys()) if (!known.has(option)) fail(`unknown option ${option}`);
  const required = (option, label = option) => {
    const value = values.get(option);
    if (value === undefined) fail(`${option} is required`);
    return validateAbsolutePath(value, label);
  };
  const findings = values.get("--findings");
  return Object.freeze({
    candidateBundle: required("--candidate-bundle", "candidate bundle"),
    previousBundle: required("--previous-bundle", "previous bundle"),
    candidateCli: required("--candidate-cli", "candidate CLI"),
    previousCli: required("--previous-cli", "previous CLI"),
    workspace: required("--workspace", "workspace"),
    output: required("--output", "report output"),
    findings: findings === undefined ? undefined : validateAbsolutePath(findings, "findings"),
    iterations: parseBoundedInteger(
      values.get("--iterations"),
      "--iterations",
      1,
      MAX_ITERATIONS,
      DEFAULT_ITERATIONS,
    ),
    commandTimeoutMs: parseBoundedInteger(
      values.get("--command-timeout-ms"),
      "--command-timeout-ms",
      1,
      MAX_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS,
    ),
    totalTimeoutMs: parseBoundedInteger(
      values.get("--total-timeout-ms"),
      "--total-timeout-ms",
      1,
      MAX_TOTAL_TIMEOUT_MS,
      DEFAULT_TOTAL_TIMEOUT_MS,
    ),
  });
}

async function inspectDirectory(directory, label) {
  const info = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink())
    fail(`${label} must be an existing regular directory`);
  return realpath(directory);
}

async function inspectFile(filename, label) {
  const info = await lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined || !info.isFile() || info.isSymbolicLink())
    fail(`${label} must be an existing regular non-symlink file`);
  if (info.size > BigInt(MAX_CLI_BYTES)) fail(`${label} exceeds ${MAX_CLI_BYTES} bytes`);
  return { filename, info, real: await realpath(filename) };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isOutputOutsideWorkspace(workspace, output) {
  return !isWithin(workspace, output) && !isWithin(output, workspace);
}

async function boundedFileDigest(filename, label, maximum = MAX_CLI_BYTES) {
  const info = await lstat(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} is not a regular file`);
  if (info.size > BigInt(maximum)) fail(`${label} exceeds ${maximum} bytes`);
  const bytes = await readFile(filename);
  const after = await lstat(filename, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    after.size !== info.size ||
    after.mtimeNs !== info.mtimeNs ||
    BigInt(bytes.byteLength) !== info.size
  )
    fail(`${label} changed while it was read`);
  return Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) });
}

async function digestBundle(directory) {
  const hash = createHash("sha256");
  let files = 0;
  let totalBytes = 0;
  async function visit(current, relativeDirectory) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      compareUtf8(left.name, right.name),
    );
    for (const entry of entries) {
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const filename = path.join(current, entry.name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) fail(`bundle contains a symbolic link: ${relative}`);
      if (info.isDirectory()) {
        await visit(filename, relative);
        continue;
      }
      if (!info.isFile()) fail(`bundle contains a non-regular entry: ${relative}`);
      files += 1;
      if (files > MAX_TREE_FILES) fail("bundle exceeds the file bound");
      const digest = await boundedFileDigest(filename, `bundle/${relative}`, MAX_CLI_BYTES);
      totalBytes += digest.bytes;
      if (totalBytes > MAX_TREE_BYTES) fail("bundle exceeds the aggregate byte bound");
      hash.update(relative);
      hash.update("\0");
      hash.update(digest.sha256);
      hash.update("\0");
    }
  }
  await visit(directory, "");
  return Object.freeze({ files, bytes: totalBytes, sha256: hash.digest("hex") });
}

async function snapshotWorkspace(directory) {
  const hash = createHash("sha256");
  let files = 0;
  let totalBytes = 0;
  async function visit(current, relativeDirectory) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      compareUtf8(left.name, right.name),
    );
    for (const entry of entries) {
      if (relativeDirectory === "" && entry.name === ".git") continue;
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const filename = path.join(current, entry.name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) fail(`workspace contains a symbolic link: ${relative}`);
      if (info.isDirectory()) {
        hash.update("directory\0");
        hash.update(relative);
        hash.update("\0");
        hash.update(String(info.mode & 0o777));
        hash.update("\0");
        await visit(filename, relative);
        continue;
      }
      if (!info.isFile()) fail(`workspace contains a non-regular entry: ${relative}`);
      files += 1;
      if (files > MAX_TREE_FILES) fail("workspace exceeds the file bound");
      const digest = await boundedFileDigest(filename, `workspace/${relative}`, MAX_CLI_BYTES);
      totalBytes += digest.bytes;
      if (totalBytes > MAX_TREE_BYTES) fail("workspace exceeds the aggregate byte bound");
      hash.update("file\0");
      hash.update(relative);
      hash.update("\0");
      hash.update(String(info.mode & 0o777));
      hash.update("\0");
      hash.update(digest.sha256);
      hash.update("\0");
    }
  }
  await visit(directory, "");
  return Object.freeze({ files, bytes: totalBytes, sha256: hash.digest("hex") });
}

function parseVersion(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (match === null) fail(`${label} has an invalid release version`);
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

function compareVersions(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] > right[field] ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const leftValue = left.prerelease[index];
    const rightValue = right.prerelease[index];
    if (leftValue === undefined) return -1;
    if (rightValue === undefined) return 1;
    if (leftValue === rightValue) continue;
    const leftNumeric = /^\d+$/u.test(leftValue);
    const rightNumeric = /^\d+$/u.test(rightValue);
    if (leftNumeric && rightNumeric) return Number(leftValue) > Number(rightValue) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return compareUtf8(leftValue, rightValue);
  }
  return 0;
}

async function loadFindings(filename) {
  if (filename === undefined) return [];
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) fail("findings must be a regular non-symlink file");
  if (info.size > BigInt(MAX_FINDINGS_BYTES)) fail("findings exceed the byte bound");
  let values;
  try {
    values = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    fail("findings are not valid JSON");
  }
  if (!Array.isArray(values) || values.length > 128)
    fail("findings must be an array of at most 128 records");
  const seen = new Set();
  return values.map((finding, index) => {
    if (finding === null || typeof finding !== "object" || Array.isArray(finding))
      fail(`finding ${index} is not an object`);
    const allowed = ["dueDate", "id", "owner", "rationale", "severity", "status"];
    if (Object.keys(finding).some((key) => !allowed.includes(key)))
      fail(`finding ${index} has unknown fields`);
    if (
      typeof finding.id !== "string" ||
      !FINDING_ID_PATTERN.test(finding.id) ||
      seen.has(finding.id)
    )
      fail(`finding ${index} has an invalid or duplicate id`);
    seen.add(finding.id);
    if (!["P0", "P1", "P2", "P3"].includes(finding.severity))
      fail(`finding ${index} has an invalid severity`);
    if (typeof finding.status !== "string" || !["open", "accepted"].includes(finding.status))
      fail(`finding ${index} has an invalid status`);
    if (typeof finding.owner !== "string" || !OWNER_PATTERN.test(finding.owner))
      fail(`finding ${index} has an invalid owner`);
    if (
      typeof finding.rationale !== "string" ||
      Buffer.byteLength(finding.rationale, "utf8") > MAX_TEXT_BYTES
    )
      fail(`finding ${index} has an invalid rationale`);
    if (typeof finding.dueDate !== "string" || !DATE_PATTERN.test(finding.dueDate))
      fail(`finding ${index} has an invalid dueDate`);
    if (finding.severity === "P0" || finding.severity === "P1") {
      if (finding.status !== "open") fail(`P0/P1 finding ${finding.id} cannot be accepted`);
    } else if (finding.status !== "accepted") {
      fail(`non-blocking finding ${finding.id} must be accepted`);
    }
    return Object.freeze({
      id: finding.id,
      severity: finding.severity,
      status: finding.status,
      owner: finding.owner,
      dueDate: finding.dueDate,
      rationaleSha256: sha256(Buffer.from(finding.rationale, "utf8")),
    });
  });
}

function denyCapabilitiesSource() {
  return `'use strict';
const blocked = () => { throw new Error('release soak denied network/process capability'); };
for (const name of ['node:net','node:tls','node:http','node:https','node:http2','node:dgram','node:dns','node:dns/promises']) {
  try {
    const module = require(name);
    for (const key of ['connect','createConnection','request','get','createServer','lookup','resolve','resolve4','resolve6','send']) {
      if (typeof module[key] === 'function') module[key] = blocked;
    }
  } catch {
    // A missing or immutable optional builtin is denied by the fixed environment as well.
  }
}
try {
  const childProcess = require('node:child_process');
  for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[key] = blocked;
} catch {
  // The preload remains fail-closed for environments without the optional builtin.
}
globalThis.fetch = blocked;
`;
}

function killChild(child) {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The child may already have exited between the existence check and the signal.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The fallback kill is best effort after process-group termination.
  }
}

function runSmokeCommand(cliPath, smokeCase, workspace, timeoutMs, environment) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...smokeCase.arguments], {
        cwd: workspace,
        detached: process.platform !== "win32",
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(
        Object.freeze({
          case: smokeCase.id,
          exitCode: null,
          signal: null,
          outputLimit: false,
          timedOut: false,
          invalidOutput: false,
          spawnError: safeErrorCode(error),
          stdoutBytes: 0,
          stdoutSha256: sha256(Buffer.alloc(0)),
          stderrBytes: 0,
          stderrSha256: sha256(Buffer.alloc(0)),
        }),
      );
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimit = false;
    let timedOut = false;
    let spawnError;
    const collect = (target, value, current) => {
      const bytes = Buffer.from(value);
      const next = current + bytes.byteLength;
      if (next > MAX_OUTPUT_BYTES) {
        outputLimit = true;
        killChild(child);
        return MAX_OUTPUT_BYTES;
      }
      target.push(bytes);
      return next;
    };
    child.stdout.on("data", (value) => {
      stdoutBytes = collect(stdout, value, stdoutBytes);
    });
    child.stderr.on("data", (value) => {
      stderrBytes = collect(stderr, value, stderrBytes);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      const stdoutBytesBuffer = Buffer.concat(stdout);
      const stderrBytesBuffer = Buffer.concat(stderr);
      const invalidOutput =
        !outputLimit &&
        !timedOut &&
        exitCode === 0 &&
        (smokeCase.output === "json"
          ? (() => {
              try {
                const text = stdoutBytesBuffer.toString("utf8");
                JSON.parse(text);
                return text.trim() === "";
              } catch {
                return true;
              }
            })()
          : stdoutBytesBuffer.byteLength === 0);
      resolve(
        Object.freeze({
          case: smokeCase.id,
          exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
          signal: signal === null ? null : String(signal).slice(0, 32),
          outputLimit,
          timedOut,
          invalidOutput,
          spawnError: spawnError === undefined ? null : safeErrorCode(spawnError),
          stdoutBytes,
          stdoutSha256: sha256(stdoutBytesBuffer),
          stderrBytes,
          stderrSha256: sha256(stderrBytesBuffer),
        }),
      );
    });
  });
}

function outcomeFailed(outcome) {
  return (
    outcome.outputLimit ||
    outcome.timedOut ||
    outcome.invalidOutput ||
    outcome.spawnError !== null ||
    outcome.signal !== null ||
    outcome.exitCode !== 0
  );
}

function failureId(phase, iteration, smokeCase, reason) {
  return `${phase}.${iteration}.${smokeCase}.${reason}`;
}

async function runPhase({
  phase,
  cliPath,
  workspace,
  iterations,
  commandTimeoutMs,
  deadlineNs,
  environment,
}) {
  const outcomes = [];
  const blockingFindings = [];
  let deadlineExceeded = false;
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const smokeCase of SMOKE_CASES) {
      const remainingNs = deadlineNs - process.hrtime.bigint();
      if (remainingNs <= 0n) {
        deadlineExceeded = true;
        const skipped = Object.freeze({
          case: smokeCase.id,
          exitCode: null,
          signal: null,
          outputLimit: false,
          timedOut: true,
          invalidOutput: false,
          spawnError: null,
          stdoutBytes: 0,
          stdoutSha256: sha256(Buffer.alloc(0)),
          stderrBytes: 0,
          stderrSha256: sha256(Buffer.alloc(0)),
          skipped: "total-deadline",
        });
        outcomes.push(Object.freeze({ iteration, ...skipped }));
        blockingFindings.push({
          id: failureId(phase, iteration, smokeCase.id, "total-deadline"),
          severity: "P1",
        });
        continue;
      }
      const remainingMs = Math.max(1, Math.floor(Number(remainingNs) / 1_000_000));
      const outcome = await runSmokeCommand(
        cliPath,
        smokeCase,
        workspace,
        Math.min(commandTimeoutMs, remainingMs),
        environment,
      );
      outcomes.push(Object.freeze({ iteration, ...outcome }));
      if (outcomeFailed(outcome)) {
        const reason = outcome.timedOut
          ? "timeout"
          : outcome.outputLimit
            ? "output-limit"
            : outcome.invalidOutput
              ? "invalid-output"
              : (outcome.spawnError ?? (outcome.exitCode === 0 ? "terminated" : "nonzero-exit"));
        blockingFindings.push({
          id: failureId(phase, iteration, smokeCase.id, reason),
          severity: "P1",
        });
      }
    }
  }
  return Object.freeze({ phase, outcomes, blockingFindings, deadlineExceeded });
}

function summarizeFinding(finding) {
  const result = { id: finding.id, severity: finding.severity };
  if (finding.status !== undefined) {
    result.status = finding.status;
    result.owner = finding.owner;
    result.dueDate = finding.dueDate;
    result.rationaleSha256 = finding.rationaleSha256;
  }
  return Object.freeze(result);
}

function summarizeBlockingFinding(finding) {
  return Object.freeze({ id: finding.id, severity: finding.severity });
}

export async function runSoakRehearsal(options) {
  const requestedWorkspace = validateAbsolutePath(options.workspace, "workspace");
  const candidateBundle = await inspectDirectory(options.candidateBundle, "candidate bundle");
  const previousBundle = await inspectDirectory(options.previousBundle, "previous bundle");
  const workspace = await inspectDirectory(options.workspace, "workspace");
  const output = validateAbsolutePath(options.output, "report output");
  if (
    !isOutputOutsideWorkspace(path.resolve(requestedWorkspace), path.resolve(output)) ||
    !isOutputOutsideWorkspace(workspace, output)
  )
    fail("report output must be outside the workspace");
  if (candidateBundle === previousBundle)
    fail("candidate and previous bundles must be different directories");
  const candidateCli = await inspectFile(options.candidateCli, "candidate CLI");
  const previousCli = await inspectFile(options.previousCli, "previous CLI");
  const candidateCliReal = candidateCli.real;
  const previousCliReal = previousCli.real;
  if (!isWithin(candidateBundle, candidateCliReal))
    fail("candidate CLI must be inside candidate bundle");
  if (!isWithin(previousBundle, previousCliReal))
    fail("previous CLI must be inside previous bundle");
  const [
    candidateVerification,
    previousVerification,
    candidateArtifact,
    previousArtifact,
    candidateCliDigest,
    previousCliDigest,
    findings,
  ] = await Promise.all([
    verifyReleaseArtifactBundle(candidateBundle),
    verifyReleaseArtifactBundle(previousBundle),
    digestBundle(candidateBundle),
    digestBundle(previousBundle),
    boundedFileDigest(candidateCliReal, "candidate CLI"),
    boundedFileDigest(previousCliReal, "previous CLI"),
    loadFindings(options.findings),
  ]);
  const candidateVersion = parseVersion(candidateVerification.releaseVersion, "candidate version");
  const previousVersion = parseVersion(previousVerification.releaseVersion, "previous version");
  if (compareVersions(candidateVersion, previousVersion) <= 0)
    fail("candidate release must be newer than the previous release");
  if (candidateArtifact.sha256 === previousArtifact.sha256)
    fail("candidate and previous artifacts are identical");

  const boundedFindings = findings.map(summarizeFinding);
  const blockingInputFindings = findings.filter(
    (finding) => finding.severity === "P0" || finding.severity === "P1",
  );
  const reportBase = {
    $schema: "https://agent-context.invalid/schemas/release-soak-report.v1.schema.json",
    artifactFormat: FORMAT,
    schemaVersion: 1,
    harness: {
      iterations: options.iterations,
      commandTimeoutMs: options.commandTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      smokeCases: SMOKE_CASES.map(({ id, output }) => ({ id, output })),
      networkPolicy: "deny-preload",
      processPolicy: "deny-preload",
      repositoryMutation: "detected-by-workspace-digest",
    },
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    candidate: {
      version: candidateVerification.releaseVersion,
      artifactSha256: candidateArtifact.sha256,
      artifactFiles: candidateArtifact.files,
      artifactBytes: candidateArtifact.bytes,
      cliSha256: candidateCliDigest.sha256,
      cliBytes: candidateCliDigest.bytes,
    },
    previous: {
      version: previousVerification.releaseVersion,
      artifactSha256: previousArtifact.sha256,
      artifactFiles: previousArtifact.files,
      artifactBytes: previousArtifact.bytes,
      cliSha256: previousCliDigest.sha256,
      cliBytes: previousCliDigest.bytes,
    },
    findings: boundedFindings,
    limits: {
      maxIterations: MAX_ITERATIONS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxReportBytes: MAX_REPORT_BYTES,
      maxTotalTimeoutMs: MAX_TOTAL_TIMEOUT_MS,
    },
    workspace: { files: 0, bytes: 0, sha256: sha256(Buffer.alloc(0)) },
  };
  if (blockingInputFindings.length > 0) {
    return Object.freeze({
      report: Object.freeze({
        ...reportBase,
        status: "blocked-p0-p1",
        blockingFindings: blockingInputFindings.map(summarizeBlockingFinding),
        rollbackVerified: false,
        phases: [],
      }),
      exitCode: 2,
    });
  }

  const runRoot = await mkdtemp(path.join(os.tmpdir(), "agent-context-release-soak-"));
  try {
    const emptyHome = path.join(runRoot, "home");
    const tempDirectory = path.join(runRoot, "tmp");
    await mkdir(emptyHome, { recursive: true, mode: 0o700 });
    await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
    const preload = path.join(runRoot, "deny-capabilities.cjs");
    await writeFile(preload, denyCapabilitiesSource(), { encoding: "utf8", mode: 0o600 });
    const environment = {
      CI: "1",
      HOME: emptyHome,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
      TMPDIR: tempDirectory,
      TZ: "UTC",
      NODE_OPTIONS: `--require=${preload}`,
    };
    const before = await snapshotWorkspace(workspace);
    const deadlineNs = process.hrtime.bigint() + BigInt(options.totalTimeoutMs) * 1_000_000n;
    const candidatePhase = await runPhase({
      phase: "candidate",
      cliPath: candidateCliReal,
      workspace,
      iterations: options.iterations,
      commandTimeoutMs: options.commandTimeoutMs,
      deadlineNs,
      environment,
    });
    const afterCandidate = await snapshotWorkspace(workspace);
    const candidateMutated = before.sha256 !== afterCandidate.sha256;
    const previousPhase = candidateMutated
      ? Object.freeze({
          phase: "rollback",
          outcomes: [],
          blockingFindings: [],
          deadlineExceeded: false,
          skipped: "workspace-mutated",
        })
      : await runPhase({
          phase: "rollback",
          cliPath: previousCliReal,
          workspace,
          iterations: options.iterations,
          commandTimeoutMs: options.commandTimeoutMs,
          deadlineNs,
          environment,
        });
    const after = await snapshotWorkspace(workspace);
    const workspaceMutated = before.sha256 !== after.sha256;
    const blockingFindings = [
      ...candidatePhase.blockingFindings,
      ...previousPhase.blockingFindings,
      ...(candidateMutated || workspaceMutated
        ? [{ id: "workspace.mutated", severity: "P1" }]
        : []),
    ];
    const report = Object.freeze({
      ...reportBase,
      status:
        blockingFindings.length === 0 &&
        !candidatePhase.deadlineExceeded &&
        !previousPhase.deadlineExceeded
          ? "passed"
          : "failed-p1",
      blockingFindings: blockingFindings.map(summarizeBlockingFinding),
      rollbackVerified:
        !candidateMutated &&
        !workspaceMutated &&
        previousPhase.skipped === undefined &&
        previousPhase.blockingFindings.length === 0 &&
        !previousPhase.deadlineExceeded,
      phases: [candidatePhase, previousPhase],
      workspace: after,
    });
    return Object.freeze({ report, exitCode: report.status === "passed" ? 0 : 1 });
  } finally {
    await rm(runRoot, { force: true, recursive: true });
  }
}

async function writeReport(filename, report) {
  const parent = path.dirname(filename);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    fail("report parent must be a regular directory");
  const bytes = Buffer.from(canonicalJson(report), "utf8");
  if (bytes.byteLength > MAX_REPORT_BYTES) fail("report exceeds the byte bound");
  await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseSoakArguments(argv);
  const result = await runSoakRehearsal(options);
  await writeReport(options.output, result.report);
  process.stdout.write(
    `${JSON.stringify({ status: result.report.status, report: options.output })}\n`,
  );
  return result.exitCode;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "release soak failed"}\n`);
    process.exitCode = 2;
  }
}

export const RELEASE_SOAK_LIMITS = Object.freeze({
  MAX_ITERATIONS,
  MAX_COMMAND_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_TOTAL_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_REPORT_BYTES,
});
