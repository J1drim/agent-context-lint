# Developing approved mechanical fixes

I12 is a fail-closed policy layer between genuine rule results and I11. Adding a suggestion or a
`fixPlan` to repository-controlled data is insufficient: only code holding same-process evaluator
provenance may call `issueSafeFixEligibility()`.

## Required proof for a new rule

A rule may move from `refused` to `approved` only when one exact, deterministic transformation can
be proven from closed source evidence. Its change must be single-file, range-bounded, independent of
model or subjective judgment, semantics-preserving for every affected target/profile, and safe under
malformed input, Unicode, mixed line endings, cancellation, concurrent mutation, and link
substitution. The implementation must bind the rule/version, diagnostic, source, range bytes,
replacement, and plan digest before authority is issued.

The packaged structural schema is paired with `validateMechanicalFixSafetyMatrix()`. Always run the
runtime validator with `require`-exact semantics: it binds every array position to the corresponding
`REQUIRED_RULE_IDS` entry and the reviewed decision, reason, and proof. A schema-only positive check
is not sufficient evidence for exhaustiveness.

The review must include positive, negative, boundary, malformed, suppression, copied/forged
authority, and resource-limit cases. Property coverage must demonstrate that bytes outside every
declared half-open range remain identical. A complete apply/reparse/evaluate/finalize/plan cycle
must return zero candidates on the second run. File mode and line-ending preservation must be
checked against the real I10 writer, not a string-only helper.

Do not approve a transformation when it:

- chooses among valid policy meanings or rewrites instructions, commands, scope, or security intent;
- depends on inferred paths, vendor versions, UI/model behavior, approximate similarity, scores,
  counterfactual projections, or incomplete/conditional evidence;
- creates, deletes, moves, or changes multiple files without a proven portable transaction;
- downloads standards, pins mutable content, creates lockfiles, executes repository commands, or
  requires network access; or
- exposes source or secret bytes merely to establish a precondition.

## Current flow

1. F05 parses suppression comments from validated B03 bytes and retains private parser ownership.
2. B08 matches the issued directive against the complete F05-family diagnostic set used by this
   narrowly approved subset; arbitrary additional diagnostics do not establish global completeness.
3. F05 emits ACL109 only for the exact `unused` record and retains private finalization ownership.
4. I12 requires exactly one ACL100–ACL108 target, because only that family is complete in the
   authenticated evaluation. Cross-family, multi-rule, wildcard/malformed, and ACL109 targets remain
   refusal-only without dedicated complete unfiltered authority.
5. I12 checks the source/range relationship again, incorporates the fragment hash into the plan ID,
   validates the resulting B04 bundle, and lets I11 bind that ID and canonical plan digest in the
   issued candidate.
6. Only the complete, unfiltered direct finalizer may populate private mechanical eligibility.
   Policy-filtered scheduled finalizations are reporting-only even when they contain ACL109.
7. The caller explicitly selects a candidate for preview; I11 and I10 own all filesystem work.

The CLI's `scan --fix-dry-run` path calls this authority only after a complete, unfiltered direct
syntax finalization. Do not add a second scan path or grant write authority in the router while
implementing a rule-specific fix.

Focused verification:

```sh
pnpm exec vitest run packages/rules/test/syntax-structure.unit.test.ts \
  tests/approved-mechanical-fixes.integration.test.ts \
  packages/core/test/diagnostic-contracts.unit.test.ts \
  packages/evidence/test/safe-fix-pipeline.unit.test.ts
pnpm exec vitest run packages/rules/test/syntax-structure.unit.test.ts \
  tests/approved-mechanical-fixes.integration.test.ts \
  --coverage --coverage.include=packages/rules/src/syntax-structure.ts \
  --coverage.include=packages/rules/src/mechanical-fix-safety.ts
pnpm typecheck
pnpm lint
pnpm pack:check
```
