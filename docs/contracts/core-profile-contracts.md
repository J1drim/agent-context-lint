# Core profile contracts

- Contract version: `0.1.0`
- Ticket: B02
- Public package: `@agent-context/core`
- Status: stable product contract; wire identity `0.1.0`

This document describes the JSON-serializable TypeScript model that connects instruction syntax to
client behavior. The types are exported from the package root; consumers do not need a deep import.

## Separation of responsibilities

The model has four independent identities:

| Contract         | Owns                                                                               | Does not own                                                                               |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `DocumentFormat` | Syntax family and parser-visible syntax features                                   | Discovery roots, default filenames, activation, ordering, or imports performed by a client |
| `ClientProfile`  | Product identity, release class, and its surface IDs                               | A filename or an execution environment                                                     |
| `Surface`        | One independently modeled execution environment and surface-wide capability claims | Syntax parsing or claims from sibling surfaces                                             |
| `SpecSnapshot`   | Versioned sources, retrieval date, client-version state, and assumptions           | Mutable live behavior without dated provenance                                             |

`SurfaceFormatSupport` connects a format to a surface under one spec snapshot. Its recognition claim
says whether that surface accepts the syntax. More specific behavioral claims, such as path
activation, remain capability claims on that relationship. This is why `agents-markdown` can have a
known Codex claim and a model-selected VS Code claim without two syntax definitions.

Default filenames, discovery roots, precedence, imports, dynamic loading, and activation are
profile-owned behavior. They can be represented by named capabilities in B02 and implemented by
profile adapters later; they must not be added to `DocumentFormat`.

## Canonical D01 alignment

The state vocabularies exactly match
[`profile-surface-map.v0.json`](../../conformance/contracts/profile-surface-map.v0.json):

- `SupportState`: `supported`, `conditional`, `unknown`, `not-listed`, and `recognized-unsupported`;
- `EvidenceState`: all 15 D01 evidence labels, including `documented-versioned`, `model-selected`,
  `contradiction`, `pending-observation`, and `blocked-paid-observation`; and
- `UncertaintyState`: `known`, `conditional`, `unknown`, or `contradiction`.

IDs are open rather than a closed vendor union, but runtime validation requires stable alphanumeric
segments separated only by `.`, `_`, `:`, `/`, or `-`. This excludes whitespace, controls, and
ambiguous empty segments while leaving room for namespaced extensions. D01 supplies the current
canonical eight format IDs, eight profile IDs, and nine surface IDs. Conformance data and profile
registries enforce the supported set. In particular, the four Copilot surfaces and the Cursor
IDE/CLI surfaces remain distinct.

The B02 positive example is a deliberately small projection of D01. It proves the relevant
relationships without duplicating the entire research catalog:

- [`profile-catalog.valid.json`](../../packages/core/test/fixtures/profile-catalog.valid.json) maps
  `agents-markdown` to both Codex CLI and Copilot VS Code;
- it retains the Copilot description-only contradiction with two alternatives; and
- it retains Cursor Agent CLI legacy-rule support as `unknown`, not `false`.

The fixture uses D01's canonical IDs and snapshot identifiers. The exhaustive unit test separately
locks all D01 state vocabularies and surface distinctions.

## Claims and uncertainty

Every `SupportClaim` contains all of the following:

- a support state;
- one or more evidence-state labels;
- one or more source IDs from the selected spec snapshot; and
- an explicit uncertainty object.

Uncertainty is a discriminated union:

- `known` has no conditions or alternatives;
- `conditional` has at least one unique condition;
- `unknown` has a reason; and
- `contradiction` has a reason and at least two named alternatives.

A claim cannot infer certainty from missing data. Unknown and `not-listed` support must use unknown
or contradictory uncertainty, conditional support must use conditional or contradictory uncertainty,
and contradictory evidence must preserve a contradiction. Evidence such as `model-selected`,
`not-listed`, or `pending-observation` cannot be labeled `known`.

Surface-wide claims use `SurfaceCapabilityClaim`, which requires a `specSnapshotId`. This is
intentionally stricter than looking up evidence across all snapshots listed on a surface: source IDs
resolve only inside the claim's selected snapshot. A format relationship already selects exactly one
snapshot, so its recognition and capability claims inherit that unambiguous evidence boundary.

## Snapshots and provenance

A snapshot can cover several profiles and surfaces when a source is a shared support matrix. Both
directions of every relationship are validated:

- a profile lists each owned surface;
- a surface lists each selected snapshot;
- a snapshot lists every covered surface and that surface owner's profile; and
- a format relationship selects a snapshot that covers its surface.

Each source has a stable ID and an explicit provenance kind:

- `immutable` requires an absolute HTTPS URL without credentials and a revision;
- `living` requires the same constrained HTTPS URL, retrieval date, and a mutable-source reason; and
- `observation` requires a canonical, non-root `RepositoryRelativePath` for a repository-owned
  artifact and may also retain a constrained HTTPS source URL.

Source IDs must be unique inside a snapshot. Dates use strict `YYYY-MM-DD` calendar validation,
including round-trip validation that rejects normalized values such as `2026-02-31` while accepting
real leap days.

## Runtime validation

Use the validator at an untrusted JSON boundary:

```ts
import { validateProfileCatalog } from "@agent-context/core";

const result = validateProfileCatalog(JSON.parse(input));
if (!result.ok) {
  for (const issue of result.issues) {
    console.error(`${issue.path}: ${issue.message}`);
  }
}
```

`validateProfileCatalog` is pure, synchronous, and performs no filesystem, environment, or network
access. Before reading contract fields, it applies the shared strict canonical-JSON preflight. The
preflight rejects non-finite numbers, negative zero, non-JSON values, cycles, accessors, proxies,
exotic prototypes, non-enumerable properties, sparse arrays, and noncanonical array indices. It
inspects arrays by own keys rather than declared length and uses an iterative, depth-bounded
traversal.

Validation retains at most 255 ordinary issues. If another issue is discovered, the validator
appends one final `resource-limit` sentinel at `$` and stops. The returned array then has exactly
the public `MAX_VALIDATION_ISSUES` bound of 256 entries. Ordering is stable for identical input.
`invalid-json` and `resource-limit` are public `ProfileCatalogValidationCode` values;
`VALIDATION_ISSUE_LIMIT_CODE` names the sentinel code. `isProfileCatalog` provides a type guard for
callers that only need a Boolean result. See the
[profile-catalog runtime API](../api/profile-catalog.md) for complete ingress and resource-bound
behavior.

The v0 validator is closed at every object level. It rejects unknown fields, duplicate IDs,
malformed states, invalid source forms, broken references, wrong capability scopes, ambiguous
evidence references, and duplicate surface/format pairs. See
[`profile-catalog.invalid.json`](../../packages/core/test/fixtures/profile-catalog.invalid.json) for
intentional failures including vendor activation embedded in syntax, unknown support mislabeled as
known, and invalid calendar dates.

B02 does not publish JSON Schema. B04 owns the first schema-backed diagnostic contracts and B05 owns
machine-output schema versions; adding an overlapping schema here would create two compatibility
authorities. The TypeScript model, runtime validation behavior, and examples are the B02 public
contract until that schema layer is established.

## Versioning

The catalog contract is independently identified as `0.1.0` and is shipped as part of the stable
`1.0.0` product release. Compatible clarifications require corresponding fixtures and tests.
Removing a field or state, adding a required field, changing relationship semantics, or changing
uncertainty interpretation requires the contract review and migrations defined by the compatibility
policy.

The contract identity is not the product release identity; package and product release notes use the
repository's SemVer release (`1.0.0` here).
