import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";

import {
  CHANGED_FILE_METADATA_LIMITS,
  containsUnsafeGitText,
  createReadOnlyRepository,
  isIssuedRepositoryRootSelection,
  parseGitIndex,
  type GitMetadataExecutionPolicy,
  type GitMetadataExecutor,
  type GitMetadataRequest,
  type GitMetadataRequestKind,
  type GitMetadataResponse,
  type ParsedGitIndex,
  type ReadOnlyRepository,
  type RepositoryRootSelection,
} from "@agent-context/evidence";

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
const EMPTY_BYTES = new Uint8Array();
const MAXIMUM_RAW_WORKTREE_BYTES = 536_870_912;
const MAXIMUM_RAW_FILE_BYTES = 16_777_216;
const MAXIMUM_RAW_DEPTH = 128;
const MAXIMUM_GIT_METADATA_BYTES = CHANGED_FILE_METADATA_LIMITS.maximumCommandOutputBytes;
// Every admitted loose/packed object input is rebound before and after each Git request. Keep this
// deliberately below the public path ceiling so a hostile loose-object farm cannot amplify seven
// changed-mode probes into unbounded metadata work. Repositories over the cap use the full scan.
const MAXIMUM_OBJECT_STORE_ENTRIES = 4_096;
const MAXIMUM_SYMBOLIC_REF_DEPTH = 8;

const POSIX_GIT_CANDIDATES = Object.freeze([
  "/usr/bin/git",
  "/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
]);
const WINDOWS_GIT_CANDIDATES = Object.freeze([
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
]);

interface FileIdentity {
  readonly contentSha256: string | null;
  readonly ctimeNanoseconds: string;
  readonly device: string;
  readonly inode: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly mtimeNanoseconds: string;
  readonly path: string;
  readonly size: string;
}

interface RepositoryExecutionIdentity {
  readonly commonConfig: FileIdentity;
  readonly commonDirectory: FileIdentity;
  readonly commondirFile: FileIdentity | null;
  readonly gitDirectory: FileIdentity;
  readonly gitMarker: FileIdentity;
  readonly gitdirBacklink: FileIdentity | null;
  readonly indexPath: string;
  readonly metadataGuardDirectories: readonly FileIdentity[];
  readonly objectDirectory: FileIdentity;
  readonly objectFormat: "sha1" | "sha256";
  readonly objectStoreIdentities: readonly FileIdentity[];
  readonly root: FileIdentity;
}

interface StableFile {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
}

interface SyntheticGitIdentity {
  readonly config: FileIdentity;
  readonly directory: FileIdentity;
  readonly head: FileIdentity;
  readonly objects: FileIdentity;
  readonly refs: FileIdentity;
}

interface IndexSnapshot {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly parsed: ParsedGitIndex;
}

interface WorktreeSnapshot {
  readonly index: IndexSnapshot;
  readonly modifiedPaths: readonly string[];
  readonly state: Uint8Array;
}

interface ReferenceInputSnapshot {
  readonly bytes: Uint8Array | null;
  readonly file: FileIdentity | null;
  readonly guards: readonly FileIdentity[];
}

interface ReferenceResolutionSnapshot {
  readonly inputs: readonly ReferenceInputSnapshot[];
  readonly objectId: string;
}

interface PackedReferenceSnapshot {
  readonly inputs: readonly ReferenceInputSnapshot[];
  readonly references: ReadonlyMap<string, string>;
}

interface AsyncCloseable {
  close(): Promise<void>;
}

async function closeOperationResource(handle: AsyncCloseable): Promise<void> {
  await handle.close();
}

type SpawnGitProcess = typeof import("node:child_process").spawn;

export interface NodeGitMetadataExecutorOptions {
  /** Trusted absolute executable override. Repository input must never select this path. */
  readonly gitExecutable?: string;
  /** A trusted host may enforce a stricter output ceiling than the public contract. */
  readonly maximumOutputBytes?: number;
  /** A trusted host may enforce a stricter subprocess deadline than the public contract. */
  readonly maximumDurationMs?: number;
  /** A trusted host may enforce a stricter one-time object-store preflight deadline. */
  readonly maximumPreflightDurationMs?: number;
  /** Trusted cancellation authority for bounded object-store preflight. */
  readonly signal?: AbortSignal;
}

function aborted(signal: AbortSignal): boolean {
  try {
    return ABORTED_DESCRIPTOR?.get?.call(signal) !== false;
  } catch {
    return true;
  }
}

/** @internal Exported only for deterministic resource-race contract tests. */
export class OperationContext {
  readonly #controller = new AbortController();
  readonly #deadlineAt: number;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort: (() => void) | undefined;
  readonly #timer: NodeJS.Timeout;
  readonly #description: string;
  #failure: TypeError | null = null;

  constructor(maximumDurationMs: number, externalSignal?: AbortSignal, description = "operation") {
    this.#deadlineAt = performance.now() + maximumDurationMs;
    this.#description = description;
    this.#externalSignal = externalSignal;
    this.#onExternalAbort =
      externalSignal === undefined
        ? undefined
        : (): void => {
            this.#fail(`Git metadata ${this.#description} was cancelled`);
          };
    if (externalSignal !== undefined && aborted(externalSignal))
      this.#fail(`Git metadata ${this.#description} was cancelled`);
    else if (externalSignal !== undefined && this.#onExternalAbort !== undefined)
      Reflect.apply(ADD_EVENT_LISTENER, externalSignal, [
        "abort",
        this.#onExternalAbort,
        { once: true },
      ]);
    this.#timer = setTimeout(() => {
      this.#fail(`Git metadata ${this.#description} exceeded its deadline`);
    }, maximumDurationMs);
    this.#timer.unref();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  #fail(message: string): void {
    if (this.#failure !== null) return;
    this.#failure = new TypeError(message);
    this.#controller.abort(this.#failure);
  }

