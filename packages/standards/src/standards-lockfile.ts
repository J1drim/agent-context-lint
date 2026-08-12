import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";

import { canonicalizeJson } from "./knowledge-pack.js";
import type {
  KnowledgePackChannel,
  KnowledgePackIssue,
  KnowledgePackIssueCode,
} from "./knowledge-pack.js";
import type {
  TufTrustedMetadataSummary,
  TufTrustedStateSnapshot,
  TufVerifiedTarget,
} from "./tuf-trust.js";

export const STANDARDS_LOCKFILE_CONTRACT_VERSION = "1.0.0" as const;
export const STANDARDS_LOCKFILE_RECORD_KIND = "agent-context-standards-lock" as const;
export const MAX_STANDARDS_LOCKFILE_BYTES = 65_536;
export const DEFAULT_STANDARDS_LOCKFILE_PATH =
  "agent-context-standards.lock.json" as RepositoryRelativePath;

const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL_IDENTITY = /^(?:0|[1-9][0-9]{0,63})$/u;
const STABLE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const TARGET_PATH = /^knowledge\/(preview|stable)\/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*\.json$/u;
const CHANNEL_ROLE = Object.freeze({ preview: "standards-preview", stable: "standards-stable" });
const TOP_LEVEL_ROLE = Object.freeze({
  root: "root",
  snapshot: "snapshot",
  targets: "targets",
  timestamp: "timestamp",
});

export type StandardsLockfileIssueCode =
  | "invalid-json"
  | "invalid-relationship"
  | "invalid-value"
  | "missing-field"
  | "non-canonical"
  | "resource-limit"
  | "unknown-field"
  | "unsupported-version";

export interface StandardsLockfileIssue {
  readonly code: StandardsLockfileIssueCode;
  readonly message: string;
  readonly path: string;
}

export interface StandardsLockfilePack {
  readonly packId: string;
  readonly packVersion: string;
  readonly publishedAt: string;
  readonly schemaVersion: "0.1.0";
}

export interface StandardsLockfile {
  readonly channel: KnowledgePackChannel;
  readonly pack: StandardsLockfilePack;
  readonly recordKind: typeof STANDARDS_LOCKFILE_RECORD_KIND;
  readonly schemaVersion: typeof STANDARDS_LOCKFILE_CONTRACT_VERSION;
  readonly target: TufVerifiedTarget;
  readonly trustedState: TufTrustedStateSnapshot;
  readonly verificationTime: string;
}

export type StandardsLockfileValidationResult =
  | { readonly ok: true; readonly value: StandardsLockfile }
  | { readonly issues: readonly StandardsLockfileIssue[]; readonly ok: false };

export type StandardsLockfileParseResult =
  | { readonly canonicalJson: string; readonly ok: true; readonly value: StandardsLockfile }
  | { readonly issues: readonly StandardsLockfileIssue[]; readonly ok: false };

export type StandardsLockfileSerializationResult =
  | { readonly ok: true; readonly text: string }
  | { readonly issues: readonly StandardsLockfileIssue[]; readonly ok: false };

export interface StandardsLockfileExpectedState {
  readonly identity: Readonly<{ readonly device: string; readonly inode: string }>;
  readonly sha256: string;
}

export interface StandardsLockfileAtomicWriteRequest {
  readonly expected: StandardsLockfileExpectedState;
  readonly path: RepositoryRelativePath;
  readonly replacement: Uint8Array;
}

export interface StandardsLockfileAtomicWriteResult {
  readonly bytesWritten: number;
  readonly contractVersion: "0.1.0";
  readonly directorySync: "synced" | "unsupported";
  readonly durability: "file-and-directory" | "file-only";
  readonly identity: Readonly<{ readonly device: string; readonly inode: string }>;
  readonly mode: number;
  readonly path: RepositoryRelativePath;
  readonly previousSha256: string;
  readonly sha256: string;
}

/** Explicit trusted mutation capability, structurally implemented by the I10 repository writer. */
export interface StandardsLockfileAtomicWriter {
  write(request: unknown): Promise<StandardsLockfileAtomicWriteResult>;
}

export interface StandardsLockfileUpdateRequest {
  readonly expected: StandardsLockfileExpectedState;
  readonly lockfile: unknown;
  readonly path: RepositoryRelativePath;
}

