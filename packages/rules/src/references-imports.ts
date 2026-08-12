import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  MAX_DIAGNOSTICS_PER_BUNDLE,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
  computePathFingerprint,
  computeSemanticFingerprint,
  isRepositoryRelativePath,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import type {
  ClientProfileId,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticId,
  DiagnosticSeverity,
  DiagnosticSourceLocation,
  ImportReference,
  ImportReferenceId,
  InstructionDocument,
  InstructionIr,
  RelatedEvidenceId,
  RepositoryRelativePath,
  SourceDocument,
  SourceRange,
} from "@agent-context/core";
import type { ImportGraphIssueCode, ImportGraphResult } from "@agent-context/evidence";
import {
  CLAUDE_CODE_PROFILE,
  CODEX_CLI_PROFILE,
  GEMINI_CLI_PROFILE,
  copilotProfile,
  cursorSurfaceProfile,
} from "@agent-context/profiles";
import { buildDocumentImportDag, createSyntheticTargetTrace } from "@agent-context/resolver";

export const REFERENCES_IMPORTS_CONTRACT_VERSION = "0.1.0" as const;
export const REFERENCES_IMPORTS_RULE_VERSION = "1.0.0" as const;
export const REFERENCES_IMPORTS_RULE_IDS = [
  "ACL150",
  "ACL151",
  "ACL152",
  "ACL153",
  "ACL154",
  "ACL155",
  "ACL156",
] as const;
export type ReferencesImportsRuleId = (typeof REFERENCES_IMPORTS_RULE_IDS)[number];

export const REFERENCE_PROFILE_IDS = [
  "claude-code",
  "codex-cli",
  "copilot-cli",
  "copilot-vscode",
  "copilot-cloud-agent",
  "copilot-code-review",
  "cursor-agent",
  "gemini-cli",
] as const;
export type ReferenceProfileId = (typeof REFERENCE_PROFILE_IDS)[number];

export const REFERENCE_MARKDOWN_LINK_STATES = [
  "disabled",
  "enabled",
  "not-applicable",
  "unknown",
] as const;
export type ReferenceMarkdownLinkState = (typeof REFERENCE_MARKDOWN_LINK_STATES)[number];

export interface ReferenceProfileTarget {
  readonly formatId: string;
  readonly importId: ImportReferenceId;
  readonly markdownLinks: ReferenceMarkdownLinkState;
  readonly profileId: ReferenceProfileId;
  readonly surfaceId: string;
}

export interface ReferenceRepositoryPathSnapshot {
  readonly completeness: "complete" | "partial";
  readonly paths: readonly RepositoryRelativePath[];
}

export interface ReferencesImportsInput {
  readonly contractVersion: typeof REFERENCES_IMPORTS_CONTRACT_VERSION;
  readonly graphs: readonly ImportGraphResult[];
  readonly ir: InstructionIr;
  readonly pathSnapshot: ReferenceRepositoryPathSnapshot;
  readonly recordKind: "agent-context-references-imports-rule-input";
  readonly targets: readonly ReferenceProfileTarget[];
}

export interface ReferencesImportsLimits {
  readonly maximumDiagnostics: number;
  readonly maximumGraphs: number;
  readonly maximumPaths: number;
  readonly maximumTargets: number;
  readonly maximumTextBytes: number;
  readonly maximumUncertainties: number;
}

export type ReferencesImportsOptions = Partial<ReferencesImportsLimits>;

export const REFERENCES_IMPORTS_DEFAULT_LIMITS: Readonly<ReferencesImportsLimits> = Object.freeze({
  maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
  maximumGraphs: 1_024,
  maximumPaths: 1_000_000,
  maximumTargets: 262_144,
  maximumTextBytes: 16_384,
  maximumUncertainties: 250_000,
});

export const REFERENCES_IMPORTS_HARD_LIMITS: Readonly<ReferencesImportsLimits> = Object.freeze({
  maximumDiagnostics: MAX_DIAGNOSTICS_PER_BUNDLE,
  maximumGraphs: 4_096,
  maximumPaths: 2_000_000,
  maximumTargets: 1_000_000,
  maximumTextBytes: 65_536,
  maximumUncertainties: 250_000,
});

export type ReferenceUncertaintyReason =
  | "ambiguous-case-match"
  | "ambiguous-reference"
  | "graph-resource-limit"
  | "malformed-reference"
  | "path-snapshot-partial"
  | "profile-reference-behavior-unknown"
  | "target-unavailable-not-missing";

export interface ReferenceUncertainty {
  readonly importId: ImportReferenceId;
  readonly profileId: ReferenceProfileId | null;
  readonly reason: ReferenceUncertaintyReason;
  readonly ruleId: ReferencesImportsRuleId;
}

