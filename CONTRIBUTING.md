# Contributing

Thank you for improving Agent Context Linter. Contributions should preserve its normal-scan
guarantees: deterministic, offline, model-free, read-only, root jailed, and unable to execute
repository commands.

## Prepare a change

Use Node.js 24.18.1 and pnpm 11.18.0. Create a focused branch, install with
`pnpm install --frozen-lockfile`, and keep one bounded plan ticket per commit. Use imperative commit
subjects and explain behavior, tests, documentation, and important design decisions in the body.

Every behavior change needs positive, negative, boundary, malformed-input, and suppression tests
where applicable. Update the matching user, developer, rule, schema, security, or operations
documentation in the same change. Run focused tests while developing and
`pnpm verify:local -- --report local-gate-report.json` before requesting review. Install the
repository hook with `pnpm hooks:install`; it blocks pushes without a passing report for the exact
pushed commit and lockfile. Attach the report to the review, but do not commit it.

The repository intentionally contains no GitHub-hosted workflow. The local gate is the release
verification mechanism and is designed to run without paid CI minutes. The hook is opt-in per
checkout, so a reviewer must still require the report and reject `git push --no-verify`.

Add a Changeset for any user-visible or publishable-package change. See
[`.changeset/README.md`](.changeset/README.md) for SemVer and release-note rules. Internal-only
tests, docs, refactors, and CI changes do not require a Changeset; state that decision in the change
description.

Report vulnerabilities through [SECURITY.md](SECURITY.md), never in a public issue or fixture. Do
not commit credentials, private-repository content, or unredacted reports.

## Contribution license

Unless explicitly marked otherwise, an intentional contribution submitted for inclusion is provided
under the [Apache License 2.0](LICENSE), as described in section 5 of that license. No separate
contributor license agreement is required. Preserve applicable third-party notices and do not
relicense vendored or generated third-party material.
