# Machine-readable CLI reference

Every `@agent-context/lint` package contains `reference/agent-context-lint-reference.v1.json`. It is
generated from three authoritative inputs:

- the I01–I03 command registry and its option/value metadata;
- the complete B06 configuration JSON Schema, embedded byte-for-byte as parsed JSON and bound by its
  source-file SHA-256 digest;
- the complete B09 rule registry, including rationale, owner, default severity, precision state, fix
  safety, and documentation location.

The outer contract is validated by `schemas/agent-context-lint-reference.v1.schema.json`.
`schemaVersion` versions that aggregate contract independently of the CLI version and the embedded
command/rule contract versions. New additive fields require a compatible schema revision; removing
or changing an existing meaning requires a new major reference schema.

Consumers should validate the file before use, reject unknown major versions, and use the embedded
configuration schema rather than recreating defaults. The JSON is deterministic, key-sorted UTF-8
with LF line endings and no generated timestamp, build path, environment value, or terminal state.
