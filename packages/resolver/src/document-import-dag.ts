import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { isIssuedInstructionIrSnapshot, isRepositoryRelativePath } from "@agent-context/core";
import type {
  ImportReferenceId,
  InstructionDocumentId,
  RepositoryRelativePath,
  SourceDocumentId,
  SourcePosition,
  SourceRange,
  InstructionIrSnapshot,
} from "@agent-context/core";
import type {
  ImportGraphEdgeState,
  ImportGraphIssueCode,
  ImportGraphResult,
} from "@agent-context/evidence";

import {
  digestResolutionEventTrace,
  normalizeResolutionEventTrace,
  type ResolutionEventTrace,
} from "./resolution-event-trace.js";

export const DOCUMENT_IMPORT_DAG_CONTRACT_VERSION = "0.1.0" as const;

export const DOCUMENT_IMPORT_DAG_LIMITS: Readonly<{
  maxContents: 4_096;
  maxDocuments: 4_096;
  maxGraphIssues: 4_096;
  maxOccurrences: 65_537;
  maxReferences: 262_144;
}> = Object.freeze({
  maxContents: 4_096,
  maxDocuments: 4_096,
  maxGraphIssues: 4_096,
  maxOccurrences: 65_537,
  maxReferences: 262_144,
});

export interface BuildDocumentImportDagInput {
  readonly graph: ImportGraphResult;
  readonly trace: ResolutionEventTrace;
}

export interface BuildNoImportDocumentDagInput {
  readonly documentId: InstructionDocumentId;
  readonly ir: InstructionIrSnapshot;
  readonly trace: ResolutionEventTrace;
}

export interface ImportDagDocument {
  readonly byteLength: number;
  readonly contentId: string;
  readonly depth: number;
  readonly documentId: InstructionDocumentId;
  readonly path: RepositoryRelativePath;
  readonly sourceId: SourceDocumentId;
  readonly state: "loaded" | "parse-failed";
}

export interface ImportDagContent {
  readonly byteLength: number;
  readonly documentIds: readonly InstructionDocumentId[];
  readonly id: string;
  readonly sha256: string;
}

export type ImportDagOccurrenceState = "entry" | ImportGraphEdgeState;

export interface ImportDagOccurrence {
  readonly contentId: string | null;
  readonly depth: number;
  readonly fromDocumentId: InstructionDocumentId | null;
  readonly id: string;
  readonly importId: ImportReferenceId | null;
  readonly issueCode: ImportGraphIssueCode | null;
  readonly ordinal: number;
  readonly range: SourceRange | null;
  readonly state: ImportDagOccurrenceState;
  readonly targetDocumentId: InstructionDocumentId | null;
  readonly targetPath: RepositoryRelativePath | null;
}

export interface ImportDagIssue {
  readonly code: ImportGraphIssueCode;
  readonly importId: ImportReferenceId | null;
  readonly path: RepositoryRelativePath;
  readonly range: SourceRange | null;
  readonly targetPath: RepositoryRelativePath | null;
}

export interface DocumentImportDag {
  readonly recordKind: "agent-context-document-import-dag";
  readonly contractVersion: typeof DOCUMENT_IMPORT_DAG_CONTRACT_VERSION;
  readonly contents: readonly ImportDagContent[];
  readonly documents: readonly ImportDagDocument[];
  readonly entryDocumentId: InstructionDocumentId | null;
  readonly entryPath: RepositoryRelativePath;
  readonly graphState: "complete" | "partial";
  readonly issues: readonly ImportDagIssue[];
  readonly occurrences: readonly ImportDagOccurrence[];
  readonly traceEventIds: readonly string[];
  readonly traceSha256: string;
}

const ISSUED_DOCUMENT_IMPORT_DAGS = new WeakSet<object>();

/** True only for DAGs produced by this process's E04 builder. */
export function isIssuedDocumentImportDag(value: unknown): value is DocumentImportDag {
  return typeof value === "object" && value !== null && ISSUED_DOCUMENT_IMPORT_DAGS.has(value);
}

