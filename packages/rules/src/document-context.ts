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
import { countEstimatedTokens } from "@agent-context/efficiency/scan-runtime";
import {
  DuplicationIndexError,
  DuplicationIndexErrorCode,
  StatementClassifierError,
  StatementClassifierErrorCode,
  buildDuplicationIndex,
  normalizeAndClassifyStatement,
} from "@agent-context/evidence";

import type {
  AstNode,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticId,
  DiagnosticSeverity,
  DiagnosticSourceLocation,
  FingerprintComponent,
  ImportReference,
  InstructionDocument,
  InstructionIr,
  RelatedEvidence,
  RelatedEvidenceId,
  RepositoryFactRelatedEvidence,
  SourceDocument,
  SourceRange,
} from "@agent-context/core";
import type { TokenCount } from "@agent-context/efficiency/scan-runtime";
import type {
  DuplicationEvidencePointer,
  DuplicationIndexEntry,
  DuplicationIndexResult,
  StatementClassifierResult,
} from "@agent-context/evidence";

export const DOCUMENT_CONTEXT_RULE_CONTRACT_VERSION = "0.1.0" as const;
export const DOCUMENT_CONTEXT_RULE_VERSION = "1.0.0" as const;
export const DOCUMENT_CONTEXT_BUDGET_SCOPE = "raw-always-on-document" as const;
export const DOCUMENT_CONTEXT_RULE_IDS = [
  "ACL350",
  "ACL351",
  "ACL352",
  "ACL353",
  "ACL354",
  "ACL355",
] as const;

export type DocumentContextRuleId = (typeof DOCUMENT_CONTEXT_RULE_IDS)[number];

export interface DocumentContextRuleThresholds {
  readonly largeCodeBlockTokens: number;
  readonly longInstructionTokens: number;
  readonly maxAlwaysOnTokens: number;
  readonly maximumImportExpansionBasisPoints: number;
  readonly minimumImportedTokens: number;
}

export const DOCUMENT_CONTEXT_DEFAULT_THRESHOLDS: Readonly<DocumentContextRuleThresholds> =
  Object.freeze({
    largeCodeBlockTokens: 256,
    longInstructionTokens: 128,
    maxAlwaysOnTokens: 4_000,
    maximumImportExpansionBasisPoints: 20_000,
    minimumImportedTokens: 128,
  });

export const DOCUMENT_CONTEXT_HARD_MAXIMUM_THRESHOLD = 1_000_000 as const;
export const DOCUMENT_CONTEXT_MAX_IMPORTS_PER_DOCUMENT = 60 as const;

export type DocumentContextRuleOptions = Partial<DocumentContextRuleThresholds>;

export interface ImportResolutionProvenance {
  readonly collectorId: string;
  readonly factId: string;
  readonly valueDigest: string;
}

export interface DocumentImportResolution {
  readonly importId: string;
  readonly provenance: ImportResolutionProvenance;
  /** Target content must already be present in the supplied B03 source registry. */
  readonly targetSourceId: string;
}

export interface DocumentContextRuleInput {
  readonly contractVersion: typeof DOCUMENT_CONTEXT_RULE_CONTRACT_VERSION;
  readonly importResolutions: readonly DocumentImportResolution[];
  readonly ir: InstructionIr;
  readonly recordKind: "agent-context-document-context-rule-input";
}

export interface DocumentContextRuleIssue {
  readonly code: "dependency-failure" | "invalid-input" | "invalid-options" | "resource-limit";
  readonly message: string;
  readonly path: string;
}

export interface DocumentContextRuleMetrics {
  readonly budgetScope: typeof DOCUMENT_CONTEXT_BUDGET_SCOPE;
  readonly diagnosticCount: number;
  readonly documentCount: number;
  readonly duplicationExactClusterCount: number;
  readonly importResolutionCount: number;
  readonly statementCount: number;
  readonly tokenizer: TokenCount["identity"];
}

export type DocumentContextRuleResult =
  | {
      readonly ok: true;
      readonly bundle: DiagnosticBundle;
      readonly duplicationIndex: DuplicationIndexResult;
      readonly metrics: DocumentContextRuleMetrics;
      readonly sources: readonly SourceDocument[];
    }
  | { readonly ok: false; readonly issues: readonly DocumentContextRuleIssue[] };

