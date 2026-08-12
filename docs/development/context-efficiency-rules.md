# Developing context-efficiency rules

F14 is the boundary between neutral G04–G08 analysis records and B04 diagnostics. Keep calculation
in the owning G package. A rule may select and explain issued evidence, but must not fill an
unknown, recount text, reinterpret a score curve, or invent a counterfactual.

## Evaluation sequence

1. Validate the closed options and input records without invoking accessors or proxy traps.
2. Validate B03 and require same-process G05, G07, and G08 authority.
3. Reconcile metric/configuration/specification hashes, score version, and tokenizer identity.
4. Bind every document contribution and recommendation evidence ID to an exact B03 source.
5. Evaluate complete evidence in rule-ID order and retain partial evidence as sorted uncertainty.
6. Build deterministic B04 diagnostics with fixed versioned fingerprints and no fix plans.
7. Parse B08 directives and associate them with the issued result for explicit finalization.

Repository order, discovery order, scenario order, and tokenizer-comparison order must not affect
serialized output. Use UTF-8 byte ordering and integer/bigint arithmetic already issued by G04–G08.

## Recommendation invariant

A G08 `recommended` state is necessary but not sufficient. F14 independently checks fixed
`qualityClaim: false` and `semanticQualityPreservationClaim: false` fields, complete before/after
measurements, positive reconciled savings, and the proof appropriate to the recommendation kind:

- scope narrowing requires at least one intended target with byte-identical assembly and ambiguity
  proof; saving targets deliberately remove context and are never described as retaining necessary
  content;
- exact consolidation requires evidence in at least two B03 format IDs and unique-content retention
  on every affected target. Profile count alone is not treated as proof of vendor-specific content.

Messages and suggestions must continue to deny semantic equivalence, target necessity, and task
quality preservation. ACL558 tells the user that a high-impact static projection needs an opt-in
empirical task-quality test before any quality claim.

## Adding tests

Each rule needs a positive, negative, exact-threshold boundary, malformed/forged authority,
suppression, and formatter path. The labeled corpus has positive and negative labels for all nine
IDs. Integration goldens should retain numeric component values and affected profiles/targets so a
message cannot drift away from its evidence. Coverage for this module must remain at least 90%
statements and 85% branches.

Run the focused F14 unit/integration suite, forced efficiency/rules build, test typecheck, rule-doc
generator/check, affected formatter tests, ESLint/Prettier, boundaries, security validation, and
rules/CLI package inspections before integration. The integration owner runs the serialized full
gate.
