# Effective-context resolver development

E05 is a projection boundary, not another client emulator. D03, D05, D08, D10, and D13 own client
selection semantics; E04 owns ordered import occurrences and content identities. E05 preserves those
facts in one graph while retaining every unknown that can affect activation, order, content, or
target scope.

## Invariants

- Accept only same-process issued D-series results and E04 DAGs. The module-level `WeakSet` issuance
  guards are capability checks, not serialization formats.
- Validate the raw E05 envelope before inspecting it. Do not invoke accessors or proxy traps.
- Keep presentation order separate from precedence. Canonical path sorting for unordered profiles
  makes output reproducible but grants no winner semantics.
- Keep load order separate from semantic conflict resolution. In particular, Codex observed
  root-to-CWD order is not evidence for “later wins.”
- Do not copy imported source text out of E04. E04 carries ordered occurrence/content identities;
  exact imported assembly requires a future profile-owned contract.
- Conflict records are opportunities, produced pairwise from possibly active documents. They do not
  claim a semantic contradiction without downstream rule evidence.
- New profile states must map explicitly. Never coerce an unknown state to inactive or active.

## Determinism and limits

Stable IDs hash length-delimited UTF-8 fields with SHA-256. Ambiguity document IDs and final
ambiguity output are canonically sorted. Codex and Gemini preserve observed order; Claude uses a
deterministic topological representative of its partial order; Copilot and Cursor path-sort
unordered inventories. The resolver fails before emitting more than the public resource limits.

## Verification

Run the focused suite and coverage gate:

```sh
pnpm exec vitest run packages/resolver/test/effective-context.unit.test.ts \
  tests/effective-context-profiles.integration.test.ts
pnpm exec vitest run packages/resolver/test/effective-context.unit.test.ts \
  --coverage.enabled --coverage.include=packages/resolver/src/effective-context.ts
```

Tests must use real upstream resolver/builder calls. Include positive, inactive, conditional,
shadowed, truncated, unavailable, malformed-envelope, forged-authority, relationship, repeated
import, partial import, resource, order-permutation, and repeated-run cases. Canonical profile
fixtures are checked against `conformance/fixtures/v0/effective-context.golden.json`.
