# Context-efficiency rule security boundary

F14 is a pure, capability-free evaluator. It receives immutable in-memory B03 and G04–G08 data and
has no filesystem, network, process, environment, model, clock, locale, randomness, write, or
callback capability. Repository text, paths, identifiers, suppressions, and apparent commands are
untrusted inert data.

## Authority and relationship controls

- G05 metrics, G07 scores, and G08 recommendations require module-owned same-process authority.
- G08 registers authority only after completing a projection; a clone, parsed JSON object, or frozen
  lookalike is rejected.
- Cross-record SHA-256 identities, score version, configuration, specification, and tokenizer must
  reconcile exactly.
- ACL557 accepts only issued G07 pairs. It reports incompatibility and never normalizes or compares
  their numeric scores.
- Every document ID, path, range, primary location, and related location is rebound to validated B03
  source bytes before output.

Inputs and options reject proxies, accessors, inherited fields, symbols, sparse/extended arrays,
unknown fields, duplicate IDs, invalid identifiers, unsafe integers, and configured/absolute limit
excess. Diagnostics and uncertainties are bounded, sorted, deeply immutable, and revalidated by
B04. Error messages never reflect repository content.

Unquantified, empty, unavailable, incompatible, or indeterminate evidence cannot become a favorable
result. A partial resolver analysis is surfaced only when G08 still issues a recommended state with
numeric before/after measurements and the required retention proof; the diagnostic then names that
partial state as a caveat. Estimated tokenizers, stratified samples, and caveated scores likewise
remain explicit in diagnostic text. G08 recommendations retain their fixed-false
semantic/task-quality claims. No F14 suggestion is executable or mechanical.

B08 suppressions are parsed from B03 source during evaluation. Finalization requires the exact
issued F14 object, preventing callers from combining a trusted bundle with forged directives.
