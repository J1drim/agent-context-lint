# Developing bounded multi-target resolution

E10 lives in `packages/resolver/src/bounded-resolution.ts`. It is orchestration downstream of E05;
it must not implement profile discovery, activation, ordering, imports, or conflict semantics.

## Invariants

1. Validate the complete options and task set before invoking any executor.
2. Accept only tasks minted by `createEffectiveContextResolutionTask` in this process.
3. Keep executable task capabilities in a private `WeakMap`; no callback appears in the task data
   contract or serialized output.
4. Sort work by UTF-8 profile, surface, profile/specification/client versions, target, then task ID
   before assigning queue indexes.
5. Maintain at most `maximumConcurrency` active executors and start work only when a worker takes
   the next queue item.
6. Accept only same-process E05 results matching the complete declared profile, version, surface,
   specification, and target relationship.
7. Bound each retained result, aggregate retained bytes, task count, text, duration, and
   concurrency.
8. Stop queue admission and propagate the internal native signal on cancellation, deadline, or
   result-byte exhaustion.
9. Never serialize timing, completion order, concurrency, or error details into a successful batch.
10. Return no partial batch. Failure indexes are canonical queue indexes, not timing-dependent
    worker identities.

E09 composition is intentionally outside the scheduler. An application task may call
`EffectiveContextMemoizationCache.resolve`; E10 validates the E05 object returned on both cold and
warm paths. This keeps caching optional and prevents concurrency from changing cache authority.

The executor factory is an internal capability injection point. It is suitable for application-owned
resolution preparation only. Never construct it from repository/configuration/standards fields or
expose it to the future semantic plug-in boundary. When task preparation performs filesystem I/O,
give each concurrently active task a separate C02 facade or serialize access to a shared facade; C02
rejects concurrent use by design.

## Scheduling model

The scheduler creates `min(maximumConcurrency, taskCount)` async workers. JavaScript execution makes
the monotonic queue index assignment atomic between awaits. Each worker claims one task, awaits its
executor, validates and byte-accounts the issued result, and only then claims another. Therefore
pending work has real backpressure rather than being eagerly converted into promises.

The outer cancellation signal is never passed directly. E10 validates it through the captured native
getter and relays it to a private controller without relaying the caller's reason. A batch timer and
the outer signal race bounded worker completion. Active task code remains responsible for cleaning
its own resources on abort; E11 adds the public no-leaked-handle lifecycle tests documented in
[Developing the embedded library boundary](library-api.md).

## Verification

Run the narrow contract, built integration, affected E05/E08/E09 suites, and focused coverage:

```sh
pnpm build
pnpm exec vitest run packages/resolver/test/bounded-resolution.unit.test.ts
pnpm exec vitest run tests/bounded-resolution.integration.test.ts
pnpm exec vitest run packages/resolver/test/effective-context.unit.test.ts packages/resolver/test/effective-context-cache.unit.test.ts packages/resolver/test/target-sampler.unit.test.ts
pnpm exec vitest run tests/effective-context-profiles.integration.test.ts tests/effective-context-cache.integration.test.ts
pnpm exec vitest run packages/resolver/test/bounded-resolution.unit.test.ts --coverage --coverage.include=packages/resolver/src/bounded-resolution.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm boundaries
pnpm security:validate
pnpm pack:check
```

The tests cover serial/parallel/golden byte equality, completion and input permutations, cold/warm
E09 composition, queue backpressure, active-slot ceilings, cancellation before and during work,
deadline behavior, sanitized thrown failures, forged/mismatched results, duplicate relationships,
hostile JavaScript containers, Unicode ordering, hard limits, and output immutability.
