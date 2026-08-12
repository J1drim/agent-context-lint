# Developing ACL100–ACL109

F05 is a composition layer, not another parser or profile registry. Keep C07 frontmatter parsing,
B08 directive authority, B03 validation, and B04 fingerprints in their owning contracts. New profile
adapters should translate reviewed specification facts into the closed data policies rather than
adding profile-name conditionals to `syntax-structure.ts`.

## Required invariants

1. Validate descriptor-safe closed input before reading policy values.
2. Validate B03 before trusting source text, ranges, paths, or digests.
3. Parse YAML/MDC with C07 and never broaden scope after an invalid result.
4. Keep duplicate keys under ACL107 so one parser issue does not also create ACL100 noise.
5. Emit ACL105/ACL106 only from explicit supported-state observations with specification evidence.
6. Parse B08 directives in phase one, but decide ACL109 only in the finalizer after all scheduled
   diagnostics are present.
7. Sort diagnostics by UTF-8 path, byte offset, rule ID, and diagnostic ID and validate B04 output.

F15 calls the scheduled finalizer on stable-sorted policy-filtered raw diagnostics before
fingerprint deduplication. This preserves exact line matching when duplicate fingerprints have
different primaries. Scheduled finalization is reporting-only and must never be accepted by I12.

Detection changes require positive, negative, exact-boundary, malformed/hostile, targeted
suppression, stylish, JSON, and SARIF cases for every affected rule. Unknown client behavior must
remain silent and documented. Minimize any hostile-input failure into a project-owned synthetic
fixture; never modify a repository selected for analysis.

## Focused verification

```sh
pnpm build
pnpm exec vitest run packages/rules/test/syntax-structure.unit.test.ts
pnpm exec vitest run tests/syntax-structure-rules.integration.test.ts
pnpm exec eslint packages/rules/src/syntax-structure.ts \
  packages/rules/test/syntax-structure.unit.test.ts \
  tests/syntax-structure-rules.integration.test.ts
pnpm rules:docs:check
pnpm boundaries
pnpm pack:check
```

Coverage registration includes `packages/rules/src/syntax-structure.ts`; review its branch report,
not only aggregate percentages. Build before the integration test because that test imports the
packaged rules surface from `dist`.
