# Changesets

Every user-visible or publishable package change must include a Changeset. Run `pnpm changeset`,
select only affected public packages, and choose the smallest correct SemVer increment.
Documentation, tests, internal refactors, and CI-only changes that do not affect a published package
do not need one.

Summaries are release notes. Start each summary with exactly one conventional category followed by a
colon: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`. Use an imperative,
user-facing sentence and include a migration link for breaking changes. Do not include issue or
pull-request links that have not been verified.

Private workspace packages are never versioned or tagged. The optional tokenizer remains
deliberately outside the default workspace dependency graph and is not versioned by Changesets. The
public workspace packages are released together at `1.0.0`; subsequent changes use the smallest
correct SemVer increment. Release commands, review requirements, and rollback rules are documented
in [`docs/development/releasing.md`](../docs/development/releasing.md).
