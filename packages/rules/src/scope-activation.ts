import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  MAX_DIAGNOSTICS_PER_BUNDLE,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
  computePathFingerprint,
  computeSemanticFingerprint,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import type {
  ActivationRule,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticId,
  DiagnosticSeverity,
  DiagnosticSourceLocation,
  FingerprintComponent,
  InstructionDocument,
  InstructionIr,
  RelatedEvidence,
  RelatedEvidenceId,
  RepositoryRelativePath,
  SourceDocument,
  SourceRange,
} from "@agent-context/core";
import { sampleTargets, serializeActivationResult } from "@agent-context/resolver";
import type {
  ActivationResult,
  SampleTargetsInput,
  TargetSamplingResult,
} from "@agent-context/resolver";

export const SCOPE_ACTIVATION_CONTRACT_VERSION = "0.1.0" as const;
export const SCOPE_ACTIVATION_RULE_VERSION = "1.0.0" as const;
export const SCOPE_ACTIVATION_RULE_IDS = [
  "ACL200",
  "ACL201",
  "ACL202",
  "ACL203",
  "ACL204",
  "ACL205",
  "ACL206",
] as const;
export type ScopeActivationRuleId = (typeof SCOPE_ACTIVATION_RULE_IDS)[number];

export const SCOPE_ACTIVATION_TARGET_KINDS = [
  "source",
  "generated",
  "vendored",
  "dependency",
  "unknown",
] as const;
export type ScopeActivationTargetKind = (typeof SCOPE_ACTIVATION_TARGET_KINDS)[number];

export const SCOPE_ACTIVATION_FACT_STATES = [
  "known",
  "ambiguous",
  "conditional",
  "contradictory",
  "unknown",
] as const;
export type ScopeActivationFactState = (typeof SCOPE_ACTIVATION_FACT_STATES)[number];

export interface ScopeActivationObservationResult {
  readonly result: ActivationResult;
  readonly ruleId: string;
}

export interface ScopeActivationObservation {
  readonly path: RepositoryRelativePath;
  readonly results: readonly ScopeActivationObservationResult[];
  readonly targetKind: ScopeActivationTargetKind;
}

export interface ScopeActivationRuleFact {
  readonly comparisonGroup: string | null;
  readonly factId: string;
  readonly nestingState: ScopeActivationFactState;
  readonly reachabilityState:
    | "ambiguous"
    | "conditional"
    | "contradictory"
    | "reachable"
    | "shadowed"
    | "unknown"
    | "unreachable";
  readonly ruleId: string;
  readonly scopeMetadataState: "missing" | "present" | "unknown";
  readonly shadowedByRuleIds: readonly string[];
}

export type ScopeActivationSamplingInput = Omit<SampleTargetsInput, "activationObservations">;

export interface ScopeActivationInput {
  readonly activationResults: readonly ScopeActivationObservation[];
  readonly contractVersion: typeof SCOPE_ACTIVATION_CONTRACT_VERSION;
  readonly facts: readonly ScopeActivationRuleFact[];
  readonly ir: InstructionIr;
  readonly recordKind: "agent-context-scope-activation-rule-input";
  readonly sampling: ScopeActivationSamplingInput;
}

export interface ScopeActivationLimits {
  readonly maximumActivationResults: number;
  readonly maximumDiagnostics: number;
  readonly maximumFacts: number;
  readonly maximumProvenanceFacts: number;
  readonly maximumRules: number;
  readonly maximumTextBytes: number;
  readonly maximumUncertainties: number;
}

export type ScopeActivationOptions = Partial<ScopeActivationLimits>;

export const SCOPE_ACTIVATION_DEFAULT_LIMITS: Readonly<ScopeActivationLimits> = Object.freeze({
  maximumActivationResults: 1_000_000,
  maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
  maximumFacts: 10_000,
  maximumProvenanceFacts: 4_096,
  maximumRules: 4_096,
  maximumTextBytes: 16_384,
  maximumUncertainties: 50_000,
});

export const SCOPE_ACTIVATION_HARD_LIMITS: Readonly<ScopeActivationLimits> = Object.freeze({
  maximumActivationResults: 10_000_000,
  maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
  maximumFacts: 100_000,
  maximumProvenanceFacts: 4_096,
  maximumRules: 100_000,
  maximumTextBytes: 65_536,
  maximumUncertainties: 250_000,
});

export type ScopeActivationSetState = "empty" | "indeterminate" | "non-empty" | "sampled-no-active";

export interface ScopeActivationSummary {
  readonly activeCount: number;
  readonly completeness: "exact" | "sampled";
  readonly inactiveCount: number;
  readonly indeterminateCount: number;
  readonly ruleId: string;
  readonly setState: ScopeActivationSetState;
}

