# Ownership and review governance

Status: normative for the stable `v1.0.0` release

Owner: accountable maintainer (future governance aliases are inactive)

Review cadence: quarterly and at every release freeze

This document defines who is accountable for each repository area, which
automated and audit evidence is required, and how the controls in
`.github/CODEOWNERS` can become enforceable. It implements ticket A10 from the
production implementation plan.

## Current operating mode: sole maintainer

The current repository has one accountable human maintainer. That maintainer's
documented review, the automated gates, and an independent audit by a different
agent are sufficient for implementation and release acceptance. The agent audit
is quality evidence, not a second human approval. No second human reviewer or
minimum team membership is a v1.0.0 prerequisite.

The team aliases, review matrix, and remote ruleset procedure below are retained
as an explicitly inactive future multi-maintainer profile. They must not be read
as current acceptance requirements. If that profile is activated later, record
the activation decision and update this section before relying on its additional
roles.

The aliases currently use the placeholder organization
`@agent-context-lint`. They are valid CODEOWNERS tokens but are intentionally
not assumed to exist. **A repository administrator must complete the activation
procedure below before enabling remote CI, accepting remote pull requests, or
publishing an artifact.** An unresolved alias is a release blocker, not a reason
to remove ownership from a path.

Normative terms such as MUST, MUST NOT, REQUIRED, and SHOULD are used in their
ordinary policy sense.

## Governance principles

- Every change has one directly responsible individual (DRI). In the current
  mode the accountable maintainer may review a change they authored; the exact
  commit still requires automated gates and a different agent's audit.
- A future multi-maintainer activation may require separation between author and
  approver, but that profile is inactive and is not a current human-review gate.
- Review follows the affected risk, not the contributor's team or the file's
  apparent size. Generated files, fixtures, and configuration can be high risk.
- A change that crosses domains requires the union of the reviews in the review
  matrix. One person who belongs to several teams may fill only one required
  review seat for a high-risk change.
- Ownership includes implementation, automated tests, user/developer
  documentation, operational evidence, and follow-up after release.
- Missing, inactive, invisible, or under-permissioned owners fail closed: the
  change does not merge and the product does not release.
- External GitHub repositories are read-only validation targets. Their owners
  are never contacted through this workflow and no branch, commit, patch, pull
  request, issue, or comment is prepared for them.

## Future multi-maintainer alias directory (inactive)

The future repository organization may use different slugs. Replace every
placeholder consistently; do not leave a mixture of old and new aliases.

| Placeholder alias | Accountable scope | Minimum active membership | Independence constraint |
|---|---|---:|---|
| `@agent-context-lint/maintainers` | Default ownership, integration, prioritization, dependency direction | 2 | At least one member is not a release manager |
| `@agent-context-lint/contracts-reviewers` | Public TypeScript API, IR, JSON schemas, config, compatibility, ADRs | 2 | Reviewer did not author the contract change |
| `@agent-context-lint/profile-reviewers` | Syntax adapters, client profiles, provenance, conformance truth tables | 2 | At least one member can review fixture evidence independently |
| `@agent-context-lint/rules-reviewers` | Repository evidence, deterministic rules, efficiency metrics, thresholds | 2 | QA independently reviews expected-output and calibration changes |
| `@agent-context-lint/platform-reviewers` | CLI, formatters, integrations, general developer tooling | 2 | Relevant contract or release owner reviews externally visible changes |
| `@agent-context-lint/security-reviewers` | Trust boundaries, filesystem jail, parsing limits, secrets, workflow permissions, fixes, sandboxing | 3 | At least two members are outside day-to-day feature ownership |
| `@agent-context-lint/standards-reviewers` | Standards registry, TUF metadata/policy, compatibility updates, recovery | 2 | TUF root/key custodians are not the sole implementation reviewers |
| `@agent-context-lint/fix-reviewers` | Text edits, atomic writes, dry-run patches, canonical synchronization | 2 | A security reviewer supplies the second high-risk review |
| `@agent-context-lint/release-managers` | CI, packaging, dependencies, provenance, signing, publishing, rollback | 3 | Builder and final release approver are distinct people |
| `@agent-context-lint/docs-reviewers` | User, rule, profile, migration, support, and operational documentation | 2 | Behavior owner also reviews normative technical claims |
| `@agent-context-lint/qa-reviewers` | Test strategy, fixtures, goldens, and fuzz seeds | 2 | A test change cannot be the only evidence for its paired behavior change |
| `@agent-context-lint/governance-reviewers` | CODEOWNERS, this policy, exceptions, ownership audits, break-glass audit | 2 | Neither member may approve a policy change they authored |

