# Codex CLI `AGENTS.md` compatibility profile

- Status: D03 implementation and executable conformance fixture complete; D02 specification independently reviewed and mapped by the D01 v0 fixture contract
- Profile identifier: `codex-cli`
- Pinned client: `codex-cli 0.146.0`
- Pinned release: `rust-v0.146.0`, commit [`e363b08c9175ac1cbe5893615dd2cb9ddf95043b`](https://github.com/openai/codex/tree/e363b08c9175ac1cbe5893615dd2cb9ddf95043b)
- Evidence retrieved: 2026-08-01
- Official manual implementation check: 2026-08-02
- Observed platform: macOS arm64

This document defines what a Svetovid `codex-cli` compatibility profile must
report. It deliberately does not define the generic `AGENTS.md` document
syntax. The profile is versioned because client discovery behavior can change.

## Compatibility boundary

There are three separate concepts:

1. **Document syntax** — `AGENTS.md` is Markdown treated as opaque instruction
   text. The cited Codex material defines no machine-readable front matter,
   import directive, rule ID, or statement-level override operator. A generic
   parser must not invent these constructs.
2. **Client profile** — Codex CLI chooses filenames, walks from a detected root
   to a launch working directory, selects at most one file per directory, and
   assembles the chosen text in a client-specific order. Those rules are the
   subject of this profile.
3. **Out-of-repository context** — the optional file in `CODEX_HOME` is user
   context, not repository content. A normal repository scan must neither read
   nor assume it. A caller may provide that context explicitly for an
   environment simulation; otherwise the result must say
   `external-context-unavailable`.

The profile models a local Codex CLI session launched at a chosen CWD. It does
not reinterpret the path of every lint target as a new CWD. Sibling and
descendant directories outside the root-to-CWD chain are not loaded for that
session.

## Evidence and confidence labels

| Label | Meaning |
| --- | --- |
| `documented` | Current official OpenAI documentation states the behavior. |
| `source` | The pinned 0.146.0 release source establishes the behavior. |
| `observed` | A no-model local observation reproduced it on the pinned binary. |
| `unknown` | Neither the official contract nor the bounded observation establishes a portable answer. |

Normative public references:

- [Official `AGENTS.md` guide](https://developers.openai.com/codex/guides/agents-md)
- [Advanced configuration: project instruction discovery](https://developers.openai.com/codex/config-advanced#project-instructions-discovery)
- [Configuration reference](https://developers.openai.com/codex/config-reference)
- [CLI reference: `codex debug prompt-input`](https://developers.openai.com/codex/cli/reference#codex-debug-prompt-input)
- [Pinned 0.146.0 discovery source](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/agents_md.rs)
- [Pinned release](https://github.com/openai/codex/releases/tag/rust-v0.146.0)

Source anchors used for review are [root discovery and path order, lines
1–16](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/agents_md.rs#L1-L16),
[aggregate byte loading and UTF-8 decoding, lines
83–150](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/agents_md.rs#L83-L150),
[root/config-layer and per-directory discovery, lines
153–232](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/agents_md.rs#L153-L232),
[candidate construction, lines
234–248](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/agents_md.rs#L234-L248),
and [prompt assembly, lines
310–345](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/agents_md.rs#L310-L345).

The observation transcript is in
[`codex-cli-0.146.0-macos-arm64.md`](observations/codex-cli-0.146.0-macos-arm64.md).
The executable, schema-neutral cases are catalogued in
[`codex-cli-0.146.0-agents-md.json`](../../conformance/profiles/codex-cli-0.146.0-agents-md.json).
The D03 executable resolver cases are in
[`codex-cli-agents.fixture.json`](../../conformance/fixtures/v0/codex-cli-agents.fixture.json), and
the implementation API is described in the
[Codex CLI profile resolver contract](../api/codex-cli-profile.md).

## Discovery truth table

| ID | Condition | 0.146.0 result | Confidence | Required linter representation |
| --- | --- | --- | --- | --- |
| `CDX-ROOT-01` | `project_root_markers` is unset | Use `['.git']`. | documented, source, observed | Record the effective marker and its origin as a default. |
| `CDX-ROOT-02` | One or more ancestors contain a configured marker | The nearest marked ancestor is the project root. Do not walk above it. | documented, source, observed | Report the selected root and winning marker. |
| `CDX-ROOT-03` | No ancestor through filesystem root contains a marker | Search the CWD only, not its parents. | documented, source, observed | Report `root-not-found` and the single searched directory. |
| `CDX-ROOT-04` | `project_root_markers = []` | Disable parent traversal and search CWD only. | documented, source, observed | Distinguish an explicit empty list from the default. |
| `CDX-ROOT-05` | Custom marker list is non-empty | Find the nearest ancestor containing any configured marker. | documented, source, observed | Preserve configured order for provenance; do not claim it changes nearest-ancestor selection. |
| `CDX-ROOT-06` | A repository-local `.codex/config.toml` tries to bootstrap `project_root_markers` | The pinned source excludes project config layers while finding the root. | source | Do not use the project-local layer to discover the root that would make that layer available. |
| `CDX-PATH-01` | A project root exists | Search every directory root → CWD, inclusive. | documented, source, observed | Emit the exact ordered directory chain. |
| `CDX-PATH-02` | A file exists in a sibling, descendant, or ancestor above root | It is outside this session's chain and is not selected. | documented, source | Explain it as `outside-discovery-chain`, not as absent. |
| `CDX-PATH-03` | `codex -C PATH` / `codex --cd PATH` is used | `PATH` is the launch CWD for discovery. | documented, local help | Accept CWD independently from the lint target path. |

## Filename selection and empty-file truth table

For each searched directory the candidate order is:

1. `AGENTS.override.md`
2. `AGENTS.md`
3. each non-empty `project_doc_fallback_filenames` entry in configured order

Duplicate candidate strings are removed while preserving their first
occurrence. The two built-in names therefore always retain priority even if
repeated in the fallback list.

| ID | Directory contents | Selected candidate | Confidence | Notes |
| --- | --- | --- | --- | --- |
| `CDX-SEL-01` | override, base, and fallbacks are regular files | `AGENTS.override.md` | documented, source, observed | At most one project file is selected per directory. |
| `CDX-SEL-02` | no override; base and fallbacks exist | `AGENTS.md` | documented, source | Fallbacks are considered only when both built-ins are absent/non-files. |
| `CDX-SEL-03` | neither built-in exists; multiple fallbacks exist | First configured fallback that resolves to a file | documented, source, observed | Configured list order is significant. |
| `CDX-SEL-04` | a candidate path is a directory | Skip it and try the next candidate. | source | Selection checks file metadata. |
| `CDX-SEL-05` | an empty candidate name occurs in fallbacks | Ignore that name. | source | It must not mean the current directory. |
| `CDX-SEL-06` | a fallback duplicates a prior name | Ignore the duplicate. | source | First occurrence wins. |
| `CDX-EMPTY-01` | selected project override is empty or whitespace-only; base has text | Select override, then omit its blank content. Do **not** fall through to base. | source, observed | File selection precedes content reading. This edge case is easy to misread from prose docs. |
| `CDX-EMPTY-02` | selected first fallback is empty; later fallback has text | Select first fallback, omit blank content, and do not fall through. | source, observed | Report both `selected` and `content-omitted-empty`. |
| `CDX-EMPTY-03` | `CODEX_HOME/AGENTS.override.md` is empty; global base has text | Use the first non-empty global instruction file, so the base is used. | documented, observed | Global selection is not the same as project-directory selection. |

The linter must preserve the distinction among `missing`, `not-a-file`,
`selected-empty`, and `selected-nonempty`. Collapsing all four into “ignored”
would conceal real Codex behavior.

## Concatenation and precedence truth table

| ID | Condition | Model-visible assembly | Confidence | Required interpretation |
| --- | --- | --- | --- | --- |
| `CDX-MERGE-01` | More than one non-empty project file was selected | Concatenate root → CWD with `\n\n` between project entries. | documented, source, observed | Preserve ordered provenance for every contribution. |
| `CDX-MERGE-02` | Non-empty global and project instructions exist | Global text first, then `\n\n--- project-doc ---\n\n`, then project text. | source, observed | Separator bytes are assembly text, not a source document. |
| `CDX-MERGE-03` | Documentation says nearer files “override” earlier guidance | Nearer text appears later; Codex does not mechanically delete or rewrite earlier statements. | documented, source | Report an ordered conflict opportunity. Do not assert deterministic statement-level resolution. |
| `CDX-MERGE-04` | Only empty selected project files exist | No project entry or project separator is emitted. | source, observed | Selection provenance still matters to an explanation. |
| `CDX-MERGE-05` | Multiple project environments are present | The pinned source has environment-labelled assembly, but the local single-CWD profile did not exercise it. | source, unknown portability | Out of scope for the initial local profile; preserve an explicit unsupported/unknown state. |

Markdown headings, paragraphs, and path-scope wording can guide a model, but
they do not change the mechanical discovery algorithm. A linter may detect
human-readable conflicts, provided it labels those findings as analysis rather
than Codex's deterministic merge result.

## Byte budget and encoding truth table

`project_doc_max_bytes` defaults to 32 KiB (`32768`). For the pinned client it
is an **aggregate project-document budget**, consumed in root-to-CWD order.
This is established by the guide, pinned implementation, and observation. One
advanced-configuration sentence describes the cap as applying “from each
file”; that sentence conflicts with the more specific guide and implementation
and is not adopted by this versioned profile.

| ID | Condition | 0.146.0 result | Confidence | Required linter representation |
| --- | --- | --- | --- | --- |
| `CDX-BYTE-01` | Total selected project bytes are below cap | Include every non-empty selected project file in order. | documented, source, observed | Track raw source byte counts. |
| `CDX-BYTE-02` | A file exceeds the remaining aggregate budget | Read only the remaining bytes; later files receive no budget. | source, observed | Mark exact truncation offset and all budget-exhausted omissions. |
| `CDX-BYTE-03` | `project_doc_max_bytes = 0` | Load no project documents. | source | Global/user instructions can still exist. |
| `CDX-BYTE-04` | Truncation splits a UTF-8 sequence | Decode lossy UTF-8 and emit U+FFFD for the incomplete/invalid sequence. | source, observed | Measure bytes before decoding; do not truncate by characters. |
| `CDX-BYTE-05` | A selected file is blank | It does not consume budget in the pinned implementation. | source | Record selected-empty without reducing remaining bytes. |
| `CDX-BYTE-06` | Separators or global text exist | They do not consume `project_doc_max_bytes`. | source, observed | Keep project budget distinct from assembled prompt length. |
| `CDX-BYTE-07` | Source contains a UTF-8 BOM or unusual newline form | No special normalization is documented. Source inspection suggests lossy decoding preserves decoded characters, but this was not independently observed. | source inference, unknown contract | Preserve raw-byte facts; do not promise normalization. |
| `CDX-BYTE-08` | A non-blank file is truncated to a whitespace-only prefix | Omit the bounded prefix and do not charge it to the aggregate budget; the next selected file can use that budget. | source | Distinguish a bounded blank prefix from an entirely blank source file. |

## Global and `CODEX_HOME` context

The global lookup is performed under `CODEX_HOME`, whose default is
`~/.codex`. It considers `AGENTS.override.md`, then `AGENTS.md`, and uses the
first non-empty file. `CODEX_HOME` also controls other Codex state and must
already exist when set.

This is explicitly **outside repository scanning authority**:

- Default linting reports that external context is unavailable and never reads
  the user's real home or `CODEX_HOME`.
- A simulation may accept an explicit, caller-supplied external-context object
  containing the effective path, text/hash, and provenance. It must not discover
  that context by escaping the scan root.
- Findings caused only by missing external context must be informational and
  must not imply the repository is self-contained.
- Repository conformance results remain reproducible without personal files.

## Symlinks, paths, and filesystem uncertainty

The pinned source explicitly permits symlinks, and the local observation loaded
an `AGENTS.md` symlink whose target was outside the synthetic repository. That
describes Codex, not permission for Svetovid to escape its root.

| Case | Codex 0.146.0 profile | Safe linter behavior |
| --- | --- | --- |
| Symlink resolving to a regular file inside root | Recognized as a candidate. | Resolve safely, retain link and target provenance, and apply cycle/depth/root controls. |
| Symlink resolving to a regular file outside root | Locally observed as loaded by Codex. | Do not read outside root. Report `external-symlink-target` and projected client behavior with content unavailable. |
| Broken symlink | Expected to behave as not found from source metadata handling; not independently observed. | Report broken link; do not fabricate content. |
| Symlink loop, Windows junction, remote executor URI | Not established by this bounded profile. | Report unsupported/unknown rather than guessing. |
| Filename case differences (`agents.md`) | Depends on filesystem path semantics; no portable Codex contract found. | Match the exact configured string and report platform uncertainty where relevant. |
| Permission or transient read error | Source propagates non-`NotFound` I/O errors and logs at its caller; stable user-visible behavior is not documented. | Return a structured incomplete-analysis diagnostic. |
| File changes between metadata probe and read | Not documented. | Mark the analysis non-atomic if detected; never claim a stable snapshot without one. |

## Configuration inputs and precedence

The profile consumes these effective settings:

| Input | Default | Effect |
| --- | --- | --- |
| `project_root_markers` | `['.git']` | Root detection; `[]` disables upward traversal. |
| `project_doc_fallback_filenames` | `[]` | Additional per-directory candidate names after both built-ins. |
| `project_doc_max_bytes` | `32768` | Aggregate raw-byte budget for project documents. |
| `CODEX_HOME` | `~/.codex` | External global instructions and Codex state location. |
| launch CWD / `-C`, `--cd` | process CWD | End of the root-to-CWD discovery chain. |
| `--profile NAME` | none | Selects an additional named configuration layer. |
| `-c key=value` / `--config key=value` | none | CLI configuration override. |

Official configuration precedence is CLI overrides, trusted project layers
(root → CWD, with the closest winning), selected profile, user, system, then
built-in defaults. A trusted project configuration can affect fallback names
and byte budget. For root detection, the pinned source
specifically merges non-project layers and ignores project layers to avoid a
bootstrap cycle. Invalid root-marker configuration falls back to the default
marker list in the pinned source and emits a warning; exact warning transport
is not a stable profile contract.

A conformance harness must inject effective settings explicitly. It must not
depend on a developer's real user configuration, trust database, credentials,
or selected profile.

## Safe observability

For Codex CLI 0.146.0, the preferred non-model observation is:

```console
$ CODEX_HOME="$OBS_ROOT/home" codex debug prompt-input 'LOCAL_OBSERVATION_PROMPT'
```

The official CLI describes this experimental command as rendering the exact
model-visible prompt input as JSON. It produced the discovery result locally
without invoking `codex exec`, opening a TUI session, or making a model/API
request. Because it is experimental, automation must version-check it and
gracefully mark observation pending when unavailable.

Other documented observability paths are weaker or potentially costly:

- a TUI request for instruction summaries can involve a model and is forbidden
  in this conformance workflow;
- plaintext TUI logs or session JSONL may expose prompt content and exist only
  after a session, so they are neither the default nor safe fixtures;
- local `codex-cli 0.146.0 --help` exposes no `codex status` subcommand despite
  one guide example using that spelling. Do not treat it as a portable command
  (the TUI `/status` command is a separate interface).

Every stored observation must record client version, binary, OS/architecture,
effective synthetic configuration, CWD, command, relevant output, date, and
whether any model/API path was used. Secrets and the user's actual global
context must never be captured.

## Profile algorithm for implementation

The following is the deterministic core the linter profile should implement:

1. Receive a repository scan root, a separately chosen session CWD, and
   explicit effective configuration. Reject or annotate a CWD outside the scan
   root; never silently expand authority.
2. Resolve root markers without a repository-local configuration layer. Find
   the nearest marked ancestor, bounded by filesystem and scan authority. If no
   marker exists or the marker list is empty, use CWD only.
3. Enumerate directories from root to CWD, inclusive.
4. Build the deduplicated candidate list: override, base, then configured
   fallbacks. In each directory, select the first candidate resolving to a file.
5. Read selected project candidates in directory order under one aggregate raw
   byte budget. A selected blank file contributes no text and does not trigger
   candidate fallback. Decode the bytes with UTF-8 replacement semantics.
6. Return ordered contributions, skips, truncation offsets, unresolved external
   links, and remaining budget. Do not flatten provenance into one string for
   diagnostics.
7. If explicitly supplied, prepend non-empty external global context and model
   the project separator. Otherwise report that external context was not
   evaluated.
8. Label later text as later text—not as proof that earlier natural-language
   instructions were semantically overridden.

## Known unknowns and review gates

The following remain explicitly unknown or out of scope rather than implicit
compatibility promises:

- portable behavior for case-insensitive filesystems, Windows junctions, remote
  environment URIs, symlink cycles, and concurrent file mutation;
- a stable public guarantee for warning/log formatting or exit behavior after
  each class of metadata/read failure;
- statement-level conflict resolution inside Markdown;
- multi-environment prompt labelling in a local single-CWD linter run;
- compatibility with Codex versions other than the pinned `0.146.0` until a
  separately versioned profile is reviewed;
- downstream B02/B03 type names and the remaining scenario migrations beyond
  the canonical D01 examples.

D02's independent review checked the truth tables against the current official
manual, pinned sources, observation transcript, and scenario catalog. D01 maps
the catalog through the [v0 conformance contract](../contracts/profile-conformance-fixture-v0.md)
and its canonical root-order example without weakening these assertions.

## D16 observation disposition

The [2026-08-02 GA review](ga-observation-review-2026-08-02.md) revalidated the exact local
`0.146.0` executable through D15's digest-pinned, deny-network `--version` adapter. The result was
observed with an unchanged disposable workspace. It matches the version of the earlier no-model
prompt-input observation and the canonical root-order fixture, but the D15 transcript itself
contains no loaded-source sequence and promotes no new behavior.
