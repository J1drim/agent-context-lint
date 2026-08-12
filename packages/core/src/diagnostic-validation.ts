import { createHash } from "node:crypto";

import {
  MAX_VALIDATION_ISSUES,
  VALIDATION_ISSUE_LIMIT_CODE,
  ValidationIssueLimitReached,
  validateJsonValue,
  validateUncertaintyValue,
} from "./contract-validation.js";
import {
  DIAGNOSTIC_CONTRACT_VERSION,
  DIAGNOSTIC_SEVERITIES,
  FIX_OPERATION_KINDS,
  PATH_FINGERPRINT_METHOD,
  RELATED_EVIDENCE_KINDS,
  SEMANTIC_FINGERPRINT_METHOD,
  SUPPRESSION_STATES,
} from "./diagnostic-contracts.js";
import { computePathFingerprint, computeSemanticFingerprint } from "./diagnostic-fingerprint.js";
import { validateSourceRange } from "./ir-validation.js";
import { isRepositoryRelativePath } from "./repository-path.js";

import type { JsonValidationLimits } from "./contract-validation.js";
import type {
  AtomicFixPlan,
  DiagnosticBundle,
  DiagnosticContractValidationCode,
  DiagnosticContractValidationIssue,
  DiagnosticContractValidationResult,
  DiagnosticSourceLocation,
  FingerprintComponent,
  FixOperation,
  PathFingerprintBasis,
  RelatedEvidence,
  SemanticFingerprintBasis,
} from "./diagnostic-contracts.js";
import type { SourceDocument, SourceRange } from "./ir-contracts.js";

type UnknownRecord = Record<string, unknown>;

export const MAX_DIAGNOSTICS_PER_BUNDLE = 10_000 as const;
export const MAX_RELATED_EVIDENCE_PER_DIAGNOSTIC = 128 as const;
export const MAX_FIX_OPERATIONS_PER_PLAN = 1_024 as const;
export const MAX_SUPPRESSIONS_PER_BUNDLE = 10_000 as const;
export const MAX_DIAGNOSTIC_TEXT_BYTES = 16_384 as const;
export const MAX_FIX_TEXT_BYTES = 1_048_576 as const;
export const MAX_DIAGNOSTIC_JSON_CONTAINER_ENTRIES = 100_000 as const;
export const MAX_DIAGNOSTIC_JSON_KEY_BYTES = 1_024 as const;
export const MAX_DIAGNOSTIC_JSON_STRING_BYTES = 1_048_576 as const;
export const MAX_DIAGNOSTIC_JSON_TOTAL_STRING_BYTES = 67_108_864 as const;
export const MAX_DIAGNOSTIC_JSON_VALUES = 1_000_000 as const;

const DIAGNOSTIC_JSON_LIMITS: JsonValidationLimits = {
  maximumContainerEntries: MAX_DIAGNOSTIC_JSON_CONTAINER_ENTRIES,
  maximumKeyBytes: MAX_DIAGNOSTIC_JSON_KEY_BYTES,
  maximumStringBytes: MAX_DIAGNOSTIC_JSON_STRING_BYTES,
  maximumTotalStringBytes: MAX_DIAGNOSTIC_JSON_TOTAL_STRING_BYTES,
  maximumValues: MAX_DIAGNOSTIC_JSON_VALUES,
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const SEVERITY_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_SEVERITIES);
const EVIDENCE_KIND_SET: ReadonlySet<string> = new Set(RELATED_EVIDENCE_KINDS);
const FIX_KIND_SET: ReadonlySet<string> = new Set(FIX_OPERATION_KINDS);
const SUPPRESSION_STATE_SET: ReadonlySet<string> = new Set(SUPPRESSION_STATES);

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

interface ValidationContext {
  readonly entityIds: Map<string, string>;
  readonly issues: DiagnosticContractValidationIssue[];
  readonly pathFingerprints: Set<string>;
  readonly sources: ReadonlyMap<string, SourceDocument>;
}

function registerEntityId(id: string | undefined, path: string, context: ValidationContext): void {
  if (id === undefined) return;
  const prior = context.entityIds.get(id);
  if (prior === undefined) context.entityIds.set(id, path);
  else
    addIssue(
      context,
      "duplicate-id",
      path,
      `duplicates B04 entity '${id}' first declared at ${prior}`,
    );
}

function addIssue(
  context: ValidationContext,
  code: DiagnosticContractValidationCode,
  path: string,
  message: string,
): void {
  if (context.issues.length >= MAX_VALIDATION_ISSUES - 1) {
    if (context.issues.length === MAX_VALIDATION_ISSUES - 1) {
      context.issues.push({
        code: VALIDATION_ISSUE_LIMIT_CODE,
        message: `validation stopped after ${String(MAX_VALIDATION_ISSUES - 1)} issues`,
        path: "$",
      });
    }
    throw new ValidationIssueLimitReached();
  }
  context.issues.push({ code, message, path });
}

function objectValue(
  value: unknown,
  path: string,
  keys: readonly string[],
  context: ValidationContext,
): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(context, "invalid-value", path, "must be an object");
    return undefined;
  }
  const record = value as UnknownRecord;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      addIssue(context, "unknown-field", `${path}.${key}`, "is not part of contract version 0.1.0");
    }
  }
  return record;
}

