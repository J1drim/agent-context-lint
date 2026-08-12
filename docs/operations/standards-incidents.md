# Standards registry incident runbook

This H13 runbook is the operator index for standards registry outages, compromise, key lifecycle,
target withdrawal, rollback, and engine incompatibility. It does not create signing or publication
authority. Follow the threshold and custody requirements in
[Standards trust recovery](../security/standards-recovery.md), the local transaction rules in
[Standards activation and rollback](standards-update-rollback.md), and the severity/communication
process in [Security response](../security/security-response.md).

## First response for every incident

1. Stop publication and explicit standards acquisition when authenticity, role authority, or
   registry integrity is uncertain. Ordinary offline scans may continue only from the prior verified
   compatible bundled or locked pack and must report its recorded age.
2. Preserve signed metadata bytes, immutable object identities, versions, digests, expiry times,
   engine versions, the active lock, cache quarantine, audit logs, and public custody records. Never
   copy private keys, recovery phrases, credentials, source content, or writable external checkout
   paths into incident evidence.
3. Classify the incident using the matrix below. Do not weaken signatures, thresholds, canonical
   encoding, hashes, lengths, roles, channels, expiry, replay counters, engine requirements, TLS, or
   endpoint policy to restore availability.
4. Communicate affected pack digests and engine versions. Resume publication or acquisition only
   after the selected recovery path passes offline verification and the normal protected approval
   boundary.

## Decision matrix

| Incident                          | Required response                                                                                                                                                                                    | Explicitly forbidden                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Registry outage or freeze         | Disable acquisition, preserve the last known-good state, continue ordinary scans with stale/age status, and retry only through the bounded allowlisted client.                                       | Claiming live freshness, changing endpoint, following a redirect, extending expiry, or deleting the prior lock/cache.                   |
| Registry or metadata compromise   | Stop publication and acquisition, preserve evidence, quarantine affected online identities, identify the compromised role/target/storage boundary, and rotate or recover trust below.                | Treating cache or registry availability as trust authority.                                                                             |
| Root threshold compromise         | Stop all in-band updates and ship a separately reviewed executable release containing a new out-of-band bundled root through the normal npm provenance process.                                      | Claiming that attacker-controlled downloaded root metadata restores continuity.                                                         |
| Planned or emergency key rotation | Use exact sequential root versions and both old-root and new-root thresholds; issue fresh timestamp/snapshot state after an online-key change. Delegated rotation updates only its isolated channel. | Skipping an intermediate root, reusing an attacker-fast-forwarded counter, or granting one channel another channel's authority.         |
| Revocation or yank                | Publish newly versioned threshold-signed delegated metadata omitting the target or binding a reviewed replacement; then update snapshot/timestamp and issue an advisory.                             | Deleting immutable history or editing a user's lock by hand.                                                                            |
| Local activation rollback         | Use the original one-shot same-process receipt. After process exit, inspect current state and perform a fresh H08-verified update to the desired signed target.                                      | Serializing/reconstructing a receipt, force-overwriting a concurrent change, or describing an uncertain committed write as rolled back. |
| Engine incompatibility            | Reject activation before any lock write, retain the prior verified compatible lock, report required/current engine versions, and publish compatibility guidance or a reviewed engine release.        | Activating an incompatible target, ignoring `minimumEngineVersion`, or relabeling the target without new signed metadata.               |

## Recovery completion checklist

- The fixed verification time and complete root-to-target graph validate offline with the packaged
  verifier; replay, rollback, freeze, role/channel confusion, hash/length mismatch, malformed bytes,
  and unsupported engine versions still fail closed.
- The active lock is parsed from observed bytes and identifies a compatible, non-revoked target.
  Cache entries are evidence or immutable candidates, never activation authority.
- A clean client reconstructs the intended state from the supported bundled trust anchor and exact
  sequential metadata. No production private material enters source, tests, logs, or CI artifacts.
- The advisory names affected public identities, versions, digests, engine range, user action, and
  current status. Post-incident findings have an owner and milestone.
- Run `pnpm standards:recovery-drill`; retain its deterministic H13 record hash and the affected
  gate results with the incident record.

## Tabletop evidence

The committed [H13 tabletop record](../../tools/standards/evidence/recovery-tabletop.v1.json) covers
all seven rows above. `tools/standards/recovery-tabletop.mjs` reports schema validity, evidence
validity, and release acceptance separately. The explicit `standards:recovery-capture` command now
refuses to start an accountable command unless an OS containment provider proves control of detached
session leaders. A POSIX process group is not such proof. The reviewed provider is a digest-pinned
Docker client and server running a separately pinned Linux OCI image with its RepoDigest and image
configuration ID checked as distinct identities. It requires `--pull=never`, an explicit empty
`--pid=` value (Docker's inspected private PID mode; the pinned client rejects the literal word
`private`), `--init`, a PID limit, no network, a read-only root filesystem and source mount, bounded
tmpfs writes, dropped capabilities, `no-new-privileges`, resource limits, exact entrypoint/argv, and
awaited forced removal within the one absolute capture deadline. Before start, capture inspects and
requires the exact declared Docker 29.5.2 Config/HostConfig key inventories and binds every raw
value, including log driver/configuration, environment, user, devices, mounts, storage, DNS, ports,
ulimits, sysctls, masked/readonly paths, tmpfs, image identities, PID/IPC/network modes, labels, and
all resource fields. Missing, unknown, or changed fields fail before start. No Docker socket is
mounted into the container.

