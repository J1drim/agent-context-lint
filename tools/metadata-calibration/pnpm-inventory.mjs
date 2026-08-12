#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAXIMUM_PNPM_RUNTIME_FILES = 5_000;
const MAXIMUM_PNPM_RUNTIME_BYTES = 64 * 1024 * 1024;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function assertDirectoryAuthorities(authorities) {
  for (const authority of authorities) {
    const [held, visible, resolved] = await Promise.all([
      authority.handle.stat(),
      lstat(authority.path),
      realpath(authority.path),
    ]);
    if (
      resolved !== authority.path ||
      visible.isSymbolicLink() ||
      !visible.isDirectory() ||
      visible.dev !== authority.before.dev ||
      visible.ino !== authority.before.ino ||
      held.dev !== authority.before.dev ||
      held.ino !== authority.before.ino ||
      held.mtimeMs !== authority.before.mtimeMs ||
      held.ctimeMs !== authority.before.ctimeMs
    )
      throw new Error("pnpm runtime directory authority changed during traversal");
  }
}

async function openDirectoryAuthority(absolute, lexical, ancestors) {
  await assertDirectoryAuthorities(ancestors);
  const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isDirectory() ||
      before.dev !== lexical.dev ||
      before.ino !== lexical.ino ||
      before.mtimeMs !== lexical.mtimeMs ||
      before.ctimeMs !== lexical.ctimeMs
    )
      throw new Error("pnpm runtime directory changed while acquiring authority");
    await assertDirectoryAuthorities(ancestors);
    return { before, handle, path: absolute };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function stableFileIdentity(absolute, relative, authorities, fileReadObserver) {
  await assertDirectoryAuthorities(authorities);
  const lexical = await lstat(absolute);
  if (!lexical.isFile() || lexical.isSymbolicLink())
    throw new Error(`pnpm runtime contains a non-regular file: ${relative}`);
  const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== lexical.dev ||
      before.ino !== lexical.ino ||
      before.size !== lexical.size
    )
      throw new Error(`pnpm runtime file changed during open: ${relative}`);
    if (before.size > MAXIMUM_PNPM_RUNTIME_BYTES)
      throw new Error("pnpm runtime package exceeds its closed inventory limits");
    await assertDirectoryAuthorities(authorities);
    const bytes = await handle.readFile();
    if (fileReadObserver !== null) fileReadObserver({ absolute, relative, size: bytes.length });
    const after = await handle.stat();
    await assertDirectoryAuthorities(authorities);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error(`pnpm runtime file changed during hashing: ${relative}`);
    return Object.freeze({
      mode: before.mode & 0o777,
      path: relative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: before.size,
    });
  } finally {
    await handle.close();
  }
}

