# Profile conformance fixture contract v0

Status: D01 fixture contract retained for stable-release conformance.

Contract identifier: `svetovid-profile-conformance-fixture/0.1.0`

Canonical mapping:
[`profile-surface-map.v0.json`](../../conformance/contracts/profile-surface-map.v0.json)

This contract gives every client-profile implementation the same reproducible way to describe a
synthetic repository, runtime events, expected resolution graph, evidence, client version, and
unresolved ambiguity. It is deliberately schema-neutral: it does not depend on the
[B02 public profile catalog](core-profile-contracts.md) or the future B03 IR, but it fixes the
semantic information those types must preserve.

The contract does not make research truth tables executable by pretending that unknown behavior is
deterministic. It makes uncertainty executable: a fixture must either provide an empty `ambiguities`
array or identify every conditional, unknown, model-selected, contradicted, or blocked result
explicitly.

## Separation of concerns

Three identifiers are independent:

- `formatId` describes what can be parsed from a file, such as `agents-markdown` or `cursor-mdc`.
- `profileId` describes a product behavior contract, such as `codex-cli` or `copilot-vscode`.
- `surfaceId` identifies the runtime surface on which that behavior was documented or observed.

The same format can map differently on different surfaces. For example, `agents-markdown` is
selected root-to-CWD by Codex, model-selected when nested support is enabled in VS Code,
nearest-relevant in the Copilot coding agent, root-only with unresolved nested behavior in code
review, and a documented root source in Cursor Agent CLI. No shared adapter may supply a universal
activation rule.

## Canonical v0 inventory

The machine-readable map is normative for IDs and support states. This table is a review aid.

| Profile               | Surface                             | Release class            | Repository root model                                                             | External/user scope                                                    |
| --------------------- | ----------------------------------- | ------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `codex-cli`           | `codex-cli/local-cli-single-cwd`    | GA required              | Nearest configured root marker; default `.git`; otherwise CWD only                | `CODEX_HOME`, unavailable unless supplied synthetically                |
| `claude-code`         | `claude-code/local-session`         | GA required              | Launch ancestor chain plus read-triggered descendants                             | Managed/user instructions, user rules, approved additional directories |
| `copilot-cli`         | `copilot-cli/local-terminal`        | GA required              | Repository/CWD/intermediate/runtime-work paths; exact order unknown               | `COPILOT_HOME`, custom instruction directories                         |
| `copilot-vscode`      | `copilot-vscode/local-chat`         | GA required              | Open workspace roots; optional trusted parent `.git` lookup                       | User folders, organization instructions, editor settings/state         |
| `copilot-cloud-agent` | `copilot-cloud-agent/github-hosted` | Recognized evidence only | Hosted checkout; branch lifecycle incompletely documented                         | Organization policy and hosted task state                              |
| `copilot-code-review` | `copilot-code-review/github-hosted` | Recognized evidence only | Pull-request head-branch snapshot                                                 | Personal/organization instructions and review settings                 |
| `gemini-cli`          | `gemini-cli/local-terminal`         | GA required              | Trusted workspace roots to configurable boundary; default `.git`; descendants JIT | Global context, include roots, extensions, private memory              |
| `cursor-agent`        | `cursor-agent/ide`                  | GA required              | Supplied IDE workspace roots plus nested rule roots                               | User/team rules, memories, IDE reference state                         |
| `cursor-agent`        | `cursor-agent/cli`                  | GA required              | Supplied CLI workspace; subdirectory-launch root discovery unknown                | User/team rules and runtime reference state                            |

Copilot hosted surfaces remain separate profile IDs because their discovery, exclusion, branch, and
observation models differ from both local surfaces. Cursor uses one required profile family with two
surface IDs because D11 explicitly requires IDE and Agent CLI claims to remain independently
evidenced.

## Canonical format IDs

