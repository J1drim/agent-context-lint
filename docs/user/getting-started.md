# Getting started

Agent Context Linter checks repository-controlled instruction files used by coding agents. A normal
scan is deterministic, offline, model-free, and read-only: it does not run repository commands, load
dependencies from the repository, contact a network service, or write source files.

This page is a copy-and-run tour of the public CLI. The exact option grammar and exit-code contract
are maintained in the [command-line reference](../api/command-line.md); keep that page matched to
the CLI version you install.

The command blocks below use `npx --no-install`, so they never download a package while you are
following the guide. If you installed with pnpm, replace that prefix with `pnpm exec`; if the
executable is already on your `PATH`, the shorter `agent-context-lint` form is equivalent.

## Install

The published package requires Node.js `^24.11.0 || ^26.0.0`. From the repository you want to check,
install the CLI as a development dependency:

```sh
npm install --save-dev @agent-context/lint
npx --no-install agent-context-lint --version
```

`pnpm` projects can use their normal execution commands instead:

```sh
pnpm add --save-dev @agent-context/lint
pnpm exec agent-context-lint --version
```

If you are building a local checkout instead of installing the `1.0.0` release, use the pinned
development toolchain and build the workspace first:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/cli.js --version
node packages/cli/dist/cli.js scan .
```

The checkout workflow is described in [development setup](../development/getting-started.md).

## Run the first scan

Change to the repository root and run the default scan:

```sh
cd path/to/repository
npx --no-install agent-context-lint scan
```

The default terminal output is deterministic and color-free. To select a repository explicitly, pass
its path as the single operand:

```sh
npx --no-install agent-context-lint scan ./path/to/repository
```

To try the complete read-only path without guessing a source filename, create a tiny disposable
fixture and point every command at it:

```sh
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
lint_bin="$(pwd)/node_modules/@agent-context/lint/dist/cli.js"
mkdir -p "$fixture/src"
printf '%s\n' '# Local policy' 'Keep changes focused.' >"$fixture/AGENTS.md"
printf '%s\n' 'export const example = 1;' >"$fixture/src/example.ts"
(
  cd "$fixture"
  node "$lint_bin" scan . --format json --fail-on never >scan.json
  node "$lint_bin" list . --format json >list.json
  node "$lint_bin" explain src/example.ts --agent codex-cli --format json >explain.json
  node "$lint_bin" rules --format json >rules.json
  node "$lint_bin" standards status --format json >standards-status.json
)
```

The fixture is removed by the trap. `scan`, `list`, `explain`, `rules`, and `standards status` do
not modify it; keep `init` separate because that command intentionally creates a configuration file.

The exit status is useful in scripts and CI:

| Exit status | Meaning                                                                         |
| ----------: | ------------------------------------------------------------------------------- |
|         `0` | The command completed below the selected failure threshold.                     |
|         `1` | A completed scan found a diagnostic at or above the selected threshold.         |
|         `2` | Usage or operational failure, such as an invalid option or unavailable command. |
|       `130` | The command was interrupted by `SIGINT` (`Ctrl-C`).                             |

The default threshold is `error`. Use `--fail-on warning` to fail on warnings too, or
`--fail-on never` when collecting a report without making diagnostics fail the process:

```sh
npx --no-install agent-context-lint scan . --fail-on warning
npx --no-install agent-context-lint scan . --fail-on never
```

## See what an agent will use

`list` shows discovered instruction files and each enabled client surface's disposition:

```sh
npx --no-install agent-context-lint list .
npx --no-install agent-context-lint list . --format json >instruction-list.json
```

To explain the effective context for one file, replace `src/path/to/file.ts` with a path inside the
repository:

```sh
npx --no-install agent-context-lint explain src/path/to/file.ts --agent claude-code
npx --no-install agent-context-lint explain src/path/to/file.ts --agent gemini-cli --format json
npx --no-install agent-context-lint explain src/path/to/file.ts \
  --agent cursor-agent --surface cursor-agent/cli
```

Replace `src/path/to/file.ts` with a repository-relative file. The fixture above uses
`src/example.ts`; `explain` rejects absolute paths and targets outside the selected root.

An explanation distinguishes `included`, `excluded`, and `conditional` documents and records the
reason and provenance for each decision. Conditional and unknown behavior is kept visible when a
client's dynamic or undocumented state cannot be proven from local evidence. The target and any
trace supplied with `--trace` must remain inside the selected repository root.

`rules` prints the installed rule registry. JSON is useful when another tool needs rule metadata:

```sh
npx --no-install agent-context-lint rules
npx --no-install agent-context-lint rules --format json >rules.json
```

## Produce CI-friendly reports

Scan diagnostics can be written as the versioned JSON envelope or SARIF 2.1.0. The command still
returns the policy exit status described above, so a report can be saved even when findings are
present:

```sh
npx --no-install agent-context-lint scan . --format json >agent-context-report.json
npx --no-install agent-context-lint scan . --format sarif >agent-context-report.sarif
```

Use the [bundled GitHub Action](../../action/README.md) when annotations are useful. It requests
only read access, does not upload SARIF, and keeps the scanner's normal read-only boundary.

## Select profiles, rules, and changed files

Scan profile selection uses `--profile`; repeat it to compare more than one client. A surface is
selected only when the profile exposes that exact surface:

```sh
npx --no-install agent-context-lint scan . \
  --profile claude-code --surface claude-code/local-session
