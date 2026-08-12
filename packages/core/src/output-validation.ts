import { types as nodeTypes } from "node:util";

import {
  MAX_VALIDATION_ISSUES,
  ValidationIssueLimitReached,
  validateJsonValue,
} from "./contract-validation.js";
import {
  DIAGNOSTIC_CONTRACT_VERSION,
  DIAGNOSTIC_SEVERITIES,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
} from "./diagnostic-contracts.js";
import { validateDiagnosticBundle } from "./diagnostic-validation.js";
import {
  BASELINE_OUTPUT_SCHEMA_VERSION,
  EFFICIENCY_OUTPUT_SCHEMA_VERSION,
  JSON_OUTPUT_SCHEMA_VERSION,
  OUTPUT_RECORD_KINDS,
  SARIF_OUTPUT_LEGACY_SCHEMA_VERSION,
  SARIF_OUTPUT_SCHEMA_VERSION,
  SARIF_SCHEMA_URI,
  SARIF_VERSION,
  STANDARDS_OUTPUT_SCHEMA_VERSION,
  TERMINAL_OUTPUT_SCHEMA_VERSION,
} from "./output-contracts.js";
import { isRepositoryRelativePath } from "./repository-path.js";
import {
  decodeSarifArtifactUri,
  sanitizeOutputJson,
  sanitizeOutputText,
} from "./output-sanitization.js";

import type { JsonValidationLimits } from "./contract-validation.js";
import type { SourceDocument } from "./ir-contracts.js";
import type {
  BaselineOutput,
  EfficiencyOutput,
  NativeOutputDocument,
  OutputCompatibilityResult,
  OutputSerializationResult,
  OutputValidationCode,
  OutputValidationIssue,
  OutputValidationResult,
  SarifOutput,
  SarifOutputV1,
  SarifV1MigrationResult,
  ScanJsonOutput,
  StandardsOutput,
  TerminalOutput,
} from "./output-contracts.js";

type UnknownRecord = Record<string, unknown>;

export const MAX_OUTPUT_CONTAINER_ENTRIES = 100_000 as const;
export const MAX_OUTPUT_KEY_BYTES = 1_024 as const;
export const MAX_OUTPUT_STRING_BYTES = 1_048_576 as const;
export const MAX_OUTPUT_TOTAL_STRING_BYTES = 67_108_864 as const;
export const MAX_OUTPUT_VALUES = 1_000_000 as const;
export const MAX_OUTPUT_TEXT_BYTES = 16_384 as const;
export const MAX_OUTPUT_TEXT_CODE_POINTS = 4_096 as const;
export const MAX_TERMINAL_LINES = 100_000 as const;
export const MAX_EFFICIENCY_RECOMMENDATIONS = 10_000 as const;
export const MAX_BASELINE_ENTRIES = 100_000 as const;
export const MAX_SARIF_RESULTS = 10_000 as const;
export const MAX_SARIF_RULES = 10_000 as const;
export const MAX_SARIF_RELATED_LOCATIONS = 128 as const;

const LIMITS: JsonValidationLimits = {
  maximumContainerEntries: MAX_OUTPUT_CONTAINER_ENTRIES,
  maximumKeyBytes: MAX_OUTPUT_KEY_BYTES,
  maximumStringBytes: MAX_OUTPUT_STRING_BYTES,
  maximumTotalStringBytes: MAX_OUTPUT_TOTAL_STRING_BYTES,
  maximumValues: MAX_OUTPUT_VALUES,
};
const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GITHUB_LINE_HASH = /^[a-f0-9]+:[1-9]\d*$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OUTPUT_KIND_SET: ReadonlySet<string> = new Set(OUTPUT_RECORD_KINDS);

interface Context {
  readonly issues: OutputValidationIssue[];
}

interface ValidatedSummary {
  readonly errors: number;
  readonly exitCode: number;
  readonly infos: number;
  readonly suppressed: number;
  readonly warnings: number;
}

function issue(context: Context, code: OutputValidationCode, path: string, message: string): void {
  if (context.issues.length >= MAX_VALIDATION_ISSUES - 1) {
    if (context.issues.length === MAX_VALIDATION_ISSUES - 1) {
      context.issues.push({
        code: "resource-limit",
        path: "$",
        message: `validation stopped after ${String(MAX_VALIDATION_ISSUES - 1)} issues`,
      });
    }
    throw new ValidationIssueLimitReached();
  }
  context.issues.push({ code, path, message });
}

function object(
  value: unknown,
  path: string,
  keys: readonly string[],
  context: Context,
): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issue(context, "invalid-value", path, "must be an object");
    return undefined;
  }
  const record = value as UnknownRecord;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      issue(context, "unknown-field", `${path}.${key}`, "is not part of this schema version");
  }
  return record;
}

function string(
  record: UnknownRecord,
  key: string,
  path: string,
  context: Context,
  options: { readonly empty?: boolean; readonly pattern?: RegExp } = {},
): string | undefined {
  const value = record[key];
  const fieldPath = `${path}.${key}`;
  if (value === undefined) {
    issue(context, "missing-field", fieldPath, "is required");
    return undefined;
  }
  if (
    typeof value !== "string" ||
    (options.empty !== true && value.length === 0) ||
    Array.from(value).length > MAX_OUTPUT_TEXT_CODE_POINTS ||
    Buffer.byteLength(value, "utf8") > MAX_OUTPUT_TEXT_BYTES ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    issue(context, "invalid-value", fieldPath, "is not a valid bounded string");
    return undefined;
  }
  return value;
}

function isCanonicalDateTime(value: string): boolean {
  if (!DATE_TIME.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isCredentialFreeHttpsUri(value: string): boolean {
  if (!/^[\x21-\x7e]+$/u.test(value) || value.includes("\\") || /%(?![0-9A-Fa-f]{2})/u.test(value))
    return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function enumString(
  record: UnknownRecord,
  key: string,
  path: string,
  values: readonly string[],
  context: Context,
): string | undefined {
  const value = string(record, key, path, context);
  if (value !== undefined && !values.includes(value)) {
    issue(context, "invalid-state", `${path}.${key}`, `must be one of ${values.join(", ")}`);
    return undefined;
  }
  return value;
}

function integer(
  record: UnknownRecord,
  key: string,
  path: string,
  context: Context,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    issue(context, "missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    issue(
      context,
      "invalid-value",
      `${path}.${key}`,
      `must be an integer from ${String(minimum)} through ${String(maximum)}`,
    );
    return undefined;
  }
  return value as number;
}

function numberValue(
  record: UnknownRecord,
  key: string,
  path: string,
  context: Context,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    issue(
      context,
      value === undefined ? "missing-field" : "invalid-value",
      `${path}.${key}`,
      "must be a finite in-range number",
    );
    return undefined;
  }
  return value;
}

function nullableString(
  record: UnknownRecord,
  key: string,
  path: string,
  context: Context,
): string | null | undefined {
  if (!(key in record)) {
    issue(context, "missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  if (record[key] === null) return null;
  return string(record, key, path, context);
}

function array(
  record: UnknownRecord,
  key: string,
  path: string,
  context: Context,
  maximum: number,
): readonly unknown[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    issue(
      context,
      value === undefined ? "missing-field" : "invalid-value",
      `${path}.${key}`,
      "must be an array",
    );
    return undefined;
  }
  if (value.length > maximum)
    issue(
      context,
      "resource-limit",
      `${path}.${key}`,
      `must contain at most ${String(maximum)} items`,
    );
  const values: readonly unknown[] = value;
  return values.slice(0, maximum);
}

function canonicalStrings(
  values: readonly unknown[] | undefined,
  path: string,
  context: Context,
  pattern = IDENTIFIER,
): readonly string[] {
  const result: string[] = [];
  for (const [index, value] of (values ?? []).entries()) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Array.from(value).length > MAX_OUTPUT_TEXT_CODE_POINTS ||
      Buffer.byteLength(value, "utf8") > MAX_OUTPUT_TEXT_BYTES ||
      !pattern.test(value)
    ) {
      issue(
        context,
        "invalid-value",
        `${path}[${String(index)}]`,
        "must be a valid bounded string",
      );
    } else {
      const previous = result.at(-1);
      if (previous !== undefined && previous >= value) {
        issue(
          context,
          result.includes(value) ? "duplicate-id" : "invalid-order",
          `${path}[${String(index)}]`,
          "must be unique and sorted by Unicode code unit",
        );
      }
      result.push(value);
    }
  }
  return result;
}

