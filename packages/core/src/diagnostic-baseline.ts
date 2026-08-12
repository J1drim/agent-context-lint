import { createHash } from "node:crypto";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
} from "./diagnostic-contracts.js";
import { validateDiagnosticBundle } from "./diagnostic-validation.js";
import { validateJsonValue } from "./contract-validation.js";
import {
  BASELINE_OUTPUT_SCHEMA_VERSION,
  type BaselineEntry,
  type BaselineOutput,
  type BaselineProfileVersionIdentity,
} from "./output-contracts.js";
import { sanitizeOutputJson, sanitizeOutputText } from "./output-sanitization.js";
import { serializeNativeOutput, validateBaselineOutput } from "./output-validation.js";
import { isRepositoryRelativePath } from "./repository-path.js";

import type { Diagnostic, DiagnosticBundle } from "./diagnostic-contracts.js";
import type { SourceDocument } from "./ir-contracts.js";
import type { OutputValidationIssue } from "./output-contracts.js";
import type { RepositoryRelativePath } from "./repository-path.js";

export const BASELINE_DIAGNOSTIC_KINDS = ["lint", "configuration-error", "parser-error"] as const;
export const BASELINE_COMPARISON_STATUSES = [
  "matched",
  "new",
  "expired",
  "incompatible",
  "ambiguous",
] as const;
export const MAX_BASELINE_PATH_MOVES = 10_000 as const;
export const MAX_BASELINE_SERIALIZED_BYTES = 67_108_864 as const;

export type BaselineDiagnosticKind = (typeof BASELINE_DIAGNOSTIC_KINDS)[number];
export type BaselineComparisonStatus = (typeof BASELINE_COMPARISON_STATUSES)[number];

export interface BaselineDiagnosticClassification {
  readonly diagnosticId: string;
  readonly kind: BaselineDiagnosticKind;
}

export interface BaselinePathMove {
  readonly fromPath: RepositoryRelativePath;
  readonly toPath: RepositoryRelativePath;
  readonly ruleId: string;
  readonly semanticFingerprint: string;
}

