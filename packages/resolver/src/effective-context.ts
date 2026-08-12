import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { isRepositoryRelativePath } from "@agent-context/core";

import type { RepositoryRelativePath } from "@agent-context/core";
import { isIssuedClaudeCodeProfileResolution } from "./claude-code-profile.js";
import { isIssuedCodexCliAgentsResolution } from "./codex-cli-profile.js";
import { isIssuedCopilotProfileResolution } from "./copilot-profile.js";
import { isIssuedCursorProfileResolution } from "./cursor-profile.js";
import { isIssuedDocumentImportDag } from "./document-import-dag.js";
import { isIssuedGeminiCliResolution } from "./gemini-cli-profile.js";

import type { ClaudeCodeProfileResolution } from "./claude-code-profile.js";
import type { CodexCliAgentsResolution } from "./codex-cli-profile.js";
import type { CopilotProfileResolution } from "./copilot-profile.js";
import type { CursorProfileResolution } from "./cursor-profile.js";
import type { DocumentImportDag, ImportDagOccurrence } from "./document-import-dag.js";
import type { GeminiCliResolution } from "./gemini-cli-profile.js";

export const EFFECTIVE_CONTEXT_CONTRACT_VERSION = "0.1.0" as const;
export const EFFECTIVE_CONTEXT_RECORD_KIND = "agent-context-effective-context" as const;
export const EFFECTIVE_CONTEXT_INPUT_RECORD_KIND = "agent-context-effective-context-input" as const;

export const EFFECTIVE_CONTEXT_LIMITS: Readonly<{
  maximumAmbiguities: number;
  maximumConflicts: number;
  maximumDocuments: number;
  maximumImportDags: number;
  maximumOccurrences: number;
  maximumTextBytes: number;
}> = Object.freeze({
  maximumAmbiguities: 65_536,
  maximumConflicts: 65_536,
  maximumDocuments: 4_096,
  maximumImportDags: 4_096,
  maximumOccurrences: 65_537,
  maximumTextBytes: 16_777_216,
});

export type EffectiveContextProfileResolution =
  | ClaudeCodeProfileResolution
  | CodexCliAgentsResolution
  | CopilotProfileResolution
  | CursorProfileResolution
  | GeminiCliResolution;

export interface ResolveEffectiveContextInput {
  readonly contractVersion: typeof EFFECTIVE_CONTEXT_CONTRACT_VERSION;
  readonly importDags: readonly DocumentImportDag[];
  readonly profileResolution: EffectiveContextProfileResolution;
  readonly recordKind: typeof EFFECTIVE_CONTEXT_INPUT_RECORD_KIND;
  readonly targetPath: RepositoryRelativePath;
}

export type EffectiveDocumentActivation = "active" | "inactive" | "indeterminate";
export type EffectiveDocumentState =
  "conditional" | "effective" | "empty" | "inactive" | "shadowed" | "unavailable";
export type EffectiveContentState =
  "complete" | "identity-only" | "truncated-prefix" | "unavailable";

export interface EffectiveContextDocument {
  readonly activation: EffectiveDocumentActivation;
  readonly availableBytes: number | null;
  readonly contentSha256: string | null;
  readonly contentState: EffectiveContentState;
  readonly formatId: string;
  readonly id: string;
  readonly includedBytes: number | null;
  readonly order: number | null;
  readonly path: RepositoryRelativePath;
  readonly reasonCode: string;
  readonly sourceDocumentId: string | null;
  readonly state: EffectiveDocumentState;
  readonly text: string | null;
  readonly truncation: "none" | "prefix" | "unknown";
}

export interface EffectiveContextPrecedence {
  readonly afterDocumentId: string;
  readonly beforeDocumentId: string;
  readonly kind: "documented-partial-order" | "observed-load-order";
}

export interface EffectiveContextConflictOpportunity {
  readonly firstDocumentId: string;
  readonly id: string;
  readonly precedence:
    "documented-order" | "semantic-winner-unknown" | "undefined" | "unknown-activation";
  readonly secondDocumentId: string;
}

export type EffectiveContextAmbiguityKind =
  | "activation"
  | "external-context"
  | "import-resolution"
  | "partial-profile"
  | "precedence"
  | "semantic-precedence"
  | "target-scope"
  | "truncation";

export interface EffectiveContextAmbiguity {
  readonly documentIds: readonly string[];
  readonly id: string;
  readonly kind: EffectiveContextAmbiguityKind;
  readonly reasonCode: string;
}

export interface EffectiveContextOccurrence {
  readonly contentId: string | null;
  readonly entryDocumentId: string;
  readonly id: string;
  readonly issueCode: string | null;
  readonly ordinal: number;
  readonly state: ImportDagOccurrence["state"];
  readonly targetDocumentId: string | null;
  readonly targetPath: RepositoryRelativePath | null;
}

export interface EffectiveContextAssembly {
  readonly byteLength: number | null;
  readonly documentIds: readonly string[];
  readonly sha256: string | null;
  readonly state: "exact" | "partial" | "unknown";
  readonly text: string | null;
}

