import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { types as nodeTypes } from "node:util";

import type { PathFlavor } from "@agent-context/core";

export const REPOSITORY_ROOT_SELECTION_LIMITS: Readonly<{
  maximumAncestorDepth: 128;
  maximumGitfileBytes: 4_096;
  maximumMetadataOperations: 1_024;
  maximumPathComponents: 256;
  maximumPathBytes: 16_384;
}> = Object.freeze({
  maximumAncestorDepth: 128,
  maximumGitfileBytes: 4_096,
  maximumMetadataOperations: 1_024,
  maximumPathComponents: 256,
  maximumPathBytes: 16_384,
});

export const REPOSITORY_ROOT_SELECTION_MODES: readonly ["discover", "explicit"] = Object.freeze([
  "discover",
  "explicit",
] as const);
export type RepositoryRootSelectionMode = (typeof REPOSITORY_ROOT_SELECTION_MODES)[number];

export const REPOSITORY_ROOT_SELECTION_REASONS: readonly [
  "explicit-path",
  "git-directory",
  "git-worktree-file",
  "non-git-directory",
] = Object.freeze([
  "explicit-path",
  "git-directory",
  "git-worktree-file",
  "non-git-directory",
] as const);
export type RepositoryRootSelectionReason = (typeof REPOSITORY_ROOT_SELECTION_REASONS)[number];

export const REPOSITORY_ROOT_SEARCH_BOUNDARIES: readonly [
  "ceiling",
  "filesystem-device",
  "filesystem-root",
] = Object.freeze(["ceiling", "filesystem-device", "filesystem-root"] as const);
export type RepositoryRootSearchBoundary = (typeof REPOSITORY_ROOT_SEARCH_BOUNDARIES)[number];

export const RepositoryRootSelectionErrorCode: Readonly<{
  aborted: "REPOSITORY_ROOT_ABORTED";
  gitMarkerChanged: "REPOSITORY_ROOT_GIT_MARKER_CHANGED";
  gitMarkerInvalid: "REPOSITORY_ROOT_GIT_MARKER_INVALID";
  gitMarkerUnavailable: "REPOSITORY_ROOT_GIT_MARKER_UNAVAILABLE";
  invalidOptions: "REPOSITORY_ROOT_INVALID_OPTIONS";
  invalidPath: "REPOSITORY_ROOT_INVALID_PATH";
  limitExceeded: "REPOSITORY_ROOT_LIMIT_EXCEEDED";
  pathChanged: "REPOSITORY_ROOT_PATH_CHANGED";
  pathNotDirectory: "REPOSITORY_ROOT_PATH_NOT_DIRECTORY";
  pathSymlink: "REPOSITORY_ROOT_PATH_SYMLINK";
  pathUnavailable: "REPOSITORY_ROOT_PATH_UNAVAILABLE";
}> = Object.freeze({
  aborted: "REPOSITORY_ROOT_ABORTED",
  gitMarkerChanged: "REPOSITORY_ROOT_GIT_MARKER_CHANGED",
  gitMarkerInvalid: "REPOSITORY_ROOT_GIT_MARKER_INVALID",
  gitMarkerUnavailable: "REPOSITORY_ROOT_GIT_MARKER_UNAVAILABLE",
  invalidOptions: "REPOSITORY_ROOT_INVALID_OPTIONS",
  invalidPath: "REPOSITORY_ROOT_INVALID_PATH",
  limitExceeded: "REPOSITORY_ROOT_LIMIT_EXCEEDED",
  pathChanged: "REPOSITORY_ROOT_PATH_CHANGED",
  pathNotDirectory: "REPOSITORY_ROOT_PATH_NOT_DIRECTORY",
  pathSymlink: "REPOSITORY_ROOT_PATH_SYMLINK",
  pathUnavailable: "REPOSITORY_ROOT_PATH_UNAVAILABLE",
} as const);

export type RepositoryRootSelectionErrorCode =
  (typeof RepositoryRootSelectionErrorCode)[keyof typeof RepositoryRootSelectionErrorCode];

/** Typed operational failure. Messages never interpolate hostile path or marker content. */
export class RepositoryRootSelectionError extends Error {
  override readonly name = "RepositoryRootSelectionError" as const;
  readonly code: RepositoryRootSelectionErrorCode;
  readonly causeCode: string | undefined;
  readonly operation: string;
  readonly path: string | undefined;

  constructor(
    code: RepositoryRootSelectionErrorCode,
    message: string,
    operation: string,
    pathValue?: string,
    causeCode?: string,
  ) {
    super(message);
    this.code = code;
    this.causeCode = causeCode;
    this.operation = operation;
    this.path = pathValue;
    Object.freeze(this);
  }
}

