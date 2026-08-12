# Developing canonical-policy synchronization

The implementation is in `packages/resolver/src/canonical-policy-sync.ts`. Resolver owns this
composition because its allowed dependencies already include evidence, profiles, and syntax.
Evidence remains the generic I10/I11 authority and has no upward dependency on profile behavior.

## Pipeline

1. Snapshot and close-validate the request, native `AbortSignal`, canonical source, target list,
   bounds, and monotonic deadline.
2. Parse the canonical source through D03's actual AGENTS Markdown parser.
3. Select one non-duplicating vendor destination for each family and attach the immutable D
   profile/surface/spec/evidence identity.
4. Render a deterministic wrapper without altering canonical body text.
5. Parse the emitted bytes through the real Claude, Copilot, Gemini, or Cursor syntax adapter.
6. Reject profile-specific imports/references and canonical constructs with target-dependent
   meaning.
7. Probe the real D05/D08/D10/D13 resolver for an in-scope target and, for a nested policy, an
   out-of-scope target. Emission requires exact target-set parity.
8. Compare `prior base`, `current`, and `generated`. Any hand edit, missing tracked target,
   malformed base/header, untracked existing target, or uncertain merge produces a refusal with no
   patch authority.
9. Ask I11 to produce the stable patch. Keep its capability in a private `WeakMap`; serialized
   output is never application authority.
10. Apply only one exact clean existing-file target through the same I11 pipeline. I11/C02/I10
    revalidate bytes, digest, inode/device, root, parents, file type, link count, and source
    identity immediately before the atomic replacement.

The internal `ACL254` diagnostic exists only to compose this private I11 transaction. It is not
registered as I12 generic fix eligibility, is not emitted to the ordinary diagnostics stream, and
must never make generic `--fix` eligible. The synchronizer's private, same-instance, one-use
`WeakMap` authority is the only bridge to `apply()`.

The implementation deliberately does not invoke Git merge machinery. The three-way nomenclature
follows Git's current/base/other model, but the safety policy is stricter: only `current === base`
can accept a changed generated version. Git documents that ordinary three-way merging combines both
sides and reports overlapping changed segments as conflicts; I13 refuses all local changes because
proving prose intent is outside a deterministic mechanical fix. See the official
[git-merge-file documentation](https://git-scm.com/docs/git-merge-file), retrieved 2026-08-03.

## Tests

The focused suite covers root and nested targets, parser and resolver parity, profile identity,
deterministic goldens, closed-schema validation, creation non-applicability, clean atomic
replacement, idempotence, hand edits, malformed and missing bases, untracked files, concurrent
mutation, symlinks, hard links, non-files, traversal attempts, hostile containers, cancellation,
deadlines, resource ceilings, and generated-case stability.

When a vendor profile changes, update its D-stream fixture first. I13 must consume the reviewed
profile identity and will refuse generation until the new resolver proves the same target set.
