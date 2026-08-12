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
  ClientProfileId,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticFingerprintBasis,
  DiagnosticId,
  DiagnosticSeverity,
  DiagnosticSourceLocation,
  InstructionDocument,
  InstructionIr,
  InstructionStatement,
  RelatedEvidence,
  RelatedEvidenceId,
  RepositoryRelativePath,
  SourceDocument,
} from "@agent-context/core";
import {
  STATEMENT_CLASSIFIER_CONTRACT_VERSION,
  StatementClassifierError,
  StatementClassifierErrorCode,
  normalizeAndClassifyStatement,
} from "@agent-context/evidence";
import type {
  StatementClassifierResult,
  StatementDomainClassification,
} from "@agent-context/evidence";
import {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  isIssuedCrossProfileComparison,
} from "@agent-context/resolver";
import type {
  CrossProfileComparison,
  CrossProfilePairComparison,
  CrossProfileProfileSummary,
} from "@agent-context/resolver";
import { matchSuppressionDirectives, parseSuppressionDirectives } from "@agent-context/syntax";
import type { ParsedSuppressionDirective } from "@agent-context/syntax";

export const PORTABILITY_RULE_CONTRACT_VERSION = "0.1.0" as const;
export const PORTABILITY_RULE_VERSION = "1.0.0" as const;
export const PORTABILITY_RULE_IDS = ["ACL450", "ACL451", "ACL452", "ACL453"] as const;
export type PortabilityRuleId = (typeof PORTABILITY_RULE_IDS)[number];

export const PORTABILITY_SUPPORT_STATES = [
  "conditional",
  "recognized",
  "supported",
  "unknown",
  "unsupported",
] as const;
export type PortabilitySupportState = (typeof PORTABILITY_SUPPORT_STATES)[number];

export const PORTABILITY_BEHAVIOR_KINDS = ["editor-feature", "import", "nesting"] as const;
export type PortabilityBehaviorKind = (typeof PORTABILITY_BEHAVIOR_KINDS)[number];

export interface PortabilityFormatObservation {
  readonly documentId: string;
  readonly profileId: ClientProfileId;
  readonly state: PortabilitySupportState;
  readonly surfaceId: string;
}

export interface PortabilityBehaviorObservation {
  readonly behaviorId: string;
  readonly documentId: string;
  readonly kind: PortabilityBehaviorKind;
  readonly profileId: ClientProfileId;
  readonly state: PortabilitySupportState;
  readonly statementId: string;
  readonly surfaceId: string;
}

export interface PortabilityRuleInput {
  readonly behaviorObservations: readonly PortabilityBehaviorObservation[];
  readonly comparisons: readonly CrossProfileComparison[];
  readonly contractVersion: typeof PORTABILITY_RULE_CONTRACT_VERSION;
  readonly formatInventoryState: "complete" | "partial";
  readonly formatObservations: readonly PortabilityFormatObservation[];
  readonly ir: InstructionIr;
  readonly recordKind: "agent-context-portability-rule-input";
}

export interface PortabilityRuleLimits {
  readonly maximumBehaviorObservations: number;
  readonly maximumComparisons: number;
  readonly maximumDiagnostics: number;
  readonly maximumFormatObservations: number;
  readonly maximumPairWork: number;
  readonly maximumStatements: number;
  readonly maximumTextLength: number;
  readonly maximumUncertainties: number;
}

export type PortabilityRuleOptions = Partial<PortabilityRuleLimits>;

export const PORTABILITY_RULE_DEFAULT_LIMITS: Readonly<PortabilityRuleLimits> = Object.freeze({
  maximumBehaviorObservations: 100_000,
  maximumComparisons: 10_000,
  maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
  maximumFormatObservations: 100_000,
  maximumPairWork: 2_000_000,
  maximumStatements: 100_000,
  maximumTextLength: 65_536,
  maximumUncertainties: 250_000,
});

export const PORTABILITY_RULE_HARD_LIMITS: Readonly<PortabilityRuleLimits> = Object.freeze({
  maximumBehaviorObservations: 1_000_000,
  maximumComparisons: 100_000,
  maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
  maximumFormatObservations: 1_000_000,
  maximumPairWork: 20_000_000,
  maximumStatements: 1_000_000,
  maximumTextLength: 1_048_576,
  maximumUncertainties: 250_000,
});

export type PortabilityUncertaintyReason =
  | "behavior-support-indeterminate"
  | "comparison-indeterminate"
  | "format-inventory-partial"
  | "format-support-indeterminate"
  | "statement-unclassified";

export interface PortabilityUncertainty {
  readonly documentId: string;
  readonly profileId: ClientProfileId | null;
  readonly reason: PortabilityUncertaintyReason;
  readonly statementId: string | null;
}

export interface PortabilityRuleMetrics {
  readonly behaviorObservationCount: number;
  readonly comparisonCount: number;
  readonly diagnosticCount: number;
  readonly formatObservationCount: number;
  readonly pairWork: number;
  readonly statementCount: number;
  readonly suppressionDirectiveCount: number;
  readonly uncertaintyCount: number;
}

export type PortabilityRuleIssueCode =
  "dependency-failure" | "invalid-input" | "invalid-options" | "resource-limit";

