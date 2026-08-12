import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  MAX_DIAGNOSTICS_PER_BUNDLE,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
  computePathFingerprint,
  computeSemanticFingerprint,
  isIssuedInstructionIrSnapshot,
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
  DUPLICATION_INDEX_CONTRACT_VERSION,
  DuplicationIndexError,
  DuplicationIndexErrorCode,
  STATEMENT_CLASSIFIER_CONTRACT_VERSION,
  StatementClassifierError,
  StatementClassifierErrorCode,
  buildDuplicationIndex,
  normalizeAndClassifyStatement,
} from "@agent-context/evidence";
import type {
  DuplicationIndexResult,
  StatementClassifierResult,
  StatementDomainClassification,
} from "@agent-context/evidence";
import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  isIssuedEffectiveContextResolution,
} from "@agent-context/resolver";
import type { EffectiveContextDocument, EffectiveContextResolution } from "@agent-context/resolver";
import { matchSuppressionDirectives, parseSuppressionDirectives } from "@agent-context/syntax";
import type { ParsedSuppressionDirective } from "@agent-context/syntax";

export const CONFLICTS_DUPLICATION_CONTRACT_VERSION = "0.1.0" as const;
export const CONFLICTS_DUPLICATION_RULE_VERSION = "1.0.0" as const;
export const CONFLICTS_DUPLICATION_RULE_IDS = [
  "ACL250",
  "ACL251",
  "ACL252",
  "ACL253",
  "ACL254",
  "ACL255",
] as const;
export type ConflictsDuplicationRuleId = (typeof CONFLICTS_DUPLICATION_RULE_IDS)[number];

export interface ConflictsDuplicationInput {
  readonly contexts: readonly EffectiveContextResolution[];
  readonly contractVersion: typeof CONFLICTS_DUPLICATION_CONTRACT_VERSION;
  readonly ir: InstructionIr;
  readonly recordKind: "agent-context-conflicts-duplication-rule-input";
}

export interface ConflictsDuplicationLimits {
  readonly maximumComparisons: number;
  readonly maximumContexts: number;
  readonly maximumDiagnostics: number;
  readonly maximumInputNodes: number;
  readonly maximumStatements: number;
  readonly maximumStringBytes: number;
  readonly maximumTextLength: number;
  readonly maximumUncertainties: number;
}

export type ConflictsDuplicationOptions = Partial<ConflictsDuplicationLimits>;

export const CONFLICTS_DUPLICATION_DEFAULT_LIMITS: Readonly<ConflictsDuplicationLimits> =
  Object.freeze({
    maximumComparisons: 2_000_000,
    maximumContexts: 10_000,
    maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
    maximumInputNodes: 1_000_000,
    maximumStatements: 100_000,
    maximumStringBytes: 67_108_864,
    maximumTextLength: 65_536,
    maximumUncertainties: 250_000,
  });

export const CONFLICTS_DUPLICATION_HARD_LIMITS: Readonly<ConflictsDuplicationLimits> =
  Object.freeze({
    maximumComparisons: 20_000_000,
    maximumContexts: 100_000,
    maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
    maximumInputNodes: 4_000_000,
    maximumStatements: 1_000_000,
    maximumStringBytes: 268_435_456,
    maximumTextLength: 1_048_576,
    maximumUncertainties: 250_000,
  });

export type ConflictsDuplicationUncertaintyReason =
  | "conditional-document"
  | "effective-document-unmapped"
  | "partial-effective-context"
  | "truncated-content"
  | "unavailable-content";

export interface ConflictsDuplicationUncertainty {
  readonly contextId: string;
  readonly documentId: string | null;
  readonly reason: ConflictsDuplicationUncertaintyReason;
}

export interface ConflictsDuplicationMetrics {
  readonly comparisonCount: number;
  readonly contextCount: number;
  readonly diagnosticCount: number;
  readonly exactClusterCount: number;
  readonly nearClusterCount: number;
  readonly statementCount: number;
  readonly suppressionDirectiveCount: number;
  readonly uncertaintyCount: number;
}

export type ConflictsDuplicationIssueCode =
  "dependency-failure" | "invalid-input" | "invalid-options" | "resource-limit";

export interface ConflictsDuplicationIssue {
  readonly code: ConflictsDuplicationIssueCode;
  readonly message: string;
  readonly path: string;
}

export type ConflictsDuplicationResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly classifierContractVersion: typeof STATEMENT_CLASSIFIER_CONTRACT_VERSION;
      readonly contractVersion: typeof CONFLICTS_DUPLICATION_CONTRACT_VERSION;
      readonly duplicationIndexContractVersion: typeof DUPLICATION_INDEX_CONTRACT_VERSION;
      readonly effectiveContextContractVersion: typeof EFFECTIVE_CONTEXT_CONTRACT_VERSION;
      readonly limits: ConflictsDuplicationLimits;
      readonly metrics: ConflictsDuplicationMetrics;
      readonly ok: true;
      readonly sources: readonly SourceDocument[];
      readonly uncertainties: readonly ConflictsDuplicationUncertainty[];
    }
  | {
      readonly issues: readonly ConflictsDuplicationIssue[];
      readonly ok: false;
    };

export type ConflictsDuplicationSuppressionFinalizationResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly ok: true;
      readonly suppressedDiagnostics: readonly Diagnostic[];
      readonly visibleDiagnostics: readonly Diagnostic[];
    }
  | { readonly issues: readonly ConflictsDuplicationIssue[]; readonly ok: false };

interface ClassifiedStatement {
  readonly classification: StatementClassifierResult;
  readonly document: InstructionDocument;
  readonly source: SourceDocument;
  readonly statement: InstructionStatement;
}

