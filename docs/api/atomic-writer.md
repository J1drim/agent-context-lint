# Atomic repository writer API

`@agent-context/evidence` exports the I10 writer as an explicit mutation capability. Constructing a
read-only repository does not construct or expose this writer, so ordinary scan, list, explain, and
evidence paths remain read-only.

```ts
import {
  createAtomicRepositoryWriter,
  createReadOnlyRepository,
  selectRepositoryRoot,
} from "@agent-context/evidence";

const selection = await selectRepositoryRoot(repository, { mode: "explicit" });
const readable = await createReadOnlyRepository(selection);
const analyzed = await readable.readFile("AGENTS.md");
const writer = await createAtomicRepositoryWriter(selection);

await writer.write({
  expected: {
    identity: analyzed.identity,
    sha256: analyzedSha256,
  },
  path: analyzed.path,
  replacement: replacementBytes,
});
```

The caller must pass the C02 device/inode identity and B03/B04 SHA-256 digest captured during
analysis. A path or digest by itself is not an adequate write precondition. Requests are closed,
plain-data inputs; unknown fields, accessors, proxies, shared buffers, noncanonical paths, invalid
digests, and values above the configured hard bounds fail before filesystem mutation.

## Commit protocol

For one existing regular file, `write()` performs this protocol:

1. Revalidate the selected root, every parent, the target's real path, regular-file type, one-link
   identity, supported mode, byte limit, device/inode, complete content digest, and cancellation.
2. Acquire an exclusive per-target lock in the target directory. This serializes all cooperating
   writer instances and treats an existing or crash-stale lock as a conflict.
3. Create an exclusive random same-directory temporary file with mode `0600` and no-follow where the
   host exposes it. Copy the caller bytes defensively and handle partial writes while the file stays
   private, then apply only the source's `0777` permission bits, flush the file, and verify the open
   and pathname identities.
4. Re-run the root, parent, target, lock, temporary-file, digest, and cancellation checks
   immediately before commit. The replacement is a same-directory atomic rename.
5. Verify that the published inode is the prepared inode. Flush the containing directory when the
   host/filesystem supports directory `fsync`, remove the writer lock safely, and flush that
   directory change as well.

The writer never follows a target or parent symlink, writes through a hard link, modifies a
read-only target, silently truncates a large target, or unlinks a pathname whose identity no longer
belongs to the writer. Special mode bits are deliberately not propagated.

## Result and failure state

Successful results are frozen and include:

- `previousSha256` and the replacement `sha256`;
- `bytesWritten`, preserved `mode`, repository-relative `path`, and the published replacement's
  device/inode `identity` for a subsequent exact rollback or compare-and-swap;
- `directorySync: "synced" | "unsupported"`;
- `durability: "file-and-directory" | "file-only"`.

An `AtomicWriteError` has a stable `code`, sanitized `operation` and `causeCode`,
repository-relative `path`, and `committed` flag. `committed: false` means the rename did not occur.
A failure during directory durability or lock cleanup after rename has `committed: true`; callers
must not describe that outcome as rollback. Absolute temporary and lock paths never enter public
errors.

`ATOMIC_WRITE_CLEANUP_FAILED` is intentionally fail-closed. For example, if an untrusted process
renames the parent directory during the operation, the writer closes its handles but refuses to
search for or delete relocated artifacts. An operator may remove a stale
`.agent-context-lint-*.lock` or `.tmp` only after confirming that no writer is active and that the
path belongs to the selected repository.

## Durability and portability

Node documents `FileHandle.sync()` as an operating-system- and device-specific request to flush file
data. Its promise filesystem operations are not automatically synchronized with other concurrent
modifications. The writer therefore supplies its own exclusive cooperative lock, exact
compare-and-swap revalidation, and same-directory rename. See the official
[Node.js 24 filesystem API](https://nodejs.org/docs/latest-v24.x/api/fs.html) (retrieved
2026-08-02).

On filesystems that reject directory handles or directory `fsync` with a documented unsupported
error, the write can still be atomically visible but is reported as `file-only`; it must not be
represented as crash-durable directory metadata. Unexpected directory flush failures are errors with
`committed: true`.

Portable Node does not expose a kernel conditional-rename primitive. The writer closes the practical
TOCTOU window by serializing cooperating writers and revalidating after the last injectable step
immediately before rename, then validating the published inode. A noncooperating process with write
access can still race at the operating-system scheduling boundary; callers needing a hostile shared
write domain must provide stronger OS/filesystem isolation rather than treating the lock file as an
authorization boundary.

The v0.1 API updates existing files only. I11's [safe fix pipeline](safe-fix-pipeline.md) plans
every B04 operation and applies one exact existing-file replacement through this writer. Creation,
moves, and recoverable multi-file transaction semantics remain fail-closed until a portable
no-clobber or durable journal protocol is implemented and proven.
