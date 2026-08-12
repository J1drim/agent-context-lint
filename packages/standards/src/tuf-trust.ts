import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalize } from "@tufjs/canonical-json";
import { Metadata, MetadataKind } from "@tufjs/models";

import type { Root, Snapshot, Targets, Timestamp } from "@tufjs/models";

import { KNOWLEDGE_PACK_CONTRACT_VERSION } from "./knowledge-pack.js";

/**
 * Agent Context Standards POUF v0.1.0, constrained to TUF specification 1.0.35.
 *
 * The implementation intentionally supports one closed, Ed25519-only metadata
 * profile. Expanding algorithms, roles, paths, or extensions is a reviewed
 * trust-contract change rather than permissive parsing.
 */
export const TUF_TRUST_CONTRACT_VERSION = "0.1.0" as const;
export const TUF_SPECIFICATION_VERSION = "1.0.35" as const;
export const TUF_REPOSITORY_ID = "agent-context-standards" as const;
export const TUF_STABLE_ROLE = "standards-stable" as const;
export const TUF_PREVIEW_ROLE = "standards-preview" as const;
export const TUF_SUPPORTED_KEY_TYPE = "ed25519" as const;
export const TUF_SUPPORTED_KEY_SCHEME = "ed25519" as const;
export const MAX_TUF_METADATA_BYTES: number = 512 * 1024;
export const MAX_TUF_ROOT_CHAIN = 32;
export const MAX_TUF_JSON_DEPTH = 64;
export const MAX_TUF_JSON_VALUES = 50_000;
export const MAX_TUF_TARGET_BYTES: number = 4 * 1024 * 1024;
export const MAX_TUF_ISSUE_MESSAGE_BYTES = 512;
export const MAX_TUF_ISSUE_PATH_BYTES = 512;
export const MAX_TUF_PACK_ID_BYTES = 256;
export const MAX_TUF_SEMVER_BYTES = 256;
export const MAX_TUF_TARGET_PATH_BYTES = 1024;
export const TUF_CLOCK_SKEW_MS: number = 5 * 60 * 1000;

const ROLE_EXPIRY_LIMIT_MS = Object.freeze({
  root: 366 * 24 * 60 * 60 * 1000,
  snapshot: 8 * 24 * 60 * 60 * 1000,
  targets: 93 * 24 * 60 * 60 * 1000,
  timestamp: 25 * 60 * 60 * 1000,
});

const TOP_LEVEL_ROLES = Object.freeze(["root", "snapshot", "targets", "timestamp"] as const);
const CHANNEL_ROLE = Object.freeze({ preview: TUF_PREVIEW_ROLE, stable: TUF_STABLE_ROLE });
const CHANNEL_PATH = Object.freeze({
  preview: "knowledge/preview/*",
  stable: "knowledge/stable/*",
});
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ED25519_PUBLIC = /^[a-f0-9]{64}$/u;
const SIGNATURE = /^[a-f0-9]{128}$/u;
const TARGET_PATH = /^knowledge\/(?:preview|stable)\/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*\.json$/u;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;

export type TufChannel = "preview" | "stable";
export type TufMetadataRole = "root" | "snapshot" | "targets" | "timestamp";

export type TufTrustErrorCode =
  | "channel-mismatch"
  | "expired-metadata"
  | "hash-mismatch"
  | "incompatible-engine"
  | "invalid-input"
  | "invalid-metadata"
  | "invalid-policy"
  | "invalid-signature"
  | "length-mismatch"
  | "mix-and-match"
  | "replay"
  | "resource-limit"
  | "rollback"
  | "root-continuity"
  | "target-not-found"
  | "unsupported-version"
  | "wrong-role";

export interface TufTrustIssue {
  readonly code: TufTrustErrorCode;
  readonly path: string;
  readonly message: string;
}

export interface TufTrustedMetadataSummary {
  readonly expires: string;
  readonly issuedAt: string;
  readonly role: string;
  readonly sha256: string;
  readonly version: number;
}

export interface TufTrustedStateSnapshot {
  readonly contractVersion: typeof TUF_TRUST_CONTRACT_VERSION;
  readonly repositoryId: typeof TUF_REPOSITORY_ID;
  readonly root: TufTrustedMetadataSummary;
  readonly snapshot: TufTrustedMetadataSummary | null;
  readonly targets: TufTrustedMetadataSummary | null;
  readonly timestamp: TufTrustedMetadataSummary | null;
  readonly delegated: Readonly<{
    preview: TufTrustedMetadataSummary | null;
    stable: TufTrustedMetadataSummary | null;
  }>;
}

export interface TufOfflineUpdateBundle {
  readonly roots?: readonly (string | Uint8Array)[];
  readonly timestamp: string | Uint8Array;
  readonly snapshot: string | Uint8Array;
  readonly targets: string | Uint8Array;
  readonly delegatedTargets: string | Uint8Array;
  readonly target: string | Uint8Array;
}

export interface TufOfflineUpdateRequest {
  readonly channel: TufChannel;
  readonly engineVersion: string;
  readonly startedAt: string;
  readonly targetPath: string;
}

export interface TufVerifiedTarget {
  readonly channel: TufChannel;
  readonly length: number;
  readonly minEngineVersion: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly schemaVersion: typeof KNOWLEDGE_PACK_CONTRACT_VERSION;
  readonly sha256: string;
  readonly targetPath: string;
}

export interface TufVerifiedUpdate {
  readonly recovery: Readonly<{
    readonly rootVersionsApplied: readonly number[];
    readonly snapshotAuthorityRotated: boolean;
    readonly timestampAuthorityRotated: boolean;
  }>;
  readonly state: OfflineTufTrustStore;
  readonly target: TufVerifiedTarget;
  readonly targetBytes: Uint8Array;
}

export type TufTrustResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly issues: readonly TufTrustIssue[]; readonly ok: false };

interface JsonObject {
  readonly [key: string]: JsonValue;
  readonly _type?: JsonValue;
  readonly channel?: JsonValue;
  readonly consistent_snapshot?: JsonValue;
  readonly custom?: JsonValue;
  readonly delegations?: JsonValue;
  readonly engineVersion?: JsonValue;
  readonly expires?: JsonValue;
  readonly hashes?: JsonValue;
  readonly issuedAt?: JsonValue;
  readonly keyid?: JsonValue;
  readonly keyids?: JsonValue;
  readonly keys?: JsonValue;
  readonly keytype?: JsonValue;
  readonly keyval?: JsonValue;
  readonly length?: JsonValue;
  readonly meta?: JsonValue;
  readonly minEngineVersion?: JsonValue;
  readonly name?: JsonValue;
  readonly packId?: JsonValue;
  readonly packVersion?: JsonValue;
  readonly paths?: JsonValue;
  readonly policyVersion?: JsonValue;
  readonly preview?: JsonValue;
  readonly public?: JsonValue;
  readonly repositoryId?: JsonValue;
  readonly roles?: JsonValue;
  readonly root?: JsonValue;
  readonly scheme?: JsonValue;
  readonly schemaVersion?: JsonValue;
  readonly sha256?: JsonValue;
  readonly sig?: JsonValue;
  readonly signatures?: JsonValue;
  readonly signed?: JsonValue;
  readonly snapshot?: JsonValue;
  readonly spec_version?: JsonValue;
  readonly stable?: JsonValue;
  readonly startedAt?: JsonValue;
  readonly target?: JsonValue;
  readonly targetPath?: JsonValue;
  readonly targets?: JsonValue;
  readonly terminating?: JsonValue;
  readonly threshold?: JsonValue;
  readonly timestamp?: JsonValue;
  readonly version?: JsonValue;
  readonly "x-agent-context"?: JsonValue;
}
type JsonValue = boolean | null | number | string | readonly JsonValue[] | JsonObject;

