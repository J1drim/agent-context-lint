import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import { describe, expect, test, vi } from "vitest";

import {
  COMMAND_LEXER_DEFAULT_LIMITS,
  CommandLexerError,
  CommandLexerErrorCode,
  lexCommandEvidence,
} from "../src/index.js";
import type { CommandDialect, CommandLexerInput } from "../src/index.js";

function input(text: string, dialect: CommandDialect = "posix-shell"): CommandLexerInput {
  return {
    dialect,
    provenance: {
      collectorId: "evidence.package-json.script",
      factId: "fact-000001",
      source: {
        path: canonicalizeRepositoryRelativePath("package.json"),
        range: {
          start: { byteOffset: 20, line: 2, utf16Column: 4, utf16Offset: 20 },
          end: { byteOffset: 80, line: 2, utf16Column: 64, utf16Offset: 80 },
        },
      },
      sourceKind: "evidence-fact",
    },
    text,
  } as const;
}

describe("command evidence lexer", () => {
  test("recognizes POSIX assignments, literals, expansions, substitutions, redirects, and pipelines", () => {
    const result = lexCommandEvidence(
      input("CI=1 node 'tool.js' \"plain value\" $TARGET $(printf x) `date` 2>log && echo done"),
    );

    expect(result.resolvedDialect).toBe("posix-shell");
    expect(result.uncertainty).toEqual({
      conditions: ["runtime expansion or substitution determines part of the command"],
      state: "conditional",
    });
    expect(result.invocations).toHaveLength(2);
    expect(result.invocations[0]).toMatchObject({
      environment: { CI: "1" },
      executable: "node",
      redirections: [{ operator: "2>", target: "log" }],
      state: "dynamic",
    });
    expect(result.tokens.flatMap((token) => token.parts).map((part) => part.kind)).toEqual(
      expect.arrayContaining([
        "single-quoted",
        "double-quoted",
        "variable-expansion",
        "command-substitution",
        "backtick-substitution",
      ]),
    );
    expect(result.provenance.source.path).toBe("package.json");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tokens)).toBe(true);
    expect(Object.isFrozen(result.invocations[0]?.environment)).toBe(true);
  });

  test("recognizes Windows cmd expansion, caret escaping, executables, and descriptor redirects", () => {
    const result = lexCommandEvidence(
      input("SET X=1 & TOOL.EXE ^& literal %TEMP% !LATE! 2>&1", "windows-cmd"),
    );

    expect(result.invocations.map((entry) => entry.executable)).toEqual(["set", "tool"]);
    expect(result.tokens.flatMap((token) => token.parts).map((part) => part.kind)).toEqual(
      expect.arrayContaining(["escape", "variable-expansion"]),
    );
    expect(result.invocations[1]?.redirections[0]).toMatchObject({ operator: "2>&1" });
    expect(result.uncertainty.state).toBe("conditional");

    const quoted = lexCommandEvidence(input('ECHO "%TEMP%"', "windows-cmd"));
    expect(quoted.tokens[1]?.value).toBeNull();
  });

  test("recognizes PowerShell variables, subexpressions, call operator, quoting, and script names", () => {
    const result = lexCommandEvidence(
      input("& Build.ps1 'fixed' $env:CI $(Get-Date) *> out.log", "windows-powershell"),
    );

    expect(result.invocations[0]).toMatchObject({ executable: "build", state: "dynamic" });
    expect(result.tokens.flatMap((token) => token.parts).map((part) => part.kind)).toEqual(
      expect.arrayContaining(["single-quoted", "variable-expansion", "command-substitution"]),
    );
    expect(result.uncertainty.state).toBe("conditional");

    const escapedQuote = lexCommandEvidence(input('Write-Host "a`"b"', "windows-powershell"));
    expect(escapedQuote.tokens[1]?.value).toBe('a`"b');
  });

  test("infers exclusive dialect markers while preserving inference confidence", () => {
    expect(lexCommandEvidence(input("printf %s $(date)", "auto"))).toMatchObject({
      confidence: { basis: "exclusive-markers", level: "high", score: 0.9 },
      requestedDialect: "auto",
      resolvedDialect: "posix-shell",
    });
    expect(lexCommandEvidence(input("echo %TEMP%", "auto"))).toMatchObject({
      resolvedDialect: "windows-cmd",
    });
    expect(lexCommandEvidence(input("Write-Host $env:CI", "auto"))).toMatchObject({
      resolvedDialect: "windows-powershell",
    });
  });

  test("reports mixed or insufficient auto-dialect evidence without inventing semantics", () => {
    const mixed = lexCommandEvidence(input("echo %TEMP% $(date)", "auto"));
    expect(mixed).toMatchObject({
      confidence: { basis: "mixed-markers", level: "low" },
      resolvedDialect: null,
      uncertainty: { state: "contradiction" },
    });
    expect(mixed.issues[0]?.code).toBe("ambiguous-dialect");

    const unknown = lexCommandEvidence(input("tool build", "auto"));
    expect(unknown).toMatchObject({
      confidence: { basis: "insufficient-markers", level: "low" },
      resolvedDialect: null,
      uncertainty: { state: "unknown" },
    });
  });

  test.each([
    ["echo 'open", "unclosed ' quote"],
    ["echo $(open", "unclosed $() expression"],
    ["echo `open", "unclosed backtick substitution"],
    ["echo \\", "dangling escape"],
  ])("reports malformed POSIX input %s", (text, message) => {
    const result = lexCommandEvidence(input(text));
    expect(result.issues).toEqual([expect.objectContaining({ code: "malformed-syntax", message })]);
    expect(result.uncertainty.state).toBe("unknown");
    expect(result.invocations[0]?.state).toBe("malformed");
  });

  test("keeps UTF-16 and CRLF offsets relative to the exact input", () => {
    const text = "echo 🧪\r\nprintf done";
    const result = lexCommandEvidence(input(text));
    expect(result.tokens.map(({ start, end, raw }) => ({ start, end, raw }))).toEqual([
      { end: 4, raw: "echo", start: 0 },
      { end: 7, raw: "🧪", start: 5 },
      { end: 15, raw: "printf", start: 9 },
      { end: 20, raw: "done", start: 16 },
    ]);
    expect(lexCommandEvidence(input(text))).toEqual(result);
  });

  test("handles quoting and nesting inside command substitutions without interpreting them", () => {
    const result = lexCommandEvidence(input('echo $(printf "a\\"b" $(inner)) `a\\`b`'));
    expect(result.issues).toEqual([]);
    expect(result.tokens[1]?.parts[0]).toMatchObject({ kind: "command-substitution", value: null });
    expect(result.tokens[2]?.parts[0]).toMatchObject({
      kind: "backtick-substitution",
      value: null,
    });
  });

  test("represents redirection-only and leading-operator segments without an executable", () => {
    const result = lexCommandEvidence(input("&& >output"));
    expect(result.invocations).toEqual([
      expect.objectContaining({
        executable: null,
        redirections: [expect.any(Object)],
        state: "empty",
      }),
    ]);
  });

  test("never executes executable-looking text or consults process facilities", () => {
    const marker = vi.fn();
    Object.defineProperty(globalThis, "__commandLexerExecutionMarker", {
      configurable: true,
      value: marker,
    });
    const text =
      "node -e 'globalThis.__commandLexerExecutionMarker()' && curl https://invalid.test";
    const result = lexCommandEvidence(input(text));
    expect(result.invocations.map((entry) => entry.executable)).toEqual(["node", "curl"]);
    expect(marker).not.toHaveBeenCalled();
    Reflect.deleteProperty(globalThis, "__commandLexerExecutionMarker");
  });

  test.each([
    [null, "input must be a non-proxy plain object"],
    [{}, "input.text must be a string"],
    [{ ...input("echo ok"), extra: true }, "input contains an unknown field"],
    [
      { ...input("echo ok"), dialect: "fish" },
      "input.dialect must name a supported command dialect",
    ],
    [
      { ...input("echo ok"), provenance: { ...input("").provenance, sourceKind: "magic" } },
      "input.provenance.sourceKind is invalid",
    ],
  ])("rejects invalid input %#", (value, message) => {
    expect(() => lexCommandEvidence(value)).toThrow(
      expect.objectContaining({
        code: CommandLexerErrorCode.invalidInput,
        message,
      }),
    );
  });

  test("rejects proxies, symbols, accessors, and non-plain options without invoking them", () => {
    const trap = vi.fn();
    expect(() => lexCommandEvidence(new Proxy(input("echo ok"), { ownKeys: trap }))).toThrow(
      CommandLexerError,
    );
    expect(trap).not.toHaveBeenCalled();
    expect(() => lexCommandEvidence({ ...input("echo ok"), [Symbol("hostile")]: true })).toThrow(
      CommandLexerError,
    );
    const hostile = { ...input("echo ok") } as Record<string, unknown>;
    Object.defineProperty(hostile, "text", { get: trap });
    expect(() => lexCommandEvidence(hostile)).toThrow(CommandLexerError);
    expect(trap).not.toHaveBeenCalled();
    expect(() => lexCommandEvidence(input("echo ok"), new Date())).toThrow(
      expect.objectContaining({ code: CommandLexerErrorCode.invalidOptions }),
    );
  });

  test.each([
    ["maximumInputLength", "echo"],
    ["maximumTokens", "a b"],
    ["maximumParts", "a$X"],
    ["maximumInvocations", "a;b"],
    ["maximumNesting", "echo $($(x))"],
  ] as const)("enforces %s", (limitName, text) => {
    const options = { ...COMMAND_LEXER_DEFAULT_LIMITS, [limitName]: 1 };
    expect(() => lexCommandEvidence(input(text), options)).toThrow(
      expect.objectContaining({ code: CommandLexerErrorCode.limitExceeded, limitName }),
    );
  });

  test("enforces the retained issue limit", () => {
    expect(() =>
      lexCommandEvidence(input("echo %TEMP% $(open", "auto"), {
        ...COMMAND_LEXER_DEFAULT_LIMITS,
        maximumIssues: 1,
      }),
    ).toThrow(
      expect.objectContaining({
        code: CommandLexerErrorCode.limitExceeded,
        limitName: "maximumIssues",
      }),
    );
  });

  test("rejects malformed limits and canonical source-range violations", () => {
    expect(() => lexCommandEvidence(input("ok"), { maximumTokens: 0 })).toThrow(
      expect.objectContaining({ code: CommandLexerErrorCode.invalidOptions }),
    );
    const reversed = input("ok");
    const bad = {
      ...reversed,
      provenance: {
        ...reversed.provenance,
        source: {
          ...reversed.provenance.source,
          range: {
            start: { byteOffset: 2, line: 0, utf16Column: 2, utf16Offset: 2 },
            end: { byteOffset: 1, line: 0, utf16Column: 1, utf16Offset: 1 },
          },
        },
      },
    };
    expect(() => lexCommandEvidence(bad)).toThrow(
      expect.objectContaining({ code: CommandLexerErrorCode.invalidInput }),
    );
  });

  test.each([
    [{ ...input("ok"), provenance: { ...input("ok").provenance, factId: null } }, false],
    [{ ...input("ok"), provenance: { ...input("ok").provenance, collectorId: "" } }, true],
    [{ ...input("ok"), provenance: { ...input("ok").provenance, collectorId: "has space" } }, true],
    [
      { ...input("ok"), provenance: { ...input("ok").provenance, collectorId: "x".repeat(513) } },
      true,
    ],
    [
      {
        ...input("ok"),
        provenance: {
          ...input("ok").provenance,
          source: { ...input("ok").provenance.source, path: 42 },
        },
      },
      true,
    ],
    [
      {
        ...input("ok"),
        provenance: {
          ...input("ok").provenance,
          source: { ...input("ok").provenance.source, path: "../outside" },
        },
      },
      true,
    ],
    [
      {
        ...input("ok"),
        provenance: {
          ...input("ok").provenance,
          source: {
            ...input("ok").provenance.source,
            range: {
              ...input("ok").provenance.source.range,
              start: {
                ...input("ok").provenance.source.range.start,
                byteOffset: -1,
              },
            },
          },
        },
      },
      true,
    ],
  ])("validates provenance boundary %#", (value, rejects) => {
    if (rejects) expect(() => lexCommandEvidence(value)).toThrow(CommandLexerError);
    else expect(lexCommandEvidence(value).provenance.factId).toBeNull();
  });
});
