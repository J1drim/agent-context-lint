import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { fromMarkdown } from "mdast-util-from-markdown";
import type { CompileContext, Extension, Token } from "mdast-util-from-markdown";

import type {
  AstNode,
  AstNodeId,
  SourceDocumentId,
  SourceParseState,
  SourcePosition,
  SourceRange,
} from "@agent-context/core";

/** Stable package identifier for diagnostics and composition metadata. */
export const packageId = "@agent-context/markdown" as const;

export const MARKDOWN_SYNTAX = "commonmark-0.31.2" as const;

export const DEFAULT_MARKDOWN_PARSER_LIMITS: Readonly<Required<MarkdownParserOptions>> =
  Object.freeze({
    maxDepth: 128,
    maxDelimiterRun: 4096,
    maxIssues: 64,
    maxNodes: 50_000,
    maxUtf16CodeUnits: 512 * 1024,
    maxUtf8Bytes: 512 * 1024,
  });

export const DEFAULT_MARKDOWN_EXTRACTION_LIMITS: Readonly<Required<MarkdownExtractionLimits>> =
  Object.freeze({
    maxExtractedUtf16CodeUnits: 4 * 1024 * 1024,
    maxExtractedUtf8Bytes: 16 * 1024 * 1024,
  });

const ABSOLUTE_MARKDOWN_PARSER_LIMITS = Object.freeze({
  ...DEFAULT_MARKDOWN_PARSER_LIMITS,
});
const ABSOLUTE_MARKDOWN_EXTRACTION_LIMITS = Object.freeze({
  ...DEFAULT_MARKDOWN_EXTRACTION_LIMITS,
});

const STABLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/;
const MAX_SOURCE_ID_LENGTH = 512;

export type MarkdownParserErrorCode =
  | "MARKDOWN_EXTRACTION_RESOURCE_LIMIT"
  | "MARKDOWN_INVALID_INPUT"
  | "MARKDOWN_INVALID_LIMIT"
  | "MARKDOWN_MALFORMED_UNICODE"
  | "MARKDOWN_PARSE_FAILED"
  | "MARKDOWN_RESOURCE_LIMIT";

export type MarkdownParseIssueCode = "unclosed-fence" | "unclosed-html-comment";

export interface MarkdownParseInput {
  readonly sourceId: SourceDocumentId;
  /** Exact decoded UTF-8 source. No newline, BOM, tab, or Unicode normalization is applied. */
  readonly text: string;
}

export interface MarkdownParserOptions {
  readonly maxDepth?: number;
  /** Maximum run of one ASCII Markdown punctuation delimiter before parsing. */
  readonly maxDelimiterRun?: number;
  readonly maxIssues?: number;
  readonly maxNodes?: number;
  readonly maxUtf16CodeUnits?: number;
  readonly maxUtf8Bytes?: number;
}

export interface MarkdownExtractionLimits {
  /** Cumulative UTF-16 units copied into every extracted `original` slice. */
  readonly maxExtractedUtf16CodeUnits?: number;
  /** Cumulative source bytes addressed by every extracted `original` slice. */
  readonly maxExtractedUtf8Bytes?: number;
}

export type MarkdownExtractionOptions = MarkdownParserOptions & MarkdownExtractionLimits;

export type MarkdownLimitName =
  keyof Required<MarkdownExtractionLimits> | keyof Required<MarkdownParserOptions>;

export interface MarkdownParseIssue {
  readonly code: MarkdownParseIssueCode;
  readonly message: string;
  readonly range: SourceRange;
}

export interface MarkdownParseResult {
  readonly syntax: typeof MARKDOWN_SYNTAX;
  readonly rootNodeId: AstNodeId;
  /** Deterministic pre-order. Every child ID resolves within this array. */
  readonly nodes: readonly AstNode[];
  readonly issues: readonly MarkdownParseIssue[];
  readonly parseState: SourceParseState;
}

export class MarkdownParserError extends Error {
  public readonly code: MarkdownParserErrorCode;
  public readonly limitName: MarkdownLimitName | null;

  public constructor(
    code: MarkdownParserErrorCode,
    message: string,
    limitName: MarkdownLimitName | null = null,
  ) {
    super(message);
    this.name = "MarkdownParserError";
    this.code = code;
    this.limitName = limitName;
  }
}

