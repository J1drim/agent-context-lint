# Profile catalog validation

The [canonical B02 profile contract](../contracts/core-profile-contracts.md) defines the model,
relationship semantics, provenance rules, and compatibility authority. This page documents its
runtime API boundary.

`validateProfileCatalog` is the strict runtime boundary for the versioned B02 profile catalog. It
accepts untrusted JSON-shaped input, performs no I/O, and narrows the value to `ProfileCatalog` only
after structural, relationship, provenance, and uncertainty checks pass.

The shared JSON preflight rejects non-finite numbers, negative zero, `undefined`, functions, bigint,
symbols, cycles, accessors, proxies, exotic prototypes, non-enumerable properties, sparse arrays,
and noncanonical array properties. Arrays are inspected by their own keys, so a hostile array with a
very large declared length is rejected without iterating every absent slot. Traversal is iterative
and accepts at most 256 container levels, including the catalog envelope.

Uncertainty is always explicit. Conditional uncertainty requires a non-empty list of unique,
non-empty conditions. Unknown uncertainty requires a reason. Contradiction uncertainty requires a
reason and at least two uniquely identified alternatives.

Both profile-catalog and instruction-IR validation retain at most 255 ordinary issues. When another
issue is discovered, the validator appends a deterministic `resource-limit` sentinel at `$` and
stops. The resulting 256 entries equal `MAX_VALIDATION_ISSUES`. The public validation-code unions
include `invalid-json` for strict preflight failures and `resource-limit` for saturation;
`VALIDATION_ISSUE_LIMIT_CODE` is the exported sentinel-code constant.

```ts
import {
  MAX_VALIDATION_ISSUES,
  VALIDATION_ISSUE_LIMIT_CODE,
  validateProfileCatalog,
} from "@agent-context/core";

const result = validateProfileCatalog(JSON.parse(input));
if (!result.ok && result.issues.at(-1)?.code === VALIDATION_ISSUE_LIMIT_CODE) {
  console.error(`Catalog exceeded the ${MAX_VALIDATION_ISSUES}-issue response bound.`);
}
```
