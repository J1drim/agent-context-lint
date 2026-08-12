# Cross-profile comparison API

E07 compares effective context already issued by E05 for one exact repository target. It is a pure,
offline projection: it performs no discovery, profile replay, filesystem access, command execution,
network access, model request, or ambient configuration read.

Import `compareEffectiveContexts` and the `CROSS_PROFILE_COMPARISON_*` constants from
`@agent-context/resolver`. The closed input contains exactly:

- `contractVersion: "0.1.0"`;
- `recordKind: "agent-context-cross-profile-comparison-input"`; and
- two to sixteen same-process E05 resolutions for one target path and distinct profile/surface
  contracts.

Serialized, cloned, forged, duplicate, cross-target, sparse, accessor-bearing, proxied, oversized,
or same-contract inputs fail closed. Run each profile through its own D03/D05/D08/D10/D13 resolver
and E05 first; E07 never substitutes a generic activation or precedence dialect.

## Result model

The immutable result contains stable profile summaries and every deterministic profile pair. A pair
has three independent dimensions:

- `scope` compares recognized effective inclusion states. Known included/excluded/absent differences
  are retained while conditional activation and incomplete absence proof become `unknownPaths`.
- `ordering` compares relative order only among paths included by both profiles. It is `unknown`
  unless both E05 orders are total and their common sequences are complete; a confirmed reversal has
  one stable witness.
- `content` compares SHA-256 identities only for paths included by both profiles. Missing content,
  identity-only records, unknown truncation, and matching truncated prefixes remain unknown.

Each dimension is `same`, `different`, `unknown`, or, where there is no comparison basis,
`not-applicable`. `overall` is `divergent` when any known difference exists, `indeterminate` when no
difference is proven but a dimension is unknown, and `observational-match` otherwise.

`observational-match` is deliberately not behavioral equivalence. Every pair has
`equivalenceClaim: false` and a `semanticRelation` of `incompatible-profile-contracts` or
`distinct-surface-contracts`. Profile-owned meanings, client versions, specification snapshots, and
uncertainties remain visible in the separate summaries.

## Evidence and privacy

The comparison emits canonical repository paths, public profile identities, stable upstream
ambiguity IDs, fixed reason codes, counts, and content digests. It never emits instruction text,
upstream reason prose, settings, prompts, or environment values. Pair and profile IDs are
length-delimited SHA-256-derived identities. Output ordering uses UTF-8 byte order and is
independent of input order and locale.

Limits are published as `CROSS_PROFILE_COMPARISON_LIMITS`. Aggregate document/ambiguity counts, pair
work, pair evidence, and profile count are checked before or during bounded materialization.
`CrossProfileComparisonError.code` distinguishes invalid input, invalid relationships, and resource
limits.
