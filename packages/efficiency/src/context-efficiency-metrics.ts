import { types as nodeTypes } from "node:util";

import { compareRepositoryRelativePaths, isRepositoryRelativePath } from "@agent-context/core";
import type {
  InstructionDocumentId,
  InstructionStatementId,
  RepositoryRelativePath,
  SourceRange,
} from "@agent-context/core";
import { buildDuplicationIndex, normalizeAndClassifyStatement } from "@agent-context/evidence";
import type {
  DuplicationIndexResult,
  DuplicationSimilarityContract,
  NearDuplicationEdge,
  StatementClassifierInput,
  StatementClassifierResult,
  StatementDomain,
} from "@agent-context/evidence";
import { isIssuedCrossProfileComparison } from "@agent-context/resolver";
import type {
  CrossProfileComparison,
  CrossProfilePairComparison,
  CrossProfileProfileSummary,
  CrossProfileScopeState,
  TargetSamplingResult,
} from "@agent-context/resolver";

import { aggregateProfileTargetDistribution } from "./profile-target-distribution.js";
import type {
  ProfileTargetAccounting,
  ProfileTargetDistribution,
  ProfileTargetIdentity,
} from "./profile-target-distribution.js";
import {
  TOKENIZER_PLUGIN_CONTRACT_VERSION,
  compareTokenizerIdentities,
  validateTokenizerIdentity,
} from "./tokenizer-contract.js";
import type { TokenCount, TokenizerIdentity } from "./tokenizer-contract.js";

export const CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION = "0.2.0" as const;
export const CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND =
  "agent-context-efficiency-metrics-input" as const;
export const CONTEXT_EFFICIENCY_METRICS_RECORD_KIND = "agent-context-efficiency-metrics" as const;
export const CONTEXT_EFFICIENCY_RATIO_SCALE = 10_000 as const;

export const CONTEXT_EFFICIENCY_METRICS_LIMITS: Readonly<{
  maximumComparisons: 100_000;
  maximumDocuments: 4_096;
  maximumEvidenceEntries: 1_000_000;
  maximumPairTargets: 250_000;
  maximumProfiles: 16;
  maximumStatements: 100_000;
}> = Object.freeze({
  maximumComparisons: 100_000,
  maximumDocuments: 4_096,
  maximumEvidenceEntries: 1_000_000,
  maximumPairTargets: 250_000,
  maximumProfiles: 16,
  maximumStatements: 100_000,
} as const);

export interface EfficiencyMetricDocumentInput {
  readonly classificationState: "complete" | "partial";
  readonly count: TokenCount;
  readonly documentId: InstructionDocumentId;
  readonly path: RepositoryRelativePath;
}

export interface EfficiencyMetricStatementInput {
  readonly count: TokenCount;
  readonly statement: StatementClassifierInput;
}

export interface EfficiencyMetricProfileInput {
  readonly accountings: readonly ProfileTargetAccounting[];
  readonly profile: ProfileTargetIdentity;
  readonly sampling: TargetSamplingResult;
}

export interface AnalyzeContextEfficiencyMetricsInput {
  readonly comparisons: readonly CrossProfileComparison[];
  readonly contractVersion: typeof CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION;
  readonly documents: readonly EfficiencyMetricDocumentInput[];
  readonly identity: TokenizerIdentity;
  readonly profiles: readonly EfficiencyMetricProfileInput[];
  readonly recordKind: typeof CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND;
  readonly statements: readonly EfficiencyMetricStatementInput[];
}

export interface MetricTokenContribution {
  readonly documentId: InstructionDocumentId;
  readonly path: RepositoryRelativePath;
  readonly tokens: number;
}

export interface MetricStatementContribution extends MetricTokenContribution {
  readonly range: SourceRange;
  readonly statementId: InstructionStatementId;
}

export interface ExactDuplicateMetricCluster {
  readonly canonical: MetricStatementContribution;
  readonly duplicates: readonly MetricStatementContribution[];
  readonly id: string;
  readonly normalizedTextSha256: string;
  readonly redundantTokens: number;
  readonly semanticEquivalenceClaim: false;
}

export interface NearDuplicateMetricCluster {
  readonly candidates: readonly MetricStatementContribution[];
  readonly edges: readonly NearDuplicationEdge[];
  readonly id: string;
  readonly memberCount: number;
  readonly representative: MetricStatementContribution;
  readonly similarityCandidateTokens: number;
  readonly semanticEquivalenceClaim: false;
}

export interface DuplicateMetrics {
  readonly exact: {
    readonly clusters: readonly ExactDuplicateMetricCluster[];
    readonly redundantTokens: number;
  };
  readonly indexContractVersion: DuplicationIndexResult["contractVersion"];
  readonly near: {
    readonly clusters: readonly NearDuplicateMetricCluster[];
    readonly similarity: DuplicationSimilarityContract;
    readonly similarityCandidateTokens: number;
  };
  readonly state: "complete";
}

export interface ProfileMetricIdentity extends ProfileTargetIdentity {
  readonly key: string;
}

export interface DeadScopeDocumentMetric extends MetricTokenContribution {
  readonly observedTargetCount: number;
}

export interface ProfileDeadScopeMetric {
  readonly documents: readonly DeadScopeDocumentMetric[];
  readonly profile: ProfileMetricIdentity;
  readonly reasonCodes: readonly string[];
  readonly state: "measured" | "unknown";
  readonly tokens: number | null;
  readonly unobservedDocuments: readonly MetricTokenContribution[];
}

export interface TargetTokenContribution {
  readonly path: RepositoryRelativePath;
  readonly state: "complete" | "partial";
  readonly tokens: number;
}

export interface BroadScopeDocumentMetric extends MetricTokenContribution {
  readonly completeIncludedTargetCount: number;
  readonly completeTargetCount: number;
  readonly coverageBasisPoints: number | null;
  readonly effectiveTokens: number;
  readonly state: "complete" | "partial" | "unknown";
  readonly targets: readonly TargetTokenContribution[];
}

export interface ProfileBroadScopeMetric {
  readonly documents: readonly BroadScopeDocumentMetric[];
  readonly profile: ProfileMetricIdentity;
  readonly state: "complete" | "partial";
}

export interface AmplificationTargetMetric {
  readonly amplificationBasisPoints: number | null;
  readonly contributions: readonly MetricTokenContribution[];
  readonly effectiveTokens: number;
  readonly path: RepositoryRelativePath;
  readonly repeatedTokens: number | null;
  readonly state: "complete" | "not-applicable" | "partial";
  readonly uniqueTokens: number;
}

export interface AmplificationStatistics {
  readonly maximumBasisPoints: number;
  readonly minimumBasisPoints: number;
  readonly p50BasisPoints: number;
  readonly p95BasisPoints: number;
}

export interface ProfileAmplificationMetric {
  readonly profile: ProfileMetricIdentity;
  readonly state: "complete" | "empty" | "partial";
  readonly statistics: AmplificationStatistics | null;
  readonly targets: readonly AmplificationTargetMetric[];
}

