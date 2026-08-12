# Seeded recall security boundary

Seeded recall is a repository-maintainer workflow with a deliberately narrow data boundary.

- Corpus scenarios contain repository-owned synthetic input only. The workflow neither clones nor
  reads external repositories and never executes repository commands.
- The committed report is fingerprint-only. It excludes messages, suggestions, fingerprint bases,
  paths, source text, tokens, and secret-like fixture strings.
- The check runner is deterministic, offline, model-free, and uses only fixed repository-owned
  artifact paths. Generation requires `--write --acknowledge-reviewed-update` and uses an exclusive
  temporary file, `fsync`, and atomic rename for each artifact. The two-file set is not
  transactionally atomic; check mode rejects a pair left stale by interruption.
- Generation repeatedly checks the captured parent device, inode, and real path and uses no-follow
  file opens where supported. A residual pathname race remains possible against a hostile process
  with concurrent directory-replacement access, so generation is a trusted-maintainer operation
  and is never part of normal scanning.
- The reviewer accepts canonical repository-relative paths only, selects the root explicitly, and
  reads through the bounded C01/C02 read-only repository facade. Absolute paths, traversal, invalid
  UTF-8/JSON, oversized files, excessive structure, duplicate JSON keys, non-normalized two-space
  pretty JSON, and intermediate symlink escapes fail closed.
- Reviewer commands emit worksheets, reviews, and adjudications to standard output only. They do
  not create or overwrite files. The caller deliberately persists output, then the validator rereads
  the saved artifact before it is accepted.
- Review contracts are closed and complete. Labels are bound to the canonical report digest and
  exact case/rule/path/semantic fingerprint tuple. The persisted primary and optional tie-breaker
  role records use distinct stable IDs because the artifact validator reconstructs each decision
  from its inputs; those IDs do not impose a multiple-human approval requirement. The accountable
  maintainer is the sole human reviewer under the current policy, while a separate audit agent
  verifies the exact artifact, reconstruction, and arithmetic. Persisted adjudications are
  reconstructed from their bound review files before acceptance; reordered, duplicated, stale, or
  inconsistent decisions fail.

Repository files, artifact JSON, worksheets, and reviewer identifiers are untrusted input. Review
tools never interpret their contents as shell commands, Markdown instructions, module names, or
filesystem paths beyond the bounded input paths selected by the caller.
