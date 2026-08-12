# Context-efficiency reports

Use `efficiency` to inspect static context cost after the scan pipeline has resolved the selected
repository and profiles:

```sh
agent-context-lint efficiency
agent-context-lint efficiency ./repository
agent-context-lint efficiency --agent codex-cli
agent-context-lint efficiency --format json
agent-context-lint efficiency --compare ../candidate --no-color --width 100
```

Repository reports show each profile and surface separately, including effective p50/p95/max,
always-on context, sampling state, the 0–100 heuristic score and every component, evidence caveats,
and all evaluated recommendations. Version 1 reports are repository-scoped because their G05/G07/G08
evidence is aggregate. A target operand cannot relabel that evidence as target-specific.

Comparison mode resolves both sources independently and refuses to compare different tokenizers,
score formulas/configurations, repository scopes, or profile/client/surface/specification
identities. Missing scores or counts are displayed as `unavailable`; they are never treated as zero.
JSON uses the stable v1 report or comparison schema and contains the same identities and caveats as
terminal output.

Efficiency is informational, so a valid F grade still exits 0. Lint policy failures belong to
`scan`; malformed arguments, incompatible comparisons, or analysis/output failures exit 2, and
SIGINT exits 130. `--no-color` removes all ANSI escapes. `--width` accepts 40 through 240 columns.

Static recommendations do not prove that smaller context preserves instruction meaning, agent
behavior, or task quality. The release reports these limitations explicitly and does not produce
empirical task-quality results.
