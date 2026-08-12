# Changed-file mode security boundary

Default scanning retains zero repository-command and network authority. The Git capability may be
created only after the user explicitly requests changed-file mode and must be bound to a fresh
opaque identity for the selected repository scan; repository files, configuration, environment
variables, and Git output cannot mint it. Metadata or evidence from another scope is rejected.
The CLI bundle keeps `node:child_process` behind a dynamic import confined to the changed-mode Git
executor; bundle and extracted-package gates prove a normal scan while spawning is denied.

The trusted executor must implement every request policy field:

- pass a fresh allowlist environment, never merge inherited `GIT_*`, pager, proxy, credential, or
  shell variables;
- disable system/global Git configuration and prompts, and run against a packaged engine-owned
  synthetic Git directory so repository-local configuration and includes are never parsed;
- set `GIT_NO_LAZY_FETCH=1` so a promisor/partial clone cannot fetch objects;
- set `GIT_OPTIONAL_LOCKS=0` and deny repository writes;
- admit only local object/index commands, reject alternates and promisor metadata, set
  `protocol.allow=never`, and set `GIT_NO_LAZY_FETCH=1`; the executor does not itself install an OS
  network sandbox, so deployments that require process-level network isolation must add one;
- invoke Git without a shell, worktree argument, pager, aliases, hooks, external diff drivers,
  textconv, clean filters, or process filters;
- enforce cancellation, deadline, stdout byte limits, and process-tree cleanup.

One monotonic context covers executable resolution, repository and synthetic-runtime preflight,
every request filesystem read, subprocess, and postflight identity check. Its caller is released if
an underlying filesystem promise stalls; abortable reads receive its signal and late file/directory
handles are explicitly closed. Expiration prevents later continuation from spawning Git or
publishing executor state. Repository configuration is decoded and parsed by the executor only to
admit an unambiguous main `[core]` format 0/SHA-1 or format 1 with the sole main `[extensions]`
`objectFormat = sha256` entry. Relevant subsections, duplicates, continuations, ambiguous syntax or
encoding, and includes are rejected; includes are never followed. Unknown extensions, format
1/SHA-1, shallow state, grafts, replacement refs in either loose or packed form, and private
`config.worktree` force full fallback. Linked worktrees must prove both their
`<common>/worktrees/<id>` membership and exact private `gitdir` backlink; private and common
metadata identities are rebound throughout collection.

Synchronous host rejection while starting the already-admitted Git executable maps to the same
bounded empty exit-1 fallback on every platform. The contract test injects that rejection at the
shared production spawn boundary; it does not execute malformed bytes and depend on an OS shell's
platform-specific `ENOEXEC` exit status.

Only verified lowercase commit IDs flow past reference resolution. Git runs only commit/object/index
operations; `diff-index --cached --name-status -z --no-renames` cannot convert worktree content.
Changed paths are NUL-delimited,
fatal-UTF-8 decoded, root-relative POSIX canonicalized, and reject `.git`, traversal, backslashes,
controls, duplicates, excess length/count, and unsupported/unmerged states. Multiple merge bases are
ambiguous and force a full scan rather than accepting Git's unspecified single-base choice.
The exact index is opened with `O_NOFOLLOW`, bounded, checksum-validated, and rejects split, sparse,
unmerged, malformed, or unsupported forms. Supported regular 100644/100755 paths are read through
the root-jailed no-follow facade and hashed with the index's raw Git blob algorithm. Symlinks,
gitlinks, missing/type-changed files, unsupported modes, and resource excess force full fallback.
`HEAD` is resolved again after both path probes and must retain its exact object identity and hash
width, so a concurrent ref move cannot authorize a stale subset. Every packed-ref file, loose
`HEAD`/symbolic-ref file, traversed reference directory, and missing-path parent is retained as an
exact identity. After Git and tracked-worktree postflight, those inputs are rebound and the ref is
resolved again to the same object ID; an in-place rewrite or late loose override therefore fails.
The CLI repeats the seven-execution snapshot after scheduling and reconciles it with the first
same-scope snapshot. After final inventory, configuration, and read-ledger validation, it takes a
third Git-state identity snapshot immediately before evidence minting. The executor retains the
exact index and tracked-worktree snapshot returned within each metadata collection and recollects
both after the final `HEAD` Git process and metadata postflight. Working-tree, index, base,
merge-base, HEAD, configuration, or admitted Git metadata drift forces full output. The metadata
boundary reports `repository-changed`; the real executor can fail even earlier with the coarser
`command-failed` reason if a bound root, Git marker, ref, index, or tracked byte changes.

The E05/F15 planner fails open to full results. It does not hide syntax rules ACL100–ACL109 and does
not subset incomplete discovery/parser/resolver evidence. Callers cannot provide a reduced candidate
list: only issued B06/B07, C05, E05, and F15 objects can mint the closed evidence authority. The
authority derives root configuration, discovered client/ignore controls, configured standards lock,
and instruction paths. Its B06/B07 root identity must match the scope's privately retained C01
selection, and all C05 instruction candidates must exist in F15 sources. Structural changes,
untracked paths, and any instruction/control path that cannot be mapped to complete E05 scope
evidence force a full scan. No repository text, path, ref, command output, rejection, or stderr
appears in a fallback reason.

Untracked proof uses the scanner's bounded filesystem inventory and resolved ignore policy, not Git
worktree inspection. If an included path is absent from the exact index, the complete filesystem
inventory is used for discovery, parsing, resolution, and scheduling before the result is labeled
full. The inventory repository records every visited directory listing, entry identity, consumed
file byte, and relevant absence boundary. After the last Git snapshot, configuration and that
complete ledger are rebound once more, so a nested late path cannot retain changed-only authority.

Changed-mode diagnostics may include dependency-expanded unchanged paths, but fix-preview authority
does not: a candidate is accepted only when its diagnostic is visible and its primary path appears
in the directly changed path set. All scan and preview paths remain read-only.
