# Reviewing metadata calibration diagnostics

The accountable K03 maintainer uses the K02 contracts to label every error and warning. The workflow
deliberately shows stable repository/rule/path/semantic/diagnostic fingerprints rather than copying
public repository source into this project.

1. Validate the selected corpus and fingerprint-only report.
2. Generate a worksheet to standard output.
3. The maintainer fills every `label` and `reason`, then creates a review bound to the committed
   maintainer-authority declaration; the command records its own completion time.
4. Generate and validate the adjudication from the exact report and maintainer review.
5. Generate and commit the precision evidence and native proof, then run the deterministic release
   replay gate against those exact artifacts.

Before starting a private capture, inspect the committed readiness state with the offline JSON
preflight. It reads only the repository-owned gate state and native-proof placeholder. Development
checkouts may also provide an implementation ledger for parity; the public release snapshot omits
that planning artifact and treats the schema-validated gate state as authoritative. The preflight
never opens the private bundle, starts a capture, or declares precision readiness. A pending state
exits successfully because this command is an observation, not the release gate:

```sh
node tools/metadata-calibration/gate-state.mjs --json
```

When an implementation ledger is present, it contains exactly one machine-readable parity marker,
for example `K03 gate-state status: \`feature-unavailable\``. Update that marker in the same change
as the gate-state artifact. The preflight ignores historical status prose and fails closed when the
marker is missing, duplicated, unsupported, or different from the schema-validated artifact. A
release checkout without the ledger skips this optional parity comparison.

The default command remains human-readable. Use `--release` only after the JSON state reports
`"status": "ready"`; it then requires the private review and exact packed-runtime environment and
runs the complete offline replay gate. `--json --release` is intentionally rejected so a status
projection cannot be mistaken for release evidence.

```sh
node tools/metadata-calibration/reviewer.mjs validate calibration/metadata/v0/corpus.json review/report.json
node tools/metadata-calibration/reviewer.mjs worksheet calibration/metadata/v0/corpus.json review/report.json "$K03_WORK_ROOT/private-review.json"
node tools/metadata-calibration/reviewer.mjs review calibration/metadata/v0/corpus.json review/report.json "$K03_WORK_ROOT/private-review.json" review/worksheet.json
node tools/metadata-calibration/reviewer.mjs adjudicate calibration/metadata/v0/corpus.json review/report.json "$K03_WORK_ROOT/private-review.json" review/maintainer.json
```

Persist stdout through an intentional caller-controlled step; the reviewer itself never writes a
file. Labels are `true-positive`, `false-positive`, `uncertain-client-behavior`, and
`test-harness-defect`. Reasons are closed and label-compatible. The maintainer must use `uncertain`
for undocumented/version-dependent client behavior rather than inventing semantics. A false positive
reason identifies classifier boundaries, evidence mismatch, threshold, or scope resolution so K03
can tune without test-set leakage.

The maintainer may inspect the pinned public repository separately under the approved K03 procedure,
but must not paste source into worksheets, create upstream changes, or contact maintainers. The K02
set is calibration data. It is not the K06 random ten-repository release trial.

K03 requires the accountable maintainer to review every emitted error and warning (at least 500
diagnostics total). The closed `k03-maintainer-authority.json` record fixes the actual maintainer
identity and the repository-owner merge acceptance boundary. Work from the private temporary bundle
and its read-only disposable checkout. Never run code from the checkout, install its dependencies,
edit it, or prepare an upstream change. Unknown client behavior stays uncertain rather than being
guessed into a true positive. A harness defect blocks release and requires repair plus a complete
recapture. Uncertain outcomes remain outside precision, but release permits at most 25 and at most
5% of all reviewed diagnostics.

The reviewer commands require the absolute mode-`0600` private bundle for worksheet, review,
adjudication, adjudication validation, and precision creation. Every boundary recomputes its
source-safe digest and re-verifies every frozen checkout; changing a message, location, evidence
item, checkout inventory, or unbound wrapper field invalidates the public report binding. Review and
adjudication commands generate their completion times internally. These values enforce ordering but
are not trusted timestamp attestations. The repository owner's intentional merge of the evidence PR
is the human acceptance boundary; this contract does not claim a cryptographic signature.

The final evidence reports raw counts, point precision, and two-sided 95% Wilson bounds. Passing
requires the lower bound to reach 95% for default errors and 85% for default warnings. Confirmed
false positives used for tuning must cite the same rule and a synthetic regression test. Repository
content and the private bundle are never committed. The later random K06 repositories must remain
unknown throughout K03.

After committing neither private data nor checkout paths, use `reviewer.mjs precision` with the
byte-exact candidate, corpus, report, maintainer review, adjudication, and F16 files plus the
captured engine identity and a JSON-array tuning ledger to derive the final gate evidence. The
command prints only validated JSON to standard output; its full positional usage is available by
invoking the tool without arguments. For a non-empty tuning ledger, add `--pre-tuning` followed by
the exact pre-tuning report, maintainer review, and adjudication paths. Add `--pre-private` with the
absolute exact pre-tuning private bundle. The offline release gate reconstructs both pre- and
post-tuning adjudications and rechecks committed regression, final F16, packed-package, Node, Git,
guard, and rule-registry identities.

Run the final gate only through `pnpm metadata-calibration:precision:check` with the reviewed
absolute executable and extracted-package variables documented in the developer procedure. The gate
requires exact pnpm 11.18.0, immutable engine commit E, a clean evidence-only descendant A, two
byte-identical independent CLI/core rebuilds, successful execution of every cited regression, and a
fresh 69/69 F16 run. The pending state currently reflects missing native Darwin quota/confinement
proof and genuine adjudication; release replay remains unavailable until that committed proof has
been captured and validated.

Keep `$K03_WORK_ROOT`, its frozen checkouts, and `private-review.json` intact until the maintainer
review, precision generation, and the final gate have succeeded. After that success—and never
before—remove only those bound resources with the explicit cleanup command:

```sh
pnpm metadata-calibration:cleanup -- \
  calibration/metadata/v0/corpus.json \
  calibration/metadata/v0/report.json \
  "$K03_WORK_ROOT/private-review.json" \
  "$K03_WORK_ROOT" \
  --acknowledge-successful-final-k03-gate
```

The command validates the report/private digest, re-verifies every frozen checkout, and preflights
all exact work-root children before detaching or deleting anything. If it cannot prove ownership, it
retains the resource for quarantine and fails. Immediately before unlinking each image it performs a
final exact attachment inventory, including when the host mount identity was already restored;
inventory uncertainty or a remaining image-bound device retains the image for quarantine. The same
single fail-closed unlink helper covers provisioning failures, including wrapper failures that issue
no device. Its hdiutil inventory is unconditionally the last awaited operation before unlink.
