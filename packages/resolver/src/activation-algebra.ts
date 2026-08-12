import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  REPOSITORY_ROOT,
  isRepositoryRelativePath,
  type ActivationKind,
  type ActivationRule,
  type ActivationRuleId,
  type ClientProfileId,
  type InstructionDocumentId,
  type RepositoryRelativePath,
  type SpecSnapshotId,
  type SurfaceId,
} from "@agent-context/core";

export const ACTIVATION_STATES = ["active", "inactive", "indeterminate"] as const;
export type ActivationState = (typeof ACTIVATION_STATES)[number];

export const ACTIVATION_PROVENANCE_KINDS = [
  "always",
  "scope-root",
  "directory-selector",
  "glob-selector",
  "manual-fact",
  "conditional-fact",
  "unknown-rule",
  "caller-fact",
] as const;
export type ActivationProvenanceKind = (typeof ACTIVATION_PROVENANCE_KINDS)[number];

export interface ActivationAlgebraLimits {
  readonly maxConditions: number;
  readonly maxInputTextBytes: number;
  readonly maxOperands: number;
  readonly maxProvenanceFacts: number;
  readonly maxSelectors: number;
  readonly maxTextBytes: number;
}

export const ACTIVATION_ALGEBRA_LIMITS: Readonly<ActivationAlgebraLimits> = Object.freeze({
  maxConditions: 1_024,
  maxInputTextBytes: 1_048_576,
  maxOperands: 4_096,
  maxProvenanceFacts: 4_096,
  maxSelectors: 4_096,
  maxTextBytes: 16_384,
});

export const ActivationAlgebraErrorCode: Readonly<{
  callbackFailed: "ACTIVATION_CALLBACK_FAILED";
  conflictingProvenance: "ACTIVATION_CONFLICTING_PROVENANCE";
  invalidCallback: "ACTIVATION_INVALID_CALLBACK";
  invalidResult: "ACTIVATION_INVALID_RESULT";
  invalidRule: "ACTIVATION_INVALID_RULE";
  invalidTargetPath: "ACTIVATION_INVALID_TARGET_PATH";
  resourceLimit: "ACTIVATION_RESOURCE_LIMIT";
}> = Object.freeze({
  callbackFailed: "ACTIVATION_CALLBACK_FAILED",
  conflictingProvenance: "ACTIVATION_CONFLICTING_PROVENANCE",
  invalidCallback: "ACTIVATION_INVALID_CALLBACK",
  invalidResult: "ACTIVATION_INVALID_RESULT",
  invalidRule: "ACTIVATION_INVALID_RULE",
  invalidTargetPath: "ACTIVATION_INVALID_TARGET_PATH",
  resourceLimit: "ACTIVATION_RESOURCE_LIMIT",
} as const);

export type ActivationAlgebraErrorCode =
  (typeof ActivationAlgebraErrorCode)[keyof typeof ActivationAlgebraErrorCode];

export class ActivationAlgebraError extends Error {
  override readonly name = "ActivationAlgebraError" as const;
  readonly code: ActivationAlgebraErrorCode;
  override readonly cause: unknown;

  constructor(code: ActivationAlgebraErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.cause = cause;
  }
}

/** One atomic fact retained in a minimal proof of an activation result. */
export interface ActivationProvenance {
  readonly key: string;
  readonly kind: ActivationProvenanceKind;
  readonly observedState: ActivationState;
  readonly description: string;
}

/** A three-valued activation decision with a flat, canonical proof. */
export interface ActivationResult {
  readonly state: ActivationState;
  readonly provenance: readonly ActivationProvenance[];
}

/** Profile-owned or event-owned answer to one predicate request. */
export interface ActivationFactDecision {
  readonly state: ActivationState;
  readonly reason: string;
}

export interface GlobActivationRequest {
  readonly ruleId: ActivationRuleId;
  readonly profileId: ClientProfileId;
  readonly surfaceId: SurfaceId;
  readonly scopeRoot: RepositoryRelativePath;
  readonly targetPath: RepositoryRelativePath;
  readonly pattern: string;
  readonly dialectId: string | null;
}

export interface ManualActivationRequest {
  readonly ruleId: ActivationRuleId;
  readonly documentId: InstructionDocumentId;
  readonly profileId: ClientProfileId;
  readonly surfaceId: SurfaceId;
  readonly specSnapshotId: SpecSnapshotId;
  readonly targetPath: RepositoryRelativePath;
  /** B03 conditions are passed intact even when the profile classifies the rule as manual. */
  readonly conditions: readonly string[];
}

