import { types as nodeTypes, TextDecoder } from "node:util";

import {
  isRepositoryRelativePath,
  type ImportReference,
  type InstructionDocumentId,
  type RepositoryRelativePath,
  type SourceDocumentId,
  type SourcePosition,
  type SourceRange,
} from "@agent-context/core";

import {
  DEFAULT_FRONTMATTER_LIMITS,
  parseFrontmatter,
  type FrontmatterIssue,
  type FrontmatterLocation,
  type FrontmatterParseResult,
} from "./frontmatter-parser.js";
import { ImportLexerError, lexImportReferences } from "./import-lexer.js";

export const CURSOR_RULE_SYNTAX_CONTRACT_VERSION = "0.1.0" as const;
export const CURSOR_RULE_FORMATS: readonly ["mdc", "legacy"] = Object.freeze(["mdc", "legacy"]);
export const CURSOR_RULE_SYNTAX_LIMITS: Readonly<{
  maxDescriptionUtf16CodeUnits: number;
  maxGlobAggregateUtf16CodeUnits: number;
  maxGlobPatterns: number;
  maxGlobUtf16CodeUnits: number;
  maxPathUtf8Bytes: number;
}> = Object.freeze({
  maxDescriptionUtf16CodeUnits: 4_096,
  maxGlobAggregateUtf16CodeUnits: 32_768,
  maxGlobPatterns: 1_024,
  maxGlobUtf16CodeUnits: 4_096,
  maxPathUtf8Bytes: 16_384,
});

export type CursorRuleFormat = (typeof CURSOR_RULE_FORMATS)[number];
export type CursorRuleFieldState = "absent" | "empty" | "invalid" | "valid";
export type CursorRuleModeClassification =
  | "agent-requested"
  | "always"
  | "auto-attached"
  | "legacy"
  | "manual"
  | "malformed"
  | "mixed"
  | "unknown";
export type CursorRuleModeState =
  "conditional" | "invalid" | "known-syntax" | "not-applicable" | "unknown";

export interface CursorRuleSyntaxInput {
  readonly bytes: Uint8Array;
  readonly documentId: InstructionDocumentId;
  readonly format: CursorRuleFormat;
  readonly path: RepositoryRelativePath;
  readonly sourceId: SourceDocumentId;
}

export interface CursorRuleField<T> {
  readonly keyRange: SourceRange | null;
  readonly range: SourceRange | null;
  readonly state: CursorRuleFieldState;
  /** Empty strings are retained; invalid and absent values are null. */
  readonly value: T | null;
}

export interface CursorGlobPattern {
  readonly range: SourceRange | null;
  readonly value: string;
}

export interface CursorGlobValue {
  readonly encoding: "comma-scalar" | "scalar" | "yaml-list";
  readonly patterns: readonly CursorGlobPattern[];
}

export interface CursorRuleModeSyntax {
  readonly canonical: boolean;
  readonly classification: CursorRuleModeClassification;
  readonly evidenceIds: readonly string[];
  readonly state: CursorRuleModeState;
}

export interface CursorRuleSourceLocation {
  readonly path: RepositoryRelativePath;
  readonly ruleRoot: RepositoryRelativePath | null;
  readonly scopeRoot: RepositoryRelativePath | null;
  readonly state: "supported" | "unknown" | "unsupported";
}

export type CursorRuleSyntaxIssueCode =
  | "empty-body"
  | "empty-field"
  | "frontmatter-invalid"
  | "frontmatter-required"
  | "invalid-field-type"
  | "invalid-location"
  | "legacy-format"
  | "markdown-partial"
  | "mode-uncertain"
  | "reference-resource-limit"
  | "resource-limit"
  | "unknown-field";

export interface CursorRuleSyntaxIssue {
  readonly code: CursorRuleSyntaxIssueCode;
  readonly evidenceIds: readonly string[];
  readonly field: string | null;
  readonly message: string;
  readonly range: SourceRange | null;
  readonly severity: "error" | "warning";
}

