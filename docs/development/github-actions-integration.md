# Reusable GitHub Action development

The repository ships a reusable action, but intentionally does not run that action from a
repository-owned GitHub workflow. Consumers choose whether to run it in their own automation and
must review/pin the release commit themselves. Local development and release verification use the
checked-in bundle and no hosted runner.

## Bundle contract

`action/action.yml` is the Node 24 metadata contract. `scripts/build-github-action.mjs` compiles the
production scan into `action/dist/index.js`, copies the immutable standards and Git-runtime assets,
and audits the closed bundle. `action:check` performs two deterministic builds and compares the
bundle, notices, asset inventory, and canonical metafile bytes. It rejects symbolic links, stale
private modules, missing assets, test seams, and production/network capability drift.

Run the local checks with the pinned toolchain:

```sh
pnpm action:build
pnpm action:check
pnpm test:ci
pnpm verify:local -- --report local-gate-report.json
```

The action tests execute the built artifact against synthetic read-only fixtures. They verify input
boundaries, SARIF validation and escaping, annotation limits, changed-mode fallback behavior,
operational failure handling, and the absence of repository mutation. The local action-metadata
validator rejects mutable runtimes, extra inputs/outputs, duplicate YAML keys, identity drift, and
unreviewed root fields.

## Consumer requirements

Consumers should use an ordinary `pull_request` event for forked changes, never
`pull_request_target`, and should pass no secrets to the action. Pin checkout and action references
to full reviewed commit SHAs. Give the calling job only `contents: read`, fetch complete history
when changed mode is enabled, and keep the action checkout separate from the untrusted scan target.
The complete consumer example is in [the user CI guide](../user/ci.md), while the output and path
boundary are covered by [the security guide](../security/github-actions-integration.md).

This project does not claim that local tests reproduce a consumer's runner annotations or branch
protection. Those are consumer-side integration properties and must be reviewed in the consumer's
repository if they choose to use the action.
