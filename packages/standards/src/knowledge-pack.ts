import { types as nodeTypes } from "node:util";

import { isRepositoryRelativePath } from "@agent-context/core";

import type { RepositoryRelativePath } from "@agent-context/core";

export const KNOWLEDGE_PACK_CONTRACT_VERSION = "0.1.0" as const;
export const KNOWLEDGE_PACK_CHANNELS = ["preview", "stable"] as const;

export const KNOWLEDGE_KINDS = [
  "known-field",
  "known-location",
  "deprecation",
  "migration-hint",
] as const;
export const KNOWLEDGE_VALUE_TYPES = ["array", "boolean", "number", "object", "string"] as const;
export const LOCATION_SCOPES = ["repository-root", "scope-root"] as const;
export const KNOWLEDGE_MATCHER_IDS = [
  "field-presence",
  "field-type",
  "identifier-equals",
  "identifier-transition",
  "location-exact",
] as const;

Object.freeze(KNOWLEDGE_KINDS);
Object.freeze(KNOWLEDGE_PACK_CHANNELS);
Object.freeze(KNOWLEDGE_VALUE_TYPES);
Object.freeze(LOCATION_SCOPES);
Object.freeze(KNOWLEDGE_MATCHER_IDS);

export const MAX_KNOWLEDGE_PACK_BYTES: number = 4 * 1024 * 1024;
export const MAX_KNOWLEDGE_PACK_DEPTH = 64;
export const MAX_KNOWLEDGE_PACK_VALUES = 100_000;
export const MAX_KNOWLEDGE_PACK_CONTAINER_ENTRIES = 20_000;
export const MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS = 4_096;
export const MAX_KNOWLEDGE_PACK_STRING_BYTES = 16_384;
export const MAX_KNOWLEDGE_PACK_TOTAL_STRING_BYTES: number = 4 * 1024 * 1024;
export const MAX_KNOWLEDGE_PACK_RECORDS = 10_000;
export const MAX_KNOWLEDGE_PACK_SOURCES = 1_024;
export const MAX_KNOWLEDGE_COMPATIBILITY_RECORDS = 16;
export const MAX_KNOWLEDGE_PACK_RULE_IDS = 64;
export const MAX_KNOWLEDGE_PACK_ISSUES = 256;

export type KnowledgeValueType = (typeof KNOWLEDGE_VALUE_TYPES)[number];
export type LocationScope = (typeof LOCATION_SCOPES)[number];
export type KnowledgeMatcherId = (typeof KNOWLEDGE_MATCHER_IDS)[number];
export type KnowledgePackChannel = (typeof KNOWLEDGE_PACK_CHANNELS)[number];

export interface KnowledgePackSource {
  readonly id: string;
  readonly url: string;
  readonly retrievedAt: string;
  readonly sha256: string;
}

export interface StandardsCompatibility {
  readonly adapterVersion: string;
  readonly channel: KnowledgePackChannel;
  readonly contentDigests: Readonly<Record<string, string>>;
  readonly formatId: string;
  readonly minEngineVersion: string;
  readonly profileId: string | null;
  readonly retrievedAt: string;
  readonly rulesetVersion: string;
  readonly specificationUrls: readonly string[];
  readonly surfaceId: string | null;
  readonly upstreamRevision: string | null;
}

export type KnowledgeMatcher =
  | {
      readonly id: "field-presence";
      readonly operands: { readonly fieldName: string };
    }
  | {
      readonly id: "field-type";
      readonly operands: {
        readonly fieldName: string;
        readonly valueType: KnowledgeValueType;
      };
    }
  | {
      readonly id: "location-exact";
      readonly operands: {
        readonly path: RepositoryRelativePath;
        readonly scope: LocationScope;
      };
    }
  | {
      readonly id: "identifier-equals";
      readonly operands: { readonly identifier: string };
    }
  | {
      readonly id: "identifier-transition";
      readonly operands: { readonly fromId: string; readonly toId: string };
    };

interface KnowledgeRecordBase {
  readonly id: string;
  readonly profileId: string | null;
  readonly ruleIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly summary: string;
  readonly surfaceId: string | null;
}

export interface FieldKnowledge extends KnowledgeRecordBase {
  readonly kind: "known-field";
  readonly field: {
    readonly name: string;
    readonly required: boolean;
    readonly valueType: KnowledgeValueType;
  };
  readonly matcher: Extract<KnowledgeMatcher, { readonly id: "field-presence" | "field-type" }>;
}

export interface LocationKnowledge extends KnowledgeRecordBase {
  readonly kind: "known-location";
  readonly location: {
    readonly path: RepositoryRelativePath;
    readonly scope: LocationScope;
  };
  readonly matcher: Extract<KnowledgeMatcher, { readonly id: "location-exact" }>;
}

export interface DeprecationKnowledge extends KnowledgeRecordBase {
  readonly kind: "deprecation";
  readonly deprecation: {
    readonly deprecatedSince: string;
    readonly removalVersion: string | null;
    readonly replacementId: string | null;
    readonly subjectId: string;
  };
  readonly matcher: Extract<KnowledgeMatcher, { readonly id: "identifier-equals" }>;
}

export interface MigrationKnowledge extends KnowledgeRecordBase {
  readonly kind: "migration-hint";
  readonly migration: {
    readonly fromId: string;
    readonly guidance: string;
    readonly toId: string;
  };
  readonly matcher: Extract<KnowledgeMatcher, { readonly id: "identifier-transition" }>;
}

export type KnowledgeRecord =
  DeprecationKnowledge | FieldKnowledge | LocationKnowledge | MigrationKnowledge;

export interface KnowledgePack {
  readonly recordKind: "agent-context-knowledge-pack";
  readonly schemaVersion: typeof KNOWLEDGE_PACK_CONTRACT_VERSION;
  readonly packId: string;
  readonly packVersion: string;
  readonly publishedAt: string;
  readonly channel: KnowledgePackChannel;
  readonly compatibility: readonly StandardsCompatibility[];
  readonly sources: readonly KnowledgePackSource[];
  readonly knowledge: readonly KnowledgeRecord[];
}

export type KnowledgePackIssueCode =
  | "duplicate-id"
  | "forbidden-field"
  | "invalid-json"
  | "invalid-order"
  | "invalid-relationship"
  | "invalid-value"
  | "missing-field"
  | "non-canonical"
  | "resource-limit"
  | "unknown-field"
  | "unsupported-version";

export interface KnowledgePackIssue {
  readonly code: KnowledgePackIssueCode;
  readonly path: string;
  readonly message: string;
}

export type KnowledgePackValidationResult =
  | { readonly ok: true; readonly value: KnowledgePack }
  | { readonly ok: false; readonly issues: readonly KnowledgePackIssue[] };

export type KnowledgePackParseResult =
  | { readonly ok: true; readonly value: KnowledgePack; readonly canonicalJson: string }
  | { readonly ok: false; readonly issues: readonly KnowledgePackIssue[] };

