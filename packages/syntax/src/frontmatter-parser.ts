import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";

import type { JsonValue, SourceDocumentId, SourcePosition, SourceRange } from "@agent-context/core";

export const FRONTMATTER_PARSER_CONTRACT_VERSION = "0.1.0" as const;
export const FRONTMATTER_DIALECTS = ["mdc", "yaml"] as const;

export const DEFAULT_FRONTMATTER_LIMITS: Readonly<Required<FrontmatterParserOptions>> =
  Object.freeze({
    maxCollectionEntries: 4_096,
    maxDepth: 64,
    maxIssues: 64,
    maxNodes: 8_192,
    maxScalarBytes: 65_536,
    maxSourceBytes: 262_144,
  });

const ABSOLUTE_FRONTMATTER_LIMITS = DEFAULT_FRONTMATTER_LIMITS;
const SOURCE_ID = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const MAX_SOURCE_ID_UTF16_CODE_UNITS = 512;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const INPUT_KEYS = new Set(["bytes", "dialect", "sourceId"]);
const OPTION_KEYS = new Set(Object.keys(DEFAULT_FRONTMATTER_LIMITS));

export type FrontmatterDialect = (typeof FRONTMATTER_DIALECTS)[number];
export type FrontmatterParseState = "absent" | "invalid" | "valid";
export type FrontmatterScopeAuthority = "absent" | "available" | "denied";

export type FrontmatterIssueCode =
  | "alias-forbidden"
  | "bom-forbidden"
  | "duplicate-key"
  | "invalid-encoding"
  | "invalid-key"
  | "invalid-root"
  | "invalid-value"
  | "invalid-yaml"
  | "resource-limit"
  | "tag-forbidden"
  | "unclosed-frontmatter";

export interface FrontmatterParserInput {
  readonly bytes: Uint8Array;
  readonly dialect: FrontmatterDialect;
  readonly sourceId: SourceDocumentId;
}

export interface FrontmatterParserOptions {
  readonly maxCollectionEntries?: number;
  readonly maxDepth?: number;
  readonly maxIssues?: number;
  readonly maxNodes?: number;
  readonly maxScalarBytes?: number;
  readonly maxSourceBytes?: number;
}

export interface FrontmatterIssue {
  readonly code: FrontmatterIssueCode;
  readonly message: string;
  /** Null only when invalid bytes prevent honest source-coordinate construction. */
  readonly range: SourceRange | null;
}

export interface FrontmatterLocation {
  /** JSON-pointer-like path rooted at `$`; `~` and `/` are escaped per RFC 6901. */
  readonly path: string;
  readonly keyRange: SourceRange | null;
  readonly valueRange: SourceRange;
}

export interface FrontmatterParseResult {
  readonly bodyRange: SourceRange | null;
  readonly contentRange: SourceRange | null;
  readonly contractVersion: typeof FRONTMATTER_PARSER_CONTRACT_VERSION;
  readonly dialect: FrontmatterDialect;
  readonly frontmatterRange: SourceRange | null;
  readonly issues: readonly FrontmatterIssue[];
  readonly locations: readonly FrontmatterLocation[];
  readonly scopeAuthority: FrontmatterScopeAuthority;
  readonly sourceId: SourceDocumentId;
  readonly state: FrontmatterParseState;
  /** Exact decoded source; null only when encoding or byte-limit preflight prevents decoding. */
  readonly text: string | null;
  readonly value: Readonly<Record<string, JsonValue>> | null;
}

export type FrontmatterParserErrorCode = "FRONTMATTER_INVALID_INPUT" | "FRONTMATTER_INVALID_LIMIT";

export class FrontmatterParserError extends Error {
  public readonly code: FrontmatterParserErrorCode;
  public readonly limitName: keyof Required<FrontmatterParserOptions> | null;

  public constructor(
    code: FrontmatterParserErrorCode,
    message: string,
    limitName: keyof Required<FrontmatterParserOptions> | null = null,
  ) {
    super(message);
    this.name = "FrontmatterParserError";
    this.code = code;
    this.limitName = limitName;
  }
}