  checkpoint(): void {
    if (this.#failure !== null) throw this.#failure;
    if (performance.now() >= this.#deadlineAt) {
      const failure = new TypeError(`Git metadata ${this.#description} exceeded its deadline`);
      this.#fail(failure.message);
      throw failure;
    }
  }

  remainingMilliseconds(): number {
    this.checkpoint();
    return Math.max(1, Math.ceil(this.#deadlineAt - performance.now()));
  }

  async wait<T>(
    operation: () => Promise<T>,
    cleanupLate?: (value: T) => Promise<void>,
  ): Promise<T> {
    this.checkpoint();
    const pending = operation();
    let lostRace = false;
    if (cleanupLate !== undefined)
      void pending.then(
        async (value) => {
          if (lostRace) await cleanupLate(value).catch(() => undefined);
        },
        () => undefined,
      );
    let onAbort: (() => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => {
        reject(this.#failure ?? new TypeError(`Git metadata ${this.#description} was cancelled`));
      };
      Reflect.apply(ADD_EVENT_LISTENER, this.signal, ["abort", onAbort, { once: true }]);
    });
    try {
      const value = await Promise.race([pending, cancellation]);
      try {
        this.checkpoint();
      } catch (error) {
        if (cleanupLate !== undefined) await cleanupLate(value).catch(() => undefined);
        throw error;
      }
      return value;
    } catch (error) {
      lostRace = this.#failure !== null;
      throw error;
    } finally {
      if (onAbort !== undefined)
        Reflect.apply(REMOVE_EVENT_LISTENER, this.signal, ["abort", onAbort]);
    }
  }

  async open(target: string, flags: number): Promise<Awaited<ReturnType<typeof open>>> {
    return this.wait(() => open(target, flags), closeOperationResource);
  }

  async openDirectory(target: string): Promise<Awaited<ReturnType<typeof opendir>>> {
    return this.wait(() => opendir(target), closeOperationResource);
  }

  async close(closeable: AsyncCloseable): Promise<void> {
    const pending = closeOperationResource(closeable);
    if (this.#failure !== null) {
      void pending.catch(() => undefined);
      return;
    }
    try {
      await this.wait(() => pending);
    } catch {
      void pending.catch(() => undefined);
    }
  }

  dispose(): void {
    clearTimeout(this.#timer);
    if (this.#externalSignal !== undefined && this.#onExternalAbort !== undefined)
      Reflect.apply(REMOVE_EVENT_LISTENER, this.#externalSignal, ["abort", this.#onExternalAbort]);
  }
}

function samePlatformPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function fileIdentity(
  context: OperationContext,
  target: string,
  expected: "directory" | "file",
  bindContents = false,
  maximumContentBytes = 4_096,
): Promise<FileIdentity> {
  const metadata = await context.wait(() => lstat(target, { bigint: true }));
  if (metadata.isSymbolicLink()) throw new TypeError("Git execution identity cannot be a link");
  if (
    (expected === "directory" && !metadata.isDirectory()) ||
    (expected === "file" && !metadata.isFile())
  )
    throw new TypeError("Git execution identity has an unsupported file type");
  let contentSha256: string | null = null;
  if (bindContents) {
    if (expected !== "file" || metadata.size > BigInt(maximumContentBytes))
      throw new TypeError("Git marker contents exceed the identity limit");
    const handle = await context.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await context.wait(() => handle.stat({ bigint: true }));
      if (
        before.dev !== metadata.dev ||
        before.ino !== metadata.ino ||
        before.size !== metadata.size ||
        before.mode !== metadata.mode ||
        before.mtimeNs !== metadata.mtimeNs ||
        before.ctimeNs !== metadata.ctimeNs
      )
        throw new TypeError("Git marker changed while its identity was captured");
      const bytes = await context.wait(() => handle.readFile({ signal: context.signal }));
      const after = await context.wait(() => handle.stat({ bigint: true }));
      if (
        bytes.byteLength !== Number(metadata.size) ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mode !== before.mode ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new TypeError("Git marker changed while its contents were captured");
      contentSha256 = createHash("sha256").update(bytes).digest("hex");
    } finally {
      await context.close(handle);
    }
  }
  return Object.freeze({
    contentSha256,
    ctimeNanoseconds: metadata.ctimeNs.toString(10),
    device: metadata.dev.toString(10),
    inode: metadata.ino.toString(10),
    kind: expected,
    mode: Number(metadata.mode),
    mtimeNanoseconds: metadata.mtimeNs.toString(10),
    path: target,
    size: metadata.size.toString(10),
  });
}

async function sameIdentity(context: OperationContext, expected: FileIdentity): Promise<boolean> {
  try {
    const observed = await fileIdentity(
      context,
      expected.path,
      expected.kind,
      expected.contentSha256 !== null,
      expected.contentSha256 === null ? 4_096 : Number(expected.size),
    );
    return (
      observed.contentSha256 === expected.contentSha256 &&
      observed.ctimeNanoseconds === expected.ctimeNanoseconds &&
      observed.device === expected.device &&
      observed.inode === expected.inode &&
      observed.mode === expected.mode &&
      observed.mtimeNanoseconds === expected.mtimeNanoseconds &&
      observed.size === expected.size
    );
  } catch {
    return false;
  }
}

async function stableFile(
  context: OperationContext,
  target: string,
  maximumBytes: number,
): Promise<StableFile> {
  const beforePath = await context.wait(() => lstat(target, { bigint: true }));
  if (
    beforePath.isSymbolicLink() ||
    !beforePath.isFile() ||
    beforePath.size < 0n ||
    beforePath.size > BigInt(maximumBytes)
  )
    throw new TypeError("Git metadata file is unavailable or unsupported");
  const handle = await context.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await context.wait(() => handle.stat({ bigint: true }));
    if (
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      before.size !== beforePath.size ||
      before.mode !== beforePath.mode ||
      before.mtimeNs !== beforePath.mtimeNs ||
      before.ctimeNs !== beforePath.ctimeNs
    )
      throw new TypeError("Git metadata file changed before it was read");
    const bytes = await context.wait(() => handle.readFile({ signal: context.signal }));
    const after = await context.wait(() => handle.stat({ bigint: true }));
    if (
      bytes.byteLength !== Number(before.size) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new TypeError("Git metadata file changed while it was read");
    return Object.freeze({
      bytes: Uint8Array.from(bytes),
      identity: await fileIdentity(context, target, "file", true, maximumBytes),
    });
  } finally {
    await context.close(handle);
  }
}

function parseRepositoryConfig(bytes: Uint8Array): "sha1" | "sha256" {
  let text = decodeExactUtf8(bytes);
  if (text.startsWith("\uFEFF") || text.includes("\0"))
    throw new TypeError("Git repository configuration encoding is unsupported");
  text = text.replaceAll("\r\n", "\n");
  if (text.includes("\r") || text.includes("\\"))
    throw new TypeError("Git repository configuration syntax is unsupported");
  let section: { readonly main: boolean; readonly name: string } | null = null;
  let repositoryFormatVersion: string | null = null;
  let objectFormat: string | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const mainMatch = /^\[\s*([A-Za-z][A-Za-z0-9-]*)\s*\]$/u.exec(line);
      const subsectionMatch = /^\[\s*([A-Za-z][A-Za-z0-9-]*)\s+"([^"\r\n]*)"\s*\]$/u.exec(line);
      const deprecatedSubsectionMatch =
        /^\[\s*([A-Za-z][A-Za-z0-9-]*)\.([A-Za-z0-9][A-Za-z0-9.-]*)\s*\]$/u.exec(line);
      const match = mainMatch ?? subsectionMatch ?? deprecatedSubsectionMatch;
      if (match === null)
        throw new TypeError("Git repository configuration section is unsupported");
      const name = (match[1] ?? "").toLowerCase();
      const main = mainMatch !== null;
      if (name === "include" || name === "includeif")
        throw new TypeError("Git configuration includes are unsupported");
      if (!main && (name === "core" || name === "extensions"))
        throw new TypeError("Git repository configuration subsection is unsupported");
      section = Object.freeze({ main, name });
      continue;
    }
    const separator = line.indexOf("=");
    const rawKey = (separator < 0 ? line : line.slice(0, separator)).trim();
    if (section === null || !/^[A-Za-z][A-Za-z0-9-]*$/u.test(rawKey))
      throw new TypeError("Git repository configuration is unsupported");
    const key = rawKey.toLowerCase();
    if (!section.main || (section.name !== "core" && section.name !== "extensions")) continue;
    if (separator < 1) throw new TypeError("Git repository configuration value is unsupported");
    if (section.name === "core" && key !== "repositoryformatversion") continue;
    if (section.name === "extensions" && key !== "objectformat")
      throw new TypeError("Git repository extension is unsupported");
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9]+$/u.test(value))
      throw new TypeError("Git repository configuration value is unsupported");
    if (section.name === "core") {
      if (repositoryFormatVersion !== null)
        throw new TypeError("Git repository format is duplicated");
      repositoryFormatVersion = value;
    }
    if (section.name === "extensions") {
      if (objectFormat !== null) throw new TypeError("Git object format is duplicated");
      objectFormat = value;
    }
  }
  if (repositoryFormatVersion === "0" && objectFormat === null) return "sha1";
  if (repositoryFormatVersion === "1" && objectFormat === "sha256") return "sha256";
  throw new TypeError("Git repository format is unsupported");
}

async function rejectExistingMetadata(
  context: OperationContext,
  target: string,
  description: string,
): Promise<void> {
  if (!(await pathDoesNotExist(context, target)))
    throw new TypeError(`${description} is unsupported`);
}

async function pathDoesNotExist(context: OperationContext, target: string): Promise<boolean> {
  try {
    await context.wait(() => lstat(target));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    context.checkpoint();
    throw error;
  }
}

async function canonicalDirectory(
  context: OperationContext,
  target: string,
): Promise<FileIdentity> {
  const canonical = await context.wait(() => realpath(target));
  if (!samePlatformPath(canonical, target))
    throw new TypeError("Git metadata directory cannot contain links");
  return fileIdentity(context, target, "directory");
}

async function objectStorePreflight(
  context: OperationContext,
  objectRoot: string,
): Promise<readonly FileIdentity[]> {
  const identities: FileIdentity[] = [];
  let entries = 0;
  const checkpoint = (): void => {
    context.checkpoint();
  };
  const visit = async (
    directory: string,
    relative: string,
    kind: "fanout" | "info" | "pack" | "root",
  ): Promise<void> => {
    checkpoint();
    const before = await canonicalDirectory(context, directory);
    const handle = await context.openDirectory(directory);
    try {
      for (;;) {
        const child = await context.wait(() => handle.read());
        if (child === null) break;
        checkpoint();
        entries += 1;
        if (entries > MAXIMUM_OBJECT_STORE_ENTRIES)
          throw new TypeError("Git object store exceeds the metadata entry limit");
        if (
          child.name.length === 0 ||
          child.name === "." ||
          child.name === ".." ||
          containsUnsafeGitText(child.name)
        )
          throw new TypeError("Git object store contains an unsafe name");
        const childRelative = relative === "" ? child.name : `${relative}/${child.name}`;
        const childPath = path.join(directory, child.name);
        const metadata = await context.wait(() => lstat(childPath, { bigint: true }));
        if (metadata.isSymbolicLink()) throw new TypeError("Git object store cannot contain links");
        if (metadata.isDirectory()) {
          if (kind !== "root")
            throw new TypeError("Git object store contains an unexpected nested directory");
          const childKind =
            child.name === "info"
              ? "info"
              : child.name === "pack"
                ? "pack"
                : /^[0-9a-f]{2}$/u.test(child.name)
                  ? "fanout"
                  : null;
          if (childKind === null)
            throw new TypeError("Git object store contains an unsupported directory");
          await visit(childPath, childRelative, childKind);
          continue;
        }
        if (!metadata.isFile()) throw new TypeError("Git object store contains a special file");
        if (kind === "root")
          throw new TypeError("Git object store contains an unsupported root file");
        if (
          childRelative === "info/alternates" ||
          childRelative === "info/http-alternates" ||
          child.name.endsWith(".promisor")
        )
          throw new TypeError("Git alternate or lazy object metadata is unsupported");
        identities.push(await fileIdentity(context, childPath, "file"));
      }
    } finally {
      await context.close(handle);
    }
    const after = await canonicalDirectory(context, directory);
    if (
      before.device !== after.device ||
      before.inode !== after.inode ||
      before.mode !== after.mode ||
      before.mtimeNanoseconds !== after.mtimeNanoseconds ||
      before.ctimeNanoseconds !== after.ctimeNanoseconds
    )
      throw new TypeError("Git object store changed during preflight");
    identities.push(after);
  };
  await visit(objectRoot, "", "root");
  return Object.freeze(identities);
}

function defaultCandidates(): readonly string[] {
  return process.platform === "win32" ? WINDOWS_GIT_CANDIDATES : POSIX_GIT_CANDIDATES;
}

async function resolveExecutable(
  context: OperationContext,
  selection: RepositoryRootSelection,
  requested: string | undefined,
): Promise<FileIdentity> {
  const candidates = requested === undefined ? defaultCandidates() : Object.freeze([requested]);
  for (const candidate of candidates) {
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > 16_384 ||
      containsUnsafeGitText(candidate) ||
      !path.isAbsolute(candidate) ||
      samePlatformPath(candidate, selection.root) ||
      isWithin(selection.root, candidate)
    )
      continue;
    try {
      const canonical = await context.wait(() => realpath(candidate));
      if (
        samePlatformPath(canonical, selection.root) ||
        isWithin(selection.root, canonical) ||
        !path.isAbsolute(canonical)
      )
        continue;
      const identity = await fileIdentity(context, canonical, "file");
      if (process.platform !== "win32") await context.wait(() => access(canonical, constants.X_OK));
      return identity;
    } catch {
      context.checkpoint();
      // Continue through the fixed host-only candidate list. No repository path is consulted.
    }
  }
  throw new TypeError("a trusted Git executable is unavailable");
}

