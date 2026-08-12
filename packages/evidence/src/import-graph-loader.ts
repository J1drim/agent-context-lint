import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalizeRepositoryRelativePath, RepositoryPathError } from "@agent-context/core";
import type {
  ImportReference,
  ImportReferenceId,
  InstructionDocumentId,
  RepositoryRelativePath,
  SourceDocumentId,
  SourceRange,
} from "@agent-context/core";
import { lexImportReferences, type ImportDialect } from "@agent-context/syntax";

import type { ReadOnlyRepository, ReadOnlyRepositoryIdentity } from "./read-only-filesystem.js";

export const IMPORT_GRAPH_CONTRACT_VERSION = "0.1.0" as const;

export interface ImportGraphLimits {
  readonly maxDepth?: number;
  readonly maxEdges?: number;
  readonly maxFanOut?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxIssues?: number;
}

export const DEFAULT_IMPORT_GRAPH_LIMITS: Readonly<Required<ImportGraphLimits>> = Object.freeze({
  maxDepth: 32,
  maxEdges: 65_536,
  maxFanOut: 256,
  maxFiles: 4_096,
  maxFileBytes: 524_288,
  maxTotalBytes: 16_777_216,
  maxIssues: 4_096,
});

export const HARD_IMPORT_GRAPH_LIMITS: Readonly<Required<ImportGraphLimits>> =
  DEFAULT_IMPORT_GRAPH_LIMITS;

export interface LoadImportGraphInput {
  readonly repository: ReadOnlyRepository;
  readonly entryPath: RepositoryRelativePath;
  readonly syntax: ImportDialect;
}

export type ImportGraphIssueCode =
  | "IMPORT_GRAPH_AMBIGUOUS_REFERENCE"
  | "IMPORT_GRAPH_CYCLE"
  | "IMPORT_GRAPH_DEPTH_LIMIT"
  | "IMPORT_GRAPH_EDGE_LIMIT"
  | "IMPORT_GRAPH_FAN_OUT_LIMIT"
  | "IMPORT_GRAPH_FILE_LIMIT"
  | "IMPORT_GRAPH_FILE_TOO_LARGE"
  | "IMPORT_GRAPH_INVALID_UTF8"
  | "IMPORT_GRAPH_LEX_FAILED"
  | "IMPORT_GRAPH_READ_FAILED"
  | "IMPORT_GRAPH_ROOT_BOUNDARY"
  | "IMPORT_GRAPH_TARGET_REJECTED"
  | "IMPORT_GRAPH_TOTAL_BYTES_LIMIT";

export interface ImportGraphIssue {
  readonly code: ImportGraphIssueCode;
  readonly importId: ImportReferenceId | null;
  readonly path: RepositoryRelativePath;
  readonly range: SourceRange | null;
  readonly targetPath: RepositoryRelativePath | null;
}

export type ImportGraphEdgeState =
  | "loaded"
  | "already-loaded"
  | "cycle"
  | "ambiguous"
  | "rejected"
  | "unavailable"
  | "limit-exceeded";

export interface ImportGraphEdge {
  readonly depth: number;
  readonly fromDocumentId: InstructionDocumentId;
  readonly import: ImportReference;
  readonly issueCode: ImportGraphIssueCode | null;
  readonly state: ImportGraphEdgeState;
  readonly targetDocumentId: InstructionDocumentId | null;
  readonly targetPath: RepositoryRelativePath | null;
}

export interface ImportGraphNode {
  readonly byteLength: number;
  readonly depth: number;
  readonly documentId: InstructionDocumentId;
  readonly imports: readonly ImportReference[];
  readonly path: RepositoryRelativePath;
  readonly sha256: string;
  readonly sourceId: SourceDocumentId;
  readonly state: "loaded" | "parse-failed";
}

export interface ImportGraphUsage {
  readonly edges: number;
  readonly files: number;
  readonly issues: number;
  readonly totalBytes: number;
}

export interface ImportGraphResult {
  readonly contractVersion: typeof IMPORT_GRAPH_CONTRACT_VERSION;
  readonly edges: readonly ImportGraphEdge[];
  readonly entryPath: RepositoryRelativePath;
  readonly issues: readonly ImportGraphIssue[];
  readonly nodes: readonly ImportGraphNode[];
  readonly state: "complete" | "partial";
  readonly syntax: ImportDialect;
  readonly usage: Readonly<ImportGraphUsage>;
}

export type ImportGraphLoaderErrorCode =
  "IMPORT_GRAPH_INVALID_INPUT" | "IMPORT_GRAPH_INVALID_LIMIT";

