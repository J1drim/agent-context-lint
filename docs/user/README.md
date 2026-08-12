# User documentation

This index is the shortest route through the Agent Context Linter user documentation. The
documentation describes the packaged command as it behaves today; it does not promise that a client
will follow an instruction or that an undocumented vendor behavior is deterministic.

## Start here

- [Getting started](getting-started.md) — install the package, run a first scan, and understand exit
  statuses and local safety boundaries.
- [Scanning repositories](scanning.md) — select profiles, rules, changed-file mode, output formats,
  and conservative fallback behavior.
- [Commands](commands.md) — use `list`, `explain`, `rules`, and `init`.
- [Rule catalog](../rules/catalog.md) — review every ACL rule's metadata and illustrative bad/good
  examples. These snippets are documentation aids, not precision fixtures.
- [Effective context](effective-context.md) — understand included, excluded, conditional, partial,
  and unknown context.
- [Understanding an explanation](explain.md) — read target-level resolution and import evidence.

## Client profiles and migration

- [Profile limitations](profiles.md) — compare supported surfaces and see which facts remain
  conditional, model-selected, UI-only, or outside a repository scan.
- [Migration guide](migration.md) — move common multi-agent instruction layouts without silently
  changing policy or asking the linter to rewrite prose.
- [Canonical policy synchronization](canonical-policy-sync.md) — preview vendor-specific policy
  projections when the selected profile can prove a safe mapping.

## CI, standards, and operations

- [CI integration](ci.md) — choose local checks or the read-only GitHub Action and pin trusted
  action releases.
- [Standards operations](standards.md) — inspect bundled knowledge, request an explicit check, and
  preview or activate a verified lockfile update.
- [Mechanical-fix previews](mechanical-fixes.md) — review the one currently approved dry-run fix;
  normal scans remain read-only.
- [Shell completion and manual pages](shell-completion.md) — install generated command help for
  supported shells.

## Context efficiency

- [Context-efficiency score](context-efficiency-score.md) — interpret the static score without
  treating it as a quality or equivalence claim.
- [Context-efficiency reports](context-efficiency-reports.md) — inspect identities, uncertainty, and
  compatible comparisons.
- [Efficiency metrics](context-efficiency-metrics.md) and
  [recommendations](context-efficiency-recommendations.md) — review the evidence behind a
  recommendation.

## Library and validation references

- [Embed the linter](library-api.md) — use the public library boundary.
- [Machine-readable CLI reference](machine-reference.md) — consume the packaged command and rule
  metadata contract. Normative profile specifications live under
  [`docs/profiles`](../profiles/README.md), security controls under
  [`docs/security`](../security/threat-model.md), and generated command/rule contracts under
  [`docs/api`](../api/command-reference.md). Start with this index when navigating those
  developer-facing references.