export type CanonicalJsonResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly issues: readonly KnowledgePackIssue[] };

type UnknownRecord = Record<string, unknown>;
type JsonValue = boolean | null | number | string | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

const STABLE_ID = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const RULE_ID = /^ACL[1-9][0-9]{2}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const FORBIDDEN_CAPABILITY_FIELDS = new Set([
  "callback",
  "code",
  "command",
  "eval",
  "executable",
  "expression",
  "function",
  "glob",
  "handler",
  "module",
  "plugin",
  "regex",
  "require",
  "script",
  "template",
]);
const ALLOWED_VALUE_TYPES = new Set<string>(KNOWLEDGE_VALUE_TYPES);
const ALLOWED_LOCATION_SCOPES = new Set<string>(LOCATION_SCOPES);
const ALLOWED_MATCHERS = new Set<string>(KNOWLEDGE_MATCHER_IDS);
const ALLOWED_CHANNELS = new Set<string>(KNOWLEDGE_PACK_CHANNELS);

type IntrinsicGetter = (this: unknown) => unknown;
type IntrinsicFunction = (...arguments_: readonly unknown[]) => unknown;

function requirePrototype(value: object, name: string): object {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype === null) throw new TypeError(`${name} prototype is unavailable`);
  return prototype;
}

function requireIntrinsicGetter(prototype: object, key: string): IntrinsicGetter {
  const getter = Reflect.getOwnPropertyDescriptor(prototype, key)?.get;
  if (getter === undefined) throw new TypeError(`${key} intrinsic getter is unavailable`);
  return getter;
}

function requireIntrinsicFunction(prototype: object, key: string): IntrinsicFunction {
  const value: unknown = Reflect.getOwnPropertyDescriptor(prototype, key)?.value;
  if (typeof value !== "function") throw new TypeError(`${key} intrinsic function is unavailable`);
  return value as IntrinsicFunction;
}

const TYPED_ARRAY_PROTOTYPE = requirePrototype(Uint8Array.prototype, "TypedArray");
const TYPED_ARRAY_BYTE_LENGTH = requireIntrinsicGetter(TYPED_ARRAY_PROTOTYPE, "byteLength");
const TYPED_ARRAY_BUFFER = requireIntrinsicGetter(TYPED_ARRAY_PROTOTYPE, "buffer");
const UINT8_ARRAY_SET = requireIntrinsicFunction(TYPED_ARRAY_PROTOTYPE, "set");

interface MutableValidationState {
  containerEntries: number;
  issues: KnowledgePackIssue[];
  stringBytes: number;
  values: number;
}

class IssueLimitReached extends Error {}

function addIssue(
  state: MutableValidationState,
  code: KnowledgePackIssueCode,
  path: string,
  message: string,
): void {
  if (state.issues.length >= MAX_KNOWLEDGE_PACK_ISSUES - 1) {
    if (state.issues.length === MAX_KNOWLEDGE_PACK_ISSUES - 1) {
      state.issues.push({
        code: "resource-limit",
        path: "$",
        message: `validation stopped after ${String(MAX_KNOWLEDGE_PACK_ISSUES - 1)} issues`,
      });
    }
    throw new IssueLimitReached();
  }
  state.issues.push({ code, path, message });
}

interface UnicodeMetrics {
  readonly bytes: number;
  readonly codePoints: number;
}

function isUnicodeNoncharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint <= 0x10ffff && (codePoint & 0xfffe) === 0xfffe)
  );
}

function iJsonUnicodeMetrics(value: string): UnicodeMetrics | undefined {
  let bytes = 0;
  let codePoints = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    let codePoint = unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return undefined;
      codePoint = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return undefined;
    if (isUnicodeNoncharacter(codePoint)) return undefined;
    codePoints += 1;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return { bytes, codePoints };
}

function inspectJsonValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
  state: MutableValidationState,
): value is JsonValue {
  state.values += 1;
  if (state.values > MAX_KNOWLEDGE_PACK_VALUES) {
    addIssue(state, "resource-limit", path, "exceeds the maximum JSON value count");
    return false;
  }
  if (depth > MAX_KNOWLEDGE_PACK_DEPTH) {
    addIssue(state, "resource-limit", path, "exceeds the maximum JSON nesting depth");
    return false;
  }
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      addIssue(state, "invalid-json", path, "numbers must be finite IEEE 754 values");
      return false;
    }
    return true;
  }
  if (typeof value === "string") {
    const metrics = iJsonUnicodeMetrics(value);
    const bytes = metrics?.bytes ?? 0;
    state.stringBytes += bytes;
    if (
      metrics === undefined ||
      metrics.codePoints > MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS ||
      bytes > MAX_KNOWLEDGE_PACK_STRING_BYTES
    ) {
      addIssue(
        state,
        "invalid-json",
        path,
        "strings must be bounded I-JSON Unicode without surrogates or noncharacters",
      );
      return false;
    }
    if (state.stringBytes > MAX_KNOWLEDGE_PACK_TOTAL_STRING_BYTES) {
      addIssue(state, "resource-limit", path, "exceeds the total string-byte limit");
      return false;
    }
    return true;
  }
  if (typeof value !== "object") {
    addIssue(state, "invalid-json", path, "must contain only JSON values");
    return false;
  }
  if (nodeTypes.isProxy(value)) {
    addIssue(state, "invalid-json", path, "proxies are not accepted");
    return false;
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    addIssue(state, "invalid-json", path, "must be safely inspectable JSON data");
    return false;
  }
  const isArray = Array.isArray(value);
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    addIssue(state, "invalid-json", path, "objects and arrays must have plain prototypes");
    return false;
  }
  if (ancestors.has(value)) {
    addIssue(state, "invalid-json", path, "cycles are not accepted");
    return false;
  }
  ancestors.add(value);
  const expectedArrayKeys = isArray ? (value as unknown[]).length + 1 : keys.length;
  if (isArray && keys.length !== expectedArrayKeys) {
    addIssue(state, "invalid-json", path, "arrays must be dense and contain no extra fields");
  }
  state.containerEntries += isArray ? (value as unknown[]).length : keys.length;
  if (state.containerEntries > MAX_KNOWLEDGE_PACK_CONTAINER_ENTRIES)
    addIssue(state, "resource-limit", path, "exceeds the container-entry limit");
  let valid = true;
  for (const key of keys) {
    if (isArray && key === "length") continue;
    if (typeof key !== "string") {
      addIssue(state, "invalid-json", path, "symbol properties are not accepted");
      valid = false;
      continue;
    }
    const keyMetrics = iJsonUnicodeMetrics(key);
    if (
      keyMetrics === undefined ||
      keyMetrics.codePoints > MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS ||
      keyMetrics.bytes > MAX_KNOWLEDGE_PACK_STRING_BYTES
    ) {
      addIssue(
        state,
        "invalid-json",
        path,
        "property names must be bounded I-JSON Unicode without noncharacters",
      );
      valid = false;
      continue;
    }
    state.stringBytes += keyMetrics.bytes;
    if (state.stringBytes > MAX_KNOWLEDGE_PACK_TOTAL_STRING_BYTES) {
      addIssue(state, "resource-limit", path, "exceeds the total string-byte limit");
      valid = false;
    }
    if (isArray && !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      addIssue(state, "invalid-json", `${path}.${key}`, "arrays may only contain indexed items");
      valid = false;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      addIssue(state, "invalid-json", `${path}.${key}`, "must be an enumerable own data property");
      valid = false;
      continue;
    }
    const childPath = isArray ? `${path}[${key}]` : `${path}.${key}`;
    if (!isArray && FORBIDDEN_CAPABILITY_FIELDS.has(key.toLowerCase())) {
      addIssue(state, "forbidden-field", childPath, "executable capability fields are forbidden");
      valid = false;
    }
    valid = inspectJsonValue(descriptor.value, childPath, depth + 1, ancestors, state) && valid;
  }
  ancestors.delete(value);
  return valid;
}

