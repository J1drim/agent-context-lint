# Semantic rule plug-in API

F17 exposes one optional API from `@agent-context/rules`:

```ts
const result = await runSemanticRulePlugin(input, configuration, options);
```

The default `configuration` is `SEMANTIC_PLUGIN_DISABLED_CONFIGURATION`. In that state the function
returns immediately without inspecting `input`. Enabling requires the complete closed record:

```ts
{
  contractVersion: "0.1.0",
  enabled: true,
  pluginId: "reference-contradiction-candidate-v1",
  recordKind: "agent-context-semantic-plugin-configuration"
}
```

No callback, module bytes, path, package name, command, environment, network client, filesystem
facade, model client, or registration function is accepted. Unknown and missing fields fail closed.
The identifier selects release-owned code from a static registry.

## Input

Enabled execution accepts `agent-context-semantic-plugin-input` version `0.1.0`. `documents` is a
dense list of `{ documentId, path, sourceDigest, text }` records. Document IDs and paths are each
unique within one invocation. Paths must already be canonical repository-relative paths. C0/DEL
controls, malformed Unicode, backslashes, drive-relative forms, traversal, dot segments, duplicate
separators, and trailing separators are rejected. Source digests are lowercase SHA-256. The runner
copies each record through own data descriptors before its first asynchronous yield.

Options may lower or raise the default document, finding, byte, and work ceilings up to the exported
hard limits, and may supply a native `AbortSignal`. Every container is plain, descriptor-safe,
non-proxy, closed, and bounded. Runtime admission compares the O(1) UTF-16 string length with the
remaining byte and work ceilings before scanning text or encoding it as UTF-8, then enforces the
exact aggregate UTF-8 byte limit. Candidate line numbers recognize LF, CRLF, and CR source lines.

## Output

Success is a separate `agent-context-semantic-plugin-result` record. It always includes:

- `determinism: "non-deterministic"`;
- `networkAccess: "denied"`;
- `qualityClaim: false`;
- the selected module identity and empty capability list; and
- bounded candidate observations, never B04 diagnostics.

The output cannot be passed into F15 as a rule-family result and is not merged into terminal, JSON,
SARIF, baseline, or exit-status calculations. Packaged `semantic-plugin-configuration.v0`,
`semantic-plugin-input.v0`, and `semantic-plugin-result.v0` schemas validate persisted boundary
records through the corresponding `@agent-context/rules/schemas/...` exports. Runtime admission also
enforces aggregate UTF-8 byte, work, and identity-uniqueness invariants that JSON Schema cannot
express completely.

Failures are `{ ok: false, issues }` with one sanitized issue. Codes are `cancelled`,
`invalid-configuration`, `invalid-input`, `invalid-options`, `plugin-failure`, and `resource-limit`.

## Reference plug-in

The reference plug-in is executable but intentionally narrow. Host code finds bounded `always` and
`never` markers and passes two integer flags to a fixed WebAssembly `classify` function. The module
returns their conjunction. A positive result emits a manual-review candidate; it is not a semantic
equivalence, contradiction, safety, compliance, or quality claim.
