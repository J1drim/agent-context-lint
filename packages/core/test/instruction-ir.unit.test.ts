import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { describe, expect, test } from "vitest";

import {
  ACTIVATION_KINDS,
  AST_NODE_KINDS,
  IMPORT_KINDS,
  IMPORT_STATES,
  IMPORT_TARGET_KINDS,
  INSTRUCTION_IR_CONTRACT_VERSION,
  MAX_VALIDATION_ISSUES,
  RESOLUTION_EVENT_KINDS,
  VALIDATION_ISSUE_LIMIT_CODE,
  isInstructionIr,
  sliceSourceRange,
  validateInstructionIr,
  validateSourceRange,
} from "../src/index.js";
import type {
  InstructionIr,
  InstructionIrValidationCode,
  ResolutionEvent,
  SourceDocument,
} from "../src/index.js";

type PathSegment = number | string;

const VALID_FIXTURE = new URL("./fixtures/instruction-ir.valid.json", import.meta.url);
const INVALID_FIXTURE = new URL("./fixtures/instruction-ir.invalid.json", import.meta.url);

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function cloneValid(): unknown {
  return structuredClone(readJson(VALID_FIXTURE));
}

function child(container: unknown, segment: PathSegment): unknown {
  if (typeof segment === "number") {
    if (!Array.isArray(container)) throw new TypeError("expected array");
    return container[segment];
  }
  if (container === null || typeof container !== "object" || Array.isArray(container)) {
    throw new TypeError("expected object");
  }
  return (container as Record<string, unknown>)[segment];
}

function setValue(root: unknown, path: readonly PathSegment[], value: unknown): void {
  if (path.length === 0) throw new TypeError("cannot replace root");
  let parent = root;
  for (const segment of path.slice(0, -1)) parent = child(parent, segment);
  const key = path.at(-1);
  if (typeof key === "number") {
    if (!Array.isArray(parent)) throw new TypeError("expected array parent");
    parent[key] = value;
  } else if (typeof key === "string") {
    if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
      throw new TypeError("expected object parent");
    }
    (parent as Record<string, unknown>)[key] = value;
  }
}

function deleteValue(root: unknown, path: readonly PathSegment[]): void {
  if (path.length === 0) throw new TypeError("cannot delete root");
  let parent = root;
  for (const segment of path.slice(0, -1)) parent = child(parent, segment);
  const key = path.at(-1);
  if (
    typeof key !== "string" ||
    parent === null ||
    typeof parent !== "object" ||
    Array.isArray(parent)
  ) {
    throw new TypeError("expected object property");
  }
  Reflect.deleteProperty(parent, key);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected record");
  }
  return value as Record<string, unknown>;
}

function expectIssue(input: unknown, path: string, code?: InstructionIrValidationCode): void {
  const result = validateInstructionIr(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid IR");
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ...(code === undefined ? {} : { code }), path }),
    ]),
  );
}