function object(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  state: MutableValidationState,
): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addIssue(state, "invalid-value", path, "must be an object");
    return undefined;
  }
  const record = value as UnknownRecord;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      addIssue(
        state,
        FORBIDDEN_CAPABILITY_FIELDS.has(key.toLowerCase()) ? "forbidden-field" : "unknown-field",
        `${path}.${key}`,
        "is not part of the closed knowledge-pack contract",
      );
    }
  }
  return record;
}

function requiredString(
  record: UnknownRecord,
  key: string,
  path: string,
  state: MutableValidationState,
  pattern?: RegExp,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    addIssue(state, "missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    addIssue(state, "invalid-value", `${path}.${key}`, "has an invalid value");
    return undefined;
  }
  return value;
}

function nullableStableId(
  record: UnknownRecord,
  key: string,
  path: string,
  state: MutableValidationState,
): string | null | undefined {
  if (!Object.hasOwn(record, key)) {
    addIssue(state, "missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  if (record[key] === null) return null;
  return requiredString(record, key, path, state, STABLE_ID);
}

function nullableString(
  record: UnknownRecord,
  key: string,
  path: string,
  state: MutableValidationState,
): string | null | undefined {
  if (!Object.hasOwn(record, key)) {
    addIssue(state, "missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  if (record[key] === null) return null;
  return requiredString(record, key, path, state);
}

function exactDate(value: string): boolean {
  const match = DATE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function exactHttpsUrl(value: string): boolean {
  if (!value.startsWith("https://") || value.includes("\\") || /%(?![0-9A-Fa-f]{2})/u.test(value))
    return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname.length > 0 &&
      parsed.toString() === value
    );
  } catch {
    return false;
  }
}

interface ParsedSemver {
  readonly core: readonly [string, string, string];
  readonly prerelease: readonly string[] | null;
}

function parseSemver(value: string): ParsedSemver | undefined {
  const match = SEMVER.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
    return undefined;
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] === undefined ? null : match[4].split("."),
  };
}

function array(
  value: unknown,
  path: string,
  maximum: number,
  state: MutableValidationState,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    addIssue(
      state,
      value === undefined ? "missing-field" : "invalid-value",
      path,
      "must be an array",
    );
    return [];
  }
  if (value.length > maximum)
    addIssue(state, "resource-limit", path, `must contain at most ${String(maximum)} items`);
  return value.slice(0, maximum);
}

function sortedUniqueStrings(
  value: unknown,
  path: string,
  maximum: number,
  state: MutableValidationState,
  pattern: RegExp,
): readonly string[] {
  const output: string[] = [];
  for (const [index, item] of array(value, path, maximum, state).entries()) {
    if (typeof item !== "string" || !pattern.test(item)) {
      addIssue(state, "invalid-value", `${path}[${String(index)}]`, "has an invalid value");
      continue;
    }
    const previous = output.at(-1);
    if (previous !== undefined && previous >= item)
      addIssue(
        state,
        previous === item || output.includes(item) ? "duplicate-id" : "invalid-order",
        `${path}[${String(index)}]`,
        "must be unique and sorted by UTF-16 code units",
      );
    output.push(item);
  }
  if (output.length === 0) addIssue(state, "invalid-value", path, "must not be empty");
  return Object.freeze(output);
}

function validateSources(
  value: unknown,
  state: MutableValidationState,
): readonly KnowledgePackSource[] {
  const output: KnowledgePackSource[] = [];
  const ids = new Set<string>();
  for (const [index, item] of array(
    value,
    "$.sources",
    MAX_KNOWLEDGE_PACK_SOURCES,
    state,
  ).entries()) {
    const path = `$.sources[${String(index)}]`;
    const record = object(item, path, ["id", "retrievedAt", "sha256", "url"], state);
    if (record === undefined) continue;
    const id = requiredString(record, "id", path, state, STABLE_ID);
    const retrievedAt = requiredString(record, "retrievedAt", path, state);
    const sha256 = requiredString(record, "sha256", path, state, SHA256);
    const url = requiredString(record, "url", path, state);
    if (retrievedAt !== undefined && !exactDate(retrievedAt))
      addIssue(state, "invalid-value", `${path}.retrievedAt`, "must be a real YYYY-MM-DD date");
    if (url !== undefined && !exactHttpsUrl(url))
      addIssue(state, "invalid-value", `${path}.url`, "must be an exact credential-free HTTPS URL");
    if (id !== undefined) {
      const previous = output.at(-1)?.id;
      if (previous !== undefined && previous >= id)
        addIssue(
          state,
          ids.has(id) ? "duplicate-id" : "invalid-order",
          `${path}.id`,
          "sources must be unique and sorted by id",
        );
      ids.add(id);
    }
    if (
      id !== undefined &&
      retrievedAt !== undefined &&
      sha256 !== undefined &&
      url !== undefined &&
      exactDate(retrievedAt) &&
      exactHttpsUrl(url)
    )
      output.push(Object.freeze({ id, retrievedAt, sha256, url }));
  }
  if (output.length === 0)
    addIssue(state, "invalid-value", "$.sources", "must contain at least one source");
  return Object.freeze(output);
}

