import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { types as nodeTypes } from "node:util";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";

import { BUILT_IN_IGNORE_PATTERNS } from "./built-in-ignore-patterns.js";
import { ReadOnlyRepositoryError, ReadOnlyRepositoryErrorCode } from "./read-only-filesystem.js";
import type { ReadOnlyRepository, ReadOnlyRepositoryEntry } from "./read-only-filesystem.js";

export interface TrackedFileEnumerationLimits {
  readonly maximumDepth: number;
  readonly maximumDirectories: number;
  readonly maximumFiles: number;
  readonly maximumIndexBytes: number;
  readonly maximumIndexEntries: number;
  readonly maximumProblems: number;
}

export const TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS: Readonly<TrackedFileEnumerationLimits> =
  Object.freeze({
    maximumDepth: 128,
    maximumDirectories: 100_000,
    maximumFiles: 100_000,
    maximumIndexBytes: 16_777_216,
    maximumIndexEntries: 1_000_000,
    maximumProblems: 256,
  });

export const TRACKED_FILE_ENUMERATION_HARD_LIMITS: Readonly<TrackedFileEnumerationLimits> =
  Object.freeze({
    maximumDepth: 1_024,
    maximumDirectories: 1_000_000,
    maximumFiles: 1_000_000,
    maximumIndexBytes: 16_777_216,
    maximumIndexEntries: 1_000_000,
    maximumProblems: 4_096,
  });

export interface TrackedFileEnumerationOptions {
  readonly maximumDepth?: number;
  readonly maximumDirectories?: number;
  readonly maximumFiles?: number;
  readonly maximumIndexBytes?: number;
  readonly maximumIndexEntries?: number;
  readonly maximumProblems?: number;
}

export type TrackedFileEnumerationSource = "filesystem-fallback" | "git-index";
export type TrackedFileEnumerationReason =
  | "git-directory-missing"
  | "git-index-malformed"
  | "git-index-missing"
  | "git-index-unsupported"
  | "git-metadata-unsafe"
  | "git-worktree-external-metadata"
  | "verified-git-index";

export interface TrackedFileEnumerationProblem {
  readonly code: string;
  readonly path: RepositoryRelativePath;
}

const BUILT_IN_DIRECTORY_ROOTS = Object.freeze(
  BUILT_IN_IGNORE_PATTERNS.map((pattern) => pattern.slice(0, -1)),
);

function isBuiltInIgnoredPath(path: RepositoryRelativePath): boolean {
  return BUILT_IN_DIRECTORY_ROOTS.some((root) => path === root || path.endsWith(`/${root}`));
}

export interface TrackedFileEnumerationResult {
  readonly certainty: "all-files-not-tracked" | "tracked";
  readonly indexObjectFormat?: "sha1" | "sha256";
  readonly indexVersion?: 2 | 3 | 4;
  readonly limits: TrackedFileEnumerationLimits;
  readonly omittedProblems: number;
  readonly paths: readonly RepositoryRelativePath[];
  readonly problems: readonly TrackedFileEnumerationProblem[];
  readonly reason: TrackedFileEnumerationReason;
  readonly source: TrackedFileEnumerationSource;
}

export const TrackedFileEnumerationErrorCode: Readonly<{
  invalidOptions: "TRACKED_FILE_ENUMERATION_INVALID_OPTIONS";
  limitExceeded: "TRACKED_FILE_ENUMERATION_LIMIT_EXCEEDED";
}> = Object.freeze({
  invalidOptions: "TRACKED_FILE_ENUMERATION_INVALID_OPTIONS",
  limitExceeded: "TRACKED_FILE_ENUMERATION_LIMIT_EXCEEDED",
});

export class TrackedFileEnumerationError extends Error {
  override readonly name = "TrackedFileEnumerationError" as const;
  readonly code: (typeof TrackedFileEnumerationErrorCode)[keyof typeof TrackedFileEnumerationErrorCode];
  readonly operation: string;