type UnknownRecord = Record<string, unknown>;

function failure(
  code: StandardsLockfileIssueCode,
  path: string,
  message: string,
): { readonly issues: readonly StandardsLockfileIssue[]; readonly ok: false } {
  return { ok: false, issues: Object.freeze([Object.freeze({ code, message, path })]) };
}

function issue(
  issues: StandardsLockfileIssue[],
  code: StandardsLockfileIssueCode,
  path: string,
  message: string,
): void {
  if (issues.length < 32) issues.push(Object.freeze({ code, message, path }));
}

function mappedCode(code: KnowledgePackIssueCode): StandardsLockfileIssueCode {
  return code === "resource-limit" ? "resource-limit" : "invalid-json";
}

function mapCanonicalIssues(
  issues: readonly KnowledgePackIssue[],
): readonly StandardsLockfileIssue[] {
  return Object.freeze(
    issues.slice(0, 32).map((entry) =>
      Object.freeze({
        code: mappedCode(entry.code),
        message: entry.message,
        path: entry.path,
      }),
    ),
  );
}

function plainClone(
  input: unknown,
  maximumBytes = MAX_STANDARDS_LOCKFILE_BYTES,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly issues: readonly StandardsLockfileIssue[]; readonly ok: false } {
  const canonical = canonicalizeJson(input);
  if (!canonical.ok) return { ok: false, issues: mapCanonicalIssues(canonical.issues) };
  if (Buffer.byteLength(canonical.text, "utf8") > maximumBytes)
    return failure("resource-limit", "$", `input exceeds ${String(maximumBytes)} bytes`);
  return { ok: true, value: JSON.parse(canonical.text) as unknown };
}

function object(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: StandardsLockfileIssue[],
): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issue(issues, "invalid-value", path, "must be an object");
    return undefined;
  }
  const record = value as UnknownRecord;
  const keys = Object.keys(record);
  for (const key of allowed)
    if (!Object.hasOwn(record, key))
      issue(issues, "missing-field", `${path}.${key}`, "is required");
  for (const key of keys)
    if (!allowed.includes(key))
      issue(
        issues,
        "unknown-field",
        `${path}.${key}`,
        "is not part of the closed lockfile contract",
      );
  return record;
}

function string(
  record: UnknownRecord | undefined,
  key: string,
  path: string,
  issues: StandardsLockfileIssue[],
  pattern?: RegExp,
): string | undefined {
  if (record === undefined || !Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    issue(issues, "invalid-value", `${path}.${key}`, "has an invalid value");
    return undefined;
  }
  return value;
}

