# Workspace and source-boundary discovery

Ticket C11 exposes deterministic, read-only boundary evidence from '@agent-context/evidence'. Call
'discoverWorkspaceBoundaries(repository, discoveryIndex, options)' with the C02 repository
capability and C05 targeted discovery index.

The function reads only candidates recognized by the closed built-in evidence catalog. Dynamic
matcher facts, instruction/configuration candidates, and a built-in recognizer attached to the wrong
basename cannot authorize a read.

## Result contract

'WorkspaceBoundaryDiscoveryResult' is recursively immutable and has contract version '0.1.0'.
Evidence and boundaries use case-sensitive, locale-independent ordering. Each evidence record
provides:

- its canonical repository path and containing root;
- recognizer, family, parser kind, and detected languages;
- exact UTF-8 byte and UTF-16 source coordinates;
- optional project name and package-manager declaration;
- source-located include/exclude patterns, retained as data and never glob-expanded;
- executable-capable fields that were deliberately ignored;
- a 'complete', 'malformed', 'unsupported', or 'unavailable' state with located issues.

The result preserves C05 uncertainty and adds one reason for every non-complete record. Missing
files, safe-read failures, invalid UTF-8, duplicate JSON keys, unsupported syntax, and unsafe member
paths cannot silently become known boundaries.

## Supported evidence

| Evidence                 | Inert interpretation                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| package.json             | strict JSON name, packageManager, and workspaces array / workspaces.packages; scripts ignored |
| pnpm-workspace.yaml      | bounded root packages sequence; leading ! becomes an exclusion                                |
| Cargo.toml               | bounded TOML package.name and workspace members / exclude string arrays                       |
| pyproject.toml           | bounded TOML project.name and uv workspace members / exclude                                  |
| setup.cfg                | bounded INI metadata.name                                                                     |
| setup.py                 | Python project marker only; executable Python is never parsed                                 |
| go.mod                   | module directive                                                                              |
| go.work                  | single and block use directives, limited to repository-relative paths                         |
| lerna.json               | strict JSON packages and npmClient; command configuration ignored                             |
| rush.json                | strict JSON projects[].projectFolder; event hooks ignored                                     |
| nx.json, turbo.json      | strict JSON workspace markers; plugins, targets, pipelines, and tasks ignored                 |
| WORKSPACE*, MODULE.bazel | Bazel workspace markers; Starlark is never evaluated                                          |
| BUILD, BUILD.bazel       | path-derived Bazel package/source boundary; Starlark is never evaluated                       |

JSONC comments and trailing commas are malformed strict JSON. TOML and YAML readers implement only
the closed scalar/array shapes above; they instantiate no tags, aliases, plugins, or callbacks.
Member patterns must be non-empty, bounded, repository-relative POSIX text without parent traversal.
Absolute Go paths are valid in Go's grammar but remain unsupported uncertainty here because they
cannot safely establish an in-repository boundary.

## Resources and errors

'WorkspaceBoundaryError' has stable codes for invalid input/options, cancellation, deadlines, and
resource exhaustion. Production uses a monotonic clock; 'discoverWorkspaceBoundariesWithClock' is
the trusted deterministic-test form.

| Resource                   |    Default | Hard maximum |
| -------------------------- | ---------: | -----------: |
| Inspected C05 candidates   |    100,000 |    1,000,000 |
| Evidence manifests         |     10,000 |      100,000 |
| Recognitions per candidate |         32 |          256 |
| Bytes per manifest         |      1 MiB |       16 MiB |
| Total bytes                |     64 MiB |      512 MiB |
| Lines                      |    100,000 |    1,000,000 |
| UTF-16 units per line      |     65,536 |    1,048,576 |
| Structure depth            |         64 |          256 |
| JSON nodes                 |    100,000 |    1,000,000 |
| Member patterns            |     10,000 |      100,000 |
| UTF-16 units per pattern   |      4,096 |       16,384 |
| Retained issues            |      1,000 |      100,000 |
| Duration                   | 30 seconds |  300 seconds |

Limits may only be raised to their hard ceilings. C02 independently enforces its root jail,
symlink/type policy, identity revalidation, byte budgets, and deadlines.

## Specification boundary

Supported shapes were reviewed on 2026-08-02 against current first-party documentation:

- [npm workspaces](https://docs.npmjs.com/misc/workspaces/)
- [pnpm workspaces](https://pnpm.io/workspaces)
- [Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html)
- [Go module and workspace files](https://go.dev/ref/mod)
- [Python pyproject.toml specification](https://packaging.python.org/en/latest/specifications/pyproject-toml/)
- [uv workspaces](https://docs.astral.sh/uv/concepts/projects/workspaces/)
- [Bazel workspaces and packages](https://bazel.build/concepts/build-ref)
- [Nx nx.json](https://nx.dev/docs/reference/nx-json)
- [Turborepo configuration](https://turborepo.com/docs/reference/configuration)
- [Lerna configuration](https://lerna.js.org/docs/api-reference/configuration)
- [Rush rush.json](https://rushjs.io/pages/configs/rush_json/)

These sources describe their tools, not universal repository semantics. C11 emits evidence and
explicit uncertainty; it never invokes those tools to reproduce version-dependent discovery.