export interface DensityStatementEvidence {
  readonly domains: readonly StatementDomain[];
  readonly range: SourceRange;
  readonly statementId: InstructionStatementId;
}

export interface DocumentDensityMetric extends MetricTokenContribution {
  readonly actionablePerThousandBasisPoints: number | null;
  readonly actionableStatementCount: number;
  readonly actionableStatements: readonly DensityStatementEvidence[];
  readonly state: "complete" | "empty" | "partial";
  readonly statementCount: number;
}

export interface DensityMetrics {
  readonly actionablePerThousandBasisPoints: number | null;
  readonly actionableStatementCount: number;
  readonly documents: readonly DocumentDensityMetric[];
  readonly rawTokens: number;
  readonly state: "complete" | "empty" | "partial";
  readonly statementCount: number;
}

export type DivergenceEvidenceKind =
  | "content-different"
  | "content-unknown"
  | "ordering-witness"
  | "scope-different"
  | "scope-unknown";

export interface DivergencePathEvidence {
  readonly kinds: readonly DivergenceEvidenceKind[];
  readonly leftState: CrossProfileScopeState | null;
  readonly leftTokens: number | null;
  readonly path: RepositoryRelativePath;
  readonly rightState: CrossProfileScopeState | null;
  readonly rightTokens: number | null;
}

export interface DivergentExactPolicyMetric {
  readonly clusterId: string;
  readonly members: readonly MetricStatementContribution[];
  readonly repeatedTokens: number;
  readonly semanticEquivalenceClaim: false;
}

export interface CrossProfileDivergenceObservation {
  readonly contentDifferentEffectiveTokens: number | null;
  readonly equivalenceClaim: false;
  readonly exactRepeatedPolicy: readonly DivergentExactPolicyMetric[];
  readonly exactRepeatedPolicyTokens: number;
  readonly leftProfile: ProfileMetricIdentity;
  readonly pairId: string;
  readonly paths: readonly DivergencePathEvidence[];
  readonly qualityClaim: false;
  readonly rightProfile: ProfileMetricIdentity;
  readonly scopeDifferenceTokens: number | null;
  readonly state: CrossProfilePairComparison["overall"];
  readonly targetPath: RepositoryRelativePath;
}

export interface MissingCrossProfileComparison {
  readonly leftProfile: ProfileMetricIdentity;
  readonly rightProfile: ProfileMetricIdentity;
  readonly targetPath: RepositoryRelativePath;
}

export interface CrossProfileDivergenceMetrics {
  readonly divergentPairTargetCount: number;
  readonly exactRepeatedPolicyTokens: number;
  readonly expectedPairTargetCount: number;
  readonly indeterminatePairTargetCount: number;
  readonly missing: readonly MissingCrossProfileComparison[];
  readonly observations: readonly CrossProfileDivergenceObservation[];
  readonly observationalMatchPairTargetCount: number;
  readonly observedPairTargetCount: number;
  readonly qualityClaim: false;
  readonly semanticEquivalenceClaim: false;
  readonly state: "complete" | "partial";
}

export interface ContextEfficiencyMetrics {
  readonly amplification: readonly ProfileAmplificationMetric[];
  readonly broadScope: readonly ProfileBroadScopeMetric[];
  readonly contractVersion: typeof CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION;
  readonly deadScope: readonly ProfileDeadScopeMetric[];
  readonly density: DensityMetrics;
  readonly distributions: readonly ProfileTargetDistribution[];
  readonly divergence: CrossProfileDivergenceMetrics;
  readonly duplication: DuplicateMetrics;
  readonly limits: typeof CONTEXT_EFFICIENCY_METRICS_LIMITS;
  readonly recordKind: typeof CONTEXT_EFFICIENCY_METRICS_RECORD_KIND;
  readonly state: "complete" | "partial";
  readonly tokenizer: TokenizerIdentity;
}

export const ContextEfficiencyMetricsErrorCode: Readonly<{
  incompatibleTokenizer: "CONTEXT_EFFICIENCY_METRICS_INCOMPATIBLE_TOKENIZER";
  invalidInput: "CONTEXT_EFFICIENCY_METRICS_INVALID_INPUT";
  invalidRelationship: "CONTEXT_EFFICIENCY_METRICS_INVALID_RELATIONSHIP";
  resourceLimit: "CONTEXT_EFFICIENCY_METRICS_RESOURCE_LIMIT";
}> = Object.freeze({
  incompatibleTokenizer: "CONTEXT_EFFICIENCY_METRICS_INCOMPATIBLE_TOKENIZER",
  invalidInput: "CONTEXT_EFFICIENCY_METRICS_INVALID_INPUT",
  invalidRelationship: "CONTEXT_EFFICIENCY_METRICS_INVALID_RELATIONSHIP",
  resourceLimit: "CONTEXT_EFFICIENCY_METRICS_RESOURCE_LIMIT",
} as const);

export type ContextEfficiencyMetricsErrorCode =
  (typeof ContextEfficiencyMetricsErrorCode)[keyof typeof ContextEfficiencyMetricsErrorCode];

export class ContextEfficiencyMetricsError extends Error {
  readonly code: ContextEfficiencyMetricsErrorCode;
  override readonly name = "ContextEfficiencyMetricsError" as const;

  constructor(code: ContextEfficiencyMetricsErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface NormalizedDocument {
  readonly classificationState: "complete" | "partial";
  readonly count: TokenCount;
  readonly documentId: InstructionDocumentId;
  readonly path: RepositoryRelativePath;
}

interface NormalizedStatement {
  readonly classification: StatementClassifierResult;
  readonly count: TokenCount;
  readonly document: NormalizedDocument;
}

interface TargetProjection {
  readonly accounting: ProfileTargetAccounting["accounting"];
  readonly contributions: ReadonlyMap<InstructionDocumentId, number>;
  readonly path: RepositoryRelativePath;
  readonly state: "complete" | "partial";
}

interface ProfileProjection {
  readonly distribution: ProfileTargetDistribution;
  readonly identity: ProfileMetricIdentity;
  readonly observedDocuments: ReadonlySet<InstructionDocumentId>;
  readonly targets: ReadonlyMap<RepositoryRelativePath, TargetProjection>;
}

interface EvidenceBudget {
  entries: number;
}

const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const INPUT_KEYS = [
  "comparisons",
  "contractVersion",
  "documents",
  "identity",
  "profiles",
  "recordKind",
  "statements",
] as const;
const DOCUMENT_KEYS = ["classificationState", "count", "documentId", "path"] as const;
const STATEMENT_KEYS = ["count", "statement"] as const;
const PROFILE_KEYS = ["accountings", "profile", "sampling"] as const;
const COUNT_KEYS = [
  "contractVersion",
  "identity",
  "inputCodeUnits",
  "inputUtf8Bytes",
  "tokens",
] as const;
const ISSUED_METRICS = new WeakSet<object>();

/** True only for a G05 report issued by this process. */
export function isIssuedContextEfficiencyMetrics(
  value: unknown,
): value is ContextEfficiencyMetrics {
  return typeof value === "object" && value !== null && ISSUED_METRICS.has(value);
}

function fail(code: ContextEfficiencyMetricsErrorCode, message: string): never {
  throw new ContextEfficiencyMetricsError(code, message);
}

function dataRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return fail(ContextEfficiencyMetricsErrorCode.invalidInput, `${label} must be a data record`);
  let prototype: object | null;
  let actual: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    actual = Reflect.ownKeys(value);
    /* v8 ignore start -- proxies are rejected before their reflective traps can execute */
  } catch {
    return fail(ContextEfficiencyMetricsErrorCode.invalidInput, `${label} cannot be inspected`);
  }
  /* v8 ignore stop */
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail(ContextEfficiencyMetricsErrorCode.invalidInput, `${label} has unexpected fields`);
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidInput,
        `${label}.${key} must be an own data field`,
      );
  }
  return value as DataRecord;
}