function validateCompatibility(
  value: unknown,
  expectedChannel: string | undefined,
  sources: readonly KnowledgePackSource[],
  state: MutableValidationState,
): readonly StandardsCompatibility[] {
  const output: StandardsCompatibility[] = [];
  const ids = new Set<string>();
  const sourcesByUrl = new Map(sources.map((source) => [source.url, source]));
  for (const [index, item] of array(
    value,
    "$.compatibility",
    MAX_KNOWLEDGE_COMPATIBILITY_RECORDS,
    state,
  ).entries()) {
    const path = `$.compatibility[${String(index)}]`;
    const record = object(
      item,
      path,
      [
        "adapterVersion",
        "channel",
        "contentDigests",
        "formatId",
        "minEngineVersion",
        "profileId",
        "retrievedAt",
        "rulesetVersion",
        "specificationUrls",
        "surfaceId",
        "upstreamRevision",
      ],
      state,
    );
    if (record === undefined) continue;
    const adapterVersion = requiredString(record, "adapterVersion", path, state);
    const channel = requiredString(record, "channel", path, state);
    const formatId = requiredString(record, "formatId", path, state, STABLE_ID);
    const minEngineVersion = requiredString(record, "minEngineVersion", path, state);
    const profileId = nullableStableId(record, "profileId", path, state);
    const retrievedAt = requiredString(record, "retrievedAt", path, state);
    const rulesetVersion = requiredString(record, "rulesetVersion", path, state);
    const specificationUrls = sortedUniqueStrings(
      record["specificationUrls"],
      `${path}.specificationUrls`,
      MAX_KNOWLEDGE_PACK_SOURCES,
      state,
      /^https:\/\//u,
    );
    const surfaceId = nullableStableId(record, "surfaceId", path, state);
    const upstreamRevision = nullableStableId(record, "upstreamRevision", path, state);
    const versions = [
      ["adapterVersion", adapterVersion],
      ["minEngineVersion", minEngineVersion],
      ["rulesetVersion", rulesetVersion],
    ] as const;
    for (const [key, version] of versions)
      if (version !== undefined && parseSemver(version) === undefined)
        addIssue(state, "invalid-value", `${path}.${key}`, "must be exact SemVer 2.0.0");
    if (channel !== undefined && !ALLOWED_CHANNELS.has(channel))
      addIssue(state, "invalid-value", `${path}.channel`, "must be preview or stable");
    if (channel !== undefined && expectedChannel !== undefined && channel !== expectedChannel)
      addIssue(state, "invalid-relationship", `${path}.channel`, "must equal the pack channel");
    if (retrievedAt !== undefined && !exactDate(retrievedAt))
      addIssue(state, "invalid-value", `${path}.retrievedAt`, "must be a real YYYY-MM-DD date");
    for (const [urlIndex, url] of specificationUrls.entries()) {
      if (!exactHttpsUrl(url))
        addIssue(
          state,
          "invalid-value",
          `${path}.specificationUrls[${String(urlIndex)}]`,
          "must be an exact credential-free HTTPS URL",
        );
    }
    const digestValue = record["contentDigests"];
    const digestRecord = object(
      digestValue,
      `${path}.contentDigests`,
      digestValue !== null && typeof digestValue === "object" && !Array.isArray(digestValue)
        ? Object.keys(digestValue)
        : [],
      state,
    );
    const contentDigests: Record<string, string> = {};
    if (digestRecord !== undefined) {
      const digestUrls = Object.keys(digestRecord);
      if (digestUrls.length === 0)
        addIssue(state, "invalid-value", `${path}.contentDigests`, "must not be empty");
      if (
        digestUrls.length !== specificationUrls.length ||
        digestUrls.some((url, urlIndex) => url !== specificationUrls[urlIndex])
      )
        addIssue(
          state,
          "invalid-relationship",
          `${path}.contentDigests`,
          "keys must exactly equal specificationUrls in canonical UTF-16 order",
        );
      for (const url of digestUrls) {
        const digest = digestRecord[url];
        if (!exactHttpsUrl(url) || typeof digest !== "string" || !SHA256.test(digest))
          addIssue(
            state,
            "invalid-value",
            `${path}.contentDigests.${url}`,
            "must map an exact HTTPS URL to a lowercase SHA-256 digest",
          );
        else contentDigests[url] = digest;
      }
    }
    for (const url of specificationUrls) {
      const source = sourcesByUrl.get(url);
      if (
        source === undefined ||
        source.retrievedAt !== retrievedAt ||
        source.sha256 !== contentDigests[url]
      )
        addIssue(
          state,
          "invalid-relationship",
          `${path}.specificationUrls`,
          "each specification must exactly match a source URL, retrieval date, and digest",
        );
    }
    if (formatId !== undefined && profileId !== undefined && surfaceId !== undefined) {
      const identity = `${formatId}\0${profileId ?? ""}\0${surfaceId ?? ""}`;
      const previousRecord = output.at(-1);
      const previous =
        previousRecord === undefined
          ? undefined
          : `${previousRecord.formatId}\0${previousRecord.profileId ?? ""}\0${previousRecord.surfaceId ?? ""}`;
      if (previous !== undefined && previous >= identity)
        addIssue(
          state,
          ids.has(identity) ? "duplicate-id" : "invalid-order",
          `${path}.formatId`,
          "compatibility identities must be unique and sorted by format, profile, and surface",
        );
      ids.add(identity);
    }
    if (
      adapterVersion !== undefined &&
      parseSemver(adapterVersion) !== undefined &&
      channel !== undefined &&
      ALLOWED_CHANNELS.has(channel) &&
      formatId !== undefined &&
      minEngineVersion !== undefined &&
      parseSemver(minEngineVersion) !== undefined &&
      profileId !== undefined &&
      retrievedAt !== undefined &&
      exactDate(retrievedAt) &&
      rulesetVersion !== undefined &&
      parseSemver(rulesetVersion) !== undefined &&
      specificationUrls.length > 0 &&
      surfaceId !== undefined &&
      upstreamRevision !== undefined
    )
      output.push(
        Object.freeze({
          adapterVersion,
          channel: channel as KnowledgePackChannel,
          contentDigests: Object.freeze(contentDigests),
          formatId,
          minEngineVersion,
          profileId,
          retrievedAt,
          rulesetVersion,
          specificationUrls,
          surfaceId,
          upstreamRevision,
        }),
      );
  }
  if (output.length === 0) addIssue(state, "invalid-value", "$.compatibility", "must not be empty");
  return Object.freeze(output);
}

