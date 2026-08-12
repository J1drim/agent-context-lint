# ADR-0002: Package manager and version policy

- Status: Accepted
- Date: 2026-08-01
- Ticket: A01
- Decision owners: Maintainers

## Context

The planned repository contains many TypeScript packages with strict dependency
directions. Local development, CI, release builds, and provenance generation must
resolve the same graph. Dependency upgrades must be deliberate and reviewable,
especially because normal linting processes hostile repository input and the
standards channel has a supply-chain trust boundary.

The implementation plan already recommends a pnpm workspace. pnpm 11 supports
Node.js 24, stores workspace settings in `pnpm-workspace.yaml`, and supports an
exact project package-manager declaration. pnpm 12 is beta on the decision date
and its installation path differs from pnpm 11.

## Decision

### Package manager

Use pnpm `11.18.0` exclusively for repository development, workspace dependency
resolution, CI, packing, and release production.

A02 must encode the choice in all of these places:

```json
{
  "packageManager": "pnpm@11.18.0",
  "engines": {
    "node": "^24.11.0 || ^26.0.0",
    "pnpm": "11.18.0"
  }
}
```

The root configuration must reject a different pnpm version. CI setup actions
must also pin `11.18.0`; they must not use floating `latest` or major-only tags.
Corepack may honor `packageManager` where it is installed, but the project must
not assume that Node.js bundles Corepack. Bootstrap documentation must include a
version-pinned installation path that works without it.

The lockfile is `pnpm-lock.yaml`, uses the format emitted by pnpm 11.18.0, and is
committed. CI and release builds use a frozen lockfile. Any unexpected lockfile
change fails validation.

Workspace packages declare internal dependencies with the `workspace:` protocol
so a registry package can never silently replace a local package. Shared version
choices live in the pnpm workspace catalog when A02 creates the workspace. pnpm
configuration belongs in `pnpm-workspace.yaml`, not the deprecated `pnpm` field
of `package.json`.

No npm, Yarn, or Bun lockfile may be committed. npm, Yarn, and Bun remain
installation-test clients for the packed public artifact, as required by the
release plan; they are not repository development package managers.

### Exact development baseline

The initial foundation baseline is:

| Tool | Exact version | Contract |
|---|---:|---|
| Node.js development runtime | `24.18.1` | Exact version file; distinct from the public engine range |
| pnpm | `11.18.0` | `packageManager`, `engines.pnpm`, CI setup, lockfile producer |
| TypeScript | `7.0.2` | Exact root catalog/dev dependency when A02 adds the compiler |

These are the stable, non-prerelease versions selected on 2026-08-01. A02 may not
substitute floating tags or older majors. If a release is withdrawn or an
incompatibility is discovered before A02 lands, changing this table requires an
amendment to this ADR with evidence; it is not an implicit implementation choice.

### Dependency declarations and lock policy

- Root and workspace direct `dependencies`, `optionalDependencies`, and
  `devDependencies` use exact versions. Peer dependencies, if introduced, use
  the narrowest compatible semver range and are tested at both bounds.
- Transitive versions and integrity data are fixed by the committed lockfile.
- Registry Git URLs, branches, mutable tarball URLs, and unpinned Git dependencies
  are prohibited. A temporary Git commit dependency requires an ADR and full
  commit hash.
- Prerelease dependencies are prohibited in release branches unless a dedicated
  experiment ADR says otherwise; they cannot enter a GA artifact.
- Install scripts are denied by default. A dependency requiring a lifecycle or
  native build script must be explicitly allowlisted with rationale, ownership,
  and CI coverage.
- Generated lockfile changes are reviewed as code. A dependency update commit
  includes the manifest/catalog change, complete lockfile diff, relevant release
  notes or advisory, and passing tests.

### Update cadence

- A scheduled automation job may propose stable patch and minor updates once per
  week. It must create reviewable changes and must never merge or publish them.
- Normal updates observe a seven-day minimum release age. A maintainer may waive
  it for a documented vulnerability fix after checking upstream provenance and
  running the complete affected test matrix.
- Patch/minor dependency updates stay within the accepted architecture and need
  normal review. Major updates to Node.js, pnpm, TypeScript, the Markdown/YAML
  parser, glob engine, schema validator, test runner, signing implementation, or
  sandbox require explicit compatibility review; a changed runtime/module/public
  contract requires a superseding ADR.
- The pinned development Node.js patch is reviewed monthly and after Node.js
  security releases. Supported engine floors change only under ADR-0001.
- The pnpm patch pin is reviewed monthly. Major pnpm upgrades require a clean
  install, lockfile-format review, packed-artifact matrix, and an ADR amendment or
  superseding ADR.
- Production releases are built only from the reviewed frozen lockfile. Release
  automation never refreshes dependency resolution while packing or publishing.

## Consequences

- Contributors get one deterministic workspace workflow and one lockfile.
- Direct dependency changes are noisier but cannot arrive because a permissive
  range happened to resolve differently.
- Consumers can still install the packed CLI with npm, pnpm, Yarn, or Bun; this
  decision governs repository development, not the consumer's installer.
- Automated updates remain proposals subject to tests and human review.
- A02 and A09 have precise package-manager and lockfile expectations.

## Rejected alternatives

### npm workspaces

Rejected because pnpm provides stricter workspace linking, a dedicated workspace
configuration file, and the `workspace:` protocol required by the planned package
boundaries. npm remains important in the consumer installation matrix.

### Yarn or Bun as the repository package manager

Rejected because neither improves the plan's pnpm workspace design enough to
justify another lockfile and behavior matrix. Bun is also not the selected
production runtime.

### pnpm 12 beta

Rejected because it is explicitly beta and not recommended for production use
on the decision date. Its native rewrite and different bootstrap behavior should
be evaluated only after a stable release.

### Floating package-manager or tool versions

Rejected because `latest`, major-only pins, and open direct-dependency ranges can
change the build without a reviewed repository diff. That conflicts with
reproducible release and provenance requirements.

### Committing multiple lockfiles

Rejected because multiple solvers can represent different dependency graphs and
make the release input ambiguous. Other package managers test only the packed
consumer artifact.

## Primary sources

Retrieved 2026-08-01:

- [pnpm installation, version pinning, and compatibility](https://pnpm.io/installation)
- [pnpm package manifest and development-engine fields](https://pnpm.io/package_json)
- [pnpm workspace protocol](https://pnpm.io/workspaces#workspace-protocol-workspace)
- [pnpm 11 release notes](https://github.com/orgs/pnpm/discussions/11377)
- [npm registry metadata for the latest stable pnpm release](https://registry.npmjs.org/pnpm/latest)
- [TypeScript 7.0 release announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [TypeScript package release history](https://www.npmjs.com/package/typescript?activeTab=versions)
