# Developing ACL450–ACL453

F12 composes existing evidence instead of rediscovering or guessing agent behavior:

1. validate the closed B03 instruction IR;
2. accept only same-process E07 comparisons and index their exact profile/surface/version summaries;
3. validate explicit format and behavior observations against those summaries and B03 ownership;
4. classify statements through F03 and use only confidence at or above `0.95`;
5. require E07 scope/content divergence at the affected source paths;
6. retain partial, conditional, unknown, and unclassified evidence as bounded uncertainties;
7. generate fixed-message B04 diagnostics; and
8. retain B08 directives for issued-result suppression finalization.

Do not infer format support from names, extensions, documentation prose, or profile family alone. Do
not reconstruct E07 objects from JSON: issuance is an integrity boundary. One selected
profile/surface cannot appear with different summary identities or client versions across the input.
The editor-surface set is deliberately closed; a new editor integration requires reviewed code and
evidence rather than a string heuristic.

## Precision invariants

- ACL450 requires a complete format inventory and no exact high-confidence shared-format domain.
- Any unclassified statement in the shared format makes shared absence indeterminate.
- ACL451 compares only different formats and the same F03 subject coordinate with different exact
  structured policy.
- ACL452 is limited to `import` and `nesting`; other behavior labels cannot promote it.
- ACL453 requires supported evidence from a known editor surface and unsupported evidence from a
  known non-editor surface.
- `conditional`, `unknown`, an indeterminate E07 pair, or divergence unrelated to the source path
  produces no definitive finding.
- Fingerprints contain stable statement identities and digested policy/target components, never raw
  repository prose or control-bearing structured keys.

## Verification

Run the focused matrix while developing:

```sh
pnpm build
vitest run packages/rules/test/portability.unit.test.ts
vitest run tests/portability-rules.integration.test.ts
vitest run packages/resolver/test/cross-profile-comparison.unit.test.ts
pnpm rules:docs:check
```

The unit suite covers every rule, the 16-case committed precision corpus, actual Codex/Claude/Cursor
E05-to-E07 evidence, suppressions, mixed client versions, hostile containers, deduplication,
deterministic ordering, and all resource ceilings. The packaged integration suite composes built
resolver/rules exports and verifies stylish, JSON, and SARIF output against a golden projection. F12
production source must retain at least 95% statement/line/function and 90% branch coverage in the
focused report.