function validatedFixture(): InstructionIr {
  const result = validateInstructionIr(readJson(VALID_FIXTURE));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function standaloneSource(text: string, lineEnding: SourceDocument["lineEnding"]): SourceDocument {
  const base = validatedFixture().sources[0];
  if (base === undefined) throw new TypeError("positive fixture must contain a source");
  return {
    ...base,
    bom: text.startsWith("\uFEFF") ? "utf-8" : "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    lineEnding,
    sha256: createHash("sha256").update(text).digest("hex"),
    text,
    utf16Length: text.length,
  };
}

describe("public B03 vocabulary and round trip", () => {
  test("exports the closed contract vocabulary", () => {
    expect(INSTRUCTION_IR_CONTRACT_VERSION).toBe("0.1.0");
    expect(AST_NODE_KINDS).toHaveLength(13);
    expect(IMPORT_KINDS).toEqual(["vendor-import", "markdown-link", "reference-token"]);
    expect(IMPORT_TARGET_KINDS).toContain("unknown");
    expect(IMPORT_STATES).toEqual(["recognized", "malformed", "ambiguous"]);
    expect(ACTIVATION_KINDS).toEqual([
      "always",
      "directory-tree",
      "glob",
      "manual",
      "conditional",
      "unknown",
    ]);
    expect(RESOLUTION_EVENT_KINDS).toEqual([
      "launch",
      "reference-path",
      "read-path",
      "write-path",
      "list-directory",
      "manual-rule-mention",
      "rule-selection",
      "memory-show",
      "memory-list",
      "memory-reload",
      "compact",
      "directory-add",
      "review-request",
      "review-push",
      "hosted-task-start",
      "settings-change",
      "client-restart",
    ]);
  });

  test("validates and narrows the positive JSON fixture", () => {
    const input = readJson(VALID_FIXTURE);
    expect(isInstructionIr(input)).toBe(true);
    expect(validatedFixture().sources[0]?.path).toBe("AGENTS.md");
  });

  test("round-trips without losing explicit nulls, CRLF, Unicode, or uncertainty", () => {
    const value = validatedFixture();
    const reparsed = JSON.parse(JSON.stringify(value)) as unknown;
    expect(validateInstructionIr(reparsed)).toEqual({ ok: true, value });
    expect(value.sources[0]?.text).toContain("🧭");
    expect(value.activationRules[0]?.include[0]).toMatchObject({ dialectId: null });
  });

  test("rejects the maintained negative JSON fixture", () => {
    expectIssue(readJson(INVALID_FIXTURE), "$.events[0].unexpected", "unknown-field");
    expectIssue(readJson(INVALID_FIXTURE), "$.events[0].path", "invalid-path");
    expectIssue(readJson(INVALID_FIXTURE), "$.events[0].targetId", "invalid-relationship");
  });
});

describe("closed envelope", () => {
  test.each([
    "recordKind",
    "contractVersion",
    "sources",
    "documents",
    "nodes",
    "imports",
    "statements",
    "activationRules",
    "targets",
    "events",
  ])("requires %s", (key) => {
    const fixture = cloneValid();
    deleteValue(fixture, [key]);
    expectIssue(fixture, `$.${key}`, "missing-field");
  });

  test.each([
    ["recordKind", "wrong"],
    ["contractVersion", "9.0.0"],
    ["sources", {}],
    ["documents", null],
    ["nodes", "nodes"],
  ] as const)("rejects malformed %s", (key, value) => {
    const fixture = cloneValid();
    setValue(fixture, [key], value);
    expectIssue(fixture, `$.${key}`);
  });

  test("rejects non-objects and unknown fields", () => {
    expect(validateInstructionIr(null).ok).toBe(false);
    const fixture = cloneValid();
    setValue(fixture, ["vendorBehavior"], true);
    expectIssue(fixture, "$.vendorBehavior", "unknown-field");
  });

  test.each([
    "sources",
    "documents",
    "nodes",
    "imports",
    "statements",
    "activationRules",
    "targets",
    "events",
  ])("rejects duplicate IDs in %s", (key) => {
    const fixture = cloneValid();
    const values = child(fixture, key);
    if (!Array.isArray(values) || values.length === 0)
      throw new TypeError("expected populated array");
    values.push(structuredClone(values[0]));
    expectIssue(fixture, `$.${key}[${String(values.length - 1)}].id`, "duplicate-id");
  });

  test("caps issues with a stable sentinel and deterministic order", () => {
    const fixture = asRecord(cloneValid());
    for (let index = 0; index < MAX_VALIDATION_ISSUES + 100; index += 1) {
      fixture[`unexpected${String(index).padStart(4, "0")}`] = true;
    }
    const first = validateInstructionIr(fixture);
    const second = validateInstructionIr(fixture);
    expect(first).toEqual(second);
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected capped validation failure");
    expect(first.issues).toHaveLength(MAX_VALIDATION_ISSUES);
    expect(first.issues[0]?.path).toBe("$.unexpected0000");
    expect(first.issues.at(-1)).toEqual({
      code: VALIDATION_ISSUE_LIMIT_CODE,
      message: `validation stopped after ${String(MAX_VALIDATION_ISSUES - 1)} issues`,
      path: "$",
    });
  });
});

describe("source bytes, BOM, paths, and coordinates", () => {
  test("reuses exact standalone range validation and slicing", () => {
    const fixture = validatedFixture();
    const source = fixture.sources[0];
    const range = fixture.statements[0]?.range;
    if (source === undefined || range === undefined) throw new TypeError("missing fixture facts");
    expect(validateSourceRange(source, range)).toEqual({ ok: true, value: range });
    expect(sliceSourceRange(source, range)).toEqual({ ok: true, range, text: "Use 🧭 paths." });

    const corrupted = structuredClone(range) as unknown;
    setValue(corrupted, ["end", "byteOffset"], 27);
    const result = validateSourceRange(source, corrupted);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected corrupt range to fail");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-range", path: "$.range.end" }),
      ]),
    );
  });

  test("fails closed without throwing for unsafe standalone range inputs", () => {
    const source = validatedFixture().sources[0];
    if (source === undefined) throw new TypeError("missing source");
    let invoked = false;
    const accessorRange = {
      sourceId: source.id,
      get start(): never {
        invoked = true;
        throw new Error("must not run");
      },
      end: { byteOffset: 0, utf16Offset: 0, line: 0, utf16Column: 0 },
    };
    expect(validateSourceRange(source, accessorRange).ok).toBe(false);
    expect(invoked).toBe(false);

    const revokedRange = Proxy.revocable({}, {});
    revokedRange.revoke();
    expect(validateSourceRange(source, revokedRange.proxy).ok).toBe(false);

    const revokedSource = Proxy.revocable({}, {});
    revokedSource.revoke();
    expect(validateSourceRange(revokedSource.proxy as SourceDocument, {}).ok).toBe(false);
  });

  test("tracks lone CR and mixed line endings exactly", () => {
    const crSource = standaloneSource("a\rb", "cr");
    const crRange = {
      sourceId: crSource.id,
      start: { byteOffset: 0, utf16Offset: 0, line: 0, utf16Column: 0 },
      end: { byteOffset: 2, utf16Offset: 2, line: 1, utf16Column: 0 },
    };
    expect(validateSourceRange(crSource, crRange).ok).toBe(true);

    const mixedSource = standaloneSource("a\rb\r\nc\n", "mixed");
    const mixedRange = {
      sourceId: mixedSource.id,
      start: { byteOffset: 0, utf16Offset: 0, line: 0, utf16Column: 0 },
      end: { byteOffset: 7, utf16Offset: 7, line: 3, utf16Column: 0 },
    };
    expect(validateSourceRange(mixedSource, mixedRange).ok).toBe(true);
    expect(validateSourceRange({ ...crSource, lineEnding: "mixed" }, crRange).ok).toBe(false);
  });

  test.each([
    ["path", "../AGENTS.md", "invalid-path"],
    ["path", "/repo/AGENTS.md", "invalid-path"],
    ["path", "src\\AGENTS.md", "invalid-path"],
    ["path", ".", "invalid-path"],
    ["encoding", "utf-16", "invalid-state"],
    ["byteLength", 46, "invalid-value"],
    ["utf16Length", 48, "invalid-value"],
    ["sha256", "0".repeat(64), "invalid-digest"],
    ["lineEnding", "lf", "invalid-value"],
    ["bom", "utf-8", "invalid-value"],
  ] as const)("rejects invalid source %s", (key, value, code) => {
    const fixture = cloneValid();
    setValue(fixture, ["sources", 0, key], value);
    expectIssue(fixture, `$.sources[0].${key}`, code);
  });

  test("accepts an exact UTF-8 BOM source", () => {
    const fixture = cloneValid();
    setValue(fixture, ["sources", 0, "text"], "\uFEFF");
    setValue(fixture, ["sources", 0, "bom"], "utf-8");
    setValue(fixture, ["sources", 0, "byteLength"], 3);
    setValue(fixture, ["sources", 0, "utf16Length"], 1);
    setValue(
      fixture,
      ["sources", 0, "sha256"],
      "f1945cd6c19e56b3c1c78943ef5ec18116907a4ca1efc40a57d48ab1db7adfc5",
    );
    setValue(fixture, ["sources", 0, "lineEnding"], "none");
    setValue(fixture, ["nodes", 0, "range", "end"], {
      byteOffset: 3,
      utf16Offset: 1,
      line: 0,
      utf16Column: 1,
    });
    for (const key of ["nodes", "imports", "statements", "activationRules"] as const) {
      const values = child(fixture, key);
      if (Array.isArray(values)) values.splice(key === "nodes" ? 1 : 0);
    }
    setValue(fixture, ["nodes", 0, "childIds"], []);
    setValue(fixture, ["documents", 0, "importIds"], []);
    setValue(fixture, ["documents", 0, "statementIds"], []);
    setValue(fixture, ["documents", 0, "activationRuleIds"], []);
    setValue(fixture, ["events"], []);
    expect(validateInstructionIr(fixture).ok).toBe(true);
  });

  test.each([
    ["byteOffset", 27],
    ["utf16Offset", 14],
    ["line", 3],
    ["utf16Column", 14],
  ] as const)("rejects a mismatched %s", (key, value) => {
    const fixture = cloneValid();
    setValue(fixture, ["statements", 0, "range", "end", key], value);
    expectIssue(fixture, "$.statements[0].range.end", "invalid-range");
  });

  test("rejects reversed ranges, offsets outside the source, and surrogate splits", () => {
    const reversed = cloneValid();
    setValue(reversed, ["statements", 0, "range", "start", "utf16Offset"], 30);
    expectIssue(reversed, "$.statements[0].range", "invalid-range");

    const outside = cloneValid();
    setValue(outside, ["nodes", 0, "range", "end", "utf16Offset"], 100);
    expectIssue(outside, "$.nodes[0].range.end", "invalid-range");

    const split = cloneValid();
    setValue(split, ["statements", 0, "range", "start"], {
      byteOffset: 17,
      utf16Offset: 19,
      line: 2,
      utf16Column: 8,
    });
    expectIssue(split, "$.statements[0].range.start", "invalid-range");
  });

  test("rejects malformed Unicode and non-integer coordinates", () => {
    const unicode = cloneValid();
    setValue(unicode, ["sources", 0, "text"], "\ud800");
    expectIssue(unicode, "$.sources[0].text", "invalid-value");

    const coordinate = cloneValid();
    setValue(coordinate, ["nodes", 0, "range", "start", "line"], 0.5);
    expectIssue(coordinate, "$.nodes[0].range.start.line", "invalid-value");
  });

  test.each([
    [{ state: "partial", reason: "bounded input" }, true],
    [{ state: "malformed", reason: "bad fence" }, true],
    [{ state: "complete", reason: "not allowed" }, false],
    [{ state: "partial" }, false],
  ])("validates parse state %#", (parseState, accepted) => {
    const fixture = cloneValid();
    setValue(fixture, ["sources", 0, "parseState"], parseState);
    expect(validateInstructionIr(fixture).ok).toBe(accepted);
  });

  test("validates 4,096 ranges over a 1 MiB source within the scale bound", () => {
    const fixture = cloneValid();
    const text = "a".repeat(1024 * 1024);
    const childCount = 4096;
    const childWidth = text.length / childCount;
    const position = (offset: number): Record<string, number> => ({
      byteOffset: offset,
      line: 0,
      utf16Column: offset,
      utf16Offset: offset,
    });
    const childIds = Array.from(
      { length: childCount },
      (_, index) => `node:scale-${String(index)}`,
    );
    const nodes: unknown[] = [
      {
        id: "node:root",
        sourceId: "source:agents",
        kind: "root",
        range: {
          sourceId: "source:agents",
          start: position(0),
          end: position(text.length),
        },
        childIds,
      },
      ...childIds.map((id, index) => {
        const start = index * childWidth;
        return {
          id,
          sourceId: "source:agents",
          kind: "text",
          range: {
            sourceId: "source:agents",
            start: position(start),
            end: position(start + childWidth),
          },
          childIds: [],
        };
      }),
    ];
    setValue(fixture, ["sources", 0, "text"], text);
    setValue(fixture, ["sources", 0, "byteLength"], text.length);
    setValue(fixture, ["sources", 0, "utf16Length"], text.length);
    setValue(fixture, ["sources", 0, "sha256"], createHash("sha256").update(text).digest("hex"));
    setValue(fixture, ["sources", 0, "lineEnding"], "none");
    setValue(fixture, ["nodes"], nodes);
    setValue(fixture, ["documents", 0, "importIds"], []);
    setValue(fixture, ["documents", 0, "statementIds"], []);
    setValue(fixture, ["documents", 0, "activationRuleIds"], []);
    setValue(fixture, ["imports"], []);
    setValue(fixture, ["statements"], []);
    setValue(fixture, ["activationRules"], []);
    setValue(fixture, ["targets"], []);
    setValue(fixture, ["events"], []);

    const startedAt = performance.now();
    const result = validateInstructionIr(fixture);
    const elapsedMilliseconds = performance.now() - startedAt;
    expect(result.ok).toBe(true);
    expect(elapsedMilliseconds).toBeLessThan(2000);
  }, 3000);
});

