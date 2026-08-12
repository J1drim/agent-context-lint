# Optional exact tokenizer providers

Status: accepted implementation contract for G10

Provider ABI: `agent-context-tokenizer-wasm-v1`

## Delivery and selection

Optional exact tokenizers are separately installed data packages. They are outside the pnpm
workspace and absent from every default dependency, optional dependency, peer dependency, build,
and packed linter artifact. npm's documented optional-peer mechanism informed the packaging choice,
but the linter uses an even stricter explicit-install model: it declares no dependency edge at all.

The engine owns a closed provider registry. Repository files, configuration objects, organization
packs, and API callers may select a registered identifier but cannot provide package names, paths,
digests, manifests, imports, commands, callbacks, or code. Adding a provider requires a reviewed
engine commit that pins all of those facts.

The initial reference package is `@agent-context/tokenizer-utf8-byte`, selected as
`optional:utf8-byte`. Its `utf8.byte@1.0.0` algorithm defines every UTF-8 byte as one token. It is an
exact conformance oracle, not a model tokenizer. Future model-specific packages must pin generated
vocabulary/merge-table provenance and exact conformance fixtures before entering the registry.

## Data-only package

A package contains exactly:

- a closed JSON manifest with contract, provider, identity, ABI, encoding, and artifact digest;
- one canonical base64 WebAssembly artifact;
- package metadata and documentation.

It contains no JavaScript, native add-on, install script, executable, network locator, or dynamic
module reference. The host resolves only two hardcoded package exports relative to its own installed
module, rejects links/special files and oversized or unstable reads, verifies the exact manifest
digest, canonical base64, decoded artifact SHA-256, registry identity, and ABI before execution, and
never reflects package-controlled errors.

A known provider package whose artifact export is a symbolic link is deterministically `invalid`,
not `unavailable`, on every supported OS. Absence and non-file resolution remain unavailable; a
resolved but forbidden file shape is admitted far enough to produce the stronger invalid result and
is never opened through the link.

Package absence is normal. Missing, corrupt, incompatible, timed-out, or failed providers produce an
immutable labeled G02 estimate plus stable fallback code and requested/resolved provider provenance.
Invalid caller input/options and cancellation remain failures rather than being hidden by fallback.

## Capability boundary

The reviewed host starts one Node Worker for one count. Package resolution, bounded reads, digest
verification, WebAssembly compilation, and counting all occur inside that worker under one
end-to-end deadline. The Worker starts with empty `argv`, `execArgv`, and environment, bounded V8
heap/code/stack settings, redirected standard streams, and a parent deadline/cancellation path. The
parent returns timeout or cancellation only after termination is confirmed. If termination cannot
be confirmed within the independent one-second stop grace, a process-local circuit breaker rejects
all later exact execution and requests fall back. Node documents that Worker resource limits do not
constrain external `ArrayBuffer` memory, so the host independently bounds the artifact, input, and
imported linear memory.

Provider WebAssembly must:

- import exactly `env.memory` and nothing else;
- export exactly `count(offset, byteLength)` and nothing else;
- fit the host-created memory capped at 257 64-KiB pages;
- return a non-negative safe integer before the deadline.

It receives no WASI or JavaScript function import. Consequently provider code has no filesystem,
process, environment, credential, clock, random, socket, DNS, HTTP, worker, or native-addon
capability. The Worker JavaScript is release-owned host code; provider JavaScript is never loaded.
Parent-enforced `Worker.terminate()` handles loops, and malformed imports/exports/results fail closed.

Primary implementation references:

- [Node.js Worker threads](https://nodejs.org/download/release/latest-v24.x/docs/api/worker_threads.html)
- [JavaScript WebAssembly API](https://developer.mozilla.org/docs/WebAssembly/JavaScript_interface)
- [npm optional peer dependencies](https://docs.npmjs.com/cli/configuring-npm/package-json/#peerdependenciesmeta)

## Versioning and release evidence

Changing the ABI, import set, memory ceiling, manifest shape, digest, tokenizer algorithm, vocabulary,
normalizer, pre-tokenizer, merge table, or special-token behavior requires a new reviewed identity or
contract version. The G01 compatibility check forbids cross-version comparison.

Every provider release needs package-inventory, digest, exact-count, Unicode, malformed-input,
missing-package, corruption, forbidden-import/export, malformed-result, non-settling, timeout,
cancellation, no-default-dependency, and fallback tests. Model-specific packages additionally need
official upstream vectors and a documented reproducible artifact generator.
