import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { types as nodeTypes } from "node:util";

import {
  canonicalizeRepositoryRelativePath,
  repositoryRelativePathToAbsolute,
} from "@agent-context/core";
import type { PathFlavor, RepositoryRelativePath } from "@agent-context/core";

import {
  normalizeRepositorySelectionPath,
  REPOSITORY_ROOT_SELECTION_REASONS,
} from "./repository-root.js";
import type { RepositoryRootSelection } from "./repository-root.js";

export interface ReadOnlyRepositoryLimits {
  readonly maximumDurationMs: number;
  readonly maximumEntries: number;
  readonly maximumFileBytes: number;
  readonly maximumMetadataOperations: number;
  readonly maximumSymlinkDepth: number;
  readonly maximumTotalBytes: number;
  readonly maximumTraversalDepth: number;
}

export const READ_ONLY_REPOSITORY_HARD_LIMITS: Readonly<ReadOnlyRepositoryLimits> = Object.freeze({
  maximumDurationMs: 300_000,
  maximumEntries: 1_000_000,
  maximumFileBytes: 16_777_216,
  maximumMetadataOperations: 4_000_000,
  maximumSymlinkDepth: 64,
  maximumTotalBytes: 1_073_741_824,
  maximumTraversalDepth: 1_024,
} as const);

export const READ_ONLY_REPOSITORY_DEFAULT_LIMITS: Readonly<ReadOnlyRepositoryLimits> =
  Object.freeze({
    maximumDurationMs: 30_000,
    maximumEntries: 100_000,
    maximumFileBytes: 1_048_576,
    maximumMetadataOperations: 1_000_000,
    maximumSymlinkDepth: 32,
    maximumTotalBytes: 67_108_864,
    maximumTraversalDepth: 128,
  } as const);

export interface ReadOnlyRepositoryOptions {
  readonly maximumDurationMs?: number;
  readonly maximumEntries?: number;
  readonly maximumFileBytes?: number;
  readonly maximumMetadataOperations?: number;
  readonly maximumSymlinkDepth?: number;
  readonly maximumTotalBytes?: number;
  readonly maximumTraversalDepth?: number;
  readonly signal?: AbortSignal;
}

export interface ReadOnlyRepositoryFileSystemCapability {
  lstat(target: string): Promise<BigIntStats>;
  now(): number;
  open(target: string, flags: number): Promise<FileHandle>;
  openDirectory(target: string): Promise<ReadOnlyRepositoryDirectoryHandle>;
  readlink(target: string): Promise<string>;
  realpath(target: string): Promise<string>;
}

export interface ReadOnlyRepositoryDirectoryHandle {
  close(): Promise<void>;
  read(): Promise<string | null>;
}

export const ReadOnlyRepositoryErrorCode: Readonly<{
  aborted: "READ_ONLY_REPOSITORY_ABORTED";
  closeFailed: "READ_ONLY_REPOSITORY_CLOSE_FAILED";
  concurrentOperation: "READ_ONLY_REPOSITORY_CONCURRENT_OPERATION";
  deadlineExceeded: "READ_ONLY_REPOSITORY_DEADLINE_EXCEEDED";
  hardLink: "READ_ONLY_REPOSITORY_HARD_LINK";
  invalidOptions: "READ_ONLY_REPOSITORY_INVALID_OPTIONS";
  invalidPath: "READ_ONLY_REPOSITORY_INVALID_PATH";
  invalidSelection: "READ_ONLY_REPOSITORY_INVALID_SELECTION";
  limitExceeded: "READ_ONLY_REPOSITORY_LIMIT_EXCEEDED";
  notDirectory: "READ_ONLY_REPOSITORY_NOT_DIRECTORY";
  notFile: "READ_ONLY_REPOSITORY_NOT_FILE";
  outsideRoot: "READ_ONLY_REPOSITORY_OUTSIDE_ROOT";
  pathChanged: "READ_ONLY_REPOSITORY_PATH_CHANGED";
  pathUnavailable: "READ_ONLY_REPOSITORY_PATH_UNAVAILABLE";
  readFailed: "READ_ONLY_REPOSITORY_READ_FAILED";
  symlinkLoop: "READ_ONLY_REPOSITORY_SYMLINK_LOOP";
  unsafeType: "READ_ONLY_REPOSITORY_UNSAFE_TYPE";
}> = Object.freeze({
  aborted: "READ_ONLY_REPOSITORY_ABORTED",
  closeFailed: "READ_ONLY_REPOSITORY_CLOSE_FAILED",
  concurrentOperation: "READ_ONLY_REPOSITORY_CONCURRENT_OPERATION",
  deadlineExceeded: "READ_ONLY_REPOSITORY_DEADLINE_EXCEEDED",
  hardLink: "READ_ONLY_REPOSITORY_HARD_LINK",
  invalidOptions: "READ_ONLY_REPOSITORY_INVALID_OPTIONS",
  invalidPath: "READ_ONLY_REPOSITORY_INVALID_PATH",
  invalidSelection: "READ_ONLY_REPOSITORY_INVALID_SELECTION",
  limitExceeded: "READ_ONLY_REPOSITORY_LIMIT_EXCEEDED",
  notDirectory: "READ_ONLY_REPOSITORY_NOT_DIRECTORY",
  notFile: "READ_ONLY_REPOSITORY_NOT_FILE",
  outsideRoot: "READ_ONLY_REPOSITORY_OUTSIDE_ROOT",
  pathChanged: "READ_ONLY_REPOSITORY_PATH_CHANGED",
  pathUnavailable: "READ_ONLY_REPOSITORY_PATH_UNAVAILABLE",
  readFailed: "READ_ONLY_REPOSITORY_READ_FAILED",
  symlinkLoop: "READ_ONLY_REPOSITORY_SYMLINK_LOOP",
  unsafeType: "READ_ONLY_REPOSITORY_UNSAFE_TYPE",
} as const);

export type ReadOnlyRepositoryErrorCode =
  (typeof ReadOnlyRepositoryErrorCode)[keyof typeof ReadOnlyRepositoryErrorCode];

