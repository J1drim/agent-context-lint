# Security boundary for syntax and structure rules

ACL100–ACL109 consume repository-controlled Markdown, YAML/MDC, glob-shaped strings, suppression
comments, paths, ranges, and profile observations as hostile data. The evaluator has no filesystem,
network, process, environment, model, dynamic-import, callback, or write capability.

Top-level inputs, policies, fields, observations, evidence records, and arrays are closed own-data
structures. Proxies, accessors, symbols, inherited/sparse entries, duplicate identities, unsupported
states, malformed HTTPS evidence, and oversized collections fail closed. B03 revalidates source
digests and range ownership before C07 or B08 runs. C07 supplies bounded fatal UTF-8/YAML parsing;
B08 independently revalidates source-exact HTML comments and keeps attachment authority private.

Repository text is never copied into diagnostic messages, suggestions, evidence labels, or
fingerprint components. Messages use fixed product text plus bounded schema/profile identifiers or
parser issue codes. Unknown profile behavior produces no finding. Suggestions carry no fix plan.

Unused suppression detection is intentionally two-phase. Only a live evaluator result owns B08
attachments, and matching occurs against a B04-validated complete diagnostic set. This prevents
forged attachments, cross-source or cross-line widening, and false ACL109 reports for findings
owned by a later rule family. Invalid directives never gain suppression authority; dependency or
output-contract failures return one stable issue and no partial authoritative result.