function validateMatcher(
  value: unknown,
  path: string,
  state: MutableValidationState,
): KnowledgeMatcher | undefined {
  const record = object(value, path, ["id", "operands"], state);
  if (record === undefined) return undefined;
  const id = requiredString(record, "id", path, state);
  if (id === undefined || !ALLOWED_MATCHERS.has(id)) {
    if (id !== undefined)
      addIssue(state, "invalid-value", `${path}.id`, "is not an allowlisted engine-owned matcher");
    return undefined;
  }
  if (id === "field-presence") {
    const operands = object(record["operands"], `${path}.operands`, ["fieldName"], state);
    const fieldName =
      operands === undefined
        ? undefined
        : requiredString(operands, "fieldName", `${path}.operands`, state, STABLE_ID);
    return fieldName === undefined
      ? undefined
      : Object.freeze({ id, operands: Object.freeze({ fieldName }) });
  }
  if (id === "field-type") {
    const operands = object(
      record["operands"],
      `${path}.operands`,
      ["fieldName", "valueType"],
      state,
    );
    const fieldName =
      operands === undefined
        ? undefined
        : requiredString(operands, "fieldName", `${path}.operands`, state, STABLE_ID);
    const valueType =
      operands === undefined
        ? undefined
        : requiredString(operands, "valueType", `${path}.operands`, state);
    if (valueType !== undefined && !ALLOWED_VALUE_TYPES.has(valueType))
      addIssue(state, "invalid-value", `${path}.operands.valueType`, "is not a known value type");
    return fieldName === undefined || valueType === undefined || !ALLOWED_VALUE_TYPES.has(valueType)
      ? undefined
      : Object.freeze({
          id,
          operands: Object.freeze({ fieldName, valueType: valueType as KnowledgeValueType }),
        });
  }
  if (id === "location-exact") {
    const operands = object(record["operands"], `${path}.operands`, ["path", "scope"], state);
    const repositoryPath =
      operands === undefined
        ? undefined
        : requiredString(operands, "path", `${path}.operands`, state);
    const scope =
      operands === undefined
        ? undefined
        : requiredString(operands, "scope", `${path}.operands`, state);
    if (repositoryPath !== undefined && !isRepositoryRelativePath(repositoryPath))
      addIssue(
        state,
        "invalid-value",
        `${path}.operands.path`,
        "must be a repository-relative exact path",
      );
    if (scope !== undefined && !ALLOWED_LOCATION_SCOPES.has(scope))
      addIssue(state, "invalid-value", `${path}.operands.scope`, "is not a known location scope");
    return repositoryPath === undefined ||
      !isRepositoryRelativePath(repositoryPath) ||
      scope === undefined ||
      !ALLOWED_LOCATION_SCOPES.has(scope)
      ? undefined
      : Object.freeze({
          id,
          operands: Object.freeze({ path: repositoryPath, scope: scope as LocationScope }),
        });
  }
  if (id === "identifier-equals") {
    const operands = object(record["operands"], `${path}.operands`, ["identifier"], state);
    const identifier =
      operands === undefined
        ? undefined
        : requiredString(operands, "identifier", `${path}.operands`, state, STABLE_ID);
    return identifier === undefined
      ? undefined
      : Object.freeze({ id, operands: Object.freeze({ identifier }) });
  }
  const operands = object(record["operands"], `${path}.operands`, ["fromId", "toId"], state);
  const fromId =
    operands === undefined
      ? undefined
      : requiredString(operands, "fromId", `${path}.operands`, state, STABLE_ID);
  const toId =
    operands === undefined
      ? undefined
      : requiredString(operands, "toId", `${path}.operands`, state, STABLE_ID);
  return fromId === undefined || toId === undefined
    ? undefined
    : Object.freeze({ id: "identifier-transition", operands: Object.freeze({ fromId, toId }) });
}

function commonRecord(
  record: UnknownRecord,
  path: string,
  state: MutableValidationState,
): Omit<KnowledgeRecordBase, never> | undefined {
  const id = requiredString(record, "id", path, state, STABLE_ID);
  const profileId = nullableStableId(record, "profileId", path, state);
  const surfaceId = nullableStableId(record, "surfaceId", path, state);
  const summary = requiredString(record, "summary", path, state);
  const ruleIds = sortedUniqueStrings(
    record["ruleIds"],
    `${path}.ruleIds`,
    MAX_KNOWLEDGE_PACK_RULE_IDS,
    state,
    RULE_ID,
  );
  const sourceIds = sortedUniqueStrings(
    record["sourceIds"],
    `${path}.sourceIds`,
    MAX_KNOWLEDGE_PACK_SOURCES,
    state,
    STABLE_ID,
  );
  return id === undefined ||
    profileId === undefined ||
    surfaceId === undefined ||
    summary === undefined
    ? undefined
    : { id, profileId, ruleIds, sourceIds, summary, surfaceId };
}

