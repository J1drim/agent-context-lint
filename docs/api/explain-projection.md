# Explain projection API

`@agent-context/resolver` E06 exports `projectExplain`, a pure synchronous projection for explaining
one or many genuine E05 effective-context results. It performs no filesystem, process, environment,
network, clock, or model access.

## Entry point

```ts
projectExplain({
  contractVersion: "0.1.0",
  recordKind: "agent-context-explain-projection-input",
  resolutions: [effectiveContextForTarget],
  trace: null,
});
```

Every resolution must have been returned by `resolveEffectiveContext` in the same process. All
resolutions must share `profileId`, `profileVersion`, `clientVersion`, `surfaceId`, and
`specSnapshotId`, and each must have a unique canonical target path. The output target array is
sorted by UTF-8 target path, independent of input order.

`trace` is either `null` for a static projection or the parsed JSON value of an E03 resolution-event
trace. E06 normalizes and validates a supplied trace, requires every explained target to have a
matching trace target, records its canonical SHA-256 digest, and projects launch, session, and
matching target events. The trace is target-matched evidence; callers that want event-sensitive
profile resolution must supply the same trace to the upstream profile resolver before E05. E06 does
not replay a profile or claim that a trace retroactively caused an E05 decision.

## Accounting and reasons

Each target contains its E05 assembly, order, precedence, conflicts, ambiguities, and sequence plus
two complete disposition ledgers:

- `included`: selected/effective documents and loaded import occurrences;
- `excluded`: inactive or shadowed documents and rejected/unavailable/cyclic/resource-limited
  occurrences;
- `conditional`: indeterminate/conditional documents and ambiguous import occurrences.

Every document has activation, selection-state, and content-state reasons. Truncation and linked E05
ambiguities add reasons rather than replacing the base accounting. Every occurrence has one import
reason. Reasons contain a stable E06 `code`, category `kind`, the upstream `sourceCode` where one
exists, and an optional related ambiguity ID. `accounting` totals dispositions, reasons, conflicts,
ambiguities, and matched trace events so consumers can confirm that nothing silently disappeared.

The immutable result has record kind `agent-context-explain-projection` and contract version
`0.1.0`. Its top-level identity fields bind the explanation to the exact profile, client version,
surface, and specification snapshot used by E05. `analysisStatus` is partial whenever any target is
partial.

## Errors and limits

`ExplainProjectionError` uses stable codes:

- `EXPLAIN_PROJECTION_INVALID_INPUT` for malformed, hostile, or non-issued input;
- `EXPLAIN_PROJECTION_INVALID_RELATIONSHIP` for duplicate targets, mixed identities, or a trace
  without a matching explained target;
- `EXPLAIN_PROJECTION_INVALID_TRACE` when E03 rejects the supplied trace;
- `EXPLAIN_PROJECTION_RESOURCE_LIMIT` before aggregate output can exceed a public E06 limit.

`EXPLAIN_PROJECTION_LIMITS` caps targets at 4,096, aggregate documents at 8,192, occurrences at
32,768, reasons at 65,536, and projected trace events at 65,536. E03 applies its own input limits
before E06 projection. The input envelope is closed and descriptor-safe; proxies, accessors, sparse
or extended arrays, and unknown fields fail closed.
