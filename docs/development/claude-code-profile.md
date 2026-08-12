# Developing the Claude Code profile

D05 is split across `packages/syntax/src/claude-instructions.ts`,
`packages/profiles/src/claude-code.ts`, and `packages/resolver/src/claude-code-profile.ts`. Keep the
syntax/profile/resolution boundaries intact: syntax identifies inert structure, the descriptor pins
identity/evidence, and only the resolver combines authorized runtime snapshots.

## Change procedure

1. Update the dated D04 compatibility research from first-party evidence before changing behavior.
2. Identify the exact instruction source, client version, setting source, launch/read/compact event,
   and repository/external boundary involved.
3. Update the smallest owning layer. Do not add filesystem, process, environment, client, approval,
   model, or network capability to syntax or resolution.
4. Preserve undocumented results as indeterminate. Never turn malformed `paths`, unknown glob
   semantics, incomplete exclusions, or missing external context into broad activation.
5. Add positive, negative, boundary, unknown, hostile-shape, mutation, immutability, and repeat-
   determinism evidence. Update the D01 fixture when effective-context behavior changes.
6. Run focused syntax/profile/resolver tests and coverage, then conformance, build, lint, type,
   package-boundary, packed-artifact, and serialized repository gates.

## Invariants

- `claude-code` owns only `claude-code/local-session` and the
  `claude-code/project-rule-paths/2026-08-01` glob dialect.
- D05 never discovers or reads a path. Candidate bytes and C10 graphs are caller-owned snapshots.
- Frontmatter cannot broaden activation when malformed, excessive, or wrongly typed.
- C09 recognizes imports; C10 validates repository reads; E04 constructs occurrences; D05 only maps
  those established states to Claude-specific approval/depth evidence.
- Only exact and trailing-`/**` absolute exclusion subsets are resolved. An arbitrary
  `claudeMdExcludes` glob is unknown until a separately versioned dialect is proven.
- External managed/user/additional-directory context must be supplied explicitly or the overall
  result remains partial.
- Source text, paths, events, arrays, and byte snapshots are bounded, closed, immutable, and
  deterministic. Fixture prose is never executed.

Focused coverage for new reachable syntax and resolver code must stay at or above 95% statements,
functions, and lines and 90% branches. Coverage exclusions are not a replacement for exercising
failure and uncertainty branches.
