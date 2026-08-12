import { types as nodeTypes } from "node:util";

import { eastAsianWidth, eastAsianWidthType } from "get-east-asian-width";
import { isEmojiPresentation, isExtendedPictographic } from "unicode-segmenter/emoji";
import { GraphemeCategory, graphemeSegments } from "unicode-segmenter/grapheme";

import {
  MAX_OUTPUT_TEXT_BYTES,
  MAX_OUTPUT_TEXT_CODE_POINTS,
  MAX_TERMINAL_LINES,
  TERMINAL_OUTPUT_SCHEMA_VERSION,
  sanitizeOutputText,
  validateDiagnosticBundle,
  validateTerminalOutput,
} from "@agent-context/core";

import type {
  Diagnostic,
  DiagnosticBundle,
  DiagnosticSourceLocation,
  OutputSummary,
  RelatedEvidence,
  SourceDocument,
  TerminalOutput,
} from "@agent-context/core";

export const STYLISH_MIN_WIDTH = 20 as const;
export const STYLISH_MAX_WIDTH = 1_000 as const;
export const STYLISH_DEFAULT_WIDTH = 80 as const;
export const MAX_STYLISH_RELATED_LOCATIONS = 16 as const;
export const STYLISH_CELL_WIDTH_VERSION = "terminal-cell-v1" as const;

const MAX_FORMATTER_ISSUES = 256;
const LINE_RESERVE = 64;
const MAX_ISSUE_FIELD_CODE_POINTS = 512;
const ANSI_BYTE_RESERVE = 32;
const ANSI_CODE_POINT_RESERVE = 16;
const MAX_PLAIN_LINE_BYTES = MAX_OUTPUT_TEXT_BYTES - ANSI_BYTE_RESERVE;
const MAX_PLAIN_LINE_CODE_POINTS = MAX_OUTPUT_TEXT_CODE_POINTS - ANSI_CODE_POINT_RESERVE;
const OVER_BUDGET_CELL_MARKER = "�";
const ANSI = Object.freeze({
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
});

const OPTION_KEYS = new Set(["color", "failureThreshold", "terminalSupportsAnsi", "width"]);

export type StylishColorPolicy = "always" | "auto" | "never";
export type StylishFailureThreshold = "error" | "never" | "warning";

export interface StylishFormatterOptions {
  /** `auto` is deterministic: the caller supplies the terminal capability explicitly. */
  readonly color?: StylishColorPolicy;
  readonly failureThreshold?: StylishFailureThreshold;
  readonly terminalSupportsAnsi?: boolean;
  readonly width?: number;
}

export interface StylishFormatterIssue {
  readonly code: "invalid-diagnostics" | "invalid-options" | "resource-limit";
  readonly path: string;
  readonly message: string;
}

export type StylishFormatterResult =
  | {
      readonly ok: true;
      /** Validated B05 terminal model. ANSI, when enabled, is formatter-owned fixed SGR only. */
      readonly output: TerminalOutput;
      /** Exact bytes for stdout, ending in one LF unless the model is empty. */
      readonly text: string;
    }
  | { readonly ok: false; readonly issues: readonly StylishFormatterIssue[] };

interface ResolvedOptions {
  readonly colorMode: "ansi" | "never";
  readonly failureThreshold: StylishFailureThreshold;
  readonly width: number;
}

type LineRole =
  "error" | "info" | "message" | "path" | "related" | "suggestion" | "summary" | "warning";

interface PlainLine {
  readonly role: LineRole;
  readonly text: string;
}

interface RelatedLocation {
  readonly label: string;
  readonly location: DiagnosticSourceLocation;
}

function immutableIssue(
  code: StylishFormatterIssue["code"],
  path: string,
  message: string,
): StylishFormatterIssue {
  return Object.freeze({ code, path, message });
}

function failure(issue: StylishFormatterIssue): StylishFormatterResult {
  return Object.freeze({ ok: false, issues: Object.freeze([issue]) });
}

function boundedSafeText(value: string): string {
  return Array.from(sanitizeOutputText(value)).slice(0, MAX_ISSUE_FIELD_CODE_POINTS).join("");
}

