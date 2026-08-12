# Developing standards freshness rules

F13 lives in `packages/rules/src/standards-freshness.ts`. Keep policy presentation here while H06
continues to own deterministic offline status and H09 continues to own signed acquisition and update
verification. Do not duplicate lock parsing, bundled-pack authentication, TUF verification, registry
access, or cache reads in the rule package.

When changing the contract:

1. preserve the closed, descriptor-safe input validation and collection limits;
2. keep all time decisions relative to `statusRequest.asOf` and use exact SemVer ordering;
3. bind deprecated syntax to the exact H06-selected digest/version/origin;
4. preserve `cached-offline` versus `verified-live-h09` in messages, evidence, and fingerprints;
5. add positive, negative, boundary, malformed, deterministic-order, and B08 suppression tests;
6. exercise every changed rule through stylish, native JSON, and SARIF;
7. update API, rule-catalog, developer, and threat-model documentation in the same commit.

The focused verification commands are:

```sh
vitest run packages/rules/test/standards-freshness.unit.test.ts --no-file-parallelism --maxWorkers=1
vitest run packages/rules/test/standards-freshness.unit.test.ts \
  --coverage.enabled --coverage.include=packages/rules/src/standards-freshness.ts \
  --coverage.thresholds.statements=95 --coverage.thresholds.branches=90 \
  --coverage.thresholds.functions=95 --coverage.thresholds.lines=95
tsc -b packages/rules --pretty false
tsc -p tsconfig.tests.json --pretty false
eslint packages/rules/src/standards-freshness.ts \
  packages/rules/test/standards-freshness.unit.test.ts
```

The precision corpus intentionally includes ordinary offline scans, local scans without locks,
preview-enabled operation, and acquisition outages. Findings must follow the labeled expected set;
precision below 95% is a release failure. Reproduce any external-repository false positive in a
minimal repository-owned fixture before changing a rule.
