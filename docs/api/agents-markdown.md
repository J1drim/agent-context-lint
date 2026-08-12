# AGENTS Markdown syntax adapter

`@agent-context/syntax` exposes `parseAgentsMarkdown` for the document-syntax half of D03. It parses
exactly one caller-authorized byte array as Markdown and returns the shared source, AST,
instruction-document, and statement records.

The adapter deliberately does not discover files, infer a client, resolve imports, interpret path
language in prose, assign activation rules, classify statements, read the filesystem, execute
commands, or access the network. Codex discovery and assembly live in the profile resolver. This
separation prevents ordinary Markdown wording from becoming invented client behavior.

## Input and result

The closed input contains:

- `bytes`: a plain `Uint8Array`, capped at the shared Markdown parser's 512 KiB byte limit;
- `contentStatus`: `complete` or `truncated`;
- `path`: a canonical repository-relative source path capped at 16 KiB;
- `scopeRoot`: a canonical repository-relative scope capped at 16 KiB that must contain `path`.

The immutable result records SHA-256 identity, byte and UTF-16 lengths, BOM and line-ending facts,
lossy UTF-8 status, Markdown recovery issues, source nodes, and unclassified instruction statements.
A truncated model-visible prefix is `partial`. Malformed UTF-8 is decoded with U+FFFD and
represented as `malformed`; no exception hides the available evidence.

`AgentsMarkdownError` is reserved for invalid containers and resource bounds. Inputs are copied
after rejecting proxies, accessors, subclasses, sparse/exotic arrays, extra properties,
non-canonical paths, and out-of-scope paths.

Suppression syntax is not interpreted by this adapter. Suppression processing applies later to
diagnostics, so Markdown that resembles a suppression directive remains ordinary source text here.

## Safety and determinism

The adapter is synchronous, deterministic, model-free, and side-effect free. It performs no I/O. IDs
depend only on the canonical path and exact authorized bytes. The caller retains responsibility for
obtaining those bytes through the root-jailed read-only repository facade.

See the [Codex CLI profile resolver](codex-cli-profile.md) for filename selection, root-to-CWD
ordering, byte budgeting, and external-context policy.