export interface EffectiveContextResolution {
  readonly ambiguities: readonly EffectiveContextAmbiguity[];
  readonly analysisStatus: "complete" | "partial";
  readonly assembly: EffectiveContextAssembly;
  readonly clientVersion: string | null;
  readonly conflicts: readonly EffectiveContextConflictOpportunity[];
  readonly contractVersion: typeof EFFECTIVE_CONTEXT_CONTRACT_VERSION;
  readonly documents: readonly EffectiveContextDocument[];
  readonly occurrences: readonly EffectiveContextOccurrence[];
  readonly ordering: "partial" | "total" | "unknown" | "unordered";
  readonly precedence: readonly EffectiveContextPrecedence[];
  readonly profileId: string;
  readonly profileVersion: string;
  readonly recordKind: typeof EFFECTIVE_CONTEXT_RECORD_KIND;
  readonly sequence: readonly string[];
  readonly specSnapshotId: string;
  readonly surfaceId: string;
  readonly targetPath: RepositoryRelativePath;
}

const ISSUED_EFFECTIVE_CONTEXT_RESOLUTIONS = new WeakSet<object>();

/** True only for effective-context resolutions produced by this process's E05 resolver. */
export function isIssuedEffectiveContextResolution(
  value: unknown,
): value is EffectiveContextResolution {
  return (
    typeof value === "object" && value !== null && ISSUED_EFFECTIVE_CONTEXT_RESOLUTIONS.has(value)
  );
}

export const EffectiveContextErrorCode: Readonly<{
  invalidInput: "EFFECTIVE_CONTEXT_INVALID_INPUT";
  invalidRelationship: "EFFECTIVE_CONTEXT_INVALID_RELATIONSHIP";
  resourceLimit: "EFFECTIVE_CONTEXT_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "EFFECTIVE_CONTEXT_INVALID_INPUT",
  invalidRelationship: "EFFECTIVE_CONTEXT_INVALID_RELATIONSHIP",
  resourceLimit: "EFFECTIVE_CONTEXT_RESOURCE_LIMIT",
});

export type EffectiveContextErrorCode =
  (typeof EffectiveContextErrorCode)[keyof typeof EffectiveContextErrorCode];

export class EffectiveContextError extends Error {
  readonly code: EffectiveContextErrorCode;
  override readonly name = "EffectiveContextError" as const;

  constructor(code: EffectiveContextErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface Projection {
  readonly ambiguities: EffectiveContextAmbiguity[];
  readonly assembly: EffectiveContextAssembly;
  readonly clientVersion: string | null;
  readonly documents: EffectiveContextDocument[];
  readonly ordering: EffectiveContextResolution["ordering"];
  readonly precedence: EffectiveContextPrecedence[];
  readonly profileId: string;
  readonly profileVersion: string;
  readonly sequence: string[];
  readonly specSnapshotId: string;
  readonly surfaceId: string;
}

const INPUT_KEYS = new Set([
  "contractVersion",
  "importDags",
  "profileResolution",
  "recordKind",
  "targetPath",
]);
const PROFILE_RECORD_KINDS = new Set([
  "agent-context-claude-code-profile-resolution",
  "agent-context-codex-cli-agents-resolution",
  "agent-context-copilot-profile-resolution",
  "agent-context-cursor-profile-resolution",
  "agent-context-gemini-cli-resolution",
]);
function fail(code: EffectiveContextErrorCode, message: string): never {
  throw new EffectiveContextError(code, message);
}

function dataRecord(value: unknown, label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  )
    return fail(EffectiveContextErrorCode.invalidInput, `${label} must be a non-proxy data record`);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return fail(EffectiveContextErrorCode.invalidInput, `${label} must be a plain data record`);
  return value as DataRecord;
}

function closedRecord(value: unknown, keys: ReadonlySet<string>, label: string): DataRecord {
  const record = dataRecord(value, label);
  const actual = Reflect.ownKeys(record);
  if (
    actual.length !== keys.size ||
    actual.some((key) => typeof key !== "string" || !keys.has(key))
  )
    return fail(EffectiveContextErrorCode.invalidInput, `${label} has unknown or missing fields`);
  for (const key of actual) field(record, key as string, label);
  return record;
}

function field(record: DataRecord, key: string, label: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
    return fail(
      EffectiveContextErrorCode.invalidInput,
      `${label}.${key} must be an own data field`,
    );
  return descriptor.value;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return fail(EffectiveContextErrorCode.invalidInput, `${label} must be a regular dense array`);
  if (value.length > maximum)
    return fail(EffectiveContextErrorCode.resourceLimit, `${label} exceeds its item limit`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1)
    return fail(EffectiveContextErrorCode.invalidInput, `${label} must not be sparse or extended`);
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return fail(EffectiveContextErrorCode.invalidInput, `${label} must contain own data entries`);
    output.push(descriptor.value);
  }
  return output;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || !isRepositoryRelativePath(value))
    return fail(
      EffectiveContextErrorCode.invalidInput,
      `${label} must be a canonical repository path`,
    );
  return value;
}