export interface CursorRuleSyntaxResult {
  readonly alwaysApply: CursorRuleField<boolean>;
  readonly bodyRange: SourceRange | null;
  readonly contractVersion: typeof CURSOR_RULE_SYNTAX_CONTRACT_VERSION;
  readonly description: CursorRuleField<string>;
  readonly documentId: InstructionDocumentId;
  readonly format: CursorRuleFormat;
  readonly frontmatterRange: SourceRange | null;
  readonly globs: CursorRuleField<CursorGlobValue>;
  readonly issues: readonly CursorRuleSyntaxIssue[];
  readonly location: CursorRuleSourceLocation;
  readonly metadataAuthority: "available" | "denied" | "not-applicable";
  readonly modeSyntax: CursorRuleModeSyntax;
  readonly references: readonly ImportReference[];
  readonly sourceId: SourceDocumentId;
  readonly sourceRange: SourceRange | null;
  readonly state: "complete" | "malformed" | "partial";
  readonly text: string | null;
}

export const CursorRuleSyntaxErrorCode: Readonly<{
  invalidInput: "CURSOR_RULE_SYNTAX_INVALID_INPUT";
  resourceLimit: "CURSOR_RULE_SYNTAX_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "CURSOR_RULE_SYNTAX_INVALID_INPUT",
  resourceLimit: "CURSOR_RULE_SYNTAX_RESOURCE_LIMIT",
} as const);

export type CursorRuleSyntaxErrorCode =
  (typeof CursorRuleSyntaxErrorCode)[keyof typeof CursorRuleSyntaxErrorCode];

export class CursorRuleSyntaxError extends Error {
  override readonly name = "CursorRuleSyntaxError" as const;
  readonly code: CursorRuleSyntaxErrorCode;

  constructor(code: CursorRuleSyntaxErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;
type MutableIssue = CursorRuleSyntaxIssue;

const INPUT_KEYS = Object.freeze(["bytes", "documentId", "format", "path", "sourceId"]);
const KNOWN_FIELDS = new Set(["alwaysApply", "description", "globs"]);
const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const MAX_IDENTIFIER_UTF16_CODE_UNITS = 512;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

function fail(code: CursorRuleSyntaxErrorCode, message: string): never {
  throw new CursorRuleSyntaxError(code, message);
}

function inputRecord(value: unknown): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    return fail(CursorRuleSyntaxErrorCode.invalidInput, "Cursor rule input must be a plain record");
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return fail(CursorRuleSyntaxErrorCode.invalidInput, "Cursor rule input cannot be inspected");
  }
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== INPUT_KEYS.length) {
    return fail(CursorRuleSyntaxErrorCode.invalidInput, "Cursor rule input must be closed");
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || !INPUT_KEYS.includes(key)) {
      return fail(CursorRuleSyntaxErrorCode.invalidInput, "Cursor rule input has an unknown field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(
        CursorRuleSyntaxErrorCode.invalidInput,
        "Cursor rule input must contain enumerable data properties",
      );
    }
    output[key] = descriptor.value;
  }
  return output;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_UTF16_CODE_UNITS ||
    !STABLE_IDENTIFIER.test(value)
  ) {
    return fail(
      CursorRuleSyntaxErrorCode.invalidInput,
      `${label} must be a bounded stable identifier`,
    );
  }
  return value;
}

function snapshotBytes(value: unknown): Uint8Array {
  if (!nodeTypes.isUint8Array(value) || nodeTypes.isProxy(value)) {
    return fail(
      CursorRuleSyntaxErrorCode.invalidInput,
      "Cursor rule bytes must be an intrinsic Uint8Array",
    );
  }
  if (TYPED_ARRAY_BYTE_LENGTH === undefined) {
    return fail(CursorRuleSyntaxErrorCode.invalidInput, "Uint8Array intrinsics are unavailable");
  }
  let byteLength: number;
  try {
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as number;
  } catch {
    return fail(CursorRuleSyntaxErrorCode.invalidInput, "Cursor rule bytes cannot be inspected");
  }
  if (byteLength > DEFAULT_FRONTMATTER_LIMITS.maxSourceBytes) {
    return fail(
      CursorRuleSyntaxErrorCode.resourceLimit,
      `Cursor rule bytes exceed ${String(DEFAULT_FRONTMATTER_LIMITS.maxSourceBytes)} bytes`,
    );
  }
  const snapshot = new Uint8Array(byteLength);
  try {
    Reflect.apply(UINT8_ARRAY_SET, snapshot, [value]);
  } catch {
    return fail(CursorRuleSyntaxErrorCode.invalidInput, "Cursor rule bytes cannot be copied");
  }
  return snapshot;
}

