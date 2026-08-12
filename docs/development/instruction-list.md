# Maintaining the D14 instruction list

The implementation lives in `packages/resolver/src/instruction-list.ts`. It is an orchestration
projection over D03, D05, D08, D10, and D13, not a second activation engine. Profile-specific
selection, trust, version, glob, and event behavior must remain in the owning resolver.

## Change checklist

1. Update the owning profile resolver and its evidence before changing a mapping.
2. Keep syntax-adapter identities distinct from catalog format IDs. Copilot repository-wide syntax
   is mapped by its recognized basename; Cursor `mdc`/`legacy` syntax maps explicitly to
   `cursor-mdc`/`cursor-legacy-rules`.
3. Preserve precedence: malformed, catalog support, then activation. Do not turn unknown catalog
   support or indeterminate activation into a definite active/inactive result.
4. Retain stable resolver decision codes and bounded reasons. Fixed D14 explanations must not echo
   arbitrary object shapes or errors.
5. Keep ordering locale-free and reject duplicate path/profile/surface/format rows.
6. Extend the all-profile golden whenever a row contract or explanation changes. A golden update
   requires an intentional contract review, not snapshot regeneration by default.
7. Add positive, negative, boundary, malformed-input, determinism, and integration coverage. Real
   resolver outputs must continue to pass through the projection.
8. Keep I/O and CLI concerns out of this module. Discovery supplies authorized snapshots; I03 owns
   command routing and presentation.

## Focused verification

```bash
pnpm exec vitest run packages/resolver/test/instruction-list.unit.test.ts --project unit
pnpm exec vitest run tests/resolver/instruction-list.integration.test.ts --project integration
pnpm exec vitest run packages/resolver/test/instruction-list.unit.test.ts \
  tests/resolver/instruction-list.integration.test.ts --coverage
pnpm typecheck
pnpm lint
pnpm boundaries
pnpm conformance:validate
pnpm pack:check
```

The integration fixture uses only an in-memory synthetic `ReadOnlyRepository`. It must never run a
client or a repository command. Failures found in external validation repositories belong in a
minimal repository-owned fixture rather than a patch or commit prepared for the external project.