export const DocumentImportDagErrorCode: Readonly<{
  invalidGraph: "DOCUMENT_IMPORT_DAG_INVALID_GRAPH";
  invalidInput: "DOCUMENT_IMPORT_DAG_INVALID_INPUT";
  invalidRelationship: "DOCUMENT_IMPORT_DAG_INVALID_RELATIONSHIP";
  resourceLimit: "DOCUMENT_IMPORT_DAG_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidGraph: "DOCUMENT_IMPORT_DAG_INVALID_GRAPH",
  invalidInput: "DOCUMENT_IMPORT_DAG_INVALID_INPUT",
  invalidRelationship: "DOCUMENT_IMPORT_DAG_INVALID_RELATIONSHIP",
  resourceLimit: "DOCUMENT_IMPORT_DAG_RESOURCE_LIMIT",
} as const);

export type DocumentImportDagErrorCode =
  (typeof DocumentImportDagErrorCode)[keyof typeof DocumentImportDagErrorCode];

export class DocumentImportDagError extends Error {
  readonly code: DocumentImportDagErrorCode;

  constructor(code: DocumentImportDagErrorCode, message: string) {
    super(message);
    this.name = "DocumentImportDagError";
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface NormalizedNode {
  readonly byteLength: number;
  readonly depth: number;
  readonly documentId: InstructionDocumentId;
  readonly path: RepositoryRelativePath;
  readonly sha256: string;
  readonly sourceId: SourceDocumentId;
  readonly state: "loaded" | "parse-failed";
}

interface NormalizedEdge {
  readonly depth: number;
  readonly fromDocumentId: InstructionDocumentId;
  readonly importId: ImportReferenceId;
  readonly issueCode: ImportGraphIssueCode | null;
  readonly range: SourceRange;
  readonly state: ImportGraphEdgeState;
  readonly targetDocumentId: InstructionDocumentId | null;
  readonly targetPath: RepositoryRelativePath | null;
}

interface NormalizedGraph {
  readonly edges: readonly NormalizedEdge[];
  readonly entryPath: RepositoryRelativePath;
  readonly issues: readonly ImportDagIssue[];
  readonly nodes: readonly NormalizedNode[];
  readonly state: "complete" | "partial";
}

const STABLE_ID = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const EDGE_STATES = new Set<ImportGraphEdgeState>([
  "loaded",
  "already-loaded",
  "cycle",
  "ambiguous",
  "rejected",
  "unavailable",
  "limit-exceeded",
]);
const ISSUE_CODES = new Set<ImportGraphIssueCode>([
  "IMPORT_GRAPH_AMBIGUOUS_REFERENCE",
  "IMPORT_GRAPH_CYCLE",
  "IMPORT_GRAPH_DEPTH_LIMIT",
  "IMPORT_GRAPH_EDGE_LIMIT",
  "IMPORT_GRAPH_FAN_OUT_LIMIT",
  "IMPORT_GRAPH_FILE_LIMIT",
  "IMPORT_GRAPH_FILE_TOO_LARGE",
  "IMPORT_GRAPH_INVALID_UTF8",
  "IMPORT_GRAPH_LEX_FAILED",
  "IMPORT_GRAPH_READ_FAILED",
  "IMPORT_GRAPH_ROOT_BOUNDARY",
  "IMPORT_GRAPH_TARGET_REJECTED",
  "IMPORT_GRAPH_TOTAL_BYTES_LIMIT",
]);

function fail(code: DocumentImportDagErrorCode, message: string): never {
  throw new DocumentImportDagError(code, message);
}

function isRecord(value: unknown): value is DataRecord {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function property(record: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    fail(DocumentImportDagErrorCode.invalidInput, "input must contain enumerable data properties");
  }
  return descriptor.value;
}

function record(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (!isRecord(value)) {
    fail(DocumentImportDagErrorCode.invalidInput, `${label} must be a non-proxy data record`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail(DocumentImportDagErrorCode.invalidInput, `${label} must have exactly its contract fields`);
  }
  for (const key of keys) property(value, key);
  return value;
}

function denseArray(value: unknown, limit: number, label: string): readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(DocumentImportDagErrorCode.invalidInput, `${label} must be a regular dense array`);
  }
  if (value.length > limit) {
    fail(DocumentImportDagErrorCode.resourceLimit, `${label} exceeds its item limit`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    fail(DocumentImportDagErrorCode.invalidInput, `${label} must not be sparse or extended`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(DocumentImportDagErrorCode.invalidInput, `${label} must contain own data entries`);
    }
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 512 || !STABLE_ID.test(value)) {
    fail(DocumentImportDagErrorCode.invalidGraph, `${label} must be a stable identifier`);
  }
  return value;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || !isRepositoryRelativePath(value)) {
    fail(DocumentImportDagErrorCode.invalidGraph, `${label} must be a canonical repository path`);
  }
  return value;
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(
      DocumentImportDagErrorCode.invalidGraph,
      `${label} must be a bounded non-negative integer`,
    );
  }
  return value;
}

