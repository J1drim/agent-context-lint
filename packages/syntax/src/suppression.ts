import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { parseMarkdown } from "@agent-context/markdown";
import { validateDiagnosticBundle, validateInstructionIr } from "@agent-context/core";

import type {
  Diagnostic,
  DiagnosticBundle,
  DiagnosticFingerprint,
  DiagnosticSourceLocation,
  SuppressionId,
  SuppressionRecord,
} from "@agent-context/core";
import type {
  AstNode,
  InstructionIr,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
  SourceRange,
} from "@agent-context/core";

export const SUPPRESSION_DIRECTIVE_SYNTAX = "agent-context-lint-disable-next-line/v1" as const;

export const DEFAULT_SUPPRESSION_LIMITS: Readonly<{
  maxCandidates: 1_024;
  maxCommentBytes: 4_096;
  maxIssues: 128;
  maxReasonBytes: 1_024;
  maxRulesPerDirective: 64;
}> = Object.freeze({
  maxCandidates: 1_024,
  maxCommentBytes: 4_096,
  maxIssues: 128,
  maxReasonBytes: 1_024,
  maxRulesPerDirective: 64,
});

const ABSOLUTE_SUPPRESSION_LIMITS = DEFAULT_SUPPRESSION_LIMITS;
export const SUPPRESSION_PROCESSOR_RESOURCE_LIMITS: Readonly<{
  maxNodes: 50_000;
  maxSources: 1_024;
  maxUtf16CodeUnitsPerSource: 524_288;
  maxUtf8BytesPerSource: 524_288;
}> = Object.freeze({
  maxNodes: 50_000,
  maxSources: 1_024,
  maxUtf16CodeUnitsPerSource: 524_288,
  maxUtf8BytesPerSource: 524_288,
});
const DIRECTIVE_KEYWORD = "agent-context-lint-disable-next-line";
const DIRECTIVE_MARKER = "agent-context-lint-";
const RULE_ID_PATTERN = /^ACL[1-9][0-9]{2}$/;
const BROAD_RULE_PATTERN = /^(?:\*|all|ACL\*)$/i;
const parsedDirectiveBrand: unique symbol = Symbol("ParsedSuppressionDirective");
const issuedDirectives = new WeakSet<object>();

export type SuppressionProcessorErrorCode =
  | "SUPPRESSION_INVALID_BUNDLE"
  | "SUPPRESSION_INVALID_INPUT"
  | "SUPPRESSION_INVALID_OPTIONS"
  | "SUPPRESSION_INVALID_OWNERSHIP"
  | "SUPPRESSION_INVALID_OUTPUT"
  | "SUPPRESSION_RESOURCE_LIMIT";

export type SuppressionDirectiveIssueCode =
  | "broad-rule"
  | "duplicate-rule"
  | "invalid-rule"
  | "malformed-directive"
  | "missing-reason"
  | "missing-target-line"
  | "resource-limit"
  | "unknown-directive";

export interface SuppressionOptions {
  readonly maxCandidates?: number;
  readonly maxCommentBytes?: number;
  readonly maxIssues?: number;
  readonly maxReasonBytes?: number;
  readonly maxRulesPerDirective?: number;
  readonly requireReason?: boolean;
}

export interface SuppressionDirectiveIssue {
  readonly code: SuppressionDirectiveIssueCode;
  readonly location: DiagnosticSourceLocation;
  readonly message: string;
}

export interface ParsedSuppressionDirective {
  readonly [parsedDirectiveBrand]: true;
  readonly profileScope: "all-profiles";
  readonly record: SuppressionRecord;
  readonly syntax: typeof SUPPRESSION_DIRECTIVE_SYNTAX;
  readonly target: DiagnosticSourceLocation;
}

export interface SuppressionParseResult {
  readonly directives: readonly ParsedSuppressionDirective[];
  readonly issues: readonly SuppressionDirectiveIssue[];
}

