import { createHash } from "node:crypto";

import type { EfficiencyComponentKey } from "@agent-context/core";

import type {
  BroadScopeDocumentMetric,
  ContextEfficiencyMetrics,
  ProfileMetricIdentity,
} from "./context-efficiency-metrics.js";
import { isIssuedContextEfficiencyMetrics } from "./context-efficiency-metrics.js";
import {
  EFFICIENCY_BROAD_SCOPE_CUTOFF_BASIS_POINTS,
  EFFICIENCY_DENSITY_TARGET_BASIS_POINTS,
  EFFICIENCY_SCORE_BASIS_POINTS,
  createEfficiencyScoreSpecification,
  efficiencyRatioBasisPoints,
  evaluateEfficiencyPenaltyCurve,
  gradeEfficiencyScore,
} from "./efficiency-score-specification.js";
import type {
  EfficiencyGrade,
  EfficiencyScoreInputSpecification,
  EfficiencyScoreSpecification,
} from "./efficiency-score-specification.js";
import type { ProfileTargetDistribution } from "./profile-target-distribution.js";

export const CONTEXT_EFFICIENCY_SCORE_CONTRACT_VERSION = "0.1.0" as const;
export const CONTEXT_EFFICIENCY_SCORE_RECORD_KIND = "agent-context-efficiency-score" as const;

const ISSUED_CONTEXT_EFFICIENCY_SCORES = new WeakSet<object>();

export type EfficiencyScoreState = "caveated" | "complete" | "unavailable";
export type EfficiencyScoreConfidence =
  "complete-static-evidence" | "limited-static-evidence" | "unavailable";

export type EfficiencyScoreCaveatCode =
  "estimated-tokenizer" | "sampling-stratified" | "zero-weight-component-unavailable";

export type EfficiencyScoreUncertaintyCode =
  | "amplification-partial"
  | "broad-scope-partial"
  | "dead-scope-unknown"
  | "density-partial"
  | "distribution-empty"
  | "distribution-partial"
  | "divergence-indeterminate"
  | "divergence-partial"
  | "sampling-partial";

export interface EfficiencyScoreEvidenceReference {
  readonly documentId: string | null;
  readonly id: string;
  readonly path: string | null;
  readonly profileKey: string | null;
  readonly state: "complete" | "empty" | "measured" | "partial" | "sampled" | "unknown";
  readonly tokens: number | null;
  readonly value: number | null;
  readonly valueUnit: "basis-points" | "count" | null;
}

export interface EfficiencyScoreInputResult {
  readonly allocationBasisPoints: number;
  readonly denominator: number | null;
  readonly evidence: readonly EfficiencyScoreEvidenceReference[];
  readonly id: string;
  readonly inputBasisPoints: number | null;
  readonly metricSource: string;
  readonly normalization: EfficiencyScoreInputSpecification["normalization"];
  readonly numerator: number | null;
  readonly penaltyBasisPoints: number | null;
  readonly reasonCodes: readonly EfficiencyScoreUncertaintyCode[];
  readonly state: "complete" | "sampled" | "unavailable";
}

export interface EfficiencyComponentScore {
  readonly id: EfficiencyComponentKey;
  readonly inputs: readonly EfficiencyScoreInputResult[];
  readonly reasonCodes: readonly EfficiencyScoreUncertaintyCode[];
  readonly score: number | null;
  readonly scoreBasisPoints: number | null;
  readonly state: "complete" | "ignored-unavailable" | "sampled" | "unavailable";
  readonly weight: number;
}

export interface ContextEfficiencyScore {
  readonly caveatCodes: readonly EfficiencyScoreCaveatCode[];
  readonly components: readonly EfficiencyComponentScore[];
  readonly confidence: EfficiencyScoreConfidence;
  readonly configuration: {
    readonly budgets: EfficiencyScoreSpecification["budgets"];
    readonly componentWeights: Readonly<Record<EfficiencyComponentKey, number>>;
    readonly gradeThresholds: EfficiencyScoreSpecification["gradeThresholds"];
    readonly scoreVersion: EfficiencyScoreSpecification["scoreVersion"];
  };
  readonly contractVersion: typeof CONTEXT_EFFICIENCY_SCORE_CONTRACT_VERSION;
  readonly grade: EfficiencyGrade | null;
  readonly identities: {
    readonly configurationSha256: string;
    readonly metricsSha256: string;
    readonly specificationSha256: string;
  };
  readonly qualityClaim: false;
  readonly recordKind: typeof CONTEXT_EFFICIENCY_SCORE_RECORD_KIND;
  readonly score: number | null;
  readonly semanticQualityPreservationClaim: false;
  readonly specification: EfficiencyScoreSpecification;
  readonly state: EfficiencyScoreState;
  readonly tokenizer: ContextEfficiencyMetrics["tokenizer"];
  readonly uncertaintyCodes: readonly EfficiencyScoreUncertaintyCode[];
}

