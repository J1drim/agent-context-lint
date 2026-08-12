import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { types as nodeTypes } from "node:util";

import {
  canonicalizeRepositoryRelativePath,
  repositoryRelativePathToAbsolute,
} from "@agent-context/core";
import type { PathFlavor, RepositoryRelativePath } from "@agent-context/core";

import type { RepositoryRootSelection } from "./repository-root.js";

export const ATOMIC_WRITER_CONTRACT_VERSION = "0.1.0" as const;
export const ATOMIC_WRITER_DEFAULT_MAXIMUM_BYTES = 16_777_216;
export const ATOMIC_WRITER_HARD_MAXIMUM_BYTES = 67_108_864;
export const ATOMIC_WRITER_DEFAULT_TEMPORARY_ATTEMPTS = 16;
export const ATOMIC_WRITER_HARD_TEMPORARY_ATTEMPTS = 64;

export const AtomicWriteErrorCode: Readonly<{
  aborted: "ATOMIC_WRITE_ABORTED";
  cleanupFailed: "ATOMIC_WRITE_CLEANUP_FAILED";
  concurrentChange: "ATOMIC_WRITE_CONCURRENT_CHANGE";
  durabilityFailed: "ATOMIC_WRITE_DURABILITY_FAILED";
  invalidInput: "ATOMIC_WRITE_INVALID_INPUT";
  invalidSelection: "ATOMIC_WRITE_INVALID_SELECTION";
  ioFailed: "ATOMIC_WRITE_IO_FAILED";
  readOnly: "ATOMIC_WRITE_READ_ONLY";
  resourceLimit: "ATOMIC_WRITE_RESOURCE_LIMIT";
  temporaryCollision: "ATOMIC_WRITE_TEMPORARY_COLLISION";
  unsafePath: "ATOMIC_WRITE_UNSAFE_PATH";
  unsafeType: "ATOMIC_WRITE_UNSAFE_TYPE";
}> = Object.freeze({
  aborted: "ATOMIC_WRITE_ABORTED",
  cleanupFailed: "ATOMIC_WRITE_CLEANUP_FAILED",
  concurrentChange: "ATOMIC_WRITE_CONCURRENT_CHANGE",
  durabilityFailed: "ATOMIC_WRITE_DURABILITY_FAILED",
  invalidInput: "ATOMIC_WRITE_INVALID_INPUT",
  invalidSelection: "ATOMIC_WRITE_INVALID_SELECTION",
  ioFailed: "ATOMIC_WRITE_IO_FAILED",
  readOnly: "ATOMIC_WRITE_READ_ONLY",
  resourceLimit: "ATOMIC_WRITE_RESOURCE_LIMIT",
  temporaryCollision: "ATOMIC_WRITE_TEMPORARY_COLLISION",
  unsafePath: "ATOMIC_WRITE_UNSAFE_PATH",
  unsafeType: "ATOMIC_WRITE_UNSAFE_TYPE",
} as const);

export type AtomicWriteErrorCode = (typeof AtomicWriteErrorCode)[keyof typeof AtomicWriteErrorCode];
export type AtomicWriteDurability = "file-and-directory" | "file-only";

export interface AtomicWriteExpectedIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface AtomicWriteExpectedState {
  readonly identity: AtomicWriteExpectedIdentity;
  readonly sha256: string;
}

export interface AtomicWriteRequest {
  readonly expected: AtomicWriteExpectedState;
  readonly path: RepositoryRelativePath;
  readonly replacement: Uint8Array;
}

export interface AtomicWriteOptions {
  readonly maximumBytes?: number;
  readonly maximumTemporaryAttempts?: number;
  readonly signal?: AbortSignal;
}

export interface AtomicWriteResult {
  readonly bytesWritten: number;
  readonly contractVersion: typeof ATOMIC_WRITER_CONTRACT_VERSION;
  readonly directorySync: "synced" | "unsupported";
  readonly durability: AtomicWriteDurability;
  /** Device/inode identity of the atomically published replacement. */
  readonly identity: AtomicWriteExpectedIdentity;
  readonly mode: number;
  readonly path: RepositoryRelativePath;
  readonly previousSha256: string;
  readonly sha256: string;
}

/** A typed failure that never exposes absolute or temporary paths. */
export class AtomicWriteError extends Error {
  override readonly name = "AtomicWriteError" as const;
  readonly causeCode: string | undefined;
  readonly code: AtomicWriteErrorCode;
  /** True only when the atomic replacement occurred before a later durability/cleanup failure. */
  readonly committed: boolean;
  readonly operation: string;
  readonly path: RepositoryRelativePath | undefined;

  constructor(
    code: AtomicWriteErrorCode,
    message: string,
    operation: string,
    committed: boolean,
    pathValue?: RepositoryRelativePath,
    causeCode?: string,
  ) {
    super(message);
    this.causeCode = causeCode;
    this.code = code;
    this.committed = committed;
    this.operation = operation;
    this.path = pathValue;
    Object.freeze(this);
  }
}

export interface AtomicWriterFileHandle {
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  stat(options: { readonly bigint: true }): Promise<BigIntStats>;
  sync(): Promise<void>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesWritten: number }>;
}