export class ImportGraphLoaderError extends Error {
  readonly code: ImportGraphLoaderErrorCode;
  readonly limitName: keyof Required<ImportGraphLimits> | null;

  constructor(
    code: ImportGraphLoaderErrorCode,
    message: string,
    limitName: keyof Required<ImportGraphLimits> | null = null,
  ) {
    super(message);
    this.name = "ImportGraphLoaderError";
    this.code = code;
    this.limitName = limitName;
    Object.freeze(this);
  }
}

interface ValidatedInput {
  readonly repository: ReadOnlyRepository;
  readonly readFile: ReadOnlyRepository["readFile"];
  readonly entryPath: RepositoryRelativePath;
  readonly syntax: ImportDialect;
}

interface MutableState {
  readonly active: Map<RepositoryRelativePath, InstructionDocumentId>;
  readonly activeIdentities: Map<string, InstructionDocumentId>;
  readonly completed: Map<RepositoryRelativePath, InstructionDocumentId>;
  readonly edges: ImportGraphEdge[];
  readonly issues: ImportGraphIssue[];
  readonly limits: Readonly<Required<ImportGraphLimits>>;
  readonly nodes: ImportGraphNode[];
  readonly readFile: (path: RepositoryRelativePath) => ReturnType<ReadOnlyRepository["readFile"]>;
  readonly syntax: ImportDialect;
  edgeSlots: number;
  halted: boolean;
  totalBytes: number;
}

type VisitResult =
  | { readonly documentId: InstructionDocumentId; readonly failureCode: null }
  | {
      readonly documentId: InstructionDocumentId | null;
      readonly failureCode: ImportGraphIssueCode;
    };

const INPUT_KEYS = new Set(["repository", "entryPath", "syntax"]);
const LIMIT_KEYS = new Set<keyof Required<ImportGraphLimits>>([
  "maxDepth",
  "maxEdges",
  "maxFanOut",
  "maxFiles",
  "maxFileBytes",
  "maxTotalBytes",
  "maxIssues",
]);
const IMPORT_DIALECT_SET = new Set<ImportDialect>([
  "claude-code",
  "copilot-cli",
  "cursor-agent",
  "gemini-cli",
]);

function failInput(message: string): never {
  throw new ImportGraphLoaderError("IMPORT_GRAPH_INVALID_INPUT", message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    failInput("input must contain documented own data properties");
  }
  return descriptor.value;
}

function validateClosedRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): Record<string, unknown> {
  if (!isPlainRecord(value)) failInput("input must be a non-proxy plain record");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > allowed.size ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    failInput("input contains an unknown property");
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) failInput("input is missing a property");
  }
  return value;
}

function repositoryMethod(repository: object, name: string): unknown {
  let current: object | null = repository;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    if (nodeTypes.isProxy(current)) failInput("repository must not contain proxy prototypes");
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) failInput("repository methods must be data properties");
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function validateRepository(value: unknown): ReadOnlyRepository {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    failInput("repository must be a non-proxy object");
  }
  for (const name of ["readFile", "usage"] as const) {
    if (typeof repositoryMethod(value, name) !== "function") {
      failInput("repository does not implement the read-only contract");
    }
  }
  return value as ReadOnlyRepository;
}

function validateInput(value: LoadImportGraphInput): ValidatedInput {
  const record = validateClosedRecord(value, INPUT_KEYS, ["repository", "entryPath", "syntax"]);
  const repository = validateRepository(ownData(record, "repository"));
  const readFile = repositoryMethod(repository, "readFile") as ReadOnlyRepository["readFile"];
  const entryPath = ownData(record, "entryPath");
  const syntax = ownData(record, "syntax");
  if (typeof entryPath !== "string") failInput("entryPath must be a canonical repository path");
  try {
    if (canonicalizeRepositoryRelativePath(entryPath) !== entryPath || entryPath === ".") {
      failInput("entryPath must name a canonical repository file");
    }
  } catch (error: unknown) {
    if (error instanceof ImportGraphLoaderError) throw error;
    if (error instanceof RepositoryPathError)
      failInput("entryPath must be a canonical repository file");
    throw error;
  }
  if (typeof syntax !== "string" || !IMPORT_DIALECT_SET.has(syntax as ImportDialect)) {
    failInput("syntax is unsupported");
  }
  return {
    repository,
    readFile,
    entryPath: entryPath as RepositoryRelativePath,
    syntax: syntax as ImportDialect,
  };
}