function validateKnowledge(
  value: unknown,
  sources: ReadonlySet<string>,
  state: MutableValidationState,
): readonly KnowledgeRecord[] {
  const output: KnowledgeRecord[] = [];
  const ids = new Set<string>();
  for (const [index, item] of array(
    value,
    "$.knowledge",
    MAX_KNOWLEDGE_PACK_RECORDS,
    state,
  ).entries()) {
    const path = `$.knowledge[${String(index)}]`;
    const discriminator =
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? (item as UnknownRecord)["kind"]
        : undefined;
    const payloadKey =
      discriminator === "known-field"
        ? "field"
        : discriminator === "known-location"
          ? "location"
          : discriminator === "deprecation"
            ? "deprecation"
            : discriminator === "migration-hint"
              ? "migration"
              : undefined;
    const allowed = [
      "id",
      "kind",
      "matcher",
      "profileId",
      "ruleIds",
      "sourceIds",
      "summary",
      "surfaceId",
      ...(payloadKey === undefined ? [] : [payloadKey]),
    ];
    const record = object(item, path, allowed, state);
    if (record === undefined) continue;
    const kind = requiredString(record, "kind", path, state);
    if (kind === undefined || !KNOWLEDGE_KINDS.includes(kind as (typeof KNOWLEDGE_KINDS)[number])) {
      if (kind !== undefined)
        addIssue(state, "invalid-value", `${path}.kind`, "is not a known knowledge kind");
      continue;
    }
    const common = commonRecord(record, path, state);
    const matcher = validateMatcher(record["matcher"], `${path}.matcher`, state);
    let result: KnowledgeRecord | undefined;
    if (kind === "known-field") {
      const field = object(
        record["field"],
        `${path}.field`,
        ["name", "required", "valueType"],
        state,
      );
      const name =
        field === undefined
          ? undefined
          : requiredString(field, "name", `${path}.field`, state, STABLE_ID);
      const required = field?.["required"];
      const valueType =
        field === undefined
          ? undefined
          : requiredString(field, "valueType", `${path}.field`, state);
      if (typeof required !== "boolean")
        addIssue(
          state,
          required === undefined ? "missing-field" : "invalid-value",
          `${path}.field.required`,
          "must be Boolean",
        );
      if (valueType !== undefined && !ALLOWED_VALUE_TYPES.has(valueType))
        addIssue(state, "invalid-value", `${path}.field.valueType`, "is not a known value type");
      if (matcher !== undefined && matcher.id !== "field-presence" && matcher.id !== "field-type")
        addIssue(
          state,
          "invalid-relationship",
          `${path}.matcher.id`,
          "is incompatible with known-field knowledge",
        );
      if (
        matcher !== undefined &&
        name !== undefined &&
        (matcher.id === "field-presence" || matcher.id === "field-type") &&
        matcher.operands.fieldName !== name
      )
        addIssue(
          state,
          "invalid-relationship",
          `${path}.matcher.operands.fieldName`,
          "must equal field.name",
        );
      if (
        matcher?.id === "field-type" &&
        valueType !== undefined &&
        matcher.operands.valueType !== valueType
      )
        addIssue(
          state,
          "invalid-relationship",
          `${path}.matcher.operands.valueType`,
          "must equal field.valueType",
        );
      if (
        common !== undefined &&
        name !== undefined &&
        typeof required === "boolean" &&
        valueType !== undefined &&
        ALLOWED_VALUE_TYPES.has(valueType) &&
        (matcher?.id === "field-presence" || matcher?.id === "field-type")
      )
        result = Object.freeze({
          ...common,
          field: Object.freeze({ name, required, valueType: valueType as KnowledgeValueType }),
          kind,
          matcher,
        });
    } else if (kind === "known-location") {
      const location = object(record["location"], `${path}.location`, ["path", "scope"], state);
      const repositoryPath =
        location === undefined
          ? undefined
          : requiredString(location, "path", `${path}.location`, state);
      const scope =
        location === undefined
          ? undefined
          : requiredString(location, "scope", `${path}.location`, state);
      if (repositoryPath !== undefined && !isRepositoryRelativePath(repositoryPath))
        addIssue(
          state,
          "invalid-value",
          `${path}.location.path`,
          "must be a repository-relative exact path",
        );
      if (scope !== undefined && !ALLOWED_LOCATION_SCOPES.has(scope))
        addIssue(state, "invalid-value", `${path}.location.scope`, "is not a known location scope");
      if (matcher !== undefined && matcher.id !== "location-exact")
        addIssue(
          state,
          "invalid-relationship",
          `${path}.matcher.id`,
          "is incompatible with known-location knowledge",
        );
      if (
        matcher?.id === "location-exact" &&
        repositoryPath !== undefined &&
        (matcher.operands.path !== repositoryPath || matcher.operands.scope !== scope)
      )
        addIssue(
          state,
          "invalid-relationship",
          `${path}.matcher.operands`,
          "must equal the known location",
        );
      if (
        common !== undefined &&
        repositoryPath !== undefined &&
        isRepositoryRelativePath(repositoryPath) &&
        scope !== undefined &&
        ALLOWED_LOCATION_SCOPES.has(scope) &&
        matcher?.id === "location-exact"
      )
        result = Object.freeze({
          ...common,
          kind,
          location: Object.freeze({ path: repositoryPath, scope: scope as LocationScope }),
          matcher,
        });
    } else if (kind === "deprecation") {
      const deprecation = object(
        record["deprecation"],
        `${path}.deprecation`,
        ["deprecatedSince", "removalVersion", "replacementId", "subjectId"],
        state,
      );
      const subjectId =
        deprecation === undefined
          ? undefined
          : requiredString(deprecation, "subjectId", `${path}.deprecation`, state, STABLE_ID);
      const deprecatedSince =
        deprecation === undefined
          ? undefined
          : requiredString(deprecation, "deprecatedSince", `${path}.deprecation`, state);
      const replacementId =
        deprecation === undefined
          ? undefined
          : nullableStableId(deprecation, "replacementId", `${path}.deprecation`, state);
      const removalVersion =
        deprecation === undefined
          ? undefined
          : nullableString(deprecation, "removalVersion", `${path}.deprecation`, state);
      if (deprecatedSince !== undefined && !exactDate(deprecatedSince))
        addIssue(
          state,
          "invalid-value",
          `${path}.deprecation.deprecatedSince`,
          "must be a real YYYY-MM-DD date",
        );
      if (typeof removalVersion === "string" && parseSemver(removalVersion) === undefined)
        addIssue(
          state,
          "invalid-value",
          `${path}.deprecation.removalVersion`,
          "must be exact SemVer 2.0.0 or null",
        );
      if (replacementId !== null && replacementId === subjectId)
        addIssue(
          state,
          "invalid-relationship",
          `${path}.deprecation.replacementId`,
          "must differ from subjectId",
        );
      if (matcher !== undefined && matcher.id !== "identifier-equals")
        addIssue(
          state,
          "invalid-relationship",
          `${path}.matcher.id`,
          "is incompatible with deprecation knowledge",
        );
      if (
        matcher?.id === "identifier-equals" &&
        subjectId !== undefined &&
        matcher.operands.identifier !== subjectId
      )
        addIssue(
          state,
          "invalid-relationship",
          `${path}.matcher.operands.identifier`,
          "must equal deprecation.subjectId",
        );
      if (
        common !== undefined &&
        subjectId !== undefined &&
        deprecatedSince !== undefined &&
        exactDate(deprecatedSince) &&
        replacementId !== undefined &&
        removalVersion !== undefined &&
        (removalVersion === null || parseSemver(removalVersion) !== undefined) &&
        matcher?.id === "identifier-equals"
      )
        result = Object.freeze({
          ...common,
          deprecation: Object.freeze({ deprecatedSince, removalVersion, replacementId, subjectId }),
          kind,
          matcher,
        });
    } else {
      const migration = object(
        record["migration"],
        `${path}.migration`,
        ["fromId", "guidance", "toId"],
        state,
      );
      const fromId =
        migration === undefined
          ? undefined
          : requiredString(migration, "fromId", `${path}.migration`, state, STABLE_ID);
      const guidance =
        migration === undefined
          ? undefined
          : requiredString(migration, "guidance", `${path}.migration`, state);
      const toId =
        migration === undefined
          ? undefined
          : requiredString(migration, "toId", `${path}.migration`, state, STABLE_ID);
      if (fromId !== undefined && fromId === toId)
        addIssue(
          state,
          "invalid-relationship",
          `${path}.migration.toId`,
          "must differ from fromId",
        );
      if (matcher !== undefined && matcher.id !== "identifier-transition")
        addIssue(
          state,
          "invalid-relationship",
          `${path}.matcher.id`,
          "is incompatible with migration knowledge",
        );
      if (
        matcher?.id === "identifier-transition" &&
        (matcher.operands.fromId !== fromId || matcher.operands.toId !== toId)
      )
        addIssue(
          state,
          "invalid-relationship",
          `${path}.matcher.operands`,
          "must equal the migration identifiers",
        );
      if (
        common !== undefined &&
        fromId !== undefined &&
        guidance !== undefined &&
        toId !== undefined &&
        fromId !== toId &&
        matcher?.id === "identifier-transition"
      )
        result = Object.freeze({
          ...common,
          kind: "migration-hint",
          matcher,
          migration: Object.freeze({ fromId, guidance, toId }),
        });
    }
    if (common !== undefined) {
      const previous = output.at(-1)?.id;
      if (previous !== undefined && previous >= common.id)
        addIssue(
          state,
          ids.has(common.id) ? "duplicate-id" : "invalid-order",
          `${path}.id`,
          "knowledge records must be unique and sorted by id",
        );
      ids.add(common.id);
      for (const sourceId of common.sourceIds)
        if (!sources.has(sourceId))
          addIssue(
            state,
            "invalid-relationship",
            `${path}.sourceIds`,
            `references unknown source '${sourceId}'`,
          );
    }
    if (result !== undefined) output.push(result);
  }
  if (output.length === 0)
    addIssue(state, "invalid-value", "$.knowledge", "must contain at least one knowledge record");
  return Object.freeze(output);
}

function createState(): MutableValidationState {
  return { containerEntries: 0, issues: [], stringBytes: 0, values: 0 };
}

