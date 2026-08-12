import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import { types as nodeTypes } from "node:util";

import type { KeyObject } from "node:crypto";
import type { Server, Socket } from "node:net";

import { MAX_KNOWLEDGE_PACK_BYTES } from "./knowledge-pack.js";
import { MAX_TUF_METADATA_BYTES } from "./tuf-trust.js";

export const STANDARDS_CACHE_CONTRACT_VERSION = "0.1.0" as const;
export const STANDARDS_CACHE_LAYOUT_VERSION = "v1" as const;
export const MAX_STANDARDS_CACHE_QUARANTINE_ENTRIES = 64;
export const MAX_STANDARDS_CACHE_RELEASE_CLAIMS = 64;
export const MAX_STANDARDS_CACHE_LOCK_ATTEMPTS = 100;
export const MAX_STANDARDS_CACHE_LOCK_DELAY_MS = 1_000;
export const MAX_STANDARDS_CACHE_LOCK_WAIT_MS = 30_000;

export type StandardsCacheEntryKind = "artifact" | "state";

export type StandardsCacheIssueCode =
  | "cache-miss"
  | "cancelled"
  | "concurrent-change"
  | "digest-mismatch"
  | "entry-exists"
  | "invalid-input"
  | "io-failure"
  | "lock-invalid"
  | "lock-timeout"
  | "quarantine-full"
  | "resource-limit"
  | "unsafe-cache";

export interface StandardsCacheIssue {
  readonly code: StandardsCacheIssueCode;
  readonly message: string;
  readonly path: string;
}

export type StandardsCacheResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly issues: readonly StandardsCacheIssue[]; readonly ok: false };

export interface StandardsCacheEntryRequest {
  readonly kind: StandardsCacheEntryKind;
  readonly length: number;
  readonly sha256: string;
}

export interface StandardsCacheEntry extends StandardsCacheEntryRequest {
  readonly bytes: Uint8Array;
  readonly contractVersion: typeof STANDARDS_CACHE_CONTRACT_VERSION;
  readonly origin: "untrusted-cache";
}

export interface StandardsCacheCandidate {
  readonly bytes: Uint8Array;
  readonly kind: StandardsCacheEntryKind;
  readonly sha256: string;
}

export interface StandardsCacheLockOptions {
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly signal: AbortSignal;
}

export interface StandardsCacheQuarantineRecord {
  readonly contractVersion: typeof STANDARDS_CACHE_CONTRACT_VERSION;
  readonly expectedSha256: string;
  readonly kind: StandardsCacheEntryKind;
  readonly observedSha256: string;
  readonly path: string;
}

export interface StandardsCacheWriteLock {
  readonly contractVersion: typeof STANDARDS_CACHE_CONTRACT_VERSION;
  release(): Promise<StandardsCacheResult<Readonly<{ released: true }>>>;
}

interface StatIdentity {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
}

interface CacheHooks {
  readonly afterEntryLstat?: (absolutePath: string) => Promise<void> | void;
  readonly afterEntryOpen?: (absolutePath: string) => Promise<void> | void;
  readonly afterEntryRead?: (absolutePath: string) => Promise<void> | void;
  readonly afterLockOwnerWrite?: (ownerPath: string) => Promise<void> | void;
  readonly beforeLockHolderListen?: () => Promise<void> | void;
  readonly afterLockOwnerTemporaryWrite?: (temporaryPath: string) => Promise<void> | void;
  readonly afterPublishLink?: (temporaryPath: string, finalPath: string) => Promise<void> | void;
  readonly afterPublishUnlink?: (finalPath: string) => Promise<void> | void;
  readonly afterQuarantineWrite?: (quarantinePath: string) => Promise<void> | void;
  readonly afterTemporaryWrite?: (temporaryPath: string) => Promise<void> | void;
  readonly beforeLockOwnerRelease?: (ownerPath: string) => Promise<void> | void;
  readonly beforeLockOwnerPublish?: (
    temporaryPath: string,
    ownerPath: string,
  ) => Promise<void> | void;
  readonly beforeLockRetryWait?: (attempt: number) => Promise<void> | void;
  readonly beforePublish?: (temporaryPath: string, finalPath: string) => Promise<void> | void;
  readonly beforeQuarantineSourceRemove?: (sourcePath: string) => Promise<void> | void;
}

interface ExactRead {
  readonly bytes: Uint8Array;
  readonly identity: StatIdentity;
}

interface LockState {
  active: boolean;
  readonly cache: StandardsCache;
  readonly holder: LockHolder;
  readonly ownerBytes: Uint8Array;
  readonly ownerHandle: Awaited<ReturnType<typeof open>>;
  readonly ownerIdentity: StatIdentity;
  readonly ownerRelative: string;
  readonly temporaryRelative: string;
}

interface LockHolder {
  acquisitionTimer?: ReturnType<typeof globalThis.setTimeout>;
  readonly port: number;
  readonly publicKey: string;
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

interface AcquisitionBudget {
  readonly cleanupDeadline: number;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

class CacheFailure extends Error {
  readonly issue: StandardsCacheIssue;

  constructor(code: StandardsCacheIssueCode, issuePath: string, message: string) {
    super(message);
    this.issue = Object.freeze({ code, message, path: issuePath });
  }
}

class LockBusy extends Error {}

const SHA256 = /^[a-f0-9]{64}$/u;
const LAYOUT_DIRECTORIES = [
  "artifacts",
  "artifacts/sha256",
  "state",
  "state/sha256",
  "locks",
  "temporary",
  "quarantine",
] as const;
const INITIAL_LOCK_GENERATION = "locks/writer.v0.json";
const LOCK_GENERATION_NAME = /^\.writer\.generation-([a-f0-9]{64})\.v0\.json$/u;
const LOCK_TEMPORARY_NAME =
  /^lock-owner-([a-f0-9]{64})-port-([1-9][0-9]{0,4})-key-([a-f0-9]{88})\.partial$/u;
const LOCK_OWNER_SLOT_NAME = /^lock-owner-slot-([0-9]{2})$/u;
const LOCK_TOKEN_BYTES = 32;
const LOCK_TOKEN = /^[a-f0-9]{64}$/u;
const LOCK_STATES = new WeakMap<object, LockState>();

function acquisitionBudget(options: Required<StandardsCacheLockOptions>): AcquisitionBudget {
  const milliseconds = Math.min(
    MAX_STANDARDS_CACHE_LOCK_WAIT_MS,
    1_000 + options.maxAttempts * options.retryDelayMs,
  );
  const cleanupDeadline = performance.now() + milliseconds;
  return { cleanupDeadline, deadline: cleanupDeadline - 100, signal: options.signal };
}

function remainingCleanupBudget(budget: AcquisitionBudget): number {
  const remaining = budget.cleanupDeadline - performance.now();
  if (!(remaining > 0)) fail("lock-timeout", "$lock", "cache lock cleanup deadline expired");
  return Math.max(1, Math.ceil(remaining));
}

function remainingBudget(budget: AcquisitionBudget): number {
  if (budget.signal.aborted) fail("cancelled", "$lock", "cache lock acquisition was cancelled");
  const remaining = budget.deadline - performance.now();
  if (!(remaining > 0)) fail("lock-timeout", "$lock", "cache lock acquisition deadline expired");
  return Math.max(1, Math.ceil(remaining));
}

async function withinAcquisitionBudget<T>(
  operation: () => Promise<T> | T,
  budget: AcquisitionBudget,
): Promise<T> {
  remainingBudget(budget);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      globalThis.clearTimeout(timeout);
      budget.signal.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: CacheFailure): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timeout = globalThis.setTimeout(() => {
      rejectOnce(new CacheFailure("lock-timeout", "$lock", "cache lock acquisition timed out"));
    }, remainingBudget(budget));
    const onAbort = (): void => {
      rejectOnce(new CacheFailure("cancelled", "$lock", "cache lock acquisition was cancelled"));
    };
    budget.signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error("cache lock operation failed"));
        },
      );
  });
}

type IntrinsicGetter = (this: unknown) => unknown;
type IntrinsicFunction = (...arguments_: readonly unknown[]) => unknown;

function requireGetter(prototype: object, key: string): IntrinsicGetter {
  const getter = Reflect.getOwnPropertyDescriptor(prototype, key)?.get;
  if (getter === undefined) throw new TypeError(`${key} intrinsic getter is unavailable`);
  return getter;
}

