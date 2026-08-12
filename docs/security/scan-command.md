# Production scan security boundary

The normal `scan` command is deterministic, offline, model-free, read-only, and unable to execute
repository commands. Repository paths, bytes, Git metadata, Markdown, frontmatter, imports,
configuration, suppression comments, and thrown values are untrusted.

All filesystem authority comes from C01 and C02. Reads remain inside the selected root; traversal,
external links, hard links, special files, races, and repository-control paths fail closed. Import
loading uses C10 through the same facade. Network and process capabilities are absent. The packed
acceptance test additionally replaces child-process entry points, `net.Socket.connect`, and the
present `fetch`, `WebSocket`, and `EventSource` globals with immutable throwing guards. It proves
each global guard with a hostile subprocess, runs the real scan with filesystem-write permission
disabled, and verifies byte-identical repository snapshots.

During C03 fallback, non-negatable built-in directory patterns are pruned at any exact path segment
only after C02 proves the entry is a directory; a regular file named `vendor` or `node_modules`
remains visible. Oversized regular files are skipped with explicit uncertainty, while directory,
depth, entry-count, and total-work limits remain fatal. C05 accepts `known` built-in exclusions
during fallback alongside `tracking-uncertain` decisions, but exact Git-index enumeration permits
only `known` decisions.

Activation rules cannot broaden scope from malformed metadata. The source universe is classified by
E08's public exact classifier, work is capped before evaluating the path-by-rule matrix, and unknown
activation remains unknown. Imported occurrences require their own E05 path evidence and never
inherit the entry document's state.

`--fix-dry-run` cannot write. It runs the complete direct syntax evaluator, finalizes genuine B08
suppressions, admits only I12-approved plans, and asks I11 for a preview. JSON and SARIF
combinations are rejected so patch text cannot be confused with a structured diagnostic contract. No
apply capability is exposed by the command.

The public package does not depend on private engine packages at runtime. Its scan ESM bundle is
closed by an esbuild-metafile audit: only Node built-ins and `@agent-context/core` may remain
external. Both input dependency edges and emitted bundle imports are rejected if they reference a
network-capable Node builtin. Scan imports the narrow `@agent-context/efficiency/scan-runtime`
entrypoint, which contains only the deterministic estimate tokenizer; the optional exact-tokenizer
worker remains outside the scan dependency graph. The checked-in metafile and emitted output are
both tested to contain no `node:worker_threads` capability. Build warnings, residual imports,
absolute source-map paths, missing third-party license texts, or a standards trust-tree byte
mismatch fail packaging. Deterministic `THIRD_PARTY_NOTICES`, the build metafile, external source
map, and exact signed standards assets are included in the tarball for review.
