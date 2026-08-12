import { createHash } from "node:crypto";
import { types as nodeTypes, TextDecoder } from "node:util";

import {
  isRepositoryRelativePath,
  type AstNode,
  type InstructionDocument,
  type InstructionDocumentId,
  type InstructionStatement,
  type InstructionStatementId,
  type RepositoryRelativePath,
  type SourceDocument,
  type SourceDocumentId,
  type SourceParseState,
  type SourceRange,
} from "@agent-context/core";
import {
  DEFAULT_MARKDOWN_PARSER_LIMITS,
  extractMarkdownContent,
  type MarkdownParseIssue,
} from "@agent-context/markdown";

export const AGENTS_MARKDOWN_CONTRACT_VERSION = "0.1.0" as const;
export const AGENTS_MARKDOWN_FORMAT_ID = "agents-markdown" as const;
export const AGENTS_MARKDOWN_MAX_BYTES: number = DEFAULT_MARKDOWN_PARSER_LIMITS.maxUtf8Bytes;
export const AGENTS_MARKDOWN_MAX_PATH_BYTES = 16_384 as const;

export type AgentsMarkdownContentStatus = "complete" | "truncated";

export interface ParseAgentsMarkdownInput {
  readonly bytes: Uint8Array;
  readonly contentStatus: AgentsMarkdownContentStatus;
  readonly path: RepositoryRelativePath;
  /** Profile-supplied scope; the document syntax does not infer consumer activation. */
  readonly scopeRoot: RepositoryRelativePath;
}

export type AgentsMarkdownIssueCode = "invalid-utf8" | "markdown-recovery" | "truncated-input";

export interface AgentsMarkdownIssue {
  readonly code: AgentsMarkdownIssueCode;
  readonly message: string;
  readonly range: SourceRange | null;
}

export interface AgentsMarkdownParseResult {
  readonly contractVersion: typeof AGENTS_MARKDOWN_CONTRACT_VERSION;
  readonly decode: "utf8" | "utf8-lossy-replacement";
  readonly document: InstructionDocument;
  readonly formatId: typeof AGENTS_MARKDOWN_FORMAT_ID;
  readonly issues: readonly AgentsMarkdownIssue[];
  readonly nodes: readonly AstNode[];
  readonly source: SourceDocument;
  readonly statements: readonly InstructionStatement[];
}

export const AgentsMarkdownErrorCode: Readonly<{
  invalidInput: "AGENTS_MARKDOWN_INVALID_INPUT";
  resourceLimit: "AGENTS_MARKDOWN_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "AGENTS_MARKDOWN_INVALID_INPUT",
  resourceLimit: "AGENTS_MARKDOWN_RESOURCE_LIMIT",
} as const);

export type AgentsMarkdownErrorCode =
  (typeof AgentsMarkdownErrorCode)[keyof typeof AgentsMarkdownErrorCode];

export class AgentsMarkdownError extends Error {
  override readonly name = "AgentsMarkdownError" as const;
  readonly code: AgentsMarkdownErrorCode;

  constructor(code: AgentsMarkdownErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

const INPUT_KEYS = Object.freeze(["bytes", "contentStatus", "path", "scopeRoot"]);
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(code: AgentsMarkdownErrorCode, message: string): never {
  throw new AgentsMarkdownError(code, message);
}

function dataRecord(value: unknown): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail(
      AgentsMarkdownErrorCode.invalidInput,
      "AGENTS Markdown input must be a data record",
    );
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== INPUT_KEYS.length ||
    keys.some((key) => typeof key !== "string" || !INPUT_KEYS.includes(key))
  )
    return fail(AgentsMarkdownErrorCode.invalidInput, "AGENTS Markdown input must be closed");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        AgentsMarkdownErrorCode.invalidInput,
        "AGENTS Markdown input must contain enumerable data properties",
      );
  }
  return value as DataRecord;
}

function valueOf(record: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function copyBytes(value: unknown): Uint8Array {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  )
    return fail(
      AgentsMarkdownErrorCode.invalidInput,
      "AGENTS Markdown bytes must be a plain Uint8Array",
    );
  const bytes = value as Uint8Array;
  const keys = Reflect.ownKeys(bytes);
  if (keys.length !== bytes.length)
    return fail(
      AgentsMarkdownErrorCode.invalidInput,
      "AGENTS Markdown bytes must not contain extra properties",
    );
  for (let index = 0; index < bytes.length; index += 1) {
    const key = String(index);
    if (keys[index] !== key) {
      return fail(
        AgentsMarkdownErrorCode.invalidInput,
        "AGENTS Markdown bytes must have canonical indices",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(bytes, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return fail(
        AgentsMarkdownErrorCode.invalidInput,
        "AGENTS Markdown bytes must contain enumerable data elements",
      );
  }
  if (bytes.byteLength > AGENTS_MARKDOWN_MAX_BYTES)
    return fail(
      AgentsMarkdownErrorCode.resourceLimit,
      `AGENTS Markdown input exceeds ${String(AGENTS_MARKDOWN_MAX_BYTES)} bytes`,
    );
  return Uint8Array.prototype.slice.call(bytes);
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || !isRepositoryRelativePath(value))
    return fail(
      AgentsMarkdownErrorCode.invalidInput,
      `${label} must be a canonical repository path`,
    );
  if (Buffer.byteLength(value, "utf8") > AGENTS_MARKDOWN_MAX_PATH_BYTES)
    return fail(
      AgentsMarkdownErrorCode.resourceLimit,
      `${label} exceeds ${String(AGENTS_MARKDOWN_MAX_PATH_BYTES)} bytes`,
    );
  return value;
}

function containsPath(scopeRoot: string, path: string): boolean {
  return scopeRoot === "." || path === scopeRoot || path.startsWith(`${scopeRoot}/`);
}

function lineEnding(text: string): SourceDocument["lineEnding"] {
  let cr = 0;
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) {
        crlf += 1;
        index += 1;
      } else cr += 1;
    } else if (text.charCodeAt(index) === 0x0a) lf += 1;
  }
  const kinds = Number(cr > 0) + Number(crlf > 0) + Number(lf > 0);
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  return crlf > 0 ? "crlf" : cr > 0 ? "cr" : "lf";
}