export class ReadOnlyRepositoryError extends Error {
  override readonly name = "ReadOnlyRepositoryError" as const;
  readonly causeCode: string | undefined;
  readonly code: ReadOnlyRepositoryErrorCode;
  readonly operation: string;
  readonly path: RepositoryRelativePath | undefined;

  constructor(
    code: ReadOnlyRepositoryErrorCode,
    message: string,
    operation: string,
    pathValue?: RepositoryRelativePath,
    causeCode?: string,
  ) {
    super(message);
    this.causeCode = causeCode;
    this.code = code;
    this.operation = operation;
    this.path = pathValue;
    Object.freeze(this);
  }
}

export interface ReadOnlyRepositoryIdentity {
  readonly device: string;
  readonly inode: string;
}

export type ReadOnlyRepositoryEntryType = "directory" | "file";

export interface ReadOnlyRepositoryEntry {
  readonly identity: ReadOnlyRepositoryIdentity;
  readonly linkDepth: number;
  readonly path: RepositoryRelativePath;
  readonly size: number;
  readonly type: ReadOnlyRepositoryEntryType;
}

export interface ReadOnlyRepositoryDirectory extends ReadOnlyRepositoryEntry {
  readonly entries: readonly RepositoryRelativePath[];
  readonly type: "directory";
}

export interface ReadOnlyRepositoryUsage {
  readonly elapsedMs: number;
  readonly entries: number;
  readonly metadataOperations: number;
  readonly totalBytes: number;
}

export class ReadOnlyRepositoryFile implements ReadOnlyRepositoryEntry {
  readonly identity: ReadOnlyRepositoryIdentity;
  readonly linkDepth: number;
  readonly path: RepositoryRelativePath;
  readonly size: number;
  readonly type = "file" as const;
  readonly #content: Uint8Array;

  constructor(
    pathValue: RepositoryRelativePath,
    content: Uint8Array,
    identity: ReadOnlyRepositoryIdentity,
    linkDepth: number,
  ) {
    this.#content = Uint8Array.from(content);
    this.identity = identity;
    this.linkDepth = linkDepth;
    this.path = pathValue;
    this.size = content.byteLength;
    Object.freeze(this);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.#content);
  }
}

export interface ReadOnlyRepository {
  readonly limits: ReadOnlyRepositoryLimits;
  readonly root: string;
  inspect(relativePath: unknown): Promise<ReadOnlyRepositoryEntry>;
  readDirectory(relativePath: unknown): Promise<ReadOnlyRepositoryDirectory>;
  readFile(relativePath: unknown): Promise<ReadOnlyRepositoryFile>;
  usage(): ReadOnlyRepositoryUsage;
}

interface SelectionSnapshot {
  readonly identity: ReadOnlyRepositoryIdentity;
  readonly lexicalRoot: string;
  readonly root: string;
}

interface OptionsSnapshot {
  readonly limits: ReadOnlyRepositoryLimits;
  readonly signal?: AbortSignal;
}

interface MutableUsage {
  entries: number;
  metadataOperations: number;
  totalBytes: number;
}

interface Observation {
  readonly path: string;
  readonly stats: BigIntStats;
}

interface ResolvedEntry {
  readonly absolutePath: string;
  readonly linkDepth: number;
  readonly observations: readonly Observation[];
  readonly path: RepositoryRelativePath;
  readonly stats: BigIntStats;
}

const DEFAULT_CAPABILITY: ReadOnlyRepositoryFileSystemCapability = Object.freeze({
  lstat: async (target: string): Promise<BigIntStats> => lstat(target, { bigint: true }),
  now: (): number => performance.now(),
  open: async (target: string, flags: number): Promise<FileHandle> => open(target, flags),
  openDirectory: async (target: string): Promise<ReadOnlyRepositoryDirectoryHandle> => {
    const handle = await opendir(target, { encoding: "utf8" });
    return {
      close: async (): Promise<void> => handle.close(),
      read: async (): Promise<string | null> => (await handle.read())?.name ?? null,
    };
  },
  readlink: async (target: string): Promise<string> => readlink(target, { encoding: "utf8" }),
  realpath: async (target: string): Promise<string> => realpath(target),
});

const ABORT_SIGNAL_ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
);

function failure(
  code: ReadOnlyRepositoryErrorCode,
  message: string,
  operation: string,
  pathValue?: RepositoryRelativePath,
  causeCode?: string,
): ReadOnlyRepositoryError {
  return new ReadOnlyRepositoryError(code, message, operation, pathValue, causeCode);
}

function isFacadeError(error: unknown): error is ReadOnlyRepositoryError {
  if (nodeTypes.isProxy(error)) return false;
  try {
    return error instanceof ReadOnlyRepositoryError;
  } catch {
    return false;
  }
}

function platformErrorCode(error: unknown): string | undefined {
  if (
    (typeof error !== "object" && typeof error !== "function") ||
    error === null ||
    nodeTypes.isProxy(error)
  ) {
    return undefined;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "code");
  } catch {
    return undefined;
  }
  const value: unknown =
    descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(value) ? value : undefined;
}

function intrinsicAbortState(value: unknown): boolean | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    ABORT_SIGNAL_ABORTED_DESCRIPTOR?.get === undefined
  ) {
    return undefined;
  }
  try {
    const state: unknown = ABORT_SIGNAL_ABORTED_DESCRIPTOR.get.call(value);
    return typeof state === "boolean" ? state : undefined;
  } catch {
    return undefined;
  }
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  return intrinsicAbortState(value) !== undefined;
}

function plainDataValues(
  value: unknown,
  allowedKeys: readonly string[],
  operation: string,
  code: ReadOnlyRepositoryErrorCode = ReadOnlyRepositoryErrorCode.invalidOptions,
): ReadonlyMap<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw failure(code, "read-only repository data must be a plain object", operation);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > allowedKeys.length ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
  ) {
    throw failure(code, "read-only repository data contains an unknown field", operation);
  }
  const values = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor)
    ) {
      throw failure(code, "read-only repository data contains an accessor", operation);
    }
    values.set(key as string, descriptor.value as unknown);
  }
  return values;
}

