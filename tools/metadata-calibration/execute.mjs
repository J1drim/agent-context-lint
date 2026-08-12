#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

import {
  MAXIMUM_CALIBRATION_ARTIFACT_BYTES,
  createCalibrationCaptureAccumulator,
} from "./capture.mjs";
import {
  canonicalJson,
  prettyJson,
  sha256Canonical,
  validateCalibrationCorpus,
  validateCandidateSnapshot,
} from "./contracts.mjs";
import { validateFrozenCalibrationFrameBytes } from "./precision.mjs";
import { createDarwinQuotaVolumeProvider, verifyQuotaVolume } from "./quota-volume.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const GUARD_PATH = path.join(MODULE_DIRECTORY, "capability-guard.mjs");
const MAXIMUM_STDOUT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_STDERR_BYTES = 1024 * 1024;
const CHECKOUT_TIMEOUT_MS = 10 * 60 * 1000;
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const MAXIMUM_CHECKOUT_FILES = 150_000;
const MAXIMUM_PACKAGE_FILES = 20_000;
const MAXIMUM_PACKAGE_BYTES = 256 * 1024 * 1024;

function checkoutLogicalBudget(repository) {
  const value = Math.max(64 * 1024 * 1024, repository.diskUsageKiB * 1024 * 2);
  if (!Number.isSafeInteger(value)) throw new Error("checkout logical byte budget is invalid");
  return value;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safeSegment(value) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value) || value === "." || value === "..")
    throw new Error("repository name contains an unsafe checkout segment");
  return value;
}

function repositoryUrl(fullName) {
  const segments = fullName.split("/");
  if (segments.length !== 2) throw new Error("selected repository name is invalid");
  return `https://github.com/${safeSegment(segments[0])}/${safeSegment(segments[1])}.git`;
}

function minimalEnvironment(home) {
  const environment = Object.create(null);
  for (const key of ["PATH", "TMPDIR", "SYSTEMROOT", "SystemRoot"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.HOME = home;
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = "/dev/null";
  environment.GIT_LFS_SKIP_SMUDGE = "1";
  environment.GIT_ASKPASS = "/dev/null";
  environment.GIT_SSH_COMMAND = "false";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.SSH_ASKPASS = "/dev/null";
  environment.LC_ALL = "C";
  environment.LANG = "C";
  environment.NO_COLOR = "1";
  return environment;
}

export function runBoundedCommand(
  executable,
  arguments_,
  {
    cwd,
    environment,
    maximumStderrBytes = MAXIMUM_STDERR_BYTES,
    maximumStdoutBytes = MAXIMUM_STDOUT_BYTES,
    monitorTree = null,
    signal: cancellationSignal,
    stdinBytes = null,
    stdoutEncoding = "utf8",
    timeoutMs,
  },
) {
  if (!new Set(["buffer", "utf8"]).has(stdoutEncoding))
    throw new Error("bounded command stdout encoding is invalid");
  if (stdinBytes !== null && !Buffer.isBuffer(stdinBytes) && typeof stdinBytes !== "string")
    throw new Error("bounded command stdin is invalid");
  if (stdinBytes !== null && Buffer.byteLength(stdinBytes) > 64)
    throw new Error("bounded command stdin exceeded its limit");
  if (cancellationSignal?.aborted === true)
    return Promise.reject(new Error("bounded command was cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: [stdinBytes === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failure = null;
    let monitoring = false;
    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const fail = (error) => {
      if (settled || failure !== null) return;
      failure = error;
      clearTimeout(timer);
      clearInterval(monitor);
      killTree();
    };
    const timer = setTimeout(
      () => fail(new Error("bounded command exceeded its timeout")),
      timeoutMs,
    );
    const monitor = setInterval(() => {
      if (monitorTree === null || monitoring || failure !== null || settled) return;
      monitoring = true;
      boundedTreeInventory(monitorTree.root, monitorTree)
        .catch((error) => fail(error))
        .finally(() => {
          monitoring = false;
        });
    }, 5);
    monitor.unref();
    const cancel = () => fail(new Error("bounded command was cancelled"));
    cancellationSignal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumStdoutBytes)
        fail(new Error("bounded command stdout exceeded its limit"));
      else stdout.push(chunk);
    });
    if (stdinBytes !== null) child.stdin.end(stdinBytes, (error) => error && fail(error));
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maximumStderrBytes)
        fail(new Error("bounded command stderr exceeded its limit"));
      else stderr.push(chunk);
    });
    child.once("error", fail);
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(monitor);
      cancellationSignal?.removeEventListener("abort", cancel);
      // The direct process can close after handing work to another member of its
      // issued process group. Terminate that group on every return path, including
      // success, before exposing a result to the caller.
      killTree();
      if (failure !== null) {
        reject(failure);
        return;
      }
      try {
        const stdoutBytesValue = Buffer.concat(stdout);
        const stdoutValue =
          stdoutEncoding === "buffer"
            ? stdoutBytesValue
            : new TextDecoder("utf-8", { fatal: true }).decode(stdoutBytesValue);
        const stderrText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderr));
        resolve({ signal, status, stderr: stderrText, stdout: stdoutValue });
      } catch {
        killTree();
        reject(new Error("bounded command emitted malformed UTF-8"));
      }
    });
  });
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isOutsideRepository(candidate) {
  return !isWithin(REPOSITORY_ROOT, candidate) && !isWithin(candidate, REPOSITORY_ROOT);
}

async function ensureExistingDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw new Error(`${label} must be an absolute path`);
  const lexical = path.resolve(value);
  const lexicalMetadata = await lstat(lexical);
  if (lexicalMetadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const resolved = await realpath(lexical);
  const resolvedParent = await realpath(path.dirname(lexical));
  if (resolved !== path.join(resolvedParent, path.basename(lexical)))
    throw new Error(`${label} must not substitute its final path component`);
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

async function ensureDedicatedTemporaryRoot(value, label, { requireEmpty = false } = {}) {
  const resolved = await ensureExistingDirectory(value, label);
  const temporaryRoot = await realpath(os.tmpdir());
  if (!isWithin(temporaryRoot, resolved) || resolved === temporaryRoot)
    throw new Error(`${label} must be a dedicated child of the operating-system temporary root`);
  if (!isOutsideRepository(resolved)) throw new Error(`${label} must be outside the repository`);
  const metadata = await stat(resolved);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    new Set(["work root", "package root"]).has(label) &&
    ((metadata.mode & 0o777) !== 0o700 || (uid !== null && metadata.uid !== uid))
  )
    throw new Error(`${label} must be owned by the capture user with exact mode 0700`);
  if (requireEmpty && (await readdir(resolved)).length !== 0)
    throw new Error(`${label} must be empty before capture`);
  return resolved;
}

