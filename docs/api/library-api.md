# Embedded library API

Ticket E11 defines the stable asynchronous scan boundary exported from `@agent-context/lint`.
`scanAgentContext(request, capability, options)` accepts serializable request data, an opaque
same-process scan-engine capability, and optional native cancellation and progress capabilities. It
returns the canonical B05 `ScanJsonOutput` contract. It never renders terminal output or maps a
result to a process exit code.

## Request

`LibraryScanRequest` is a closed record with these exact fields:

| Field             | Contract                                       |
| ----------------- | ---------------------------------------------- |
| `contractVersion` | `1.0.0`                                        |
| `recordKind`      | `agent-context-library-scan-request`           |
| `repositoryRoot`  | canonical absolute `file:` URL, at most 16 KiB |
| `profileIds`      | non-empty, unique built-in profile identifiers |
| `targetPaths`     | unique branded repository-relative POSIX paths |
| `progressUnits`   | integer from zero through 100,000              |

The facade copies and UTF-8-sorts profiles and targets before starting the engine. Proxies,
accessors, symbols, sparse or extended arrays, duplicate entries, unknown fields, invalid URLs, and
values over hard ceilings fail without invoking caller-controlled inspection hooks.

The root URL is an identity and capability-routing input, not permission to use ambient Node
filesystem APIs. The injected engine remains responsible for using the C02 root-jailed read-only
filesystem and for composing E06 through E10. Repository/configuration/standards data must never be
allowed to select or construct executable capabilities.

## Engine capability

`createLibraryScanCapability(executor)` mints an immutable, non-serializable authority in the
current JavaScript process. Copies, structured clones, objects with matching fields, and proxies are
not authorities. The factory accepts only a direct function and keeps it in a private `WeakMap`.

The executor receives the normalized frozen request and a frozen context:

- `signal` is the facade-owned native `AbortSignal`. Engines must pass it through every E08/E09/E10
  operation and release resources before their promise settles.
- `reportProgress()` records exactly one completed deterministic work unit. The executor must call
  it exactly `request.progressUnits` times before returning.

The executor must return a genuine `Promise` for `{ output, sources }`. `output` is validated
against the B05 scan contract and B04 source relationships, sanitized through the shared output
boundary, canonicalized, parsed into detached data, and recursively frozen. The facade does not
return the engine's mutable object. Invalid output details are deliberately not exposed.

The capability factory is a composition boundary, not a general plug-in system. Application code may
mint the built-in engine during trusted startup. A configuration file, instruction file, knowledge
pack, downloaded module, or semantic plug-in may not receive the factory or provide the executor.

## Cancellation and cleanup

`options.signal` must be a genuine native `AbortSignal`. Already-aborted calls reject before the
engine starts. Mid-scan abort propagates synchronously to the derived engine signal, stops progress,
and waits for the engine promise to settle before the public promise rejects. This wait is
intentional: returning early would falsely claim cancellation while file descriptors, workers, or
timers could still be live.

The facade installs one `{ once: true }` listener and removes it in every completion path. It uses
captured `AbortSignal` and `EventTarget` intrinsics, does not read `signal.reason`, and never
reflects an abort reason. A trusted engine that ignores cancellation keeps the public operation
pending; it cannot make the facade claim cleanup that has not happened. E10's bounded deadline
remains the hard-stop mechanism for built-in resolution work.

Node recommends one-shot `AbortSignal` listeners to prevent leaks. Source checked 2026-08-03 against
[Node.js 24 `AbortSignal`](https://nodejs.org/download/release/latest-v24.x/docs/api/globals.html#class-abortsignal).

## Deterministic progress

The optional synchronous `onProgress` observer receives immutable `agent-context-library-progress`
records:

1. `started`, sequence zero, completed zero;
2. one `running` record for each completed unit, with monotonically increasing count and sequence;
3. `completed` only after output validation and canonicalization.

Events contain no timestamps, task identities, completion durations, worker indices, or scheduling
options. Two successful executions with the same request and output therefore produce identical
progress bytes even when task completion order changes. Observer promises are rejected: progress is
synchronous and bounded, so a slow observer cannot create an unbounded async queue. Throws and
returned promises cancel the derived operation and become `LIBRARY_PROGRESS_FAILED`.

## Typed errors

Failures reject with a genuine `LibraryApiError`. `isLibraryApiError` checks same-process issuance;
matching fields are not enough. Each frozen error exposes only a closed `code`, `category`, fixed
`message`, and `retryable` value:

| Code                         | Meaning                                           |
| ---------------------------- | ------------------------------------------------- |
| `LIBRARY_CANCELLED`          | native cancellation won                           |
| `LIBRARY_ENGINE_FAILED`      | trusted engine threw, rejected, or broke contract |
| `LIBRARY_INVALID_CAPABILITY` | capability was absent, forged, copied, or proxied |
| `LIBRARY_INVALID_INPUT`      | request data was malformed                        |
| `LIBRARY_INVALID_OPTIONS`    | signal or observer option was malformed           |
| `LIBRARY_INVALID_RESULT`     | progress underflow or invalid B04/B05 output      |
| `LIBRARY_PROGRESS_FAILED`    | observer threw or returned a promise              |
| `LIBRARY_RESOURCE_LIMIT`     | request/progress exceeded a hard ceiling          |

Thrown values, validation paths, repository roots/content, callback return values, and cancellation
reasons never enter those fields and are not attached as `cause`.

## Process and I/O behavior

Import and invocation install no process signal, rejection, exception, or exit handlers. The module
does not call `process.exit`, set `process.exitCode`, read environment variables, open files,
execute commands, use the network, create workers, or create timers. All scan I/O belongs to the
injected engine capability. This keeps the facade safe in test runners, servers, language servers,
and other long-lived embedded hosts.
