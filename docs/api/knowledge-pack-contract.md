# Canonical standards knowledge-pack contract

Ticket H01 defines the `0.1.0` data-only knowledge-pack contract. This is an independent
wire-contract identity shipped by the stable `1.0.0` product release. The normative JSON Schema is
shipped as `@agent-context/standards/schemas/knowledge-pack.v0.schema.json`; the TypeScript types,
constants, validator, canonical serializer, and canonical parser are exported from
`@agent-context/standards`.

## Trust boundary

A pack is untrusted input. Validation never loads a module, invokes a callback, executes a command,
evaluates an expression, compiles a regular expression or glob, follows a URL, or mutates a
repository. The schema is closed at every fixed object boundary. Engine-owned matcher identifiers
select only the five fixed operand shapes in this contract:

- `field-presence` and `field-type`;
- `location-exact` for one canonical repository-relative path;
- `identifier-equals`; and
- `identifier-transition`.

Fields named `callback`, `code`, `command`, `eval`, `executable`, `expression`, `function`, `glob`,
`handler`, `module`, `plugin`, `regex`, `require`, `script`, or `template` are rejected at every
object depth. Unknown fields are also rejected. Matchers are declarative selectors; they cannot add
discovery, parsing, precedence, import, glob, or executable rule logic. Those changes require an
engine release.

H01 establishes safe canonical data validation, not artifact authenticity. H02 owns TUF roles,
signatures, thresholds, expiry, rollback, and channel delegation. The H03
[immutable bundled loader](bundled-knowledge-pack-loader.md) verifies TUF metadata, target
path/length/digest, channel, schema version, and `minEngineVersion` before passing bytes to this
parser. A successful H01 parse alone must never activate a downloaded pack.

## Root and compatibility identity

Every root has exactly these fields: `recordKind`, `schemaVersion`, `channel`, `packId`,
`packVersion`, `publishedAt`, `compatibility`, `sources`, and `knowledge`. `channel` is `stable` or
`preview`; every compatibility record must repeat the same channel so a mixed pack fails closed.

Each compatibility record identifies one unique, sorted `(formatId, profileId, surfaceId)` tuple and
records:

- exact SemVer 2.0.0 `adapterVersion`, `rulesetVersion`, and `minEngineVersion` values;
- nullable `profileId`, `surfaceId`, and `upstreamRevision` values (null means unavailable or not
  applicable, never an implicit default);
- a real `retrievedAt` date; and
- sorted, unique canonical HTTPS `specificationUrls` plus an exact URL-to-lowercase-SHA-256
  `contentDigests` map.

Each specification URL, retrieval date, and digest must exactly match an entry in `sources`. Sources
are sorted by stable ID, use credential-free canonical HTTPS URLs, and cannot have a retrieval date
later than `publishedAt`. This keeps syntax/client provenance visible in every accepted pack without
making the pack a source of executable adapter behavior. Canonical bracketed IPv6 literals are
supported; unbracketed IPv6 authorities, credentials, and URL spellings that the WHATWG URL parser
would normalize are rejected.

## Knowledge records

`knowledge` is a non-empty array sorted by stable record ID. The four closed record kinds are
`known-field`, `known-location`, `deprecation`, and `migration-hint`. Every record carries explicit
nullable profile/surface IDs, a non-empty summary, sorted unique `ACL100`–`ACL999` rule IDs, sorted
unique source IDs, and one allowlisted matcher. Payload and matcher operands must agree exactly.
Source IDs must resolve within the same pack. H03 may additionally cross-bind the rule IDs to the
engine-owned registry without creating a package dependency from standards to rules.

Stable IDs use ASCII alphanumerics separated only by `.`, `_`, `:`, `/`, or `-`. Dates are real
proleptic Gregorian `YYYY-MM-DD` dates. Versions use the complete SemVer 2.0.0 grammar, including
prerelease and build identifiers. Repository paths use the core canonical repository-relative POSIX
contract.

## Canonical JSON and ingress

`serializeKnowledgePack(value)` first validates an in-memory value and then emits RFC 8785 JSON
Canonicalization Scheme (JCS) text. The implementation:

