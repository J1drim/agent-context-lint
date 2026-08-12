# Security boundary for document context rules

ACL350–ACL355 analyze repository-controlled Markdown, ranges, filenames, import metadata, and
provenance as hostile input. The evaluator accepts data only; it has no filesystem service, network
client, process launcher, environment lookup, model adapter, dynamic import, callback, or fix
application capability.

## Controls

- The top-level input, options, import entries, provenance records, and arrays are closed own-data
  structures. Proxies, accessors, symbols, inherited/sparse entries, and unknown authority fields
  fail closed.
- B03 revalidates source bytes, SHA-256 digests, canonical repository-relative paths, ranges, node
  ownership, and document/import relationships before evaluation.
- G02 bounds every tokenized source or slice. F03/F04 apply their own text, entry, shingle, and
  comparison limits. F10 caps diagnostics and direct imports per document; arithmetic uses safe
  integers or `BigInt` comparisons.
- Import targets must already exist in the supplied B03 source registry. Resolution evidence is an
  inert collector/fact/digest tuple. The evaluator never follows an import specifier or symlink.
- Messages and labels are fixed product text. Raw repository prose is represented by digests and
  source locations, so terminal/JSON/SARIF sanitation remains effective and secrets are not copied
  into diagnostic messages or fingerprints.
- Suggestions are advisory and carry no fix plan. F10 cannot mutate repository content.

An invalid dependency result, output contract failure, or exhausted bound returns one stable issue
and no partial diagnostic bundle. Unknown activation or prose semantics remain non-findings; the
evaluator does not use a model to convert uncertainty into authority.

## Scope-confusion defense

ACL350 evidence is tagged `raw-always-on-document` and has no profile or resolved-target
provenance. ACL355 accepts only direct explicit links. This prevents untrusted repository content
from presenting a document-level estimate as the resolved ACL550/ACL551 budget result or the ACL554
transitive amplification result. F15 must preserve these scopes when it later schedules and
deduplicates rule families.

Regression tests exercise accessors without invocation, proxies without trap execution, forged
source IDs, invalid digests/options, oversized import sets, exact thresholds, suppression, all
formatters, deterministic reordering, and B04 validation.

