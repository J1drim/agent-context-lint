# CI integration

This release repository deliberately has no GitHub-hosted workflow. Private-repository Actions
minutes are therefore never consumed by the project. Contributors run the same deterministic gate
locally and provide its bounded report for review.

## Contributor gate

Install the documented hook once per checkout:

```sh
pnpm install --frozen-lockfile
pnpm hooks:install
```

Run the complete gate before pushing and keep the generated report for the reviewer:

```sh
pnpm verify:local -- --report local-gate-report.json
git push
```

The command runs `pnpm check`, writes a private machine-readable copy to
`.git/local-gate-result.json`, and writes the requested review copy. The pre-push hook accepts a
push only when the report is successful for every pushed commit and matches the current
`pnpm-lock.yaml` digest. A changed commit or lockfile requires a fresh run. The hook is a local
convenience and can be bypassed by Git itself; reviewers should require the report and reject a push
made with `--no-verify` or without a current report.

To remove the hook from the current checkout:

```sh
pnpm hooks:uninstall
```

The report contains only command status, tool versions, commit identity, lockfile digest, timing,
and exit information. It does not include repository instruction text, diagnostics, or credentials.

## Optional reusable GitHub Action

The repository still ships a reusable action for consumers that choose to run it in their own
automation. The bundled action emits bounded inline annotations from validated SARIF and requests
only `contents: read`; it does not upload SARIF or expose a token, fix, network, package-version, or
arbitrary-command input. Pin both the checkout and action references to full reviewed commit SHAs:

```yaml
permissions:
  contents: read

steps:
  - name: Check out source and merge-base history
    uses: actions/checkout@<REVIEWED_FULL_COMMIT_SHA>
    with:
      fetch-depth: 0
      persist-credentials: false
  - name: Check agent context
    uses: <OWNER>/<REPOSITORY>/action@<REVIEWED_FULL_COMMIT_SHA>
    with:
      changed: ${{ github.event_name == 'pull_request' }}
      base: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || '' }}
      fail-on: warning
      max-annotations: "50"
```

For fork pull requests use the ordinary `pull_request` event, not `pull_request_target`, and do not
pass secrets. See [GitHub Actions integration security](../security/github-actions-integration.md)
and [action metadata](../../action/README.md) for the complete consumer boundary.

## Scan exit codes

- Exit `0` means the selected threshold was not met.
- Exit `1` means a completed scan found a diagnostic at or above the threshold.
- Exit `2` means usage or operational failure.
- Exit `130` means cancellation by `SIGINT`.

An action annotation is not an approval or a code-review decision. Keep reports local or attach only
the bounded local-gate report to a review; never expose repository-controlled instruction text or
credentials.
