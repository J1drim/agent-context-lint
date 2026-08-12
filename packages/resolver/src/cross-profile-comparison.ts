import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { RepositoryRelativePath } from "@agent-context/core";
import {
  isIssuedEffectiveContextResolution,
  type EffectiveContextAmbiguityKind,
  type EffectiveContextDocument,
  type EffectiveContextResolution,
} from "./effective-context.js";

export const CROSS_PROFILE_COMPARISON_CONTRACT_VERSION = "0.1.0" as const;
export const CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND =
  "agent-context-cross-profile-comparison-input" as const;
export const CROSS_PROFILE_COMPARISON_RECORD_KIND =
  "agent-context-cross-profile-comparison" as const;

export const CROSS_PROFILE_COMPARISON_LIMITS: Readonly<{
  maximumAggregateAmbiguities: number;
  maximumAggregateDocuments: number;
  maximumPairEvidenceEntries: number;
  maximumPairWork: number;
  maximumProfiles: number;
}> = Object.freeze({
  maximumAggregateAmbiguities: 131_072,
  maximumAggregateDocuments: 65_536,
  maximumPairEvidenceEntries: 524_288,
  maximumPairWork: 1_048_576,
  maximumProfiles: 16,
});

export interface CompareEffectiveContextsInput {
  readonly contractVersion: typeof CROSS_PROFILE_COMPARISON_CONTRACT_VERSION;
  readonly recordKind: typeof CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND;
  readonly resolutions: readonly EffectiveContextResolution[];
}

export type CrossProfileDimensionState = "different" | "not-applicable" | "same" | "unknown";
export type CrossProfileScopeState = "absent" | "conditional" | "excluded" | "included" | "unknown";

export interface CrossProfileCountSummary {
  readonly conditional: number;
  readonly excluded: number;
  readonly included: number;
  readonly unavailableContent: number;
}

export interface CrossProfileProfileSummary {
  readonly ambiguityIds: readonly string[];
  readonly analysisStatus: EffectiveContextResolution["analysisStatus"];
  readonly assemblySha256: string | null;
  readonly assemblyState: EffectiveContextResolution["assembly"]["state"];
  readonly clientVersion: string | null;
  readonly counts: CrossProfileCountSummary;
  readonly id: string;
  readonly ordering: EffectiveContextResolution["ordering"];
  readonly profileId: string;
  readonly profileVersion: string;
  readonly specSnapshotId: string;
  readonly surfaceId: string;
}

export interface CrossProfileScopeDifference {
  readonly leftState: CrossProfileScopeState;
  readonly path: RepositoryRelativePath;
  readonly rightState: CrossProfileScopeState;
}

export interface CrossProfileScopeComparison {
  readonly differences: readonly CrossProfileScopeDifference[];
  readonly reasonCodes: readonly string[];
  readonly state: Exclude<CrossProfileDimensionState, "not-applicable">;
  readonly unknownPaths: readonly RepositoryRelativePath[];
}

export interface CrossProfileOrderWitness {
  readonly firstPath: RepositoryRelativePath;
  readonly leftRelation: "before";
  readonly rightRelation: "after";
  readonly secondPath: RepositoryRelativePath;
}

export interface CrossProfileOrderComparison {
  readonly commonIncludedPaths: readonly RepositoryRelativePath[];
  readonly reasonCodes: readonly string[];
  readonly state: CrossProfileDimensionState;
  readonly witness: CrossProfileOrderWitness | null;
}

export interface CrossProfileContentDifference {
  readonly leftSha256: string;
  readonly path: RepositoryRelativePath;
  readonly rightSha256: string;
}

export interface CrossProfileContentComparison {
  readonly differences: readonly CrossProfileContentDifference[];
  readonly matchingPaths: readonly RepositoryRelativePath[];
  readonly reasonCodes: readonly string[];
  readonly state: CrossProfileDimensionState;
  readonly unknownPaths: readonly RepositoryRelativePath[];
}

export interface CrossProfilePairComparison {
  readonly content: CrossProfileContentComparison;
  readonly equivalenceClaim: false;
  readonly id: string;
  readonly leftProfileId: string;
  readonly ordering: CrossProfileOrderComparison;
  readonly overall: "divergent" | "indeterminate" | "observational-match";
  readonly rightProfileId: string;
  readonly scope: CrossProfileScopeComparison;
  readonly semanticRelation: "distinct-surface-contracts" | "incompatible-profile-contracts";
}

