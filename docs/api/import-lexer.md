# Syntax-specific import lexer

Ticket C09 adds the internal `@agent-context/syntax` import lexer. It recognizes conservative vendor
`@` reference tokens in already decoded instruction text, maps them to B03 `ImportReference`
records, and returns the exact C06/C08 Markdown parse used to classify code and comment regions.

The lexer does not resolve paths, inspect the filesystem, follow imports, test containment, load
URLs, execute repository content, or infer that a running client activated a file. C10 owns safe
target resolution, repository boundaries, cycles, graph limits, and reads.

## API

```ts
import { lexImportReferences } from "@agent-context/syntax";

const result = lexImportReferences({
  documentId,
  sourceId,
  syntax: "claude-code",
  text: exactDecodedUtf8Text,
});
```

Supported syntax identifiers are `claude-code`, `copilot-cli`, `cursor-agent`, and `gemini-cli`. The
contract version is `0.1.0`. The result contains immutable `imports` in source order and the
immutable `markdown` extraction used by the lexer.

Each import has:

- a deterministic B03 ID derived from document identity, dialect, source identity, and exact text;
- an exact half-open token range covering `@specifier`;
- an exact specifier range whose source slice equals `rawSpecifier`;
- the deepest C06 AST node that contains the complete token, falling back to its parent when an
  intentionally ambiguous token crosses a Markdown delimiter;
- a lexical target class only: repository-path candidate, absolute-path candidate, URL, malformed,
  or unknown; and
- `recognized`, `malformed`, or `ambiguous` state with mandatory B02 uncertainty.

UTF-16 offsets use JavaScript slicing. Byte offsets address the same boundary in the original UTF-8
source. Lines and columns are zero-based, preserve CRLF/bare-CR/LF/mixed endings, and count UTF-16
code units without visual tab expansion.

## Dialect matrix

The lexer keeps document grammar separate from client-profile activation. An adapter must call the
Copilot dialect only for file families where the selected CLI surface documents reference expansion;
recognition here does not make the syntax universal across Copilot surfaces.

| Dialect     | Conservative token boundary                                                                                                 | Code and comment treatment                                                                                                                                                                                    | Certainty                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | `@path` at content or prose-token boundaries; whitespace terminates the candidate                                           | Inline code, fenced/indented code, and HTML comments are excluded. Escaped tokens are literals.                                                                                                               | Simple path tokens are known; bare mentions and punctuation-dependent endings are ambiguous.                                               |
| Copilot CLI | Simple relative `@path` candidates at content or prose-token boundaries                                                     | Plain simple references are recognized. Code/comment occurrences are retained as ambiguous because the reviewed CLI material does not define that tokenization.                                               | Bare mentions and undocumented boundary cases remain unknown. Absolute candidates are retained for C10/profile rejection rather than read. |
| Gemini CLI  | `@` at content start or after ECMAScript whitespace; first path unit is `.`, `/`, or an ASCII letter; whitespace terminates | Matched backtick inline/fenced regions are excluded. Tilde/indented code is retained with explicit documentation-versus-source contradiction. HTML comments are scanned, matching the pinned source behavior. | The pinned source grammar is known; contradicted code-region cases are ambiguous.                                                          |
| Cursor      | Conservative `@` candidates, including escaped occurrences                                                                  | Code, comment, punctuation, quoting, and escaping cases are retained rather than discarded.                                                                                                                   | Every token is ambiguous because exact reference grammar and code-region treatment are explicitly unknown in the D11 evidence.             |

An email-like `name@example.com` is not a candidate because `@` has no allowed token boundary.
Tokens never absorb whitespace. The lexer deliberately preserves punctuation in the raw span and
marks uncertain endings ambiguous instead of silently trimming source text.

The matrix is based on the repository's pinned first-party research:

- [Claude Code compatibility](../profiles/claude-code/compatibility.md), import cases `CC-IMPORT-01`
  through `CC-IMPORT-14`;
- [Copilot surface support](../profiles/copilot-surface-support.md), especially `COP-PRE-005` and
  the CLI reference/boundary rows;
- [Gemini CLI compatibility](../profiles/gemini-cli/compatibility.md), facts `GEM-IMP-001` through
  `GEM-IMP-007`; and
- [Cursor compatibility](../profiles/cursor/compatibility.md), cases `CURSOR-REF-01` through
  `CURSOR-REF-10`.

Those records pin URLs, retrieval dates, versions or immutable source revisions, and
documented-versus-observed differences. C09 does not replace their profile semantics.

## Resource and hostile-input boundary

C06 first enforces its 512 KiB UTF-16 and UTF-8 ceilings, well-formed Unicode, parser node/depth,
delimiter, and extraction-amplification limits. C09 adds limits that callers may tighten but never
raise:

| Limit                   | Default and hard ceiling |
| ----------------------- | -----------------------: |
| emitted candidate count |                    4,096 |
| one specifier           |  4,096 UTF-16 code units |

Exact-boundary inputs succeed; the first unit or candidate over a limit fails the complete call with
`ImportLexerError` code `IMPORT_LEXER_RESOURCE_LIMIT` and a stable `limitName`. Invalid or widened
limits fail with `IMPORT_LEXER_INVALID_LIMIT`. Invalid API containers fail with
`IMPORT_LEXER_INVALID_INPUT`. Existing `MarkdownParserError` identities remain intact for C06/C08
input, Unicode, parse, and extraction failures.

Inputs and options must be non-proxy objects containing only documented own data properties.
Accessors, symbols, unknown fields, exotic prototypes through proxies, invalid stable IDs, and
unsupported dialects fail before source parsing. The closed input and option schemas bound the
own-key count before any property descriptor is read, then inspect only individually allowed own
data descriptors; oversized records and accessors therefore cannot trigger bulk descriptor
materialization or execute caller code. Explicit null or undefined limit values are invalid rather
than being treated as absent. Error text never includes repository content or a hostile field name.

The implementation performs one bounded source scan, builds disposition intervals in C06 source
order, and associates emitted tokens through bounded AST descent. It performs no model call, clock,
randomness, filesystem, environment, subprocess, telemetry, or network operation.
