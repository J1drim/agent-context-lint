import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { EfficiencyComponentKey } from "@agent-context/core";

import type { ContextEfficiencyMetrics } from "./context-efficiency-metrics.js";
import { isIssuedContextEfficiencyMetrics } from "./context-efficiency-metrics.js";
import type {
  ContextEfficiencyRecommendations,
  EfficiencyRecommendationProfileIdentity,
} from "./context-efficiency-recommendations.js";
import { isIssuedContextEfficiencyRecommendations } from "./context-efficiency-recommendations.js";
import type { ContextEfficiencyScore } from "./context-efficiency-score.js";
import { isIssuedContextEfficiencyScore } from "./context-efficiency-score.js";
import { compareTokenizerIdentities } from "./tokenizer-contract.js";
import type { TokenizerIdentity } from "./tokenizer-contract.js";

export const CONTEXT_EFFICIENCY_REPORT_SCHEMA_VERSION = "1.0.0" as const;
export const CONTEXT_EFFICIENCY_REPORT_RECORD_KIND = "agent-context-efficiency-report" as const;
export const CONTEXT_EFFICIENCY_COMPARISON_RECORD_KIND =
  "agent-context-efficiency-comparison" as const;

export const CONTEXT_EFFICIENCY_REPORT_LIMITS: Readonly<{
  maximumJsonBytes: number;
  maximumOutputChunkBytes: number;
  maximumTerminalBytes: number;
  maximumTerminalWidth: number;
  minimumTerminalWidth: number;
}> = Object.freeze({
  maximumJsonBytes: 64 * 1_024 * 1_024,
  maximumOutputChunkBytes: 64 * 1_024,
  maximumTerminalBytes: 4 * 1_024 * 1_024,
  maximumTerminalWidth: 240,
  minimumTerminalWidth: 40,
} as const);

export interface EfficiencyReportScope {
  readonly kind: "repository";
  readonly targetPath: null;
}

export interface EfficiencyReportTokenStatistics {
  readonly maximum: number;
  readonly minimum: number;
  readonly p50: number;
  readonly p95: number;
}

export interface EfficiencyReportProfile {
  readonly clientVersion: string | null;
  readonly completeSampleCount: number;
  readonly effectiveTokens: EfficiencyReportTokenStatistics | null;
  readonly key: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly sampleCount: number;
  readonly samplingState: "complete" | "partial";
  readonly samplingStrategy: "exhaustive" | "stratified";
  readonly specSnapshotId: string;
  readonly state: "complete" | "empty" | "partial";
  readonly surfaceId: string;
  readonly alwaysOnTokens: EfficiencyReportTokenStatistics | null;
}

export interface ContextEfficiencyReport {
  readonly profiles: readonly EfficiencyReportProfile[];
  readonly qualityClaim: false;
  readonly recommendations: ContextEfficiencyRecommendations;
  readonly recordKind: typeof CONTEXT_EFFICIENCY_REPORT_RECORD_KIND;
  readonly schemaVersion: typeof CONTEXT_EFFICIENCY_REPORT_SCHEMA_VERSION;
  readonly scope: EfficiencyReportScope;
  readonly score: ContextEfficiencyScore;
  readonly semanticQualityPreservationClaim: false;
  readonly source: {
    readonly configurationSha256: string;
    readonly metricsContractVersion: string;
    readonly metricsSha256: string;
    readonly recommendationsContractVersion: string;
    readonly scoreContractVersion: string;
    readonly scoreSpecificationSha256: string;
    readonly scoreVersion: string;
  };
  readonly state: "complete" | "partial" | "unavailable";
  readonly tokenizer: TokenizerIdentity;
}

export interface EfficiencyComparisonValue {
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
}

export interface EfficiencyComparisonProfile {
  readonly effectiveMaximum: EfficiencyComparisonValue;
  readonly effectiveP50: EfficiencyComparisonValue;
  readonly effectiveP95: EfficiencyComparisonValue;
  readonly key: string;
  readonly alwaysOnP50: EfficiencyComparisonValue;
}