async function ensureRegularFile(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw new Error(`${label} must be an absolute path`);
  const lexical = path.resolve(value);
  const metadata = await lstat(lexical);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${label} must be a regular file`);
  return lexical;
}

export async function validateCapturePaths(workRootValue, privateOutputValue) {
  const workRoot = await ensureDedicatedTemporaryRoot(workRootValue, "work root", {
    requireEmpty: true,
  });
  if (!path.isAbsolute(privateOutputValue))
    throw new Error("private review output must be absolute");
  const outputName = path.basename(privateOutputValue);
  const outputParent = await realpath(path.dirname(privateOutputValue));
  const privateOutput = path.join(outputParent, outputName);
  if (outputParent !== workRoot || outputName !== "private-review.json")
    throw new Error(
      "private review output must be the fixed direct child of the dedicated work root",
    );
  return Object.freeze({ privateOutput, workRoot });
}

export async function publishPrivateReview(workRoot, privateOutput, value) {
  const guard = await createPrivateReviewPublicationGuard(workRoot, privateOutput);
  try {
    await guard.publish(value);
  } finally {
    await guard.close();
  }
}

export async function createPrivateReviewPublicationGuard(workRoot, privateOutput) {
  const parentReal = await realpath(path.dirname(privateOutput));
  if (parentReal !== workRoot)
    throw new Error("private review output parent differs from the dedicated work root");
  const parentBefore = await stat(workRoot);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if ((parentBefore.mode & 0o077) !== 0 || (uid !== null && parentBefore.uid !== uid))
    throw new Error("private review output parent is not private to the capture user");
  const parentHandle = await open(workRoot, fsConstants.O_RDONLY);
  const heldParent = await parentHandle.stat();
  if (heldParent.dev !== parentBefore.dev || heldParent.ino !== parentBefore.ino) {
    await parentHandle.close();
    throw new Error("private review output parent changed before reservation");
  }
  let handle;
  let opened;
  try {
    handle = await open(
      privateOutput,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1)
      throw new Error("private review output did not open as a unique regular file");
  } catch (error) {
    await handle?.close();
    await parentHandle.close();
    throw error;
  }
  let closed = false;
  const assertPublicationIdentity = async (expectedSize) => {
    const [parentAfter, heldAfter, outputAfter, heldOutputAfter] = await Promise.all([
      stat(workRoot),
      parentHandle.stat(),
      lstat(privateOutput),
      handle.stat(),
    ]);
    if (
      parentBefore.dev !== parentAfter.dev ||
      parentBefore.ino !== parentAfter.ino ||
      heldAfter.dev !== heldParent.dev ||
      heldAfter.ino !== heldParent.ino ||
      !outputAfter.isFile() ||
      outputAfter.isSymbolicLink() ||
      outputAfter.dev !== opened.dev ||
      outputAfter.ino !== opened.ino ||
      outputAfter.nlink !== 1 ||
      heldOutputAfter.dev !== opened.dev ||
      heldOutputAfter.ino !== opened.ino ||
      heldOutputAfter.size !== expectedSize
    )
      throw new Error("private review output identity changed during publication");
  };
  return Object.freeze({
    close: async () => {
      if (closed) return;
      closed = true;
      const errors = [];
      for (const resource of [handle, parentHandle]) {
        try {
          await resource.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0)
        throw new AggregateError(errors, "private review publication handles did not close", {
          cause: errors[0],
        });
    },
    publish: async (value) => {
      if (closed) throw new Error("private review publication guard is closed");
      const bytes = Buffer.from(prettyJson(value));
      await assertPublicationIdentity(0);
      await handle.writeFile(bytes);
      await handle.sync();
      await assertPublicationIdentity(bytes.length);
      await parentHandle.sync();
    },
  });
}

async function boundedTreeInventory(
  root,
  { maximumBytes, maximumFiles, rejectAtLimit = false, tolerateRaces = false },
) {
  const entries = [];
  const pending = [root];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (tolerateRaces && error?.code === "ENOENT") continue;
      throw error;
    }
    names.sort(compareUtf8);
    for (const name of names) {
      const absolute = path.join(directory, name);
      let metadata;
      try {
        metadata = await lstat(absolute);
      } catch (error) {
        if (tolerateRaces && error?.code === "ENOENT") continue;
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        entries.push({
          modifiedMs: metadata.mtimeMs,
          mode: "symlink",
          permissions: metadata.mode & 0o777,
          path: path.relative(root, absolute),
          target: await readlink(absolute),
        });
      } else if (metadata.isDirectory()) {
        pending.push(absolute);
        entries.push({
          modifiedMs: metadata.mtimeMs,
          mode: "directory",
          permissions: metadata.mode & 0o777,
          path: path.relative(root, absolute),
        });
      } else if (metadata.isFile()) {
        totalBytes += metadata.size;
        entries.push({
          modifiedMs: metadata.mtimeMs,
          mode: "file",
          permissions: metadata.mode & 0o777,
          path: path.relative(root, absolute),
          size: metadata.size,
        });
      } else {
        throw new Error("bounded tree contains a special file");
      }
      if (
        entries.length > maximumFiles ||
        totalBytes > maximumBytes ||
        (rejectAtLimit && (entries.length === maximumFiles || totalBytes === maximumBytes))
      )
        throw new Error("bounded tree exceeds its file or byte budget");
    }
  }
  return { entries, totalBytes };
}

async function freezeCheckout(root) {
  const pending = [root];
  const directories = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    directories.push(directory);
    const names = await readdir(directory);
    for (const name of names) {
      const absolute = path.join(directory, name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) pending.push(absolute);
      else if (metadata.isFile()) await chmod(absolute, metadata.mode & 0o111 ? 0o555 : 0o444);
      else throw new Error("checkout contains a special file");
    }
  }
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) await chmod(directory, 0o555);
}

async function checkoutInventory(root, budget) {
  const inventory = await boundedTreeInventory(root, budget);
  for (const entry of inventory.entries) {
    if (entry.mode !== "file") continue;
    const absolute = path.join(root, entry.path);
    const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== entry.size)
        throw new Error("read-only checkout changed while hashing its inventory");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < before.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - position),
          position,
        );
        if (bytesRead === 0)
          throw new Error("read-only checkout changed while hashing its inventory");
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("read-only checkout changed while hashing its inventory");
      entry.sha256 = hash.digest("hex");
    } finally {
      await handle.close();
    }
  }
  return Object.freeze({
    sha256: sha256Canonical({
      entries: inventory.entries,
      format: "k03-read-only-checkout-inventory-v1",
      totalBytes: inventory.totalBytes,
    }),
    totalBytes: inventory.totalBytes,
  });
}

export async function verifyFrozenCheckout(checkout, { verifyQuota = verifyQuotaVolume } = {}) {
  if (checkout.quota === null || checkout.quota === undefined)
    throw new Error("read-only checkout has no quota-volume evidence");
  await verifyQuota(checkout.quota);
  const inventory = await checkoutInventory(checkout.root, checkout.budget);
  if (inventory.sha256 !== checkout.inventorySha256)
    throw new Error("read-only checkout inventory changed after capture");
  return inventory;
}

async function packageInventory(root) {
  const inventory = await boundedTreeInventory(root, {
    maximumBytes: MAXIMUM_PACKAGE_BYTES,
    maximumFiles: MAXIMUM_PACKAGE_FILES,
  });
  if (inventory.entries.some((entry) => entry.mode === "symlink"))
    throw new Error("extracted package inventory must not contain symbolic links");
  const files = [];
  for (const entry of inventory.entries) {
    if (entry.mode !== "file") continue;
    const bytes = await readFile(path.join(root, entry.path));
    files.push({
      path: entry.path.split(path.sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: entry.size,
    });
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  return files;
}

function exactManifestKeys(manifest, expected, label) {
  if (Object.hasOwn(manifest, "scripts"))
    throw new Error(`${label} must not contain lifecycle scripts`);
  const actual = Object.keys(manifest).sort(compareUtf8);
  const required = [...expected].sort(compareUtf8);
  if (canonicalJson(actual) !== canonicalJson(required))
    throw new Error(`${label} has unexpected or missing fields`);
}

async function rejectSymlinkComponents(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`${label} must be contained by the extracted package root`);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`);
  }
}

async function verifyExportTargets(packageRoot, exports_, label) {
  const pending = [exports_];
  const targets = new Set();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") targets.add(value);
    else if (value !== null && typeof value === "object" && !Array.isArray(value))
      pending.push(...Object.values(value));
    else throw new Error(`${label} contains an invalid export target`);
  }
  for (const target of targets) {
    const absolute = path.resolve(packageRoot, target);
    if (!isWithin(packageRoot, absolute))
      throw new Error(`${label} export target escapes its package`);
    await rejectSymlinkComponents(packageRoot, absolute, `${label} export target`);
    await ensureRegularFile(absolute, `${label} export target`);
  }
}