Membership is reviewed quarterly, when a member changes role, and before RC
freeze. A team that drops below its minimum is immediately inactive for
approvals. A person who is unavailable for the review window does not count as
active membership.

The K01 official-example corpus retains a stricter monthly evidence cadence, but
its current review is the accountable maintainer's documented review followed by
the separate audit-agent verification described in
`docs/profiles/official-example-conformance.md`. An overdue review blocks
compatibility publication; the inactive future aliases do not add a human
approval requirement.

## Path ownership map (future companions inactive)

`.github/CODEOWNERS` is the machine-readable source for exact patterns. The
following map explains intent and catches future paths that have not yet been
created. New paths with equivalent responsibility MUST receive the same owner in
the pull request that creates them.

| Domain | Representative paths | Primary owner | Future companion when activated |
|---|---|---|---|
| Shared contracts | `packages/core/src/{contracts,config,diagnostics,ir,public-api}/`, `schemas/`, architecture and compatibility docs | Contracts reviewers | Affected consumer owner; QA for schema goldens |
| Core resolution | `packages/core/`, `packages/resolver/` outside the specialized paths below | Contracts reviewers | Profile reviewers for activation/effective-context behavior |
| Client profiles and syntax | `packages/profiles/`, `packages/syntax/`, client conformance fixtures and profile docs, including `conformance/official-examples/` | Profile reviewers | QA; security if discovery/import boundaries change |
| Rules and efficiency | `packages/evidence/`, `packages/rules/`, `packages/efficiency/` | Rules reviewers | QA; contracts for diagnostic/schema changes |
| CLI and formatters | `packages/cli/`, `packages/formatters/`, general `tools/` | Platform reviewers | Contracts for machine output; release for integration/package changes |
| Filesystem and parser safety | safe discovery/path/filesystem modules, `packages/markdown/`, security fixtures/docs | Security reviewers | Maintainer or relevant parser owner; QA |
| Standards and TUF | `packages/standards/`, `standards/`, `knowledge/`, standards fixtures/docs | Standards reviewers | Security reviewers |
| Fixes and synchronization | fix modules, fix fixtures/docs, atomic write and canonical preview code | Fix reviewers | Security reviewers; QA for idempotence evidence |
| Release and supply chain | manifests, lockfile, Changesets, workflows, action, release scripts/docs | Release managers | Security reviewers for permissions/signing/provenance |
| Documentation | `README.md`, `CONTRIBUTING.md`, `docs/`, `examples/` | Docs reviewers | Owner of any behavior stated normatively |
| Tests and validation | test/spec files, `packages/test-kit/`, and general fixtures | QA reviewers | Owner of the production behavior |
| Governance | `.github/CODEOWNERS` and `docs/governance/` | Governance reviewers | Security for enforcement controls |

Patterns are ordered from broad to specific because GitHub applies only the last
matching CODEOWNERS pattern. Sensitive paths therefore appear after general
documentation, test, and fixture patterns. When a sensitive path lists several
teams, GitHub considers approval from any one listed code owner sufficient; the
additional future-profile roles in the next section are inactive until explicitly
activated.

## Future multi-maintainer review matrix (inactive)

