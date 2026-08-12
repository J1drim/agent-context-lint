# Standards trust rotation, revocation, and recovery

This H02 runbook covers the Agent Context Standards TUF trust domain. It supplements the
[security-response process](security-response.md) and the normative
[TUF trust contract](../api/tuf-trust-model.md). It does not authorize publication: protected
environment rules and the independent approvals in the ownership policy still apply.

The H03 npm bundle is an out-of-band offline baseline. Its manifest length and SHA-256 are compiled
into the executable loader, and every signed metadata/target artifact is independently bound by the
manifest before H02 verification. The initial bootstrap bundle retained no private key material and
cannot authorize a future registry update. Replacing its root, fixed verification time, manifest
anchor, or content digest therefore requires a reviewed executable release and the production key
custody ceremony below; downloaded metadata can never silently replace those values.

The H05 cache is not recovery authority. Corrupt entries are classified offline and may be moved,
under the exclusive identity-bound write lock, only to the bounded recoverable quarantine. The cache
does not automatically evict good data, break a lock using PID/age text, download a replacement, or
claim freshness. Operators preserve quarantine and the last known-good bundled/locked state during
an incident; explicit reacquisition remains an H07/H08 operation after trust and transport review.

The local H10/H11 standards review is also not recovery or publication authority. Keep the prior
reviewed baseline, reject an unsafe or ambiguous handoff, and retain only bounded review evidence.
Never convert a passing local replay into permission to bypass threshold signing, metadata
versioning, expiry, or the protected release ceremony below.

For incident triage and the closed H13 outage/compromise/rotation/revocation/yank/rollback/engine
matrix, use the [standards registry incident runbook](../operations/standards-incidents.md). This
document remains the normative key-custody and trust-anchor recovery procedure.

## Roles and custody inventory

The release owner maintains an access-controlled inventory containing only public key IDs, custodian
identity, hardware or encrypted-offline storage class, creation/activation date, role, last ceremony,
and planned rotation. Private keys, recovery phrases, PINs, tokens, exported signing requests, and
unredacted ceremony recordings are never committed or attached to CI artifacts.

- Root, top-level targets, stable, and preview each use three separate offline custodians and a 2-of-3
  threshold. No person/device/key serves two roles.
- Snapshot and timestamp use separate 1-of-1 online identities with no target authority. Their
  environment has metadata-only input/output, least privilege, short-lived credentials, audit logs,
  and no npm or source-merge authority.
- Stable custodians and preview custodians are separate. Promotion creates newly reviewed stable
  metadata; a preview signature is never accepted as a stable signature.
- Every public key ID is independently recomputed as SHA-256 of the exact OLPC canonical public-key
  object before it enters root or delegation metadata.

The accountable maintainer verifies the inventory quarterly, before an RC, after personnel/device
changes, and after every incident. Missing custody evidence blocks standards publication.

## Planned rotation

### Root or top-level role key

1. Open a protected rotation record naming reason, affected public key ID, old root version, proposed
   next exact version, custodians, reviewers, and planned validity window.
2. Generate the replacement offline on a distinct approved device. Record only its public object and
   recomputed key ID.
3. Construct exactly `N+1.root.json`. Remove the retired key, add the replacement, preserve 2-of-3,
   disjoint role identities, repository identity, consistent snapshots, and the closed POUF.
4. Obtain at least two valid signatures from keys authorized by root `N` and at least two valid
   signatures from keys authorized by root `N+1`. One signature may satisfy both sets only when that
   key remains authorized, but each unique key counts once per threshold.
5. Verify the complete root chain from the oldest supported bundled root with the packaged verifier.
   Never publish only the newest root; every intermediate version remains immutable and available.
6. If timestamp or snapshot keys change, generate new current metadata under the new identities. The
   client deliberately clears prior timestamp/snapshot fast-forward counters after verified root
   rotation, then establishes them from this fresh repository state.
7. Run the automated drill and full gate, record the accountable maintainer's standards and security
   review, publish immutable metadata, and verify from a clean client with network acquisition
   separated from offline verification.
8. Mark the retired private key destroyed or quarantined according to the custody record. Keep its
   public identity and signed historical metadata for audit.

### Stable or preview delegated key

1. Generate a replacement offline and update only the relevant channel key set in newly versioned,
   2-of-3-signed top-level targets metadata.
2. Sign new delegated metadata with at least two keys from the new channel set. A retired key must not
   appear in the delegation and must not satisfy the new threshold.
3. Increment delegated, top-level targets, snapshot, and timestamp versions in publication order.
   Bind exact byte lengths and SHA-256 values at every parent edge.
4. Prove that stable and preview paths, keys, and target `custom.channel` remain isolated. A channel
   rotation never grants authority over the other channel.

### Timestamp or snapshot key

