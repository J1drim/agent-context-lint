# Cross-profile comparison security boundary

E07 is a capability-free in-memory projection. Its only accepted semantic inputs are E05 objects
issued in the same process. It cannot read repository or user files, discover profiles, execute
commands, inspect environment variables, contact clients or models, use the clock, access the
network, or write output.

| Threat | Control |
| --- | --- |
| Forged universal semantics | Same-process E05 issuance is mandatory; each result retains its profile, surface, version, and specification identity. |
| False equivalence | Every pair fixes `equivalenceClaim` to false; an observational match is explicitly narrower than behavioral equivalence. |
| Unknown-as-absent | Missing paths are comparable as absent only when activation, target-scope, and partial-profile ambiguity are absent. |
| Partial order presented as total | Order is compared only when both E05 records say `total` and both common sequences are complete. |
| Truncated/unknown content presented as equal | Missing, identity-only, unavailable, unknown-truncation, and matching-prefix evidence remains unknown. |
| Content disclosure | Output contains digests and paths, never E05 document text or upstream reason prose. |
| Accessor/proxy execution | The public envelope and array are descriptor-validated; dependencies are immutable issued records. |
| Resource exhaustion | Profile, aggregate document/ambiguity, pair-work, and output-evidence budgets are enforced. Order divergence uses a linear witness scan. |
| Nondeterministic output | UTF-8 byte ordering, digest-derived IDs, stable pair enumeration, and deep immutability remove locale/input-order dependence. |

Downstream portability and efficiency rules may cite E07 evidence, but they must preserve the same
semantic boundary. In particular, a `same` dimension or `observational-match` overall result cannot
be relabeled as proof that two clients load, prioritize, interpret, or obey instructions identically.