/** Conditional requests share the complete origin descriptor carried by manual requests. */
export type ConditionalActivationRequest = ManualActivationRequest;

export interface ActivationCallbacks {
  readonly matchGlob?: (request: GlobActivationRequest) => ActivationFactDecision;
  readonly resolveManual?: (request: ManualActivationRequest) => ActivationFactDecision;
  readonly resolveConditional?: (request: ConditionalActivationRequest) => ActivationFactDecision;
}

export interface ActivationEvaluationInput {
  /** A B01 canonical path selected by the caller. E01 does not infer targets from events. */
  readonly targetPath: RepositoryRelativePath;
  /** Missing dynamic/profile facts conservatively become `indeterminate`. */
  readonly callbacks?: ActivationCallbacks;
}

type DataRecord = Readonly<Record<string, unknown>>;

const ACTIVATION_STATE_SET = new Set<string>(ACTIVATION_STATES);
const PROVENANCE_KIND_SET = new Set<string>(ACTIVATION_PROVENANCE_KINDS);
const ACTIVATION_KIND_SET = new Set<string>([
  "always",
  "directory-tree",
  "glob",
  "manual",
  "conditional",
  "unknown",
]);
const RULE_KEYS = [
  "id",
  "documentId",
  "profileId",
  "surfaceId",
  "specSnapshotId",
  "kind",
  "scopeRoot",
  "include",
  "exclude",
  "conditions",
  "unknownReason",
  "evidenceRefs",
  "uncertainty",
] as const;

function fail(code: ActivationAlgebraErrorCode, message: string, cause?: unknown): never {
  throw new ActivationAlgebraError(code, message, cause);
}