| Format ID                     | Candidate family                                                    | Parser responsibility, not activation behavior                                 |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `agents-markdown`             | `AGENTS.md`, Codex `AGENTS.override.md`, configured Codex fallbacks | Markdown body, empty state, reference-token candidates                         |
| `claude-memory-markdown`      | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`                 | Markdown, `@` candidates, code regions, HTML comment spans                     |
| `claude-rule-markdown`        | `.claude/rules/**/*.md`                                             | Markdown plus defensive `paths` frontmatter                                    |
| `copilot-repository-markdown` | `.github/copilot-instructions.md`                                   | Markdown plus reference candidates                                             |
| `copilot-path-instructions`   | `.github/instructions/**/*.instructions.md`                         | Markdown plus `applyTo`, `excludeAgent`, `name`, and `description` frontmatter |
| `gemini-context-markdown`     | `GEMINI.md` and configured context names                            | Markdown, Gemini `@` candidates, backtick code-region candidates               |
| `cursor-mdc`                  | `.cursor/rules/**/*.mdc`                                            | MDC delimiters, Markdown, `description`, `globs`, `alwaysApply`, references    |
| `cursor-legacy-rules`         | root `.cursorrules`                                                 | Legacy plain text and migration identity                                       |

Parsing a token does not prove that a surface expands it. Copilot CLI does not expand Gemini
imports, Cursor Agent CLI support for root `CLAUDE.md` does not inherit Claude Code's import rules,
and hosted Copilot references remain unknown unless that surface documents them.

## Fixture shape

Every `*.fixture.json` document has these required top-level members:

```json
{
  "recordKind": "profile-conformance-fixture",
  "fixtureFormatVersion": "0.1.0",
  "id": "vendor-scenario-stable-id",
  "title": "short human description",
  "profile": {},
  "provenance": {},
  "repository": {},
  "externalContext": {},
  "invocation": {},
  "targets": [],
  "eventTrace": [],
  "expectedGraph": {},
  "assertions": []
}
```

Unknown top-level fields are rejected in v0. Extension data belongs under an explicit namespaced
`extensions` object so fixture typos cannot silently alter meaning.

### Profile identity

`profile` contains:

- `profileId` and `surfaceId`, which must be an exact pair in the canonical map;
- `specSnapshotId`, which identifies the reviewed behavior snapshot;
- `clientVersion`, a string or `null`;
- `versionStatus`, such as `pinned-release`, `pinned-package-and-source`, `observed-metadata-only`,
  or `hosted-service-date`; and
- `serviceObservedAt` when a hosted surface has no client version.

A `null` client version is explicit uncertainty, not a missing field. It requires a non-empty
`versionStatus` and provenance explaining how the living service or documentation was dated.

### Provenance

`provenance` requires:

- at least one `researchRecordId` from the canonical map;
- at least one source with stable `id`, absolute HTTPS `url`, retrieval date, and `immutability`
  classification;
- `derivation`, one of `official-example`, `synthetic-edge-case`, `observed-reproduction`, or
  `regression-minimization`;
- an `assumptions` array, explicitly empty when none; and
- an `observationIds` array, explicitly empty when no client observation exists.

An immutable source records `revision`. A living source records `mutableSourceReason`. An
observation artifact uses a repository-relative `artifactPath`. Fixtures may cite research records
for compactness, but cannot omit their own source list: a moved fixture must retain audit
provenance.

### Repository and external context

All repository paths are canonical repository-relative POSIX paths. The root is `.`. Absolute paths,
`..`, backslashes, empty segments, and NUL are forbidden. Directories end in `/`; files and symlinks
do not. File content may be a UTF-8 string, including the empty string. A bounded encoded form may
be added by a later filesystem contract. An instruction candidate has a canonical `formatId`; an
ordinary target/evidence file uses explicit `null`.

`externalContext.mode` is one of:

- `unavailable`: normal repository-only scan; no host user files may be read;
- `explicit-synthetic`: fixture-owned data simulates user/managed context; or
- `not-applicable`: the scenario has no external scope.

Explicit synthetic entries use symbolic paths and inline synthetic marker content. They never
contain or direct the harness to a real home directory.

### Invocation, targets, and event trace

`invocation` contains the supplied launch CWD, workspace roots, effective settings, trust state,
branch state, and runtime mode. Missing runtime input is represented with a value such as `unknown`,
not by reading client state from the host.

`targets` is non-empty. A target describes the path whose effective context is being resolved and
its purpose. A launch-only scenario still supplies a synthetic target so comparisons and coverage
accounting have a stable unit.

`eventTrace` is non-empty and ordered by integer `sequence` starting at zero. The canonical event
vocabulary begins with:

- `launch`;
- `reference-path`, `read-path`, `write-path`, and `list-directory`;
- `manual-rule-mention`;
- `memory-show`, `memory-list`, `memory-reload`, and `compact`;
- `directory-add`;
- `review-request`, `review-push`, and `hosted-task-start`; and
- `settings-change` and `client-restart`.

Profiles may ignore unsupported events, but fixtures retain them. Events cannot execute repository
commands.

### Expected graph

`expectedGraph.nodes` and `expectedGraph.edges` describe the resolution result without adopting
B03's future in-memory IR names.

`expectedGraph.analysisStatus` is `complete`, `partial`, or `unknown`. A graph with one or more
ambiguities cannot claim `complete`.

Node kinds are `document`, `external-context`, `target`, `event`, and `content-occurrence`. Edge
relations are:

- `discovers`, `selects`, `shadows`, `excludes`, and `deduplicates`;
- `activates`, `deactivates`, and `makes-eligible`;
- `imports`, `references`, and `blocks-boundary`;
- `precedes`, `injects`, `truncates`, and `omits`; and
- `observes`.

Each node and edge carries `resolutionStatus` from the contract vocabulary and one or more evidence
references. Paths identify occurrences; a separate `contentIdentity` may connect duplicate bytes
without deleting occurrences. Graph order is the array order only for serialization. Semantic order
is expressed with `precedes` edges.

### Assertions and explicit ambiguity

`assertions` make pass/fail expectations machine-checkable. Deterministic assertions may use
`documented`, `documented-versioned`, `source-derived`, or `observed`. An assertion whose status is
conditional, model-selected, unknown, not-listed, contradiction, pending-observation, or
blocked-paid-observation must reference an ambiguity.

`expectedGraph.ambiguities` is always present, even when empty. Every entry has:

- a stable `id`;
- `kind`;
- non-empty `reason`;
- at least two explicit `alternatives` with stable IDs and descriptions; and
- one or more evidence references.

Every non-deterministic graph node, edge, or assertion must have an `ambiguityId` that resolves to
exactly one entry. This prevents an unknown from quietly becoming active or inactive when a fixture
is implemented.

## Version and compatibility policy

The v0 fixture contract uses semantic-looking version `0.1.0` as an independent fixture identity. It
is supported by the stable `1.0.0` product release; the fixture version must not be read as the
product version.

- Patch changes clarify documentation or validator diagnostics without changing accepted data.
- Minor changes may add optional fields or enum members through the compatibility review.
- Any removal, new required field, meaning change, or altered uncertainty rule increments the major
  component and migrates every fixture.
- Changes after the major-version `0` freeze require an ADR, fixture migration, and review from
  contract plus affected profile owners, as required by the compatibility policy.

The mapping and fixture version are independent. Updating upstream profile facts creates a new
`specSnapshotId`; it does not automatically change the fixture format.

## Validation and examples

The standalone validator uses only Node built-ins and makes no network calls:

```bash
node tools/conformance/validate-profile-contract.mjs \
  conformance/contracts/profile-surface-map.v0.json \
  conformance/fixtures/v0/codex-root-order.fixture.json \
  conformance/fixtures/v0/copilot-vscode-description-ambiguity.fixture.json \
  conformance/fixtures/v0/gemini-hierarchy-jit.fixture.json \
  conformance/fixtures/v0/gemini-import-modes.fixture.json \
  conformance/fixtures/v0/gemini-ignore-memory-ambiguity.fixture.json