export interface ReferencesImportsMetrics {
  readonly diagnosticCount: number;
  readonly graphCount: number;
  readonly pathCount: number;
  readonly referenceCount: number;
  readonly targetCount: number;
  readonly uncertaintyCount: number;
}

export interface ReferencesImportsResult {
  readonly bundle: DiagnosticBundle;
  readonly contractVersion: typeof REFERENCES_IMPORTS_CONTRACT_VERSION;
  readonly limits: ReferencesImportsLimits;
  readonly metrics: ReferencesImportsMetrics;
  readonly recordKind: "agent-context-references-imports-rule-result";
  readonly sources: readonly SourceDocument[];
  readonly uncertainties: readonly ReferenceUncertainty[];
}

export const ReferencesImportsErrorCode: Readonly<{
  dependencyFailure: "REFERENCES_IMPORTS_DEPENDENCY_FAILURE";
  invalidInput: "REFERENCES_IMPORTS_INVALID_INPUT";
  invalidOptions: "REFERENCES_IMPORTS_INVALID_OPTIONS";
  resourceLimit: "REFERENCES_IMPORTS_RESOURCE_LIMIT";
}> = Object.freeze({
  dependencyFailure: "REFERENCES_IMPORTS_DEPENDENCY_FAILURE",
  invalidInput: "REFERENCES_IMPORTS_INVALID_INPUT",
  invalidOptions: "REFERENCES_IMPORTS_INVALID_OPTIONS",
  resourceLimit: "REFERENCES_IMPORTS_RESOURCE_LIMIT",
});
export type ReferencesImportsErrorCode =
  (typeof ReferencesImportsErrorCode)[keyof typeof ReferencesImportsErrorCode];

export class ReferencesImportsError extends Error {
  override readonly name = "ReferencesImportsError" as const;
  readonly code: ReferencesImportsErrorCode;

  constructor(code: ReferencesImportsErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;
type SupportState = "supported" | "unsupported" | "unknown";

interface ValidatedTarget extends ReferenceProfileTarget {
  readonly support: SupportState;
}

interface GraphFact {
  readonly importId: ImportReferenceId;
  readonly issueCode: ImportGraphIssueCode | null;
  readonly state:
    | "loaded"
    | "already-loaded"
    | "cycle"
    | "ambiguous"
    | "rejected"
    | "unavailable"
    | "limit-exceeded"
    | "issue-only";
  readonly targetPath: RepositoryRelativePath | null;
}

interface EvaluationContext {
  readonly diagnostics: Diagnostic[];
  readonly documentById: ReadonlyMap<string, InstructionDocument>;
  readonly factsByImport: ReadonlyMap<string, readonly GraphFact[]>;
  readonly importById: ReadonlyMap<string, ImportReference>;
  readonly limits: ReferencesImportsLimits;
  readonly pathSnapshot: ReferenceRepositoryPathSnapshot;
  readonly sourceById: ReadonlyMap<string, SourceDocument>;
  readonly targetsByImport: ReadonlyMap<string, readonly ValidatedTarget[]>;
  readonly uncertainties: ReferenceUncertainty[];
  readonly uncertaintyKeys: Set<string>;
}

const INPUT_KEYS = ["contractVersion", "graphs", "ir", "pathSnapshot", "recordKind", "targets"];
const PATH_SNAPSHOT_KEYS = ["completeness", "paths"];
const TARGET_KEYS = ["formatId", "importId", "markdownLinks", "profileId", "surfaceId"];
const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const PROFILE_SET = new Set<string>(REFERENCE_PROFILE_IDS);
const MARKDOWN_LINK_SET = new Set<string>(REFERENCE_MARKDOWN_LINK_STATES);
const RESOURCE_ISSUES = new Set<ImportGraphIssueCode>([
  "IMPORT_GRAPH_DEPTH_LIMIT",
  "IMPORT_GRAPH_EDGE_LIMIT",
  "IMPORT_GRAPH_FAN_OUT_LIMIT",
  "IMPORT_GRAPH_FILE_LIMIT",
  "IMPORT_GRAPH_FILE_TOO_LARGE",
  "IMPORT_GRAPH_TOTAL_BYTES_LIMIT",
]);
const SEVERITY: Readonly<Record<ReferencesImportsRuleId, DiagnosticSeverity>> = Object.freeze({
  ACL150: "error",
  ACL151: "error",
  ACL152: "error",
  ACL153: "warning",
  ACL154: "warning",
  ACL155: "warning",
  ACL156: "warning",
});

function fail(code: ReferencesImportsErrorCode, message: string): never {
  throw new ReferencesImportsError(code, message);
}

function dataRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail(ReferencesImportsErrorCode.invalidInput, `${label} must be a closed plain data record`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail(ReferencesImportsErrorCode.invalidInput, `${label} has unexpected fields`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      fail(ReferencesImportsErrorCode.invalidInput, `${label}.${key} must be an own data property`);
  }
  return value as DataRecord;
}

function property(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    fail(ReferencesImportsErrorCode.invalidInput, `${label} must be a dense regular array`);
  if (value.length > maximum)
    fail(ReferencesImportsErrorCode.resourceLimit, `${label} exceeds its item limit`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      fail(ReferencesImportsErrorCode.invalidInput, `${label} contains an unsafe entry`);
  }
  return value;
}

function boundedText(value: unknown, label: string, limits: ReferencesImportsLimits): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limits.maximumTextBytes)
    fail(ReferencesImportsErrorCode.invalidInput, `${label} must be bounded text`);
  return value;
}

