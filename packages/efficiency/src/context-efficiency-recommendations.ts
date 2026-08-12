import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { RepositoryRelativePath } from "@agent-context/core";
import { resolveEffectiveContext } from "@agent-context/resolver";
import type {
  EffectiveContextResolution,
  ResolveEffectiveContextInput,
} from "@agent-context/resolver";

import type { ContextEfficiencyMetrics } from "./context-efficiency-metrics.js";
import { isIssuedContextEfficiencyMetrics } from "./context-efficiency-metrics.js";
import type {
  ContextEfficiencyScore,
  EfficiencyScoreConfidence,
} from "./context-efficiency-score.js";
import { isIssuedContextEfficiencyScore } from "./context-efficiency-score.js";
import {
  BUILTIN_ESTIMATE_IDENTITY,
  BUILTIN_ESTIMATE_PROVIDER_ID,
  OPTIONAL_UTF8_BYTE_IDENTITY,
  OPTIONAL_UTF8_BYTE_PROVIDER_ID,
  compareTokenizerIdentities,
} from "./tokenizer-contract.js";
import type { TokenCount, TokenizerIdentity } from "./tokenizer-contract.js";

export const CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION = "0.1.0" as const;
export const CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND =
  "agent-context-efficiency-recommendations-input" as const;
export const CONTEXT_EFFICIENCY_RECOMMENDATIONS_RECORD_KIND =
  "agent-context-efficiency-recommendations" as const;

const ISSUED_CONTEXT_EFFICIENCY_RECOMMENDATIONS = new WeakSet<object>();

export const CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS: Readonly<{
  maximumEvidenceDocumentIds: 4_096;
  maximumScenarios: 128;
  maximumTargets: 4_096;
}> = Object.freeze({
  maximumEvidenceDocumentIds: 4_096,
  maximumScenarios: 128,
  maximumTargets: 4_096,
} as const);

export type EfficiencyRecommendationKind = "exact-duplicate-consolidation" | "scope-narrowing";

export interface EfficiencyRecommendationTargetScenario {
  readonly baseline: ResolveEffectiveContextInput;
  readonly projected: ResolveEffectiveContextInput;
}

export interface EfficiencyRecommendationScenario {
  readonly evidenceDocumentIds: readonly string[];
  readonly evidenceId: string;
  readonly id: string;
  readonly targets: readonly EfficiencyRecommendationTargetScenario[];
}

/** Engine-owned token counter used only by closed runtime-specific recommendation entrypoints. */
export type RecommendationTokenCounter = (
  providerId: string,
  text: string,
  signal: AbortSignal | undefined,
) => Promise<TokenCount | null>;

export interface ProjectContextEfficiencyRecommendationsInput {
  readonly contractVersion: typeof CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION;
  readonly metrics: ContextEfficiencyMetrics;
  readonly recordKind: typeof CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND;
  readonly scenarios: readonly EfficiencyRecommendationScenario[];
  readonly score: ContextEfficiencyScore;
}

export interface ProjectContextEfficiencyRecommendationsOptions {
  readonly signal?: AbortSignal;
}

export type EfficiencyRecommendationCaveatCode =
  | "estimated-tokenizer"
  | "quality-not-empirically-verified"
  | "profile-resolution-uncertainty"
  | "semantic-equivalence-not-proven"
  | "source-score-caveated"
  | "source-score-unavailable"
  | "target-necessity-not-inferred";

export type EfficiencyRecommendationReasonCode =
  | "baseline-metrics-mismatch"
  | "content-retention-failed"
  | "content-retention-unknown"
  | "counterfactual-not-smaller"
  | "evidence-incomplete"
  | "missing-affected-target"
  | "no-intended-target"
  | "no-saving-target"
  | "projection-partial"
  | "tokenizer-unavailable"
  | "unexpected-affected-target";

export interface EfficiencyRecommendationProfileIdentity {
  readonly clientVersion: string | null;
  readonly key: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly specSnapshotId: string;
  readonly surfaceId: string;
}

export interface CounterfactualContextMeasurement {
  readonly ambiguityIds: readonly string[];
  readonly analysisStatus: "complete" | "partial";
  readonly assemblyByteLength: number | null;
  readonly assemblySha256: string | null;
  readonly contentSha256s: readonly string[];
  readonly profile: EfficiencyRecommendationProfileIdentity;
  readonly targetPath: RepositoryRelativePath;
  readonly tokens: number | null;
}

export interface CounterfactualRetentionProof {
  readonly missingContentSha256s: readonly string[];
  readonly mode: "byte-identical-assembly" | "unique-content-identities";
  readonly state: "failed" | "proved" | "unknown";
}

export interface EfficiencyRecommendationTargetProjection {
  readonly baseline: CounterfactualContextMeasurement;
  readonly estimatedSavingTokens: number | null;
  readonly projected: CounterfactualContextMeasurement;
  readonly retention: CounterfactualRetentionProof;
  readonly role: "affected" | "intended" | "saving";
}

