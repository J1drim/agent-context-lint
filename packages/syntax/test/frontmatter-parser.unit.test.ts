import { describe, expect, test } from "vitest";

import type { SourceDocumentId, SourceRange } from "@agent-context/core";

import {
  DEFAULT_FRONTMATTER_LIMITS,
  FrontmatterParserError,
  parseFrontmatter,
} from "../src/index.js";
import type { FrontmatterParseResult } from "../src/index.js";

const SOURCE_ID = "source:frontmatter" as SourceDocumentId;
const ENCODER = new TextEncoder();

function parse(
  text: string,
  dialect: "mdc" | "yaml" = "yaml",
  options?: Parameters<typeof parseFrontmatter>[1],
): FrontmatterParseResult {
  return parseFrontmatter({ bytes: ENCODER.encode(text), dialect, sourceId: SOURCE_ID }, options);
}

function original(text: string, range: SourceRange | null): string | null {
  return range === null ? null : text.slice(range.start.utf16Offset, range.end.utf16Offset);
}

function expectParserError(operation: () => unknown, code: FrontmatterParserError["code"]): void {
  try {
    operation();
    throw new Error("expected parser error");
  } catch (error) {
    expect(error).toBeInstanceOf(FrontmatterParserError);
    expect((error as FrontmatterParserError).code).toBe(code);
  }
}

