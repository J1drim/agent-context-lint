import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  CONFIGURATION_PROFILE_IDS,
  CONFIGURATION_PROFILE_KEY_BY_ID,
  isRepositoryRelativePath,
  validateAgentContextConfiguration,
} from "@agent-context/core";

import type { AgentContextConfiguration, RepositoryRelativePath } from "@agent-context/core";
import type { ReadOnlyRepositoryIdentity } from "@agent-context/evidence";
import { isIssuedClaudeCodeProfileResolution } from "./claude-code-profile.js";
import { isIssuedCodexCliAgentsResolution } from "./codex-cli-profile.js";
import { isIssuedCopilotProfileResolution } from "./copilot-profile.js";
import { isIssuedCursorProfileResolution } from "./cursor-profile.js";
import { isIssuedDocumentImportDag, type DocumentImportDag } from "./document-import-dag.js";
import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  isIssuedEffectiveContextResolution,
  resolveEffectiveContext,
} from "./effective-context.js";
import type {
  EffectiveContextProfileResolution,
  EffectiveContextResolution,
  ResolveEffectiveContextInput,
} from "./effective-context.js";
import { isIssuedGeminiCliResolution } from "./gemini-cli-profile.js";
import { isIssuedTargetSamplingResult, TARGET_SAMPLER_CONTRACT_VERSION } from "./target-sampler.js";
import type { SampledTarget, TargetSamplingResult } from "./target-sampler.js";

export const EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION = "0.1.0" as const;
export const EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND =
  "agent-context-effective-context-cache-request" as const;
export const EFFECTIVE_CONTEXT_CACHE_KEY_RECORD_KIND =
  "agent-context-effective-context-cache-key" as const;

export interface EffectiveContextCacheLimits {
  readonly maximumCanonicalNodes: number;
  readonly maximumCanonicalTextBytes: number;
  readonly maximumDependencyBytes: number;
  readonly maximumDependencyFiles: number;
  readonly maximumEntries: number;
  readonly maximumEntryBytes: number;
  readonly maximumIdentityBytes: number;
  readonly maximumPathBytes: number;
  readonly maximumWeightBytes: number;
}

export const EFFECTIVE_CONTEXT_CACHE_DEFAULT_LIMITS: Readonly<EffectiveContextCacheLimits> =
  Object.freeze({
    maximumCanonicalNodes: 1_000_000,
    maximumCanonicalTextBytes: 67_108_864,
    maximumDependencyBytes: 67_108_864,
    maximumDependencyFiles: 65_536,
    maximumEntries: 1_024,
    maximumEntryBytes: 33_554_432,
    maximumIdentityBytes: 1_024,
    maximumPathBytes: 4_096,
    maximumWeightBytes: 67_108_864,
  });

export const EFFECTIVE_CONTEXT_CACHE_HARD_LIMITS: Readonly<EffectiveContextCacheLimits> =
  Object.freeze({
    maximumCanonicalNodes: 10_000_000,
    maximumCanonicalTextBytes: 536_870_912,
    maximumDependencyBytes: 1_073_741_824,
    maximumDependencyFiles: 1_000_000,
    maximumEntries: 65_536,
    maximumEntryBytes: 268_435_456,
    maximumIdentityBytes: 16_384,
    maximumPathBytes: 16_384,
    maximumWeightBytes: 1_073_741_824,
  });

export type EffectiveContextCacheOptions = Partial<EffectiveContextCacheLimits>;

export interface EffectiveContextCacheDocumentSnapshot {
  readonly bytes: Uint8Array | null;
  readonly identity: ReadOnlyRepositoryIdentity | null;
  readonly path: RepositoryRelativePath;
  readonly state: "available" | "unavailable";
}

export interface EffectiveContextCacheRequest {
  readonly configuration: AgentContextConfiguration;
  readonly configurationIdentity: ReadOnlyRepositoryIdentity | null;
  readonly context: ResolveEffectiveContextInput;
  readonly contractVersion: typeof EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION;
  readonly documents: readonly EffectiveContextCacheDocumentSnapshot[];
  readonly recordKind: typeof EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND;
  readonly sampling: TargetSamplingResult;
  readonly targetIdentity: ReadOnlyRepositoryIdentity | null;
}

export interface EffectiveContextCacheResolveOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface EffectiveContextCacheKey {
  readonly configurationSha256: string;
  readonly contractVersion: typeof EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION;
  readonly dependencySha256: string;
  readonly importDagSha256: string;
  readonly profileId: string;
  readonly profileResolutionSha256: string;
  readonly profileVersion: string;
  readonly recordKind: typeof EFFECTIVE_CONTEXT_CACHE_KEY_RECORD_KIND;
  readonly samplingSha256: string;
  readonly sha256: string;
  readonly sourceIdentitySha256: string;
  readonly specSnapshotId: string;
  readonly surfaceId: string;
  readonly targetPath: RepositoryRelativePath;
}

export interface EffectiveContextCacheStats {
  readonly entries: number;
  readonly evictions: number;
  readonly hits: number;
  readonly misses: number;
  readonly oversizedResults: number;
  readonly weightBytes: number;
}

export const EffectiveContextCacheErrorCode: Readonly<{
  cancelled: "EFFECTIVE_CONTEXT_CACHE_CANCELLED";
  invalidInput: "EFFECTIVE_CONTEXT_CACHE_INVALID_INPUT";
  invalidOptions: "EFFECTIVE_CONTEXT_CACHE_INVALID_OPTIONS";
  invalidRelationship: "EFFECTIVE_CONTEXT_CACHE_INVALID_RELATIONSHIP";
  resourceLimit: "EFFECTIVE_CONTEXT_CACHE_RESOURCE_LIMIT";
}> = Object.freeze({
  cancelled: "EFFECTIVE_CONTEXT_CACHE_CANCELLED",
  invalidInput: "EFFECTIVE_CONTEXT_CACHE_INVALID_INPUT",
  invalidOptions: "EFFECTIVE_CONTEXT_CACHE_INVALID_OPTIONS",
  invalidRelationship: "EFFECTIVE_CONTEXT_CACHE_INVALID_RELATIONSHIP",
  resourceLimit: "EFFECTIVE_CONTEXT_CACHE_RESOURCE_LIMIT",
});

export type EffectiveContextCacheErrorCode =
  (typeof EffectiveContextCacheErrorCode)[keyof typeof EffectiveContextCacheErrorCode];

export class EffectiveContextCacheError extends Error {
  readonly code: EffectiveContextCacheErrorCode;
  override readonly name = "EffectiveContextCacheError" as const;

