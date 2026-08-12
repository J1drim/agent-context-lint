# Diagnostic baseline API

Ticket I08 implements diagnostic baselines as a pure `@agent-context/core` operation over validated
B03/B04 data. The API neither reads a baseline file nor writes one. CLI integration is responsible
for repository-contained I/O and must treat a failed result as an operational error; it must never
interpret a malformed baseline as an empty baseline.

## Frozen v1 identity

`diagnostic-baseline.v1.schema.json` is the dedicated closed Draft 2020-12 schema. It is also the
`agent-context-baseline-output` branch of `output-contract.v1.schema.json`. A v1 document binds:

- baseline schema, B04 diagnostic contract, engine, path-fingerprint method, and
  semantic-fingerprint method versions;
- every selected profile's profile/client versions and canonical surface/specification snapshot IDs;
- every entry's rule ID/version, effective severity, repository path, both fingerprints, and the
  profile/surface/specification provenance extracted from the diagnostic; a tuple-preserving
  provenance fingerprint prevents cross-profile surface/spec permutations from comparing equal;
- an explicit caller-supplied creation instant, optional baseline/entry expiry, source revision
  digest, and canonical entry order.

Unknown fields and unsupported identities fail closed. The legacy B05 scaffold omitted identity
fields required for safe comparison and therefore requires explicit regeneration; it is not silently
upgraded. Frozen exact-match, expiry, unsupported-major, and legacy-regeneration expectations live
in `diagnostic-baseline-compatibility.v1.json`.

## Generation

`generateDiagnosticBaseline` accepts a validated diagnostic bundle, its B03 source documents, an
explicit diagnostic classification in the same order, exact environment identities, `createdAt`, and
`expiresAt`. The caller must classify every item as `lint`, `configuration-error`, or
`parser-error`. Only `lint` items become entries. Parser and configuration errors cannot become
baseline suppressions.

Generation owns the persisted canonical order: entries are ordered by their complete compatibility
identity. This intentionally differs from F15's presentation order. Only byte-identical matching
identities are deduplicated; a severity, provenance, rule version, path, or fingerprint difference
remains a separate entry. Comparison results preserve the current diagnostic order.

The result and every nested object are frozen. The operation uses no filesystem, network, process,
environment, random, or ambient clock capability. It sanitizes output strings, validates the final
closed document, canonical-serializes it, and enforces the shared 100,000-entry and 64 MiB aggregate
string/serialized-byte ceilings.

## Comparison

`compareDiagnosticBaseline` validates both inputs before comparing. On failure it returns
`ok: false`; callers must report that operational failure and retain the unfiltered current
diagnostics. The required `now` value is a canonical UTC instant with millisecond precision. Local
offsets and implicit current time are rejected, which makes expiry boundary behavior reproducible
across time zones.

A diagnostic is hidden only when one unexpired entry has the complete exact identity. Results expose
one audit record per current diagnostic and retain caller order:

| Status         | Visibility | Meaning                                                                                                  |
| -------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `matched`      | hidden     | one exact entry or one explicitly proven path move matched                                               |
| `new`          | visible    | no entry matched, a move was unproven, or the item is parser/configuration output                        |
| `expired`      | visible    | the matching entry or whole baseline expired at or before `now`                                          |
| `incompatible` | visible    | engine, profile/client/surface/spec, rule version, severity, provenance, or fingerprint identity changed |
| `ambiguous`    | visible    | a fingerprint collision or many-to-one/one-to-many move could not be proven unique                       |

The summary reports `matched`, `new`, `stale`, `expired`, `incompatible`, and `ambiguous`.
Unconsumed baseline entries are retained as stale audit records rather than silently pruned or
migrated. `diagnosticIndex` and `visibleDiagnosticIndexes` are the authoritative links back to the
caller's F15 array; diagnostic IDs in the audit result are sanitized presentation values.

## Path moves

Semantic fingerprints alone never suppress a moved result. A caller must provide a closed
`BaselinePathMove` containing the old path, new path, rule ID, and semantic fingerprint. The engine
then requires identical rule/severity/profile/surface/spec provenance and a one-to-one candidate on
both sides. Duplicate declarations, semantic collisions, and one-to-many or many-to-one candidates
are `ambiguous` and remain visible. Without a declaration, the deterministic result is
`new/path-move-unproven`.

## Standards basis

The design was reviewed on 2026-08-02 against the
[SARIF 2.1.0 baseline-state contract](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
and
[GitHub's fingerprint guidance](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files).
SARIF requires comprehensive comparison when baseline state is claimed and warns that
nondeterministic inputs weaken fingerprints. GitHub additionally requires stable rule IDs and paths.
The linter therefore reports every comparison outcome, versions its fingerprints, and permits a path
change only with stronger explicit evidence. ESLint's documented conservative bulk-suppression
behavior was also reviewed: when identity cannot distinguish old from new findings, results remain
visible rather than being guessed away.