interface ActiveStatement extends ClassifiedStatement {
  readonly context: EffectiveContextResolution;
  readonly effectiveDocument: EffectiveContextDocument;
}

interface Finding {
  readonly left: ClassifiedStatement;
  readonly message: string;
  readonly primary: ClassifiedStatement;
  readonly profileIds: Set<ClientProfileId>;
  readonly relatedLabel: string;
  readonly right: ClassifiedStatement;
  readonly ruleId: ConflictsDuplicationRuleId;
  readonly subject: string;
  readonly targets: Set<RepositoryRelativePath>;
}

interface EvaluationState {
  comparisonCount: number;
  readonly findings: Map<string, Finding>;
  readonly limits: ConflictsDuplicationLimits;
  readonly uncertainties: ConflictsDuplicationUncertainty[];
  readonly uncertaintyKeys: Set<string>;
}

const INPUT_KEYS = new Set(["contexts", "contractVersion", "ir", "recordKind"]);
const LIMIT_KEYS = new Set(Object.keys(CONFLICTS_DUPLICATION_DEFAULT_LIMITS));
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const SAFE_TERM = /^[a-z0-9][a-z0-9_.:@/+-]{0,255}$/u;
const POSITIVE_MODALITIES = new Set(["must", "should", "preference"]);
const SEVERITY: Readonly<Record<ConflictsDuplicationRuleId, DiagnosticSeverity>> = Object.freeze({
  ACL250: "error",
  ACL251: "error",
  ACL252: "warning",
  ACL253: "warning",
  ACL254: "warning",
  ACL255: "info",
});
const MESSAGES: Readonly<Record<ConflictsDuplicationRuleId, string>> = Object.freeze({
  ACL250: "Mutually exclusive package-manager requirements apply to the same effective target.",
  ACL251:
    "The same structured action is both required and prohibited for the same effective target.",
  ACL252: "Mutually exclusive workflow instructions apply to the same effective target.",
  ACL253: "A near-duplicate instruction appears in multiple effective documents.",
  ACL254: "A vendor-specific instruction diverges from effective canonical AGENTS.md policy.",
  ACL255: "A more specific instruction repeats inherited policy unchanged.",
});
const issuedEvaluations = new WeakMap<
  object,
  { readonly directives: readonly ParsedSuppressionDirective[]; readonly ir: InstructionIr }
>();

function issue(
  code: ConflictsDuplicationIssueCode,
  path: string,
  message: string,
): ConflictsDuplicationIssue {
  return Object.freeze({ code, message, path });
}

class ConflictsDuplicationAbort extends Error {
  readonly detail: ConflictsDuplicationIssue;

  constructor(detail: ConflictsDuplicationIssue) {
    super(detail.message);
    this.name = "ConflictsDuplicationAbort";
    this.detail = detail;
  }
}

function abort(detail: ConflictsDuplicationIssue): never {
  throw new ConflictsDuplicationAbort(detail);
}

function failure(value: ConflictsDuplicationIssue): ConflictsDuplicationResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function isIssue(value: unknown): value is ConflictsDuplicationIssue {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "code" in value &&
    "message" in value &&
    "path" in value
  );
}

function plainRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
  code: ConflictsDuplicationIssueCode,
  requireEveryKey = true,
): Map<string, unknown> | ConflictsDuplicationIssue {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    (Reflect.getPrototypeOf(value) !== Object.prototype && Reflect.getPrototypeOf(value) !== null)
  )
    return issue(code, label, "must be a closed non-proxy plain data object");
  let actual: readonly PropertyKey[];
  try {
    actual = Reflect.ownKeys(value);
  } catch {
    /* v8 ignore next -- proxies are rejected before inspection; this retains fail-closed host-object handling. */
    return issue(code, label, "could not be inspected safely");
  }
  if (
    (requireEveryKey && actual.length !== keys.size) ||
    actual.some((key) => typeof key !== "string" || !keys.has(key))
  )
    return issue(code, label, "has unknown or missing fields");
  const output = new Map<string, unknown>();
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return issue(code, label, "must contain only enumerable own data fields");
    output.set(key as string, descriptor.value);
  }
  return output;
}

function limits(raw: unknown): ConflictsDuplicationLimits | ConflictsDuplicationIssue {
  if (raw === undefined) return CONFLICTS_DUPLICATION_DEFAULT_LIMITS;
  const record = plainRecord(raw, LIMIT_KEYS, "$.options", "invalid-options", false);
  if (!(record instanceof Map)) return record;
  const output: Record<string, number> = {};
  for (const key of LIMIT_KEYS as ReadonlySet<keyof ConflictsDuplicationLimits>) {
    const value = record.has(key) ? record.get(key) : CONFLICTS_DUPLICATION_DEFAULT_LIMITS[key];
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) > CONFLICTS_DUPLICATION_HARD_LIMITS[key]
    )
      return issue(
        "invalid-options",
        `$.options.${key}`,
        `must be a positive safe integer no greater than ${String(CONFLICTS_DUPLICATION_HARD_LIMITS[key])}`,
      );
    output[key] = value as number;
  }
  return Object.freeze(output) as unknown as ConflictsDuplicationLimits;
}

