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
import {
  compareTokenizerIdentities,
  isIssuedContextEfficiencyMetrics,
  isIssuedContextEfficiencyRecommendations,
  isIssuedContextEfficiencyScore,
} from "@agent-context/efficiency/scan-runtime";
import { matchSuppressionDirectives, parseSuppressionDirectives } from "@agent-context/syntax";

import type {
  ClientProfileId,
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
  RepositoryFactRelatedEvidence,
  SourceDocument,
  SourceRange,
} from "@agent-context/core";
import type {
  ContextEfficiencyMetrics,
  ContextEfficiencyRecommendations,
  ContextEfficiencyScore,
  EfficiencyRecommendationEvaluation,
  ProfileMetricIdentity,
} from "@agent-context/efficiency/scan-runtime";
import type { ParsedSuppressionDirective } from "@agent-context/syntax";

export const CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION = "0.1.0" as const;
export const CONTEXT_EFFICIENCY_RULE_VERSION = "1.0.0" as const;
export const CONTEXT_EFFICIENCY_RULE_IDS = [
  "ACL550",
  "ACL551",
  "ACL552",
  "ACL553",
  "ACL554",
  "ACL555",
  "ACL556",
  "ACL557",
  "ACL558",
] as const;
export type ContextEfficiencyRuleId = (typeof CONTEXT_EFFICIENCY_RULE_IDS)[number];

export interface EfficiencyTokenizerComparisonInput {
  readonly baseline: ContextEfficiencyScore;
  readonly candidate: ContextEfficiencyScore;
  readonly id: string;
  readonly sourceDocumentId: string;
}

export interface ContextEfficiencyRuleInput {
  readonly contractVersion: typeof CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION;
  readonly ir: InstructionIr;
  readonly metrics: ContextEfficiencyMetrics;
  readonly recommendations: ContextEfficiencyRecommendations;
  readonly recordKind: "agent-context-efficiency-rule-input";
  readonly score: ContextEfficiencyScore;
  readonly tokenizerComparisons: readonly EfficiencyTokenizerComparisonInput[];
}

export interface ContextEfficiencyRuleThresholds {
  readonly duplicateTokens: number;
  readonly highImpactSavingBasisPoints: number;
  readonly highImpactSavingTokens: number;
  readonly importAmplificationBasisPoints: number;
  readonly minimumDensityBasisPoints: number;
}

export type ContextEfficiencyRuleOptions = Partial<ContextEfficiencyRuleThresholds>;

export const CONTEXT_EFFICIENCY_RULE_DEFAULT_THRESHOLDS: Readonly<ContextEfficiencyRuleThresholds> =
  Object.freeze({
    duplicateTokens: 128,
    highImpactSavingBasisPoints: 2_000,
    highImpactSavingTokens: 512,
    importAmplificationBasisPoints: 15_000,
    minimumDensityBasisPoints: 1_000_000,
  });

export const CONTEXT_EFFICIENCY_RULE_HARD_MAXIMUM_THRESHOLD = 1_000_000_000 as const;
export const CONTEXT_EFFICIENCY_RULE_MAX_COMPARISONS = 4_096 as const;

export type ContextEfficiencyUncertaintyReason =
  | "metrics-partial"
  | "profile-evidence-partial"
  | "recommendation-indeterminate"
  | "score-caveated"
  | "score-unavailable";

export interface ContextEfficiencyUncertainty {
  readonly evidenceId: string | null;
  readonly profileId: string | null;
  readonly reason: ContextEfficiencyUncertaintyReason;
  readonly ruleId: ContextEfficiencyRuleId;
}

export interface ContextEfficiencyRuleMetrics {
  readonly diagnosticCount: number;
  readonly recommendationCount: number;
  readonly suppressionDirectiveCount: number;
  readonly tokenizerComparisonCount: number;
  readonly uncertaintyCount: number;
}

export type ContextEfficiencyRuleIssueCode =
  | "dependency-failure"
  | "invalid-input"
  | "invalid-options"
  | "invalid-relationship"
  | "resource-limit";

export interface ContextEfficiencyRuleIssue {
  readonly code: ContextEfficiencyRuleIssueCode;
  readonly message: string;
  readonly path: string;
}

export type ContextEfficiencyRuleResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly contractVersion: typeof CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION;
      readonly metrics: ContextEfficiencyRuleMetrics;
      readonly ok: true;
      readonly sources: readonly SourceDocument[];
      readonly thresholds: ContextEfficiencyRuleThresholds;
      readonly uncertainties: readonly ContextEfficiencyUncertainty[];
    }
  | { readonly issues: readonly ContextEfficiencyRuleIssue[]; readonly ok: false };

export type ContextEfficiencySuppressionFinalizationResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly ok: true;
      readonly suppressedDiagnostics: readonly Diagnostic[];
      readonly visibleDiagnostics: readonly Diagnostic[];
    }
  | { readonly issues: readonly ContextEfficiencyRuleIssue[]; readonly ok: false };

interface Comparison {
  readonly baseline: ContextEfficiencyScore;
  readonly candidate: ContextEfficiencyScore;
  readonly id: string;
  readonly sourceDocumentId: string;
}

