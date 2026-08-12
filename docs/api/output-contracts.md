# Output contracts and compatibility

B05 closes the production output boundary before formatter and domain implementations are added. The
public TypeScript contracts, hostile-input validators, and deterministic serializers live in
`@agent-context/core`. The private formatter, efficiency, and standards packages consume these
contracts; they do not define competing wire formats.

## Published schemas and versions

Every product-owned family is versioned independently. The SARIF subset advanced to `2.0.0` in I06;
[ADR-0004](../architecture/decisions/0004-sarif-product-subset-v2.md) records the required GitHub
compatibility correction. These family versions are wire-contract identities within the stable
`1.0.0` product release:

| Family                | Record or standard                | Version constant                   |
| --------------------- | --------------------------------- | ---------------------------------- |
| Terminal render model | `agent-context-terminal-output`   | `TERMINAL_OUTPUT_SCHEMA_VERSION`   |
| Native scan JSON      | `agent-context-scan-output`       | `JSON_OUTPUT_SCHEMA_VERSION`       |
| SARIF product subset  | SARIF 2.1.0                       | `SARIF_OUTPUT_SCHEMA_VERSION`      |
| Efficiency report     | `agent-context-efficiency-output` | `EFFICIENCY_OUTPUT_SCHEMA_VERSION` |
| Standards status      | `agent-context-standards-output`  | `STANDARDS_OUTPUT_SCHEMA_VERSION`  |
| Diagnostic baseline   | `agent-context-baseline-output`   | `BASELINE_OUTPUT_SCHEMA_VERSION`   |

The package exports three closed Draft 2020-12 schemas:

- `@agent-context/core/schemas/output-contract.v1.schema.json` covers all native records. Its scan
  variant references the separately published B04 diagnostic schema.
- `@agent-context/core/schemas/sarif-output.v2.1.0.schema.json` is the frozen original SARIF product
  subset v1 schema.
- `@agent-context/core/schemas/sarif-output.v2.1.0-product-v2.schema.json` covers the current SARIF
  product subset v2.

The SARIF standard version (`SARIF_VERSION`) remains `2.1.0`; the product subset version is stored
in `runs[].properties.agentContextSchemaVersion`. These versions answer different questions and must
not be substituted for one another.

## Closed runtime boundary

All records are plain, acyclic JSON with exact fields. Runtime validation rejects unknown fields,
accessors, proxies, exotic prototypes, sparse arrays, symbols, non-finite numbers, negative zero,
ill-formed Unicode, excessive nesting, and input over the exported resource ceilings. Validation
collects at most 256 issues. Callers should display issues as data and must never evaluate text from
an output record.

The family validators perform constraints JSON Schema cannot express conveniently:

- identifiers and fingerprint maps are unique and sorted by Unicode code unit;
- repository paths remain repository-relative; SARIF artifact URIs use the one canonical,
  uppercase-percent-encoded, query-free and fragment-free form produced by `encodeSarifArtifactUri`
  and accepted by `decodeSarifArtifactUri`;
- efficiency percentiles are monotonic and projected tokens cannot exceed their baseline;
- scan profile identities exactly equal the union of profile identities used by emitted diagnostic
  fingerprints, and exit status is derived from active diagnostic severities and the declared
  `error`, `warning`, or `never` failure threshold;
- standards artifact channels agree with the requested channel and a locked activation has a lock;
- baseline and entry timestamps are real canonical UTC instants, chronology is forward, the
  diagnostic contract is exactly B04 `0.1.0`, and entries have a canonical compound order;
- SARIF `ruleIndex` identifies the matching sorted descriptor, source regions are forward, related
  location IDs are consecutive and physical locations are unique, provenance IDs are canonical, all
  three fingerprint keys have their exact value form, and tool/help URIs are well-formed
  credential-free HTTPS.

Text fields, including semantic versions and the SARIF tool information URI, are limited to 4,096
Unicode code points in both Draft 2020-12 schemas. Runtime validation additionally enforces 16,384
UTF-8 bytes. The fixed SARIF fingerprint keys have exact value shapes: GitHub's line hash is bounded
to 4,096 ASCII characters, and the two product fingerprints are lowercase 64-character SHA-256
digests. Fixed-width timestamps and digests carry their exact schema lengths. Differential tests pin
each variable-length boundary in both schema and runtime validation.

`validateScanJsonOutput` additionally requires the exact validated B03 source documents so its B04
diagnostic bundle can be checked against source digests, ranges, relationships, and fingerprints.
Passing an empty source registry is not a shortcut for consuming untrusted scan output.

## Deterministic serialization

Every public serializer validates and then passes every string key and value through the same
inert-output boundary. It replaces C0/C1 and Unicode bidirectional formatting controls (including
ALM, LRM, and RLM), strips every caller-provided SGR sequence instead of preserving arbitrary color
state, and redacts high-confidence credential forms and test canaries as `REDACTED`. Consequently,
repository-controlled text cannot inject terminal state or survive in JSON/SARIF as a known secret.
The final document LF is trusted framing generated by the serializer.

`serializeNativeOutput` and `serializeSarifOutput` then recursively sort object keys by Unicode code
unit, emit compact JSON, and terminate the document with one LF. Arrays retain their
contract-defined order. SARIF root members are intentionally written as `version`, `$schema`, then
`runs`, following SARIF's recommendation that `version` appear first.

`serializeTerminalOutput` validates the render model, sanitizes each line, and joins it with LF. An
empty model renders no bytes; a non-empty model ends in one LF. Terminal width and color policy are
inputs captured in the model, making snapshots stable and independent of the ambient terminal.

