import { createHash } from "node:crypto";

import {
  MAX_VALIDATION_ISSUES,
  VALIDATION_ISSUE_LIMIT_CODE,
  ValidationIssueLimitReached,
  validateJsonValue,
  validateUncertaintyValue,
} from "./contract-validation.js";
import {
  ACTIVATION_KINDS,
  AST_NODE_KINDS,
  IMPORT_KINDS,
  IMPORT_STATES,
  IMPORT_TARGET_KINDS,
  INSTRUCTION_IR_CONTRACT_VERSION,
  RESOLUTION_EVENT_KINDS,
} from "./ir-contracts.js";
import { REPOSITORY_ROOT, isRepositoryRelativePath } from "./repository-path.js";

import type {
  InstructionIr,
  InstructionIrValidationCode,
  InstructionIrValidationIssue,
  InstructionIrValidationResult,
  SourceDocument,
  SourcePosition,
  SourceRange,
  SourceRangeSliceResult,
  SourceRangeValidationResult,
} from "./ir-contracts.js";
import type { UncertaintyState } from "./profile-contracts.js";

type UnknownRecord = Record<string, unknown>;

interface SourceFacts {
  readonly id: string;
  readonly path: string;
  readonly text: string;
  readonly rootNodeId: string;
  readonly positions: SourcePositionIndex;
}

interface SourcePositionIndex {
  readonly byteOffsets: readonly number[];
  readonly lineStarts: readonly number[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const AST_NODE_KIND_SET: ReadonlySet<string> = new Set(AST_NODE_KINDS);
const IMPORT_KIND_SET: ReadonlySet<string> = new Set(IMPORT_KINDS);
const IMPORT_TARGET_KIND_SET: ReadonlySet<string> = new Set(IMPORT_TARGET_KINDS);
const IMPORT_STATE_SET: ReadonlySet<string> = new Set(IMPORT_STATES);
const ACTIVATION_KIND_SET: ReadonlySet<string> = new Set(ACTIVATION_KINDS);
const EVENT_KIND_SET: ReadonlySet<string> = new Set(RESOLUTION_EVENT_KINDS);
const PATH_EVENT_KINDS: ReadonlySet<string> = new Set([
  "reference-path",
  "read-path",
  "write-path",
  "list-directory",
  "directory-add",
]);

function addIssue(
  issues: InstructionIrValidationIssue[],
  code: InstructionIrValidationCode,
  path: string,
  message: string,
): void {
  if (issues.length >= MAX_VALIDATION_ISSUES - 1) {
    if (issues.length === MAX_VALIDATION_ISSUES - 1) {
      issues.push({
        code: VALIDATION_ISSUE_LIMIT_CODE,
        message: `validation stopped after ${String(MAX_VALIDATION_ISSUES - 1)} issues`,
        path: "$",
      });
    }
    throw new ValidationIssueLimitReached();
  }
  issues.push({ code, message, path });
}

function objectValue(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: InstructionIrValidationIssue[],
): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(issues, "invalid-value", path, "must be an object");
    return undefined;
  }
  const record = value as UnknownRecord;
  const allowed: ReadonlySet<string> = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      addIssue(issues, "unknown-field", `${path}.${key}`, "is not part of contract version 0.1.0");
  }
  return record;
}

function requiredString(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: InstructionIrValidationIssue[],
  allowEmpty = false,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    addIssue(issues, "missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    addIssue(
      issues,
      "invalid-value",
      `${path}.${key}`,
      allowEmpty ? "must be a string" : "must be a non-empty string",
    );
    return undefined;
  }
  return value;
}

function requiredIdentifier(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: InstructionIrValidationIssue[],
): string | undefined {
  const value = requiredString(record, key, path, issues);
  if (value !== undefined && !IDENTIFIER_PATTERN.test(value)) {
    addIssue(issues, "invalid-value", `${path}.${key}`, "must be a stable identifier");
    return undefined;
  }
  return value;
}

function requiredInteger(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: InstructionIrValidationIssue[],
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    addIssue(issues, "missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    addIssue(issues, "invalid-value", `${path}.${key}`, "must be a non-negative safe integer");
    return undefined;
  }
  return value;
}

function requiredBoolean(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: InstructionIrValidationIssue[],
): boolean | undefined {
  const value = record[key];
  if (value === undefined) addIssue(issues, "missing-field", `${path}.${key}`, "is required");
  else if (typeof value !== "boolean")
    addIssue(issues, "invalid-value", `${path}.${key}`, "must be a Boolean");
  else return value;
  return undefined;
}

function enumString(
  record: UnknownRecord,
  key: string,
  path: string,
  allowed: ReadonlySet<string>,
  issues: InstructionIrValidationIssue[],
): string | undefined {
  const value = requiredString(record, key, path, issues);
  if (value !== undefined && !allowed.has(value)) {
    addIssue(issues, "invalid-state", `${path}.${key}`, `has unsupported state '${value}'`);
    return undefined;
  }
  return value;
}

function requiredArray(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: InstructionIrValidationIssue[],
): readonly unknown[] | undefined {
  const value = record[key];
  if (value === undefined) addIssue(issues, "missing-field", `${path}.${key}`, "is required");
  else if (!Array.isArray(value))
    addIssue(issues, "invalid-value", `${path}.${key}`, "must be an array");
  else return value as unknown[];
  return undefined;
}

function identifierArray(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: InstructionIrValidationIssue[],
  minimum = 0,
): readonly string[] | undefined {
  const values = requiredArray(record, key, path, issues);
  if (values === undefined) return undefined;
  if (values.length < minimum)
    addIssue(
      issues,
      "invalid-value",
      `${path}.${key}`,
      `must contain at least ${String(minimum)} item(s)`,
    );
  const output: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const itemPath = `${path}.${key}[${String(index)}]`;
    if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
      addIssue(issues, "invalid-value", itemPath, "must be a stable identifier");
    } else {
      if (seen.has(value)) addIssue(issues, "duplicate-id", itemPath, `duplicates '${value}'`);
      seen.add(value);
      output.push(value);
    }
  }
  return output;
}

function nullableIdentifier(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: InstructionIrValidationIssue[],
): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    addIssue(
      issues,
      "missing-field",
      `${path}.${key}`,
      "is required and must be explicit when absent",
    );
    return undefined;
  }
  if (value === null) return null;
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    addIssue(issues, "invalid-value", `${path}.${key}`, "must be null or a stable identifier");
    return undefined;
  }
  return value;
}

function nullableString(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: InstructionIrValidationIssue[],
): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    addIssue(
      issues,
      "missing-field",
      `${path}.${key}`,
      "is required and must be explicit when absent",
    );
    return undefined;
  }
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    addIssue(issues, "invalid-value", `${path}.${key}`, "must be null or a non-empty string");
    return undefined;
  }
  return value;
}

function reportUncertainty(
  value: unknown,
  path: string,
  issues: InstructionIrValidationIssue[],
): UncertaintyState | undefined {
  return validateUncertaintyValue(value, path, (code, issuePath, message) => {
    addIssue(issues, code, issuePath, message);
  });
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function lineEndingOf(text: string): "none" | "lf" | "cr" | "crlf" | "mixed" {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") {
      if (text[index + 1] === "\n") {
        crlf += 1;
        index += 1;
      } else cr += 1;
    } else if (text[index] === "\n") lf += 1;
  }
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  if (cr > 0) return "cr";
  return crlf > 0 ? "crlf" : "lf";
}