export interface CrossProfileComparison {
  readonly analysisStatus: "complete" | "partial";
  readonly contractVersion: typeof CROSS_PROFILE_COMPARISON_CONTRACT_VERSION;
  readonly pairs: readonly CrossProfilePairComparison[];
  readonly profiles: readonly CrossProfileProfileSummary[];
  readonly recordKind: typeof CROSS_PROFILE_COMPARISON_RECORD_KIND;
  readonly targetPath: RepositoryRelativePath;
}

export const CrossProfileComparisonErrorCode: Readonly<{
  invalidInput: "CROSS_PROFILE_COMPARISON_INVALID_INPUT";
  invalidRelationship: "CROSS_PROFILE_COMPARISON_INVALID_RELATIONSHIP";
  resourceLimit: "CROSS_PROFILE_COMPARISON_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "CROSS_PROFILE_COMPARISON_INVALID_INPUT",
  invalidRelationship: "CROSS_PROFILE_COMPARISON_INVALID_RELATIONSHIP",
  resourceLimit: "CROSS_PROFILE_COMPARISON_RESOURCE_LIMIT",
});

export type CrossProfileComparisonErrorCode =
  (typeof CrossProfileComparisonErrorCode)[keyof typeof CrossProfileComparisonErrorCode];

export class CrossProfileComparisonError extends Error {
  readonly code: CrossProfileComparisonErrorCode;
  override readonly name = "CrossProfileComparisonError" as const;

  constructor(code: CrossProfileComparisonErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface ProfileProjection {
  readonly documentsByPath: ReadonlyMap<RepositoryRelativePath, EffectiveContextDocument>;
  readonly includedPaths: ReadonlySet<RepositoryRelativePath>;
  readonly resolution: EffectiveContextResolution;
  readonly scopeComplete: boolean;
  readonly sequencePaths: readonly RepositoryRelativePath[];
  readonly summary: CrossProfileProfileSummary;
}

interface ComparisonBudget {
  evidenceEntries: number;
}

const INPUT_KEYS = new Set(["contractVersion", "recordKind", "resolutions"]);
const SCOPE_AMBIGUITY_KINDS: ReadonlySet<EffectiveContextAmbiguityKind> = new Set([
  "activation",
  "partial-profile",
  "target-scope",
]);
const ISSUED_CROSS_PROFILE_COMPARISONS = new WeakSet<object>();

/** True only for comparison records produced by this process's E07 implementation. */
export function isIssuedCrossProfileComparison(value: unknown): value is CrossProfileComparison {
  return typeof value === "object" && value !== null && ISSUED_CROSS_PROFILE_COMPARISONS.has(value);
}

function fail(code: CrossProfileComparisonErrorCode, message: string): never {
  throw new CrossProfileComparisonError(code, message);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hash(...values: readonly (null | string)[]): string {
  const digest = createHash("sha256");
  for (const value of values) {
    const bytes = Buffer.from(value ?? "<null>", "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

function inputRecord(value: unknown): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    (Reflect.getPrototypeOf(value) !== Object.prototype && Reflect.getPrototypeOf(value) !== null)
  )
    return fail(
      CrossProfileComparisonErrorCode.invalidInput,
      "comparison input must be a non-proxy data record",
    );
  const record = value as DataRecord;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== INPUT_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key))
  )
    return fail(
      CrossProfileComparisonErrorCode.invalidInput,
      "comparison input has unknown or missing fields",
    );
  for (const key of INPUT_KEYS) property(record, key, "comparison input");
  return record;
}

function property(record: DataRecord, key: string, label: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
    return fail(
      CrossProfileComparisonErrorCode.invalidInput,
      `${label}.${key} must be an own data field`,
    );
  return descriptor.value;
}

function resolutionArray(value: unknown): readonly EffectiveContextResolution[] {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return fail(
      CrossProfileComparisonErrorCode.invalidInput,
      "comparison resolutions must be a regular dense array",
    );
  if (value.length < 2)
    return fail(
      CrossProfileComparisonErrorCode.invalidRelationship,
      "cross-profile comparison requires at least two resolutions",
    );
  if (value.length > CROSS_PROFILE_COMPARISON_LIMITS.maximumProfiles)
    return fail(
      CrossProfileComparisonErrorCode.resourceLimit,
      "comparison resolution count exceeds its limit",
    );
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1)
    return fail(
      CrossProfileComparisonErrorCode.invalidInput,
      "comparison resolutions must not be sparse or extended",
    );
  const output: EffectiveContextResolution[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        CrossProfileComparisonErrorCode.invalidInput,
        "comparison resolutions must contain own data entries",
      );
    if (!isIssuedEffectiveContextResolution(descriptor.value))
      return fail(
        CrossProfileComparisonErrorCode.invalidInput,
        "comparison accepts only same-process E05 resolutions",
      );
    output.push(descriptor.value);
  }
  if (new Set(output).size !== output.length)
    return fail(
      CrossProfileComparisonErrorCode.invalidRelationship,
      "comparison resolutions must not repeat an issued object",
    );
  return output;
}

