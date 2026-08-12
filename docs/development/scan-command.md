# Developing the production scan command

I02 composes existing issued contracts rather than implementing parallel discovery, parsing,
resolution, rule, accounting, or formatting logic. `packages/cli/src/scan-command.ts` performs C01
root selection, B07 configuration, C02/C03/C04 discovery, syntax-specific parsing, genuine C10/E04
import graphs, D-series profile resolution, E01/E05/E08 activation and target resolution, G03-G08
efficiency analysis, F15 scheduling, B08 suppression, and I04-I06 formatting.

The B06 configuration is applied at its owning contract boundary: package-manager selection enters
C06 evidence, import depth/fan-out enter C10, `ACL350.maxTokens` enters F10, efficiency thresholds
enter G07, and security allowances enter F15 policy. Explicit CLI/rule policy wins over broad
allowances. Unknown configured rule IDs remain inert so an older binary can scan a configuration
written by a newer rule catalog without inventing semantics.

Target sampling starts from `classifyTargetSourcePath()` over the exact tracked source universe.
Activation observations are computed before `sampleTargets()` so path-specific rules cannot vanish
from a stratified sample. Every profile accounting uses only DAGs applicable to that exact issued
E05 context. A loaded import absent from the context document evidence is unknown, not implicitly
active. Profiles never receive raw or effective tokens from another profile's documents.

G04 requires one G03 accounting per sampled target. When a profile target has no applicable
instruction DAG, the composition builds E04's issued shape from a closed, complete zero-document C10
transport and accounts its zero documents. It never probes `.git` or another sentinel path, which is
essential for linked worktrees where `.git` is a regular pointer file. This graph is used only for
G03/G04, is never added to B03 or F06, and cannot fabricate an import diagnostic. Packaged and
source-only fixtures assert complete zero totals and no findings.

Before F05 issues the shared B03 snapshot, documents, imports, graphs, policies, and provenance are
filtered to the selected profile/surface authorities as one coherent repository view. This keeps
unrelated vendor syntax out of every downstream family and preserves F15's exact-snapshot invariant.
References-import targets are then deduplicated by import, format, profile, and surface because the
same profile authority applies across sampled target paths. Incompatible import dialects can assign
different issued document identities to the same path; the scan fails conservatively instead of
silently discarding a graph. Repository-controlled values are never included in user-facing
operational errors.

G08 scenarios are produced only for exact whole-document duplicate candidates whose import and
activation projections can be reconstructed from issued evidence. The projected E05 resolution is
rerun in memory. If exact token or retention proof is unavailable, G08 reports an indeterminate
scenario rather than recommending a rewrite. Profile versions are aggregated across surfaces;
disagreeing client versions become `null`, while disagreeing profile contract versions fail closed.

Verification must include focused scan/router tests, test TypeScript, the affected resolver,
efficiency, rules, formatter, and fix suites, generated CLI documentation, package boundaries,
security controls, and the extracted-tarball gate. The tarball scan runs under child-process,
socket, and filesystem-write denial and compares repository snapshots before and after.

I02 ships scan as a closed Node 24 ESM bundle. `@agent-context/core` and Node built-ins are the only
external imports; all private engines and third-party JavaScript are embedded. The esbuild metafile
is canonicalized and audited, an external source map is checked for absolute build paths, and
`THIRD_PARTY_NOTICES` is regenerated from the exact bundled third-party inputs. The signed standards
trust tree is copied byte-for-byte as runtime data.

JSON diagnostics are streamed through I05 with bounded chunks and backpressure. Stylish, SARIF, and
fix-preview output is preflighted against the CLI total-output limit and emitted in
Unicode-scalar-safe chunks. CI standards timestamps are normalized to the UTC day so repeated runs
do not vary with wall-clock seconds.

`pnpm build` and package `prepack` always run the bundle after TypeScript. `pnpm cli:bundle:check`
builds twice in memory, proves deterministic bytes, and compares every generated artifact and trust
file with disk. The pack gate constructs the CLI tarball twice and requires identical bytes, then
extracts it, installs only the exact packed public core artifact, and runs the guarded black-box
scan. See [ADR 0005](../architecture/decisions/0005-closed-cli-scan-bundle.md).