function buildSourcePositionIndex(text: string): SourcePositionIndex {
  const byteOffsets = new Array<number>(text.length + 1);
  const lineStarts = [0];
  byteOffsets[0] = 0;
  let byteOffset = 0;
  for (let utf16Offset = 0; utf16Offset < text.length; utf16Offset += 1) {
    const unit = text.charCodeAt(utf16Offset);
    if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      utf16Offset + 1 < text.length &&
      text.charCodeAt(utf16Offset + 1) >= 0xdc00 &&
      text.charCodeAt(utf16Offset + 1) <= 0xdfff
    ) {
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
  return { byteOffsets, lineStarts };
}

function expectedPosition(
  positions: SourcePositionIndex,
  utf16Offset: number,
): SourcePosition | undefined {
  if (utf16Offset < 0 || utf16Offset >= positions.byteOffsets.length) return undefined;
  const byteOffset = positions.byteOffsets[utf16Offset];
  if (byteOffset === undefined || byteOffset < 0) return undefined;
  let low = 0;
  let high = positions.lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = positions.lineStarts[middle];
    if (lineStart !== undefined && lineStart <= utf16Offset) low = middle + 1;
    else high = middle;
  }
  const line = low - 1;
  const lastLineStart = positions.lineStarts[line];
  if (lastLineStart === undefined) return undefined;
  return {
    byteOffset,
    utf16Offset,
    line,
    utf16Column: utf16Offset - lastLineStart,
  };
}

function validatePosition(
  value: unknown,
  path: string,
  positions: SourcePositionIndex | undefined,
  issues: InstructionIrValidationIssue[],
): SourcePosition | undefined {
  const record = objectValue(
    value,
    path,
    ["byteOffset", "utf16Offset", "line", "utf16Column"],
    issues,
  );
  if (record === undefined) return undefined;
  const byteOffset = requiredInteger(record, "byteOffset", path, issues);
  const utf16Offset = requiredInteger(record, "utf16Offset", path, issues);
  const line = requiredInteger(record, "line", path, issues);
  const utf16Column = requiredInteger(record, "utf16Column", path, issues);
  if (
    byteOffset === undefined ||
    utf16Offset === undefined ||
    line === undefined ||
    utf16Column === undefined
  )
    return undefined;
  const position = { byteOffset, utf16Offset, line, utf16Column };
  if (positions !== undefined) {
    const expected = expectedPosition(positions, utf16Offset);
    if (expected === undefined) {
      addIssue(
        issues,
        "invalid-range",
        path,
        "UTF-16 offset is outside the source or splits a surrogate pair",
      );
    } else if (
      expected.byteOffset !== byteOffset ||
      expected.line !== line ||
      expected.utf16Column !== utf16Column
    )
      addIssue(
        issues,
        "invalid-range",
        path,
        "does not match the source's byte and UTF-16 coordinates",
      );
  }
  return position;
}

interface ValidatedRange {
  readonly sourceId: string;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

function validateRange(
  value: unknown,
  path: string,
  sources: ReadonlyMap<string, SourceFacts>,
  issues: InstructionIrValidationIssue[],
): ValidatedRange | undefined {
  const record = objectValue(value, path, ["sourceId", "start", "end"], issues);
  if (record === undefined) return undefined;
  const sourceId = requiredIdentifier(record, "sourceId", path, issues);
  const source = sourceId === undefined ? undefined : sources.get(sourceId);
  if (sourceId !== undefined && source === undefined)
    addIssue(issues, "invalid-relationship", `${path}.sourceId`, "references an unknown source");
  if (record["start"] === undefined)
    addIssue(issues, "missing-field", `${path}.start`, "is required");
  if (record["end"] === undefined) addIssue(issues, "missing-field", `${path}.end`, "is required");
  const start =
    record["start"] === undefined
      ? undefined
      : validatePosition(record["start"], `${path}.start`, source?.positions, issues);
  const end =
    record["end"] === undefined
      ? undefined
      : validatePosition(record["end"], `${path}.end`, source?.positions, issues);
  if (sourceId === undefined || start === undefined || end === undefined) return undefined;
  if (start.utf16Offset > end.utf16Offset || start.byteOffset > end.byteOffset)
    addIssue(issues, "invalid-range", path, "start must not follow end");
  return { sourceId, start, end };
}

function rangeContains(outer: ValidatedRange, inner: ValidatedRange): boolean {
  return (
    outer.sourceId === inner.sourceId &&
    outer.start.utf16Offset <= inner.start.utf16Offset &&
    outer.end.utf16Offset >= inner.end.utf16Offset
  );
}

function sourceSlice(
  source: SourceFacts | undefined,
  range: ValidatedRange | undefined,
): string | undefined {
  return source === undefined || range === undefined
    ? undefined
    : source.text.slice(range.start.utf16Offset, range.end.utf16Offset);
}

function collectRecords(
  record: UnknownRecord,
  key: string,
  issues: InstructionIrValidationIssue[],
): readonly unknown[] {
  return requiredArray(record, key, "$", issues) ?? [];
}

function collectIds(
  values: readonly unknown[],
  path: string,
  issues: InstructionIrValidationIssue[],
): Map<string, UnknownRecord> {
  const output = new Map<string, UnknownRecord>();
  for (const [index, value] of values.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as UnknownRecord;
    const id = item["id"];
    if (typeof id !== "string" || !IDENTIFIER_PATTERN.test(id)) continue;
    if (output.has(id))
      addIssue(issues, "duplicate-id", `${path}[${String(index)}].id`, `duplicates '${id}'`);
    else output.set(id, item);
  }
  return output;
}

function validateSource(
  value: unknown,
  path: string,
  issues: InstructionIrValidationIssue[],
): SourceFacts | undefined {
  const record = objectValue(
    value,
    path,
    [
      "id",
      "path",
      "encoding",
      "bom",
      "text",
      "byteLength",
      "utf16Length",
      "sha256",
      "lineEnding",
      "parseState",
      "rootNodeId",
    ],
    issues,
  );
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, issues);
  const sourcePath = requiredString(record, "path", path, issues);
  if (
    sourcePath !== undefined &&
    (!isRepositoryRelativePath(sourcePath) || sourcePath === REPOSITORY_ROOT)
  )
    addIssue(
      issues,
      "invalid-path",
      `${path}.path`,
      "must be a canonical repository-relative file path",
    );
  const encoding = requiredString(record, "encoding", path, issues);
  if (encoding !== undefined && encoding !== "utf-8")
    addIssue(issues, "invalid-state", `${path}.encoding`, "must equal 'utf-8'");
  const bom = enumString(record, "bom", path, new Set(["none", "utf-8"]), issues);
  const text = requiredString(record, "text", path, issues, true);
  const byteLength = requiredInteger(record, "byteLength", path, issues);
  const utf16Length = requiredInteger(record, "utf16Length", path, issues);
  const sha256 = requiredString(record, "sha256", path, issues);
  const lineEnding = enumString(
    record,
    "lineEnding",
    path,
    new Set(["none", "lf", "cr", "crlf", "mixed"]),
    issues,
  );
  const rootNodeId = requiredIdentifier(record, "rootNodeId", path, issues);
  const parseState = objectValue(
    record["parseState"],
    `${path}.parseState`,
    ["state", "reason"],
    issues,
  );
  if (parseState !== undefined) {
    const state = enumString(
      parseState,
      "state",
      `${path}.parseState`,
      new Set(["complete", "partial", "malformed"]),
      issues,
    );
    if (state === "complete" && parseState["reason"] !== undefined)
      addIssue(
        issues,
        "invalid-value",
        `${path}.parseState.reason`,
        "is not allowed for complete parsing",
      );
    if (
      (state === "partial" || state === "malformed") &&
      requiredString(parseState, "reason", `${path}.parseState`, issues) === undefined
    ) {
      // The helper recorded the precise issue.
    }
  }
  if (text !== undefined) {
    if (!hasWellFormedUnicode(text))
      addIssue(issues, "invalid-value", `${path}.text`, "must contain well-formed Unicode");
    if (byteLength !== undefined && Buffer.byteLength(text, "utf8") !== byteLength)
      addIssue(
        issues,
        "invalid-value",
        `${path}.byteLength`,
        "does not equal the UTF-8 byte length",
      );
    if (utf16Length !== undefined && text.length !== utf16Length)
      addIssue(
        issues,
        "invalid-value",
        `${path}.utf16Length`,
        "does not equal the JavaScript UTF-16 length",
      );
    if (
      sha256 !== undefined &&
      (!SHA256_PATTERN.test(sha256) || createHash("sha256").update(text).digest("hex") !== sha256)
    )
      addIssue(
        issues,
        "invalid-digest",
        `${path}.sha256`,
        "must be the lowercase SHA-256 digest of the exact source text",
      );
    if (lineEnding !== undefined && lineEndingOf(text) !== lineEnding)
      addIssue(
        issues,
        "invalid-value",
        `${path}.lineEnding`,
        "does not match the exact source line endings",
      );
    if (bom !== undefined && (text.startsWith("\uFEFF") ? "utf-8" : "none") !== bom)
      addIssue(
        issues,
        "invalid-value",
        `${path}.bom`,
        "must describe whether the exact decoded text begins with a UTF-8 BOM marker",
      );
  }
  return id === undefined ||
    sourcePath === undefined ||
    text === undefined ||
    rootNodeId === undefined
    ? undefined
    : { id, path: sourcePath, text, rootNodeId, positions: buildSourcePositionIndex(text) };
}

