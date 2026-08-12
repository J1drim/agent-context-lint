# Command-line contract

The `@agent-context/lint` package installs the `agent-context-lint` executable. The I01 command
router establishes a deterministic, closed command grammar and process boundary. I03 installs the
repository `list`, `explain`, `rules`, and `init` handlers. I02 installs the complete offline `scan`
handler over F15. G09 installs the offline `efficiency` report handler. The H06/H08/H09 `standards`
handler provides offline status and explicit check/update operations; registry access remains
default-deny until a reviewed origin is configured.

I14 exposes the router's immutable command/option registry as the only source for the generated
[command reference](./command-reference.md), Bash/Zsh/Fish completions, manual page, and packaged
machine reference. The latter embeds the B06 configuration schema and complete B09 rule metadata;
its outer schema is `packages/cli/schemas/agent-context-lint-reference.v1.schema.json`.

## Available behavior

```text
agent-context-lint
agent-context-lint --help
agent-context-lint -h
agent-context-lint --version
agent-context-lint -V
agent-context-lint <command> --help
agent-context-lint scan [repository] --fix-dry-run
agent-context-lint scan [repository] --changed --base <ref>
agent-context-lint list [repository] [--format terminal|json]
agent-context-lint explain <target> [--agent <profile>] [--surface <surface>] [--trace <file>] [--format terminal|json]
agent-context-lint rules [--format terminal|json]
agent-context-lint init [repository]
agent-context-lint standards status [--format terminal|json]
agent-context-lint standards check [--format terminal|json]
agent-context-lint standards update [--format terminal|json] [--dry-run] [--cache <directory>]
```

An empty invocation is equivalent to `--help`. Help and version are stable text outputs and do not
inspect the working directory, environment, network, or repository. Unknown commands, unknown
options, and invalid command arity fail without echoing the rejected value.

## Registered product commands

| Grammar                                                      | Purpose                                          | I01 status and owner |
| ------------------------------------------------------------ | ------------------------------------------------ | -------------------- |
| `scan [repository] [--fix-dry-run] [--changed --base <ref>]` | Lint repository agent instruction files          | Available; I02/I07   |
| `list [repository]`                                          | List discovered instruction surfaces             | Available; I03       |
| `explain <target>`                                           | Explain effective instructions for a target path | Available; I03       |
| `rules`                                                      | List installed lint rules                        | Available; I03       |
| `init [repository]`                                          | Create starter configuration                     | Available; I03       |
| `standards status`                                           | Report bundled/locked standards freshness        | Available; H06/I CLI |
| `standards check`                                            | Acquire and verify signed standards metadata     | Available; H08/I CLI |
| `standards update`                                           | Preview or activate a verified standards update  | Available; H09/I CLI |
| `efficiency [repository]`                                    | Report instruction-context efficiency            | Available; G09       |

`scan --fix-dry-run` reaches the installed scan handler as `fixDryRun: true`, is never counted as
the optional repository operand, and performs no mutation. It previews only plans issued by the
complete unfiltered syntax evaluation and the I12/I11 safety pipeline. JSON and SARIF are rejected
with this option because a review patch is a terminal artifact rather than a diagnostic envelope.
`--changed` and `--base <ref>` are an inseparable, non-repeatable pair. They initialize the bounded
Git metadata executor only for that explicit invocation; default scans retain zero process
authority. Unsafe or unstable metadata falls back to complete output with a fixed stderr reason.

The executable loads only the selected command handler. Root help therefore reports handlers as
unavailable until they are selected, while `<command> --help` imports that command and reports its
actual availability. A lazy composition failure remains an operational failure; a placeholder never
implies that repository discovery, parsing, linting, or fixes occurred. `standards check` and
write-capable `standards update` are the only commands that may enter the explicit standards
network/cache path; all other commands remain offline and read-only.

## Standards commands

`standards status` is deterministic and offline. It verifies the package-bundled signed knowledge
pack and, when present, reads the configured repository lockfile through the bounded read-only
repository facade. It reports activation, selected channel, freshness, age, and typed issues; it
never claims that an unavailable remote registry was checked. Use `--format json` for automation.

`standards check` runs the H08 signed acquisition boundary only when explicitly requested. The
release currently ships with an empty registry allowlist, so the command returns exit `2` with a
sanitized `registry-unconfigured` issue before DNS or HTTP. A future reviewed registry configuration
will remain bounded by the H07 transport and H02 TUF verification contracts.

`standards update` requires an existing canonical lockfile. `--dry-run` performs H08/H09 validation
and prints a reviewable plan without opening a cache or writer. Activation requires an explicit,
absolute private cache root via `--cache`; the path cannot be the repository, its descendant, or a
filesystem root. `--dry-run` and `--cache` are mutually exclusive. Activation stores verified
content in the cache before one I10 compare-and-swap lock replacement. No command creates an initial
lockfile or writes an upstream repository.

## I03 command behavior

`scan` selects the repository through C01 and reads it only through C02. It resolves configuration,
tracked-file evidence, ignores, syntax adapters, import graphs, profile contexts, activation-aware
E08 target samples, occurrence token accounting, all applicable F15 rule families, suppressions, and
the native stylish, JSON, or SARIF formatter. `--rule`, `--severity`, `--fail-on`, `--profile`, and
`--surface` are closed repeatable selectors; a severity override cannot re-enable a rule outside an
explicit rule selection. The default failure threshold is `error`.

The normal path has no network, subprocess, repository-write, model, or repository-command
capability. A repository with no instruction documents receives an issued zero-document partial
accounting for each sampled profile target, so context-efficiency evidence stays honest without
inventing instructions or import diagnostics. See the [scan guide](../user/scanning.md) and
[development boundary](../development/scan-command.md).

