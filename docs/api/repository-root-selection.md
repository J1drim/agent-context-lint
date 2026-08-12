# Repository-root selection

`@agent-context/evidence` exposes the internal C01 root-selection boundary used before
configuration, discovery, or parsing. Callers always provide an absolute start directory; the
selector never reads the process working directory, home directory, environment-selected Git
directory, user/global Git configuration, or user-global linter configuration.

```ts
import { selectRepositoryRoot } from "@agent-context/evidence";

const selection = await selectRepositoryRoot("/checkout/project/packages/api", {
  mode: "discover",
  ceiling: "/checkout/project",
  signal,
});

selection.root; // canonical absolute root
selection.reason; // deterministic authority reason
```

The package is private in v1; I01 will translate CLI arguments into this contract instead of
duplicating discovery.

`selectRepositoryRootWithFileSystem` is the capability-injected internal form used by race tests and
future filesystem composition. Its `fileSystem` argument is trusted executable code: the selector
invokes its methods and consumes their typed results. Callers must never construct that capability
from repository content, configuration, or another untrusted data source. Ordinary callers use
`selectRepositoryRoot`, which supplies the fixed Node filesystem implementation.

## Authority and reasons

| Authority, highest first             | `reason`            | Selected root                                                                              |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------ |
| Caller uses `mode: "explicit"`       | `explicit-path`     | The exact directory, after safe canonicalization; no Git search occurs.                    |
| Nearest valid `.git` directory       | `git-directory`     | Its containing directory. A regular non-link `HEAD` entry is required.                     |
| Nearest valid `.git` gitfile         | `git-worktree-file` | Its containing worktree directory. Absolute and relative `gitdir: ` targets are supported. |
| No marker before the search boundary | `non-git-directory` | The exact start directory, not the ceiling or filesystem root.                             |

Nearest-marker precedence makes nested repositories deterministic. A present but malformed,
unreadable, linked, special, oversized, missing-target, or concurrently changed nearest marker is a
failure; it never broadens discovery to an outer repository. `ceiling` is inclusive. Without a
ceiling, discovery stops at the current filesystem boundary, matching Git's default decision not to
cross devices. `searchBoundary` records `ceiling`, `filesystem-device`, or `filesystem-root` for a
non-Git result.

## Path and link contract

Inputs use the current host grammar and must be fully qualified, well-formed Unicode without C0,
DEL, bidi override, or bidi isolate controls. Dot and parent-traversal segments are rejected rather
than normalized. POSIX inputs reject backslashes; Windows inputs reject drive-relative,
single-rooted, and device-namespace paths. Terminal separators are harmlessly removed without
changing filesystem-root identity. Every caller path is limited to 16,384 UTF-8 bytes before any
filesystem operation. Canonical paths returned by the operating system and generated `.git`, `HEAD`,
and gitdir paths pass through the same grammar and byte bound before inspection.

The exported `normalizeRepositorySelectionPath` helper accepts its flavor as a runtime boundary and
recognizes only the exact strings `posix` and `win32`. Other values fail as invalid options before
path parsing and are never coerced. Production selection derives that closed value from the current
Node host; the explicit parameter exists for deterministic cross-platform grammar tests.

The selected leaf may not be a symlink or junction. A stable intermediate link is allowed because
macOS system paths commonly contain aliases such as `/var`; the selector resolves it once, performs
discovery on the canonical directory chain, records every lexical and canonical identity, and
rechecks them before returning. Directory identity and type must remain stable; intermediate
directory content timestamp changes do not imply path replacement and are ignored. Link entries, the
selected root, and Git metadata receive stricter stability checks, and any replacement fails closed.
The result retains both the selected caller-chain spelling in `lexicalRoot` and canonical `root`;
filesystem consumers use `root`. Discovery above an intermediate link's target may select an
ancestor with no equivalent spelling in the caller-observed chain. In that case `lexicalRoot` falls
back to the canonical spelling instead of inventing a lexical path.

Gitfiles are fatal UTF-8, at most 4,096 bytes, contain exactly one `gitdir: <path>` record, and are
read through a non-following regular-file handle where the platform supports `O_NOFOLLOW`. A bounded
offset loop accepts ordinary short-read fragments while requiring exactly the size advertised by the
stable opened handle and a following EOF; every fragment consumes the global operation budget, and a
second handle stat must match. Early EOF, growth, zero progress before the advertised size, trailing
content, or concurrent change fails closed. To validate an actual linked worktree, C01 inspects only
the target administrative directory and its regular `HEAD` metadata; it does not read Git
configuration, refs, objects, hooks, or worktree content through that target. `gitDirectory` is
metadata provenance, not authorization to traverse outside `root`. Open, stat, read, and close
failures are exposed only as fixed-message typed errors. `causeCode` accepts only a short uppercase
platform-code grammar from an inert own data property; accessors, proxies, controls, non-strings,
and oversized values are discarded. A cleanup close failure is reported after successful processing
but never replaces a primary read, stat, or validation failure.

## Bounds, cancellation, and errors

Discovery is capped at 16,384 UTF-8 bytes per path, 128 ancestors, 256 path components, 1,024
metadata operations, and a 4,096-byte gitfile. A caller may lower the ancestor limit but cannot
raise a fixed bound. Cancellation is checked before and after every awaited filesystem operation.
Options must be a plain data object; accessors, proxies, unknown fields, invalid signals, and
out-of-range limits are rejected without invoking callbacks. The four-key allowlist is enforced
before individual descriptors are read, and proxied or revoked signal values fail as invalid options
before filesystem access. Cancellation reads the branded state through the captured intrinsic
`AbortSignal` getter, so own or subclass `aborted` accessors are bypassed and cannot run caller
code. An object without the native signal brand fails with a frozen typed options error.

Success objects, nested identity objects, reason tables, and limits are frozen. Operational failure
throws a frozen `RepositoryRootSelectionError` with a stable code, operation, optional validated
path, and sanitized platform error code. Messages do not interpolate hostile input.

| Error code                               | Meaning                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `REPOSITORY_ROOT_ABORTED`                | Cancellation was observed.                                  |
| `REPOSITORY_ROOT_GIT_MARKER_CHANGED`     | A marker or administrative target changed during selection. |
| `REPOSITORY_ROOT_GIT_MARKER_INVALID`     | The nearest marker is malformed, unsafe, or incomplete.     |
| `REPOSITORY_ROOT_GIT_MARKER_UNAVAILABLE` | A marker could not be safely opened or inspected.           |
| `REPOSITORY_ROOT_INVALID_OPTIONS`        | Options or ceiling authority are invalid.                   |
| `REPOSITORY_ROOT_INVALID_PATH`           | A path violates the host/path-text contract.                |
| `REPOSITORY_ROOT_LIMIT_EXCEEDED`         | A fixed or caller-lowered discovery bound was reached.      |
| `REPOSITORY_ROOT_PATH_CHANGED`           | Root or path-component identity changed.                    |
| `REPOSITORY_ROOT_PATH_NOT_DIRECTORY`     | A selected path component has an unsupported type.          |
| `REPOSITORY_ROOT_PATH_SYMLINK`           | The selected leaf is a link or junction.                    |
| `REPOSITORY_ROOT_PATH_UNAVAILABLE`       | A required path cannot be inspected or canonicalized.       |

C01 establishes only root authority. C02 must still jail every later repository-relative read,
reject unsafe links and special files, and enforce traversal/file/count/byte/deadline limits.