function pathValue(value: unknown): RepositoryRelativePath {
  if (typeof value !== "string" || value === "." || !isRepositoryRelativePath(value)) {
    return fail(
      CursorRuleSyntaxErrorCode.invalidInput,
      "Cursor rule path must be a canonical repository file path",
    );
  }
  if (Buffer.byteLength(value, "utf8") > CURSOR_RULE_SYNTAX_LIMITS.maxPathUtf8Bytes) {
    return fail(CursorRuleSyntaxErrorCode.resourceLimit, "Cursor rule path exceeds its byte limit");
  }
  return value;
}

function validateInput(value: unknown): Readonly<CursorRuleSyntaxInput> {
  const record = inputRecord(value);
  const format = record["format"];
  if (typeof format !== "string" || !(CURSOR_RULE_FORMATS as readonly string[]).includes(format)) {
    return fail(CursorRuleSyntaxErrorCode.invalidInput, "Cursor rule format must be mdc or legacy");
  }
  return Object.freeze({
    bytes: snapshotBytes(record["bytes"]),
    documentId: identifier(record["documentId"], "Cursor rule documentId") as InstructionDocumentId,
    format: format as CursorRuleFormat,
    path: pathValue(record["path"]),
    sourceId: identifier(record["sourceId"], "Cursor rule sourceId") as SourceDocumentId,
  });
}

function issue(
  code: CursorRuleSyntaxIssueCode,
  severity: "error" | "warning",
  field: string | null,
  message: string,
  range: SourceRange | null,
  evidenceIds: readonly string[],
): CursorRuleSyntaxIssue {
  return Object.freeze({
    code,
    evidenceIds: Object.freeze([...evidenceIds]),
    field,
    message,
    range,
    severity,
  });
}

function locationAt(
  locations: readonly FrontmatterLocation[],
  path: string,
): FrontmatterLocation | undefined {
  return locations.find((location) => location.path === path);
}

function field<T>(
  state: CursorRuleFieldState,
  location: FrontmatterLocation | undefined,
  value: T | null,
): CursorRuleField<T> {
  return Object.freeze({
    keyRange: location?.keyRange ?? null,
    range: location?.valueRange ?? null,
    state,
    value,
  });
}

function absentField<T>(): CursorRuleField<T> {
  return field<T>("absent", undefined, null);
}

function frontmatterIssue(value: FrontmatterIssue): CursorRuleSyntaxIssue {
  const evidenceId =
    value.code === "unclosed-frontmatter"
      ? "CURSOR-MDC-08"
      : value.code === "duplicate-key"
        ? "CURSOR-MDC-10"
        : value.code === "resource-limit" ||
            value.code === "invalid-encoding" ||
            value.code === "bom-forbidden"
          ? "CURSOR-MDC-15"
          : "CURSOR-MDC-07";
  return issue(
    value.code === "resource-limit" ? "resource-limit" : "frontmatter-invalid",
    "error",
    null,
    "Cursor MDC frontmatter is not safely parseable.",
    value.range,
    [evidenceId],
  );
}

function parseDescription(
  root: Readonly<Record<string, unknown>>,
  locations: readonly FrontmatterLocation[],
  issues: MutableIssue[],
): CursorRuleField<string> {
  if (!Object.hasOwn(root, "description")) return absentField();
  const location = locationAt(locations, "$/description");
  const value = root["description"];
  if (value === null || (typeof value === "string" && value.trim().length === 0)) {
    issues.push(
      issue(
        "empty-field",
        "warning",
        "description",
        "Empty description is retained and treated as an absent syntax signal.",
        location?.valueRange ?? null,
        ["CURSOR-MDC-12"],
      ),
    );
    return field("empty", location, typeof value === "string" ? value : "");
  }
  if (
    typeof value !== "string" ||
    value.length > CURSOR_RULE_SYNTAX_LIMITS.maxDescriptionUtf16CodeUnits
  ) {
    issues.push(
      issue(
        typeof value === "string" ? "resource-limit" : "invalid-field-type",
        "error",
        "description",
        "description must be a bounded string.",
        location?.valueRange ?? null,
        ["CURSOR-MDC-03"],
      ),
    );
    return field<string>("invalid", location, null);
  }
  return field("valid", location, value);
}

