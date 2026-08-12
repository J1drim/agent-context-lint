# Safe fix pipeline API

`@agent-context/evidence` exposes I11 as an explicit preview-first capability built on the B03/B04
contracts and I10 atomic writer. Ordinary scan remains read-only. The only CLI grammar that can ask
for a preview is `scan [repository] --fix-dry-run`; the flag itself never grants write authority.

```ts
import { createSafeFixPipeline, issueSafeFixEligibility } from "@agent-context/evidence";

const eligibility = issueSafeFixEligibility({
  confidence: 1,
  diagnosticId: diagnostic.id,
  plan: diagnostic.suggestion.fixPlan,
  policyState: "eligible",
  ruleId: diagnostic.ruleId,
  ruleVersion: diagnostic.ruleVersion,
});

const pipeline = await createSafeFixPipeline(selection);
const preview = pipeline.preview({
  bundle,
  candidates: [eligibility],
  minimumConfidence: 0.95,
  selectedPlanIds: [eligibility.planId],
  sources: [{ identity: analyzedFile.identity, source }],
});
```

`issueSafeFixEligibility()` is a trusted engine boundary for the later I12/F15 mechanical-rule
scheduler. Repository files, configuration, serialized JSON, plug-ins, and user input must never be
allowed to invoke it. Its objects are unforgeable in-memory capabilities bound to the exact rule ID
and version, diagnostic ID, plan ID, canonical plan digest, confidence, and post-policy `eligible`
state. Clones, proxies, ordinary lookalike objects, changed plans, suppressed results, and
confidence below `0.95` fail closed. Baseline-hidden, disabled, or safety-unproved results must not
receive a capability.

I12's [`planApprovedMechanicalFixes()`](mechanical-fixes.md) is the current trusted issuer. It
authenticates a genuine F05/B08 finalization and approves only the safe ACL109 subset. I12
incorporates the selected UTF-8 fragment digest into the deterministic plan ID; I11's private
capability state binds that ID and the canonical plan digest without changing the published B04 v0
contract.

Selection is always explicit and UTF-8 sorted. An empty selection creates an immutable no-op
preview; there is no implicit “fix everything” mode. Across selected plans the planner rejects
duplicate or overlapping edits, two insertions at one offset, edit-and-move of one source, repeated
move sources, and duplicate destinations. Adjacent half-open edits remain valid. Aggregate source,
operation, replacement, and patch limits are checked with bounded sorting and a linear source
rebuild. A create/move destination already present in the analyzed source set is also rejected
because its B04 `absent` precondition is already disproved.

## Deterministic review patch

The preview contains canonically ordered change records, a deterministic Git-style review patch, and
SHA-256 of the exact patch bytes. The patch is a display artifact, not application authority and not
promised to be accepted by `git apply`: repository text is passed through the central B05 secret and
terminal-control sanitizer, and backslashes are escaped. This prevents credentials, ANSI/C0/C1, and
bidirectional controls from becoming active output. Applying uses private defensively copied bytes
bound to the preview, never the display patch.

The layout follows Git's documented extended headers and unified `-`/`+` review convention. See the
official [Git patch format](https://git-scm.com/docs/diff-generate-patch.html), retrieved
2026-08-02.

## Application and concurrency

`apply()` accepts exactly the same unused preview object returned by that pipeline. A clone,
serialized value, proxy, foreign-pipeline preview, second call, or concurrent reuse is rejected.
Before mutation it re-reads the complete selected source through C02 and compares exact bytes,
SHA-256, device, and inode. I10 then repeats root, parent, type, link, mode, metadata, digest,
cancellation, temporary-file, and immediately-before-rename checks.

One preview may coalesce any number of disjoint selected edits to one existing file. That
replacement is crash-safe and atomic under I10. Its result reports actual `file-and-directory` or
`file-only` durability; an empty preview reports `not-applicable`. A post-rename durability/cleanup
failure is an error with `committed: true`, never described as rollback.

Portable Node provides no cross-file atomic rename transaction and no no-clobber conditional rename.
Consequently application currently rejects, before any write:

- previews affecting more than one existing file;
- `create-document`; and
- `move-document`.

These operations are still fully validated and previewed for I13 and review workflows. They cannot
be applied until a durable, identity-validated transaction/recovery protocol is implemented and
tested. Sequential writes with best-effort rollback are deliberately not represented as atomic. Node
documents that promise filesystem operations are not synchronized against concurrent modification;
see the official [Node.js 24 filesystem API](https://nodejs.org/docs/latest-v24.x/api/fs.html),
retrieved 2026-08-02.

## Errors

`SafeFixError` is frozen and contains a stable code, sanitized operation, repository-relative
affected paths, stable cause code where available, and `committed`. Absolute paths, source content,
temporary names, thrown repository text, and secrets are excluded. Rejected planning, stale
previews, unsupported transactions, and precommit I10 failures leave `committed: false`. Only an I10
failure after publication can produce `committed: true`.
