import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";

import {
  MAX_KNOWLEDGE_PACK_BYTES,
  canonicalizeJson,
  parseCanonicalKnowledgePack,
} from "./knowledge-pack.js";
import { MAX_TUF_METADATA_BYTES, OfflineTufTrustStore } from "./tuf-trust.js";

import type { KnowledgePack } from "./knowledge-pack.js";
import type { TufChannel, TufTrustedStateSnapshot, TufVerifiedTarget } from "./tuf-trust.js";

export const BUNDLED_PACK_LOADER_CONTRACT_VERSION = "0.1.0" as const;
export const BUNDLED_PACK_MANIFEST_VERSION = "0.1.0" as const;
export const MAX_BUNDLED_MANIFEST_BYTES: number = 128 * 1024;
export const MAX_BUNDLED_MANIFEST_ENTRIES = 2;
export const MAX_BUNDLED_PATH_BYTES = 256;

const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const SAFE_PATH = /^[a-z0-9][a-z0-9._/-]*$/u;
const MANIFEST_FILE = "manifest.v0.json";
const BUNDLED_ROOT = fileURLToPath(new URL("../bundled/", import.meta.url));

// The manifest is the out-of-band bundled trust anchor. Updating either value is a reviewed H03
// fixture migration and must be accompanied by the complete signed metadata and target bytes.
export const BUNDLED_MANIFEST_LENGTH = 1_097;
export const BUNDLED_MANIFEST_SHA256 =
  "c014107c43607dec73a0a38ca2ccb9799ba32af2dd7e8dbf8b0e8f4f440988bc";

export interface BundledKnowledgePackRequest {
  readonly channel: TufChannel;
  readonly engineVersion: string;
}

export interface BundledKnowledgePackProvenance {
  readonly channel: TufChannel;
  readonly contentLength: number;
  readonly contentPath: string;
  readonly contentSha256: string;
  readonly manifestSha256: string;
  readonly target: TufVerifiedTarget;
  readonly trustedState: TufTrustedStateSnapshot;
  readonly verificationTime: string;
}

export interface LoadedBundledKnowledgePack {
  readonly contractVersion: typeof BUNDLED_PACK_LOADER_CONTRACT_VERSION;
  readonly origin: "bundled";
  readonly pack: KnowledgePack;
  readonly provenance: BundledKnowledgePackProvenance;
}

export type BundledPackLoadIssueCode =
  | "binding-mismatch"
  | "concurrent-change"
  | "invalid-input"
  | "invalid-manifest"
  | "manifest-mismatch"
  | "pack-invalid"
  | "resource-limit"
  | "trust-failure"
  | "unsafe-file"
  | "unsafe-path";

export interface BundledPackLoadIssue {
  readonly code: BundledPackLoadIssueCode;
  readonly message: string;
  readonly path: string;
}

export type BundledPackLoadResult =
  | { readonly ok: true; readonly value: LoadedBundledKnowledgePack }
  | { readonly issues: readonly BundledPackLoadIssue[]; readonly ok: false };

interface FileDescriptor {
  readonly length: number;
  readonly path: string;
  readonly sha256: string;
}

interface ManifestEntry {
  readonly channel: TufChannel;
  readonly content: FileDescriptor;
  readonly metadata: Readonly<{
    delegatedTargets: FileDescriptor;
    root: FileDescriptor;
    snapshot: FileDescriptor;
    targets: FileDescriptor;
    timestamp: FileDescriptor;
  }>;
  readonly targetPath: string;
}

interface BundledManifest {
  readonly entries: readonly ManifestEntry[];
  readonly recordKind: "agent-context-bundled-pack-manifest";
  readonly schemaVersion: typeof BUNDLED_PACK_MANIFEST_VERSION;
  readonly verificationTime: string;
}

interface ReadHooks {
  readonly afterOpen?: (relativePath: string, absolutePath: string) => Promise<void> | void;
}

interface StatIdentity {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}

class LoadFailure extends Error {
  readonly issue: BundledPackLoadIssue;

  constructor(code: BundledPackLoadIssueCode, issuePath: string, message: string) {
    super(message);
    this.issue = Object.freeze({ code, message, path: issuePath });
  }
}

const AUTHENTICATED_BUNDLED_PACKS = new WeakSet<object>();
const AUTHENTICATED_BUNDLED_TRUST = new WeakMap<object, OfflineTufTrustStore>();

function fail(code: BundledPackLoadIssueCode, issuePath: string, message: string): never {
  throw new LoadFailure(code, issuePath, message);
}