function integer(
  record: UnknownRecord | undefined,
  key: string,
  path: string,
  issues: StandardsLockfileIssue[],
  minimum: number,
): number | undefined {
  if (record === undefined || !Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    issue(issues, "invalid-value", `${path}.${key}`, "must be a bounded integer");
    return undefined;
  }
  return value as number;
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

function exactInstant(value: string): boolean {
  const match = RFC3339_UTC.exec(value);
  if (match === null) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(".000Z", "Z") === value;
}

function metadataSummary(
  value: unknown,
  path: string,
  expectedRole: string,
  issues: StandardsLockfileIssue[],
): TufTrustedMetadataSummary | undefined {
  const record = object(value, path, ["expires", "issuedAt", "role", "sha256", "version"], issues);
  const expires = string(record, "expires", path, issues, RFC3339_UTC);
  const issuedAt = string(record, "issuedAt", path, issues, RFC3339_UTC);
  const role = string(record, "role", path, issues);
  const sha256 = string(record, "sha256", path, issues, SHA256);
  const version = integer(record, "version", path, issues, 1);
  if (expires !== undefined && !exactInstant(expires))
    issue(issues, "invalid-value", `${path}.expires`, "must be exact UTC RFC 3339 seconds");
  if (issuedAt !== undefined && !exactInstant(issuedAt))
    issue(issues, "invalid-value", `${path}.issuedAt`, "must be exact UTC RFC 3339 seconds");
  if (role !== undefined && role !== expectedRole)
    issue(issues, "invalid-value", `${path}.role`, "does not identify the required metadata role");
  if (issuedAt !== undefined && expires !== undefined && issuedAt >= expires)
    issue(issues, "invalid-relationship", `${path}.expires`, "must be later than issuedAt");
  if (
    expires === undefined ||
    issuedAt === undefined ||
    role !== expectedRole ||
    sha256 === undefined ||
    version === undefined
  )
    return undefined;
  return Object.freeze({ expires, issuedAt, role, sha256, version });
}

function nullableMetadataSummary(
  value: unknown,
  path: string,
  expectedRole: string,
  issues: StandardsLockfileIssue[],
): TufTrustedMetadataSummary | null | undefined {
  return value === null ? null : metadataSummary(value, path, expectedRole, issues);
}

function validateTrustedState(
  value: unknown,
  channel: KnowledgePackChannel | undefined,
  verificationTime: string | undefined,
  issues: StandardsLockfileIssue[],
): TufTrustedStateSnapshot | undefined {
  const path = "$.trustedState";
  const record = object(
    value,
    path,
    ["contractVersion", "delegated", "repositoryId", "root", "snapshot", "targets", "timestamp"],
    issues,
  );
  const contractVersion = string(record, "contractVersion", path, issues);
  const repositoryId = string(record, "repositoryId", path, issues);
  if (contractVersion !== undefined && contractVersion !== "0.1.0")
    issue(issues, "unsupported-version", `${path}.contractVersion`, "only 0.1.0 is supported");
  if (repositoryId !== undefined && repositoryId !== "agent-context-standards")
    issue(
      issues,
      "invalid-value",
      `${path}.repositoryId`,
      "must identify the standards repository",
    );
  const root = metadataSummary(record?.["root"], `${path}.root`, TOP_LEVEL_ROLE.root, issues);
  const snapshot = nullableMetadataSummary(
    record?.["snapshot"],
    `${path}.snapshot`,
    TOP_LEVEL_ROLE.snapshot,
    issues,
  );
  const targets = nullableMetadataSummary(
    record?.["targets"],
    `${path}.targets`,
    TOP_LEVEL_ROLE.targets,
    issues,
  );
  const timestamp = nullableMetadataSummary(
    record?.["timestamp"],
    `${path}.timestamp`,
    TOP_LEVEL_ROLE.timestamp,
    issues,
  );
  const delegatedRecord = object(
    record?.["delegated"],
    `${path}.delegated`,
    ["preview", "stable"],
    issues,
  );
  const preview = nullableMetadataSummary(
    delegatedRecord?.["preview"],
    `${path}.delegated.preview`,
    CHANNEL_ROLE.preview,
    issues,
  );
  const stable = nullableMetadataSummary(
    delegatedRecord?.["stable"],
    `${path}.delegated.stable`,
    CHANNEL_ROLE.stable,
    issues,
  );
  const selected = channel === "preview" ? preview : channel === "stable" ? stable : undefined;
  if (channel !== undefined && selected === null)
    issue(
      issues,
      "invalid-relationship",
      `${path}.delegated.${channel}`,
      "selected channel metadata is required",
    );
  for (const [summaryPath, summary] of [
    [`${path}.snapshot`, snapshot],
    [`${path}.targets`, targets],
    [`${path}.timestamp`, timestamp],
  ] as const)
    if (summary === null)
      issue(
        issues,
        "invalid-relationship",
        summaryPath,
        "verified target locks require this metadata summary",
      );
  if (verificationTime !== undefined) {
    for (const [summaryPath, summary] of [
      [`${path}.root`, root],
      [`${path}.snapshot`, snapshot],
      [`${path}.targets`, targets],
      [`${path}.timestamp`, timestamp],
      [`${path}.delegated.${channel ?? "stable"}`, selected],
    ] as const) {
      if (
        summary !== null &&
        summary !== undefined &&
        !(summary.issuedAt <= verificationTime && verificationTime < summary.expires)
      )
        issue(issues, "invalid-relationship", summaryPath, "must be current at verificationTime");
    }
  }
  if (
    contractVersion !== "0.1.0" ||
    repositoryId !== "agent-context-standards" ||
    root === undefined ||
    snapshot === undefined ||
    snapshot === null ||
    targets === undefined ||
    targets === null ||
    timestamp === undefined ||
    timestamp === null ||
    preview === undefined ||
    stable === undefined ||
    selected === null ||
    selected === undefined
  )
    return undefined;
  return Object.freeze({
    contractVersion,
    delegated: Object.freeze({ preview, stable }),
    repositoryId,
    root,
    snapshot,
    targets,
    timestamp,
  });
}

/** Validate untrusted lock data and return a deeply immutable, authority-neutral copy. */
export function validateStandardsLockfile(input: unknown): StandardsLockfileValidationResult {
  try {
    const clone = plainClone(input);
    if (!clone.ok) return clone;
    const issues: StandardsLockfileIssue[] = [];
    const root = object(
      clone.value,
      "$",
      [
        "channel",
        "pack",
        "recordKind",
        "schemaVersion",
        "target",
        "trustedState",
        "verificationTime",
      ],
      issues,
    );
    const recordKind = string(root, "recordKind", "$", issues);
    const schemaVersion = string(root, "schemaVersion", "$", issues);
    const channel = string(root, "channel", "$", issues);
    const verificationTime = string(root, "verificationTime", "$", issues, RFC3339_UTC);
    if (recordKind !== undefined && recordKind !== STANDARDS_LOCKFILE_RECORD_KIND)
      issue(issues, "invalid-value", "$.recordKind", "must identify a standards lockfile");
    if (schemaVersion !== undefined && schemaVersion !== STANDARDS_LOCKFILE_CONTRACT_VERSION)
      issue(issues, "unsupported-version", "$.schemaVersion", "only 1.0.0 is supported");
    if (channel !== undefined && channel !== "preview" && channel !== "stable")
      issue(issues, "invalid-value", "$.channel", "must be preview or stable");
    if (verificationTime !== undefined && !exactInstant(verificationTime))
      issue(issues, "invalid-value", "$.verificationTime", "must be exact UTC RFC 3339 seconds");
    const channelValue = channel === "preview" || channel === "stable" ? channel : undefined;

    const packPath = "$.pack";
    const packRecord = object(
      root?.["pack"],
      packPath,
      ["packId", "packVersion", "publishedAt", "schemaVersion"],
      issues,
    );
    const packId = string(packRecord, "packId", packPath, issues, STABLE_ID);
    const packVersion = string(packRecord, "packVersion", packPath, issues, SEMVER);
    const publishedAt = string(packRecord, "publishedAt", packPath, issues, DATE);
    const packSchemaVersion = string(packRecord, "schemaVersion", packPath, issues);
    if (publishedAt !== undefined && !exactDate(publishedAt))
      issue(issues, "invalid-value", `${packPath}.publishedAt`, "must be a real YYYY-MM-DD date");
    if (packSchemaVersion !== undefined && packSchemaVersion !== "0.1.0")
      issue(issues, "unsupported-version", `${packPath}.schemaVersion`, "only 0.1.0 is supported");
    if (
      publishedAt !== undefined &&
      verificationTime !== undefined &&
      publishedAt > verificationTime.slice(0, 10)
    )
      issue(
        issues,
        "invalid-relationship",
        `${packPath}.publishedAt`,
        "must not be later than verificationTime",
      );

    const targetPath = "$.target";
    const targetRecord = object(
      root?.["target"],
      targetPath,
      [
        "channel",
        "length",
        "minEngineVersion",
        "packId",
        "packVersion",
        "schemaVersion",
        "sha256",
        "targetPath",
      ],
      issues,
    );
    const targetChannel = string(targetRecord, "channel", targetPath, issues);
    const length = integer(targetRecord, "length", targetPath, issues, 1);
    const minEngineVersion = string(targetRecord, "minEngineVersion", targetPath, issues, SEMVER);
    const targetPackId = string(targetRecord, "packId", targetPath, issues, STABLE_ID);
    const targetPackVersion = string(targetRecord, "packVersion", targetPath, issues, SEMVER);
    const targetSchemaVersion = string(targetRecord, "schemaVersion", targetPath, issues);
    const sha256 = string(targetRecord, "sha256", targetPath, issues, SHA256);
    const targetPathValue = string(targetRecord, "targetPath", targetPath, issues, TARGET_PATH);
    if (targetChannel !== undefined && targetChannel !== "preview" && targetChannel !== "stable")
      issue(issues, "invalid-value", `${targetPath}.channel`, "must be preview or stable");
    if (targetSchemaVersion !== undefined && targetSchemaVersion !== "0.1.0")
      issue(
        issues,
        "unsupported-version",
        `${targetPath}.schemaVersion`,
        "only 0.1.0 is supported",
      );
    if (channelValue !== undefined && targetChannel !== undefined && channelValue !== targetChannel)
      issue(
        issues,
        "invalid-relationship",
        `${targetPath}.channel`,
        "must equal the selected channel",
      );
    if (packId !== undefined && targetPackId !== undefined && packId !== targetPackId)
      issue(issues, "invalid-relationship", `${targetPath}.packId`, "must equal pack.packId");
    if (
      packVersion !== undefined &&
      targetPackVersion !== undefined &&
      packVersion !== targetPackVersion
    )
      issue(
        issues,
        "invalid-relationship",
        `${targetPath}.packVersion`,
        "must equal pack.packVersion",
      );
    if (
      packSchemaVersion !== undefined &&
      targetSchemaVersion !== undefined &&
      packSchemaVersion !== targetSchemaVersion
    )
      issue(
        issues,
        "invalid-relationship",
        `${targetPath}.schemaVersion`,
        "must equal pack.schemaVersion",
      );
    if (
      channelValue !== undefined &&
      targetPathValue !== undefined &&
      TARGET_PATH.exec(targetPathValue)?.[1] !== channelValue
    )
      issue(
        issues,
        "invalid-relationship",
        `${targetPath}.targetPath`,
        "must belong to the selected channel",
      );

    const trustedState = validateTrustedState(
      root?.["trustedState"],
      channelValue,
      verificationTime,
      issues,
    );
    if (
      issues.length > 0 ||
      recordKind !== STANDARDS_LOCKFILE_RECORD_KIND ||
      schemaVersion !== STANDARDS_LOCKFILE_CONTRACT_VERSION ||
      channelValue === undefined ||
      verificationTime === undefined ||
      !exactInstant(verificationTime) ||
      packId === undefined ||
      packVersion === undefined ||
      publishedAt === undefined ||
      !exactDate(publishedAt) ||
      packSchemaVersion !== "0.1.0" ||
      targetChannel !== channelValue ||
      length === undefined ||
      minEngineVersion === undefined ||
      targetPackId !== packId ||
      targetPackVersion !== packVersion ||
      targetSchemaVersion !== packSchemaVersion ||
      sha256 === undefined ||
      targetPathValue === undefined ||
      trustedState === undefined
    )
      return { ok: false, issues: Object.freeze(issues) };
    return {
      ok: true,
      value: Object.freeze({
        channel: channelValue,
        pack: Object.freeze({ packId, packVersion, publishedAt, schemaVersion: packSchemaVersion }),
        recordKind,
        schemaVersion,
        target: Object.freeze({
          channel: channelValue,
          length,
          minEngineVersion,
          packId: targetPackId,
          packVersion: targetPackVersion,
          schemaVersion: targetSchemaVersion,
          sha256,
          targetPath: targetPathValue,
        }),
        trustedState,
        verificationTime,
      }),
    };
  } catch {
    return failure("invalid-json", "$", "input must be safely inspectable lockfile data");
  }
}

/** Serialize a valid standards lockfile as exact RFC 8785 canonical JSON without a trailing newline. */
export function serializeStandardsLockfile(input: unknown): StandardsLockfileSerializationResult {
  const validation = validateStandardsLockfile(input);
  if (!validation.ok) return validation;
  const canonical = canonicalizeJson(validation.value);
  return canonical.ok ? canonical : { ok: false, issues: mapCanonicalIssues(canonical.issues) };
}

function copyBytes(
  input: string | Uint8Array,
):
  | { readonly ok: true; readonly value: Uint8Array }
  | { readonly issues: readonly StandardsLockfileIssue[]; readonly ok: false } {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_STANDARDS_LOCKFILE_BYTES)
      return failure(
        "resource-limit",
        "$",
        `lockfile exceeds ${String(MAX_STANDARDS_LOCKFILE_BYTES)} bytes`,
      );
    return { ok: true, value: Buffer.from(input, "utf8") };
  }
  if (nodeTypes.isProxy(input) || !nodeTypes.isUint8Array(input))
    return failure("invalid-json", "$", "input must be UTF-8 text or bytes");
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
    return failure("invalid-json", "$", "exotic byte views are not accepted");
  if (nodeTypes.isSharedArrayBuffer(input.buffer))
    return failure("invalid-json", "$", "shared byte buffers are not accepted");
  if (input.byteLength > MAX_STANDARDS_LOCKFILE_BYTES)
    return failure(
      "resource-limit",
      "$",
      `lockfile exceeds ${String(MAX_STANDARDS_LOCKFILE_BYTES)} bytes`,
    );
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== input.byteLength ||
    keys.some((key, index) => typeof key !== "string" || key !== String(index))
  )
    return failure("invalid-json", "$", "byte input must not carry extra properties");
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return { ok: true, value: copy };
}

