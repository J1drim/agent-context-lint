#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PACKAGE_INSTALL_MATRIX_EVIDENCE_FORMAT = "agent-context-package-install-matrix-v1";
export const PACKAGE_INSTALL_MATRIX_EVIDENCE_SCHEMA =
  "https://agent-context.invalid/schemas/package-install-matrix-report.v1.schema.json";
export const PACKAGE_INSTALL_MATRIX_EVIDENCE_VERSION = 1;

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MANAGERS = 4;
const MAX_REASON_BYTES = 128;
const MAX_NODE_VERSION_BYTES = 64;
const MAX_MANAGER_OUTPUT_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NODE_VERSION_PATTERN = /^v(?:\d+)\.(?:\d+)\.(?:\d+)(?:\+[0-9A-Za-z.-]+)?$/u;
const PACKAGE_MANAGER_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PACKAGE_MANAGER_NAMES = Object.freeze(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_MANAGER_SET = new Set(PACKAGE_MANAGER_NAMES);
const MANAGER_STATES = new Set(["passed", "unavailable", "blocked", "failed"]);
const ASSESSMENTS = new Set(["passed", "exploratory", "pending-external", "blocked"]);
const REASONS = new Set([
  "missing-executable",
  "node-engine-mismatch",
  "invalid-executable",
  "invalid-node-launcher",
  "invalid-pnpm-launcher",
  "node-runtime-probe-failed",
  "node-runtime-invalid",
  "node-runtime-mismatch",
  "manager-version-probe-failed",
  "manager-version-invalid",
  "pnpm-version-probe-failed",
  "pnpm-version-mismatch",
  "install-failed",
  "workspace-backlink",
  "runtime-validation-failed",
  "tarball-mutated",
]);

export const PACKAGE_INSTALL_MATRIX_EVIDENCE_LIMITS = Object.freeze({
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_MANAGERS,
  MAX_REASON_BYTES,
  MAX_NODE_VERSION_BYTES,
  MAX_MANAGER_OUTPUT_BYTES,
});

export function nodeRuntimeSatisfiesReleaseRange(version) {
  if (typeof version !== "string") return false;
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 24 && minor >= 11) || major === 26;
}

const compareUtf8 = (left, right) =>
  Math.sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));

