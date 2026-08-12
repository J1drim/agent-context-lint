# Cross-profile instruction listing

Ticket D14 adds `buildInstructionList` to `@agent-context/resolver`. It projects the closed Codex
CLI, Claude Code, Copilot, Gemini CLI, and Cursor resolver results into one deterministic inventory.
The packaged `agent-context-lint list` command is wired later by I03; callers must not interpret the
presence of this engine as an already available CLI command.

## States

Every discovered candidate row has exactly one state and a non-empty explanation:

| State         | Meaning                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `supported`   | The pinned surface supports the format and the supplied profile trace activates or loads it.                        |
| `ignored`     | The profile deterministically excludes, shadows, disables, or does not load the candidate.                          |
| `conditional` | Discovery, version, trust, event, selection, or profile support is incomplete or conditional.                       |
| `recognized`  | The syntax is recognized, but the selected surface's support matrix or client-version boundary does not support it. |
| `malformed`   | The candidate has malformed syntax or invalid UTF-8; this takes precedence over activation.                         |

`recognized` is deliberately not a synonym for `supported`. This distinction lets later portability
rules report syntax understood by the linter without claiming that a client consumes it.

Each `InstructionListEntry` includes `path`, `formatId`, `profileId`, `surfaceId`, `profileVersion`,
`scopeRoot`, `state`, `decisionCode`, `sourceState`, and `reason`. A null scope means the profile
could not establish scope; it never means repository-wide scope.

## Input and accounting

Pass resolver results in their matching family arrays. Gemini additionally requires the original
closed candidate snapshots because its event resolution intentionally retains loaded documents, not
every recognized-but-unloaded candidate.

```ts
import { buildInstructionList } from "@agent-context/resolver";

const listing = buildInstructionList({
  codexCli: [codexResolution],
  claudeCode: [claudeResolution],
  copilot: copilotSurfaceResolutions,
  cursor: cursorSurfaceResolutions,
  geminiCli: [{ candidates: geminiCandidates, resolution: geminiResolution }],
});

for (const candidate of listing.entries) {
  console.log(candidate.path, candidate.profileId, candidate.state, candidate.reason);
}
```

One row represents one path/format/profile/surface decision. A file consumed by several surfaces
therefore appears several times. Duplicate identities are rejected instead of silently merged.
Missing Codex search locations and Gemini directory snapshots are not files and are omitted.

Rows use locale-independent code-point ordering by path, profile, surface, format, and decision
code. The summary counts are derived after duplicate and resource checks. Reordering input families
or candidates cannot change serialized output.

## Safety and limits

The listing engine is pure and synchronous. It performs no discovery, filesystem access, network
access, client invocation, model call, or command execution. Inputs must already be
caller-authorized resolver results. Proxies, accessors, symbols, sparse arrays, cyclic/unsupported
object graphs, unknown top-level fields, duplicate rows, excessive sources, excessive entries, and
excessive input depth/nodes fail closed with `InstructionListError`.

The exported `INSTRUCTION_LIST_LIMITS` caps sources per resolver family, entries, input nodes, and
tree depth. Reasons come from bounded resolver decisions or fixed D14 explanations; repository text
is not copied into list output.
