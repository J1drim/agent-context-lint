# Context-efficiency report security boundary

G09 has no filesystem, repository, command, environment, clock, locale, model, network, or write
capability. It accepts only immutable records issued by G05/G07/G08 in the current process. G08 now
has its own module-private issuance set, so a caller cannot forge a retention proof by copying the
public result shape.

Closed non-proxy records and own enumerable data properties are required before any field is read.
The constructor reconciles tokenizer and all configuration/metrics/specification/version/profile
relationships and recomputes the exact G07/G08 digest of the supplied G05 record. Version 1
accepts only the literal repository scope, so aggregate distributions cannot be labeled as evidence
for an arbitrary target. Comparisons additionally require identical issued scope and complete
profile identity sets. Serialized JSON cannot be reintroduced as authority; it is data only.

JSON output is bounded to 64 MiB, preflight before the first write, split into at most 64 KiB chunks,
and written sequentially under backpressure. Native cancellation is checked before and between
chunks and raced against an outstanding sink. Sink exceptions and rejection values are replaced by
a fixed error. Terminal output is bounded to 4 MiB and sanitizes C0/C1 controls, ANSI-capable input,
bidi controls, isolates, and malformed Unicode. ANSI color consists only of fixed renderer-owned
sequences and never changes text or ordering.

Every result fixes quality and semantic-preservation claims to false. Missing operands remain null,
and comparison output repeats explicit static-only caveats. Report generation never executes
repository strings, opens a socket, changes an exit policy, writes a repository, or touches an
external repository.