function requiredString(
  record: UnknownRecord,
  key: string,
  path: string,
  context: ValidationContext,
  options: { readonly allowEmpty?: boolean; readonly maximumBytes?: number } = {},
): string | undefined {
  const value = record[key];
  const fieldPath = `${path}.${key}`;
  if (value === undefined) {
    addIssue(context, "missing-field", fieldPath, "is required");
    return undefined;
  }
  if (
    typeof value !== "string" ||
    (options.allowEmpty !== true && value.length === 0) ||
    !hasWellFormedUnicode(value)
  ) {
    addIssue(context, "invalid-value", fieldPath, "must be a well-formed Unicode string");
    return undefined;
  }
  if (
    options.maximumBytes !== undefined &&
    Buffer.byteLength(value, "utf8") > options.maximumBytes
  ) {
    addIssue(
      context,
      "resource-limit",
      fieldPath,
      `must not exceed ${String(options.maximumBytes)} UTF-8 bytes`,
    );
    return undefined;
  }
  return value;
}

function requiredIdentifier(
  record: UnknownRecord,
  key: string,
  path: string,
  context: ValidationContext,
): string | undefined {
  const value = requiredString(record, key, path, context);
  if (value !== undefined && !IDENTIFIER_PATTERN.test(value)) {
    addIssue(context, "invalid-value", `${path}.${key}`, "must be a stable identifier");
    return undefined;
  }
  return value;
}

function nullableString(
  record: UnknownRecord,
  key: string,
  path: string,
  context: ValidationContext,
): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    addIssue(context, "missing-field", `${path}.${key}`, "is required and must be explicit");
    return undefined;
  }
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !hasWellFormedUnicode(value) ||
    Buffer.byteLength(value, "utf8") > MAX_DIAGNOSTIC_TEXT_BYTES
  ) {
    addIssue(
      context,
      "invalid-value",
      `${path}.${key}`,
      `must be null or non-empty well-formed Unicode within ${String(MAX_DIAGNOSTIC_TEXT_BYTES)} UTF-8 bytes`,
    );
    return undefined;
  }
  return value;
}

function nullableIdentifier(
  record: UnknownRecord,
  key: string,
  path: string,
  context: ValidationContext,
): string | null | undefined {
  const value = nullableString(record, key, path, context);
  if (typeof value === "string" && !IDENTIFIER_PATTERN.test(value)) {
    addIssue(context, "invalid-value", `${path}.${key}`, "must be null or a stable identifier");
    return undefined;
  }
  return value;
}

function enumString(
  record: UnknownRecord,
  key: string,
  path: string,
  allowed: ReadonlySet<string>,
  context: ValidationContext,
): string | undefined {
  const value = requiredString(record, key, path, context);
  if (value !== undefined && !allowed.has(value)) {
    addIssue(context, "invalid-state", `${path}.${key}`, `has unsupported state '${value}'`);
    return undefined;
  }
  return value;
}

function requiredArray(
  record: UnknownRecord,
  key: string,
  path: string,
  context: ValidationContext,
  maximum: number,
  minimum = 0,
): readonly unknown[] | undefined {
  const value = record[key];
  const fieldPath = `${path}.${key}`;
  if (value === undefined) {
    addIssue(context, "missing-field", fieldPath, "is required");
    return undefined;
  }
  if (!Array.isArray(value)) {
    addIssue(context, "invalid-value", fieldPath, "must be an array");
    return undefined;
  }
  if (value.length < minimum)
    addIssue(
      context,
      "invalid-value",
      fieldPath,
      `must contain at least ${String(minimum)} item(s)`,
    );
  if (value.length > maximum) {
    addIssue(
      context,
      "resource-limit",
      fieldPath,
      `must not contain more than ${String(maximum)} items`,
    );
    return (value as readonly unknown[]).slice(0, maximum);
  }
  return value as readonly unknown[];
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validateCanonicalStringArray(
  values: readonly unknown[] | undefined,
  path: string,
  context: ValidationContext,
  requireIdentifier = true,
): readonly string[] {
  if (values === undefined) return [];
  const output: string[] = [];
  let previous: string | undefined;
  for (const [index, value] of values.entries()) {
    const itemPath = `${path}[${String(index)}]`;
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      !hasWellFormedUnicode(value) ||
      (requireIdentifier && !IDENTIFIER_PATTERN.test(value))
    ) {
      addIssue(
        context,
        "invalid-value",
        itemPath,
        requireIdentifier ? "must be a stable identifier" : "must be non-empty well-formed Unicode",
      );
      continue;
    }
    if (previous !== undefined && compareUtf8(previous, value) >= 0) {
      addIssue(
        context,
        previous === value ? "duplicate-id" : "invalid-order",
        itemPath,
        "must be unique and sorted by UTF-8 bytes",
      );
    }
    previous = value;
    output.push(value);
  }
  return output;
}

function validateUnorderedIdentifierArray(
  values: readonly unknown[] | undefined,
  path: string,
  context: ValidationContext,
): readonly string[] {
  if (values === undefined) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const itemPath = `${path}[${String(index)}]`;
    if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
      addIssue(context, "invalid-value", itemPath, "must be a stable identifier");
    } else if (seen.has(value)) {
      addIssue(context, "duplicate-id", itemPath, `duplicates '${value}'`);
    } else {
      seen.add(value);
      output.push(value);
    }
  }
  return output;
}

function validatePath(value: string | undefined, path: string, context: ValidationContext): void {
  if (value !== undefined && !isRepositoryRelativePath(value)) {
    addIssue(context, "invalid-path", path, "must be a canonical repository-relative path");
  }
}

