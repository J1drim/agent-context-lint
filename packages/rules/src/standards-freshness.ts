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
  STANDARDS_UPDATE_CONTRACT_VERSION,
  STANDARDS_UPDATE_RECORD_KIND,
  createOfflineStandardsStatus,
} from "@agent-context/standards/offline";
import { matchSuppressionDirectives, parseSuppressionDirectives } from "@agent-context/syntax";

import type {
  ClientProfileId,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticId,
  DiagnosticSourceLocation,
  FingerprintComponent,
  InstructionIr,
  RelatedEvidence,
  RelatedEvidenceId,
  RepositoryFactRelatedEvidence,
  SourceDocument,
  SourcePosition,
  SourceRange,
  SpecRelatedEvidence,
} from "@agent-context/core";
import type {
  OfflineStandardsStatusReport,
  OfflineStandardsStatusRequest,
  StandardsUpdateIssue,
  StandardsUpdatePlan,
  StandardsUpdateResult,
} from "@agent-context/standards/offline";
import type { ParsedSuppressionDirective } from "@agent-context/syntax";

import { findRuleMetadata } from "./registry.js";

export const STANDARDS_FRESHNESS_RULE_CONTRACT_VERSION = "0.1.0" as const;
export const STANDARDS_FRESHNESS_RULE_VERSION = "1.0.0" as const;
export const STANDARDS_FRESHNESS_RULE_IDS = [
  "ACL500",
  "ACL501",
  "ACL502",
  "ACL503",
  "ACL504",
  "ACL505",
  "ACL506",
] as const;

export const STANDARDS_FRESHNESS_DEFAULT_LIMITS: Readonly<{
  readonly deprecatedSyntax: number;
  readonly liveUpdates: number;
}> = Object.freeze({
  deprecatedSyntax: 1_024,
  liveUpdates: 2,
});

export type StandardsFreshnessRuleId = (typeof STANDARDS_FRESHNESS_RULE_IDS)[number];
export type StandardsObservationOrigin = "cached-offline" | "verified-live-h09";

export interface VerifiedLiveStandardsObservation {
  readonly channel: "preview" | "stable";
  readonly origin: "verified-live-h09";
  readonly result: StandardsUpdateResult<StandardsUpdatePlan>;
}

export interface DeprecatedSyntaxObservation {
  readonly deprecatedSince: string;
  readonly evidence: Readonly<{
    readonly evidenceRefId: string;
    readonly retrievedAt: string;
    readonly revision: string | null;
    readonly url: string;
  }>;
  readonly pack: Readonly<{
    readonly digest: string;
    readonly origin: "bundled" | "locked";
    readonly version: string;
  }>;
  readonly profileId: string;
  readonly range: SourceRange;
  readonly replacementId: string | null;
  readonly sourceId: string;
  readonly specSnapshotId: string;
  readonly subjectId: string;
  readonly surfaceId: string;
}

export interface StandardsFreshnessRuleInput {
  readonly anchorSourceId: string;
  readonly contractVersion: typeof STANDARDS_FRESHNESS_RULE_CONTRACT_VERSION;
  readonly deprecatedSyntax: readonly DeprecatedSyntaxObservation[];
  readonly environment: "ci" | "local";
  readonly ir: InstructionIr;
  readonly liveUpdates: readonly VerifiedLiveStandardsObservation[];
  readonly previewEnabled: boolean;
  readonly recordKind: "agent-context-standards-freshness-rule-input";
  readonly statusRequest: OfflineStandardsStatusRequest;
}

export interface StandardsFreshnessRuleIssue {
  readonly code: "dependency-failure" | "invalid-input" | "resource-limit";
  readonly message: string;
  readonly path: string;
}

export interface StandardsFreshnessRuleMetrics {
  readonly cachedObservationCount: number;
  readonly deprecatedObservationCount: number;
  readonly diagnosticCount: number;
  readonly liveObservationCount: number;
  readonly suppressionDirectiveCount: number;
}

export type StandardsFreshnessRuleResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly metrics: StandardsFreshnessRuleMetrics;
      readonly ok: true;
      readonly sources: readonly SourceDocument[];
      readonly status: OfflineStandardsStatusReport;
    }
  | { readonly issues: readonly StandardsFreshnessRuleIssue[]; readonly ok: false };

export type StandardsFreshnessSuppressionFinalizationResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly ok: true;
      readonly suppressedDiagnostics: readonly Diagnostic[];
      readonly visibleDiagnostics: readonly Diagnostic[];
    }
  | { readonly issues: readonly StandardsFreshnessRuleIssue[]; readonly ok: false };

interface ValidatedInput {
  readonly anchor: SourceDocument;
  readonly deprecatedSyntax: readonly DeprecatedSyntaxObservation[];
  readonly environment: "ci" | "local";
  readonly ir: InstructionIr;
  readonly liveUpdates: readonly VerifiedLiveStandardsObservation[];
  readonly previewEnabled: boolean;
  readonly statusRequest: OfflineStandardsStatusRequest;
}

interface IssuedEvaluation {
  readonly directives: readonly ParsedSuppressionDirective[];
  readonly ir: InstructionIr;
}