export interface ContextEfficiencyComparison {
  readonly baseline: {
    readonly metricsSha256: string;
    readonly recommendationCount: number;
    readonly score: number | null;
    readonly state: ContextEfficiencyReport["state"];
  };
  readonly candidate: {
    readonly metricsSha256: string;
    readonly recommendationCount: number;
    readonly score: number | null;
    readonly state: ContextEfficiencyReport["state"];
  };
  readonly caveatCodes: readonly [
    "quality-not-empirically-verified",
    "semantic-equivalence-not-proven",
    "static-analysis-only",
  ];
  readonly components: readonly {
    readonly id: EfficiencyComponentKey;
    readonly score: EfficiencyComparisonValue;
  }[];
  readonly profiles: readonly EfficiencyComparisonProfile[];
  readonly qualityClaim: false;
  readonly recordKind: typeof CONTEXT_EFFICIENCY_COMPARISON_RECORD_KIND;
  readonly schemaVersion: typeof CONTEXT_EFFICIENCY_REPORT_SCHEMA_VERSION;
  readonly scope: EfficiencyReportScope;
  readonly score: EfficiencyComparisonValue;
  readonly semanticQualityPreservationClaim: false;
  readonly sourceCompatibility: {
    readonly configurationSha256: string;
    readonly profileIdentitySha256: string;
    readonly scoreSpecificationSha256: string;
    readonly scoreVersion: string;
  };
  readonly tokenizer: TokenizerIdentity;
}

export interface CreateContextEfficiencyReportInput {
  readonly metrics: ContextEfficiencyMetrics;
  readonly recommendations: ContextEfficiencyRecommendations;
  readonly scope: EfficiencyReportScope;
  readonly score: ContextEfficiencyScore;
}

export interface CompareContextEfficiencyReportsInput {
  readonly baseline: ContextEfficiencyReport;
  readonly candidate: ContextEfficiencyReport;
}

export interface EfficiencyReportTerminalOptions {
  readonly colorMode?: "ansi" | "never";
  readonly width?: number;
}

export interface EfficiencyReportWriteOptions {
  readonly signal?: AbortSignal;
}

export interface EfficiencyReportSink {
  readonly write: (text: string, signal: AbortSignal | undefined) => Promise<void> | void;
}

export const ContextEfficiencyReportErrorCode: Readonly<{
  cancelled: "CONTEXT_EFFICIENCY_REPORT_CANCELLED";
  incompatible: "CONTEXT_EFFICIENCY_REPORT_INCOMPATIBLE";
  invalidInput: "CONTEXT_EFFICIENCY_REPORT_INVALID_INPUT";
  outputFailed: "CONTEXT_EFFICIENCY_REPORT_OUTPUT_FAILED";
  resourceLimit: "CONTEXT_EFFICIENCY_REPORT_RESOURCE_LIMIT";
}> = Object.freeze({
  cancelled: "CONTEXT_EFFICIENCY_REPORT_CANCELLED",
  incompatible: "CONTEXT_EFFICIENCY_REPORT_INCOMPATIBLE",
  invalidInput: "CONTEXT_EFFICIENCY_REPORT_INVALID_INPUT",
  outputFailed: "CONTEXT_EFFICIENCY_REPORT_OUTPUT_FAILED",
  resourceLimit: "CONTEXT_EFFICIENCY_REPORT_RESOURCE_LIMIT",
} as const);

export type ContextEfficiencyReportErrorCode =
  (typeof ContextEfficiencyReportErrorCode)[keyof typeof ContextEfficiencyReportErrorCode];

export class ContextEfficiencyReportError extends Error {
  readonly code: ContextEfficiencyReportErrorCode;
  override readonly name = "ContextEfficiencyReportError" as const;

  constructor(code: ContextEfficiencyReportErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

const ISSUED_REPORTS = new WeakSet<object>();
const ISSUED_COMPARISONS = new WeakSet<object>();
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const INPUT_KEYS = ["metrics", "recommendations", "scope", "score"] as const;
const COMPARISON_KEYS = ["baseline", "candidate"] as const;
const SCOPE_KEYS = ["kind", "targetPath"] as const;
const TERMINAL_OPTION_KEYS = ["colorMode", "width"] as const;
const WRITE_OPTION_KEYS = ["signal"] as const;
const SINK_KEYS = ["write"] as const;
// Capture the native brand-checking accessor before any untrusted value is inspected.
// eslint-disable-next-line @typescript-eslint/unbound-method
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const ADD_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "addEventListener",
)?.value as (...arguments_: readonly unknown[]) => unknown;
const REMOVE_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "removeEventListener",
)?.value as (...arguments_: readonly unknown[]) => unknown;

type DataRecord = Readonly<Record<string, unknown>>;
type ReportDocument = ContextEfficiencyComparison | ContextEfficiencyReport;

