# Local organization policy packs

Organization policy packs are a closed, data-only B11 contract for sharing reviewed policy inside
one repository. A pack may select registered profiles and surfaces, configure registered built-in
rules, and set a small allowlist of existing configuration values. It cannot add rule logic, load a
module, execute a command, define a regular expression or glob, grant filesystem or network access,
or carry an executable fix.

The public decoded-value schema is
[`organization-policy-pack.v0.schema.json`](../../packages/core/schemas/organization-policy-pack.v0.schema.json).
The runtime entry points are `validateOrganizationPolicyPack`, `classifyOrganizationPolicyTarget`,
and `resolveOrganizationPolicy` from `@agent-context/core`. They perform no filesystem or network
I/O.

## Identity, origin, and provenance

Every document has these independent identities:

- `recordKind` is `agent-context-organization-policy-pack`;
- `schemaVersion` is exactly `0.1.0`;
- `packId` is the stable policy-family identity;
- `packVersion` is an exact SemVer value and identifies immutable policy content;
- `compatibility` pins configuration version 1, profile catalog version `0.1.0`, the exact private
  rule-registry version, and a minimum engine version;
- the validation `origin.path` is the canonical repository-relative path from which the pack bytes
  were obtained, and `origin.sha256` is SHA-256 over those exact bytes before decoding;
- `provenance.approvedSource` is a separate repository-local approval or governance record and its
  exact-byte SHA-256 digest. It is not the pack digest and need not contain the pack itself;
- `approvedBy`, `reviewedAt`, and `revision` identify the approving authority and review.

Both origin paths are non-root, canonical POSIX logical paths. Absolute paths, `..`, repeated or
terminal separators, backslashes, malformed Unicode, controls, and Windows drive forms are rejected.
The validator is lexical and read-free. A loader owned by the safe-filesystem layer must still open
the explicit repository root, reject linked/non-regular files and linked ancestors, prove real-path
containment, bound bytes before decoding, hash the bytes it actually parsed, and reject concurrent
replacement. It must never search parent, home, environment-selected, user-global, or remote
locations. C02 and the CLI integration tickets own that I/O boundary.

No ordinary scan contacts the approval source, a registry, or any other endpoint. A digest records
identity; it does not grant trust or capability by itself.

## Closed capabilities

Each policy has a stable `id`, an `authority`, one typed `target`, and one typed `value`.

| Target    | Allowed effect                                         | Registry check                            |
| --------- | ------------------------------------------------------ | ----------------------------------------- |
| `profile` | Enable or disable one B06 profile                      | Closed D01/B06 profile catalog            |
| `surface` | Enable or disable one surface under its owning profile | Closed profile/surface relationship       |
| `rule`    | Set the B06 `severity` and `maxTokens` pair            | Engine-supplied private B09 rule registry |
| `setting` | Set one allowlisted scalar configuration value         | Closed B11 setting table                  |

The engine must supply `engineVersion`, `ruleRegistryVersion`, and the complete registered B09 rule
ID set as `OrganizationPolicyCapabilities`. Core intentionally does not import the private rules
package. A syntactically valid `ACL999` is still rejected unless the running engine registers it.
Changing the supplied capability set after validation is detected again during resolution.

The setting allowlist is:

- `commands.packageManager`;
- `standards.channel`, `standards.maxAgeDays`, and `standards.requireCurrentInCI`;
- `efficiency.tokenizer`;
- `efficiency.scoreVersion`;
- `efficiency.budgets.alwaysOnTokens` and `effectiveP95Tokens`;
- all six `efficiency.componentWeights.*` values; and
- `efficiency.gradeThresholds.A`, `.B`, `.C`, and `.D`.

Security flags, resource ceilings, ignore globs, lockfile paths, network sources, discovery rules,
precedence rules, command strings, arbitrary options, patterns, fixes, and new rule definitions are
not organization-policy capabilities. Unknown fields fail the complete pack; they never broaden a
scope or become forward-compatible executable authority.

## Authority and precedence

`default` and `enforced` have deliberately different meanings:

| Order | Layer                     | Behavior                                       |
| ----: | ------------------------- | ---------------------------------------------- |
|     1 | B06 built-in default      | Used when no higher layer assigns the target   |
|     2 | Organization `default`    | Supplies an organization-wide default          |
|     3 | Explicit repository value | Overrides an organization default              |
|     4 | Explicit CLI value        | Overrides repository and organization defaults |

An organization `enforced` value is a constraint, not a hidden fifth overlay. It supplies the value
when a higher layer is silent. An explicit repository or CLI assignment with the same value confirms
the constraint. A different value rejects the entire resolution with a `conflict` issue that names
the target and carries the repository location, when available, plus the related pack-policy
location. It never silently ignores CLI intent or silently rewrites the repository value.