function property(record: DataRecord, key: string): unknown {
  return Reflect.getOwnPropertyDescriptor(record, key)?.value;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return fail(ContextEfficiencyMetricsErrorCode.invalidInput, `${label} must be a regular array`);
  if (value.length > maximum)
    return fail(ContextEfficiencyMetricsErrorCode.resourceLimit, `${label} exceeds its item limit`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1)
    return fail(
      ContextEfficiencyMetricsErrorCode.invalidInput,
      `${label} must be dense and unextended`,
    );
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(ContextEfficiencyMetricsErrorCode.invalidInput, `${label} has an unsafe entry`);
  }
  return value;
}

function stableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !STABLE_IDENTIFIER.test(value)
  )
    return fail(ContextEfficiencyMetricsErrorCode.invalidInput, `${label} is invalid`);
  return value;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || value === "." || !isRepositoryRelativePath(value))
    return fail(
      ContextEfficiencyMetricsErrorCode.invalidInput,
      `${label} must be a canonical repository file path`,
    );
  return value;
}

function natural(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return fail(
      ContextEfficiencyMetricsErrorCode.invalidInput,
      `${label} must be a non-negative safe integer`,
    );
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result))
    return fail(ContextEfficiencyMetricsErrorCode.resourceLimit, `${label} exceeds safe range`);
  return result;
}

function ratioBasisPoints(numerator: number, denominator: number): number {
  /* v8 ignore start -- callers prove a positive denominator before invoking this helper */
  if (denominator === 0)
    return fail(ContextEfficiencyMetricsErrorCode.invalidRelationship, "ratio denominator is zero");
  /* v8 ignore stop */
  const result = (BigInt(numerator) * BigInt(CONTEXT_EFFICIENCY_RATIO_SCALE)) / BigInt(denominator);
  /* v8 ignore start -- upstream occurrence/count limits bound every reachable ratio */
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    return fail(ContextEfficiencyMetricsErrorCode.resourceLimit, "ratio exceeds safe range");
  /* v8 ignore stop */
  return Number(result);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function profileKey(profile: ProfileTargetIdentity): string {
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

function normalizeCount(value: unknown, identity: TokenizerIdentity, label: string): TokenCount {
  const record = dataRecord(value, COUNT_KEYS, label);
  if (property(record, "contractVersion") !== TOKENIZER_PLUGIN_CONTRACT_VERSION)
    return fail(
      ContextEfficiencyMetricsErrorCode.invalidInput,
      `${label}.contractVersion is invalid`,
    );
  const compatibility = compareTokenizerIdentities(identity, property(record, "identity"));
  if (!compatibility.compatible)
    return fail(
      ContextEfficiencyMetricsErrorCode.incompatibleTokenizer,
      `${label} uses an incompatible tokenizer`,
    );
  return Object.freeze({
    contractVersion: TOKENIZER_PLUGIN_CONTRACT_VERSION,
    identity,
    inputCodeUnits: natural(property(record, "inputCodeUnits"), `${label}.inputCodeUnits`),
    inputUtf8Bytes: natural(property(record, "inputUtf8Bytes"), `${label}.inputUtf8Bytes`),
    tokens: natural(property(record, "tokens"), `${label}.tokens`),
  });
}

function addEvidence(budget: EvidenceBudget, amount: number): void {
  budget.entries = safeAdd(budget.entries, amount, "metric evidence count");
  if (budget.entries > CONTEXT_EFFICIENCY_METRICS_LIMITS.maximumEvidenceEntries)
    return fail(
      ContextEfficiencyMetricsErrorCode.resourceLimit,
      "metric evidence exceeds its aggregate limit",
    );
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    /* v8 ignore next -- G05 constructs and composes only own data fields */
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function nearestRank(sorted: readonly number[], percentile: 50 | 95): number {
  const value = sorted[Math.ceil((sorted.length * percentile) / 100) - 1];
  /* v8 ignore start -- all callers require a non-empty measured population */
  if (value === undefined)
    return fail(ContextEfficiencyMetricsErrorCode.invalidRelationship, "percentile input is empty");
  /* v8 ignore stop */
  return value;
}

function normalizeDocuments(
  rawValue: unknown,
  identity: TokenizerIdentity,
): readonly NormalizedDocument[] {
  const values = denseArray(
    rawValue,
    CONTEXT_EFFICIENCY_METRICS_LIMITS.maximumDocuments,
    "documents",
  );
  const documents = values
    .map((value, index) => {
      const label = `documents[${String(index)}]`;
      const record = dataRecord(value, DOCUMENT_KEYS, label);
      const classificationState = property(record, "classificationState");
      if (classificationState !== "complete" && classificationState !== "partial")
        return fail(
          ContextEfficiencyMetricsErrorCode.invalidInput,
          `${label}.classificationState is invalid`,
        );
      return Object.freeze({
        classificationState,
        count: normalizeCount(property(record, "count"), identity, `${label}.count`),
        documentId: stableIdentifier(
          property(record, "documentId"),
          `${label}.documentId`,
        ) as InstructionDocumentId,
        path: pathValue(property(record, "path"), `${label}.path`),
      });
    })
    .sort((left, right) => compareRepositoryRelativePaths(left.path, right.path));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.documentId) || paths.has(document.path))
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        "documents must have unique identities and paths",
      );
    ids.add(document.documentId);
    paths.add(document.path);
  }
  return Object.freeze(documents);
}