export interface PortabilityRuleIssue {
  readonly code: PortabilityRuleIssueCode;
  readonly message: string;
  readonly path: string;
}

export type PortabilityRuleResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly classifierContractVersion: typeof STATEMENT_CLASSIFIER_CONTRACT_VERSION;
      readonly comparisonContractVersion: typeof CROSS_PROFILE_COMPARISON_CONTRACT_VERSION;
      readonly contractVersion: typeof PORTABILITY_RULE_CONTRACT_VERSION;
      readonly limits: PortabilityRuleLimits;
      readonly metrics: PortabilityRuleMetrics;
      readonly ok: true;
      readonly sources: readonly SourceDocument[];
      readonly uncertainties: readonly PortabilityUncertainty[];
    }
  | { readonly issues: readonly PortabilityRuleIssue[]; readonly ok: false };

export type PortabilitySuppressionFinalizationResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly ok: true;
      readonly suppressedDiagnostics: readonly Diagnostic[];
      readonly visibleDiagnostics: readonly Diagnostic[];
    }
  | { readonly issues: readonly PortabilityRuleIssue[]; readonly ok: false };

interface ClassifiedStatement {
  readonly classification: StatementClassifierResult;
  readonly document: InstructionDocument;
  readonly domains: readonly StatementDomainClassification[];
  readonly source: SourceDocument;
  readonly statement: InstructionStatement;
}

interface ValidatedFormatObservation extends PortabilityFormatObservation {
  readonly profileSummaryId: string;
}

interface ValidatedBehaviorObservation extends PortabilityBehaviorObservation {
  readonly profileSummaryId: string;
}

interface Finding {
  readonly behaviorId: string | null;
  readonly message: string;
  readonly primary: ClassifiedStatement;
  readonly profileIds: Set<ClientProfileId>;
  readonly related: ClassifiedStatement | null;
  readonly relatedLabel: string;
  readonly ruleId: PortabilityRuleId;
  readonly semanticKey: string;
  readonly targets: Set<RepositoryRelativePath>;
}

interface EvaluationState {
  pairWork: number;
  readonly findings: Map<string, Finding>;
  readonly limits: PortabilityRuleLimits;
  readonly uncertainties: PortabilityUncertainty[];
  readonly uncertaintyKeys: Set<string>;
}

type DataRecord = Readonly<Record<string, unknown>>;

const INPUT_KEYS = new Set([
  "behaviorObservations",
  "comparisons",
  "contractVersion",
  "formatInventoryState",
  "formatObservations",
  "ir",
  "recordKind",
]);
const FORMAT_OBSERVATION_KEYS = new Set(["documentId", "profileId", "state", "surfaceId"]);
const BEHAVIOR_OBSERVATION_KEYS = new Set([
  "behaviorId",
  "documentId",
  "kind",
  "profileId",
  "state",
  "statementId",
  "surfaceId",
]);
const LIMIT_KEYS = new Set(Object.keys(PORTABILITY_RULE_DEFAULT_LIMITS));
const SUPPORT_STATES = new Set<string>(PORTABILITY_SUPPORT_STATES);
const BEHAVIOR_KINDS = new Set<string>(PORTABILITY_BEHAVIOR_KINDS);
const STABLE_ID = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const SHARED_FORMAT_ID = "agents-markdown";
const EDITOR_SURFACES = new Set(["copilot-vscode/local-chat", "cursor-agent/ide"]);
const SEVERITY: Readonly<Record<PortabilityRuleId, DiagnosticSeverity>> = Object.freeze({
  ACL450: "warning",
  ACL451: "warning",
  ACL452: "info",
  ACL453: "info",
});
const MESSAGES: Readonly<Record<PortabilityRuleId, string>> = Object.freeze({
  ACL450: "A structured policy is available only through a vendor-specific instruction format.",
  ACL451: "The same structured policy differs across supported agent instruction formats.",
  ACL452: "A selected agent surface does not support this import or nesting behavior.",
  ACL453: "This instruction behavior is available only on an editor surface.",
});
const issuedEvaluations = new WeakMap<
  object,
  { readonly directives: readonly ParsedSuppressionDirective[]; readonly ir: InstructionIr }
>();

function issue(
  code: PortabilityRuleIssueCode,
  path: string,
  message: string,
): PortabilityRuleIssue {
  return Object.freeze({ code, message, path });
}

class PortabilityEvaluationError extends Error {
  override readonly name = "PortabilityEvaluationError" as const;
  readonly detail: PortabilityRuleIssue;

  constructor(detail: PortabilityRuleIssue) {
    super(detail.message);
    this.detail = detail;
    Object.freeze(this);
  }
}

function abort(detail: PortabilityRuleIssue): never {
  throw new PortabilityEvaluationError(detail);
}

function failure(detail: PortabilityRuleIssue): PortabilityRuleResult {
  return Object.freeze({ issues: Object.freeze([detail]), ok: false });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function digest(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function isPlainRecord(value: unknown): value is DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return false;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function closedRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): DataRecord | PortabilityRuleIssue {
  if (!isPlainRecord(value))
    return issue("invalid-input", path, "must be a closed non-proxy data object");
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return issue("invalid-input", path, "must be safely inspectable inert data");
  }
  if (keys.length !== allowed.size)
    return issue("invalid-input", path, "has unknown or missing fields");
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key))
      return issue("invalid-input", path, "has unknown or symbol fields");
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return issue("invalid-input", `${path}.${key}`, "must be an enumerable data property");
  }
  return value;
}

