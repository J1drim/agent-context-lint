import { constants as fsConstants } from "node:fs";
import { chmod, cp, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function componentPaths(absolute) {
  const parsed = path.parse(absolute);
  const result = [parsed.root];
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    result.push(current);
  }
  return result;
}

async function openSourceAuthority(root) {
  const paths = componentPaths(root);
  const temporaryAnchor = await realpath(os.tmpdir());
  const anchorIndex = paths.indexOf(temporaryAnchor);
  const timestampStart = anchorIndex >= 0 ? anchorIndex + 1 : 0;
  const authorities = [];
  try {
    for (const [index, directoryPath] of paths.entries()) {
      const visible = await lstat(directoryPath);
      const handle = await open(
        directoryPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_DIRECTORY ?? 0),
      );
      const held = await handle.stat();
      if (
        visible.isSymbolicLink() ||
        !visible.isDirectory() ||
        !held.isDirectory() ||
        held.dev !== visible.dev ||
        held.ino !== visible.ino ||
        (await realpath(directoryPath)) !== directoryPath
      )
        throw new Error("pnpm snapshot source authority changed while opening");
      authorities.push({
        before: held,
        handle,
        path: directoryPath,
        timestamps: index >= timestampStart,
      });
    }
    return authorities;
  } catch (error) {
    for (const authority of authorities.reverse()) await authority.handle.close();
    throw error;
  }
}

async function verifySourceAuthority(authorities) {
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
      (authority.timestamps &&
        (held.mtimeMs !== authority.before.mtimeMs || held.ctimeMs !== authority.before.ctimeMs))
    )
      throw new Error("pnpm snapshot source authority changed during acquisition");
  }
}

export async function createPnpmRuntimeSnapshotPair(packageRoot, { afterFirstCopy = null } = {}) {
  if (afterFirstCopy !== null && typeof afterFirstCopy !== "function")
    throw new Error("pnpm snapshot acquisition boundary is invalid");
  if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot))
    throw new Error("pnpm runtime package root must be exact and absolute");
  const root = await realpath(packageRoot);
  if (root !== packageRoot) throw new Error("pnpm runtime package root must be canonical");
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("pnpm runtime package root must be an ordinary directory");

  const container = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "svetovid-pnpm-snapshot-")),
  );
  const snapshots = [path.join(container, "runtime-a"), path.join(container, "runtime-b")];
  const sourceAuthorities = await openSourceAuthority(root);
  let failure = null;
  try {
    for (const [index, snapshot] of snapshots.entries()) {
      await verifySourceAuthority(sourceAuthorities);
      // Non-dereferencing copy preserves links as links. The confined inventory
      // rejects each copied link without opening its target.
      await cp(root, snapshot, {
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        recursive: true,
        verbatimSymlinks: true,
      });
      if ((await realpath(snapshot)) !== snapshot)
        throw new Error("pnpm runtime snapshot is not canonical");
      await verifySourceAuthority(sourceAuthorities);
      if (index === 0 && afterFirstCopy !== null) await afterFirstCopy();
    }
    await chmod(container, 0o500);
  } catch (error) {
    failure = error;
  }
  const closeErrors = [];
  for (const authority of sourceAuthorities.reverse()) {
    try {
      await authority.handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (closeErrors.length > 0)
    failure = new AggregateError(
      failure === null ? closeErrors : [failure, ...closeErrors],
      "pnpm snapshot source authorities did not close",
      { cause: failure ?? closeErrors[0] },
    );
  if (failure !== null) {
    const cleanupErrors = [];
    try {
      await chmod(container, 0o700);
      await rm(container, { force: true, recursive: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError([failure, ...cleanupErrors], "pnpm snapshot acquisition failed", {
        cause: failure,
      });
    throw failure;
  }
  return Object.freeze({
    originalRoot: root,
    paths: Object.freeze(snapshots),
    async remove() {
      await chmod(container, 0o700);
      await rm(container, { force: true, recursive: true });
    },
  });
}
