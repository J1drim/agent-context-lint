# Seeded recall contracts

F16 defines a closed, versioned calibration contract for proving that the public F15 scheduler can
detect at least one repository-owned synthetic instance of every registered rule. It is a recall
gate, not a precision estimate and not a substitute for each rule family's positive and negative
corpora.

## Committed artifacts

- `calibration/seeded-recall/v0/corpus.json` contains exactly one case for each of the 69 rules in
  `RULE_REGISTRY` order. Each case binds the rule, owning family, default severity, scenario ID, and
  independently reviewed SHA-256 identity of the intended diagnostic's rule/path/semantic tuple.
- `calibration/seeded-recall/v0/report.json` contains only the case identity, visibility state, rule
  identity, severity, and B04 path and semantic fingerprints selected from a public F15 result.
- `calibration/schemas/seeded-recall-corpus.v0.schema.json`, `seeded-recall-report.v0.schema.json`,
  and `seeded-recall-adjudication.v0.schema.json` are closed JSON Schema 2020-12 contracts. Unknown
  properties, missing cases, duplicate identities, reordering, invalid labels, and malformed hashes
  fail validation.

Both artifact kinds use contract version `0.1.0`. The corpus binds the B09 registry and F15
scheduler versions. The report binds the canonical corpus SHA-256. Its run digest covers all case
results, the corpus digest, and the scheduler version. Summary counts are reconstructed during
validation rather than trusted.

## Recall semantics

A case is detected only when its scenario's completed public F15 result contains a **visible**
diagnostic whose rule ID and path/semantic fingerprint tuple reproduce the exact identity committed
in that corpus case. Another diagnostic from the same rule cannot satisfy the seed. A suppressed
diagnostic never satisfies recall. A missed case has no fingerprint and uses the `missed`
disposition. The committed release gate is exactly 69 detected cases, zero missed cases, and 10,000
recall basis points.

When one synthetic scenario emits several rules or several diagnostics for one rule, each corpus
case selects only its independently declared diagnostic identity. Duplicate matches fail closed. The
report still contains exactly one result per registry rule. It never stores diagnostic messages,
suggestions, fingerprint bases, source paths, source bytes, or repository prose.

## Review and adjudication

Review labels are keyed by case ID, rule ID, and both exact fingerprints. The closed labels and
reasons are:

| Label                       | Required reason                     |
| --------------------------- | ----------------------------------- |
| `true-positive`             | `documented-behavior-confirmed`     |
| `false-positive`            | `expected-seed-not-proved`          |
| `uncertain-client-behavior` | `undocumented-or-version-dependent` |
| `test-harness-defect`       | `fixture-contract-defect`           |

The v0 file format retains distinct primary review roles so an adjudication can preserve a
disagreement instead of silently choosing a label. These role identities are artifact inputs, not a
requirement for multiple human approvals. Under the current sole-maintainer policy, the accountable
maintainer supplies the only human review and a separate audit agent verifies the exact artifact,
reconstruction, and arithmetic; that audit is quality evidence, not another human approval. A
`tie-breaker` role is optional and is used only when the primary labels disagree. Adjudication
preserves unresolved decisions as `null`; a persisted result is accepted only after its ordered
decisions, summary, role identities, optional tie-breaker usage, and report digest reconstruct
exactly from the persisted review artifacts.