export type ScopeActivationUncertaintyReason =
  | "activation-indeterminate"
  | "comparison-indeterminate"
  | "nesting-conditional"
  | "nesting-contradictory"
  | "nesting-unknown"
  | "reachability-ambiguous"
  | "reachability-conditional"
  | "reachability-contradictory"
  | "reachability-unknown"
  | "sampled-no-active"
  | "scope-metadata-unknown";

export interface ScopeActivationUncertainty {
  readonly path: RepositoryRelativePath | null;
  readonly reason: ScopeActivationUncertaintyReason;
  readonly ruleId: string;
}

export interface ScopeActivationMetrics {
  readonly activationResultCount: number;
  readonly diagnosticCount: number;
  readonly exactRuleCount: number;
  readonly ruleCount: number;
  readonly sampledRuleCount: number;
  readonly selectedTargetCount: number;
  readonly uncertaintyCount: number;
}

export interface ScopeActivationResult {
  readonly bundle: DiagnosticBundle;
  readonly contractVersion: typeof SCOPE_ACTIVATION_CONTRACT_VERSION;
  readonly limits: ScopeActivationLimits;
  readonly metrics: ScopeActivationMetrics;
  readonly recordKind: "agent-context-scope-activation-rule-result";
  readonly sampling: TargetSamplingResult;
  readonly sources: readonly SourceDocument[];
  readonly summaries: readonly ScopeActivationSummary[];
  readonly uncertainties: readonly ScopeActivationUncertainty[];
}

export const ScopeActivationErrorCode: Readonly<{
  dependencyFailure: "SCOPE_ACTIVATION_DEPENDENCY_FAILURE";
  invalidInput: "SCOPE_ACTIVATION_INVALID_INPUT";
  invalidOptions: "SCOPE_ACTIVATION_INVALID_OPTIONS";
  resourceLimit: "SCOPE_ACTIVATION_RESOURCE_LIMIT";
}> = Object.freeze({
  dependencyFailure: "SCOPE_ACTIVATION_DEPENDENCY_FAILURE",
  invalidInput: "SCOPE_ACTIVATION_INVALID_INPUT",
  invalidOptions: "SCOPE_ACTIVATION_INVALID_OPTIONS",
  resourceLimit: "SCOPE_ACTIVATION_RESOURCE_LIMIT",
} as const);
export type ScopeActivationErrorCode =
  (typeof ScopeActivationErrorCode)[keyof typeof ScopeActivationErrorCode];

export class ScopeActivationError extends Error {
  override readonly name = "ScopeActivationError" as const;
  readonly code: ScopeActivationErrorCode;

  constructor(code: ScopeActivationErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;
type ValidatedObservation = Readonly<{
  path: RepositoryRelativePath;
  results: ReadonlyMap<string, ActivationResult>;
  targetKind: ScopeActivationTargetKind;
}>;

const INPUT_KEYS = [
  "activationResults",
  "contractVersion",
  "facts",
  "ir",
  "recordKind",
  "sampling",
];
const SAMPLING_KEYS = [
  "criticalPaths",
  "paths",
  "trackingCertainty",
  "trackingReason",
  "workspaceBoundaries",
  "workspaceUncertainty",
  "workspaceUncertaintyReasons",
];
const OBSERVATION_KEYS = ["path", "results", "targetKind"];
const RESULT_KEYS = ["result", "ruleId"];
const FACT_KEYS = [
  "comparisonGroup",
  "factId",
  "nestingState",
  "reachabilityState",
  "ruleId",
  "scopeMetadataState",
  "shadowedByRuleIds",
];
const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const TARGET_KIND_SET = new Set<string>(SCOPE_ACTIVATION_TARGET_KINDS);
const FACT_STATE_SET = new Set<string>(SCOPE_ACTIVATION_FACT_STATES);
const REACHABILITY_STATE_SET = new Set<string>([
  "ambiguous",
  "conditional",
  "contradictory",
  "reachable",
  "shadowed",
  "unknown",
  "unreachable",
]);
const SEVERITY: Readonly<Record<ScopeActivationRuleId, DiagnosticSeverity>> = Object.freeze({
  ACL200: "error",
  ACL201: "warning",
  ACL202: "warning",
  ACL203: "warning",
  ACL204: "warning",
  ACL205: "warning",
  ACL206: "info",
});

function fail(code: ScopeActivationErrorCode, message: string): never {
  throw new ScopeActivationError(code, message);
}

function dataRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail(ScopeActivationErrorCode.invalidInput, `${label} must be a closed plain data record`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail(ScopeActivationErrorCode.invalidInput, `${label} has unexpected fields`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      fail(ScopeActivationErrorCode.invalidInput, `${label}.${key} must be an own data property`);
  }
  return value as DataRecord;
}

function property(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    fail(ScopeActivationErrorCode.invalidInput, `${label} must be a dense regular array`);
  if (value.length > maximum)
    fail(ScopeActivationErrorCode.resourceLimit, `${label} exceeds its item limit`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      fail(ScopeActivationErrorCode.invalidInput, `${label} contains an unsafe entry`);
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string, limits: ScopeActivationLimits): string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER.test(value) ||
    Buffer.byteLength(value, "utf8") > limits.maximumTextBytes
  )
    fail(ScopeActivationErrorCode.invalidInput, `${label} must be a bounded stable identifier`);
  return value;
}

function options(value: ScopeActivationOptions | undefined): ScopeActivationLimits {
  if (value === undefined) return SCOPE_ACTIVATION_DEFAULT_LIMITS;
  const input = dataRecord(value, Reflect.ownKeys(value) as string[], "options");
  const allowed = new Set(Object.keys(SCOPE_ACTIVATION_DEFAULT_LIMITS));
  const output = { ...SCOPE_ACTIVATION_DEFAULT_LIMITS };
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      fail(ScopeActivationErrorCode.invalidOptions, "options have unknown fields");
    const candidate = property(input, key);
    const hard = SCOPE_ACTIVATION_HARD_LIMITS[key as keyof ScopeActivationLimits];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < 1 ||
      (candidate as number) > hard
    )
      fail(ScopeActivationErrorCode.invalidOptions, `options.${key} is outside its hard limit`);
    output[key as keyof ScopeActivationLimits] = candidate as number;
  }
  return Object.freeze(output);
}