interface NodeFacts {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: string;
  readonly range: ValidatedRange;
  readonly childIds: readonly string[];
}

function validateNode(
  value: unknown,
  path: string,
  sources: ReadonlyMap<string, SourceFacts>,
  issues: InstructionIrValidationIssue[],
): NodeFacts | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(issues, "invalid-value", path, "must be an object");
    return undefined;
  }
  const raw = value as UnknownRecord;
  const kindValue = raw["kind"];
  const extraKeys =
    kindValue === "heading"
      ? ["depth"]
      : kindValue === "list"
        ? ["ordered", "start"]
        : kindValue === "code-block"
          ? ["language", "metadata"]
          : kindValue === "link"
            ? ["destination", "title"]
            : kindValue === "frontmatter"
              ? ["format"]
              : kindValue === "unknown"
                ? ["syntaxKind", "reason"]
                : [];
  const record = objectValue(
    value,
    path,
    ["id", "sourceId", "kind", "range", "childIds", ...extraKeys],
    issues,
  );
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, issues);
  const sourceId = requiredIdentifier(record, "sourceId", path, issues);
  const kind = enumString(record, "kind", path, AST_NODE_KIND_SET, issues);
  const range =
    record["range"] === undefined
      ? (addIssue(issues, "missing-field", `${path}.range`, "is required"), undefined)
      : validateRange(record["range"], `${path}.range`, sources, issues);
  const childIds = identifierArray(record, "childIds", path, issues) ?? [];
  if (range !== undefined && sourceId !== undefined && range.sourceId !== sourceId)
    addIssue(
      issues,
      "invalid-relationship",
      `${path}.range.sourceId`,
      "must equal the node sourceId",
    );
  if (kind === "heading") {
    const depth = requiredInteger(record, "depth", path, issues);
    if (depth !== undefined && (depth < 1 || depth > 6))
      addIssue(issues, "invalid-value", `${path}.depth`, "must be between 1 and 6");
  } else if (kind === "list") {
    const ordered = requiredBoolean(record, "ordered", path, issues);
    const start = record["start"];
    if (start === undefined)
      addIssue(issues, "missing-field", `${path}.start`, "is required and must be explicit");
    else if (
      start !== null &&
      (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1)
    )
      addIssue(issues, "invalid-value", `${path}.start`, "must be null or a positive safe integer");
    if (ordered === false && start !== null)
      addIssue(issues, "invalid-state", `${path}.start`, "must be null for an unordered list");
    if (ordered === true && start === null)
      addIssue(issues, "invalid-state", `${path}.start`, "must be present for an ordered list");
  } else if (kind === "code-block") {
    nullableString(record, "language", path, issues);
    nullableString(record, "metadata", path, issues);
  } else if (kind === "link") {
    requiredString(record, "destination", path, issues, true);
    nullableString(record, "title", path, issues);
  } else if (kind === "frontmatter") {
    enumString(record, "format", path, new Set(["yaml", "mdc"]), issues);
  } else if (kind === "unknown") {
    requiredString(record, "syntaxKind", path, issues);
    requiredString(record, "reason", path, issues);
  }
  return id === undefined || sourceId === undefined || kind === undefined || range === undefined
    ? undefined
    : { id, sourceId, kind, range, childIds };
}

