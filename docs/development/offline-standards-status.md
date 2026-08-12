# Developing offline standards status

H06 is implemented in `packages/standards/src/offline-standards-status.ts`. It is a pure composition
boundary over H03 and H04 data. Do not add filesystem, network, ambient-clock, repository, cache, or
write capabilities to this module. H05/H07/H08 callers must decode or acquire state separately and
pass a closed observation into the evaluator.

## Invariants

- Require the unforgeable H03 loader brand for bundled authority; structural equality is not trust.
- Parse lock bytes through H04 and keep parsed repository locks authority-neutral.
- Select locked activation only when its complete content and provenance identity matches the
  authenticated bundle and the current engine satisfies the target requirement.
- Treat cached-latest metadata as untrusted and informational. It never controls activation.
- Require an exact caller-supplied UTC-second `asOf`; never consult an ambient clock.
- Calculate age in inclusive UTC calendar-day terms and classify stale only above the configured
  1..365-day maximum.
- Compare canonical SemVer precedence without locale-sensitive operations; build metadata has no
  precedence effect.
- Keep output and issue ordering deterministic, bounded, deeply frozen, and safe to serialize.
- Preserve the authenticated bundled result when optional lock/cache data is malformed; expose a
  sanitized structured problem instead of a trust downgrade or network fallback.
- Keep H06 schema and B05 nested-output validation in agreement.

`policySelection` answers which available policy record supplies age information. It is
intentionally separate from B05 `activation`: a different valid repository lock can be the selected
policy record while remaining unauthenticated and therefore unable to activate its unavailable
content.

## CLI composition

The packaged `standards status` command performs the capability-bearing work around H06: it selects
the repository root, resolves configuration, reads one configured lockfile through C02, and obtains
the authenticated bundle from H03. It then supplies an exact UTC-second timestamp and no ambient
clock or network capability to `createOfflineStandardsStatus`. The JSON output is the frozen H06
report; terminal output is a deterministic projection of the same values. Missing or malformed
repository lock state is reported as a typed H06 issue while bundled activation remains available.

## Verification

Run focused checks while developing:

```bash
pnpm exec vitest run packages/standards/test/offline-standards-status.unit.test.ts
pnpm exec vitest run packages/standards/test/offline-standards-status.unit.test.ts --coverage \
  --coverage.include=packages/standards/src/offline-standards-status.ts
pnpm exec tsc -b --pretty false
pnpm exec tsc -p tsconfig.tests.json --pretty false
pnpm exec eslint packages/standards/src/offline-standards-status.ts \
  packages/standards/test/offline-standards-status.unit.test.ts
pnpm package-boundaries:check
pnpm pack:check
```

Tests cover current/stale calendar boundaries, max-age endpoints, exact bundled-lock identity,
different and incompatible locks, cached SemVer precedence, absent/malformed/wrong-channel/future
observations, hostile JavaScript containers, exact clocks, deterministic issue ordering, frozen
results, nested B05 validation, schema validation, and package exports. The serialized full
`pnpm check` gate remains required before integration.

Review the [API contract](../api/offline-standards-status.md),
[output semantics](../api/output-contracts.md), and [threat model](../security/threat-model.md) with
every behavior change.

## Standards basis

The comparison and timestamp rules were checked on 2026-08-02 against the primary
[Semantic Versioning 2.0.0 specification](https://semver.org/) and
[RFC 3339](https://www.rfc-editor.org/info/rfc3339). H06 intentionally narrows RFC 3339 input to an
exact UTC second (`YYYY-MM-DDTHH:mm:ssZ`) so lexical chronology and serialized evidence remain
unambiguous. SemVer build metadata is retained in reported versions but ignored for precedence.
