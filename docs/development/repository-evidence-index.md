# Developing the repository evidence index

F01 lives in `packages/evidence/src/evidence-index.ts`. Keep it a fact layer: downstream rules may
compare facts, but collectors must not make a lint conclusion or silently select among conflicts.

## Pipeline contract

Callers obtain a C02 repository capability, build the filtered path inventory through repository
discovery/ignore handling, run C11 boundary discovery, and then pass all three to
`collectRepositoryEvidence`. Do not reconstruct a path inventory by walking directories inside F01.
That would bypass ignore/tracking provenance and duplicate the hardened discovery layers.

Content reads require both a caller-approved path and a closed `readKind` match. Ordinary paths,
lockfiles, and formatter/linter configuration are path-only. C11 must mark a package, Cargo, Go,
pyproject, Nx, or Turbo manifest `complete` before F01 reopens it for additional inert fields. This
prevents malformed or unsupported C11 evidence from becoming authoritative through a second parser.

## Adding evidence

When extending a collector:

1. link a current primary format source and record the review date in the API documentation;
2. decide whether path presence is enough; prefer path-only collection when content is unnecessary;
3. add a closed recognizer rather than accepting a repository-provided parser, plug-in, include, or
   callback;
4. add source ranges, certainty, and collector provenance to every fact;
5. preserve every bounded declaration and let `EvidenceConflict` expose differing values;
6. add malformed, type, boundary, limit, cancellation, determinism, and executable-looking fixtures;
7. confirm ordinary files and every dynamic include/import remain unread or unexpanded; and
8. update the API and threat-model documentation in the same commit.

Do not use `child_process`, dynamic `import()`, `require`, `eval`, `Function`, shell libraries,
package-manager APIs, language runtimes, or tool configuration loaders. Parsing a `run`, script,
recipe, alias, hook, or task value grants no capability to execute it.

## Verification

The focused suite is:

```sh
pnpm exec vitest run packages/evidence/test/evidence-index.unit.test.ts
```

It uses `conformance/fixtures/v0/repository-evidence.fixture.json` for representative evidence and
real C02/C11 composition. Before integration, run `pnpm check`; the complete gate includes typed
lint, package boundaries, serial/parallel determinism, merged coverage, and packed-artifact checks.
