# Occurrence-aware token accounting

`accountOccurrenceTokens` in `@agent-context/efficiency` reconciles token measurements for one E04
document/import DAG and resolution trace. The output contract is
`agent-context-occurrence-token-accounting` version `0.1.0`.

`combineOccurrenceTokenAccountings` composes multiple genuine G03 results for one profile and one
target when that effective context has several top-level documents. It accepts only results issued
by this process, requires one distinct entry path per input, identical trace digests, and compatible
tokenizer identities. The combined result remains the same `0.1.0` data contract consumed as G04's
single observation for that profile/target.

## Inputs

The function accepts only closed data:

- the E04 `DocumentImportDag`;
- one full-source `TokenCount` for every document;
- one selected tokenizer identity shared by every count; and
- one explicit decision for every occurrence.

An occurrence decision is `included`, `excluded`, or `unknown`. Included decisions also name the
activation class (`always` or `conditional`), the count of the text actually consumed, and the
number of source bytes consumed. Excluded and unknown decisions carry no count or activation.

The accounting layer does not infer whether `already-loaded`, cyclic, or otherwise client-specific
occurrences are loaded. A profile/resolver must make that decision explicitly. Counts produced by
different tokenizer IDs, versions, or exact/estimate measurement kinds are rejected.

## Totals

| Field       | Exact definition                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `raw`       | Sum of each DAG document's full-source count. Separate files with identical contents remain separate. |
| `imported`  | Sum of consumed counts for included non-entry occurrences. Repetitions remain separate.               |
| `unique`    | Sum of each distinct content identity's full count when at least one included occurrence reaches it.  |
| `always`    | Sum of consumed counts for included occurrences classified `always`.                                  |
| `effective` | Sum of consumed counts for all included occurrences in this trace.                                    |

These are integer token counts, not byte estimates. `documents`, `contents`, and `occurrences`
provide the contribution records needed to reconstruct each total. `sourceBytesAvailable`,
`sourceBytesConsumed`, `availableTokens`, `consumedTokens`, and `truncated` retain exact truncation
evidence. A partial count is measured independently; it is never prorated from a whole-file count.

`unique` uses the full count of reached content rather than a fractional truncated count. This is
the source baseline needed by the later import-amplification metric. Consequently a heavily
truncated trace can have fewer effective tokens than unique source tokens.

Composition deduplicates byte-identical overlapping document/content contributions, but never
deduplicates consumption. Every occurrence is reissued with a deterministic, root-scoped identity
and a global ordinal, so the same imported subgraph reached from two top-level documents contributes
twice to `effective`/`imported` while contributing once to `unique`. Input ordering does not change
the combined bytes. Conflicting document identities, duplicate roots, occurrence/resource overflow,
or incompatible evidence fail closed. Before composition begins, the sums of input document and
content rows are each capped at 4,096; input occurrence and issue rows are each capped at 65,537.
These are work limits, so repeated rows count before deduplication and cannot amplify merge work
through many overlapping inputs.

## Partial evidence and failures

The result is `partial` when the import graph is partial, a document could not be parsed, or any
occurrence remains `unknown`. Numeric totals then contain only explicit known contributions; they
must not be presented as a complete upper bound.

Malformed, proxy/accessor-bearing, sparse, extended, over-limit, incompatible, duplicated, missing,
or relationally inconsistent inputs throw `OccurrenceTokenAccountingError`. Token sums are checked
for JavaScript safe-integer overflow. Returned records and arrays are immutable snapshots and retain
the E04 trace digest.

See also [document/import DAG](document-import-dag.md),
[tokenizer provider contract](../architecture/tokenizer-plugin-contract.md), and
[deterministic estimate tokenizer](../architecture/estimate-tokenizer.md).
