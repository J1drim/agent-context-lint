# Context-efficiency score calculation

`calculateContextEfficiencyScore(metrics, efficiencyConfiguration?)` in `@agent-context/efficiency`
turns a same-process G05 metric record into the six G06 component scores, the configured aggregate
score, and its grade. The result record kind is `agent-context-efficiency-score`, contract `0.1.0`;
its closed schema is
[`context-efficiency-score.v1.schema.json`](../../packages/efficiency/schemas/context-efficiency-score.v1.schema.json).

The calculator performs no I/O and accepts only a record issued by `analyzeContextEfficiencyMetrics`
in the current process. The optional second argument is the sparse B06 `efficiency` configuration
object. It is validated by `createEfficiencyScoreSpecification`, so the calculated result and the
emitted formula cannot disagree.

## Result states

| `state`       | `score` and `grade` | Meaning                                                                                                                                                    |
| ------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`    | present             | All weighted inputs use complete exhaustive evidence and an exact tokenizer.                                                                               |
| `caveated`    | present             | The arithmetic is valid, but the report identifies an estimated tokenizer, stratified sample, or unavailable zero-weight component.                        |
| `unavailable` | `null`              | At least one required input of a nonzero-weight component is partial, unknown, empty where a target observation is required, unobserved, or indeterminate. |

`confidence` mirrors those states as `complete-static-evidence`, `limited-static-evidence`, or
`unavailable`. Confidence describes only the completeness of deterministic static evidence. Both
`qualityClaim` and `semanticQualityPreservationClaim` are always `false`.

## Components and inputs

Every component contains its configured `weight`, exact `scoreBasisPoints`, rounded display `score`,
state, and inputs. Every input retains:

- the G06 input ID, allocation, normalization ID, metric-source selector, and curve penalty;
- the aggregate numerator and denominator used to reconstruct `inputBasisPoints`;
- bounded document/profile/aggregate evidence references from G05;
- explicit uncertainty reason codes when the value is unavailable.

Evidence references keep token contributions separate from auxiliary numeric `value` fields. Every
auxiliary value declares `valueUnit` as `basis-points` or `count`; a missing auxiliary value has a
`null` unit, so observation counts cannot be mislabeled as percentages.

The input normalizations and curves are defined by the
[versioned score specification](efficiency-score-specification.md). Calculations use integer
`BigInt` intermediates and half-up rounding. An unavailable input has `null` numerator, denominator,
normalized value, and penalty; it is never replaced with zero. A complete empty metric family is
neutral only where G06 explicitly defines that behavior.

## Reproducibility identities

The result embeds the complete immutable G06 specification and normalized configuration. It also
emits SHA-256 identities for the G05 metrics, G06 specification, and effective score configuration.
Together with each input's evidence and arithmetic fields, these allow a consumer to reconstruct the
result without relying on hidden defaults. The tokenizer identity and score version remain part of
every record.

The hashes identify canonical engine-issued JSON records; they are reproducibility identifiers, not
signatures or trust assertions. Consumers must still obtain records through a trusted execution and
must validate persisted JSON against the public schemas.

`isIssuedContextEfficiencyScore(value)` identifies records issued in the current process. It exists
for trusted in-process pipeline stages such as G08; serialized or cloned records deliberately do not
retain that authority.

## Errors

`ContextEfficiencyScoreError` uses these stable codes:

- `CONTEXT_EFFICIENCY_SCORE_INVALID_METRICS` for a forged, cloned, cross-process, or unsupported G05
  value;
- `CONTEXT_EFFICIENCY_SCORE_RESOURCE_LIMIT` when bounded evidence or safe-integer arithmetic would
  be exceeded.

Invalid score configuration continues to use G06 `EfficiencyScoreSpecificationError` codes so the
source of the failure remains precise.