function boundedIdentifier(value: unknown, label: string, limits: ReferencesImportsLimits): string {
  const result = boundedText(value, label, limits);
  if (!IDENTIFIER.test(result))
    fail(ReferencesImportsErrorCode.invalidInput, `${label} must be a stable identifier`);
  return result;
}

function options(value: unknown): ReferencesImportsLimits {
  if (value === undefined) return REFERENCES_IMPORTS_DEFAULT_LIMITS;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail(ReferencesImportsErrorCode.invalidOptions, "options must be a plain data record");
  const allowed = new Set(Object.keys(REFERENCES_IMPORTS_DEFAULT_LIMITS));
  const output = { ...REFERENCES_IMPORTS_DEFAULT_LIMITS };
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key))
      fail(ReferencesImportsErrorCode.invalidOptions, "options have unknown fields");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      fail(ReferencesImportsErrorCode.invalidOptions, `options.${key} is not an own data value`);
    const candidate: unknown = descriptor.value;
    const hard = REFERENCES_IMPORTS_HARD_LIMITS[key as keyof ReferencesImportsLimits];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < 1 ||
      (candidate as number) > hard
    )
      fail(ReferencesImportsErrorCode.invalidOptions, `options.${key} is outside its hard limit`);
    output[key as keyof ReferencesImportsLimits] = candidate as number;
  }
  return Object.freeze(output);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parent(path: RepositoryRelativePath): RepositoryRelativePath {
  const slash = path.lastIndexOf("/");
  return (slash < 0 ? "." : path.slice(0, slash)) as RepositoryRelativePath;
}

function rangeEqual(left: SourceRange | null, right: SourceRange | undefined): boolean {
  if (left === null || right === undefined) return false;
  return (
    left.sourceId === right.sourceId &&
    left.start.byteOffset === right.start.byteOffset &&
    left.start.utf16Offset === right.start.utf16Offset &&
    left.start.line === right.start.line &&
    left.start.utf16Column === right.start.utf16Column &&
    left.end.byteOffset === right.end.byteOffset &&
    left.end.utf16Offset === right.end.utf16Offset &&
    left.end.line === right.end.line &&
    left.end.utf16Column === right.end.utf16Column
  );
}

