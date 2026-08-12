# Local release soak and rollback rehearsal

`release-soak.mjs` is a small, offline rehearsal for the K11 release process. It repeatedly runs a
fixed packaged-CLI smoke set against a disposable or operator-selected workspace, then runs the same
set with the previous verified artifact as a rollback check. It records bounded exit status, byte
counts, SHA-256 digests, timeout/output-limit flags, artifact identities, and workspace before/after
digests. It never records command output or repository contents.

This is deliberately a local rehearsal. A successful run is **not** the K11 acceptance evidence: it
does not compress the required seven-day soak, prove a published npm release or provenance, prove
cross-platform behavior, replace external adjudication, or establish an on-call owner. Keep the
report with the `1.0.0` release evidence and complete the remaining K03–K10 gates before claiming
G8.

## Inputs and invariants

The harness requires two already verified K10 release bundles:

- `--candidate-bundle` is the newer candidate;
- `--previous-bundle` is an older, distinct release; and
- `--candidate-cli` and `--previous-cli` are regular files inside their respective bundles.

The release-artifact verifier checks every bundle before execution. The candidate version must be
strictly newer than the previous version, and the complete bundle digests must differ. The CLI
entrypoints are executed by the current Node runtime with fixed arguments; no shell, package
manager, Git command, user command, registry, credential, or network request is supplied by the
harness.

The workspace must be an existing real directory. The fixed smoke cases are:

1. `--help` (non-empty terminal output);
2. `list . --format json` (valid JSON); and
3. `scan . --format json --fail-on never` (valid JSON).

Each case runs for both phases, in order:

1. candidate iterations; then
2. rollback iterations using the previous CLI.

The default is three iterations, a 10-second per-command deadline, and a 120-second total deadline.
The hard limits are 32 iterations, 30 seconds per command, 300 seconds total, 64 KiB per process
stream, and a 512 KiB canonical report. The workspace inventory is bounded to 10,000 regular files
and 512 MiB. Its digest includes every in-root regular file's bytes and mode plus every directory's
relative path and mode, so empty-directory creation/removal and directory-mode changes are also
detected. A timeout, output overflow, non-zero exit, malformed JSON, denied capability, or workspace
mutation is a P1 finding and fails the rehearsal. The previous phase is skipped after workspace
mutation because rollback would no longer be trustworthy.

The child environment is intentionally minimal (`HOME`, `TMPDIR`, locale, `PATH`, and `CI`) and a
preload denies common network, DNS, fetch, and child-process APIs. This is a defense-in-depth
preflight, not a security sandbox: it cannot prove that arbitrary future code is unable to bypass a
Node preload. Release code still requires the separate packaging, security, hosted, and publication
gates.

## Run

Prepare a payload that includes the exact CLI entrypoint, generate two K10 bundles, and create an
empty report directory. The output path must be outside the workspace and must not already exist.

```sh
node scripts/release-soak.mjs run \
  --candidate-bundle "$PWD/artifacts/1.0.1" \
  --previous-bundle "$PWD/artifacts/1.0.0" \
  --candidate-cli "$PWD/artifacts/1.0.1/cli.js" \
  --previous-cli "$PWD/artifacts/1.0.0/cli.js" \
  --workspace "$PWD/fixtures/soak-workspace" \
  --output "$PWD/artifacts/soak/1.0.1.json" \
  --iterations 3
```

The equivalent package script is `pnpm release:soak` with the same options. Exit status is:

- `0`: all bounded candidate and rollback smoke checks passed and the workspace digest was stable;
- `1`: execution produced one or more P1 findings; or
- `2`: input/configuration was invalid or an open P0/P1 finding was supplied.

The report format is closed by
[`release-soak-report.v1.schema.json`](../contracts/release-soak-report.v1.schema.json). It has
artifact and CLI digests, sanitized accepted-exception records (owner, due date, and rationale
digest), phase outcomes, and no stdout/stderr text. Verify the report itself is retained with the
same immutable candidate evidence; a report is not a signature or publication attestation.

## Accepted exceptions

Use `--findings` only for reviewed, bounded exception metadata. P0/P1 records must remain `open` and
block before any child starts. P2/P3 records must be `accepted` and include an accountable owner, a
due date, and a rationale. The report keeps the rationale digest rather than the rationale text:

```json
[
  {
    "id": "docs.example",
    "severity": "P2",
    "status": "accepted",
    "owner": "maintainer",
    "dueDate": "2026-09-01",
    "rationale": "Documentation-only exception with a tracked follow-up."
  }
]
```

Do not use an exception record to waive a safety failure, a missing artifact verification, a
workspace mutation, or a P0/P1 release blocker. Those conditions remain fail-closed.

## What remains for K11/G8

The rehearsal demonstrates that local candidate/rollback mechanics are wired and that a bounded
failure cannot be mistaken for a pass. It does not start or simulate seven days, and it does not
modify either release bundle or any external repository. K11 still requires the actual RC to pass
all prerequisite gates, a retained seven-day soak with only release-blocking fixes, zero open P0/P1
defects, documented accepted P2/P3 exceptions with owners/dates, and the reviewed rollback/on-call
procedure. K12 publication and K13 post-release review remain separate gates.
