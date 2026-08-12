import type { InstructionDocumentId, SourceDocumentId } from "@agent-context/core";
import { describe, expect, test, vi } from "vitest";

import { CopilotInstructionSyntaxError, parseCopilotInstructionSyntax } from "../src/index.js";
import type { CopilotInstructionSyntaxResult } from "../src/index.js";

const SOURCE_ID = "source:copilot-fixture" as SourceDocumentId;
const DOCUMENT_ID = "document:copilot-fixture" as InstructionDocumentId;
const ENCODER = new TextEncoder();

function parse(
  text: string,
  format: "path-specific" | "repository-wide" = "path-specific",
): CopilotInstructionSyntaxResult {
  return parseCopilotInstructionSyntax({
    bytes: ENCODER.encode(text),
    documentId: DOCUMENT_ID,
    format,
    sourceId: SOURCE_ID,
  });
}

describe("D07 Copilot instruction syntax", () => {
  test("parses path metadata, top-level comma lists, braces, and hosted exclusions", () => {
    const result = parse(
      [
        "---",
        'name: "TypeScript policy"',
        'description: "Applies to implementation and tests"',
        'applyTo: "src/**/*.{ts,tsx}, tests/file[0,1].ts, tests/**/*.ts"',
        'excludeAgent: "code-review"',
        "---",
        "Use the repository formatter.",
        "@docs/not-expanded.md",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      applyTo: {
        state: "valid",
        value: ["src/**/*.{ts,tsx}", "tests/file[0,1].ts", "tests/**/*.ts"],
      },
      description: { state: "valid", value: "Applies to implementation and tests" },
      excludeAgent: { state: "valid", value: "code-review" },
      format: "path-specific",
      imports: [],
      name: { state: "valid", value: "TypeScript policy" },
      referenceSupport: "unsupported-in-path-specific",
      scopeAuthority: "available",
      state: "complete",
    });
    expect(result.applyTo.range?.sourceId).toBe(SOURCE_ID);
    expect(result.bodyRange?.sourceId).toBe(SOURCE_ID);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.applyTo.value)).toBe(true);
  });

  test("preserves repository-wide relative reference candidates for profile resolution", () => {
    const result = parse(
      "Use the shared policy.\n@docs/policy.md\n`@docs/ambiguous.md`\n",
      "repository-wide",
    );

    expect(result.scopeAuthority).toBe("not-applicable");
    expect(result.referenceSupport).toBe("profile-dependent-repository-reference");
    expect(result.imports.map((reference) => reference.rawSpecifier)).toEqual([
      "docs/policy.md",
      "docs/ambiguous.md`",
    ]);
    expect(result.imports.map((reference) => reference.state)).toEqual(["recognized", "ambiguous"]);
    expect(result.state).toBe("complete");

    const thematicBreak = parse(
      "---\nThis is ordinary repository-wide Markdown.\n",
      "repository-wide",
    );
    expect(thematicBreak).toMatchObject({
      issues: [],
      scopeAuthority: "not-applicable",
      state: "complete",
    });
    expect(thematicBreak.bodyRange?.start.utf16Offset).toBe(0);
    expect(thematicBreak.bodyRange?.end.utf16Offset).toBe(thematicBreak.text?.length);

    const recovered = parse("~~~js\nconst incomplete = true;\n", "repository-wide");
    expect(recovered).toMatchObject({
      issues: [expect.objectContaining({ code: "markdown-partial", field: null })],
      scopeAuthority: "not-applicable",
      state: "partial",
    });
    expect(recovered.bodyRange?.sourceId).toBe(SOURCE_ID);
  });

  test("denies path scope authority when applyTo is missing, invalid, or empty", () => {
    const missing = parse("---\ndescription: manual only\n---\nBody\n");
    expect(missing).toMatchObject({
      applyTo: { state: "absent", value: null },
      scopeAuthority: "denied",
      state: "partial",
    });
    expect(missing.issues.map((value) => value.code)).toEqual(["missing-apply-to"]);

    const wrongType = parse("---\napplyTo:\n  - '**/*.ts'\n---\nBody\n");
    expect(wrongType.applyTo.state).toBe("invalid");
    expect(wrongType.scopeAuthority).toBe("denied");
    expect(wrongType.issues.map((value) => value.code)).toContain("invalid-field-type");

    const empty = parse("---\napplyTo: 'src/**,'\n---\nBody\n");
    expect(empty.applyTo.state).toBe("invalid");
    expect(empty.issues.map((value) => value.code)).toContain("empty-apply-to-pattern");

    const emptyScalar = parse("---\napplyTo: ''\n---\nBody\n");
    expect(emptyScalar.applyTo.state).toBe("invalid");
    expect(emptyScalar.issues.map((value) => value.code)).toContain("empty-apply-to-pattern");
  });

  test("retains unknown keys and malformed frontmatter as explicit non-authority", () => {
    const unknown = parse("---\napplyTo: '**/*.ts'\nunknown: true\n---\nBody\n");
    expect(unknown.scopeAuthority).toBe("available");
    expect(unknown.state).toBe("partial");
    expect(unknown.issues).toEqual([
      expect.objectContaining({ code: "unknown-field", field: "unknown" }),
    ]);

    const malformed = parse("---\napplyTo: [\n---\nBody\n");
    expect(malformed.state).toBe("malformed");
    expect(malformed.scopeAuthority).toBe("denied");
    expect(malformed.issues.map((value) => value.code)).toContain("frontmatter-invalid");
  });

  test.each([
    ["duplicate key", "---\napplyTo: '**'\napplyTo: 'src/**'\n---\nBody\n"],
    ["alias", "---\nbase: &scope '**'\napplyTo: *scope\n---\nBody\n"],
    ["tag", "---\napplyTo: !custom '**'\n---\nBody\n"],
  ])("denies %s YAML graph or ambiguity features", (_name, text) => {
    const result = parse(text);
    expect(result.state).toBe("malformed");
    expect(result.scopeAuthority).toBe("denied");
    expect(result.issues.map((value) => value.code)).toContain("frontmatter-invalid");
  });

  test("rejects invalid UTF-8 without decoding or inventing source ranges", () => {
    const result = parseCopilotInstructionSyntax({
      bytes: Uint8Array.from([0xff]),
      documentId: DOCUMENT_ID,
      format: "path-specific",
      sourceId: SOURCE_ID,
    });
    expect(result).toMatchObject({
      bodyRange: null,
      scopeAuthority: "denied",
      state: "malformed",
      text: null,
    });
    expect(result.issues.map((value) => value.code)).toContain("frontmatter-invalid");
    expect(result.issues.every((value) => value.range === null)).toBe(true);
  });

  test("rejects invalid exclusion/name/description fields without reflecting their values", () => {
    const result = parse(
      [
        "---",
        "applyTo: '**'",
        "excludeAgent: local-chat",
        "name: 7",
        "description: false",
        "---",
        "Body",
      ].join("\n"),
    );
    expect(result.scopeAuthority).toBe("available");
    expect(result.excludeAgent.state).toBe("invalid");
    expect(result.name.state).toBe("invalid");
    expect(result.description.state).toBe("invalid");
    expect(result.issues).toHaveLength(3);
    expect(JSON.stringify(result.issues)).not.toContain("local-chat");

    const bounded = parse(
      `---\napplyTo: '**'\nexcludeAgent: cloud-agent\nname: ''\ndescription: '${"x".repeat(4_097)}'\n---\nBody\n`,
    );
    expect(bounded.excludeAgent).toMatchObject({ state: "valid", value: "cloud-agent" });
    expect(bounded.name.state).toBe("invalid");
    expect(bounded.description.state).toBe("invalid");
  });

  test("enforces pattern count, length, and source limits before broadening scope", () => {
    const tooMany = Array.from({ length: 1_025 }, () => "a").join(",");
    const countResult = parse(`---\napplyTo: '${tooMany}'\n---\nBody\n`);
    expect(countResult.applyTo.state).toBe("invalid");
    expect(countResult.issues.map((value) => value.code)).toContain("resource-limit");

    const longPattern = "a".repeat(4_097);
    const lengthResult = parse(`---\napplyTo: '${longPattern}'\n---\nBody\n`);
    expect(lengthResult.applyTo.state).toBe("invalid");
    expect(lengthResult.scopeAuthority).toBe("denied");

    const aggregateResult = parse(`---\napplyTo: '${"a".repeat(32_769)}'\n---\nBody\n`);
    expect(aggregateResult.applyTo.state).toBe("invalid");
    expect(aggregateResult.issues.map((value) => value.code)).toContain("resource-limit");

    for (const nested of ["{".repeat(65), "[".repeat(65)]) {
      const nestingResult = parse(`---\napplyTo: '${nested}'\n---\nBody\n`);
      expect(nestingResult.applyTo.state).toBe("invalid");
      expect(nestingResult.issues.map((value) => value.code)).toContain("resource-limit");
    }

    const oversized = parse("x".repeat(262_145), "repository-wide");
    expect(oversized.state).toBe("malformed");
    expect(oversized.issues.map((value) => value.code)).toContain("resource-limit");
    expect(oversized.text).toBeNull();
  });

  test("fails closed on proxies, inherited records, accessors, and invalid identities", () => {
    const valid = {
      bytes: ENCODER.encode("Body"),
      documentId: DOCUMENT_ID,
      format: "repository-wide",
      sourceId: SOURCE_ID,
    };
    for (const value of [null, [], new Proxy(valid, {}), Object.create(valid)]) {
      expect(() => parseCopilotInstructionSyntax(value)).toThrow(CopilotInstructionSyntaxError);
    }
    const getter = vi.fn(() => {
      throw new Error("must not execute");
    });
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "bytes", { enumerable: true, get: getter });
    Object.defineProperties(accessor, {
      documentId: { enumerable: true, value: DOCUMENT_ID },
      format: { enumerable: true, value: "repository-wide" },
      sourceId: { enumerable: true, value: SOURCE_ID },
    });
    expect(() => parseCopilotInstructionSyntax(accessor)).toThrow(CopilotInstructionSyntaxError);
    expect(getter).not.toHaveBeenCalled();

    expect(() =>
      parseCopilotInstructionSyntax({ ...valid, sourceId: "bad id" as SourceDocumentId }),
    ).toThrow(CopilotInstructionSyntaxError);
    expect(() => parseCopilotInstructionSyntax({ ...valid, extra: true })).toThrow(
      CopilotInstructionSyntaxError,
    );

    expect(() => parseCopilotInstructionSyntax({ ...valid, format: "unsupported" })).toThrow(
      CopilotInstructionSyntaxError,
    );
    expect(() => parseCopilotInstructionSyntax({ ...valid, bytes: "Body" })).toThrow(
      CopilotInstructionSyntaxError,
    );

    const symbolInput = Object.create(null) as Record<PropertyKey, unknown>;
    Object.assign(symbolInput, {
      bytes: valid.bytes,
      documentId: DOCUMENT_ID,
      format: "repository-wide",
    });
    Object.defineProperty(symbolInput, Symbol("sourceId"), {
      enumerable: true,
      value: SOURCE_ID,
    });
    expect(() => parseCopilotInstructionSyntax(symbolInput)).toThrow(CopilotInstructionSyntaxError);
  });

  test("is byte-identical across repeated parsing and does not mutate caller bytes", () => {
    const bytes = ENCODER.encode("---\napplyTo: '**/*.ts'\n---\nBody\n");
    const before = Uint8Array.from(bytes);
    const input = {
      bytes,
      documentId: DOCUMENT_ID,
      format: "path-specific" as const,
      sourceId: SOURCE_ID,
    };
    const expected = JSON.stringify(parseCopilotInstructionSyntax(input));
    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(parseCopilotInstructionSyntax(input))).toBe(expected);
    }
    expect(bytes).toEqual(before);
  });
});
