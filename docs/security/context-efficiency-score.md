# Context-efficiency scoring security boundary

G07 is a capability-free in-memory calculator. It does not read repository files, execute commands,
load code, contact a model or network, inspect environment state, or write results.

| Threat | Control |
| ------ | ------- |
| Forged metrics inject favorable values | Only same-process G05-issued records are accepted; clones, proxies, and plain lookalikes fail closed. |
| Unknown evidence becomes a perfect score | Every nonzero-weight input follows G06 `required-complete-evidence`; unavailable operands and penalties are `null`, and the aggregate is omitted. |
| Sampling is mistaken for exhaustive measurement | Stratified samples mark affected inputs `sampled` and the report `caveated`; non-exhaustive dead-scope evidence remains unavailable. |
| Formula or configuration drift is hidden | The full G06 specification, normalized configuration, version, tokenizer, operands, and SHA-256 identities are emitted with the result. |
| Floating-point or platform drift changes a grade | Bounded integer ratios and `BigInt` half-up arithmetic are independent of locale and host floating-point behavior. |
| Hostile JavaScript runs through configuration | G06 rejects proxies, accessors, exotic prototypes, cycles, sparse arrays, unknown fields, and invalid numeric relationships without invoking getters. |
| Static efficiency is presented as semantic or outcome evidence | `qualityClaim` and `semanticQualityPreservationClaim` are immutable `false`; similarity remains non-semantic G05 evidence. |
| Sensitive instruction text leaks into score artifacts | Evidence contains IDs, repository-relative paths, profiles, states, and numeric contributions—not statement text. Downstream formatters must still sanitize paths and enforce artifact retention policy. |
| Large evidence causes unbounded work | G03–G05 bounds apply before scoring; G07 additionally checks aggregate evidence and safe-integer arithmetic. |

SHA-256 fields are deterministic record identities, not signatures. They detect record changes for
reconstruction but do not authenticate the process that produced a record. Persisted or externally
received JSON must be schema-validated and handled as untrusted data.

G08 may verify a score with `isIssuedContextEfficiencyScore` when composing the in-process
efficiency pipeline. That predicate is an authority check for the current process only; it does not
turn serialized score output into trusted input.