/** Parse only exact canonical UTF-8 lockfile bytes; duplicate keys and alternate spellings fail closed. */
export function parseCanonicalStandardsLockfile(
  input: string | Uint8Array,
): StandardsLockfileParseResult {
  try {
    const copied = copyBytes(input);
    if (!copied.ok) return copied;
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(copied.value);
    if (Buffer.byteLength(text, "utf8") !== copied.value.byteLength)
      return failure(
        "invalid-json",
        "$",
        "input must use canonical UTF-8 without a byte-order mark",
      );
    const parsed: unknown = JSON.parse(text);
    const validation = validateStandardsLockfile(parsed);
    if (!validation.ok) return validation;
    const serialized = serializeStandardsLockfile(validation.value);
    if (!serialized.ok) return serialized;
    if (serialized.text !== text)
      return failure("non-canonical", "$", "input must be exact RFC 8785 canonical JSON");
    return { canonicalJson: serialized.text, ok: true, value: validation.value };
  } catch {
    return failure("invalid-json", "$", "input is not valid canonical UTF-8 JSON");
  }
}

/** Atomically replace an existing lockfile after full validation and canonical serialization. */
export async function updateStandardsLockfile(
  writer: StandardsLockfileAtomicWriter,
  request: unknown,
): Promise<StandardsLockfileAtomicWriteResult> {
  const cloned = plainClone(request, MAX_STANDARDS_LOCKFILE_BYTES + 4096);
  if (!cloned.ok)
    throw new TypeError(cloned.issues[0]?.message ?? "invalid lockfile update request");
  const issues: StandardsLockfileIssue[] = [];
  const root = object(cloned.value, "$request", ["expected", "lockfile", "path"], issues);
  const pathValue = string(root, "path", "$request", issues);
  let path: RepositoryRelativePath | undefined;
  if (pathValue !== undefined) {
    try {
      path = canonicalizeRepositoryRelativePath(pathValue);
      if (path !== pathValue || path === ".") path = undefined;
    } catch {
      path = undefined;
    }
    if (path === undefined)
      issue(issues, "invalid-value", "$request.path", "must be a canonical repository file path");
  }
  const expectedRecord = object(
    root?.["expected"],
    "$request.expected",
    ["identity", "sha256"],
    issues,
  );
  const expectedSha256 = string(expectedRecord, "sha256", "$request.expected", issues, SHA256);
  const identityRecord = object(
    expectedRecord?.["identity"],
    "$request.expected.identity",
    ["device", "inode"],
    issues,
  );
  const device = string(
    identityRecord,
    "device",
    "$request.expected.identity",
    issues,
    DECIMAL_IDENTITY,
  );
  const inode = string(
    identityRecord,
    "inode",
    "$request.expected.identity",
    issues,
    DECIMAL_IDENTITY,
  );
  const serialized = serializeStandardsLockfile(root?.["lockfile"]);
  if (!serialized.ok) issues.push(...serialized.issues);
  if (
    issues.length > 0 ||
    path === undefined ||
    expectedSha256 === undefined ||
    device === undefined ||
    inode === undefined ||
    !serialized.ok
  )
    throw new TypeError("invalid standards lockfile update request");
  return writer.write({
    expected: Object.freeze({ identity: Object.freeze({ device, inode }), sha256: expectedSha256 }),
    path,
    replacement: Buffer.from(serialized.text, "utf8"),
  } satisfies StandardsLockfileAtomicWriteRequest);
}