/** Injectable only so crash, race, and platform behavior can be tested without unsafe monkeypatches. */
export interface AtomicWriterFileSystemCapability {
  lstat(target: string): Promise<BigIntStats>;
  open(target: string, flags: number, mode?: number): Promise<AtomicWriterFileHandle>;
  readonly platform: NodeJS.Platform;
  randomToken(): string;
  realpath(target: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  unlink(target: string): Promise<void>;
}

/** @internal Fault-injection points. Hooks run before the named safety revalidation. */
export interface AtomicWriterTestHooks {
  readonly afterTemporarySync?: (targetPath: string) => Promise<void> | void;
  readonly beforeCommitValidation?: (targetPath: string) => Promise<void> | void;
  readonly beforeDirectorySync?: (directoryPath: string) => Promise<void> | void;
  readonly beforeRename?: (targetPath: string) => Promise<void> | void;
}

export interface AtomicRepositoryWriter {
  readonly contractVersion: typeof ATOMIC_WRITER_CONTRACT_VERSION;
  readonly maximumBytes: number;
  readonly root: string;
  write(request: unknown): Promise<AtomicWriteResult>;
}

interface WriterOptionsSnapshot {
  readonly maximumBytes: number;
  readonly maximumTemporaryAttempts: number;
  readonly signal?: AbortSignal;
}

interface StatSnapshot {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
}

interface ValidatedRequest {
  readonly expectedDevice: string;
  readonly expectedInode: string;
  readonly expectedSha256: string;
  readonly path: RepositoryRelativePath;
  readonly replacement: Uint8Array;
  readonly replacementSha256: string;
}

interface OpenArtifact {
  readonly absolutePath: string;
  readonly handle: AtomicWriterFileHandle;
  readonly snapshot: StatSnapshot;
}

interface TargetObservation {
  readonly digest: string;
  readonly mode: number;
  readonly snapshot: StatSnapshot;
}

const DEFAULT_FILE_SYSTEM: AtomicWriterFileSystemCapability = Object.freeze({
  lstat: async (target: string): Promise<BigIntStats> => lstat(target, { bigint: true }),
  open: async (target: string, flags: number, mode?: number): Promise<FileHandle> =>
    open(target, flags, mode),
  platform: process.platform,
  randomToken: (): string => randomBytes(16).toString("hex"),
  realpath: async (target: string): Promise<string> => realpath(target),
  rename: async (source: string, destination: string): Promise<void> => rename(source, destination),
  unlink: async (target: string): Promise<void> => unlink(target),
});

const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL_IDENTITY = /^(?:0|[1-9][0-9]{0,63})$/u;
const TEMPORARY_TOKEN = /^[a-zA-Z0-9_-]{8,128}$/u;
type IntrinsicGetter = (this: unknown) => unknown;
type IntrinsicFunction = (this: unknown, ...arguments_: readonly unknown[]) => unknown;

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
const ABORTED_GETTER = requireGetter(AbortSignal.prototype, "aborted");
const TYPED_ARRAY_BYTE_LENGTH = requireGetter(TYPED_ARRAY_PROTOTYPE, "byteLength");
const TYPED_ARRAY_BUFFER = requireGetter(TYPED_ARRAY_PROTOTYPE, "buffer");
const UINT8_ARRAY_SLICE = requireFunction(TYPED_ARRAY_PROTOTYPE, "slice");
const intrinsicAbortedGetter = (value: unknown): unknown =>
  Reflect.apply(ABORTED_GETTER, value, []);
const intrinsicByteLength = (value: unknown): unknown =>
  Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []);
const intrinsicBuffer = (value: unknown): unknown => Reflect.apply(TYPED_ARRAY_BUFFER, value, []);
const intrinsicUint8ArraySlice = (value: unknown): Uint8Array => {
  const result: unknown = Reflect.apply(UINT8_ARRAY_SLICE, value, [0]);
  if (!nodeTypes.isUint8Array(result)) throw new TypeError("byte copy failed");
  return result;
};

function fail(
  code: AtomicWriteErrorCode,
  message: string,
  operation: string,
  committed: boolean,
  pathValue?: RepositoryRelativePath,
  causeCode?: string,
): never {
  throw new AtomicWriteError(code, message, operation, committed, pathValue, causeCode);
}

function nodeErrorCode(error: unknown): string | undefined {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function") ||
    nodeTypes.isProxy(error)
  )
    return undefined;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(error, "code");
    const value: unknown =
      descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function wrapIoFailure(
  error: unknown,
  operation: string,
  committed: boolean,
  pathValue?: RepositoryRelativePath,
): AtomicWriteError {
  if (error instanceof AtomicWriteError) return error;
  return new AtomicWriteError(
    AtomicWriteErrorCode.ioFailed,
    "atomic write filesystem operation failed closed",
    operation,
    committed,
    pathValue,
    nodeErrorCode(error),
  );
}

async function ignoreRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Cleanup is best effort only when a stronger typed failure is already being preserved.
  }
}

function ownData(
  value: unknown,
  keys: readonly string[],
  operation: string,
  errorCode: AtomicWriteErrorCode = AtomicWriteErrorCode.invalidInput,
): Map<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    fail(errorCode, "input must be a plain data object", operation, false);
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    fail(errorCode, "input object could not be inspected", operation, false);
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail(errorCode, "input fields do not match the closed contract", operation, false);
  const result = new Map<string, unknown>();
  for (const key of ownKeys as readonly string[]) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(errorCode, "input field could not be inspected", operation, false);
    }
    if (descriptor === undefined || !("value" in descriptor))
      fail(errorCode, "input must contain only data properties", operation, false);
    result.set(key, descriptor.value as unknown);
  }
  return result;
}

