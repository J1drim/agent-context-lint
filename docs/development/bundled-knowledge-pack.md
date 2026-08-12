# Developing the immutable bundled knowledge pack

The committed `packages/standards/bundled` tree is byte-sensitive H03 trust material. Ordinary
development must not rewrite it. Any change to the compiled manifest length/digest, signed metadata,
pack digest, verification time, key identities, or schema is a reviewed trust-anchor migration, not
a formatting update.

The current minimal stable pack contains one real `AGENTS.md` root-location knowledge record. Its
provenance refers to `https://agents.md/`, retrieved 2026-08-02 as 81,690 bytes with SHA-256
`eda3020070376c5cc61d15044b5bfbbd0cdf73267d1d82063bb0659df36add64`. It deliberately makes no
undocumented precedence, discovery, UI, or activation claim.

## Verification workflow

Run the focused contract and real-package checks while changing H03:

```sh
pnpm build
pnpm exec vitest run packages/standards/test/bundled-pack-loader.unit.test.ts
node --test scripts/check-packed-manifests.test.mjs
pnpm pack:check
pnpm check
```

Tests cover positive deterministic loading, frozen provenance, false authority/forgery, closed
request objects, malformed and noncanonical bytes, schema/runtime limit parity, traversal,
non-content-addressed names, symlinks, non-regular files, pre-read mismatch, concurrent mutation,
digest mismatch, TUF signature failure, engine incompatibility, and a network-deny observation.

The guarded `tools/standards/generate-bundled-bootstrap.mjs --create-new-bootstrap` command exists
to document and reproduce the initial bundle shape. It refuses to overwrite an existing bundle. It
creates fresh signing keys in memory, writes only public signed metadata, sets bundle files
read-only, and never persists private key material. Because those bootstrap private halves are
intentionally not retained, this fixture is an immutable packaged offline baseline and cannot
authorize registry updates. A production root/update migration requires the separate H02 custody
ceremony and must not use this helper as a signing service.

For an approved trust-anchor migration:

1. Follow the H02 rotation/recovery runbook and obtain required independent review.
2. Build canonical H01 bytes from documented primary sources. Record URL, retrieval date, exact
   digest, client/version, and every unknown or conditional behavior.
3. Produce threshold-signed H02 metadata and bind exact target path, size, SHA-256, channel, schema,
   identity/version, and minimum engine version.
4. Create a closed canonical manifest, then deliberately update the compiled manifest length and
   SHA-256 in the loader.
5. Run the focused, recovery-drill, packaged-tarball, determinism, coverage, and full repository
   gates.
6. Record the migration evidence without committing any key, credential, writable external checkout,
   or generated upstream patch.

## Primary implementation references

The following official sources were reviewed on 2026-08-02:

- [The Update Framework 1.0.35 detailed client workflow](https://theupdateframework.github.io/specification/v1.0.35/#detailed-client-workflow),
  for out-of-band root, parent metadata bindings, and verify-before-use sequencing;
- [Node.js 24 file-system API](https://nodejs.org/docs/latest-v24.x/api/fs.html), for `lstat`,
  `realpath`, file-handle positional reads/stat, and `O_NOFOLLOW` behavior;
- [npm package `files` contract](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files),
  for explicit artifact inclusion; and
- [npm package creation guidance](https://docs.npmjs.com/creating-node-js-modules), for validating
  the installed tarball rather than only the source tree.
