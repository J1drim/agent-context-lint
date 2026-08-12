import { types as nodeTypes } from "node:util";

import type {
  ImportReference,
  InstructionDocumentId,
  SourceDocumentId,
  SourceRange,
} from "@agent-context/core";

import { lexImportReferences } from "./import-lexer.js";
import { parseFrontmatter, type FrontmatterLocation } from "./frontmatter-parser.js";

export const CLAUDE_INSTRUCTION_SYNTAX_CONTRACT_VERSION = "0.1.0" as const;
export const CLAUDE_INSTRUCTION_FORMATS = ["memory", "project-rule"] as const;
export const CLAUDE_INSTRUCTION_MAX_BYTES = 262_144 as const;

export type ClaudeInstructionFormat = (typeof CLAUDE_INSTRUCTION_FORMATS)[number];

export interface ClaudeInstructionSyntaxInput {
  readonly bytes: Uint8Array;
  readonly documentId: InstructionDocumentId;
  readonly format: ClaudeInstructionFormat;
  readonly sourceId: SourceDocumentId;
}

export interface ClaudePathsField {
  readonly range: SourceRange | null;
  readonly state: "absent" | "invalid" | "valid";
  readonly value: readonly string[] | null;
}

export type ClaudeInstructionSyntaxIssueCode =
  | "frontmatter-invalid"
  | "invalid-field-type"
  | "invalid-utf8"
  | "markdown-partial"
  | "resource-limit"
  | "unknown-field";

export interface ClaudeInstructionSyntaxIssue {
  readonly code: ClaudeInstructionSyntaxIssueCode;
  readonly field: string | null;
  readonly message: string;
  readonly range: SourceRange | null;
}

export interface ClaudeInstructionSyntaxResult {
  readonly bodyRange: SourceRange | null;
  readonly commentRanges: readonly SourceRange[];
  readonly contractVersion: typeof CLAUDE_INSTRUCTION_SYNTAX_CONTRACT_VERSION;
  readonly documentId: InstructionDocumentId;
  readonly format: ClaudeInstructionFormat;
  readonly imports: readonly ImportReference[];
  readonly issues: readonly ClaudeInstructionSyntaxIssue[];
  readonly paths: ClaudePathsField;
  readonly scopeAuthority: "available" | "denied" | "not-applicable";
  readonly sourceId: SourceDocumentId;
  readonly state: "complete" | "malformed" | "partial";
  /** Exact decoded source, or null when UTF-8 cannot be decoded safely. */
  readonly text: string | null;
  /** Instruction body after removing frontmatter and block HTML comments outside code. */
  readonly transformedBody: string | null;
}

export const ClaudeInstructionSyntaxErrorCode: Readonly<{
  invalidInput: "CLAUDE_INSTRUCTION_SYNTAX_INVALID_INPUT";
  resourceLimit: "CLAUDE_INSTRUCTION_SYNTAX_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "CLAUDE_INSTRUCTION_SYNTAX_INVALID_INPUT",
  resourceLimit: "CLAUDE_INSTRUCTION_SYNTAX_RESOURCE_LIMIT",
} as const);

export type ClaudeInstructionSyntaxErrorCode =
  (typeof ClaudeInstructionSyntaxErrorCode)[keyof typeof ClaudeInstructionSyntaxErrorCode];

export class ClaudeInstructionSyntaxError extends Error {
  override readonly name = "ClaudeInstructionSyntaxError" as const;
  readonly code: ClaudeInstructionSyntaxErrorCode;

  constructor(code: ClaudeInstructionSyntaxErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

const INPUT_KEYS = Object.freeze(["bytes", "documentId", "format", "sourceId"]);
const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_PATH_PATTERNS = 1_000;
const MAX_PATTERN_LENGTH = 4_096;
const MAX_TOTAL_PATTERN_LENGTH = 65_536;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(code: ClaudeInstructionSyntaxErrorCode, message: string): never {
  throw new ClaudeInstructionSyntaxError(code, message);
}

function record(value: unknown): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail(ClaudeInstructionSyntaxErrorCode.invalidInput, "input must be a plain data record");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== INPUT_KEYS.length ||
    keys.some((key) => typeof key !== "string" || !INPUT_KEYS.includes(key))
  )
    return fail(ClaudeInstructionSyntaxErrorCode.invalidInput, "input must be closed");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        ClaudeInstructionSyntaxErrorCode.invalidInput,
        "input must contain enumerable data properties",
      );
  }
  return value as DataRecord;
}

