# Resolver cache behavior

Agent Context Linter can reuse effective-context work within one scan. Reuse is exact and invisible:
the reported documents, ordering, conflicts, ambiguity, content, JSON, and SARIF do not say whether
a target was resolved cold or warm.

A cached result is reused only when all resolver-relevant inputs match: effective configuration,
configuration source identity, client/profile/surface/spec versions, complete profile resolution,
target path and source identity, instruction and imported-document content/availability/source
identity, import graph and trace, and the target's sampling uncertainty. Editing or replacing any
relevant file causes a miss. Changing an unrelated sampled target does not.

The v1 cache is process-local and memory-bounded. It creates no cache directory, reads no
user-global state, sends no data, and survives neither process exit nor an explicit clear. A cold
run after restart is expected and has the same output as a warm run.

Unknown behavior is not “learned” by the cache. Conditional activation, unavailable files, partial
profiles, unresolved imports, and unknown precedence remain explicit on every hit. If input changes
during collection, upstream identity/content checks and the complete key force recomputation or a
closed failure rather than stale reuse.

See the [effective-context guide](effective-context.md) for what the resolver reports and the
[cache API](../api/effective-context-cache.md) for embedding details.
