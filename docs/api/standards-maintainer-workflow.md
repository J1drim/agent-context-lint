# Local standards maintenance contract

The standards maintenance contract is local and review-only. The release repository contains no
scheduled or manual GitHub workflow for fetching upstream pages, opening pull requests, uploading
artifacts, or staging publication. A maintainer runs the bounded H10 snapshotter and H11 review
generator on a trusted workstation and supplies the resulting evidence to the human review.

## Capture and replay

`tools/standards/upstream-snapshotter.mjs` is the only network-capable step. It uses the compiled
allowlist, explicit `--acknowledge-network`, bounded responses, canonical JSON, and sanitized
provenance. `verify` is offline and recomputes every source/provenance digest and selected section.

`tools/standards/upstream-review.mjs` accepts two verified snapshots and creates a new local review
directory. It records bounded line evidence and hashes, never interprets semantics, executes input,
invokes Git, contacts a repository, or edits a fixture. Its replay command is offline and
byte-exact.

For recurring local polling, use `pnpm standards:weekly -- --acknowledge-network --fail-on-change`.
It retains baseline and candidate snapshots outside the repository, emits the same bounded review
artifacts, and requires explicit `pnpm standards:weekly:accept` after human review.

```sh
pnpm standards:snapshot -- --output-dir /private/path/candidate --acknowledge-network
pnpm standards:snapshot:verify -- \
  --source /private/path/candidate/upstream-source.v1.json \
  --provenance /private/path/candidate/upstream-provenance.v1.json
pnpm standards:review -- \
  --baseline-source /private/path/baseline/upstream-source.v1.json \
  --baseline-provenance /private/path/baseline/upstream-provenance.v1.json \
  --candidate-source /private/path/candidate/upstream-source.v1.json \
  --candidate-provenance /private/path/candidate/upstream-provenance.v1.json \
  --output-dir /private/path/review
pnpm standards:review:verify -- \
  --baseline-source /private/path/baseline/upstream-source.v1.json \
  --baseline-provenance /private/path/baseline/upstream-provenance.v1.json \
  --candidate-source /private/path/candidate/upstream-source.v1.json \
  --candidate-provenance /private/path/candidate/upstream-provenance.v1.json \
  --review /private/path/review/upstream-review.v1.json \
  --scaffold /private/path/review/upstream-fixture-scaffold.v1.json \
  --markdown /private/path/review/upstream-review.v1.md
```

## Human boundary

A changed section is evidence, not an instruction to change the linter. The maintainer opens the
bound raw and normalized snapshots as untrusted data, determines meaning manually, records
ambiguity/version dependence, reproduces accepted behavior in repository-owned synthetic fixtures,
runs affected conformance tests, and attaches the bounded review to the change. No command grants
publication, signing, lock activation, or permission to modify an external repository.

Run the standards-tool tests and complete local gate before accepting an update:

```sh
pnpm test:standards-tools
pnpm verify:local -- --report local-gate-report.json
```

The evidence files stay outside the repository unless a reviewed rule/fixture change is accepted.
Never commit raw upstream response bytes, credentials, private repository content, or an
unreviewed/generated pack.
