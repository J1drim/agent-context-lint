#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MONITOR_FORMAT = "agent-context-release-monitoring-v1";
const RETROSPECTIVE_FORMAT = "agent-context-release-retrospective-v1";
const MONITOR_SCHEMA =
  "https://agent-context.invalid/schemas/release-monitoring-report.v1.schema.json";
const RETROSPECTIVE_SCHEMA =
  "https://agent-context.invalid/schemas/release-retrospective-report.v1.schema.json";
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_CHECKS = 32;
const MAX_SIGNALS = 64;
const MAX_METRICS = 128;
const MAX_INCIDENTS = 128;
const MAX_DECISIONS = 128;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_COUNT = 1_000_000_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// eslint-disable-next-line no-control-regex -- owner labels reject terminal controls.
const OWNER_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const SECRET_PATTERN =
  /(?:-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----|(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+)/iu;
// eslint-disable-next-line no-control-regex -- report evidence must not contain terminal controls.
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const MONITOR_CHECK_IDS = Object.freeze(["install", "registry", "docs", "action", "rollback"]);
const MONITOR_CHECK_KINDS = new Set([
  "package-install",
  "registry",
  "docs",
  "action",
  "cli",
  "rollback",
]);
const CHECK_STATUSES = new Set(["pass", "fail", "unknown"]);
const SIGNAL_STATES = new Set(["clear", "triggered", "unknown"]);
const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

const compareUtf8 = (left, right) =>
  Math.sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));

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

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(`release evidence: ${message}`);
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

function assertString(value, label, maximum = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    fail(`${label} must be a non-empty string of at most ${maximum} characters`);
  if (value.includes("\0")) fail(`${label} contains a NUL`);
  return value;
}

function assertId(value, label) {
  const id = assertString(value, label, 128);
  if (!ID_PATTERN.test(id)) fail(`${label} has an unsafe identifier`);
  return id;
}

function assertOwner(value, label) {
  const owner = assertString(value, label, 128);
  if (!OWNER_PATTERN.test(owner)) fail(`${label} contains a control character`);
  return owner;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value))
    fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function assertVersion(value, label) {
  const version = assertString(value, label, 64);
  if (!VERSION_PATTERN.test(version)) fail(`${label} must be a SemVer value`);
  return version;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const [core, prerelease = ""] = value.split("-");
    const numbers = core.split(".").map(Number);
    return { numbers, prerelease: prerelease === "" ? [] : prerelease.split(".") };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/u.test(av);
    const bn = /^\d+$/u.test(bv);
    if (an && bn) return Number(av) > Number(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return compareUtf8(av, bv);
  }
  return 0;
}

function assertTimestamp(value, label) {
  const timestamp = assertString(value, label, 32);
  if (!UTC_PATTERN.test(timestamp) || Number.isNaN(Date.parse(timestamp)))
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  return timestamp;
}

function assertInteger(value, label, minimum = 0, maximum = MAX_COUNT) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function assertEnum(value, values, label) {
  if (typeof value !== "string" || !values.has(value)) fail(`${label} is invalid`);
  return value;
}

function redactText(value, label) {
  const text = assertString(value, label, MAX_TEXT_BYTES);
  if (CONTROL_PATTERN.test(text)) fail(`${label} contains a disallowed control character`);
  if (SECRET_PATTERN.test(text)) fail(`${label} appears to contain a credential or private key`);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_TEXT_BYTES) fail(`${label} exceeds the byte limit`);
  return Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) });
}

function redactEvidence(value, label) {
  const evidence = assertObject(value, label);
  assertExactKeys(evidence, ["text", "bytes", "sha256"], label);
  const hasText = evidence.text !== undefined;
  const hasDigest = evidence.bytes !== undefined || evidence.sha256 !== undefined;
  if (hasText && hasDigest) fail(`${label} must provide text or a digest, not both`);
  if (hasText) return redactText(evidence.text, `${label}.text`);
  if (!hasDigest || evidence.bytes === undefined || evidence.sha256 === undefined)
    fail(`${label} must provide text or bytes plus sha256`);
  return Object.freeze({
    bytes: assertInteger(evidence.bytes, `${label}.bytes`, 0, MAX_TEXT_BYTES),
    sha256: assertDigest(evidence.sha256, `${label}.sha256`),
  });
}

function optionalEvidence(value, label) {
  return value === undefined ? undefined : redactEvidence(value, label);
}