pnpm conformance:gemini:validate
node --test tools/conformance/validate-profile-contract.test.mjs \
  tools/conformance/validate-gemini-research.test.mjs
```

The first example maps the existing `CDX-SC-001` schema-neutral scenario into the canonical graph.
Its ambiguity array is explicitly empty. The second records the current VS Code description-only
contradiction and must retain two alternatives instead of choosing an activation result.

The Gemini examples bind the canonical fixture graph to the exact dated D09 record. A separate
offline validator rejects snapshot drift, unknown fact/source references, missing local transcripts,
malformed digests, and unsafe artifact paths. It does not fetch the pinned URLs or implement the
future D10 profile.

The validator intentionally rejects:

- absent or empty provenance;
- missing `ambiguities`, even for deterministic cases;
- non-deterministic results without a valid `ambiguityId`;
- profile/surface or format/surface pairs absent from the canonical map;
- duplicate IDs, invalid paths, broken references, or unordered events; and
- mutable sources without retrieval provenance.

## Mapping the completed research

| Research ticket | Canonical mapping action                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D02 Codex       | Preserve the 0.146.0 pinned source/observation and translate each scenario without weakening selected-empty, byte-budget, CWD, or symlink states.                  |
| D04 Claude Code | Preserve launch versus read events, partial ordering, external approval/state, version boundaries, and unknown sibling/rule ordering.                              |
| D06 Copilot     | Keep four profile/surface IDs. Never copy CLI references, VS Code globs, hosted exclusions, or review branch behavior across surfaces.                             |
| D09 Gemini CLI  | Preserve trusted roots, configurable boundary/names, static versus JIT events, format-specific import defects, and documented/source contradictions.               |
| D11 Cursor      | Keep IDE and Agent CLI surface IDs; represent model relevance, mixed MDC modes, nested interactions, reference bases, and legacy precedence as explicit ambiguity. |

This D01 contract does not promote pending observations. D15/D16 add evidence to a fixture or
produce a new spec snapshot; they do not rewrite expected states simply because a model happened to
follow synthetic marker text once.

D15 publishes a separate closed plan/transcript contract and a canonical blocked Gemini case. Its
only runnable v0 adapter is a digest-pinned, deny-network macOS-sandboxed `--version` probe from an
empty disposable working directory. That adapter proves client metadata, not fixture activation.
Every interactive, hosted, IDE, paid, or otherwise unsafe case remains an explicit blocked
observation until D16 has a separately reviewed safe signal.

D16's dated GA review binds a reviewed D15 transcript and at least one canonical fixture to every
GA-required surface. Copilot CLI and both Cursor surfaces now have explicit-unknown D01 fixtures in
addition to their detailed schema-neutral catalogs. Only the Codex metadata probe was runnable;
blocked transcripts preserve Claude, Copilot, Gemini, and Cursor uncertainty without rewriting it as
deterministic activation.

## Security and external-repository rules

Fixtures are minimal, synthetic, offline, read-only inputs. Validation does not execute commands,
resolve host symlinks, inspect a user's client configuration, or access the network. External GitHub
repositories remain read-only validation targets and are never converted wholesale into fixtures. A
failure found there must be minimized into a repository-owned synthetic fixture with its own
provenance.