async function repositoryIdentity(
  context: OperationContext,
  selection: RepositoryRootSelection,
): Promise<RepositoryExecutionIdentity> {
  if (
    !isIssuedRepositoryRootSelection(selection) ||
    selection.gitDirectory === null ||
    (selection.reason !== "git-directory" && selection.reason !== "git-worktree-file")
  )
    throw new TypeError("Git metadata execution requires a discovered Git repository root");
  const canonicalRoot = await context.wait(() => realpath(selection.root));
  if (!samePlatformPath(canonicalRoot, selection.root))
    throw new TypeError("Git metadata root identity is not canonical");
  const root = await fileIdentity(context, selection.root, "directory");
  if (root.device !== selection.identity.device || root.inode !== selection.identity.inode)
    throw new TypeError("Git metadata root identity changed");
  const markerPath = path.join(selection.root, ".git");
  const marker = await context.wait(() => lstat(markerPath, { bigint: true }));
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile()))
    throw new TypeError("Git metadata marker has an unsupported file type");
  const markerKind = marker.isDirectory() ? "directory" : "file";
  const gitMarker = await fileIdentity(context, markerPath, markerKind, markerKind === "file");
  const gitDirectoryPath = selection.gitDirectory;
  const canonicalGitDirectory = await context.wait(() => realpath(gitDirectoryPath));
  if (!samePlatformPath(canonicalGitDirectory, gitDirectoryPath))
    throw new TypeError("Git metadata directory identity is not canonical");
  const gitDirectory = await fileIdentity(context, gitDirectoryPath, "directory");
  let commonDirectory = gitDirectory;
  let commondirFile: FileIdentity | null = null;
  let gitdirBacklink: FileIdentity | null = null;
  const commondirPath = path.join(gitDirectoryPath, "commondir");
  if (selection.reason === "git-worktree-file") {
    const commondir = await stableFile(context, commondirPath, 4_096);
    commondirFile = commondir.identity;
    const text = Buffer.from(commondir.bytes).toString("utf8");
    const declared = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (
      Buffer.from(text, "utf8").byteLength !== commondir.bytes.byteLength ||
      declared.length === 0 ||
      containsUnsafeGitText(declared) ||
      declared.includes("\n") ||
      declared.includes("\r")
    )
      throw new TypeError("Git worktree common-directory metadata is invalid");
    const resolved = path.resolve(selection.gitDirectory, declared);
    const canonical = await context.wait(() => realpath(resolved));
    if (!samePlatformPath(canonical, resolved))
      throw new TypeError("Git worktree common directory cannot contain links");
    commonDirectory = await canonicalDirectory(context, canonical);
    const membership = path.relative(commonDirectory.path, gitDirectory.path).split(path.sep);
    if (
      membership.length !== 2 ||
      membership[0] !== "worktrees" ||
      membership[1] === undefined ||
      membership[1].length === 0
    )
      throw new TypeError("Git worktree private directory is not an authorized common member");
    const backlink = await stableFile(context, path.join(gitDirectory.path, "gitdir"), 4_096);
    gitdirBacklink = backlink.identity;
    const backlinkText = decodeExactUtf8(backlink.bytes);
    const declaredBacklink = backlinkText.endsWith("\n") ? backlinkText.slice(0, -1) : backlinkText;
    if (
      declaredBacklink.includes("\n") ||
      declaredBacklink.includes("\r") ||
      !path.isAbsolute(declaredBacklink) ||
      !samePlatformPath(path.resolve(declaredBacklink), markerPath)
    )
      throw new TypeError("Git worktree backlink does not match the selected marker");
  } else if (!(await pathDoesNotExist(context, commondirPath))) {
    throw new TypeError("unexpected Git worktree common-directory metadata");
  }
  const commonConfigSnapshot = await stableFile(
    context,
    path.join(commonDirectory.path, "config"),
    1_048_576,
  );
  const objectFormat = parseRepositoryConfig(commonConfigSnapshot.bytes);
  await rejectExistingMetadata(
    context,
    path.join(commonDirectory.path, "shallow"),
    "shallow Git history",
  );
  await rejectExistingMetadata(
    context,
    path.join(commonDirectory.path, "info", "grafts"),
    "Git graft metadata",
  );
  await rejectExistingMetadata(
    context,
    path.join(commonDirectory.path, "refs", "replace"),
    "Git replacement metadata",
  );
  await rejectExistingMetadata(
    context,
    path.join(gitDirectory.path, "config.worktree"),
    "Git worktree configuration",
  );
  if (!samePlatformPath(commonDirectory.path, gitDirectory.path)) {
    await rejectExistingMetadata(
      context,
      path.join(gitDirectory.path, "shallow"),
      "private shallow Git history",
    );
    await rejectExistingMetadata(
      context,
      path.join(gitDirectory.path, "refs", "replace"),
      "private Git replacement metadata",
    );
  }
  const objectPath = path.join(commonDirectory.path, "objects");
  const objectDirectory = await canonicalDirectory(context, objectPath);
  const indexPath = path.join(gitDirectory.path, "index");
  const metadataGuardDirectories = [
    await canonicalDirectory(context, path.join(commonDirectory.path, "info")),
    await canonicalDirectory(context, path.join(commonDirectory.path, "refs")),
  ];
  return Object.freeze({
    commonConfig: commonConfigSnapshot.identity,
    commonDirectory,
    commondirFile,
    gitDirectory,
    gitMarker,
    gitdirBacklink,
    indexPath,
    metadataGuardDirectories: Object.freeze(metadataGuardDirectories),
    objectDirectory,
    objectFormat,
    objectStoreIdentities: await objectStorePreflight(context, objectPath),
    root,
  });
}