function fail(code: ContextEfficiencyReportErrorCode, message: string): never {
  throw new ContextEfficiencyReportError(code, message);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
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
    return fail(ContextEfficiencyReportErrorCode.invalidInput, `${label} must be a plain record`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  const actual = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail(ContextEfficiencyReportErrorCode.invalidInput, `${label} has unexpected fields`);
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(ContextEfficiencyReportErrorCode.invalidInput, `${label}.${key} must be data`);
  }
  return value as DataRecord;
}

function partialDataRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return fail(ContextEfficiencyReportErrorCode.invalidInput, `${label} must be a plain record`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  const actual = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail(ContextEfficiencyReportErrorCode.invalidInput, `${label} has unexpected fields`);
  for (const key of actual) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        ContextEfficiencyReportErrorCode.invalidInput,
        `${label}.${String(key)} must be data`,
      );
  }
  return value as DataRecord;
}

function property(record: DataRecord, key: string): unknown {
  return Reflect.getOwnPropertyDescriptor(record, key)?.value;
}

function scope(value: unknown): EfficiencyReportScope {
  const record = dataRecord(value, SCOPE_KEYS, "scope");
  const kind = property(record, "kind");
  const targetPath = property(record, "targetPath");
  if (kind !== "repository" || targetPath !== null)
    return fail(
      ContextEfficiencyReportErrorCode.invalidInput,
      "v1 reports require repository scope",
    );
  return Object.freeze({ kind, targetPath });
}

function sameTokenizer(left: TokenizerIdentity, right: TokenizerIdentity): boolean {
  return compareTokenizerIdentities(left, right).compatible;
}

function assertSha256(value: string, label: string): void {
  if (!HEX_SHA256.test(value))
    fail(ContextEfficiencyReportErrorCode.invalidInput, `${label} is invalid`);
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function profileKey(profile: Omit<EfficiencyRecommendationProfileIdentity, "key">): string {
  return [
    profile.profileId,
    profile.surfaceId,
    profile.profileVersion,
    profile.specSnapshotId,
    profile.clientVersion ?? "<null>",
  ]
    .map((part) => `${String(Buffer.byteLength(part, "utf8"))}:${part}`)
    .join("|");
}

function statistics(values: readonly number[]): EfficiencyReportTokenStatistics | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const present = (value: number | undefined): number => {
    /* v8 ignore next -- non-empty input and nearest-rank indices prove these values exist */
    if (value === undefined)
      return fail(ContextEfficiencyReportErrorCode.invalidInput, "profile statistic is absent");
    return value;
  };
  const at = (rank: number): number => {
    return present(sorted[Math.ceil((sorted.length * rank) / 100) - 1]);
  };
  return Object.freeze({
    maximum: present(sorted.at(-1)),
    minimum: present(sorted[0]),
    p50: at(50),
    p95: at(95),
  });
}

function reportProfiles(metrics: ContextEfficiencyMetrics): readonly EfficiencyReportProfile[] {
  const keys = new Map(
    metrics.broadScope.map((entry) => [profileKey(entry.profile), entry.profile.key]),
  );
  const profiles = metrics.distributions.map((distribution): EfficiencyReportProfile => {
    const key = keys.get(profileKey(distribution.profile));
    if (key === undefined)
      return fail(ContextEfficiencyReportErrorCode.invalidInput, "profile identity is incomplete");
    const included = distribution.targets.filter((target) => target.includedInStatistics);
    return Object.freeze({
      alwaysOnTokens: statistics(included.map((target) => target.alwaysOnTokens)),
      clientVersion: distribution.profile.clientVersion,
      completeSampleCount: distribution.completeSampleCount,
      effectiveTokens:
        distribution.statistics === null
          ? null
          : Object.freeze({
              maximum: distribution.statistics.maximum,
              minimum: distribution.statistics.minimum,
              p50: distribution.statistics.p50,
              p95: distribution.statistics.p95,
            }),
      key,
      profileId: distribution.profile.profileId,
      profileVersion: distribution.profile.profileVersion,
      sampleCount: distribution.sampleCount,
      samplingState: distribution.sampling.state,
      samplingStrategy: distribution.sampling.strategy,
      specSnapshotId: distribution.profile.specSnapshotId,
      state: distribution.state,
      surfaceId: distribution.profile.surfaceId,
    });
  });
  profiles.sort((left, right) => compareUtf8(left.key, right.key));
  for (let index = 1; index < profiles.length; index += 1)
    if (profiles[index - 1]?.key === profiles[index]?.key)
      return fail(
        ContextEfficiencyReportErrorCode.invalidInput,
        "profile identities are duplicate",
      );
  return Object.freeze(profiles);
}

