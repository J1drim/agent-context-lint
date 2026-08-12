# Metadata-only calibration corpus

K02 freezes a precision-calibration sampling frame without cloning or reading repository source. The
current v0 frame contains 70 eligible public repositories and selects 50: ten each for `agents-md`,
`claude`, `copilot`, `cursor`, and `gemini`. The selected set includes monorepositories and
repositories with multiple recognized instruction formats.

## Deterministic selection

The committed candidate snapshot is the selection authority. Its fixed seed is
`SHA-256("agent-context-lint:k02:metadata-calibration:v0:2026-08-09")`. The
`sha256-ranked-stratified-v1` algorithm orders strata by ascending eligible-candidate count (UTF-8
format ID as the tie break), then ranks unused candidates with:

```text
SHA-256(seed + ":" + stratum + ":" + lower(owner/name))
```

It selects the first ten unused candidates per stratum and orders output by stratum/rank. The
offline validator recomputes the candidate digest, ordering, assignments, ranks, coverage traits,
and exact 50-repository result. Selection occurs before scanning and records that diagnostic output
was not inspected.

This is deliberately stratified calibration data, not a population estimate or a release holdout.
GitHub code search is an indexed sampling frame, exposes at most 1,000 results, may change over
time, and this freeze uses the first 100 repository results for each query. The snapshot records
total counts, `incomplete_results`, exclusions for unknown licenses and truncated/oversized trees,
and the fact that the frame is not the complete GitHub population. Popularity, language, expected
findings, and linter success are not selection filters.

## Refreshing the frame

Normal checks are offline:

```sh
pnpm metadata-calibration:check
pnpm test:metadata-calibration
```

A refresh is a network-enabled maintainer operation requiring a read-only public-metadata token:

```sh
GITHUB_TOKEN=... pnpm metadata-calibration:generate
```

The generator accepts no arbitrary output paths. It writes only the fixed candidate/corpus files
after `--write --acknowledge-reviewed-update`, using exclusive temporary files, flush, directory
identity checks, and atomic rename. Review both artifacts, the exclusion counts, repository
diversity, selection digest, and reported exact GET request count before committing. The request
count is operational capture evidence and is not added later by estimation.

The live client follows GitHub's current REST best practices while pinning the officially supported
`2022-11-28` API version. It makes serial GET requests only to closed code-search, repository,
commit, and recursive-tree endpoint shapes. GitHub documents recursive tree entries as metadata with
path/mode/type/size/SHA and sets `truncated: true` beyond its 100,000-entry or 7 MB limits. K02 uses
only non-truncated trees within those same limits, requires the returned root tree SHA, validates
mode/type pairs, and records only regular/executable blob SHAs. Symlink blobs and submodules cannot
become instruction evidence. API references and the 2026-08-09 retrieval time are recorded in the
snapshot.

Path admission is shared with C05: it rejects the complete unsafe-control and bidirectional-format
set, malformed UTF-16, non-canonical/Windows-shaped paths, more than 128 path segments, and more
than 16,384 UTF-16 code units before any instruction grammar is classified.

K02 is independent of K06. These 50 repositories are tuning/calibration inputs and must never be
counted as, substituted for, or used to choose the fresh random ten-repository release trial.

## K03 precision execution

K03 consumes the frozen K02 selection without changing a candidate, rank, stratum, or pin after
diagnostics are visible. Create two dedicated temporary directories: one for an extracted clean
installation of the packed CLI and its runtime dependency, and one empty capture root. The capture
root must be a real child of the operating-system temporary directory, outside this repository. The
private output is fixed to `private-review.json` directly inside it.

Create both directories with the platform's `mktemp -d` equivalent so they are real mode-`0700`
children of `os.tmpdir()`; do not assume `/private/tmp`, `/tmp`, or `$TMPDIR` is the canonical root.
Extract/install the already built CLI and core tarballs with lifecycle scripts disabled (for
example, `npm install --ignore-scripts`) into the package directory. Then run:

```sh
pnpm metadata-calibration:capture -- \
  --cli-entry "$K03_PACKAGE_ROOT/node_modules/@agent-context/lint/dist/cli.js" \
  --package-root "$K03_PACKAGE_ROOT" \
  --node /absolute/reviewed/path/to/node \
  --git /absolute/reviewed/path/to/git \
  --hdiutil /usr/bin/hdiutil \
  --work-root "$K03_WORK_ROOT" \
  --private-output "$K03_WORK_ROOT/private-review.json" \
  --acknowledge-ignore-scripts-extraction \
  --acknowledge-read-only-external-capture
```

