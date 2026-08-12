# Efficiency score specification

`createEfficiencyScoreSpecification` in `@agent-context/efficiency` publishes the complete,
data-only formula used by context-efficiency score version `1.0.0`. The record kind is
`agent-context-efficiency-score-specification`, contract `0.1.0`; its closed JSON Schema is
[`efficiency-score-specification.v1.schema.json`](../../packages/efficiency/schemas/efficiency-score-specification.v1.schema.json).

G06 defines the formula, configuration, curve evaluator, and grade boundaries. The
[G07 calculator](context-efficiency-score.md) applies it to G05 evidence. The specification sets
`qualityClaim: false`: a static grade is a review aid, not evidence of agent capability, instruction
necessity, or preserved task outcomes.

## Configuration and defaults

`createEfficiencyScoreSpecification(value)` accepts the sparse B06 `efficiency` object. It applies
the same closed, bounded runtime validation as `.agent-context-lint.yml`; unknown keys, accessors,
proxies, cycles, exotic prototypes, sparse arrays, non-finite numbers, and invalid relationships are
rejected with `EFFICIENCY_SCORE_INVALID_CONFIGURATION`.

| Component               | Configuration key       | Default weight |
| ----------------------- | ----------------------- | -------------: |
| Budget fit              | `budgetFit`             |             30 |
| Scope precision         | `scopePrecision`        |             25 |
| Non-redundancy          | `nonRedundancy`         |             20 |
| Reachability            | `reachability`          |             10 |
| Instruction density     | `instructionDensity`    |             10 |
| Cross-agent consistency | `crossAgentConsistency` |              5 |

Weights are integer percentages from 0 through 100 and must sum to exactly 100 after defaults are
applied. A zero-weight component remains visible but its unavailable inputs do not prevent an
aggregate score. The token budgets default to 2,500 always-on tokens and 5,000 effective p95 tokens.
The only selectable score version is `1.0.0`.

Grade floors are inclusive and must satisfy `A > B > C > D`:

| Grade | Default interval |
| ----- | ---------------- |
| A     | 90 through 100   |
| B     | 80 through 89    |
| C     | 70 through 79    |
| D     | 55 through 69    |
| F     | 0 through 54     |

`gradeEfficiencyScore` validates both the integer 0–100 score and the supplied threshold relation.

## Exact arithmetic

All ratios, curve inputs, penalties, and component scores use integer basis points: 10,000 is one
whole. No binary floating-point value, locale, clock, or host ordering participates.

```text
ratio_bp = round_half_up(numerator * 10,000 / denominator)

input_penalty_bp = piecewise_linear_round_half_up(curve, ratio_bp)

component_score_bp = 10,000 - round_half_up(
  sum(input_penalty_bp * input_allocation_bp) / 10,000
)

score = round_half_up(
  sum(component_score_bp * component_weight) / 10,000
)
```

`round_half_up(n/d)` is integer `(n + floor(d/2)) / d`. Curve inputs below/above the first/last
point clamp to that endpoint. `efficiencyRatioBasisPoints(0, 0)` returns zero; a positive numerator
over a zero denominator saturates at the public 1,000,000-basis-point input ceiling. That makes a
zero configured budget mean “no tokens permitted” without division or infinity.

## G05 normalization

G07 must use these normalizations exactly. “Maximum” is over profiles, and p95 uses G04
`empirical-nearest-rank-v1` on complete targets. A required partial/null/unknown source makes its
nonzero-weight component and aggregate score unavailable rather than zero.