function validateAstRelationships(
  nodes: ReadonlyMap<string, NodeFacts>,
  sources: ReadonlyMap<string, SourceFacts>,
  issues: InstructionIrValidationIssue[],
): ReadonlyMap<string, string> {
  const parentByChild = new Map<string, string>();
  for (const node of nodes.values()) {
    let previous: NodeFacts | undefined;
    for (const [index, childId] of node.childIds.entries()) {
      const child = nodes.get(childId);
      const childPath = `$.nodes[id=${node.id}].childIds[${String(index)}]`;
      if (child === undefined) {
        addIssue(issues, "invalid-relationship", childPath, "references an unknown AST node");
        continue;
      }
      if (child.sourceId !== node.sourceId)
        addIssue(
          issues,
          "invalid-relationship",
          childPath,
          "must reference a node in the same source",
        );
      if (!rangeContains(node.range, child.range))
        addIssue(issues, "invalid-range", childPath, "child range must be contained by its parent");
      if (previous !== undefined && previous.range.end.utf16Offset > child.range.start.utf16Offset)
        addIssue(
          issues,
          "invalid-range",
          childPath,
          "siblings must be ordered and non-overlapping",
        );
      const priorParent = parentByChild.get(childId);
      if (priorParent !== undefined && priorParent !== node.id)
        addIssue(
          issues,
          "invalid-relationship",
          childPath,
          `node already has parent '${priorParent}'`,
        );
      else parentByChild.set(childId, node.id);
      previous = child;
    }
  }

  const rootsBySource = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.kind !== "root") continue;
    const roots = rootsBySource.get(node.sourceId) ?? [];
    roots.push(node.id);
    rootsBySource.set(node.sourceId, roots);
  }

  interface WalkFrame {
    entered: boolean;
    id: string;
    nextChild: number;
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (rootId: string): void => {
    const stack: WalkFrame[] = [{ entered: false, id: rootId, nextChild: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) continue;
      if (!frame.entered) {
        if (visited.has(frame.id)) {
          stack.pop();
          continue;
        }
        if (visiting.has(frame.id)) {
          addIssue(
            issues,
            "invalid-relationship",
            `$.nodes[id=${frame.id}].childIds`,
            "AST must not contain a cycle",
          );
          stack.pop();
          continue;
        }
        frame.entered = true;
        visiting.add(frame.id);
      }
      const children = nodes.get(frame.id)?.childIds ?? [];
      const childId = children[frame.nextChild];
      if (childId !== undefined) {
        frame.nextChild += 1;
        if (nodes.has(childId)) stack.push({ entered: false, id: childId, nextChild: 0 });
        continue;
      }
      visiting.delete(frame.id);
      visited.add(frame.id);
      stack.pop();
    }
  };
  for (const source of sources.values()) {
    const sourceRoots = rootsBySource.get(source.id) ?? [];
    if (sourceRoots.length !== 1 || sourceRoots[0] !== source.rootNodeId)
      addIssue(
        issues,
        "invalid-relationship",
        `$.sources[id=${source.id}].rootNodeId`,
        "must nominate the source's only root-kind AST node",
      );
    const root = nodes.get(source.rootNodeId);
    if (root === undefined) {
      addIssue(
        issues,
        "invalid-relationship",
        `$.sources[id=${source.id}].rootNodeId`,
        "references an unknown AST node",
      );
      continue;
    }
    if (root.kind !== "root" || root.sourceId !== source.id)
      addIssue(
        issues,
        "invalid-relationship",
        `$.sources[id=${source.id}].rootNodeId`,
        "must reference the root node for this source",
      );
    if (root.range.start.utf16Offset !== 0 || root.range.end.utf16Offset !== source.text.length)
      addIssue(
        issues,
        "invalid-range",
        `$.nodes[id=${root.id}].range`,
        "root range must cover the exact source text",
      );
    walk(root.id);
  }
  for (const node of nodes.values()) {
    if (!visited.has(node.id))
      addIssue(
        issues,
        "invalid-relationship",
        `$.nodes[id=${node.id}]`,
        "must be reachable from its source root",
      );
  }
  return parentByChild;
}

interface DocumentFacts {
  readonly id: string;
  readonly sourceId: string;
  readonly rootNodeId: string;
  readonly importIds: readonly string[];
  readonly statementIds: readonly string[];
  readonly activationRuleIds: readonly string[];
}

function validateDocument(
  value: unknown,
  path: string,
  sources: ReadonlyMap<string, SourceFacts>,
  nodes: ReadonlyMap<string, NodeFacts>,
  issues: InstructionIrValidationIssue[],
): DocumentFacts | undefined {
  const record = objectValue(
    value,
    path,
    [
      "id",
      "sourceId",
      "formatId",
      "scopeRoot",
      "rootNodeId",
      "importIds",
      "statementIds",
      "activationRuleIds",
    ],
    issues,
  );
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, issues);
  const sourceId = requiredIdentifier(record, "sourceId", path, issues);
  requiredIdentifier(record, "formatId", path, issues);
  const scopeRoot = requiredString(record, "scopeRoot", path, issues);
  if (scopeRoot !== undefined && !isRepositoryRelativePath(scopeRoot))
    addIssue(
      issues,
      "invalid-path",
      `${path}.scopeRoot`,
      "must be a canonical repository-relative path",
    );
  const rootNodeId = requiredIdentifier(record, "rootNodeId", path, issues);
  const importIds = identifierArray(record, "importIds", path, issues) ?? [];
  const statementIds = identifierArray(record, "statementIds", path, issues) ?? [];
  const activationRuleIds = identifierArray(record, "activationRuleIds", path, issues) ?? [];
  const source = sourceId === undefined ? undefined : sources.get(sourceId);
  if (sourceId !== undefined && source === undefined)
    addIssue(issues, "invalid-relationship", `${path}.sourceId`, "references an unknown source");
  const root = rootNodeId === undefined ? undefined : nodes.get(rootNodeId);
  if (rootNodeId !== undefined && root === undefined)
    addIssue(
      issues,
      "invalid-relationship",
      `${path}.rootNodeId`,
      "references an unknown AST node",
    );
  if (source !== undefined && rootNodeId !== source.rootNodeId)
    addIssue(
      issues,
      "invalid-relationship",
      `${path}.rootNodeId`,
      "must equal the source root node",
    );
  return id === undefined || sourceId === undefined || rootNodeId === undefined
    ? undefined
    : { id, sourceId, rootNodeId, importIds, statementIds, activationRuleIds };
}

interface ImportFacts {
  readonly id: string;
  readonly documentId: string;
}

function validateImport(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, DocumentFacts>,
  nodes: ReadonlyMap<string, NodeFacts>,
  sources: ReadonlyMap<string, SourceFacts>,
  issues: InstructionIrValidationIssue[],
): ImportFacts | undefined {
  const record = objectValue(
    value,
    path,
    [
      "id",
      "documentId",
      "nodeId",
      "kind",
      "range",
      "specifierRange",
      "rawSpecifier",
      "targetKind",
      "state",
      "uncertainty",
    ],
    issues,
  );
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, issues);
  const documentId = requiredIdentifier(record, "documentId", path, issues);
  const nodeId = requiredIdentifier(record, "nodeId", path, issues);
  enumString(record, "kind", path, IMPORT_KIND_SET, issues);
  const range =
    record["range"] === undefined
      ? (addIssue(issues, "missing-field", `${path}.range`, "is required"), undefined)
      : validateRange(record["range"], `${path}.range`, sources, issues);
  const specifierRange =
    record["specifierRange"] === undefined
      ? (addIssue(issues, "missing-field", `${path}.specifierRange`, "is required"), undefined)
      : validateRange(record["specifierRange"], `${path}.specifierRange`, sources, issues);
  const rawSpecifier = requiredString(record, "rawSpecifier", path, issues, true);
  const targetKind = enumString(record, "targetKind", path, IMPORT_TARGET_KIND_SET, issues);
  const state = enumString(record, "state", path, IMPORT_STATE_SET, issues);
  const uncertainty =
    record["uncertainty"] === undefined
      ? (addIssue(issues, "missing-field", `${path}.uncertainty`, "is required"), undefined)
      : reportUncertainty(record["uncertainty"], `${path}.uncertainty`, issues);
  const document = documentId === undefined ? undefined : documents.get(documentId);
  if (documentId !== undefined && document === undefined)
    addIssue(
      issues,
      "invalid-relationship",
      `${path}.documentId`,
      "references an unknown instruction document",
    );
  const node = nodeId === undefined ? undefined : nodes.get(nodeId);
  if (nodeId !== undefined && node === undefined)
    addIssue(issues, "invalid-relationship", `${path}.nodeId`, "references an unknown AST node");
  if (range !== undefined && specifierRange !== undefined && !rangeContains(range, specifierRange))
    addIssue(
      issues,
      "invalid-range",
      `${path}.specifierRange`,
      "must be contained by the import token range",
    );
  if (node !== undefined && range !== undefined && !rangeContains(node.range, range))
    addIssue(
      issues,
      "invalid-range",
      `${path}.range`,
      "must be contained by the referenced AST node",
    );
  if (document !== undefined && range !== undefined && range.sourceId !== document.sourceId)
    addIssue(
      issues,
      "invalid-relationship",
      `${path}.range.sourceId`,
      "must belong to the document source",
    );
  const slice =
    specifierRange === undefined
      ? undefined
      : sourceSlice(sources.get(specifierRange.sourceId), specifierRange);
  if (slice !== undefined && rawSpecifier !== undefined && slice !== rawSpecifier)
    addIssue(
      issues,
      "invalid-range",
      `${path}.rawSpecifier`,
      "must equal the exact specifier source slice",
    );
  if (state !== "malformed" && rawSpecifier === "")
    addIssue(
      issues,
      "invalid-state",
      `${path}.rawSpecifier`,
      "may be empty only for a malformed import",
    );
  if ((state === "ambiguous" || targetKind === "unknown") && uncertainty === "known")
    addIssue(
      issues,
      "invalid-state",
      `${path}.uncertainty.state`,
      "ambiguous or unknown imports cannot be marked known",
    );
  return id === undefined || documentId === undefined ? undefined : { id, documentId };
}