function version(record: UnknownRecord, expected: string, path: string, context: Context): void {
  const actual = string(record, "schemaVersion", path, context, { pattern: VERSION });
  if (actual !== undefined && actual !== expected)
    issue(
      context,
      "unsupported-version",
      `${path}.schemaVersion`,
      `only schema version ${expected} is implemented`,
    );
}

function kind(record: UnknownRecord, expected: string, context: Context): void {
  const actual = string(record, "recordKind", "$", context);
  if (actual !== undefined && actual !== expected) {
    issue(context, "invalid-state", "$.recordKind", `must be '${expected}'`);
  }
}

function summary(value: unknown, path: string, context: Context): ValidatedSummary | undefined {
  const record = object(
    value,
    path,
    ["errors", "warnings", "infos", "suppressed", "exitCode"],
    context,
  );
  if (record === undefined) return undefined;
  const errors = integer(record, "errors", path, context);
  const warnings = integer(record, "warnings", path, context);
  const infos = integer(record, "infos", path, context);
  const suppressed = integer(record, "suppressed", path, context);
  const exitCode = integer(record, "exitCode", path, context, 0, 2);
  return errors === undefined ||
    warnings === undefined ||
    infos === undefined ||
    suppressed === undefined ||
    exitCode === undefined
    ? undefined
    : { errors, warnings, infos, suppressed, exitCode };
}

function profileVersions(
  value: unknown,
  path: string,
  context: Context,
): readonly string[] | undefined {
  const keys =
    value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const profiles = object(value, path, keys, context);
  if (profiles === undefined) return undefined;
  if (keys.length === 0)
    issue(context, "invalid-value", path, "must identify at least one profile");
  canonicalStrings(keys, path, context);
  for (const key of keys) {
    if (!IDENTIFIER.test(key)) {
      issue(context, "invalid-value", `${path}.${key}`, "profile key must be an identifier");
      continue;
    }
    const identity = object(
      profiles[key],
      `${path}.${key}`,
      ["profileVersion", "clientVersion"],
      context,
    );
    if (identity === undefined) continue;
    string(identity, "profileVersion", `${path}.${key}`, context, { pattern: VERSION });
    nullableString(identity, "clientVersion", `${path}.${key}`, context);
  }
  return keys;
}

function terminal(value: unknown, context: Context): void {
  const record = object(
    value,
    "$",
    ["recordKind", "schemaVersion", "colorMode", "width", "lines", "summary"],
    context,
  );
  if (record === undefined) return;
  kind(record, "agent-context-terminal-output", context);
  version(record, TERMINAL_OUTPUT_SCHEMA_VERSION, "$", context);
  enumString(record, "colorMode", "$", ["ansi", "never"], context);
  integer(record, "width", "$", context, 20, 1_000);
  const lines = array(record, "lines", "$", context, MAX_TERMINAL_LINES);
  for (const [index, line] of (lines ?? []).entries()) {
    const valid =
      typeof line === "string" &&
      Array.from(line).length <= MAX_OUTPUT_TEXT_CODE_POINTS &&
      Buffer.byteLength(line, "utf8") <= MAX_OUTPUT_TEXT_BYTES;
    if (!valid)
      issue(context, "unsafe-terminal", `$.lines[${String(index)}]`, "must be bounded output text");
  }
  summary(record["summary"], "$.summary", context);
}

function scan(value: unknown, sources: readonly SourceDocument[], context: Context): void {
  const record = object(
    value,
    "$",
    [
      "recordKind",
      "schemaVersion",
      "profileVersions",
      "failureThreshold",
      "diagnostics",
      "summary",
    ],
    context,
  );
  if (record === undefined) return;
  kind(record, "agent-context-scan-output", context);
  version(record, JSON_OUTPUT_SCHEMA_VERSION, "$", context);
  const declaredProfileIds = profileVersions(
    record["profileVersions"],
    "$.profileVersions",
    context,
  );
  const failureThreshold = enumString(
    record,
    "failureThreshold",
    "$",
    ["error", "warning", "never"],
    context,
  );
  let expectedSummary: Omit<ValidatedSummary, "exitCode"> | undefined;
  if (record["diagnostics"] === undefined)
    issue(context, "missing-field", "$.diagnostics", "is required");
  else {
    const result = validateDiagnosticBundle(record["diagnostics"], sources);
    if (!result.ok)
      for (const diagnosticIssue of result.issues)
        issue(
          context,
          "invalid-value",
          `$.diagnostics${diagnosticIssue.path.slice(1)}`,
          `${diagnosticIssue.code}: ${diagnosticIssue.message}`,
        );
    else {
      const diagnosticProfileIds = [
        ...new Set(
          result.value.diagnostics.flatMap((diagnostic) => [
            ...diagnostic.fingerprintBasis.path.profileIds,
            ...diagnostic.fingerprintBasis.semantic.profileIds,
          ]),
        ),
      ].sort();
      if (
        declaredProfileIds !== undefined &&
        diagnosticProfileIds.length > 0 &&
        (declaredProfileIds.length !== diagnosticProfileIds.length ||
          declaredProfileIds.some((profileId, index) => profileId !== diagnosticProfileIds[index]))
      ) {
        issue(
          context,
          "invalid-relationship",
          "$.profileVersions",
          "must exactly identify the profiles used by diagnostic fingerprints",
        );
      }
      const suppressedFingerprints = new Set(
        result.value.suppressions
          .filter((suppression) => suppression.state === "suppressed")
          .flatMap((suppression) => suppression.matchedPathFingerprints),
      );
      const activeDiagnostics = result.value.diagnostics.filter(
        (diagnostic) => !suppressedFingerprints.has(diagnostic.fingerprints.path.value),
      );
      expectedSummary = {
        errors: activeDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
        infos: activeDiagnostics.filter((diagnostic) => diagnostic.severity === "info").length,
        suppressed: suppressedFingerprints.size,
        warnings: activeDiagnostics.filter((diagnostic) => diagnostic.severity === "warning")
          .length,
      };
    }
  }
  const actualSummary = summary(record["summary"], "$.summary", context);
  if (
    expectedSummary !== undefined &&
    actualSummary !== undefined &&
    (actualSummary.errors !== expectedSummary.errors ||
      actualSummary.warnings !== expectedSummary.warnings ||
      actualSummary.infos !== expectedSummary.infos ||
      actualSummary.suppressed !== expectedSummary.suppressed)
  ) {
    issue(
      context,
      "invalid-relationship",
      "$.summary",
      "must be derived from active and suppressed diagnostics",
    );
  }
  if (actualSummary !== undefined && failureThreshold !== undefined) {
    const expectedExitCode =
      failureThreshold === "never"
        ? 0
        : failureThreshold === "warning"
          ? actualSummary.errors + actualSummary.warnings > 0
            ? 1
            : 0
          : actualSummary.errors > 0
            ? 1
            : 0;
    if (actualSummary.exitCode !== expectedExitCode) {
      issue(
        context,
        "invalid-relationship",
        "$.summary.exitCode",
        "must be derived from the active severity counts and failureThreshold",
      );
    }
  }
}

