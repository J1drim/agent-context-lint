import { types as nodeTypes } from "node:util";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type { ConfigurationSourceLocation, Uncertainty } from "@agent-context/core";

export const COMMAND_LEXER_CONTRACT_VERSION = "0.1.0" as const;
export const COMMAND_DIALECTS = [
  "auto",
  "posix-shell",
  "windows-cmd",
  "windows-powershell",
] as const;

export type CommandDialect = (typeof COMMAND_DIALECTS)[number];
export type ResolvedCommandDialect = Exclude<CommandDialect, "auto">;
export type CommandPartKind =
  | "backtick-substitution"
  | "command-substitution"
  | "double-quoted"
  | "escape"
  | "literal"
  | "single-quoted"
  | "variable-expansion";
export type CommandTokenKind = "environment-assignment" | "operator" | "redirection" | "word";

export interface CommandEvidenceProvenance {
  readonly collectorId: string;
  readonly factId: string | null;
  readonly source: ConfigurationSourceLocation;
  readonly sourceKind: "caller" | "configuration" | "evidence-fact";
}

export interface CommandLexerInput {
  readonly dialect: CommandDialect;
  readonly provenance: CommandEvidenceProvenance;
  readonly text: string;
}

export interface CommandLexerLimits {
  readonly maximumInputLength: number;
  readonly maximumInvocations: number;
  readonly maximumIssues: number;
  readonly maximumNesting: number;
  readonly maximumParts: number;
  readonly maximumTokens: number;
}

export type CommandLexerOptions = Partial<CommandLexerLimits>;

export const COMMAND_LEXER_DEFAULT_LIMITS: Readonly<CommandLexerLimits> = Object.freeze({
  maximumInputLength: 65_536,
  maximumInvocations: 4_096,
  maximumIssues: 1_024,
  maximumNesting: 64,
  maximumParts: 32_768,
  maximumTokens: 16_384,
});

export const COMMAND_LEXER_HARD_LIMITS: Readonly<CommandLexerLimits> = Object.freeze({
  maximumInputLength: 1_048_576,
  maximumInvocations: 65_536,
  maximumIssues: 16_384,
  maximumNesting: 256,
  maximumParts: 524_288,
  maximumTokens: 262_144,
});

export interface CommandSourceRange {
  /** UTF-16 offset relative to the start of input.text. */
  readonly start: number;
  /** Exclusive UTF-16 offset relative to the start of input.text. */
  readonly end: number;
}

export interface CommandWordPart extends CommandSourceRange {
  readonly kind: CommandPartKind;
  readonly raw: string;
  /** Literal value when statically knowable, otherwise null. */
  readonly value: string | null;
}

export interface CommandToken extends CommandSourceRange {
  readonly kind: CommandTokenKind;
  readonly parts: readonly CommandWordPart[];
  readonly raw: string;
  /** Canonical literal value when statically knowable, otherwise null. */
  readonly value: string | null;
}

export interface CommandRedirectionEvidence extends CommandSourceRange {
  readonly operator: string;
  readonly raw: string;
  readonly target: string | null;
}

export interface CommandInvocationEvidence extends CommandSourceRange {
  readonly arguments: readonly (string | null)[];
  readonly environment: Readonly<Record<string, string | null>>;
  readonly executable: string | null;
  readonly redirections: readonly CommandRedirectionEvidence[];
  readonly state: "dynamic" | "empty" | "literal" | "malformed";
}

export interface CommandLexerIssue extends CommandSourceRange {
  readonly code: "ambiguous-dialect" | "malformed-syntax";
  readonly message: string;
}

export interface CommandLexerConfidence {
  readonly basis:
    "caller-specified" | "exclusive-markers" | "insufficient-markers" | "mixed-markers";
  readonly level: "exact" | "high" | "low";
  readonly score: 1 | 0.9 | 0.5;
}

export interface CommandLexerMetrics {
  readonly invocationCount: number;
  readonly issueCount: number;
  readonly partCount: number;
  readonly tokenCount: number;
}

export interface CommandLexerResult {
  readonly confidence: CommandLexerConfidence;
  readonly contractVersion: typeof COMMAND_LEXER_CONTRACT_VERSION;
  readonly invocations: readonly CommandInvocationEvidence[];
  readonly issues: readonly CommandLexerIssue[];
  readonly limits: CommandLexerLimits;
  readonly metrics: CommandLexerMetrics;
  readonly provenance: CommandEvidenceProvenance;
  readonly requestedDialect: CommandDialect;
  readonly resolvedDialect: ResolvedCommandDialect | null;
  readonly tokens: readonly CommandToken[];
  readonly uncertainty: Uncertainty;
}

