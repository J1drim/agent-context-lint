# Seeded recall development workflow

The F16 corpus exercises every rule through `scheduleRuleFamilies` with the full ten-family F15
composition. Scenario inputs are built from the production syntax, evidence, resolver, standards,
efficiency, and rule APIs. Expected rows are not copied from evaluator output and the runner does
not invoke family evaluators directly.

All scenario text and repository state are synthetic and owned by this repository. External source
is intentionally excluded from the F16 recall corpus. K02 separately freezes public-repository
metadata for precision calibration; it does not copy source into seeded cases and cannot change the
expected recall identities.

## Check and regenerate

Run the offline release check after changing a rule, fingerprint, registry entry, scheduler, or
scenario:

```sh
pnpm seeded-recall:check
```

The check builds packages, executes every scenario three times using concurrency/seed combinations
`1/0`, `4/9173`, and `10/4294967295`, validates the contracts, requires 69/69 visible findings, and
byte-compares the generated corpus and report with the committed files. It performs no network I/O
and fails on stale artifacts.

Only a trusted repository maintainer should regenerate artifacts. After reviewing an intentional
fingerprint or scenario change, regenerate with the explicit acknowledgement:

```sh
pnpm seeded-recall:generate
```

The generate command performs the same complete execution and determinism checks, then replaces each
fixed calibration artifact through its own exclusive temporary file, flush, and atomic rename. The
two-file set is not transactionally atomic: interruption can leave one new file and one stale file.
The normal check rejects that state; rerun acknowledged generation to recover, then review the
complete pair. Review the JSON diff, run `pnpm test:seeded-recall`, and obtain independent label
review before accepting changed evidence.

Generation captures and repeatedly revalidates the artifact directory's device, inode, and real path
and opens fixed files with no-follow semantics where Node exposes them. Portable pathname APIs
cannot eliminate every sub-syscall race against a hostile process that can concurrently replace
repository directories. This residual limitation is why generation is maintainer-only; normal
product scans never invoke it or write repository files.

## Adding or changing a rule

1. Add the real rule and its family-level positive, hard-negative, boundary, malformed-input, and
   suppression coverage.
2. Add a genuine synthetic scenario using the issuing production authorities required by that
   family. E04 DAGs, E03 traces, and G05/G07/G08 outputs must be production-issued. Do not
   hand-author opaque authority outputs or use external repository content.
3. Map the rule to the scenario and declare the independently reviewed exact diagnostic identity.
   The corpus validator requires exact registry order, ownership, severity, and one unique case per
   rule.
4. Run the generator and inspect the fingerprint-only diff. A missed or suppressed expected finding
   is a failing recall result.
5. Run the family tests, `pnpm test:seeded-recall`, type checking, lint, boundaries, security
   checks, packed-CLI tests, and the complete affected integration suite.

The native TypeScript loader used by the maintenance runner only maps repository-relative `.js`
imports to an existing sibling `.ts` source while Node's built-in type stripping is active. Product
scan paths do not load it. The actual scheduler and workspace packages are imported through their
built public package exports.