export interface EfficiencyRecommendationEvidence {
  readonly documentIds: readonly string[];
  readonly id: string;
  readonly measuredTokens: number;
  readonly state: "complete" | "partial";
}

export interface EfficiencyRecommendationEvaluation {
  readonly affectedPaths: readonly RepositoryRelativePath[];
  readonly baselineTokens: number | null;
  readonly caveatCodes: readonly EfficiencyRecommendationCaveatCode[];
  readonly confidence: "high" | "low" | "medium" | "unavailable";
  readonly estimatedSavingBasisPoints: number | null;
  readonly estimatedSavingTokens: number | null;
  readonly evidence: EfficiencyRecommendationEvidence;
  readonly id: string;
  readonly kind: EfficiencyRecommendationKind;
  readonly profiles: readonly EfficiencyRecommendationProfileIdentity[];
  readonly projectedTokens: number | null;
  readonly qualityClaim: false;
  readonly reasonCodes: readonly EfficiencyRecommendationReasonCode[];
  readonly semanticQualityPreservationClaim: false;
  readonly state: "indeterminate" | "not-recommended" | "recommended";
  readonly targetProjections: readonly EfficiencyRecommendationTargetProjection[];
}

export interface ContextEfficiencyRecommendations {
  readonly contractVersion: typeof CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION;
  readonly evaluations: readonly EfficiencyRecommendationEvaluation[];
  readonly identities: {
    readonly configurationSha256: string;
    readonly metricsSha256: string;
    readonly scoreSpecificationSha256: string;
    readonly scoreVersion: string;
  };
  readonly limits: typeof CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS;
  readonly qualityClaim: false;
  readonly recommendations: readonly EfficiencyRecommendationEvaluation[];
  readonly recordKind: typeof CONTEXT_EFFICIENCY_RECOMMENDATIONS_RECORD_KIND;
  readonly semanticQualityPreservationClaim: false;
  readonly sourceScoreConfidence: EfficiencyScoreConfidence;
  readonly state: "complete" | "partial";
  readonly tokenizer: TokenizerIdentity;
}

export const ContextEfficiencyRecommendationsErrorCode: Readonly<{
  cancelled: "CONTEXT_EFFICIENCY_RECOMMENDATIONS_CANCELLED";
  invalidInput: "CONTEXT_EFFICIENCY_RECOMMENDATIONS_INVALID_INPUT";
  invalidRelationship: "CONTEXT_EFFICIENCY_RECOMMENDATIONS_INVALID_RELATIONSHIP";
  resourceLimit: "CONTEXT_EFFICIENCY_RECOMMENDATIONS_RESOURCE_LIMIT";
}> = Object.freeze({
  cancelled: "CONTEXT_EFFICIENCY_RECOMMENDATIONS_CANCELLED",
  invalidInput: "CONTEXT_EFFICIENCY_RECOMMENDATIONS_INVALID_INPUT",
  invalidRelationship: "CONTEXT_EFFICIENCY_RECOMMENDATIONS_INVALID_RELATIONSHIP",
  resourceLimit: "CONTEXT_EFFICIENCY_RECOMMENDATIONS_RESOURCE_LIMIT",
} as const);

export type ContextEfficiencyRecommendationsErrorCode =
  (typeof ContextEfficiencyRecommendationsErrorCode)[keyof typeof ContextEfficiencyRecommendationsErrorCode];

export class ContextEfficiencyRecommendationsError extends Error {
  readonly code: ContextEfficiencyRecommendationsErrorCode;
  override readonly name = "ContextEfficiencyRecommendationsError" as const;