export const CommandLexerErrorCode: Readonly<{
  invalidInput: "COMMAND_LEXER_INVALID_INPUT";
  invalidOptions: "COMMAND_LEXER_INVALID_OPTIONS";
  limitExceeded: "COMMAND_LEXER_LIMIT_EXCEEDED";
}> = Object.freeze({
  invalidInput: "COMMAND_LEXER_INVALID_INPUT",
  invalidOptions: "COMMAND_LEXER_INVALID_OPTIONS",
  limitExceeded: "COMMAND_LEXER_LIMIT_EXCEEDED",
} as const);
export type CommandLexerErrorCode =
  (typeof CommandLexerErrorCode)[keyof typeof CommandLexerErrorCode];

export class CommandLexerError extends Error {
  override readonly name = "CommandLexerError" as const;
  readonly code: CommandLexerErrorCode;
  readonly limitName: keyof CommandLexerLimits | null;

  constructor(
    code: CommandLexerErrorCode,
    message: string,
    limitName: keyof CommandLexerLimits | null = null,
  ) {
    super(message);
    this.code = code;
    this.limitName = limitName;
    Object.freeze(this);
  }
}

interface MutableToken extends CommandSourceRange {
  kind: CommandTokenKind;
  parts: CommandWordPart[];
  raw: string;
  value: string | null;
}

interface ScanState {
  readonly issues: CommandLexerIssue[];
  readonly limits: CommandLexerLimits;
  readonly text: string;
  readonly tokens: MutableToken[];
  partCount: number;
}

const INPUT_KEYS = new Set(["dialect", "provenance", "text"]);
const PROVENANCE_KEYS = new Set(["collectorId", "factId", "source", "sourceKind"]);
const LOCATION_KEYS = new Set(["path", "range"]);
const RANGE_KEYS = new Set(["start", "end"]);
const POSITION_KEYS = new Set(["byteOffset", "utf16Offset", "line", "utf16Column"]);
const LIMIT_KEYS = new Set(Object.keys(COMMAND_LEXER_DEFAULT_LIMITS));
const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const REDIRECTION = /(?:(?:\d+|\*)?)(?:>>?|<<?)(?:&\d+)?/uy;
const CMD_EXPANSION = /(?:%[^%\r\n]+%|![^!\r\n]+!)/uy;
const POSIX_EXPANSION = /\$(?:env:[A-Za-z_][\w]*|[A-Za-z_][\w]*|\{[^}\r\n]+\})/iuy;

function failInput(message: string): never {
  throw new CommandLexerError(CommandLexerErrorCode.invalidInput, message);
}

