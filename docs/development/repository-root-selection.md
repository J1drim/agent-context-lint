# C01 repository-root selector design

C01 is the one-time authority decision before B07 configuration and the forthcoming C02 read-only
filesystem facade. Its implementation lives in `packages/evidence/src/repository-root.ts` and is
intentionally independent of CLI parsing, Git subprocesses, repository configuration, ignore files,
and content discovery.

## Selection sequence

1. Snapshot and validate plain options without invoking accessors.
2. Validate and byte-bound the complete start and ceiling host-path strings before any filesystem
   API sees either one.
3. Inspect the lexical chain, reject a terminal link, resolve the start directory, validate and
   byte-bound the operating-system result, then identity-check the complete canonical chain.
4. In explicit mode, recheck and return that exact directory.
5. In discovery mode, inspect `.git` from the canonical start directory upward. The first present
   marker has authority: valid selects; invalid fails closed.
6. Stop inclusively at a validated ceiling, at the filesystem root, or before crossing a device.
7. Recheck the found marker/gitdir/HEAD observations and all lexical/canonical root identities. As
   the final filesystem pass before either a Git or non-Git success, recheck every previously absent
   marker from farthest to nearest so the most authority-critical absence is observed last.

Intermediate directories are rechecked by device/inode identity and directory type. Their content
timestamps may legitimately change when an unrelated sibling is created in a shared ancestor, so
timestamp drift alone is not a path race. Link entries, the selected directory, and Git metadata
retain the stricter metadata-stability checks.

This order prevents a malformed nested marker from being treated as absent, a terminal separator
from dereferencing a leaf link, a Unicode replacement from aliasing another directory, a link swap
from changing the canonical authority, and a marker appearance/removal from changing the nearest
repository during one operation.

The device/inode values in the result are decimal strings so the result remains serializable. They
are an observation for cache/provenance keys, not a persistent capability. C02 revalidates identity
at each later read.

The module also privately registers each successful result. `isIssuedRepositoryRootSelection`
distinguishes that same-process C01 authority from a clone or cast. An explicitly requested
changed-file scan can mint its opaque scan identity only from such an issued selection; the scan
scope privately retains the exact selection object so evidence from another root or scan cannot be
replayed without exposing an absolute path in result data.

## Git metadata boundary

Git documents two relevant working-tree layouts: a `.git` directory and a plain-text `.git` file
whose `gitdir:` value identifies the real administrative directory. Linked worktrees keep private
administrative data below the main repository's `.git/worktrees/<id>` directory. C01 accepts
absolute or relative gitfile targets, requires the target and regular `HEAD` metadata to exist, and
rechecks target path identities. It deliberately does not parse `config`, `commondir`, refs, index,
objects, alternates, attributes, or hooks.

No Git command is invoked. Git's own security documentation says it is unsafe to run Git commands
when an untrusted `.git` directory or its surrounding worktree is controlled by an attacker because
configuration and hooks can execute commands. Avoiding `git rev-parse --show-toplevel` is therefore
a security decision, not a compatibility shortcut. C03 may later add a hardened tracked-file fast
path, but it cannot weaken the ordinary-scan command-execution invariant.

Because a real linked worktree normally points outside its worktree root, pre-root validation makes
one narrow metadata exception: it `lstat`/`realpath` checks only the gitdir directory chain and
`HEAD` file named by the bounded gitfile. It never reads bytes from Git configuration or repository
content there. After root selection, C02 permits repository content reads only beneath canonical
`selection.root`; `selection.gitDirectory` is provenance, never jail authority.