function field(record: DataRecord, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function denseArray(
  value: unknown,
  maximum: number,
  path: string,
): readonly unknown[] | PortabilityRuleIssue {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return issue("invalid-input", path, "must be a regular dense array");
  if (value.length > maximum) return issue("resource-limit", path, "exceeds its item limit");
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return issue("invalid-input", path, "must be safely inspectable inert data");
  }
  if (keys.length !== value.length + 1)
    return issue("invalid-input", path, "must not be sparse or extended");
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return issue("invalid-input", path, "must contain only own data entries");
    output.push(descriptor.value);
  }
  return output;
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    Buffer.byteLength(value, "utf8") <= 2_048 &&
    STABLE_ID.test(value)
  );
}

function limits(raw: unknown): PortabilityRuleLimits | PortabilityRuleIssue {
  if (raw === undefined) return PORTABILITY_RULE_DEFAULT_LIMITS;
  if (!isPlainRecord(raw))
    return issue("invalid-options", "$options", "must be a closed non-proxy data object");
  const selected: Record<string, number> = { ...PORTABILITY_RULE_DEFAULT_LIMITS };
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(raw);
  } catch {
    return issue("invalid-options", "$options", "must be safely inspectable inert data");
  }
  for (const key of keys) {
    if (typeof key !== "string" || !LIMIT_KEYS.has(key))
      return issue("invalid-options", "$options", "has an unknown option");
    const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return issue("invalid-options", `$options.${key}`, "must be an enumerable data property");
    const value = descriptor.value;
    const maximum = PORTABILITY_RULE_HARD_LIMITS[key as keyof PortabilityRuleLimits];
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
      return issue("invalid-options", `$options.${key}`, "is outside the supported integer range");
    selected[key] = value as number;
  }
  return Object.freeze(selected) as unknown as PortabilityRuleLimits;
}

function profileIndex(
  comparisons: readonly CrossProfileComparison[],
): ReadonlyMap<string, CrossProfileProfileSummary> | PortabilityRuleIssue {
  const profiles = new Map<string, CrossProfileProfileSummary>();
  for (const comparison of comparisons)
    for (const profile of comparison.profiles) {
      const key = `${profile.profileId}\u0000${profile.surfaceId}`;
      const previous = profiles.get(key);
      if (previous !== undefined && previous.id !== profile.id)
        return issue(
          "invalid-input",
          "$.comparisons",
          "mixes incompatible versions of one profile/surface identity",
        );
      profiles.set(key, profile);
    }
  return profiles;
}

function comparisons(
  raw: unknown,
  selectedLimits: PortabilityRuleLimits,
): readonly CrossProfileComparison[] | PortabilityRuleIssue {
  const entries = denseArray(raw, selectedLimits.maximumComparisons, "$.comparisons");
  if (isPortabilityIssue(entries)) return entries;
  if (entries.length === 0)
    return issue("invalid-input", "$.comparisons", "requires at least one E07 comparison");
  const seen = new Set<object>();
  const output: CrossProfileComparison[] = [];
  for (const entry of entries) {
    if (!isIssuedCrossProfileComparison(entry))
      return issue(
        "invalid-input",
        "$.comparisons",
        "must contain only same-process E07 comparison results",
      );
    if (seen.has(entry))
      return issue("invalid-input", "$.comparisons", "must not contain duplicate results");
    seen.add(entry);
    output.push(entry);
  }
  return Object.freeze(
    output.sort((left, right) => compareUtf8(left.targetPath, right.targetPath)),
  );
}

function formatObservations(
  raw: unknown,
  selectedLimits: PortabilityRuleLimits,
  documents: ReadonlyMap<string, InstructionDocument>,
  profiles: ReadonlyMap<string, CrossProfileProfileSummary>,
): readonly ValidatedFormatObservation[] | PortabilityRuleIssue {
  const entries = denseArray(raw, selectedLimits.maximumFormatObservations, "$.formatObservations");
  if (isPortabilityIssue(entries)) return entries;
  const output: ValidatedFormatObservation[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const path = `$.formatObservations[${String(index)}]`;
    const record = closedRecord(entries[index], FORMAT_OBSERVATION_KEYS, path);
    if (isPortabilityIssue(record)) return record;
    const documentId = field(record, "documentId");
    const profileId = field(record, "profileId");
    const state = field(record, "state");
    const surfaceId = field(record, "surfaceId");
    if (
      !boundedIdentifier(documentId) ||
      !boundedIdentifier(profileId) ||
      !boundedIdentifier(surfaceId) ||
      typeof state !== "string" ||
      !SUPPORT_STATES.has(state)
    )
      return issue("invalid-input", path, "contains an invalid observation field");
    if (!documents.has(documentId))
      return issue("invalid-input", `${path}.documentId`, "does not identify a B03 document");
    const profile = profiles.get(`${profileId}\u0000${surfaceId}`);
    if (profile === undefined)
      return issue(
        "invalid-input",
        path,
        "does not identify a profile/surface in the supplied E07 evidence",
      );
    const key = `${documentId}\u0000${profileId}\u0000${surfaceId}`;
    if (seen.has(key)) return issue("invalid-input", path, "duplicates a format observation");
    seen.add(key);
    output.push(
      Object.freeze({
        documentId,
        profileId,
        profileSummaryId: profile.id,
        state: state as PortabilitySupportState,
        surfaceId,
      }),
    );
  }
  return Object.freeze(
    output.sort(
      (left, right) =>
        compareUtf8(left.documentId, right.documentId) ||
        compareUtf8(left.profileId, right.profileId) ||
        compareUtf8(left.surfaceId, right.surfaceId),
    ),
  );
}

