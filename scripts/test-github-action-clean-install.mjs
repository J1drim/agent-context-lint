import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TRACKED_FILES = 20_000;
const MAX_TRACKED_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_TRACKED_PATH_LENGTH = 4096;
const MAX_WORKSPACE_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const MAX_WORKSPACE_SNAPSHOT_ENTRIES = 100_000;
const SNAPSHOT_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

function fail(message) {
  throw new Error(`clean-install action test failed: ${message}`);
}

export function packageManagerInvocation(platform = process.platform) {
  if (platform === "win32")
    return Object.freeze({
      arguments: Object.freeze([
        "/d",
        "/s",
        "/c",
        "pnpm.cmd install --frozen-lockfile --no-runtime",
      ]),
      executable: "cmd.exe",
    });
  if (platform !== "darwin" && platform !== "linux") fail("unsupported clean-install platform");
  return Object.freeze({
    arguments: Object.freeze(["install", "--frozen-lockfile", "--no-runtime"]),
    executable: "pnpm",
  });
}

function hasUnsafePathCodePoint(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    )
      return true;
  }
  return false;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function workspaceSnapshot(directory = rootDirectory) {
  const entries = [];
  let entryCount = 0;
  let totalBytes = 0;

  async function visit(relative) {
    const absolute = relative === "" ? directory : path.join(directory, ...relative.split("/"));
    const children = await readdir(absolute, { withFileTypes: true });
    children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      if (child.isDirectory() && SNAPSHOT_EXCLUDED_DIRECTORIES.has(child.name)) continue;
      const childRelative = relative === "" ? child.name : `${relative}/${child.name}`;
      entryCount += 1;
      if (entryCount > MAX_WORKSPACE_SNAPSHOT_ENTRIES)
        fail("workspace snapshot entry limit exceeded");
      const childAbsolute = path.join(directory, ...childRelative.split("/"));
      const before = await lstat(childAbsolute, { bigint: true });
      const mode = Number(before.mode & 0o777n);
      if (before.isDirectory()) {
        entries.push({ mode, path: childRelative, type: "directory" });
        await visit(childRelative);
      } else if (before.isSymbolicLink()) {
        entries.push({
          mode,
          path: childRelative,
          target: await readlink(childAbsolute),
          type: "link",
        });
      } else if (before.isFile()) {
        totalBytes += Number(before.size);
        if (totalBytes > MAX_WORKSPACE_SNAPSHOT_BYTES)
          fail("workspace snapshot byte limit exceeded");
        const bytes = await readFile(childAbsolute);
        const after = await lstat(childAbsolute, { bigint: true });
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          fail("workspace changed while its snapshot was captured");
        entries.push({ mode, path: childRelative, sha256: sha256(bytes), type: "file" });
      } else fail("workspace snapshot encountered a special file");
    }
  }

  await visit("");
  return sha256(Buffer.from(JSON.stringify(entries)));
}

export function canonicalTrackedPaths(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_TRACKED_INVENTORY_BYTES)
    fail("tracked-file inventory must be bounded bytes");
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("tracked-file inventory is not valid UTF-8");
  }
  const entries = decoded.split("\0");
  if (entries.at(-1) !== "") fail("tracked-file inventory is truncated");
  entries.pop();
  if (entries.length === 0 || entries.length > MAX_TRACKED_FILES)
    fail("tracked-file count is invalid");
  const unique = new Set();
  for (const entry of entries) {
    if (
      entry.length === 0 ||
      entry.length > MAX_TRACKED_PATH_LENGTH ||
      hasUnsafePathCodePoint(entry) ||
      entry.includes("\\") ||
      entry.startsWith("/") ||
      entry
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      unique.has(entry)
    )
      fail("tracked-file inventory contains a non-canonical path");
    unique.add(entry);
  }
  return Object.freeze(
    [...unique].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
}

function run(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    ...options,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    fail(`${path.basename(executable)} exited with status ${String(result.status)}`);
}

async function copyTrackedTree(destination) {
  const inventory = execFileSync("git", ["ls-files", "--cached", "-z"], {
    cwd: rootDirectory,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const relative of canonicalTrackedPaths(inventory)) {
    const source = path.join(rootDirectory, ...relative.split("/"));
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      fail("tracked inputs must be ordinary files");
    const target = path.join(destination, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

export async function runCleanInstallActionTest() {
  const workspaceBefore = await workspaceSnapshot();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-context-i09-clean-install-"));
  let operationError;
  try {
    await copyTrackedTree(temporaryRoot);
    const pnpm = packageManagerInvocation();
    run(pnpm.executable, pnpm.arguments, {
      cwd: temporaryRoot,
      env: { ...process.env, CI: "true", PNPM_CONFIG_PM_ON_FAIL: "error" },
    });
    try {
      await lstat(path.join(temporaryRoot, "node_modules", "node", "bin", "node"));
      fail("--no-runtime unexpectedly installed a managed Node executable");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    run(process.execPath, ["scripts/build-github-action.mjs", "--check"], {
      cwd: temporaryRoot,
      env: { ...process.env, CI: "true" },
    });
  } catch (error) {
    operationError = error;
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
  const workspaceAfter = await workspaceSnapshot();
  if (workspaceAfter !== workspaceBefore) fail("source workspace changed during isolated test");
  if (operationError !== undefined) throw operationError;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2) fail("this test accepts no arguments");
  await runCleanInstallActionTest();
  console.log("Verified the GitHub Action from a fresh frozen --no-runtime installation.");
}