function parseAlwaysApply(
  root: Readonly<Record<string, unknown>>,
  locations: readonly FrontmatterLocation[],
  issues: MutableIssue[],
): CursorRuleField<boolean> {
  if (!Object.hasOwn(root, "alwaysApply")) return absentField();
  const location = locationAt(locations, "$/alwaysApply");
  const value = root["alwaysApply"];
  if (typeof value !== "boolean") {
    issues.push(
      issue(
        "invalid-field-type",
        "error",
        "alwaysApply",
        "alwaysApply must be a boolean.",
        location?.valueRange ?? null,
        ["CURSOR-MDC-11"],
      ),
    );
    return field<boolean>("invalid", location, null);
  }
  return field("valid", location, value);
}

type PatternSplit =
  | { readonly issue: "empty" | "limit"; readonly patterns: null }
  | { readonly issue: null; readonly patterns: readonly string[] };

function splitScalarPatterns(value: string): PatternSplit {
  if (value.length > CURSOR_RULE_SYNTAX_LIMITS.maxGlobAggregateUtf16CodeUnits) {
    return Object.freeze({ issue: "limit", patterns: null });
  }
  const patterns: string[] = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (braceDepth > 64 || bracketDepth > 64) {
      return Object.freeze({ issue: "limit", patterns: null });
    }
    if ((character === "," && braceDepth === 0 && bracketDepth === 0) || index === value.length) {
      const pattern = value.slice(start, index).trim();
      if (pattern.length === 0) return Object.freeze({ issue: "empty", patterns: null });
      if (
        pattern.length > CURSOR_RULE_SYNTAX_LIMITS.maxGlobUtf16CodeUnits ||
        patterns.length >= CURSOR_RULE_SYNTAX_LIMITS.maxGlobPatterns
      ) {
        return Object.freeze({ issue: "limit", patterns: null });
      }
      patterns.push(pattern);
      start = index + 1;
    }
  }
  return Object.freeze({ issue: null, patterns: Object.freeze(patterns) });
}

function globFailure(
  code: "empty-field" | "invalid-field-type" | "resource-limit",
  location: FrontmatterLocation | undefined,
  issues: MutableIssue[],
): CursorRuleField<CursorGlobValue> {
  issues.push(
    issue(
      code,
      code === "empty-field" ? "warning" : "error",
      "globs",
      code === "empty-field"
        ? "Empty globs are retained and treated as an absent syntax signal."
        : "globs must be a bounded string or list of non-empty strings.",
      location?.valueRange ?? null,
      [code === "empty-field" ? "CURSOR-MDC-13" : "CURSOR-MDC-04"],
    ),
  );
  return field<CursorGlobValue>(code === "empty-field" ? "empty" : "invalid", location, null);
}

