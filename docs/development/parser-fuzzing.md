# Parser property and fuzz regression suite

C12 continuously replays deterministic malformed/extreme inputs across the Markdown/extraction,
YAML/MDC frontmatter, import lexer and graph, ignore/glob, and explicit POSIX/Windows path surfaces.
The suite is an ordinary integration test, so it runs in every `pnpm test` and cannot silently
bitrot.

The design follows the official LLVM libFuzzer guidance that a fuzz target be narrow, deterministic,
fast, tolerant of arbitrary input, and free of process exits, and that saved corpus inputs double as
regression tests. It also follows OSS-Fuzz's recommendation to keep fuzz targets and a bounded seed
corpus in revision control and replay the corpus continuously. Sources were retrieved 2026-08-02:

- [LLVM libFuzzer target and corpus guidance](https://llvm.org/docs/LibFuzzer.html)
- [OSS-Fuzz ideal integration](https://google.github.io/oss-fuzz/advanced-topics/ideal-integration/)

This ticket supplies deterministic property mutation and corpus replay inside Vitest; it does not
claim native sanitizer instrumentation or continuous coverage-guided fuzzing. A future native fuzz
service may consume the same minimized regressions, but the normal repository gate stays offline.

## Corpus contract

[`tests/fixtures/fuzz/parser-surfaces.v1.json`](../../tests/fixtures/fuzz/parser-surfaces.v1.json)
is the persisted v1 corpus. It pins `mulberry32-v1`, six unsigned 32-bit seeds, 24 cases per seed,
and explicit minimized regressions for every target surface. Its closed runtime validator rejects
unknown/missing fields, non-dense arrays, invalid dialect/flavor identifiers, malformed seed values,
or bounds outside the committed ceilings before any target runs.

The committed ceilings are 16 seeds, 256 generated cases per seed, 4,096 UTF-16 units and 8,192
UTF-8 bytes per generated input, 64 persisted cases, and 65,536 serialized persisted-case bytes.
Tests replay two independent generators from every seed and require byte-identical inputs and
JSON-identical results or typed failures. Do not raise a ceiling merely to retain a large failure:
minimize the reproducer first.

## Required properties

Every target must:

- return deterministically or throw only its documented typed error;
- keep source ranges inside the exact source UTF-16 and UTF-8 bounds;
- keep import reads canonical, in-root, and limited to the generated source map;
- keep ignore decisions inside the supplied canonical path set;
- expose no C0/C1, terminal escape, or bidirectional control in messages, issue codes, or operation
  labels; source slices remain untrusted data and are deliberately not treated as emitted messages;
- stay inside target item/work ceilings; and
- fail finitely on the committed delimiter-run, YAML-depth/scalar, import-specifier, glob-work,
  import-fan-out, cycle, and long-path regressions.

The test deliberately uses deterministic work/item limits instead of brittle wall-clock assertions.
Production deadlines remain defense in depth, while the regression evidence is stable across CI load
and supported platforms.

## Running and extending

Run the complete suite:

```sh
pnpm test:fuzz
```

Replay one persisted seed or minimized regression with Vitest's name filter, for example:

```sh
pnpm exec vitest run tests/fuzz/parser-surfaces.integration.test.ts -t "Markdown seed 3090"
pnpm exec vitest run tests/fuzz/parser-surfaces.integration.test.ts -t "yaml-self-alias"
```

When a generated case fails, record the seed, minimize the exact input, add it under the matching
`regressions` surface with a stable descriptive ID, and keep the seed if it still expands useful
coverage. Never persist repository content, credentials, absolute paths, timestamps, random default
seeds, or raw crash logs. A parser defect belongs in the owning package with a narrow unit
regression as well as this cross-surface corpus.