function normalizeActivationResult(
  value: unknown,
  limits: ScopeActivationLimits,
  label: string,
): ActivationResult {
  let serialized: string;
  try {
    serialized = serializeActivationResult(value as ActivationResult);
  } catch {
    return fail(ScopeActivationErrorCode.invalidInput, `${label} is not a valid E01 result`);
  }
  const parsed = JSON.parse(serialized) as ActivationResult;
  if (parsed.provenance.length > limits.maximumProvenanceFacts)
    fail(ScopeActivationErrorCode.resourceLimit, `${label} exceeds the provenance limit`);
  return Object.freeze({
    provenance: Object.freeze(parsed.provenance.map((entry) => Object.freeze(entry))),
    state: parsed.state,
  });
}

function validateObservations(
  value: unknown,
  ruleIds: ReadonlySet<string>,
  limits: ScopeActivationLimits,
): readonly ValidatedObservation[] {
  const entries = denseArray(value, limits.maximumActivationResults, "activationResults");
  const paths = new Set<string>();
  let resultCount = 0;
  const output = entries.map((entry, index): ValidatedObservation => {
    const label = `activationResults[${String(index)}]`;
    const record = dataRecord(entry, OBSERVATION_KEYS, label);
    const path = property(record, "path");
    if (typeof path !== "string")
      fail(ScopeActivationErrorCode.invalidInput, `${label}.path is invalid`);
    const targetKind = property(record, "targetKind");
    if (typeof targetKind !== "string" || !TARGET_KIND_SET.has(targetKind))
      fail(ScopeActivationErrorCode.invalidInput, `${label}.targetKind is invalid`);
    if (paths.has(path))
      fail(ScopeActivationErrorCode.invalidInput, "activation paths must be unique");
    paths.add(path);
    const rawResults = denseArray(
      property(record, "results"),
      limits.maximumRules,
      `${label}.results`,
    );
    resultCount += rawResults.length;
    if (resultCount > limits.maximumActivationResults)
      fail(ScopeActivationErrorCode.resourceLimit, "activation result matrix exceeds its limit");
    const results = new Map<string, ActivationResult>();
    for (const [resultIndex, rawResult] of rawResults.entries()) {
      const resultLabel = `${label}.results[${String(resultIndex)}]`;
      const resultRecord = dataRecord(rawResult, RESULT_KEYS, resultLabel);
      const ruleId = boundedIdentifier(
        property(resultRecord, "ruleId"),
        `${resultLabel}.ruleId`,
        limits,
      );
      if (!ruleIds.has(ruleId) || results.has(ruleId))
        fail(
          ScopeActivationErrorCode.invalidInput,
          `${resultLabel}.ruleId is unknown or duplicated`,
        );
      results.set(
        ruleId,
        normalizeActivationResult(
          property(resultRecord, "result"),
          limits,
          `${resultLabel}.result`,
        ),
      );
    }
    if (results.size !== ruleIds.size)
      fail(
        ScopeActivationErrorCode.invalidInput,
        `${label}.results must cover every activation rule`,
      );
    return Object.freeze({
      path: path as RepositoryRelativePath,
      results,
      targetKind: targetKind as ScopeActivationTargetKind,
    });
  });
  return Object.freeze([...output].sort((left, right) => compareText(left.path, right.path)));
}