interface InputObject extends Record<string, unknown> {
  delegatedTargets?: unknown;
  engineVersion?: unknown;
  roots?: unknown;
  snapshot?: unknown;
  startedAt?: unknown;
  target?: unknown;
  targetPath?: unknown;
  targets?: unknown;
  timestamp?: unknown;
  channel?: unknown;
}

interface ParsedEnvelope<T extends Root | Snapshot | Targets | Timestamp> {
  readonly canonicalJson: string;
  readonly bytes: Uint8Array;
  readonly metadata: Metadata<T>;
  readonly object: JsonObject;
  readonly sha256: string;
}

interface InternalState {
  readonly root: ParsedEnvelope<Root>;
  readonly snapshot: ParsedEnvelope<Snapshot> | null;
  readonly targets: ParsedEnvelope<Targets> | null;
  readonly timestamp: ParsedEnvelope<Timestamp> | null;
  readonly delegated: Readonly<{
    preview: ParsedEnvelope<Targets> | null;
    stable: ParsedEnvelope<Targets> | null;
  }>;
}

class TrustFailure extends Error {
  readonly issue: TufTrustIssue;

  constructor(code: TufTrustErrorCode, path: string, message: string) {
    const safePath = safeIssueText(path, MAX_TUF_ISSUE_PATH_BYTES, "$");
    const safeMessage = safeIssueText(
      message,
      MAX_TUF_ISSUE_MESSAGE_BYTES,
      "trust validation failed closed",
    );
    super(safeMessage);
    this.issue = Object.freeze({ code, path: safePath, message: safeMessage });
  }
}

function safeIssueText(value: string, maximumBytes: number, fallback: string): string {
  if (value.length === 0 || value.length > maximumBytes) return fallback;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || unit > 0x7e) return fallback;
  }
  return Buffer.byteLength(value, "utf8") <= maximumBytes ? value : fallback;
}

function fail(code: TufTrustErrorCode, path: string, message: string): never {
  throw new TrustFailure(code, path, message);
}

function asFailure(error: unknown): TufTrustResult<never> {
  const issue =
    error instanceof TrustFailure
      ? error.issue
      : Object.freeze({
          code: "invalid-metadata" as const,
          path: "$",
          message: "metadata verification failed closed",
        });
  return Object.freeze({ ok: false, issues: Object.freeze([issue]) });
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requirePrototype(value: object, name: string): object {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype === null) throw new TypeError(`${name} prototype is unavailable`);
  return prototype;
}

type IntrinsicGetter = (this: unknown) => unknown;
type IntrinsicFunction = (...arguments_: readonly unknown[]) => unknown;

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

function copyBytes(input: unknown, maximum: number, path: string): Uint8Array {
  if (typeof input === "string") {
    if (input.length > maximum)
      fail("resource-limit", path, `input exceeds ${String(maximum)} bytes`);
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(index + 1);
        if (index + 1 >= input.length || next < 0xdc00 || next > 0xdfff)
          fail("invalid-input", path, "string input contains an unpaired UTF-16 surrogate");
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail("invalid-input", path, "string input contains an unpaired UTF-16 surrogate");
      }
    }
    const byteLength = Buffer.byteLength(input, "utf8");
    if (byteLength > maximum)
      fail("resource-limit", path, `input exceeds ${String(maximum)} bytes`);
    const bytes = Buffer.from(input, "utf8");
    return new Uint8Array(bytes);
  }
  if (
    typeof input !== "object" ||
    input === null ||
    nodeTypes.isProxy(input) ||
    !nodeTypes.isUint8Array(input)
  )
    fail("invalid-input", path, "must be a string or non-exotic Uint8Array");
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
    fail("invalid-input", path, "exotic byte views are not accepted");
  const length = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, input, []);
  const buffer = Reflect.apply(TYPED_ARRAY_BUFFER, input, []);
  if (typeof length !== "number")
    fail("invalid-input", path, "byte input has invalid internal state");
  if (length > maximum) fail("resource-limit", path, `input exceeds ${String(maximum)} bytes`);
  if (nodeTypes.isSharedArrayBuffer(buffer))
    fail("invalid-input", path, "shared byte buffers are not accepted");
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== length || ownKeys.some((key, index) => key !== String(index)))
    fail("invalid-input", path, "byte input must not carry extra or symbolic properties");
  const copy = new Uint8Array(length);
  Reflect.apply(UINT8_ARRAY_SET, copy, [input, 0]);
  return copy;
}

function preflightJson(text: string, path: string): void {
  let depth = 0;
  let values = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) {
      inString = true;
      values += 1;
    } else if (code === 0x7b || code === 0x5b) {
      depth += 1;
      values += 1;
      if (depth > MAX_TUF_JSON_DEPTH)
        fail("resource-limit", path, `JSON nesting exceeds ${String(MAX_TUF_JSON_DEPTH)}`);
    } else if (code === 0x7d || code === 0x5d) {
      depth -= 1;
      if (depth < 0) fail("invalid-metadata", path, "JSON structure is unbalanced");
    } else if (code === 0x2c || code === 0x3a) values += 1;
    if (values > MAX_TUF_JSON_VALUES)
      fail("resource-limit", path, `JSON values exceed ${String(MAX_TUF_JSON_VALUES)}`);
  }
  if (inString || depth !== 0) fail("invalid-metadata", path, "JSON structure is incomplete");
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_TUF_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value !== "object" || nodeTypes.isProxy(value)) return false;
  if (Array.isArray(value)) {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !isJsonValue(descriptor.value, depth + 1)
      )
        return false;
    }
    return true;
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !isJsonValue(descriptor.value, depth + 1)
    )
      return false;
  }
  return true;
}

