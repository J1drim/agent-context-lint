# Developing the target sampler

Use `classifyTargetSourcePath()` when a caller must prepare activation observations. Do not copy the
extension/basename table into a CLI or integration layer; E08 validates observations against this
same classifier and rejects non-source paths. Keep the public validation wrapper separate from the
private already-normalized classifier used by `sampleTargets`; this avoids repeating
canonicalization while retaining the per-path code-unit and aggregate byte ceilings.

E08 lives in `packages/resolver/src/target-sampler.ts`. It is a deterministic set-cover mechanism,
not a profile matcher and not a random sampler.

Preserve these ownership boundaries:

- C03 supplies path inventory certainty.
- C11 supplies workspace roots and language hints.
- E01/E02/profile adapters compute the three-valued activation observations.
- E08 groups complete state vectors and selects deterministic representatives.
- G04 aggregates completed per-target results into profile distributions.

Do not evaluate globs, resolve precedence, read repository files, or guess a missing activation
state here. Every recognized source path must have exactly one observation over the same rule-ID
universe. `indeterminate` is a real partition value, not `inactive`.

## Invariants

- Normalize all sets into B01 path order before grouping.
- Preserve every coverage stratum even when it is unavailable.
- Deduplicate selection paths while retaining all canonical reason strings.
- Treat several manifest families at one root as one workspace-root stratum.
- Keep workspace lookup logarithmic in path count; do not add workspace-by-file nested scans.
- Reject insufficient `maximumSamples`; never truncate the proof.
- Keep outputs immutable and independent of input order, locale, host filesystem, and wall-clock
  value when the deadline is not exceeded.
- Preserve same-process result issuance. E09 accepts the proof only through
  `isIssuedTargetSamplingResult`; clones and deserialized lookalikes must not authorize cache reuse.

## Verification

Run:

```sh
pnpm exec vitest run packages/resolver/test/target-sampler.unit.test.ts
pnpm coverage
pnpm check
```

Tests must retain hand-worked exhaustive and stratified fixtures, workspace/partition/language/
critical coverage, order permutations, unavailable evidence, fallback uncertainty, broad language
classification, malformed relationships, hostile JavaScript containers, hard limits, deadlines,
immutability, and repeated byte identity. Keep `packages/resolver/src/target-sampler.ts` in the
explicit Vitest coverage manifest.

The public definitions and partial-result semantics are in
[the target-sampling API contract](../api/target-sampling.md).
