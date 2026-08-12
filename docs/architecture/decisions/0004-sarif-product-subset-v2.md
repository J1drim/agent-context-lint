# ADR-0004: SARIF product subset v2 and GitHub fingerprints

- Status: Accepted
- Date: 2026-08-02
- Ticket: I06
- Decision owners: Maintainers

## Context

B05 defined the initial SARIF 2.1.0 product subset numbered `1.0.0`. It required every partial
fingerprint name to end in `/vN` and every value to be a SHA-256 digest. GitHub code scanning instead
correlates uploaded third-party results using the exact, unversioned
`partialFingerprints.primaryLocationLineHash` key and a rolling-hash value shaped as `hex:occurrence`.
The original subset also omitted rule help, full descriptions, related-location identifiers and
messages, and per-result profile/surface/spec provenance required by I06.

The normative SARIF version and the Agent Context Linter product-subset version are independent.
Adding the missing required members and accepting GitHub's vendor fingerprint changes our product
wire shape, but does not change OASIS SARIF 2.1.0.

## Decision

The current Agent Context Linter SARIF product subset is `2.0.0`. It still emits normative SARIF
`version: "2.1.0"` and the exact OASIS Errata 01 `$schema` URI.

- New producers emit only product subset v2 and validate with `validateSarifOutput`.
- The original schema remains exported as
  `@agent-context/core/schemas/sarif-output.v2.1.0.schema.json`; it is the frozen original
  product subset v1 schema retained for compatibility.
- V2 is separately exported as
  `@agent-context/core/schemas/sarif-output.v2.1.0-product-v2.schema.json`.
- `validateSarifOutputV1` validates v1 exactly. `detectSarifOutputProductVersion` validates before
  reporting either supported product version. V1 and v2 validators reject each other's documents.
- `migrateSarifOutputV1` never guesses missing data. A valid v1 document returns
  `regeneration-required`; callers regenerate v2 from the B04 diagnostic bundle and exact B03
  source documents. Invalid v1 returns bounded validation issues. Current serialization rejects v1.
- V2 requires complete referenced-rule metadata, related-location IDs/messages, rule-version and
  profile/surface/spec provenance, and three exact partial fingerprints:
  `primaryLocationLineHash`, `agentContextPath/v1`, and `agentContextSemantic/v1`.
- `primaryLocationLineHash` deliberately follows GitHub's unversioned vendor key. The two
  product-owned fingerprints retain versioned hierarchical names and SHA-256 values.
- The formatter reproduces GitHub CodeQL Action's 100-non-space/tab UTF-16-code-unit rolling hash,
  CR/LF normalization, unsigned 64-bit arithmetic, and per-hash occurrence suffix. Its behavior is
  pinned by independent fixed vectors.

This was a major correction before the stable `1.0.0` release. No released document is silently
reinterpreted and no support claim is made for lossless conversion that the old data cannot satisfy.

## Consequences

- Packed consumers can address and validate either exact schema and must negotiate using the
  product version in `runs[].properties.agentContextSchemaVersion`, not SARIF's `version`.
- Stable GitHub alert tracking requires the original source text. Persisted v1 SARIF alone is not a
  sufficient migration source.
- Formatter output can be consumed by OASIS tooling and by the documented GitHub SARIF subset, while
  remaining a deliberately smaller closed contract.
- Future changes to required metadata, fingerprint names/algorithms, serializer bytes, or provenance
  are compatibility-reviewed product-schema changes.

## Rejected alternatives

### Keep v1 and omit GitHub's key

Rejected because GitHub documents only `primaryLocationLineHash` as its supported partial
fingerprint for third-party uploads. A differently named SHA-256 would validate as generic SARIF but
would not meet the product's code-scanning stability requirement.

### Place `primaryLocationLineHash` outside the closed schema

Rejected because accepting undeclared properties would weaken fail-closed validation and make packed
consumer behavior differ from producer behavior.

### Convert v1 by copying an existing SHA-256

Rejected because neither v1 SHA-256 fingerprint contains the source-dependent rolling hash or its
occurrence count. Relabeling it would produce a syntactically plausible but semantically false value.

## Primary sources

Reviewed 2026-08-02:

- [OASIS SARIF 2.1.0 Plus Errata 01 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html)
- [OASIS SARIF 2.1.0 Errata 01 JSON Schema](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json), vendored byte-for-byte with SHA-256 `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`
- [GitHub Enterprise Cloud SARIF support](https://docs.github.com/en/enterprise-cloud@latest/code-security/reference/code-scanning/sarif-files/sarif-support), current Enterprise Cloud documentation
- [GitHub CodeQL Action fingerprint implementation](https://github.com/github/codeql-action/blob/main/src/fingerprints.ts), `main` as retrieved 2026-08-02

GitHub's documentation says only the exact `primaryLocationLineHash` partial fingerprint is used;
the rolling algorithm details are observed in the linked CodeQL Action source. GitHub may change
service-side behavior independently, so this integration must be re-reviewed before a product major
or when upload validation reports drift.