function profileSupport(
  profileId: ReferenceProfileId,
  surfaceId: string,
  formatId: string,
  markdownLinks: ReferenceMarkdownLinkState,
  reference: ImportReference,
): SupportState {
  if (profileId === "codex-cli") {
    if (
      surfaceId !== CODEX_CLI_PROFILE.surfaceId ||
      formatId !== "agents-markdown" ||
      markdownLinks !== "not-applicable"
    )
      fail(ReferencesImportsErrorCode.invalidInput, "Codex target does not match D03");
    return "unsupported";
  }
  if (profileId === "claude-code") {
    if (
      surfaceId !== CLAUDE_CODE_PROFILE.surfaceId ||
      !CLAUDE_CODE_PROFILE.formatIds.includes(formatId as never) ||
      markdownLinks !== "not-applicable"
    )
      fail(ReferencesImportsErrorCode.invalidInput, "Claude target does not match D05");
    return reference.kind === "vendor-import" ? "supported" : "unsupported";
  }
  if (profileId === "gemini-cli") {
    if (
      surfaceId !== GEMINI_CLI_PROFILE.surfaceId ||
      formatId !== "gemini-context-markdown" ||
      markdownLinks !== "not-applicable"
    )
      fail(ReferencesImportsErrorCode.invalidInput, "Gemini target does not match D10");
    return reference.kind === "vendor-import" ? "supported" : "unsupported";
  }
  if (profileId === "cursor-agent") {
    const descriptor = cursorSurfaceProfile(surfaceId);
    const claim = descriptor?.formats.find((entry) => entry.formatId === formatId);
    if (descriptor === undefined || claim === undefined || markdownLinks !== "not-applicable")
      fail(ReferencesImportsErrorCode.invalidInput, "Cursor target does not match D13");
    return "unknown";
  }
  const descriptor = copilotProfile(profileId);
  const claim = descriptor?.formats.find((entry) => entry.formatId === formatId);
  if (descriptor?.surfaceId !== surfaceId || claim === undefined)
    fail(ReferencesImportsErrorCode.invalidInput, "Copilot target does not match D08");
  if (claim.references === "markdown-links-setting") {
    if (markdownLinks === "not-applicable")
      fail(ReferencesImportsErrorCode.invalidInput, "VS Code link setting state is required");
    if (markdownLinks === "unknown") return "unknown";
    if (markdownLinks === "disabled") return "unsupported";
    return reference.kind === "markdown-link" ? "supported" : "unsupported";
  }
  if (markdownLinks !== "not-applicable")
    fail(ReferencesImportsErrorCode.invalidInput, "link setting is not applicable to this profile");
  if (claim.references === "unknown") return "unknown";
  if (claim.references === "unsupported") return "unsupported";
  return reference.kind === "vendor-import" ? "supported" : "unsupported";
}

function validateTargets(
  value: unknown,
  importById: ReadonlyMap<string, ImportReference>,
  limits: ReferencesImportsLimits,
): ReadonlyMap<string, readonly ValidatedTarget[]> {
  const entries = denseArray(value, limits.maximumTargets, "targets");
  const output = new Map<string, ValidatedTarget[]>();
  const identities = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const label = `targets[${String(index)}]`;
    const record = dataRecord(entry, TARGET_KEYS, label);
    const importId = boundedIdentifier(property(record, "importId"), `${label}.importId`, limits);
    const reference = importById.get(importId);
    if (reference === undefined)
      fail(ReferencesImportsErrorCode.invalidInput, `${label}.importId is not present in B03 IR`);
    const profileId = boundedIdentifier(
      property(record, "profileId"),
      `${label}.profileId`,
      limits,
    );
    const surfaceId = boundedIdentifier(
      property(record, "surfaceId"),
      `${label}.surfaceId`,
      limits,
    );
    const formatId = boundedIdentifier(property(record, "formatId"), `${label}.formatId`, limits);
    const markdownLinks = property(record, "markdownLinks");
    if (
      !PROFILE_SET.has(profileId) ||
      typeof markdownLinks !== "string" ||
      !MARKDOWN_LINK_SET.has(markdownLinks)
    )
      fail(ReferencesImportsErrorCode.invalidInput, `${label} has an unsupported profile state`);
    const identity = `${importId}\0${profileId}\0${surfaceId}\0${formatId}`;
    if (identities.has(identity))
      fail(ReferencesImportsErrorCode.invalidInput, `${label} duplicates a profile target`);
    identities.add(identity);
    const target: ValidatedTarget = Object.freeze({
      formatId,
      importId: importId as ImportReferenceId,
      markdownLinks: markdownLinks as ReferenceMarkdownLinkState,
      profileId: profileId as ReferenceProfileId,
      surfaceId,
      support: profileSupport(
        profileId as ReferenceProfileId,
        surfaceId,
        formatId,
        markdownLinks as ReferenceMarkdownLinkState,
        reference,
      ),
    });
    const current = output.get(importId);
    if (current === undefined) output.set(importId, [target]);
    else current.push(target);
  }
  for (const importId of importById.keys()) {
    if (!output.has(importId))
      fail(ReferencesImportsErrorCode.invalidInput, "every B03 import requires a profile target");
  }
  return new Map(
    [...output.entries()].map(([id, targets]) => [
      id,
      Object.freeze(
        [...targets].sort(
          (left, right) =>
            compareText(left.profileId, right.profileId) ||
            compareText(left.surfaceId, right.surfaceId),
        ),
      ),
    ]),
  );
}

