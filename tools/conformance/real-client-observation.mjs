#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { types as nodeTypes } from "node:util";
import { fileURLToPath } from "node:url";

export const REAL_CLIENT_OBSERVATION_CONTRACT_VERSION = "0.1.0";
export const REAL_CLIENT_OBSERVATION_PLAN_KIND = "agent-context-real-client-observation-plan";
export const REAL_CLIENT_OBSERVATION_TRANSCRIPT_KIND =
  "agent-context-real-client-observation-transcript";
export const REAL_CLIENT_OBSERVATION_MAX_PLAN_BYTES = 1024 * 1024;
export const REAL_CLIENT_OBSERVATION_MAX_OUTPUT_BYTES = 64 * 1024;
export const REAL_CLIENT_OBSERVATION_TIMEOUT_MS = 10_000;

const PLAN_KEYS = new Set([
  "capabilityPolicy",
  "caseId",
  "client",
  "contractVersion",
  "expectedLoadedSourceSequence",
  "fixtureFiles",
  "observedAt",
  "operation",
  "profileId",
  "recordKind",
  "settingSources",
  "supervisor",
  "surfaceId",
]);
const CLIENT_KEYS = new Set(["executablePath", "executableSha256", "expectedVersion"]);
const SUPERVISOR_KEYS = new Set(["executablePath", "executableSha256", "kind"]);
const FILE_KEYS = new Set(["content", "markerId", "path"]);
const CAPABILITY_POLICY_KEYS = new Set(["allowed", "denied"]);
const SUPERVISOR_RESULT_KEYS = new Set(["exitCode", "signal", "stderr", "stdout"]);
const VERIFIED_EXECUTABLE_KEYS = new Set(["digest", "identity", "realPath"]);
const PROFILE_SURFACES = new Map([
  ["codex-cli", new Set(["codex-cli/local-cli-single-cwd"])],
  ["claude-code", new Set(["claude-code/local-session"])],
  ["copilot-cli", new Set(["copilot-cli/local-terminal"])],
  ["copilot-vscode", new Set(["copilot-vscode/local-chat"])],
  ["copilot-cloud-agent", new Set(["copilot-cloud-agent/github-hosted"])],
  ["copilot-code-review", new Set(["copilot-code-review/github-hosted"])],
  ["gemini-cli", new Set(["gemini-cli/local-terminal"])],
  ["cursor-agent", new Set(["cursor-agent/ide", "cursor-agent/cli"])],
]);
const LOCAL_SURFACES = new Set([
  "codex-cli/local-cli-single-cwd",
  "claude-code/local-session",
  "copilot-cli/local-terminal",
  "gemini-cli/local-terminal",
  "cursor-agent/cli",
]);
const OPERATIONS = new Set(["blocked-paid-observation", "version-probe"]);
const BLOCKED_REASONS = new Set([
  "hosted-surface-not-locally-observable",
  "ide-surface-needs-reviewed-manual-observation",
  "no-safe-no-model-signal",
  "paid-request-not-authorized",
]);
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "HOME",
  "NO_COLOR",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);
