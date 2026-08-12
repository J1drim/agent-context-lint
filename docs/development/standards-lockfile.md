# Developing the standards lockfile

H04 is implemented in `packages/standards/src/standards-lockfile.ts`. Its package owns the data
contract and canonical codec but has no filesystem or network capability. The caller injects the
small `StandardsLockfileAtomicWriter` interface; the production implementation is I10's explicitly
constructed repository writer.

## Invariants

- Accept only closed plain I-JSON and exact canonical UTF-8 bytes, bounded to 64 KiB.
- Copy untrusted programmatic input before interpreting fields; never invoke getters, proxies,
  coercion hooks, or repository content.
- Bind the root channel, pack identity/schema, signed target channel/identity/schema/path, selected
  delegated role, repository ID, and TUF contract exactly.
- Require exact UTC-second metadata times and `issuedAt <= verificationTime < expires` for every
  authority needed by the selected lock.
- Use only the verifier-supplied fixed `verificationTime`; never read the clock or environment.
- Serialize deterministically with no newline. Restore an earlier canonical file for rollback; do
  not synthesize or mutate fields in place.
- Validate the lockfile, expected device/inode/SHA-256, and canonical repository-relative file path
  before granting the writer any bytes.
- Propagate the writer result or error unchanged so precommit and postcommit truth is preserved.
- Keep the standards package independent of evidence. Cross-package composition belongs in root
  integration tests and future CLI orchestration.
- Update existing files only. Do not weaken H04 or I10 to create a missing lock opportunistically.
- Keep H09 orchestration outside this codec: cache the H08-verified target first, make this
  compare-and-swap the sole activation point, and restore the exact prior lock for rollback.

The schema is intentionally redundant with runtime checks. Schema validation serves ecosystem and
packaging consumers; runtime validation supplies descriptor safety, resource bounds, real calendar
checks, and cross-field/TUF relationships.

## Verification

Run focused development checks:

```bash
pnpm exec vitest run packages/standards/test/standards-lockfile.unit.test.ts
pnpm exec vitest run tests/integration/standards-lockfile.integration.test.ts
pnpm exec tsc --noEmit -p packages/standards/tsconfig.json
pnpm package-boundaries:check
pnpm pack:check
```

The unit matrix covers stable/preview success, canonical/schema agreement, malformed and hostile
input, time/channel/role/binding failures, resource bounds, pre-mutation rejection, and unchanged
writer failures. The integration matrix uses C01/C02 and the real I10 writer to prove successful
publication, cancellation before commit, concurrent replacement rejection, canonical validity, and
absence of stale writer artifacts. Release integration also runs the serialized full `pnpm check`
gate on every supported platform.

Review the [standards lockfile API](../api/standards-lockfile.md),
[standards update API](../api/standards-update.md), [atomic writer API](../api/atomic-writer.md),
and [threat model](../security/threat-model.md) together when changing the format or update
sequence.