The reviewed runtime is defined by `tools/standards/container/Dockerfile`, `build-lock.v1.json`, and
`runtime-lock.v1.json`. Run
`node tools/standards/prepare-recovery-runtime.mjs --acknowledge-network --slot=a` and repeat with
`--slot=b` only as explicit network-enabled maintenance operations. The host first creates an exact
tracked index=worktree snapshot and rejects untracked, ignored, hook-configured, linked, raced, or
over-limit source. Tracked pnpmfile hook modules and pnpmfile settings in package, npm, or workspace
configuration are rejected; both pnpm phases force `ignore-pnpmfile` and a `/dev/null` global hook.
Its first container sees only the frozen lockfile and two bounded preparation modules—not repository
source—and fetches through HTTPS with the npm registry fixed to `registry.npmjs.org`; redirects and
proxy inheritance are refused. Docker bridge networking does not enforce registry-only egress, so
this is an application-layer fixed-origin control rather than a firewall claim. It discloses only
frozen public package identities, verifies the official pnpm SHA-1 and SHA-512 identities, and
fetches with scripts disabled. A separately named and labeled `--network=none` container then
receives the read-only repository, copies the fetched store, and performs the exact frozen offline
install with scripts disabled. No dependency lifecycle hook is run in either phase. Both phases and
the rootfs export use CSPRNG names, two exact ownership labels, PID/memory/CPU/output/deadline
limits, identity reconciliation after lost or malformed create results, and verified forced daemon
cleanup. Prepared-input and source inventories have explicit depth, directory-entry, file-size,
aggregate, deadline, and cancellation bounds. The operation emits ignored canonical
content-addressed rootfs and runtime-overlay archives. The committed raw official Node OCI index,
arm64 manifest, and configuration prove the locked index, platform, configuration, runtime
projection, and layer chain; their source is Docker Official Images (`docker.io/library/node`,
retrieved 2026-08-10). Rootfs export uses a never-started exact-image container and validates every
bounded tar header, rejecting unsafe members and PAX overrides while preserving payload, link,
permission, and capability semantics. The two complete preparations must have identical source and
input manifests and receive an explicit `reviewed-for-build` transition. Derive and review the
candidate build lock, including its predecessor and preparation digests. Then run
`node tools/standards/build-recovery-runtime.mjs --acknowledge-offline-build`. The direct Node
command is canonical because an unprepared pnpm launcher may bootstrap itself first. Two no-cache
`FROM scratch` builds use only the local rootfs/overlay archives, `--network=none`, `--pull=false`,
a fixed `SOURCE_DATE_EPOCH`, and no provenance sidecar; any differing OCI manifest, config, or layer
identity fails. The candidate runtime lock must bind the exact candidate build lock and OCI
identity; the pair is promotable only after `assertReviewedLockTransition()` passes. The Docker
client has a bounded deadline, but Docker does not provide this workflow an independently provable
BuildKit-daemon cancellation identity. A timed-out build is therefore a failed preparation: the
maintainer must inspect and stop the dedicated local build before retrying, and no runtime identity
or receipt from that attempt is accepted. Capture is supported only while the verified ignored
inputs and exact repeat-built image remain present. The receipt remains rejected until the next
remediation review; acceptance is not claimed.

Every capture container receives a CSPRNG name and two exact ownership labels. Capture checks name
absence before create, reconciles by exact name plus both labels even after timeout, malformed
stdout, or lost transport, inspects the image and ownership again before forced removal, and proves
no residual identity remains. Its cleanup reserve includes daemon scheduling margin and shares the
single absolute deadline.

The receipt binds the indexed and working bytes of all tracked files, excluding only the
self-referential receipt, its review record, and this implementation ledger. Capture requires
identical HEAD, index, tracked/untracked inventories, path inventory, working bytes, and working
metadata before and after the command interval, so mutating and then restoring a tracked file still
fails. Collection has file-count, per-file, aggregate, and Git-output bounds; rejects symlinks, hard
links, and unstable directory ancestry; and runs Git with sanitized worktree, index, object, and
configuration environment. Replay requires the captured Git commit to remain an ancestor and
recomputes the byte/index closure independently of the later evidence commit, avoiding a
self-referential commit hash.

Executable paths are never the final authority. Host capture reads approved Docker and Git bytes
through no-follow handles into private mode-0500, single-link artifacts, verifies their digests and
identities, executes those sealed artifacts, and rechecks them afterward. The read-only OCI image
separately binds the exact absolute Node, pnpm, Git, tar, and shell bytes injected into the package
audit, which never falls back to `PATH`; every executed identity is recorded in the supported
receipt. Commands use fixed canonical argv and exact accountable inventories. Unsupported evidence
is reported as `unsupported-historical-attestation`, never `current-replay`.

Docker containment behavior follows the Docker Engine documentation for isolated process trees,
private PID namespaces, `--init`, `--pids-limit`, read-only filesystems, and resource constraints:
<https://docs.docker.com/engine/containers/run/> and
<https://docs.docker.com/reference/cli/docker/container/run/>. The macOS limitation is based on
Apple's child-sandbox inheritance contract, which does not establish descendant lifecycle cleanup:
<https://developer.apple.com/documentation/foundation/process>.

Findings are structured lifecycle records with severity, summary, owner, target milestone/date,
status, and resolution chronology. Schema-valid P0–P3 open findings and rejected reviews remain
auditable but always produce `releaseAccepted=false`. The evidence records the prior rejections as
resolved findings rather than erasing them. The record is an exercise ledger, not a signature,
credential, trust anchor, or publication authority. The maintainer's review-subject hash covers the
receipt/source bindings, all scenarios, every field of every finding, the complete review metadata,
and the release decision. Review time must follow capture completion and every finding resolution;
any substitution requires a new accountable review.