function validateFacts(
  value: unknown,
  ruleIds: ReadonlySet<string>,
  limits: ScopeActivationLimits,
): ReadonlyMap<string, ScopeActivationRuleFact> {
  const entries = denseArray(value, limits.maximumFacts, "facts");
  const output = new Map<string, ScopeActivationRuleFact>();
  for (const [index, entry] of entries.entries()) {
    const label = `facts[${String(index)}]`;
    const record = dataRecord(entry, FACT_KEYS, label);
    const ruleId = boundedIdentifier(property(record, "ruleId"), `${label}.ruleId`, limits);
    const factId = boundedIdentifier(property(record, "factId"), `${label}.factId`, limits);
    if (!ruleIds.has(ruleId) || output.has(ruleId))
      fail(ScopeActivationErrorCode.invalidInput, `${label}.ruleId is unknown or duplicated`);
    const comparisonGroupValue = property(record, "comparisonGroup");
    const comparisonGroup =
      comparisonGroupValue === null
        ? null
        : boundedIdentifier(comparisonGroupValue, `${label}.comparisonGroup`, limits);
    const nestingState = property(record, "nestingState");
    if (typeof nestingState !== "string" || !FACT_STATE_SET.has(nestingState))
      fail(ScopeActivationErrorCode.invalidInput, `${label}.nestingState is invalid`);
    const reachabilityState = property(record, "reachabilityState");
    if (typeof reachabilityState !== "string" || !REACHABILITY_STATE_SET.has(reachabilityState))
      fail(ScopeActivationErrorCode.invalidInput, `${label}.reachabilityState is invalid`);
    const scopeMetadataState = property(record, "scopeMetadataState");
    if (
      scopeMetadataState !== "missing" &&
      scopeMetadataState !== "present" &&
      scopeMetadataState !== "unknown"
    )
      fail(ScopeActivationErrorCode.invalidInput, `${label}.scopeMetadataState is invalid`);
    const shadowedBy = denseArray(
      property(record, "shadowedByRuleIds"),
      limits.maximumRules,
      `${label}.shadowedByRuleIds`,
    ).map((item, shadowIndex) =>
      boundedIdentifier(item, `${label}.shadowedByRuleIds[${String(shadowIndex)}]`, limits),
    );
    if (
      new Set(shadowedBy).size !== shadowedBy.length ||
      shadowedBy.some((id) => !ruleIds.has(id) || id === ruleId)
    )
      fail(ScopeActivationErrorCode.invalidInput, `${label}.shadowedByRuleIds are invalid`);
    if ((reachabilityState === "shadowed") !== shadowedBy.length > 0)
      fail(
        ScopeActivationErrorCode.invalidInput,
        `${label} shadow state and shadowing rules disagree`,
      );
    output.set(
      ruleId,
      Object.freeze({
        comparisonGroup,
        factId,
        nestingState: nestingState as ScopeActivationFactState,
        reachabilityState: reachabilityState as ScopeActivationRuleFact["reachabilityState"],
        ruleId,
        scopeMetadataState,
        shadowedByRuleIds: Object.freeze([...shadowedBy].sort()),
      }),
    );
  }
  if (output.size !== ruleIds.size)
    fail(ScopeActivationErrorCode.invalidInput, "facts must cover every activation rule");
  return output;
}

function sha256(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values)
    hash.update(`${String(Buffer.byteLength(value, "utf8"))}:`).update(value);
  return hash.digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function directory(path: RepositoryRelativePath): RepositoryRelativePath {
  const slash = path.lastIndexOf("/");
  return (slash < 0 ? "." : path.slice(0, slash)) as RepositoryRelativePath;
}

function under(path: RepositoryRelativePath, root: RepositoryRelativePath): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function sourceLocation(source: SourceDocument, range: SourceRange): DiagnosticSourceLocation {
  return Object.freeze({
    path: source.path,
    range,
    sourceDigest: source.sha256,
    sourceId: source.id,
  });
}

function sourceEvidence(
  location: DiagnosticSourceLocation,
  label: string,
  seed: string,
): RelatedEvidence {
  return Object.freeze({
    id: `evidence:${sha256(seed).slice(0, 32)}` as RelatedEvidenceId,
    kind: "source",
    label,
    location,
  });
}