function efficiency(value: unknown, context: Context): void {
  const record = object(
    value,
    "$",
    [
      "recordKind",
      "schemaVersion",
      "profileId",
      "profileVersion",
      "clientVersion",
      "surfaceId",
      "specSnapshotId",
      "tokenizer",
      "sampleCount",
      "tokenStatistics",
      "score",
      "recommendations",
    ],
    context,
  );
  if (record === undefined) return;
  kind(record, "agent-context-efficiency-output", context);
  version(record, EFFICIENCY_OUTPUT_SCHEMA_VERSION, "$", context);
  for (const key of ["profileId", "surfaceId", "specSnapshotId"] as const)
    string(record, key, "$", context, { pattern: IDENTIFIER });
  string(record, "profileVersion", "$", context, { pattern: VERSION });
  nullableString(record, "clientVersion", "$", context);
  const tokenizer = object(
    record["tokenizer"],
    "$.tokenizer",
    ["id", "version", "measurement"],
    context,
  );
  if (tokenizer !== undefined) {
    string(tokenizer, "id", "$.tokenizer", context, { pattern: IDENTIFIER });
    string(tokenizer, "version", "$.tokenizer", context);
    enumString(tokenizer, "measurement", "$.tokenizer", ["exact", "estimate"], context);
  }
  integer(record, "sampleCount", "$", context, 1);
  const statistics = object(
    record["tokenStatistics"],
    "$.tokenStatistics",
    ["minimum", "median", "p95", "maximum"],
    context,
  );
  if (statistics !== undefined) {
    const minimum = integer(statistics, "minimum", "$.tokenStatistics", context);
    const median = integer(statistics, "median", "$.tokenStatistics", context);
    const p95 = integer(statistics, "p95", "$.tokenStatistics", context);
    const maximum = integer(statistics, "maximum", "$.tokenStatistics", context);
    if (
      minimum !== undefined &&
      median !== undefined &&
      p95 !== undefined &&
      maximum !== undefined &&
      !(minimum <= median && median <= p95 && p95 <= maximum)
    ) {
      issue(
        context,
        "invalid-relationship",
        "$.tokenStatistics",
        "must satisfy minimum <= median <= p95 <= maximum",
      );
    }
  }
  const score = object(record["score"], "$.score", ["version", "value", "grade"], context);
  if (score !== undefined) {
    string(score, "version", "$.score", context, { pattern: VERSION });
    numberValue(score, "value", "$.score", context, 0, 100);
    enumString(score, "grade", "$.score", ["A", "B", "C", "D", "F"], context);
  }
  const recommendations = array(
    record,
    "recommendations",
    "$",
    context,
    MAX_EFFICIENCY_RECOMMENDATIONS,
  );
  const ids: string[] = [];
  for (const [index, item] of (recommendations ?? []).entries()) {
    const path = `$.recommendations[${String(index)}]`;
    const recommendation = object(
      item,
      path,
      [
        "id",
        "title",
        "path",
        "baselineTokens",
        "projectedTokens",
        "confidence",
        "caveats",
        "benchmarkStatus",
      ],
      context,
    );
    if (recommendation === undefined) continue;
    const id = string(recommendation, "id", path, context, { pattern: IDENTIFIER });
    if (id !== undefined) {
      const previous = ids.at(-1);
      if (previous !== undefined && previous >= id)
        issue(
          context,
          ids.includes(id) ? "duplicate-id" : "invalid-order",
          `${path}.id`,
          "recommendations must be uniquely sorted by id",
        );
      ids.push(id);
    }
    string(recommendation, "title", path, context);
    const repositoryPath = string(recommendation, "path", path, context);
    if (repositoryPath !== undefined && !isRepositoryRelativePath(repositoryPath))
      issue(context, "invalid-path", `${path}.path`, "must be a repository-relative path");
    const baseline = integer(recommendation, "baselineTokens", path, context);
    const projected = integer(recommendation, "projectedTokens", path, context);
    if (baseline !== undefined && projected !== undefined && projected > baseline)
      issue(
        context,
        "invalid-relationship",
        `${path}.projectedTokens`,
        "must not exceed baselineTokens",
      );
    enumString(recommendation, "confidence", path, ["high", "medium", "low"], context);
    canonicalStrings(
      array(recommendation, "caveats", path, context, 128),
      `${path}.caveats`,
      context,
      /^.+$/u,
    );
    enumString(recommendation, "benchmarkStatus", path, ["not-run", "passed", "failed"], context);
  }
}

function artifact(value: unknown, path: string, context: Context): string | undefined {
  const record = object(value, path, ["channel", "version", "digest", "retrievedAt"], context);
  if (record === undefined) return undefined;
  const channel = string(record, "channel", path, context, { pattern: IDENTIFIER });
  string(record, "version", path, context);
  string(record, "digest", path, context, { pattern: SHA256 });
  const retrievedAt = string(record, "retrievedAt", path, context, { pattern: DATE_TIME });
  if (retrievedAt !== undefined && !isCanonicalDateTime(retrievedAt)) {
    issue(
      context,
      "invalid-value",
      `${path}.retrievedAt`,
      "must be a real canonical UTC timestamp",
    );
  }
  return channel;
}

function standards(value: unknown, context: Context): void {
  const record = object(
    value,
    "$",
    [
      "recordKind",
      "schemaVersion",
      "mode",
      "channel",
      "bundled",
      "locked",
      "cachedLatest",
      "activation",
      "freshness",
      "problems",
    ],
    context,
  );
  if (record === undefined) return;
  kind(record, "agent-context-standards-output", context);
  version(record, STANDARDS_OUTPUT_SCHEMA_VERSION, "$", context);
  enumString(record, "mode", "$", ["status", "check", "update-dry-run", "update"], context);
  const channel = string(record, "channel", "$", context, { pattern: IDENTIFIER });
  const bundledChannel = artifact(record["bundled"], "$.bundled", context);
  if (channel !== undefined && bundledChannel !== undefined && channel !== bundledChannel) {
    issue(context, "invalid-relationship", "$.bundled.channel", "must match $.channel");
  }
  for (const key of ["locked", "cachedLatest"] as const) {
    if (!(key in record)) issue(context, "missing-field", `$.${key}`, "is required");
    else if (record[key] !== null) {
      const artifactChannel = artifact(record[key], `$.${key}`, context);
      if (channel !== undefined && artifactChannel !== undefined && channel !== artifactChannel) {
        issue(context, "invalid-relationship", `$.${key}.channel`, "must match $.channel");
      }
    }
  }
  const activation = enumString(record, "activation", "$", ["bundled", "locked"], context);
  if (activation === "locked" && record["locked"] === null) {
    issue(
      context,
      "invalid-relationship",
      "$.activation",
      "cannot select a missing locked artifact",
    );
  }
  enumString(record, "freshness", "$", ["current", "update-available", "offline-unknown"], context);
  canonicalStrings(array(record, "problems", "$", context, 1_024), "$.problems", context, /^.+$/u);
}