`list` selects the nearest repository when no operand is supplied and treats an operand as an
explicit repository root. It resolves repository configuration, enumerates and ignores paths through
the bounded read-only evidence layer, runs every enabled GA profile/surface, and projects the issued
results through D14. A row is one path/profile/surface decision. Terminal rows and JSON entries use
deterministic UTF-8 ordering.

`explain` selects the nearest repository around the process working directory. The target and an
optional trace file must remain inside that repository. `--agent` accepts exactly `claude-code`,
`codex-cli`, `copilot-cli`, `copilot-cloud-agent`, `copilot-code-review`, `copilot-vscode`,
`cursor-agent`, or `gemini-cli`; the default is `codex-cli`. Cursor defaults to its IDE surface and
accepts exact `--surface cursor-agent/ide` or `--surface cursor-agent/cli` selection only when
`--agent cursor-agent` is present. Disabled surfaces fail instead of falling back. The command
normalizes a supplied E03 trace before profile resolution, maps only profile-supported, known trace
events into the Claude, Gemini, or Cursor state machine, and then passes that same trace identity
through E04, E05, and E06. A trace is parsed from a root-jailed read of at most 4 MiB, must contain
the explained target, and must have a known launch event. Unsupported or uncertain events never
become definite activation facts; a relevant supported event whose state is uncertain fails closed,
while an event outside the selected profile's vocabulary remains non-authoritative.

For profiles with documented reference/import syntax, `explain` loads each profile document through
the bounded C10 root-jailed graph loader and supplies same-process E04 DAGs to E05. The JSON and
terminal projections therefore include repeated, rejected, cyclic, unavailable, and limit-exceeded
occurrences rather than silently treating the entry document as import-free. Copilot surfaces that
do not establish CLI reference semantics do not inherit them.

`rules` renders the complete, immutable B09 registry with all 69 entries. Terminal output shows
identity, default severity, category, precision, fix safety, and description. JSON retains the full
metadata record.

`init` exclusively creates `.agent-context-lint.yml` at the selected root with mode `0644`, flushes
its contents, and never opens an existing pathname for writing. Existing files, directories,
symbolic links, unsafe roots, and races fail with exit 2 and retain the existing object. The starter
is a valid minimal version-1 configuration; omitted values select documented defaults.

`list`, `explain`, and `rules` accept only `--format terminal` (the default) or `--format json`.
JSON envelopes self-identify with `contractVersion: "0.1.0"` and record kinds
`agent-context-instruction-list`, `agent-context-explanation`, and `agent-context-rule-list`.
Repository-controlled strings are sanitized and known secret shapes are redacted in both formats.

## Exit codes

|  Code | Meaning                                                                                                                        |
| ----: | ------------------------------------------------------------------------------------------------------------------------------ |
|   `0` | The command completed and no lint diagnostic met the configured failure threshold. Help and version also use this code.        |
|   `1` | A completed lint command found diagnostics at or above the configured failure threshold.                                       |
|   `2` | Usage or operational failure, including invalid arguments, unavailable commands, handler failures, and output-stream failures. |
| `130` | The command was interrupted by `SIGINT` (`128 + 2`).                                                                           |

The executable installs its `SIGINT` listener only while a command is running, aborts through one
`AbortController`, removes the listener in all completion paths, and assigns `process.exitCode`
after awaited output completes. It never calls `process.exit()`. The first and subsequent `SIGINT`
notifications during that interval are idempotent and produce exit `130`. Node replaces its default
signal exit behavior when an application installs a listener, so the executable preserves the
conventional `128 + signal number` result explicitly. Source: Node.js
[`process` signal events](https://nodejs.org/api/process.html#signal-events), retrieved 2026-08-02
against the Node 24 documentation.

## Error and resource safety

The router accepts only dense, own-data-property argument arrays. It rejects proxies, accessors,
symbol properties, unknown invocation fields, C0/C1 controls, bidirectional text controls, unpaired
surrogates, more than 64 arguments, arguments larger than 4 KiB, and more than 64 KiB of aggregate
argument text. Repository-supplied values and thrown objects are never interpolated into errors.
Error records contain a closed code, category, fixed message, and retryability flag.

Output capabilities are injected and awaited. Each write is limited to 1 MiB and each stream to 64
MiB for one invocation. Complete `list`, `rules`, and `explain` documents are byte-preflighted
before their first write, split only between Unicode scalar values, and emitted through serial
awaited writes. Invalid Unicode and aggregate overflow therefore produce no partial standard output;
backpressure and cancellation stop later chunks. A callback error, emitted stream error, synchronous
write error, or broken pipe maps to exit `2` without exposing the thrown value. Aborted work maps to
`130` and does not print a second failure. The router races each awaited handler and output
operation against the intrinsic abort event, removes its listener after the race, and starts no new
output writes after abort. JavaScript cannot forcibly terminate an arbitrary promise: handlers and
output capabilities receive the signal and remain responsible for releasing resources owned by work
that was already in flight. The Node stream adapter removes its temporary error and abort listeners
when cancellation wins, but it cannot retract a write already submitted to the operating system.

## Embedding boundary

Importing `@agent-context/lint` is side-effect-free: it installs no signal handlers, performs no
I/O, and does not change process exit state. The command parser and process adapters are package
internals rather than public exports. E11's async `scanAgentContext` facade accepts a native
`AbortSignal` and an explicit same-process engine capability; only the executable entry owns OS
signals and `process.exitCode`.

The packed-package gate executes the extracted tarball with empty, help, version, unavailable, and
direct-shebang invocations. It also imports the extracted library under a process-state probe. These
checks prevent source-only tests from masking missing runtime files, broken executable permissions,
entry-point side effects, or a `--version` value that differs from the extracted package manifest.