interface Context {
  readonly diagnostics: Diagnostic[];
  readonly documentById: ReadonlyMap<string, InstructionDocument>;
  readonly ir: InstructionIr;
  readonly metrics: ContextEfficiencyMetrics;
  readonly recommendations: ContextEfficiencyRecommendations;
  readonly score: ContextEfficiencyScore;
  readonly sourceById: ReadonlyMap<string, SourceDocument>;
  readonly thresholds: ContextEfficiencyRuleThresholds;
  readonly uncertainties: ContextEfficiencyUncertainty[];
}

const INPUT_KEYS = new Set([
  "contractVersion",
  "ir",
  "metrics",
  "recommendations",
  "recordKind",
  "score",
  "tokenizerComparisons",
]);
const COMPARISON_KEYS = new Set(["baseline", "candidate", "id", "sourceDocumentId"]);
const OPTION_KEYS = new Set(Object.keys(CONTEXT_EFFICIENCY_RULE_DEFAULT_THRESHOLDS));
const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const issuedEvaluations = new WeakMap<
  object,
  { readonly directives: readonly ParsedSuppressionDirective[]; readonly ir: InstructionIr }
>();

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function jsonSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function issue(
  code: ContextEfficiencyRuleIssueCode,
  path: string,
  message: string,
): ContextEfficiencyRuleIssue {
  return Object.freeze({ code, message, path });
}

function failure(value: ContextEfficiencyRuleIssue): ContextEfficiencyRuleResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function closedRecord(
  value: unknown,
  keys: ReadonlySet<string>,
): ReadonlyMap<string, unknown> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return undefined;
  try {
    if (Reflect.getPrototypeOf(value) !== Object.prototype) return undefined;
    const actual = Reflect.ownKeys(value);
    if (
      actual.length !== keys.size ||
      actual.some((key) => typeof key !== "string" || !keys.has(key))
    )
      return undefined;
    const output = new Map<string, unknown>();
    for (const key of actual) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
      output.set(key as string, descriptor.value as unknown);
    }
    return output;
  } catch {
    return undefined;
  }
}

function denseArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) return undefined;
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return undefined;
    if (Reflect.ownKeys(value).length !== value.length + 1) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
      output.push(descriptor.value as unknown);
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
}

function thresholds(value: unknown): ContextEfficiencyRuleThresholds | ContextEfficiencyRuleIssue {
  if (value === undefined) return CONTEXT_EFFICIENCY_RULE_DEFAULT_THRESHOLDS;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return issue("invalid-options", "$options", "options must be a closed plain data object");
  let actual: readonly PropertyKey[];
  try {
    if (Reflect.getPrototypeOf(value) !== Object.prototype)
      return issue("invalid-options", "$options", "options must be a closed plain data object");
    actual = Reflect.ownKeys(value);
  } catch {
    return issue("invalid-options", "$options", "options must be safely inspectable");
  }
  if (actual.some((key) => typeof key !== "string" || !OPTION_KEYS.has(key)))
    return issue("invalid-options", "$options", "options contain an unknown field");
  const output = { ...CONTEXT_EFFICIENCY_RULE_DEFAULT_THRESHOLDS };
  for (const propertyKey of actual) {
    const key = propertyKey as string;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return issue("invalid-options", `$options.${key}`, "must be an own data property");
    const raw: unknown = descriptor.value as unknown;
    if (
      typeof raw !== "number" ||
      !Number.isSafeInteger(raw) ||
      raw < 1 ||
      raw > CONTEXT_EFFICIENCY_RULE_HARD_MAXIMUM_THRESHOLD
    )
      return issue(
        "invalid-options",
        `$options.${key}`,
        `must be an integer from 1 through ${String(CONTEXT_EFFICIENCY_RULE_HARD_MAXIMUM_THRESHOLD)}`,
      );
    output[key as keyof ContextEfficiencyRuleThresholds] = raw;
  }
  return Object.freeze(output);
}

function rootRange(source: SourceDocument, ir: InstructionIr): SourceRange {
  const node = ir.nodes.find((entry) => entry.id === source.rootNodeId);
  if (node === undefined) throw new TypeError("validated B03 source root is missing");
  return node.range;
}

function sourceForDocument(context: Context, documentId: string): SourceDocument | undefined {
  const document = context.documentById.get(documentId);
  return document === undefined ? undefined : context.sourceById.get(document.sourceId);
}

function location(source: SourceDocument, range: SourceRange): DiagnosticSourceLocation {
  return Object.freeze({
    path: source.path,
    range,
    sourceDigest: source.sha256,
    sourceId: source.id,
  });
}

function documentLocation(context: Context, documentId: string): DiagnosticSourceLocation {
  const document = context.documentById.get(documentId);
  const source = sourceForDocument(context, documentId);
  if (document === undefined || source === undefined)
    throw new TypeError("efficiency evidence document is absent from B03");
  const firstStatement = document.statementIds
    .map((statementId) => context.ir.statements.find((entry) => entry.id === statementId))
    .find((entry) => entry !== undefined);
  return location(source, firstStatement?.range ?? rootRange(source, context.ir));
}

function contributionLocation(
  context: Context,
  contribution: { readonly documentId: string; readonly range?: SourceRange },
): DiagnosticSourceLocation {
  const source = sourceForDocument(context, contribution.documentId);
  if (source === undefined) throw new TypeError("efficiency contribution is absent from B03");
  return contribution.range === undefined
    ? documentLocation(context, contribution.documentId)
    : location(source, contribution.range);
}

