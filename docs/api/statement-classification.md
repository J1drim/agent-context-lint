# Statement normalization and classification

Ticket F03 exports `normalizeAndClassifyStatement` from the internal `@agent-context/evidence`
package. It converts source-exact C08/B03 statement text into a stable normal form and emits only
deterministic, high-confidence structured domain claims. Unmatched prose is retained as
`unclassified`; no model, embedding, fuzzy semantic inference, repository read, environment lookup,
network access, or command execution is involved.

```ts
const result = normalizeAndClassifyStatement({
  documentId,
  nodeIds: [statementNode.nodeId],
  range: statementNode.range,
  statementId,
  text: statementNode.original,
});
```

The `0.1.0` result contains:

- the source-exact B03 `InstructionStatement`, including its immutable source range and original
  text;
- the B03-compatible primary `classification`;
- `normalizedText` and source-independent token ranges within that text;
- every matching ordered domain claim, rather than only the primary projection;
- rule-level evidence with matched normalized text, range, template kind, and confidence;
- explicit `known` or `unknown` uncertainty; and
- effective limits and deterministic metrics.

Evidence ranges are half-open UTF-16 offsets in `normalizedText`. They are deliberately named
`normalizedStart` and `normalizedEnd`; source diagnostics must use the retained B03 source range and
must not misrepresent normalized offsets as original-source locations.

## Normal form

Normalization applies Unicode NFC, maps CR/LF variants to a structural space, removes C08 statement
blockquote/list/task prefixes, replaces ordinary inline Markdown links with their label, removes one
inline-code delimiter pair, collapses Unicode whitespace, trims terminal prose punctuation, and uses
Unicode lowercase conversion. It never rewrites or mutates the original statement.

This normal form is an internal comparison key, not a reversible Markdown renderer and not a
linguistic equivalence claim. F04 may use it for exact duplication but owns bounded near-duplication
and multilingual safety.

## Closed high-confidence domains

The classifier recognizes eight domains:

| Domain                 | Closed examples of evidence                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `package-manager`      | Explicitly use or prohibit npm, pnpm, Yarn, or Bun; execute one as a command       |
| `command`              | A complete leading `run`, `execute`, or `invoke` instruction                       |
| `file-ownership`       | `path is owned/maintained by owner` or `owner owns path`                           |
| `generated-files`      | Explicit prohibition on editing generated files/artifacts or read-only declaration |
| `formatting`           | Explicit formatting tool/template relationship                                     |
| `testing`              | Explicit command to run tests or requirement that a named test class pass/run      |
| `approval-requirement` | Explicit approval/sign-off requirement or prohibition without named approval       |
| `path-policy`          | Explicit prohibited/only-write path or labeled allowed/forbidden path list         |

A statement can have multiple claims. For example, `Always run pnpm tests` yields package-manager,
command, and testing evidence. The primary B03 category uses the documented domain order above so
repeated calls are byte-stable. Domain confidence is `0.98` or `0.99`; the classifier does not emit
a lower-confidence guess.

Modality is recognized in conservative order: prohibition (`must-not`), requirement (`must`),
`should`, preference, an exact imperative, then information. Domain evidence remains available so
future conflict rules do not need to recover structure from the primary projection.

## Precision evidence

The checked-in labeled fixture `conformance/fixtures/v0/statement-classifier.fixture.json` contains
88 positive and hard-negative cases. It requires at least eight positive labels per domain and a
minimum precision of `0.95` for every domain. The suite also requires exact label equality for every
case, so missing labels and unexpected cross-domain labels fail in addition to the precision gate.
Thresholds, label order, unique IDs, and positive-label counts are asserted in tests rather than
trusted from mutable fixture metadata.

The corpus measures only its reviewed deterministic templates. It does not establish general natural
language understanding or performance on arbitrary languages and must not be presented that way.

## Input and resource safety

Input, range positions, and options are closed plain non-proxy records with own data properties.
Node IDs are a dense, sorted, unique array without extra properties. IDs, natural-number positions,
range ordering, and source-exact UTF-16/UTF-8 spans are validated before classification. Accessors,
symbols, unknown keys, sparse arrays, reversed ranges, and malformed limits fail closed with a typed
`StatementClassifierError`.

Default limits bound source text to 65,536 UTF-16 units, node IDs to 4,096, normalized tokens to
8,192, and retained evidence to 64. Hard ceilings are exported. Limits are checked before retaining
data.

The Unicode normalization choice follows
[Unicode Standard Annex #15](https://unicode.org/reports/tr15/), reviewed on 2026-08-02. Domain
templates are product policy defined by this repository, not behavior claimed from a vendor
specification.
