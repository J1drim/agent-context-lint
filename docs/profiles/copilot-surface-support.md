# GitHub Copilot surface support research

| Record field | Value |
| --- | --- |
| Research record | `copilot-surfaces/2026-08-01.0` |
| Retrieved | 2026-08-01 |
| Status | D06 research baseline; not a parser, profile, or fixture contract |

This document records the official, currently documented behavior of four
different Copilot clients. It exists to prevent the implementation from
treating “GitHub Copilot” as one discovery and precedence model. The companion
[truth-table data](data/copilot-surface-facts.v0.json) is intentionally
schema-neutral and non-contractual. D01 maps its stable surface IDs into the
[v0 conformance contract](../contracts/profile-conformance-fixture-v0.md)
without preempting B02's future public types.

No client was invoked to produce this record. In particular, no premium
request, hosted coding-agent task, or code review was started. Claims below are
documentation claims, not observations, unless explicitly labelled otherwise.

## Reading the tables

The evidence states have narrow meanings:

| State | Meaning |
| --- | --- |
| Documented | An official page affirmatively describes this behavior for the named surface. |
| Conditional | The behavior is behind a setting, model-selected, or contradicted by another current official page. |
| Not listed | The current official support matrix does not list the feature for this surface. This is not generalized into a claim about all versions. |
| Unknown | The reviewed official sources do not define the behavior precisely enough for the linter to decide it. |

“Unknown” must never be converted into definitely active, definitely inactive,
or an error by a Copilot profile. Syntax recognition and client activation are
separate decisions.

## Surface identities

| Stable research ID | Surface in this document | Important boundary |
| --- | --- | --- |
| `copilot-cli` | GitHub Copilot CLI | Terminal client and its own discovery rules. |
| `copilot-vscode` | Local Copilot Chat in Visual Studio Code | Does not include the separately listed VS Code cloud agent or local VS Code code-review row in GitHub's support matrix. |
| `copilot-cloud-agent` | Copilot coding agent on GitHub | Hosted coding agent, called “Copilot cloud agent” by the support matrix. |
| `copilot-code-review` | Copilot code review on GitHub | Hosted pull-request review. This is not the local VS Code code-review surface. |

## Source registry

Only GitHub and Visual Studio Code primary documentation was used.