const VERSION_ALLOWED_CAPABILITIES = Object.freeze(["pinned-client-version-metadata"]);
const DENIED_CAPABILITIES = Object.freeze([
  "credential-read",
  "external-network",
  "model-request",
  "repository-command",
  "repository-write",
  "user-config-read",
]);
const MARKER_PATTERN = /^D15_[A-Z0-9_]{1,64}$/u;
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTC_SECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:ENCRYPTED |RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/giu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /gh[pousr]_[A-Za-z0-9]{20,}/gu,
  /glpat-[A-Za-z0-9_-]{20,}/gu,
  /AIza[0-9A-Za-z_-]{35}/gu,
  /npm_[A-Za-z0-9]{36}/gu,
  /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/gu,
  /xox[baprs]-[A-Za-z0-9-]{20,}/gu,
  /sk_live_[A-Za-z0-9]{20,}/gu,
  /(?:authorization|proxy-authorization)\s*:\s*(?:basic|bearer)\s+[^\s]+/giu,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s]+/giu,
]);
const COMMAND_LIKE =
  /(?:^|\s)(?:bash|cmd|curl|del|erase|git|node|npm|pnpm|powershell|pwsh|python|rm|sh|wget|yarn)(?:\s|$)|[$`;&|<>]/iu;
// ANSI control bytes are the syntax this sanitizer intentionally removes.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const USER_PATH = /(?:\/Users\/|\/home\/)[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+/gu;
const ISSUED_TRANSCRIPTS = new WeakSet();

export class RealClientObservationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RealClientObservationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RealClientObservationError(code, message);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function plainRecord(value, allowedKeys, location, errors) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    errors.push(`${location} must be a closed plain data object`);
    return undefined;
  }
  try {
    const prototype = Reflect.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if (prototype !== Object.prototype && prototype !== null) {
      errors.push(`${location} must have an ordinary or null prototype`);
      return undefined;
    }
    if (
      keys.length !== allowedKeys.size ||
      keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))
    ) {
      errors.push(`${location} keys must be exactly ${[...allowedKeys].sort().join(", ")}`);
      return undefined;
    }
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        errors.push(`${location}.${String(key)} must be an enumerable data property`);
        return undefined;
      }
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    errors.push(`${location} could not be inspected safely`);
    return undefined;
  }
}

function denseArray(value, location, errors, maximum) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    errors.push(`${location} must be a dense data array`);
    return undefined;
  }
  try {
    const keys = Reflect.ownKeys(value);
    if (value.length > maximum || keys.length !== value.length + 1 || !keys.includes("length")) {
      errors.push(`${location} must be dense and contain at most ${maximum} entries`);
      return undefined;
    }
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        errors.push(`${location} must contain only enumerable data entries`);
        return undefined;
      }
      output.push(descriptor.value);
    }
    return output;
  } catch {
    errors.push(`${location} could not be inspected safely`);
    return undefined;
  }
}

function forbiddenControl(character) {
  const code = character.codePointAt(0);
  return (
    (code >= 0 && code <= 8) ||
    code === 11 ||
    code === 12 ||
    (code >= 14 && code <= 31) ||
    code === 127
  );
}

function hasForbiddenControl(value) {
  return [...value].some(forbiddenControl);
}

function replaceForbiddenControls(value) {
  return [...value].map((character) => (forbiddenControl(character) ? "�" : character)).join("");
}

function safeString(value, location, errors, maximum = 4096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    hasForbiddenControl(value)
  ) {
    errors.push(`${location} must be a non-empty bounded control-free string`);
    return false;
  }
  return true;
}

function safeContent(value, location, errors, maximum = 65_536) {
  if (typeof value !== "string" || value.length > maximum || hasForbiddenControl(value)) {
    errors.push(`${location} must be a bounded control-free string`);
    return false;
  }
  return true;
}

function validateExactStringArray(value, expected, location, errors) {
  const entries = denseArray(value, location, errors, expected.length);
  if (entries === undefined) return;
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => entry !== expected[index])
  ) {
    errors.push(`${location} must be exactly ${expected.join(", ") || "empty"}`);
  }
}

function validateCapabilityPolicy(value, operation, errors) {
  const policy = plainRecord(value, CAPABILITY_POLICY_KEYS, "$.capabilityPolicy", errors);
  if (policy === undefined) return;
  validateExactStringArray(
    policy.allowed,
    operation === "version-probe" ? VERSION_ALLOWED_CAPABILITIES : [],
    "$.capabilityPolicy.allowed",
    errors,
  );
  validateExactStringArray(policy.denied, DENIED_CAPABILITIES, "$.capabilityPolicy.denied", errors);
}

function validateSettingSources(value, errors) {
  const entries = denseArray(value, "$.settingSources", errors, 16);
  if (entries === undefined) return;
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "string" || !IDENTIFIER_PATTERN.test(entry)) {
      errors.push(`$.settingSources[${index}] must be a canonical identifier`);
      continue;
    }
    if (seen.has(entry)) errors.push(`$.settingSources[${index}] must be unique`);
    seen.add(entry);
  }
  const sorted = [...entries].sort(compareUtf8);
  if (entries.some((entry, index) => entry !== sorted[index])) {
    errors.push("$.settingSources must use locale-free canonical order");
  }
}

function validRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../");
}

function containsSecret(value) {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    return matched;
  });
}

function validateClient(value, operation, surfaceId, errors) {
  if (operation === "blocked-paid-observation") {
    if (typeof value !== "string" || !BLOCKED_REASONS.has(value)) {
      errors.push("$.client must be a supported blocked-observation reason");
    }
    if (
      (typeof surfaceId === "string" &&
        surfaceId.endsWith("/github-hosted") &&
        value !== "hosted-surface-not-locally-observable") ||
      (new Set(["copilot-vscode/local-chat", "cursor-agent/ide"]).has(surfaceId) &&
        value !== "ide-surface-needs-reviewed-manual-observation")
    ) {
      errors.push("$.client blocked reason must match the selected non-local surface");
    }
    return;
  }
  if (!LOCAL_SURFACES.has(surfaceId)) {
    errors.push("$.operation version-probe is available only for a local CLI surface");
  }
  const client = plainRecord(value, CLIENT_KEYS, "$.client", errors);
  if (client === undefined) return;
  if (
    !safeString(client.executablePath, "$.client.executablePath", errors) ||
    !path.isAbsolute(client.executablePath)
  ) {
    errors.push("$.client.executablePath must be an absolute path");
  }
  if (
    typeof client.executableSha256 !== "string" ||
    !SHA256_PATTERN.test(client.executableSha256)
  ) {
    errors.push("$.client.executableSha256 must be a lowercase SHA-256 digest");
  }
  safeString(client.expectedVersion, "$.client.expectedVersion", errors, 128);
}

function validateSupervisor(value, operation, errors) {
  if (operation === "blocked-paid-observation") {
    if (value !== null) errors.push("$.supervisor must be null for a blocked observation");
    return;
  }
  const supervisor = plainRecord(value, SUPERVISOR_KEYS, "$.supervisor", errors);
  if (supervisor === undefined) return;
  if (supervisor.kind !== "macos-sandbox-exec-v1") {
    errors.push("$.supervisor.kind must be macos-sandbox-exec-v1");
  }
  if (
    !safeString(supervisor.executablePath, "$.supervisor.executablePath", errors) ||
    !path.isAbsolute(supervisor.executablePath)
  ) {
    errors.push("$.supervisor.executablePath must be an absolute path");
  }
  if (supervisor.executablePath !== "/usr/bin/sandbox-exec") {
    errors.push("$.supervisor.executablePath must be /usr/bin/sandbox-exec");
  }
  if (
    typeof supervisor.executableSha256 !== "string" ||
    !SHA256_PATTERN.test(supervisor.executableSha256)
  ) {
    errors.push("$.supervisor.executableSha256 must be a lowercase SHA-256 digest");
  }
}

function validateFixtureFiles(value, errors) {
  const files = denseArray(value, "$.fixtureFiles", errors, 200);
  if (files === undefined) return { markers: new Map(), paths: new Set() };
  const markers = new Map();
  const paths = new Set();
  let aggregateBytes = 0;
  for (const [index, rawFile] of files.entries()) {
    const at = `$.fixtureFiles[${index}]`;
    const file = plainRecord(rawFile, FILE_KEYS, at, errors);
    if (file === undefined) continue;
    if (!validRelativePath(file.path)) {
      errors.push(`${at}.path must be a normalized relative path`);
    } else {
      if (paths.has(file.path)) errors.push(`${at}.path must be unique`);
      paths.add(file.path);
    }
    if (file.markerId !== null) {
      if (typeof file.markerId !== "string" || !MARKER_PATTERN.test(file.markerId)) {
        errors.push(`${at}.markerId must be null or satisfy ${MARKER_PATTERN.source}`);
      } else {
        if (markers.has(file.markerId)) errors.push(`${at}.markerId must be unique`);
        markers.set(file.markerId, file.path);
      }
    }
    if (!safeContent(file.content, `${at}.content`, errors)) continue;
    aggregateBytes += Buffer.byteLength(file.content);
    if (aggregateBytes > REAL_CLIENT_OBSERVATION_MAX_PLAN_BYTES) {
      errors.push("$.fixtureFiles aggregate content exceeds 1048576 UTF-8 bytes");
    }
    if (containsSecret(file.content))
      errors.push(`${at}.content contains a credential-shaped value`);
    if (COMMAND_LIKE.test(file.content)) errors.push(`${at}.content contains command-shaped text`);
    if (typeof file.markerId === "string" && MARKER_PATTERN.test(file.markerId)) {
      const occurrences = file.content.split(file.markerId).length - 1;
      if (occurrences !== 1) errors.push(`${at}.content must contain markerId exactly once`);
    }
  }
  return { markers, paths };
}

export function validateRealClientObservationPlan(value) {
  const errors = [];
  const plan = plainRecord(value, PLAN_KEYS, "$", errors);
  if (plan === undefined) return Object.freeze(errors);
  if (plan.recordKind !== REAL_CLIENT_OBSERVATION_PLAN_KIND) {
    errors.push(`$.recordKind must be ${REAL_CLIENT_OBSERVATION_PLAN_KIND}`);
  }
  if (plan.contractVersion !== REAL_CLIENT_OBSERVATION_CONTRACT_VERSION) {
    errors.push(`$.contractVersion must be ${REAL_CLIENT_OBSERVATION_CONTRACT_VERSION}`);
  }
  if (typeof plan.caseId !== "string" || !IDENTIFIER_PATTERN.test(plan.caseId)) {
    errors.push("$.caseId must be a canonical identifier");
  }
  if (typeof plan.profileId !== "string" || !PROFILE_SURFACES.has(plan.profileId)) {
    errors.push("$.profileId must be a recognized D01 profile");
  }
  const profileSurfaces = PROFILE_SURFACES.get(plan.profileId);
  if (typeof plan.surfaceId !== "string" || !profileSurfaces?.has(plan.surfaceId)) {
    errors.push("$.surfaceId must belong to $.profileId in the D01 inventory");
  }
  if (typeof plan.operation !== "string" || !OPERATIONS.has(plan.operation)) {
    errors.push("$.operation must be version-probe or blocked-paid-observation");
  }
  if (
    typeof plan.observedAt !== "string" ||
    !UTC_SECOND_PATTERN.test(plan.observedAt) ||
    Number.isNaN(Date.parse(plan.observedAt)) ||
    new Date(plan.observedAt).toISOString().replace(".000Z", "Z") !== plan.observedAt
  ) {
    errors.push("$.observedAt must be a valid RFC 3339 UTC timestamp at whole-second precision");
  }
  const fixture = validateFixtureFiles(plan.fixtureFiles, errors);
  const sequence = denseArray(
    plan.expectedLoadedSourceSequence,
    "$.expectedLoadedSourceSequence",
    errors,
    200,
  );
  if (sequence !== undefined) {
    for (const [index, sourcePath] of sequence.entries()) {
      if (!validRelativePath(sourcePath) || !fixture.paths.has(sourcePath)) {
        errors.push(`$.expectedLoadedSourceSequence[${index}] must reference a fixture path`);
      }
    }
  }
  validateCapabilityPolicy(plan.capabilityPolicy, plan.operation, errors);
  validateSettingSources(plan.settingSources, errors);
  validateClient(plan.client, plan.operation, plan.surfaceId, errors);
  validateSupervisor(plan.supervisor, plan.operation, errors);
  return Object.freeze(errors);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function canonicalObservationJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function cloneValidatedPlan(value) {
  const errors = validateRealClientObservationPlan(value);
  if (errors.length > 0) fail("invalid-plan", `observation plan is invalid: ${errors.join("; ")}`);
  const snapshotErrors = [];
  const plan = plainRecord(value, PLAN_KEYS, "$", snapshotErrors);
  const fixtureFiles = denseArray(plan.fixtureFiles, "$.fixtureFiles", snapshotErrors, 200).map(
    (rawFile, index) => {
      const file = plainRecord(rawFile, FILE_KEYS, `$.fixtureFiles[${index}]`, snapshotErrors);
      return { content: file.content, markerId: file.markerId, path: file.path };
    },
  );
  const sequence = denseArray(
    plan.expectedLoadedSourceSequence,
    "$.expectedLoadedSourceSequence",
    snapshotErrors,
    200,
  );
  const settingSources = denseArray(plan.settingSources, "$.settingSources", snapshotErrors, 16);
  const rawPolicy = plainRecord(
    plan.capabilityPolicy,
    CAPABILITY_POLICY_KEYS,
    "$.capabilityPolicy",
    snapshotErrors,
  );
  const allowed = denseArray(
    rawPolicy.allowed,
    "$.capabilityPolicy.allowed",
    snapshotErrors,
    VERSION_ALLOWED_CAPABILITIES.length,
  );
  const denied = denseArray(
    rawPolicy.denied,
    "$.capabilityPolicy.denied",
    snapshotErrors,
    DENIED_CAPABILITIES.length,
  );
  let client = plan.client;
  let supervisor = plan.supervisor;
  if (plan.operation === "version-probe") {
    const rawClient = plainRecord(plan.client, CLIENT_KEYS, "$.client", snapshotErrors);
    client = {
      executablePath: rawClient.executablePath,
      executableSha256: rawClient.executableSha256,
      expectedVersion: rawClient.expectedVersion,
    };
    const rawSupervisor = plainRecord(
      plan.supervisor,
      SUPERVISOR_KEYS,
      "$.supervisor",
      snapshotErrors,
    );
    supervisor = {
      executablePath: rawSupervisor.executablePath,
      executableSha256: rawSupervisor.executableSha256,
      kind: rawSupervisor.kind,
    };
  }
  if (snapshotErrors.length > 0) {
    fail("invalid-plan", "observation plan changed during validation");
  }
  return deepFreeze(
    canonicalize({
      capabilityPolicy: { allowed: [...allowed], denied: [...denied] },
      caseId: plan.caseId,
      client,
      contractVersion: plan.contractVersion,
      expectedLoadedSourceSequence: [...sequence],
      fixtureFiles,
      observedAt: plan.observedAt,
      operation: plan.operation,
      profileId: plan.profileId,
      recordKind: plan.recordKind,
      settingSources: [...settingSources],
      supervisor,
      surfaceId: plan.surfaceId,
    }),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function loadRealClientObservationPlan(filePath) {
  let descriptor;
  let metadata;
  let bytes;
  try {
    metadata = lstatSync(filePath, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
      fail("invalid-plan-file", "observation plan must be a singly linked ordinary file");
    }
    descriptor = openSync(filePath, fsConstants.O_RDONLY);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n ||
      openedBefore.dev !== metadata.dev ||
      openedBefore.ino !== metadata.ino
    ) {
      fail("invalid-plan-file", "observation plan identity changed before it was read");
    }
    if (openedBefore.size > BigInt(REAL_CLIENT_OBSERVATION_MAX_PLAN_BYTES)) {
      fail("invalid-plan-file", "observation plan exceeds 1048576 bytes");
    }
    bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(filePath, { bigint: true });
    if (
      openedAfter.dev !== openedBefore.dev ||
      openedAfter.ino !== openedBefore.ino ||
      openedAfter.size !== openedBefore.size ||
      openedAfter.mtimeNs !== openedBefore.mtimeNs ||
      current.isSymbolicLink() ||
      current.dev !== openedBefore.dev ||
      current.ino !== openedBefore.ino
    ) {
      fail("invalid-plan-file", "observation plan changed while it was read");
    }
  } catch (error) {
    if (error instanceof RealClientObservationError) throw error;
    fail("invalid-plan-file", "observation plan could not be opened");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (bytes.includes(0)) fail("invalid-plan-file", "observation plan contains NUL bytes");
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    fail("invalid-plan-file", "observation plan must not contain a UTF-8 BOM");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-plan-file", "observation plan is not valid UTF-8");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("invalid-plan-file", "observation plan is malformed JSON");
  }
  return cloneValidatedPlan(parsed);
}

function fixtureManifest(plan) {
  return plan.fixtureFiles
    .map((file) => ({
      markerId: file.markerId,
      path: file.path,
      sha256: sha256(Buffer.from(file.content, "utf8")),
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));
}

function snapshotDirectory(root) {
  const entries = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareUtf8(left.name, right.name),
    )) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        fail("workspace-alias", "observation workspace contains a symbolic link");
      const metadata = statSync(absolute, { bigint: true });
      if (entry.isDirectory()) {
        entries.push({
          kind: "directory",
          mode: Number(metadata.mode & 0o777n),
          mtimeNs: metadata.mtimeNs.toString(),
          path: relative,
        });
        visit(absolute, relative);
      } else if (entry.isFile()) {
        entries.push({
          kind: "file",
          mode: Number(metadata.mode & 0o777n),
          mtimeNs: metadata.mtimeNs.toString(),
          path: relative,
          sha256: sha256(readFileSync(absolute)),
          size: metadata.size.toString(),
        });
      } else {
        fail("workspace-type", "observation workspace contains an unsupported entry type");
      }
    }
  };
  visit(root, "");
  return entries;
}

function createWorkspace(plan) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-context-observation-"));
  chmodSync(root, 0o700);
  const directories = {
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    home: path.join(root, "home"),
    probe: path.join(root, "probe"),
    repo: path.join(root, "repo"),
    temp: path.join(root, "tmp"),
  };
  for (const directory of Object.values(directories)) mkdirSync(directory, { mode: 0o700 });
  for (const file of [...plan.fixtureFiles].sort((left, right) =>
    compareUtf8(left.path, right.path),
  )) {
    const destination = path.join(directories.repo, ...file.path.split("/"));
    const relative = path.relative(directories.repo, destination);
    if (relative.startsWith(`..${path.sep}`) || relative === "..")
      fail("workspace-path", "fixture escaped the observation repository");
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  return { directories, root };
}

function verifyExecutable(client) {
  let realPath;
  try {
    realPath = realpathSync(client.executablePath);
    const metadata = statSync(realPath, { bigint: true });
    if (!metadata.isFile() || metadata.nlink < 1n)
      fail("invalid-client", "client executable is not an ordinary file");
  } catch (error) {
    if (error instanceof RealClientObservationError) throw error;
    fail("invalid-client", "client executable could not be verified");
  }
  const descriptor = openSync(realPath, fsConstants.O_RDONLY);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const digest = sha256(readFileSync(descriptor));
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      fail("client-race", "client executable changed during verification");
    }
    if (digest !== client.executableSha256)
      fail("client-digest", "client executable digest does not match the plan");
    return Object.freeze({
      digest,
      identity: `${before.dev.toString()}:${before.ino.toString()}:${before.size.toString()}:${before.mtimeNs.toString()}`,
      realPath,
    });
  } finally {
    closeSync(descriptor);
  }
}

function isolatedEnvironment(directories, executablePath) {
  const runtimeDirectory = path.dirname(process.execPath);
  const clientDirectory = path.dirname(executablePath);
  return Object.freeze({
    CI: "1",
    HOME: directories.home,
    NO_COLOR: "1",
    PATH: [clientDirectory, runtimeDirectory]
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(path.delimiter),
    TEMP: directories.temp,
    TMP: directories.temp,
    TMPDIR: directories.temp,
    XDG_CACHE_HOME: directories.cache,
    XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data,
  });
}

function sandboxLiteral(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function macosVersionSandboxProfile(clientExecutablePath) {
  const client = sandboxLiteral(clientExecutablePath);
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${client}))`,
    "(allow process-info*)",
    "(allow signal (target self))",
    "(allow mach*)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    '(deny file-read* (subpath "/Users") (subpath "/home") (subpath "/Volumes"))',
    "(deny file-write*)",
    "(deny network*)",
  ].join(" ");
}