interface EvaluationContext {
  readonly diagnostics: Diagnostic[];
  readonly documentByRule: ReadonlyMap<string, InstructionDocument>;
  readonly facts: ReadonlyMap<string, ScopeActivationRuleFact>;
  readonly limits: ScopeActivationLimits;
  readonly observations: readonly ValidatedObservation[];
  readonly ruleById: ReadonlyMap<string, ActivationRule>;
  readonly sampling: TargetSamplingResult;
  readonly sourceByDocument: ReadonlyMap<string, SourceDocument>;
  readonly summaries: readonly ScopeActivationSummary[];
  readonly uncertaintyKeys: Set<string>;
  readonly uncertainties: ScopeActivationUncertainty[];
}

// The validated B03 node map is evaluator-owned and never accepted as a second caller graph.
type ContextWithNodes = EvaluationContext & {
  readonly irNodeById: ReadonlyMap<string, { readonly range: SourceRange }>;
};

function primaryFor(context: ContextWithNodes, ruleId: string): DiagnosticSourceLocation {
  const document = context.documentByRule.get(ruleId);
  const source = document === undefined ? undefined : context.sourceByDocument.get(document.id);
  /* v8 ignore next -- B03 validation and the evaluator-owned maps make this defensive check unreachable. */
  if (document === undefined || source === undefined)
    return fail(
      ScopeActivationErrorCode.dependencyFailure,
      "activation rule source is unavailable",
    );
  const rule = context.ruleById.get(ruleId);
  const selectorRange = rule?.include.find(
    (selector) => selector.sourceRange !== null,
  )?.sourceRange;
  if (selectorRange !== undefined && selectorRange !== null)
    return sourceLocation(source, selectorRange);
  const node = rule === undefined ? undefined : document.rootNodeId;
  const root = node === undefined ? undefined : context.irNodeById.get(node);
  /* v8 ignore next -- B03 requires every document root node to exist. */
  if (root === undefined)
    return fail(
      ScopeActivationErrorCode.dependencyFailure,
      "activation rule root node is unavailable",
    );
  return sourceLocation(source, root.range);
}

function addUncertainty(
  context: EvaluationContext,
  ruleId: string,
  reason: ScopeActivationUncertaintyReason,
  path: RepositoryRelativePath | null = null,
): void {
  const key = `${ruleId}\0${reason}\0${path ?? ""}`;
  if (context.uncertaintyKeys.has(key)) return;
  if (context.uncertainties.length >= context.limits.maximumUncertainties)
    fail(ScopeActivationErrorCode.resourceLimit, "uncertainties exceed their limit");
  context.uncertaintyKeys.add(key);
  context.uncertainties.push(Object.freeze({ path, reason, ruleId }));
}

function addDiagnostic(
  context: ContextWithNodes,
  ruleId: ScopeActivationRuleId,
  anchor: string,
  message: string,
  components: readonly FingerprintComponent[],
  relatedRuleIds: readonly string[],
): void {
  if (context.diagnostics.length >= context.limits.maximumDiagnostics)
    fail(ScopeActivationErrorCode.resourceLimit, "diagnostics exceed their limit");
  const primary = primaryFor(context, relatedRuleIds[0] ?? ruleId);
  const profiles = Object.freeze(
    [
      ...new Set(
        relatedRuleIds.flatMap((id) => {
          const profile = context.ruleById.get(id)?.profileId;
          return profile === undefined ? [] : [profile];
        }),
      ),
    ].sort(compareText),
  );
  const pathBasis = Object.freeze({ anchor, profileIds: profiles });
  const semanticBasis = Object.freeze({
    components: Object.freeze(
      [...components].sort((left, right) => compareText(left.key, right.key)),
    ),
    profileIds: profiles,
  });
  const semantic = computeSemanticFingerprint({
    basis: semanticBasis,
    ruleId,
    ruleVersion: SCOPE_ACTIVATION_RULE_VERSION,
  });
  const related = Object.freeze(
    relatedRuleIds.slice(0, 128).map((id) => {
      const location = primaryFor(context, id);
      return sourceEvidence(location, "Activation rule source", `${ruleId}:${id}`);
    }),
  );
  context.diagnostics.push(
    Object.freeze({
      fingerprintBasis: Object.freeze({ path: pathBasis, semantic: semanticBasis }),
      fingerprints: Object.freeze({
        path: Object.freeze({
          method: PATH_FINGERPRINT_METHOD,
          value: computePathFingerprint({
            basis: pathBasis,
            path: primary.path,
            ruleId,
            ruleVersion: SCOPE_ACTIVATION_RULE_VERSION,
          }),
        }),
        semantic: Object.freeze({ method: SEMANTIC_FINGERPRINT_METHOD, value: semantic }),
      }),
      id: `diagnostic:${ruleId.toLowerCase()}:${semantic.slice(0, 32)}` as DiagnosticId,
      message,
      primary,
      related,
      ruleId,
      ruleVersion: SCOPE_ACTIVATION_RULE_VERSION,
      severity: SEVERITY[ruleId],
      suggestion: Object.freeze({
        fixPlan: null,
        message:
          "Review the profile-owned scope evidence and narrow or clarify activation without removing applicable policy.",
      }),
    }),
  );
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareText(left.primary.path, right.primary.path) ||
    left.primary.range.start.byteOffset - right.primary.range.start.byteOffset ||
    compareText(left.ruleId, right.ruleId) ||
    compareText(left.fingerprints.semantic.value, right.fingerprints.semantic.value)
  );
}