function factEvidence(input: {
  readonly factId: string;
  readonly label: string;
  readonly locations: readonly DiagnosticSourceLocation[];
  readonly seed: string;
  readonly value: unknown;
}): RepositoryFactRelatedEvidence {
  return Object.freeze({
    collectorId: "builtin:context-efficiency",
    factId: input.factId,
    id: `evidence:${sha256(input.seed, input.factId).slice(0, 32)}` as RelatedEvidenceId,
    kind: "repository-fact",
    label: input.label,
    locations: Object.freeze([...input.locations]),
    subjectPath: input.locations[0]?.path ?? null,
    valueDigest: jsonSha256(input.value),
  });
}

function profileIds(
  profiles: readonly { readonly profileId: string }[],
): readonly ClientProfileId[] {
  return Object.freeze(
    [...new Set(profiles.map((profile) => profile.profileId))].sort(compareUtf8),
  );
}

function encodeComponents(values: readonly string[]): string {
  return values.map((value) => `${String(Buffer.byteLength(value, "utf8"))}:${value}`).join("|");
}

function addDiagnostic(
  context: Context,
  input: {
    readonly anchor: string;
    readonly components: readonly FingerprintComponent[];
    readonly message: string;
    readonly primary: DiagnosticSourceLocation;
    readonly profiles: readonly ClientProfileId[];
    readonly related: readonly RelatedEvidence[];
    readonly ruleId: ContextEfficiencyRuleId;
    readonly severity: DiagnosticSeverity;
    readonly suggestion: string;
  },
): void {
  if (context.diagnostics.length >= MAX_DIAGNOSTICS_PER_BUNDLE)
    throw new RangeError("maximum diagnostics exceeded");
  const profiles = Object.freeze([...input.profiles].sort(compareUtf8));
  const pathBasis = Object.freeze({ anchor: input.anchor, profileIds: profiles });
  const semanticBasis = Object.freeze({
    components: Object.freeze(
      [...input.components].sort((left, right) => compareUtf8(left.key, right.key)),
    ),
    profileIds: profiles,
  });
  const semantic = computeSemanticFingerprint({
    basis: semanticBasis,
    ruleId: input.ruleId,
    ruleVersion: CONTEXT_EFFICIENCY_RULE_VERSION,
  });
  context.diagnostics.push(
    Object.freeze({
      fingerprintBasis: Object.freeze({ path: pathBasis, semantic: semanticBasis }),
      fingerprints: Object.freeze({
        path: Object.freeze({
          method: PATH_FINGERPRINT_METHOD,
          value: computePathFingerprint({
            basis: pathBasis,
            path: input.primary.path,
            ruleId: input.ruleId,
            ruleVersion: CONTEXT_EFFICIENCY_RULE_VERSION,
          }),
        }),
        semantic: Object.freeze({ method: SEMANTIC_FINGERPRINT_METHOD, value: semantic }),
      }),
      id: `diagnostic:${input.ruleId.toLowerCase()}:${semantic.slice(0, 32)}` as DiagnosticId,
      message: input.message,
      primary: input.primary,
      related: Object.freeze([...input.related]),
      ruleId: input.ruleId,
      ruleVersion: CONTEXT_EFFICIENCY_RULE_VERSION,
      severity: input.severity,
      suggestion: Object.freeze({ fixPlan: null, message: input.suggestion }),
    }),
  );
}

function uncertainty(
  context: Context,
  ruleId: ContextEfficiencyRuleId,
  reason: ContextEfficiencyUncertaintyReason,
  profileId: string | null,
  evidenceId: string | null,
): void {
  context.uncertainties.push(Object.freeze({ evidenceId, profileId, reason, ruleId }));
}

function primaryDocumentForProfile(
  context: Context,
  profile: ProfileMetricIdentity,
): string | undefined {
  const broad = context.metrics.broadScope.find((entry) => entry.profile.key === profile.key);
  return broad?.documents
    .filter((entry) => sourceForDocument(context, entry.documentId) !== undefined)
    .sort(
      (left, right) =>
        right.effectiveTokens - left.effectiveTokens || compareUtf8(left.path, right.path),
    )[0]?.documentId;
}

function caveatPrefix(context: Context, sampled: boolean, extra?: string): string {
  const values: string[] = [];
  if (context.metrics.tokenizer.measurement === "estimate") values.push("estimated tokens");
  if (sampled) values.push("stratified target sample");
  if (context.score.state === "caveated") values.push("caveated static score");
  if (context.score.state === "unavailable") values.push("unavailable static score");
  if (extra !== undefined) values.push(extra);
  return values.length === 0 ? "Measured" : `Caveated (${values.join(", ")})`;
}

function nearestRank95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length * 95) / 100) - 1] ?? null;
}