function boundedVersionProbe({ clientExecutablePath, cwd, env, supervisorExecutablePath }) {
  if (process.platform !== "darwin") {
    fail("supervisor-unavailable", "macos-sandbox-exec-v1 is unavailable on this platform");
  }
  const supervisorProfile = macosVersionSandboxProfile(clientExecutablePath);
  return new Promise((resolve, reject) => {
    const child = spawn(
      supervisorExecutablePath,
      ["-p", supervisorProfile, clientExecutablePath, "--version"],
      {
        cwd,
        detached: false,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;
    const finishFailure = (code, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new RealClientObservationError(code, message));
    };
    const collect = (chunks, streamName) => (chunk) => {
      const bytes = Buffer.from(chunk);
      if (streamName === "stdout") stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (stdoutBytes + stderrBytes > REAL_CLIENT_OBSERVATION_MAX_OUTPUT_BYTES) {
        finishFailure("output-limit", "client output exceeded the observation limit");
        return;
      }
      chunks.push(bytes);
    };
    child.stdout.on("data", collect(stdout, "stdout"));
    child.stderr.on("data", collect(stderr, "stderr"));
    child.once("error", () =>
      finishFailure("client-start", "client version probe could not start"),
    );
    timer = setTimeout(
      () => finishFailure("client-timeout", "client version probe exceeded its deadline"),
      REAL_CLIENT_OBSERVATION_TIMEOUT_MS,
    );
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        Object.freeze({
          exitCode,
          signal: signal ?? null,
          stderr: Buffer.concat(stderr),
          stdout: Buffer.concat(stdout),
        }),
      );
    });
  });
}