Serializers return a result union rather than throwing for malformed input. Proxies, including
revoked proxies, are rejected before record-kind inspection. Unexpected inspection failures are
reported as `invalid-json` without invoking proxy traps or exposing exception details.

## Compatibility policy

Schema versions use canonical semantic versions. Compatibility is assessed separately for each
family.

- **Patch**: validator corrections, clearer diagnostics, documentation, or serializer bug fixes that
  do not change the accepted document shape. Patch revisions are wire-compatible.
- **Minor**: additive optional fields or additive enum members whose unknown value can be handled
  safely. Older producers are accepted by a newer consumer on the same major. A newer producer is
  not silently accepted by this closed validator: upgrade the consumer or explicitly down-convert
  using a reviewed migration.
- **Major**: adding a required field, removing or renaming a field, narrowing a value, changing
  meaning, canonical order, identity/fingerprint construction, safety limits in a compatibility-
  affecting way, or changing serializer bytes. Major versions require an explicit migration.

`classifyOutputCompatibility(producerVersion, consumerVersion)` implements negotiation. Exact
validators still accept only versions implemented by this package, even if classification says an
older minor is conceptually compatible; a release must register and test every older version it
claims to read. Pre-release and non-canonical versions are rejected rather than guessed.

### Migration procedure

For a minor addition, add the optional member to the TypeScript contract and schema, teach the
validator and canonical serializer about it, retain tests for the prior minor, and document the
down-conversion rule. For a major change, publish a new exact schema export, keep the old schema
available for the documented support window, implement a pure old-to-new migrator, and test frozen
vectors in both directions where lossless conversion is claimed. SARIF v1 is explicitly
non-convertible: `validateSarifOutputV1` preserves old evidence, `detectSarifOutputProductVersion`
negotiates validated documents, and `migrateSarifOutputV1` requires regeneration because v1 lacks
the source-dependent GitHub hash and result provenance. Never mutate a persisted baseline or report
in place; write a new file atomically after complete validation.

## Family-specific meaning

Terminal output is a safe render model, not arbitrary bytes. Native scan JSON embeds the canonical
B04 diagnostic bundle, a failure threshold, and a non-empty profile identity map. When diagnostics
are present, that map must exactly identify the union of profiles used by their path and semantic
fingerprint bases: unrelated, omitted, and extra profile entries are rejected. A clean scan has no
diagnostic identity union, so its non-empty map records the profiles selected for that scan. Every
selected profile records its knowledge/profile version plus the observed client version or explicit
`null`. Counts and exit status are duplicated in the summary for consumers and are validated as
derived data rather than treated as new diagnostic truth.

Efficiency output names the profile version and client version as well as its tokenizer, and
distinguishes exact measurement from estimate. A score version prevents silent formula drift.
Recommendations state confidence and caveats; they do not claim model-quality equivalence.

Standards output records bundled, locked, and cached artifacts independently. Validation performs no
network operation and never activates `cachedLatest` directly. Network access belongs only to an
explicit standards command, and activation remains either reviewed bundled data or a lock. For H06
offline status, `retrievedAt` means the fixed verification time for bundled/locked records and the
recorded check time for cached-latest data. `current` and `update-available` are therefore claims
only as of `lastCheckedAt`; without usable cache metadata, freshness is `offline-unknown`. The
[offline status report](offline-standards-status.md) carries that timestamp, age calculations, and
structured problems without implying a live or globally current registry observation.

Baseline entries carry both semantic and path fingerprints plus exact engine, rule, severity,
profile/client, surface, specification-snapshot, and fingerprint-method identities. Semantic
identity alone cannot suppress a rename: I08 requires an explicit one-to-one move declaration and
otherwise keeps the diagnostic visible. Baselines expire at an explicit caller-provided UTC instant,
remain bounded to 100,000 entries, and have a dedicated frozen schema and operational contract in
[Diagnostic baseline API](diagnostic-baselines.md).

The SARIF subset intentionally excludes arbitrary property bags and absolute artifact URIs. It uses
relative source locations, sorted complete rule descriptors, related-location IDs/messages, and
bounded profile/client/spec provenance. Product fingerprints retain versioned names. The exact
unversioned `primaryLocationLineHash` is a reviewed GitHub integration exception and uses GitHub's
rolling line-context algorithm. Semantic product fingerprints are not built from absolute line
numbers or file hashes, which would make stable matching impossible after harmless movement.

## Standards basis

SARIF behavior was checked on 2026-08-02 against the primary OASIS publications:

- [SARIF 2.1.0 Plus Errata 01 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html)
- [Official SARIF 2.1.0 Errata 01 JSON Schema](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json)

The local schema is a deliberately closed product subset, not a replacement for the OASIS schema.
`pnpm sarif:compatibility` is an offline release gate. The exact, unmodified official Draft-04
schema bytes are vendored under `third_party/oasis-sarif-2.1.0-errata01/` with source, retrieval
date, license notice, byte length, and SHA-256 provenance. The gate verifies that immutable
identity, compiles the complete official schema with a Draft-04 validator, and validates the
committed v1 and v2 positive fixtures against the official and corresponding closed local schemas. A
fixture with its required `runs` property removed is the negative control, proving official
validation is active. The gate also retains an independently extracted structural profile to reject
local properties or required-member semantics outside the official vocabulary. The pinned upstream
SHA-256 is `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`. GitHub integration
sources and observed fingerprint behavior are documented in the
[SARIF formatter reference](sarif-formatter.md).
