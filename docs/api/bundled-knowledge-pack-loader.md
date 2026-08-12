# Immutable bundled knowledge-pack loader

Ticket H03 provides the only API that can mint authenticated authority for the standards pack
shipped inside `@agent-context/standards`:

```ts
const result = await loadBundledKnowledgePack({
  channel: "stable",
  engineVersion: "0.1.0",
});
```

`loadBundledKnowledgePack` is deterministic and offline. It accepts a closed, plain-data request; it
does not read environment variables, the working directory, an ambient clock, or a caller path. It
performs no network request and executes no repository content. The package-relative bundle root,
manifest path, manifest length, and manifest SHA-256 are compiled into the loader.

The result is a frozen discriminated union. On success, `origin` is `bundled`, `pack` is the
recursively frozen H01 knowledge pack, and `provenance` records the manifest digest, content path,
content length and digest, fixed verification time, signed target binding, and H02 trusted-state
snapshot. `isAuthenticatedBundledKnowledgePack(value)` recognizes only objects minted through this
fixed production path. Structural copies, proxies, caller-created objects, and test-fixture results
cannot acquire that authority.

The standards command obtains the matching H02 capability with:

```ts
const trust = getAuthenticatedBundledTrustStore(result.value);
```

`getAuthenticatedBundledTrustStore` returns the private in-memory trust store only for the exact
object returned by the production loader. It returns `undefined` for structural copies, serialized
provenance, proxies, and fixture-loader results. Callers must keep the capability in process memory;
it is never included in H06/H08/H09 reports, lockfiles, caches, or command output. This accessor is
the narrow handoff from H03 to the explicit H08/H09 command path and does not grant authority to
repository-authored data.

## Verification order

The loader fails closed before returning pack data:

1. Validate the request without invoking getters, coercion, proxies, or user code.
2. Read the fixed manifest only when its compiled length and digest match.
3. Require exact canonical UTF-8 JSON and the closed manifest contract. Paths are bounded canonical
   relative POSIX paths, and pack filenames are `packs/sha256-<digest>.json`.
4. Read every referenced file through a regular-file, no-symbolic-link boundary. Check declared size
   before allocation, opened-file identity, exact positional length, post-read identity,
   containment, and SHA-256. A concurrent truncate, growth, replacement, or same-length mutation
   fails.
5. Bootstrap H02 from the bundled root and verify timestamp, snapshot, top-level targets, stable
   delegation, target signatures, thresholds, expiry at the manifest's fixed time, rollback policy,
   target path, length, digest, channel, and minimum engine version.
6. Pass only the verified target bytes to the H01 canonical parser and cross-bind channel, pack ID,
   pack version, and schema version to signed target metadata.

No error falls back to unverified bytes. Issues use fixed bounded paths/messages and distinguish
invalid input/manifest, unsafe paths/files, concurrent change, manifest mismatch, TUF failure, pack
failure, and signed-binding mismatch.

## Manifest contract and limits

The portable Draft 2020-12 schema is
`@agent-context/standards/schemas/bundled-pack-manifest.v0.schema.json`. Runtime validation also
requires canonical bytes, real UTC dates, unique channels, exact metadata locations, content-address
agreement, and filesystem safety.

| Resource                  |           Limit |
| ------------------------- | --------------: |
| Manifest bytes            |         128 KiB |
| Manifest entries          |               2 |
| Relative path             | 256 UTF-8 bytes |
| One TUF metadata envelope |         512 KiB |
| Knowledge-pack content    |           4 MiB |

The bundled pack is a safe offline baseline, not proof that no newer standards exist. H06's
[offline standards status](offline-standards-status.md) reports bundled/locked/latest-known state at
an explicit caller-supplied time. Only the explicit H07/H08 commands may perform network freshness
checks.

H04's [standards lockfile](standards-lockfile.md) can record this loader's exact pack, target,
trusted-state, and fixed verification-time provenance. A parsed repository lock remains untrusted
data until the consuming operation re-establishes the required H01/H02 authority; lock parsing alone
does not mint the loader's authenticated brand.

H05's [standards cache](standards-cache.md) stores content-addressed bytes as explicitly untrusted
offline data. A cache hit never bypasses this loader's H01/H02 verification and authority boundary.

## Packaged artifact

`pnpm pack:check` builds and inspects the actual standards tarball. It requires the loader, schemas,
manifest, all signed metadata, and the content-addressed pack; recomputes the manifest's compiled
length/SHA-256 anchor and every referenced file's length/SHA-256; verifies the content filename; and
rejects private-key material. Source-only tests do not replace this check.