interface StatementFacts {
  readonly id: string;
  readonly documentId: string;
}

function validateStatement(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, DocumentFacts>,
  nodes: ReadonlyMap<string, NodeFacts>,
  nodeParents: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, SourceFacts>,
  issues: InstructionIrValidationIssue[],
): StatementFacts | undefined {
  const record = objectValue(
    value,
    path,
    ["id", "documentId", "nodeIds", "range", "text", "classification"],
    issues,
  );
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, issues);
  const documentId = requiredIdentifier(record, "documentId", path, issues);
  const nodeIds = identifierArray(record, "nodeIds", path, issues, 1) ?? [];
  const range =
    record["range"] === undefined
      ? (addIssue(issues, "missing-field", `${path}.range`, "is required"), undefined)
      : validateRange(record["range"], `${path}.range`, sources, issues);
  const text = requiredString(record, "text", path, issues, true);
  const classificationValue = record["classification"];
  if (classificationValue === undefined)
    addIssue(issues, "missing-field", `${path}.classification`, "is required");
  else {
    const classificationState =
      classificationValue !== null &&
      typeof classificationValue === "object" &&
      !Array.isArray(classificationValue)
        ? (classificationValue as UnknownRecord)["state"]
        : undefined;
    const keys =
      classificationState === "classified"
        ? [
            "state",
            "normalizedText",
            "categoryId",
            "modality",
            "subject",
            "action",
            "object",
            "confidence",
          ]
        : ["state"];
    const classification = objectValue(classificationValue, `${path}.classification`, keys, issues);
    if (classification !== undefined) {
      const state = enumString(
        classification,
        "state",
        `${path}.classification`,
        new Set(["unclassified", "classified"]),
        issues,
      );
      if (state === "classified") {
        requiredString(classification, "normalizedText", `${path}.classification`, issues);
        requiredIdentifier(classification, "categoryId", `${path}.classification`, issues);
        enumString(
          classification,
          "modality",
          `${path}.classification`,
          new Set(["must", "must-not", "should", "preference", "information"]),
          issues,
        );
        nullableString(classification, "subject", `${path}.classification`, issues);
        nullableString(classification, "action", `${path}.classification`, issues);
        nullableString(classification, "object", `${path}.classification`, issues);
        const confidence = classification["confidence"];
        if (
          typeof confidence !== "number" ||
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > 1
        )
          addIssue(
            issues,
            "invalid-value",
            `${path}.classification.confidence`,
            "must be a finite number between 0 and 1",
          );
      }
    }
  }
  const document = documentId === undefined ? undefined : documents.get(documentId);
  if (documentId !== undefined && document === undefined)
    addIssue(
      issues,
      "invalid-relationship",
      `${path}.documentId`,
      "references an unknown instruction document",
    );
  if (document !== undefined && range !== undefined && range.sourceId !== document.sourceId)
    addIssue(
      issues,
      "invalid-relationship",
      `${path}.range.sourceId`,
      "must belong to the document source",
    );
  let previousNode: NodeFacts | undefined;
  let contributingParent: string | undefined;
  for (const [index, nodeId] of nodeIds.entries()) {
    const node = nodes.get(nodeId);
    if (node === undefined)
      addIssue(
        issues,
        "invalid-relationship",
        `${path}.nodeIds[${String(index)}]`,
        "references an unknown AST node",
      );
    else {
      const nodePath = `${path}.nodeIds[${String(index)}]`;
      if (range !== undefined && !rangeContains(range, node.range))
        addIssue(
          issues,
          "invalid-range",
          nodePath,
          "contributing node must be inside the statement range",
        );
      const parent = nodeParents.get(nodeId);
      if (index === 0) contributingParent = parent;
      else if (parent === undefined || parent !== contributingParent)
        addIssue(
          issues,
          "invalid-relationship",
          nodePath,
          "contributing nodes must be siblings with the same parent",
        );
      if (
        previousNode !== undefined &&
        previousNode.range.end.utf16Offset > node.range.start.utf16Offset
      )
        addIssue(
          issues,
          "invalid-range",
          nodePath,
          "contributing nodes must be ordered and non-overlapping",
        );
      previousNode = node;
    }
  }
  const slice = range === undefined ? undefined : sourceSlice(sources.get(range.sourceId), range);
  if (slice !== undefined && text !== undefined && slice !== text)
    addIssue(
      issues,
      "invalid-range",
      `${path}.text`,
      "must equal the exact statement source slice",
    );
  return id === undefined || documentId === undefined ? undefined : { id, documentId };
}

interface ActivationFacts {
  readonly id: string;
  readonly documentId: string;
}

function validateSelector(
  value: unknown,
  path: string,
  document: DocumentFacts | undefined,
  sources: ReadonlyMap<string, SourceFacts>,
  issues: InstructionIrValidationIssue[],
): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(issues, "invalid-value", path, "must be an object");
    return undefined;
  }
  const raw = value as UnknownRecord;
  const kind = raw["kind"];
  const keys =
    kind === "directory-tree"
      ? ["kind", "path", "sourceRange"]
      : ["kind", "pattern", "dialectId", "sourceRange", "uncertainty"];
  const record = objectValue(value, path, keys, issues);
  if (record === undefined) return undefined;
  const selectorKind = enumString(
    record,
    "kind",
    path,
    new Set(["directory-tree", "glob"]),
    issues,
  );
  if (selectorKind === "directory-tree") {
    const selectorPath = requiredString(record, "path", path, issues);
    if (selectorPath !== undefined && !isRepositoryRelativePath(selectorPath))
      addIssue(
        issues,
        "invalid-path",
        `${path}.path`,
        "must be a canonical repository-relative path",
      );
  } else if (selectorKind === "glob") {
    requiredString(record, "pattern", path, issues);
    const dialectId = nullableIdentifier(record, "dialectId", path, issues);
    const state =
      record["uncertainty"] === undefined
        ? (addIssue(issues, "missing-field", `${path}.uncertainty`, "is required"), undefined)
        : reportUncertainty(record["uncertainty"], `${path}.uncertainty`, issues);
    if (dialectId === null && state === "known")
      addIssue(
        issues,
        "invalid-state",
        `${path}.uncertainty.state`,
        "a missing glob dialect cannot be marked known",
      );
  }
  const sourceRange = record["sourceRange"];
  if (sourceRange === undefined)
    addIssue(issues, "missing-field", `${path}.sourceRange`, "is required and must be explicit");
  else if (sourceRange !== null) {
    const range = validateRange(sourceRange, `${path}.sourceRange`, sources, issues);
    if (range !== undefined && document !== undefined && range.sourceId !== document.sourceId)
      addIssue(
        issues,
        "invalid-relationship",
        `${path}.sourceRange.sourceId`,
        "must belong to the activation document",
      );
  }
  return selectorKind;
}