  constructor(code: EffectiveContextCacheErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface CanonicalBudget {
  nodes: number;
  textBytes: number;
}

interface NormalizedDocument {
  readonly contentSha256: string | null;
  readonly identity: ReadOnlyRepositoryIdentity | null;
  readonly path: RepositoryRelativePath;
  readonly size: number | null;
  readonly state: "available" | "unavailable";
}

interface NormalizedRequest {
  readonly configuration: AgentContextConfiguration;
  readonly configurationIdentity: ReadOnlyRepositoryIdentity | null;
  readonly context: ResolveEffectiveContextInput;
  readonly documents: readonly NormalizedDocument[];
  readonly samplingTarget: SampledTarget;
  readonly sampling: TargetSamplingResult;
  readonly targetIdentity: ReadOnlyRepositoryIdentity | null;
}

interface CacheEntry {
  readonly dependencies: readonly ExpectedDependency[];
  readonly resolution: EffectiveContextResolution;
  readonly weightBytes: number;
}

interface ExpectedDependency {
  readonly path: RepositoryRelativePath;
  readonly state: "available" | "unavailable";
}

const REQUEST_KEYS = new Set([
  "configuration",
  "configurationIdentity",
  "context",
  "contractVersion",
  "documents",
  "recordKind",
  "sampling",
  "targetIdentity",
]);
const CONTEXT_KEYS = new Set([
  "contractVersion",
  "importDags",
  "profileResolution",
  "recordKind",
  "targetPath",
]);
const DOCUMENT_KEYS = new Set(["bytes", "identity", "path", "state"]);
const IDENTITY_KEYS = new Set(["device", "inode"]);
const CONFIGURATION_KEYS = new Set([
  "commands",
  "efficiency",
  "ignore",
  "limits",
  "profiles",
  "rules",
  "security",
  "standards",
  "version",
]);
const CONFIGURATION_PROFILE_KEYS = new Set(CONFIGURATION_PROFILE_IDS);
const RESOLVE_OPTION_KEYS = new Set(["signal"]);
const LIMIT_KEYS = new Set(Object.keys(EFFECTIVE_CONTEXT_CACHE_DEFAULT_LIMITS));
const PROFILE_KINDS = new Set([
  "agent-context-claude-code-profile-resolution",
  "agent-context-codex-cli-agents-resolution",
  "agent-context-copilot-profile-resolution",
  "agent-context-cursor-profile-resolution",
  "agent-context-gemini-cli-resolution",
]);
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Uint8Array.prototype);
/* v8 ignore next -- every supported Node runtime exposes the typed-array intrinsic prototype */
if (TYPED_ARRAY_PROTOTYPE === null) throw new TypeError("TypedArray prototype is unavailable");
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

function fail(code: EffectiveContextCacheErrorCode, message: string): never {
  throw new EffectiveContextCacheError(code, message);
}

function dataRecord(value: unknown, label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return fail(EffectiveContextCacheErrorCode.invalidInput, `${label} must be a data record`);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return fail(
      EffectiveContextCacheErrorCode.invalidInput,
      `${label} must be a plain data record`,
    );
  return value as DataRecord;
}

function field(record: DataRecord, key: string, label: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
    return fail(
      EffectiveContextCacheErrorCode.invalidInput,
      `${label} must contain enumerable data fields`,
    );
  return descriptor.value;
}

function closedRecord(value: unknown, keys: ReadonlySet<string>, label: string): DataRecord {
  const record = dataRecord(value, label);
  const actual = Reflect.ownKeys(record);
  if (
    actual.length !== keys.size ||
    actual.some((key) => typeof key !== "string" || !keys.has(key))
  )
    return fail(EffectiveContextCacheErrorCode.invalidInput, `${label} has invalid fields`);
  for (const key of actual) field(record, key as string, label);
  return record;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return fail(EffectiveContextCacheErrorCode.invalidInput, `${label} must be a regular array`);
  if (value.length > maximum)
    return fail(EffectiveContextCacheErrorCode.resourceLimit, `${label} exceeds its item limit`);
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return fail(
      EffectiveContextCacheErrorCode.invalidInput,
      `${label} must be dense and unextended`,
    );
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        EffectiveContextCacheErrorCode.invalidInput,
        `${label} must contain enumerable data entries`,
      );
    output.push(descriptor.value);
  }
  return output;
}

function wellFormedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string")
    return fail(EffectiveContextCacheErrorCode.invalidInput, `${label} must be text`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff)
        return fail(
          EffectiveContextCacheErrorCode.invalidInput,
          `${label} is not well-formed text`,
        );
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      return fail(EffectiveContextCacheErrorCode.invalidInput, `${label} is not well-formed text`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximum)
    return fail(EffectiveContextCacheErrorCode.resourceLimit, `${label} exceeds its byte limit`);
  return value;
}

function identity(
  value: unknown,
  limits: EffectiveContextCacheLimits,
  label: string,
): ReadOnlyRepositoryIdentity | null {
  if (value === null) return null;
  const record = closedRecord(value, IDENTITY_KEYS, label);
  const device = wellFormedText(
    field(record, "device", label),
    limits.maximumIdentityBytes,
    `${label}.device`,
  );
  const inode = wellFormedText(
    field(record, "inode", label),
    limits.maximumIdentityBytes,
    `${label}.inode`,
  );
  if (device === "" || inode === "")
    return fail(EffectiveContextCacheErrorCode.invalidInput, `${label} fields must not be empty`);
  return Object.freeze({ device, inode });
}

function pathValue(
  value: unknown,
  limits: EffectiveContextCacheLimits,
  label: string,
): RepositoryRelativePath {
  if (typeof value !== "string" || !isRepositoryRelativePath(value))
    return fail(
      EffectiveContextCacheErrorCode.invalidInput,
      `${label} must be a canonical repository path`,
    );
  wellFormedText(value, limits.maximumPathBytes, label);
  return value;
}