npx --no-install agent-context-lint scan . \
  --profile codex-cli --surface codex-cli/local-cli-single-cwd
```

Limit evaluation to specific registered rules or adjust a rule's severity:

```sh
npx --no-install agent-context-lint scan . --rule ACL150 --rule ACL152
npx --no-install agent-context-lint scan . --rule ACL150 --severity ACL150=warning
```

Changed mode is opt-in and requires an exact local Git base reference. It never fetches a missing
object or runs repository hooks, filters, or helpers. Replace `origin/main` with a commit or ref
that already exists in the checkout:

```sh
BASE_REF=origin/main
npx --no-install agent-context-lint scan . --changed --base "$BASE_REF"
```

If Git evidence is incomplete or the worktree changes during collection, the linter emits a fixed
fallback notice and returns the complete scan so that findings are not silently omitted.

## Preview a safe fix

The fix workflow is deliberately separate from normal scanning. `--fix-dry-run` produces a
deterministic review patch and does not modify the repository:

```sh
npx --no-install agent-context-lint scan . --fix-dry-run
```

The current automatic preview is limited to an exact inactive suppression comment proven safe by the
complete analysis (`ACL109`). No patch is applied by this command, and JSON/SARIF cannot be combined
with the review-patch output. Other recommendations remain review guidance.

## Add a repository configuration

Create a starter `.agent-context-lint.yml` only when the file does not already exist:

```sh
npx --no-install agent-context-lint init .
```

Review the generated file before changing policy. The command refuses to replace an existing file,
directory, or symbolic link. Configuration options and their defaults are described in the
[configuration reference](../api/configuration.md).

## Measure context efficiency

The `efficiency` command is informational: it reports measured token accounting and clearly labels
uncertainty or missing evidence. It remains offline and read-only, and an F grade does not fail the
process. Use JSON when another tool consumes the report:

```sh
npx --no-install agent-context-lint efficiency .
npx --no-install agent-context-lint efficiency . --format json >efficiency.json
```

Comparisons require a second repository and use only compatible tokenizer/profile evidence. They do
not claim that a smaller context preserves task quality. The release reports static evidence and
does not make task-quality or semantic-equivalence claims.

## Inspect standards knowledge (optional)

The CLI ships with a signed standards knowledge pack. Inspect the active pack without contacting the
network or writing the repository:

```sh
npx --no-install agent-context-lint standards status
npx --no-install agent-context-lint standards status --format json >standards-status.json
```

`status` reports the bundled version, digest, freshness, and any repository lockfile that is already
present. A normal `scan` never downloads standards or opens a cache. The signed `standards check`
command is an explicit registry acquisition request and currently fails closed with
`registry-unconfigured`. To check the six official documentation pages locally once a week, use the
maintainer command from the standards guide:

```sh
pnpm standards:weekly -- --acknowledge-network --fail-on-change
```

When a repository already has a canonical standards lockfile, preview an update without opening a
cache or changing files:

```sh
npx --no-install agent-context-lint standards update --dry-run --format json
```

Activation is deliberately more explicit: pass an absolute private cache directory with `--cache`.
The cache cannot be the repository, a repository descendant, or a filesystem root, and the command
performs one compare-and-swap lockfile replacement only after the signed content is verified. These
commands never write to an upstream GitHub repository. See
[standards check](../api/standards-check.md) and [standards update](../api/standards-update.md) for
the complete contract.

## Troubleshooting

**`agent-context-lint: command not found`** — confirm the package is installed in the current
project, then use `npx --no-install agent-context-lint ...` or `pnpm exec agent-context-lint ...`.
Check `node --version` against the package engine range.

**Exit status `1`** — this is a policy result, not a CLI crash. Inspect the terminal diagnostics,
save a JSON/SARIF report, or temporarily use `--fail-on never` while reviewing the findings.

**Exit status `2`** — run `npx --no-install agent-context-lint scan --help` and check option
spelling, operand count, profile/surface pairing, and output paths. Commands whose implementation is
not enabled in a particular build return an explicit unavailable-command failure; the status is
not a successful empty scan.

**Changed mode reports a fallback** — use `git status` to ensure the checkout is stable and pass a
local base ref that resolves without fetching. A fallback is conservative: it returns the complete
scan rather than pretending that the changed set is complete.

**`explain` rejects the target** — the target must be inside the selected repository root. Use a
repository-relative path and select a profile/surface pair listed by `agent-context-lint --help`.

**The fix preview is empty** — only explicitly approved, mechanical fixes are previewed. A normal
scan never edits files; apply a recommendation manually after reviewing its diagnostic and source
location.

**The report is unexpectedly large** — JSON and SARIF are bounded outputs. Narrow the rule/profile
selection, write to a file, or inspect the terminal result; an output-limit failure is reported as
operational rather than emitting a truncated document.

For deeper behavior and versioned contracts, continue with [Scanning repositories](scanning.md),
[Listing and explaining](commands.md), or the [API command reference](../api/command-reference.md).