function requireFunction(prototype: object, key: string): IntrinsicFunction {
  const value: unknown = Reflect.getOwnPropertyDescriptor(prototype, key)?.value;
  if (typeof value !== "function") throw new TypeError(`${key} intrinsic function is unavailable`);
  return value as IntrinsicFunction;
}

const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Uint8Array.prototype);
if (TYPED_ARRAY_PROTOTYPE === null) throw new TypeError("TypedArray prototype is unavailable");
const TYPED_ARRAY_BYTE_LENGTH = requireGetter(TYPED_ARRAY_PROTOTYPE, "byteLength");
const TYPED_ARRAY_BUFFER = requireGetter(TYPED_ARRAY_PROTOTYPE, "buffer");
const UINT8_ARRAY_SET = requireFunction(TYPED_ARRAY_PROTOTYPE, "set");

function fail(code: StandardsCacheIssueCode, issuePath: string, message: string): never {
  throw new CacheFailure(code, issuePath, message);
}

function failure<T>(error: unknown): StandardsCacheResult<T> {
  const selected =
    error instanceof CacheFailure
      ? error.issue
      : Object.freeze({
          code: "io-failure" as const,
          message: "standards cache operation failed closed",
          path: "$",
        });
  return Object.freeze({ issues: Object.freeze([selected]), ok: false });
}

function success<T>(value: T): StandardsCacheResult<T> {
  return Object.freeze({ ok: true, value });
}

function nodeCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function identity(value: StatIdentity): StatIdentity {
  return {
    ctimeNs: value.ctimeNs,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    mtimeNs: value.mtimeNs,
    nlink: value.nlink,
    size: value.size,
  };
}

function sameIdentity(left: StatIdentity, right: StatIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameObject(left: StatIdentity, right: StatIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasExactPrivateMode(value: StatIdentity, expected: bigint): boolean {
  return process.platform === "win32" || (value.mode & 0o777n) === expected;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lockOwnerBytes(
  ownerIdentity: StatIdentity,
  holderPort: number,
  holderPublicKey: string,
  nextToken: string,
): Uint8Array {
  if (!LOCK_TOKEN.test(nextToken))
    fail("io-failure", "$lock", "cache lock token generation failed");
  return Buffer.from(
    `{"contractVersion":"0.1.0","holderPort":${String(holderPort)},"holderPublicKey":"${holderPublicKey}","nextToken":"${nextToken}","ownerDev":"${ownerIdentity.dev.toString()}","ownerIno":"${ownerIdentity.ino.toString()}","recordKind":"agent-context-standards-cache-lock"}`,
    "utf8",
  );
}

interface LockOwnerRecord {
  readonly holderPort: number;
  readonly holderPublicKey: string;
  readonly nextToken: string;
}

interface LockGenerationAuthority {
  readonly identity: StatIdentity;
  readonly record: LockOwnerRecord;
  readonly relative: string;
}

interface LockTemporarySnapshot {
  readonly authorities: ReadonlyMap<string, LockGenerationAuthority>;
  readonly legacyClaims: number;
  readonly occupiedSlots: ReadonlySet<number>;
}

function objectIdentityKey(value: StatIdentity): string {
  return `${value.dev.toString()}:${value.ino.toString()}`;
}

function lockTemporaryName(holder: LockHolder, nextToken: string): string {
  const key = Buffer.from(holder.publicKey, "base64").toString("hex");
  /* v8 ignore next -- private holder construction and CSPRNG output enforce both invariants. */
  if (!LOCK_TOKEN.test(nextToken) || key.length !== 88)
    fail("io-failure", "$lock", "cache lock temporary authority generation failed");
  return `lock-owner-${nextToken}-port-${String(holder.port)}-key-${key}.partial`;
}

function parseLockTemporaryName(name: string): LockOwnerRecord {
  const match = LOCK_TEMPORARY_NAME.exec(name);
  if (match === null) fail("unsafe-cache", "$lock", "cache lock temporary authority is malformed");
  const [, nextToken, portText, keyHex] = match;
  /* v8 ignore next -- every capture is mandatory in LOCK_TEMPORARY_NAME. */
  if (nextToken === undefined || portText === undefined || keyHex === undefined)
    fail("unsafe-cache", "$lock", "cache lock temporary authority is malformed");
  const holderPort = Number(portText);
  const holderPublicKey = Buffer.from(keyHex, "hex").toString("base64");
  if (!Number.isSafeInteger(holderPort) || holderPort < 1 || holderPort > 65_535)
    fail("unsafe-cache", "$lock", "cache lock temporary authority is malformed");
  try {
    const publicKey = createPublicKey({
      format: "der",
      key: Buffer.from(holderPublicKey, "base64"),
      type: "spki",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("wrong key type");
  } catch {
    fail("unsafe-cache", "$lock", "cache lock temporary authority key is invalid");
  }
  return { holderPort, holderPublicKey, nextToken };
}

function parseLockOwner(bytes: Uint8Array, ownerIdentity: StatIdentity): LockOwnerRecord {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    fail("unsafe-cache", "$lock", "cache lock owner record is malformed");
  }
  let fields: Map<string, unknown>;
  try {
    fields = ownData(
      value,
      [
        "contractVersion",
        "holderPort",
        "holderPublicKey",
        "nextToken",
        "ownerDev",
        "ownerIno",
        "recordKind",
      ],
      "$lock",
    );
  } catch {
    fail("unsafe-cache", "$lock", "cache lock owner record violates its closed contract");
  }
  const nextToken = fields.get("nextToken");
  const holderPublicKey = fields.get("holderPublicKey");
  const holderPort = fields.get("holderPort");
  if (
    fields.get("contractVersion") !== STANDARDS_CACHE_CONTRACT_VERSION ||
    fields.get("recordKind") !== "agent-context-standards-cache-lock" ||
    fields.get("ownerDev") !== ownerIdentity.dev.toString() ||
    fields.get("ownerIno") !== ownerIdentity.ino.toString() ||
    typeof nextToken !== "string" ||
    !LOCK_TOKEN.test(nextToken) ||
    typeof holderPublicKey !== "string" ||
    !Number.isSafeInteger(holderPort) ||
    (holderPort as number) < 1 ||
    (holderPort as number) > 65_535
  )
    fail("unsafe-cache", "$lock", "cache lock owner record violates its closed contract");
  let publicKey: KeyObject;
  try {
    const encoded = Buffer.from(holderPublicKey, "base64");
    if (encoded.byteLength !== 44 || encoded.toString("base64") !== holderPublicKey)
      throw new TypeError("non-canonical public key");
    publicKey = createPublicKey({ format: "der", key: encoded, type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("wrong public key type");
  } catch {
    fail("unsafe-cache", "$lock", "cache lock holder public key is invalid");
  }
  const canonical = `{"contractVersion":"0.1.0","holderPort":${String(holderPort)},"holderPublicKey":"${holderPublicKey}","nextToken":"${nextToken}","ownerDev":"${ownerIdentity.dev.toString()}","ownerIno":"${ownerIdentity.ino.toString()}","recordKind":"agent-context-standards-cache-lock"}`;
  if (Buffer.from(bytes).toString("utf8") !== canonical)
    fail("unsafe-cache", "$lock", "cache lock owner record is not canonical");
  return { holderPort: holderPort as number, holderPublicKey, nextToken };
}

async function startLockHolder(
  budget: AcquisitionBudget,
  beforeListen?: () => Promise<void> | void,
): Promise<LockHolder> {
  remainingBudget(budget);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  remainingBudget(budget);
  const encodedPublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 8) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setEncoding("ascii");
    const requestDeadline = globalThis.setTimeout(() => socket.destroy(), 1_000);
    let request = "";
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (request.length > LOCK_TOKEN_BYTES * 2 + 1) {
        socket.destroy();
        return;
      }
      if (request.endsWith("\n")) {
        const challenge = request.slice(0, -1);
        if (LOCK_TOKEN.test(challenge))
          socket.end(
            `${sign(null, Buffer.from(challenge, "ascii"), privateKey).toString("base64")}\n`,
            "ascii",
          );
        else socket.destroy();
      }
    });
    socket.on("close", () => {
      globalThis.clearTimeout(requestDeadline);
      sockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
  });
  server.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      globalThis.clearTimeout(timeout);
      budget.signal.removeEventListener("abort", onAbort);
      server.off("error", onError);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      server.close();
      reject(error);
    };
    const timeout = globalThis.setTimeout(() => {
      rejectOnce(new CacheFailure("lock-timeout", "$lock", "cache lock holder bind timed out"));
    }, remainingBudget(budget));
    const onAbort = (): void => {
      rejectOnce(new CacheFailure("cancelled", "$lock", "cache lock acquisition was cancelled"));
    };
    const onError = (error: Error): void => {
      rejectOnce(error);
    };
    budget.signal.addEventListener("abort", onAbort, { once: true });
    server.once("error", onError);
    void Promise.resolve()
      .then(() => beforeListen?.())
      .then(
        () => {
          if (!settled)
            server.listen({ exclusive: true, host: "127.0.0.1", port: 0 }, () => {
              if (settled) {
                server.close();
                return;
              }
              settled = true;
              cleanup();
              resolve();
            });
        },
        (error: unknown) => {
          rejectOnce(error instanceof Error ? error : new Error("cache lock listen hook failed"));
        },
      );
  });
  remainingBudget(budget);
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    await closeLockHolder({ port: 0, publicKey: encodedPublicKey, server, sockets });
    fail("io-failure", "$lock", "cache lock liveness holder could not bind loopback");
  }
  const holder: LockHolder = { port: address.port, publicKey: encodedPublicKey, server, sockets };
  holder.acquisitionTimer = globalThis.setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  }, remainingBudget(budget));
  return holder;
}