export interface RepositoryRootIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface RepositoryRootSelection {
  readonly gitDirectory: string | null;
  readonly identity: RepositoryRootIdentity;
  readonly inspectedAncestors: number;
  readonly lexicalRoot: string;
  readonly reason: RepositoryRootSelectionReason;
  readonly root: string;
  readonly searchBoundary: RepositoryRootSearchBoundary | null;
}

const ISSUED_REPOSITORY_ROOT_SELECTIONS = new WeakSet<object>();

/** True only for a C01 selection produced by this module instance. */
export function isIssuedRepositoryRootSelection(value: unknown): value is RepositoryRootSelection {
  return (
    typeof value === "object" && value !== null && ISSUED_REPOSITORY_ROOT_SELECTIONS.has(value)
  );
}

export interface RepositoryRootSelectionOptions {
  /** `discover` finds the nearest Git marker; `explicit` selects the exact directory. */
  readonly mode?: RepositoryRootSelectionMode;
  /** Inclusive absolute ancestor at which discovery must stop. */
  readonly ceiling?: string;
  /** A caller may lower, but never raise, the fixed ancestor-depth limit. */
  readonly maximumAncestorDepth?: number;
  readonly signal?: AbortSignal;
}

export interface RepositoryRootFileSystem {
  lstat(target: string): Promise<BigIntStats>;
  open(target: string, flags: number): Promise<FileHandle>;
  realpath(target: string): Promise<string>;
}

interface OptionsSnapshot {
  readonly ceiling?: string;
  readonly maximumAncestorDepth: number;
  readonly mode: RepositoryRootSelectionMode;
  readonly signal?: AbortSignal;
}

interface OperationBudget {
  metadataOperations: number;
}

interface SafeDirectory {
  readonly canonicalPath: string;
  readonly components: ReadonlyMap<string, BigIntStats>;
  readonly lexicalPath: string;
  readonly observations: ReadonlyMap<string, BigIntStats>;
  readonly stats: BigIntStats;
}

interface GitMarker {
  readonly gitDirectory: string;
  readonly gitDirectoryObservation: SafeDirectory | null;
  readonly gitDirectoryStats: BigIntStats;
  readonly headPath: string;
  readonly headStats: BigIntStats;
  readonly markerPath: string;
  readonly markerStats: BigIntStats;
  readonly reason: "git-directory" | "git-worktree-file";
}

const DEFAULT_FILE_SYSTEM: RepositoryRootFileSystem = Object.freeze({
  lstat: async (target: string): Promise<BigIntStats> => lstat(target, { bigint: true }),
  open: async (target: string, flags: number): Promise<FileHandle> => open(target, flags),
  realpath: async (target: string): Promise<string> => realpath(target),
});

const ABORT_SIGNAL_ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
);

function failure(
  code: RepositoryRootSelectionErrorCode,
  message: string,
  operation: string,
  pathValue?: string,
  causeCode?: string,
): RepositoryRootSelectionError {
  return new RepositoryRootSelectionError(code, message, operation, pathValue, causeCode);
}

function isRepositoryRootSelectionError(error: unknown): error is RepositoryRootSelectionError {
  if (nodeTypes.isProxy(error)) return false;
  try {
    return error instanceof RepositoryRootSelectionError;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
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
    descriptor !== undefined && "value" in descriptor
      ? (descriptor as { readonly value: unknown }).value
      : undefined;
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  const state = intrinsicAbortState(signal);
  if (state === undefined) {
    throw failure(
      RepositoryRootSelectionErrorCode.invalidOptions,
      "repository-root cancellation signal is not safely inspectable",
      "validate-signal",
    );
  }
  if (state) {
    throw failure(
      RepositoryRootSelectionErrorCode.aborted,
      "repository-root selection was cancelled",
      "cancel",
    );
  }
}

function implementationFor(flavor: PathFlavor): typeof path.posix {
  return flavor === "posix" ? path.posix : path.win32;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function containsForbiddenControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit <= 0x1f ||
      unit === 0x7f ||
      (unit >= 0x202a && unit <= 0x202e) ||
      (unit >= 0x2066 && unit <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value);
}

function isWindowsDevicePath(value: string): boolean {
  return /^[\\/]{2}[?.][\\/]/u.test(value);
}

/** Pure host-grammar validation used before every path or filesystem operation. */
export function normalizeRepositorySelectionPath(input: unknown, flavor: unknown): string {
  if (flavor !== "posix" && flavor !== "win32") {
    throw failure(
      RepositoryRootSelectionErrorCode.invalidOptions,
      "repository path flavor must be posix or win32",
      "validate-path-flavor",
    );
  }
  if (
    typeof input === "string" &&
    input.length > REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathBytes
  ) {
    throw failure(
      RepositoryRootSelectionErrorCode.limitExceeded,
      "repository path exceeds the supported byte limit",
      "path-bytes",
    );
  }
  if (
    typeof input !== "string" ||
    !hasWellFormedUnicode(input) ||
    containsForbiddenControl(input)
  ) {
    throw failure(
      RepositoryRootSelectionErrorCode.invalidPath,
      "repository paths must be well-formed Unicode without control characters",
      "validate-path",
    );
  }
  if (Buffer.byteLength(input, "utf8") > REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathBytes) {
    throw failure(
      RepositoryRootSelectionErrorCode.limitExceeded,
      "repository path exceeds the supported byte limit",
      "path-bytes",
    );
  }
  if (
    (flavor === "win32" &&
      (isWindowsDevicePath(input) ||
        /^[A-Za-z]:(?![\\/])/u.test(input) ||
        !isFullyQualifiedWindowsPath(input))) ||
    (flavor === "posix" && (!path.posix.isAbsolute(input) || input.includes("\\")))
  ) {
    throw failure(
      RepositoryRootSelectionErrorCode.invalidPath,
      "repository paths must be fully qualified paths in the selected host grammar",
      "validate-path",
    );
  }
  const implementation = implementationFor(flavor);
  const rootLength = implementation.parse(input).root.length;
  const segments = input.slice(rootLength).split(flavor === "win32" ? /[\\/]+/u : /\/+/u);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw failure(
      RepositoryRootSelectionErrorCode.invalidPath,
      "repository paths must not contain dot or parent-traversal segments",
      "validate-path",
    );
  }
  const normalized = implementation.normalize(input);
  const root = implementation.parse(normalized).root;
  let end = normalized.length;
  while (end > root.length) {
    const character = normalized[end - 1];
    if (character !== implementation.sep && !(flavor === "win32" && character === "/")) break;
    end -= 1;
  }
  return normalized.slice(0, end);
}