function profileId(resolution: EffectiveContextResolution): string {
  return `comparison-profile:${hash(
    resolution.profileId,
    resolution.surfaceId,
    resolution.profileVersion,
    resolution.specSnapshotId,
    resolution.clientVersion,
  ).slice(0, 32)}`;
}

function scopeState(document: EffectiveContextDocument): CrossProfileScopeState {
  if (document.activation === "indeterminate" || document.state === "conditional")
    return "conditional";
  if (
    document.activation === "inactive" ||
    document.state === "inactive" ||
    document.state === "shadowed"
  )
    return "excluded";
  return "included";
}

function projectProfile(resolution: EffectiveContextResolution): ProfileProjection {
  const documentsByPath = new Map<RepositoryRelativePath, EffectiveContextDocument>();
  let conditional = 0;
  let excluded = 0;
  let included = 0;
  let unavailableContent = 0;
  for (const document of resolution.documents) {
    /* v8 ignore next -- E05 rejects duplicate document paths before issuing a result */
    if (documentsByPath.has(document.path))
      return fail(
        CrossProfileComparisonErrorCode.invalidRelationship,
        "an issued resolution contains duplicate document paths",
      );
    documentsByPath.set(document.path, document);
    const state = scopeState(document);
    if (state === "conditional") conditional += 1;
    else if (state === "excluded") excluded += 1;
    else included += 1;
    if (
      document.contentSha256 === null ||
      document.contentState === "identity-only" ||
      document.contentState === "unavailable"
    )
      unavailableContent += 1;
  }
  const includedPaths = new Set(
    [...documentsByPath.values()]
      .filter((document) => scopeState(document) === "included")
      .map((document) => document.path),
  );
  const sequencePaths: RepositoryRelativePath[] = [];
  const sequenceSeen = new Set<string>();
  const byId = new Map(resolution.documents.map((document) => [document.id, document]));
  for (const id of resolution.sequence) {
    const document = byId.get(id);
    if (document === undefined || scopeState(document) !== "included") continue;
    /* v8 ignore next -- every E05 sequence is path-unique when issued */
    if (sequenceSeen.has(document.path))
      return fail(
        CrossProfileComparisonErrorCode.invalidRelationship,
        "an issued resolution repeats a document path in its sequence",
      );
    sequenceSeen.add(document.path);
    sequencePaths.push(document.path);
  }
  const summary = Object.freeze({
    ambiguityIds: Object.freeze(resolution.ambiguities.map((entry) => entry.id).sort(compareUtf8)),
    analysisStatus: resolution.analysisStatus,
    assemblySha256: resolution.assembly.sha256,
    assemblyState: resolution.assembly.state,
    clientVersion: resolution.clientVersion,
    counts: Object.freeze({ conditional, excluded, included, unavailableContent }),
    id: profileId(resolution),
    ordering: resolution.ordering,
    profileId: resolution.profileId,
    profileVersion: resolution.profileVersion,
    specSnapshotId: resolution.specSnapshotId,
    surfaceId: resolution.surfaceId,
  });
  return {
    documentsByPath,
    includedPaths,
    resolution,
    scopeComplete: !resolution.ambiguities.some((entry) => SCOPE_AMBIGUITY_KINDS.has(entry.kind)),
    sequencePaths: Object.freeze(sequencePaths),
    summary,
  };
}