function decodeOutput(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "[INVALID_UTF8_REDACTED]";
  }
}

function truncateUtf8(value, maximumBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function redactOutput(raw, plan, workspaceRoot, executablePath) {
  let output = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(ANSI_ESCAPE, "");
  output = output.replaceAll(workspaceRoot, "$OBSERVATION_ROOT");
  output = output.replaceAll(executablePath, "$CLIENT_BINARY");
  for (const file of plan.fixtureFiles) {
    if (file.content !== "") output = output.replaceAll(file.content, "[REDACTED_CONTENT]");
    if (file.markerId !== null) output = output.replaceAll(file.markerId, "[REDACTED_MARKER]");
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, "[REDACTED_SECRET]");
    pattern.lastIndex = 0;
  }
  return truncateUtf8(
    replaceForbiddenControls(
      output.replace(EMAIL, "[REDACTED_ACCOUNT]").replace(USER_PATH, "$USER_HOME"),
    ),
    REAL_CLIENT_OBSERVATION_MAX_OUTPUT_BYTES,
  );
}

export function redactRealClientObservationOutput(raw, rawPlan, workspaceRoot, executablePath) {
  if (typeof raw !== "string") fail("redaction-input", "observation log must be a string");
  const plan = cloneValidatedPlan(rawPlan);
  return redactOutput(raw, plan, workspaceRoot, executablePath);
}

