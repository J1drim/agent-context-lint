# Claude Code instruction compatibility contract

Status: D04 specification complete; D16 recorded an explicit blocked current-client observation.

Specification snapshot: 2026-08-01

Target surface: Claude Code CLI project instructions and project rules. Auto
memory, skills, subagents, hooks, permissions, and model adherence are outside
this syntax/profile contract except where they change instruction discovery.

D01 maps this research into the
[v0 profile conformance fixture contract](../../contracts/profile-conformance-fixture-v0.md).
Launch, read, compact, and settings events remain explicit; unknown sibling
ordering and external approval state are not converted into deterministic
assertions.

## Evidence policy

All deterministic claims below are based on current first-party documentation.
They have not yet been promoted to `observed`; D16 must exercise the scenarios
in this document against a pinned Claude Code version without allowing the
fixture repository to execute commands or access secrets.

The profile uses these evidence labels:

| Label | Meaning | Implementation treatment |
|---|---|---|
| `documented` | Explicit in a cited first-party source | May drive deterministic resolution, subject to version range |
| `documented-versioned` | Explicit and tied to a client version boundary | Select behavior from the configured client version |
| `unknown` | Current sources do not define an exact result | Preserve alternatives and emit conditional/unknown evidence |
| `out-of-repository` | Depends on machine, user, policy, approval, or launch state | Do not claim the repository alone determines the result |
| `pending-observation` | A deterministic claim awaiting D16 | Keep provenance and test scenario attached |

No statement about whether Claude follows an instruction is a linter guarantee.
Claude Code injects these files as context rather than an enforcement layer.

## Sources and provenance

