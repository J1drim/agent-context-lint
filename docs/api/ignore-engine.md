# Ordered ignore engine

`@agent-context/evidence` exposes C04 through
`applyIgnoreRules(repository, trackedFileEnumeration, options)`. It accepts the immutable C03
enumeration boundary and uses C02 exclusively for targeted `.gitignore` reads.

```ts
const result = await applyIgnoreRules(repository, enumeration, {
  configurationPatterns: configuration.ignore,
  profileFacts,
});

result.paths; // retained canonical paths
result.ignored; // excluded path, deciding rule, and decision certainty
result.rules; // immutable pattern and source provenance
result.certainty; // exact tracked input or fallback tracking uncertainty
result.trackingCertainty; // "tracked" or "fallback-mixed-unknown"
result.profileCertainty; // known or uncertain facts explicitly deferred
```

The function never invokes Git or another repository command, reads global configuration, interprets
`$HOME`, reads `.git/info/exclude`, accesses the network, or scans arbitrary file contents. A normal
scan reads only eligible `.gitignore` files already named by C03 fallback.

## Tracked paths and fallback uncertainty

Git ignore rules only concern untracked files. For `source: "git-index"`, C04 therefore does not
read or apply `.gitignore`; checksum-verified tracked paths remain available unless a linter
built-in, explicit configuration rule, or known-active profile fact excludes them. The result is
`exact-tracked-input`.

For `source: "filesystem-fallback"`, C03 cannot identify which candidates are tracked. C04 applies
repository `.gitignore` rules but returns `fallback-tracking-uncertain`. Every path removed by a
`.gitignore` rule has decision certainty `tracking-uncertain`; consumers must not describe that
decision as proof that Git ignores the path. Built-in, configuration, and known profile-policy
decisions remain `known` because they are linter policy rather than inferred Git tracking state.

## Precedence and provenance

The highest matching source wins. Within a source, the last matching pattern wins.

| Priority | Source                  | Behavior                                                                  |
| -------: | ----------------------- | ------------------------------------------------------------------------- |
|        4 | Safety built-ins        | Fixed positive dependency/build/cache exclusions; cannot be negated       |
|        3 | Configuration           | Ordered `configurationPatterns`, normally the validated B06 `ignore` list |
|        2 | Profile facts           | Only facts explicitly marked `known-active` are applied                   |
|        1 | Repository `.gitignore` | Root-to-leaf files; a deeper file overrides an ancestor file              |

Every rule records an ID, original pattern, normalized base, precedence, source kind, source path
and line where applicable, and profile fact/source identifiers where applicable. `profileFacts`
preserves the complete validated input. Conditional, contradictory, and unknown facts are also
listed in `deferredProfileFacts` but cannot exclude or re-include anything. `known-inactive` facts
remain provenance only. This prevents uncertain client behavior from silently broadening an ignore
decision.

The non-negatable built-in list is exported as `BUILT_IN_IGNORE_PATTERNS`. It covers common
dependency, generated-build, and cache roots including `node_modules`, `vendor`, `dist`, `build`,
`target`, virtual environments, package-manager caches, framework caches, and coverage output.

## Git pattern behavior

Repository patterns implement the Git 2.55.0 documented grammar:

- empty lines and initial `#` comments match nothing; escaped leading `#` and `!` are literal;
- unescaped trailing spaces are discarded and escaped trailing spaces are retained;
- the last matching pattern decides, while `!` cannot re-include a path beneath an excluded parent;
- a leading or middle `/` anchors to the `.gitignore` directory; a pattern without `/` matches a
  basename at any descendant level;
- a trailing `/` matches directories and their contents, not a file or symlink with that name;
- `*`, `?`, bracket classes/ranges, escapes, leading/trailing `**`, and `/**/` follow pathname
  semantics without allowing `*` or `?` to cross `/`;
- matching is case-sensitive and always uses `/`, independently of host path syntax.

A terminal backslash and structurally empty/repeated-separator patterns from `.gitignore` are
retained as invalid rules that never match, with bounded `INVALID_PATTERN_NEVER_MATCHES` provenance.
The same malformed syntax is rejected in configuration and profile-fact inputs because silent policy
no-ops are unsafe. Malformed UTF-8, surrogates, control/bidirectional characters, unsafe caller
objects, and excessive pattern text fail before matching.

Git does not read nested `.gitignore` files below an excluded directory. C04 makes the same decision
before the C02 read, which also enforces Git's excluded-parent negation limitation and avoids
reading content that cannot affect the result. Symlinked ignore files are skipped and reported;
races, cancellation, C02 aggregate limits, and root changes propagate.

## Limits

| Limit                    |    Default | Hard maximum |
| ------------------------ | ---------: | -----------: |
| `maximumDurationMs`      |     30,000 |      300,000 |
| `maximumIgnoreFileBytes` |     65,536 |    1,048,576 |
| `maximumIgnoreFiles`     |      1,024 |       10,000 |
| `maximumMatchWork`       | 50,000,000 |  200,000,000 |
| `maximumPathDepth`       |        128 |        1,024 |
| `maximumPaths`           |    100,000 |    1,000,000 |
| `maximumPatternBytes`    |  4,194,304 |   16,777,216 |
| `maximumPatternLength`   |      4,096 |       16,384 |
| `maximumPatterns`        |     10,000 |      100,000 |
| `maximumProblems`        |        256 |        4,096 |

Limits include the fixed built-ins. Options must be a plain data object. Proxies, accessors, sparse
or extended arrays, unknown fields, invalid native cancellation signals, and out-of-range values are
rejected without invoking their code. Results, nested records, paths, facts, problems, and rules are
immutable. Problems beyond `maximumProblems` are counted by `omittedProblems`.