function transcriptBase(plan, planDigest, manifest, fixtureDigest) {
  return {
    actualLoadedSourceSequence: [],
    capabilityPolicy: plan.capabilityPolicy,
    caseId: plan.caseId,
    client: null,
    contractVersion: REAL_CLIENT_OBSERVATION_CONTRACT_VERSION,
    environmentKeys: SAFE_ENVIRONMENT_KEYS,
    expectedLoadedSourceSequence: [...plan.expectedLoadedSourceSequence],
    fixtureDigest,
    fixtureManifest: manifest,
    invocation: null,
    observedAt: plan.observedAt,
    operation: plan.operation,
    planDigest,
    platform: Object.freeze({ architecture: process.arch, operatingSystem: process.platform }),
    profileId: plan.profileId,
    recordKind: REAL_CLIENT_OBSERVATION_TRANSCRIPT_KIND,
    result: null,
    settingSources: [...plan.settingSources],
    supervisor: null,
    surfaceId: plan.surfaceId,
  };
}

function testPattern(pattern, value) {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function assertTranscriptSafe(base) {
  if (base.result === null) fail("transcript-contract", "transcript result is missing");
  const blocked = base.operation === "blocked-paid-observation";
  if (
    blocked !== (base.result.status === "blocked") ||
    blocked !== (base.client === null) ||
    blocked !== (base.invocation === null) ||
    blocked !== (base.supervisor === null) ||
    (blocked &&
      (base.result.exitCode !== null ||
        base.result.signal !== null ||
        base.result.versionMatched !== null ||
        base.result.workspaceUnchanged !== true))
  ) {
    fail("transcript-contract", "transcript operation and result states are inconsistent");
  }
  const fixturePaths = new Set(base.fixtureManifest.map((entry) => entry.path));
  if (
    [...base.actualLoadedSourceSequence, ...base.expectedLoadedSourceSequence].some(
      (sourcePath) => !fixturePaths.has(sourcePath),
    )
  ) {
    fail("transcript-contract", "transcript source sequence escaped its fixture manifest");
  }
  for (const [streamName, value] of [
    ["stdout", base.result.stdout],
    ["stderr", base.result.stderr],
  ]) {
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > REAL_CLIENT_OBSERVATION_MAX_OUTPUT_BYTES ||
      containsSecret(value) ||
      testPattern(EMAIL, value) ||
      testPattern(USER_PATH, value) ||
      base.fixtureManifest.some(
        (entry) => entry.markerId !== null && value.includes(entry.markerId),
      )
    ) {
      fail("transcript-secret", `redacted ${streamName} did not satisfy the storage policy`);
    }
  }
  if (
    Buffer.byteLength(canonicalObservationJson(base), "utf8") >
    REAL_CLIENT_OBSERVATION_MAX_PLAN_BYTES
  ) {
    fail("transcript-limit", "transcript exceeds 1048576 UTF-8 bytes");
  }
}