function copyReplacement(value: unknown, maximumBytes: number): Uint8Array {
  if (nodeTypes.isProxy(value) || !nodeTypes.isUint8Array(value))
    fail(
      AtomicWriteErrorCode.invalidInput,
      "replacement must be a non-proxy byte array",
      "validate-request",
      false,
    );
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
    fail(
      AtomicWriteErrorCode.invalidInput,
      "replacement byte view is unsupported",
      "validate-request",
      false,
    );
  let length: number;
  let buffer: ArrayBufferLike;
  try {
    length = intrinsicByteLength(value) as number;
    buffer = intrinsicBuffer(value) as ArrayBufferLike;
  } catch {
    fail(
      AtomicWriteErrorCode.invalidInput,
      "replacement byte array is invalid",
      "validate-request",
      false,
    );
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes)
    fail(
      AtomicWriteErrorCode.resourceLimit,
      "replacement exceeds the byte limit",
      "validate-request",
      false,
    );
  if (nodeTypes.isSharedArrayBuffer(buffer))
    fail(
      AtomicWriteErrorCode.invalidInput,
      "shared replacement buffers are not accepted",
      "validate-request",
      false,
    );
  try {
    return intrinsicUint8ArraySlice(value);
  } catch {
    fail(
      AtomicWriteErrorCode.invalidInput,
      "replacement byte array could not be copied",
      "validate-request",
      false,
    );
  }
}

function validateRequest(value: unknown, options: WriterOptionsSnapshot): ValidatedRequest {
  const request = ownData(value, ["expected", "path", "replacement"], "validate-request");
  const expected = ownData(request.get("expected"), ["identity", "sha256"], "validate-request");
  const identity = ownData(expected.get("identity"), ["device", "inode"], "validate-request");
  const expectedDevice = identity.get("device");
  const expectedInode = identity.get("inode");
  const expectedSha256 = expected.get("sha256");
  if (typeof expectedDevice !== "string" || !DECIMAL_IDENTITY.test(expectedDevice))
    fail(
      AtomicWriteErrorCode.invalidInput,
      "expected device identity is invalid",
      "validate-request",
      false,
    );
  if (typeof expectedInode !== "string" || !DECIMAL_IDENTITY.test(expectedInode))
    fail(
      AtomicWriteErrorCode.invalidInput,
      "expected inode identity is invalid",
      "validate-request",
      false,
    );
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256))
    fail(
      AtomicWriteErrorCode.invalidInput,
      "expected content digest is invalid",
      "validate-request",
      false,
    );
  const rawPath = request.get("path");
  if (typeof rawPath !== "string")
    fail(
      AtomicWriteErrorCode.invalidInput,
      "target path is not canonical and repository-relative",
      "validate-request",
      false,
    );
  let pathValue: RepositoryRelativePath;
  try {
    pathValue = canonicalizeRepositoryRelativePath(rawPath);
  } catch {
    fail(
      AtomicWriteErrorCode.invalidInput,
      "target path is not canonical and repository-relative",
      "validate-request",
      false,
    );
  }
  if (pathValue !== rawPath)
    fail(
      AtomicWriteErrorCode.invalidInput,
      "target path must already use canonical repository-relative spelling",
      "validate-request",
      false,
    );
  if (pathValue === ".")
    fail(
      AtomicWriteErrorCode.invalidInput,
      "repository root is not a writable file target",
      "validate-request",
      false,
    );
  const replacement = copyReplacement(request.get("replacement"), options.maximumBytes);
  return Object.freeze({
    expectedDevice,
    expectedInode,
    expectedSha256,
    path: pathValue,
    replacement,
    replacementSha256: createHash("sha256").update(replacement).digest("hex"),
  });
}

function validateOptions(value: unknown): WriterOptionsSnapshot {
  if (value === undefined)
    return Object.freeze({
      maximumBytes: ATOMIC_WRITER_DEFAULT_MAXIMUM_BYTES,
      maximumTemporaryAttempts: ATOMIC_WRITER_DEFAULT_TEMPORARY_ATTEMPTS,
    });
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    fail(
      AtomicWriteErrorCode.invalidInput,
      "writer options must be a plain data object",
      "validate-options",
      false,
    );
  let ownKeys: readonly PropertyKey[];
  let prototype: object | null;
  try {
    prototype = Reflect.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    fail(
      AtomicWriteErrorCode.invalidInput,
      "writer options could not be inspected",
      "validate-options",
      false,
    );
  }
  if (prototype !== Object.prototype && prototype !== null)
    fail(
      AtomicWriteErrorCode.invalidInput,
      "writer options must be a plain data object",
      "validate-options",
      false,
    );
  const allowed = ["maximumBytes", "maximumTemporaryAttempts", "signal"];
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.includes(key)))
    fail(
      AtomicWriteErrorCode.invalidInput,
      "writer options contain unknown fields",
      "validate-options",
      false,
    );
  const fields = new Map<string, unknown>();
  for (const key of ownKeys as readonly string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      fail(
        AtomicWriteErrorCode.invalidInput,
        "writer options must contain only data properties",
        "validate-options",
        false,
      );
    if (descriptor.value === undefined)
      fail(
        AtomicWriteErrorCode.invalidInput,
        "writer options cannot contain explicit undefined values",
        "validate-options",
        false,
      );
    fields.set(key, descriptor.value as unknown);
  }
  const maximumBytes = fields.get("maximumBytes") ?? ATOMIC_WRITER_DEFAULT_MAXIMUM_BYTES;
  const maximumTemporaryAttempts =
    fields.get("maximumTemporaryAttempts") ?? ATOMIC_WRITER_DEFAULT_TEMPORARY_ATTEMPTS;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    (maximumBytes as number) < 1 ||
    (maximumBytes as number) > ATOMIC_WRITER_HARD_MAXIMUM_BYTES
  )
    fail(
      AtomicWriteErrorCode.invalidInput,
      "writer byte limit is outside its hard bounds",
      "validate-options",
      false,
    );
  if (
    !Number.isSafeInteger(maximumTemporaryAttempts) ||
    (maximumTemporaryAttempts as number) < 1 ||
    (maximumTemporaryAttempts as number) > ATOMIC_WRITER_HARD_TEMPORARY_ATTEMPTS
  )
    fail(
      AtomicWriteErrorCode.invalidInput,
      "temporary attempt limit is outside its hard bounds",
      "validate-options",
      false,
    );
  const signal = fields.get("signal");
  if (signal !== undefined && intrinsicAborted(signal) === undefined)
    fail(
      AtomicWriteErrorCode.invalidInput,
      "writer cancellation signal is invalid",
      "validate-options",
      false,
    );
  return Object.freeze({
    maximumBytes: maximumBytes as number,
    maximumTemporaryAttempts: maximumTemporaryAttempts as number,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  });
}

