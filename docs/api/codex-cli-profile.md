# Codex CLI AGENTS profile resolver

D03 implements the pinned `codex-cli 0.146.0` single-CWD profile as immutable data in
`@agent-context/profiles` and a pure resolver in `@agent-context/resolver`. `resolveCodexCliAgents`
consumes an already-authorized discovery snapshot; it never enumerates the filesystem, follows
links, reads environment variables, executes repository commands, or uses the network.

## Resolution contract

The caller supplies canonical `launchCwd` and independent `targetPath` values, effective
`projectRootMarkers`, fallback filenames, the aggregate byte cap, repository entry facts, marker
paths, and either explicitly supplied global bytes or `mode: "unavailable"`.

The resolver then:

1. Finds the nearest configured root marker. No marker, or an empty marker list, limits discovery to
   the launch CWD.
2. Searches root to CWD and selects at most one candidate per directory in the order
   `AGENTS.override.md`, `AGENTS.md`, then unique non-empty configured fallbacks.
3. Preserves empty selected project files as selections without falling through or spending byte
   budget.
4. Applies one aggregate raw-byte budget root to CWD. A final contribution can be a byte prefix,
   including a prefix that splits UTF-8 and therefore decodes with U+FFFD.
5. Parses each bounded contribution with the AGENTS Markdown adapter and joins non-empty project
   contributions with two newlines.
6. Prepends explicitly supplied global instructions with the pinned project separator. Normal scans
   leave global context unavailable.

The result keeps the exact searched directory chain, per-candidate decisions, selected file/link
provenance, contribution bytes and syntax, remaining budget, issues, external-context decision, and
assembled text. `targetPath` is evidence only and never expands the launch-CWD chain.

Codex trims each bounded prefix before charging it to the aggregate budget. If a non-blank file's
truncated prefix is only whitespace, the resolver records `bounded-prefix-empty-after-trim`, emits
no contribution, and leaves the budget for the next selected directory.

For supplied global context, the decision identifies whether override or base won and records the
exact supplied byte length, computed SHA-256, decode mode, and caller-supplied provenance. It never
discovers or exposes a host path.

## C05 and E02 composition

`createCodexCliFallbackDiscoveryMatcherFacts` produces closed, source-derived C05 basename facts for
additional configured fallbacks. Built-in AGENTS names remain in C05's fixed catalog. Duplicate and
empty fallbacks are removed without changing the two built-in priorities.

Codex AGENTS discovery has `globDialectId: null`. It does not borrow a glob dialect from E02, and
Markdown path-like prose does not mechanically activate or suppress a contribution. Later text is
closer to the launch CWD, but statement-level winner behavior remains explicitly unknown.

## Incomplete evidence

External symlink content is never followed outside the repository. It is selected with unavailable
content and an `external-symlink-target` issue. Unreadable or unknown entries, uncertain discovery,
case-variant candidate names, and syntax resource limits similarly preserve evidence and mark the
analysis incomplete. Internal symlinks retain their canonical target provenance.

An unknown candidate kind does not prove that later names are shadowed. Its decision is
`selection-unknown`, and any present later candidate is `selection-contingent`; neither is promoted
to deterministic model-visible content.

The resolver rejects proxies, accessor-bearing or open records, unsafe filenames, malformed paths,
incoherent entry payloads, duplicate inventory paths, typed-array subclasses/extra properties, and
configured resource limits before resolution. Inputs are copied and results are recursively frozen.
Discovery reasons and marker inventories are separately bounded, retained as provenance, and
included in the aggregate path budget.

The executable fixture is
[`conformance/fixtures/v0/codex-cli-agents.fixture.json`](../../conformance/fixtures/v0/codex-cli-agents.fixture.json).
The profile evidence and observed-versus-documented distinctions are in the
[Codex CLI compatibility profile](../profiles/codex-cli-agents.md).
