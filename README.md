# Agent Context Linter

Agent Context Linter is a deterministic, offline-first linter for repository instruction files used
by coding agents. It discovers instructions without executing repository commands, explains
effective context, and emits terminal, JSON, and SARIF diagnostics.

This repository contains the Agent Context Linter `1.0.0` release. The two public packages are
versioned together at `1.0.0`; internal workspace packages use the same release identity but are not
published independently.

## Quick start

The published CLI requires Node.js `^24.11.0 || ^26.0.0`. Install it in the repository you want to
check, then run a scan:

```console
npm install --save-dev @agent-context/lint
npx --no-install agent-context-lint scan
```

The [getting-started guide](docs/user/getting-started.md) includes copy-paste examples for
effective-context explanations, JSON/SARIF reports, changed-file scans, safe-fix previews, standards
status/check/update, exit codes, and troubleshooting. The
[user documentation index](docs/user/README.md) links the profile limitations, migration, CI,
standards, and efficiency guides. Normal scans are local, read-only, and do not require a GitHub
token.

## What it checks

The complete rule registry, grouped by category with severities and diagnostics, is maintained in
the [rule catalog](docs/rules/catalog.md). Use `agent-context-lint rules` to inspect the installed
registry from the command line.

## Local-first safety

The ordinary `scan`, `list`, `explain`, `rules`, and `efficiency` commands read the selected
repository through a bounded read-only facade. They are deterministic, model-free, offline, and do
not execute repository commands, child processes, hooks, or dependencies. `scan --fix-dry-run`
prints a review patch and does not edit files.

Two commands have deliberately explicit side effects: `init` creates one missing
`.agent-context-lint.yml`, while `standards check` and an activating `standards update` are the only
commands that may use the opt-in standards acquisition/cache path. No GitHub Actions workflow,
GitHub token, hosted dashboard, or paid CI service is required for local use. The optional action is
documented separately and requests read-only contents access.

## Development

The supported toolchain is Node.js 24.18.1 and pnpm 11.18.0. Install exactly the locked
dependencies, then run the complete gate:

```console
corepack pnpm install --frozen-lockfile
pnpm hooks:install
pnpm verify:local -- --report local-gate-report.json
```

The pre-push hook requires a passing report for the exact commit and lockfile; attach the report to
the review and never commit it. See [CONTRIBUTING.md](CONTRIBUTING.md) for change requirements and
[`docs/development/releasing.md`](docs/development/releasing.md) for release operations.

## Policies and help

- [Support](SUPPORT.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Contribution policy](CONTRIBUTING.md)

## License

Copyright 2026 Jakub Niezgoda. Licensed under the [Apache License 2.0](LICENSE). The license permits
commercial use, modification, and distribution without asking for permission or paying a fee,
subject to its terms. Project and optional commercial-support inquiries may be sent to
<jakub.niezgoda@areaautomation.com>; contacting or paying the project is not a condition of
exercising the Apache-2.0 license.

Dependencies and bundled assets retain their own licenses. The CLI distribution includes
`THIRD_PARTY_NOTICES` separately from the project's Apache `NOTICE`.
