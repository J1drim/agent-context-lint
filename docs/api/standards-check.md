# Signed standards freshness check

Ticket H08 adds `StandardsChecker`, the explicit acquisition and verification boundary between the
H07 registry transport and the H02 immutable TUF trust state. Constructing or importing the checker,
inspecting trusted state, ordinary scanning, imports, and offline status perform no DNS or HTTP.
Only an explicit `check()` invocation can call the registry client.

```ts
const checker = StandardsChecker.create(trustedStore);
const result = await checker.check(
  {
    channel: "stable",
    engineVersion: "1.0.0",
    targetPath: "knowledge/stable/agent-context-bundled.json",
  },
  { signal },
);
```

The production H07 registry allowlist remains empty in this release. Consequently this API call
returns a frozen `registry-unconfigured` issue before DNS starts; neither the API nor CLI claims
that a release registry has been deployed. The separate maintainer command `pnpm standards:weekly`
performs the bounded, direct official-documentation snapshot comparison described in the user
standards guide. It is deliberately outside this signed TUF API and never activates a pack.

## CLI surface

```text
agent-context-lint standards status [--format terminal|json]
agent-context-lint standards check [--format terminal|json]
agent-context-lint standards update [--format terminal|json] [--dry-run] [--cache <directory>]
```

`status` uses the package-bundled authenticated pack and the configured lockfile through the
root-jailed read-only facade. It is deterministic for a supplied clock and does not use DNS, HTTP,
or a cache. `check` is the only command that invokes the registry transport. Its JSON failure is a
bounded command record with `recordKind: "agent-context-standards-command-error"`; remote response
bodies, URLs, headers, and credentials are never copied into the record. `update --dry-run` uses the
same explicit check but does not receive cache or writer capabilities. Safe activation additionally
requires an explicit absolute private cache root and an existing lockfile; it never infers a cache
directory from the environment or creates an initial lock. `--dry-run` and `--cache` are mutually
exclusive so a preview cannot accidentally carry a write-capable path.

## Fixed workflow

One invocation validates a closed stable/preview request and native `AbortSignal`, then records one
fixed UTC start time to whole-second precision. It never consults the clock again. A bogus,
throwing, non-finite, fractional, pre-epoch, or post-year-9999 clock fails before network.

The checker then performs this bounded sequence:

1. Starting at trusted root version `N`, request `N+1`, `N+2`, and so on. A sanitized 404 is the
   only normal terminator. Every other transport failure aborts. At most 32 root updates plus one
   termination probe are allowed.
2. Request unversioned timestamp metadata.
3. Read only the bounded positive snapshot version needed to construct the consistent-snapshot
   route, then request that versioned snapshot.
4. Read only the bounded top-level and selected delegated-role versions, then request those exact
   versioned files.
5. Read only the requested target's lowercase SHA-256 for the content-addressed pack route, then
   request that exact pack.
6. Submit the entire candidate, target bytes, original trusted state, request, and fixed start time
   to `OfflineTufTrustStore.verifyUpdate()` as one atomic offline verification.

Routing reads are not trust decisions. They use fatal UTF-8, reject BOM, malformed/incomplete JSON,
depth over 64, more than 50,000 structural values, non-positive/unsafe versions, missing objects,
and noncanonical target digests. All derived routes remain inside H07's fixed vocabulary. No parsed
metadata, version, digest, or target becomes authoritative until H02 verifies the complete chain.

## Authority and result

H02 verifies sequential dual-threshold root rotation; root, timestamp, snapshot, targets, and
delegated signatures; repository/policy/spec identities; role separation; fixed-time issue and
expiry policy; timestamp replay and rollback; snapshot rollback; consistent-snapshot version,
length, and hash bindings; delegation/channel; engine compatibility; and target length/digest.
Therefore future-issued, expired/frozen, replayed, rolled-back, fast-forward recovery,
mix-and-match, wrong-root, wrong-channel, and incompatible candidates fail atomically.

Success returns a frozen comparison report containing the old and candidate metadata summaries,
verified target identity, root-rotation summary, sanitized H07 provenance, fixed check time, and
request count. It deliberately exposes neither the candidate `OfflineTufTrustStore` capability nor
target bytes. H08 performs no filesystem read/write, cache/lock mutation, lockfile update,
quarantine, activation, or rollback. H09 consumes target bytes and the verified candidate state
through a private one-use handoff associated with this exact successful report. The handoff is not
exported from the package root, does not change the public report shape, and cannot be recreated
from serialized comparison evidence. See the [verified standards update API](standards-update.md).

Failures preserve a source discriminator (`check`, `registry`, or `trust`), bounded phase, typed
code, and already-sanitized path/message. Remote bodies, status text, URLs, certificate/DNS details,
clock exceptions, cancellation reasons, and target contents are never reflected.

## Bounds and tests

One check attempts at most 38 objects: 32 accepted roots, one root termination probe, timestamp,
snapshot, targets, one delegated role, and one pack. H07 independently bounds
DNS/TCP/TLS/header/body time, total time, cleanup, response bytes, headers, chunks, and process
concurrency. Cancellation is forwarded to every request and H07 confirms transport cleanup.

Tests use the repository's deterministic non-production signed bundle and injected fake clock, DNS,
and TLS only. They cover the current path, default-deny production behavior, no-network
construction, malformed input, clock failure, future issue time, expiry/freeze, replay, H02 rollback
contract coverage, mix-and-match, target tampering, missing objects, hostile routing JSON,
root-chain limits, cancellation, and cleanup. No live registry or external repository is contacted.

## Primary-source review

Reviewed on 2026-08-02 against the supported Node.js 24.18.1 runtime:

- [The Update Framework specification 1.0.35](https://theupdateframework.github.io/specification/latest/),
  last modified 2026-07-15: fixed update start time; sequential root `N+1` discovery and
  old/new-threshold verification; timestamp-first polling; expiry/freeze, replay and rollback
  checks; versioned consistent snapshots; snapshot/targets hash and version bindings; target
  verification; atomic failure/recovery expectations.
- [Node.js 24 global AbortSignal documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/globals.html):
  one-shot cancellation and listener lifecycle. H08 forwards the caller's already validated native
  signal; H07 owns intrinsic listener and transport cleanup behavior.
- [Node.js 24 HTTP documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html):
  request cancellation behavior. H08 does not create HTTP requests directly.

Documented difference: specification persistence steps are intentionally absent from H08. The
checker is a read-only freshness operation, and the existing trusted state remains unchanged on both
success and failure. H09 separately validates the current lock/pack, stores the verified target, and
atomically activates a newly constructed lock; a public H08 report alone never grants that
authority.
