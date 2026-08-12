# `@agent-context/syntax`

Internal bounded syntax adapters. D03 adds a generic AGENTS Markdown adapter that converts one
authorized byte sequence into shared source/AST/instruction records without assigning Codex
discovery or activation semantics. D12 adds `parseCursorRuleSyntax`, a syntax-only Cursor MDC and
legacy `.cursorrules` adapter built on the defensive C07 frontmatter parser and C09 inert reference
lexer.

See [the AGENTS Markdown API contract](../../docs/api/agents-markdown.md) and
[the Cursor rule syntax API contract](../../docs/api/cursor-rule-syntax.md). Filesystem reads belong
to the root-jailed evidence layer; this package performs no repository I/O, target resolution,
activation, relevance selection, execution, model calls, or networking.

D10 adds the Gemini context Markdown adapter and a closed `settings.json` reader/merger. Settings
bytes and layer metadata must be supplied explicitly; environment placeholders stay inert, and the
package never inspects a Gemini home or process environment. See the
[Gemini CLI profile contract](../../docs/api/gemini-cli-profile.md).