async function closeLockHolder(holder: LockHolder, budget?: AcquisitionBudget): Promise<void> {
  if (holder.acquisitionTimer !== undefined) {
    globalThis.clearTimeout(holder.acquisitionTimer);
    delete holder.acquisitionTimer;
  }
  for (const socket of holder.sockets) socket.destroy();
  if (!holder.server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const timeout =
      budget === undefined
        ? undefined
        : globalThis.setTimeout(() => {
            reject(new CacheFailure("lock-timeout", "$lock", "cache lock cleanup timed out"));
          }, remainingCleanupBudget(budget));
    holder.server.close(() => {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      resolve();
    });
  });
}

function completeLockHolderAcquisition(holder: LockHolder): void {
  if (holder.acquisitionTimer === undefined) return;
  globalThis.clearTimeout(holder.acquisitionTimer);
  delete holder.acquisitionTimer;
}

async function probeLockHolder(
  record: LockOwnerRecord,
  budget: AcquisitionBudget,
): Promise<"alive" | "busy" | "dead"> {
  remainingBudget(budget);
  return new Promise((resolve, reject) => {
    const challenge = randomBytes(LOCK_TOKEN_BYTES).toString("hex");
    const publicKey = createPublicKey({
      format: "der",
      key: Buffer.from(record.holderPublicKey, "base64"),
      type: "spki",
    });
    const socket = createConnection({ host: "127.0.0.1", port: record.holderPort });
    let settled = false;
    let response = "";
    const cleanup = (): void => {
      globalThis.clearTimeout(timeout);
      budget.signal.removeEventListener("abort", onAbort);
    };
    const finish = (result: "alive" | "busy" | "dead"): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      cleanup();
      resolve(result);
    };
    const failProbe = (error: CacheFailure): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      failProbe(new CacheFailure("cancelled", "$lock", "cache lock acquisition was cancelled"));
    };
    const timeout = globalThis.setTimeout(() => {
      failProbe(new CacheFailure("lock-timeout", "$lock", "cache lock probe timed out"));
    }, remainingBudget(budget));
    budget.signal.addEventListener("abort", onAbort, { once: true });
    socket.setEncoding("ascii");
    socket.once("connect", () => {
      try {
        remainingBudget(budget);
        socket.write(`${challenge}\n`, "ascii", () => {
          try {
            remainingBudget(budget);
          } catch (error) {
            if (error instanceof CacheFailure) failProbe(error);
          }
        });
      } catch (error) {
        if (error instanceof CacheFailure) failProbe(error);
      }
    });
    socket.on("data", (chunk: string) => {
      try {
        remainingBudget(budget);
        response += chunk;
        if (response.length > 89) finish("busy");
        else if (response.endsWith("\n")) {
          const signature = Buffer.from(response.slice(0, -1), "base64");
          remainingBudget(budget);
          const alive =
            signature.byteLength === 64 &&
            verify(null, Buffer.from(challenge, "ascii"), publicKey, signature);
          remainingBudget(budget);
          finish(alive ? "alive" : "busy");
        }
      } catch (error) {
        failProbe(
          error instanceof CacheFailure
            ? error
            : new CacheFailure("io-failure", "$lock", "cache lock probe failed closed"),
        );
      }
    });
    socket.once("end", () => {
      finish("busy");
    });
    socket.once("error", (error) => {
      finish(nodeCode(error) === "ECONNREFUSED" ? "dead" : "busy");
    });
  });
}

function ownData(value: unknown, keys: readonly string[], issuePath: string): Map<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    fail("invalid-input", issuePath, "cache input must be a non-proxy plain data object");
  const prototype = Reflect.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail("invalid-input", issuePath, "cache input fields do not match the closed contract");
  const result = new Map<string, unknown>();
  for (const key of ownKeys as readonly string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      fail("invalid-input", issuePath, "cache input must contain only own data properties");
    result.set(key, descriptor.value as unknown);
  }
  return result;
}

function validateEntryRequest(value: unknown): StandardsCacheEntryRequest {
  const fields = ownData(value, ["kind", "length", "sha256"], "$entry");
  const kind = fields.get("kind");
  const length = fields.get("length");
  const sha256 = fields.get("sha256");
  if (kind !== "artifact" && kind !== "state")
    fail("invalid-input", "$entry.kind", "cache entry kind is unsupported");
  const maximum = kind === "artifact" ? MAX_KNOWLEDGE_PACK_BYTES : MAX_TUF_METADATA_BYTES;
  if (!Number.isSafeInteger(length) || (length as number) < 1 || (length as number) > maximum)
    fail("resource-limit", "$entry.length", "cache entry length is outside its limit");
  if (typeof sha256 !== "string" || !SHA256.test(sha256))
    fail("invalid-input", "$entry.sha256", "cache digest must be lowercase SHA-256");
  return Object.freeze({ kind, length: length as number, sha256 });
}

function copyBytes(value: unknown, maximum: number): Uint8Array {
  if (nodeTypes.isProxy(value) || !nodeTypes.isUint8Array(value))
    fail("invalid-input", "$candidate.bytes", "cache bytes must be a plain byte array");
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
    fail("invalid-input", "$candidate.bytes", "exotic byte views are not accepted");
  const length = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []);
  const buffer = Reflect.apply(TYPED_ARRAY_BUFFER, value, []);
  if (typeof length !== "number" || length < 1 || length > maximum)
    fail("resource-limit", "$candidate.bytes", "cache bytes are outside their size limit");
  if (nodeTypes.isSharedArrayBuffer(buffer))
    fail("invalid-input", "$candidate.bytes", "shared byte buffers are not accepted");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length ||
    keys.some((key, index) => typeof key !== "string" || key !== String(index))
  )
    fail("invalid-input", "$candidate.bytes", "cache bytes must not carry extra properties");
  const copy = new Uint8Array(length);
  Reflect.apply(UINT8_ARRAY_SET, copy, [value, 0]);
  return copy;
}

function validateCandidate(value: unknown): StandardsCacheEntry {
  const fields = ownData(value, ["bytes", "kind", "sha256"], "$candidate");
  const kind = fields.get("kind");
  const sha256 = fields.get("sha256");
  if (kind !== "artifact" && kind !== "state")
    fail("invalid-input", "$candidate.kind", "cache entry kind is unsupported");
  if (typeof sha256 !== "string" || !SHA256.test(sha256))
    fail("invalid-input", "$candidate.sha256", "cache digest must be lowercase SHA-256");
  const bytes = copyBytes(
    fields.get("bytes"),
    kind === "artifact" ? MAX_KNOWLEDGE_PACK_BYTES : MAX_TUF_METADATA_BYTES,
  );
  if (digest(bytes) !== sha256)
    fail("digest-mismatch", "$candidate", "candidate bytes differ from their declared digest");
  return Object.freeze({
    bytes,
    contractVersion: STANDARDS_CACHE_CONTRACT_VERSION,
    kind,
    length: bytes.byteLength,
    origin: "untrusted-cache",
    sha256,
  });
}