describe("C07 defensive YAML/MDC frontmatter parser", () => {
  test.each(["yaml", "mdc"] as const)(
    "parses closed %s metadata into immutable JSON data",
    (dialect) => {
      const text = [
        "---",
        'description: "safe"',
        "globs:",
        "  - src/**",
        "alwaysApply: false",
        'nested: { count: 2, enabled: true, missing: null, "a/b~c": value }',
        "---",
        "# Body",
        "",
      ].join("\n");
      const parsed = parse(text, dialect);

      expect(parsed).toMatchObject({
        contractVersion: "0.1.0",
        dialect,
        issues: [],
        scopeAuthority: "available",
        sourceId: SOURCE_ID,
        state: "valid",
        value: {
          alwaysApply: false,
          description: "safe",
          globs: ["src/**"],
          nested: { count: 2, enabled: true, missing: null, "a/b~c": "value" },
        },
      });
      expect(original(text, parsed.frontmatterRange)).toBe(text.slice(0, text.indexOf("# Body")));
      expect(original(text, parsed.contentRange)).toContain('description: "safe"');
      expect(original(text, parsed.bodyRange)).toBe("# Body\n");
      expect(parsed.locations.map((entry) => entry.path)).toContain("$/nested/a~1b~0c");
      expect(
        original(
          text,
          parsed.locations.find((entry) => entry.path === "$/description")?.keyRange ?? null,
        ),
      ).toBe("description");
      expect(Object.getPrototypeOf(parsed.value)).toBeNull();
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.value)).toBe(true);
      expect(Object.isFrozen(parsed.value?.["nested"])).toBe(true);
      expect(Object.isFrozen(parsed.value?.["globs"])).toBe(true);
    },
  );

  test("preserves exact CRLF/Unicode byte and UTF-16 positions", () => {
    const text = '---\r\ndescription: "é😀"\r\n---\r\nbody\r\n';
    const parsed = parse(text, "mdc");
    const location = parsed.locations.find((entry) => entry.path === "$/description");
    expect(original(text, location?.valueRange ?? null)).toBe('"é😀"');
    expect(location?.valueRange).toMatchObject({
      start: { line: 1, utf16Column: 13, utf16Offset: 18 },
      end: { line: 1, utf16Column: 18, utf16Offset: 23 },
    });
    expect(location?.valueRange.start.byteOffset).toBe(Buffer.byteLength(text.slice(0, 18)));
    expect(location?.valueRange.end.byteOffset).toBe(Buffer.byteLength(text.slice(0, 23)));
    expect(original(text, parsed.bodyRange)).toBe("body\r\n");
  });

  test("tracks CR-only lines without host newline normalization", () => {
    const text = "---\rvalue: true\r---\rbody";
    const parsed = parse(text);
    const location = parsed.locations.find((entry) => entry.path === "$/value");
    expect(location?.valueRange.start).toMatchObject({ line: 1, utf16Column: 7 });
    expect(original(text, parsed.bodyRange)).toBe("body");
  });

  test("treats missing delimiters as absent metadata without inventing scope", () => {
    const text = "# Heading\n--- suffix\n";
    const parsed = parse(text);
    expect(parsed).toMatchObject({
      bodyRange: { start: { utf16Offset: 0 }, end: { utf16Offset: text.length } },
      contentRange: null,
      frontmatterRange: null,
      issues: [],
      scopeAuthority: "absent",
      state: "absent",
      value: null,
    });
  });

  test("accepts an empty closed mapping while leaving vendor-required fields to adapters", () => {
    const parsed = parse("---\n# comment\n---\nbody");
    expect(parsed.state).toBe("valid");
    expect(parsed.value).toEqual({});
    expect(Object.getPrototypeOf(parsed.value)).toBeNull();
  });

  test("denies scope authority for an unclosed opening envelope", () => {
    const text = "---\nalwaysApply: true\nbody";
    const parsed = parse(text);
    expect(parsed).toMatchObject({
      bodyRange: { start: { utf16Offset: text.length }, end: { utf16Offset: text.length } },
      issues: [{ code: "unclosed-frontmatter" }],
      scopeAuthority: "denied",
      state: "invalid",
      value: null,
    });
  });

  test.each([
    ["duplicate key", "---\nglobs: one\nglobs: two\n---\n", "duplicate-key"],
    ["malformed flow", "---\nglobs: [\n---\n", "invalid-yaml"],
    ["sequence root", "---\n- always\n---\n", "invalid-root"],
    ["scalar root", "---\nalways\n---\n", "invalid-root"],
    ["directive", "---\n%YAML 1.2\nvalue: yes\n---\n", "invalid-yaml"],
    ["NUL scalar", "---\nvalue: a\0b\n---\n", "invalid-yaml"],
    ["complex key", "---\n? [one, two]\n: value\n---\n", "invalid-yaml"],
    ["multiple documents", "---\nvalue: one\n...\nother: two\n---\n", "invalid-yaml"],
    ["unresolved explicit tag", "---\nvalue: !unknown safe\n---\n", "invalid-yaml"],
  ] as const)("rejects %s without exposing a value", (_name, text, code) => {
    const parsed = parse(text);
    expect(parsed.state).toBe("invalid");
    expect(parsed.scopeAuthority).toBe("denied");
    expect(parsed.value).toBeNull();
    expect(parsed.issues.map((entry) => entry.code)).toContain(code);
    expect(parsed.issues[0]?.range?.sourceId).toBe(SOURCE_ID);
  });

  test.each([
    ["anchor", "---\nvalue: &shared safe\n---\n", "alias-forbidden"],
    ["alias", "---\nbase: &base [one]\ncopy: *base\n---\n", "alias-forbidden"],
    ["tag", "---\nvalue: !!str safe\n---\n", "tag-forbidden"],
  ] as const)("rejects YAML %s graph capability", (_name, text, code) => {
    const parsed = parse(text);
    expect(parsed).toMatchObject({ state: "invalid", scopeAuthority: "denied", value: null });
    expect(parsed.issues.map((entry) => entry.code)).toContain(code);
  });

  test("rejects an alias amplification graph before native conversion", () => {
    const aliases = Array.from({ length: 200 }, (_, index) => `copy${String(index)}: *base`).join(
      "\n",
    );
    const parsed = parse(`---\nbase: &base [one, two, three]\n${aliases}\n---\n`);
    expect(parsed.state).toBe("invalid");
    expect(parsed.issues.some((entry) => entry.code === "alias-forbidden")).toBe(true);
    expect(parsed.value).toBeNull();
  });

  test("caps structural diagnostics without granting partial authority", () => {
    const parsed = parse("---\none: &one tagged\ntwo: !!str tagged\n---\n", "yaml", {
      maxIssues: 1,
    });
    expect(parsed.issues).toHaveLength(1);
    expect(parsed).toMatchObject({ scopeAuthority: "denied", state: "invalid", value: null });
  });

  test.each([
    ["depth", "---\nroot:\n  child:\n    grandchild: value\n---\n", { maxDepth: 2 }],
    ["nodes", "---\na: 1\nb: 2\nc: 3\n---\n", { maxNodes: 2 }],
    ["sequence nodes", "---\nitems: [1, 2, 3]\n---\n", { maxNodes: 4 }],
    ["entries", "---\na: 1\nb: 2\n---\n", { maxCollectionEntries: 1 }],
    ["sequence entries", "---\nitems: [1, 2, 3]\n---\n", { maxCollectionEntries: 2 }],
    ["scalar", "---\nvalue: oversized\n---\n", { maxScalarBytes: 4 }],
  ] as const)("enforces the configured %s resource bound", (_name, text, options) => {
    const parsed = parse(text, "yaml", options);
    expect(parsed).toMatchObject({ scopeAuthority: "denied", state: "invalid", value: null });
    expect(parsed.issues.some((entry) => entry.code === "resource-limit")).toBe(true);
  });

  test("preflights source bytes before copying or parsing", () => {
    const parsed = parse("---\nvalue: safe\n---\n", "yaml", { maxSourceBytes: 8 });
    expect(parsed).toMatchObject({
      issues: [{ code: "resource-limit", range: null }],
      state: "invalid",
      text: null,
    });

    const absoluteOversize = new Uint8Array(DEFAULT_FRONTMATTER_LIMITS.maxSourceBytes + 1);
    const absolute = parseFrontmatter({
      bytes: absoluteOversize,
      dialect: "yaml",
      sourceId: SOURCE_ID,
    });
    expect(absolute).toMatchObject({ issues: [{ code: "resource-limit" }], text: null });
  });

  test.each([
    ["malformed UTF-8", Uint8Array.from([0x2d, 0x2d, 0x2d, 0x0a, 0xc3, 0x28]), "invalid-encoding"],
    ["UTF-8 BOM", Uint8Array.from([0xef, 0xbb, 0xbf, 0x2d, 0x2d, 0x2d]), "bom-forbidden"],
  ] as const)("rejects %s without fabricated coordinates", (_name, bytes, code) => {
    const parsed = parseFrontmatter({ bytes, dialect: "mdc", sourceId: SOURCE_ID });
    expect(parsed).toMatchObject({
      issues: [{ code, range: null }],
      scopeAuthority: "denied",
      state: "invalid",
      text: null,
    });
  });

  test.each([".inf", "-.inf", ".nan", "-0", "9007199254740993"])(
    "rejects non-JSON or precision-unsafe numeric scalar %s",
    (scalar) => {
      const parsed = parse(`---\nvalue: ${scalar}\n---\n`);
      expect(parsed).toMatchObject({
        issues: [{ code: "invalid-value" }],
        state: "invalid",
        value: null,
      });
    },
  );

  test("uses null-prototype records for prototype-shaped keys", () => {
    const parsed = parse("---\n__proto__: safe\nconstructor: inert\n---\n");
    expect(parsed.state).toBe("valid");
    expect(Object.getPrototypeOf(parsed.value)).toBeNull();
    expect(parsed.value?.["__proto__"]).toBe("safe");
    expect(parsed.value?.["constructor"]).toBe("inert");
    expect(({} as Record<string, unknown>)["safe"]).toBeUndefined();
  });

  test.each([
    null,
    [],
    { maxDepth: 0 },
    { maxDepth: DEFAULT_FRONTMATTER_LIMITS.maxDepth + 1 },
    { maxIssues: 1.5 },
    { unknown: 1 },
  ])("rejects hostile or malformed options %#", (options) => {
    expectParserError(
      () =>
        parseFrontmatter(
          { bytes: new Uint8Array(), dialect: "yaml", sourceId: SOURCE_ID },
          options as never,
        ),
      options === null || Array.isArray(options) || "unknown" in (options as object)
        ? "FRONTMATTER_INVALID_INPUT"
        : "FRONTMATTER_INVALID_LIMIT",
    );
  });

  test("rejects accessors and proxies without invoking traps", () => {
    let traps = 0;
    const accessor = Object.defineProperty({}, "maxDepth", {
      get(): number {
        traps += 1;
        return 1;
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys(): never {
          traps += 1;
          throw new Error("must not inspect proxy");
        },
      },
    );
    for (const options of [accessor, proxy]) {
      expectParserError(
        () =>
          parseFrontmatter(
            { bytes: new Uint8Array(), dialect: "yaml", sourceId: SOURCE_ID },
            options,
          ),
        "FRONTMATTER_INVALID_INPUT",
      );
    }
    expect(traps).toBe(0);
  });

  test("rejects hostile input containers and snapshots mutable bytes", () => {
    expectParserError(
      () => parseFrontmatter(new Proxy({}, {}) as never),
      "FRONTMATTER_INVALID_INPUT",
    );
    expectParserError(
      () => parseFrontmatter({ bytes: [], dialect: "yaml", sourceId: SOURCE_ID } as never),
      "FRONTMATTER_INVALID_INPUT",
    );
    expectParserError(
      () =>
        parseFrontmatter({
          bytes: new Uint8Array(),
          dialect: "yaml",
          sourceId: "not stable?",
        } as never),
      "FRONTMATTER_INVALID_INPUT",
    );
    expectParserError(() => parseFrontmatter(new Date() as never), "FRONTMATTER_INVALID_INPUT");
    expectParserError(
      () =>
        parseFrontmatter({
          bytes: new Uint8Array(),
          dialect: "unknown",
          sourceId: SOURCE_ID,
        } as never),
      "FRONTMATTER_INVALID_INPUT",
    );
    expectParserError(
      () =>
        parseFrontmatter({
          bytes: new Uint8Array(),
          dialect: "yaml",
          extra: true,
          sourceId: SOURCE_ID,
        } as never),
      "FRONTMATTER_INVALID_INPUT",
    );

    let getters = 0;
    const accessor = Object.defineProperty({ dialect: "yaml", sourceId: SOURCE_ID }, "bytes", {
      get(): Uint8Array {
        getters += 1;
        return new Uint8Array();
      },
    });
    expectParserError(() => parseFrontmatter(accessor as never), "FRONTMATTER_INVALID_INPUT");
    expect(getters).toBe(0);

    const bytes = ENCODER.encode("---\nvalue: original\n---\n");
    const first = parseFrontmatter({ bytes, dialect: "yaml", sourceId: SOURCE_ID });
    bytes.fill(0x20);
    expect(first.value?.["value"]).toBe("original");
  });

  test("copies typed-array subclasses through intrinsics without consulting overrides", () => {
    let traps = 0;
    class HostileBytes extends Uint8Array {
      public override get byteLength(): number {
        traps += 1;
        throw new Error("must not use override");
      }

      public override [Symbol.iterator](): ArrayIterator<number> {
        traps += 1;
        throw new Error("must not iterate through override");
      }
    }
    const source = ENCODER.encode("---\nvalue: intrinsic\n---\n");
    const hostile = new HostileBytes(source.length);
    hostile.set(source);
    const parsed = parseFrontmatter({ bytes: hostile, dialect: "yaml", sourceId: SOURCE_ID });
    expect(parsed.value?.["value"]).toBe("intrinsic");
    expect(traps).toBe(0);
  });

  test("is deterministic across repeated parses", () => {
    const bytes = ENCODER.encode(
      "---\ndescription: deterministic\nglobs: [src/**, test/**]\n---\nbody",
    );
    const input = { bytes, dialect: "mdc" as const, sourceId: SOURCE_ID };
    expect(parseFrontmatter(input)).toEqual(parseFrontmatter(input));
  });
});