function snapshotOptions(options: unknown): OptionsSnapshot {
  if (options === undefined) {
    return {
      maximumAncestorDepth: REPOSITORY_ROOT_SELECTION_LIMITS.maximumAncestorDepth,
      mode: "discover",
    };
  }
  if (
    typeof options !== "object" ||
    options === null ||
    nodeTypes.isProxy(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw failure(
      RepositoryRootSelectionErrorCode.invalidOptions,
      "repository-root options must be a plain object",
      "validate-options",
    );
  }
  const allowed = ["ceiling", "maximumAncestorDepth", "mode", "signal"] as const;
  const keys = Reflect.ownKeys(options);
  if (
    keys.length > allowed.length ||
    keys.some(
      (key) => typeof key !== "string" || !allowed.includes(key as (typeof allowed)[number]),
    )
  ) {
    throw failure(
      RepositoryRootSelectionErrorCode.invalidOptions,
      "repository-root options contain an unknown field or accessor",
      "validate-options",
    );
  }
  const values = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor)
    ) {
      throw failure(
        RepositoryRootSelectionErrorCode.invalidOptions,
        "repository-root options contain an unknown field or accessor",
        "validate-options",
      );
    }
    values.set(key as string, descriptor.value as unknown);
  }
  const modeValue = values.get("mode");
  const depthValue = values.get("maximumAncestorDepth");
  const ceiling = values.get("ceiling");
  const signal = values.get("signal");
  const mode = modeValue ?? "discover";
  const maximumAncestorDepth = depthValue ?? REPOSITORY_ROOT_SELECTION_LIMITS.maximumAncestorDepth;
  if (
    (mode !== "discover" && mode !== "explicit") ||
    typeof maximumAncestorDepth !== "number" ||
    !Number.isSafeInteger(maximumAncestorDepth) ||
    maximumAncestorDepth < 0 ||
    maximumAncestorDepth > REPOSITORY_ROOT_SELECTION_LIMITS.maximumAncestorDepth ||
    (ceiling !== undefined && typeof ceiling !== "string") ||
    (signal !== undefined && !isNativeAbortSignal(signal)) ||
    (mode === "explicit" && ceiling !== undefined)
  ) {
    throw failure(
      RepositoryRootSelectionErrorCode.invalidOptions,
      "repository-root options are outside their supported bounds",
      "validate-options",
    );
  }
  return {
    ...(ceiling === undefined ? {} : { ceiling }),
    maximumAncestorDepth,
    mode,
    ...(signal === undefined ? {} : { signal }),
  };
}

function countMetadataOperation(budget: OperationBudget): void {
  budget.metadataOperations += 1;
  if (budget.metadataOperations > REPOSITORY_ROOT_SELECTION_LIMITS.maximumMetadataOperations) {
    throw failure(
      RepositoryRootSelectionErrorCode.limitExceeded,
      "repository-root metadata operation limit was exceeded",
      "metadata-limit",
    );
  }
}

