# Developing context-efficiency metrics

G05 lives in `packages/efficiency/src/context-efficiency-metrics.ts`. It is a composition layer over
existing evidence contracts, not an alternate parser, resolver, sampler, tokenizer, or similarity
implementation.

## Pipeline ownership

Construct the input from source-backed pipeline artifacts:

1. Select one tokenizer identity and count each inventory document and F03 statement with it.
2. Supply the F03 statement inputs; G05 invokes `normalizeAndClassifyStatement` and feeds those real
   classifications to `buildDuplicationIndex`.
3. Supply each profile's E08 sample and matching G03 accountings. G05 invokes
   `aggregateProfileTargetDistribution` and reconciles occurrence document IDs to the inventory.
4. Supply E07 results built from the corresponding E05 effective contexts for common sampled
   targets. Same-process issuance is required.
5. Consume the immutable G05 report as evidence for later score and diagnostic layers. Do not
   relabel observations as semantic equivalence, necessity, quality, or client conformance.

The `@agent-context/efficiency` package therefore has an explicit dependency on
`@agent-context/evidence`; the package-boundary checker records that dependency. Resolver remains a
type/runtime dependency for E08 and E07, while core owns canonical paths and IR identities.

## Reconciliation invariants

- One document ID maps to one path and one path maps to one document ID.
- All token counts match the envelope's tokenizer ID, tokenizer version, measurement kind, and
  tokenizer contract version.
- Every F03 statement document/source relationship and source range remains intact.
- Every G03 target path exactly matches the E08 selection, and every occurrence names an inventory
  document.
- Every E07 profile identity and target maps to the G04 profile intersection exactly once.
- Exact and near duplication evidence is rebuilt through F04; callers cannot inject clusters.
- Unknown or partial upstream evidence remains unknown or partial downstream.
- All ratios use integer arithmetic; no locale, floating percentile, clock, random source, or host
  ordering may affect output.
- Every published metric retains its document/path/token contribution, plus statement/source range
  evidence when the metric is statement-derived.

Changing any formula, near-duplicate reconciliation rule, percentile convention, state transition,
or evidence shape requires a contract-version review and updated golden evidence.

## Tests

Run the focused unit and real-composition integration suites:

```sh
pnpm exec vitest run packages/efficiency/test/context-efficiency-metrics.unit.test.ts
pnpm exec vitest run tests/context-efficiency-metrics.integration.test.ts
pnpm coverage
pnpm check
```

The unit suite covers positive, negative, boundary, malformed, hostile-container, partial,
zero-token, missing-comparison, tokenizer-mismatch, resource-limit, deterministic-order, and
immutability behavior. The integration suite constructs real Codex and Gemini profile evidence
through E05/E07 plus E08, G03/G04, F03, and F04, then compares the explanatory projection against
`conformance/fixtures/v0/context-efficiency-metrics.golden.json`.

Source-only success is insufficient when G05 becomes visible through the CLI. That later integration
must also test the packaged command and stable JSON output. The public formulas and uncertainty
rules are in [Context-efficiency metrics](../api/context-efficiency-metrics.md); security controls
are in [Context-efficiency metrics security boundary](../security/context-efficiency-metrics.md).
