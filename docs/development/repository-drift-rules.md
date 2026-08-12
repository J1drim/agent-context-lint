# Developing repository drift rules

F09 is implemented in `packages/rules/src/repository-drift.ts`. It is a deterministic correlation
layer over F01 facts, F02 command evidence, and F03 high-confidence statement domains. Keep
repository absence, conflicting evidence, and unknown client resolution as separate states.

## Change checklist

1. Keep ordinary evaluation data-only. Do not add filesystem/process/environment/network/model or
   dynamic-import capabilities, and never run a command found in a statement or fact.
2. Consume only source-backed F03 statements and exact F02 invocation parts. Do not reconstruct a
   shell command, expand variables, evaluate substitutions, or infer through a dynamic part.
3. Require positive complete F01 facts for presence/configuration conclusions. Use the nearest
   applicable scope and retain uncertainty from malformed, unavailable, unsupported, uncertain, or
   conflicting evidence.
4. Treat missing npm/pnpm explicit scripts and Make/Just targets as definite only under the
   documented closed forms. Preserve Yarn/Bun script-or-binary/file/built-in ambiguity.
5. Add command-resolution behavior only with a dated official primary source and a regression test.
   If a client/version does not document the decision, return uncertainty.
6. Keep path candidates canonical and repository-relative. Prose, globs, absolute paths, traversal,
   URL schemes, and dynamic syntax are not absence evidence.
7. Add tools only to a reviewed closed catalog and cover direct plus supported wrapper invocation. A
   name appearing in prose is not enough to claim configuration or executability.
8. Keep runtime comparison conservative. Version any expansion beyond major/exact-minor comparison
   and test compatible, conflict, mixed, range, malformed, and incomplete evidence.
9. Preserve B04 source locations, stable fingerprints, digest-only related evidence, deterministic
   ordering, recursive output immutability, fixed messages, and zero fix suggestions.
10. Update API, security, and rule documentation in the same change. Registry precision status is
    changed only after the separate reviewed precision gate supplies its evidence.

Every changed rule needs positive, close negative, boundary, malformed/hostile input, suppression,
stylish/JSON/SARIF formatter, determinism, and relevant resource-limit tests. Cross-package
integration must exercise the real F01 collector and the internally composed F02/F03 APIs. Add a
capability canary proving evaluation performs no new repository read, process execution, or network
request.

Focused verification during development is:

```sh
pnpm build
pnpm exec vitest run packages/rules/test/repository-drift.unit.test.ts --project unit
pnpm exec vitest run tests/repository-drift.integration.test.ts --project integration
pnpm exec vitest run packages/rules/test/repository-drift.unit.test.ts \
  tests/repository-drift.integration.test.ts --coverage.enabled \
  --coverage.include=packages/rules/src/repository-drift.ts
pnpm typecheck
pnpm pack:check
```

The integration owner runs the serialized repository-wide gate and records its evidence with the
release review. Do not claim precision or stability from synthetic tests alone.
