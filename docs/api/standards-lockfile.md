# Standards lockfile API

`@agent-context/standards` exports the H04 closed lockfile contract. A lock records the exact
knowledge-pack identity, signed target binding, TUF trusted-state summaries, selected stable or
preview channel, and the fixed time at which that metadata was verified. It contains no URL,
command, script, credential, executable expression, ambient timestamp, or repository path.

```ts
const serialized = serializeStandardsLockfile(candidate);
const parsed = parseCanonicalStandardsLockfile(existingBytes);
```

Successful values are deeply frozen. Serialization produces RFC 8785 canonical JSON in UTF-8 key
order with no trailing newline. Parsing accepts only exact canonical UTF-8 text or ordinary
`Uint8Array`/`Buffer` bytes up to 64 KiB. BOMs, malformed UTF-8, duplicate keys, whitespace,
alternate escapes, unknown/missing fields, unsafe JavaScript containers, invalid dates or SemVer,
wrong roles/channels, pack-to-target mismatches, absent selected delegations, and metadata not
current at `verificationTime` fail closed with bounded structured issues.

The portable Draft 2020-12 schema is
`@agent-context/standards/schemas/standards-lockfile.v1.schema.json`. Runtime validation is stricter
where JSON Schema cannot express cross-field equality, calendar validity, exact UTC instants, and
the TUF metadata time window.

## Explicit atomic update

`updateStandardsLockfile(writer, request)` composes structurally with the I10
`createAtomicRepositoryWriter()` capability without adding a standards-to-evidence package
dependency:

```ts
await updateStandardsLockfile(writer, {
  expected: {
    identity: observed.identity,
    sha256: observedSha256,
  },
  lockfile: candidate,
  path: "agent-context-standards.lock.json",
});
```

H04 validates and canonicalizes the complete request before calling the trusted writer. I10 then
requires the device/inode and SHA-256 observed through the selected repository, revalidates them,
and performs its same-directory compare-and-swap replacement. H04 does not catch writer failures:
the I10 `committed` flag remains authoritative. `committed: false` means the prior lock remains in
place; `committed: true` means rename occurred before a later durability or cleanup failure and the
caller must inspect the published file rather than claim rollback.

The update API replaces one existing regular file only. It cannot create a missing lockfile,
directory, patch, branch, or commit. Initial lock creation remains unavailable until a separately
reviewed no-clobber creation primitive exists. Normal scans never construct the writer and remain
offline and read-only.

Parsing a lockfile does not independently authenticate it. Consumers must re-establish the H01/H02
schema, target digest, compatibility, and TUF trust required by their operation; a repository author
can edit repository-local lock bytes. `verificationTime` records the original fixed verification
decision and must never be presented as proof of current global freshness.

H06's [offline standards status](offline-standards-status.md) keeps this boundary visible. It can
display a valid same-channel lock and calculate that record's age, but selects locked activation
only when the pack, target, fixed verification time, and complete TUF trusted-state snapshot exactly
match the H03 authenticated bundled pack. A different lock remains authority-neutral and receives
`lock-authority-unauthenticated`; H09 must authenticate non-bundled content before activation.

H09's [verified update transaction](standards-update.md) authenticates both the current evidence and
candidate, binds the supplied canonical current-lock bytes to I10's observed digest, publishes
candidate bytes to H05 before lock visibility, and then delegates the only activation write to this
H04/I10 path. Its rollback capability restores the exact prior parsed lock through another
identity/digest compare-and-swap; it cannot synthesize or force a downgrade.
