# Local supply-chain security controls

The release repository intentionally has no GitHub-hosted security workflow. Its blocking controls
run locally through `pnpm check` and are reported in the reviewable local-gate result. This keeps
private-repository verification free while preserving deterministic, fail-closed checks.

## Blocking local controls

- `pnpm install --frozen-lockfile --no-runtime` verifies the locked dependency graph without running
  lifecycle scripts or silently selecting a managed runtime.
- `pnpm licenses:check` validates the installed tree against the reviewed SPDX allowlist and carries
  required notices into package artifacts.
- `pnpm security:validate` validates the closed secret-scan baseline, dependency-free adjudicator,
  weekly npm-only Dependabot policy, and the absence of hosted workflow definitions.
- `pnpm test:security` exercises secret adjudication, project/dependency licensing, and the local
  security policy.
- `pnpm pack:check` performs the clean package inventory, bundle audit, and reproducibility checks.
- `pnpm action:check` verifies the reusable action without executing a workflow or uploading data.

The exact report contains status, commit, lockfile digest, toolchain identities, timing, and exit
information only. It never retains raw secret-scan output, repository source, credentials, or a
SARIF artifact.

## Secret adjudication

[`config/secret-scan-baseline.v1.json`](../../config/secret-scan-baseline.v1.json) is a closed,
sorted set of exact records. Each entry contains only a domain-separated fingerprint, canonical
path, exact detector, and mandatory human-review reason. It cannot express glob, directory,
detector-wide, repository-wide, or raw-value ignores. The local
[`adjudicate-secret-scan.mjs`](../../scripts/adjudicate-secret-scan.mjs) loads only Node built-ins,
rejects malformed/oversized JSON, and fails closed on scanner errors or unadjudicated results.

## Dependency updates

Dependabot remains enabled only for the root npm/pnpm graph on a weekly schedule. The project has no
GitHub Actions dependency update target because it has no committed workflows. Every dependency
change still requires the frozen lockfile, license policy, focused tests, complete local gate, and a
human review.

## Hosted services are optional, not hidden

CodeQL, dependency review, registry advisory services, hosted secret scanning, SBOM upload, and
GitHub branch protection are not represented as passing checks here. A consumer or organization may
add them in its own repository, but must treat their results as separate evidence and must not
replace the local gate with an unavailable service.
