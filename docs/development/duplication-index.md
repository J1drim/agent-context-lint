# Developing the duplication index

F04 is implemented in `packages/evidence/src/duplication-index.ts`. Preserve the distinction between
exact normalized identity, bounded syntactic similarity, and semantic meaning.

## Change checklist

1. Keep F03 `normalizedText` as the only text identity input; never normalize differently in F04.
2. Version any change to shingle construction, candidate selection, score arithmetic, threshold, or
   cluster formation and update golden edge evidence.
3. Use code-point operations and code-unit comparisons without locale-dependent sorting.
4. Retain integer intersection, union, and basis-point evidence for every accepted edge.
5. Test exact, threshold-included, threshold-excluded, transitive, short, empty, and expanded-exact
   behavior.
6. Add no-space, non-Latin, combining-character, astral/emoji, and cross-script negative cases.
7. Prove bounded work with candidate, shingle, posting, entry, aggregate-text, and cluster limits.
8. Keep all output recursively immutable and all member order/IDs byte-stable.
9. Update API and threat-model documentation with any widened input or capability.

Do not add quadratic fallback comparison, stemming, transliteration, embeddings, repository-derived
regular expressions, filesystem/network access, or semantic equivalence claims. F17 owns optional
semantic plug-in isolation. F08 owns conflict and duplicate diagnostics and their suppression tests.

```sh
pnpm build
pnpm exec vitest run packages/evidence/test/duplication-index.unit.test.ts --project unit
pnpm exec vitest run packages/evidence/test/duplication-index.unit.test.ts --project unit \
  --coverage.enabled --coverage.include=packages/evidence/src/duplication-index.ts
pnpm typecheck
pnpm pack:check
```

Suppression and formatter tests do not apply to this evidence index because it emits no diagnostics.
Rules consuming clusters must test those behaviors before enabling user-visible findings.
