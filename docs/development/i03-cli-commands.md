# Maintaining the I03 CLI commands

`packages/cli/src/i03-commands.ts` composes existing ticket contracts instead of duplicating their
semantics:

- C01/C02/C03/C04/C05 select, constrain, enumerate, ignore, and recognize repository inputs;
- B06 resolves repository configuration and enabled profiles;
- D03–D14 resolve profile state and build the cross-profile list;
- E05/E06 resolve and project effective context;
- B09 supplies the validated rule registry.

The router owns the closed option grammar. Command handlers receive only snapshotted operands,
format, profile, trace path, output capabilities, and cancellation. Production construction is
side-effect-free. The executable loads I03 lazily so help/version and library import do not trigger
filesystem access or internal implementation loading.

The filesystem fallback can inspect metadata before ignore matching, so the C02 facade retains its
16 MiB hard per-file ceiling for enumeration. I03 separately applies the configured `maxFileBytes`
ceiling before reading any instruction content into a profile resolver.

Golden assertions bind SHA-256 digests of terminal and JSON bytes for rules, cross-profile listing,
static explanation, and trace-bound explanation. Tests cover every supported profile, malformed
configuration and trace input, outside targets, redaction, exclusive-create conflicts, symbolic
links, repeated output, and the built `dist/cli.js` executable.

The workspace architecture keeps implementation packages private until K09 bundles them into the
public artifact. I03 imports those packages as development-time implementation boundaries, and the
CLI entry loads them only for I03 commands. Do not convert private workspaces into public runtime
dependencies to make a tarball test pass; K09 owns the reviewed production bundle.
