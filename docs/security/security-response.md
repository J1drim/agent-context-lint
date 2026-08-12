# Security response

| Document property | Value |
|---|---|
| Status | Maintainer process baseline for ticket A06 |
| Last reviewed | 2026-08-01 |
| Applies to | Agent Context Linter source, packages, standards service, CI, and validation infrastructure |

This runbook turns the [threat model](threat-model.md) into a response process. It follows the prepare, detect, respond, recover, and improve outcomes described by [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final) and the vulnerability-response practice in the [NIST SSDF](https://csrc.nist.gov/Projects/ssdf).

The public vulnerability-reporting policy is the root [`SECURITY.md`](../../SECURITY.md).
Maintainers must test its private email route before the first public release and at each release
readiness review. Public reports must never be the required route for embargoed details.

## 1. Principles

1. Protect users and repository data before preserving availability or release schedules.
2. Keep vulnerability details private until a fix and coordinated disclosure are ready, subject to legal or active-exploitation needs.
3. Stop the affected capability without weakening verification. Never “recover” by skipping a signature, root, sandbox, redaction, or filesystem check.
4. Use least-privilege, separately authenticated responders. Rotate credentials rather than copying them into investigation environments.
5. Preserve minimal, sanitized evidence with a verifiable timeline. Do not collect entire repositories, home directories, environment dumps, or suspected secrets merely for convenience.
6. Communicate confirmed facts, affected versions, workarounds, and uncertainty. Do not overstate static analysis or provenance.
7. Add a minimized project-owned regression fixture and correct the threat model/root cause after containment.

## 2. Roles and authority

Assign named people and backups before release. One person may fill several roles for a small project, but the incident commander and change author cannot alone approve restoration after a critical incident.

| Role | Responsibilities | Emergency authority |
|---|---|---|
| Incident commander (IC) | Owns severity, timeline, coordination, decisions, handoffs, and closure. | Pause CI/releases/services; isolate affected jobs; request registry/GitHub action. |
| Security lead | Validates report, threat/impact, exploitability, affected versions, evidence, remediation, and disclosure content. | Block merge/release; require key/token rotation; reject unsafe workaround. |
| Component owner | Investigates and implements a minimal fix plus regression tests and documentation. | Disable affected feature behind a safe fail-closed release where allowed. |
| Release/supply-chain owner | Controls npm publication, provenance, TUF roles, revocation, yanking/deprecation, and rollback. | Revoke publication paths and publish reviewed emergency artifacts. |
| Infrastructure owner | Isolates CI runners, caches, artifacts, GitHub credentials, model broker, and network services. | Quarantine runners/caches and revoke short-lived or long-lived credentials. |
| Communications owner | Coordinates reporter, users, advisory/CVE, status, and downstream notification. | Publish a reviewed urgent mitigation when ongoing harm outweighs embargo. |
| Evidence recorder | Maintains access-controlled event log, hashes, decisions, and custody without raw-secret replication. | Deny unsafe evidence upload and enforce retention/destruction. |

The IC records all emergency actions. Two-person approval is required to restore TUF publication or npm publication after a security incident.

## 3. Severity and response targets

Targets are objectives, not promises to publish before a fix is safe. “Acknowledge” means a human confirms private receipt; “contain” means credible further harm is stopped.

| Severity | Examples | Human acknowledgment | Initial assessment | Containment target |
|---|---|---:|---:|---:|
| S0 critical | Ordinary-scan code execution/root escape; credential or private-source exfiltration; unauthorized repository write; npm/TUF signing compromise; accepted forged standards target; active widespread exploitation | 4 hours | 8 hours | immediate, target 4 hours |
| S1 high | Reliable denial of service at normal input scale; secret in SARIF/log/artifact; fix corruption without escape; rollback/freeze bypass; CI privilege exposure; sandbox policy bypass without demonstrated host escape | 1 business day | 2 business days | target 1 business day |
| S2 medium | Narrow local information leak, cache poisoning requiring same-user access, bounded resource issue, integrity defect with strong preconditions, non-critical security misconfiguration | 2 business days | 5 business days | planned with owner/date |
| S3 low | Hardening opportunity, documentation gap, defense-in-depth issue with no current security impact | 5 business days | 10 business days | normal backlog |

Any uncertainty between severities uses the higher one until evidence supports downgrade. An S0/S1 affecting released users activates private incident coordination immediately and blocks all non-response releases.

## 4. Intake and triage

### 4.1 Intake requirements

- Accept reports only through the private channel named in the root `SECURITY.md` or a private GitHub security advisory. GitHub documents private reporting and coordinated disclosure in its [security advisory guidance](https://docs.github.com/en/code-security/concepts/vulnerability-reporting-and-management/coordinated-disclosure).
- Acknowledge without requiring a public proof of concept. Ask for affected version/commit, platform, capability, reproduction, observed impact, and whether data or credentials may have left a boundary.
- Give the report an opaque incident ID. Restrict access to the IC, security lead, necessary owners, and reporter collaboration space.
- Do not run an untrusted proof of concept on a workstation with credentials. Reproduce in an isolated disposable environment with synthetic canary secrets, network capture/denial, and bounded inputs.
- Treat attachments, repository links, model transcripts, TUF metadata, SARIF, and crash dumps as hostile and potentially sensitive.

### 4.2 First assessment checklist

1. Confirm the product/version/commit, operating system/filesystem, command, flags, config, profile, standards-pack digest, cache state, and whether the packaged artifact or source was used.
2. Identify crossed boundaries and threat IDs from the [threat register](threat-model.md#7-threat-register).
3. Determine whether ordinary scans, fixes, standards, CI/SARIF, caches, or releases are affected.
4. Determine whether repository files, host files, credentials, model data, network endpoints, packages, or signed metadata were accessed or changed.
5. Establish earliest affected version, latest affected version, exploit preconditions, current exploitation evidence, and downstream exposure.
6. Preserve only necessary sanitized logs, hashes, metadata versions, and exact commands. Rotate a secret instead of retaining its raw value as evidence.
7. Set severity, owner, next update time, containment action, and disclosure constraints. Record why a severity changes.

## 5. Containment playbooks

### 5.1 Ordinary scan execution, escape, or disclosure

- Stop releases and affected CI workflows; disable the affected command/package path if a safe server-side control exists.
- Revoke any credential that the process could access; assume exposure if logs cannot rule it out.
- Reproduce with a synthetic canary under process/filesystem/network observation. Establish whether packaged artifacts and every supported platform are affected.
- Patch the lowest boundary that failed, add regression/property tests, and audit sibling parsers, paths, output sinks, and failure paths.
- Do not recommend running the vulnerable tool on untrusted repositories as a workaround. A safe workaround disables the affected feature or pins a known-unaffected version.

### 5.2 Unsafe fix or repository corruption

- Tell affected users to stop `--fix`; ordinary read-only scanning may continue only if the defect cannot affect it.
- Preserve the before/after digests, generated patch, file identity/mode, and interruption/race timeline without collecting unrelated source.
- Determine whether the issue crosses root, changes undeclared ranges, follows a link, corrupts modes, or applies partial edits. Root/out-of-range writes are S0.
- Ship a fix only after compare-and-swap, idempotence, interrupted multi-file, read-only, link/race, and platform regression tests pass.
- Provide repository-local recovery guidance from the user's own VCS/backups. Never reset, overwrite, or commit in a repository as part of response.

### 5.3 Standards/TUF compromise or update failure

- Execute role-specific containment through the
  [standards trust rotation, revocation, and recovery runbook](standards-recovery.md). It defines
  offline quorum ceremonies, dual-threshold root continuity, online-key fast-forward recovery,
  delegated target revocation, and the automated exercise evidence.
- Disable standards publication and explicit update recommendations; preserve verified locked offline scanning.
- Identify affected TUF role/key, target paths/channels, metadata versions/expiry, first/last published time, download logs, and engine versions that could accept it.
- For an online timestamp/snapshot compromise, rotate the affected keys through new root metadata where required, invalidate unsafe trusted metadata as prescribed by the TUF recovery design, publish fresh consistent metadata, and verify on a clean client.
- For a targets/delegated-role compromise, revoke the delegation/key, publish corrected target metadata and snapshot/timestamp, and identify every target digest that may have been accepted.
- For root-key compromise, conduct the documented threshold ceremony with uncompromised keys. Root updates remain sequential and signed by both old and new thresholds; never distribute an ad hoc root over the compromised channel as trusted.
- For a malicious accepted pack, revoke it, publish a known-good immutable pack/lock recommendation, test all affected rules/profiles, and state that restoring a lock is a workaround only when that lock is known good.
- Run the fake-registry recovery suite and independent clean-client verification before re-enabling publication. If the safe trust chain cannot be established, require a new engine release with a reviewed out-of-band trusted root.

### 5.4 npm release or CI identity compromise

- Disable the publishing workflow/environment and revoke npm tokens, GitHub tokens/apps, OIDC trust, signing credentials, and affected maintainer sessions as applicable.
- Quarantine runners, caches, artifacts, and workflow logs. Compare published tarball/checksum/provenance/SBOM with reviewed source and build instructions; provenance establishes origin, not harmlessness.
- Determine affected versions and downloads. Coordinate npm package deprecation/removal under registry policy, GitHub advisory/CVE, and a clean rebuild from reviewed source on a fresh hosted runner.
- Restore with least-privilege OIDC trusted publishing, protected environment approval, pinned reviewed actions, independent packed-artifact verification, and no inherited untrusted cache.

### 5.5 Cache poisoning or privacy event

- Disable and quarantine the affected cache namespace without opening or publishing hostile payloads through unsafe tooling.
- Establish which engine/schema/profile/pack/repository identities shared the key, whether a poisoned result influenced output/fix/update, and whether raw content or secrets were stored.
- Correct key completeness, schema/digest validation, permissions, locking, serialization, and eviction. Verify cold/warm equivalence and cross-repository isolation.
- Invalidate only the bounded affected namespace when possible. Standards trust is re-established from bundled root and last trusted metadata, never from mutable cache indexes.

## 6. Eradication, recovery, and disclosure

### 6.1 Fix acceptance

An embargoed fix must include:

- a minimized synthetic regression fixture and tests for the exact exploit plus adjacent variants;
- affected/unaffected version analysis for packaged artifacts and supported platforms;
- updated threat/control mapping, user-facing documentation, and release notes/advisory draft;
- dependency/SBOM/lock changes where relevant and an independent security review;
- verification that the mitigation fails closed and does not introduce silent network, execution, write, signature, or sandbox fallback;
- a rollback plan and clean-environment packaged-artifact test.

Do not weaken a release gate, remove a test, suppress a diagnostic, or reduce logging security merely to make the fix pass.

### 6.2 Recovery decision

The IC and security lead confirm containment, root-cause removal, regression coverage, credential/key rotation, artifact integrity, and monitoring before restoration. The release owner separately approves npm/TUF restoration. Recovery uses staged rollout where supported and watches download/update errors, crash/limit reports, registry state, and duplicate or missing SARIF findings without introducing telemetry into the CLI.

### 6.3 Coordinated disclosure

- Credit reporters unless they decline or legal/safety constraints apply.
- Publish affected versions, severity, impact, exploit preconditions, fixed versions, workarounds, rotated/revoked material, and upgrade/lock guidance. Do not expose user data, live secrets, or unnecessary weaponized details.
- Request a CVE for a released vulnerability when ecosystem impact warrants it. Use a GitHub security advisory as the private collaboration and eventual publication record where available.
- Coordinate npm, GitHub, standards-channel, downstream integrator, and model-provider notices as relevant. A TUF incident names accepted malicious digests and replacement metadata/pack versions.
- If active exploitation creates immediate user risk, publish the safest available mitigation before the full postmortem, while clearly marking unknowns.

## 7. Evidence, communications, and closure

### 7.1 Minimal incident record

Record incident ID/severity, reporter/contact preference, UTC timeline, affected versions/digests/platforms, boundaries/threat IDs, indicators, impact and data classes, decisions/approvers, containment and rotations, fix/test commits, released artifacts/checksums/provenance, advisory/CVE links, notifications, recovery evidence, and follow-up owners/dates.

Store evidence in an access-controlled location outside ordinary CI artifacts. Hash retained files, record collection source/time, encrypt in transit/at rest, and set a deletion date. Replace secret values with type, owner, last four characters only when necessary, and a rotation record. Do not put embargoed details in public issues, commit messages, package metadata, or the implementation tracker.

### 7.2 Communication cadence

- S0: internal updates at least every 4 hours while active; reporter update daily unless another cadence is agreed.
- S1: internal update each business day; reporter update at least every 2 business days.
- S2/S3: update at material milestones and no less often than the agreed acknowledgment.

Every update states current severity, confirmed impact, containment, next decision, owner, and time. Silence is not a containment strategy.

### 7.3 Closure and learning

Close only after release/revocation is independently verified, affected users have actionable guidance, monitoring shows no unresolved active harm, and every follow-up has an owner/date. For S0/S1, hold a blameless review within ten business days covering detection, response timing, boundary/control failure, tests that should have caught it, blast-radius reduction, and recurrence prevention.

Update the threat model, ADRs, fixtures, security tests, dependency/publishing controls, and this runbook. Exercise at least the following before GA and annually: TUF key rotation/revocation/recovery, npm release rollback, unsafe-fix interruption, and secret-in-SARIF removal.

## 8. Threat-model linkage

| Threat IDs | Primary response playbook | Required restoration gate |
|---|---|---|
| TM-01–05, TM-26–27, TM-30 | [Ordinary scan](#51-ordinary-scan-execution-escape-or-disclosure) | SR-01 and/or SR-02 from the threat model |
| TM-06–08 | [Unsafe fix](#52-unsafe-fix-or-repository-corruption) | SR-03 |
| TM-09–13, TM-29 | [Standards/TUF](#53-standardstuf-compromise-or-update-failure) and, for cache, [cache poisoning](#55-cache-poisoning-or-privacy-event) | SR-04 |
| TM-18–20, TM-24 | [npm/CI](#54-npm-release-or-ci-identity-compromise) or [ordinary disclosure](#51-ordinary-scan-execution-escape-or-disclosure) | SR-02 and SR-07 |

Security review gate definitions are in [Threat model §10](threat-model.md#10-security-review-gates). A closed incident that changes architecture or residual risk updates both documents in the same reviewed commit.
