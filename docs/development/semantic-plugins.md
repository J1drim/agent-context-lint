# Developing semantic plug-ins

F17 is a static extension boundary, not a general dynamic plug-in loader. The public API contains
only closed data. `REFERENCE_SEMANTIC_PLUGIN_ID` selects a release-owned 46-byte WebAssembly v1
module embedded in `semantic-plugin.ts`; `REFERENCE_SEMANTIC_PLUGIN_WASM_SHA256` binds its exact
bytes.

## Execution sequence

1. Validate options without invoking accessors or proxy traps and check native cancellation.
2. Validate the explicit configuration. Disabled execution returns before reading the input.
3. Copy and bound every document, relative path, digest, and text byte; reject duplicate document
   IDs or paths. Reject a text value whose O(1) code-unit length exceeds the remaining byte or work
   budget before any linear NUL scan or UTF-8 measurement.
4. Copy and hash the release-owned module bytes, validate WebAssembly, and require exactly zero
   imports plus one `classify` function export.
5. Create a fresh module and instance with an empty import object.
6. Perform bounded linear marker extraction across LF, CRLF, and CR lines, call the fixed
   non-looping function once per document, validate its closed integer result, check cancellation
   between documents, and cap findings.
7. Sort findings by the complete UTF-8 `(path, line, documentId, sourceDigest)` tuple and freeze the
   result recursively at its collection boundaries.

The module has no memory, table, start function, loop, indirect call, or WASI import. Its function
is equivalent to:

```wat
(func (export "classify") (param i32 i32) (result i32)
  local.get 0
  local.get 1
  i32.and)
```

Its fixed instruction count, one-call-per-document rule, aggregate work ceiling, and document cap
bound execution without a wall-clock capability. Native cancellation is checked before admission,
between documents, and before publication. A future module containing variable work or memory must
run in a separately reviewed terminable worker with enforceable time and memory limits; expanding
this in-process contract is not compatible by assumption.

## Adding a release-owned plug-in

Do not add public registration, callback, dynamic import, path, URL, package, environment, WASI, or
caller-supplied module fields. A new plug-in requires a new literal identifier, pinned module
digest, static import/export/memory audit, closed output schema, hostile-input and cancellation
tests, offline/default-byte proofs, a golden result, package export review, and updates to API,
user, developer, security, and threat-model documentation.

Run at least the F17 unit suite, the F15 scheduler suites, package type checking, lint, formatting,
schema validation, package-manifest checks, and the deterministic integration golden. Never update
the deterministic golden to incorporate semantic plug-in output.