The command derives the CLI version, stable knowledge-pack version, and a bounded extracted-package
inventory digest from packed artifacts. It records and rechecks the exact Node, Git executable, Git
exec path and HTTPS helper link/target, sandbox executable, guard, rule registry, package, and
readable-runtime closure digests and versions around every scan. Git runs with an exact
`GIT_EXEC_PATH`, disabled credential helpers and prompts, and a process policy that admits only the
bound Git and HTTPS-helper paths. Platform dynamic libraries remain an explicit signed-Darwin trust
boundary rather than caller-selected executable input. The harness derives the source commit from
this repository rather than accepting identity strings. It checks every selected commit and root
tree against K02, monitors fetch and checkout against a pre-write size budget derived from frozen
GitHub `diskUsageKiB`, disables submodules, hooks, credentials, LFS smudge, and file transports, and
scans serially. The outer Git harness necessarily retains network, bound-child, and quota-volume
write authority. Its exact executable graph is Git, the HTTPS helper link/target, and `index-pack`
and `unpack-objects` links resolving back to Git. The later packed scanner is a distinct boundary
that denies network, writes, and child processes. Each Git checkout lives on a fixed-capacity APFS
sparse image mounted at an exact mode-`0700` path whose Darwin mounted filesystem name must be
exactly `apfs` inside the capture root. That name is accepted only from one partition carrying the
`Apple_APFS` marker or one of the exact APFS partition-type UUIDs
`41504653-0000-11AA-AA11-00306543ECAC` and `7C3457EF-0000-11AA-AA11-00306543ECAC` in the bound
`hdiutil info -plist` inventory whose base device is in the exact issued set. Exact `/bin/df -kP`
output must bind that same partition device and mount point before its independently bounded
1024-byte total, used, and available counts are accepted; APFS container metadata means used plus
available need not equal total. Ordinary file type formatting is not filesystem evidence. Its hard
allocated-resource ceiling is the logical repository budget plus a fixed 192 MiB filesystem reserve
covering the bounded APFS container and filesystem metadata observed on the supported Darwin host.
The byte ceiling is required to divide exactly into 512-byte sectors before forming `hdiutil`'s
sector-valued `b` size argument. The private evidence binds the image, device, mount, filesystem,
block/free-space geometry, logical budget, reserve, and read-only remount; polling is only an
early-cancellation optimization, never quota proof. Initial attachment explicitly requests
read-write authority for the filler and checkout; an explicit read-only reattach removes it before
scanning. The packaged CLI runs with the Node permission model plus a Darwin network/write sandbox.
Live capture fails closed on platforms without that reviewed sandbox; platform/release testing
belongs to K04/K06.

Before preparing a capture on Darwin, verify that the host kernel can actually apply a sandbox
profile. The presence of `/usr/bin/sandbox-exec` alone is not sufficient: managed macOS runners can
expose the binary while denying the `sandbox_apply` operation. Use an empty mode-`0700` temporary
directory and a harmless system executable; this probe does not access a repository, network, or
private capture data:

```sh
node --input-type=module <<'NODE'
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBoundedCommand } from "./tools/metadata-calibration/execute.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-capability-"));
await chmod(root, 0o700);
try {
  const result = await runBoundedCommand(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1) (allow default)", "--", "/bin/echo", "ok"],
    {
      cwd: root,
      environment: { HOME: root, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maximumStderrBytes: 4096,
      maximumStdoutBytes: 4096,
      timeoutMs: 30_000,
    },
  );
  console.log(JSON.stringify(result));
} finally {
  await rm(root, { force: true, recursive: true });
}
NODE
```

Proceed only when the result has `status: 0`, `signal: null`, and stdout `"ok\n"`. A managed host
that returns status `71` with stderr `sandbox-exec: sandbox_apply: Operation not permitted\n` is
explicitly unavailable for K03. Keep the committed native proof in its pending state and do not
replace the result with a self-asserted proof; retry on a host that permits nested Darwin sandbox
profiles. On 2026-08-11 this repository's macOS arm64 host returned that exact denial, and the
native-proof assembler produced no output artifact.