function validateDigest(value: string | undefined, path: string, context: ValidationContext): void {
  if (value !== undefined && !SHA256_PATTERN.test(value)) {
    addIssue(context, "invalid-digest", path, "must be a lowercase SHA-256 digest");
  }
}

function validateLocation(
  value: unknown,
  path: string,
  context: ValidationContext,
): DiagnosticSourceLocation | undefined {
  const record = objectValue(value, path, ["sourceId", "path", "sourceDigest", "range"], context);
  if (record === undefined) return undefined;
  const sourceId = requiredIdentifier(record, "sourceId", path, context);
  const sourcePath = requiredString(record, "path", path, context);
  const sourceDigest = requiredString(record, "sourceDigest", path, context);
  validatePath(sourcePath, `${path}.path`, context);
  validateDigest(sourceDigest, `${path}.sourceDigest`, context);
  if (record["range"] === undefined)
    addIssue(context, "missing-field", `${path}.range`, "is required");
  if (
    sourceId === undefined ||
    sourcePath === undefined ||
    sourceDigest === undefined ||
    record["range"] === undefined
  )
    return undefined;
  const source = context.sources.get(sourceId);
  if (source === undefined) {
    addIssue(
      context,
      "invalid-relationship",
      `${path}.sourceId`,
      "references an unknown B03 source document",
    );
    return undefined;
  }
  if (source.path !== sourcePath)
    addIssue(context, "invalid-relationship", `${path}.path`, "does not match the B03 source path");
  if (source.sha256 !== sourceDigest)
    addIssue(
      context,
      "invalid-digest",
      `${path}.sourceDigest`,
      "does not match the B03 source digest",
    );
  const rangeResult = validateSourceRange(source, record["range"]);
  if (!rangeResult.ok) {
    for (const issue of rangeResult.issues) {
      addIssue(
        context,
        "invalid-range",
        `${path}.range${issue.path.replace(/^\$\.range/, "")}`,
        issue.message,
      );
    }
    return undefined;
  }
  return {
    sourceId: sourceId as DiagnosticSourceLocation["sourceId"],
    path: sourcePath as DiagnosticSourceLocation["path"],
    sourceDigest,
    range: rangeResult.value,
  };
}

function validateLocations(
  values: readonly unknown[] | undefined,
  path: string,
  context: ValidationContext,
): readonly DiagnosticSourceLocation[] {
  if (values === undefined) return [];
  const output: DiagnosticSourceLocation[] = [];
  for (const [index, value] of values.entries()) {
    const location = validateLocation(value, `${path}[${String(index)}]`, context);
    if (location !== undefined) output.push(location);
  }
  return output;
}

function validateDate(value: string | undefined, path: string, context: ValidationContext): void {
  if (value === undefined) return;
  if (!DATE_PATTERN.test(value)) {
    addIssue(context, "invalid-date", path, "must be an ISO 8601 calendar date");
    return;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    addIssue(context, "invalid-date", path, "must be a real ISO 8601 calendar date");
  }
}

function validateHttpsUrl(
  value: string | undefined,
  path: string,
  context: ValidationContext,
): void {
  if (value === undefined) return;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "")
      throw new TypeError();
  } catch {
    addIssue(context, "invalid-value", path, "must be an HTTPS URL without embedded credentials");
  }
}