function snapshotBytes(value: unknown, maximum: number, label: string): Uint8Array {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    TYPED_ARRAY_BYTE_LENGTH === undefined ||
    TYPED_ARRAY_BYTE_OFFSET === undefined ||
    TYPED_ARRAY_BUFFER === undefined ||
    ARRAY_BUFFER_BYTE_LENGTH === undefined
  )
    return fail(EffectiveContextCacheErrorCode.invalidInput, `${label} must be Uint8Array data`);
  let byteLength: unknown;
  let byteOffset: unknown;
  let buffer: unknown;
  let bufferByteLength: unknown;
  try {
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []);
    byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET, value, []);
    buffer = Reflect.apply(TYPED_ARRAY_BUFFER, value, []);
    bufferByteLength = Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH, buffer, []);
  } catch {
    return fail(EffectiveContextCacheErrorCode.invalidInput, `${label} must be attached byte data`);
  }
  if (
    typeof byteLength !== "number" ||
    typeof byteOffset !== "number" ||
    buffer === null ||
    typeof buffer !== "object" ||
    typeof bufferByteLength !== "number" ||
    byteOffset + byteLength > bufferByteLength ||
    byteLength > maximum
  )
    return fail(EffectiveContextCacheErrorCode.resourceLimit, `${label} exceeds its byte limit`);
  try {
    const source = new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength);
    const output = new Uint8Array(byteLength);
    Reflect.apply(UINT8_ARRAY_SET, output, [source]);
    return output;
  } catch {
    return fail(EffectiveContextCacheErrorCode.invalidInput, `${label} must be attached byte data`);
  }
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function frame(hash: ReturnType<typeof createHash>, tag: string, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(tag, "ascii");
  hash.update(":" + String(bytes.length) + ":", "ascii");
  hash.update(bytes);
}

function canonicalDigest(value: unknown, limits: EffectiveContextCacheLimits): string {
  const hash = createHash("sha256");
  const budget: CanonicalBudget = { nodes: 0, textBytes: 0 };
  const ancestors = new WeakSet<object>();
  const visit = (current: unknown): void => {
    budget.nodes += 1;
    if (budget.nodes > limits.maximumCanonicalNodes)
      return fail(
        EffectiveContextCacheErrorCode.resourceLimit,
        "canonical dependency graph exceeds its node limit",
      );
    if (current === null) {
      frame(hash, "n", "");
      return;
    }
    if (typeof current === "boolean") {
      frame(hash, "b", current ? "1" : "0");
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0))
        return fail(
          EffectiveContextCacheErrorCode.invalidInput,
          "canonical dependency graph contains an invalid number",
        );
      frame(hash, "d", String(current));
      return;
    }
    if (typeof current === "string") {
      wellFormedText(current, limits.maximumCanonicalTextBytes, "canonical dependency text");
      budget.textBytes += Buffer.byteLength(current, "utf8");
      if (budget.textBytes > limits.maximumCanonicalTextBytes)
        return fail(
          EffectiveContextCacheErrorCode.resourceLimit,
          "canonical dependency graph exceeds its text limit",
        );
      frame(hash, "s", current);
      return;
    }
    if (typeof current !== "object" || nodeTypes.isProxy(current))
      return fail(
        EffectiveContextCacheErrorCode.invalidInput,
        "canonical dependency graph contains unsupported data",
      );
    if (ancestors.has(current))
      return fail(
        EffectiveContextCacheErrorCode.invalidInput,
        "canonical dependency graph must be acyclic",
      );
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const values = denseArray(
          current,
          limits.maximumCanonicalNodes,
          "canonical dependency array",
        );
        frame(hash, "a", String(values.length));
        for (const entry of values) visit(entry);
        frame(hash, "z", "a");
        return;
      }
      const prototype = Reflect.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null)
        return fail(
          EffectiveContextCacheErrorCode.invalidInput,
          "canonical dependency graph must contain only plain data records",
        );
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== "string"))
        return fail(
          EffectiveContextCacheErrorCode.invalidInput,
          "canonical dependency graph must not contain symbols",
        );
      const sorted = (keys as string[]).sort(compareUtf8);
      frame(hash, "o", String(sorted.length));
      for (const key of sorted) {
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
          return fail(
            EffectiveContextCacheErrorCode.invalidInput,
            "canonical dependency graph must contain enumerable data fields",
          );
        frame(hash, "k", key);
        visit(descriptor.value);
      }
      frame(hash, "z", "o");
    } finally {
      ancestors.delete(current);
    }
  };
  visit(value);
  return hash.digest("hex");
}

