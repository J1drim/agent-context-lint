# Cursor rule syntax adapter

Status: D12 syntax contract, wire version `0.1.0`; product release `1.0.0`

`parseCursorRuleSyntax` converts one caller-authorized Cursor rule byte snapshot into immutable,
source-located syntax data. It supports project-rule MDC and legacy `.cursorrules` input. It does
not discover files, read reference targets, match globs, decide model relevance, activate rules,
execute repository content, or use a client, model, or network. Those profile decisions belong to
the [D13 stateful Cursor profile](cursor-profile.md) and later integration work.

## Input contract

The function accepts exactly five own enumerable data properties:

- `bytes`: intrinsic `Uint8Array`, snapshotted before parsing and limited to 262,144 bytes;
- `documentId`: bounded B03 stable identifier;
- `format`: `mdc` or `legacy`;
- `path`: canonical repository-relative file path, limited to 16,384 UTF-8 bytes;
- `sourceId`: bounded B03 stable identifier.

Unknown properties, accessors, inherited records, proxies, invalid paths, and invalid identifiers
are rejected with `CursorRuleSyntaxError`. The adapter never reflects hostile values into its fixed
error messages.

## MDC result

MDC input is parsed by the defensive C07 frontmatter parser. UTF-8 is fatal, BOM is forbidden,
duplicate keys are rejected, YAML aliases/tags/directives are rejected, and C07's structural and
resource bounds apply. Cursor metadata authority is `denied` when frontmatter, a recognized field,
the source location, or bounded reference lexing is invalid.

The adapter exposes `alwaysApply`, `description`, and `globs` as fields with four states: `absent`,
`empty`, `invalid`, or `valid`. Each field carries its exact key and value range when C07 can
establish one. Empty `description` and `globs` values are retained as syntax evidence but do not
count as activation signals. Unknown fields produce source-located warnings and never acquire
meaning implicitly.

`globs` accepts a bounded scalar candidate, top-level comma-separated scalar candidate, or YAML
string-list candidate. Commas inside braces and brackets are not split. The encoding is preserved as
`scalar`, `comma-scalar`, or `yaml-list`; no pattern is matched by this adapter. YAML-list items
have exact source ranges. Scalar subpatterns deliberately have `null` item ranges because decoded
YAML scalars are not bijective with escaped source text; the enclosing field range remains exact.

## Syntax-only mode classification

The mode result records documented syntax signals without claiming activation:

| `alwaysApply` | non-empty `globs` | non-empty `description` | classification    | state          | canonical |
| ------------- | ----------------: | ----------------------: | ----------------- | -------------- | --------: |
| `true`        |                no |                      no | `always`          | `known-syntax` |       yes |
| `true`        |                no |                     yes | `always`          | `conditional`  |        no |
| `true`        |               yes |                  either | `mixed`           | `unknown`      |        no |
| `false`       |                no |                      no | `manual`          | `known-syntax` |       yes |
| `false`       |                no |                     yes | `agent-requested` | `known-syntax` |       yes |
| `false`       |               yes |                      no | `auto-attached`   | `known-syntax` |       yes |
| `false`       |               yes |                     yes | `mixed`           | `unknown`      |        no |
| missing       |            either |                  either | `unknown`         | `unknown`      |        no |

Invalid recognized fields classify as `malformed`/`invalid`. This table describes syntax only:
`known-syntax` does not mean the rule is active, and `agent-requested` does not predict a model
decision. Evidence IDs refer to the D11 Cursor compatibility truth table.

## Source locations and references

An MDC candidate is location-supported only below one `.cursor/rules/` segment and with an `.mdc`
suffix. `scopeRoot` is the directory containing that `.cursor` directory; `ruleRoot` ends at
`.cursor/rules`. Multiple rule-root segments are retained as `unknown`, while an unsupported name or
location is an error. The adapter does not traverse either path.

References are extracted by C09 from the original text so byte and UTF-16 locations remain exact
after Unicode frontmatter. Candidates wholly inside frontmatter are removed. Cursor's tokenization
rules for prose, escaped text, inline code, fenced code, and comments are not documented, so every
retained candidate remains `ambiguous` with `unknown` uncertainty. No target is opened or resolved.

## Legacy result

Legacy format recognizes repository-root `.cursorrules` and emits the `CURSOR-SURFACE-01`
deprecation/migration warning. A nested `.cursorrules` path is `unknown`; another filename is
unsupported and malformed. Legacy content is BOM-free fatal UTF-8 plain text—an initial `---` is
ordinary content, not MDC metadata. It receives a complete source/body range and the same bounded
C09 reference-candidate treatment, but metadata authority is `not-applicable` and mode syntax is
`legacy`.

## Result and failure states

- `complete`: supported syntax with no warning beyond the mandatory legacy-format warning;
- `partial`: decoded syntax with warnings or unresolved syntax combinations;
- `malformed`: unsafe metadata, invalid recognized fields/location, decoding failure, or bounded
  reference-lexer failure.

Every returned collection and nested record is frozen. Parsing is deterministic and read-only. The
canonical D12 test data lives in `conformance/fixtures/v0/cursor-mdc-syntax.fixture.json` and
`conformance/fixtures/v0/cursor-legacy-syntax.fixture.json`.
