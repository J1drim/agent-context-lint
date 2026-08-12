# Developing the statement classifier

F03 lives in `packages/evidence/src/statement-classifier.ts`. Its purpose is high-precision
structure, not general semantic classification. Keep unrecognized or ambiguous prose unclassified.

## Adding or changing a template

1. Use a bounded, linear-time deterministic pattern with a stable rule ID.
2. Require compound evidence that distinguishes instructions from descriptive prose or questions.
3. Add at least one positive, one close paraphrase, and hard negatives to the labeled fixture.
4. Keep every predicted domain at or above the pinned `0.95` precision threshold.
5. Assert extracted subject/action/object and modality when they affect downstream conflicts.
6. Preserve multi-domain evidence and the documented primary-domain order.
7. Update the API and security documentation in the same commit.

Do not add model calls, embeddings, learned artifacts, language detection, stemming libraries, fuzzy
matching, filesystem/network access, command parsing/execution, or repository-derived regular
expressions. F17 owns the disabled semantic plug-in boundary. F02 owns inert command lexing. F04
owns bounded near-duplicate similarity.

```sh
pnpm build
pnpm exec vitest run packages/evidence/test/statement-classifier.unit.test.ts --project unit
pnpm exec vitest run packages/evidence/test/statement-classifier.unit.test.ts --project unit \
  --coverage.enabled --coverage.include=packages/evidence/src/statement-classifier.ts
pnpm lint
```

The evidence layer emits no diagnostics or fixes, so suppression tests do not apply here. A later
rule that converts a domain claim into a diagnostic owns positive, negative, malformed, boundary,
suppression, formatter, and fix-safety coverage.
