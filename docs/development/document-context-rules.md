# Developing ACL350–ACL355

The F10 evaluator is intentionally a pure data transform. Keep repository discovery, filesystem
containment, import loading, effective profile resolution, and CLI scheduling outside
`packages/rules/src/document-context.ts`. This boundary is what makes the family safe to run on
untrusted repositories and keeps ACL350 separate from ACL550/ACL551.

## Pipeline and invariants

1. Validate the closed evaluator input and options without invoking accessors or proxy traps.
2. Validate the supplied graph with B03 before trusting any range, relationship, digest, or source
   text.
3. Re-run F03 normalization/classification from B03 statements; do not accept caller-selected
   semantic labels.
4. Build F04 from those normalized statements; do not accept caller-forged duplicate clusters.
5. Count source slices with G02; do not copy its byte/token formula into the rules package.
6. Evaluate only conservative documented predicates and retain non-qualifying/unknown cases.
7. Construct deterministic B04 evidence and fingerprints, sort findings, then validate the output
   against the exact B03 source registry.

The normal path must remain offline, model-free, read-only, environment-independent, and incapable
of running repository commands. Never add a callback/provider/module/path field to this evaluator.
Optional exact tokenizers belong to the G-stream provider boundary and require an explicit trusted
selection; F10 remains pinned to the built-in estimate for reproducibility.

## Adding or changing a detector

Detection changes are public behavior. Update the rule catalog metadata only after adding a
positive, negative, exact-boundary, malformed/hostile-input, targeted-suppression, and formatter
case. For text heuristics, prefer a closed high-confidence vocabulary or grammar. A larger recall
surface requires labeled calibration evidence; do not infer general instruction semantics from
keywords.

ACL354 must continue to consume an F04-produced cluster. ACL355 must continue to require explicit
provenance for every direct import occurrence and a target already in B03. If the desired behavior
needs a transitive import DAG, sampled targets, profile activation, p95 accounting, or
recommendation scoring, route it to E/G/F14 instead of broadening F10.

## Focused verification

Build dependencies before running integration tests because the packaged-export test imports the
rules package from `dist`:

```sh
pnpm build
pnpm exec vitest run packages/rules/test/document-context.unit.test.ts
pnpm exec vitest run tests/document-context-rules.integration.test.ts
pnpm exec eslint packages/rules/src/document-context.ts \
  packages/rules/test/document-context.unit.test.ts \
  tests/document-context-rules.integration.test.ts
pnpm rules:docs:check
pnpm boundaries
pnpm pack:check
```

Coverage must include `packages/rules/src/document-context.ts`. Review the branch report rather than
accepting a high aggregate percentage that hides an untested predicate. Determinism tests must
compare complete structured results after permuting caller-controlled import-resolution order.

Release calibration belongs to F16's adjudicated corpus and later real-repository trials. External
repositories remain read-only validation targets; reproduce any failure as a minimized synthetic
fixture in this repository.
