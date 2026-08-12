# Metadata calibration security boundary

External repositories remain hostile read-only subjects. K02 never clones them, retrieves raw or
base64 file content, calls a Git blob or Contents endpoint, executes repository code, follows a
submodule, contacts maintainers, or creates a commit, branch, patch, pull request, issue, comment,
notification, or other upstream mutation.

The network client has one exact HTTPS origin (`api.github.com`), one method (`GET`), no redirects,
serial concurrency, a 1,024-request ceiling, 15-second request deadlines, and a 7 MiB response cap.
Only four content-free endpoint shapes are admitted: code search, repository metadata, commit
metadata, and pinned recursive trees. Rate-limit responses stop immediately and report only retry
metadata. Authentication tokens are supplied by the environment, used only in the authorization
header, and never persisted or printed.

Every decoded response is bounded UTF-8 JSON. Capture rejects any `content`, `text`, or
`text_matches` field recursively. The normalized snapshot schema also rejects README bodies,
descriptions/excerpts, arbitrary response properties, and unknown extensions. Repository license
identity comes from `repository.license.spdx_id`; the license-content endpoint is never called.
Unknown/`NOASSERTION` licenses are excluded and counted rather than guessed.

Recursive trees must be non-truncated, match the requested root tree SHA, contain no duplicate or
non-canonical path, stay within 100,000 entries and 16 MiB of path text, and use documented
mode/type combinations. Only `100644` and `100755` blobs can be instruction evidence. Tree-entry SHA
is provenance metadata; no blob body is retrieved. C0/C1 controls, DEL, Arabic Letter Mark,
left/right marks, bidi embeddings/overrides/isolates, malformed Unicode, Windows device/drive paths,
backslashes, parent/dot segments, repeated separators, paths deeper than 128 segments or longer than
16,384 UTF-16 code units, and case-variant unsupported filenames fail admission. The standalone
calibration admission and C05 runtime-limit admission call the same predicate.

Committed selection artifacts contain public repository metadata only. Future K03 reports contain
repository/rule/path/semantic/diagnostic fingerprints, severity, versions, and timestamps—not paths,
messages, snippets, fixes, secrets, or repository content. Reviewer tools accept bounded canonical
repository-relative JSON paths, use no-follow reads, enforce JSON depth/value/byte limits, write
nothing, and print only closed fingerprint worksheets/reviews/adjudications to standard output. The
committed authority declaration closes reviewer identity to the repository owner; downstream
artifacts hash-bind it and the exact review. Owner merge is the human acceptance event. Generated
timestamps provide ordering only and are not represented as trusted-time or signature proof.

## K03 source handling and execution boundary

K03 is an explicit network-enabled maintainer workflow, not a normal scan path. Git is used only by
the outer harness to fetch the already frozen HTTPS repository and exact commit. Global/system Git
configuration, credential helpers, prompts, SSH, local/file transports, hooks, LFS smudge, tags, and
submodule recursion are disabled. The harness verifies both `HEAD` and `HEAD^{tree}` against K02 and
rejects special files, excessive entries, and disk usage beyond a bound derived from frozen public
metadata.

The harness binds Git's canonical exec path and the lexical `git-remote-https`, `git-index-pack`,
and `git-unpack-objects` entries. The HTTPS helper may be an in-directory symlink and its exact link
and target bytes are bound. The index-pack and unpack entries must resolve to the already reviewed
Git executable. All link, target, and executable identities are rechecked around every Git
operation. `GIT_EXEC_PATH` is forced to that directory, askpass is non-executable, terminal prompts
and credential helpers are disabled, and Darwin process confinement permits only those four lexical
entries plus the HTTPS target when distinct. This outer checkout boundary intentionally has network,
child-process, and quota-volume write authority: Git needs them to obtain and materialize the pin.
It is not the scanner boundary. The scanner separately denies network, writes, and child execution.
The operating system's signed loader and system dynamic libraries are the documented platform trust
boundary; no repository-controlled library path is admitted.