interface ValidatedInput {
  readonly byteLength: number;
  readonly bytes: Uint8Array | null;
  readonly dialect: FrontmatterDialect;
  readonly sourceId: SourceDocumentId;
}

interface PositionIndex {
  readonly byteOffsets: Float64Array;
  readonly lineStarts: readonly number[];
}

interface Envelope {
  readonly bodyStart: number;
  readonly contentEnd: number;
  readonly contentStart: number;
  readonly envelopeEnd: number;
}

interface NodeFrame {
  readonly depth: number;
  readonly keyRange: SourceRange | null;
  readonly node: unknown;
  readonly path: string;
}

function invalidInput(message: string): never {
  throw new FrontmatterParserError("FRONTMATTER_INVALID_INPUT", message);
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
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return invalidInput(`${name} properties could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidInput(`${name} must have a plain prototype`);
  }
  if (keys.length > allowedKeys.size) return invalidInput(`${name} contains too many fields`);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      return invalidInput(`${name} contains an unsupported field`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalidInput(`${name} properties could not be inspected safely`);
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalidInput(`${name} must contain only own data properties`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function validateInput(value: unknown): ValidatedInput {
  const record = ownDataRecord(value, "input", INPUT_KEYS);
  const sourceId = record["sourceId"];
  if (
    typeof sourceId !== "string" ||
    sourceId.length === 0 ||
    sourceId.length > MAX_SOURCE_ID_UTF16_CODE_UNITS ||
    !SOURCE_ID.test(sourceId)
  ) {
    return invalidInput("input.sourceId must be a bounded B03 stable identifier");
  }
  const dialect = record["dialect"];
  if (
    typeof dialect !== "string" ||
    !(FRONTMATTER_DIALECTS as readonly string[]).includes(dialect)
  ) {
    return invalidInput("input.dialect must name a supported frontmatter dialect");
  }
  const bytesValue = record["bytes"];
  if (!nodeTypes.isUint8Array(bytesValue) || nodeTypes.isProxy(bytesValue)) {
    return invalidInput("input.bytes must be an intrinsic Uint8Array");
  }
  if (TYPED_ARRAY_BYTE_LENGTH === undefined) {
    return invalidInput("intrinsic typed-array byte length is unavailable");
  }
  let byteLength: number;
  try {
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, bytesValue, []) as number;
  } catch {
    return invalidInput("input.bytes could not be inspected safely");
  }
  if (byteLength > ABSOLUTE_FRONTMATTER_LIMITS.maxSourceBytes) {
    return Object.freeze({
      byteLength,
      bytes: null,
      dialect: dialect as FrontmatterDialect,
      sourceId: sourceId as SourceDocumentId,
    });
  }
  const bytes = new Uint8Array(byteLength);
  try {
    Reflect.apply(UINT8_ARRAY_SET, bytes, [bytesValue]);
  } catch {
    return invalidInput("input.bytes could not be snapshotted safely");
  }
  return Object.freeze({
    byteLength,
    bytes,
    dialect: dialect as FrontmatterDialect,
    sourceId: sourceId as SourceDocumentId,
  });
}

function validateOptions(value: unknown): Readonly<Required<FrontmatterParserOptions>> {
  if (value === undefined) return DEFAULT_FRONTMATTER_LIMITS;
  const record = ownDataRecord(value, "options", OPTION_KEYS);
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const key of Object.keys(
    DEFAULT_FRONTMATTER_LIMITS,
  ) as (keyof Required<FrontmatterParserOptions>)[]) {
    const candidate = Object.hasOwn(record, key) ? record[key] : DEFAULT_FRONTMATTER_LIMITS[key];
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > ABSOLUTE_FRONTMATTER_LIMITS[key]
    ) {
      throw new FrontmatterParserError(
        "FRONTMATTER_INVALID_LIMIT",
        `${key} must be a positive safe integer no greater than ${String(ABSOLUTE_FRONTMATTER_LIMITS[key])}`,
        key,
      );
    }
    result[key] = candidate;
  }
  return Object.freeze(result) as Readonly<Required<FrontmatterParserOptions>>;
}

function buildPositionIndex(text: string): PositionIndex {
  const byteOffsets = new Float64Array(text.length + 1);
  const lineStarts = [0];
  let byteOffset = 0;
  for (let offset = 0; offset < text.length; offset += 1) {
    const unit = text.charCodeAt(offset);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      byteOffsets[offset + 1] = -1;
      byteOffset += 4;
      offset += 1;
    } else {
      byteOffset += unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3;
    }
    byteOffsets[offset + 1] = byteOffset;
    if (unit === 0x0a || (unit === 0x0d && text.charCodeAt(offset + 1) !== 0x0a)) {
      lineStarts.push(offset + 1);
    }
  }
  return Object.freeze({ byteOffsets, lineStarts: Object.freeze(lineStarts) });
}

function position(index: PositionIndex, offset: number): SourcePosition {
  const bounded = Math.max(0, Math.min(offset, index.byteOffsets.length - 1));
  let low = 0;
  let high = index.lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((index.lineStarts[middle] ?? 0) <= bounded) low = middle;
    else high = middle;
  }
  const byteOffset = index.byteOffsets[bounded];
  if (byteOffset === undefined || byteOffset < 0) {
    throw new FrontmatterParserError(
      "FRONTMATTER_INVALID_INPUT",
      "range offset splits a Unicode surrogate pair",
    );
  }
  return Object.freeze({
    byteOffset,
    line: low,
    utf16Column: bounded - (index.lineStarts[low] ?? 0),
    utf16Offset: bounded,
  });
}

function range(
  sourceId: SourceDocumentId,
  index: PositionIndex,
  start: number,
  end: number,
): SourceRange {
  return Object.freeze({ end: position(index, end), sourceId, start: position(index, start) });
}

function lineBounds(text: string, start: number): readonly [number, number] {
  let end = start;
  while (end < text.length && text.charCodeAt(end) !== 0x0a && text.charCodeAt(end) !== 0x0d) {
    end += 1;
  }
  let next = end;
  if (text.charCodeAt(next) === 0x0d) next += 1;
  if (text.charCodeAt(next) === 0x0a) next += 1;
  return [end, next];
}

function findEnvelope(text: string): Envelope | "absent" | "unclosed" {
  const [firstEnd, contentStart] = lineBounds(text, 0);
  if (text.slice(0, firstEnd) !== "---") return "absent";
  let lineStart = contentStart;
  while (lineStart < text.length) {
    const [lineEnd, nextLine] = lineBounds(text, lineStart);
    if (text.slice(lineStart, lineEnd) === "---") {
      return {
        bodyStart: nextLine,
        contentEnd: lineStart,
        contentStart,
        envelopeEnd: nextLine,
      };
    }
    lineStart = nextLine;
  }
  return "unclosed";
}

function firstForbiddenYamlCharacter(text: string): readonly [number, number] | undefined {
  for (let offset = 0; offset < text.length; offset += 1) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) return [offset, offset + 1];
    const allowed =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      codePoint === 0x85 ||
      (codePoint >= 0xa0 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x1_0000 && codePoint <= 0x10_ffff);
    if (!allowed) return [offset, offset + (codePoint > 0xffff ? 2 : 1)];
    if (codePoint > 0xffff) offset += 1;
  }
  return undefined;
}

function pointer(parent: string, segment: string): string {
  return `${parent}/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function nodeOffsets(node: unknown): readonly [number, number] | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const candidate = (node as { readonly range?: readonly number[] }).range;
  const start = candidate?.[0];
  const end = candidate?.[1];
  return typeof start === "number" && typeof end === "number" ? [start, end] : undefined;
}

function scalarValue(node: unknown): JsonValue | undefined {
  if (!isScalar(node)) return undefined;
  const value: unknown = node.value;
  return value === null || typeof value === "string" || typeof value === "boolean"
    ? value
    : typeof value === "number" &&
        Number.isFinite(value) &&
        !Object.is(value, -0) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))
      ? value
      : undefined;
}

