# Gemini CLI context compatibility research

| Record field | Value |
| --- | --- |
| Research record | `gemini-cli/2026-08-02.0` |
| Retrieved | 2026-08-02 |
| Stable package inspected | `@google/gemini-cli@0.53.1` |
| Stable source tag | `v0.53.1` at `19a68016bdc9cd4177a155846dd51f282c3c1c59` |
| Current source snapshot | `f47d6c6f7a1308d81f9f57acf7d279f0928c5249` |
| Status | D09 research baseline; not a parser, profile, or fixture contract |

This record defines the evidence needed to implement Gemini CLI instruction
discovery without turning current implementation accidents into permanent
compatibility promises. The companion [truth-table data](../data/gemini-cli-context-facts.v0.json)
remains schema-neutral research data. D01 maps it into the
[v0 conformance contract](../../contracts/profile-conformance-fixture-v0.md)
without promoting the research data itself into a public schema.

No authenticated Gemini session was opened, no prompt was sent, and no model
or quota was used. The local observation is limited to package provenance,
`--version`, and `--help`; see the [metadata transcript](observations/2026-08-01-local-metadata.md).
The stable/current byte comparison is separately reproducible from the
[source-equivalence transcript](observations/2026-08-02-source-equivalence.md).

## Evidence vocabulary

| State | Meaning |
| --- | --- |
| Documented | A current first-party document affirmatively states the behavior. |
| Source-derived | The pinned official implementation or tests establish the behavior, but the user documentation does not promise it. |
| Observed | A pinned executable produced the result in an isolated local probe. |
| Conditional | The result depends on trust, settings, roots, an event, or a mode. |
| Contradiction | Current official documentation and pinned source disagree. |
| Unknown | Reviewed evidence cannot determine a stable result. |
| Blocked paid observation | The client exposes no guaranteed local-only interface for the behavior and checking it would require entering a possibly authenticated/model-backed session. |

A linter must preserve `unknown`, `conditional`, and `contradiction` states.
Recognition of a context file is separate from proving that a running client
loaded it.

## Immutable source registry

The files relevant to this record are byte-identical at the stable tag and the
current source snapshot. Links below use the newer immutable source SHA; the
stable package is independently pinned by its tag and registry integrity.