function ensureUnique(ids, label) {
  if (new Set(ids).size !== ids.length) fail(`${label} contains duplicate identifiers`);
}

function parseMonitorRelease(value) {
  const release = assertObject(value, "release");
  assertExactKeys(
    release,
    ["version", "artifactSha256", "previousVersion", "previousArtifactSha256"],
    "release",
  );
  const normalized = {
    version: assertVersion(required(release.version, "release.version"), "release.version"),
    artifactSha256: assertDigest(
      required(release.artifactSha256, "release.artifactSha256"),
      "release.artifactSha256",
    ),
    previousVersion: assertVersion(
      required(release.previousVersion, "release.previousVersion"),
      "release.previousVersion",
    ),
    previousArtifactSha256: assertDigest(
      required(release.previousArtifactSha256, "release.previousArtifactSha256"),
      "release.previousArtifactSha256",
    ),
  };
  if (normalized.artifactSha256 === normalized.previousArtifactSha256)
    fail("release artifacts must have distinct digests");
  if (compareVersions(normalized.version, normalized.previousVersion) <= 0)
    fail("release.version must be newer than release.previousVersion");
  return Object.freeze(normalized);
}

function normalizeMonitorCheck(value, index) {
  const label = `checks[${index}]`;
  const check = assertObject(value, label);
  assertExactKeys(
    check,
    ["id", "kind", "status", "durationMs", "stdout", "stderr", "evidence"],
    label,
  );
  const id = assertId(required(check.id, `${label}.id`), `${label}.id`);
  const kind = assertEnum(
    required(check.kind, `${label}.kind`),
    MONITOR_CHECK_KINDS,
    `${label}.kind`,
  );
  const status = assertEnum(
    required(check.status, `${label}.status`),
    CHECK_STATUSES,
    `${label}.status`,
  );
  const normalized = {
    id,
    kind,
    status,
    durationMs: assertInteger(
      required(check.durationMs, `${label}.durationMs`),
      `${label}.durationMs`,
      0,
      300_000,
    ),
    stdout: optionalEvidence(check.stdout, `${label}.stdout`),
    stderr: optionalEvidence(check.stderr, `${label}.stderr`),
    evidence: optionalEvidence(check.evidence, `${label}.evidence`),
  };
  if (status === "pass" && normalized.stderr !== undefined && normalized.stderr.bytes > 0)
    fail(`${label} cannot mark a check with stderr as pass`);
  if (status === "fail" && normalized.evidence === undefined)
    fail(`${label}.evidence is required for a failed check`);
  if (status === "unknown" && normalized.evidence === undefined)
    fail(`${label}.evidence is required for an unknown check`);
  return Object.freeze(normalized);
}

function normalizeMonitorSignal(value, index) {
  const label = `signals[${index}]`;
  const signal = assertObject(value, label);
  assertExactKeys(signal, ["id", "severity", "state", "count", "evidence"], label);
  const normalized = {
    id: assertId(required(signal.id, `${label}.id`), `${label}.id`),
    severity: assertEnum(
      required(signal.severity, `${label}.severity`),
      SEVERITIES,
      `${label}.severity`,
    ),
    state: assertEnum(required(signal.state, `${label}.state`), SIGNAL_STATES, `${label}.state`),
    count: assertInteger(required(signal.count, `${label}.count`), `${label}.count`, 0),
    evidence: optionalEvidence(signal.evidence, `${label}.evidence`),
  };
  if (normalized.state !== "clear" && normalized.evidence === undefined)
    fail(`${label}.evidence is required when a signal is not clear`);
  if (normalized.state === "clear" && normalized.count !== 0)
    fail(`${label}.count must be zero for a clear signal`);
  if (normalized.state === "triggered" && normalized.count === 0)
    fail(`${label}.count must be positive for a triggered signal`);
  return Object.freeze(normalized);
}

function normalizeRollback(value) {
  const rollback = assertObject(value, "rollback");
  assertExactKeys(rollback, ["status", "evidence"], "rollback");
  const status = assertEnum(
    required(rollback.status, "rollback.status"),
    new Set(["verified", "failed", "not-tested", "unknown"]),
    "rollback.status",
  );
  const evidence = optionalEvidence(rollback.evidence, "rollback.evidence");
  if (status === "verified" && evidence === undefined)
    fail("rollback.evidence is required when rollback is verified");
  if ((status === "failed" || status === "unknown") && evidence === undefined)
    fail("rollback.evidence is required when rollback is not verified");
  return Object.freeze({ status, evidence });
}

