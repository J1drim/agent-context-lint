# Gemini CLI local metadata observation — 2026-08-01

Purpose: pin an official Gemini CLI executable for D09 without starting a
model session, authenticating, reading existing user configuration, spending
quota, or modifying any external repository.

## Provenance and isolation

| Field | Value |
| --- | --- |
| Package | `@google/gemini-cli@0.53.1` from the public npm registry |
| npm integrity | `sha512-xBGdD/tl05gsTpD2oV1Bq0NCb4BBeTnjSbKxHtwOB7nt1QMaqWYJ9WsOEsQQhQ2P1v0UJth1F17SAXvdZ5mASw==` |
| Official release source | `v0.53.1` at `19a68016bdc9cd4177a155846dd51f282c3c1c59` |
| Install location | isolated `/tmp` prefix and npm cache, installed with `--ignore-scripts --no-audit --no-fund` |
| Configuration isolation | `GEMINI_CLI_HOME` pointed to a new `/tmp` directory; system-settings and system-defaults variables pointed to nonexistent `/tmp` files |
| Working directory | empty synthetic `/tmp` probe directory |
| Platform | macOS arm64 |

The official `GEMINI_CLI_HOME` override was used instead of changing `HOME`, so
the probe did not inspect `~/.gemini`. No prompt, query, resume, session-list,
extension-list, MCP, or interactive command was run.

## Commands and normalized output

```text
$ gemini --version
0.53.1

$ gemini --help
Usage: gemini [options] [command]

Gemini CLI - Defaults to interactive mode. Use -p/--prompt for non-interactive (headless) mode.

Commands:
  gemini mcp                   Manage MCP servers
  gemini extensions <command>  Manage Gemini CLI extensions.
  gemini skills <command>      Manage agent skills.
  gemini hooks <command>       Manage Gemini CLI hooks.
  gemini gemma                 Manage local Gemma model routing
  gemini [query..]             Launch Gemini CLI

Relevant options:
  --include-directories  Additional directories to include in the workspace
  --version              Show version number
  --help                 Show help
```

The complete help output contained no memory, context-discovery, dry-run, or
local instruction-inspection command. `/memory` is an in-session slash command,
not a top-level command shown by this help.

## Local side effects

Even metadata-only invocations left transiently named
`.gemini/projects.json.<uuid>.tmp` files inside the isolated
`GEMINI_CLI_HOME`. This is an observed local metadata side effect, not evidence
that a project or context file was discovered. All writes remained under the
disposable `/tmp` isolation root.

## Supported claims

- The official stable package was installable and reported version `0.53.1`.
- Version/help completed without authentication or a model request.
- The help advertises include-directory input but no guaranteed local-only
  context-discovery inspection surface.

## Unsupported claims and blocked observation

This probe does not establish which `GEMINI.md` files load, their content or
order, JIT behavior, trust behavior, import expansion, ignore precedence, or
reload semantics. Attempting `/memory show`, `/memory list`, or `/memory
reload` requires entering the interactive client and may start authentication
or model-backed session behavior.

Status for those cases: `blocked-paid-observation`. They remain documented or
source-derived claims until the D15/D16 isolated conformance run is explicitly
authorized. That run must continue to use a synthetic home and must not read a
user's Gemini configuration or send changes to external repositories.