function record(value: unknown, name: string, keys: ReadonlySet<string>): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return failInput(`${name} must be a non-proxy plain object`);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return failInput(`${name} must have a plain prototype`);
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return failInput(`${name} could not be inspected safely`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== "string" || !keys.has(key))
      return failInput(`${name} contains an unknown field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      return failInput(`${name} must contain only own data properties`);
    output[key] = descriptor.value;
  }
  return output;
}

function boundedIdentifier(value: unknown, name: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !IDENTIFIER.test(value)
  )
    return failInput(`${name} must be a bounded stable identifier${nullable ? " or null" : ""}`);
  return value;
}

function requiredIdentifier(value: unknown, name: string): string {
  const result = boundedIdentifier(value, name);
  if (result === null) return failInput(`${name} must not be null`);
  return result;
}

function natural(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    return failInput(`${name} must be a non-negative safe integer`);
  return value as number;
}

function validatePosition(
  value: unknown,
  name: string,
): ConfigurationSourceLocation["range"]["start"] {
  const item = record(value, name, POSITION_KEYS);
  return Object.freeze({
    byteOffset: natural(item["byteOffset"], `${name}.byteOffset`),
    line: natural(item["line"], `${name}.line`),
    utf16Column: natural(item["utf16Column"], `${name}.utf16Column`),
    utf16Offset: natural(item["utf16Offset"], `${name}.utf16Offset`),
  });
}

function validateLocation(value: unknown): ConfigurationSourceLocation {
  const item = record(value, "input.provenance.source", LOCATION_KEYS);
  if (typeof item["path"] !== "string")
    return failInput("input.provenance.source.path must be a string");
  let path;
  try {
    path = canonicalizeRepositoryRelativePath(item["path"]);
  } catch {
    return failInput("input.provenance.source.path must be canonical and repository-relative");
  }
  const range = record(item["range"], "input.provenance.source.range", RANGE_KEYS);
  const start = validatePosition(range["start"], "input.provenance.source.range.start");
  const end = validatePosition(range["end"], "input.provenance.source.range.end");
  if (end.byteOffset < start.byteOffset || end.utf16Offset < start.utf16Offset)
    return failInput("input.provenance.source.range must not be reversed");
  return Object.freeze({ path, range: Object.freeze({ start, end }) });
}

function validateInput(value: unknown): CommandLexerInput {
  const input = record(value, "input", INPUT_KEYS);
  if (typeof input["text"] !== "string") return failInput("input.text must be a string");
  if (
    typeof input["dialect"] !== "string" ||
    !(COMMAND_DIALECTS as readonly string[]).includes(input["dialect"])
  )
    return failInput("input.dialect must name a supported command dialect");
  const rawProvenance = record(input["provenance"], "input.provenance", PROVENANCE_KEYS);
  const sourceKind = rawProvenance["sourceKind"];
  if (sourceKind !== "caller" && sourceKind !== "configuration" && sourceKind !== "evidence-fact")
    return failInput("input.provenance.sourceKind is invalid");
  const provenance = Object.freeze({
    collectorId: requiredIdentifier(rawProvenance["collectorId"], "input.provenance.collectorId"),
    factId: boundedIdentifier(rawProvenance["factId"], "input.provenance.factId", true),
    source: validateLocation(rawProvenance["source"]),
    sourceKind,
  });
  return Object.freeze({
    dialect: input["dialect"] as CommandDialect,
    provenance,
    text: input["text"],
  });
}

function validateOptions(value: unknown): CommandLexerLimits {
  if (value === undefined) return COMMAND_LEXER_DEFAULT_LIMITS;
  let options: Record<string, unknown>;
  try {
    options = record(value, "options", LIMIT_KEYS);
  } catch (error) {
    if (error instanceof CommandLexerError)
      throw new CommandLexerError(
        CommandLexerErrorCode.invalidOptions,
        error.message.replace("input", "options"),
      );
    throw error;
  }
  const result: Record<string, number> = {};
  for (const key of LIMIT_KEYS as ReadonlySet<keyof CommandLexerLimits>) {
    const candidate = Object.hasOwn(options, key)
      ? options[key]
      : COMMAND_LEXER_DEFAULT_LIMITS[key];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < 1 ||
      (candidate as number) > COMMAND_LEXER_HARD_LIMITS[key]
    )
      throw new CommandLexerError(
        CommandLexerErrorCode.invalidOptions,
        `${key} must be a positive safe integer no greater than ${String(COMMAND_LEXER_HARD_LIMITS[key])}`,
        key,
      );
    result[key] = candidate as number;
  }
  return Object.freeze(result) as unknown as CommandLexerLimits;
}

function limit(name: keyof CommandLexerLimits): never {
  throw new CommandLexerError(CommandLexerErrorCode.limitExceeded, `${name} was exceeded`, name);
}

function issue(
  state: ScanState,
  start: number,
  end: number,
  message: string,
  code: CommandLexerIssue["code"] = "malformed-syntax",
): void {
  if (state.issues.length >= state.limits.maximumIssues) limit("maximumIssues");
  state.issues.push(Object.freeze({ code, end, message, start }));
}

function part(
  state: ScanState,
  parts: CommandWordPart[],
  kind: CommandPartKind,
  start: number,
  end: number,
  value: string | null,
): void {
  if (state.partCount >= state.limits.maximumParts) limit("maximumParts");
  state.partCount += 1;
  parts.push(Object.freeze({ end, kind, raw: state.text.slice(start, end), start, value }));
}

function pushToken(state: ScanState, token: MutableToken): void {
  if (state.tokens.length >= state.limits.maximumTokens) limit("maximumTokens");
  state.tokens.push(token);
}

function isSpace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function readBalanced(state: ScanState, start: number, open: string, close: string): number {
  let depth = 1;
  let index = start + open.length;
  let quote: "'" | '"' | null = null;
  while (index < state.text.length) {
    const character = state.text.charAt(index);
    if (quote !== null) {
      if (character === quote) quote = null;
      if (character === "\\" && quote === '"') index += 1;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (state.text.startsWith(open, index)) {
      depth += 1;
      if (depth > state.limits.maximumNesting) limit("maximumNesting");
      index += open.length;
      continue;
    }
    if (state.text.startsWith(close, index)) {
      depth -= 1;
      index += close.length;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  issue(state, start, state.text.length, `unclosed ${open}${close} expression`);
  return state.text.length;
}

function operatorAt(text: string, index: number): string | null {
  for (const candidate of ["&&", "||", "|", ";", "&", "(", ")"])
    if (text.startsWith(candidate, index)) return candidate;
  return null;
}

function redirectionAt(text: string, index: number): string | null {
  REDIRECTION.lastIndex = index;
  const match = REDIRECTION.exec(text);
  return match?.[0] ?? null;
}

function expansionAt(
  text: string,
  index: number,
  dialect: ResolvedCommandDialect,
): string | undefined {
  const expression = dialect === "windows-cmd" ? CMD_EXPANSION : POSIX_EXPANSION;
  expression.lastIndex = index;
  return expression.exec(text)?.[0];
}

function literalPartValue(parts: readonly CommandWordPart[]): string | null {
  let result = "";
  for (const item of parts) {
    if (item.value === null) return null;
    result += item.value;
  }
  return result;
}

function scanWord(state: ScanState, dialect: ResolvedCommandDialect, start: number): number {
  const parts: CommandWordPart[] = [];
  let index = start;
  let literalStart = start;
  const flushLiteral = (end: number): void => {
    if (end > literalStart)
      part(state, parts, "literal", literalStart, end, state.text.slice(literalStart, end));
  };
  while (index < state.text.length) {
    const character = state.text.charAt(index);
    if (
      isSpace(character) ||
      operatorAt(state.text, index) !== null ||
      redirectionAt(state.text, index) !== null
    )
      break;
    if (character === "'" || character === '"') {
      flushLiteral(index);
      const quote = character;
      const quoteStart = index;
      index += 1;
      const contentStart = index;
      while (index < state.text.length && state.text[index] !== quote) {
        if (dialect !== "windows-cmd" && quote === '"' && state.text[index] === "\\") index += 1;
        if (dialect === "windows-powershell" && quote === '"' && state.text[index] === "`")
          index += 1;
        index += 1;
      }
      if (index >= state.text.length) issue(state, quoteStart, index, `unclosed ${quote} quote`);
      else index += 1;
      const rawContent = state.text.slice(
        contentStart,
        Math.max(contentStart, index - (state.text[index - 1] === quote ? 1 : 0)),
      );
      const dynamic =
        quote === '"' &&
        ((dialect !== "windows-cmd" && /\$(?:\(|\{|[A-Za-z_])/u.test(rawContent)) ||
          (dialect === "windows-cmd" && /%[^%]+%|![^!]+!/u.test(rawContent)));
      part(
        state,
        parts,
        quote === "'" ? "single-quoted" : "double-quoted",
        quoteStart,
        index,
        dynamic ? null : rawContent,
      );
      literalStart = index;
      continue;
    }
    const escape = dialect === "windows-cmd" ? "^" : dialect === "windows-powershell" ? "`" : "\\";
    if (character === escape) {
      flushLiteral(index);
      const escapeStart = index;
      index += 1;
      if (index >= state.text.length) issue(state, escapeStart, index, "dangling escape");
      else index += 1;
      part(
        state,
        parts,
        "escape",
        escapeStart,
        index,
        index - escapeStart === 2 ? state.text.charAt(index - 1) : "",
      );
      literalStart = index;
      continue;
    }
    if (dialect !== "windows-cmd" && state.text.startsWith("$(", index)) {
      flushLiteral(index);
      const end = readBalanced(state, index, "$(", ")");
      part(state, parts, "command-substitution", index, end, null);
      index = end;
      literalStart = index;
      continue;
    }
    if (dialect === "posix-shell" && character === "`") {
      flushLiteral(index);
      const substitutionStart = index;
      index += 1;
      while (index < state.text.length && state.text[index] !== "`")
        index += state.text[index] === "\\" ? 2 : 1;
      if (index >= state.text.length)
        issue(state, substitutionStart, index, "unclosed backtick substitution");
      else index += 1;
      part(state, parts, "backtick-substitution", substitutionStart, index, null);
      literalStart = index;
      continue;
    }
    const expansion = expansionAt(state.text, index, dialect);
    if (expansion !== undefined) {
      flushLiteral(index);
      part(state, parts, "variable-expansion", index, index + expansion.length, null);
      index += expansion.length;
      literalStart = index;
      continue;
    }
    index += 1;
  }
  flushLiteral(index);
  const value = literalPartValue(parts);
  const raw = state.text.slice(start, index);
  const kind =
    value !== null && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value) ? "environment-assignment" : "word";
  pushToken(state, { end: index, kind, parts, raw, start, value });
  return index;
}