/** Validate an untrusted in-memory value and return an immutable authority-bearing copy. */
export function validateKnowledgePack(input: unknown): KnowledgePackValidationResult {
  const state = createState();
  try {
    if (!inspectJsonValue(input, "$", 0, new Set(), state))
      return { ok: false, issues: Object.freeze(state.issues) };
    const root = object(
      input,
      "$",
      [
        "channel",
        "compatibility",
        "knowledge",
        "packId",
        "packVersion",
        "publishedAt",
        "recordKind",
        "schemaVersion",
        "sources",
      ],
      state,
    );
    if (root === undefined) return { ok: false, issues: Object.freeze(state.issues) };
    const recordKind = requiredString(root, "recordKind", "$", state);
    if (recordKind !== undefined && recordKind !== "agent-context-knowledge-pack")
      addIssue(
        state,
        "invalid-value",
        "$.recordKind",
        "must identify an agent context knowledge pack",
      );
    const schemaVersion = requiredString(root, "schemaVersion", "$", state);
    if (schemaVersion !== undefined && schemaVersion !== KNOWLEDGE_PACK_CONTRACT_VERSION)
      addIssue(
        state,
        "unsupported-version",
        "$.schemaVersion",
        `only ${KNOWLEDGE_PACK_CONTRACT_VERSION} is supported`,
      );
    const channel = requiredString(root, "channel", "$", state);
    if (channel !== undefined && !ALLOWED_CHANNELS.has(channel))
      addIssue(state, "invalid-value", "$.channel", "must be preview or stable");
    const packId = requiredString(root, "packId", "$", state, STABLE_ID);
    const packVersion = requiredString(root, "packVersion", "$", state);
    if (packVersion !== undefined && parseSemver(packVersion) === undefined)
      addIssue(state, "invalid-value", "$.packVersion", "must be exact SemVer 2.0.0");
    const publishedAt = requiredString(root, "publishedAt", "$", state);
    if (publishedAt !== undefined && !exactDate(publishedAt))
      addIssue(state, "invalid-value", "$.publishedAt", "must be a real YYYY-MM-DD date");
    const sources = validateSources(root["sources"], state);
    if (publishedAt !== undefined && exactDate(publishedAt))
      for (const [index, source] of sources.entries())
        if (source.retrievedAt > publishedAt)
          addIssue(
            state,
            "invalid-relationship",
            `$.sources[${String(index)}].retrievedAt`,
            "must not be later than publishedAt",
          );
    const compatibility = validateCompatibility(root["compatibility"], channel, sources, state);
    const knowledge = validateKnowledge(
      root["knowledge"],
      new Set(sources.map((source) => source.id)),
      state,
    );
    if (
      state.issues.length > 0 ||
      recordKind !== "agent-context-knowledge-pack" ||
      schemaVersion !== KNOWLEDGE_PACK_CONTRACT_VERSION ||
      channel === undefined ||
      !ALLOWED_CHANNELS.has(channel) ||
      packId === undefined ||
      packVersion === undefined ||
      parseSemver(packVersion) === undefined ||
      publishedAt === undefined ||
      !exactDate(publishedAt)
    )
      return { ok: false, issues: Object.freeze(state.issues) };
    const value: KnowledgePack = Object.freeze({
      channel: channel as KnowledgePackChannel,
      compatibility,
      knowledge,
      packId,
      packVersion,
      publishedAt,
      recordKind,
      schemaVersion,
      sources,
    });
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof IssueLimitReached))
      state.issues.splice(0, state.issues.length, {
        code: "invalid-json",
        path: "$",
        message: "input must be safely inspectable JSON data",
      });
    return { ok: false, issues: Object.freeze(state.issues) };
  }
}

function canonicalJsonValue(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    const encoded = JSON.stringify(value);
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  const objectValue = value as JsonObject;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(objectValue[key] as JsonValue)}`)
    .join(",")}}`;
}

/** RFC 8785 JCS serialization for bounded I-JSON values; no normalization is performed. */
export function canonicalizeJson(input: unknown): CanonicalJsonResult {
  const state = createState();
  try {
    if (!inspectJsonValue(input, "$", 0, new Set(), state))
      return { ok: false, issues: Object.freeze(state.issues) };
    return { ok: true, text: canonicalJsonValue(input) };
  } catch {
    return {
      ok: false,
      issues: Object.freeze([
        { code: "invalid-json", path: "$", message: "input cannot be canonicalized safely" },
      ]),
    };
  }
}

/** Validate and serialize a knowledge pack to canonical RFC 8785 UTF-8 text. */
export function serializeKnowledgePack(input: unknown): CanonicalJsonResult {
  const validation = validateKnowledgePack(input);
  return validation.ok ? canonicalizeJson(validation.value) : validation;
}

interface KnowledgePackFailure {
  readonly ok: false;
  readonly issues: readonly KnowledgePackIssue[];
}

function singleIssue(code: KnowledgePackIssueCode, message: string): KnowledgePackFailure {
  return { ok: false, issues: Object.freeze([{ code, path: "$", message }]) };
}

function rawBytes(
  input: string | Uint8Array,
): { readonly ok: true; readonly value: Uint8Array } | KnowledgePackFailure {
  if (typeof input === "string") {
    if (input.length > MAX_KNOWLEDGE_PACK_BYTES)
      return singleIssue(
        "resource-limit",
        `pack exceeds ${String(MAX_KNOWLEDGE_PACK_BYTES)} bytes`,
      );
    if (iJsonUnicodeMetrics(input) === undefined)
      return singleIssue("invalid-json", "input must be well-formed UTF-8 text or bytes");
    const byteLength = Buffer.byteLength(input, "utf8");
    if (byteLength > MAX_KNOWLEDGE_PACK_BYTES)
      return singleIssue(
        "resource-limit",
        `pack exceeds ${String(MAX_KNOWLEDGE_PACK_BYTES)} bytes`,
      );
    return { ok: true, value: Buffer.from(input, "utf8") };
  }
  if (nodeTypes.isProxy(input) || !nodeTypes.isUint8Array(input))
    return singleIssue("invalid-json", "input must be well-formed UTF-8 text or bytes");
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
    return singleIssue("invalid-json", "exotic byte views are not accepted");
  const internalByteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, input, []);
  const internalBuffer = Reflect.apply(TYPED_ARRAY_BUFFER, input, []);
  if (typeof internalByteLength !== "number")
    return singleIssue("invalid-json", "byte input has invalid internal state");
  if (internalByteLength > MAX_KNOWLEDGE_PACK_BYTES)
    return singleIssue("resource-limit", `pack exceeds ${String(MAX_KNOWLEDGE_PACK_BYTES)} bytes`);
  if (nodeTypes.isSharedArrayBuffer(internalBuffer))
    return singleIssue("invalid-json", "shared byte buffers are not accepted");
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== internalByteLength ||
    ownKeys.some((key, index) => typeof key !== "string" || key !== String(index))
  )
    return singleIssue("invalid-json", "byte input must not carry extra or symbolic properties");
  const copy = new Uint8Array(internalByteLength);
  Reflect.apply(UINT8_ARRAY_SET, copy, [input, 0]);
  return { ok: true, value: copy };
}