function validateOptions(
  input: unknown,
):
  | { readonly ok: true; readonly value: ResolvedOptions }
  | { readonly ok: false; readonly issue: StylishFormatterIssue } {
  if (input === undefined) {
    return {
      ok: true,
      value: { colorMode: "never", failureThreshold: "error", width: STYLISH_DEFAULT_WIDTH },
    };
  }
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      nodeTypes.isProxy(input)
    ) {
      return {
        ok: false,
        issue: immutableIssue("invalid-options", "$options", "must be a plain data object"),
      };
    }
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return {
        ok: false,
        issue: immutableIssue("invalid-options", "$options", "must be a plain data object"),
      };
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length > OPTION_KEYS.size) {
      return {
        ok: false,
        issue: immutableIssue("invalid-options", "$options", "contains too many fields"),
      };
    }
    const values = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== "string") {
        return {
          ok: false,
          issue: immutableIssue("invalid-options", "$options", "symbol properties are not allowed"),
        };
      }
      if (!OPTION_KEYS.has(key)) {
        return {
          ok: false,
          issue: immutableIssue("invalid-options", "$options", "contains an unknown field"),
        };
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return {
          ok: false,
          issue: immutableIssue(
            "invalid-options",
            "$options",
            "accessor properties are not allowed",
          ),
        };
      }
      values.set(key, descriptor.value as unknown);
    }
    const width = values.has("width") ? values.get("width") : STYLISH_DEFAULT_WIDTH;
    const color = values.has("color") ? values.get("color") : "never";
    const terminalSupportsAnsi = values.has("terminalSupportsAnsi")
      ? values.get("terminalSupportsAnsi")
      : false;
    const failureThreshold = values.has("failureThreshold")
      ? values.get("failureThreshold")
      : "error";
    if (
      !Number.isSafeInteger(width) ||
      (width as number) < STYLISH_MIN_WIDTH ||
      (width as number) > STYLISH_MAX_WIDTH
    ) {
      return {
        ok: false,
        issue: immutableIssue(
          "invalid-options",
          "$options.width",
          `must be an integer from ${String(STYLISH_MIN_WIDTH)} through ${String(STYLISH_MAX_WIDTH)}`,
        ),
      };
    }
    if (color !== "always" && color !== "auto" && color !== "never") {
      return {
        ok: false,
        issue: immutableIssue(
          "invalid-options",
          "$options.color",
          "must be 'always', 'auto', or 'never'",
        ),
      };
    }
    if (typeof terminalSupportsAnsi !== "boolean") {
      return {
        ok: false,
        issue: immutableIssue(
          "invalid-options",
          "$options.terminalSupportsAnsi",
          "must be a boolean",
        ),
      };
    }
    if (
      failureThreshold !== "error" &&
      failureThreshold !== "warning" &&
      failureThreshold !== "never"
    ) {
      return {
        ok: false,
        issue: immutableIssue(
          "invalid-options",
          "$options.failureThreshold",
          "must be 'error', 'warning', or 'never'",
        ),
      };
    }
    return {
      ok: true,
      value: {
        colorMode:
          color === "always" || (color === "auto" && terminalSupportsAnsi) ? "ansi" : "never",
        failureThreshold,
        width: width as number,
      },
    };
  } catch {
    return {
      ok: false,
      issue: immutableIssue("invalid-options", "$options", "must be safely inspectable data"),
    };
  }
}

interface Cell {
  readonly byteLength: number;
  readonly codePoints: number;
  readonly text: string;
  readonly width: number;
}

function categoryOf(character: string): number {
  for (const segment of graphemeSegments(character)) return segment._catBegin;
  return GraphemeCategory.Any;
}

function isNonPrintingCategory(category: number): boolean {
  return (
    category === GraphemeCategory.CR ||
    category === GraphemeCategory.Control ||
    category === GraphemeCategory.Extend ||
    category === GraphemeCategory.LF ||
    category === GraphemeCategory.Prepend ||
    category === GraphemeCategory.ZWJ
  );
}