type ParserLimits = Readonly<Required<MarkdownParserOptions>>;
type ExtractionLimits = Readonly<Required<MarkdownExtractionLimits>>;

interface ValidatedExtractionOptions {
  readonly extractionLimits: ExtractionLimits;
  readonly parserOptions: ParserLimits;
}

interface MdastPosition {
  readonly start?: { readonly offset?: number };
  readonly end?: { readonly offset?: number };
}

interface MdastNode {
  readonly type?: unknown;
  readonly position?: MdastPosition;
  readonly children?: unknown;
  readonly depth?: unknown;
  readonly ordered?: unknown;
  readonly start?: unknown;
  readonly lang?: unknown;
  readonly meta?: unknown;
  readonly url?: unknown;
  readonly title?: unknown;
  readonly identifier?: unknown;
  readonly label?: unknown;
  readonly referenceType?: unknown;
}

interface IndexedNode {
  readonly node: MdastNode;
  readonly depth: number;
  readonly start: number;
  readonly end: number;
}

export interface MarkdownExtractedSlice {
  readonly nodeId: AstNodeId;
  readonly range: SourceRange;
  /** Exact, unnormalized source covered by `range`. */
  readonly original: string;
}

export interface MarkdownHeadingExtraction extends MarkdownExtractedSlice {
  readonly kind: "heading";
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface MarkdownStatementExtraction extends MarkdownExtractedSlice {
  readonly kind: "paragraph" | "list-item";
}

export interface MarkdownCodeBlockExtraction extends MarkdownExtractedSlice {
  readonly kind: "code-block";
  readonly language: string | null;
  readonly metadata: string | null;
}

export interface MarkdownLinkExtraction extends MarkdownExtractedSlice {
  readonly kind: "link";
  readonly destination: string;
  readonly title: string | null;
}

export interface MarkdownReferenceExtraction extends MarkdownExtractedSlice {
  readonly kind: "reference";
  readonly role: "definition" | "use";
  readonly identifier: string;
  readonly label: string | null;
  readonly referenceType: "collapsed" | "full" | "shortcut" | null;
  /** Present only for a definition. C08 does not resolve uses to definitions. */
  readonly destination: string | null;
  readonly title: string | null;
}

export interface MarkdownExtractionResult {
  readonly syntax: typeof MARKDOWN_SYNTAX;
  readonly rootNodeId: AstNodeId;
  readonly nodes: readonly AstNode[];
  readonly issues: readonly MarkdownParseIssue[];
  readonly parseState: SourceParseState;
  readonly headings: readonly MarkdownHeadingExtraction[];
  readonly statements: readonly MarkdownStatementExtraction[];
  readonly codeBlocks: readonly MarkdownCodeBlockExtraction[];
  readonly links: readonly MarkdownLinkExtraction[];
  readonly references: readonly MarkdownReferenceExtraction[];
}

interface PositionIndex {
  readonly byteOffsets: Float64Array;
  readonly lineStarts: readonly number[];
}

interface FenceTracker {
  readonly openingStates: Map<number, boolean>;
}

function invalidInput(message: string): never {
  throw new MarkdownParserError("MARKDOWN_INVALID_INPUT", message);
}

function ownDataRecord(
  value: unknown,
  name: string,
  allowedKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return invalidInput(`${name} must be a non-proxy object`);
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalidInput(`${name} properties could not be inspected safely`);
  }

  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return invalidInput(`${name} symbol keys are not supported`);
    if (!allowedKeys.has(key)) return invalidInput(`${name}.${key} is not part of the contract`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalidInput(`${name}.${key} must be an own data property`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function validateInput(value: unknown): MarkdownParseInput {
  const record = ownDataRecord(value, "input", new Set(["sourceId", "text"]));
  const sourceId = record["sourceId"];
  const text = record["text"];
  if (
    typeof sourceId !== "string" ||
    sourceId.length === 0 ||
    sourceId.length > MAX_SOURCE_ID_LENGTH ||
    !STABLE_IDENTIFIER_PATTERN.test(sourceId)
  ) {
    return invalidInput("input.sourceId must be a bounded B03 stable identifier");
  }
  if (typeof text !== "string") return invalidInput("input.text must be a string");
  return { sourceId: sourceId as SourceDocumentId, text };
}

function validateLimit(value: unknown, name: MarkdownLimitName, absoluteMaximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > absoluteMaximum
  ) {
    throw new MarkdownParserError(
      "MARKDOWN_INVALID_LIMIT",
      `${name} must be a positive safe integer no greater than ${String(absoluteMaximum)}`,
      name,
    );
  }
  return value as number;
}

function validateOptions(value: unknown): ParserLimits {
  if (value === undefined) return DEFAULT_MARKDOWN_PARSER_LIMITS;
  const keys = new Set(Object.keys(DEFAULT_MARKDOWN_PARSER_LIMITS));
  const record = ownDataRecord(value, "options", keys);
  return Object.freeze({
    maxDepth: validateLimit(
      record["maxDepth"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxDepth,
      "maxDepth",
      ABSOLUTE_MARKDOWN_PARSER_LIMITS.maxDepth,
    ),
    maxDelimiterRun: validateLimit(
      record["maxDelimiterRun"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxDelimiterRun,
      "maxDelimiterRun",
      ABSOLUTE_MARKDOWN_PARSER_LIMITS.maxDelimiterRun,
    ),
    maxIssues: validateLimit(
      record["maxIssues"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxIssues,
      "maxIssues",
      ABSOLUTE_MARKDOWN_PARSER_LIMITS.maxIssues,
    ),
    maxNodes: validateLimit(
      record["maxNodes"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxNodes,
      "maxNodes",
      ABSOLUTE_MARKDOWN_PARSER_LIMITS.maxNodes,
    ),
    maxUtf16CodeUnits: validateLimit(
      record["maxUtf16CodeUnits"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxUtf16CodeUnits,
      "maxUtf16CodeUnits",
      ABSOLUTE_MARKDOWN_PARSER_LIMITS.maxUtf16CodeUnits,
    ),
    maxUtf8Bytes: validateLimit(
      record["maxUtf8Bytes"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxUtf8Bytes,
      "maxUtf8Bytes",
      ABSOLUTE_MARKDOWN_PARSER_LIMITS.maxUtf8Bytes,
    ),
  });
}

function validateExtractionOptions(value: unknown): ValidatedExtractionOptions {
  const keys = new Set([
    ...Object.keys(DEFAULT_MARKDOWN_PARSER_LIMITS),
    ...Object.keys(DEFAULT_MARKDOWN_EXTRACTION_LIMITS),
  ]);
  const record: Readonly<Record<string, unknown>> =
    value === undefined
      ? (Object.create(null) as Readonly<Record<string, unknown>>)
      : ownDataRecord(value, "options", keys);
  const parserOptions = validateOptions({
    maxDepth: record["maxDepth"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxDepth,
    maxDelimiterRun: record["maxDelimiterRun"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxDelimiterRun,
    maxIssues: record["maxIssues"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxIssues,
    maxNodes: record["maxNodes"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxNodes,
    maxUtf16CodeUnits:
      record["maxUtf16CodeUnits"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxUtf16CodeUnits,
    maxUtf8Bytes: record["maxUtf8Bytes"] ?? DEFAULT_MARKDOWN_PARSER_LIMITS.maxUtf8Bytes,
  });
  return Object.freeze({
    parserOptions,
    extractionLimits: Object.freeze({
      maxExtractedUtf16CodeUnits: validateLimit(
        record["maxExtractedUtf16CodeUnits"] ??
          DEFAULT_MARKDOWN_EXTRACTION_LIMITS.maxExtractedUtf16CodeUnits,
        "maxExtractedUtf16CodeUnits",
        ABSOLUTE_MARKDOWN_EXTRACTION_LIMITS.maxExtractedUtf16CodeUnits,
      ),
      maxExtractedUtf8Bytes: validateLimit(
        record["maxExtractedUtf8Bytes"] ?? DEFAULT_MARKDOWN_EXTRACTION_LIMITS.maxExtractedUtf8Bytes,
        "maxExtractedUtf8Bytes",
        ABSOLUTE_MARKDOWN_EXTRACTION_LIMITS.maxExtractedUtf8Bytes,
      ),
    }),
  });
}

function requireWellFormedUnicode(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (index + 1 >= text.length || next < 0xdc00 || next > 0xdfff) {
        throw new MarkdownParserError(
          "MARKDOWN_MALFORMED_UNICODE",
          "input.text contains an unpaired UTF-16 surrogate",
        );
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new MarkdownParserError(
        "MARKDOWN_MALFORMED_UNICODE",
        "input.text contains an unpaired UTF-16 surrogate",
      );
    }
  }
}

function resourceLimit(name: keyof ParserLimits, message: string): never {
  throw new MarkdownParserError("MARKDOWN_RESOURCE_LIMIT", message, name);
}

function extractionResourceLimit(name: keyof ExtractionLimits, maximum: number): never {
  throw new MarkdownParserError(
    "MARKDOWN_EXTRACTION_RESOURCE_LIMIT",
    `extracted source slices exceed ${name} (${String(maximum)})`,
    name,
  );
}

function isAsciiPunctuation(unit: number): boolean {
  return (
    (unit >= 0x21 && unit <= 0x2f) ||
    (unit >= 0x3a && unit <= 0x40) ||
    (unit >= 0x5b && unit <= 0x60) ||
    (unit >= 0x7b && unit <= 0x7e)
  );
}

function enforceDelimiterRunLimit(text: string, limits: ParserLimits): void {
  let previous = -1;
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === previous && isAsciiPunctuation(unit)) run += 1;
    else {
      previous = unit;
      run = isAsciiPunctuation(unit) ? 1 : 0;
    }
    if (run > limits.maxDelimiterRun) {
      resourceLimit(
        "maxDelimiterRun",
        `Markdown punctuation run exceeds maxDelimiterRun (${String(limits.maxDelimiterRun)})`,
      );
    }
  }
}

function enforceUtf16Length(text: string, limits: ParserLimits): void {
  if (text.length > limits.maxUtf16CodeUnits) {
    resourceLimit(
      "maxUtf16CodeUnits",
      `input.text exceeds maxUtf16CodeUnits (${String(limits.maxUtf16CodeUnits)})`,
    );
  }
}

function buildPositionIndex(text: string, limits: ParserLimits): PositionIndex {
  const byteOffsets = new Float64Array(text.length + 1);
  const lineStarts = [0];
  let byteOffset = 0;
  for (let utf16Offset = 0; utf16Offset < text.length; utf16Offset += 1) {
    const unit = text.charCodeAt(utf16Offset);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      byteOffsets[utf16Offset + 1] = -1;
      byteOffset += 4;
      utf16Offset += 1;
    } else {
      byteOffset += unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3;
      if (unit === 0x0a || (unit === 0x0d && text.charCodeAt(utf16Offset + 1) !== 0x0a)) {
        lineStarts.push(utf16Offset + 1);
      }
    }
    byteOffsets[utf16Offset + 1] = byteOffset;
    if (byteOffset > limits.maxUtf8Bytes) {
      return resourceLimit(
        "maxUtf8Bytes",
        `input.text exceeds maxUtf8Bytes (${String(limits.maxUtf8Bytes)})`,
      );
    }
  }
  return { byteOffsets, lineStarts };
}

function positionAt(index: PositionIndex, utf16Offset: number): SourcePosition {
  const byteOffset = index.byteOffsets[utf16Offset];
  if (byteOffset === undefined || byteOffset < 0) {
    throw new MarkdownParserError(
      "MARKDOWN_PARSE_FAILED",
      "the Markdown parser returned a position that splits a Unicode scalar value",
    );
  }
  let low = 0;
  let high = index.lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = index.lineStarts[middle];
    if (candidate !== undefined && candidate <= utf16Offset) low = middle + 1;
    else high = middle;
  }
  const line = low - 1;
  const lineStart = index.lineStarts[line];
  if (lineStart === undefined) {
    throw new MarkdownParserError("MARKDOWN_PARSE_FAILED", "could not derive a source line");
  }
  return Object.freeze({
    byteOffset,
    utf16Offset,
    line,
    utf16Column: utf16Offset - lineStart,
  });
}

function makeRange(
  sourceId: SourceDocumentId,
  positions: PositionIndex,
  start: number,
  end: number,
): SourceRange {
  return Object.freeze({
    sourceId,
    start: positionAt(positions, start),
    end: positionAt(positions, end),
  });
}

function offsetOf(value: unknown, textLength: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= textLength
    ? (value as number)
    : undefined;
}

function childrenOf(node: MdastNode): readonly MdastNode[] {
  if (node.children === undefined) return [];
  if (!Array.isArray(node.children)) {
    throw new MarkdownParserError(
      "MARKDOWN_PARSE_FAILED",
      "the Markdown parser returned invalid children",
    );
  }
  for (const child of node.children as unknown[]) {
    if (child === null || typeof child !== "object") {
      throw new MarkdownParserError(
        "MARKDOWN_PARSE_FAILED",
        "the Markdown parser returned an invalid child node",
      );
    }
  }
  return node.children as MdastNode[];
}

function indexTree(
  root: MdastNode,
  textLength: number,
  offsetAdjustment: number,
  limits: ParserLimits,
): readonly IndexedNode[] {
  const output: IndexedNode[] = [];
  const seen = new Set<MdastNode>();
  const stack: { readonly node: MdastNode; readonly depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.depth > limits.maxDepth) {
      return resourceLimit(
        "maxDepth",
        `Markdown AST exceeds maxDepth (${String(limits.maxDepth)})`,
      );
    }
    if (seen.has(current.node)) {
      throw new MarkdownParserError(
        "MARKDOWN_PARSE_FAILED",
        "the Markdown parser returned a cyclic AST",
      );
    }
    seen.add(current.node);
    const isRoot = current.node === root;
    const rawStart = offsetOf(current.node.position?.start?.offset, textLength - offsetAdjustment);
    const rawEnd = offsetOf(current.node.position?.end?.offset, textLength - offsetAdjustment);
    const start = isRoot ? 0 : rawStart === undefined ? undefined : rawStart + offsetAdjustment;
    const end = isRoot ? textLength : rawEnd === undefined ? undefined : rawEnd + offsetAdjustment;
    if (start === undefined || end === undefined || start > end) {
      throw new MarkdownParserError(
        "MARKDOWN_PARSE_FAILED",
        "the Markdown parser returned an invalid source range",
      );
    }
    output.push({
      node: current.node,
      depth: current.depth,
      start,
      end,
    });
    if (output.length > limits.maxNodes) {
      return resourceLimit(
        "maxNodes",
        `Markdown AST exceeds maxNodes (${String(limits.maxNodes)})`,
      );
    }
    const children = childrenOf(current.node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child === undefined) {
        throw new MarkdownParserError(
          "MARKDOWN_PARSE_FAILED",
          "the Markdown parser returned a sparse child array",
        );
      }
      stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  return output;
}

function nullableNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nodeType(node: MdastNode): string {
  return typeof node.type === "string" && node.type.length > 0 ? node.type : "invalid-mdast-node";
}

function mapNode(
  indexed: IndexedNode,
  id: AstNodeId,
  sourceId: SourceDocumentId,
  range: SourceRange,
  childIds: readonly AstNodeId[],
  source: string,
): AstNode {
  const base = { id, sourceId, range, childIds: Object.freeze([...childIds]) };
  const type = nodeType(indexed.node);
  if (type === "root") return Object.freeze({ ...base, kind: "root" });
  if (type === "heading") {
    const depth = indexed.node.depth;
    if (depth === 1 || depth === 2 || depth === 3 || depth === 4 || depth === 5 || depth === 6) {
      return Object.freeze({ ...base, kind: "heading", depth });
    }
  } else if (type === "paragraph") return Object.freeze({ ...base, kind: "paragraph" });
  else if (type === "list") {
    const orderedStart = Number.isSafeInteger(indexed.node.start)
      ? (indexed.node.start as number)
      : null;
    if (indexed.node.ordered === true && (orderedStart === null || orderedStart < 1)) {
      return Object.freeze({
        ...base,
        kind: "unknown",
        syntaxKind: "list",
        reason: "Ordered list start cannot satisfy the positive B03 list-start invariant",
      });
    }
    return Object.freeze({
      ...base,
      kind: "list",
      ordered: indexed.node.ordered === true,
      start: indexed.node.ordered === true ? orderedStart : null,
    });
  } else if (type === "listItem") return Object.freeze({ ...base, kind: "list-item" });
  else if (type === "blockquote") return Object.freeze({ ...base, kind: "block-quote" });
  else if (type === "code") {
    return Object.freeze({
      ...base,
      kind: "code-block",
      language: nullableNonEmpty(indexed.node.lang),
      metadata: nullableNonEmpty(indexed.node.meta),
    });
  } else if (type === "inlineCode") return Object.freeze({ ...base, kind: "inline-code" });
  else if (type === "link") {
    return Object.freeze({
      ...base,
      kind: "link",
      destination: typeof indexed.node.url === "string" ? indexed.node.url : "",
      title: nullableNonEmpty(indexed.node.title),
    });
  } else if (type === "text") return Object.freeze({ ...base, kind: "text" });
  else if (type === "html") {
    const original = source.slice(indexed.start, indexed.end).trimStart();
    if (original.startsWith("<!--")) return Object.freeze({ ...base, kind: "html-comment" });
  }
  return Object.freeze({
    ...base,
    kind: "unknown",
    syntaxKind: type,
    reason: "CommonMark syntax has no dedicated B03 AST node kind",
  });
}

function fenceTrackingExtension(tracker: FenceTracker): Extension {
  let activeOpening: number | null = null;
  return {
    exit: {
      codeFencedFence(this: CompileContext, token: Token): void {
        if (this.data.flowCodeInside) {
          if (activeOpening !== null) tracker.openingStates.set(activeOpening, true);
          activeOpening = null;
          return;
        }
        activeOpening = token.start.offset;
        tracker.openingStates.set(activeOpening, false);
        // This extension deliberately replaces mdast-util-from-markdown's built-in fence-exit
        // handle, so it must preserve the opening handle's buffer and state transitions exactly.
        this.buffer();
        this.data.flowCodeInside = true;
      },
    },
  };
}

function collectIssues(
  indexedNodes: readonly IndexedNode[],
  source: string,
  sourceId: SourceDocumentId,
  positions: PositionIndex,
  fenceTracker: FenceTracker,
  offsetAdjustment: number,
  limits: ParserLimits,
): readonly MarkdownParseIssue[] {
  const issues: MarkdownParseIssue[] = [];
  const add = (issue: MarkdownParseIssue): void => {
    if (issues.length >= limits.maxIssues) {
      resourceLimit(
        "maxIssues",
        `Markdown recovery exceeds maxIssues (${String(limits.maxIssues)})`,
      );
    }
    issues.push(Object.freeze(issue));
  };
  for (const indexed of indexedNodes) {
    const type = nodeType(indexed.node);
    if (
      type === "code" &&
      fenceTracker.openingStates.get(indexed.start - offsetAdjustment) === false
    ) {
      add({
        code: "unclosed-fence",
        message: "Fenced code block reaches the end of its container without a closing fence",
        range: makeRange(sourceId, positions, indexed.start, indexed.end),
      });
    } else if (type === "html") {
      const original = source.slice(indexed.start, indexed.end).trimStart();
      if (original.startsWith("<!--") && !original.includes("-->")) {
        add({
          code: "unclosed-html-comment",
          message: "HTML comment reaches the end of its container without a closing delimiter",
          range: makeRange(sourceId, positions, indexed.start, indexed.end),
        });
      }
    }
  }
  return Object.freeze(issues);
}

function parseStateFor(issues: readonly MarkdownParseIssue[]): SourceParseState {
  if (issues.length === 0) return Object.freeze({ state: "complete" });
  const codes = [...new Set(issues.map((issue) => issue.code))];
  return Object.freeze({
    state: "partial",
    reason: `CommonMark recovery reported ${String(issues.length)} issue(s): ${codes.join(", ")}`,
  });
}

interface ParsedMarkdownInternal {
  readonly input: MarkdownParseInput;
  readonly indexedNodes: readonly IndexedNode[];
  readonly result: MarkdownParseResult;
}

/**
 * Parse exact decoded UTF-8 Markdown into B03 AST nodes.
 *
 * Repository text is treated only as data. This function performs no I/O, imports no plug-ins,
 * resolves no links, and never evaluates HTML or code. Syntax recovery is returned as issues;
 * invalid API input and exceeded resource limits fail closed with `MarkdownParserError`.
 */
function parseMarkdownInternal(
  inputValue: MarkdownParseInput,
  optionsValue?: MarkdownParserOptions,
): ParsedMarkdownInternal {
  const input = validateInput(inputValue);
  const limits = validateOptions(optionsValue);
  // Length is constant-time on a JavaScript string and must gate every content-dependent scan.
  enforceUtf16Length(input.text, limits);
  requireWellFormedUnicode(input.text);
  const positions = buildPositionIndex(input.text, limits);
  enforceDelimiterRunLimit(input.text, limits);

  // micromark intentionally consumes a leading UTF-8 BOM before assigning offsets. Parse the
  // post-BOM view explicitly and translate its offsets so all emitted ranges remain source-exact.
  const offsetAdjustment = input.text.startsWith("\uFEFF") ? 1 : 0;
  const parserText = offsetAdjustment === 0 ? input.text : input.text.slice(offsetAdjustment);
  const fenceTracker: FenceTracker = { openingStates: new Map() };

  let root: MdastNode;
  try {
    root = fromMarkdown(parserText, {
      mdastExtensions: [fenceTrackingExtension(fenceTracker)],
    }) as MdastNode;
  } catch {
    throw new MarkdownParserError(
      "MARKDOWN_PARSE_FAILED",
      "the bounded CommonMark parser could not parse the input",
    );
  }

  const indexedNodes = indexTree(root, input.text.length, offsetAdjustment, limits);
  const sourceKey = createHash("sha256")
    .update(input.sourceId, "utf8")
    .update("\0", "utf8")
    .update(input.text, "utf8")
    .digest("hex");
  const ids = new Map<MdastNode, AstNodeId>();
  for (const [index, indexed] of indexedNodes.entries()) {
    ids.set(indexed.node, `ast:${sourceKey}:${index.toString(36)}` as AstNodeId);
  }

  const nodes = indexedNodes.map((indexed) => {
    const id = ids.get(indexed.node);
    if (id === undefined) {
      throw new MarkdownParserError(
        "MARKDOWN_PARSE_FAILED",
        "could not assign a stable AST node ID",
      );
    }
    const childIds = childrenOf(indexed.node).map((child) => {
      const childId = ids.get(child);
      if (childId === undefined) {
        throw new MarkdownParserError(
          "MARKDOWN_PARSE_FAILED",
          "a child node was missing from the bounded AST index",
        );
      }
      return childId;
    });
    return mapNode(
      indexed,
      id,
      input.sourceId,
      makeRange(input.sourceId, positions, indexed.start, indexed.end),
      childIds,
      input.text,
    );
  });
  const issues = collectIssues(
    indexedNodes,
    input.text,
    input.sourceId,
    positions,
    fenceTracker,
    offsetAdjustment,
    limits,
  );
  const rootNodeId = ids.get(root);
  if (rootNodeId === undefined) {
    throw new MarkdownParserError("MARKDOWN_PARSE_FAILED", "the AST root has no stable ID");
  }
  const result: MarkdownParseResult = Object.freeze({
    syntax: MARKDOWN_SYNTAX,
    rootNodeId,
    nodes: Object.freeze(nodes),
    issues,
    parseState: parseStateFor(issues),
  });
  return { input, indexedNodes, result };
}

export function parseMarkdown(
  inputValue: MarkdownParseInput,
  optionsValue?: MarkdownParserOptions,
): MarkdownParseResult {
  return parseMarkdownInternal(inputValue, optionsValue).result;
}

function referenceTypeOf(value: unknown): MarkdownReferenceExtraction["referenceType"] {
  return value === "collapsed" || value === "full" || value === "shortcut" ? value : null;
}

function requiredIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isExtractedNode(node: AstNode, indexed: IndexedNode): boolean {
  if (
    node.kind === "heading" ||
    node.kind === "paragraph" ||
    node.kind === "list-item" ||
    node.kind === "code-block" ||
    node.kind === "link"
  ) {
    return true;
  }
  const type = nodeType(indexed.node);
  return type === "definition" || type === "linkReference";
}

function preflightExtractedSlices(
  indexedNodes: readonly IndexedNode[],
  nodes: readonly AstNode[],
  limits: ExtractionLimits,
): void {
  let utf16CodeUnits = 0;
  let utf8Bytes = 0;
  for (const [index, indexed] of indexedNodes.entries()) {
    const node = nodes[index];
    if (node === undefined) {
      throw new MarkdownParserError(
        "MARKDOWN_PARSE_FAILED",
        "an indexed Markdown node was missing from the public AST",
      );
    }
    if (!isExtractedNode(node, indexed)) continue;
    utf16CodeUnits += node.range.end.utf16Offset - node.range.start.utf16Offset;
    utf8Bytes += node.range.end.byteOffset - node.range.start.byteOffset;
    if (utf16CodeUnits > limits.maxExtractedUtf16CodeUnits) {
      extractionResourceLimit("maxExtractedUtf16CodeUnits", limits.maxExtractedUtf16CodeUnits);
    }
    if (utf8Bytes > limits.maxExtractedUtf8Bytes) {
      extractionResourceLimit("maxExtractedUtf8Bytes", limits.maxExtractedUtf8Bytes);
    }
  }
}

/**
 * Extract the source-exact C08 structural views used by syntax adapters.
 *
 * This operation deliberately does not render Markdown, normalize prose, resolve reference links,
 * classify instructions, or interpret code. Every extraction points back to one C06/B03 AST node
 * and carries the exact source slice for downstream range and provenance checks.
 */
export function extractMarkdownContent(
  inputValue: MarkdownParseInput,
  optionsValue?: MarkdownExtractionOptions,
): MarkdownExtractionResult {
  const options = validateExtractionOptions(optionsValue);
  const parsed = parseMarkdownInternal(inputValue, options.parserOptions);
  preflightExtractedSlices(parsed.indexedNodes, parsed.result.nodes, options.extractionLimits);
  const headings: MarkdownHeadingExtraction[] = [];
  const statements: MarkdownStatementExtraction[] = [];
  const codeBlocks: MarkdownCodeBlockExtraction[] = [];
  const links: MarkdownLinkExtraction[] = [];
  const references: MarkdownReferenceExtraction[] = [];

  for (const [index, indexed] of parsed.indexedNodes.entries()) {
    const node = parsed.result.nodes[index];
    if (node === undefined) {
      throw new MarkdownParserError(
        "MARKDOWN_PARSE_FAILED",
        "an indexed Markdown node was missing from the public AST",
      );
    }
    if (!isExtractedNode(node, indexed)) continue;
    const original = parsed.input.text.slice(
      node.range.start.utf16Offset,
      node.range.end.utf16Offset,
    );
    const slice = { nodeId: node.id, range: node.range, original };
    if (node.kind === "heading") {
      headings.push(Object.freeze({ ...slice, kind: "heading", depth: node.depth }));
    } else if (node.kind === "paragraph" || node.kind === "list-item") {
      statements.push(Object.freeze({ ...slice, kind: node.kind }));
    } else if (node.kind === "code-block") {
      codeBlocks.push(
        Object.freeze({
          ...slice,
          kind: "code-block",
          language: node.language,
          metadata: node.metadata,
        }),
      );
    } else if (node.kind === "link") {
      links.push(
        Object.freeze({
          ...slice,
          kind: "link",
          destination: node.destination,
          title: node.title,
        }),
      );
    }

    const type = nodeType(indexed.node);
    if (type !== "definition" && type !== "linkReference") continue;
    const identifier = requiredIdentifier(indexed.node.identifier);
    if (identifier === null) {
      throw new MarkdownParserError(
        "MARKDOWN_PARSE_FAILED",
        "the Markdown parser returned a reference without an identifier",
      );
    }
    const isDefinition = type === "definition";
    references.push(
      Object.freeze({
        ...slice,
        kind: "reference",
        role: isDefinition ? "definition" : "use",
        identifier,
        label: nullableNonEmpty(indexed.node.label),
        referenceType: isDefinition ? null : referenceTypeOf(indexed.node.referenceType),
        destination: isDefinition && typeof indexed.node.url === "string" ? indexed.node.url : null,
        title: isDefinition ? nullableNonEmpty(indexed.node.title) : null,
      }),
    );
  }

  return Object.freeze({
    ...parsed.result,
    headings: Object.freeze(headings),
    statements: Object.freeze(statements),
    codeBlocks: Object.freeze(codeBlocks),
    links: Object.freeze(links),
    references: Object.freeze(references),
  });
}
