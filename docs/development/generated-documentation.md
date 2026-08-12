# Maintaining generated CLI documentation

Ticket I14 has one generation pipeline for the command reference, shell completions, manual page,
and packaged machine reference. It reads `CLI_COMMAND_DEFINITIONS` and `CLI_GLOBAL_OPTIONS` from the
router, the complete B06 configuration schema, and `RULE_REGISTRY` from B09. Do not add a second
hand-maintained command or option list.

Run the explicit writer after an authoritative contract changes:

```sh
pnpm docs:artifacts
```

All generators are check-only when called without an option. The full check is:

```sh
pnpm docs:artifacts:check
```

CI compares every artifact byte-for-byte and fails on a missing or stale file. Generated output has
no clock, locale-dependent ordering, host path, color, or terminal-width input. Command and rule
metadata is validated before rendering; shell, Markdown, and roff metacharacters are escaped at
their output boundary. Tests include hostile `$()`, quote, backslash, Markdown-tag, and roff-macro
metadata.

The packaged machine reference uses the generator's recursively key-sorted, two-space canonical JSON
byte contract. It is intentionally listed in `.prettierignore`: Prettier's compact-array layout
would conflict with the byte-for-byte regeneration and packed-artifact checks. The reference schema,
generator check, schema validation, and package audit remain authoritative for that file;
hand-formatting it is unsupported.

The pack gate requires all completion, manual, schema, and reference paths in the npm tarball. It
also parses the tagged examples in `docs/api/command-reference.md`, proves that the visible shell
line matches the structured argument vector, and invokes every example against the extracted tarball
with `shell: false`. Examples in that generated section are intentionally help/version operations,
so the documentation test never scans a repository, writes a configuration, calls a model, or
accesses the network.

The generated `packages/cli/publish/` staging tree is not part of the source documentation tree. It
copies the package README to a deeper path for packing, so its repository-relative documentation
links are intentionally excluded from the local Markdown link walk. Source links remain checked at
their authoritative `packages/cli/README.md` location.

When adding a command or option:

1. update the router registry and parser together;
2. add router behavior tests;
3. regenerate all documentation artifacts;
4. inspect Bash, Zsh, Fish, roff, Markdown, and machine-reference diffs;
5. run focused unit and documentation tests, followed by the actual pack gate.
