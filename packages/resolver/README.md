# `@agent-context/resolver`

This is a private implementation package. Embedded consumers use the high-level E11 facade exported
by `@agent-context/lint`; they do not import resolver internals or mint E10 tasks directly.

Internal resolver mechanisms for Agent Context Linter. E01 provides the pure three-valued activation
algebra and B03 rule evaluator. E02 adds the bounded profile-owned glob callback without shared
default semantics. E03 adds a bounded, canonical event-trace mechanism and dynamic-rule selection
callbacks. E04 records ordered import DAG occurrences and issues a one-entry DAG for a genuine B03
document with a proven empty import set, without inventing a vendor dialect. E05 composes genuine
D03/D05/D08/D10/D13 profile results and E04 DAGs into a deterministic effective-context graph
without flattening profile-specific unknowns into a fictional universal merge order. E06 projects
one or many genuine E05 results into complete included/excluded/conditional accounting and can
attach a normalized E03 trace without rerunning a profile. E07 compares genuine E05 results while
keeping every profile and surface contract separate: it reports mechanical scope, common-path order,
and content divergence or uncertainty, but never turns an observational match into behavioral
equivalence. E08 deterministically samples targets across workspaces, scope partitions, languages,
and critical paths, and exports its pure source-path classifier for activation-evidence composition.
E09 memoizes genuine E05 results under complete content-addressed configuration,
profile/specification, target, document/import content, source-identity, and target-sampling keys;
warm results are the exact cold object and unknown states remain unchanged. E10 runs explicitly
minted multi-target resolution tasks under hard concurrency, duration, task, and result-memory
bounds. It applies lazy queue backpressure, propagates cancellation, validates same-process E05
result relationships, and emits byte-identical canonical batches independent of input, completion,
cache, or concurrency order.

D03 adds the pinned Codex CLI 0.146.0 AGENTS profile resolver. It consumes a closed, authorized,
data-only repository snapshot, composes configured fallback names with C05 discovery facts, applies
root-to-CWD selection and the aggregate raw-byte cap, and delegates only Markdown mechanics to C06.
It does not follow external symlinks or read global `CODEX_HOME` context during a normal scan.

The generic activation algebra never selects a glob syntax or assigns client-specific meaning to
generic conditions. See
[`docs/api/profile-glob-dialects.md`](../../docs/api/profile-glob-dialects.md) for E02 ownership,
supported subsets, explicit unknowns, and limits;
[`docs/api/activation-algebra.md`](../../docs/api/activation-algebra.md) for E01; and
[`docs/api/resolution-event-traces.md`](../../docs/api/resolution-event-traces.md) for E03 trace
construction, normalization, selection/settings queries, provenance, and resource limits. The
[Codex CLI profile resolver contract](../../docs/api/codex-cli-profile.md) documents D03.

D08 adds a pure resolver for four separate Copilot surfaces. It consumes explicit candidate bytes
and runtime snapshots, composes D07 syntax with E02 glob ownership, and preserves unknown or
contradictory client behavior as indeterminate. See
[`docs/api/copilot-profiles.md`](../../docs/api/copilot-profiles.md).

D05 adds a pure stateful Claude Code resolver. It composes bounded Claude syntax, C10/E04 import
graphs, E02 project-rule glob ownership, and explicit launch/read/compact/settings snapshots while
retaining external context, arbitrary exclusions, version drift, symlinks, and sibling ordering as
indeterminate where D04 does not establish authority. See
[`docs/api/claude-code-profile.md`](../../docs/api/claude-code-profile.md).

D10 adds the stateful Gemini CLI resolver. It consumes only caller-authorized candidate, settings,
boundary, trust, and event snapshots; composes the Gemini syntax adapter with C10 import loading;
and records launch, JIT, reload, and directory-add decisions without consulting ambient client
state. Documented/source contradictions remain explicit issues. See the
[Gemini CLI profile contract](../../docs/api/gemini-cli-profile.md).

D13 adds the stateful Cursor resolver. It composes D12 syntax with explicit workspace, settings,
version, and event snapshots; keeps Always/Auto/Manual mechanics separate from Agent Requested
selection; delegates globs only to Cursor's unknown E02 dialect; and retains nested, legacy,
reference-base, coexistence, external-context, and version uncertainty. See the
[stateful Cursor profile contract](../../docs/api/cursor-profile.md).

E05 exposes `resolveEffectiveContext`. The result separates document activation and shadowing,
content availability and byte truncation, observed/documented order, possible conflicts, imported
occurrences, and unresolved activation/precedence/external-context questions. Only resolution and
DAG objects issued by the corresponding resolver in the same process are accepted; serialized or
caller-forged lookalikes fail closed. See the
[effective-context API](../../docs/api/effective-context.md),
[user guide](../../docs/user/effective-context.md), and
[developer notes](../../docs/development/effective-context.md).

E06 exposes `projectExplain`. It emits immutable target ledgers with stable reasons, preserves E05
assembly/order/conflicts/ambiguities, binds output to profile/client/specification identities, and
fails closed on forged dependencies, incompatible targets, invalid traces, or aggregate limits. See
the [explain projection API](../../docs/api/explain-projection.md),
[user guide](../../docs/user/explain.md), and
[developer notes](../../docs/development/explain-projection.md).

E07 exposes `compareEffectiveContexts`. It requires two or more distinct profile/surface contracts
for one exact target, emits every deterministic pair in stable order, and carries explicit
`equivalenceClaim: false` and semantic-relation labels. See the
[cross-profile comparison API](../../docs/api/cross-profile-comparison.md) and
[developer notes](../../docs/development/cross-profile-comparison.md).

E09 exposes `EffectiveContextMemoizationCache`. It requires genuine E05/E08 dependencies and exact
document/import snapshots, performs no I/O, and retains bounded process-local entries only. See the
[effective-context cache API](../../docs/api/effective-context-cache.md),
[developer notes](../../docs/development/effective-context-cache.md), and
[security analysis](../../docs/security/effective-context-cache.md).

E10 exposes `createEffectiveContextResolutionTask` and `resolveEffectiveContextsBounded`. Task
executors are trusted application capabilities kept outside the data contract; repository data can
never supply them. See the [bounded-resolution API](../../docs/api/bounded-resolution.md),
[developer notes](../../docs/development/bounded-resolution.md),
[user guide](../../docs/user/concurrent-resolution.md), and
[security analysis](../../docs/security/bounded-resolution.md).

I13 exposes `createCanonicalPolicySynchronizer`. It composes the real profile and syntax
implementations with I11/I10 to produce bounded deterministic vendor-policy previews, proves
target-scope parity through actual resolvers, preserves profile/surface/spec uncertainty, refuses
hand edits and ambiguous translations, and fixes `semanticEquivalenceClaimed` to `false`. Creation
is preview-only; only a clean existing single-file replacement can receive atomic compare-and-swap
authority. See the [canonical-policy synchronization API](../../docs/api/canonical-policy-sync.md).