A pack may contain only one policy per target and one policy per ID. A repository or CLI layer may
also contain only one assignment per target and ID. Duplicates fail closed rather than using first-
or last-wins behavior. Valid policies and overrides are normalized by stable target/ID order, so
input permutation cannot change assignments, issues, or explanation order. Every successful
assignment records its selected source; explanation events record selection, confirmation, and
replacement in authority order.

## B07 configuration integration boundary

The existing B07 resolver remains `CLI > repository > built-in defaults` when no pack is selected.
An adapter that enables a local organization pack must retain the sparse, explicit repository and
CLI values before B07 expands omitted values to defaults. It converts only explicit values whose
paths map to a B11 target into `OrganizationPolicyOverride` records, runs
`resolveOrganizationPolicy`, and applies the returned assignments to a fresh decoded B06 value for
final `validateAgentContextConfiguration` validation.

Do not infer explicit intent by comparing the already default-expanded B07 result with built-in
defaults: an explicit value equal to a default still has authority and must confirm or conflict with
an enforced policy. Do not pass `ignore`, `limits`, `security`, `standards.lockfile`, or any unknown
CLI option through this adapter. A malformed pack, layer, capability registry, conflict, or final
B06 configuration rejects the whole operation; no partially merged configuration is returned.

## Example

```json
{
  "recordKind": "agent-context-organization-policy-pack",
  "schemaVersion": "0.1.0",
  "packId": "area.security-policy",
  "packVersion": "2.1.0",
  "compatibility": {
    "configurationVersion": 1,
    "minimumEngineVersion": "1.3.0",
    "profileCatalogVersion": "0.1.0",
    "ruleRegistryVersion": "1.2.0"
  },
  "provenance": {
    "approvedBy": "area.security-council",
    "approvedSource": {
      "path": "policy/approved.json",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "reviewedAt": "2026-08-02",
    "revision": "governance.42"
  },
  "policies": [
    {
      "id": "require.acl001",
      "authority": "enforced",
      "target": { "kind": "rule", "ruleId": "ACL001" },
      "value": { "severity": "warning", "maxTokens": null }
    },
    {
      "id": "default.package-manager",
      "authority": "default",
      "target": { "kind": "setting", "settingId": "commands.packageManager" },
      "value": "pnpm"
    }
  ]
}
```

Callers calculate the pack's exact-byte digest and pass the local origin separately:

```ts
const checked = validateOrganizationPolicyPack(decoded, {
  capabilities: engineCapabilities,
  origin: { path: ".agent-context-policy.json", sha256: exactByteDigest },
  locate,
  locateKey,
});
```

Successful documents, assignments, events, and issues are deeply frozen snapshots. Callers retain
ownership of all input objects; validation and resolution never mutate them.

Resolution accepts only the exact `result.value` object returned by a successful call to
`validateOrganizationPolicyPack` in the same loaded module instance. The runtime authenticates that
identity privately before reading any pack property. A forged object, proxy wrapper, or
`structuredClone` is data but is not validated authority and is rejected; callers must revalidate
decoded or transferred data rather than casting it to `ValidatedOrganizationPolicyPack`.

## Hostile-input behavior

The runtime rejects proxies, accessors, symbols, exotic prototypes, cycles or repeated object
identities, sparse or extra-keyed arrays, non-finite numbers, negative zero, malformed Unicode,
control and bidirectional formatting characters, Unicode noncharacters, oversized strings/keys,
excess aggregate text/values/containers, and more than 512 policies. Validation stops at a bounded
issue count. Issue paths and messages are capped at 4,096 and 1,024 UTF-8 bytes respectively. Error
messages use fixed vocabulary and policy identifiers only after bounded validation;
executable-looking field names are explicitly classified as forbidden.

Every bounded string first receives a constant-time UTF-16 code-unit length preflight (UTF-8 cannot
use fewer bytes), so an enormous value is rejected before Unicode or UTF-8 scanning, regular
expressions, or repository-path parsing. Diagnostic child paths collapse to the fixed root marker as
soon as the next bounded component would exceed the path ceiling; deeply nested keys therefore
cannot create a growing chain of cumulative path strings.

The same fail-closed boundary applies to validator options, resolver options, engine capabilities,
origins, rule-ID arrays, targets, and override layers. Location-provider functions are explicit
trusted capabilities whose exceptions are contained. Their return values are independently validated
and cloned: invalid, accessor-bearing, or proxy results are ignored, and callback-owned objects are
never exposed or frozen as part of a result.

Closed public option and source-location objects are key-counted against their exact allowlists
before descriptor values are copied. Origin and callback-returned repository paths are rejected
above 1,024 UTF-8 bytes before canonical repository-path parsing.

The schema uses [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12), and versions
follow [Semantic Versioning 2.0.0](https://semver.org/). The runtime's aggregate/resource and
JavaScript-hostility checks intentionally exceed what portable JSON Schema can express.
