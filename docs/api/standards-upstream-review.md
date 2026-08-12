# Upstream standards review artifacts

H11 converts two independently verified H10 snapshot pairs into three deterministic maintainer
artifacts. They are draft review inputs, not linter output, runtime configuration, compatibility
metadata, a knowledge pack, TUF metadata, a patch, or publication authorization. They are ignored by
all packaged end-user commands.

## Draft review JSON v1

`upstream-review.v1.json` follows
[`upstream-review.v1.schema.json`](../../tools/standards/schemas/upstream-review.v1.schema.json). It
binds the baseline and candidate source/provenance artifact hashes, retrieval dates, catalog hash,
generator version, and fixed resource limits. All six official source identities and URLs remain in
catalog order.

Each selected section is classified only as byte-normalized text `changed` or `unchanged`. A source
whose raw page changed outside the selected sections is explicitly `raw-only-change`. Those labels
are hash comparisons, not semantic conclusions. The artifact always contains:

- `status: draft-human-review-required`;
- `semanticAssessment: not-performed`;
- `publicationAuthorized: false`.

Changed sections include their old and new SHA-256 values, complete line counts, equal-prefix and
equal-suffix counts, changed-window sizes, and at most 48 evidence lines from each side. Each
evidence line has a one-based source line, SHA-256 over its complete UTF-8 line plus LF, complete
byte count, omitted byte count, and an ASCII-escaped prefix capped at 512 input bytes. Large windows
are marked `evidenceTruncated`; complete review uses the bound H10 snapshot, never the preview
alone.

`bounded-lines-v1` deliberately does not infer moved text, fields, precedence, activation,
deprecation, support, runtime behavior, security impact, or compatibility. It is a deterministic
review locator rather than a natural-language interpreter.

## Fixture-update scaffold JSON v1

`upstream-fixture-scaffold.v1.json` follows
[`upstream-fixture-scaffold.v1.schema.json`](../../tools/standards/schemas/upstream-fixture-scaffold.v1.schema.json).
It is bound to the review SHA-256 and contains one pending entry per changed selected section. Every
entry starts with empty `semanticClaims` and empty `fixtureOperations`; the closed schema requires
both arrays to remain empty in the generated draft. It names four follow-up requirements: human
semantic review, repository-owned synthetic fixtures, profile conformance tests, and recorded
provenance/unknowns.

The scaffold never edits a fixture. A maintainer creates separately reviewed fixture changes only
after deciding what the documentation does and does not establish. Client-observed behavior remains
conditional or unknown unless separately pinned evidence supports it.

## Human-readable Markdown

`upstream-review.v1.md` is deterministically regenerated from the two JSON artifacts. Remote text is
shown only as indented, ASCII-escaped evidence with line hashes; control, bidi, and non-ASCII code
points use `\u{...}` notation. The document repeats the non-claim and no-publication banner and
binds both JSON hashes.

## Offline replay

Replay reruns H10 verification on both input pairs, regenerates all three H11 artifacts, and
requires byte equality. All input paths must be canonical, non-symlinked, single-link regular files
within the documented size limits. Replay does no DNS, HTTP, command execution, fixture write, Git
operation, or external-service mutation.

The contract is repository-private maintainer tooling in v1. Changing its versions, limits,
classification labels, or canonical bytes requires new golden evidence and review.