- accepts only I-JSON-compatible finite IEEE-754 values and well-formed Unicode, rejecting lone
  surrogates and all 66 Unicode noncharacters in both property names and values;
- preserves Unicode code points without normalization;
- uses ECMAScript JSON number/string serialization;
- sorts object names by UTF-16 code units; and
- emits no insignificant whitespace or trailing newline.

`parseCanonicalKnowledgePack(textOrBytes)` accepts only exact canonical UTF-8. For byte input it
reads length and backing storage through trusted TypedArray internal-slot getters, rejects every own
extra/accessor/symbol property without reading it, and copies through the trusted intrinsic
TypedArray-to-TypedArray operation. It never consults an input iterator, species, constructor,
`byteLength`, or `buffer` property. Proxies, other views, typed-array subclasses, detached buffers,
shared buffers, BOMs, malformed UTF-8, duplicate keys, alternate escapes, alternate number
spellings, and whitespace variants fail closed.

Before `JSON.parse`, the escape-aware lexical scanner decodes string code points arithmetically
without constructing decoded strings. It enforces each decoded string's code-point/UTF-8 limits,
I-JSON surrogate/noncharacter rules, nesting, container entries, and structural tokens. The 4 MiB
raw-byte ceiling also bounds aggregate decoded strings because every accepted UTF-8 character uses
the same bytes as its decoded form and every JSON escape is longer than the bytes it decodes.
Semantic validation then repeats the complete in-memory limits, conservatively including object
member names in aggregate string-byte accounting, and closed-schema checks.

## Resource limits

| Resource                   |                                            Limit |
| -------------------------- | -----------------------------------------------: |
| Canonical pack bytes       |                                            4 MiB |
| JSON nesting depth         |                                               64 |
| JSON values                |                                          100,000 |
| Container entries          |                                           20,000 |
| One string                 | 4,096 Unicode code points and 16,384 UTF-8 bytes |
| Total string bytes         |                                            4 MiB |
| Knowledge records          |                                           10,000 |
| Sources                    |                                            1,024 |
| Compatibility records      |                                               16 |
| Rule IDs per record        |                                               64 |
| Reported validation issues |         256 (the final issue reports truncation) |

Arrays with authority-bearing identities or references must be non-empty, unique, and sorted by
UTF-16 code units. The validator returns a recursively frozen copy, so later caller mutation cannot
change accepted authority-bearing data.

## Schema and runtime responsibilities

The Draft 2020-12 schema provides portable structural validation and bounded vocabularies. Runtime
validation additionally enforces properties JSON Schema cannot express compactly: canonical URL
spelling, real dates, canonical repository paths, source/provenance joins, channel equality,
payload/matcher equality, sorted order, aggregate limits, hostile JavaScript object rejection, and
exact canonical bytes. Consumers must use the runtime parser at the trust boundary; validating with
the JSON Schema alone is insufficient.

## Primary specifications

The contract was checked against these primary sources on 2026-08-01:

| Source                                                                                               | Applied requirement                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)                | I-JSON input, ECMAScript primitive serialization, no whitespace/normalization, recursive UTF-16 property sorting |
| [RFC 7493: I-JSON](https://www.rfc-editor.org/rfc/rfc7493.txt)                                       | interoperable JSON constraints, including surrogate and Unicode noncharacter rejection                           |
| [RFC 8259: JSON](https://www.rfc-editor.org/rfc/rfc8259.html)                                        | JSON syntax and interoperability baseline                                                                        |
| [JSON Schema Draft 2020-12 Core](https://json-schema.org/draft/2020-12/json-schema-core)             | schema dialect and closed applicator semantics                                                                   |
| [JSON Schema Draft 2020-12 Validation](https://json-schema.org/draft/2020-12/json-schema-validation) | validation keywords and format boundary                                                                          |
| [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)                                     | version grammar                                                                                                  |
| [The Update Framework specification](https://theupdateframework.github.io/specification/latest/)     | future H02/H03 authenticity, freshness, delegation, and rollback boundary                                        |

The TUF source is versioned independently and is intentionally informative for H01; H02 records the
exact adopted TUF version and operational assumptions.