function validateLockOptions(value: unknown): Required<StandardsCacheLockOptions> {
  const fields = ownData(value, ["maxAttempts", "retryDelayMs", "signal"], "$lock");
  const maxAttempts = fields.get("maxAttempts");
  const retryDelayMs = fields.get("retryDelayMs");
  const signal = fields.get("signal");
  if (
    !Number.isSafeInteger(maxAttempts) ||
    (maxAttempts as number) < 1 ||
    (maxAttempts as number) > MAX_STANDARDS_CACHE_LOCK_ATTEMPTS ||
    !Number.isSafeInteger(retryDelayMs) ||
    (retryDelayMs as number) < 0 ||
    (retryDelayMs as number) > MAX_STANDARDS_CACHE_LOCK_DELAY_MS ||
    (maxAttempts as number) * (retryDelayMs as number) > MAX_STANDARDS_CACHE_LOCK_WAIT_MS
  )
    fail("resource-limit", "$lock", "cache lock wait is outside its bounded policy");
  if (
    nodeTypes.isProxy(signal) ||
    !(signal instanceof AbortSignal) ||
    Reflect.getPrototypeOf(signal) !== AbortSignal.prototype ||
    Reflect.ownKeys(signal).some((key) => typeof key === "string")
  )
    fail("invalid-input", "$lock.signal", "cache cancellation must be a native AbortSignal");
  return Object.freeze({
    maxAttempts: maxAttempts as number,
    retryDelayMs: retryDelayMs as number,
    signal,
  });
}