function baseline(value: unknown, context: Context): void {
  const record = object(
    value,
    "$",
    [
      "recordKind",
      "schemaVersion",
      "diagnosticContractVersion",
      "engineVersion",
      "fingerprintMethods",
      "createdAt",
      "expiresAt",
      "sourceRevision",
      "profileVersions",
      "entries",
    ],
    context,
  );
  if (record === undefined) return;
  kind(record, "agent-context-baseline-output", context);
  version(record, BASELINE_OUTPUT_SCHEMA_VERSION, "$", context);
  const diagnosticVersion = string(record, "diagnosticContractVersion", "$", context, {
    pattern: VERSION,
  });
  if (diagnosticVersion !== undefined && diagnosticVersion !== DIAGNOSTIC_CONTRACT_VERSION) {
    issue(
      context,
      "unsupported-version",
      "$.diagnosticContractVersion",
      `must be '${DIAGNOSTIC_CONTRACT_VERSION}'`,
    );
  }
  string(record, "engineVersion", "$", context, { pattern: VERSION });
  const methods = object(
    record["fingerprintMethods"],
    "$.fingerprintMethods",
    ["path", "semantic"],
    context,
  );
  if (methods !== undefined) {
    const pathMethod = string(methods, "path", "$.fingerprintMethods", context);
    const semanticMethod = string(methods, "semantic", "$.fingerprintMethods", context);
    if (pathMethod !== undefined && pathMethod !== PATH_FINGERPRINT_METHOD)
      issue(
        context,
        "unsupported-version",
        "$.fingerprintMethods.path",
        `must be '${PATH_FINGERPRINT_METHOD}'`,
      );
    if (semanticMethod !== undefined && semanticMethod !== SEMANTIC_FINGERPRINT_METHOD)
      issue(
        context,
        "unsupported-version",
        "$.fingerprintMethods.semantic",
        `must be '${SEMANTIC_FINGERPRINT_METHOD}'`,
      );
  }
  const createdAt = string(record, "createdAt", "$", context, { pattern: DATE_TIME });
  if (createdAt !== undefined && !isCanonicalDateTime(createdAt)) {
    issue(context, "invalid-value", "$.createdAt", "must be a real canonical UTC timestamp");
  }
  const expiresAt = nullableString(record, "expiresAt", "$", context);
  if (typeof expiresAt === "string" && !isCanonicalDateTime(expiresAt))
    issue(context, "invalid-value", "$.expiresAt", "must be a canonical UTC timestamp or null");
  if (createdAt !== undefined && typeof expiresAt === "string" && expiresAt <= createdAt)
    issue(context, "invalid-relationship", "$.expiresAt", "must be later than createdAt");
  string(record, "sourceRevision", "$", context, { pattern: SHA256 });
  const profiles = object(
    record["profileVersions"],
    "$.profileVersions",
    Object.keys((record["profileVersions"] as UnknownRecord | undefined) ?? {}),
    context,
  );
  const profileSurfaceIds = new Set<string>();
  const profileSpecSnapshotIds = new Set<string>();
  const profileKeys = new Set<string>();
  if (profiles !== undefined) {
    const keys = Object.keys(profiles);
    if (keys.length === 0)
      issue(context, "invalid-value", "$.profileVersions", "must identify at least one profile");
    canonicalStrings(keys, "$.profileVersions", context);
    for (const key of keys) profileKeys.add(key);
    for (const key of keys) {
      const profile = object(
        profiles[key],
        `$.profileVersions.${key}`,
        ["profileVersion", "clientVersion", "surfaceIds", "specSnapshotIds"],
        context,
      );
      if (profile === undefined) continue;
      string(profile, "profileVersion", `$.profileVersions.${key}`, context, { pattern: VERSION });
      nullableString(profile, "clientVersion", `$.profileVersions.${key}`, context);
      const surfaceIds = canonicalStrings(
        array(
          profile,
          "surfaceIds",
          `$.profileVersions.${key}`,
          context,
          MAX_OUTPUT_CONTAINER_ENTRIES,
        ),
        `$.profileVersions.${key}.surfaceIds`,
        context,
      );
      const specSnapshotIds = canonicalStrings(
        array(
          profile,
          "specSnapshotIds",
          `$.profileVersions.${key}`,
          context,
          MAX_OUTPUT_CONTAINER_ENTRIES,
        ),
        `$.profileVersions.${key}.specSnapshotIds`,
        context,
      );
      for (const id of surfaceIds) profileSurfaceIds.add(id);
      for (const id of specSnapshotIds) profileSpecSnapshotIds.add(id);
    }
  }
  const entries = array(record, "entries", "$", context, MAX_BASELINE_ENTRIES);
  const identities: string[] = [];
  for (const [index, item] of (entries ?? []).entries()) {
    const path = `$.entries[${String(index)}]`;
    const entry = object(
      item,
      path,
      [
        "ruleId",
        "ruleVersion",
        "severity",
        "path",
        "semanticFingerprint",
        "pathFingerprint",
        "provenanceFingerprint",
        "profileIds",
        "surfaceIds",
        "specSnapshotIds",
        "firstSeenAt",
        "expiresAt",
      ],
      context,
    );
    if (entry === undefined) continue;
    const ruleId = string(entry, "ruleId", path, context, { pattern: IDENTIFIER });
    const ruleVersion = string(entry, "ruleVersion", path, context, { pattern: VERSION });
    const severity = enumString(entry, "severity", path, DIAGNOSTIC_SEVERITIES, context);
    const repositoryPath = string(entry, "path", path, context);
    if (repositoryPath !== undefined && !isRepositoryRelativePath(repositoryPath))
      issue(context, "invalid-path", `${path}.path`, "must be a repository-relative path");
    const semantic = string(entry, "semanticFingerprint", path, context, { pattern: SHA256 });
    const pathFingerprint = string(entry, "pathFingerprint", path, context, { pattern: SHA256 });
    const provenanceFingerprint = string(entry, "provenanceFingerprint", path, context, {
      pattern: SHA256,
    });
    const entryProfileIds = canonicalStrings(
      array(entry, "profileIds", path, context, MAX_OUTPUT_CONTAINER_ENTRIES),
      `${path}.profileIds`,
      context,
    );
    const entrySurfaceIds = canonicalStrings(
      array(entry, "surfaceIds", path, context, MAX_OUTPUT_CONTAINER_ENTRIES),
      `${path}.surfaceIds`,
      context,
    );
    const entrySpecSnapshotIds = canonicalStrings(
      array(entry, "specSnapshotIds", path, context, MAX_OUTPUT_CONTAINER_ENTRIES),
      `${path}.specSnapshotIds`,
      context,
    );
    for (const id of entryProfileIds)
      if (!profileKeys.has(id))
        issue(
          context,
          "invalid-relationship",
          `${path}.profileIds`,
          "must reference a declared profile",
        );
    for (const id of entrySurfaceIds)
      if (!profileSurfaceIds.has(id))
        issue(
          context,
          "invalid-relationship",
          `${path}.surfaceIds`,
          "must reference a declared surface",
        );
    for (const id of entrySpecSnapshotIds)
      if (!profileSpecSnapshotIds.has(id))
        issue(
          context,
          "invalid-relationship",
          `${path}.specSnapshotIds`,
          "must reference a declared specification snapshot",
        );
    const firstSeenAt = string(entry, "firstSeenAt", path, context, { pattern: DATE_TIME });
    if (firstSeenAt !== undefined && !isCanonicalDateTime(firstSeenAt)) {
      issue(
        context,
        "invalid-value",
        `${path}.firstSeenAt`,
        "must be a real canonical UTC timestamp",
      );
    }
    const entryExpiry = nullableString(entry, "expiresAt", path, context);
    if (typeof entryExpiry === "string" && !isCanonicalDateTime(entryExpiry))
      issue(
        context,
        "invalid-value",
        `${path}.expiresAt`,
        "must be a canonical UTC timestamp or null",
      );
    if (firstSeenAt !== undefined && createdAt !== undefined && firstSeenAt > createdAt) {
      issue(
        context,
        "invalid-relationship",
        `${path}.firstSeenAt`,
        "must not be later than createdAt",
      );
    }
    if (
      firstSeenAt !== undefined &&
      typeof entryExpiry === "string" &&
      entryExpiry <= firstSeenAt
    ) {
      issue(context, "invalid-relationship", `${path}.expiresAt`, "must be later than firstSeenAt");
    }
    if (
      typeof entryExpiry === "string" &&
      typeof expiresAt === "string" &&
      entryExpiry > expiresAt
    ) {
      issue(
        context,
        "invalid-relationship",
        `${path}.expiresAt`,
        "must not exceed baseline expiry",
      );
    }
    if (
      ruleId !== undefined &&
      ruleVersion !== undefined &&
      severity !== undefined &&
      repositoryPath !== undefined &&
      semantic !== undefined &&
      pathFingerprint !== undefined &&
      provenanceFingerprint !== undefined
    ) {
      const identity = `${ruleId}\u0000${ruleVersion}\u0000${severity}\u0000${repositoryPath}\u0000${semantic}\u0000${pathFingerprint}\u0000${provenanceFingerprint}\u0000${entryProfileIds.join("\u0001")}\u0000${entrySurfaceIds.join("\u0001")}\u0000${entrySpecSnapshotIds.join("\u0001")}`;
      const previous = identities.at(-1);
      if (previous !== undefined && previous >= identity)
        issue(
          context,
          identities.includes(identity) ? "duplicate-id" : "invalid-order",
          path,
          "entries must be uniquely sorted by their complete compatibility identity",
        );
      identities.push(identity);
    }
  }
}