function validateActivation(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, DocumentFacts>,
  sources: ReadonlyMap<string, SourceFacts>,
  issues: InstructionIrValidationIssue[],
): ActivationFacts | undefined {
  const record = objectValue(
    value,
    path,
    [
      "id",
      "documentId",
      "profileId",
      "surfaceId",
      "specSnapshotId",
      "kind",
      "scopeRoot",
      "include",
      "exclude",
      "conditions",
      "unknownReason",
      "evidenceRefs",
      "uncertainty",
    ],
    issues,
  );
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, issues);
  const documentId = requiredIdentifier(record, "documentId", path, issues);
  requiredIdentifier(record, "profileId", path, issues);
  requiredIdentifier(record, "surfaceId", path, issues);
  requiredIdentifier(record, "specSnapshotId", path, issues);
  const kind = enumString(record, "kind", path, ACTIVATION_KIND_SET, issues);
  const scopeRoot = requiredString(record, "scopeRoot", path, issues);
  if (scopeRoot !== undefined && !isRepositoryRelativePath(scopeRoot))
    addIssue(
      issues,
      "invalid-path",
      `${path}.scopeRoot`,
      "must be a canonical repository-relative path",
    );
  const document = documentId === undefined ? undefined : documents.get(documentId);
  if (documentId !== undefined && document === undefined)
    addIssue(
      issues,
      "invalid-relationship",
      `${path}.documentId`,
      "references an unknown instruction document",
    );
  const include = requiredArray(record, "include", path, issues) ?? [];
  const exclude = requiredArray(record, "exclude", path, issues) ?? [];
  const includeKinds = include.map((selector, index) =>
    validateSelector(selector, `${path}.include[${String(index)}]`, document, sources, issues),
  );
  exclude.forEach((selector, index) =>
    validateSelector(selector, `${path}.exclude[${String(index)}]`, document, sources, issues),
  );
  const conditions = requiredArray(record, "conditions", path, issues) ?? [];
  const seenConditions = new Set<string>();
  for (const [index, condition] of conditions.entries()) {
    if (typeof condition !== "string" || condition.length === 0)
      addIssue(
        issues,
        "invalid-value",
        `${path}.conditions[${String(index)}]`,
        "must be a non-empty string",
      );
    else if (seenConditions.has(condition))
      addIssue(
        issues,
        "duplicate-id",
        `${path}.conditions[${String(index)}]`,
        "duplicates an activation condition",
      );
    else seenConditions.add(condition);
  }
  const unknownReason = nullableString(record, "unknownReason", path, issues);
  const evidence = requiredArray(record, "evidenceRefs", path, issues) ?? [];
  if (evidence.length === 0)
    addIssue(
      issues,
      "invalid-value",
      `${path}.evidenceRefs`,
      "must contain at least one evidence reference",
    );
  const evidencePairs = new Set<string>();
  for (const [index, evidenceValue] of evidence.entries()) {
    const evidencePath = `${path}.evidenceRefs[${String(index)}]`;
    const item = objectValue(evidenceValue, evidencePath, ["sourceId", "factId"], issues);
    if (item === undefined) continue;
    const sourceId = requiredIdentifier(item, "sourceId", evidencePath, issues);
    const factId = nullableIdentifier(item, "factId", evidencePath, issues);
    if (sourceId !== undefined && factId !== undefined) {
      const pair = `${sourceId}\0${factId ?? ""}`;
      if (evidencePairs.has(pair))
        addIssue(issues, "duplicate-id", evidencePath, "duplicates an evidence reference");
      evidencePairs.add(pair);
    }
  }
  const uncertainty =
    record["uncertainty"] === undefined
      ? (addIssue(issues, "missing-field", `${path}.uncertainty`, "is required"), undefined)
      : reportUncertainty(record["uncertainty"], `${path}.uncertainty`, issues);
  if (kind === "always" && conditions.length > 0)
    addIssue(
      issues,
      "invalid-state",
      `${path}.conditions`,
      "always activation cannot declare conditions",
    );
  if (kind === "directory-tree" && !includeKinds.includes("directory-tree"))
    addIssue(
      issues,
      "invalid-state",
      `${path}.include`,
      "directory-tree activation requires a directory selector",
    );
  if (kind === "glob" && !includeKinds.includes("glob"))
    addIssue(
      issues,
      "invalid-state",
      `${path}.include`,
      "glob activation requires a glob selector",
    );
  if (kind === "conditional" && conditions.length === 0)
    addIssue(
      issues,
      "invalid-state",
      `${path}.conditions`,
      "conditional activation requires at least one condition",
    );
  if (kind === "unknown") {
    if (unknownReason === null)
      addIssue(
        issues,
        "invalid-state",
        `${path}.unknownReason`,
        "unknown activation requires a reason",
      );
    if (uncertainty === "known")
      addIssue(
        issues,
        "invalid-state",
        `${path}.uncertainty.state`,
        "unknown activation cannot be marked known",
      );
  } else if (unknownReason !== null && unknownReason !== undefined)
    addIssue(
      issues,
      "invalid-state",
      `${path}.unknownReason`,
      "is only allowed for unknown activation",
    );
  return id === undefined || documentId === undefined ? undefined : { id, documentId };
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) return true;
  }
  return false;
}

interface TargetFacts {
  readonly id: string;
}

function validateTarget(
  value: unknown,
  path: string,
  issues: InstructionIrValidationIssue[],
): TargetFacts | undefined {
  const record = objectValue(value, path, ["id", "path", "purpose"], issues);
  if (record === undefined) return undefined;
  const id = requiredIdentifier(record, "id", path, issues);
  const targetPath = requiredString(record, "path", path, issues);
  if (
    targetPath !== undefined &&
    (!isRepositoryRelativePath(targetPath) || targetPath === REPOSITORY_ROOT)
  )
    addIssue(
      issues,
      "invalid-path",
      `${path}.path`,
      "must be a canonical repository-relative file path",
    );
  requiredString(record, "purpose", path, issues);
  return id === undefined ? undefined : { id };
}

