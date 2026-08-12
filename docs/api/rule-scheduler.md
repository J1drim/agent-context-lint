# Deterministic rule scheduler API

F15 exports `scheduleRuleFamilies(input, options?)` from `@agent-context/rules`. It composes the
real F05–F14 evaluators; there is no evaluator registration or injection API.

`RuleSchedulerInput` is a closed version `0.1.0` record containing selected family requests and a
policy. `syntax-structure` is mandatory because its B03 source registry and parser-owned B08
directives are the authority for the whole run. Every family carrying `ir` must reference the same
exact object. F09 instead supplies an evidence index and an exact, complete, duplicate-free view of
all snapshot statements. Omitted, additional, or changed F09 statements fail admission.

The policy supports `error`, `warning`, `info`, or `off` per registered rule and an `error`,
`warning`, or `never` failure threshold. `off` is applied before suppression, so a disabled finding
cannot consume a directive. Failure thresholds inspect only visible diagnostics.

Options are closed and bounded: `maximumConcurrency`, `maximumDiagnostics`, `maximumDurationMs`,
`scheduleSeed`, and a native `AbortSignal`. Seed zero performs no event-loop perturbation.
Cancellation is checked before deadlines and returns a typed issue without reflecting an abort
reason.

A success contains the canonical B04 bundle, immutable source registry, stable execution order,
family summaries, visible and suppressed views, and a threshold summary. Failures are
`{ ok: false, issues }` with immutable typed issues.

`canonicalizeRuleDiagnostics` is the lower-level B04 validation/policy/deduplication seam. It
rejects duplicate IDs and fingerprint identity or message conflicts, retains the highest severity,
selects the earliest primary, converts alternate primaries to related evidence, rejects conflicting
suggestions, and stable-sorts the result.