interface ValidatedImportResolution {
  readonly importId: string;
  readonly provenance: ImportResolutionProvenance;
  readonly targetSourceId: string;
}

interface EvaluationContext {
  readonly diagnostics: Diagnostic[];
  readonly documentById: ReadonlyMap<string, InstructionDocument>;
  readonly importById: ReadonlyMap<string, ImportReference>;
  readonly ir: InstructionIr;
  readonly nodeById: ReadonlyMap<string, AstNode>;
  readonly sourceById: ReadonlyMap<string, SourceDocument>;
  readonly thresholds: DocumentContextRuleThresholds;
}

const INPUT_KEYS = new Set(["contractVersion", "importResolutions", "ir", "recordKind"]);
const IMPORT_RESOLUTION_KEYS = new Set(["importId", "provenance", "targetSourceId"]);
const PROVENANCE_KEYS = new Set(["collectorId", "factId", "valueDigest"]);
const OPTION_KEYS = new Set(Object.keys(DOCUMENT_CONTEXT_DEFAULT_THRESHOLDS));
const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VAGUE_STATEMENTS = new Set([
  "be careful",
  "do a good job",
  "do it correctly",
  "ensure quality",
  "follow best practices",
  "keep it clean",
  "keep things clean",
  "make it good",
  "use common sense",
  "write clean code",
]);
const METADATA_DESCRIPTION =
  /^(?:(?:this|the) (?:codebase|project|repository) (?:contains|includes|is|is licensed under|is written in|runs on|uses)|the (?:package manager|project name|repository name) is)\s+\S/iu;
const REQUIREMENT_START =
  /^(?:always|avoid|do not|ensure|keep|maintain|must|never|only|prefer|run|should|use|verify)\b/iu;

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function frozenIssue(
  code: DocumentContextRuleIssue["code"],
  path: string,
  message: string,
): DocumentContextRuleIssue {
  return Object.freeze({ code, message, path });
}

function failure(issue: DocumentContextRuleIssue): DocumentContextRuleResult {
  return Object.freeze({ ok: false, issues: Object.freeze([issue]) });
}

function plainDataRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, unknown> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return undefined;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== allowed.size ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key))
    )
      return undefined;
    const output = new Map<string, unknown>();
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
        return undefined;
      output.set(key as string, descriptor.value as unknown);
    }
    return output;
  } catch {
    return undefined;
  }
}

function denseDataArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) return undefined;
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = value.length;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1 ||
      keys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length),
      )
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
        return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return undefined;
  }
}

function stableIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    STABLE_IDENTIFIER.test(value)
  );
}

function validateOptions(value: unknown): DocumentContextRuleThresholds | DocumentContextRuleIssue {
  if (value === undefined) return DOCUMENT_CONTEXT_DEFAULT_THRESHOLDS;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return frozenIssue("invalid-options", "$options", "options must be a closed plain data object");
  let keys: readonly PropertyKey[];
  try {
    if (Reflect.getPrototypeOf(value) !== Object.prototype) throw new TypeError("prototype");
    keys = Reflect.ownKeys(value);
  } catch {
    return frozenIssue("invalid-options", "$options", "options must be safely inspectable");
  }
  if (keys.some((key) => typeof key !== "string" || !OPTION_KEYS.has(key)))
    return frozenIssue("invalid-options", "$options", "options contain an unknown field");
  const output = {
    largeCodeBlockTokens: DOCUMENT_CONTEXT_DEFAULT_THRESHOLDS.largeCodeBlockTokens,
    longInstructionTokens: DOCUMENT_CONTEXT_DEFAULT_THRESHOLDS.longInstructionTokens,
    maxAlwaysOnTokens: DOCUMENT_CONTEXT_DEFAULT_THRESHOLDS.maxAlwaysOnTokens,
    maximumImportExpansionBasisPoints:
      DOCUMENT_CONTEXT_DEFAULT_THRESHOLDS.maximumImportExpansionBasisPoints,
    minimumImportedTokens: DOCUMENT_CONTEXT_DEFAULT_THRESHOLDS.minimumImportedTokens,
  };
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
      return frozenIssue(
        "invalid-options",
        `$options.${String(key)}`,
        "must be an own data property",
      );
    const threshold: unknown = descriptor.value as unknown;
    if (
      !Number.isSafeInteger(threshold) ||
      (threshold as number) < 1 ||
      (threshold as number) > DOCUMENT_CONTEXT_HARD_MAXIMUM_THRESHOLD
    )
      return frozenIssue(
        "invalid-options",
        `$options.${String(key)}`,
        `must be an integer from 1 through ${String(DOCUMENT_CONTEXT_HARD_MAXIMUM_THRESHOLD)}`,
      );
    output[key as keyof DocumentContextRuleThresholds] = threshold as number;
  }
  return Object.freeze(output);
}

