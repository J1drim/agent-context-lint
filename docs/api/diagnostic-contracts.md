# Diagnostic, evidence, fix, suppression, and fingerprint contracts

`@agent-context/core` exposes B04 as the closed, versioned `agent-context-diagnostics` transport
contract. The current contract version is `0.1.0`. It carries diagnostics with exact B03 source
locations, typed evidence, previewable atomic fix plans, suppression lifecycle records, and two
independently versioned fingerprints.

Use `validateDiagnosticBundle` at every untrusted boundary. It needs the exact `SourceDocument`
objects from an already validated B03 instruction IR so that paths, digests, and UTF-16/UTF-8 source
ranges can be checked against the bytes that analysis used:

```ts
import { validateDiagnosticBundle, validateInstructionIr } from "@agent-context/core";

const ir = validateInstructionIr(JSON.parse(irText));
if (!ir.ok) throw new Error("invalid instruction IR");

const result = validateDiagnosticBundle(JSON.parse(diagnosticText), ir.value.sources);
if (!result.ok) {
  for (const issue of result.issues) console.error(`${issue.path}: ${issue.message}`);
  return;
}

const bundle = result.value;
```

`isDiagnosticBundle` provides Boolean narrowing over the same validation. Both entry points are
synchronous, deterministic, offline, and fail closed. They do not read files, follow links, access
the network, execute repository content, apply fixes, or interpret suppression comments. Accessors,
proxies, cycles, exotic objects, malformed Unicode, sparse arrays, excessive depth, and oversized
collections are rejected before semantic inspection.

The packaged Draft 2020-12 schema is exported as
`@agent-context/core/schemas/diagnostic-contract.v0.schema.json`. JSON Schema validates the portable
shape. Callers must still use the runtime validator for relationships that JSON Schema cannot prove,
including exact source ranges and digests, canonical ordering, fingerprints, fix conflicts, and
suppression state coherence.

## Diagnostics and evidence

Every diagnostic has a stable ID, rule ID and rule version, severity, message, primary source
location, related evidence, optional suggestion, fingerprint basis, and computed fingerprints.
Primary and source-related locations bind a canonical repository-relative path and SHA-256 digest to
a B03 source ID and its zero-based half-open range. Absolute paths are never part of this contract.

Related evidence is a closed union:

- `source` points to an exact source location;
- `repository-fact` names the collector, stable fact identity, optional subject path, value digest,
  and supporting locations;
- `resolution` binds profile, surface, specification snapshot, selected targets/rules/events,
  evidence references, source locations, and explicit B02 uncertainty; and
- `spec` binds a B02 snapshot/evidence reference to credential-free HTTPS provenance, retrieval
  date, and optional immutable revision.

IDs are unique across the B04 bundle. Set-like target and activation-rule identifiers are unique and
sorted by UTF-8 bytes. Resolution event IDs are unique but retain chronological trace order instead
of being sorted. Evidence fact anchors are stable identifiers or explicit `null`. Evidence remains
declarative: the contract does not claim that a referenced fact is true without the corresponding
validated source, repository, resolution, or specification record.

## Atomic fix plans

Suggestions may contain a `mechanical`, `atomic` fix plan. A plan contains one or more canonically
ordered operations:

- `text-edit` replaces an exact B03 range only when its source path and digest still match;
- `move-document` moves one exact source to a canonical destination whose precondition is `absent`;
  and
- `create-document` writes bounded content whose SHA-256 digest is included, again only to an absent
  destination.

Validation rejects malformed or out-of-source ranges, overlapping edits (including two insertions at
the same position), duplicate move sources, edit-and-move of one source, duplicate destinations, a
move to itself, and any create/move destination already present among the supplied B03 sources. A
move chain cannot make an initially occupied destination acceptable: all `absent` preconditions
refer to the same pre-application snapshot.

The contract is an intent and preview format. The I10 [atomic writer](atomic-writer.md) supplies
one-file exact-identity/digest compare-and-swap replacement. I11's
[safe fix pipeline](safe-fix-pipeline.md) owns deterministic edit planning, cross-plan conflict
rejection, preview rendering, selection/confidence authority, and one-file application. It rejects
multi-file/create/move application before mutation until a recoverable portable transaction can
satisfy the complete-plan-or-nothing claim. B04 performs no filesystem mutation.

## Suppression lifecycle

A suppression record is explicitly `applicable`, `suppressed`, or `unused`. It retains the
directive's exact source location, sorted target rule IDs, an optional reason, matched path
fingerprints, and related evidence. `suppressed` requires at least one matched fingerprint;
`applicable` and `unused` must not claim matches. B08 parses directives and emits applicable
records, range attachments, deterministic matching, and unused-state results. F15 will integrate
that API with scheduling and severity policy. Absence never silently means suppressed. See the
[targeted suppression API](suppressions.md) for the closed grammar and source/rule/range/profile
semantics.

## Fingerprints

`computePathFingerprint` emits `agent-context-lint/path/v1`. It includes the rule ID/version,
repository-relative path, a caller-defined stable anchor, and canonical profile IDs. It changes when
the finding moves to another path.

`computeSemanticFingerprint` emits `agent-context-lint/semantic/v1`. It includes the rule
ID/version, canonical profile IDs, and unique caller-defined semantic key/value components, but
excludes the path and absolute coordinates so a logically identical finding can survive a file move.

Both functions use SHA-256 with domain separation and eight-byte UTF-8 length framing for every
field. They canonicalize set-like inputs without normalizing Unicode. Messages and incidental source
offsets must not be used as semantic identity. Fingerprint method strings are part of the
compatibility contract; any breaking change requires a new method version rather than silently
changing existing hashes.

## Limits and compatibility

The public constants define collection and text limits. The diagnostic JSON preflight caps each
container at 100,000 entries, the complete graph at 1,000,000 values, each key at 1,024 UTF-8 bytes,
each string at 1 MiB, and cumulative inspected string/key data at 64 MiB. Contract prose and
nullable prose are further capped at 16 KiB; operation content retains its stricter
operation-specific rules. These budgets are simultaneous, so reaching a per-field maximum does not
reserve that maximum for every field in one envelope. Bounds are checked before array-key
enumeration and before content-dependent work where JavaScript exposes a constant-time UTF-16
length.

At most 255 ordinary issues plus the shared resource-limit sentinel are retained, including failures
while validating the supplied B03 source registry, so adversarial input cannot create unbounded
diagnostics. Validation reports stable issue codes and paths; message wording is explanatory rather
than a machine identifier.

Additive optional fields require an explicit contract-version decision. Removing fields, changing
semantics, widening fix authority, changing ordering, or changing a fingerprint algorithm is
breaking. Consumers should check `recordKind`, `contractVersion`, and each fingerprint `method`
instead of assuming that a future contract is backward compatible.