function invalidUtf8(bytes: Uint8Array): boolean {
  try {
    UTF8_FATAL_DECODER.decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function sourceState(
  markdownState: SourceParseState,
  malformedUtf8: boolean,
  contentStatus: AgentsMarkdownContentStatus,
): SourceParseState {
  if (malformedUtf8)
    return Object.freeze({
      state: "malformed",
      reason: "AGENTS Markdown contains malformed UTF-8 and was decoded with replacement",
    });
  if (contentStatus === "truncated")
    return Object.freeze({
      state: "partial",
      reason:
        markdownState.state === "complete"
          ? "AGENTS Markdown is a profile-bounded source prefix"
          : `AGENTS Markdown is a profile-bounded source prefix; ${markdownState.reason}`,
    });
  return markdownState;
}

function rootRange(nodes: readonly AstNode[], sourceId: SourceDocumentId): SourceRange | null {
  return nodes.find((node) => node.kind === "root" && node.sourceId === sourceId)?.range ?? null;
}

function markdownIssue(issue: MarkdownParseIssue): AgentsMarkdownIssue {
  return Object.freeze({
    code: "markdown-recovery",
    message: issue.message,
    range: issue.range,
  });
}

/**
 * Parses exactly the caller-authorized bytes as generic AGENTS Markdown. The adapter performs no
 * discovery, import resolution, profile activation, filesystem access, execution, or networking.
 */
export function parseAgentsMarkdown(
  inputValue: ParseAgentsMarkdownInput,
): AgentsMarkdownParseResult {
  const input = dataRecord(inputValue);
  const bytes = copyBytes(valueOf(input, "bytes"));
  const contentStatus = valueOf(input, "contentStatus");
  if (contentStatus !== "complete" && contentStatus !== "truncated")
    return fail(
      AgentsMarkdownErrorCode.invalidInput,
      "AGENTS Markdown contentStatus must be complete or truncated",
    );
  const path = pathValue(valueOf(input, "path"), "AGENTS Markdown path");
  const scopeRoot = pathValue(valueOf(input, "scopeRoot"), "AGENTS Markdown scopeRoot");
  if (!containsPath(scopeRoot, path))
    return fail(
      AgentsMarkdownErrorCode.invalidInput,
      "AGENTS Markdown scopeRoot must contain its source path",
    );

  const digest = createHash("sha256").update(bytes).digest("hex");
  const identity = createHash("sha256")
    .update(path, "utf8")
    .update("\0", "utf8")
    .update(digest, "ascii")
    .digest("hex");
  const sourceId = `source:agents:${identity}` as SourceDocumentId;
  const documentId = `document:agents:${identity}` as InstructionDocumentId;
  const text = Buffer.from(bytes).toString("utf8");
  const malformedUtf8 = invalidUtf8(bytes);
  const extracted = extractMarkdownContent({ sourceId, text });
  const parseState = sourceState(extracted.parseState, malformedUtf8, contentStatus);
  const source: SourceDocument = Object.freeze({
    bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8" : "none",
    byteLength: bytes.byteLength,
    encoding: "utf-8",
    id: sourceId,
    lineEnding: lineEnding(text),
    parseState,
    path,
    rootNodeId: extracted.rootNodeId,
    sha256: digest,
    text,
    utf16Length: text.length,
  });
  const statements = extracted.statements.map((statement, index): InstructionStatement =>
    Object.freeze({
      classification: Object.freeze({ state: "unclassified" as const }),
      documentId,
      id: `statement:agents:${identity}:${index.toString(36)}` as InstructionStatementId,
      nodeIds: Object.freeze([statement.nodeId]),
      range: statement.range,
      text: statement.original,
    }),
  );
  const document: InstructionDocument = Object.freeze({
    activationRuleIds: Object.freeze([]),
    formatId: AGENTS_MARKDOWN_FORMAT_ID,
    id: documentId,
    importIds: Object.freeze([]),
    rootNodeId: extracted.rootNodeId,
    scopeRoot,
    sourceId,
    statementIds: Object.freeze(statements.map((statement) => statement.id)),
  });
  const issues: AgentsMarkdownIssue[] = extracted.issues.map(markdownIssue);
  if (malformedUtf8)
    issues.unshift(
      Object.freeze({
        code: "invalid-utf8",
        message: "AGENTS Markdown contains malformed UTF-8; replacement decoding was used",
        range: rootRange(extracted.nodes, sourceId),
      }),
    );
  if (contentStatus === "truncated")
    issues.push(
      Object.freeze({
        code: "truncated-input",
        message: "AGENTS Markdown parsing is limited to the model-visible byte prefix",
        range: rootRange(extracted.nodes, sourceId),
      }),
    );
  return Object.freeze({
    contractVersion: AGENTS_MARKDOWN_CONTRACT_VERSION,
    decode: malformedUtf8 ? "utf8-lossy-replacement" : "utf8",
    document,
    formatId: AGENTS_MARKDOWN_FORMAT_ID,
    issues: Object.freeze(issues),
    nodes: extracted.nodes,
    source,
    statements: Object.freeze(statements),
  });
}