function evaluateBudgets(context: Context): void {
  const reported = new Set<string>();
  for (const distribution of context.metrics.distributions) {
    const profile = {
      ...distribution.profile,
      key: [
        distribution.profile.profileId,
        distribution.profile.surfaceId,
        distribution.profile.profileVersion,
        distribution.profile.specSnapshotId,
        distribution.profile.clientVersion ?? "<null>",
      ]
        .map((value) => `${String(Buffer.byteLength(value, "utf8"))}:${value}`)
        .join("|"),
    };
    if (distribution.state !== "complete" || distribution.statistics === null) {
      uncertainty(context, "ACL550", "profile-evidence-partial", profile.profileId, profile.key);
      uncertainty(context, "ACL551", "profile-evidence-partial", profile.profileId, profile.key);
      continue;
    }
    const documentId = primaryDocumentForProfile(context, profile);
    if (documentId === undefined) continue;
    const primary = documentLocation(context, documentId);
    const sampled = distribution.sampling.strategy === "stratified";
    const completeTargets = distribution.targets.filter(
      (entry) => entry.includedInStatistics && entry.state === "complete",
    );
    const alwaysP95 = nearestRank95(completeTargets.map((entry) => entry.alwaysOnTokens));
    const budgetEntries = [
      {
        budget: context.score.configuration.budgets.alwaysOnTokens,
        ruleId: "ACL550" as const,
        scope: "resolved-profile-always-p95",
        value: alwaysP95,
      },
      {
        budget: context.score.configuration.budgets.effectiveP95Tokens,
        ruleId: "ACL551" as const,
        scope: "resolved-profile-effective-p95",
        value: distribution.statistics.p95,
      },
    ];
    for (const entry of budgetEntries) {
      if (entry.value === null || entry.value <= entry.budget) continue;
      const duplicateKey = `${profile.key}|${entry.scope}|${String(entry.value)}|${String(entry.budget)}`;
      if (reported.has(duplicateKey)) continue;
      reported.add(duplicateKey);
      const related = factEvidence({
        factId: `${entry.ruleId.toLowerCase()}:${sha256(profile.key).slice(0, 20)}`,
        label: `${entry.scope} evidence for ${profile.profileId}`,
        locations: [primary],
        seed: duplicateKey,
        value: {
          budget: entry.budget,
          percentileMethod: distribution.percentileMethod,
          profile,
          sampleCount: distribution.sampleCount,
          sampling: distribution.sampling,
          tokens: entry.value,
        },
      });
      addDiagnostic(context, {
        anchor: `${entry.scope}:${profile.key}`,
        components: [
          { key: "budget-scope", value: entry.scope },
          { key: "budget-tokens", value: String(entry.budget) },
          { key: "observed-tokens", value: String(entry.value) },
          { key: "profile-key", value: profile.key },
          { key: "score-version", value: context.score.configuration.scoreVersion },
        ],
        message: `${caveatPrefix(context, sampled)} ${entry.scope} is ${String(entry.value)} tokens for ${profile.profileId}, exceeding the configured ${String(entry.budget)}-token budget.`,
        primary,
        profiles: profileIds([profile]),
        related: [related],
        ruleId: entry.ruleId,
        severity: "warning",
        suggestion:
          "Review resolved profile context and use only a separately proved scope or exact-duplicate projection; no quality preservation is implied.",
      });
    }
  }
}

function evaluateDuplicates(context: Context): void {
  if (context.metrics.state !== "complete") {
    uncertainty(context, "ACL552", "metrics-partial", null, null);
    return;
  }
  for (const cluster of context.metrics.duplication.exact.clusters) {
    if (cluster.redundantTokens < context.thresholds.duplicateTokens) continue;
    const all = [cluster.canonical, ...cluster.duplicates];
    const locations = all.map((entry) => contributionLocation(context, entry));
    const primary = locations[0];
    if (primary === undefined) continue;
    addDiagnostic(context, {
      anchor: `resolved-exact-duplicate:${cluster.id}`,
      components: [
        { key: "cluster-id", value: cluster.id },
        { key: "normalized-text-sha256", value: cluster.normalizedTextSha256 },
        { key: "redundant-tokens", value: String(cluster.redundantTokens) },
        { key: "semantic-equivalence-claim", value: "false" },
      ],
      message: `${caveatPrefix(context, false)} exact normalized-text duplication contributes ${String(cluster.redundantTokens)} redundant resolved-context tokens; semantic equivalence is not claimed.`,
      primary,
      profiles: profileIds(context.metrics.broadScope.map((entry) => entry.profile)),
      related: [
        factEvidence({
          factId: `acl552:${sha256(cluster.id).slice(0, 20)}`,
          label: "G05 exact-duplicate component evidence",
          locations,
          seed: cluster.id,
          value: cluster,
        }),
      ],
      ruleId: "ACL552",
      severity: "warning",
      suggestion:
        "Inspect the exact text occurrences and use a profile-compatible G08 projection before consolidating; equivalence and necessity are not inferred.",
    });
  }
}

function completeRecommendation(recommendation: EfficiencyRecommendationEvaluation): boolean {
  const projectionsComplete = recommendation.targetProjections.every(
    (projection) => projection.baseline.tokens !== null && projection.projected.tokens !== null,
  );
  const intended = recommendation.targetProjections.filter(
    (projection) => projection.role === "intended",
  );
  const retentionProved =
    recommendation.kind === "scope-narrowing"
      ? intended.length > 0 &&
        intended.every(
          (projection) =>
            projection.retention.mode === "byte-identical-assembly" &&
            projection.retention.state === "proved",
        )
      : recommendation.targetProjections.every(
          (projection) =>
            projection.retention.mode === "unique-content-identities" &&
            projection.retention.state === "proved",
        );
  return (
    recommendation.state === "recommended" &&
    recommendation.evidence.state === "complete" &&
    recommendation.baselineTokens !== null &&
    recommendation.projectedTokens !== null &&
    recommendation.estimatedSavingTokens !== null &&
    recommendation.estimatedSavingTokens > 0 &&
    recommendation.targetProjections.length > 0 &&
    projectionsComplete &&
    retentionProved
  );
}

