# Changed-file mode (I07)

Contract versions: Git metadata `0.1.0`; selection plan `0.1.0`.

The packaged CLI exposes one closed grammar: `scan [repository] --changed --base <ref>`. The two
options are inseparable, duplicate options are rejected, and the exact validated ref is preserved.
Default `scan` never initializes Git or process authority.

## Git metadata authority

`createChangedFileScanScope()` mints one opaque identity for one selected repository scan.
`createGitMetadataCapability(scope, executor)` accepts that identity and a trusted host callback,
not repository data. The capability is recognized only in the process that created it.
`collectGitChangedFileMetadata` issues six request kinds in seven bounded executions:

1. resolve `HEAD` as a commit;
2. resolve the caller's base reference as a commit, after `--end-of-options`;
3. request every best merge base for the two verified object IDs;
4. compare the sole merge base to the exact index with object/index-only `diff-index --cached`;
5. read, checksum, and parse the exact bounded Git index with `O_NOFOLLOW`;
6. hash supported regular tracked files as raw Git SHA-1/SHA-256 blobs through the root-jailed
   no-follow filesystem facade;
7. resolve `HEAD` again and require the exact same object identity and hash width before the
   metadata snapshot becomes ready.

The Node executor enforces the request policy with a fixed trusted Git executable, no shell, a fresh
allowlist environment, disabled system/global configuration, a packaged synthetic Git directory,
`GIT_NO_LAZY_FETCH=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, and `GIT_PAGER=cat`. It
binds the selected root, Git marker, and executable identities and enforces output, deadline,
cancellation, and process-tree cleanup limits. Repository-local Git configuration and includes are
never on Git's read path. The executor rejects `include`/`includeIf` directives instead of following
them and accepts only an unambiguous main `[core]` format 0 with SHA-1 or format 1 whose sole main
`[extensions]` entry is `objectFormat = sha256`. Relevant subsections, duplicate keys,
continuations, and ambiguous encodings or syntax force full mode; ordinary remote and branch
subsections remain admitted. It resolves bounded loose/packed refs itself, binds linked-worktree
common metadata, validates the private `gitdir` backlink and `common/worktrees/<id>` membership, and
binds the exact admitted object/index identities. Shallow repositories, grafts, loose or packed
replacement refs, private `config.worktree`, alternates, promisor data, links, special files, and
oversized object stores are rejected. `node:child_process` is dynamically imported only after
explicit changed mode. A monotonic deadline/abort context bounds executable resolution, preflight,
every request, and all Git pre/postflight checks even if an underlying filesystem operation does not
settle. Abortable reads receive its signal, and handles or directories that resolve after the race
are explicitly closed. Protocol/lazy-fetch controls close the admitted command paths, but the
executor does not claim to install an OS network sandbox.

The change-list request fixes `diff-index --cached --name-status -z --no-renames`; Git receives no
worktree argument and never converts worktree content. Base and `HEAD` refs are resolved from
bounded no-follow loose/packed metadata, then only the resulting lowercase object ID is peeled in
the synthetic Git runtime; all later commands receive only validated object IDs. Multiple/no merge
bases, unsupported states, malformed or duplicate paths, resource excess, cancellation, or command
failure produce an issued `fallback` record. The CLI separately enumerates scanner-visible files
under the configured limits and ignore policy; any included path absent from the validated index
forces full fallback, and that complete inventory becomes the analysis input. A final repeated
inventory closes late-untracked races. After that inventory, configuration, and the complete read
ledger are validated, a third Git-state identity snapshot closes mutations in the final validation
window; configuration and every recorded inventory directory, entry, consumed byte, and absence
boundary are rebound after that snapshot before evidence is minted. Within each metadata collection
the executor also binds the exact index and tracked-worktree snapshot returned before the final
`HEAD` resolution, then recollects and compares both after that Git process and its metadata
postflight. Packed and loose reference inputs, including traversed directories and absences, are
then rebound and resolved again to the same object ID. A concurrent HEAD, index, tracked-source,
nested inventory, or metadata move produces `repository-changed` or a conservative metadata
fallback. Command stderr and repository-controlled output are never reflected.

The CLI collects this metadata before and after complete discovery, parsing, E05 resolution, and F15
scheduling. `reconcileGitChangedFileMetadata` accepts only two same-scope issued records. Any
semantic difference in HEAD, base, merge base, exact index bytes, raw worktree state, changed paths,
or fallback state becomes an issued `repository-changed` fallback, so the subset is bound to the
full evaluation interval.

## E05/F15 selection plan

`createChangedFileModeEvidenceAuthority` privately snapshots and binds the following same-process
issued results to the same opaque scan identity as the Git metadata:

- a successful B06/B07 configuration resolution;
- a complete C05 targeted discovery index;
- E05 effective-context resolutions, including one for every changed target and the deterministic
  scope sample;
- an F15 scheduler success.

Callers cannot supply or omit path lists. The authority derives instruction candidates from C05 and
derives control paths from the root `.agent-context-lint.yml`, every C05 `configuration` candidate,
and the resolved `standards.lockfile` path (including a custom configured path). A cloned, forged,
uncertain, or cross-scope value cannot authorize changed-only filtering. `planChangedFileMode`
accepts only that authority plus Git metadata issued for its exact scan identity.

Changed targets expand to all effective documents and imported paths in their E05 resolution.
Changed instruction or imported paths expand to every represented target that consumes them.
Diagnostics are retained when their primary source, related source, resolution source, or repository
fact path intersects that closure. Root-global visible ACL100–ACL109 remain visible; path-owned
syntax diagnostics, including suppressed diagnostics and unused-suppression records, follow the
selected dependency closure.

Every C05 instruction candidate must also be present in the issued F15 source inventory. Imported
sources may be additional paths: E05 occurrences prove their dependency relationship, including a
shared import consumed by multiple targets. A C05/F15 mismatch rejects authority construction.

The result is immutable and contains sorted changed/selected paths plus included and excluded F15
diagnostic IDs. It does not mutate the scheduler bundle.

## Full fallback

The selector returns `mode: "full"` and the complete F15 diagnostic bundle when safe subset
completeness cannot be proved. Causes include unavailable Git metadata, configuration/policy
changes, delete, rename, copy, or type changes, untracked files, incomplete C05/parser/E05 results,
unrepresented changed targets, unmapped instruction candidates, invalid authority, and resource
excess.

Partial E05 assembly caused only by external context, ordering, semantic precedence, or unavailable
exact composed text does not hide repository path dependencies and may still authorize selection.
Activation, target-scope, import-resolution, or partial-profile ambiguity always forces a full scan.
Full fallback writes one fixed reason to stderr and renders the complete scheduler bundle. Changed
output filters diagnostics and suppression bookkeeping together, recomputes exit policy, and keeps
ACL100–ACL109 visible. `--fix-dry-run` is narrower still: it may preview a fix only in a directly
changed file, never an unchanged dependency.

Primary Git references (retrieved 2026-08-09):

- <https://git-scm.com/docs/git-merge-base>
- <https://git-scm.com/docs/git-diff-index>
- <https://git-scm.com/docs/git-rev-parse>
