import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { extractMarkdownContent } from "@agent-context/markdown";

import type {
  AstNode,
  AstNodeId,
  ImportReference,
  ImportReferenceId,
  ImportState,
  ImportTargetKind,
  InstructionDocumentId,
  SourceDocumentId,
  SourcePosition,
  SourceRange,
  Uncertainty,
} from "@agent-context/core";
import type { MarkdownExtractionResult } from "@agent-context/markdown";

export const IMPORT_LEXER_CONTRACT_VERSION = "0.1.0" as const;
export const IMPORT_DIALECTS: readonly [
  "claude-code",
  "copilot-cli",
  "cursor-agent",
  "gemini-cli",
] = Object.freeze(["claude-code", "copilot-cli", "cursor-agent", "gemini-cli"]);

export const DEFAULT_IMPORT_LEXER_LIMITS: Readonly<Required<ImportLexerOptions>> = Object.freeze({
  maxImports: 4_096,
  maxSpecifierUtf16CodeUnits: 4_096,
});

const ABSOLUTE_IMPORT_LEXER_LIMITS = DEFAULT_IMPORT_LEXER_LIMITS;
const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const MAX_IDENTIFIER_UTF16_CODE_UNITS = 512;
const KNOWN_UNCERTAINTY = Object.freeze({ state: "known" as const });

export type ImportDialect = (typeof IMPORT_DIALECTS)[number];

export interface ImportLexerInput {
  readonly documentId: InstructionDocumentId;
  readonly sourceId: SourceDocumentId;
  readonly syntax: ImportDialect;
  /** Exact decoded UTF-8 source. No source normalization is performed. */
  readonly text: string;
}

export interface ImportLexerOptions {
  readonly maxImports?: number;
  readonly maxSpecifierUtf16CodeUnits?: number;
}

export interface ImportLexerResult {
  readonly contractVersion: typeof IMPORT_LEXER_CONTRACT_VERSION;
  readonly syntax: ImportDialect;
  /** The exact C06/C08 parse used to exclude or qualify syntax regions. */
  readonly markdown: MarkdownExtractionResult;
  readonly imports: readonly ImportReference[];
}

export type ImportLexerErrorCode =
  "IMPORT_LEXER_INVALID_INPUT" | "IMPORT_LEXER_INVALID_LIMIT" | "IMPORT_LEXER_RESOURCE_LIMIT";

export class ImportLexerError extends Error {
  public readonly code: ImportLexerErrorCode;
  public readonly limitName: keyof Required<ImportLexerOptions> | null;

  public constructor(
    code: ImportLexerErrorCode,
    message: string,
    limitName: keyof Required<ImportLexerOptions> | null = null,
  ) {
    super(message);
    this.name = "ImportLexerError";
    this.code = code;
    this.limitName = limitName;
  }
}

interface ValidatedInput {
  readonly documentId: InstructionDocumentId;
  readonly sourceId: SourceDocumentId;
  readonly syntax: ImportDialect;
  readonly text: string;
}

interface PositionIndex {
  readonly byteOffsets: Float64Array;
  readonly lineStarts: readonly number[];
}

interface DispositionRange {
  readonly start: number;
  readonly end: number;
  readonly disposition: "ambiguous" | "contradiction" | "exclude";
}

interface Candidate {
  readonly start: number;
  readonly specifierStart: number;
  readonly end: number;
  readonly state: ImportState;
  readonly targetKind: ImportTargetKind;
  readonly uncertainty: Uncertainty;
}

interface Classification {
  readonly state: ImportState;
  readonly targetKind: ImportTargetKind;
  readonly uncertainty: Uncertainty;
}

function invalidInput(message: string): never {
  throw new ImportLexerError("IMPORT_LEXER_INVALID_INPUT", message);
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
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return invalidInput(`${name} must have a plain prototype`);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return invalidInput(`${name} properties could not be inspected safely`);
  }
  if (keys.length > allowedKeys.size) return invalidInput(`${name} contains too many fields`);
  for (const key of keys) {
    if (typeof key !== "string") return invalidInput(`${name} symbol keys are not supported`);
    if (!allowedKeys.has(key)) return invalidInput(`${name} contains an unknown field`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as readonly string[]) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor))
        return invalidInput(`${name} must contain only own data properties`);
      output[key] = descriptor.value;
    } catch {
      return invalidInput(`${name} properties could not be inspected safely`);
    }
  }
  return output;
}

function stableIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_UTF16_CODE_UNITS ||
    !STABLE_IDENTIFIER.test(value)
  ) {
    return invalidInput(`${name} must be a bounded B03 stable identifier`);
  }
  return value;
}

function validateInput(value: unknown): ValidatedInput {
  const record = ownDataRecord(
    value,
    "input",
    new Set(["documentId", "sourceId", "syntax", "text"]),
  );
  const syntax = record["syntax"];
  if (typeof syntax !== "string" || !(IMPORT_DIALECTS as readonly string[]).includes(syntax))
    return invalidInput("input.syntax must name a supported import dialect");
  if (typeof record["text"] !== "string") return invalidInput("input.text must be a string");
  return Object.freeze({
    documentId: stableIdentifier(record["documentId"], "input.documentId") as InstructionDocumentId,
    sourceId: stableIdentifier(record["sourceId"], "input.sourceId") as SourceDocumentId,
    syntax: syntax as ImportDialect,
    text: record["text"],
  });
}

function validateLimit(
  value: unknown,
  name: keyof Required<ImportLexerOptions>,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new ImportLexerError(
      "IMPORT_LEXER_INVALID_LIMIT",
      `${name} must be a positive safe integer no greater than ${String(maximum)}`,
      name,
    );
  }
  return value as number;
}

function validateOptions(value: unknown): Readonly<Required<ImportLexerOptions>> {
  if (value === undefined) return DEFAULT_IMPORT_LEXER_LIMITS;
  const record = ownDataRecord(
    value,
    "options",
    new Set(["maxImports", "maxSpecifierUtf16CodeUnits"]),
  );
  return Object.freeze({
    maxImports: validateLimit(
      Object.hasOwn(record, "maxImports")
        ? record["maxImports"]
        : DEFAULT_IMPORT_LEXER_LIMITS.maxImports,
      "maxImports",
      ABSOLUTE_IMPORT_LEXER_LIMITS.maxImports,
    ),
    maxSpecifierUtf16CodeUnits: validateLimit(
      Object.hasOwn(record, "maxSpecifierUtf16CodeUnits")
        ? record["maxSpecifierUtf16CodeUnits"]
        : DEFAULT_IMPORT_LEXER_LIMITS.maxSpecifierUtf16CodeUnits,
      "maxSpecifierUtf16CodeUnits",
      ABSOLUTE_IMPORT_LEXER_LIMITS.maxSpecifierUtf16CodeUnits,
    ),
  });
}

function buildPositionIndex(text: string): PositionIndex {
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
      if (unit === 0x0a || (unit === 0x0d && text.charCodeAt(utf16Offset + 1) !== 0x0a))
        lineStarts.push(utf16Offset + 1);
    }
    byteOffsets[utf16Offset + 1] = byteOffset;
  }
  return Object.freeze({ byteOffsets, lineStarts: Object.freeze(lineStarts) });
}

function positionAt(index: PositionIndex, utf16Offset: number): SourcePosition {
  const byteOffset = index.byteOffsets[utf16Offset];
  if (byteOffset === undefined || byteOffset < 0)
    throw new ImportLexerError(
      "IMPORT_LEXER_INVALID_INPUT",
      "an import boundary splits a Unicode scalar value",
    );
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
  if (lineStart === undefined)
    throw new ImportLexerError("IMPORT_LEXER_INVALID_INPUT", "could not derive source position");
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

function isWhitespace(unit: number): boolean {
  return (
    (unit >= 0x09 && unit <= 0x0d) ||
    unit === 0x20 ||
    unit === 0xa0 ||
    unit === 0x1680 ||
    (unit >= 0x2000 && unit <= 0x200a) ||
    unit === 0x2028 ||
    unit === 0x2029 ||
    unit === 0x202f ||
    unit === 0x205f ||
    unit === 0x3000 ||
    unit === 0xfeff
  );
}

function isAsciiLetter(unit: number): boolean {
  return (unit >= 0x41 && unit <= 0x5a) || (unit >= 0x61 && unit <= 0x7a);
}

function isAsciiDigit(unit: number): boolean {
  return unit >= 0x30 && unit <= 0x39;
}

function isEscaped(text: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && text.charCodeAt(index) === 0x5c; index -= 1)
    slashes += 1;
  return slashes % 2 === 1;
}