function validateEvidence(
  value: unknown,
  path: string,
  context: ValidationContext,
): RelatedEvidence | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(context, "invalid-value", path, "must be an object");
    return undefined;
  }
  const raw = value as UnknownRecord;
  const kind = raw["kind"];
  const keys =
    kind === "source"
      ? ["id", "kind", "label", "location"]
      : kind === "repository-fact"
        ? [
            "id",
            "kind",
            "label",
            "collectorId",
            "factId",
            "subjectPath",
            "valueDigest",
            "locations",
          ]
        : kind === "resolution"
          ? [
              "id",
              "kind",
              "label",
              "profileId",
              "surfaceId",
              "specSnapshotId",
              "eventIds",
              "targetIds",
              "activationRuleIds",
              "sourceLocations",
              "evidenceRefs",
              "uncertainty",
            ]
          : [
              "id",
              "kind",
              "label",
              "specSnapshotId",
              "evidenceRefId",
              "factId",
              "url",
              "retrievedAt",
              "revision",
            ];
  const record = objectValue(value, path, keys, context);
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, context);
  registerEntityId(id, `${path}.id`, context);
  const evidenceKind = enumString(record, "kind", path, EVIDENCE_KIND_SET, context);
  requiredString(record, "label", path, context, { maximumBytes: MAX_DIAGNOSTIC_TEXT_BYTES });

  if (evidenceKind === "source") {
    if (record["location"] === undefined)
      addIssue(context, "missing-field", `${path}.location`, "is required");
    else validateLocation(record["location"], `${path}.location`, context);
  } else if (evidenceKind === "repository-fact") {
    requiredIdentifier(record, "collectorId", path, context);
    requiredIdentifier(record, "factId", path, context);
    const subjectPath = record["subjectPath"];
    if (subjectPath !== null && typeof subjectPath !== "string")
      addIssue(context, "invalid-value", `${path}.subjectPath`, "must be null or a path");
    else if (typeof subjectPath === "string")
      validatePath(subjectPath, `${path}.subjectPath`, context);
    if (subjectPath === undefined)
      addIssue(context, "missing-field", `${path}.subjectPath`, "is required and must be explicit");
    validateDigest(
      requiredString(record, "valueDigest", path, context),
      `${path}.valueDigest`,
      context,
    );
    validateLocations(
      requiredArray(record, "locations", path, context, MAX_RELATED_EVIDENCE_PER_DIAGNOSTIC),
      `${path}.locations`,
      context,
    );
  } else if (evidenceKind === "resolution") {
    requiredIdentifier(record, "profileId", path, context);
    requiredIdentifier(record, "surfaceId", path, context);
    requiredIdentifier(record, "specSnapshotId", path, context);
    validateUnorderedIdentifierArray(
      requiredArray(record, "eventIds", path, context, 1_024),
      `${path}.eventIds`,
      context,
    );
    validateCanonicalStringArray(
      requiredArray(record, "targetIds", path, context, 1_024),
      `${path}.targetIds`,
      context,
    );
    validateCanonicalStringArray(
      requiredArray(record, "activationRuleIds", path, context, 1_024),
      `${path}.activationRuleIds`,
      context,
    );
    validateLocations(
      requiredArray(record, "sourceLocations", path, context, MAX_RELATED_EVIDENCE_PER_DIAGNOSTIC),
      `${path}.sourceLocations`,
      context,
    );
    const refs = requiredArray(record, "evidenceRefs", path, context, 1_024);
    for (const [index, refValue] of (refs ?? []).entries()) {
      const refPath = `${path}.evidenceRefs[${String(index)}]`;
      const ref = objectValue(refValue, refPath, ["evidenceRefId", "factId"], context);
      if (ref !== undefined) {
        requiredIdentifier(ref, "evidenceRefId", refPath, context);
        nullableIdentifier(ref, "factId", refPath, context);
      }
    }
    if (record["uncertainty"] === undefined)
      addIssue(context, "missing-field", `${path}.uncertainty`, "is required");
    else
      validateUncertaintyValue(
        record["uncertainty"],
        `${path}.uncertainty`,
        (code, issuePath, message) => {
          addIssue(context, code, issuePath, message);
        },
        { maximumTextBytes: MAX_DIAGNOSTIC_TEXT_BYTES },
      );
  } else if (evidenceKind === "spec") {
    requiredIdentifier(record, "specSnapshotId", path, context);
    requiredIdentifier(record, "evidenceRefId", path, context);
    nullableIdentifier(record, "factId", path, context);
    validateHttpsUrl(requiredString(record, "url", path, context), `${path}.url`, context);
    const retrievedAt = requiredString(record, "retrievedAt", path, context);
    validateDate(retrievedAt, `${path}.retrievedAt`, context);
    nullableString(record, "revision", path, context);
  }
  return id === undefined ? undefined : (value as RelatedEvidence);
}

function validateEvidenceArray(
  values: readonly unknown[] | undefined,
  path: string,
  context: ValidationContext,
): readonly RelatedEvidence[] {
  if (values === undefined) return [];
  const output: RelatedEvidence[] = [];
  for (const [index, value] of values.entries()) {
    const itemPath = `${path}[${String(index)}]`;
    const evidence = validateEvidence(value, itemPath, context);
    if (evidence !== undefined) output.push(evidence);
  }
  return output;
}

