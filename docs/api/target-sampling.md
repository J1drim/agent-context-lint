# Deterministic target sampling

`classifyTargetSourcePath()` exposes E08's pure source-language classifier so composition roots can
construct activation observations for exactly the same source universe before sampling. It accepts
one canonical repository file path, matches special basenames case-sensitively and extensions
case-insensitively, returns `null` for non-source files, and rejects roots, escapes, malformed
Unicode, non-strings, and hostile objects. The public classifier and E08 path validator reject
individual paths above 32,768 UTF-16 code units before canonicalization; the aggregate UTF-8
path-text budget remains a separate scan-wide limit.

`sampleTargets` in `@agent-context/resolver` selects target paths for per-profile context analysis.
The immutable output record is `agent-context-target-sampling` contract `0.1.0`.
`isIssuedTargetSamplingResult` distinguishes a same-process E08 proof from a serialized lookalike;
E09 requires that issuance before a sampling record can authorize memoization for one selected
target.

## Inputs

The sampler consumes data already collected without executing repository content:

- canonical tracked/fallback paths and C03 tracking certainty/reason;
- C11 workspace boundaries and its uncertainty evidence;
- user-selected critical paths; and
- one E01 three-valued activation observation for every recognized source path.

Every observation contains the same sorted rule universe after normalization. The sampler groups
paths by the complete `active`/`inactive`/`indeterminate` state vector and hashes that framed vector
to a stable scope-partition ID. It does not call profile callbacks or apply a shared glob dialect.
Profiles own matching semantics; E08 only samples their data-only results.

Recognized source extensions cover common systems, application, web, mobile, scripting,
infrastructure, schema, and smart-contract languages. `Dockerfile`, `Makefile`, and `GNUmakefile`
are recognized without reading contents. Critical paths can be any tracked file, including docs or
configuration.

## Strategies

When the source-file count is at or below `exhaustiveSourceFileLimit` (default 1,000), strategy
`exhaustive` selects every recognized source file plus every available critical path.

Larger repositories use strategy `stratified`. The selected union contains:

- every available critical path;
- the first canonical source path under every distinct C11 workspace root;
- the first canonical path in every activation-state partition; and
- the first canonical path for every `(language, source directory)` pair.

“First” uses the case-sensitive, locale-independent B01 repository-path order. Input array order,
filesystem order, and locale cannot alter results. A path selected by several strata appears once
with every sorted reason. If the required union exceeds `maximumSamples`, sampling fails rather than
silently dropping coverage.

## Coverage proof and uncertainty

`coverage` contains a stable criterion for every critical path, workspace root, scope partition,
language directory, and (in exhaustive mode) the complete source set. Each criterion records its
candidate count, representative, and `covered`/`unavailable` status. Metrics report tracked/source,
workspace, partition, language-directory, critical-path, and activation-fact cardinalities.

The result is `partial` when tracking used a fallback, C11 workspace evidence is uncertain, or a
requested critical/workspace stratum has no source candidate. Missing critical paths are retained as
unavailable proof; they are not invented or silently ignored. C03 certainty/reason and C11
uncertainty/reasons must agree and are preserved in provenance.

## Safety and limits

The sampler reads no files and invokes no commands. It rejects proxy/accessor-bearing or extended
records, sparse/extended arrays, noncanonical paths, duplicate identities, inconsistent activation
rule universes, contradictory upstream provenance, unknown fields/states/families/languages, and
over-limit text, paths, facts, workspaces, rules, samples, or elapsed time. Defaults support 100,000
tracked paths and 1,000,000 activation facts; hard ceilings remain finite.

See [activation algebra](activation-algebra.md) and
[workspace-boundary discovery](workspace-boundary-discovery.md).
