# Developing the import lexer

C09 lives in `packages/syntax/src/import-lexer.ts`. Read the
[public lexer contract](../api/import-lexer.md),
[Markdown parser contract](../api/markdown-parser.md),
[B03 instruction IR](../api/instruction-ir.md), and [threat model](../security/threat-model.md)
before changing it.

## Separation of responsibilities

- C06/C08 own Markdown recovery, AST nodes, exact source positions, and structural extraction.
- C09 owns only source-token recognition, syntax-region exclusion or ambiguity, lexical target
  classification, and creation of B03 `ImportReference` records.
- C10 owns path decoding, relative bases, canonical containment, symlink-safe reads, missing
  targets, cycles, recursion, fan-out, total bytes, and partial graph failures.
- D05/D07/D10/D12 decide which discovered file and client surface selects a dialect and whether a
  recognized import can be active.

Never add filesystem or client execution to the lexer. A target string is untrusted data even when
its lexical class is `repository-path-candidate`.

## Range and identity invariants

The token range includes `@`; `specifierRange` does not. `rawSpecifier` must equal the exact source
slice addressed by `specifierRange`, including punctuation or quoting retained for ambiguity. Both
ranges use C06's zero-based UTF-16/UTF-8 coordinate contract and must fit inside the selected AST
node. When a deliberately ambiguous token crosses a Markdown closing delimiter, select the nearest
containing parent instead of shortening the raw token.

Import IDs include the syntax dialect so the same source interpreted under two client grammars
cannot alias. The fixed-width source-order suffix keeps IDs and `InstructionDocument.importIds`
lexically ordered through the hard candidate ceiling.

## Complexity rules

- Let C06 reject oversized or malformed Unicode before any C09 content scan.
- Bound a public argument's own-key count before reading individual allowed data descriptors; never
  bulk-materialize descriptors or invoke accessors.
- Scan source monotonically. Never restart a regular expression at each `@`.
- Keep specifier work bounded before copying `rawSpecifier`.
- C06 emits nodes in deterministic pre-order; code/comment disposition ranges therefore retain
  nondecreasing starts without another sort.
- Locate the disposition interval with binary search and locate the owning node by descending the
  ordered B03 child ranges. Never compare every import with every AST node.
- Preflight the import-count limit before constructing the next B03 object. Return no partial result
  after any failure.

## Changing a dialect

Update a dialect only from pinned first-party documentation, source, or a versioned observation.
Keep syntax recognition separate from activation and resolution. Where documentation is silent or
contradicts pinned source, emit `ambiguous` with B02 `unknown` or `contradiction`; do not convert an
implementation guess into `known` behavior.

Any dialect change requires positive, negative, escaping, punctuation, inline/fenced/comment,
Unicode/range, malformed-input, exact-boundary, one-over-limit, determinism, and B03 integration
tests. Reproduce an external failure as a minimal repository-owned fixture rather than modifying the
external repository.

## Verification

During development run:

```sh
pnpm build
pnpm exec vitest run packages/syntax/test/import-lexer.unit.test.ts
pnpm coverage
pnpm check
```

The final ticket gate also inspects packed public artifacts. `@agent-context/syntax` is private and
must package only compiled `dist` output; tests and fixture content must remain excluded.