  constructor(code: ContextEfficiencyRecommendationsErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

/** True only for a G08 recommendation result issued by this process. */
export function isIssuedContextEfficiencyRecommendations(
  value: unknown,
): value is ContextEfficiencyRecommendations {
  return (
    typeof value === "object" &&
    value !== null &&
    ISSUED_CONTEXT_EFFICIENCY_RECOMMENDATIONS.has(value)
  );
}

type DataRecord = Readonly<Record<string, unknown>>;

interface NormalizedScenario {
  readonly evidenceDocumentIds: readonly string[];
  readonly evidenceId: string;
  readonly id: string;
  readonly targets: readonly {
    readonly baseline: unknown;
    readonly projected: unknown;
  }[];
}

interface MeasuredPair {
  readonly projection: EfficiencyRecommendationTargetProjection;
  readonly key: string;
  readonly unrelatedChange: boolean;
  readonly witnessedEvidenceDocumentIds: readonly string[];
}

interface ValidatedEvidence {
  readonly expectedTargetKeys: ReadonlySet<string>;
  readonly kind: EfficiencyRecommendationKind;
  readonly output: EfficiencyRecommendationEvidence;
}

const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const INPUT_KEYS = ["contractVersion", "metrics", "recordKind", "scenarios", "score"] as const;
const SCENARIO_KEYS = ["evidenceDocumentIds", "evidenceId", "id", "targets"] as const;
const TARGET_KEYS = ["baseline", "projected"] as const;
const OPTIONS_KEYS = ["signal"] as const;
// The getter is invoked only through `.call` after the signal's proxy/type checks.
// eslint-disable-next-line @typescript-eslint/unbound-method
const ABORT_SIGNAL_ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function fail(code: ContextEfficiencyRecommendationsErrorCode, message: string): never {
  throw new ContextEfficiencyRecommendationsError(code, message);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    /* v8 ignore next -- this module constructs and composes only own data fields */
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function dataRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      `${label} must be a plain data record`,
    );
  let prototype: object | null;
  let actual: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    actual = Reflect.ownKeys(value);
  } catch {
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      `${label} cannot be inspected`,
    );
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      `${label} has unexpected fields`,
    );
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        ContextEfficiencyRecommendationsErrorCode.invalidInput,
        `${label}.${key} must be an own data field`,
      );
  }
  return value as DataRecord;
}

function field(record: DataRecord, key: string): unknown {
  return Reflect.getOwnPropertyDescriptor(record, key)?.value;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      `${label} must be a regular array`,
    );
  if (value.length > maximum)
    return fail(
      ContextEfficiencyRecommendationsErrorCode.resourceLimit,
      `${label} exceeds its item limit`,
    );
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      `${label} must be dense and unextended`,
    );
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        ContextEfficiencyRecommendationsErrorCode.invalidInput,
        `${label} contains an unsafe entry`,
      );
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    !IDENTIFIER.test(value)
  )
    return fail(ContextEfficiencyRecommendationsErrorCode.invalidInput, `${label} is invalid`);
  return value;
}

function normalizeInput(value: unknown): {
  readonly metrics: ContextEfficiencyMetrics;
  readonly scenarios: readonly NormalizedScenario[];
  readonly score: ContextEfficiencyScore;
} {
  const input = dataRecord(value, INPUT_KEYS, "input");
  if (
    field(input, "recordKind") !== CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND ||
    field(input, "contractVersion") !== CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION
  )
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "input kind or contract version is invalid",
    );
  const metricsValue = field(input, "metrics");
  if (!isIssuedContextEfficiencyMetrics(metricsValue))
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "metrics must be same-process G05 evidence",
    );
  const scoreValue = field(input, "score");
  if (!isIssuedContextEfficiencyScore(scoreValue))
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "score must be a same-process G07 result",
    );
  if (
    scoreValue.identities.metricsSha256 !== sha256(metricsValue) ||
    !compareTokenizerIdentities(metricsValue.tokenizer, scoreValue.tokenizer).compatible
  )
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
      "G05 and G07 evidence do not belong to the same analysis",
    );
  const values = denseArray(
    field(input, "scenarios"),
    CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS.maximumScenarios,
    "input.scenarios",
  );
  let totalTargets = 0;
  const scenarioIds = new Set<string>();
  const scenarios = values.map((value, index): NormalizedScenario => {
    const label = `input.scenarios[${String(index)}]`;
    const scenario = dataRecord(value, SCENARIO_KEYS, label);
    const id = boundedIdentifier(field(scenario, "id"), `${label}.id`);
    if (scenarioIds.has(id))
      return fail(
        ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
        "scenario IDs must be unique",
      );
    scenarioIds.add(id);
    const evidenceDocumentIds = denseArray(
      field(scenario, "evidenceDocumentIds"),
      CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS.maximumEvidenceDocumentIds,
      `${label}.evidenceDocumentIds`,
    ).map((entry, itemIndex) =>
      boundedIdentifier(entry, `${label}.evidenceDocumentIds[${String(itemIndex)}]`),
    );
    if (
      evidenceDocumentIds.length === 0 ||
      new Set(evidenceDocumentIds).size !== evidenceDocumentIds.length
    )
      return fail(
        ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
        "scenario evidence document IDs must be non-empty and unique",
      );
    const targetValues = denseArray(
      field(scenario, "targets"),
      CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS.maximumTargets,
      `${label}.targets`,
    );
    totalTargets += targetValues.length;
    if (
      totalTargets > CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS.maximumTargets ||
      targetValues.length === 0
    )
      return fail(
        ContextEfficiencyRecommendationsErrorCode.resourceLimit,
        "recommendation target count is empty or exceeds its aggregate limit",
      );
    const targets = targetValues.map(
      (targetValue, targetIndex): NormalizedScenario["targets"][number] => {
        const targetLabel = `${label}.targets[${String(targetIndex)}]`;
        const target = dataRecord(targetValue, TARGET_KEYS, targetLabel);
        return Object.freeze({
          baseline: field(target, "baseline"),
          projected: field(target, "projected"),
        });
      },
    );
    return Object.freeze({
      evidenceDocumentIds: Object.freeze([...evidenceDocumentIds].sort(compareUtf8)),
      evidenceId: boundedIdentifier(field(scenario, "evidenceId"), `${label}.evidenceId`),
      id,
      targets: Object.freeze(targets),
    });
  });
  return Object.freeze({
    metrics: metricsValue,
    scenarios: Object.freeze(scenarios.sort((left, right) => compareUtf8(left.id, right.id))),
    score: scoreValue,
  });
}