function abortState(value: unknown): boolean | undefined {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return undefined;
  if (ABORTED_GETTER === undefined) return undefined;
  try {
    const state: unknown = Reflect.apply(ABORTED_GETTER, value, []);
    return typeof state === "boolean" ? state : undefined;
  } catch {
    return undefined;
  }
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal !== undefined && abortState(signal) !== false)
    fail(EffectiveContextCacheErrorCode.cancelled, "effective-context cache operation cancelled");
}

function resolveSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  const record = dataRecord(value, "resolve options");
  const keys = Reflect.ownKeys(record);
  if (
    keys.length > RESOLVE_OPTION_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !RESOLVE_OPTION_KEYS.has(key))
  )
    return fail(
      EffectiveContextCacheErrorCode.invalidOptions,
      "resolve options have invalid fields",
    );
  if (keys.length === 0) return undefined;
  const signal = field(record, "signal", "resolve options");
  if (signal === undefined) return undefined;
  if (abortState(signal) === undefined)
    return fail(
      EffectiveContextCacheErrorCode.invalidOptions,
      "resolve signal must be a native AbortSignal",
    );
  return signal as AbortSignal;
}

function limits(value: unknown): Readonly<EffectiveContextCacheLimits> {
  if (value === undefined) return EFFECTIVE_CONTEXT_CACHE_DEFAULT_LIMITS;
  const record = dataRecord(value, "cache options");
  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== "string" || !LIMIT_KEYS.has(key)))
    return fail(EffectiveContextCacheErrorCode.invalidOptions, "cache options have invalid fields");
  const output = { ...EFFECTIVE_CONTEXT_CACHE_DEFAULT_LIMITS };
  for (const key of actual as (keyof EffectiveContextCacheLimits)[]) {
    const selected = field(record, key, "cache options");
    const maximum = EFFECTIVE_CONTEXT_CACHE_HARD_LIMITS[key];
    if (
      !Number.isSafeInteger(selected) ||
      (selected as number) < 1 ||
      (selected as number) > maximum
    )
      return fail(
        EffectiveContextCacheErrorCode.invalidOptions,
        "cache limits must be positive integers within hard ceilings",
      );
    output[key] = selected as number;
  }
  if (output.maximumEntryBytes > output.maximumWeightBytes)
    return fail(
      EffectiveContextCacheErrorCode.invalidOptions,
      "maximumEntryBytes must not exceed maximumWeightBytes",
    );
  return Object.freeze(output);
}

function profileResolution(value: unknown): EffectiveContextProfileResolution {
  const record = dataRecord(value, "context.profileResolution");
  const kind = field(record, "recordKind", "context.profileResolution");
  if (typeof kind !== "string" || !PROFILE_KINDS.has(kind))
    return fail(
      EffectiveContextCacheErrorCode.invalidInput,
      "context profile resolution kind is invalid",
    );
  if (
    (kind === "agent-context-claude-code-profile-resolution" &&
      isIssuedClaudeCodeProfileResolution(record)) ||
    (kind === "agent-context-codex-cli-agents-resolution" &&
      isIssuedCodexCliAgentsResolution(record)) ||
    (kind === "agent-context-copilot-profile-resolution" &&
      isIssuedCopilotProfileResolution(record)) ||
    (kind === "agent-context-cursor-profile-resolution" &&
      isIssuedCursorProfileResolution(record)) ||
    (kind === "agent-context-gemini-cli-resolution" && isIssuedGeminiCliResolution(record))
  )
    return record;
  return fail(
    EffectiveContextCacheErrorCode.invalidInput,
    "context profile resolution was not issued by its profile resolver",
  );
}

function profileFields(value: EffectiveContextProfileResolution): {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly specSnapshotId: string;
  readonly surfaceId: string;
} {
  const profile = value.profile;
  return {
    profileId: profile.profileId,
    profileVersion: profile.contractVersion,
    specSnapshotId: profile.specSnapshotId,
    surfaceId: profile.surfaceId,
  };
}