describe("flat AST validation", () => {
  test.each([
    ["paragraph", {}],
    ["block-quote", {}],
    ["inline-code", {}],
    ["html-comment", {}],
    ["text", {}],
    ["code-block", { language: null, metadata: "meta" }],
    ["link", { destination: "https://example.test", title: null }],
    ["frontmatter", { format: "yaml" }],
    ["unknown", { syntaxKind: "extension-node", reason: "retained tolerantly" }],
  ] as const)("accepts closed %s node payload", (kind, fields) => {
    const fixture = cloneValid();
    const node = asRecord(child(child(fixture, "nodes"), 1));
    Reflect.deleteProperty(node, "depth");
    Object.assign(node, { kind, ...fields });
    expect(validateInstructionIr(fixture).ok).toBe(true);
  });

  test("accepts ordered list start and rejects inconsistent list fields", () => {
    const valid = cloneValid();
    setValue(valid, ["nodes", 2, "ordered"], true);
    setValue(valid, ["nodes", 2, "start"], 1);
    expect(validateInstructionIr(valid).ok).toBe(true);

    const invalid = cloneValid();
    setValue(invalid, ["nodes", 2, "start"], 1);
    expectIssue(invalid, "$.nodes[2].start", "invalid-state");
  });

  test.each([
    ["heading", "depth", 7],
    ["frontmatter", "format", "toml"],
    ["unknown", "reason", ""],
  ] as const)("rejects malformed %s payload", (kind, field, value) => {
    const fixture = cloneValid();
    const node = asRecord(child(child(fixture, "nodes"), 1));
    Reflect.deleteProperty(node, "depth");
    Object.assign(
      node,
      kind === "unknown" ? { kind, syntaxKind: "x", reason: "reason" } : { kind },
    );
    node[field] = value;
    expectIssue(fixture, `$.nodes[1].${field}`);
  });

  test("rejects broken children, cycles, multiple parents, containment, overlap, and unreachable nodes", () => {
    const broken = cloneValid();
    setValue(broken, ["nodes", 0, "childIds", 0], "node:missing");
    expectIssue(broken, "$.nodes[id=node:root].childIds[0]", "invalid-relationship");

    const cycle = cloneValid();
    setValue(cycle, ["nodes", 3, "childIds"], ["node:list"]);
    expectIssue(cycle, "$.nodes[id=node:list].childIds", "invalid-relationship");

    const multiple = cloneValid();
    setValue(multiple, ["nodes", 1, "childIds"], ["node:list-item"]);
    expectIssue(multiple, "$.nodes[id=node:list].childIds[0]", "invalid-relationship");

    const outside = cloneValid();
    setValue(outside, ["nodes", 1, "range", "end"], {
      byteOffset: 48,
      utf16Offset: 46,
      line: 5,
      utf16Column: 0,
    });
    expectIssue(outside, "$.nodes[id=node:root].childIds[1]", "invalid-range");

    const overlap = cloneValid();
    setValue(overlap, ["nodes", 4, "range", "start"], {
      byteOffset: 13,
      utf16Offset: 13,
      line: 2,
      utf16Column: 2,
    });
    expectIssue(overlap, "$.nodes[id=node:root].childIds[2]", "invalid-range");

    const unreachable = cloneValid();
    setValue(unreachable, ["nodes", 0, "childIds"], ["node:heading", "node:import-paragraph"]);
    expectIssue(unreachable, "$.nodes[id=node:list]", "invalid-relationship");
  });

  test("requires the source root to reference a full root node", () => {
    const missing = cloneValid();
    setValue(missing, ["sources", 0, "rootNodeId"], "node:missing");
    expectIssue(missing, "$.sources[id=source:agents].rootNodeId", "invalid-relationship");

    const partial = cloneValid();
    setValue(partial, ["nodes", 0, "range", "end"], {
      byteOffset: 46,
      utf16Offset: 44,
      line: 4,
      utf16Column: 14,
    });
    expectIssue(partial, "$.nodes[id=node:root].range", "invalid-range");
  });

  test("requires one nominated root-kind node and one owner per canonical source path", () => {
    const extraRoot = cloneValid();
    const extraRootNodes = child(extraRoot, "nodes");
    if (!Array.isArray(extraRootNodes)) throw new TypeError("expected nodes");
    const extra = structuredClone(extraRootNodes[1]) as Record<string, unknown>;
    extra["id"] = "node:extra-root";
    extra["kind"] = "root";
    Reflect.deleteProperty(extra, "depth");
    extraRootNodes.push(extra);
    expectIssue(extraRoot, "$.sources[id=source:agents].rootNodeId", "invalid-relationship");

    const duplicatePath = cloneValid();
    const sourceValues = child(duplicatePath, "sources");
    if (!Array.isArray(sourceValues)) throw new TypeError("expected sources");
    const copiedSource = structuredClone(sourceValues[0]) as Record<string, unknown>;
    copiedSource["id"] = "source:copy";
    copiedSource["rootNodeId"] = "node:copy-root";
    sourceValues.push(copiedSource);
    expectIssue(duplicatePath, "$.sources[1].path", "duplicate-id");
  });

  test("walks a 12,000-node AST chain and detects a deep cycle without recursion", () => {
    const fixture = cloneValid();
    const nodeCount = 12_000;
    const text = "x";
    const position = (offset: number): Record<string, number> => ({
      byteOffset: offset,
      line: 0,
      utf16Column: offset,
      utf16Offset: offset,
    });
    const nodeIds = Array.from({ length: nodeCount }, (_, index) =>
      index === 0 ? "node:root" : `node:deep-${String(index)}`,
    );
    const nodes = nodeIds.map((id, index) => ({
      id,
      sourceId: "source:agents",
      kind: index === 0 ? "root" : "paragraph",
      range: { sourceId: "source:agents", start: position(0), end: position(1) },
      childIds: index + 1 < nodeCount ? [nodeIds[index + 1]] : [],
    }));
    setValue(fixture, ["sources", 0, "text"], text);
    setValue(fixture, ["sources", 0, "byteLength"], 1);
    setValue(fixture, ["sources", 0, "utf16Length"], 1);
    setValue(fixture, ["sources", 0, "sha256"], createHash("sha256").update(text).digest("hex"));
    setValue(fixture, ["sources", 0, "lineEnding"], "none");
    setValue(fixture, ["nodes"], nodes);
    setValue(fixture, ["documents", 0, "importIds"], []);
    setValue(fixture, ["documents", 0, "statementIds"], []);
    setValue(fixture, ["documents", 0, "activationRuleIds"], []);
    setValue(fixture, ["imports"], []);
    setValue(fixture, ["statements"], []);
    setValue(fixture, ["activationRules"], []);
    setValue(fixture, ["targets"], []);
    setValue(fixture, ["events"], []);
    expect(validateInstructionIr(fixture).ok).toBe(true);

    setValue(fixture, ["nodes", nodeCount - 1, "childIds"], ["node:root"]);
    expect(validateInstructionIr(fixture).ok).toBe(false);
  }, 5000);
});