function validatePathSnapshot(
  value: unknown,
  limits: ReferencesImportsLimits,
): ReferenceRepositoryPathSnapshot {
  const record = dataRecord(value, PATH_SNAPSHOT_KEYS, "pathSnapshot");
  const completeness = property(record, "completeness");
  if (completeness !== "complete" && completeness !== "partial")
    fail(ReferencesImportsErrorCode.invalidInput, "pathSnapshot.completeness is invalid");
  const paths = denseArray(property(record, "paths"), limits.maximumPaths, "pathSnapshot.paths");
  const normalized = paths.map((path, index) => {
    if (typeof path !== "string" || path === "." || !isRepositoryRelativePath(path))
      fail(
        ReferencesImportsErrorCode.invalidInput,
        `pathSnapshot.paths[${String(index)}] is not a canonical file path`,
      );
    return path;
  });
  if (
    normalized.some(
      (path, index) => index > 0 && compareText(normalized[index - 1] ?? "", path) >= 0,
    )
  )
    fail(ReferencesImportsErrorCode.invalidInput, "pathSnapshot.paths must be unique and sorted");
  return Object.freeze({ completeness, paths: Object.freeze(normalized) });
}

function validateGraphs(
  value: unknown,
  ir: InstructionIr,
  limits: ReferencesImportsLimits,
): ReadonlyMap<string, readonly GraphFact[]> {
  const graphs = denseArray(value, limits.maximumGraphs, "graphs");
  const importById = new Map(ir.imports.map((reference) => [reference.id, reference]));
  const documentById = new Map(ir.documents.map((document) => [document.id, document]));
  const sourceById = new Map(ir.sources.map((source) => [source.id, source]));
  const output = new Map<string, GraphFact[]>();
  for (const [graphIndex, rawGraph] of graphs.entries()) {
    let dag;
    try {
      const graph = rawGraph as ImportGraphResult;
      dag = buildDocumentImportDag({
        graph,
        trace: createSyntheticTargetTrace({
          launchCwd: parent(graph.entryPath),
          purpose: "f06-reference-validation",
          targetPath: graph.entryPath,
          workspaceRoots: ["." as RepositoryRelativePath],
        }),
      });
    } catch {
      fail(
        ReferencesImportsErrorCode.dependencyFailure,
        `graphs[${String(graphIndex)}] is not a valid C10 graph`,
      );
    }
    for (const document of dag.documents) {
      const irDocument = documentById.get(document.documentId);
      const source = sourceById.get(document.sourceId);
      if (
        irDocument === undefined ||
        source === undefined ||
        irDocument.sourceId !== document.sourceId ||
        source.path !== document.path ||
        source.sha256 !== document.contentId.slice("content:".length) ||
        source.byteLength !== document.byteLength
      )
        fail(
          ReferencesImportsErrorCode.invalidInput,
          "C10 graph documents must be byte-identical members of the B03 IR",
        );
    }
    const factKeys = new Set<string>();
    for (const occurrence of dag.occurrences) {
      if (occurrence.importId === null) continue;
      const reference = importById.get(occurrence.importId);
      if (
        reference?.documentId !== occurrence.fromDocumentId ||
        !rangeEqual(occurrence.range, reference.specifierRange)
      )
        fail(
          ReferencesImportsErrorCode.invalidInput,
          "C10 graph imports must correspond exactly to B03 references",
        );
      const fact: GraphFact = Object.freeze({
        importId: occurrence.importId,
        issueCode: occurrence.issueCode,
        state: occurrence.state as GraphFact["state"],
        targetPath: occurrence.targetPath,
      });
      const key = `${fact.importId}\0${fact.issueCode ?? ""}\0${fact.state}\0${fact.targetPath ?? ""}`;
      factKeys.add(key);
      const current = output.get(fact.importId);
      if (current === undefined) output.set(fact.importId, [fact]);
      else if (
        !current.some(
          (entry) =>
            `${entry.importId}\0${entry.issueCode ?? ""}\0${entry.state}\0${entry.targetPath ?? ""}` ===
            key,
        )
      )
        current.push(fact);
    }
    for (const issue of dag.issues) {
      if (issue.importId === null) continue;
      const reference = importById.get(issue.importId);
      if (reference === undefined || !rangeEqual(issue.range, reference.specifierRange))
        fail(
          ReferencesImportsErrorCode.invalidInput,
          "C10 graph issues must correspond exactly to B03 references",
        );
      const key = `${issue.importId}\0${issue.code}\0issue-only\0${issue.targetPath ?? ""}`;
      if (factKeys.has(key)) continue;
      const fact: GraphFact = Object.freeze({
        importId: issue.importId,
        issueCode: issue.code,
        state: "issue-only",
        targetPath: issue.targetPath,
      });
      const current = output.get(issue.importId);
      if (current === undefined) output.set(issue.importId, [fact]);
      else if (
        !current.some(
          (entry) => entry.issueCode === issue.code && entry.targetPath === issue.targetPath,
        )
      )
        current.push(fact);
    }
  }
  return new Map(
    [...output.entries()].map(([id, facts]) => [
      id,
      Object.freeze(
        [...facts].sort(
          (left, right) =>
            compareText(left.targetPath ?? "", right.targetPath ?? "") ||
            compareText(left.issueCode ?? "", right.issueCode ?? "") ||
            compareText(left.state, right.state),
        ),
      ),
    ]),
  );
}

