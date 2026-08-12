import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  REPOSITORY_ROOT,
  isRepositoryRelativePath,
  validateInstructionIr,
  type ActivationKind,
  type ActivationRuleId,
  type ClientProfileId,
  type InstructionIr,
  type InstructionDocumentId,
  type JsonValue,
  type RepositoryRelativePath,
  type ResolutionEvent,
  type ResolutionEventId,
  type ResolutionSetting,
  type ResolutionTarget,
  type ResolutionTargetId,
  type SpecSnapshotId,
  type SurfaceId,
  type Uncertainty,
} from "@agent-context/core";
import type {
  ActivationCallbacks,
  ActivationFactDecision,
  ConditionalActivationRequest,
  ManualActivationRequest,
} from "./activation-algebra.js";

export const RESOLUTION_EVENT_TRACE_CONTRACT_VERSION = "0.1.0" as const;

export interface ResolutionEventTraceLimits {
  readonly maxEvents: number;
  readonly maxInputTextBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxKnownRules: number;
  readonly maxRuleConditions: number;
  readonly maxSettingsPerEvent: number;
  readonly maxTargets: number;
  readonly maxTextBytes: number;
  readonly maxWorkspaceRoots: number;
}

export const RESOLUTION_EVENT_TRACE_LIMITS: Readonly<ResolutionEventTraceLimits> = Object.freeze({
  maxEvents: 16_384,
  maxInputTextBytes: 4_194_304,
  maxJsonDepth: 256,
  maxJsonNodes: 65_536,
  maxKnownRules: 4_096,
  maxRuleConditions: 1_024,
  maxSettingsPerEvent: 4_096,
  maxTargets: 4_096,
  maxTextBytes: 16_384,
  maxWorkspaceRoots: 4_096,
});

export const ResolutionEventTraceErrorCode: Readonly<{
  invalidEvent: "EVENT_TRACE_INVALID_EVENT";
  invalidInput: "EVENT_TRACE_INVALID_INPUT";
  invalidPath: "EVENT_TRACE_INVALID_PATH";
  invalidRelationship: "EVENT_TRACE_INVALID_RELATIONSHIP";
  invalidState: "EVENT_TRACE_INVALID_STATE";
  resourceLimit: "EVENT_TRACE_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidEvent: "EVENT_TRACE_INVALID_EVENT",
  invalidInput: "EVENT_TRACE_INVALID_INPUT",
  invalidPath: "EVENT_TRACE_INVALID_PATH",
  invalidRelationship: "EVENT_TRACE_INVALID_RELATIONSHIP",
  invalidState: "EVENT_TRACE_INVALID_STATE",
  resourceLimit: "EVENT_TRACE_RESOURCE_LIMIT",
} as const);

export type ResolutionEventTraceErrorCode =
  (typeof ResolutionEventTraceErrorCode)[keyof typeof ResolutionEventTraceErrorCode];

export class ResolutionEventTraceError extends Error {
  override readonly name = "ResolutionEventTraceError" as const;
  readonly code: ResolutionEventTraceErrorCode;
  override readonly cause: unknown;

  constructor(code: ResolutionEventTraceErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.cause = cause;
  }
}

/** Canonical, JSON-safe projection of the B03 target/event portion of an instruction IR. */
export interface ResolutionEventTrace {
  readonly recordKind: "agent-context-resolution-event-trace";
  readonly contractVersion: typeof RESOLUTION_EVENT_TRACE_CONTRACT_VERSION;
  readonly rules: readonly TraceActivationRuleDescriptor[];
  readonly targets: readonly ResolutionTarget[];
  readonly events: readonly ResolutionEvent[];
}

/** Rule-origin facts needed to bind a B03 selection event to one E01 dynamic predicate. */
export interface TraceActivationRuleDescriptor {
  readonly id: ActivationRuleId;
  readonly documentId: InstructionDocumentId;
  readonly profileId: ClientProfileId;
  readonly surfaceId: SurfaceId;
  readonly specSnapshotId: SpecSnapshotId;
  readonly kind: ActivationKind;
  readonly conditions: readonly string[];
}

export interface SyntheticTargetTraceInput {
  readonly launchCwd: RepositoryRelativePath;
  readonly workspaceRoots: readonly RepositoryRelativePath[];
  readonly targetPath: RepositoryRelativePath;
  readonly purpose: string;
  readonly settings?: readonly ResolutionSetting[];
  readonly targetEventKind?: "reference-path" | "read-path" | "write-path";
}

export interface TraceRuleSelectionEvidence {
  readonly eventId: ResolutionEventId;
  readonly sequence: number;
  readonly eventKind: "manual-rule-mention" | "rule-selection";
  readonly selectionSource: "profile" | "model" | "user" | "unknown" | null;
  readonly targetId: ResolutionTargetId | null;
  readonly uncertainty: Uncertainty;
}

export interface TraceRuleSelection {
  readonly state: "active" | "indeterminate";
  readonly ruleId: ActivationRuleId;
  readonly targetPath: RepositoryRelativePath;
  readonly evidence: readonly TraceRuleSelectionEvidence[];
  readonly reason: string;
}

export interface TraceRuleSelectionQuery {
  readonly rule: TraceActivationRuleDescriptor;
  readonly targetPath: RepositoryRelativePath;
  readonly mode: "manual" | "conditional";
}