function scan(
  text: string,
  dialect: ResolvedCommandDialect,
  limits: CommandLexerLimits,
): ScanState {
  const state: ScanState = { issues: [], limits, partCount: 0, text, tokens: [] };
  let index = 0;
  while (index < text.length) {
    if (isSpace(text.charAt(index))) {
      index += 1;
      continue;
    }
    const redirection = redirectionAt(text, index);
    if (redirection !== null) {
      pushToken(state, {
        end: index + redirection.length,
        kind: "redirection",
        parts: [],
        raw: redirection,
        start: index,
        value: redirection,
      });
      index += redirection.length;
      continue;
    }
    const operator = operatorAt(text, index);
    if (operator !== null) {
      pushToken(state, {
        end: index + operator.length,
        kind: "operator",
        parts: [],
        raw: operator,
        start: index,
        value: operator,
      });
      index += operator.length;
      continue;
    }
    index = scanWord(state, dialect, index);
  }
  return state;
}

function inferDialect(
  text: string,
  requested: CommandDialect,
): {
  confidence: CommandLexerConfidence;
  dialect: ResolvedCommandDialect | null;
  uncertainty: Uncertainty;
  issue?: string;
} {
  if (requested !== "auto")
    return {
      confidence: Object.freeze({ basis: "caller-specified", level: "exact", score: 1 }),
      dialect: requested,
      uncertainty: Object.freeze({ state: "known" }),
    };
  const matches = [
    { dialect: "windows-cmd" as const, found: /%[^%\r\n]+%|![^!\r\n]+!|\^[&|<>]/u.test(text) },
    {
      dialect: "windows-powershell" as const,
      found: /\$env:|\b(?:Write-Host|Get-ChildItem|Set-Location)\b|`[&|<>]/iu.test(text),
    },
    {
      dialect: "posix-shell" as const,
      found: /\$\(|`[^`]*`|\$\{[^}]+\}|\b(?:export|printf|chmod)\b/u.test(text),
    },
  ].filter((entry) => entry.found);
  if (matches.length === 1)
    return {
      confidence: Object.freeze({ basis: "exclusive-markers", level: "high", score: 0.9 }),
      dialect: matches[0]?.dialect ?? null,
      uncertainty: Object.freeze({ state: "known" }),
    };
  if (matches.length > 1)
    return {
      confidence: Object.freeze({ basis: "mixed-markers", level: "low", score: 0.5 }),
      dialect: null,
      issue: "command contains markers from multiple dialects",
      uncertainty: Object.freeze({
        alternatives: Object.freeze(
          matches.map((entry) =>
            Object.freeze({ description: `markers match ${entry.dialect}`, id: entry.dialect }),
          ),
        ),
        reason: "multiple command dialects are plausible",
        state: "contradiction",
      }),
    };
  return {
    confidence: Object.freeze({ basis: "insufficient-markers", level: "low", score: 0.5 }),
    dialect: null,
    issue: "command has no dialect-exclusive markers",
    uncertainty: Object.freeze({
      reason: "dialect cannot be inferred from static text",
      state: "unknown",
    }),
  };
}