The table below records the future domain matrix for a repository that explicitly
activates multi-maintainer governance. It is advisory while sole-maintainer mode
is active. Current acceptance uses the accountable maintainer's review,
automated gates, and the independent agent audit; “independent” in the future
matrix must not be interpreted as an additional current human approval.

| Change class | Required domain approvals | Required evidence before approval |
|---|---|---|
| Public contract or compatibility behavior | 1 contracts reviewer + 1 affected package/profile owner | Versioned examples, compatibility impact, migrated consumers, contract/schema tests, documentation/changeset decision |
| Profile, syntax, discovery, import, or precedence behavior | 1 profile reviewer + 1 QA reviewer | Official-source provenance, positive/negative conformance fixtures, unknown-state handling, cross-platform result where relevant |
| Rule, repository evidence, metric, threshold, or recommendation | 1 rules reviewer + 1 QA reviewer | Per-rule matrix, source-located golden, and seeded recall/precision impact |
| CLI, formatter, or integration behavior | 1 platform reviewer + the affected contracts or release reviewer | Exit-code/output schema compatibility, packaged integration test, terminal-safety and documentation evidence |
| Filesystem boundary, parser resource limit, secret handling, or security policy | 1 security reviewer + 1 maintainer outside the authoring change | Threat-model delta, abuse-case tests, fuzz/property regression where applicable, no-boundary-escape evidence |
| Standards data or compatibility snapshot | 1 standards reviewer + 1 security reviewer | Provenance/digest, expiry/rollback behavior, golden fixtures, offline-default confirmation |
| TUF roles, keys, thresholds, trusted root, or update verification | 1 standards reviewer + 2 security reviewers; all distinct | Threshold/key-custody record, signature/replay/freeze/mix-and-match tests, recovery/rollback procedure update |
| Automatic fix, write path, or canonical synchronization | 1 fix reviewer + 1 security reviewer | Dry-run golden, atomicity/concurrent-change test, idempotence test, root-jail and ambiguous-merge refusal evidence |
| Consumer workflow integration, dependency policy, package, signing, provenance, or release | 1 release manager + 1 security reviewer + 1 maintainer; all distinct | Least-privilege diff, clean install/build, required suites, SBOM/provenance/signature checks, rollback impact |
| Documentation-only editorial change | 1 docs reviewer + 1 general reviewer | Link/format checks; executable example test if an example changes |
| Normative behavior, security, profile, rule, or release documentation | 1 docs reviewer + the relevant domain reviewer | Evidence that the text matches implemented and tested behavior |
| Test, fixture, golden, threshold, snapshot, or baseline | 1 QA reviewer + relevant production owner | Explanation for expected-output change; test fails against old behavior and passes against intended behavior where feasible |
| CODEOWNERS, governance, required-check, or bypass policy | 1 governance reviewer + 1 security reviewer; both distinct from author | CODEOWNERS validation, enforcement impact, activation/audit procedure update |

Mechanical generated output does not waive review. Its generator and input are
reviewed, and the pull request records the exact reproducible command. Deleting
or weakening a test, fuzz seed, diagnostic golden, security limit, precision
threshold is treated as a behavior change in the
corresponding domain.

## Change workflow (current mode and future activation)

1. The issue or pull request names the ticket, DRI, risk domains, acceptance
   evidence, documentation impact, and rollback plan when state can change.
2. The author runs affected unit/contract tests and records reproducible results.
3. In sole-maintainer mode, the maintainer records the review and a different
   agent audits the exact commit, evidence, and relevant automated gates.
4. If future multi-maintainer mode is activated, CODEOWNERS and its matrix may
   request the additional domain roles recorded below.
5. The active checks verify the exact review/audit evidence and fresh results
   after the last reviewable push; no second human approval is implied.
6. The DRI watches post-merge signals and owns rollback/follow-up.

