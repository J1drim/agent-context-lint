import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";

import { isIssuedRepositoryRootSelection } from "./repository-root.js";
import {
  enumerateTrackedFilesFromGitIndexBytes,
  parseGitIndex,
} from "./tracked-file-enumeration.js";

import type { RepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRootSelection } from "./repository-root.js";
import type {
  TrackedFileEnumerationOptions,
  TrackedFileEnumerationResult,
} from "./tracked-file-enumeration.js";

export const CHANGED_FILE_METADATA_CONTRACT_VERSION = "0.1.0" as const;
export const CHANGED_FILE_METADATA_RECORD_KIND = "agent-context-git-changed-file-metadata" as const;

export interface ChangedFileMetadataLimits {
  readonly maximumBaseReferenceBytes: number;
  readonly maximumBaseReferenceCodeUnits: number;
  readonly maximumChangedPaths: number;
  readonly maximumCommandDurationMs: number;
  readonly maximumCommandOutputBytes: number;
  readonly maximumPathBytes: number;
}

export const CHANGED_FILE_METADATA_LIMITS: Readonly<ChangedFileMetadataLimits> = Object.freeze({
  maximumBaseReferenceBytes: 1_024,
  maximumBaseReferenceCodeUnits: 1_024,
  maximumChangedPaths: 100_000,
  maximumCommandDurationMs: 30_000,
  maximumCommandOutputBytes: 16_777_216,
  maximumPathBytes: 16_384,
});

export type GitMetadataRequestKind =
  "resolve-base" | "resolve-head" | "merge-bases" | "diff" | "index-state" | "worktree-state";

export interface GitMetadataRequest {
  readonly arguments: readonly string[];
  readonly kind: GitMetadataRequestKind;
  readonly policy: GitMetadataExecutionPolicy;
}

export interface GitMetadataExecutionPolicy {
  readonly disableGlobalConfiguration: true;
  readonly disableSystemConfiguration: true;
  readonly environment: Readonly<{
    GIT_CONFIG_NOSYSTEM: "1";
    GIT_NO_LAZY_FETCH: "1";
    GIT_OPTIONAL_LOCKS: "0";
    GIT_PAGER: "cat";
    GIT_TERMINAL_PROMPT: "0";
  }>;
  readonly inheritEnvironment: false;
  readonly maximumDurationMs: number;
  readonly network: "denied";
  readonly repositoryWrites: "denied";
}

export interface GitMetadataResponse {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
}

export type GitMetadataExecutor = (
  request: GitMetadataRequest,
  signal: AbortSignal,
) => GitMetadataResponse | Promise<GitMetadataResponse>;

export interface GitMetadataCapability {
  readonly contractVersion: typeof CHANGED_FILE_METADATA_CONTRACT_VERSION;
  readonly kind: "agent-context-git-metadata-capability";
}

export interface ChangedFileScanScope {
  readonly contractVersion: typeof CHANGED_FILE_METADATA_CONTRACT_VERSION;
  readonly kind: "agent-context-changed-file-scan-scope";
}

export interface CollectGitChangedFileMetadataInput {
  readonly baseReference: string;
  readonly signal: AbortSignal;
}

export type GitChangeStatus =
  "added" | "copied" | "deleted" | "modified" | "renamed" | "type-changed";

export interface GitChangedPath {
  readonly path: RepositoryRelativePath;
  readonly previousPath: RepositoryRelativePath | null;
  readonly status: GitChangeStatus;
}

export type GitChangedFileFallbackReason =
  | "cancelled"
  | "command-failed"
  | "invalid-base-reference"
  | "invalid-command-output"
  | "multiple-merge-bases"
  | "no-merge-base"
  | "resource-limit"
  | "repository-changed"
  | "unsupported-change-state"
  | "untracked-files";

interface GitChangedFileMetadataBase {
  readonly baseReference: string;
  readonly contractVersion: typeof CHANGED_FILE_METADATA_CONTRACT_VERSION;
  readonly recordKind: typeof CHANGED_FILE_METADATA_RECORD_KIND;
}

