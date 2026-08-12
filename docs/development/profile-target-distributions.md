# Developing profile target distributions

G04 lives in `packages/efficiency/src/profile-target-distribution.ts`. It aggregates data-only E08
and G03 outputs; it does not resolve profiles, resample paths, tokenize text, or calculate scores.

## Invariants

- Require exact equality between the E08 selected path set and G03 accounting path set.
- Normalize accounting order with the B01 case-sensitive path comparator.
- Reject mixed tokenizer identity, version, or measurement kind.
- Aggregate distribution statistics only from `totals.effective`; retain `totals.always` on each
  target as source-backed G06 budget evidence and retain each G03 trace digest for explanation.
- Exclude partial-accounting lower bounds from statistics while retaining them in target evidence.
- Preserve E08 and G03 uncertainty separately.
- Return `null`, never zero or `NaN`, when no complete observation exists.
- Keep `empirical-nearest-rank-v1` byte-stable. A different quantile method requires a new method ID
  and migration evidence.

The nearest-rank indices for the only published percentiles are computed directly as
`ceil(n * 50 / 100) - 1` and `ceil(n * 95 / 100) - 1` after numeric sorting. Do not use the default
JavaScript lexicographic sort, host statistics libraries, interpolation, floating output, or a
median-of-two convention.

## Verification

Run:

```sh
pnpm exec vitest run packages/efficiency/test/profile-target-distribution.unit.test.ts
pnpm coverage
pnpm check
```

Tests must retain the hand-worked 1..20 fixture, singleton and empty behavior, partial-sample and
partial-accounting behavior, exact tokenizer compatibility, path-set equality, order independence,
hostile JavaScript containers, resource ceilings, immutability, and repeated byte identity. At least
one focused fixture must use the production E08 sampler and G03 accounting function rather than
hand-forged summaries.

The public contract and quantile definition are in
[Per-profile target token distributions](../api/profile-target-distributions.md).