function contextInput(
  value: unknown,
  cacheLimits: EffectiveContextCacheLimits,
): ResolveEffectiveContextInput {
  const record = closedRecord(value, CONTEXT_KEYS, "context");
  if (
    field(record, "contractVersion", "context") !== EFFECTIVE_CONTEXT_CONTRACT_VERSION ||
    field(record, "recordKind", "context") !== EFFECTIVE_CONTEXT_INPUT_RECORD_KIND
  )
    return fail(
      EffectiveContextCacheErrorCode.invalidInput,
      "context kind or contract version is invalid",
    );
  const targetPath = pathValue(
    field(record, "targetPath", "context"),
    cacheLimits,
    "context target",
  );
  const profile = profileResolution(field(record, "profileResolution", "context"));
  const rawDags = denseArray(
    field(record, "importDags", "context"),
    cacheLimits.maximumDependencyFiles,
    "context import DAGs",
  );
  const dags = rawDags.map((dag) => {
    if (!isIssuedDocumentImportDag(dag))
      return fail(
        EffectiveContextCacheErrorCode.invalidInput,
        "context import DAG was not issued by E04",
      );
    return dag;
  });
  return Object.freeze({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: Object.freeze(dags),
    profileResolution: profile,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath,
  });
}

function normalizedDocuments(
  value: unknown,
  cacheLimits: EffectiveContextCacheLimits,
): readonly NormalizedDocument[] {
  const raw = denseArray(value, cacheLimits.maximumDependencyFiles, "documents");
  const seen = new Set<string>();
  let bytes = 0;
  const output = raw.map((item, index): NormalizedDocument => {
    const label = `documents[${String(index)}]`;
    const record = closedRecord(item, DOCUMENT_KEYS, label);
    const path = pathValue(field(record, "path", label), cacheLimits, `${label}.path`);
    if (seen.has(path))
      return fail(
        EffectiveContextCacheErrorCode.invalidRelationship,
        "document dependency paths must be unique",
      );
    seen.add(path);
    const state = field(record, "state", label);
    if (state !== "available" && state !== "unavailable")
      return fail(EffectiveContextCacheErrorCode.invalidInput, "document state is invalid");
    const sourceIdentity = identity(
      field(record, "identity", label),
      cacheLimits,
      `${label}.identity`,
    );
    const rawBytes = field(record, "bytes", label);
    if (state === "unavailable") {
      if (rawBytes !== null || sourceIdentity !== null)
        return fail(
          EffectiveContextCacheErrorCode.invalidRelationship,
          "unavailable dependencies cannot claim content or source identity",
        );
      return Object.freeze({ contentSha256: null, identity: null, path, size: null, state });
    }
    if (rawBytes === null || sourceIdentity === null)
      return fail(
        EffectiveContextCacheErrorCode.invalidRelationship,
        "available dependencies require content and source identity",
      );
    const copied = snapshotBytes(rawBytes, cacheLimits.maximumDependencyBytes, `${label}.bytes`);
    bytes += copied.byteLength;
    if (bytes > cacheLimits.maximumDependencyBytes)
      return fail(
        EffectiveContextCacheErrorCode.resourceLimit,
        "document dependencies exceed their total byte limit",
      );
    return Object.freeze({
      contentSha256: sha256Bytes(copied),
      identity: sourceIdentity,
      path,
      size: copied.byteLength,
      state,
    });
  });
  return Object.freeze(output.sort((left, right) => compareUtf8(left.path, right.path)));
}

function normalizedConfiguration(value: unknown): AgentContextConfiguration {
  const input = closedRecord(value, CONFIGURATION_KEYS, "configuration");
  const profiles = closedRecord(
    field(input, "profiles", "configuration"),
    CONFIGURATION_PROFILE_KEYS,
    "configuration.profiles",
  );
  const publicProfiles: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const profileId of CONFIGURATION_PROFILE_IDS)
    publicProfiles[CONFIGURATION_PROFILE_KEY_BY_ID[profileId]] = field(
      profiles,
      profileId,
      "configuration.profiles",
    );
  const publicInput: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of CONFIGURATION_KEYS)
    publicInput[key] = key === "profiles" ? publicProfiles : field(input, key, "configuration");
  const validated = validateAgentContextConfiguration(publicInput);
  if (!validated.ok)
    return fail(
      EffectiveContextCacheErrorCode.invalidInput,
      "cache request configuration is invalid",
    );
  return validated.value;
}