function addEvidence(budget: ComparisonBudget, amount: number): void {
  budget.evidenceEntries += amount;
  if (budget.evidenceEntries > CROSS_PROFILE_COMPARISON_LIMITS.maximumPairEvidenceEntries)
    return fail(
      CrossProfileComparisonErrorCode.resourceLimit,
      "cross-profile comparison evidence exceeds its aggregate limit",
    );
}

function uniqueSorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareUtf8));
}

function stateAt(profile: ProfileProjection, path: RepositoryRelativePath): CrossProfileScopeState {
  const document = profile.documentsByPath.get(path);
  if (document !== undefined) return scopeState(document);
  return profile.scopeComplete ? "absent" : "unknown";
}

function compareScope(
  left: ProfileProjection,
  right: ProfileProjection,
  budget: ComparisonBudget,
): CrossProfileScopeComparison {
  const paths = uniqueSorted([
    ...left.documentsByPath.keys(),
    ...right.documentsByPath.keys(),
  ]) as readonly RepositoryRelativePath[];
  const differences: CrossProfileScopeDifference[] = [];
  const unknownPaths: RepositoryRelativePath[] = [];
  const reasons = new Set<string>();
  for (const path of paths) {
    const leftState = stateAt(left, path);
    const rightState = stateAt(right, path);
    if (leftState === "unknown") reasons.add("left-scope-incomplete");
    if (rightState === "unknown") reasons.add("right-scope-incomplete");
    if (leftState === "conditional" || rightState === "conditional")
      reasons.add("conditional-activation");
    if (
      leftState === "unknown" ||
      rightState === "unknown" ||
      leftState === "conditional" ||
      rightState === "conditional"
    ) {
      unknownPaths.push(path);
      continue;
    }
    if (leftState !== rightState) differences.push(Object.freeze({ leftState, path, rightState }));
  }
  addEvidence(budget, differences.length + unknownPaths.length);
  return Object.freeze({
    differences: Object.freeze(differences),
    reasonCodes: uniqueSorted(reasons),
    state: differences.length > 0 ? "different" : unknownPaths.length > 0 ? "unknown" : "same",
    unknownPaths: Object.freeze(unknownPaths),
  });
}

function compareOrdering(
  left: ProfileProjection,
  right: ProfileProjection,
  budget: ComparisonBudget,
): CrossProfileOrderComparison {
  const commonIncludedPaths = uniqueSorted(
    [...left.includedPaths].filter((path) => right.includedPaths.has(path)),
  ) as readonly RepositoryRelativePath[];
  const reasons = new Set<string>();
  if (commonIncludedPaths.length < 2) {
    reasons.add("fewer-than-two-common-included-paths");
    return Object.freeze({
      commonIncludedPaths,
      reasonCodes: uniqueSorted(reasons),
      state: "not-applicable",
      witness: null,
    });
  }
  if (left.resolution.ordering !== "total") reasons.add("left-order-not-total");
  if (right.resolution.ordering !== "total") reasons.add("right-order-not-total");
  const common = new Set(commonIncludedPaths);
  const leftSequence = left.sequencePaths.filter((path) => common.has(path));
  const rightSequence = right.sequencePaths.filter((path) => common.has(path));
  /* v8 ignore next -- total issued E05 sequences contain every included document exactly once */
  if (leftSequence.length !== common.size) reasons.add("left-sequence-incomplete");
  /* v8 ignore next -- total issued E05 sequences contain every included document exactly once */
  if (rightSequence.length !== common.size) reasons.add("right-sequence-incomplete");
  if (reasons.size > 0) {
    addEvidence(budget, commonIncludedPaths.length);
    return Object.freeze({
      commonIncludedPaths,
      reasonCodes: uniqueSorted(reasons),
      state: "unknown",
      witness: null,
    });
  }
  const rightRank = new Map(rightSequence.map((path, index) => [path, index]));
  let maximumRank = -1;
  let maximumPath: RepositoryRelativePath | null = null;
  let witness: CrossProfileOrderWitness | null = null;
  for (const path of leftSequence) {
    const rank = rightRank.get(path);
    /* v8 ignore next -- complete common sequences guarantee the rank */
    if (rank === undefined)
      return fail(
        CrossProfileComparisonErrorCode.invalidRelationship,
        "complete comparison sequence is missing a shared path",
      );
    if (rank < maximumRank && maximumPath !== null) {
      witness = Object.freeze({
        firstPath: maximumPath,
        leftRelation: "before",
        rightRelation: "after",
        secondPath: path,
      });
      break;
    }
    maximumRank = rank;
    maximumPath = path;
  }
  addEvidence(budget, commonIncludedPaths.length + (witness === null ? 0 : 1));
  return Object.freeze({
    commonIncludedPaths,
    reasonCodes: Object.freeze([]),
    state: witness === null ? "same" : "different",
    witness,
  });
}