export interface SuppressedDiagnostic {
  readonly diagnostic: Diagnostic;
  readonly suppressionId: SuppressionId;
}

export interface SuppressionMatchResult {
  /** All diagnostics plus final suppression states; remains valid B04 transport data. */
  readonly bundle: DiagnosticBundle;
  readonly suppressedDiagnostics: readonly SuppressedDiagnostic[];
  readonly visibleDiagnostics: readonly Diagnostic[];
}

export class SuppressionProcessorError extends Error {
  public readonly code: SuppressionProcessorErrorCode;

  public constructor(code: SuppressionProcessorErrorCode, message: string) {
    super(message);
    this.name = "SuppressionProcessorError";
    this.code = code;
  }
}

type SuppressionLimits = Readonly<Required<SuppressionOptions>>;
type UnknownRecord = Readonly<Record<string, unknown>>;

interface LineIndex {
  readonly byteOffsets: Float64Array;
  readonly lines: readonly { readonly end: number; readonly start: number }[];
}

interface SourceContext {
  readonly htmlCommentRanges: ReadonlySet<string>;
  readonly inertLines: Uint8Array;
  readonly lineIndex: LineIndex;
}

interface Candidate {
  readonly node: AstNode & { readonly kind: "html-comment" };
  readonly source: SourceDocument;
}

function fail(code: SuppressionProcessorErrorCode, message: string): never {
  throw new SuppressionProcessorError(code, message);
}

function ownDataRecord(
  value: unknown,
  name: string,
  allowedKeys: ReadonlySet<string>,
  code: SuppressionProcessorErrorCode,
): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return fail(code, `${name} must be a non-proxy object`);
  }
  let prototype: object | null;
  try {
    prototype = Reflect.getPrototypeOf(value);
  } catch {
    return fail(code, `${name} cannot be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(code, `${name} must have Object.prototype or a null prototype`);
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail(code, `${name} cannot be inspected safely`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      return fail(code, `${name} contains an unsupported field`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      return fail(code, `${name}.${key} must be an own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function limit(value: unknown, key: keyof typeof DEFAULT_SUPPRESSION_LIMITS): number {
  const maximum = ABSOLUTE_SUPPRESSION_LIMITS[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return fail(
      "SUPPRESSION_INVALID_OPTIONS",
      `${key} must be a positive safe integer no greater than ${String(maximum)}`,
    );
  }
  return value as number;
}

function optionsOf(value: unknown): SuppressionLimits {
  if (value === undefined)
    return Object.freeze({ ...DEFAULT_SUPPRESSION_LIMITS, requireReason: false });
  const allowed = new Set([...Object.keys(DEFAULT_SUPPRESSION_LIMITS), "requireReason"]);
  const record = ownDataRecord(value, "options", allowed, "SUPPRESSION_INVALID_OPTIONS");
  if (record["requireReason"] !== undefined && typeof record["requireReason"] !== "boolean") {
    return fail("SUPPRESSION_INVALID_OPTIONS", "requireReason must be Boolean");
  }
  return Object.freeze({
    maxCandidates: limit(
      record["maxCandidates"] ?? DEFAULT_SUPPRESSION_LIMITS.maxCandidates,
      "maxCandidates",
    ),
    maxCommentBytes: limit(
      record["maxCommentBytes"] ?? DEFAULT_SUPPRESSION_LIMITS.maxCommentBytes,
      "maxCommentBytes",
    ),
    maxIssues: limit(record["maxIssues"] ?? DEFAULT_SUPPRESSION_LIMITS.maxIssues, "maxIssues"),
    maxReasonBytes: limit(
      record["maxReasonBytes"] ?? DEFAULT_SUPPRESSION_LIMITS.maxReasonBytes,
      "maxReasonBytes",
    ),
    maxRulesPerDirective: limit(
      record["maxRulesPerDirective"] ?? DEFAULT_SUPPRESSION_LIMITS.maxRulesPerDirective,
      "maxRulesPerDirective",
    ),
    requireReason: record["requireReason"] ?? false,
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    compareUtf8(left.source.path, right.source.path) ||
    left.node.range.start.utf16Offset - right.node.range.start.utf16Offset ||
    compareUtf8(left.node.id, right.node.id)
  );
}

function compareDirectives(
  left: ParsedSuppressionDirective,
  right: ParsedSuppressionDirective,
): number {
  return (
    compareUtf8(left.record.directive.path, right.record.directive.path) ||
    left.record.directive.range.start.utf16Offset -
      right.record.directive.range.start.utf16Offset ||
    compareUtf8(left.record.id, right.record.id)
  );
}

function buildLineIndex(text: string): LineIndex {
  const byteOffsets = new Float64Array(text.length + 1);
  const lines: { end: number; start: number }[] = [];
  let byteOffset = 0;
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      byteOffsets[index + 1] = -1;
      byteOffset += 4;
      index += 1;
    } else {
      byteOffset += unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3;
      if (unit === 0x0d || unit === 0x0a) {
        lines.push({ end: index, start: lineStart });
        if (unit === 0x0d && text.charCodeAt(index + 1) === 0x0a) {
          byteOffsets[index + 1] = byteOffset;
          byteOffset += 1;
          index += 1;
        }
        lineStart = index + 1;
      }
    }
    byteOffsets[index + 1] = byteOffset;
  }
  if (lineStart < text.length) lines.push({ end: text.length, start: lineStart });
  return { byteOffsets, lines };
}

function lineText(text: string, index: LineIndex, line: number): string {
  const entry = index.lines[line];
  return entry === undefined ? "" : text.slice(entry.start, entry.end);
}

function frontmatterLineCount(text: string, index: LineIndex): number {
  if (index.lines.length === 0) return 0;
  const opening = lineText(text, index, 0).replace(/^\uFEFF/, "");
  if (!/^---[ \t]*$/u.test(opening)) return 0;
  for (let line = 1; line < index.lines.length; line += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(lineText(text, index, line))) return line + 1;
  }
  // A malformed, unclosed envelope is authority-denying through end of source.
  return index.lines.length;
}