function behaviorObservations(
  raw: unknown,
  selectedLimits: PortabilityRuleLimits,
  documents: ReadonlyMap<string, InstructionDocument>,
  statements: ReadonlyMap<string, InstructionStatement>,
  profiles: ReadonlyMap<string, CrossProfileProfileSummary>,
): readonly ValidatedBehaviorObservation[] | PortabilityRuleIssue {
  const entries = denseArray(
    raw,
    selectedLimits.maximumBehaviorObservations,
    "$.behaviorObservations",
  );
  if (isPortabilityIssue(entries)) return entries;
  const output: ValidatedBehaviorObservation[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const path = `$.behaviorObservations[${String(index)}]`;
    const record = closedRecord(entries[index], BEHAVIOR_OBSERVATION_KEYS, path);
    if (isPortabilityIssue(record)) return record;
    const behaviorId = field(record, "behaviorId");
    const documentId = field(record, "documentId");
    const kind = field(record, "kind");
    const profileId = field(record, "profileId");
    const state = field(record, "state");
    const statementId = field(record, "statementId");
    const surfaceId = field(record, "surfaceId");
    if (
      !boundedIdentifier(behaviorId) ||
      !boundedIdentifier(documentId) ||
      !boundedIdentifier(profileId) ||
      !boundedIdentifier(statementId) ||
      !boundedIdentifier(surfaceId) ||
      typeof kind !== "string" ||
      !BEHAVIOR_KINDS.has(kind) ||
      typeof state !== "string" ||
      !SUPPORT_STATES.has(state)
    )
      return issue("invalid-input", path, "contains an invalid observation field");
    const document = documents.get(documentId);
    const statement = statements.get(statementId);
    if (document === undefined || statement?.documentId !== document.id)
      return issue(
        "invalid-input",
        path,
        "must identify a B03 statement owned by the observed document",
      );
    const profile = profiles.get(`${profileId}\u0000${surfaceId}`);
    if (profile === undefined)
      return issue(
        "invalid-input",
        path,
        "does not identify a profile/surface in the supplied E07 evidence",
      );
    const key = `${behaviorId}\u0000${documentId}\u0000${kind}\u0000${profileId}\u0000${surfaceId}`;
    if (seen.has(key)) return issue("invalid-input", path, "duplicates a behavior observation");
    seen.add(key);
    output.push(
      Object.freeze({
        behaviorId,
        documentId,
        kind: kind as PortabilityBehaviorKind,
        profileId,
        profileSummaryId: profile.id,
        state: state as PortabilitySupportState,
        statementId,
        surfaceId,
      }),
    );
  }
  return Object.freeze(
    output.sort(
      (left, right) =>
        compareUtf8(left.behaviorId, right.behaviorId) ||
        compareUtf8(left.documentId, right.documentId) ||
        compareUtf8(left.profileId, right.profileId) ||
        compareUtf8(left.surfaceId, right.surfaceId),
    ),
  );
}

function classifyStatements(
  ir: InstructionIr,
  selectedLimits: PortabilityRuleLimits,
): readonly ClassifiedStatement[] | PortabilityRuleIssue {
  if (ir.statements.length > selectedLimits.maximumStatements)
    return issue("resource-limit", "$.ir.statements", "statement limit was exceeded");
  const documentById = new Map(ir.documents.map((document) => [document.id, document]));
  const sourceById = new Map(ir.sources.map((source) => [source.id, source]));
  const output: ClassifiedStatement[] = [];
  try {
    for (const statement of [...ir.statements].sort((left, right) =>
      compareUtf8(left.id, right.id),
    )) {
      if (statement.text.length > selectedLimits.maximumTextLength)
        return issue("resource-limit", "$.ir.statements", "statement text limit was exceeded");
      const document = documentById.get(statement.documentId);
      const source = document === undefined ? undefined : sourceById.get(document.sourceId);
      if (document === undefined || source === undefined)
        return issue("dependency-failure", "$.ir", "statement ownership is incomplete");
      const classification = normalizeAndClassifyStatement({
        documentId: statement.documentId,
        nodeIds: statement.nodeIds,
        range: statement.range,
        statementId: statement.id,
        text: statement.text,
      });
      const domains = Object.freeze(
        classification.domains.filter((domain) => domain.confidence >= 0.95),
      );
      output.push(Object.freeze({ classification, document, domains, source, statement }));
    }
  } catch (error) {
    const limited =
      error instanceof StatementClassifierError &&
      error.code === StatementClassifierErrorCode.limitExceeded;
    return issue(
      limited ? "resource-limit" : "dependency-failure",
      "$.ir.statements",
      limited ? "F03 statement-classifier limit was exceeded" : "F03 rejected B03 statement data",
    );
  }
  return Object.freeze(output);
}

