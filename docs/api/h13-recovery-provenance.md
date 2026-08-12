# H13 recovery-runtime provenance

H13 preparation accepts only a canonical repository root whose tracked index and worktree bytes are
identical. The source snapshot rejects untracked and ignored paths, non-stage-zero index entries,
symlinks, hard links, special files, configured `core.hooksPath`, repository hook files, unsafe
paths, concurrent file changes, and bounded-inventory overflow. Its canonical
`preparation-source-manifest.v1.json` records HEAD, index blob/mode/path rows, byte digests, and the
package-manager execution policy. The preparation container mounts this snapshot, never the live
worktree.

Both network fetch and offline installation invoke the pinned pnpm program directly. CLI arguments
fix lifecycle scripts, pre/post scripts, managed runtimes, frozen-lockfile behavior, registry or
offline mode, and the store. The environment disables Corepack project selection and user npm
configuration. The snapshot rejects tracked `.pnpmfile`/`pnpmfile` JavaScript hooks, pnpmfile keys
in package manifests, and pnpmfile settings in `.npmrc` or workspace configuration. Both phases also
force `ignore-pnpmfile`, a `/dev/null` global pnpmfile, and matching environment settings. Project
configuration remains input bytes but has no authority to re-enable hooks, scripts, Corepack,
proxies, redirects, or a different registry.

Preparation inspection is scoped to the pinned Docker 29.5.2 Linux/arm64 engine and declares the
complete supported raw Config and HostConfig key inventories for that version. A missing or unknown
key is rejected. Every declared raw value is retained in the confinement comparison, including log
driver/configuration, all CPU/memory/blkio/kernel/I/O resource fields, mounts and storage options,
devices and device requests, binds, DNS and extra hosts, port publishing, ulimits, sysctls,
masked/readonly paths, tmpfs, restart/runtime, and privilege controls. Effective mounts and stopped
PID state are bound separately. A remote log driver, injected `/dev/mem`, resource change, or new
engine inspect field is rejected before start; supporting a new Docker inspect shape requires an
explicit inventory and expected-policy update. Legacy `KernelMemory` and `KernelMemoryTCP`, absent
from the pinned client shape, are explicitly forbidden rather than silently ignored.

The network container has ordinary Docker bridge egress. Application-layer checks restrict the
download and pnpm registry origin to `https://registry.npmjs.org`, reject redirects and proxy
inheritance, and send no repository source. This is not a host firewall or registry-only network
allowlist; operators requiring that stronger property must add and separately audit an external
egress control.

## Reviewed transition

Run preparation twice into slots `a` and `b`. `createReviewedPreparationTransition()` accepts only
canonical byte-equal input manifests and byte-equal preparation-source manifests, exactly two
preparations, the accountable maintainer identity, and a valid review time. It binds the source
manifest digest into the prepared-input manifest.

`createBuildLockCandidate()` moves that review to `candidate-reviewed-for-build` while recording the
predecessor build-lock digest. After two deterministic offline builds,
`createRuntimeLockCandidate()` binds the exact candidate build-lock digest, copied build-input
provenance, predecessor runtime-lock digest, and observed OCI identity.
`assertReviewedLockTransition()` must pass before the pair can replace the committed locks. Capture
then carries the preparation-source and preparation-review digests through runtime provenance.

The transition API never edits committed locks or evidence. Promotion is a separate reviewed commit.
Any candidate/runtime mismatch, single preparation, source-manifest substitution, or predecessor
drift is rejected. The current committed locks and execution/tabletop evidence remain deliberately
stale until the two acknowledged network preparations, offline builds, lock review/promotion, and
fresh contained capture are completed.

## Offline lock-transition preflight

Before an operator requests the two network preparations, the read-only
`pnpm standards:recovery:preflight` command (or
`node tools/standards/recovery-lock-preflight.mjs --json`) checks the committed build/runtime lock
bytes. It performs no network, Docker, Git, subprocess, clock, environment, or mutation operation.
The JSON record includes exact lock-byte SHA-256 values, fixed reason codes, and two deliberately
narrow outcomes:

- `ready-for-offline-build` means only that a reviewed build-lock candidate contains the two-prepare
  provenance digests and predecessor binding. It does not assert that `.h13-runtime-inputs-reviewed`
  exists or that an offline build can run.
- `ready-for-capture` additionally means the candidate runtime lock has a matching exact build-lock
  digest, copied build-input provenance, predecessor binding, and a complete runtime-image identity.
  It still does not assert Docker availability, image presence, source freshness, or containment.

Any malformed/non-canonical lock bytes, missing transition, digest mismatch, input substitution, or
incomplete image identity returns `state: "blocked"` and exit code `2`; no fallback or implicit
promotion is attempted. If either lock cannot be read, preflight emits the stable
`build-lock-read-failed` or `runtime-lock-read-failed` issue code without exposing a host path or
filesystem error and still exits `2`. The checked-in locks intentionally produce this blocked state
until the authorized H13 preparation, offline-build, lock-review, and fresh-capture evidence is
complete.