function normalizeStatements(
  rawValue: unknown,
  identity: TokenizerIdentity,
  documents: ReadonlyMap<InstructionDocumentId, NormalizedDocument>,
): readonly NormalizedStatement[] {
  const values = denseArray(
    rawValue,
    CONTEXT_EFFICIENCY_METRICS_LIMITS.maximumStatements,
    "statements",
  );
  const output: NormalizedStatement[] = [];
  for (const [index, value] of values.entries()) {
    const label = `statements[${String(index)}]`;
    const record = dataRecord(value, STATEMENT_KEYS, label);
    let classification: StatementClassifierResult;
    try {
      classification = normalizeAndClassifyStatement(property(record, "statement"));
    } catch {
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidInput,
        `${label}.statement is not valid F03 input`,
      );
    }
    const document = documents.get(classification.statement.documentId);
    if (document === undefined)
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        `${label} refers to a document outside the metric inventory`,
      );
    const count = normalizeCount(property(record, "count"), identity, `${label}.count`);
    if (
      count.inputCodeUnits !== classification.statement.text.length ||
      count.inputUtf8Bytes !== Buffer.byteLength(classification.statement.text, "utf8")
    )
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        `${label}.count does not describe the exact statement source`,
      );
    output.push(Object.freeze({ classification, count, document }));
  }
  output.sort((left, right) =>
    compareUtf8(left.classification.statement.id, right.classification.statement.id),
  );
  for (let index = 1; index < output.length; index += 1) {
    if (
      output[index - 1]?.classification.statement.id === output[index]?.classification.statement.id
    )
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        "statements must have unique identities",
      );
  }
  return Object.freeze(output);
}

function metricProfileIdentity(profile: ProfileTargetIdentity): ProfileMetricIdentity {
  return Object.freeze({ ...profile, key: profileKey(profile) });
}

function projectTarget(
  entry: ProfileTargetAccounting,
  state: "complete" | "partial",
  documents: ReadonlyMap<InstructionDocumentId, NormalizedDocument>,
  observedDocuments: Set<InstructionDocumentId>,
  budget: EvidenceBudget,
): TargetProjection {
  const contributions = new Map<InstructionDocumentId, number>();
  for (const documentEvidence of entry.accounting.documents) {
    const documentId = documentEvidence.documentId as InstructionDocumentId;
    const document = documents.get(documentId);
    if (
      document?.path !== documentEvidence.path ||
      document.count.tokens !== documentEvidence.rawTokens
    )
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        "profile accounting document evidence disagrees with the metric inventory",
      );
    observedDocuments.add(documentId);
  }
  for (const occurrence of entry.accounting.occurrences) {
    if (occurrence.disposition !== "included") continue;
    const documentId = occurrence.targetDocumentId as InstructionDocumentId | null;
    /* v8 ignore start -- G04 revalidation proves included occurrence contribution fields */
    if (documentId === null || occurrence.consumedTokens === null)
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        "included occurrence lacks token contribution evidence",
      );
    /* v8 ignore stop */
    /* v8 ignore start -- accounting document reconciliation above proves inventory membership */
    if (!documents.has(documentId))
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        "included occurrence refers to a document outside the metric inventory",
      );
    /* v8 ignore stop */
    contributions.set(
      documentId,
      safeAdd(
        contributions.get(documentId) ?? 0,
        occurrence.consumedTokens,
        "document effective token contribution",
      ),
    );
  }
  addEvidence(budget, contributions.size);
  return Object.freeze({
    accounting: entry.accounting,
    contributions,
    path: entry.path,
    state,
  });
}

function normalizeProfiles(
  rawValue: unknown,
  identity: TokenizerIdentity,
  documents: ReadonlyMap<InstructionDocumentId, NormalizedDocument>,
  budget: EvidenceBudget,
): readonly ProfileProjection[] {
  const values = denseArray(
    rawValue,
    CONTEXT_EFFICIENCY_METRICS_LIMITS.maximumProfiles,
    "profiles",
  );
  if (values.length === 0)
    return fail(
      ContextEfficiencyMetricsErrorCode.invalidRelationship,
      "at least one profile is required",
    );
  const projections: ProfileProjection[] = [];
  for (const [index, value] of values.entries()) {
    const label = `profiles[${String(index)}]`;
    const record = dataRecord(value, PROFILE_KEYS, label);
    const accountings = property(record, "accountings") as readonly ProfileTargetAccounting[];
    const profile = property(record, "profile") as ProfileTargetIdentity;
    const sampling = property(record, "sampling") as TargetSamplingResult;
    let distribution: ProfileTargetDistribution;
    try {
      distribution = aggregateProfileTargetDistribution({
        accountings,
        identity,
        profile,
        sampling,
      });
    } catch {
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidInput,
        `${label} is not valid G04 distribution evidence`,
      );
    }
    const identityValue = metricProfileIdentity(distribution.profile);
    const entriesByPath = new Map(accountings.map((entry) => [entry.path, entry]));
    const targets = new Map<RepositoryRelativePath, TargetProjection>();
    const observedDocuments = new Set<InstructionDocumentId>();
    for (const target of distribution.targets) {
      const entry = entriesByPath.get(target.path);
      /* v8 ignore next -- G04 proves exact path-set correspondence */
      if (entry === undefined)
        return fail(
          ContextEfficiencyMetricsErrorCode.invalidRelationship,
          "G04 target lacks its accounting",
        );
      targets.set(
        target.path,
        projectTarget(entry, target.state, documents, observedDocuments, budget),
      );
    }
    projections.push(
      Object.freeze({ distribution, identity: identityValue, observedDocuments, targets }),
    );
  }
  projections.sort((left, right) => compareUtf8(left.identity.key, right.identity.key));
  for (let index = 1; index < projections.length; index += 1) {
    if (projections[index - 1]?.identity.key === projections[index]?.identity.key)
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        "profiles must have distinct contracts",
      );
  }
  return Object.freeze(projections);
}

function buildDuplicationEvidence(
  statements: readonly NormalizedStatement[],
): DuplicationIndexResult {
  try {
    return buildDuplicationIndex(
      statements.map(({ classification }) => ({
        documentId: classification.statement.documentId,
        nodeIds: classification.statement.nodeIds,
        normalizedText: classification.normalizedText,
        range: classification.statement.range,
        statementId: classification.statement.id,
      })),
    );
  } catch {
    return fail(
      ContextEfficiencyMetricsErrorCode.invalidRelationship,
      "F03 statement evidence could not produce an F04 duplication index",
    );
  }
}

function statementContribution(statement: NormalizedStatement): MetricStatementContribution {
  return Object.freeze({
    documentId: statement.document.documentId,
    path: statement.document.path,
    range: statement.classification.statement.range,
    statementId: statement.classification.statement.id,
    tokens: statement.count.tokens,
  });
}

