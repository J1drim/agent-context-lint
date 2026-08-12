# Developing context-efficiency scoring

G07 is implemented by `packages/efficiency/src/context-efficiency-score.ts`. It is the deterministic
composition boundary between source-linked G05 metrics and the immutable G06 formula.

## Pipeline contract

1. Build occurrence accounting and target distributions through G03/G04.
2. Build metrics through `analyzeContextEfficiencyMetrics`; do not construct metric summaries by
   hand.
3. Call `calculateContextEfficiencyScore` with that same-process record and an optional sparse B06
   efficiency configuration.
4. Pass the immutable score record to G09 formatters or F14 rules without recalculating, filling, or
   weakening uncertainty.

The calculator maps the nine fixed G06 input IDs to their documented G05 selectors. Any change to an
input ID, normalization, curve, allocation, weight semantics, rounding, or grade behavior needs a
score-version review plus schema, golden, and documentation updates.

## Implementation invariants

- Ratios, penalties, components, and aggregate arithmetic use integer basis points and `BigInt`
  half-up rounding only.
- Maximums and p95 values include only the complete observations G06 names.
- Partial sampling, partial distributions, unknown dead scope, partial
  breadth/amplification/density, missing comparisons, and indeterminate comparisons remain
  unavailable.
- Stratified-but-complete evidence is labeled `sampled`; it is never presented as exhaustive.
- A zero-weight unavailable component remains visible as `ignored-unavailable` and adds a report
  caveat, but cannot block the weighted aggregate.
- Empty density, amplification, or cross-profile populations are neutral only under the explicit G06
  rules. An empty target distribution is unavailable because no budget percentile exists.
- The output retains G05/G06/configuration identities, normalized operands, evidence references,
  formula metadata, tokenizer identity, and false quality claims.
- No function in this module reads files, the environment, clock, network, model, or repository
  content, and no repository text is copied into score evidence.

## Verification

```sh
pnpm build
pnpm exec vitest run packages/efficiency/test/context-efficiency-metrics.unit.test.ts
pnpm exec vitest run tests/context-efficiency-metrics.integration.test.ts
pnpm exec vitest run --coverage \
  --coverage.include=packages/efficiency/src/context-efficiency-score.ts \
  packages/efficiency/test/context-efficiency-metrics.unit.test.ts \
  tests/context-efficiency-metrics.integration.test.ts
pnpm lint
pnpm boundaries
pnpm security:scan
pnpm pack:check
```

The integration test runs the real F03/F04, E05/E07/E08, G03/G04/G05 pipeline through compiled
package exports and reconstructs the committed `52/F` golden. Unit cases cover all normalizations,
custom configuration, zero budgets, exhaustive and stratified samples, partial/unobserved evidence,
empty populations, schema closure, hostile inputs, immutability, and byte determinism.