This boundary follows the reviewed semantics of the
[Node.js permission model](https://nodejs.org/docs/latest-v24.x/api/permissions.html),
[Git partial clone options](https://git-scm.com/docs/git-clone), and
[Git credential configuration](https://git-scm.com/docs/gitcredentials), retrieved 2026-08-09.

Standard output is the fingerprint-only public report. The private file contains bounded B04
diagnostic explanations and disposable checkout locations but no copied source bytes. It is mode
`0600`, exclusively and durably created, and must never be staged. Retain the capture root through
the accountable maintainer review, precision generation, and the successful final K03 gate: each
phase re-verifies the same frozen checkout identities. Only after that gate may the operator invoke
`pnpm metadata-calibration:cleanup` with the exact corpus, report, private bundle, work root, and
`--acknowledge-successful-final-k03-gate`. The bounded command preflights every target, then
detaches and removes only the digest-bound quota resources. Capture failures still attempt immediate
cleanup of every issued resource. Never run repository scripts, install repository dependencies,
initialize submodules, or prepare any external patch, branch, commit, issue, comment, or
notification. After checkout, the harness removes `origin`, freezes every checkout and Git-control
file read-only, and records an inventory. It verifies that inventory after scanning and again when
precision evidence is finalized. Every regular-file byte digest is part of that inventory, so
same-size or timestamp-restored substitutions fail. Pre-abort, live cancellation, timeout,
output-limit, malformed-output, quota, and successful return all terminate the issued process group.
This guarantee covers the exact reviewed command graph; external repository commands, hooks,
lifecycle scripts, unbound executables, and detached Node children are denied rather than treated as
arbitrary daemon input.

The accountable maintainer receives one complete worksheet and the private bundle. The committed
closed authority record supplies the stable ID and defines repository-owner merge as the human
acceptance boundary. The maintainer labels all errors and warnings as true-positive, false-positive,
uncertain client behavior, or harness defect. The committed report, review, adjudication, and
precision evidence contain only repository IDs, rule IDs, severities, fingerprints, counts, and
committed tuning-test paths/digests. The worksheet, review, and adjudication also bind the exact
private payload digest. The normal CLI generates review and adjudication times rather than accepting
them from positional input. They form an ordering ledger, not a trusted timestamp attestation; no
cryptographic signature is claimed without a separately provisioned trusted key. Adjudication and
precision evidence hash-bind the exact authority and review artifacts. If tuning occurs, retain the
exact pre-tuning report, maintainer review, and adjudication as public fingerprint-only artifacts.
The offline gate reconstructs that pre-tuning decision chain before accepting any cited false
positive. Run it against the exact extracted `1.0.0` release and reviewed executables:

```sh
AGENT_CONTEXT_LINT_K03_GIT=/absolute/reviewed/git \
AGENT_CONTEXT_LINT_K03_HDIUTIL=/usr/bin/hdiutil \
AGENT_CONTEXT_LINT_K03_NODE=/absolute/reviewed/node \
AGENT_CONTEXT_LINT_K03_PACKAGE_ROOT="$K03_PACKAGE_ROOT" \
AGENT_CONTEXT_LINT_K03_CLI_ENTRY="$K03_PACKAGE_ROOT/node_modules/@agent-context/lint/dist/cli.js" \
AGENT_CONTEXT_LINT_K03_PRIVATE_REVIEW="$K03_WORK_ROOT/private-review.json" \
AGENT_CONTEXT_LINT_K03_PRE_PRIVATE_REVIEW="$K03_PRE_WORK_ROOT/private-review.json" \
pnpm metadata-calibration:precision:check
```

The gate runs without network access and must be invoked through the pinned pnpm 11.18.0 package
script under the captured Node executable. Capture binds immutable engine commit E. Final evidence
is committed separately as clean descendant A; E..A may contain only the closed K03 evidence and
documentation paths. The gate rejects build, lockfile, engine, F16, and regression drift,
materializes E independently with reviewed absolute Git and tar executables, and hashes every E
path/mode/blob before building. It rechecks every A tracked byte before and after replay and uses
I02's canonical frozen/offline/ignore-scripts workspace builder twice. Both independently built CLI
and core tarballs must be byte-identical. The gate then extracts the clean runtime, recomputes its
complete CLI/core identity, executes every cited standalone regression, runs the real F16
three-schedule reconstruction, and requires the final engine commit to contain the exact F16 bytes.

A tuned chain also supplies its exact pre-tuning private bundle and rechecks every pre-tuning
checkout after review. Pre-tuning adjudication must strictly predate final capture, which must
strictly predate final reviews and adjudication. `pnpm metadata-calibration:quota:native` is the
mandatory real Darwin fast-copy/ENOSPC proof; fake providers never count as release evidence. The
release gate reruns that probe and requires exact tool, filesystem type/name, logical budget,
reserve, ENOSPC, confinement-profile, and cleanup identities. Filesystem geometry must retain the
exact block size and its block count may vary by at most one, to account for APFS allocation
rounding. The reserve filler establishes the initial logical free-space ceiling; repository payload
may reduce free space but cannot raise it above that ceiling. Attach recovery detaches every new
base device bound to the exact issued image, preserves the original attach failure, and never
detaches a concurrent device bound to another image. A detach race is accepted only after fresh
inventory and host-mount identity prove that the issued image is already detached. The closed
gate-state artifact remains feature-unavailable until the committed native Darwin quota and
parent-confinement proof plus genuine adjudication exist. Its native-proof path replaces any
self-asserted validation boolean. The normal metadata test validates that pending state, while
`metadata-calibration:precision:release` fails until the state is ready.

Native proof publication requires
`--acknowledge-native-release-capture --output <absolute-new-file>`. The assembler runs the real
quota and both install/pack confinement probes, reconstructs the embedded quota and profile digests,
and validates the closed ready schema before publication. Output is create-only: a same-directory
mode-`0600` temporary file is synced, linked without replacement, and followed by a directory sync.
Existing proof files are never edited or overwritten.

The native build proof inventories the entire published pnpm package under closed 5,000-entry and 64
MiB ceilings, including its worker, built-in `pnpmrc`, and bundled transitive modules. The source is
copied twice without dereferencing links into an unpublished private snapshot container. Acquisition
holds and rechecks the canonical source directory chain, the container is locked before child start,
and the two complete inventories must match as a content fixed point. Every snapshot file is opened
no-follow and hashed with pre/post identity checks, and copied links are rejected. Inventory is
delegated to the digest-bound child under exact Node and an OS read/process sandbox limited to those
snapshots and fixed runtime inputs; its argv, handshake, and closed output schema are verified. The
child pauses only after snapshot root directories are enqueued, permitting the native test to
replace a queued source directory and prove that no bytes are read from the seatbelt-allowed outside
target. Only the sandbox child's result can populate authoritative `pnpmRuntime`; managed hosts that
cannot apply the sandbox remain feature-unavailable. Production inventory holds and rechecks the
exact sandbox, vendored Node, child, and the complete canonical component chain to a held
filesystem-root anchor across execution and exposes no command-injection seam. Vendored Node and
child bytes are copied from held file descriptors into an unpublished digest-verified bundle. The
SIP-protected Apple platform binary `/usr/bin/sandbox-exec` is invoked at its fixed canonical path
because a relocated copy is not executable; its held bytes and complete canonical path are still
rechecked before and after execution. Restored grandparent or whole-tree substitution therefore
cannot run and rejects the result. The pnpm owning manifest is canonical and no-follow read; ascent
occurs only when the nearer `package.json` directory entry is truly absent. Malformed,
duplicate-key, symlinked, non-file, unreadable, or identity-unstable nearer manifests fail closed.
Its fixed `bin.pnpm` mapping must resolve exactly to the supplied ESM launcher, while the CJS
compatibility shim is separately bound. The manifest reader compares the immediate pre-open pathname
identity to the no-follow handle and then rechecks both the held file and canonical pathname after
reading; pre-open inode replacement or post-open pathname substitution is rejected
deterministically. The complete inventory is re-created before and after each package-manager
operation. TypeScript and esbuild entries are resolved independently from their canonical owning
manifests in the actual pnpm layout. Native proof records distinct normalized install, pack, and
extraction policy digests, including the complete sorted helper and executable allowlists, and each
operation rechecks them afterward. Darwin `/bin/sh` dispatches through the exact identity-bound
`/bin/bash` variant, so both paths are explicit proof-bound helpers rather than a general shell
allowance.

Confirmed false positives may tune classifiers, rule thresholds, default severity, or enablement
only from this 50-repository calibration set. Each change receives a minimal synthetic regression
fixture owned here and is recorded against same-rule fingerprints. Regenerate F16 after a rule
change and require 69/69 recall before finalizing. The fresh K06 ten-repository trial remains
unselected, unobserved, and unused; the precision evidence schema fixes its count to zero.