| ID | First-party source | Retrieved | Scope |
|---|---|---|---|
| `CC-MEMORY` | [How Claude remembers your project](https://code.claude.com/docs/en/memory) | 2026-08-01 | Locations, resolution order, imports, rules, exclusions, version changes |
| `CC-SETTINGS` | [Claude Code settings](https://code.claude.com/docs/en/settings) | 2026-08-01 | Setting scopes, precedence, setting sources |
| `CC-PERMISSIONS` | [Configure permissions](https://code.claude.com/docs/en/permissions) | 2026-08-01 | Additional-directory discovery boundary |
| `CC-DEBUG` | [Debug your configuration](https://code.claude.com/docs/en/debug-your-config) | 2026-08-01 | `/context`, `/memory`, safe-mode observation |
| `CC-CLI` | [CLI reference](https://code.claude.com/docs/en/cli-reference) | 2026-08-01 | `--add-dir`, `--setting-sources`, runtime controls |

Documentation is mutable. D16 must capture the installed client version and an
immutable observation artifact. A future standards update must diff both the
source snapshot and real-client evidence before changing profile behavior.

## Resolution vocabulary

| Term | Definition |
|---|---|
| launch directory | Process working directory when Claude Code starts |
| working tree | Repository-visible tree under analysis |
| ancestor chain | Directories from filesystem root through the launch directory |
| descendant | Directory below the launch directory |
| launch-loaded | Included when the session starts |
| on-demand | Included only after Claude reads a file in the relevant subtree |
| unconditional rule | Rule file without a `paths` frontmatter field |
| path-scoped rule | Rule file with a `paths` frontmatter field |
| external import | Project instruction import resolving outside the working directory |

The linter's `scanRoot` is not automatically the client's launch directory. A
caller or profile configuration must provide the intended launch path. If it
does not, the linter evaluates repository-visible alternatives and labels the
result conditional instead of selecting one silently.

## Instruction-source inventory

| Priority/scope | Location | Repository-visible by default | Activation | Evidence |
|---|---|---:|---|---|
| Managed | platform-specific managed `CLAUDE.md` or managed `claudeMd` setting | No | Launch | `documented`, `out-of-repository` |
| User | `~/.claude/CLAUDE.md` | No | Launch | `documented`, `out-of-repository` |
| User rules | `~/.claude/rules/**/*.md` | No | Launch or path match | `documented`, `out-of-repository` |
| Project | repository `CLAUDE.md` | Yes | Launch for ancestors; on-demand for descendants | `documented` |
| Project alternate | repository `.claude/CLAUDE.md` | Yes | Project instruction source | `documented`; exact sibling ordering is `unknown` |
| Project rules | repository `.claude/rules/**/*.md` | Yes | Launch if unconditional; otherwise on matching read | `documented` |
| Local | `CLAUDE.local.md` | Sometimes, normally ignored | Launch for ancestors; on-demand for descendants | `documented` |
| Additional directory | instruction sources under a `--add-dir` directory | Not necessarily | Only when the opt-in environment variable is set | `documented`, runtime-dependent |
| Auto memory | machine-local `MEMORY.md` and topic files | No | Index at launch; topics on-demand | Out of this profile |

Managed instructions load before user and project instructions and cannot be
excluded. User instructions load before project instructions. Repository-only
analysis therefore reports that unseen higher-level context may exist.

## Launch and on-demand truth table

Assume a session launched at `/repo/apps/api`, with `/repo` as the repository
root. "Include" means include the source in the effective context state, not
that model compliance is guaranteed.

| Case | Candidate | Event | Expected state/result | Evidence |
|---|---|---|---|---|
| `CC-LOAD-01` | `/repo/CLAUDE.md` | Launch | Include at launch | `documented` |
| `CC-LOAD-02` | `/repo/CLAUDE.local.md` | Launch | Include after `/repo/CLAUDE.md` at that level | `documented` |
| `CC-LOAD-03` | `/repo/apps/CLAUDE.md` | Launch | Include at launch after `/repo` sources | `documented` |
| `CC-LOAD-04` | `/repo/apps/api/CLAUDE.md` | Launch | Include at launch after broader ancestors | `documented` |
| `CC-LOAD-05` | `/repo/other/CLAUDE.md` | Launch | Do not include yet | `documented` |
| `CC-LOAD-06` | `/repo/other/CLAUDE.md` | Read `/repo/other/x.ts` | Include on demand for that subtree | `documented` |
| `CC-LOAD-07` | `/repo/other/CLAUDE.local.md` | Read `/repo/other/x.ts` | Include on demand after sibling `CLAUDE.md` | `documented` |
| `CC-LOAD-08` | Two ancestor `CLAUDE.md` files | Launch | Concatenate; broader filesystem path first, launch-nearer last | `documented` |
| `CC-LOAD-09` | `CLAUDE.md` and `CLAUDE.local.md` in one directory | Activation | Concatenate shared file first, local file second | `documented` |
| `CC-LOAD-10` | Conflicting active instructions | Activation | Keep both; client docs do not define semantic conflict resolution | `documented` discovery, semantic result `unknown` |
| `CC-LOAD-11` | Descendant file after `/compact` | Compact only | Do not automatically re-inject | `documented` |
| `CC-LOAD-12` | Descendant file after `/compact` then matching read | Read | Load again on demand | `documented` |
| `CC-LOAD-13` | Project-root `CLAUDE.md` after `/compact` | Compact | Re-read and re-inject | `documented` |
| `CC-LOAD-14` | Empty instruction file | Activation | Discovered, but exact context representation is unspecified | `unknown` |
| `CC-LOAD-15` | Non-UTF-8/invalidly encoded file | Activation | Decode/error behavior is unspecified | `unknown` |
| `CC-LOAD-16` | Symlinked `CLAUDE.md` | Activation | Docs show a `CLAUDE.md` symlink as supported; escape and cycle details unspecified | Partly `documented` |

### Ordering contract

The supported deterministic ordering is:

1. managed instruction scope;
2. user instruction and user-rule scope;
3. project sources from the filesystem root toward the launch directory;
4. within a directory, `CLAUDE.md` before `CLAUDE.local.md`;
5. descendant sources enter later when their subtree is read.

Current documentation calls repository-root `CLAUDE.md` and
`.claude/CLAUDE.md` project instruction locations but does not define their
relative order when both exist. It also says unconditional project rules have
the same priority as `.claude/CLAUDE.md` without defining a stable filename
order. The linter must not invent either order. It should preserve a partial
order and flag order-sensitive conflicts as conditional.

## Import truth table

Imports are syntax inside instruction files, not generic Markdown links.

| Case | Input/condition | Expected result | Evidence |
|---|---|---|---|
| `CC-IMPORT-01` | `@docs/policy.md` in plain Markdown | Import the referenced file | `documented` |
| `CC-IMPORT-02` | Relative import | Resolve relative to the containing instruction file | `documented` |
| `CC-IMPORT-03` | Absolute import | Supported; classify repository escape if outside scan root | `documented` |
| `CC-IMPORT-04` | `@path` inside an inline code span | Treat as literal, not an import | `documented` |
| `CC-IMPORT-05` | `@path` inside a fenced code block | Treat as literal, not an import | `documented` |
| `CC-IMPORT-06` | Import chain within four recursive hops | Expand recursively | `documented` |
| `CC-IMPORT-07` | Import beyond four recursive hops | Do not claim expansion beyond the supported limit | `documented`; exact truncation diagnostic `unknown` |
| `CC-IMPORT-08` | Project import resolves outside working directory | Require first-use approval before client loads it | `documented`, runtime-dependent |
| `CC-IMPORT-09` | External import approval declined | Import remains disabled and prompt does not recur | `documented`, runtime-dependent |
| `CC-IMPORT-10` | Import from user-scope instruction | Load without project external-import dialog | `documented`, `out-of-repository` |
| `CC-IMPORT-11` | Missing target | Exact error and retained context behavior unspecified | `unknown` |
| `CC-IMPORT-12` | Import cycle | Cycle behavior unspecified | `unknown` |
| `CC-IMPORT-13` | Directory target | Directory expansion behavior unspecified | `unknown` |
| `CC-IMPORT-14` | Escaped, percent-encoded, or case-variant path | Filesystem/platform behavior unspecified | `unknown` |

The resolver must detect imports without following untrusted paths first. It
must apply the safe-filesystem policy before reading targets, retain the raw
token and containing-file span, and represent approval as `unknown` unless the
caller provides explicit session state. It must never prompt for approval or
write Claude configuration during linting.

## Rule truth table

Project rules are recursively discovered Markdown files under
`.claude/rules/`. User rules are out-of-repository inputs.

| Case | Rule | Event | Expected result | Evidence |
|---|---|---|---|---|
| `CC-RULE-01` | `.claude/rules/testing.md`, no `paths` | Launch | Load unconditionally | `documented` |
| `CC-RULE-02` | Nested `.claude/rules/backend/api.md`, no `paths` | Launch | Discover recursively and load | `documented` |
| `CC-RULE-03` | `paths: ["src/api/**/*.ts"]` | Launch only | Do not activate yet | `documented` |
| `CC-RULE-04` | Same rule | Read `src/api/users.ts` | Activate | `documented` |
| `CC-RULE-05` | Same rule | Read `test/users.ts` | Do not activate | `documented` |
| `CC-RULE-06` | No `paths` field | Any session | Unconditional | `documented` |
| `CC-RULE-07` | Multiple path patterns | Any one pattern matches | Activate rule once | `documented`; dedup identity detail `pending-observation` |
| `CC-RULE-08` | `*.md` | Read root `README.md` | Match | `documented` |
| `CC-RULE-09` | `*.md` | Read `docs/README.md` | Do not match | `documented` |
| `CC-RULE-10` | `src/**/*.{ts,tsx}` | Matching read | Apply brace expansion | `documented` |
| `CC-RULE-11` | Expansion stays within budget | Parse | Use expanded patterns | `documented-versioned` |
| `CC-RULE-12` | Expansion would exceed 1,000 patterns or 4 MiB | Parse | Use the over-budget pattern unexpanded; literal braces match nothing | `documented-versioned` |
| `CC-RULE-13` | Invalid bracket expression plus valid sibling pattern | Read | Invalid pattern matches nothing; siblings continue | `documented-versioned` |
| `CC-RULE-14` | Symlink to shared rule file/directory | Discovery | Resolve and load; detect circular symlinks gracefully | `documented` |
| `CC-RULE-15` | YAML parses but `paths` has unsupported type | Parse | Exact recovery behavior unspecified | `unknown` |
| `CC-RULE-16` | Malformed YAML frontmatter | Parse | Exact recovery behavior unspecified | `unknown` |
| `CC-RULE-17` | Two rules conflict | Activation | Both are context; semantic winner unspecified | `unknown` |
| `CC-RULE-18` | Rule has HTML block comment | Activation | Strip block comment from injected content | `documented` by general instruction behavior; rule-specific observation pending |

Paths are expressed relative to the project root in official examples. The
documentation describes glob syntax through examples but does not name or pin
the underlying glob library. The compatibility implementation must cover the
documented cases and retain `unknown` for undocumented syntax rather than
claiming full minimatch, gitignore, or shell-glob compatibility.

## Exclusion truth table

`claudeMdExcludes` is a settings array whose patterns match absolute file paths.

| Case | Configuration/target | Expected result | Evidence |
|---|---|---|---|
| `CC-EXCLUDE-01` | Exact absolute path matches project `CLAUDE.md` | Skip that instruction file | `documented` |
| `CC-EXCLUDE-02` | Glob matches `.claude/rules/**` | Skip matching rules | `documented` |
| `CC-EXCLUDE-03` | Values exist in multiple settings scopes | Merge arrays | `documented` |
| `CC-EXCLUDE-04` | Pattern matches managed instruction | Do not exclude managed instruction | `documented` |
| `CC-EXCLUDE-05` | User/local settings are unavailable to repository scan | Resolution | Report possible exclusions as external assumptions | `out-of-repository` |
| `CC-EXCLUDE-06` | Relative exclusion pattern | Resolution | No deterministic match claim; docs specify absolute-path matching | `unknown` |
| `CC-EXCLUDE-07` | Case differs on case-insensitive filesystem | Resolution | Platform behavior unspecified | `unknown` |

Settings normally resolve managed, command-line, local, project, then user for
scalar precedence, while some values merge. `claudeMdExcludes` specifically
merges across layers. Repository-only analysis can read project settings but
cannot conclude the final merged list unless all active setting sources and
runtime overrides are supplied.

## Content transformation truth table

| Case | Content | Expected injected content | Evidence |
|---|---|---|---|
| `CC-CONTENT-01` | Block-level `<!-- comment -->` | Comment removed | `documented` |
| `CC-CONTENT-02` | HTML comment inside fenced code | Comment preserved | `documented` |
| `CC-CONTENT-03` | Instruction file over 200 lines | Load in full; 200 lines is guidance, not a CLAUDE.md limit | `documented` |
| `CC-CONTENT-04` | Imported files make source larger | Import still enters launch context; splitting does not save context | `documented` |
| `CC-CONTENT-05` | Frontmatter in a project rule | Use `paths` for activation; exclude frontmatter from instruction body | Body transformation `pending-observation` |
| `CC-CONTENT-06` | CRLF, BOM, NUL, invalid Unicode | Exact normalization/error behavior | `unknown` |

The separate 200-line/25-KiB startup truncation applies to auto-memory
`MEMORY.md`, not to `CLAUDE.md`. The linter must not apply that auto-memory
limit to project instructions.

## Additional-directory truth table

| Case | Runtime state | Expected instruction discovery | Evidence |
|---|---|---|---|
| `CC-ADDDIR-01` | `--add-dir ../shared`, no enabling environment variable | Grant file access but do not load its instruction files | `documented` |
| `CC-ADDDIR-02` | Same flag plus `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | Load `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, and eligible local instructions | `documented` |
| `CC-ADDDIR-03` | Environment enabled but `local` excluded from `--setting-sources` | Skip `CLAUDE.local.md` from added directory | `documented` |
| `CC-ADDDIR-04` | Repository scan lacks launch flags/environment | Resolution | Return conditional alternatives, not a definitive effective context | `out-of-repository` |

The official additional-directory table writes `.claude/rules/*.md`; it does
not explicitly promise recursive `**/*.md` discovery in added directories.
Until D16 observes this, nested added-directory rules remain `unknown`.

## Runtime-mode truth table

Runtime flags can suppress repository instructions even when every file is
otherwise valid. These values are external inputs to a repository-only scan.

| Case | Runtime state | Expected instruction discovery | Evidence |
|---|---|---|---|
| `CC-MODE-01` | Normal invocation | Use active setting sources and the resolution rules above | `documented` |
| `CC-MODE-02` | `--bare` | Skip auto-discovery of `CLAUDE.md` along with the other documented customizations | `documented` |
| `CC-MODE-03` | `--safe-mode` | Do not load project, user, or managed `CLAUDE.md` customizations | `documented` |
| `CC-MODE-04` | `--setting-sources user,project` | Exclude the `local` source, including `CLAUDE.local.md` eligibility | `documented` |
| `CC-MODE-05` | `--setting-sources` omits `project` on version `2.1.211+` | Skip project rules, including on-demand and path-scoped rules | `documented-versioned` |
| `CC-MODE-06` | Runtime flags unavailable to the linter | Preserve normal/bare/safe/source-filter alternatives as external assumptions | `out-of-repository` |

Safe mode still applies managed settings policy, but current CLI documentation
explicitly says managed `CLAUDE.md` does not load. The profile must distinguish
enforceable settings policy from behavioral instruction context.

## Version-sensitive behavior

| Boundary | Behavior at/after boundary | Earlier behavior | Profile action |
|---|---|---|---|
| `2.1.198` | Path rules match files reached through a symlinked project path | Not documented as supported | Treat symlink-path activation as version-sensitive |
| `2.1.207` | One invalid glob matches nothing while sibling patterns continue | Before `2.1.207`, invalid pattern could make every evaluated Read fail | Model legacy failure separately; never reproduce a crash |
| `2.1.211` | Excluding project setting source also skips on-demand/path-scoped rules; loaded-content sizing fixed for auto memory | Earlier on-demand rules could load despite exclusion; auto-memory check measured raw file | Apply source exclusion boundary; auto-memory note is non-profile context |
| `2.1.217` | Brace expansion is bounded by 1,000 patterns and 4 MiB without startup stall/crash | Earlier large brace groups could stall or crash startup | Always enforce safe bound; report legacy client risk without emulating denial of service |

The source documents version boundaries but does not publish a stable machine
readable compatibility schema. D16 must pin at least the then-current release
and, where safely obtainable, the boundary versions needed to validate these
branches. Unsupported or unavailable old binaries are documented rather than
downloaded from untrusted mirrors.

## Profile output requirements

For every resolved source, the future Claude Code profile must retain:

- normalized path and original path spelling;
- scope and repository visibility;
- discovery reason and activation event;
- load state (`launch`, `on-demand-active`, `on-demand-inactive`, `excluded`,
  `approval-required`, or `unknown`);
- partial ordering constraints rather than an invented total order;
- source byte span and transformed-content provenance;
- import parent, depth, target state, and repository-boundary result;
- configured client version and applicable version branch;
- source citation and observation ID;
- unresolved external assumptions.

The profile must not read outside the allowed scan boundary merely to answer an
external-context question. It must not invoke Claude Code during normal linting.

## D16 conformance plan

D16 will convert the cases above into versioned fixtures and observation
records. The observation harness must:

1. create a disposable repository and disposable Claude configuration home;
2. deny hooks and tool execution from fixtures;
3. remove credentials and network access where the client supports doing so;
4. use `/context`, `/memory`, `InstructionsLoaded`, or debug logs only when they
   can expose discovery without a paid model request;
5. record client version, platform, invocation, fixture hash, setting sources,
   environment allowlist, actual loaded-source sequence, and raw redacted log;
6. cover launch, a matching descendant read, a non-matching read, compaction,
   external-import approval states, exclusions, symlinks, invalid glob recovery,
   and version boundaries;
7. mark a case `blocked-paid-observation` instead of spending API/plan quota;
8. keep machine/user/managed state isolated so a developer's configuration
   cannot contaminate expected results.

At minimum, D16 must settle the unknown ordering of simultaneous
`CLAUDE.md`, `.claude/CLAUDE.md`, and unconditional rule files before D05 treats
their order as deterministic. Unknown decode, malformed-frontmatter, import
cycle, and missing-target behavior may remain conditional if the client exposes
no safe observable signal; the implementation must still fail safely.

### D16 result

The [2026-08-02 GA review](../ga-observation-review-2026-08-02.md) pins official current release
`2.1.220` and its darwin-arm64 artifact digest. No installed, guaranteed no-model instruction-list
signal was available, so D15 recorded `blocked` without opening Claude Code. The fixture's
`2.1.217` version remains the compatible minimum safety branch; simultaneous-source order and all
other client-only questions above remain explicit unknowns.

## Acceptance checklist for D04

- [x] Launch-time and on-demand states are distinct.
- [x] Ancestor, descendant, local, alternate project, and rule sources are inventoried.
- [x] Concatenation constraints and undocumented ordering are explicit.
- [x] Import parsing, depth, approval, and safe-boundary behavior are specified.
- [x] Rule activation, glob examples, budgets, invalid patterns, and symlinks are specified.
- [x] Exclusions and unavailable settings are represented conditionally.
- [x] Bare, safe, and setting-source runtime modes are represented conditionally.
- [x] Comment stripping and size-limit distinctions are recorded.
- [x] Version changes are tied to client-version branches.
- [x] A no-cost, isolated live-client observation plan is defined for D16.
- [x] First-party sources and retrieval date are recorded.