function canonicalExecutable(value: string, dialect: ResolvedCommandDialect): string {
  if (dialect === "posix-shell") return value;
  return value.toLowerCase().replace(/\.(?:bat|cmd|exe|ps1)$/iu, "");
}

function buildInvocations(
  state: ScanState,
  dialect: ResolvedCommandDialect,
): readonly CommandInvocationEvidence[] {
  const groups: MutableToken[][] = [[]];
  for (const token of state.tokens) {
    if (token.kind === "operator") {
      if (groups.at(-1)?.length !== 0) groups.push([]);
    } else groups.at(-1)?.push(token);
  }
  const invocations: CommandInvocationEvidence[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (invocations.length >= state.limits.maximumInvocations) limit("maximumInvocations");
    const environment: Record<string, string | null> = Object.create(null) as Record<
      string,
      string | null
    >;
    const redirections: CommandRedirectionEvidence[] = [];
    const words: MutableToken[] = [];
    for (let index = 0; index < group.length; index += 1) {
      const token = group[index];
      if (token === undefined) continue;
      if (token.kind === "environment-assignment" && words.length === 0) {
        const assignment = token.value;
        if (assignment === null) {
          words.push(token);
          continue;
        }
        const equal = assignment.indexOf("=");
        environment[assignment.slice(0, equal)] = assignment.slice(equal + 1);
      } else if (token.kind === "redirection") {
        const target = group[index + 1]?.kind === "word" ? (group[++index]?.value ?? null) : null;
        redirections.push(
          Object.freeze({
            end: group[index]?.end ?? token.end,
            operator: token.raw,
            raw: state.text.slice(token.start, group[index]?.end ?? token.end),
            start: token.start,
            target,
          }),
        );
      } else words.push(token);
    }
    const executableToken = words[0];
    const malformed = state.issues.some(
      (item) => item.start >= (group[0]?.start ?? 0) && item.start <= (group.at(-1)?.end ?? 0),
    );
    const dynamic =
      words.some((token) => token.value === null) ||
      Object.values(environment).some((value) => value === null);
    invocations.push(
      Object.freeze({
        arguments: Object.freeze(words.slice(1).map((token) => token.value)),
        end: group.at(-1)?.end ?? 0,
        environment: Object.freeze(environment),
        executable:
          executableToken?.value === null || executableToken === undefined
            ? null
            : canonicalExecutable(executableToken.value, dialect),
        redirections: Object.freeze(redirections),
        start: group[0]?.start ?? 0,
        state: malformed
          ? "malformed"
          : executableToken === undefined
            ? "empty"
            : dynamic
              ? "dynamic"
              : "literal",
      }),
    );
  }
  return Object.freeze(invocations);
}