  constructor(
    code: (typeof TrackedFileEnumerationErrorCode)[keyof typeof TrackedFileEnumerationErrorCode],
    message: string,
    operation: string,
  ) {
    super(message);
    this.code = code;
    this.operation = operation;
    Object.freeze(this);
  }
}

export interface ParsedGitIndexEntry {
  readonly ctimeNanoseconds: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly mtimeNanoseconds: string;
  readonly objectId: string;
  readonly path: RepositoryRelativePath;
  readonly size: number;
  readonly stage: 0 | 1 | 2 | 3;
}

export interface ParsedGitIndex {
  readonly entries: readonly ParsedGitIndexEntry[];
  readonly objectFormat: "sha1" | "sha256";
  readonly paths: readonly RepositoryRelativePath[];
  readonly version: 2 | 3 | 4;
}

class IndexFailure extends Error {
  readonly kind: "malformed" | "unsupported";
  constructor(kind: "malformed" | "unsupported") {
    super("Git index cannot be used safely");
    this.kind = kind;
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const INDEX_HEADER_BYTES = 12;

function fail(kind: "malformed" | "unsupported" = "malformed"): never {
  throw new IndexFailure(kind);
}

function byteAt(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  return value ?? fail();
}

function u16(bytes: Uint8Array, offset: number, end: number): number {
  if (offset + 2 > end) fail();
  return (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1);
}

function u32(bytes: Uint8Array, offset: number, end: number): number {
  if (offset + 4 > end) fail();
  return (
    byteAt(bytes, offset) * 0x1000000 +
    (byteAt(bytes, offset + 1) << 16) +
    (byteAt(bytes, offset + 2) << 8) +
    byteAt(bytes, offset + 3)
  );
}

function nul(bytes: Uint8Array, start: number, end: number): number {
  for (let offset = start; offset < end; offset += 1) if (bytes[offset] === 0) return offset;
  return fail();
}

function v4Remove(bytes: Uint8Array, start: number, end: number): readonly [number, number] {
  let value = 0;
  let offset = start;
  for (let count = 0; count < 10; count += 1) {
    if (offset >= end) fail();
    const byte = byteAt(bytes, offset++);
    if (value > Math.floor(Number.MAX_SAFE_INTEGER / 128)) fail();
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, offset];
    value += 1;
  }
  return fail();
}

function containsUnsafePathText(value: string): boolean {
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
  }
  return false;
}

