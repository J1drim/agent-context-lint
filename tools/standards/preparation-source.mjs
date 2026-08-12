import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

import { canonicalJson, digest } from "./container/runtime-inputs.mjs";

const LIMITS = Object.freeze({
  files: 4_096,
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
});

export class PreparationGitError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "PreparationGitError";
    Object.assign(this, details);
  }
}

function safePath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function statIdentity(state) {
  return `${state.dev}:${state.ino}:${state.size}:${state.mtimeNs}`;
}

async function recordSafeAncestry(root, repositoryPath, directories) {
  let current = root;
  for (const segment of repositoryPath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const state = await lstat(current, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error(`preparation source refuses unsafe directory ancestry: ${repositoryPath}`);
    const identity = statIdentity(state);
    if (directories.has(current) && directories.get(current) !== identity)
      throw new Error(`preparation source directory ancestry changed: ${repositoryPath}`);
    directories.set(current, identity);
  }
}

async function runGit(root, arguments_, deadline) {
  const remaining = deadline - performance.now();
  if (remaining < 1) throw new Error("preparation source deadline expired");
  const child = spawn("/usr/bin/git", ["-C", root, "--no-optional-locks", ...arguments_], {
    env: {
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      HOME: root,
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let outputExceeded = false;
  let timedOut = false;
  const consume = (target) => (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > 4 * 1024 * 1024) {
      outputExceeded = true;
      child.kill("SIGKILL");
    } else target.push(chunk);
  };
  child.stdout.on("data", consume(stdout));
  child.stderr.on("data", consume(stderr));
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      Math.min(10_000, remaining),
    );
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (outputExceeded || result.code !== 0 || result.signal !== null)
    throw new PreparationGitError(
      `preparation source Git query failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 256)}`,
      {
        exitCode: result.code,
        outputExceeded,
        signal: result.signal,
        timedOut,
      },
    );
  return Buffer.concat(stdout);
}

export function isAbsentGitConfigValue(error) {
  return (
    error instanceof PreparationGitError &&
    error.exitCode === 1 &&
    error.signal === null &&
    error.timedOut === false &&
    error.outputExceeded === false
  );
}

export async function assertNoRepositoryHooks(root, deadline, git = runGit) {
  for (const scope of ["--local", "--worktree"]) {
    let output;
    try {
      output = await git(root, ["config", scope, "--get-all", "core.hooksPath"], deadline);
    } catch (error) {
      if (!isAbsentGitConfigValue(error)) throw error;
      output = Buffer.alloc(0);
    }
    if (output.byteLength !== 0)
      throw new Error(`preparation source refuses ${scope.slice(2)} core.hooksPath configuration`);
  }
  const gitDirectories = new Set();
  for (const selector of ["--git-dir", "--git-common-dir"]) {
    const value = (await git(root, ["rev-parse", "--path-format=absolute", selector], deadline))
      .toString("utf8")
      .trim();
    if (!path.isAbsolute(value)) throw new Error("preparation source received a relative Git dir");
    gitDirectories.add(value);
  }
  for (const gitDirectory of gitDirectories) {
    const hooks = path.join(gitDirectory, "hooks");
    try {
      const entries = await readdir(hooks, { withFileTypes: true });
      if (entries.some((entry) => !entry.name.endsWith(".sample")))
        throw new Error("preparation source refuses repository hook files");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

const PNPM_HOOK_FILE = /^(?:\.pnpmfile|pnpmfile)\.(?:cjs|mjs|js)$/iu;
const PNPM_HOOK_CONFIG = /^\s*(?:global[-_.]?)?pnpmfile(?:[-_.]?path)?\s*[:=]/imu;

function hasPackageJsonPnpmHook(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const hookKeys = ["globalPnpmfile", "globalPnpmFile", "pnpmfile", "pnpmFile"];
  if (hookKeys.some((key) => Object.hasOwn(value, key))) return true;
  for (const owner of ["config", "pnpm"])
    if (
      Object.hasOwn(value, owner) &&
      value[owner] !== null &&
      typeof value[owner] === "object" &&
      !Array.isArray(value[owner]) &&
      hookKeys.some((key) => Object.hasOwn(value[owner], key))
    )
      return true;
  return false;
}

export function assertNoPnpmProjectHook(repositoryPath, bytes) {
  const basename = path.posix.basename(repositoryPath);
  if (PNPM_HOOK_FILE.test(basename))
    throw new Error(`preparation source refuses pnpm project hook file: ${repositoryPath}`);
  if (basename === "package.json") {
    let manifest;
    try {
      manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      throw new Error(`preparation source refuses malformed package manifest: ${repositoryPath}`, {
        cause: error,
      });
    }
    if (hasPackageJsonPnpmHook(manifest))
      throw new Error(`preparation source refuses package pnpm hook setting: ${repositoryPath}`);
  }
  if (basename === ".npmrc" || basename === "pnpm-workspace.yaml") {
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`preparation source refuses malformed package config: ${repositoryPath}`, {
        cause: error,
      });
    }
    if (PNPM_HOOK_CONFIG.test(source))
      throw new Error(`preparation source refuses pnpm hook configuration: ${repositoryPath}`);
  }
}

export async function createPreparationSourceSnapshot(root, destination, options = {}) {
  const deadline = options.deadline?.expiresAt ?? performance.now() + 30_000;
  const canonicalRoot = await realpath(root);
  root = canonicalRoot;
  await assertNoRepositoryHooks(root, deadline);
  const [headBytes, trackedBytes, stagedBytes, untrackedBytes, ignoredBytes] = await Promise.all([
    runGit(root, ["rev-parse", "--verify", "HEAD"], deadline),
    runGit(root, ["ls-files", "-z"], deadline),
    runGit(root, ["ls-files", "--stage", "-z"], deadline),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], deadline),
    runGit(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], deadline),
  ]);
  const untracked = untrackedBytes.toString("utf8").split("\0").filter(Boolean);
  const ignored = ignoredBytes.toString("utf8").split("\0").filter(Boolean);
  if (untracked.length !== 0 || ignored.length !== 0)
    throw new Error(
      `preparation source refuses untracked (${untracked.length}) or ignored (${ignored.length}) paths`,
    );
  const tracked = trackedBytes.toString("utf8").split("\0").filter(Boolean).sort();
  const staged = stagedBytes
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const separator = row.indexOf("\t");
      const metadata = row.slice(0, separator).split(" ");
      return {
        blob: metadata[1],
        mode: metadata[0],
        path: row.slice(separator + 1),
        stage: metadata[2],
      };
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (
    tracked.length < 1 ||
    tracked.length > LIMITS.files ||
    staged.length !== tracked.length ||
    staged.some(
      (row, index) =>
        row.path !== tracked[index] ||
        row.stage !== "0" ||
        !/^[0-9a-f]{40,64}$/u.test(row.blob) ||
        !["100644", "100755"].includes(row.mode) ||
        !safePath(row.path),
    )
  )
    throw new Error("preparation source tracked/index inventory is unsupported");
  await mkdir(destination, { mode: 0o700 });
  const rows = [];
  const directories = new Map();
  const rootState = await lstat(root, { bigint: true });
  if (!rootState.isDirectory() || rootState.isSymbolicLink())
    throw new Error("preparation source refuses unsafe root ancestry");
  directories.set(root, statIdentity(rootState));
  let totalBytes = 0;
  for (const row of staged) {
    const absolute = path.join(root, row.path);
    await recordSafeAncestry(root, row.path, directories);
    const canonicalPath = await realpath(absolute);
    if (!canonicalPath.startsWith(`${root}${path.sep}`))
      throw new Error(`preparation source refuses escaping path: ${row.path}`);
    const state = await lstat(absolute, { bigint: true });
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.nlink !== 1n ||
      state.size > BigInt(LIMITS.fileBytes)
    )
      throw new Error(`preparation source refuses non-regular or oversized path: ${row.path}`);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const before = await handle.stat({ bigint: true });
      bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs
      )
        throw new Error(`preparation source changed while read: ${row.path}`);
    } finally {
      await handle.close();
    }
    const indexBytes = await runGit(root, ["cat-file", "blob", row.blob], deadline);
    if (!bytes.equals(indexBytes))
      throw new Error(`preparation source index/worktree bytes differ: ${row.path}`);
    assertNoPnpmProjectHook(row.path, bytes);
    totalBytes += bytes.byteLength;
    if (totalBytes > LIMITS.totalBytes)
      throw new Error("preparation source aggregate bytes exceed limit");
    const target = path.join(destination, row.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: row.mode === "100755" ? 0o700 : 0o600 });
    rows.push({ ...row, bytes: bytes.byteLength, sha256: digest("sha256", bytes) });
  }
  const manifest = {
    contractVersion: "1.0.0",
    gitHead: headBytes.toString("ascii").trim(),
    ignoredFileCount: 0,
    packageManagerExecutionPolicy: {
      configFilesAreNonAuthoritative: true,
      corepackDisabled: true,
      gitConfigQueriesFailClosed: true,
      lifecycleHooksDisabled: true,
      pnpmfileHooksRejected: true,
      pnpmfileIgnored: true,
      scriptsDisabled: true,
    },
    recordKind: "agent-context-h13-preparation-source-manifest",
    rows,
    totalBytes,
    trackedFileCount: rows.length,
    untrackedFileCount: 0,
  };
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  const manifestPath = path.join(destination, "preparation-source-manifest.v1.json");
  await writeFile(manifestPath, bytes, { flag: "wx", mode: 0o600 });
  for (const [directory, identity] of directories) {
    const state = await lstat(directory, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink() || statIdentity(state) !== identity)
      throw new Error("preparation source directory ancestry changed while snapshotted");
  }
  const [headAfter, trackedAfter, stagedAfter, untrackedAfter, ignoredAfter] = await Promise.all([
    runGit(root, ["rev-parse", "--verify", "HEAD"], deadline),
    runGit(root, ["ls-files", "-z"], deadline),
    runGit(root, ["ls-files", "--stage", "-z"], deadline),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], deadline),
    runGit(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], deadline),
  ]);
  if (
    !headAfter.equals(headBytes) ||
    !trackedAfter.equals(trackedBytes) ||
    !stagedAfter.equals(stagedBytes) ||
    !untrackedAfter.equals(untrackedBytes) ||
    !ignoredAfter.equals(ignoredBytes)
  )
    throw new Error("preparation source repository state changed while snapshotted");
  await assertNoRepositoryHooks(root, deadline);
  return Object.freeze({ manifest, manifestPath, manifestSha256: digest("sha256", bytes) });
}

export function compareReviewedPreparationManifests(first, second) {
  if (canonicalJson(first) !== canonicalJson(second))
    throw new Error("reviewed H13 preparations have different manifests");
  return Object.freeze({
    manifestSha256: digest("sha256", Buffer.from(`${canonicalJson(first)}\n`)),
    reviewedPrepareCount: 2,
  });
}
