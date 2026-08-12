# Agent Context Linter action

This JavaScript action runs the release-bundled Agent Context Linter without installing packages,
executing repository scripts, contacting a service, or writing to the checkout. It emits at most 50
escaped GitHub workflow-command annotations from the linter's validated SARIF and preserves the CLI
exit contract: `0` is below threshold, `1` is a lint-policy failure, `2` is an operational failure,
and `130` is cancellation.

The calling job needs only `contents: read`. A consumer-owned workflow must never execute action
code from an untrusted pull-request checkout: pin this action to a reviewed full release commit SHA,
check out the exact head SHA with persisted credentials disabled, and keep the action source
separate from the scanned checkout. Changed mode also needs local merge-base history and an exact
immutable base object ID. Mutable branch, tag, and remote-tracking names are rejected. This release
repository supplies no hosted workflow; the examples below are integration guidance for a
consumer-owned workflow.

## Inputs

| Input               | Default   | Contract                                                                |
| ------------------- | --------- | ----------------------------------------------------------------------- |
| `working-directory` | `.`       | Repository-relative directory without `.`/`..` components or link trust |
| `changed`           | `false`   | Exact `true` or `false`; enables conservative I07 changed mode          |
| `base`              | empty     | Required with `changed`; exact lowercase 40/64-character Git object ID  |
| `fail-on`           | `warning` | `error`, `warning`, or `never`                                          |
| `max-annotations`   | `50`      | Decimal integer from 1 through 50                                       |

The wrapper intentionally exposes no fix, output-file, arbitrary-argument, package-version, token,
upload, network, or command input. Full SARIF remains available through the CLI for separately
reviewed integrations; this unprivileged action creates annotations directly and never requests
`security-events: write`. When changed mode must conservatively run the complete scan, the action
emits a fixed warning rather than hiding the fallback.

Annotation input must pass the repository's complete public SARIF v2 product validator before any
result is emitted. Artifact locations use only canonical repository-relative SARIF URI encoding and
reject C0/C1 controls, directional marks/overrides/isolates, and malformed Unicode. Repository-
controlled message text is sanitized with the shared output sanitizer. Validation always traverses
results beyond the annotation cap.

## Reuse from another repository

Pin both actions to reviewed full 40-character commit SHAs. Replace the placeholders with commits
from immutable release-specific tags; do not copy a mutable branch or major tag into a protected
workflow.

```yaml
permissions:
  contents: read

steps:
  - name: Check out source and merge-base history
    uses: actions/checkout@<REVIEWED_FULL_COMMIT_SHA> # reviewed release tag
    with:
      repository:
        ${{ github.event_name == 'pull_request' && github.event.pull_request.base.repo.full_name ||
        github.repository }}
      ref:
        ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha
        }}
      fetch-depth: 0
      persist-credentials: false
  - name: Scan agent context
    uses: <OWNER>/<REPOSITORY>/action@<REVIEWED_FULL_COMMIT_SHA> # immutable v1.x.y release
    with:
      base: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || '' }}
      changed: ${{ github.event_name == 'pull_request' }}
      fail-on: warning
      max-annotations: "50"
```

Use `pull_request`, not `pull_request_target`, for untrusted fork code. Do not pass secrets or add a
write token: the action does not need either. A protected workflow should also retain a bounded job
timeout and concurrency cancellation. The wrapper validates all SARIF results even after the
annotation cap; `max-annotations` limits emission, not validation.

Release maintainers rebuild `dist/index.js`, `bundled/`, `git-runtime/`, and `THIRD_PARTY_NOTICES`
with `pnpm action:build`. `pnpm action:check` independently rebuilds and byte-compares the complete
committed distribution. It performs two independent bundle builds and compares bundle, notice, and
canonical metafile bytes; audits out internal Git test seams and requires production executor
markers; and rejects symbolic or non-ordinary committed bundles, notices, and asset-tree roots. The
build runs TypeScript with the current exact Node executable and is verified separately by
`pnpm test:action-clean-install` from a fresh frozen `--no-runtime` installation.