When classification is disputed, apply the higher-risk class until governance
and the relevant domain owner agree in writing. Security has stop-ship authority
for filesystem, network, credential, command-execution, fix, signature, and
sandbox concerns. Release managers have stop-ship authority for unverifiable or
unrecoverable artifacts. Neither authority may unilaterally declare the concern
resolved.

## Future GitHub enforcement and fail-closed activation

GitHub requires a listed team to be visible and have explicit write access for
it to act as a code owner. GitHub also treats any one owner on a matching line as
sufficient. Therefore CODEOWNERS alone cannot enforce this policy's cross-team
or separation-of-duties rules.

If multi-maintainer mode is explicitly activated, an administrator MUST complete
the following procedure before relying on team-based remote enforcement. It is
not a current v1.0.0 acceptance prerequisite:

1. Choose the real GitHub organization and create or map every team in the alias
   directory with the required membership and visibility.
2. Replace all `@agent-context-lint/` prefixes in `.github/CODEOWNERS` with the
   real organization/team slugs. Grant every team explicit write access. If a
   team should not normally push, use organization/repository permissions to
   restrict pushes while retaining the access GitHub requires for ownership.
3. Query `GET /repos/{owner}/{repo}/codeowners/errors?ref=<activation-sha>` and
   require an empty `errors` array. Also verify each referenced team through the
   GitHub API or administrative UI; syntax validation alone does not prove that
   a team exists or has access.
4. Run an ownership-coverage check over every tracked path and a sentinel pull
   request that touches one representative path for each row in the ownership
   map. Verify the intended review requests and the `governance/review-policy`
   result.
5. Install an active ruleset on the default branch, release branches, and tags.
   Do not leave it in evaluation mode. Require:
   - a pull request and the activated repository acceptance policy;
   - review from code owners;
   - dismissal of stale approvals and approval of the most recent reviewable
     push by someone other than its author;
   - resolution of all conversations;
   - strict required checks, including `governance/codeowners`,
     `governance/review-policy`, build, lint, unit/contract/integration tests,
     secret scan, dependency review, and applicable security checks;
   - the merge queue, blocked force pushes, blocked deletion, and linear history;
   - no routine bypass, including for administrators and automation.
6. Pin each required status check to its expected GitHub App where supported.
   Give workflow tokens read-only permissions by default and elevate only the
   individual job that needs more.
7. Record the activation evidence in a governance issue: aliases and membership
   counts (not private personal data), API validation result, ruleset export,
   sentinel PR links, required-check identities, approvers, and timestamp.

The future `governance/codeowners` check MUST fail when a placeholder remains,
the API reports an error, a team cannot resolve, a team lacks write access, a
tracked path has no effective owner, or this policy and CODEOWNERS disagree.
The future `governance/review-policy` check MUST fail when a required domain is
unapproved or a configured audit rule is violated. In current sole-maintainer
mode, the local maintainer review and exact-commit agent audit are the applicable
acceptance evidence; remote team activation remains optional.

## Separation of duties (future profile)

- In current sole-maintainer mode, the maintainer may approve their own change
  after automated gates and a different agent's exact-commit audit. Future
  multi-maintainer mode may impose author/approver separation.
- Future security-sensitive or release changes use the domain matrix; no
  additional human approval is required while that profile is inactive.
- The person who builds or uploads a release artifact cannot give the final
  release approval. The verifier checks the registry artifact against source,
  provenance, checksums, signatures, and the approved commit.
- A person who changes an expected result, precision adjudication, or threshold cannot be its sole QA
  reviewer.
- TUF root/key/threshold changes require the standards owner and two independent
  security reviewers. Online timestamp/snapshot operational access does not
  confer root-key approval. Root keys remain offline and threshold-controlled.
- Publishing credentials, signing material, and repository administration are separate capabilities
  with least privilege.
  No normal service identity receives all of them.

## Emergency and break-glass policy

Break-glass exists only for an active P0 security incident, compromise of
release/signing infrastructure, or urgent rollback of a harmful published
artifact. Schedule pressure, an unavailable reviewer, CI flakiness, or a P1–P3
defect is not an emergency.

