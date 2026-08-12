# Document/import occurrence DAG

Ticket E04 adds `buildDocumentImportDag` to the internal `@agent-context/resolver` package. It
projects one trusted C10 import graph and one normalized E03 event trace into an immutable,
occurrence-aware document/content graph.

```ts
import { buildDocumentImportDag } from "@agent-context/resolver";

const dag = buildDocumentImportDag({ graph: importGraph, trace: eventTrace });
```

For a parser-issued B03 document that has no imports, use the separate no-import bridge:

```ts
const dag = buildNoImportDocumentDag({ ir: issuedIrSnapshot, documentId, trace: eventTrace });
```

This bridge exists for formats such as `AGENTS.md` that need genuine occurrence accounting but do
not have a vendor import dialect. It accepts only a same-process B03 snapshot, requires the selected
document and source relationship to exist, refuses any non-empty `importIds`, and emits exactly one
entry document, content, and occurrence. The caller-supplied E03 trace describes the genuine
resolution scenario (for example, launch at the selected root and read the actual sampled target),
not a claim that the instruction document was itself the target. It is normalized and digested by
the same E03 boundary as an import-backed DAG. Graph state is `complete` only when the source parse
state is complete. Imported documents must use C10 and `buildDocumentImportDag`.

The v0.1.0 result contains:

- `documents` in C10 first-read order, each linked to one content identity;
- `contents` sorted by `content:<sha256>`, with sorted document membership;
- `occurrences` in actual C10 encounter order: an entry occurrence followed by one record for every
  admitted import edge;
- all C10 partial issues and graph state; and
- the exact ordered E03 event IDs plus the canonical E03 trace SHA-256.

Document IDs retain logical path and source identity. Content IDs depend only on exact byte SHA-256,
so byte-identical files at different paths share one content record without collapsing their
different relative import bases. Device/inode values are deliberately absent: C10 uses them only
during one safe traversal, and filesystem placement must not destabilize resolver results.

## Occurrence semantics

Every import attempt is distinct even when it names an already loaded document or identical bytes.
An occurrence records its global ordinal, stable length-framed SHA-256 identity, importing document,
source range/import ID, state, target logical path/document/content when known, and issue code.
`loaded`, `already-loaded`, `cycle`, `ambiguous`, `rejected`, `unavailable`, and `limit-exceeded`
remain distinct. Repeated `already-loaded` occurrences therefore cannot disappear behind document or
content deduplication, and cycle evidence remains a finite ID relationship rather than an object
cycle.

E04 does not expand a repeated document according to one invented universal policy. Gemini tree and
flat modes, Claude recursion, Copilot surface differences, and Cursor unknowns are profile-owned.
Later adapters/E05 may interpret the preserved occurrence state using their pinned specification;
they must not change the evidence order or silently convert unknown behavior to loaded behavior.

The entry record is present only when C10 loaded or parse-failed the entry file. A root read failure
produces no entry occurrence but retains the graph issue. An imported parse-failed document remains
a loaded occurrence whose target document state is `parse-failed`; the separate C10 issue preserves
the failure evidence.

## Validation and limits

The builder revalidates C10's closed graph shape, supported contract/dialect, dense arrays, stable
IDs, canonical paths, SHA-256 values, ranges, counts, aggregate bytes, state/issue pairs, source and
target relationships, entry identity, and unique document/source/path identities. It then invokes
E03's closed trace normalizer and digest. E03 validation errors retain their existing stable error
identity; E04 graph errors use `DocumentImportDagError`.

| Limit                          |   Value |
| ------------------------------ | ------: |
| documents                      |   4,096 |
| unique contents                |   4,096 |
| entry plus import occurrences  |  65,537 |
| retained C10 issues            |   4,096 |
| references across loaded nodes | 262,144 |

All public records and arrays are non-proxy, own-data, dense, bounded, and frozen. The no-import
bridge also rejects cloned/forged snapshots, unknown document IDs, imported documents, and B03
snapshots beyond the E04 document ceiling. Validation checks declared lengths before entries and
never invokes accessors or coercion. The operation is pure and has no filesystem, network, clock,
random, process, environment, model, telemetry, or write capability.