function parseEnvelope<T extends Root | Snapshot | Targets | Timestamp>(
  input: unknown,
  role: TufMetadataRole,
  path: string,
): ParsedEnvelope<T> {
  const bytes = copyBytes(input, MAX_TUF_METADATA_BYTES, path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    fail("invalid-metadata", path, "metadata must be well-formed UTF-8");
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    fail("invalid-metadata", path, "UTF-8 BOM is not accepted");
  preflightJson(text, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("invalid-metadata", path, "metadata must be valid JSON");
  }
  if (
    !isJsonValue(parsed) ||
    Array.isArray(parsed) ||
    parsed === null ||
    typeof parsed !== "object"
  )
    fail("invalid-metadata", path, "metadata must contain a plain JSON object");
  let canonical: string;
  try {
    canonical = canonicalize(parsed);
  } catch {
    fail("invalid-metadata", path, "metadata cannot be canonicalized safely");
  }
  if (canonical !== text)
    fail("invalid-metadata", path, "metadata must use exact OLPC canonical JSON bytes");
  let metadata: Metadata<Root | Snapshot | Targets | Timestamp>;
  try {
    switch (role) {
      case "root":
        metadata = Metadata.fromJSON(MetadataKind.Root, parsed as never);
        break;
      case "snapshot":
        metadata = Metadata.fromJSON(MetadataKind.Snapshot, parsed as never);
        break;
      case "targets":
        metadata = Metadata.fromJSON(MetadataKind.Targets, parsed as never);
        break;
      case "timestamp":
        metadata = Metadata.fromJSON(MetadataKind.Timestamp, parsed as never);
        break;
    }
  } catch {
    fail("invalid-metadata", path, "metadata does not satisfy the TUF role model");
  }
  return Object.freeze({
    bytes,
    canonicalJson: canonical,
    metadata: metadata as Metadata<T>,
    object: parsed as JsonObject,
    sha256: sha256(bytes),
  });
}

function record(value: JsonValue | undefined, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid-metadata", path, "must be an object");
  return value as JsonObject;
}

function array(value: JsonValue | undefined, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) fail("invalid-metadata", path, "must be an array");
  return value as readonly JsonValue[];
}

function string(value: JsonValue | undefined, path: string): string {
  if (typeof value !== "string") fail("invalid-metadata", path, "must be a string");
  return value;
}

function integer(
  value: JsonValue | undefined,
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0 || value > maximum)
    fail("invalid-metadata", path, `must be an integer from 1 through ${String(maximum)}`);
  return value;
}

function exactKeys(object: JsonObject, expected: readonly string[], path: string): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail("invalid-metadata", path, `must contain exactly: ${wanted.join(", ")}`);
}

function signedObject(envelope: ParsedEnvelope<Root | Snapshot | Targets | Timestamp>): JsonObject {
  exactKeys(envelope.object, ["signatures", "signed"], "$metadata");
  const signatures = array(envelope.object.signatures, "$metadata.signatures");
  if (signatures.length === 0 || signatures.length > 32)
    fail("resource-limit", "$metadata.signatures", "must contain between 1 and 32 signatures");
  let previous = "";
  for (let index = 0; index < signatures.length; index += 1) {
    const signature = record(signatures[index], `$metadata.signatures[${String(index)}]`);
    exactKeys(signature, ["keyid", "sig"], `$metadata.signatures[${String(index)}]`);
    const keyid = string(signature.keyid, `$metadata.signatures[${String(index)}].keyid`);
    const sig = string(signature.sig, `$metadata.signatures[${String(index)}].sig`);
    if (!SHA256.test(keyid) || !SIGNATURE.test(sig))
      fail(
        "invalid-metadata",
        `$metadata.signatures[${String(index)}]`,
        "must use lowercase Ed25519 hex identity and signature",
      );
    if (keyid <= previous)
      fail(
        "invalid-metadata",
        "$metadata.signatures",
        "signatures must have unique key IDs in ascending order",
      );
    previous = keyid;
  }
  return record(envelope.object.signed, "$metadata.signed");
}

interface RoleTimes {
  readonly expires: string;
  readonly expiresMs: number;
  readonly issuedAt: string;
  readonly issuedAtMs: number;
}

function parseUtc(
  value: JsonValue | undefined,
  path: string,
): { readonly ms: number; readonly text: string } {
  const text = string(value, path);
  const match = RFC3339_UTC.exec(text);
  if (match === null)
    fail("invalid-metadata", path, "must be canonical UTC RFC 3339 without fractions");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59)
    fail("invalid-metadata", path, "must be a real UTC timestamp");
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  const canonical = `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}Z`;
  if (!Number.isFinite(ms) || canonical !== text)
    fail("invalid-metadata", path, "must be a real canonical UTC timestamp");
  return { ms, text };
}

function validateCommonSigned(
  signed: JsonObject,
  role: TufMetadataRole,
  extraFields: readonly string[],
): { readonly times: RoleTimes; readonly version: number } {
  exactKeys(
    signed,
    ["_type", "expires", "spec_version", "version", "x-agent-context", ...extraFields],
    "$metadata.signed",
  );
  if (signed._type !== role) fail("wrong-role", "$metadata.signed._type", `must be ${role}`);
  const specVersion = string(signed.spec_version, "$metadata.signed.spec_version");
  if (specVersion !== TUF_SPECIFICATION_VERSION)
    fail(
      "unsupported-version",
      "$metadata.signed.spec_version",
      `must be ${TUF_SPECIFICATION_VERSION}`,
    );
  const version = integer(signed.version, "$metadata.signed.version", 2_147_483_647);
  const extension = record(signed["x-agent-context"], "$metadata.signed.x-agent-context");
  exactKeys(
    extension,
    ["issuedAt", "policyVersion", "repositoryId"],
    "$metadata.signed.x-agent-context",
  );
  if (extension.policyVersion !== TUF_TRUST_CONTRACT_VERSION)
    fail(
      "unsupported-version",
      "$metadata.signed.x-agent-context.policyVersion",
      `must be ${TUF_TRUST_CONTRACT_VERSION}`,
    );
  if (extension.repositoryId !== TUF_REPOSITORY_ID)
    fail(
      "invalid-policy",
      "$metadata.signed.x-agent-context.repositoryId",
      `must be ${TUF_REPOSITORY_ID}`,
    );
  const issued = parseUtc(extension.issuedAt, "$metadata.signed.x-agent-context.issuedAt");
  const expires = parseUtc(signed.expires, "$metadata.signed.expires");
  if (expires.ms <= issued.ms || expires.ms - issued.ms > ROLE_EXPIRY_LIMIT_MS[role])
    fail(
      "invalid-policy",
      "$metadata.signed.expires",
      `${role} validity exceeds the configured short-lived policy`,
    );
  return {
    times: {
      expires: expires.text,
      expiresMs: expires.ms,
      issuedAt: issued.text,
      issuedAtMs: issued.ms,
    },
    version,
  };
}

function validateAtStart(times: RoleTimes, startedAtMs: number, role: string): void {
  if (times.issuedAtMs > startedAtMs + TUF_CLOCK_SKEW_MS)
    fail("invalid-policy", `${role}.issuedAt`, "metadata issue time is implausibly in the future");
  if (times.expiresMs <= startedAtMs)
    fail(
      "expired-metadata",
      `${role}.expires`,
      `${role} metadata is expired at the fixed update start time`,
    );
}

