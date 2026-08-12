import { describe, expect, it } from "vitest";

import { parseGeminiContext, type ParseGeminiContextInput } from "../src/index.js";

const encoder = new TextEncoder();

function input(text: string): ParseGeminiContextInput {
  return {
    bytes: encoder.encode(text),
    contentStatus: "complete",
    path: "docs/GEMINI.md" as never,
    scopeRoot: "docs" as never,
  };
}

describe("parseGeminiContext", () => {
  it("parses Markdown and Gemini imports while excluding backtick regions", () => {
    const result = parseGeminiContext(
      input(
        "# Policy\n\nUse pnpm.\n\n@rules/team.md\n\n`@not-import.md`\n\n```\n@also-not.md\n```",
      ),
    );
    expect(result.formatId).toBe("gemini-context-markdown");
    expect(result.imports.map((entry) => entry.rawSpecifier)).toEqual(["rules/team.md"]);
    expect(result.document.importIds).toEqual(result.imports.map((entry) => entry.id));
    expect(result.statements.some((statement) => statement.text.includes("Use pnpm"))).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("retains malformed UTF-8 as explicit syntax evidence", () => {
    const result = parseGeminiContext({ ...input("ok"), bytes: new Uint8Array([0xff]) });
    expect(result.decode).toBe("utf8-lossy-replacement");
    expect(result.issues.map((entry) => entry.code)).toContain("invalid-utf8");
  });

  it("preserves truncated caller evidence", () => {
    const result = parseGeminiContext({ ...input("partial"), contentStatus: "truncated" });
    expect(result.issues.map((entry) => entry.code)).toContain("truncated-input");
    expect(result.source.parseState.state).toBe("partial");
  });

  it("inherits closed hostile-input and root-containment checks", () => {
    expect(() => parseGeminiContext({ ...input("x"), extra: true } as never)).toThrow();
    expect(() => parseGeminiContext(new Proxy(input("x"), {}))).toThrow();
    expect(() => parseGeminiContext({ ...input("x"), scopeRoot: "other" as never })).toThrow();
  });

  it("does not invoke input accessors", () => {
    let invoked = false;
    const hostile = input("x") as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "bytes", {
      enumerable: true,
      get() {
        invoked = true;
        return encoder.encode("x");
      },
    });
    expect(() => parseGeminiContext(hostile as never)).toThrow();
    expect(invoked).toBe(false);
  });
});
