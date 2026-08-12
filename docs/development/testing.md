# Deterministic testing

The repository uses exact `vitest@4.1.10` and `@vitest/coverage-v8@4.1.10` versions. The root
configuration defines separately named `unit` and `integration` projects. Tests must produce the
same semantic result whether Vitest schedules files serially or in parallel.

## Project layout

- Package tests named `*.unit.test.ts` belong to the `unit` project.
- Repository-level tests named `*.integration.test.ts` belong to the `integration` project.
- Shared scenario code belongs in `tests/support`; committed, byte-sensitive expectations belong in
  `tests/goldens`.
- Test files import Vitest APIs explicitly. They do not depend on injected globals or test order.

Run a narrow project while developing and the complete deterministic checks before handoff:

```sh
pnpm test:unit
pnpm test:integration
pnpm test:serial
pnpm test:parallel
pnpm test:determinism
pnpm test:coverage-runner
pnpm test:documentation
pnpm coverage
```

I14 treats generated documentation as executable contract evidence. The default generator mode is
read-only and byte-compares committed output, shell/roff renderers receive hostile metadata cases,
and the pack gate runs tagged help/version examples against the extracted npm tarball without a
shell. See [Maintaining generated CLI documentation](generated-documentation.md).

`test:determinism` runs the real suite twice. Its normalizer removes wall-clock start/end/duration
fields, replaces the checkout root with `<workspace>`, sorts files and assertions, and compares the
remaining bytes and SHA-256 hashes. Timing is intentionally operational telemetry, not a golden
contract.

## Injected services

`@agent-context/core` owns small `Clock`, `RandomSource`, and `PathService` contracts. Production
features accept those contracts rather than directly reading time, randomness, the process working
directory, or the host path grammar. A03 deliberately does not add default production adapters;
later tickets must choose those adapters at a composition boundary.

The private `@agent-context/test-kit` package provides structurally compatible deterministic
implementations without adding a production-to-test dependency:

- `FixedClock` always returns one safe-integer epoch-millisecond value.
- `AdvancingClock` returns its current value, then advances by an explicit fixed step. It never
  reads wall time.
- `SeededRandom` uses `mulberry32-v1`, this repository's frozen 32-bit Mulberry32 output contract.
  Seeds are reduced to an unsigned 32-bit value; integer selection uses rejection sampling. It is
  suitable for replay and fixtures, never for secrets, signatures, identifiers, or security choices.
- `DeterministicPathService` selects POSIX or Windows grammar explicitly using Node's `path.posix`
  or `path.win32`. Its operations never use `process.cwd()`. `resolveWithinRoot` provides lexical
  traversal rejection, not a filesystem/symlink security boundary; C02 must combine path validation
  with the read-only filesystem jail.

Changing `mulberry32-v1` output is a fixture compatibility break. Introduce a new algorithm/version
identifier and migration rather than silently changing its sequence.

## Temporary workspaces

`createTempWorkspace` creates a unique directory below the operating system's temporary directory.
Fixture paths always use forward slashes, must be relative, and cannot lexically escape their root.
The helper writes fixture maps in sorted order and exposes root-contained `write`, `readText`,
`exists`, and `resolvePath` operations.

Prefer `withTempWorkspace(files, callback)`: it cleans up in `finally` after success or failure.
`createTempWorkspace` is available when a test needs a longer lifecycle, but every caller must
invoke its idempotent `cleanup`. Never include the randomized absolute temporary path in snapshots
or diagnostics. These helpers are for repository-owned fixtures; they are not a substitute for the
C02 hostile-filesystem facade.

Tests must not read a user's home directory, rely on the shell's current directory or locale, mutate
process-wide environment variables, monkeypatch global clocks/randomness/path APIs, make network
requests, or leave background work and temporary files behind.

## Coverage collection and merge

`pnpm coverage` follows Vitest's supported sharded-report workflow:

1. Run the unit and integration projects independently with the blob reporter and V8 coverage.
2. Merge the two blobs with `vitest --merge-reports` and apply the repository thresholds only to the
   complete result.