async function repositoryIdentityStillMatches(
  context: OperationContext,
  identity: RepositoryExecutionIdentity,
): Promise<boolean> {
  try {
    if (!(
      (await sameIdentity(context, identity.root)) &&
      (await sameIdentity(context, identity.gitMarker)) &&
      (await sameIdentity(context, identity.gitDirectory)) &&
      (await sameIdentity(context, identity.commonConfig)) &&
      (await sameIdentity(context, identity.commonDirectory)) &&
      (identity.commondirFile === null || (await sameIdentity(context, identity.commondirFile))) &&
      (identity.gitdirBacklink === null ||
        (await sameIdentity(context, identity.gitdirBacklink))) &&
      (await sameIdentity(context, identity.objectDirectory))
    ))
      return false;
    for (const entry of identity.objectStoreIdentities)
      if (!(await sameIdentity(context, entry))) return false;
    for (const entry of identity.metadataGuardDirectories)
      if (!(await sameIdentity(context, entry))) return false;
    return true;
  } catch {
    return false;
  }
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function exactOwnKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.size &&
    keys.every((key) => typeof key === "string" && expected.has(key))
  );
}

const POLICY_KEYS = new Set([
  "disableGlobalConfiguration",
  "disableSystemConfiguration",
  "environment",
  "inheritEnvironment",
  "maximumDurationMs",
  "network",
  "repositoryWrites",
]);
const POLICY_ENVIRONMENT_KEYS = new Set([
  "GIT_CONFIG_NOSYSTEM",
  "GIT_NO_LAZY_FETCH",
  "GIT_OPTIONAL_LOCKS",
  "GIT_PAGER",
  "GIT_TERMINAL_PROMPT",
]);
const REQUEST_KEYS = new Set(["arguments", "kind", "policy"]);
const EXECUTOR_OPTION_KEYS = new Set([
  "gitExecutable",
  "maximumDurationMs",
  "maximumOutputBytes",
  "maximumPreflightDurationMs",
  "signal",
]);
const REQUEST_POLICY: GitMetadataExecutionPolicy = Object.freeze({
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

function plainPolicy(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  if (!exactOwnKeys(value, POLICY_KEYS)) return false;
  const environment = ownData(value, "environment");
  if (
    typeof environment !== "object" ||
    environment === null ||
    nodeTypes.isProxy(environment) ||
    Object.getPrototypeOf(environment) !== Object.prototype ||
    !exactOwnKeys(environment, POLICY_ENVIRONMENT_KEYS)
  )
    return false;
  return (
    ownData(value, "disableGlobalConfiguration") === true &&
    ownData(value, "disableSystemConfiguration") === true &&
    ownData(value, "inheritEnvironment") === false &&
    ownData(value, "maximumDurationMs") === CHANGED_FILE_METADATA_LIMITS.maximumCommandDurationMs &&
    ownData(value, "network") === "denied" &&
    ownData(value, "repositoryWrites") === "denied" &&
    ownData(environment, "GIT_CONFIG_NOSYSTEM") === "1" &&
    ownData(environment, "GIT_NO_LAZY_FETCH") === "1" &&
    ownData(environment, "GIT_OPTIONAL_LOCKS") === "0" &&
    ownData(environment, "GIT_PAGER") === "cat" &&
    ownData(environment, "GIT_TERMINAL_PROMPT") === "0"
  );
}

function snapshotOptions(value: unknown): Readonly<NodeGitMetadataExecutorOptions> {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError("Git metadata executor options are invalid");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > EXECUTOR_OPTION_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !EXECUTOR_OPTION_KEYS.has(key))
  )
    throw new TypeError("Git metadata executor options are invalid");
  const has = (key: string): boolean => keys.includes(key);
  const gitExecutable = ownData(value, "gitExecutable");
  const maximumDurationMs = ownData(value, "maximumDurationMs");
  const maximumOutputBytes = ownData(value, "maximumOutputBytes");
  const maximumPreflightDurationMs = ownData(value, "maximumPreflightDurationMs");
  const signal = ownData(value, "signal");
  if (
    (has("gitExecutable") && typeof gitExecutable !== "string") ||
    (has("maximumDurationMs") && typeof maximumDurationMs !== "number") ||
    (has("maximumOutputBytes") && typeof maximumOutputBytes !== "number") ||
    (has("maximumPreflightDurationMs") && typeof maximumPreflightDurationMs !== "number") ||
    (has("signal") &&
      (typeof signal !== "object" ||
        signal === null ||
        nodeTypes.isProxy(signal) ||
        Object.getPrototypeOf(signal) !== AbortSignal.prototype))
  )
    throw new TypeError("Git metadata executor options are invalid");
  return Object.freeze({
    ...(has("gitExecutable") ? { gitExecutable: gitExecutable as string } : {}),
    ...(has("maximumDurationMs") ? { maximumDurationMs: maximumDurationMs as number } : {}),
    ...(has("maximumOutputBytes") ? { maximumOutputBytes: maximumOutputBytes as number } : {}),
    ...(has("maximumPreflightDurationMs")
      ? { maximumPreflightDurationMs: maximumPreflightDurationMs as number }
      : {}),
    ...(has("signal") ? { signal: signal as AbortSignal } : {}),
  });
}

function plainArguments(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > 16 ||
    Reflect.ownKeys(value).length !== lengthDescriptor.value + 1
  )
    return null;
  const output: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > 2_048 ||
      containsUnsafeGitText(descriptor.value)
    )
      return null;
    output.push(descriptor.value);
  }
  return Object.freeze(output);
}