function finalizeTranscript(base) {
  assertTranscriptSafe(base);
  const transcript = deepFreeze(canonicalize(base));
  ISSUED_TRANSCRIPTS.add(transcript);
  return transcript;
}

function snapshotVerifiedExecutable(value) {
  const errors = [];
  const verified = plainRecord(value, VERIFIED_EXECUTABLE_KEYS, "verified executable", errors);
  if (verified !== undefined) {
    if (typeof verified.digest !== "string" || !SHA256_PATTERN.test(verified.digest)) {
      errors.push("verified executable digest is invalid");
    }
    safeString(verified.identity, "verified executable identity", errors, 512);
    if (
      !safeString(verified.realPath, "verified executable path", errors) ||
      !path.isAbsolute(verified.realPath)
    ) {
      errors.push("verified executable path must be absolute");
    }
  }
  if (errors.length > 0)
    fail("client-verification", "client verification returned invalid evidence");
  return Object.freeze({
    digest: verified.digest,
    identity: verified.identity,
    realPath: verified.realPath,
  });
}

function snapshotSupervisorResult(value) {
  const errors = [];
  const result = plainRecord(value, SUPERVISOR_RESULT_KEYS, "supervisor result", errors);
  if (result !== undefined) {
    if (!Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)) {
      errors.push("supervisor streams must be buffers");
    }
    if (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) {
      errors.push("supervisor exit code must be null or a safe integer");
    }
    if (result.signal !== null && typeof result.signal !== "string") {
      errors.push("supervisor signal must be null or a string");
    }
    if (
      Buffer.isBuffer(result.stdout) &&
      Buffer.isBuffer(result.stderr) &&
      result.stdout.length + result.stderr.length > REAL_CLIENT_OBSERVATION_MAX_OUTPUT_BYTES
    ) {
      errors.push("supervisor output exceeds the observation limit");
    }
  }
  if (errors.length > 0)
    fail("supervisor-result", "observation supervisor returned an invalid result");
  return Object.freeze({
    exitCode: result.exitCode,
    signal: result.signal,
    stderr: Buffer.from(result.stderr),
    stdout: Buffer.from(result.stdout),
  });
}