Online-key replacement is authorized only through a sequential dual-threshold root update. After
root rotation, issue fresh versioned snapshot and timestamp metadata using the replacement key and
short lifetime. Do not reuse or trust attacker-controlled fast-forward versions. Root recovery
permits clean version counters only because both old and new root thresholds authorized the new
online identity.

## Suspected compromise

Follow the S0/S1 response targets in [Security response](security-response.md). Immediately:

1. Stop standards publication and protect logs, public metadata, observed digests, versions, expiry,
   registry objects, and custody evidence. Do not copy private keys into incident storage.
2. Identify whether compromise affects one key, a threshold, an online role, target bytes,
   publication storage, or the executable/npm release path. One compromised offline key is below a
   2-of-3 threshold but still requires prompt revocation.
3. Preserve the last known good locked pack for offline scans. Disable freshness/update acquisition
   if it cannot be made safe; never bypass verification or extend expired metadata locally.
4. For a single root/top-level/delegated key, perform the appropriate threshold-authorized rotation
   above. For an online key, rotate it through root and re-establish clean metadata versions.
5. Revoke a malicious target by publishing newly versioned delegated metadata that omits it or binds
   a reviewed replacement, then update snapshot and timestamp. Record affected pack digests and
   engine versions in the advisory.
6. If a threshold of root keys may be compromised, normal in-band root continuity is no longer a
   safe recovery claim. Stop updates, ship a reviewed executable release with a new out-of-band
   bundled root through the npm release/provenance process, and treat possibly affected clients and
   packs as compromised. Never silently replace the trust anchor in downloaded data.
7. Complete independent verification, regression fixtures, public communication, credential/key
   destruction, and post-incident review before publication resumes.

## Registry outage, freeze, and clock failure

- A mirror can deny availability. Expired timestamp, snapshot, delegated, targets, or final root
  metadata makes the failure visible; it does not authorize use as a fresh update.
- Ordinary offline scans may keep using the prior verified lock under H03/H06 and report recorded age.
  They must not claim a live latest version.
- Retry acquisition only through H07's explicit allowlisted bounded client. Do not change endpoint,
  follow an untrusted redirect, relax length/hash/signature/expiry, or delete last known good state.
- H08 `standards check` is read-only: it records one fixed start time, verifies a complete candidate,
  and returns comparison summaries without exposing activation authority or mutating cache/lock state.
  A successful check is not an update; H09 is the explicit activation path. H09 validates current
  lock/pack continuity, stores the verified candidate before one H04/I10 lock compare-and-swap, and
  returns a private one-use same-process rollback capability. See the
  [activation and rollback runbook](../operations/standards-update-rollback.md).
- A local clock outside the documented policy aborts the update with a clock/freshness error. Operators
  correct the host time and rerun with one new fixed start time; they do not edit signed times.

## Engine incompatibility and target withdrawal

- Verification rejects a target whose minimum engine version is newer than the running engine before
  activation. Preserve the prior verified compatible lock and report the exact required/current
  versions; never edit signed custom metadata or bypass the compatibility gate.
- Yank or revoke a harmful pack through newly versioned threshold-signed delegated metadata that omits
  the target or binds a reviewed replacement, followed by new snapshot and timestamp metadata. Keep
  immutable historical objects for audit and publish the affected digest/version range.
- A withdrawn target already present in a user's lock is an explicit security/compatibility response,
  not authority to rewrite that repository. Publish deterministic guidance for an H08-verified H09
  update or, where required, a compatible engine release.

## Automated recovery drill

