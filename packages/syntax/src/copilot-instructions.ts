import { types as nodeTypes } from "node:util";

import type {
  ImportReference,
  InstructionDocumentId,
  SourceDocumentId,
  SourceRange,
} from "@agent-context/core";

import { lexImportReferences } from "./import-lexer.js";
import { parseFrontmatter } from "./frontmatter-parser.js";
import type { FrontmatterIssue, FrontmatterLocation } from "./frontmatter-parser.js";

export const COPILOT_INSTRUCTION_SYNTAX_CONTRACT_VERSION = "0.1.0" as const;
export const COPILOT_INSTRUCTION_FORMATS = ["repository-wide", "path-specific"] as const;

export type CopilotInstructionFormat = (typeof COPILOT_INSTRUCTION_FORMATS)[number];
export type CopilotExcludedAgent = "cloud-agent" | "code-review";

export interface CopilotInstructionSyntaxInput {
  readonly bytes: Uint8Array;
  readonly documentId: InstructionDocumentId;
  readonly format: CopilotInstructionFormat;
  readonly sourceId: SourceDocumentId;
}

export interface CopilotInstructionField<T> {
  readonly range: SourceRange | null;
  readonly state: "absent" | "invalid" | "valid";
  readonly value: T | null;
}

export type CopilotInstructionSyntaxIssueCode =
  | "empty-apply-to-pattern"
  | "frontmatter-invalid"
  | "invalid-field-type"
  | "markdown-partial"
  | "missing-apply-to"
  | "resource-limit"
  | "unknown-field";

export interface CopilotInstructionSyntaxIssue {
  readonly code: CopilotInstructionSyntaxIssueCode;
  readonly field: string | null;
  readonly message: string;
  readonly range: SourceRange | null;
}

export interface CopilotInstructionSyntaxResult {
  readonly applyTo: CopilotInstructionField<readonly string[]>;
  readonly bodyRange: SourceRange | null;
  readonly contractVersion: typeof COPILOT_INSTRUCTION_SYNTAX_CONTRACT_VERSION;
  readonly description: CopilotInstructionField<string>;
  readonly documentId: InstructionDocumentId;
  readonly excludeAgent: CopilotInstructionField<CopilotExcludedAgent>;
  readonly format: CopilotInstructionFormat;
  readonly imports: readonly ImportReference[];
  readonly issues: readonly CopilotInstructionSyntaxIssue[];
  readonly name: CopilotInstructionField<string>;
  readonly referenceSupport:
    "profile-dependent-repository-reference" | "unsupported-in-path-specific";
  readonly scopeAuthority: "available" | "denied" | "not-applicable";
  readonly sourceId: SourceDocumentId;
  readonly state: "complete" | "malformed" | "partial";
  readonly text: string | null;
}

export const CopilotInstructionSyntaxErrorCode: Readonly<{
  invalidInput: "COPILOT_INSTRUCTION_SYNTAX_INVALID_INPUT";
}> = Object.freeze({
  invalidInput: "COPILOT_INSTRUCTION_SYNTAX_INVALID_INPUT",
} as const);

export type CopilotInstructionSyntaxErrorCode =
  (typeof CopilotInstructionSyntaxErrorCode)[keyof typeof CopilotInstructionSyntaxErrorCode];

export class CopilotInstructionSyntaxError extends Error {
  readonly code: CopilotInstructionSyntaxErrorCode;

  constructor(message: string) {
    super(message);
    this.name = "CopilotInstructionSyntaxError";
    this.code = CopilotInstructionSyntaxErrorCode.invalidInput;
    Object.freeze(this);
  }
}

const INPUT_KEYS = new Set(["bytes", "documentId", "format", "sourceId"]);
const KNOWN_FIELDS = new Set(["applyTo", "description", "excludeAgent", "name"]);
const STABLE_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TEXT_LENGTH = 4_096;
const MAX_APPLY_TO_LENGTH = 32_768;
const MAX_PATTERNS = 1_024;
const MAX_PATTERN_LENGTH = 4_096;

function fail(message: string): never {
  throw new CopilotInstructionSyntaxError(message);
}

function inputRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    return fail("input must be a non-proxy plain record");
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return fail("input cannot be inspected safely");
  }
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== INPUT_KEYS.size) {
    return fail("input must contain exactly the documented fields");
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || !INPUT_KEYS.has(key)) {
      return fail("input contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail("input must contain only own enumerable data properties");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function stableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !STABLE_IDENTIFIER.test(value)
  ) {
    return fail(`${label} must be a bounded stable identifier`);
  }
  return value;
}