function nullablePath(value: unknown, label: string): RepositoryRelativePath | null {
  return value === null ? null : pathValue(value, label);
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

function position(value: unknown, label: string): SourcePosition {
  const input = record(value, ["byteOffset", "utf16Offset", "line", "utf16Column"], label);
  return Object.freeze({
    byteOffset: integer(property(input, "byteOffset"), `${label}.byteOffset`),
    utf16Offset: integer(property(input, "utf16Offset"), `${label}.utf16Offset`),
    line: integer(property(input, "line"), `${label}.line`),
    utf16Column: integer(property(input, "utf16Column"), `${label}.utf16Column`),
  });
}

function range(value: unknown, label: string): SourceRange {
  const input = record(value, ["sourceId", "start", "end"], label);
  const sourceId = identifier(property(input, "sourceId"), `${label}.sourceId`) as SourceDocumentId;
  const start = position(property(input, "start"), `${label}.start`);
  const end = position(property(input, "end"), `${label}.end`);
  if (
    end.byteOffset < start.byteOffset ||
    end.utf16Offset < start.utf16Offset ||
    end.line < start.line ||
    (end.line === start.line && end.utf16Column < start.utf16Column)
  ) {
    fail(DocumentImportDagErrorCode.invalidGraph, `${label} must be a forward half-open range`);
  }
  return Object.freeze({ sourceId, start, end });
}

function nullableRange(value: unknown, label: string): SourceRange | null {
  return value === null ? null : range(value, label);
}

function normalizeNode(value: unknown, index: number): NormalizedNode {
  const label = `graph.nodes[${String(index)}]`;
  const input = record(
    value,
    ["byteLength", "depth", "documentId", "imports", "path", "sha256", "sourceId", "state"],
    label,
  );
  denseArray(property(input, "imports"), 4_096, `${label}.imports`);
  const state = property(input, "state");
  if (state !== "loaded" && state !== "parse-failed") {
    fail(DocumentImportDagErrorCode.invalidGraph, `${label}.state is invalid`);
  }
  const sha256 = property(input, "sha256");
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    fail(DocumentImportDagErrorCode.invalidGraph, `${label}.sha256 is invalid`);
  }
  return Object.freeze({
    byteLength: integer(property(input, "byteLength"), `${label}.byteLength`, 524_288),
    depth: integer(property(input, "depth"), `${label}.depth`, 32),
    documentId: identifier(
      property(input, "documentId"),
      `${label}.documentId`,
    ) as InstructionDocumentId,
    path: pathValue(property(input, "path"), `${label}.path`),
    sha256,
    sourceId: identifier(property(input, "sourceId"), `${label}.sourceId`) as SourceDocumentId,
    state,
  });
}

