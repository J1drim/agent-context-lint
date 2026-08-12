# Scope activation rule security boundary

ACL200–ACL206 treat repository paths, instruction graphs, activation provenance, resolution facts,
and sampling evidence as untrusted data. The evaluator has no I/O or execution capability and
accepts no callbacks. Commands, glob engines, models, network clients, modules, and ambient process
state are outside its contract.

The implementation rejects proxies and accessor-bearing/open records, requires dense arrays,
validates B03, normalizes through E01, invokes E08, bounds work/output, and validates B04. Messages
are fixed and source-bound; formatters still apply centralized sanitization.

The main integrity risk is a false absence claim. ACL200 requires a complete exact E08 universe
with no active or indeterminate result. Sampled, partial, conditional, contradictory, ambiguous,
and unknown evidence remains distinct. Shadowing and nesting are never inferred from filenames or
ordering. No diagnostic contains a fix because mechanically changing scope can remove policy.

Review malformed B03/E01/E08 relationships, forged shadow IDs, large matrices/provenance, limits,
determinism, suppression, and all formatters. Root escape, repository read, execution, network,
hidden capability, or unknown-to-inactive conversion is stop-the-line.