function assertRecommendationProfiles(
  recommendations: ContextEfficiencyRecommendations,
  profiles: readonly EfficiencyReportProfile[],
): void {
  const known = new Set(profiles.map((profile) => profile.key));
  for (const evaluation of recommendations.evaluations)
    for (const profile of evaluation.profiles)
      if (!known.has(profile.key) || profile.key !== profileKey(profile))
        fail(
          ContextEfficiencyReportErrorCode.invalidInput,
          "recommendation profile identity is not present in metrics",
        );
}

/** Build a report only from same-process G05/G07/G08 evidence and preserve absent values. */
export function createContextEfficiencyReport(inputValue: unknown): ContextEfficiencyReport {
  const input = dataRecord(inputValue, INPUT_KEYS, "input");
  const metricsValue = property(input, "metrics");
  const scoreValue = property(input, "score");
  const recommendationsValue = property(input, "recommendations");
  if (!isIssuedContextEfficiencyMetrics(metricsValue))
    return fail(ContextEfficiencyReportErrorCode.invalidInput, "metrics are not issued by G05");
  if (!isIssuedContextEfficiencyScore(scoreValue))
    return fail(ContextEfficiencyReportErrorCode.invalidInput, "score is not issued by G07");
  if (!isIssuedContextEfficiencyRecommendations(recommendationsValue))
    return fail(
      ContextEfficiencyReportErrorCode.invalidInput,
      "recommendations are not issued by G08",
    );
  const metrics = metricsValue;
  const scoreValueIssued = scoreValue;
  const recommendations = recommendationsValue;
  const normalizedScope = scope(property(input, "scope"));
  if (
    !sameTokenizer(metrics.tokenizer, scoreValueIssued.tokenizer) ||
    !sameTokenizer(metrics.tokenizer, recommendations.tokenizer)
  )
    return fail(ContextEfficiencyReportErrorCode.incompatible, "tokenizer identities differ");
  if (
    scoreValueIssued.identities.metricsSha256 !== sha256Json(metrics) ||
    recommendations.identities.configurationSha256 !==
      scoreValueIssued.identities.configurationSha256 ||
    recommendations.identities.metricsSha256 !== scoreValueIssued.identities.metricsSha256 ||
    recommendations.identities.scoreSpecificationSha256 !==
      scoreValueIssued.identities.specificationSha256 ||
    recommendations.identities.scoreVersion !== scoreValueIssued.configuration.scoreVersion
  )
    return fail(ContextEfficiencyReportErrorCode.incompatible, "source identities differ");
  for (const [label, digest] of Object.entries(scoreValueIssued.identities))
    assertSha256(digest, `score.identities.${label}`);
  const profiles = reportProfiles(metrics);
  assertRecommendationProfiles(recommendations, profiles);
  const report = deepFreeze({
    profiles,
    qualityClaim: false as const,
    recommendations,
    recordKind: CONTEXT_EFFICIENCY_REPORT_RECORD_KIND,
    schemaVersion: CONTEXT_EFFICIENCY_REPORT_SCHEMA_VERSION,
    scope: normalizedScope,
    score: scoreValueIssued,
    semanticQualityPreservationClaim: false as const,
    source: {
      configurationSha256: scoreValueIssued.identities.configurationSha256,
      metricsContractVersion: metrics.contractVersion,
      metricsSha256: scoreValueIssued.identities.metricsSha256,
      recommendationsContractVersion: recommendations.contractVersion,
      scoreContractVersion: scoreValueIssued.contractVersion,
      scoreSpecificationSha256: scoreValueIssued.identities.specificationSha256,
      scoreVersion: scoreValueIssued.configuration.scoreVersion,
    },
    state:
      scoreValueIssued.state === "unavailable"
        ? ("unavailable" as const)
        : metrics.state === "partial" || recommendations.state === "partial"
          ? ("partial" as const)
          : ("complete" as const),
    tokenizer: metrics.tokenizer,
  });
  ISSUED_REPORTS.add(report);
  return report;
}

export function isIssuedContextEfficiencyReport(value: unknown): value is ContextEfficiencyReport {
  return typeof value === "object" && value !== null && ISSUED_REPORTS.has(value);
}

