# Profile-owned glob dialects

E02 supplies the glob callback required by the [activation algebra](activation-algebra.md) without
creating a universal glob language. The `@agent-context/profiles` package owns a closed, data-only
dialect catalog; the resolver interprets only the mechanism fields in that catalog. There is no
caller registration hook and no fallback to `minimatch`, `picomatch`, Git ignore rules, shell globs,
or another profile's behavior.

The contract is `0.1.0`. Every dialect identity binds one profile, its allowed surfaces, a
specification snapshot, pattern base, documented feature subset, evidence facts, and explicit
unknowns. `matchProfileGlob(request)` returns the exact E01 `{ state, reason }` decision.
`createProfileGlobActivationCallbacks()` supplies only that matcher; trace-owned manual and
conditional callbacks remain separate.

## Pinned behavior

| Dialect                                     | Base                                  | Deterministic subset                                                                            | Preserved unknowns                                                  |
| ------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `claude-code/project-rule-paths/2026-08-01` | Repository/project root               | segment `*`, full-segment `**`, brace alternatives; malformed bracket expression is a non-match | valid bracket classes, `?`, case, dotfile, leading/escaped patterns |
| `copilot-vscode/apply-to/2026-08-01`        | caller-supplied workspace `scopeRoot` | segment `*`, full-segment `**`, brace alternatives                                              | brackets, `?`, case, dotfile, escaping, symlink interpretation      |
| Copilot CLI and hosted dialect IDs          | unknown                               | none until their base is documented or observed at a pinned version                             | complete match result                                               |
| `cursor-agent/mdc-globs/2026-08-01`         | unknown                               | none until D12/D16 establish grammar and base                                                   | complete match result, including comma/list and brace forms         |

The same `*.md` pattern therefore intentionally differs for a nested scope: Claude evaluates it from
the repository root, VS Code evaluates it from the selected workspace scope root, and Cursor remains
indeterminate. The persisted
[`profile-glob-dialects.fixture.json`](../../conformance/fixtures/v0/profile-glob-dialects.fixture.json)
locks that cross-profile result. A profile/surface mismatch, `null` dialect, or unknown dialect ID
also returns `indeterminate`; none inherits a default.

Codex has no path-glob activation behavior in its pinned AGENTS contract. Gemini's `.gitignore`,
`.geminiignore`, and custom-ignore behavior belongs to the ordered C04 ignore engine, not E02
instruction activation. Those mechanisms deliberately do not receive an activation-dialect entry.

The source basis was checked on 2026-08-02 against the existing profile snapshots and current
first-party pages:

- [Claude Code project rules and `paths` patterns](https://code.claude.com/docs/en/memory)
- [VS Code file-based instructions and `applyTo`](https://code.visualstudio.com/docs/agent-customization/custom-instructions)
- [GitHub Copilot custom-instruction surface support](../profiles/copilot-surface-support.md)
- [Cursor rule activation](https://docs.cursor.com/context/rules)

Living pages do not erase the snapshot's recorded gaps. A newly observed behavior requires the
profile's normal truth-table and conformance review before a new dialect identity can claim it.

## Matching rules

The two deterministic subsets operate only on canonical B01 `/` paths. A single `*` matches Unicode
scalars within one segment. A segment equal to `**` matches zero or more whole segments. Brace
alternatives are expanded before matching. Embedded `**`, backslashes, leading `/`, `./`, `../`,
negation, unsupported `?`/bracket forms, and malformed brace forms return `indeterminate` unless a
pinned profile specifies another result.

Case and wildcard-dotfile policy are not documented. An exact case-sensitive, dot-independent match
is active. A result that changes under ASCII case folding or wildcard access to a leading dot is
indeterminate. Clearly different ASCII paths are inactive. A non-ASCII non-match remains
indeterminate because the profile's filesystem case behavior is not pinned.

Claude Code 2.1.217 documents a 1,000-pattern/4 MiB brace-expansion defense and treats an
over-budget expression literally, so it cannot match as an expanded pattern. VS Code does not
publish equivalent client limits; crossing the linter's equal-or-lower safety ceiling remains
indeterminate rather than becoming a client claim.

## Defensive boundary

`PROFILE_GLOB_DIALECT_LIMITS` bounds each request to 16 KiB per pattern/target, 64 KiB cumulative
text, 1,024 path segments, 1,000 expanded patterns, 4 MiB expanded text, and 1,048,576 deterministic
matching work units. Matching uses bounded dynamic programming rather than a backtracking regular
expression. Work exhaustion returns an indeterminate profile fact.

The direct API rejects proxies, accessors, symbols, extra fields, noncanonical paths, and oversized
requests with `ProfileGlobDialectError`. Repository-controlled malformed Unicode or terminal
controls in a pattern produce a fixed safe indeterminate reason. Decisions never interpolate the raw
pattern or target, are frozen, deterministic, offline, and perform no filesystem, process, model,
locale, clock, or network operation.