const issuedEvaluations = new WeakMap<object, IssuedEvaluation>();
const INPUT_KEYS = new Set([
  "anchorSourceId",
  "contractVersion",
  "deprecatedSyntax",
  "environment",
  "ir",
  "liveUpdates",
  "previewEnabled",
  "recordKind",
  "statusRequest",
]);
const LIVE_KEYS = new Set(["channel", "origin", "result"]);
const RESULT_OK_KEYS = new Set(["ok", "value"]);
const RESULT_FAILURE_KEYS = new Set(["issues", "ok"]);
const PLAN_KEYS = new Set([
  "candidateLockSha256",
  "checkedAt",
  "contractVersion",
  "diff",
  "mode",
  "noChanges",
  "recordKind",
  "signer",
]);
const DIFF_KEYS = new Set(["digest", "engineRequirement", "rules", "version"]);
const PAIR_KEYS = new Set(["candidate", "current"]);
const RULE_DIFF_KEYS = new Set(["added", "removed"]);
const SIGNER_KEYS = new Set(["authorizedKeyCount", "metadataSha256", "role", "threshold"]);
const UPDATE_ISSUE_KEYS = new Set(["code", "message", "path", "source"]);
const DEPRECATION_KEYS = new Set([
  "deprecatedSince",
  "evidence",
  "pack",
  "profileId",
  "range",
  "replacementId",
  "sourceId",
  "specSnapshotId",
  "subjectId",
  "surfaceId",
]);
const EVIDENCE_KEYS = new Set(["evidenceRefId", "retrievedAt", "revision", "url"]);
const PACK_KEYS = new Set(["digest", "origin", "version"]);
const RANGE_KEYS = new Set(["end", "sourceId", "start"]);
const POSITION_KEYS = new Set(["byteOffset", "line", "utf16Column", "utf16Offset"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const EXACT_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const STABLE_ID = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const RULE_ID = /^ACL\d{3}$/u;
const TRUST_FAILURE_CODES = new Set([
  "candidate-binding-mismatch",
  "candidate-pack-invalid",
  "current-binding-mismatch",
  "current-pack-invalid",
  "current-trust-mismatch",
  "digest-mismatch",
  "expired-metadata",
  "hash-mismatch",
  "invalid-metadata",
  "invalid-signature",
  "length-mismatch",
  "mix-and-match",
  "replay",
  "rollback",
  "root-continuity",
  "wrong-role",
]);

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function issue(
  code: StandardsFreshnessRuleIssue["code"],
  path: string,
  message: string,
): StandardsFreshnessRuleIssue {
  return Object.freeze({ code, message, path });
}

function failure(value: StandardsFreshnessRuleIssue): StandardsFreshnessRuleResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function finalizationFailure(
  value: StandardsFreshnessRuleIssue,
): StandardsFreshnessSuppressionFinalizationResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function record(
  value: unknown,
  keys: ReadonlySet<string>,
): ReadonlyMap<string, unknown> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  )
    return undefined;
  try {
    if (
      (Reflect.getPrototypeOf(value) !== Object.prototype &&
        Reflect.getPrototypeOf(value) !== null) ||
      Reflect.ownKeys(value).length !== keys.size ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.has(key))
    )
      return undefined;
    const output = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return undefined;
      output.set(key as string, descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function array(value: unknown, maximum: number): readonly unknown[] | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    value.length > maximum
  )
    return undefined;
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function bounded(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

function stable(value: unknown): value is string {
  return bounded(value) && STABLE_ID.test(value);
}

function exactInstant(value: unknown): value is string {
  if (typeof value !== "string" || !EXACT_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(".000Z", "Z") === value;
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

interface ParsedSemver {
  readonly core: readonly [string, string, string];
  readonly prerelease: readonly string[] | null;
}

function parseSemver(value: unknown): ParsedSemver | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  const match = SEMVER.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
    return undefined;
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] === undefined ? null : match[4].split("."),
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const a = left.replace(/^0+(?=\d)/u, "");
    const b = right.replace(/^0+(?=\d)/u, "");
    return a.length - b.length || compareUtf8(a, b);
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return compareUtf8(left, right);
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === undefined || b === undefined) throw new TypeError("invalid SemVer");
  for (const index of [0, 1, 2] as const) {
    const result = compareIdentifier(a.core[index], b.core[index]);
    if (result !== 0) return result;
  }
  if (a.prerelease === null || b.prerelease === null)
    return a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    const result = compareIdentifier(leftPart, rightPart);
    if (result !== 0) return result;
  }
  return 0;
}

function parseStringArray(value: unknown, maximum: number): readonly string[] | undefined {
  const values = array(value, maximum);
  if (
    values === undefined ||
    values.some((entry) => typeof entry !== "string" || !RULE_ID.test(entry)) ||
    new Set(values).size !== values.length
  )
    return undefined;
  const sorted = [...(values as readonly string[])].sort(compareUtf8);
  if (sorted.some((entry, index) => entry !== values[index])) return undefined;
  return Object.freeze(sorted);
}

function parsePair(
  value: unknown,
  kind: "digest" | "semver",
): { current: string; candidate: string } | undefined {
  const fields = record(value, PAIR_KEYS);
  const current = fields?.get("current");
  const candidate = fields?.get("candidate");
  const valid =
    kind === "digest"
      ? SHA256.test(String(current)) && SHA256.test(String(candidate))
      : parseSemver(current) !== undefined && parseSemver(candidate) !== undefined;
  return fields !== undefined && valid
    ? Object.freeze({ candidate: candidate as string, current: current as string })
    : undefined;
}