function recommendationFormatIds(
  context: Context,
  recommendation: EfficiencyRecommendationEvaluation,
): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        recommendation.evidence.documentIds.map((documentId) => {
          const document = context.documentById.get(documentId);
          if (document === undefined)
            throw new TypeError("recommendation evidence document is absent from B03");
          return document.formatId;
        }),
      ),
    ].sort(compareUtf8),
  );
}

function recommendationLocations(
  context: Context,
  recommendation: EfficiencyRecommendationEvaluation,
): readonly DiagnosticSourceLocation[] {
  return Object.freeze(
    recommendation.evidence.documentIds.map((documentId) => documentLocation(context, documentId)),
  );
}

function recommendationEvidence(
  context: Context,
  recommendation: EfficiencyRecommendationEvaluation,
  ruleId: ContextEfficiencyRuleId,
): RepositoryFactRelatedEvidence {
  return factEvidence({
    factId: `${ruleId.toLowerCase()}:${sha256(recommendation.id).slice(0, 20)}`,
    label: `G08 ${recommendation.kind} projection with fixed-false quality claims`,
    locations: recommendationLocations(context, recommendation),
    seed: `${ruleId}:${recommendation.id}`,
    value: recommendation,
  });
}

function recommendationMessage(
  context: Context,
  recommendation: EfficiencyRecommendationEvaluation,
): string {
  const partialResolution = recommendation.targetProjections.some(
    (projection) =>
      projection.baseline.analysisStatus === "partial" ||
      projection.projected.analysisStatus === "partial",
  );
  return `${caveatPrefix(context, false, partialResolution ? "partial resolver analysis" : undefined)} G08 projection reduces ${String(recommendation.baselineTokens)} to ${String(recommendation.projectedTokens)} tokens (${String(recommendation.estimatedSavingTokens)} tokens, ${String(recommendation.estimatedSavingBasisPoints ?? 0)} basis points) across ${String(recommendation.affectedPaths.length)} affected target(s); semantic equivalence, necessity, and quality preservation are not claimed.`;
}

function evaluateRecommendations(context: Context): void {
  for (const recommendation of context.recommendations.evaluations) {
    if (!completeRecommendation(recommendation)) {
      if (recommendation.state === "indeterminate")
        uncertainty(context, "ACL558", "recommendation-indeterminate", null, recommendation.id);
      continue;
    }
    const locations = recommendationLocations(context, recommendation);
    const primary = locations[0];
    if (primary === undefined) continue;
    const profiles = profileIds(recommendation.profiles);
    const formats = recommendationFormatIds(context, recommendation);
    if (recommendation.kind === "scope-narrowing")
      addDiagnostic(context, {
        anchor: `scope-projection:${recommendation.id}`,
        components: [
          { key: "affected-paths", value: encodeComponents(recommendation.affectedPaths) },
          { key: "baseline-tokens", value: String(recommendation.baselineTokens) },
          { key: "projection-id", value: recommendation.id },
          { key: "projected-tokens", value: String(recommendation.projectedTokens) },
          { key: "quality-claim", value: "false" },
        ],
        message: `Specialized context has a fully reconciled scope-narrowing counterfactual. ${recommendationMessage(context, recommendation)}`,
        primary,
        profiles,
        related: [recommendationEvidence(context, recommendation, "ACL553")],
        ruleId: "ACL553",
        severity: "info",
        suggestion:
          "Review the displayed affected targets and byte-identical intended-target proof before manually narrowing scope.",
      });
    if (recommendation.kind === "exact-duplicate-consolidation" && formats.length > 1)
      addDiagnostic(context, {
        anchor: `vendor-format-consolidation:${recommendation.id}`,
        components: [
          { key: "affected-paths", value: encodeComponents(recommendation.affectedPaths) },
          { key: "format-ids", value: encodeComponents(formats) },
          { key: "projection-id", value: recommendation.id },
          { key: "saving-tokens", value: String(recommendation.estimatedSavingTokens) },
          { key: "semantic-equivalence-claim", value: "false" },
        ],
        message: `A profile-compatible exact-duplicate consolidation projection spans vendor-specific formats ${formats.join(", ")}. ${recommendationMessage(context, recommendation)}`,
        primary,
        profiles,
        related: [recommendationEvidence(context, recommendation, "ACL555")],
        ruleId: "ACL555",
        severity: "info",
        suggestion:
          "Review every profile/target projection and unique-content retention proof before manually consolidating vendor-specific files.",
      });
    if (
      recommendation.caveatCodes.includes("quality-not-empirically-verified") &&
      ((recommendation.estimatedSavingTokens ?? 0) >= context.thresholds.highImpactSavingTokens ||
        (recommendation.estimatedSavingBasisPoints ?? 0) >=
          context.thresholds.highImpactSavingBasisPoints)
    )
      addDiagnostic(context, {
        anchor: `unbenchmarked-projection:${recommendation.id}`,
        components: [
          { key: "projection-id", value: recommendation.id },
          { key: "quality-claim", value: "false" },
          {
            key: "saving-basis-points",
            value: String(recommendation.estimatedSavingBasisPoints),
          },
          { key: "saving-tokens", value: String(recommendation.estimatedSavingTokens) },
        ],
        message: `High-impact reduction is statically projected but not benchmarked. ${recommendationMessage(context, recommendation)}`,
        primary,
        profiles,
        related: [recommendationEvidence(context, recommendation, "ACL558")],
        ruleId: "ACL558",
        severity: "info",
        suggestion:
          "Run an explicit sandboxed comparative benchmark before making any task-quality or quality-preservation claim.",
      });
  }
}