function intrinsicAborted(signal: unknown): boolean | undefined {
  if (signal === null || typeof signal !== "object" || nodeTypes.isProxy(signal)) return undefined;
  try {
    const value: unknown = intrinsicAbortedGetter(signal);
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function checkAborted(options: WriterOptionsSnapshot, pathValue?: RepositoryRelativePath): void {
  if (options.signal !== undefined && intrinsicAborted(options.signal) === true)
    fail(
      AtomicWriteErrorCode.aborted,
      "atomic write was cancelled before commit",
      "check-cancellation",
      false,
      pathValue,
    );
}

function snapshot(stats: BigIntStats): StatSnapshot {
  return {
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    mtimeNs: stats.mtimeNs,
    nlink: stats.nlink,
    size: stats.size,
  };
}

function sameSnapshot(left: StatSnapshot, right: StatSnapshot): boolean {
  return (
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function sameDirectory(left: StatSnapshot, right: StatSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameIdentity(stats: StatSnapshot, device: string, inode: string): boolean {
  return String(stats.dev) === device && String(stats.ino) === inode;
}

function fileMode(stats: StatSnapshot): number {
  return Number(stats.mode & 0o777n);
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
}

function pathFlavor(platform: NodeJS.Platform): PathFlavor {
  return platform === "win32" ? "win32" : "posix";
}

function temporaryName(
  kind: "lock" | "tmp",
  pathValue: RepositoryRelativePath,
  token?: string,
): string {
  const targetKey = createHash("sha256").update(pathValue).digest("hex").slice(0, 32);
  if (kind === "lock") return `.agent-context-lint-${targetKey}.lock`;
  if (token === undefined) throw new TypeError("temporary token is required");
  return `.agent-context-lint-${targetKey}-${token}.tmp`;
}

function unsupportedDirectorySync(error: unknown, platform: NodeJS.Platform): boolean {
  const code = nodeErrorCode(error);
  if (code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS") return true;
  return platform === "win32" && (code === "EPERM" || code === "EISDIR");
}

class RepositoryAtomicWriter implements AtomicRepositoryWriter {
  readonly contractVersion = ATOMIC_WRITER_CONTRACT_VERSION;
  readonly maximumBytes: number;
  readonly root: string;
  readonly #fileSystem: AtomicWriterFileSystemCapability;
  readonly #flavor: PathFlavor;
  readonly #hooks: AtomicWriterTestHooks;
  readonly #options: WriterOptionsSnapshot;
  readonly #rootIdentity: AtomicWriteExpectedIdentity;

  constructor(
    root: string,
    rootIdentity: AtomicWriteExpectedIdentity,
    options: WriterOptionsSnapshot,
    fileSystem: AtomicWriterFileSystemCapability,
    hooks: AtomicWriterTestHooks,
  ) {
    this.#fileSystem = fileSystem;
    // Path syntax follows the running host. `platform` on the injected capability controls only
    // filesystem semantics so non-Windows CI can exercise Windows durability behavior.
    this.#flavor = pathFlavor(process.platform);
    this.#hooks = hooks;
    this.#options = options;
    this.#rootIdentity = rootIdentity;
    this.maximumBytes = options.maximumBytes;
    this.root = root;
    Object.freeze(this);
  }

  async write(requestInput: unknown): Promise<AtomicWriteResult> {
    const request = validateRequest(requestInput, this.#options);
    checkAborted(this.#options, request.path);
    const absolute = repositoryRelativePathToAbsolute(this.root, request.path, this.#flavor);
    const directory = path.dirname(absolute);
    let lock: OpenArtifact | undefined;
    let temporary: OpenArtifact | undefined;
    let committed = false;
    try {
      const parentSnapshot = await this.#validatePathParents(request.path);
      lock = await this.#acquireLock(directory, request.path);
      const first = await this.#observeTarget(absolute, request, parentSnapshot);
      temporary = await this.#prepareTemporary(directory, request, first.mode);
      await this.#hooks.afterTemporarySync?.(request.path);
      await this.#verifyArtifact(
        temporary,
        request.path,
        request.replacement.byteLength,
        first.mode,
      );
      await temporary.handle.close();
      await this.#hooks.beforeCommitValidation?.(request.path);
      checkAborted(this.#options, request.path);
      await this.#validatePathParents(request.path, parentSnapshot);
      await this.#observeTarget(absolute, request, parentSnapshot, first.snapshot);
      await this.#verifyClosedArtifact(
        temporary,
        request.path,
        request.replacement.byteLength,
        first.mode,
      );
      await this.#verifyOpenArtifact(lock, request.path, 0, 0o600);
      await this.#hooks.beforeRename?.(request.path);
      checkAborted(this.#options, request.path);
      await this.#validatePathParents(request.path, parentSnapshot);
      await this.#observeTarget(absolute, request, parentSnapshot, first.snapshot);
      await this.#verifyClosedArtifact(
        temporary,
        request.path,
        request.replacement.byteLength,
        first.mode,
      );
      await this.#verifyOpenArtifact(lock, request.path, 0, 0o600);
      const publishedExpected = temporary.snapshot;
      await this.#fileSystem.rename(temporary.absolutePath, absolute);
      committed = true;
      temporary = undefined;
      const published = await this.#fileSystem.lstat(absolute);
      const publishedSnapshot = snapshot(published);
      if (
        !published.isFile() ||
        published.isSymbolicLink() ||
        publishedSnapshot.dev !== publishedExpected.dev ||
        publishedSnapshot.ino !== publishedExpected.ino ||
        publishedSnapshot.mode !== publishedExpected.mode ||
        publishedSnapshot.mtimeNs !== publishedExpected.mtimeNs ||
        publishedSnapshot.nlink !== 1n ||
        publishedSnapshot.size !== BigInt(request.replacement.byteLength) ||
        (this.#fileSystem.platform !== "win32" && fileMode(publishedSnapshot) !== first.mode)
      )
        fail(
          AtomicWriteErrorCode.concurrentChange,
          "published file failed identity validation",
          "verify-published",
          true,
          request.path,
        );
      let directorySync = await this.#syncDirectory(directory, request.path, true);
      await this.#releaseArtifact(lock, request.path, true);
      lock = undefined;
      const cleanupSync = await this.#syncDirectory(directory, request.path, true);
      if (cleanupSync === "unsupported") directorySync = "unsupported";
      return Object.freeze({
        bytesWritten: request.replacement.byteLength,
        contractVersion: ATOMIC_WRITER_CONTRACT_VERSION,
        directorySync,
        durability: directorySync === "synced" ? "file-and-directory" : "file-only",
        identity: Object.freeze({
          device: String(publishedSnapshot.dev),
          inode: String(publishedSnapshot.ino),
        }),
        mode: first.mode,
        path: request.path,
        previousSha256: request.expectedSha256,
        sha256: request.replacementSha256,
      });
    } catch (error) {
      const primary = wrapIoFailure(error, "atomic-write", committed, request.path);
      const cleanup = await this.#cleanupFailure(temporary, lock, request.path, committed);
      if (cleanup !== undefined) throw cleanup;
      throw primary;
    }
  }

  async #validatePathParents(
    pathValue: RepositoryRelativePath,
    expectedParent?: StatSnapshot,
  ): Promise<StatSnapshot> {
    const rootStats = await this.#fileSystem.lstat(this.root);
    if (
      !rootStats.isDirectory() ||
      rootStats.isSymbolicLink() ||
      String(rootStats.dev) !== this.#rootIdentity.device ||
      String(rootStats.ino) !== this.#rootIdentity.inode ||
      (await this.#fileSystem.realpath(this.root)) !== this.root
    )
      fail(
        AtomicWriteErrorCode.unsafePath,
        "repository root identity changed",
        "validate-root",
        false,
        pathValue,
      );
    const segments = pathValue.split("/");
    let current = this.root;
    let parent = snapshot(rootStats);
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      const stats = await this.#fileSystem.lstat(current);
      if (
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        (await this.#fileSystem.realpath(current)) !== current
      )
        fail(
          AtomicWriteErrorCode.unsafePath,
          "target parent is not a canonical real directory",
          "validate-parent",
          false,
          pathValue,
        );
      parent = snapshot(stats);
    }
    if (expectedParent !== undefined && !sameDirectory(parent, expectedParent))
      fail(
        AtomicWriteErrorCode.concurrentChange,
        "target parent identity changed",
        "validate-parent",
        false,
        pathValue,
      );
    return parent;
  }

  async #observeTarget(
    absolute: string,
    request: ValidatedRequest,
    parentSnapshot: StatSnapshot,
    expectedSnapshot?: StatSnapshot,
  ): Promise<TargetObservation> {
    await this.#validatePathParents(request.path, parentSnapshot);
    const pathStats = await this.#fileSystem.lstat(absolute);
    const before = snapshot(pathStats);
    if (!pathStats.isFile() || pathStats.isSymbolicLink())
      fail(
        AtomicWriteErrorCode.unsafeType,
        "atomic write target must be a regular non-link file",
        "inspect-target",
        false,
        request.path,
      );
    if (before.nlink !== 1n)
      fail(
        AtomicWriteErrorCode.unsafeType,
        "atomic write target has ambiguous hard-link identity",
        "inspect-target",
        false,
        request.path,
      );
    if (!sameIdentity(before, request.expectedDevice, request.expectedInode))
      fail(
        AtomicWriteErrorCode.concurrentChange,
        "target identity differs from the analyzed file",
        "compare-target",
        false,
        request.path,
      );
    if (expectedSnapshot !== undefined && !sameSnapshot(before, expectedSnapshot))
      fail(
        AtomicWriteErrorCode.concurrentChange,
        "target metadata changed before commit",
        "compare-target",
        false,
        request.path,
      );
    if (before.size < 0n || before.size > BigInt(this.#options.maximumBytes))
      fail(
        AtomicWriteErrorCode.resourceLimit,
        "target exceeds the byte limit",
        "read-target",
        false,
        request.path,
      );
    const mode = fileMode(before);
    if ((mode & 0o222) === 0)
      fail(
        AtomicWriteErrorCode.readOnly,
        "read-only targets are not modified",
        "inspect-mode",
        false,
        request.path,
      );
    if ((await this.#fileSystem.realpath(absolute)) !== absolute)
      fail(
        AtomicWriteErrorCode.unsafePath,
        "target resolves through a link",
        "resolve-target",
        false,
        request.path,
      );
    const handle = await this.#fileSystem.open(absolute, fsConstants.O_RDONLY | noFollowFlag());
    let after: StatSnapshot;
    let digest: string;
    try {
      const opened = await handle.stat({ bigint: true });
      const openedSnapshot = snapshot(opened);
      if (!opened.isFile() || !sameSnapshot(before, openedSnapshot))
        fail(
          AtomicWriteErrorCode.concurrentChange,
          "target changed while it was opened",
          "open-target",
          false,
          request.path,
        );
      const bytes = new Uint8Array(Number(before.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead <= 0)
          fail(
            AtomicWriteErrorCode.concurrentChange,
            "target was truncated while reading",
            "read-target",
            false,
            request.path,
          );
        offset += result.bytesRead;
      }
      if ((await handle.read(new Uint8Array(1), 0, 1, bytes.byteLength)).bytesRead !== 0)
        fail(
          AtomicWriteErrorCode.concurrentChange,
          "target grew while reading",
          "read-target",
          false,
          request.path,
        );
      digest = createHash("sha256").update(bytes).digest("hex");
      after = snapshot(await handle.stat({ bigint: true }));
      if (!sameSnapshot(openedSnapshot, after))
        fail(
          AtomicWriteErrorCode.concurrentChange,
          "target changed while reading",
          "read-target",
          false,
          request.path,
        );
    } finally {
      await handle.close();
    }
    const pathAfter = snapshot(await this.#fileSystem.lstat(absolute));
    if (!sameSnapshot(after, pathAfter) || (await this.#fileSystem.realpath(absolute)) !== absolute)
      fail(
        AtomicWriteErrorCode.concurrentChange,
        "target path changed while reading",
        "compare-target",
        false,
        request.path,
      );
    if (digest !== request.expectedSha256)
      fail(
        AtomicWriteErrorCode.concurrentChange,
        "target content differs from the analyzed digest",
        "compare-target",
        false,
        request.path,
      );
    await this.#validatePathParents(request.path, parentSnapshot);
    return { digest, mode, snapshot: before };
  }

  async #acquireLock(directory: string, pathValue: RepositoryRelativePath): Promise<OpenArtifact> {
    const absolutePath = path.join(directory, temporaryName("lock", pathValue));
    let handle: AtomicWriterFileHandle;
    try {
      handle = await this.#fileSystem.open(
        absolutePath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(),
        0o600,
      );
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST")
        fail(
          AtomicWriteErrorCode.concurrentChange,
          "another writer or stale lock owns the target",
          "acquire-lock",
          false,
          pathValue,
          "EEXIST",
        );
      throw error;
    }
    try {
      await handle.chmod(0o600);
      const stats = await handle.stat({ bigint: true });
      const selected = snapshot(stats);
      if (
        !stats.isFile() ||
        selected.nlink !== 1n ||
        selected.size !== 0n ||
        (this.#fileSystem.platform !== "win32" && fileMode(selected) !== 0o600)
      )
        fail(
          AtomicWriteErrorCode.unsafeType,
          "writer lock is not an exclusive private file",
          "acquire-lock",
          false,
          pathValue,
        );
      return { absolutePath, handle, snapshot: selected };
    } catch (error) {
      await this.#cleanupOpenedPath(handle, absolutePath);
      throw error;
    }
  }

  async #prepareTemporary(
    directory: string,
    request: ValidatedRequest,
    mode: number,
  ): Promise<OpenArtifact> {
    for (let attempt = 0; attempt < this.#options.maximumTemporaryAttempts; attempt += 1) {
      const token = this.#fileSystem.randomToken();
      if (!TEMPORARY_TOKEN.test(token))
        fail(
          AtomicWriteErrorCode.invalidInput,
          "temporary token capability returned an invalid token",
          "create-temporary",
          false,
          request.path,
        );
      const absolutePath = path.join(directory, temporaryName("tmp", request.path, token));
      let handle: AtomicWriterFileHandle;
      try {
        handle = await this.#fileSystem.open(
          absolutePath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(),
          0o600,
        );
      } catch (error) {
        if (nodeErrorCode(error) === "EEXIST") continue;
        throw error;
      }
      try {
        let offset = 0;
        while (offset < request.replacement.byteLength) {
          const result = await handle.write(
            request.replacement,
            offset,
            request.replacement.byteLength - offset,
            offset,
          );
          if (result.bytesWritten <= 0)
            fail(
              AtomicWriteErrorCode.ioFailed,
              "temporary file write made no progress",
              "write-temporary",
              false,
              request.path,
            );
          offset += result.bytesWritten;
        }
        await handle.chmod(mode);
        await handle.sync();
        const stats = await handle.stat({ bigint: true });
        const selected = snapshot(stats);
        if (
          !stats.isFile() ||
          selected.nlink !== 1n ||
          selected.size !== BigInt(request.replacement.byteLength) ||
          (this.#fileSystem.platform !== "win32" && fileMode(selected) !== mode)
        )
          fail(
            AtomicWriteErrorCode.concurrentChange,
            "temporary file changed while writing",
            "verify-temporary",
            false,
            request.path,
          );
        return { absolutePath, handle, snapshot: selected };
      } catch (error) {
        await this.#cleanupOpenedPath(handle, absolutePath);
        throw error;
      }
    }
    fail(
      AtomicWriteErrorCode.temporaryCollision,
      "exclusive temporary file attempts were exhausted",
      "create-temporary",
      false,
      request.path,
    );
  }

  async #verifyArtifact(
    artifact: OpenArtifact,
    pathValue: RepositoryRelativePath,
    size: number,
    mode: number,
  ): Promise<void> {
    const opened = await artifact.handle.stat({ bigint: true });
    const selected = snapshot(opened);
    if (
      !opened.isFile() ||
      !sameSnapshot(selected, artifact.snapshot) ||
      selected.nlink !== 1n ||
      selected.size !== BigInt(size) ||
      (this.#fileSystem.platform !== "win32" && fileMode(selected) !== mode)
    )
      fail(
        AtomicWriteErrorCode.concurrentChange,
        "open temporary artifact changed",
        "verify-temporary",
        false,
        pathValue,
      );
    await this.#verifyClosedArtifact(artifact, pathValue, size, mode);
  }

  async #verifyClosedArtifact(
    artifact: OpenArtifact,
    pathValue: RepositoryRelativePath,
    size: number,
    mode: number,
  ): Promise<void> {
    const pathStats = await this.#fileSystem.lstat(artifact.absolutePath);
    const selected = snapshot(pathStats);
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      !sameSnapshot(selected, artifact.snapshot) ||
      selected.nlink !== 1n ||
      selected.size !== BigInt(size) ||
      (this.#fileSystem.platform !== "win32" && fileMode(selected) !== mode) ||
      (await this.#fileSystem.realpath(artifact.absolutePath)) !== artifact.absolutePath
    )
      fail(
        AtomicWriteErrorCode.concurrentChange,
        "temporary artifact path changed",
        "verify-temporary",
        false,
        pathValue,
      );
  }

  async #verifyOpenArtifact(
    artifact: OpenArtifact,
    pathValue: RepositoryRelativePath,
    size: number,
    mode: number,
  ): Promise<void> {
    await this.#verifyArtifact(artifact, pathValue, size, mode);
  }

  async #syncDirectory(
    directory: string,
    pathValue: RepositoryRelativePath,
    committed: boolean,
  ): Promise<"synced" | "unsupported"> {
    await this.#hooks.beforeDirectorySync?.(directory);
    let handle: AtomicWriterFileHandle;
    try {
      handle = await this.#fileSystem.open(directory, fsConstants.O_RDONLY | noFollowFlag());
    } catch (error) {
      if (unsupportedDirectorySync(error, this.#fileSystem.platform)) return "unsupported";
      throw new AtomicWriteError(
        AtomicWriteErrorCode.durabilityFailed,
        "directory durability handle could not be opened",
        "sync-directory",
        committed,
        pathValue,
        nodeErrorCode(error),
      );
    }
    let outcome: "synced" | "unsupported" = "synced";
    let syncFailure: AtomicWriteError | undefined;
    try {
      await handle.sync();
    } catch (error) {
      if (unsupportedDirectorySync(error, this.#fileSystem.platform)) outcome = "unsupported";
      else
        syncFailure = new AtomicWriteError(
          AtomicWriteErrorCode.durabilityFailed,
          "directory metadata flush failed after commit",
          "sync-directory",
          committed,
          pathValue,
          nodeErrorCode(error),
        );
    }
    try {
      await handle.close();
    } catch (error) {
      throw new AtomicWriteError(
        AtomicWriteErrorCode.durabilityFailed,
        "directory durability handle could not be closed",
        "close-directory",
        committed,
        pathValue,
        nodeErrorCode(error),
      );
    }
    if (syncFailure !== undefined) throw syncFailure;
    return outcome;
  }

  async #releaseArtifact(
    artifact: OpenArtifact,
    pathValue: RepositoryRelativePath,
    committed: boolean,
  ): Promise<void> {
    try {
      const openStats = snapshot(await artifact.handle.stat({ bigint: true }));
      const pathStats = snapshot(await this.#fileSystem.lstat(artifact.absolutePath));
      if (
        !sameSnapshot(openStats, artifact.snapshot) ||
        !sameSnapshot(pathStats, artifact.snapshot)
      )
        fail(
          AtomicWriteErrorCode.cleanupFailed,
          "writer lock changed before cleanup",
          "release-lock",
          committed,
          pathValue,
        );
      await artifact.handle.close();
      await this.#fileSystem.unlink(artifact.absolutePath);
    } catch (error) {
      await ignoreRejection(artifact.handle.close());
      if (error instanceof AtomicWriteError) throw error;
      throw new AtomicWriteError(
        AtomicWriteErrorCode.cleanupFailed,
        "writer lock cleanup failed",
        "release-lock",
        committed,
        pathValue,
        nodeErrorCode(error),
      );
    }
  }

  async #safeUnlink(absolutePath: string, expected?: StatSnapshot): Promise<boolean> {
    try {
      const stats = snapshot(await this.#fileSystem.lstat(absolutePath));
      if (expected !== undefined && !sameSnapshot(stats, expected)) return false;
      await this.#fileSystem.unlink(absolutePath);
      return true;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      return true;
    }
  }

  async #cleanupOpenedPath(handle: AtomicWriterFileHandle, absolutePath: string): Promise<void> {
    let opened: StatSnapshot;
    try {
      opened = snapshot(await handle.stat({ bigint: true }));
    } catch (error) {
      await ignoreRejection(handle.close());
      throw new AtomicWriteError(
        AtomicWriteErrorCode.cleanupFailed,
        "unidentifiable writer artifact was left in place",
        "cleanup-open-artifact",
        false,
        undefined,
        nodeErrorCode(error),
      );
    }
    let closeFailure: unknown;
    try {
      await handle.close();
    } catch (error) {
      closeFailure = error;
    }
    let removed = false;
    let unlinkFailure: unknown;
    try {
      removed = await this.#safeUnlink(absolutePath, opened);
    } catch (error) {
      unlinkFailure = error;
    }
    if (closeFailure !== undefined || unlinkFailure !== undefined || !removed)
      throw new AtomicWriteError(
        AtomicWriteErrorCode.cleanupFailed,
        "writer artifact cleanup could not be completed safely",
        "cleanup-open-artifact",
        false,
        undefined,
        nodeErrorCode(closeFailure ?? unlinkFailure),
      );
  }

  async #cleanupFailure(
    temporary: OpenArtifact | undefined,
    lock: OpenArtifact | undefined,
    pathValue: RepositoryRelativePath,
    committed: boolean,
  ): Promise<AtomicWriteError | undefined> {
    let selected: AtomicWriteError | undefined;
    if (temporary !== undefined) {
      try {
        await temporary.handle.close();
      } catch (error) {
        selected = new AtomicWriteError(
          AtomicWriteErrorCode.cleanupFailed,
          "temporary handle cleanup failed",
          "cleanup-temporary",
          committed,
          pathValue,
          nodeErrorCode(error),
        );
      }
      try {
        await this.#safeUnlink(temporary.absolutePath, temporary.snapshot);
      } catch (error) {
        selected ??= new AtomicWriteError(
          AtomicWriteErrorCode.cleanupFailed,
          "temporary pathname cleanup failed",
          "cleanup-temporary",
          committed,
          pathValue,
          nodeErrorCode(error),
        );
      }
    }
    if (lock !== undefined)
      try {
        await this.#releaseArtifact(lock, pathValue, committed);
      } catch (error) {
        selected ??=
          error instanceof AtomicWriteError
            ? error
            : new AtomicWriteError(
                AtomicWriteErrorCode.cleanupFailed,
                "writer lock cleanup failed closed",
                "cleanup",
                committed,
                pathValue,
                nodeErrorCode(error),
              );
      }
    return selected;
  }
}

async function validateSelection(
  value: unknown,
  fileSystem: AtomicWriterFileSystemCapability,
): Promise<{ readonly identity: AtomicWriteExpectedIdentity; readonly root: string }> {
  const fields = ownData(
    value,
    [
      "gitDirectory",
      "identity",
      "inspectedAncestors",
      "lexicalRoot",
      "reason",
      "root",
      "searchBoundary",
    ],
    "validate-selection",
    AtomicWriteErrorCode.invalidSelection,
  );
  const root = fields.get("root");
  const selectionIdentity = ownData(
    fields.get("identity"),
    ["device", "inode"],
    "validate-selection",
    AtomicWriteErrorCode.invalidSelection,
  );
  const device = selectionIdentity.get("device");
  const inode = selectionIdentity.get("inode");
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.length > 16_384 ||
    root.includes("\0") ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    typeof device !== "string" ||
    !DECIMAL_IDENTITY.test(device) ||
    typeof inode !== "string" ||
    !DECIMAL_IDENTITY.test(inode)
  )
    fail(
      AtomicWriteErrorCode.invalidSelection,
      "repository root selection is invalid",
      "validate-selection",
      false,
    );
  try {
    const stats = await fileSystem.lstat(root);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      String(stats.dev) !== device ||
      String(stats.ino) !== inode ||
      (await fileSystem.realpath(root)) !== root
    )
      fail(
        AtomicWriteErrorCode.invalidSelection,
        "repository root selection identity changed",
        "validate-selection",
        false,
      );
  } catch (error) {
    if (error instanceof AtomicWriteError) throw error;
    throw wrapIoFailure(error, "validate-selection", false);
  }
  return Object.freeze({ identity: Object.freeze({ device, inode }), root });
}

export async function createAtomicRepositoryWriter(
  selection: RepositoryRootSelection,
  options?: AtomicWriteOptions,
): Promise<AtomicRepositoryWriter> {
  return createAtomicRepositoryWriterWithFileSystem(selection, options, DEFAULT_FILE_SYSTEM);
}

/** @internal Trusted capability entry point for platform and fault-injection tests. */
export async function createAtomicRepositoryWriterWithFileSystem(
  selection: unknown,
  options: unknown,
  fileSystem: AtomicWriterFileSystemCapability,
  hooks: AtomicWriterTestHooks = Object.freeze({}),
): Promise<AtomicRepositoryWriter> {
  const selectedOptions = validateOptions(options);
  const selected = await validateSelection(selection, fileSystem);
  return new RepositoryAtomicWriter(
    selected.root,
    selected.identity,
    selectedOptions,
    fileSystem,
    Object.freeze({ ...hooks }),
  );
}
