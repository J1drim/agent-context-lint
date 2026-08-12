# Standards TUF trust model

Ticket H02 defines the `0.1.0` Agent Context Standards TUF Protocol, Operations, Usage, and Format
(POUF). The public offline verifier, immutable trust-state types, limits, and error codes are
exported from `@agent-context/standards`. The closed Draft 2020-12 metadata schema is shipped as
`@agent-context/standards/schemas/tuf-metadata.v0.schema.json`.

This contract implements verification and trusted-state transition only. It performs no network,
filesystem, environment, ambient-clock, command, module-loading, or repository operation. The H03
[immutable bundled loader](bundled-knowledge-pack-loader.md) composes this verifier with fixed
package-relative, content-addressed bytes and is the only bundled-authority minting path. H04/H05
own persistent state and atomic cache; H07/H08 own explicit bounded acquisition. A transport or
cache never becomes a trust root.

## Pinned upstream basis

The adopted specification is TUF `1.0.35`, retrieved on 2026-08-02 from the official specification
repository at commit
[`743c8a026b6edeaa5e64d247c68a31dc9786b5b2`](https://github.com/theupdateframework/specification/blob/743c8a026b6edeaa5e64d247c68a31dc9786b5b2/tuf-spec.md).
The exact `tuf-spec.md` bytes have SHA-256
`2d1c5a2349eb8cf62ef54e668b35e7cf9830c76e9f23b1f085c2f2055ed0f94a`.

Metadata parsing, OLPC canonical JSON signing, Ed25519 verification, and unique-signature threshold
counting use the official TUF JavaScript model packages:

- `@tufjs/models@4.0.0`, source commit
  [`970af8d0b0153a9a1b4e1e9719d52f76b4a665bf`](https://github.com/theupdateframework/tuf-js/tree/970af8d0b0153a9a1b4e1e9719d52f76b4a665bf),
  npm integrity
  `sha512-h5x5ga/hh82COe+GoD4+gKUeV4T3iaYOxqLt41GRKApinPI7DMidhCmNVTjKfhCWFJIGXaFJee07XczdT4jdZQ==`;
- `@tufjs/canonical-json@2.0.0`, the official implementation of the OLPC canonical JSON dialect used
  for TUF signed bytes.

Version `4.0.0` is intentionally pinned because it supports the project's Node `24.11.0` minimum.
The current `@tufjs/models@5.0.0` requires Node `24.15.0`; changing that minimum or dependency is a
reviewed compatibility and SR-04 trust change. The local state-transition layer follows the
[official detailed client workflow](https://theupdateframework.github.io/specification/v1.0.35/#detailed-client-workflow)
and is tested against its threshold, fixed-time, rollback, consistent-snapshot, delegation, and
root-recovery rules.

## Closed repository profile

All metadata is exact UTF-8 OLPC canonical JSON. The signed bytes are the OLPC canonical encoding of
the complete `signed` object; unknown signed or envelope fields are rejected rather than dropped.
This prevents duplicate-key, alternate-encoding, and extension ambiguity. Metadata uses TUF
`spec_version: "1.0.35"`, Ed25519 public keys, lowercase hexadecimal signatures, SHA-256 identities,
and consistent snapshots. A key ID must equal SHA-256 of its canonical public-key object.

Each signed role contains this closed extension:

```json
{
  "x-agent-context": {
    "issuedAt": "2026-08-02T00:00:00Z",
    "policyVersion": "0.1.0",
    "repositoryId": "agent-context-standards"
  }
}
```

`issuedAt` lets the verifier enforce role lifetime and future-clock limits rather than trusting an
expiry date alone. `repositoryId` prevents metadata from another TUF repository from entering this
trust domain. Both are signed.

| Role                | Keys and threshold | Storage/use                                                  | Maximum signed lifetime |
| ------------------- | -----------------: | ------------------------------------------------------------ | ----------------------: |
| root                |             2 of 3 | Three separately controlled offline encrypted/HSM identities |                366 days |
| top-level targets   |             2 of 3 | Three separately controlled offline encrypted/HSM identities |                 93 days |
| `standards-stable`  |             2 of 3 | Offline stable release custodians                            |                 93 days |
| `standards-preview` |             2 of 3 | Separate offline preview custodians                          |                 93 days |
| snapshot            |             1 of 1 | Restricted online metadata identity; no target authority     |                  8 days |
| timestamp           |             1 of 1 | Restricted online freshness identity; no target authority    |                25 hours |

All six top-level key identities are disjoint from one another, and stable and preview each have a
disjoint three-key set that is also disjoint from top-level keys. The top-level targets role carries
no target files. It delegates only the terminating paths `knowledge/stable/*` and
`knowledge/preview/*`. Each knowledge target binds path, exact byte length, SHA-256, channel,
knowledge schema version, pack identity/version, and minimum engine version.

Production private keys are never accepted by the verifier, stored in metadata, committed to this
repository, bundled in an npm artifact, or available to online scan/update jobs. Custodians generate
and store root/targets/channel keys offline with separate recovery material and quorum ceremony.
Timestamp/snapshot credentials live only in their restricted publication environment and cannot sign
targets. Deterministic keys in H02 tests are visibly labeled non-production, generated from public
fixture labels, live only under `packages/standards/test`, and are excluded by the package manifest.

## Offline verification state machine

`OfflineTufTrustStore.bootstrap(root)` accepts an out-of-band bundled root only after closed-policy,
key-identity, and 2-of-3 self-threshold verification. Root expiry is intentionally checked at update
time, matching TUF's bootstrap workflow. `verifyUpdate(bundle, request)` requires a complete already
downloaded candidate and one explicit fixed `startedAt` value:

1. Parse each `N+1` root under hard byte/depth/count limits. Require exactly sequential versions and
   both the preceding root threshold and the candidate's new self-threshold. Check final root
   expiry.
2. If timestamp or snapshot authority changed anywhere in the root chain, discard those prior
   rollback counters before verifying new online metadata. This is the specified recovery from a
   compromised online key's fast-forward versions.
3. Verify timestamp signature, strictly newer version, snapshot version monotonicity, expiry, and
   clock sanity.
4. Verify snapshot length/hash/version against timestamp, then its signature, expiry, and that no
   previously trusted targets metadata name/version was removed or rolled back.
5. Verify top-level targets length/hash/version against snapshot, its 2-of-3 root authorization,
   expiry, exact stable/preview delegation graph, and role/key isolation.
6. Verify the selected delegated metadata against snapshot and its channel's 2-of-3 threshold.
7. Validate every target path and binding in the selected delegated metadata, including entries the
   caller did not request. Require every signed custom channel to match the delegation, then select
   the requested target and check engine compatibility, exact target length, and SHA-256.
8. Publish a new immutable in-memory trust store only after every step succeeds. A failure returns
   one bounded sanitized issue and leaves the prior store unchanged.

Metadata validity uses the single fixed update start time. The verifier never calls `Date.now()`.
Intermediate root expiry is ignored until the latest candidate, as TUF requires. Same-version
timestamp metadata is treated as replay and cannot replace state. A cached or offline pack may be
used by ordinary scans under H03/H06 policy, but it cannot be called a fresh update.

## Resource and hostile-input boundary

| Resource                   |                  Limit |
| -------------------------- | ---------------------: |
| one metadata envelope      |                512 KiB |
| one update root chain      | 32 sequential versions |
| JSON nesting               |                     64 |
| JSON lexical values/tokens |                 50,000 |
| one target                 |                  4 MiB |
| delegated targets          |                  1,000 |
| metadata signatures        |                     32 |
| SemVer or pack ID string   |              256 bytes |
| target path                |            1,024 bytes |
| returned issue path        |              512 bytes |
| returned issue message     |              512 bytes |

Byte ingress accepts strings, plain `Uint8Array`, and Node `Buffer`; it checks string code-unit and
UTF-8 byte ceilings before allocation and copies through trusted typed-array internal slots.
Unpaired UTF-16 surrogates, proxies, subclasses, shared/detached buffers, extra/symbol properties,
accessors, sparse arrays, exotic prototypes, malformed UTF-8, BOM, noncanonical JSON, duplicate
keys, unknown fields, and unsafe integers fail closed. String code-unit limits are checked before
UTF-8 sizing or regular-expression work. SemVer core and numeric prerelease identifiers are compared
by digit length and then lexicographically, so precedence remains exact beyond JavaScript's safe
integer range; build metadata is ignored for precedence. Returned target bytes are a defensive copy
and do not carry trust authority; the immutable descriptor contains their signed digest and length.

## Failure and recovery semantics

Errors distinguish signature, root continuity, replay, rollback, freeze/expiry, mix-and-match,
length, hash, role, channel, engine, policy, malformed input, and resource limits without echoing
hostile metadata. Issue locations use fixed field names or bounded numeric indexes, never untrusted
map keys, and issue text is restricted to bounded printable ASCII. No trust failure falls back to
unverified state. Availability remains outside TUF's guarantee: a mirror can withhold updates, while
an already verified locked pack remains usable offline with explicit staleness.

Operational rotation, revocation, compromise, and drill steps are in
[Standards trust recovery](../security/standards-recovery.md). Run `pnpm standards:recovery-drill`
after any change to roles, keys, metadata, expiry, canonicalization, dependency versions, or
recovery logic.