function signalFromOptions(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "options must be a closed plain data record",
    );
  let keys: readonly PropertyKey[];
  try {
    if (
      Reflect.getPrototypeOf(value) !== Object.prototype &&
      Reflect.getPrototypeOf(value) !== null
    )
      return fail(
        ContextEfficiencyRecommendationsErrorCode.invalidInput,
        "options must be a closed plain data record",
      );
    keys = Reflect.ownKeys(value);
  } catch {
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "options cannot be inspected",
    );
  }
  if (
    keys.length > OPTIONS_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== "string" || !OPTIONS_KEYS.includes(key as (typeof OPTIONS_KEYS)[number]),
    )
  )
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "options has unexpected fields",
    );
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        ContextEfficiencyRecommendationsErrorCode.invalidInput,
        "options fields must be own data properties",
      );
  }
  const options = value as DataRecord;
  const signal = field(options, "signal");
  if (signal === undefined) return undefined;
  if (signal === null || typeof signal !== "object" || nodeTypes.isProxy(signal))
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "options.signal must be an intrinsic AbortSignal",
    );
  try {
    if (ABORT_SIGNAL_ABORTED?.call(signal) === undefined)
      return fail(
        ContextEfficiencyRecommendationsErrorCode.invalidInput,
        "options.signal must be an intrinsic AbortSignal",
      );
  } catch {
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "options.signal must be an intrinsic AbortSignal",
    );
  }
  return signal as AbortSignal;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  let aborted: unknown;
  try {
    aborted = ABORT_SIGNAL_ABORTED?.call(signal);
  } catch {
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "options.signal cannot be inspected",
    );
  }
  if (aborted !== false)
    return fail(
      ContextEfficiencyRecommendationsErrorCode.cancelled,
      "recommendation projection was cancelled",
    );
}

function profileKey(profile: {
  readonly clientVersion: string | null;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly specSnapshotId: string;
  readonly surfaceId: string;
}): string {
  return [
    profile.profileId,
    profile.surfaceId,
    profile.profileVersion,
    profile.specSnapshotId,
    profile.clientVersion ?? "<null>",
  ]
    .map((entry) => `${Buffer.byteLength(entry, "utf8").toString()}:${entry}`)
    .join("|");
}

function profileIdentity(
  resolution: EffectiveContextResolution,
): EfficiencyRecommendationProfileIdentity {
  const identity = {
    clientVersion: resolution.clientVersion,
    profileId: resolution.profileId,
    profileVersion: resolution.profileVersion,
    specSnapshotId: resolution.specSnapshotId,
    surfaceId: resolution.surfaceId,
  };
  return Object.freeze({ ...identity, key: profileKey(identity) });
}

function targetKey(profile: { readonly key: string }, path: RepositoryRelativePath): string {
  return `${profile.key}|${Buffer.byteLength(path, "utf8").toString()}:${path}`;
}

function providerId(identity: TokenizerIdentity): string | null {
  if (compareTokenizerIdentities(identity, BUILTIN_ESTIMATE_IDENTITY).compatible)
    return BUILTIN_ESTIMATE_PROVIDER_ID;
  if (compareTokenizerIdentities(identity, OPTIONAL_UTF8_BYTE_IDENTITY).compatible)
    return OPTIONAL_UTF8_BYTE_PROVIDER_ID;
  return null;
}

