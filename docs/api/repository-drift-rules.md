# Repository drift rules

Ticket F09 exports `evaluateRepositoryDrift` from `@agent-context/rules`. The evaluator composes a
sorted set of source-backed statements with the F01 `RepositoryEvidenceIndex`, calls the F03
classifier and F02 command lexer internally, and emits a B04 `DiagnosticBundle` for ACL300–ACL305.
It performs no repository reads, command execution, environment expansion, dynamic imports, network
access, model calls, or writes.

```ts
const result = evaluateRepositoryDrift(statements, evidenceIndex);

for (const diagnostic of result.bundle.diagnostics) {
  // Format, suppress, or schedule through the normal B04/F15 pipeline.
}
for (const uncertainty of result.uncertainties) {
  // Preserve this separately from a confirmed finding.
}
```

Each statement carries its canonical repository path, source digest, B03 document/statement/node IDs
and exact source range, plus the F02 dialect to use for command-shaped text. Inputs must be sorted
by unique statement ID. The immutable `0.1.0` result records the F01, F02, and F03 contract
versions, effective limits, work metrics, diagnostics, and explicit uncertainties. Findings have
stable path and semantic fingerprints and attach digest-only repository-fact evidence where a
configured value caused the conclusion. F09 proposes no fixes.

## Rule decisions

| Rule   | A finding requires                                                                                                                                                                  | A finding is withheld when                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| ACL300 | An explicit npm/pnpm `run` or `run-script` name, or a Make/Just target, is absent from the nearest applicable complete fact scope.                                                  | The command/task is dynamic or optional, applicable evidence is incomplete, or resolution can select something other than a script/task. |
| ACL301 | One complete nearest-scope `package-manager:selected` value differs from a literal npm, pnpm, Yarn, or Bun command.                                                                 | Selection is absent, incomplete, or conflicting, or the command/dialect is dynamic.                                                      |
| ACL302 | A high-confidence F03 path-policy object or a repository-relative command executable is absent from the F01 path inventory. A descendant inventory entry proves a directory exists. | The candidate contains prose, glob/dynamic syntax, is absolute/outside-root, or matching/index evidence is incomplete.                   |
| ACL303 | A literal invocation names a tool in F09's closed tool catalog and no nearest-scope complete F01 tool fact exists. Recognized package-runner wrappers are unwrapped.                | The tool is unknown to the closed catalog, dynamic, present, or supported only by incomplete evidence.                                   |
| ACL304 | A high-confidence runtime statement specifies a major or exact minor version and every complete applicable fact proves a conflicting major or exact minor.                          | Any fact is compatible, evidence conflicts/is incomplete, or repository syntax has range semantics F09 does not prove.                   |
| ACL305 | A high-confidence formatting/linting policy names a closed-catalog tool for which complete applicable tool/config evidence exists.                                                  | The prose is not a recognized F03/F09 policy form or configuration presence is unproved.                                                 |

`scopedFacts` uses the nearest applicable repository scope; root facts apply everywhere and a more
specific workspace scope hides broader facts for the same category/name. A positive fact is one
whose certainty is not `uncertain` and whose source state is `complete` or `path-only`.

## Package-manager command resolution

F09 deliberately does not pretend that the same spelling means the same thing in every client.

| Command form                            | ACL300 treatment                                                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run NAME`, `npm run-script NAME`   | Definite package-script reference. `--if-present` becomes `optional-task-reference`, never a missing-script error. npm lifecycle shorthands are not generalized into script references.                    |
| `pnpm run NAME`, `pnpm run-script NAME` | Definite package-script reference. Optional and regular-expression forms remain uncertainty.                                                                                                               |
| `yarn run NAME`, `yarn NAME`            | A present script suppresses ACL300; otherwise `ambiguous-task-resolution`, because Yarn can resolve dependency binaries and shorthand can overlap CLI commands.                                            |
| `bun run NAME`, `bun NAME`              | A present script suppresses ACL300; otherwise `ambiguous-task-resolution`, because Bun can resolve built-ins, scripts, source files, project binaries, and system commands with form-dependent precedence. |
| `make NAME`, `just NAME`                | Definite task reference when `NAME` is one safe literal.                                                                                                                                                   |

The behavior above was reviewed on 2026-08-02 against the current official
[npm run-script documentation](https://docs.npmjs.com/cli/v11/commands/npm-run/),
[pnpm run documentation](https://pnpm.io/cli/run),
[Yarn run documentation](https://yarnpkg.com/cli/run), and
[Bun runtime documentation](https://bun.com/docs/runtime). The observed/documented distinction is
part of the rule contract: npm and pnpm explicit `run` address manifest scripts, Yarn documents
script-then-binary behavior, and Bun documents built-in/script/file/binary/system resolution. These
pages describe the cited client versions available at retrieval time, not an everlasting precedence
guarantee. New shorthand or precedence claims require a reviewed source and regression fixture;
otherwise F09 must return uncertainty.

## Runtime boundary

Recognized prose is anchored to `use`, `require`, or `target` plus Node.js, Python, Go, Rust, Java,
or Ruby, or to an explicit `runtime version must/should be/is` form. F09 compares integer major
versions and exact minor versions only. A caret constraint can prove a major mismatch but not an
exact minor mismatch. Unions, wildcards, `x` ranges, and other unsupported range syntax produce
`unsupported-runtime-constraint` instead of a diagnostic. This is intentionally narrower than each
runtime's full version algebra.

## Input, uncertainty, and resource safety

Statements, options, the F01 index envelope, and every decision-bearing fact/location/provenance
record are closed, descriptor-snapshotted, non-proxy data. Arrays must be dense and contain no extra
keys. IDs, canonical paths, source digests, Unicode, ranges, enum values, ordering, and unique fact
IDs are revalidated at the rule boundary. Nondecision F01 metadata such as collection metrics and
issues is retained at the F01 boundary but is not traversed or interpreted by F09; aggregate
`uncertainty` and all decision-bearing facts are revalidated.

Uncertainty is deduplicated and sorted separately from diagnostics. Its closed reasons are ambiguous
dialect, ambiguous task resolution, dynamic command, evidence conflict, incomplete evidence,
optional task reference, pattern task reference, and unsupported runtime constraint. A caller must
not promote an uncertainty to a finding.

| Resource                     | Default | Hard maximum |
| ---------------------------- | ------: | -----------: |
| Statements                   |  10,000 |      100,000 |
| F01 facts                    | 250,000 |    1,000,000 |
| UTF-16 units per text/value  |  65,536 |    1,048,576 |
| Diagnostics                  |  50,000 |      250,000 |
| Uncertainties                |  50,000 |      250,000 |
| Related facts per diagnostic |      64 |        1,024 |

Invalid input/options and exhausted limits fail closed with `RepositoryDriftError` and a stable code
plus the applicable limit name. Category/name indexes avoid a statement-by-all-facts scan, and
deduplication uses bounded sets instead of repeated result-array searches.