function validRequest(value: GitMetadataRequest): boolean {
  const arguments_ = value.arguments;
  switch (value.kind) {
    case "resolve-head":
      return (
        arguments_.length === 3 && arguments_.join("\0") === "rev-parse\0--verify\0HEAD^{commit}"
      );
    case "resolve-base": {
      if (
        arguments_.length !== 4 ||
        arguments_[0] !== "rev-parse" ||
        arguments_[1] !== "--verify" ||
        arguments_[2] !== "--end-of-options"
      )
        return false;
      const reference = arguments_[3];
      return (
        reference !== undefined &&
        reference.endsWith("^{commit}") &&
        reference.length > "^{commit}".length &&
        reference.length <= 1_033 &&
        !containsUnsafeGitText(reference)
      );
    }
    case "merge-bases":
      return (
        arguments_.length === 4 &&
        arguments_[0] === "merge-base" &&
        arguments_[1] === "--all" &&
        SHA_PATTERN.test(arguments_[2] ?? "") &&
        SHA_PATTERN.test(arguments_[3] ?? "")
      );
    case "diff":
      return (
        arguments_.length === 7 &&
        arguments_[0] === "diff-index" &&
        arguments_[1] === "--cached" &&
        arguments_[2] === "--name-status" &&
        arguments_[3] === "-z" &&
        arguments_[4] === "--no-renames" &&
        SHA_PATTERN.test(arguments_[5] ?? "") &&
        arguments_[6] === "--"
      );
    case "index-state":
      return arguments_.length === 1 && arguments_[0] === "read-index";
    case "worktree-state":
      return arguments_.length === 1 && arguments_[0] === "read-worktree-state";
  }
}

function snapshotRequest(value: unknown): GitMetadataRequest | null {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !exactOwnKeys(value, REQUEST_KEYS)
  )
    return null;
  const arguments_ = plainArguments(ownData(value, "arguments"));
  const kind = ownData(value, "kind");
  const policyValue = ownData(value, "policy");
  if (
    arguments_ === null ||
    (kind !== "resolve-base" &&
      kind !== "resolve-head" &&
      kind !== "merge-bases" &&
      kind !== "diff" &&
      kind !== "index-state" &&
      kind !== "worktree-state") ||
    !plainPolicy(policyValue)
  )
    return null;
  const request = Object.freeze({ arguments: arguments_, kind, policy: REQUEST_POLICY });
  return validRequest(request) ? request : null;
}

function validRefName(value: string): boolean {
  let forbiddenCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(value[index] ?? "")) {
      forbiddenCharacter = true;
      break;
    }
  }
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    forbiddenCharacter
  )
    return false;
  return value.split("/").every((component) => {
    return (
      component.length > 0 &&
      component !== "." &&
      component !== ".." &&
      !component.startsWith(".") &&
      !component.endsWith(".lock")
    );
  });
}

function exactObjectId(value: string, format: "sha1" | "sha256"): boolean {
  return (format === "sha1" ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u).test(value);
}

type BeforeMetadataGuardVerification = () => Promise<void>;

async function boundMetadataFileWithin(
  context: OperationContext,
  root: string,
  relative: string,
  maximumBytes: number,
  beforeGuardVerification?: BeforeMetadataGuardVerification,
): Promise<ReferenceInputSnapshot> {
  const components = relative.split("/");
  if (
    components.length === 0 ||
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  )
    throw new TypeError("Git metadata path is invalid");
  const target = path.resolve(root, ...components);
  if (!isWithin(root, target)) throw new TypeError("Git metadata path escapes its root");
  const guards: FileIdentity[] = [await canonicalDirectory(context, root)];
  let current = root;
  for (const component of components.slice(0, -1)) {
    const child = path.join(current, component);
    try {
      const identity = await canonicalDirectory(context, child);
      guards.push(identity);
      current = child;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (beforeGuardVerification !== undefined) await context.wait(beforeGuardVerification);
      for (const guard of guards)
        if (!(await sameIdentity(context, guard)))
          throw new TypeError("Git metadata path changed while its absence was captured", {
            cause: error,
          });
      return Object.freeze({ bytes: null, file: null, guards: Object.freeze(guards) });
    }
  }
  let bytes: Uint8Array | null;
  let file: FileIdentity | null;
  try {
    const stable = await stableFile(context, target, maximumBytes);
    bytes = stable.bytes;
    file = stable.identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    bytes = null;
    file = null;
  }
  if (beforeGuardVerification !== undefined) await context.wait(beforeGuardVerification);
  for (const guard of guards)
    if (!(await sameIdentity(context, guard)))
      throw new TypeError("Git metadata path changed while it was captured");
  return Object.freeze({ bytes, file, guards: Object.freeze(guards) });
}

/** @internal Test-only wrapper for the exact post-capture metadata-guard race boundary. */
export async function bindMetadataFileWithinForTest(
  root: string,
  relative: string,
  maximumBytes: number,
  beforeGuardVerification: BeforeMetadataGuardVerification,
  signal?: AbortSignal,
): Promise<ReferenceInputSnapshot> {
  const context = new OperationContext(5_000, signal, "reference binding test");
  try {
    return await boundMetadataFileWithin(
      context,
      root,
      relative,
      maximumBytes,
      beforeGuardVerification,
    );
  } finally {
    context.dispose();
  }
}

async function referenceInputStillMatches(
  context: OperationContext,
  input: ReferenceInputSnapshot,
): Promise<boolean> {
  for (const guard of input.guards) if (!(await sameIdentity(context, guard))) return false;
  return input.file === null || (await sameIdentity(context, input.file));
}

async function referenceInputsStillMatch(
  context: OperationContext,
  inputs: readonly ReferenceInputSnapshot[],
): Promise<boolean> {
  for (const input of inputs) if (!(await referenceInputStillMatches(context, input))) return false;
  return true;
}

function decodeExactUtf8(bytes: Uint8Array): string {
  const value = Buffer.from(bytes).toString("utf8");
  if (Buffer.from(value, "utf8").byteLength !== bytes.byteLength)
    throw new TypeError("Git metadata is not exact UTF-8");
  return value;
}

function parseRefRecord(
  bytes: Uint8Array,
  format: "sha1" | "sha256",
): { readonly objectId?: string; readonly symbolic?: string } {
  const raw = decodeExactUtf8(bytes);
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (value.includes("\n") || value.includes("\r") || containsUnsafeGitText(value))
    throw new TypeError("Git reference metadata is invalid");
  if (value.startsWith("ref: ")) {
    const symbolic = value.slice(5);
    if (!symbolic.startsWith("refs/") || !validRefName(symbolic))
      throw new TypeError("Git symbolic reference is invalid");
    return Object.freeze({ symbolic });
  }
  if (!exactObjectId(value, format)) throw new TypeError("Git object identity is invalid");
  return Object.freeze({ objectId: value });
}

async function packedReferences(
  context: OperationContext,
  repository: RepositoryExecutionIdentity,
  format: "sha1" | "sha256",
): Promise<PackedReferenceSnapshot> {
  const packed = await boundMetadataFileWithin(
    context,
    repository.commonDirectory.path,
    "packed-refs",
    MAXIMUM_GIT_METADATA_BYTES,
  );
  if (packed.bytes === null)
    return Object.freeze({ inputs: Object.freeze([packed]), references: new Map() });
  const text = decodeExactUtf8(packed.bytes);
  const result = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) continue;
    const separator = line.indexOf(" ");
    if (separator < 1 || line.includes(" ", separator + 1))
      throw new TypeError("packed Git references are malformed");
    const objectId = line.slice(0, separator);
    const name = line.slice(separator + 1);
    if (!exactObjectId(objectId, format) || !name.startsWith("refs/") || !validRefName(name))
      throw new TypeError("packed Git reference is invalid");
    if (name === "refs/replace" || name.startsWith("refs/replace/"))
      throw new TypeError("packed Git replacement reference is unsupported");
    if (result.has(name)) throw new TypeError("packed Git reference is duplicated");
    result.set(name, objectId);
  }
  return Object.freeze({ inputs: Object.freeze([packed]), references: result });
}

