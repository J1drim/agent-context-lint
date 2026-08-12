# Shell completion and manual pages

The npm package includes completions generated from the exact command registry used by the CLI. Use
the artifact installed with the CLI version you run; copying a completion from another release can
expose options that its executable does not accept.

## Bash

The Bash artifact uses only facilities available in macOS Bash 3.2 and current GNU Bash. For a
project-local installation, load it into the current shell:

```sh
source ./node_modules/@agent-context/lint/completions/agent-context-lint.bash
```

Copy or source that file from the completion directory used by your shell framework for persistent
installation.

## Zsh

Add the package completion directory to `fpath` before initializing completion:

```zsh
fpath=(./node_modules/@agent-context/lint/completions $fpath)
autoload -Uz compinit
compinit
```

The packaged filename is `_agent-context-lint`, as required by Zsh's native discovery convention.

## Fish

Load the generated Fish definition for the current session:

```fish
source ./node_modules/@agent-context/lint/completions/agent-context-lint.fish
```

For persistent installation, copy it to the per-user Fish completions directory using the normal
Fish configuration workflow.

## Manual page

The package declares `man/agent-context-lint.1` through npm's `man` field. A global npm-compatible
installation can register it automatically. A project-local copy can be read explicitly:

```sh
man ./node_modules/@agent-context/lint/man/agent-context-lint.1
```

The generated manual contains no ANSI styling or hard-coded terminal width; the selected `man`
implementation and pager own wrapping and color policy.

## Platform policy

Native Bash, Zsh, and Fish artifacts are supported on the Unix-like systems where those shells are
available. On Windows, the Bash artifact is supported inside WSL or Git Bash. Native PowerShell
completion is not part of the v1 contract. The CLI remains fully supported on Windows without shell
completion.