async function readJsonRegularFile(absolutePath, label) {
  const regular = await ensureRegularFile(absolutePath, label);
  const bytes = await readFile(regular);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const duplicateCheck = parseDocument(text, { maxAliasCount: 0, uniqueKeys: true });
    if (duplicateCheck.errors.length > 0) throw new Error("duplicate object keys");
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid unique-key UTF-8 JSON`);
  }
}

async function executeWithStableIdentity(absolute, beforeBytes, label, operation) {
  let result;
  let failure = null;
  try {
    result = await operation();
  } catch (error) {
    failure = error;
  }
  let identityFailure = null;
  try {
    const after = await ensureRegularFile(absolute, label);
    if (
      (await realpath(after)) !== (await realpath(absolute)) ||
      !Buffer.from(await readFile(after)).equals(Buffer.from(beforeBytes))
    )
      throw new Error(`${label} changed during execution`);
  } catch (error) {
    identityFailure = error;
  }
  if (failure !== null && identityFailure !== null)
    throw new AggregateError(
      [failure, identityFailure],
      `${label} operation failed and its executable identity changed`,
      { cause: failure },
    );
  if (failure !== null) throw failure;
  if (identityFailure !== null) throw identityFailure;
  return result;
}

export async function inspectExecutableIdentity(
  executable,
  label,
  arguments_,
  command = runBoundedCommand,
) {
  const absolute = await ensureRegularFile(executable, label);
  const bytes = await readFile(absolute);
  const result = await executeWithStableIdentity(absolute, bytes, label, () =>
    command(absolute, arguments_, {
      cwd: path.dirname(absolute),
      environment: minimalEnvironment(os.tmpdir()),
      maximumStderrBytes: 4096,
      maximumStdoutBytes: 4096,
      timeoutMs: 30_000,
    }),
  );
  const version = result.stdout.trim();
  if (result.status !== 0 || result.signal !== null || version.length < 1 || version.length > 256)
    throw new Error(`${label} has no bounded reviewed version identity`);
  return Object.freeze({
    path: await realpath(absolute),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    version,
  });
}

async function exactFileSha256(absolute, label) {
  const regular = await ensureRegularFile(absolute, label);
  const resolved = await realpath(regular);
  if (resolved !== absolute) throw new Error(`${label} must have an exact canonical path`);
  return createHash("sha256")
    .update(await readFile(regular))
    .digest("hex");
}

export async function inspectGitRuntime(gitExecutable, command = runBoundedCommand) {
  const git = await inspectExecutableIdentity(
    gitExecutable,
    "Git executable",
    ["--version"],
    command,
  );
  const result = await command(git.path, ["--exec-path"], {
    cwd: path.dirname(git.path),
    environment: minimalEnvironment(os.tmpdir()),
    maximumStderrBytes: 4096,
    maximumStdoutBytes: 4096,
    timeoutMs: 30_000,
  });
  const execPath = result.stdout.trim();
  if (
    result.status !== 0 ||
    result.signal !== null ||
    !path.isAbsolute(execPath) ||
    (await realpath(execPath)) !== execPath
  )
    throw new Error("Git has no exact canonical exec-path identity");
  const httpsPath = path.join(execPath, "git-remote-https");
  const lexical = await lstat(httpsPath);
  let linkTarget = null;
  let target = httpsPath;
  if (lexical.isSymbolicLink()) {
    linkTarget = await readlink(httpsPath);
    if (path.isAbsolute(linkTarget) || linkTarget.split(path.sep).includes(".."))
      throw new Error("Git HTTPS helper symbolic link must remain inside its exec-path");
    target = path.resolve(execPath, linkTarget);
  } else if (!lexical.isFile()) throw new Error("Git HTTPS helper is not an ordinary file or link");
  if (!isWithin(execPath, target)) throw new Error("Git HTTPS helper target escaped its exec-path");
  const targetSha256 = await exactFileSha256(target, "Git HTTPS helper target");
  const children = [];
  for (const name of ["git-index-pack", "git-unpack-objects"]) {
    const childPath = path.join(execPath, name);
    const childLexical = await lstat(childPath);
    const childLinkTarget = childLexical.isSymbolicLink() ? await readlink(childPath) : null;
    const childTarget = childLexical.isSymbolicLink()
      ? path.resolve(execPath, childLinkTarget)
      : childPath;
    if (
      (!childLexical.isFile() && !childLexical.isSymbolicLink()) ||
      childTarget !== git.path ||
      (await exactFileSha256(childTarget, `Git ${name} target`)) !== git.sha256
    )
      throw new Error(`Git ${name} must resolve to the exact reviewed Git executable`);
    children.push(
      Object.freeze({ linkTarget: childLinkTarget, path: childPath, target: childTarget }),
    );
  }
  if ((await exactFileSha256(git.path, "Git executable")) !== git.sha256)
    throw new Error("Git executable changed during HTTPS runtime inspection");
  return Object.freeze({
    git,
    helper: Object.freeze({
      path: httpsPath,
      sha256: sha256Canonical({
        children,
        format: "k03-git-https-helper-v1",
        linkTarget,
        targetSha256,
      }),
      target,
      targetSha256,
      version: `target-sha256:${targetSha256};link:${linkTarget ?? "ordinary-file"}`,
    }),
    children: Object.freeze(children),
    execPath,
  });
}

export async function verifyGitRuntimeIdentity(expected) {
  if ((await exactFileSha256(expected.gitPath, "Git executable")) !== expected.gitSha256)
    throw new Error("Git executable identity changed during checkout");
  const lexical = await lstat(expected.helperPath);
  const observedLink = lexical.isSymbolicLink() ? await readlink(expected.helperPath) : null;
  if (observedLink !== expected.helperLinkTarget)
    throw new Error("Git HTTPS helper link identity changed during checkout");
  const observedTarget = lexical.isSymbolicLink()
    ? path.resolve(expected.execPath, observedLink)
    : expected.helperPath;
  if (
    observedTarget !== expected.helperTarget ||
    !isWithin(expected.execPath, observedTarget) ||
    (await exactFileSha256(observedTarget, "Git HTTPS helper target")) !==
      expected.helperTargetSha256
  )
    throw new Error("Git HTTPS helper target identity changed during checkout");
  for (const child of expected.children) {
    const metadata = await lstat(child.path);
    const observedLink = metadata.isSymbolicLink() ? await readlink(child.path) : null;
    const observedTarget = metadata.isSymbolicLink()
      ? path.resolve(expected.execPath, observedLink)
      : child.path;
    if (
      observedLink !== child.linkTarget ||
      observedTarget !== expected.gitPath ||
      (await exactFileSha256(observedTarget, "Git required child target")) !== expected.gitSha256
    )
      throw new Error("Git required child executable identity changed during checkout");
  }
}

export async function inspectSystemHelpIdentity(executable, label, command = runBoundedCommand) {
  const absolute = await ensureRegularFile(executable, label);
  const bytes = await readFile(absolute);
  const result = await executeWithStableIdentity(absolute, bytes, label, () =>
    command(absolute, ["--help"], {
      cwd: path.dirname(absolute),
      environment: minimalEnvironment(os.tmpdir()),
      maximumStderrBytes: 16 * 1024,
      maximumStdoutBytes: 16 * 1024,
      timeoutMs: 30_000,
    }),
  );
  const output = `${result.stdout}\0${result.stderr}`;
  if (result.signal !== null || output.length < 1)
    throw new Error(`${label} has no bounded reviewed help identity`);
  return Object.freeze({
    path: await realpath(absolute),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    version: `help-sha256:${createHash("sha256").update(output).digest("hex")}`,
  });
}

export async function inspectHdiutilIdentity(
  hdiutilExecutable = "/usr/bin/hdiutil",
  command = runBoundedCommand,
) {
  if (hdiutilExecutable !== "/usr/bin/hdiutil")
    throw new Error("quota capture requires the exact /usr/bin/hdiutil executable");
  const executable = await ensureRegularFile(hdiutilExecutable, "hdiutil executable");
  const bytes = await readFile(executable);
  const result = await executeWithStableIdentity(executable, bytes, "hdiutil executable", () =>
    command(executable, ["help"], {
      cwd: "/usr/bin",
      environment: minimalEnvironment(os.tmpdir()),
      maximumStderrBytes: 4096,
      maximumStdoutBytes: 4096,
      timeoutMs: 30_000,
    }),
  );
  if (result.status !== 0 || result.signal !== null || !result.stderr.startsWith("Usage:"))
    throw new Error("hdiutil has no bounded reviewed help identity");
  return Object.freeze({
    path: executable,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    version: `help-sha256:${createHash("sha256").update(result.stderr).digest("hex")}`,
  });
}

export async function inspectCaptureRuntime({
  cliEntry,
  command = runBoundedCommand,
  gitExecutable,
  hdiutilExecutable,
  nodeExecutable,
  packageRoot,
}) {
  const [packed, gitRuntime, hdiutil, node, sandboxExec, guardBytes] = await Promise.all([
    inspectPackedEngine(packageRoot, cliEntry),
    inspectGitRuntime(gitExecutable, command),
    inspectHdiutilIdentity(hdiutilExecutable, command),
    inspectExecutableIdentity(nodeExecutable, "Node executable", ["--version"], command),
    inspectSystemHelpIdentity("/usr/bin/sandbox-exec", "sandbox-exec executable", command),
    readFile(await ensureRegularFile(GUARD_PATH, "capture capability guard")),
  ]);
  const { git, helper: gitRemoteHttps } = gitRuntime;
  if (!/^git version [0-9]+\.[0-9]+\.[0-9]+(?:\s|$)/.test(git.version))
    throw new Error("Git executable version is unsupported or malformed");
  if (!/^v(?:24|26)\.[0-9]+\.[0-9]+(?:-.+)?$/.test(node.version))
    throw new Error("Node executable version is outside the reviewed runtime line");
  if (hdiutilExecutable !== "/usr/bin/hdiutil" || hdiutil.path !== "/usr/bin/hdiutil")
    throw new Error("quota capture requires the exact /usr/bin/hdiutil executable");
  const guardSha256 = createHash("sha256").update(guardBytes).digest("hex");
  return Object.freeze({
    defaultSeverityByRule: packed.defaultSeverityByRule,
    engine: Object.freeze({
      git: Object.freeze({ sha256: git.sha256, version: git.version }),
      gitRemoteHttps: Object.freeze({
        sha256: gitRemoteHttps.sha256,
        version: gitRemoteHttps.version,
      }),
      hdiutil: Object.freeze({ sha256: hdiutil.sha256, version: hdiutil.version }),
      guardSha256,
      knowledgeVersion: packed.knowledgeVersion,
      node: Object.freeze({ sha256: node.sha256, version: node.version }),
      sandboxExec: Object.freeze({ sha256: sandboxExec.sha256, version: sandboxExec.version }),
      packageSha256: packed.packageSha256,
      ruleRegistrySha256: packed.ruleRegistrySha256,
      runtimeClosureSha256: sha256Canonical({
        format: "k03-complete-runtime-closure-v1",
        guardSha256,
        gitRemoteHttpsSha256: gitRemoteHttps.sha256,
        nodeSha256: node.sha256,
        packageRuntimeClosureSha256: packed.runtimeClosureSha256,
        sandboxExecSha256: sandboxExec.sha256,
      }),
      version: packed.engineVersion,
    }),
    paths: Object.freeze({
      cliEntry: packed.cliEntry,
      gitExecutable: git.path,
      gitExecPath: gitRuntime.execPath,
      gitRequiredChildren: gitRuntime.children,
      gitRemoteHttpsLinkTarget:
        gitRemoteHttps.path === gitRemoteHttps.target ? null : await readlink(gitRemoteHttps.path),
      gitRemoteHttpsPath: gitRemoteHttps.path,
      gitRemoteHttpsTarget: gitRemoteHttps.target,
      gitRemoteHttpsTargetSha256: gitRemoteHttps.targetSha256,
      hdiutilExecutable: hdiutil.path,
      nodeExecutable: node.path,
      packageRoot: packed.packageRoot,
      readablePackageRoots: Object.freeze([packed.cliPackageRoot, packed.corePackageRoot]),
      sandboxExecutable: sandboxExec.path,
    }),
  });
}

export async function verifyCaptureRuntime(expected, options) {
  const observed = await inspectCaptureRuntime(options);
  if (expected.engine.commitSha !== undefined) {
    const commitSha = await deriveEngineCommit({
      command: options.command,
      environment: minimalEnvironment(os.tmpdir()),
      gitExecutable: observed.paths.gitExecutable,
    });
    if (commitSha !== expected.engine.commitSha)
      throw new Error("capture source commit changed during runtime verification");
  }
  const expectedEngine = { ...expected.engine };
  delete expectedEngine.captureStartedAt;
  delete expectedEngine.commitSha;
  if (canonicalJson(observed.engine) !== canonicalJson(expectedEngine))
    throw new Error("capture runtime identity changed during calibration");
  return observed;
}

export async function inspectPackedEngine(packageRoot, cliEntry) {
  const lexicalRoot = path.resolve(packageRoot);
  const root = await ensureDedicatedTemporaryRoot(packageRoot, "package root");
  await rejectSymlinkComponents(lexicalRoot, path.resolve(cliEntry), "CLI entry");
  const entry = await ensureRegularFile(cliEntry, "CLI entry");
  const entryReal = await realpath(entry);
  if (!isWithin(root, entryReal))
    throw new Error("CLI entry must be inside the extracted package root");
  let directory = path.dirname(entryReal);
  let manifest;
  let cliPackageRoot;
  while (isWithin(root, directory)) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const candidate = await readJsonRegularFile(manifestPath, "packed CLI manifest");
      if (candidate?.name === "@agent-context/lint") {
        manifest = candidate;
        cliPackageRoot = directory;
        break;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !String(error?.message).includes("ENOENT")) throw error;
    }
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  if (
    manifest === undefined ||
    cliPackageRoot === undefined ||
    typeof manifest.version !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(
      manifest.version,
    )
  )
    throw new Error("extracted package root does not contain the packed CLI identity");
  exactManifestKeys(
    manifest,
    new Set([
      "bin",
      "dependencies",
      "description",
      "engines",
      "exports",
      "man",
      "name",
      "publishConfig",
      "sideEffects",
      "type",
      "types",
      "version",
    ]),
    "packed CLI manifest",
  );
  const bin = manifest.bin;
  if (
    bin === null ||
    typeof bin !== "object" ||
    Array.isArray(bin) ||
    Object.keys(bin).length !== 1 ||
    bin["agent-context-lint"] !== "./dist/cli.js"
  )
    throw new Error("packed CLI manifest has an invalid executable contract");
  const manifestEntry = await realpath(path.resolve(cliPackageRoot, bin["agent-context-lint"]));
  if (manifestEntry !== entryReal)
    throw new Error("CLI entry does not equal the packed manifest executable");
  const dependencies = manifest.dependencies;
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies) ||
    Object.keys(dependencies).length !== 1 ||
    dependencies["@agent-context/core"] !== manifest.version
  )
    throw new Error("packed CLI manifest has an invalid closed runtime dependency set");
  const expectedExports = {
    ".": {
      default: "./dist/index.js",
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
    "./reference/agent-context-lint-reference.v1.json":
      "./reference/agent-context-lint-reference.v1.json",
    "./schemas/agent-context-lint-reference.v1.schema.json":
      "./schemas/agent-context-lint-reference.v1.schema.json",
  };
  if (canonicalJson(manifest.exports) !== canonicalJson(expectedExports))
    throw new Error("packed CLI manifest has an invalid closed export map");
  await verifyExportTargets(cliPackageRoot, manifest.exports, "packed CLI manifest");
  const corePackageRoot = path.join(path.dirname(cliPackageRoot), "core");
  await rejectSymlinkComponents(root, corePackageRoot, "packed core package");
  const coreManifest = await readJsonRegularFile(
    path.join(corePackageRoot, "package.json"),
    "packed core manifest",
  );
  exactManifestKeys(
    coreManifest,
    new Set([
      "description",
      "engines",
      "exports",
      "files",
      "name",
      "publishConfig",
      "sideEffects",
      "type",
      "types",
      "version",
    ]),
    "packed core manifest",
  );
  const expectedCoreExports = {
    ".": {
      default: "./dist/index.js",
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    },
    "./policies/compatibility-policy.v1.json": "./policies/compatibility-policy.v1.json",
    "./schemas/agent-context-lint-config.v1.schema.json":
      "./schemas/agent-context-lint-config.v1.schema.json",
    "./schemas/diagnostic-baseline.v1.schema.json": "./schemas/diagnostic-baseline.v1.schema.json",
    "./schemas/diagnostic-contract.v0.schema.json": "./schemas/diagnostic-contract.v0.schema.json",
    "./schemas/organization-policy-pack.v0.schema.json":
      "./schemas/organization-policy-pack.v0.schema.json",
    "./schemas/output-contract.v1.schema.json": "./schemas/output-contract.v1.schema.json",
    "./schemas/sarif-output.v2.1.0-product-v2.schema.json":
      "./schemas/sarif-output.v2.1.0-product-v2.schema.json",
    "./schemas/sarif-output.v2.1.0.schema.json": "./schemas/sarif-output.v2.1.0.schema.json",
  };
  if (
    coreManifest?.name !== "@agent-context/core" ||
    coreManifest.version !== manifest.version ||
    coreManifest.dependencies !== undefined ||
    canonicalJson(coreManifest.exports) !== canonicalJson(expectedCoreExports)
  )
    throw new Error("packed core manifest has an invalid closed runtime contract");
  await verifyExportTargets(corePackageRoot, coreManifest.exports, "packed core manifest");
  const packageFiles = [];
  for (const [name, packageDirectory] of [
    ["@agent-context/core", corePackageRoot],
    ["@agent-context/lint", cliPackageRoot],
  ])
    packageFiles.push({ files: await packageInventory(packageDirectory), name });
  const reference = await readJsonRegularFile(
    path.join(cliPackageRoot, "reference/agent-context-lint-reference.v1.json"),
    "packed CLI reference",
  );
  const registryEntries = reference?.rules?.entries;
  if (
    !Array.isArray(registryEntries) ||
    registryEntries.length !== 69 ||
    registryEntries.some(
      (rule) =>
        !/^ACL[1-5][0-9]{2}$/.test(rule?.id) ||
        !new Set(["error", "warning", "info"]).has(rule?.defaultSeverity),
    ) ||
    new Set(registryEntries.map((rule) => rule.id)).size !== 69
  )
    throw new Error("packed CLI reference has an invalid default-severity registry");
  const defaultSeverityByRule = new Map(
    registryEntries.map((rule) => [rule.id, rule.defaultSeverity]),
  );
  const ruleRegistrySha256 = sha256Canonical({
    contractVersion: reference.rules.contractVersion,
    entries: registryEntries,
  });
  const stable = await readJsonRegularFile(
    path.join(cliPackageRoot, "bundled/metadata/standards-stable.json"),
    "packed stable standards metadata",
  );
  const targets = stable?.signed?.targets;
  if (targets === null || typeof targets !== "object" || Array.isArray(targets))
    throw new Error("packed standards metadata has no stable target");
  const targetEntries = Object.entries(targets);
  if (targetEntries.length !== 1)
    throw new Error("packed standards metadata must select one target");
  const [targetName, target] = targetEntries[0];
  const knowledgeVersion = target?.custom?.packVersion;
  const packSha256 = target?.hashes?.sha256;
  const packLength = target?.length;
  if (
    typeof knowledgeVersion !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(knowledgeVersion) ||
    typeof packSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(packSha256) ||
    !Number.isSafeInteger(packLength) ||
    packLength < 1 ||
    targetName !== "knowledge/stable/agent-context-bundled.json"
  )
    throw new Error("packed standards target identity is invalid");
  const packPath = path.join(cliPackageRoot, `bundled/packs/sha256-${packSha256}.json`);
  const packBytes = await readFile(await ensureRegularFile(packPath, "packed knowledge artifact"));
  if (
    packBytes.length !== packLength ||
    createHash("sha256").update(packBytes).digest("hex") !== packSha256
  )
    throw new Error("packed knowledge artifact differs from its signed metadata identity");
  const packageSha256 = sha256Canonical({
    format: "k03-extracted-package-inventory-v1",
    packages: packageFiles,
  });
  return Object.freeze({
    cliPackageRoot,
    cliEntry: entryReal,
    corePackageRoot,
    defaultSeverityByRule,
    engineVersion: manifest.version,
    knowledgeVersion,
    packageRoot: root,
    packageSha256,
    ruleRegistrySha256,
    runtimeClosureSha256: sha256Canonical({
      cliEntry: path.relative(cliPackageRoot, entryReal),
      format: "k03-readable-runtime-closure-v1",
      packageSha256,
      readablePackages: ["@agent-context/core", "@agent-context/lint"],
    }),
  });
}

export async function checkoutPinnedRepository(
  repository,
  destination,
  {
    command = runBoundedCommand,
    environment,
    gitExecutable,
    gitExecPath,
    gitRequiredChildren,
    gitRemoteHttpsLinkTarget,
    gitRemoteHttpsPath,
    gitRemoteHttpsTarget,
    gitRemoteHttpsTargetSha256,
    gitSha256,
    quotaProvider,
    quotaState,
    sandboxExecutable,
    sandboxSha256,
  },
) {
  if (
    quotaProvider === undefined ||
    quotaState === undefined ||
    quotaState.mount?.path !== destination ||
    quotaState.logicalBudgetBytes !== checkoutLogicalBudget(repository) ||
    quotaState.readOnly !== false
  )
    throw new Error("pinned checkout requires an issued writable quota volume");
  const git = await ensureRegularFile(gitExecutable, "Git executable");
  const requiredGitChildPaths =
    typeof gitExecPath === "string"
      ? ["git-index-pack", "git-unpack-objects"].map((name) => path.join(gitExecPath, name))
      : [];
  if (
    sandboxExecutable !== "/usr/bin/sandbox-exec" ||
    !/^[0-9a-f]{64}$/.test(sandboxSha256) ||
    typeof gitExecPath !== "string" ||
    !path.isAbsolute(gitExecPath) ||
    !Array.isArray(gitRequiredChildren) ||
    gitRequiredChildren.length !== 2 ||
    canonicalJson(gitRequiredChildren.map((child) => child.path).sort(compareUtf8)) !==
      canonicalJson(requiredGitChildPaths.sort(compareUtf8)) ||
    gitRequiredChildren.some((child) => child.target !== git) ||
    gitRemoteHttpsPath !== path.join(gitExecPath, "git-remote-https") ||
    !isWithin(gitExecPath, gitRemoteHttpsTarget)
  )
    throw new Error("pinned checkout requires the exact bound Git HTTPS runtime");
  const expectedGitRuntime = Object.freeze({
    execPath: gitExecPath,
    gitPath: git,
    gitSha256,
    helperLinkTarget: gitRemoteHttpsLinkTarget,
    helperPath: gitRemoteHttpsPath,
    helperTarget: gitRemoteHttpsTarget,
    helperTargetSha256: gitRemoteHttpsTargetSha256,
    children: gitRequiredChildren,
  });
  const checkoutEnvironment = Object.assign(Object.create(null), environment, {
    GIT_ASKPASS: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EXEC_PATH: gitExecPath,
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "/dev/null",
  });
  const policy = [
    "(version 1)",
    "(allow default)",
    "(deny process-exec*)",
    `(allow process-exec (literal "${sandboxLiteral(git)}"))`,
    `(allow process-exec (literal "${sandboxLiteral(gitRemoteHttpsPath)}"))`,
    ...gitRequiredChildren.map(
      (child) => `(allow process-exec (literal "${sandboxLiteral(child.path)}"))`,
    ),
    ...(gitRemoteHttpsTarget === gitRemoteHttpsPath
      ? []
      : [`(allow process-exec (literal "${sandboxLiteral(gitRemoteHttpsTarget)}"))`]),
  ].join(" ");
  const checkoutBudget = Object.freeze({
    maximumBytes: checkoutLogicalBudget(repository),
    maximumFiles: MAXIMUM_CHECKOUT_FILES,
    rejectAtLimit: true,
    tolerateRaces: true,
    root: destination,
  });
  const gitArguments = (...values) => [
    "-c",
    "credential.helper=",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "submodule.recurse=false",
    "-c",
    "protocol.file.allow=never",
    ...values,
  ];
  const runGit = async (arguments_, options) => {
    await verifyGitRuntimeIdentity(expectedGitRuntime);
    if ((await exactFileSha256(sandboxExecutable, "sandbox-exec executable")) !== sandboxSha256)
      throw new Error("sandbox-exec identity changed during checkout");
    let result;
    let failure = null;
    try {
      result = await command(sandboxExecutable, ["-p", policy, git, ...arguments_], {
        ...options,
        environment: checkoutEnvironment,
      });
    } catch (error) {
      failure = error;
    }
    let identityFailure = null;
    try {
      await verifyGitRuntimeIdentity(expectedGitRuntime);
      if ((await exactFileSha256(sandboxExecutable, "sandbox-exec executable")) !== sandboxSha256)
        throw new Error("sandbox-exec identity changed during checkout");
    } catch (error) {
      identityFailure = error;
    }
    if (failure !== null && identityFailure !== null)
      throw new AggregateError(
        [failure, identityFailure],
        "Git operation failed and its exact HTTPS runtime identity changed",
        { cause: failure },
      );
    if (failure !== null) throw failure;
    if (identityFailure !== null) throw identityFailure;
    return result;
  };
  for (const arguments_ of [
    gitArguments("init", "--quiet", destination),
    gitArguments("-C", destination, "remote", "add", "origin", repositoryUrl(repository.fullName)),
    gitArguments(
      "-C",
      destination,
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      "--filter=blob:none",
      "origin",
      repository.pinnedCommitSha,
    ),
    gitArguments(
      "-C",
      destination,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "--quiet",
      "--no-recurse-submodules",
      "--detach",
      "--force",
      repository.pinnedCommitSha,
    ),
  ]) {
    const result = await runGit(arguments_, {
      cwd: destination,
      maximumStderrBytes: MAXIMUM_STDERR_BYTES,
      maximumStdoutBytes: MAXIMUM_STDERR_BYTES,
      monitorTree: checkoutBudget,
      timeoutMs: CHECKOUT_TIMEOUT_MS,
    });
    await boundedTreeInventory(destination, {
      maximumBytes: checkoutBudget.maximumBytes,
      maximumFiles: checkoutBudget.maximumFiles,
      rejectAtLimit: false,
    });
    if (result.status !== 0 || result.signal !== null)
      throw new Error(`pinned read-only checkout failed for repository ${repository.repositoryId}`);
  }
  const head = await runGit(["-C", destination, "rev-parse", "--verify", "HEAD"], {
    cwd: destination,
    maximumStderrBytes: 4096,
    maximumStdoutBytes: 4096,
    timeoutMs: 30_000,
  });
  if (
    head.status !== 0 ||
    head.signal !== null ||
    head.stdout.trim() !== repository.pinnedCommitSha
  )
    throw new Error(
      `checkout HEAD differs from the K02 pin for repository ${repository.repositoryId}`,
    );
  const tree = await runGit(["-C", destination, "rev-parse", "--verify", "HEAD^{tree}"], {
    cwd: destination,
    maximumStderrBytes: 4096,
    maximumStdoutBytes: 4096,
    timeoutMs: 30_000,
  });
  if (tree.status !== 0 || tree.signal !== null || tree.stdout.trim() !== repository.pinnedTreeSha)
    throw new Error(
      `checkout tree differs from the K02 pin for repository ${repository.repositoryId}`,
    );
  const removeOrigin = await runGit(
    [...gitArguments("-C", destination, "remote", "remove", "origin")],
    {
      cwd: destination,
      maximumStderrBytes: 4096,
      maximumStdoutBytes: 4096,
      timeoutMs: 30_000,
    },
  );
  if (removeOrigin.status !== 0 || removeOrigin.signal !== null)
    throw new Error(`checkout retained push authority for repository ${repository.repositoryId}`);
  await freezeCheckout(destination);
  const readOnlyQuotaState = await quotaProvider.freeze(quotaState);
  const inventory = await checkoutInventory(destination, {
    maximumBytes: checkoutBudget.maximumBytes,
    maximumFiles: checkoutBudget.maximumFiles,
  });
  return Object.freeze({
    budget: Object.freeze({
      maximumBytes: checkoutBudget.maximumBytes,
      maximumFiles: checkoutBudget.maximumFiles,
    }),
    inventorySha256: inventory.sha256,
    quota: quotaProvider.evidence(readOnlyQuotaState),
    quotaState: readOnlyQuotaState,
    root: destination,
  });
}

function sandboxLiteral(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function validateSandboxPolicyText(policy) {
  for (const required of [
    "(deny network*)",
    "(deny file-write*)",
    "(deny file-read*)",
    "(deny process-exec*)",
  ])
    if (!policy.includes(required)) throw new Error(`sandbox policy is missing ${required}`);
  return policy;
}

function sandboxPolicy({ checkoutRoot, nodeExecutable, readablePackageRoots }) {
  const readable = [
    "/System/Library",
    "/usr/lib",
    "/dev/null",
    checkoutRoot,
    GUARD_PATH,
    nodeExecutable,
    ...readablePackageRoots,
  ];
  return validateSandboxPolicyText(
    [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      "(deny file-write*)",
      "(deny file-read*)",
      ...readable.map((entry) =>
        entry === "/dev/null" || entry === GUARD_PATH || entry === nodeExecutable
          ? `(allow file-read* (literal "${sandboxLiteral(entry)}"))`
          : `(allow file-read* (subpath "${sandboxLiteral(entry)}"))`,
      ),
      "(deny process-exec*)",
      `(allow process-exec (literal "${sandboxLiteral(nodeExecutable)}"))`,
    ].join(" "),
  );
}

export async function invokePackedCalibrationScan(
  checkoutRoot,
  { command = runBoundedCommand, environment, nodeExecutable, readablePackageRoots, cliEntry },
) {
  if (process.platform !== "darwin")
    throw new Error("K03 live capture fails closed without the reviewed Darwin sandbox profile");
  const arguments_ = [
    "-p",
    sandboxPolicy({ checkoutRoot, nodeExecutable, readablePackageRoots }),
    nodeExecutable,
    "--permission",
    `--allow-fs-read=${checkoutRoot}${path.sep}`,
    ...readablePackageRoots.map((root) => `--allow-fs-read=${root}${path.sep}`),
    `--allow-fs-read=${GUARD_PATH}`,
    `--import=${pathToFileURL(GUARD_PATH).href}`,
    cliEntry,
    "scan",
    checkoutRoot,
    "--format",
    "json",
    "--fail-on",
    "never",
  ];
  const result = await command("/usr/bin/sandbox-exec", arguments_, {
    cwd: checkoutRoot,
    environment,
    maximumStdoutBytes: MAXIMUM_CALIBRATION_ARTIFACT_BYTES,
    timeoutMs: SCAN_TIMEOUT_MS,
  });
  if (result.status !== 0 || result.signal !== null || result.stderr !== "")
    throw new Error("guarded packed calibration scan failed");
  let output;
  try {
    output = JSON.parse(result.stdout);
    const duplicateCheck = parseDocument(result.stdout, {
      maxAliasCount: 0,
      uniqueKeys: true,
    });
    if (duplicateCheck.errors.length > 0)
      throw new Error("guarded packed calibration scan emitted duplicate JSON keys");
  } catch {
    throw new Error("guarded packed calibration scan did not emit unique-key JSON");
  }
  return output;
}

export async function verifyOsReadConfinement({
  command = runBoundedCommand,
  environment,
  nodeExecutable,
  readablePackageRoots,
  workRoot,
}) {
  if (process.platform !== "darwin")
    throw new Error("K03 live capture fails closed without the reviewed Darwin read sandbox");
  const probeRoot = path.join(workRoot, "read-confinement-probe");
  await mkdir(probeRoot, { mode: 0o700 });
  const escape = path.join(probeRoot, "outside");
  await symlink("/etc/hosts", escape);
  const code =
    "try{require('node:fs').readFileSync(process.argv[1]);process.exit(42)}catch{process.exit(0)}";
  const result = await command(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      sandboxPolicy({ checkoutRoot: probeRoot, nodeExecutable, readablePackageRoots }),
      nodeExecutable,
      "--permission",
      `--allow-fs-read=${probeRoot}${path.sep}`,
      ...readablePackageRoots.map((root) => `--allow-fs-read=${root}${path.sep}`),
      "-e",
      code,
      escape,
    ],
    { cwd: probeRoot, environment, timeoutMs: 30_000 },
  );
  if (result.status !== 0 || result.signal !== null)
    throw new Error("OS read confinement did not deny a Node permission symlink escape");
}

export async function cleanupIssuedQuotaVolumes(
  quotaProvider,
  issuedQuotaStates,
  cause,
  message = "K03 capture failed and one or more quota volumes were retained for quarantine",
) {
  const cleanupErrors = [];
  for (const state of [...issuedQuotaStates].reverse()) {
    try {
      await quotaProvider.cleanup(state);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError([cause, ...cleanupErrors], message, { cause: cleanupErrors.at(0) });
}

export async function cleanupCapturedCalibration(
  quotaProvider,
  privateReviewBundle,
  workRootValue,
  { verifyCheckout = verifyFrozenCheckout } = {},
) {
  if (
    privateReviewBundle?.recordKind !==
      "agent-context-private-metadata-calibration-review-bundle" ||
    privateReviewBundle.mustNotCommit !== true ||
    !Array.isArray(privateReviewBundle.repositories) ||
    privateReviewBundle.repositories.length === 0
  )
    throw new Error("post-gate cleanup requires the exact private review bundle");
  const workRoot = await ensureDedicatedTemporaryRoot(workRootValue, "work root");
  const states = [];
  for (const repository of privateReviewBundle.repositories) {
    if (!/^[1-9][0-9]{0,19}$/.test(repository?.repositoryId))
      throw new Error("post-gate cleanup found an invalid repository identity");
    const quota = repository.checkout?.quota;
    const expectedMount = path.join(workRoot, `repository-${repository.repositoryId}`);
    const expectedImage = path.join(workRoot, `quota-${repository.repositoryId}.sparseimage`);
    if (
      quota === null ||
      typeof quota !== "object" ||
      repository.checkout.root !== expectedMount ||
      quota.mount?.path !== expectedMount ||
      quota.imagePath !== expectedImage
    )
      throw new Error("post-gate cleanup target differs from its exact captured quota identity");
    const state = Object.freeze({ ...quota, workRoot });
    await verifyCheckout(repository.checkout, {
      verifyQuota: quotaProvider.verify ?? verifyQuotaVolume,
    });
    states.push(state);
  }
  await cleanupIssuedQuotaVolumes(
    quotaProvider,
    states,
    new Error("explicit post-gate cleanup failed"),
    "K03 post-gate cleanup failed and one or more quota volumes were retained for quarantine",
  );
  return Object.freeze({ cleanedRepositories: states.length, workRoot });
}

export async function publishCapturedCalibration({
  captured,
  cleanup = cleanupCapturedCalibration,
  guard,
  quotaProvider,
  workRoot,
}) {
  try {
    await guard.publish(captured.privateReviewBundle);
  } catch (publicationError) {
    try {
      await cleanup(quotaProvider, captured.privateReviewBundle, workRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [publicationError, cleanupError],
        "private review publication failed and one or more issued volumes were retained for quarantine",
        { cause: cleanupError },
      );
    }
    throw publicationError;
  }
}

export async function executeCalibration({
  candidateBytes,
  captureLimits,
  captureRuntime,
  checkout = checkoutPinnedRepository,
  command = runBoundedCommand,
  corpus,
  corpusBytes,
  generatedAt,
  quotaProvider = null,
  scan = invokePackedCalibrationScan,
  verifyCheckout = verifyFrozenCheckout,
  verifyRuntime = verifyCaptureRuntime,
  workRoot,
}) {
  const frozen = validateFrozenCalibrationFrameBytes(candidateBytes, corpusBytes);
  if (!frozen.valid) throw new Error(frozen.errors.join("\n"));
  const candidates = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(candidateBytes));
  const frozenCorpus = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(corpusBytes));
  if (canonicalJson(corpus) !== canonicalJson(frozenCorpus))
    throw new Error("capture corpus differs from the immutable K02 corpus bytes");
  const candidateCheck = validateCandidateSnapshot(candidates);
  const corpusCheck = validateCalibrationCorpus(corpus, candidates);
  if (!candidateCheck.valid || !corpusCheck.valid)
    throw new Error([...candidateCheck.errors, ...corpusCheck.errors].join("\n"));
  const byId = new Map(candidates.candidates.map((entry) => [entry.repositoryId, entry]));
  const environment = minimalEnvironment(path.join(workRoot, "empty-home"));
  await mkdir(environment.HOME, { mode: 0o700 });
  const capture = createCalibrationCaptureAccumulator({
    corpus,
    defaultSeverityByRule: captureRuntime.defaultSeverityByRule,
    engine: captureRuntime.engine,
    generatedAt,
    limits: captureLimits,
  });
  const issuedQuotaStates = [];
  try {
    for (const selected of [...corpus.repositories].sort((left, right) =>
      compareUtf8(left.repositoryId, right.repositoryId),
    )) {
      const metadata = byId.get(selected.repositoryId);
      if (metadata === undefined) throw new Error("selected repository metadata is unavailable");
      const destination = path.join(workRoot, `repository-${selected.repositoryId}`);
      let quotaState = null;
      if (quotaProvider !== null) {
        quotaState = await quotaProvider.provision({
          logicalBudgetBytes: checkoutLogicalBudget(metadata),
          repositoryId: selected.repositoryId,
          workRoot,
        });
        issuedQuotaStates.push(quotaState);
      }
      const checkoutState = await checkout(metadata, destination, {
        command,
        environment,
        gitExecPath: captureRuntime.paths.gitExecPath,
        gitExecutable: captureRuntime.paths.gitExecutable,
        gitRemoteHttpsLinkTarget: captureRuntime.paths.gitRemoteHttpsLinkTarget,
        gitRemoteHttpsPath: captureRuntime.paths.gitRemoteHttpsPath,
        gitRemoteHttpsTarget: captureRuntime.paths.gitRemoteHttpsTarget,
        gitRemoteHttpsTargetSha256: captureRuntime.paths.gitRemoteHttpsTargetSha256,
        gitRequiredChildren: captureRuntime.paths.gitRequiredChildren,
        gitSha256: captureRuntime.engine.git.sha256,
        hdiutilExecutable: captureRuntime.paths.hdiutilExecutable,
        quotaProvider,
        quotaState,
        sandboxExecutable: captureRuntime.paths.sandboxExecutable,
        sandboxSha256: captureRuntime.engine.sandboxExec.sha256,
      });
      if (checkoutState.quotaState !== undefined && quotaState !== null) {
        issuedQuotaStates[issuedQuotaStates.indexOf(quotaState)] = checkoutState.quotaState;
      }
      const checkoutRoot = checkoutState.root;
      await verifyRuntime(captureRuntime, {
        cliEntry: captureRuntime.paths.cliEntry,
        command,
        gitExecutable: captureRuntime.paths.gitExecutable,
        hdiutilExecutable: captureRuntime.paths.hdiutilExecutable,
        nodeExecutable: captureRuntime.paths.nodeExecutable,
        packageRoot: captureRuntime.paths.packageRoot,
      });
      const output = await scan(checkoutRoot, {
        cliEntry: captureRuntime.paths.cliEntry,
        command,
        environment,
        nodeExecutable: captureRuntime.paths.nodeExecutable,
        readablePackageRoots: captureRuntime.paths.readablePackageRoots,
      });
      capture.add(selected.repositoryId, output, checkoutState);
      await verifyCheckout(checkoutState);
      await verifyRuntime(captureRuntime, {
        cliEntry: captureRuntime.paths.cliEntry,
        command,
        gitExecutable: captureRuntime.paths.gitExecutable,
        hdiutilExecutable: captureRuntime.paths.hdiutilExecutable,
        nodeExecutable: captureRuntime.paths.nodeExecutable,
        packageRoot: captureRuntime.paths.packageRoot,
      });
    }
    // Successful live captures intentionally retain their frozen quota volumes. Both
    // the maintainer review and final release gate re-verify those exact checkouts;
    // cleanup is a separate, explicit post-gate operation.
    return capture.finish(generatedAt ?? new Date().toISOString());
  } catch (error) {
    if (quotaProvider !== null)
      await cleanupIssuedQuotaVolumes(quotaProvider, issuedQuotaStates, error);
    throw error;
  }
}

export async function deriveEngineCommit({
  command = runBoundedCommand,
  environment,
  gitExecutable,
}) {
  const result = await command(
    gitExecutable,
    ["-C", REPOSITORY_ROOT, "rev-parse", "--verify", "HEAD"],
    {
      cwd: REPOSITORY_ROOT,
      environment,
      maximumStderrBytes: 4096,
      maximumStdoutBytes: 4096,
      timeoutMs: 30_000,
    },
  );
  const commitSha = result.stdout.trim();
  if (
    result.status !== 0 ||
    result.signal !== null ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)
  )
    throw new Error("unable to derive exact linter source commit identity");
  return commitSha;
}

function usage() {
  return "Usage: node tools/metadata-calibration/execute.mjs --cli-entry <absolute> --package-root <absolute> --node <absolute> --git <absolute> --hdiutil /usr/bin/hdiutil --work-root <absolute> --private-output <absolute> --acknowledge-ignore-scripts-extraction --acknowledge-read-only-external-capture";
}

function parseArguments(arguments_) {
  const values = Object.create(null);
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index];
    if (key === "--acknowledge-read-only-external-capture") {
      if (values.acknowledged) throw new Error(usage());
      values.acknowledged = true;
      continue;
    }
    if (key === "--acknowledge-ignore-scripts-extraction") {
      if (values.ignoreScriptsAcknowledged) throw new Error(usage());
      values.ignoreScriptsAcknowledged = true;
      continue;
    }
    const names = new Map([
      ["--cli-entry", "cliEntry"],
      ["--git", "gitExecutable"],
      ["--hdiutil", "hdiutilExecutable"],
      ["--node", "nodeExecutable"],
      ["--package-root", "packageRoot"],
      ["--private-output", "privateOutput"],
      ["--work-root", "workRoot"],
    ]);
    const name = names.get(key);
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || values[name] !== undefined)
      throw new Error(usage());
    values[name] = value;
    index += 1;
  }
  if (
    !values.acknowledged ||
    !values.ignoreScriptsAcknowledged ||
    [
      "cliEntry",
      "gitExecutable",
      "hdiutilExecutable",
      "nodeExecutable",
      "packageRoot",
      "privateOutput",
      "workRoot",
    ].some((name) => values[name] === undefined)
  )
    throw new Error(usage());
  return values;
}

async function main(arguments_) {
  const values = parseArguments(arguments_);
  const { privateOutput, workRoot } = await validateCapturePaths(
    values.workRoot,
    values.privateOutput,
  );
  const publicationGuard = await createPrivateReviewPublicationGuard(workRoot, privateOutput);
  let failure = null;
  let publishedReport = null;
  try {
    const inspectedRuntime = await inspectCaptureRuntime({
      cliEntry: values.cliEntry,
      gitExecutable: values.gitExecutable,
      hdiutilExecutable: values.hdiutilExecutable,
      nodeExecutable: values.nodeExecutable,
      packageRoot: values.packageRoot,
    });
    const candidateBytes = await readFile(
      path.join(REPOSITORY_ROOT, "calibration/metadata/v0/candidate-snapshot.json"),
    );
    const corpusBytes = await readFile(
      path.join(REPOSITORY_ROOT, "calibration/metadata/v0/corpus.json"),
    );
    const corpus = JSON.parse(corpusBytes.toString("utf8"));
    const environment = minimalEnvironment(path.join(workRoot, "empty-home"));
    const commitSha = await deriveEngineCommit({
      environment,
      gitExecutable: inspectedRuntime.paths.gitExecutable,
    });
    const captureRuntime = Object.freeze({
      ...inspectedRuntime,
      engine: Object.freeze({
        ...inspectedRuntime.engine,
        captureStartedAt: new Date().toISOString(),
        commitSha,
      }),
    });
    await verifyOsReadConfinement({
      environment,
      nodeExecutable: captureRuntime.paths.nodeExecutable,
      readablePackageRoots: captureRuntime.paths.readablePackageRoots,
      workRoot,
    });
    const quotaProvider = createDarwinQuotaVolumeProvider({
      command: runBoundedCommand,
      cp: await inspectSystemHelpIdentity("/bin/cp", "cp executable"),
      dd: await inspectSystemHelpIdentity("/bin/dd", "dd executable"),
      df: await inspectSystemHelpIdentity("/bin/df", "df executable"),
      environment,
      hdiutil: Object.freeze({
        path: inspectedRuntime.paths.hdiutilExecutable,
        ...inspectedRuntime.engine.hdiutil,
      }),
    });
    const captured = await executeCalibration({
      candidateBytes,
      captureRuntime,
      corpus,
      corpusBytes,
      quotaProvider,
      workRoot,
    });
    await publishCapturedCalibration({
      captured,
      guard: publicationGuard,
      quotaProvider,
      workRoot,
    });
    publishedReport = captured.report;
  } catch (error) {
    failure = error;
  }
  try {
    await publicationGuard.close();
  } catch (error) {
    failure =
      failure === null
        ? error
        : new AggregateError([failure, error], "capture failed and publication handles remained", {
            cause: failure,
          });
  }
  if (failure !== null) throw failure;
  process.stdout.write(prettyJson(publishedReport));
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "calibration capture failed"}\n`,
    );
    process.exitCode = 1;
  }
}
