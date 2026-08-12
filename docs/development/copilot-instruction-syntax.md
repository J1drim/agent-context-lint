# Developing Copilot instruction syntax

D07 lives in `packages/syntax/src/copilot-instructions.ts`. Keep this layer independent from D08
profile selection: a parsed field is not proof that a particular Copilot surface uses it.

## Invariants

- Compose C07 for YAML safety and C09 for source-exact inert reference candidates; do not add a
  second YAML or `@` lexer.
- Do not interpret frontmatter in repository-wide Markdown. In particular, a leading thematic break
  must not make a repository-wide document malformed or scoped.
- Never broaden a path-specific document when frontmatter or `applyTo` is absent, malformed, wrongly
  typed, empty, or over a resource limit.
- Split only top-level comma separators; preserve commas inside brace and bracket expressions. Leave
  glob validity and client-specific pattern semantics to E02's profile-owned dialect.
- Preserve `excludeAgent` as syntax. D08 may apply `cloud-agent` only to that hosted coding-agent
  profile and `code-review` only to hosted code review.
- Do not expose `@` candidates for `*.instructions.md`; Copilot CLI documents that references are
  not expanded there.
- Keep all issue messages closed and non-reflective. Repository text belongs in source evidence, not
  operational errors.

## Verification

Run focused verification with:

```sh
pnpm exec vitest run packages/syntax/test/copilot-instructions.unit.test.ts
pnpm typecheck
pnpm lint
pnpm pack:check
```

Tests cover all documented fields, comma/brace partitioning, missing and malformed authority,
profile-dependent repository references, path-file reference exclusion, hostile JavaScript input,
frontmatter resource limits, exact source ranges, immutability, and repeated byte identity. D08 must
add surface activation fixtures instead of weakening these syntax guarantees.