Run from a clean checkout using the exact supported toolchain:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm standards:recovery-drill
pnpm check
```

The aggregate `pnpm security:validate` gate checks the portable maintainer and standards controls;
it does not replay H13 evidence automatically. The H13 tabletop is an explicit, host-bound drill
because its receipt binds a reviewed containment runtime, executable identities, and source closure.
Run it only on the supported capture host after reviewing the receipt and its accountable inputs.

The deterministic drill uses public fixture-derived non-production keys only. Capture with
`pnpm standards:recovery-capture` only on a host with the reviewed offline Docker containment
capability. Run
`node tools/standards/prepare-recovery-runtime.mjs --acknowledge-network --slot=a` and `--slot=b` as
the separate
acknowledged network step and review its exact npm-registry dependency-name/version disclosure. The
networked container receives only the frozen lockfile and bounded preparation modules, uses the
fixed HTTPS registry with proxy inheritance and redirects disabled, and fetches with scripts
disabled. Docker bridge mode still provides general egress; registry-only enforcement is at the
application URL/client layer, not a Docker firewall claim. A different `--network=none` container
receives an exact tracked index=worktree snapshot—not the live repository—and performs the frozen
offline install with scripts disabled; no dependency lifecycle code sees repository bytes while it
has network authority. Tracked pnpmfile modules and pnpmfile settings in package/npm/workspace
configuration are rejected, while `ignore-pnpmfile`, `/dev/null` global-pnpmfile, and matching
environment controls are fixed in both phases. No lifecycle or project configuration hook is used
to construct the shipped overlay. Every
preparation container is CSPRNG-named, ownership-labeled twice, resource-bounded, reconciled after
ambiguous create outcomes, and forcibly removed by its verified daemon identity.
Preparation inspection is version-scoped to the pinned Docker 29.5.2 Linux/arm64 shape: exact raw
Config and HostConfig key inventories reject missing or unknown fields, and every admitted value is
bound. This includes remote-capable log configuration, mounts/storage, device access, networking,
and all kernel/CPU/memory/blkio/I/O resource controls.
Then run `node tools/standards/build-recovery-runtime.mjs --acknowledge-offline-build`. These direct
Node entrypoints are canonical: an unprepared pnpm launcher may perform its own version/runtime
bootstrap before it invokes a package script. Preparation verifies the complete raw base OCI
index/platform/config chain, exports an unstarted exact-image root filesystem, canonicalizes only
bounded tar headers, and creates a fixed-metadata runtime overlay from the integrity-checked pnpm
archive and frozen dependencies. Two complete preparations must produce identical source and input
manifests. An accountable review binds them into a candidate build lock with its predecessor; the
candidate runtime lock then binds that exact build lock, its predecessor, and the OCI identity. The
build verifies every prepared input byte and performs two `FROM scratch`, `--network=none`,
`--pull=false`, no-cache builds from those local rootfs/overlay archives. It has no external base
resolver and refuses unequal manifest, configuration, or layer identities. Prepared-input and
source traversal is fail-fast under depth, entry, file, byte, deadline, and cancellation ceilings.
A Docker-client build timeout invalidates the attempt and requires explicit inspection/termination
of the local BuildKit job before retry because daemon cancellation identity is not independently
provable here. Confirm the result against
`tools/standards/container/runtime-lock.v1.json`, then replay the generated receipt and committed
[H13 tabletop record](../../tools/standards/evidence/recovery-tabletop.v1.json) with
`pnpm standards:recovery-drill`. Capture refuses before command execution when the pinned Docker
client/server, distinct OCI RepoDigest and image configuration ID, or content-addressed Node 24
runtime/dependency input is unavailable. An unsupported historical attestation is reviewable but
cannot release. A supported capture executes the trust suite, non-self-referential standards-tool
tests, and real clean package audit rather than accepting declared totals. It proves:

1. baseline stable and preview updates satisfy root → timestamp → snapshot → targets → delegated →
   target verification;
2. one delegated signer cannot meet 2-of-3 and a revoked delegated key cannot authorize a target;
3. root `N+1` fails without the old threshold, new threshold, or exact sequential version;
4. an authorized root rotation changes timestamp/snapshot identities, clears hostile fast-forward
   counters, and accepts a fresh version-1 repository state only under the new keys;
5. replay, rollback, freeze, mix-and-match, wrong channel/role/engine, signature, hash, length,
   canonical-byte, malformed-input, proxy/accessor, and resource-limit cases fail closed;
6. a failed candidate leaves the prior immutable state intact and invokes no network or ambient clock.

Attach only the exact source-tree inventory, executable-bound tool versions, command deadline and
termination results, test identities, deterministic result hash, exact four-package inventory,
findings, and reviewer decision to the exercise record. Never attach test
private material, raw hostile metadata, production credentials, or a writable external repository.
For this sole-maintainer repository, the accountable maintainer records the decision and UTC time;
release acceptance additionally requires exact offline replay and no open P0/P1/P2 findings.

## Exercise record template

| Field | Required value |
|---|---|
| Date and ticket | UTC date; H02 or later trust-change ID |
| Exact source | Stable pre/post ancestor HEAD, index, tracked/untracked inventories, working metadata, and every bounded tracked path/byte row; restoration after an in-command mutation is rejected; only the receipt, review record, and status ledger may be excluded |
| Toolchain | Private single-link sealed copies of approved host Docker and Git bytes; immutable read-only-image Node, pnpm, Git, tar, and shell bytes; fixed digests and pre/post identity checks; raw official base index/platform/config chain; npm integrity/shasum; canonical frozen dependency snapshot; reproducible OCI manifest/config proof |
| Scenarios | inject, expected response, observed response, outcome, and every normative action |
| Evidence | Canonical generated receipt: explicit supported/unsupported containment result, digest of the exact inspected config/host-config/mount/PID/network/resource policy, fixed argv, one hard absolute deadline including reconciled awaited forced removal, exact accountable 24/40 test identities, exact four-package names/counts, every actual executable identity, and stable source closure |
| Review | Sole accountable maintainer identity, decision, UTC time after capture/resolutions, and hash of receipt/source bindings, scenarios, full findings, review metadata, and release decision |
| Findings | P0–P3 severity, summary, owner, target milestone/date, open/resolved status, and valid resolution chronology |
| Outcome | approved/rejected and next scheduled exercise |
