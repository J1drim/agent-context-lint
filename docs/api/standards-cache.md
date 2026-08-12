# Hostile standards cache and process lock

Ticket H05 defines the private `@agent-context/standards` cache contract. The cache is an offline,
content-addressed byte store; it is never a trust root. Every returned entry is explicitly labeled
`origin: "untrusted-cache"`. H02/H03 or a future verified H07 update must validate signatures,
channel, engine compatibility, schema, length, and digest before cached bytes can affect analysis.

```ts
const opened = await StandardsCache.open(explicitAbsoluteCacheRoot);
if (opened.ok) {
  const hit = await opened.value.readEntry({
    kind: "artifact",
    length: expectedLength,
    sha256: expectedSha256,
  });
}
```

The root is explicit, absolute, canonical, and bounded. The API does not read the environment,
working directory, global configuration, PID, user name, or ambient clock. Normal reads use no
socket; explicit write locking uses only the authenticated numeric loopback liveness endpoint
described below. A miss or corrupt entry returns a frozen typed failure. It cannot download,
reacquire, activate, or silently fall back; only the explicit H07 network capability may fetch
missing bytes.

## Versioned layout

```text
<explicit-root>/
└── v1/
    ├── artifacts/sha256/ab/cdef….bin
    ├── state/sha256/ab/cdef….bin
    ├── locks/writer.v0.json
    ├── locks/.writer.generation-<next-token>.v0.json
    ├── temporary/<kind>-<sha256>.partial
    ├── temporary/lock-owner-slot-00…64/
    │   └── lock-owner-<next-token>-port-<port>-key-<public-key-hex>.partial
    └── quarantine/<kind>-sha256-<expected>-<observed>.corrupt
```

Artifact entries are limited to 4 MiB and state/TUF metadata entries to 512 KiB. Paths derive only
from a lowercase SHA-256 and fixed vocabulary. Directories are created with mode `0700` and files
with `0600`; pre-existing components with broader POSIX permissions are rejected, not repaired
through path-following mutation. Windows applies the platform's limited mode semantics while
retaining the link, identity, and containment checks Node exposes portably.

All components are rechecked with `lstat` and `realpath`. Reads require a regular non-symbolic file,
one link, exact size, canonical containment, `O_NOFOLLOW` where supported, matching path/open-handle
device and inode identity, stable nanosecond timestamps/mode/link count/size, exact positional EOF,
and address digest. The descriptor is opened before the replacement window and kept open through the
final path comparison, preventing immediate inode reuse from hiding a same-byte replacement.
Symbolic links, Windows junctions, hard links, directories, FIFOs, sockets, devices, replacements,
truncation, growth, and same-length mutation fail closed.

## Write lock and publication

`acquireWriteLock` is the only cache operation that opens a local liveness endpoint. Normal scans,
cache reads, and offline status never create a socket. Explicit write/update locking binds a server
to numeric IPv4 loopback `127.0.0.1` with no DNS, remote address, outbound connection, proxy, or
caller-selected port. The returned object is an in-memory capability bound in a private weak map to
the cache, exact open generation-file identity, and that exact server.

The owner record contains no PID, age, host, user, private key, or shared secret. It contains the
generation file device/inode identity, a random next-generation token, the loopback port, and an
ephemeral Ed25519 public key. The private key exists only in the acquiring process. A contender
sends a fresh random 256-bit challenge and accepts the holder as live only after verifying its
signature. An unrelated process that reuses the port, replays a response, stalls, or returns
malformed bytes is treated as busy, never as proof of death. Only an explicit loopback
`ECONNREFUSED` proves the holder is gone and permits traversal to the nominated successor. PID reuse
and mutable metadata are not authority.

The generation path and still-open owner handle are revalidated before every protected cache
mutation and after release closes liveness. A displaced writer therefore loses authority even if it
still retains the JavaScript capability object.

The holder accepts at most eight simultaneous connections, at most 65 request bytes per connection,
and closes an incomplete connection after one second. Probes use an independent absolute timer from
the shared acquisition deadline; partial reads do not reset it. Bind, firewall, resource, and
protocol failures are sanitized and fail closed. Release destroys all accepted sockets, closes the
exact server, awaits close confirmation, then rechecks the immutable filesystem identity. It never
writes, renames, links, or unlinks acquisition state.

