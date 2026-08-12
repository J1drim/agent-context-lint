# Developing the safe fix pipeline

I11 lives in `packages/evidence/src/safe-fix-pipeline.ts` because applying a preview must share C01,
C02, and I10's root-jail authority. Planning itself is synchronous, deterministic, offline,
model-free, and mutation-free.

## Required sequence

1. Snapshot only closed own-data request/source wrappers and validate the complete B04 bundle
   against exact B03 sources.
2. Require an engine-issued, exact rule/diagnostic/plan-digest eligibility capability for every
   explicitly selected plan. Enforce the hard `0.95` floor and suppression/policy gate.
3. Bound aggregate sources and operations, sort by canonical UTF-8 keys, reject cross-plan
   conflicts, and rebuild each edited source once from ascending half-open UTF-16 ranges.
4. Produce a centrally sanitized, bounded, canonical review patch. Store application bytes only in
   private preview state and defensively copy them.
5. On apply, atomically consume the exact same-pipeline preview, reject unsupported transaction
   shapes, re-read all selected bytes/identities, then call I10.
6. Preserve I10's actual durability and committed state. Never infer rollback after publication.

The one-file limit is a safety invariant, not an implementation convenience. Do not expand it by
looping over `writer.write()`: a process crash between renames would violate B04's atomic plan
claim. A future expansion requires a reviewed repository transaction lock, canonical target-lock
ordering, durably flushed journal and preimages, commit/recovery states, restart recovery,
corruption and substitution rejection, directory durability, and child-process crash tests at every
state boundary.

## Test matrix

Focused tests cover:

- single, adjacent, insertion, replacement, BOM, CRLF, astral, and no-final-newline edits;
- exact-confidence acceptance and rejection, forged/cloned/proxied/mismatched authority, explicit
  empty selection, preview immutability, foreign/concurrent/repeated application;
- cross-plan overlaps, same-position insertion, duplicate move source, duplicate destinations,
  multi-file refusal, create/move preview-only behavior, and deterministic ordering;
- secret, ANSI, C0/C1, bidi, patch-byte, replacement-byte, malformed wrapper, cancellation, stale
  digest/identity, read-only, and hard-link behavior; and
- maintained B03/B04 fixture integration against a real temporary repository.

The packed-manifest gate executes the extracted tarball's genuine scan and `scan --fix-dry-run`
under child-process, socket, and filesystem-write denial. It verifies stable diagnostics and patch
bytes, snapshots both repositories before and after, and rejects the flag on non-scan commands.

Run:

```bash
pnpm exec vitest run packages/evidence/test/safe-fix-pipeline.unit.test.ts \
  tests/safe-fix-pipeline.integration.test.ts
pnpm exec vitest run packages/evidence/test/safe-fix-pipeline.unit.test.ts \
  --coverage --coverage.include=packages/evidence/src/safe-fix-pipeline.ts
pnpm typecheck
pnpm lint
```

Before integration, run `pnpm check` and inspect the packed CLI help/unknown-option behavior. Normal
scan paths must still be unable to construct a writer or eligibility capability from repository
data.
