# Clean package-manager install matrix

K09 owns the install boundary after the closed bundle and packed-manifest checks. The matrix
exercises the two public tarballs in a fresh disposable consumer project with npm, pnpm, Yarn, and
Bun. Each manager gets its own fixture, so a successful install cannot hide a missing dependency in
a previous manager's `node_modules` tree.

The matrix is deliberately additive to `pnpm pack:check`. The existing pack gate remains the release
authority for the exact clean source build, package inventories, and the exact absolute pnpm
JavaScript launcher. This command never replaces that gate and never resolves a package manager
through `PATH`.

## Run it

With the exact release Node and pnpm launcher available, this command creates both tarballs through
the clean pack flow and then runs every selected manager:

```sh
AGENT_CONTEXT_PACK_NODE=/absolute/path/to/node \
AGENT_CONTEXT_PACK_PNPM=/absolute/path/to/pnpm.mjs \
AGENT_CONTEXT_PACK_NPM=/absolute/path/to/npm-cli.js \
AGENT_CONTEXT_PACK_YARN=/absolute/path/to/yarn.cjs \
AGENT_CONTEXT_PACK_BUN=/absolute/path/to/bun \
node scripts/check-package-install-matrix.mjs --strict --format terminal
```

The `AGENT_CONTEXT_PACK_*` values must be absolute paths. npm and Yarn must identify the exact
`.js`, `.cjs`, or `.mjs` launcher file, and are executed through `AGENT_CONTEXT_PACK_NODE`; a
shell/shebang wrapper or a `PATH` lookup is rejected. `AGENT_CONTEXT_PACK_PNPM` must be the exact
`.cjs` or `.mjs` launcher and is likewise executed through `AGENT_CONTEXT_PACK_NODE`; its reported
version must equal the repository's pinned `packageManager` version (`11.18.0`). Bun is the sole
explicit native exception: its absolute executable is invoked directly, then the installed CLI is
still probed with the attested Node runtime. Every configured manager run begins by invoking the
selected absolute Node executable with `--version`; the observed stable version must match the
report's requested version and satisfy `^24.11.0 || ^26.0.0`. These checks intentionally remain
fail-closed.

Before installing, each configured manager is invoked once with `--version`. The raw matrix report
retains the normalized `managerVersion` (strict `major.minor.patch`), `runtime` (`node` for npm,
pnpm, and Yarn; `native` for Bun), and the attested Node version. This makes a rerun reproducible
when a manager is upgraded and prevents a shebang from silently selecting ambient Node. A
non-zero/signal/stderr manager probe is `manager-version-probe-failed`; output that is not a stable
semantic version is `manager-version-invalid`. Node probe failures use `node-runtime-probe-failed`,
`node-runtime-invalid`, or `node-runtime-mismatch`; an unsupported selected Node is
`node-engine-mismatch`, and an npm/Yarn launcher with the wrong extension is
`invalid-node-launcher`. No version output, executable path, or manager stderr is copied into
retained evidence. pnpm additionally retains the legacy `expectedPnpmVersion` and
`observedPnpmVersion` fields so existing v1 evidence remains replayable.

When tarballs already exist, bypass only the packing step (not the install or runtime checks):

```sh
node scripts/check-package-install-matrix.mjs \
  --cli-tarball /absolute/path/to/agent-context-lint.tgz \
  --core-tarball /absolute/path/to/agent-context-core.tgz \
  --manager npm --strict --format json
```

Use `--manager npm,pnpm,yarn,bun` to select a subset. `--strict` is required for release evidence:
every selected manager must report `passed`. Without `--strict`, the command is exploratory and
reports configured-but-unavailable managers without treating them as passes; it only succeeds when
at least one manager passes and every other selected manager is explicitly unavailable. A blocked
Node engine, malformed executable configuration, failed install, tarball mutation, source-workspace
backlink, missing runtime file, license mismatch, workspace dependency, or CLI version mismatch is
always a failure.

### Deterministic failure diagnostics

Manager admission and install failures are reported with the closed reason codes used by the
retained evidence contract. The matrix never includes an executable path, temporary fixture path,
stderr text, or manager command output in its JSON or terminal report. A malformed absolute-path
configuration is scoped to that manager as `failed`/`invalid-executable`, so another selected
manager still runs and the strict aggregate cannot mistake the malformed configuration for an
unavailable manager. A configured pnpm path must be a regular `.cjs` or `.mjs` launcher (it is
invoked through the pinned Node executable); otherwise it is `failed`/`invalid-pnpm-launcher`.
Install-process failures retain only bounded stdout/stderr byte counts and SHA-256 digests
(`install-failed`), while workspace backlinks, runtime validation failures, and tarball mutation
retain their corresponding stable codes.