function validateLimits(
  value: ImportGraphLimits | undefined,
): Readonly<Required<ImportGraphLimits>> {
  if (value === undefined) return DEFAULT_IMPORT_GRAPH_LIMITS;
  if (!isPlainRecord(value)) {
    throw new ImportGraphLoaderError(
      "IMPORT_GRAPH_INVALID_LIMIT",
      "import graph limits must be a non-proxy plain record",
    );
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > LIMIT_KEYS.size ||
    keys.some(
      (key) => typeof key !== "string" || !LIMIT_KEYS.has(key as keyof Required<ImportGraphLimits>),
    )
  ) {
    throw new ImportGraphLoaderError(
      "IMPORT_GRAPH_INVALID_LIMIT",
      "import graph limits contain an unknown property",
    );
  }
  const record = value;
  const result = { ...DEFAULT_IMPORT_GRAPH_LIMITS };
  for (const name of LIMIT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ImportGraphLoaderError(
        "IMPORT_GRAPH_INVALID_LIMIT",
        "import graph limits must be own data properties",
        name,
      );
    }
    const candidate = descriptor.value as unknown;
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < (name === "maxDepth" ? 0 : 1) ||
      candidate > HARD_IMPORT_GRAPH_LIMITS[name]
    ) {
      throw new ImportGraphLoaderError(
        "IMPORT_GRAPH_INVALID_LIMIT",
        "import graph limit is outside its supported range",
        name,
      );
    }
    result[name] = candidate;
  }
  return Object.freeze(result);
}

function stableIds(
  pathValue: RepositoryRelativePath,
  syntax: ImportDialect,
  bytes: Uint8Array,
): {
  readonly documentId: InstructionDocumentId;
  readonly sha256: string;
  readonly sourceId: SourceDocumentId;
} {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = createHash("sha256")
    .update(pathValue, "utf8")
    .update("\0", "utf8")
    .update(syntax, "utf8")
    .update("\0", "utf8")
    .update(sha256, "ascii")
    .digest("hex");
  return {
    documentId: `document:${identity}` as InstructionDocumentId,
    sha256,
    sourceId: `source:${identity}` as SourceDocumentId,
  };
}

function resolveTarget(
  fromPath: RepositoryRelativePath,
  specifier: string,
): { readonly path: RepositoryRelativePath | null; readonly escaped: boolean } {
  if (specifier.length === 0 || specifier.includes("\\") || specifier.startsWith("/")) {
    return { path: null, escaped: false };
  }
  const base = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const segments = base === "" ? [] : base.split("/");
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return { path: null, escaped: true };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return { path: null, escaped: false };
  try {
    return { path: canonicalizeRepositoryRelativePath(segments.join("/")), escaped: false };
  } catch (error: unknown) {
    if (error instanceof RepositoryPathError) return { path: null, escaped: false };
    throw error;
  }
}

function identityKey(identity: ReadOnlyRepositoryIdentity): string {
  return `${String(identity.device.length)}:${identity.device}${identity.inode}`;
}

function addIssue(
  state: MutableState,
  code: ImportGraphIssueCode,
  pathValue: RepositoryRelativePath,
  reference: ImportReference | null,
  targetPath: RepositoryRelativePath | null,
): void {
  if (state.issues.length >= state.limits.maxIssues) return;
  state.issues.push(
    Object.freeze({
      code,
      importId: reference?.id ?? null,
      path: pathValue,
      range: reference?.specifierRange ?? null,
      targetPath,
    }),
  );
}

function addEdge(
  state: MutableState,
  fromDocumentId: InstructionDocumentId,
  reference: ImportReference,
  depth: number,
  edgeState: ImportGraphEdgeState,
  targetPath: RepositoryRelativePath | null,
  targetDocumentId: InstructionDocumentId | null,
  issueCode: ImportGraphIssueCode | null,
  position?: number,
): void {
  const edge = Object.freeze({
    depth,
    fromDocumentId,
    import: reference,
    issueCode,
    state: edgeState,
    targetDocumentId,
    targetPath,
  });
  if (position === undefined) state.edges.push(edge);
  else state.edges.splice(position, 0, edge);
}