function parseGlobs(
  root: Readonly<Record<string, unknown>>,
  locations: readonly FrontmatterLocation[],
  issues: MutableIssue[],
): CursorRuleField<CursorGlobValue> {
  if (!Object.hasOwn(root, "globs")) return absentField();
  const location = locationAt(locations, "$/globs");
  const value = root["globs"];
  if (value === null || (typeof value === "string" && value.trim().length === 0)) {
    return globFailure("empty-field", location, issues);
  }
  if (typeof value === "string") {
    const split = splitScalarPatterns(value);
    if (split.patterns === null) {
      return globFailure(
        split.issue === "limit" ? "resource-limit" : "empty-field",
        location,
        issues,
      );
    }
    const encoding = split.patterns.length > 1 ? "comma-scalar" : "scalar";
    const globValue: CursorGlobValue = Object.freeze({
      encoding,
      patterns: Object.freeze(
        split.patterns.map((pattern) => Object.freeze({ range: null, value: pattern })),
      ),
    });
    return field("valid", location, globValue);
  }
  if (!Array.isArray(value)) return globFailure("invalid-field-type", location, issues);
  if (value.length === 0) return globFailure("empty-field", location, issues);
  if (value.length > CURSOR_RULE_SYNTAX_LIMITS.maxGlobPatterns) {
    return globFailure("resource-limit", location, issues);
  }
  let aggregate = 0;
  const patterns: CursorGlobPattern[] = [];
  for (const [index, candidate] of value.entries()) {
    const itemLocation = locationAt(locations, `$/globs/${String(index)}`);
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      return globFailure("invalid-field-type", itemLocation ?? location, issues);
    }
    const normalized = candidate.trim();
    aggregate += normalized.length;
    if (
      normalized.length > CURSOR_RULE_SYNTAX_LIMITS.maxGlobUtf16CodeUnits ||
      aggregate > CURSOR_RULE_SYNTAX_LIMITS.maxGlobAggregateUtf16CodeUnits
    ) {
      return globFailure("resource-limit", itemLocation ?? location, issues);
    }
    patterns.push(Object.freeze({ range: itemLocation?.valueRange ?? null, value: normalized }));
  }
  return field(
    "valid",
    location,
    Object.freeze({ encoding: "yaml-list", patterns: Object.freeze(patterns) }),
  );
}

function mode(
  classification: CursorRuleModeClassification,
  state: CursorRuleModeState,
  canonical: boolean,
  evidenceIds: readonly string[],
): CursorRuleModeSyntax {
  return Object.freeze({
    canonical,
    classification,
    evidenceIds: Object.freeze([...evidenceIds]),
    state,
  });
}

function classifyMode(
  alwaysApply: CursorRuleField<boolean>,
  description: CursorRuleField<string>,
  globs: CursorRuleField<CursorGlobValue>,
  issues: MutableIssue[],
): CursorRuleModeSyntax {
  if (
    alwaysApply.state === "invalid" ||
    description.state === "invalid" ||
    globs.state === "invalid"
  ) {
    return mode("malformed", "invalid", false, ["CURSOR-MDC-11"]);
  }
  const hasDescription = description.state === "valid";
  const hasGlobs = globs.state === "valid";
  if (alwaysApply.state === "absent") {
    const evidenceId = hasGlobs
      ? "CURSOR-MODE-09"
      : hasDescription
        ? "CURSOR-MODE-10"
        : "CURSOR-MODE-08";
    issues.push(
      issue(
        "mode-uncertain",
        "warning",
        "alwaysApply",
        "Missing alwaysApply leaves Cursor mode syntax unknown.",
        null,
        [evidenceId],
      ),
    );
    return mode("unknown", "unknown", false, [evidenceId]);
  }
  if (alwaysApply.value === true) {
    if (hasGlobs) {
      issues.push(
        issue(
          "mode-uncertain",
          "warning",
          null,
          "alwaysApply and globs form an undocumented mixed mode.",
          globs.range,
          ["CURSOR-MODE-05"],
        ),
      );
      return mode("mixed", "unknown", false, ["CURSOR-MODE-05"]);
    }
    if (hasDescription) {
      issues.push(
        issue(
          "mode-uncertain",
          "warning",
          "description",
          "Always syntax is present but description interaction is undocumented.",
          description.range,
          ["CURSOR-MODE-06"],
        ),
      );
      return mode("always", "conditional", false, ["CURSOR-MODE-06"]);
    }
    return mode("always", "known-syntax", true, ["CURSOR-MODE-01"]);
  }
  if (hasGlobs && hasDescription) {
    issues.push(
      issue(
        "mode-uncertain",
        "warning",
        null,
        "globs and description form an undocumented Auto/Agent mixed mode.",
        globs.range,
        ["CURSOR-MODE-07"],
      ),
    );
    return mode("mixed", "unknown", false, ["CURSOR-MODE-07"]);
  }
  if (hasGlobs) return mode("auto-attached", "known-syntax", true, ["CURSOR-MODE-02"]);
  if (hasDescription) {
    return mode("agent-requested", "known-syntax", true, ["CURSOR-MODE-03"]);
  }
  return mode("manual", "known-syntax", true, ["CURSOR-MODE-04"]);
}

