# Targeted suppression directives

Ticket B08 implements the closed, source-exact suppression grammar in the private
`@agent-context/syntax` composition layer. Public `@agent-context/core` retains only the B04
suppression transport contracts and validation. The processor consumes a complete B03
`InstructionIr`, emits B04 `applicable` suppression records plus ephemeral range attachments, and
resolves those records to `suppressed` or `unused` against a B04 diagnostic bundle. It is
synchronous, deterministic, offline, read-only, and does not execute or render repository content.

## Grammar

Version `agent-context-lint-disable-next-line/v1` has one directive:

```markdown
<!-- agent-context-lint-disable-next-line ACL250, ACL300 -- package is intentionally standalone -->
```

The complete directive must be a closed CommonMark HTML comment on one physical line. A standalone
comment may have zero through three literal ASCII spaces before it, as CommonMark permits; four
spaces or a leading tab make the line indented code and therefore inert. It contains:

1. the exact, case-sensitive `agent-context-lint-disable-next-line` keyword;
2. one or more comma-separated rule IDs in the closed `ACL100`–`ACL999` syntax;
3. optionally, horizontal whitespace, `--`, horizontal whitespace, and a non-empty reason.

Whitespace around rule IDs and commas is ignored. Rule IDs are made unique and sorted by UTF-8
bytes; duplicates are malformed rather than silently normalized. `*`, `all`, `ACL*`, empty entries,
unknown directive names, non-ACL IDs, multiline comments, unclosed comments, and malformed reasons
never produce suppression authority. A syntactically valid future ID such as `ACL999` is retained
and becomes unused when it matches no diagnostic; B09 owns the rule registry and can later report
whether the ID is registered.

Only B03 `html-comment` nodes whose unchanged source range independently reparses through the
bounded `@agent-context/markdown` CommonMark 0.31.2 adapter as an HTML comment are candidates.
Lookalike text in prose is inert. This independent source pass handles container-relative fenced and
indented code, code spans with exact delimiter-run matching, backslash escapes, and a file-opening
YAML/MDC `---` envelope; it does not grant authority solely because a caller supplied or relabeled
an AST node. HTML-comment text inside those contexts is inert even if a forged-but-valid B03 graph
elides or relabels its ancestors. An unclosed file-opening frontmatter envelope is authority-denying
through end of source. A normal prose paragraph, blockquote, or list may contain an actual HTML
comment; `disable-next-line` still targets the following physical source line.

## Range, ownership, rule, and profile semantics

The directive location is the exact half-open B03 range of the HTML comment, including permitted
leading/trailing spacing when the CommonMark parser includes it in the block range. Its attachment
is the exact content range of the immediately following physical line, excluding LF, CRLF, or
bare-CR line terminators. Blank lines are not skipped. A directive at end of file has no target and
is invalid. Byte offsets, UTF-16 offsets, lines, and columns are derived from the unchanged B03
source, including BOM, tabs, CRLF, and astral Unicode. Authority-bearing positions are copied and
frozen; later mutation of a caller-owned IR cannot retarget a parsed directive.

A diagnostic matches only when all of these facts agree:

- its primary source ID is the directive owner's source ID;
- its primary range starts on the attached physical line; and
- its exact rule ID is listed by the directive.

There is deliberately no profile selector in v1. A source/rule/line match applies to diagnostics for
every profile, surface, and specification snapshot. The narrow source, rule, and line boundaries are
still mandatory. A future profile qualifier would require a new grammar version rather than an
undocumented interpretation of v1.

If multiple directives could claim one diagnostic, canonical source-path/offset/ID order gives it to
the first directive; later duplicates remain unused. A diagnostic is therefore suppressed at most
once. Matching is indexed by source, line, and rule, so diagnostic registration order does not
choose the owner. Matched path fingerprints are unique and sorted. The resulting bundle remains
valid B04 transport data and retains all diagnostics; `visibleDiagnostics` and
`suppressedDiagnostics` are separate views for the future F15 scheduler.

## API

```ts
import { matchSuppressionDirectives, parseSuppressionDirectives } from "@agent-context/syntax";

const parsed = parseSuppressionDirectives(validatedIr, {
  requireReason: true,
});

// ACL108 can consume parsed.issues. Malformed entries are absent from parsed.directives.
const applicableBundle = {
  recordKind: "agent-context-diagnostics",
  contractVersion: "0.1.0",
  diagnostics,
  suppressions: parsed.directives.map((entry) => entry.record),
};

const resolved = matchSuppressionDirectives(
  applicableBundle,
  parsed.directives,
  validatedIr.sources,
);

// ACL109 can consume records whose state is "unused".
console.log(resolved.bundle.suppressions);
```

This is an internal workspace API used by the product pipeline, not a published consumer entry
point. Integrations exchange the resulting B04 records through `@agent-context/core`; they do not
receive parser-issued attachment authority.

`requireReason` defaults to `false`; this is the B08 library policy switch, not repository
configuration discovery. B06/B07 own the eventual configuration key and precedence. The parser
returns stable issue codes and source locations for broad rules, duplicate/invalid rules, malformed
syntax, a required-but-missing reason, a missing target line, unknown directives, and resource
limits. It does not emit ACL108/ACL109 diagnostics itself because F05/B09 own rule metadata and F15
owns scheduling.

Parsed attachments are intentionally ephemeral and branded. Matching accepts only attachment objects
produced by the same processor instance and requires the B04 bundle's applicable records to match
them exactly. This prevents a caller from forging or widening an attachment while still allowing
normal array copies and property-order-independent JSON transport of the B04 records.

## Limits and failure behavior

Callers may only tighten these hard ceilings:

| Limit                             | Default and hard ceiling |
| --------------------------------- | -----------------------: |
| Candidate directive comments      |                    1,024 |
| UTF-8 bytes per candidate comment |                    4,096 |
| Rules per directive               |                       64 |
| UTF-8 bytes per reason            |                    1,024 |
| Retained parse issues             |                      128 |

When the issue limit is reached, the final retained issue is a deterministic `resource-limit`
sentinel. Candidate processing stops at its cap. B03 validation rejects proxies, revoked proxies,
accessors, sparse/deep/exotic graphs, malformed Unicode, and inconsistent ranges before directive
inspection. B08 options are also a closed own-data contract; getters are never invoked, inherited
policy is rejected, and the only accepted prototypes are `Object.prototype` and `null`. Errors at
API trust boundaries use `SuppressionProcessorError` with stable codes and never copy repository or
third-party exception text.

Before building source/node maps, collecting or sorting candidates, or reparsing any source, the
processor also enforces non-configurable trust-boundary ceilings: 1,024 sources, 50,000 total B03
nodes, 1,024 potential `html-comment` nodes, and the C06 limits of 524,288 UTF-16 code units and
524,288 UTF-8 bytes per source. These checks use already-validated B03 length metadata, so an
oversized forged graph cannot reach CommonMark or obtain suppression authority. Breaches raise
`SUPPRESSION_RESOURCE_LIMIT`.

Malformed, unknown, broad, over-budget, or unowned inputs fail closed: they cannot hide any
diagnostic. B08 performs no global ignore, regex rule selection, profile inference, configuration
discovery, rule scheduling, diagnostic sorting, or filesystem operation.
