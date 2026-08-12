# Context-efficiency metrics

`analyzeContextEfficiencyMetrics` in `@agent-context/efficiency` composes source-backed F03/F04,
G03/G04, E08, and same-process E07 evidence into immutable G05 metrics. Its output record kind is
`agent-context-efficiency-metrics`, contract `0.2.0`. Version `0.2.0` carries the additive G04
per-target always-on subtotal used by G06; all G05 metric formulas remain unchanged.

The API is a deterministic, in-memory measurement boundary. It performs no discovery, filesystem,
process, environment, clock, model, or network operation. It describes observed tokens, paths, and
source ranges. It does not decide whether context is useful, instructions are semantically
equivalent, or one profile is better than another.

## Input contract

The closed `agent-context-efficiency-metrics-input` envelope contains:

- one tokenizer identity shared by every document, statement, and G03 accounting;
- documents with an ID, repository-relative path, raw token count, and complete/partial
  classification state;
- source-exact F03 statement inputs and their token counts;
- profile inputs containing an E08 sample, matching G03 accountings, and an exact profile/surface/
  specification/client identity; and
- zero or more E07 comparisons issued by this process.

Document IDs and paths are one-to-one. Every statement names one supplied document and uses that
document's tokenizer. Every profile accounting path must equal its E08 selected-path set, and every
accounting occurrence must name a supplied document. An E07 profile and target must correspond to
exactly one supplied profile distribution and a target observed for that profile. Violations fail
with a typed `ContextEfficiencyMetricsError`; they are never silently excluded.

## Units and calculations

`CONTEXT_EFFICIENCY_RATIO_SCALE` is 10,000. Ratio values use integer basis points with truncation
toward zero, so `10_000` means `1.0` and `20_000` means `2.0`. Token quantities retain the selected
tokenizer identity and measurement kind.

### Duplication

F04 exact clusters are reconciled to document paths, F03 statement IDs, source ranges, and token
contributions. `exact.redundantTokens` is the sum of every non-canonical exact member's statement
tokens. Near-duplicate candidate tokens count the non-representative members of F04 near clusters,
excluding members already grouped as exact duplicates to avoid double counting.

Exact normalization is textual normalization, and near matching is bounded trigram Jaccard candidate
evidence. Both cluster types set `semanticEquivalenceClaim: false`.

### Dead-scope observation

A profile is `measured` only when its E08 strategy is exhaustive, its G04 distribution is complete,
and every supplied document appears in the profile's G03 occurrence inventory. A measured document
is dead in the observed target set when none of those targets includes it. The result cites the
document ID, path, raw tokens, and observed target count.

Otherwise the profile is `unknown`, `tokens` is `null`, no dead documents are asserted, and the
result records `sample-not-exhaustive`, `profile-evidence-partial`, and/or `documents-unobserved`
with document ID, path, and raw-token evidence for every unobserved document.

### Broad-scope observation

For each observed document and profile:

```text
coverageBasisPoints = complete included targets / complete targets * 10,000
```

The record retains every included target path, its complete/partial state, its token contribution,
the total effective contribution, and the document's raw tokens. With no complete targets, coverage
is `null` and the document state is `unknown`. This is observed target breadth, not a claim that a
scope is unnecessarily broad.

### Import amplification

For each complete target with nonzero unique source tokens:

```text
amplificationBasisPoints = effective tokens / unique tokens * 10,000
repeatedTokens = effective tokens - unique tokens
```

Each result cites the contributing document IDs, paths, and effective occurrence tokens. A partial
G03 accounting returns `null` ratios and repeated tokens. A complete zero-token target is
`not-applicable`, not zero amplification. Profile minimum, p50, p95, and maximum use G04's
`empirical-nearest-rank-v1` convention over complete, applicable targets only.

### Instruction density

F03 `classified` statements are counted as mechanically actionable observations. For each document
and for the aggregate:

```text
actionablePerThousandBasisPoints = actionable statements * 1,000 / raw tokens * 10,000
```

Every actionable contribution cites its statement ID, exact source range, and classified domains.
Zero-token density is `null`; incomplete source classification produces `partial`. The rate is not
an instruction-quality score.

### Cross-profile divergence

For every profile pair sharing a sampled target, G05 expects one E07 pair observation. It retains
scope/content/ordering path evidence and left/right token contributions. Known scope differences sum
absolute token differences; known content differences sum the larger side's tokens. Either value is
`null` if required token evidence is unknown.

An exact F04 cluster contributes repeated-policy evidence only when its source members occur in
opposing profile-specific paths for that E07 scope comparison. Members, source ranges, paths, and
tokens remain attached. Missing expected pair-target comparisons and partial E07 results make the
divergence aggregate partial. `equivalenceClaim`, `semanticEquivalenceClaim`, and `qualityClaim` are
always false; `observational-match` remains narrower than semantic or client equivalence.

## Determinism, uncertainty, and limits

Inputs are normalized with UTF-8 byte ordering and repository-path ordering; the result is deeply
frozen and byte-stable for equivalent input permutations. Partial or absent evidence is represented
with explicit states, reasons, missing pair-targets, and `null` measurements rather than invented
zeros.

The public limits are exposed as `CONTEXT_EFFICIENCY_METRICS_LIMITS`: 4,096 documents, 100,000
statements, 16 profiles, 100,000 E07 comparison records, 250,000 expected profile-pair targets, and
1,000,000 emitted evidence entries. Arrays must be dense and exact, records must be plain and
closed, paths must be canonical repository-relative paths, and arithmetic must remain within the
safe integer range.

G05 distributions retain each target's revalidated G03 `alwaysOnTokens` subtotal so the versioned
G06 budget-fit formula can use real occurrence evidence. G05 itself does not calculate or grade a
score. See the [efficiency score specification](efficiency-score-specification.md).

See [statement classification](statement-classification.md),
[duplication index](duplication-index.md),
[occurrence-aware token accounting](occurrence-token-accounting.md),
[per-profile target token distributions](profile-target-distributions.md), and
[cross-profile comparison](cross-profile-comparison.md).