function validateImportResolutions(
  value: unknown,
): readonly ValidatedImportResolution[] | DocumentContextRuleIssue {
  const entries = denseDataArray(value);
  if (entries === undefined)
    return frozenIssue(
      "invalid-input",
      "$.importResolutions",
      "must be a dense non-proxy data array",
    );
  if (entries.length > 100_000)
    return frozenIssue("resource-limit", "$.importResolutions", "contains too many resolutions");
  const output: ValidatedImportResolution[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const path = `$.importResolutions[${String(index)}]`;
    const fields = plainDataRecord(entry, IMPORT_RESOLUTION_KEYS);
    if (fields === undefined)
      return frozenIssue("invalid-input", path, "must be a closed plain data object");
    const importId = fields.get("importId");
    const targetSourceId = fields.get("targetSourceId");
    const provenance = plainDataRecord(fields.get("provenance"), PROVENANCE_KEYS);
    if (
      !stableIdentifier(importId) ||
      !stableIdentifier(targetSourceId) ||
      provenance === undefined
    )
      return frozenIssue(
        "invalid-input",
        path,
        "contains an invalid stable identifier or provenance",
      );
    const collectorId = provenance.get("collectorId");
    const factId = provenance.get("factId");
    const valueDigest = provenance.get("valueDigest");
    if (
      !stableIdentifier(collectorId) ||
      !stableIdentifier(factId) ||
      typeof valueDigest !== "string" ||
      !SHA256.test(valueDigest)
    )
      return frozenIssue(
        "invalid-input",
        `${path}.provenance`,
        "must contain stable IDs and a SHA-256 digest",
      );
    if (ids.has(importId))
      return frozenIssue(
        "invalid-input",
        `${path}.importId`,
        "must not duplicate another resolution",
      );
    ids.add(importId);
    output.push(
      Object.freeze({
        importId,
        provenance: Object.freeze({ collectorId, factId, valueDigest }),
        targetSourceId,
      }),
    );
  }
  return Object.freeze(output.sort((left, right) => compareUtf8(left.importId, right.importId)));
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

function location(source: SourceDocument, range: SourceRange): DiagnosticSourceLocation {
  return Object.freeze({
    path: source.path,
    range,
    sourceDigest: source.sha256,
    sourceId: source.id,
  });
}

function repositoryEvidence(input: {
  readonly collectorId: string;
  readonly factId: string;
  readonly label: string;
  readonly locations: readonly DiagnosticSourceLocation[];
  readonly seed: string;
  readonly subjectPath: SourceDocument["path"] | null;
  readonly valueDigest: string;
}): RepositoryFactRelatedEvidence {
  return Object.freeze({
    collectorId: input.collectorId,
    factId: input.factId,
    id: `evidence:${sha256(input.seed, input.collectorId, input.factId).slice(0, 32)}` as RelatedEvidenceId,
    kind: "repository-fact",
    label: input.label,
    locations: Object.freeze([...input.locations]),
    subjectPath: input.subjectPath,
    valueDigest: input.valueDigest,
  });
}

function addDiagnostic(
  context: EvaluationContext,
  input: {
    readonly anchor: string;
    readonly components: readonly FingerprintComponent[];
    readonly message: string;
    readonly primary: DiagnosticSourceLocation;
    readonly related: readonly RelatedEvidence[];
    readonly ruleId: DocumentContextRuleId;
    readonly severity: DiagnosticSeverity;
    readonly suggestion: string;
  },
): void {
  if (context.diagnostics.length >= MAX_DIAGNOSTICS_PER_BUNDLE)
    throw new RangeError("maximum diagnostics exceeded");
  const pathBasis = Object.freeze({ anchor: input.anchor, profileIds: Object.freeze([]) });
  const semanticBasis = Object.freeze({
    components: Object.freeze(
      [...input.components].sort((left, right) => compareUtf8(left.key, right.key)),
    ),
    profileIds: Object.freeze([]),
  });
  const semantic = computeSemanticFingerprint({
    basis: semanticBasis,
    ruleId: input.ruleId,
    ruleVersion: DOCUMENT_CONTEXT_RULE_VERSION,
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
            ruleVersion: DOCUMENT_CONTEXT_RULE_VERSION,
          }),
        }),
        semantic: Object.freeze({ method: SEMANTIC_FINGERPRINT_METHOD, value: semantic }),
      }),
      id: `diagnostic:${input.ruleId.toLowerCase()}:${semantic.slice(0, 32)}` as DiagnosticId,
      message: input.message,
      primary: input.primary,
      related: Object.freeze([...input.related]),
      ruleId: input.ruleId,
      ruleVersion: DOCUMENT_CONTEXT_RULE_VERSION,
      severity: input.severity,
      suggestion: Object.freeze({ fixPlan: null, message: input.suggestion }),
    }),
  );
}