function snapshotSelection(value: unknown): SelectionSnapshot {
  const fields = plainDataValues(
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
    ReadOnlyRepositoryErrorCode.invalidSelection,
  );
  const identityValue = fields.get("identity");
  const identity = plainDataValues(
    identityValue,
    ["device", "inode"],
    "validate-selection",
    ReadOnlyRepositoryErrorCode.invalidSelection,
  );
  const root = fields.get("root");
  const lexicalRoot = fields.get("lexicalRoot");
  const reason = fields.get("reason");
  const device = identity.get("device");
  const inode = identity.get("inode");
  if (
    typeof root !== "string" ||
    typeof lexicalRoot !== "string" ||
    typeof reason !== "string" ||
    !REPOSITORY_ROOT_SELECTION_REASONS.includes(
      reason as (typeof REPOSITORY_ROOT_SELECTION_REASONS)[number],
    ) ||
    typeof device !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(device) ||
    typeof inode !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(inode)
  ) {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidSelection,
      "repository-root selection is invalid",
      "validate-selection",
    );
  }
  const flavor: PathFlavor = process.platform === "win32" ? "win32" : "posix";
  let normalizedRoot: string;
  let normalizedLexicalRoot: string;
  try {
    normalizedRoot = normalizeRepositorySelectionPath(root, flavor);
    normalizedLexicalRoot = normalizeRepositorySelectionPath(lexicalRoot, flavor);
  } catch {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidSelection,
      "repository-root selection contains an invalid path",
      "validate-selection",
    );
  }
  if (normalizedRoot !== root || normalizedLexicalRoot !== lexicalRoot) {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidSelection,
      "repository-root selection paths must already be normalized",
      "validate-selection",
    );
  }
  return Object.freeze({
    identity: Object.freeze({ device, inode }),
    lexicalRoot,
    root,
  });
}

function snapshotOptions(value: unknown): OptionsSnapshot {
  if (value === undefined) {
    return { limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS };
  }
  const keys = [
    "maximumDurationMs",
    "maximumEntries",
    "maximumFileBytes",
    "maximumMetadataOperations",
    "maximumSymlinkDepth",
    "maximumTotalBytes",
    "maximumTraversalDepth",
    "signal",
  ] as const;
  const fields = plainDataValues(value, keys, "validate-options");
  const limits: Record<keyof ReadOnlyRepositoryLimits, number> = {
    maximumDurationMs: READ_ONLY_REPOSITORY_DEFAULT_LIMITS.maximumDurationMs,
    maximumEntries: READ_ONLY_REPOSITORY_DEFAULT_LIMITS.maximumEntries,
    maximumFileBytes: READ_ONLY_REPOSITORY_DEFAULT_LIMITS.maximumFileBytes,
    maximumMetadataOperations: READ_ONLY_REPOSITORY_DEFAULT_LIMITS.maximumMetadataOperations,
    maximumSymlinkDepth: READ_ONLY_REPOSITORY_DEFAULT_LIMITS.maximumSymlinkDepth,
    maximumTotalBytes: READ_ONLY_REPOSITORY_DEFAULT_LIMITS.maximumTotalBytes,
    maximumTraversalDepth: READ_ONLY_REPOSITORY_DEFAULT_LIMITS.maximumTraversalDepth,
  };
  for (const key of keys) {
    if (key === "signal" || !fields.has(key)) continue;
    const candidate = fields.get(key);
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > READ_ONLY_REPOSITORY_HARD_LIMITS[key]
    ) {
      throw failure(
        ReadOnlyRepositoryErrorCode.invalidOptions,
        "read-only repository limits are outside supported bounds",
        "validate-options",
      );
    }
    limits[key] = candidate;
  }
  const signal = fields.get("signal");
  if (
    (fields.has("signal") && signal === undefined) ||
    (signal !== undefined && !isNativeAbortSignal(signal))
  ) {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidOptions,
      "read-only repository cancellation signal is invalid",
      "validate-options",
    );
  }
  return Object.freeze({
    limits: Object.freeze(limits),
    ...(signal === undefined ? {} : { signal }),
  });
}

function sameIdentity(stats: BigIntStats, identity: ReadOnlyRepositoryIdentity): boolean {
  return String(stats.dev) === identity.device && String(stats.ino) === identity.inode;
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory() && right.isDirectory() && sameEntry(left, right);
}

function identityOf(stats: BigIntStats): ReadOnlyRepositoryIdentity {
  return Object.freeze({ device: String(stats.dev), inode: String(stats.ino) });
}

function pathFlavor(): PathFlavor {
  return process.platform === "win32" ? "win32" : "posix";
}

function implementationFor(flavor: PathFlavor): typeof path.posix {
  return flavor === "posix" ? path.posix : path.win32;
}

