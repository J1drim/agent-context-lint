# Offline standards status API

H06 exposes `createOfflineStandardsStatus` from `@agent-context/standards`. It combines an
authenticated H03 bundled pack, optional canonical H04 lock bytes, and optional caller-supplied H05
cache metadata into one deterministic status report. The function has no filesystem, network,
environment, repository, clock, or mutation capability.

```ts
const status = createOfflineStandardsStatus({
  asOf: "2026-08-02T12:00:00Z",
  bundled: loadedBundle,
  cachedLatest: null,
  engineVersion: "0.1.0",
  lockfile: canonicalLockBytes,
  maxAgeDays: 30,
});
```

`asOf` is a required exact RFC 3339 UTC second. Repeating a call with identical inputs produces an
identical deeply frozen result. The API never reads `Date.now()`. `maxAgeDays` is an integer from 1
through 365, inclusive. Age is the difference between UTC calendar dates, so a pack becomes stale
only when `ageDays > maxAgeDays`; the configured limit itself remains current.

The result contains the existing B05 `StandardsOutput` plus:

- separate bundled and locked age records;
- the policy selection used to evaluate age;
- `lastCheckedAt`, which is either the cache observation time or `null`;
- bounded, sorted, machine-readable issues; and
- contract identity `agent-context-offline-standards-status` version `0.1.0`.

The portable closed schema is exported as
`@agent-context/standards/schemas/offline-standards-status.v0.schema.json`. Runtime validation is
stricter: it rejects proxies, accessors, symbols, exotic prototypes, unknown fields, invalid real
dates, non-exact timestamps, unsafe SemVer values, and unauthenticated structural copies of a
bundle.

## Meaning of status fields

`bundled` is derived only from the H03 authenticated loader. `locked` reports a syntactically and
internally valid H04 lock for the same channel, but parsing a lock does not authenticate external
pack bytes. H06 reports `activation: "locked"` only when every available content and provenance
binding matches the authenticated bundled pack: pack identity/version/date/schema; target path,
length, digest, and minimum-engine version; fixed verification time; and the complete TUF
trusted-state snapshot. A different valid lock is still visible for diagnosis, receives
`lock-authority-unauthenticated`, and cannot replace bundled authority. H09 owns authenticated
activation of non-bundled content.

`cachedLatest` accepts only a closed observation with literal origin `untrusted-offline-cache`.
Cache data is informational even when well formed. It can make freshness `update-available` or
`current` **as of** `lastCheckedAt`; it can never activate standards or prove current global
registry state. Without a usable observation freshness is `offline-unknown`. A newer cached pack
that needs a newer engine remains an informational update and emits `cached-engine-incompatible`.

In the nested B05 artifacts, `retrievedAt` has source-specific provenance:

- bundled and locked: the recorded fixed verification time;
- cached latest: the recorded last-check time.

It is never the time of this API call and never evidence of a live network check.

## Failure behavior

Invalid top-level authority, time, or policy inputs return `ok: false`. A malformed, wrong-channel,
future, incompatible, or unavailable lock/cache observation becomes a bounded status problem when
the authenticated bundled baseline can still be reported. No exception detail or hostile input is
echoed. A stale selected pack emits `selected-pack-stale`; presentation layers map this evidence to
ACL500/ACL501 under the applicable CLI policy.

See the [bundled loader](bundled-knowledge-pack-loader.md),
[standards lockfile](standards-lockfile.md), [standards cache](standards-cache.md), and
[output contracts](output-contracts.md).
