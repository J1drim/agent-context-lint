# Discovery index design

## Boundary and pipeline position

C05 is a projection over C03 and C04 results:

```text
C03 canonical paths + tracking provenance
                    |
                    v
C04 retained/ignored partition + profile uncertainty
                    |
                    v
C05 path-only recognizers -> bounded candidate index
                    |
                    v
profile adapters / C11 selectively read candidates through C02
```

The implementation has no `ReadOnlyRepository` parameter. That makes the "never read unrelated
contents" requirement structural rather than dependent on caller discipline. It imports no
filesystem, process, child-process, socket, or model API. Tests may read the compact generator
fixture; production code does not.

## Input authority

The C03 snapshot must be canonical, sorted, unique, bounded, and coherent: `git-index` means
tracked/verified, while filesystem fallback means `all-files-not-tracked`. The C04 retained and
ignored arrays must be sorted, disjoint, and form an exact partition of the C03 array. Tracking
certainty, ignore certainty, ignored-decision certainty, and profile certainty must agree with that
source. This rejects forged results that could silently drop a path or claim stronger provenance.

Snapshotting accepts only own plain data properties and dense ordinary arrays. Repository-owned
getters, proxies, symbols, extended arrays, and sparse arrays are rejected before use. Canonical
path checks reject traversal, backslashes, malformed UTF-16, controls, and bidi overrides while
preserving valid Unicode scalar values and case.

## Matching and determinism

The built-in catalog contains path mechanisms, not client semantics. Matching is separator-neutral
because inputs are already canonical POSIX paths. It is case-sensitive and independent of the host
filesystem, locale, directory iteration order, or installed client version.

Paths remain in C03/C04 order. Recognitions sort by stable recognizer ID, kinds sort lexically,
catalog sources sort by ID, and all returned containers are frozen. Profile/configuration
contributions are closed data facts; C05 never invokes callbacks. Unknown or conditional behavior
cannot silently add a file.

## Resource accounting

Validation and matching share one deadline, cancellation check, and work budget. Work is charged
while snapshotting paths, validating the C03/C04 partition, and evaluating recognizers.
Cancellation/deadline checks occur at construction, at bounded work intervals, and before
publication. Counts, total UTF-8 path bytes, path depth/length, facts, candidates, recognizers per
candidate, work, and time all have defaults and immutable hard ceilings.

`conformance/fixtures/v0/discovery-100k.fixture.json` describes a compact, deterministic generator
for exactly 100,000 paths, including 100 instruction files, 40 evidence manifests, and 50 ignored
paths. The acceptance test expands it in memory, requires the exact 140-candidate result, asserts
zero content reads, requires deterministic work below the default ceiling, and enforces the plan's
ten-second C05 budget. It stores no repository contents and does not use an external Git repository.

## Extending the catalog

Add a built-in recognizer only when a required ticket needs its path and a first-party source or
explicit plan artifact supports the candidate class. Update API documentation and positive,
negative, structural-boundary, hostile, and 100k-resource tests in the same commit. Discovery
changes that alter client activation belong in that client's adapter and conformance fixtures, not
here.