interface ValidatedKey {
  readonly id: string;
  readonly object: JsonObject;
}

function validateKeyMap(
  value: JsonValue | undefined,
  path: string,
  maximum = 32,
): readonly ValidatedKey[] {
  const keys = record(value, path);
  const ids = Object.keys(keys);
  if (ids.length === 0 || ids.length > maximum)
    fail("resource-limit", path, `must contain between 1 and ${String(maximum)} keys`);
  const sorted = [...ids].sort();
  if (ids.some((id, index) => id !== sorted[index]))
    fail("invalid-policy", path, "key IDs must be in ascending order");
  return Object.freeze(
    ids.map((id, index) => {
      const keyPath = `${path}[${String(index)}]`;
      if (!SHA256.test(id)) fail("invalid-policy", keyPath, "key ID must be lowercase SHA-256");
      const key = record(keys[id], keyPath);
      exactKeys(key, ["keytype", "keyval", "scheme"], keyPath);
      if (key.keytype !== TUF_SUPPORTED_KEY_TYPE || key.scheme !== TUF_SUPPORTED_KEY_SCHEME)
        fail("invalid-policy", keyPath, "only Ed25519 keys and signatures are supported");
      const keyval = record(key.keyval, `${keyPath}.keyval`);
      exactKeys(keyval, ["public"], `${keyPath}.keyval`);
      const publicKey = string(keyval.public, `${keyPath}.keyval.public`);
      if (!ED25519_PUBLIC.test(publicKey))
        fail(
          "invalid-policy",
          `${keyPath}.keyval.public`,
          "must be a 32-byte lowercase Ed25519 public key",
        );
      if (sha256(canonicalize(key)) !== id)
        fail(
          "invalid-policy",
          keyPath,
          "key ID must equal SHA-256 of the OLPC canonical key object",
        );
      return Object.freeze({ id, object: key });
    }),
  );
}

interface ValidatedRole {
  readonly keyids: readonly string[];
  readonly threshold: number;
}

function validateRole(
  value: JsonValue | undefined,
  path: string,
  expectedCount: number,
  expectedThreshold: number,
): ValidatedRole {
  const role = record(value, path);
  exactKeys(role, ["keyids", "threshold"], path);
  const rawKeyids = array(role.keyids, `${path}.keyids`);
  if (rawKeyids.length !== expectedCount)
    fail(
      "invalid-policy",
      `${path}.keyids`,
      `must contain exactly ${String(expectedCount)} key IDs`,
    );
  const keyids = rawKeyids.map((id, index) => string(id, `${path}.keyids[${String(index)}]`));
  let previous = "";
  if (
    keyids.some((id) => {
      const invalid = !SHA256.test(id) || id <= previous;
      previous = id;
      return invalid;
    })
  )
    fail(
      "invalid-policy",
      `${path}.keyids`,
      "must be unique lowercase SHA-256 key IDs in ascending order",
    );
  const threshold = integer(role.threshold, `${path}.threshold`, expectedCount);
  if (threshold !== expectedThreshold)
    fail("invalid-policy", `${path}.threshold`, `must be ${String(expectedThreshold)}`);
  return Object.freeze({ keyids: Object.freeze(keyids), threshold });
}

interface RootPolicy {
  readonly roles: Readonly<Record<(typeof TOP_LEVEL_ROLES)[number], ValidatedRole>>;
  readonly times: RoleTimes;
  readonly version: number;
}

function validateRoot(envelope: ParsedEnvelope<Root>): RootPolicy {
  const signed = signedObject(envelope);
  const common = validateCommonSigned(signed, "root", ["consistent_snapshot", "keys", "roles"]);
  if (signed.consistent_snapshot !== true)
    fail(
      "invalid-policy",
      "$metadata.signed.consistent_snapshot",
      "consistent snapshots are mandatory",
    );
  const keys = validateKeyMap(signed.keys, "$metadata.signed.keys", 16);
  const keySet = new Set(keys.map((key) => key.id));
  const rolesObject = record(signed.roles, "$metadata.signed.roles");
  exactKeys(rolesObject, TOP_LEVEL_ROLES, "$metadata.signed.roles");
  const roles = Object.freeze({
    root: validateRole(rolesObject.root, "$metadata.signed.roles.root", 3, 2),
    snapshot: validateRole(rolesObject.snapshot, "$metadata.signed.roles.snapshot", 1, 1),
    targets: validateRole(rolesObject.targets, "$metadata.signed.roles.targets", 3, 2),
    timestamp: validateRole(rolesObject.timestamp, "$metadata.signed.roles.timestamp", 1, 1),
  });
  const allRoleKeys = TOP_LEVEL_ROLES.flatMap((role) => [...roles[role].keyids]);
  if (new Set(allRoleKeys).size !== allRoleKeys.length)
    fail("invalid-policy", "$metadata.signed.roles", "top-level roles must use disjoint keys");
  if (allRoleKeys.some((id) => !keySet.has(id)) || keySet.size !== allRoleKeys.length)
    fail(
      "invalid-policy",
      "$metadata.signed.keys",
      "root key map must contain exactly the role-authorized public keys",
    );
  try {
    envelope.metadata.verifyDelegate("root", envelope.metadata);
  } catch {
    fail(
      "invalid-signature",
      "$metadata.signatures",
      "root metadata does not meet its 2-of-3 self-signature threshold",
    );
  }
  return Object.freeze({ roles, times: common.times, version: common.version });
}

function verifyDelegate(
  delegator: ParsedEnvelope<Root | Targets>,
  role: string,
  delegated: ParsedEnvelope<Root | Snapshot | Targets | Timestamp>,
  path: string,
): void {
  try {
    delegator.metadata.verifyDelegate(role, delegated.metadata);
  } catch {
    fail(
      "invalid-signature",
      path,
      `${role} metadata does not meet its authorized signature threshold`,
    );
  }
}

function sameKeys(left: ValidatedRole, right: ValidatedRole): boolean {
  return (
    left.threshold === right.threshold &&
    left.keyids.length === right.keyids.length &&
    left.keyids.every((id, index) => id === right.keyids[index])
  );
}

interface MetaBinding {
  readonly length: number;
  readonly sha256: string;
  readonly version: number;
}

function validateMetaBinding(value: JsonValue | undefined, path: string): MetaBinding {
  const meta = record(value, path);
  exactKeys(meta, ["hashes", "length", "version"], path);
  const hashes = record(meta.hashes, `${path}.hashes`);
  exactKeys(hashes, ["sha256"], `${path}.hashes`);
  const digest = string(hashes.sha256, `${path}.hashes.sha256`);
  if (!SHA256.test(digest))
    fail("invalid-metadata", `${path}.hashes.sha256`, "must be a lowercase SHA-256 digest");
  return Object.freeze({
    length: integer(meta.length, `${path}.length`, MAX_TUF_METADATA_BYTES),
    sha256: digest,
    version: integer(meta.version, `${path}.version`, 2_147_483_647),
  });
}