export interface GitChangedFileMetadataReady extends GitChangedFileMetadataBase {
  readonly baseCommit: string;
  readonly changes: readonly GitChangedPath[];
  readonly headCommit: string;
  readonly indexStateSha256: string;
  readonly indexObjectFormat: "sha1" | "sha256";
  readonly indexVersion: 2 | 3 | 4;
  readonly mergeBase: string;
  readonly state: "ready";
  readonly trackedPaths: readonly RepositoryRelativePath[];
  readonly worktreeStateSha256: string;
}

export interface GitChangedFileMetadataFallback extends GitChangedFileMetadataBase {
  readonly reason: GitChangedFileFallbackReason;
  readonly state: "fallback";
}

export type GitChangedFileMetadata = GitChangedFileMetadataFallback | GitChangedFileMetadataReady;

const ISSUED_SCOPES = new WeakSet<object>();
const SCOPE_SELECTIONS = new WeakMap<object, RepositoryRootSelection>();
const ISSUED_CAPABILITIES = new WeakMap<
  object,
  Readonly<{ readonly executor: GitMetadataExecutor; readonly scope: ChangedFileScanScope }>
>();
const ISSUED_METADATA = new WeakSet<object>();
const METADATA_SCOPES = new WeakMap<object, ChangedFileScanScope>();
const METADATA_INDEX_BYTES = new WeakMap<object, Uint8Array>();
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
const ADD_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "addEventListener",
)?.value as (this: EventTarget, type: string, listener: () => void, options?: unknown) => void;
const REMOVE_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "removeEventListener",
)?.value as (this: EventTarget, type: string, listener: () => void) => void;
const EXECUTION_POLICY: GitMetadataExecutionPolicy = Object.freeze({
  disableGlobalConfiguration: true,
  disableSystemConfiguration: true,
  environment: Object.freeze({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  }),
  inheritEnvironment: false,
  maximumDurationMs: CHANGED_FILE_METADATA_LIMITS.maximumCommandDurationMs,
  network: "denied",
  repositoryWrites: "denied",
});

function aborted(signal: AbortSignal): boolean {
  try {
    return ABORTED_DESCRIPTOR?.get?.call(signal) !== false;
  } catch {
    return true;
  }
}

function freezeRequest(kind: GitMetadataRequestKind, args: readonly string[]): GitMetadataRequest {
  return Object.freeze({ arguments: Object.freeze([...args]), kind, policy: EXECUTION_POLICY });
}

function fallback(
  scope: ChangedFileScanScope,
  baseReference: string,
  reason: GitChangedFileFallbackReason,
): GitChangedFileMetadataFallback {
  const result = Object.freeze({
    baseReference,
    contractVersion: CHANGED_FILE_METADATA_CONTRACT_VERSION,
    reason,
    recordKind: CHANGED_FILE_METADATA_RECORD_KIND,
    state: "fallback" as const,
  });
  ISSUED_METADATA.add(result);
  METADATA_SCOPES.set(result, scope);
  return result;
}

/** Validate the exact bounded ref grammar accepted by explicit changed-file scans. */
export function containsUnsafeGitText(value: string): boolean {
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
    )
      return true;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** Validate the exact bounded ref grammar accepted by explicit changed-file scans. */
export function isValidGitBaseReference(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("-") ||
    value.length > CHANGED_FILE_METADATA_LIMITS.maximumBaseReferenceCodeUnits ||
    containsUnsafeGitText(value)
  )
    return false;
  return Buffer.byteLength(value, "utf8") <= CHANGED_FILE_METADATA_LIMITS.maximumBaseReferenceBytes;
}