function normalizeEdge(value: unknown, index: number): NormalizedEdge {
  const label = `graph.edges[${String(index)}]`;
  const input = record(
    value,
    ["depth", "fromDocumentId", "import", "issueCode", "state", "targetDocumentId", "targetPath"],
    label,
  );
  const reference = record(
    property(input, "import"),
    [
      "id",
      "documentId",
      "nodeId",
      "kind",
      "range",
      "specifierRange",
      "rawSpecifier",
      "targetKind",
      "state",
      "uncertainty",
    ],
    `${label}.import`,
  );
  const state = property(input, "state");
  if (typeof state !== "string" || !EDGE_STATES.has(state as ImportGraphEdgeState)) {
    fail(DocumentImportDagErrorCode.invalidGraph, `${label}.state is invalid`);
  }
  const issueCode = property(input, "issueCode");
  if (
    issueCode !== null &&
    (typeof issueCode !== "string" || !ISSUE_CODES.has(issueCode as ImportGraphIssueCode))
  ) {
    fail(DocumentImportDagErrorCode.invalidGraph, `${label}.issueCode is invalid`);
  }
  const rawSpecifier = property(reference, "rawSpecifier");
  if (typeof rawSpecifier !== "string" || rawSpecifier.length > 4_096) {
    fail(DocumentImportDagErrorCode.invalidGraph, `${label}.import.rawSpecifier is invalid`);
  }
  const fromDocumentId = identifier(
    property(input, "fromDocumentId"),
    `${label}.fromDocumentId`,
  ) as InstructionDocumentId;
  if (property(reference, "documentId") !== fromDocumentId) {
    fail(DocumentImportDagErrorCode.invalidRelationship, `${label}.import has the wrong document`);
  }
  return Object.freeze({
    depth: integer(property(input, "depth"), `${label}.depth`, 33),
    fromDocumentId,
    importId: identifier(property(reference, "id"), `${label}.import.id`) as ImportReferenceId,
    issueCode: issueCode as ImportGraphIssueCode | null,
    range: range(property(reference, "specifierRange"), `${label}.import.specifierRange`),
    state: state as ImportGraphEdgeState,
    targetDocumentId: nullableIdentifier(
      property(input, "targetDocumentId"),
      `${label}.targetDocumentId`,
    ) as InstructionDocumentId | null,
    targetPath: nullablePath(property(input, "targetPath"), `${label}.targetPath`),
  });
}

function normalizeIssue(value: unknown, index: number): ImportDagIssue {
  const label = `graph.issues[${String(index)}]`;
  const input = record(value, ["code", "importId", "path", "range", "targetPath"], label);
  const code = property(input, "code");
  if (typeof code !== "string" || !ISSUE_CODES.has(code as ImportGraphIssueCode)) {
    fail(DocumentImportDagErrorCode.invalidGraph, `${label}.code is invalid`);
  }
  return Object.freeze({
    code: code as ImportGraphIssueCode,
    importId: nullableIdentifier(
      property(input, "importId"),
      `${label}.importId`,
    ) as ImportReferenceId | null,
    path: pathValue(property(input, "path"), `${label}.path`),
    range: nullableRange(property(input, "range"), `${label}.range`),
    targetPath: nullablePath(property(input, "targetPath"), `${label}.targetPath`),
  });
}