async function checkedLstat(
  target: string,
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<BigIntStats> {
  throwIfAborted(signal);
  countMetadataOperation(budget);
  try {
    const result = await fileSystem.lstat(target);
    throwIfAborted(signal);
    return result;
  } catch (error: unknown) {
    if (isRepositoryRootSelectionError(error)) throw error;
    throw failure(
      RepositoryRootSelectionErrorCode.pathUnavailable,
      "a repository-root path cannot be inspected",
      "lstat",
      target,
      errorCode(error),
    );
  }
}

async function optionalLstat(
  target: string,
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<BigIntStats | undefined> {
  try {
    return await checkedLstat(target, fileSystem, budget, signal);
  } catch (error: unknown) {
    if (isRepositoryRootSelectionError(error) && error.causeCode === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function checkedRealpath(
  target: string,
  flavor: PathFlavor,
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  countMetadataOperation(budget);
  try {
    const result = await fileSystem.realpath(target);
    throwIfAborted(signal);
    return normalizeRepositorySelectionPath(result, flavor);
  } catch (error: unknown) {
    if (isRepositoryRootSelectionError(error)) throw error;
    throw failure(
      RepositoryRootSelectionErrorCode.pathUnavailable,
      "a repository-root path cannot be canonicalized",
      "realpath",
      target,
      errorCode(error),
    );
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.isDirectory() &&
    right.isDirectory()
  );
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.isFile() &&
    right.isFile()
  );
}

function sameStableEntry(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.mode === right.mode
  );
}

async function checkedGitfileHandleStat(
  handle: FileHandle,
  markerPath: string,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<BigIntStats> {
  throwIfAborted(signal);
  countMetadataOperation(budget);
  try {
    const stats = await handle.stat({ bigint: true });
    throwIfAborted(signal);
    return stats;
  } catch (error: unknown) {
    if (isRepositoryRootSelectionError(error)) throw error;
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerUnavailable,
      "Git worktree marker metadata cannot be inspected safely",
      "stat-gitfile",
      markerPath,
      errorCode(error),
    );
  }
}

async function checkedGitfileHandleRead(
  handle: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  markerPath: string,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<number> {
  throwIfAborted(signal);
  countMetadataOperation(budget);
  try {
    const result = await handle.read(buffer, offset, length, offset);
    throwIfAborted(signal);
    return result.bytesRead;
  } catch (error: unknown) {
    if (isRepositoryRootSelectionError(error)) throw error;
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerUnavailable,
      "Git worktree marker content cannot be read safely",
      "read-gitfile",
      markerPath,
      errorCode(error),
    );
  }
}

function componentPaths(absolutePath: string, flavor: PathFlavor): readonly string[] {
  const implementation = implementationFor(flavor);
  const root = implementation.parse(absolutePath).root;
  const relative = absolutePath.slice(root.length);
  const segments = relative.split(/[\\/]/u).filter((segment) => segment.length > 0);
  if (segments.length > REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathComponents) {
    throw failure(
      RepositoryRootSelectionErrorCode.limitExceeded,
      "repository path component limit was exceeded",
      "path-components",
    );
  }
  const components = [root];
  let current = root;
  for (const segment of segments) {
    current = implementation.join(current, segment);
    components.push(current);
  }
  return components;
}

function joinedSelectionPath(base: string, child: string, flavor: PathFlavor): string {
  return normalizeRepositorySelectionPath(implementationFor(flavor).join(base, child), flavor);
}

async function inspectSafeDirectory(
  absolutePath: string,
  flavor: PathFlavor,
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<SafeDirectory> {
  const observations = new Map<string, BigIntStats>();
  const lexicalComponents = componentPaths(absolutePath, flavor);
  for (const [index, component] of lexicalComponents.entries()) {
    const stats = await checkedLstat(component, fileSystem, budget, signal);
    if (index === lexicalComponents.length - 1 && stats.isSymbolicLink()) {
      throw failure(
        RepositoryRootSelectionErrorCode.pathSymlink,
        "the selected repository-root leaf must not be a symbolic link or junction",
        "inspect-directory",
        component,
      );
    }
    if (!stats.isDirectory() && !stats.isSymbolicLink()) {
      throw failure(
        RepositoryRootSelectionErrorCode.pathNotDirectory,
        "repository-root path components must be directories or stable intermediate links",
        "inspect-directory",
        component,
      );
    }
    observations.set(component, stats);
  }
  const initial = observations.get(absolutePath);
  if (initial === undefined) {
    throw failure(
      RepositoryRootSelectionErrorCode.pathUnavailable,
      "repository-root identity could not be established",
      "inspect-directory",
      absolutePath,
    );
  }
  const canonicalPath = await checkedRealpath(absolutePath, flavor, fileSystem, budget, signal);
  const components = new Map<string, BigIntStats>();
  for (const component of componentPaths(canonicalPath, flavor)) {
    const stats = await checkedLstat(component, fileSystem, budget, signal);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw failure(
        RepositoryRootSelectionErrorCode.pathChanged,
        "canonical repository-root path contains an unresolved or non-directory component",
        "inspect-canonical-directory",
        component,
      );
    }
    components.set(component, stats);
  }
  const canonicalStats = components.get(canonicalPath);
  if (canonicalStats === undefined) {
    throw failure(
      RepositoryRootSelectionErrorCode.pathUnavailable,
      "canonical repository-root identity could not be established",
      "inspect-canonical-directory",
      canonicalPath,
    );
  }
  if (!sameStableDirectory(initial, canonicalStats)) {
    throw failure(
      RepositoryRootSelectionErrorCode.pathChanged,
      "repository-root path changed while it was being selected",
      "inspect-directory",
      absolutePath,
    );
  }
  return { canonicalPath, components, lexicalPath: absolutePath, observations, stats: initial };
}

async function readGitfile(
  markerPath: string,
  markerStats: BigIntStats,
  flavor: PathFlavor,
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (markerStats.size > BigInt(REPOSITORY_ROOT_SELECTION_LIMITS.maximumGitfileBytes)) {
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerInvalid,
      "Git worktree marker exceeds the supported byte limit",
      "read-gitfile",
      markerPath,
    );
  }
  throwIfAborted(signal);
  countMetadataOperation(budget);
  let handle: FileHandle;
  try {
    const flags =
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await fileSystem.open(markerPath, flags);
  } catch (error: unknown) {
    if (isRepositoryRootSelectionError(error)) throw error;
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerUnavailable,
      "Git worktree marker cannot be opened safely",
      "open-gitfile",
      markerPath,
      errorCode(error),
    );
  }
  let gitDirectoryPath: string | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    throwIfAborted(signal);
    const openedStats = await checkedGitfileHandleStat(handle, markerPath, budget, signal);
    if (!sameStableFile(markerStats, openedStats)) {
      throw failure(
        RepositoryRootSelectionErrorCode.gitMarkerChanged,
        "Git worktree marker changed while it was being selected",
        "read-gitfile",
        markerPath,
      );
    }
    const expectedBytes = Number(openedStats.size);
    const buffer = Buffer.alloc(expectedBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const remaining = buffer.length - bytesRead;
      const fragmentBytes = await checkedGitfileHandleRead(
        handle,
        buffer,
        bytesRead,
        remaining,
        markerPath,
        budget,
        signal,
      );
      if (!Number.isSafeInteger(fragmentBytes) || fragmentBytes < 0 || fragmentBytes > remaining) {
        throw failure(
          RepositoryRootSelectionErrorCode.gitMarkerChanged,
          "Git worktree marker returned an invalid read length",
          "read-gitfile",
          markerPath,
        );
      }
      if (fragmentBytes === 0) {
        if (bytesRead !== expectedBytes) {
          throw failure(
            RepositoryRootSelectionErrorCode.gitMarkerChanged,
            "Git worktree marker ended before its advertised size",
            "read-gitfile",
            markerPath,
          );
        }
        break;
      }
      bytesRead += fragmentBytes;
      if (bytesRead > expectedBytes) {
        throw failure(
          RepositoryRootSelectionErrorCode.gitMarkerChanged,
          "Git worktree marker grew while it was being read",
          "read-gitfile",
          markerPath,
        );
      }
    }
    const completedStats = await checkedGitfileHandleStat(handle, markerPath, budget, signal);
    if (!sameStableFile(openedStats, completedStats)) {
      throw failure(
        RepositoryRootSelectionErrorCode.gitMarkerChanged,
        "Git worktree marker changed while it was being read",
        "read-gitfile",
        markerPath,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw failure(
        RepositoryRootSelectionErrorCode.gitMarkerInvalid,
        "Git worktree marker is not valid UTF-8",
        "read-gitfile",
        markerPath,
      );
    }
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (!text.startsWith("gitdir: ") || text.includes("\n") || text.includes("\r")) {
      throw failure(
        RepositoryRootSelectionErrorCode.gitMarkerInvalid,
        "Git worktree marker must contain exactly one gitdir path",
        "parse-gitfile",
        markerPath,
      );
    }
    const gitDirectoryValue = text.slice("gitdir: ".length);
    if (
      gitDirectoryValue.length === 0 ||
      !hasWellFormedUnicode(gitDirectoryValue) ||
      containsForbiddenControl(gitDirectoryValue)
    ) {
      throw failure(
        RepositoryRootSelectionErrorCode.gitMarkerInvalid,
        "Git worktree marker contains an invalid gitdir path",
        "parse-gitfile",
        markerPath,
      );
    }
    const implementation = implementationFor(flavor);
    const absoluteGitDirectory = implementation.isAbsolute(gitDirectoryValue)
      ? gitDirectoryValue
      : implementation.resolve(implementation.dirname(markerPath), gitDirectoryValue);
    try {
      gitDirectoryPath = normalizeRepositorySelectionPath(absoluteGitDirectory, flavor);
    } catch (error: unknown) {
      if (isRepositoryRootSelectionError(error)) {
        throw failure(
          RepositoryRootSelectionErrorCode.gitMarkerInvalid,
          "Git worktree marker contains an unsupported gitdir path",
          "parse-gitfile",
          markerPath,
        );
      }
      throw error;
    }
  } catch (error: unknown) {
    hasPrimaryError = true;
    primaryError = error;
  }
  if (hasPrimaryError) {
    try {
      await closeGitfile(handle, markerPath);
    } catch {
      // The typed primary read/stat/validation failure is authoritative.
    }
    throw primaryError;
  }
  await closeGitfile(handle, markerPath);
  if (gitDirectoryPath === undefined) {
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerInvalid,
      "Git worktree marker did not produce an administrative path",
      "parse-gitfile",
      markerPath,
    );
  }
  return gitDirectoryPath;
}

