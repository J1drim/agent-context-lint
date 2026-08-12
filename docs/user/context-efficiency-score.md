# Reading a context-efficiency score

The context-efficiency score is a transparent static review aid from 0 to 100. It combines budget
fit, scope precision, non-redundancy, reachability, instruction density, and cross-agent consistency
using the weights and grade thresholds in your configuration.

It does **not** measure agent intelligence, prove that an instruction is unnecessary, or show that
removing context preserves task results. Outcome-preservation and task-quality claims are outside
this release's static analysis boundary.

## Check the state before the number

- `complete` means all weighted evidence is exhaustive and uses an exact tokenizer.
- `caveated` means the number is usable only with the listed limitations, such as the default
  estimated tokenizer or a stratified target sample.
- `unavailable` means the product deliberately omitted the score and grade because required evidence
  was partial or unknown.

Never compare scores that use different tokenizer identities, score versions, budgets, component
weights, or target-sampling conditions. The result includes identities for all of these inputs.

## Review a low component

Each component shows its rounded score, exact basis-point score, weight, normalized metric inputs,
curve penalties, evidence references, and uncertainty reasons. Follow the cited G05 document,
profile, and path evidence before changing repository policy.

A broad-scope penalty can represent a necessary root policy. A low density score can reflect useful
rationale. Near-duplicate evidence identifies text-similarity candidates, not semantic equivalence.
The score never authorizes automatic deletion or rewriting.

The full [API result contract](../api/context-efficiency-score.md) documents every field. See the
[formula and curves](../api/efficiency-score-specification.md) and the
[underlying metric evidence](context-efficiency-metrics.md) for detailed interpretation.
