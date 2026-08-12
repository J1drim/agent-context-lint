import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { INSTRUCTION_IR_CONTRACT_VERSION, validateInstructionIr } from "@agent-context/core";
import type {
  AstNode,
  InstructionIr,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
} from "@agent-context/core";

import {
  DEFAULT_MARKDOWN_EXTRACTION_LIMITS,
  DEFAULT_MARKDOWN_PARSER_LIMITS,
  MARKDOWN_SYNTAX,
  MarkdownParserError,
  extractMarkdownContent,
  parseMarkdown,
} from "../src/index.js";

const SOURCE_ID = "source:test.md" as SourceDocumentId;

function parse(
  text: string,
  options?: Parameters<typeof parseMarkdown>[1],
): ReturnType<typeof parseMarkdown> {
  return parseMarkdown({ sourceId: SOURCE_ID, text }, options);
}

function slice(text: string, node: AstNode): string {
  return text.slice(node.range.start.utf16Offset, node.range.end.utf16Offset);
}

function findNode(nodes: readonly AstNode[], kind: AstNode["kind"]): AstNode {
  const node = nodes.find((candidate) => candidate.kind === kind);
  if (node === undefined) throw new Error(`expected ${kind} node`);
  return node;
}

function expectParserError(
  operation: () => unknown,
  code: MarkdownParserError["code"],
  limitName: MarkdownParserError["limitName"] = null,
): void {
  try {
    operation();
    throw new Error("expected parser error");
  } catch (error) {
    expect(error).toBeInstanceOf(MarkdownParserError);
    expect(error).toMatchObject({ code, limitName });
  }
}

function lineEndingOf(text: string): SourceDocument["lineEnding"] {
  const forms = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      forms.add("crlf");
      index += 1;
    } else if (text[index] === "\r") forms.add("cr");
    else if (text[index] === "\n") forms.add("lf");
  }
  if (forms.size === 0) return "none";
  if (forms.size > 1) return "mixed";
  return [...forms][0] as SourceDocument["lineEnding"];
}

function asIr(text: string, nodes: readonly AstNode[], rootNodeId: AstNode["id"]): InstructionIr {
  return {
    recordKind: "agent-context-instruction-ir",
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    sources: [
      {
        id: SOURCE_ID,
        path: "test.md" as RepositoryRelativePath,
        encoding: "utf-8",
        bom: text.startsWith("\uFEFF") ? "utf-8" : "none",
        text,
        byteLength: Buffer.byteLength(text, "utf8"),
        utf16Length: text.length,
        sha256: createHash("sha256").update(text).digest("hex"),
        lineEnding: lineEndingOf(text),
        parseState: { state: "complete" },
        rootNodeId,
      },
    ],
    documents: [],
    nodes,
    imports: [],
    statements: [],
    activationRules: [],
    targets: [],
    events: [],
  };
}

function expectedPosition(text: string, offset: number): SourcePosition {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      if (index + 1 < offset) {
        line += 1;
        lineStart = index + 2;
        index += 1;
      }
    } else if (text[index] === "\r" || text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return {
    byteOffset: Buffer.byteLength(text.slice(0, offset), "utf8"),
    utf16Offset: offset,
    line,
    utf16Column: offset - lineStart,
  };
}

function expectExactRanges(text: string): void {
  const result = parse(text);
  const bytes = Buffer.from(text, "utf8");
  for (const node of result.nodes) {
    expect(node.range.start).toEqual(expectedPosition(text, node.range.start.utf16Offset));
    expect(node.range.end).toEqual(expectedPosition(text, node.range.end.utf16Offset));
    expect(
      bytes.subarray(node.range.start.byteOffset, node.range.end.byteOffset).toString("utf8"),
    ).toBe(slice(text, node));
  }
}