function rangeKey(start: number, end: number): string {
  return `${String(start)}:${String(end)}`;
}

function commonMarkHtmlCommentRanges(source: SourceDocument): ReadonlySet<string> {
  let parsed: ReturnType<typeof parseMarkdown>;
  try {
    parsed = parseMarkdown({ sourceId: source.id, text: source.text });
  } catch {
    return new Set();
  }
  const ranges = new Set<string>();
  for (const node of parsed.nodes) {
    if (node.kind === "html-comment") {
      ranges.add(rangeKey(node.range.start.utf16Offset, node.range.end.utf16Offset));
    }
  }
  return ranges;
}

function sourceContext(source: SourceDocument): SourceContext {
  const lineIndex = buildLineIndex(source.text);
  const inertLines = new Uint8Array(lineIndex.lines.length);
  const frontmatterLines = frontmatterLineCount(source.text, lineIndex);
  inertLines.fill(1, 0, frontmatterLines);
  return {
    htmlCommentRanges: commonMarkHtmlCommentRanges(source),
    inertLines,
    lineIndex,
  };
}

function sourceVerifiedComment(candidate: Candidate, context: SourceContext): string | undefined {
  const { node, source } = candidate;
  const line = context.lineIndex.lines[node.range.start.line];
  if (line === undefined || context.inertLines[node.range.start.line] === 1) return undefined;
  const nodeRaw = source.text.slice(node.range.start.utf16Offset, node.range.end.utf16Offset);
  const commentStartInNode = nodeRaw.indexOf("<!--");
  if (commentStartInNode < 0) return undefined;
  if (
    !context.htmlCommentRanges.has(
      rangeKey(node.range.start.utf16Offset, node.range.end.utf16Offset),
    )
  ) {
    return undefined;
  }
  const commentStart = node.range.start.utf16Offset + commentStartInNode;
  if (node.range.start.line !== node.range.end.line) return nodeRaw;
  const commentEndInNode = nodeRaw.lastIndexOf("-->");
  if (commentEndInNode < commentStartInNode) return nodeRaw;
  if (!/^[ \t]*$/u.test(nodeRaw.slice(0, commentStartInNode))) return undefined;
  const afterComment = commentEndInNode + 3;
  if (!/^[ \t]*$/u.test(nodeRaw.slice(afterComment))) return undefined;
  const commentEnd = node.range.start.utf16Offset + afterComment;
  if (commentStart < line.start || commentEnd > line.end) return undefined;

  let prefix = source.text.slice(line.start, commentStart);
  if (node.range.start.line === 0) prefix = prefix.replace(/^\uFEFF/u, "");
  if (/^[ \t]*$/u.test(prefix)) {
    // CommonMark permits at most three literal leading spaces for an HTML block. A tab reaches
    // the indented-code column and four spaces are an indented code block.
    if (prefix.includes("\t") || prefix.length > 3) return undefined;
  }
  return source.text.slice(commentStart, commentEnd);
}