function isDataRecord(value: unknown): value is DataRecord {
  if (value === null || typeof value !== "object") return false;
  if (nodeTypes.isProxy(value) || Array.isArray(value)) return false;
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
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertDenseArray(
  value: unknown,
  label: string,
  maximum: number,
  code: ActivationAlgebraErrorCode,
): asserts value is readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(code, `${label} must be a regular dense array`);
  }
  if (value.length > maximum) {
    fail(
      ActivationAlgebraErrorCode.resourceLimit,
      `${label} exceeds the limit of ${String(maximum)} items`,
    );
  }
  const ownKeys = Reflect.ownKeys(value);
  const keys = ownKeys.filter((key): key is string => key !== "length" && typeof key === "string");
  if (ownKeys.length !== value.length + 1 || keys.length !== value.length)
    fail(code, `${label} must not be sparse or have extra properties`);
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) {
      fail(code, `${label} must contain only canonical enumerable array indices`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(code, `${label} must contain enumerable data properties only`);
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
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function textBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertText(
  value: unknown,
  label: string,
  code: ActivationAlgebraErrorCode,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${label} must be a non-empty string`);
  }
  if (!hasWellFormedUnicode(value)) fail(code, `${label} must contain well-formed Unicode`);
  if (textBytes(value) > ACTIVATION_ALGEBRA_LIMITS.maxTextBytes) {
    fail(
      ActivationAlgebraErrorCode.resourceLimit,
      `${label} exceeds the ${String(ACTIVATION_ALGEBRA_LIMITS.maxTextBytes)} byte text limit`,
    );
  }
}

function assertState(value: unknown, label: string): asserts value is ActivationState {
  if (typeof value !== "string" || !ACTIVATION_STATE_SET.has(value)) {
    fail(ActivationAlgebraErrorCode.invalidResult, `${label} is not an activation state`);
  }
}

function lengthPrefixed(parts: readonly string[]): string {
  return parts.map((part) => `${String(textBytes(part))}:${part}`).join("");
}

function factKey(kind: ActivationProvenanceKind, parts: readonly string[]): string {
  const digest = createHash("sha256").update(lengthPrefixed(parts), "utf8").digest("hex");
  return `${kind}:${digest}`;
}

function ruleIdentityParts(rule: ActivationRule): readonly string[] {
  return [rule.id, rule.documentId, rule.profileId, rule.surfaceId, rule.specSnapshotId];
}

function describeText(value: string): string {
  const bytes = textBytes(value);
  if (bytes <= 1_024) return `'${value}'`;
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `[sha256:${digest}; ${String(bytes)} bytes]`;
}

function compareFacts(left: ActivationProvenance, right: ActivationProvenance): number {
  for (const [leftValue, rightValue] of [
    [left.key, right.key],
    [left.kind, right.kind],
    [left.observedState, right.observedState],
    [left.description, right.description],
  ] as const) {
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

function normalizeFacts(input: unknown, label: string): readonly ActivationProvenance[] {
  assertDenseArray(
    input,
    label,
    ACTIVATION_ALGEBRA_LIMITS.maxProvenanceFacts,
    ActivationAlgebraErrorCode.invalidResult,
  );
  const byKey = new Map<string, ActivationProvenance>();
  let inputBytes = 0;
  for (const [index, value] of input.entries()) {
    if (
      !isDataRecord(value) ||
      !hasExactKeys(value, ["key", "kind", "observedState", "description"])
    ) {
      fail(
        ActivationAlgebraErrorCode.invalidResult,
        `${label}[${String(index)}] must be a closed provenance record`,
      );
    }
    const key = dataProperty(value, "key");
    const kind = dataProperty(value, "kind");
    const observedState = dataProperty(value, "observedState");
    const description = dataProperty(value, "description");
    assertText(key, `${label}[${String(index)}].key`, ActivationAlgebraErrorCode.invalidResult);
    if (typeof kind !== "string" || !PROVENANCE_KIND_SET.has(kind)) {
      fail(
        ActivationAlgebraErrorCode.invalidResult,
        `${label}[${String(index)}].kind is not a provenance kind`,
      );
    }
    assertState(observedState, `${label}[${String(index)}].observedState`);
    assertText(
      description,
      `${label}[${String(index)}].description`,
      ActivationAlgebraErrorCode.invalidResult,
    );
    inputBytes += textBytes(key) + textBytes(description);
    if (inputBytes > ACTIVATION_ALGEBRA_LIMITS.maxInputTextBytes) {
      fail(ActivationAlgebraErrorCode.resourceLimit, `${label} exceeds the cumulative text limit`);
    }
    const fact = Object.freeze({
      key,
      kind: kind as ActivationProvenanceKind,
      observedState,
      description,
    });
    const prior = byKey.get(key);
    if (prior !== undefined) {
      if (
        prior.kind !== fact.kind ||
        prior.observedState !== fact.observedState ||
        prior.description !== fact.description
      ) {
        fail(
          ActivationAlgebraErrorCode.conflictingProvenance,
          `provenance key '${key}' has conflicting facts`,
        );
      }
      continue;
    }
    byKey.set(key, fact);
  }
  return Object.freeze([...byKey.values()].sort(compareFacts));
}

function makeResult(state: ActivationState, provenance: unknown): ActivationResult {
  const facts = normalizeFacts(provenance, "activation provenance");
  return Object.freeze({ state, provenance: facts });
}

function normalizeResult(value: unknown, label: string): ActivationResult {
  if (!isDataRecord(value) || !hasExactKeys(value, ["state", "provenance"])) {
    fail(ActivationAlgebraErrorCode.invalidResult, `${label} must be a closed activation result`);
  }
  const state = dataProperty(value, "state");
  assertState(state, `${label}.state`);
  return makeResult(state, dataProperty(value, "provenance"));
}

function proofKey(result: ActivationResult): string {
  return result.provenance
    .map((fact) => lengthPrefixed([fact.key, fact.kind, fact.observedState, fact.description]))
    .join("");
}

function leastProof(results: readonly ActivationResult[]): ActivationResult {
  const first = results[0];
  if (first === undefined) {
    fail(ActivationAlgebraErrorCode.invalidResult, "cannot select a proof from no results");
  }
  let selected = first;
  let selectedKey = proofKey(selected);
  for (const candidate of results.slice(1)) {
    const candidateKey = proofKey(candidate);
    if (candidateKey < selectedKey) {
      selected = candidate;
      selectedKey = candidateKey;
    }
  }
  return selected;
}

function mergeProofs(results: readonly ActivationResult[]): readonly ActivationProvenance[] {
  const facts: ActivationProvenance[] = [];
  for (const result of results) facts.push(...result.provenance);
  return facts;
}

function normalizeOperands(input: unknown, operation: string): readonly ActivationResult[] {
  assertDenseArray(
    input,
    `${operation} operands`,
    ACTIVATION_ALGEBRA_LIMITS.maxOperands,
    ActivationAlgebraErrorCode.invalidResult,
  );
  const normalized: ActivationResult[] = [];
  const facts: ActivationProvenance[] = [];
  let provenanceBytes = 0;
  for (const [index, operand] of input.entries()) {
    const result = normalizeResult(operand, `${operation} operands[${String(index)}]`);
    normalized.push(result);
    if (facts.length + result.provenance.length > ACTIVATION_ALGEBRA_LIMITS.maxProvenanceFacts) {
      fail(
        ActivationAlgebraErrorCode.resourceLimit,
        `${operation} operands exceed the cumulative provenance limit`,
      );
    }
    for (const fact of result.provenance) {
      provenanceBytes += textBytes(fact.key) + textBytes(fact.description);
      if (provenanceBytes > ACTIVATION_ALGEBRA_LIMITS.maxInputTextBytes) {
        fail(
          ActivationAlgebraErrorCode.resourceLimit,
          `${operation} operands exceed the cumulative provenance text limit`,
        );
      }
      facts.push(fact);
    }
  }
  normalizeFacts(facts, `${operation} operand provenance`);
  return normalized;
}

/** Constructs one generic atomic fact for direct set-algebra composition. */
export function activationFact(
  state: ActivationState,
  key: string,
  description: string,
): ActivationResult {
  assertState(state, "activation fact state");
  assertText(key, "activation fact key", ActivationAlgebraErrorCode.invalidResult);
  assertText(description, "activation fact description", ActivationAlgebraErrorCode.invalidResult);
  return makeResult(state, [{ key, kind: "caller-fact", observedState: state, description }]);
}

/** Strong-Kleene set union. Empty union is the inactive empty set. */
export function activationUnion(operands: readonly ActivationResult[]): ActivationResult {
  const normalized = normalizeOperands(operands, "union");
  if (normalized.length === 0) return makeResult("inactive", []);
  const active = normalized.filter((operand) => operand.state === "active");
  if (active.length > 0) {
    const proof = leastProof(active);
    return makeResult("active", proof.provenance);
  }
  const state = normalized.some((operand) => operand.state === "indeterminate")
    ? "indeterminate"
    : "inactive";
  return makeResult(state, mergeProofs(normalized));
}

/** Strong-Kleene set intersection. Empty intersection is the active universal set. */
export function activationIntersection(operands: readonly ActivationResult[]): ActivationResult {
  const normalized = normalizeOperands(operands, "intersection");
  if (normalized.length === 0) return makeResult("active", []);
  const inactive = normalized.filter((operand) => operand.state === "inactive");
  if (inactive.length > 0) {
    const proof = leastProof(inactive);
    return makeResult("inactive", proof.provenance);
  }
  const state = normalized.some((operand) => operand.state === "indeterminate")
    ? "indeterminate"
    : "active";
  return makeResult(state, mergeProofs(normalized));
}

/** Strong-Kleene complement. Atomic provenance remains the observed fact, not an invented inverse. */
export function activationComplement(operand: ActivationResult): ActivationResult {
  const normalized = normalizeResult(operand, "complement operand");
  const state =
    normalized.state === "active"
      ? "inactive"
      : normalized.state === "inactive"
        ? "active"
        : "indeterminate";
  return makeResult(state, normalized.provenance);
}

/** Set difference `left ∩ ¬right` using the same three-valued truth table. */
export function activationDifference(
  left: ActivationResult,
  right: ActivationResult,
): ActivationResult {
  return activationIntersection([left, activationComplement(right)]);
}

function atomicResult(
  state: ActivationState,
  kind: ActivationProvenanceKind,
  keyParts: readonly string[],
  description: string,
): ActivationResult {
  return makeResult(state, [
    {
      key: factKey(kind, keyParts),
      kind,
      observedState: state,
      description,
    },
  ]);
}

function assertRule(rule: unknown): asserts rule is ActivationRule {
  if (!isDataRecord(rule) || !hasExactKeys(rule, RULE_KEYS)) {
    fail(
      ActivationAlgebraErrorCode.invalidRule,
      "activation rule must be a closed B03 data record",
    );
  }
  const id = dataProperty(rule, "id");
  const documentId = dataProperty(rule, "documentId");
  const profileId = dataProperty(rule, "profileId");
  const surfaceId = dataProperty(rule, "surfaceId");
  const snapshotId = dataProperty(rule, "specSnapshotId");
  assertText(id, "activation rule id", ActivationAlgebraErrorCode.invalidRule);
  assertText(documentId, "activation rule documentId", ActivationAlgebraErrorCode.invalidRule);
  assertText(profileId, "activation rule profileId", ActivationAlgebraErrorCode.invalidRule);
  assertText(surfaceId, "activation rule surfaceId", ActivationAlgebraErrorCode.invalidRule);
  assertText(snapshotId, "activation rule specSnapshotId", ActivationAlgebraErrorCode.invalidRule);
  const kind = dataProperty(rule, "kind");
  if (typeof kind !== "string" || !ACTIVATION_KIND_SET.has(kind)) {
    fail(ActivationAlgebraErrorCode.invalidRule, "activation rule kind is invalid");
  }
  const scopeRoot = dataProperty(rule, "scopeRoot");
  assertText(scopeRoot, "activation rule scopeRoot", ActivationAlgebraErrorCode.invalidRule);
  if (!isRepositoryRelativePath(scopeRoot)) {
    fail(ActivationAlgebraErrorCode.invalidRule, "activation rule scopeRoot is not a B01 path");
  }
  const include = dataProperty(rule, "include");
  const exclude = dataProperty(rule, "exclude");
  assertDenseArray(
    include,
    "activation rule include selectors",
    ACTIVATION_ALGEBRA_LIMITS.maxSelectors,
    ActivationAlgebraErrorCode.invalidRule,
  );
  assertDenseArray(
    exclude,
    "activation rule exclude selectors",
    ACTIVATION_ALGEBRA_LIMITS.maxSelectors,
    ActivationAlgebraErrorCode.invalidRule,
  );
  if (include.length + exclude.length > ACTIVATION_ALGEBRA_LIMITS.maxSelectors) {
    fail(
      ActivationAlgebraErrorCode.resourceLimit,
      `activation rule exceeds the combined selector limit of ${String(ACTIVATION_ALGEBRA_LIMITS.maxSelectors)}`,
    );
  }
  let inputBytes =
    textBytes(id) +
    textBytes(documentId) +
    textBytes(profileId) +
    textBytes(surfaceId) +
    textBytes(snapshotId) +
    textBytes(scopeRoot);
  const includeKinds = new Set<string>();
  for (const [index, selector] of [...include, ...exclude].entries()) {
    if (!isDataRecord(selector)) {
      fail(
        ActivationAlgebraErrorCode.invalidRule,
        `activation selector ${String(index)} must be a data record`,
      );
    }
    const selectorKind = dataProperty(selector, "kind");
    if (selectorKind === "directory-tree") {
      if (!hasExactKeys(selector, ["kind", "path", "sourceRange"])) {
        fail(ActivationAlgebraErrorCode.invalidRule, "directory selector is not a B03 record");
      }
      const path = dataProperty(selector, "path");
      assertText(path, "directory selector path", ActivationAlgebraErrorCode.invalidRule);
      if (!isRepositoryRelativePath(path)) {
        fail(ActivationAlgebraErrorCode.invalidRule, "directory selector path is not a B01 path");
      }
      inputBytes += textBytes(path);
    } else if (selectorKind === "glob") {
      if (!hasExactKeys(selector, ["kind", "pattern", "dialectId", "sourceRange", "uncertainty"])) {
        fail(ActivationAlgebraErrorCode.invalidRule, "glob selector is not a B03 record");
      }
      const pattern = dataProperty(selector, "pattern");
      const dialectId = dataProperty(selector, "dialectId");
      assertText(pattern, "glob selector pattern", ActivationAlgebraErrorCode.invalidRule);
      if (dialectId !== null) {
        assertText(dialectId, "glob selector dialectId", ActivationAlgebraErrorCode.invalidRule);
      }
      inputBytes += textBytes(pattern) + (dialectId === null ? 0 : textBytes(dialectId));
    } else {
      fail(ActivationAlgebraErrorCode.invalidRule, "activation selector kind is invalid");
    }
    if (index < include.length) includeKinds.add(selectorKind);
    if (inputBytes > ACTIVATION_ALGEBRA_LIMITS.maxInputTextBytes) {
      fail(
        ActivationAlgebraErrorCode.resourceLimit,
        "activation rule exceeds the cumulative text limit",
      );
    }
  }
  const conditions = dataProperty(rule, "conditions");
  assertDenseArray(
    conditions,
    "activation rule conditions",
    ACTIVATION_ALGEBRA_LIMITS.maxConditions,
    ActivationAlgebraErrorCode.invalidRule,
  );
  const conditionSet = new Set<string>();
  for (const [index, condition] of conditions.entries()) {
    assertText(
      condition,
      `activation rule conditions[${String(index)}]`,
      ActivationAlgebraErrorCode.invalidRule,
    );
    if (conditionSet.has(condition)) {
      fail(ActivationAlgebraErrorCode.invalidRule, "activation rule conditions must be unique");
    }
    conditionSet.add(condition);
    inputBytes += textBytes(condition);
    if (inputBytes > ACTIVATION_ALGEBRA_LIMITS.maxInputTextBytes) {
      fail(
        ActivationAlgebraErrorCode.resourceLimit,
        "activation rule exceeds the cumulative text limit",
      );
    }
  }
  const unknownReason = dataProperty(rule, "unknownReason");
  if (unknownReason !== null) {
    assertText(
      unknownReason,
      "activation rule unknownReason",
      ActivationAlgebraErrorCode.invalidRule,
    );
    inputBytes += textBytes(unknownReason);
  }
  const evidenceRefs = dataProperty(rule, "evidenceRefs");
  assertDenseArray(
    evidenceRefs,
    "activation rule evidenceRefs",
    ACTIVATION_ALGEBRA_LIMITS.maxSelectors,
    ActivationAlgebraErrorCode.invalidRule,
  );
  if (evidenceRefs.length === 0) {
    fail(ActivationAlgebraErrorCode.invalidRule, "activation rule requires evidenceRefs");
  }
  const evidencePairs = new Set<string>();
  for (const [index, evidenceRef] of evidenceRefs.entries()) {
    if (!isDataRecord(evidenceRef) || !hasExactKeys(evidenceRef, ["sourceId", "factId"])) {
      fail(
        ActivationAlgebraErrorCode.invalidRule,
        `activation rule evidenceRefs[${String(index)}] must be a closed evidence record`,
      );
    }
    const sourceId = dataProperty(evidenceRef, "sourceId");
    const factId = dataProperty(evidenceRef, "factId");
    assertText(
      sourceId,
      `activation rule evidenceRefs[${String(index)}].sourceId`,
      ActivationAlgebraErrorCode.invalidRule,
    );
    if (factId !== null) {
      assertText(
        factId,
        `activation rule evidenceRefs[${String(index)}].factId`,
        ActivationAlgebraErrorCode.invalidRule,
      );
    }
    const evidencePair = lengthPrefixed([sourceId, factId ?? ""]);
    if (evidencePairs.has(evidencePair)) {
      fail(ActivationAlgebraErrorCode.invalidRule, "activation rule evidenceRefs must be unique");
    }
    evidencePairs.add(evidencePair);
    inputBytes += textBytes(sourceId) + (factId === null ? 0 : textBytes(factId));
    if (inputBytes > ACTIVATION_ALGEBRA_LIMITS.maxInputTextBytes) {
      fail(
        ActivationAlgebraErrorCode.resourceLimit,
        "activation rule exceeds the cumulative text limit",
      );
    }
  }
  if (kind === "always" && conditions.length > 0) {
    fail(ActivationAlgebraErrorCode.invalidRule, "always activation cannot declare conditions");
  }
  if (kind === "directory-tree" && !includeKinds.has("directory-tree")) {
    fail(
      ActivationAlgebraErrorCode.invalidRule,
      "directory-tree activation requires a directory selector",
    );
  }
  if (kind === "glob" && !includeKinds.has("glob")) {
    fail(ActivationAlgebraErrorCode.invalidRule, "glob activation requires a glob selector");
  }
  if (kind === "conditional" && conditions.length === 0) {
    fail(ActivationAlgebraErrorCode.invalidRule, "conditional activation requires conditions");
  }
  if (kind === "unknown" && unknownReason === null) {
    fail(ActivationAlgebraErrorCode.invalidRule, "unknown activation requires unknownReason");
  }
  if (kind !== "unknown" && unknownReason !== null) {
    fail(
      ActivationAlgebraErrorCode.invalidRule,
      "unknownReason is valid only for unknown activation",
    );
  }
  if (inputBytes > ACTIVATION_ALGEBRA_LIMITS.maxInputTextBytes) {
    fail(
      ActivationAlgebraErrorCode.resourceLimit,
      "activation rule exceeds the cumulative text limit",
    );
  }
}

function assertCallbacks(value: unknown): asserts value is ActivationCallbacks {
  if (!isDataRecord(value)) {
    fail(ActivationAlgebraErrorCode.invalidCallback, "activation callbacks must be a data record");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["matchGlob", "resolveManual", "resolveConditional"].includes(key))) {
    fail(ActivationAlgebraErrorCode.invalidCallback, "activation callbacks contain an unknown key");
  }
  for (const key of keys) {
    if (typeof dataProperty(value, key) !== "function") {
      fail(
        ActivationAlgebraErrorCode.invalidCallback,
        `activation callback '${key}' is not a function`,
      );
    }
  }
}

function normalizeDecision(value: unknown, label: string): ActivationFactDecision {
  if (!isDataRecord(value) || !hasExactKeys(value, ["state", "reason"])) {
    fail(ActivationAlgebraErrorCode.invalidCallback, `${label} must return a closed fact decision`);
  }
  const state = dataProperty(value, "state");
  const reason = dataProperty(value, "reason");
  if (typeof state !== "string" || !ACTIVATION_STATE_SET.has(state)) {
    fail(ActivationAlgebraErrorCode.invalidCallback, `${label} returned an invalid state`);
  }
  assertText(reason, `${label} reason`, ActivationAlgebraErrorCode.invalidCallback);
  return Object.freeze({ state: state as ActivationState, reason });
}

function invokeCallback<Request extends object>(
  callback: ((request: Request) => ActivationFactDecision) | undefined,
  request: Request,
  label: string,
  missingReason: string,
): ActivationFactDecision {
  if (callback === undefined)
    return Object.freeze({ state: "indeterminate", reason: missingReason });
  let result: unknown;
  try {
    result = callback(Object.freeze(request));
  } catch (error: unknown) {
    fail(ActivationAlgebraErrorCode.callbackFailed, `${label} threw`, error);
  }
  return normalizeDecision(result, label);
}

function isWithinDirectory(
  targetPath: RepositoryRelativePath,
  directory: RepositoryRelativePath,
): boolean {
  return (
    directory === REPOSITORY_ROOT ||
    targetPath === directory ||
    targetPath.startsWith(`${directory}/`)
  );
}

function selectorKey(selector: ActivationRule["include"][number]): string {
  return selector.kind === "directory-tree"
    ? factKey("directory-selector", [selector.path])
    : factKey("glob-selector", [selector.dialectId ?? "", selector.pattern]);
}

function selectorResult(
  rule: ActivationRule,
  targetPath: RepositoryRelativePath,
  selector: ActivationRule["include"][number],
  callbacks: ActivationCallbacks,
  globMemo: Map<string, ActivationResult>,
): ActivationResult {
  if (selector.kind === "directory-tree") {
    const active = isWithinDirectory(targetPath, selector.path);
    return atomicResult(
      active ? "active" : "inactive",
      "directory-selector",
      [...ruleIdentityParts(rule), targetPath, selector.path],
      `Target ${describeText(targetPath)} is ${active ? "inside" : "outside"} directory selector ${describeText(selector.path)}.`,
    );
  }
  const key = selectorKey(selector);
  const cached = globMemo.get(key);
  if (cached !== undefined) return cached;
  const decision = invokeCallback(
    callbacks.matchGlob,
    {
      ruleId: rule.id,
      profileId: rule.profileId,
      surfaceId: rule.surfaceId,
      scopeRoot: rule.scopeRoot,
      targetPath,
      pattern: selector.pattern,
      dialectId: selector.dialectId,
    } satisfies GlobActivationRequest,
    "glob matcher",
    "No profile-owned glob matcher was supplied.",
  );
  const result = atomicResult(
    decision.state,
    "glob-selector",
    [
      ...ruleIdentityParts(rule),
      targetPath,
      rule.scopeRoot,
      selector.dialectId ?? "",
      selector.pattern,
    ],
    decision.reason,
  );
  globMemo.set(key, result);
  return result;
}

function selectorUnion(
  rule: ActivationRule,
  targetPath: RepositoryRelativePath,
  selectors: readonly ActivationRule["include"][number][],
  emptyState: "active" | "inactive",
  callbacks: ActivationCallbacks,
  globMemo: Map<string, ActivationResult>,
): ActivationResult {
  if (selectors.length === 0) return makeResult(emptyState, []);
  const unique = new Map<string, ActivationRule["include"][number]>();
  for (const selector of selectors) {
    const key = selectorKey(selector);
    if (!unique.has(key)) unique.set(key, selector);
  }
  const ordered = [...unique.entries()].sort(([left], [right]) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
  return activationUnion(
    ordered.map(([, selector]) => selectorResult(rule, targetPath, selector, callbacks, globMemo)),
  );
}

function baseResult(
  rule: ActivationRule,
  targetPath: RepositoryRelativePath,
  callbacks: ActivationCallbacks,
): ActivationResult {
  const kind: ActivationKind = rule.kind;
  if (kind === "always") {
    return atomicResult(
      "active",
      "always",
      ruleIdentityParts(rule),
      `Rule ${describeText(rule.id)} has unconditional activation.`,
    );
  }
  if (kind === "directory-tree" || kind === "glob") return makeResult("active", []);
  if (kind === "manual") {
    const decision = invokeCallback(
      callbacks.resolveManual,
      {
        ruleId: rule.id,
        documentId: rule.documentId,
        profileId: rule.profileId,
        surfaceId: rule.surfaceId,
        specSnapshotId: rule.specSnapshotId,
        targetPath,
        conditions: Object.freeze([...rule.conditions]),
      } satisfies ManualActivationRequest,
      "manual activation resolver",
      "No manual-activation fact callback was supplied.",
    );
    return atomicResult(
      decision.state,
      "manual-fact",
      [...ruleIdentityParts(rule), targetPath],
      decision.reason,
    );
  }
  if (kind === "conditional") {
    const decision = invokeCallback(
      callbacks.resolveConditional,
      {
        ruleId: rule.id,
        documentId: rule.documentId,
        profileId: rule.profileId,
        surfaceId: rule.surfaceId,
        specSnapshotId: rule.specSnapshotId,
        targetPath,
        conditions: Object.freeze([...rule.conditions]),
      } satisfies ConditionalActivationRequest,
      "conditional activation resolver",
      "No conditional-activation fact callback was supplied.",
    );
    return atomicResult(
      decision.state,
      "conditional-fact",
      [
        ...ruleIdentityParts(rule),
        targetPath,
        "conditions",
        String(rule.conditions.length),
        ...rule.conditions,
      ],
      decision.reason,
    );
  }
  const unknownReason = rule.unknownReason ?? "The B03 activation rule is unknown.";
  return atomicResult(
    "indeterminate",
    "unknown-rule",
    [...ruleIdentityParts(rule), unknownReason],
    unknownReason,
  );
}

/**
 * Evaluates one validated B03 rule for one caller-selected B01 path.
 *
 * Semantics are `scope ∩ trigger ∩ includes ∖ excludes`. Includes are a union (or universal
 * when absent), excludes are a union (or empty when absent), and a definite exclusion wins over an
 * otherwise active or indeterminate candidate. No event interpretation or glob dialect is invented.
 */
export function evaluateActivationRule(
  rule: ActivationRule,
  input: ActivationEvaluationInput,
): ActivationResult {
  assertRule(rule);
  if (
    !isDataRecord(input) ||
    !Object.keys(input).every((key) => ["targetPath", "callbacks"].includes(key))
  ) {
    fail(ActivationAlgebraErrorCode.invalidTargetPath, "activation input must be a data record");
  }
  const targetPath = dataProperty(input, "targetPath");
  assertText(targetPath, "targetPath", ActivationAlgebraErrorCode.invalidTargetPath);
  if (!isRepositoryRelativePath(targetPath)) {
    fail(ActivationAlgebraErrorCode.invalidTargetPath, "targetPath must be a canonical B01 path");
  }
  const rawCallbacks = dataProperty(input, "callbacks");
  const callbacks = rawCallbacks === undefined ? Object.freeze({}) : rawCallbacks;
  assertCallbacks(callbacks);

  const scopeInside = isWithinDirectory(targetPath, rule.scopeRoot);
  const scope =
    rule.scopeRoot === REPOSITORY_ROOT
      ? makeResult("active", [])
      : atomicResult(
          scopeInside ? "active" : "inactive",
          "scope-root",
          [...ruleIdentityParts(rule), targetPath, rule.scopeRoot],
          `Target ${describeText(targetPath)} is ${scopeInside ? "inside" : "outside"} scope root ${describeText(rule.scopeRoot)}.`,
        );
  if (scope.state === "inactive") return scope;

  const trigger = baseResult(rule, targetPath, callbacks);
  if (trigger.state === "inactive") return trigger;

  const globMemo = new Map<string, ActivationResult>();
  const included = selectorUnion(rule, targetPath, rule.include, "active", callbacks, globMemo);
  const eligible = activationIntersection([scope, trigger, included]);
  if (eligible.state === "inactive") return eligible;

  const excluded = selectorUnion(rule, targetPath, rule.exclude, "inactive", callbacks, globMemo);
  if (excluded.state === "active") return activationComplement(excluded);
  return activationDifference(eligible, excluded);
}

/** Canonical JSON serialization with fixed object keys and already-sorted provenance. */
export function serializeActivationResult(result: ActivationResult): string {
  const normalized = normalizeResult(result, "serialized activation result");
  return JSON.stringify({
    state: normalized.state,
    provenance: normalized.provenance.map((fact) => ({
      key: fact.key,
      kind: fact.kind,
      observedState: fact.observedState,
      description: fact.description,
    })),
  });
}