function freezeValue(node: unknown): JsonValue {
  const scalar = scalarValue(node);
  if (scalar !== undefined || (isScalar(node) && node.value === null)) return scalar ?? null;
  if (isSeq(node)) {
    return Object.freeze(node.items.map((item) => freezeValue(item)));
  }
  if (isMap(node)) {
    const object: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const item of node.items) {
      if (!isPair(item) || !isScalar(item.key) || typeof item.key.value !== "string") {
        throw new TypeError("invalid mapping key");
      }
      Object.defineProperty(object, item.key.value, {
        configurable: false,
        enumerable: true,
        value: item.value === null ? null : freezeValue(item.value),
        writable: false,
      });
    }
    return Object.freeze(object);
  }
  throw new TypeError("unsupported YAML node");
}

function issue(
  code: FrontmatterIssueCode,
  message: string,
  issueRange: SourceRange | null,
): FrontmatterIssue {
  return Object.freeze({ code, message, range: issueRange });
}

function result(
  input: ValidatedInput,
  state: FrontmatterParseState,
  text: string | null,
  bodyRange: SourceRange | null,
  contentRange: SourceRange | null,
  frontmatterRange: SourceRange | null,
  issues: readonly FrontmatterIssue[],
  locations: readonly FrontmatterLocation[] = [],
  value: Readonly<Record<string, JsonValue>> | null = null,
): FrontmatterParseResult {
  return Object.freeze({
    bodyRange,
    contentRange,
    contractVersion: FRONTMATTER_PARSER_CONTRACT_VERSION,
    dialect: input.dialect,
    frontmatterRange,
    issues: Object.freeze([...issues]),
    locations: Object.freeze([...locations]),
    scopeAuthority: state === "valid" ? "available" : state === "absent" ? "absent" : "denied",
    sourceId: input.sourceId,
    state,
    text,
    value,
  });
}

