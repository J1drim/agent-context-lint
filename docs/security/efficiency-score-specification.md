# Efficiency score specification security boundary

G06 is a capability-free, deterministic data contract. It does not read repository files, invoke
commands or models, inspect the environment or clock, access the network, or write output.

| Threat | Control |
| --- | --- |
| Configuration changes hidden scoring behavior | Score version, weights, budgets, grade floors, every curve point, allocation, normalization ID, source path, and arithmetic rule are emitted in the immutable specification. |
| Hostile JavaScript executes during validation | B06 validation plus curve descriptor checks reject proxies, accessors, exotic prototypes, cycles, sparse/extended arrays, symbols, and unexpected keys without invoking getters. |
| Floating-point/platform drift changes grades | Ratios and interpolation use bounded integers and `BigInt` intermediates with one documented half-up rule. Golden reconstruction runs through compiled package boundaries. |
| Divide-by-zero or arithmetic overflow | Zero budgets have an explicit policy, ratios saturate at 1,000,000 bp, inputs are safe integers, and curve penalties are bounded to 0–10,000 bp. |
| Unknown evidence improves a score | Every input requires complete G05 evidence. The [G07 calculator](context-efficiency-score.md) keeps partial, missing, indeterminate, or null evidence unavailable and may ignore it only when its configured component weight is zero. |
| A heuristic is presented as outcome evidence | `qualityClaim` is fixed to `false`; documentation prohibits intelligence, necessity, conformance, or task-quality claims. Empirical outcome evidence is outside this release. |
| Formula downgrade or silent drift | Only score version `1.0.0` is accepted. Any result-affecting curve, normalization, allocation, rounding, or threshold-semantics change requires a new version. |

The specification and golden contain aggregate numeric evidence, not instruction text. Later
formatters still must sanitize paths and bound artifact retention. Organization policies may lock
individual scoring settings, but resolving independently valid settings must also pass the final
sum/order relationships before scoring.