async function closeGitfile(handle: FileHandle, markerPath: string): Promise<void> {
  try {
    await handle.close();
  } catch (error: unknown) {
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerUnavailable,
      "Git worktree marker handle could not be closed safely",
      "close-gitfile",
      markerPath,
      errorCode(error),
    );
  }
}

async function validateHead(
  gitDirectory: string,
  flavor: PathFlavor,
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<{ readonly path: string; readonly stats: BigIntStats }> {
  const headPath = joinedSelectionPath(gitDirectory, "HEAD", flavor);
  const headStats = await optionalLstat(headPath, fileSystem, budget, signal);
  if (headStats === undefined || headStats.isSymbolicLink() || !headStats.isFile()) {
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerInvalid,
      "Git marker does not identify supported repository metadata with a regular HEAD file",
      "validate-git-head",
      headPath,
    );
  }
  return { path: headPath, stats: headStats };
}

async function inspectGitMarker(
  repositoryCandidate: string,
  markerPath: string,
  markerStats: BigIntStats,
  flavor: PathFlavor,
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<GitMarker> {
  if (markerStats.isSymbolicLink()) {
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerInvalid,
      "Git marker must not be a symbolic link or junction",
      "inspect-git-marker",
      markerPath,
    );
  }
  if (markerStats.isDirectory()) {
    const head = await validateHead(markerPath, flavor, fileSystem, budget, signal);
    return {
      gitDirectory: markerPath,
      gitDirectoryObservation: null,
      gitDirectoryStats: markerStats,
      headPath: head.path,
      headStats: head.stats,
      markerPath,
      markerStats,
      reason: "git-directory",
    };
  }
  if (!markerStats.isFile()) {
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerInvalid,
      "Git marker must be a directory or regular gitfile",
      "inspect-git-marker",
      markerPath,
    );
  }
  const gitDirectoryPath = await readGitfile(
    markerPath,
    markerStats,
    flavor,
    fileSystem,
    budget,
    signal,
  );
  let gitDirectory: SafeDirectory;
  try {
    gitDirectory = await inspectSafeDirectory(gitDirectoryPath, flavor, fileSystem, budget, signal);
  } catch (error: unknown) {
    if (isRepositoryRootSelectionError(error)) {
      throw failure(
        RepositoryRootSelectionErrorCode.gitMarkerInvalid,
        "Git worktree marker points to unavailable or unsafe repository metadata",
        "validate-gitdir",
        repositoryCandidate,
        error.causeCode,
      );
    }
    throw error;
  }
  const head = await validateHead(gitDirectory.canonicalPath, flavor, fileSystem, budget, signal);
  return {
    gitDirectory: gitDirectory.canonicalPath,
    gitDirectoryObservation: gitDirectory,
    gitDirectoryStats: gitDirectory.stats,
    headPath: head.path,
    headStats: head.stats,
    markerPath,
    markerStats,
    reason: "git-worktree-file",
  };
}