async function exactReference(
  context: OperationContext,
  repository: RepositoryExecutionIdentity,
  name: string,
  format: "sha1" | "sha256",
  packed: ReadonlyMap<string, string>,
  inputs: ReferenceInputSnapshot[],
): Promise<string | null> {
  let current = name;
  const visited = new Set<string>();
  for (let depth = 0; depth < MAXIMUM_SYMBOLIC_REF_DEPTH; depth += 1) {
    if (visited.has(current)) throw new TypeError("Git symbolic reference cycle is unsupported");
    visited.add(current);
    const sourceRoot =
      current === "HEAD" ? repository.gitDirectory.path : repository.commonDirectory.path;
    const relative = current === "HEAD" ? "HEAD" : current;
    const loose = await boundMetadataFileWithin(context, sourceRoot, relative, 4_096);
    inputs.push(loose);
    if (loose.bytes === null) return packed.get(current) ?? null;
    const parsed = parseRefRecord(loose.bytes, format);
    if (parsed.objectId !== undefined) return parsed.objectId;
    current = parsed.symbolic ?? "";
  }
  throw new TypeError("Git symbolic reference depth is unsupported");
}

async function resolveReference(
  context: OperationContext,
  repository: RepositoryExecutionIdentity,
  value: string,
  format: "sha1" | "sha256",
): Promise<ReferenceResolutionSnapshot> {
  if (exactObjectId(value, format))
    return Object.freeze({ inputs: Object.freeze([]), objectId: value });
  if (value !== "HEAD" && !validRefName(value))
    throw new TypeError("Git reference name is unsupported");
  const packed = await packedReferences(context, repository, format);
  const inputs = [...packed.inputs];
  if (value === "HEAD") {
    const head = await exactReference(
      context,
      repository,
      value,
      format,
      packed.references,
      inputs,
    );
    if (head === null) throw new TypeError("Git HEAD is unresolved");
    return Object.freeze({ inputs: Object.freeze(inputs), objectId: head });
  }
  const candidates = value.startsWith("refs/")
    ? [value]
    : [
        value,
        `refs/${value}`,
        `refs/tags/${value}`,
        `refs/heads/${value}`,
        `refs/remotes/${value}`,
        `refs/remotes/${value}/HEAD`,
      ];
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (candidate !== "HEAD" && !candidate.startsWith("refs/")) continue;
    const objectId = await exactReference(
      context,
      repository,
      candidate,
      format,
      packed.references,
      inputs,
    );
    if (objectId !== null && !matches.includes(objectId)) matches.push(objectId);
  }
  if (matches.length !== 1) throw new TypeError("Git reference is unresolved or ambiguous");
  const resolved = matches[0];
  if (resolved === undefined) throw new TypeError("Git reference is unresolved");
  return Object.freeze({ inputs: Object.freeze(inputs), objectId: resolved });
}

async function syntheticGitIdentity(
  context: OperationContext,
  format: "sha1" | "sha256",
): Promise<SyntheticGitIdentity> {
  const directoryPath = fileURLToPath(new URL(`../git-runtime/${format}/`, import.meta.url));
  const canonical = await context.wait(() => realpath(directoryPath));
  if (!samePlatformPath(canonical, directoryPath.slice(0, -1)))
    throw new TypeError("synthetic Git runtime is not canonical");
  return Object.freeze({
    config: await fileIdentity(context, path.join(canonical, "config"), "file", true),
    directory: await fileIdentity(context, canonical, "directory"),
    head: await fileIdentity(context, path.join(canonical, "HEAD"), "file", true),
    objects: await canonicalDirectory(context, path.join(canonical, "objects")),
    refs: await canonicalDirectory(context, path.join(canonical, "refs")),
  });
}

async function syntheticGitIdentityStillMatches(
  context: OperationContext,
  identity: SyntheticGitIdentity,
): Promise<boolean> {
  return (
    (await sameIdentity(context, identity.directory)) &&
    (await sameIdentity(context, identity.config)) &&
    (await sameIdentity(context, identity.head)) &&
    (await sameIdentity(context, identity.objects)) &&
    (await sameIdentity(context, identity.refs))
  );
}

