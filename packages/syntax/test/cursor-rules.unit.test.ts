import { readFileSync } from "node:fs";

import type {
  InstructionDocumentId,
  RepositoryRelativePath,
  SourceDocumentId,
  SourceRange,
} from "@agent-context/core";
import { describe, expect, test, vi } from "vitest";

import {
  CURSOR_RULE_SYNTAX_LIMITS,
  CursorRuleSyntaxError,
  parseCursorRuleSyntax,
} from "../src/index.js";
import type { CursorRuleSyntaxResult } from "../src/index.js";

const SOURCE_ID = "source:cursor-fixture" as SourceDocumentId;
const DOCUMENT_ID = "document:cursor-fixture" as InstructionDocumentId;
const ENCODER = new TextEncoder();

interface MatrixCase {
  readonly alwaysApply: boolean | null;
  readonly canonical: boolean;
  readonly classification: string;
  readonly description: boolean;
  readonly globs: boolean;
  readonly id: string;
  readonly state: string;
}

interface MatrixFixture {
  readonly cases: readonly MatrixCase[];
  readonly recordKind: string;
  readonly schemaVersion: string;
}

interface LegacyCase {
  readonly id: string;
  readonly locationState: string;
  readonly path: string;
  readonly resultState: string;
}

interface LegacyFixture {
  readonly cases: readonly LegacyCase[];
  readonly recordKind: string;
  readonly schemaVersion: string;
}

const matrixFixture = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/v0/cursor-mdc-syntax.fixture.json", import.meta.url),
    "utf8",
  ),
) as MatrixFixture;
const legacyFixture = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/v0/cursor-legacy-syntax.fixture.json", import.meta.url),
    "utf8",
  ),
) as LegacyFixture;

function parse(
  text: string,
  options: {
    readonly format?: "legacy" | "mdc";
    readonly path?: RepositoryRelativePath;
  } = {},
): CursorRuleSyntaxResult {
  return parseCursorRuleSyntax({
    bytes: ENCODER.encode(text),
    documentId: DOCUMENT_ID,
    format: options.format ?? "mdc",
    path: options.path ?? (".cursor/rules/policy.mdc" as RepositoryRelativePath),
    sourceId: SOURCE_ID,
  });
}

function original(text: string, range: SourceRange | null): string | null {
  return range === null ? null : text.slice(range.start.utf16Offset, range.end.utf16Offset);
}

function matrixSource(value: MatrixCase): string {
  const fields: string[] = [];
  if (value.alwaysApply !== null) fields.push(`alwaysApply: ${String(value.alwaysApply)}`);
  if (value.description) fields.push("description: Select this rule");
  if (value.globs) fields.push("globs: '**/*.ts'");
  return ["---", ...fields, "---", "Apply the policy."].join("\n");
}

function expectSyntaxError(operation: () => unknown, code: CursorRuleSyntaxError["code"]): void {
  try {
    operation();
    throw new Error("expected cursor syntax error");
  } catch (error) {
    expect(error).toBeInstanceOf(CursorRuleSyntaxError);
    expect((error as CursorRuleSyntaxError).code).toBe(code);
  }
}