function validateInput(value: unknown): CopilotInstructionSyntaxInput {
  const record = inputRecord(value);
  const format = record["format"];
  if (
    typeof format !== "string" ||
    !(COPILOT_INSTRUCTION_FORMATS as readonly string[]).includes(format)
  ) {
    return fail("input.format must name a supported Copilot instruction format");
  }
  const bytes = record["bytes"];
  if (!nodeTypes.isUint8Array(bytes) || nodeTypes.isProxy(bytes)) {
    return fail("input.bytes must be an intrinsic Uint8Array");
  }
  return Object.freeze({
    bytes,
    documentId: stableIdentifier(record["documentId"], "input.documentId") as InstructionDocumentId,
    format: format as CopilotInstructionFormat,
    sourceId: stableIdentifier(record["sourceId"], "input.sourceId") as SourceDocumentId,
  });
}

function fieldRange(locations: readonly FrontmatterLocation[], field: string): SourceRange | null {
  return locations.find((location) => location.path === `$/${field}`)?.valueRange ?? null;
}

function absentField<T>(): CopilotInstructionField<T> {
  return Object.freeze({ range: null, state: "absent", value: null });
}

function invalidField<T>(range: SourceRange | null): CopilotInstructionField<T> {
  return Object.freeze({ range, state: "invalid", value: null });
}

function validField<T>(range: SourceRange | null, value: T): CopilotInstructionField<T> {
  return Object.freeze({ range, state: "valid", value });
}

function issue(
  code: CopilotInstructionSyntaxIssueCode,
  field: string | null,
  message: string,
  range: SourceRange | null,
): CopilotInstructionSyntaxIssue {
  return Object.freeze({ code, field, message, range });
}

function frontmatterIssues(values: readonly FrontmatterIssue[]): CopilotInstructionSyntaxIssue[] {
  return values.map((value) =>
    issue(
      value.code === "resource-limit" ? "resource-limit" : "frontmatter-invalid",
      null,
      "Copilot instruction frontmatter is not safely parseable.",
      value.range,
    ),
  );
}

type SplitPatternsResult =
  | {
      readonly patterns: readonly string[];
      readonly issueCode: null;
    }
  | {
      readonly patterns: null;
      readonly issueCode: "empty-apply-to-pattern" | "resource-limit";
    };

function splitFailure(issueCode: "empty-apply-to-pattern" | "resource-limit"): SplitPatternsResult {
  return Object.freeze({ issueCode, patterns: null });
}

/** Split documented comma lists while preserving commas inside one balanced brace expression. */
function splitApplyTo(value: string): SplitPatternsResult {
  if (value.length === 0 || value.length > MAX_APPLY_TO_LENGTH) {
    return splitFailure(
      value.length > MAX_APPLY_TO_LENGTH ? "resource-limit" : "empty-apply-to-pattern",
    );
  }
  const patterns: string[] = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === "{") {
      braceDepth += 1;
      if (braceDepth > 64) {
        return splitFailure("resource-limit");
      }
    } else if (character === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (character === "[") {
      bracketDepth += 1;
      if (bracketDepth > 64) {
        return splitFailure("resource-limit");
      }
    } else if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    }
    if ((character === "," && braceDepth === 0 && bracketDepth === 0) || index === value.length) {
      const pattern = value.slice(start, index).trim();
      if (pattern.length === 0) {
        return splitFailure("empty-apply-to-pattern");
      }
      if (pattern.length > MAX_PATTERN_LENGTH || patterns.length >= MAX_PATTERNS) {
        return splitFailure("resource-limit");
      }
      patterns.push(pattern);
      start = index + 1;
    }
  }
  return Object.freeze({ issueCode: null, patterns: Object.freeze(patterns) });
}

function textField(
  value: unknown,
  name: "description" | "name",
  locations: readonly FrontmatterLocation[],
  issues: CopilotInstructionSyntaxIssue[],
): CopilotInstructionField<string> {
  const range = fieldRange(locations, name);
  if (value === undefined) return absentField();
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    issues.push(
      issue("invalid-field-type", name, `${name} must be a bounded non-empty string.`, range),
    );
    return invalidField(range);
  }
  return validField(range, value);
}

function parseApplyTo(
  value: unknown,
  locations: readonly FrontmatterLocation[],
  issues: CopilotInstructionSyntaxIssue[],
): CopilotInstructionField<readonly string[]> {
  const range = fieldRange(locations, "applyTo");
  if (value === undefined) return absentField();
  if (typeof value !== "string") {
    issues.push(issue("invalid-field-type", "applyTo", "applyTo must be a string.", range));
    return invalidField(range);
  }
  const split = splitApplyTo(value);
  if (split.patterns === null) {
    issues.push(
      issue(
        split.issueCode,
        "applyTo",
        "applyTo must be a bounded comma-separated list of non-empty patterns.",
        range,
      ),
    );
    return invalidField(range);
  }
  return validField(range, split.patterns);
}