function sourceLocation(
  context: EvaluationContext,
  reference: ImportReference,
): DiagnosticSourceLocation {
  const document = context.documentById.get(reference.documentId);
  const source = document === undefined ? undefined : context.sourceById.get(document.sourceId);
  /* v8 ignore next 2 -- B03 validation makes both maps total for every import. */
  if (source === undefined)
    fail(ReferencesImportsErrorCode.dependencyFailure, "reference source is unavailable");
  return Object.freeze({
    path: source.path,
    range: reference.specifierRange,
    sourceDigest: source.sha256,
    sourceId: source.id,
  });
}

function sha256(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values)
    hash.update(`${String(Buffer.byteLength(value, "utf8"))}:`, "ascii").update(value, "utf8");
  return hash.digest("hex");
}

function addDiagnostic(
  context: EvaluationContext,
  reference: ImportReference,
  ruleId: ReferencesImportsRuleId,
  message: string,
  profileIds: readonly ReferenceProfileId[],
  evidenceKey: string,
): void {
  if (context.diagnostics.length >= context.limits.maximumDiagnostics)
    fail(ReferencesImportsErrorCode.resourceLimit, "diagnostics exceed their limit");
  const primary = sourceLocation(context, reference);
  const profiles = Object.freeze(
    [...new Set(profileIds)].sort(compareText).map((profile) => profile as ClientProfileId),
  );
  const anchor = `reference:${reference.id}`;
  const pathBasis = Object.freeze({ anchor, profileIds: profiles });
  const semanticBasis = Object.freeze({
    components: Object.freeze([
      Object.freeze({ key: "evidence", value: evidenceKey }),
      Object.freeze({ key: "reference-kind", value: reference.kind }),
      Object.freeze({ key: "specifier-sha256", value: sha256(reference.rawSpecifier) }),
      Object.freeze({ key: "target-kind", value: reference.targetKind }),
    ]),
    profileIds: profiles,
  });
  const semantic = computeSemanticFingerprint({
    basis: semanticBasis,
    ruleId,
    ruleVersion: REFERENCES_IMPORTS_RULE_VERSION,
  });
  const sourceEvidence = Object.freeze({
    id: `evidence:${sha256(ruleId, reference.id).slice(0, 32)}` as RelatedEvidenceId,
    kind: "source" as const,
    label: "Reference syntax source",
    location: primary,
  });
  context.diagnostics.push(
    Object.freeze({
      fingerprintBasis: Object.freeze({ path: pathBasis, semantic: semanticBasis }),
      fingerprints: Object.freeze({
        path: Object.freeze({
          method: PATH_FINGERPRINT_METHOD,
          value: computePathFingerprint({
            basis: pathBasis,
            path: primary.path,
            ruleId,
            ruleVersion: REFERENCES_IMPORTS_RULE_VERSION,
          }),
        }),
        semantic: Object.freeze({ method: SEMANTIC_FINGERPRINT_METHOD, value: semantic }),
      }),
      id: `diagnostic:${ruleId.toLowerCase()}:${semantic.slice(0, 32)}` as DiagnosticId,
      message,
      primary,
      related: Object.freeze([sourceEvidence]),
      ruleId,
      ruleVersion: REFERENCES_IMPORTS_RULE_VERSION,
      severity: SEVERITY[ruleId],
      suggestion: Object.freeze({
        fixPlan: null,
        message:
          "Review the profile-owned reference syntax and use a repository-contained, portable target.",
      }),
    }),
  );
}

function addUncertainty(
  context: EvaluationContext,
  reference: ImportReference,
  ruleId: ReferencesImportsRuleId,
  reason: ReferenceUncertaintyReason,
  profileId: ReferenceProfileId | null,
): void {
  const key = `${reference.id}\0${ruleId}\0${reason}\0${profileId ?? ""}`;
  if (context.uncertaintyKeys.has(key)) return;
  if (context.uncertainties.length >= context.limits.maximumUncertainties)
    fail(ReferencesImportsErrorCode.resourceLimit, "uncertainties exceed their limit");
  context.uncertaintyKeys.add(key);
  context.uncertainties.push(Object.freeze({ importId: reference.id, profileId, reason, ruleId }));
}

function asciiFold(value: string): string | null {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit > 0x7f) return null;
    output += unit >= 0x41 && unit <= 0x5a ? String.fromCharCode(unit + 0x20) : value.charAt(index);
  }
  return output;
}