function sarifLocationV1(value: unknown, path: string, context: Context): void {
  const location = object(value, path, ["physicalLocation"], context);
  const physical =
    location === undefined
      ? undefined
      : object(
          location["physicalLocation"],
          `${path}.physicalLocation`,
          ["artifactLocation", "region"],
          context,
        );
  const artifact =
    physical === undefined
      ? undefined
      : object(
          physical["artifactLocation"],
          `${path}.physicalLocation.artifactLocation`,
          ["uri"],
          context,
        );
  if (artifact !== undefined) {
    const uri = string(artifact, "uri", `${path}.physicalLocation.artifactLocation`, context);
    if (uri !== undefined && decodeSarifArtifactUri(uri) === undefined)
      issue(
        context,
        "invalid-path",
        `${path}.physicalLocation.artifactLocation.uri`,
        "must be a canonical percent-encoded repository-relative URI",
      );
  }
  const region =
    physical === undefined
      ? undefined
      : object(
          physical["region"],
          `${path}.physicalLocation.region`,
          ["startLine", "startColumn", "endLine", "endColumn"],
          context,
        );
  if (region !== undefined) {
    const startLine = integer(region, "startLine", `${path}.physicalLocation.region`, context, 1);
    const startColumn = integer(
      region,
      "startColumn",
      `${path}.physicalLocation.region`,
      context,
      1,
    );
    const endLine = integer(region, "endLine", `${path}.physicalLocation.region`, context, 1);
    const endColumn = integer(region, "endColumn", `${path}.physicalLocation.region`, context, 1);
    if (
      startLine !== undefined &&
      endLine !== undefined &&
      startColumn !== undefined &&
      endColumn !== undefined &&
      (endLine < startLine || (endLine === startLine && endColumn < startColumn))
    )
      issue(
        context,
        "invalid-relationship",
        `${path}.physicalLocation.region`,
        "end must not precede start",
      );
  }
}

function sarifV1(value: unknown, context: Context): void {
  const root = object(value, "$", ["version", "$schema", "runs"], context);
  if (root === undefined) return;
  const sarifVersion = string(root, "version", "$", context);
  if (sarifVersion !== undefined && sarifVersion !== SARIF_VERSION)
    issue(context, "unsupported-version", "$.version", `only SARIF ${SARIF_VERSION} is supported`);
  const schema = string(root, "$schema", "$", context);
  if (schema !== undefined && schema !== SARIF_SCHEMA_URI)
    issue(
      context,
      "invalid-value",
      "$.$schema",
      "must identify the official SARIF 2.1.0 Errata 01 schema",
    );
  const runs = array(root, "runs", "$", context, 1);
  if (runs?.length !== 1) issue(context, "invalid-value", "$.runs", "must contain exactly one run");
  for (const [runIndex, runValue] of (runs ?? []).entries()) {
    const runPath = `$.runs[${String(runIndex)}]`;
    const run = object(runValue, runPath, ["tool", "results", "properties"], context);
    const tool =
      run === undefined ? undefined : object(run["tool"], `${runPath}.tool`, ["driver"], context);
    const driver =
      tool === undefined
        ? undefined
        : object(
            tool["driver"],
            `${runPath}.tool.driver`,
            ["name", "semanticVersion", "informationUri", "rules"],
            context,
          );
    const ruleIds: string[] = [];
    if (driver !== undefined) {
      const name = string(driver, "name", `${runPath}.tool.driver`, context);
      if (name !== undefined && name !== "Agent Context Linter")
        issue(
          context,
          "invalid-value",
          `${runPath}.tool.driver.name`,
          "must name Agent Context Linter",
        );
      string(driver, "semanticVersion", `${runPath}.tool.driver`, context, { pattern: VERSION });
      const informationUri = string(driver, "informationUri", `${runPath}.tool.driver`, context);
      if (informationUri !== undefined && !isCredentialFreeHttpsUri(informationUri))
        issue(
          context,
          "invalid-value",
          `${runPath}.tool.driver.informationUri`,
          "must be a credential-free well-formed HTTPS URI",
        );
      const rules = array(driver, "rules", `${runPath}.tool.driver`, context, MAX_SARIF_RULES);
      for (const [index, item] of (rules ?? []).entries()) {
        const path = `${runPath}.tool.driver.rules[${String(index)}]`;
        const rule = object(
          item,
          path,
          ["id", "name", "shortDescription", "defaultConfiguration"],
          context,
        );
        if (rule === undefined) continue;
        const id = string(rule, "id", path, context, { pattern: IDENTIFIER });
        if (id !== undefined) {
          const previous = ruleIds.at(-1);
          if (previous !== undefined && previous >= id)
            issue(
              context,
              ruleIds.includes(id) ? "duplicate-id" : "invalid-order",
              `${path}.id`,
              "rules must be uniquely sorted by id",
            );
          ruleIds.push(id);
        }
        string(rule, "name", path, context, { pattern: IDENTIFIER });
        const description = object(
          rule["shortDescription"],
          `${path}.shortDescription`,
          ["text"],
          context,
        );
        if (description !== undefined)
          string(description, "text", `${path}.shortDescription`, context);
        const configuration = object(
          rule["defaultConfiguration"],
          `${path}.defaultConfiguration`,
          ["level"],
          context,
        );
        if (configuration !== undefined)
          enumString(
            configuration,
            "level",
            `${path}.defaultConfiguration`,
            ["error", "warning", "note"],
            context,
          );
      }
    }
    const results =
      run === undefined ? undefined : array(run, "results", runPath, context, MAX_SARIF_RESULTS);
    for (const [index, item] of (results ?? []).entries()) {
      const path = `${runPath}.results[${String(index)}]`;
      const result = object(
        item,
        path,
        [
          "ruleId",
          "ruleIndex",
          "level",
          "message",
          "locations",
          "relatedLocations",
          "partialFingerprints",
        ],
        context,
      );
      if (result === undefined) continue;
      const ruleId = string(result, "ruleId", path, context, { pattern: IDENTIFIER });
      const ruleIndex = integer(
        result,
        "ruleIndex",
        path,
        context,
        0,
        Math.max(0, ruleIds.length - 1),
      );
      if (ruleId !== undefined && ruleIndex !== undefined && ruleIds[ruleIndex] !== ruleId)
        issue(
          context,
          "invalid-relationship",
          `${path}.ruleIndex`,
          "must identify ruleId in tool.driver.rules",
        );
      enumString(result, "level", path, ["error", "warning", "note"], context);
      const message = object(result["message"], `${path}.message`, ["text"], context);
      if (message !== undefined) string(message, "text", `${path}.message`, context);
      const locations = array(result, "locations", path, context, 1);
      if (locations?.length !== 1)
        issue(
          context,
          "invalid-value",
          `${path}.locations`,
          "must contain exactly one primary location",
        );
      for (const [locationIndex, location] of (locations ?? []).entries()) {
        sarifLocationV1(location, `${path}.locations[${String(locationIndex)}]`, context);
      }
      const related = array(result, "relatedLocations", path, context, MAX_SARIF_RELATED_LOCATIONS);
      const relatedIdentities = new Set<string>();
      for (const [locationIndex, location] of (related ?? []).entries()) {
        const locationPath = `${path}.relatedLocations[${String(locationIndex)}]`;
        sarifLocationV1(location, locationPath, context);
        const identity = JSON.stringify(canonicalize(location));
        if (relatedIdentities.has(identity))
          issue(context, "duplicate-id", locationPath, "related locations must be unique");
        relatedIdentities.add(identity);
      }
      const fingerprints = object(
        result["partialFingerprints"],
        `${path}.partialFingerprints`,
        Object.keys((result["partialFingerprints"] as UnknownRecord | undefined) ?? {}),
        context,
      );
      if (fingerprints !== undefined) {
        const keys = Object.keys(fingerprints);
        canonicalStrings(
          keys,
          `${path}.partialFingerprints`,
          context,
          /^[A-Za-z][A-Za-z0-9./-]*\/v[1-9]\d*$/,
        );
        if (keys.length === 0)
          issue(context, "invalid-value", `${path}.partialFingerprints`, "must not be empty");
        for (const key of keys) {
          const fingerprint = fingerprints[key];
          if (typeof fingerprint !== "string" || !SHA256.test(fingerprint))
            issue(
              context,
              "invalid-value",
              `${path}.partialFingerprints.${key}`,
              "must be a lowercase SHA-256 fingerprint",
            );
        }
      }
    }
    const properties =
      run === undefined
        ? undefined
        : object(
            run["properties"],
            `${runPath}.properties`,
            ["agentContextSchemaVersion", "profileVersions"],
            context,
          );
    if (properties !== undefined) {
      const productVersion = string(
        properties,
        "agentContextSchemaVersion",
        `${runPath}.properties`,
        context,
      );
      if (productVersion !== undefined && productVersion !== SARIF_OUTPUT_LEGACY_SCHEMA_VERSION)
        issue(
          context,
          "unsupported-version",
          `${runPath}.properties.agentContextSchemaVersion`,
          `only legacy schema version ${SARIF_OUTPUT_LEGACY_SCHEMA_VERSION} is implemented`,
        );
      profileVersions(
        properties["profileVersions"],
        `${runPath}.properties.profileVersions`,
        context,
      );
    }
  }
}

