# C02 read-only repository design

C02 is the sole ordinary-scan filesystem authority after C01. Its implementation is
`packages/evidence/src/read-only-filesystem.ts`. Later tickets should compose its canonical
repository-relative results; they must not import Node filesystem read APIs, rediscover a root, or
interpret `RepositoryRootSelection.gitDirectory` as content-read authority.

## Operation sequence

Facade construction snapshots the C01 result and options without invoking accessors, starts the
deadline, counts and bounds `lstat`/`realpath`/`lstat` root validation, and compares the canonical
root's device/inode with C01. Each later operation then:

1. rejects concurrent use and checks cancellation/deadline;
2. validates the canonical repository-relative path and caller-lowered limits;
3. revalidates root identity;
4. resolves each path component with `lstat`, reading only stable in-root link targets;
5. checks terminal type, hard-link policy, and the relevant entry/size/aggregate budget;
6. performs a timer- and cancellation-bounded handle operation;
7. rechecks handle and path observations before publishing a deeply immutable result.

File reads allocate only the advertised bounded size plus one byte. The offset loop accepts
fragmented reads, requires EOF after exactly the advertised size, and compares handle metadata
before and after. The extra byte detects growth. Directory enumeration uses `opendir` and one
bounded `read()` per entry instead of `readdir`, so a single hostile directory cannot allocate an
unbounded names array before `maximumEntries` is enforced. Directory names are withheld unless the
directory observation remains stable after enumeration.

The facade deliberately rejects hard-linked regular files. Device/inode proves identity for ordinary
replacement races, while `nlink === 1` removes ambiguity about an attacker changing the same inode
through another path during analysis. This is stricter than many general-purpose file readers and is
part of the TB-01 policy.

Node has no portable cancellable `open`, `lstat`, `readlink`, directory-read, or file-read API. C02
therefore races each awaited promise with the absolute facade deadline and native abort signal, then
discards late results. Open is special: a late file or directory handle receives an attached close
continuation so deadline enforcement does not leak descriptors. Cleanup itself is bounded; an abort
observed during an otherwise successful close remains `ABORTED`, not `CLOSE_FAILED`. Production
duration accounting uses `performance.now()`. Capability-injected clocks are normalized to their
observed high-water mark across root validation and the full facade lifetime; wall-clock adjustments
or an injected rollback cannot extend the session budget.

## Adding a filesystem consumer

- Accept a `ReadOnlyRepository`, never an absolute root plus ambient filesystem functions.
- Keep identities in repository-relative POSIX form and preserve their original case.
- Lower limits only for a narrower operation; do not create a new higher ceiling.
- Treat every returned filename and byte as untrusted even though the result object is frozen.
- Use a new facade for an independent scan session. Do not run calls concurrently on one facade.
- Reproduce external-repository failures in project-owned synthetic fixtures; never prepare an
  upstream branch, commit, patch, issue, or message.

The capability-injected factory is restricted to tests and trusted internal composition. A new
capability method is a security-boundary change and requires threat-model, API, malformed-result,
timeout, cancellation, cleanup, and cross-platform review.

## Verification

The focused C02 suite covers positive, negative, boundary, malformed-input, suppression-equivalent
fail-closed, and race behavior: POSIX repository-relative grammar; C01 canonical handoff; internal,
external, malformed, looping, deep, and replaced links; special types and hard links; exact and
oversized files; aggregate entry/byte/metadata/depth/time limits; streamed overproducing
directories; short reads, EOF, growth, invalid fragments, file-handle races; root/directory/link
replacement; initial and in-flight cancellation; non-settling deadlines; late-open cleanup; close
precedence; hostile options/selections/errors; immutability; and command-free capability shape.

Run the focused gates with:

```sh
pnpm build
pnpm exec vitest run packages/evidence/test/read-only-filesystem.unit.test.ts --project unit
pnpm exec vitest run packages/evidence/test/read-only-filesystem.unit.test.ts --project unit \
  --coverage.enabled --coverage.include=packages/evidence/src/read-only-filesystem.ts \
  --coverage.reporter=text
```

The focused source must remain above the repository's 95% statements/lines/functions and 90%
branches thresholds. The full `pnpm check` remains required before integration.

Primary sources, retrieved 2026-08-02:

- Node.js `fs` documentation, v24.18.1:
  <https://nodejs.org/download/release/v24.18.1/docs/api/fs.html> (`lstat`, `opendir`, `Dir.read`,
  `readlink`, `realpath`, `FileHandle.read`, short reads/EOF, explicit handle close, bigint stats,
  `O_RDONLY`, and platform support for `O_NOFOLLOW`).
- Node.js `path` documentation, v24.18.1:
  <https://nodejs.org/download/release/v24.18.1/docs/api/path.html> (POSIX/Windows roots, relative
  membership, normalization, and separators).
- Node.js `perf_hooks` documentation, v24.18.1:
  <https://nodejs.org/download/release/v24.18.1/docs/api/perf_hooks.html#performancenow> (monotonic
  high-resolution duration source independent of civil-clock adjustment).

Observed-versus-documented: tests inject fragmented reads and concurrent identity changes because
their timing cannot be made reliable with a live filesystem. Actual temporary-filesystem fixtures
confirm Node's documented file, directory, symlink, hard-link, canonicalization, and handle
behavior. Windows junction and `O_NOFOLLOW` decisions are conditional on `process.platform` and run
on the required OS CI matrix; the POSIX development host cannot claim a Windows observation.

Injected-clock deadline tests give the real fallback timer generous scheduling headroom and cross
the deadline through the injected monotonic value. This keeps clock validation deterministic under
parallel CI load while separate non-settling-operation cases continue to exercise the real timer.
