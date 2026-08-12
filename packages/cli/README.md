# `@agent-context/lint`

Agent Context Linter's public ESM package provides the `agent-context-lint` executable and the
embedded `scanAgentContext` API for Node.js 24+. The library import is side-effect-free: it performs
no I/O, installs no global handlers, and never exits or changes exit state.

Embedded hosts inject a trusted capability minted with `createLibraryScanCapability`, pass a native
`AbortSignal`, and may observe bounded deterministic progress. Successful scans return the canonical
`ScanJsonOutput`; operational failures reject with a sanitized `LibraryApiError`.

See the [library API reference](../../docs/api/library-api.md),
[embedding guide](../../docs/user/library-api.md), and
[security boundary](../../docs/security/library-api.md).

The internal G09 `efficiency` handler consumes only an injected genuine analysis source; I02/F15 own
repository scanning and scheduling. It supports stable terminal/JSON output and compatible
comparison mode without turning scores into exit policy. See the
[efficiency report guide](../../docs/user/context-efficiency-reports.md).

The packaged CLI provides a complete deterministic `scan` command with stylish, JSON, and SARIF
output; rule, severity, failure-threshold, profile, and surface selection; suppressions; import and
activation-aware context accounting; and read-only approved-fix previews. Normal scans are offline,
model-free, read-only, and do not execute Git or any repository command. See the
[scan guide](../../docs/user/scanning.md) and [command contract](../../docs/api/command-line.md).

The published scan runtime is a closed audited Node 24 ESM bundle. Private implementation engines
and third-party JavaScript are embedded; `@agent-context/core` is the only package dependency.
External source maps, the esbuild metafile, third-party license texts, and the exact signed
standards trust tree ship with the package for inspection.