3. Repeat the merge with reversed blob filenames and require byte-identical normalized coverage.
4. Replace the checkout root, recursively sort the Istanbul coverage map, write
   `coverage/normalized-coverage.json`, and print its SHA-256 hash.

For release evidence or a host where the ambient package-manager metadata may have been produced by
another pnpm version, seal the replay to the admitted Node and JavaScript pnpm launcher:

```sh
AGENT_CONTEXT_PACK_NODE=/absolute/path/to/node \
AGENT_CONTEXT_PACK_PNPM=/absolute/path/to/pnpm.mjs \
node scripts/run-coverage-merge.mjs
```

Both values must be absolute; the launcher path must end in `.cjs` or `.mjs`. The runner executes
that launcher through the supplied Node binary with `--config.enable-global-virtual-store=false`,
never uses a shell, and omits admitted executable/launcher and temporary report paths from its
synthesized command summary. Without these variables, ordinary developer runs retain the platform
`pnpm` command lookup.

Normalization maps every positive Istanbul hit count to one while retaining zero. Coverage gates and
covered-path identity depend on whether a counter was reached, not how often a generated loop or
bounded traversal reached it. The normalized hash therefore rejects any covered/uncovered path
change without treating harmless positive invocation-count variation as a semantic difference.

Coverage instrumentation adds substantial CPU and memory pressure to the repository's maximum-size
boundary tests. Vitest schedules test files in parallel by default, and `maxWorkers` bounds the
worker count without defining a stable inter-file execution schedule. Coverage collection therefore
uses Vitest's documented `--no-file-parallelism` mode with an explicit single worker. This is a
deterministic instrumented collection schedule, not a timeout allowance: the five-second deadline,
all test cases, the documented native-platform skip, and the final 95% statement/function/line and
90% branch thresholds remain unchanged.

Ordinary `test:parallel` uses the shared two-lane orchestrator. Its first lane selects
`availableParallelism === 1 ? 1 : min(4, max(2, floor(availableParallelism / 2)))` workers. Its
second lane runs the eight reviewed maximum-size files sequentially with one worker, after excluding
them exactly from the first lane; this includes the filesystem-heavy standards-cache security
boundary tests. Each lane is nonempty, has a ten-minute process deadline, and propagates failures
and signals. The orchestrator uses the provisioned Node executable directly and runs each lane in an
independently managed process tree. Its absolute `performance.now()` deadline is rechecked after
timer wake-up. Deadline or parent SIGINT/SIGTERM stops admission of the second lane, waits through a
bounded TERM-to-KILL cleanup, and only then reports or re-raises the original outcome. Every lane
runs through a trusted intermediate host below a trusted Node supervisor, so losing the lane's
direct parent does not remove the cleanup anchor. On POSIX the supervisor stays alive after
reporting the lane result as the private session and process-group leader and ignores TERM until
cleanup escalates to KILL, preventing its PGID from being reused during cleanup. A bounded lineage
observer detects escaped descendants. Linux enumerates only bounded canonical numeric `/proc`
entries, then parses PID, PPID, process group, session, and exact start ticks from the same bounded
`O_NOFOLLOW` stat handle. It tolerates only an entry that vanishes between enumeration and open;
malformed, linked, oversized, duplicated, inaccessible, or excessive entries fail the observer.
Every targeted descendant PID reopens its own exact stat record. Group TERM first probes existence
and reopens the exact supervisor stat record to revalidate PID, start ticks, group, and session.
KILL uses the existing IPC channel to ask the live supervisor to synchronously signal its own group,
rather than externally signalling a numeric PGID that could be reused. Linux attempts an immediate
anchor revalidation first; any observer or identity uncertainty still fails the lane but does not
replace tree cleanup with direct-anchor destruction. Darwin and other POSIX platforms retain bounded
fixed-`/bin/ps` detection but require both the live direct supervisor handle and a current leader
row before signalling a group; otherwise they fail without that group signal or an individual signal
to a descendant whose precise identity is unknown. Any new-session descendant still live at
cleanup—or any observer uncertainty—fails the lane. Polling is detection, not a kernel containment
boundary: a double-fork/reparent wholly between snapshots can evade it, so J05 still owns native
sandbox containment. If the supervisor closes before cleanup, the runner sends neither an unowned
POSIX group signal nor a Windows `taskkill` to its possibly reused PID, fails the lane, and
suppresses the next lane. Windows otherwise keeps its supervisor alive after the lane reports over
IPC, then requires the validated `%SystemRoot%\\System32\\taskkill.exe /PID <pid> /T /F` operation
to close successfully within its cleanup deadline. The determinism check uses the same split for its
serial and resource-aware replays before comparing their normalized reports. This retains
concurrency evidence without letting unrelated maximum-size allocations starve one another on hosted
runners. Collection uses both the default and blob reporters so a failed project prints its complete
test failure before the merge stops. Timing-sensitive unit cases use explicit private test
boundaries to select the intended timeout or cancellation transition; wall-clock races are not
accepted as deterministic coverage evidence.

