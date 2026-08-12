# Package boundaries

The workspace separates public contracts from parsing, resolution, rules, and presentation. These
directories are implementation boundaries even when several packages are eventually bundled into one
public artifact.

## Public packages

- `@agent-context/lint` is the installable CLI and eventual high-level library facade.
- `@agent-context/core` contains stable contracts and dependency-free composition primitives.

The npm names remain provisional until registry ownership is verified. Every other workspace package
is marked `private: true` and is not a supported consumer entry point.

## Dependency layers

```text
@agent-context/lint
  -> evidence / formatters / profiles / resolver / rules / standards
  -> core

formatters -> rules / efficiency / standards -> resolver / evidence / profiles
rules      -> evidence / efficiency / resolver / standards
efficiency -> evidence / resolver
resolver   -> profiles / syntax (E01 activation algebra currently imports only core contracts)
standards  -> profiles
profiles   -> syntax
syntax     -> markdown
markdown   -> core
evidence   -> core
test-kit   -> no production package
core       -> no workspace package
```

The efficiency package consumes the evidence package's inert statement classifier and duplication
index to calculate G05 measurements. That edge is one-way: evidence does not import efficiency, and
metrics receive no filesystem or command-execution capability through it. G06 score specifications
remain in the same package and consume only the core B06 configuration contract plus inert G05
values; core does not import the private efficiency package.

`test-kit` implements core service contracts structurally and does not import `core`. Production
packages may use `test-kit` only as a development dependency; runtime edges to test helpers remain
forbidden.

The diagram shows permitted direction, not a requirement to depend on every package in the next
layer. The exact allow-list lives in `scripts/check-package-boundaries.mjs` and is executable
policy.

## Enforced rules

`pnpm boundaries` fails when:

- a package adds an internal dependency outside its allow-list;
- an internal dependency does not use the `workspace:` protocol;
- a TypeScript project reference and its manifest dependency disagree;
- source imports another workspace package without declaring it;
- a relative source import escapes its package directory;
- the workspace graph contains a cycle;
- a public runtime package depends on a private package; or
- a package changes its expected name or publication visibility.

The boundary test suite validates the real workspace and constructs rejected graphs so a broken
checker cannot make forbidden directions pass silently.

## Adding or moving an edge

First confirm that the edge follows the architecture in
[ADR-0003](../architecture/decisions/0003-esm-packaging-and-public-api.md). Update the package
manifest with `workspace:*`, add the matching `tsconfig.json` reference, update the executable
allow-list if the architecture truly permits the edge, and run:

```sh
pnpm test:boundaries
pnpm build
```

Changing a public boundary or reversing an accepted dependency direction requires an ADR rather than
a checker exception.