function normalizePolicy(value, label = "policy") {
  const policy = assertObject(value, label);
  assertExactKeys(policy, ["networkAccess", "credentials", "repositoryMutation"], label);
  const normalized = {
    networkAccess: assertEnum(
      required(policy.networkAccess, `${label}.networkAccess`),
      new Set(["not-used"]),
      `${label}.networkAccess`,
    ),
    credentials: assertEnum(
      required(policy.credentials, `${label}.credentials`),
      new Set(["none"]),
      `${label}.credentials`,
    ),
    repositoryMutation: assertEnum(
      required(policy.repositoryMutation, `${label}.repositoryMutation`),
      new Set(["not-observed"]),
      `${label}.repositoryMutation`,
    ),
  };
  return Object.freeze(normalized);
}

function digestReport(report, field) {
  const withoutDigest = { ...report };
  delete withoutDigest[field];
  return sha256(Buffer.from(canonicalJson(withoutDigest), "utf8"));
}

function materialize(report) {
  return Object.freeze(JSON.parse(canonicalJson(report)));
}

export function createMonitoringReport(input) {
  const value = assertObject(input, "monitoring input");
  assertExactKeys(
    value,
    ["schemaVersion", "mode", "observedAt", "release", "checks", "signals", "rollback", "policy"],
    "monitoring input",
  );
  if (value.schemaVersion !== 1) fail("monitoring input.schemaVersion must be 1");
  if (value.mode !== "offline-local") fail("monitoring input.mode must be offline-local");
  const checksValue = required(value.checks, "checks");
  if (!Array.isArray(checksValue) || checksValue.length === 0 || checksValue.length > MAX_CHECKS)
    fail(`checks must contain 1-${MAX_CHECKS} records`);
  const checks = checksValue.map(normalizeMonitorCheck);
  ensureUnique(
    checks.map(({ id }) => id),
    "checks",
  );
  for (const requiredId of MONITOR_CHECK_IDS) {
    if (!checks.some(({ id }) => id === requiredId)) fail(`checks must include ${requiredId}`);
  }
  const signalsValue = required(value.signals, "signals");
  if (!Array.isArray(signalsValue) || signalsValue.length > MAX_SIGNALS)
    fail(`signals must contain at most ${MAX_SIGNALS} records`);
  const signals = signalsValue.map(normalizeMonitorSignal);
  ensureUnique(
    signals.map(({ id }) => id),
    "signals",
  );
  const rollback = normalizeRollback(required(value.rollback, "rollback"));
  const policy = normalizePolicy(required(value.policy, "policy"));
  const report = {
    $schema: MONITOR_SCHEMA,
    artifactFormat: MONITOR_FORMAT,
    schemaVersion: 1,
    mode: "offline-local",
    assessment: "pending-external",
    observedAt: assertTimestamp(required(value.observedAt, "observedAt"), "observedAt"),
    release: parseMonitorRelease(required(value.release, "release")),
    checks,
    signals,
    rollback,
    policy: {
      ...policy,
      publicationVerification: "pending-external",
      monitoringDuration: "not-established",
    },
    limits: {
      maxInputBytes: MAX_INPUT_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxChecks: MAX_CHECKS,
      maxSignals: MAX_SIGNALS,
      maxTextBytes: MAX_TEXT_BYTES,
    },
  };
  const blocking =
    checks.some(({ status }) => status === "fail") ||
    signals.some(
      ({ severity, state }) => (severity === "P0" || severity === "P1") && state === "triggered",
    ) ||
    rollback.status === "failed";
  const incomplete =
    checks.some(({ status }) => status === "unknown") ||
    signals.some(({ state }) => state === "unknown") ||
    rollback.status === "not-tested" ||
    rollback.status === "unknown";
  report.assessment = blocking ? "blocked" : incomplete ? "pending-external" : "preflight-ready";
  report.reportSha256 = digestReport(report, "reportSha256");
  return materialize(report);
}