function addUncertainty(
  state: EvaluationState,
  reason: PortabilityUncertaintyReason,
  documentId: string,
  statementId: string | null,
  profileId: ClientProfileId | null,
): void {
  const key = `${reason}\u0000${documentId}\u0000${statementId ?? ""}\u0000${profileId ?? ""}`;
  if (state.uncertaintyKeys.has(key)) return;
  if (state.uncertainties.length >= state.limits.maximumUncertainties)
    abort(issue("resource-limit", "$output.uncertainties", "uncertainty limit was exceeded"));
  state.uncertaintyKeys.add(key);
  state.uncertainties.push(Object.freeze({ documentId, profileId, reason, statementId }));
}

function incrementPairWork(state: EvaluationState): void {
  state.pairWork += 1;
  if (state.pairWork > state.limits.maximumPairWork)
    abort(issue("resource-limit", "$evaluation", "pair-work limit was exceeded"));
}

function exactKey(domain: StatementDomainClassification): string {
  return [
    domain.domain,
    domain.action,
    domain.subject ?? "",
    domain.object ?? "",
    domain.modality,
  ].join("\u0000");
}

function subjectKey(domain: StatementDomainClassification): string {
  return [domain.domain, domain.action, domain.subject ?? ""].join("\u0000");
}

function pairBetween(
  comparison: CrossProfileComparison,
  leftSummaryId: string,
  rightSummaryId: string,
): CrossProfilePairComparison | undefined {
  return comparison.pairs.find(
    (pair) =>
      (pair.leftProfileId === leftSummaryId && pair.rightProfileId === rightSummaryId) ||
      (pair.leftProfileId === rightSummaryId && pair.rightProfileId === leftSummaryId),
  );
}

function divergenceTargets(
  comparisons: readonly CrossProfileComparison[],
  left: ValidatedFormatObservation | ValidatedBehaviorObservation,
  right: ValidatedFormatObservation | ValidatedBehaviorObservation,
  paths: ReadonlySet<RepositoryRelativePath>,
  state: EvaluationState,
): readonly RepositoryRelativePath[] {
  const targets: RepositoryRelativePath[] = [];
  for (const comparison of comparisons) {
    const pair = pairBetween(comparison, left.profileSummaryId, right.profileSummaryId);
    if (pair === undefined) continue;
    incrementPairWork(state);
    if (pair.overall === "indeterminate") continue;
    const scopePath = pair.scope.differences.some((entry) => paths.has(entry.path));
    const contentPath = pair.content.differences.some((entry) => paths.has(entry.path));
    if (pair.overall === "divergent" && (scopePath || contentPath))
      targets.push(comparison.targetPath);
  }
  return Object.freeze([...new Set(targets)].sort(compareUtf8));
}

function addFinding(
  state: EvaluationState,
  finding: Omit<Finding, "profileIds" | "targets"> & {
    readonly profileIds: readonly ClientProfileId[];
    readonly targets: readonly RepositoryRelativePath[];
  },
): void {
  const key = digest(
    finding.ruleId,
    finding.primary.statement.id,
    finding.related?.statement.id ?? "",
    finding.behaviorId ?? "",
    finding.semanticKey,
  );
  const existing = state.findings.get(key);
  if (existing !== undefined) {
    for (const profileId of finding.profileIds) existing.profileIds.add(profileId);
    for (const target of finding.targets) existing.targets.add(target);
    return;
  }
  state.findings.set(
    key,
    Object.freeze({
      ...finding,
      profileIds: new Set(finding.profileIds),
      targets: new Set(finding.targets),
    }),
  );
}

function evaluateVendorOnly(
  state: EvaluationState,
  classified: readonly ClassifiedStatement[],
  formatObservationsValue: readonly ValidatedFormatObservation[],
  comparisonsValue: readonly CrossProfileComparison[],
  inventoryState: "complete" | "partial",
): void {
  const sharedKeys = new Set(
    classified
      .filter((entry) => entry.document.formatId === SHARED_FORMAT_ID)
      .flatMap((entry) => entry.domains.map(exactKey)),
  );
  const sharedIndeterminate = classified.some(
    (entry) => entry.document.formatId === SHARED_FORMAT_ID && entry.domains.length === 0,
  );
  for (const entry of classified)
    if (entry.document.formatId === SHARED_FORMAT_ID && entry.domains.length === 0)
      addUncertainty(state, "statement-unclassified", entry.document.id, entry.statement.id, null);
  for (const entry of classified) {
    if (entry.document.formatId === SHARED_FORMAT_ID) continue;
    if (entry.domains.length === 0) {
      addUncertainty(state, "statement-unclassified", entry.document.id, entry.statement.id, null);
      continue;
    }
    const observations = formatObservationsValue.filter(
      (observation) => observation.documentId === entry.document.id,
    );
    for (const supported of observations.filter((observation) => observation.state === "supported"))
      for (const unavailable of observations.filter(
        (observation) =>
          observation.profileSummaryId !== supported.profileSummaryId &&
          (observation.state === "recognized" || observation.state === "unsupported"),
      )) {
        const targets = divergenceTargets(
          comparisonsValue,
          supported,
          unavailable,
          new Set([entry.source.path]),
          state,
        );
        if (targets.length === 0) continue;
        for (const domain of entry.domains) {
          if (sharedKeys.has(exactKey(domain))) continue;
          if (sharedIndeterminate) continue;
          if (inventoryState !== "complete") {
            addUncertainty(
              state,
              "format-inventory-partial",
              entry.document.id,
              entry.statement.id,
              unavailable.profileId,
            );
            continue;
          }
          addFinding(state, {
            behaviorId: null,
            message: MESSAGES.ACL450,
            primary: entry,
            profileIds: [supported.profileId, unavailable.profileId],
            related: null,
            relatedLabel: "",
            ruleId: "ACL450",
            semanticKey: exactKey(domain),
            targets,
          });
        }
      }
    for (const observation of observations)
      if (observation.state === "conditional" || observation.state === "unknown")
        addUncertainty(
          state,
          "format-support-indeterminate",
          entry.document.id,
          entry.statement.id,
          observation.profileId,
        );
  }
}