function validateSettings(
  value: unknown,
  path: string,
  issues: InstructionIrValidationIssue[],
): readonly unknown[] {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      value === undefined ? "missing-field" : "invalid-value",
      path,
      value === undefined ? "is required" : "must be an array",
    );
    return [];
  }
  const settingKeys = new Set<string>();
  for (const [index, settingValue] of value.entries()) {
    const settingPath = `${path}[${String(index)}]`;
    const setting = objectValue(settingValue, settingPath, ["key", "value"], issues);
    if (setting === undefined) continue;
    const key = requiredString(setting, "key", settingPath, issues);
    if (key !== undefined) {
      if (hasControl(key))
        addIssue(
          issues,
          "invalid-value",
          `${settingPath}.key`,
          "must not contain control characters",
        );
      if (settingKeys.has(key))
        addIssue(issues, "duplicate-id", `${settingPath}.key`, `duplicates '${key}'`);
      settingKeys.add(key);
    }
    if (setting["value"] === undefined)
      addIssue(issues, "missing-field", `${settingPath}.value`, "is required");
    else
      validateJsonValue(setting["value"], `${settingPath}.value`, (code, issuePath, message) => {
        addIssue(issues, code === "invalid-value" ? "invalid-json" : code, issuePath, message);
      });
  }
  return value;
}

function validateEvent(
  value: unknown,
  path: string,
  expectedSequence: number,
  activationRules: ReadonlyMap<string, ActivationFacts>,
  targets: ReadonlyMap<string, TargetFacts>,
  issues: InstructionIrValidationIssue[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(issues, "invalid-value", path, "must be an object");
    return;
  }
  const raw = value as UnknownRecord;
  const rawKind = raw["kind"];
  const kindKeys =
    rawKind === "launch"
      ? ["path", "workspaceRoots", "settings"]
      : typeof rawKind === "string" && PATH_EVENT_KINDS.has(rawKind)
        ? ["path"]
        : rawKind === "manual-rule-mention"
          ? ["ruleId"]
          : rawKind === "rule-selection"
            ? ["ruleIds", "selectionSource"]
            : rawKind === "settings-change"
              ? ["settings"]
              : [];
  const record = objectValue(
    value,
    path,
    ["id", "sequence", "kind", "targetId", "uncertainty", ...kindKeys],
    issues,
  );
  if (record === undefined) return;
  requiredIdentifier(record, "id", path, issues);
  const sequence = requiredInteger(record, "sequence", path, issues);
  if (sequence !== undefined && sequence !== expectedSequence)
    addIssue(
      issues,
      "invalid-state",
      `${path}.sequence`,
      "must equal its zero-based array position",
    );
  const kind = enumString(record, "kind", path, EVENT_KIND_SET, issues);
  const targetId = nullableIdentifier(record, "targetId", path, issues);
  if (targetId !== null && targetId !== undefined && !targets.has(targetId))
    addIssue(
      issues,
      "invalid-relationship",
      `${path}.targetId`,
      "references an unknown resolution target",
    );
  if (record["uncertainty"] === undefined)
    addIssue(issues, "missing-field", `${path}.uncertainty`, "is required");
  else reportUncertainty(record["uncertainty"], `${path}.uncertainty`, issues);
  if (kind === "launch" || (kind !== undefined && PATH_EVENT_KINDS.has(kind))) {
    const eventPath = requiredString(record, "path", path, issues);
    if (eventPath !== undefined && !isRepositoryRelativePath(eventPath))
      addIssue(
        issues,
        "invalid-path",
        `${path}.path`,
        "must be a canonical repository-relative path",
      );
  }
  if (kind === "launch") {
    const workspaceRoots = requiredArray(record, "workspaceRoots", path, issues) ?? [];
    if (workspaceRoots.length === 0)
      addIssue(issues, "invalid-value", `${path}.workspaceRoots`, "must contain at least one root");
    const seen = new Set<string>();
    for (const [index, root] of workspaceRoots.entries()) {
      if (typeof root !== "string" || !isRepositoryRelativePath(root))
        addIssue(
          issues,
          "invalid-path",
          `${path}.workspaceRoots[${String(index)}]`,
          "must be a canonical repository-relative path",
        );
      else if (seen.has(root))
        addIssue(
          issues,
          "duplicate-id",
          `${path}.workspaceRoots[${String(index)}]`,
          `duplicates '${root}'`,
        );
      else seen.add(root);
    }
    validateSettings(record["settings"], `${path}.settings`, issues);
  } else if (kind === "manual-rule-mention") {
    const ruleId = requiredIdentifier(record, "ruleId", path, issues);
    if (ruleId !== undefined && !activationRules.has(ruleId))
      addIssue(
        issues,
        "invalid-relationship",
        `${path}.ruleId`,
        "references an unknown activation rule",
      );
  } else if (kind === "rule-selection") {
    const ruleIds = identifierArray(record, "ruleIds", path, issues, 1) ?? [];
    for (const [index, ruleId] of ruleIds.entries()) {
      if (!activationRules.has(ruleId))
        addIssue(
          issues,
          "invalid-relationship",
          `${path}.ruleIds[${String(index)}]`,
          "references an unknown activation rule",
        );
    }
    enumString(
      record,
      "selectionSource",
      path,
      new Set(["profile", "model", "user", "unknown"]),
      issues,
    );
  } else if (kind === "settings-change") {
    const settings = validateSettings(record["settings"], `${path}.settings`, issues);
    if (settings.length === 0)
      addIssue(
        issues,
        "invalid-state",
        `${path}.settings`,
        "settings-change requires at least one setting",
      );
  }
}

function validateOwnership(
  documents: ReadonlyMap<string, DocumentFacts>,
  imports: ReadonlyMap<string, ImportFacts>,
  statements: ReadonlyMap<string, StatementFacts>,
  activations: ReadonlyMap<string, ActivationFacts>,
  issues: InstructionIrValidationIssue[],
): void {
  const check = (
    document: DocumentFacts,
    ids: readonly string[],
    records: ReadonlyMap<string, { readonly documentId: string }>,
    path: string,
  ): void => {
    for (const [index, id] of ids.entries()) {
      const record = records.get(id);
      if (record === undefined)
        addIssue(
          issues,
          "invalid-relationship",
          `${path}[${String(index)}]`,
          "references an unknown record",
        );
      else if (record.documentId !== document.id)
        addIssue(
          issues,
          "invalid-relationship",
          `${path}[${String(index)}]`,
          "references a record owned by another document",
        );
    }
  };
  for (const document of documents.values()) {
    check(document, document.importIds, imports, `$.documents[id=${document.id}].importIds`);
    check(
      document,
      document.statementIds,
      statements,
      `$.documents[id=${document.id}].statementIds`,
    );
    check(
      document,
      document.activationRuleIds,
      activations,
      `$.documents[id=${document.id}].activationRuleIds`,
    );
  }
  for (const [collection, records] of [
    ["imports", imports],
    ["statements", statements],
    ["activationRules", activations],
  ] as const) {
    for (const record of records.values()) {
      const document = documents.get(record.documentId);
      const listed =
        collection === "imports"
          ? document?.importIds
          : collection === "statements"
            ? document?.statementIds
            : document?.activationRuleIds;
      if (document !== undefined && listed?.includes(record.id) !== true)
        addIssue(
          issues,
          "invalid-relationship",
          `$.${collection}[id=${record.id}].documentId`,
          "owning document does not list this record",
        );
    }
  }
}