function safeJsonSnapshot(value: unknown, selectedLimits: ConflictsDuplicationLimits): unknown {
  const ancestors = new WeakSet<object>();
  let nodeCount = 0;
  let stringBytes = 0;
  const visit = (candidate: unknown, path: string, depth: number): unknown => {
    nodeCount += 1;
    if (nodeCount > selectedLimits.maximumInputNodes)
      abort(issue("resource-limit", path, "input node limit was exceeded"));
    if (depth > 64) abort(issue("resource-limit", path, "input nesting limit was exceeded"));
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        abort(issue("invalid-input", path, "must be finite JSON data"));
      return candidate;
    }
    if (typeof candidate === "string") {
      stringBytes += Buffer.byteLength(candidate, "utf8");
      if (stringBytes > selectedLimits.maximumStringBytes)
        abort(issue("resource-limit", path, "aggregate string-byte limit was exceeded"));
      return candidate;
    }
    if (typeof candidate !== "object" || nodeTypes.isProxy(candidate))
      abort(issue("invalid-input", path, "must contain only non-proxy JSON data"));
    if (ancestors.has(candidate)) abort(issue("invalid-input", path, "must not be cyclic"));
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Reflect.getPrototypeOf(candidate) !== Array.prototype)
          abort(issue("invalid-input", path, "arrays must use the standard prototype"));
        const keys = Reflect.ownKeys(candidate);
        if (
          keys.length !== candidate.length + 1 ||
          keys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" ||
                !/^(?:0|[1-9]\d*)$/u.test(key) ||
                Number(key) >= candidate.length),
          )
        )
          abort(issue("invalid-input", path, "arrays must be dense and unextended"));
        const output: unknown[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
            abort(issue("invalid-input", path, "arrays must contain enumerable own data entries"));
          output.push(visit(descriptor.value, `${path}[${String(index)}]`, depth + 1));
        }
        return output;
      }
      const prototype = Reflect.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null)
        abort(issue("invalid-input", path, "objects must have a plain prototype"));
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = Reflect.ownKeys(candidate);
      for (const key of keys) {
        if (typeof key !== "string")
          abort(issue("invalid-input", path, "symbol keys are forbidden"));
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
          abort(issue("invalid-input", path, "objects must contain enumerable own data fields"));
        output[key] = visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };
  try {
    return visit(value, "$.ir", 0);
  } catch (error) {
    return error instanceof ConflictsDuplicationAbort
      ? error.detail
      : issue("invalid-input", "$.ir", "could not be snapshotted safely");
  }
}

function denseContexts(
  value: unknown,
  selectedLimits: ConflictsDuplicationLimits,
): readonly EffectiveContextResolution[] | ConflictsDuplicationIssue {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return issue("invalid-input", "$.contexts", "must be a regular dense array");
  if (value.length > selectedLimits.maximumContexts)
    return issue("resource-limit", "$.contexts", "context limit was exceeded");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length),
    )
  )
    return issue("invalid-input", "$.contexts", "must be dense and unextended");
  const output: EffectiveContextResolution[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return issue("invalid-input", "$.contexts", "must contain enumerable own data entries");
    if (!isIssuedEffectiveContextResolution(descriptor.value))
      return issue(
        "invalid-input",
        `$.contexts[${String(index)}]`,
        "must be an effective context issued by E05 in this process",
      );
    const context = descriptor.value;
    const identity = [
      context.profileId,
      context.surfaceId,
      context.specSnapshotId,
      context.targetPath,
    ].join("\u0000");
    if (identities.has(identity))
      return issue(
        "invalid-input",
        "$.contexts",
        "contains a duplicate effective-context identity",
      );
    identities.add(identity);
    output.push(context);
  }
  return Object.freeze(
    output.sort(
      (left, right) =>
        compareUtf8(left.targetPath, right.targetPath) ||
        compareUtf8(left.profileId, right.profileId) ||
        compareUtf8(left.surfaceId, right.surfaceId) ||
        compareUtf8(left.specSnapshotId, right.specSnapshotId),
    ),
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function digest(...values: readonly string[]): string {
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

function contextId(value: EffectiveContextResolution): string {
  return `effective-context:${digest(value.profileId, value.surfaceId, value.specSnapshotId, value.targetPath).slice(0, 24)}`;
}

function addUncertainty(
  state: EvaluationState,
  context: EffectiveContextResolution,
  reason: ConflictsDuplicationUncertaintyReason,
  documentId: string | null,
): void {
  const id = contextId(context);
  const key = `${id}\u0000${reason}\u0000${documentId ?? ""}`;
  if (state.uncertaintyKeys.has(key)) return;
  if (state.uncertainties.length >= state.limits.maximumUncertainties)
    abort(issue("resource-limit", "$.contexts", "uncertainty limit was exceeded"));
  state.uncertaintyKeys.add(key);
  state.uncertainties.push(Object.freeze({ contextId: id, documentId, reason }));
}

function classifyStatements(
  ir: InstructionIr,
  selectedLimits: ConflictsDuplicationLimits,
): readonly ClassifiedStatement[] | ConflictsDuplicationIssue {
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
      /* v8 ignore next -- B03 validates every statement's document ownership. */
      if (document === undefined)
        abort(issue("dependency-failure", "$.ir", "statement document is missing"));
      const source = sourceById.get(document.sourceId);
      /* v8 ignore next -- B03 validates every document's source ownership. */
      if (source === undefined)
        abort(issue("dependency-failure", "$.ir", "document source is missing"));
      const classification = normalizeAndClassifyStatement({
        documentId: statement.documentId,
        nodeIds: statement.nodeIds,
        range: statement.range,
        statementId: statement.id,
        text: statement.text,
      });
      output.push(Object.freeze({ classification, document, source, statement }));
    }
  } catch (error) {
    /* v8 ignore next 9 -- B03 and F08 limits are equal to or stricter than F03's accepted contract. */
    const limited =
      error instanceof StatementClassifierError &&
      error.code === StatementClassifierErrorCode.limitExceeded;
    return issue(
      limited ? "resource-limit" : "dependency-failure",
      "$.ir.statements",
      limited
        ? "F03 statement-classifier limit was exceeded"
        : "F03 rejected validated statement data",
    );
  }
  const ordered = output.sort(
    (left, right) =>
      compareUtf8(left.document.id, right.document.id) ||
      compareUtf8(left.classification.normalizedText, right.classification.normalizedText) ||
      left.statement.range.start.utf16Offset - right.statement.range.start.utf16Offset ||
      left.statement.range.end.utf16Offset - right.statement.range.end.utf16Offset ||
      compareUtf8(left.statement.id, right.statement.id),
  );
  const logical: ClassifiedStatement[] = [];
  let candidate: ClassifiedStatement | undefined;
  let overlapEnd = -1;
  for (const entry of ordered) {
    if (candidate === undefined) {
      candidate = entry;
      overlapEnd = entry.statement.range.end.utf16Offset;
      continue;
    }
    if (
      candidate.document.id !== entry.document.id ||
      candidate.classification.normalizedText !== entry.classification.normalizedText ||
      entry.statement.range.start.utf16Offset >= overlapEnd
    ) {
      logical.push(candidate);
      candidate = entry;
      overlapEnd = entry.statement.range.end.utf16Offset;
      continue;
    }
    overlapEnd = Math.max(overlapEnd, entry.statement.range.end.utf16Offset);
    const currentSpan =
      candidate.statement.range.end.utf16Offset - candidate.statement.range.start.utf16Offset;
    const entrySpan =
      entry.statement.range.end.utf16Offset - entry.statement.range.start.utf16Offset;
    if (
      entrySpan < currentSpan ||
      (entrySpan === currentSpan && entry.statement.id < candidate.statement.id)
    )
      candidate = entry;
  }
  if (candidate !== undefined) logical.push(candidate);
  return Object.freeze(
    logical.sort((left, right) => compareUtf8(left.statement.id, right.statement.id)),
  );
}