function failure(error: unknown): BundledPackLoadResult {
  const issue =
    error instanceof LoadFailure
      ? error.issue
      : Object.freeze({
          code: "unsafe-file" as const,
          message: "bundled pack loading failed closed",
          path: "$",
        });
  return Object.freeze({ issues: Object.freeze([issue]), ok: false });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  issuePath: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail("invalid-manifest", issuePath, "manifest object fields do not match the closed schema");
}

function record(value: unknown, issuePath: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid-manifest", issuePath, "manifest value must be an object");
  return value as Record<string, unknown>;
}

function string(value: unknown, issuePath: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail("invalid-manifest", issuePath, "manifest value must be a non-empty string");
  return value;
}

function integer(value: unknown, issuePath: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    fail("resource-limit", issuePath, "manifest length is outside its resource ceiling");
  return value as number;
}

function safeRelativePath(value: unknown, issuePath: string): string {
  const candidate = string(value, issuePath);
  if (
    candidate.length > MAX_BUNDLED_PATH_BYTES ||
    Buffer.byteLength(candidate, "utf8") > MAX_BUNDLED_PATH_BYTES ||
    !SAFE_PATH.test(candidate) ||
    candidate.startsWith("/") ||
    candidate.endsWith("/") ||
    candidate.split("/").some((segment) => segment === "." || segment === "..") ||
    path.posix.normalize(candidate) !== candidate
  )
    fail("unsafe-path", issuePath, "manifest path is not a canonical bundled relative path");
  return candidate;
}

function descriptor(value: unknown, issuePath: string, maximum: number): FileDescriptor {
  const candidate = record(value, issuePath);
  exactKeys(candidate, ["length", "path", "sha256"], issuePath);
  const digest = string(candidate["sha256"], `${issuePath}.sha256`);
  if (!SHA256.test(digest))
    fail("invalid-manifest", `${issuePath}.sha256`, "manifest digest must be lowercase SHA-256");
  return Object.freeze({
    length: integer(candidate["length"], `${issuePath}.length`, maximum),
    path: safeRelativePath(candidate["path"], `${issuePath}.path`),
    sha256: digest,
  });
}

function validUtc(value: string): boolean {
  const match = RFC3339_UTC.exec(value);
  if (match === null) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().replace(".000Z", "Z") === value;
}

function parseManifest(bytes: Uint8Array): BundledManifest {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    fail("invalid-manifest", "$manifest", "manifest must be well-formed UTF-8");
  }
  if (Buffer.byteLength(text, "utf8") !== bytes.byteLength || text.charCodeAt(0) === 0xfeff)
    fail("invalid-manifest", "$manifest", "manifest must use UTF-8 without a byte-order mark");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("invalid-manifest", "$manifest", "manifest must be valid JSON");
  }
  const canonical = canonicalizeJson(parsed);
  if (!canonical.ok || canonical.text !== text)
    fail("invalid-manifest", "$manifest", "manifest must be exact canonical I-JSON");
  const root = record(parsed, "$manifest");
  exactKeys(root, ["entries", "recordKind", "schemaVersion", "verificationTime"], "$manifest");
  if (root["recordKind"] !== "agent-context-bundled-pack-manifest")
    fail("invalid-manifest", "$manifest.recordKind", "manifest record kind is unsupported");
  if (root["schemaVersion"] !== BUNDLED_PACK_MANIFEST_VERSION)
    fail("invalid-manifest", "$manifest.schemaVersion", "manifest schema version is unsupported");
  const verificationTime = string(root["verificationTime"], "$manifest.verificationTime");
  if (!validUtc(verificationTime))
    fail("invalid-manifest", "$manifest.verificationTime", "verification time must be exact UTC");
  if (!Array.isArray(root["entries"]))
    fail("invalid-manifest", "$manifest.entries", "manifest entries must be an array");
  if (root["entries"].length < 1 || root["entries"].length > MAX_BUNDLED_MANIFEST_ENTRIES)
    fail("resource-limit", "$manifest.entries", "manifest entry count is outside its limit");
  const entries: ManifestEntry[] = [];
  let previousChannel: string | undefined;
  for (const [index, entryValue] of root["entries"].entries()) {
    const entryPath = `$manifest.entries[${String(index)}]`;
    const entry = record(entryValue, entryPath);
    exactKeys(entry, ["channel", "content", "metadata", "targetPath"], entryPath);
    const channel = string(entry["channel"], `${entryPath}.channel`);
    if (channel !== "preview" && channel !== "stable")
      fail("invalid-manifest", `${entryPath}.channel`, "manifest channel is unsupported");
    if (previousChannel !== undefined && previousChannel >= channel)
      fail(
        "invalid-manifest",
        `${entryPath}.channel`,
        "manifest channels must be sorted and unique",
      );
    previousChannel = channel;
    const metadata = record(entry["metadata"], `${entryPath}.metadata`);
    exactKeys(
      metadata,
      ["delegatedTargets", "root", "snapshot", "targets", "timestamp"],
      `${entryPath}.metadata`,
    );
    const content = descriptor(entry["content"], `${entryPath}.content`, MAX_KNOWLEDGE_PACK_BYTES);
    if (content.path !== `packs/sha256-${content.sha256}.json`)
      fail("unsafe-path", `${entryPath}.content.path`, "pack path must be content-addressed");
    entries.push(
      Object.freeze({
        channel,
        content,
        metadata: Object.freeze({
          delegatedTargets: descriptor(
            metadata["delegatedTargets"],
            `${entryPath}.metadata.delegatedTargets`,
            MAX_TUF_METADATA_BYTES,
          ),
          root: descriptor(metadata["root"], `${entryPath}.metadata.root`, MAX_TUF_METADATA_BYTES),
          snapshot: descriptor(
            metadata["snapshot"],
            `${entryPath}.metadata.snapshot`,
            MAX_TUF_METADATA_BYTES,
          ),
          targets: descriptor(
            metadata["targets"],
            `${entryPath}.metadata.targets`,
            MAX_TUF_METADATA_BYTES,
          ),
          timestamp: descriptor(
            metadata["timestamp"],
            `${entryPath}.metadata.timestamp`,
            MAX_TUF_METADATA_BYTES,
          ),
        }),
        targetPath: safeRelativePath(entry["targetPath"], `${entryPath}.targetPath`),
      }),
    );
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    recordKind: "agent-context-bundled-pack-manifest",
    schemaVersion: BUNDLED_PACK_MANIFEST_VERSION,
    verificationTime,
  });
}

