# Stable JSON formatter

Ticket I05 implements the native machine-output formatter in the private `@agent-context/formatters`
workspace package. It consumes one B04 diagnostic bundle, the exact B03 source registry used to
validate that bundle, and explicit formatter options. It emits the B05 `ScanJsonOutput` record; it
does not define a second JSON vocabulary.

## API

```ts
const result = formatJsonDiagnostics(diagnosticBundle, sources, {
  failureThreshold: "error",
  chunkBytes: 16_384,
  profileVersions: {
    "codex-cli": {
      profileVersion: "2026.8.2",
      clientVersion: "0.74.1",
    },
  },
});

if (!result.ok) {
  // Treat result.issues as a formatter failure. Messages never contain input text.
} else {
  process.stdout.write(result.text);
  process.exitCode = result.output.summary.exitCode;
}
```

`profileVersions` is required, non-empty, and must exactly equal the profile IDs in non-empty
diagnostic fingerprint bases. Its keys are canonicalized in Unicode code-unit order. Each identity
requires `profileVersion`; `clientVersion` is always present in the output and is either a non-empty
bounded string or explicit `null`. `failureThreshold` defaults to `error`. `chunkBytes` defaults to
16,384 and accepts integers from 256 through 1,048,576 UTF-8 bytes. Omitted optional formatter
options select their documented defaults; explicit `undefined`, missing identity members, and
coercible values are rejected.

The successful result exposes exact `text`, its UTF-8 `byteLength`, deterministic `chunks`, and the
sanitized parsed `output`. The result, chunk array, output, and every nested output object and array
are frozen. No result retains a caller-owned diagnostic object.

## Stable wire representation

The formatter delegates its wire contract, validation, sanitization, and canonical serialization to
B05:

- `recordKind` is `agent-context-scan-output` and `schemaVersion` is `JSON_OUTPUT_SCHEMA_VERSION`
  (`1.0.0`), which self-identify the schema family and exact version;
- the compact document is encoded as UTF-8, has object keys recursively sorted by Unicode code unit,
  and ends in exactly one formatter-owned LF;
- arrays retain contract order; in particular, diagnostic and suppression arrays retain validated
  caller order;
- JSON string escaping is the ECMAScript `JSON.stringify` representation after B05 sanitization;
  there is no insignificant whitespace before the final LF and no ANSI output;
- required nullable members such as `clientVersion`, suppression `reason`, suggestion `fixPlan`, and
  evidence `factId` remain explicit `null`; the formatter does not turn `null` into omission; and
- the embedded B04 bundle retains `contractVersion`, diagnostic `ruleVersion`, fingerprint profile
  identities, resolution/spec snapshot evidence, retrieval metadata, and the supplied B05 profile
  and client versions. These are the profile, ruleset, and specification provenance carried by the
  existing contracts.

The formatter deliberately does not sort or deduplicate diagnostic arrays and does not resolve
severity or suppression policy. F15 owns canonical scheduling, deduplication, severity policy,
suppression matching, and stable sorting before the formatter is called. Consequently, identical
validated ordered inputs and identical options are byte-identical; permuting diagnostics changes the
corresponding array order in the output.

The summary is derived from the B05 relationship rules. Diagnostics whose path fingerprint appears
in a `suppressed` suppression record are excluded from active severity counts. `suppressed` counts
unique matched path fingerprints. `warning` fails on active errors or warnings, `error` fails only
on active errors, and `never` always yields exit code 0. Operational formatter and sink failures are
not successful JSON documents and do not use exit code 2 inside a fabricated output record.

## Sanitization and closed failure behavior

The complete B04 and B05 runtime validators run before success. They bind locations, ranges,
digests, fingerprints, fix relationships, suppressions, profiles, summary, and schema versions to
the supplied sources. The published Draft 2020-12 output schema and referenced diagnostic schema are
exercised against the formatter golden in automated tests.

Every JSON key and string passes through B05's shared inert-output boundary. C0/C1 and Unicode bidi
formatting controls become `�`, caller-provided SGR is removed, and known credential patterns and
test canaries become `REDACTED`. The final framing LF is added only after sanitization. If redaction
would change an identity-linked value without its corresponding identity—for example, sanitizing a
create-document fix body would invalidate its `contentDigest`—B05 rejects the complete document. The
formatter reports the fixed `serialization-failed` issue and emits no bytes instead of changing fix
semantics or leaking the original text.

Options and sinks are closed plain data objects. Proxies, revoked proxies, accessors, symbols,
exotic prototypes, unknown properties, malformed Unicode, sparse arrays, duplicate relationships,
and oversized strings or containers fail without coercion or invoking caller accessors. Options are
bounded before their descriptors or diagnostic trees are inspected. B04/B05 then enforce the shared
maximum nesting, issue count, source, diagnostic, suppression, relationship, string,
aggregate-string, container, and value budgets. Serialized output has the additional explicit
67,108,864-byte ceiling. Failures return one frozen issue with a fixed path and message; exception
messages, abort reasons, sink errors, and repository content are never reflected.

## Streaming and atomicity boundary

```ts
const written = await writeJsonDiagnostics(
  diagnosticBundle,
  sources,
  options,
  {
    async write(chunk) {
      await destination.write(chunk); // fulfillment acknowledges backpressure
    },
  },
  abortSignal,
);
```

Streaming uses complete in-memory preflight because the B05 aggregate and formatter byte ceilings
bound the document. Before the first sink call, the formatter validates the inputs, constructs and
validates the B05 record, sanitizes and serializes it, checks the aggregate byte ceiling, parses and
revalidates the emitted bytes, freezes the model, and creates deterministic chunks. A preflight
failure therefore writes exactly zero bytes and can never leave a partial schema-invalid document.

Chunks never exceed `chunkBytes`, never split a Unicode scalar or UTF-8 sequence, and reconstruct
the buffered `text` exactly. The writer awaits each returned promise before invoking `write` again,
providing backpressure with at most one write in flight. A real intrinsic `AbortSignal` is optional;
every pending write is raced against it, so cancellation also releases a nonsettling sink promise.

An arbitrary sink cannot be rolled back. A throw, rejection, or abort after acknowledged chunks can
therefore leave a prefix at that destination. The failure result records only the acknowledged
`chunksWritten` and `byteLength`; it never represents that prefix as a successful JSON document.
Callers requiring destination-level atomicity must stream into an atomic temporary destination and
publish it only after `{ ok: true }`. Once the final write is acknowledged, success is the
linearization point; cancellation after that point does not retroactively fail the document.

The formatter is deterministic, offline, model-free, filesystem-free, and process-state-free. It
does not execute repository commands and performs no network operation.
