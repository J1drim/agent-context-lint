# Listing, explaining, rules, and initialization

The examples use the project-local npm executable without allowing an implicit download. Use
`pnpm exec agent-context-lint` in a pnpm project, or the shorter `agent-context-lint` form when the
binary is already on your `PATH`.

Use `agent-context-lint list` to see every discovered instruction file as each enabled client
surface interprets it. The state is important: `supported` means the supplied static profile events
load the file, while `conditional`, `recognized`, `ignored`, and `malformed` avoid overstating
vendor behavior.

```sh
npx --no-install agent-context-lint list
npx --no-install agent-context-lint list ../another-repository --format json
```

Use `explain` for a target inside the current repository. Codex CLI is the default profile; select
another profile explicitly when comparing clients. Cursor uses its IDE surface by default, or can
select the IDE and Agent CLI contracts exactly with `--surface`.

```sh
npx --no-install agent-context-lint explain src/api/users.ts
npx --no-install agent-context-lint explain src/api/users.ts --agent claude-code
npx --no-install agent-context-lint explain src/api/users.ts --agent gemini-cli --format json
npx --no-install agent-context-lint explain src/api/users.ts --agent cursor-agent --surface cursor-agent/cli
npx --no-install agent-context-lint explain src/api/users.ts --trace evidence/trace.json
```

Replace `src/api/users.ts` with a file that exists below the selected repository root. The command
does not infer a target from the filesystem and refuses absolute or outside-root paths.

Static output is a deterministic projection from repository evidence. It cannot prove dynamic,
model-selected, UI-only, external, or undocumented client state. These cases remain partial or
conditional. `--trace` accepts an E03 resolution-event trace inside the repository and uses its
known events while resolving Claude, Gemini, and Cursor before producing the explanation. The same
trace also binds the emitted import DAG and explanation identities. Reading a trace never executes
or observes a client. Unsupported event kinds remain non-authoritative, while a relevant supported
event with uncertain state fails closed instead of manufacturing definite activation.

Recognized imports and references appear as occurrence rows in the explanation. Loaded and repeated
content, root-boundary rejection, cycles, unavailable files, and resource-limit outcomes remain
distinct. Imported repository bytes are not added to terminal document text merely because C10
needed them to establish the graph.

`npx --no-install agent-context-lint rules` prints the installed registry. Use JSON when another
tool needs complete rationale, owner, precision, fix-safety, and documentation metadata.

`npx --no-install agent-context-lint init` creates a small, documented `.agent-context-lint.yml` in
the selected repository. It refuses to replace anything already at that path, including a symbolic
link or directory. Review the generated file and add only settings that differ from the defaults.

All four commands are offline and model-free. `list`, `explain`, and `rules` are read-only. `init`
has only the explicit exclusive-create capability for the one configuration filename.

The complete generated grammar is in the [command reference](../api/command-reference.md).
[Shell completion and manual-page setup](./shell-completion.md) and the
[machine-readable reference contract](./machine-reference.md) are version-matched to the installed
package.

## Efficiency

`agent-context-lint efficiency [repository]` presents the genuine G07 score and G08 recommendations
with per-profile token distributions. Use `--format json` for the closed machine contract, `--agent`
for one exact profile, `--compare <repository>` for a compatibility-checked comparison, and
`--no-color --width <40..240>` for terminal control. A valid report is informational and exits 0
even for an F grade. See [context-efficiency reports](./context-efficiency-reports.md) for the
identity, uncertainty, and static-only claim rules.