function validateRequest(input: unknown): BundledKnowledgePackRequest {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    nodeTypes.isProxy(input)
  )
    fail("invalid-input", "$request", "request must be a non-proxy plain data object");
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    fail("invalid-input", "$request", "request must have a plain prototype");
  const keys = Reflect.ownKeys(input);
  if (keys.length > 2) fail("invalid-input", "$request", "request contains too many fields");
  if (
    keys.length !== 2 ||
    keys.some((key) => typeof key !== "string" || (key !== "channel" && key !== "engineVersion"))
  )
    fail("invalid-input", "$request", "request fields do not match the closed schema");
  const values = new Map<string, unknown>();
  for (const key of keys as readonly string[]) {
    const property = Reflect.getOwnPropertyDescriptor(input, key);
    if (property === undefined || !("value" in property))
      fail("invalid-input", "$request", "request must contain only own data properties");
    values.set(key, property.value as unknown);
  }
  const channel = values.get("channel");
  const engineVersion = values.get("engineVersion");
  if (channel !== "preview" && channel !== "stable")
    fail("invalid-input", "$request.channel", "request channel is unsupported");
  if (
    typeof engineVersion !== "string" ||
    engineVersion.length > 256 ||
    Buffer.byteLength(engineVersion, "utf8") > 256 ||
    !SEMVER.test(engineVersion)
  )
    fail("invalid-input", "$request.engineVersion", "engine version must be bounded exact SemVer");
  return Object.freeze({ channel, engineVersion });
}

function identity(
  stats: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): StatIdentity {
  const candidate = stats as unknown as StatIdentity;
  return {
    ctimeNs: candidate.ctimeNs,
    dev: candidate.dev,
    ino: candidate.ino,
    mode: candidate.mode,
    mtimeNs: candidate.mtimeNs,
    size: candidate.size,
  };
}