function duplicationIndex(
  statements: readonly ClassifiedStatement[],
): DuplicationIndexResult | ConflictsDuplicationIssue {
  try {
    return buildDuplicationIndex(
      statements.map((entry) => ({
        documentId: entry.statement.documentId,
        nodeIds: entry.statement.nodeIds,
        normalizedText: entry.classification.normalizedText,
        range: entry.statement.range,
        statementId: entry.statement.id,
      })),
    );
  } catch (error) {
    /* v8 ignore next 9 -- validated F03 output and F08 limits are within F04's accepted contract. */
    const limited =
      error instanceof DuplicationIndexError &&
      error.code === DuplicationIndexErrorCode.limitExceeded;
    return issue(
      limited ? "resource-limit" : "dependency-failure",
      "$.ir.statements",
      limited
        ? "F04 duplication-index limit was exceeded"
        : "F04 rejected classified statement data",
    );
  }
}

function activeStatements(
  state: EvaluationState,
  context: EffectiveContextResolution,
  byDocument: ReadonlyMap<string, readonly ClassifiedStatement[]>,
): readonly ActiveStatement[] {
  if (context.analysisStatus === "partial")
    addUncertainty(state, context, "partial-effective-context", null);
  const output: ActiveStatement[] = [];
  for (const document of context.documents) {
    if (document.activation === "indeterminate" || document.state === "conditional") {
      addUncertainty(state, context, "conditional-document", document.id);
      continue;
    }
    if (document.activation !== "active" || document.state !== "effective") continue;
    if (
      document.sourceDocumentId === null ||
      document.contentState === "identity-only" ||
      document.contentState === "unavailable" ||
      document.text === null
    ) {
      addUncertainty(state, context, "unavailable-content", document.id);
      continue;
    }
    const statements = byDocument.get(document.sourceDocumentId);
    if (statements === undefined) {
      addUncertainty(state, context, "effective-document-unmapped", document.id);
      continue;
    }
    if (document.truncation === "prefix")
      addUncertainty(state, context, "truncated-content", document.id);
    for (const statement of statements) {
      if (
        document.truncation === "prefix" &&
        (document.includedBytes === null ||
          statement.statement.range.end.byteOffset > document.includedBytes)
      )
        continue;
      output.push(Object.freeze({ ...statement, context, effectiveDocument: document }));
    }
  }
  return Object.freeze(
    output.sort((left, right) => compareUtf8(left.statement.id, right.statement.id)),
  );
}

function documentPair(leftDocumentId: string, rightDocumentId: string): string {
  return compareUtf8(leftDocumentId, rightDocumentId) <= 0
    ? `${leftDocumentId}\u0000${rightDocumentId}`
    : `${rightDocumentId}\u0000${leftDocumentId}`;
}

function allowedDocumentPairs(context: EffectiveContextResolution): ReadonlySet<string> {
  return new Set(
    context.conflicts.map((entry) => documentPair(entry.firstDocumentId, entry.secondDocumentId)),
  );
}

function allowedPair(
  allowed: ReadonlySet<string>,
  left: ActiveStatement,
  right: ActiveStatement,
): boolean {
  if (left.effectiveDocument.id === right.effectiveDocument.id) return true;
  return allowed.has(documentPair(left.effectiveDocument.id, right.effectiveDocument.id));
}

function domain(
  entry: ClassifiedStatement,
  name: StatementDomainClassification["domain"],
): StatementDomainClassification | undefined {
  return entry.classification.domains.find((candidate) => candidate.domain === name);
}

function safeTerm(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().replace(/[.!?;:]+$/u, "");
  return SAFE_TERM.test(normalized) ? normalized : null;
}

