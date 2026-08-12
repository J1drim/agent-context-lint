# Developing the effective-context cache

E09 lives in `packages/resolver/src/effective-context-cache.ts`. Keep it downstream of genuine E05
resolution and E08 sampling. It must not reproduce profile semantics, interpret repository content,
or turn cache state into evidence.

## Resolution flow

1. Snapshot the closed E09 envelope without invoking accessors.
2. Normalize the complete effective B06/B07 configuration.
3. Require a genuine E08 proof containing the exact E05 target.
4. Require same-process-issued profile and E04 objects.
5. Copy and hash the exact sorted document dependency set plus configuration, target, and document
   source identities.
6. Hash the complete issued profile result, import DAGs, and target-specific sampling proof.
7. Reuse only an exact final SHA-256 address.
8. Otherwise run E05, derive the authoritative document/import path closure, and compare it to the
   supplied dependencies before publication.
9. Store the immutable issued result only when configured entry/weight bounds permit it.

Do not optimize by hashing only profile/version labels, mtimes, filenames, E05 output text, or the
selected documents. Those shortcuts miss inactive/shadowed candidates, imports, profile ambiguity,
configuration, same-content replacement identity, and source failure state. Do not include the full
E08 repository proof: unrelated sampled paths would cause imprecise invalidation. The target record,
strategy, state, and provenance are sufficient for the target-specific cache contract.

## Invariants

- Warm `EffectiveContextResolution` bytes equal cold bytes exactly.
- Every changed key component causes a miss; equal independently-created issued inputs share a hit.
- Dependency order does not affect the address.
- Missing, surplus, duplicate, unavailable, or inconsistent snapshot shapes fail before storage.
- Unknown profile, import, tracking, and workspace states remain data and participate in the key.
- A failed, cancelled, forged, malformed, or over-limit operation never inserts an entry.
- FIFO eviction is deterministic and cache clearing changes no resolution result.
- Cache code owns no I/O or executable callback.

Adding persistent storage is not an implementation detail. It requires a new ticket and threat-model
review covering atomic publication, permission and link safety, corruption, cross-version migration,
issuance reconstruction, lock ownership, and untrusted-cache revalidation. Do not serialize and
later rebrand E05 objects.

## Verification

Run the focused unit and built integration tests, then affected resolver/profile suites:

```sh
pnpm build
pnpm exec vitest run packages/resolver/test/effective-context-cache.unit.test.ts
pnpm exec vitest run tests/effective-context-cache.integration.test.ts
pnpm exec vitest run packages/resolver/test/effective-context.unit.test.ts packages/resolver/test/target-sampler.unit.test.ts
pnpm exec vitest run tests/effective-context-profiles.integration.test.ts
pnpm exec vitest run packages/resolver/test/effective-context-cache.unit.test.ts --coverage --coverage.include=packages/resolver/src/effective-context-cache.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm boundaries
pnpm security:validate
pnpm pack:check
```

Tests retain cold/warm identity, independent invalidation dimensions, target-specific E08 precision,
E04 changed/failed imports, configuration/source replacement, dependency permutations, ambiguity,
eviction, oversized values, cancellation, hostile JavaScript containers, detached/mutable bytes,
hard limits, golden addresses, built distribution imports, and output immutability.