function parsePlan(value: unknown, channel: "preview" | "stable"): StandardsUpdatePlan | undefined {
  const fields = record(value, PLAN_KEYS);
  const diff = record(fields?.get("diff"), DIFF_KEYS);
  const rules = record(diff?.get("rules"), RULE_DIFF_KEYS);
  const signer = record(fields?.get("signer"), SIGNER_KEYS);
  const digest = parsePair(diff?.get("digest"), "digest");
  const engineRequirement = parsePair(diff?.get("engineRequirement"), "semver");
  const version = parsePair(diff?.get("version"), "semver");
  const added = parseStringArray(rules?.get("added"), 1_024);
  const removed = parseStringArray(rules?.get("removed"), 1_024);
  const role = channel === "stable" ? "standards-stable" : "standards-preview";
  if (
    fields === undefined ||
    diff === undefined ||
    rules === undefined ||
    signer === undefined ||
    digest === undefined ||
    engineRequirement === undefined ||
    version === undefined ||
    added === undefined ||
    removed === undefined ||
    fields.get("contractVersion") !== STANDARDS_UPDATE_CONTRACT_VERSION ||
    fields.get("recordKind") !== STANDARDS_UPDATE_RECORD_KIND ||
    !SHA256.test(String(fields.get("candidateLockSha256"))) ||
    !exactInstant(fields.get("checkedAt")) ||
    (fields.get("mode") !== "dry-run" && fields.get("mode") !== "update") ||
    typeof fields.get("noChanges") !== "boolean" ||
    signer.get("authorizedKeyCount") !== 3 ||
    signer.get("threshold") !== 2 ||
    signer.get("role") !== role ||
    !SHA256.test(String(signer.get("metadataSha256")))
  )
    return undefined;
  const noChanges =
    digest.current === digest.candidate &&
    engineRequirement.current === engineRequirement.candidate &&
    version.current === version.candidate &&
    added.length === 0 &&
    removed.length === 0;
  if (noChanges !== fields.get("noChanges")) return undefined;
  return value as StandardsUpdatePlan;
}

function parseUpdateIssue(value: unknown): StandardsUpdateIssue | undefined {
  const fields = record(value, UPDATE_ISSUE_KEYS);
  const source = fields?.get("source");
  if (
    fields === undefined ||
    !bounded(fields.get("code"), 128) ||
    !bounded(fields.get("message"), 4_096) ||
    !bounded(fields.get("path"), 1_024) ||
    !["cache", "candidate-pack", "check", "current-lock", "current-pack", "update"].includes(
      String(source),
    )
  )
    return undefined;
  return value as StandardsUpdateIssue;
}

function parseLiveUpdates(
  value: unknown,
  asOf: string,
): readonly VerifiedLiveStandardsObservation[] | undefined {
  const values = array(value, STANDARDS_FRESHNESS_DEFAULT_LIMITS.liveUpdates);
  if (values === undefined) return undefined;
  const output: VerifiedLiveStandardsObservation[] = [];
  const channels = new Set<string>();
  for (const valueEntry of values) {
    const fields = record(valueEntry, LIVE_KEYS);
    const channel = fields?.get("channel");
    const resultValue = fields?.get("result");
    if (
      fields === undefined ||
      (channel !== "stable" && channel !== "preview") ||
      fields.get("origin") !== "verified-live-h09" ||
      channels.has(channel)
    )
      return undefined;
    const ok = record(resultValue, RESULT_OK_KEYS);
    const failed = record(resultValue, RESULT_FAILURE_KEYS);
    if (ok?.get("ok") === true) {
      const plan = parsePlan(ok.get("value"), channel);
      if (plan === undefined || plan.checkedAt > asOf) return undefined;
    } else if (failed?.get("ok") === false) {
      const issues = array(failed.get("issues"), 64);
      if (
        issues === undefined ||
        issues.length === 0 ||
        issues.some((entry) => parseUpdateIssue(entry) === undefined)
      )
        return undefined;
    } else return undefined;
    channels.add(channel);
    output.push(valueEntry as VerifiedLiveStandardsObservation);
  }
  return Object.freeze(output.sort((a, b) => compareUtf8(a.channel, b.channel)));
}

function parsePosition(value: unknown): SourceRange["start"] | undefined {
  const fields = record(value, POSITION_KEYS);
  if (
    fields === undefined ||
    ["byteOffset", "line", "utf16Column", "utf16Offset"].some((key) => {
      const part = fields.get(key);
      return !Number.isSafeInteger(part) || (part as number) < 0;
    })
  )
    return undefined;
  return value as SourceRange["start"];
}

function parseRange(value: unknown): SourceRange | undefined {
  const fields = record(value, RANGE_KEYS);
  const start = parsePosition(fields?.get("start"));
  const end = parsePosition(fields?.get("end"));
  return fields !== undefined &&
    stable(fields.get("sourceId")) &&
    start !== undefined &&
    end !== undefined
    ? (value as SourceRange)
    : undefined;
}