function estimatedTokens(text: string): TokenCount {
  const counted = countEstimatedTokens(text);
  if (!counted.ok) throw new RangeError("tokenizer input limit exceeded");
  return counted.value;
}

/** B03 validation has already proven every relationship used through this lookup. */
function validatedGraphValue<T>(values: ReadonlyMap<string, T>, id: string): T {
  return values.get(id) as T;
}

function rootRange(
  document: InstructionDocument,
  nodes: ReadonlyMap<string, AstNode>,
): SourceRange {
  return validatedGraphValue(nodes, document.rootNodeId).range;
}

function tokenizerEvidence(
  source: SourceDocument,
  range: SourceRange,
  count: TokenCount,
  factId: string,
  seed: string,
): RepositoryFactRelatedEvidence {
  return repositoryEvidence({
    collectorId: "builtin:deterministic-estimate",
    factId,
    label: "Deterministic estimated token measurement",
    locations: [location(source, range)],
    seed,
    subjectPath: source.path,
    valueDigest: sha256(
      count.identity.id,
      count.identity.measurement,
      count.identity.version,
      String(count.inputUtf8Bytes),
      String(count.tokens),
    ),
  });
}

function evaluateAcl350(context: EvaluationContext): void {
  const alwaysOnDocuments = new Set(
    context.ir.activationRules
      .filter((rule) => rule.kind === "always" && rule.uncertainty.state === "known")
      .map((rule) => rule.documentId),
  );
  for (const document of context.ir.documents) {
    if (!alwaysOnDocuments.has(document.id)) continue;
    const source = validatedGraphValue(context.sourceById, document.sourceId);
    const count = estimatedTokens(source.text);
    if (count.tokens <= context.thresholds.maxAlwaysOnTokens) continue;
    const range = rootRange(document, context.nodeById);
    const seed = `${document.id}:acl350`;
    addDiagnostic(context, {
      anchor: `document:${document.id}`,
      components: [
        { key: "budget-scope", value: DOCUMENT_CONTEXT_BUDGET_SCOPE },
        { key: "document-digest", value: source.sha256 },
        { key: "max-tokens", value: String(context.thresholds.maxAlwaysOnTokens) },
        { key: "tokens", value: String(count.tokens) },
        { key: "tokenizer", value: `${count.identity.id}/${count.identity.version}` },
      ],
      message: `Estimated raw always-on document size is ${String(count.tokens)} tokens; configured document budget is ${String(context.thresholds.maxAlwaysOnTokens)}.`,
      primary: location(source, range),
      related: [tokenizerEvidence(source, range, count, `document:${document.id}`, seed)],
      ruleId: "ACL350",
      severity: "warning",
      suggestion: "Split the document or narrow its activation while preserving applicable policy.",
    });
  }
}