function contentKnown(document: EffectiveContextDocument): boolean {
  return (
    document.contentSha256 !== null &&
    document.contentState !== "identity-only" &&
    document.contentState !== "unavailable" &&
    document.truncation !== "unknown"
  );
}

function compareContent(
  left: ProfileProjection,
  right: ProfileProjection,
  budget: ComparisonBudget,
): CrossProfileContentComparison {
  const commonIncludedPaths = uniqueSorted(
    [...left.includedPaths].filter((path) => right.includedPaths.has(path)),
  ) as readonly RepositoryRelativePath[];
  if (commonIncludedPaths.length === 0)
    return Object.freeze({
      differences: Object.freeze([]),
      matchingPaths: Object.freeze([]),
      reasonCodes: Object.freeze(["no-common-included-paths"]),
      state: "not-applicable",
      unknownPaths: Object.freeze([]),
    });
  const differences: CrossProfileContentDifference[] = [];
  const matchingPaths: RepositoryRelativePath[] = [];
  const unknownPaths: RepositoryRelativePath[] = [];
  const reasons = new Set<string>();
  for (const path of commonIncludedPaths) {
    const leftDocument = left.documentsByPath.get(path);
    const rightDocument = right.documentsByPath.get(path);
    /* v8 ignore next -- the path came from both included sets */
    if (leftDocument === undefined || rightDocument === undefined)
      return fail(
        CrossProfileComparisonErrorCode.invalidRelationship,
        "included path is missing its source document",
      );
    if (!contentKnown(leftDocument) || !contentKnown(rightDocument)) {
      unknownPaths.push(path);
      if (!contentKnown(leftDocument)) reasons.add("left-content-incomplete");
      if (!contentKnown(rightDocument)) reasons.add("right-content-incomplete");
      continue;
    }
    const leftDigest = leftDocument.contentSha256;
    const rightDigest = rightDocument.contentSha256;
    /* v8 ignore next -- contentKnown proves both digests */
    if (leftDigest === null || rightDigest === null) continue;
    if (leftDigest !== rightDigest) {
      differences.push(Object.freeze({ leftSha256: leftDigest, path, rightSha256: rightDigest }));
      continue;
    }
    if (leftDocument.truncation === "prefix" || rightDocument.truncation === "prefix") {
      unknownPaths.push(path);
      reasons.add("truncated-content-prefix");
      continue;
    }
    matchingPaths.push(path);
  }
  addEvidence(budget, differences.length + matchingPaths.length + unknownPaths.length);
  return Object.freeze({
    differences: Object.freeze(differences),
    matchingPaths: Object.freeze(matchingPaths),
    reasonCodes: uniqueSorted(reasons),
    state: differences.length > 0 ? "different" : unknownPaths.length > 0 ? "unknown" : "same",
    unknownPaths: Object.freeze(unknownPaths),
  });
}