export async function runRealClientObservation(rawPlan) {
  const plan = cloneValidatedPlan(rawPlan);
  const planDigest = sha256(Buffer.from(canonicalObservationJson(plan), "utf8"));
  const manifest = fixtureManifest(plan);
  const fixtureDigest = sha256(Buffer.from(canonicalObservationJson(manifest), "utf8"));
  const base = transcriptBase(plan, planDigest, manifest, fixtureDigest);
  if (plan.operation === "blocked-paid-observation") {
    base.result = Object.freeze({
      blockedReason: plan.client,
      exitCode: null,
      signal: null,
      status: "blocked",
      stderr: "",
      stdout: "",
      versionMatched: null,
      workspaceUnchanged: true,
    });
    return finalizeTranscript(base);
  }

  if (process.platform !== "darwin") {
    fail("supervisor-unavailable", "macos-sandbox-exec-v1 is unavailable on this platform");
  }
  const verified = snapshotVerifiedExecutable(verifyExecutable(plan.client));
  const verifiedSupervisor = snapshotVerifiedExecutable(verifyExecutable(plan.supervisor));
  const workspace = createWorkspace(plan);
  try {
    const before = snapshotDirectory(workspace.root);
    const environment = isolatedEnvironment(workspace.directories, verified.realPath);
    if (
      JSON.stringify(Object.keys(environment).sort()) !==
      JSON.stringify([...SAFE_ENVIRONMENT_KEYS].sort())
    ) {
      fail("environment-policy", "observation environment deviated from its fixed allowlist");
    }
    const rawResult = snapshotSupervisorResult(
      await boundedVersionProbe({
        arguments: Object.freeze(["--version"]),
        clientExecutablePath: verified.realPath,
        cwd: workspace.directories.probe,
        env: environment,
        stdin: "closed",
        supervisorExecutablePath: verifiedSupervisor.realPath,
      }),
    );
    const verifiedAfter = snapshotVerifiedExecutable(verifyExecutable(plan.client));
    const verifiedSupervisorAfter = snapshotVerifiedExecutable(verifyExecutable(plan.supervisor));
    if (
      verifiedAfter.digest !== verified.digest ||
      verifiedAfter.identity !== verified.identity ||
      verifiedAfter.realPath !== verified.realPath
    ) {
      fail("client-race", "client executable changed during the observation");
    }
    if (
      verifiedSupervisorAfter.digest !== verifiedSupervisor.digest ||
      verifiedSupervisorAfter.identity !== verifiedSupervisor.identity ||
      verifiedSupervisorAfter.realPath !== verifiedSupervisor.realPath
    ) {
      fail("supervisor-race", "sandbox supervisor changed during the observation");
    }
    const after = snapshotDirectory(workspace.root);
    const workspaceUnchanged = canonicalObservationJson(before) === canonicalObservationJson(after);
    const rawStdout = decodeOutput(rawResult.stdout);
    const rawStderr = decodeOutput(rawResult.stderr);
    const combined = `${rawStdout}\n${rawStderr}`;
    base.actualLoadedSourceSequence = [];
    base.client = Object.freeze({
      executableIdentitySha256: sha256(Buffer.from(verified.identity, "utf8")),
      executableSha256: verified.digest,
      expectedVersion: plan.client.expectedVersion,
    });
    base.invocation = Object.freeze({
      adapterId: "macos-sandboxed-literal-double-dash-version-v1",
      arguments: Object.freeze(["--version"]),
      shell: false,
      stdin: "closed",
    });
    base.supervisor = Object.freeze({
      executableIdentitySha256: sha256(Buffer.from(verifiedSupervisor.identity, "utf8")),
      executableSha256: verifiedSupervisor.digest,
      kind: plan.supervisor.kind,
    });
    const versionMatched = combined.includes(plan.client.expectedVersion);
    base.result = Object.freeze({
      blockedReason: null,
      exitCode: rawResult.exitCode,
      signal: rawResult.signal,
      status:
        rawResult.exitCode === 0 &&
        rawResult.signal === null &&
        versionMatched &&
        workspaceUnchanged
          ? "observed"
          : "failed",
      stderr: redactOutput(rawStderr, plan, workspace.root, verified.realPath),
      stdout: redactOutput(rawStdout, plan, workspace.root, verified.realPath),
      versionMatched,
      workspaceUnchanged,
    });
    return finalizeTranscript(base);
  } finally {
    rmSync(workspace.root, { force: true, recursive: true });
  }
}