function parseExcludeAgent(
  value: unknown,
  locations: readonly FrontmatterLocation[],
  issues: CopilotInstructionSyntaxIssue[],
): CopilotInstructionField<CopilotExcludedAgent> {
  const range = fieldRange(locations, "excludeAgent");
  if (value === undefined) return absentField();
  if (value !== "cloud-agent" && value !== "code-review") {
    issues.push(
      issue(
        "invalid-field-type",
        "excludeAgent",
        "excludeAgent must be cloud-agent or code-review.",
        range,
      ),
    );
    return invalidField(range);
  }
  return validField(range, value);
}

/** Parse Copilot repository-wide or path-specific instruction syntax without resolving a client. */
export function parseCopilotInstructionSyntax(rawInput: unknown): CopilotInstructionSyntaxResult {
  const input = validateInput(rawInput);
  const frontmatter = parseFrontmatter({
    bytes: input.bytes,
    dialect: "yaml",
    sourceId: input.sourceId,
  });

  if (input.format === "repository-wide") {
    if (frontmatter.text === null) {
      return Object.freeze({
        applyTo: absentField<readonly string[]>(),
        bodyRange: null,
        contractVersion: COPILOT_INSTRUCTION_SYNTAX_CONTRACT_VERSION,
        description: absentField<string>(),
        documentId: input.documentId,
        excludeAgent: absentField<CopilotExcludedAgent>(),
        format: input.format,
        imports: Object.freeze([]),
        issues: Object.freeze(frontmatterIssues(frontmatter.issues)),
        name: absentField<string>(),
        referenceSupport: "profile-dependent-repository-reference",
        scopeAuthority: "not-applicable",
        sourceId: input.sourceId,
        state: "malformed",
        text: null,
      });
    }
    const importResult = lexImportReferences({
      documentId: input.documentId,
      sourceId: input.sourceId,
      syntax: "copilot-cli",
      text: frontmatter.text,
    });
    const root = importResult.markdown.nodes.find(
      (node) => node.id === importResult.markdown.rootNodeId,
    );
    const repositoryIssues: CopilotInstructionSyntaxIssue[] = [];
    if (importResult.markdown.parseState.state !== "complete") {
      repositoryIssues.push(
        issue(
          "markdown-partial",
          null,
          "Copilot repository instruction Markdown was parsed only partially.",
          root?.range ?? null,
        ),
      );
    }
    return Object.freeze({
      applyTo: absentField<readonly string[]>(),
      bodyRange: root?.range ?? null,
      contractVersion: COPILOT_INSTRUCTION_SYNTAX_CONTRACT_VERSION,
      description: absentField<string>(),
      documentId: input.documentId,
      excludeAgent: absentField<CopilotExcludedAgent>(),
      format: input.format,
      imports: importResult.imports,
      issues: Object.freeze(repositoryIssues),
      name: absentField<string>(),
      referenceSupport: "profile-dependent-repository-reference",
      scopeAuthority: "not-applicable",
      sourceId: input.sourceId,
      state: repositoryIssues.length === 0 ? "complete" : "partial",
      text: frontmatter.text,
    });
  }

  const issues = frontmatterIssues(frontmatter.issues);
  const value = frontmatter.value ?? (Object.create(null) as Readonly<Record<string, unknown>>);

  if (frontmatter.value !== null) {
    for (const key of Object.keys(frontmatter.value).sort()) {
      if (!KNOWN_FIELDS.has(key)) {
        issues.push(
          issue(
            "unknown-field",
            key,
            "Frontmatter field is not part of the documented Copilot instruction syntax.",
            fieldRange(frontmatter.locations, key),
          ),
        );
      }
    }
  }

  const applyTo = parseApplyTo(value["applyTo"], frontmatter.locations, issues);
  const description = textField(value["description"], "description", frontmatter.locations, issues);
  const excludeAgent = parseExcludeAgent(value["excludeAgent"], frontmatter.locations, issues);
  const name = textField(value["name"], "name", frontmatter.locations, issues);

  if (applyTo.state === "absent") {
    issues.push(
      issue(
        "missing-apply-to",
        "applyTo",
        "Path-specific Copilot instructions require profile-specific handling when applyTo is absent.",
        frontmatter.frontmatterRange,
      ),
    );
  }

  const malformed = frontmatter.state === "invalid";
  const scopeAuthority = malformed || applyTo.state !== "valid" ? "denied" : "available";
  return Object.freeze({
    applyTo,
    bodyRange: frontmatter.bodyRange,
    contractVersion: COPILOT_INSTRUCTION_SYNTAX_CONTRACT_VERSION,
    description,
    documentId: input.documentId,
    excludeAgent,
    format: input.format,
    imports: Object.freeze([]),
    issues: Object.freeze(issues),
    name,
    referenceSupport: "unsupported-in-path-specific",
    scopeAuthority,
    sourceId: input.sourceId,
    state: malformed ? "malformed" : issues.length === 0 ? "complete" : "partial",
    text: frontmatter.text,
  });
}