function hasTokenBoundary(text: string, offset: number, syntax: ImportDialect): boolean {
  if (offset === 0) return true;
  const previous = text.charCodeAt(offset - 1);
  if (isWhitespace(previous)) return true;
  if (syntax === "cursor-agent" && previous === 0x5c)
    return offset === 1 || isWhitespace(text.charCodeAt(offset - 2));
  if (syntax === "gemini-cli") return false;
  return (
    previous === 0x28 ||
    previous === 0x5b ||
    previous === 0x60 ||
    previous === 0x7b ||
    previous === 0x3c
  );
}

function canStartSpecifier(unit: number, syntax: ImportDialect): boolean {
  if (syntax === "gemini-cli") return unit === 0x2e || unit === 0x2f || isAsciiLetter(unit);
  return (
    unit === 0x2e ||
    unit === 0x2f ||
    unit === 0x5c ||
    unit === 0x7e ||
    isAsciiLetter(unit) ||
    isAsciiDigit(unit) ||
    (syntax === "cursor-agent" && (unit === 0x22 || unit === 0x27))
  );
}

function hasUrlScheme(raw: string): boolean {
  if (!isAsciiLetter(raw.charCodeAt(0))) return false;
  let index = 1;
  while (index < raw.length) {
    const unit = raw.charCodeAt(index);
    if (unit === 0x3a)
      return raw.charCodeAt(index + 1) === 0x2f && raw.charCodeAt(index + 2) === 0x2f;
    if (!(
      isAsciiLetter(unit) ||
      isAsciiDigit(unit) ||
      unit === 0x2b ||
      unit === 0x2d ||
      unit === 0x2e
    ))
      return false;
    index += 1;
  }
  return false;
}

function classifyTarget(raw: string): ImportTargetKind {
  for (let index = 0; index < raw.length; index += 1) {
    const unit = raw.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return "malformed";
    if (unit > 0x7e) return "unknown";
  }
  if (hasUrlScheme(raw)) return "url";
  if (
    raw.startsWith("/") ||
    raw.startsWith("\\\\") ||
    raw.startsWith("~/") ||
    (isAsciiLetter(raw.charCodeAt(0)) && raw.charCodeAt(1) === 0x3a)
  )
    return "absolute-path-candidate";
  if (raw.includes("@") || raw.startsWith('"') || raw.startsWith("'")) return "unknown";
  return "repository-path-candidate";
}

function hasAmbiguousPunctuation(raw: string): boolean {
  const last = raw.charCodeAt(raw.length - 1);
  return (
    last === 0x21 ||
    last === 0x22 ||
    last === 0x27 ||
    last === 0x29 ||
    last === 0x2c ||
    last === 0x3a ||
    last === 0x3b ||
    last === 0x3e ||
    last === 0x3f ||
    last === 0x5d ||
    last === 0x7d
  );
}

function unknown(reason: string): Uncertainty {
  return Object.freeze({ state: "unknown", reason });
}

function contradiction(): Uncertainty {
  return Object.freeze({
    state: "contradiction",
    reason: "Gemini documentation and pinned source disagree about code-region recognition",
    alternatives: Object.freeze([
      Object.freeze({ id: "documented-marked-regions", description: "Treat the region as code" }),
      Object.freeze({ id: "source-matched-backticks", description: "Scan the region for imports" }),
    ]),
  });
}