function positionAt(index: LineIndex, line: number, utf16Offset: number): SourcePosition {
  const lineEntry = index.lines[line];
  const byteOffset = index.byteOffsets[utf16Offset];
  if (lineEntry === undefined || byteOffset === undefined || byteOffset < 0) {
    return fail("SUPPRESSION_INVALID_INPUT", "a source position could not be derived");
  }
  return Object.freeze({
    byteOffset,
    line,
    utf16Column: utf16Offset - lineEntry.start,
    utf16Offset,
  });
}

function targetRange(
  source: SourceDocument,
  index: LineIndex,
  directive: SourceRange,
): SourceRange | undefined {
  const lineNumber = directive.end.line + 1;
  const line = index.lines[lineNumber];
  if (line === undefined) return undefined;
  return Object.freeze({
    sourceId: source.id,
    start: positionAt(index, lineNumber, line.start),
    end: positionAt(index, lineNumber, line.end),
  });
}

function location(source: SourceDocument, range: SourceRange): DiagnosticSourceLocation {
  const copyPosition = (position: SourcePosition): SourcePosition =>
    Object.freeze({
      byteOffset: position.byteOffset,
      line: position.line,
      utf16Column: position.utf16Column,
      utf16Offset: position.utf16Offset,
    });
  const copyRange: SourceRange = Object.freeze({
    sourceId: range.sourceId,
    start: copyPosition(range.start),
    end: copyPosition(range.end),
  });
  return Object.freeze({
    path: source.path,
    range: copyRange,
    sourceDigest: source.sha256,
    sourceId: source.id,
  });
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([size, bytes]);
}

function suppressionId(
  source: SourceDocument,
  range: SourceRange,
  ruleIds: readonly string[],
  reason: string | null,
): SuppressionId {
  const hash = createHash("sha256");
  for (const value of [
    SUPPRESSION_DIRECTIVE_SYNTAX,
    source.id,
    source.path,
    source.sha256,
    String(range.start.utf16Offset),
    String(range.end.utf16Offset),
    ...ruleIds,
    reason ?? "",
  ]) {
    hash.update(frame(value));
  }
  return `suppression:${hash.digest("hex")}` as SuppressionId;
}

function frozenRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function issueAdder(issues: SuppressionDirectiveIssue[], limits: SuppressionLimits) {
  let stopped = false;
  return (issue: SuppressionDirectiveIssue): boolean => {
    if (stopped) return false;
    if (issues.length >= limits.maxIssues - 1) {
      issues.push(
        frozenRecord({
          code: "resource-limit" as const,
          location: issue.location,
          message: `suppression issue reporting stopped after ${String(limits.maxIssues - 1)} issue(s)`,
        }),
      );
      stopped = true;
      return false;
    }
    issues.push(frozenRecord(issue));
    return true;
  };
}