interface TimestampPolicy {
  readonly snapshot: MetaBinding;
  readonly times: RoleTimes;
  readonly version: number;
}

function validateTimestamp(envelope: ParsedEnvelope<Timestamp>): TimestampPolicy {
  const signed = signedObject(envelope);
  const common = validateCommonSigned(signed, "timestamp", ["meta"]);
  const meta = record(signed.meta, "$metadata.signed.meta");
  exactKeys(meta, ["snapshot.json"], "$metadata.signed.meta");
  return Object.freeze({
    snapshot: validateMetaBinding(meta["snapshot.json"], "$metadata.signed.meta.snapshot.json"),
    times: common.times,
    version: common.version,
  });
}

interface SnapshotPolicy {
  readonly meta: Readonly<Record<string, MetaBinding>>;
  readonly times: RoleTimes;
  readonly version: number;
}

function validateSnapshot(envelope: ParsedEnvelope<Snapshot>): SnapshotPolicy {
  const signed = signedObject(envelope);
  const common = validateCommonSigned(signed, "snapshot", ["meta"]);
  const meta = record(signed.meta, "$metadata.signed.meta");
  const expected = ["standards-preview.json", "standards-stable.json", "targets.json"];
  exactKeys(meta, expected, "$metadata.signed.meta");
  const result: Record<string, MetaBinding> = Object.create(null) as Record<string, MetaBinding>;
  for (const name of expected)
    result[name] = validateMetaBinding(meta[name], `$metadata.signed.meta.${name}`);
  return Object.freeze({
    meta: Object.freeze(result),
    times: common.times,
    version: common.version,
  });
}

function verifyMetaBinding(
  binding: MetaBinding,
  envelope: ParsedEnvelope<Root | Snapshot | Targets | Timestamp>,
  path: string,
): void {
  if (envelope.bytes.byteLength !== binding.length)
    fail("length-mismatch", path, "metadata length does not match its signed parent binding");
  if (envelope.sha256 !== binding.sha256)
    fail("hash-mismatch", path, "metadata SHA-256 does not match its signed parent binding");
  const signed = record(envelope.object.signed, `${path}.signed`);
  if (signed.version !== binding.version)
    fail(
      "mix-and-match",
      `${path}.signed.version`,
      "metadata version does not match its signed parent binding",
    );
}

interface DelegationPolicy {
  readonly preview: ValidatedRole;
  readonly stable: ValidatedRole;
}

interface TargetsPolicy {
  readonly delegations: DelegationPolicy | null;
  readonly targets: JsonObject;
  readonly times: RoleTimes;
  readonly version: number;
}

function validateTopLevelTargets(
  envelope: ParsedEnvelope<Targets>,
  root: RootPolicy,
): TargetsPolicy {
  const signed = signedObject(envelope);
  const common = validateCommonSigned(signed, "targets", ["delegations", "targets"]);
  const targets = record(signed.targets, "$metadata.signed.targets");
  exactKeys(targets, [], "$metadata.signed.targets");
  const delegations = record(signed.delegations, "$metadata.signed.delegations");
  exactKeys(delegations, ["keys", "roles"], "$metadata.signed.delegations");
  const keys = validateKeyMap(delegations.keys, "$metadata.signed.delegations.keys", 6);
  const keySet = new Set(keys.map((key) => key.id));
  const roles = array(delegations.roles, "$metadata.signed.delegations.roles");
  if (roles.length !== 2)
    fail(
      "invalid-policy",
      "$metadata.signed.delegations.roles",
      "must contain stable and preview roles only",
    );

  const parsedRoles: Partial<Record<TufChannel, ValidatedRole>> = {};
  for (let index = 0; index < roles.length; index += 1) {
    const path = `$metadata.signed.delegations.roles[${String(index)}]`;
    const role = record(roles[index], path);
    exactKeys(role, ["keyids", "name", "paths", "terminating", "threshold"], path);
    const name = string(role.name, `${path}.name`);
    const channel =
      name === TUF_STABLE_ROLE ? "stable" : name === TUF_PREVIEW_ROLE ? "preview" : undefined;
    if (channel === undefined || parsedRoles[channel] !== undefined)
      fail("invalid-policy", `${path}.name`, "must identify each configured channel exactly once");
    if (role.terminating !== true)
      fail("invalid-policy", `${path}.terminating`, "channel delegations must be terminating");
    const paths = array(role.paths, `${path}.paths`);
    if (paths.length !== 1 || paths[0] !== CHANNEL_PATH[channel])
      fail(
        "channel-mismatch",
        `${path}.paths`,
        `must isolate ${channel} targets at ${CHANNEL_PATH[channel]}`,
      );
    const roleKeyids = role.keyids;
    const roleThreshold = role.threshold;
    if (roleKeyids === undefined || roleThreshold === undefined)
      fail("invalid-policy", path, "delegated role authority is incomplete");
    parsedRoles[channel] = validateRole(
      { keyids: roleKeyids, threshold: roleThreshold },
      path,
      3,
      2,
    );
  }
  if (parsedRoles.preview === undefined || parsedRoles.stable === undefined)
    fail("invalid-policy", "$metadata.signed.delegations.roles", "both channel roles are required");
  const allDelegated = [...parsedRoles.preview.keyids, ...parsedRoles.stable.keyids];
  if (
    new Set(allDelegated).size !== 6 ||
    allDelegated.some((id) => !keySet.has(id)) ||
    keySet.size !== 6
  )
    fail(
      "invalid-policy",
      "$metadata.signed.delegations",
      "stable and preview must use disjoint 2-of-3 key sets",
    );
  const topLevel = TOP_LEVEL_ROLES.flatMap((role) => [...root.roles[role].keyids]);
  if (allDelegated.some((id) => topLevel.includes(id)))
    fail(
      "invalid-policy",
      "$metadata.signed.delegations.keys",
      "delegated and top-level keys must be disjoint",
    );
  return Object.freeze({
    delegations: Object.freeze({ preview: parsedRoles.preview, stable: parsedRoles.stable }),
    targets,
    times: common.times,
    version: common.version,
  });
}

interface TargetBinding {
  readonly channel: TufChannel;
  readonly length: number;
  readonly minEngineVersion: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly schemaVersion: typeof KNOWLEDGE_PACK_CONTRACT_VERSION;
  readonly sha256: string;
}

interface ParsedSemver {
  readonly core: readonly [string, string, string];
  readonly pre: readonly string[];
}

function boundedString(
  value: unknown,
  path: string,
  maximumBytes: number,
  invalidCode: TufTrustErrorCode,
): string {
  if (typeof value !== "string") fail(invalidCode, path, "must be a string");
  if (value.length > maximumBytes)
    fail("resource-limit", path, `input exceeds ${String(maximumBytes)} bytes`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes)
    fail("resource-limit", path, `input exceeds ${String(maximumBytes)} bytes`);
  return value;
}