function sameIdentity(left: StatIdentity, right: StatIdentity): boolean {
  return (
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function readDescriptor(
  rootDirectory: string,
  file: FileDescriptor,
  issuePath: string,
  hooks: ReadHooks = {},
): Promise<Uint8Array> {
  const selectedRoot = path.resolve(rootDirectory);
  const rootBefore = await lstat(selectedRoot, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink())
    fail("unsafe-file", issuePath, "bundled root must be a real directory");
  const rootRealBefore = await realpath(selectedRoot);
  const root = rootRealBefore;
  const segments = file.path.split("/");
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    const ancestor = await lstat(cursor, { bigint: true });
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
      fail("unsafe-path", issuePath, "bundled path contains a non-directory or symbolic ancestor");
  }
  const absolute = path.join(root, ...segments);
  if (!contained(root, absolute)) fail("unsafe-path", issuePath, "bundled path escapes its root");
  const pathBefore = await lstat(absolute, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink())
    fail("unsafe-file", issuePath, "bundled entry must be a regular non-symbolic file");
  if (pathBefore.size !== BigInt(file.length))
    fail("manifest-mismatch", issuePath, "bundled entry length differs from the manifest");
  const realBefore = await realpath(absolute);
  if (realBefore !== absolute || !contained(rootRealBefore, realBefore))
    fail("unsafe-path", issuePath, "bundled entry resolves outside its root");

  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
  let bytes: Uint8Array;
  let openedBefore: StatIdentity;
  let openedAfter: StatIdentity;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(file.length))
      fail("concurrent-change", issuePath, "bundled entry changed before reading");
    openedBefore = identity(before);
    if (
      openedBefore.dev !== pathBefore.dev ||
      openedBefore.ino !== pathBefore.ino ||
      openedBefore.size !== pathBefore.size
    )
      fail("concurrent-change", issuePath, "bundled entry identity changed before reading");
    await hooks.afterOpen?.(file.path, absolute);
    bytes = new Uint8Array(file.length);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0)
        fail("concurrent-change", issuePath, "bundled entry was truncated while reading");
      offset += result.bytesRead;
    }
    const extra = new Uint8Array(1);
    if ((await handle.read(extra, 0, 1, bytes.byteLength)).bytesRead !== 0)
      fail("concurrent-change", issuePath, "bundled entry grew while reading");
    const after = await handle.stat({ bigint: true });
    openedAfter = identity(after);
    if (!sameIdentity(openedBefore, openedAfter))
      fail("concurrent-change", issuePath, "bundled entry changed while reading");
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(absolute, { bigint: true });
  const rootAfter = await lstat(selectedRoot, { bigint: true });
  const realAfter = await realpath(absolute);
  const rootRealAfter = await realpath(selectedRoot);
  if (
    rootAfter.dev !== rootBefore.dev ||
    rootAfter.ino !== rootBefore.ino ||
    rootRealAfter !== rootRealBefore ||
    pathAfter.dev !== openedAfter.dev ||
    pathAfter.ino !== openedAfter.ino ||
    pathAfter.size !== openedAfter.size ||
    realAfter !== realBefore
  )
    fail("concurrent-change", issuePath, "bundled path changed during reading");
  if (sha256(bytes) !== file.sha256)
    fail("manifest-mismatch", issuePath, "bundled entry digest differs from the manifest");
  return bytes;
}

function bindPack(pack: KnowledgePack, target: TufVerifiedTarget): void {
  if (
    pack.channel !== target.channel ||
    pack.packId !== target.packId ||
    pack.packVersion !== target.packVersion
  )
    fail("binding-mismatch", "$pack", "parsed pack identity differs from signed target metadata");
}

