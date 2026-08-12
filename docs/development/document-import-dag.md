# Developing the document/import DAG

E04 lives in `packages/resolver/src/document-import-dag.ts`. Review the
[API contract](../api/document-import-dag.md), [C10 graph](../api/import-graph-loader.md),
[E03 trace](../api/resolution-event-traces.md), and [threat model](../security/threat-model.md).

Preserve these separations:

- C10 owns safe reads, target decisions, limits, cycles, and partial graph evidence.
- E03 owns canonical event order and trace identity.
- E04 owns document/content identity projection and exact occurrence preservation.
- The no-import bridge owns only the one-entry projection of an issued B03 document with zero
  imports. Never use it to bypass C10 or to assign a fictitious vendor dialect.
- D-series profiles own vendor recursion/dedup behavior; E05 owns precedence/effective context.
- G03 consumes occurrences through the explicit
  [occurrence-accounting contract](occurrence-token-accounting.md); profile resolution supplies one
  loading/activation decision per occurrence so accounting never invents client semantics.

Never deduplicate the occurrence array. Document deduplication uses its stable C10 document ID;
content deduplication uses exact SHA-256 and must reject a conflicting byte length. Keep
logical-path documents separate even when their bytes match. Do not expose C02 inode/device
identity. A cycle is an occurrence pointing to an existing document ID, never a JavaScript object
reference.

Changes require tests for repeated imports, byte-identical files, ordered nested edges, cycles,
missing/invalid targets, parse-failed documents, empty root failure, trace changes, determinism,
relationship forgeries, count/byte disagreements, malformed ranges/IDs/paths/states, proxy/accessor/
sparse/extended containers, every resource ceiling, and no-import snapshot issuance/refusals.

Run:

```sh
pnpm build
pnpm exec vitest run packages/resolver/test/document-import-dag.unit.test.ts --project unit
pnpm coverage
pnpm check
```