function pairComparison(
  left: ProfileProjection,
  right: ProfileProjection,
  targetPath: RepositoryRelativePath,
  budget: ComparisonBudget,
): CrossProfilePairComparison {
  const scope = compareScope(left, right, budget);
  const ordering = compareOrdering(left, right, budget);
  const content = compareContent(left, right, budget);
  const states = [scope.state, ordering.state, content.state];
  const overall = states.includes("different")
    ? "divergent"
    : states.includes("unknown")
      ? "indeterminate"
      : "observational-match";
  return Object.freeze({
    content,
    equivalenceClaim: false,
    id: `comparison-pair:${hash(left.summary.id, right.summary.id, targetPath).slice(0, 32)}`,
    leftProfileId: left.summary.id,
    ordering,
    overall,
    rightProfileId: right.summary.id,
    scope,
    semanticRelation:
      left.resolution.profileId === right.resolution.profileId
        ? "distinct-surface-contracts"
        : "incompatible-profile-contracts",
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    /* v8 ignore next -- E07 constructs only own data fields in its output graph */
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

/**
 * Compare E05 observations without inventing a shared activation, precedence, or semantic model.
 * A mechanical observational match is deliberately not an equivalence claim.
 */
export function compareEffectiveContexts(
  input: CompareEffectiveContextsInput,
): CrossProfileComparison {
  const record = inputRecord(input);
  if (
    property(record, "contractVersion", "comparison input") !==
    CROSS_PROFILE_COMPARISON_CONTRACT_VERSION
  )
    return fail(
      CrossProfileComparisonErrorCode.invalidInput,
      "comparison contract version is unsupported",
    );
  if (
    property(record, "recordKind", "comparison input") !==
    CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND
  )
    return fail(
      CrossProfileComparisonErrorCode.invalidInput,
      "comparison input record kind is unsupported",
    );
  const resolutions = resolutionArray(property(record, "resolutions", "comparison input"));
  const targetPath = resolutions[0]?.targetPath;
  /* v8 ignore next -- resolutionArray requires at least two entries */
  if (targetPath === undefined)
    return fail(CrossProfileComparisonErrorCode.invalidRelationship, "comparison target is absent");
  if (resolutions.some((resolution) => resolution.targetPath !== targetPath))
    return fail(
      CrossProfileComparisonErrorCode.invalidRelationship,
      "cross-profile resolutions must describe one exact target path",
    );
  const surfaceKeys = resolutions.map(
    (resolution) => `${resolution.profileId}\u0000${resolution.surfaceId}`,
  );
  if (new Set(surfaceKeys).size !== surfaceKeys.length)
    return fail(
      CrossProfileComparisonErrorCode.invalidRelationship,
      "cross-profile resolutions must use distinct profile/surface contracts",
    );
  const aggregateDocuments = resolutions.reduce(
    (sum, resolution) => sum + resolution.documents.length,
    0,
  );
  const aggregateAmbiguities = resolutions.reduce(
    (sum, resolution) => sum + resolution.ambiguities.length,
    0,
  );
  if (aggregateDocuments > CROSS_PROFILE_COMPARISON_LIMITS.maximumAggregateDocuments)
    return fail(
      CrossProfileComparisonErrorCode.resourceLimit,
      "comparison documents exceed their aggregate limit",
    );
  if (aggregateAmbiguities > CROSS_PROFILE_COMPARISON_LIMITS.maximumAggregateAmbiguities)
    return fail(
      CrossProfileComparisonErrorCode.resourceLimit,
      "comparison ambiguities exceed their aggregate limit",
    );
  const pairWork = aggregateDocuments * (resolutions.length - 1);
  if (pairWork > CROSS_PROFILE_COMPARISON_LIMITS.maximumPairWork)
    return fail(
      CrossProfileComparisonErrorCode.resourceLimit,
      "comparison pair work exceeds its limit",
    );
  const profiles = resolutions
    .map(projectProfile)
    .sort((left, right) => compareUtf8(left.summary.id, right.summary.id));
  const budget: ComparisonBudget = { evidenceEntries: 0 };
  const pairs: CrossProfilePairComparison[] = [];
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1)
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex];
      const right = profiles[rightIndex];
      /* v8 ignore next -- loop indices are bounded by the profile array */
      if (left === undefined || right === undefined) continue;
      pairs.push(pairComparison(left, right, targetPath, budget));
    }
  const output: CrossProfileComparison = {
    analysisStatus:
      resolutions.some((resolution) => resolution.analysisStatus === "partial") ||
      pairs.some(
        (pair) =>
          pair.scope.state === "unknown" ||
          pair.ordering.state === "unknown" ||
          pair.content.state === "unknown",
      )
        ? "partial"
        : "complete",
    contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
    pairs,
    profiles: profiles.map((profile) => profile.summary),
    recordKind: CROSS_PROFILE_COMPARISON_RECORD_KIND,
    targetPath,
  };
  const frozen = deepFreeze(output);
  ISSUED_CROSS_PROFILE_COMPARISONS.add(frozen);
  return frozen;
}
