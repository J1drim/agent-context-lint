# Defensive YAML/MDC frontmatter parser

Status: implemented by C07

Contract version: `0.1.0`

The private `@agent-context/syntax` package exports `parseFrontmatter`. It accepts a closed object
containing an intrinsic `Uint8Array`, a B03 source ID, and either the `yaml` or `mdc` dialect label.
The function performs no filesystem, command, environment, clock, locale, or network operation. It
snapshots accepted bytes through typed-array intrinsics before decoding.

## Envelope and authority

Only `---` on the first complete line opens metadata, and only a later line containing exactly `---`
closes it. LF, CRLF, and CR are retained; delimiters, content, body, keys, and values use zero-based
half-open B03 positions with both UTF-16 and UTF-8 byte offsets.

The result separates syntax state from scope authority:

| State     | Scope authority | Meaning                                                                          |
| --------- | --------------- | -------------------------------------------------------------------------------- |
| `absent`  | `absent`        | No exact opening delimiter; the whole file is Markdown body.                     |
| `valid`   | `available`     | A closed mapping passed every encoding, syntax, graph, type, and resource check. |
| `invalid` | `denied`        | Metadata cannot control activation. No partial or recovered value is returned.   |

An unclosed envelope has an empty body range at end of input. This prevents metadata-shaped text
from silently becoming always-on instructions. Vendor adapters remain responsible for required and
unknown fields, scalar shapes such as glob lists, and the activation meaning of valid fields.

## Accepted data subset

The parser uses the pinned `yaml@2.9.0` document AST under strict YAML 1.2 core-schema parsing. A
frontmatter value is rebuilt without `Document#toJS` into deeply frozen JSON-compatible data. Maps
have null prototypes and string keys; arrays retain source order. Finite floats, safe integers,
booleans, strings, and null are accepted. Negative zero, non-finite numbers, precision-unsafe
integers, non-string/complex keys, non-mapping roots, parser warnings, directives, and multiple
documents fail closed.

Anchors, aliases, and explicit tags are rejected before native conversion. This is deliberately
narrower than YAML 1.2: frontmatter describes scope metadata and does not need graph identity or
application-defined construction. YAML 1.2 identifies ill-formed streams, unresolved aliases,
unresolved tags, non-unique keys, and unavailable native types as loading failure points. The
selected library documents `uniqueKeys` and `maxAliasCount` as controls; C07 avoids alias conversion
entirely and iterates the bounded AST itself.

Primary references:

- [YAML 1.2.2 specification](https://yaml.org/spec/1.2.2/)
- [`yaml` parse, document, node, and resource-control documentation](https://eemeli.org/yaml/)

## Resource and diagnostic contract

Defaults are also absolute maxima and may only be reduced by a closed plain options object:

| Limit                              | Default/maximum |
| ---------------------------------- | --------------: |
| source bytes                       |         262,144 |
| YAML nodes, including mapping keys |           8,192 |
| collection entries                 |           4,096 |
| collection depth                   |              64 |
| decoded scalar/key bytes           |          65,536 |
| issues                             |              64 |

Source byte length is checked through an intrinsic typed-array getter before copying or decoding.
Malformed UTF-8 and UTF-8 BOMs are rejected without fabricated positions (`range: null`). Decodable
failures carry exact ranges. Parse errors and warnings are mapped to stable product codes without
reflecting repository-controlled text.

Duplicate keys produce `duplicate-key`; malformed YAML, directives, and warnings produce
`invalid-yaml`; anchors/aliases and tags have separate denial codes. Resource failures stop bounded
traversal. Hostile API objects, proxies, accessors, symbols, sparse/extra fields, typed-array
subclass overrides, malformed options, and mutable input bytes cannot become authority.

## Composition

Consumers slice the exact decoded `text` by `bodyRange` and pass that body to C06/C08. They use the
ordered `locations` array for source-located adapter validation and diagnostics. Paths use `$` plus
RFC 6901 escaping (`~0`, `~1`). An invalid result must be reported and must never be treated as an
empty mapping, absent metadata, or an always-active instruction.