Platform-only Node test cases return immediately after recording their skip. A skip never continues
into another operating system's cleanup implementation. Linux process-stat tests still exercise
bounded parsing and reads everywhere, but assert the `O_NOFOLLOW` bit only where the host exposes a
nonzero flag; required Linux CI supplies the native no-follow proof.

The intermediate host and resident supervisor protect the ordinary operational lifecycle, including
a lane killing its direct parent and a post-TERM observer failure. They are not a same-UID security
boundary: deliberately enumerating and killing the trusted supervisor or calling `setsid()` can
defeat portable process-tree ownership. J05 owns native adversarial containment. Tests assert the
honest boundary: delayed markers are prevented while the anchor is resident, anchor loss fails
without a stale group/PID signal, and no subsequent lane starts.

This boundary follows Node's documented distinction: a detached POSIX child becomes a new process
group/session leader, while detached children can outlive parents. It also follows Microsoft's
documented `/T` contract for terminating a Windows process and the children it started. Sources:
[Node child processes](https://nodejs.org/api/child_process.html) and
[Microsoft taskkill](https://learn.microsoft.com/windows-server/administration/windows-commands/taskkill),
retrieved 2026-08-10. Linux start ticks follow the documented
[`/proc/pid/stat` field 22](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html); the fixed
reader rejects links, malformed records, mismatched PIDs, split identity sources, and oversized
content. POSIX `setsid()` can deliberately create another session, so neither a negative polling
result nor GitHub runner job-end orphan cleanup is represented as adversarial containment.

The Git metadata executor's post-capture race seam is internal test authority, not shipped runtime
surface. The CLI lazily imports a one-name production facade, and the deterministic bundle audit
requires the real executor and its runtime diagnostics while rejecting the test wrapper and marker.
Bundle writes remove, checks reject, and package inventories forbid every unbundled facade artifact.
Tests for those cleanup controls use isolated temporary directories and never mutate the real bundle
directory concurrently with bundle or package checks.

Coverage explicitly includes implemented production contracts and all `test-kit` source helpers,
including files a particular project does not import. The repository-path contract has exhaustive
table cases plus deterministic generated round-trip and comparison properties. Global minimums are
95% for statements, functions, and lines and 90% for branches. Thresholds are guardrails, not a
reason to omit malformed or boundary cases. Generated coverage and Vitest artifacts are ignored;
timing-bearing reports never enter committed goldens.

The configuration follows the official Vitest documentation retrieved 2026-08-01:

- [Test projects](https://vitest.dev/guide/projects)
- [V8 coverage and explicit source inclusion](https://vitest.dev/guide/coverage)
- [Blob reports and report merging](https://vitest.dev/guide/reporters#blob-reporter)
- [Parallelism, `fileParallelism`, and `maxWorkers`](https://vitest.dev/guide/parallelism)