The packed scanner receives no child-process, worker, addon, WASI, or filesystem-write permission.
On Darwin it also runs under an OS policy denying network, file writes, and all file reads except
the exact checkout, CLI/core package closure, guard, Node executable, and required system runtime
files. A mandatory pre-capture probe proves that a checkout symlink to `/etc/hosts` remains
unreadable even where Node's permission allowlist alone follows it. A preload guard makes ordinary
child/socket attempts fatal even if application code catches the first exception. Only the
disposable checkout, exact package closure, and guard are application-readable. Scanner stderr,
timeout, malformed UTF-8, output overflow, nonzero status, or summary mismatch fail capture.

Native JSON is deep-snapshotted as bounded plain data. Proxies, accessors, symbols, non-finite
numbers, malformed Unicode, excessive depth/count/text, unknown diagnostic fields, forged
fingerprints, and suppressed/info inflation are rejected. Public output includes only derived
fingerprint identities. Diagnostic messages, locations, related evidence, fingerprint bases, and
checkout paths remain in the mode-`0600` temporary review bundle. Before capture, publication
exclusively reserves that fixed path and retains both its file handle and parent-directory handle.
It checks the held and path-visible file/parent identities before secret bytes, after the durable
write, and before the directory sync. Publication failure preserves the issued-state list, attempts
cleanup of every retained volume, and aggregates any cleanup failures for quarantine. The public
digest binds every private diagnostic and the exact local checkout identity while revealing none of
those values.

Fetch and checkout run in a dedicated process group with a live aggregate file/byte monitor;
pre-abort, live cancellation, timeout, output-limit, quota, malformed-output, and success paths kill
the issued group and wait for the direct process to close. Polling is not treated as a pre-write
boundary. Each checkout instead uses exact reviewed `/usr/bin/hdiutil` bytes to mount a dedicated
fixed-capacity APFS sparse image at an exact private work-root child. Its hard allocated ceiling is
the logical checkout budget plus a measured fixed 192 MiB filesystem reserve, covering the bounded
APFS container and filesystem metadata observed on the supported Darwin host. Because `hdiutil`'s
`b` suffix denotes 512-byte sectors, the byte ceiling must be exactly divisible by 512 and is
divided before the create argument is formed. The image, device, underlying mode-`0700` mount path,
mounted root, exact Darwin filesystem name `apfs`, filesystem/block/free-space geometry, budget,
reserve, and read-only remount are private-digest-bound. Initial attachment explicitly requests
read-write authority for the reserve filler and checkout; an explicit detach and read-only reattach
removes that authority before scanning. The `apfs` name is derived from one mounted-partition entity
carrying the `Apple_APFS` marker or one of the exact APFS type UUIDs
`41504653-0000-11AA-AA11-00306543ECAC` and `7C3457EF-0000-11AA-AA11-00306543ECAC` in the
identity-bound `hdiutil info -plist` inventory and must belong to an issued base device; the
identity-bound `/bin/df -kP` result must bind that exact partition device and mount point before
providing 1024-byte block totals. APFS may exclude container metadata from the `Used` and
`Available` columns, so those columns are bounded independently rather than required to sum to the
total; after checkout, remaining free space may decrease but cannot exceed the filler-established
logical budget. It is not inferred from a pathname-oriented `stat` format token. A real oversized
fast-copy proof is mandatory on the Darwin release host; fake providers and feature-unavailable
managed hosts do not satisfy it. The checkout loses its remote, is frozen read-only, and is checked
against the same inventory after scan and before final evidence. The inventory includes every
regular file's SHA-256 digest in addition to path, type, permissions, size, and timestamps. Native
output rejects duplicate JSON keys and is projected immediately so fifty maximum outputs cannot
accumulate. Public and private artifacts share an 8 MiB limit and at most 10,000 reviewed
diagnostics.

