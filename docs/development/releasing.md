# Release process

Releases are package-scoped, deterministic, and prepared with Changesets. The current product
release is `1.0.0`; A05 establishes versioning and changelog preparation; provenance, signing,
registry publication, and release automation remain separate gated work and must not be inferred
from this document.

The offline pre-publication integrity bundle is documented in
[`release-artifact-bundle.md`](release-artifact-bundle.md). It generates a deterministic manifest,
checksums, SPDX inventory/dependency artifact, release notes, and upgrade/rollback guide, then
verifies them without npm, Git, network access, credentials, or signing keys. A successful local
verification does not claim npm provenance, a signature, or a published release.

After two K10 bundles exist, the bounded local candidate/rollback rehearsal is documented in
[`release-soak-rehearsal.md`](release-soak-rehearsal.md). It is useful for detecting repeated CLI,
timeout, output, capability, and workspace-mutation failures, but it is not the seven-day K11 soak
or published-release acceptance evidence.

The K12/K13 offline evidence formatter is documented in
[`release-evidence.md`](release-evidence.md). It validates sanitized local smoke, rollback,
72-hour-review, and 30-day-retrospective records without publication, network access, credentials,
or external repository mutation. Its `preflight-ready` and `ready-for-human-review` assessments are
preparatory only; they do not satisfy the live publication, monitoring-duration, or maintainer
acceptance gates.

## Prepare

1. Require one valid Changeset for every user-visible package change. Summaries use `Added`,
   `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`.
2. Run `pnpm release:status` and review the public package set and bump levels.
3. Run `pnpm release:dry-run`. It versions a temporary, tracked-source copy and verifies package
   versions, changelogs, internal ranges, licensing, and that the checkout was not modified.
4. Run `pnpm check`, including actual tarball inspection. Review generated package changelogs and
   the repository `CHANGELOG.md`.
5. Run the strict [clean package-manager install matrix](package-install-matrix.md) for npm, pnpm,
   Yarn, and Bun using the exact release Node and pnpm launcher. Keep its JSON report and tarball
   digests with the `1.0.0` release evidence. Missing managers are an evidence gap, not a pass.

Private workspace packages are neither versioned nor tagged independently. The public packages and
their internal workspace companions carry the `1.0.0` release identity; later public releases follow
SemVer: patch for compatible fixes, minor for compatible functionality, and major for breaking
changes.

The optional exact-tokenizer package remains outside the default pnpm workspace so ordinary
development cannot discover it as an installed provider. It is packed and audited by
`pnpm pack:check`, but Changesets does not version or publish it. Any future tokenizer publication
needs its own reviewed release authorization while preserving that isolation boundary.

The root, every public manifest, and each internally packed artifact declare `Apache-2.0`.
Non-distributed private workspace manifests inherit the root license and REUSE file-level
annotation; they intentionally carry no npm publication metadata. This keeps package metadata scoped
to artifacts that can actually be packed or published.

## Apply and review

On a dedicated release branch, run `pnpm release:version`. Review every manifest, lockfile change,
and package changelog. The command does not commit. Re-run the full gate and inspect packed tarballs
for exact `LICENSE`, `NOTICE`, third-party notices, source maps, and manifest versions. A maintainer
creates the release commit only after those checks pass.

Do not publish manually from an unverified checkout. If version preparation is wrong, discard the
dedicated release branch before publication, correct the Changeset, and repeat. Published versions
are immutable: never overwrite or reuse one. Handle a bad published version with deprecation and a
forward fix, following the compatibility policy.

The configuration choices follow the official Changesets configuration and workflow documentation,
reviewed on 2026-08-09:

- <https://github.com/changesets/changesets/blob/main/docs/config-file-options.md>
- <https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md>