async function measureResolution(
  resolution: EffectiveContextResolution,
  identity: TokenizerIdentity,
  signal: AbortSignal | undefined,
  countTokens: RecommendationTokenCounter,
): Promise<CounterfactualContextMeasurement> {
  throwIfCancelled(signal);
  let tokens: number | null = null;
  const selectedProvider = providerId(identity);
  const effectiveDocuments = resolution.documents.filter(
    (document) => document.activation === "active" && document.state !== "shadowed",
  );
  if (
    selectedProvider !== null &&
    resolution.assembly.state === "exact" &&
    resolution.occurrences.length === 0 &&
    effectiveDocuments.every((document) => document.text !== null)
  ) {
    let total = 0;
    let complete = true;
    for (const document of effectiveDocuments) {
      const text = document.text;
      if (text === null) {
        complete = false;
        break;
      }
      const counted = await countTokens(selectedProvider, text, signal);
      throwIfCancelled(signal);
      if (counted === null || !compareTokenizerIdentities(identity, counted.identity).compatible) {
        complete = false;
        break;
      }
      total += counted.tokens;
      if (!Number.isSafeInteger(total))
        return fail(
          ContextEfficiencyRecommendationsErrorCode.resourceLimit,
          "projected token total exceeds safe range",
        );
    }
    if (complete) tokens = total;
  }
  const contentSha256s = new Set<string>();
  for (const document of resolution.documents) {
    if (
      document.activation === "active" &&
      document.state !== "inactive" &&
      document.state !== "shadowed" &&
      document.contentSha256 !== null
    )
      contentSha256s.add(document.contentSha256);
  }
  return deepFreeze({
    ambiguityIds: Object.freeze(resolution.ambiguities.map((entry) => entry.id).sort(compareUtf8)),
    analysisStatus: resolution.analysisStatus,
    assemblyByteLength: resolution.assembly.byteLength,
    assemblySha256: resolution.assembly.sha256,
    contentSha256s: Object.freeze([...contentSha256s].sort(compareUtf8)),
    profile: profileIdentity(resolution),
    targetPath: resolution.targetPath,
    tokens,
  });
}

function retentionProof(
  kind: EfficiencyRecommendationKind,
  role: EfficiencyRecommendationTargetProjection["role"],
  baseline: CounterfactualContextMeasurement,
  projected: CounterfactualContextMeasurement,
): CounterfactualRetentionProof {
  const mode =
    kind === "scope-narrowing" && role === "intended"
      ? ("byte-identical-assembly" as const)
      : ("unique-content-identities" as const);
  if (baseline.tokens === null || projected.tokens === null)
    return Object.freeze({
      missingContentSha256s: Object.freeze([]),
      mode,
      state: "unknown" as const,
    });
  if (mode === "byte-identical-assembly") {
    const proved =
      baseline.assemblySha256 !== null &&
      baseline.assemblyByteLength !== null &&
      baseline.assemblySha256 === projected.assemblySha256 &&
      baseline.assemblyByteLength === projected.assemblyByteLength &&
      baseline.ambiguityIds.length === projected.ambiguityIds.length &&
      baseline.ambiguityIds.every((entry, index) => entry === projected.ambiguityIds[index]);
    return Object.freeze({
      missingContentSha256s: Object.freeze([]),
      mode,
      state: proved ? ("proved" as const) : ("failed" as const),
    });
  }
  const projectedContent = new Set(projected.contentSha256s);
  const missing = baseline.contentSha256s.filter((digest) => !projectedContent.has(digest));
  return Object.freeze({
    missingContentSha256s: Object.freeze(missing),
    mode,
    state: missing.length === 0 ? ("proved" as const) : ("failed" as const),
  });
}

function expectedTargets(
  metrics: ContextEfficiencyMetrics,
  documentIds: ReadonlySet<string>,
): Set<string> {
  const output = new Set<string>();
  for (const profile of metrics.amplification) {
    for (const target of profile.targets) {
      if (target.contributions.some((entry) => documentIds.has(entry.documentId)))
        output.add(targetKey(profile.profile, target.path));
    }
  }
  return output;
}

function validateEvidence(
  scenario: NormalizedScenario,
  metrics: ContextEfficiencyMetrics,
): ValidatedEvidence | null {
  const documentSet = new Set(scenario.evidenceDocumentIds);
  const cluster = metrics.duplication.exact.clusters.find(
    (entry) => entry.id === scenario.evidenceId,
  );
  if (cluster !== undefined) {
    const actual = [
      cluster.canonical.documentId,
      ...cluster.duplicates.map((entry) => entry.documentId),
    ].sort(compareUtf8);
    if (
      actual.length !== scenario.evidenceDocumentIds.length ||
      actual.some((entry, index) => entry !== scenario.evidenceDocumentIds[index])
    )
      return null;
    return Object.freeze({
      expectedTargetKeys: expectedTargets(metrics, documentSet),
      kind: "exact-duplicate-consolidation" as const,
      output: Object.freeze({
        documentIds: scenario.evidenceDocumentIds,
        id: scenario.evidenceId,
        measuredTokens: cluster.redundantTokens,
        state: "complete" as const,
      }),
    });
  }
  if (scenario.evidenceDocumentIds.length !== 1) return null;
  const documentId = scenario.evidenceDocumentIds[0];
  if (documentId === undefined || scenario.evidenceId !== documentId) return null;
  const observations = metrics.broadScope.flatMap((profile) =>
    profile.documents.filter((document) => document.documentId === documentId),
  );
  if (observations.length === 0) return null;
  const complete = observations.every(
    (document) => document.state === "complete" && document.coverageBasisPoints !== null,
  );
  const measuredTokens = Math.max(...observations.map((document) => document.effectiveTokens));
  return Object.freeze({
    expectedTargetKeys: expectedTargets(metrics, documentSet),
    kind: "scope-narrowing" as const,
    output: Object.freeze({
      documentIds: scenario.evidenceDocumentIds,
      id: scenario.evidenceId,
      measuredTokens,
      state: complete ? ("complete" as const) : ("partial" as const),
    }),
  });
}