function evaluateAcl351(context: EvaluationContext): void {
  const documentForSource = new Map<string, InstructionDocument>();
  for (const document of context.ir.documents) {
    if (!documentForSource.has(document.sourceId))
      documentForSource.set(document.sourceId, document);
  }
  for (const node of context.ir.nodes) {
    if (node.kind !== "code-block") continue;
    const document = documentForSource.get(node.sourceId);
    if (document === undefined) continue;
    const source = validatedGraphValue(context.sourceById, node.sourceId);
    const text = source.text.slice(node.range.start.utf16Offset, node.range.end.utf16Offset);
    const count = estimatedTokens(text);
    if (count.tokens <= context.thresholds.largeCodeBlockTokens) continue;
    const seed = `${document.id}:${node.id}:acl351`;
    addDiagnostic(context, {
      anchor: `node:${node.id}`,
      components: [
        { key: "content-digest", value: sha256(text) },
        { key: "node-kind", value: node.kind },
        { key: "threshold", value: String(context.thresholds.largeCodeBlockTokens) },
        { key: "tokens", value: String(count.tokens) },
      ],
      message: `Estimated code-block size is ${String(count.tokens)} tokens; large-block threshold is ${String(context.thresholds.largeCodeBlockTokens)}.`,
      primary: location(source, node.range),
      related: [tokenizerEvidence(source, node.range, count, `code-block:${node.id}`, seed)],
      ruleId: "ACL351",
      severity: "info",
      suggestion:
        "Reference a maintained repository file instead of embedding the large block when practical.",
    });
  }
}

function evaluateAcl352(
  context: EvaluationContext,
  classified: readonly StatementClassifierResult[],
): void {
  for (const result of classified) {
    if (
      result.classification.state !== "unclassified" ||
      !VAGUE_STATEMENTS.has(result.normalizedText)
    )
      continue;
    const statement = result.statement;
    const document = validatedGraphValue(context.documentById, statement.documentId);
    const source = validatedGraphValue(context.sourceById, document.sourceId);
    const normalizedDigest = sha256(result.normalizedText);
    addDiagnostic(context, {
      anchor: `statement:${statement.id}`,
      components: [
        { key: "normalized-text", value: normalizedDigest },
        { key: "statement-id", value: statement.id },
      ],
      message: "Instruction uses a known vague phrase without a verifiable action or outcome.",
      primary: location(source, statement.range),
      related: [
        repositoryEvidence({
          collectorId: "statement-classifier",
          factId: `statement:${statement.id}`,
          label: "Deterministic unclassified statement",
          locations: [location(source, statement.range)],
          seed: `${statement.id}:acl352`,
          subjectPath: source.path,
          valueDigest: normalizedDigest,
        }),
      ],
      ruleId: "ACL352",
      severity: "info",
      suggestion:
        "Replace the phrase with a concrete action and an observable completion condition.",
    });
  }
}

function independentRequirementCount(text: string): number {
  const segments = text
    .replace(/\r\n?/gu, "\n")
    .split(
      /(?:[.;!?]\s+|\n+|\s+(?:and|also)\s+(?=(?:always|avoid|do not|ensure|keep|maintain|must|never|only|prefer|run|should|use|verify)\b))/giu,
    )
    .map((segment) => segment.trim().replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, ""))
    .filter((segment) => segment.length > 0);
  return segments.filter((segment) => REQUIREMENT_START.test(segment)).length;
}

function evaluateAcl353(
  context: EvaluationContext,
  classified: readonly StatementClassifierResult[],
): void {
  for (const result of classified) {
    const statement = result.statement;
    const count = estimatedTokens(statement.text);
    const requirements = independentRequirementCount(statement.text);
    if (count.tokens <= context.thresholds.longInstructionTokens || requirements < 2) continue;
    const document = validatedGraphValue(context.documentById, statement.documentId);
    const source = validatedGraphValue(context.sourceById, document.sourceId);
    const seed = `${statement.id}:acl353`;
    addDiagnostic(context, {
      anchor: `statement:${statement.id}`,
      components: [
        { key: "content-digest", value: sha256(statement.text) },
        { key: "requirement-count", value: String(requirements) },
        { key: "statement-id", value: statement.id },
        { key: "threshold", value: String(context.thresholds.longInstructionTokens) },
        { key: "tokens", value: String(count.tokens) },
      ],
      message: `Estimated instruction size is ${String(count.tokens)} tokens and contains ${String(requirements)} independently signaled requirements.`,
      primary: location(source, statement.range),
      related: [
        tokenizerEvidence(source, statement.range, count, `statement:${statement.id}`, seed),
      ],
      ruleId: "ACL353",
      severity: "info",
      suggestion: "Split the independent requirements into separately reviewable instructions.",
    });
  }
}