function parseSemver(value: string, path: string, invalidCode: TufTrustErrorCode): ParsedSemver {
  boundedString(value, path, MAX_TUF_SEMVER_BYTES, invalidCode);
  const match = SEMVER.exec(value);
  if (match === null) fail(invalidCode, path, "must use SemVer 2.0.0");
  const captures = match as RegExpExecArray & {
    readonly 1: string;
    readonly 2: string;
    readonly 3: string;
  };
  const core: [string, string, string] = [captures[1], captures[2], captures[3]];
  return Object.freeze({
    core: Object.freeze(core),
    pre: Object.freeze(captures[4] === undefined ? [] : captures[4].split(".")),
  });
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function validateTargetBinding(
  value: JsonValue | undefined,
  path: string,
  channel: TufChannel,
): TargetBinding {
  const target = record(value, path);
  exactKeys(target, ["custom", "hashes", "length"], path);
  const hashes = record(target.hashes, `${path}.hashes`);
  exactKeys(hashes, ["sha256"], `${path}.hashes`);
  const digest = string(hashes.sha256, `${path}.hashes.sha256`);
  if (!SHA256.test(digest))
    fail("invalid-metadata", `${path}.hashes.sha256`, "must be lowercase SHA-256");
  const custom = record(target.custom, `${path}.custom`);
  exactKeys(
    custom,
    ["channel", "minEngineVersion", "packId", "packVersion", "schemaVersion"],
    `${path}.custom`,
  );
  if (custom.channel !== channel)
    fail("channel-mismatch", `${path}.custom.channel`, `must equal delegated ${channel} channel`);
  if (custom.schemaVersion !== KNOWLEDGE_PACK_CONTRACT_VERSION)
    fail(
      "unsupported-version",
      `${path}.custom.schemaVersion`,
      `must be ${KNOWLEDGE_PACK_CONTRACT_VERSION}`,
    );
  const minEngineVersion = boundedString(
    custom.minEngineVersion,
    `${path}.custom.minEngineVersion`,
    MAX_TUF_SEMVER_BYTES,
    "invalid-metadata",
  );
  const packVersion = boundedString(
    custom.packVersion,
    `${path}.custom.packVersion`,
    MAX_TUF_SEMVER_BYTES,
    "invalid-metadata",
  );
  parseSemver(minEngineVersion, `${path}.custom.minEngineVersion`, "invalid-metadata");
  parseSemver(packVersion, `${path}.custom.packVersion`, "invalid-metadata");
  const packId = boundedString(
    custom.packId,
    `${path}.custom.packId`,
    MAX_TUF_PACK_ID_BYTES,
    "invalid-metadata",
  );
  if (!/^[A-Za-z0-9]+(?:[._/-][A-Za-z0-9]+)*$/u.test(packId))
    fail("invalid-metadata", `${path}.custom.packId`, "pack ID is not canonical");
  return Object.freeze({
    channel,
    length: integer(target.length, `${path}.length`, MAX_TUF_TARGET_BYTES),
    minEngineVersion,
    packId,
    packVersion,
    schemaVersion: KNOWLEDGE_PACK_CONTRACT_VERSION,
    sha256: digest,
  });
}

function validateDelegatedTargets(
  envelope: ParsedEnvelope<Targets>,
  channel: TufChannel,
  requestedPath: string,
): { readonly binding: TargetBinding; readonly policy: TargetsPolicy } {
  const signed = signedObject(envelope);
  const common = validateCommonSigned(signed, "targets", ["targets"]);
  const targets = record(signed.targets, "$metadata.signed.targets");
  const names = Object.keys(targets);
  if (names.length === 0 || names.length > 1_000)
    fail(
      "resource-limit",
      "$metadata.signed.targets",
      "delegated targets must contain between 1 and 1000 entries",
    );
  const sorted = [...names].sort();
  if (names.some((name, index) => name !== sorted[index]))
    fail("invalid-policy", "$metadata.signed.targets", "target paths must be in ascending order");
  let requestedBinding: TargetBinding | undefined;
  for (const [index, name] of names.entries()) {
    const entryPath = `$metadata.signed.targets[${String(index)}]`;
    boundedString(name, entryPath, MAX_TUF_TARGET_PATH_BYTES, "invalid-metadata");
    if (!TARGET_PATH.test(name) || !name.startsWith(`knowledge/${channel}/`))
      fail("channel-mismatch", entryPath, `target path is outside ${channel} authority`);
    const binding = validateTargetBinding(targets[name], entryPath, channel);
    if (name === requestedPath) requestedBinding = binding;
  }
  if (requestedBinding === undefined)
    fail(
      "target-not-found",
      "$metadata.signed.targets",
      "requested target is not present in its delegated channel",
    );
  return Object.freeze({
    binding: requestedBinding,
    policy: Object.freeze({
      delegations: null,
      targets,
      times: common.times,
      version: common.version,
    }),
  });
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left, "$request.engineVersion", "invalid-input");
  const b = parseSemver(
    right,
    "$metadata.signed.targets[].custom.minEngineVersion",
    "invalid-metadata",
  );
  for (const index of [0, 1, 2] as const) {
    const leftCore = a.core[index];
    const rightCore = b.core[index];
    const comparison = compareNumericIdentifier(leftCore, rightCore);
    if (comparison !== 0) return comparison;
  }
  if (a.pre.length === 0 || b.pre.length === 0)
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/u.test(x);
    const yn = /^\d+$/u.test(y);
    if (xn && yn) return compareNumericIdentifier(x, y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function plainDataObject(value: unknown, path: string): InputObject {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  )
    fail("invalid-input", path, "must be a plain data object");
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("invalid-input", path, "must have a plain prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: InputObject = Object.create(null) as InputObject;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail("invalid-input", path, "symbol fields are not accepted");
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor))
      fail("invalid-input", path, "accessor fields are not accepted");
    output[key] = descriptor.value;
  }
  return output;
}

function exactInputKeys(
  object: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(object);
  if (required.some((key) => !Object.hasOwn(object, key)) || keys.some((key) => !allowed.has(key)))
    fail("invalid-input", path, "contains missing or unknown fields");
}