function summarize(
  rules: readonly ActivationRule[],
  observations: readonly ValidatedObservation[],
  completeness: "exact" | "sampled",
): readonly ScopeActivationSummary[] {
  return Object.freeze(
    rules.map((rule) => {
      let activeCount = 0;
      let inactiveCount = 0;
      let indeterminateCount = 0;
      for (const observation of observations) {
        const state = observation.results.get(rule.id)?.state;
        if (state === "active") activeCount += 1;
        else if (state === "inactive") inactiveCount += 1;
        else indeterminateCount += 1;
      }
      const setState: ScopeActivationSetState =
        activeCount > 0
          ? "non-empty"
          : indeterminateCount > 0
            ? "indeterminate"
            : completeness === "exact"
              ? "empty"
              : "sampled-no-active";
      return Object.freeze({
        activeCount,
        completeness,
        inactiveCount,
        indeterminateCount,
        ruleId: rule.id,
        setState,
      });
    }),
  );
}

function evaluateRules(context: ContextWithNodes): void {
  const summaryById = new Map(context.summaries.map((summary) => [summary.ruleId, summary]));
  for (const [ruleId, rule] of context.ruleById) {
    const summary = summaryById.get(ruleId);
    const fact = context.facts.get(ruleId);
    /* v8 ignore next -- summaries and facts cover the validated activation-rule universe. */
    if (summary === undefined || fact === undefined) continue;
    const hasScopeSelector =
      rule.kind === "glob" || rule.kind === "directory-tree" || rule.include.length > 0;
    if (hasScopeSelector && summary.setState === "empty")
      addDiagnostic(
        context,
        "ACL200",
        `activation:${ruleId}`,
        "Scope is provably empty across the exact E08 target universe.",
        [
          { key: "activation-rule", value: ruleId },
          { key: "completeness", value: summary.completeness },
        ],
        [ruleId],
      );
    else if (hasScopeSelector && summary.setState === "sampled-no-active")
      addUncertainty(context, ruleId, "sampled-no-active");
    if (summary.setState === "indeterminate")
      addUncertainty(context, ruleId, "activation-indeterminate");

    if (
      fact.scopeMetadataState === "missing" &&
      rule.kind === "always" &&
      rule.scopeRoot === "." &&
      rule.include.length === 0 &&
      rule.exclude.length === 0
    )
      addDiagnostic(
        context,
        "ACL201",
        `activation:${ruleId}`,
        "Missing scope metadata makes this rule unconditionally active.",
        [{ key: "activation-rule", value: ruleId }],
        [ruleId],
      );
    else if (fact.scopeMetadataState === "unknown")
      addUncertainty(context, ruleId, "scope-metadata-unknown");

    const document = context.documentByRule.get(ruleId);
    const source = document === undefined ? undefined : context.sourceByDocument.get(document.id);
    if (source !== undefined && directory(source.path) !== ".") {
      const broadWitness = context.observations.find(
        (observation) =>
          observation.results.get(ruleId)?.state === "active" &&
          !under(observation.path, directory(source.path)),
      );
      if (broadWitness !== undefined)
        addDiagnostic(
          context,
          "ACL202",
          `activation:${ruleId}`,
          "Observed activation extends outside the instruction document's directory tree.",
          [
            { key: "activation-rule", value: ruleId },
            { key: "witness-path", value: broadWitness.path },
          ],
          [ruleId],
        );
    }

    if (fact.reachabilityState === "shadowed" || fact.reachabilityState === "unreachable")
      addDiagnostic(
        context,
        "ACL203",
        `activation:${ruleId}`,
        fact.reachabilityState === "shadowed"
          ? "Profile resolution evidence proves this rule is completely shadowed."
          : "Profile resolution evidence proves this rule is unreachable.",
        [
          { key: "activation-rule", value: ruleId },
          { key: "reachability-state", value: fact.reachabilityState },
          ...(fact.shadowedByRuleIds.length === 0
            ? []
            : [{ key: "shadowed-by", value: fact.shadowedByRuleIds.join(",") }]),
        ],
        [ruleId, ...fact.shadowedByRuleIds],
      );
    else if (fact.reachabilityState === "ambiguous")
      addUncertainty(context, ruleId, "reachability-ambiguous");
    else if (fact.reachabilityState === "conditional")
      addUncertainty(context, ruleId, "reachability-conditional");
    else if (fact.reachabilityState === "contradictory")
      addUncertainty(context, ruleId, "reachability-contradictory");
    else if (fact.reachabilityState === "unknown")
      addUncertainty(context, ruleId, "reachability-unknown");

    if (fact.nestingState === "ambiguous" || fact.nestingState === "contradictory")
      addDiagnostic(
        context,
        "ACL205",
        `activation:${ruleId}`,
        fact.nestingState === "contradictory"
          ? "Selected-client nesting evidence is contradictory."
          : "Selected-client nesting behavior is ambiguous.",
        [
          { key: "activation-rule", value: ruleId },
          { key: "nesting-state", value: fact.nestingState },
        ],
        [ruleId],
      );
    if (fact.nestingState === "conditional") addUncertainty(context, ruleId, "nesting-conditional");
    else if (fact.nestingState === "contradictory")
      addUncertainty(context, ruleId, "nesting-contradictory");
    else if (fact.nestingState === "unknown") addUncertainty(context, ruleId, "nesting-unknown");

    const affectedArtifacts = context.observations.filter(
      (observation) =>
        observation.targetKind !== "source" &&
        observation.targetKind !== "unknown" &&
        observation.results.get(ruleId)?.state === "active",
    );
    if (affectedArtifacts.length > 0)
      addDiagnostic(
        context,
        "ACL206",
        `activation:${ruleId}`,
        "Instruction activation includes generated, vendored, or dependency source files.",
        [
          { key: "activation-rule", value: ruleId },
          { key: "affected-count", value: String(affectedArtifacts.length) },
          {
            key: "artifact-kinds",
            value: [...new Set(affectedArtifacts.map((entry) => entry.targetKind))]
              .sort()
              .join(","),
          },
        ],
        [ruleId],
      );
  }

  const comparisons = new Map<string, string[]>();
  for (const fact of context.facts.values()) {
    if (fact.comparisonGroup === null) continue;
    const group = comparisons.get(fact.comparisonGroup) ?? [];
    group.push(fact.ruleId);
    comparisons.set(fact.comparisonGroup, group);
  }
  for (const [groupId, rawRuleIds] of [...comparisons].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const ruleIds = rawRuleIds.sort(compareText);
    if (ruleIds.length < 2) continue;
    let witness: RepositoryRelativePath | null = null;
    let indeterminate = false;
    for (const observation of context.observations) {
      const states = ruleIds.map((id) => observation.results.get(id)?.state ?? "indeterminate");
      if (states.includes("active") && states.includes("inactive")) {
        witness = observation.path;
        break;
      }
      if (states.includes("indeterminate") && new Set(states).size > 1) indeterminate = true;
    }
    if (witness !== null)
      addDiagnostic(
        context,
        "ACL204",
        `comparison:${groupId}`,
        "Different client profiles produce materially different activation for the same sampled target.",
        [
          { key: "comparison-group", value: groupId },
          { key: "witness-path", value: witness },
        ],
        ruleIds,
      );
    else if (indeterminate)
      for (const ruleId of ruleIds) addUncertainty(context, ruleId, "comparison-indeterminate");
  }
}

