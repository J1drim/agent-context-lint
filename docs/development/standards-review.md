# Reviewing an upstream standards change

H11 is the offline review stage after H10 capture. It accepts an older reviewed H10
source/provenance pair and a candidate pair, verifies both byte-for-byte against the committed exact
source catalog, then writes a draft review into one new local directory. It cannot fetch, interpret
semantics, change fixtures, invoke Git, open an issue or pull request, upload an artifact, sign a
pack, or publish.

## Generate a draft

Use canonical real paths. The output directory must not exist and its parent must contain no symlink
component.

```sh
pnpm standards:review -- \
  --baseline-source /private/path/baseline/upstream-source.v1.json \
  --baseline-provenance /private/path/baseline/upstream-provenance.v1.json \
  --candidate-source /private/path/candidate/upstream-source.v1.json \
  --candidate-provenance /private/path/candidate/upstream-provenance.v1.json \
  --output-dir /private/path/new-review
```

H11 creates the directory as `0700` and the fixed review, scaffold, and Markdown files as `0600`.
Creation is exclusive; any write failure removes only that newly created directory. Existing output,
symlinked parents, symlink inputs, hard-linked inputs, non-regular files, concurrent input changes,
oversized input, malformed H10 artifacts, and a candidate date older than the baseline fail closed.
Errors do not echo path contents or upstream text.

## Replay a draft

```sh
pnpm standards:review:verify -- \
  --baseline-source /private/path/baseline/upstream-source.v1.json \
  --baseline-provenance /private/path/baseline/upstream-provenance.v1.json \
  --candidate-source /private/path/candidate/upstream-source.v1.json \
  --candidate-provenance /private/path/candidate/upstream-provenance.v1.json \
  --review /private/path/review/upstream-review.v1.json \
  --scaffold /private/path/review/upstream-fixture-scaffold.v1.json \
  --markdown /private/path/review/upstream-review.v1.md
```

Replay is offline and succeeds only if regenerated files match all supplied bytes. It distinguishes
raw-page-only changes from changes inside selected text, caps evidence to 48 lines per side and 512
input bytes per displayed line, and binds all omitted content through complete hashes and counts.

## Required human work

For every pending scaffold entry:

1. Open the bound raw and normalized H10 snapshots as untrusted data and compare the official URL.
2. Determine whether the changed prose documents syntax, discovery, scope, imports, limits, or
   behavior relevant to a supported surface. A changed webpage alone proves none of these.
3. Record ambiguity, version dependence, undocumented behavior, and observed-versus-documented
   differences. Never invent precedence or activation semantics.
4. Reproduce the reviewed behavior in a minimal synthetic fixture owned by this repository. Do not
   copy a third-party repository or prepare an upstream patch.
5. Run the affected profile conformance tests and obtain maintainer review.
6. Hand any accepted data-only change to the separate threshold-protected pack process. Engine
   semantics require an engine change. H11 grants neither publication authority.

The committed golden
[`golden-document-change.v1.json`](../../tools/standards/fixtures/h11/golden-document-change.v1.json)
contains one synthetic changed section for each of the six official source/profile families. Tests
pin the exact review, scaffold, and Markdown SHA-256 values, validate both closed schemas, replay
the CLI with network and command capabilities denied, and cover hostile text, truncation,
chronology, tampering, links, permissions, and malformed input.

Required verification:

```sh
pnpm test:standards-tools
pnpm check
```