function entryRelative(entry: StandardsCacheEntryRequest): string {
  const prefix = entry.kind === "artifact" ? "artifacts" : "state";
  return `${prefix}/sha256/${entry.sha256.slice(0, 2)}/${entry.sha256.slice(2)}.bin`;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

let constructStandardsCache: (
  root: string,
  rootIdentity: StatIdentity,
  hooks: CacheHooks,
) => StandardsCache;
let releaseStandardsCacheLock: (
  cache: StandardsCache,
  value: object,
) => Promise<StandardsCacheResult<Readonly<{ released: true }>>>;

export class StandardsCache {
  readonly #hooks: CacheHooks;
  readonly #root: string;
  readonly #rootIdentity: StatIdentity;
  readonly #versionRoot: string;

  private constructor(root: string, rootIdentity: StatIdentity, hooks: CacheHooks) {
    this.#root = root;
    this.#rootIdentity = rootIdentity;
    this.#versionRoot = path.join(root, STANDARDS_CACHE_LAYOUT_VERSION);
    this.#hooks = hooks;
    Object.freeze(this);
  }

  static {
    constructStandardsCache = (root, rootIdentity, hooks): StandardsCache =>
      new StandardsCache(root, rootIdentity, hooks);
    releaseStandardsCacheLock = (
      cache,
      value,
    ): Promise<StandardsCacheResult<Readonly<{ released: true }>>> => cache.#releaseLock(value);
  }

  static async open(rootInput: unknown): Promise<StandardsCacheResult<StandardsCache>> {
    return openCache(rootInput, {});
  }

  async #verifyDirectory(relative: string): Promise<StatIdentity> {
    const absolute = relative === "" ? this.#root : path.join(this.#versionRoot, relative);
    if (relative !== "" && !contained(this.#root, absolute))
      fail("unsafe-cache", "$cache", "cache layout path escapes its root");
    const stats = await lstat(absolute, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink())
      fail("unsafe-cache", "$cache", "cache layout component must be a real directory");
    const selected = identity(stats);
    if (!hasExactPrivateMode(selected, 0o700n))
      fail("unsafe-cache", "$cache", "cache layout directory permissions are not private");
    const resolved = await realpath(absolute);
    if (resolved !== absolute)
      fail("unsafe-cache", "$cache", "cache layout component resolves through a link");
    return selected;
  }

  async #verifyLayout(): Promise<void> {
    const root = await this.#verifyDirectory("");
    if (root.dev !== this.#rootIdentity.dev || root.ino !== this.#rootIdentity.ino)
      fail("concurrent-change", "$cache", "cache root identity changed");
    await this.#verifyDirectory(".");
    for (const relative of LAYOUT_DIRECTORIES) await this.#verifyDirectory(relative);
  }

  #absolute(relative: string): string {
    const absolute = path.join(this.#versionRoot, ...relative.split("/"));
    if (!contained(this.#root, absolute))
      fail("unsafe-cache", "$cache", "cache path escapes its root");
    return absolute;
  }

  async readEntry(requestInput: unknown): Promise<StandardsCacheResult<StandardsCacheEntry>> {
    try {
      const request = validateEntryRequest(requestInput);
      await this.#verifyLayout();
      const relative = entryRelative(request);
      const { bytes } = await this.#readExact(relative, request, true);
      return success(
        Object.freeze({
          ...request,
          bytes,
          contractVersion: STANDARDS_CACHE_CONTRACT_VERSION,
          origin: "untrusted-cache" as const,
        }),
      );
    } catch (error) {
      if (nodeCode(error) === "ENOENT")
        return failure(new CacheFailure("cache-miss", "$entry", "cache entry is absent"));
      return failure(error);
    }
  }

  async #readExact(
    relative: string,
    request: StandardsCacheEntryRequest,
    verifyDigest: boolean,
  ): Promise<ExactRead> {
    const absolute = this.#absolute(relative);
    const parentRelative = path.posix.dirname(relative);
    await this.#verifyDirectory(parentRelative);
    const beforePath = await lstat(absolute, { bigint: true });
    const beforeIdentity = identity(beforePath);
    if (
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      beforePath.nlink !== 1n ||
      !hasExactPrivateMode(beforeIdentity, 0o600n)
    )
      fail("unsafe-cache", "$entry", "cache entry must be one regular unlinked file");
    if (beforePath.size !== BigInt(request.length))
      fail("digest-mismatch", "$entry", "cache entry length differs from its descriptor");
    const resolved = await realpath(absolute);
    if (resolved !== absolute || !contained(this.#root, resolved))
      fail("unsafe-cache", "$entry", "cache entry resolves outside its root");
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
    let bytes: Uint8Array;
    try {
      const openedBefore = identity(await handle.stat({ bigint: true }));
      if (
        !sameIdentity(openedBefore, beforeIdentity) ||
        openedBefore.nlink !== 1n ||
        !hasExactPrivateMode(openedBefore, 0o600n) ||
        openedBefore.size !== BigInt(request.length)
      )
        fail("concurrent-change", "$entry", "cache entry changed before reading");
      // Keep the observed inode pinned while the path is rechecked. Without the open descriptor,
      // Linux may immediately reuse its inode for a same-byte replacement and defeat stat-only CAS.
      await this.#hooks.afterEntryLstat?.(absolute);
      let pathAfterOpen: StatIdentity;
      let resolvedAfterOpen: string;
      try {
        pathAfterOpen = identity(await lstat(absolute, { bigint: true }));
        resolvedAfterOpen = await realpath(absolute);
      } catch (error) {
        if (nodeCode(error) === "ENOENT")
          fail("concurrent-change", "$entry", "cache entry path disappeared before reading");
        throw error;
      }
      if (!sameIdentity(pathAfterOpen, openedBefore) || resolvedAfterOpen !== resolved)
        fail("concurrent-change", "$entry", "cache entry path changed before reading");
      await this.#hooks.afterEntryOpen?.(absolute);
      bytes = new Uint8Array(request.length);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0)
          fail("concurrent-change", "$entry", "cache entry was truncated while reading");
        offset += result.bytesRead;
      }
      if ((await handle.read(new Uint8Array(1), 0, 1, bytes.length)).bytesRead !== 0)
        fail("concurrent-change", "$entry", "cache entry grew while reading");
      const openedAfter = identity(await handle.stat({ bigint: true }));
      if (!sameIdentity(openedBefore, openedAfter))
        fail("concurrent-change", "$entry", "cache entry changed while reading");
      await this.#hooks.afterEntryRead?.(absolute);
      let afterPath: StatIdentity;
      try {
        afterPath = identity(await lstat(absolute, { bigint: true }));
      } catch (error) {
        if (nodeCode(error) === "ENOENT")
          fail("concurrent-change", "$entry", "cache entry path disappeared while reading");
        throw error;
      }
      const finalOpen = identity(await handle.stat({ bigint: true }));
      let selectedHandle: Awaited<ReturnType<typeof open>>;
      try {
        selectedHandle = await open(absolute, fsConstants.O_RDONLY | noFollow);
      } catch (error) {
        if (nodeCode(error) === "ENOENT" || nodeCode(error) === "ELOOP")
          fail("concurrent-change", "$entry", "cache entry path changed while reading");
        throw error;
      }
      let selectedOpen: StatIdentity;
      try {
        selectedOpen = identity(await selectedHandle.stat({ bigint: true }));
      } finally {
        await selectedHandle.close();
      }
      let resolvedAfterRead: string;
      try {
        resolvedAfterRead = await realpath(absolute);
      } catch (error) {
        if (nodeCode(error) === "ENOENT")
          fail("concurrent-change", "$entry", "cache entry path disappeared while reading");
        throw error;
      }
      if (
        !sameIdentity(openedAfter, finalOpen) ||
        !sameIdentity(afterPath, finalOpen) ||
        !sameIdentity(selectedOpen, finalOpen) ||
        resolvedAfterRead !== resolved
      )
        fail("concurrent-change", "$entry", "cache entry path changed while reading");
      if (verifyDigest && digest(bytes) !== request.sha256)
        fail("digest-mismatch", "$entry", "cache entry digest differs from its address");
      return { bytes, identity: finalOpen };
    } finally {
      await handle.close();
    }
  }

  async acquireWriteLock(
    optionsInput: unknown,
  ): Promise<StandardsCacheResult<StandardsCacheWriteLock>> {
    try {
      const options = validateLockOptions(optionsInput);
      const budget = acquisitionBudget(options);
      await this.#verifyLayout();
      for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        remainingBudget(budget);
        let holder: LockHolder | undefined;
        let ownerHandle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          const selected = await this.#selectLockSlot(budget);
          remainingBudget(budget);
          holder = await startLockHolder(budget, this.#hooks.beforeLockHolderListen);
          const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
          const nextToken = randomBytes(LOCK_TOKEN_BYTES).toString("hex");
          const temporaryName = lockTemporaryName(holder, nextToken);
          const temporaryRelative = `${selected.temporaryDirectoryRelative}/${temporaryName}`;
          const temporaryOwnerPath = this.#absolute(temporaryRelative);
          const ownerPath = this.#absolute(selected.relative);
          ownerHandle = await open(
            temporaryOwnerPath,
            fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
            0o600,
          );
          const initialOwnerIdentity = identity(await ownerHandle.stat({ bigint: true }));
          const ownerBytes = lockOwnerBytes(
            initialOwnerIdentity,
            holder.port,
            holder.publicKey,
            nextToken,
          );
          await ownerHandle.chmod(0o600);
          await ownerHandle.writeFile(ownerBytes);
          await ownerHandle.sync();
          await withinAcquisitionBudget(
            () => this.#hooks.afterLockOwnerTemporaryWrite?.(temporaryOwnerPath),
            budget,
          );
          remainingBudget(budget);
          const temporaryOwnerIdentity = identity(await ownerHandle.stat({ bigint: true }));
          if (
            temporaryOwnerIdentity.nlink !== 1n ||
            temporaryOwnerIdentity.size !== BigInt(ownerBytes.byteLength) ||
            !sameObject(temporaryOwnerIdentity, initialOwnerIdentity) ||
            !hasExactPrivateMode(temporaryOwnerIdentity, 0o600n)
          ) {
            fail("unsafe-cache", "$lock", "cache lock temporary owner file is unsafe");
          }
          await withinAcquisitionBudget(
            () => this.#hooks.beforeLockOwnerPublish?.(temporaryOwnerPath, ownerPath),
            budget,
          );
          remainingBudget(budget);
          const selectedTemporaryIdentity = identity(
            await lstat(temporaryOwnerPath, { bigint: true }),
          );
          if (
            !sameIdentity(selectedTemporaryIdentity, temporaryOwnerIdentity) ||
            (await realpath(temporaryOwnerPath)) !== temporaryOwnerPath
          )
            fail("concurrent-change", "$lock", "cache lock temporary owner was replaced");
          await link(temporaryOwnerPath, ownerPath);
          await withinAcquisitionBudget(() => this.#hooks.afterLockOwnerWrite?.(ownerPath), budget);
          remainingBudget(budget);
          const linkedIdentity = identity(await ownerHandle.stat({ bigint: true }));
          const linkedPathIdentity = identity(await lstat(ownerPath, { bigint: true }));
          if (
            linkedIdentity.nlink !== 2n ||
            !sameObject(linkedIdentity, temporaryOwnerIdentity) ||
            !sameIdentity(linkedIdentity, linkedPathIdentity) ||
            !sameIdentity(
              linkedIdentity,
              identity(await lstat(temporaryOwnerPath, { bigint: true })),
            ) ||
            (await realpath(temporaryOwnerPath)) !== temporaryOwnerPath
          ) {
            fail("unsafe-cache", "$lock", "cache lock owner publication is unsafe");
          }
          const observedOwnerBytes = new Uint8Array(ownerBytes.byteLength);
          let observedOffset = 0;
          while (observedOffset < observedOwnerBytes.length) {
            const result = await ownerHandle.read(
              observedOwnerBytes,
              observedOffset,
              observedOwnerBytes.length - observedOffset,
              observedOffset,
            );
            if (result.bytesRead === 0)
              fail(
                "concurrent-change",
                "$lock",
                "cache lock owner bytes changed during publication",
              );
            observedOffset += result.bytesRead;
          }
          if (
            (await ownerHandle.read(new Uint8Array(1), 0, 1, observedOwnerBytes.length))
              .bytesRead !== 0 ||
            !Buffer.from(observedOwnerBytes).equals(Buffer.from(ownerBytes))
          )
            fail("concurrent-change", "$lock", "cache lock owner bytes changed during publication");
          parseLockOwner(observedOwnerBytes, linkedIdentity);
          remainingBudget(budget);
          const ownerIdentity = identity(await ownerHandle.stat({ bigint: true }));
          const ownerPathIdentity = identity(await lstat(ownerPath, { bigint: true }));
          if (
            ownerIdentity.nlink !== 2n ||
            ownerIdentity.size !== BigInt(ownerBytes.byteLength) ||
            !hasExactPrivateMode(ownerIdentity, 0o600n) ||
            !sameIdentity(ownerIdentity, ownerPathIdentity) ||
            (await realpath(ownerPath)) !== ownerPath
          ) {
            fail("unsafe-cache", "$lock", "cache lock owner file is unsafe");
          }
          remainingBudget(budget);
          const lock = new CacheWriteLock();
          completeLockHolderAcquisition(holder);
          LOCK_STATES.set(lock, {
            active: true,
            cache: this,
            holder,
            ownerBytes,
            ownerHandle,
            ownerIdentity,
            ownerRelative: selected.relative,
            temporaryRelative,
          });
          ownerHandle = undefined;
          holder = undefined;
          return success(Object.freeze(lock));
        } catch (error) {
          let cleanupError: unknown;
          if (ownerHandle !== undefined) await ownerHandle.close().catch(() => undefined);
          if (holder !== undefined) {
            try {
              await closeLockHolder(holder, budget);
            } catch (selected) {
              cleanupError ??= selected;
            }
          }
          if (cleanupError !== undefined) {
            if (error instanceof CacheFailure) throw error;
            if (cleanupError instanceof Error) throw cleanupError;
            fail("io-failure", "$lock", "cache lock cleanup failed closed");
          }
          if (nodeCode(error) !== "EEXIST" && !(error instanceof LockBusy)) throw error;
          if (attempt === options.maxAttempts)
            fail("lock-timeout", "$lock", "cache write lock remained busy");
          await withinAcquisitionBudget(() => this.#hooks.beforeLockRetryWait?.(attempt), budget);
          remainingBudget(budget);
          try {
            await wait(Math.min(options.retryDelayMs, remainingBudget(budget)), undefined, {
              signal: options.signal,
            });
          } catch {
            fail("cancelled", "$lock", "cache lock acquisition was cancelled");
          }
        }
      }
      fail("lock-timeout", "$lock", "cache write lock remained busy");
    } catch (error) {
      return failure(error);
    }
  }

  async storeEntry(
    lock: unknown,
    candidateInput: unknown,
  ): Promise<StandardsCacheResult<StandardsCacheEntry>> {
    try {
      await this.#requireLock(lock);
      const candidate = validateCandidate(candidateInput);
      await this.#verifyLayout();
      const relative = entryRelative(candidate);
      const parentRelative = path.posix.dirname(relative);
      await this.#ensureDirectory(parentRelative);
      const finalPath = this.#absolute(relative);
      try {
        await lstat(finalPath);
        fail("entry-exists", "$entry", "cache entry already exists and was preserved");
      } catch (error) {
        if (error instanceof CacheFailure) throw error;
        if (nodeCode(error) !== "ENOENT") throw error;
      }
      const temporaryRelative = `temporary/${candidate.kind}-${candidate.sha256}.partial`;
      const temporaryPath = this.#absolute(temporaryRelative);
      const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
      const handle = await open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
        0o600,
      );
      let temporaryIdentity: StatIdentity;
      try {
        await handle.chmod(0o600);
        await handle.writeFile(candidate.bytes);
        await handle.sync();
        await this.#hooks.afterTemporaryWrite?.(temporaryPath);
        temporaryIdentity = identity(await handle.stat({ bigint: true }));
        if (temporaryIdentity.nlink !== 1n || temporaryIdentity.size !== BigInt(candidate.length))
          fail("concurrent-change", "$entry", "temporary cache entry changed while writing");
      } finally {
        await handle.close();
      }
      await this.#hooks.beforePublish?.(temporaryPath, finalPath);
      const beforePublish = await lstat(temporaryPath, { bigint: true });
      if (
        beforePublish.dev !== temporaryIdentity.dev ||
        beforePublish.ino !== temporaryIdentity.ino ||
        beforePublish.nlink !== 1n
      )
        fail("concurrent-change", "$entry", "temporary cache entry identity changed");
      await this.#requireLock(lock);
      await link(temporaryPath, finalPath);
      await this.#hooks.afterPublishLink?.(temporaryPath, finalPath);
      const afterLink = identity(await lstat(temporaryPath, { bigint: true }));
      if (
        afterLink.dev !== temporaryIdentity.dev ||
        afterLink.ino !== temporaryIdentity.ino ||
        afterLink.nlink !== 2n
      )
        fail("concurrent-change", "$entry", "temporary cache entry changed during publication");
      await unlink(temporaryPath);
      await this.#hooks.afterPublishUnlink?.(finalPath);
      const published = identity(await lstat(finalPath, { bigint: true }));
      if (
        published.dev !== temporaryIdentity.dev ||
        published.ino !== temporaryIdentity.ino ||
        published.nlink !== 1n ||
        !hasExactPrivateMode(published, 0o600n)
      )
        fail("concurrent-change", "$entry", "published cache entry identity changed");
      const stored = await this.#readExact(relative, candidate, true);
      return success(Object.freeze({ ...candidate, bytes: stored.bytes }));
    } catch (error) {
      return failure(error);
    }
  }

  async quarantineCorruptEntry(
    lock: unknown,
    requestInput: unknown,
  ): Promise<StandardsCacheResult<StandardsCacheQuarantineRecord>> {
    try {
      await this.#requireLock(lock);
      const request = validateEntryRequest(requestInput);
      await this.#verifyLayout();
      const sourceRelative = entryRelative(request);
      let read: ExactRead;
      try {
        read = await this.#readExact(sourceRelative, request, false);
      } catch (error) {
        if (nodeCode(error) === "ENOENT") fail("cache-miss", "$entry", "cache entry is absent");
        throw error;
      }
      const observedSha256 = digest(read.bytes);
      if (observedSha256 === request.sha256)
        fail("invalid-input", "$entry", "valid cache entries cannot be quarantined");
      await this.#assertQuarantineCapacity();
      await this.#requireLock(lock);
      const name = `${request.kind}-sha256-${request.sha256}-${observedSha256}.corrupt`;
      const destinationRelative = `quarantine/${name}`;
      const destination = this.#absolute(destinationRelative);
      const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
      try {
        const output = await open(
          destination,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
          0o600,
        );
        let outputIdentity: StatIdentity;
        try {
          await output.chmod(0o600);
          await output.writeFile(read.bytes);
          await output.sync();
          await this.#hooks.afterQuarantineWrite?.(destination);
          outputIdentity = identity(await output.stat({ bigint: true }));
          if (
            outputIdentity.nlink !== 1n ||
            outputIdentity.size !== BigInt(read.bytes.length) ||
            !hasExactPrivateMode(outputIdentity, 0o600n)
          )
            fail("concurrent-change", "$quarantine", "quarantine entry changed while writing");
        } finally {
          await output.close();
        }
        const outputPath = identity(await lstat(destination, { bigint: true }));
        if (
          !sameIdentity(outputIdentity, outputPath) ||
          (await realpath(destination)) !== destination
        )
          fail("concurrent-change", "$quarantine", "quarantine entry path changed while writing");
      } catch (error) {
        if (nodeCode(error) !== "EEXIST") throw error;
        const existing = await this.#readQuarantine(destination, read.bytes.length);
        if (digest(existing) !== observedSha256)
          fail("unsafe-cache", "$quarantine", "quarantine collision contains different bytes");
      }
      const source = this.#absolute(sourceRelative);
      await this.#hooks.beforeQuarantineSourceRemove?.(source);
      await this.#requireLock(lock);
      const sourceBefore = await lstat(source, { bigint: true });
      if (
        !sourceBefore.isFile() ||
        sourceBefore.isSymbolicLink() ||
        !sameIdentity(identity(sourceBefore), read.identity)
      )
        fail("concurrent-change", "$entry", "corrupt cache entry changed before quarantine");
      await unlink(source);
      return success(
        Object.freeze({
          contractVersion: STANDARDS_CACHE_CONTRACT_VERSION,
          expectedSha256: request.sha256,
          kind: request.kind,
          observedSha256,
          path: destinationRelative,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  }

  async #readQuarantine(absolute: string, length: number): Promise<Uint8Array> {
    const stats = await lstat(absolute, { bigint: true });
    const before = identity(stats);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1n ||
      stats.size !== BigInt(length) ||
      !hasExactPrivateMode(before, 0o600n)
    )
      fail("unsafe-cache", "$quarantine", "quarantine entry is unsafe");
    const resolved = await realpath(absolute);
    if (resolved !== absolute || !contained(this.#root, resolved))
      fail("unsafe-cache", "$quarantine", "quarantine entry resolves outside its root");
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
    let bytes: Uint8Array;
    let openedAfter: StatIdentity;
    try {
      const openedBefore = identity(await handle.stat({ bigint: true }));
      if (!sameIdentity(before, openedBefore))
        fail("concurrent-change", "$quarantine", "quarantine entry changed before reading");
      bytes = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const read = await handle.read(bytes, offset, length - offset, offset);
        if (read.bytesRead === 0)
          fail("concurrent-change", "$quarantine", "quarantine entry changed");
        offset += read.bytesRead;
      }
      if ((await handle.read(new Uint8Array(1), 0, 1, length)).bytesRead !== 0)
        fail("concurrent-change", "$quarantine", "quarantine entry grew while reading");
      openedAfter = identity(await handle.stat({ bigint: true }));
      if (!sameIdentity(openedBefore, openedAfter))
        fail("concurrent-change", "$quarantine", "quarantine entry changed while reading");
    } finally {
      await handle.close();
    }
    const afterPath = identity(await lstat(absolute, { bigint: true }));
    if (!sameIdentity(openedAfter, afterPath) || (await realpath(absolute)) !== resolved)
      fail("concurrent-change", "$quarantine", "quarantine entry path changed while reading");
    return bytes;
  }

  async #assertQuarantineCapacity(): Promise<void> {
    const directory = await opendir(this.#absolute("quarantine"));
    let count = 0;
    try {
      for await (const entry of directory) {
        count += 1;
        if (count >= MAX_STANDARDS_CACHE_QUARANTINE_ENTRIES)
          fail("quarantine-full", "$quarantine", "cache quarantine reached its entry limit");
        if (!entry.isFile() || entry.isSymbolicLink() || entry.name.length > 256)
          fail("unsafe-cache", "$quarantine", "cache quarantine contains an unsafe entry");
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  async #lockGenerationNames(budget: AcquisitionBudget): Promise<Set<string>> {
    remainingBudget(budget);
    const directory = await opendir(this.#absolute("locks"));
    const generations = new Set<string>();
    try {
      for await (const entry of directory) {
        remainingBudget(budget);
        if (entry.name !== "writer.v0.json" && !LOCK_GENERATION_NAME.test(entry.name))
          fail("unsafe-cache", "$lock", "cache lock directory contains an unsafe entry");
        if (!entry.isFile() || entry.isSymbolicLink())
          fail("unsafe-cache", "$lock", "cache lock generation must be an ordinary file");
        generations.add(entry.name);
        if (generations.size > MAX_STANDARDS_CACHE_RELEASE_CLAIMS + 1)
          fail("resource-limit", "$lock", "cache lock generations reached their entry limit");
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return generations;
  }

  async #validateLockTemporaryDebris(
    budget: AcquisitionBudget,
    generations: ReadonlySet<string>,
  ): Promise<LockTemporarySnapshot> {
    const generationIdentities = new Map<string, string>();
    for (const generation of generations) {
      remainingBudget(budget);
      const selected = identity(
        await lstat(this.#absolute(`locks/${generation}`), { bigint: true }),
      );
      const key = objectIdentityKey(selected);
      if (generationIdentities.has(key))
        fail("unsafe-cache", "$lock", "multiple cache generations alias one inode");
      generationIdentities.set(key, generation);
    }
    const directory = await opendir(this.#absolute("temporary"));
    let legacyClaims = 0;
    const authorities = new Map<string, LockGenerationAuthority>();
    const occupiedSlots = new Set<number>();
    const assertClaimCapacity = (): void => {
      if (legacyClaims + occupiedSlots.size > MAX_STANDARDS_CACHE_RELEASE_CLAIMS + 1)
        fail("resource-limit", "$lock", "cache lock temporary debris reached its entry limit");
    };
    const validateAuthority = async (relative: string, name: string): Promise<void> => {
      const temporaryAuthority = parseLockTemporaryName(name);
      const temporaryPath = this.#absolute(relative);
      const stats = await lstat(temporaryPath, { bigint: true });
      const selected = identity(stats);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        (selected.nlink !== 1n && selected.nlink !== 2n) ||
        !hasExactPrivateMode(selected, 0o600n) ||
        selected.size < 1n ||
        selected.size > 1_024n ||
        (await realpath(temporaryPath)) !== temporaryPath
      )
        fail("unsafe-cache", "$lock", "cache lock temporary debris is unsafe");
      if (selected.nlink === 2n) {
        const key = objectIdentityKey(selected);
        if (!generationIdentities.has(key) || authorities.has(key))
          fail("unsafe-cache", "$lock", "cache lock temporary has no authoritative generation");
        authorities.set(key, { identity: selected, record: temporaryAuthority, relative });
      }
    };
    try {
      for await (const entry of directory) {
        remainingBudget(budget);
        if (entry.name.startsWith("lock-owner-slot-")) {
          const match = LOCK_OWNER_SLOT_NAME.exec(entry.name);
          const slotText = match?.[1];
          if (slotText === undefined || !entry.isDirectory() || entry.isSymbolicLink())
            fail("unsafe-cache", "$lock", "cache lock authority slot is malformed");
          const slot = Number(slotText);
          if (slot > MAX_STANDARDS_CACHE_RELEASE_CLAIMS || occupiedSlots.has(slot))
            fail("unsafe-cache", "$lock", "cache lock authority slot is malformed");
          occupiedSlots.add(slot);
          assertClaimCapacity();
          const slotRelative = `temporary/${entry.name}`;
          await this.#verifyDirectory(slotRelative);
          const slotDirectory = await opendir(this.#absolute(slotRelative));
          let selectedName: string | undefined;
          try {
            for await (const nested of slotDirectory) {
              remainingBudget(budget);
              if (selectedName !== undefined || !nested.isFile() || nested.isSymbolicLink())
                fail("unsafe-cache", "$lock", "cache lock authority slot is unsafe");
              selectedName = nested.name;
            }
          } finally {
            await slotDirectory.close().catch(() => undefined);
          }
          if (selectedName !== undefined)
            await validateAuthority(`${slotRelative}/${selectedName}`, selectedName);
          continue;
        }
        if (!entry.name.startsWith("lock-owner-")) continue;
        if (!entry.isFile() || entry.isSymbolicLink())
          fail("unsafe-cache", "$lock", "cache lock temporary debris is unsafe");
        legacyClaims += 1;
        assertClaimCapacity();
        await validateAuthority(`temporary/${entry.name}`, entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    for (const slot of occupiedSlots)
      if (slot < legacyClaims)
        fail("unsafe-cache", "$lock", "cache lock authority slots overlap legacy claims");
    return { authorities, legacyClaims, occupiedSlots };
  }

  async #reserveLockAuthoritySlot(
    snapshot: LockTemporarySnapshot,
    budget: AcquisitionBudget,
  ): Promise<string> {
    for (let slot = snapshot.legacyClaims; slot <= MAX_STANDARDS_CACHE_RELEASE_CLAIMS; slot += 1) {
      if (snapshot.occupiedSlots.has(slot)) continue;
      const name = `lock-owner-slot-${slot.toString().padStart(2, "0")}`;
      const relative = `temporary/${name}`;
      try {
        await mkdir(this.#absolute(relative), { mode: 0o700 });
      } catch (error) {
        if (nodeCode(error) === "EEXIST") continue;
        throw error;
      }
      remainingBudget(budget);
      await this.#verifyDirectory(relative);
      return relative;
    }
    fail("resource-limit", "$lock", "cache lock generations reached their entry limit");
  }

  async #readLockOwner(
    ownerRelative: string,
    budget: AcquisitionBudget,
    authorities: ReadonlyMap<string, LockGenerationAuthority>,
  ): Promise<LockOwnerRecord> {
    remainingBudget(budget);
    const ownerPath = this.#absolute(ownerRelative);
    const beforeStats = await lstat(ownerPath, { bigint: true });
    const before = identity(beforeStats);
    if (
      !beforeStats.isFile() ||
      beforeStats.isSymbolicLink() ||
      (before.nlink !== 1n && before.nlink !== 2n) ||
      !hasExactPrivateMode(before, 0o600n) ||
      before.size < 1n ||
      before.size > 1_024n ||
      (await realpath(ownerPath)) !== ownerPath
    )
      fail("unsafe-cache", "$lock", "cache lock owner file is unsafe");
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(ownerPath, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = identity(await handle.stat({ bigint: true }));
      if (!sameIdentity(before, opened))
        fail("concurrent-change", "$lock", "cache lock owner changed before reading");
      const bytes = new Uint8Array(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0)
          fail("concurrent-change", "$lock", "cache lock owner was truncated while reading");
        offset += result.bytesRead;
      }
      if ((await handle.read(new Uint8Array(1), 0, 1, bytes.length)).bytesRead !== 0)
        fail("concurrent-change", "$lock", "cache lock owner grew while reading");
      remainingBudget(budget);
      const finalOpen = identity(await handle.stat({ bigint: true }));
      const finalPath = identity(await lstat(ownerPath, { bigint: true }));
      if (
        !sameIdentity(opened, finalOpen) ||
        !sameIdentity(finalOpen, finalPath) ||
        (await realpath(ownerPath)) !== ownerPath
      )
        fail("concurrent-change", "$lock", "cache lock owner changed while reading");
      const authority = authorities.get(objectIdentityKey(finalOpen));
      if (authority !== undefined) {
        /* v8 ignore next -- only an external metadata race can change a snapshotted inode here. */
        if (!sameIdentity(authority.identity, finalOpen))
          fail("unsafe-cache", "$lock", "cache lock generation authority is inconsistent");
        const authorityPath = this.#absolute(authority.relative);
        if (
          !sameIdentity(identity(await lstat(authorityPath, { bigint: true })), finalOpen) ||
          (await realpath(authorityPath)) !== authorityPath
        )
          /* v8 ignore next -- this closes the final unhooked pathname race after the snapshot. */
          fail("concurrent-change", "$lock", "cache lock generation authority changed");
      }
      let record: LockOwnerRecord | undefined;
      try {
        record = parseLockOwner(bytes, opened);
      } catch (error) {
        /* v8 ignore next -- parseLockOwner exposes only the closed CacheFailure type. */
        if (!(error instanceof CacheFailure)) throw error;
      }
      if (authority !== undefined) return authority.record;
      if (record === undefined || finalOpen.nlink !== 1n)
        fail("unsafe-cache", "$lock", "cache lock generation has no recoverable authority");
      return record;
    } finally {
      await handle.close();
    }
  }

  async #selectLockSlot(budget: AcquisitionBudget): Promise<{
    readonly relative: string;
    readonly temporaryDirectoryRelative: string;
  }> {
    const generations = await this.#lockGenerationNames(budget);
    const snapshot = await this.#validateLockTemporaryDebris(budget, generations);
    const visited = new Set<string>();
    let relative = INITIAL_LOCK_GENERATION;
    for (;;) {
      remainingBudget(budget);
      try {
        const generationName = path.posix.basename(relative);
        if (visited.has(generationName))
          fail("unsafe-cache", "$lock", "cache lock ownership chain contains a cycle");
        const record = await this.#readLockOwner(relative, budget, snapshot.authorities);
        visited.add(generationName);
        if ((await probeLockHolder(record, budget)) !== "dead") {
          if (generations.size !== visited.size)
            fail("unsafe-cache", "$lock", "cache lock generations are not one exact chain");
          if (generations.size >= MAX_STANDARDS_CACHE_RELEASE_CLAIMS + 1)
            fail("resource-limit", "$lock", "cache lock generations reached their entry limit");
          throw new LockBusy();
        }
        relative = `locks/.writer.generation-${record.nextToken}.v0.json`;
      } catch (error) {
        if (nodeCode(error) !== "ENOENT") throw error;
        if (generations.size !== visited.size)
          fail("unsafe-cache", "$lock", "cache lock generations are not one exact chain");
        if (
          generations.size >= MAX_STANDARDS_CACHE_RELEASE_CLAIMS + 1 &&
          relative !== INITIAL_LOCK_GENERATION
        )
          fail("resource-limit", "$lock", "cache lock generations reached their entry limit");
        remainingBudget(budget);
        return {
          relative,
          temporaryDirectoryRelative: await this.#reserveLockAuthoritySlot(snapshot, budget),
        };
      }
    }
  }

  async #ensureDirectory(relative: string): Promise<void> {
    const segments = relative.split("/");
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      const absolute = this.#absolute(current);
      try {
        await mkdir(absolute, { mode: 0o700 });
      } catch (error) {
        if (nodeCode(error) !== "EEXIST") throw error;
      }
      await this.#verifyDirectory(current);
    }
  }

  async #requireLock(value: unknown): Promise<void> {
    if (value === null || typeof value !== "object")
      fail("lock-invalid", "$lock", "an active cache lock capability is required");
    const state = LOCK_STATES.get(value);
    if (state === undefined || !state.active || state.cache !== this)
      fail("lock-invalid", "$lock", "an active cache lock capability is required");
    await this.#verifyLockIdentity(state);
  }

  async #verifyLockIdentity(state: LockState, requireLiveHolder = true): Promise<void> {
    const ownerPath = this.#absolute(state.ownerRelative);
    const temporaryPath = this.#absolute(state.temporaryRelative);
    const ownerOpen = identity(await state.ownerHandle.stat({ bigint: true }));
    const ownerPathStat = await lstat(ownerPath, { bigint: true });
    const selectedOwner = identity(ownerPathStat);
    if (
      (requireLiveHolder && !state.holder.server.listening) ||
      !ownerPathStat.isFile() ||
      ownerPathStat.isSymbolicLink() ||
      !sameIdentity(ownerOpen, state.ownerIdentity) ||
      !sameIdentity(selectedOwner, state.ownerIdentity) ||
      !sameIdentity(identity(await lstat(temporaryPath, { bigint: true })), state.ownerIdentity) ||
      !hasExactPrivateMode(selectedOwner, 0o600n) ||
      selectedOwner.size !== BigInt(state.ownerBytes.byteLength) ||
      (await realpath(ownerPath)) !== ownerPath ||
      (await realpath(temporaryPath)) !== temporaryPath
    )
      fail("concurrent-change", "$lock", "cache lock identity changed");
    const observed = new Uint8Array(state.ownerBytes.byteLength);
    let offset = 0;
    while (offset < observed.length) {
      const result = await state.ownerHandle.read(
        observed,
        offset,
        observed.length - offset,
        offset,
      );
      if (result.bytesRead === 0)
        fail("concurrent-change", "$lock", "cache lock owner bytes changed");
      offset += result.bytesRead;
    }
    if (
      (await state.ownerHandle.read(new Uint8Array(1), 0, 1, observed.length)).bytesRead !== 0 ||
      !Buffer.from(observed).equals(Buffer.from(state.ownerBytes)) ||
      !sameIdentity(identity(await state.ownerHandle.stat({ bigint: true })), state.ownerIdentity)
    )
      fail("concurrent-change", "$lock", "cache lock owner bytes changed");
  }

  async #releaseLock(value: object): Promise<StandardsCacheResult<Readonly<{ released: true }>>> {
    const state = LOCK_STATES.get(value);
    if (state === undefined || !state.active || state.cache !== this)
      return failure(new CacheFailure("lock-invalid", "$lock", "cache lock is not active"));
    state.active = false;
    try {
      const ownerPath = this.#absolute(state.ownerRelative);
      await this.#verifyLockIdentity(state);
      await this.#hooks.beforeLockOwnerRelease?.(ownerPath);
      await closeLockHolder(state.holder);
      await this.#verifyLockIdentity(state, false);
      return success(Object.freeze({ released: true as const }));
    } catch (error) {
      return failure(error);
    } finally {
      await state.ownerHandle.close().catch(() => undefined);
    }
  }
}

class CacheWriteLock implements StandardsCacheWriteLock {
  readonly contractVersion = STANDARDS_CACHE_CONTRACT_VERSION;

  async release(): Promise<StandardsCacheResult<Readonly<{ released: true }>>> {
    const state = LOCK_STATES.get(this);
    if (state === undefined)
      return failure(new CacheFailure("lock-invalid", "$lock", "cache lock is not active"));
    return releaseStandardsCacheLock(state.cache, this);
  }
}

async function initializeRoot(root: string): Promise<StatIdentity> {
  const parent = path.dirname(root);
  if ((await realpath(parent)) !== parent)
    fail("unsafe-cache", "$root", "cache root parent resolves through a link");
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (nodeCode(error) !== "EEXIST") throw error;
  }
  const stats = await lstat(root, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(root)) !== root)
    fail("unsafe-cache", "$root", "cache root must be a canonical real directory");
  const selected = identity(stats);
  if (!hasExactPrivateMode(selected, 0o700n))
    fail("unsafe-cache", "$root", "cache root directory permissions are not private");
  return selected;
}

async function openCache(
  rootInput: unknown,
  hooks: CacheHooks,
): Promise<StandardsCacheResult<StandardsCache>> {
  try {
    if (
      typeof rootInput !== "string" ||
      rootInput.length === 0 ||
      rootInput.length > 4_096 ||
      rootInput.includes("\0") ||
      !path.isAbsolute(rootInput) ||
      path.resolve(rootInput) !== rootInput ||
      path.parse(rootInput).root === rootInput
    )
      fail("invalid-input", "$root", "cache root must be a bounded canonical absolute path");
    const rootIdentity = await initializeRoot(rootInput);
    const versionRoot = path.join(rootInput, STANDARDS_CACHE_LAYOUT_VERSION);
    for (const relative of ["", ...LAYOUT_DIRECTORIES]) {
      const absolute =
        relative === "" ? versionRoot : path.join(versionRoot, ...relative.split("/"));
      try {
        await mkdir(absolute, { mode: 0o700 });
      } catch (error) {
        if (nodeCode(error) !== "EEXIST") throw error;
      }
      const stats = await lstat(absolute, { bigint: true });
      if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(absolute)) !== absolute)
        fail("unsafe-cache", "$cache", "cache layout contains an unsafe directory");
      if (!hasExactPrivateMode(identity(stats), 0o700n))
        fail("unsafe-cache", "$cache", "cache layout directory permissions are not private");
    }
    const cache = constructStandardsCache(rootInput, rootIdentity, hooks);
    return success(cache);
  } catch (error) {
    return failure(error);
  }
}

/** @internal Fault-injection entry point; not exported from the package root. */
export async function openStandardsCacheFixtureForTest(
  rootInput: unknown,
  hooks: CacheHooks,
): Promise<StandardsCacheResult<StandardsCache>> {
  return openCache(rootInput, hooks);
}