describe("document, import, and statement relationships", () => {
  test.each([
    ["sourceId", "source:missing"],
    ["rootNodeId", "node:missing"],
  ] as const)("rejects document %s reference", (key, value) => {
    const fixture = cloneValid();
    setValue(fixture, ["documents", 0, key], value);
    expectIssue(fixture, `$.documents[0].${key}`, "invalid-relationship");
  });

  test.each([
    ["importIds", "import:missing"],
    ["statementIds", "statement:missing"],
    ["activationRuleIds", "activation:missing"],
  ] as const)("rejects missing %s member", (key, value) => {
    const fixture = cloneValid();
    setValue(fixture, ["documents", 0, key, 0], value);
    expectIssue(fixture, `$.documents[id=document:agents].${key}[0]`, "invalid-relationship");
  });

  test("requires record ownership in both directions", () => {
    for (const [collection, list] of [
      ["imports", "importIds"],
      ["statements", "statementIds"],
      ["activationRules", "activationRuleIds"],
    ] as const) {
      const fixture = cloneValid();
      setValue(fixture, ["documents", 0, list], []);
      expectIssue(
        fixture,
        `$.${collection}[id=${asRecord(child(child(fixture, collection), 0))["id"] as string}].documentId`,
        "invalid-relationship",
      );
    }
  });

  test.each([
    ["documentId", "document:missing", "invalid-relationship"],
    ["nodeId", "node:missing", "invalid-relationship"],
    ["rawSpecifier", "different.md", "invalid-range"],
    ["kind", "include", "invalid-state"],
    ["targetKind", "file", "invalid-state"],
    ["state", "maybe", "invalid-state"],
  ] as const)("rejects malformed import %s", (key, value, code) => {
    const fixture = cloneValid();
    setValue(fixture, ["imports", 0, key], value);
    expectIssue(fixture, `$.imports[0].${key}`, code);
  });

  test("preserves malformed and ambiguous imports without resolving them", () => {
    const malformed = cloneValid();
    setValue(malformed, ["imports", 0, "state"], "malformed");
    setValue(malformed, ["imports", 0, "targetKind"], "malformed");
    setValue(malformed, ["imports", 0, "rawSpecifier"], "");
    setValue(malformed, ["imports", 0, "specifierRange"], {
      sourceId: "source:agents",
      start: { byteOffset: 32, utf16Offset: 30, line: 4, utf16Column: 0 },
      end: { byteOffset: 32, utf16Offset: 30, line: 4, utf16Column: 0 },
    });
    expect(validateInstructionIr(malformed).ok).toBe(true);

    const ambiguous = cloneValid();
    setValue(ambiguous, ["imports", 0, "state"], "ambiguous");
    setValue(ambiguous, ["imports", 0, "uncertainty"], { state: "known" });
    expectIssue(ambiguous, "$.imports[0].uncertainty.state", "invalid-state");
  });

  test("requires exact import range containment", () => {
    const fixture = cloneValid();
    setValue(fixture, ["imports", 0, "specifierRange", "start"], {
      byteOffset: 11,
      utf16Offset: 11,
      line: 2,
      utf16Column: 0,
    });
    expectIssue(fixture, "$.imports[0].specifierRange", "invalid-range");
  });

  test.each([
    ["documentId", "document:missing", "invalid-relationship"],
    ["text", "changed", "invalid-range"],
  ] as const)("rejects malformed statement %s", (key, value, code) => {
    const fixture = cloneValid();
    setValue(fixture, ["statements", 0, key], value);
    expectIssue(fixture, `$.statements[0].${key}`, code);
  });

  test("requires unique ordered non-overlapping contributing sibling nodes", () => {
    const reversed = cloneValid();
    setValue(
      reversed,
      ["statements", 0, "nodeIds"],
      ["node:statement-rest", "node:statement-prefix"],
    );
    expectIssue(reversed, "$.statements[0].nodeIds[1]", "invalid-range");

    const duplicate = cloneValid();
    setValue(
      duplicate,
      ["statements", 0, "nodeIds"],
      ["node:statement-prefix", "node:statement-prefix"],
    );
    expectIssue(duplicate, "$.statements[0].nodeIds[1]", "duplicate-id");

    const overlap = cloneValid();
    setValue(overlap, ["nodes", 6, "range", "start"], {
      byteOffset: 13,
      utf16Offset: 13,
      line: 2,
      utf16Column: 2,
    });
    expectIssue(overlap, "$.statements[0].nodeIds[1]", "invalid-range");

    const nonSibling = cloneValid();
    setValue(nonSibling, ["statements", 0, "nodeIds", 1], "node:import-paragraph");
    expectIssue(nonSibling, "$.statements[0].nodeIds[1]", "invalid-relationship");
  });

  test("validates classified statement payloads and confidence", () => {
    const valid = cloneValid();
    setValue(valid, ["statements", 0, "classification"], {
      state: "classified",
      normalizedText: "Use paths.",
      categoryId: "repository-paths",
      modality: "must",
      subject: null,
      action: "use",
      object: "paths",
      confidence: 1,
    });
    expect(validateInstructionIr(valid).ok).toBe(true);

    const invalid = structuredClone(valid);
    setValue(invalid, ["statements", 0, "classification", "confidence"], Number.NaN);
    expectIssue(invalid, "$.statements[0].classification.confidence", "invalid-json");
  });
});