/** Evaluate ACL200-ACL206 from B03 rules, canonical E01 results, and E08 target sampling. */
export function evaluateScopeActivationRules(
  inputValue: ScopeActivationInput,
  optionsValue?: ScopeActivationOptions,
): ScopeActivationResult {
  const limits = options(optionsValue);
  const input = dataRecord(inputValue, INPUT_KEYS, "input");
  if (
    property(input, "recordKind") !== "agent-context-scope-activation-rule-input" ||
    property(input, "contractVersion") !== SCOPE_ACTIVATION_CONTRACT_VERSION
  )
    fail(ScopeActivationErrorCode.invalidInput, "input kind or contract version is invalid");
  const irValidation = validateInstructionIr(property(input, "ir"));
  if (!irValidation.ok) fail(ScopeActivationErrorCode.invalidInput, "input.ir must satisfy B03");
  const ir = irValidation.value;
  if (ir.activationRules.length > limits.maximumRules)
    fail(ScopeActivationErrorCode.resourceLimit, "activation rules exceed their limit");
  const ruleIds = new Set(ir.activationRules.map((rule) => rule.id));
  const observations = validateObservations(property(input, "activationResults"), ruleIds, limits);
  const facts = validateFacts(property(input, "facts"), ruleIds, limits);
  const samplingRecord = dataRecord(property(input, "sampling"), SAMPLING_KEYS, "sampling");
  let sampling: TargetSamplingResult;
  try {
    sampling = sampleTargets({
      activationObservations: observations.map((observation) =>
        Object.freeze({
          path: observation.path,
          states: Object.freeze(
            [...observation.results].map(([ruleId, result]) =>
              Object.freeze({ ruleId, state: result.state }),
            ),
          ),
        }),
      ),
      criticalPaths: property(
        samplingRecord,
        "criticalPaths",
      ) as SampleTargetsInput["criticalPaths"],
      paths: property(samplingRecord, "paths") as SampleTargetsInput["paths"],
      trackingCertainty: property(
        samplingRecord,
        "trackingCertainty",
      ) as SampleTargetsInput["trackingCertainty"],
      trackingReason: property(
        samplingRecord,
        "trackingReason",
      ) as SampleTargetsInput["trackingReason"],
      workspaceBoundaries: property(
        samplingRecord,
        "workspaceBoundaries",
      ) as SampleTargetsInput["workspaceBoundaries"],
      workspaceUncertainty: property(
        samplingRecord,
        "workspaceUncertainty",
      ) as SampleTargetsInput["workspaceUncertainty"],
      workspaceUncertaintyReasons: property(
        samplingRecord,
        "workspaceUncertaintyReasons",
      ) as SampleTargetsInput["workspaceUncertaintyReasons"],
    });
  } catch {
    return fail(ScopeActivationErrorCode.invalidInput, "sampling input must satisfy E08");
  }
  const selected = new Set(sampling.selected.map((target) => target.path));
  const selectedObservations = observations.filter((observation) => selected.has(observation.path));
  const completeness =
    sampling.strategy === "exhaustive" &&
    sampling.state === "complete" &&
    sampling.metrics.trackedPathCount === sampling.metrics.sourcePathCount
      ? "exact"
      : "sampled";
  const rules = [...ir.activationRules].sort((left, right) => compareText(left.id, right.id));
  const summaries = summarize(rules, selectedObservations, completeness);
  const documentById = new Map(ir.documents.map((document) => [document.id, document]));
  const sourceById = new Map(ir.sources.map((source) => [source.id, source]));
  const documentByRule = new Map<string, InstructionDocument>();
  const sourceByDocument = new Map<string, SourceDocument>();
  for (const rule of rules) {
    const document = documentById.get(rule.documentId);
    const source = document === undefined ? undefined : sourceById.get(document.sourceId);
    /* v8 ignore next -- B03 validation proves activation ownership and source relationships. */
    if (document === undefined || source === undefined)
      fail(ScopeActivationErrorCode.dependencyFailure, "B03 activation ownership is incomplete");
    documentByRule.set(rule.id, document);
    sourceByDocument.set(document.id, source);
  }
  const context: ContextWithNodes = {
    diagnostics: [],
    documentByRule,
    facts,
    irNodeById: new Map(ir.nodes.map((node) => [node.id, node])),
    limits,
    observations: selectedObservations,
    ruleById: new Map(rules.map((rule) => [rule.id, rule])),
    sampling,
    sourceByDocument,
    summaries,
    uncertainties: [],
    uncertaintyKeys: new Set(),
  };
  evaluateRules(context);
  context.uncertainties.sort(
    (left, right) =>
      compareText(left.ruleId, right.ruleId) ||
      compareText(left.reason, right.reason) ||
      compareText(left.path ?? "", right.path ?? ""),
  );
  const bundle: DiagnosticBundle = Object.freeze({
    contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
    diagnostics: Object.freeze(context.diagnostics.sort(compareDiagnostics)),
    recordKind: "agent-context-diagnostics",
    suppressions: Object.freeze([]),
  });
  const validated = validateDiagnosticBundle(bundle, ir.sources);
  /* v8 ignore next -- diagnostics use only validated B03 locations and closed B04 fields. */
  if (!validated.ok)
    fail(ScopeActivationErrorCode.dependencyFailure, "generated diagnostics failed B04 validation");
  const exactRuleCount = summaries.filter((summary) => summary.completeness === "exact").length;
  return Object.freeze({
    bundle: validated.value,
    contractVersion: SCOPE_ACTIVATION_CONTRACT_VERSION,
    limits,
    metrics: Object.freeze({
      activationResultCount: observations.reduce(
        (total, observation) => total + observation.results.size,
        0,
      ),
      diagnosticCount: validated.value.diagnostics.length,
      exactRuleCount,
      ruleCount: rules.length,
      sampledRuleCount: summaries.length - exactRuleCount,
      selectedTargetCount: selectedObservations.length,
      uncertaintyCount: context.uncertainties.length,
    }),
    recordKind: "agent-context-scope-activation-rule-result",
    sampling,
    sources: Object.freeze([...ir.sources]),
    summaries,
    uncertainties: Object.freeze(context.uncertainties),
  });
}
