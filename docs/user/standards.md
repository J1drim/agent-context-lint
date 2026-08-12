# Standards knowledge and updates

Normal scans use the authenticated standards pack bundled with the package. They do not contact a
registry, inspect a cache, or change a lockfile. The `standards` commands make freshness and update
operations explicit so a routine lint cannot acquire new data unexpectedly.

## Inspect the offline state

```sh
npx --no-install agent-context-lint standards status
npx --no-install agent-context-lint standards status --format json >standards-status.json
```

Status reports the bundled pack, any repository lockfile, recorded age, and explicit uncertainty. An
offline status is not a claim that a remote registry is current. Cached metadata remains
informational until a signed update path verifies it.

## Refresh the bundled rules

The package itself is the supported distribution channel for the bundled rules. To refresh rules
without configuring a registry, review and install a newer package version, then confirm the
installed pack:

```sh
npm outdated @agent-context/lint
export REVIEWED_LINT_VERSION='1.0.0' # replace with the exact reviewed release
npm install --save-dev "@agent-context/lint@${REVIEWED_LINT_VERSION}"
npx --no-install agent-context-lint rules
npx --no-install agent-context-lint standards status
```

Use the exact version selected during dependency review; do not use the floating `latest` tag.

`rules` lists the ACL rules shipped by the installed package; `standards status` reports the signed
pack version, digest, and activation state. The package upgrade replaces the authenticated bundled
pack; it does not modify repository files, contact a standards registry, or change a lockfile. Keep
the previous package version available if you need to reproduce an earlier scan. Do not download or
copy a JSON pack into the repository: unsigned or manually edited data is never accepted as active
standards.

There are two separate refresh layers. Upgrading the package is available today and refreshes the
bundled rules. The local weekly check below compares the six official documentation pages directly;
it does not require a registry or GitHub Actions. The packaged `standards check`/`standards update`
commands remain the signed TUF registry path and are intentionally unavailable until a release
registry is deployed.

## Request an explicit freshness check

```sh
npx --no-install agent-context-lint standards check --format json
```

`check` is the only command that may use the configured registry transport. This release keeps the
production registry origin unconfigured, so the command fails closed with a sanitized
`registry-unconfigured` result before network access. It never writes a lockfile or cache and never
includes response bodies, URLs, headers, or credentials in its output.

## Preview or activate an update

Preview an update without granting cache or writer capabilities:

```sh
npx --no-install agent-context-lint standards update --dry-run --format json
```

Activation is separate and requires an existing canonical lockfile plus an absolute private cache
directory outside the selected repository:

```sh
npx --no-install agent-context-lint standards update \
  --cache /private/var/cache/agent-context-lint --format json
```

The command validates the complete signed chain and candidate pack before one compare-and-swap
lockfile replacement. It never infers a cache path, creates an initial lockfile, or writes to an
upstream repository. `--dry-run` and `--cache` cannot be combined. Until a reviewed registry origin
is configured, both forms fail closed before acquisition or mutation.

## Local weekly standards check

Run this once to create a verified baseline outside the repository:

```sh
pnpm standards:weekly -- \
  --initialize \
  --acknowledge-network
```

Then run the same command once a week (for example from macOS `launchd`, Linux `cron`, or Windows
Task Scheduler):

```sh
pnpm standards:weekly -- \
  --acknowledge-network \
  --fail-on-change
```

For a simple Unix scheduler, run it from the checkout and append output to a local log (the state
directory remains outside the checkout):

```cron
0 9 * * 1 cd /absolute/path/to/agent-context-lint && /opt/homebrew/bin/pnpm standards:weekly -- --acknowledge-network --fail-on-change >> /absolute/path/to/agent-context-standards-weekly.log 2>&1
```

Use the absolute path to the pinned `pnpm` executable on your machine. A scheduled run only reports
that a change exists; it does not accept the change or edit the repository. Review the generated
artifacts and run `pnpm standards:weekly:accept` manually after deciding how the linter should
adapt.

