# Scope and activation rules

F07 implements ACL200–ACL206 in `@agent-context/rules`. The evaluator is a deterministic, offline,
model-free transform over validated B03 instruction data, canonical E01 activation results,
profile-resolution facts, and E08 sampling inputs.

```ts
import { evaluateScopeActivationRules } from "@agent-context/rules";

const result = evaluateScopeActivationRules({
  recordKind: "agent-context-scope-activation-rule-input",
  contractVersion: "0.1.0",
  ir,
  activationResults,
  facts,
  sampling,
});
```

The API accepts no filesystem, repository, process, environment, network, model, module, command, or
callback capability. Callers evaluate profile-owned activation through E01 first. F07 canonicalizes
each `ActivationResult` through E01's serializer, derives E08 activation observations, and calls
`sampleTargets`. It does not copy glob, directory, manual, conditional, include, exclude, workspace,
language, partition, or sampling semantics.

## Input contract

`ir` must satisfy B03. `activationResults` contains one observation for every recognized E08 source
target and one E01 result for every B03 activation rule. Targets are explicitly `source`,
`generated`, `vendored`, `dependency`, or `unknown`; unknown is never inactive.

`sampling` is E08 input without `activationObservations`; F07 constructs that field from the E01
matrix. E08 validates tracked paths, workspaces, critical paths, source coverage, and the rule
universe and emits the normal sampling proof.

One closed `facts` entry is required per activation rule. It preserves scope-metadata state,
reachability, nesting, proven shadow relationships, and an optional cross-profile comparison group.
Reachable, unreachable, shadowed, conditional, contradictory, ambiguous, and unknown values stay
distinct. F07 does not infer precedence, shadowing, or undocumented nesting semantics from filenames
or rule order.

## Exact and sampled sets

An activation set is `exact` only when E08 returns `strategy: exhaustive`, `state: complete`, and
its recognized source count equals the complete tracked-path count. Otherwise it is `sampled`;
non-source tracked files must not disappear from an absence proof. Each rule summary reports counts
and one state:

- `non-empty` when a target is definitely active;
- `empty` only when the complete exact set is definitely inactive;
- `indeterminate` when membership remains unknown and no active witness exists; or
- `sampled-no-active` when a finite sample contains no active witness.

Neither indeterminate nor sampled-no-active is converted to empty.

## Rule predicates

| Rule   | Emission predicate                                                                                                            | Conservative non-emission                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ACL200 | A glob/directory/include scope is empty over the exact E08 universe.                                                          | Sampled-no-active or indeterminate becomes uncertainty.                   |
| ACL201 | Metadata is explicitly missing and B03 proves repository-root unconditional `always` activation without selectors/exclusions. | Present/unknown metadata, conditional/manual behavior, or narrower scope. |
| ACL202 | A definite active witness lies outside the instruction document's directory.                                                  | No witness or only indeterminate outside results.                         |
| ACL203 | Resolution evidence explicitly says `shadowed` with shadowing rules, or `unreachable`.                                        | Conditional, contradictory, ambiguous, or unknown reachability.           |
| ACL204 | Rules in one comparison group are active versus inactive for the same target.                                                 | Indeterminate comparisons remain uncertainty.                             |
| ACL205 | Selected-client nesting evidence is ambiguous or contradictory.                                                               | Conditional/unknown states remain uncertainty.                            |
| ACL206 | A definite active target is generated, vendored, or dependency source.                                                        | Unknown classification or indeterminate activation.                       |

Witness rules may use sampled evidence; absence claims require exact coverage. Diagnostics use B03
digests/ranges and B04 fingerprints with deterministic ordering and no fix plan. F15 owns global
policy and suppression scheduling. B08 suppressions and stylish, JSON, and SARIF formatters consume
the ordinary B04 bundle.

## Limits and precision

Defaults bound rules (4,096), facts (10,000), matrix entries (1,000,000), provenance facts per E01
result (4,096), diagnostics (10,000), uncertainties (50,000), and identifier text. Options cannot
exceed exported hard ceilings. Proxies, accessors, sparse/extended arrays, unknown fields, invalid
B03/E01/E08 relationships, duplicate identities, incomplete matrices, and forged shadow links fail
closed.

The reviewed synthetic corpus is
[`scope-activation-precision.v1.json`](../../packages/rules/test/fixtures/scope-activation-precision.v1.json).
It covers positives and close hard negatives for all seven rules and enforces at least 95%
precision. This calibrates the closed predicates, not arbitrary repositories or unobserved clients.