function value(baseline: number | null, candidate: number | null): EfficiencyComparisonValue {
  return Object.freeze({
    baseline,
    candidate,
    delta: baseline === null || candidate === null ? null : candidate - baseline,
  });
}

function profileIdentityDocument(profiles: readonly EfficiencyReportProfile[]): unknown {
  return profiles.map((profile) => ({
    clientVersion: profile.clientVersion,
    key: profile.key,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    specSnapshotId: profile.specSnapshotId,
    surfaceId: profile.surfaceId,
  }));
}

function sha256Canonical(value: unknown): string {
  const crypto = createHash("sha256");
  for (const token of jsonTokens(value)) crypto.update(token, "utf8");
  return crypto.digest("hex");
}

function identityJson(value: unknown): string {
  return [...jsonTokens(value)].join("");
}

/** Compare only reports whose scoring, tokenizer, scope, and complete profile identities match. */
export function compareContextEfficiencyReports(inputValue: unknown): ContextEfficiencyComparison {
  const input = dataRecord(inputValue, COMPARISON_KEYS, "input");
  const baselineValue = property(input, "baseline");
  const candidateValue = property(input, "candidate");
  if (
    !isIssuedContextEfficiencyReport(baselineValue) ||
    !isIssuedContextEfficiencyReport(candidateValue)
  )
    return fail(
      ContextEfficiencyReportErrorCode.invalidInput,
      "comparison inputs must be issued reports",
    );
  const baseline = baselineValue;
  const candidate = candidateValue;
  const baselineProfiles = identityJson(profileIdentityDocument(baseline.profiles));
  const candidateProfiles = identityJson(profileIdentityDocument(candidate.profiles));
  if (
    !sameTokenizer(baseline.tokenizer, candidate.tokenizer) ||
    baseline.source.configurationSha256 !== candidate.source.configurationSha256 ||
    baseline.source.scoreSpecificationSha256 !== candidate.source.scoreSpecificationSha256 ||
    baseline.source.scoreVersion !== candidate.source.scoreVersion ||
    baseline.source.metricsContractVersion !== candidate.source.metricsContractVersion ||
    baseline.source.scoreContractVersion !== candidate.source.scoreContractVersion ||
    baseline.source.recommendationsContractVersion !==
      candidate.source.recommendationsContractVersion ||
    baselineProfiles !== candidateProfiles
  )
    return fail(
      ContextEfficiencyReportErrorCode.incompatible,
      "reports use incompatible scope, configuration, specification, tokenizer, or profile identities",
    );
  const profiles = Object.freeze(
    baseline.profiles.map((baselineProfile, index): EfficiencyComparisonProfile => {
      const candidateProfile = candidate.profiles[index];
      if (candidateProfile === undefined)
        return fail(ContextEfficiencyReportErrorCode.incompatible, "candidate profile is missing");
      return Object.freeze({
        alwaysOnP50: value(
          baselineProfile.alwaysOnTokens?.p50 ?? null,
          candidateProfile.alwaysOnTokens?.p50 ?? null,
        ),
        effectiveMaximum: value(
          baselineProfile.effectiveTokens?.maximum ?? null,
          candidateProfile.effectiveTokens?.maximum ?? null,
        ),
        effectiveP50: value(
          baselineProfile.effectiveTokens?.p50 ?? null,
          candidateProfile.effectiveTokens?.p50 ?? null,
        ),
        effectiveP95: value(
          baselineProfile.effectiveTokens?.p95 ?? null,
          candidateProfile.effectiveTokens?.p95 ?? null,
        ),
        key: baselineProfile.key,
      });
    }),
  );
  const candidateComponents = new Map(candidate.score.components.map((entry) => [entry.id, entry]));
  const components = Object.freeze(
    baseline.score.components.map((entry) => {
      const candidateEntry = candidateComponents.get(entry.id);
      if (candidateEntry === undefined)
        return fail(ContextEfficiencyReportErrorCode.incompatible, "score component is missing");
      return Object.freeze({
        id: entry.id,
        score: value(entry.score, candidateEntry.score),
      });
    }),
  );
  const comparison = deepFreeze({
    baseline: {
      metricsSha256: baseline.source.metricsSha256,
      recommendationCount: baseline.recommendations.recommendations.length,
      score: baseline.score.score,
      state: baseline.state,
    },
    candidate: {
      metricsSha256: candidate.source.metricsSha256,
      recommendationCount: candidate.recommendations.recommendations.length,
      score: candidate.score.score,
      state: candidate.state,
    },
    caveatCodes: [
      "quality-not-empirically-verified",
      "semantic-equivalence-not-proven",
      "static-analysis-only",
    ] as const,
    components,
    profiles,
    qualityClaim: false as const,
    recordKind: CONTEXT_EFFICIENCY_COMPARISON_RECORD_KIND,
    schemaVersion: CONTEXT_EFFICIENCY_REPORT_SCHEMA_VERSION,
    scope: baseline.scope,
    score: value(baseline.score.score, candidate.score.score),
    semanticQualityPreservationClaim: false as const,
    sourceCompatibility: {
      configurationSha256: baseline.source.configurationSha256,
      profileIdentitySha256: sha256Canonical(profileIdentityDocument(baseline.profiles)),
      scoreSpecificationSha256: baseline.source.scoreSpecificationSha256,
      scoreVersion: baseline.source.scoreVersion,
    },
    tokenizer: baseline.tokenizer,
  });
  ISSUED_COMPARISONS.add(comparison);
  return comparison;
}