function operationSortKey(operation: FixOperation): string {
  if (operation.kind === "create-document") return `${operation.path}\0create-document`;
  if (operation.kind === "move-document")
    return `${operation.path}\0move-document\0${operation.destinationPath}`;
  return `${operation.path}\0text-edit\0${String(operation.range.start.utf16Offset).padStart(16, "0")}`;
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  if (left.sourceId !== right.sourceId) return false;
  const leftStart = left.start.utf16Offset;
  const leftEnd = left.end.utf16Offset;
  const rightStart = right.start.utf16Offset;
  const rightEnd = right.end.utf16Offset;
  if (leftStart === rightStart) return true;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function validateFixOperation(
  value: unknown,
  path: string,
  context: ValidationContext,
): FixOperation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(context, "invalid-value", path, "must be an object");
    return undefined;
  }
  const raw = value as UnknownRecord;
  const kind = raw["kind"];
  const keys =
    kind === "text-edit"
      ? ["kind", "sourceId", "path", "sourceDigest", "range", "newText"]
      : kind === "move-document"
        ? ["kind", "sourceId", "path", "sourceDigest", "destinationPath", "destinationPrecondition"]
        : ["kind", "path", "destinationPrecondition", "content", "contentDigest"];
  const record = objectValue(value, path, keys, context);
  if (record === undefined) return undefined;
  const operationKind = enumString(record, "kind", path, FIX_KIND_SET, context);
  const operationPath = requiredString(record, "path", path, context);
  validatePath(operationPath, `${path}.path`, context);
  if (operationKind === "create-document") {
    const precondition = requiredString(record, "destinationPrecondition", path, context);
    if (precondition !== undefined && precondition !== "absent")
      addIssue(context, "invalid-state", `${path}.destinationPrecondition`, "must be 'absent'");
    const content = requiredString(record, "content", path, context, {
      allowEmpty: true,
      maximumBytes: MAX_FIX_TEXT_BYTES,
    });
    const digest = requiredString(record, "contentDigest", path, context);
    validateDigest(digest, `${path}.contentDigest`, context);
    if (
      content !== undefined &&
      digest !== undefined &&
      createHash("sha256").update(content).digest("hex") !== digest
    ) {
      addIssue(
        context,
        "invalid-digest",
        `${path}.contentDigest`,
        "does not match create-document content",
      );
    }
    return operationPath === undefined ? undefined : (value as FixOperation);
  }
  const sourceId = requiredIdentifier(record, "sourceId", path, context);
  const sourceDigest = requiredString(record, "sourceDigest", path, context);
  validateDigest(sourceDigest, `${path}.sourceDigest`, context);
  const source = sourceId === undefined ? undefined : context.sources.get(sourceId);
  if (sourceId !== undefined && source === undefined)
    addIssue(
      context,
      "invalid-relationship",
      `${path}.sourceId`,
      "references an unknown B03 source document",
    );
  if (source !== undefined && operationPath !== source.path)
    addIssue(context, "invalid-relationship", `${path}.path`, "does not match the B03 source path");
  if (source !== undefined && sourceDigest !== source.sha256)
    addIssue(
      context,
      "invalid-digest",
      `${path}.sourceDigest`,
      "does not match the B03 source digest",
    );
  if (operationKind === "text-edit") {
    requiredString(record, "newText", path, context, {
      allowEmpty: true,
      maximumBytes: MAX_FIX_TEXT_BYTES,
    });
    if (record["range"] === undefined)
      addIssue(context, "missing-field", `${path}.range`, "is required");
    else if (source !== undefined) {
      const range = validateSourceRange(source, record["range"]);
      if (!range.ok)
        for (const issue of range.issues)
          addIssue(
            context,
            "invalid-range",
            `${path}.range${issue.path.replace(/^\$\.range/, "")}`,
            issue.message,
          );
    }
  } else if (operationKind === "move-document") {
    const destination = requiredString(record, "destinationPath", path, context);
    validatePath(destination, `${path}.destinationPath`, context);
    if (destination !== undefined && destination === operationPath)
      addIssue(
        context,
        "invalid-path",
        `${path}.destinationPath`,
        "must differ from the source path",
      );
    const precondition = requiredString(record, "destinationPrecondition", path, context);
    if (precondition !== undefined && precondition !== "absent")
      addIssue(context, "invalid-state", `${path}.destinationPrecondition`, "must be 'absent'");
  }
  return operationKind === undefined || operationPath === undefined
    ? undefined
    : (value as FixOperation);
}

function validateFixPlan(
  value: unknown,
  path: string,
  context: ValidationContext,
): AtomicFixPlan | undefined {
  const record = objectValue(
    value,
    path,
    ["id", "title", "safety", "application", "operations"],
    context,
  );
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, context);
  registerEntityId(id, `${path}.id`, context);
  requiredString(record, "title", path, context, { maximumBytes: MAX_DIAGNOSTIC_TEXT_BYTES });
  const safety = requiredString(record, "safety", path, context);
  if (safety !== undefined && safety !== "mechanical")
    addIssue(context, "invalid-state", `${path}.safety`, "must be 'mechanical'");
  const application = requiredString(record, "application", path, context);
  if (application !== undefined && application !== "atomic")
    addIssue(context, "invalid-state", `${path}.application`, "must be 'atomic'");
  const values = requiredArray(record, "operations", path, context, MAX_FIX_OPERATIONS_PER_PLAN, 1);
  const operations: FixOperation[] = [];
  for (const [index, operationValue] of (values ?? []).entries()) {
    const operation = validateFixOperation(
      operationValue,
      `${path}.operations[${String(index)}]`,
      context,
    );
    if (operation !== undefined) operations.push(operation);
  }
  const destinations = new Set<string>();
  const knownSourcePaths = new Set(
    [...context.sources.values()].map((source) => source.path as string),
  );
  const movedSources = new Set<string>();
  const editedSources = new Set<string>();
  const editsBySource = new Map<string, { readonly path: string; readonly range: SourceRange }[]>();
  let previousKey: string | undefined;
  for (const [index, operation] of operations.entries()) {
    const itemPath = `${path}.operations[${String(index)}]`;
    const key = operationSortKey(operation);
    if (previousKey !== undefined && compareUtf8(previousKey, key) >= 0)
      addIssue(
        context,
        "invalid-order",
        itemPath,
        "operations must have unique canonical path/kind/range order",
      );
    previousKey = key;
    if (operation.kind === "create-document" || operation.kind === "move-document") {
      const destination =
        operation.kind === "create-document" ? operation.path : operation.destinationPath;
      const destinationPath =
        operation.kind === "create-document" ? `${itemPath}.path` : `${itemPath}.destinationPath`;
      if (knownSourcePaths.has(destination))
        addIssue(
          context,
          "invalid-relationship",
          destinationPath,
          `destination '${destination}' is an existing B03 source and cannot satisfy the absent precondition`,
        );
      if (destinations.has(destination))
        addIssue(
          context,
          "invalid-relationship",
          itemPath,
          `duplicates destination '${destination}'`,
        );
      destinations.add(destination);
    }
    if (operation.kind === "move-document") {
      if (movedSources.has(operation.sourceId)) {
        addIssue(
          context,
          "invalid-relationship",
          itemPath,
          `duplicates move source '${operation.sourceId}'`,
        );
      }
      movedSources.add(operation.sourceId);
    }
    if (operation.kind === "text-edit") {
      editedSources.add(operation.sourceId);
      const edits = editsBySource.get(operation.sourceId) ?? [];
      for (const prior of edits)
        if (rangesOverlap(prior.range, operation.range))
          addIssue(context, "overlapping-edit", `${itemPath}.range`, `overlaps ${prior.path}`);
      edits.push({ path: `${itemPath}.range`, range: operation.range });
      editsBySource.set(operation.sourceId, edits);
    }
  }
  for (const sourceId of movedSources)
    if (editedSources.has(sourceId))
      addIssue(
        context,
        "invalid-relationship",
        `${path}.operations`,
        `source '${sourceId}' cannot be edited and moved in one plan`,
      );
  return id === undefined ? undefined : (value as AtomicFixPlan);
}