function classifyCandidate(
  raw: string,
  syntax: ImportDialect,
  ambiguousRegion: boolean,
  contradictoryRegion: boolean,
): Classification {
  const targetKind = classifyTarget(raw);
  if (targetKind === "malformed")
    return Object.freeze({ state: "malformed", targetKind, uncertainty: KNOWN_UNCERTAINTY });
  if (syntax === "cursor-agent")
    return Object.freeze({
      state: "ambiguous",
      targetKind,
      uncertainty: unknown("Cursor does not document exact @ reference tokenization"),
    });
  if (ambiguousRegion)
    return Object.freeze({
      state: "ambiguous",
      targetKind,
      uncertainty: unknown(
        "The selected syntax does not document reference handling in this region",
      ),
    });
  if (contradictoryRegion)
    return Object.freeze({ state: "ambiguous", targetKind, uncertainty: contradiction() });
  if (targetKind === "unknown" || hasAmbiguousPunctuation(raw))
    return Object.freeze({
      state: "ambiguous",
      targetKind,
      uncertainty: unknown("The selected syntax does not define this @ token boundary precisely"),
    });
  if (syntax !== "gemini-cli" && !raw.includes("/") && !raw.includes("\\") && !raw.includes("."))
    return Object.freeze({
      state: "ambiguous",
      targetKind,
      uncertainty: unknown("A bare @ name can be prose or a file reference"),
    });
  return Object.freeze({ state: "recognized", targetKind, uncertainty: KNOWN_UNCERTAINTY });
}

function codeFenceMarker(text: string, node: AstNode): number | null {
  const start = node.range.start.utf16Offset;
  const end = node.range.end.utf16Offset;
  for (let index = start; index < end; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x60 || unit === 0x7e) return unit;
    if (!(unit === 0x20 || unit === 0x09 || unit === 0x3e || unit === 0x2d || isAsciiDigit(unit)))
      return null;
  }
  return null;
}

function regionDisposition(
  text: string,
  node: AstNode,
  syntax: ImportDialect,
): "ambiguous" | "contradiction" | "exclude" | null {
  const code = node.kind === "inline-code" || node.kind === "code-block";
  const comment = node.kind === "html-comment";
  if (!code && !comment) return null;
  if (syntax === "claude-code") return "exclude";
  if (syntax === "gemini-cli") {
    if (node.kind === "inline-code") return "exclude";
    if (node.kind === "code-block")
      return codeFenceMarker(text, node) === 0x60 ? "exclude" : "contradiction";
    return null;
  }
  return "ambiguous";
}

function buildDispositionRanges(
  text: string,
  nodes: readonly AstNode[],
  syntax: ImportDialect,
): readonly DispositionRange[] {
  const ranges: DispositionRange[] = [];
  for (const node of nodes) {
    const disposition = regionDisposition(text, node, syntax);
    if (disposition !== null)
      ranges.push(
        Object.freeze({
          start: node.range.start.utf16Offset,
          end: node.range.end.utf16Offset,
          disposition,
        }),
      );
  }
  return Object.freeze(ranges);
}

function containingDisposition(
  ranges: readonly DispositionRange[],
  start: number,
): "ambiguous" | "contradiction" | "exclude" | null {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (range !== undefined && range.start <= start) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low - 1];
  return range !== undefined && range.start <= start && range.end > start
    ? range.disposition
    : null;
}

function nodeMap(nodes: readonly AstNode[]): ReadonlyMap<AstNodeId, AstNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function deepestContainingNode(
  rootNodeId: AstNodeId,
  nodes: ReadonlyMap<AstNodeId, AstNode>,
  start: number,
  end: number,
): AstNode {
  const root = nodes.get(rootNodeId);
  if (root === undefined)
    throw new ImportLexerError("IMPORT_LEXER_INVALID_INPUT", "Markdown root node is unavailable");
  let current = root;
  while (current.childIds.length > 0) {
    let low = 0;
    let high = current.childIds.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const childId = current.childIds[middle];
      const child = childId === undefined ? undefined : nodes.get(childId);
      if (child !== undefined && child.range.start.utf16Offset <= start) low = middle + 1;
      else high = middle;
    }
    const childId = current.childIds[low - 1];
    const child = childId === undefined ? undefined : nodes.get(childId);
    if (
      child === undefined ||
      child.range.start.utf16Offset > start ||
      child.range.end.utf16Offset < end
    )
      break;
    current = child;
  }
  return current;
}