function baselineMetricTokens(
  metrics: ContextEfficiencyMetrics,
  profile: EfficiencyRecommendationProfileIdentity,
  targetPath: RepositoryRelativePath,
): number | null {
  const distribution = metrics.distributions.find(
    (entry) => profileKey(entry.profile) === profile.key,
  );
  const target = distribution?.targets.find((entry) => entry.path === targetPath);
  return target?.state === "complete" && target.includedInStatistics
    ? target.effectiveTokens
    : null;
}

async function measurePair(
  target: NormalizedScenario["targets"][number],
  kind: EfficiencyRecommendationKind,
  evidenceDocumentIds: ReadonlySet<string>,
  metrics: ContextEfficiencyMetrics,
  identity: TokenizerIdentity,
  signal: AbortSignal | undefined,
  countTokens: RecommendationTokenCounter,
): Promise<MeasuredPair> {
  let baselineResolution: EffectiveContextResolution;
  let projectedResolution: EffectiveContextResolution;
  try {
    baselineResolution = resolveEffectiveContext(target.baseline);
    projectedResolution = resolveEffectiveContext(target.projected);
  } catch {
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidInput,
      "a counterfactual resolver input was rejected",
    );
  }
  const baselineProfile = profileIdentity(baselineResolution);
  const projectedProfile = profileIdentity(projectedResolution);
  if (
    baselineProfile.key !== projectedProfile.key ||
    baselineResolution.targetPath !== projectedResolution.targetPath
  )
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
      "baseline and projected contexts must have the same profile and target",
    );
  const baseline = await measureResolution(baselineResolution, identity, signal, countTokens);
  const projected = await measureResolution(projectedResolution, identity, signal, countTokens);
  const metricTokens = baselineMetricTokens(metrics, baseline.profile, baseline.targetPath);
  const baselineWithAuthority =
    metricTokens !== null && baseline.tokens === metricTokens
      ? baseline
      : { ...baseline, tokens: null };
  const saving =
    baselineWithAuthority.tokens === null || projected.tokens === null
      ? null
      : baselineWithAuthority.tokens - projected.tokens;
  const byteIdentical =
    baseline.assemblySha256 !== null &&
    baseline.assemblyByteLength !== null &&
    baseline.assemblySha256 === projected.assemblySha256 &&
    baseline.assemblyByteLength === projected.assemblyByteLength &&
    baseline.ambiguityIds.length === projected.ambiguityIds.length &&
    baseline.ambiguityIds.every((entry, index) => entry === projected.ambiguityIds[index]);
  const role: EfficiencyRecommendationTargetProjection["role"] = byteIdentical
    ? "intended"
    : saving !== null && saving > 0
      ? "saving"
      : "affected";
  const retention = retentionProof(kind, role, baseline, projected);
  const effective = (
    resolution: EffectiveContextResolution,
  ): readonly EffectiveContextResolution["documents"][number][] =>
    resolution.documents.filter(
      (document) =>
        document.activation !== "inactive" &&
        document.state !== "inactive" &&
        document.state !== "shadowed",
    );
  const baselineDocuments = effective(baselineResolution);
  const projectedDocuments = effective(projectedResolution);
  const projectedSignatures = new Set(
    projectedDocuments.map(
      (document) =>
        `${document.path}|${document.contentSha256 ?? "<null>"}|${document.contentState}|${document.truncation}`,
    ),
  );
  const baselineSignatures = new Set(
    baselineDocuments.map(
      (document) =>
        `${document.path}|${document.contentSha256 ?? "<null>"}|${document.contentState}|${document.truncation}`,
    ),
  );
  const unrelatedBaselineChange = baselineDocuments.some(
    (document) =>
      !projectedSignatures.has(
        `${document.path}|${document.contentSha256 ?? "<null>"}|${document.contentState}|${document.truncation}`,
      ) &&
      (document.sourceDocumentId === null || !evidenceDocumentIds.has(document.sourceDocumentId)),
  );
  const unrelatedProjectedChange = projectedDocuments.some((document) => {
    const signature = `${document.path}|${document.contentSha256 ?? "<null>"}|${document.contentState}|${document.truncation}`;
    if (baselineSignatures.has(signature)) return false;
    if (
      kind === "exact-duplicate-consolidation" &&
      document.contentSha256 !== null &&
      baseline.contentSha256s.includes(document.contentSha256)
    )
      return false;
    return (
      document.sourceDocumentId === null || !evidenceDocumentIds.has(document.sourceDocumentId)
    );
  });
  const witnessedEvidenceDocumentIds = baselineDocuments
    .map((document) => document.sourceDocumentId)
    .filter(
      (documentId): documentId is string =>
        documentId !== null && evidenceDocumentIds.has(documentId),
    );
  return Object.freeze({
    key: targetKey(baseline.profile, baseline.targetPath),
    projection: deepFreeze({
      baseline: baselineWithAuthority,
      estimatedSavingTokens: saving,
      projected,
      retention,
      role,
    }),
    unrelatedChange: unrelatedBaselineChange || unrelatedProjectedChange,
    witnessedEvidenceDocumentIds: Object.freeze(
      [...new Set(witnessedEvidenceDocumentIds)].sort(compareUtf8),
    ),
  });
}

