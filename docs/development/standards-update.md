# Developing verified standards updates

H09 is implemented in `packages/standards/src/standards-update.ts`. Keep orchestration in this
module: H08 owns acquisition and trust verification, H05 owns immutable cache publication, H04 owns
the canonical lock contract, and I10 owns filesystem replacement. Do not move network or writer
capabilities into parsers, the normal scan path, or a dry-run API.

## Invariants

- Obtain candidate bytes only from H08's private, one-use verified handoff. A public comparison
  report is evidence, not activation authority.
- Parse and bind both current and candidate packs. Match byte length/digest, channel, pack identity,
  version, publication time, schema, target identity, and exact current trusted-state summaries.
- Derive plans from verified immutable values. Sort and deduplicate rule IDs without
  locale-sensitive ordering; never expose target or previous-lock bytes.
- Keep dry-run capability-minimal: no cache, writer, path, expected identity, or rollback receipt.
- Validate the complete activation options object before calling H08 or opening the cache.
- Require the canonical current-lock bytes to hash to the I10 expected digest before calling H08;
  rollback must retain the exact file evidence that activation replaced.
- Store or validate the candidate's content-addressed cache entry before making the lock visible.
  Treat an orphaned immutable entry as safe; never treat a cache hit as trust evidence.
- Make the H04/I10 lock replacement the sole activation point. Preserve I10 writer exceptions and
  their `committed` truth unchanged.
- Return unchanged only for exact canonical candidate-lock equality. This keeps repeated identical
  calls idempotent while preserving meaningful trust/freshness transitions.
- Bind rollback authority to a private, one-use, same-process receipt and exact post-activation
  identity/digest. Restore the exact parsed prior lock; do not synthesize a downgrade.
- Require the H08 checker's current authenticated snapshot to equal the active lock's complete
  summaries. Never infer root/replay continuity from monotonic version numbers or reconstruct a
  trust capability from repository-controlled lock text.
- Update an existing regular lockfile only. Initial creation remains outside this ticket.

The public report schema is `packages/standards/schemas/standards-update.v0.schema.json`. Runtime
validation remains stricter because JSON Schema cannot express descriptor safety, unforgeable
capabilities, current-to-candidate trust continuity, byte-address bindings, or compare-and-swap.

## CLI composition

`packages/cli/src/standards-command.ts` is the only production composition layer for H06/H08/H09.
The router imports it lazily for the explicit `standards` command; ordinary scan/help construction
does not import or invoke the handler. The command selects a C01 repository root, resolves only the
repository configuration, reads the configured lock through C02, and loads the package-owned H03
bundle. The H03 loader's in-memory authenticated trust capability is handed to H08 and H09 through
the private accessor; it is never serialized or placed in a report.

`standards status` supplies H06 with a caller-controlled whole-second clock and no cache
observation. `standards check` invokes H08 and projects only sanitized comparison evidence.
`standards update --dry-run` supplies no cache or writer. Safe activation requires an explicit
canonical absolute `--cache` path outside the selected repository, opens H05, binds the observed
lock identity/digest, and delegates the single H04/I10 replacement. The command never creates an
initial lockfile. Errors are fixed-shape JSON records or bounded terminal text; repository,
registry, and filesystem error messages are not interpolated.

## Verification

Run the focused checks while developing:

```bash
pnpm exec vitest run packages/standards/test/standards-check.unit.test.ts
pnpm exec vitest run packages/standards/test/standards-update.unit.test.ts
pnpm exec vitest run tests/integration/standards-update.integration.test.ts
pnpm exec tsc --noEmit -p packages/standards/tsconfig.json
pnpm package-boundaries:check
pnpm pack:check
```

The matrix must include positive, negative, boundary, malformed, hostile-container, signature,
replay, trust-substitution, cache contention/race, concurrent replacement, precommit interruption,
rollback, forged/reused receipt, idempotence, schema, and packaged-runtime cases. Integration tests
use temporary repository-owned fixtures with real H05 and I10 capabilities. They do not mutate an
external repository or contact a live registry. The integration owner runs the serialized full
`pnpm check` gate before accepting the ticket.

Review the [update API](../api/standards-update.md),
[standards-check API](../api/standards-check.md), [lockfile API](../api/standards-lockfile.md), and
[recovery runbook](../operations/standards-update-rollback.md) together for every transaction
change.
