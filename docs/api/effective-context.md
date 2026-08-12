# Effective-context resolver API

`@agent-context/resolver` E05 exports a pure, synchronous projection over one genuine D-series
profile resolution and zero or more genuine E04 import DAGs. It performs no filesystem, process,
environment, network, clock, or model access.

## Entry point

```ts
resolveEffectiveContext({
  contractVersion: "0.1.0",
  recordKind: "agent-context-effective-context-input",
  profileResolution,
  importDags,
  targetPath,
});
```

`profileResolution` must be an object returned in the same process by one of:

- `resolveCodexCliAgents` (D03)
- `resolveClaudeCodeProfile` (D05)
- `resolveCopilotProfile` (D08)
- `resolveGeminiCliContext` (D10)
- `resolveCursorProfile` (D13)

Each import DAG must come from `buildDocumentImportDag` (E04) and its `entryPath` must uniquely
match a projected profile document. This issuance requirement prevents a caller from forging an
internally inconsistent “trusted” profile result. Persist the original resolver inputs if replay is
needed; deserialized output objects are deliberately not accepted as authority.

## Result contract

The immutable `EffectiveContextResolution` has record kind `agent-context-effective-context` and
contract version `0.1.0`.

| Field                                            | Meaning                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profileId` / `profileVersion`                   | Resolver profile identity and its output-contract version.                                                                                                                                              |
| `clientVersion` / `surfaceId` / `specSnapshotId` | Actual client version when known, exact client surface, and pinned specification snapshot used by the profile.                                                                                          |
| `documents`                                      | Canonical documents with activation, state, exact/partial content, byte counts, digest, source identity, and truncation.                                                                                |
| `sequence`                                       | A total order only where the profile establishes one; otherwise a deterministic representative sequence accompanied by non-total `ordering`.                                                            |
| `precedence`                                     | Observed load-order or documented partial-order edges. These edges do not claim semantic winner behavior.                                                                                               |
| `conflicts`                                      | Pairwise conflict opportunities among possibly active, non-shadowed, non-empty documents. E05 does not parse prose to assert that two instructions conflict.                                            |
| `ambiguities`                                    | Stable records for activation, precedence, semantic precedence, target scope, imports, truncation, external context, or partial upstream analysis.                                                      |
| `occurrences`                                    | Ordered E04 import occurrences. Repeated imports retain separate occurrence IDs and shared content identity.                                                                                            |
| `assembly`                                       | Exact text only when the profile exposes exact assembly and all contributing external context was supplied (currently D03); otherwise `partial` or `unknown`. Known partial text may still be retained. |
| `analysisStatus`                                 | `complete` only when no ambiguity remains and assembly is exact; otherwise `partial`.                                                                                                                   |

Document `state` and `activation` are deliberately separate. A shadowed fallback is inactive because
another candidate won selection. A conditional document is indeterminate. An empty selected document
remains selected but contributes no conflict opportunity. `contentState` distinguishes complete
text, a known truncated prefix, identity-only evidence, and unavailable bytes.

## Ordering rules

- Codex preserves root-to-CWD observed load order and exact assembled text. Its pinned profile does
  not establish a semantic “later text wins” rule, so multiple documents produce
  `semantic-precedence` ambiguity and `semantic-winner-unknown` conflicts.
- Claude preserves `orderAfter` as a documented partial order. Unrelated ready nodes remain partial.
- Copilot and Cursor candidate inventories are canonically path-sorted, but this deterministic
  presentation is not precedence. Their `ordering` stays `unordered` or `unknown` where applicable.
- Gemini preserves its real resolver document load order (startup followed by JIT events).

## Errors and limits

`EffectiveContextError` uses stable codes:

- `EFFECTIVE_CONTEXT_INVALID_INPUT` for malformed/hostile envelopes or non-issued dependencies;
- `EFFECTIVE_CONTEXT_INVALID_RELATIONSHIP` for target/DAG relationships that do not agree;
- `EFFECTIVE_CONTEXT_RESOURCE_LIMIT` before an unbounded document, occurrence, ambiguity, or
  pairwise-conflict result can be materialized.

`EFFECTIVE_CONTEXT_LIMITS` is public and immutable. The conflict matrix and ambiguity collection are
capped at 65,536 records, documents/import DAGs at 4,096, aggregate occurrences at 65,537, and
retained text at 16 MiB. The input envelope is closed, descriptor-safe, and rejects proxies,
accessors, sparse arrays, extended arrays, noncanonical target paths, and unknown fields.

`isIssuedEffectiveContextResolution` is a same-process capability check used by downstream trusted
projections such as E06. It is not a validation API for deserialized data and returns false for
caller-created lookalikes.