function comparableValue(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().replace(/[.!?;:]+$/u, "");
  return normalized.length === 0 || normalized.length > 4_096 ? null : normalized;
}

function locationOrder(left: ClassifiedStatement, right: ClassifiedStatement): number {
  return (
    compareUtf8(left.source.path, right.source.path) ||
    left.statement.range.start.byteOffset - right.statement.range.start.byteOffset ||
    compareUtf8(left.statement.id, right.statement.id)
  );
}

function findingKey(
  ruleId: ConflictsDuplicationRuleId,
  left: ClassifiedStatement,
  right: ClassifiedStatement,
): string {
  const ids = [left.statement.id, right.statement.id].sort(compareUtf8);
  const firstId = ids[0];
  const secondId = ids[1];
  /* v8 ignore next -- the finding key is always built from exactly two statements. */
  if (firstId === undefined || secondId === undefined)
    abort(issue("dependency-failure", "$evaluation", "finding pair is incomplete"));
  return `${ruleId}\u0000${firstId}\u0000${secondId}`;
}

function addFinding(
  state: EvaluationState,
  ruleId: ConflictsDuplicationRuleId,
  left: ClassifiedStatement,
  right: ClassifiedStatement,
  context: EffectiveContextResolution,
  subject: string,
  relatedLabel: string,
  preferredPrimary?: ClassifiedStatement,
): void {
  const key = findingKey(ruleId, left, right);
  const existing = state.findings.get(key);
  if (existing !== undefined) {
    existing.profileIds.add(context.profileId);
    existing.targets.add(context.targetPath);
    return;
  }
  const primary = preferredPrimary ?? (locationOrder(left, right) <= 0 ? right : left);
  state.findings.set(key, {
    left,
    message: MESSAGES[ruleId],
    primary,
    profileIds: new Set([context.profileId]),
    relatedLabel,
    right,
    ruleId,
    subject,
    targets: new Set([context.targetPath]),
  });
}

function incrementComparison(state: EvaluationState): void {
  state.comparisonCount += 1;
  if (state.comparisonCount > state.limits.maximumComparisons)
    abort(issue("resource-limit", "$.contexts", "comparison limit was exceeded"));
}

function oppositeRequired(
  left: StatementDomainClassification,
  right: StatementDomainClassification,
): boolean {
  return (
    (left.modality === "must" && right.modality === "must-not") ||
    (left.modality === "must-not" && right.modality === "must")
  );
}

function sameCoordinate(
  left: StatementDomainClassification,
  right: StatementDomainClassification,
): boolean {
  return (
    left.action === right.action &&
    comparableValue(left.object) !== null &&
    comparableValue(left.object) === comparableValue(right.object) &&
    comparableValue(left.subject) === comparableValue(right.subject)
  );
}

function requiredProhibitedConflict(
  left: ClassifiedStatement,
  right: ClassifiedStatement,
): string | null {
  for (const name of ["package-manager", "command", "formatting", "testing"] as const) {
    const first = domain(left, name);
    const second = domain(right, name);
    if (
      name === "package-manager" &&
      (first?.evidence.some((entry) => entry.ruleId === "package-manager.command") === true ||
        second?.evidence.some((entry) => entry.ruleId === "package-manager.command") === true)
    )
      continue;
    if (
      first !== undefined &&
      second !== undefined &&
      oppositeRequired(first, second) &&
      sameCoordinate(first, second)
    )
      return `${name}:${digest(comparableValue(first.object) ?? "action").slice(0, 24)}`;
  }
  return null;
}

interface WorkflowSelection {
  readonly selection: string;
  readonly workflow: "build" | "commit" | "formatting" | "testing";
}

function workflowSelection(entry: ClassifiedStatement): WorkflowSelection | null {
  const formatting = domain(entry, "formatting");
  const formattingTool = formatting === undefined ? null : safeTerm(formatting.object);
  if (
    formatting !== undefined &&
    formattingTool !== null &&
    POSITIVE_MODALITIES.has(formatting.modality)
  )
    return { selection: formattingTool, workflow: "formatting" };
  if (domain(entry, "command") === undefined) return null;
  const match = /^(?:must |always )?(?:run|execute|invoke) only (.+)$/u.exec(
    entry.classification.normalizedText,
  );
  const selection = match?.[1]?.trim() ?? null;
  if (selection === null || selection.length === 0 || selection.length > 256) return null;
  const workflow = /\btests?\b/u.test(selection)
    ? "testing"
    : /\bbuild\b/u.test(selection)
      ? "build"
      : /\bformat(?:ting)?\b/u.test(selection)
        ? "formatting"
        : /\bcommit\b/u.test(selection)
          ? "commit"
          : null;
  return workflow === null ? null : { selection, workflow };
}