describe("profile-owned activation data", () => {
  test.each([
    ["documentId", "document:missing", "invalid-relationship"],
    ["profileId", "profile with spaces", "invalid-value"],
    ["surfaceId", "", "invalid-value"],
    ["scopeRoot", "../outside", "invalid-path"],
  ] as const)("rejects invalid activation %s", (key, value, code) => {
    const fixture = cloneValid();
    setValue(fixture, ["activationRules", 0, key], value);
    expectIssue(fixture, `$.activationRules[0].${key}`, code);
  });

  test.each([
    ["always", [], [], [], null, { state: "known" }],
    [
      "directory-tree",
      [{ kind: "directory-tree", path: "src", sourceRange: null }],
      [],
      [],
      null,
      { state: "known" },
    ],
    [
      "glob",
      [
        {
          kind: "glob",
          pattern: "src/**",
          dialectId: "gitignore",
          sourceRange: null,
          uncertainty: { state: "known" },
        },
      ],
      [],
      [],
      null,
      { state: "known" },
    ],
    ["manual", [], [], [], null, { state: "known" }],
    [
      "conditional",
      [],
      [],
      ["model-selected"],
      null,
      { state: "conditional", conditions: ["model-selected"] },
    ],
    [
      "unknown",
      [],
      [],
      [],
      "Evidence is incomplete.",
      { state: "unknown", reason: "Evidence is incomplete." },
    ],
  ] as const)(
    "accepts %s activation record",
    (kind, include, exclude, conditions, unknownReason, uncertainty) => {
      const fixture = cloneValid();
      setValue(fixture, ["activationRules", 0, "kind"], kind);
      setValue(fixture, ["activationRules", 0, "include"], include);
      setValue(fixture, ["activationRules", 0, "exclude"], exclude);
      setValue(fixture, ["activationRules", 0, "conditions"], conditions);
      setValue(fixture, ["activationRules", 0, "unknownReason"], unknownReason);
      setValue(fixture, ["activationRules", 0, "uncertainty"], uncertainty);
      expect(validateInstructionIr(fixture).ok).toBe(true);
    },
  );

  test("accepts path restrictions for always activation but rejects conditions", () => {
    const restricted = cloneValid();
    setValue(restricted, ["activationRules", 0, "kind"], "always");
    setValue(restricted, ["activationRules", 0, "include"], []);
    setValue(
      restricted,
      ["activationRules", 0, "exclude"],
      [{ kind: "directory-tree", path: "vendor", sourceRange: null }],
    );
    setValue(restricted, ["activationRules", 0, "conditions"], []);
    setValue(restricted, ["activationRules", 0, "uncertainty"], { state: "known" });
    expect(validateInstructionIr(restricted).ok).toBe(true);

    const conditionalAlways = structuredClone(restricted);
    setValue(conditionalAlways, ["activationRules", 0, "conditions"], ["model-selected"]);
    expectIssue(conditionalAlways, "$.activationRules[0].conditions", "invalid-state");
  });

  test("rejects semantic requirements without implementing activation", () => {
    const directory = cloneValid();
    setValue(directory, ["activationRules", 0, "kind"], "directory-tree");
    expectIssue(directory, "$.activationRules[0].include", "invalid-state");

    const unknown = cloneValid();
    setValue(unknown, ["activationRules", 0, "kind"], "unknown");
    setValue(unknown, ["activationRules", 0, "unknownReason"], null);
    setValue(unknown, ["activationRules", 0, "uncertainty"], { state: "known" });
    expectIssue(unknown, "$.activationRules[0].unknownReason", "invalid-state");
    expectIssue(unknown, "$.activationRules[0].uncertainty.state", "invalid-state");
  });

  test("requires explicit glob uncertainty and provenance anchors", () => {
    const dialect = cloneValid();
    setValue(dialect, ["activationRules", 0, "include", 0, "uncertainty"], { state: "known" });
    expectIssue(dialect, "$.activationRules[0].include[0].uncertainty.state", "invalid-state");

    const evidence = cloneValid();
    setValue(evidence, ["activationRules", 0, "evidenceRefs"], []);
    expectIssue(evidence, "$.activationRules[0].evidenceRefs", "invalid-value");
  });

  test("reuses B02 contradiction invariants", () => {
    const fixture = cloneValid();
    setValue(fixture, ["activationRules", 0, "uncertainty"], {
      state: "contradiction",
      reason: "Sources differ.",
      alternatives: [{ id: "only", description: "Only one alternative." }],
    });
    expectIssue(fixture, "$.activationRules[0].uncertainty.alternatives", "invalid-value");
  });

  test("rejects duplicate activation and uncertainty conditions", () => {
    const activation = cloneValid();
    setValue(activation, ["activationRules", 0, "conditions"], ["same", "same"]);
    expectIssue(activation, "$.activationRules[0].conditions[1]", "duplicate-id");

    const uncertainty = cloneValid();
    setValue(uncertainty, ["activationRules", 0, "uncertainty"], {
      state: "conditional",
      conditions: ["same", "same"],
    });
    expectIssue(uncertainty, "$.activationRules[0].uncertainty.conditions[1]", "duplicate-id");
  });

  test.each([
    null,
    {},
    { state: "maybe" },
    { state: "known", reason: "forbidden" },
    { state: "conditional" },
    { state: "conditional", conditions: [] },
    { state: "conditional", conditions: [""] },
    { state: "conditional", conditions: ["condition"], reason: "forbidden" },
    { state: "unknown" },
    { state: "unknown", reason: "reason", conditions: ["forbidden"] },
    { state: "contradiction", reason: "reason" },
    { state: "contradiction", reason: "reason", alternatives: {} },
    { state: "contradiction", reason: "reason", alternatives: [null, null] },
    {
      state: "contradiction",
      reason: "reason",
      alternatives: [
        { id: "bad id", description: "one" },
        { id: "two", description: "" },
      ],
    },
    {
      state: "contradiction",
      reason: "reason",
      conditions: ["forbidden"],
      alternatives: [
        { id: "one", description: "one" },
        { id: "two", description: "two" },
      ],
    },
  ])("rejects malformed shared uncertainty %#", (uncertainty) => {
    const fixture = cloneValid();
    setValue(fixture, ["activationRules", 0, "uncertainty"], uncertainty);
    expect(validateInstructionIr(fixture).ok).toBe(false);
  });
});

