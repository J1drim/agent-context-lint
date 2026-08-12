# Tolerant Markdown parser API

Tickets C06 and C08 provide the internal `@agent-context/markdown` parser and structural extractor.
They turn exact decoded UTF-8 Markdown into the existing B03 `AstNode`, `SourceRange`, and
`SourceParseState` contracts, then expose source-exact structural views for syntax adapters. They do
not discover files, parse frontmatter, resolve links, classify instruction prose, or execute
repository content.

## Compatibility contract

The syntax identifier is `commonmark-0.31.2`. The implementation uses
`mdast-util-from-markdown@2.0.3`, whose parser is micromark, with no plug-ins or extensions. The
compatibility choices follow the
[CommonMark 0.31.2 specification](https://spec.commonmark.org/0.31.2/) and the
[remark parser documentation](https://github.com/remarkjs/remark) as retrieved on 2026-08-02.

- CommonMark blocks and inlines are recognized. GFM, MDX, MDC, YAML frontmatter, and vendor import
  extensions are not enabled by C06.
- A leading U+FEFF is retained in the root source range. Micromark consumes it before parsing, so
  C06 translates all parser offsets back to the untouched source.
- LF, CRLF, bare CR, mixed line endings, and tabs are preserved. Lines and columns are zero-based;
  columns count JavaScript UTF-16 code units and do not expand tabs visually.
- Unclosed CommonMark fences and HTML comments remain usable nodes and produce bounded recovery
  issues. Other syntax that CommonMark accepts through normal recovery is returned without an
  invented error.
- A CommonMark ordered list starting at zero becomes an `unknown` node because the reviewed B03
  contract requires positive ordered-list starts. The parser does not broaden that shared contract.

## API

```ts
import { parseMarkdown } from "@agent-context/markdown";

const result = parseMarkdown({
  sourceId,
  text: exactDecodedUtf8Text,
});
```

`parseMarkdown` returns:

- `syntax`, currently `commonmark-0.31.2`;
- `rootNodeId` and `nodes` in deterministic pre-order;
- `issues` for explicitly detected tolerant-recovery cases;
- `parseState`, either `complete` or `partial` with a deterministic reason.

Every node uses a half-open range. `utf16Offset` is suitable for `String.prototype.slice`, while
`byteOffset` addresses the same boundary after UTF-8 encoding. Consumers can therefore prove an
original-slice round trip:

```ts
const original = text.slice(node.range.start.utf16Offset, node.range.end.utf16Offset);
const originalBytes = Buffer.from(text, "utf8").subarray(
  node.range.start.byteOffset,
  node.range.end.byteOffset,
);
```

Node IDs hash the B03 source ID and exact text, then append the pre-order index. Repeating a parse
is byte-deterministic; changing either source identity or content prevents stale node references
from matching. Returned records, arrays, positions, ranges, and issues are frozen.

### Structural extraction

`extractMarkdownContent` applies the same parser, validation, recovery, and resource limits once and
returns the parse result plus immutable source-order collections:

```ts
import { extractMarkdownContent } from "@agent-context/markdown";

const extracted = extractMarkdownContent({ sourceId, text: exactDecodedUtf8Text });
for (const statement of extracted.statements) {
  // `original` is the exact paragraph or list-item source, including Markdown markers.
  console.log(statement.kind, statement.original, statement.range);
}
```

- `headings` retains the heading depth and original marked-up slice;
- `statements` exposes paragraphs and list items as candidates without classifying or normalizing
  them;
- `codeBlocks` retains the parser language and metadata fields and the complete fenced or indented
  source slice;
- `links` retains inline-link destinations and titles without fetching or resolving them; and
- `references` retains CommonMark link-reference uses and definitions independently. Uses are not
  joined to definitions, and missing definitions remain ordinary source rather than invented links.

Every extraction has the exact C06/B03 `nodeId` and `range`. `original` must equal
`text.slice(range.start.utf16Offset, range.end.utf16Offset)`. Paragraphs nested in list items are
retained alongside their containing list item so downstream syntax adapters can choose their own
statement granularity without losing source structure. Code, HTML comments, escaped link syntax, and
image syntax never create link/reference extractions.

Extraction also has cumulative output budgets. Before creating any `original` string, the API walks
all extractable ranges and totals both their UTF-16 lengths and their source UTF-8 byte lengths.
Overlapping candidates count independently: for example, a list-item slice and its nested paragraph
slice both contribute their full lengths. This prevents deeply nested valid Markdown from amplifying
a bounded input into unbounded copied strings. Callers may tighten, but never raise, these defaults:

| Extraction limit             |    Default | Hard ceiling |
| ---------------------------- | ---------: | -----------: |
| `maxExtractedUtf16CodeUnits` |  4,194,304 |    4,194,304 |
| `maxExtractedUtf8Bytes`      | 16,777,216 |   16,777,216 |

An exact-boundary total succeeds. The first range that would make either total exceed its budget
fails the complete extraction before any extraction `original` slice is copied.

## Limits and failures

Options can only tighten the hard parser ceilings. Repository-controlled configuration cannot use
this API to grant the parser more resources than its production defaults:

| Limit               | Default | Hard ceiling | Applies before parser invocation |
| ------------------- | ------: | -----------: | :------------------------------: |
| `maxUtf8Bytes`      | 524,288 |      524,288 |               yes                |
| `maxUtf16CodeUnits` | 524,288 |      524,288 |               yes                |
| `maxDelimiterRun`   |   4,096 |        4,096 |               yes                |
| `maxNodes`          |  50,000 |       50,000 | no; bounded input applies first  |
| `maxDepth`          |     128 |          128 | no; bounded input applies first  |
| `maxIssues`         |      64 |           64 |       issue creation only        |

Limits are optional own data properties. Unknown keys, getters, setters, proxies (including revoked
proxies), non-integer values, and values outside the hard ceilings are rejected before their values
can influence parsing. `sourceId` must be a bounded B03 stable identifier. Unpaired UTF-16
surrogates are rejected because they cannot map unambiguously to the B03 decoded-UTF-8 source
contract. The constant-time UTF-16 length check runs before every content-dependent Unicode, byte,
or delimiter scan.

Failures throw `MarkdownParserError`. Its stable `code` is one of:

- `MARKDOWN_INVALID_INPUT`;
- `MARKDOWN_INVALID_LIMIT`;
- `MARKDOWN_MALFORMED_UNICODE`;
- `MARKDOWN_EXTRACTION_RESOURCE_LIMIT`;
- `MARKDOWN_RESOURCE_LIMIT`;
- `MARKDOWN_PARSE_FAILED`.

For limit failures, `limitName` identifies the exact parser or extraction boundary. Extraction
budget failures use `MARKDOWN_EXTRACTION_RESOURCE_LIMIT`, distinct from parser resource failures.
Parser-library exception text and source content are never copied into the public error.

## Safety properties

The parser is synchronous, deterministic, offline, and read-only. It performs no filesystem or
network access, loads no repository-selected plug-ins, resolves no link, renders no HTML, and never
evaluates code blocks or command-shaped text. HTML and link values remain inert data. C02 owns the
outer filesystem and cancellation boundary; C12 owns broader fuzz and known-superlinear regression
coverage.
