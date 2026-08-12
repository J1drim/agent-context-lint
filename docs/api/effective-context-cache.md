# Effective-context memoization cache

E09 exposes `EffectiveContextMemoizationCache` from `@agent-context/resolver`. It memoizes genuine
E05 `EffectiveContextResolution` objects in memory under a SHA-256 content address. The cache is an
optimization, not a resolution authority: every miss runs E05, and an entry is published only after
the caller's dependency snapshot exactly covers the effective and imported repository paths.

The contract version is `0.1.0`. Requests use record kind
`agent-context-effective-context-cache-request`; inspectable keys use
`agent-context-effective-context-cache-key`.

## Request

`resolve(request, { signal })` and `key(request, { signal })` accept a closed request with:

- `configuration`: the complete validated B06/B07 effective configuration, using canonical profile
  IDs rather than YAML aliases;
- `configurationIdentity`: the C02 `{ device, inode }` identity of the repository configuration, or
  `null` when no repository configuration file exists;
- `context`: the exact E05 input envelope containing one same-process issued D03/D05/D08/D10/D13
  profile result, issued E04 import DAGs, and target;
- `documents`: one snapshot for every effective-context document, import DAG document, import entry,
  and attempted import target;
- `sampling`: a same-process E08 sampling proof that selected the exact target;
- `targetIdentity`: the C02 `{ device, inode }` identity of the selected target, or explicit `null`
  when upstream identity evidence is unavailable; and
- the E09 contract version and record kind.

An available document snapshot contains canonical repository path, copied bytes, and its C02 source
identity. An unavailable snapshot contains the path and explicit `null` bytes/identity. Available
and unavailable states cannot be conflated. Duplicate, missing, or surplus dependency paths fail.

## Content address

The final address frames and hashes these independent components:

| Component                 | Invalidates on                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `configurationSha256`     | Any semantic effective-configuration change                                              |
| `sourceIdentitySha256`    | Configuration, target, or document device/inode change, including same-byte replacement  |
| `dependencySha256`        | Document/import availability, byte length, or content digest change                      |
| `profileResolutionSha256` | Profile inputs/results, client/profile contract, activation, unknown, or version change  |
| `importDagSha256`         | Import content identities, ordering, occurrences, failures, trace, or uncertainty change |
| `samplingSha256`          | Selected target's E08 reasons or repository/sampling uncertainty change                  |
| `targetPath`              | Target path change                                                                       |

The profile ID, surface ID, profile contract version, and spec snapshot ID are also exposed in the
immutable key. They are already covered by `profileResolutionSha256`; the explicit fields make cache
provenance reviewable. Unrelated E08 targets do not invalidate one target's result.

Canonical hashing accepts only finite JSON-shaped data issued by dependencies. It uses sorted UTF-8
record keys and length framing, rejects malformed Unicode, accessors, proxies, symbols, sparse or
extended arrays, cycles, unsupported prototypes/values, and resource excess. Document bytes are
copied through typed-array intrinsics before hashing, so later caller mutation cannot change the
operation in progress.

## Warm and cold behavior

On an exact hit, `resolve` returns the same immutable E05-issued object stored by the cold run.
Therefore JSON bytes, unknown/conditional states, ambiguity IDs, document order, and assembly bytes
are identical. A miss cannot reuse a prefix, profile-only match, path-only match, or caller-provided
digest.

`key` derives an address without resolving or mutating cache statistics. `stats` returns immutable
entry, byte-weight, hit, miss, eviction, and oversized-result counts. `clear` removes entries and
their accounted weight while retaining cumulative counters.

Entries use deterministic insertion-order eviction. `maximumEntries`, `maximumWeightBytes`, and
`maximumEntryBytes` bound retained results. A valid result larger than the per-entry limit is
returned without storage; cache size never changes resolver semantics. Other hard limits bound
dependency files/bytes, path and identity bytes, canonical nodes, and canonical text.

Cancellation accepts only a native `AbortSignal`. An already-cancelled operation fails before key
derivation. Cancellation after key derivation or cold resolution is checked before a hit is reported
or an entry is published, so cancelled work cannot poison cache state. E11 owns asynchronous
scan-level cancellation and progress orchestration.

The cache performs no filesystem, process, environment, clock, network, model, or write operation.
It does not persist entries. A future persistent representation must be a separate verified
capability and cannot treat an untrusted serialized E05 object as issued authority.
