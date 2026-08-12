# Scanning repositories

For a first installation and copy-paste workflow, start with the
[getting-started guide](getting-started.md).

The examples use `npx --no-install`, which only runs the already-installed project dependency. Use
`pnpm exec agent-context-lint` for a pnpm project; neither workflow requires GitHub Actions, a
GitHub token, or a paid CI service.

Run a complete offline scan from anywhere inside a repository:

```sh
npx --no-install agent-context-lint scan
npx --no-install agent-context-lint scan . --format json --fail-on warning
npx --no-install agent-context-lint scan . --profile claude-code --surface claude-code/local-session
npx --no-install agent-context-lint scan . --rule ACL150 --rule ACL152 --severity ACL150=warning
npx --no-install agent-context-lint scan . --changed --base origin/main
```

The default output is deterministic, color-free stylish text. `--format json` emits the versioned
diagnostic envelope and `--format sarif` emits SARIF 2.1.0. Exit `0` means the scan completed below
the threshold, exit `1` means a diagnostic met it, exit `2` is a usage or operational failure, and
exit `130` is cancellation. The default threshold is `error`; `--fail-on never` produces reports
without policy failure.

`--rule`, `--profile`, and `--surface` may be repeated. `--severity ACLNNN=error|warning|info|off`
may also be repeated, but it cannot select a rule omitted by an explicit `--rule` set. Profile and
surface selections must describe at least one valid pair. Unknown, duplicated, oversized, or
relationally empty selectors fail before repository analysis.

Use `--changed --base <ref>` together to render only findings proven relevant to the worktree diff
from the unique merge base. The scanner expands changed source files through their effective
instructions and imports, and expands changed instructions to every represented target that consumes
them. Syntax diagnostics remain visible. The base is resolved exactly; neither option is accepted
alone.

Changed mode is conservative. Configuration changes, structural changes, untracked files, ambiguous
or unavailable Git evidence, incomplete discovery/parsing/dependency scope, and repository changes
during the scan all produce a fixed fallback notice and the complete scan result. It never fetches a
missing object or executes repository hooks, helpers, filters, or commands. With `--fix-dry-run`, a
preview is limited to directly changed files even when unchanged dependencies remain visible.

The scanner follows recognized local imports only through the root-jailed read-only repository
facade. Path activation facts are evaluated over the exact E08 source-language universe before
sampling. Successfully loaded imports inherit the active entry context when the client profile
defines recursive loading; unresolved or incomplete import evidence remains unknown. Empty and
source-only repositories complete with exact zero accounting without inventing instruction documents
or findings. Selecting a profile also removes unrelated vendor documents and imports from the issued
rule input, so (for example) a Codex-only scan does not diagnose Claude imports.

Configuration limits and policy are active during scanning, including import depth/fan-out,
package-manager evidence, `ACL350.maxTokens`, efficiency thresholds, and the narrow absolute-path
and network-reference allowances. The `preview` standards channel remains fully offline and uses the
bundled stable evidence with preview policy enabled.

JSON is written incrementally with bounded chunks and backpressure. All formats enforce a 64 MiB
total-output ceiling before writing unbounded text; oversized reports fail operationally instead of
being truncated into invalid JSON or SARIF. When one profile has multiple selected surfaces, JSON
and SARIF publish a client version only if every surface agrees; otherwise `clientVersion` is
`null`.

Normal scans never connect to a network service, execute Git or another child process, load a model,
or modify repository files. `--fix-dry-run` is also read-only: it appends a deterministic review
patch only for a genuine approved mechanical fix and is available with stylish output.

For pull-request annotations, a repository may opt into the
[bundled GitHub Action](../../action/README.md) from its own workflow. This release repository does
not ship or run a hosted workflow; consumers choose their own triggers and permissions. The action
does not upload SARIF or require a write token, and the same deterministic scan can always be run
locally with the CLI.