function plainResponse(value: unknown): GitMetadataResponse | null {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 2
  )
    return null;
  const exit = Object.getOwnPropertyDescriptor(value, "exitCode");
  const stdout = Object.getOwnPropertyDescriptor(value, "stdout");
  if (
    exit === undefined ||
    !("value" in exit) ||
    typeof exit.value !== "number" ||
    !Number.isSafeInteger(exit.value) ||
    stdout === undefined ||
    !("value" in stdout) ||
    !(stdout.value instanceof Uint8Array) ||
    nodeTypes.isProxy(stdout.value) ||
    (Object.getPrototypeOf(stdout.value) !== Uint8Array.prototype &&
      Object.getPrototypeOf(stdout.value) !== Buffer.prototype) ||
    stdout.value.byteLength > CHANGED_FILE_METADATA_LIMITS.maximumCommandOutputBytes
  )
    return null;
  return Object.freeze({ exitCode: exit.value, stdout: Uint8Array.from(stdout.value) });
}

function snapshotInput(value: unknown): CollectGitChangedFileMetadataInput | null {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 2
  )
    return null;
  const base = Object.getOwnPropertyDescriptor(value, "baseReference");
  const signal = Object.getOwnPropertyDescriptor(value, "signal");
  if (
    base === undefined ||
    !("value" in base) ||
    signal === undefined ||
    !("value" in signal) ||
    typeof signal.value !== "object" ||
    signal.value === null ||
    nodeTypes.isProxy(signal.value)
  )
    return null;
  try {
    if (typeof ABORTED_DESCRIPTOR?.get?.call(signal.value) !== "boolean") return null;
  } catch {
    return null;
  }
  return Object.freeze({
    baseReference: base.value as string,
    signal: signal.value as AbortSignal,
  });
}

async function execute(
  executor: GitMetadataExecutor,
  request: GitMetadataRequest,
  signal: AbortSignal,
): Promise<GitMetadataResponse | null> {
  if (aborted(signal)) return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: GitMetadataResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        Reflect.apply(REMOVE_EVENT_LISTENER, signal, ["abort", onAbort]);
      } catch {
        resolve(null);
        return;
      }
      resolve(value);
    };
    const onAbort = (): void => {
      finish(null);
    };
    const timer = setTimeout(() => {
      finish(null);
    }, request.policy.maximumDurationMs);
    try {
      Reflect.apply(ADD_EVENT_LISTENER, signal, ["abort", onAbort, { once: true }]);
    } catch {
      finish(null);
      return;
    }
    if (aborted(signal)) {
      finish(null);
      return;
    }
    Promise.resolve()
      .then(() => executor(request, signal))
      .then(
        (value) => {
          finish(aborted(signal) ? null : plainResponse(value));
        },
        () => {
          finish(null);
        },
      );
  });
}

function oneSha(bytes: Uint8Array): string | null {
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n") || text.includes("\r")) return null;
  const value = text.slice(0, -1);
  return !value.includes("\n") && SHA_PATTERN.test(value) ? value : null;
}

function shaLines(bytes: Uint8Array): readonly string[] | null {
  const text = Buffer.from(bytes).toString("utf8");
  if (text.includes("\r") || (text.length > 0 && !text.endsWith("\n"))) return null;
  const body = text.length === 0 ? "" : text.slice(0, -1);
  if (body.endsWith("\n")) return null;
  const values = body.length === 0 ? [] : body.split("\n");
  return values.every((value) => SHA_PATTERN.test(value)) ? Object.freeze(values) : null;
}

function pathFromBytes(value: Uint8Array): RepositoryRelativePath | null {
  if (value.byteLength === 0 || value.byteLength > CHANGED_FILE_METADATA_LIMITS.maximumPathBytes)
    return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
  if (text.includes("\\") || text.endsWith("/")) return null;
  try {
    const path = canonicalizeRepositoryRelativePath(text, "posix");
    return path === text && path !== "." && !path.split("/").includes(".git") ? path : null;
  } catch {
    return null;
  }
}

