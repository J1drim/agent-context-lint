# Configuration discovery and precedence

B07 resolves configuration through `resolveAgentContextConfiguration(repositoryRoot, options)` in
the private `@agent-context/syntax` package. The resolver is the single integration boundary between
the filesystem-free B06 parser/contracts and later repository-root and CLI work. I01 will map
command arguments into the sparse `cliOverrides` value; it must not duplicate this merge logic.

## Authority model

Authority is deterministic and field-aware:

1. CLI overrides;
2. the repository-root `.agent-context-lint.yml` file;
3. B06 built-in defaults.

Nested plain objects merge recursively. Arrays and all non-object values replace lower-authority
values. In particular, `ignore` is replaced rather than concatenated, and a profile boolean replaces
the lower profile object. The resolver converts the normalized repository value back to the B06
decoded shape before overlaying CLI values, then validates and freezes the complete result through
`validateAgentContextConfiguration`. This preserves repository values for CLI fields that were not
specified and prevents divergent CLI validation rules.

There is intentionally no v1 user-global configuration. C01 selects a canonical root once, with an
explicit authority reason, and the caller passes that exact `selection.root` to this resolver. The
resolver does not inspect a parent directory, current working directory, home directory, environment
variable, XDG location, Git configuration, or platform preference directory. It reads only the named
root and the exact child `.agent-context-lint.yml`. A caller that selects the wrong repository root
receives the configuration for that explicit root; C01 owns repository-root selection and never
delegates that authority decision to configuration.

## Failure and provenance contract

A missing repository file is not an error. Every other unusable layer fails closed: malformed YAML,
unknown fields, invalid CLI values, unsafe runtime objects, malformed UTF-8, resource-limit
breaches, links, non-regular files, read failures, and observed replacement during a read all reject
the complete resolution. The resolver never falls back after finding an invalid higher-authority
source.

Successful results include ordered `sources` entries for defaults and each participating repository
or CLI layer. Failures identify the `repository` or `cli` source. Repository parsing issues preserve
the B06 half-open source range and repository-relative configuration path; filesystem issues
identify the exact configuration path but have no invented text range. Results, source lists,
issues, and valid configuration values are frozen.

Successful results are also registered as same-process authority and privately retain the canonical
root device/inode identity observed independently by B07. Security-sensitive consumers call
`isIssuedConfigurationResolutionSuccess` and compare that private identity with an issued C01
selection. A clone, proxy, cast, deserialized lookalike, or result from another repository is not
authoritative for the selected scan and must be resolved again.

## Hostile-input and filesystem controls

CLI values are treated as untrusted runtime input. Before merging, the resolver snapshots them
without reading accessors or invoking callbacks. It rejects proxies, accessors, symbols, exotic
prototypes, sparse arrays, cycles, malformed Unicode, non-finite numbers, negative zero, excessive
nesting, and the B06 aggregate JSON limits. The `version` field belongs to the repository schema and
is not a CLI override.

Repository reads are bounded to one byte beyond the 65,536-byte source limit. The file must be a
regular non-symlink entry before opening. On POSIX the open also requests `O_NOFOLLOW`; Node
documents that this flag makes opening a symlink fail, while its Windows flag list does not include
`O_NOFOLLOW`. The portable protection therefore does not depend on that flag: the resolver compares
device, inode, size, nanosecond modification time, and nanosecond change time across pre-open,
open-handle, post-read, and final path observations. A mismatch rejects the read. UTF-8 decoding is
fatal, and the file handle is closed on every path.

The repository root has a separate identity invariant. Before invoking any path or filesystem API,
the resolver rejects malformed Unicode and NUL bytes so host encoding replacement cannot turn an
invalid input into an alias of a different directory. It requires an absolute path, removes terminal
host separators without changing a filesystem-root path, and uses that exact selected path for the
leaf `lstat`, canonicalization, and final identity check. Removing terminal separators first is
security-significant because POSIX `lstat("link/")` can dereference a directory symlink rather than
inspect the selected link entry.

The resolver records the selected root's bigint device and inode before resolving the real path,
identity-compares the resolved directory to that initial root, and rechecks the selected path,
canonical path, directory type, and identity after every absent-file, successful-read, or
failed-read outcome. A leaf link is rejected even when the caller supplies trailing separators, and
a root substitution fails with `repository-root-changed` instead of accepting configuration from the
replacement.

This is deliberately a narrow B07 read boundary. C02 owns the reusable repository filesystem facade
and its broader traversal, link-loop, special-file, aggregate-count, deadline, and cancellation
controls. B07 does not execute repository commands, inspect Git metadata, write files, or use the
network.

## Primary platform reference

- Node.js `fs` documentation, “File system flags” and `FileHandle.stat`, Node.js v25.9.0, retrieved
  2026-08-02: <https://nodejs.org/download/release/v25.9.0/docs/api/fs.html>

Observed-versus-documented note: the implementation uses `O_NOFOLLOW` only outside Windows because
the documented Windows-supported flag list omits it. Cross-platform identity checks remain the
required protection on every platform.

## Verification expectations

Unit tests cover the full missing/repository/CLI conflict matrix, replacement semantics, source
locations, deterministic repeated results, malformed and over-limit inputs, and callback-free
rejection of hostile JavaScript values. Integration tests prove exact-root-only discovery and reject
relative, missing, file, malformed-Unicode alias, and leaf-symlink roots, including symlink roots
with terminal host separators. Symlink, directory, malformed UTF-8, and oversized configuration
fixtures exercise actual filesystem behavior. Injected deterministic root-substitution tests cover
the initial realpath identity comparison and the final absent/read checks. Until I01 exposes
user-visible CLI configuration flags, there is no packaged CLI path for B07 to test.