function duplicationMetrics(
  index: DuplicationIndexResult,
  statements: ReadonlyMap<InstructionStatementId, NormalizedStatement>,
  budget: EvidenceBudget,
): DuplicateMetrics {
  let exactTokens = 0;
  const exactClusters = index.exactClusters.map((cluster) => {
    const members = cluster.members.map((member) => {
      const statement = statements.get(member.statementId);
      /* v8 ignore start -- this index was built from the same statement map */
      if (statement === undefined)
        return fail(
          ContextEfficiencyMetricsErrorCode.invalidRelationship,
          "F04 exact cluster refers to an unknown statement",
        );
      /* v8 ignore stop */
      return statementContribution(statement);
    });
    const canonical = members[0];
    /* v8 ignore next -- F04 exact clusters always contain at least two members */
    if (canonical === undefined)
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        "F04 exact cluster is empty",
      );
    const duplicates = Object.freeze(members.slice(1));
    const redundantTokens = duplicates.reduce(
      (sum, member) => safeAdd(sum, member.tokens, "exact duplicate tokens"),
      0,
    );
    exactTokens = safeAdd(exactTokens, redundantTokens, "total exact duplicate tokens");
    addEvidence(budget, members.length);
    return Object.freeze({
      canonical,
      duplicates,
      id: cluster.id,
      normalizedTextSha256: cluster.normalizedTextSha256,
      redundantTokens,
      semanticEquivalenceClaim: false as const,
    });
  });

  let nearTokens = 0;
  const nearClusters = index.nearClusters.map((cluster) => {
    const members = cluster.members.map((member) => {
      const statement = statements.get(member.statementId);
      /* v8 ignore start -- this index was built from the same statement map */
      if (statement === undefined)
        return fail(
          ContextEfficiencyMetricsErrorCode.invalidRelationship,
          "F04 near cluster refers to an unknown statement",
        );
      /* v8 ignore stop */
      return statement;
    });
    const representatives = new Map<string, NormalizedStatement>();
    for (const statement of members) {
      const text = statement.classification.normalizedText;
      if (!representatives.has(text)) representatives.set(text, statement);
    }
    const unique = [...representatives.values()].sort((left, right) =>
      compareUtf8(left.classification.statement.id, right.classification.statement.id),
    );
    const representativeStatement = unique[0];
    /* v8 ignore next -- F04 near clusters span at least two unique normalized texts */
    if (representativeStatement === undefined)
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        "F04 near cluster is empty",
      );
    const candidates = Object.freeze(unique.slice(1).map(statementContribution));
    const similarityCandidateTokens = candidates.reduce(
      (sum, member) => safeAdd(sum, member.tokens, "near duplicate candidate tokens"),
      0,
    );
    nearTokens = safeAdd(
      nearTokens,
      similarityCandidateTokens,
      "total near duplicate candidate tokens",
    );
    addEvidence(budget, cluster.members.length + cluster.edges.length);
    return Object.freeze({
      candidates,
      edges: cluster.edges,
      id: cluster.id,
      memberCount: cluster.members.length,
      representative: statementContribution(representativeStatement),
      semanticEquivalenceClaim: false as const,
      similarityCandidateTokens,
    });
  });
  return Object.freeze({
    exact: Object.freeze({ clusters: Object.freeze(exactClusters), redundantTokens: exactTokens }),
    indexContractVersion: index.contractVersion,
    near: Object.freeze({
      clusters: Object.freeze(nearClusters),
      similarity: index.similarity,
      similarityCandidateTokens: nearTokens,
    }),
    state: "complete" as const,
  });
}

function densityRate(actionable: number, tokens: number): number | null {
  if (tokens === 0) return null;
  const scaled = BigInt(actionable) * 1_000n * BigInt(CONTEXT_EFFICIENCY_RATIO_SCALE);
  const result = scaled / BigInt(tokens);
  /* v8 ignore start -- maximum statements and the per-thousand scale keep density in range */
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    return fail(ContextEfficiencyMetricsErrorCode.resourceLimit, "density exceeds safe range");
  /* v8 ignore stop */
  return Number(result);
}

function densityMetrics(
  documents: readonly NormalizedDocument[],
  statements: readonly NormalizedStatement[],
  budget: EvidenceBudget,
): DensityMetrics {
  const byDocument = new Map<InstructionDocumentId, NormalizedStatement[]>();
  for (const statement of statements) {
    const current = byDocument.get(statement.document.documentId);
    if (current === undefined) byDocument.set(statement.document.documentId, [statement]);
    else current.push(statement);
  }
  let rawTokens = 0;
  let statementCount = 0;
  let actionableStatementCount = 0;
  const partial = documents.some((document) => document.classificationState === "partial");
  const documentMetrics = documents.map((document) => {
    const documentStatements = byDocument.get(document.documentId) ?? [];
    const actionable = documentStatements.filter(
      (statement) => statement.classification.classification.state === "classified",
    );
    const actionableStatements = Object.freeze(
      actionable.map((statement) =>
        Object.freeze({
          domains: Object.freeze(statement.classification.domains.map((domain) => domain.domain)),
          range: statement.classification.statement.range,
          statementId: statement.classification.statement.id,
        }),
      ),
    );
    rawTokens = safeAdd(rawTokens, document.count.tokens, "density raw tokens");
    statementCount = safeAdd(statementCount, documentStatements.length, "density statement count");
    actionableStatementCount = safeAdd(
      actionableStatementCount,
      actionable.length,
      "density actionable statement count",
    );
    addEvidence(budget, actionableStatements.length + 1);
    return Object.freeze({
      actionablePerThousandBasisPoints: densityRate(actionable.length, document.count.tokens),
      actionableStatementCount: actionable.length,
      actionableStatements,
      documentId: document.documentId,
      path: document.path,
      state:
        document.classificationState === "partial"
          ? ("partial" as const)
          : document.count.tokens === 0
            ? ("empty" as const)
            : ("complete" as const),
      statementCount: documentStatements.length,
      tokens: document.count.tokens,
    });
  });
  return Object.freeze({
    actionablePerThousandBasisPoints: densityRate(actionableStatementCount, rawTokens),
    actionableStatementCount,
    documents: Object.freeze(documentMetrics),
    rawTokens,
    state: partial ? "partial" : rawTokens === 0 ? "empty" : "complete",
    statementCount,
  });
}

function deadScopeMetrics(
  profiles: readonly ProfileProjection[],
  documents: readonly NormalizedDocument[],
  budget: EvidenceBudget,
): readonly ProfileDeadScopeMetric[] {
  return Object.freeze(
    profiles.map((profile) => {
      const reasonCodes: string[] = [];
      if (profile.distribution.sampling.strategy !== "exhaustive")
        reasonCodes.push("sample-not-exhaustive");
      if (profile.distribution.state === "partial") reasonCodes.push("profile-evidence-partial");
      const unobservedDocuments = documents
        .filter((document) => !profile.observedDocuments.has(document.documentId))
        .map((document) =>
          Object.freeze({
            documentId: document.documentId,
            path: document.path,
            tokens: document.count.tokens,
          }),
        );
      if (unobservedDocuments.length > 0) reasonCodes.push("documents-unobserved");
      const measured = reasonCodes.length === 0;
      const dead: DeadScopeDocumentMetric[] = [];
      let tokens = 0;
      if (measured) {
        for (const document of documents) {
          let included = false;
          for (const target of profile.targets.values()) {
            if (target.contributions.has(document.documentId)) {
              included = true;
              break;
            }
          }
          if (included) continue;
          dead.push(
            Object.freeze({
              documentId: document.documentId,
              observedTargetCount: profile.targets.size,
              path: document.path,
              tokens: document.count.tokens,
            }),
          );
          tokens = safeAdd(tokens, document.count.tokens, "dead-scope tokens");
        }
      }
      addEvidence(budget, dead.length + unobservedDocuments.length);
      return Object.freeze({
        documents: Object.freeze(dead),
        profile: profile.identity,
        reasonCodes: Object.freeze(reasonCodes),
        state: measured ? ("measured" as const) : ("unknown" as const),
        tokens: measured ? tokens : null,
        unobservedDocuments: Object.freeze(unobservedDocuments),
      });
    }),
  );
}