| ID | Official source | Surface/version note |
| --- | --- | --- |
| `GH-CLI` | [Adding repository custom instructions for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions) | Living GitHub Docs page; no CLI version is stated. |
| `GH-MATRIX` | [Support for different types of custom instructions](https://docs.github.com/en/copilot/reference/custom-instructions-support) | Living GitHub Docs support matrix; no client versions are stated. |
| `GH-REPO` | [Adding repository custom instructions for GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions) | Living GitHub Docs page for GitHub-hosted experiences; no service version is stated. |
| `GH-REVIEW` | [Using GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review?tool=vscode) | Living GitHub Docs page; current text says instructions are read from the pull request's head branch. |
| `GH-REVIEW-TUTORIAL` | [Customizing Copilot code review](https://docs.github.com/en/copilot/tutorials/customize-code-review) | Living GitHub Docs tutorial; describes the roughly 1,000-line recommendation and lack of external-link retrieval. |
| `VSC-INSTRUCTIONS` | [Use custom instructions in VS Code](https://code.visualstudio.com/docs/agent-customization/custom-instructions) | Page snapshot showed 2026-07-29. No extension or editor build is pinned by the page. |
| `VSC-OVERVIEW` | [Customize AI in VS Code](https://code.visualstudio.com/docs/agent-customization/overview) | Page snapshot showed 2026-07-29. Parent-repository behavior is settings-dependent. |
| `VSC-SETTINGS` | [AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings) | Current settings reference retrieved 2026-08-01; exact VS Code and extension versions are not stated. |

All URLs and claims must be rechecked when a profile release is prepared. Living
documentation is not a substitute for a pinned client observation.

## Scope assumptions

The record makes only these explicit scoping assumptions:

- GitHub's “Copilot cloud agent” support-matrix row maps to the hosted coding
  agent represented here by `copilot-cloud-agent`.
- GitHub.com's code-review row maps to `copilot-code-review`; the separate local
  VS Code code-review row does not.
- VS Code's local Copilot Chat documentation maps to `copilot-vscode`; its cloud
  agent entrypoints remain part of the hosted coding-agent surface.
- A syntax example proves only the shown example, not an exhaustive glob or
  frontmatter grammar.
- “Not listed” describes the retrieved matrix snapshot only. Feature rollout,
  product plan, enterprise policy, and older or newer client versions can differ.
- Hosted-service behavior may change without a client version. Any subsequent
  observation therefore needs a timestamp in addition to fixture provenance.

## Format and location support matrix

| Location or format | CLI | VS Code Chat | Coding agent | Code review |
| --- | --- | --- | --- | --- |
| Root `.github/copilot-instructions.md` | Documented; discovered at standard roots | Documented; always included for workspace chat requests | Documented | Documented |
| `.github/instructions/**/*.instructions.md` | Documented; recursive, but not searched in intermediate directories | Documented; recursive under configured instruction folders | Documented | Documented for files in the review whose `applyTo` matches |
| Root `AGENTS.md` | Documented | Documented; enabled by default | Documented | Documented |
| Nested `AGENTS.md` | Documented through CLI standard-location traversal | Conditional; experimental setting, with agent-selected relevance | Documented generically for GitHub-hosted Copilot; nearest file wins for the relevant directory | Unknown: the review-specific page names only root `AGENTS.md`, while a generic GitHub-hosted page describes nested files |
| Root `CLAUDE.md` | Documented; `.claude/CLAUDE.md` is also recognized | Conditional/version-dependent: VS Code documents it, while GitHub's current VS Code Chat matrix omits it | Documented alternative | Not listed in the current matrix |
| Root `GEMINI.md` | Documented | Not listed in the current matrix | Documented alternative | Not listed in the current matrix |
| User instruction files | Documented under `$HOME/.copilot`, or the `COPILOT_HOME` replacement | Documented through configured user instruction folders | Not listed in the current matrix | Not listed in the current matrix |
| Organization instructions | Not listed in the current matrix | Documented and enabled by default | Documented | Documented |

Absence from the current support matrix is recorded as `Not listed`, rather
than promoted to a permanent incompatibility claim.

## Copilot CLI

| Topic | Documented behavior | Boundary or unresolved point | Sources |
| --- | --- | --- | --- |
| Discovery roots | Standard locations include the repository root, current working directory, intermediate directories, and directories nested in the path of a file on which Copilot is working. | The precise traversal ordering is not documented. | `GH-CLI` |
| Repository-wide file | `.github/copilot-instructions.md` is searched in standard locations. | When multiple standard locations contain this file, relative ordering is unknown. | `GH-CLI` |
| Path-specific files | `.github/instructions/**/*.instructions.md` is searched recursively at standard locations, except intermediate directories are not searched for these files. | The effective base directory for a nested file's `applyTo` patterns is not stated. | `GH-CLI` |
| Agent files | `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, and `GEMINI.md` are supported at standard locations. | Conflict ordering among different file families is not documented. | `GH-CLI`, `GH-MATRIX` |
| User files | `$HOME/.copilot/copilot-instructions.md` and `$HOME/.copilot/instructions/**/*.instructions.md` are supported. `COPILOT_HOME` replaces the `$HOME/.copilot` root. | Interaction between `COPILOT_HOME` and extra instruction directories is not assigned precedence. | `GH-CLI` |
| Extra roots | `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` accepts comma-separated directories and adds `AGENTS.md` and `*.instructions.md` discovery. | Traversal, symlink, duplicate-path, and precedence behavior are not documented. | `GH-CLI` |
| `applyTo` syntax | A comma-separated list of glob patterns is documented, including `*`, `**`, `**/*`, `*.py`, `**/*.py`, `src/*.py`, `src/**/*.py`, and `**/subdir/**/*.py`. | The docs do not name a formal glob dialect, escaping rules, case sensitivity, dotfile rules, symlink treatment, or the base for nested instruction files. | `GH-CLI` |
| Activation | A path-specific file applies only if `applyTo` matches a file being worked on. `/instructions` shows discovered files and supports enable/disable controls. | “File being worked on” is client state, not a property a static linter can always know. | `GH-CLI` |
| `excludeAgent` | The field and values `code-review` and `cloud-agent` are documented for hosted surfaces. | No CLI exclusion value or CLI effect is documented; a CLI profile must preserve but not use this field to deactivate the file. | `GH-REPO` |
| `@` references | Relative references are expanded in `.github/copilot-instructions.md`, `AGENTS.md`, and `CLAUDE.md`; immediate and nested references are supported. | References are not expanded in `GEMINI.md` or `*.instructions.md`. Cycle handling and maximum depth are unknown. | `GH-CLI` |
| Reference boundary | Repository instructions may reference only files in the repository; local instructions may reference only files in their custom-instruction directory. Absolute paths and `~/` references are rejected. | Symlink and canonical-path behavior are not documented; the linter must enforce its own safe containment check without claiming client equivalence. | `GH-CLI` |
| Combination and deduplication | Multiple applicable user and repository files are combined. Identical copies of user `copilot-instructions.md`, repository-wide instructions, and agent instructions are removed. | General order, winner semantics for conflicting content, normalization before deduplication, and path-file deduplication are unknown. | `GH-CLI` |
| Session timing | Instruction changes require exiting and starting or resuming a session before they take effect. | No filesystem watch behavior is documented inside a running session. | `GH-CLI` |
| Size and count limits | No hard file-size, line-count, instruction-count, import-depth, or aggregate-context limit is stated in the reviewed CLI documentation. | Do not invent limits. Resource guidance may be advisory only until a versioned client establishes behavior. | `GH-CLI` |

## VS Code Copilot Chat

| Topic | Documented behavior | Boundary or unresolved point | Sources |
| --- | --- | --- | --- |
| Workspace root | Discovery normally stays within open workspace roots. `.github/copilot-instructions.md` at a workspace root is included in every workspace chat request. | Multi-root workspace ordering and duplicate handling are not documented. | `VSC-INSTRUCTIONS`, `VSC-OVERVIEW` |
| Path-specific files | `.instructions.md` files are discovered recursively beneath configured instruction folders. The default workspace folder is `.github/instructions`; additional workspace and user folders are configurable. | Ordering across configured locations is not documented. | `VSC-INSTRUCTIONS`, `VSC-SETTINGS` |
| Frontmatter | `name`, `description`, and `applyTo` are documented optional fields for `.instructions.md`. | Unknown frontmatter-key behavior is not defined by the page. | `VSC-INSTRUCTIONS` |
| Glob syntax and base | `applyTo` is relative to the workspace root. Comma-separated patterns and brace patterns are shown. `**` matches all files. | The page does not define the underlying glob library, case sensitivity, escaping, dotfile, or symlink semantics. | `VSC-INSTRUCTIONS` |
| Missing `applyTo` | One section says a file without `applyTo` is not added automatically but may be manually attached. | The same page also says the agent determines relevance from `applyTo` or semantic matching of `description`. Automatic description-only activation is therefore conditional/ambiguous until a pinned observation resolves it. | `VSC-INSTRUCTIONS` |
| Agent files | Root `AGENTS.md` is enabled by default with `chat.useAgentsMdFile`. | Nested files are a distinct experimental mode. | `VSC-INSTRUCTIONS`, `VSC-SETTINGS` |
| Nested agent files | `chat.useNestedAgentsMdFiles` defaults to false. When enabled, VS Code recursively discovers nested files and the agent decides which apply based on files it edits. | This is not a deterministic nearest-directory rule. A static result should be conditional, not active by default. | `VSC-INSTRUCTIONS`, `VSC-SETTINGS` |
| Parent repository | `chat.useCustomizationsInParentRepositories` defaults false. When enabled, a workspace without its own `.git` may inherit from a trusted parent repository, walking upward to the parent `.git`. | Behavior for nested repositories, worktrees, symlinks, and multiple parent candidates is not stated. | `VSC-OVERVIEW`, `VSC-SETTINGS` |
| Markdown references | Markdown links can reference files and URLs. Referenced-instruction inclusion has a separate `chat.includeReferencedInstructions` setting, default false. | The docs do not specify recursive import semantics, cycles, maximum depth, repository containment, or whether every ordinary link is loaded. Do not reuse CLI `@` rules. | `VSC-INSTRUCTIONS`, `VSC-SETTINGS` |
| Ordering | Multiple instruction files may be combined, and no specific order is guaranteed. Personal instructions have higher priority than repository instructions, which have higher priority than organization instructions; all relevant instructions are still supplied. | No stable within-repository order or textual “winner” is promised. | `VSC-INSTRUCTIONS` |
| Activation controls | Applying-instruction diagnostics are enabled by default. Root repository instructions, matching path instructions, root agent files, organization instructions, and manual attachments have separate controls. | Model-selected relevance is not statically reproducible. | `VSC-INSTRUCTIONS`, `VSC-SETTINGS` |
| `excludeAgent` | No effect for local VS Code Chat is documented in the reviewed VS Code pages. | Preserve the field as syntax, but do not filter local Chat based on hosted-agent values. | `VSC-INSTRUCTIONS`, `GH-REPO` |
| Size and count limits | No hard file-size, line-count, file-count, link-depth, or aggregate-context limit is stated. | Do not turn context-window pressure into a fabricated validation limit. | `VSC-INSTRUCTIONS` |
| Version drift | VS Code documents `CLAUDE.md` support and a default-enabled setting, while GitHub's current support matrix omits Claude instructions from the VS Code Chat row. | Treat Claude activation as version-dependent/conditional until a pinned extension and editor observation exists. | `VSC-INSTRUCTIONS`, `VSC-SETTINGS`, `GH-MATRIX` |

## Copilot coding agent

| Topic | Documented behavior | Boundary or unresolved point | Sources |
| --- | --- | --- | --- |
| Repository-wide file | Root `.github/copilot-instructions.md` is supported. | Hosted discovery outside the checked-out repository is not documented. | `GH-REPO`, `GH-MATRIX` |
| Path-specific files | `.github/instructions/**/*.instructions.md` is supported recursively; matching files combine with repository-wide instructions. | The base of `applyTo` patterns and the formal glob dialect are not stated. | `GH-REPO` |
| `applyTo` syntax | Comma-separated globs and the standard examples listed for CLI are documented. | Case sensitivity, brace support, escaping, dotfile, and symlink semantics are unknown. | `GH-REPO` |
| Agent files | One or more `AGENTS.md` files may appear anywhere; the nearest file in the relevant directory tree takes precedence. A single root `CLAUDE.md` or `GEMINI.md` is documented as an alternative. | Precedence between an agent file and `.github` instruction families is not defined. “Relevant directory” may depend on work selected by the agent. | `GH-REPO`, `GH-MATRIX` |
| `excludeAgent` | `excludeAgent: cloud-agent` excludes the path-specific instruction file from coding-agent use. Omitting the field permits both hosted agents. | Unknown values and multiple values are not documented. | `GH-REPO` |
| Organization precedence | Repository instructions have higher priority than organization instructions, while all relevant instructions are passed to Copilot. | The matrix does not list personal instructions for the coding agent; do not import the broader personal-priority rule into this surface. | `GH-REPO`, `GH-MATRIX` |
| Imports and references | No `@` import, Markdown-import recursion, import boundary, cycle rule, or depth limit is documented for the hosted coding agent in the reviewed sources. | CLI reference rules must not be transferred to this surface. Natural-language links are not proof of content loading. | `GH-REPO`, `GH-MATRIX` |
| Activation event | Repository instructions are available after they are committed to the repository and are used automatically for coding-agent requests. | The reviewed sources do not pin whether every task reads the default, task, or another branch at each lifecycle stage. | `GH-REPO` |
| Size and count limits | No hard per-file, aggregate, nesting, or import limit is stated in the reviewed pages. | Do not guess hosted context limits. | `GH-REPO` |
| Settings | `excludeAgent` controls per-file exclusion. Repository and organization policy settings exist outside the file syntax. | Exact enterprise/policy interactions and rollout versions are not part of these pages. | `GH-REPO` |

## Copilot code review on GitHub

| Topic | Documented behavior | Boundary or unresolved point | Sources |
| --- | --- | --- | --- |
| Repository-wide file | Root `.github/copilot-instructions.md` is supported. | The local VS Code code-review row has different support and is outside this surface. | `GH-REVIEW`, `GH-MATRIX` |
| Path-specific files | `.github/instructions/**/*.instructions.md` is supported for reviewed files matched by `applyTo`. | Formal glob dialect and pattern base are not stated. | `GH-REVIEW`, `GH-REPO` |
| Agent files | The review-specific page documents root `AGENTS.md`. | A generic GitHub-hosted page describes nested `AGENTS.md` with nearest-file precedence. Because the specific page does not, nested review behavior remains unknown. | `GH-REVIEW`, `GH-REPO` |
| Other agent formats | `CLAUDE.md` and `GEMINI.md` are not listed for GitHub.com code review in the current support matrix. | Record this as versioned “not listed,” not a permanent parser error. | `GH-MATRIX` |
| `excludeAgent` | `excludeAgent: code-review` excludes a path-specific instruction file from code review. Omitting the field permits both hosted agents. | Unknown values and multiple values are not documented. | `GH-REPO` |
| Branch snapshot | Code review reads instructions from the pull request's head branch, not the base branch. | Timing for force-pushes, queued reviews, and concurrent updates is not specified. | `GH-REVIEW`, `GH-REVIEW-TUTORIAL` |
| Trigger | Reviews can be requested manually. Automatic reviews and review after each push are configurable. | Reviews are non-deterministic; trigger and discovery can be checked, but exact comments are not a stable oracle. | `GH-REVIEW` |
| Ordering and precedence | Personal instructions are described as higher priority than repository instructions, which are higher than organization instructions; all relevant instructions are passed. | No ordering among repository-wide, path-specific, and agent files is stated. | `GH-REPO` |
| Imports and links | The tutorial explicitly says code review does not follow external links. | Internal Markdown references, `@` imports, recursion, cycles, repository boundary, and maximum depth are not documented. | `GH-REVIEW-TUTORIAL` |
| Size guidance | GitHub recommends keeping custom instructions to about 1,000 lines to reduce ignored guidance. | This is advisory, not a hard acceptance limit. Overall context limits are not stated. | `GH-REVIEW-TUTORIAL` |
| Settings | Use of custom instructions for code review is enabled by default and can be disabled in repository settings. Automatic review and re-review-on-push are separate controls. | Organization policy and rollout interactions are not fully specified by the reviewed pages. | `GH-REPO`, `GH-REVIEW` |

## Precedence and uncertainty rules for implementation

| Rule ID | Linter rule | Confidence |
| --- | --- | --- |
| `COP-PRE-001` | Keep syntax parsing independent from the selected Copilot surface profile. A recognized file can be inactive, conditional, or unknown for a surface without becoming invalid syntax. | Required architecture |
| `COP-PRE-002` | Do not create a universal Copilot order. CLI has combination and limited identical-copy deduplication; VS Code promises no within-set order; hosted documentation gives only broad instruction-level priorities and limited nearest-`AGENTS.md` behavior. | Documented |
| `COP-PRE-003` | Model `excludeAgent: cloud-agent` and `excludeAgent: code-review` only for their named hosted surfaces. Preserve it without changing CLI or local VS Code activation. | Documented |
| `COP-PRE-004` | Never assume the CLI glob base, hosted glob base, or a common glob engine. VS Code alone explicitly states workspace-root-relative patterns. | Documented plus unknown boundaries |
| `COP-PRE-005` | Apply CLI `@` expansion only to the file families documented by the CLI page and enforce a conservative containment boundary. Do not project it onto VS Code or hosted clients. | Documented plus safety policy |
| `COP-PRE-006` | Report unknown activation as unknown. In particular: VS Code description-only activation, code-review nested `AGENTS.md`, hosted import behavior, multi-root ordering, and all undocumented size limits. | Required uncertainty policy |
| `COP-PRE-007` | Treat the code-review 1,000-line statement as advisory. It cannot justify a parse failure or hard limit. | Documented |
| `COP-PRE-008` | Preserve branch provenance in observations. Current code-review documentation names the pull request head branch; no reviewed coding-agent source establishes an equivalent lifecycle rule. | Documented/unknown split |
| `COP-PRE-009` | Version settings and client observations. Current living docs do not pin CLI, extension, editor, or hosted rollout versions. | Required provenance policy |

## Current contradictions and gaps

These are test targets, not invitations to select a preferred interpretation.

| Gap ID | Evidence conflict or omission | Required treatment before observation |
| --- | --- | --- |
| `COP-GAP-001` | VS Code says a missing `applyTo` prevents automatic inclusion, but also describes semantic matching through `description`. | Conditional/unknown automatic activation. |
| `COP-GAP-002` | VS Code documents Claude-instruction support, while GitHub's VS Code Chat row omits it. | Conditional/version-dependent. |
| `COP-GAP-003` | The generic GitHub-hosted instructions page describes nested `AGENTS.md`; the code-review-specific page names root `AGENTS.md`. | Root documented; nested unknown for code review. |
| `COP-GAP-004` | CLI and hosted GitHub pages show glob examples but do not state the base for nested path-specific instruction files. | Parse patterns; do not claim a definitive match. |
| `COP-GAP-005` | Broad priority exists for personal/repository/organization instructions, but stable ordering within repository instruction families is absent. | No deterministic content winner. |
| `COP-GAP-006` | CLI documents reference expansion and boundaries; hosted surfaces do not. VS Code documents links but not equivalent import recursion. | Separate surface behaviors. |
| `COP-GAP-007` | No reviewed source defines symlink traversal, path canonicalization, case sensitivity, deduplication normalization, cycles, import depth, or hard size limits comprehensively. | Unknown, with independent conservative security checks allowed. |
| `COP-GAP-008` | VS Code documents open-workspace roots and optional parent-repository inheritance but not multi-root ordering. | Discover candidates; report order unknown. |

## No-paid-call observation and conformance plan

The observation plan is deliberately staged. Stage 0 and most of stage 1 require
no model invocation. Hosted stages are deferred until the project explicitly
authorizes an account, repository, and budget.

### Stage 0: static conformance corpus

Create project-owned synthetic repository fixtures using the D01 v0 contract;
B02 may later provide public types without changing these semantics. Use unique
marker strings and include:

- root and nested copies of every documented instruction family;
- matching, nonmatching, missing, comma-separated, brace, malformed, and
  overlapping `applyTo` values;
- both documented `excludeAgent` values, omission, and an unknown value;
- relative, nested, duplicate, cyclic, absolute, home-relative, escaping, and
  symlinked reference targets;
- duplicate and contradictory text across user, repository-wide,
  path-specific, organization-simulated, and agent files;
- nested repository and multi-root workspace layouts;
- files above, inside, and outside each documented boundary; and
- separate base/head contents so branch provenance can be observed.

Expected results must cite fact IDs from the JSON file. Unknown cases must have
an observation target but no fabricated expected client outcome.

### Stage 1: local discovery observations without model requests

For VS Code, use the Customizations view, instruction diagnostics, reference
list, and setting inspection without sending a chat request. Record:

- VS Code build, Copilot extension version, operating system, workspace trust,
  workspace-root layout, and every relevant setting value;
- the discovered file list, diagnostic applicability output, and screenshots or
  structured logs where the client exposes them; and
- fixture commit and content hashes, with credentials and user paths redacted.

For CLI, first record `copilot --version` and available help. Do not enter a
session or invoke `/instructions` if doing so may consume an entitlement. If a
future version exposes a guaranteed local-only discovery command, capture its
output against the same fixture. Otherwise defer CLI behavioral observation to
an explicitly approved budgeted stage.

### Stage 2: controlled client calls, deferred

Only after explicit approval, run a small, deterministic matrix in a
project-owned private synthetic repository. Never modify, open pull requests in,
or contact the randomly selected external validation repositories.

For each client and case, record the exact version or hosted timestamp, account
plan, settings, fixture commit, event that triggered discovery, marker evidence,
and repeated-trial count. For non-deterministic surfaces, distinguish “file was
made available” from “model followed the text.” Use at least three trials before
classifying a stability observation, while retaining every raw result.

Coding-agent cases should test root/path/agent discovery, nearest nested agent
files, both exclusions, and source-branch timing. Code-review cases should test
head-versus-base content, matching reviewed files, root versus nested
`AGENTS.md`, exclusions, manual versus automatic triggers, re-review after a
push, and internal/external reference behavior. CLI cases should test standard
and extra roots, intermediate-directory asymmetry, duplicate copies, session
refresh, each allowed/disallowed reference family, boundary escapes, cycles,
and the unknown nested-file glob base. VS Code request cases should be limited
to gaps not resolved by local diagnostics, especially description-only
activation and Claude support.

### Promotion rule

An observation may become a profile behavior only when it includes a pinned
client version or hosted observation date, reproducible fixture, raw evidence,
and QA/profile-owner review. A single observed run does not erase a documented
contradiction. Documentation and observations should coexist with explicit
scope until the upstream product publishes a stable rule.

### D16 result

The [2026-08-02 GA review](ga-observation-review-2026-08-02.md) pins Copilot CLI `1.0.77` and the
latest official Copilot Chat GitHub release artifact `0.43.0`. Neither surface exposed an approved
no-model behavioral signal in this environment: CLI is blocked and VS Code requires reviewed manual
IDE observation. The new CLI fixture preserves cross-family ordering alternatives, and the existing
VS Code description-only contradiction remains unpinned and explicit. No chat, entitlement, or
hosted request was used.

## Maintenance checklist

On every Copilot profile release:

1. Re-open every source URL and record retrieval time and any displayed page
   version or date.
2. Diff the official support matrix by surface, including the distinct local
   and hosted VS Code rows.
3. Recheck defaults for every named setting and capture exact client versions.
4. Review all `COP-GAP-*` entries; resolve only with versioned evidence.
5. Run the synthetic conformance corpus and retain raw evidence.
6. Keep advisory guidance, security-policy findings, syntax validity, and
   surface activation as separate diagnostic dimensions.