function validateRequest(input: unknown): TufOfflineUpdateRequest {
  const request = plainDataObject(input, "$request");
  exactInputKeys(request, ["channel", "engineVersion", "startedAt", "targetPath"], [], "$request");
  const channel = boundedString(request.channel, "$request.channel", 7, "invalid-input");
  if (channel !== "preview" && channel !== "stable")
    fail("invalid-input", "$request.channel", "must be preview or stable");
  const engineVersion = boundedString(
    request.engineVersion,
    "$request.engineVersion",
    MAX_TUF_SEMVER_BYTES,
    "invalid-input",
  );
  parseSemver(engineVersion, "$request.engineVersion", "invalid-input");
  const startedAt = boundedString(request.startedAt, "$request.startedAt", 20, "invalid-input");
  parseUtc(startedAt, "$request.startedAt");
  const targetPath = boundedString(
    request.targetPath,
    "$request.targetPath",
    MAX_TUF_TARGET_PATH_BYTES,
    "invalid-input",
  );
  if (!TARGET_PATH.test(targetPath))
    fail(
      "invalid-input",
      "$request.targetPath",
      "must be a canonical standards knowledge target path",
    );
  if (!targetPath.startsWith(`knowledge/${channel}/`))
    fail(
      "channel-mismatch",
      "$request.targetPath",
      "target path does not belong to the selected channel",
    );
  return Object.freeze({
    channel,
    engineVersion,
    startedAt,
    targetPath,
  });
}

function validateRoots(value: unknown): readonly (string | Uint8Array)[] {
  if (value === undefined) return Object.freeze([]);
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value)
  )
    fail("invalid-input", "$bundle.roots", "must be a plain dense array");
  if (Reflect.getPrototypeOf(value) !== Array.prototype || value.length > MAX_TUF_ROOT_CHAIN)
    fail(
      "resource-limit",
      "$bundle.roots",
      `must contain at most ${String(MAX_TUF_ROOT_CHAIN)} roots`,
    );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1)
    fail("invalid-input", "$bundle.roots", "must be dense and contain no extra fields");
  const roots: (string | Uint8Array)[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor))
      fail(
        "invalid-input",
        `$bundle.roots[${String(index)}]`,
        "accessor or sparse entries are not accepted",
      );
    const item: unknown = descriptor.value as unknown;
    if (typeof item !== "string" && !nodeTypes.isUint8Array(item))
      fail("invalid-input", `$bundle.roots[${String(index)}]`, "must be metadata text or bytes");
    roots.push(item);
  }
  return Object.freeze(roots);
}

function validateBundle(input: unknown): TufOfflineUpdateBundle {
  const bundle = plainDataObject(input, "$bundle");
  exactInputKeys(
    bundle,
    ["delegatedTargets", "snapshot", "target", "targets", "timestamp"],
    ["roots"],
    "$bundle",
  );
  return Object.freeze({
    delegatedTargets: bundle.delegatedTargets as string | Uint8Array,
    roots: validateRoots(bundle.roots),
    snapshot: bundle.snapshot as string | Uint8Array,
    target: bundle.target as string | Uint8Array,
    targets: bundle.targets as string | Uint8Array,
    timestamp: bundle.timestamp as string | Uint8Array,
  });
}

function metadataSummary(
  envelope: ParsedEnvelope<Root | Snapshot | Targets | Timestamp>,
  role: string,
): TufTrustedMetadataSummary {
  const signed = record(envelope.object.signed, "$state.metadata.signed");
  const extension = record(signed["x-agent-context"], "$state.metadata.signed.x-agent-context");
  return Object.freeze({
    expires: string(signed.expires, "$state.metadata.signed.expires"),
    issuedAt: string(extension.issuedAt, "$state.metadata.signed.x-agent-context.issuedAt"),
    role,
    sha256: envelope.sha256,
    version: integer(signed.version, "$state.metadata.signed.version", 2_147_483_647),
  });
}

function retainDelegated(
  previous: ParsedEnvelope<Targets> | null,
  binding: MetaBinding,
): ParsedEnvelope<Targets> | null {
  if (previous === null) return null;
  const signed = record(previous.object.signed, "$state.delegated.signed");
  return previous.sha256 === binding.sha256 &&
    previous.bytes.byteLength === binding.length &&
    signed.version === binding.version
    ? previous
    : null;
}

function requireMetaBinding(
  meta: Readonly<Record<string, MetaBinding>>,
  name: string,
): MetaBinding {
  const binding = meta[name];
  if (binding === undefined)
    fail("mix-and-match", `$metadata.signed.meta.${name}`, "required metadata binding is missing");
  return binding;
}

/**
 * Immutable, side-effect-free trusted metadata state.
 *
 * Instances can only originate from a bundled root bootstrap or a successful
 * complete offline update. No method performs network, filesystem, clock, or
 * environment access.
 */
export class OfflineTufTrustStore {
  readonly #state: InternalState;

  private constructor(state: InternalState) {
    this.#state = state;
    Object.freeze(this);
  }

  /** Establish an out-of-band bundled trust anchor after closed-policy and self-threshold checks. */
  static bootstrap(root: string | Uint8Array): TufTrustResult<OfflineTufTrustStore> {
    try {
      const envelope = parseEnvelope<Root>(root, "root", "$root");
      validateRoot(envelope);
      return Object.freeze({
        ok: true,
        value: new OfflineTufTrustStore(
          Object.freeze({
            delegated: Object.freeze({ preview: null, stable: null }),
            root: envelope,
            snapshot: null,
            targets: null,
            timestamp: null,
          }),
        ),
      });
    } catch (error) {
      return asFailure(error);
    }
  }