function evaluateAmplification(context: Context): void {
  for (const profile of context.metrics.amplification) {
    if (profile.state !== "complete") {
      uncertainty(context, "ACL554", "profile-evidence-partial", profile.profile.profileId, null);
      continue;
    }
    for (const target of profile.targets) {
      if (
        target.state !== "complete" ||
        target.amplificationBasisPoints === null ||
        target.amplificationBasisPoints <= 10_000 ||
        target.amplificationBasisPoints < context.thresholds.importAmplificationBasisPoints
      )
        continue;
      const locations = target.contributions.map((entry) => contributionLocation(context, entry));
      const primary = locations[0];
      if (primary === undefined) continue;
      addDiagnostic(context, {
        anchor: `resolved-import-amplification:${profile.profile.key}:${target.path}`,
        components: [
          { key: "amplification-basis-points", value: String(target.amplificationBasisPoints) },
          { key: "effective-tokens", value: String(target.effectiveTokens) },
          { key: "profile-key", value: profile.profile.key },
          { key: "repeated-tokens", value: String(target.repeatedTokens) },
          { key: "target", value: target.path },
          { key: "unique-tokens", value: String(target.uniqueTokens) },
        ],
        message: `${caveatPrefix(context, false)} import graph amplifies ${target.path} to ${String(target.amplificationBasisPoints)} basis points (${String(target.effectiveTokens)} effective versus ${String(target.uniqueTokens)} unique tokens) for ${profile.profile.profileId}.`,
        primary,
        profiles: profileIds([profile.profile]),
        related: [
          factEvidence({
            factId: `acl554:${sha256(profile.profile.key, target.path).slice(0, 20)}`,
            label: `G05 import-amplification component for ${target.path}`,
            locations,
            seed: `${profile.profile.key}:${target.path}`,
            value: target,
          }),
        ],
        ruleId: "ACL554",
        severity: "info",
        suggestion:
          "Inspect repeated import occurrences and only change imports through a separately reconciled G08 projection.",
      });
    }
  }
}

function evaluateDensity(context: Context): void {
  if (context.metrics.density.state !== "complete") {
    uncertainty(context, "ACL556", "profile-evidence-partial", null, null);
    return;
  }
  for (const document of context.metrics.density.documents) {
    if (
      document.state !== "complete" ||
      document.actionablePerThousandBasisPoints === null ||
      document.tokens === 0 ||
      document.actionablePerThousandBasisPoints >= context.thresholds.minimumDensityBasisPoints
    )
      continue;
    const primary = documentLocation(context, document.documentId);
    addDiagnostic(context, {
      anchor: `instruction-density:${document.documentId}`,
      components: [
        {
          key: "actionable-per-thousand-basis-points",
          value: String(document.actionablePerThousandBasisPoints),
        },
        { key: "actionable-statements", value: String(document.actionableStatementCount) },
        { key: "document-id", value: document.documentId },
        { key: "statement-count", value: String(document.statementCount) },
        { key: "tokens", value: String(document.tokens) },
      ],
      message: `${caveatPrefix(context, false)} instruction density is ${String(document.actionablePerThousandBasisPoints)} basis points (${String(document.actionableStatementCount)} actionable statements across ${String(document.tokens)} tokens), below the configured ${String(context.thresholds.minimumDensityBasisPoints)} threshold.`,
      primary,
      profiles: Object.freeze([]),
      related: [
        factEvidence({
          factId: `acl556:${sha256(document.documentId).slice(0, 20)}`,
          label: "G05 instruction-density component evidence",
          locations: [primary],
          seed: document.documentId,
          value: document,
        }),
      ],
      ruleId: "ACL556",
      severity: "info",
      suggestion:
        "Review descriptive prose for references or narrower scope; no content is declared unnecessary and no automatic rewrite is offered.",
    });
  }
}

function evaluateTokenizerComparisons(context: Context, comparisons: readonly Comparison[]): void {
  for (const comparison of comparisons) {
    const compatibility = compareTokenizerIdentities(
      comparison.baseline.tokenizer,
      comparison.candidate.tokenizer,
    );
    if (compatibility.compatible) continue;
    const primary = documentLocation(context, comparison.sourceDocumentId);
    addDiagnostic(context, {
      anchor: `incompatible-tokenizer:${comparison.id}`,
      components: [
        { key: "baseline-provider", value: comparison.baseline.tokenizer.id },
        { key: "baseline-version", value: comparison.baseline.tokenizer.version },
        { key: "candidate-provider", value: comparison.candidate.tokenizer.id },
        { key: "candidate-version", value: comparison.candidate.tokenizer.version },
        { key: "comparison-id", value: comparison.id },
      ],
      message: `Efficiency comparison ${comparison.id} is invalid because tokenizer identities ${comparison.baseline.tokenizer.id}@${comparison.baseline.tokenizer.version} and ${comparison.candidate.tokenizer.id}@${comparison.candidate.tokenizer.version} are incompatible.`,
      primary,
      profiles: Object.freeze([]),
      related: [
        factEvidence({
          factId: `acl557:${sha256(comparison.id).slice(0, 20)}`,
          label: "G07 tokenizer identity comparison",
          locations: [primary],
          seed: comparison.id,
          value: {
            baseline: comparison.baseline.tokenizer,
            candidate: comparison.candidate.tokenizer,
            compatibility,
          },
        }),
      ],
      ruleId: "ACL557",
      severity: "warning",
      suggestion:
        "Recalculate both sides with a byte-identical tokenizer identity or an explicitly reviewed normalization; do not compare these scores directly.",
    });
  }
}