function parseDiff(bytes: Uint8Array): readonly GitChangedPath[] | GitChangedFileFallbackReason {
  if (bytes.byteLength === 0) return Object.freeze([]);
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(bytes.slice(start, index));
    start = index + 1;
  }
  if (start !== bytes.byteLength) return "invalid-command-output";
  const changes: GitChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    if (changes.length >= CHANGED_FILE_METADATA_LIMITS.maximumChangedPaths) return "resource-limit";
    const statusBytes = fields[index] ?? new Uint8Array();
    if (statusBytes.some((byte) => byte > 0x7f)) return "invalid-command-output";
    const statusText = Buffer.from(statusBytes).toString("ascii");
    index += 1;
    if (!/^(?:[ADMT]|[CR](?:100|[1-9]?[0-9]))$/u.test(statusText))
      return "unsupported-change-state";
    const code = statusText[0];
    const first = pathFromBytes(fields[index] ?? new Uint8Array());
    index += 1;
    if (first === null) return "invalid-command-output";
    let path = first;
    let previousPath: RepositoryRelativePath | null = null;
    if (code === "C" || code === "R") {
      const second = pathFromBytes(fields[index] ?? new Uint8Array());
      index += 1;
      if (second === null || second === first) return "invalid-command-output";
      previousPath = first;
      path = second;
    }
    const status: GitChangeStatus =
      code === "A"
        ? "added"
        : code === "C"
          ? "copied"
          : code === "D"
            ? "deleted"
            : code === "M"
              ? "modified"
              : code === "R"
                ? "renamed"
                : "type-changed";
    changes.push(Object.freeze({ path, previousPath, status }));
  }
  const unique = new Set<string>();
  for (const change of changes) {
    if (unique.has(change.path)) return "invalid-command-output";
    unique.add(change.path);
    if (change.previousPath !== null) {
      if (unique.has(change.previousPath)) return "invalid-command-output";
      unique.add(change.previousPath);
    }
  }
  return Object.freeze(
    changes.sort((left, right) =>
      Buffer.compare(
        Buffer.from(`${left.path}\u0000${left.previousPath ?? ""}`, "utf8"),
        Buffer.from(`${right.path}\u0000${right.previousPath ?? ""}`, "utf8"),
      ),
    ),
  );
}

/** Mint command authority only in a trusted host after the user explicitly selected changed mode. */
export function createChangedFileScanScope(
  selection: RepositoryRootSelection,
): ChangedFileScanScope {
  if (!isIssuedRepositoryRootSelection(selection))
    throw new TypeError("changed-file scan scope requires an issued repository selection");
  const scope = Object.freeze({
    contractVersion: CHANGED_FILE_METADATA_CONTRACT_VERSION,
    kind: "agent-context-changed-file-scan-scope" as const,
  });
  ISSUED_SCOPES.add(scope);
  SCOPE_SELECTIONS.set(scope, selection);
  return scope;
}

export function isIssuedChangedFileScanScope(value: unknown): value is ChangedFileScanScope {
  return typeof value === "object" && value !== null && ISSUED_SCOPES.has(value);
}

/** Check a scope against its privately retained C01 selection without exposing the root path. */
export function isIssuedChangedFileScanScopeForRepositorySelection(
  scope: unknown,
  selection: unknown,
): scope is ChangedFileScanScope {
  const scopedSelection =
    typeof scope === "object" && scope !== null ? SCOPE_SELECTIONS.get(scope) : undefined;
  return (
    isIssuedChangedFileScanScope(scope) &&
    isIssuedRepositoryRootSelection(selection) &&
    scopedSelection?.root === selection.root &&
    scopedSelection.identity.device === selection.identity.device &&
    scopedSelection.identity.inode === selection.identity.inode
  );
}

