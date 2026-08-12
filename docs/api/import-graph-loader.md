# Safe import graph loader

Ticket C10 adds `loadImportGraph` to the internal `@agent-context/evidence` package. It combines the
C02 root-jailed read-only repository with C09 lexical references. The result is an immutable,
deterministic graph of unique loaded documents and ordered import occurrences. A bad import cannot
discard successfully collected evidence from another branch.

```ts
import { loadImportGraph } from "@agent-context/evidence";

const graph = await loadImportGraph({
  repository,
  entryPath,
  syntax: "claude-code",
});
```

The v0.1.0 result has `nodes` in first-read depth-first order and `edges` in import encounter order.
Repeated imports retain separate edges but reuse a completed node. Each node records its canonical
repository path, byte count, content SHA-256, deterministic source/document IDs, first-seen depth,
lexical imports, and `loaded` or `parse-failed` state. It does not expose source text or unstable
filesystem identity. Device/inode identity is used only inside one traversal for alias-cycle safety.
An edge records the complete source-located B03 import, target decision, depth, and target document
identity when available.

Bytes are decoded with fatal UTF-8 semantics and a leading BOM is retained, preserving C09's exact
byte/UTF-16 coordinate contract. The implementation primitives were checked against the current
[Node 24 TextDecoder documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/util.html#class-utiltextdecoder)
and
[Node 24 crypto documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/crypto.html#cryptocreatehashalgorithm-options).

## Decisions and partial results

Only a `recognized` `repository-path-candidate` can cause a read. The target is resolved relative to
the importing file with POSIX repository-path rules. `..` may move toward the selected root but can
never cross it. C02 then performs real-path, symlink, hard-link, race, type, and root containment
checks before returning bytes.

Absolute paths, URLs, fragments, unknown or malformed targets, ambiguous references, lexical root
escapes, missing/unsafe files, cycles, invalid UTF-8, parse failures, and limit failures become
stable issue codes. Import issues use the original specifier range and importing path; root read and
decode issues have no source range. Error records never contain source bytes, filesystem error text,
absolute host paths, or exception causes.

The result state is `complete` only when there are no issues. Otherwise it is `partial`; nodes and
edges from unaffected branches remain available. Canonical-path cycles are detected against the
active traversal stack before a read; in-root symlink aliases are detected from C02's device/inode
identity immediately after the bounded read and before decoding or expansion. Completed targets are
deduplicated by canonical logical path because distinct logical paths can have distinct relative
import bases. E04 owns later occurrence/content DAG semantics and profile adapters own whether a
recognized syntax is active for a particular client version.

## Resource contract

Callers may tighten but never raise these defaults/hard ceilings:

| Limit                                 |    Ceiling |
| ------------------------------------- | ---------: |
| Import depth below the entry document |         32 |
| Ordered edge occurrences              |     65,536 |
| Loaded targets from one document      |        256 |
| Unique graph nodes                    |      4,096 |
| Bytes in one file                     |    524,288 |
| Aggregate unique-file bytes           | 16,777,216 |
| Materialized issues                   |      4,096 |

The C09 per-document import ceiling additionally bounds work before the graph-wide edge ceiling. At
fan-out overflow, the first omitted occurrence carries the issue and every lexical occurrence still
receives a `limit-exceeded` edge until the global edge ceiling. The first occurrence beyond that
ceiling receives a source-located issue and expansion stops across the traversal. At the issue
ceiling, already admitted edge decisions remain available without growing the issue array. Reads are
deliberately sequential because C02 rejects concurrent facade operations; this also keeps
first-failure and traversal order reproducible.

API inputs and limits are closed non-proxy records with own data properties. Repository methods are
snapshotted without invoking accessors before the first await. Invalid containers and paths fail the
whole call with `ImportGraphLoaderError`; repository/content failures are graph evidence instead.

## Capability boundary

The loader has no network, DNS, socket, process, shell, VCS, environment, model, plugin, telemetry,
or write capability. It never executes repository content and never treats an import as a command.
Production callers must pass a C02 facade created from an explicitly accepted C01 selection. The
structural repository type exists for deterministic tests, not as permission to pass an arbitrary
I/O callback across the production trust boundary.
