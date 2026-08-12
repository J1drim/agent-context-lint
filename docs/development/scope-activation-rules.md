# Developing ACL200–ACL206

F07 composes existing contracts instead of recreating their behavior:

1. validate B03;
2. canonicalize results with E01 `serializeActivationResult`;
3. derive E08 observations and invoke `sampleTargets`;
4. classify exact versus sampled coverage from E08;
5. apply closed ACL200–ACL206 predicates; and
6. sort and validate a B04 bundle.

Do not add glob matching, traversal, profile callbacks, precedence, or language classification here.
E01 owns activation, E02 owns glob dialects, profile resolution owns reachability/nesting evidence,
and E08 owns sampling. New uncertainty must remain explicit, never normalized to inactive.

Detection changes require positive, close-negative, exact-boundary, malformed/hostile, limit,
determinism, suppression, stylish/JSON/SARIF, and labeled-corpus coverage. ACL200 requires exact E08
coverage. ACL202, ACL204, and ACL206 may use definite sampled witnesses. ACL203 requires explicit
shadow or unreachable evidence. ACL205 must not turn conditional or unknown behavior into a warning.

```sh
pnpm build
pnpm exec vitest run packages/rules/test/scope-activation.unit.test.ts \
  tests/scope-activation-rules.integration.test.ts
pnpm exec eslint packages/rules/src/scope-activation.ts \
  packages/rules/test/scope-activation.unit.test.ts \
  tests/scope-activation-rules.integration.test.ts
pnpm rules:docs:check
pnpm boundaries
pnpm pack:check
```

Focused coverage must remain at least 95% statements and above 90% branches. Keep
`packages/rules/src/scope-activation.ts` in the repository-wide `vitest.config.ts` coverage include
list so the complete gate measures the production evaluator even if a future test stops importing
it. Registry state remains `seeded`; reproduce hostile-input failures as local synthetic fixtures
and never prepare changes for a repository selected for analysis.