/** Parse one already-read UTF-8 instruction file without filesystem, network, or execution access. */
export function parseFrontmatter(
  inputValue: FrontmatterParserInput,
  optionsValue?: FrontmatterParserOptions,
): FrontmatterParseResult {
  const options = validateOptions(optionsValue);
  const input = validateInput(inputValue);
  if (input.byteLength > options.maxSourceBytes || input.bytes === null) {
    return result(input, "invalid", null, null, null, null, [
      issue("resource-limit", "source exceeds the configured frontmatter byte limit", null),
    ]);
  }
  const bytes = input.bytes;
  if (input.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return result(input, "invalid", null, null, null, null, [
      issue("bom-forbidden", "UTF-8 BOM is not accepted for frontmatter authority", null),
    ]);
  }

  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return result(input, "invalid", null, null, null, null, [
      issue("invalid-encoding", "source is not well-formed UTF-8", null),
    ]);
  }
  const index = buildPositionIndex(text);
  const wholeRange = range(input.sourceId, index, 0, text.length);
  const envelope = findEnvelope(text);
  if (envelope === "absent") {
    return result(input, "absent", text, wholeRange, null, null, []);
  }
  if (envelope === "unclosed") {
    return result(
      input,
      "invalid",
      text,
      range(input.sourceId, index, text.length, text.length),
      null,
      wholeRange,
      [
        issue(
          "unclosed-frontmatter",
          "opening frontmatter delimiter has no closing delimiter",
          wholeRange,
        ),
      ],
    );
  }

  const bodyRange = range(input.sourceId, index, envelope.bodyStart, text.length);
  const contentRange = range(input.sourceId, index, envelope.contentStart, envelope.contentEnd);
  const frontmatterRange = range(input.sourceId, index, 0, envelope.envelopeEnd);
  const content = text.slice(envelope.contentStart, envelope.contentEnd);
  const forbidden = firstForbiddenYamlCharacter(content);
  if (forbidden !== undefined) {
    return result(input, "invalid", text, bodyRange, contentRange, frontmatterRange, [
      issue(
        "invalid-yaml",
        "frontmatter contains a character forbidden by YAML 1.2",
        range(
          input.sourceId,
          index,
          envelope.contentStart + forbidden[0],
          envelope.contentStart + forbidden[1],
        ),
      ),
    ]);
  }
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(content, {
      intAsBigInt: false,
      merge: false,
      prettyErrors: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
  } catch {
    return result(input, "invalid", text, bodyRange, contentRange, frontmatterRange, [
      issue("invalid-yaml", "frontmatter is not valid YAML", contentRange),
    ]);
  }
  const parseIssues: FrontmatterIssue[] = [];
  for (const error of document.errors.slice(0, options.maxIssues)) {
    const start = envelope.contentStart + error.pos[0];
    const end = envelope.contentStart + error.pos[1];
    parseIssues.push(
      issue(
        error.code === "DUPLICATE_KEY" ? "duplicate-key" : "invalid-yaml",
        error.code === "DUPLICATE_KEY"
          ? "frontmatter mapping keys must be unique"
          : "frontmatter contains invalid YAML",
        range(input.sourceId, index, start, end),
      ),
    );
  }
  for (const warning of document.warnings.slice(
    0,
    Math.max(0, options.maxIssues - parseIssues.length),
  )) {
    const start = envelope.contentStart + warning.pos[0];
    const end = envelope.contentStart + warning.pos[1];
    parseIssues.push(
      issue(
        "invalid-yaml",
        "frontmatter YAML warning is rejected",
        range(input.sourceId, index, start, end),
      ),
    );
  }
  if (parseIssues.length > 0) {
    return result(input, "invalid", text, bodyRange, contentRange, frontmatterRange, parseIssues);
  }
  if (document.directives?.yaml.explicit === true || content.trimStart().startsWith("%")) {
    return result(input, "invalid", text, bodyRange, contentRange, frontmatterRange, [
      issue("invalid-yaml", "YAML directives are not supported in frontmatter", contentRange),
    ]);
  }
  if (document.contents !== null && !isMap(document.contents)) {
    return result(input, "invalid", text, bodyRange, contentRange, frontmatterRange, [
      issue("invalid-root", "frontmatter root must be a mapping", contentRange),
    ]);
  }

  const root = document.contents;
  const locations: FrontmatterLocation[] = [];
  const structuralIssues: FrontmatterIssue[] = [];
  const stack: NodeFrame[] =
    root === null ? [] : [{ depth: 0, keyRange: null, node: root, path: "$" }];
  let collectionEntries = 0;
  let nodes = 0;
  const addStructuralIssue = (entry: FrontmatterIssue): void => {
    if (structuralIssues.length < options.maxIssues) structuralIssues.push(entry);
  };
  while (stack.length > 0 && structuralIssues.length < options.maxIssues) {
    const frame = stack.pop();
    if (frame === undefined || frame.node === null) continue;
    nodes += 1;
    const offsets = nodeOffsets(frame.node);
    const valueRange =
      offsets === undefined
        ? contentRange
        : range(
            input.sourceId,
            index,
            envelope.contentStart + offsets[0],
            envelope.contentStart + offsets[1],
          );
    locations.push(Object.freeze({ keyRange: frame.keyRange, path: frame.path, valueRange }));
    if (nodes > options.maxNodes) {
      addStructuralIssue(issue("resource-limit", "frontmatter exceeds the node limit", valueRange));
      break;
    }
    if (frame.depth > options.maxDepth) {
      addStructuralIssue(
        issue("resource-limit", "frontmatter exceeds the depth limit", valueRange),
      );
      break;
    }
    if (isAlias(frame.node)) {
      addStructuralIssue(issue("alias-forbidden", "YAML aliases are disabled", valueRange));
      continue;
    }
    const metadata = frame.node as { readonly anchor?: string; readonly tag?: string };
    if (metadata.anchor !== undefined) {
      addStructuralIssue(issue("alias-forbidden", "YAML anchors are disabled", valueRange));
    }
    if (metadata.tag !== undefined) {
      addStructuralIssue(issue("tag-forbidden", "explicit YAML tags are disabled", valueRange));
    }
    if (isScalar(frame.node)) {
      const scalar = scalarValue(frame.node);
      if (scalar === undefined && frame.node.value !== null) {
        addStructuralIssue(
          issue("invalid-value", "frontmatter scalar is not a finite JSON value", valueRange),
        );
      } else if (
        typeof scalar === "string" &&
        Buffer.byteLength(scalar, "utf8") > options.maxScalarBytes
      ) {
        addStructuralIssue(
          issue("resource-limit", "frontmatter scalar exceeds the byte limit", valueRange),
        );
      }
      continue;
    }
    if (isSeq(frame.node)) {
      if (collectionEntries + frame.node.items.length > options.maxCollectionEntries) {
        addStructuralIssue(
          issue("resource-limit", "frontmatter exceeds the collection-entry limit", valueRange),
        );
        break;
      }
      collectionEntries += frame.node.items.length;
      for (let itemIndex = frame.node.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        stack.push({
          depth: frame.depth + 1,
          keyRange: null,
          node: frame.node.items[itemIndex],
          path: pointer(frame.path, String(itemIndex)),
        });
      }
    } else if (isMap(frame.node)) {
      if (collectionEntries + frame.node.items.length > options.maxCollectionEntries) {
        addStructuralIssue(
          issue("resource-limit", "frontmatter exceeds the collection-entry limit", valueRange),
        );
        break;
      }
      collectionEntries += frame.node.items.length;
      if (nodes + frame.node.items.length > options.maxNodes) {
        addStructuralIssue(
          issue("resource-limit", "frontmatter exceeds the node limit", valueRange),
        );
        break;
      }
      nodes += frame.node.items.length;
      for (let itemIndex = frame.node.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const pair = frame.node.items[itemIndex];
        if (!isPair(pair) || !isScalar(pair.key) || typeof pair.key.value !== "string") {
          addStructuralIssue(issue("invalid-key", "mapping keys must be strings", valueRange));
          continue;
        }
        const keyOffsets = nodeOffsets(pair.key);
        const keyRange =
          keyOffsets === undefined
            ? valueRange
            : range(
                input.sourceId,
                index,
                envelope.contentStart + keyOffsets[0],
                envelope.contentStart + keyOffsets[1],
              );
        if (Buffer.byteLength(pair.key.value, "utf8") > options.maxScalarBytes) {
          addStructuralIssue(
            issue("resource-limit", "mapping key exceeds the byte limit", keyRange),
          );
        }
        stack.push({
          depth: frame.depth + 1,
          keyRange,
          node: pair.value,
          path: pointer(frame.path, pair.key.value),
        });
      }
    } else {
      addStructuralIssue(issue("invalid-value", "unsupported YAML node", valueRange));
    }
  }
  if (structuralIssues.length > 0) {
    return result(
      input,
      "invalid",
      text,
      bodyRange,
      contentRange,
      frontmatterRange,
      structuralIssues,
    );
  }

  let value: Readonly<Record<string, JsonValue>>;
  try {
    value = (root === null ? Object.freeze(Object.create(null)) : freezeValue(root)) as Readonly<
      Record<string, JsonValue>
    >;
  } catch {
    return result(input, "invalid", text, bodyRange, contentRange, frontmatterRange, [
      issue("invalid-value", "frontmatter could not be converted safely", contentRange),
    ]);
  }
  return result(
    input,
    "valid",
    text,
    bodyRange,
    contentRange,
    frontmatterRange,
    [],
    locations,
    value,
  );
}