The command fetches only the six exact HTTPS sources in `tools/standards/upstream-sources.v1.json`,
verifies bounded canonical snapshots, compares them with the retained baseline, and writes state
under the platform application-state directory. It never writes the repository, publishes a PR, or
changes linter rules. Exit code `0` means no change; exit code `10` means a source changed; any
other nonzero exit indicates an operational failure. Use `--format json` for a scheduler log.

When a change is detected, inspect the generated review directory shown in the output. The candidate
and review artifacts remain outside the repository. After human review and any corresponding rule or
fixture changes, explicitly promote the reviewed candidate:

```sh
pnpm standards:weekly:accept
```

Acceptance changes only the local baseline; it does not activate rules or modify the project.

For a one-off review with an explicit state location, use `--state-dir /absolute/path`. The state
directory must be outside the repository and is intentionally not committed.

## Manual standards evidence (advanced)

The lower-level capture and review commands remain available when you need portable evidence files
for a maintainer review. They require explicit network acknowledgement for capture and remain
offline during verification:

```sh
tmp="$(mktemp -d)"
pnpm standards:snapshot -- --output-dir "$tmp/candidate" --acknowledge-network
pnpm standards:snapshot:verify -- \
  --source "$tmp/candidate/upstream-source.v1.json" \
  --provenance "$tmp/candidate/upstream-provenance.v1.json"
```

For a change review, retain a previously reviewed baseline and run the deterministic H11 review:

```sh
pnpm standards:review -- \
  --baseline-source /private/path/baseline/upstream-source.v1.json \
  --baseline-provenance /private/path/baseline/upstream-provenance.v1.json \
  --candidate-source "$tmp/candidate/upstream-source.v1.json" \
  --candidate-provenance "$tmp/candidate/upstream-provenance.v1.json" \
  --output-dir /private/path/review
pnpm standards:review:verify -- \
  --baseline-source /private/path/baseline/upstream-source.v1.json \
  --baseline-provenance /private/path/baseline/upstream-provenance.v1.json \
  --candidate-source "$tmp/candidate/upstream-source.v1.json" \
  --candidate-provenance "$tmp/candidate/upstream-provenance.v1.json" \
  --review /private/path/review/upstream-review.v1.json \
  --scaffold /private/path/review/upstream-fixture-scaffold.v1.json \
  --markdown /private/path/review/upstream-review.v1.md
```

When the review reports a change, stage a bounded, local draft for human inspection. The command
does not open a pull request or contact GitHub:

```sh
pnpm exec node tools/standards/standards-update-proposal.mjs \
  --review /private/path/review/upstream-review.v1.json \
  --scaffold /private/path/review/upstream-fixture-scaffold.v1.json \
  --markdown /private/path/review/upstream-review.v1.md \
  --output-dir /private/path/review/proposal
```

The review remains a draft: it never interprets semantics, edits rules, publishes a pack, changes
TUF metadata, activates a lockfile, opens a pull request, or modifies an external repository. Human
review, synthetic regression fixtures, affected tests, and the normal local gate are required before
any accepted rule change is committed.

## Recovery and rollback

Do not hand-edit `agent-context-standards.lock.json` or delete the last known-good cache entry.
Activation and same-process rollback are covered by the
[standards update rollback runbook](../operations/standards-update-rollback.md). Trust-root
rotation, revocation, and registry incidents use the
[standards recovery runbook](../security/standards-recovery.md). The API-level invariants are
documented in [offline status](../api/offline-standards-status.md),
[standards check](../api/standards-check.md), [standards update](../api/standards-update.md), and
the [lockfile contract](../api/standards-lockfile.md).

When reporting a standards problem, retain only the bounded command record, pack/lock identities,
and sanitized issue code. Never paste credentials, remote response bodies, or private repository
content into an issue or support request.
