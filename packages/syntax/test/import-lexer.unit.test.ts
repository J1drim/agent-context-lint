import { createHash } from "node:crypto";

import { validateInstructionIr } from "@agent-context/core";
import { MarkdownParserError } from "@agent-context/markdown";
import { describe, expect, test, vi } from "vitest";

import type {
  InstructionDocument,
  InstructionDocumentId,
  InstructionIr,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
} from "@agent-context/core";

import {
  DEFAULT_IMPORT_LEXER_LIMITS,
  IMPORT_DIALECTS,
  ImportLexerError,
  lexImportReferences,
} from "../src/index.js";

const SOURCE_ID = "source:c09-imports" as SourceDocumentId;
const DOCUMENT_ID = "document:c09-imports" as InstructionDocumentId;

function lex(
  text: string,
  syntax: (typeof IMPORT_DIALECTS)[number] = "claude-code",
  options?: Parameters<typeof lexImportReferences>[1],
): ReturnType<typeof lexImportReferences> {
  return lexImportReferences(
    { documentId: DOCUMENT_ID, sourceId: SOURCE_ID, syntax, text },
    options,
  );
}

describe("C09 syntax-specific import lexer", () => {
  test("emits deterministic B03 imports with exact Unicode, CRLF, UTF-16, and byte ranges", () => {
    expect(Object.isFrozen(IMPORT_DIALECTS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_IMPORT_LEXER_LIMITS)).toBe(true);
    const text = "😀 preface\r\nUse @docs/policy.md now.\r\n";
    const first = lex(text);
    const second = lex(text);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.imports)).toBe(true);
    expect(first.imports).toHaveLength(1);
    const reference = first.imports[0];
    if (reference === undefined) throw new Error("expected import reference");
    const tokenStart = text.indexOf("@docs/policy.md");
    const tokenEnd = tokenStart + "@docs/policy.md".length;
    expect(reference).toMatchObject({
      documentId: DOCUMENT_ID,
      kind: "vendor-import",
      rawSpecifier: "docs/policy.md",
      state: "recognized",
      targetKind: "repository-path-candidate",
      uncertainty: { state: "known" },
    });
    expect(reference.range.start).toEqual({
      byteOffset: Buffer.byteLength(text.slice(0, tokenStart)),
      utf16Offset: tokenStart,
      line: 1,
      utf16Column: 4,
    });
    expect(reference.range.end).toEqual({
      byteOffset: Buffer.byteLength(text.slice(0, tokenEnd)),
      utf16Offset: tokenEnd,
      line: 1,
      utf16Column: 19,
    });
    expect(reference.specifierRange.start.utf16Offset).toBe(tokenStart + 1);
    expect(
      text.slice(
        reference.specifierRange.start.utf16Offset,
        reference.specifierRange.end.utf16Offset,
      ),
    ).toBe(reference.rawSpecifier);
    expect(first.markdown.nodes.find((node) => node.id === reference.nodeId)?.range).toMatchObject({
      sourceId: SOURCE_ID,
    });
  });

  test("Claude excludes imports in inline code, both fence styles, comments, escapes, and email text", () => {
    const result = lex(
      [
        "Use @docs/plain.md",
        "`@docs/inline.md`",
        "```text",
        "@docs/backtick.md",
        "```",
        "~~~text",
        "@docs/tilde.md",
        "~~~",
        "    @docs/indented.md",
        "<!-- @docs/comment.md -->",
        String.raw`\@docs/escaped.md`,
        "person@example.com",
      ].join("\n"),
    );
    expect(result.imports.map((reference) => reference.rawSpecifier)).toEqual(["docs/plain.md"]);
  });

  test("Gemini follows its pinned whitespace/path grammar and matched-backtick behavior", () => {
    const result = lex(
      [
        "@docs/plain.md",
        "prefix@docs/not-a-token.md",
        "@_unsupported-start.md",
        String.raw`\@docs/escaped.md`,
        "`@docs/inline.md`",
        "```text",
        "@docs/backtick.md",
        "```",
        "~~~text",
        "@docs/tilde.md",
        "~~~",
        "    @docs/indented.md",
        "<!-- @docs/comment.md -->",
      ].join("\n"),
      "gemini-cli",
    );
    expect(result.imports.map((reference) => reference.rawSpecifier)).toEqual([
      "docs/plain.md",
      "docs/tilde.md",
      "docs/indented.md",
      "docs/comment.md",
    ]);
    expect(result.imports[0]).toMatchObject({
      state: "recognized",
      uncertainty: { state: "known" },
    });
    expect(result.imports[1]).toMatchObject({
      state: "ambiguous",
      uncertainty: { state: "contradiction" },
    });
    expect(result.imports[2]).toMatchObject({
      state: "ambiguous",
      uncertainty: { state: "contradiction" },
    });
    expect(result.imports[3]).toMatchObject({
      state: "recognized",
      uncertainty: { state: "known" },
    });
  });

  test("Copilot recognizes documented simple relative references but preserves region and mention ambiguity", () => {
    const result = lex(
      [
        "@docs/plain.md",
        "@ruleName",
        "`@docs/inline.md`",
        "<!-- @docs/comment.md -->",
        "@/absolute/rejected-by-resolver.md",
      ].join("\n"),
      "copilot-cli",
    );
    expect(result.imports).toHaveLength(5);
    expect(result.imports[0]).toMatchObject({
      state: "recognized",
      uncertainty: { state: "known" },
    });
    expect(result.imports[1]).toMatchObject({
      state: "ambiguous",
      uncertainty: { state: "unknown" },
    });
    expect(result.imports[2]).toMatchObject({
      state: "ambiguous",
      uncertainty: { state: "unknown" },
    });
    expect(result.imports[3]).toMatchObject({
      state: "ambiguous",
      uncertainty: { state: "unknown" },
    });
    expect(result.imports[4]).toMatchObject({
      state: "recognized",
      targetKind: "absolute-path-candidate",
    });
  });

  test("Cursor preserves every conservative token as ambiguous, including code, comments, and escaping", () => {
    const result = lex(
      [
        "@service-template.ts",
        "`@inline.ts`,",
        "```",
        "@fenced.ts",
        "```",
        "<!-- @comment.ts -->",
        String.raw`\@escaped.ts`,
      ].join("\n"),
      "cursor-agent",
    );
    expect(result.imports.map((reference) => reference.rawSpecifier)).toEqual([
      "service-template.ts",
      "inline.ts`,",
      "fenced.ts",
      "comment.ts",
      "escaped.ts",
    ]);
    for (const reference of result.imports) {
      expect(reference.kind).toBe("reference-token");
      expect(reference.state).toBe("ambiguous");
      expect(reference.uncertainty.state).toBe("unknown");
    }
  });

  test("classifies lexical target candidates without resolving or reading them", () => {
    const result = lex(
      "@../relative.md @/absolute.md @https://example.com/policy @file.md, @file\u0000tail @file-π.md @C:\\policy.md @~/policy.md @\\\\server\\policy.md @foo@bar",
      "claude-code",
    );
    expect(
      result.imports.map(({ rawSpecifier, state, targetKind }) => ({
        rawSpecifier,
        state,
        targetKind,
      })),
    ).toEqual([
      {
        rawSpecifier: "../relative.md",
        state: "recognized",
        targetKind: "repository-path-candidate",
      },
      { rawSpecifier: "/absolute.md", state: "recognized", targetKind: "absolute-path-candidate" },
      { rawSpecifier: "https://example.com/policy", state: "recognized", targetKind: "url" },
      { rawSpecifier: "file.md,", state: "ambiguous", targetKind: "repository-path-candidate" },
      { rawSpecifier: "file\u0000tail", state: "malformed", targetKind: "malformed" },
      { rawSpecifier: "file-π.md", state: "ambiguous", targetKind: "unknown" },
      {
        rawSpecifier: "C:\\policy.md",
        state: "recognized",
        targetKind: "absolute-path-candidate",
      },
      {
        rawSpecifier: "~/policy.md",
        state: "recognized",
        targetKind: "absolute-path-candidate",
      },
      {
        rawSpecifier: "\\\\server\\policy.md",
        state: "recognized",
        targetKind: "absolute-path-candidate",
      },
      { rawSpecifier: "foo@bar", state: "ambiguous", targetKind: "unknown" },
    ]);
  });

  test("produces imports that validate inside a minimal complete B03 IR", () => {
    const text = "# Rules\n\nRead @docs/policy.md\n";
    const result = lex(text);
    const source: SourceDocument = {
      id: SOURCE_ID,
      path: "CLAUDE.md" as RepositoryRelativePath,
      encoding: "utf-8",
      bom: "none",
      text,
      byteLength: Buffer.byteLength(text),
      utf16Length: text.length,
      sha256: createHash("sha256").update(text).digest("hex"),
      lineEnding: "lf",
      parseState: result.markdown.parseState,
      rootNodeId: result.markdown.rootNodeId,
    };
    const document: InstructionDocument = {
      id: DOCUMENT_ID,
      sourceId: SOURCE_ID,
      formatId: "claude-markdown",
      scopeRoot: "." as RepositoryRelativePath,
      rootNodeId: result.markdown.rootNodeId,
      importIds: result.imports.map((reference) => reference.id),
      statementIds: [],
      activationRuleIds: [],
    };
    const ir: InstructionIr = {
      recordKind: "agent-context-instruction-ir",
      contractVersion: "0.1.0",
      sources: [source],
      documents: [document],
      nodes: result.markdown.nodes,
      imports: result.imports,
      statements: [],
      activationRules: [],
      targets: [],
      events: [],
    };
    expect(validateInstructionIr(ir)).toEqual({ ok: true, value: ir });
  });

  test("enforces exact import and specifier limits without partial output", () => {
    expect(lex("@abcd", "claude-code", { maxSpecifierUtf16CodeUnits: 4 }).imports).toHaveLength(1);
    expect(() => lex("@abcde", "claude-code", { maxSpecifierUtf16CodeUnits: 4 })).toThrow(
      expect.objectContaining({
        code: "IMPORT_LEXER_RESOURCE_LIMIT",
        limitName: "maxSpecifierUtf16CodeUnits",
      }),
    );
    expect(lex("@a.md @b.md", "claude-code", { maxImports: 2 }).imports).toHaveLength(2);
    expect(() => lex("@a.md @b.md @c.md", "claude-code", { maxImports: 2 })).toThrow(
      expect.objectContaining({ code: "IMPORT_LEXER_RESOURCE_LIMIT", limitName: "maxImports" }),
    );
    expect(() => lex("x".repeat(512 * 1024 + 1))).toThrow(
      expect.objectContaining({ code: "MARKDOWN_RESOURCE_LIMIT", limitName: "maxUtf16CodeUnits" }),
    );
  });

  test("rejects hostile API containers, accessors, surrogates, and limit widening", () => {
    for (const input of [null, [], "input", new Proxy({}, {}), Object.create({ inherited: true })])
      expect(() => lexImportReferences(input as never)).toThrow(ImportLexerError);
    const accessor = Object.create(null) as Record<string, unknown>;
    const getter = vi.fn(() => {
      throw new Error("must not execute");
    });
    Object.defineProperty(accessor, "text", {
      enumerable: true,
      get: getter,
    });
    expect(() => lexImportReferences(accessor as never)).toThrow(
      expect.objectContaining({ code: "IMPORT_LEXER_INVALID_INPUT" }),
    );
    expect(getter).not.toHaveBeenCalled();
    const symbolic = {
      documentId: DOCUMENT_ID,
      sourceId: SOURCE_ID,
      syntax: "claude-code",
      text: "@a.md",
      [Symbol("hostile")]: true,
    };
    expect(() => lexImportReferences(symbolic as never)).toThrow(ImportLexerError);
    expect(() =>
      lexImportReferences({
        documentId: "bad id" as InstructionDocumentId,
        sourceId: SOURCE_ID,
        syntax: "claude-code",
        text: "@a.md",
      }),
    ).toThrow(ImportLexerError);
    expect(() =>
      lexImportReferences({
        documentId: DOCUMENT_ID,
        sourceId: SOURCE_ID,
        syntax: "unsupported" as never,
        text: "@a.md",
      }),
    ).toThrow(ImportLexerError);
    expect(() =>
      lexImportReferences({
        documentId: DOCUMENT_ID,
        sourceId: SOURCE_ID,
        syntax: "claude-code",
        text: 1 as never,
      }),
    ).toThrow(ImportLexerError);
    expect(() => lex("\ud800")).toThrow(MarkdownParserError);
    expect(() => lex("@a.md", "claude-code", { maxImports: 0 })).toThrow(
      expect.objectContaining({ code: "IMPORT_LEXER_INVALID_LIMIT", limitName: "maxImports" }),
    );
    expect(() => lex("@a.md", "claude-code", { maxImports: null } as never)).toThrow(
      expect.objectContaining({ code: "IMPORT_LEXER_INVALID_LIMIT", limitName: "maxImports" }),
    );
    expect(() =>
      lex("@a.md", "claude-code", { maxSpecifierUtf16CodeUnits: undefined } as never),
    ).toThrow(
      expect.objectContaining({
        code: "IMPORT_LEXER_INVALID_LIMIT",
        limitName: "maxSpecifierUtf16CodeUnits",
      }),
    );
    expect(() =>
      lex("@a.md", "claude-code", {
        maxImports: DEFAULT_IMPORT_LEXER_LIMITS.maxImports + 1,
      }),
    ).toThrow(expect.objectContaining({ code: "IMPORT_LEXER_INVALID_LIMIT" }));
    expect(() => lex("@a.md", "claude-code", { unknown: true } as never)).toThrow(ImportLexerError);
    const optionGetter = vi.fn(() => {
      throw new Error("must not execute");
    });
    const hostileOptions = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileOptions, "maxImports", {
      enumerable: true,
      get: optionGetter,
    });
    expect(() => lex("@a.md", "claude-code", hostileOptions as never)).toThrow(ImportLexerError);
    expect(optionGetter).not.toHaveBeenCalled();
  });

  test("rejects oversized API records before reading any property descriptor", () => {
    const inputGetter = vi.fn(() => {
      throw new Error("must not execute");
    });
    const oversizedInput = Object.create(null) as Record<string, unknown>;
    oversizedInput["documentId"] = DOCUMENT_ID;
    oversizedInput["sourceId"] = SOURCE_ID;
    oversizedInput["syntax"] = "claude-code";
    Object.defineProperty(oversizedInput, "text", {
      enumerable: true,
      get: inputGetter,
    });
    for (let index = 0; index < 10_000; index += 1)
      oversizedInput[`extra-${String(index)}`] = index;

    const optionsGetter = vi.fn(() => {
      throw new Error("must not execute");
    });
    const oversizedOptions = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(oversizedOptions, "maxImports", {
      enumerable: true,
      get: optionsGetter,
    });
    for (let index = 0; index < 10_000; index += 1)
      oversizedOptions[`extra-${String(index)}`] = index;

    const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    let inputError: unknown;
    let inputDescriptorCalls = 0;
    let optionsError: unknown;
    let optionsDescriptorCalls = 0;
    try {
      Object.getOwnPropertyDescriptor = ((target: object, key: PropertyKey) => {
        if (target === oversizedInput) inputDescriptorCalls += 1;
        if (target === oversizedOptions) optionsDescriptorCalls += 1;
        return originalGetOwnPropertyDescriptor(target, key);
      }) as typeof Object.getOwnPropertyDescriptor;
      try {
        lexImportReferences(oversizedInput as never);
      } catch (error) {
        inputError = error;
      }
      try {
        lex("@a.md", "claude-code", oversizedOptions);
      } catch (error) {
        optionsError = error;
      }
    } finally {
      Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
    }

    expect(inputError).toEqual(expect.objectContaining({ code: "IMPORT_LEXER_INVALID_INPUT" }));
    expect(optionsError).toEqual(expect.objectContaining({ code: "IMPORT_LEXER_INVALID_INPUT" }));
    expect(inputDescriptorCalls).toBe(0);
    expect(optionsDescriptorCalls).toBe(0);
    expect(inputGetter).not.toHaveBeenCalled();
    expect(optionsGetter).not.toHaveBeenCalled();
  });
});