interface LexicalContainer {
  readonly kind: "array" | "object";
  commas: number;
  hasValue: boolean;
}

interface LexicalStringSuccess {
  readonly ok: true;
  readonly end: number;
}

function hexDigit(unit: number): number | undefined {
  if (unit >= 0x30 && unit <= 0x39) return unit - 0x30;
  if (unit >= 0x41 && unit <= 0x46) return unit - 0x41 + 10;
  if (unit >= 0x61 && unit <= 0x66) return unit - 0x61 + 10;
  return undefined;
}

function hexQuad(text: string, start: number): number | undefined {
  let value = 0;
  for (let offset = 0; offset < 4; offset += 1) {
    const digit = hexDigit(text.charCodeAt(start + offset));
    if (digit === undefined) return undefined;
    value = value * 16 + digit;
  }
  return value;
}

function codePointUtf8Bytes(codePoint: number): number {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

function scanJsonString(
  text: string,
  openingQuote: number,
): LexicalStringSuccess | KnowledgePackFailure {
  let bytes = 0;
  let codePoints = 0;
  for (let index = openingQuote + 1; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22) return { ok: true, end: index };
    let codePoint = unit;
    if (unit === 0x5c) {
      const escape = text.charCodeAt(index + 1);
      if (escape === 0x75) {
        const escaped = hexQuad(text, index + 2);
        if (escaped === undefined) continue;
        codePoint = escaped;
        index += 5;
        if (escaped >= 0xd800 && escaped <= 0xdbff) {
          if (text.charCodeAt(index + 1) !== 0x5c || text.charCodeAt(index + 2) !== 0x75)
            return singleIssue("invalid-json", "JSON strings must not contain lone surrogates");
          const low = hexQuad(text, index + 3);
          if (low === undefined || low < 0xdc00 || low > 0xdfff)
            return singleIssue("invalid-json", "JSON strings must not contain lone surrogates");
          codePoint = 0x10000 + ((escaped - 0xd800) << 10) + (low - 0xdc00);
          index += 6;
        } else if (escaped >= 0xdc00 && escaped <= 0xdfff) {
          return singleIssue("invalid-json", "JSON strings must not contain lone surrogates");
        }
      } else {
        codePoint =
          escape === 0x62
            ? 0x08
            : escape === 0x66
              ? 0x0c
              : escape === 0x6e
                ? 0x0a
                : escape === 0x72
                  ? 0x0d
                  : escape === 0x74
                    ? 0x09
                    : escape;
        index += 1;
      }
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff)
        return singleIssue("invalid-json", "JSON strings must not contain lone surrogates");
      codePoint = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return singleIssue("invalid-json", "JSON strings must not contain lone surrogates");
    }
    if (isUnicodeNoncharacter(codePoint))
      return singleIssue("invalid-json", "I-JSON strings must not contain Unicode noncharacters");
    codePoints += 1;
    bytes += codePointUtf8Bytes(codePoint);
    if (
      codePoints > MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS ||
      bytes > MAX_KNOWLEDGE_PACK_STRING_BYTES
    )
      return singleIssue("resource-limit", "a decoded JSON string exceeds its resource limit");
  }
  return { ok: true, end: text.length };
}

/** Bound structural work before JSON.parse; JSON.parse remains the syntax authority. */
function lexicalPreflight(text: string): KnowledgePackFailure | undefined {
  const stack: LexicalContainer[] = [];
  let containerEntries = 0;
  let structuralTokens = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (/\s/u.test(character)) continue;
    const parent = stack.at(-1);
    if (character === '"') {
      structuralTokens += 1;
      if (parent?.kind === "array") parent.hasValue = true;
      const stringResult = scanJsonString(text, index);
      if (!stringResult.ok) return stringResult;
      index = stringResult.end;
    } else if (character === "{" || character === "[") {
      structuralTokens += 1;
      if (parent?.kind === "array") parent.hasValue = true;
      stack.push({ kind: character === "[" ? "array" : "object", commas: 0, hasValue: false });
      if (stack.length > MAX_KNOWLEDGE_PACK_DEPTH + 1)
        return singleIssue("resource-limit", "pack exceeds the maximum JSON nesting depth");
    } else if (character === "}" || character === "]") {
      const closed = stack.pop();
      if (closed?.kind === "array" && closed.hasValue) containerEntries += closed.commas + 1;
    } else if (character === ",") {
      if (parent?.kind === "array") parent.commas += 1;
    } else if (character === ":") {
      containerEntries += 1;
    } else {
      structuralTokens += 1;
      if (parent?.kind === "array") parent.hasValue = true;
      while (index + 1 < text.length && !/[\s,\]}:]/u.test(text.charAt(index + 1))) index += 1;
    }
    if (containerEntries > MAX_KNOWLEDGE_PACK_CONTAINER_ENTRIES)
      return singleIssue("resource-limit", "pack exceeds the container-entry limit");
    if (structuralTokens > MAX_KNOWLEDGE_PACK_VALUES + MAX_KNOWLEDGE_PACK_CONTAINER_ENTRIES)
      return singleIssue("resource-limit", "pack exceeds the structural-token limit");
  }
  return undefined;
}

/** Parse only exact canonical UTF-8 JCS bytes; duplicate keys and alternate spellings fail closed. */
export function parseCanonicalKnowledgePack(input: string | Uint8Array): KnowledgePackParseResult {
  try {
    const raw = rawBytes(input);
    if (!raw.ok) return raw;
    const bytes = raw.value;
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    if (Buffer.byteLength(text, "utf8") !== bytes.byteLength)
      return {
        ok: false,
        issues: Object.freeze([
          {
            code: "invalid-json",
            path: "$",
            message: "input must use canonical UTF-8 without a byte-order mark",
          },
        ]),
      };
    const preflightIssue = lexicalPreflight(text);
    if (preflightIssue !== undefined) return preflightIssue;
    const parsed: unknown = JSON.parse(text);
    const validation = validateKnowledgePack(parsed);
    if (!validation.ok) return validation;
    const serialized = canonicalizeJson(validation.value);
    if (!serialized.ok) return serialized;
    if (serialized.text !== text)
      return {
        ok: false,
        issues: Object.freeze([
          {
            code: "non-canonical",
            path: "$",
            message:
              "input must be exact RFC 8785 canonical JSON; duplicate keys, whitespace, alternate escapes, and alternate number spellings are forbidden",
          },
        ]),
      };
    return { ok: true, value: validation.value, canonicalJson: serialized.text };
  } catch {
    return {
      ok: false,
      issues: Object.freeze([
        { code: "invalid-json", path: "$", message: "input is not valid canonical UTF-8 JSON" },
      ]),
    };
  }
}