function hasInertAncestor(
  node: AstNode,
  nodes: ReadonlyMap<string, AstNode>,
  parents: ReadonlyMap<string, string>,
): boolean {
  let parentId = parents.get(node.id);
  while (parentId !== undefined) {
    const parent = nodes.get(parentId);
    if (parent === undefined) return true;
    if (
      parent.kind === "code-block" ||
      parent.kind === "frontmatter" ||
      parent.kind === "inline-code"
    ) {
      return true;
    }
    parentId = parents.get(parent.id);
  }
  return false;
}

function enforceProcessorResourceLimits(ir: InstructionIr): void {
  if (ir.sources.length > SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxSources) {
    return fail(
      "SUPPRESSION_RESOURCE_LIMIT",
      `instruction IR exceeds maxSources (${String(SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxSources)})`,
    );
  }
  if (ir.nodes.length > SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxNodes) {
    return fail(
      "SUPPRESSION_RESOURCE_LIMIT",
      `instruction IR exceeds maxNodes (${String(SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxNodes)})`,
    );
  }
  for (const source of ir.sources) {
    if (source.utf16Length > SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxUtf16CodeUnitsPerSource) {
      return fail(
        "SUPPRESSION_RESOURCE_LIMIT",
        `source exceeds maxUtf16CodeUnitsPerSource (${String(SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxUtf16CodeUnitsPerSource)})`,
      );
    }
    if (source.byteLength > SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxUtf8BytesPerSource) {
      return fail(
        "SUPPRESSION_RESOURCE_LIMIT",
        `source exceeds maxUtf8BytesPerSource (${String(SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxUtf8BytesPerSource)})`,
      );
    }
  }
  let candidates = 0;
  for (const node of ir.nodes) {
    if (node.kind !== "html-comment") continue;
    candidates += 1;
    if (candidates > ABSOLUTE_SUPPRESSION_LIMITS.maxCandidates) {
      return fail(
        "SUPPRESSION_RESOURCE_LIMIT",
        `instruction IR exceeds the absolute suppression candidate limit (${String(ABSOLUTE_SUPPRESSION_LIMITS.maxCandidates)})`,
      );
    }
  }
}

