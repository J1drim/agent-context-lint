# Copilot surface profiles

`@agent-context/profiles` defines four separate D08 descriptors and `@agent-context/resolver`
resolves explicit repository candidates against one of them:

| Profile               | Surface                    | Release treatment        |
| --------------------- | -------------------------- | ------------------------ |
| `copilot-cli`         | local terminal CLI         | GA-required              |
| `copilot-vscode`      | local VS Code Chat         | GA-required              |
| `copilot-cloud-agent` | GitHub-hosted coding agent | recognized evidence only |
| `copilot-code-review` | GitHub-hosted code review  | recognized evidence only |

The catalog is immutable and versioned by `COPILOT_PROFILE_CONTRACT_VERSION`. Every format claim
records support, activation mechanism, reference behavior, glob-dialect ownership, uncertainty, and
evidence references. It deliberately has no generic `copilot` fallback. Behavior from one surface is
never copied to another.

## Resolver contract

`resolveCopilotProfile` is a pure resolver over explicit byte and runtime snapshots. Callers supply
canonical repository-relative candidates, bounded target paths, and the selected surface's runtime
state. The runtime kind must equal the selected profile ID. The resolver does not inspect the
filesystem, environment, process, clock, client, account, model, or network.

Each candidate result separates:

- `discovery`: `documented`, `not-discovered`, or `unknown`;
- `eligibility`: `allowed`, `denied`, or `indeterminate`;
- `activation`: `active`, `inactive`, or `indeterminate`;
- syntax from D07, exact scope root when established, and per-target decisions.

`analysisStatus: partial` means at least one candidate retains an indeterminate state. Unknown
events, settings, discovery order, glob bases, and contradictory documentation stay indeterminate;
they are never collapsed to inactive or active.

## Surface boundaries

- CLI discovery uses only caller-declared standard locations. Path-specific files are not searched
  at intermediate-directory locations. Explicit session disables apply only to CLI.
- VS Code discovery uses explicit workspace roots and instruction folders. Its documented
  workspace-root glob base is resolved through E02. A description-only path instruction remains
  contradictory unless manually attached.
- Hosted profiles recognize repository-root instruction locations only. `excludeAgent` disables a
  path instruction only for the named hosted surface. Code review has its own explicit custom-
  instructions setting.
- CLI and hosted path glob bases that official documentation does not define remain indeterminate.
  The resolver does not select a convenient common base.

The resolver handles the D07 repository-wide and path-specific Copilot formats. Other catalog
claims, including `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`, are profile evidence for their owning
syntax/resolver implementations; D08 does not reinterpret those files as Copilot syntax.

## Validation and limits

Inputs are closed plain-data records with canonical dense arrays, canonical `Uint8Array` content,
unique identities, and repository-relative paths. Proxies, accessors, inherited records, Buffers,
extra properties, mismatched runtime/profile pairs, invalid enum values, and duplicate entries are
rejected with `COPILOT_PROFILE_INVALID_INPUT`. Per-item and aggregate path/content limits fail with
`COPILOT_PROFILE_RESOURCE_LIMIT` before unbounded parsing.

The resolver sorts copied snapshots and freezes outputs, so equivalent inputs produce stable results
without mutating caller-owned bytes.

## Evidence and conformance

The behavior snapshot was retrieved 2026-08-02 from primary documentation:

- [GitHub Copilot CLI custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [GitHub-hosted repository instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)
- [GitHub Copilot custom-instruction support](https://docs.github.com/en/copilot/reference/custom-instructions-support)
- [VS Code custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions)

Living documentation is recorded as unpinned evidence, not as a client-version observation. The full
source ledger and unresolved gaps are in
[Copilot surface support](../profiles/copilot-surface-support.md). The versioned
`copilot-vscode-description-ambiguity` fixture proves that the description-only contradiction
survives end-to-end resolution.
