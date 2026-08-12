# C03 tracked-file enumeration design

C03 lives in `packages/evidence/src/tracked-file-enumeration.ts` and consumes only C02. Later
discovery and ignore components consume its result object, including `source`, `certainty`,
`reason`, and `problems`; accepting only `paths` would discard required uncertainty.

## Trust decisions

Git commands are deliberately absent. Running `git ls-files` in an untrusted checkout can load
repository/system configuration and expands the production process boundary. Reading a verified
ordinary in-root index is a narrower data-only optimization. A `.git` gitfile usually names an
external linked-worktree administrative directory; C03 does not read that file or follow its target
because C01 provenance does not authorize later content access outside the root.

The parser tries the documented SHA-1 and SHA-256 widths independently. A candidate must consume the
complete file, validate its matching hash, and satisfy every entry/extension invariant. Exactly one
candidate must succeed. It never infers the object format from repository config and never
dereferences an object ID.

V2/v3 entries are padded relative to the entry start. V4 paths decode the documented OFS_DELTA-style
remove count and suffix without padding. Entries must retain bytewise Git ordering and increasing
stage ordering for identical paths. C03 rejects case-fold and file/directory prefix collisions even
on a case-sensitive host so a result cannot broaden differently after transport to another supported
platform.

Split and sparse indexes require shared-index or tree-object reads and merge semantics. Those would
either cross the root jail or add object-database authority, so C03 labels them unsupported and uses
the filesystem fallback. Optional uppercase extensions do not affect the tracked pathname set and
are skipped after their length is proven within the checksum-covered region. Unknown lowercase
extensions are required and therefore unsupported.

Fallback performs depth-first, lexically ordered C02 calls without a sorting work queue. It tracks
directory device/inode identities to stop aliases, does not recurse through directory links, skips
every `.git` directory at any depth, and bounds files, directories, depth, and retained problems
independently of C02's session budgets. Every repeated directory identity is reported. Problems
beyond the configured retention bound are counted in `omittedProblems`, so an exhausted provenance
budget is never silent. Filesystem fallback intentionally includes safe untracked files; C04 owns
ignore semantics.

## Verification

The focused suite constructs byte-exact synthetic indexes without invoking Git. It covers v2/v3/v4,
v4 prefix compression, SHA-1/SHA-256, merge stages, supported modes, optional/required extensions,
split and sparse formats, bad checksum/signature/version/count/mode/flags/length/padding/order,
truncation, malformed UTF-8 and paths, collisions, bounds, hostile options, ordinary repositories,
missing/malformed/oversized indexes, linked worktrees, external/internal links, disappearing and
aliased directories, finite problems, cancellation, and fallback limits. Synthetic fixtures make
corruption and race timing deterministic; no repository command is executed by product or tests.

Primary sources, retrieved 2026-08-02:

- Git `gitformat-index` 2.55.0: <https://git-scm.com/docs/gitformat-index/2.55.0> (header,
  SHA-1/SHA-256 widths, v2/v3/v4 entries, byte ordering, modes, flags, pathname grammar, padding,
  extensions, split index, and sparse index).
- Git `gitformat-pack` 2.55.0: <https://git-scm.com/docs/gitformat-pack/2.55.0> (OFS_DELTA variable
  width integer referenced by index v4 prefix compression).
- Git repository layout 2.49.0: <https://git-scm.com/docs/gitrepository-layout/2.49.0> (`.git`
  directory and gitfile layouts, index location, linked-worktree administrative data).

Observed-versus-documented: actual Git commands are intentionally excluded from C03 verification.
The parser claims compatibility with the cited binary grammar, demonstrated by independent
byte-level fixtures, not compatibility with undocumented Git configuration or object-database
behavior.
