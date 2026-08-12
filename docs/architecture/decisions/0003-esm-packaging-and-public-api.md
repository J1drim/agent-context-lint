# ADR-0003: ESM packaging and public API

- Status: Accepted
- Date: 2026-08-01
- Ticket: A01
- Decision owners: Maintainers

## Context

The command-line product also needs stable programmatic seams for CI integrations,
a future language server, and hosted products. Publishing every workspace package
would turn implementation boundaries into permanent compatibility commitments.
Dual ESM/CommonJS output would double packaging and interop states without helping
the Node.js 24+ runtime contract.

Node.js treats `.js` as ESM when the nearest package manifest declares
`"type": "module"`. It recommends the `exports` field for new packages because it
defines and encapsulates public entry points. TypeScript recommends a Node-aware
module mode for code that executes in Node.js; `NodeNext` models Node's ESM and
package-exports behavior rather than a bundler's behavior.

## Decision

### Module format and compilation

All production packages and executables are ESM-only.

- Every package manifest declares `"type": "module"`.
- TypeScript uses `"module": "NodeNext"` and
  `"moduleResolution": "NodeNext"` with an explicit, non-floating
  `"target": "ES2023"` and `"lib": ["ES2023"]`.
- Source relative imports include the emitted `.js` extension. Package-to-package
  imports use package names and declared exports, never source-relative paths that
  cross a workspace boundary.
- Build output contains `.js`, `.d.ts`, and source maps. Published manifests expose
  types through `types` and through the `types` condition where appropriate.
- No `require` condition, `.cjs` production build, or CommonJS compatibility
  wrapper is shipped in v1.
- The CLI executable is an ESM entry point with a portable Node.js shebang. Its
  packed tarball and executable bit are verified by release tests.
- Runtime code executes directly in Node.js; it is not bundled for v1. Tests must
  consume built package exports, not reach into another package's `src` tree.

Compiler options that affect soundness or output are written explicitly even when
TypeScript currently defaults to them. Strict mode, declaration emit, source maps,
exact optional properties, unchecked indexed access, consistent casing, isolated
module syntax, and no unchecked side-effect imports are foundation requirements
for A02; compiler defaults are not an implicit contract.

### Public package boundary

There are two logical public packages:

| Logical package | Public responsibility |
|---|---|
| `@agent-context/lint` | Installable product, `agent-context-lint` binary, and high-level async programmatic facade for `scan`, `list`, and `explain` workflows |
| `@agent-context/core` | Stable versioned contracts, domain types, diagnostics, configuration/result types, and pure composition primitives needed by integrations |

The npm scope and names are provisional until maintainers verify registry ownership.
No registry reservation or publication is part of A01. If the scope is unavailable,
the publication names may change before the first public release without changing
these logical package roles; after publication, a name change requires release notes
and migration guidance.

All other planned workspace packages (`markdown`, `syntax`, `profiles`, `resolver`,
`evidence`, `rules`, `standards`, `efficiency`, `formatters`, and
`test-kit`) are implementation boundaries. They are private or bundled into the
two public artifacts and carry no public compatibility promise in v1. They may not
be imported by consumers through filesystem paths.

### Export and API rules

- `package.json#exports` is the complete public boundary. Unlisted deep imports
  are unsupported and blocked. Export maps enumerate entry points; they do not use
  broad wildcard exports over implementation directories.
- Each JavaScript export has a matching type declaration and source map. The
  package manifest itself is not exported unless a documented consumer requirement
  is accepted.
- The root `@agent-context/lint` export exposes a small options-in/results-out
  facade. It does not expose CLI argument-parser or terminal-renderer objects.
- Library operations are asynchronous, accept an `AbortSignal`, and accept
  explicit filesystem, clock, randomness, and network capabilities where those
  capabilities are relevant. Importing a package has no I/O, environment
  mutation, telemetry, signal-handler registration, or process exit side effect.
- The library never calls `process.exit`. The CLI maps typed results and errors to
  output and exit codes at its outer boundary.
- Public inputs and results are serializable data contracts. Schema and model
  types defined by Stream B are re-exported from documented entry points rather
  than duplicated.
- Public APIs use repository-relative logical paths, not host-specific path
  strings, once Stream B defines that branded contract.
- Built-in syntax adapters and client profiles are selected through identifiers
  and options. Arbitrary executable third-party plug-ins are not a v1 public API;
  the separate disabled semantic plug-in boundary remains ticket F17.
- Only symbols documented in the generated API reference and reachable through an
  export map are public. TypeScript declaration visibility alone does not make a
  symbol public.

The exact function and schema shapes are deliberately assigned to Stream B and
the language-server boundary ticket. This ADR fixes the direction and package
boundary without pre-implementing those contracts.

### Compatibility

The stable `1.0.0` release establishes the semantic-versioning contract for exported
runtime symbols, documented types, CLI behavior, and machine schemas. The compatibility
policy defined by B05/B10 governs subsequent releases.

Removing or changing an export, narrowing an accepted input, broadening a result
in a way that breaks exhaustive consumers, changing an error/diagnostic contract,
or adding CommonJS with different behavior requires explicit compatibility
review. Adding an implementation package does not change the public API.

Both public packages are versioned together through v1 so that their contracts
cannot drift. Independent versioning may be proposed later with an ADR and a
tested compatibility matrix.

## Consequences

- Node.js 24+ consumers use native ESM imports; CommonJS consumers must use dynamic
  `import()` or invoke the CLI.
- One module graph avoids dual-package hazards and halves the package test states.
- Explicit export maps prevent accidental reliance on implementation files.
- Internal packages can evolve while the high-level facade and core contracts
  remain stable.
- A02 must enforce dependency direction independently from what is publicly
  exported.

## Rejected alternatives

### Dual ESM and CommonJS publication

Rejected because the minimum runtime has mature ESM support and dual publication
adds conditional-export, declaration, state-duplication, and test complexity. No
v1 requirement needs synchronous CommonJS `require`.

### CommonJS-only output

Rejected because it makes the new package target a legacy module format and works
against the ESM direction of Node.js, TypeScript, and pnpm 11.

### Bundler module resolution

Rejected because the product runs in Node.js without a runtime bundler. Bundler
resolution accepts import forms that native Node.js ESM rejects and would let
type-checking diverge from execution.

### Publishing every workspace package as public

Rejected because repository decomposition exists to control dependencies, not to
create a dozen v1 semver commitments. The high-level facade and core contracts are
sufficient extension seams.

### One CLI-only package with no library API

Rejected because the product plan requires future IDE, hosted, and integration
surfaces. Forcing those consumers to spawn and parse a CLI would weaken
cancellation, typed errors, performance, and compatibility.

### A single compiled executable as the only artifact

Rejected because clean npm installation and a reusable public API are v1 release
requirements. A signed single-binary distribution can be added later without
changing the logical API.

## Primary sources

Retrieved 2026-08-01:

- [Node.js package and module documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/packages.html)
- [TypeScript module theory](https://www.typescriptlang.org/docs/handbook/modules/theory.html)
- [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#node16-node18-node20-nodenext)
- [TypeScript 7.0 release announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
