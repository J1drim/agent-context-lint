# Claude Code syntax and profile resolver

D05 provides a syntax-only adapter in `@agent-context/syntax`, an immutable profile descriptor in
`@agent-context/profiles`, and a pure stateful resolver in `@agent-context/resolver`. The behavior
is bound to the dated D04 research snapshot `claude-code/2026-08-01`; it is not a claim that Claude
will follow an instruction.

## Syntax contract

`parseClaudeInstructionSyntax` accepts a closed record containing canonical `Uint8Array` bytes,
stable document/source identifiers, and one format:

- `memory` parses `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md` bodies;
- `project-rule` additionally parses C07 YAML frontmatter and the documented `paths` field.

The adapter composes C09's `claude-code` import lexer, retains exact source ranges, removes block
HTML comments only when they are outside inline/fenced code, and returns both exact decoded text and
the transformed instruction body. Frontmatter and comments are excluded from the transformed body;
imports outside the body are excluded from import evidence.

`paths` may be one non-empty string or a bounded, unique, non-empty string array. Missing `paths`
means an unconditional rule. Malformed YAML or invalid scope data denies scope authority instead of
broadening the rule. Unknown fields and Markdown recovery remain explicit partial evidence.

## Resolver input

`resolveClaudeCodeProfile` accepts only inert snapshots. A request supplies:

- the canonical repository root and launch CWD;
- candidate bytes, repository-relative path, scope root, kind, origin, absolute-path evidence,
  symlink state, and an optional already-validated C10 import graph;
- client version, launch/read/compact event trace, runtime mode, active setting sources,
  additional-directory opt-in, external-context state, and exclusion evidence.

The resolver has no filesystem, process, environment, clock, client, model, approval prompt, or
network capability. Discovery and reads happen in earlier authorized layers. Outputs are immutable,
bounded, and deterministically sorted.

## Resolution behavior

The resolver preserves D04's state model:

- repository ancestor memory is launch-loaded from broader to nearer directories;
- `CLAUDE.local.md` follows the shared file at the same level;
- descendant memory becomes active only after a supplied matching read event;
- an unconditional project rule loads at launch, while a valid `paths` rule uses the profile-owned
  E02 dialect against supplied post-compact read events;
- after compact, repository-root `CLAUDE.md` is re-injected, while unsupported descendant/rule
  reconstruction remains indeterminate until another read establishes it;
- `.claude/CLAUDE.md` and unconditional project-rule sibling order remains unresolved;
- bare/safe/unknown modes, setting-source filters, additional directories, symlinks, empty or
  malformed content, exclusions, and unversioned/legacy behavior retain explicit inactive or
  indeterminate decisions.

Each candidate reports activation, load state, decision code/reason, `activatedBy` events,
documented partial order, syntax evidence, import decisions, and its version branch.
`analysisStatus: partial` means at least one runtime, syntax, import, external-context, or ordering
fact remains unresolved.

## Imports and exclusions

C10 remains the authority for repository-safe import loading. A supplied graph is rebuilt through
E04 and must match the candidate entry path. The profile maps occurrences through the documented
four-hop limit and keeps external approval, cycles, unavailable targets, and unknown graph states
explicit. Without a graph, raw C09 import candidates remain unresolved; the resolver never follows
them itself.

Claude documents `claudeMdExcludes` as absolute-path matching, but does not define a portable glob
dialect. D05 therefore resolves only exact absolute exclusions and a trailing `/**` subtree subset
when the caller proves a complete, case-sensitive snapshot. Relative patterns, arbitrary wildcards,
unknown platform case, incomplete settings, or absent absolute-path evidence remain indeterminate.

## Version boundaries

The descriptor records the documented 2.1.198 symlink rule behavior, 2.1.207 invalid-glob isolation,
2.1.211 project-source filtering, and 2.1.217 bounded brace expansion. The current resolver selects
the 2.1.211 and 2.1.217 branches it needs; it retains older or missing-version behavior as
`legacy-client-risk` or `unknown-version` where the evidence cannot establish a safe answer. D16
must provide a pinned real-client observation before GA.

## Limits and failures

The syntax adapter accepts at most 262,144 bytes. The resolver bounds candidate/event/exclusion
counts, each path and candidate, and aggregate path/content bytes. Closed records, canonical dense
arrays, intrinsic canonical byte arrays, stable unique IDs, canonical repository paths, and matching
candidate locations are mandatory. Invalid shapes throw `CLAUDE_CODE_PROFILE_INVALID_INPUT` or
`CLAUDE_INSTRUCTION_SYNTAX_INVALID_INPUT`; exhausted limits use their corresponding resource-limit
codes. Hostile input text is never reflected in errors.

The versioned `claude-launch-read-rules` conformance fixture proves launch memory, descendant
on-demand memory, and path-rule activation through the public package exports.
