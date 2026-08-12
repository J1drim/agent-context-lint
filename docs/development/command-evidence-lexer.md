# Developing the command evidence lexer

F02 is implemented in `packages/evidence/src/command-lexer.ts`. Keep the module a pure recognizer:
adding `child_process`, shell libraries, filesystem/network access, module loading, `eval`,
expansion, executable discovery, or environment lookup violates the ordinary-scan security boundary.

## Change checklist

1. Separate source syntax recognition from runtime/client behavior.
2. Preserve exact raw text and half-open UTF-16 ranges for every retained token and word part.
3. Return `null` for values that require expansion; never approximate them with raw syntax.
4. Keep auto-dialect inference conservative and its confidence/uncertainty explicit.
5. Validate hostile public input through descriptors before reading values.
6. Bound input, tokens, parts, invocations, issues, and nesting before retaining more data.
7. Add positive, negative, boundary, malformed-input, Unicode/CRLF, determinism, immutability, and
   execution-canary tests for new syntax.
8. Update the API contract and threat model with any widened grammar or capability.

Use exact dialect tests for rule behavior. Use `auto` only when provenance cannot supply the client
or shell family; an unknown or contradictory inference must never silently select policy.

```sh
pnpm build
pnpm exec vitest run packages/evidence/test/command-lexer.unit.test.ts --project unit
pnpm exec vitest run packages/evidence/test/command-lexer.unit.test.ts --project unit \
  --coverage.enabled --coverage.include=packages/evidence/src/command-lexer.ts
pnpm lint
```

Suppression tests do not apply at this evidence layer because the lexer emits no diagnostics or
fixes. Rules that convert command evidence into diagnostics own suppression behavior.