| Input                   | G05 source and normalization                                                                                                                                   | Allocation |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------: |
| Always-on p95 budget    | Maximum profile p95 of complete `distributions.targets[].alwaysOnTokens`, divided by `budgets.alwaysOnTokens`                                                  |      5,000 |
| Effective p95 budget    | Maximum complete `distributions[].statistics.p95`, divided by `budgets.effectiveP95Tokens`                                                                     |      5,000 |
| Broad-scope token share | Across complete `broadScope` profiles, sum `effectiveTokens` for documents with coverage at least 8,000 bp, divided by all observed document `effectiveTokens` |     10,000 |
| Exact duplicate share   | `duplication.exact.redundantTokens / density.rawTokens`                                                                                                        |      7,000 |
| Near-duplicate share    | `duplication.near.similarityCandidateTokens / density.rawTokens`                                                                                               |      3,000 |
| Dead-scope share        | Sum measured `deadScope.tokens / (density.rawTokens * measured profile count)`                                                                                 |      6,000 |
| Amplification overhead  | For the maximum complete profile p95 `a`, `max(0, a - 10,000) / a`                                                                                             |      4,000 |
| Density shortfall       | `max(0, 2,000,000 - density.actionablePerThousandBasisPoints) / 2,000,000`                                                                                     |     10,000 |
| Divergence rate         | `divergence.divergentPairTargetCount / divergence.observedPairTargetCount`                                                                                     |     10,000 |

Zero raw/effective tokens produce zero duplicate, broad-scope, dead-scope, or density-shortfall
input only when the corresponding G05 state is complete/empty. No applicable complete amplification
target and no expected profile pair are likewise neutral `0`, not missing evidence. A non-exhaustive
dead-scope profile, partial broad-scope/amplification/density/divergence evidence, a missing
expected comparison, or a distribution without a complete target is unknown. Cross-profile
`indeterminatePairTargetCount > 0` is unknown even if some pairs are divergent.

The always-on subtotal is copied from each revalidated G03 `totals.always` into the additive G04
`0.2.0` target observation carried by G05 `0.2.0`; it is not recomputed from path names or client
assumptions.

## Version 1 curves

Each row lists `(input bp → penalty bp)` points. Between points, use the exact interpolation above.

| Curve ID                                      | Points                                                      |
| --------------------------------------------- | ----------------------------------------------------------- |
| `efficiency:budget-utilization:v1`            | `0→0`, `10000→0`, `12500→2500`, `15000→6000`, `20000→10000` |
| `efficiency:broad-scope-token-share:v1`       | `0→0`, `2500→0`, `5000→2000`, `7500→6000`, `10000→10000`    |
| `efficiency:exact-duplicate-token-share:v1`   | `0→0`, `500→0`, `1500→5000`, `3000→10000`                   |
| `efficiency:near-duplicate-token-share:v1`    | `0→0`, `1000→0`, `2500→4000`, `5000→10000`                  |
| `efficiency:dead-scope-token-share:v1`        | `0→0`, `500→0`, `2000→4000`, `5000→10000`                   |
| `efficiency:import-amplification-overhead:v1` | `0→0`, `500→0`, `1500→3000`, `3000→7000`, `5000→10000`      |
| `efficiency:instruction-density-shortfall:v1` | `0→0`, `2500→0`, `5000→5000`, `7500→8000`, `10000→10000`    |
| `efficiency:cross-profile-divergence-rate:v1` | `0→0`, `1000→1000`, `2500→3500`, `5000→7000`, `10000→10000` |

`evaluateEfficiencyPenaltyCurve` defensively validates a closed curve before evaluation. Points must
be dense, contain 2–32 entries, start at `(0, 0)`, increase strictly by input, never decrease by
penalty, terminate at penalty 10,000, and remain inside the public bounds.

## Golden reconstruction

[`efficiency-score-specification.golden.json`](../../conformance/fixtures/v0/efficiency-score-specification.golden.json)
starts with the real, compiled G05 integration fixture, selects its complete Codex profile, records
all normalized inputs and curve penalties, then applies the formulas above. The result is exactly
`52 (F)`. Tests reconstruct the value from public G05 output and public G06 functions; the golden
does not contain hidden constants or source text.

Changing a point, allocation, normalization, rounding rule, component identity, default weight, or
grade interpretation requires a new score version and updated golden/schema/documentation evidence.