function evaluatePathFact(
  context: EvaluationContext,
  reference: ImportReference,
  fact: GraphFact,
  profiles: readonly ReferenceProfileId[],
): void {
  if (fact.issueCode === "IMPORT_GRAPH_CYCLE")
    addDiagnostic(
      context,
      reference,
      "ACL151",
      "The reference participates in an import cycle.",
      profiles,
      "c10-cycle",
    );
  if (fact.issueCode === "IMPORT_GRAPH_ROOT_BOUNDARY")
    addDiagnostic(
      context,
      reference,
      "ACL152",
      "The reference resolves outside the selected repository boundary.",
      profiles,
      "c10-root-boundary",
    );
  if (fact.issueCode !== null && RESOURCE_ISSUES.has(fact.issueCode))
    addUncertainty(context, reference, "ACL150", "graph-resource-limit", null);
  if (fact.targetPath === null) return;
  const exact = context.pathSnapshot.paths.includes(fact.targetPath);
  if (exact) {
    if (fact.issueCode === "IMPORT_GRAPH_READ_FAILED")
      addUncertainty(context, reference, "ACL150", "target-unavailable-not-missing", null);
    return;
  }
  if (context.pathSnapshot.completeness === "partial") {
    if (fact.issueCode === "IMPORT_GRAPH_READ_FAILED")
      addUncertainty(context, reference, "ACL150", "path-snapshot-partial", null);
    return;
  }
  const folded = asciiFold(fact.targetPath);
  const caseMatches =
    folded === null ? [] : context.pathSnapshot.paths.filter((path) => asciiFold(path) === folded);
  const caseMatch = caseMatches[0];
  if (caseMatches.length === 1 && caseMatch !== undefined) {
    addDiagnostic(
      context,
      reference,
      "ACL156",
      "The reference path casing differs from the repository path.",
      profiles,
      `case:${caseMatch}`,
    );
    return;
  }
  if (caseMatches.length > 1) {
    addUncertainty(context, reference, "ACL156", "ambiguous-case-match", null);
    return;
  }
  if (fact.issueCode === "IMPORT_GRAPH_READ_FAILED")
    addDiagnostic(
      context,
      reference,
      "ACL150",
      "The referenced repository file does not exist in the complete path snapshot.",
      profiles,
      `missing:${fact.targetPath}`,
    );
  else if (fact.state === "loaded" || fact.state === "already-loaded")
    fail(
      ReferencesImportsErrorCode.invalidInput,
      "a complete path snapshot cannot omit a C10-loaded target",
    );
}

function evaluateReference(context: EvaluationContext, reference: ImportReference): void {
  const targets = context.targetsByImport.get(reference.id);
  /* v8 ignore next 2 -- validateTargets requires complete coverage of the B03 import set. */
  if (targets === undefined)
    fail(ReferencesImportsErrorCode.dependencyFailure, "reference profile target is unavailable");
  const profiles = targets.map((target) => target.profileId);
  if (reference.state === "malformed") {
    addUncertainty(context, reference, "ACL155", "malformed-reference", null);
    return;
  }
  if (reference.state === "ambiguous" || reference.uncertainty.state !== "known") {
    addUncertainty(context, reference, "ACL155", "ambiguous-reference", null);
    return;
  }
  if (reference.targetKind === "absolute-path-candidate")
    addDiagnostic(
      context,
      reference,
      "ACL153",
      "The reference uses an absolute local path and is not portable across machines.",
      profiles,
      "absolute-local-path",
    );
  const unsupported = targets.filter((target) => target.support === "unsupported");
  const unknown = targets.filter((target) => target.support === "unknown");
  if (reference.targetKind === "url") {
    const remoteUnsupported = targets.filter(
      (target) =>
        target.profileId === "claude-code" ||
        target.profileId === "codex-cli" ||
        target.profileId === "gemini-cli" ||
        target.profileId === "copilot-cli" ||
        (target.profileId === "copilot-vscode" && target.support === "unsupported"),
    );
    const remoteUnknown = targets.filter(
      (target) =>
        target.profileId === "cursor-agent" ||
        target.profileId === "copilot-cloud-agent" ||
        target.profileId === "copilot-code-review" ||
        (target.profileId === "copilot-vscode" && target.support === "unknown"),
    );
    if (remoteUnsupported.length > 0)
      addDiagnostic(
        context,
        reference,
        "ACL154",
        "The selected client profile does not load this remote reference as instruction content.",
        remoteUnsupported.map((target) => target.profileId),
        `remote:${remoteUnsupported.map((target) => target.profileId).join(",")}`,
      );
    for (const target of remoteUnknown)
      addUncertainty(
        context,
        reference,
        "ACL154",
        "profile-reference-behavior-unknown",
        target.profileId,
      );
  } else {
    for (const target of unsupported)
      addDiagnostic(
        context,
        reference,
        "ACL155",
        "This reference syntax is unsupported by the selected client profile and format.",
        [target.profileId],
        `unsupported:${target.profileId}:${target.formatId}`,
      );
    for (const target of unknown)
      addUncertainty(
        context,
        reference,
        "ACL155",
        "profile-reference-behavior-unknown",
        target.profileId,
      );
  }
  for (const fact of context.factsByImport.get(reference.id) ?? [])
    evaluatePathFact(context, reference, fact, profiles);
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareText(left.primary.path, right.primary.path) ||
    left.primary.range.start.byteOffset - right.primary.range.start.byteOffset ||
    compareText(left.ruleId, right.ruleId) ||
    compareText(left.fingerprints.semantic.value, right.fingerprints.semantic.value)
  );
}