function commandArguments(
  runtime: SyntheticGitIdentity,
  request: GitMetadataRequest,
): readonly string[] {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return Object.freeze([
    `--git-dir=${runtime.directory.path}`,
    "--no-pager",
    "--no-optional-locks",
    "--no-replace-objects",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${nullDevice}`,
    "-c",
    "core.untrackedCache=false",
    "-c",
    "credential.helper=",
    "-c",
    "diff.external=",
    "-c",
    "protocol.allow=never",
    "-c",
    "submodule.recurse=false",
    ...request.arguments,
  ]);
}

function executionEnvironment(repository: RepositoryExecutionIdentity): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  // Node's permission model appends its own trusted NODE_OPTIONS propagation immediately before
  // spawn. The record must therefore remain mutable, but it is still a new closed allowlist and
  // never inherits repository or host environment entries.
  return {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ATTR_GLOBAL: nullDevice,
    GIT_CEILING_DIRECTORIES: repository.root.path,
    GIT_CONFIG_COUNT: "7",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_KEY_1: "core.hookspath",
    GIT_CONFIG_KEY_2: "core.untrackedcache",
    GIT_CONFIG_KEY_3: "credential.helper",
    GIT_CONFIG_KEY_4: "diff.external",
    GIT_CONFIG_KEY_5: "protocol.allow",
    GIT_CONFIG_KEY_6: "submodule.recurse",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_VALUE_1: nullDevice,
    GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_VALUE_3: "",
    GIT_CONFIG_VALUE_4: "",
    GIT_CONFIG_VALUE_5: "never",
    GIT_CONFIG_VALUE_6: "false",
    GIT_FLUSH: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OBJECT_DIRECTORY: repository.objectDirectory.path,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_INDEX_FILE: repository.indexPath,
    LANG: "C",
    LC_ALL: "C",
  };
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function readStableIndex(
  context: OperationContext,
  repository: RepositoryExecutionIdentity,
): Promise<IndexSnapshot> {
  if (!(await repositoryIdentityStillMatches(context, repository)))
    throw new TypeError("repository identity changed before index read");
  const indexPath = repository.indexPath;
  const beforePath = await context.wait(() => lstat(indexPath, { bigint: true }));
  if (
    beforePath.isSymbolicLink() ||
    !beforePath.isFile() ||
    beforePath.size < 1n ||
    beforePath.size > BigInt(CHANGED_FILE_METADATA_LIMITS.maximumCommandOutputBytes)
  )
    throw new TypeError("Git index is unavailable or unsupported");
  const handle = await context.open(indexPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await context.wait(() => handle.stat({ bigint: true }));
    if (
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      before.size !== beforePath.size ||
      before.mode !== beforePath.mode ||
      before.mtimeNs !== beforePath.mtimeNs ||
      before.ctimeNs !== beforePath.ctimeNs
    )
      throw new TypeError("Git index changed before it was read");
    const raw = await context.wait(() => handle.readFile({ signal: context.signal }));
    const after = await context.wait(() => handle.stat({ bigint: true }));
    if (
      raw.byteLength !== Number(before.size) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      !(await repositoryIdentityStillMatches(context, repository))
    )
      throw new TypeError("Git index changed while it was read");
    const bytes = Uint8Array.from(raw);
    const parsed = parseGitIndex(bytes, {
      maximumFiles: CHANGED_FILE_METADATA_LIMITS.maximumChangedPaths,
      maximumIndexBytes: CHANGED_FILE_METADATA_LIMITS.maximumCommandOutputBytes,
      maximumIndexEntries: CHANGED_FILE_METADATA_LIMITS.maximumChangedPaths,
    });
    if (parsed.entries.some((entry) => entry.stage !== 0))
      throw new TypeError("unmerged Git index entries are unsupported");
    return Object.freeze({
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
      parsed,
    });
  } finally {
    await context.close(handle);
  }
}

async function probeRepository(
  selection: RepositoryRootSelection,
  context: OperationContext,
): Promise<ReadOnlyRepository> {
  return context.wait(() =>
    createReadOnlyRepository(selection, {
      maximumDurationMs: context.remainingMilliseconds(),
      maximumEntries: CHANGED_FILE_METADATA_LIMITS.maximumChangedPaths,
      maximumFileBytes: MAXIMUM_RAW_FILE_BYTES,
      maximumMetadataOperations: CHANGED_FILE_METADATA_LIMITS.maximumChangedPaths * 8,
      maximumSymlinkDepth: 1,
      maximumTotalBytes: MAXIMUM_RAW_WORKTREE_BYTES,
      maximumTraversalDepth: MAXIMUM_RAW_DEPTH,
      signal: context.signal,
    }),
  );
}

function gitBlobObjectId(algorithm: "sha1" | "sha256", bytes: Uint8Array): string {
  return createHash(algorithm)
    .update(Buffer.from(`blob ${String(bytes.byteLength)}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

async function readWorktreeSnapshot(
  context: OperationContext,
  selection: RepositoryRootSelection,
  repository: RepositoryExecutionIdentity,
): Promise<WorktreeSnapshot> {
  const index = await readStableIndex(context, repository);
  const facade = await probeRepository(selection, context);
  const modified: string[] = [];
  const stateParts: Buffer[] = [
    Buffer.from("agent-context-worktree-state-v1\0", "ascii"),
    Buffer.from(`${index.digest}\0`, "ascii"),
  ];
  for (const entry of index.parsed.entries) {
    context.checkpoint();
    // Symlinks, gitlinks, and sparse-directory entries require a full scan. Both ordinary regular
    // modes are safe because scan evidence is raw content; chmod-only drift does not affect it.
    if (entry.stage !== 0 || (entry.mode !== 0o100644 && entry.mode !== 0o100755))
      throw new TypeError("tracked file mode is unsupported for changed-file proof");
    const file = await context.wait(() => facade.readFile(entry.path));
    if (file.linkDepth !== 0 || file.size > MAXIMUM_RAW_FILE_BYTES)
      throw new TypeError("tracked file cannot be read without links and within limits");
    const objectId = gitBlobObjectId(index.parsed.objectFormat, file.bytes());
    if (objectId !== entry.objectId) {
      modified.push(entry.path);
      stateParts.push(
        Buffer.from("M\0", "ascii"),
        Buffer.from(entry.path, "utf8"),
        Buffer.from("\0", "ascii"),
        Buffer.from(objectId, "ascii"),
        Buffer.from("\0", "ascii"),
      );
    }
  }
  const finalIndex = await readStableIndex(context, repository);
  if (finalIndex.digest !== index.digest)
    throw new TypeError("Git index changed while worktree content was captured");
  const state = Uint8Array.from(Buffer.concat(stateParts));
  if (state.byteLength > CHANGED_FILE_METADATA_LIMITS.maximumCommandOutputBytes)
    throw new TypeError("worktree state exceeded the metadata output limit");
  return Object.freeze({
    index,
    modifiedPaths: Object.freeze(modified.sort(byteCompare)),
    state,
  });
}

function changedPathsFromGitNameStatus(bytes: Uint8Array): ReadonlySet<string> {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(Buffer.from(bytes.slice(start, index)));
    start = index + 1;
  }
  if (start !== bytes.byteLength) throw new TypeError("Git name-status output is not terminated");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const statusBytes = fields[index] ?? Buffer.alloc(0);
    if (statusBytes.some((byte) => byte > 0x7f))
      throw new TypeError("Git name-status output contains a non-ASCII status");
    const status = statusBytes.toString("ascii");
    index += 1;
    if (!/^[ADMT]$/u.test(status))
      throw new TypeError("Git name-status output contains an unsupported status");
    const rawPath = fields[index];
    index += 1;
    if (rawPath === undefined || rawPath.byteLength === 0)
      throw new TypeError("Git name-status output contains an invalid path");
    paths.add(rawPath.toString("utf8"));
  }
  return paths;
}

function mergeWorktreeChanges(
  gitOutput: Uint8Array,
  snapshot: WorktreeSnapshot,
  maximumOutputBytes: number,
): Uint8Array {
  const present = changedPathsFromGitNameStatus(gitOutput);
  const additions: Buffer[] = [];
  let total = gitOutput.byteLength;
  for (const pathValue of snapshot.modifiedPaths) {
    if (present.has(pathValue)) continue;
    const record = Buffer.concat([
      Buffer.from("M\0", "ascii"),
      Buffer.from(pathValue, "utf8"),
      Buffer.from("\0", "ascii"),
    ]);
    total += record.byteLength;
    if (total > maximumOutputBytes)
      throw new TypeError("combined changed paths exceed the output limit");
    additions.push(record);
  }
  return Uint8Array.from(Buffer.concat([Buffer.from(gitOutput), ...additions], total));
}

function failureResponse(): GitMetadataResponse {
  return Object.freeze({ exitCode: 1, stdout: EMPTY_BYTES });
}

function attemptGitSpawn<T>(
  attempt: () => T,
): { readonly ok: false } | { readonly ok: true; readonly value: T } {
  try {
    return Object.freeze({ ok: true as const, value: attempt() });
  } catch {
    return Object.freeze({ ok: false as const });
  }
}

/** @internal Deterministic contract seam for synchronous host spawn rejection. */
export function mapGitSpawnFailureForTest(attempt: () => unknown): GitMetadataResponse | null {
  return attemptGitSpawn(attempt).ok ? null : failureResponse();
}

function commitPeelRequest(objectId: string): GitMetadataRequest {
  return Object.freeze({
    arguments: Object.freeze(["rev-parse", "--verify", "--end-of-options", `${objectId}^{commit}`]),
    kind: "resolve-base" as const,
    policy: REQUEST_POLICY,
  });
}

function terminate(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // A process that exited between the observation and signal needs no further cleanup.
  }
}

async function runGit(
  context: OperationContext,
  spawnGitProcess: SpawnGitProcess,
  executable: FileIdentity,
  repository: RepositoryExecutionIdentity,
  runtime: SyntheticGitIdentity,
  request: GitMetadataRequest,
  maximumOutputBytes: number,
): Promise<GitMetadataResponse> {
  if (
    aborted(context.signal) ||
    !(await sameIdentity(context, executable)) ||
    !(await repositoryIdentityStillMatches(context, repository)) ||
    !(await syntheticGitIdentityStillMatches(context, runtime))
  )
    return failureResponse();
  context.checkpoint();
  const remainingDurationMs = context.remainingMilliseconds();
  return new Promise((resolve) => {
    let outputBytes = 0;
    let stdoutBytes = 0;
    const output: Buffer[] = [];
    let settled = false;
    let stopping = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const started = attemptGitSpawn(() =>
      spawnGitProcess(executable.path, commandArguments(runtime, request), {
        cwd: repository.root.path,
        detached: process.platform !== "win32",
        env: executionEnvironment(repository),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
    if (!started.ok) {
      resolve(failureResponse());
      return;
    }
    const child: ReturnType<SpawnGitProcess> = started.value;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      terminate(child.pid, "SIGTERM");
      forceTimer = setTimeout(() => {
        terminate(child.pid, "SIGKILL");
      }, 200);
      forceTimer.unref();
    };
    const deadline = setTimeout(stop, remainingDurationMs);
    deadline.unref();
    const onAbort = (): void => {
      stop();
    };
    const finish = async (exitCode: number | null): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      try {
        Reflect.apply(REMOVE_EVENT_LISTENER, context.signal, ["abort", onAbort]);
      } catch {
        resolve(failureResponse());
        return;
      }
      let identitiesMatch: boolean;
      try {
        identitiesMatch =
          (await sameIdentity(context, executable)) &&
          (await repositoryIdentityStillMatches(context, repository)) &&
          (await syntheticGitIdentityStillMatches(context, runtime));
      } catch {
        identitiesMatch = false;
      }
      if (
        stopping ||
        aborted(context.signal) ||
        !identitiesMatch ||
        exitCode === null ||
        !Number.isSafeInteger(exitCode)
      ) {
        resolve(failureResponse());
        return;
      }
      resolve(
        Object.freeze({
          exitCode,
          stdout: Uint8Array.from(Buffer.concat(output, stdoutBytes)),
        }),
      );
    };
    try {
      Reflect.apply(ADD_EVENT_LISTENER, context.signal, ["abort", onAbort, { once: true }]);
    } catch {
      stop();
    }
    const consumeBytes = (chunk: Buffer): boolean => {
      if (stopping) return false;
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        output.length = 0;
        stop();
        return false;
      }
      return true;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!consumeBytes(chunk)) return;
      stdoutBytes += chunk.byteLength;
      output.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      consumeBytes(chunk);
    });
    child.once("error", stop);
    child.once("close", (code) => {
      void finish(code);
    });
    if (aborted(context.signal)) stop();
  });
}

