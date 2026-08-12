# Gemini CLI context profile

D10 implements the pinned Gemini CLI `0.53.1` local-terminal profile. The immutable descriptor in
`@agent-context/profiles`, closed syntax and settings adapters in `@agent-context/syntax`, and
stateful resolver in `@agent-context/resolver` are tied to snapshot `gemini-cli/2026-08-02.0`.
Stable source `19a68016bdc9cd4177a155846dd51f282c3c1c59` and current source
`f47d6c6f7a1308d81f9f57acf7d279f0928c5249` are retained separately.

Normal resolution is deterministic, offline, read-only, and model-free. The caller supplies an
authorized candidate inventory, explicit settings bytes, workspace and boundary paths, an ordered
event trace, trust state, and a root-jailed `ReadOnlyRepository`. The resolver does not enumerate
the host filesystem, inspect a Gemini home, expand environment variables, run Gemini CLI, execute
repository commands, or use the network.

## Syntax and settings

`parseGeminiContext` accepts one closed Markdown byte snapshot. It reuses the exact source/range and
AST guarantees of `parseAgentsMarkdown`, then applies Gemini's import-reference dialect. It assigns
syntax only: discovery, hierarchy, trust, and activation remain profile-owned.

`parseGeminiSettings` accepts one explicit UTF-8 JSON object and models these `context` fields:

- `fileName`, with `GEMINI.md` retained as a final fallback;
- `includeDirectories` and `loadMemoryFromIncludeDirectories`;
- `memoryBoundaryMarkers` and `discoveryMaxDirs`;
- `importFormat`, limited to `tree` or `flat`; and
- `fileFiltering.respectGitIgnore` and `fileFiltering.respectGeminiIgnore`.

Duplicate keys, malformed JSON, unknown fields, unsafe paths, invalid types, and resource-limit
failures are explicit. `$VAR` and `${...}` expressions remain inert and are omitted with an issue;
ambient environment values are never read.

`mergeGeminiSettingsLayers` accepts only explicit layers in this order:

| Order | Layer             | Trust behavior                                         |
| ----: | ----------------- | ------------------------------------------------------ |
|     1 | `defaults`        | Applied when supplied                                  |
|     2 | `system-defaults` | Applied when supplied                                  |
|     3 | `user`            | Applied when supplied; no user directory is discovered |
|     4 | `workspace`       | Applied only when marked trusted                       |
|     5 | `system-override` | Applied last                                           |

Scalar and list-valued settings replace the previous value, except include directories, which are
concatenated and deduplicated. Malformed layers are skipped, and untrusted workspace settings are
reported but not applied. The result always contains effective defaults.

## Stateful resolution

`resolveGeminiCliContext` requires a `launch` event first and then processes `read-path`,
`write-path`, `list-directory`, `memory-reload`, and `directory-add` events in order.

At launch, each workspace root is searched from its nearest configured memory boundary to the root.
Configured filenames are checked per directory, selected identities are deduplicated, and the final
project list is ordered lexicographically by canonical path. A trusted read, write, or list event
performs just-in-time discovery from the deepest containing root to the target directory and loads
only identities not already present. `memory-reload` clears the loaded state and repeats static
discovery. `directory-add` adds a root immediately, but reloads static memory only when
`loadMemoryFromIncludeDirectories` is enabled.

Untrusted and unknown trust states suppress all workspace and JIT memory. Targets outside every
active root are retained as `outside-roots` decisions. Candidate identity, not only path, prevents
duplicate loading across overlapping roots. Every result includes per-event additions and post-event
state, document provenance, effective settings, issues, and final static/loaded paths. Inputs are
copied or validated as closed data, and returned records and arrays are immutable.

## Imports, ignores, and uncertainty

Each selected document is parsed and passed to the C10 bounded import graph loader through a
repository capability restricted to the nearest memory boundary. Tree mode has the pinned depth
limit of five. Gemini's documented flat mode has no finite client limit, so the linter applies a
safety cap of 32 and emits `flat-import-depth-safety-cap`. Graph limits also bound files, bytes,
edges, fan-out, and issues.

Relative imports are supported. Pinned Gemini behavior also permits contained absolute imports, but
C10 intentionally accepts repository-relative targets only. D10 therefore rejects absolute imports
safely and reports `absolute-import-unsupported`; it never guesses a host-to-repository mapping.
Missing, unreadable, cyclic, escaping, or resource-limited imports produce a partial graph and an
explicit issue.

Pinned evidence disagrees on whether ignore filtering affects context-memory discovery. Candidate
`ignoredBy` evidence is retained, but it does not silently deactivate memory; the resolver emits
`ignore-memory-contradiction`. Likewise, non-default `discoveryMaxDirs` and configured include roots
retain their known contradictions as issues. `externalContext` is either `unavailable` or an
explicit synthetic state; no global context is discovered.

## Limits and conformance

Settings input is capped at 1 MiB, eight layers, 128 filenames, 128 include directories, 128
boundary markers, and 128 issues. Resolver input is capped at 65,536 candidates, 4,096 events, 4,096
boundary directories, 256 roots, 32 ignore references per candidate, 16 KiB paths/identities, and
4,096 issues. Invalid proxies, accessors, sparse arrays, duplicate paths or event IDs, malformed
canonical paths, and open records are rejected before resolution.

The implementation scenarios are linked to the D09 canonical fixtures:

- [`gemini-hierarchy-jit.fixture.json`](../../conformance/fixtures/v0/gemini-hierarchy-jit.fixture.json)
  covers boundary hierarchy, custom names, multi-root ordering, trust, JIT, and reload traces;
- [`gemini-import-modes.fixture.json`](../../conformance/fixtures/v0/gemini-import-modes.fixture.json)
  covers tree/flat imports and unavailable or unsafe targets; and
- [`gemini-ignore-memory-ambiguity.fixture.json`](../../conformance/fixtures/v0/gemini-ignore-memory-ambiguity.fixture.json)
  preserves ignore contradictions instead of inventing activation semantics.

D14 inventory/list presentation and D15 real-client observation are intentionally outside this
contract. External repository validation remains read-only and cannot create branches, commits,
patches, pull requests, issues, comments, or other upstream artifacts.
