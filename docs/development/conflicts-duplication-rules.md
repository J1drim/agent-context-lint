# Developing ACL250–ACL255

F08 is an evidence composer, not another prose classifier. Keep the dependency chain explicit:

1. snapshot hostile B03 input through descriptor-only, bounded JSON reconstruction;
2. validate the snapshot through B03;
3. normalize and classify each logical statement through F03;
4. build exact and near clusters through F04;
5. accept only same-process E05 contexts and project known active statements;
6. evaluate structured pairs, duplication, inheritance, and cross-profile canonical divergence;
7. build and validate B04 diagnostics; and
8. retain parser-issued B08 directives for a separate finalization step.

Do not infer applicability from document paths alone. E05 supplies activation, shadowing, effective
document identity, ordering, conflict opportunities, truncation, profile, surface, specification,
and target. Directory ancestry is used only after E05 proves that both documents are effective and
orders the parent before the child for ACL255.

## Precision rules

- ACL250 requires two `must` package-manager selections from the closed F03 manager vocabulary.
- ACL251 requires an exact action/object coordinate with `must` versus `must-not`. A phrase such as
  `Do not run npm publish` is command evidence, not a prohibition on selecting npm.
- Different required commands are compatible unless a closed ACL252 exclusivity template proves a
  common workflow selection.
- ACL253 consumes F04 edges; do not add a second similarity implementation.
- ACL254 compares canonical and vendor statements only when both are effective for the same target.
- ACL255 requires exact F04 identity plus E05 parent-before-child inheritance evidence.

Messages remain fixed and do not interpolate repository prose. Fingerprints contain stable statement
IDs, a bounded structured subject, profile IDs, and a digest of applicable targets. Related evidence
uses the other source location and globally unique evidence IDs.

## Verification

Run the focused matrix while developing:

```sh
pnpm build
vitest run packages/rules/test/conflicts-duplication.unit.test.ts
vitest run tests/conflicts-duplication.integration.test.ts
vitest run packages/resolver/test/effective-context.unit.test.ts
vitest run packages/evidence/test/statement-classifier.unit.test.ts packages/evidence/test/duplication-index.unit.test.ts
```

The unit suite covers every rule, hard negatives, truncation, suppression ownership, hostile
containers, resource limits, deterministic output, and the labeled default-error precision gate. The
integration suite evaluates real Codex and Claude resolutions through the built rules package and
sends all six rule IDs through stylish, JSON, and SARIF. F08 source must remain at least 95%
statement and above 90% branch coverage in the focused report.
