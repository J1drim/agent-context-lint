# Developing the standards cache

H05 treats the complete cache tree, including lock and quarantine metadata, as hostile input. Tests
must use explicit canonical temporary roots and must not infer a cache path from `HOME`, XDG values,
the working directory, a repository, or global configuration.

Run the focused cache suite and packaged standards audit during development:

```sh
pnpm build
pnpm exec vitest run packages/standards/test/standards-cache.unit.test.ts
pnpm exec vitest run packages/standards/test/standards-cache.unit.test.ts \
  --coverage --coverage.include=packages/standards/src/standards-cache.ts
node --test scripts/check-packed-manifests.test.mjs
pnpm pack:check
pnpm check
```

The focused suite covers both entry classes and byte ceilings; immutable success/failure wrappers;
malformed/accessor/proxy/exotic/shared byte inputs; restrictive modes; cache miss and corruption;
symbolic links, hard links, directories, and POSIX FIFOs; repeated pre-open, opened-file, post-read,
temporary, lock-owner, lock-directory, truncate, growth, and same-length races; competing locks;
bounded timeout; pre-wait and in-wait cancellation; forged, displaced, wrong, and released
capabilities; the exact rename/hardlink/re-alias replacement-after-release-check interleaving;
immutable owner bytes; absence of an authoritative empty state; retained flat-file loser debris;
valid retained post-link generations and permanent authority aliases; bounded non-authoritative
private debris; immediate reacquisition after cleanup expiry; one monotonic acquisition deadline
shared across retries and one-byte/400-millisecond drip probes; stable torn generations;
64-generation exhaustion; malformed, symbolic, hard-linked, copied-to-new-inode, special, orphan,
and forked generations; released-port reuse with a wrong Ed25519 proof; publication link/alias
replacement; valid-data preservation; bounded quarantine, output-link collisions, and source
replacement; and an observed normal-read no-network/no-environment invariant. Windows CI exercises
the same contract except POSIX FIFO construction; junctions enter the symbolic-link rejection path.

## Design constraints

- Cache bytes never carry authenticity. Do not add an API named `trusted`, `verified`, `activate`,
  `latest`, `fetch`, or `reacquire` to this layer.
- Never overwrite an existing content address, evict last-known-good data, automatically clear a
  lock, or infer ownership/staleness from mutable text, PID existence, or timestamps.
- Keep all names fixed, derived from validated lowercase SHA-256, or derived from engine-generated
  256-bit lowercase tokens. Do not accept caller-relative paths or quarantine names.
- Release must never write, link, rename, unlink, or remove acquisition state: Node has no
  identity-conditional pathname mutation. Ownership advances through an append-only, token-nominated
  chain only after the prior generation's ephemeral Ed25519 holder no longer accepts authenticated
  loopback challenges. Release may close only its private server, accepted sockets, and open
  handles; it must await close confirmation and repeat final path/real-path/identity checks.
- Owner records are immutable. Write and synchronize the complete record in the private temporary
  directory after atomically reserving one of 65 fixed authority-slot directories, bind the record
  to that inode, atomically hard-link it without overwrite to the flat token-nominated generation
  path and verify its exact bytes and two-link identity. Never remove the private alias: its bounded
  filename carries the public liveness authority and next token needed to recover a substituted or
  malformed dead generation. A canonical one-link record is the recovery authority when its alias is
  displaced. Empty reserved slots are non-authoritative capacity claims.
- Give every acquisition one monotonic absolute deadline, capped at 30 seconds and derived from its
  retry policy. Socket connect/read/write, cryptographic validation, generation traversal, retry
  waits, and holder shutdown consume that same budget; no retry or generation receives a fresh
  timeout. Reserve 100 milliseconds of that budget for bounded failure cleanup.
- Never unlink, rename, or remove a lock generation or lock-owner alias. Retain bounded one-link
  pre-publication debris and stable two-link authority aliases. After a failed link or validation,
  close the holder so traversal can advance only after authenticated death.
- Liveness is available only to explicit write/update locking. Bind numeric `127.0.0.1` without DNS,
  keep the Ed25519 private key memory-only, use a fresh random challenge for every probe, bound
  connections/bytes/deadlines, and treat timeout, wrong proof, port reuse, firewall failure, and
  every error other than explicit `ECONNREFUSED` as busy or fail-closed—not proof of death.
- Retained generations and private lock debris are deliberately bounded and never garbage-collected
  automatically. Allocate final capacity through atomic fixed-slot creation, never a racy count
  preflight: 64 claims can advance to 65, while 65 claims reject without changing the directory.
  Hitting 64 successor generations is an explicit fail-closed recovery boundary, not evidence that
  an old owner is stale.
- The portable Windows boundary is the same flat atomic-link/descriptor plus authenticated IPv4
  loopback protocol with POSIX mode enforcement waived. Do not substitute delete sharing,
  `LockFileEx`, junction traversal, shell helpers, PID probes, or an untested native addon.
- The lock is cooperative exclusion plus hostile replacement detection, not a distributed lease or a
  defense against an actively malicious process already running as the same OS account. Node 24
  exposes no portable descriptor-source hard link or identity-conditional unlink across Linux,
  macOS, and Windows; stable aliases and signed recovery avoid destructive pathname cleanup. Network
  filesystems with weaker metadata/atomicity guarantees require separate validation and are not
  claimed safe.

## Primary references

Reviewed on 2026-08-02 and rechecked on 2026-08-09 against the supported Node 24 runtime:

- [Node.js 24.18.1 filesystem API](https://nodejs.org/docs/latest-v24.x/api/fs.html): promise
  operations are not synchronized; explicit file-handle close, exclusive flags, `lstat`, `realpath`,
  BigInt `stat`, positional reads, synchronization, links, permissions, and rename caveats.
- [npm `cacache` source and design](https://github.com/npm/cacache): content-addressed integrity,
  temporary-file publication, verification on retrieval, and cache-not-authority semantics.
- [`proper-lockfile` source](https://github.com/moxystudio/node-proper-lockfile): atomic directory
  creation as portable lock prior art. H05 deliberately does not adopt its mtime/PID stale-lock
  takeover because mutable age/owner metadata is not authority in this threat model.