function pathValue(raw: Uint8Array, limits: TrackedFileEnumerationLimits): RepositoryRelativePath {
  if (raw.byteLength > 16_384) return fail("unsupported");
  let text: string;
  try {
    text = UTF8.decode(raw);
  } catch {
    return fail("unsupported");
  }
  if (
    text.length === 0 ||
    containsUnsafePathText(text) ||
    text.endsWith("/") ||
    text.split("/").includes(".git") ||
    text.includes("\\")
  ) {
    return fail();
  }
  try {
    const canonical = canonicalizeRepositoryRelativePath(text, "posix");
    if (canonical !== text || canonical === ".") fail();
    if (canonical.split("/").length > limits.maximumDepth) fail("unsupported");
    return canonical;
  } catch (error: unknown) {
    if (error instanceof IndexFailure) throw error;
    return fail();
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = byteAt(left, index) - byteAt(right, index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function parseCandidate(
  bytes: Uint8Array,
  oidBytes: 20 | 32,
  limits: TrackedFileEnumerationLimits,
): ParsedGitIndex {
  const checksumBytes = oidBytes;
  if (bytes.length < INDEX_HEADER_BYTES + checksumBytes) fail();
  const contentEnd = bytes.length - checksumBytes;
  const algorithm = oidBytes === 20 ? "sha1" : "sha256";
  const expected = createHash(algorithm).update(bytes.subarray(0, contentEnd)).digest();
  if (!expected.equals(Buffer.from(bytes.subarray(contentEnd)))) fail();
  if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "DIRC") fail();
  const version = u32(bytes, 4, contentEnd);
  if (version !== 2 && version !== 3 && version !== 4) fail("unsupported");
  const entryCount = u32(bytes, 8, contentEnd);
  if (entryCount > limits.maximumIndexEntries || entryCount > limits.maximumFiles) {
    fail("unsupported");
  }
  let offset = INDEX_HEADER_BYTES;
  let previousRaw: Uint8Array = new Uint8Array();
  let previousStage = -1;
  const paths: RepositoryRelativePath[] = [];
  const entries: ParsedGitIndexEntry[] = [];
  const seen = new Set<string>();
  const lower = new Map<string, string>();
  let previousUnique: RepositoryRelativePath | undefined;
  for (let index = 0; index < entryCount; index += 1) {
    const entryStart = offset;
    const fixed = 40 + oidBytes + 2;
    if (offset + fixed > contentEnd) fail();
    const ctimeNanoseconds = `${String(u32(bytes, offset, contentEnd))}${String(
      u32(bytes, offset + 4, contentEnd),
    ).padStart(9, "0")}`;
    const mtimeNanoseconds = `${String(u32(bytes, offset + 8, contentEnd))}${String(
      u32(bytes, offset + 12, contentEnd),
    ).padStart(9, "0")}`;
    const device = String(u32(bytes, offset + 16, contentEnd));
    const inode = String(u32(bytes, offset + 20, contentEnd));
    const mode = u32(bytes, offset + 24, contentEnd);
    if (![0o100644, 0o100755, 0o120000, 0o160000, 0o040000].includes(mode)) fail();
    const size = u32(bytes, offset + 36, contentEnd);
    const objectId = Buffer.from(bytes.subarray(offset + 40, offset + 40 + oidBytes)).toString(
      "hex",
    );
    offset += 40 + oidBytes;
    const flags = u16(bytes, offset, contentEnd);
    offset += 2;
    const extended = (flags & 0x4000) !== 0;
    if (version === 2 && extended) fail();
    let extendedFlags = 0;
    if (extended) {
      extendedFlags = u16(bytes, offset, contentEnd);
      offset += 2;
      if ((extendedFlags & ~0x6000) !== 0) fail("unsupported");
    }
    if (mode === 0o040000 || (extendedFlags & 0x4000) !== 0) fail("unsupported");
    let raw: Uint8Array;
    if (version === 4) {
      const [remove, suffixStart] = v4Remove(bytes, offset, contentEnd);
      if (remove > previousRaw.length) fail();
      const terminator = nul(bytes, suffixStart, contentEnd);
      raw = new Uint8Array(previousRaw.length - remove + terminator - suffixStart);
      raw.set(previousRaw.subarray(0, previousRaw.length - remove));
      raw.set(bytes.subarray(suffixStart, terminator), previousRaw.length - remove);
      offset = terminator + 1;
    } else {
      const terminator = nul(bytes, offset, contentEnd);
      raw = bytes.slice(offset, terminator);
      offset = terminator + 1;
      const entryLength = offset - entryStart;
      offset += (8 - (entryLength % 8)) % 8;
      if (offset > contentEnd) fail();
      for (let pad = terminator + 1; pad < offset; pad += 1) if (bytes[pad] !== 0) fail();
    }
    const nameLength = flags & 0x0fff;
    if (
      (nameLength === 0x0fff && raw.length < 0x0fff) ||
      (nameLength !== 0x0fff && nameLength !== raw.length)
    ) {
      fail();
    }
    const stage = (flags >>> 12) & 3;
    const order = compareBytes(previousRaw, raw);
    if (index > 0 && (order > 0 || (order === 0 && stage <= previousStage))) fail();
    if (order === 0 && previousStage === 0) fail();
    previousRaw = raw;
    previousStage = stage;
    const value = pathValue(raw, limits);
    entries.push(
      Object.freeze({
        ctimeNanoseconds,
        device,
        inode,
        mode,
        mtimeNanoseconds,
        objectId,
        path: value,
        size,
        stage: stage as 0 | 1 | 2 | 3,
      }),
    );
    if (stage === 0 || !seen.has(value)) {
      const folded = value.toLocaleLowerCase("en-US");
      const collision = lower.get(folded);
      if (collision !== undefined && collision !== value) fail("unsupported");
      lower.set(folded, value);
      if (!seen.has(value)) {
        if (previousUnique !== undefined && value.startsWith(`${previousUnique}/`)) fail();
        seen.add(value);
        paths.push(value);
        previousUnique = value;
      }
    }
  }
  while (offset < contentEnd) {
    if (offset + 8 > contentEnd) fail();
    const signatureBytes = bytes.subarray(offset, offset + 4);
    const signature = Buffer.from(signatureBytes).toString("ascii");
    const length = u32(bytes, offset + 4, contentEnd);
    offset += 8;
    if (offset + length > contentEnd) fail();
    if (signature === "link" || signature === "sdir") fail("unsupported");
    const first = byteAt(signatureBytes, 0);
    if (first < 0x41 || first > 0x5a) fail("unsupported");
    offset += length;
  }
  if (offset !== contentEnd) fail();
  return Object.freeze({
    entries: Object.freeze(entries),
    objectFormat: algorithm,
    paths: Object.freeze(paths.slice().sort()),
    version,
  });
}

export function parseGitIndex(
  input: Uint8Array,
  options?: TrackedFileEnumerationOptions,
): ParsedGitIndex {
  const limits = snapshotOptions(options);
  if (input.byteLength > limits.maximumIndexBytes) fail("unsupported");
  const bytes = Uint8Array.from(input);
  const candidates: ParsedGitIndex[] = [];
  let unsupported = false;
  for (const oidBytes of [20, 32] as const) {
    try {
      candidates.push(parseCandidate(bytes, oidBytes, limits));
    } catch (error: unknown) {
      if (!(error instanceof IndexFailure)) throw error;
      if (error.kind === "unsupported") unsupported = true;
    }
  }
  if (candidates.length !== 1) fail(unsupported ? "unsupported" : "malformed");
  const candidate = candidates[0];
  return candidate ?? fail();
}

/** Build exact tracked-file evidence from validated index bytes supplied by a trusted host. */
export function enumerateTrackedFilesFromGitIndexBytes(
  input: Uint8Array,
  options?: TrackedFileEnumerationOptions,
): TrackedFileEnumerationResult {
  const limits = snapshotOptions(options);
  const parsed = parseGitIndex(input, limits);
  return Object.freeze({
    certainty: "tracked" as const,
    indexObjectFormat: parsed.objectFormat,
    indexVersion: parsed.version,
    limits,
    omittedProblems: 0,
    paths: parsed.paths,
    problems: Object.freeze([]),
    reason: "verified-git-index" as const,
    source: "git-index" as const,
  });
}

function snapshotOptions(value: unknown): Readonly<TrackedFileEnumerationLimits> {
  if (value === undefined) return TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS;
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TrackedFileEnumerationError(
      TrackedFileEnumerationErrorCode.invalidOptions,
      "tracked-file enumeration options must be a plain object",
      "validate-options",
    );
  }
  const allowed = Object.keys(TRACKED_FILE_ENUMERATION_HARD_LIMITS);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new TrackedFileEnumerationError(
      TrackedFileEnumerationErrorCode.invalidOptions,
      "tracked-file enumeration options contain an unknown field",
      "validate-options",
    );
  }
  const limits = { ...TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS };
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const maximum = TRACKED_FILE_ENUMERATION_HARD_LIMITS[key as keyof TrackedFileEnumerationLimits];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TrackedFileEnumerationError(
        TrackedFileEnumerationErrorCode.invalidOptions,
        "tracked-file enumeration options contain an accessor",
        "validate-options",
      );
    }
    const candidate: unknown = descriptor.value;
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > maximum
    ) {
      throw new TrackedFileEnumerationError(
        TrackedFileEnumerationErrorCode.invalidOptions,
        "tracked-file enumeration limit is outside supported bounds",
        "validate-options",
      );
    }
    limits[key as keyof TrackedFileEnumerationLimits] = candidate;
  }
  return Object.freeze(limits);
}

