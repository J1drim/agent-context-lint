# ACL250–ACL255 security boundary

F08 interprets untrusted instruction prose as inert data. It receives no filesystem, shell,
process, environment, clock, network, model, dynamic import, callback, or write interface. The only
accepted applicability authority is an E05 result issued in the same process from already-issued
profile resolutions.

## Fail-closed controls

- The outer input/options and context array reject proxies, accessors, symbol keys, inherited
  fields, sparse/extended arrays, unknown fields, duplicates, and out-of-range limits.
- B03 data is copied recursively through own descriptors before its normal validator sees it.
  Proxies, accessors, cycles, non-JSON values, excessive depth/node counts, and aggregate string
  bytes are rejected without invoking repository-controlled getters.
- F03 and F04 run internally. Callers cannot inject classifications, confidence, normalized text,
  duplicate edges, or similarity values.
- Conditional, shadowed, inactive, unavailable, unmapped, and truncated-out statements do not
  become errors or warnings. Uncertainty is explicit and bounded.
- Pair work, contexts, statements, diagnostics, text, snapshot nodes/bytes, and uncertainties have
  defaults and immutable hard ceilings.
- Diagnostic messages and labels are fixed. Raw instruction text is not interpolated into output;
  target sets and arbitrary action objects enter fingerprints only through digests where needed.
- Suppression matching accepts only parser-issued directives tied to the exact evaluator-issued
  result. Forged or cloned objects fail closed.

F08 never treats an E05 load order as proof that one prose statement semantically overrides
another. Order is used for ACL255 inheritance only; other ordered pairs remain conflict
opportunities when their structured requirements cannot both hold.

The evaluator identifies contradictory or redundant policy. It neither authorizes the referenced
actions nor proves that an agent will follow them. No F08 rule exposes a fix plan.