function safeSum(values: readonly number[], label: string): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum))
      return fail(
        ContextEfficiencyRecommendationsErrorCode.resourceLimit,
        `${label} exceeds safe range`,
      );
  }
  return sum;
}

function caveats(
  metrics: ContextEfficiencyMetrics,
  score: ContextEfficiencyScore,
  projections: readonly EfficiencyRecommendationTargetProjection[],
): readonly EfficiencyRecommendationCaveatCode[] {
  const values = new Set<EfficiencyRecommendationCaveatCode>([
    "quality-not-empirically-verified",
    "semantic-equivalence-not-proven",
    "target-necessity-not-inferred",
  ]);
  if (metrics.tokenizer.measurement === "estimate") values.add("estimated-tokenizer");
  if (
    projections.some(
      (entry) =>
        entry.baseline.analysisStatus === "partial" || entry.projected.analysisStatus === "partial",
    )
  )
    values.add("profile-resolution-uncertainty");
  if (score.state === "caveated") values.add("source-score-caveated");
  if (score.state === "unavailable") values.add("source-score-unavailable");
  return Object.freeze([...values].sort());
}

function recommendationConfidence(
  score: ContextEfficiencyScore,
  projections: readonly EfficiencyRecommendationTargetProjection[],
): "high" | "low" | "medium" | "unavailable" {
  if (projections.some((entry) => entry.retention.state === "unknown")) return "unavailable";
  if (score.confidence === "unavailable") return "low";
  if (score.confidence === "complete-static-evidence" && score.tokenizer.measurement === "exact")
    return "high";
  return "medium";
}