function scanCandidates(
  input: ValidatedInput,
  markdown: MarkdownExtractionResult,
  limits: Readonly<Required<ImportLexerOptions>>,
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  const dispositionRanges = buildDispositionRanges(input.text, markdown.nodes, input.syntax);
  for (let index = 0; index < input.text.length; index += 1) {
    if (input.text.charCodeAt(index) !== 0x40 || !hasTokenBoundary(input.text, index, input.syntax))
      continue;
    const escaped = isEscaped(input.text, index);
    if (escaped && input.syntax !== "cursor-agent") continue;
    const specifierStart = index + 1;
    const first = input.text.charCodeAt(specifierStart);
    if (!canStartSpecifier(first, input.syntax)) continue;
    let end = specifierStart;
    while (end < input.text.length && !isWhitespace(input.text.charCodeAt(end))) {
      if (end - specifierStart >= limits.maxSpecifierUtf16CodeUnits)
        throw new ImportLexerError(
          "IMPORT_LEXER_RESOURCE_LIMIT",
          `import specifier exceeds maxSpecifierUtf16CodeUnits (${String(limits.maxSpecifierUtf16CodeUnits)})`,
          "maxSpecifierUtf16CodeUnits",
        );
      end += 1;
    }
    const disposition = containingDisposition(dispositionRanges, index);
    if (disposition === "exclude") {
      index = end - 1;
      continue;
    }
    if (candidates.length >= limits.maxImports)
      throw new ImportLexerError(
        "IMPORT_LEXER_RESOURCE_LIMIT",
        `emitted import candidate count exceeds maxImports (${String(limits.maxImports)})`,
        "maxImports",
      );
    const raw = input.text.slice(specifierStart, end);
    const classified = classifyCandidate(
      raw,
      input.syntax,
      escaped || disposition === "ambiguous",
      disposition === "contradiction",
    );
    candidates.push(
      Object.freeze({
        start: index,
        specifierStart,
        end,
        state: classified.state,
        targetKind: classified.targetKind,
        uncertainty: classified.uncertainty,
      }),
    );
    index = end - 1;
  }
  return Object.freeze(candidates);
}

/**
 * Lex vendor @ references without loading or resolving any target.
 *
 * The function is synchronous, deterministic, model-free, and has no filesystem, process, or
 * network capability. C10 owns repository containment, graph traversal, target reads, and cycles.
 */
export function lexImportReferences(
  inputValue: ImportLexerInput,
  optionsValue?: ImportLexerOptions,
): ImportLexerResult {
  const input = validateInput(inputValue);
  const limits = validateOptions(optionsValue);
  const markdown = extractMarkdownContent({ sourceId: input.sourceId, text: input.text });
  const positions = buildPositionIndex(input.text);
  const candidates = scanCandidates(input, markdown, limits);
  const nodes = nodeMap(markdown.nodes);
  const identity = createHash("sha256")
    .update(input.documentId, "utf8")
    .update("\0", "utf8")
    .update(input.syntax, "utf8")
    .update("\0", "utf8")
    .update(input.sourceId, "utf8")
    .update("\0", "utf8")
    .update(input.text, "utf8")
    .digest("hex");
  const imports = candidates.map((candidate, index) => {
    const owner = deepestContainingNode(markdown.rootNodeId, nodes, candidate.start, candidate.end);
    return Object.freeze({
      id: `import:${identity}:${index.toString(36).padStart(3, "0")}` as ImportReferenceId,
      documentId: input.documentId,
      nodeId: owner.id,
      kind: input.syntax === "cursor-agent" ? "reference-token" : "vendor-import",
      range: makeRange(input.sourceId, positions, candidate.start, candidate.end),
      specifierRange: makeRange(input.sourceId, positions, candidate.specifierStart, candidate.end),
      rawSpecifier: input.text.slice(candidate.specifierStart, candidate.end),
      targetKind: candidate.targetKind,
      state: candidate.state,
      uncertainty: candidate.uncertainty,
    } satisfies ImportReference);
  });
  return Object.freeze({
    contractVersion: IMPORT_LEXER_CONTRACT_VERSION,
    syntax: input.syntax,
    markdown,
    imports: Object.freeze(imports),
  });
}
