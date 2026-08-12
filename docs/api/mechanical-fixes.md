# Approved mechanical fixes API

Ticket I12 exposes `planApprovedMechanicalFixes()` from `@agent-context/rules`. It converts only a
genuine F05/B08 finalization into I11 eligibility capabilities. The v0 approved set contains one
rule: ACL109, and only when a parser-owned directive names exactly one ACL100–ACL108 rule that the
complete unfiltered F05 result and genuine B08 matcher proved unused. Cross-family, multi-rule, and
ACL109 targets remain refusal-only without dedicated complete unfiltered authority.

```ts
import { finalizeSyntaxSuppressions, planApprovedMechanicalFixes } from "@agent-context/rules";

const finalized = finalizeSyntaxSuppressions(syntaxEvaluation, allRuleDiagnostics);
const planned = planApprovedMechanicalFixes(finalized);
if (!planned.ok) throw new Error(planned.issues[0]?.message);

const preview = pipeline.preview({
  bundle: planned.bundle,
  candidates: planned.candidates,
  selectedPlanIds: [planned.eligiblePlanIds[0]],
  sources: [{ identity: analyzedFile.identity, source: planned.sources[0] }],
});
```

The caller must still make an explicit, sorted selection and provide C02 filesystem identities from
the same analysis snapshot. `planApprovedMechanicalFixes()` does not read or write the repository,
accept paths, invoke callbacks, inspect environment state, execute commands, or use the network. The
returned candidates are unforgeable same-process capabilities; a copied, serialized, proxied, or
fabricated finalization is rejected.

## Exact operation contract

An approved ACL109 plan contains one `text-edit` and no create, move, delete, or multi-file action.
The operation binds:

- the B03 source ID, repository-relative path, whole-source SHA-256, and complete source identity;
- a zero-based half-open range containing both exact UTF-8 byte offsets and exact UTF-16 offsets;
- an issuer-computed SHA-256 of only the UTF-8 bytes covered by that range, incorporated into the
  deterministic plan ID without extending serialized B04 v0;
- the empty replacement; and
- the rule version, diagnostic ID, plan ID, and canonical plan digest through I11 eligibility.

B04 validates the byte/UTF-16 range against the exact whole-source digest and source bytes. The
issuer-computed fragment hash contributes to the plan ID; I11 binds that ID and the exact canonical
plan digest in its unforgeable candidate state. I11 then rejects a changed plan, source, filesystem
identity, overlapping selection, stale preview, concurrent edit, link substitution, or cancellation
before publication. I10 performs the final whole-source compare-and-swap while preserving mode.

Only a complete, unfiltered result returned directly by `finalizeSyntaxSuppressions()` may enter the
planner's private authority set. A policy-filtered scheduled finalization can legitimately report
ACL109 while a rule is disabled, but it must never mint a removal candidate.

The API returns `eligiblePlanIds` for presentation, not implicit selection. Applying a candidate
requires a preview from the same pipeline instance. Running the genuine parser, evaluator, B08
finalizer, and planner again after application returns no candidate, which is the I12 idempotence
contract.

## Safety matrix

`MECHANICAL_FIX_SAFETY_MATRIX` is a frozen, exhaustive 69-rule record with closed schema
`schemas/mechanical-fix-safety.v0.schema.json`. An entry is either `approved` with a concrete proof
or `refused` with a stable reason. ACL109 approval is conditional on the exact completeness proof
above; nonqualifying ACL109 findings keep `fixPlan: null`. Registry metadata may advertise
`fixSafety: mechanical` only when the matrix approves that same rule. Suggestions remain prose and
never grant I11 authority. The schema requires the exact 69 `REQUIRED_RULE_IDS` in canonical order
and well-formed Unicode. `validateMechanicalFixSafetyMatrix()` additionally enforces canonical
decision, reason, and proof equality plus a 4 KiB UTF-8 proof ceiling. Duplicates, omissions,
substitutions, sparse/proxied data, and policy drift are invalid.

See the [per-rule proof matrix](../rules/mechanical-fix-safety.md),
[developer workflow](../development/mechanical-fixes.md), and
[security boundary](../security/mechanical-fixes.md).
