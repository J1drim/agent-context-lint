# Repository evidence index

Ticket F01 exposes `collectRepositoryEvidence` from the internal `@agent-context/evidence` package.
It composes three already-authorized inputs:

1. the C02 `ReadOnlyRepository` capability;
2. the C11 `WorkspaceBoundaryDiscoveryResult`; and
3. a canonical, sorted, unique path inventory that the caller has already filtered through its
   repository discovery/ignore policy.

The collector never traverses from a manifest, runs Git, starts a process, expands a glob, resolves
an environment variable, loads a module, follows a task include, or invokes a package manager. A
command, script, recipe, CI step, dependency declaration, or executable-looking string remains inert
text.

```ts
import { collectRepositoryEvidence } from "@agent-context/evidence";

const index = await collectRepositoryEvidence(repository, workspaceBoundaries, retainedPaths);
```

## Result contract

`RepositoryEvidenceIndex` is recursively immutable and uses contract version `0.1.0`. Facts are
sorted by scope, category, name, normalized value, source path, source byte offset, and raw value.
Their stable IDs are assigned only after that ordering. Repeated calls over identical inputs are
byte-identical.

Every fact has:

- a category: `manifest`, `lockfile`, `package-manager`, `script`, `task`, `path`, `runtime`, `ci`,
  or `tool`;
- canonical scope and source path plus UTF-8 byte and UTF-16 line/column range;
- a normalized `value` and the exact bounded `rawValue` used to derive it;
- `declared`, `observed-path`, or `uncertain` certainty; and
- a collector ID, inert interpretation, and source state in `provenance`.

The index does not choose a package manager or runtime. Differing values for the same normalized
subject and scope are retained as separate facts and referenced by an `EvidenceConflict`. The same
rule applies to conflicting script/task declarations. An unavailable, malformed, or deliberately
unsupported source contributes an issue and makes the aggregate index uncertain; it never becomes
negative evidence.

## Closed collectors

| Family                   | Interpretation                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C11 manifests            | Path, family, project root/name, and complete/malformed/unavailable/unsupported state                                                                                                                                                          |
| Lockfiles                | Path-only identity for npm, pnpm, Yarn, Bun, Cargo, Go, uv, Poetry, Pipenv, Bundler, and Composer                                                                                                                                              |
| `package.json`           | Strict JSON strings for package manager, scripts, engines, and a closed formatter/linter dependency catalog                                                                                                                                    |
| Make/Just                | Statically named targets/recipes only; recipes, imports, modules, `eval`, and `shell` are never expanded                                                                                                                                       |
| Cargo/Python tasks       | Closed string assignments in Cargo aliases and documented pyproject task tables                                                                                                                                                                |
| Runtime files            | Bounded scalar declarations in Node/Python/Rust toolchain files, `go.mod`, Cargo, and pyproject                                                                                                                                                |
| CI                       | Path-only GitHub Actions, GitLab CI, CircleCI, Azure Pipelines, Buildkite, Bitbucket Pipelines, and Jenkins identity; GitHub workflow/job and single-line `run`/`uses` values; YAML expressions and multiline commands are data, not execution |
| Formatter/linter configs | Closed path-only catalog plus recognized package dependencies                                                                                                                                                                                  |
| Paths                    | Every caller-approved inventory path, without reading ordinary files                                                                                                                                                                           |

F01 is evidence collection, not command understanding. F02 owns the non-expanding command lexer, and
F09 owns repository-drift conclusions. A path-only tool/config fact establishes presence only; it
does not claim the tool is usable or selected.

## Input and resource safety

Arrays must be ordinary, dense, bounded arrays. Paths must be canonical, sorted, unique repository
paths. Options and C11 records reject proxies, accessors, reversed source ranges, invalid native
abort signals, unknown keys, and forged contract versions before their data is used. File content is
decoded as fatal UTF-8 through C02. C02 independently enforces root containment, safe file type,
symlink and hard-link policy, identity revalidation, deadlines, and aggregate read budgets.

| Resource                     |    Default | Hard maximum |
| ---------------------------- | ---------: | -----------: |
| Inventory paths              |    200,000 |    1,000,000 |
| Retained facts               |    250,000 |    1,000,000 |
| Content reads                |     25,000 |      100,000 |
| Bytes per file               |      1 MiB |       16 MiB |
| Total bytes                  |     64 MiB |      512 MiB |
| Retained issues              |      4,096 |      100,000 |
| Lines                        |    250,000 |    1,000,000 |
| UTF-16 units per line/string |     65,536 |    1,048,576 |
| JSON nodes                   |    500,000 |    2,000,000 |
| JSON depth                   |         64 |          256 |
| Duration                     | 30 seconds |  300 seconds |

Limit exhaustion, cancellation, deadline expiry, and invalid API data throw a typed
`EvidenceIndexError`. Expected C02 read denial becomes a sanitized `unavailable` issue so other
evidence can remain useful; unknown capability failures are not swallowed.

## Specification boundary

The closed field shapes were reviewed on 2026-08-02 against primary documentation for
[npm package manifests](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/),
[GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[Cargo manifests](https://doc.rust-lang.org/cargo/reference/manifest.html), and the
[pyproject specification](https://packaging.python.org/en/latest/specifications/pyproject-toml/).
Those sources define producer formats, not universal repository policy. Vendor extensions or dynamic
task semantics that cannot be interpreted safely remain explicit uncertainty.