function normalizePeriod(value, label, minimumHours) {
  const period = assertObject(value, label);
  assertExactKeys(period, ["status", "observedAt", "notes"], label);
  const status = assertEnum(
    required(period.status, `${label}.status`),
    new Set(["pending", "complete"]),
    `${label}.status`,
  );
  const observedAt =
    period.observedAt === undefined
      ? undefined
      : assertTimestamp(period.observedAt, `${label}.observedAt`);
  if (status === "complete" && observedAt === undefined)
    fail(`${label}.observedAt is required when complete`);
  if (status === "pending" && observedAt !== undefined)
    fail(`${label}.observedAt must be omitted while pending`);
  return Object.freeze({
    status,
    observedAt,
    notes: optionalEvidence(period.notes, `${label}.notes`),
    minimumHours,
  });
}

function parseRetrospectiveRelease(value) {
  const release = assertObject(value, "release");
  assertExactKeys(release, ["version", "artifactSha256"], "release");
  return Object.freeze({
    version: assertVersion(required(release.version, "release.version"), "release.version"),
    artifactSha256: assertDigest(
      required(release.artifactSha256, "release.artifactSha256"),
      "release.artifactSha256",
    ),
  });
}

function normalizeMetric(value, index) {
  const label = `metrics[${index}]`;
  const metric = assertObject(value, label);
  assertExactKeys(metric, ["id", "value", "unit", "denominator", "evidence"], label);
  const unit = assertEnum(
    required(metric.unit, `${label}.unit`),
    new Set(["count", "milliseconds", "ratio", "percent"]),
    `${label}.unit`,
  );
  const normalized = {
    id: assertId(required(metric.id, `${label}.id`), `${label}.id`),
    value:
      typeof metric.value === "number" && Number.isFinite(metric.value)
        ? metric.value
        : fail(`${label}.value must be finite`),
    unit,
    denominator:
      metric.denominator === undefined
        ? undefined
        : assertInteger(metric.denominator, `${label}.denominator`, 1),
    evidence: optionalEvidence(metric.evidence, `${label}.evidence`),
  };
  if (unit === "count" || unit === "milliseconds") {
    if (
      !Number.isSafeInteger(normalized.value) ||
      normalized.value < 0 ||
      normalized.value > MAX_COUNT
    )
      fail(`${label}.value must be a bounded non-negative integer`);
    if (normalized.denominator !== undefined)
      fail(`${label}.denominator is not allowed for ${unit}`);
  }
  if (
    unit === "ratio" &&
    (normalized.value < 0 || normalized.value > 1 || normalized.denominator === undefined)
  )
    fail(`${label} ratio must be between 0 and 1 and include denominator`);
  if (
    unit === "percent" &&
    (normalized.value < 0 || normalized.value > 100 || normalized.denominator === undefined)
  )
    fail(`${label} percent must be between 0 and 100 and include denominator`);
  if (normalized.evidence === undefined) fail(`${label}.evidence is required`);
  return Object.freeze(normalized);
}

function normalizeIncident(value, index) {
  const label = `incidents[${index}]`;
  const incident = assertObject(value, label);
  assertExactKeys(
    incident,
    ["id", "severity", "status", "owner", "dueDate", "summary", "impact", "remediation"],
    label,
  );
  const status = assertEnum(
    required(incident.status, `${label}.status`),
    new Set(["open", "closed"]),
    `${label}.status`,
  );
  const normalized = {
    id: assertId(required(incident.id, `${label}.id`), `${label}.id`),
    severity: assertEnum(
      required(incident.severity, `${label}.severity`),
      SEVERITIES,
      `${label}.severity`,
    ),
    status,
    owner: assertOwner(required(incident.owner, `${label}.owner`), `${label}.owner`),
    dueDate: assertString(required(incident.dueDate, `${label}.dueDate`), `${label}.dueDate`, 10),
    summary: redactEvidence(required(incident.summary, `${label}.summary`), `${label}.summary`),
    impact: redactEvidence(required(incident.impact, `${label}.impact`), `${label}.impact`),
    remediation: optionalEvidence(incident.remediation, `${label}.remediation`),
  };
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(normalized.dueDate) ||
    Number.isNaN(Date.parse(`${normalized.dueDate}T00:00:00Z`))
  )
    fail(`${label}.dueDate must be YYYY-MM-DD`);
  if ((normalized.severity === "P0" || normalized.severity === "P1") && status === "open") {
    if (normalized.remediation === undefined)
      fail(`${label}.remediation is required for an open P0/P1 incident`);
  }
  if (status === "closed" && normalized.remediation === undefined)
    fail(`${label}.remediation is required for a closed incident`);
  return Object.freeze(normalized);
}

