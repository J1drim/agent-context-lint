# Developing the atomic writer

The I10 implementation is `packages/evidence/src/atomic-writer.ts`. It belongs beside the C01/C02
root-jail code because every mutation must start from the same canonical `RepositoryRootSelection`.
The package's usual evidence collectors remain read-only; only an explicit call to
`createAtomicRepositoryWriter()` grants a write-capable object.

## Design invariants

- Require the analyzed C02 device/inode identity and exact SHA-256 source digest.
- Accept only canonical repository-relative paths and bounded defensively copied bytes.
- Reject target or parent links, hard-linked files, special types, read-only modes, changed roots,
  changed parents, changed bytes, changed metadata, and cancellation before rename.
- Serialize cooperating writers with an exclusive same-directory per-target lock.
- Use exclusive same-directory temporary creation, retain restrictive permissions until all bytes
  are written, then apply the approved mode, file sync, identity rechecks, atomic rename,
  publication verification, and directory sync.
- Preserve ordinary `0777` permission bits only. Never copy setuid, setgid, sticky, ownership, ACL,
  xattr, or platform-specific metadata implicitly.
- Never remove a lock or temporary pathname after identity substitution. Close every owned handle
  even when safe pathname cleanup is impossible.
- Distinguish precommit failure from postcommit durability/cleanup failure using `committed`.
- Return the published device/inode identity so an immediately dependent exact CAS can bind to the
  replacement rather than rediscovering an ambiguous pathname.
- Do not expose absolute, lock, temporary, or hostile filesystem text in errors.

The lock is a serialization mechanism, not a stale-lock lease and not an authorization boundary.
Automatically breaking it based on PID, hostname, or age would introduce unsafe reuse and clock/PID
races. A crash can leave it behind; recovery is an explicit operator action after checking that no
writer is active.

## Fault injection

Production callers use `createAtomicRepositoryWriter()`. Tests use the trusted
`createAtomicRepositoryWriterWithFileSystem()` entry point and narrow hooks to inject:

- partial/zero-progress writes and file-sync failure;
- mutation before both commit validations;
- target growth, truncation, path replacement, parent replacement, and temp substitution;
- lock contention, poisoning, collision, and cleanup failure;
- rename and post-rename publication failure;
- supported, unsupported, and unexpected directory-sync behavior;
- precommit cancellation and hostile request/options/selection values.

The injected `platform` controls only mode and durability behavior. Path syntax follows the host so
a non-Windows CI runner can test Windows filesystem outcomes without constructing invalid native
paths.

Run the focused checks while developing:

```bash
pnpm exec vitest run packages/evidence/test/atomic-writer.unit.test.ts
pnpm exec vitest run packages/evidence/test/atomic-writer.unit.test.ts \
  --coverage --coverage.include=packages/evidence/src/atomic-writer.ts
pnpm typecheck
pnpm lint
```

Release integration must also run `pnpm check`. Native filesystem cases execute on every supported
CI OS; injected tests are not a substitute for Ubuntu, macOS, and Windows lanes.

## Review checklist

Any change to the sequence needs security review. Confirm that:

1. no filesystem action precedes closed input and root-selection validation;
2. every opened handle is closed on every outcome;
3. cleanup compares the owned inode before unlink;
4. the last target check remains immediately before rename;
5. no error path reports `committed: false` after rename;
6. directory-sync unsupported codes stay narrowly platform-scoped;
7. normal scan code still cannot obtain this capability implicitly;
8. crash, race, read-only, symlink, hard-link, mode, and platform tests remain enabled.

Implementation behavior is based on the official
[Node.js 24 filesystem API](https://nodejs.org/docs/latest-v24.x/api/fs.html), retrieved 2026-08-02.