async function inspectPnpmRuntimeSnapshot(
  packageRoot,
  reportedRoot,
  version,
  { afterRootEnqueue = null, fileReadObserver = null } = {},
) {
  if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot))
    throw new Error("pnpm runtime package root must be exact and absolute");
  const root = await realpath(packageRoot);
  if (root !== packageRoot) throw new Error("pnpm runtime package root must be canonical");
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error("pnpm runtime package root must be an ordinary directory");
  if (fileReadObserver !== null && typeof fileReadObserver !== "function")
    throw new Error("pnpm runtime file-read observer must be a function");
  const rootParent = path.dirname(root);
  const rootParentAuthority = await openDirectoryAuthority(rootParent, await lstat(rootParent), []);
  let rootAuthority;
  try {
    rootAuthority = await openDirectoryAuthority(root, rootMetadata, [rootParentAuthority]);
  } catch (error) {
    await rootParentAuthority.handle.close();
    throw error;
  }
  const pending = [{ authorities: [rootParentAuthority, rootAuthority], path: root }];
  const openedDirectories = [rootParentAuthority, rootAuthority];
  const entries = [];
  let totalBytes = 0;
  let rootEnqueueBoundaryObserved = false;
  let traversalFailure = null;
  try {
    while (pending.length > 0) {
      const directory = pending.pop();
      await assertDirectoryAuthorities(directory.authorities);
      const names = await readdir(directory.path);
      await assertDirectoryAuthorities(directory.authorities);
      names.sort(compareUtf8);
      for (const name of names) {
        await assertDirectoryAuthorities(directory.authorities);
        const absolute = path.join(directory.path, name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        const metadata = await lstat(absolute);
        await assertDirectoryAuthorities(directory.authorities);
        if (metadata.isSymbolicLink())
          throw new Error(`pnpm runtime contains a symbolic link: ${relative}`);
        if (metadata.isDirectory()) {
          const authority = await openDirectoryAuthority(absolute, metadata, directory.authorities);
          openedDirectories.push(authority);
          entries.push(Object.freeze({ mode: metadata.mode & 0o777, path: `${relative}/` }));
          pending.push({ authorities: [...directory.authorities, authority], path: absolute });
        } else if (metadata.isFile()) {
          const entry = await stableFileIdentity(
            absolute,
            relative,
            directory.authorities,
            fileReadObserver,
          );
          totalBytes += entry.size;
          entries.push(entry);
        } else throw new Error(`pnpm runtime contains a special file: ${relative}`);
        if (entries.length > MAXIMUM_PNPM_RUNTIME_FILES || totalBytes > MAXIMUM_PNPM_RUNTIME_BYTES)
          throw new Error("pnpm runtime package exceeds its closed inventory limits");
      }
      if (directory.path === root && afterRootEnqueue !== null) {
        if (typeof afterRootEnqueue !== "function" || rootEnqueueBoundaryObserved)
          throw new Error("pnpm runtime root-enqueue boundary is invalid");
        rootEnqueueBoundaryObserved = true;
        await afterRootEnqueue();
      }
    }
    await assertDirectoryAuthorities([rootParentAuthority, rootAuthority]);
  } catch (error) {
    traversalFailure = error;
  }
  const closeErrors = [];
  for (const authority of openedDirectories.reverse()) {
    try {
      await authority.handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (closeErrors.length > 0)
    throw new AggregateError(
      traversalFailure === null ? closeErrors : [traversalFailure, ...closeErrors],
      "pnpm runtime directory authorities did not close",
      { cause: closeErrors[0] },
    );
  if (traversalFailure !== null) throw traversalFailure;
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  return Object.freeze({
    path: reportedRoot,
    sha256: createHash("sha256")
      .update(JSON.stringify({ entries, format: "pnpm-runtime-package-v1", totalBytes }), "utf8")
      .digest("hex"),
    version,
  });
}

export async function inspectPnpmRuntimePackage(packageRoot, version, options = {}) {
  const { createPnpmRuntimeSnapshotPair } = await import("./pnpm-snapshot.mjs");
  const { afterFirstSnapshot = null, ...traversalOptions } = options;
  const snapshot = await createPnpmRuntimeSnapshotPair(packageRoot, {
    afterFirstCopy: afterFirstSnapshot,
  });
  let result;
  let failure = null;
  try {
    const first = await inspectPnpmRuntimeSnapshot(
      snapshot.paths[0],
      snapshot.originalRoot,
      version,
      traversalOptions,
    );
    const second = await inspectPnpmRuntimeSnapshot(
      snapshot.paths[1],
      snapshot.originalRoot,
      version,
    );
    if (first.sha256 !== second.sha256)
      throw new Error("pnpm runtime snapshot inventories do not form a content fixed point");
    result = first;
  } catch (error) {
    failure = error;
  }
  try {
    await snapshot.remove();
  } catch (error) {
    failure = new AggregateError(
      failure === null ? [error] : [failure, error],
      "pnpm runtime snapshot could not be removed",
      { cause: failure ?? error },
    );
  }
  if (failure !== null) throw failure;
  return result;
}

async function main(arguments_) {
  if (arguments_.length !== 4) throw new Error("pnpm inventory child arguments are invalid");
  const first = await inspectPnpmRuntimeSnapshot(arguments_[1], arguments_[0], arguments_[3], {
    afterRootEnqueue: async () => {
      process.stderr.write("K03_PNPM_INVENTORY_READY\n");
      const chunks = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        length += chunk.length;
        if (length > 3) throw new Error("pnpm inventory child handshake is oversized");
        chunks.push(chunk);
      }
      if (Buffer.concat(chunks).toString("utf8") !== "GO\n")
        throw new Error("pnpm inventory child handshake is invalid");
    },
  });
  const second = await inspectPnpmRuntimeSnapshot(arguments_[2], arguments_[0], arguments_[3]);
  if (first.sha256 !== second.sha256)
    throw new Error("pnpm runtime snapshot inventories do not form a content fixed point");
  process.stdout.write(`${JSON.stringify(first)}\n`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "pnpm inventory failed"}\n`);
    process.exitCode = 1;
  }
}