  /** Return immutable authority summaries without exposing mutable metadata model objects. */
  snapshot(): TufTrustedStateSnapshot {
    return Object.freeze({
      contractVersion: TUF_TRUST_CONTRACT_VERSION,
      delegated: Object.freeze({
        preview:
          this.#state.delegated.preview === null
            ? null
            : metadataSummary(this.#state.delegated.preview, TUF_PREVIEW_ROLE),
        stable:
          this.#state.delegated.stable === null
            ? null
            : metadataSummary(this.#state.delegated.stable, TUF_STABLE_ROLE),
      }),
      repositoryId: TUF_REPOSITORY_ID,
      root: metadataSummary(this.#state.root, "root"),
      snapshot:
        this.#state.snapshot === null ? null : metadataSummary(this.#state.snapshot, "snapshot"),
      targets:
        this.#state.targets === null ? null : metadataSummary(this.#state.targets, "targets"),
      timestamp:
        this.#state.timestamp === null ? null : metadataSummary(this.#state.timestamp, "timestamp"),
    });
  }

  /**
   * Verify a complete already-downloaded update using one fixed caller-supplied
   * time. Failure is atomic: this instance and its prior trusted state remain
   * unchanged and no partial candidate is exposed.
   */
  verifyUpdate(
    bundleInput: TufOfflineUpdateBundle,
    requestInput: TufOfflineUpdateRequest,
  ): TufTrustResult<TufVerifiedUpdate> {
    try {
      const bundle = validateBundle(bundleInput);
      const request = validateRequest(requestInput);
      const startedAt = parseUtc(request.startedAt, "$request.startedAt").ms;

      let trustedRoot = this.#state.root;
      let trustedRootPolicy = validateRoot(trustedRoot);
      const appliedRootVersions: number[] = [];
      let timestampAuthorityRotated = false;
      let snapshotAuthorityRotated = false;

      const roots = bundle.roots ?? [];
      for (let index = 0; index < roots.length; index += 1) {
        const candidate = parseEnvelope<Root>(
          roots[index],
          "root",
          `$bundle.roots[${String(index)}]`,
        );
        const candidatePolicy = validateRoot(candidate);
        if (candidatePolicy.version !== trustedRootPolicy.version + 1)
          fail(
            "root-continuity",
            `$bundle.roots[${String(index)}].signed.version`,
            "root versions must be exact sequential increments",
          );
        verifyDelegate(
          trustedRoot,
          "root",
          candidate,
          `$bundle.roots[${String(index)}].signatures.old-root`,
        );
        timestampAuthorityRotated ||= !sameKeys(
          trustedRootPolicy.roles.timestamp,
          candidatePolicy.roles.timestamp,
        );
        snapshotAuthorityRotated ||= !sameKeys(
          trustedRootPolicy.roles.snapshot,
          candidatePolicy.roles.snapshot,
        );
        trustedRoot = candidate;
        trustedRootPolicy = candidatePolicy;
        appliedRootVersions.push(candidatePolicy.version);
      }
      validateAtStart(trustedRootPolicy.times, startedAt, "root");

      const resetOnlineState = timestampAuthorityRotated || snapshotAuthorityRotated;
      const priorTimestamp = resetOnlineState ? null : this.#state.timestamp;
      const priorSnapshot = resetOnlineState ? null : this.#state.snapshot;

      const timestamp = parseEnvelope<Timestamp>(
        bundle.timestamp,
        "timestamp",
        "$bundle.timestamp",
      );
      const timestampPolicy = validateTimestamp(timestamp);
      verifyDelegate(trustedRoot, "timestamp", timestamp, "$bundle.timestamp.signatures");
      validateAtStart(timestampPolicy.times, startedAt, "timestamp");
      if (priorTimestamp !== null) {
        const previous = validateTimestamp(priorTimestamp);
        if (timestampPolicy.version < previous.version)
          fail(
            "rollback",
            "$bundle.timestamp.signed.version",
            "timestamp version is older than trusted state",
          );
        if (timestampPolicy.version === previous.version)
          fail(
            "replay",
            "$bundle.timestamp.signed.version",
            "timestamp version was already trusted",
          );
        if (timestampPolicy.snapshot.version < previous.snapshot.version)
          fail(
            "rollback",
            "$bundle.timestamp.signed.meta.snapshot.json.version",
            "timestamp rolls snapshot back",
          );
      }

      const snapshot = parseEnvelope<Snapshot>(bundle.snapshot, "snapshot", "$bundle.snapshot");
      verifyMetaBinding(timestampPolicy.snapshot, snapshot, "$bundle.snapshot");
      const snapshotPolicy = validateSnapshot(snapshot);
      verifyDelegate(trustedRoot, "snapshot", snapshot, "$bundle.snapshot.signatures");
      validateAtStart(snapshotPolicy.times, startedAt, "snapshot");
      if (priorSnapshot !== null) {
        const previous = validateSnapshot(priorSnapshot);
        for (const [name, prior] of Object.entries(previous.meta)) {
          const next = snapshotPolicy.meta[name];
          if (next === undefined || next.version < prior.version)
            fail(
              "rollback",
              `$bundle.snapshot.signed.meta.${name}`,
              "snapshot removed or rolled back trusted targets metadata",
            );
        }
      }

      const targets = parseEnvelope<Targets>(bundle.targets, "targets", "$bundle.targets");
      verifyMetaBinding(
        requireMetaBinding(snapshotPolicy.meta, "targets.json"),
        targets,
        "$bundle.targets",
      );
      const targetsPolicy = validateTopLevelTargets(targets, trustedRootPolicy);
      verifyDelegate(trustedRoot, "targets", targets, "$bundle.targets.signatures");
      validateAtStart(targetsPolicy.times, startedAt, "targets");

      const delegated = parseEnvelope<Targets>(
        bundle.delegatedTargets,
        "targets",
        "$bundle.delegatedTargets",
      );
      const delegatedName = `${CHANNEL_ROLE[request.channel]}.json`;
      verifyMetaBinding(
        requireMetaBinding(snapshotPolicy.meta, delegatedName),
        delegated,
        "$bundle.delegatedTargets",
      );
      const delegatedResult = validateDelegatedTargets(
        delegated,
        request.channel,
        request.targetPath,
      );
      verifyDelegate(
        targets,
        CHANNEL_ROLE[request.channel],
        delegated,
        "$bundle.delegatedTargets.signatures",
      );
      validateAtStart(delegatedResult.policy.times, startedAt, CHANNEL_ROLE[request.channel]);

      if (compareSemver(request.engineVersion, delegatedResult.binding.minEngineVersion) < 0)
        fail(
          "incompatible-engine",
          "$request.engineVersion",
          "engine is older than the target minimum version",
        );

      const targetBytes = copyBytes(bundle.target, MAX_TUF_TARGET_BYTES, "$bundle.target");
      if (targetBytes.byteLength !== delegatedResult.binding.length)
        fail(
          "length-mismatch",
          "$bundle.target",
          "target length does not match delegated metadata",
        );
      if (sha256(targetBytes) !== delegatedResult.binding.sha256)
        fail("hash-mismatch", "$bundle.target", "target SHA-256 does not match delegated metadata");

      const otherChannel: TufChannel = request.channel === "stable" ? "preview" : "stable";
      const nextDelegated = {
        [request.channel]: delegated,
        [otherChannel]: resetOnlineState
          ? null
          : retainDelegated(
              this.#state.delegated[otherChannel],
              requireMetaBinding(snapshotPolicy.meta, `${CHANNEL_ROLE[otherChannel]}.json`),
            ),
      } as Record<TufChannel, ParsedEnvelope<Targets> | null>;
      const nextState = new OfflineTufTrustStore(
        Object.freeze({
          delegated: Object.freeze({
            preview: nextDelegated.preview,
            stable: nextDelegated.stable,
          }),
          root: trustedRoot,
          snapshot,
          targets,
          timestamp,
        }),
      );
      const target = Object.freeze({
        channel: request.channel,
        length: delegatedResult.binding.length,
        minEngineVersion: delegatedResult.binding.minEngineVersion,
        packId: delegatedResult.binding.packId,
        packVersion: delegatedResult.binding.packVersion,
        schemaVersion: delegatedResult.binding.schemaVersion,
        sha256: delegatedResult.binding.sha256,
        targetPath: request.targetPath,
      });
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          recovery: Object.freeze({
            rootVersionsApplied: Object.freeze(appliedRootVersions),
            snapshotAuthorityRotated,
            timestampAuthorityRotated,
          }),
          state: nextState,
          target,
          targetBytes: new Uint8Array(targetBytes),
        }),
      });
    } catch (error) {
      return asFailure(error);
    }
  }
}
