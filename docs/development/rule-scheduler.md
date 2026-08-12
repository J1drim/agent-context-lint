# Developing the deterministic rule scheduler

The dependency graph is the frozen `RULE_FAMILY_DESCRIPTORS` table. F05 runs first; each selected
F06–F14 family statically depends on F05. A new built-in family requires a registry entry, explicit
switch branch, typed request, ownership check, precision tests, formatter coverage, and an updated
graph assertion. Runtime evaluator registration is intentionally unsupported.

The scheduler normalizes native options and checks pre-cancellation, then synchronously creates or
reuses a bounded issued B03 snapshot before its first `await`. All current evaluators are
synchronous and bounded. F15 evaluates and validates them in topological order before yielding and
retains only their immutable results; bounded workers and `scheduleSeed` perturb the completion
reporting of those admitted results. Mutation in a queued microtask or timer therefore cannot change
a run, while same-process evidence identity remains intact.

The security-sensitive output order is: validate and cap raw family diagnostics; apply B06 policy;
stable-sort; finalize B08 with `scheduled-reporting` issuance; enforce the post-ACL109 cap;
fingerprint-deduplicate and merge evidence; then derive visible/suppressed views and failure counts.
Never move deduplication before B08 because a later duplicate primary can be the exact target line.

Run `vitest run packages/rules/test/rule-scheduler.unit.test.ts --project unit` while developing.
Run `pnpm rules:scheduler:golden` only to intentionally rebuild and update the compiled formatter
golden. Normal acceptance runs the integration test without `--update` and must write no snapshot.
