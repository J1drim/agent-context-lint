# Copilot instruction syntax adapter

`parseCopilotInstructionSyntax` in `@agent-context/syntax` parses two inert document forms under
contract `0.1.0`:

- repository-wide Markdown such as `.github/copilot-instructions.md`;
- path-specific `*.instructions.md` with YAML frontmatter.

The adapter recognizes syntax only. D08 owns client discovery and activation for Copilot CLI and VS
Code, including client state. Hosted coding-agent and code-review profiles also decide whether
`excludeAgent` applies. D07 does not invent a universal Copilot precedence model.

Repository-wide files are plain Markdown. A leading `---` is treated as a thematic break, not as
path metadata; frontmatter fields have meaning only in the path-specific format.

## Path-specific fields

The closed documented field set is `applyTo`, `description`, `excludeAgent`, and `name`.

- `applyTo` must be one bounded string. Top-level commas split patterns; commas inside brace or
  bracket expressions remain in that pattern for the profile-owned E02 dialect matcher. Empty
  patterns, more than 1,024 patterns, patterns over 4,096 UTF-16 code units, or an aggregate string
  over 32,768 units deny scope authority.
- `excludeAgent` accepts only `cloud-agent` or `code-review`. The syntax adapter preserves the
  value; only its named hosted profile may use it to exclude a document.
- `name` and `description` are optional bounded strings. Their relevance semantics are not treated
  as deterministic path activation.
- Unknown fields are retained by C07 but reported as syntax issues. They do not silently acquire
  activation semantics.

Missing or malformed `applyTo` yields `scopeAuthority: denied`, never an always-on fallback. D08 may
represent VS Code's missing-`applyTo` documentation conflict as manual/conditional/unknown, but it
cannot turn denied path scope into a definite match.

## References

Repository-wide syntax exposes source-exact C09 `@relative/path` candidates with
`referenceSupport: profile-dependent-repository-reference`. Current Copilot CLI documentation says
it expands relative references in repository-wide Copilot instructions, `AGENTS.md`, and
`CLAUDE.md`, while other profiles remain responsible for their own support claims.

Path-specific files return no import candidates and
`referenceSupport: unsupported-in-path-specific`; current CLI documentation explicitly excludes
`*.instructions.md` from reference expansion.

## Failure and safety behavior

The parser composes the bounded C07 YAML/frontmatter parser and C09 inert import lexer. It performs
no file read, path resolution, command execution, clock, environment, model, or network operation.
Invalid UTF-8, aliases, tags, duplicate keys, malformed YAML, resource excess, proxies, accessors,
inherited records, invalid identities, and unsupported fields fail closed or produce bounded
non-authoritative issues. Output is immutable and retains source ranges where honest ranges exist.

Behavior sources reviewed 2026-08-02:

- [GitHub Copilot CLI custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- [GitHub-hosted repository instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)
- [VS Code custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions)

The source-backed cross-surface truth table remains in
[Copilot surface support](../profiles/copilot-surface-support.md).
