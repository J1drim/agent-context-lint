# Context-efficiency metrics security boundary

G05 is a capability-free, in-memory composition boundary. It does not read files, discover targets,
execute repository content, access the environment or clock, invoke models, use the network, or
write results. All repository-derived identifiers, paths, statements, token counts, samples,
accountings, and comparisons remain untrusted inputs.

| Threat | Control |
| --- | --- |
| Forged cross-profile semantics | E07 comparisons must be same-process issued records and must reconcile exactly to supplied G04 profile identities and common targets. |
| Injected metric or cluster | G05 invokes real F03, F04, and G04 implementations; callers supply source evidence and accountings, not calculated metric summaries. |
| Mixed measurement units | Every document, statement, occurrence accounting, and distribution must use the exact selected tokenizer contract, ID, version, and exact/estimate kind. |
| Unknown presented as zero | Partial classification, non-exhaustive samples, partial accounting, unobserved documents, unknown comparison paths, and missing comparisons retain explicit state, reason, or `null` values. |
| False semantic or quality claim | Exact/near duplicates and divergent repeated policy set semantic-equivalence claims false; cross-profile results also fix equivalence and quality claims false. |
| Lost provenance | Metrics retain source document IDs, canonical repository paths, tokens, target paths, and source ranges for statement evidence. |
| Accessor/proxy execution | Public records and arrays are descriptor-validated, closed, dense, and plain; proxies, accessors, sparse arrays, unexpected keys, and symbol keys are rejected. |
| Path escape or identity confusion | Paths use the core canonical repository-relative validator; document ID/path mappings, source relationships, samples, occurrences, and profile identities are reconciled before calculation. |
| Resource exhaustion or arithmetic overflow | Document, statement, profile, comparison, pair-target, and emitted-evidence ceilings are enforced; safe-integer token arithmetic and integer ratios fail closed. |
| Nondeterministic evidence | UTF-8 byte and repository-path ordering, fixed integer formulas, fixed nearest-rank statistics, immutable output, and no host capabilities make equivalent input permutations byte-stable. |

G05 output can reveal repository paths, policy structure, and token distribution. Callers must apply
the ordinary output redaction, terminal escaping, artifact retention, and access controls before
displaying or persisting it. Downstream rules must preserve uncertainty and cannot convert an
observation into permission to execute, modify, or disclose repository content.
