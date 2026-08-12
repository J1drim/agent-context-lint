import type { InstructionDocumentId, SourceDocumentId } from "@agent-context/core";
import { describe, expect, test } from "vitest";

import {
  CLAUDE_INSTRUCTION_MAX_BYTES,
  ClaudeInstructionSyntaxError,
  ClaudeInstructionSyntaxErrorCode,
  parseClaudeInstructionSyntax,
  type ClaudeInstructionSyntaxResult,
} from "../src/index.js";

const encoder = new TextEncoder();
const IDS = {
  documentId: "document:claude:test" as InstructionDocumentId,
  sourceId: "source:claude:test" as SourceDocumentId,
};

function parse(
  text: string,
  format: "memory" | "project-rule" = "memory",
): ClaudeInstructionSyntaxResult {
  return parseClaudeInstructionSyntax({ bytes: encoder.encode(text), format, ...IDS });
}

describe("D05 Claude instruction syntax", () => {
  test("parses memory imports and strips only block HTML comments", () => {
    const result = parse(
      "Keep this.\n<!-- remove me -->\n`<!-- inline literal -->`\n```md\n<!-- fenced literal -->\n```\n@docs/policy.md\n",
    );
    expect(result).toMatchObject({
      format: "memory",
      paths: { state: "absent", value: null },
      scopeAuthority: "not-applicable",
      state: "complete",
    });
    expect(result.imports.map((entry) => entry.rawSpecifier)).toEqual(["docs/policy.md"]);
    expect(result.commentRanges).toHaveLength(1);
    expect(result.transformedBody).not.toContain("remove me");
    expect(result.transformedBody).toContain("inline literal");
    expect(result.transformedBody).toContain("fenced literal");
  });

  test("parses string and list paths while excluding frontmatter from body and imports", () => {
    const list = parse(
      "---\npaths:\n  - src/**/*.ts\n  - test/*.ts\n---\nBody\n@docs/rules.md\n",
      "project-rule",
    );
    expect(list.paths).toMatchObject({ state: "valid", value: ["src/**/*.ts", "test/*.ts"] });
    expect(list.scopeAuthority).toBe("available");
    expect(list.transformedBody).toBe("Body\n@docs/rules.md\n");
    expect(list.imports.map((entry) => entry.rawSpecifier)).toEqual(["docs/rules.md"]);

    expect(parse("---\npaths: '*.md'\n---\nRule\n", "project-rule").paths.value).toEqual(["*.md"]);
  });

  test("keeps an unconditional rule distinct from malformed path authority", () => {
    expect(parse("No frontmatter.\n", "project-rule")).toMatchObject({
      paths: { state: "absent" },
      scopeAuthority: "available",
      state: "complete",
    });
    expect(parse("---\npaths: 42\n---\nRule\n", "project-rule")).toMatchObject({
      paths: { state: "invalid" },
      scopeAuthority: "denied",
      state: "malformed",
    });
    expect(parse("---\npaths: [a, a]\n---\nRule\n", "project-rule").paths.state).toBe("invalid");
  });

  test("retains unknown fields and Markdown recovery as explicit partial evidence", () => {
    const unknown = parse("---\npaths: src/**\npriority: high\n---\nRule\n", "project-rule");
    expect(unknown.state).toBe("partial");
    expect(unknown.issues).toEqual([expect.objectContaining({ code: "unknown-field" })]);
    expect(parse("before\n<!-- unclosed", "memory")).toMatchObject({ state: "partial" });
  });

  test("returns a bounded malformed result for invalid UTF-8", () => {
    const result = parseClaudeInstructionSyntax({
      bytes: new Uint8Array([0xc3, 0x28]),
      format: "memory",
      ...IDS,
    });
    expect(result).toMatchObject({
      bodyRange: null,
      state: "malformed",
      text: null,
      transformedBody: null,
    });
    expect(result.issues).toEqual([expect.objectContaining({ code: "invalid-utf8" })]);
    expect(
      parseClaudeInstructionSyntax({
        bytes: new Uint8Array([0xc3, 0x28]),
        format: "project-rule",
        ...IDS,
      }).scopeAuthority,
    ).toBe("denied");
  });

  test("retains invalid and resource-limited frontmatter without reading it as body", () => {
    const invalid = parse("---\npaths: [\n---\nBody\n", "project-rule");
    expect(invalid).toMatchObject({ scopeAuthority: "denied", state: "malformed" });
    expect(invalid.issues).toEqual([expect.objectContaining({ code: "frontmatter-invalid" })]);

    const oversizedScalar = `---\npaths: ${"a".repeat(65_537)}\n---\nBody\n`;
    const limited = parse(oversizedScalar, "project-rule");
    expect(limited.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "resource-limit" })]),
    );

    const unclosed = parse("---\npaths: src/**\n", "project-rule");
    expect(unclosed).toMatchObject({
      scopeAuthority: "denied",
      state: "malformed",
      transformedBody: "",
    });
    expect(unclosed.bodyRange?.start.utf16Offset).toBe(unclosed.text?.length);
  });

  test("rejects hostile records, typed-array aliases, invalid identifiers, and excess bytes", () => {
    expect(() =>
      parseClaudeInstructionSyntax({ bytes: Buffer.from("x"), format: "memory", ...IDS }),
    ).toThrow(ClaudeInstructionSyntaxError);
    expect(() =>
      parseClaudeInstructionSyntax({ bytes: new Uint8Array(), format: "other", ...IDS }),
    ).toThrow(ClaudeInstructionSyntaxError);
    expect(() =>
      parseClaudeInstructionSyntax({
        bytes: new Uint8Array(),
        documentId: "bad id",
        format: "memory",
        sourceId: IDS.sourceId,
      }),
    ).toThrow(ClaudeInstructionSyntaxError);
    expect(() =>
      parseClaudeInstructionSyntax({
        bytes: new Uint8Array(CLAUDE_INSTRUCTION_MAX_BYTES + 1),
        format: "memory",
        ...IDS,
      }),
    ).toThrow(expect.objectContaining({ code: ClaudeInstructionSyntaxErrorCode.resourceLimit }));
    expect(() => parseClaudeInstructionSyntax(new Proxy({}, {}))).toThrow(
      ClaudeInstructionSyntaxError,
    );
    expect(() =>
      parseClaudeInstructionSyntax({
        bytes: new Uint8Array(),
        extra: true,
        format: "memory",
        ...IDS,
      }),
    ).toThrow(ClaudeInstructionSyntaxError);
    const accessor = { bytes: new Uint8Array(), format: "memory", ...IDS };
    Object.defineProperty(accessor, "format", { enumerable: true, get: () => "memory" });
    expect(() => parseClaudeInstructionSyntax(accessor)).toThrow(ClaudeInstructionSyntaxError);
    const aliased = new Uint8Array([1]);
    Object.defineProperty(aliased, "extra", { enumerable: true, value: true });
    expect(() =>
      parseClaudeInstructionSyntax({ bytes: aliased, format: "memory", ...IDS }),
    ).toThrow(ClaudeInstructionSyntaxError);
  });

  test("is deterministic and does not mutate caller bytes", () => {
    const bytes = encoder.encode("@docs/policy.md\n");
    const before = Uint8Array.from(bytes);
    const input = { bytes, format: "memory" as const, ...IDS };
    expect(parseClaudeInstructionSyntax(input)).toEqual(parseClaudeInstructionSyntax(input));
    expect(bytes).toEqual(before);
    expect(Object.isFrozen(parseClaudeInstructionSyntax(input))).toBe(true);
  });
});
