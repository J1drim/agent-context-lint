# Synchronizing a canonical policy

Canonical-policy synchronization is an optional preview-first library capability. It treats one
repository `AGENTS.md` as the canonical text and shows how the same plain instruction content could
be represented for Claude Code, supported Copilot surfaces, Gemini CLI, and Cursor.

It is intentionally conservative:

- a preview never writes;
- a new vendor file is shown as `preview-only` and cannot be applied;
- an existing vendor file can be replaced only when it is byte-for-byte equal to the recorded prior
  generated base;
- any hand edit, deletion, malformed base, missing marker, concurrent change, link, non-file, path
  escape, or uncertain client scope is refused;
- links, imports, HTML comments, frontmatter-like canonical content, and client-dependent activation
  constructs are not translated; and
- output never claims that different clients behave equivalently.

Review `patch`, `profiles`, `mergeState`, `application`, and `reason` for every target. Keep the
returned `nextBase` with local tool state only after accepting the exact generated file. A later
preview needs that exact base to distinguish a clean regeneration from user-authored changes.

Nested policies are generated only when the selected client profile proves the same inside/outside
target set. Nested Cursor generation is currently refused because Cursor's MDC glob grammar and
pattern base remain unknown; the resolver confirms that a nested rule-root candidate with
`alwaysApply: false` and scoped `**` excludes outside paths but cannot claim that it activates
inside. Nested Copilot generation is also refused because the supported CLI and VS Code profiles do
not provide one common certain path-glob interpretation.

No repository command, network request, model call, Git mutation, or external repository operation
is part of this workflow.