describe("parseMarkdown", () => {
  test("maps CommonMark block and inline syntax onto the existing B03 AST", () => {
    const text = [
      "# Heading *strong*",
      "",
      '> quoted `code` and [docs](./docs "Title")',
      "",
      "3. first",
      "4. second",
      "",
      "```ts sample",
      "const command = 'never execute me';",
      "```",
      "",
      "<!-- private instruction -->",
      "",
    ].join("\n");
    const result = parse(text);

    expect(result.syntax).toBe(MARKDOWN_SYNTAX);
    expect(result.parseState).toEqual({ state: "complete" });
    expect(result.issues).toEqual([]);
    expect(result.nodes.map((node) => node.kind)).toEqual(
      expect.arrayContaining([
        "root",
        "heading",
        "paragraph",
        "block-quote",
        "inline-code",
        "link",
        "list",
        "list-item",
        "code-block",
        "html-comment",
        "text",
        "unknown",
      ]),
    );
    expect(findNode(result.nodes, "list")).toMatchObject({ ordered: true, start: 3 });
    expect(findNode(result.nodes, "code-block")).toMatchObject({
      language: "ts",
      metadata: "sample",
    });
    expect(findNode(result.nodes, "link")).toMatchObject({
      destination: "./docs",
      title: "Title",
    });
    expect(slice(text, findNode(result.nodes, "html-comment"))).toBe(
      "<!-- private instruction -->",
    );

    const root = result.nodes[0];
    expect(root).toMatchObject({ id: result.rootNodeId, kind: "root" });
    expect(root?.range.start).toEqual({ byteOffset: 0, utf16Offset: 0, line: 0, utf16Column: 0 });
    expect(root?.range.end).toEqual(expectedPosition(text, text.length));
    expect(validateInstructionIr(asIr(text, result.nodes, result.rootNodeId))).toMatchObject({
      ok: true,
    });
  });

  test("derives byte and UTF-16 coordinates from exact LF, CRLF, CR, Unicode, and tab input", () => {
    const text = "\uFEFF# 😀\r\n\r\n\tλ tab\nA `🚀` B\rLast";
    const result = parse(text);
    const rocket = result.nodes.find(
      (node) => node.kind === "inline-code" && slice(text, node) === "`🚀`",
    );
    expect(rocket?.range).toEqual({
      sourceId: SOURCE_ID,
      start: { byteOffset: 23, utf16Offset: 18, line: 3, utf16Column: 2 },
      end: { byteOffset: 29, utf16Offset: 22, line: 3, utf16Column: 6 },
    });
    expect(result.nodes[0]?.range.end.byteOffset).toBe(Buffer.byteLength(text, "utf8"));
    expectExactRanges(text);
    expect(validateInstructionIr(asIr(text, result.nodes, result.rootNodeId))).toMatchObject({
      ok: true,
    });
  });

  test("round-trips every original node slice across deterministic source variants", () => {
    const endings = ["\n", "\r\n", "\r"] as const;
    const contents = ["plain", "😀 astral", "\tindented", "[x](./a)", "<!-- x -->"];
    for (const ending of endings) {
      for (const content of contents) {
        expectExactRanges(`# h${ending}${ending}${content}${ending}`);
      }
    }
    expectExactRanges("a\r\nb\nc\rd");
  });

  test("keeps comments and command-shaped content inert in the appropriate syntax context", () => {
    const text = [
      "<!-- `rm -rf /` --> and text",
      "",
      "```sh",
      "<!-- not a comment node -->",
      "$(touch /tmp/never-created-by-parser)",
      "```",
    ].join("\n");
    const result = parse(text);
    expect(result.nodes.filter((node) => node.kind === "html-comment")).toHaveLength(1);
    const code = findNode(result.nodes, "code-block");
    expect(code.childIds).toEqual([]);
    expect(slice(text, code)).toContain("$(touch /tmp/never-created-by-parser)");
  });

  test("recovers deterministically from unclosed fences and HTML comments", () => {
    const fence = parse("~~~js\r\ncode 😀\r\n");
    expect(fence.parseState).toEqual({
      state: "partial",
      reason: "CommonMark recovery reported 1 issue(s): unclosed-fence",
    });
    expect(fence.issues).toEqual([expect.objectContaining({ code: "unclosed-fence" })]);
    expect(findNode(fence.nodes, "code-block").range.end.utf16Offset).toBe(
      "~~~js\r\ncode 😀\r\n".length,
    );

    const comment = parse("before\n\n<!-- never closed");
    expect(comment.issues).toEqual([expect.objectContaining({ code: "unclosed-html-comment" })]);
    expect(findNode(comment.nodes, "html-comment")).toBeDefined();

    const malformedFence = parse("`` not a fence\ntext\n");
    expect(malformedFence.issues).toEqual([]);
    expect(findNode(malformedFence.nodes, "paragraph")).toBeDefined();
  });

  test("does not report closed fences, including longer and indented closers", () => {
    for (const text of [
      "```\nx\n```",
      "~~~\nx\n ~~~~\n",
      "````\nx\n`````\n",
      "> ```\n> blockquote\n> ```\n",
      "- ```\n  list\n  ```\n",
      "> - ~~~\n>   nested\n>   ~~~~\n",
      "> ~~~\r\n> blockquote CRLF\r\n> ~~~~\r\n",
    ]) {
      expect(parse(text).issues).toEqual([]);
    }
  });

  test("represents a B03-incompatible zero-start ordered list without broadening the contract", () => {
    const result = parse("0. zero\n");
    const list = result.nodes.find((node) => node.kind === "unknown" && node.syntaxKind === "list");
    expect(list).toBeDefined();
    if (list?.kind !== "unknown") throw new Error("expected unknown list node");
    expect(list.reason).toContain("B03");
    expect(validateInstructionIr(asIr("0. zero\n", result.nodes, result.rootNodeId))).toMatchObject(
      {
        ok: true,
      },
    );
  });

  test("produces byte-identical deterministic output and binds IDs to source identity and text", () => {
    const first = parse("# same\n\nbody `x`\n");
    const second = parse("# same\n\nbody `x`\n");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(
      parseMarkdown({
        sourceId: "source:other.md" as SourceDocumentId,
        text: "# same\n\nbody `x`\n",
      }).rootNodeId,
    ).not.toBe(first.rootNodeId);
    expect(parse("# changed\n\nbody `x`\n").rootNodeId).not.toBe(first.rootNodeId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nodes)).toBe(true);
    expect(first.nodes.every((node) => Object.isFrozen(node))).toBe(true);
  });

  test("rejects malformed UTF-16 before byte positions can become ambiguous", () => {
    for (const text of ["high \uD800", "low \uDC00", "reversed \uDC00\uD800"]) {
      expectParserError(() => parse(text), "MARKDOWN_MALFORMED_UNICODE");
    }
    expect(() => parse("paired 😀")).not.toThrow();
  });

  test("enforces UTF-8 byte, UTF-16, node, depth, and issue resource limits", () => {
    expect(() => parse("é", { maxUtf8Bytes: 2 })).not.toThrow();
    expectParserError(
      () => parse("é", { maxUtf8Bytes: 1 }),
      "MARKDOWN_RESOURCE_LIMIT",
      "maxUtf8Bytes",
    );
    expectParserError(
      () => parse("ab", { maxUtf16CodeUnits: 1 }),
      "MARKDOWN_RESOURCE_LIMIT",
      "maxUtf16CodeUnits",
    );
    expectParserError(
      () => parse(`a${"\uD800".repeat(100)}`, { maxUtf16CodeUnits: 1 }),
      "MARKDOWN_RESOURCE_LIMIT",
      "maxUtf16CodeUnits",
    );
    expectParserError(
      () => parse("text *emphasis*", { maxNodes: 3 }),
      "MARKDOWN_RESOURCE_LIMIT",
      "maxNodes",
    );
    expectParserError(
      () => parse("# nested *text*", { maxDepth: 1 }),
      "MARKDOWN_RESOURCE_LIMIT",
      "maxDepth",
    );
    expectParserError(
      () => parse("```\nnot closed", { maxIssues: 1, maxNodes: 1 }),
      "MARKDOWN_RESOURCE_LIMIT",
      "maxNodes",
    );
    expectParserError(
      () => parse("> ```\n> x\n\n> ```\n> y", { maxIssues: 1 }),
      "MARKDOWN_RESOURCE_LIMIT",
      "maxIssues",
    );
  });

  test("rejects invalid option values and unknown option keys", () => {
    for (const maxDepth of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expectParserError(() => parse("", { maxDepth }), "MARKDOWN_INVALID_LIMIT", "maxDepth");
    }
    expectParserError(
      () => parseMarkdown({ sourceId: SOURCE_ID, text: "" }, { unexpected: 1 } as never),
      "MARKDOWN_INVALID_INPUT",
    );
    expect(DEFAULT_MARKDOWN_PARSER_LIMITS).toEqual({
      maxDepth: 128,
      maxDelimiterRun: 4096,
      maxIssues: 64,
      maxNodes: 50_000,
      maxUtf16CodeUnits: 524_288,
      maxUtf8Bytes: 524_288,
    });
    expect(Object.isFrozen(DEFAULT_MARKDOWN_PARSER_LIMITS)).toBe(true);
  });

  test("rejects proxies and accessors without executing hostile ingress", () => {
    const inputGetter = vi.fn(() => "# owned");
    const input = Object.defineProperty({ sourceId: SOURCE_ID }, "text", {
      enumerable: true,
      get: inputGetter,
    });
    expectParserError(() => parseMarkdown(input as never), "MARKDOWN_INVALID_INPUT");
    expect(inputGetter).not.toHaveBeenCalled();

    const optionGetter = vi.fn(() => 1);
    const options = Object.defineProperty({}, "maxDepth", {
      enumerable: true,
      get: optionGetter,
    });
    expectParserError(
      () => parseMarkdown({ sourceId: SOURCE_ID, text: "" }, options),
      "MARKDOWN_INVALID_INPUT",
    );
    expect(optionGetter).not.toHaveBeenCalled();

    const symbolGetter = vi.fn(() => "ignored");
    const symbolInput = Object.defineProperty(
      { sourceId: SOURCE_ID, text: "" },
      Symbol("hostile"),
      {
        get: symbolGetter,
      },
    );
    expectParserError(() => parseMarkdown(symbolInput), "MARKDOWN_INVALID_INPUT");
    expect(symbolGetter).not.toHaveBeenCalled();

    expectParserError(
      () => parseMarkdown(new Proxy({ sourceId: SOURCE_ID, text: "" }, {})),
      "MARKDOWN_INVALID_INPUT",
    );
    expectParserError(
      () => parseMarkdown({ sourceId: SOURCE_ID, text: "" }, new Proxy({}, {})),
      "MARKDOWN_INVALID_INPUT",
    );
    const { proxy, revoke } = Proxy.revocable({ sourceId: SOURCE_ID, text: "" }, {});
    revoke();
    expect(nodeTypes.isProxy(proxy)).toBe(true);
    expectParserError(() => parseMarkdown(proxy), "MARKDOWN_INVALID_INPUT");
  });

  test("rejects malformed source identities and closed-schema input", () => {
    for (const sourceId of ["", "space id", ".leading", "x".repeat(513)]) {
      expectParserError(
        () => parseMarkdown({ sourceId: sourceId as SourceDocumentId, text: "" }),
        "MARKDOWN_INVALID_INPUT",
      );
    }
    expectParserError(
      () => parseMarkdown({ sourceId: SOURCE_ID, text: "", command: "run" } as never),
      "MARKDOWN_INVALID_INPUT",
    );
    expectParserError(
      () => parseMarkdown({ sourceId: SOURCE_ID, text: new String("text") } as never),
      "MARKDOWN_INVALID_INPUT",
    );
  });

  test("rejects a large hostile delimiter corpus before invoking the CommonMark parser", () => {
    const text = `${"[".repeat(20_000)}${"`".repeat(20_000)}${"]".repeat(20_000)}`;
    expectParserError(() => parse(text), "MARKDOWN_RESOURCE_LIMIT", "maxDelimiterRun");
  });
});

