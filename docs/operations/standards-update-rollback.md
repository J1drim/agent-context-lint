# Standards activation and rollback runbook

This runbook covers H09 local activation failures. It does not authorize standards publication,
trust-root replacement, registry changes, or manual lock editing. Use
[Standards trust recovery](../security/standards-recovery.md) for key or repository compromise.

## Before activation

1. Run the explicit dry-run and retain its bounded report: current/candidate version, digest,
   minimum engine version, rule additions/removals, signer role, signer-metadata digest, threshold,
   fixed check time, and candidate-lock digest.
2. Confirm the selected stable/preview channel and review rule/engine changes. A successful dry-run
   writes neither the repository nor the cache.
3. Observe the existing lock through the selected repository and pass its device, inode, SHA-256,
   and canonical relative path to activation. Do not reuse an old observation.
4. Keep the process alive if immediate rollback may be needed. Rollback authority is deliberately
   in-memory and is not serializable.

## Interpret activation outcomes

- `unchanged`: no cache or repository write occurred; there is nothing to roll back.
- `activated`: candidate bytes were safely stored/reused before one atomic lock replacement. Retain
  the returned receipt only in the current process until validation completes.
- Typed check/cache failure: the prior lock remains active and no repository writer was called.
- Writer error with `committed: false`: the prior lock remains active. Resolve cancellation,
  concurrent replacement, permissions, or validation failure and start with a fresh observation.
- Writer error with `committed: true`: do not claim rollback. Inspect and parse the actual lock,
  record its identity/digest, and choose recovery from observed state.

An unused content-addressed cache artifact after interruption is not active and need not be removed.
Never delete the last known-good lock or cache state as a first response.

## Immediate same-process rollback

Call `rollbackStandardsUpdate(writer, receipt)` once with the exact receipt object returned by the
successful activation. The operation replaces the current activated lock only if its identity and
digest still match. Success restores the exact previous canonical lock and leaves immutable cache
artifacts intact.

If rollback reports `rollback-invalid`, the receipt is forged, copied, stale, already used, or from
another process. If I10 reports a concurrent change, preserve that file and investigate; never
force-overwrite it. Handle rollback writer errors by their unchanged `committed` property exactly as
for activation.

## Recovery after process exit

There is no persistent rollback token. Do not copy fields from logs or reconstruct a receipt. Parse
and inspect the current lock, preserve evidence, restore trustworthy registry/clock conditions, and
perform a fresh explicit H08-verified update to the desired signed target. A known vulnerable
target, signature failure, replay indication, unexpected signer role, or key compromise escalates to
the security response and trust-recovery runbooks.

Record only sanitized versions, digests, identities, fixed verification time, typed outcome,
`committed` truth, and reviewer decision. Do not record target contents, credentials, remote bodies,
private key material, or writable external-repository paths.
