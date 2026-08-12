# Developing the import graph loader

C10 lives in `packages/evidence/src/import-graph-loader.ts`. Review the
[API contract](../api/import-graph-loader.md), [C02 facade](read-only-repository.md),
[C09 lexer](import-lexer.md), [B03 instruction IR](../api/instruction-ir.md), and
[threat model](../security/threat-model.md) before changing it.

Maintain these invariants:

- never read a target unless C09 marked it as a recognized repository-path candidate;
- resolve only logical POSIX paths, reject lexical escape, and delegate real containment to C02;
- read sequentially through the already bounded facade; never add direct `node:fs` access;
- check canonical-path active cycles and completed nodes before reading, then check C02 identity
  aliases before decoding;
- preserve source-order edge occurrences and first-read depth-first node order;
- check depth/edge/file/fan-out/byte ceilings before expanding the next unit;
- retain successful branches after a contained failure and emit only stable, source-located codes;
- never include source content, host paths, or raw exception messages in issues; and
- keep input/output arrays, identities, nodes, edges, issues, limits, and results immutable.

Tests must cover a multi-level graph, repeated occurrences, cycles, root escape, every non-path
target class, missing/unsafe reads, invalid UTF-8, parse failure, exact boundaries and one-over each
limit, issue truncation, deterministic replay, hostile API containers, and proof that rejected
targets were never read. Filesystem containment/race behavior remains covered at the C02 layer;
integration tests should use the real C02 facade rather than duplicate filesystem access here.

Run:

```sh
pnpm build
pnpm exec vitest run packages/evidence/test/import-graph-loader.unit.test.ts --project unit
pnpm coverage
pnpm check
```

Any future dialect-specific decoding or activation rule belongs in its D-series adapter. E04 may
consume this graph but must not reinterpret a rejected C10 edge as loaded.
