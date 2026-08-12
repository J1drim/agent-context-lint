# Context-efficiency recommendation API

G08 exports `projectContextEfficiencyRecommendations` from `@agent-context/efficiency`. It is an
asynchronous, deterministic projection over genuine same-process G05 metrics, their matching G07
score, and paired resolver inputs. It does not accept recommendation prose or claimed measurements.

## Contract

The input record kind is `agent-context-efficiency-recommendations-input`; the input and result
contract version is `0.1.0`. Each scenario contains only:

- a stable scenario ID;
- the G05 evidence ID and exact document IDs;
- baseline/counterfactual `ResolveEffectiveContextInput` pairs.

The function derives the recommendation kind, agents, profiles, surfaces, specification snapshots,
affected paths, evidence state, tokens, savings, confidence, caveats, retention, and recommendation
state. A scenario is not an authority claim. G08 matches its evidence to a supported G05 metric
family, requires the scenario to cover every affected sampled profile/target, reruns E05 for both
sides, and reconciles the baseline count to G05 before calculating a projection.

Target roles are derived: byte-identical pairs are `intended`, positive reductions are `saving`, and
other changes are `affected` and cannot satisfy a recommendation.

`recommendations` contains only evaluations whose state is `recommended`. `evaluations` also keeps
`not-recommended` and `indeterminate` candidates so uncertainty is not erased. Every evaluation has
`qualityClaim: false` and `semanticQualityPreservationClaim: false`.

`isIssuedContextEfficiencyRecommendations` is true only for an exact result minted by this module in
the current process. G09 reporting and F14 diagnostics require that authority marker; serialized
records and frozen clones remain valid interchange data but cannot authorize either consumer.

## Retention proofs

- An intended scope target requires byte-identical E05 assemblies and identical ambiguity IDs.
- Exact-duplicate consolidation requires every unique effective baseline content digest to remain.
- Missing text, imported occurrence content that cannot be reconstructed, partial assembly, a
  tokenizer fallback, or G05/count disagreement makes the projection indeterminate.
- Saving targets are deliberately not described as retaining necessary policy. The fixed
  `target-necessity-not-inferred` caveat says static evidence cannot decide whether removed content
  was useful for that target.

Counts use the exact tokenizer identity carried by G05. Both the estimate and optional exact
providers remain selected through the closed G01/G10 registry. The output carries full
profile/surface/client/spec, tokenizer, score-version, configuration, metric, and
score-specification identities, plus before/after assembly and content digests.

The JSON contract is
`@agent-context/efficiency/schemas/context-efficiency-recommendations.v1.schema.json`.

## Errors and cancellation

`ContextEfficiencyRecommendationsError` has stable codes for invalid input, invalid relationships,
resource limits, and cancellation. Inputs are closed, dense, bounded data records. Same-process G05
and G07 authority is mandatory. Resolver rejection is reported without reflecting repository text.
Pass an intrinsic `AbortSignal` as `{ signal }`; cancellation is checked before and after async
tokenizer work.