async function recheckMarker(
  marker: GitMarker,
  flavor: PathFlavor,
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (marker.gitDirectoryObservation !== null) {
    const finalGitDirectory = await recheckRoot(
      marker.gitDirectoryObservation,
      marker.gitDirectoryObservation.lexicalPath,
      marker.gitDirectoryObservation.stats,
      flavor,
      fileSystem,
      budget,
      signal,
    );
    if (finalGitDirectory !== marker.gitDirectory) {
      throw failure(
        RepositoryRootSelectionErrorCode.gitMarkerChanged,
        "Git worktree marker target changed while repository root was being selected",
        "recheck-gitdir",
        marker.markerPath,
      );
    }
  }
  const markerFinal = await optionalLstat(marker.markerPath, fileSystem, budget, signal);
  const gitDirectoryFinal = await optionalLstat(marker.gitDirectory, fileSystem, budget, signal);
  const headFinal = await optionalLstat(marker.headPath, fileSystem, budget, signal);
  const markerMatches =
    markerFinal !== undefined &&
    (marker.reason === "git-directory"
      ? sameStableDirectory(marker.markerStats, markerFinal)
      : sameStableFile(marker.markerStats, markerFinal));
  if (
    !markerMatches ||
    gitDirectoryFinal === undefined ||
    !sameStableDirectory(marker.gitDirectoryStats, gitDirectoryFinal) ||
    headFinal === undefined ||
    !sameStableFile(marker.headStats, headFinal)
  ) {
    throw failure(
      RepositoryRootSelectionErrorCode.gitMarkerChanged,
      "Git marker changed while repository root was being selected",
      "recheck-git-marker",
      marker.markerPath,
    );
  }
}