function validateComparisons(
  value: unknown,
  documents: ReadonlyMap<string, InstructionDocument>,
): readonly Comparison[] | ContextEfficiencyRuleIssue {
  const values = denseArray(value);
  if (values === undefined)
    return issue("invalid-input", "$.tokenizerComparisons", "must be a dense data array");
  if (values.length > CONTEXT_EFFICIENCY_RULE_MAX_COMPARISONS)
    return issue("resource-limit", "$.tokenizerComparisons", "contains too many comparisons");
  const output: Comparison[] = [];
  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    const path = `$.tokenizerComparisons[${String(index)}]`;
    const record = closedRecord(value, COMPARISON_KEYS);
    if (record === undefined) return issue("invalid-input", path, "must be a closed data object");
    const id = record.get("id");
    const sourceDocumentId = record.get("sourceDocumentId");
    const baseline = record.get("baseline");
    const candidate = record.get("candidate");
    if (typeof id !== "string" || id.length > 512 || !STABLE_IDENTIFIER.test(id) || ids.has(id))
      return issue("invalid-input", `${path}.id`, "must be a unique bounded stable identifier");
    if (typeof sourceDocumentId !== "string" || !documents.has(sourceDocumentId))
      return issue(
        "invalid-relationship",
        `${path}.sourceDocumentId`,
        "must identify a B03 instruction document",
      );
    if (!isIssuedContextEfficiencyScore(baseline) || !isIssuedContextEfficiencyScore(candidate))
      return issue("invalid-input", path, "scores must be same-process G07 issued evidence");
    ids.add(id);
    output.push(Object.freeze({ baseline, candidate, id, sourceDocumentId }));
  }
  return Object.freeze(output.sort((left, right) => compareUtf8(left.id, right.id)));
}

function recordsReconcile(
  metrics: ContextEfficiencyMetrics,
  score: ContextEfficiencyScore,
  recommendations: ContextEfficiencyRecommendations,
): boolean {
  return (
    score.identities.metricsSha256 === jsonSha256(metrics) &&
    recommendations.identities.metricsSha256 === score.identities.metricsSha256 &&
    recommendations.identities.configurationSha256 === score.identities.configurationSha256 &&
    recommendations.identities.scoreSpecificationSha256 === score.identities.specificationSha256 &&
    recommendations.identities.scoreVersion === score.configuration.scoreVersion &&
    compareTokenizerIdentities(metrics.tokenizer, score.tokenizer).compatible &&
    compareTokenizerIdentities(metrics.tokenizer, recommendations.tokenizer).compatible
  );
}

function evidenceBelongsToIr(context: Context): boolean {
  const documentMatches = (entry: {
    readonly documentId: string;
    readonly path: string;
  }): boolean => sourceForDocument(context, entry.documentId)?.path === entry.path;
  return (
    context.metrics.broadScope.every((profile) => profile.documents.every(documentMatches)) &&
    context.metrics.deadScope.every((profile) =>
      [...profile.documents, ...profile.unobservedDocuments].every(documentMatches),
    ) &&
    context.metrics.density.documents.every(documentMatches) &&
    context.metrics.duplication.exact.clusters.every((cluster) =>
      [cluster.canonical, ...cluster.duplicates].every(documentMatches),
    ) &&
    context.metrics.amplification.every((profile) =>
      profile.targets.every((target) => target.contributions.every(documentMatches)),
    ) &&
    context.recommendations.evaluations.every((recommendation) =>
      recommendation.evidence.documentIds.every(
        (documentId) => sourceForDocument(context, documentId) !== undefined,
      ),
    )
  );
}

/**
 * Evaluate ACL550-ACL558 from same-process G04-G08 evidence. This pure evaluator has no
 * filesystem, network, command, environment, model, clock, randomness, or callback capability.
 */
