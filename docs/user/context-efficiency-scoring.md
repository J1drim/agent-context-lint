# Understanding the context-efficiency score

The context-efficiency score is a transparent 0–100 static heuristic. It summarizes token budget
fit, observed scope breadth, duplication, reachability/import overhead, classified instruction
density, and cross-profile divergence. It does not measure whether an agent is intelligent, whether
an instruction is valuable, or whether removing context preserves task results.

The defaults are A at 90, B at 80, C at 70, D at 55, and F below 55. Grade boundaries, token
budgets, and the six component weights can be configured in `.agent-context-lint.yml`; weights must
sum to 100 and grade floors must remain strictly ordered. Every report identifies score version
`1.0.0`, shows its components, and exposes the curve points used to calculate them.

A high broad-scope penalty is a prompt to review widely loaded text, not an instruction to remove a
root policy. A low density score can reflect necessary rationale. Near duplicates are similarity
candidates, not semantic equivalence. Confirm the cited documents, profiles, and target sample
before changing policy.

The implemented G07 result reports `complete`, `caveated`, or `unavailable`. When required evidence
is partial or unknown, the aggregate score and grade are `null`; it never substitutes zero. A
numeric result is explicitly caveated for estimated tokenization or sampled evidence. Tokenizer
identity also matters: scores from incompatible tokenizer versions are not directly comparable.

See the [complete score formula and curves](../api/efficiency-score-specification.md) and the
[underlying evidence metrics](context-efficiency-metrics.md). The
[score result guide](context-efficiency-score.md) explains states, components, and comparisons.
