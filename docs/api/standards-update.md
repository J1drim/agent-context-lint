# Verified standards update API

Ticket H09 composes the H08 signed freshness check, H01 knowledge-pack parser, H05 content-addressed
cache, H04 lockfile codec, and I10 repository atomic writer into one explicit update transaction. It
does not run during ordinary scans. The production registry allowlist is still empty, so an explicit
production update currently fails with `registry-unconfigured` before DNS. The packaged CLI exposes
this signed API through `standards update`. Maintainers who only need to detect changes in the
official documentation pages can use the separate local `pnpm standards:weekly` command; that
command compares bounded snapshots and never activates a standards pack.

```text
agent-context-lint standards update --dry-run --format json
agent-context-lint standards update --cache /private/var/cache/agent-context-lint --format json
```

The dry-run command requires an existing canonical lockfile but never opens a cache or writer. Safe
activation also requires `--cache` with a canonical absolute private directory. The path must not be
the repository root, a repository descendant, or a filesystem root. The command never infers cache
state from environment variables and never creates an initial lockfile. A configured registry is
still required before either form can produce a candidate.

```ts
const updater = StandardsUpdater.create(checker);
const preview = await updater.dryRun({ check, currentLockfile, currentPack }, { signal });

const activated = await updater.activate(
  { check, currentLockfile, currentPack },
  {
    cache,
    cacheLock: { maxAttempts: 20, retryDelayMs: 25 },
    expected: observedLockIdentityAndDigest,
    path: "agent-context-standards.lock.json",
    signal,
    writer,
  },
);
```

All request and option records are closed plain-data contracts. Proxies, accessors, symbols, unknown
fields, exotic byte containers, shared backing memory, invalid cache bounds, a non-native signal, a
noncanonical repository-relative path, or an invalid writer capability fail before acquisition or
mutation.

## Dry-run contract

`dryRun()` receives no cache or writer capability and therefore cannot persist anything. It checks
the current canonical lock and current canonical pack, verifies their complete binding, performs the
H08 update, verifies that H08 started from exactly the lock's trusted-state summaries, parses and
binds the candidate pack, and returns a frozen plan. The plan includes:

- current and candidate pack versions, target SHA-256 digests, and minimum engine versions;
- sorted unique ACL rule IDs added and removed;
- the exact selected delegated signer role, delegated metadata digest, reviewed 2-of-3 threshold,
  and authorized-key count;
- candidate canonical-lock digest, fixed verification time, and whether the candidate lock bytes are
  already active.

The result never contains target bytes, either lockfile body, a trust-store capability, cache paths,
remote bodies, or credentials. Its portable Draft 2020-12 schema is exported as
`@agent-context/standards/schemas/standards-update.v0.schema.json`.

The caller must construct H08 from the trusted state corresponding exactly to the active lock. H09
does not infer root or replay continuity from version numbers and does not deserialize a trust
capability from repository-controlled summaries. A mismatch returns `current-trust-mismatch` before
candidate activation.

## Activation order and idempotence

`activate()` repeats the complete preparation rather than accepting a caller-modified plan. A
successful non-no-op transaction has exactly this order:

1. Validate every local input and activation capability.
2. Bind the supplied canonical current-lock bytes to the exact digest observed for I10 CAS.
3. Perform H08 acquisition and atomic offline verification.
4. Parse and cross-bind the data-only candidate pack and canonical candidate lock.
5. Reuse or atomically publish the candidate bytes in the H05 cache by verified length and digest.
6. Replace the existing lockfile once through H04/I10 device/inode/digest compare-and-swap.
7. Return the writer's durability evidence and an in-memory rollback receipt.

The cache is availability data, not authority. It is populated before the lock changes so an active
lock never points at an unpublished candidate. A process interruption after cache publication but
before lock replacement may leave an unreachable content-addressed artifact; that is safe and a
later update reuses it. Cache failure or lock contention invokes no repository writer.

If the canonical candidate lock is already byte-for-byte active, activation returns `unchanged`,
does not open the cache writer, does not call the repository writer, and returns no receipt. A
different fixed check time or trusted-state summary is a real state transition even when the target
pack digest is unchanged.

Writer errors are intentionally not converted to update issues. The I10 `committed` property is the
only source of truth: `false` means no replacement occurred; `true` means the caller must inspect
the actual lock because the rename occurred before a later durability or cleanup failure.

## Explicit rollback

`rollbackStandardsUpdate(writer, receipt)` restores the exact prior canonical lock bytes through a
second H04/I10 compare-and-swap. A receipt is minted only after a successful activation, is bound to
the activated lock identity and digest in private process memory, and can be consumed once. A
serialized, copied, forged, proxied, stale, or already-used receipt has no rollback authority.

Rollback deliberately leaves the immutable cached candidate in place. It changes only the lockfile,
returns the writer's durability evidence, and cannot overwrite concurrent changes. The receipt is a
same-process recovery capability, not a persistent token. After restart, operators must inspect the
lock and use a fresh H08-verified update path; they must not reconstruct or deserialize a receipt.

## Primary-source review

Reviewed on 2026-08-02 against:

- [The Update Framework specification 1.0.35](https://theupdateframework.github.io/specification/latest/),
  last modified 2026-07-15: threshold roles, target handoff only after complete verification,
  replay/rollback/freeze resistance, and atomic preservation of the previous trusted state on update
  failure.
- [Node.js 24 filesystem documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/fs.html):
  filesystem calls are not intrinsically synchronized; H09 therefore delegates replacement and
  commit truth to the separately reviewed I10 compare-and-swap writer.
