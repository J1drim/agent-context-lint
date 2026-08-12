# Command evidence contract

Ticket F02 exports `lexCommandEvidence` from the internal `@agent-context/evidence` package. It
recognizes command-shaped text as inert data. It does not expand variables or substitutions, resolve
executables, read an environment, access a filesystem or network, import code, or start a process.

```ts
const result = lexCommandEvidence({
  dialect: "posix-shell",
  text: scriptFact.rawValue,
  provenance: {
    collectorId: scriptFact.provenance.collectorId,
    factId: scriptFact.id,
    source: scriptFact.location,
    sourceKind: "evidence-fact",
  },
});
```

The `0.1.0` result is recursively immutable and deterministic. It contains the requested and
resolved dialect, confidence, normalized B02 uncertainty, canonical provenance, tokens, invocations,
issues, effective limits, and metrics. Token and issue ranges are half-open UTF-16 offsets relative
to the exact `input.text`; provenance retains the repository-relative source and absolute
source-document range supplied by F01 or another trusted collector.

## Recognition boundary

Supported dialects are `posix-shell`, `windows-cmd`, `windows-powershell`, and `auto`. The lexer
recognizes words, leading POSIX-style environment assignments, control operators, redirections,
quotes, escapes, variable expansions, POSIX backtick substitutions, and `$()` substitutions. Windows
executable names are case-folded and the `.bat`, `.cmd`, `.exe`, or `.ps1` suffix is removed for
comparison. Exact spelling remains available in `raw`.

Every word is divided into source-located parts. A fully static word has a string `value`; any part
whose runtime value depends on expansion or substitution makes the word value `null`. Invocation
arguments preserve those nulls instead of guessing. Malformed quotes, substitutions, and escapes are
retained with issues and `unknown` uncertainty.

`auto` is intentionally conservative:

- one family of dialect-exclusive markers yields `high` (`0.9`) confidence;
- mixed marker families yield a `contradiction`, alternatives, and no resolved dialect;
- no exclusive markers yield `unknown` uncertainty and no resolved dialect; and
- an explicit caller dialect yields `exact` (`1`) confidence.

When an unresolved `auto` input is tokenized, the implementation uses only the common static subset
and still returns `resolvedDialect: null`. This fallback is an inspection mechanism, not a claim
about shell behavior.

## Limits and errors

Default limits bound UTF-16 input length (65,536), tokens (16,384), parts (32,768), invocations
(4,096), issues (1,024), and nested substitutions (64). Hard ceilings are exported separately.
Invalid input/options and resource exhaustion throw `CommandLexerError` with stable
`CommandLexerErrorCode` values and, for limits, `limitName`.

Input, provenance, nested ranges, and options must be closed, plain, non-proxy data records with own
data properties. Repository paths must already be canonical and repository-relative. Accessors,
symbols, unknown keys, reversed locations, unsafe integers, and forged dialects fail before use.

## Specification boundary

The static subset was reviewed on 2026-08-02 against the
[POSIX Shell Command Language](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html),
[Microsoft `cmd` documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd),
[PowerShell parsing rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing),
and
[PowerShell redirection rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection).
These specifications describe substantially more context-sensitive behavior than this safety-focused
lexer implements. Alias lookup, command discovery, globbing, parameter expansion results, pipelines,
subshell execution, PowerShell expression evaluation, `cmd` delayed-expansion state, and client host
differences remain conditional or unknown.