function sarifMessage(value: unknown, path: string, context: Context): void {
  const message = object(value, path, ["text"], context);
  if (message !== undefined) string(message, "text", path, context);
}

function sarifLocationV2(value: unknown, path: string, context: Context, relatedId?: number): void {
  const keys =
    relatedId === undefined ? ["physicalLocation"] : ["id", "physicalLocation", "message"];
  const location = object(value, path, keys, context);
  if (location === undefined) return;
  if (relatedId !== undefined) {
    const id = integer(location, "id", path, context, 1, MAX_SARIF_RELATED_LOCATIONS);
    if (id !== undefined && id !== relatedId)
      issue(
        context,
        "invalid-order",
        `${path}.id`,
        "related location ids must be consecutive from 1",
      );
    sarifMessage(location["message"], `${path}.message`, context);
  }
  const physical = object(
    location["physicalLocation"],
    `${path}.physicalLocation`,
    ["artifactLocation", "region"],
    context,
  );
  if (physical === undefined) return;
  const artifact = object(
    physical["artifactLocation"],
    `${path}.physicalLocation.artifactLocation`,
    ["uri"],
    context,
  );
  if (artifact !== undefined) {
    const uri = string(artifact, "uri", `${path}.physicalLocation.artifactLocation`, context);
    if (uri !== undefined && decodeSarifArtifactUri(uri) === undefined)
      issue(
        context,
        "invalid-path",
        `${path}.physicalLocation.artifactLocation.uri`,
        "must be a canonical percent-encoded repository-relative URI",
      );
  }
  const region = object(
    physical["region"],
    `${path}.physicalLocation.region`,
    ["startLine", "startColumn", "endLine", "endColumn"],
    context,
  );
  if (region === undefined) return;
  const startLine = integer(region, "startLine", `${path}.physicalLocation.region`, context, 1);
  const startColumn = integer(region, "startColumn", `${path}.physicalLocation.region`, context, 1);
  const endLine = integer(region, "endLine", `${path}.physicalLocation.region`, context, 1);
  const endColumn = integer(region, "endColumn", `${path}.physicalLocation.region`, context, 1);
  if (
    startLine !== undefined &&
    endLine !== undefined &&
    startColumn !== undefined &&
    endColumn !== undefined &&
    (endLine < startLine || (endLine === startLine && endColumn < startColumn))
  )
    issue(
      context,
      "invalid-relationship",
      `${path}.physicalLocation.region`,
      "end must not precede start",
    );
}

function sarifRuleV2(value: unknown, path: string, context: Context, ruleIds: string[]): void {
  const rule = object(
    value,
    path,
    [
      "id",
      "name",
      "shortDescription",
      "fullDescription",
      "helpUri",
      "help",
      "defaultConfiguration",
      "properties",
    ],
    context,
  );
  if (rule === undefined) return;
  const id = string(rule, "id", path, context, { pattern: IDENTIFIER });
  if (id !== undefined) {
    const previous = ruleIds.at(-1);
    if (previous !== undefined && previous >= id)
      issue(
        context,
        ruleIds.includes(id) ? "duplicate-id" : "invalid-order",
        `${path}.id`,
        "rules must be uniquely sorted by id",
      );
    ruleIds.push(id);
  }
  string(rule, "name", path, context, { pattern: IDENTIFIER });
  for (const field of ["shortDescription", "fullDescription"] as const)
    sarifMessage(rule[field], `${path}.${field}`, context);
  const helpUri = string(rule, "helpUri", path, context);
  if (helpUri !== undefined && !isCredentialFreeHttpsUri(helpUri))
    issue(context, "invalid-value", `${path}.helpUri`, "must be a credential-free HTTPS URI");
  const help = object(rule["help"], `${path}.help`, ["text", "markdown"], context);
  if (help !== undefined) {
    string(help, "text", `${path}.help`, context);
    string(help, "markdown", `${path}.help`, context);
  }
  const configuration = object(
    rule["defaultConfiguration"],
    `${path}.defaultConfiguration`,
    ["level"],
    context,
  );
  if (configuration !== undefined)
    enumString(
      configuration,
      "level",
      `${path}.defaultConfiguration`,
      ["error", "warning", "note"],
      context,
    );
  const properties = object(
    rule["properties"],
    `${path}.properties`,
    [
      "tags",
      "problem.severity",
      "agentContextCategory",
      "agentContextFixSafety",
      "agentContextOwner",
      "agentContextPrecisionStatus",
    ],
    context,
  );
  if (properties !== undefined) {
    canonicalStrings(
      array(properties, "tags", `${path}.properties`, context, 128),
      `${path}.properties.tags`,
      context,
    );
    enumString(
      properties,
      "problem.severity",
      `${path}.properties`,
      ["error", "warning", "recommendation"],
      context,
    );
    for (const field of [
      "agentContextCategory",
      "agentContextFixSafety",
      "agentContextPrecisionStatus",
    ])
      string(properties, field, `${path}.properties`, context, { pattern: IDENTIFIER });
    string(properties, "agentContextOwner", `${path}.properties`, context);
  }
}

