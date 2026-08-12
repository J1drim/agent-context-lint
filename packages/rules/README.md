# `@agent-context/rules`

Internal deterministic diagnostic evaluators and the canonical ACL rule registry.

The generated [rule catalog](../../docs/rules/catalog.md) includes a bounded illustrative bad/good
pair for every registered rule. Those pairs are review aids; conformance fixtures and integration
tests remain the authority for detection behavior.

F17 adds the explicitly opt-in `runSemanticRulePlugin` isolation boundary. The only registered
reference plug-in is a fixed, digest-pinned WebAssembly module with no imports or memory. It is
disabled by default, accepts no caller code or capability, and produces a separate result labeled
`non-deterministic`; it can never enter the F15/B04 deterministic bundle.

See the [semantic plug-in API](../../docs/api/semantic-plugins.md),
[developer guide](../../docs/development/semantic-plugins.md),
[user guide](../../docs/user/semantic-plugins.md), and
[security boundary](../../docs/security/semantic-plugins.md).

F15 adds `scheduleRuleFamilies`, the production composition boundary for the ten F05–F14 built-in
families. It creates or reuses one bounded engine-owned B03 snapshot, validates the static
dependency graph, admits every synchronous evaluator result before yielding, applies B06 severity
policy and B08 suppression before fingerprint deduplication, and returns deeply immutable,
source-bound B04 diagnostics in stable order. Seeded completion perturbation and bounded concurrency
are test controls and cannot alter diagnostic or formatter bytes.

See the [scheduler API](../../docs/api/rule-scheduler.md),
[developer guide](../../docs/development/rule-scheduler.md),
[user guide](../../docs/user/rule-scheduling.md), and
[security boundary](../../docs/security/rule-scheduler.md).

F08 adds ACL250–ACL255 through `evaluateConflictsDuplicationRules`. It composes validated B03
instruction data with real F03 classification, F04 duplication, and same-process E05 effective
contexts while retaining conditional, unavailable, partial, and truncated states. The evaluator
accepts no I/O, execution, model, network, write, or callback capability.

See the [conflicts and duplication API](../../docs/api/conflicts-duplication-rules.md),
[developer guide](../../docs/development/conflicts-duplication-rules.md), and
[security boundary](../../docs/security/conflicts-duplication-rules.md).

F12 adds ACL450–ACL453 through `evaluatePortabilityRules`. It composes validated B03 data, F03
high-confidence structured statements, same-process E07 comparisons, and explicit exact-surface
support observations. Partial inventories and conditional/unknown support remain uncertainty; the
evaluator makes no general semantic-equivalence or client-compliance claim and accepts no I/O,
execution, model, network, write, or callback capability.

See the [portability API](../../docs/api/portability-rules.md),
[developer guide](../../docs/development/portability-rules.md), and
[security boundary](../../docs/security/portability-rules.md).

F14 adds ACL550–ACL558 through `evaluateContextEfficiencyRules`. It consumes only matching,
same-process G05/G07/G08 records (including G04 distributions and G06 score specification), binds
their evidence back to B03, and emits B04 diagnostics with B08 finalization. Unknown or partial
issued evidence remains uncertainty; projected reductions retain fixed-false equivalence, necessity,
and quality claims. The evaluator accepts no capability and does not overlap F10's raw-document
budget/import rules.

See the [context-efficiency rule API](../../docs/api/context-efficiency-rules.md),
[developer guide](../../docs/development/context-efficiency-rules.md),
[user guide](../../docs/user/context-efficiency-rules.md), and
[security boundary](../../docs/security/context-efficiency-rules.md).

I12 adds a fail-closed approved-mechanical-fix boundary. Only a genuine F05/B08 ACL109 finalization
for one exact ACL100–ACL108 target can mint I11 authority, and it can delete only the exact
parser-owned unused suppression comment. Cross-family, multi-rule, and ACL109-target directives
remain refusal-only without dedicated complete unfiltered authority. Every other F05–F14 rule
remains refusal-only in the exhaustive machine-readable safety matrix. See the
[mechanical-fix API](../../docs/api/mechanical-fixes.md),
[developer guide](../../docs/development/mechanical-fixes.md),
[user guide](../../docs/user/mechanical-fixes.md), and
[security boundary](../../docs/security/mechanical-fixes.md).