describe("resolution targets, discriminated events, and JSON settings", () => {
  function eventFor(kind: (typeof RESOLUTION_EVENT_KINDS)[number]): ResolutionEvent {
    const base = {
      id: `event:${kind}` as ResolutionEvent["id"],
      sequence: 0,
      targetId: "target:main" as ResolutionEvent["targetId"],
      uncertainty: { state: "known" as const },
    };
    if (kind === "launch")
      return { ...base, kind, path: "." as never, workspaceRoots: ["." as never], settings: [] };
    if (
      ["reference-path", "read-path", "write-path", "list-directory", "directory-add"].includes(
        kind,
      )
    )
      return { ...base, kind: kind as "read-path", path: "src/main.ts" as never };
    if (kind === "manual-rule-mention")
      return { ...base, kind, ruleId: "activation:vscode-description" as never };
    if (kind === "rule-selection")
      return {
        ...base,
        kind,
        ruleIds: ["activation:vscode-description" as never],
        selectionSource: "model",
      };
    if (kind === "settings-change")
      return { ...base, kind, settings: [{ key: "mode", value: "agent" }] };
    return { ...base, kind: kind as "compact" };
  }

  test.each(RESOLUTION_EVENT_KINDS)("accepts the closed %s event variant", (kind) => {
    const fixture = cloneValid();
    setValue(fixture, ["events"], [eventFor(kind)]);
    expect(validateInstructionIr(fixture).ok).toBe(true);
  });

  test("rejects broken targets, paths, purposes, and event references", () => {
    const targetPath = cloneValid();
    setValue(targetPath, ["targets", 0, "path"], ".");
    expectIssue(targetPath, "$.targets[0].path", "invalid-path");

    const purpose = cloneValid();
    setValue(purpose, ["targets", 0, "purpose"], "");
    expectIssue(purpose, "$.targets[0].purpose", "invalid-value");

    const reference = cloneValid();
    setValue(reference, ["events", 0, "targetId"], "target:missing");
    expectIssue(reference, "$.events[0].targetId", "invalid-relationship");
  });

  test("rejects event sequence gaps and impossible fields", () => {
    const sequence = cloneValid();
    setValue(sequence, ["events", 1, "sequence"], 9);
    expectIssue(sequence, "$.events[1].sequence", "invalid-state");

    const impossible = cloneValid();
    setValue(impossible, ["events", 1, "ruleId"], "activation:vscode-description");
    expectIssue(impossible, "$.events[1].ruleId", "unknown-field");

    const missing = cloneValid();
    deleteValue(missing, ["events", 0, "workspaceRoots"]);
    expectIssue(missing, "$.events[0].workspaceRoots", "missing-field");
  });

  test("rejects missing manual rules and empty settings changes", () => {
    const rule = cloneValid();
    setValue(
      rule,
      ["events"],
      [
        {
          id: "event:manual",
          sequence: 0,
          kind: "manual-rule-mention",
          targetId: null,
          uncertainty: { state: "known" },
          ruleId: "activation:missing",
        },
      ],
    );
    expectIssue(rule, "$.events[0].ruleId", "invalid-relationship");

    const settings = cloneValid();
    setValue(
      settings,
      ["events"],
      [
        {
          id: "event:settings",
          sequence: 0,
          kind: "settings-change",
          targetId: null,
          uncertainty: { state: "known" },
          settings: [],
        },
      ],
    );
    expectIssue(settings, "$.events[0].settings", "invalid-state");
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 1n])(
    "rejects non-JSON setting value %s",
    (value) => {
      const fixture = cloneValid();
      setValue(fixture, ["events", 0, "settings", 0, "value"], value);
      expectIssue(fixture, "$.events[0].settings[0].value", "invalid-json");
    },
  );

  test("rejects undefined JSON setting values at ingress", () => {
    const fixture = cloneValid();
    setValue(fixture, ["events", 0, "settings", 0, "value"], undefined);
    expectIssue(fixture, "$.events[0].settings[0].value", "invalid-json");
  });

  test("rejects sparse, cyclic, exotic, extra-keyed, and symbol-keyed JSON", () => {
    const values: unknown[] = [];
    const sparse = new Array<unknown>(1);
    values.push(sparse);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    values.push(cyclic);
    values.push(new Date());
    const arrayWithProperty: unknown[] = [];
    Object.assign(arrayWithProperty, { extra: true });
    values.push(arrayWithProperty);
    const objectWithSymbol: Record<PropertyKey, unknown> = {};
    objectWithSymbol[Symbol("secret")] = true;
    values.push(objectWithSymbol);
    const arrayWithSymbol: unknown[] = [];
    arrayWithSymbol[Symbol("secret") as unknown as number] = true;
    values.push(arrayWithSymbol);

    for (const value of values) {
      const fixture = cloneValid();
      setValue(fixture, ["events", 0, "settings", 0, "value"], value);
      expect(validateInstructionIr(fixture).ok).toBe(false);
    }
  });

  test("rejects noncanonical, non-enumerable, accessor, and proxied JSON containers", () => {
    const values: unknown[] = [];
    let accessorInvoked = false;
    const numericNonIndex: unknown[] = [];
    Object.defineProperty(numericNonIndex, "01", { enumerable: true, value: true });
    values.push(numericNonIndex);
    const maximumNonIndex: unknown[] = [];
    Object.defineProperty(maximumNonIndex, "4294967295", { enumerable: true, value: true });
    values.push(maximumNonIndex);
    const hiddenIndex = [true];
    Object.defineProperty(hiddenIndex, "0", { enumerable: false, value: true });
    values.push(hiddenIndex);
    const hiddenObject = {};
    Object.defineProperty(hiddenObject, "hidden", { enumerable: false, value: true });
    values.push(hiddenObject);
    const exoticArray: unknown[] = [];
    Object.setPrototypeOf(exoticArray, { inherited: true });
    values.push(exoticArray);
    const accessorArray = [true];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error("must not run");
      },
    });
    values.push(accessorArray);
    values.push(new Proxy({ value: true }, {}));
    const revoked = Proxy.revocable({ value: true }, {});
    revoked.revoke();
    values.push(revoked.proxy);

    for (const value of values) {
      const fixture = cloneValid();
      setValue(fixture, ["events", 0, "settings", 0, "value"], value);
      expect(validateInstructionIr(fixture).ok).toBe(false);
    }
    expect(accessorInvoked).toBe(false);
  });

  test("rejects a billion-slot sparse array without length-proportional work", () => {
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    const fixture = cloneValid();
    setValue(fixture, ["events", 0, "settings", 0, "value"], sparse);
    const startedAt = performance.now();
    expect(validateInstructionIr(fixture).ok).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  test("rejects duplicate and control-bearing setting keys", () => {
    const duplicate = cloneValid();
    setValue(
      duplicate,
      ["events", 0, "settings"],
      [
        { key: "same", value: true },
        { key: "same", value: false },
      ],
    );
    expectIssue(duplicate, "$.events[0].settings[1].key", "duplicate-id");

    const control = cloneValid();
    setValue(control, ["events", 0, "settings", 0, "key"], "bad\nkey");
    expectIssue(control, "$.events[0].settings[0].key", "invalid-value");
  });

  test("accepts every finite recursive JSON form", () => {
    const fixture = cloneValid();
    setValue(fixture, ["events", 0, "settings", 0, "value"], {
      nullValue: null,
      stringValue: "value",
      booleanValue: false,
      integerValue: 0,
      arrayValue: [null, "value", true, 1],
      objectValue: { nested: "value" },
    });
    expect(validateInstructionIr(fixture).ok).toBe(true);
  });

  test.each([
    [251, true],
    [252, false],
    [10_000, false],
  ] as const)("bounds setting JSON nesting depth %i without throwing", (depth, accepted) => {
    let value: unknown = null;
    for (let index = 0; index < depth; index += 1) value = { next: value };
    const fixture = cloneValid();
    setValue(fixture, ["events", 0, "settings", 0, "value"], value);
    expect(validateInstructionIr(fixture).ok).toBe(accepted);
  });

  test("rejects JSON accessors without invoking them", () => {
    let invoked = false;
    const value = {};
    Object.defineProperty(value, "unsafe", {
      enumerable: true,
      get() {
        invoked = true;
        return "value";
      },
    });
    const fixture = cloneValid();
    setValue(fixture, ["events", 0, "settings", 0, "value"], value);
    expect(validateInstructionIr(fixture).ok).toBe(false);
    expect(invoked).toBe(false);
  });

  test("rejects invalid rule-selection payloads", () => {
    const scenarios = [
      { ruleIds: [], selectionSource: "model" },
      { ruleIds: ["activation:missing"], selectionSource: "profile" },
      {
        ruleIds: ["activation:vscode-description", "activation:vscode-description"],
        selectionSource: "user",
      },
      { ruleIds: ["activation:vscode-description"], selectionSource: "automatic" },
    ];
    for (const scenario of scenarios) {
      const fixture = cloneValid();
      setValue(
        fixture,
        ["events"],
        [
          {
            id: "event:selection",
            sequence: 0,
            kind: "rule-selection",
            targetId: null,
            uncertainty: { state: "known" },
            ...scenario,
          },
        ],
      );
      expect(validateInstructionIr(fixture).ok).toBe(false);
    }
  });
});

