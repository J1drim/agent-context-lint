# Context-efficiency recommendation security boundary

G08 is capability-free with respect to repositories. It receives immutable in-memory evidence,
calls the existing pure E05 resolver, and optionally invokes only the closed G01/G10 tokenizer
selection. It has no repository filesystem, process, network, model, environment, clock, locale, or
write capability. Repository commands and executable-looking text remain inert data.

## Trust rules

- Only same-process G05 metrics and their exact same-process G07 score are accepted.
- Completed G08 outputs are registered in a module-owned `WeakSet`; the public authority predicate
  rejects copied, parsed, proxied, or forged lookalikes before downstream reports or diagnostics can
  rely on their retention proofs.
- Baseline/counterfactual contexts must contain genuine branded D-series and E04 results accepted by
  E05; copied or forged output objects are not authority.
- Scenario kind and document identities must match G05 evidence. G08 derives every user-visible
  claim and rejects unrelated changes or incomplete affected-target coverage.
- Profile, surface, client, specification, target, tokenizer, score-version, and configuration
  identities must reconcile exactly. No cross-profile or cross-tokenizer comparison is inferred.
- Closed records, dense arrays, aggregate ceilings, safe-integer arithmetic, intrinsic cancellation,
  bounded tokenizer execution, deterministic sorting, and deep freezing constrain hostile input.
- Exceptions never reflect repository strings, proxy traps, tokenizer-provider text, or cancellation
  reasons.

Unknown, conditional, ambiguous, truncated, imported-but-unreconstructible, partial, and fallback
states remain visible and block a recommendation when required proof is unavailable. A successful
static result always carries fixed caveats denying semantic and task-quality preservation claims.

Security tests cover proxies, accessors, sparse/extended/oversized arrays, forged G05/G07 authority,
mismatched profile/target pairs, incomplete target coverage, unrelated changes, content loss,
partial resolution, tokenizer unavailability, cancellation, deterministic ordering, closed-schema
rejection, and built package export. No test opens a socket, spawns a command, calls a model, mutates a
repository, or touches an external repository.
