# Metadata calibration contracts

K02 and K03 define eight closed draft 2020-12 JSON contract families at version `0.1.0`. These are
independent evidence-contract identities shipped with the stable `1.0.0` product release:

- `metadata-calibration-candidates.v0.schema.json` validates the frozen public GitHub sampling frame
  and retrieval provenance;
- `metadata-calibration-corpus.v0.schema.json` validates the deterministic 50-repository selection;
- `metadata-calibration-report.v0.schema.json` accepts future K03 error/warning observations using
  fingerprint identities only; and
- `metadata-calibration-adjudication.v0.schema.json` validates the complete maintainer review and
  reconstructible adjudication;
- `metadata-calibration-maintainer-authority.v0.schema.json` fixes the accountable reviewer and
  repository-owner merge acceptance boundary;
- `metadata-calibration-precision-evidence.v0.schema.json` binds the final report, adjudication,
  packed engine identity, F16 recall evidence, tuning ledger, and K06 holdout state;
- `metadata-calibration-native-proof.v0.schema.json` binds the exact Darwin filesystem, tool, quota,
  parent-confinement, zero-residual-cleanup, and actual build graph (vendored Node; exact pnpm
  complete bounded package inventory plus manifest-mapped ESM launcher, separately bound CJS
  compatibility shim, bundle, and manifest; esbuild wrapper, entry, manifests, and platform binary;
  and TypeScript wrapper, bin/runtime/resolver entries, manifests, and native compiler) or the
  closed not-yet-captured state; and
- `metadata-calibration-gate-state.v0.schema.json` binds readiness to that committed native proof.

The semantic validators add invariants that JSON Schema cannot express. Candidate IDs and names are
unique, entries are canonical UTF-8 ordered, URLs bind the public repository, instruction paths are
reclassified by the exact production C05 recognizer, tree metadata URLs bind the pinned tree, and
strata/traits reconstruct from evidence. The corpus binds the canonical candidate snapshot digest
and recomputes every assigned stratum and rank. Report diagnostics bind a selected repository and
are ordered by repository/rule/fingerprint. Reviews cover the report in exact order and bind its
digest and the closed repository-owned authority record. An adjudication hash-binds the exact
review, including its completion time, and reconstructs only from that supplied review file.

The calibration report deliberately has no fields for repository paths, diagnostic messages, source
snippets, suggestions, or fingerprint bases. Its `sourcePolicy` constants require fingerprint-only
output. Unknown and test-harness labels do not enter the precision denominator. Error and warning
summaries report raw true/false-positive counts, integer basis-point precision, and two-sided Wilson
95% bounds. The v1 gate uses the conservative lower Wilson bound—not the point estimate—and requires
at least 9,500 basis points for errors and 8,500 for warnings. With no false positives this requires
at least 73 reviewed errors and 22 reviewed warnings; K03 additionally requires at least 500
resolved error/warning diagnostics overall. Any `test-harness-defect` blocks release and requires
repair followed by a complete recapture. `uncertain-client-behavior` remains outside the precision
denominator but is bounded to both 25 diagnostics and 500 basis points of the reviewed population;
precision evidence records those counts and limits explicitly.

`diagnosticFingerprint` is exactly SHA-256 over canonical JSON containing the domain tag
`agent-context-lint:k03:diagnostic:v1`, repository ID, rule ID, B04 path fingerprint, B04 semantic
fingerprint, and severity. Validators recompute it. A tuning record may cite only a confirmed
false-positive fingerprint for the same rule and must identify sorted committed regression-test
paths and byte digests.

The report records packaged-default `severity` separately from repository-effective severity, so a
repository configuration cannot promote or demote the population being calibrated. It also binds the
exact private-review payload digest and complete public engine/runtime/tool identity. Reviews carry
that private digest and command-generated monotonic completion times. Those times establish
ordering, not a trusted timestamp or cryptographic signature; repository-owner merge is the human
acceptance boundary. Precision evidence hash-binds the authority, exact review, and adjudication and
reconstructs false-positive counts by rule, reason, assigned stratum, monorepository type, and
multiple-format trait.

The public engine identity includes the exact Git executable, canonical exec-path HTTPS-helper
link/target digest, `index-pack` and `unpack-objects` entries resolving to that Git executable, and
Darwin sandbox executable. The Git checkout harness retains the network/write/bound-child authority
needed to materialize pins; the distinct scanner authority denies all three. The private checkout
identity persists and is reverified at worksheet, review, adjudication, and validation boundaries
until the final gate has reverified it. Cleanup is an explicit acknowledged post-gate lifecycle
transition, not part of successful capture.

Tuning evidence is a pre-report false-positive to exact immutable engine commit/package to
post-tuning report chain. Regression evidence uses canonical repository paths and committed byte
digests rather than caller-selected names. The pre-tuning adjudication must reconstruct from its
exact maintainer-review artifact. The final engine commit must contain the exact regenerated F16
report; the offline gate verifies those commit bytes and the cited regression-test bytes, then
independently rehashes the packed CLI/core, Node, Git, guard, registry, and runtime closure without
network access. The unchanged F16 corpus bytes remain pinned after tuning, and both corpus and
report must contain exactly one case for every supported rule ID. Regression evidence is restricted
to standalone `calibration/regressions/*.test.mjs` tests so the release replay can execute it.
Source/package replay uses I02's canonical clean builder. Captured engine/tooling commit E is
immutable. Clean evidence commit A must descend from E and may change only the closed K03 evidence,
implementation-status, and documentation paths. Engine, build, lockfile, F16, and regression changes
in E..A are rejected. Replay materializes E into a separate bounded archive, verifies every path,
mode, size, and Git blob, and never builds A. It rejects any HEAD, index, tracked-byte, mode,
symlink, special-entry, or untracked-file drift from A; performs two independent frozen, offline,
script-disabled dependency installations; and requires byte-identical CLI and core packs. The gate
extracts those packs, recomputes the complete package identities, executes the exact cited
regressions, and reconstructs the three-perturbation F16 run. A self-declared package provenance
file is not proof.

The K03 gate pins the byte-exact pre-diagnostic K02 frame:

- candidates: `dfebdbb895f855e6705430d94553d77e0643cb8891b1cbab461219ddb827585b`;
- corpus: `3b5a95e1b659facad62003f9be0402f79a412cf6f31a1f7065e85dbdc9ab06b1`.

It also pins the F16 corpus and report bytes (`d764ef6e…` and `370fc6bb…`). The semantic objects
must equal those exact bytes after fatal UTF-8 JSON parsing; self-consistent replacement artifacts
are rejected.

`recognizeBuiltInInstructionPath` is a public package-internal projection of the built-in discovery
catalog. Its shared data, exact C01/C05 path admission, and matcher interpreter are used by both
normal C05 discovery and K02 maintenance tooling. Paths remain case-sensitive; search-engine case
variants do not become product-supported evidence.
