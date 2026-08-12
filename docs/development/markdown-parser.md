# Developing the Markdown parser

The C06 implementation lives in `packages/markdown`. Read the
[public parser contract](../api/markdown-parser.md), the
[B03 instruction IR](../api/instruction-ir.md), and the [threat model](../security/threat-model.md)
before changing it.

## Mapping into B03

The parser deliberately adapts mdast instead of exposing it across a package boundary:

| mdast type                  | B03 kind                             |
| --------------------------- | ------------------------------------ |
| `root`                      | `root`                               |
| `heading`                   | `heading`                            |
| `paragraph`                 | `paragraph`                          |
| `list` / `listItem`         | `list` / `list-item`                 |
| `blockquote`                | `block-quote`                        |
| `code` / `inlineCode`       | `code-block` / `inline-code`         |
| `link`                      | `link`                               |
| `html` containing a comment | `html-comment`                       |
| `text`                      | `text`                               |
| every other CommonMark node | `unknown` with its mdast syntax kind |

This preserves the reviewed B03 union. C08's `extractMarkdownContent` builds immutable structural
views over those same node IDs and ranges; it does not introduce another AST or source-position
contract. Never add a local source-position or AST contract to work around B03. Propose a B03 change
separately if a new shared representation is required.

All parser offsets are ignored except `position.start.offset` and `position.end.offset`. C06 derives
byte offsets, lines, and UTF-16 columns from the exact original text. This is essential for CRLF,
bare CR, tabs, astral characters, and the leading-BOM translation. Do not use mdast line/column
fields directly.

Unclosed-fence recovery uses a closed mdast compile extension that records micromark's own opening
and closing fence tokens. The extension replaces one upstream exit handle and therefore preserves
that handle's `buffer()` and `flowCodeInside` transitions. Do not replace this with raw-line
matching: blockquote and list container prefixes differ between opening and closing lines.

## Defensive implementation rules

- Validate the complete API boundary before calling the parser. Never read input or option
  accessors.
- Keep the parser plug-in list closed and code-free. Profile-specific extensions belong in reviewed
  syntax-adapter tickets.
- Add every new recovery diagnostic to the issue union, resource cap, deterministic parse-state
  reason, and positive/negative tests.
- Preserve exact half-open ranges. Each child must be contained by its parent, and sibling ranges
  must remain ordered and non-overlapping for the B03 validator.
- Do not normalize source text or emit rendered Markdown/HTML.
- Keep reference uses and definitions separate. Resolution, filesystem decisions, and import
  semantics belong to C09/C10 and syntax adapters, not C08.
- Keep paragraphs nested in list items as well as the containing list-item candidates. Consumers,
  rather than the CommonMark layer, own statement-granularity policy.
- Preflight every extractable range before creating the first `original` slice. Count overlapping
  list-item and paragraph ranges independently in both UTF-16 units and UTF-8 bytes, and retain the
  distinct `MARKDOWN_EXTRACTION_RESOURCE_LIMIT` identity so callers can distinguish output
  amplification from parser input limits.
- Bound work before parsing where practical. Post-parse node/depth limits complement, but do not
  replace, the C02 outer cancellation boundary and the [C12 fuzz corpus](parser-fuzzing.md).

## Verification

During development run:

```sh
pnpm build
pnpm exec vitest run --project unit packages/markdown/test/markdown-parser.unit.test.ts
pnpm coverage
pnpm check
```

Tests must include valid, malformed, boundary, mixed-newline, byte/UTF-16, astral, tab, BOM,
unpaired-surrogate, resource-limit, proxy, accessor, and exact original-slice cases. C08 tests must
also cover paragraphs/list items, direct links, full/collapsed/shortcut reference uses, definitions,
and inert code/comment/escaped syntax. Cumulative extraction-budget tests must include exact and
one-unit-over boundaries, multibyte text, overlapping nested-list candidates, and a default-limit
amplification case. At least one test must insert all emitted nodes into a complete B03 IR envelope
and pass `validateInstructionIr`.