function clusterLocations(
  pointers: readonly DuplicationEvidencePointer[],
  context: EvaluationContext,
): readonly DiagnosticSourceLocation[] {
  return Object.freeze(
    pointers.slice(0, 128).flatMap((pointer) => {
      const document = validatedGraphValue(context.documentById, pointer.documentId);
      const source = validatedGraphValue(context.sourceById, document.sourceId);
      return [location(source, pointer.range)];
    }),
  );
}

function evaluateAcl354(
  context: EvaluationContext,
  classifiedById: ReadonlyMap<string, StatementClassifierResult>,
  duplication: DuplicationIndexResult,
): void {
  for (const cluster of duplication.exactClusters) {
    for (const member of cluster.members) {
      const result = classifiedById.get(member.statementId);
      if (
        result?.classification.state !== "unclassified" ||
        !METADATA_DESCRIPTION.test(result.normalizedText)
      )
        continue;
      const document = validatedGraphValue(context.documentById, member.documentId);
      const source = validatedGraphValue(context.sourceById, document.sourceId);
      addDiagnostic(context, {
        anchor: `statement:${member.statementId}`,
        components: [
          { key: "cluster-id", value: cluster.id },
          { key: "normalized-text", value: cluster.normalizedTextSha256 },
          { key: "statement-id", value: member.statementId },
        ],
        message:
          "Repository-description metadata is repeated verbatim across instruction documents.",
        primary: location(source, member.range),
        related: [
          repositoryEvidence({
            collectorId: "duplication-index",
            factId: cluster.id,
            label: "F04 exact-duplication cluster",
            locations: clusterLocations(cluster.members, context),
            seed: `${member.statementId}:acl354`,
            subjectPath: source.path,
            valueDigest: cluster.normalizedTextSha256,
          }),
        ],
        ruleId: "ACL354",
        severity: "info",
        suggestion:
          "Remove repeated description text when repository metadata already conveys it reliably.",
      });
    }
  }
}