function evaluateFormatDrift(
  state: EvaluationState,
  classified: readonly ClassifiedStatement[],
  formatObservationsValue: readonly ValidatedFormatObservation[],
  comparisonsValue: readonly CrossProfileComparison[],
): void {
  const supportedByDocument = new Map<string, readonly ValidatedFormatObservation[]>();
  for (const entry of classified)
    supportedByDocument.set(
      entry.document.id,
      formatObservationsValue.filter(
        (observation) =>
          observation.documentId === entry.document.id && observation.state === "supported",
      ),
    );
  for (let leftIndex = 0; leftIndex < classified.length; leftIndex += 1)
    for (let rightIndex = leftIndex + 1; rightIndex < classified.length; rightIndex += 1) {
      const left = classified[leftIndex];
      const right = classified[rightIndex];
      if (left === undefined || right === undefined) continue;
      if (
        left.document.id === right.document.id ||
        left.document.formatId === right.document.formatId ||
        left.domains.length === 0 ||
        right.domains.length === 0
      )
        continue;
      for (const leftDomain of left.domains)
        for (const rightDomain of right.domains) {
          incrementPairWork(state);
          if (
            subjectKey(leftDomain) !== subjectKey(rightDomain) ||
            exactKey(leftDomain) === exactKey(rightDomain)
          )
            continue;
          for (const leftObservation of supportedByDocument.get(left.document.id) ?? [])
            for (const rightObservation of supportedByDocument.get(right.document.id) ?? []) {
              if (leftObservation.profileSummaryId === rightObservation.profileSummaryId) continue;
              const targets = divergenceTargets(
                comparisonsValue,
                leftObservation,
                rightObservation,
                new Set([left.source.path, right.source.path]),
                state,
              );
              if (targets.length === 0) continue;
              addFinding(state, {
                behaviorId: null,
                message: MESSAGES.ACL451,
                primary: compareUtf8(left.source.path, right.source.path) <= 0 ? left : right,
                profileIds: [leftObservation.profileId, rightObservation.profileId],
                related: compareUtf8(left.source.path, right.source.path) <= 0 ? right : left,
                relatedLabel: "divergent instruction in another supported format",
                ruleId: "ACL451",
                semanticKey: subjectKey(leftDomain),
                targets,
              });
            }
        }
    }
}

function evaluateBehaviors(
  state: EvaluationState,
  classifiedByStatement: ReadonlyMap<string, ClassifiedStatement>,
  observations: readonly ValidatedBehaviorObservation[],
  comparisonsValue: readonly CrossProfileComparison[],
): void {
  const groups = new Map<string, ValidatedBehaviorObservation[]>();
  for (const observation of observations) {
    const key = `${observation.documentId}\u0000${observation.behaviorId}\u0000${observation.kind}`;
    const values = groups.get(key) ?? [];
    groups.set(key, values);
    values.push(observation);
    if (observation.state === "conditional" || observation.state === "unknown")
      addUncertainty(
        state,
        "behavior-support-indeterminate",
        observation.documentId,
        observation.statementId,
        observation.profileId,
      );
  }
  for (const values of groups.values()) {
    const supported = values.filter((value) => value.state === "supported");
    const unsupported = values.filter((value) => value.state === "unsupported");
    for (const available of supported)
      for (const absent of unsupported) {
        if (available.profileSummaryId === absent.profileSummaryId) continue;
        const statement = classifiedByStatement.get(available.statementId);
        if (statement === undefined)
          abort(
            issue("dependency-failure", "$.behaviorObservations", "statement index is incomplete"),
          );
        const targets = divergenceTargets(
          comparisonsValue,
          available,
          absent,
          new Set([statement.source.path]),
          state,
        );
        if (targets.length === 0) {
          addUncertainty(
            state,
            "comparison-indeterminate",
            available.documentId,
            available.statementId,
            absent.profileId,
          );
          continue;
        }
        if (available.kind === "import" || available.kind === "nesting")
          addFinding(state, {
            behaviorId: available.behaviorId,
            message: MESSAGES.ACL452,
            primary: statement,
            profileIds: [available.profileId, absent.profileId],
            related: null,
            relatedLabel: "",
            ruleId: "ACL452",
            semanticKey: `${available.kind}:${available.behaviorId}`,
            targets,
          });
        if (
          available.kind === "editor-feature" &&
          EDITOR_SURFACES.has(available.surfaceId) &&
          !EDITOR_SURFACES.has(absent.surfaceId)
        )
          addFinding(state, {
            behaviorId: available.behaviorId,
            message: MESSAGES.ACL453,
            primary: statement,
            profileIds: [available.profileId, absent.profileId],
            related: null,
            relatedLabel: "",
            ruleId: "ACL453",
            semanticKey: `editor-feature:${available.behaviorId}`,
            targets,
          });
      }
  }
}

