# Tracked-file enumeration

`@agent-context/evidence` exposes C03 through `enumerateTrackedFiles(repository, options)`. The
caller supplies an already root-jailed C02 `ReadOnlyRepository`; C03 has no ambient filesystem,
process, environment, network, Git-command, or object-database capability.

```ts
const result = await enumerateTrackedFiles(repository);

result.paths; // sorted canonical repository-relative identities
result.source; // "git-index" or "filesystem-fallback"
result.certainty; // "tracked" or "all-files-not-tracked"
result.reason; // exact fast-path or fallback decision
result.omittedProblems; // count not retained after maximumProblems
```

## Fast path

The fast path is available only when `.git` is an ordinary, non-link directory inside the selected
root and `.git/index` is a C02-readable regular single-link file. C03 validates the complete index
before returning a path:

- `DIRC` header, version 2, 3, or 4, and bounded entry count;
- SHA-1 or SHA-256 object/checksum width, detected only when exactly one complete checksum-valid
  parse succeeds;
- network-order fields, documented file/symlink/gitlink modes, flags, stages, name lengths, v2/v3
  padding, and v4 prefix compression;
- fatal UTF-8 decoding into canonical POSIX repository-relative paths, with `.git`, traversal, empty
  components, backslashes, trailing separators, control/bidi text, paths beyond 16,384 UTF-8 bytes
  or configured depth, case collisions, path-prefix collisions, duplicate stages, and incorrect byte
  ordering rejected;
- bounded extension headers and payload lengths. Optional uppercase extensions are skipped only
  after structural validation. Required unknown extensions, split-index `link`, sparse-index `sdir`,
  sparse directory entries, and invalid extended flags reject the fast path.

C03 never reads an object ID target, object database, config, shared index, hook, attribute, ignore
file, or external gitdir. Merge-stage paths are deduplicated into one logical tracked identity.

## Fallback and provenance

A missing Git directory/index, malformed or unsupported index, unsafe Git metadata, linked-worktree
gitfile, external gitdir, or C02 index-size refusal selects deterministic filesystem fallback. The
fallback recursively uses only `readDirectory` and `inspect`, never enters a `.git` directory at any
depth, never follows a directory link, records a bounded list of skipped unsafe entries, and returns
sorted canonical file paths.

Fallback paths are **not known to be tracked**. The result therefore sets
`certainty: "all-files-not-tracked"` and records a reason such as `git-index-malformed`,
`git-index-unsupported`, or `git-worktree-external-metadata`. Consumers must preserve this label and
must not present fallback paths as Git-tracked. C04 applies ignore behavior later; C03 fallback does
not interpret `.gitignore` or silently remove untracked files.

C02 cancellation, deadlines, concurrent-use failures, root/path races, and aggregate resource-limit
failures propagate instead of being downgraded to uncertainty. Individual unavailable, externally
linked, hard-linked, directory-linked, or special fallback entries are skipped with bounded
`problems` provenance; safe in-root file links remain candidates. Repeated directory identities are
also reported before traversal is stopped. When the list reaches `maximumProblems`,
`omittedProblems` counts every additional problem so truncation is explicit.

## Limits

| Limit                 |    Default | Hard maximum |
| --------------------- | ---------: | -----------: |
| `maximumDepth`        |        128 |        1,024 |
| `maximumDirectories`  |    100,000 |    1,000,000 |
| `maximumFiles`        |    100,000 |    1,000,000 |
| `maximumIndexBytes`   | 16,777,216 |   16,777,216 |
| `maximumIndexEntries` |  1,000,000 |    1,000,000 |
| `maximumProblems`     |        256 |        4,096 |

Options may lower but not raise these ceilings. They must be a plain data object; proxies,
accessors, unknown fields, non-integers, and explicit invalid values fail before enumeration.
Returned results, paths, limits, and problem records are immutable.