function isOutside(root: string, candidate: string, flavor: PathFlavor): boolean {
  const implementation = implementationFor(flavor);
  const relative = implementation.relative(root, candidate);
  return (
    implementation.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${implementation.sep}`)
  );
}

function containsUnsafeText(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > 16_384) return true;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit <= 0x1f ||
      (unit >= 0x7f && unit <= 0x9f) ||
      unit === 0x061c ||
      unit === 0x200e ||
      unit === 0x200f ||
      (unit >= 0x202a && unit <= 0x202e) ||
      (unit >= 0x2066 && unit <= 0x2069)
    ) {
      return true;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizedRelativePath(
  value: unknown,
  limits: ReadOnlyRepositoryLimits,
): RepositoryRelativePath {
  if (typeof value !== "string" || containsUnsafeText(value)) {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidPath,
      "repository-relative path is invalid",
      "validate-path",
    );
  }
  let normalized: RepositoryRelativePath;
  try {
    normalized = canonicalizeRepositoryRelativePath(value, "posix");
  } catch {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidPath,
      "repository-relative path is invalid",
      "validate-path",
    );
  }
  if (normalized !== value) {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidPath,
      "repository-relative path must already be canonical",
      "validate-path",
    );
  }
  const depth = normalized === "." ? 0 : normalized.split("/").length;
  if (depth > limits.maximumTraversalDepth) {
    throw failure(
      ReadOnlyRepositoryErrorCode.limitExceeded,
      "repository traversal depth limit was exceeded",
      "path-depth",
      normalized,
    );
  }
  return normalized;
}

function validateDirectoryName(value: unknown, parent: RepositoryRelativePath): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    containsUnsafeText(value)
  ) {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidPath,
      "repository directory contains an invalid entry name",
      "validate-directory-entry",
      parent,
    );
  }
  return value;
}

class ReadOnlyRepositoryFacade implements ReadOnlyRepository {
  readonly limits: ReadOnlyRepositoryLimits;
  readonly root: string;
  readonly #capability: ReadOnlyRepositoryFileSystemCapability;
  readonly #flavor: PathFlavor;
  readonly #identity: ReadOnlyRepositoryIdentity;
  readonly #signal: AbortSignal | undefined;
  readonly #startedAt: number;
  readonly #usage: MutableUsage = { entries: 0, metadataOperations: 0, totalBytes: 0 };
  #active = false;
  #lastNow: number;

  constructor(
    selection: SelectionSnapshot,
    options: OptionsSnapshot,
    capability: ReadOnlyRepositoryFileSystemCapability,
    startedAt: number,
    initialLastNow: number,
    initialMetadataOperations: number,
  ) {
    this.#capability = capability;
    this.#flavor = pathFlavor();
    this.#identity = selection.identity;
    this.#signal = options.signal;
    this.#startedAt = startedAt;
    this.#lastNow = initialLastNow;
    this.#usage.metadataOperations = initialMetadataOperations;
    this.limits = options.limits;
    this.root = selection.root;
    Object.freeze(this);
  }

  async inspect(relativePath: unknown): Promise<ReadOnlyRepositoryEntry> {
    return this.#operation(async () => {
      const normalized = normalizedRelativePath(relativePath, this.limits);
      await this.#assertRoot();
      const resolved = await this.#resolve(normalized);
      this.#consumeEntries(1, normalized);
      this.#assertSupportedType(resolved.stats, normalized);
      await this.#recheck(resolved);
      await this.#assertRoot();
      return this.#entry(resolved);
    });
  }

  async readDirectory(relativePath: unknown): Promise<ReadOnlyRepositoryDirectory> {
    return this.#operation(async () => {
      const normalized = normalizedRelativePath(relativePath, this.limits);
      await this.#assertRoot();
      const resolved = await this.#resolve(normalized);
      if (!resolved.stats.isDirectory()) {
        throw failure(
          ReadOnlyRepositoryErrorCode.notDirectory,
          "repository path is not a directory",
          "read-directory",
          normalized,
        );
      }
      this.#consumeEntries(1, normalized);
      const names = await this.#readDirectoryNames(resolved.absolutePath, normalized);
      const entries = names
        .map((name) => validateDirectoryName(name, normalized))
        .sort()
        .map((name) =>
          canonicalizeRepositoryRelativePath(normalized === "." ? name : `${normalized}/${name}`),
        );
      await this.#recheck(resolved);
      await this.#assertRoot();
      const base = this.#entry(resolved);
      return Object.freeze({
        ...base,
        entries: Object.freeze(entries),
        type: "directory" as const,
      });
    });
  }

  async readFile(relativePath: unknown): Promise<ReadOnlyRepositoryFile> {
    return this.#operation(async () => {
      const normalized = normalizedRelativePath(relativePath, this.limits);
      await this.#assertRoot();
      const resolved = await this.#resolve(normalized);
      if (!resolved.stats.isFile()) {
        throw failure(
          ReadOnlyRepositoryErrorCode.notFile,
          "repository path is not a regular file",
          "read-file",
          normalized,
        );
      }
      this.#assertUnambiguousFile(resolved.stats, normalized);
      const size = this.#boundedFileSize(resolved.stats, normalized);
      this.#consumeEntries(1, normalized);
      this.#consumeBytes(size, normalized);
      const bytes = await this.#readStableFile(resolved, size);
      await this.#assertRoot();
      return new ReadOnlyRepositoryFile(
        normalized,
        bytes,
        identityOf(resolved.stats),
        resolved.linkDepth,
      );
    });
  }

  usage(): ReadOnlyRepositoryUsage {
    return Object.freeze({
      elapsedMs: Math.max(0, this.#now() - this.#startedAt),
      entries: this.#usage.entries,
      metadataOperations: this.#usage.metadataOperations,
      totalBytes: this.#usage.totalBytes,
    });
  }

  async #operation<Result>(run: () => Promise<Result>): Promise<Result> {
    if (this.#active) {
      throw failure(
        ReadOnlyRepositoryErrorCode.concurrentOperation,
        "read-only repository operations must be sequential",
        "operation",
      );
    }
    this.#active = true;
    try {
      this.#checkpoint();
      return await run();
    } finally {
      this.#active = false;
    }
  }

  #now(): number {
    let value: number;
    try {
      value = this.#capability.now();
    } catch {
      throw failure(
        ReadOnlyRepositoryErrorCode.invalidOptions,
        "trusted filesystem clock failed",
        "clock",
      );
    }
    if (!Number.isFinite(value)) {
      throw failure(
        ReadOnlyRepositoryErrorCode.invalidOptions,
        "trusted filesystem clock is invalid",
        "clock",
      );
    }
    this.#lastNow = Math.max(this.#lastNow, value);
    return this.#lastNow;
  }

  #checkpoint(): void {
    const state = this.#signal === undefined ? false : intrinsicAbortState(this.#signal);
    if (state === undefined) {
      throw failure(
        ReadOnlyRepositoryErrorCode.invalidOptions,
        "read-only repository cancellation signal is invalid",
        "validate-signal",
      );
    }
    if (state) {
      throw failure(
        ReadOnlyRepositoryErrorCode.aborted,
        "read-only repository operation was cancelled",
        "cancel",
      );
    }
    if (this.#now() - this.#startedAt > this.limits.maximumDurationMs) {
      throw failure(
        ReadOnlyRepositoryErrorCode.deadlineExceeded,
        "read-only repository deadline was exceeded",
        "deadline",
      );
    }
  }

  async #awaitBounded<Result>(operation: Promise<Result>): Promise<Result> {
    this.#checkpoint();
    const elapsed = Math.max(0, this.#now() - this.#startedAt);
    const remaining = Math.max(1, Math.ceil(this.limits.maximumDurationMs - elapsed));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          failure(
            ReadOnlyRepositoryErrorCode.deadlineExceeded,
            "read-only repository deadline was exceeded",
            "deadline",
          ),
        );
      }, remaining);
    });
    const contenders: Promise<Result>[] = [operation, deadline];
    if (this.#signal !== undefined) {
      const cancelled = new Promise<never>((_resolve, reject) => {
        abortListener = (): void => {
          reject(
            failure(
              ReadOnlyRepositoryErrorCode.aborted,
              "read-only repository operation was cancelled",
              "cancel",
            ),
          );
        };
        EventTarget.prototype.addEventListener.call(this.#signal, "abort", abortListener, {
          once: true,
        });
        if (intrinsicAbortState(this.#signal)) abortListener();
      });
      contenders.push(cancelled);
    }
    try {
      const result = await Promise.race(contenders);
      this.#checkpoint();
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (this.#signal !== undefined && abortListener !== undefined) {
        EventTarget.prototype.removeEventListener.call(this.#signal, "abort", abortListener);
      }
    }
  }

  #countOperation(pathValue?: RepositoryRelativePath): void {
    this.#checkpoint();
    this.#usage.metadataOperations += 1;
    if (this.#usage.metadataOperations > this.limits.maximumMetadataOperations) {
      throw failure(
        ReadOnlyRepositoryErrorCode.limitExceeded,
        "repository metadata operation limit was exceeded",
        "metadata-limit",
        pathValue,
      );
    }
  }

  async #lstat(target: string, pathValue?: RepositoryRelativePath): Promise<BigIntStats> {
    this.#countOperation(pathValue);
    try {
      const stats = await this.#awaitBounded(this.#capability.lstat(target));
      return stats;
    } catch (error: unknown) {
      if (isFacadeError(error)) throw error;
      throw failure(
        ReadOnlyRepositoryErrorCode.pathUnavailable,
        "repository path cannot be inspected",
        "lstat",
        pathValue,
        platformErrorCode(error),
      );
    }
  }

  async #readlink(target: string, pathValue: RepositoryRelativePath): Promise<string> {
    this.#countOperation(pathValue);
    try {
      const value = await this.#awaitBounded(this.#capability.readlink(target));
      return value;
    } catch (error: unknown) {
      if (isFacadeError(error)) throw error;
      throw failure(
        ReadOnlyRepositoryErrorCode.pathUnavailable,
        "repository symbolic link cannot be inspected",
        "readlink",
        pathValue,
        platformErrorCode(error),
      );
    }
  }

  async #openDirectory(
    target: string,
    pathValue: RepositoryRelativePath,
  ): Promise<ReadOnlyRepositoryDirectoryHandle> {
    this.#countOperation(pathValue);
    let operation: Promise<ReadOnlyRepositoryDirectoryHandle> | undefined;
    try {
      operation = this.#capability.openDirectory(target);
      return await this.#awaitBounded(operation);
    } catch (error: unknown) {
      if (operation !== undefined && isFacadeError(error)) {
        void operation.then(async (handle) => handle.close()).catch(() => undefined);
      }
      if (isFacadeError(error)) throw error;
      throw failure(
        ReadOnlyRepositoryErrorCode.readFailed,
        "repository directory cannot be opened safely",
        "open-directory",
        pathValue,
        platformErrorCode(error),
      );
    }
  }

  async #readDirectoryEntry(
    handle: ReadOnlyRepositoryDirectoryHandle,
    pathValue: RepositoryRelativePath,
  ): Promise<string | null> {
    this.#countOperation(pathValue);
    try {
      const name = await this.#awaitBounded(handle.read());
      if (name !== null && typeof name !== "string") {
        throw new TypeError("invalid trusted directory entry");
      }
      return name;
    } catch (error: unknown) {
      if (isFacadeError(error)) throw error;
      throw failure(
        ReadOnlyRepositoryErrorCode.readFailed,
        "repository directory cannot be read safely",
        "read-directory-entry",
        pathValue,
        platformErrorCode(error),
      );
    }
  }

  async #closeDirectory(
    handle: ReadOnlyRepositoryDirectoryHandle,
    pathValue: RepositoryRelativePath,
  ): Promise<void> {
    try {
      await this.#awaitBounded(handle.close());
    } catch (error: unknown) {
      if (isFacadeError(error)) throw error;
      throw failure(
        ReadOnlyRepositoryErrorCode.closeFailed,
        "repository directory handle could not be closed safely",
        "close-directory",
        pathValue,
        platformErrorCode(error),
      );
    }
  }

  async #readDirectoryNames(
    target: string,
    pathValue: RepositoryRelativePath,
  ): Promise<readonly string[]> {
    const handle = await this.#openDirectory(target, pathValue);
    const names: string[] = [];
    let primaryError: unknown;
    let hasPrimaryError = false;
    try {
      for (;;) {
        const name = await this.#readDirectoryEntry(handle, pathValue);
        if (name === null) break;
        this.#consumeEntries(1, pathValue);
        names.push(validateDirectoryName(name, pathValue));
      }
    } catch (error: unknown) {
      primaryError = error;
      hasPrimaryError = true;
    }
    if (hasPrimaryError) {
      try {
        await this.#closeDirectory(handle, pathValue);
      } catch {
        // Preserve the authoritative read, validation, limit, or cancellation failure.
      }
      throw primaryError;
    }
    await this.#closeDirectory(handle, pathValue);
    return Object.freeze(names);
  }

  async #assertRoot(): Promise<void> {
    const stats = await this.#lstat(this.root);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(stats, this.#identity)) {
      throw failure(
        ReadOnlyRepositoryErrorCode.pathChanged,
        "repository root changed after selection",
        "recheck-root",
      );
    }
  }

  async #resolve(relativePath: RepositoryRelativePath): Promise<ResolvedEntry> {
    if (relativePath === ".") {
      const rootStats = await this.#lstat(this.root, relativePath);
      return {
        absolutePath: this.root,
        linkDepth: 0,
        observations: Object.freeze([{ path: this.root, stats: rootStats }]),
        path: relativePath,
        stats: rootStats,
      };
    }
    const implementation = implementationFor(this.#flavor);
    let pending = relativePath.split("/");
    let resolvedSegments: string[] = [];
    let linkDepth = 0;
    const observations: Observation[] = [];
    const visitedLinks = new Set<string>();

    while (pending.length > 0) {
      this.#checkpoint();
      if (resolvedSegments.length + pending.length > this.limits.maximumTraversalDepth) {
        throw failure(
          ReadOnlyRepositoryErrorCode.limitExceeded,
          "repository traversal depth limit was exceeded",
          "resolve-path",
          relativePath,
        );
      }
      const segment = pending.shift();
      if (segment === undefined) break;
      const candidate = implementation.join(this.root, ...resolvedSegments, segment);
      const stats = await this.#lstat(candidate, relativePath);
      observations.push({ path: candidate, stats });
      if (stats.isSymbolicLink()) {
        linkDepth += 1;
        if (linkDepth > this.limits.maximumSymlinkDepth) {
          throw failure(
            ReadOnlyRepositoryErrorCode.limitExceeded,
            "repository symbolic-link depth limit was exceeded",
            "resolve-link",
            relativePath,
          );
        }
        const linkKey = `${candidate}\0${String(stats.dev)}\0${String(stats.ino)}`;
        if (visitedLinks.has(linkKey)) {
          throw failure(
            ReadOnlyRepositoryErrorCode.symlinkLoop,
            "repository symbolic-link loop was detected",
            "resolve-link",
            relativePath,
          );
        }
        visitedLinks.add(linkKey);
        const linkValue = await this.#readlink(candidate, relativePath);
        if (
          containsUnsafeText(linkValue) ||
          (this.#flavor === "posix" && linkValue.includes("\\"))
        ) {
          throw failure(
            ReadOnlyRepositoryErrorCode.invalidPath,
            "repository symbolic link contains an invalid target",
            "resolve-link",
            relativePath,
          );
        }
        const linkFinal = await this.#lstat(candidate, relativePath);
        if (!sameEntry(stats, linkFinal) || !linkFinal.isSymbolicLink()) {
          throw failure(
            ReadOnlyRepositoryErrorCode.pathChanged,
            "repository symbolic link changed while resolving",
            "resolve-link",
            relativePath,
          );
        }
        let target: string;
        if (implementation.isAbsolute(linkValue)) {
          try {
            target = normalizeRepositorySelectionPath(linkValue, this.#flavor);
          } catch {
            throw failure(
              ReadOnlyRepositoryErrorCode.outsideRoot,
              "repository symbolic link target is outside the selected root",
              "resolve-link",
              relativePath,
            );
          }
        } else {
          if (this.#flavor === "win32" && /^[A-Za-z]:/u.test(linkValue)) {
            throw failure(
              ReadOnlyRepositoryErrorCode.outsideRoot,
              "repository symbolic link target is outside the selected root",
              "resolve-link",
              relativePath,
            );
          }
          target = implementation.resolve(implementation.dirname(candidate), linkValue);
        }
        if (isOutside(this.root, target, this.#flavor)) {
          throw failure(
            ReadOnlyRepositoryErrorCode.outsideRoot,
            "repository symbolic link target is outside the selected root",
            "resolve-link",
            relativePath,
          );
        }
        const targetRelative = implementation.relative(this.root, target);
        resolvedSegments = [];
        pending = [...targetRelative.split(/[\\/]/u).filter((part) => part.length > 0), ...pending];
        continue;
      }
      const isLast = pending.length === 0;
      if (!isLast && !stats.isDirectory()) {
        throw failure(
          ReadOnlyRepositoryErrorCode.notDirectory,
          "repository path component is not a directory",
          "resolve-path",
          relativePath,
        );
      }
      resolvedSegments.push(segment);
    }

    const absolutePath = repositoryRelativePathToAbsolute(
      this.root,
      canonicalizeRepositoryRelativePath(resolvedSegments.join("/")),
      this.#flavor,
    );
    const stats = observations.at(-1)?.stats;
    if (stats === undefined) {
      throw failure(
        ReadOnlyRepositoryErrorCode.pathUnavailable,
        "repository path could not be resolved",
        "resolve-path",
        relativePath,
      );
    }
    return {
      absolutePath,
      linkDepth,
      observations: Object.freeze(observations),
      path: relativePath,
      stats,
    };
  }

  #assertSupportedType(stats: BigIntStats, pathValue: RepositoryRelativePath): void {
    if (!stats.isDirectory() && !stats.isFile()) {
      throw failure(
        ReadOnlyRepositoryErrorCode.unsafeType,
        "repository entry is not a regular file or directory",
        "inspect-type",
        pathValue,
      );
    }
    if (stats.isFile()) this.#assertUnambiguousFile(stats, pathValue);
  }

  #assertUnambiguousFile(stats: BigIntStats, pathValue: RepositoryRelativePath): void {
    if (stats.nlink !== 1n) {
      throw failure(
        ReadOnlyRepositoryErrorCode.hardLink,
        "repository file has ambiguous hard-link identity",
        "inspect-hard-link",
        pathValue,
      );
    }
  }

  #boundedFileSize(stats: BigIntStats, pathValue: RepositoryRelativePath): number {
    if (stats.size < 0n || stats.size > BigInt(this.limits.maximumFileBytes)) {
      throw failure(
        ReadOnlyRepositoryErrorCode.limitExceeded,
        "repository file exceeds the per-file byte limit",
        "file-size",
        pathValue,
      );
    }
    return Number(stats.size);
  }

  #consumeEntries(count: number, pathValue: RepositoryRelativePath): void {
    if (count < 0 || this.#usage.entries + count > this.limits.maximumEntries) {
      throw failure(
        ReadOnlyRepositoryErrorCode.limitExceeded,
        "repository entry-count limit was exceeded",
        "entry-limit",
        pathValue,
      );
    }
    this.#usage.entries += count;
  }

  #consumeBytes(count: number, pathValue: RepositoryRelativePath): void {
    if (count < 0 || this.#usage.totalBytes + count > this.limits.maximumTotalBytes) {
      throw failure(
        ReadOnlyRepositoryErrorCode.limitExceeded,
        "repository aggregate byte limit was exceeded",
        "byte-limit",
        pathValue,
      );
    }
    this.#usage.totalBytes += count;
  }

  async #recheck(resolved: ResolvedEntry): Promise<void> {
    for (const observation of resolved.observations) {
      const finalStats = await this.#lstat(observation.path, resolved.path);
      const stable = observation.stats.isDirectory()
        ? sameDirectory(observation.stats, finalStats)
        : sameEntry(observation.stats, finalStats);
      if (!stable) {
        throw failure(
          ReadOnlyRepositoryErrorCode.pathChanged,
          "repository path changed during read-only access",
          "recheck-path",
          resolved.path,
        );
      }
    }
  }

  #entry(resolved: ResolvedEntry): ReadOnlyRepositoryEntry {
    this.#assertSupportedType(resolved.stats, resolved.path);
    const type = resolved.stats.isDirectory() ? "directory" : "file";
    return Object.freeze({
      identity: identityOf(resolved.stats),
      linkDepth: resolved.linkDepth,
      path: resolved.path,
      size: type === "file" ? this.#boundedFileSize(resolved.stats, resolved.path) : 0,
      type,
    });
  }

  async #openFile(target: string, pathValue: RepositoryRelativePath): Promise<FileHandle> {
    this.#countOperation(pathValue);
    let operation: Promise<FileHandle> | undefined;
    try {
      const flags =
        process.platform === "win32"
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NOFOLLOW;
      operation = this.#capability.open(target, flags);
      const handle = await this.#awaitBounded(operation);
      return handle;
    } catch (error: unknown) {
      // A non-cancellable platform open may settle after our deadline/cancellation race. Attach
      // cleanup immediately so a late handle cannot escape ownership.
      if (operation !== undefined && isFacadeError(error)) {
        void operation.then(async (handle) => handle.close()).catch(() => undefined);
      }
      if (isFacadeError(error)) throw error;
      throw failure(
        ReadOnlyRepositoryErrorCode.readFailed,
        "repository file cannot be opened safely",
        "open-file",
        pathValue,
        platformErrorCode(error),
      );
    }
  }

  async #handleStat(handle: FileHandle, pathValue: RepositoryRelativePath): Promise<BigIntStats> {
    this.#countOperation(pathValue);
    try {
      const stats = await this.#awaitBounded(handle.stat({ bigint: true }));
      return stats;
    } catch (error: unknown) {
      if (isFacadeError(error)) throw error;
      throw failure(
        ReadOnlyRepositoryErrorCode.readFailed,
        "repository file handle cannot be inspected safely",
        "stat-file",
        pathValue,
        platformErrorCode(error),
      );
    }
  }

  async #handleRead(
    handle: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    pathValue: RepositoryRelativePath,
  ): Promise<number> {
    this.#countOperation(pathValue);
    try {
      const result = await this.#awaitBounded(handle.read(buffer, offset, length, offset));
      return result.bytesRead;
    } catch (error: unknown) {
      if (isFacadeError(error)) throw error;
      throw failure(
        ReadOnlyRepositoryErrorCode.readFailed,
        "repository file content cannot be read safely",
        "read-file",
        pathValue,
        platformErrorCode(error),
      );
    }
  }

  async #closeFile(handle: FileHandle, pathValue: RepositoryRelativePath): Promise<void> {
    try {
      await this.#awaitBounded(handle.close());
    } catch (error: unknown) {
      if (isFacadeError(error)) throw error;
      throw failure(
        ReadOnlyRepositoryErrorCode.closeFailed,
        "repository file handle could not be closed safely",
        "close-file",
        pathValue,
        platformErrorCode(error),
      );
    }
  }

  async #readStableFile(resolved: ResolvedEntry, expectedBytes: number): Promise<Uint8Array> {
    const handle = await this.#openFile(resolved.absolutePath, resolved.path);
    let primaryError: unknown;
    let hasPrimaryError = false;
    let content: Uint8Array | undefined;
    try {
      const openedStats = await this.#handleStat(handle, resolved.path);
      if (!sameEntry(resolved.stats, openedStats) || !openedStats.isFile()) {
        throw failure(
          ReadOnlyRepositoryErrorCode.pathChanged,
          "repository file changed before reading",
          "read-file",
          resolved.path,
        );
      }
      this.#assertUnambiguousFile(openedStats, resolved.path);
      const buffer = Buffer.alloc(expectedBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const remaining = buffer.length - bytesRead;
        const fragment = await this.#handleRead(
          handle,
          buffer,
          bytesRead,
          remaining,
          resolved.path,
        );
        if (!Number.isSafeInteger(fragment) || fragment < 0 || fragment > remaining) {
          throw failure(
            ReadOnlyRepositoryErrorCode.pathChanged,
            "repository file returned an invalid read length",
            "read-file",
            resolved.path,
          );
        }
        if (fragment === 0) {
          if (bytesRead !== expectedBytes) {
            throw failure(
              ReadOnlyRepositoryErrorCode.pathChanged,
              "repository file ended before its advertised size",
              "read-file",
              resolved.path,
            );
          }
          break;
        }
        bytesRead += fragment;
        if (bytesRead > expectedBytes) {
          throw failure(
            ReadOnlyRepositoryErrorCode.pathChanged,
            "repository file grew while it was being read",
            "read-file",
            resolved.path,
          );
        }
      }
      const completedStats = await this.#handleStat(handle, resolved.path);
      if (!sameEntry(openedStats, completedStats)) {
        throw failure(
          ReadOnlyRepositoryErrorCode.pathChanged,
          "repository file changed while it was being read",
          "read-file",
          resolved.path,
        );
      }
      content = buffer.subarray(0, expectedBytes);
    } catch (error: unknown) {
      primaryError = error;
      hasPrimaryError = true;
    }
    if (hasPrimaryError) {
      try {
        await this.#closeFile(handle, resolved.path);
      } catch {
        // Preserve the authoritative primary validation/read/cancellation failure.
      }
      throw primaryError;
    }
    await this.#closeFile(handle, resolved.path);
    await this.#recheck(resolved);
    if (content === undefined) {
      throw failure(
        ReadOnlyRepositoryErrorCode.readFailed,
        "repository file did not produce content",
        "read-file",
        resolved.path,
      );
    }
    return content;
  }
}

function initialNow(capability: ReadOnlyRepositoryFileSystemCapability): number {
  let value: number;
  try {
    value = capability.now();
  } catch {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidOptions,
      "trusted filesystem clock failed",
      "clock",
    );
  }
  if (!Number.isFinite(value)) {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidOptions,
      "trusted filesystem clock is invalid",
      "clock",
    );
  }
  return value;
}

interface InitialValidationState {
  readonly capability: ReadOnlyRepositoryFileSystemCapability;
  readonly options: OptionsSnapshot;
  readonly startedAt: number;
  lastNow: number;
  metadataOperations: number;
}

function initialMonotonicNow(state: InitialValidationState): number {
  state.lastNow = Math.max(state.lastNow, initialNow(state.capability));
  return state.lastNow;
}

function initialCheckpoint(state: InitialValidationState): void {
  const signalState =
    state.options.signal === undefined ? false : intrinsicAbortState(state.options.signal);
  if (signalState === undefined) {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidOptions,
      "read-only repository cancellation signal is invalid",
      "validate-signal",
    );
  }
  if (signalState) {
    throw failure(
      ReadOnlyRepositoryErrorCode.aborted,
      "read-only repository operation was cancelled",
      "cancel",
    );
  }
  const elapsed = Math.max(0, initialMonotonicNow(state) - state.startedAt);
  if (elapsed > state.options.limits.maximumDurationMs) {
    throw failure(
      ReadOnlyRepositoryErrorCode.deadlineExceeded,
      "read-only repository deadline was exceeded",
      "deadline",
    );
  }
}

async function initialOperation<Result>(
  state: InitialValidationState,
  start: () => Promise<Result>,
): Promise<Result> {
  initialCheckpoint(state);
  state.metadataOperations += 1;
  if (state.metadataOperations > state.options.limits.maximumMetadataOperations) {
    throw failure(
      ReadOnlyRepositoryErrorCode.limitExceeded,
      "repository metadata operation limit was exceeded",
      "metadata-limit",
    );
  }
  const operation = start();
  const elapsed = Math.max(0, initialMonotonicNow(state) - state.startedAt);
  const remaining = Math.max(1, Math.ceil(state.options.limits.maximumDurationMs - elapsed));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        failure(
          ReadOnlyRepositoryErrorCode.deadlineExceeded,
          "read-only repository deadline was exceeded",
          "deadline",
        ),
      );
    }, remaining);
  });
  const contenders: Promise<Result>[] = [operation, deadline];
  if (state.options.signal !== undefined) {
    const cancelled = new Promise<never>((_resolve, reject) => {
      abortListener = (): void => {
        reject(
          failure(
            ReadOnlyRepositoryErrorCode.aborted,
            "read-only repository operation was cancelled",
            "cancel",
          ),
        );
      };
      EventTarget.prototype.addEventListener.call(state.options.signal, "abort", abortListener, {
        once: true,
      });
      if (intrinsicAbortState(state.options.signal)) abortListener();
    });
    contenders.push(cancelled);
  }
  try {
    const result = await Promise.race(contenders);
    initialCheckpoint(state);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (state.options.signal !== undefined && abortListener !== undefined) {
      EventTarget.prototype.removeEventListener.call(state.options.signal, "abort", abortListener);
    }
  }
}

async function validateInitialRoot(
  selection: SelectionSnapshot,
  state: InitialValidationState,
): Promise<void> {
  let lexicalStats: BigIntStats;
  let canonical: string;
  let canonicalStats: BigIntStats;
  try {
    lexicalStats = await initialOperation(state, () => state.capability.lstat(selection.root));
    canonical = normalizeRepositorySelectionPath(
      await initialOperation(state, () => state.capability.realpath(selection.root)),
      pathFlavor(),
    );
    canonicalStats = await initialOperation(state, () => state.capability.lstat(canonical));
  } catch (error: unknown) {
    if (isFacadeError(error)) throw error;
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidSelection,
      "selected repository root cannot be revalidated",
      "validate-root",
      undefined,
      platformErrorCode(error),
    );
  }
  if (
    canonical !== selection.root ||
    lexicalStats.isSymbolicLink() ||
    !lexicalStats.isDirectory() ||
    !canonicalStats.isDirectory() ||
    !sameIdentity(lexicalStats, selection.identity) ||
    !sameIdentity(canonicalStats, selection.identity)
  ) {
    throw failure(
      ReadOnlyRepositoryErrorCode.invalidSelection,
      "selected repository root identity is invalid",
      "validate-root",
    );
  }
}

/** Create a bounded read-only facade over an already accepted C01 repository-root selection. */
export async function createReadOnlyRepository(
  selection: RepositoryRootSelection,
  options?: ReadOnlyRepositoryOptions,
): Promise<ReadOnlyRepository> {
  return createReadOnlyRepositoryWithFileSystem(selection, options, DEFAULT_CAPABILITY);
}

/** Trusted capability-injected form for deterministic race tests and future internal composition. */
export async function createReadOnlyRepositoryWithFileSystem(
  selection: RepositoryRootSelection,
  options: ReadOnlyRepositoryOptions | undefined,
  capability: ReadOnlyRepositoryFileSystemCapability,
): Promise<ReadOnlyRepository> {
  const selectionSnapshot = snapshotSelection(selection);
  const optionsSnapshot = snapshotOptions(options);
  const startedAt = initialNow(capability);
  const initialState: InitialValidationState = {
    capability,
    lastNow: startedAt,
    metadataOperations: 0,
    options: optionsSnapshot,
    startedAt,
  };
  initialCheckpoint(initialState);
  await validateInitialRoot(selectionSnapshot, initialState);
  return new ReadOnlyRepositoryFacade(
    selectionSnapshot,
    optionsSnapshot,
    capability,
    startedAt,
    initialState.lastNow,
    initialState.metadataOperations,
  );
}