function sarifV2(value: unknown, context: Context): void {
  const root = object(value, "$", ["version", "$schema", "runs"], context);
  if (root === undefined) return;
  const sarifVersion = string(root, "version", "$", context);
  if (sarifVersion !== undefined && sarifVersion !== SARIF_VERSION)
    issue(context, "unsupported-version", "$.version", `only SARIF ${SARIF_VERSION} is supported`);
  const schema = string(root, "$schema", "$", context);
  if (schema !== undefined && schema !== SARIF_SCHEMA_URI)
    issue(
      context,
      "invalid-value",
      "$.$schema",
      "must identify the official SARIF 2.1.0 Errata 01 schema",
    );
  const runs = array(root, "runs", "$", context, 1);
  if (runs?.length !== 1) issue(context, "invalid-value", "$.runs", "must contain exactly one run");
  for (const [runIndex, runValue] of (runs ?? []).entries()) {
    const runPath = `$.runs[${String(runIndex)}]`;
    const run = object(runValue, runPath, ["tool", "results", "properties"], context);
    if (run === undefined) continue;
    const tool = object(run["tool"], `${runPath}.tool`, ["driver"], context);
    const driver =
      tool === undefined
        ? undefined
        : object(
            tool["driver"],
            `${runPath}.tool.driver`,
            ["name", "semanticVersion", "informationUri", "rules"],
            context,
          );
    const ruleIds: string[] = [];
    if (driver !== undefined) {
      const name = string(driver, "name", `${runPath}.tool.driver`, context);
      if (name !== undefined && name !== "Agent Context Linter")
        issue(
          context,
          "invalid-value",
          `${runPath}.tool.driver.name`,
          "must name Agent Context Linter",
        );
      string(driver, "semanticVersion", `${runPath}.tool.driver`, context, { pattern: VERSION });
      const informationUri = string(driver, "informationUri", `${runPath}.tool.driver`, context);
      if (informationUri !== undefined && !isCredentialFreeHttpsUri(informationUri))
        issue(
          context,
          "invalid-value",
          `${runPath}.tool.driver.informationUri`,
          "must be a credential-free HTTPS URI",
        );
      const rules = array(driver, "rules", `${runPath}.tool.driver`, context, MAX_SARIF_RULES);
      for (const [index, rule] of (rules ?? []).entries())
        sarifRuleV2(rule, `${runPath}.tool.driver.rules[${String(index)}]`, context, ruleIds);
    }
    const results = array(run, "results", runPath, context, MAX_SARIF_RESULTS);
    for (const [index, item] of (results ?? []).entries()) {
      const path = `${runPath}.results[${String(index)}]`;
      const result = object(
        item,
        path,
        [
          "ruleId",
          "ruleIndex",
          "level",
          "message",
          "locations",
          "relatedLocations",
          "partialFingerprints",
          "properties",
        ],
        context,
      );
      if (result === undefined) continue;
      const ruleId = string(result, "ruleId", path, context, { pattern: IDENTIFIER });
      const ruleIndex = integer(
        result,
        "ruleIndex",
        path,
        context,
        0,
        Math.max(0, ruleIds.length - 1),
      );
      if (ruleId !== undefined && ruleIndex !== undefined && ruleIds[ruleIndex] !== ruleId)
        issue(
          context,
          "invalid-relationship",
          `${path}.ruleIndex`,
          "must identify ruleId in tool.driver.rules",
        );
      enumString(result, "level", path, ["error", "warning", "note"], context);
      sarifMessage(result["message"], `${path}.message`, context);
      const locations = array(result, "locations", path, context, 1);
      if (locations?.length !== 1)
        issue(
          context,
          "invalid-value",
          `${path}.locations`,
          "must contain exactly one primary location",
        );
      for (const [locationIndex, location] of (locations ?? []).entries())
        sarifLocationV2(location, `${path}.locations[${String(locationIndex)}]`, context);
      const related = array(result, "relatedLocations", path, context, MAX_SARIF_RELATED_LOCATIONS);
      const relatedIdentities = new Set<string>();
      for (const [locationIndex, location] of (related ?? []).entries()) {
        const locationPath = `${path}.relatedLocations[${String(locationIndex)}]`;
        sarifLocationV2(location, locationPath, context, locationIndex + 1);
        const record = location as UnknownRecord;
        const identity = JSON.stringify(canonicalize(record["physicalLocation"]));
        if (relatedIdentities.has(identity))
          issue(context, "duplicate-id", locationPath, "related physical locations must be unique");
        relatedIdentities.add(identity);
      }
      const fingerprints = object(
        result["partialFingerprints"],
        `${path}.partialFingerprints`,
        ["primaryLocationLineHash", "agentContextPath/v1", "agentContextSemantic/v1"],
        context,
      );
      if (fingerprints !== undefined) {
        string(fingerprints, "primaryLocationLineHash", `${path}.partialFingerprints`, context, {
          pattern: GITHUB_LINE_HASH,
        });
        string(fingerprints, "agentContextPath/v1", `${path}.partialFingerprints`, context, {
          pattern: SHA256,
        });
        string(fingerprints, "agentContextSemantic/v1", `${path}.partialFingerprints`, context, {
          pattern: SHA256,
        });
      }
      const properties = object(
        result["properties"],
        `${path}.properties`,
        ["agentContextRuleVersion", "profileIds", "surfaceIds", "specSnapshotIds"],
        context,
      );
      if (properties !== undefined) {
        string(properties, "agentContextRuleVersion", `${path}.properties`, context, {
          pattern: VERSION,
        });
        for (const field of ["profileIds", "surfaceIds", "specSnapshotIds"])
          canonicalStrings(
            array(properties, field, `${path}.properties`, context, 128),
            `${path}.properties.${field}`,
            context,
          );
      }
    }
    const properties = object(
      run["properties"],
      `${runPath}.properties`,
      ["agentContextSchemaVersion", "profileVersions"],
      context,
    );
    if (properties !== undefined) {
      const productVersion = string(
        properties,
        "agentContextSchemaVersion",
        `${runPath}.properties`,
        context,
      );
      if (productVersion !== undefined && productVersion !== SARIF_OUTPUT_SCHEMA_VERSION)
        issue(
          context,
          "unsupported-version",
          `${runPath}.properties.agentContextSchemaVersion`,
          `only schema version ${SARIF_OUTPUT_SCHEMA_VERSION} is implemented`,
        );
      profileVersions(
        properties["profileVersions"],
        `${runPath}.properties.profileVersions`,
        context,
      );
    }
  }
}