function evaluateAcl355(
  context: EvaluationContext,
  resolutions: readonly ValidatedImportResolution[],
): DocumentContextRuleIssue | undefined {
  const byDocument = new Map<string, ValidatedImportResolution[]>();
  for (const resolution of resolutions) {
    const reference = context.importById.get(resolution.importId);
    const target = context.sourceById.get(resolution.targetSourceId);
    if (reference === undefined)
      return frozenIssue(
        "invalid-input",
        "$.importResolutions",
        "references an unknown B03 import ID",
      );
    if (target === undefined)
      return frozenIssue(
        "invalid-input",
        "$.importResolutions",
        "references an unknown B03 target source ID",
      );
    const values = byDocument.get(reference.documentId) ?? [];
    if (values.length >= DOCUMENT_CONTEXT_MAX_IMPORTS_PER_DOCUMENT)
      return frozenIssue(
        "resource-limit",
        "$.importResolutions",
        `a document exceeds ${String(DOCUMENT_CONTEXT_MAX_IMPORTS_PER_DOCUMENT)} resolved imports`,
      );
    values.push(resolution);
    byDocument.set(reference.documentId, values);
  }
  for (const [documentId, entries] of [...byDocument].sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    const document = validatedGraphValue(context.documentById, documentId);
    const source = validatedGraphValue(context.sourceById, document.sourceId);
    const ownCount = estimatedTokens(source.text);
    let importedTokens = 0;
    const related: RelatedEvidence[] = [];
    const provenanceDigests: string[] = [];
    for (const entry of entries.sort((left, right) => compareUtf8(left.importId, right.importId))) {
      const reference = validatedGraphValue(context.importById, entry.importId);
      const target = validatedGraphValue(context.sourceById, entry.targetSourceId);
      const count = estimatedTokens(target.text);
      importedTokens += count.tokens;
      if (!Number.isSafeInteger(importedTokens))
        return frozenIssue(
          "resource-limit",
          "$.importResolutions",
          "aggregate token count is unsafe",
        );
      const importLocation = location(source, reference.specifierRange);
      const evidenceSeed = `${documentId}:${entry.importId}:acl355`;
      related.push(
        repositoryEvidence({
          collectorId: entry.provenance.collectorId,
          factId: entry.provenance.factId,
          label: "Explicit import-resolution provenance",
          locations: [importLocation],
          seed: evidenceSeed,
          subjectPath: source.path,
          valueDigest: entry.provenance.valueDigest,
        }),
        Object.freeze({
          id: `evidence:${sha256(evidenceSeed, target.id).slice(0, 32)}` as RelatedEvidenceId,
          kind: "source" as const,
          label: "Imported B03 source content",
          location: location(target, rootRangeForSource(target, context.nodeById)),
        }),
      );
      provenanceDigests.push(entry.provenance.valueDigest, target.sha256);
    }
    const totalTokens = ownCount.tokens + importedTokens;
    if (
      importedTokens < context.thresholds.minimumImportedTokens ||
      BigInt(totalTokens) * 10_000n <=
        BigInt(ownCount.tokens) * BigInt(context.thresholds.maximumImportExpansionBasisPoints)
    )
      continue;
    const first = entries[0];
    if (first === undefined) throw new TypeError("validated import group must not be empty");
    const firstReference = validatedGraphValue(context.importById, first.importId);
    const aggregateDigest = sha256(
      source.sha256,
      ...provenanceDigests,
      String(ownCount.tokens),
      String(importedTokens),
    );
    related.unshift(
      repositoryEvidence({
        collectorId: "builtin:deterministic-estimate",
        factId: `import-expansion:${document.id}`,
        label: "Document-level estimated import expansion",
        locations: entries.flatMap((entry) => {
          const reference = validatedGraphValue(context.importById, entry.importId);
          return [location(source, reference.specifierRange)];
        }),
        seed: `${document.id}:acl355:aggregate`,
        subjectPath: source.path,
        valueDigest: aggregateDigest,
      }),
    );
    addDiagnostic(context, {
      anchor: `document-imports:${document.id}`,
      components: [
        { key: "budget-scope", value: "direct-document-imports" },
        { key: "expansion-digest", value: aggregateDigest },
        { key: "imported-tokens", value: String(importedTokens) },
        { key: "own-tokens", value: String(ownCount.tokens) },
      ],
      message: `Direct imports expand estimated document context from ${String(ownCount.tokens)} to ${String(totalTokens)} tokens.`,
      primary: location(source, firstReference.specifierRange),
      related,
      ruleId: "ACL355",
      severity: "warning",
      suggestion:
        "Reduce, split, or narrow direct imports so their context cost is explicit and bounded.",
    });
  }
  return undefined;
}

function rootRangeForSource(
  source: SourceDocument,
  nodeById: ReadonlyMap<string, AstNode>,
): SourceRange {
  return validatedGraphValue(nodeById, source.rootNodeId).range;
}

function classifiedStatements(ir: InstructionIr): readonly StatementClassifierResult[] {
  return Object.freeze(
    ir.statements
      .map((statement) =>
        normalizeAndClassifyStatement({
          documentId: statement.documentId,
          nodeIds: statement.nodeIds,
          range: statement.range,
          statementId: statement.id,
          text: statement.text,
        }),
      )
      .sort((left, right) => compareUtf8(left.statement.id, right.statement.id)),
  );
}

function duplicationEntries(
  classified: readonly StatementClassifierResult[],
): readonly DuplicationIndexEntry[] {
  return Object.freeze(
    classified.map((result) =>
      Object.freeze({
        documentId: result.statement.documentId,
        nodeIds: result.statement.nodeIds,
        normalizedText: result.normalizedText,
        range: result.statement.range,
        statementId: result.statement.id,
      }),
    ),
  );
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareUtf8(left.primary.path, right.primary.path) ||
    left.primary.range.start.byteOffset - right.primary.range.start.byteOffset ||
    compareUtf8(left.ruleId, right.ruleId) ||
    compareUtf8(left.fingerprints.semantic.value, right.fingerprints.semantic.value)
  );
}

