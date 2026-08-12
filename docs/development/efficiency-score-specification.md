# Developing the efficiency score specification

G06 lives in `packages/efficiency/src/efficiency-score-specification.ts`. It is the immutable
formula/configuration layer between G05 evidence and the implemented
[G07 calculator](context-efficiency-score.md).

## Change discipline

1. Build the specification only through `createEfficiencyScoreSpecification`; it delegates sparse
   input to the real B06 validator and snapshots the normalized values.
2. Keep curves data-only and monotonic. Use integer basis points and `BigInt` intermediate
   arithmetic; never replace the documented half-up rule with floating-point interpolation.
3. Name the exact G05 source and normalization on every input. Adding a metric requires source
   provenance and explicit empty/partial/unknown behavior.
4. Keep each component's input allocations at 10,000 bp and all configured component weights at 100
   percent. Runtime validation owns cross-property relationships that JSON Schema cannot express.
5. Do not turn missing evidence into zero. G07 must omit a score when a required nonzero-weight
   component is unavailable and report the reason.
6. Increment `EFFICIENCY_SCORE_VERSION` for any result-affecting change. Contract-only additive
   metadata follows the repository compatibility policy separately.

G06 adds `alwaysOnTokens` in G04/G05 contracts `0.2.0` because it is the only source-backed path
from revalidated G03 `totals.always` to the budget-fit input. Preserve that field through G05; do
not infer always-on context from syntax or profile names.

## Verification

```sh
pnpm build
pnpm exec vitest run packages/efficiency/test/efficiency-score-specification.unit.test.ts
pnpm exec vitest run tests/context-efficiency-metrics.integration.test.ts
pnpm exec vitest run packages/core/test/configuration.unit.test.ts
pnpm config:reference:check
pnpm boundaries
pnpm pack:check
```

The unit suite covers defaults, customization, relational validation, hostile JavaScript values,
curve structure, interpolation boundaries, clamping, zero budgets, grade edges, determinism, and a
monotonic property sweep. The integration suite uses compiled package exports and real
F03/F04/E05/E07/E08/G03/G04/G05 composition before reconstructing the committed G06 golden.