/**
 * Evaluate ACL150-ACL156 over closed B03, C10, and D03-D13 evidence.
 *
 * This function is synchronous, deterministic, model-free, and has no filesystem, process,
 * environment, clock, or network capability. Repository absence is asserted only from a complete
 * caller-supplied path snapshot; profile uncertainty is preserved explicitly.
 */
export function evaluateReferencesImports(
  inputValue: ReferencesImportsInput,
  optionsValue?: ReferencesImportsOptions,
): ReferencesImportsResult {
  const limits = options(optionsValue);
  const input = dataRecord(inputValue, INPUT_KEYS, "input");
  if (
    property(input, "recordKind") !== "agent-context-references-imports-rule-input" ||
    property(input, "contractVersion") !== REFERENCES_IMPORTS_CONTRACT_VERSION
  )
    fail(ReferencesImportsErrorCode.invalidInput, "input contract identity is unsupported");
  const irValidation = validateInstructionIr(property(input, "ir"));
  if (!irValidation.ok)
    fail(ReferencesImportsErrorCode.invalidInput, "input.ir is not a valid B03 instruction IR");
  const ir = irValidation.value;
  const importById = new Map(ir.imports.map((reference) => [reference.id, reference]));
  const pathSnapshot = validatePathSnapshot(property(input, "pathSnapshot"), limits);
  const targetsByImport = validateTargets(property(input, "targets"), importById, limits);
  const factsByImport = validateGraphs(property(input, "graphs"), ir, limits);
  const context: EvaluationContext = {
    diagnostics: [],
    documentById: new Map(ir.documents.map((document) => [document.id, document])),
    factsByImport,
    importById,
    limits,
    pathSnapshot,
    sourceById: new Map(ir.sources.map((source) => [source.id, source])),
    targetsByImport,
    uncertainties: [],
    uncertaintyKeys: new Set(),
  };
  for (const reference of [...ir.imports].sort((left, right) => compareText(left.id, right.id)))
    evaluateReference(context, reference);
  context.diagnostics.sort(compareDiagnostics);
  context.uncertainties.sort(
    (left, right) =>
      compareText(left.importId, right.importId) ||
      compareText(left.ruleId, right.ruleId) ||
      compareText(left.profileId ?? "", right.profileId ?? "") ||
      compareText(left.reason, right.reason),
  );
  const bundle: DiagnosticBundle = Object.freeze({
    contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
    diagnostics: Object.freeze(context.diagnostics),
    recordKind: "agent-context-diagnostics",
    suppressions: Object.freeze([]),
  });
  const validation = validateDiagnosticBundle(bundle, ir.sources);
  /* v8 ignore next 5 -- diagnostics are constructed solely from validated B03 locations and B04 primitives. */
  if (!validation.ok)
    fail(
      ReferencesImportsErrorCode.dependencyFailure,
      "generated diagnostics do not satisfy the B04 contract",
    );
  return Object.freeze({
    bundle: validation.value,
    contractVersion: REFERENCES_IMPORTS_CONTRACT_VERSION,
    limits,
    metrics: Object.freeze({
      diagnosticCount: bundle.diagnostics.length,
      graphCount: (property(input, "graphs") as readonly unknown[]).length,
      pathCount: pathSnapshot.paths.length,
      referenceCount: ir.imports.length,
      targetCount: (property(input, "targets") as readonly unknown[]).length,
      uncertaintyCount: context.uncertainties.length,
    }),
    recordKind: "agent-context-references-imports-rule-result",
    sources: ir.sources,
    uncertainties: Object.freeze(context.uncertainties),
  });
}