async function visit(
  state: MutableState,
  pathValue: RepositoryRelativePath,
  depth: number,
  parent: {
    readonly documentId: InstructionDocumentId;
    readonly path: RepositoryRelativePath;
    readonly reference: ImportReference;
  } | null,
): Promise<VisitResult> {
  let file;
  try {
    file = await state.readFile(pathValue);
  } catch {
    addIssue(
      state,
      "IMPORT_GRAPH_READ_FAILED",
      parent?.path ?? pathValue,
      parent?.reference ?? null,
      pathValue,
    );
    return { documentId: null, failureCode: "IMPORT_GRAPH_READ_FAILED" };
  }
  const activeIdentity = state.activeIdentities.get(identityKey(file.identity));
  if (activeIdentity !== undefined) {
    addIssue(
      state,
      "IMPORT_GRAPH_CYCLE",
      parent?.path ?? pathValue,
      parent?.reference ?? null,
      pathValue,
    );
    return { documentId: activeIdentity, failureCode: "IMPORT_GRAPH_CYCLE" };
  }
  const bytes = file.bytes();
  if (bytes.byteLength > state.limits.maxFileBytes) {
    addIssue(
      state,
      "IMPORT_GRAPH_FILE_TOO_LARGE",
      parent?.path ?? pathValue,
      parent?.reference ?? null,
      pathValue,
    );
    return { documentId: null, failureCode: "IMPORT_GRAPH_FILE_TOO_LARGE" };
  }
  if (state.totalBytes + bytes.byteLength > state.limits.maxTotalBytes) {
    addIssue(
      state,
      "IMPORT_GRAPH_TOTAL_BYTES_LIMIT",
      parent?.path ?? pathValue,
      parent?.reference ?? null,
      pathValue,
    );
    return { documentId: null, failureCode: "IMPORT_GRAPH_TOTAL_BYTES_LIMIT" };
  }
  state.totalBytes += bytes.byteLength;
  const ids = stableIds(pathValue, state.syntax, bytes);

  let text: string;
  try {
    // WHATWG's `ignoreBOM: true` means the BOM is included in output rather than consumed.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    state.nodes.push(
      Object.freeze({
        byteLength: bytes.byteLength,
        depth,
        documentId: ids.documentId,
        imports: Object.freeze([]),
        path: pathValue,
        sha256: ids.sha256,
        sourceId: ids.sourceId,
        state: "parse-failed" as const,
      }),
    );
    addIssue(
      state,
      "IMPORT_GRAPH_INVALID_UTF8",
      parent?.path ?? pathValue,
      parent?.reference ?? null,
      pathValue,
    );
    state.completed.set(pathValue, ids.documentId);
    return { documentId: ids.documentId, failureCode: null };
  }

  let imports: readonly ImportReference[];
  try {
    imports = lexImportReferences({
      documentId: ids.documentId,
      sourceId: ids.sourceId,
      syntax: state.syntax,
      text,
    }).imports;
  } catch {
    const issueCode: ImportGraphIssueCode = "IMPORT_GRAPH_LEX_FAILED";
    state.nodes.push(
      Object.freeze({
        byteLength: bytes.byteLength,
        depth,
        documentId: ids.documentId,
        imports: Object.freeze([]),
        path: pathValue,
        sha256: ids.sha256,
        sourceId: ids.sourceId,
        state: "parse-failed" as const,
      }),
    );
    addIssue(state, issueCode, parent?.path ?? pathValue, parent?.reference ?? null, pathValue);
    state.completed.set(pathValue, ids.documentId);
    return { documentId: ids.documentId, failureCode: null };
  }

  state.nodes.push(
    Object.freeze({
      byteLength: bytes.byteLength,
      depth,
      documentId: ids.documentId,
      imports,
      path: pathValue,
      sha256: ids.sha256,
      sourceId: ids.sourceId,
      state: "loaded" as const,
    }),
  );
  state.active.set(pathValue, ids.documentId);
  state.activeIdentities.set(identityKey(file.identity), ids.documentId);

  if (imports.length > state.limits.maxFanOut) {
    for (const firstOmitted of imports.slice(state.limits.maxFanOut, state.limits.maxFanOut + 1)) {
      addIssue(state, "IMPORT_GRAPH_FAN_OUT_LIMIT", pathValue, firstOmitted, null);
    }
  }

  for (const [referenceIndex, reference] of imports.entries()) {
    if (state.halted) break;
    if (state.edgeSlots >= state.limits.maxEdges) {
      addIssue(state, "IMPORT_GRAPH_EDGE_LIMIT", pathValue, reference, null);
      state.halted = true;
      break;
    }
    state.edgeSlots += 1;
    if (referenceIndex >= state.limits.maxFanOut) {
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        "limit-exceeded",
        null,
        null,
        "IMPORT_GRAPH_FAN_OUT_LIMIT",
      );
      continue;
    }
    if (reference.state !== "recognized") {
      addIssue(state, "IMPORT_GRAPH_AMBIGUOUS_REFERENCE", pathValue, reference, null);
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        "ambiguous",
        null,
        null,
        "IMPORT_GRAPH_AMBIGUOUS_REFERENCE",
      );
      continue;
    }
    if (reference.targetKind !== "repository-path-candidate") {
      addIssue(state, "IMPORT_GRAPH_TARGET_REJECTED", pathValue, reference, null);
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        "rejected",
        null,
        null,
        "IMPORT_GRAPH_TARGET_REJECTED",
      );
      continue;
    }
    const resolution = resolveTarget(pathValue, reference.rawSpecifier);
    if (resolution.path === null) {
      const code: ImportGraphIssueCode = resolution.escaped
        ? "IMPORT_GRAPH_ROOT_BOUNDARY"
        : "IMPORT_GRAPH_TARGET_REJECTED";
      addIssue(state, code, pathValue, reference, null);
      addEdge(state, ids.documentId, reference, depth + 1, "rejected", null, null, code);
      continue;
    }
    const targetPath = resolution.path;
    const activeDocument = state.active.get(targetPath);
    if (activeDocument !== undefined) {
      addIssue(state, "IMPORT_GRAPH_CYCLE", pathValue, reference, targetPath);
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        "cycle",
        targetPath,
        activeDocument,
        "IMPORT_GRAPH_CYCLE",
      );
      continue;
    }
    const completedDocument = state.completed.get(targetPath);
    if (completedDocument !== undefined) {
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        "already-loaded",
        targetPath,
        completedDocument,
        null,
      );
      continue;
    }
    if (depth >= state.limits.maxDepth) {
      addIssue(state, "IMPORT_GRAPH_DEPTH_LIMIT", pathValue, reference, targetPath);
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        "limit-exceeded",
        targetPath,
        null,
        "IMPORT_GRAPH_DEPTH_LIMIT",
      );
      continue;
    }
    if (state.nodes.length >= state.limits.maxFiles) {
      addIssue(state, "IMPORT_GRAPH_FILE_LIMIT", pathValue, reference, targetPath);
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        "limit-exceeded",
        targetPath,
        null,
        "IMPORT_GRAPH_FILE_LIMIT",
      );
      continue;
    }
    const edgePosition = state.edges.length;
    const child = await visit(state, targetPath, depth + 1, {
      documentId: ids.documentId,
      path: pathValue,
      reference,
    });
    if (child.failureCode === null) {
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        "loaded",
        targetPath,
        child.documentId,
        null,
        edgePosition,
      );
    } else if (child.failureCode === "IMPORT_GRAPH_CYCLE") {
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        "cycle",
        targetPath,
        child.documentId,
        child.failureCode,
        edgePosition,
      );
    } else {
      const issueCode = child.failureCode;
      addEdge(
        state,
        ids.documentId,
        reference,
        depth + 1,
        issueCode.includes("LIMIT") || issueCode === "IMPORT_GRAPH_FILE_TOO_LARGE"
          ? "limit-exceeded"
          : "unavailable",
        targetPath,
        null,
        issueCode,
        edgePosition,
      );
    }
  }

  state.active.delete(pathValue);
  state.activeIdentities.delete(identityKey(file.identity));
  state.completed.set(pathValue, ids.documentId);
  return { documentId: ids.documentId, failureCode: null };
}

