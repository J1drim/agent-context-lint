import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import { describe, expect, test } from "vitest";

import {
  AGENTS_MARKDOWN_MAX_BYTES,
  AgentsMarkdownError,
  AgentsMarkdownErrorCode,
  parseAgentsMarkdown,
  type ParseAgentsMarkdownInput,
} from "../src/index.js";

const encoder = new TextEncoder();

function input(
  text: string,
  overrides: Partial<ParseAgentsMarkdownInput> = {},
): ParseAgentsMarkdownInput {
  return {
    bytes: encoder.encode(text),
    contentStatus: "complete",
    path: canonicalizeRepositoryRelativePath("workspace/AGENTS.md"),
    scopeRoot: canonicalizeRepositoryRelativePath("workspace"),
    ...overrides,
  };
}

describe("D03 AGENTS Markdown syntax adapter", () => {
  test("builds deterministic source, AST, document, and unclassified statements", () => {
    const first = parseAgentsMarkdown(input("# Build\n\nRun tests.\n\n- Keep docs current.\n"));
    const second = parseAgentsMarkdown(input("# Build\n\nRun tests.\n\n- Keep docs current.\n"));

    expect(first).toEqual(second);
    expect(first.formatId).toBe("agents-markdown");
    expect(first.source.path).toBe("workspace/AGENTS.md");
    expect(first.source.parseState.state).toBe("complete");
    expect(first.document.scopeRoot).toBe("workspace");
    expect(first.document.activationRuleIds).toEqual([]);
    expect(first.document.importIds).toEqual([]);
    expect(first.statements.length).toBeGreaterThan(0);
    expect(
      first.statements.every((statement) => statement.classification.state === "unclassified"),
    ).toBe(true);
    expect(first.document.statementIds).toEqual(first.statements.map((statement) => statement.id));
    expect(first.nodes.some((node) => node.kind === "root")).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.statements)).toBe(true);
  });

  test("preserves empty files, BOM metadata, and CRLF line endings", () => {
    const empty = parseAgentsMarkdown(input(""));
    const bom = parseAgentsMarkdown(
      input("ignored", { bytes: encoder.encode("\uFEFF# Title\r\n\r\nBody\r\n") }),
    );

    expect(empty.source.byteLength).toBe(0);
    expect(empty.source.lineEnding).toBe("none");
    expect(empty.statements).toEqual([]);
    expect(bom.source.bom).toBe("utf-8");
    expect(bom.source.lineEnding).toBe("crlf");
    expect(parseAgentsMarkdown(input("one\rtwo\r")).source.lineEnding).toBe("cr");
    expect(parseAgentsMarkdown(input("one\r\ntwo\n")).source.lineEnding).toBe("mixed");
  });

  test("retains CommonMark recovery and valid truncated-prefix evidence", () => {
    const recovered = parseAgentsMarkdown(input("```ts\nconst value = 1;\n"));
    const partial = parseAgentsMarkdown(input("paragraph", { contentStatus: "truncated" }));

    expect(recovered.source.parseState.state).toBe("partial");
    expect(recovered.issues).toEqual([expect.objectContaining({ code: "markdown-recovery" })]);
    expect(partial.decode).toBe("utf8");
    expect(partial.source.parseState).toEqual({
      state: "partial",
      reason: "AGENTS Markdown is a profile-bounded source prefix",
    });
    expect(partial.issues).toEqual([expect.objectContaining({ code: "truncated-input" })]);
  });

  test("reports lossy UTF-8 and profile-bounded partial input", () => {
    const parsed = parseAgentsMarkdown(
      input("ignored", {
        bytes: Uint8Array.of(0x23, 0x20, 0x61, 0x0a, 0xc3),
        contentStatus: "truncated",
      }),
    );

    expect(parsed.decode).toBe("utf8-lossy-replacement");
    expect(parsed.source.text).toContain("�");
    expect(parsed.source.parseState.state).toBe("malformed");
    expect(parsed.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["invalid-utf8", "truncated-input"]),
    );
  });

  test("keeps syntax independent from profile activation and target selection", () => {
    const parsed = parseAgentsMarkdown(input("Apply only to src/**/*.ts."));

    expect(parsed.document.activationRuleIds).toEqual([]);
    expect(parsed.document.scopeRoot).toBe("workspace");
    expect(parsed.statements[0]?.classification).toEqual({ state: "unclassified" });
  });

  test("rejects paths outside the supplied scope and non-canonical paths", () => {
    expect(() =>
      parseAgentsMarkdown(
        input("text", { scopeRoot: canonicalizeRepositoryRelativePath("other") }),
      ),
    ).toThrow(AgentsMarkdownError);
    expect(() =>
      parseAgentsMarkdown({ ...input("text"), path: "../AGENTS.md" } as ParseAgentsMarkdownInput),
    ).toThrow(AgentsMarkdownError);
  });

  test("rejects closed-record violations, accessors, proxies, and exotic byte arrays", () => {
    const withExtra = { ...input("text"), extra: true } as unknown as ParseAgentsMarkdownInput;
    const accessor = Object.defineProperty({}, "bytes", {
      enumerable: true,
      get: () => encoder.encode("text"),
    });
    for (const [key, value] of Object.entries(input("text")))
      if (key !== "bytes") Object.defineProperty(accessor, key, { enumerable: true, value });
    const bytesWithExtra = encoder.encode("text");
    Object.defineProperty(bytesWithExtra, "extra", { enumerable: true, value: true });

    for (const hostile of [
      withExtra,
      accessor as ParseAgentsMarkdownInput,
      new Proxy(input("text"), {}),
      input("text", { bytes: Buffer.from("text") }),
      input("text", { bytes: bytesWithExtra }),
    ])
      expect(() => parseAgentsMarkdown(hostile)).toThrow(AgentsMarkdownError);
  });

  test("enforces the syntax byte ceiling with a typed resource error", () => {
    expect(() =>
      parseAgentsMarkdown(
        input("ignored", { bytes: new Uint8Array(AGENTS_MARKDOWN_MAX_BYTES + 1) }),
      ),
    ).toThrow(expect.objectContaining({ code: AgentsMarkdownErrorCode.resourceLimit }));
  });

  test("rejects malformed status values without invoking the Markdown parser", () => {
    expect(() =>
      parseAgentsMarkdown({ ...input("text"), contentStatus: "unknown" } as never),
    ).toThrow(expect.objectContaining({ code: AgentsMarkdownErrorCode.invalidInput }));
  });

  test("bounds canonical source and scope paths", () => {
    const oversized = "a".repeat(16_385);
    expect(() =>
      parseAgentsMarkdown(
        input("text", {
          path: oversized as ParseAgentsMarkdownInput["path"],
          scopeRoot: oversized as ParseAgentsMarkdownInput["scopeRoot"],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: AgentsMarkdownErrorCode.resourceLimit }));
  });
});
