# Context-efficiency rule API

F14 exports `evaluateContextEfficiencyRules` and `finalizeContextEfficiencySuppressions` from
`@agent-context/rules`. The evaluator implements ACL550–ACL558 as a deterministic projection of
genuine G04–G08 evidence. It does not recalculate resolution, metrics, scores, or recommendations.

## Input and authority

The closed input kind is `agent-context-efficiency-rule-input`, contract version `0.1.0`. It
contains:

- a validated B03 instruction IR used only for byte-bound locations and B08 directives;
- a same-process G05 `ContextEfficiencyMetrics` record, including its G04 distributions;
- the matching same-process G07 score, including the immutable G06 specification;
- the matching same-process G08 recommendation report;
- zero or more bounded tokenizer comparisons, each containing two issued G07 scores and a B03 source
  anchor.

F14 recomputes the G05 JSON digest and requires it to match G07. G08's metric, configuration,
specification, score-version, and tokenizer identities must match G05/G07. Every referenced document
and path must resolve to the supplied B03 IR. A frozen clone is data, not authority.

`isIssuedContextEfficiencyRecommendations` is the G08 authority predicate. Only an object returned
by `projectContextEfficiencyRecommendations` in the same process satisfies it.

## Rule mapping

| Rule   | Required complete evidence                                  | Emission basis                                                                       |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ACL550 | G04 profile distribution and G06 always-on budget           | nearest-rank always-on p95 is over budget                                            |
| ACL551 | G04 profile distribution and G06 effective budget           | emitted effective p95 is over budget                                                 |
| ACL552 | complete G05 exact-duplicate cluster                        | redundant exact tokens meet the configured threshold                                 |
| ACL553 | recommended G08 scope projection                            | intended target has byte-identical assembly proof and saving targets are quantified  |
| ACL554 | complete G05 amplification target                           | effective/unique ratio is above both 1.0 and the configured threshold                |
| ACL555 | recommended multi-format G08 exact-consolidation projection | evidence spans vendor formats and every projection retains unique content identities |
| ACL556 | complete G05 document density                               | non-empty density is below the configured threshold                                  |
| ACL557 | two issued G07 scores                                       | G01 identities are incompatible                                                      |
| ACL558 | recommended G08 projection                                  | saving meets either high-impact threshold and remains explicitly unbenchmarked       |

ACL550/ACL551 are resolved profile-level checks. They never inspect raw B03 document length and
therefore do not reproduce F10 ACL350. ACL554 uses occurrence-aware resolved amplification and does
not reproduce F10's direct-document ACL355 calculation.

## Result

Success returns a B04 bundle, B03 sources, selected thresholds, deterministic counts, and sorted
uncertainties. Diagnostics carry affected profile IDs in both fingerprint bases; target paths,
component values, token values, score version, and projection proof are bound through fingerprint
components and repository-fact evidence. Suggested actions are review-only and contain no fix plan.

`finalizeContextEfficiencySuppressions` accepts only the exact issued evaluation object and applies
only the B08 directives parsed during evaluation. It returns visible and suppressed diagnostics;
forged evaluations fail closed.

## Thresholds

Defaults are 128 exact-duplicate tokens, 15,000 amplification basis points, 1,000,000 density basis
points, and a high-impact reduction of either 512 tokens or 2,000 basis points. Options are sparse
closed own-data records. Values must be safe integers from 1 through 1,000,000,000. F14 does not
override G06 budgets; those remain part of the authenticated score configuration.