/** Validate an untrusted JSON-like value as the closed B03 instruction IR. */
function validateInstructionIrValue(
  input: unknown,
  issues: InstructionIrValidationIssue[],
): InstructionIrValidationResult {
  const jsonSafe = validateJsonValue(input, "$", (_code, issuePath, message) => {
    addIssue(issues, "invalid-json", issuePath, message);
  });
  if (!jsonSafe) return { issues, ok: false };
  const record = objectValue(
    input,
    "$",
    [
      "recordKind",
      "contractVersion",
      "sources",
      "documents",
      "nodes",
      "imports",
      "statements",
      "activationRules",
      "targets",
      "events",
    ],
    issues,
  );
  if (record === undefined) return { issues, ok: false };
  const recordKind = requiredString(record, "recordKind", "$", issues);
  if (recordKind !== undefined && recordKind !== "agent-context-instruction-ir")
    addIssue(issues, "invalid-value", "$.recordKind", "must equal 'agent-context-instruction-ir'");
  const version = requiredString(record, "contractVersion", "$", issues);
  if (version !== undefined && version !== INSTRUCTION_IR_CONTRACT_VERSION)
    addIssue(
      issues,
      "invalid-value",
      "$.contractVersion",
      `must equal '${INSTRUCTION_IR_CONTRACT_VERSION}'`,
    );

  const sourceValues = collectRecords(record, "sources", issues);
  const documentValues = collectRecords(record, "documents", issues);
  const nodeValues = collectRecords(record, "nodes", issues);
  const importValues = collectRecords(record, "imports", issues);
  const statementValues = collectRecords(record, "statements", issues);
  const activationValues = collectRecords(record, "activationRules", issues);
  const targetValues = collectRecords(record, "targets", issues);
  const eventValues = collectRecords(record, "events", issues);
  collectIds(sourceValues, "$.sources", issues);
  collectIds(documentValues, "$.documents", issues);
  collectIds(nodeValues, "$.nodes", issues);
  collectIds(importValues, "$.imports", issues);
  collectIds(statementValues, "$.statements", issues);
  collectIds(activationValues, "$.activationRules", issues);
  collectIds(targetValues, "$.targets", issues);
  collectIds(eventValues, "$.events", issues);

  const sources = new Map<string, SourceFacts>();
  const sourceIdsByPath = new Map<string, string>();
  for (const [index, value] of sourceValues.entries()) {
    const facts = validateSource(value, `$.sources[${String(index)}]`, issues);
    if (facts !== undefined && !sources.has(facts.id)) {
      const priorSourceId = sourceIdsByPath.get(facts.path);
      if (priorSourceId !== undefined)
        addIssue(
          issues,
          "duplicate-id",
          `$.sources[${String(index)}].path`,
          `duplicates canonical source path owned by '${priorSourceId}'`,
        );
      else sourceIdsByPath.set(facts.path, facts.id);
      sources.set(facts.id, facts);
    }
  }
  const nodes = new Map<string, NodeFacts>();
  for (const [index, value] of nodeValues.entries()) {
    const facts = validateNode(value, `$.nodes[${String(index)}]`, sources, issues);
    if (facts !== undefined && !nodes.has(facts.id)) nodes.set(facts.id, facts);
  }
  const nodeParents = validateAstRelationships(nodes, sources, issues);
  const documents = new Map<string, DocumentFacts>();
  for (const [index, value] of documentValues.entries()) {
    const facts = validateDocument(value, `$.documents[${String(index)}]`, sources, nodes, issues);
    if (facts !== undefined && !documents.has(facts.id)) documents.set(facts.id, facts);
  }
  const imports = new Map<string, ImportFacts>();
  for (const [index, value] of importValues.entries()) {
    const facts = validateImport(
      value,
      `$.imports[${String(index)}]`,
      documents,
      nodes,
      sources,
      issues,
    );
    if (facts !== undefined && !imports.has(facts.id)) imports.set(facts.id, facts);
  }
  const statements = new Map<string, StatementFacts>();
  for (const [index, value] of statementValues.entries()) {
    const facts = validateStatement(
      value,
      `$.statements[${String(index)}]`,
      documents,
      nodes,
      nodeParents,
      sources,
      issues,
    );
    if (facts !== undefined && !statements.has(facts.id)) statements.set(facts.id, facts);
  }
  const activations = new Map<string, ActivationFacts>();
  for (const [index, value] of activationValues.entries()) {
    const facts = validateActivation(
      value,
      `$.activationRules[${String(index)}]`,
      documents,
      sources,
      issues,
    );
    if (facts !== undefined && !activations.has(facts.id)) activations.set(facts.id, facts);
  }
  validateOwnership(documents, imports, statements, activations, issues);
  const targets = new Map<string, TargetFacts>();
  for (const [index, value] of targetValues.entries()) {
    const facts = validateTarget(value, `$.targets[${String(index)}]`, issues);
    if (facts !== undefined && !targets.has(facts.id)) targets.set(facts.id, facts);
  }
  for (const [index, value] of eventValues.entries())
    validateEvent(value, `$.events[${String(index)}]`, index, activations, targets, issues);

  return issues.length === 0 ? { ok: true, value: input as InstructionIr } : { issues, ok: false };
}

export function validateInstructionIr(input: unknown): InstructionIrValidationResult {
  const issues: InstructionIrValidationIssue[] = [];
  try {
    return validateInstructionIrValue(input, issues);
  } catch (error) {
    if (error instanceof ValidationIssueLimitReached) return { issues, ok: false };
    throw error;
  }
}

export function isInstructionIr(input: unknown): input is InstructionIr {
  return validateInstructionIr(input).ok;
}

/** Validate a standalone range against the exact bytes and UTF-16 text facts of a source. */
function validateSourceRangeValue(
  source: SourceDocument,
  input: unknown,
  issues: InstructionIrValidationIssue[],
): SourceRangeValidationResult {
  const sourceJsonSafe = validateJsonValue(source, "$.source", (_code, issuePath, message) => {
    addIssue(issues, "invalid-json", issuePath, message);
  });
  const rangeJsonSafe = validateJsonValue(input, "$.range", (_code, issuePath, message) => {
    addIssue(issues, "invalid-json", issuePath, message);
  });
  if (!sourceJsonSafe || !rangeJsonSafe) return { issues, ok: false };
  const sourceFacts = validateSource(source, "$.source", issues);
  const sources = new Map<string, SourceFacts>();
  if (sourceFacts !== undefined) sources.set(sourceFacts.id, sourceFacts);
  const range = validateRange(input, "$.range", sources, issues);
  return issues.length === 0 && range !== undefined
    ? { ok: true, value: input as SourceRange }
    : { issues, ok: false };
}

export function validateSourceRange(
  source: SourceDocument,
  input: unknown,
): SourceRangeValidationResult {
  const issues: InstructionIrValidationIssue[] = [];
  try {
    return validateSourceRangeValue(source, input, issues);
  } catch (error) {
    if (error instanceof ValidationIssueLimitReached) return { issues, ok: false };
    throw error;
  }
}

/** Validate and slice without trusting unchecked offsets or throwing on untrusted range data. */
export function sliceSourceRange(source: SourceDocument, input: unknown): SourceRangeSliceResult {
  const validation = validateSourceRange(source, input);
  return validation.ok
    ? {
        ok: true,
        range: validation.value,
        text: source.text.slice(
          validation.value.start.utf16Offset,
          validation.value.end.utf16Offset,
        ),
      }
    : validation;
}
