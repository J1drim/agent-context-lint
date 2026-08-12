# Cursor local metadata observation — 2026-08-01

Purpose: pin locally available client surfaces for D11 without starting a model
session, reading user configuration, spending quota, or modifying a repository.

Environment: macOS arm64, Europe/Warsaw. User/account identifiers and absolute
binary locations are intentionally omitted because they are not relevant to the
compatibility claim.

## Commands and normalized output

```text
$ cursor --version
3.12.30
63a2996a10d9e476b6c28e951dd7691d9c0cf480
arm64

$ agent --version
2026.05.24-dda726e

$ cursor-agent --version
2026.05.24-dda726e
```

The Agent CLI help output was also inspected without authentication or a model
request. It identifies `agent` as "Start the Cursor Agent", exposes
`generate-rule|rule`, and shows `--workspace`, `--mode plan|ask`, and
`--version`. It warns that print mode has write and shell tools; no print-mode
request was run.

## Supported claims

- The pinned IDE launcher and Agent CLI versions were installed and executable.
- `agent` and `cursor-agent` resolved to the same reported Agent version.
- Metadata-only commands did not start a model request.

## Unsupported claims

This observation does not show which project rules load, their order, glob
matching, model relevance, nested behavior, reference expansion, or legacy
precedence. Those require the isolated D16 conformance harness and, if a paid
request is unavoidable, explicit authorization.