export function isIssuedContextEfficiencyComparison(
  value: unknown,
): value is ContextEfficiencyComparison {
  return typeof value === "object" && value !== null && ISSUED_COMPARISONS.has(value);
}

function* jsonTokens(value: unknown): Generator<string> {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    yield JSON.stringify(value);
    return;
  }
  if (typeof value === "string") {
    yield JSON.stringify(value);
    return;
  }
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) yield ",";
      yield* jsonTokens(value[index]);
    }
    yield "]";
    return;
  }
  if (typeof value !== "object")
    return fail(ContextEfficiencyReportErrorCode.invalidInput, "report contains a non-JSON value");
  yield "{";
  const keys = Object.keys(value).sort(compareUtf8);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      return fail(ContextEfficiencyReportErrorCode.invalidInput, "report contains an accessor");
    if (index > 0) yield ",";
    yield JSON.stringify(key);
    yield ":";
    yield* jsonTokens(descriptor.value);
  }
  yield "}";
}

function reportDocument(value: unknown): ReportDocument {
  if (isIssuedContextEfficiencyReport(value) || isIssuedContextEfficiencyComparison(value))
    return value;
  return fail(ContextEfficiencyReportErrorCode.invalidInput, "value is not an issued report");
}

function jsonByteLength(value: ReportDocument): number {
  let bytes = 1;
  for (const token of jsonTokens(value)) {
    bytes += Buffer.byteLength(token, "utf8");
    if (bytes > CONTEXT_EFFICIENCY_REPORT_LIMITS.maximumJsonBytes)
      return fail(ContextEfficiencyReportErrorCode.resourceLimit, "JSON output exceeds its limit");
  }
  return bytes;
}

/** Canonical UTF-8 JSON with recursively sorted object keys and one trailing LF. */
export function serializeContextEfficiencyJson(value: unknown): string {
  const report = reportDocument(value);
  jsonByteLength(report);
  return `${[...jsonTokens(report)].join("")}\n`;
}

function aborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (nodeTypes.isProxy(signal) || ABORTED_GETTER === undefined)
    return fail(ContextEfficiencyReportErrorCode.invalidInput, "signal is invalid");
  try {
    return ABORTED_GETTER.call(signal) !== false;
  } catch {
    return fail(ContextEfficiencyReportErrorCode.invalidInput, "signal is invalid");
  }
}

function writeOptions(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  const options = partialDataRecord(value, WRITE_OPTION_KEYS, "options");
  const signal = property(options, "signal");
  if (signal !== undefined) aborted(signal as AbortSignal);
  return signal as AbortSignal | undefined;
}

function sink(value: unknown): EfficiencyReportSink["write"] {
  const output = dataRecord(value, SINK_KEYS, "sink");
  const write = property(output, "write");
  if (typeof write !== "function" || nodeTypes.isProxy(write))
    return fail(ContextEfficiencyReportErrorCode.invalidInput, "sink.write is invalid");
  return write as EfficiencyReportSink["write"];
}