async function recheckRoot(
  root: SafeDirectory,
  selectedPath: string,
  selectedStats: BigIntStats,
  flavor: PathFlavor,
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<string> {
  for (const [observedPath, observedStats] of root.observations) {
    const finalObservation = await checkedLstat(observedPath, fileSystem, budget, signal);
    const observationIsStable = observedStats.isSymbolicLink()
      ? sameStableEntry(observedStats, finalObservation)
      : sameIdentity(observedStats, finalObservation) && finalObservation.isDirectory();
    if (!observationIsStable) {
      throw failure(
        RepositoryRootSelectionErrorCode.pathChanged,
        "repository-root path changed while it was being selected",
        "recheck-root-component",
        observedPath,
      );
    }
  }
  const finalLexical = await checkedLstat(selectedPath, fileSystem, budget, signal);
  const finalCanonicalPath = await checkedRealpath(
    selectedPath,
    flavor,
    fileSystem,
    budget,
    signal,
  );
  const finalCanonical = await checkedLstat(finalCanonicalPath, fileSystem, budget, signal);
  if (
    !sameStableDirectory(selectedStats, finalLexical) ||
    !sameStableDirectory(selectedStats, finalCanonical)
  ) {
    throw failure(
      RepositoryRootSelectionErrorCode.pathChanged,
      "repository-root path changed while it was being selected",
      "recheck-root",
      selectedPath,
    );
  }
  return finalCanonicalPath;
}

async function recheckAbsentMarkers(
  markerPaths: readonly string[],
  fileSystem: RepositoryRootFileSystem,
  budget: OperationBudget,
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const markerPath of markerPaths.toReversed()) {
    if ((await optionalLstat(markerPath, fileSystem, budget, signal)) !== undefined) {
      throw failure(
        RepositoryRootSelectionErrorCode.gitMarkerChanged,
        "Git marker appeared while repository root was being selected",
        "recheck-git-marker",
        markerPath,
      );
    }
  }
}

function lexicalSpellingFor(
  start: SafeDirectory,
  canonicalSelection: string,
  selectedStats: BigIntStats,
): string {
  const observations = [...start.observations.entries()];
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (observation !== undefined && sameIdentity(observation[1], selectedStats)) {
      return observation[0];
    }
  }
  return canonicalSelection;
}

function frozenResult(
  root: string,
  lexicalRoot: string,
  stats: BigIntStats,
  reason: RepositoryRootSelectionReason,
  gitDirectory: string | null,
  inspectedAncestors: number,
  searchBoundary: RepositoryRootSearchBoundary | null,
): RepositoryRootSelection {
  const identity = Object.freeze({ device: String(stats.dev), inode: String(stats.ino) });
  const result = Object.freeze({
    gitDirectory,
    identity,
    inspectedAncestors,
    lexicalRoot,
    reason,
    root,
    searchBoundary,
  });
  ISSUED_REPOSITORY_ROOT_SELECTIONS.add(result);
  return result;
}