describe("D12 Cursor rule syntax adapters", () => {
  test("keeps canonical fixtures closed and covers the complete documented field matrix", () => {
    expect(Object.keys(matrixFixture).sort()).toEqual(["cases", "recordKind", "schemaVersion"]);
    expect(Array.isArray(matrixFixture.cases)).toBe(true);
    expect(matrixFixture).toMatchObject({
      recordKind: "cursor-mdc-syntax-field-matrix",
      schemaVersion: "0.1.0",
    });
    expect(matrixFixture.cases).toHaveLength(12);

    for (const fixtureCase of matrixFixture.cases) {
      expect(Object.keys(fixtureCase).sort()).toEqual([
        "alwaysApply",
        "canonical",
        "classification",
        "description",
        "globs",
        "id",
        "state",
      ]);
      const result = parse(matrixSource(fixtureCase));
      expect(result.modeSyntax, fixtureCase.id).toMatchObject({
        canonical: fixtureCase.canonical,
        classification: fixtureCase.classification,
        state: fixtureCase.state,
      });
      expect(result.metadataAuthority, fixtureCase.id).toBe("available");
      expect(result.state, fixtureCase.id).toBe(fixtureCase.canonical ? "complete" : "partial");
    }
  });

  test("preserves scalar, top-level comma, brace, bracket, and YAML-list glob encodings", () => {
    const scalar = parse("---\nalwaysApply: false\nglobs: '*.ts'\n---\nBody\n");
    expect(scalar.globs).toMatchObject({
      state: "valid",
      value: { encoding: "scalar", patterns: [{ range: null, value: "*.ts" }] },
    });

    const comma = parse(
      "---\nalwaysApply: false\nglobs: 'src/**/*.{ts,tsx}, tests/file[0,1].ts, docs/**'\n---\nBody\n",
    );
    expect(comma.globs.value).toEqual({
      encoding: "comma-scalar",
      patterns: [
        { range: null, value: "src/**/*.{ts,tsx}" },
        { range: null, value: "tests/file[0,1].ts" },
        { range: null, value: "docs/**" },
      ],
    });

    const listText = [
      "---",
      "alwaysApply: false",
      "globs:",
      "  - 'src/**/*.ts'",
      "  - tests/**/*.tsx",
      "---",
      "Body",
    ].join("\n");
    const list = parse(listText);
    expect(list.globs.value?.encoding).toBe("yaml-list");
    expect(list.globs.value?.patterns.map((value) => value.value)).toEqual([
      "src/**/*.ts",
      "tests/**/*.tsx",
    ]);
    expect(original(listText, list.globs.value?.patterns[0]?.range ?? null)).toBe("'src/**/*.ts'");
    expect(original(listText, list.globs.value?.patterns[1]?.range ?? null)).toBe("tests/**/*.tsx");
  });

  test("preserves exact field, body, source, reference, CRLF, and Unicode locations", () => {
    const text = [
      "---",
      'description: "é😀 @metadata.ts"',
      "alwaysApply: false",
      "---",
      "Use @service-template.ts and `@inline.ts`.",
      "<!-- @comment.ts -->",
      "```ts",
      "@fenced.ts",
      "```",
      String.raw`\@escaped.ts`,
      "tail",
    ].join("\r\n");
    const result = parse(text);

    expect(original(text, result.description.keyRange)).toBe("description");
    expect(original(text, result.description.range)).toBe('"é😀 @metadata.ts"');
    expect(original(text, result.bodyRange)).toContain("Use @service-template.ts");
    expect(result.sourceRange?.end).toMatchObject({
      byteOffset: Buffer.byteLength(text),
      utf16Offset: text.length,
    });
    expect(result.references.map((value) => value.rawSpecifier)).toEqual([
      "service-template.ts",
      "inline.ts`.",
      "comment.ts",
      "fenced.ts",
      "escaped.ts",
    ]);
    expect(result.references.some((value) => value.rawSpecifier === "metadata.ts")).toBe(false);
    for (const reference of result.references) {
      expect(reference.state).toBe("ambiguous");
      expect(reference.uncertainty.state).toBe("unknown");
      expect(reference.range.start.byteOffset).toBe(
        Buffer.byteLength(text.slice(0, reference.range.start.utf16Offset)),
      );
    }
  });

  test("derives root and nested rule locations without resolving activation", () => {
    const root = parse("---\nalwaysApply: true\n---\nBody\n");
    expect(root.location).toEqual({
      path: ".cursor/rules/policy.mdc",
      ruleRoot: ".cursor/rules",
      scopeRoot: ".",
      state: "supported",
    });
    const nested = parse("---\nalwaysApply: false\n---\nBody\n", {
      path: "services/api/.cursor/rules/security/policy.mdc" as RepositoryRelativePath,
    });
    expect(nested.location).toEqual({
      path: "services/api/.cursor/rules/security/policy.mdc",
      ruleRoot: "services/api/.cursor/rules",
      scopeRoot: "services/api",
      state: "supported",
    });

    for (const [path, state] of [
      [".cursor/rules/policy.md", "unsupported"],
      ["policy.mdc", "unsupported"],
      [".cursor/rules/nested/.cursor/rules/policy.mdc", "unknown"],
    ] as const) {
      const result = parse("---\nalwaysApply: true\n---\nBody\n", {
        path: path as RepositoryRelativePath,
      });
      expect(result.location.state).toBe(state);
      expect(result.state).toBe(state === "unknown" ? "partial" : "malformed");
      expect(result.issues.map((value) => value.code)).toContain("invalid-location");
    }
  });

  test("retains empty signals and rejects malformed field values", () => {
    for (const text of [
      "---\nalwaysApply: false\ndescription: ''\nglobs: ''\n---\nBody\n",
      "---\nalwaysApply: false\ndescription:\nglobs:\n---\nBody\n",
    ]) {
      const result = parse(text);
      expect(result.description).toMatchObject({ state: "empty", value: "" });
      expect(result.globs).toMatchObject({ state: "empty", value: null });
      expect(result.modeSyntax.classification).toBe("manual");
      expect(result.state).toBe("partial");
    }

    for (const [label, text] of [
      ["always", "---\nalwaysApply: 'false'\n---\nBody\n"],
      ["description", "---\nalwaysApply: false\ndescription: 7\n---\nBody\n"],
      ["globs object", "---\nalwaysApply: false\nglobs: { key: value }\n---\nBody\n"],
      ["globs item", "---\nalwaysApply: false\nglobs: ['ok', 7]\n---\nBody\n"],
      ["globs empty item", "---\nalwaysApply: false\nglobs: ['ok', ' ']\n---\nBody\n"],
    ] as const) {
      const result = parse(text);
      expect(result.state, label).toBe("malformed");
      expect(result.metadataAuthority, label).toBe("denied");
      expect(result.modeSyntax.classification, label).toBe("malformed");
    }
  });

  test("reports unknown metadata and malformed MDC without inventing authority", () => {
    const unknown = parse("---\nalwaysApply: true\nfutureMode: enabled\n---\nBody\n");
    expect(unknown).toMatchObject({ metadataAuthority: "available", state: "partial" });
    expect(unknown.issues).toContainEqual(
      expect.objectContaining({ code: "unknown-field", field: "futureMode" }),
    );

    for (const [label, text, evidenceId] of [
      ["missing", "Body only\n", "CURSOR-MDC-07"],
      ["unclosed", "---\nalwaysApply: true\nBody\n", "CURSOR-MDC-08"],
      ["duplicate", "---\nalwaysApply: true\nalwaysApply: false\n---\n", "CURSOR-MDC-10"],
      ["alias", "---\nbase: &value true\nalwaysApply: *value\n---\n", "CURSOR-MDC-07"],
      ["tag", "---\nalwaysApply: !!bool true\n---\n", "CURSOR-MDC-07"],
      ["sequence", "---\n- always\n---\n", "CURSOR-MDC-07"],
    ] as const) {
      const result = parse(text);
      expect(result.state, label).toBe("malformed");
      expect(result.metadataAuthority, label).toBe("denied");
      expect(
        result.issues.flatMap((value) => value.evidenceIds),
        label,
      ).toContain(evidenceId);
    }
  });

  test("recognizes legacy syntax and emits read-only migration evidence for every location case", () => {
    expect(Object.keys(legacyFixture).sort()).toEqual(["cases", "recordKind", "schemaVersion"]);
    expect(legacyFixture).toMatchObject({
      recordKind: "cursor-legacy-syntax-cases",
      schemaVersion: "0.1.0",
    });
    for (const fixtureCase of legacyFixture.cases) {
      expect(Object.keys(fixtureCase).sort()).toEqual([
        "id",
        "locationState",
        "path",
        "resultState",
      ]);
      const text = "---\r\nLegacy é😀 @policy.md\r\nfinal";
      const result = parse(text, {
        format: "legacy",
        path: fixtureCase.path as RepositoryRelativePath,
      });
      expect(result.location.state, fixtureCase.id).toBe(fixtureCase.locationState);
      expect(result.state, fixtureCase.id).toBe(fixtureCase.resultState);
      expect(result.modeSyntax).toMatchObject({
        canonical: false,
        classification: "legacy",
        state: "not-applicable",
      });
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "legacy-format",
          evidenceIds: ["CURSOR-SURFACE-01"],
          severity: "warning",
        }),
      );
      expect(result.sourceRange?.end).toMatchObject({
        byteOffset: Buffer.byteLength(text),
        line: 2,
        utf16Column: 5,
        utf16Offset: text.length,
      });
      expect(result.references.map((value) => value.rawSpecifier)).toEqual(["policy.md"]);
    }

    const empty = parse(" \r\n", {
      format: "legacy",
      path: ".cursorrules" as RepositoryRelativePath,
    });
    expect(empty.state).toBe("partial");
    expect(empty.issues.map((value) => value.code)).toContain("empty-body");
  });

  test("fails closed for invalid encoding, BOM, and bounded resources", () => {
    for (const [format, path] of [
      ["mdc", ".cursor/rules/policy.mdc"],
      ["legacy", ".cursorrules"],
    ] as const) {
      for (const bytes of [Uint8Array.from([0xff]), Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])]) {
        const result = parseCursorRuleSyntax({
          bytes,
          documentId: DOCUMENT_ID,
          format,
          path: path as RepositoryRelativePath,
          sourceId: SOURCE_ID,
        });
        expect(result).toMatchObject({ state: "malformed", text: null });
      }
    }

    const nulText = "---\nalwaysApply: true\n---\nBody\0tail\n";
    const nul = parse(nulText);
    const nulIssue = nul.issues.find(
      (value) =>
        value.code === "frontmatter-invalid" && value.evidenceIds.includes("CURSOR-MDC-15"),
    );
    expect(nul).toMatchObject({ metadataAuthority: "denied", state: "malformed" });
    expect(original(nulText, nulIssue?.range ?? null)).toBe("\0");

    const overSource = new Uint8Array(262_145);
    expectSyntaxError(
      () =>
        parseCursorRuleSyntax({
          bytes: overSource,
          documentId: DOCUMENT_ID,
          format: "mdc",
          path: ".cursor/rules/policy.mdc" as RepositoryRelativePath,
          sourceId: SOURCE_ID,
        }),
      "CURSOR_RULE_SYNTAX_RESOURCE_LIMIT",
    );
    const longDescription = parse(
      `---\nalwaysApply: false\ndescription: '${"x".repeat(CURSOR_RULE_SYNTAX_LIMITS.maxDescriptionUtf16CodeUnits + 1)}'\n---\nBody\n`,
    );
    expect(longDescription.description.state).toBe("invalid");
    expect(longDescription.issues.map((value) => value.code)).toContain("resource-limit");

    for (const value of [
      "a,".repeat(CURSOR_RULE_SYNTAX_LIMITS.maxGlobPatterns) + "a",
      "a".repeat(CURSOR_RULE_SYNTAX_LIMITS.maxGlobUtf16CodeUnits + 1),
      "a".repeat(CURSOR_RULE_SYNTAX_LIMITS.maxGlobAggregateUtf16CodeUnits + 1),
      "{".repeat(65),
      "[".repeat(65),
    ]) {
      const result = parse(`---\nalwaysApply: false\nglobs: '${value}'\n---\nBody\n`);
      expect(result.globs.state).toBe("invalid");
      expect(result.issues.map((entry) => entry.code)).toContain("resource-limit");
    }
    const tooManyList = Array.from(
      { length: CURSOR_RULE_SYNTAX_LIMITS.maxGlobPatterns + 1 },
      () => "  - a",
    ).join("\n");
    expect(parse(`---\nalwaysApply: false\nglobs:\n${tooManyList}\n---\nBody`).globs.state).toBe(
      "invalid",
    );

    const tooManyReferences = Array.from({ length: 4_097 }, () => "@a.md").join(" ");
    const referenceLimit = parse(`---\nalwaysApply: true\n---\n${tooManyReferences}`);
    expect(referenceLimit.state).toBe("malformed");
    expect(referenceLimit.issues.map((value) => value.code)).toContain("reference-resource-limit");
  });

  test("rejects hostile containers, accessors, identities, paths, and formats", () => {
    const valid = {
      bytes: ENCODER.encode("---\nalwaysApply: true\n---\nBody"),
      documentId: DOCUMENT_ID,
      format: "mdc",
      path: ".cursor/rules/policy.mdc" as RepositoryRelativePath,
      sourceId: SOURCE_ID,
    };
    for (const input of [
      null,
      [],
      new Proxy(valid, {}),
      Object.create(valid),
      { ...valid, extra: 1 },
    ]) {
      expectSyntaxError(() => parseCursorRuleSyntax(input), "CURSOR_RULE_SYNTAX_INVALID_INPUT");
    }
    const getter = vi.fn(() => ENCODER.encode("Body"));
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessor, {
      bytes: { enumerable: true, get: getter },
      documentId: { enumerable: true, value: DOCUMENT_ID },
      format: { enumerable: true, value: "mdc" },
      path: { enumerable: true, value: ".cursor/rules/policy.mdc" },
      sourceId: { enumerable: true, value: SOURCE_ID },
    });
    expectSyntaxError(() => parseCursorRuleSyntax(accessor), "CURSOR_RULE_SYNTAX_INVALID_INPUT");
    expect(getter).not.toHaveBeenCalled();

    for (const override of [
      { bytes: new Proxy(valid.bytes, {}) },
      { bytes: [] },
      { documentId: "bad id" },
      { sourceId: "bad id" },
      { format: "other" },
      { path: "../escape.mdc" },
      { path: "." },
      { path: `${"a".repeat(16_385)}.mdc` },
    ]) {
      expect(() => parseCursorRuleSyntax({ ...valid, ...override })).toThrow(CursorRuleSyntaxError);
    }
  });

  test("snapshots input and returns deeply immutable deterministic data", () => {
    const bytes = ENCODER.encode("---\nalwaysApply: false\nglobs: ['src/**']\n---\n@policy.md\n");
    const first = parseCursorRuleSyntax({
      bytes,
      documentId: DOCUMENT_ID,
      format: "mdc",
      path: ".cursor/rules/policy.mdc" as RepositoryRelativePath,
      sourceId: SOURCE_ID,
    });
    bytes.fill(0x78);
    const second = parse("---\nalwaysApply: false\nglobs: ['src/**']\n---\n@policy.md\n");
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.issues)).toBe(true);
    expect(Object.isFrozen(first.globs)).toBe(true);
    expect(Object.isFrozen(first.globs.value)).toBe(true);
    expect(Object.isFrozen(first.globs.value?.patterns)).toBe(true);
    expect(Object.isFrozen(first.references)).toBe(true);
    expect(Object.isFrozen(first.modeSyntax.evidenceIds)).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