function validateFingerprintBasis(
  value: unknown,
  path: string,
  context: ValidationContext,
): {
  readonly pathBasis?: PathFingerprintBasis;
  readonly semanticBasis?: SemanticFingerprintBasis;
} {
  const record = objectValue(value, path, ["path", "semantic"], context);
  if (record === undefined) return {};
  const pathRecord = objectValue(record["path"], `${path}.path`, ["anchor", "profileIds"], context);
  let pathBasis: PathFingerprintBasis | undefined;
  if (pathRecord !== undefined) {
    const anchor = requiredString(pathRecord, "anchor", `${path}.path`, context, {
      maximumBytes: MAX_DIAGNOSTIC_TEXT_BYTES,
    });
    const profileIds = validateCanonicalStringArray(
      requiredArray(pathRecord, "profileIds", `${path}.path`, context, 128),
      `${path}.path.profileIds`,
      context,
    );
    if (anchor !== undefined) pathBasis = { anchor, profileIds };
  }
  const semanticRecord = objectValue(
    record["semantic"],
    `${path}.semantic`,
    ["components", "profileIds"],
    context,
  );
  let semanticBasis: SemanticFingerprintBasis | undefined;
  if (semanticRecord !== undefined) {
    const componentValues = requiredArray(
      semanticRecord,
      "components",
      `${path}.semantic`,
      context,
      128,
      1,
    );
    const components: FingerprintComponent[] = [];
    let previousKey: string | undefined;
    for (const [index, componentValue] of (componentValues ?? []).entries()) {
      const componentPath = `${path}.semantic.components[${String(index)}]`;
      const component = objectValue(componentValue, componentPath, ["key", "value"], context);
      if (component === undefined) continue;
      const key = requiredIdentifier(component, "key", componentPath, context);
      const componentValueText = requiredString(component, "value", componentPath, context, {
        maximumBytes: MAX_DIAGNOSTIC_TEXT_BYTES,
      });
      if (key !== undefined && previousKey !== undefined && compareUtf8(previousKey, key) >= 0)
        addIssue(
          context,
          previousKey === key ? "duplicate-id" : "invalid-order",
          `${componentPath}.key`,
          "component keys must be unique and sorted by UTF-8 bytes",
        );
      if (key !== undefined) previousKey = key;
      if (key !== undefined && componentValueText !== undefined)
        components.push({ key, value: componentValueText });
    }
    const profileIds = validateCanonicalStringArray(
      requiredArray(semanticRecord, "profileIds", `${path}.semantic`, context, 128),
      `${path}.semantic.profileIds`,
      context,
    );
    semanticBasis = { components, profileIds };
  }
  return {
    ...(pathBasis === undefined ? {} : { pathBasis }),
    ...(semanticBasis === undefined ? {} : { semanticBasis }),
  };
}

function fingerprintValue(
  value: unknown,
  path: string,
  method: string,
  context: ValidationContext,
): string | undefined {
  const record = objectValue(value, path, ["method", "value"], context);
  if (record === undefined) return undefined;
  const actualMethod = requiredString(record, "method", path, context);
  if (actualMethod !== undefined && actualMethod !== method)
    addIssue(context, "invalid-state", `${path}.method`, `must be '${method}'`);
  const fingerprint = requiredString(record, "value", path, context);
  if (fingerprint !== undefined && !FINGERPRINT_PATTERN.test(fingerprint))
    addIssue(
      context,
      "invalid-fingerprint",
      `${path}.value`,
      "must be a lowercase SHA-256 fingerprint",
    );
  return fingerprint;
}