function sourceLocation(
  path: RepositoryRelativePath,
  format: CursorRuleFormat,
  issues: MutableIssue[],
): CursorRuleSourceLocation {
  const segments = path.split("/");
  if (format === "legacy") {
    const namedLegacy = segments.at(-1) === ".cursorrules";
    const root = path === ".cursorrules";
    if (!namedLegacy) {
      issues.push(
        issue(
          "invalid-location",
          "error",
          null,
          "Legacy Cursor syntax requires the .cursorrules filename.",
          null,
          ["CURSOR-SURFACE-01"],
        ),
      );
      return Object.freeze({ path, ruleRoot: null, scopeRoot: null, state: "unsupported" });
    }
    if (!root) {
      issues.push(
        issue(
          "invalid-location",
          "warning",
          null,
          "Nested .cursorrules behavior is undocumented.",
          null,
          ["CURSOR-SURFACE-02"],
        ),
      );
      return Object.freeze({ path, ruleRoot: null, scopeRoot: null, state: "unknown" });
    }
    return Object.freeze({
      path,
      ruleRoot: "." as RepositoryRelativePath,
      scopeRoot: "." as RepositoryRelativePath,
      state: "supported",
    });
  }
  const roots: number[] = [];
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segments[index] === ".cursor" && segments[index + 1] === "rules") roots.push(index);
  }
  const mdcName = segments.at(-1)?.endsWith(".mdc") === true;
  if (roots.length !== 1 || !mdcName || (roots[0] ?? segments.length) + 2 >= segments.length) {
    issues.push(
      issue(
        "invalid-location",
        roots.length > 1 ? "warning" : "error",
        null,
        roots.length > 1
          ? "Multiple .cursor/rules roots make source scope ambiguous."
          : "MDC project rules require a .cursor/rules/**/*.mdc location.",
        null,
        [roots.length > 1 ? "CURSOR-NEST-08" : "CURSOR-MDC-01"],
      ),
    );
    return Object.freeze({
      path,
      ruleRoot: null,
      scopeRoot: null,
      state: roots.length > 1 ? "unknown" : "unsupported",
    });
  }
  const index = roots[0] ?? 0;
  const scope = index === 0 ? "." : segments.slice(0, index).join("/");
  const ruleRoot = segments.slice(0, index + 2).join("/");
  return Object.freeze({
    path,
    ruleRoot: ruleRoot as RepositoryRelativePath,
    scopeRoot: scope as RepositoryRelativePath,
    state: "supported",
  });
}

function sourceRange(frontmatter: FrontmatterParseResult): SourceRange | null {
  if (frontmatter.text === null || frontmatter.bodyRange === null) return null;
  const start = frontmatter.frontmatterRange?.start ?? frontmatter.bodyRange.start;
  return Object.freeze({ end: frontmatter.bodyRange.end, sourceId: frontmatter.sourceId, start });
}

function endPosition(text: string): SourcePosition {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) index += 1;
      line += 1;
      lineStart = index + 1;
    } else if (unit === 0x0a) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return Object.freeze({
    byteOffset: Buffer.byteLength(text, "utf8"),
    line,
    utf16Column: text.length - lineStart,
    utf16Offset: text.length,
  });
}

function characterRange(
  text: string,
  utf16Offset: number,
  sourceId: SourceDocumentId,
): SourceRange {
  return Object.freeze({
    end: endPosition(text.slice(0, utf16Offset + 1)),
    sourceId,
    start: endPosition(text.slice(0, utf16Offset)),
  });
}