The mounted image contains an allocated reserve filler so usable free space is within one filesystem
block of the logical checkout budget. The native copy proof accepts only exact ENOSPC output and a
non-empty partial destination smaller than the hostile payload; timeouts, signals, EFBIG, EACCES,
and generic nonzero exits fail. Attach recovery compares bounded before/after hdiutil inventories,
associates each new base device with its exact decoded sparse-image path, and attempts to detach
every still-attached device issued for that image. If APFS disappears between inventory and detach,
the failed detach is accepted only when a new inventory and host-mount identity prove the desired
detached state. Concurrent new devices bound to another image are never detached; they make recovery
fail closed and are reported for quarantine together with the exact issued-device list. After every
successful detach set, a fresh hdiutil inventory must prove that no device remains bound to the
image and, where a mount was issued, that the original host mount identity has returned. An
unreadable inventory, retained device, or mount mismatch sets `safeToRemoveImage=false`; the image
is retained for quarantine rather than unlinked. Cleanup always performs one final exact
`hdiutil info -plist` inventory immediately before unlink, even when the mount path already has its
original host identity or an earlier detach postflight succeeded.

Packed CLI/core manifests have an exact reviewed field set, no lifecycle scripts, a closed runtime
dependency/export graph, and no symlinked files. Installation/extraction requires an explicit
ignore-scripts acknowledgement. Exact Node/Git/hdiutil versions and executable digests, package
inventory, rule registry, guard, and readable closure are public report identities and are rehashed
throughout capture and finalization.

The native proof separately inventories the complete bounded published pnpm package rather than only
its launchers. Worker code, built-in configuration, and bundled transitive modules are hashed
without following symlinks and the inventory is rechecked around every package-manager operation.
Before the proof child starts, the package is copied twice without dereferencing links into an
unpublished mode-`0500` private container. Acquisition holds and rechecks the complete source
directory chain, and both independently traversed inventories must produce one content-identity
fixed point. Inventory runs over those confined snapshots in a proof-bound exact-Node sandbox that
can read only the snapshots, canonical source identity, and fixed system runtime files. Any copied
link is rejected without opening its target. The proof binds the inventory child source digest; its
exact argv, `READY`/`GO` handshake, closed JSON output shape, and post-exit child/package identities
are validated. A closed set of literal ancestor directory entries is readable solely so macOS can
traverse and `realpath` each approved absolute path. Those literals do not grant access to sibling
descendants; only the separately listed snapshot, package, Node-runtime, and system-runtime subtrees
are readable. A directory swapped to an outside symlink after snapshot creation cannot alter the
tree being traversed or cause an outside read. `READY` is emitted only after snapshot root children
have been classified and directories enqueued, so the native regression replaces an already queued
source directory while the child completes only from confined bytes. The authoritative `pnpmRuntime`
identity is accepted only from that sandboxed child JSON; an in-process inventory is never proof
authority. The production authority path has no injectable command runner: it holds no-follow
handles for exact sandbox-exec, vendored Node, and inventory-child bytes plus every canonical
directory component back to the held filesystem root. It creates private digest-verified executable
copies of vendored Node and the inventory child directly from those held bytes. The Apple platform
binary `/usr/bin/sandbox-exec` cannot execute after byte-copy relocation, so its SIP-protected
canonical path is spawned while the held file and complete path chain are revalidated before and
after; no caller-selected pathname is accepted. Every ancestor retains held-versus-visible inode and
canonical-path checks. Timestamp stability additionally applies to user-owned directories that are
not group- or world-writable; shared roots such as `/private/tmp` are not treated as immutable
because unrelated processes legitimately change their directory timestamps. Authority diagnostics
number non-root path components from zero so an exact changed ancestor is reproducible in tests.
Parent, grandparent, and whole-tree ABA replacement therefore cannot execute substituted bytes, and
restored substitutions, fabricated JSON, or a zero/changed digest rejects the result. A managed
runner that cannot apply the exact OS sandbox remains explicitly feature-unavailable rather than
substituting an unsandboxed digest. Successful capture deliberately retains its frozen quota mounts
through the accountable maintainer review and the final gate. Destruction is a distinct acknowledged
post-gate command that preflights all private-bundle targets before cleanup; failure paths continue
to clean immediately and quarantine anything whose exact ownership cannot be proven.

Owning package manifests are fail-closed identity reads. A canonical ordinary-file `lstat`
immediately precedes the no-follow open; its device, inode, and type must match the opened handle.
After the bounded read, both the handle and canonical pathname are revalidated, so pre-open
replacement, post-open pathname swaps, in-place mutation, malformed UTF-8, and duplicate JSON keys
cannot authorize a launcher.

