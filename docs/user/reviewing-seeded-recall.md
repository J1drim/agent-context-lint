# Reviewing the seeded recall corpus

Maintainers review the committed fingerprint evidence without exposing or copying scenario source
content into review records.

First confirm that the production scheduler reproduces the committed evidence:

```sh
pnpm seeded-recall:check
node tools/seeded-recall/reviewer.mjs validate \
  calibration/seeded-recall/v0/corpus.json \
  calibration/seeded-recall/v0/report.json
```

Create a worksheet on standard output and deliberately save it:

```sh
node tools/seeded-recall/reviewer.mjs worksheet \
  calibration/seeded-recall/v0/corpus.json \
  calibration/seeded-recall/v0/report.json > calibration-review-worksheet.json
```

Fill every `label` and matching `reason`. Then create each primary review on standard output:

```sh
node tools/seeded-recall/reviewer.mjs review \
  calibration/seeded-recall/v0/corpus.json \
  calibration/seeded-recall/v0/report.json \
  calibration-review-worksheet.json reviewer-a primary > reviewer-a.json
```

Run `validate` again with the saved review path. This rereads the persisted artifact through the
bounded repository reader and proves that it still binds the current report. The v0 validator keeps
distinct role IDs so it can reconstruct disagreement; these IDs are artifact identities, not a
requirement for two human approvers. The accountable maintainer performs the sole human review and a
separate audit agent independently verifies the exact artifact and arithmetic.

Saved input JSON must be UTF-8 with the exact normalized representation emitted by the tool:
two-space indentation and one final newline. Duplicate keys, alternate whitespace, excessive
nesting, oversized files, traversal, and symlink escapes are rejected before review processing.

Adjudicate the persisted primary role records as follows:

```sh
node tools/seeded-recall/reviewer.mjs adjudicate \
  calibration/seeded-recall/v0/corpus.json \
  calibration/seeded-recall/v0/report.json reviewer-a.json reviewer-b.json > adjudication.json
```

If the summary reports unresolved cases, obtain an optional independent `tie-breaker` role record
and pass it as the final argument. The tool resolves only disagreements for which that fingerprint
label exists. Validate the exact saved adjudication and all role records before accepting it:

```sh
node tools/seeded-recall/reviewer.mjs validate-adjudication \
  calibration/seeded-recall/v0/corpus.json \
  calibration/seeded-recall/v0/report.json \
  adjudication.json reviewer-a.json reviewer-b.json [reviewer-c.json]
```

Validation reconstructs every ordered decision and summary count from those reviews and rejects a
stale report binding, reviewer mismatch, unneeded tie-breaker identity, duplicate or reordered
decision, or inconsistent resolution. Keep review artifacts outside the committed corpus unless the
release process explicitly calls for archiving them.
