# Semantic plug-in security boundary

F17 remains inside TB-03. Repository text, paths, digests, configuration, persisted results, and
JavaScript containers are hostile. The API grants no authority to repository content.

## Controls

- Disabled is the sole implicit configuration. That path does not inspect input and instantiates no
  module.
- The closed configuration selects only a release-owned literal identifier. Executable callbacks,
  registration, paths, URLs, commands, packages, module bytes, and capability-bearing fields are
  rejected.
- Inputs are non-proxy plain data records with own enumerable data descriptors. Accessors, symbols,
  sparse arrays, duplicate document IDs or paths, C0/DEL controls, malformed Unicode, noncanonical
  or traversal paths, NUL text, malformed digests, unknown fields, and excessive resources fail
  closed with fixed messages. The core canonical repository-path validator is the runtime authority;
  the input schema mirrors its data-only checks as far as JSON Schema permits.
- The fixed WebAssembly bytes are copied and SHA-256 verified before use. Runtime inspection requires
  zero imports (therefore no WASI or host functions), zero exported memory, and exactly one known
  function export. Each call creates a fresh instance with an empty import object.
- The audited module has no memory, table, start function, loop, or indirect call. Host work is
  bounded by document, UTF-8 byte, JavaScript-code-unit work, and finding ceilings. O(1) string
  lengths are checked against remaining byte and work budgets before any linear hostile-text scan or
  encoding pass. Cancellation is checked before input admission, between documents, and before
  publication.
- Plug-in output is a distinct contract labeled `non-deterministic`, `networkAccess: "denied"`, and
  `qualityClaim: false`. It cannot enter B04 diagnostics, F15 scheduling, suppression, baselines,
  formatters, or deterministic exit status.
- Output messages are fixed and contain no source text. Paths remain validated repository-relative
  data. Results and nested collections are immutable.

## Residual limits

The reference marker detector is deliberately not a language model and can produce false positives
or miss real conflicts. `non-deterministic` is a policy label for the entire optional semantic class,
not a claim that this fixed module uses randomness. JavaScript WebAssembly calls are synchronous;
the current in-process design is acceptable only because the exact reviewed module has a fixed
non-looping instruction sequence and no memory. Any variable-work module requires a terminable
worker isolation design before acceptance.

Tests prove disabled non-inspection, explicit selection, no fetch calls, digest/import/export shape,
fresh detached bytes, positive and negative execution, hostile containers, pre-scan resource
ceilings, all three source newline conventions, cancellation, order stability, closed schema
rejection, golden output, and separation from F15.
