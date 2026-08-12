# Developing cross-profile comparison

E07 lives in `packages/resolver/src/cross-profile-comparison.ts`. Its boundary is intentionally
after E05. Tests must construct real profile resolutions and pass them through
`resolveEffectiveContext`; adding a public unbranded comparison path would let callers replace
profile truth with invented generic semantics.

## Mechanical algorithm

1. Validate the closed descriptor-safe envelope and regular dense resolution array without invoking
   accessors.
2. Require same-process E05 issuance, a single exact target, distinct profile/surface contracts, and
   aggregate limits.
3. Project each result into a text-free path map, included set, total-order sequence when available,
   ambiguity identity list, and profile identity summary.
4. Sort profiles by their hashed identity and enumerate every pair in that order.
5. Compare scope over the union of recognized paths. Absence is authoritative only when E05 has no
   activation, target-scope, or partial-profile ambiguity.
6. Compare order over common included paths only. A linear rank scan finds the first inversion
   without quadratic path-pair expansion.
7. Compare content over common included paths using issued SHA-256 identities. A known digest
   mismatch proves divergence; incomplete or truncated evidence cannot prove equality.
8. Deep-freeze the output and mark it issued for downstream F12/G05 consumers.

The preflight pair-work bound is `(profileCount - 1) * aggregateDocumentCount`, equal to the number
of document visits across all pair unions up to a constant factor. Pair evidence has a separate hard
cap. Never replace either with an unbounded all-path inversion matrix.

## Required tests

Changes must cover:

- observational matches with `equivalenceClaim: false`;
- known scope/content divergence and digest-only evidence;
- conditional activation, incomplete absence, unavailable content, partial order, and no-common-path
  behavior;
- deterministic results under reversed input order and complete pair accounting;
- forged/cloned/duplicate/cross-target/sparse/extended/proxy/accessor inputs;
- resource boundaries, deep immutability, public exports, built-package integration, and a versioned
  golden; and
- focused statement and branch coverage at or above repository thresholds.

When a new profile adds a comparable surface, add a genuine profile fixture. Do not manufacture an
E05-shaped object merely to reach a comparison branch.
