# Offline release-artifact bundle

`scripts/release-artifacts.mjs` prepares and verifies a `1.0.0` release evidence bundle without
network access, package-manager execution, Git commands, publication credentials, or signing keys.
It is a local integrity layer for K10; it is not npm provenance, a signature, or a publication
workflow.

## Generate

Prepare a directory containing only the release payload (for example, the public package tarballs),
plus reviewed release notes and the upgrade/rollback guide:

```sh
node scripts/release-artifacts.mjs generate \
  --input artifacts/rc-payload \
  --output artifacts/rc-bundle \
  --version 1.0.0 \
  --release-notes CHANGELOG.md \
  --rollback-guide docs/development/releasing.md
```

The output directory must not already exist. Generation is deterministic for identical input bytes.
It contains:

- `release-manifest.json`, the schema-versioned path/size/SHA-256 inventory;
- `checksums.sha256`, covering every bundle file except itself;
- `sbom.spdx.json`, either the supplied canonicalized SPDX 2.3 dependency SBOM or a generated
  artifact-inventory SBOM when `--sbom` is omitted;
- `RELEASE_NOTES.md` and `UPGRADE_AND_ROLLBACK.md`, copied byte-for-byte after safety checks; and
- the payload files copied from `--input`.

The generated inventory SBOM records release files, not transitive npm dependencies. A release
candidate must provide the dependency SBOM produced by the reviewed supply-chain workflow using
`--sbom`; omitting it is useful for local integrity tests but does not satisfy the dependency-SBOM
release gate.

## Verify

Verification is read-only and recomputes every manifest digest, checksum, path, file size, SPDX
shape, release-note heading, and rollback-guide heading:

```sh
node scripts/release-artifacts.mjs verify \
  --bundle artifacts/rc-bundle
```

Use `--version 1.0.0` with `verify` when the caller needs an expected-version assertion. The
verifier rejects symlinks, special files, path traversal, duplicate or missing entries, oversized
files, changed bytes, and manifests that claim publication, provenance, key use, or signatures.

## What this command deliberately does not do

- It never calls npm, Git, a package manager, a shell, or a network API.
- It never reads environment tokens, private keys, signing agents, or GitHub credentials.
- It never publishes packages, creates tags/releases, uploads assets, or emits npm provenance.
- It never fabricates a signature. `signature.state` remains `not-produced` until a separately
  reviewed signing workflow verifies a detached signature against this exact bundle.

The independent K10 acceptance requirement remains verification of the published `1.0.0` release,
including npm provenance and signatures. This local bundle is necessary evidence and a safe
pre-publication check; it is not that acceptance evidence.

The manifest contract is versioned at
[`release-artifact-manifest.v1.schema.json`](../contracts/release-artifact-manifest.v1.schema.json).
The broader release preparation and Changesets policy is in [`releasing.md`](releasing.md).