Final source replay separates immutable engine commit E from clean evidence descendant A. A closed
E..A allowlist admits only K03 evidence, implementation status, and documentation, rejecting engine,
build, lockfile, F16, and regression drift. Replay archives E with exact absolute Git, extracts it
with exact absolute tar, verifies every tracked path, executable mode, size, and Git blob digest,
and builds only that separate tree. A is rechecked byte-for-byte before and after replay. I02's
builder performs frozen offline installs with dependency lifecycle scripts disabled; K03 builds two
independent workspaces and requires byte-identical CLI and core tarballs. A preload guard denies
socket, DNS, HTTP(S), `fetch`, `WebSocket`, `EventSource`, and detached Node children during build
and replay. Exact regression files run in the clean tree under Node's permission boundary, followed
by the real three-perturbation F16 reconstruction. Only a recomputed extracted-package inventory can
match the captured package identity; provenance text is never accepted in its place.

The reviewed build phase needs child processes because pinned pnpm invokes the exact CLI prepack
builder. Node's unscoped child-process permission is therefore not the security boundary. On the
Darwin release host, `/usr/bin/sandbox-exec` is the parent of every install and pack command. Its
committed profile identity denies all network operations and file writes outside the replay root,
denies arbitrary process execution, and admits only captured Node, exact shell/environment helpers,
and the reconstructed frozen build graph: vendored Node 24.18.1; the pnpm 11.18.0 manifest-mapped
ESM launcher, separately bound CJS compatibility shim, bundled runtime, and package manifest;
pnpm-generated `esbuild` and `tsc` wrappers; the esbuild entry, package/platform manifests, and
platform binary; and the TypeScript 7.0.2 bin entry, JavaScript runtime entry, executable resolver,
package/platform manifests, and native compiler. TypeScript and esbuild are resolved separately from
each package's canonical owning manifest. The shell helper set binds both `/bin/sh` and `/bin/bash`
because Darwin's `/bin/sh` dispatches its reviewed shell variant through `/bin/bash`; the sandbox
does not grant a general PATH-based shell lookup. Versions are read from the workspace package,
lockfile, and installed package manifests; launcher paths are canonicalized only for the
workspace-root prefix while every graph file remains digest-bound. Every executable and helper is
rehash-verified before and after its actual operation, including failure paths. Mandatory native
probes demonstrate direct curl denial, curl denial from a Node child, network denial, and
write-escape denial. Exact sandbox executable bytes, inventory-child bytes, and separate normalized
install/pack/extract policy digests bind the complete sorted executable allowlists. The profiles and
digests are reconstructed before and after each operation. The preload guard and Node permissions
remain defense in depth. Managed or non-Darwin hosts cannot produce this proof, so gate state
remains pending there.

Install, pack, build, and tar extraction use bounded asynchronous process groups with deadlines,
stdout/stderr caps, pre-abort and live cancellation, fatal UTF-8 decoding, and unconditional issued
process-group termination on every return path. This is a process-group guarantee, not a claim to
contain an arbitrary hostile daemon that deliberately creates a new session. That authority is
excluded from the production boundary instead: external repository commands, hooks, lifecycle
scripts, and unbound executables never run; the exact source and executable/argument graph is
reviewed and digest-bound; and the preload rejects detached Node children. Final source and runtime
extraction run under the proof-bound sandbox with a minimal environment, and canonical
`/usr/bin/bsdtar` (the resolved macOS `/usr/bin/tar` target) is rehashed immediately before and
after each extraction, including failed extraction. Attach wrapper and plist failures inventory
devices before and after each initial or read-only attach: zero issued identities preserve the
original failure, while one or many devices associated with the exact image are all detached.
Unbound concurrent devices are reported but never detached. Ready validation reruns these native
relations instead of trusting the committed proof's self-digest; APFS geometry requires the exact
block size and permits the block count to differ by at most one, while tool, profile, budget,
ENOSPC, and zero-residual cleanup identities are exact.

The exact K02 and F16 artifact byte digests are compile-time K03 authorities. In-memory objects must
equal fatal-UTF-8 parses of those bytes, preventing a valid-looking selection or recall artifact
from being substituted after findings are known. The K06 release holdout is neither selected nor
read by this workflow.