function validateDiagnostic(
  value: unknown,
  path: string,
  context: ValidationContext,
): string | undefined {
  const record = objectValue(
    value,
    path,
    [
      "id",
      "ruleId",
      "ruleVersion",
      "severity",
      "message",
      "primary",
      "related",
      "suggestion",
      "fingerprintBasis",
      "fingerprints",
    ],
    context,
  );
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, context);
  registerEntityId(id, `${path}.id`, context);
  const ruleId = requiredIdentifier(record, "ruleId", path, context);
  const ruleVersion = requiredIdentifier(record, "ruleVersion", path, context);
  enumString(record, "severity", path, SEVERITY_SET, context);
  requiredString(record, "message", path, context, { maximumBytes: MAX_DIAGNOSTIC_TEXT_BYTES });
  const primary =
    record["primary"] === undefined
      ? (addIssue(context, "missing-field", `${path}.primary`, "is required"), undefined)
      : validateLocation(record["primary"], `${path}.primary`, context);
  validateEvidenceArray(
    requiredArray(record, "related", path, context, MAX_RELATED_EVIDENCE_PER_DIAGNOSTIC),
    `${path}.related`,
    context,
  );
  const suggestion = record["suggestion"];
  if (suggestion === undefined)
    addIssue(context, "missing-field", `${path}.suggestion`, "is required and must be explicit");
  else if (suggestion !== null) {
    const suggestionRecord = objectValue(
      suggestion,
      `${path}.suggestion`,
      ["message", "fixPlan"],
      context,
    );
    if (suggestionRecord !== undefined) {
      requiredString(suggestionRecord, "message", `${path}.suggestion`, context, {
        maximumBytes: MAX_DIAGNOSTIC_TEXT_BYTES,
      });
      if (suggestionRecord["fixPlan"] === undefined)
        addIssue(
          context,
          "missing-field",
          `${path}.suggestion.fixPlan`,
          "is required and must be explicit",
        );
      else if (suggestionRecord["fixPlan"] !== null)
        validateFixPlan(suggestionRecord["fixPlan"], `${path}.suggestion.fixPlan`, context);
    }
  }
  const basis =
    record["fingerprintBasis"] === undefined
      ? (addIssue(context, "missing-field", `${path}.fingerprintBasis`, "is required"), {})
      : validateFingerprintBasis(record["fingerprintBasis"], `${path}.fingerprintBasis`, context);
  const fingerprints = objectValue(
    record["fingerprints"],
    `${path}.fingerprints`,
    ["path", "semantic"],
    context,
  );
  const pathFingerprint =
    fingerprints === undefined
      ? undefined
      : fingerprintValue(
          fingerprints["path"],
          `${path}.fingerprints.path`,
          PATH_FINGERPRINT_METHOD,
          context,
        );
  const semanticFingerprint =
    fingerprints === undefined
      ? undefined
      : fingerprintValue(
          fingerprints["semantic"],
          `${path}.fingerprints.semantic`,
          SEMANTIC_FINGERPRINT_METHOD,
          context,
        );
  if (
    ruleId !== undefined &&
    ruleVersion !== undefined &&
    primary !== undefined &&
    basis.pathBasis !== undefined &&
    pathFingerprint !== undefined
  ) {
    try {
      const expected = computePathFingerprint({
        ruleId,
        ruleVersion,
        path: primary.path,
        basis: basis.pathBasis,
      });
      if (expected !== pathFingerprint)
        addIssue(
          context,
          "invalid-fingerprint",
          `${path}.fingerprints.path.value`,
          "does not match the versioned path fingerprint basis",
        );
      else context.pathFingerprints.add(pathFingerprint);
    } catch {
      addIssue(
        context,
        "invalid-fingerprint",
        `${path}.fingerprintBasis.path`,
        "cannot be encoded by the path fingerprint method",
      );
    }
  }
  if (
    ruleId !== undefined &&
    ruleVersion !== undefined &&
    basis.semanticBasis !== undefined &&
    semanticFingerprint !== undefined
  ) {
    try {
      const expected = computeSemanticFingerprint({
        ruleId,
        ruleVersion,
        basis: basis.semanticBasis,
      });
      if (expected !== semanticFingerprint)
        addIssue(
          context,
          "invalid-fingerprint",
          `${path}.fingerprints.semantic.value`,
          "does not match the versioned semantic fingerprint basis",
        );
    } catch {
      addIssue(
        context,
        "invalid-fingerprint",
        `${path}.fingerprintBasis.semantic`,
        "cannot be encoded by the semantic fingerprint method",
      );
    }
  }
  return id;
}

function validateSuppression(
  value: unknown,
  path: string,
  context: ValidationContext,
): string | undefined {
  const record = objectValue(
    value,
    path,
    ["id", "state", "directive", "targetRuleIds", "reason", "matchedPathFingerprints", "evidence"],
    context,
  );
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, context);
  registerEntityId(id, `${path}.id`, context);
  const state = enumString(record, "state", path, SUPPRESSION_STATE_SET, context);
  if (record["directive"] === undefined)
    addIssue(context, "missing-field", `${path}.directive`, "is required");
  else validateLocation(record["directive"], `${path}.directive`, context);
  validateCanonicalStringArray(
    requiredArray(record, "targetRuleIds", path, context, 1_024, 1),
    `${path}.targetRuleIds`,
    context,
  );
  nullableString(record, "reason", path, context);
  const fingerprints = requiredArray(record, "matchedPathFingerprints", path, context, 10_000);
  const matched = validateCanonicalStringArray(
    fingerprints,
    `${path}.matchedPathFingerprints`,
    context,
    false,
  );
  for (const [index, fingerprint] of matched.entries())
    if (!FINGERPRINT_PATTERN.test(fingerprint))
      addIssue(
        context,
        "invalid-fingerprint",
        `${path}.matchedPathFingerprints[${String(index)}]`,
        "must be a lowercase SHA-256 fingerprint",
      );
    else if (!context.pathFingerprints.has(fingerprint))
      addIssue(
        context,
        "invalid-relationship",
        `${path}.matchedPathFingerprints[${String(index)}]`,
        "does not identify a diagnostic in this bundle",
      );
  validateEvidenceArray(
    requiredArray(record, "evidence", path, context, MAX_RELATED_EVIDENCE_PER_DIAGNOSTIC),
    `${path}.evidence`,
    context,
  );
  if (state === "suppressed" && matched.length === 0)
    addIssue(
      context,
      "invalid-state",
      `${path}.matchedPathFingerprints`,
      "suppressed directives must identify at least one diagnostic",
    );
  if ((state === "applicable" || state === "unused") && matched.length !== 0)
    addIssue(
      context,
      "invalid-state",
      `${path}.matchedPathFingerprints`,
      `${state} directives cannot identify suppressed diagnostics`,
    );
  return id;
}