async function loadFromRoot(
  rootDirectory: string,
  manifestDescriptor: FileDescriptor,
  requestInput: unknown,
  hooks: ReadHooks,
  authenticate: boolean,
): Promise<BundledPackLoadResult> {
  try {
    if (
      manifestDescriptor.path !== MANIFEST_FILE ||
      !Number.isSafeInteger(manifestDescriptor.length) ||
      manifestDescriptor.length < 1 ||
      manifestDescriptor.length > MAX_BUNDLED_MANIFEST_BYTES ||
      !SHA256.test(manifestDescriptor.sha256)
    )
      fail(
        "invalid-manifest",
        "$manifest",
        "bundled manifest descriptor is outside the fixed contract",
      );
    const request = validateRequest(requestInput);
    const manifestBytes = await readDescriptor(
      rootDirectory,
      manifestDescriptor,
      "$manifest",
      hooks,
    );
    const manifest = parseManifest(manifestBytes);
    const entry = manifest.entries.find((candidate) => candidate.channel === request.channel);
    if (entry === undefined)
      fail("invalid-input", "$request.channel", "requested channel is not bundled");
    const [root, timestamp, snapshot, targets, delegatedTargets, content] = await Promise.all([
      readDescriptor(rootDirectory, entry.metadata.root, "$metadata.root", hooks),
      readDescriptor(rootDirectory, entry.metadata.timestamp, "$metadata.timestamp", hooks),
      readDescriptor(rootDirectory, entry.metadata.snapshot, "$metadata.snapshot", hooks),
      readDescriptor(rootDirectory, entry.metadata.targets, "$metadata.targets", hooks),
      readDescriptor(
        rootDirectory,
        entry.metadata.delegatedTargets,
        "$metadata.delegatedTargets",
        hooks,
      ),
      readDescriptor(rootDirectory, entry.content, "$content", hooks),
    ]);
    const bootstrap = OfflineTufTrustStore.bootstrap(root);
    if (!bootstrap.ok)
      fail(
        "trust-failure",
        "$metadata.root",
        `TUF bootstrap failed: ${bootstrap.issues[0]?.code ?? "invalid-metadata"}`,
      );
    const verified = bootstrap.value.verifyUpdate(
      { delegatedTargets, snapshot, target: content, targets, timestamp },
      {
        channel: request.channel,
        engineVersion: request.engineVersion,
        startedAt: manifest.verificationTime,
        targetPath: entry.targetPath,
      },
    );
    if (!verified.ok)
      fail(
        "trust-failure",
        "$metadata",
        `TUF verification failed: ${verified.issues[0]?.code ?? "invalid-metadata"}`,
      );
    if (
      verified.value.target.length !== entry.content.length ||
      verified.value.target.sha256 !== entry.content.sha256 ||
      verified.value.target.targetPath !== entry.targetPath ||
      verified.value.target.channel !== entry.channel
    )
      fail("binding-mismatch", "$manifest.entries", "manifest differs from signed target metadata");
    const parsed = parseCanonicalKnowledgePack(verified.value.targetBytes);
    if (!parsed.ok) fail("pack-invalid", "$content", "signed target is not a canonical H01 pack");
    bindPack(parsed.value, verified.value.target);
    const value: LoadedBundledKnowledgePack = Object.freeze({
      contractVersion: BUNDLED_PACK_LOADER_CONTRACT_VERSION,
      origin: "bundled",
      pack: parsed.value,
      provenance: Object.freeze({
        channel: request.channel,
        contentLength: entry.content.length,
        contentPath: entry.content.path,
        contentSha256: entry.content.sha256,
        manifestSha256: manifestDescriptor.sha256,
        target: verified.value.target,
        trustedState: verified.value.state.snapshot(),
        verificationTime: manifest.verificationTime,
      }),
    });
    if (authenticate) {
      AUTHENTICATED_BUNDLED_PACKS.add(value);
      AUTHENTICATED_BUNDLED_TRUST.set(value, verified.value.state);
    }
    return Object.freeze({ ok: true, value });
  } catch (error) {
    return failure(error);
  }
}

/** Load the immutable package-bundled pack without network, ambient clock, process, or env input. */
export async function loadBundledKnowledgePack(request: unknown): Promise<BundledPackLoadResult> {
  return loadFromRoot(
    BUNDLED_ROOT,
    { length: BUNDLED_MANIFEST_LENGTH, path: MANIFEST_FILE, sha256: BUNDLED_MANIFEST_SHA256 },
    request,
    {},
    true,
  );
}

/** Authenticate only a value minted by this module's fixed bundled trust path. */
export function isAuthenticatedBundledKnowledgePack(
  value: unknown,
): value is LoadedBundledKnowledgePack {
  return value !== null && typeof value === "object" && AUTHENTICATED_BUNDLED_PACKS.has(value);
}

/**
 * Return the private trusted-state capability paired with an authenticated bundled pack.
 *
 * The capability is minted only by the production loader's fixed manifest/bootstrap path. A
 * structural copy of a loaded pack, a fixture loader result, or serialized provenance cannot
 * obtain it. H08 callers must keep the capability in process memory and never expose it in a
 * command report or persistent artifact.
 */
export function getAuthenticatedBundledTrustStore(
  value: unknown,
): OfflineTufTrustStore | undefined {
  if (!isAuthenticatedBundledKnowledgePack(value)) return undefined;
  return AUTHENTICATED_BUNDLED_TRUST.get(value);
}

/** @internal Test-only filesystem fault surface. It never mints bundled authority. */
export async function loadBundledKnowledgePackFixtureForTest(
  rootDirectory: string,
  manifestDescriptor: FileDescriptor,
  request: unknown,
  hooks: ReadHooks = {},
): Promise<BundledPackLoadResult> {
  return loadFromRoot(rootDirectory, manifestDescriptor, request, hooks, false);
}
