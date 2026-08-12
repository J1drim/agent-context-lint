# Continuous integration

The release repository does not commit GitHub-hosted workflows. This avoids consuming private
repository Actions minutes and makes the release gate reproducible on a contributor's own machine.
The supported replacement is a checked-in pre-push hook plus an explicit, reviewable local report.

## Toolchain

Use Node.js `24.18.1` and pnpm `11.18.0`, then install the frozen dependency graph:

```sh
pnpm install --frozen-lockfile
pnpm hooks:install
```

The local gate runs the same `pnpm check` command used for release verification. That command covers
formatting, generated references, the bundled action, package boundaries, conformance, security and
license policy, deterministic tests, type checking, coverage, and clean package manifests.

## Required matrix

The local matrix has one required lane: the complete `pnpm check` command at the exact commit under
review. Focused unit, integration, type, security, and action checks are useful during development,
but they do not replace the complete gate and its report.

## Push evidence

Run the gate at the exact commit that will be pushed:

```sh
pnpm verify:local -- --report local-gate-report.json
git push
```

The command keeps an internal report at `.git/local-gate-result.json` and writes the requested copy.
The pre-push hook reads the internal report and fails unless it is successful for every non-delete
ref being pushed and its lockfile digest still matches. Re-run the gate after any commit or lockfile
change. Attach the report to the review; it is deliberately not a tracked project artifact.

The report contains no repository source, diagnostics, credentials, or command output. It records
only the gate version, commit, lockfile digest, Node/pnpm identities, command name, timestamps,
duration, exit code, and signal. A reviewer must reject `git push --no-verify` or a missing/stale
report. Hooks are local Git configuration and cannot be imposed by a remote repository, so this
human review step is intentional.

## What the local gate cannot claim

Local results do not emulate GitHub branch protection, hosted runner images, hosted caches, GitHub
annotations, or the permissions of a consumer's workflow. The reusable action remains available for
consumers who choose to run it in their own automation; its metadata and bundled artifact are
validated locally by `pnpm action:check` and the action test suite.

## Focused commands

Use focused checks while developing, then run the complete report before review:

```sh
pnpm test:unit
pnpm test:integration
pnpm typecheck
pnpm security:validate
pnpm action:check
pnpm verify:local -- --report local-gate-report.json
```

The local policy validator fails closed if a `.github/workflows` definition is reintroduced, if the
hook or package scripts drift, or if Dependabot is configured to update GitHub Actions again.