function references(
  text: string,
  input: Readonly<CursorRuleSyntaxInput>,
  frontmatterRange: SourceRange | null,
  issues: MutableIssue[],
): readonly ImportReference[] {
  try {
    const result = lexImportReferences({
      documentId: input.documentId,
      sourceId: input.sourceId,
      syntax: "cursor-agent",
      text,
    });
    const root = result.markdown.nodes.find((node) => node.id === result.markdown.rootNodeId);
    if (result.markdown.parseState.state !== "complete") {
      issues.push(
        issue(
          "markdown-partial",
          "warning",
          null,
          "Cursor rule Markdown was parsed only partially.",
          root?.range ?? null,
          ["CURSOR-MDC-02"],
        ),
      );
    }
    if (frontmatterRange === null) return result.imports;
    return Object.freeze(
      result.imports.filter(
        (reference) =>
          reference.range.start.utf16Offset < frontmatterRange.start.utf16Offset ||
          reference.range.start.utf16Offset >= frontmatterRange.end.utf16Offset,
      ),
    );
  } catch (error) {
    if (!(error instanceof ImportLexerError)) throw error;
    issues.push(
      issue(
        "reference-resource-limit",
        "error",
        null,
        "Cursor reference candidates exceed the bounded lexer limits.",
        null,
        ["CURSOR-REF-05"],
      ),
    );
    return Object.freeze([]);
  }
}

function hasEmptyBody(text: string, bodyRange: SourceRange | null): boolean {
  return (
    bodyRange !== null &&
    text.slice(bodyRange.start.utf16Offset, bodyRange.end.utf16Offset).trim().length === 0
  );
}

function malformedResult(
  input: Readonly<CursorRuleSyntaxInput>,
  location: CursorRuleSourceLocation,
  issues: readonly CursorRuleSyntaxIssue[],
): CursorRuleSyntaxResult {
  return Object.freeze({
    alwaysApply: absentField<boolean>(),
    bodyRange: null,
    contractVersion: CURSOR_RULE_SYNTAX_CONTRACT_VERSION,
    description: absentField<string>(),
    documentId: input.documentId,
    format: input.format,
    frontmatterRange: null,
    globs: absentField<CursorGlobValue>(),
    issues: Object.freeze([...issues]),
    location,
    metadataAuthority: input.format === "mdc" ? "denied" : "not-applicable",
    modeSyntax: mode(
      input.format === "mdc" ? "malformed" : "legacy",
      input.format === "mdc" ? "invalid" : "not-applicable",
      false,
      [input.format === "mdc" ? "CURSOR-MDC-15" : "CURSOR-SURFACE-01"],
    ),
    references: Object.freeze([]),
    sourceId: input.sourceId,
    sourceRange: null,
    state: "malformed",
    text: null,
  });
}

function parseLegacy(
  input: Readonly<CursorRuleSyntaxInput>,
  location: CursorRuleSourceLocation,
  issues: MutableIssue[],
): CursorRuleSyntaxResult {
  const bytes = input.bytes;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    issues.push(
      issue(
        "frontmatter-invalid",
        "error",
        null,
        "Legacy Cursor rules require BOM-free UTF-8 for exact source locations.",
        null,
        ["CURSOR-MDC-15"],
      ),
    );
    return malformedResult(input, location, issues);
  }
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    issues.push(
      issue(
        "frontmatter-invalid",
        "error",
        null,
        "Legacy Cursor rules are not valid UTF-8.",
        null,
        ["CURSOR-MDC-15"],
      ),
    );
    return malformedResult(input, location, issues);
  }
  issues.push(
    issue(
      "legacy-format",
      "warning",
      null,
      "Legacy .cursorrules is recognized read-only; migrate manually to MDC project rules.",
      null,
      ["CURSOR-SURFACE-01"],
    ),
  );
  const foundReferences = references(text, input, null, issues);
  const wholeRange: SourceRange = Object.freeze({
    end: endPosition(text),
    sourceId: input.sourceId,
    start: Object.freeze({ byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 }),
  });
  if (text.trim().length === 0) {
    issues.push(
      issue(
        "empty-body",
        "warning",
        null,
        "Legacy .cursorrules has no instruction content.",
        wholeRange,
        ["CURSOR-MDC-02"],
      ),
    );
  }
  const hasError = issues.some((value) => value.severity === "error");
  const significantIssues = issues.some((value) => value.code !== "legacy-format");
  return Object.freeze({
    alwaysApply: absentField<boolean>(),
    bodyRange: wholeRange,
    contractVersion: CURSOR_RULE_SYNTAX_CONTRACT_VERSION,
    description: absentField<string>(),
    documentId: input.documentId,
    format: input.format,
    frontmatterRange: null,
    globs: absentField<CursorGlobValue>(),
    issues: Object.freeze(issues),
    location,
    metadataAuthority: "not-applicable",
    modeSyntax: mode("legacy", "not-applicable", false, ["CURSOR-SURFACE-01"]),
    references: foundReferences,
    sourceId: input.sourceId,
    sourceRange: wholeRange,
    state: hasError ? "malformed" : significantIssues ? "partial" : "complete",
    text,
  });
}