function property(value: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER.test(value)
  )
    return fail(
      ClaudeInstructionSyntaxErrorCode.invalidInput,
      `${label} must be a bounded stable identifier`,
    );
  return value;
}

function bytes(value: unknown): Uint8Array {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  )
    return fail(
      ClaudeInstructionSyntaxErrorCode.invalidInput,
      "bytes must be an intrinsic Uint8Array",
    );
  const input = value as Uint8Array;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== input.length)
    return fail(ClaudeInstructionSyntaxErrorCode.invalidInput, "bytes must not have extra fields");
  for (let index = 0; index < input.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      keys[index] !== key ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return fail(
        ClaudeInstructionSyntaxErrorCode.invalidInput,
        "bytes must use canonical data indices",
      );
  }
  if (input.byteLength > CLAUDE_INSTRUCTION_MAX_BYTES)
    return fail(
      ClaudeInstructionSyntaxErrorCode.resourceLimit,
      "Claude instruction exceeds its byte limit",
    );
  return Uint8Array.prototype.slice.call(input);
}

function issue(
  code: ClaudeInstructionSyntaxIssueCode,
  field: string | null,
  message: string,
  range: SourceRange | null,
): ClaudeInstructionSyntaxIssue {
  return Object.freeze({ code, field, message, range });
}

function fieldRange(locations: readonly FrontmatterLocation[], field: string): SourceRange | null {
  return locations.find((entry) => entry.path === `$/${field}`)?.valueRange ?? null;
}

function pathsField(
  value: unknown,
  locations: readonly FrontmatterLocation[],
  issues: ClaudeInstructionSyntaxIssue[],
): ClaudePathsField {
  const range = fieldRange(locations, "paths");
  if (value === undefined) return Object.freeze({ range: null, state: "absent", value: null });
  const values = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > MAX_PATH_PATTERNS ||
    values.some(
      (entry) =>
        typeof entry !== "string" || entry.length === 0 || entry.length > MAX_PATTERN_LENGTH,
    ) ||
    values.reduce(
      (sum: number, entry: unknown): number => sum + (typeof entry === "string" ? entry.length : 0),
      0,
    ) > MAX_TOTAL_PATTERN_LENGTH ||
    new Set(values).size !== values.length
  ) {
    issues.push(
      issue(
        "invalid-field-type",
        "paths",
        "paths must be one string or a bounded non-empty array of unique strings",
        range,
      ),
    );
    return Object.freeze({ range, state: "invalid", value: null });
  }
  return Object.freeze({
    range,
    state: "valid",
    value: Object.freeze([...(values as readonly string[])]),
  });
}

function transformed(
  text: string,
  bodyRange: SourceRange | null,
  commentRanges: readonly SourceRange[],
): string | null {
  if (bodyRange === null) return null;
  let output = "";
  let cursor = bodyRange.start.utf16Offset;
  for (const range of commentRanges) {
    const start = Math.max(cursor, range.start.utf16Offset);
    output += text.slice(cursor, start);
    cursor = Math.min(bodyRange.end.utf16Offset, range.end.utf16Offset);
  }
  output += text.slice(cursor, bodyRange.end.utf16Offset);
  return output;
}

function malformedResult(
  input: ClaudeInstructionSyntaxInput,
  issueValue: ClaudeInstructionSyntaxIssue,
): ClaudeInstructionSyntaxResult {
  return Object.freeze({
    bodyRange: null,
    commentRanges: Object.freeze([]),
    contractVersion: CLAUDE_INSTRUCTION_SYNTAX_CONTRACT_VERSION,
    documentId: input.documentId,
    format: input.format,
    imports: Object.freeze([]),
    issues: Object.freeze([issueValue]),
    paths: Object.freeze({ range: null, state: "invalid", value: null }),
    scopeAuthority: input.format === "memory" ? "not-applicable" : "denied",
    sourceId: input.sourceId,
    state: "malformed",
    text: null,
    transformedBody: null,
  });
}