describe("malformed boundary coverage", () => {
  type Mutation = (fixture: unknown) => void;
  const mutations: readonly Mutation[] = [
    (f): void => {
      setValue(f, ["sources", 0, "id"], "bad id");
    },
    (f): void => {
      deleteValue(f, ["sources", 0, "byteLength"]);
    },
    (f): void => {
      setValue(f, ["sources", 0, "byteLength"], -1);
    },
    (f): void => {
      setValue(f, ["sources", 0, "parseState"], null);
    },
    (f): void => {
      setValue(f, ["sources", 0, "parseState", "state"], "unknown");
    },
    (f): void => {
      setValue(f, ["sources", 0, "parseState", "extra"], true);
    },
    (f): void => {
      setValue(f, ["sources", 0, "text"], "\udcff");
    },
    (f): void => {
      setValue(f, ["nodes", 0], null);
    },
    (f): void => {
      deleteValue(f, ["nodes", 0, "range"]);
    },
    (f): void => {
      deleteValue(f, ["nodes", 0, "range", "sourceId"]);
    },
    (f): void => {
      deleteValue(f, ["nodes", 0, "range", "start"]);
    },
    (f): void => {
      deleteValue(f, ["nodes", 0, "range", "end"]);
    },
    (f): void => {
      deleteValue(f, ["nodes", 0, "range", "start", "byteOffset"]);
    },
    (f): void => {
      setValue(f, ["nodes", 0, "range", "sourceId"], "source:missing");
    },
    (f): void => {
      setValue(f, ["nodes", 1, "depth"], 0);
    },
    (f): void => {
      deleteValue(f, ["nodes", 1, "depth"]);
    },
    (f): void => {
      deleteValue(f, ["nodes", 2, "ordered"]);
    },
    (f): void => {
      setValue(f, ["nodes", 2, "ordered"], "false");
    },
    (f): void => {
      deleteValue(f, ["nodes", 2, "start"]);
    },
    (f): void => {
      setValue(f, ["nodes", 2, "start"], 0);
    },
    (f): void => {
      setValue(f, ["nodes", 0, "childIds"], ["node:heading", "node:heading"]);
    },
    (f): void => {
      setValue(f, ["nodes", 0, "childIds"], {});
    },
    (f): void => {
      setValue(f, ["nodes", 1, "sourceId"], "source:missing");
    },
    (f): void => {
      setValue(f, ["nodes", 1, "range", "sourceId"], "source:missing");
    },
    (f): void => {
      setValue(f, ["documents", 0], null);
    },
    (f): void => {
      setValue(f, ["documents", 0, "scopeRoot"], "");
    },
    (f): void => {
      setValue(f, ["documents", 0, "importIds"], ["bad id"]);
    },
    (f): void => {
      deleteValue(f, ["documents", 0, "statementIds"]);
    },
    (f): void => {
      setValue(f, ["imports", 0], null);
    },
    (f): void => {
      deleteValue(f, ["imports", 0, "range"]);
    },
    (f): void => {
      deleteValue(f, ["imports", 0, "specifierRange"]);
    },
    (f): void => {
      deleteValue(f, ["imports", 0, "uncertainty"]);
    },
    (f): void => {
      setValue(f, ["imports", 0, "nodeId"], "node:list-item");
    },
    (f): void => {
      setValue(f, ["imports", 0, "range", "sourceId"], "source:missing");
    },
    (f): void => {
      setValue(f, ["imports", 0, "rawSpecifier"], "");
    },
    (f): void => {
      setValue(f, ["imports", 0, "targetKind"], "unknown");
    },
    (f): void => {
      setValue(f, ["statements", 0], null);
    },
    (f): void => {
      setValue(f, ["statements", 0, "nodeIds"], []);
    },
    (f): void => {
      setValue(f, ["statements", 0, "nodeIds"], ["node:missing"]);
    },
    (f): void => {
      deleteValue(f, ["statements", 0, "range"]);
    },
    (f): void => {
      deleteValue(f, ["statements", 0, "classification"]);
    },
    (f): void => {
      setValue(f, ["statements", 0, "classification"], null);
    },
    (f): void => {
      setValue(f, ["statements", 0, "classification", "state"], "unknown");
    },
    (f): void => {
      setValue(f, ["statements", 0, "classification"], { state: "classified" });
    },
    (f): void => {
      setValue(f, ["activationRules", 0], null);
    },
    (f): void => {
      setValue(f, ["activationRules", 0, "include"], [null]);
    },
    (f): void => {
      setValue(f, ["activationRules", 0, "include", 0, "kind"], "directory-tree");
    },
    (f): void => {
      setValue(f, ["activationRules", 0, "include", 0, "path"], "../outside");
    },
    (f): void => {
      deleteValue(f, ["activationRules", 0, "include", 0, "sourceRange"]);
    },
    (f): void => {
      setValue(f, ["activationRules", 0, "conditions"], [""]);
    },
    (f): void => {
      setValue(f, ["activationRules", 0, "conditions"], {});
    },
    (f): void => {
      deleteValue(f, ["activationRules", 0, "unknownReason"]);
    },
    (f): void => {
      setValue(f, ["activationRules", 0, "evidenceRefs"], [null]);
    },
    (f): void => {
      setValue(f, ["activationRules", 0, "evidenceRefs", 0, "factId"], "bad id");
    },
    (f): void => {
      setValue(f, ["targets", 0], null);
    },
    (f): void => {
      setValue(f, ["events", 0], null);
    },
    (f): void => {
      deleteValue(f, ["events", 0, "id"]);
    },
    (f): void => {
      deleteValue(f, ["events", 0, "sequence"]);
    },
    (f): void => {
      setValue(f, ["events", 0, "sequence"], -1);
    },
    (f): void => {
      deleteValue(f, ["events", 0, "targetId"]);
    },
    (f): void => {
      setValue(f, ["events", 0, "targetId"], "bad id");
    },
    (f): void => {
      deleteValue(f, ["events", 0, "uncertainty"]);
    },
    (f): void => {
      setValue(f, ["events", 0, "path"], "../outside");
    },
    (f): void => {
      setValue(f, ["events", 0, "workspaceRoots"], []);
    },
    (f): void => {
      setValue(f, ["events", 0, "workspaceRoots"], [".", "."]);
    },
    (f): void => {
      setValue(f, ["events", 0, "workspaceRoots"], ["../outside"]);
    },
    (f): void => {
      setValue(f, ["events", 0, "settings"], null);
    },
    (f): void => {
      setValue(f, ["events", 0, "settings"], [null]);
    },
    (f): void => {
      deleteValue(f, ["events", 0, "settings", 0, "key"]);
    },
    (f): void => {
      setValue(f, ["events", 0, "settings", 0, "key"], 1);
    },
  ];

  test("rejects every malformed boundary without throwing", () => {
    for (const [index, mutate] of mutations.entries()) {
      const fixture = cloneValid();
      mutate(fixture);
      expect(validateInstructionIr(fixture).ok, `mutation ${String(index)}`).toBe(false);
    }
  });
});