export function canonicalize(value) {
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
  throw new Error(`package install evidence: ${message}`);
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${label} has unknown field ${key}`);
  }
}

function required(value, label) {
  if (value === undefined) fail(`${label} is required`);
  return value;
}

function assertString(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    fail(`${label} must be a non-empty string of at most ${maximum} characters`);
  if (value.includes("\0")) fail(`${label} contains a NUL`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value))
    fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function assertNodeVersion(value, label) {
  const version = assertString(value, label, MAX_NODE_VERSION_BYTES);
  if (!NODE_VERSION_PATTERN.test(version)) fail(`${label} must be a stable Node version`);
  return version;
}

function assertPackageManagerVersion(value, label) {
  const version = assertString(value, label, 32);
  if (!PACKAGE_MANAGER_VERSION_PATTERN.test(version))
    fail(`${label} must be a stable package-manager version`);
  return version;
}

function assertInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    fail(`${label} must be an integer between 0 and ${maximum}`);
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function assertEnum(value, values, label) {
  if (typeof value !== "string" || !values.has(value)) fail(`${label} is invalid`);
  return value;
}

function assertManagers(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MANAGERS)
    fail(`${label} must contain 1-${MAX_MANAGERS} managers`);
  const managers = value.map((manager, index) => {
    const item = assertString(manager, `${label}[${index}]`, 8);
    if (!PACKAGE_MANAGER_SET.has(item)) fail(`${label}[${index}] is unsupported`);
    return item;
  });
  if (new Set(managers).size !== managers.length) fail(`${label} contains duplicate managers`);
  return managers;
}

function assertReason(value, label) {
  const reason = assertString(value, label, MAX_REASON_BYTES);
  if (!REASONS.has(reason)) fail(`${label} is invalid`);
  return reason;
}

function normalizeManager(value, index) {
  const label = `managers[${index}]`;
  const manager = assertObject(value, label);
  assertExactKeys(
    manager,
    [
      "manager",
      "runtime",
      "state",
      "reason",
      "nodeVersion",
      "managerVersion",
      "expectedPnpmVersion",
      "observedPnpmVersion",
      "cliManifestSha256",
      "coreManifestSha256",
      "stderrSha256",
      "stdoutSha256",
      "stderrBytes",
      "stdoutBytes",
    ],
    label,
  );
  const normalized = {
    manager: assertEnum(
      required(manager.manager, `${label}.manager`),
      PACKAGE_MANAGER_SET,
      `${label}.manager`,
    ),
    state: assertEnum(required(manager.state, `${label}.state`), MANAGER_STATES, `${label}.state`),
  };
  if (manager.runtime !== undefined) {
    normalized.runtime = assertEnum(
      manager.runtime,
      new Set(["node", "native"]),
      `${label}.runtime`,
    );
    const expectedRuntime = normalized.manager === "bun" ? "native" : "node";
    if (normalized.runtime !== expectedRuntime) fail(`${label}.runtime does not match its manager`);
  }
  if (manager.reason !== undefined)
    normalized.reason = assertReason(manager.reason, `${label}.reason`);
  if (manager.nodeVersion !== undefined)
    normalized.nodeVersion = assertNodeVersion(manager.nodeVersion, `${label}.nodeVersion`);
  if (manager.managerVersion !== undefined)
    normalized.managerVersion = assertPackageManagerVersion(
      manager.managerVersion,
      `${label}.managerVersion`,
    );
  if (manager.expectedPnpmVersion !== undefined)
    normalized.expectedPnpmVersion = assertPackageManagerVersion(
      manager.expectedPnpmVersion,
      `${label}.expectedPnpmVersion`,
    );
  if (manager.observedPnpmVersion !== undefined)
    normalized.observedPnpmVersion = assertPackageManagerVersion(
      manager.observedPnpmVersion,
      `${label}.observedPnpmVersion`,
    );
  for (const key of ["cliManifestSha256", "coreManifestSha256", "stderrSha256", "stdoutSha256"])
    if (manager[key] !== undefined) normalized[key] = assertDigest(manager[key], `${label}.${key}`);
  for (const key of ["stderrBytes", "stdoutBytes"])
    if (manager[key] !== undefined)
      normalized[key] = assertInteger(manager[key], `${label}.${key}`, MAX_MANAGER_OUTPUT_BYTES);

  if (normalized.state === "passed") {
    if (normalized.reason !== undefined) fail(`${label}.reason is not allowed for passed managers`);
    if (normalized.cliManifestSha256 === undefined || normalized.coreManifestSha256 === undefined)
      fail(`${label} passed state requires installed manifest digests`);
  } else if (normalized.reason === undefined) {
    fail(`${label}.reason is required for a non-passed manager`);
  }
  if (normalized.state === "blocked" && normalized.reason !== "node-engine-mismatch")
    fail(`${label} blocked state requires node-engine-mismatch`);
  if (normalized.state === "unavailable" && normalized.reason !== "missing-executable")
    fail(`${label} unavailable state requires missing-executable`);
  if (normalized.state === "failed" && normalized.reason === "node-engine-mismatch")
    fail(`${label} failed state cannot use node-engine-mismatch`);
  if (
    normalized.manager !== "pnpm" &&
    (normalized.expectedPnpmVersion !== undefined || normalized.observedPnpmVersion !== undefined)
  )
    fail(`${label} pnpm version fields require the pnpm manager`);
  return Object.freeze(normalized);
}

function assertPolicy(value) {
  const policy = assertObject(value, "policy");
  assertExactKeys(
    policy,
    ["networkAccess", "credentials", "repositoryMutation", "sourcePaths"],
    "policy",
  );
  for (const [key, expected] of [
    ["networkAccess", "not-used"],
    ["credentials", "none"],
    ["repositoryMutation", "not-observed"],
    ["sourcePaths", "not-retained"],
  ]) {
    if (policy[key] !== expected) fail(`policy.${key} must be ${expected}`);
  }
  return Object.freeze({ ...policy });
}

function assertLimits(value) {
  const limits = assertObject(value, "limits");
  const expected = PACKAGE_INSTALL_MATRIX_EVIDENCE_LIMITS;
  assertExactKeys(limits, Object.keys(expected), "limits");
  for (const key of Object.keys(expected)) {
    if (limits[key] !== expected[key]) fail(`limits.${key} does not match the evidence contract`);
  }
  return Object.freeze({ ...limits });
}

function reportWithoutDigest(value) {
  const copy = { ...value };
  delete copy.reportSha256;
  return copy;
}

export function packageInstallMatrixReportDigest(value) {
  return sha256(Buffer.from(canonicalJson(reportWithoutDigest(value)), "utf8"));
}

function deriveAssessment(strict, managers) {
  const states = managers.map(({ state }) => state);
  const allPassed = states.every((state) => state === "passed");
  if (strict) return allPassed ? "passed" : "blocked";
  if (allPassed) return "exploratory";
  if (
    states.some((state) => state === "passed") &&
    states.every((state) => state === "passed" || state === "unavailable")
  )
    return "pending-external";
  return "blocked";
}

function normalizeEvidence(value) {
  const report = assertObject(value, "report");
  assertExactKeys(
    report,
    [
      "$schema",
      "artifactFormat",
      "schemaVersion",
      "mode",
      "assessment",
      "nodeVersion",
      "selectedManagers",
      "strict",
      "managers",
      "tarballs",
      "policy",
      "limits",
      "reportSha256",
    ],
    "report",
  );
  if (report.$schema !== PACKAGE_INSTALL_MATRIX_EVIDENCE_SCHEMA) fail("report.$schema is invalid");
  if (report.artifactFormat !== PACKAGE_INSTALL_MATRIX_EVIDENCE_FORMAT)
    fail("report.artifactFormat is invalid");
  if (report.schemaVersion !== PACKAGE_INSTALL_MATRIX_EVIDENCE_VERSION)
    fail("report.schemaVersion must be 1");
  if (report.mode !== "offline-local") fail("report.mode must be offline-local");
  const selectedManagers = assertManagers(
    required(report.selectedManagers, "report.selectedManagers"),
    "report.selectedManagers",
  );
  const managersValue = required(report.managers, "report.managers");
  if (!Array.isArray(managersValue) || managersValue.length !== selectedManagers.length)
    fail("report.managers must match selectedManagers length");
  const managers = managersValue.map(normalizeManager);
  if (managers.some(({ manager }, index) => manager !== selectedManagers[index]))
    fail("report.managers must match selectedManagers order");
  const strict = assertBoolean(required(report.strict, "report.strict"), "report.strict");
  if (
    strict &&
    managers.some(
      (manager) =>
        manager.state === "passed" &&
        (manager.runtime === undefined || manager.nodeVersion === undefined),
    )
  )
    fail("strict passed managers require runtime and Node attestation fields");
  const assessment = assertEnum(
    required(report.assessment, "report.assessment"),
    ASSESSMENTS,
    "report.assessment",
  );
  const derivedAssessment = deriveAssessment(strict, managers);
  if (assessment !== derivedAssessment)
    fail(`report.assessment must be ${derivedAssessment} for its manager states`);
  const nodeVersion = assertNodeVersion(
    required(report.nodeVersion, "report.nodeVersion"),
    "report.nodeVersion",
  );
  if (
    managers.some(
      (manager) =>
        manager.state === "passed" &&
        manager.nodeVersion !== undefined &&
        manager.nodeVersion !== nodeVersion,
    )
  )
    fail("manager Node attestation does not match report.nodeVersion");
  const tarballs = assertObject(required(report.tarballs, "report.tarballs"), "report.tarballs");
  assertExactKeys(tarballs, ["cliSha256", "coreSha256"], "report.tarballs");
  const normalizedTarballs = {
    cliSha256: assertDigest(
      required(tarballs.cliSha256, "report.tarballs.cliSha256"),
      "report.tarballs.cliSha256",
    ),
    coreSha256: assertDigest(
      required(tarballs.coreSha256, "report.tarballs.coreSha256"),
      "report.tarballs.coreSha256",
    ),
  };
  if (normalizedTarballs.cliSha256 === normalizedTarballs.coreSha256)
    fail("report.tarballs digests must be distinct");
  const policy = assertPolicy(required(report.policy, "report.policy"));
  const limits = assertLimits(required(report.limits, "report.limits"));
  const reportSha256 = assertDigest(
    required(report.reportSha256, "report.reportSha256"),
    "report.reportSha256",
  );
  if (!nodeRuntimeSatisfiesReleaseRange(nodeVersion) && assessment !== "blocked")
    fail("unsupported Node release can only produce a blocked assessment");
  const normalized = {
    $schema: PACKAGE_INSTALL_MATRIX_EVIDENCE_SCHEMA,
    artifactFormat: PACKAGE_INSTALL_MATRIX_EVIDENCE_FORMAT,
    schemaVersion: PACKAGE_INSTALL_MATRIX_EVIDENCE_VERSION,
    mode: "offline-local",
    assessment,
    nodeVersion,
    selectedManagers,
    strict,
    managers,
    tarballs: normalizedTarballs,
    policy,
    limits,
    reportSha256,
  };
  const computed = packageInstallMatrixReportDigest(normalized);
  if (computed !== reportSha256) fail("reportSha256 does not match canonical report bytes");
  return Object.freeze(JSON.parse(canonicalJson(normalized)));
}

export function validatePackageInstallMatrixEvidence(value, options = {}) {
  const report = normalizeEvidence(value);
  if (options.expectedTarballs !== undefined) {
    const expected = assertObject(options.expectedTarballs, "expectedTarballs");
    assertExactKeys(expected, ["cliSha256", "coreSha256"], "expectedTarballs");
    if (
      assertDigest(expected.cliSha256, "expectedTarballs.cliSha256") !== report.tarballs.cliSha256
    )
      fail("CLI tarball digest does not match expected identity");
    if (
      assertDigest(expected.coreSha256, "expectedTarballs.coreSha256") !==
      report.tarballs.coreSha256
    )
      fail("core tarball digest does not match expected identity");
  }
  if (
    options.nodeVersion !== undefined &&
    assertNodeVersion(options.nodeVersion, "expected nodeVersion") !== report.nodeVersion
  )
    fail("Node version does not match expected identity");
  return report;
}

export function replayPackageInstallMatrixEvidence(value, options = {}) {
  const report = validatePackageInstallMatrixEvidence(value, options);
  const passedManagers = report.managers
    .filter(({ state }) => state === "passed")
    .map(({ manager }) => manager);
  const unavailableManagers = report.managers
    .filter(({ state }) => state === "unavailable")
    .map(({ manager }) => manager);
  const blockedManagers = report.managers
    .filter(({ state }) => state === "blocked")
    .map(({ manager }) => manager);
  const failedManagers = report.managers
    .filter(({ state }) => state === "failed")
    .map(({ manager }) => manager);
  const releaseReady = report.assessment === "passed" && report.strict === true;
  return Object.freeze({
    report,
    reportSha256: report.reportSha256,
    passedManagers,
    unavailableManagers,
    blockedManagers,
    failedManagers,
    nodeReleaseSupported: nodeRuntimeSatisfiesReleaseRange(report.nodeVersion),
    success: releaseReady,
    releaseReady,
  });
}

function mapFailureReason(result) {
  const reason = typeof result.reason === "string" ? result.reason : "";
  if (REASONS.has(reason)) return reason;
  if (result.state === "blocked" || reason === "node-engine-mismatch")
    return "node-engine-mismatch";
  if (result.state === "unavailable" || /^missing-/u.test(reason)) return "missing-executable";
  if (/exact \.js, \.cjs, or \.mjs launcher/u.test(reason)) return "invalid-node-launcher";
  if (/exact \.cjs or \.mjs launcher|regular file/u.test(reason)) return "invalid-pnpm-launcher";
  if (reason === "pnpm-version-probe-failed") return "pnpm-version-probe-failed";
  if (reason === "pnpm-version-mismatch") return "pnpm-version-mismatch";
  if (/link(?:s|ed) back into/u.test(reason)) return "workspace-backlink";
  if (/tarball changed/u.test(reason)) return "tarball-mutated";
  if (/runtime|identity|license|dependency|version probe|executable CLI/u.test(reason))
    return "runtime-validation-failed";
  return "install-failed";
}

function normalizeRawManager(result, index) {
  const manager = assertObject(result, `raw.managers[${index}]`);
  assertExactKeys(
    manager,
    [
      "manager",
      "runtime",
      "state",
      "reason",
      "nodeVersion",
      "managerVersion",
      "expectedPnpmVersion",
      "observedPnpmVersion",
      "cliManifestSha256",
      "coreManifestSha256",
      "stderrSha256",
      "stdoutSha256",
      "stderrBytes",
      "stdoutBytes",
      "status",
      "signal",
    ],
    `raw.managers[${index}]`,
  );
  const name = assertEnum(
    required(manager.manager, `raw.managers[${index}].manager`),
    PACKAGE_MANAGER_SET,
    `raw.managers[${index}].manager`,
  );
  const state = assertEnum(
    required(manager.state, `raw.managers[${index}].state`),
    MANAGER_STATES,
    `raw.managers[${index}].state`,
  );
  const normalized = { manager: name, state };
  if (manager.runtime !== undefined) {
    normalized.runtime = assertEnum(
      manager.runtime,
      new Set(["node", "native"]),
      `raw.managers[${index}].runtime`,
    );
    const expectedRuntime = name === "bun" ? "native" : "node";
    if (normalized.runtime !== expectedRuntime)
      fail(`raw.managers[${index}].runtime does not match its manager`);
  }
  if (state === "passed" && manager.reason !== undefined)
    fail(`raw.managers[${index}].passed state cannot include a reason`);
  if (
    state === "unavailable" &&
    (typeof manager.reason !== "string" || !/^missing-/u.test(manager.reason))
  )
    fail(`raw.managers[${index}] unavailable state requires a missing executable reason`);
  if (state === "blocked" && manager.reason !== "node-engine-mismatch")
    fail(`raw.managers[${index}] blocked state requires node-engine-mismatch`);
  if (state !== "passed") normalized.reason = mapFailureReason(manager);
  if (state === "blocked")
    normalized.nodeVersion = assertNodeVersion(
      required(manager.nodeVersion, `raw.managers[${index}].nodeVersion`),
      `raw.managers[${index}].nodeVersion`,
    );
  if (manager.nodeVersion !== undefined && state !== "blocked")
    normalized.nodeVersion = assertNodeVersion(
      manager.nodeVersion,
      `raw.managers[${index}].nodeVersion`,
    );
  for (const key of ["expectedPnpmVersion", "observedPnpmVersion"])
    if (manager[key] !== undefined)
      normalized[key] = assertPackageManagerVersion(manager[key], `raw.managers[${index}].${key}`);
  if (manager.managerVersion !== undefined)
    normalized.managerVersion = assertPackageManagerVersion(
      manager.managerVersion,
      `raw.managers[${index}].managerVersion`,
    );
  for (const key of ["cliManifestSha256", "coreManifestSha256", "stderrSha256", "stdoutSha256"])
    if (manager[key] !== undefined)
      normalized[key] = assertDigest(manager[key], `raw.managers[${index}].${key}`);
  for (const key of ["stderrBytes", "stdoutBytes"])
    if (manager[key] !== undefined)
      normalized[key] = assertInteger(
        manager[key],
        `raw.managers[${index}].${key}`,
        MAX_MANAGER_OUTPUT_BYTES,
      );
  return normalized;
}

export function createPackageInstallMatrixEvidence(value) {
  const input = assertObject(value, "raw report");
  if (input.artifactFormat === PACKAGE_INSTALL_MATRIX_EVIDENCE_FORMAT)
    return validatePackageInstallMatrixEvidence(input);
  assertExactKeys(
    input,
    [
      "artifactKind",
      "schemaVersion",
      "nodeVersion",
      "managers",
      "selectedManagers",
      "strict",
      "tarballs",
    ],
    "raw report",
  );
  if (input.artifactKind !== "agent-context-package-install-matrix")
    fail("raw report.artifactKind is invalid");
  if (input.schemaVersion !== "0.1.0") fail("raw report.schemaVersion must be 0.1.0");
  const selectedManagers = assertManagers(
    required(input.selectedManagers, "raw report.selectedManagers"),
    "raw report.selectedManagers",
  );
  if (!Array.isArray(input.managers) || input.managers.length !== selectedManagers.length)
    fail("raw report.managers must match selectedManagers length");
  const managers = input.managers.map(normalizeRawManager);
  if (managers.some(({ manager }, index) => manager !== selectedManagers[index]))
    fail("raw report.managers must match selectedManagers order");
  const strict = assertBoolean(required(input.strict, "raw report.strict"), "raw report.strict");
  const nodeVersion = assertNodeVersion(
    required(input.nodeVersion, "raw report.nodeVersion"),
    "raw report.nodeVersion",
  );
  if (
    strict &&
    managers.some(
      (manager) =>
        manager.state === "passed" &&
        (manager.runtime === undefined || manager.nodeVersion === undefined),
    )
  )
    fail("raw strict passed managers require runtime and Node attestation fields");
  const tarballs = assertObject(
    required(input.tarballs, "raw report.tarballs"),
    "raw report.tarballs",
  );
  assertExactKeys(tarballs, ["cliSha256", "coreSha256"], "raw report.tarballs");
  const normalized = {
    $schema: PACKAGE_INSTALL_MATRIX_EVIDENCE_SCHEMA,
    artifactFormat: PACKAGE_INSTALL_MATRIX_EVIDENCE_FORMAT,
    schemaVersion: PACKAGE_INSTALL_MATRIX_EVIDENCE_VERSION,
    mode: "offline-local",
    assessment: deriveAssessment(strict, managers),
    nodeVersion,
    selectedManagers,
    strict,
    managers,
    tarballs: {
      cliSha256: assertDigest(
        required(tarballs.cliSha256, "raw report.tarballs.cliSha256"),
        "raw report.tarballs.cliSha256",
      ),
      coreSha256: assertDigest(
        required(tarballs.coreSha256, "raw report.tarballs.coreSha256"),
        "raw report.tarballs.coreSha256",
      ),
    },
    policy: {
      networkAccess: "not-used",
      credentials: "none",
      repositoryMutation: "not-observed",
      sourcePaths: "not-retained",
    },
    limits: PACKAGE_INSTALL_MATRIX_EVIDENCE_LIMITS,
  };
  if (
    managers.some(
      (manager) =>
        manager.state === "passed" &&
        manager.nodeVersion !== undefined &&
        manager.nodeVersion !== nodeVersion,
    )
  )
    fail("raw manager Node attestation does not match report.nodeVersion");
  if (normalized.tarballs.cliSha256 === normalized.tarballs.coreSha256)
    fail("raw report.tarballs digests must be distinct");
  normalized.reportSha256 = packageInstallMatrixReportDigest(normalized);
  return validatePackageInstallMatrixEvidence(normalized);
}

async function readBoundedJson(filename) {
  const inspected = await lstat(filename);
  if (!inspected.isFile() || inspected.isSymbolicLink())
    fail("input must be a regular non-symlink file");
  if (inspected.size > MAX_INPUT_BYTES) fail(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  const bytes = await readFile(filename);
  if (bytes.length > MAX_INPUT_BYTES) fail(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(
      `input is not valid JSON: ${error instanceof Error ? error.message.slice(0, 160) : "parse failed"}`,
    );
  }
}

async function writeExclusive(filename, report) {
  const bytes = Buffer.from(canonicalJson(report), "utf8");
  if (bytes.length > MAX_OUTPUT_BYTES) fail(`output exceeds ${MAX_OUTPUT_BYTES} bytes`);
  await writeFile(filename, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function usage() {
  return [
    "Usage: node scripts/package-install-matrix-evidence.mjs --input REPORT.json [options]",
    "",
    "Options:",
    "  --input PATH                 raw 0.1.0 matrix or retained v1 report",
    "  --output PATH                write canonical retained evidence (exclusive create)",
    "  --expected-cli-sha256 HASH   require the exact CLI tarball identity",
    "  --expected-core-sha256 HASH  require the exact core tarball identity",
    "  --format json|terminal       output format (default: terminal)",
    "  --help                       show this message",
    "",
    "The validator never reads tarball paths, starts package managers, uses PATH, or claims a",
    "release pass when a manager is unavailable, blocked, failed, or omitted by a strict run.",
  ].join("\n");
}

function parseArguments(arguments_) {
  const options = { format: "terminal" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (
      argument === "--input" ||
      argument === "--output" ||
      argument === "--format" ||
      argument === "--expected-cli-sha256" ||
      argument === "--expected-core-sha256"
    ) {
      const value = arguments_[++index];
      if (value === undefined || value.length === 0) fail(`${argument} requires a value`);
      if (argument === "--input" || argument === "--output")
        options[argument.slice(2)] = path.resolve(rootDirectory, value);
      else if (argument === "--format") options.format = value;
      else if (argument === "--expected-cli-sha256") options.expectedCliSha256 = value;
      else options.expectedCoreSha256 = value;
      continue;
    }
    throw new Error(`package install evidence: unknown option ${argument}`);
  }
  if (options.input === undefined) fail("--input is required");
  if (!new Set(["json", "terminal"]).has(options.format)) fail("--format must be json or terminal");
  if (options.expectedCliSha256 !== undefined)
    assertDigest(options.expectedCliSha256, "--expected-cli-sha256");
  if (options.expectedCoreSha256 !== undefined)
    assertDigest(options.expectedCoreSha256, "--expected-core-sha256");
  if (options.output !== undefined && options.output === options.input)
    fail("--output must differ from --input");
  return options;
}

function renderTerminal(replay) {
  const { report } = replay;
  return (
    [
      `Package install evidence (${report.nodeVersion})`,
      `Assessment: ${report.assessment}`,
      `Managers: ${report.managers.map(({ manager, state }) => `${manager}=${state}`).join(", ")}`,
      `Release-ready: ${replay.releaseReady ? "yes" : "no"}`,
      `Report SHA-256: ${report.reportSha256}`,
    ].join("\n") + "\n"
  );
}

export async function main(arguments_ = process.argv.slice(2)) {
  try {
    const options = parseArguments(arguments_);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const input = await readBoundedJson(options.input);
    const report =
      input.artifactFormat === PACKAGE_INSTALL_MATRIX_EVIDENCE_FORMAT
        ? validatePackageInstallMatrixEvidence(input, {
            expectedTarballs: {
              cliSha256: options.expectedCliSha256 ?? input.tarballs?.cliSha256,
              coreSha256: options.expectedCoreSha256 ?? input.tarballs?.coreSha256,
            },
          })
        : createPackageInstallMatrixEvidence(input);
    if (options.expectedCliSha256 !== undefined || options.expectedCoreSha256 !== undefined) {
      validatePackageInstallMatrixEvidence(report, {
        expectedTarballs: {
          cliSha256: options.expectedCliSha256 ?? report.tarballs.cliSha256,
          coreSha256: options.expectedCoreSha256 ?? report.tarballs.coreSha256,
        },
      });
    }
    if (options.output !== undefined) await writeExclusive(options.output, report);
    const replay = replayPackageInstallMatrixEvidence(report);
    process.stdout.write(
      options.format === "json" ? canonicalJson(report) : renderTerminal(replay),
    );
    return replay.releaseReady ? 0 : 2;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "package install evidence: validation failed"}\n`,
    );
    process.stderr.write("Run with --help for usage.\n");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