describe("extractMarkdownContent", () => {
  test("extracts structural views and exact original slices in source order", () => {
    const text = [
      "# Heading *with emphasis*",
      "",
      'Paragraph with [direct](./direct.md "Direct title") and [full][guide].',
      "",
      "- first instruction",
      "- second `inline` instruction",
      "",
      "```ts sample",
      "const inert = true;",
      "```",
      "",
      '[guide]: ./guide.md "Guide title"',
      "",
    ].join("\n");
    const result = extractMarkdownContent({ sourceId: SOURCE_ID, text });

    expect(result.headings.map((entry) => [entry.depth, entry.original])).toEqual([
      [1, "# Heading *with emphasis*"],
    ]);
    expect(result.statements.map((entry) => [entry.kind, entry.original])).toEqual([
      ["paragraph", 'Paragraph with [direct](./direct.md "Direct title") and [full][guide].'],
      ["list-item", "- first instruction"],
      ["paragraph", "first instruction"],
      ["list-item", "- second `inline` instruction"],
      ["paragraph", "second `inline` instruction"],
    ]);
    expect(result.codeBlocks).toEqual([
      expect.objectContaining({
        kind: "code-block",
        language: "ts",
        metadata: "sample",
        original: "```ts sample\nconst inert = true;\n```",
      }),
    ]);
    expect(result.links).toEqual([
      expect.objectContaining({
        destination: "./direct.md",
        title: "Direct title",
        original: '[direct](./direct.md "Direct title")',
      }),
    ]);
    expect(result.references).toEqual([
      expect.objectContaining({
        role: "use",
        identifier: "guide",
        label: "guide",
        referenceType: "full",
        destination: null,
        title: null,
        original: "[full][guide]",
      }),
      expect.objectContaining({
        role: "definition",
        identifier: "guide",
        label: "guide",
        referenceType: null,
        destination: "./guide.md",
        title: "Guide title",
        original: '[guide]: ./guide.md "Guide title"',
      }),
    ]);

    for (const entries of [
      result.headings,
      result.statements,
      result.codeBlocks,
      result.links,
      result.references,
    ]) {
      for (const entry of entries) {
        expect(entry.original).toBe(
          text.slice(entry.range.start.utf16Offset, entry.range.end.utf16Offset),
        );
        expect(
          result.nodes.some((node) => node.id === entry.nodeId && node.range === entry.range),
        ).toBe(true);
        expect(Object.isFrozen(entry)).toBe(true);
      }
      expect(Object.isFrozen(entries)).toBe(true);
    }
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("retains full, collapsed, and shortcut reference syntax without resolving it", () => {
    const text = [
      "[full text][target] [collapsed][] [shortcut]",
      "",
      "[target]: ./one",
      "[collapsed]: ./two",
      "[shortcut]: ./three",
    ].join("\n");
    const result = extractMarkdownContent({ sourceId: SOURCE_ID, text });

    expect(
      result.references.map(({ role, identifier, referenceType, destination }) => ({
        role,
        identifier,
        referenceType,
        destination,
      })),
    ).toEqual([
      { role: "use", identifier: "target", referenceType: "full", destination: null },
      { role: "use", identifier: "collapsed", referenceType: "collapsed", destination: null },
      { role: "use", identifier: "shortcut", referenceType: "shortcut", destination: null },
      { role: "definition", identifier: "target", referenceType: null, destination: "./one" },
      { role: "definition", identifier: "collapsed", referenceType: null, destination: "./two" },
      { role: "definition", identifier: "shortcut", referenceType: null, destination: "./three" },
    ]);
  });

  test("keeps code and HTML inert and does not invent links or references", () => {
    const text = [
      "```md",
      "[fake](./never) [fake][reference]",
      "```",
      "",
      "<!-- [also fake](./never) -->",
      "",
      "Escaped \\[not a link](./never).",
      "Unresolved [reference][missing].",
    ].join("\n");
    const result = extractMarkdownContent({ sourceId: SOURCE_ID, text });
    expect(result.codeBlocks).toHaveLength(1);
    expect(result.links).toEqual([]);
    expect(result.references).toEqual([]);
  });

  test("inherits deterministic validation, recovery, and resource limits from C06", () => {
    const input = { sourceId: SOURCE_ID, text: "~~~js\r\ncode 😀\r\n" };
    const first = extractMarkdownContent(input);
    const second = extractMarkdownContent(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.parseState.state).toBe("partial");
    expect(first.codeBlocks[0]?.original).toBe(input.text);

    expectParserError(
      () => extractMarkdownContent({ sourceId: SOURCE_ID, text: "ab" }, { maxUtf16CodeUnits: 1 }),
      "MARKDOWN_RESOURCE_LIMIT",
      "maxUtf16CodeUnits",
    );
    expectParserError(
      () => extractMarkdownContent({ sourceId: SOURCE_ID, text: "bad \uD800" }),
      "MARKDOWN_MALFORMED_UNICODE",
    );

    const getter = vi.fn(() => "# hostile");
    const hostile = Object.defineProperty({ sourceId: SOURCE_ID }, "text", {
      enumerable: true,
      get: getter,
    });
    expectParserError(() => extractMarkdownContent(hostile as never), "MARKDOWN_INVALID_INPUT");
    expect(getter).not.toHaveBeenCalled();
  });

  test("preflights cumulative extracted UTF-16 and UTF-8 before creating slices", () => {
    const nested = Array.from(
      { length: 10 },
      (_, depth) => `${"  ".repeat(depth)}- level ${String(depth)} 😀`,
    ).join("\n");
    const baseline = extractMarkdownContent({ sourceId: SOURCE_ID, text: nested });
    const extractedUtf16 = baseline.statements.reduce(
      (total, entry) => total + entry.range.end.utf16Offset - entry.range.start.utf16Offset,
      0,
    );
    const extractedUtf8 = baseline.statements.reduce(
      (total, entry) => total + entry.range.end.byteOffset - entry.range.start.byteOffset,
      0,
    );

    expect(() =>
      extractMarkdownContent(
        { sourceId: SOURCE_ID, text: nested },
        {
          maxExtractedUtf16CodeUnits: extractedUtf16,
          maxExtractedUtf8Bytes: extractedUtf8,
        },
      ),
    ).not.toThrow();
    expectParserError(
      () =>
        extractMarkdownContent(
          { sourceId: SOURCE_ID, text: nested },
          {
            maxExtractedUtf16CodeUnits: extractedUtf16 - 1,
            maxExtractedUtf8Bytes: extractedUtf8,
          },
        ),
      "MARKDOWN_EXTRACTION_RESOURCE_LIMIT",
      "maxExtractedUtf16CodeUnits",
    );
    expectParserError(
      () =>
        extractMarkdownContent(
          { sourceId: SOURCE_ID, text: nested },
          {
            maxExtractedUtf16CodeUnits: extractedUtf16,
            maxExtractedUtf8Bytes: extractedUtf8 - 1,
          },
        ),
      "MARKDOWN_EXTRACTION_RESOURCE_LIMIT",
      "maxExtractedUtf8Bytes",
    );

    const amplified = Array.from(
      { length: 30 },
      (_, depth) => `${"  ".repeat(depth)}- ${depth === 29 ? "x".repeat(150_000) : "nested"}`,
    ).join("\n");
    expectParserError(
      () => extractMarkdownContent({ sourceId: SOURCE_ID, text: amplified }),
      "MARKDOWN_EXTRACTION_RESOURCE_LIMIT",
      "maxExtractedUtf16CodeUnits",
    );
  });

  test("copies exactly one original slice for each emitted extraction", () => {
    const text = "# Heading *with emphasis*\n\nParagraph with `code`.\n\n- list item\n";
    const sliceSpy = vi.spyOn(String.prototype, "slice");
    try {
      parseMarkdown({ sourceId: SOURCE_ID, text });
      const parserSliceCalls = sliceSpy.mock.calls.length;
      sliceSpy.mockClear();

      const result = extractMarkdownContent({ sourceId: SOURCE_ID, text });
      const emittedCount =
        result.headings.length +
        result.statements.length +
        result.codeBlocks.length +
        result.links.length +
        result.references.length;

      expect(sliceSpy.mock.calls.length - parserSliceCalls).toBe(emittedCount);
    } finally {
      sliceSpy.mockRestore();
    }
  });

  test("validates extraction limits without invoking hostile accessors", () => {
    expect(DEFAULT_MARKDOWN_EXTRACTION_LIMITS).toEqual({
      maxExtractedUtf16CodeUnits: 4_194_304,
      maxExtractedUtf8Bytes: 16_777_216,
    });
    expect(Object.isFrozen(DEFAULT_MARKDOWN_EXTRACTION_LIMITS)).toBe(true);

    const getter = vi.fn(() => 1);
    const options = Object.defineProperty({}, "maxExtractedUtf16CodeUnits", {
      enumerable: true,
      get: getter,
    });
    expectParserError(
      () => extractMarkdownContent({ sourceId: SOURCE_ID, text: "# safe" }, options),
      "MARKDOWN_INVALID_INPUT",
    );
    expect(getter).not.toHaveBeenCalled();

    expectParserError(
      () =>
        extractMarkdownContent(
          { sourceId: SOURCE_ID, text: "# safe" },
          { maxExtractedUtf8Bytes: DEFAULT_MARKDOWN_EXTRACTION_LIMITS.maxExtractedUtf8Bytes + 1 },
        ),
      "MARKDOWN_INVALID_LIMIT",
      "maxExtractedUtf8Bytes",
    );
  });

  test("preserves BOM, CRLF, tabs, and Unicode coordinates in extracted slices", () => {
    const text = "\uFEFF# 😀\r\n\r\n- tab\tλ\r\n\r\n[文档](./文档.md)\r\n";
    const result = extractMarkdownContent({ sourceId: SOURCE_ID, text });
    for (const entry of [...result.headings, ...result.statements, ...result.links]) {
      expect(entry.original).toBe(
        text.slice(entry.range.start.utf16Offset, entry.range.end.utf16Offset),
      );
      expect(
        Buffer.from(text, "utf8")
          .subarray(entry.range.start.byteOffset, entry.range.end.byteOffset)
          .toString("utf8"),
      ).toBe(entry.original);
    }
    expect(result.headings[0]?.original).toBe("# 😀");
    expect(result.links[0]?.destination).toBe("./文档.md");
  });
});