function evaluateStructuredPair(
  state: EvaluationState,
  context: EffectiveContextResolution,
  left: ActiveStatement,
  right: ActiveStatement,
): void {
  const leftManager = domain(left, "package-manager");
  const rightManager = domain(right, "package-manager");
  const firstManager = leftManager === undefined ? null : safeTerm(leftManager.object);
  const secondManager = rightManager === undefined ? null : safeTerm(rightManager.object);
  const leftManagerCommand =
    leftManager?.evidence.some((entry) => entry.ruleId === "package-manager.command") === true;
  const rightManagerCommand =
    rightManager?.evidence.some((entry) => entry.ruleId === "package-manager.command") === true;
  const packageConflict =
    leftManager !== undefined &&
    rightManager !== undefined &&
    leftManagerCommand === rightManagerCommand &&
    leftManager.modality === "must" &&
    rightManager.modality === "must" &&
    firstManager !== null &&
    secondManager !== null &&
    PACKAGE_MANAGERS.has(firstManager) &&
    PACKAGE_MANAGERS.has(secondManager) &&
    firstManager !== secondManager;
  if (packageConflict)
    addFinding(
      state,
      "ACL250",
      left,
      right,
      context,
      `${firstManager}:${secondManager}`,
      "conflicting package-manager instruction",
    );

  const prohibited = requiredProhibitedConflict(left, right);
  if (prohibited !== null)
    addFinding(
      state,
      "ACL251",
      left,
      right,
      context,
      prohibited,
      "opposite structured instruction",
    );

  if (!packageConflict) {
    const firstWorkflow = workflowSelection(left);
    const secondWorkflow = workflowSelection(right);
    if (
      firstWorkflow !== null &&
      secondWorkflow !== null &&
      firstWorkflow.workflow === secondWorkflow.workflow &&
      firstWorkflow.selection !== secondWorkflow.selection
    )
      addFinding(
        state,
        "ACL252",
        left,
        right,
        context,
        firstWorkflow.workflow,
        "conflicting workflow instruction",
      );
  }
}

function sameOrPreceding(
  context: EffectiveContextResolution,
  beforeId: string,
  afterId: string,
): boolean {
  const before = context.sequence.indexOf(beforeId);
  const after = context.sequence.indexOf(afterId);
  if (context.ordering === "total" && before >= 0 && after >= 0 && before < after) return true;
  return context.precedence.some(
    (entry) => entry.beforeDocumentId === beforeId && entry.afterDocumentId === afterId,
  );
}

function directory(path: RepositoryRelativePath): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function ancestorDirectory(parent: string, child: string): boolean {
  return parent !== child && (parent === "." || child.startsWith(`${parent}/`));
}

function isInheritedRepeat(
  context: EffectiveContextResolution,
  parent: ActiveStatement,
  child: ActiveStatement,
): boolean {
  return (
    ancestorDirectory(
      directory(parent.effectiveDocument.path),
      directory(child.effectiveDocument.path),
    ) && sameOrPreceding(context, parent.effectiveDocument.id, child.effectiveDocument.id)
  );
}

function evaluateDuplication(
  state: EvaluationState,
  contexts: readonly EffectiveContextResolution[],
  activeByContext: ReadonlyMap<EffectiveContextResolution, readonly ActiveStatement[]>,
  index: DuplicationIndexResult,
): void {
  const nearEdges = index.nearClusters.flatMap((cluster) => cluster.edges);
  for (const context of contexts) {
    const allowed = allowedDocumentPairs(context);
    const active = activeByContext.get(context);
    /* v8 ignore next -- the caller populated every issued context immediately above. */
    if (active === undefined)
      abort(issue("dependency-failure", "$.contexts", "active context state is missing"));
    const activeById = new Map(active.map((entry) => [entry.statement.id, entry]));
    for (const edge of nearEdges) {
      incrementComparison(state);
      const left = activeById.get(edge.leftStatementId);
      const right = activeById.get(edge.rightStatementId);
      if (
        left === undefined ||
        right === undefined ||
        left.document.id === right.document.id ||
        !allowedPair(allowed, left, right)
      )
        continue;
      addFinding(
        state,
        "ACL253",
        left,
        right,
        context,
        `similarity:${String(edge.similarityBasisPoints)}`,
        "near-duplicate instruction",
      );
    }
    for (const cluster of index.exactClusters) {
      for (let leftIndex = 0; leftIndex < cluster.members.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < cluster.members.length; rightIndex += 1) {
          incrementComparison(state);
          const firstMember = cluster.members[leftIndex];
          const secondMember = cluster.members[rightIndex];
          /* v8 ignore next -- the two loop bounds prove both members exist. */
          if (firstMember === undefined || secondMember === undefined) continue;
          const first = activeById.get(firstMember.statementId);
          const second = activeById.get(secondMember.statementId);
          if (first === undefined || second === undefined || !allowedPair(allowed, first, second))
            continue;
          const inherited = isInheritedRepeat(context, first, second)
            ? { child: second, parent: first }
            : isInheritedRepeat(context, second, first)
              ? { child: first, parent: second }
              : null;
          if (inherited === null) continue;
          addFinding(
            state,
            "ACL255",
            inherited.parent,
            inherited.child,
            context,
            cluster.normalizedTextSha256,
            "inherited instruction",
            inherited.child,
          );
        }
      }
    }
  }
}

function divergence(canonical: ClassifiedStatement, vendor: ClassifiedStatement): string | null {
  for (const name of ["package-manager", "formatting"] as const) {
    const left = domain(canonical, name);
    const right = domain(vendor, name);
    if (left === undefined || right === undefined) continue;
    if (left.action !== right.action) continue;
    const leftObject = safeTerm(left.object);
    const rightObject = safeTerm(right.object);
    if (
      leftObject !== null &&
      rightObject !== null &&
      ((POSITIVE_MODALITIES.has(left.modality) &&
        POSITIVE_MODALITIES.has(right.modality) &&
        leftObject !== rightObject) ||
        (leftObject === rightObject && oppositeRequired(left, right)))
    )
      return `${name}:${leftObject}:${rightObject}`;
  }
  const leftOwner = domain(canonical, "file-ownership");
  const rightOwner = domain(vendor, "file-ownership");
  if (leftOwner !== undefined && rightOwner !== undefined) {
    const leftObject = safeTerm(leftOwner.object);
    const rightObject = safeTerm(rightOwner.object);
    const leftSubject = safeTerm(leftOwner.subject);
    const rightSubject = safeTerm(rightOwner.subject);
    if (
      leftObject !== null &&
      leftObject === rightObject &&
      leftSubject !== null &&
      rightSubject !== null &&
      leftSubject !== rightSubject
    )
      return `file-ownership:${leftObject}`;
  }
  const opposite = requiredProhibitedConflict(canonical, vendor);
  return opposite === null ? null : `polarity:${opposite}`;
}