export function createGitMetadataCapability(
  scope: ChangedFileScanScope,
  executor: GitMetadataExecutor,
): GitMetadataCapability {
  if (!isIssuedChangedFileScanScope(scope))
    throw new TypeError("Git metadata scope must be issued by this process");
  if (typeof executor !== "function" || nodeTypes.isProxy(executor))
    throw new TypeError("Git metadata executor must be a non-proxy function");
  const capability = Object.freeze({
    contractVersion: CHANGED_FILE_METADATA_CONTRACT_VERSION,
    kind: "agent-context-git-metadata-capability" as const,
  });
  ISSUED_CAPABILITIES.set(capability, Object.freeze({ executor, scope }));
  return capability;
}

export function isIssuedGitChangedFileMetadata(value: unknown): value is GitChangedFileMetadata {
  return typeof value === "object" && value !== null && ISSUED_METADATA.has(value);
}

export function isIssuedGitChangedFileMetadataForScope(
  value: unknown,
  scope: unknown,
): value is GitChangedFileMetadata {
  return (
    isIssuedGitChangedFileMetadata(value) &&
    isIssuedChangedFileScanScope(scope) &&
    METADATA_SCOPES.get(value) === scope
  );
}

/** Conservatively replace issued metadata with an issued full-scan fallback. */
export function forceGitChangedFileMetadataFallback(
  scope: ChangedFileScanScope,
  metadata: GitChangedFileMetadata,
  reason: GitChangedFileFallbackReason,
): GitChangedFileMetadataFallback {
  if (!isIssuedGitChangedFileMetadataForScope(metadata, scope))
    throw new TypeError("Git metadata fallback requires metadata issued for the same scope");
  return fallback(scope, metadata.baseReference, reason);
}

/** Reissue the exact validated index inventory retained by ready changed-file metadata. */
export function enumerateTrackedFilesFromGitChangedFileMetadata(
  scope: ChangedFileScanScope,
  metadata: GitChangedFileMetadata,
  options?: TrackedFileEnumerationOptions,
): TrackedFileEnumerationResult {
  if (!isIssuedGitChangedFileMetadataForScope(metadata, scope) || metadata.state !== "ready")
    throw new TypeError("tracked-file enumeration requires ready metadata for the same scope");
  const bytes = METADATA_INDEX_BYTES.get(metadata);
  if (bytes === undefined) throw new TypeError("tracked-file index evidence is unavailable");
  return enumerateTrackedFilesFromGitIndexBytes(bytes, options);
}

function sameChangedPath(left: GitChangedPath, right: GitChangedPath): boolean {
  return (
    left.path === right.path &&
    left.previousPath === right.previousPath &&
    left.status === right.status
  );
}

function sameMetadata(left: GitChangedFileMetadata, right: GitChangedFileMetadata): boolean {
  if (left.baseReference !== right.baseReference || left.state !== right.state) return false;
  if (left.state === "fallback" || right.state === "fallback")
    return left.state === "fallback" && right.state === "fallback" && left.reason === right.reason;
  return (
    left.baseCommit === right.baseCommit &&
    left.headCommit === right.headCommit &&
    left.indexObjectFormat === right.indexObjectFormat &&
    left.indexStateSha256 === right.indexStateSha256 &&
    left.indexVersion === right.indexVersion &&
    left.mergeBase === right.mergeBase &&
    left.trackedPaths.length === right.trackedPaths.length &&
    left.trackedPaths.every((entry, index) => entry === right.trackedPaths[index]) &&
    left.worktreeStateSha256 === right.worktreeStateSha256 &&
    left.changes.length === right.changes.length &&
    left.changes.every((entry, index) => {
      const other = right.changes[index];
      return other !== undefined && sameChangedPath(entry, other);
    })
  );
}

/**
 * Bind Git metadata across the full repository read/evaluation interval. Any HEAD, index, or
 * working-tree drift invalidates subset authority and produces an issued full-scan fallback.
 */
