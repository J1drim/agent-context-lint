# Deterministic concurrent resolution

Agent Context Linter can prepare effective context for many targets concurrently without making
output depend on machine speed. It uses a fixed upper bound on active work, starts queued targets
only when a slot becomes available, and always reports results in profile/surface/path order.

For the same repository snapshot, configuration, profiles, targets, and standards knowledge,
single-slot and multi-slot runs produce byte-identical resolver batches. Task completion timing is
not included in output and cannot establish profile precedence. E10 preserves every E05 unknown,
conditional, partial, truncation, and ambiguity state exactly as a serial run does.

Cancellation stops new targets from starting and signals active work. The whole batch also has a
deadline and task/result-memory limits. A cancellation, task failure, mismatched result, or limit
failure returns no partial success. Internal task errors are not copied into output because they may
contain repository text or local paths.

Concurrency grants no new capability. Normal analysis remains offline, model-free, read-only, and
does not execute repository commands. Task preparation uses the same root-jailed read-only services
as a serial scan. The E11 library layer publishes bounded, count-only progress and owns cancellation
cleanup; E10 defines the deterministic engine beneath it. See [Embed Agent Context Linter](library-api.md).