function broadScopeMetrics(
  profiles: readonly ProfileProjection[],
  documents: readonly NormalizedDocument[],
  budget: EvidenceBudget,
): readonly ProfileBroadScopeMetric[] {
  return Object.freeze(
    profiles.map((profile) => {
      const completeTargetCount = [...profile.targets.values()].filter(
        (target) => target.state === "complete",
      ).length;
      const metrics: BroadScopeDocumentMetric[] = [];
      for (const document of documents) {
        const targets: TargetTokenContribution[] = [];
        let completeIncludedTargetCount = 0;
        let effectiveTokens = 0;
        for (const target of profile.targets.values()) {
          const tokens = target.contributions.get(document.documentId);
          if (tokens === undefined) continue;
          targets.push(Object.freeze({ path: target.path, state: target.state, tokens }));
          effectiveTokens = safeAdd(effectiveTokens, tokens, "broad-scope effective tokens");
          if (target.state === "complete") completeIncludedTargetCount += 1;
        }
        if (targets.length === 0 && !profile.observedDocuments.has(document.documentId)) continue;
        addEvidence(budget, targets.length + 1);
        metrics.push(
          Object.freeze({
            completeIncludedTargetCount,
            completeTargetCount,
            coverageBasisPoints:
              completeTargetCount === 0
                ? null
                : ratioBasisPoints(completeIncludedTargetCount, completeTargetCount),
            documentId: document.documentId,
            effectiveTokens,
            path: document.path,
            state:
              completeTargetCount === 0
                ? ("unknown" as const)
                : profile.distribution.state === "complete"
                  ? ("complete" as const)
                  : ("partial" as const),
            targets: Object.freeze(targets),
            tokens: document.count.tokens,
          }),
        );
      }
      return Object.freeze({
        documents: Object.freeze(metrics),
        profile: profile.identity,
        state:
          profile.distribution.state === "partial" ? ("partial" as const) : ("complete" as const),
      });
    }),
  );
}

function targetMetricContributions(
  target: TargetProjection,
  documents: ReadonlyMap<InstructionDocumentId, NormalizedDocument>,
): readonly MetricTokenContribution[] {
  return Object.freeze(
    [...target.contributions.entries()]
      .map(([documentId, tokens]) => {
        const document = documents.get(documentId);
        /* v8 ignore next -- profile projection already validates document membership */
        if (document === undefined)
          return fail(
            ContextEfficiencyMetricsErrorCode.invalidRelationship,
            "target contribution lacks a document",
          );
        return Object.freeze({ documentId, path: document.path, tokens });
      })
      .sort((left, right) => compareRepositoryRelativePaths(left.path, right.path)),
  );
}

function amplificationMetrics(
  profiles: readonly ProfileProjection[],
  documents: ReadonlyMap<InstructionDocumentId, NormalizedDocument>,
  budget: EvidenceBudget,
): readonly ProfileAmplificationMetric[] {
  return Object.freeze(
    profiles.map((profile) => {
      const ratioValues: number[] = [];
      const targets = [...profile.targets.values()]
        .sort((left, right) => compareRepositoryRelativePaths(left.path, right.path))
        .map((target) => {
          const { effective, unique } = target.accounting.totals;
          const contributions = targetMetricContributions(target, documents);
          addEvidence(budget, contributions.length + 1);
          if (target.state === "partial") {
            return Object.freeze({
              amplificationBasisPoints: null,
              contributions,
              effectiveTokens: effective,
              path: target.path,
              repeatedTokens: null,
              state: "partial" as const,
              uniqueTokens: unique,
            });
          }
          if (unique === 0) {
            /* v8 ignore start -- reconciled G03 totals cannot have effective content without unique content */
            if (effective !== 0)
              return fail(
                ContextEfficiencyMetricsErrorCode.invalidRelationship,
                "effective tokens cannot exist without unique source tokens",
              );
            /* v8 ignore stop */
            return Object.freeze({
              amplificationBasisPoints: null,
              contributions,
              effectiveTokens: effective,
              path: target.path,
              repeatedTokens: 0,
              state: "not-applicable" as const,
              uniqueTokens: unique,
            });
          }
          const ratio = ratioBasisPoints(effective, unique);
          ratioValues.push(ratio);
          return Object.freeze({
            amplificationBasisPoints: ratio,
            contributions,
            effectiveTokens: effective,
            path: target.path,
            repeatedTokens: Math.max(0, effective - unique),
            state: "complete" as const,
            uniqueTokens: unique,
          });
        });
      ratioValues.sort((left, right) => left - right);
      const statistics =
        ratioValues.length === 0
          ? null
          : Object.freeze({
              maximumBasisPoints: ratioValues.at(-1) ?? 0,
              minimumBasisPoints: ratioValues[0] ?? 0,
              p50BasisPoints: nearestRank(ratioValues, 50),
              p95BasisPoints: nearestRank(ratioValues, 95),
            });
      return Object.freeze({
        profile: profile.identity,
        state:
          targets.length === 0
            ? ("empty" as const)
            : targets.some((target) => target.state === "partial")
              ? ("partial" as const)
              : ("complete" as const),
        statistics,
        targets: Object.freeze(targets),
      });
    }),
  );
}

function profileMatchesSummary(
  profile: ProfileProjection,
  summary: CrossProfileProfileSummary,
): boolean {
  return (
    profile.identity.clientVersion === summary.clientVersion &&
    profile.identity.profileId === summary.profileId &&
    profile.identity.profileVersion === summary.profileVersion &&
    profile.identity.specSnapshotId === summary.specSnapshotId &&
    profile.identity.surfaceId === summary.surfaceId
  );
}

function pathTokenMap(
  target: TargetProjection,
  documents: ReadonlyMap<InstructionDocumentId, NormalizedDocument>,
): ReadonlyMap<RepositoryRelativePath, number> {
  const result = new Map<RepositoryRelativePath, number>();
  for (const [documentId, tokens] of target.contributions) {
    const document = documents.get(documentId);
    /* v8 ignore next -- profile projection already validates document membership */
    if (document === undefined)
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
        "divergence contribution lacks a document",
      );
    result.set(document.path, tokens);
  }
  return result;
}

function tokensForState(
  tokens: ReadonlyMap<RepositoryRelativePath, number>,
  path: RepositoryRelativePath,
  state: CrossProfileScopeState | null,
): number | null {
  const measured = tokens.get(path);
  if (measured !== undefined) return measured;
  return state === "absent" || state === "excluded" ? 0 : null;
}

interface MutableDivergencePath {
  kinds: Set<DivergenceEvidenceKind>;
  leftState: CrossProfileScopeState | null;
  rightState: CrossProfileScopeState | null;
}

