# Developing the embedded library boundary

E11 lives in `packages/cli/src/library-api.ts` because ADR-0003 assigns the public facade to
`@agent-context/lint`; the resolver and other workspace packages remain private implementation
boundaries. The module may depend only on `@agent-context/core` at runtime. Do not add a runtime
edge from the public package to a private workspace package.

## Composing the built-in engine

Trusted application startup creates one capability with `createLibraryScanCapability`. Its executor
may compose discovery, E08 target sampling, E09 caching, E10 bounded resolution, F-series
scheduling, and output construction. Keep all executable collaborators in closure state. The
normalized request and `LibraryScanExecutionContext` are the only per-call values crossing the
boundary.

An executor must:

1. return a native promise;
2. treat the derived signal as authoritative and propagate it through every owned operation;
3. close handles and settle only after cancellation cleanup finishes;
4. define deterministic work units before execution and call `reportProgress()` exactly once per
   completed unit;
5. return a B05 scan output plus all B03 source documents needed to validate its B04 evidence;
6. perform ordinary scans offline, model-free, read-only, and without repository command execution.

Do not expose work-unit callbacks, filenames, exception details, timings, worker IDs, or completion
order through progress. Do not convert repository data into an executor or invoke imported code
selected by configuration.

## Lifecycle reasoning

The facade creates a derived `AbortController`, subscribes to the caller signal once, and races the
engine result against its internal stop notification. If cancellation or progress failure wins, it
still awaits the captured engine outcome. The finalizer aborts the derived signal idempotently and
removes the external listener. There are no library-owned timers or global handlers.

This design favors truthful cleanup over prompt but unsafe rejection. A non-cooperative engine is a
composition defect and remains pending; the built-in engine must combine cooperative cleanup with
E10's bounded deadline. Never change the facade to abandon a live engine promise merely to make a
cancellation test finish sooner.

## Validation and canonical output

Keep public records closed and inspect them through own data-property descriptors. Reject proxies
before reflection. Validate returned scan output with `serializeNativeOutput(output, sources)`; that
single path enforces B03/B04/B05 relationships, sanitization, and canonical key order. Parse the
canonical bytes and deep-freeze the detached value before return. Do not return or mutate the
engine-owned object.

Operational errors are fixed table entries. Never interpolate an exception, path, validation issue,
abort reason, or callback result. Do not add `cause` without a separate redaction and compatibility
review.

## Required verification

Changes to this boundary must run:

```sh
pnpm build
pnpm typecheck
pnpm exec vitest run packages/cli/test/library-api.unit.test.ts
pnpm exec vitest run tests/library-api.integration.test.ts
pnpm boundaries
pnpm security:validate
pnpm pack:check
```

Unit coverage includes malformed and adversarial values, capability forgery, cancellation races,
progress overflow/underflow, scheduling permutations, output detachment, and global-state probes.
The built integration test launches an embedded child consumer with a ref-counted interval. It
cancels mid-scan and must exit naturally within the test deadline; a leaked interval makes the test
fail by timeout. It also verifies listener removal, unchanged process handlers/exit state, built
root exports, and absence of sensitive thrown text.

Coverage for `library-api.ts` must remain at least 95% for statements, lines, and functions and 90%
for branches. The packed-manifest gate requires the JavaScript, declaration, and source-map files so
source-only success cannot hide a missing public implementation.
