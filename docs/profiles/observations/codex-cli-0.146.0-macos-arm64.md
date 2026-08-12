# Codex CLI 0.146.0 `AGENTS.md` observation transcript

- Date: 2026-08-01
- Platform: macOS arm64
- Binary: `/opt/homebrew/bin/codex` → Homebrew Cask `codex/0.146.0`
- Reported version: `codex-cli 0.146.0`
- Release source pin: `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`
- Cost/network policy: no model, API, `exec`, or TUI session was used

This is a sanitized transcript of local, synthetic observations supporting the
[`codex-cli` profile](../codex-cli-agents.md). `$OBS_ROOT` represents one
temporary directory; no repository or real global instruction file was used.
The temporary `CODEX_HOME` directories contained only fixtures plus state that
the CLI initialized locally (`installation_id`, migration marker, and built-in
skill marker). The ordinary PATH-alias sandbox warning is omitted.

## Inspection path

```console
$ /opt/homebrew/bin/codex --version
codex-cli 0.146.0

$ /opt/homebrew/bin/codex debug prompt-input --help
Render the exact model-visible prompt input as JSON for inspection
```

The official [CLI reference](https://developers.openai.com/codex/cli/reference#codex-debug-prompt-input)
documents `debug prompt-input` as an experimental inspection command. Every
observation below invokes only that command with synthetic context and filters
its JSON output for unique sentinels. The command returned locally without
starting an interactive session or executing a model request. Output blocks
show only the relevant excerpt from the matching model-visible JSON string;
wrapper metadata and the local prompt sentinel are omitted.

## Fixture outline

The principal fixture was equivalent to:

```text
$OBS_ROOT/
├── home/
│   ├── AGENTS.md                    GLOBAL_BASE_SENTINEL
│   ├── AGENTS.override.md           GLOBAL_OVERRIDE_SENTINEL
│   └── config.toml                  fallbacks + 65536-byte cap
└── repo/
    ├── .git/
    ├── AGENTS.md                    ROOT_BASE_SENTINEL
    ├── AGENTS.override.md           ROOT_OVERRIDE_SENTINEL
    ├── TEAM_GUIDE.md                ROOT_FALLBACK_SENTINEL
    └── selected/
        ├── AGENTS.md                CHILD_BASE_SENTINEL
        ├── AGENTS.override.md       CHILD_OVERRIDE_SENTINEL
        ├── TEAM_GUIDE.md            CHILD_FALLBACK_SENTINEL
        └── deep/
            ├── TEAM_GUIDE.md        DEEP_FALLBACK_SENTINEL
            └── empty/
                ├── AGENTS.override.md  empty
                └── AGENTS.md           EMPTY_DIR_BASE_SENTINEL
```

The effective fallback list intentionally included duplicates and an empty
entry:

```toml
project_doc_fallback_filenames = ["TEAM_GUIDE.md", "AGENTS.md", "", "TEAM_GUIDE.md"]
project_doc_max_bytes = 65536
```

## Root, order, candidate selection, and empty shadowing

```console
$ cd "$OBS_ROOT/repo/selected/deep/empty"
$ CODEX_HOME="$OBS_ROOT/home" codex debug prompt-input \
    'LOCAL_OBSERVATION_PROMPT' | jq -r \
    '.. | strings | select(test("SENTINEL|project-doc"))'
GLOBAL_OVERRIDE_SENTINEL

--- project-doc ---

ROOT_OVERRIDE_SENTINEL

CHILD_OVERRIDE_SENTINEL

DEEP_FALLBACK_SENTINEL
```

Absent from the model-visible text were the global base, root/child bases and
fallbacks, and `EMPTY_DIR_BASE_SENTINEL`. This confirms, for the fixture:

- global override before project content;
- root-to-CWD project order;
- one candidate per directory with override before base before fallback;
- configured fallback use where both built-ins are absent;
- an empty selected project override shadows the non-empty base in that same
  directory.

## Global empty override differs from project empty selection

```console
$ cd "$OBS_ROOT/repo"
$ CODEX_HOME="$OBS_ROOT/home-empty" codex debug prompt-input \
    'LOCAL_OBSERVATION_PROMPT' | jq -r \
    '.. | strings | select(test("GLOBAL_BASE_AFTER_EMPTY_OVERRIDE"))'
GLOBAL_BASE_AFTER_EMPTY_OVERRIDE
```

Here the global override fixture was empty and the global base was non-empty.
The base was used. This confirms the documented “first non-empty” global rule
and demonstrates that it must not be conflated with project candidate
selection.

## Empty first fallback shadows a later fallback

With `project_doc_fallback_filenames = ["FIRST.md", "SECOND.md"]`, an empty
`FIRST.md`, and a non-empty `SECOND.md`:

```console
$ cd "$OBS_ROOT/repo-fallback"
$ CODEX_HOME="$OBS_ROOT/home-fallback" codex debug prompt-input \
    'LOCAL_OBSERVATION_PROMPT' | jq -r \
    '.. | strings | select(test("SECOND_FALLBACK_SENTINEL|project-doc"))'
# no matching output
```

The first fallback was selected by metadata, then omitted as empty; discovery
did not continue to the second fallback.

## Custom, missing, and explicitly empty root markers

```console
$ cd "$OBS_ROOT/custom-root/child/deep"
$ CODEX_HOME="$OBS_ROOT/home-empty" codex \
    -c 'project_root_markers=[".workspace-root"]' \
    debug prompt-input 'LOCAL_OBSERVATION_PROMPT' | jq -r \
    '.. | strings | select(test("CUSTOM_(ROOT|CHILD|DEEP)"))'
CUSTOM_ROOT_SENTINEL

CUSTOM_CHILD_SENTINEL

CUSTOM_DEEP_SENTINEL
```

From a tree with no default marker, only the CWD sentinel appeared; its parent
sentinel did not. From the principal Git tree with
`-c 'project_root_markers=[]'`, only the CWD fallback appeared; root and child
sentinels did not.

| Case | Relevant output |
| --- | --- |
| no ancestor `.git` | `NO_MARKER_CHILD_SENTINEL` only |
| `project_root_markers=[]` | `DEEP_FALLBACK_SENTINEL` only |
| custom `.workspace-root` | root, child, then deep sentinels |

## Aggregate budget and raw-byte truncation

The root file contained exactly 23 bytes (`ROOT_OVERRIDE_SENTINEL` plus a
newline), the child began with `CHILD_OVERRIDE_SENTINEL`, and a deep file was
also present. With a 30-byte cap:

```console
$ cd "$OBS_ROOT/repo/selected/deep/empty"
$ CODEX_HOME="$OBS_ROOT/home" codex -c 'project_doc_max_bytes=30' \
    debug prompt-input \
    'LOCAL_OBSERVATION_PROMPT' | jq -r \
    '.. | strings | select(test("ROOT_|CHILD_|DEEP_"))'
ROOT_OVERRIDE_SENTINEL

CHILD_O
```

The root consumed 23 bytes, the child consumed the remaining 7, and the deep
file was omitted. This is one aggregate budget, not a per-file cap.

For an `AGENTS.md` containing `1234567€TAIL` and a 9-byte cap:

```console
$ cd "$OBS_ROOT/repo-cap"
$ CODEX_HOME="$OBS_ROOT/home-empty" codex -c 'project_doc_max_bytes=9' \
    debug prompt-input \
    'LOCAL_OBSERVATION_PROMPT' | jq -r \
    '.. | strings | select(test("1234567"))'
1234567�
```

Seven ASCII bytes plus only two bytes of the three-byte euro sign fit. The
client therefore truncated raw bytes and decoded the incomplete sequence with
the replacement character.

## Symlink outside the repository

`repo-symlink/AGENTS.md` was a symlink to a synthetic file elsewhere under
`$OBS_ROOT`, while `.git` remained inside `repo-symlink`:

```console
$ cd "$OBS_ROOT/repo-symlink"
$ CODEX_HOME="$OBS_ROOT/home-empty" codex debug prompt-input \
    'LOCAL_OBSERVATION_PROMPT' | jq -r \
    '.. | strings | select(test("SYMLINK_OUTSIDE_SENTINEL"))'
SYMLINK_OUTSIDE_SENTINEL
```

This confirms what the pinned source states: Codex permits such symlinks. It
does not authorize the linter to read outside its scan root; the compatibility
profile requires an external-target diagnostic with unavailable content.

## Source pin and no-cost limits

The installed binary is not itself a source checkout. The release tag was
resolved independently:

```console
$ git ls-remote https://github.com/openai/codex.git \
    'refs/tags/rust-v0.146.0*'
e363b08c9175ac1cbe5893615dd2cb9ddf95043b refs/tags/rust-v0.146.0^{}
```

The pinned source supplies behaviors not safely exercised here, including the
zero-byte cap, metadata/read error propagation, project-config exclusion during
root detection, candidate deduplication, and multi-environment assembly. They
remain labelled `source`, not `observed`.

No-cost inspection is available on this client, so the core local observation
is not pending. Independent review was completed during main-branch integration.
Cross-platform observations and migration of the remaining scenario catalog to
the [D01 v0 conformance contract](../../contracts/profile-conformance-fixture-v0.md)
remain pending; the canonical root-order fixture demonstrates the mapping.
