# Developing reference and import rules

F06 keeps four authorities separate:

- B03 owns source text, reference identity, syntax state, and exact ranges.
- C10 owns containment, graph traversal, cycle, target-read, and resource-limit outcomes.
- D03–D13 descriptors own per-profile and per-surface syntax support.
- the repository path snapshot owns path existence and canonical casing.

Do not infer ACL150 directly from `IMPORT_GRAPH_READ_FAILED`: that result can also mean permission,
link, race, or other availability failure. ACL150 is emitted only when the C10 target is absent from
a complete path snapshot and has no unique case-only match. Similarly, do not promote Cursor or
hosted Copilot reference uncertainty to ACL155.

Each new behavior needs positive, negative, exact-boundary, malformed, partial-evidence,
suppression, stylish/JSON/SARIF, deterministic-order, hostile-container, and resource-limit tests.
Profile changes must use their profile descriptor or resolver output rather than copying a rule into
F06. The seeded precision corpus must retain at least 95% precision before an error remains enabled.

Useful focused checks are:

```sh
pnpm build
pnpm exec vitest run packages/rules/test/references-imports.unit.test.ts
pnpm exec vitest run tests/references-imports.integration.test.ts
pnpm exec vitest run packages/rules/test/references-imports.unit.test.ts --coverage
pnpm lint
pnpm rules:docs:check
pnpm pack:check
```