/**
 * Evaluate ACL350-ACL355 from inert B03 data. The function is deterministic and performs no
 * filesystem, network, process, environment, command, model, or callback access.
 */
export function evaluateDocumentContextRules(
  rawInput: unknown,
  rawOptions?: unknown,
): DocumentContextRuleResult {
  const thresholds = validateOptions(rawOptions);
  if ("code" in thresholds) return failure(thresholds);
  const input = plainDataRecord(rawInput, INPUT_KEYS);
  if (input === undefined)
    return failure(frozenIssue("invalid-input", "$", "input must be a closed plain data object"));
  if (
    input.get("recordKind") !== "agent-context-document-context-rule-input" ||
    input.get("contractVersion") !== DOCUMENT_CONTEXT_RULE_CONTRACT_VERSION
  )
    return failure(frozenIssue("invalid-input", "$", "input kind or contract version is invalid"));
  const imports = validateImportResolutions(input.get("importResolutions"));
  if ("code" in imports) return failure(imports);
  const irValidation = validateInstructionIr(input.get("ir"));
  if (!irValidation.ok)
    return failure(frozenIssue("invalid-input", "$.ir", "must satisfy the closed B03 IR contract"));
  try {
    const ir = irValidation.value;
    if (ir.documents.length > MAX_DIAGNOSTICS_PER_BUNDLE)
      return failure(
        frozenIssue("resource-limit", "$.ir.documents", "contains too many documents"),
      );
    const classified = classifiedStatements(ir);
    const duplication = buildDuplicationIndex(duplicationEntries(classified));
    const sourceById = new Map(ir.sources.map((source) => [source.id, source]));
    const documentById = new Map(ir.documents.map((document) => [document.id, document]));
    const importById = new Map(ir.imports.map((reference) => [reference.id, reference]));
    const context: EvaluationContext = {
      diagnostics: [],
      documentById,
      importById,
      ir,
      nodeById: new Map(ir.nodes.map((node) => [node.id, node])),
      sourceById,
      thresholds,
    };
    evaluateAcl350(context);
    evaluateAcl351(context);
    evaluateAcl352(context, classified);
    evaluateAcl353(context, classified);
    evaluateAcl354(
      context,
      new Map(classified.map((result) => [result.statement.id, result])),
      duplication,
    );
    const importIssue = evaluateAcl355(context, imports);
    if (importIssue !== undefined) return failure(importIssue);
    const bundle: DiagnosticBundle = Object.freeze({
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: Object.freeze(context.diagnostics.sort(compareDiagnostics)),
      recordKind: "agent-context-diagnostics",
      suppressions: Object.freeze([]),
    });
    const validation = validateDiagnosticBundle(bundle, ir.sources);
    if (!validation.ok)
      return failure(
        frozenIssue(
          "dependency-failure",
          "$output",
          "generated diagnostics failed the B04 contract",
        ),
      );
    const identity = countEstimatedTokens("");
    if (!identity.ok)
      return failure(frozenIssue("dependency-failure", "$tokenizer", "G02 tokenizer unavailable"));
    return Object.freeze({
      bundle: validation.value,
      duplicationIndex: duplication,
      metrics: Object.freeze({
        budgetScope: DOCUMENT_CONTEXT_BUDGET_SCOPE,
        diagnosticCount: validation.value.diagnostics.length,
        documentCount: ir.documents.length,
        duplicationExactClusterCount: duplication.exactClusters.length,
        importResolutionCount: imports.length,
        statementCount: ir.statements.length,
        tokenizer: identity.value.identity,
      }),
      ok: true,
      sources: Object.freeze([...ir.sources]),
    });
  } catch (error) {
    const dependencyLimit =
      (error instanceof StatementClassifierError &&
        error.code === StatementClassifierErrorCode.limitExceeded) ||
      (error instanceof DuplicationIndexError &&
        error.code === DuplicationIndexErrorCode.limitExceeded);
    return failure(
      frozenIssue(
        error instanceof RangeError || dependencyLimit ? "resource-limit" : "dependency-failure",
        "$",
        error instanceof RangeError || dependencyLimit
          ? "a bounded evaluation resource limit was exceeded"
          : "a deterministic dependency rejected the validated input",
      ),
    );
  }
}