/** Parse Claude memory or project-rule syntax without resolving filesystem or runtime state. */
export function parseClaudeInstructionSyntax(rawInput: unknown): ClaudeInstructionSyntaxResult {
  const raw = record(rawInput);
  const format = property(raw, "format");
  if (!CLAUDE_INSTRUCTION_FORMATS.includes(format as ClaudeInstructionFormat))
    return fail(ClaudeInstructionSyntaxErrorCode.invalidInput, "format is unsupported");
  const input: ClaudeInstructionSyntaxInput = Object.freeze({
    bytes: bytes(property(raw, "bytes")),
    documentId: identifier(property(raw, "documentId"), "documentId") as InstructionDocumentId,
    format: format as ClaudeInstructionFormat,
    sourceId: identifier(property(raw, "sourceId"), "sourceId") as SourceDocumentId,
  });
  let text: string;
  try {
    text = UTF8.decode(input.bytes);
  } catch {
    return malformedResult(
      input,
      issue("invalid-utf8", null, "Claude instruction UTF-8 is malformed", null),
    );
  }

  const frontmatter =
    input.format === "project-rule"
      ? parseFrontmatter({ bytes: input.bytes, dialect: "yaml", sourceId: input.sourceId })
      : null;
  const issues: ClaudeInstructionSyntaxIssue[] = [];
  if (frontmatter !== null) {
    for (const entry of frontmatter.issues) {
      issues.push(
        issue(
          entry.code === "resource-limit" ? "resource-limit" : "frontmatter-invalid",
          null,
          "Claude rule frontmatter is not safely parseable",
          entry.range,
        ),
      );
    }
    if (frontmatter.value !== null) {
      for (const key of Object.keys(frontmatter.value).sort()) {
        if (key !== "paths")
          issues.push(
            issue(
              "unknown-field",
              key,
              "frontmatter field is not documented for Claude project rules",
              fieldRange(frontmatter.locations, key),
            ),
          );
      }
    }
  }
  const paths =
    frontmatter === null
      ? Object.freeze({ range: null, state: "absent" as const, value: null })
      : pathsField(frontmatter.value?.["paths"], frontmatter.locations, issues);
  const importResult = lexImportReferences({
    documentId: input.documentId,
    sourceId: input.sourceId,
    syntax: "claude-code",
    text,
  });
  const root = importResult.markdown.nodes.find(
    (node) => node.id === importResult.markdown.rootNodeId,
  );
  const bodyRange = frontmatter?.bodyRange ?? root?.range ?? null;
  const comments = Object.freeze(
    importResult.markdown.nodes
      .filter(
        (node) =>
          node.kind === "html-comment" &&
          bodyRange !== null &&
          node.range.start.utf16Offset >= bodyRange.start.utf16Offset &&
          node.range.end.utf16Offset <= bodyRange.end.utf16Offset,
      )
      .map((node) => node.range),
  );
  if (importResult.markdown.parseState.state !== "complete")
    issues.push(
      issue(
        "markdown-partial",
        null,
        "Claude instruction Markdown was parsed only partially",
        root?.range ?? null,
      ),
    );
  const imports = Object.freeze(
    importResult.imports.filter(
      (entry) =>
        bodyRange !== null &&
        entry.range.start.utf16Offset >= bodyRange.start.utf16Offset &&
        entry.range.end.utf16Offset <= bodyRange.end.utf16Offset,
    ),
  );
  const malformed = frontmatter?.state === "invalid" || paths.state === "invalid";
  return Object.freeze({
    bodyRange,
    commentRanges: comments,
    contractVersion: CLAUDE_INSTRUCTION_SYNTAX_CONTRACT_VERSION,
    documentId: input.documentId,
    format: input.format,
    imports,
    issues: Object.freeze(issues),
    paths,
    scopeAuthority:
      input.format === "memory" ? "not-applicable" : malformed ? "denied" : "available",
    sourceId: input.sourceId,
    state: malformed ? "malformed" : issues.length === 0 ? "complete" : "partial",
    text,
    transformedBody: transformed(text, bodyRange, comments),
  });
}