function normalizeDecision(value, index) {
  const label = `decisions[${index}]`;
  const decision = assertObject(value, label);
  assertExactKeys(decision, ["id", "disposition", "owner", "dueDate", "rationale"], label);
  const normalized = {
    id: assertId(required(decision.id, `${label}.id`), `${label}.id`),
    disposition: assertEnum(
      required(decision.disposition, `${label}.disposition`),
      new Set(["keep", "change", "defer"]),
      `${label}.disposition`,
    ),
    owner: assertOwner(required(decision.owner, `${label}.owner`), `${label}.owner`),
    dueDate: assertString(required(decision.dueDate, `${label}.dueDate`), `${label}.dueDate`, 10),
    rationale: redactEvidence(
      required(decision.rationale, `${label}.rationale`),
      `${label}.rationale`,
    ),
  };
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(normalized.dueDate) ||
    Number.isNaN(Date.parse(`${normalized.dueDate}T00:00:00Z`))
  )
    fail(`${label}.dueDate must be YYYY-MM-DD`);
  return Object.freeze(normalized);
}

export function createRetrospectiveReport(input) {
  const value = assertObject(input, "retrospective input");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "mode",
      "release",
      "releaseAt",
      "review72h",
      "retrospective30d",
      "metrics",
      "incidents",
      "falsePositives",
      "decisions",
      "policy",
    ],
    "retrospective input",
  );
  if (value.schemaVersion !== 1) fail("retrospective input.schemaVersion must be 1");
  if (value.mode !== "offline-local") fail("retrospective input.mode must be offline-local");
  const releaseAt = assertTimestamp(required(value.releaseAt, "releaseAt"), "releaseAt");
  const releaseTime = Date.parse(releaseAt);
  const review72h = normalizePeriod(required(value.review72h, "review72h"), "review72h", 72);
  const retrospective30d = normalizePeriod(
    required(value.retrospective30d, "retrospective30d"),
    "retrospective30d",
    720,
  );
  if (
    review72h.observedAt !== undefined &&
    Date.parse(review72h.observedAt) - releaseTime < 72 * 60 * 60 * 1000
  )
    fail("review72h.observedAt must be at least 72 hours after releaseAt");
  if (
    retrospective30d.observedAt !== undefined &&
    Date.parse(retrospective30d.observedAt) - releaseTime < 30 * 24 * 60 * 60 * 1000
  )
    fail("retrospective30d.observedAt must be at least 30 days after releaseAt");
  const metricsValue = required(value.metrics, "metrics");
  if (
    !Array.isArray(metricsValue) ||
    metricsValue.length === 0 ||
    metricsValue.length > MAX_METRICS
  )
    fail(`metrics must contain 1-${MAX_METRICS} records`);
  const metrics = metricsValue.map(normalizeMetric);
  ensureUnique(
    metrics.map(({ id }) => id),
    "metrics",
  );
  const incidentsValue = required(value.incidents, "incidents");
  if (!Array.isArray(incidentsValue) || incidentsValue.length > MAX_INCIDENTS)
    fail(`incidents must contain at most ${MAX_INCIDENTS} records`);
  const incidents = incidentsValue.map(normalizeIncident);
  ensureUnique(
    incidents.map(({ id }) => id),
    "incidents",
  );
  const falsePositives = assertObject(
    required(value.falsePositives, "falsePositives"),
    "falsePositives",
  );
  assertExactKeys(
    falsePositives,
    ["diagnosticsReviewed", "confirmedFalsePositives", "escapedFindings", "evidence"],
    "falsePositives",
  );
  const normalizedFalsePositives = {
    diagnosticsReviewed: assertInteger(
      required(falsePositives.diagnosticsReviewed, "falsePositives.diagnosticsReviewed"),
    ),
    confirmedFalsePositives: assertInteger(
      required(falsePositives.confirmedFalsePositives, "falsePositives.confirmedFalsePositives"),
    ),
    escapedFindings: assertInteger(
      required(falsePositives.escapedFindings, "falsePositives.escapedFindings"),
    ),
    evidence: redactEvidence(
      required(falsePositives.evidence, "falsePositives.evidence"),
      "falsePositives.evidence",
    ),
  };
  if (
    normalizedFalsePositives.confirmedFalsePositives > normalizedFalsePositives.diagnosticsReviewed
  )
    fail("falsePositives.confirmedFalsePositives cannot exceed diagnosticsReviewed");
  const decisionsValue = required(value.decisions, "decisions");
  if (
    !Array.isArray(decisionsValue) ||
    decisionsValue.length === 0 ||
    decisionsValue.length > MAX_DECISIONS
  )
    fail(`decisions must contain 1-${MAX_DECISIONS} records`);
  const decisions = decisionsValue.map(normalizeDecision);
  ensureUnique(
    decisions.map(({ id }) => id),
    "decisions",
  );
  const policy = normalizePolicy(required(value.policy, "policy"));
  const report = {
    $schema: RETROSPECTIVE_SCHEMA,
    artifactFormat: RETROSPECTIVE_FORMAT,
    schemaVersion: 1,
    mode: "offline-local",
    assessment: "pending-external",
    release: parseRetrospectiveRelease(required(value.release, "release")),
    releaseAt,
    review72h,
    retrospective30d,
    metrics,
    incidents,
    falsePositives: normalizedFalsePositives,
    decisions,
    policy: {
      ...policy,
      publicationVerification: "pending-external",
      humanReview: "required",
    },
    limits: {
      maxInputBytes: MAX_INPUT_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxMetrics: MAX_METRICS,
      maxIncidents: MAX_INCIDENTS,
      maxDecisions: MAX_DECISIONS,
      maxTextBytes: MAX_TEXT_BYTES,
    },
  };
  const blocking = incidents.some(
    ({ severity, status }) => (severity === "P0" || severity === "P1") && status === "open",
  );
  const incomplete = review72h.status !== "complete" || retrospective30d.status !== "complete";
  report.assessment = blocking
    ? "blocked"
    : incomplete
      ? "pending-external"
      : "ready-for-human-review";
  report.reportSha256 = digestReport(report, "reportSha256");
  return materialize(report);
}

function validateAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0"))
    fail(`${label} must be an absolute path`);
  return value;
}

export function parseEvidenceArguments(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["monitor", "retrospective"]).has(command))
    fail("usage: release-evidence.mjs monitor|retrospective --input FILE --output FILE");
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    const value = rest[index + 1];
    if (
      !option?.startsWith("--") ||
      values.has(option) ||
      value === undefined ||
      value.startsWith("--")
    )
      fail("options are duplicated or malformed");
    values.set(option, value);
    index += 1;
  }
  for (const option of values.keys())
    if (!["--input", "--output"].includes(option)) fail(`unknown option ${option}`);
  const input = validateAbsolutePath(required(values.get("--input"), "--input"), "input");
  const output = validateAbsolutePath(required(values.get("--output"), "--output"), "output");
  if (input === output) fail("input and output must be different files");
  return Object.freeze({ command, input, output });
}

async function readJson(filename, label) {
  const info = await lstat(filename, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") fail(`${label} does not exist`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  if (info.size > BigInt(MAX_INPUT_BYTES)) fail(`${label} exceeds ${MAX_INPUT_BYTES} bytes`);
  let value;
  try {
    const bytes = await readFile(filename);
    const after = await lstat(filename, { bigint: true });
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.size !== BigInt(bytes.byteLength)
    )
      fail(`${label} changed while it was read`);
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return value;
}

async function writeReport(filename, report) {
  const parent = path.dirname(filename);
  const parentInfo = await lstat(parent).catch(() => undefined);
  if (parentInfo === undefined || !parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    fail("output parent must be a regular directory");
  const bytes = Buffer.from(canonicalJson(report), "utf8");
  if (bytes.byteLength > MAX_OUTPUT_BYTES) fail(`report exceeds ${MAX_OUTPUT_BYTES} bytes`);
  await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseEvidenceArguments(argv);
  const input = await readJson(options.input, "input");
  const report =
    options.command === "monitor"
      ? createMonitoringReport(input)
      : createRetrospectiveReport(input);
  await writeReport(options.output, report);
  process.stdout.write(
    `${JSON.stringify({ assessment: report.assessment, report: options.output })}\n`,
  );
  return report.assessment === "blocked" ? 1 : report.assessment === "pending-external" ? 2 : 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "release evidence failed"}\n`);
    process.exitCode = 2;
  }
}

export const RELEASE_EVIDENCE_LIMITS = Object.freeze({
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_CHECKS,
  MAX_SIGNALS,
  MAX_METRICS,
  MAX_INCIDENTS,
  MAX_DECISIONS,
  MAX_TEXT_BYTES,
});