async function awaitWrite(
  operation: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    try {
      await operation;
      return;
    } catch {
      return fail(ContextEfficiencyReportErrorCode.outputFailed, "output sink failed");
    }
  }
  if (aborted(signal)) return fail(ContextEfficiencyReportErrorCode.cancelled, "report cancelled");
  let abort = (): void => undefined;
  const cancelled = new Promise<"cancelled">((resolve) => {
    abort = (): void => {
      resolve("cancelled");
    };
  });
  Reflect.apply(ADD_EVENT_LISTENER, signal, ["abort", abort, { once: true }]);
  try {
    const result = await Promise.race([
      operation.then<"written", "failed">(
        () => "written",
        () => "failed",
      ),
      cancelled,
    ]);
    if (result === "cancelled")
      return fail(ContextEfficiencyReportErrorCode.cancelled, "report cancelled");
    if (result === "failed")
      return fail(ContextEfficiencyReportErrorCode.outputFailed, "output sink failed");
  } finally {
    Reflect.apply(REMOVE_EVENT_LISTENER, signal, ["abort", abort]);
  }
}

/** Preflight the byte limit, then write sequential chunks while honoring sink backpressure. */
export async function writeContextEfficiencyJson(
  value: unknown,
  sinkValue: unknown,
  optionsValue?: unknown,
): Promise<void> {
  const report = reportDocument(value);
  const write = sink(sinkValue);
  const signal = writeOptions(optionsValue);
  if (aborted(signal)) return fail(ContextEfficiencyReportErrorCode.cancelled, "report cancelled");
  jsonByteLength(report);
  let pending = "";
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const text = pending;
    pending = "";
    let operation: Promise<void>;
    try {
      operation = Promise.resolve(Reflect.apply(write, undefined, [text, signal]));
    } catch {
      return fail(ContextEfficiencyReportErrorCode.outputFailed, "output sink failed");
    }
    await awaitWrite(operation, signal);
  };
  for (const token of jsonTokens(report)) {
    if (aborted(signal))
      return fail(ContextEfficiencyReportErrorCode.cancelled, "report cancelled");
    if (
      Buffer.byteLength(pending, "utf8") + Buffer.byteLength(token, "utf8") >
        CONTEXT_EFFICIENCY_REPORT_LIMITS.maximumOutputChunkBytes &&
      pending.length > 0
    )
      await flush();
    pending += token;
  }
  pending += "\n";
  await flush();
}

function terminalOptions(value: unknown): Required<EfficiencyReportTerminalOptions> {
  if (value === undefined) return Object.freeze({ colorMode: "never", width: 80 });
  const options = partialDataRecord(value, TERMINAL_OPTION_KEYS, "options");
  const colorMode = property(options, "colorMode");
  const width = property(options, "width");
  if (colorMode !== undefined && colorMode !== "ansi" && colorMode !== "never")
    return fail(ContextEfficiencyReportErrorCode.invalidInput, "color mode is invalid");
  if (
    width !== undefined &&
    (typeof width !== "number" ||
      !Number.isSafeInteger(width) ||
      width < CONTEXT_EFFICIENCY_REPORT_LIMITS.minimumTerminalWidth ||
      width > CONTEXT_EFFICIENCY_REPORT_LIMITS.maximumTerminalWidth)
  )
    return fail(ContextEfficiencyReportErrorCode.invalidInput, "terminal width is invalid");
  return Object.freeze({
    colorMode: colorMode ?? "never",
    width: width ?? 80,
  });
}