export function evaluateContextEfficiencyRules(
  rawInput: unknown,
  rawOptions?: unknown,
): ContextEfficiencyRuleResult {
  const selectedThresholds = thresholds(rawOptions);
  if ("code" in selectedThresholds) return failure(selectedThresholds);
  const input = closedRecord(rawInput, INPUT_KEYS);
  if (input === undefined)
    return failure(issue("invalid-input", "$", "input must be a closed plain data object"));
  if (
    input.get("contractVersion") !== CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION ||
    input.get("recordKind") !== "agent-context-efficiency-rule-input"
  )
    return failure(issue("invalid-input", "$", "input kind or contract version is invalid"));
  const irResult = validateInstructionIr(input.get("ir"));
  if (!irResult.ok)
    return failure(issue("invalid-input", "$.ir", "must satisfy the closed B03 IR contract"));
  const metrics = input.get("metrics");
  const score = input.get("score");
  const recommendations = input.get("recommendations");
  if (!isIssuedContextEfficiencyMetrics(metrics))
    return failure(issue("invalid-input", "$.metrics", "must be same-process G05 issued evidence"));
  if (!isIssuedContextEfficiencyScore(score))
    return failure(issue("invalid-input", "$.score", "must be same-process G07 issued evidence"));
  if (!isIssuedContextEfficiencyRecommendations(recommendations))
    return failure(
      issue("invalid-input", "$.recommendations", "must be same-process G08 issued evidence"),
    );
  if (!recordsReconcile(metrics, score, recommendations))
    return failure(
      issue(
        "invalid-relationship",
        "$",
        "G05, G07, and G08 records must belong to the same analysis and tokenizer",
      ),
    );
  const ir = irResult.value;
  const documentById = new Map(ir.documents.map((document) => [document.id, document]));
  const comparisons = validateComparisons(input.get("tokenizerComparisons"), documentById);
  if ("code" in comparisons) return failure(comparisons);
  const context: Context = {
    diagnostics: [],
    documentById,
    ir,
    metrics,
    recommendations,
    score,
    sourceById: new Map(ir.sources.map((source) => [source.id, source])),
    thresholds: selectedThresholds,
    uncertainties: [],
  };
  if (!evidenceBelongsToIr(context))
    return failure(
      issue(
        "invalid-relationship",
        "$",
        "efficiency evidence must resolve to byte-bound B03 documents and paths",
      ),
    );
  if (score.state === "unavailable") {
    uncertainty(context, "ACL550", "score-unavailable", null, null);
    uncertainty(context, "ACL551", "score-unavailable", null, null);
  } else if (score.state === "caveated") {
    uncertainty(context, "ACL550", "score-caveated", null, null);
    uncertainty(context, "ACL551", "score-caveated", null, null);
  }
  try {
    evaluateBudgets(context);
    evaluateDuplicates(context);
    evaluateRecommendations(context);
    evaluateAmplification(context);
    evaluateDensity(context);
    evaluateTokenizerComparisons(context, comparisons);
    const diagnostics = Object.freeze(
      context.diagnostics.sort(
        (left, right) =>
          compareUtf8(left.primary.path, right.primary.path) ||
          left.primary.range.start.byteOffset - right.primary.range.start.byteOffset ||
          compareUtf8(left.ruleId, right.ruleId) ||
          compareUtf8(left.fingerprints.semantic.value, right.fingerprints.semantic.value),
      ),
    );
    const suppression = parseSuppressionDirectives(ir);
    const bundle: DiagnosticBundle = Object.freeze({
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics,
      recordKind: "agent-context-diagnostics",
      suppressions: Object.freeze(suppression.directives.map((entry) => entry.record)),
    });
    const validatedBundle = validateDiagnosticBundle(bundle, ir.sources);
    if (!validatedBundle.ok)
      return failure(
        issue("dependency-failure", "$output", "generated diagnostics failed B04 validation"),
      );
    const uncertainties = Object.freeze(
      context.uncertainties.sort(
        (left, right) =>
          compareUtf8(left.ruleId, right.ruleId) ||
          compareUtf8(left.profileId ?? "", right.profileId ?? "") ||
          compareUtf8(left.evidenceId ?? "", right.evidenceId ?? "") ||
          compareUtf8(left.reason, right.reason),
      ),
    );
    const result = Object.freeze({
      bundle: validatedBundle.value,
      contractVersion: CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION,
      metrics: Object.freeze({
        diagnosticCount: diagnostics.length,
        recommendationCount: recommendations.recommendations.length,
        suppressionDirectiveCount: suppression.directives.length,
        tokenizerComparisonCount: comparisons.length,
        uncertaintyCount: uncertainties.length,
      }),
      ok: true as const,
      sources: Object.freeze([...ir.sources]),
      thresholds: selectedThresholds,
      uncertainties,
    });
    issuedEvaluations.set(result, { directives: suppression.directives, ir });
    return result;
  } catch (error) {
    return failure(
      issue(
        error instanceof RangeError ? "resource-limit" : "dependency-failure",
        "$evaluation",
        "context-efficiency evaluation failed",
      ),
    );
  }
}

/** Apply only parser-issued B08 directives to an evaluator-issued F14 result. */
export function finalizeContextEfficiencySuppressions(
  evaluation: unknown,
): ContextEfficiencySuppressionFinalizationResult {
  if (evaluation === null || typeof evaluation !== "object" || nodeTypes.isProxy(evaluation))
    return Object.freeze({
      issues: Object.freeze([
        issue("invalid-input", "$.evaluation", "must be an issued F14 evaluation"),
      ]),
      ok: false,
    });
  const issued = issuedEvaluations.get(evaluation);
  if (issued === undefined)
    return Object.freeze({
      issues: Object.freeze([
        issue("invalid-input", "$.evaluation", "must be an issued F14 evaluation"),
      ]),
      ok: false,
    });
  const result = evaluation as Extract<ContextEfficiencyRuleResult, { readonly ok: true }>;
  try {
    const matched = matchSuppressionDirectives(result.bundle, issued.directives, issued.ir.sources);
    const suppressed = new Set(matched.suppressedDiagnostics.map((entry) => entry.diagnostic.id));
    return Object.freeze({
      bundle: matched.bundle,
      ok: true,
      suppressedDiagnostics: Object.freeze(
        matched.bundle.diagnostics.filter((entry) => suppressed.has(entry.id)),
      ),
      visibleDiagnostics: Object.freeze(
        matched.bundle.diagnostics.filter((entry) => !suppressed.has(entry.id)),
      ),
    });
  } catch {
    return Object.freeze({
      issues: Object.freeze([
        issue("dependency-failure", "$.evaluation", "suppression processing failed"),
      ]),
      ok: false,
    });
  }
}