function cellWidth(segment: string): number {
  const scalars = Array.from(segment, (character) => ({
    category: categoryOf(character),
    codePoint: character.codePointAt(0) ?? 0,
  }));
  const baseIndex = scalars.findIndex((scalar) => !isNonPrintingCategory(scalar.category));
  if (baseIndex < 0) return 0;
  const base = scalars[baseIndex];
  if (base === undefined) return 0;
  const regionalIndicators = scalars.filter(
    (scalar) => scalar.category === GraphemeCategory.Regional_Indicator,
  ).length;
  const extendedPictographics = scalars.filter((scalar) =>
    isExtendedPictographic(scalar.codePoint),
  ).length;
  const emoji =
    isEmojiPresentation(base.codePoint) ||
    regionalIndicators >= 2 ||
    scalars.some((scalar) => scalar.codePoint === 0x20e3) ||
    (scalars.some((scalar) => scalar.codePoint === 0xfe0f) &&
      isExtendedPictographic(base.codePoint)) ||
    (scalars.some((scalar) => scalar.category === GraphemeCategory.ZWJ) &&
      extendedPictographics >= 2);
  if (emoji) return 2;

  let width = eastAsianWidth(base.codePoint, { ambiguousAsWide: false });
  for (const scalar of scalars.slice(baseIndex + 1)) {
    const widthType = eastAsianWidthType(scalar.codePoint);
    if (
      scalar.category === GraphemeCategory.SpacingMark ||
      widthType === "fullwidth" ||
      widthType === "halfwidth"
    )
      width += eastAsianWidth(scalar.codePoint, { ambiguousAsWide: false });
  }
  return width;
}

function terminalCells(value: string): readonly Cell[] {
  return Array.from(graphemeSegments(value), ({ segment }) => {
    const codePoints = Array.from(segment).length;
    const byteLength = Buffer.byteLength(segment, "utf8");
    return {
      byteLength,
      codePoints,
      text: segment,
      width:
        codePoints > MAX_PLAIN_LINE_CODE_POINTS || byteLength > MAX_PLAIN_LINE_BYTES
          ? Number.POSITIVE_INFINITY
          : cellWidth(segment),
    };
  });
}

function displayCell(cell: Cell, maximumWidth: number): Cell {
  if (
    cell.width < 1 ||
    cell.width > maximumWidth ||
    cell.byteLength > MAX_PLAIN_LINE_BYTES ||
    cell.codePoints > MAX_PLAIN_LINE_CODE_POINTS
  ) {
    return { byteLength: 3, codePoints: 1, text: OVER_BUDGET_CELL_MARKER, width: 1 };
  }
  return cell;
}