function validate<T>(
  input: unknown,
  callback: (value: unknown, context: Context) => void,
): OutputValidationResult<T> {
  const context: Context = { issues: [] };
  try {
    if (
      !validateJsonValue(
        input,
        "$",
        (code, path, message) => {
          issue(context, code === "invalid-value" ? "invalid-json" : code, path, message);
        },
        LIMITS,
      )
    )
      return { ok: false, issues: context.issues };
    callback(input, context);
  } catch (error) {
    if (!(error instanceof ValidationIssueLimitReached))
      return {
        ok: false,
        issues: [
          {
            code: "invalid-json",
            path: "$",
            message: "input must be safely inspectable JSON data",
          },
        ],
      };
  }
  return context.issues.length === 0
    ? { ok: true, value: input as T }
    : { ok: false, issues: context.issues };
}

function recordKind(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  try {
    if (nodeTypes.isProxy(input)) return undefined;
    if (Array.isArray(input)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, "recordKind");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function validateTerminalOutput(input: unknown): OutputValidationResult<TerminalOutput> {
  return validate(input, terminal);
}

export function validateScanJsonOutput(
  input: unknown,
  sources: readonly SourceDocument[],
): OutputValidationResult<ScanJsonOutput> {
  return validate(input, (value, context) => {
    scan(value, sources, context);
  });
}

export function validateEfficiencyOutput(input: unknown): OutputValidationResult<EfficiencyOutput> {
  return validate(input, efficiency);
}

export function validateStandardsOutput(input: unknown): OutputValidationResult<StandardsOutput> {
  return validate(input, standards);
}

export function validateBaselineOutput(input: unknown): OutputValidationResult<BaselineOutput> {
  return validate(input, baseline);
}

export function validateNativeOutput(
  input: unknown,
  sources: readonly SourceDocument[] = [],
): OutputValidationResult<NativeOutputDocument> {
  try {
    const kind = recordKind(input);
    if (kind === "agent-context-terminal-output") return validateTerminalOutput(input);
    if (kind === "agent-context-scan-output") return validateScanJsonOutput(input, sources);
    if (kind === "agent-context-efficiency-output") return validateEfficiencyOutput(input);
    if (kind === "agent-context-standards-output") return validateStandardsOutput(input);
    if (kind === "agent-context-baseline-output") return validateBaselineOutput(input);
    return validate(input, (_value, context) => {
      issue(
        context,
        kind === undefined ? "missing-field" : "invalid-state",
        "$.recordKind",
        kind === undefined ? "is required" : `has unsupported value '${kind}'`,
      );
    });
  } catch {
    return unsafeInputResult();
  }
}

export function validateSarifOutput(input: unknown): OutputValidationResult<SarifOutput> {
  return validate(input, sarifV2);
}

/** Validate a frozen pre-GA v1 document without accepting any v2 additions. */
export function validateSarifOutputV1(input: unknown): OutputValidationResult<SarifOutputV1> {
  return validate(input, sarifV1);
}

/** Negotiate the product subset independently from the normative SARIF `version` field. */
export function detectSarifOutputProductVersion(
  input: unknown,
): typeof SARIF_OUTPUT_SCHEMA_VERSION | typeof SARIF_OUTPUT_LEGACY_SCHEMA_VERSION | undefined {
  if (validateSarifOutput(input).ok) return SARIF_OUTPUT_SCHEMA_VERSION;
  if (validateSarifOutputV1(input).ok) return SARIF_OUTPUT_LEGACY_SCHEMA_VERSION;
  return undefined;
}

/**
 * v1 lacks GitHub's fingerprint key and complete rule/result provenance, so a safe migration cannot
 * infer v2. Callers must regenerate from the validated B04 diagnostic bundle and source documents.
 */
export function migrateSarifOutputV1(input: unknown): SarifV1MigrationResult {
  const validation = validateSarifOutputV1(input);
  return validation.ok
    ? {
        ok: false,
        code: "regeneration-required",
        fromVersion: SARIF_OUTPUT_LEGACY_SCHEMA_VERSION,
        toVersion: SARIF_OUTPUT_SCHEMA_VERSION,
        reason:
          "SARIF product subset v2 must be regenerated from diagnostics and source documents; v1 does not contain enough provenance or GitHub line-hash input",
      }
    : { ok: false, code: "invalid-v1", issues: validation.issues };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      result[key] = canonicalize((value as UnknownRecord)[key]);
    return result;
  }
  return value;
}

function unsafeInputResult(): OutputSerializationResult & OutputValidationResult<never> {
  return {
    ok: false,
    issues: [
      { code: "invalid-json", path: "$", message: "input must be safely inspectable JSON data" },
    ],
  };
}

function unsafeSanitizationResult(): OutputSerializationResult {
  return {
    ok: false,
    issues: [
      {
        code: "invalid-state",
        path: "$",
        message: "safe redaction would violate output contract relationships",
      },
    ],
  };
}

export function serializeNativeOutput(
  input: unknown,
  sources: readonly SourceDocument[] = [],
): OutputSerializationResult {
  try {
    const result = validateNativeOutput(input, sources);
    if (!result.ok) return result;
    const sanitized = sanitizeOutputJson(result.value);
    if (!validateNativeOutput(sanitized, sources).ok) return unsafeSanitizationResult();
    return { ok: true, text: `${JSON.stringify(canonicalize(sanitized))}\n` };
  } catch {
    return unsafeInputResult();
  }
}

export function serializeTerminalOutput(input: unknown): OutputSerializationResult {
  try {
    const result = validateTerminalOutput(input);
    return result.ok
      ? {
          ok: true,
          text:
            result.value.lines.length === 0
              ? ""
              : `${result.value.lines.map(sanitizeOutputText).join("\n")}\n`,
        }
      : result;
  } catch {
    return unsafeInputResult();
  }
}

export function serializeSarifOutput(input: unknown): OutputSerializationResult {
  try {
    const result = validateSarifOutput(input);
    if (!result.ok) return result;
    const sanitized = sanitizeOutputJson(result.value) as SarifOutput;
    if (!validateSarifOutput(sanitized).ok) return unsafeSanitizationResult();
    const canonical = canonicalize(sanitized) as UnknownRecord;
    const ordered: UnknownRecord = {
      version: sanitized.version,
      $schema: sanitized.$schema,
      runs: canonical["runs"],
    };
    return { ok: true, text: `${JSON.stringify(ordered)}\n` };
  } catch {
    return unsafeInputResult();
  }
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function classifyOutputCompatibility(
  producerVersion: string,
  consumerVersion: string,
): OutputCompatibilityResult {
  const producer = VERSION.exec(producerVersion);
  const consumer = VERSION.exec(consumerVersion);
  if (producer === null || consumer === null)
    return {
      change: "major",
      compatible: false,
      reason: "both versions must be canonical semantic versions",
    };
  const [producerMajor, producerMinor] = producerVersion.split(".") as [string, string, string];
  const [consumerMajor, consumerMinor] = consumerVersion.split(".") as [string, string, string];
  if (producerMajor !== consumerMajor)
    return {
      change: "major",
      compatible: false,
      reason: "major versions differ; migration is required",
    };
  if (compareNumericIdentifier(producerMinor, consumerMinor) > 0)
    return {
      change: "minor",
      compatible: false,
      reason: "the producer uses a newer additive schema; upgrade or explicitly down-convert",
    };
  if (producerMinor !== consumerMinor)
    return {
      change: "minor",
      compatible: true,
      reason: "the consumer implements this older additive schema",
    };
  return {
    change: "patch",
    compatible: true,
    reason: "patch revisions do not change the accepted document shape",
  };
}

export function isNativeOutput(
  input: unknown,
  sources: readonly SourceDocument[] = [],
): input is NativeOutputDocument {
  return validateNativeOutput(input, sources).ok;
}

export function isSarifOutput(input: unknown): input is SarifOutput {
  return validateSarifOutput(input).ok;
}

export function isKnownOutputRecordKind(value: string): boolean {
  return OUTPUT_KIND_SET.has(value);
}
