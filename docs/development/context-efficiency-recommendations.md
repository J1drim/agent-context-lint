# Developing context-efficiency recommendations

G08 is the verification and derivation layer between static metrics/scoring and the later G09
reporting command. The orchestration layer builds an alternative repository snapshot in memory, runs
the normal D-series profile and E04 import machinery on that snapshot, then supplies the issued
baseline and counterfactual resolver inputs. G08 never receives a filesystem writer and never edits
the repository.

This scenario-construction boundary is intentional. E05 accepts branded D-series/E04 results, so a
caller cannot forge an effective-context graph. G08 reruns E05 rather than trusting precomputed
before/after output. The later scan/efficiency orchestrator is responsible for constructing the
hypothetical snapshot from deterministic transformations and for mapping natural workspace/scope
boundaries to the complete target-pair universe. G08 derives `intended`, `saving`, and `affected`
roles from the measured E05 projections; the orchestrator must not treat user prose as proof.

## Evaluation pipeline

1. Validate a closed, bounded input and same-process G05/G07 authority.
2. Bind G07's metrics digest and tokenizer to the supplied G05 report.
3. Match the scenario kind and document set to G05 broad-scope or exact-duplicate evidence.
4. Derive the complete affected target set from G05 amplification contributions.
5. Rerun E05 for every baseline and counterfactual pair.
6. Require exact profile, surface, client, spec, and target identity across each pair.
7. Count effective documents with the same closed tokenizer provider used by G05 and reconcile every
   baseline count to the G05 distribution.
8. Detect unrelated document changes, prove intended-target retention, compute integer token savings
   and basis points, then derive state, confidence, and fixed caveats.
9. Sort and deeply freeze the result.

The implementation deliberately does not accept a recommendation kind, labels, descriptions,
savings, confidence, affected paths, compatibility prose, executable callbacks, commands, paths to
executables, URLs, or mutation capabilities. G09 may render fixed product wording from the closed
codes.

## Adding recommendation kinds

Do not add a kind until a deterministic metric family identifies its evidence and a mechanical E05
counterfactual proves the relevant retention invariant. Update the TypeScript union, evidence
validator, JSON schema, positive/negative/boundary/security tests, golden, and all four
documentation surfaces together. Near-duplicate or subjective prose compression cannot be promoted
to exact consolidation; similarity is not semantic equivalence.

Focused tests live in `packages/efficiency/test/context-efficiency-recommendations.unit.test.ts`;
built-boundary coverage is in `tests/context-efficiency-recommendations.integration.test.ts`; the
deterministic projection is
`conformance/fixtures/v0/context-efficiency-recommendations.golden.json`.
