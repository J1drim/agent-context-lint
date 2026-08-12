# Repository-relative path contract

`@agent-context/core` represents every repository entry as a branded `RepositoryRelativePath`. The
contract is host-independent: it never reads the process working directory, the current drive,
environment variables, locale, filesystem, or global path settings.

## Canonical form

| Concern          | Contract                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository root  | `.` is the only canonical root value. Empty input and sequences of `.` segments canonicalize to `.`.                                                                                                                           |
| Separator        | `/` is the only canonical separator. Repeated and trailing input separators are removed.                                                                                                                                       |
| Parent traversal | A `..` segment is rejected; it is never collapsed.                                                                                                                                                                             |
| Absolute input   | POSIX absolute, Windows rooted, drive-qualified, UNC, and device namespace input is rejected by the relative-path constructor.                                                                                                 |
| Windows input    | Select `win32` explicitly to accept `\` as an input separator. Drive-relative forms such as `C:src` are rejected because they depend on process state. Device forms such as `\\?\C:\repo` and `\\.\pipe\name` are unsupported. |
| POSIX input      | Select `posix` (the default). A backslash is rejected instead of treating it as a filename character, because that name cannot round-trip portably to Windows.                                                                 |
| Unicode          | Valid Unicode code points are preserved code-unit-for-code-unit. The API performs no NFC, NFD, NFKC, or NFKD normalization. Unpaired UTF-16 surrogates are rejected.                                                           |
| Case             | Case is preserved and logical comparison is case-sensitive, using JavaScript string code-unit order without locale or filesystem folding.                                                                                      |
| Characters       | C0 controls (`U+0000`–`U+001F`) and `U+007F` are rejected. This includes NUL, tabs, and line breaks.                                                                                                                           |

Unicode validation covers every code-unit position, including segment and string boundaries. It is
applied by relative canonicalization, absolute root/target conversion, the canonical-path predicate,
and forged-brand revalidation before an absolute join.

For example:

```ts
import {
  canonicalizeRepositoryRelativePath,
  repositoryRelativePathFromAbsolute,
  repositoryRelativePathToAbsolute,
} from "@agent-context/core";

const entry = canonicalizeRepositoryRelativePath("./src//rules/index.ts");
// "src/rules/index.ts"

repositoryRelativePathToAbsolute("/checkout/project", entry, "posix");
// "/checkout/project/src/rules/index.ts"

repositoryRelativePathFromAbsolute(
  "C:\\checkout\\project",
  "C:\\checkout\\project\\src\\rules\\index.ts",
  "win32",
);
// "src/rules/index.ts"
```

`canonicalizeRepositoryRelativePath(input, sourceFlavor?)` is the only constructor for untrusted
logical input. `isRepositoryRelativePath` recognizes strings that are already canonical; it does not
normalize them. The brand prevents accidental mixing with arbitrary strings at TypeScript API
boundaries, while runtime validation protects boundaries receiving JavaScript or forged values.

## Absolute conversion

Both absolute conversion functions require an explicit `posix` or `win32` grammar and an explicit,
fully qualified root. They do not fall back to `process.cwd()`.

- POSIX roots must start with `/`.
- Windows roots must be drive-qualified (`C:\repo`) or valid UNC roots (`\\server\share\repo`). A
  single-leading-separator path and a drive-relative path are not fully qualified.
- `repositoryRelativePathFromAbsolute` normalizes absolute `.` and `..` segments, computes a lexical
  relative path, and rejects targets outside the root.
- `repositoryRelativePathToAbsolute` revalidates the branded value before joining it beneath the
  normalized root.
- Round trips preserve the canonical logical value. Host filesystem case behavior is deliberately
  not imported into logical equality; Windows absolute containment follows Node's `path.win32`
  semantics, while returned logical segment spelling comes from the target.

`compareRepositoryRelativePaths` returns `-1`, `0`, or `1` in case-sensitive JavaScript string
order. `repositoryRelativePathsEqual` uses exact identity. Thus composed `café` and decomposed
`cafe\u0301`, as well as `A` and `a`, remain distinct. Callers that ingest filesystems with
different normalization or case behavior must detect collisions explicitly rather than silently
merge names.

## Errors

Failures throw `RepositoryPathError`. Its stable `code` supports exhaustive handling; `input`
identifies the rejected value and `root` is present when containment context is relevant.

| Code                                      | Meaning                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `REPOSITORY_PATH_CONTROL_CHARACTER`       | Input contains a C0 or DEL control character.                        |
| `REPOSITORY_PATH_MALFORMED_UNICODE`       | Input contains an unpaired UTF-16 surrogate.                         |
| `REPOSITORY_PATH_NON_CANONICAL`           | A value carrying the compile-time brand is not canonical at runtime. |
| `REPOSITORY_PATH_NOT_RELATIVE`            | Relative input is absolute or rooted.                                |
| `REPOSITORY_PATH_OUTSIDE_REPOSITORY`      | An absolute target is lexically outside its root.                    |
| `REPOSITORY_PATH_PARENT_TRAVERSAL`        | Relative input contains a `..` segment.                              |
| `REPOSITORY_PATH_ROOT_NOT_ABSOLUTE`       | The supplied root is not fully qualified.                            |
| `REPOSITORY_PATH_TARGET_NOT_ABSOLUTE`     | The supplied target is not fully qualified.                          |
| `REPOSITORY_PATH_UNSUPPORTED_DEVICE_PATH` | A Windows device namespace path was supplied.                        |
| `REPOSITORY_PATH_WINDOWS_DRIVE_RELATIVE`  | A drive-relative form such as `C:src` was supplied.                  |
| `REPOSITORY_PATH_WINDOWS_SEPARATOR`       | POSIX logical input contains a backslash.                            |

## Filesystem security boundary

This contract is lexical. It does not call `realpath`, inspect symlinks or junctions, open files,
defend against time-of-check/time-of-use races, or prove that a path stays inside a root after
filesystem resolution. Never use lexical containment alone as authorization to access an untrusted
checkout.

C02's read-only filesystem jail must enforce the root at each filesystem operation, reject unsafe
link traversal, and return typed access failures. Keep the branded logical path as the transport
format, then apply the jail immediately before filesystem access. Archive extraction and other write
paths require their own containment and link policies.

## Standards references

The contract follows these primary references, retrieved 2026-08-01:

- [Node.js `path` API](https://nodejs.org/api/path.html), including the explicit `path.posix` and
  `path.win32` implementations
- [Microsoft: File path formats on Windows](https://learn.microsoft.com/en-us/dotnet/standard/io/file-path-formats),
  including drive-relative, UNC, and device path behavior
- [Unicode Standard Annex #15: Unicode Normalization Forms](https://unicode.org/reports/tr15/),
  which explains why normalization can change representation and why compatibility normalization can
  erase distinctions
