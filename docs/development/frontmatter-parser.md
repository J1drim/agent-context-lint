# Frontmatter parser maintenance

C07 is a security boundary. Changes require focused tests plus the full repository gate.

## Review checklist

- Preserve exact `---` envelope recognition and `invalid` → `denied` authority.
- Keep byte preflight before snapshot/decode and use typed-array intrinsics, not caller iteration.
- Keep fatal UTF-8 decoding, BOM rejection, source-exact CR/LF/CRLF and Unicode positions.
- Inspect the YAML document AST before constructing data; never convert aliases or custom tags.
- Count mapping keys, values, sequences, maps, entries, depth, scalar bytes, and issues before
  adding unbounded work to parser-owned stacks or result arrays.
- Build null-prototype, deeply frozen JSON values; never expose mutable `yaml` nodes.
- Return stable product diagnostics without parser/repository error text.
- Keep the parser pure: no filesystem, network, command, environment, clock, or dynamic module
  capability.

## Required regression families

Tests must retain positive YAML/MDC maps, absent/empty/unclosed envelopes, LF/CRLF/CR positions,
Unicode byte offsets, nested arrays/maps, JSON-pointer escaping, prototype-shaped keys, duplicate
keys, malformed syntax, directives, complex keys, invalid roots, tags, anchors, aliases and alias
amplification, every resource limit, malformed UTF-8, BOM/NUL input, non-JSON numbers, hostile
containers/options, typed-array subclass overrides, mutation snapshots, immutability, and repeated
determinism.

Run:

```sh
pnpm exec vitest run packages/syntax/test/frontmatter-parser.unit.test.ts
pnpm check
```

The generic C07 parser does not define vendor field vocabularies or activation semantics. Add those
only in the relevant D-stream adapter with its pinned profile evidence and negative fixtures.