/**
 * Parse one caller-authorized Cursor MDC or legacy source without discovery, target reads, profile
 * activation, relevance selection, filesystem access, execution, model calls, or networking.
 */
export function parseCursorRuleSyntax(rawInput: unknown): CursorRuleSyntaxResult {
  const input = validateInput(rawInput);
  const issues: MutableIssue[] = [];
  const location = sourceLocation(input.path, input.format, issues);
  if (input.format === "legacy") return parseLegacy(input, location, issues);

  const frontmatter = parseFrontmatter({
    bytes: input.bytes,
    dialect: "mdc",
    sourceId: input.sourceId,
  });
  issues.push(...frontmatter.issues.map(frontmatterIssue));
  if (frontmatter.state === "absent") {
    issues.push(
      issue(
        "frontmatter-required",
        "error",
        null,
        "Cursor MDC project rules require delimited metadata.",
        frontmatter.bodyRange,
        ["CURSOR-MDC-07"],
      ),
    );
  }
  if (frontmatter.text === null) return malformedResult(input, location, issues);
  const nulOffset = frontmatter.text.indexOf("\0");
  if (nulOffset >= 0) {
    issues.push(
      issue(
        "frontmatter-invalid",
        "error",
        null,
        "Cursor MDC must not contain NUL bytes.",
        characterRange(frontmatter.text, nulOffset, input.sourceId),
        ["CURSOR-MDC-15"],
      ),
    );
  }

  const root = frontmatter.value ?? (Object.create(null) as Readonly<Record<string, unknown>>);
  if (frontmatter.value !== null) {
    for (const key of Object.keys(frontmatter.value).sort()) {
      if (!KNOWN_FIELDS.has(key)) {
        const fieldLocation = locationAt(frontmatter.locations, `$/${key}`);
        issues.push(
          issue(
            "unknown-field",
            "warning",
            key,
            "Field is not part of documented Cursor MDC metadata.",
            fieldLocation?.keyRange ?? fieldLocation?.valueRange ?? null,
            ["CURSOR-MDC-09"],
          ),
        );
      }
    }
  }
  const alwaysApply = parseAlwaysApply(root, frontmatter.locations, issues);
  const description = parseDescription(root, frontmatter.locations, issues);
  const globs = parseGlobs(root, frontmatter.locations, issues);
  const modeSyntax = classifyMode(alwaysApply, description, globs, issues);
  const foundReferences = references(frontmatter.text, input, frontmatter.frontmatterRange, issues);
  if (hasEmptyBody(frontmatter.text, frontmatter.bodyRange)) {
    issues.push(
      issue(
        "empty-body",
        "warning",
        null,
        "Cursor MDC has no instruction content after metadata.",
        frontmatter.bodyRange,
        ["CURSOR-MDC-02"],
      ),
    );
  }
  const invalidField =
    alwaysApply.state === "invalid" || description.state === "invalid" || globs.state === "invalid";
  const malformed =
    frontmatter.state !== "valid" ||
    invalidField ||
    issues.some((value) => value.severity === "error");
  const metadataAuthority = malformed ? "denied" : "available";
  return Object.freeze({
    alwaysApply,
    bodyRange: frontmatter.bodyRange,
    contractVersion: CURSOR_RULE_SYNTAX_CONTRACT_VERSION,
    description,
    documentId: input.documentId,
    format: input.format,
    frontmatterRange: frontmatter.frontmatterRange,
    globs,
    issues: Object.freeze(issues),
    location,
    metadataAuthority,
    modeSyntax,
    references: foundReferences,
    sourceId: input.sourceId,
    sourceRange: sourceRange(frontmatter),
    state: malformed ? "malformed" : issues.length === 0 ? "complete" : "partial",
    text: frontmatter.text,
  });
}
