# Reusable GitHub Action security boundary

The repository's action is a consumer-side reporting boundary, not a repository-owned workflow or
GitHub API client. The release repository runs no hosted workflow. A consumer that adopts the action
must supply the ordinary `pull_request` event, read-only permissions, trusted release pins, and
separate trusted-action and untrusted-target checkouts.

## Consumer checkout rules

Use a trusted base checkout for the action and an explicitly selected target checkout for the files
being scanned. Pin both checkout and action references to full commit SHAs, set
`persist-credentials: false`, and use immutable event SHAs rather than branches, tags, or
remote-tracking names. Never use `pull_request_target`, `workflow_run`, secrets, write permissions,
artifact uploads, caches shared with privileged jobs, or `NODE_OPTIONS` sourced from the target.

The action metadata is closed to the exact Node 24 entry point, five bounded inputs, and no outputs
or pre/post scripts. `scripts/check-action-metadata.mjs` validates that contract locally. The bundle
builder performs the capability audit and exact byte comparison; `action/test/index.test.mjs`
exercises hostile paths, SARIF, annotations, changed-mode fallback, and operational failures.

## Output boundary

The action accepts only the validated SARIF document produced by the same scan invocation whose exit
status is returned. It enforces closed fields, rule/result relationships, provenance, fingerprints,
canonical repository-relative paths, Unicode safety, message limits, and the 1–50 annotation
ceiling. Workflow-command values are escaped after validation. Operational failures use fixed text
and never echo captured repository-controlled output. No SARIF, source, patch, credential, or
artifact is uploaded by the action.

These checks establish the reusable artifact's local contract. They cannot prove the consumer's
branch protection, runner image, permissions, or review configuration; the consumer owns that
integration decision.