export interface TraceSettingQuery {
  readonly key: string;
  readonly targetPath: RepositoryRelativePath;
}

export type TraceSettingResult =
  | {
      readonly state: "known";
      readonly key: string;
      readonly value: JsonValue;
      readonly eventId: ResolutionEventId;
      readonly sequence: number;
    }
  | {
      readonly state: "indeterminate";
      readonly key: string;
      readonly eventId: ResolutionEventId;
      readonly sequence: number;
      readonly reason: string;
    }
  | { readonly state: "unrecorded"; readonly key: string };

type DataRecord = Readonly<Record<string, unknown>>;

interface ValidationBudget {
  jsonNodes: number;
  textBytes: number;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/;
const PATH_EVENT_KINDS = new Set<string>([
  "reference-path",
  "read-path",
  "write-path",
  "list-directory",
  "directory-add",
]);
const PAYLOADLESS_EVENT_KINDS = new Set<string>([
  "memory-show",
  "memory-list",
  "memory-reload",
  "compact",
  "review-request",
  "review-push",
  "hosted-task-start",
  "client-restart",
]);
const SELECTION_SOURCES = new Set<string>(["profile", "model", "user", "unknown"]);
const ACTIVATION_KINDS = new Set<string>([
  "always",
  "directory-tree",
  "glob",
  "manual",
  "conditional",
  "unknown",
]);

function fail(code: ResolutionEventTraceErrorCode, message: string, cause?: unknown): never {
  throw new ResolutionEventTraceError(code, message, cause);
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isDataRecord(value: unknown): value is DataRecord {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function dataProperty(record: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function hasExactKeys(record: DataRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (!isDataRecord(value) || !hasExactKeys(value, keys)) {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      `${label} must be a closed regular data record`,
    );
  }
  return value;
}

function assertDenseArray(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(ResolutionEventTraceErrorCode.invalidInput, `${label} must be a regular dense array`);
  }
  if (value.length > maximum) {
    fail(
      ResolutionEventTraceErrorCode.resourceLimit,
      `${label} exceeds the limit of ${String(maximum)} items`,
    );
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1) {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      `${label} must not be sparse or have extra properties`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (ownKeys[index] !== key) {
      fail(
        ResolutionEventTraceErrorCode.invalidInput,
        `${label} must contain canonical array indices`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(
        ResolutionEventTraceErrorCode.invalidInput,
        `${label} must contain enumerable data properties`,
      );
    }
  }
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function addText(
  value: string,
  label: string,
  budget: ValidationBudget,
  allowEmpty = false,
): string {
  if ((!allowEmpty && value.length === 0) || !hasWellFormedUnicode(value)) {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      `${label} must be ${allowEmpty ? "a" : "a non-empty"} well-formed Unicode string`,
    );
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > RESOLUTION_EVENT_TRACE_LIMITS.maxTextBytes) {
    fail(
      ResolutionEventTraceErrorCode.resourceLimit,
      `${label} exceeds the ${String(RESOLUTION_EVENT_TRACE_LIMITS.maxTextBytes)} byte text limit`,
    );
  }
  budget.textBytes += bytes;
  if (budget.textBytes > RESOLUTION_EVENT_TRACE_LIMITS.maxInputTextBytes) {
    fail(
      ResolutionEventTraceErrorCode.resourceLimit,
      `event trace exceeds the ${String(RESOLUTION_EVENT_TRACE_LIMITS.maxInputTextBytes)} byte cumulative text limit`,
    );
  }
  return value;
}

function text(value: unknown, label: string, budget: ValidationBudget, allowEmpty = false): string {
  if (typeof value !== "string") {
    fail(ResolutionEventTraceErrorCode.invalidInput, `${label} must be a string`);
  }
  return addText(value, label, budget, allowEmpty);
}

function identifier(value: unknown, label: string, budget: ValidationBudget): string {
  const result = text(value, label, budget);
  if (!IDENTIFIER_PATTERN.test(result)) {
    fail(ResolutionEventTraceErrorCode.invalidInput, `${label} must be a stable B03 identifier`);
  }
  return result;
}

function path(value: unknown, label: string, budget: ValidationBudget): RepositoryRelativePath {
  const result = text(value, label, budget);
  if (!isRepositoryRelativePath(result)) {
    fail(
      ResolutionEventTraceErrorCode.invalidPath,
      `${label} must be a canonical B01 repository-relative path`,
    );
  }
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function normalizeJsonValue(
  value: unknown,
  label: string,
  budget: ValidationBudget,
  ancestors: Set<object>,
  depth: number,
): JsonValue {
  if (depth > RESOLUTION_EVENT_TRACE_LIMITS.maxJsonDepth) {
    fail(
      ResolutionEventTraceErrorCode.resourceLimit,
      `${label} exceeds the JSON nesting limit of ${String(RESOLUTION_EVENT_TRACE_LIMITS.maxJsonDepth)}`,
    );
  }
  budget.jsonNodes += 1;
  if (budget.jsonNodes > RESOLUTION_EVENT_TRACE_LIMITS.maxJsonNodes) {
    fail(
      ResolutionEventTraceErrorCode.resourceLimit,
      `event trace exceeds the JSON node limit of ${String(RESOLUTION_EVENT_TRACE_LIMITS.maxJsonNodes)}`,
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return addText(value, label, budget, true);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail(ResolutionEventTraceErrorCode.invalidInput, `${label} must be a finite JSON number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    fail(ResolutionEventTraceErrorCode.invalidInput, `${label} must be JSON-safe`);
  }
  if (nodeTypes.isProxy(value)) {
    fail(ResolutionEventTraceErrorCode.invalidInput, `${label} must not be a proxy`);
  }
  if (ancestors.has(value)) {
    fail(ResolutionEventTraceErrorCode.invalidInput, `${label} must not contain a cycle`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArray(value, label, RESOLUTION_EVENT_TRACE_LIMITS.maxJsonNodes);
      const output = value.map((entry, index) =>
        normalizeJsonValue(entry, `${label}[${String(index)}]`, budget, ancestors, depth + 1),
      );
      return Object.freeze(output);
    }
    if (!isDataRecord(value)) {
      fail(ResolutionEventTraceErrorCode.invalidInput, `${label} must be a plain JSON object`);
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      addText(key, `${label} key`, budget, true);
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: normalizeJsonValue(
          dataProperty(value, key),
          `${label}.${key}`,
          budget,
          ancestors,
          depth + 1,
        ),
        writable: false,
      });
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeUncertainty(
  value: unknown,
  label: string,
  budget: ValidationBudget,
): Uncertainty {
  if (!isDataRecord(value)) {
    fail(ResolutionEventTraceErrorCode.invalidInput, `${label} must be an uncertainty record`);
  }
  const state = dataProperty(value, "state");
  if (state === "known") {
    assertRecord(value, ["state"], label);
    return Object.freeze({ state });
  }
  if (state === "conditional") {
    assertRecord(value, ["state", "conditions"], label);
    const conditions = dataProperty(value, "conditions");
    assertDenseArray(conditions, `${label}.conditions`, RESOLUTION_EVENT_TRACE_LIMITS.maxEvents);
    if (conditions.length === 0) {
      fail(ResolutionEventTraceErrorCode.invalidState, `${label}.conditions must not be empty`);
    }
    const normalized = conditions.map((condition, index) =>
      text(condition, `${label}.conditions[${String(index)}]`, budget),
    );
    if (new Set(normalized).size !== normalized.length) {
      fail(ResolutionEventTraceErrorCode.invalidState, `${label}.conditions must be unique`);
    }
    return Object.freeze({
      state,
      conditions: Object.freeze(normalized.sort(compareCodeUnits)),
    });
  }
  if (state === "unknown") {
    assertRecord(value, ["state", "reason"], label);
    return Object.freeze({
      state,
      reason: text(dataProperty(value, "reason"), `${label}.reason`, budget),
    });
  }
  if (state === "contradiction") {
    assertRecord(value, ["state", "reason", "alternatives"], label);
    const alternatives = dataProperty(value, "alternatives");
    assertDenseArray(
      alternatives,
      `${label}.alternatives`,
      RESOLUTION_EVENT_TRACE_LIMITS.maxEvents,
    );
    if (alternatives.length < 2) {
      fail(
        ResolutionEventTraceErrorCode.invalidState,
        `${label}.alternatives must contain at least two entries`,
      );
    }
    const ids = new Set<string>();
    const normalized = alternatives.map((alternative, index) => {
      const entryLabel = `${label}.alternatives[${String(index)}]`;
      const record = assertRecord(alternative, ["id", "description"], entryLabel);
      const id = identifier(dataProperty(record, "id"), `${entryLabel}.id`, budget);
      if (ids.has(id)) {
        fail(
          ResolutionEventTraceErrorCode.invalidState,
          `${label}.alternatives must have unique IDs`,
        );
      }
      ids.add(id);
      return Object.freeze({
        id,
        description: text(dataProperty(record, "description"), `${entryLabel}.description`, budget),
      });
    });
    return Object.freeze({
      state,
      reason: text(dataProperty(value, "reason"), `${label}.reason`, budget),
      alternatives: Object.freeze(
        normalized.sort((left, right) => compareCodeUnits(left.id, right.id)),
      ),
    });
  }
  fail(ResolutionEventTraceErrorCode.invalidState, `${label}.state is not a B02 uncertainty state`);
}

function normalizeSettings(
  value: unknown,
  label: string,
  budget: ValidationBudget,
  requireNonEmpty: boolean,
): readonly ResolutionSetting[] {
  assertDenseArray(value, label, RESOLUTION_EVENT_TRACE_LIMITS.maxSettingsPerEvent);
  if (requireNonEmpty && value.length === 0) {
    fail(ResolutionEventTraceErrorCode.invalidState, `${label} must not be empty`);
  }
  const keys = new Set<string>();
  const normalized = value.map((setting, index) => {
    const entryLabel = `${label}[${String(index)}]`;
    const record = assertRecord(setting, ["key", "value"], entryLabel);
    const key = text(dataProperty(record, "key"), `${entryLabel}.key`, budget);
    if (/\p{Cc}/u.test(key)) {
      fail(
        ResolutionEventTraceErrorCode.invalidInput,
        `${entryLabel}.key contains a control character`,
      );
    }
    if (keys.has(key)) {
      fail(ResolutionEventTraceErrorCode.invalidState, `${label} contains duplicate key '${key}'`);
    }
    keys.add(key);
    return Object.freeze({
      key,
      value: normalizeJsonValue(
        dataProperty(record, "value"),
        `${entryLabel}.value`,
        budget,
        new Set(),
        0,
      ),
    });
  });
  return Object.freeze(normalized.sort((left, right) => compareCodeUnits(left.key, right.key)));
}

function normalizeTarget(
  value: unknown,
  index: number,
  budget: ValidationBudget,
): ResolutionTarget {
  const label = `targets[${String(index)}]`;
  const record = assertRecord(value, ["id", "path", "purpose"], label);
  const targetPath = path(dataProperty(record, "path"), `${label}.path`, budget);
  if (targetPath === REPOSITORY_ROOT) {
    fail(
      ResolutionEventTraceErrorCode.invalidPath,
      `${label}.path must identify a repository file`,
    );
  }
  return Object.freeze({
    id: identifier(dataProperty(record, "id"), `${label}.id`, budget) as ResolutionTargetId,
    path: targetPath,
    purpose: text(dataProperty(record, "purpose"), `${label}.purpose`, budget),
  });
}

function normalizeIdentifiers(
  value: unknown,
  label: string,
  budget: ValidationBudget,
  maximum: number,
  minimum = 0,
): readonly string[] {
  assertDenseArray(value, label, maximum);
  if (value.length < minimum) {
    fail(
      ResolutionEventTraceErrorCode.invalidState,
      `${label} must contain at least ${String(minimum)} item(s)`,
    );
  }
  const output = value.map((item, index) => identifier(item, `${label}[${String(index)}]`, budget));
  if (new Set(output).size !== output.length) {
    fail(ResolutionEventTraceErrorCode.invalidState, `${label} must contain unique identifiers`);
  }
  return Object.freeze(output.sort(compareCodeUnits));
}

function normalizeRuleDescriptor(
  value: unknown,
  label: string,
  budget: ValidationBudget,
): TraceActivationRuleDescriptor {
  const record = assertRecord(
    value,
    ["id", "documentId", "profileId", "surfaceId", "specSnapshotId", "kind", "conditions"],
    label,
  );
  const kind = text(dataProperty(record, "kind"), `${label}.kind`, budget);
  if (!ACTIVATION_KINDS.has(kind)) {
    fail(ResolutionEventTraceErrorCode.invalidState, `${label}.kind is not a B03 activation kind`);
  }
  const rawConditions = dataProperty(record, "conditions");
  assertDenseArray(
    rawConditions,
    `${label}.conditions`,
    RESOLUTION_EVENT_TRACE_LIMITS.maxRuleConditions,
  );
  const conditions = rawConditions.map((condition, index) =>
    text(condition, `${label}.conditions[${String(index)}]`, budget),
  );
  if (new Set(conditions).size !== conditions.length) {
    fail(ResolutionEventTraceErrorCode.invalidState, `${label}.conditions must be unique`);
  }
  if (kind === "always" && conditions.length > 0) {
    fail(ResolutionEventTraceErrorCode.invalidState, `${label} always rule cannot have conditions`);
  }
  if (kind === "conditional" && conditions.length === 0) {
    fail(
      ResolutionEventTraceErrorCode.invalidState,
      `${label} conditional rule requires conditions`,
    );
  }
  return Object.freeze({
    id: identifier(dataProperty(record, "id"), `${label}.id`, budget) as ActivationRuleId,
    documentId: identifier(
      dataProperty(record, "documentId"),
      `${label}.documentId`,
      budget,
    ) as InstructionDocumentId,
    profileId: identifier(dataProperty(record, "profileId"), `${label}.profileId`, budget),
    surfaceId: identifier(dataProperty(record, "surfaceId"), `${label}.surfaceId`, budget),
    specSnapshotId: identifier(
      dataProperty(record, "specSnapshotId"),
      `${label}.specSnapshotId`,
      budget,
    ),
    kind: kind as ActivationKind,
    conditions: Object.freeze(conditions),
  });
}

function sameRuleDescriptor(
  left: TraceActivationRuleDescriptor,
  right: TraceActivationRuleDescriptor,
): boolean {
  return (
    left.id === right.id &&
    left.documentId === right.documentId &&
    left.profileId === right.profileId &&
    left.surfaceId === right.surfaceId &&
    left.specSnapshotId === right.specSnapshotId &&
    left.kind === right.kind &&
    left.conditions.length === right.conditions.length &&
    left.conditions.every((condition, index) => condition === right.conditions[index])
  );
}

function normalizeEvent(
  value: unknown,
  index: number,
  targetIds: ReadonlySet<string>,
  knownRuleIds: ReadonlySet<string>,
  budget: ValidationBudget,
): ResolutionEvent {
  const label = `events[${String(index)}]`;
  if (!isDataRecord(value)) {
    fail(ResolutionEventTraceErrorCode.invalidEvent, `${label} must be a regular data record`);
  }
  const kindValue = dataProperty(value, "kind");
  const kind = text(kindValue, `${label}.kind`, budget);
  const payloadKeys =
    kind === "launch"
      ? ["path", "workspaceRoots", "settings"]
      : PATH_EVENT_KINDS.has(kind)
        ? ["path"]
        : kind === "manual-rule-mention"
          ? ["ruleId"]
          : kind === "rule-selection"
            ? ["ruleIds", "selectionSource"]
            : kind === "settings-change"
              ? ["settings"]
              : PAYLOADLESS_EVENT_KINDS.has(kind)
                ? []
                : undefined;
  if (payloadKeys === undefined) {
    fail(ResolutionEventTraceErrorCode.invalidEvent, `${label}.kind is not a B03 event kind`);
  }
  if (!hasExactKeys(value, ["id", "sequence", "kind", "targetId", "uncertainty", ...payloadKeys])) {
    fail(ResolutionEventTraceErrorCode.invalidEvent, `${label} has fields invalid for '${kind}'`);
  }
  const id = identifier(dataProperty(value, "id"), `${label}.id`, budget) as ResolutionEventId;
  const sequence = nonNegativeInteger(dataProperty(value, "sequence"), `${label}.sequence`);
  if (sequence !== index) {
    fail(
      ResolutionEventTraceErrorCode.invalidState,
      `${label}.sequence must equal its zero-based array position`,
    );
  }
  const rawTargetId = dataProperty(value, "targetId");
  const targetId =
    rawTargetId === null
      ? null
      : (identifier(rawTargetId, `${label}.targetId`, budget) as ResolutionTargetId);
  if (targetId !== null && !targetIds.has(targetId)) {
    fail(
      ResolutionEventTraceErrorCode.invalidRelationship,
      `${label}.targetId references unknown target '${targetId}'`,
    );
  }
  const uncertainty = normalizeUncertainty(
    dataProperty(value, "uncertainty"),
    `${label}.uncertainty`,
    budget,
  );
  const base = { id, sequence, targetId, uncertainty } as const;
  if (kind === "launch") {
    const launchPath = path(dataProperty(value, "path"), `${label}.path`, budget);
    const rawRoots = dataProperty(value, "workspaceRoots");
    assertDenseArray(
      rawRoots,
      `${label}.workspaceRoots`,
      RESOLUTION_EVENT_TRACE_LIMITS.maxWorkspaceRoots,
    );
    if (rawRoots.length === 0) {
      fail(ResolutionEventTraceErrorCode.invalidState, `${label}.workspaceRoots must not be empty`);
    }
    const workspaceRoots = rawRoots.map((root, rootIndex) =>
      path(root, `${label}.workspaceRoots[${String(rootIndex)}]`, budget),
    );
    if (new Set(workspaceRoots).size !== workspaceRoots.length) {
      fail(ResolutionEventTraceErrorCode.invalidState, `${label}.workspaceRoots must be unique`);
    }
    return Object.freeze({
      ...base,
      kind,
      path: launchPath,
      workspaceRoots: Object.freeze(workspaceRoots.sort(compareCodeUnits)),
      settings: normalizeSettings(
        dataProperty(value, "settings"),
        `${label}.settings`,
        budget,
        false,
      ),
    });
  }
  if (PATH_EVENT_KINDS.has(kind)) {
    return Object.freeze({
      ...base,
      kind: kind as "reference-path",
      path: path(dataProperty(value, "path"), `${label}.path`, budget),
    });
  }
  if (kind === "manual-rule-mention") {
    const ruleId = identifier(
      dataProperty(value, "ruleId"),
      `${label}.ruleId`,
      budget,
    ) as ActivationRuleId;
    if (!knownRuleIds.has(ruleId)) {
      fail(
        ResolutionEventTraceErrorCode.invalidRelationship,
        `${label}.ruleId references unknown rule '${ruleId}'`,
      );
    }
    return Object.freeze({ ...base, kind, ruleId });
  }
  if (kind === "rule-selection") {
    const ruleIds = normalizeIdentifiers(
      dataProperty(value, "ruleIds"),
      `${label}.ruleIds`,
      budget,
      RESOLUTION_EVENT_TRACE_LIMITS.maxKnownRules,
      1,
    ) as readonly ActivationRuleId[];
    for (const ruleId of ruleIds) {
      if (!knownRuleIds.has(ruleId)) {
        fail(
          ResolutionEventTraceErrorCode.invalidRelationship,
          `${label}.ruleIds references unknown rule '${ruleId}'`,
        );
      }
    }
    const selectionSource = text(
      dataProperty(value, "selectionSource"),
      `${label}.selectionSource`,
      budget,
    );
    if (!SELECTION_SOURCES.has(selectionSource)) {
      fail(ResolutionEventTraceErrorCode.invalidState, `${label}.selectionSource is unsupported`);
    }
    return Object.freeze({
      ...base,
      kind,
      ruleIds,
      selectionSource: selectionSource as "profile" | "model" | "user" | "unknown",
    });
  }
  if (kind === "settings-change") {
    return Object.freeze({
      ...base,
      kind,
      settings: normalizeSettings(
        dataProperty(value, "settings"),
        `${label}.settings`,
        budget,
        true,
      ),
    });
  }
  return Object.freeze({
    ...base,
    kind: kind as
      | "memory-show"
      | "memory-list"
      | "memory-reload"
      | "compact"
      | "review-request"
      | "review-push"
      | "hosted-task-start"
      | "client-restart",
  });
}

/** Normalize and validate an untrusted E03 trace without filesystem, process, or profile access. */
export function normalizeResolutionEventTrace(input: unknown): ResolutionEventTrace {
  const record = assertRecord(
    input,
    ["recordKind", "contractVersion", "rules", "targets", "events"],
    "event trace",
  );
  if (dataProperty(record, "recordKind") !== "agent-context-resolution-event-trace") {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      "event trace.recordKind must equal 'agent-context-resolution-event-trace'",
    );
  }
  if (dataProperty(record, "contractVersion") !== RESOLUTION_EVENT_TRACE_CONTRACT_VERSION) {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      `event trace.contractVersion must equal '${RESOLUTION_EVENT_TRACE_CONTRACT_VERSION}'`,
    );
  }
  const budget: ValidationBudget = { jsonNodes: 0, textBytes: 0 };
  const rawRules = dataProperty(record, "rules");
  assertDenseArray(rawRules, "rules", RESOLUTION_EVENT_TRACE_LIMITS.maxKnownRules);
  const rules = rawRules.map((rule, index) =>
    normalizeRuleDescriptor(rule, `rules[${String(index)}]`, budget),
  );
  const ruleIds = new Set(rules.map((rule) => rule.id));
  if (ruleIds.size !== rules.length) {
    fail(ResolutionEventTraceErrorCode.invalidState, "rules must have unique IDs");
  }
  const rawTargets = dataProperty(record, "targets");
  assertDenseArray(rawTargets, "targets", RESOLUTION_EVENT_TRACE_LIMITS.maxTargets);
  const targets = rawTargets.map((target, index) => normalizeTarget(target, index, budget));
  const targetIds = new Set(targets.map((target) => target.id));
  if (targetIds.size !== targets.length) {
    fail(ResolutionEventTraceErrorCode.invalidState, "targets must have unique IDs");
  }
  const rawEvents = dataProperty(record, "events");
  assertDenseArray(rawEvents, "events", RESOLUTION_EVENT_TRACE_LIMITS.maxEvents);
  if (rawEvents.length === 0) {
    fail(ResolutionEventTraceErrorCode.invalidState, "event trace must contain a launch event");
  }
  const ruleSet = new Set<string>(rules.map((rule) => rule.id));
  const events = rawEvents.map((event, index) =>
    normalizeEvent(event, index, targetIds, ruleSet, budget),
  );
  const eventIds = new Set(events.map((event) => event.id));
  if (eventIds.size !== events.length) {
    fail(ResolutionEventTraceErrorCode.invalidState, "events must have unique IDs");
  }
  const launchIndexes = events
    .map((event, index) => (event.kind === "launch" ? index : -1))
    .filter((index) => index >= 0);
  if (launchIndexes.length !== 1 || launchIndexes[0] !== 0) {
    fail(
      ResolutionEventTraceErrorCode.invalidState,
      "event trace must contain exactly one launch event at sequence zero",
    );
  }
  return Object.freeze({
    recordKind: "agent-context-resolution-event-trace",
    contractVersion: RESOLUTION_EVENT_TRACE_CONTRACT_VERSION,
    rules: Object.freeze(rules.sort((left, right) => compareCodeUnits(left.id, right.id))),
    targets: Object.freeze(targets.sort((left, right) => compareCodeUnits(left.id, right.id))),
    events: Object.freeze(events),
  });
}

/** Extract a trace only after the complete B03 IR and all of its relationships validate. */
export function createResolutionEventTrace(ir: InstructionIr): ResolutionEventTrace {
  const result = validateInstructionIr(ir);
  if (!result.ok) {
    const first = result.issues[0];
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      first === undefined
        ? "instruction IR failed B03 validation"
        : `instruction IR failed B03 validation at ${first.path}: ${first.message}`,
    );
  }
  return normalizeResolutionEventTrace({
    recordKind: "agent-context-resolution-event-trace",
    contractVersion: RESOLUTION_EVENT_TRACE_CONTRACT_VERSION,
    rules: result.value.activationRules.map((rule) => ({
      id: rule.id,
      documentId: rule.documentId,
      profileId: rule.profileId,
      surfaceId: rule.surfaceId,
      specSnapshotId: rule.specSnapshotId,
      kind: rule.kind,
      conditions: rule.conditions,
    })),
    targets: result.value.targets,
    events: result.value.events,
  });
}

function lengthPrefixed(parts: readonly string[]): string {
  return parts.map((part) => `${String(Buffer.byteLength(part, "utf8"))}:${part}`).join("");
}

function stableId(prefix: string, parts: readonly string[]): string {
  const digest = createHash("sha256").update(lengthPrefixed(parts), "utf8").digest("hex");
  return `${prefix}:${digest}`;
}

/** Build the documented one-target projection: launch followed by one target path event. */
export function createSyntheticTargetTrace(input: SyntheticTargetTraceInput): ResolutionEventTrace {
  if (!isDataRecord(input)) {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      "synthetic target trace input must be a regular data record",
    );
  }
  const allowedKeys = new Set([
    "launchCwd",
    "workspaceRoots",
    "targetPath",
    "purpose",
    "settings",
    "targetEventKind",
  ]);
  if (
    !Object.keys(input).every((key) => allowedKeys.has(key)) ||
    !["launchCwd", "workspaceRoots", "targetPath", "purpose"].every((key) =>
      Object.prototype.hasOwnProperty.call(input, key),
    )
  ) {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      "synthetic target trace input has missing or unknown fields",
    );
  }
  const record = input;
  const launchCwd = dataProperty(record, "launchCwd");
  const workspaceRoots = dataProperty(record, "workspaceRoots");
  const targetPath = dataProperty(record, "targetPath");
  const purpose = dataProperty(record, "purpose");
  const settings = Object.prototype.hasOwnProperty.call(record, "settings")
    ? dataProperty(record, "settings")
    : [];
  const targetEventKind = Object.prototype.hasOwnProperty.call(record, "targetEventKind")
    ? dataProperty(record, "targetEventKind")
    : "reference-path";
  if (!new Set(["reference-path", "read-path", "write-path"]).has(targetEventKind as string)) {
    fail(
      ResolutionEventTraceErrorCode.invalidEvent,
      "synthetic target trace targetEventKind must be reference-path, read-path, or write-path",
    );
  }
  if (typeof targetPath !== "string" || typeof purpose !== "string") {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      "synthetic target and purpose must be strings",
    );
  }
  const targetId = stableId("target", [targetPath, purpose]) as ResolutionTargetId;
  const provisional = normalizeResolutionEventTrace({
    recordKind: "agent-context-resolution-event-trace",
    contractVersion: RESOLUTION_EVENT_TRACE_CONTRACT_VERSION,
    rules: [],
    targets: [{ id: targetId, path: targetPath, purpose }],
    events: [
      {
        id: "event:synthetic-launch",
        sequence: 0,
        kind: "launch",
        targetId,
        uncertainty: { state: "known" },
        path: launchCwd,
        workspaceRoots,
        settings,
      },
      {
        id: "event:synthetic-target",
        sequence: 1,
        kind: targetEventKind,
        targetId,
        uncertainty: { state: "known" },
        path: targetPath,
      },
    ],
  });
  const launch = provisional.events[0];
  const targetEvent = provisional.events[1];
  if (launch?.kind !== "launch" || targetEvent === undefined || targetEvent.kind === "launch") {
    fail(ResolutionEventTraceErrorCode.invalidState, "synthetic trace construction failed");
  }
  const launchPayload = JSON.stringify({
    kind: launch.kind,
    targetId: launch.targetId,
    uncertainty: launch.uncertainty,
    path: launch.path,
    workspaceRoots: launch.workspaceRoots,
    settings: launch.settings,
  });
  const targetPayload = JSON.stringify({
    kind: targetEvent.kind,
    targetId: targetEvent.targetId,
    uncertainty: targetEvent.uncertainty,
    path: "path" in targetEvent ? targetEvent.path : null,
  });
  return normalizeResolutionEventTrace({
    ...provisional,
    events: [
      { ...launch, id: stableId("event", ["0", launchPayload]) },
      { ...targetEvent, id: stableId("event", ["1", targetPayload]) },
    ],
  });
}

/** Fixed-key canonical JSON; object-valued settings are recursively key-sorted during normalization. */
export function serializeResolutionEventTrace(trace: ResolutionEventTrace): string {
  return JSON.stringify(normalizeResolutionEventTrace(trace));
}

/** SHA-256 identity of the exact canonical E03 serialization. */
export function digestResolutionEventTrace(trace: ResolutionEventTrace): string {
  return createHash("sha256").update(serializeResolutionEventTrace(trace), "utf8").digest("hex");
}

function eventAppliesToPath(
  trace: ResolutionEventTrace,
  event: ResolutionEvent,
  targetPath: RepositoryRelativePath,
): boolean {
  if (event.targetId === null) return true;
  return trace.targets.some((target) => target.id === event.targetId && target.path === targetPath);
}

function uncertaintyDescription(uncertainty: Uncertainty): string {
  if (uncertainty.state === "known") return "known";
  if (uncertainty.state === "conditional") {
    return `conditional: ${uncertainty.conditions.join("; ")}`;
  }
  return `${uncertainty.state}: ${uncertainty.reason}`;
}

function normalizeRuleSelectionQuery(input: unknown): TraceRuleSelectionQuery {
  const record = assertRecord(input, ["rule", "targetPath", "mode"], "rule selection query");
  const budget: ValidationBudget = { jsonNodes: 0, textBytes: 0 };
  const rule = normalizeRuleDescriptor(
    dataProperty(record, "rule"),
    "rule selection query.rule",
    budget,
  );
  const targetPath = path(
    dataProperty(record, "targetPath"),
    "rule selection query.targetPath",
    budget,
  );
  const mode = text(dataProperty(record, "mode"), "rule selection query.mode", budget);
  if (mode !== "manual" && mode !== "conditional") {
    fail(
      ResolutionEventTraceErrorCode.invalidState,
      "rule selection query.mode must be 'manual' or 'conditional'",
    );
  }
  return Object.freeze({ rule, targetPath, mode });
}

/** Resolve explicit positive trace evidence. Absence is indeterminate, never a fabricated deselection. */
export function resolveTraceRuleSelection(
  trace: ResolutionEventTrace,
  query: TraceRuleSelectionQuery,
): TraceRuleSelection {
  const normalized = normalizeResolutionEventTrace(trace);
  const normalizedQuery = normalizeRuleSelectionQuery(query);
  const origin = normalized.rules.find((rule) => rule.id === normalizedQuery.rule.id);
  if (origin === undefined || !sameRuleDescriptor(origin, normalizedQuery.rule)) {
    fail(
      ResolutionEventTraceErrorCode.invalidRelationship,
      "rule selection query does not match a complete originating rule descriptor",
    );
  }
  const { id: ruleId } = origin;
  const { mode, targetPath } = normalizedQuery;
  const evidence: TraceRuleSelectionEvidence[] = [];
  for (const event of normalized.events) {
    const selected =
      event.kind === "rule-selection"
        ? event.ruleIds.includes(ruleId)
        : mode === "manual" && event.kind === "manual-rule-mention" && event.ruleId === ruleId;
    if (!selected || !eventAppliesToPath(normalized, event, targetPath)) continue;
    evidence.push(
      Object.freeze({
        eventId: event.id,
        sequence: event.sequence,
        eventKind: event.kind as "manual-rule-mention" | "rule-selection",
        selectionSource: event.kind === "rule-selection" ? event.selectionSource : null,
        targetId: event.targetId,
        uncertainty: event.uncertainty,
      }),
    );
  }
  const known = evidence.find((entry) => entry.uncertainty.state === "known");
  const state = known === undefined ? "indeterminate" : "active";
  const reason =
    known !== undefined
      ? `Rule '${ruleId}' is explicitly selected by event '${known.eventId}' at sequence ${String(known.sequence)}.`
      : evidence.length === 0
        ? `Trace contains no explicit positive selection for rule '${ruleId}' and does not prove deselection.`
        : `Selection for rule '${ruleId}' is ${uncertaintyDescription(evidence[0]?.uncertainty ?? { state: "unknown", reason: "missing evidence" })}.`;
  return Object.freeze({
    state,
    ruleId,
    targetPath,
    evidence: Object.freeze(evidence),
    reason,
  });
}

function decisionFor(
  trace: ResolutionEventTrace,
  request: unknown,
  mode: "manual" | "conditional",
): ActivationFactDecision {
  const keys = [
    "ruleId",
    "documentId",
    "profileId",
    "surfaceId",
    "specSnapshotId",
    "targetPath",
    "conditions",
  ];
  const record = assertRecord(request, keys, `${mode} activation request`);
  const result = resolveTraceRuleSelection(trace, {
    rule: {
      id: dataProperty(record, "ruleId") as ActivationRuleId,
      documentId: dataProperty(record, "documentId") as InstructionDocumentId,
      profileId: dataProperty(record, "profileId") as ClientProfileId,
      surfaceId: dataProperty(record, "surfaceId") as SurfaceId,
      specSnapshotId: dataProperty(record, "specSnapshotId") as SpecSnapshotId,
      kind: mode,
      conditions: dataProperty(record, "conditions") as readonly string[],
    },
    targetPath: dataProperty(record, "targetPath") as RepositoryRelativePath,
    mode,
  });
  return Object.freeze({ state: result.state, reason: result.reason });
}

/** E01-compatible dynamic callbacks; profile-owned glob matching remains a separate E02 concern. */
export function createTraceActivationCallbacks(trace: ResolutionEventTrace): ActivationCallbacks {
  const normalized = normalizeResolutionEventTrace(trace);
  return Object.freeze({
    resolveManual(request: ManualActivationRequest): ActivationFactDecision {
      return decisionFor(normalized, request, "manual");
    },
    resolveConditional(request: ConditionalActivationRequest): ActivationFactDecision {
      return decisionFor(normalized, request, "conditional");
    },
  });
}

/** Return the last recorded assignment for a target; uncertain assignments remain indeterminate. */
export function resolveTraceSetting(
  trace: ResolutionEventTrace,
  query: TraceSettingQuery,
): TraceSettingResult {
  const normalized = normalizeResolutionEventTrace(trace);
  const queryRecord = assertRecord(query, ["key", "targetPath"], "setting query");
  const budget: ValidationBudget = { jsonNodes: 0, textBytes: 0 };
  const normalizedKey = text(dataProperty(queryRecord, "key"), "setting query.key", budget);
  if (/\p{Cc}/u.test(normalizedKey)) {
    fail(
      ResolutionEventTraceErrorCode.invalidInput,
      "setting query.key contains a control character",
    );
  }
  const targetPath = path(
    dataProperty(queryRecord, "targetPath"),
    "setting query.targetPath",
    budget,
  );
  let result: TraceSettingResult = Object.freeze({ state: "unrecorded", key: normalizedKey });
  for (const event of normalized.events) {
    if (
      (event.kind !== "launch" && event.kind !== "settings-change") ||
      !eventAppliesToPath(normalized, event, targetPath)
    ) {
      continue;
    }
    const setting = event.settings.find((candidate) => candidate.key === normalizedKey);
    if (setting === undefined) continue;
    result =
      event.uncertainty.state === "known"
        ? Object.freeze({
            state: "known",
            key: normalizedKey,
            value: setting.value,
            eventId: event.id,
            sequence: event.sequence,
          })
        : Object.freeze({
            state: "indeterminate",
            key: normalizedKey,
            eventId: event.id,
            sequence: event.sequence,
            reason: uncertaintyDescription(event.uncertainty),
          });
  }
  return result;
}