function fallbackEligible(error: unknown): boolean {
  const fatalCodes = new Set<ReadOnlyRepositoryErrorCode>([
    ReadOnlyRepositoryErrorCode.aborted,
    ReadOnlyRepositoryErrorCode.concurrentOperation,
    ReadOnlyRepositoryErrorCode.deadlineExceeded,
    ReadOnlyRepositoryErrorCode.invalidOptions,
    ReadOnlyRepositoryErrorCode.invalidSelection,
    ReadOnlyRepositoryErrorCode.limitExceeded,
    ReadOnlyRepositoryErrorCode.pathChanged,
  ]);
  return error instanceof ReadOnlyRepositoryError && !fatalCodes.has(error.code);
}

async function filesystemFallback(
  repository: ReadOnlyRepository,
  limits: Readonly<TrackedFileEnumerationLimits>,
  reason: Exclude<TrackedFileEnumerationReason, "verified-git-index">,
): Promise<TrackedFileEnumerationResult> {
  const paths: RepositoryRelativePath[] = [];
  const problems: TrackedFileEnumerationProblem[] = [];
  let omittedProblems = 0;
  const recordProblem = (problem: TrackedFileEnumerationProblem): void => {
    if (problems.length < limits.maximumProblems) {
      problems.push(Object.freeze(problem));
    } else {
      omittedProblems += 1;
    }
  };
  const pending: { depth: number; path: RepositoryRelativePath }[] = [
    { depth: 0, path: canonicalizeRepositoryRelativePath(".") },
  ];
  const directories = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (directories.size >= limits.maximumDirectories || current.depth > limits.maximumDepth) {
      throw new TrackedFileEnumerationError(
        TrackedFileEnumerationErrorCode.limitExceeded,
        "filesystem fallback traversal limit was exceeded",
        "fallback-limit",
      );
    }
    let directory;
    try {
      directory = await repository.readDirectory(current.path);
    } catch (error: unknown) {
      if (!fallbackEligible(error)) throw error;
      recordProblem({ code: (error as ReadOnlyRepositoryError).code, path: current.path });
      continue;
    }
    const identity = `${directory.identity.device}:${directory.identity.inode}`;
    if (directories.has(identity)) {
      recordProblem({ code: "DIRECTORY_IDENTITY_REPEATED", path: current.path });
      continue;
    }
    directories.add(identity);
    const childDirectories: { depth: number; path: RepositoryRelativePath }[] = [];
    for (const child of directory.entries) {
      if (child === ".git" || child.endsWith("/.git")) continue;
      let entry: ReadOnlyRepositoryEntry;
      try {
        entry = await repository.inspect(child);
      } catch (error: unknown) {
        if (
          error instanceof ReadOnlyRepositoryError &&
          error.code === ReadOnlyRepositoryErrorCode.limitExceeded &&
          error.operation === "file-size"
        ) {
          recordProblem({ code: error.code, path: child });
          continue;
        }
        if (!fallbackEligible(error)) throw error;
        recordProblem({ code: (error as ReadOnlyRepositoryError).code, path: child });
        continue;
      }
      if (entry.type === "directory" && isBuiltInIgnoredPath(child)) {
        recordProblem({ code: "BUILT_IN_DIRECTORY_PRUNED", path: child });
        continue;
      }
      if (entry.type === "directory" && entry.linkDepth === 0) {
        childDirectories.push({ depth: current.depth + 1, path: child });
      } else if (entry.type === "file") {
        if (paths.length >= limits.maximumFiles) {
          throw new TrackedFileEnumerationError(
            TrackedFileEnumerationErrorCode.limitExceeded,
            "filesystem fallback file limit was exceeded",
            "fallback-limit",
          );
        }
        paths.push(child);
      } else {
        recordProblem({ code: "DIRECTORY_LINK_SKIPPED", path: child });
      }
    }
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      const child = childDirectories[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return Object.freeze({
    certainty: "all-files-not-tracked",
    limits,
    omittedProblems,
    paths: Object.freeze(paths.sort()),
    problems: Object.freeze(
      problems.sort((left, right) =>
        left.path === right.path
          ? left.code.localeCompare(right.code, "en-US")
          : left.path.localeCompare(right.path, "en-US"),
      ),
    ),
    reason,
    source: "filesystem-fallback",
  });
}

/** Enumerate bounded scanner-visible filesystem candidates for relevant-untracked proof. */
export async function enumerateRepositoryFilesForUntrackedProof(
  repository: ReadOnlyRepository,
  options?: TrackedFileEnumerationOptions,
): Promise<TrackedFileEnumerationResult> {
  return filesystemFallback(repository, snapshotOptions(options), "git-metadata-unsafe");
}

/** Enumerate verified Git-index paths, or all safe filesystem candidates with explicit uncertainty. */
export async function enumerateTrackedFiles(
  repository: ReadOnlyRepository,
  options?: TrackedFileEnumerationOptions,
): Promise<TrackedFileEnumerationResult> {
  const limits = snapshotOptions(options);
  let gitEntry: ReadOnlyRepositoryEntry;
  try {
    gitEntry = await repository.inspect(".git");
  } catch (error: unknown) {
    if (!fallbackEligible(error)) throw error;
    const reason =
      error instanceof ReadOnlyRepositoryError &&
      error.code === ReadOnlyRepositoryErrorCode.pathUnavailable
        ? "git-directory-missing"
        : "git-metadata-unsafe";
    return filesystemFallback(repository, limits, reason);
  }
  if (gitEntry.type !== "directory" || gitEntry.linkDepth !== 0) {
    return filesystemFallback(
      repository,
      limits,
      gitEntry.type === "file" ? "git-worktree-external-metadata" : "git-metadata-unsafe",
    );
  }
  let indexFile: Awaited<ReturnType<ReadOnlyRepository["readFile"]>>;
  try {
    indexFile = await repository.readFile(".git/index");
  } catch (error: unknown) {
    const indexLimit =
      error instanceof ReadOnlyRepositoryError &&
      error.code === ReadOnlyRepositoryErrorCode.limitExceeded;
    if (!fallbackEligible(error) && !indexLimit) throw error;
    return filesystemFallback(
      repository,
      limits,
      indexLimit
        ? "git-index-unsupported"
        : error instanceof ReadOnlyRepositoryError &&
            error.code === ReadOnlyRepositoryErrorCode.pathUnavailable
          ? "git-index-missing"
          : "git-metadata-unsafe",
    );
  }
  if (indexFile.linkDepth !== 0) {
    return filesystemFallback(repository, limits, "git-metadata-unsafe");
  }
  const bytes = indexFile.bytes();
  try {
    const parsed = parseGitIndex(bytes, limits);
    return Object.freeze({
      certainty: "tracked",
      indexObjectFormat: parsed.objectFormat,
      indexVersion: parsed.version,
      limits,
      omittedProblems: 0,
      paths: parsed.paths,
      problems: Object.freeze([]),
      reason: "verified-git-index",
      source: "git-index",
    });
  } catch (error: unknown) {
    if (!(error instanceof IndexFailure)) throw error;
    return filesystemFallback(
      repository,
      limits,
      error.kind === "unsupported" ? "git-index-unsupported" : "git-index-malformed",
    );
  }
}
