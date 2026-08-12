# Profile limitations and surfaces

The linter parses repository syntax once and then evaluates it against a selected client profile and
surface. A profile result describes what the available evidence supports; it is not a promise that
an agent will follow the text. Select a surface when a client has more than one documented entry
point.

## Supported profile surfaces

| Profile              | CLI value             | Surface value                       | Repository-visible focus                                                                     | Important limitation                                                                                      |
| -------------------- | --------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Codex CLI            | `codex-cli`           | `codex-cli/local-cli-single-cwd`    | Root-to-working-directory `AGENTS.md` discovery, configured names, ordering, and byte limits | User/global context and launch configuration are outside a repository-only scan unless supplied.          |
| Claude Code          | `claude-code`         | `claude-code/local-session`         | `CLAUDE.md`, `.claude/` rules, imports, path activation, and launch/on-demand states         | Managed/user files, approvals, session events, and semantic precedence can remain unknown.                |
| GitHub Copilot CLI   | `copilot-cli`         | `copilot-cli/local-terminal`        | CLI custom-instruction locations, matching, and documented references                        | The profile does not infer hosted or editor behavior, and unsupported order/import details stay unknown.  |
| Copilot coding agent | `copilot-cloud-agent` | `copilot-cloud-agent/github-hosted` | Hosted repository instruction locations and documented `excludeAgent` behavior               | Branch lifecycle, organization policy, and model-selected relevance are not statically provable.          |
| Copilot code review  | `copilot-code-review` | `copilot-code-review/github-hosted` | Review-specific instruction locations, head-branch provenance, and exclusions                | Review triggers, nested-file behavior, and comment semantics are version-dependent or unknown.            |
| Copilot VS Code Chat | `copilot-vscode`      | `copilot-vscode/local-chat`         | Workspace instruction files, `applyTo`, settings, and optional references                    | Editor settings, multi-root ordering, description-based activation, and extension rollout may be unknown. |
| Gemini CLI           | `gemini-cli`          | `gemini-cli/local-terminal`         | `GEMINI.md` hierarchy, configured names, imports, and ignore facts                           | `/memory`, user settings, and just-in-time runtime events require supplied evidence.                      |
| Cursor Agent CLI     | `cursor-agent`        | `cursor-agent/cli`                  | MDC syntax, CLI rule locations, references, and documented activation modes                  | Model-selected activation and undocumented glob/nested-root behavior remain conditional.                  |
| Cursor IDE           | `cursor-agent`        | `cursor-agent/ide`                  | MDC syntax, IDE rule locations, and documented activation modes                              | UI/manual/model selection is not a deterministic repository fact.                                         |

Use the exact values from this table with `scan` or `explain`:

```sh
npx --no-install agent-context-lint scan . \
  --profile codex-cli --surface codex-cli/local-cli-single-cwd
npx --no-install agent-context-lint explain src/example.ts \
  --agent cursor-agent --surface cursor-agent/ide
```

An omitted surface uses the profile's default only where the command contract defines one. A
profile/surface mismatch fails before analysis rather than silently selecting another client.

## How to read limitations

- `included` and `excluded` are evidence-backed dispositions for the selected profile state.
- `conditional` means an external, dynamic, model-selected, UI-only, or otherwise missing fact is
  needed before activation can be decided.
- `unknown` preserves a documented gap or contradiction; it is not an empty result.
- `assembly.state: partial` or `unknown` means the linter cannot claim a byte-exact client context.

The linter does not read user or managed instruction files by default, contact client services, or
ask a model to resolve a conflict. A supplied event trace can add supported session evidence, but it
cannot authorize unsupported event kinds or turn an uncertain vendor behavior into a fact.

## Normative evidence

The versioned specifications contain the source URLs, retrieval dates, observations, truth tables,
and explicit unknowns:

- [Codex CLI](../profiles/codex-cli-agents.md)
- [Claude Code](../profiles/claude-code/compatibility.md)
- [GitHub Copilot surfaces](../profiles/copilot-surface-support.md)
- [Gemini CLI](../profiles/gemini-cli/compatibility.md)
- [Cursor](../profiles/cursor/compatibility.md)

When upstream documentation changes, update the relevant profile evidence and fixtures before
changing a deterministic result. A living vendor page is a review trigger, not proof that runtime
semantics changed.