export interface GenerateDiagnosticBaselineInput {
  readonly diagnostics: DiagnosticBundle;
  readonly sources: readonly SourceDocument[];
  readonly classifications: readonly BaselineDiagnosticClassification[];
  readonly engineVersion: string;
  readonly sourceRevision: string;
  readonly profileVersions: Readonly<Record<string, BaselineProfileVersionIdentity>>;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface CompareDiagnosticBaselineInput {
  readonly baseline: unknown;
  readonly diagnostics: DiagnosticBundle;
  readonly sources: readonly SourceDocument[];
  readonly classifications: readonly BaselineDiagnosticClassification[];
  readonly engineVersion: string;
  readonly profileVersions: Readonly<Record<string, BaselineProfileVersionIdentity>>;
  readonly now: string;
  readonly pathMoves?: readonly BaselinePathMove[];
}

export type BaselineOperationIssueCode =
  "invalid-baseline" | "invalid-diagnostics" | "invalid-input" | "resource-limit";

export interface BaselineOperationIssue {
  readonly code: BaselineOperationIssueCode;
  readonly path: string;
  readonly message: string;
}

export type GenerateDiagnosticBaselineResult =
  | { readonly ok: true; readonly baseline: BaselineOutput; readonly serializedBytes: number }
  | { readonly ok: false; readonly issues: readonly BaselineOperationIssue[] };

export type BaselineComparisonReason =
  | "exact-match"
  | "path-move"
  | "not-in-baseline"
  | "non-suppressible-configuration-error"
  | "non-suppressible-parser-error"
  | "baseline-expired"
  | "entry-expired"
  | "engine-version-changed"
  | "profile-identity-changed"
  | "rule-version-changed"
  | "severity-changed"
  | "diagnostic-provenance-changed"
  | "fingerprint-changed"
  | "path-move-unproven"
  | "fingerprint-collision"
  | "ambiguous-path-move";

export interface BaselineDiagnosticComparison {
  readonly diagnosticIndex: number;
  readonly diagnosticId: string;
  readonly status: BaselineComparisonStatus;
  readonly reason: BaselineComparisonReason;
  readonly visible: boolean;
  readonly baselineEntryIndex: number | null;
}

export interface BaselineStaleEntry {
  readonly baselineEntryIndex: number;
  readonly ruleId: string;
  readonly path: RepositoryRelativePath;
  readonly reason: "expired" | "not-observed";
}

export interface BaselineComparisonSummary {
  readonly matched: number;
  readonly new: number;
  readonly stale: number;
  readonly expired: number;
  readonly incompatible: number;
  readonly ambiguous: number;
}

export type CompareDiagnosticBaselineResult =
  | {
      readonly ok: true;
      readonly diagnostics: readonly BaselineDiagnosticComparison[];
      readonly visibleDiagnosticIndexes: readonly number[];
      readonly visibleDiagnosticIds: readonly string[];
      readonly staleEntries: readonly BaselineStaleEntry[];
      readonly summary: BaselineComparisonSummary;
    }
  | { readonly ok: false; readonly issues: readonly BaselineOperationIssue[] };

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function fail(
  code: BaselineOperationIssueCode,
  path: string,
  message: string,
): { readonly ok: false; readonly issues: readonly BaselineOperationIssue[] } {
  return freeze({ ok: false as const, issues: [{ code, path, message }] });
}

function validationFail(
  code: "invalid-baseline" | "invalid-diagnostics" | "invalid-input",
  issues: readonly { readonly path: string; readonly message: string }[],
): { readonly ok: false; readonly issues: readonly BaselineOperationIssue[] } {
  return freeze({
    ok: false as const,
    issues: issues.map((item) => ({ code, path: item.path, message: item.message })),
  });
}

function canonicalDateTime(value: string): boolean {
  if (!DATE_TIME.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareBytes);
}

function canonicalSanitizedStrings(values: readonly string[]): readonly string[] {
  const canonical = canonicalStrings(values);
  const sanitized = canonical.map(sanitizeOutputText);
  if (new Set(sanitized).size !== canonical.length)
    throw new TypeError("redaction must not collapse distinct baseline identities");
  return sanitized.sort(compareBytes);
}

function canonicalProfiles(
  value: Readonly<Record<string, BaselineProfileVersionIdentity>>,
): Readonly<Record<string, BaselineProfileVersionIdentity>> {
  const sanitized = sanitizeOutputJson(value) as Record<string, BaselineProfileVersionIdentity>;
  const result: Record<string, BaselineProfileVersionIdentity> = Object.create(null) as Record<
    string,
    BaselineProfileVersionIdentity
  >;
  for (const profileId of Object.keys(sanitized).sort(compareBytes)) {
    const profile = sanitized[profileId];
    if (profile === undefined) continue;
    result[profileId] = {
      profileVersion: profile.profileVersion,
      clientVersion: profile.clientVersion,
      surfaceIds: canonicalStrings(profile.surfaceIds),
      specSnapshotIds: canonicalStrings(profile.specSnapshotIds),
    };
  }
  return result;
}

function profilesIdentity(value: Readonly<Record<string, BaselineProfileVersionIdentity>>): string {
  return JSON.stringify(canonicalProfiles(value));
}

function diagnosticProvenance(diagnostic: Diagnostic): {
  readonly profileIds: readonly string[];
  readonly surfaceIds: readonly string[];
  readonly specSnapshotIds: readonly string[];
  readonly provenanceFingerprint: string;
} {
  const profileIds = [
    ...diagnostic.fingerprintBasis.path.profileIds,
    ...diagnostic.fingerprintBasis.semantic.profileIds,
  ];
  const surfaceIds: string[] = [];
  const specSnapshotIds: string[] = [];
  const provenanceComponents: string[] = [
    ...diagnostic.fingerprintBasis.path.profileIds.map((id) =>
      JSON.stringify(["path-profile", id]),
    ),
    ...diagnostic.fingerprintBasis.semantic.profileIds.map((id) =>
      JSON.stringify(["semantic-profile", id]),
    ),
  ];
  for (const related of diagnostic.related) {
    if (related.kind === "resolution") {
      profileIds.push(related.profileId);
      surfaceIds.push(related.surfaceId);
      specSnapshotIds.push(related.specSnapshotId);
      provenanceComponents.push(
        JSON.stringify([
          "resolution",
          related.profileId,
          related.surfaceId,
          related.specSnapshotId,
        ]),
      );
    } else if (related.kind === "spec") {
      specSnapshotIds.push(related.specSnapshotId);
      provenanceComponents.push(JSON.stringify(["spec", related.specSnapshotId]));
    }
  }
  return {
    profileIds: canonicalStrings(profileIds),
    surfaceIds: canonicalStrings(surfaceIds),
    specSnapshotIds: canonicalStrings(specSnapshotIds),
    provenanceFingerprint: createHash("sha256")
      .update(JSON.stringify(canonicalStrings(provenanceComponents)))
      .digest("hex"),
  };
}

function entryFromDiagnostic(
  diagnostic: Diagnostic,
  firstSeenAt: string,
  expiresAt: string | null,
): BaselineEntry {
  const provenance = diagnosticProvenance(diagnostic);
  return {
    ruleId: sanitizeOutputText(diagnostic.ruleId),
    ruleVersion: sanitizeOutputText(diagnostic.ruleVersion),
    severity: diagnostic.severity,
    path: sanitizeOutputText(diagnostic.primary.path) as RepositoryRelativePath,
    semanticFingerprint: diagnostic.fingerprints.semantic.value,
    pathFingerprint: diagnostic.fingerprints.path.value,
    provenanceFingerprint: provenance.provenanceFingerprint,
    profileIds: canonicalSanitizedStrings(provenance.profileIds),
    surfaceIds: canonicalSanitizedStrings(provenance.surfaceIds),
    specSnapshotIds: canonicalSanitizedStrings(provenance.specSnapshotIds),
    firstSeenAt,
    expiresAt,
  };
}

function matchIdentity(entry: BaselineEntry): string {
  return JSON.stringify([
    entry.ruleId,
    entry.ruleVersion,
    entry.severity,
    entry.path,
    entry.semanticFingerprint,
    entry.pathFingerprint,
    entry.provenanceFingerprint,
    entry.profileIds,
    entry.surfaceIds,
    entry.specSnapshotIds,
  ]);
}

function nearIdentity(entry: BaselineEntry): string {
  return JSON.stringify([entry.ruleId, entry.path]);
}

function semanticIdentity(entry: BaselineEntry): string {
  return JSON.stringify([
    entry.ruleId,
    entry.ruleVersion,
    entry.severity,
    entry.semanticFingerprint,
    entry.provenanceFingerprint,
    entry.profileIds,
    entry.surfaceIds,
    entry.specSnapshotIds,
  ]);
}

function moveIdentity(
  move: Pick<BaselinePathMove, "toPath" | "ruleId" | "semanticFingerprint">,
): string {
  return JSON.stringify([move.toPath, move.ruleId, move.semanticFingerprint]);
}

function appendIndex<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function classificationMap(
  diagnostics: readonly Diagnostic[],
  classifications: readonly BaselineDiagnosticClassification[],
): ReadonlyMap<string, BaselineDiagnosticKind> | undefined {
  if (classifications.length !== diagnostics.length) return undefined;
  const result = new Map<string, BaselineDiagnosticKind>();
  for (const [index, diagnostic] of diagnostics.entries()) {
    const classification = classifications[index];
    if (
      classification === undefined ||
      Object.keys(classification).sort().join("\u0000") !== "diagnosticId\u0000kind" ||
      classification.diagnosticId !== diagnostic.id ||
      !BASELINE_DIAGNOSTIC_KINDS.includes(classification.kind) ||
      result.has(classification.diagnosticId)
    )
      return undefined;
    result.set(classification.diagnosticId, classification.kind);
  }
  return result;
}

function profilesAreWellFormed(
  profiles: Readonly<Record<string, BaselineProfileVersionIdentity>>,
): boolean {
  try {
    if (
      !validateJsonValue(profiles, "$.profileVersions", () => undefined, {
        maximumContainerEntries: 100_000,
        maximumKeyBytes: 1_024,
        maximumStringBytes: 16_384,
        maximumTotalStringBytes: 67_108_864,
        maximumValues: 1_000_000,
      })
    )
      return false;
    const keys = Object.keys(profiles);
    if (keys.length === 0 || keys.length > 100_000) return false;
    for (const key of keys) {
      const profile = profiles[key];
      if (
        profile === undefined ||
        Object.keys(profile).sort().join("\u0000") !==
          "clientVersion\u0000profileVersion\u0000specSnapshotIds\u0000surfaceIds" ||
        !IDENTIFIER.test(key) ||
        !VERSION.test(profile.profileVersion) ||
        (profile.clientVersion !== null && typeof profile.clientVersion !== "string") ||
        !Array.isArray(profile.surfaceIds) ||
        !Array.isArray(profile.specSnapshotIds) ||
        profile.surfaceIds.some((id) => typeof id !== "string" || !IDENTIFIER.test(id)) ||
        profile.specSnapshotIds.some((id) => typeof id !== "string" || !IDENTIFIER.test(id)) ||
        new Set(profile.surfaceIds).size !== profile.surfaceIds.length ||
        new Set(profile.specSnapshotIds).size !== profile.specSnapshotIds.length
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validateCommon(
  diagnostics: DiagnosticBundle,
  sources: readonly SourceDocument[],
  classifications: readonly BaselineDiagnosticClassification[],
  engineVersion: string,
  profileVersions: Readonly<Record<string, BaselineProfileVersionIdentity>>,
):
  | { readonly ok: true; readonly classifications: ReadonlyMap<string, BaselineDiagnosticKind> }
  | { readonly ok: false; readonly issues: readonly BaselineOperationIssue[] } {
  const diagnosticResult = validateDiagnosticBundle(diagnostics, sources);
  if (!diagnosticResult.ok) return validationFail("invalid-diagnostics", diagnosticResult.issues);
  const kinds = classificationMap(diagnosticResult.value.diagnostics, classifications);
  if (kinds === undefined)
    return fail(
      "invalid-input",
      "$.classifications",
      "must classify every diagnostic exactly once in caller order",
    );
  if (!VERSION.test(engineVersion))
    return fail("invalid-input", "$.engineVersion", "must be an exact semantic version");
  if (!profilesAreWellFormed(profileVersions))
    return fail("invalid-input", "$.profileVersions", "must be closed bounded profile identities");
  return { ok: true, classifications: kinds };
}

export function generateDiagnosticBaseline(
  input: GenerateDiagnosticBaselineInput,
): GenerateDiagnosticBaselineResult {
  try {
    const common = validateCommon(
      input.diagnostics,
      input.sources,
      input.classifications,
      input.engineVersion,
      input.profileVersions,
    );
    if (!common.ok) return common;
    if (!canonicalDateTime(input.createdAt))
      return fail("invalid-input", "$.createdAt", "must be an explicit canonical UTC instant");
    if (
      input.expiresAt !== null &&
      (!canonicalDateTime(input.expiresAt) || input.expiresAt <= input.createdAt)
    )
      return fail("invalid-input", "$.expiresAt", "must be null or later than createdAt");
    if (!SHA256.test(input.sourceRevision))
      return fail("invalid-input", "$.sourceRevision", "must be a lowercase SHA-256 digest");

    const byIdentity = new Map<string, BaselineEntry>();
    for (const diagnostic of input.diagnostics.diagnostics) {
      if (common.classifications.get(diagnostic.id) !== "lint") continue;
      const entry = entryFromDiagnostic(diagnostic, input.createdAt, input.expiresAt);
      const identity = matchIdentity(entry);
      if (!byIdentity.has(identity)) byIdentity.set(identity, entry);
    }
    const entries = [...byIdentity.values()].sort((left, right) =>
      compareBytes(matchIdentity(left), matchIdentity(right)),
    );
    const baseline = {
      recordKind: "agent-context-baseline-output",
      schemaVersion: BASELINE_OUTPUT_SCHEMA_VERSION,
      diagnosticContractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      engineVersion: input.engineVersion,
      fingerprintMethods: {
        path: PATH_FINGERPRINT_METHOD,
        semantic: SEMANTIC_FINGERPRINT_METHOD,
      },
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      sourceRevision: input.sourceRevision,
      profileVersions: canonicalProfiles(input.profileVersions),
      entries,
    } satisfies BaselineOutput;
    const validated = validateBaselineOutput(baseline);
    if (!validated.ok) return validationFail("invalid-input", validated.issues);
    const serialized = serializeNativeOutput(validated.value);
    if (!serialized.ok) return validationFail("invalid-input", serialized.issues);
    const serializedBytes = Buffer.byteLength(serialized.text, "utf8");
    if (serializedBytes > MAX_BASELINE_SERIALIZED_BYTES)
      return fail("resource-limit", "$", "baseline exceeds the serialized byte limit");
    const sanitizedResult = validateBaselineOutput(JSON.parse(serialized.text) as unknown);
    if (!sanitizedResult.ok) return validationFail("invalid-input", sanitizedResult.issues);
    return freeze({ ok: true, baseline: sanitizedResult.value, serializedBytes });
  } catch {
    return fail("invalid-input", "$", "input must be safely inspectable bounded data");
  }
}

function validateMoves(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_BASELINE_PATH_MOVES) return false;
  try {
    return value.every((candidate: unknown) => {
      if (candidate === null || typeof candidate !== "object") return false;
      const move = candidate as Record<string, unknown>;
      return (
        Object.keys(move).sort().join("\u0000") ===
          "fromPath\u0000ruleId\u0000semanticFingerprint\u0000toPath" &&
        typeof move["fromPath"] === "string" &&
        isRepositoryRelativePath(move["fromPath"]) &&
        typeof move["toPath"] === "string" &&
        isRepositoryRelativePath(move["toPath"]) &&
        move["fromPath"] !== move["toPath"] &&
        typeof move["ruleId"] === "string" &&
        IDENTIFIER.test(move["ruleId"]) &&
        typeof move["semanticFingerprint"] === "string" &&
        SHA256.test(move["semanticFingerprint"])
      );
    });
  } catch {
    return false;
  }
}

function incompatibilityReason(
  baseline: BaselineEntry,
  current: BaselineEntry,
): BaselineComparisonReason {
  if (baseline.ruleVersion !== current.ruleVersion) return "rule-version-changed";
  if (baseline.severity !== current.severity) return "severity-changed";
  if (
    baseline.provenanceFingerprint !== current.provenanceFingerprint ||
    !arraysEqual(baseline.profileIds, current.profileIds) ||
    !arraysEqual(baseline.surfaceIds, current.surfaceIds) ||
    !arraysEqual(baseline.specSnapshotIds, current.specSnapshotIds)
  )
    return "diagnostic-provenance-changed";
  return "fingerprint-changed";
}

function expiredReason(
  baseline: BaselineOutput,
  entry: BaselineEntry,
  now: string,
): "baseline-expired" | "entry-expired" | undefined {
  if (baseline.expiresAt !== null && baseline.expiresAt <= now) return "baseline-expired";
  if (entry.expiresAt !== null && entry.expiresAt <= now) return "entry-expired";
  return undefined;
}

export function compareDiagnosticBaseline(
  input: CompareDiagnosticBaselineInput,
): CompareDiagnosticBaselineResult {
  try {
    const baselineResult = validateBaselineOutput(input.baseline);
    if (!baselineResult.ok) return validationFail("invalid-baseline", baselineResult.issues);
    const common = validateCommon(
      input.diagnostics,
      input.sources,
      input.classifications,
      input.engineVersion,
      input.profileVersions,
    );
    if (!common.ok) return common;
    if (!canonicalDateTime(input.now))
      return fail("invalid-input", "$.now", "must be an explicit canonical UTC instant");
    const moves = input.pathMoves ?? [];
    if (!validateMoves(moves))
      return fail(
        "invalid-input",
        "$.pathMoves",
        "must contain closed unambiguous move declarations",
      );

    const baseline = baselineResult.value;
    const currentEntries = input.diagnostics.diagnostics.map((diagnostic) =>
      entryFromDiagnostic(diagnostic, input.now, null),
    );
    const currentIdentityCounts = new Map<string, number>();
    const currentSemanticCounts = new Map<string, number>();
    for (const entry of currentEntries) {
      const identity = matchIdentity(entry);
      currentIdentityCounts.set(identity, (currentIdentityCounts.get(identity) ?? 0) + 1);
      const semantic = semanticIdentity(entry);
      currentSemanticCounts.set(semantic, (currentSemanticCounts.get(semantic) ?? 0) + 1);
    }
    const exactEntries = new Map<
      string,
      { readonly entry: BaselineEntry; readonly index: number }[]
    >();
    const nearEntries = new Map<
      string,
      { readonly entry: BaselineEntry; readonly index: number }[]
    >();
    const semanticEntries = new Map<
      string,
      { readonly entry: BaselineEntry; readonly index: number }[]
    >();
    for (const [index, entry] of baseline.entries.entries()) {
      const indexed = { entry, index };
      appendIndex(exactEntries, matchIdentity(entry), indexed);
      appendIndex(nearEntries, nearIdentity(entry), indexed);
      appendIndex(semanticEntries, semanticIdentity(entry), indexed);
    }
    const moveDeclarations = new Map<string, BaselinePathMove[]>();
    for (const move of moves) appendIndex(moveDeclarations, moveIdentity(move), move);
    const consumed = new Set<number>();
    const comparisons: BaselineDiagnosticComparison[] = [];
    const baselineProfiles = profilesIdentity(baseline.profileVersions);
    const currentProfiles = profilesIdentity(input.profileVersions);
    const globalReason: BaselineComparisonReason | undefined =
      baseline.engineVersion !== input.engineVersion
        ? "engine-version-changed"
        : baselineProfiles !== currentProfiles
          ? "profile-identity-changed"
          : undefined;

    for (const [diagnosticIndex, diagnostic] of input.diagnostics.diagnostics.entries()) {
      const current = currentEntries[diagnosticIndex];
      if (current === undefined) continue;
      const kind = common.classifications.get(diagnostic.id);
      if (kind !== "lint") {
        comparisons.push({
          diagnosticIndex,
          diagnosticId: sanitizeOutputText(diagnostic.id),
          status: "new",
          reason:
            kind === "parser-error"
              ? "non-suppressible-parser-error"
              : "non-suppressible-configuration-error",
          visible: true,
          baselineEntryIndex: null,
        });
        continue;
      }
      if (globalReason !== undefined) {
        comparisons.push({
          diagnosticIndex,
          diagnosticId: sanitizeOutputText(diagnostic.id),
          status: "incompatible",
          reason: globalReason,
          visible: true,
          baselineEntryIndex: null,
        });
        continue;
      }

      const exact = exactEntries.get(matchIdentity(current)) ?? [];
      if (exact.length === 1 && (currentIdentityCounts.get(matchIdentity(current)) ?? 0) === 1) {
        const candidate = exact[0];
        if (candidate === undefined) continue;
        const expiry = expiredReason(baseline, candidate.entry, input.now);
        consumed.add(candidate.index);
        comparisons.push({
          diagnosticIndex,
          diagnosticId: sanitizeOutputText(diagnostic.id),
          status: expiry === undefined ? "matched" : "expired",
          reason: expiry ?? "exact-match",
          visible: expiry !== undefined,
          baselineEntryIndex: candidate.index,
        });
        continue;
      }
      if (
        exact.length > 1 ||
        (exact.length === 1 && (currentIdentityCounts.get(matchIdentity(current)) ?? 0) > 1)
      ) {
        comparisons.push({
          diagnosticIndex,
          diagnosticId: sanitizeOutputText(diagnostic.id),
          status: "ambiguous",
          reason: "fingerprint-collision",
          visible: true,
          baselineEntryIndex: null,
        });
        continue;
      }

      const near = nearEntries.get(nearIdentity(current)) ?? [];
      if (near.length === 1) {
        const candidate = near[0];
        if (candidate === undefined) continue;
        comparisons.push({
          diagnosticIndex,
          diagnosticId: sanitizeOutputText(diagnostic.id),
          status: "incompatible",
          reason: incompatibilityReason(candidate.entry, current),
          visible: true,
          baselineEntryIndex: candidate.index,
        });
        continue;
      }
      if (near.length > 1) {
        comparisons.push({
          diagnosticIndex,
          diagnosticId: sanitizeOutputText(diagnostic.id),
          status: "ambiguous",
          reason: "fingerprint-collision",
          visible: true,
          baselineEntryIndex: null,
        });
        continue;
      }

      const declarations =
        moveDeclarations.get(
          moveIdentity({
            toPath: current.path,
            ruleId: current.ruleId,
            semanticFingerprint: current.semanticFingerprint,
          }),
        ) ?? [];
      const semanticCandidates = semanticEntries.get(semanticIdentity(current)) ?? [];
      if (declarations.length > 0) {
        const eligible = semanticCandidates.filter(({ entry }) =>
          declarations.some((move) => move.fromPath === entry.path),
        );
        const currentSemanticCount = currentSemanticCounts.get(semanticIdentity(current)) ?? 0;
        if (declarations.length !== 1 || eligible.length !== 1 || currentSemanticCount !== 1) {
          comparisons.push({
            diagnosticIndex,
            diagnosticId: sanitizeOutputText(diagnostic.id),
            status: "ambiguous",
            reason: "ambiguous-path-move",
            visible: true,
            baselineEntryIndex: null,
          });
          continue;
        }
        const candidate = eligible[0];
        if (candidate === undefined) continue;
        const expiry = expiredReason(baseline, candidate.entry, input.now);
        consumed.add(candidate.index);
        comparisons.push({
          diagnosticIndex,
          diagnosticId: sanitizeOutputText(diagnostic.id),
          status: expiry === undefined ? "matched" : "expired",
          reason: expiry ?? "path-move",
          visible: expiry !== undefined,
          baselineEntryIndex: candidate.index,
        });
        continue;
      }
      comparisons.push({
        diagnosticIndex,
        diagnosticId: sanitizeOutputText(diagnostic.id),
        status: "new",
        reason: semanticCandidates.length > 0 ? "path-move-unproven" : "not-in-baseline",
        visible: true,
        baselineEntryIndex: null,
      });
    }

    const staleEntries: BaselineStaleEntry[] = [];
    let unmatchedExpired = 0;
    for (const [index, entry] of baseline.entries.entries()) {
      if (consumed.has(index)) continue;
      const expired = expiredReason(baseline, entry, input.now) !== undefined;
      if (expired) unmatchedExpired += 1;
      staleEntries.push({
        baselineEntryIndex: index,
        ruleId: sanitizeOutputText(entry.ruleId),
        path: sanitizeOutputText(entry.path) as RepositoryRelativePath,
        reason: expired ? "expired" : "not-observed",
      });
    }
    const summary: BaselineComparisonSummary = {
      matched: comparisons.filter((item) => item.status === "matched").length,
      new: comparisons.filter((item) => item.status === "new").length,
      stale: staleEntries.filter((item) => item.reason === "not-observed").length,
      expired: comparisons.filter((item) => item.status === "expired").length + unmatchedExpired,
      incompatible: comparisons.filter((item) => item.status === "incompatible").length,
      ambiguous: comparisons.filter((item) => item.status === "ambiguous").length,
    };
    return freeze({
      ok: true,
      diagnostics: comparisons,
      visibleDiagnosticIndexes: comparisons
        .filter((item) => item.visible)
        .map((item) => item.diagnosticIndex),
      visibleDiagnosticIds: comparisons
        .filter((item) => item.visible)
        .map((item) => item.diagnosticId),
      staleEntries,
      summary,
    });
  } catch {
    return fail("invalid-input", "$", "input must be safely inspectable bounded data");
  }
}

/** Stable audit digest for a validated entry's matching provenance, excluding timestamps and path. */
export function computeBaselineProvenanceDigest(entry: BaselineEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        entry.ruleId,
        entry.ruleVersion,
        entry.severity,
        entry.semanticFingerprint,
        entry.provenanceFingerprint,
        entry.profileIds,
        entry.surfaceIds,
        entry.specSnapshotIds,
      ]),
    )
    .digest("hex");
}

export function baselineValidationIssues(input: unknown): readonly OutputValidationIssue[] {
  const result = validateBaselineOutput(input);
  return result.ok ? freeze([]) : freeze([...result.issues]);
}