function sourceLocation(entry: ClassifiedStatement): DiagnosticSourceLocation {
  return Object.freeze({
    path: entry.source.path,
    range: entry.statement.range,
    sourceDigest: entry.source.sha256,
    sourceId: entry.source.id,
  });
}

function relatedEvidence(finding: Finding): readonly RelatedEvidence[] {
  if (finding.related === null) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      id: `evidence:${finding.ruleId}:${digest(finding.primary.statement.id, finding.related.statement.id, finding.semanticKey).slice(0, 24)}` as RelatedEvidenceId,
      kind: "source" as const,
      label: finding.relatedLabel,
      location: sourceLocation(finding.related),
    }),
  ]);
}

function diagnostics(
  findings: ReadonlyMap<string, Finding>,
  selectedLimits: PortabilityRuleLimits,
): readonly Diagnostic[] {
  if (findings.size > selectedLimits.maximumDiagnostics)
    abort(issue("resource-limit", "$output", "diagnostic limit was exceeded"));
  const output = [...findings.values()].map((finding): Diagnostic => {
    const profileIds = Object.freeze([...finding.profileIds].sort(compareUtf8));
    const targetDigest = digest(...[...finding.targets].sort(compareUtf8));
    const pathBasis: DiagnosticFingerprintBasis["path"] = Object.freeze({
      anchor: `statement:${finding.primary.statement.id}`,
      profileIds,
    });
    const semanticBasis: DiagnosticFingerprintBasis["semantic"] = Object.freeze({
      components: Object.freeze([
        Object.freeze({ key: "behavior", value: finding.behaviorId ?? "none" }),
        Object.freeze({ key: "policy-sha256", value: digest(finding.semanticKey) }),
        Object.freeze({ key: "primary-statement", value: finding.primary.statement.id }),
        Object.freeze({ key: "related-statement", value: finding.related?.statement.id ?? "none" }),
        Object.freeze({ key: "targets-sha256", value: targetDigest }),
      ]),
      profileIds,
    });
    const pathFingerprint = computePathFingerprint({
      basis: pathBasis,
      path: finding.primary.source.path,
      ruleId: finding.ruleId,
      ruleVersion: PORTABILITY_RULE_VERSION,
    });
    const semanticFingerprint = computeSemanticFingerprint({
      basis: semanticBasis,
      ruleId: finding.ruleId,
      ruleVersion: PORTABILITY_RULE_VERSION,
    });
    return Object.freeze({
      fingerprintBasis: Object.freeze({ path: pathBasis, semantic: semanticBasis }),
      fingerprints: Object.freeze({
        path: Object.freeze({ method: PATH_FINGERPRINT_METHOD, value: pathFingerprint }),
        semantic: Object.freeze({
          method: SEMANTIC_FINGERPRINT_METHOD,
          value: semanticFingerprint,
        }),
      }),
      id: `diagnostic:${finding.ruleId}:${semanticFingerprint.slice(0, 24)}` as DiagnosticId,
      message: finding.message,
      primary: sourceLocation(finding.primary),
      related: relatedEvidence(finding),
      ruleId: finding.ruleId,
      ruleVersion: PORTABILITY_RULE_VERSION,
      severity: SEVERITY[finding.ruleId],
      suggestion: Object.freeze({
        fixPlan: null,
        message:
          "Review the profile-specific behavior and preserve intentional scope before consolidating policy.",
      }),
    });
  });
  return Object.freeze(
    output.sort(
      (left, right) =>
        compareUtf8(left.primary.path, right.primary.path) ||
        left.primary.range.start.byteOffset - right.primary.range.start.byteOffset ||
        compareUtf8(left.ruleId, right.ruleId) ||
        compareUtf8(left.id, right.id),
    ),
  );
}

function isPortabilityIssue(value: unknown): value is PortabilityRuleIssue {
  return (
    isPlainRecord(value) &&
    typeof field(value, "code") === "string" &&
    typeof field(value, "path") === "string" &&
    typeof field(value, "message") === "string"
  );
}

/**
 * Evaluate cross-agent portability only from closed B03 data, F03 high-confidence classifications,
 * same-process E07 comparisons, and explicit profile behavior observations. No filesystem, process,
 * environment, clock, network, model, callback, dynamic-loading, or fix capability is accepted.
 */