| ID | Official source | Scope |
| --- | --- | --- |
| `GEM-DOC-MEMORY` | [GEMINI.md guide](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/docs/cli/gemini-md.md) | Current hierarchy, JIT summary, commands, and filename example. |
| `GEM-DOC-CONFIG` | [Configuration reference](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/docs/reference/configuration.md) | Settings and an older eager-descendant hierarchy description. |
| `GEM-DOC-IMPORT` | [Memory import processor](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/docs/reference/memport.md) | Import syntax, safety, cycles, depth, and error claims. |
| `GEM-DOC-IGNORE` | [Ignoring files](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/docs/cli/gemini-ignore.md) | `.geminiignore` syntax, scope, and restart behavior. |
| `GEM-SRC-DISCOVERY` | [Memory discovery](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/utils/memoryDiscovery.ts) | Global, ancestor, trusted-root, boundary, deduplication, and JIT ordering. |
| `GEM-SRC-NAMES` | [Context filename state](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/tools/memoryTool.ts) | Default, string/list normalization, order, and deduplication. |
| `GEM-SRC-MANAGER` | [Memory context manager](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/context/memoryContextManager.ts) | Refresh, categories, trust, loaded paths, and dynamic discovery. |
| `GEM-SRC-JIT` | [JIT context integration](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/tools/jit-context.ts) | High-intent tool list, output injection, and failure isolation. |
| `GEM-SRC-IMPORT` | [Import processor](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/utils/memoryImportProcessor.ts) | Grammar, path base, code regions, cycles, depth, boundaries, and output formats. |
| `GEM-SRC-CONFIG` | [CLI configuration assembly](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/cli/src/config/config.ts) | Settings application, include directories, trust, and runtime initialization. |
| `GEM-SRC-SETTINGS` | [Settings loading and merge](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/cli/src/config/settings.ts) and [settings schema](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/cli/src/config/settingsSchema.ts) | Layer order, merge strategies, validation, defaults, and restart metadata. |
| `GEM-SRC-FILTER` | [File discovery service](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/services/fileDiscoveryService.ts) and [custom ignore parser](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/utils/ignoreFileParser.ts) | Ignore-file ordering and construction-time loading. |
| `GEM-SRC-COMMAND` | [`/memory` implementation](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/commands/memory.ts) and [CLI command registration](https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/cli/src/ui/commands/memoryCommand.ts) | `show`, `reload`/`refresh`, and `list`. |
| `GEM-PKG-STABLE` | [Release tag `v0.53.1`](https://github.com/google-gemini/gemini-cli/tree/19a68016bdc9cd4177a155846dd51f282c3c1c59) and [npm registry metadata for `0.53.1`](https://registry.npmjs.org/@google%2fgemini-cli/0.53.1) | Executable/package provenance for the metadata observation. |
| `GEM-HIST-SETTINGS` | [Official settings-redesign issue #6709](https://github.com/google-gemini/gemini-cli/issues/6709) | Historical proposed spelling `loadFromIncludeDirectories`; not a pinned current contract. |
| `GEM-OBS-METADATA` | [Local metadata transcript](observations/2026-08-01-local-metadata.md) | Isolated package version/help probe; no credentials or model request. |
| `GEM-OBS-EQUIVALENCE` | [Source-equivalence transcript](observations/2026-08-02-source-equivalence.md) | Stable/current refs, registry metadata, byte comparison, and SHA-256 digests. |

The stable npm artifact integrity rechecked on 2026-08-02 was
`sha512-xBGdD/tl05gsTpD2oV1Bq0NCb4BBeTnjSbKxHtwOB7nt1QMaqWYJ9WsOEsQQhQ2P1v0UJth1F17SAXvdZ5mASw==`.
The current source package version is
`0.55.0-nightly.20260802.gf47d6c6f7`; it is not substituted for the stable
executable observation.

## Discovery and ordering truth table

“Earlier/later” below describes assembly or injection order. It does not mean
that Gemini CLI parses natural-language conflicts and selects a deterministic
winner.

| Case | Result at the pinned source | State | Evidence |
| --- | --- | --- | --- |
| Default filename | `GEMINI.md`. | Documented | `GEM-DOC-MEMORY` |
| Global files | Every configured filename found under the user Gemini directory is checked in configured filename order. Global memory is assembled before workspace memory. | Documented plus source-derived ordering | `GEM-DOC-MEMORY`, `GEM-SRC-DISCOVERY`, `GEM-SRC-MANAGER` |
| Trusted workspace at repository root | The workspace/root context files are startup project memory. | Documented | `GEM-DOC-MEMORY`, `GEM-SRC-DISCOVERY` |
| Trusted workspace below repository root | Discovery walks upward to the nearest directory containing a configured boundary marker, includes that directory, and produces root-to-leaf order for one nested root. | Source-derived | `GEM-SRC-DISCOVERY` |
| No boundary marker above a trusted root | The trusted root itself is the ceiling; parents above it are not scanned. | Source-derived | `GEM-SRC-DISCOVERY` |
| Empty `memoryBoundaryMarkers` | Parent traversal is disabled; each trusted root is its own ceiling. | Documented/source-derived | `GEM-SRC-SETTINGS`, `GEM-SRC-DISCOVERY` |
| Invalid boundary marker | Absolute markers and markers containing `..` are skipped by source. Their configuration remains unsafe/invalid for a linter rather than a supported escape mechanism. | Source-derived | `GEM-SRC-DISCOVERY` |
| Multiple workspace/include roots | Results from all roots are inode/device-deduplicated, then sorted lexicographically by absolute path. No semantic root priority is defined. | Source-derived | `GEM-SRC-DISCOVERY` |
| Multiple names in one directory | Upward/JIT discovery checks names in configured order. Startup project paths are later globally sorted, so configured name order is not a stable final order across all roots. | Source-derived | `GEM-SRC-DISCOVERY` |
| Symlink/case aliases | Existing files are deduplicated by followed target identity (`dev:ino`), retaining the first encountered path before the final project sort. | Source-derived; platform-dependent | `GEM-SRC-DISCOVERY` |
| Untrusted workspace | Workspace/project discovery and JIT discovery are suppressed. Global memory still has a separate discovery path. Workspace settings are omitted from the settings merge. | Source-derived/conditional | `GEM-SRC-MANAGER`, `GEM-SRC-SETTINGS` |
| Descendant file at startup | Current discovery does not eagerly recurse below each workspace root. | Source-derived, contradicted by older current docs | `GEM-SRC-DISCOVERY`, `GEM-DOC-CONFIG` |
| Descendant file when a high-intent tool accesses its subtree | The deepest trusted root containing the target is selected; discovery walks from the target directory to the boundary ceiling, root-to-leaf, and injects only not-yet-loaded files. | Documented/source-derived JIT | `GEM-DOC-MEMORY`, `GEM-SRC-DISCOVERY`, `GEM-SRC-JIT` |
| Target outside every trusted root | No JIT context is loaded. | Source-derived | `GEM-SRC-DISCOVERY` |
| New/nonexistent file target | JIT treats it as a file path and begins at its parent directory. | Source-derived | `GEM-SRC-DISCOVERY` |
| Repeated JIT access | Previously loaded path identities are not emitted again in the session. | Source-derived | `GEM-SRC-DISCOVERY`, `GEM-SRC-MANAGER` |
| JIT read error | The primary tool operation continues; JIT errors are swallowed because context is supplementary. | Source-derived | `GEM-SRC-JIT` |

The source names these high-intent integrations: `read_file`,
`list_directory`, `write_file`, `replace`, and `read_many_files`. For
`read_many_files`, unique directories are processed serially so shared
ancestors are injected only once. A static linter can predict candidates for a
specified target, but it cannot call descendant instructions active without a
runtime access event.

## `context.fileName` truth table

| Input/state | Pinned behavior or required linter treatment | State |
| --- | --- | --- |
| Absent | Use `GEMINI.md`. | Documented |
| String | Normalize and prepend the non-empty name; retain the existing default unless it duplicates the supplied name. | Source-derived |
| List | Normalize and prepend valid non-empty entries in first-occurrence order, then retain the existing default if absent. | Source-derived |
| Duplicate values | Deduplicated after path normalization, first occurrence retained. | Source-derived |
| Empty/whitespace values | Skipped; reset logic falls back to `GEMINI.md` if nothing remains. | Source-derived |
| Wrong JSON type or non-string list member | Schema-invalid. The loader records a warning but currently returns the expanded malformed value; downstream effects are not a compatibility contract. | Source-derived/unknown runtime |
| Broken JSON or non-object settings root | Fatal settings error; the CLI requests correction. | Source-derived |
| Name containing separators, absolute path, or `..` | Documentation calls this a filename, while source normalization does not expose a clear workspace-containment policy. Treat as unsafe/unknown and never use it to escape a scan root. | Unknown/security boundary |
| Setting edited during a session | Schema metadata says no restart is required, but configuration is applied during setup and `/memory reload` is not a documented settings reload. Exact live activation is unknown pending observation. | Unknown |

`context.fileName` is a scalar setting at the settings-merge level: a later
settings layer replaces an earlier string/list. It is not concatenated across
layers. Filename-list order and settings-layer precedence are different axes.

## Settings layers and include directories

Persistent settings merge in this order, with later scalar values winning:

1. schema defaults;
2. system defaults;
3. user settings;
4. trusted workspace settings; and
5. system settings as enforced overrides.

Untrusted workspace settings are excluded. Environment files and command-line
arguments affect other runtime values after this persistent merge, so they
must not be represented as additional `settings.json` layers. The CLI has no
direct command-line override for `context.fileName`.

| Setting/event | Pinned behavior | State |
| --- | --- | --- |
| `context.includeDirectories` | Arrays concatenate across settings layers. Entries are resolved relative to the process working directory; CLI `--include-directories` entries are appended. Missing directories are skipped with a warning when workspace roots are initialized. | Documented/source-derived |
| `context.loadMemoryFromIncludeDirectories` | Current schema key and default are exact: boolean, `false`. The manager's ordinary refresh scans all initialized workspace directories, while the flag gates refresh after dynamically adding directories. The settings text instead says it controls which roots `/memory reload` scans. | Contradiction |
| Older `context.loadFromIncludeDirectories` example | This spelling appeared in `GEM-HIST-SETTINGS`, but is absent from the pinned schema, docs, and implementation. It is not an alias. | Historical, unsupported at pinned revision |
| `context.discoveryMaxDirs` | Schema default is `200`, but current ancestor/JIT discovery has no descendant-directory breadth loop and no production call to its getter. The older configuration section still attributes a 200-directory eager scan to it. | Contradiction/inert in reviewed path |
| `context.memoryBoundaryMarkers` | Default `['.git']`; restart required. | Documented/source-derived |
| `context.fileFiltering.*` | Ignore settings require restart. | Documented/source-derived |
| Environment interpolation | Gemini settings permit `$VAR`, `${VAR}`, and documented default expressions. Repository-only linter analysis keeps them inert unless values are supplied as explicit synthetic external context; it never inspects the ambient process environment or a real user configuration directory. | Documented client behavior; linter security boundary |

Because include-directory behavior is internally inconsistent, a profile must
report roots and the flag separately. It must not silently discard an include
root from every refresh path merely because the flag is false.

## Ignore truth table

Ignore behavior belongs to file-discovery tools, not automatically to context
memory discovery.

| Case | Result | State |
| --- | --- | --- |
| `.gitignore` in a Git repository | Used when `respectGitIgnore` is true. | Source-derived |
| `.gitignore` outside a Git repository | No Git ignore parser is created. | Source-derived |
| root `.geminiignore` | Used when `respectGeminiIgnore` is true; supports blank/comment lines, `*`, `?`, classes, directory suffixes, root anchors, and `!` negation. | Documented |
| Custom ignore files | Higher precedence than `.geminiignore` and `.gitignore`; earlier paths in the configured list have higher precedence than later paths. | Documented/source-derived |
| All three enabled | Patterns are combined in order `.gitignore`, `.geminiignore`, then custom; later patterns can negate earlier ones. | Source-derived |
| Only one built-in ignore family enabled | Custom ignores are checked first as an independent filter. A custom negation does not necessarily unignore a path still ignored by the separately evaluated enabled family. | Source-derived edge case |
| Ignore file changes | Parsers read files when the discovery service is constructed; `.geminiignore` documentation and setting metadata require a CLI restart. | Documented/source-derived |
| Ignored ordinary file used by `@` sharing/search | Excluded by tools that support the filter. | Documented |
| `GEMINI.md` matched by an ignore pattern | Current ancestor and JIT memory discovery do not consult the file-discovery ignore service. The older eager-scan documentation says common ignores apply and the current guide links ignores to the context system. | Contradiction; do not mark memory inactive solely from ignore rules |

Ignore pattern validity, ordinary tool visibility, and context-memory activation
must therefore be separate diagnostics.

## Import truth table

| Case | Tree format | Flat format | Evidence state |
| --- | --- | --- | --- |
| Recognition | `@path` begins at start-of-content or after whitespace; path ends at whitespace and starts with `.`, `/`, or an ASCII letter. | Same scanner. | Source-derived |
| Relative base | Resolve relative to the importing file; nested imports change base to the nested file's directory. | Same. | Documented/source-derived |
| Absolute path | Allowed only if its canonical target stays within the inferred allowed root. | Same. | Documented/source-derived |
| Allowed root | Nearest ancestor containing a configured boundary marker; if none, the importing file's directory. | Same. | Source-derived |
| URL | `file:`, `http:`, and `https:` URLs are rejected. | Same. | Source-derived |
| Symlink/path escape | Canonical real paths must remain within the allowed root. Invalid/escaping import becomes an HTML failure comment. | Invalid/escaping import is skipped from the flat file list. | Source-derived |
| Backtick code span/fence | Import text inside matched same-length backtick regions remains literal. | Same. | Source-derived |
| Tilde fence | The pinned scanner recognizes backticks, not tilde fences. Do not promise tilde-fence suppression. | Same. | Source-derived limitation |
| Cycle/repeat | A same-chain repeat becomes `File already processed`; processed sets are copied per branch, so sibling branches may repeat a file. | A global processed set deduplicates repeats and terminates cycles. | Source-derived |
| Depth | Default tree maximum is 5; at the limit, remaining content is returned with deeper imports unexpanded. | The top-level guard exists, but recursive flat processing increments an unused depth argument and does not enforce the advertised limit. | Contradiction |
| Missing/unreadable file | Insert an HTML failure comment and continue. | Keep source file text unchanged and omit the missing target from the flattened file list; warning is debug-only. | Source-derived/documentation contradiction for flat |
| Output order | Imports replace directives inline, wrapped by origin/end comments; import tree preserves encounter order. | Root then unique imports in depth-first encounter order, each wrapped in file markers; raw `@` text remains in each file body. | Source-derived |

The import documentation says the `marked` library detects code regions and
that maximum depth is configurable. The pinned processor uses a backtick regex,
hard-codes a default depth of five, and exposes no reviewed user setting for
that limit. The schema types `context.importFormat` as a string even though
runtime code expects `tree` or `flat`; an unknown value is invalid/unknown for
the profile, not a supported implicit fallback.

## `/memory` and dynamic events

| Event | Pinned result | State |
| --- | --- | --- |
| Client initialization | Constructs the memory manager and refreshes global, extension, trusted workspace, and private project memory before client initialization completes. | Source-derived |
| High-intent tool access | Newly found JIT context is appended to that tool's model-facing output and its identity is marked loaded. | Source-derived |
| `/memory show` | Displays concatenated static hierarchical buckets. The displayed file count comes from all loaded paths, including JIT paths, while JIT text is not added to a static bucket. | Source-derived contradiction with “exact current context” wording |
| `/memory list` | Lists all loaded paths, including paths marked by JIT discovery. | Source-derived |
| `/memory reload` | Clears loaded path/identity sets, re-discovers and reloads static memory, emits `MemoryChanged`, and updates the initialized system instruction. `refresh` is a command alias. | Documented/source-derived |
| Edit a context file | Not guaranteed to update memory automatically; `/memory reload` is the documented activation event. | Documented |
| Add a directory during a session | The directory becomes a workspace root. Immediate memory refresh after `/directory add` is gated by `loadMemoryFromIncludeDirectories`; later explicit refresh behavior conflicts with settings text as described above. | Conditional/source-derived |
| Edit an ignore file | Restart the CLI. | Documented |

The client may separate global memory (system instruction), workspace memory
(initial session context), and JIT tool-result context. “Concatenated order” is
therefore not a complete model-message precedence rule.

## Required profile behavior

| Rule ID | Requirement |
| --- | --- |
| `GEM-PRE-001` | Keep syntax recognition, static candidate discovery, runtime activation, and model-message placement separate. |
| `GEM-PRE-002` | Accept `context.fileName` string/list syntax, preserve configured order as evidence, and model the default-retention behavior without permitting path escape. |
| `GEM-PRE-003` | Require explicit workspace trust and runtime roots before calling project/JIT memory active. |
| `GEM-PRE-004` | Use configured boundary markers for upward discovery and imports, but apply canonical containment as an independent security invariant. |
| `GEM-PRE-005` | Do not implement the stale eager descendant scan or give `discoveryMaxDirs` an invented current effect. |
| `GEM-PRE-006` | Do not use ignore matches alone to deactivate `GEMINI.md`; report memory discovery and tool filtering separately. |
| `GEM-PRE-007` | Preserve tree/flat import differences, including cycle scope, missing-file output, and the flat-depth defect. |
| `GEM-PRE-008` | Treat malformed settings and undocumented setting values as invalid/unknown, never as stable fallbacks inferred from accidental JavaScript coercion. |
| `GEM-PRE-009` | Version every observation with package, source SHA, settings, trust state, roots, fixture hash, and activation event. |
| `GEM-PRE-010` | Never claim a natural-language conflict winner from concatenation order alone. |

## Current gaps and inconsistencies

| Gap ID | Problem | Required treatment |
| --- | --- | --- |
| `GEM-GAP-001` | Dedicated memory guide describes JIT descendants; configuration reference still describes eager recursive descendants and `discoveryMaxDirs=200`. | Use current pinned source for implementation candidates; retain contradiction until observed/reconciled upstream. |
| `GEM-GAP-002` | `loadMemoryFromIncludeDirectories` documentation says false limits `/memory reload` to the current directory, but manager refresh uses every initialized workspace root. | Conditional/contradiction; test both startup and dynamic-add events. |
| `GEM-GAP-003` | Import docs claim `marked` code-region parsing; source uses a backtick regex. | Source-derived scanner behavior, with tilde/nested Markdown cases retained as test targets. |
| `GEM-GAP-004` | Import docs claim configurable max depth; no setting was located, and flat recursion does not enforce the default guard. | Tree depth 5 source-derived; flat depth contradiction. |
| `GEM-GAP-005` | Import docs promise graceful error comments generally; flat mode silently omits failed targets from its list. | Format-specific result. |
| `GEM-GAP-006` | `/memory show` is documented as exact current hierarchical context; JIT paths affect its count/list but their content is not stored in its static buckets. | Do not use `show` alone as a JIT content oracle. |
| `GEM-GAP-007` | Schema says several context settings do not require restart, but setup-time application and settings-cache behavior leave live-edit activation unclear. | Require an explicit event/version observation. |
| `GEM-GAP-008` | Current docs link ignore files to context, while current memory discovery bypasses ignore filtering. | Separate file-tool filtering from memory activation. |

## Conformance plan

Build synthetic repository fixtures with the D01 v0 contract; B02 may later
provide public types without changing these semantics. Use unique markers for
global, boundary ancestor, workspace, nested descendants, include roots,
imports, and ignore rules. The corpus must cover:

- trusted and untrusted workspaces; no marker, file marker, directory marker,
  multiple markers, empty marker list, nested repositories, symlinks, and
  overlapping workspace roots;
- filename string/list ordering, duplicates, empty entries, malformed JSON,
  wrong types, unsafe path-like names, and every persistent settings layer;
- startup, `/memory show`, `/memory list`, `/memory reload`, repeated JIT
  accesses, nonexistent write targets, and dynamic `/directory add` events;
- `.gitignore`, `.geminiignore`, multiple custom ignore files, negations,
  disabled flags, non-Git roots, and restart/no-restart trials;
- relative, absolute, nested, duplicate, cyclic, escaping, symlinked, missing,
  unreadable, code-span, backtick-fence, tilde-fence, and depth 4/5/6 imports in
  both tree and flat formats; and
- `discoveryMaxDirs` values around 0, 1, and 200 without assuming they affect
  current JIT discovery.

The D09 canonical seed fixtures are
[`gemini-hierarchy-jit.fixture.json`](../../../conformance/fixtures/v0/gemini-hierarchy-jit.fixture.json),
[`gemini-import-modes.fixture.json`](../../../conformance/fixtures/v0/gemini-import-modes.fixture.json),
and
[`gemini-ignore-memory-ambiguity.fixture.json`](../../../conformance/fixtures/v0/gemini-ignore-memory-ambiguity.fixture.json).
They preserve unresolved runtime and source/documentation contradictions rather
than erasing them with guessed behavior. D10 now implements the deterministic
parts and emits explicit issues for the unresolved parts; see the
[Gemini CLI profile contract](../../api/gemini-cli-profile.md). The dedicated
offline research validator cross-checks fixture snapshots and evidence
references against this truth table.

The installed CLI exposes no guaranteed no-auth command that prints memory
discovery. `/memory` is an interactive command, and entering that session may
start authentication or model-backed behavior. D09 therefore records
`blocked-paid-observation` rather than spending quota. D15/D16 may run the
behavior matrix only after explicit authorization, using an isolated synthetic
home and never a user's existing Gemini configuration.

D15 now encodes that decision in
`conformance/observations/v0/gemini-no-safe-signal.plan.json`. Validation and
recording of this case never opens Gemini CLI. The separate sandboxed
`--version` adapter can pin client metadata but cannot resolve `/memory`, JIT,
import, ignore, or setting contradictions; those remain for D16 as explicit
unknowns unless a reviewed no-model signal becomes available.

The [D16 GA review](../ga-observation-review-2026-08-02.md) now supplies the reviewed blocked
transcript for stable `0.53.1` and binds it to all three canonical Gemini fixtures. The source and
package pins match, but the blocked transcript does not resolve JIT, import, ignore, settings, or
interactive-memory contradictions. No Gemini executable, authentication flow, or model endpoint was
opened by D16.

The later ten-repository validation must run the finished linter read-only
against pinned external repository SHAs. It must not commit, push, open issues,
or otherwise modify those repositories. External repositories are diversity
inputs, not client-behavior oracles; hierarchy/JIT expectations remain grounded
in the controlled fixture and pinned Gemini evidence.

## Security boundary

The research data and its validator are offline, data-only inputs. Validation
must not fetch source URLs, execute Gemini CLI, enter an interactive session,
read a real Gemini home, or expand settings placeholders. Repository filenames,
settings, ignore patterns, Markdown, imports, symlinks, and event paths remain
untrusted. D10 discovery and imports use the repository read facade, canonical
containment, bounded work, and explicit synthetic external context;
neither `context.fileName` nor an import may grant access outside the selected
root.

## Maintenance checklist

1. Resolve both the stable release tag and current main to immutable SHAs.
2. Diff every source-registry file across those SHAs and record any semantic drift.
3. Recheck the npm version, integrity, supported Node range, and CLI help.
4. Re-run the synthetic event matrix with a new isolated home and fixture commit.
5. Revisit every `GEM-GAP-*` item; do not erase a contradiction with one run.
6. Keep raw transcripts free of credentials, user paths, prompts, and model output.
7. Validate the finished profile on the controlled corpus before the ten read-only external repositories.