function addPathKind(
  paths: Map<RepositoryRelativePath, MutableDivergencePath>,
  path: RepositoryRelativePath,
  kind: DivergenceEvidenceKind,
  leftState: CrossProfileScopeState | null = null,
  rightState: CrossProfileScopeState | null = null,
): void {
  const current = paths.get(path);
  if (current === undefined) {
    paths.set(path, { kinds: new Set([kind]), leftState, rightState });
    return;
  }
  current.kinds.add(kind);
  if (leftState !== null) current.leftState = leftState;
  if (rightState !== null) current.rightState = rightState;
}

function pathEvidenceForPair(
  pair: CrossProfilePairComparison,
  leftTokens: ReadonlyMap<RepositoryRelativePath, number>,
  rightTokens: ReadonlyMap<RepositoryRelativePath, number>,
  budget: EvidenceBudget,
): readonly DivergencePathEvidence[] {
  const paths = new Map<RepositoryRelativePath, MutableDivergencePath>();
  for (const difference of pair.scope.differences)
    addPathKind(
      paths,
      difference.path,
      "scope-different",
      difference.leftState,
      difference.rightState,
    );
  for (const path of pair.scope.unknownPaths)
    addPathKind(paths, path, "scope-unknown", "unknown", "unknown");
  for (const difference of pair.content.differences)
    addPathKind(paths, difference.path, "content-different", "included", "included");
  for (const path of pair.content.unknownPaths)
    addPathKind(paths, path, "content-unknown", null, null);
  if (pair.ordering.witness !== null) {
    addPathKind(paths, pair.ordering.witness.firstPath, "ordering-witness", "included", "included");
    addPathKind(
      paths,
      pair.ordering.witness.secondPath,
      "ordering-witness",
      "included",
      "included",
    );
  }
  addEvidence(budget, paths.size);
  return Object.freeze(
    [...paths.entries()]
      .sort(([left], [right]) => compareRepositoryRelativePaths(left, right))
      .map(([path, value]) =>
        Object.freeze({
          kinds: Object.freeze([...value.kinds].sort(compareUtf8)),
          leftState: value.leftState,
          leftTokens: tokensForState(leftTokens, path, value.leftState),
          path,
          rightState: value.rightState,
          rightTokens: tokensForState(rightTokens, path, value.rightState),
        }),
      ),
  );
}

function sumPathDifference(
  paths: readonly DivergencePathEvidence[],
  kind: DivergenceEvidenceKind,
  mode: "absolute" | "maximum",
): number | null {
  let total = 0;
  for (const path of paths) {
    if (!path.kinds.includes(kind)) continue;
    if (path.leftTokens === null || path.rightTokens === null) return null;
    const contribution =
      mode === "absolute"
        ? Math.abs(path.leftTokens - path.rightTokens)
        : Math.max(path.leftTokens, path.rightTokens);
    total = safeAdd(total, contribution, "cross-profile divergent tokens");
  }
  return total;
}

function divergentExactPolicy(
  pair: CrossProfilePairComparison,
  exactClusters: readonly ExactDuplicateMetricCluster[],
  budget: EvidenceBudget,
): readonly DivergentExactPolicyMetric[] {
  const scope = new Map(
    pair.scope.differences.map((difference) => [difference.path, difference] as const),
  );
  const output: DivergentExactPolicyMetric[] = [];
  for (const cluster of exactClusters) {
    const members = [cluster.canonical, ...cluster.duplicates].filter((member) => {
      const difference = scope.get(member.path);
      return (
        difference !== undefined &&
        (difference.leftState === "included" || difference.rightState === "included")
      );
    });
    const hasLeftSpecific = members.some((member) => {
      const difference = scope.get(member.path);
      return difference?.leftState === "included" && difference.rightState !== "included";
    });
    const hasRightSpecific = members.some((member) => {
      const difference = scope.get(member.path);
      return difference?.rightState === "included" && difference.leftState !== "included";
    });
    if (!hasLeftSpecific || !hasRightSpecific) continue;
    members.sort((left, right) => compareUtf8(left.statementId, right.statementId));
    const repeatedTokens = members
      .slice(1)
      .reduce((sum, member) => safeAdd(sum, member.tokens, "divergent exact policy tokens"), 0);
    addEvidence(budget, members.length);
    output.push(
      Object.freeze({
        clusterId: cluster.id,
        members: Object.freeze(members),
        repeatedTokens,
        semanticEquivalenceClaim: false as const,
      }),
    );
  }
  return Object.freeze(output);
}

function expectedPairKey(
  left: ProfileMetricIdentity,
  right: ProfileMetricIdentity,
  targetPath: RepositoryRelativePath,
): string {
  const [first, second] =
    compareUtf8(left.key, right.key) <= 0 ? [left.key, right.key] : [right.key, left.key];
  return `${first}\u0000${second}\u0000${targetPath}`;
}