function normalizeRequest(
  value: unknown,
  cacheLimits: EffectiveContextCacheLimits,
): NormalizedRequest {
  const input = closedRecord(value, REQUEST_KEYS, "cache request");
  if (
    field(input, "recordKind", "cache request") !== EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND ||
    field(input, "contractVersion", "cache request") !== EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION
  )
    return fail(
      EffectiveContextCacheErrorCode.invalidInput,
      "cache request kind or contract version is invalid",
    );
  const configuration = normalizedConfiguration(field(input, "configuration", "cache request"));
  const context = contextInput(field(input, "context", "cache request"), cacheLimits);
  const sampling = field(input, "sampling", "cache request");
  if (!isIssuedTargetSamplingResult(sampling))
    return fail(
      EffectiveContextCacheErrorCode.invalidInput,
      "sampling proof was not issued by E08",
    );
  const samplingTarget = sampling.selected.find((entry) => entry.path === context.targetPath);
  if (samplingTarget === undefined)
    return fail(
      EffectiveContextCacheErrorCode.invalidRelationship,
      "effective-context target is not selected by the E08 sampling proof",
    );
  return {
    configuration,
    configurationIdentity: identity(
      field(input, "configurationIdentity", "cache request"),
      cacheLimits,
      "configurationIdentity",
    ),
    context,
    documents: normalizedDocuments(field(input, "documents", "cache request"), cacheLimits),
    sampling,
    samplingTarget,
    targetIdentity: identity(
      field(input, "targetIdentity", "cache request"),
      cacheLimits,
      "targetIdentity",
    ),
  };
}

function dependencyClosure(
  resolution: EffectiveContextResolution,
  dags: readonly DocumentImportDag[],
): readonly ExpectedDependency[] {
  const states = new Map<RepositoryRelativePath, ExpectedDependency["state"]>();
  const add = (path: RepositoryRelativePath, state: ExpectedDependency["state"]): void => {
    const existing = states.get(path);
    if (existing !== undefined && existing !== state)
      fail(
        EffectiveContextCacheErrorCode.invalidRelationship,
        "issued dependencies disagree on document availability",
      );
    states.set(path, state);
  };
  for (const document of resolution.documents)
    add(document.path, document.contentState === "unavailable" ? "unavailable" : "available");
  for (const dag of dags) {
    if (dag.documents.length === 0) add(dag.entryPath, "unavailable");
    for (const document of dag.documents) add(document.path, "available");
    for (const occurrence of dag.occurrences)
      if (occurrence.targetPath !== null)
        add(
          occurrence.targetPath,
          occurrence.targetDocumentId === null ? "unavailable" : "available",
        );
  }
  return Object.freeze(
    [...states.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([path, state]) => Object.freeze({ path, state })),
  );
}

function requireExactDependencies(
  expected: readonly ExpectedDependency[],
  actual: readonly NormalizedDocument[],
): void {
  if (
    expected.length !== actual.length ||
    expected.some((dependency, index) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- equal lengths and the expected-array iteration prove this index.
      const candidate = actual[index]!;
      return dependency.path !== candidate.path || dependency.state !== candidate.state;
    })
  )
    fail(
      EffectiveContextCacheErrorCode.invalidRelationship,
      "document dependency set must exactly cover effective and imported paths",
    );
}

function keyFor(
  request: NormalizedRequest,
  cacheLimits: EffectiveContextCacheLimits,
): EffectiveContextCacheKey {
  const profile = profileFields(request.context.profileResolution);
  const configurationSha256 = canonicalDigest(request.configuration, cacheLimits);
  const dependencySha256 = canonicalDigest(
    request.documents.map((entry) => ({
      contentSha256: entry.contentSha256,
      path: entry.path,
      size: entry.size,
      state: entry.state,
    })),
    cacheLimits,
  );
  const sourceIdentitySha256 = canonicalDigest(
    {
      configuration: request.configurationIdentity,
      documents: request.documents.map((entry) => ({ identity: entry.identity, path: entry.path })),
      target: request.targetIdentity,
    },
    cacheLimits,
  );
  const importDagSha256 = canonicalDigest(request.context.importDags, cacheLimits);
  const profileResolutionSha256 = canonicalDigest(request.context.profileResolution, cacheLimits);
  const samplingSha256 = canonicalDigest(
    {
      contractVersion: TARGET_SAMPLER_CONTRACT_VERSION,
      provenance: request.sampling.provenance,
      state: request.sampling.state,
      strategy: request.sampling.strategy,
      target: request.samplingTarget,
    },
    cacheLimits,
  );
  const digest = canonicalDigest(
    {
      cacheContractVersion: EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION,
      configurationSha256,
      dependencySha256,
      effectiveContextContractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
      importDagSha256,
      profileResolutionSha256,
      samplingSha256,
      sourceIdentitySha256,
      targetPath: request.context.targetPath,
    },
    cacheLimits,
  );
  return Object.freeze({
    configurationSha256,
    contractVersion: EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION,
    dependencySha256,
    importDagSha256,
    profileId: profile.profileId,
    profileResolutionSha256,
    profileVersion: profile.profileVersion,
    recordKind: EFFECTIVE_CONTEXT_CACHE_KEY_RECORD_KIND,
    samplingSha256,
    sha256: digest,
    sourceIdentitySha256,
    specSnapshotId: profile.specSnapshotId,
    surfaceId: profile.surfaceId,
    targetPath: request.context.targetPath,
  });
}

