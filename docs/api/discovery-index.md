# Targeted discovery index

Ticket C05 exposes a deterministic path-only discovery stage from `@agent-context/evidence`:

```ts
import { buildTargetedDiscoveryIndex } from "@agent-context/evidence";

const index = buildTargetedDiscoveryIndex(enumeration, ignoreResult, {
  matcherFacts,
});
```

The function accepts the immutable results of C03 tracked-file enumeration and C04 ignore
resolution. It deliberately accepts no repository, filesystem, command, network, or content-reader
capability. Its `contentReads` metric is therefore always `0`. Downstream adapters read only paths
selected from this index through C02.

## Result contract

`TargetedDiscoveryIndex` is recursively immutable and uses contract version `0.1.0`. `candidates`
are sorted by canonical repository-relative POSIX path. Each candidate contains:

- one or more kinds: `instruction`, `configuration`, or `evidence`;
- every path recognizer that matched it, including format identity where one is known;
- recognizer provenance: source identifier, retrieval date, and either an HTTPS source or a
  repository-owned artifact;
- explicit uncertainty inherited from C03 fallback tracking, deferred C04 profile ignores, and
  deferred C05 matcher facts.

The index also records the C03 source/reason/certainty, C04 tracking and profile certainty, applied
fact identifiers, deferred facts/counts, selected limits, and deterministic work/count metrics. A
candidate is not a claim that a client activates the file. Profile adapters remain authoritative for
location, selection, ordering, precedence, and activation.

`isIssuedTargetedDiscoveryIndex` authenticates only indexes produced by the current module instance.
Security-sensitive consumers such as changed-file selection require this identity so repository data
cannot forge or truncate a supposedly complete C05 inventory. Cloned or deserialized indexes must be
rebuilt from validated C03/C04 inputs before they regain authority.

## Built-in catalog

The closed v0 catalog recognizes the required instruction syntaxes:

- `AGENTS.md` and `AGENTS.override.md`;
- `CLAUDE.md`, `CLAUDE.local.md`, and recursive `.claude/rules/**/*.md`;
- `.github/copilot-instructions.md` and recursive `.github/instructions/**/*.instructions.md`;
- `GEMINI.md`;
- recursive `.cursor/rules/**/*.mdc` and root-only `.cursorrules`.

It also selects repository configuration required by earlier/later stages: root
`.agent-context-lint.yml`, nested `.gitignore`, `.geminiignore`, exact `.claude/settings.json`,
`.claude/settings.local.json`, and `.gemini/settings.json` suffixes. Evidence candidates for C11
include JS/pnpm, Cargo, Python, Go, Bazel, Nx, Turbo, Lerna, and Rush workspace manifests. C05 does
not parse those manifests.

Configured profile filenames are supplied as data-only `matcherFacts`, with an explicit candidate
kind and optional instruction-format identity. Matchers are restricted to `basename`, canonical
`exact-path`, canonical `path-suffix`, and `under-directory-extension`; arbitrary callbacks and
ambient globs are not accepted. Only `known-active` facts match. `known-inactive` facts are retained
but do not match. `conditional`, `unknown`, and `contradiction` facts are retained in
`deferredMatcherFacts` and add uncertainty without broadening discovery.

## Errors and limits

`DiscoveryIndexError` has stable codes for invalid options/input, malformed paths, limits,
cancellation, and deadlines. Input objects must be plain data; proxies, accessors, sparse/extended
arrays, duplicate identities, malformed UTF-16, controls, bidirectional overrides, traversal,
inconsistent C03/C04 provenance, and a non-partitioning ignore result fail closed.

Default limits are:

| Resource                   |     Default | Hard maximum |
| -------------------------- | ----------: | -----------: |
| Paths                      |     100,000 |    1,000,000 |
| Total path bytes           |      64 MiB |      512 MiB |
| Candidates                 |     100,000 |    1,000,000 |
| Path depth                 |         128 |        1,024 |
| Path UTF-16 length         |      16,384 |       16,384 |
| Matcher facts              |         256 |        4,096 |
| Recognizers per candidate  |          32 |          256 |
| Upstream C04 profile facts |      10,000 |      100,000 |
| Matcher work units         | 100,000,000 |  500,000,000 |
| Duration                   |  30 seconds |  300 seconds |

Limits may only be tightened or raised up to their hard maximum. The production API uses a monotonic
clock. `buildTargetedDiscoveryIndexWithClock` is the trusted test form for deterministic deadline
checks.

## Source boundary

The catalog was checked on 2026-08-02 against current first-party sources:

- [Codex `AGENTS.md`](https://developers.openai.com/codex/guides/agents-md)
- [Claude Code memory and rules](https://code.claude.com/docs/en/memory)
- [GitHub Copilot custom-instruction support](https://docs.github.com/en/copilot/reference/custom-instructions-support)
- [Gemini CLI `GEMINI.md`](https://geminicli.com/docs/cli/gemini-md/)
- [Cursor rules](https://cursor.com/docs/context/rules)

These sources establish candidate locations, not universal client precedence. The repository's
pinned D02/D04/D06/D09/D11 research remains the authority for versioned client behavior. Current
docs and pinned observations can differ; C05 does not turn such a difference into certain
activation.
