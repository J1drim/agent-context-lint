# Development setup

Agent Context Linter uses a pinned Node.js and pnpm toolchain. The repository is a TypeScript
project-reference workspace and must build from a clean clone without global project state.

## Prerequisites

- Node.js `24.18.1` is the development baseline. The public runtime contract is
  `^24.11.0 || ^26.0.0`; see
  [ADR-0001](../architecture/decisions/0001-runtime-and-platform-support.md).
- pnpm `11.18.0` is the only repository package manager.

The `.node-version` file is understood by many Node version managers. After selecting Node.js,
install the exact pnpm version without relying on bundled Corepack:

```sh
npm install --global pnpm@11.18.0
node --version
pnpm --version
```

The version commands must report `v24.18.1` and `11.18.0` for the reproducible development baseline.
pnpm also downloads the pinned Node runtime for project scripts when the shell uses another
supported Node line.

## Install and verify

The first install creates no lockfile changes because the reviewed lockfile is committed:

```sh
pnpm install --frozen-lockfile
pnpm check
```

The aggregate check also validates the committed CI/security workflows and audits the licenses of
the installed dependency graph. See
[supply-chain security controls](../security/supply-chain-controls.md) for hosted checks and
repository settings.

Use a non-frozen install only while making a reviewed dependency change:

```sh
pnpm install --no-frozen-lockfile
git diff -- package.json pnpm-workspace.yaml pnpm-lock.yaml
```

Do not commit npm, Yarn, or Bun lockfiles. Normal dependency updates must satisfy the seven-day
release-age policy and keep lifecycle scripts denied unless a specific package/version is reviewed
and allowlisted. The workspace contains two exact release-age exceptions: Node.js `24.18.1` and pnpm
`11.18.0`, because the accepted A01 ADR pins those newly released tool versions. These exceptions do
not permit later versions and must be removed or updated only with the ADR.

## Commands

| Command                     | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `pnpm build`                | Build every package in project-reference order                         |
| `pnpm typecheck`            | Type-check production projects, tests, and Vitest configuration        |
| `pnpm lint`                 | Run typed ESLint and package-boundary enforcement                      |
| `pnpm format:check`         | Check managed source, configuration, and developer documentation       |
| `pnpm test`                 | Run unit and integration projects with file parallelism                |
| `pnpm test:serial`          | Run the same projects in one worker without file parallelism           |
| `pnpm test:determinism`     | Compare normalized serial and parallel result bytes and hashes         |
| `pnpm test:boundaries`      | Prove allowed and forbidden dependency edges                           |
| `pnpm test:pack`            | Exercise required and forbidden packed-file policy                     |
| `pnpm test:documentation`   | Test generated-doc parsing, determinism, and stale-file detection      |
| `pnpm docs:links:check`     | Verify every repository-local Markdown link and heading anchor         |
| `pnpm docs:artifacts`       | Explicitly regenerate command, config, rule, completion, and man docs  |
| `pnpm docs:artifacts:check` | Check generated documentation without modifying the worktree           |
| `pnpm coverage`             | Collect project blobs, merge coverage, and verify stable merged output |
| `pnpm pack:check`           | Pack public packages and execute the extracted CLI acceptance suite    |
| `pnpm clean`                | Remove TypeScript outputs through project-reference clean mode         |
| `pnpm check`                | Run all repository foundation checks in release order                  |

The deterministic test contracts and fixture APIs are documented in [Testing](testing.md).

The packed-file policy fails closed on known cross-package build outputs, including suppression and
configuration-parser files that belong to the private syntax package. A clean build is useful
verification, but it cannot replace this explicit deny-list: TypeScript does not necessarily remove
ignored outputs left behind after a source file moves between packages.

The extracted CLI checks cover help, version, unavailable-command failure, direct shebang execution,
a side-effect-free public-library import, packaged documentation paths, and every tagged generated
command example. See the [command-line contract](../api/command-line.md) for the command grammar,
exit codes, cancellation behavior, and current feature availability.

## TypeScript 7 and linting

TypeScript `7.0.2` is the build compiler. TypeScript 7.0 does not expose a programmatic compiler
API, while typed ESLint requires that API. Following the
[official TypeScript 7 side-by-side guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60),
the workspace installs the native compiler as `@typescript/native` and exposes exact
`@typescript/typescript6@6.0.2` under the `typescript` alias solely for `typescript-eslint`. `tsc`
therefore runs 7.0.2; ESLint receives the supported 6.0 API. Both versions are exact catalog entries
and lockfile inputs.

## Fresh-clone expectation

A clean checkout plus the pinned Node and pnpm versions must be sufficient. Do not depend on
globally installed compilers, formatters, package caches, generated `dist` directories, or a
developer's global pnpm configuration. CI uses the frozen lockfile and treats warnings or lock drift
as failures.

See [Continuous integration](continuous-integration.md) for the required cross-platform matrix,
workflow security controls, static validation commands, and Node 26 promotion procedure.