function divergenceMetrics(
  rawValue: unknown,
  profiles: readonly ProfileProjection[],
  documents: ReadonlyMap<InstructionDocumentId, NormalizedDocument>,
  exactClusters: readonly ExactDuplicateMetricCluster[],
  budget: EvidenceBudget,
): CrossProfileDivergenceMetrics {
  const comparisons = denseArray(
    rawValue,
    CONTEXT_EFFICIENCY_METRICS_LIMITS.maximumComparisons,
    "comparisons",
  );
  const expected = new Map<string, MissingCrossProfileComparison>();
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex];
      const right = profiles[rightIndex];
      /* v8 ignore next -- the loop bounds guarantee both profiles */
      if (left === undefined || right === undefined) continue;
      for (const targetPath of left.targets.keys()) {
        if (!right.targets.has(targetPath)) continue;
        if (expected.size >= CONTEXT_EFFICIENCY_METRICS_LIMITS.maximumPairTargets)
          return fail(
            ContextEfficiencyMetricsErrorCode.resourceLimit,
            "cross-profile pair/target work exceeds its limit",
          );
        expected.set(
          expectedPairKey(left.identity, right.identity, targetPath),
          Object.freeze({
            leftProfile: left.identity,
            rightProfile: right.identity,
            targetPath,
          }),
        );
      }
    }
  }

  const observed = new Set<string>();
  const observations: CrossProfileDivergenceObservation[] = [];
  let anyPartialComparison = false;
  let exactRepeatedPolicyTokens = 0;
  for (const [comparisonIndex, rawComparison] of comparisons.entries()) {
    if (!isIssuedCrossProfileComparison(rawComparison))
      return fail(
        ContextEfficiencyMetricsErrorCode.invalidInput,
        `comparisons[${String(comparisonIndex)}] must be a same-process E07 result`,
      );
    const comparison = rawComparison;
    if (comparison.analysisStatus === "partial") anyPartialComparison = true;
    const profileBySummaryId = new Map<string, ProfileProjection>();
    for (const summary of comparison.profiles) {
      const matches = profiles.filter((profile) => profileMatchesSummary(profile, summary));
      if (matches.length !== 1)
        return fail(
          ContextEfficiencyMetricsErrorCode.invalidRelationship,
          "E07 profile does not match exactly one G04 profile distribution",
        );
      const match = matches[0];
      /* v8 ignore next -- exact one-match check proves this value */
      if (match === undefined) continue;
      if (!match.targets.has(comparison.targetPath))
        return fail(
          ContextEfficiencyMetricsErrorCode.invalidRelationship,
          "E07 target is absent from its G04 profile distribution",
        );
      profileBySummaryId.set(summary.id, match);
    }
    for (const pair of comparison.pairs) {
      const left = profileBySummaryId.get(pair.leftProfileId);
      const right = profileBySummaryId.get(pair.rightProfileId);
      /* v8 ignore next -- issued E07 pairs name issued summaries */
      if (left === undefined || right === undefined)
        return fail(
          ContextEfficiencyMetricsErrorCode.invalidRelationship,
          "E07 pair refers to an unknown profile summary",
        );
      const key = expectedPairKey(left.identity, right.identity, comparison.targetPath);
      /* v8 ignore start -- matched profiles plus per-profile target checks construct this key */
      if (!expected.has(key))
        return fail(
          ContextEfficiencyMetricsErrorCode.invalidRelationship,
          "E07 pair/target is outside the G04 sample intersection",
        );
      /* v8 ignore stop */
      if (observed.has(key))
        return fail(
          ContextEfficiencyMetricsErrorCode.invalidRelationship,
          "E07 comparisons repeat a profile pair and target",
        );
      observed.add(key);
      const leftTarget = left.targets.get(comparison.targetPath);
      const rightTarget = right.targets.get(comparison.targetPath);
      /* v8 ignore next -- expected pair membership proves both target projections */
      if (leftTarget === undefined || rightTarget === undefined) continue;
      const paths = pathEvidenceForPair(
        pair,
        pathTokenMap(leftTarget, documents),
        pathTokenMap(rightTarget, documents),
        budget,
      );
      const exactRepeatedPolicy = divergentExactPolicy(pair, exactClusters, budget);
      const pairRepeatedTokens = exactRepeatedPolicy.reduce(
        (sum, cluster) => safeAdd(sum, cluster.repeatedTokens, "pair repeated-policy tokens"),
        0,
      );
      exactRepeatedPolicyTokens = safeAdd(
        exactRepeatedPolicyTokens,
        pairRepeatedTokens,
        "cross-profile repeated-policy tokens",
      );
      observations.push(
        Object.freeze({
          contentDifferentEffectiveTokens: sumPathDifference(paths, "content-different", "maximum"),
          equivalenceClaim: false as const,
          exactRepeatedPolicy,
          exactRepeatedPolicyTokens: pairRepeatedTokens,
          leftProfile: left.identity,
          pairId: pair.id,
          paths,
          qualityClaim: false as const,
          rightProfile: right.identity,
          scopeDifferenceTokens: sumPathDifference(paths, "scope-different", "absolute"),
          state: pair.overall,
          targetPath: comparison.targetPath,
        }),
      );
    }
  }
  observations.sort((left, right) => {
    const targetOrder = compareRepositoryRelativePaths(left.targetPath, right.targetPath);
    return targetOrder !== 0 ? targetOrder : compareUtf8(left.pairId, right.pairId);
  });
  const missing = [...expected.entries()]
    .filter(([key]) => !observed.has(key))
    .map(([, value]) => value)
    .sort((left, right) => {
      const targetOrder = compareRepositoryRelativePaths(left.targetPath, right.targetPath);
      if (targetOrder !== 0) return targetOrder;
      const leftOrder = compareUtf8(left.leftProfile.key, right.leftProfile.key);
      return leftOrder !== 0
        ? leftOrder
        : compareUtf8(left.rightProfile.key, right.rightProfile.key);
    });
  addEvidence(budget, missing.length + observations.length);
  return Object.freeze({
    divergentPairTargetCount: observations.filter((item) => item.state === "divergent").length,
    exactRepeatedPolicyTokens,
    expectedPairTargetCount: expected.size,
    indeterminatePairTargetCount: observations.filter((item) => item.state === "indeterminate")
      .length,
    missing: Object.freeze(missing),
    observations: Object.freeze(observations),
    observationalMatchPairTargetCount: observations.filter(
      (item) => item.state === "observational-match",
    ).length,
    observedPairTargetCount: observations.length,
    qualityClaim: false as const,
    semanticEquivalenceClaim: false as const,
    state: missing.length > 0 || anyPartialComparison ? "partial" : "complete",
  });
}

/**
 * Compose F03/F04, G04, and same-process E07 evidence into bounded context-efficiency metrics.
 * This function performs no I/O and makes no semantic-equivalence or outcome-quality claim.
 */
export function analyzeContextEfficiencyMetrics(
  inputValue: AnalyzeContextEfficiencyMetricsInput,
): ContextEfficiencyMetrics {
  const input = dataRecord(inputValue, INPUT_KEYS, "input");
  if (property(input, "contractVersion") !== CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION)
    return fail(
      ContextEfficiencyMetricsErrorCode.invalidInput,
      "input contract version is invalid",
    );
  if (property(input, "recordKind") !== CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND)
    return fail(ContextEfficiencyMetricsErrorCode.invalidInput, "input record kind is invalid");
  const identityResult = validateTokenizerIdentity(property(input, "identity"));
  if (!identityResult.ok)
    return fail(ContextEfficiencyMetricsErrorCode.invalidInput, "input tokenizer is invalid");
  const identity = identityResult.value;
  const budget: EvidenceBudget = { entries: 0 };
  const documents = normalizeDocuments(property(input, "documents"), identity);
  const documentsById = new Map(documents.map((document) => [document.documentId, document]));
  const statements = normalizeStatements(property(input, "statements"), identity, documentsById);
  const statementsById = new Map(
    statements.map((statement) => [statement.classification.statement.id, statement]),
  );
  const index = buildDuplicationEvidence(statements);
  const profiles = normalizeProfiles(property(input, "profiles"), identity, documentsById, budget);
  const duplication = duplicationMetrics(index, statementsById, budget);
  const density = densityMetrics(documents, statements, budget);
  const deadScope = deadScopeMetrics(profiles, documents, budget);
  const broadScope = broadScopeMetrics(profiles, documents, budget);
  const amplification = amplificationMetrics(profiles, documentsById, budget);
  const divergence = divergenceMetrics(
    property(input, "comparisons"),
    profiles,
    documentsById,
    duplication.exact.clusters,
    budget,
  );
  const partial =
    density.state === "partial" ||
    deadScope.some((metric) => metric.state === "unknown") ||
    broadScope.some((metric) => metric.state === "partial") ||
    amplification.some((metric) => metric.state === "partial") ||
    divergence.state === "partial";
  const output: ContextEfficiencyMetrics = {
    amplification,
    broadScope,
    contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
    deadScope,
    density,
    distributions: profiles.map((profile) => profile.distribution),
    divergence,
    duplication,
    limits: CONTEXT_EFFICIENCY_METRICS_LIMITS,
    recordKind: CONTEXT_EFFICIENCY_METRICS_RECORD_KIND,
    state: partial ? "partial" : "complete",
    tokenizer: identity,
  };
  const frozen = deepFreeze(output);
  ISSUED_METRICS.add(frozen);
  return frozen;
}