export const ContextEfficiencyScoreErrorCode: Readonly<{
  invalidMetrics: "CONTEXT_EFFICIENCY_SCORE_INVALID_METRICS";
  resourceLimit: "CONTEXT_EFFICIENCY_SCORE_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidMetrics: "CONTEXT_EFFICIENCY_SCORE_INVALID_METRICS",
  resourceLimit: "CONTEXT_EFFICIENCY_SCORE_RESOURCE_LIMIT",
} as const);

export type ContextEfficiencyScoreErrorCode =
  (typeof ContextEfficiencyScoreErrorCode)[keyof typeof ContextEfficiencyScoreErrorCode];

export class ContextEfficiencyScoreError extends Error {
  readonly code: ContextEfficiencyScoreErrorCode;
  override readonly name = "ContextEfficiencyScoreError" as const;

  constructor(code: ContextEfficiencyScoreErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

/** True only for a G07 score issued by this process from authenticated G05 evidence. */
export function isIssuedContextEfficiencyScore(value: unknown): value is ContextEfficiencyScore {
  return typeof value === "object" && value !== null && ISSUED_CONTEXT_EFFICIENCY_SCORES.has(value);
}

interface NormalizedInput {
  readonly denominator: number | null;
  readonly evidence: readonly EfficiencyScoreEvidenceReference[];
  readonly inputBasisPoints: number | null;
  readonly numerator: number | null;
  readonly reasonCodes: readonly EfficiencyScoreUncertaintyCode[];
  readonly sampled: boolean;
}

const MAX_SCORE_EVIDENCE = 1_000_000;

function fail(code: ContextEfficiencyScoreErrorCode, message: string): never {
  throw new ContextEfficiencyScoreError(code, message);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    /* v8 ignore next -- G07 constructs only own data fields and composes frozen G05/G06 records */
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  /* v8 ignore start -- same-process G05 limits bound every score-side addition */
  if (!Number.isSafeInteger(result))
    return fail(ContextEfficiencyScoreErrorCode.resourceLimit, `${label} exceeds safe range`);
  /* v8 ignore stop */
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  /* v8 ignore start -- G05 document/profile limits bound this multiplication */
  if (!Number.isSafeInteger(result))
    return fail(ContextEfficiencyScoreErrorCode.resourceLimit, `${label} exceeds safe range`);
  /* v8 ignore stop */
  return result;
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function requiredNumber(value: number | null | undefined, label: string): number {
  /* v8 ignore start -- same-process G05 state invariants prove these values before use */
  if (value === null || value === undefined)
    return fail(ContextEfficiencyScoreErrorCode.invalidMetrics, `${label} is unavailable`);
  /* v8 ignore stop */
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function profileRef(
  id: string,
  profile: ProfileMetricIdentity,
  state: EfficiencyScoreEvidenceReference["state"],
  tokens: number | null,
  value: number | null = null,
  valueUnit: EfficiencyScoreEvidenceReference["valueUnit"] = null,
): EfficiencyScoreEvidenceReference {
  return Object.freeze({
    documentId: null,
    id,
    path: null,
    profileKey: profile.key,
    state,
    tokens,
    value,
    valueUnit: value === null ? null : valueUnit,
  });
}

function documentRef(
  id: string,
  profile: ProfileMetricIdentity,
  document: BroadScopeDocumentMetric,
): EfficiencyScoreEvidenceReference {
  return Object.freeze({
    documentId: document.documentId,
    id,
    path: document.path,
    profileKey: profile.key,
    state: document.state,
    tokens: document.effectiveTokens,
    value: document.coverageBasisPoints,
    valueUnit: document.coverageBasisPoints === null ? null : "basis-points",
  });
}

function aggregateRef(
  id: string,
  state: EfficiencyScoreEvidenceReference["state"],
  tokens: number | null,
  value: number | null = null,
  valueUnit: EfficiencyScoreEvidenceReference["valueUnit"] = null,
): EfficiencyScoreEvidenceReference {
  return Object.freeze({
    documentId: null,
    id,
    path: null,
    profileKey: null,
    state,
    tokens,
    value,
    valueUnit: value === null ? null : valueUnit,
  });
}

function nearestRank95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return requiredNumber(sorted[Math.ceil((sorted.length * 95) / 100) - 1], "p95 observation");
}

function samplingReasons(
  distributions: readonly ProfileTargetDistribution[],
): readonly EfficiencyScoreUncertaintyCode[] {
  const reasons = new Set<EfficiencyScoreUncertaintyCode>();
  for (const distribution of distributions) {
    if (distribution.sampling.state === "partial") reasons.add("sampling-partial");
    if (distribution.state === "partial") reasons.add("distribution-partial");
    if (distribution.state === "empty") reasons.add("distribution-empty");
  }
  return Object.freeze([...reasons].sort());
}

function isSampled(metrics: ContextEfficiencyMetrics): boolean {
  return metrics.distributions.some(
    (distribution) => distribution.sampling.strategy === "stratified",
  );
}

function unavailable(
  reasons: readonly EfficiencyScoreUncertaintyCode[],
  evidence: readonly EfficiencyScoreEvidenceReference[],
): NormalizedInput {
  return Object.freeze({
    denominator: null,
    evidence: Object.freeze(evidence),
    inputBasisPoints: null,
    numerator: null,
    reasonCodes: Object.freeze([...new Set(reasons)].sort()),
    sampled: false,
  });
}

function measured(
  numerator: number,
  denominator: number,
  evidence: readonly EfficiencyScoreEvidenceReference[],
  sampled: boolean,
): NormalizedInput {
  return Object.freeze({
    denominator,
    evidence: Object.freeze(evidence),
    inputBasisPoints: efficiencyRatioBasisPoints(numerator, denominator),
    numerator,
    reasonCodes: Object.freeze([]),
    sampled,
  });
}

function budgetInput(
  metrics: ContextEfficiencyMetrics,
  specification: EfficiencyScoreSpecification,
  kind: "always" | "effective",
): NormalizedInput {
  const reasons = samplingReasons(metrics.distributions);
  const evidence = metrics.distributions.map((distribution) => {
    const value =
      kind === "always"
        ? nearestRank95(
            distribution.targets
              .filter((target) => target.includedInStatistics)
              .map((target) => target.alwaysOnTokens),
          )
        : (distribution.statistics?.p95 ?? null);
    const state =
      distribution.state === "empty"
        ? "empty"
        : distribution.state === "partial"
          ? "partial"
          : distribution.sampling.strategy === "stratified"
            ? "sampled"
            : "complete";
    return profileRef(
      `${kind}-p95`,
      { ...distribution.profile, key: profileKey(distribution.profile) },
      state,
      value,
    );
  });
  if (reasons.length > 0) return unavailable(reasons, evidence);
  const maximum = Math.max(
    ...evidence.map((entry) => requiredNumber(entry.tokens, "budget observation")),
  );
  return measured(
    maximum,
    kind === "always"
      ? specification.budgets.alwaysOnTokens
      : specification.budgets.effectiveP95Tokens,
    evidence,
    isSampled(metrics),
  );
}

function profileKey(profile: Omit<ProfileMetricIdentity, "key">): string {
  return [
    profile.profileId,
    profile.surfaceId,
    profile.profileVersion,
    profile.specSnapshotId,
    profile.clientVersion ?? "<null>",
  ]
    .map((value) => `${Buffer.byteLength(value, "utf8").toString()}:${value}`)
    .join("|");
}

function broadScopeInput(metrics: ContextEfficiencyMetrics): NormalizedInput {
  const evidence = metrics.broadScope.flatMap((profile) =>
    profile.documents.map((document) =>
      documentRef("broad-scope-document", profile.profile, document),
    ),
  );
  if (metrics.broadScope.some((profile) => profile.state === "partial"))
    return unavailable(["broad-scope-partial"], evidence);
  let numerator = 0;
  let denominator = 0;
  for (const profile of metrics.broadScope) {
    for (const document of profile.documents) {
      denominator = safeAdd(denominator, document.effectiveTokens, "broad-scope denominator");
      if (
        requiredNumber(document.coverageBasisPoints, "broad-scope coverage") >=
        EFFICIENCY_BROAD_SCOPE_CUTOFF_BASIS_POINTS
      )
        numerator = safeAdd(numerator, document.effectiveTokens, "broad-scope numerator");
    }
  }
  return measured(numerator, denominator, evidence, isSampled(metrics));
}

function duplicateInput(
  metrics: ContextEfficiencyMetrics,
  kind: "exact" | "near",
): NormalizedInput {
  if (metrics.density.state === "partial")
    return unavailable(["density-partial"], [aggregateRef(`${kind}-duplicate`, "partial", null)]);
  const numerator =
    kind === "exact"
      ? metrics.duplication.exact.redundantTokens
      : metrics.duplication.near.similarityCandidateTokens;
  const evidence = [aggregateRef(`${kind}-duplicate`, "complete", numerator)];
  return measured(numerator, metrics.density.rawTokens, evidence, false);
}

function deadScopeInput(metrics: ContextEfficiencyMetrics): NormalizedInput {
  const evidence = metrics.deadScope.map((profile) =>
    profileRef("dead-scope-profile", profile.profile, profile.state, profile.tokens),
  );
  const unknown = metrics.deadScope.filter((profile) => profile.state === "unknown");
  if (unknown.length > 0) return unavailable(["dead-scope-unknown"], evidence);
  const numerator = metrics.deadScope.reduce(
    (sum, profile) =>
      safeAdd(sum, requiredNumber(profile.tokens, "dead-scope tokens"), "dead-scope numerator"),
    0,
  );
  const denominator = safeMultiply(
    metrics.density.rawTokens,
    metrics.deadScope.length,
    "dead-scope denominator",
  );
  return measured(numerator, denominator, evidence, false);
}

function amplificationInput(metrics: ContextEfficiencyMetrics): NormalizedInput {
  const evidence = metrics.amplification.map((profile) =>
    profileRef(
      "amplification-p95",
      profile.profile,
      profile.state === "empty" ? "empty" : profile.state,
      null,
      profile.statistics?.p95BasisPoints ?? null,
      "basis-points",
    ),
  );
  if (metrics.amplification.some((profile) => profile.state === "partial"))
    return unavailable(["amplification-partial"], evidence);
  const complete = metrics.amplification
    .map((profile) => profile.statistics?.p95BasisPoints ?? null)
    .filter((value): value is number => value !== null);
  if (complete.length === 0) return measured(0, 0, evidence, isSampled(metrics));
  const maximum = Math.max(...complete);
  return measured(
    Math.max(0, maximum - EFFICIENCY_SCORE_BASIS_POINTS),
    maximum,
    evidence,
    isSampled(metrics),
  );
}

function densityInput(metrics: ContextEfficiencyMetrics): NormalizedInput {
  const evidence = metrics.density.documents.map((document) =>
    Object.freeze({
      documentId: document.documentId,
      id: "density-document",
      path: document.path,
      profileKey: null,
      state: document.state,
      tokens: document.tokens,
      value: document.actionablePerThousandBasisPoints,
      valueUnit:
        document.actionablePerThousandBasisPoints === null ? null : ("basis-points" as const),
    }),
  );
  if (metrics.density.state === "partial") return unavailable(["density-partial"], evidence);
  if (metrics.density.state === "empty") return measured(0, 0, evidence, false);
  const observed = requiredNumber(
    metrics.density.actionablePerThousandBasisPoints,
    "instruction density",
  );
  return measured(
    Math.max(0, EFFICIENCY_DENSITY_TARGET_BASIS_POINTS - observed),
    EFFICIENCY_DENSITY_TARGET_BASIS_POINTS,
    evidence,
    false,
  );
}

function divergenceInput(metrics: ContextEfficiencyMetrics): NormalizedInput {
  const divergence = metrics.divergence;
  const evidence = [
    aggregateRef(
      "cross-profile-divergence",
      divergence.state,
      divergence.divergentPairTargetCount,
      divergence.observedPairTargetCount,
      "count",
    ),
  ];
  const reasons: EfficiencyScoreUncertaintyCode[] = [];
  if (divergence.state === "partial") reasons.push("divergence-partial");
  if (divergence.indeterminatePairTargetCount > 0) reasons.push("divergence-indeterminate");
  if (reasons.length > 0) return unavailable(reasons, evidence);
  if (divergence.expectedPairTargetCount === 0) return measured(0, 0, evidence, isSampled(metrics));
  return measured(
    divergence.divergentPairTargetCount,
    divergence.observedPairTargetCount,
    evidence,
    isSampled(metrics),
  );
}

function normalizedInputs(
  metrics: ContextEfficiencyMetrics,
  specification: EfficiencyScoreSpecification,
): ReadonlyMap<string, NormalizedInput> {
  return new Map([
    ["always-on-p95-budget", budgetInput(metrics, specification, "always")],
    ["effective-p95-budget", budgetInput(metrics, specification, "effective")],
    ["broad-scope-token-share", broadScopeInput(metrics)],
    ["exact-duplicate-token-share", duplicateInput(metrics, "exact")],
    ["near-duplicate-token-share", duplicateInput(metrics, "near")],
    ["dead-scope-token-share", deadScopeInput(metrics)],
    ["import-amplification-overhead", amplificationInput(metrics)],
    ["instruction-density-shortfall", densityInput(metrics)],
    ["cross-profile-divergence-rate", divergenceInput(metrics)],
  ]);
}

function scoreInput(
  specification: EfficiencyScoreInputSpecification,
  normalized: NormalizedInput,
): EfficiencyScoreInputResult {
  const penaltyBasisPoints =
    normalized.inputBasisPoints === null
      ? null
      : evaluateEfficiencyPenaltyCurve(specification.curve, normalized.inputBasisPoints);
  return Object.freeze({
    allocationBasisPoints: specification.allocationBasisPoints,
    denominator: normalized.denominator,
    evidence: normalized.evidence,
    id: specification.id,
    inputBasisPoints: normalized.inputBasisPoints,
    metricSource: specification.metricSource,
    normalization: specification.normalization,
    numerator: normalized.numerator,
    penaltyBasisPoints,
    reasonCodes: normalized.reasonCodes,
    state:
      normalized.inputBasisPoints === null
        ? "unavailable"
        : normalized.sampled
          ? "sampled"
          : "complete",
  });
}

function componentScore(
  specification: EfficiencyScoreSpecification["components"][number],
  values: ReadonlyMap<string, NormalizedInput>,
): EfficiencyComponentScore {
  const inputs = specification.inputs.map((input) => {
    const value = values.get(input.id);
    /* v8 ignore next -- the fixed G06 registry and G07 normalizer are reviewed together */
    if (value === undefined)
      return fail(
        ContextEfficiencyScoreErrorCode.invalidMetrics,
        `score input ${input.id} is unsupported`,
      );
    return scoreInput(input, value);
  });
  const reasons = Object.freeze([...new Set(inputs.flatMap((input) => input.reasonCodes))].sort());
  const hasUnavailable = inputs.some((input) => input.state === "unavailable");
  const state = hasUnavailable
    ? specification.weight === 0
      ? "ignored-unavailable"
      : "unavailable"
    : inputs.some((input) => input.state === "sampled")
      ? "sampled"
      : "complete";
  if (hasUnavailable)
    return Object.freeze({
      id: specification.id,
      inputs: Object.freeze(inputs),
      reasonCodes: reasons,
      score: null,
      scoreBasisPoints: null,
      state,
      weight: specification.weight,
    });
  const weightedPenalty = inputs.reduce(
    (sum, input) =>
      sum +
      BigInt(requiredNumber(input.penaltyBasisPoints, "input penalty")) *
        BigInt(input.allocationBasisPoints),
    0n,
  );
  const scoreBasisPoints =
    EFFICIENCY_SCORE_BASIS_POINTS -
    Number(roundHalfUp(weightedPenalty, BigInt(EFFICIENCY_SCORE_BASIS_POINTS)));
  return Object.freeze({
    id: specification.id,
    inputs: Object.freeze(inputs),
    reasonCodes: reasons,
    score: Number(roundHalfUp(BigInt(scoreBasisPoints), 100n)),
    scoreBasisPoints,
    state,
    weight: specification.weight,
  });
}

/**
 * Calculate the versioned static efficiency score from a same-process G05 evidence record.
 * The function is deterministic and capability-free; unavailable evidence never becomes zero.
 */
export function calculateContextEfficiencyScore(
  metricsValue: unknown,
  efficiencyConfiguration?: unknown,
): ContextEfficiencyScore {
  if (!isIssuedContextEfficiencyMetrics(metricsValue))
    return fail(
      ContextEfficiencyScoreErrorCode.invalidMetrics,
      "metrics must be a same-process G05 context-efficiency record",
    );
  const metrics = metricsValue;
  const specification = createEfficiencyScoreSpecification(efficiencyConfiguration);
  const values = normalizedInputs(metrics, specification);
  const evidenceCount = [...values.values()].reduce(
    (sum, value) => safeAdd(sum, value.evidence.length, "score evidence count"),
    0,
  );
  /* v8 ignore start -- G05's aggregate evidence cap ordinarily proves this stricter guard */
  if (evidenceCount > MAX_SCORE_EVIDENCE)
    return fail(ContextEfficiencyScoreErrorCode.resourceLimit, "score evidence exceeds its limit");
  /* v8 ignore stop */
  const components = Object.freeze(
    specification.components.map((component) => componentScore(component, values)),
  );
  const weightedUnavailable = components.some(
    (component) => component.weight > 0 && component.state === "unavailable",
  );
  const uncertaintyCodes = Object.freeze(
    [
      ...new Set(
        components
          .filter((component) => component.weight > 0)
          .flatMap((component) => component.reasonCodes),
      ),
    ].sort(),
  );
  const caveatCodes = new Set<EfficiencyScoreCaveatCode>();
  if (metrics.tokenizer.measurement === "estimate") caveatCodes.add("estimated-tokenizer");
  if (isSampled(metrics)) caveatCodes.add("sampling-stratified");
  if (components.some((component) => component.state === "ignored-unavailable"))
    caveatCodes.add("zero-weight-component-unavailable");
  let score: number | null = null;
  if (!weightedUnavailable) {
    const weightedScores = components.reduce(
      (sum, component) =>
        component.weight === 0
          ? sum
          : sum +
            BigInt(requiredNumber(component.scoreBasisPoints, "component score")) *
              BigInt(component.weight),
      0n,
    );
    score = Number(roundHalfUp(weightedScores, BigInt(EFFICIENCY_SCORE_BASIS_POINTS)));
  }
  const configuration = deepFreeze({
    budgets: specification.budgets,
    componentWeights: Object.fromEntries(
      specification.components.map((component) => [component.id, component.weight]),
    ) as Record<EfficiencyComponentKey, number>,
    gradeThresholds: specification.gradeThresholds,
    scoreVersion: specification.scoreVersion,
  });
  const sortedCaveats = Object.freeze([...caveatCodes].sort());
  const state: EfficiencyScoreState =
    score === null ? "unavailable" : sortedCaveats.length > 0 ? "caveated" : "complete";
  const result = deepFreeze({
    caveatCodes: sortedCaveats,
    components,
    confidence:
      state === "unavailable"
        ? ("unavailable" as const)
        : state === "caveated"
          ? ("limited-static-evidence" as const)
          : ("complete-static-evidence" as const),
    configuration,
    contractVersion: CONTEXT_EFFICIENCY_SCORE_CONTRACT_VERSION,
    grade: score === null ? null : gradeEfficiencyScore(score, specification.gradeThresholds),
    identities: {
      configurationSha256: sha256(configuration),
      metricsSha256: sha256(metrics),
      specificationSha256: sha256(specification),
    },
    qualityClaim: false as const,
    recordKind: CONTEXT_EFFICIENCY_SCORE_RECORD_KIND,
    score,
    semanticQualityPreservationClaim: false as const,
    specification,
    state,
    tokenizer: metrics.tokenizer,
    uncertaintyCodes,
  });
  ISSUED_CONTEXT_EFFICIENCY_SCORES.add(result);
  return result;
}