export function evaluatePortabilityRules(
  rawInput: unknown,
  rawOptions?: unknown,
): PortabilityRuleResult {
  const selectedLimits = limits(rawOptions);
  if (isPortabilityIssue(selectedLimits)) return failure(selectedLimits);
  const input = closedRecord(rawInput, INPUT_KEYS, "$input");
  if (isPortabilityIssue(input)) return failure(input);
  if (
    field(input, "recordKind") !== "agent-context-portability-rule-input" ||
    field(input, "contractVersion") !== PORTABILITY_RULE_CONTRACT_VERSION
  )
    return failure(issue("invalid-input", "$input", "input kind or contract version is invalid"));
  const validatedIr = validateInstructionIr(field(input, "ir"));
  if (!validatedIr.ok)
    return failure(issue("invalid-input", "$.ir", "must satisfy the closed B03 IR contract"));
  const ir = validatedIr.value;
  const comparisonsValue = comparisons(field(input, "comparisons"), selectedLimits);
  if (isPortabilityIssue(comparisonsValue)) return failure(comparisonsValue);
  const profiles = profileIndex(comparisonsValue);
  if (isPortabilityIssue(profiles)) return failure(profiles);
  const documentById = new Map(ir.documents.map((document) => [document.id, document]));
  const statementById = new Map(ir.statements.map((statement) => [statement.id, statement]));
  const formats = formatObservations(
    field(input, "formatObservations"),
    selectedLimits,
    documentById,
    profiles,
  );
  if (isPortabilityIssue(formats)) return failure(formats);
  const behaviors = behaviorObservations(
    field(input, "behaviorObservations"),
    selectedLimits,
    documentById,
    statementById,
    profiles,
  );
  if (isPortabilityIssue(behaviors)) return failure(behaviors);
  const formatInventoryState = field(input, "formatInventoryState");
  if (formatInventoryState !== "complete" && formatInventoryState !== "partial")
    return failure(issue("invalid-input", "$.formatInventoryState", "must be complete or partial"));
  const classified = classifyStatements(ir, selectedLimits);
  if (isPortabilityIssue(classified)) return failure(classified);
  const classifiedByStatement = new Map(
    classified.map((entry) => [entry.statement.id, entry] as const),
  );
  const state: EvaluationState = {
    findings: new Map(),
    limits: selectedLimits,
    pairWork: 0,
    uncertainties: [],
    uncertaintyKeys: new Set(),
  };
  try {
    evaluateVendorOnly(state, classified, formats, comparisonsValue, formatInventoryState);
    evaluateFormatDrift(state, classified, formats, comparisonsValue);
    evaluateBehaviors(state, classifiedByStatement, behaviors, comparisonsValue);
    const generated = diagnostics(state.findings, selectedLimits);
    const suppression = parseSuppressionDirectives(ir);
    const bundle: DiagnosticBundle = Object.freeze({
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: generated,
      recordKind: "agent-context-diagnostics",
      suppressions: Object.freeze(suppression.directives.map((entry) => entry.record)),
    });
    const validatedBundle = validateDiagnosticBundle(bundle, ir.sources);
    if (!validatedBundle.ok)
      return failure(
        issue("dependency-failure", "$output", "generated diagnostics failed B04 validation"),
      );
    const uncertainties = Object.freeze(
      state.uncertainties.sort(
        (left, right) =>
          compareUtf8(left.documentId, right.documentId) ||
          compareUtf8(left.statementId ?? "", right.statementId ?? "") ||
          compareUtf8(left.reason, right.reason) ||
          compareUtf8(left.profileId ?? "", right.profileId ?? ""),
      ),
    );
    const result = Object.freeze({
      bundle: validatedBundle.value,
      classifierContractVersion: STATEMENT_CLASSIFIER_CONTRACT_VERSION,
      comparisonContractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
      contractVersion: PORTABILITY_RULE_CONTRACT_VERSION,
      limits: selectedLimits,
      metrics: Object.freeze({
        behaviorObservationCount: behaviors.length,
        comparisonCount: comparisonsValue.length,
        diagnosticCount: generated.length,
        formatObservationCount: formats.length,
        pairWork: state.pairWork,
        statementCount: classified.length,
        suppressionDirectiveCount: suppression.directives.length,
        uncertaintyCount: uncertainties.length,
      }),
      ok: true as const,
      sources: Object.freeze([...ir.sources]),
      uncertainties,
    });
    issuedEvaluations.set(result, { directives: suppression.directives, ir });
    return result;
  } catch (error) {
    if (error instanceof PortabilityEvaluationError) return failure(error.detail);
    return failure(issue("dependency-failure", "$evaluation", "portability evaluation failed"));
  }
}

/** Apply only parser-issued B08 directives to an evaluator-issued F12 result. */
export function finalizePortabilitySuppressions(
  evaluation: unknown,
): PortabilitySuppressionFinalizationResult {
  if (evaluation === null || typeof evaluation !== "object" || nodeTypes.isProxy(evaluation))
    return Object.freeze({
      issues: Object.freeze([
        issue("invalid-input", "$.evaluation", "must be an issued F12 evaluation"),
      ]),
      ok: false,
    });
  const issued = issuedEvaluations.get(evaluation);
  if (issued === undefined)
    return Object.freeze({
      issues: Object.freeze([
        issue("invalid-input", "$.evaluation", "must be an issued F12 evaluation"),
      ]),
      ok: false,
    });
  const result = evaluation as Extract<PortabilityRuleResult, { readonly ok: true }>;
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
