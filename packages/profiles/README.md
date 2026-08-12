# `@agent-context/profiles`

Internal immutable client-profile identities and closed behavior catalogs. D03 adds the pinned Codex
CLI 0.146.0 single-CWD descriptor, built-in AGENTS candidate names, default root marker, and
aggregate byte-cap default. The descriptor intentionally has no callbacks and no E02 glob dialect.

D08 adds four distinct Copilot descriptors for CLI, local VS Code Chat, hosted coding agent, and
hosted code review. Each descriptor retains surface-specific support, reference, glob, and
uncertainty claims; there is no generic Copilot fallback.

D05 adds the `claude-code/local-session` descriptor, the canonical Claude memory/rule formats, the
documented four-hop import limit, the profile-owned project-rule glob dialect, and explicit client
version boundaries. The descriptor is data-only; runtime behavior lives in the resolver.

D10 adds the immutable Gemini CLI 0.53.1 local-terminal descriptor, pinned stable/current source
identities, defaults, and evidence references. State transitions remain resolver-owned.

D13 adds separate immutable Cursor IDE and Agent CLI surface descriptors, pinned metadata-only
client versions, MDC/legacy support claims, the existing Cursor-owned unknown E02 glob dialect, and
the documented `0.45`/`0.49` IDE boundaries. Model relevance and runtime transitions remain
resolver-owned.

Executable profile resolution lives in `@agent-context/resolver`. See the
[Codex CLI resolver contract](../../docs/api/codex-cli-profile.md), the
[versioned compatibility profile](../../docs/profiles/codex-cli-agents.md), and the
[Copilot surface profile contract](../../docs/api/copilot-profiles.md), the
[Claude Code profile contract](../../docs/api/claude-code-profile.md), and the
[Gemini CLI profile contract](../../docs/api/gemini-cli-profile.md). The
[stateful Cursor profile contract](../../docs/api/cursor-profile.md) documents D13.