function normalizeGraph(value: unknown): NormalizedGraph {
  const input = record(
    value,
    ["contractVersion", "edges", "entryPath", "issues", "nodes", "state", "syntax", "usage"],
    "graph",
  );
  if (property(input, "contractVersion") !== "0.1.0") {
    fail(DocumentImportDagErrorCode.invalidGraph, "graph contract version is unsupported");
  }
  if (
    !["claude-code", "copilot-cli", "cursor-agent", "gemini-cli"].includes(
      property(input, "syntax") as string,
    )
  ) {
    fail(DocumentImportDagErrorCode.invalidGraph, "graph syntax is unsupported");
  }
  const entryPath = pathValue(property(input, "entryPath"), "graph.entryPath");
  if (entryPath === ".")
    fail(DocumentImportDagErrorCode.invalidGraph, "graph entry must be a file");
  const rawNodes = denseArray(
    property(input, "nodes"),
    DOCUMENT_IMPORT_DAG_LIMITS.maxDocuments,
    "graph.nodes",
  );
  const rawEdges = denseArray(
    property(input, "edges"),
    DOCUMENT_IMPORT_DAG_LIMITS.maxOccurrences - 1,
    "graph.edges",
  );
  const rawIssues = denseArray(
    property(input, "issues"),
    DOCUMENT_IMPORT_DAG_LIMITS.maxGraphIssues,
    "graph.issues",
  );
  let referenceCount = 0;
  const nodes = rawNodes.map((node, index) => {
    const inputNode = record(
      node,
      ["byteLength", "depth", "documentId", "imports", "path", "sha256", "sourceId", "state"],
      `graph.nodes[${String(index)}]`,
    );
    referenceCount += denseArray(
      property(inputNode, "imports"),
      4_096,
      `graph.nodes[${String(index)}].imports`,
    ).length;
    if (referenceCount > DOCUMENT_IMPORT_DAG_LIMITS.maxReferences) {
      fail(DocumentImportDagErrorCode.resourceLimit, "graph import references exceed the limit");
    }
    return normalizeNode(node, index);
  });
  const edges = rawEdges.map(normalizeEdge);
  const issues = rawIssues.map(normalizeIssue);
  const state = property(input, "state");
  if (state !== "complete" && state !== "partial") {
    fail(DocumentImportDagErrorCode.invalidGraph, "graph state is invalid");
  }
  if ((state === "complete") !== (issues.length === 0)) {
    fail(DocumentImportDagErrorCode.invalidGraph, "graph state and issues disagree");
  }
  const usage = record(
    property(input, "usage"),
    ["edges", "files", "issues", "totalBytes"],
    "graph.usage",
  );
  if (
    integer(property(usage, "edges"), "graph.usage.edges") !== edges.length ||
    integer(property(usage, "files"), "graph.usage.files") !== nodes.length ||
    integer(property(usage, "issues"), "graph.usage.issues") !== issues.length
  ) {
    fail(DocumentImportDagErrorCode.invalidGraph, "graph usage counts disagree");
  }
  const totalBytes = integer(property(usage, "totalBytes"), "graph.usage.totalBytes", 16_777_216);
  if (totalBytes !== nodes.reduce((sum, node) => sum + node.byteLength, 0)) {
    fail(DocumentImportDagErrorCode.invalidGraph, "graph byte usage disagrees");
  }
  return Object.freeze({
    edges: Object.freeze(edges),
    entryPath,
    issues: Object.freeze(issues),
    nodes: Object.freeze(nodes),
    state,
  });
}

