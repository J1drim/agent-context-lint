# Client profile specifications

This directory records the externally observable instruction-discovery behavior that each client
profile must reproduce. A profile specification is a versioned compatibility contract, not a general
user guide.

Each specification distinguishes three evidence levels:

- **Documented**: stated by a current first-party source.
- **Observed**: reproduced against a pinned client version by the project's conformance harness.
- **Unknown**: not specified precisely enough to implement as deterministic client behavior.

An implementation must preserve unknowns. It must not turn an inference into a compatibility
promise. Repository scans also cannot know user-level, managed, or runtime-only configuration unless
the caller supplies it; findings that depend on such state are conditional.

Current specifications:

- [Claude Code](claude-code/compatibility.md)
- [Codex CLI](codex-cli-agents.md)
- [Gemini CLI](gemini-cli/compatibility.md)
- [GitHub Copilot surfaces](copilot-surface-support.md)
- [Cursor](cursor/compatibility.md)

The dated [GA observation review](ga-observation-review-2026-08-02.md) binds all seven GA surfaces
to D15 transcripts and versioned fixtures. Only Codex produced a safe metadata probe; all other
client-only behavior remains explicit unknown/blocked evidence rather than a compatibility claim.

Cursor's 71-case MDC, activation, glob, nested-root, reference, and surface matrix is also available
as validated, schema-neutral [research data](data/cursor-rule-facts.v0.json). It intentionally
grants no runtime activation authority; unresolved and model-selected behavior stays conditional
until pinned behavioral conformance exists.

The executable [Copilot profile contract](../api/copilot-profiles.md) keeps CLI, VS Code, hosted
coding-agent, and hosted code-review behavior separate while preserving this research record's
unknown and contradictory states.

The version-0 mapping between formats, profiles, and runtime surfaces, plus the canonical fixture
requirements, is defined in the
[profile conformance fixture contract](../contracts/profile-conformance-fixture-v0.md).

The [official-example conformance corpus](official-example-conformance.md) pairs positive and
negative fixtures for every GA surface/format capability and records its monthly profile-owner and
QA-owner review deadline.

The resolver's closed mapping from these profiles to versioned glob behavior is documented in the
[profile-owned glob dialect contract](../api/profile-glob-dialects.md); undocumented syntax or bases
remain indeterminate instead of inheriting a shared library default.

The implemented Codex profile API is documented in the
[Codex CLI AGENTS resolver contract](../api/codex-cli-profile.md). Its generic Markdown adapter is
documented separately so client discovery behavior cannot leak into document syntax.