export function writeRealClientObservationTranscript(outputPath, transcript) {
  if (!ISSUED_TRANSCRIPTS.has(transcript)) {
    fail("untrusted-transcript", "only a transcript issued by this harness can be written");
  }
  const absolute = path.resolve(outputPath);
  const parent = path.dirname(absolute);
  let realParent;
  try {
    const metadata = lstatSync(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail("output-parent", "transcript parent must be an ordinary directory");
    realParent = realpathSync(parent);
  } catch (error) {
    if (error instanceof RealClientObservationError) throw error;
    fail("output-parent", "transcript parent could not be verified");
  }
  if (realParent !== parent) fail("output-parent", "transcript parent must not traverse aliases");
  const temporary = path.join(
    parent,
    `.${path.basename(absolute)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor;
  let linked = false;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    const bytes = Buffer.from(canonicalObservationJson(transcript), "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) fail("output-write", "transcript write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    chmodSync(temporary, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, absolute);
    linked = true;
    unlinkSync(temporary);
    const parentDescriptor = openSync(parent, fsConstants.O_RDONLY);
    try {
      try {
        fsyncSync(parentDescriptor);
      } catch (error) {
        if (!new Set(["EINVAL", "ENOTSUP", "EBADF"]).has(error?.code)) throw error;
      }
    } finally {
      closeSync(parentDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (linked) {
      try {
        unlinkSync(absolute);
      } catch {
        // The caller still receives a failure; never overwrite an existing path on retry.
      }
    }
    rmSync(temporary, { force: true });
    if (error instanceof RealClientObservationError) throw error;
    if (error?.code === "EEXIST") fail("output-exists", "transcript output already exists");
    fail("output-write", "transcript could not be written atomically");
  }
}

async function main(argv) {
  const [command, planPath, outputPath, acknowledgement, ...extra] = argv;
  if (extra.length > 0 || !new Set(["run", "validate"]).has(command)) {
    fail(
      "usage",
      "usage: real-client-observation.mjs validate <plan> | run <plan> <new-output> --acknowledge-client-execution",
    );
  }
  const plan = loadRealClientObservationPlan(planPath);
  if (command === "validate") {
    if (outputPath !== undefined || acknowledgement !== undefined)
      fail("usage", "validate accepts exactly one plan path");
    process.stdout.write(`valid ${plan.caseId}\n`);
    return;
  }
  if (outputPath === undefined || acknowledgement !== "--acknowledge-client-execution") {
    fail(
      "acknowledgement",
      "run requires a new output path and explicit execution acknowledgement",
    );
  }
  const transcript = await runRealClientObservation(plan);
  writeRealClientObservationTranscript(outputPath, transcript);
  process.stdout.write(`recorded ${transcript.caseId} ${transcript.result.status}\n`);
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const message =
      error instanceof RealClientObservationError ? error.message : "observation harness failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