function safeScalar(scalar: string): string {
  const codePoint = scalar.codePointAt(0) ?? 0;
  if (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
    return "?";
  return scalar;
}

function scalarWidth(scalar: string): number {
  return (scalar.codePointAt(0) ?? 0) <= 0x7e ? 1 : 2;
}

function safeText(value: string): string {
  return Array.from(value, safeScalar).join("");
}

function wrap(text: string, width: number): readonly string[] {
  const scalars = Array.from(safeText(text));
  const lines: string[] = [];
  let line = "";
  let columns = 0;
  for (const scalar of scalars) {
    const scalarColumns = scalarWidth(scalar);
    if (columns + scalarColumns > width && line.length > 0) {
      lines.push(line);
      line = "";
      columns = 0;
    }
    line += scalar;
    columns += scalarColumns;
  }
  lines.push(line);
  return lines;
}

function numeric(value: number | null): string {
  return value === null ? "unavailable" : String(value);
}

function colored(text: string, color: "cyan" | "yellow"): string {
  const code = color === "cyan" ? "36" : "33";
  return `\u001b[${code}m${text}\u001b[0m`;
}

function renderReport(
  report: ContextEfficiencyReport,
  options: Required<EfficiencyReportTerminalOptions>,
): string[] {
  const lines = [
    "Context efficiency report",
    `State: ${report.state}`,
    "Scope: repository",
    `Tokenizer: ${report.tokenizer.id}@${report.tokenizer.version} (${report.tokenizer.measurement})`,
    `Score: ${numeric(report.score.score)}${report.score.grade === null ? "" : `/100 (${report.score.grade})`}`,
    `Confidence: ${report.score.confidence}`,
    "Components:",
    ...report.score.components.map(
      (component) =>
        `  ${component.id}: ${numeric(component.score)}/100; weight ${String(component.weight)}; state ${component.state}`,
    ),
    "Profiles:",
    ...report.profiles.map(
      (profile) =>
        `  ${profile.profileId}/${profile.surfaceId}@${profile.profileVersion}: p50 ${numeric(profile.effectiveTokens?.p50 ?? null)}, p95 ${numeric(profile.effectiveTokens?.p95 ?? null)}, max ${numeric(profile.effectiveTokens?.maximum ?? null)} tokens; ${String(profile.completeSampleCount)}/${String(profile.sampleCount)} complete`,
    ),
    `Recommendations: ${String(report.recommendations.recommendations.length)} recommended; ${String(report.recommendations.evaluations.length)} evaluated`,
    ...report.recommendations.evaluations.flatMap((recommendation) => [
      `  ${recommendation.id}: ${recommendation.state}; saving ${numeric(recommendation.estimatedSavingTokens)} tokens; confidence ${recommendation.confidence}`,
      `    affected: ${recommendation.affectedPaths.length === 0 ? "none" : recommendation.affectedPaths.join(", ")}`,
      `    caveats: ${recommendation.caveatCodes.length === 0 ? "none" : recommendation.caveatCodes.join(", ")}`,
      `    uncertainty: ${recommendation.reasonCodes.length === 0 ? "none" : recommendation.reasonCodes.join(", ")}`,
    ]),
    `Score caveats: ${report.score.caveatCodes.length === 0 ? "none" : report.score.caveatCodes.join(", ")}`,
    `Score uncertainty: ${report.score.uncertaintyCodes.length === 0 ? "none" : report.score.uncertaintyCodes.join(", ")}`,
    "Static analysis only: quality and semantic preservation are not claimed.",
  ];
  return lines.flatMap((line) => wrap(line, options.width));
}

function renderComparison(
  report: ContextEfficiencyComparison,
  options: Required<EfficiencyReportTerminalOptions>,
): string[] {
  const lines = [
    "Context efficiency comparison",
    "Scope: repository",
    `Tokenizer: ${report.tokenizer.id}@${report.tokenizer.version} (${report.tokenizer.measurement})`,
    `Score baseline/candidate/delta: ${numeric(report.score.baseline)} / ${numeric(report.score.candidate)} / ${numeric(report.score.delta)}`,
    "Components:",
    ...report.components.map(
      (component) =>
        `  ${component.id}: ${numeric(component.score.baseline)} -> ${numeric(component.score.candidate)} (delta ${numeric(component.score.delta)})`,
    ),
    "Profiles:",
    ...report.profiles.map(
      (profile) =>
        `  ${profile.key}: p95 ${numeric(profile.effectiveP95.baseline)} -> ${numeric(profile.effectiveP95.candidate)} (delta ${numeric(profile.effectiveP95.delta)})`,
    ),
    `Recommendations baseline/candidate: ${String(report.baseline.recommendationCount)} / ${String(report.candidate.recommendationCount)}`,
    "Static comparison only: quality and semantic preservation are not claimed.",
  ];
  return lines.flatMap((line) => wrap(line, options.width));
}

/** Render an accessible, width-bounded report whose meaning never depends on color. */
export function renderContextEfficiencyTerminal(value: unknown, optionsValue?: unknown): string {
  const report = reportDocument(value);
  const options = terminalOptions(optionsValue);
  const plainLines = isIssuedContextEfficiencyReport(report)
    ? renderReport(report, options)
    : renderComparison(report, options);
  const lines =
    options.colorMode === "never"
      ? plainLines
      : plainLines.map((line, index) =>
          index === 0
            ? colored(line, "cyan")
            : index === plainLines.length - 1
              ? colored(line, "yellow")
              : line,
        );
  const output = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(output, "utf8") > CONTEXT_EFFICIENCY_REPORT_LIMITS.maximumTerminalBytes)
    return fail(
      ContextEfficiencyReportErrorCode.resourceLimit,
      "terminal output exceeds its limit",
    );
  return output;
}
