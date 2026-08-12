# Bounded multi-target resolution API

E10 exposes an internal concurrency boundary from `@agent-context/resolver`. It runs explicitly
minted effective-context tasks with bounded queue admission and emits one deterministic immutable
batch. Changing task input order, task completion order, or `maximumConcurrency` does not change the
result bytes.

The contract version is `0.1.0`; successful batches use record kind
`agent-context-bounded-effective-context-resolution`.

## Create tasks

```ts
const task = createEffectiveContextResolutionTask(
  {
    clientVersion: "0.146.0",
    id: "codex:src/main.ts",
    profileId: "codex-cli",
    profileVersion: "0.1.0",
    specSnapshotId: "codex-cli-agents-2026-08-01",
    surfaceId: "codex-cli/local-cli-single-cwd",
    targetPath: "src/main.ts",
  },
  async (signal) => {
    const prepared = await prepareEffectiveContextInput("src/main.ts", signal);
    return resolveEffectiveContext(prepared);
  },
);
```

The descriptor is a closed data record. `id`, profile/specification versions, and surface must be
non-empty, well-formed control-free text; `clientVersion` is the expected version or `null`;
`profileId` must name a configured v1 profile; `targetPath` must be a canonical repository-relative
path. The task factory snapshots and freezes the descriptor. A cloned or caller-forged task has no
issuance authority and is rejected before any executor runs.

The executor is trusted application code, not repository data. It receives one native internal
`AbortSignal` and may prepare the exact D-series/E04 inputs before calling E05, or call E09's cache.
Repository Markdown, configuration, standards packs, serialized task records, and untrusted plug-ins
must never choose or supply this callback. If an executor uses C02, it must own an independent
read-only repository facade because one facade deliberately permits only one operation at a time.

## Resolve a batch

```ts
const result = await resolveEffectiveContextsBounded(tasks, {
  maximumConcurrency: 4,
  maximumDurationMs: 30_000,
  signal,
});
```

E10 validates every task and all duplicate relationships before starting work. It then sorts by
UTF-8 bytes over profile, surface, profile/specification/client versions, target, then ID; starts no
more than `maximumConcurrency` executors; and admits another task only after an active task settles.
A result must be a same-process E05-issued object whose complete
profile/version/surface/specification and target identity exactly match its task.

The successful record contains only `contractVersion`, `recordKind`, and ordered `entries`. Each
entry contains `taskId` and the genuine E05 `resolution`. Scheduling limits, timings, worker
numbers, completion order, and cancellation state are deliberately absent, so single-slot and
maximum-slot runs serialize identically. `isIssuedBoundedResolutionResult` distinguishes a
same-process result from deserialized data.

## Cancellation, failures, and backpressure

An already-aborted native signal prevents all task admission. Later cancellation aborts the internal
signal shared by active tasks and prevents queued work from starting. The duration limit applies to
the whole batch. A deadline or byte limit settles the scheduler even if an executor ignores
cancellation; well-behaved executors must stop and release their own handles when the signal aborts.
E11 owns the public embedded-consumer lifecycle and progress contract; see
[Embedded library API](library-api.md).

Task throws and rejected promises are collected without exposing their messages. Once all bounded
work settles, failed task indexes refer to the canonical sorted order, never completion order.
Forged or mismatched results fail as an invalid relationship. No partial successful batch is
returned.

`BoundedResolutionError` has fixed messages and these stable codes:

- `BOUNDED_RESOLUTION_CANCELLED`
- `BOUNDED_RESOLUTION_DEADLINE_EXCEEDED`
- `BOUNDED_RESOLUTION_INVALID_INPUT`
- `BOUNDED_RESOLUTION_INVALID_OPTIONS`
- `BOUNDED_RESOLUTION_INVALID_RELATIONSHIP`
- `BOUNDED_RESOLUTION_RESOURCE_LIMIT`
- `BOUNDED_RESOLUTION_TASK_FAILED`

## Limits

| Limit                     |     Default |  Hard maximum | Purpose                                   |
| ------------------------- | ----------: | ------------: | ----------------------------------------- |
| `maximumConcurrency`      |           8 |            64 | Active executor/I/O slots                 |
| `maximumDurationMs`       |      30,000 |       300,000 | Whole-batch deadline                      |
| `maximumTasks`            |      65,536 |     1,000,000 | Pending plus active task descriptors      |
| `maximumTaskIdBytes`      |         512 |        16,384 | Per-task ID                               |
| `maximumResultBytes`      |  33,554,432 |   268,435,456 | One serialized E05 result retained by E10 |
| `maximumTotalResultBytes` | 134,217,728 | 1,073,741,824 | Aggregate serialized E05 results retained |

Options are closed data. Unknown fields, accessors, proxies, non-integers, zero/negative limits,
limits above hard ceilings, an invalid signal, or a per-result limit above the aggregate limit fail
before work starts. Surface identities and canonical target paths retain the core 16,384-byte hard
text/path ceiling independently of the configurable task-ID limit.