function isOutside(ancestor: string, candidate: string, flavor: PathFlavor): boolean {
  const implementation = implementationFor(flavor);
  const relative = implementation.relative(ancestor, candidate);
  return (
    implementation.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${implementation.sep}`)
  );
}

/** Selects one deterministic repository root without invoking Git or reading configuration. */
export async function selectRepositoryRoot(
  startPath: string,
  options?: RepositoryRootSelectionOptions,
): Promise<RepositoryRootSelection> {
  return selectRepositoryRootWithFileSystem(startPath, options, DEFAULT_FILE_SYSTEM);
}

/** Capability-injected form used by deterministic race tests and future filesystem composition. */
export async function selectRepositoryRootWithFileSystem(
  startPath: string,
  options: RepositoryRootSelectionOptions | undefined,
  fileSystem: RepositoryRootFileSystem,
): Promise<RepositoryRootSelection> {
  const snapshot = snapshotOptions(options);
  throwIfAborted(snapshot.signal);
  const flavor: PathFlavor = process.platform === "win32" ? "win32" : "posix";
  const normalizedStart = normalizeRepositorySelectionPath(startPath, flavor);
  const normalizedCeiling =
    snapshot.ceiling === undefined
      ? undefined
      : normalizeRepositorySelectionPath(snapshot.ceiling, flavor);
  const budget: OperationBudget = { metadataOperations: 0 };
  const start = await inspectSafeDirectory(
    normalizedStart,
    flavor,
    fileSystem,
    budget,
    snapshot.signal,
  );

  if (snapshot.mode === "explicit") {
    const root = await recheckRoot(
      start,
      start.lexicalPath,
      start.stats,
      flavor,
      fileSystem,
      budget,
      snapshot.signal,
    );
    return frozenResult(root, start.lexicalPath, start.stats, "explicit-path", null, 0, null);
  }

  let ceiling: SafeDirectory | undefined;
  if (normalizedCeiling !== undefined) {
    ceiling = await inspectSafeDirectory(
      normalizedCeiling,
      flavor,
      fileSystem,
      budget,
      snapshot.signal,
    );
    if (isOutside(ceiling.canonicalPath, start.canonicalPath, flavor)) {
      throw failure(
        RepositoryRootSelectionErrorCode.invalidOptions,
        "repository-root ceiling must be an ancestor of the start directory",
        "validate-ceiling",
      );
    }
    const startCeilingStats = start.components.get(ceiling.canonicalPath);
    if (startCeilingStats === undefined || !sameIdentity(startCeilingStats, ceiling.stats)) {
      throw failure(
        RepositoryRootSelectionErrorCode.invalidOptions,
        "repository-root ceiling does not identify the selected ancestor",
        "validate-ceiling",
      );
    }
  }

  const implementation = implementationFor(flavor);
  const absentMarkers: string[] = [];
  let current = start.canonicalPath;
  let inspectedAncestors = 0;
  let boundary: RepositoryRootSearchBoundary;

  for (;;) {
    if (inspectedAncestors > snapshot.maximumAncestorDepth) {
      throw failure(
        RepositoryRootSelectionErrorCode.limitExceeded,
        "repository-root ancestor depth limit was exceeded",
        "ancestor-search",
      );
    }
    const currentStats = start.components.get(current);
    if (currentStats === undefined) {
      throw failure(
        RepositoryRootSelectionErrorCode.pathChanged,
        "repository-root ancestor identity is unavailable",
        "ancestor-search",
        current,
      );
    }
    const markerPath = joinedSelectionPath(current, ".git", flavor);
    const markerStats = await optionalLstat(markerPath, fileSystem, budget, snapshot.signal);
    if (markerStats !== undefined) {
      let marker: GitMarker;
      try {
        marker = await inspectGitMarker(
          current,
          markerPath,
          markerStats,
          flavor,
          fileSystem,
          budget,
          snapshot.signal,
        );
      } catch (error: unknown) {
        if (
          isRepositoryRootSelectionError(error) &&
          error.code === RepositoryRootSelectionErrorCode.pathUnavailable
        ) {
          throw failure(
            RepositoryRootSelectionErrorCode.gitMarkerUnavailable,
            "Git marker cannot be inspected safely",
            "inspect-git-marker",
            markerPath,
            error.causeCode,
          );
        }
        throw error;
      }
      await recheckMarker(marker, flavor, fileSystem, budget, snapshot.signal);
      const root = await recheckRoot(
        start,
        current,
        currentStats,
        flavor,
        fileSystem,
        budget,
        snapshot.signal,
      );
      await recheckAbsentMarkers(absentMarkers, fileSystem, budget, snapshot.signal);
      return frozenResult(
        root,
        lexicalSpellingFor(start, current, currentStats),
        currentStats,
        marker.reason,
        marker.gitDirectory,
        inspectedAncestors,
        null,
      );
    }
    absentMarkers.push(markerPath);

    if (current === ceiling?.canonicalPath) {
      boundary = "ceiling";
      break;
    }
    const parent = implementation.dirname(current);
    if (parent === current) {
      boundary = "filesystem-root";
      break;
    }
    const parentStats = start.components.get(parent);
    if (parentStats?.dev !== currentStats.dev) {
      boundary = "filesystem-device";
      break;
    }
    current = parent;
    inspectedAncestors += 1;
  }

  const root = await recheckRoot(
    start,
    start.lexicalPath,
    start.stats,
    flavor,
    fileSystem,
    budget,
    snapshot.signal,
  );
  await recheckAbsentMarkers(absentMarkers, fileSystem, budget, snapshot.signal);
  return frozenResult(
    root,
    start.lexicalPath,
    start.stats,
    "non-git-directory",
    null,
    inspectedAncestors,
    boundary,
  );
}