/**
 * Build the only production metadata adapter used by explicit changed-file scans. Git receives
 * only commit/object/index commands; exact index and worktree probes use bounded no-follow reads.
 */
export async function createNodeGitMetadataExecutor(
  selection: RepositoryRootSelection,
  optionsValue: NodeGitMetadataExecutorOptions | AbortSignal = {},
): Promise<GitMetadataExecutor> {
  const options = snapshotOptions(
    !nodeTypes.isProxy(optionsValue) &&
      Object.getPrototypeOf(optionsValue) === AbortSignal.prototype
      ? { signal: optionsValue }
      : optionsValue,
  );
  const maximumOutputBytes =
    options.maximumOutputBytes ?? CHANGED_FILE_METADATA_LIMITS.maximumCommandOutputBytes;
  const maximumDurationMs =
    options.maximumDurationMs ?? CHANGED_FILE_METADATA_LIMITS.maximumCommandDurationMs - 500;
  const maximumPreflightDurationMs =
    options.maximumPreflightDurationMs ?? CHANGED_FILE_METADATA_LIMITS.maximumCommandDurationMs;
  if (
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1 ||
    maximumOutputBytes > CHANGED_FILE_METADATA_LIMITS.maximumCommandOutputBytes
  )
    throw new TypeError("Git metadata output limit is invalid");
  if (
    !Number.isSafeInteger(maximumDurationMs) ||
    maximumDurationMs < 1 ||
    maximumDurationMs > CHANGED_FILE_METADATA_LIMITS.maximumCommandDurationMs - 500
  )
    throw new TypeError("Git metadata duration limit is invalid");
  if (
    !Number.isSafeInteger(maximumPreflightDurationMs) ||
    maximumPreflightDurationMs < 1 ||
    maximumPreflightDurationMs > CHANGED_FILE_METADATA_LIMITS.maximumCommandDurationMs
  )
    throw new TypeError("Git metadata preflight duration limit is invalid");
  const creationContext = new OperationContext(
    maximumPreflightDurationMs,
    options.signal,
    "preflight",
  );
  let repository: RepositoryExecutionIdentity;
  let executable: FileIdentity;
  let objectFormat: "sha1" | "sha256";
  let runtime: SyntheticGitIdentity;
  let spawnGitProcess: SpawnGitProcess;
  try {
    repository = await repositoryIdentity(creationContext, selection);
    executable = await resolveExecutable(creationContext, selection, options.gitExecutable);
    const initialIndex = await readStableIndex(creationContext, repository);
    objectFormat = initialIndex.parsed.objectFormat;
    if (objectFormat !== repository.objectFormat)
      throw new TypeError("Git index object format does not match repository configuration");
    runtime = await syntheticGitIdentity(creationContext, objectFormat);
    // This runtime import is deliberately after explicit changed-mode composition and all executor
    // preflight. Default scans never initialize Node's process-spawning capability.
    ({ spawn: spawnGitProcess } = await creationContext.wait(() => import("node:child_process")));
    creationContext.checkpoint();
  } finally {
    creationContext.dispose();
  }
  let pendingFinalSnapshot: WorktreeSnapshot | null = null;
  const executor: GitMetadataExecutor = async (request, signal) => {
    let snapshot: GitMetadataRequest | null;
    try {
      snapshot = snapshotRequest(request);
    } catch {
      return failureResponse();
    }
    if (snapshot === null || aborted(signal)) return failureResponse();
    const context = new OperationContext(
      Math.min(maximumDurationMs, snapshot.policy.maximumDurationMs - 500),
      signal,
    );
    try {
      if (snapshot.kind === "index-state") {
        pendingFinalSnapshot = null;
        const index = await readStableIndex(context, repository);
        if (index.bytes.byteLength > maximumOutputBytes) return failureResponse();
        return Object.freeze({ exitCode: 0, stdout: index.bytes });
      }
      if (snapshot.kind === "worktree-state") {
        const worktree = await readWorktreeSnapshot(context, selection, repository);
        if (worktree.state.byteLength > maximumOutputBytes) return failureResponse();
        pendingFinalSnapshot = worktree;
        return Object.freeze({ exitCode: 0, stdout: worktree.state });
      }
      if (snapshot.kind === "resolve-head" || snapshot.kind === "resolve-base") {
        const finalSnapshot = snapshot.kind === "resolve-head" ? pendingFinalSnapshot : null;
        if (snapshot.kind === "resolve-head") pendingFinalSnapshot = null;
        const requested =
          snapshot.kind === "resolve-head"
            ? "HEAD"
            : (snapshot.arguments[3]?.slice(0, -"^{commit}".length) ?? "");
        const reference = await resolveReference(context, repository, requested, objectFormat);
        const result = await runGit(
          context,
          spawnGitProcess,
          executable,
          repository,
          runtime,
          commitPeelRequest(reference.objectId),
          maximumOutputBytes,
        );
        if (result.exitCode !== 0) return result;
        if (finalSnapshot !== null) {
          const postflight = await readWorktreeSnapshot(context, selection, repository);
          if (
            postflight.index.digest !== finalSnapshot.index.digest ||
            !Buffer.from(postflight.state).equals(Buffer.from(finalSnapshot.state))
          )
            return failureResponse();
        }
        if (!(await referenceInputsStillMatch(context, reference.inputs))) return failureResponse();
        const finalReference = await resolveReference(context, repository, requested, objectFormat);
        if (
          finalReference.objectId !== reference.objectId ||
          !(await referenceInputsStillMatch(context, finalReference.inputs))
        )
          return failureResponse();
        return result;
      }
      if (snapshot.kind === "diff") {
        pendingFinalSnapshot = null;
        const before = await readStableIndex(context, repository);
        const result = await runGit(
          context,
          spawnGitProcess,
          executable,
          repository,
          runtime,
          snapshot,
          maximumOutputBytes,
        );
        if (result.exitCode !== 0) return result;
        const after = await readStableIndex(context, repository);
        if (before.digest !== after.digest) return failureResponse();
        const worktree = await readWorktreeSnapshot(context, selection, repository);
        if (worktree.index.digest !== before.digest) return failureResponse();
        return Object.freeze({
          exitCode: 0,
          stdout: mergeWorktreeChanges(result.stdout, worktree, maximumOutputBytes),
        });
      }
      pendingFinalSnapshot = null;
      return await runGit(
        context,
        spawnGitProcess,
        executable,
        repository,
        runtime,
        snapshot,
        maximumOutputBytes,
      );
    } catch {
      pendingFinalSnapshot = null;
      return failureResponse();
    } finally {
      context.dispose();
    }
  };
  return executor;
}

/** Fixed request kinds retained here so the host allowlist is reviewable without hidden aliases. */
export const NODE_GIT_METADATA_REQUEST_KINDS: readonly GitMetadataRequestKind[] = Object.freeze([
  "resolve-base",
  "resolve-head",
  "merge-bases",
  "diff",
  "index-state",
  "worktree-state",
]);