function evaluateVendorDivergence(
  state: EvaluationState,
  contexts: readonly EffectiveContextResolution[],
  activeByContext: ReadonlyMap<EffectiveContextResolution, readonly ActiveStatement[]>,
): void {
  const byTarget = new Map<string, ActiveStatement[]>();
  const seen = new Set<string>();
  for (const context of contexts) {
    const targetEntries = byTarget.get(context.targetPath) ?? [];
    byTarget.set(context.targetPath, targetEntries);
    const active = activeByContext.get(context);
    /* v8 ignore next -- the caller populated every issued context immediately above. */
    if (active === undefined)
      abort(issue("dependency-failure", "$.contexts", "active context state is missing"));
    for (const entry of active) {
      const key = `${context.targetPath}\u0000${context.profileId}\u0000${entry.statement.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targetEntries.push(entry);
    }
  }
  for (const entries of byTarget.values()) {
    const canonical = entries.filter(
      (entry) => entry.effectiveDocument.formatId === "agents-markdown",
    );
    const vendor = entries.filter(
      (entry) => entry.effectiveDocument.formatId !== "agents-markdown",
    );
    for (const shared of canonical)
      for (const specific of vendor) {
        if (shared.statement.id === specific.statement.id) continue;
        incrementComparison(state);
        const reason = divergence(shared, specific);
        if (reason === null) continue;
        addFinding(
          state,
          "ACL254",
          shared,
          specific,
          specific.context,
          reason,
          "canonical AGENTS.md instruction",
          specific,
        );
        const key = findingKey("ACL254", shared, specific);
        const finding = state.findings.get(key);
        if (finding !== undefined) finding.profileIds.add(shared.context.profileId);
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
  const related =
    finding.primary.statement.id === finding.left.statement.id ? finding.right : finding.left;
  return Object.freeze([
    Object.freeze({
      id: `evidence:${finding.ruleId}:${digest(finding.left.statement.id, finding.right.statement.id).slice(0, 24)}` as RelatedEvidenceId,
      kind: "source" as const,
      label: finding.relatedLabel,
      location: sourceLocation(related),
    }),
  ]);
}

function diagnostics(
  findings: ReadonlyMap<string, Finding>,
  selectedLimits: ConflictsDuplicationLimits,
): readonly Diagnostic[] {
  if (findings.size > selectedLimits.maximumDiagnostics)
    abort(issue("resource-limit", "$output", "diagnostic limit was exceeded"));
  const output = [...findings.values()].map((finding): Diagnostic => {
    const profileIds = Object.freeze([...finding.profileIds].sort(compareUtf8));
    const targetDigest = digest(...[...finding.targets].sort(compareUtf8));
    const pair = [finding.left.statement.id, finding.right.statement.id].sort(compareUtf8);
    const leftStatementId = pair[0];
    const rightStatementId = pair[1];
    /* v8 ignore next -- each finding is constructed from exactly two statements. */
    if (leftStatementId === undefined || rightStatementId === undefined)
      abort(issue("dependency-failure", "$output", "diagnostic pair is incomplete"));
    const pathBasis: DiagnosticFingerprintBasis["path"] = Object.freeze({
      anchor: `statement:${finding.primary.statement.id}`,
      profileIds,
    });
    const semanticBasis: DiagnosticFingerprintBasis["semantic"] = Object.freeze({
      components: Object.freeze([
        Object.freeze({ key: "left-statement", value: leftStatementId }),
        Object.freeze({ key: "right-statement", value: rightStatementId }),
        Object.freeze({ key: "subject", value: finding.subject }),
        Object.freeze({ key: "targets-sha256", value: targetDigest }),
      ]),
      profileIds,
    });
    const pathFingerprint = computePathFingerprint({
      basis: pathBasis,
      path: finding.primary.source.path,
      ruleId: finding.ruleId,
      ruleVersion: CONFLICTS_DUPLICATION_RULE_VERSION,
    });
    const semanticFingerprint = computeSemanticFingerprint({
      basis: semanticBasis,
      ruleId: finding.ruleId,
      ruleVersion: CONFLICTS_DUPLICATION_RULE_VERSION,
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
      ruleVersion: CONFLICTS_DUPLICATION_RULE_VERSION,
      severity: SEVERITY[finding.ruleId],
      suggestion: Object.freeze({
        fixPlan: null,
        message:
          "Reconcile the two source instructions without discarding intentional scope or rationale.",
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

/**
 * Evaluate structured conflicts and duplication over F03/F04 evidence constrained by actual E05
 * effective contexts. The evaluator has no filesystem, process, environment, clock, network,
 * callback, model, dynamic-loading, or fix capability.
 */
export function evaluateConflictsDuplicationRules(
  rawInput: unknown,
  rawOptions?: unknown,
): ConflictsDuplicationResult {
  const selectedLimits = limits(rawOptions);
  if (isIssue(selectedLimits)) return failure(selectedLimits);
  const input = plainRecord(rawInput, INPUT_KEYS, "$", "invalid-input");
  if (!(input instanceof Map)) return failure(input);
  if (
    input.get("recordKind") !== "agent-context-conflicts-duplication-rule-input" ||
    input.get("contractVersion") !== CONFLICTS_DUPLICATION_CONTRACT_VERSION
  )
    return failure(issue("invalid-input", "$", "input kind or contract version is invalid"));
  const suppliedIr = input.get("ir");
  let ir: InstructionIr;
  if (isIssuedInstructionIrSnapshot(suppliedIr)) ir = suppliedIr;
  else {
    const snapshot = safeJsonSnapshot(suppliedIr, selectedLimits);
    if (snapshot !== null && typeof snapshot === "object" && "code" in snapshot)
      return failure(snapshot as ConflictsDuplicationIssue);
    const validatedIr = validateInstructionIr(snapshot);
    if (!validatedIr.ok)
      return failure(issue("invalid-input", "$.ir", "must satisfy the closed B03 IR contract"));
    ir = validatedIr.value;
  }
  const contexts = denseContexts(input.get("contexts"), selectedLimits);
  if (isIssue(contexts)) return failure(contexts);
  const classified = classifyStatements(ir, selectedLimits);
  if (isIssue(classified)) return failure(classified);
  const index = duplicationIndex(classified);
  /* v8 ignore next -- exercised only by fault-injecting the validated F04 dependency boundary. */
  if (isIssue(index)) return failure(index);
  const byDocument = new Map<string, ClassifiedStatement[]>();
  for (const entry of classified) {
    const statements = byDocument.get(entry.document.id) ?? [];
    byDocument.set(entry.document.id, statements);
    statements.push(entry);
  }
  const state: EvaluationState = {
    comparisonCount: 0,
    findings: new Map(),
    limits: selectedLimits,
    uncertainties: [],
    uncertaintyKeys: new Set(),
  };
  try {
    const activeByContext = new Map<EffectiveContextResolution, readonly ActiveStatement[]>();
    for (const context of contexts) {
      const allowed = allowedDocumentPairs(context);
      const active = activeStatements(state, context, byDocument);
      activeByContext.set(context, active);
      for (let left = 0; left < active.length; left += 1)
        for (let right = left + 1; right < active.length; right += 1) {
          const first = active[left];
          const second = active[right];
          /* v8 ignore next -- the two loop bounds prove both active statements exist. */
          if (first === undefined || second === undefined) continue;
          incrementComparison(state);
          if (!allowedPair(allowed, first, second)) continue;
          evaluateStructuredPair(state, context, first, second);
        }
    }
    evaluateDuplication(state, contexts, activeByContext, index);
    evaluateVendorDivergence(state, contexts, activeByContext);
    const generated = diagnostics(state.findings, selectedLimits);
    const suppression = parseSuppressionDirectives(ir);
    const bundle: DiagnosticBundle = Object.freeze({
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: generated,
      recordKind: "agent-context-diagnostics",
      suppressions: Object.freeze(suppression.directives.map((entry) => entry.record)),
    });
    const validatedBundle = validateDiagnosticBundle(bundle, ir.sources);
    /* v8 ignore next 10 -- diagnostics are built only from validated B03 locations and closed B04 primitives. */
    if (!validatedBundle.ok) {
      const first = validatedBundle.issues[0];
      return failure(
        issue(
          "dependency-failure",
          "$output",
          first === undefined
            ? "generated diagnostics failed B04 validation"
            : `generated diagnostics failed B04 validation at ${first.path} (${first.code})`,
        ),
      );
    }
    const uncertainties = Object.freeze(
      state.uncertainties.sort(
        (left, right) =>
          compareUtf8(left.contextId, right.contextId) ||
          compareUtf8(left.reason, right.reason) ||
          compareUtf8(left.documentId ?? "", right.documentId ?? ""),
      ),
    );
    const result = Object.freeze({
      bundle: validatedBundle.value,
      classifierContractVersion: STATEMENT_CLASSIFIER_CONTRACT_VERSION,
      contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
      duplicationIndexContractVersion: DUPLICATION_INDEX_CONTRACT_VERSION,
      effectiveContextContractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
      limits: selectedLimits,
      metrics: Object.freeze({
        comparisonCount: state.comparisonCount,
        contextCount: contexts.length,
        diagnosticCount: generated.length,
        exactClusterCount: index.exactClusters.length,
        nearClusterCount: index.nearClusters.length,
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
    if (error instanceof ConflictsDuplicationAbort) return failure(error.detail);
    /* v8 ignore next -- dependency exceptions are normalized without fault-injecting production modules. */
    return failure(issue("dependency-failure", "$evaluation", "conflict evaluation failed"));
  }
}

/** Apply only parser-issued B08 directives to an evaluator-issued F08 result. */
export function finalizeConflictsDuplicationSuppressions(
  evaluation: unknown,
): ConflictsDuplicationSuppressionFinalizationResult {
  if (evaluation === null || typeof evaluation !== "object" || nodeTypes.isProxy(evaluation))
    return Object.freeze({
      issues: Object.freeze([
        issue("invalid-input", "$.evaluation", "must be an issued F08 evaluation"),
      ]),
      ok: false,
    });
  const issued = issuedEvaluations.get(evaluation);
  if (issued === undefined)
    return Object.freeze({
      issues: Object.freeze([
        issue("invalid-input", "$.evaluation", "must be an issued F08 evaluation"),
      ]),
      ok: false,
    });
  const result = evaluation as Extract<ConflictsDuplicationResult, { readonly ok: true }>;
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
    /* v8 ignore next 6 -- B08 receives the exact parser-issued IR and directives branded above. */
    return Object.freeze({
      issues: Object.freeze([
        issue("dependency-failure", "$.evaluation", "suppression processing failed"),
      ]),
      ok: false,
    });
  }
}