/**
 * Load one import graph through C02's bounded, root-jailed read-only repository facade.
 * Repository reads are sequential; no URL, subprocess, shell, VCS, or repository code is invoked.
 */
export async function loadImportGraph(
  inputValue: LoadImportGraphInput,
  limitsValue?: ImportGraphLimits,
): Promise<ImportGraphResult> {
  const input = validateInput(inputValue);
  const limits = validateLimits(limitsValue);
  const state: MutableState = {
    active: new Map(),
    activeIdentities: new Map(),
    completed: new Map(),
    edges: [],
    issues: [],
    limits,
    nodes: [],
    readFile: (pathValue) => Reflect.apply(input.readFile, input.repository, [pathValue]),
    syntax: input.syntax,
    edgeSlots: 0,
    halted: false,
    totalBytes: 0,
  };
  await visit(state, input.entryPath, 0, null);
  return Object.freeze({
    contractVersion: IMPORT_GRAPH_CONTRACT_VERSION,
    edges: Object.freeze(state.edges),
    entryPath: input.entryPath,
    issues: Object.freeze(state.issues),
    nodes: Object.freeze(state.nodes),
    state: state.issues.length === 0 ? "complete" : "partial",
    syntax: input.syntax,
    usage: Object.freeze({
      edges: state.edges.length,
      files: state.nodes.length,
      issues: state.issues.length,
      totalBytes: state.totalBytes,
    }),
  });
}
