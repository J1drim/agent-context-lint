# Developing occurrence-aware token accounting

G03 is arithmetic and evidence preservation, not client resolution. Keep profile behavior in the
resolver/profile layers and pass it into `accountOccurrenceTokens` as one decision per E04
occurrence. In particular, never reinterpret `already-loaded`, `cycle`, or failed-import states in
the efficiency package.

## Invariants

- Every DAG document has exactly one full-source measurement.
- Every DAG occurrence has exactly one decision.
- Every count uses the selected tokenizer identity and contract version.
- Documents sharing a content ID have identical full counts.
- An included untruncated occurrence has the exact full document count.
- An included truncated occurrence records its independently tokenized prefix and exact consumed
  source-byte length.
- Excluded and unknown occurrences contribute no numeric tokens.
- All additions remain safe integers.
- Output order follows immutable E04 document/content/occurrence order.
- Multi-entry composition accepts only same-process issued G03 results for one trace and tokenizer.
- Combined documents/content are deduplicated by exact identity; repeated occurrences are retained,
  reissued with root-scoped IDs, and globally reindexed in canonical root-path order.
- Composition preflights raw input-row sums against the G03 document/content/occurrence ceilings
  before sorting or deduplication; do not move these checks after the merge.

The implementation validates closed own-data records, dense ordinary arrays, cardinality ceilings,
cross-references, and tokenizer compatibility before accounting. Do not weaken these checks merely
because current callers produce trusted TypeScript objects; JSON formatters, cache restoration, and
future plug-in boundaries can reintroduce hostile data.

## Testing changes

Run the focused suite:

```sh
pnpm exec vitest run packages/efficiency/test/occurrence-token-accounting.unit.test.ts
```

Then run `pnpm check`. Tests must keep hand-calculated reconciliation for repeated imports,
same-content files, explicit repeated-import exclusion, truncation, uncertainty, incompatible
tokenizers, forged relationships, proxies/accessors, sparse/extended arrays, limits, immutability,
repeat determinism, multi-entry order independence, shared imported content, partial evidence, and
direct G04 acceptance. Downstream G04 receives exactly one base or combined accounting for each
selected profile/target and must never combine incompatible tokenizer or trace identities.

The public definitions are documented in
[the occurrence-accounting API contract](../api/occurrence-token-accounting.md).