async function evaluateScenario(
  scenario: NormalizedScenario,
  metrics: ContextEfficiencyMetrics,
  score: ContextEfficiencyScore,
  signal: AbortSignal | undefined,
  countTokens: RecommendationTokenCounter,
): Promise<EfficiencyRecommendationEvaluation> {
  throwIfCancelled(signal);
  const evidence = validateEvidence(scenario, metrics);
  if (evidence === null)
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
      "scenario evidence does not identify a supported G05 recommendation",
    );
  const evidenceDocumentIds = new Set(scenario.evidenceDocumentIds);
  const measured: MeasuredPair[] = [];
  for (const target of scenario.targets)
    measured.push(
      await measurePair(
        target,
        evidence.kind,
        evidenceDocumentIds,
        metrics,
        metrics.tokenizer,
        signal,
        countTokens,
      ),
    );
  measured.sort((left, right) => compareUtf8(left.key, right.key));
  if (new Set(measured.map((entry) => entry.key)).size !== measured.length)
    return fail(
      ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
      "scenario profile/target pairs must be unique",
    );
  const targetKeys = new Set(measured.map((entry) => entry.key));
  const reasonCodes = new Set<EfficiencyRecommendationReasonCode>();
  if (evidence.output.state !== "complete") reasonCodes.add("evidence-incomplete");
  const witnessed = new Set(measured.flatMap((entry) => entry.witnessedEvidenceDocumentIds));
  if (
    measured.some((entry) => entry.unrelatedChange) ||
    scenario.evidenceDocumentIds.some((documentId) => !witnessed.has(documentId))
  )
    reasonCodes.add("evidence-incomplete");
  const expected = evidence.expectedTargetKeys;
  if ([...expected].some((key) => !targetKeys.has(key))) reasonCodes.add("missing-affected-target");
  if ([...targetKeys].some((key) => !expected.has(key)))
    reasonCodes.add("unexpected-affected-target");
  const projections = Object.freeze(measured.map((entry) => entry.projection));
  if (
    evidence.kind === "scope-narrowing" &&
    !projections.some((entry) => entry.role === "intended")
  )
    reasonCodes.add("no-intended-target");
  if (!projections.some((entry) => entry.role === "saving")) reasonCodes.add("no-saving-target");
  if (projections.some((entry) => entry.baseline.tokens === null))
    reasonCodes.add("baseline-metrics-mismatch");
  if (projections.some((entry) => entry.projected.tokens === null))
    reasonCodes.add("tokenizer-unavailable");
  if (
    projections.some((entry) => entry.baseline.tokens === null || entry.projected.tokens === null)
  )
    reasonCodes.add("projection-partial");
  if (projections.some((entry) => entry.retention.state === "unknown"))
    reasonCodes.add("content-retention-unknown");
  if (
    projections.some((entry) => entry.role === "intended" && entry.retention.state === "failed") ||
    (evidence.kind === "exact-duplicate-consolidation" &&
      projections.some((entry) => entry.retention.state === "failed"))
  )
    reasonCodes.add("content-retention-failed");
  if (
    projections.some(
      (entry) =>
        entry.role === "saving" &&
        (entry.estimatedSavingTokens === null || entry.estimatedSavingTokens <= 0),
    )
  )
    reasonCodes.add("counterfactual-not-smaller");
  const unavailable = projections.some(
    (entry) => entry.baseline.tokens === null || entry.projected.tokens === null,
  );
  const baselineTokens = unavailable
    ? null
    : safeSum(
        projections.map((entry) => entry.baseline.tokens ?? 0),
        "baseline tokens",
      );
  const projectedTokens = unavailable
    ? null
    : safeSum(
        projections.map((entry) => entry.projected.tokens ?? 0),
        "projected tokens",
      );
  const saving =
    baselineTokens === null || projectedTokens === null ? null : baselineTokens - projectedTokens;
  const sortedReasons = Object.freeze([...reasonCodes].sort());
  const indeterminateReasons = new Set<EfficiencyRecommendationReasonCode>([
    "baseline-metrics-mismatch",
    "content-retention-unknown",
    "projection-partial",
    "tokenizer-unavailable",
  ]);
  const state =
    sortedReasons.length === 0
      ? ("recommended" as const)
      : sortedReasons.some((reason) => indeterminateReasons.has(reason))
        ? ("indeterminate" as const)
        : ("not-recommended" as const);
  const profiles = new Map<string, EfficiencyRecommendationProfileIdentity>();
  for (const projection of projections)
    profiles.set(projection.baseline.profile.key, projection.baseline.profile);
  const affectedPaths = Object.freeze(
    [...new Set(projections.map((entry) => entry.baseline.targetPath))].sort(compareUtf8),
  );
  return deepFreeze({
    affectedPaths,
    baselineTokens,
    caveatCodes: caveats(metrics, score, projections),
    confidence:
      state === "recommended" ? recommendationConfidence(score, projections) : "unavailable",
    estimatedSavingBasisPoints:
      saving === null || baselineTokens === null || baselineTokens === 0
        ? null
        : Number((BigInt(saving) * 10_000n) / BigInt(baselineTokens)),
    estimatedSavingTokens: saving,
    evidence: evidence.output,
    id: scenario.id,
    kind: evidence.kind,
    profiles: Object.freeze(
      [...profiles.values()].sort((left, right) => compareUtf8(left.key, right.key)),
    ),
    projectedTokens,
    qualityClaim: false as const,
    reasonCodes: sortedReasons,
    semanticQualityPreservationClaim: false as const,
    state,
    targetProjections: projections,
  });
}

/**
 * Rerun E05 over paired in-memory contexts and issue only quantified recommendations whose
 * profile/target coverage, baseline accounting, retention proof, and reduction all reconcile.
 */
export async function projectContextEfficiencyRecommendationsWithTokenCounter(
  inputValue: unknown,
  countTokens: RecommendationTokenCounter,
  options?: ProjectContextEfficiencyRecommendationsOptions,
): Promise<ContextEfficiencyRecommendations> {
  const input = normalizeInput(inputValue);
  const signal = signalFromOptions(options);
  throwIfCancelled(signal);
  const evaluations: EfficiencyRecommendationEvaluation[] = [];
  for (const scenario of input.scenarios)
    evaluations.push(
      await evaluateScenario(scenario, input.metrics, input.score, signal, countTokens),
    );
  const frozenEvaluations = Object.freeze(evaluations);
  const output = deepFreeze({
    contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
    evaluations: frozenEvaluations,
    identities: {
      configurationSha256: input.score.identities.configurationSha256,
      metricsSha256: input.score.identities.metricsSha256,
      scoreSpecificationSha256: input.score.identities.specificationSha256,
      scoreVersion: input.score.configuration.scoreVersion,
    },
    limits: CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS,
    qualityClaim: false as const,
    recommendations: Object.freeze(
      frozenEvaluations.filter((entry) => entry.state === "recommended"),
    ),
    recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_RECORD_KIND,
    semanticQualityPreservationClaim: false as const,
    sourceScoreConfidence: input.score.confidence,
    state: frozenEvaluations.some((entry) => entry.state === "indeterminate")
      ? ("partial" as const)
      : ("complete" as const),
    tokenizer: input.metrics.tokenizer,
  });
  ISSUED_CONTEXT_EFFICIENCY_RECOMMENDATIONS.add(output);
  return output;
}