/**
 * Pure in-memory E09 memoization. Cache entries are optimizations only: every miss runs E05 and
 * validates the exact dependency-path closure before publication.
 */
export class EffectiveContextMemoizationCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #limits: Readonly<EffectiveContextCacheLimits>;
  #evictions = 0;
  #hits = 0;
  #misses = 0;
  #oversizedResults = 0;
  #weightBytes = 0;

  constructor(options?: EffectiveContextCacheOptions) {
    this.#limits = limits(options);
  }

  /** Derive the same content address used by `resolve` without reading or mutating cache state. */
  key(value: unknown, options?: EffectiveContextCacheResolveOptions): EffectiveContextCacheKey {
    const signal = resolveSignal(options);
    checkCancelled(signal);
    const request = normalizeRequest(value, this.#limits);
    const key = keyFor(request, this.#limits);
    checkCancelled(signal);
    return key;
  }

  /** Resolve cold or reuse a byte-identical, same-process E05 result on an exact key match. */
  resolve(
    value: unknown,
    options?: EffectiveContextCacheResolveOptions,
  ): EffectiveContextResolution {
    const signal = resolveSignal(options);
    checkCancelled(signal);
    const request = normalizeRequest(value, this.#limits);
    const key = keyFor(request, this.#limits);
    checkCancelled(signal);
    const existing = this.#entries.get(key.sha256);
    if (existing !== undefined) {
      requireExactDependencies(existing.dependencies, request.documents);
      /* v8 ignore next -- private entries retain the same frozen same-process E05 result */
      if (!isIssuedEffectiveContextResolution(existing.resolution))
        return fail(
          EffectiveContextCacheErrorCode.invalidRelationship,
          "cache entry lost its E05 issuance authority",
        );
      this.#hits += 1;
      return existing.resolution;
    }

    this.#misses += 1;
    const resolution = resolveEffectiveContext(request.context);
    checkCancelled(signal);
    const expectedDependencies = dependencyClosure(resolution, request.context.importDags);
    requireExactDependencies(expectedDependencies, request.documents);
    const weightBytes =
      Buffer.byteLength(JSON.stringify(resolution), "utf8") +
      Buffer.byteLength(JSON.stringify(expectedDependencies), "utf8") +
      Buffer.byteLength(key.sha256, "utf8");
    if (weightBytes > this.#limits.maximumEntryBytes) {
      this.#oversizedResults += 1;
      return resolution;
    }
    while (
      this.#entries.size >= this.#limits.maximumEntries ||
      this.#weightBytes + weightBytes > this.#limits.maximumWeightBytes
    ) {
      const oldest = this.#entries.entries().next().value;
      /* v8 ignore next -- positive limits and a non-empty over-capacity map guarantee an entry */
      if (oldest === undefined) break;
      this.#entries.delete(oldest[0]);
      this.#weightBytes -= oldest[1].weightBytes;
      this.#evictions += 1;
    }
    const entry: CacheEntry = Object.freeze({
      dependencies: expectedDependencies,
      resolution,
      weightBytes,
    });
    this.#entries.set(key.sha256, entry);
    this.#weightBytes += weightBytes;
    return resolution;
  }

  /** Drop optimization state without changing cumulative observability counters. */
  clear(): void {
    this.#entries.clear();
    this.#weightBytes = 0;
  }

  stats(): EffectiveContextCacheStats {
    return Object.freeze({
      entries: this.#entries.size,
      evictions: this.#evictions,
      hits: this.#hits,
      misses: this.#misses,
      oversizedResults: this.#oversizedResults,
      weightBytes: this.#weightBytes,
    });
  }
}