function recordKind(value: DataRecord): string {
  const kind = field(value, "recordKind", "profileResolution");
  if (typeof kind !== "string" || !PROFILE_RECORD_KINDS.has(kind))
    return fail(EffectiveContextErrorCode.invalidInput, "profileResolution kind is unsupported");
  return kind;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hash(...values: readonly string[]): string {
  const digest = createHash("sha256");
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

function documentId(profileId: string, path: RepositoryRelativePath): string {
  return `effective-document:${hash(profileId, path).slice(0, 32)}`;
}

function contentDigest(value: string | null): string | null {
  return value === null ? null : createHash("sha256").update(value, "utf8").digest("hex");
}

function addAmbiguity(
  output: EffectiveContextAmbiguity[],
  kind: EffectiveContextAmbiguityKind,
  reasonCode: string,
  documentIds: readonly string[],
): void {
  const sortedIds = [...documentIds].sort(compareUtf8);
  const id = `ambiguity:${hash(kind, reasonCode, ...sortedIds).slice(0, 32)}`;
  if (output.some((entry) => entry.id === id)) return;
  /* v8 ignore next -- upstream profile/DAG limits cannot issue this many initial ambiguities */
  if (output.length >= EFFECTIVE_CONTEXT_LIMITS.maximumAmbiguities)
    return fail(EffectiveContextErrorCode.resourceLimit, "ambiguity count exceeds its limit");
  output.push(Object.freeze({ documentIds: Object.freeze(sortedIds), id, kind, reasonCode }));
}

function makeDocument(input: {
  readonly activation: EffectiveDocumentActivation;
  readonly availableBytes?: number | null;
  readonly contentState: EffectiveContentState;
  readonly formatId: string;
  readonly includedBytes?: number | null;
  readonly order?: number | null;
  readonly path: RepositoryRelativePath;
  readonly profileId: string;
  readonly reasonCode: string;
  readonly sourceDocumentId?: string | null;
  readonly state: EffectiveDocumentState;
  readonly text: string | null;
  readonly truncation?: EffectiveContextDocument["truncation"];
}): EffectiveContextDocument {
  const digest = contentDigest(input.text);
  return Object.freeze({
    activation: input.activation,
    availableBytes:
      input.availableBytes ?? (input.text === null ? null : Buffer.byteLength(input.text, "utf8")),
    contentSha256: digest,
    contentState: input.contentState,
    formatId: input.formatId,
    id: documentId(input.profileId, input.path),
    includedBytes:
      input.includedBytes ?? (input.text === null ? null : Buffer.byteLength(input.text, "utf8")),
    order: input.order ?? null,
    path: input.path,
    reasonCode: input.reasonCode,
    sourceDocumentId: input.sourceDocumentId ?? null,
    state: input.state,
    text: input.text,
    truncation: input.truncation ?? "none",
  });
}

function profileIdentity(profile: EffectiveContextProfileResolution["profile"]): {
  clientVersion: string | null;
  profileId: string;
  profileVersion: string;
  specSnapshotId: string;
  surfaceId: string;
} {
  return {
    clientVersion: "clientVersion" in profile ? profile.clientVersion : null,
    profileId: profile.profileId,
    profileVersion: profile.contractVersion,
    specSnapshotId: profile.specSnapshotId,
    surfaceId: profile.surfaceId,
  };
}

function syntaxText(
  value: ClaudeCodeProfileResolution["candidates"][number]["syntax"],
): string | null {
  return value.transformedBody;
}

function bodyText(
  value:
    | CopilotProfileResolution["candidates"][number]["syntax"]
    | CursorProfileResolution["candidates"][number]["syntax"],
): string | null {
  const range = value.bodyRange;
  return value.text === null || range === null
    ? value.text
    : value.text.slice(range.start.utf16Offset, range.end.utf16Offset);
}

function assembly(
  state: EffectiveContextAssembly["state"],
  documentIds: readonly string[],
  value: string | null,
): EffectiveContextAssembly {
  return Object.freeze({
    byteLength: value === null ? null : Buffer.byteLength(value, "utf8"),
    documentIds: Object.freeze([...documentIds]),
    sha256: contentDigest(value),
    state,
    text: value,
  });
}

function projectCodex(value: CodexCliAgentsResolution): Projection {
  const profile = profileIdentity(value.profile);
  const ambiguities: EffectiveContextAmbiguity[] = [];
  const selectedByPath = new Map(value.selected.map((entry) => [entry.path, entry]));
  const contributionByPath = new Map(value.contributions.map((entry) => [entry.path, entry]));
  const documents: EffectiveContextDocument[] = [];
  for (const decision of value.candidateDecisions) {
    if (decision.entryKind === null || decision.state === "missing") continue;
    const selected = selectedByPath.get(decision.path);
    const contribution = contributionByPath.get(decision.path);
    const isSelected = selected !== undefined;
    const conditional =
      decision.state === "selection-contingent" || decision.state === "selection-unknown";
    const unavailable = selected?.availableBytes === null;
    const empty =
      selected?.state === "empty-after-trim" ||
      selected?.state === "bounded-prefix-empty-after-trim";
    const state: EffectiveDocumentState =
      decision.state === "shadowed"
        ? "shadowed"
        : conditional
          ? "conditional"
          : unavailable
            ? "unavailable"
            : empty
              ? "empty"
              : isSelected
                ? "effective"
                : "inactive";
    const activation: EffectiveDocumentActivation = conditional
      ? "indeterminate"
      : isSelected
        ? "active"
        : "inactive";
    const doc = makeDocument({
      activation,
      availableBytes: selected?.availableBytes ?? null,
      contentState: unavailable
        ? "unavailable"
        : selected?.truncated === true
          ? "truncated-prefix"
          : contribution === undefined
            ? "identity-only"
            : "complete",
      formatId: "agents-markdown",
      includedBytes: selected?.bytesIncluded ?? null,
      order: isSelected ? value.selected.indexOf(selected) : null,
      path: decision.path,
      profileId: profile.profileId,
      reasonCode: decision.state,
      sourceDocumentId: contribution?.syntax?.document.id ?? null,
      state,
      text: contribution?.text ?? null,
      truncation: selected?.truncated === true ? "prefix" : unavailable ? "unknown" : "none",
    });
    documents.push(doc);
    if (conditional) addAmbiguity(ambiguities, "activation", decision.state, [doc.id]);
    if (selected?.truncated === true)
      addAmbiguity(ambiguities, "truncation", selected.state, [doc.id]);
  }
  const effective = documents
    .filter((entry) => entry.activation === "active" && entry.state !== "shadowed")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const precedence = effective.slice(1).map((entry, index) =>
    Object.freeze({
      afterDocumentId: entry.id,
      beforeDocumentId: effective[index]?.id ?? "",
      kind: "observed-load-order" as const,
    }),
  );
  if (effective.length > 1)
    addAmbiguity(
      ambiguities,
      "semantic-precedence",
      value.semanticPrecedence,
      effective.map((entry) => entry.id),
    );
  if (value.externalContext.state === "unavailable")
    addAmbiguity(ambiguities, "external-context", "codex-global-context-unavailable", []);
  return {
    ambiguities,
    assembly: assembly(
      value.analysisStatus === "complete" && value.externalContext.state !== "unavailable"
        ? "exact"
        : "partial",
      effective.map((entry) => entry.id),
      value.assembledText,
    ),
    clientVersion: profile.clientVersion,
    documents,
    ordering: documents.some((entry) => entry.activation === "indeterminate") ? "partial" : "total",
    precedence,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    sequence: effective.map((entry) => entry.id),
    specSnapshotId: profile.specSnapshotId,
    surfaceId: profile.surfaceId,
  };
}

function projectClaude(value: ClaudeCodeProfileResolution): Projection {
  const profile = profileIdentity(value.profile);
  const ambiguities: EffectiveContextAmbiguity[] = [];
  const documents = value.candidates
    .map((candidate) => {
      const state: EffectiveDocumentState =
        candidate.activation === "active"
          ? "effective"
          : candidate.activation === "inactive"
            ? "inactive"
            : "conditional";
      const candidateText = syntaxText(candidate.syntax);
      const doc = makeDocument({
        activation: candidate.activation,
        contentState: candidateText === null ? "unavailable" : "complete",
        formatId:
          candidate.syntax.format === "memory" ? "claude-memory-markdown" : "claude-rule-markdown",
        path: candidate.path,
        profileId: profile.profileId,
        reasonCode: candidate.code,
        sourceDocumentId: candidate.syntax.documentId,
        state,
        text: candidateText,
        truncation: "none",
      });
      if (candidate.activation === "indeterminate")
        addAmbiguity(ambiguities, "activation", candidate.code, [doc.id]);
      for (const imported of candidate.imports)
        if (imported.state !== "loaded")
          addAmbiguity(ambiguities, "import-resolution", imported.state, [doc.id]);
      return doc;
    })
    .sort((left, right) => compareUtf8(left.path, right.path));
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  const precedence: EffectiveContextPrecedence[] = [];
  for (const candidate of value.candidates) {
    const after = byPath.get(candidate.path);
    if (after === undefined) continue;
    for (const beforePath of candidate.orderAfter) {
      const before = byPath.get(beforePath);
      if (before !== undefined)
        precedence.push(
          Object.freeze({
            afterDocumentId: after.id,
            beforeDocumentId: before.id,
            kind: "documented-partial-order",
          }),
        );
    }
  }
  const active = documents.filter((entry) => entry.activation !== "inactive");
  for (const reason of value.unresolvedOrdering)
    addAmbiguity(
      ambiguities,
      "precedence",
      reason,
      active.map((entry) => entry.id),
    );
  if (value.externalContext !== "supplied")
    addAmbiguity(ambiguities, "external-context", `claude-external-${value.externalContext}`, []);
  const ordered = topologicalSequence(active, precedence, ambiguities);
  return {
    ambiguities,
    assembly: assembly("partial", ordered.sequence, null),
    clientVersion: value.runtime.clientVersion,
    documents,
    ordering: ordered.complete ? "total" : "partial",
    precedence,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    sequence: ordered.sequence,
    specSnapshotId: profile.specSnapshotId,
    surfaceId: profile.surfaceId,
  };
}

function targetActivation(
  candidate: {
    readonly targetDecisions: readonly {
      readonly state: EffectiveDocumentActivation;
      readonly targetPath: RepositoryRelativePath;
    }[];
  },
  targetPath: RepositoryRelativePath,
): EffectiveDocumentActivation {
  const exact = candidate.targetDecisions.find((entry) => entry.targetPath === targetPath);
  return exact?.state ?? "indeterminate";
}

function projectCopilot(
  value: CopilotProfileResolution,
  targetPath: RepositoryRelativePath,
): Projection {
  const profile = profileIdentity(value.profile);
  const ambiguities: EffectiveContextAmbiguity[] = [];
  if (
    !value.candidates.some((candidate) =>
      candidate.targetDecisions.some((entry) => entry.targetPath === targetPath),
    )
  )
    addAmbiguity(ambiguities, "target-scope", "copilot-target-not-profiled", []);
  const documents = value.candidates
    .map((candidate) => {
      const activation = targetActivation(candidate, targetPath);
      const state: EffectiveDocumentState =
        activation === "active"
          ? "effective"
          : activation === "inactive"
            ? "inactive"
            : "conditional";
      const candidateText = bodyText(candidate.syntax);
      const doc = makeDocument({
        activation,
        contentState: candidateText === null ? "unavailable" : "complete",
        formatId: candidate.format,
        path: candidate.path,
        profileId: profile.profileId,
        reasonCode: candidate.code,
        sourceDocumentId: candidate.syntax.documentId,
        state,
        text: candidateText,
      });
      if (activation === "indeterminate")
        addAmbiguity(ambiguities, "activation", candidate.code, [doc.id]);
      return doc;
    })
    .sort((left, right) => compareUtf8(left.path, right.path));
  const possible = documents.filter((entry) => entry.activation !== "inactive");
  if (possible.length > 1)
    addAmbiguity(
      ambiguities,
      "precedence",
      "copilot-general-precedence-undefined",
      possible.map((entry) => entry.id),
    );
  return {
    ambiguities,
    assembly: assembly(
      possible.length <= 1 && possible.every((entry) => entry.text !== null)
        ? "partial"
        : "unknown",
      possible.map((entry) => entry.id),
      null,
    ),
    clientVersion: profile.clientVersion,
    documents,
    ordering: possible.length <= 1 ? "total" : "unordered",
    precedence: [],
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    sequence: possible.map((entry) => entry.id).sort(compareUtf8),
    specSnapshotId: profile.specSnapshotId,
    surfaceId: profile.surfaceId,
  };
}

function geminiDocumentText(value: GeminiCliResolution["documents"][number]["syntax"]): {
  sourceDocumentId: string | null;
  text: string | null;
} {
  if (value === null) return { sourceDocumentId: null, text: null };
  return { sourceDocumentId: value.document.id, text: value.source.text };
}

function projectGemini(value: GeminiCliResolution): Projection {
  const profile = profileIdentity(value.profile);
  const ambiguities: EffectiveContextAmbiguity[] = [];
  const documents = value.documents.map((candidate, order) => {
    const content = geminiDocumentText(candidate.syntax);
    const effective = candidate.state === "loaded";
    const doc = makeDocument({
      activation: effective ? "active" : "indeterminate",
      contentState: content.text === null ? "unavailable" : "complete",
      formatId: "gemini-context-markdown",
      order,
      path: candidate.path,
      profileId: profile.profileId,
      reasonCode: candidate.state,
      sourceDocumentId: content.sourceDocumentId,
      state: effective ? "effective" : "unavailable",
      text: content.text,
    });
    if (!effective)
      addAmbiguity(ambiguities, "activation", "gemini-candidate-unavailable", [doc.id]);
    return doc;
  });
  const effective = documents.filter((entry) => entry.state === "effective");
  const precedence = effective.slice(1).map((entry, index) =>
    Object.freeze({
      afterDocumentId: entry.id,
      beforeDocumentId: effective[index]?.id ?? "",
      kind: "observed-load-order" as const,
    }),
  );
  for (const issue of value.issues)
    addAmbiguity(
      ambiguities,
      issue.code === "import-partial" ? "import-resolution" : "partial-profile",
      issue.code,
      issue.path === null ? [] : [documentId(profile.profileId, issue.path)],
    );
  if (value.externalContext === "unavailable")
    addAmbiguity(ambiguities, "external-context", "gemini-external-context-unavailable", []);
  return {
    ambiguities,
    assembly: assembly(
      "partial",
      effective.map((entry) => entry.id),
      null,
    ),
    clientVersion: profile.clientVersion,
    documents,
    ordering: "total",
    precedence,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    sequence: effective.map((entry) => entry.id),
    specSnapshotId: profile.specSnapshotId,
    surfaceId: profile.surfaceId,
  };
}

function projectCursor(
  value: CursorProfileResolution,
  targetPath: RepositoryRelativePath,
): Projection {
  const profile = profileIdentity(value.profile);
  const ambiguities: EffectiveContextAmbiguity[] = [];
  const runtimeTargets = new Set(value.runtime.events.map((entry) => entry.targetPath));
  if (runtimeTargets.size > 1)
    addAmbiguity(ambiguities, "target-scope", "cursor-multi-target-trace", []);
  const documents = value.candidates
    .map((candidate) => {
      const activation =
        runtimeTargets.size === 0 || (runtimeTargets.size === 1 && runtimeTargets.has(targetPath))
          ? candidate.activation
          : "indeterminate";
      const state: EffectiveDocumentState =
        activation === "active"
          ? "effective"
          : activation === "inactive"
            ? "inactive"
            : "conditional";
      const candidateText = bodyText(candidate.syntax);
      const doc = makeDocument({
        activation,
        contentState: candidateText === null ? "unavailable" : "complete",
        formatId: candidate.format === "mdc" ? "cursor-rule-mdc" : "cursor-legacy",
        path: candidate.path,
        profileId: profile.profileId,
        reasonCode: candidate.code,
        sourceDocumentId: candidate.syntax.documentId,
        state,
        text: candidateText,
      });
      if (activation === "indeterminate")
        addAmbiguity(ambiguities, "activation", candidate.code, [doc.id]);
      if (candidate.references.some((entry) => entry.state === "indeterminate"))
        addAmbiguity(ambiguities, "import-resolution", "cursor-reference-base-unknown", [doc.id]);
      return doc;
    })
    .sort((left, right) => compareUtf8(left.path, right.path));
  const possible = documents.filter((entry) => entry.activation !== "inactive");
  if (possible.length > 1)
    addAmbiguity(
      ambiguities,
      "precedence",
      "cursor-rule-precedence-unknown",
      possible.map((entry) => entry.id),
    );
  if (value.externalContext !== "absent")
    addAmbiguity(ambiguities, "external-context", `cursor-external-${value.externalContext}`, []);
  return {
    ambiguities,
    assembly: assembly("unknown", possible.map((entry) => entry.id).sort(compareUtf8), null),
    clientVersion: value.runtime.clientVersion,
    documents,
    ordering: possible.length <= 1 ? "total" : "unknown",
    precedence: [],
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    sequence: possible.map((entry) => entry.id).sort(compareUtf8),
    specSnapshotId: profile.specSnapshotId,
    surfaceId: profile.surfaceId,
  };
}

function topologicalSequence(
  documents: readonly EffectiveContextDocument[],
  edges: readonly EffectiveContextPrecedence[],
  ambiguities: EffectiveContextAmbiguity[],
): { readonly complete: boolean; readonly sequence: string[] } {
  const ids = new Set(documents.map((entry) => entry.id));
  const indegree = new Map([...ids].map((id) => [id, 0]));
  const afterByBefore = new Map<string, string[]>();
  for (const edge of edges) {
    /* v8 ignore next -- D05 only issues edges between candidates in the same resolution */
    if (!ids.has(edge.beforeDocumentId) || !ids.has(edge.afterDocumentId)) continue;
    indegree.set(edge.afterDocumentId, (indegree.get(edge.afterDocumentId) ?? 0) + 1);
    const after = afterByBefore.get(edge.beforeDocumentId) ?? [];
    after.push(edge.afterDocumentId);
    afterByBefore.set(edge.beforeDocumentId, after);
  }
  const sequence: string[] = [];
  let unique = true;
  while (sequence.length < ids.size) {
    const ready = [...ids]
      .filter((id) => !sequence.includes(id) && indegree.get(id) === 0)
      .sort(compareUtf8);
    /* v8 ignore next -- D05's documented parent relation is acyclic */
    if (ready.length === 0) {
      /* v8 ignore next */
      addAmbiguity(ambiguities, "precedence", "precedence-cycle", [...ids]);
      /* v8 ignore next */
      break;
    }
    if (ready.length > 1) unique = false;
    const current = ready[0];
    /* v8 ignore next -- guarded by ready.length above */
    if (current === undefined) break;
    sequence.push(current);
    for (const after of afterByBefore.get(current) ?? [])
      indegree.set(after, (indegree.get(after) ?? 1) - 1);
  }
  return { complete: sequence.length === ids.size && unique, sequence };
}

function validateDags(
  value: unknown,
  documentPaths: ReadonlySet<string>,
): readonly DocumentImportDag[] {
  const values = denseArray(value, EFFECTIVE_CONTEXT_LIMITS.maximumImportDags, "input.importDags");
  const output: DocumentImportDag[] = [];
  const entries = new Set<string>();
  let occurrences = 0;
  for (const [index, candidate] of values.entries()) {
    if (!isIssuedDocumentImportDag(candidate))
      return fail(
        EffectiveContextErrorCode.invalidInput,
        `input.importDags[${String(index)}] was not issued by E04`,
      );
    const dag = candidate;
    const entryPath = dag.entryPath;
    if (entries.has(entryPath) || !documentPaths.has(entryPath))
      return fail(
        EffectiveContextErrorCode.invalidRelationship,
        "import DAG entry must uniquely match a profile document",
      );
    occurrences += dag.occurrences.length;
    /* v8 ignore next -- aggregate guard retained above E04's per-DAG hard limit */
    if (occurrences > EFFECTIVE_CONTEXT_LIMITS.maximumOccurrences)
      return fail(
        EffectiveContextErrorCode.resourceLimit,
        "aggregate import occurrence count exceeds its limit",
      );
    entries.add(entryPath);
    output.push(dag);
  }
  return output;
}

function projectOccurrences(
  dags: readonly DocumentImportDag[],
  documents: readonly EffectiveContextDocument[],
  ambiguities: EffectiveContextAmbiguity[],
): EffectiveContextOccurrence[] {
  const byPath = new Map(documents.map((entry) => [entry.path, entry]));
  const output: EffectiveContextOccurrence[] = [];
  for (const dag of [...dags].sort((a, b) => compareUtf8(a.entryPath, b.entryPath))) {
    const entry = byPath.get(dag.entryPath);
    /* v8 ignore next -- validateDags established the entry relationship */
    if (entry === undefined)
      return fail(
        EffectiveContextErrorCode.invalidRelationship,
        "import DAG entry document disappeared",
      );
    const dagDocumentIds = new Set(dag.documents.map((document) => document.documentId));
    for (const occurrence of dag.occurrences) {
      /* v8 ignore next -- E04 validates occurrence targets before issuing a DAG */
      if (occurrence.targetDocumentId !== null && !dagDocumentIds.has(occurrence.targetDocumentId))
        return fail(
          EffectiveContextErrorCode.invalidRelationship,
          "import occurrence target is absent from its DAG",
        );
      const projected = Object.freeze({
        contentId: occurrence.contentId,
        entryDocumentId: entry.id,
        id: occurrence.id,
        issueCode: occurrence.issueCode,
        ordinal: occurrence.ordinal,
        state: occurrence.state,
        targetDocumentId: occurrence.targetDocumentId,
        targetPath: occurrence.targetPath,
      });
      output.push(projected);
      if (!["entry", "loaded", "already-loaded"].includes(occurrence.state))
        addAmbiguity(
          ambiguities,
          occurrence.state === "limit-exceeded" ? "truncation" : "import-resolution",
          occurrence.issueCode ?? occurrence.state,
          [entry.id],
        );
    }
    if (dag.graphState === "partial")
      addAmbiguity(ambiguities, "import-resolution", "import-dag-partial", [entry.id]);
  }
  return output;
}

function conflictPrecedence(
  first: EffectiveContextDocument,
  second: EffectiveContextDocument,
  precedence: readonly EffectiveContextPrecedence[],
  profileId: string,
): EffectiveContextConflictOpportunity["precedence"] {
  if (first.activation === "indeterminate" || second.activation === "indeterminate")
    return "unknown-activation";
  if (profileId === "codex-cli") return "semantic-winner-unknown";
  if (
    precedence.some(
      (edge) =>
        (edge.beforeDocumentId === first.id && edge.afterDocumentId === second.id) ||
        (edge.beforeDocumentId === second.id && edge.afterDocumentId === first.id),
    )
  )
    return "documented-order";
  return "undefined";
}

function conflicts(
  documents: readonly EffectiveContextDocument[],
  precedence: readonly EffectiveContextPrecedence[],
  profileId: string,
): EffectiveContextConflictOpportunity[] {
  const possible = documents.filter(
    (entry) =>
      entry.activation !== "inactive" && entry.state !== "shadowed" && entry.state !== "empty",
  );
  const output: EffectiveContextConflictOpportunity[] = [];
  for (let left = 0; left < possible.length; left += 1) {
    for (let right = left + 1; right < possible.length; right += 1) {
      if (output.length >= EFFECTIVE_CONTEXT_LIMITS.maximumConflicts)
        return fail(
          EffectiveContextErrorCode.resourceLimit,
          "conflict opportunity count exceeds its limit",
        );
      const first = possible[left];
      const second = possible[right];
      /* v8 ignore next -- loop bounds guarantee both entries */
      if (first === undefined || second === undefined) continue;
      output.push(
        Object.freeze({
          firstDocumentId: first.id,
          id: `conflict:${hash(first.id, second.id).slice(0, 32)}`,
          precedence: conflictPrecedence(first, second, precedence, profileId),
          secondDocumentId: second.id,
        }),
      );
    }
  }
  return output;
}

/**
 * Project one real D-series profile result and optional E04 DAGs into a deterministic, model-free
 * effective-context graph. Profile-specific unknowns remain explicit and never become ordering.
 */
export function resolveEffectiveContext(rawInput: unknown): EffectiveContextResolution {
  const input = closedRecord(rawInput, INPUT_KEYS, "input");
  if (
    field(input, "recordKind", "input") !== EFFECTIVE_CONTEXT_INPUT_RECORD_KIND ||
    field(input, "contractVersion", "input") !== EFFECTIVE_CONTEXT_CONTRACT_VERSION
  )
    return fail(
      EffectiveContextErrorCode.invalidInput,
      "input kind or contract version is invalid",
    );
  const targetPath = pathValue(field(input, "targetPath", "input"), "input.targetPath");
  const profileRecord = dataRecord(
    field(input, "profileResolution", "input"),
    "input.profileResolution",
  );
  const kind = recordKind(profileRecord);
  let projection: Projection;
  if (kind === "agent-context-codex-cli-agents-resolution") {
    if (!isIssuedCodexCliAgentsResolution(profileRecord))
      return fail(
        EffectiveContextErrorCode.invalidInput,
        "profile resolution was not issued by D03",
      );
    const value = profileRecord;
    if (value.targetPath !== targetPath)
      return fail(
        EffectiveContextErrorCode.invalidRelationship,
        "Codex resolution target differs from E05 target",
      );
    projection = projectCodex(value);
  } else if (kind === "agent-context-claude-code-profile-resolution") {
    if (!isIssuedClaudeCodeProfileResolution(profileRecord))
      return fail(
        EffectiveContextErrorCode.invalidInput,
        "profile resolution was not issued by D05",
      );
    projection = projectClaude(profileRecord);
  } else if (kind === "agent-context-copilot-profile-resolution") {
    if (!isIssuedCopilotProfileResolution(profileRecord))
      return fail(
        EffectiveContextErrorCode.invalidInput,
        "profile resolution was not issued by D08",
      );
    projection = projectCopilot(profileRecord, targetPath);
  } else if (kind === "agent-context-gemini-cli-resolution") {
    if (!isIssuedGeminiCliResolution(profileRecord))
      return fail(
        EffectiveContextErrorCode.invalidInput,
        "profile resolution was not issued by D10",
      );
    projection = projectGemini(profileRecord);
  } else {
    if (!isIssuedCursorProfileResolution(profileRecord))
      return fail(
        EffectiveContextErrorCode.invalidInput,
        "profile resolution was not issued by D13",
      );
    projection = projectCursor(profileRecord, targetPath);
  }
  /* v8 ignore next -- every branded profile has an equal or stricter candidate limit */
  if (projection.documents.length > EFFECTIVE_CONTEXT_LIMITS.maximumDocuments)
    return fail(
      EffectiveContextErrorCode.resourceLimit,
      "effective document count exceeds its limit",
    );
  const paths = new Set<string>();
  for (const document of projection.documents) {
    /* v8 ignore next -- each D-series resolver rejects duplicate candidate paths */
    if (paths.has(document.path))
      return fail(
        EffectiveContextErrorCode.invalidRelationship,
        "profile resolution contains duplicate document paths",
      );
    paths.add(document.path);
  }
  const dags = validateDags(field(input, "importDags", "input"), paths);
  const occurrences = projectOccurrences(dags, projection.documents, projection.ambiguities);
  const projectedConflicts = conflicts(
    projection.documents,
    projection.precedence,
    projection.profileId,
  );
  for (const conflict of projectedConflicts) {
    if (conflict.precedence === "undefined")
      addAmbiguity(projection.ambiguities, "precedence", "conflict-precedence-undefined", [
        conflict.firstDocumentId,
        conflict.secondDocumentId,
      ]);
    else if (conflict.precedence === "unknown-activation")
      addAmbiguity(projection.ambiguities, "activation", "conflict-activation-unknown", [
        conflict.firstDocumentId,
        conflict.secondDocumentId,
      ]);
  }
  if ((profileRecord as { readonly analysisStatus?: unknown }).analysisStatus !== "complete")
    addAmbiguity(
      projection.ambiguities,
      "partial-profile",
      `${projection.profileId}-profile-partial`,
      [],
    );
  const ambiguities = Object.freeze(projection.ambiguities.sort((a, b) => compareUtf8(a.id, b.id)));
  const result: EffectiveContextResolution = Object.freeze({
    ambiguities,
    analysisStatus:
      ambiguities.length === 0 && projection.assembly.state === "exact" ? "complete" : "partial",
    assembly: projection.assembly,
    clientVersion: projection.clientVersion,
    conflicts: Object.freeze(projectedConflicts),
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    documents: Object.freeze(projection.documents),
    occurrences: Object.freeze(occurrences),
    ordering: projection.ordering,
    precedence: Object.freeze(projection.precedence),
    profileId: projection.profileId,
    profileVersion: projection.profileVersion,
    recordKind: EFFECTIVE_CONTEXT_RECORD_KIND,
    sequence: Object.freeze(projection.sequence),
    specSnapshotId: projection.specSnapshotId,
    surfaceId: projection.surfaceId,
    targetPath,
  });
  ISSUED_EFFECTIVE_CONTEXT_RESOLUTIONS.add(result);
  return result;
}
