# Local release evidence for K12 and K13

`release-evidence.mjs` is an offline, fail-closed evidence formatter for the final release
milestones. It has two subcommands:

- `monitor` validates a local K12 smoke/rollback observation; and
- `retrospective` validates the data prepared for the 72-hour review and 30-day retrospective.

Both commands read one operator-created JSON file and write one new canonical JSON report. They do
not publish packages, query npm or GitHub, follow URLs, execute a command from the input, read
credentials, or contact a repository. Every narrative/output value is reduced to a byte count and
SHA-256 digest. Unknown external observations remain unknown; they are never converted to a pass.

The report formats are closed by
[`release-monitoring-report.v1.schema.json`](../contracts/release-monitoring-report.v1.schema.json)
and
[`release-retrospective-report.v1.schema.json`](../contracts/release-retrospective-report.v1.schema.json).
The local reports are evidence preparation only. They do not establish npm provenance, signatures,
publication, an on-call owner, 72 hours of operation, 30 days of operation, or human acceptance.

## K12 monitor input

The input must use `schemaVersion: 1` and `mode: "offline-local"`. It must name a newer release and
a distinct previous artifact, and it must include checks with the IDs `install`, `registry`, `docs`,
`action`, and `rollback`. A check has `pass`, `fail`, or `unknown` status and a bounded duration.
Failed and unknown checks require an evidence object. Evidence can be supplied as text or as a
precomputed `{ "bytes": number, "sha256": "..." }` object; reports retain only the latter.

The policy is intentionally fixed:

```json
{
  "networkAccess": "not-used",
  "credentials": "none",
  "repositoryMutation": "not-observed"
}
```

An all-pass local input produces `preflight-ready`, but its report still says
`publicationVerification: "pending-external"` and `monitoringDuration: "not-established"`.
Missing/unknown registry, documentation, action, or rollback observations produce
`pending-external`. A failed check, failed rollback, or triggered P0/P1 signal produces `blocked`.

Example invocation (the output file must not already exist and must be outside the input
repository):

```sh
node scripts/release-evidence.mjs monitor \
  --input "$PWD/evidence/k12-input.json" \
  --output "$PWD/evidence/k12-report.json"
```

The equivalent package script is `pnpm release:evidence:monitor -- --input ... --output ...`. Exit
status is `0` for a local preflight-ready report, `1` for a blocked report, and `2` for pending
external evidence or invalid input. A successful local status is not K12 acceptance.

## K13 retrospective input

The retrospective input contains `releaseAt`, `review72h`, and `retrospective30d` periods. A
complete 72-hour period must have an observation at least 72 hours after `releaseAt`; a complete
30-day period must be at least 30×24 hours after it. Pending periods intentionally omit
`observedAt`. Metrics are bounded and unit-labelled (`count`, `milliseconds`, `ratio`, or
`percent`), and every metric carries redacted evidence. Incidents and roadmap decisions require an
owner, a due date, and hashed summaries/rationales. Open P0/P1 incidents block the report.

```sh
node scripts/release-evidence.mjs retrospective \
  --input "$PWD/evidence/k13-input.json" \
  --output "$PWD/evidence/k13-report.json"
```

`ready-for-human-review` means that both supplied timestamps and local records satisfy the schema;
it does not mean the 72-hour or 30-day review occurred, that publication was verified, or that the
sole maintainer accepted the findings. A pending period returns `pending-external`; an open P0/P1
incident returns `blocked`. Follow-ups remain ordinary project work and must be carried into the
implementation ledger by the maintainer.

## Redaction and hostile-input rules

Unknown object fields, duplicate IDs, unsafe paths, malformed timestamps/digests, control
characters, oversized values, private-key headers, and common `token=`, `password=`, `secret=`, or
`authorization:` forms are rejected. The tool never stores or prints the input path, raw narrative,
stdout, stderr, URL, environment, command, or credential. Reports use canonical UTF-8 JSON and a
`reportSha256` digest over the report without that field, so the same input produces byte-identical
evidence on another machine.

Run the focused contract suite with:

```sh
node --test scripts/release-evidence.test.mjs
```

The suite covers deterministic serialization, schema validation, pending/blocked states, period
boundaries, duplicate and malformed records, credential-like input, report tampering, and closed CLI
argument parsing. The tool is deliberately not a network monitor. Use the approved release operator
workflow to collect external registry/action/docs signals, then import only sanitized digests after
human review.
