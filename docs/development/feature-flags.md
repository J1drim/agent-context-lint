# Feature flags and the GA release audit

The repository uses a small, static feature manifest to make incomplete committed scope visible
without making normal development checks permanently red. The manifest is
[`config/feature-flags.json`](../../config/feature-flags.json).

Feature flags are temporary delivery controls, not product configuration. They cannot inspect users,
call a service, vary by environment implicitly, or make a random rollout decision. Runtime callers
must request a known identifier and may supply only an explicit Boolean override. Unknown flags,
unknown overrides, and untyped overrides fail closed.

## Manifest contract

Every entry declares:

- a stable `profile.*` or `rule.aclNNN` identifier;
- a matching `kind`;
- whether the feature is committed to `ga` or explicitly deferred to `post-ga`;
- its feature maturity (`experimental`, `beta`, or `stable`); these labels describe individual
  feature readiness, not the `1.0.0` product release channel;
- the deterministic default state;
- one accountable owner, target gate, and sorted implementation tickets; and
- a rationale while the feature is not stable.

Entries and ticket lists are sorted so reviews and generated evidence remain deterministic. The
validator rejects unknown fields rather than silently accepting misspelled or obsolete controls.
Changes to the manifest require profile and release review through CODEOWNERS.

This design follows the OpenFeature specification's typed default-value and immutable
evaluation-metadata principles while deliberately avoiding a runtime provider or SDK. A local
manifest is sufficient for an offline command-line analyzer and removes network, targeting, and
availability risks.

## Required checks

Run the development check during ordinary work:

```sh
pnpm feature-flags:check
```

It validates the complete manifest contract but permits a known feature to remain disabled or
pre-stable while its named tickets are active.

Run the GA audit at release gates:

```sh
pnpm feature-flags:ga
```

The audit fails if any `ga` feature is disabled or has not reached `stable`. It is intentionally
failing while the Cursor and Gemini CLI implementation/conformance tickets remain open. A release
workflow must run this command; changing a feature to `post-ga` is a scope decision that requires
the plan, ADR, and implementation tracker to change in the same reviewed work.

Tests cover development and GA modes, fail-closed parsing, sorting, duplicate detection, typed
evaluation, and immutable evaluation metadata:

```sh
pnpm test:feature-flags
```

## Source

- [OpenFeature specification](https://openfeature.dev/specification/) — evaluation defaults, flag
  value types, and immutable evaluation details (accessed 2026-08-01).
