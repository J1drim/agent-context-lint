# Cursor project-rule compatibility contract

Status: D11 specification and validated research data complete; D12 bounded syntax adapters and D13
stateful activation/relevance resolver implemented. Behavioral client conformance remains part of
D16.

Specification snapshot: 2026-08-02

Pinned local clients:

- Cursor IDE CLI launcher: `3.12.30` (`arm64`, commit `63a2996a10d9e476b6c28e951dd7691d9c0cf480`)
- Cursor Agent CLI: `2026.05.24-dda726e`

Target surface: repository-owned Cursor MDC project rules, nested rule roots, rule activation modes,
file references, and legacy `.cursorrules` recognition. User/team rules, memories, skills, commands,
hooks, and model adherence are outside this contract except where they make repository-only
conclusions conditional.

D01 maps Cursor IDE and Agent CLI as separate surfaces in the
[v0 profile conformance fixture contract](../../contracts/profile-conformance-fixture-v0.md).
Model-selected relevance and undocumented MDC interactions require explicit fixture ambiguity rather
than a guessed activation result.

The D12 [Cursor rule syntax API](../../api/cursor-rule-syntax.md) implements the syntax-only field
matrix, nested source-location derivation, inert reference candidates, and legacy recognition
described here. It intentionally grants no glob-match, relevance, or activation authority.

The D13 [stateful Cursor profile API](../../api/cursor-profile.md) evaluates those syntax records
against caller-supplied workspace, settings, version, and event snapshots. It keeps mechanical
Always/Auto/Manual channels separate from model-selected Agent Requested relevance and preserves the
unknown behavior in this contract rather than inventing client semantics.

The companion schema-neutral [truth-table data](../data/cursor-rule-facts.v0.json) mirrors all 71
cases in this document. It is a research artifact, not a published product schema or an
activation-authority input. The closed validator rejects missing cases, unapproved sources, source
substitution, canonical-mode drift, paid-observation promotion, unknown fields, oversized/malformed
input, NUL bytes, and symlinks.

## Evidence policy

The project uses these evidence labels:

| Label                  | Meaning                                                                | Profile treatment                                       |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `documented`           | Current first-party documentation states the behavior                  | May drive a deterministic branch after D16 confirmation |
| `documented-versioned` | First-party source ties behavior to a release                          | Select only for matching versions                       |
| `observed-metadata`    | A local binary exposed version/help output without a model call        | Establishes surface/version only, not rule activation   |
| `model-selected`       | Cursor describes the Agent as making a relevance decision              | Preserve as conditional; never predict as deterministic |
| `unknown`              | No current first-party source defines the exact result                 | Preserve alternatives; do not infer a winner            |
| `out-of-repository`    | Result depends on user/team settings, active surface, or runtime state | Report the assumption with repository findings          |

Rule inclusion is model context, not an enforcement mechanism. The linter can determine that a rule
is eligible or definitely attached only where the client contract supports that conclusion; it
cannot guarantee adherence.

## Sources and provenance