function framedHash(namespace: string, fields: readonly string[]): string {
  const hash = createHash("sha256").update(namespace, "utf8");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    hash.update("\0", "utf8").update(String(bytes.byteLength), "ascii").update(":", "ascii");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function occurrenceId(fields: readonly string[]): string {
  return `occurrence:${framedHash("document-import-occurrence-v1", fields)}`;
}

/** Build a pure occurrence-preserving DAG from one C10 graph and one normalized E03 trace. */
export function buildDocumentImportDag(inputValue: BuildDocumentImportDagInput): DocumentImportDag {
  const input = record(inputValue, ["graph", "trace"], "input");
  const graph = normalizeGraph(property(input, "graph"));
  const trace = normalizeResolutionEventTrace(property(input, "trace"));
  const traceSha256 = digestResolutionEventTrace(trace);

  const documentIds = new Set<string>();
  const sourceIds = new Set<string>();
  const paths = new Set<string>();
  const documentsById = new Map<InstructionDocumentId, ImportDagDocument>();
  const contentDocuments = new Map<
    string,
    { byteLength: number; documentIds: InstructionDocumentId[]; sha256: string }
  >();

  const documents = graph.nodes.map((node) => {
    if (documentIds.has(node.documentId) || sourceIds.has(node.sourceId) || paths.has(node.path)) {
      fail(
        DocumentImportDagErrorCode.invalidRelationship,
        "graph document identities must be unique",
      );
    }
    documentIds.add(node.documentId);
    sourceIds.add(node.sourceId);
    paths.add(node.path);
    const contentId = `content:${node.sha256}`;
    const existing = contentDocuments.get(contentId);
    if (existing !== undefined && existing.byteLength !== node.byteLength) {
      fail(
        DocumentImportDagErrorCode.invalidRelationship,
        "one content digest has conflicting lengths",
      );
    }
    if (existing === undefined) {
      contentDocuments.set(contentId, {
        byteLength: node.byteLength,
        documentIds: [node.documentId],
        sha256: node.sha256,
      });
    } else {
      existing.documentIds.push(node.documentId);
    }
    const document = Object.freeze({
      byteLength: node.byteLength,
      contentId,
      depth: node.depth,
      documentId: node.documentId,
      path: node.path,
      sourceId: node.sourceId,
      state: node.state,
    });
    documentsById.set(node.documentId, document);
    return document;
  });

  const entry = documents.find((document) => document.path === graph.entryPath) ?? null;
  if (documents.length > 0 && entry === null) {
    fail(
      DocumentImportDagErrorCode.invalidRelationship,
      "loaded graph does not contain its entry path",
    );
  }

  const contents = [...contentDocuments.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([id, content]) =>
      Object.freeze({
        byteLength: content.byteLength,
        documentIds: Object.freeze(
          content.documentIds.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
        ),
        id,
        sha256: content.sha256,
      }),
    );

  const occurrences: ImportDagOccurrence[] = [];
  if (entry !== null) {
    occurrences.push(
      Object.freeze({
        contentId: entry.contentId,
        depth: 0,
        fromDocumentId: null,
        id: occurrenceId(["entry", entry.documentId, entry.path]),
        importId: null,
        issueCode: null,
        ordinal: 0,
        range: null,
        state: "entry" as const,
        targetDocumentId: entry.documentId,
        targetPath: entry.path,
      }),
    );
  }

  const occurrenceIds = new Set(occurrences.map((occurrence) => occurrence.id));
  const importIds = new Set<ImportReferenceId>();
  for (const [index, edge] of graph.edges.entries()) {
    if (importIds.has(edge.importId)) {
      fail(DocumentImportDagErrorCode.invalidRelationship, "import occurrence IDs must be unique");
    }
    importIds.add(edge.importId);
    const from = documentsById.get(edge.fromDocumentId);
    if (edge.range.sourceId !== from?.sourceId) {
      fail(
        DocumentImportDagErrorCode.invalidRelationship,
        "import edge source is not its document",
      );
    }
    const target =
      edge.targetDocumentId === null ? null : (documentsById.get(edge.targetDocumentId) ?? null);
    if (edge.targetDocumentId !== null && target === null) {
      fail(
        DocumentImportDagErrorCode.invalidRelationship,
        "import edge target document is unknown",
      );
    }
    if (target !== null && edge.targetPath !== target.path && edge.state !== "cycle") {
      fail(DocumentImportDagErrorCode.invalidRelationship, "import edge target path disagrees");
    }
    if (
      (edge.state === "loaded" || edge.state === "already-loaded" || edge.state === "cycle") &&
      target === null
    ) {
      fail(DocumentImportDagErrorCode.invalidRelationship, "loaded or cyclic edge lacks a target");
    }
    if (
      edge.state !== "loaded" &&
      edge.state !== "already-loaded" &&
      edge.state !== "cycle" &&
      target !== null
    ) {
      fail(
        DocumentImportDagErrorCode.invalidRelationship,
        "failed import edge has a target document",
      );
    }
    if (
      ((edge.state === "loaded" || edge.state === "already-loaded") && edge.issueCode !== null) ||
      (edge.state === "cycle" && edge.issueCode !== "IMPORT_GRAPH_CYCLE") ||
      (edge.state !== "loaded" && edge.state !== "already-loaded" && edge.issueCode === null)
    ) {
      fail(DocumentImportDagErrorCode.invalidRelationship, "import edge state and issue disagree");
    }
    const ordinal = occurrences.length;
    const id = occurrenceId([
      String(index),
      edge.fromDocumentId,
      edge.importId,
      edge.state,
      edge.targetDocumentId ?? "",
      edge.targetPath ?? "",
    ]);
    if (occurrenceIds.has(id)) {
      fail(DocumentImportDagErrorCode.invalidRelationship, "occurrence identities collide");
    }
    occurrenceIds.add(id);
    occurrences.push(
      Object.freeze({
        contentId: target?.contentId ?? null,
        depth: edge.depth,
        fromDocumentId: edge.fromDocumentId,
        id,
        importId: edge.importId,
        issueCode: edge.issueCode,
        ordinal,
        range: edge.range,
        state: edge.state,
        targetDocumentId: edge.targetDocumentId,
        targetPath: edge.targetPath,
      }),
    );
  }

  const result: DocumentImportDag = Object.freeze({
    recordKind: "agent-context-document-import-dag",
    contractVersion: DOCUMENT_IMPORT_DAG_CONTRACT_VERSION,
    contents: Object.freeze(contents),
    documents: Object.freeze(documents),
    entryDocumentId: entry?.documentId ?? null,
    entryPath: graph.entryPath,
    graphState: graph.state,
    issues: graph.issues,
    occurrences: Object.freeze(occurrences),
    traceEventIds: Object.freeze(trace.events.map((event) => event.id)),
    traceSha256,
  });
  ISSUED_DOCUMENT_IMPORT_DAGS.add(result);
  return result;
}

/**
 * Issue the E04 occurrence shape for one B03 document whose validated import set is empty.
 * This closes the accounting boundary for formats such as AGENTS.md without assigning them a
 * fictitious vendor import dialect. Documents that declare imports must use a genuine C10 graph.
 */
export function buildNoImportDocumentDag(
  inputValue: BuildNoImportDocumentDagInput,
): DocumentImportDag {
  const input = record(inputValue, ["documentId", "ir", "trace"], "no-import DAG input");
  const ir = property(input, "ir");
  const documentId = property(input, "documentId");
  if (!isIssuedInstructionIrSnapshot(ir) || typeof documentId !== "string")
    fail(DocumentImportDagErrorCode.invalidInput, "no-import DAG authority is invalid");
  if (ir.documents.length > DOCUMENT_IMPORT_DAG_LIMITS.maxDocuments)
    fail(DocumentImportDagErrorCode.resourceLimit, "IR document count exceeds the E04 limit");
  const document = ir.documents.find((entry) => entry.id === documentId);
  if (document === undefined)
    fail(DocumentImportDagErrorCode.invalidRelationship, "document is absent from the IR snapshot");
  if (document.importIds.length !== 0)
    fail(
      DocumentImportDagErrorCode.invalidRelationship,
      "document declares imports and requires a C10 graph",
    );
  const source = ir.sources.find((entry) => entry.id === document.sourceId);
  if (source === undefined)
    fail(
      DocumentImportDagErrorCode.invalidRelationship,
      "document source is absent from the IR snapshot",
    );
  const trace = normalizeResolutionEventTrace(property(input, "trace"));
  const traceSha256 = digestResolutionEventTrace(trace);
  const contentId = `content:${source.sha256}`;
  const occurrence = Object.freeze({
    contentId,
    depth: 0,
    fromDocumentId: null,
    id: occurrenceId(["entry", document.id, source.path]),
    importId: null,
    issueCode: null,
    ordinal: 0,
    range: null,
    state: "entry" as const,
    targetDocumentId: document.id,
    targetPath: source.path,
  });
  const result: DocumentImportDag = Object.freeze({
    contents: Object.freeze([
      Object.freeze({
        byteLength: source.byteLength,
        documentIds: Object.freeze([document.id]),
        id: contentId,
        sha256: source.sha256,
      }),
    ]),
    contractVersion: DOCUMENT_IMPORT_DAG_CONTRACT_VERSION,
    documents: Object.freeze([
      Object.freeze({
        byteLength: source.byteLength,
        contentId,
        depth: 0,
        documentId: document.id,
        path: source.path,
        sourceId: source.id,
        state:
          source.parseState.state === "complete" ? ("loaded" as const) : ("parse-failed" as const),
      }),
    ]),
    entryDocumentId: document.id,
    entryPath: source.path,
    graphState: source.parseState.state === "complete" ? "complete" : "partial",
    issues: Object.freeze([]),
    occurrences: Object.freeze([occurrence]),
    recordKind: "agent-context-document-import-dag",
    traceEventIds: Object.freeze(trace.events.map((event) => event.id)),
    traceSha256,
  });
  ISSUED_DOCUMENT_IMPORT_DAGS.add(result);
  return result;
}