function freezeTokens(tokens: readonly MutableToken[]): readonly CommandToken[] {
  return Object.freeze(
    tokens.map((token) => Object.freeze({ ...token, parts: Object.freeze(token.parts) })),
  );
}

/**
 * Recognizes command-shaped text without evaluating, expanding, resolving, or executing it.
 * Repository content is untrusted data; this function performs no I/O.
 */
export function lexCommandEvidence(rawInput: unknown, rawOptions?: unknown): CommandLexerResult {
  const input = validateInput(rawInput);
  const limits = validateOptions(rawOptions);
  if (input.text.length > limits.maximumInputLength)
    throw new CommandLexerError(
      CommandLexerErrorCode.limitExceeded,
      "maximumInputLength was exceeded",
      "maximumInputLength",
    );
  const inference = inferDialect(input.text, input.dialect);
  const dialect = inference.dialect ?? "posix-shell";
  const state = scan(input.text, dialect, limits);
  if (inference.issue !== undefined)
    issue(state, 0, input.text.length, inference.issue, "ambiguous-dialect");
  const invocations = buildInvocations(state, dialect);
  const hasDynamic = state.tokens.some((token) => token.parts.some((item) => item.value === null));
  const uncertainty: Uncertainty =
    inference.uncertainty.state === "known" && state.issues.length > 0
      ? Object.freeze({ reason: "command text contains malformed static syntax", state: "unknown" })
      : inference.uncertainty.state === "known" && hasDynamic
        ? Object.freeze({
            conditions: Object.freeze([
              "runtime expansion or substitution determines part of the command",
            ]),
            state: "conditional",
          })
        : inference.uncertainty;
  return Object.freeze({
    confidence: inference.confidence,
    contractVersion: COMMAND_LEXER_CONTRACT_VERSION,
    invocations,
    issues: Object.freeze(state.issues),
    limits,
    metrics: Object.freeze({
      invocationCount: invocations.length,
      issueCount: state.issues.length,
      partCount: state.partCount,
      tokenCount: state.tokens.length,
    }),
    provenance: input.provenance,
    requestedDialect: input.dialect,
    resolvedDialect: inference.dialect,
    tokens: freezeTokens(state.tokens),
    uncertainty,
  });
}
