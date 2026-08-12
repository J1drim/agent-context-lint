# Package-install matrix evidence

K09 keeps the executable package-manager matrix separate from its retained release evidence. The
matrix runner (`scripts/check-package-install-matrix.mjs`) performs the clean-consumer install and
returns a bounded `0.1.0` report. The evidence helper converts that report into the closed
`agent-context-package-install-matrix-v1` contract in
`docs/contracts/package-install-matrix-report.v1.schema.json`.

## Canonical report

`createPackageInstallMatrixEvidence(rawReport)` accepts only the runner's exact raw shape and
returns canonical JSON with:

- the exact Node version and ordered, unique selected managers;
- one state per selected manager (`passed`, `unavailable`, `blocked`, or `failed`);
- the manager `runtime` attestation (`node` for npm/pnpm/Yarn, `native` for Bun) and, for new strict
  passed entries, the exact selected Node version observed from its `--version` probe;
- the observed `managerVersion` for configured managers when the runner completed its bounded
  version probe (strict `major.minor.patch`);
- only bounded failure reason codes, not package-manager paths, stderr, or environment values;
- SHA-256 identities for the CLI and core tarballs and the installed manifests;
- the fixed offline/no-credentials/no-mutation policy and explicit size limits; and
- `reportSha256`, calculated over the canonical report with its digest field removed.

The validator rejects unknown fields, duplicate managers, manager-order drift, malformed or equal
tarball digests, inconsistent state/reason pairs, unsupported Node releases that claim anything
other than `blocked`, and a changed report digest. `replayPackageInstallMatrixEvidence` recomputes
the digest and returns the passed, unavailable, blocked, and failed manager partitions. Its
`success` and `releaseReady` values are true only for a strict report in which every selected
manager passed on Node `^24.11.0 || ^26.0.0`. An unavailable manager is an evidence gap, not a pass;
a non-strict exploratory report cannot authorize release.

Expected tarball or Node identities can be supplied to
`validatePackageInstallMatrixEvidence(report, { expectedTarballs, nodeVersion })` when replaying a
report beside a separately retained artifact. The helper compares the identities but never opens a
tarball, runs a package manager, resolves `PATH`, or makes network requests.

The runner probes the selected absolute Node executable with `--version` before any manager. npm,
pnpm, and Yarn launchers are then passed as scripts to that exact Node; Bun is intentionally the
only native manager exception. A Node probe failure is retained as `node-runtime-probe-failed`,
`node-runtime-invalid`, or `node-runtime-mismatch`; an unsupported runtime is
`node-engine-mismatch`. The runner then probes every configured manager with `--version`. A failed
process probe is retained as `manager-version-probe-failed`; non-semver output is retained as
`manager-version-invalid`. pnpm still carries its compatibility `expectedPnpmVersion` and
`observedPnpmVersion` fields. Older v1 reports may omit `runtime`, `nodeVersion`, and
`managerVersion` and remain replayable when they are not new strict passed evidence; new strict
reports require the runtime and Node attestation fields for every passed manager.

## CLI conversion and replay

Convert a raw matrix JSON file and retain the canonical report with exclusive creation:

```sh
node scripts/package-install-matrix-evidence.mjs \
  --input /absolute/path/matrix-raw.json \
  --output /absolute/path/matrix-evidence.json \
  --format terminal
```

The input is bounded to 64 KiB and must be a regular non-symlink file. The output is canonical,
bounded to 64 KiB, mode `0600`, and is never overwritten. Supplying `--expected-cli-sha256` and
`--expected-core-sha256` binds the retained report to the exact packed tarball identities. JSON
output is suitable for a separate append-only evidence store:

```sh
node scripts/package-install-matrix-evidence.mjs \
  --input /absolute/path/matrix-raw.json \
  --expected-cli-sha256 <64-lowercase-hex> \
  --expected-core-sha256 <64-lowercase-hex> \
  --format json
```

The command exits `0` only when the replay is release-ready. Valid pending, blocked, exploratory, or
strict-gap reports are emitted and exit `2`; malformed, tampered, or unsafe inputs also exit `2`.
This distinction prevents a retained unavailable-manager report from being mistaken for a successful
K09 gate.

The schema and runtime validator are intentionally redundant. JSON Schema provides a portable closed
shape for independent tooling; the runtime validator enforces cross-field relationships and the
canonical digest that JSON Schema cannot express.