function candidatesOf(ir: InstructionIr): readonly Candidate[] {
  const sources = new Map(ir.sources.map((source) => [source.id, source]));
  const nodes = new Map(ir.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string>();
  for (const node of ir.nodes) {
    for (const childId of node.childIds) parents.set(childId, node.id);
  }
  const output: Candidate[] = [];
  for (const node of ir.nodes) {
    if (node.kind !== "html-comment" || hasInertAncestor(node, nodes, parents)) continue;
    const source = sources.get(node.sourceId);
    if (source !== undefined) output.push({ node, source });
  }
  return output.sort(compareCandidates);
}

function horizontalTrim(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

interface ParsedBody {
  readonly reason: string | null;
  readonly ruleIds: readonly string[];
}

function parseBody(
  raw: string,
  candidate: Candidate,
  limits: SuppressionLimits,
  addIssue: (issue: SuppressionDirectiveIssue) => boolean,
): ParsedBody | undefined {
  const directiveLocation = location(candidate.source, candidate.node.range);
  const report = (code: SuppressionDirectiveIssueCode, message: string): undefined => {
    addIssue({ code, location: directiveLocation, message });
    return undefined;
  };
  if (!raw.includes(DIRECTIVE_MARKER)) return undefined;
  if (
    raw.length > limits.maxCommentBytes ||
    Buffer.byteLength(raw, "utf8") > limits.maxCommentBytes
  ) {
    report("resource-limit", "suppression comment exceeds maxCommentBytes");
    return undefined;
  }
  if (!raw.startsWith("<!--") || !raw.endsWith("-->")) {
    report("malformed-directive", "suppression directive must be a closed HTML comment");
    return undefined;
  }
  const inner = horizontalTrim(raw.slice(4, -3));
  if (inner.includes("\n") || inner.includes("\r")) {
    report("malformed-directive", "suppression directives must occupy one physical line");
    return undefined;
  }
  if (!inner.startsWith(DIRECTIVE_KEYWORD)) {
    report("unknown-directive", "suppression directive name is not supported");
    return undefined;
  }
  const afterKeyword = inner.slice(DIRECTIVE_KEYWORD.length);
  if (afterKeyword.length === 0 || !/^[ \t]/.test(afterKeyword)) {
    report("malformed-directive", "suppression directive must name at least one rule");
    return undefined;
  }
  const payload = horizontalTrim(afterKeyword);
  const separator = /[ \t]+--(?:[ \t]+|$)/.exec(payload);
  const rulesText = horizontalTrim(
    separator === null ? payload : payload.slice(0, separator.index),
  );
  const reason =
    separator === null
      ? null
      : horizontalTrim(payload.slice(separator.index + separator[0].length));
  if (reason !== null && (reason.length === 0 || reason.includes("--"))) {
    report("malformed-directive", "suppression reason is malformed");
    return undefined;
  }
  if (
    reason !== null &&
    (reason.length > limits.maxReasonBytes ||
      Buffer.byteLength(reason, "utf8") > limits.maxReasonBytes)
  ) {
    report("resource-limit", "suppression reason exceeds maxReasonBytes");
    return undefined;
  }
  if (reason === null && limits.requireReason) {
    report("missing-reason", "suppression policy requires a non-empty reason");
    return undefined;
  }
  if (rulesText.length === 0) {
    report("malformed-directive", "suppression directive must name at least one rule");
    return undefined;
  }
  const rawRules = rulesText.split(",").map(horizontalTrim);
  if (rawRules.length > limits.maxRulesPerDirective) {
    report("resource-limit", "suppression directive exceeds maxRulesPerDirective");
    return undefined;
  }
  const seen = new Set<string>();
  for (const ruleId of rawRules) {
    if (ruleId.length === 0) {
      report("malformed-directive", "suppression rule list contains an empty entry");
      return undefined;
    }
    if (BROAD_RULE_PATTERN.test(ruleId)) {
      report("broad-rule", "wildcard and all-rule suppressions are forbidden");
      return undefined;
    }
    if (!RULE_ID_PATTERN.test(ruleId)) {
      report("invalid-rule", "suppression rule IDs must use the ACLddd form");
      return undefined;
    }
    if (seen.has(ruleId)) {
      report("duplicate-rule", "suppression rule IDs must be unique");
      return undefined;
    }
    seen.add(ruleId);
  }
  return { reason, ruleIds: [...seen].sort(compareUtf8) };
}

/** Parse closed, source-exact targeted directives from a validated B03 graph. */
export function parseSuppressionDirectives(
  input: unknown,
  options?: SuppressionOptions,
): SuppressionParseResult {
  const limits = optionsOf(options);
  const validation = validateInstructionIr(input);
  if (!validation.ok) {
    return fail("SUPPRESSION_INVALID_INPUT", "input must be a valid B03 instruction IR");
  }
  // Valid B03 transport can exceed a single bounded parser invocation. Gate constant-time source
  // metadata and bounded collection sizes before building maps, collecting candidates, sorting, or
  // reparsing any repository content.
  enforceProcessorResourceLimits(validation.value);
  const issues: SuppressionDirectiveIssue[] = [];
  const directives: ParsedSuppressionDirective[] = [];
  const addIssue = issueAdder(issues, limits);
  const contexts = new Map<SourceDocumentId, SourceContext>();
  let candidateCount = 0;

  for (const candidate of candidatesOf(validation.value)) {
    const context = contexts.get(candidate.source.id) ?? sourceContext(candidate.source);
    contexts.set(candidate.source.id, context);
    const raw = sourceVerifiedComment(candidate, context);
    if (raw === undefined) continue;
    if (!raw.includes(DIRECTIVE_MARKER)) continue;
    candidateCount += 1;
    if (candidateCount > limits.maxCandidates) {
      addIssue({
        code: "resource-limit",
        location: location(candidate.source, candidate.node.range),
        message: "suppression candidate count exceeds maxCandidates",
      });
      break;
    }
    const body = parseBody(raw, candidate, limits, addIssue);
    if (body === undefined) continue;
    const attachedRange = targetRange(candidate.source, context.lineIndex, candidate.node.range);
    if (attachedRange === undefined) {
      addIssue({
        code: "missing-target-line",
        location: location(candidate.source, candidate.node.range),
        message: "disable-next-line has no following physical line",
      });
      continue;
    }
    const record = frozenRecord({
      evidence: Object.freeze([]),
      id: suppressionId(candidate.source, candidate.node.range, body.ruleIds, body.reason),
      matchedPathFingerprints: Object.freeze([]),
      reason: body.reason,
      state: "applicable" as const,
      targetRuleIds: Object.freeze([...body.ruleIds]),
      directive: location(candidate.source, candidate.node.range),
    });
    const parsed = frozenRecord({
      [parsedDirectiveBrand]: true as const,
      profileScope: "all-profiles" as const,
      record,
      syntax: SUPPRESSION_DIRECTIVE_SYNTAX,
      target: location(candidate.source, attachedRange),
    });
    issuedDirectives.add(parsed);
    directives.push(parsed);
  }
  return frozenRecord({
    directives: Object.freeze(directives.sort(compareDirectives)),
    issues: Object.freeze(issues),
  });
}

function requireIssuedDirectives(value: unknown): readonly ParsedSuppressionDirective[] {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > ABSOLUTE_SUPPRESSION_LIMITS.maxCandidates
  ) {
    return fail(
      "SUPPRESSION_INVALID_OWNERSHIP",
      "directives must be a bounded parser result array",
    );
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    return fail("SUPPRESSION_INVALID_OWNERSHIP", "directives must be a dense plain array");
  }
  const output: ParsedSuppressionDirective[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const candidate: unknown =
      descriptor === undefined || !("value" in descriptor) ? undefined : descriptor.value;
    if (candidate === null || typeof candidate !== "object" || !issuedDirectives.has(candidate)) {
      return fail("SUPPRESSION_INVALID_OWNERSHIP", "directives must originate from this parser");
    }
    output.push(candidate as ParsedSuppressionDirective);
  }
  return output.sort(compareDirectives);
}

function sameRecord(left: SuppressionRecord, right: SuppressionRecord): boolean {
  const samePosition = (leftPosition: SourcePosition, rightPosition: SourcePosition): boolean =>
    leftPosition.byteOffset === rightPosition.byteOffset &&
    leftPosition.line === rightPosition.line &&
    leftPosition.utf16Column === rightPosition.utf16Column &&
    leftPosition.utf16Offset === rightPosition.utf16Offset;
  const sameRange = (leftRange: SourceRange, rightRange: SourceRange): boolean =>
    leftRange.sourceId === rightRange.sourceId &&
    samePosition(leftRange.start, rightRange.start) &&
    samePosition(leftRange.end, rightRange.end);
  return (
    left.id === right.id &&
    left.state === "applicable" &&
    right.state === "applicable" &&
    left.directive.sourceId === right.directive.sourceId &&
    left.directive.path === right.directive.path &&
    left.directive.sourceDigest === right.directive.sourceDigest &&
    sameRange(left.directive.range, right.directive.range) &&
    left.reason === right.reason &&
    left.targetRuleIds.length === right.targetRuleIds.length &&
    left.targetRuleIds.every((ruleId, index) => ruleId === right.targetRuleIds[index]) &&
    left.matchedPathFingerprints.length === 0 &&
    right.matchedPathFingerprints.length === 0 &&
    left.evidence.length === 0 &&
    right.evidence.length === 0
  );
}

function ownerIndex(
  directives: readonly ParsedSuppressionDirective[],
): ReadonlyMap<string, ReadonlyMap<number, ReadonlyMap<string, ParsedSuppressionDirective>>> {
  const sources = new Map<string, Map<number, Map<string, ParsedSuppressionDirective>>>();
  for (const directive of directives) {
    const lines =
      sources.get(directive.target.sourceId) ??
      new Map<number, Map<string, ParsedSuppressionDirective>>();
    sources.set(directive.target.sourceId, lines);
    const rules =
      lines.get(directive.target.range.start.line) ?? new Map<string, ParsedSuppressionDirective>();
    lines.set(directive.target.range.start.line, rules);
    for (const ruleId of directive.record.targetRuleIds) {
      if (!rules.has(ruleId)) rules.set(ruleId, directive);
    }
  }
  return sources;
}

/** Resolve matching and unused states without broadening source, rule, range, or profile scope. */
export function matchSuppressionDirectives(
  bundle: unknown,
  directives: unknown,
  sources: readonly SourceDocument[],
): SuppressionMatchResult {
  const parsed = requireIssuedDirectives(directives);
  const validation = validateDiagnosticBundle(bundle, sources);
  if (!validation.ok) {
    return fail("SUPPRESSION_INVALID_BUNDLE", "bundle must satisfy the B04 diagnostic contract");
  }
  if (validation.value.suppressions.length !== parsed.length) {
    return fail(
      "SUPPRESSION_INVALID_OWNERSHIP",
      "bundle suppressions must match parsed directives",
    );
  }
  const records = new Map(validation.value.suppressions.map((record) => [record.id, record]));
  for (const directive of parsed) {
    const record = records.get(directive.record.id);
    if (record === undefined || !sameRecord(record, directive.record)) {
      return fail("SUPPRESSION_INVALID_OWNERSHIP", "bundle contains a forged suppression record");
    }
  }

  const matched = new Map<SuppressionId, DiagnosticFingerprint[]>();
  const suppressedDiagnostics: SuppressedDiagnostic[] = [];
  const visibleDiagnostics: Diagnostic[] = [];
  const owners = ownerIndex(parsed);
  for (const diagnostic of validation.value.diagnostics) {
    const owner = owners
      .get(diagnostic.primary.sourceId)
      ?.get(diagnostic.primary.range.start.line)
      ?.get(diagnostic.ruleId);
    if (owner === undefined) {
      visibleDiagnostics.push(diagnostic);
      continue;
    }
    const fingerprints = matched.get(owner.record.id) ?? [];
    fingerprints.push(diagnostic.fingerprints.path.value);
    matched.set(owner.record.id, fingerprints);
    suppressedDiagnostics.push(frozenRecord({ diagnostic, suppressionId: owner.record.id }));
  }

  const suppressions = parsed.map((directive): SuppressionRecord => {
    const fingerprints = [...new Set(matched.get(directive.record.id) ?? [])].sort(compareUtf8);
    return frozenRecord({
      ...directive.record,
      matchedPathFingerprints: Object.freeze(fingerprints),
      state: fingerprints.length === 0 ? "unused" : "suppressed",
    });
  });
  const outputBundle = frozenRecord({
    ...validation.value,
    diagnostics: Object.freeze([...validation.value.diagnostics]),
    suppressions: Object.freeze(suppressions),
  });
  if (!validateDiagnosticBundle(outputBundle, sources).ok) {
    return fail("SUPPRESSION_INVALID_OUTPUT", "resolved suppression bundle is inconsistent");
  }
  return frozenRecord({
    bundle: outputBundle,
    suppressedDiagnostics: Object.freeze(suppressedDiagnostics),
    visibleDiagnostics: Object.freeze(visibleDiagnostics),
  });
}
