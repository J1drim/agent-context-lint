# Context-efficiency report API

G09 turns genuine G05 metrics, their matching G07 score, and the exact G08 recommendation result
into stable terminal and JSON reports. Import the report-only surface from
`@agent-context/efficiency/report`; the package root exports the same symbols for internal
composition.

`createContextEfficiencyReport` accepts a closed record with `metrics`, `score`, `recommendations`,
and the literal repository scope `{ "kind": "repository", "targetPath": null }`. Version 1 does not
allow a caller-provided target to relabel aggregate metrics. All three analysis records must have
been issued in the current process and the constructor recomputes the exact metrics digest used by
G07/G08. The report retains the complete G07 score (formula, components, operands, evidence,
caveats, and uncertainty) and complete G08 evaluations. It adds deterministic per-profile
effective/always-on distributions and exact source identities:

- configuration, metrics, and score-specification SHA-256 identities;
- G05, G07, and G08 contract versions and the score version;
- profile, client, surface, and specification-snapshot identities;
- exact tokenizer ID, version, and exact/estimate label.

No unavailable score, token count, saving, grade, or evidence value is replaced with zero. Both
quality-claim fields are permanently `false`.

`compareContextEfficiencyReports` accepts only reports issued by this process. It requires equal
repository scope, configuration, score specification/version, tokenizer, contract versions, and
complete profile identity set. The metrics digests are expected to differ. Every numeric delta is
`null` unless both operands exist. A comparison always carries the fixed caveats
`static-analysis-only`, `quality-not-empirically-verified`, and `semantic-equivalence-not-proven`.

`serializeContextEfficiencyJson` emits canonical recursively UTF-8-key-sorted JSON with one final
LF. `writeContextEfficiencyJson` performs a zero-write size preflight, writes at most 64 KiB at a
time, awaits each sink call for backpressure, and accepts an intrinsic `AbortSignal`.
`renderContextEfficiencyTerminal` supports widths 40–240 and `ansi`/`never` color modes. Labels,
states, and caveats carry all meaning; color is never the only signal. Unsafe controls, bidi
overrides, isolates, and unpaired surrogates are replaced before terminal output.

Closed Draft 2020-12 schemas are published as:

- `context-efficiency-report.v1.schema.json`;
- `context-efficiency-comparison.v1.schema.json`.

`ContextEfficiencyReportError` exposes fixed codes for invalid input, incompatibility, resource
limits, cancellation, and sink failure without reflecting repository or sink text.
