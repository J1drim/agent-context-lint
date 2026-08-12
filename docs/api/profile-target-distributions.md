# Per-profile target token distributions

`aggregateProfileTargetDistribution` in `@agent-context/efficiency` combines one E08 target sample
with one G03 occurrence-aware token accounting result per selected path. Its immutable output is
`agent-context-profile-target-token-distribution` contract `0.2.0`. Version `0.2.0` adds the
source-derived per-target always-on subtotal required by G06; the percentile method is unchanged.

## Input identity and correspondence

The caller supplies a profile, surface, specification snapshot, profile/client version, and one
selected tokenizer identity. Every accounting must use that exact tokenizer ID, version, and
`exact`/`estimate` measurement kind. Mixing tokenizers fails; distributions built from unlike units
are not meaningful.

Accounting paths may arrive in any order, but their set must equal the E08 `selected` path set
exactly. Missing, duplicate, or substituted paths fail rather than changing the denominator. The
result retains the profile, tokenizer, E08 strategy/state, each target's trace digest and effective
token total, and whether that observation entered the statistics.

## Exact percentile definition

Contract `empirical-nearest-rank-v1` sorts complete effective-token observations in ascending
numeric order. For `n > 0`, percentile `p` uses the observed value at one-based rank
`ceil(p * n / 100)`. Therefore:

- `p50 = sorted[ceil(0.50 * n) - 1]`;
- `p95 = sorted[ceil(0.95 * n) - 1]`;
- minimum and maximum are the first and last observations.

This is the inverse empirical distribution (nearest-rank) definition: it never interpolates a
fractional token count and is independent of locale or input order. For values 1 through 20, the
result is minimum 1, p50 10, p95 19, maximum 20. A singleton uses its sole value for all four
statistics.

The definition follows the order-statistic framing in the
[NIST/SEMATECH Engineering Statistics Handbook](https://www.itl.nist.gov/div898/handbook/prc/section2/prc262.htm).
Each target also preserves `alwaysOnTokens` from the revalidated G03 `totals.always` value. G06 uses
that source-derived subtotal for its always-on budget input; callers must not infer it from syntax
or profile names.

The method ID is versioned because changing a sample quantile convention can change scores and
release comparisons.

## Empty and partial evidence

An empty E08 selection returns state `empty`, sample counts of zero, and `statistics: null`; zero is
not invented as a token measurement. Non-empty G03 `partial` results retain their known effective
token lower bound for explanation but set `includedInStatistics: false`. Statistics use only
complete accountings. If no complete accounting remains, statistics are `null` and the explicit
`no-complete-targets` issue is emitted.

The aggregate is `partial` when E08 sampling is partial or any target accounting is partial.
`sampling-partial` and path-specific `accounting-partial` issues preserve those two uncertainty
sources independently. Downstream scores must not present a partial subset distribution as complete.

## Safety and limits

The aggregator performs no file, command, clock, environment, or network operation. It accepts at
most 100,000 targets and rejects proxies, accessors, sparse/extended arrays, malformed paths and
identities, unsafe integers, incompatible tokenizers, unsupported upstream contract versions, and
path-set mismatches. Outputs are closed immutable data.

See [target sampling](target-sampling.md),
[occurrence-aware token accounting](occurrence-token-accounting.md), and
[output contracts](output-contracts.md).