These diagnostics are deliberately less specific than a local exception message. Use the bounded
digest and the operator's local process logs to investigate a failed run; never copy raw manager
output into release evidence. The evidence converter additionally maps legacy free-form runner
messages to the same closed codes before canonicalization.

## Offline and safety contract

Every install is run with offline/no-audit/no-fund controls, a reserved invalid registry, and
`--ignore-scripts`. The fixture has no project scripts. Its generated `pnpm-workspace.yaml`, npm
`overrides`, and Yarn `resolutions` pin the transitive core dependency to the already-admitted local
core tarball; this is disposable fixture metadata and never changes the packed manifest. Manager
home, config, cache, and store variables (`npm_config_cache`, `pnpm_config_store_dir`,
`YARN_CACHE_FOLDER`, `BUN_INSTALL_CACHE_DIR`, Bun's transpiler/config paths, and the platform home
variables) are redirected beneath that fixture, so a root-owned or stale user cache cannot make a
run fail or write outside the disposable tree. The matrix retains only bounded status, byte counts,
and SHA-256 digests of manager output; it does not print manager output or tarball paths. Input
tarballs must be regular non-symlink `.tgz` files below the 128 MiB bound and are hashed before and
after each install. The consumer fixture is removed after each manager, whether the run passes or
fails.

Tarball and fixture paths are canonicalized before relative `file:` dependencies are written. This
matters on macOS, where the lexical temporary-directory spelling is often `/var/...` but a child
process resolves its current directory through `/private/var/...`; without canonicalization, a valid
tarball can be addressed as `/private/private/...` and a clean npm install fails before the package
is inspected. The canonicalization is local to the disposable fixture and does not alter the source
workspace or retained report.

The installed manifests must retain the Apache-2.0 license, normalized `@agent-context/core`
dependency, and the `1.0.0` package identity. The CLI executable is invoked from the installed tree
for a version probe. Optional forbidden workspace roots can be supplied through the library API; the
command uses the repository root by default so a package manager cannot silently link back to the
source workspace.

Unavailable npm, pnpm, Yarn, or Bun installations are evidence gaps, not successful verification.
The K09 ticket remains open until the strict matrix has been run with every required manager on the
release Node/pnpm toolchain and its report is retained with the `1.0.0` release evidence.

## Retain and replay evidence

The matrix's `--format json` output is a bounded execution report, not yet release evidence. Convert
it through the closed K09 evidence contract before attaching it to the `1.0.0` release evidence:

```sh
node scripts/check-package-install-matrix.mjs \
  --cli-tarball /absolute/path/to/agent-context-lint.tgz \
  --core-tarball /absolute/path/to/agent-context-core.tgz \
  --manager npm,pnpm,yarn,bun --strict --format json > matrix-raw.json

node scripts/package-install-matrix-evidence.mjs \
  --input matrix-raw.json \
  --output matrix-evidence.json \
  --expected-cli-sha256 "$(shasum -a 256 /absolute/path/to/agent-context-lint.tgz | cut -d ' ' -f 1)" \
  --expected-core-sha256 "$(shasum -a 256 /absolute/path/to/agent-context-core.tgz | cut -d ' ' -f 1)"
```

`package-install-matrix-evidence.mjs` uses exclusive output creation, canonical key ordering, and
mode `0600`; it never overwrites an existing report. The retained report contains no tarball paths,
manager output, credentials, or environment values. Its `reportSha256` covers every canonical field.
Replay or an independent verifier must check that digest and, when the tarballs are available, pass
their exact SHA-256 values as expected identities.

The evidence report is release-ready only when `strict` is true, Node satisfies
`^24.11.0 || ^26.0.0`, every selected manager is `passed`, and the tarball identities match the
candidate artifacts. Missing npm/pnpm/Yarn/Bun executables are retained as `unavailable` and result
in `pending-external` (exploratory mode) or `blocked` (strict mode). Unsupported Node, install
errors, launcher/version mismatches, workspace backlinks, tarball mutation, and runtime validation
failures are never downgraded to a pass. See the
[K09 evidence API](../api/package-install-matrix-evidence.md) and the closed
[report schema](../contracts/package-install-matrix-report.v1.schema.json) for the portable
contract.

Run the deterministic runner/evidence contract suite locally with
`pnpm test:package-install-matrix`.
