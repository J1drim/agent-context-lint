# Read-only repository facade

`@agent-context/evidence` exposes the internal C02 filesystem boundary used after C01 accepts a
repository root and before discovery, parsing, imports, or evidence collection. It accepts only the
frozen shape returned by `selectRepositoryRoot`; it does not rediscover Git, consult environment or
user configuration, invoke repository commands, access the network, or provide a write method. The
separate [atomic writer](atomic-writer.md) is an explicitly constructed mutation capability and is
never reachable through this facade. The [safe fix pipeline](safe-fix-pipeline.md) reuses the facade
for exact preflight identity/content validation, but dry-run preview itself performs no filesystem
mutation.

```ts
import { createReadOnlyRepository, selectRepositoryRoot } from "@agent-context/evidence";

const selection = await selectRepositoryRoot("/checkout/project", { mode: "explicit" });
const repository = await createReadOnlyRepository(selection, { signal });

const root = await repository.readDirectory(".");
const file = await repository.readFile("AGENTS.md");
const bytes = file.bytes();
```

The package is private in v1. Downstream internal components receive the facade rather than an
absolute path or the Node filesystem API.

## Path and result contract

`inspect`, `readDirectory`, and `readFile` accept canonical repository-relative POSIX identities.
The root is `.`. Absolute paths, backslashes, empty/dot/traversal components, repeated separators,
malformed Unicode, C0/C1 controls, bidi formatting controls, and paths longer than 16,384 UTF-8
bytes fail before filesystem access. Inputs are never coerced and error messages never interpolate
them.

`inspect` returns metadata for a regular file or directory. `readDirectory` streams one entry at a
time through a bounded directory handle, validates each untrusted name, returns sorted canonical
identities, and never materializes an unbounded platform result. Directory size is reported as zero
because platform directory byte counts are not portable content sizes. `readFile` returns a
`ReadOnlyRepositoryFile`; each `bytes()` call returns a fresh `Uint8Array`, so callers cannot mutate
the retained content. Results, entries, limits, usage snapshots, and nested identity objects are
frozen.

Calls on one facade are sequential by contract. A concurrent call fails with
`READ_ONLY_REPOSITORY_CONCURRENT_OPERATION`; this makes aggregate accounting and result ordering
deterministic. `usage()` reports root-validation and later metadata operations, retained entry
counts, accepted file bytes, and elapsed time.

## Jail and filesystem policy

The canonical C01 root and device/inode identity are revalidated during facade creation and before
and after user-visible reads. Path resolution uses component `lstat` observations, not string-prefix
membership. Stable symbolic links and junctions may resolve only to a lexical target inside the
canonical root. External targets are rejected before target inspection. Link loops and excessive
link expansion fail closed.

Only regular files and directories are accepted. Sockets, FIFOs, devices, and other special types
are rejected before open. Regular files with a link count other than one are rejected as ambiguous.
On POSIX, content opens use `O_RDONLY | O_NOFOLLOW`; Windows uses `O_RDONLY` and relies on the
component/link observations plus opened-handle identity because Node documents `O_NOFOLLOW` as
unavailable there. The opened handle must match the resolved file before bytes are read and again
after the bounded read. A following EOF is required at the advertised size. Early EOF, growth,
invalid or zero-progress fragments, identity/metadata drift, link replacement, directory
replacement, and root replacement fail without returning content or names.

Every opened file or directory handle has a guaranteed cleanup path. A successful-operation close
failure is reported. A cleanup failure cannot replace an earlier validation, cancellation, limit, or
read failure. If a non-cancellable platform open settles after a deadline or cancellation, a late
cleanup continuation closes the resulting handle.

## Limits and cancellation

| Limit                       |    Default |  Hard maximum | Accounted behavior                                |
| --------------------------- | ---------: | ------------: | ------------------------------------------------- |
| `maximumDurationMs`         |     30,000 |       300,000 | Creation and every awaited filesystem operation   |
| `maximumEntries`            |    100,000 |     1,000,000 | Inspected, read, and streamed directory entries   |
| `maximumFileBytes`          |  1,048,576 |    16,777,216 | Advertised size checked before content allocation |
| `maximumMetadataOperations` |  1,000,000 |     4,000,000 | Root validation, metadata, handle, and read calls |
| `maximumSymlinkDepth`       |         32 |            64 | Followed in-root link components                  |
| `maximumTotalBytes`         | 67,108,864 | 1,073,741,824 | Aggregate accepted file sizes for this facade     |
| `maximumTraversalDepth`     |        128 |         1,024 | Caller path plus link-expanded path components    |

Options may lower but never raise the hard limits. Creation validates the root using three counted
metadata operations. Every operation has cooperative pre/post checkpoints and an active timer/abort
race, so a non-settling filesystem promise does not prevent the facade deadline from settling. The
production clock is Node's monotonic `performance.now()`, not civil time. Injected clocks are held
to a monotonic high-water mark, so rollback cannot regain elapsed duration. Node filesystem calls
are not generally cancellable; a rejected call may still complete inside the runtime, but its result
is discarded and any late file/directory handle is closed.

Options and the C01 selection are snapshotted from plain data descriptors. Proxies, accessors,
unknown fields, explicit `undefined`, invalid native signal brands, unsafe paths, and out-of-range
limits fail before their values can dispatch caller code. Cancellation state is read through the
captured intrinsic `AbortSignal` getter.

## Errors and trusted injection

Failures are frozen `ReadOnlyRepositoryError` objects with a stable `code`, `operation`, optional
validated repository-relative `path`, and optional sanitized platform `causeCode`. Cause codes are
accepted only from short uppercase own data properties. Main categories distinguish cancellation,
deadline, limits, invalid input/selection, unavailable or changed paths, external links, link loops,
hard links, unsupported types, file/directory mismatches, read/close failure, and concurrent use.

`createReadOnlyRepositoryWithFileSystem` exists for deterministic race, fragmented-read, timeout,
and platform tests. Its capability and returned handles are trusted executable code. They must never
originate in repository files, parsed configuration, standards data, or plug-ins. Production callers
use `createReadOnlyRepository`, whose fixed capability contains only `lstat`, `realpath`,
`readlink`, read-only file open, streaming directory open, and a clock.