function hardWrap(
  value: string,
  maximumWidth: number,
  reservedBytes = 0,
  reservedCodePoints = 0,
): readonly string[] {
  if (value.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  let width = 0;
  let bytes = reservedBytes;
  let codePoints = reservedCodePoints;
  for (const rawCell of terminalCells(value)) {
    const cell = displayCell(rawCell, maximumWidth);
    if (
      line.length > 0 &&
      (width + cell.width > maximumWidth ||
        bytes + cell.byteLength > MAX_PLAIN_LINE_BYTES ||
        codePoints + cell.codePoints > MAX_PLAIN_LINE_CODE_POINTS)
    ) {
      lines.push(line);
      line = "";
      width = 0;
      bytes = reservedBytes;
      codePoints = reservedCodePoints;
    }
    line += cell.text;
    width += cell.width;
    bytes += cell.byteLength;
    codePoints += cell.codePoints;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function visibleWidth(value: string): number {
  return terminalCells(value).reduce((sum, cell) => sum + cell.width, 0);
}

/** Measure already-sanitized, ANSI-free text with the pinned terminal-cell-v1 profile. */
export function measureStylishTextWidth(value: string): number {
  return visibleWidth(value);
}

/** Internal layout primitive: never split one extended cluster, degrading it to `�` if needed. */
export function wrapStylishText(value: string, maximumWidth: number): readonly string[] {
  return hardWrap(value, maximumWidth);
}

function wrapText(value: string, width: number, prefix: string): readonly string[] {
  const available = Math.max(1, width - visibleWidth(prefix));
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const prefixCodePoints = Array.from(prefix).length;
  const words = value.split(/ +/u).filter((word) => word.length > 0);
  if (words.length === 0) return [prefix.trimEnd()];
  const chunks = words.flatMap((word) => hardWrap(word, available, prefixBytes, prefixCodePoints));
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  let lineBytes = prefixBytes;
  let lineCodePoints = prefixCodePoints;
  for (const chunk of chunks) {
    const chunkWidth = visibleWidth(chunk);
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    const chunkCodePoints = Array.from(chunk).length;
    const separator = line.length === 0 ? 0 : 1;
    if (
      line.length > 0 &&
      (lineWidth + separator + chunkWidth > available ||
        lineBytes + separator + chunkBytes > MAX_PLAIN_LINE_BYTES ||
        lineCodePoints + separator + chunkCodePoints > MAX_PLAIN_LINE_CODE_POINTS)
    ) {
      lines.push(`${prefix}${line}`);
      line = chunk;
      lineWidth = chunkWidth;
      lineBytes = prefixBytes + chunkBytes;
      lineCodePoints = prefixCodePoints + chunkCodePoints;
    } else {
      line += `${line.length === 0 ? "" : " "}${chunk}`;
      lineWidth += separator + chunkWidth;
      lineBytes += separator + chunkBytes;
      lineCodePoints += separator + chunkCodePoints;
    }
  }
  lines.push(`${prefix}${line}`);
  return lines;
}

function line(role: LineRole, text: string): PlainLine {
  return { role, text };
}

function sourceLocation(location: DiagnosticSourceLocation): string {
  return `${sanitizeOutputText(location.path)}:${String(location.range.start.line + 1)}:${String(location.range.start.utf16Column + 1)}`;
}

function addRelated(
  output: RelatedLocation[],
  label: string,
  locations: readonly DiagnosticSourceLocation[],
): number {
  let omitted = 0;
  for (const location of locations) {
    if (output.length < MAX_STYLISH_RELATED_LOCATIONS) output.push({ label, location });
    else omitted += 1;
  }
  return omitted;
}

function relatedLocations(evidence: readonly RelatedEvidence[]): {
  readonly locations: readonly RelatedLocation[];
  readonly omitted: number;
} {
  const output: RelatedLocation[] = [];
  let omitted = 0;
  for (const item of evidence) {
    if (item.kind === "source") omitted += addRelated(output, item.label, [item.location]);
    else if (item.kind === "repository-fact")
      omitted += addRelated(output, item.label, item.locations);
    else if (item.kind === "resolution")
      omitted += addRelated(output, item.label, item.sourceLocations);
  }
  return { locations: output, omitted };
}

function diagnosticLines(diagnostic: Diagnostic, width: number): readonly PlainLine[] {
  const output: PlainLine[] = [];
  for (const part of hardWrap(sourceLocation(diagnostic.primary), width))
    output.push(line("path", part));
  for (const part of wrapText(`${diagnostic.severity} ${diagnostic.ruleId}`, width, "  "))
    output.push(line(diagnostic.severity, part));
  for (const part of wrapText(sanitizeOutputText(diagnostic.message), width, "  "))
    output.push(line("message", part));

  const related = relatedLocations(diagnostic.related);
  for (const item of related.locations) {
    const text = `related ${sanitizeOutputText(item.label)}: ${sourceLocation(item.location)}`;
    for (const part of wrapText(text, width, "  ")) output.push(line("related", part));
  }
  if (related.omitted > 0) {
    for (const part of wrapText(
      `${String(related.omitted)} related locations omitted`,
      width,
      "  ",
    ))
      output.push(line("related", part));
  }
  if (diagnostic.suggestion !== null) {
    for (const part of wrapText(
      `suggestion: ${sanitizeOutputText(diagnostic.suggestion.message)}`,
      width,
      "  ",
    ))
      output.push(line("suggestion", part));
  }
  return output;
}

function activeDiagnostics(bundle: DiagnosticBundle): {
  readonly active: readonly Diagnostic[];
  readonly suppressed: number;
} {
  const suppressed = new Set(
    bundle.suppressions
      .filter((suppression) => suppression.state === "suppressed")
      .flatMap((suppression) => suppression.matchedPathFingerprints),
  );
  return {
    active: bundle.diagnostics.filter(
      (diagnostic) => !suppressed.has(diagnostic.fingerprints.path.value),
    ),
    suppressed: suppressed.size,
  };
}

function outputSummary(
  diagnostics: readonly Diagnostic[],
  suppressed: number,
  failureThreshold: StylishFailureThreshold,
): OutputSummary {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const infos = diagnostics.filter((diagnostic) => diagnostic.severity === "info").length;
  const failed =
    failureThreshold === "warning"
      ? errors + warnings > 0
      : failureThreshold === "error"
        ? errors > 0
        : false;
  return Object.freeze({ errors, warnings, infos, suppressed, exitCode: failed ? 1 : 0 });
}

function plural(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? "" : "s"}`;
}

function summaryLines(summary: OutputSummary, width: number): readonly PlainLine[] {
  const total = summary.errors + summary.warnings + summary.infos;
  const text = `${plural(total, "problem")} (${plural(summary.errors, "error")}, ${plural(summary.warnings, "warning")}, ${plural(summary.infos, "info")}, ${String(summary.suppressed)} suppressed)`;
  return wrapText(text, width, "").map((part) => line("summary", part));
}

function colorize(value: PlainLine, colorMode: "ansi" | "never"): string {
  if (colorMode === "never" || value.text.length === 0) return value.text;
  const start =
    value.role === "error"
      ? `${ANSI.bold}${ANSI.red}`
      : value.role === "warning"
        ? `${ANSI.bold}${ANSI.yellow}`
        : value.role === "info" || value.role === "path"
          ? `${ANSI.bold}${ANSI.cyan}`
          : value.role === "related"
            ? ANSI.dim
            : value.role === "suggestion"
              ? ANSI.green
              : value.role === "summary"
                ? ANSI.bold
                : "";
  return start.length === 0 ? value.text : `${start}${value.text}${ANSI.reset}`;
}

function render(
  diagnostics: readonly Diagnostic[],
  summary: OutputSummary,
  options: ResolvedOptions,
): readonly string[] {
  if (diagnostics.length === 0 && summary.suppressed === 0) return [];
  const summaryBlock = summaryLines(summary, options.width);
  const lines: PlainLine[] = [];
  let omitted = 0;
  for (const [index, diagnostic] of diagnostics.entries()) {
    const block = diagnosticLines(diagnostic, options.width);
    const separator = lines.length === 0 ? 0 : 1;
    if (
      lines.length + separator + block.length + summaryBlock.length >
      MAX_TERMINAL_LINES - LINE_RESERVE
    ) {
      omitted = diagnostics.length - index;
      break;
    }
    if (separator === 1) lines.push(line("message", ""));
    lines.push(...block);
  }
  if (omitted > 0) {
    if (lines.length > 0) lines.push(line("message", ""));
    for (const part of wrapText(
      `${String(omitted)} diagnostics omitted by output limit`,
      options.width,
      "",
    ))
      lines.push(line("related", part));
  }
  if (lines.length > 0) lines.push(line("message", ""));
  lines.push(...summaryBlock);
  return Object.freeze(lines.map((item) => colorize(item, options.colorMode)));
}

/**
 * Render a validated B04 diagnostic bundle without consulting process state, the filesystem, or
 * the network. Repository-controlled text is redacted and made inert before fixed formatter ANSI
 * is added. Diagnostic blocks preserve validated input array order; canonical scheduling,
 * deduplication, and stable sorting belong to the upstream F15 pipeline.
 */
export function formatStylishDiagnostics(
  input: unknown,
  sources: readonly SourceDocument[],
  options?: StylishFormatterOptions,
): StylishFormatterResult {
  const resolvedOptions = validateOptions(options);
  if (!resolvedOptions.ok) return failure(resolvedOptions.issue);
  try {
    const validation = validateDiagnosticBundle(input, sources);
    if (!validation.ok) {
      const issues = validation.issues
        .slice(0, MAX_FORMATTER_ISSUES)
        .map((issue) =>
          immutableIssue(
            "invalid-diagnostics",
            boundedSafeText(issue.path),
            `${boundedSafeText(issue.code)}: ${boundedSafeText(issue.message)}`,
          ),
        );
      return Object.freeze({ ok: false, issues: Object.freeze(issues) });
    }
    const selected = activeDiagnostics(validation.value);
    const summary = outputSummary(
      selected.active,
      selected.suppressed,
      resolvedOptions.value.failureThreshold,
    );
    const lines = render(selected.active, summary, resolvedOptions.value);
    const output: TerminalOutput = Object.freeze({
      recordKind: "agent-context-terminal-output",
      schemaVersion: TERMINAL_OUTPUT_SCHEMA_VERSION,
      colorMode: resolvedOptions.value.colorMode,
      width: resolvedOptions.value.width,
      lines,
      summary,
    });
    const outputValidation = validateTerminalOutput(output);
    if (!outputValidation.ok) {
      return failure(
        immutableIssue("resource-limit", "$", "constructed terminal output failed validation"),
      );
    }
    return Object.freeze({
      ok: true,
      output,
      text: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    });
  } catch {
    return failure(
      immutableIssue("invalid-diagnostics", "$", "diagnostics must be safely inspectable data"),
    );
  }
}