export function reconcileGitChangedFileMetadata(
  scope: ChangedFileScanScope,
  before: GitChangedFileMetadata,
  after: GitChangedFileMetadata,
): GitChangedFileMetadata {
  if (
    !isIssuedChangedFileScanScope(scope) ||
    !isIssuedGitChangedFileMetadataForScope(before, scope) ||
    !isIssuedGitChangedFileMetadataForScope(after, scope)
  )
    throw new TypeError("Git metadata reconciliation requires one issued scan scope");
  return sameMetadata(before, after)
    ? after
    : fallback(scope, before.baseReference, "repository-changed");
}

/** Resolve exact commits, require one merge base, and obtain a NUL-delimited worktree diff. */
export async function collectGitChangedFileMetadata(
  capability: GitMetadataCapability,
  input: CollectGitChangedFileMetadataInput,
): Promise<GitChangedFileMetadata> {
  const authority = ISSUED_CAPABILITIES.get(capability);
  const snapshot = snapshotInput(input);
  const baseReference =
    snapshot !== null && isValidGitBaseReference(snapshot.baseReference)
      ? snapshot.baseReference
      : "";
  if (authority === undefined) throw new TypeError("Git metadata capability is not issued");
  const { executor, scope } = authority;
  if (snapshot === null) return fallback(scope, baseReference, "command-failed");
  if (!isValidGitBaseReference(snapshot.baseReference))
    return fallback(scope, "", "invalid-base-reference");
  if (aborted(snapshot.signal)) return fallback(scope, snapshot.baseReference, "cancelled");

  const headResponse = await execute(
    executor,
    freezeRequest("resolve-head", ["rev-parse", "--verify", "HEAD^{commit}"]),
    snapshot.signal,
  );
  if (headResponse === null)
    return fallback(
      scope,
      snapshot.baseReference,
      aborted(snapshot.signal) ? "cancelled" : "command-failed",
    );
  if (headResponse.exitCode !== 0) return fallback(scope, snapshot.baseReference, "command-failed");
  const headCommit = oneSha(headResponse.stdout);
  if (headCommit === null) return fallback(scope, snapshot.baseReference, "invalid-command-output");

  const baseResponse = await execute(
    executor,
    freezeRequest("resolve-base", [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${snapshot.baseReference}^{commit}`,
    ]),
    snapshot.signal,
  );
  if (baseResponse === null)
    return fallback(
      scope,
      snapshot.baseReference,
      aborted(snapshot.signal) ? "cancelled" : "command-failed",
    );
  if (baseResponse.exitCode !== 0) return fallback(scope, snapshot.baseReference, "command-failed");
  const baseCommit = oneSha(baseResponse.stdout);
  if (baseCommit === null) return fallback(scope, snapshot.baseReference, "invalid-command-output");

  const mergeResponse = await execute(
    executor,
    freezeRequest("merge-bases", ["merge-base", "--all", baseCommit, headCommit]),
    snapshot.signal,
  );
  if (mergeResponse === null)
    return fallback(
      scope,
      snapshot.baseReference,
      aborted(snapshot.signal) ? "cancelled" : "command-failed",
    );
  if (mergeResponse.exitCode !== 0)
    return fallback(scope, snapshot.baseReference, "command-failed");
  const mergeBases = shaLines(mergeResponse.stdout);
  if (mergeBases === null) return fallback(scope, snapshot.baseReference, "invalid-command-output");
  if (mergeBases.length === 0) return fallback(scope, snapshot.baseReference, "no-merge-base");
  if (mergeBases.length !== 1)
    return fallback(scope, snapshot.baseReference, "multiple-merge-bases");
  const mergeBase = mergeBases[0];
  if (mergeBase === undefined)
    return fallback(scope, snapshot.baseReference, "invalid-command-output");
  if (baseCommit.length !== headCommit.length || mergeBase.length !== headCommit.length)
    return fallback(scope, snapshot.baseReference, "invalid-command-output");

  const diffResponse = await execute(
    executor,
    freezeRequest("diff", [
      "diff-index",
      "--cached",
      "--name-status",
      "-z",
      "--no-renames",
      mergeBase,
      "--",
    ]),
    snapshot.signal,
  );
  if (diffResponse === null)
    return fallback(
      scope,
      snapshot.baseReference,
      aborted(snapshot.signal) ? "cancelled" : "command-failed",
    );
  if (diffResponse.exitCode !== 0) return fallback(scope, snapshot.baseReference, "command-failed");
  const changes = parseDiff(diffResponse.stdout);
  if (typeof changes === "string") return fallback(scope, snapshot.baseReference, changes);
  const indexStateResponse = await execute(
    executor,
    freezeRequest("index-state", ["read-index"]),
    snapshot.signal,
  );
  if (indexStateResponse === null)
    return fallback(
      scope,
      snapshot.baseReference,
      aborted(snapshot.signal) ? "cancelled" : "command-failed",
    );
  if (indexStateResponse.exitCode !== 0)
    return fallback(scope, snapshot.baseReference, "command-failed");
  let parsedIndex;
  try {
    parsedIndex = parseGitIndex(indexStateResponse.stdout, {
      maximumFiles: CHANGED_FILE_METADATA_LIMITS.maximumChangedPaths,
      maximumIndexBytes: CHANGED_FILE_METADATA_LIMITS.maximumCommandOutputBytes,
      maximumIndexEntries: CHANGED_FILE_METADATA_LIMITS.maximumChangedPaths,
    });
  } catch {
    return fallback(scope, snapshot.baseReference, "invalid-command-output");
  }
  if (
    (parsedIndex.objectFormat === "sha1" ? 40 : 64) !== headCommit.length ||
    parsedIndex.entries.some((entry) => entry.stage !== 0)
  )
    return fallback(scope, snapshot.baseReference, "unsupported-change-state");
  const worktreeStateResponse = await execute(
    executor,
    freezeRequest("worktree-state", ["read-worktree-state"]),
    snapshot.signal,
  );
  if (worktreeStateResponse === null)
    return fallback(
      scope,
      snapshot.baseReference,
      aborted(snapshot.signal) ? "cancelled" : "command-failed",
    );
  if (worktreeStateResponse.exitCode !== 0)
    return fallback(scope, snapshot.baseReference, "command-failed");
  const indexStateSha256 = createHash("sha256").update(indexStateResponse.stdout).digest("hex");
  const worktreeStateSha256 = createHash("sha256")
    .update(worktreeStateResponse.stdout)
    .digest("hex");
  const finalHeadResponse = await execute(
    executor,
    freezeRequest("resolve-head", ["rev-parse", "--verify", "HEAD^{commit}"]),
    snapshot.signal,
  );
  if (finalHeadResponse === null)
    return fallback(
      scope,
      snapshot.baseReference,
      aborted(snapshot.signal) ? "cancelled" : "command-failed",
    );
  if (finalHeadResponse.exitCode !== 0)
    return fallback(scope, snapshot.baseReference, "command-failed");
  const finalHeadCommit = oneSha(finalHeadResponse.stdout);
  if (finalHeadCommit === null)
    return fallback(scope, snapshot.baseReference, "invalid-command-output");
  if (finalHeadCommit.length !== headCommit.length || finalHeadCommit !== headCommit)
    return fallback(scope, snapshot.baseReference, "repository-changed");
  const result = Object.freeze({
    baseCommit,
    baseReference: snapshot.baseReference,
    changes,
    contractVersion: CHANGED_FILE_METADATA_CONTRACT_VERSION,
    headCommit,
    indexObjectFormat: parsedIndex.objectFormat,
    indexStateSha256,
    indexVersion: parsedIndex.version,
    mergeBase,
    recordKind: CHANGED_FILE_METADATA_RECORD_KIND,
    state: "ready" as const,
    trackedPaths: parsedIndex.paths,
    worktreeStateSha256,
  });
  ISSUED_METADATA.add(result);
  METADATA_SCOPES.set(result, scope);
  METADATA_INDEX_BYTES.set(result, Uint8Array.from(indexStateResponse.stdout));
  return result;
}
