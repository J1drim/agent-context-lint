# Activation algebra API

Ticket E01 implements the adapter-independent activation mechanism in `@agent-context/resolver`. It
consumes a validated B03 `ActivationRule` and a B01 canonical target path. It does not interpret
resolution events or choose a glob library.

The package is currently an internal workspace API. Its exports are typed and documented so profile,
rule, sampling, and effective-context work can depend on one mechanism while the v0 contracts are
being assembled.

## Three-valued results

Every operation returns an immutable `ActivationResult`:

```ts
interface ActivationResult {
  readonly state: "active" | "inactive" | "indeterminate";
  readonly provenance: readonly ActivationProvenance[];
}
```

`indeterminate` means the available facts do not prove either membership or non-membership. It is
not falsy and must not be collapsed to `inactive`.

Union and intersection use the strong-Kleene tables:

| `A`           | `B`           | `A ∪ B`       | `A ∩ B`       |
| ------------- | ------------- | ------------- | ------------- |
| active        | active        | active        | active        |
| active        | inactive      | active        | inactive      |
| active        | indeterminate | active        | indeterminate |
| inactive      | active        | active        | inactive      |
| inactive      | inactive      | inactive      | inactive      |
| inactive      | indeterminate | indeterminate | inactive      |
| indeterminate | active        | active        | indeterminate |
| indeterminate | inactive      | indeterminate | inactive      |
| indeterminate | indeterminate | indeterminate | indeterminate |

Complement swaps `active` and `inactive` and preserves `indeterminate`. Difference is defined as
`A ∩ ¬B`. Empty union is the inactive empty set; empty intersection is the active universal set.

The exports are:

- `activationFact(state, key, description)` for an atomic caller-owned fact;
- `activationUnion(operands)`;
- `activationIntersection(operands)`;
- `activationComplement(operand)`;
- `activationDifference(left, right)`; and
- `serializeActivationResult(result)` for canonical JSON.

### Minimal canonical provenance

Provenance is a flat proof, not an evaluation trace. An absorbing operand is sufficient to prove an
active union or inactive intersection, so only the lexicographically least decisive proof is kept.
When no operand absorbs the result, all logically necessary proofs are combined. Duplicate atomic
facts are removed and contradictory claims using one provenance key are rejected.

Facts are ordered by exact JavaScript UTF-16 code-unit order over key, kind, observed state, and
description. The implementation does not use locale or ICU collation. This makes serialized output
independent of host locale and operand order. Complement keeps the original observed fact: for
example, an active exclusion is provenance for an inactive final result rather than being rewritten
as a fictitious inactive match.

Evaluator-owned fact keys SHA-256 hash an unambiguous UTF-8 length-prefixed tuple. Every tuple
starts with the complete rule identity: rule ID, document ID, profile ID, surface ID, and
specification snapshot ID. It then includes every value that identifies the predicate, such as
target, scope root, selector dialect/pattern, ordered conditional tuple, or unknown reason. Length
framing prevents tuple-boundary collisions. This also bounds keys even when an allowed selector is
large. Caller facts retain their supplied stable key. Human descriptions show ordinary values
directly and replace values over 1 KiB with their byte length and SHA-256 digest, preventing derived
provenance from exceeding the documented field limit.

## Evaluating a B03 activation rule

```ts
import { evaluateActivationRule } from "@agent-context/resolver";

const decision = evaluateActivationRule(rule, {
  targetPath,
  callbacks: {
    matchGlob(request) {
      return profileGlobMatcher(request);
    },
    resolveManual(request) {
      return selectedRules.has(request.ruleId)
        ? { state: "active", reason: "the user selected this rule" }
        : { state: "inactive", reason: "the user did not select this rule" };
    },
    resolveConditional(request) {
      return resolveProfileCondition(request);
    },
  },
});
```

Evaluation is the set expression:

```text
scope root ∩ activation trigger ∩ union(includes) − union(excludes)
```

- A repository-root scope is universal. A narrower `scopeRoot` contains its exact path and path
  descendants at `/` component boundaries.
- `always` supplies an unconditional trigger.
- `directory-tree` and `glob` obtain their trigger from their required include selector.
- `manual` and `conditional` are resolved only by caller callbacks.
- `unknown` remains indeterminate unless a definite scope/include/exclude fact proves inactivity.
- An empty include list is universal. An empty exclude list is empty.
- Includes and excludes are unions. A definite exclude is final even if an included trigger is
  active or indeterminate.

Directory selectors are the only shared deterministic matcher in E01. A glob callback receives the
raw pattern, nullable dialect identity, scope root, selected target, rule, profile, and surface IDs.
The callback owns all syntax and matching behavior. If it is absent, the match is indeterminate. E02
supplies profile-owned dialect implementations; E01 intentionally does not depend on `picomatch`,
`minimatch`, or a shared default.

The concrete closed dialect catalog, cross-profile fixture, and resource limits are documented in
[Profile-owned glob dialects](profile-glob-dialects.md). Unknown or mismatched dialect identities
remain indeterminate and never borrow another profile's callback behavior.

Manual and conditional callbacks receive the complete originating rule identity: rule, document,
profile, surface, specification snapshot, target, and the complete frozen B03 `conditions` array.
The conditions are retained for manual rules too, so an event provider can distinguish otherwise
colliding rule records. E01 passes the array once; it does not turn descriptions into independent
predicates or map events. E03 owns selected-rule and event-trace interpretation and rejects a
callback request whose origin descriptor differs from the trace. Dynamic callbacks are optional;
missing facts become indeterminate rather than guessed.

Callbacks must be synchronous, deterministic data functions for the same request. Every exception
thrown during callback invocation is an operational `ACTIVATION_CALLBACK_FAILED` error with the
original exception as its cause, even when caller code throws an `ActivationAlgebraError` instance.
Validation happens after invocation, so a returned malformed `{ state, reason }` record retains the
library's `ACTIVATION_INVALID_CALLBACK` or resource-limit code. The reason from a valid decision is
retained as provenance.

## Defensive limits and errors

`ACTIVATION_ALGEBRA_LIMITS` publishes the current mechanism limits:

| Limit                                    |  Value |
| ---------------------------------------- | -----: |
| operands per set operation               |  4,096 |
| selectors per rule, include plus exclude |  4,096 |
| conditions per rule                      |  1,024 |
| provenance facts per operation           |  4,096 |
| bytes per text field                     | 16,384 |
| cumulative evaluated input text          |  1 MiB |

The evaluator expects the rule to have passed B03 IR validation, then performs a narrow defensive
preflight before invoking callbacks. It rejects proxies, accessors, sparse arrays, extra callback or
result fields, malformed Unicode, non-canonical B01 paths, invalid kind relationships, conflicting
provenance, and resource excess. A billion-length sparse array is rejected from its declared length
without walking its holes. All failures use `ActivationAlgebraError` and a stable
`ActivationAlgebraErrorCode`.

These checks are a safety boundary for the mechanism, not a replacement for `validateInstructionIr`:
source/document/profile relationships, source ranges, and uncertainty records remain owned by B03.

## Determinism and purity

The evaluator performs no filesystem, process, clock, random, network, or event access. It sorts and
deduplicates selectors before evaluation and memoizes identical glob predicates within one rule
evaluation. Returned results, provenance arrays, facts, callback requests, and conditional arrays
are frozen. Reordering set operands or semantically duplicate selectors therefore produces the same
canonical result when callbacks satisfy their deterministic contract.