| ID                             | First-party source                                                                                   | Retrieved  | Scope                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| `CURSOR-RULES`                 | [Rules](https://cursor.com/docs/rules)                                                               | 2026-08-02 | Project rules, MDC fields, four activation modes, nested rules, references, legacy file |
| `CURSOR-CLI`                   | [Using Agent in CLI](https://cursor.com/docs/cli/using)                                              | 2026-08-02 | CLI rule support and root instruction sources                                           |
| `CURSOR-CHANGE-045`            | [`.cursor/rules`, better codebase understanding, new Tab model](https://cursor.com/changelog/0-45-x) | 2026-08-02 | First versioned project-rule release; Agent relevance selection                         |
| `CURSOR-CHANGE-049`            | [Rules generation and improved Agent terminal](https://cursor.com/changelog/0-49)                    | 2026-08-02 | Auto-attachment on Agent reads/writes and long-conversation Always fix                  |
| `CURSOR-CLI-CHANGE-2026-01-08` | [New CLI features and performance](https://cursor.com/changelog/cli-jan-08-2026)                     | 2026-08-02 | `agent` entry point and CLI rule management                                             |
| `LOCAL-CURSOR-2026-08-02`      | [Local metadata observation](observations/2026-08-02-local-metadata.md)                              | 2026-08-02 | Installed IDE/Agent versions and launcher warning; no activation claims                 |

Cursor's current documentation is rendered dynamically and its public text does not identify a
documentation revision hash or a formal MDC schema. The retrieval date, client versions, and local
transcript are therefore mandatory provenance. Future profile updates must archive a source diff or
reviewed snapshot before changing deterministic behavior.

The current rules page and current CLI page do not tie their statements to an IDE or Agent CLI
version. Consequently, they establish documented current behavior but do not prove that every
statement applies to the pinned local binaries. Conversely, metadata-only version output establishes
which binaries were present but proves no rule behavior. The versioned `0.45` and `0.49` changelogs
establish historical boundaries only for the statements they make. These evidence classes stay
separate in both the prose and JSON record.

## Surface and source inventory

| Surface/source              | Location                                                      | Repository-visible | Documented behavior                                                                         |
| --------------------------- | ------------------------------------------------------------- | -----------------: | ------------------------------------------------------------------------------------------- |
| IDE project rules           | `.cursor/rules/*.mdc` and nested `.cursor/rules/` directories |                Yes | Four activation modes; applies to Agent and Inline Edit according to the current rules page |
| Agent CLI project rules     | `.cursor/rules/`                                              |                Yes | CLI says it supports the same rules system as the IDE                                       |
| Agent CLI root instructions | repository-root `AGENTS.md`, `CLAUDE.md`                      |                Yes | CLI reads both and applies them alongside project rules                                     |
| IDE `AGENTS.md`             | repository root in the cited rules guide                      |                Yes | Plain Markdown alternative; detailed semantics are not part of D11                          |
| Legacy rules                | repository-root `.cursorrules`                                |                Yes | Still recognized but deprecated                                                             |
| User rules                  | Cursor Settings                                               |                 No | Plain text, globally active                                                                 |
| Team/managed state          | Account/organization configuration                            |                 No | Exact interaction with repository rule conflicts is not specified here                      |
| Memories                    | Client state                                                  |                 No | Not a repository project-rule source                                                        |

IDE and Agent CLI are separate profile surfaces even when both recognize the same `.cursor/rules`
files. A claim observed in one surface must not be copied to the other without first-party evidence
or a separate D16 observation.

## MDC parse truth table

MDC is Markdown content preceded by delimiter-based metadata. Current docs show the fields
`description`, `globs`, and `alwaysApply`, but do not publish a formal grammar or claim full YAML
compatibility.

| Case            | Input/condition                                                                | Classification/result                                         | Evidence                                |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------- |
| `CURSOR-MDC-01` | `.cursor/rules/service.mdc` with opening and closing `---` metadata delimiters | Recognized project-rule candidate                             | `documented`                            |
| `CURSOR-MDC-02` | Markdown body follows metadata                                                 | Retain body as instruction content                            | `documented`                            |
| `CURSOR-MDC-03` | `description` is a non-empty string                                            | Retain as relevance metadata                                  | `documented`                            |
| `CURSOR-MDC-04` | `globs` is non-empty                                                           | Retain as path activation metadata                            | `documented`; grammar details `unknown` |
| `CURSOR-MDC-05` | `alwaysApply: true`                                                            | Retain as Always-mode signal                                  | `documented`                            |
| `CURSOR-MDC-06` | `alwaysApply: false`                                                           | Do not classify without considering `description` and `globs` | `documented`                            |
| `CURSOR-MDC-07` | Metadata is missing                                                            | Candidate is malformed/unsupported, not silently Always       | Exact client recovery `unknown`         |
| `CURSOR-MDC-08` | Closing delimiter is missing                                                   | Candidate is malformed                                        | Exact client recovery `unknown`         |
| `CURSOR-MDC-09` | Unknown metadata key                                                           | Preserve key and report unsupported metadata                  | Client handling `unknown`               |
| `CURSOR-MDC-10` | Duplicate metadata key                                                         | Preserve spans and report ambiguity                           | Winner/recovery `unknown`               |
| `CURSOR-MDC-11` | `alwaysApply` is a string or number                                            | Report invalid field type                                     | Coercion behavior `unknown`             |
| `CURSOR-MDC-12` | `description` is empty/whitespace                                              | Treat as absent for safe classification and record raw value  | Whitespace semantics `unknown`          |
| `CURSOR-MDC-13` | `globs` is empty/whitespace                                                    | Treat as absent for safe classification and record raw value  | Whitespace semantics `unknown`          |
| `CURSOR-MDC-14` | `.md` file under `.cursor/rules/`                                              | Do not claim MDC support from current docs                    | `unknown`                               |
| `CURSOR-MDC-15` | `.mdc` contains BOM, NUL, invalid Unicode, or non-UTF-8 bytes                  | Fail safely and preserve diagnostic span                      | Client decode behavior `unknown`        |

The parser may use a hardened YAML-frontmatter library as an implementation detail, but the profile
cannot equate that library's entire accepted language with Cursor's undocumented MDC language.

## Activation-mode truth table

The four documented modes are represented as states, not as a total precedence order. Canonical
combinations are those the documentation describes or the Cursor rule editor generates.

| Case             | `alwaysApply` | `globs`      | `description`                     | Classification/activation                                               | Evidence                                                      |
| ---------------- | ------------: | ------------ | --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `CURSOR-MODE-01` |        `true` | empty        | empty/optional                    | `always`; include in every supported model context                      | `documented`                                                  |
| `CURSOR-MODE-02` |       `false` | non-empty    | empty/optional                    | `auto-attached`; include when a matching file is referenced             | `documented`                                                  |
| `CURSOR-MODE-03` |       `false` | empty        | non-empty                         | `agent-requested`; Agent decides from description relevance             | `documented`, `model-selected`                                |
| `CURSOR-MODE-04` |       `false` | empty        | empty                             | `manual`; include only when explicitly mentioned as `@ruleName`         | `documented`                                                  |
| `CURSOR-MODE-05` |        `true` | non-empty    | any                               | Mixed form; do not assume Always overrides glob                         | Exact precedence `unknown`                                    |
| `CURSOR-MODE-06` |        `true` | empty        | non-empty                         | Eligible Always, but description's additional role is unspecified       | Partly `documented`                                           |
| `CURSOR-MODE-07` |       `false` | non-empty    | non-empty                         | Mixed Auto/Agent form; retain both possible activation channels         | Exact interaction `unknown`                                   |
| `CURSOR-MODE-08` |       missing | empty        | empty                             | Malformed/ambiguous, not safely classifiable as Manual                  | `unknown`                                                     |
| `CURSOR-MODE-09` |       missing | non-empty    | empty                             | Path metadata present, but exact missing-boolean default is unspecified | `unknown`                                                     |
| `CURSOR-MODE-10` |       missing | empty        | non-empty                         | Description makes it Agent-eligible; default handling still unspecified | `model-selected`, partly `unknown`                            |
| `CURSOR-MODE-11` |       `false` | matching     | any                               | File reference creates deterministic Auto eligibility                   | `documented`                                                  |
| `CURSOR-MODE-12` |       `false` | non-matching | any                               | Glob channel inactive; description channel may remain if present        | `documented` plus mixed-form `unknown`                        |
| `CURSOR-MODE-13` |       `false` | empty        | relevant description              | Linter cannot decide inclusion, only Agent eligibility                  | `model-selected`                                              |
| `CURSOR-MODE-14` |       `false` | empty        | empty, explicit `@ruleName` event | Activate manual rule for that event                                     | `documented`                                                  |
| `CURSOR-MODE-15` |           any | any          | any                               | No triggering event/target trace supplied                               | Return possible states; do not fabricate an effective context | Profile requirement |

### Event model

An Auto rule reacts to referenced files. Cursor's `0.49` changelog explicitly expanded/fixed
automatic application when Agent reads or writes matching files. The stateful profile therefore
recognizes at least these event kinds:

- user-attached or explicitly referenced file;
- active file/context reference exposed by the surface;
- Agent read of a path;
- Agent write of a path;
- explicit `@ruleName` mention.

The exact IDE definition of "referenced" beyond those documented cases is unknown. Open tabs, search
results, directory mentions, diffs, terminal output, and indirect references must not activate a
rule deterministically without a pinned observation.

## Glob truth table

Current first-party docs require a file pattern for Auto Attached rules but do not publish a
complete glob grammar, base directory, case policy, separator policy, list encoding, or
invalid-pattern recovery behavior.

| Case             | Condition                                                                          | Profile result                                                       | Evidence                  |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| `CURSOR-GLOB-01` | A configured pattern matches a referenced file under the documented pattern subset | Auto channel eligible                                                | `documented`              |
| `CURSOR-GLOB-02` | No configured pattern matches                                                      | Auto channel inactive                                                | `documented`              |
| `CURSOR-GLOB-03` | Multiple patterns encoded as comma-separated scalar                                | Preserve as a candidate encoding; do not promise split semantics yet | `unknown`                 |
| `CURSOR-GLOB-04` | Multiple patterns encoded as a YAML-style list                                     | Preserve as a candidate encoding; do not promise client support yet  | `unknown`                 |
| `CURSOR-GLOB-05` | Brace expansion such as `*.{ts,tsx}`                                               | Do not claim support                                                 | `unknown`                 |
| `CURSOR-GLOB-06` | `*.ts` versus `**/*.ts`                                                            | Do not infer recursive equivalence                                   | `unknown`                 |
| `CURSOR-GLOB-07` | Pattern begins `/` or `./`                                                         | Base/anchoring semantics unspecified                                 | `unknown`                 |
| `CURSOR-GLOB-08` | Backslashes on Windows                                                             | Separator/escape semantics unspecified                               | `unknown`                 |
| `CURSOR-GLOB-09` | Case differs from filesystem entry                                                 | Case policy unspecified                                              | `unknown`                 |
| `CURSOR-GLOB-10` | Invalid or adversarial pattern                                                     | Bound parsing and return malformed/unknown without crash             | Recovery `unknown`        |
| `CURSOR-GLOB-11` | File reached through a symlink                                                     | Match logical and real paths safely; report both alternatives        | Client behavior `unknown` |

D16 must observe the generated format from the pinned rule editor and exercise single/multiple
pattern encodings before D12 treats either list form as supported. Community reports are useful test
leads, not compatibility evidence.

## Nested-root truth table

Assume `/repo` is the workspace and a nested rule directory exists at
`/repo/backend/server/.cursor/rules/`.

| Case             | Event/target                                                 | Expected state                                                     | Evidence                                             |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- |
| `CURSOR-NEST-01` | Reference `/repo/backend/server/api.ts`                      | Nested rules become location-eligible                              | `documented`                                         |
| `CURSOR-NEST-02` | Reference `/repo/frontend/app.ts`                            | Backend nested rules are not location-eligible                     | `documented`                                         |
| `CURSOR-NEST-03` | Nested Always rule and in-scope file reference               | Attach under documented nested behavior                            | `documented`; exact metadata interaction pending D16 |
| `CURSOR-NEST-04` | Nested Auto rule with matching glob and in-scope file        | Both location and glob conditions are satisfied                    | `documented`; conjunction semantics pending D16      |
| `CURSOR-NEST-05` | Nested Auto rule with non-matching glob but in-scope file    | Location says attach while glob says no; preserve contradiction    | `unknown`                                            |
| `CURSOR-NEST-06` | Nested Agent Requested rule in scope                         | Make available to Agent; selection remains conditional             | `model-selected`                                     |
| `CURSOR-NEST-07` | Nested Manual rule in scope, no explicit mention             | Do not claim automatic inclusion                                   | Exact nested override `unknown`                      |
| `CURSOR-NEST-08` | Same rule name in root and nested directories                | Preserve both identities                                           | Lookup/dedup/precedence `unknown`                    |
| `CURSOR-NEST-09` | `.cursor/rules` reached through symlink or escapes workspace | Enforce scan boundary before traversal                             | Client behavior `unknown`                            |
| `CURSOR-NEST-10` | Multi-root IDE workspace                                     | Resolve per supplied root; cross-root ordering remains conditional | `unknown`, surface-dependent                         |

The first-party phrase "nested rules automatically attach when files in their directory are
referenced" is not precise about whether nesting overrides each rule's selected activation type. The
profile keeps location eligibility and metadata eligibility as separate dimensions until D16
resolves the interaction.

## Reference truth table

The rules guide states that `@filename.ts` references include files as additional context when the
containing rule triggers.

| Case            | Reference/condition                                     | Expected result                                                           | Evidence                                         |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `CURSOR-REF-01` | `@service-template.ts` in active rule content           | Include referenced file as additional context                             | `documented`                                     |
| `CURSOR-REF-02` | Reference in inactive rule                              | Do not eagerly include target                                             | `documented` by trigger wording                  |
| `CURSOR-REF-03` | Reference path relative to rule file versus workspace   | Preserve both candidates                                                  | Base directory `unknown`                         |
| `CURSOR-REF-04` | Reference points to another `.mdc` rule                 | Treat as a file reference candidate, not proven recursive rule activation | `unknown`                                        |
| `CURSOR-REF-05` | Reference chain or cycle                                | Bound traversal and report cycle                                          | Client depth/cycle behavior `unknown`            |
| `CURSOR-REF-06` | Missing reference target                                | Report unresolved reference                                               | Exact client recovery `unknown`                  |
| `CURSOR-REF-07` | Target resolves outside workspace                       | Block read by default and report boundary escape                          | Client permission/prompt behavior `unknown`      |
| `CURSOR-REF-08` | `@name` inside inline code or fenced code               | Preserve literal-versus-reference alternatives                            | Parser behavior `unknown`                        |
| `CURSOR-REF-09` | Spaces, quoting, fragments, or punctuation in reference | Preserve raw token and span                                               | Tokenization `unknown`                           |
| `CURSOR-REF-10` | Manual `@ruleName` mention                              | Activate the identified Manual rule                                       | `documented`; duplicate-name selection `unknown` |

The linter must parse and boundary-check before reading a target. It must never launch Cursor,
approve access, or expand an external target during normal lint.

## Legacy and cross-surface truth table

| Case                | Source/surface                        | Expected result                                                  | Evidence                                               |
| ------------------- | ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `CURSOR-SURFACE-01` | Root `.cursorrules` in IDE            | Recognize as supported legacy source and emit migration guidance | `documented`                                           |
| `CURSOR-SURFACE-02` | Nested `.cursorrules`                 | Do not claim support                                             | Root-only source documented; nested behavior `unknown` |
| `CURSOR-SURFACE-03` | `.cursorrules` plus MDC project rules | Recognize both; do not invent precedence or dedup                | Interaction `unknown`                                  |
| `CURSOR-SURFACE-04` | IDE project MDC rule                  | Evaluate IDE event state                                         | `documented`                                           |
| `CURSOR-SURFACE-05` | Agent CLI project MDC rule            | Evaluate CLI event state separately                              | `documented`                                           |
| `CURSOR-SURFACE-06` | Agent CLI root `AGENTS.md`            | Recognize as CLI rule source                                     | `documented`                                           |
| `CURSOR-SURFACE-07` | Agent CLI root `CLAUDE.md`            | Recognize as CLI rule source                                     | `documented`                                           |
| `CURSOR-SURFACE-08` | IDE root `CLAUDE.md`                  | Do not copy CLI support claim to IDE                             | IDE behavior `unknown`                                 |
| `CURSOR-SURFACE-09` | Active user/team rules unavailable    | Report unseen external context assumption                        | `out-of-repository`                                    |
| `CURSOR-SURFACE-10` | Same repo opened at a subdirectory    | Keep workspace-root assumption explicit                          | Root discovery behavior `unknown`                      |

Legacy support is a recognition and migration concern; the linter never rewrites or deletes
`.cursorrules` unless a later explicit safe-fix ticket implements and the user requests that fix.

## Version-sensitive behavior

| Boundary                       | Documented change                                                                                                       | Profile action                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Cursor `0.49`                  | Auto Attached rules apply when Agent reads or writes matching files; Always persistence in long conversations was fixed | Include read/write events for `0.49+`; do not promise prior persistence |
| Agent CLI changelog 2026-01-08 | `agent` became the primary CLI entry point; `cursor-agent` remains an alias; `/rules` management added                  | Treat command name as surface metadata, not different rule semantics    |

Current docs contain historical language around root versus nested `AGENTS.md` support that changed
over time. D11 does not define an IDE AGENTS profile from that material. D16 must pin and observe
the relevant IDE and CLI versions before another ticket makes deterministic nested-AGENTS claims.

## Profile output requirements

For each Cursor candidate and event projection, D12/D13 must retain:

- client surface and version;
- workspace root and nested rule-root scope;
- normalized path plus original spelling;
- raw metadata, parsed supported fields, unknown fields, and source spans;
- canonical, mixed, malformed, or unknown mode classification;
- location eligibility, glob eligibility, semantic eligibility, manual trigger, and final
  known/conditional activation as separate fields;
- triggering file/reference/read/write event and target path;
- reference parent, raw token, candidate bases, resolved state, and cycle/depth;
- legacy status and migration evidence;
- source citation, observation ID, and all external assumptions.

The resolver must preserve a partial state such as "Agent Requested and eligible" without converting
it to active or inactive.

## D16 conformance plan

Behavioral observation requires an authenticated model surface and may consume a subscription or API
quota, so D11 performed only no-cost version/help discovery. D16 must not run a paid request without
explicit project authorization. Its disposable harness must:

1. isolate workspace and Cursor configuration/state directories;
2. deny shell commands, writes, external reads, MCP, hooks, plugins, and network where the selected
   client offers such controls;
3. capture IDE and Agent CLI versions separately;
4. create rules through the client editor where possible and record exact MDC;
5. exercise all four canonical modes, every mixed combination, one and multiple glob encodings,
   nested metadata interaction, reference bases/cycles, duplicate names, legacy coexistence, and
   root/subdirectory launch;
6. record only synthetic marker text and redact account/workspace identifiers;
7. store invocation, event trace, fixture hash, expected state, actual source sequence, and raw
   redacted evidence;
8. label model-selected outcomes as observations of that run, never universal rules;
9. mark the case `blocked-paid-observation` if no free local signal exists.

Before D12 treats mixed metadata, glob lists, nested precedence, or reference bases as supported,
D16 must either settle the behavior on both GA surfaces or leave the result explicitly conditional.

### D16 result

The [2026-08-02 GA review](../ga-observation-review-2026-08-02.md) retains the local IDE
`3.12.30`/`63a2996a…` and Agent CLI `2026.05.24-dda726e` metadata pins. The IDE requires reviewed
manual observation. The installed CLI launcher resides under user state and would require child
execution that D15 correctly denies, so it also remains blocked. New D01 fixtures make IDE model
selection and CLI AGENTS/MDC ordering explicit alternatives; no mixed-field, glob, nesting,
reference, legacy, or model-selected behavior was promoted.

The detailed no-paid boundary, synthetic fixture matrix, evidence fields, and stop conditions are
recorded in the [D11 no-paid observation plan](observations/2026-08-02-no-paid-plan.md). D11 ran
only the inert local transcript above. No model request, account access, repository command,
external write, or upstream mutation was performed.

## Automated research-data validation

Run the focused validator directly:

```sh
node tools/conformance/validate-cursor-rule-facts.mjs \
  docs/profiles/data/cursor-rule-facts.v0.json
```

`pnpm conformance:validate` includes the same check, and `pnpm test:conformance` covers the positive
record plus negative, boundary, malformed-input, source-substitution, unknown-promotion,
paid-observation, and symlink cases. Validation never launches Cursor or interprets repository text
as commands.

## Acceptance checklist for D11

- [x] MDC fields and malformed/unknown forms are specified.
- [x] Always, Auto Attached, Agent Requested, and Manual modes are distinct.
- [x] Mixed field combinations remain unknown where documentation is silent.
- [x] File-reference events and model-selected relevance are separated.
- [x] Glob syntax is limited to documented semantics rather than an assumed library.
- [x] Nested rule-root eligibility and metadata interaction are separate states.
- [x] File/rule reference parsing, boundaries, cycles, and ambiguity are specified.
- [x] Legacy `.cursorrules` is recognized with non-destructive migration posture.
- [x] IDE and Agent CLI claims are surface-specific.
- [x] Current local client versions and a no-cost transcript are pinned.
- [x] All 71 prose cases are mirrored in closed, versioned, schema-neutral data.
- [x] Automated validation rejects incomplete, unsafe, or authority-promoting data.
- [x] First-party provenance and the D16 behavioral observation gate are recorded.