function expectedPosition(text: string, offset: number): SourcePosition | undefined {
  if (
    offset > text.length ||
    (offset > 0 &&
      offset < text.length &&
      /[\uD800-\uDBFF]/u.test(text[offset - 1] ?? "") &&
      /[\uDC00-\uDFFF]/u.test(text[offset] ?? ""))
  )
    return undefined;
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      if (index + 1 < offset) {
        line += 1;
        lineStart = index + 2;
        index += 1;
      }
    } else if (text[index] === "\r" || text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return {
    byteOffset: Buffer.byteLength(text.slice(0, offset), "utf8"),
    line,
    utf16Column: offset - lineStart,
    utf16Offset: offset,
  };
}

function samePosition(left: SourcePosition, right: SourcePosition | undefined): boolean {
  return (
    left.byteOffset === right?.byteOffset &&
    left.line === right.line &&
    left.utf16Column === right.utf16Column &&
    left.utf16Offset === right.utf16Offset
  );
}

function parseDeprecations(
  value: unknown,
  sourceById: ReadonlyMap<string, SourceDocument>,
  selected: {
    readonly digest: string;
    readonly origin: "bundled" | "locked";
    readonly version: string;
  },
): readonly DeprecatedSyntaxObservation[] | undefined {
  const values = array(value, STANDARDS_FRESHNESS_DEFAULT_LIMITS.deprecatedSyntax);
  if (values === undefined) return undefined;
  const output: DeprecatedSyntaxObservation[] = [];
  const identities = new Set<string>();
  for (const entry of values) {
    const fields = record(entry, DEPRECATION_KEYS);
    const evidence = record(fields?.get("evidence"), EVIDENCE_KEYS);
    const pack = record(fields?.get("pack"), PACK_KEYS);
    const range = parseRange(fields?.get("range"));
    const revision = evidence?.get("revision");
    const replacementId = fields?.get("replacementId");
    const url = evidence?.get("url");
    if (
      fields === undefined ||
      evidence === undefined ||
      pack === undefined ||
      range === undefined ||
      !isoDate(fields.get("deprecatedSince")) ||
      !stable(fields.get("profileId")) ||
      !stable(fields.get("sourceId")) ||
      !stable(fields.get("specSnapshotId")) ||
      !stable(fields.get("subjectId")) ||
      !stable(fields.get("surfaceId")) ||
      (replacementId !== null && !stable(replacementId)) ||
      !stable(evidence.get("evidenceRefId")) ||
      !isoDate(evidence.get("retrievedAt")) ||
      (revision !== null && !bounded(revision)) ||
      typeof url !== "string" ||
      url.length > 4_096 ||
      !SHA256.test(String(pack.get("digest"))) ||
      (pack.get("origin") !== "bundled" && pack.get("origin") !== "locked") ||
      parseSemver(pack.get("version")) === undefined ||
      pack.get("digest") !== selected.digest ||
      pack.get("origin") !== selected.origin ||
      pack.get("version") !== selected.version ||
      range.sourceId !== fields.get("sourceId") ||
      !sourceById.has(fields.get("sourceId") as string)
    )
      return undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return undefined;
    } catch {
      return undefined;
    }
    const source = sourceById.get(fields.get("sourceId") as string);
    if (
      source === undefined ||
      range.start.utf16Offset > range.end.utf16Offset ||
      !samePosition(range.start, expectedPosition(source.text, range.start.utf16Offset)) ||
      !samePosition(range.end, expectedPosition(source.text, range.end.utf16Offset))
    )
      return undefined;
    const identity = `${String(fields.get("sourceId"))}\0${String(range.start.byteOffset)}\0${String(fields.get("subjectId"))}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    output.push(entry as DeprecatedSyntaxObservation);
  }
  return Object.freeze(
    output.sort((a, b) =>
      compareUtf8(
        `${a.sourceId}\0${String(a.range.start.byteOffset)}\0${a.subjectId}`,
        `${b.sourceId}\0${String(b.range.start.byteOffset)}\0${b.subjectId}`,
      ),
    ),
  );
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

function anchorRange(source: SourceDocument, ir: InstructionIr): SourceRange {
  const root = ir.nodes.find((node) => node.id === source.rootNodeId);
  if (root === undefined) throw new TypeError("validated source root is missing");
  const childById = new Map(ir.nodes.map((node) => [node.id, node]));
  return (
    root.childIds
      .map((id) => childById.get(id))
      .find((node) => node !== undefined && node.kind !== "html-comment")?.range ?? root.range
  );
}

function location(source: SourceDocument, range: SourceRange): DiagnosticSourceLocation {
  return Object.freeze({
    path: source.path,
    range,
    sourceDigest: source.sha256,
    sourceId: source.id,
  });
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareUtf8(left.primary.path, right.primary.path) ||
    left.primary.range.start.byteOffset - right.primary.range.start.byteOffset ||
    compareUtf8(left.ruleId, right.ruleId) ||
    compareUtf8(left.id, right.id)
  );
}

function repositoryEvidence(
  primary: DiagnosticSourceLocation,
  collectorId: string,
  label: string,
  ...values: readonly string[]
): RepositoryFactRelatedEvidence {
  const digest = sha256(collectorId, label, ...values);
  return Object.freeze({
    collectorId,
    factId: `${collectorId}:${digest.slice(0, 24)}`,
    id: `evidence:${digest.slice(0, 32)}` as RelatedEvidenceId,
    kind: "repository-fact",
    label,
    locations: Object.freeze([primary]),
    subjectPath: primary.path,
    valueDigest: digest,
  });
}

function specEvidence(value: DeprecatedSyntaxObservation): SpecRelatedEvidence {
  return Object.freeze({
    evidenceRefId: value.evidence.evidenceRefId,
    factId: value.subjectId,
    id: `evidence:${sha256(value.evidence.evidenceRefId, value.subjectId).slice(0, 32)}` as RelatedEvidenceId,
    kind: "spec",
    label: "Selected specification deprecation evidence",
    retrievedAt: value.evidence.retrievedAt,
    revision: value.evidence.revision,
    specSnapshotId: value.specSnapshotId,
    url: value.evidence.url,
  });
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  input: {
    readonly anchor: string;
    readonly components: readonly FingerprintComponent[];
    readonly message: string;
    readonly primary: DiagnosticSourceLocation;
    readonly profiles?: readonly string[];
    readonly related: readonly RelatedEvidence[];
    readonly ruleId: StandardsFreshnessRuleId;
    readonly suggestion: string;
  },
): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS_PER_BUNDLE) throw new RangeError("diagnostic limit");
  const profileIds: readonly ClientProfileId[] = Object.freeze(
    [...(input.profiles ?? [])].sort(compareUtf8),
  );
  const pathBasis = Object.freeze({ anchor: input.anchor, profileIds });
  const semanticBasis = Object.freeze({
    components: Object.freeze([...input.components].sort((a, b) => compareUtf8(a.key, b.key))),
    profileIds,
  });
  const semantic = computeSemanticFingerprint({
    basis: semanticBasis,
    ruleId: input.ruleId,
    ruleVersion: STANDARDS_FRESHNESS_RULE_VERSION,
  });
  const metadata = findRuleMetadata(input.ruleId);
  if (metadata === undefined) throw new TypeError("freshness rule is absent from B09 registry");
  diagnostics.push(
    Object.freeze({
      fingerprintBasis: Object.freeze({ path: pathBasis, semantic: semanticBasis }),
      fingerprints: Object.freeze({
        path: Object.freeze({
          method: PATH_FINGERPRINT_METHOD,
          value: computePathFingerprint({
            basis: pathBasis,
            path: input.primary.path,
            ruleId: input.ruleId,
            ruleVersion: STANDARDS_FRESHNESS_RULE_VERSION,
          }),
        }),
        semantic: Object.freeze({ method: SEMANTIC_FINGERPRINT_METHOD, value: semantic }),
      }),
      id: `diagnostic:${input.ruleId.toLowerCase()}:${semantic.slice(0, 32)}` as DiagnosticId,
      message: input.message,
      primary: input.primary,
      related: Object.freeze([...input.related]),
      ruleId: input.ruleId,
      ruleVersion: STANDARDS_FRESHNESS_RULE_VERSION,
      severity: metadata.defaultSeverity,
      suggestion: Object.freeze({ fixPlan: null, message: input.suggestion }),
    }),
  );
}

function validateInput(
  rawInput: unknown,
):
  | { ok: true; value: ValidatedInput; status: OfflineStandardsStatusReport }
  | { ok: false; issue: StandardsFreshnessRuleIssue } {
  const input = record(rawInput, INPUT_KEYS);
  if (
    input?.get("recordKind") !== "agent-context-standards-freshness-rule-input" ||
    input.get("contractVersion") !== STANDARDS_FRESHNESS_RULE_CONTRACT_VERSION
  )
    return {
      ok: false,
      issue: issue("invalid-input", "$", "input kind or contract version is invalid"),
    };
  if (
    (input.get("environment") !== "ci" && input.get("environment") !== "local") ||
    typeof input.get("previewEnabled") !== "boolean" ||
    !stable(input.get("anchorSourceId"))
  )
    return {
      ok: false,
      issue: issue(
        "invalid-input",
        "$",
        "execution policy and anchor must satisfy the closed contract",
      ),
    };
  const validatedIr = validateInstructionIr(input.get("ir"));
  if (!validatedIr.ok)
    return {
      ok: false,
      issue: issue("invalid-input", "$.ir", "must satisfy the closed B03 IR contract"),
    };
  const sourceById = new Map(
    validatedIr.value.sources.map((source) => [source.id as string, source]),
  );
  const anchor = sourceById.get(input.get("anchorSourceId") as string);
  if (anchor === undefined)
    return {
      ok: false,
      issue: issue("invalid-input", "$.anchorSourceId", "must reference a B03 source"),
    };
  const statusResult = createOfflineStandardsStatus(input.get("statusRequest"));
  if (!statusResult.ok)
    return {
      ok: false,
      issue: issue(
        "dependency-failure",
        "$.statusRequest",
        `H06 rejected status input (${statusResult.issues[0]?.code ?? "unknown"})`,
      ),
    };
  const statusRequest = input.get("statusRequest") as OfflineStandardsStatusRequest;
  const liveUpdates = parseLiveUpdates(input.get("liveUpdates"), statusResult.value.asOf);
  if (liveUpdates === undefined)
    return {
      ok: false,
      issue: issue(
        "invalid-input",
        "$.liveUpdates",
        "must contain bounded, channel-unique H09 results",
      ),
    };
  const selected =
    statusResult.value.output.activation === "locked" && statusResult.value.output.locked !== null
      ? { ...statusResult.value.output.locked, origin: "locked" as const }
      : { ...statusResult.value.output.bundled, origin: "bundled" as const };
  const deprecatedSyntax = parseDeprecations(input.get("deprecatedSyntax"), sourceById, selected);
  if (deprecatedSyntax === undefined)
    return {
      ok: false,
      issue: issue(
        "invalid-input",
        "$.deprecatedSyntax",
        "must be bounded, source-valid, and bound to the selected H06 artifact",
      ),
    };
  return {
    ok: true,
    status: statusResult.value,
    value: {
      anchor,
      deprecatedSyntax,
      environment: input.get("environment") as "ci" | "local",
      ir: validatedIr.value,
      liveUpdates,
      previewEnabled: input.get("previewEnabled") as boolean,
      statusRequest,
    },
  };
}

function successfulPlan(observation: VerifiedLiveStandardsObservation): StandardsUpdatePlan | null {
  return observation.result.ok ? observation.result.value : null;
}

function evaluateStatus(
  diagnostics: Diagnostic[],
  input: ValidatedInput,
  status: OfflineStandardsStatusReport,
): void {
  const primary = location(input.anchor, anchorRange(input.anchor, input.ir));
  const lockedAge = status.age.locked;
  if (lockedAge?.status === "stale")
    addDiagnostic(diagnostics, {
      anchor: "standards-lock:age",
      components: [
        { key: "max-age-days", value: String(lockedAge.maximumAgeDays) },
        { key: "published-at", value: lockedAge.publishedAt },
      ],
      message: `Locked knowledge pack is ${String(lockedAge.ageDays)} days old, exceeding the configured ${String(lockedAge.maximumAgeDays)}-day maximum.`,
      primary,
      related: [
        repositoryEvidence(
          primary,
          "builtin:h06-offline-status",
          "Deterministic H06 locked-pack age",
          status.asOf,
          lockedAge.publishedAt,
          String(lockedAge.maximumAgeDays),
        ),
      ],
      ruleId: "ACL500",
      suggestion:
        "Run an explicit verified standards update and review the proposed lockfile change.",
    });
  const cached = status.output.cachedLatest;
  const liveStable = input.liveUpdates.find((entry) => entry.channel === "stable");
  const liveStablePlan = liveStable === undefined ? null : successfulPlan(liveStable);
  const selectedVersion =
    status.output.activation === "locked" && status.output.locked !== null
      ? status.output.locked.version
      : status.output.bundled.version;
  if (
    liveStablePlan !== null &&
    !liveStablePlan.noChanges &&
    compareSemver(liveStablePlan.diff.version.candidate, selectedVersion) > 0
  )
    addDiagnostic(diagnostics, {
      anchor: "standards-update:stable:verified-live",
      components: [
        { key: "candidate", value: liveStablePlan.diff.version.candidate },
        { key: "checked-at", value: liveStablePlan.checkedAt },
        { key: "origin", value: "verified-live-h09" },
        { key: "selected", value: selectedVersion },
      ],
      message: `Verified live standards check found stable knowledge pack ${liveStablePlan.diff.version.candidate}, newer than selected ${selectedVersion}.`,
      primary,
      related: [
        repositoryEvidence(
          primary,
          "builtin:h09-verified-update",
          "Verified live H09 stable observation",
          liveStablePlan.checkedAt,
          liveStablePlan.signer.metadataSha256,
          liveStablePlan.diff.digest.candidate,
        ),
      ],
      ruleId: "ACL501",
      suggestion:
        "Review the verified dry-run diff, then explicitly update the standards lockfile.",
    });
  else if (
    liveStablePlan === null &&
    status.output.freshness === "update-available" &&
    cached !== null
  )
    addDiagnostic(diagnostics, {
      anchor: "standards-update:stable:cached",
      components: [
        { key: "candidate", value: cached.version },
        { key: "checked-at", value: status.lastCheckedAt ?? cached.retrievedAt },
        { key: "origin", value: "cached-offline" },
        { key: "selected", value: selectedVersion },
      ],
      message: `Cached offline observation from ${status.lastCheckedAt ?? cached.retrievedAt} records stable knowledge pack ${cached.version}, newer than selected ${selectedVersion}; this is not a live freshness claim.`,
      primary,
      related: [
        repositoryEvidence(
          primary,
          "builtin:h06-cached-latest",
          "Untrusted cached H06 freshness observation",
          status.lastCheckedAt ?? cached.retrievedAt,
          cached.digest,
          cached.version,
        ),
      ],
      ruleId: "ACL501",
      suggestion:
        "Confirm the cached observation with an explicit verified standards check before updating.",
    });
  for (const value of status.issues.filter(
    (entry) =>
      entry.code === "lock-engine-incompatible" || entry.code === "cached-engine-incompatible",
  ))
    addDiagnostic(diagnostics, {
      anchor: `standards-engine:${value.source}`,
      components: [
        { key: "issue", value: value.code },
        { key: "origin", value: value.source },
      ],
      message:
        value.code === "cached-engine-incompatible"
          ? "Cached offline metadata describes a knowledge pack that requires a newer CLI engine; it has not been activated."
          : "Locked knowledge pack requires a newer CLI engine and was not activated.",
      primary,
      related: [
        repositoryEvidence(
          primary,
          "builtin:h06-offline-status",
          "Deterministic H06 engine compatibility result",
          status.asOf,
          value.code,
          value.source,
        ),
      ],
      ruleId: "ACL502",
      suggestion: "Upgrade the CLI engine before selecting this knowledge pack.",
    });
  for (const live of input.liveUpdates) {
    const plan = successfulPlan(live);
    if (
      plan !== null &&
      compareSemver(input.statusRequest.engineVersion, plan.diff.engineRequirement.candidate) < 0
    )
      addDiagnostic(diagnostics, {
        anchor: `standards-engine:${live.channel}:verified-live`,
        components: [
          { key: "candidate", value: plan.diff.version.candidate },
          { key: "minimum-engine", value: plan.diff.engineRequirement.candidate },
          { key: "origin", value: "verified-live-h09" },
        ],
        message: `Verified live ${live.channel} knowledge pack ${plan.diff.version.candidate} requires CLI engine ${plan.diff.engineRequirement.candidate} or newer.`,
        primary,
        related: [
          repositoryEvidence(
            primary,
            "builtin:h09-verified-update",
            "Verified live H09 engine requirement",
            plan.checkedAt,
            plan.diff.digest.candidate,
            plan.diff.engineRequirement.candidate,
          ),
        ],
        ruleId: "ACL502",
        suggestion: "Upgrade the CLI engine before selecting this knowledge pack.",
      });
    if (!live.result.ok)
      for (const value of live.result.issues.filter((entry) => TRUST_FAILURE_CODES.has(entry.code)))
        addDiagnostic(diagnostics, {
          anchor: `standards-trust:${live.channel}:${value.code}:${value.path}`,
          components: [
            { key: "channel", value: live.channel },
            { key: "code", value: value.code },
            { key: "origin", value: "verified-live-h09" },
            { key: "path", value: value.path },
          ],
          message: `Verified live ${live.channel} standards update failed trust or integrity validation (${value.code}).`,
          primary,
          related: [
            repositoryEvidence(
              primary,
              "builtin:h09-verified-update-failure",
              "H09 trust failure evidence",
              live.channel,
              value.code,
              value.path,
            ),
          ],
          ruleId: "ACL503",
          suggestion:
            "Keep the last known-good standards data and investigate the failed trust chain.",
        });
  }
  for (const value of status.issues.filter(
    (entry) => entry.code === "invalid-lockfile" || entry.code === "lock-authority-unauthenticated",
  ))
    addDiagnostic(diagnostics, {
      anchor: `standards-trust:lockfile:${value.code}`,
      components: [
        { key: "code", value: value.code },
        { key: "origin", value: "locked" },
      ],
      message:
        value.code === "invalid-lockfile"
          ? "Standards lockfile failed canonical validation and was not activated."
          : "Standards lockfile differs from authenticated authority and was not activated.",
      primary,
      related: [
        repositoryEvidence(
          primary,
          "builtin:h06-offline-status",
          "Deterministic H06 lockfile validation result",
          status.asOf,
          value.code,
        ),
      ],
      ruleId: "ACL503",
      suggestion:
        "Restore a verified lockfile or run the explicit signed standards update workflow.",
    });
  if (input.environment === "ci" && input.statusRequest.lockfile === null)
    addDiagnostic(diagnostics, {
      anchor: "standards-lock:missing-ci",
      components: [
        { key: "environment", value: "ci" },
        { key: "selected-digest", value: status.output.bundled.digest },
      ],
      message: "Repository standards lockfile is missing in CI.",
      primary,
      related: [
        repositoryEvidence(
          primary,
          "builtin:h06-offline-status",
          "H06 lockfile absence in CI",
          status.asOf,
          status.output.bundled.digest,
        ),
      ],
      ruleId: "ACL505",
      suggestion: "Create and commit a verified standards lockfile so CI scans are reproducible.",
    });
  const livePreview = input.liveUpdates.find((entry) => entry.channel === "preview");
  const previewPlan = livePreview === undefined ? null : successfulPlan(livePreview);
  if (!input.previewEnabled && previewPlan !== null && !previewPlan.noChanges)
    addDiagnostic(diagnostics, {
      anchor: "standards-preview:verified-live",
      components: [
        { key: "candidate", value: previewPlan.diff.version.candidate },
        { key: "checked-at", value: previewPlan.checkedAt },
        { key: "origin", value: "verified-live-h09" },
      ],
      message: `Verified live standards check found preview knowledge pack ${previewPlan.diff.version.candidate}, but preview behavior is not enabled.`,
      primary,
      related: [
        repositoryEvidence(
          primary,
          "builtin:h09-verified-update",
          "Verified live H09 preview observation",
          previewPlan.checkedAt,
          previewPlan.signer.metadataSha256,
          previewPlan.diff.digest.candidate,
        ),
      ],
      ruleId: "ACL506",
      suggestion:
        "Keep stable semantics, or explicitly enable preview after reviewing its verified diff.",
    });
}

function evaluateDeprecations(
  diagnostics: Diagnostic[],
  input: ValidatedInput,
  asOf: string,
): void {
  const sourceById = new Map(input.ir.sources.map((source) => [source.id as string, source]));
  for (const value of input.deprecatedSyntax) {
    if (value.deprecatedSince > asOf.slice(0, 10)) continue;
    const source = sourceById.get(value.sourceId);
    if (source === undefined) throw new TypeError("validated deprecation source is missing");
    addDiagnostic(diagnostics, {
      anchor: `deprecated:${value.sourceId}:${String(value.range.start.byteOffset)}:${value.subjectId}`,
      components: [
        { key: "deprecated-since", value: value.deprecatedSince },
        { key: "pack-digest", value: value.pack.digest },
        { key: "subject", value: value.subjectId },
      ],
      message: `Repository uses '${value.subjectId}', deprecated by the selected specification since ${value.deprecatedSince}.`,
      primary: location(source, value.range),
      profiles: [value.profileId],
      related: [specEvidence(value)],
      ruleId: "ACL504",
      suggestion:
        value.replacementId === null
          ? "Review the selected specification and migrate away from the deprecated syntax."
          : `Migrate to '${value.replacementId}' as documented by the selected specification.`,
    });
  }
}

export function evaluateStandardsFreshnessRules(rawInput: unknown): StandardsFreshnessRuleResult {
  const validated = validateInput(rawInput);
  if (!validated.ok) return failure(validated.issue);
  try {
    const diagnostics: Diagnostic[] = [];
    evaluateStatus(diagnostics, validated.value, validated.status);
    evaluateDeprecations(diagnostics, validated.value, validated.status.asOf);
    const suppression = parseSuppressionDirectives(validated.value.ir);
    const bundle: DiagnosticBundle = Object.freeze({
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
      recordKind: "agent-context-diagnostics",
      suppressions: Object.freeze(suppression.directives.map((entry) => entry.record)),
    });
    const checked = validateDiagnosticBundle(bundle, validated.value.ir.sources);
    if (!checked.ok)
      return failure(
        issue("dependency-failure", "$output", "generated output failed B04 validation"),
      );
    const result = Object.freeze({
      bundle: checked.value,
      metrics: Object.freeze({
        cachedObservationCount: validated.status.output.cachedLatest === null ? 0 : 1,
        deprecatedObservationCount: validated.value.deprecatedSyntax.length,
        diagnosticCount: checked.value.diagnostics.length,
        liveObservationCount: validated.value.liveUpdates.length,
        suppressionDirectiveCount: suppression.directives.length,
      }),
      ok: true as const,
      sources: Object.freeze([...validated.value.ir.sources]),
      status: validated.status,
    });
    issuedEvaluations.set(result, { directives: suppression.directives, ir: validated.value.ir });
    return result;
  } catch (error) {
    return failure(
      issue(
        error instanceof RangeError ? "resource-limit" : "dependency-failure",
        "$",
        error instanceof RangeError
          ? "a bounded evaluation resource limit was exceeded"
          : "a deterministic dependency rejected the validated input",
      ),
    );
  }
}

export function finalizeStandardsFreshnessSuppressions(
  evaluation: unknown,
  additionalDiagnostics: unknown = [],
): StandardsFreshnessSuppressionFinalizationResult {
  if (evaluation === null || typeof evaluation !== "object" || nodeTypes.isProxy(evaluation))
    return finalizationFailure(
      issue("invalid-input", "$.evaluation", "must be an issued evaluation"),
    );
  const issued = issuedEvaluations.get(evaluation);
  if (issued === undefined)
    return finalizationFailure(
      issue("invalid-input", "$.evaluation", "must be an issued evaluation"),
    );
  const extra = array(additionalDiagnostics, MAX_DIAGNOSTICS_PER_BUNDLE);
  if (extra === undefined)
    return finalizationFailure(
      issue("invalid-input", "$.additionalDiagnostics", "must be a bounded dense array"),
    );
  const result = evaluation as Extract<StandardsFreshnessRuleResult, { readonly ok: true }>;
  const candidate: DiagnosticBundle = Object.freeze({
    ...result.bundle,
    diagnostics: Object.freeze([...result.bundle.diagnostics, ...(extra as readonly Diagnostic[])]),
  });
  const checked = validateDiagnosticBundle(candidate, issued.ir.sources);
  if (!checked.ok)
    return finalizationFailure(
      issue("invalid-input", "$.additionalDiagnostics", "must contain valid B04 diagnostics"),
    );
  const applicable: DiagnosticBundle = Object.freeze({
    ...checked.value,
    diagnostics: Object.freeze([...checked.value.diagnostics].sort(compareDiagnostics)),
  });
  try {
    const matched = matchSuppressionDirectives(applicable, issued.directives, issued.ir.sources);
    const validated = validateDiagnosticBundle(matched.bundle, issued.ir.sources);
    if (!validated.ok)
      return finalizationFailure(
        issue("dependency-failure", "$output", "generated output failed B04 validation"),
      );
    const suppressed = new Set(matched.suppressedDiagnostics.map((entry) => entry.diagnostic.id));
    return Object.freeze({
      bundle: validated.value,
      ok: true,
      suppressedDiagnostics: Object.freeze(
        validated.value.diagnostics.filter((entry) => suppressed.has(entry.id)),
      ),
      visibleDiagnostics: Object.freeze(
        validated.value.diagnostics.filter((entry) => !suppressed.has(entry.id)),
      ),
    });
  } catch {
    return finalizationFailure(
      issue("dependency-failure", "$", "the suppression processor rejected the validated input"),
    );
  }
}