Waits require explicit `maxAttempts`, `retryDelayMs`, and a native `AbortSignal`. Attempts are
capped at 100 and one delay at 1 second. Acquisition receives one monotonic absolute budget of
`min(30 seconds, 1 second + maxAttempts × retryDelayMs)`; 100 milliseconds are reserved for cleanup.
The same deadline is checked through chain traversal, key generation/verification, socket bind,
connect/read/write, retry waits, publication, and close. A stalled generation therefore cannot add a
fresh timeout on each attempt or retained generation. Cancellation and thrown reasons are sanitized.
No lock-owner pathname is ever removed, renamed, or overwritten. Each attempt that reaches
publication first claims one of 65 fixed slot directories with atomic no-overwrite `mkdir`;
concurrent attempts therefore cannot exceed the capacity even when they share an earlier snapshot.
Pre-publication failures retain the claimed slot and, if created, a bounded one-link private record.
After the atomic link succeeds, every failure retains the generation and its stable two-link
authority alias, closes its holder, and lets the next acquisition advance only after authenticated
dead-holder proof. This avoids every stat-then-unlink race.

The initial generation is `writer.v0.json`. A dead generation points to exactly one flat immutable
`.writer.generation-<token>.v0.json` successor. Each complete owner record is written and
synchronized inside its reserved `temporary/lock-owner-slot-00…64` directory, binds its own file
device/inode, and is atomically hard-linked without overwrite to that nominated path. An empty slot
is a permanent, non-authoritative capacity claim left by an interrupted publisher. The private alias
is permanent and encodes the holder port, public key, and next token. The alias is the recovery
authority if publication linked a concurrently substituted or subsequently malformed record: a live
signed holder remains busy, while an explicitly dead holder advances through the alias token. A
canonical one-link generation remains recoverable if its alias was displaced; the record itself
supplies the same signed authority. Private one-link pre-publication debris is non-authoritative and
strictly shaped. Existing flat aliases remain readable and consume the first logical slots, while
atomic slot arbitration guarantees at most 65 aliases in total. Exact owner bytes are reread and
parsed before a capability is returned. Retained files form an append-only chain. Symlinks, copied
records without either inode-bound canonical bytes or the exact stable alias, special files, orphan
generations, unexplained aliases, and forked chains fail closed. Exhaustion requires explicit
offline operator recovery and is never silently collected.

Linux, macOS, and Windows use the same immutable-generation protocol. Windows does not enforce POSIX
mode bits, but still requires canonical containment, regular-file type, the exact publication-link
shape, exact bytes, atomic no-overwrite linking, stable file identity, and authenticated loopback
liveness. Junctions and reparse-point paths fail canonical real-path checks. No `LockFileEx`,
advisory lock, native addon, shell command, PID probe, or rename-overwrite assumption is part of the
contract.

Node filesystem promises cannot interrupt a kernel-level filesystem stall. The supported deadline
claim therefore requires an ordinary local filesystem with responsive metadata operations; network
or faulted filesystems need process/worker containment by the caller. Within that boundary, the
independent monotonic timer forcibly closes acquisition sockets and the holder server, all protocol
events contain deadline and crypto failures inside the acquisition promise, and acquisition
including the reserved cleanup window settles within the 30-second cap.

Writers must hold the unforgeable active capability. Candidate bytes are defensively copied and
checked against their address before any write. A restrictive exclusive temporary file is fully
written and synchronized, then atomically published by a same-filesystem hard link and immediate
temporary unlink. Readers reject the brief two-link state. Existing destinations are preserved and
never overwritten, retaining last-known-good content.

H09 activation uses only `artifact` entries and stores or validates the verified candidate before
changing the repository lock. A later lock failure can therefore leave an unreachable immutable
artifact, but cannot activate it. A cache hit is never sufficient authority: H09 first performs H08
verification and rechecks the candidate schema, digest, length, channel, and pack/target bindings.
Rollback changes only the lock and deliberately retains content-addressed artifacts for safe reuse.

## Corruption and quarantine

`readEntry` classifies missing, unsafe, concurrently changed, length-mismatched, and
digest-mismatched entries without mutation. `quarantineCorruptEntry` is an explicit offline
write-lock operation. It copies only a same-length, safely opened digest-mismatched entry to an
exclusive deterministic quarantine file, synchronizes it, rechecks the source identity, then unlinks
the source. Valid data, replacement files, and unrelated entries are preserved.

Quarantine is recoverable and limited to 64 files. Repeated identical corruption reuses only an
exact existing quarantine copy; name collisions, special/link entries, and a full quarantine fail
closed. Quarantine never triggers deletion, network access, or reacquisition.