The selector recognizes the documented physical marker layout, not every behavior Git can derive
from repository configuration. In particular, it does not honor `GIT_DIR`, `GIT_WORK_TREE`,
`core.worktree`, `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, or global/system
configuration. Bare repositories are not working-tree roots. Legacy symlinked `HEAD` files are
rejected by the linter's stricter no-link metadata policy even though Git documentation records that
historical representation.

## Limits and C02 handoff

The 16,384-UTF-8-byte path, 128-ancestor, 256-component, 1,024-operation, and 4,096-byte gitfile
limits are hard ceilings intended only for bounded root selection. The path grammar and byte limit
are reapplied to untrusted `realpath` output and every generated `.git`, `HEAD`, and resolved gitdir
path before inspection. A bounded, operation-counted gitfile read loop accepts fragments but must
exactly match the stable opened-handle size, prove EOF, and finish with a matching handle stat, so
early EOF, growth, zero progress, and concurrent replacement fail closed. These limits are not C02
scan budgets. Handle rejections are mapped at this boundary to fixed-message typed errors, and only
inert bounded platform codes are retained; cleanup cannot mask an earlier primary failure. Option
keys are count- and allowlist-checked before their four possible data descriptors are read, and
reflective signal checks reject proxies. Native cancellation state is read only through a captured
intrinsic `AbortSignal` getter; own and subclass accessors are never dispatched, and invalid brands
fail as typed options errors. The exported runtime path helper validates the exact `posix`/`win32`
flavor union before parsing and never coerces another value. C02 owns repository entry counts,
file/content bytes, traversal depth, deadlines, special-file policy, link loops, hard-link
ambiguity, and per-operation containment. C03 owns tracked-file enumeration. Neither ticket should
repeat root selection or change its authority precedence.

`selectRepositoryRootWithFileSystem` is a trusted executable capability boundary rather than a data
validation boundary. Tests and future composition may inject implementations, whose methods are
necessarily called; repository files, configuration, and parsed values must never supply that
object. Production callers use `selectRepositoryRoot` and its fixed Node filesystem capability.

B07 accepts only an already selected root and reads the exact root configuration. Integration tests
therefore call C01 once, pass canonical `selection.root` to `resolveAgentContextConfiguration`, and
prove that a linked worktree receives its own configuration rather than a main-worktree, parent,
home, or global file.

## Verification and source evidence

Tests include host-independent POSIX/Windows path tables, exhaustive forbidden-control negatives,
malformed options without callback invocation, oversized caller/canonical/generated paths before
filesystem access, actual filesystem link/marker/type/size fixtures, short and corrupted gitfile
reads, inert error-code and bounded option reflection, nested real Git repositories, a real
disposable linked worktree, cancellation, depth and metadata boundaries, injected root/marker races,
result immutability, deterministic repeated selection, and the B07 handoff. Git commands exist only
in disposable project-owned integration fixture setup; production source has no process import or
spawn path.

Primary sources, retrieved 2026-08-02:

- Git `gitrepository-layout` 2.49.0: <https://git-scm.com/docs/gitrepository-layout/2.49.0>
  (working-tree `.git` directory, gitfile form, required `HEAD`, and worktree administrative
  layout).
- Git `git-worktree` 2.55.0: <https://git-scm.com/docs/git-worktree/2.55.0> (linked-worktree private
  gitdir and `.git` file relationship; relative-worktree paths).
- Git 2.55.0 security and discovery documentation: <https://git-scm.com/docs/git/2.55.0> (untrusted
  repository configuration/hook execution risk, filesystem-boundary discovery, and ceiling
  behavior).
- Node.js `fs` documentation, v24.18.1:
  <https://nodejs.org/download/release/v24.18.1/docs/api/fs.html> (`lstat`, `realpath`, bigint
  identity metadata, file handles, and platform link behavior).
- Node.js `path` documentation, v24.18.1:
  <https://nodejs.org/download/release/v24.18.1/docs/api/path.html> (explicit POSIX/Windows parsing,
  roots, normalization, relative paths, and separators).

Observed-versus-documented: actual worktree fixtures are created with the locally installed Git in a
disposable directory and confirm the documented absolute gitfile form. Relative gitfiles are covered
synthetically because Git 2.55 documents them but older installed clients may not create them by
default. The selector claims only marker recognition; it does not claim complete Git repository
format validation.