1. The incident commander opens an incident record, states the trigger, scope,
   least-privilege action, recovery plan, and expiry (maximum four hours).
2. Two people authorize access: one security reviewer and one governance or
   release reviewer. Neither may be the change author when another qualified
   person is available.
3. Use a pull request and “bypass for pull requests only” when the platform is
   available. Direct pushes, unsigned artifacts, disabled audit logging, force
   pushes, branch deletion, and bypass of cryptographic verification remain
   prohibited.
4. Time-bound access is granted to a normally empty break-glass team or identity.
   Production credentials are short-lived and scoped to the exact operation.
5. Preserve the diff, commands, checks, GitHub ruleset insight/audit event,
   artifact digest, approvers, and outcome. Revoke access immediately after the
   operation and rotate any credential whose confidentiality is uncertain.
6. Restore ordinary protections before other work resumes. Within 24 hours,
   independent owners review the action and either ratify it with complete tests
   or revert it. Within five business days, publish an internal retrospective
   and track corrective actions.

Emergency changes never waive the product's no-external-repository-mutation
rule, filesystem boundary, signature/integrity verification, secret protection,
or prohibition on executing repository instructions during a normal scan.

## Ownership changes and exceptions

Team membership and path mappings change through a normal change owned by the
maintainer. The change includes the old/new accountability, handoff date, open
risks, runbooks, and (only when future multi-maintainer mode is activated) the
replacement team's target membership. Removing an inactive alias does not block
sole-maintainer acceptance.

P0/P1 defects and filesystem, network, fix-integrity, credential, signature, or
sandbox safety requirements cannot be waived. A P2/P3 release exception records
the owner, user impact, evidence, compensating control, expiry, and target date;
it requires governance and the affected domain owner. Expired exceptions fail
the release gate.

## Acceptance evidence for A10

| Requirement | Evidence |
|---|---|
| Every repository path has an owner | The leading `*` rule assigns maintainers; later rules specialize sensitive paths |
| Contracts and profiles have designated owners | Dedicated contract/profile patterns, maintainer review, and agent-audit evidence |
| Filesystem/security, standards/TUF, and fixes are protected | Explicit path patterns, security companion reviews, and non-waivable safety policy |
| Release, docs, and tests have designated owners | Release/docs/QA patterns plus maintainer review and evidence requirements |
| Governance files protect themselves | Final CODEOWNERS patterns assign governance/security ownership to CODEOWNERS and governance docs |
| High-risk domains are enforced | Automated gates, maintainer decision, and fail-closed exact-commit agent audit |
| Placeholder aliases cannot silently weaken protection | Activation blocker, API/team-resolution validation, coverage/sentinel checks, and required ruleset controls |
| Emergency access remains accountable | Narrow trigger, two-person authorization, time limit, audit, revocation, and retrospective |

Local validation for this bootstrap revision checks that every non-comment
CODEOWNERS rule has a pattern and at least one syntactically valid team owner,
that unsupported negation/range syntax is absent, that all required high-risk
aliases occur, that the file is below GitHub's 3 MiB limit, and that Markdown
links and fenced blocks are structurally sound. GitHub-side owner resolution and
ruleset behavior are intentionally part of the activation evidence because a
local parser cannot prove organization permissions.

## References

Retrieved 2026-08-01:

- [GitHub: About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
  — file precedence, pattern behavior, owner permissions, team visibility, and
  the fact that one owner on a line is sufficient.
- [GitHub: About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
  — required reviews/checks, stale approvals, last-push approval, restrictions,
  and bypass behavior.
- [GitHub: Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
  — pull-request, status-check, code-owner, and bypass rules.
- [GitHub REST API: List CODEOWNERS errors](https://docs.github.com/en/rest/repos/repos#list-codeowners-errors)
  — server-side syntax validation for a selected ref.