function sourceRegistry(
  sources: readonly SourceDocument[],
  issues: DiagnosticContractValidationIssue[],
): ReadonlyMap<string, SourceDocument> {
  const context: ValidationContext = {
    entityIds: new Map(),
    issues,
    pathFingerprints: new Set(),
    sources: new Map(),
  };
  const output = new Map<string, SourceDocument>();
  if (sources.length > MAX_DIAGNOSTICS_PER_BUNDLE)
    addIssue(
      context,
      "resource-limit",
      "$sources",
      `must not contain more than ${String(MAX_DIAGNOSTICS_PER_BUNDLE)} sources`,
    );
  for (const [index, source] of sources.slice(0, MAX_DIAGNOSTICS_PER_BUNDLE).entries()) {
    const sourcePath = `$sources[${String(index)}]`;
    const candidate: unknown = source;
    if (candidate === null || typeof candidate !== "object") {
      addIssue(context, "invalid-value", sourcePath, "must be a B03 source document");
      continue;
    }
    const id = (candidate as { readonly id?: unknown }).id;
    if (typeof id !== "string" || !IDENTIFIER_PATTERN.test(id)) {
      addIssue(context, "invalid-value", `${sourcePath}.id`, "must be a stable B03 source ID");
    } else if (output.has(id)) {
      addIssue(context, "duplicate-id", `${sourcePath}.id`, `duplicates B03 source '${id}'`);
    } else {
      output.set(id, candidate as SourceDocument);
    }
  }
  return output;
}

function validateBundleValue(
  input: unknown,
  sources: readonly SourceDocument[],
  issues: DiagnosticContractValidationIssue[],
): DiagnosticContractValidationResult {
  const preflightContext: ValidationContext = {
    entityIds: new Map(),
    issues,
    pathFingerprints: new Set(),
    sources: new Map(),
  };
  const sourcesSafe = validateJsonValue(
    sources,
    "$sources",
    (code, issuePath, message) => {
      addIssue(
        preflightContext,
        code === "resource-limit" ? code : "invalid-json",
        issuePath,
        message,
      );
    },
    DIAGNOSTIC_JSON_LIMITS,
  );
  if (!sourcesSafe) return { ok: false, issues };
  const registry = sourceRegistry(sources, issues);
  const context: ValidationContext = {
    entityIds: new Map(),
    issues,
    pathFingerprints: new Set(),
    sources: registry,
  };
  const inputSafe = validateJsonValue(
    input,
    "$",
    (code, issuePath, message) => {
      addIssue(context, code === "resource-limit" ? code : "invalid-json", issuePath, message);
    },
    DIAGNOSTIC_JSON_LIMITS,
  );
  if (!inputSafe) return { ok: false, issues };
  const record = objectValue(
    input,
    "$",
    ["recordKind", "contractVersion", "diagnostics", "suppressions"],
    context,
  );
  if (record === undefined) return { ok: false, issues };
  const recordKind = requiredString(record, "recordKind", "$", context);
  if (recordKind !== undefined && recordKind !== "agent-context-diagnostics")
    addIssue(context, "invalid-state", "$.recordKind", "must be 'agent-context-diagnostics'");
  const version = requiredString(record, "contractVersion", "$", context);
  if (version !== undefined && version !== DIAGNOSTIC_CONTRACT_VERSION)
    addIssue(
      context,
      "invalid-state",
      "$.contractVersion",
      `must be '${DIAGNOSTIC_CONTRACT_VERSION}'`,
    );
  const diagnosticValues = requiredArray(
    record,
    "diagnostics",
    "$",
    context,
    MAX_DIAGNOSTICS_PER_BUNDLE,
  );
  for (const [index, diagnosticValue] of (diagnosticValues ?? []).entries()) {
    const itemPath = `$.diagnostics[${String(index)}]`;
    validateDiagnostic(diagnosticValue, itemPath, context);
  }
  const suppressionValues = requiredArray(
    record,
    "suppressions",
    "$",
    context,
    MAX_SUPPRESSIONS_PER_BUNDLE,
  );
  for (const [index, suppressionValue] of (suppressionValues ?? []).entries()) {
    const itemPath = `$.suppressions[${String(index)}]`;
    validateSuppression(suppressionValue, itemPath, context);
  }
  return issues.length === 0
    ? { ok: true, value: input as DiagnosticBundle }
    : { ok: false, issues };
}

/** Validate the closed B04 envelope against exact source documents from a validated B03 IR. */
export function validateDiagnosticBundle(
  input: unknown,
  sources: readonly SourceDocument[],
): DiagnosticContractValidationResult {
  const issues: DiagnosticContractValidationIssue[] = [];
  try {
    return validateBundleValue(input, sources, issues);
  } catch (error) {
    if (error instanceof ValidationIssueLimitReached) return { ok: false, issues };
    return {
      ok: false,
      issues: [
        { code: "invalid-json", message: "input must be safely inspectable JSON data", path: "$" },
      ],
    };
  }
}

export function isDiagnosticBundle(
  input: unknown,
  sources: readonly SourceDocument[],
): input is DiagnosticBundle {
  return validateDiagnosticBundle(input, sources).ok;
}
