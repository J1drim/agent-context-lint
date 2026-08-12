# Rule metadata registry

Ticket B09 defines the single machine-readable inventory of rule identities and their governance
metadata in `@agent-context/rules`. The registry contract version is `0.1.0`, an independent
wire-contract identity shipped in the stable `1.0.0` product release; its closed Draft 2020-12
schema is packaged as `schemas/rule-registry.v0.schema.json`.

## Contract

Each entry contains a stable `ACL100`–`ACL599` identifier, reserved category, default severity,
short description, rationale, accountable governance alias, precision status, fix-safety state, and
repository-relative documentation URL. The committed registry contains exactly the 69 rules in the
v1 plan, once each and in ascending identifier order. Numeric ranges determine categories, so a
caller cannot relabel a security rule as another category.

`defaultSeverity` is the severity to use after a rule qualifies for activation. It does not mean
that an unimplemented rule runs. B09 initialized entries with `precisionStatus: planned` and
`fixSafety: none`; later F-stream implementation and calibration tickets update those fields only
with their required evidence. ACL100–ACL109, ACL150–ACL156, ACL200–ACL206, ACL250–ACL255,
ACL350–ACL355, ACL400–ACL406, and ACL500–ACL506 are `seeded` after their positive, negative,
boundary, malformed-input, suppression, formatter, redaction where required, precision where
required, and integration evidence. ACL450–ACL453 are also `seeded` after F12's issued-E07,
closed-observation, unknown-state, 16-case precision, and packaged formatter evidence. A rule cannot
advertise a mechanical fix before I12 supplies a safety proof and idempotence tests. I12 now marks
only ACL109 as `mechanical`; the other 68 rules remain `none` under the exhaustive
[safety matrix](../rules/mechanical-fix-safety.md).

The owner aliases are the normative placeholders from
[`docs/governance/ownership.md`](../governance/ownership.md). They identify accountability but do
not prove that a GitHub team exists or is active. A10's activation procedure remains a release
blocker for remote enforcement.

## Runtime API

```ts
import {
  RULE_REGISTRY,
  findRuleMetadata,
  resolveRuleDocsUrl,
  validateRuleRegistry,
} from "@agent-context/rules";

const acl250 = findRuleMetadata("ACL250");
const result = validateRuleRegistry(RULE_REGISTRY, { requireComplete: true });
const docs = resolveRuleDocsUrl("ACL250", "https://docs.example.test/agent-context-lint/");
```

`findRuleMetadata` is an exact, case-sensitive binary lookup and returns `undefined` for reserved or
malformed identifiers. `validateRuleRegistry` rejects unknown/accessor/symbol fields, wrong enums,
mis-categorized IDs, duplicate or unsorted IDs, malformed Unicode, oversized text, oversized
registries, sparse or inherited array entries, and every proxy input. `requireComplete` additionally
requires the exact committed v1 ID set; partial registries are otherwise valid for tooling that
intentionally processes a subset. Validation never loads documentation, executes rule code, reads a
repository, or accesses the network.

Text is limited to 1,024 Unicode code points and 4,096 UTF-8 bytes. Registries are limited to 128
entries and 256 reported validation issues. The JSON Schema enforces the closed structural and
Unicode/code-point contract; the runtime adds semantic completeness, ordering, category-range, and
ID-to-document-anchor checks.

## Generated documentation

[`docs/rules/catalog.md`](../rules/catalog.md) is generated deterministically from the registry:

```sh
pnpm rules:docs
pnpm rules:docs:check
```

The aggregate `pnpm check` gate rejects stale generated documentation. The check imports tracked
TypeScript source directly, so it works before a clean-checkout build creates ignored `dist` output.
Every `docsUrl` resolves to exactly one generated rule heading.

Every generated rule entry also contains one concise bad/good example pair. The pairs are explicitly
illustrative: they show the policy shape a reviewer should recognize, but they are not executable
conformance fixtures and do not claim precision for every profile or repository. The profile
conformance corpus and rule integration tests remain the authority for detection behavior. The
source map is closed over all 69 `RuleId` values, so catalog generation fails rather than silently
omitting an example.

Registry `docsUrl` values are repository-relative URL references, not deployment-specific links.
Before an external formatter exposes one, it must call `resolveRuleDocsUrl` with an explicit,
credential-free HTTPS directory base. The resolver returns a directly navigable absolute URL and
rejects HTTP, credentials, queries/fragments, file-like bases, and proxied URL objects. I14 will
provide the product deployment base without changing rule identities.

Adding/removing a rule, changing its ID/category/default severity, weakening precision/fix status,
or changing the registry/schema contract is a reviewed public behavior change. Editorial rationale
or description clarifications are additive only when they do not change detection semantics.
