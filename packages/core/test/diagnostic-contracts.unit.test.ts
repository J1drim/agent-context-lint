import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { describe, expect, test } from "vitest";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  DIAGNOSTIC_SEVERITIES,
  FIX_OPERATION_KINDS,
  MAX_DIAGNOSTIC_TEXT_BYTES,
  MAX_FIX_OPERATIONS_PER_PLAN,
  MAX_DIAGNOSTIC_JSON_CONTAINER_ENTRIES,
  MAX_DIAGNOSTIC_JSON_STRING_BYTES,
  MAX_DIAGNOSTIC_JSON_TOTAL_STRING_BYTES,
  MAX_RELATED_EVIDENCE_PER_DIAGNOSTIC,
  MAX_VALIDATION_ISSUES,
  PATH_FINGERPRINT_METHOD,
  RELATED_EVIDENCE_KINDS,
  SEMANTIC_FINGERPRINT_METHOD,
  SUPPRESSION_STATES,
  VALIDATION_ISSUE_LIMIT_CODE,
  computePathFingerprint,
  computeSemanticFingerprint,
  isDiagnosticBundle,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "../src/index.js";
import type {
  DiagnosticBundle,
  DiagnosticContractValidationCode,
  RepositoryRelativePath,
  SourceDocument,
} from "../src/index.js";

type PathSegment = number | string;

const VALID_FIXTURE = new URL("./fixtures/diagnostics.valid.json", import.meta.url);
const INVALID_FIXTURE = new URL("./fixtures/diagnostics.invalid.json", import.meta.url);
const IR_FIXTURE = new URL("./fixtures/instruction-ir.valid.json", import.meta.url);
const SCHEMA = new URL("../schemas/diagnostic-contract.v0.schema.json", import.meta.url);

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function sourceDocuments(): readonly SourceDocument[] {
  const result = validateInstructionIr(readJson(IR_FIXTURE));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value.sources;
}

function validatedBundle(): DiagnosticBundle {
  const result = validateDiagnosticBundle(readJson(VALID_FIXTURE), sourceDocuments());
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
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
  let parent = root;
  for (const segment of path.slice(0, -1)) parent = child(parent, segment);
  const key = path.at(-1);
  if (typeof key !== "string" || parent === null || typeof parent !== "object") {
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

function expectIssue(
  input: unknown,
  path: string,
  code?: DiagnosticContractValidationCode,
  sources: readonly SourceDocument[] = sourceDocuments(),
): void {
  const result = validateDiagnosticBundle(input, sources);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid diagnostic bundle");
  expect(
    result.issues.some(
      (issue) =>
        (code === undefined || issue.code === code) &&
        (issue.path === path || (path.length > 1_024 && path.startsWith(`${issue.path}.value`))),
    ),
    JSON.stringify(result.issues),
  ).toBe(true);
}

function diagnostic(input: unknown): Record<string, unknown> {
  return asRecord(child(child(input, "diagnostics"), 0));
}

function fixOperations(input: unknown): unknown[] {
  const operations = child(child(child(diagnostic(input), "suggestion"), "fixPlan"), "operations");
  if (!Array.isArray(operations)) throw new TypeError("expected operations");
  return operations;
}

function withRecomputedFingerprints(input: unknown): void {
  const value = diagnostic(input);
  const primary = asRecord(value["primary"]);
  const basis = asRecord(value["fingerprintBasis"]);
  const pathBasis = asRecord(basis["path"]);
  const semanticBasis = asRecord(basis["semantic"]);
  const fingerprints = asRecord(value["fingerprints"]);
  asRecord(fingerprints["path"])["value"] = computePathFingerprint({
    ruleId: value["ruleId"] as string,
    ruleVersion: value["ruleVersion"] as string,
    path: primary["path"] as RepositoryRelativePath,
    basis: pathBasis as never,
  });
  asRecord(fingerprints["semantic"])["value"] = computeSemanticFingerprint({
    ruleId: value["ruleId"] as string,
    ruleVersion: value["ruleVersion"] as string,
    basis: semanticBasis as never,
  });
}

describe("published B04 schema and vocabulary", () => {
  test("publishes a strict Draft 2020-12 schema that accepts the positive fixture", () => {
    const schema = readJson(SCHEMA) as AnySchema;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    expect(validate(readJson(VALID_FIXTURE)), JSON.stringify(validate.errors)).toBe(true);
  });

  test("schema rejects the maintained negative fixture and unknown fields", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(readJson(SCHEMA) as AnySchema);
    expect(validate(readJson(INVALID_FIXTURE))).toBe(false);
    expect(
      validate.errors?.some(
        (error: { readonly keyword: string }) => error.keyword === "additionalProperties",
      ),
    ).toBe(true);
  });

  test("exports the closed contract vocabulary and limits", () => {
    expect(DIAGNOSTIC_CONTRACT_VERSION).toBe("0.1.0");
    expect(DIAGNOSTIC_SEVERITIES).toEqual(["error", "warning", "info"]);
    expect(RELATED_EVIDENCE_KINDS).toEqual(["source", "repository-fact", "resolution", "spec"]);
    expect(FIX_OPERATION_KINDS).toEqual(["text-edit", "move-document", "create-document"]);
    expect(SUPPRESSION_STATES).toEqual(["applicable", "suppressed", "unused"]);
    expect(MAX_RELATED_EVIDENCE_PER_DIAGNOSTIC).toBe(128);
    expect(MAX_FIX_OPERATIONS_PER_PLAN).toBe(1024);
  });

  test("round-trips the positive JSON fixture and narrows it", () => {
    const bundle = validatedBundle();
    expect(isDiagnosticBundle(JSON.parse(JSON.stringify(bundle)), sourceDocuments())).toBe(true);
    expect(bundle.diagnostics[0]?.related.map((evidence) => evidence.kind)).toEqual([
      "source",
      "repository-fact",
      "resolution",
      "spec",
    ]);
  });
});

describe("stable versioned fingerprints", () => {
  const pathInput = {
    ruleId: "ACL250",
    ruleVersion: "1.0.0",
    path: "AGENTS.md" as RepositoryRelativePath,
    basis: { anchor: "statement:use-paths", profileIds: ["codex-cli"] },
  } as const;
  const semanticInput = {
    ruleId: "ACL250",
    ruleVersion: "1.0.0",
    basis: {
      components: [
        { key: "category", value: "package-manager" },
        { key: "instruction", value: "use-pnpm" },
      ],
      profileIds: ["codex-cli"],
    },
  } as const;

  test("matches frozen SHA-256 vectors and distinct domains", () => {
    expect(PATH_FINGERPRINT_METHOD).toBe("agent-context-lint/path/v1");
    expect(SEMANTIC_FINGERPRINT_METHOD).toBe("agent-context-lint/semantic/v1");
    expect(computePathFingerprint(pathInput)).toBe(
      "dde482dcc539531e5e98bd71063388925f7f566e97a2cca924eb567a47072916",
    );
    expect(computeSemanticFingerprint(semanticInput)).toBe(
      "6c049bc33df348a479d475fcc462b6f98e6d17c12846a284870e22bf8894ba02",
    );
    expect(computePathFingerprint(pathInput)).not.toBe(computeSemanticFingerprint(semanticInput));
  });

  test("length-prefixing prevents concatenation-boundary collisions", () => {
    const first = computeSemanticFingerprint({
      ...semanticInput,
      basis: { components: [{ key: "a", value: "bc" }], profileIds: [] },
    });
    const second = computeSemanticFingerprint({
      ...semanticInput,
      basis: { components: [{ key: "ab", value: "c" }], profileIds: [] },
    });
    expect(first).not.toBe(second);
  });

  test("canonicalizes set-like profile and component ordering", () => {
    const forward = computeSemanticFingerprint({
      ...semanticInput,
      basis: {
        components: [
          { key: "a", value: "1" },
          { key: "b", value: "2" },
        ],
        profileIds: ["codex-cli", "gemini-cli"],
      },
    });
    const reverse = computeSemanticFingerprint({
      ...semanticInput,
      basis: {
        components: [
          { key: "b", value: "2" },
          { key: "a", value: "1" },
        ],
        profileIds: ["gemini-cli", "codex-cli"],
      },
    });
    expect(reverse).toBe(forward);
  });

  test("uses exact Unicode code points without implicit normalization", () => {
    const composed = computeSemanticFingerprint({
      ...semanticInput,
      basis: { components: [{ key: "text", value: "café" }], profileIds: [] },
    });
    const decomposed = computeSemanticFingerprint({
      ...semanticInput,
      basis: { components: [{ key: "text", value: "café" }], profileIds: [] },
    });
    expect(composed).not.toBe(decomposed);
  });

  test("path identity changes on moves while semantic identity survives", () => {
    expect(
      computePathFingerprint({
        ...pathInput,
        path: "packages/api/AGENTS.md" as RepositoryRelativePath,
      }),
    ).not.toBe(computePathFingerprint(pathInput));
    expect(computeSemanticFingerprint(semanticInput)).toBe(
      computeSemanticFingerprint(structuredClone(semanticInput)),
    );
  });

  test("message and absolute coordinate shifts do not participate", () => {
    const bundle = validatedBundle();
    const original = bundle.diagnostics[0];
    if (original === undefined) throw new TypeError("fixture diagnostic missing");
    const changed = {
      ...original,
      message: "Reworded diagnostic",
      primary: {
        ...original.primary,
        range: {
          ...original.primary.range,
          start: { ...original.primary.range.start, line: 999, byteOffset: 999 },
        },
      },
    };
    expect(changed.fingerprints).toEqual(original.fingerprints);
  });

  test("rejects duplicate semantic keys, malformed Unicode, and absolute paths", () => {
    expect(() =>
      computeSemanticFingerprint({
        ...semanticInput,
        basis: {
          components: [
            { key: "same", value: "1" },
            { key: "same", value: "2" },
          ],
          profileIds: [],
        },
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      computeSemanticFingerprint({
        ...semanticInput,
        basis: { components: [{ key: "text", value: "\ud800" }], profileIds: [] },
      }),
    ).toThrow(/well-formed/);
    expect(() =>
      computePathFingerprint({ ...pathInput, path: "/tmp/AGENTS.md" as RepositoryRelativePath }),
    ).toThrow(/repository-relative/);
  });

  test("is deterministic over a seeded property matrix", () => {
    let state = 0x1a2b3c4d;
    for (let index = 0; index < 500; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const value = `v:${state.toString(16)}:🧭`;
      const input = {
        ...semanticInput,
        basis: { components: [{ key: "value", value }], profileIds: ["codex-cli"] },
      };
      expect(computeSemanticFingerprint(input)).toBe(computeSemanticFingerprint(input));
    }
  });
});

describe("strict envelope and exact B03 source links", () => {
  test.each(["recordKind", "contractVersion", "diagnostics", "suppressions"])(
    "requires %s",
    (key) => {
      const input = cloneValid();
      deleteValue(input, [key]);
      expectIssue(input, `$.${key}`, "missing-field");
    },
  );

  test("rejects the maintained malformed fixture", () => {
    expectIssue(readJson(INVALID_FIXTURE), "$.diagnostics[0].unexpected", "unknown-field");
    expectIssue(readJson(INVALID_FIXTURE), "$.diagnostics[0].severity", "invalid-state");
  });

  test.each([
    [
      ["diagnostics", 0, "primary", "sourceId"],
      "source:missing",
      "$.diagnostics[0].primary.sourceId",
      "invalid-relationship",
    ],
    [
      ["diagnostics", 0, "primary", "path"],
      "wrong.md",
      "$.diagnostics[0].primary.path",
      "invalid-relationship",
    ],
    [
      ["diagnostics", 0, "primary", "sourceDigest"],
      "0".repeat(64),
      "$.diagnostics[0].primary.sourceDigest",
      "invalid-digest",
    ],
    [
      ["diagnostics", 0, "primary", "range", "start", "utf16Offset"],
      14,
      "$.diagnostics[0].primary.range.start",
      "invalid-range",
    ],
    [
      ["diagnostics", 0, "primary", "range", "sourceId"],
      "source:wrong",
      "$.diagnostics[0].primary.range.sourceId",
      "invalid-range",
    ],
  ] as const)("rejects mismatched exact source fact %j", (path, value, issuePath, code) => {
    const input = cloneValid();
    setValue(input, path, value);
    expectIssue(input, issuePath, code);
  });

  test("recomputes both fingerprints and rejects forged values", () => {
    const input = cloneValid();
    setValue(input, ["diagnostics", 0, "fingerprints", "path", "value"], "0".repeat(64));
    setValue(input, ["diagnostics", 0, "fingerprints", "semantic", "value"], "1".repeat(64));
    expectIssue(input, "$.diagnostics[0].fingerprints.path.value", "invalid-fingerprint");
    expectIssue(input, "$.diagnostics[0].fingerprints.semantic.value", "invalid-fingerprint");
  });

  test("requires canonical fingerprint-basis ordering", () => {
    const input = cloneValid();
    setValue(
      input,
      ["diagnostics", 0, "fingerprintBasis", "path", "profileIds"],
      ["gemini-cli", "codex-cli"],
    );
    withRecomputedFingerprints(input);
    expectIssue(input, "$.diagnostics[0].fingerprintBasis.path.profileIds[1]", "invalid-order");
  });

  test("validates calendar dates and credential-free HTTPS spec provenance", () => {
    const invalidDate = cloneValid();
    setValue(invalidDate, ["diagnostics", 0, "related", 3, "retrievedAt"], "2026-02-30");
    expectIssue(invalidDate, "$.diagnostics[0].related[3].retrievedAt", "invalid-date");
    const invalidUrl = cloneValid();
    setValue(
      invalidUrl,
      ["diagnostics", 0, "related", 3, "url"],
      "https://user:secret@example.com/spec",
    );
    expectIssue(invalidUrl, "$.diagnostics[0].related[3].url", "invalid-value");
  });

  test("rejects duplicate related evidence IDs", () => {
    const input = cloneValid();
    setValue(input, ["diagnostics", 0, "related", 1, "id"], "evidence:source");
    expectIssue(input, "$.diagnostics[0].related[1].id", "duplicate-id");
  });
});

describe("atomic fix plans", () => {
  test("accepts bounded text edits and create-document in canonical order", () => {
    expect(
      validatedBundle().diagnostics[0]?.suggestion?.fixPlan?.operations.map((item) => item.kind),
    ).toEqual(["text-edit", "create-document"]);
  });

  test("accepts move-document with exact source digest and absent destination", () => {
    const input = cloneValid();
    setValue(
      input,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations"],
      [
        {
          kind: "move-document",
          sourceId: "source:agents",
          path: "AGENTS.md",
          sourceDigest: "28cb206cb6284d0a1d68044875f92c5d9011613a92ca523127137696276ef45c",
          destinationPath: "docs/AGENTS.md",
          destinationPrecondition: "absent",
        },
      ],
    );
    expect(validateDiagnosticBundle(input, sourceDocuments()).ok).toBe(true);
  });

  test.each([
    ["sourceId", "source:missing", "invalid-relationship"],
    ["path", "wrong.md", "invalid-relationship"],
    ["sourceDigest", "0".repeat(64), "invalid-digest"],
  ] as const)("rejects text-edit source %s mismatch", (key, value, code) => {
    const input = cloneValid();
    setValue(input, ["diagnostics", 0, "suggestion", "fixPlan", "operations", 0, key], value);
    expectIssue(input, `$.diagnostics[0].suggestion.fixPlan.operations[0].${key}`, code);
  });

  test("rejects text-edit ranges that do not agree with the exact source", () => {
    const input = cloneValid();
    setValue(
      input,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations", 0, "range", "end", "byteOffset"],
      27,
    );
    expectIssue(
      input,
      "$.diagnostics[0].suggestion.fixPlan.operations[0].range.end",
      "invalid-range",
    );
  });

  test("recomputes create-document content digests", () => {
    const input = cloneValid();
    setValue(
      input,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations", 1, "contentDigest"],
      "0".repeat(64),
    );
    expectIssue(
      input,
      "$.diagnostics[0].suggestion.fixPlan.operations[1].contentDigest",
      "invalid-digest",
    );
  });

  test("rejects unordered and overlapping edits including same-position insertions", () => {
    const input = cloneValid();
    const first = structuredClone(fixOperations(input)[0]);
    fixOperations(input).splice(0, 1, structuredClone(first), structuredClone(first));
    expectIssue(input, "$.diagnostics[0].suggestion.fixPlan.operations[1]", "invalid-order");
    expectIssue(
      input,
      "$.diagnostics[0].suggestion.fixPlan.operations[1].range",
      "overlapping-edit",
    );
  });

  test("rejects create/move destination collisions", () => {
    const input = cloneValid();
    setValue(
      input,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations"],
      [
        {
          kind: "move-document",
          sourceId: "source:agents",
          path: "AGENTS.md",
          sourceDigest: "28cb206cb6284d0a1d68044875f92c5d9011613a92ca523127137696276ef45c",
          destinationPath: "docs/policy.md",
          destinationPrecondition: "absent",
        },
        {
          kind: "create-document",
          path: "docs/policy.md",
          destinationPrecondition: "absent",
          content: "",
          contentDigest: createHash("sha256").update("").digest("hex"),
        },
      ],
    );
    expectIssue(input, "$.diagnostics[0].suggestion.fixPlan.operations[1]", "invalid-relationship");
  });

  test("rejects create and move destinations that are already known sources", () => {
    const create = cloneValid();
    setValue(
      create,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations"],
      [
        {
          kind: "create-document",
          path: "AGENTS.md",
          destinationPrecondition: "absent",
          content: "",
          contentDigest: createHash("sha256").update("").digest("hex"),
        },
      ],
    );
    expectIssue(
      create,
      "$.diagnostics[0].suggestion.fixPlan.operations[0].path",
      "invalid-relationship",
    );

    const existing = sourceDocuments()[0];
    if (existing === undefined) throw new Error("expected source fixture");
    const second: SourceDocument = {
      ...existing,
      id: "source:existing" as SourceDocument["id"],
      path: "docs/existing.md" as RepositoryRelativePath,
    };
    const sources = [existing, second] as const;
    const move = cloneValid();
    setValue(
      move,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations"],
      [
        {
          kind: "move-document",
          sourceId: "source:agents",
          path: "AGENTS.md",
          sourceDigest: existing.sha256,
          destinationPath: "docs/existing.md",
          destinationPrecondition: "absent",
        },
      ],
    );
    expectIssue(
      move,
      "$.diagnostics[0].suggestion.fixPlan.operations[0].destinationPath",
      "invalid-relationship",
      sources,
    );
  });

  test("rejects move chains whose destination is only vacated by another operation", () => {
    const existing = sourceDocuments()[0];
    if (existing === undefined) throw new Error("expected source fixture");
    const second: SourceDocument = {
      ...existing,
      id: "source:existing" as SourceDocument["id"],
      path: "docs/existing.md" as RepositoryRelativePath,
    };
    const input = cloneValid();
    setValue(
      input,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations"],
      [
        {
          kind: "move-document",
          sourceId: "source:agents",
          path: "AGENTS.md",
          sourceDigest: existing.sha256,
          destinationPath: "docs/existing.md",
          destinationPrecondition: "absent",
        },
        {
          kind: "move-document",
          sourceId: "source:existing",
          path: "docs/existing.md",
          sourceDigest: second.sha256,
          destinationPath: "moved.md",
          destinationPrecondition: "absent",
        },
      ],
    );
    expectIssue(
      input,
      "$.diagnostics[0].suggestion.fixPlan.operations[0].destinationPath",
      "invalid-relationship",
      [existing, second],
    );
  });

  test("rejects edit+move of the same source because application phases are not implicit", () => {
    const input = cloneValid();
    const edit = structuredClone(fixOperations(input)[0]);
    setValue(
      input,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations"],
      [
        edit,
        {
          kind: "move-document",
          sourceId: "source:agents",
          path: "AGENTS.md",
          sourceDigest: "28cb206cb6284d0a1d68044875f92c5d9011613a92ca523127137696276ef45c",
          destinationPath: "moved.md",
          destinationPrecondition: "absent",
        },
      ],
    );
    expectIssue(input, "$.diagnostics[0].suggestion.fixPlan.operations", "invalid-relationship");
  });

  test("rejects a move to its source path and duplicate source moves", () => {
    const same = cloneValid();
    setValue(
      same,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations"],
      [
        {
          kind: "move-document",
          sourceId: "source:agents",
          path: "AGENTS.md",
          sourceDigest: "28cb206cb6284d0a1d68044875f92c5d9011613a92ca523127137696276ef45c",
          destinationPath: "AGENTS.md",
          destinationPrecondition: "absent",
        },
      ],
    );
    expectIssue(
      same,
      "$.diagnostics[0].suggestion.fixPlan.operations[0].destinationPath",
      "invalid-path",
    );

    const duplicate = cloneValid();
    setValue(
      duplicate,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations"],
      [
        {
          kind: "move-document",
          sourceId: "source:agents",
          path: "AGENTS.md",
          sourceDigest: "28cb206cb6284d0a1d68044875f92c5d9011613a92ca523127137696276ef45c",
          destinationPath: "a.md",
          destinationPrecondition: "absent",
        },
        {
          kind: "move-document",
          sourceId: "source:agents",
          path: "AGENTS.md",
          sourceDigest: "28cb206cb6284d0a1d68044875f92c5d9011613a92ca523127137696276ef45c",
          destinationPath: "b.md",
          destinationPrecondition: "absent",
        },
      ],
    );
    expectIssue(
      duplicate,
      "$.diagnostics[0].suggestion.fixPlan.operations[1]",
      "invalid-relationship",
    );
  });

  test("bounds replacement text by UTF-8 bytes and rejects malformed Unicode", () => {
    const oversized = cloneValid();
    setValue(
      oversized,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations", 0, "newText"],
      "🧭".repeat(Math.floor(1_048_576 / 4) + 1),
    );
    expectIssue(
      oversized,
      "$.diagnostics[0].suggestion.fixPlan.operations[0].newText",
      "resource-limit",
    );
    const malformed = cloneValid();
    setValue(
      malformed,
      ["diagnostics", 0, "suggestion", "fixPlan", "operations", 0, "newText"],
      "\ud800",
    );
    expectIssue(
      malformed,
      "$.diagnostics[0].suggestion.fixPlan.operations[0].newText",
      "invalid-json",
    );
  });
});

describe("suppression lifecycle", () => {
  test.each(["applicable", "unused"] as const)("accepts %s with no matches", (state) => {
    const input = cloneValid();
    setValue(input, ["suppressions", 0, "state"], state);
    expect(validateDiagnosticBundle(input, sourceDocuments()).ok).toBe(true);
  });

  test("accepts suppressed only with sorted matching path fingerprints", () => {
    const input = cloneValid();
    setValue(input, ["suppressions", 0, "state"], "suppressed");
    setValue(
      input,
      ["suppressions", 0, "matchedPathFingerprints"],
      ["dde482dcc539531e5e98bd71063388925f7f566e97a2cca924eb567a47072916"],
    );
    expect(validateDiagnosticBundle(input, sourceDocuments()).ok).toBe(true);
  });

  test("rejects incoherent suppression states", () => {
    const suppressed = cloneValid();
    setValue(suppressed, ["suppressions", 0, "state"], "suppressed");
    expectIssue(suppressed, "$.suppressions[0].matchedPathFingerprints", "invalid-state");
    const unused = cloneValid();
    setValue(unused, ["suppressions", 0, "matchedPathFingerprints"], ["a".repeat(64)]);
    expectIssue(unused, "$.suppressions[0].matchedPathFingerprints", "invalid-state");
  });

  test("requires unique sorted targeted rules and matched fingerprints", () => {
    const input = cloneValid();
    setValue(input, ["suppressions", 0, "targetRuleIds"], ["ACL300", "ACL250"]);
    expectIssue(input, "$.suppressions[0].targetRuleIds[1]", "invalid-order");
  });
});

describe("adversarial and resource-bounded ingress", () => {
  test("rejects accessors without invoking them", () => {
    const input = cloneValid();
    let invoked = false;
    Object.defineProperty(diagnostic(input), "message", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("must not run");
      },
    });
    expect(() => validateDiagnosticBundle(input, sourceDocuments())).not.toThrow();
    expect(invoked).toBe(false);
    expectIssue(input, "$.diagnostics[0].message", "invalid-json");
  });

  test("rejects proxies and revoked proxies without throwing", () => {
    const proxied = cloneValid();
    setValue(proxied, ["diagnostics", 0, "suggestion"], new Proxy({}, {}));
    expect(() => validateDiagnosticBundle(proxied, sourceDocuments())).not.toThrow();
    expectIssue(proxied, "$.diagnostics[0].suggestion", "invalid-json");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => validateDiagnosticBundle(revoked.proxy, sourceDocuments())).not.toThrow();
  });

  test("rejects huge sparse arrays in bounded time", () => {
    const input = cloneValid();
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    sparse[999_999_999] = diagnostic(input);
    setValue(input, ["diagnostics"], sparse);
    const started = performance.now();
    expectIssue(input, "$.diagnostics", "resource-limit");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("rejects deep containers iteratively", () => {
    const input = cloneValid();
    let value: unknown = "leaf";
    for (let depth = 0; depth < 400; depth += 1) value = { value };
    setValue(input, ["diagnostics", 0, "message"], value);
    expectIssue(
      input,
      "$.diagnostics[0].message.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value.value",
      "invalid-json",
    );
  });

  test("caps deterministic issues with the shared sentinel", () => {
    const input = asRecord(cloneValid());
    for (let index = 0; index < MAX_VALIDATION_ISSUES + 50; index += 1) {
      input[`unexpected${String(index).padStart(4, "0")}`] = true;
    }
    const first = validateDiagnosticBundle(input, sourceDocuments());
    const second = validateDiagnosticBundle(input, sourceDocuments());
    expect(first).toEqual(second);
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected validation failure");
    expect(first.issues).toHaveLength(MAX_VALIDATION_ISSUES);
    expect(first.issues.at(-1)).toEqual({
      code: VALIDATION_ISSUE_LIMIT_CODE,
      message: `validation stopped after ${String(MAX_VALIDATION_ISSUES - 1)} issues`,
      path: "$",
    });
  });

  test("bounds user-visible diagnostic text by UTF-8 bytes", () => {
    const input = cloneValid();
    setValue(
      input,
      ["diagnostics", 0, "message"],
      "🧭".repeat(Math.floor(MAX_DIAGNOSTIC_TEXT_BYTES / 4) + 1),
    );
    expectIssue(input, "$.diagnostics[0].message", "resource-limit");
  });
});

describe("closed semantic validation matrix", () => {
  test.each([
    [["recordKind"], "wrong", "$.recordKind", "invalid-state"],
    [["contractVersion"], "9.0.0", "$.contractVersion", "invalid-state"],
    [["diagnostics"], {}, "$.diagnostics", "invalid-value"],
    [
      ["diagnostics", 0, "related", 3, "factId"],
      "",
      "$.diagnostics[0].related[3].factId",
      "invalid-value",
    ],
    [
      ["diagnostics", 0, "related", 3, "revision"],
      "",
      "$.diagnostics[0].related[3].revision",
      "invalid-value",
    ],
    [
      ["diagnostics", 0, "related", 1, "subjectPath"],
      7,
      "$.diagnostics[0].related[1].subjectPath",
      "invalid-value",
    ],
    [
      ["diagnostics", 0, "related", 1, "subjectPath"],
      "/outside",
      "$.diagnostics[0].related[1].subjectPath",
      "invalid-path",
    ],
    [
      ["diagnostics", 0, "related", 1, "valueDigest"],
      "ABC",
      "$.diagnostics[0].related[1].valueDigest",
      "invalid-digest",
    ],
    [
      ["diagnostics", 0, "related", 2, "eventIds"],
      [1],
      "$.diagnostics[0].related[2].eventIds[0]",
      "invalid-value",
    ],
    [
      ["diagnostics", 0, "related", 2, "eventIds"],
      ["event:launch", "event:launch"],
      "$.diagnostics[0].related[2].eventIds[1]",
      "duplicate-id",
    ],
    [
      ["diagnostics", 0, "related", 2, "targetIds"],
      {},
      "$.diagnostics[0].related[2].targetIds",
      "invalid-value",
    ],
    [
      ["diagnostics", 0, "related", 3, "retrievedAt"],
      "2026-13-40",
      "$.diagnostics[0].related[3].retrievedAt",
      "invalid-date",
    ],
    [
      ["diagnostics", 0, "related", 3, "url"],
      "http://example.test",
      "$.diagnostics[0].related[3].url",
      "invalid-value",
    ],
    [
      ["diagnostics", 0, "suggestion", "fixPlan", "operations"],
      [],
      "$.diagnostics[0].suggestion.fixPlan.operations",
      "invalid-value",
    ],
    [
      ["diagnostics", 0, "suggestion", "fixPlan", "safety"],
      "unsafe",
      "$.diagnostics[0].suggestion.fixPlan.safety",
      "invalid-state",
    ],
    [
      ["diagnostics", 0, "suggestion", "fixPlan", "application"],
      "sequential",
      "$.diagnostics[0].suggestion.fixPlan.application",
      "invalid-state",
    ],
    [
      ["diagnostics", 0, "suggestion", "fixPlan", "operations", 0, "kind"],
      "delete-document",
      "$.diagnostics[0].suggestion.fixPlan.operations[0].kind",
      "invalid-state",
    ],
    [
      ["diagnostics", 0, "suggestion", "fixPlan", "operations", 1, "destinationPrecondition"],
      "present",
      "$.diagnostics[0].suggestion.fixPlan.operations[1].destinationPrecondition",
      "invalid-state",
    ],
    [
      ["diagnostics", 0, "fingerprints", "path", "method"],
      "agent-context-lint/path/v9",
      "$.diagnostics[0].fingerprints.path.method",
      "invalid-state",
    ],
    [
      ["diagnostics", 0, "fingerprints", "path", "value"],
      "ABC",
      "$.diagnostics[0].fingerprints.path.value",
      "invalid-fingerprint",
    ],
    [
      ["diagnostics", 0, "fingerprintBasis", "semantic", "components"],
      [],
      "$.diagnostics[0].fingerprintBasis.semantic.components",
      "invalid-value",
    ],
    [
      ["diagnostics", 0, "fingerprintBasis", "semantic", "components"],
      [
        { key: "z", value: "1" },
        { key: "a", value: "2" },
      ],
      "$.diagnostics[0].fingerprintBasis.semantic.components[1].key",
      "invalid-order",
    ],
    [["suppressions", 0, "targetRuleIds"], [], "$.suppressions[0].targetRuleIds", "invalid-value"],
    [
      ["suppressions", 0, "matchedPathFingerprints"],
      ["not-a-fingerprint"],
      "$.suppressions[0].matchedPathFingerprints[0]",
      "invalid-fingerprint",
    ],
    [
      ["suppressions", 0, "matchedPathFingerprints"],
      ["0".repeat(64)],
      "$.suppressions[0].matchedPathFingerprints[0]",
      "invalid-relationship",
    ],
  ] as const)("rejects semantic mutation at %j", (path, value, issuePath, code) => {
    const input = cloneValid();
    setValue(input, path, value);
    expectIssue(input, issuePath, code);
  });

  test.each([
    [["diagnostics", 0, "related", 0, "location"], "$.diagnostics[0].related[0].location"],
    [["diagnostics", 0, "related", 1, "subjectPath"], "$.diagnostics[0].related[1].subjectPath"],
    [["diagnostics", 0, "related", 2, "uncertainty"], "$.diagnostics[0].related[2].uncertainty"],
    [["diagnostics", 0, "related", 3, "factId"], "$.diagnostics[0].related[3].factId"],
    [["diagnostics", 0, "related", 3, "revision"], "$.diagnostics[0].related[3].revision"],
    [["diagnostics", 0, "primary", "range"], "$.diagnostics[0].primary.range"],
    [["diagnostics", 0, "suggestion"], "$.diagnostics[0].suggestion"],
    [["diagnostics", 0, "suggestion", "fixPlan"], "$.diagnostics[0].suggestion.fixPlan"],
    [["diagnostics", 0, "fingerprintBasis"], "$.diagnostics[0].fingerprintBasis"],
    [["suppressions", 0, "directive"], "$.suppressions[0].directive"],
    [["suppressions", 0, "reason"], "$.suppressions[0].reason"],
  ] as const)("requires explicit field at %j", (path, issuePath) => {
    const input = cloneValid();
    deleteValue(input, path);
    expectIssue(input, issuePath, "missing-field");
  });

  test("rejects malformed evidence, fix operations, roots, and source registries", () => {
    const evidence = cloneValid();
    setValue(evidence, ["diagnostics", 0, "related", 0], null);
    expectIssue(evidence, "$.diagnostics[0].related[0]", "invalid-value");

    const operation = cloneValid();
    setValue(operation, ["diagnostics", 0, "suggestion", "fixPlan", "operations", 0], null);
    expectIssue(operation, "$.diagnostics[0].suggestion.fixPlan.operations[0]", "invalid-value");

    expectIssue(null, "$", "invalid-value");
    expectIssue(cloneValid(), "$sources[0]", "invalid-value", [null as never]);

    const source = sourceDocuments()[0];
    if (source === undefined) throw new Error("expected source fixture");
    expectIssue(cloneValid(), "$sources[1].id", "duplicate-id", [source, source]);
  });

  test("aligns nullable identifiers and bounded prose with the published schema", () => {
    for (const [path, issuePath] of [
      [
        ["diagnostics", 0, "related", 2, "evidenceRefs", 0, "factId"],
        "$.diagnostics[0].related[2].evidenceRefs[0].factId",
      ],
      [["diagnostics", 0, "related", 3, "factId"], "$.diagnostics[0].related[3].factId"],
    ] as const) {
      const input = cloneValid();
      setValue(input, path, "fact with spaces");
      expectIssue(input, issuePath, "invalid-value");
    }

    for (const [path, issuePath, uncertainty] of [
      [
        ["diagnostics", 0, "related", 2, "uncertainty", "reason"],
        "$.diagnostics[0].related[2].uncertainty.reason",
        true,
      ],
      [["diagnostics", 0, "related", 3, "revision"], "$.diagnostics[0].related[3].revision", false],
      [["suppressions", 0, "reason"], "$.suppressions[0].reason", false],
    ] as const) {
      const input = cloneValid();
      if (uncertainty) {
        setValue(input, ["diagnostics", 0, "related", 2, "uncertainty"], {
          state: "unknown",
          reason: "x".repeat(MAX_DIAGNOSTIC_TEXT_BYTES + 1),
        });
      } else {
        setValue(input, path, "x".repeat(MAX_DIAGNOSTIC_TEXT_BYTES + 1));
      }
      expectIssue(input, issuePath, "invalid-value");
    }

    const malformed = cloneValid();
    setValue(malformed, ["diagnostics", 0, "related", 2, "uncertainty"], {
      state: "unknown",
      reason: "\ud800",
    });
    expectIssue(malformed, "$.diagnostics[0].related[2].uncertainty.reason", "invalid-json");
  });

  test("keeps schema and runtime aligned at identifier, prose, and Unicode boundaries", () => {
    const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(
      readJson(SCHEMA) as AnySchema,
    );
    const invalid: unknown[] = [];

    for (const path of [
      ["diagnostics", 0, "related", 2, "evidenceRefs", 0, "factId"],
      ["diagnostics", 0, "related", 3, "factId"],
    ] as const) {
      const input = cloneValid();
      setValue(input, path, "fact with spaces");
      invalid.push(input);
    }

    const uncertainty = cloneValid();
    setValue(uncertainty, ["diagnostics", 0, "related", 2, "uncertainty"], {
      state: "unknown",
      reason: "x".repeat(MAX_DIAGNOSTIC_TEXT_BYTES + 1),
    });
    invalid.push(uncertainty);

    const malformed = cloneValid();
    setValue(malformed, ["diagnostics", 0, "related", 2, "uncertainty"], {
      state: "unknown",
      reason: "\ud800",
    });
    invalid.push(malformed);

    for (const path of [
      ["diagnostics", 0, "related", 3, "revision"],
      ["suppressions", 0, "reason"],
    ] as const) {
      const input = cloneValid();
      setValue(input, path, "x".repeat(MAX_DIAGNOSTIC_TEXT_BYTES + 1));
      invalid.push(input);
    }

    for (const input of invalid) {
      expect(validateSchema(input), JSON.stringify(validateSchema.errors)).toBe(false);
      expect(validateDiagnosticBundle(input, sourceDocuments()).ok).toBe(false);
    }

    const maximum = cloneValid();
    const maximumText = "x".repeat(MAX_DIAGNOSTIC_TEXT_BYTES);
    setValue(maximum, ["diagnostics", 0, "related", 2, "uncertainty"], {
      state: "unknown",
      reason: maximumText,
    });
    setValue(maximum, ["diagnostics", 0, "related", 3, "revision"], maximumText);
    setValue(maximum, ["suppressions", 0, "reason"], maximumText);
    expect(validateSchema(maximum), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(validateDiagnosticBundle(maximum, sourceDocuments()).ok).toBe(true);
  });

  test("preserves event chronology while canonicalizing resolution target and rule sets", () => {
    const chronological = cloneValid();
    setValue(chronological, ["diagnostics", 0, "related", 2, "eventIds"], ["event:z", "event:a"]);
    expect(validateDiagnosticBundle(chronological, sourceDocuments()).ok).toBe(true);

    for (const [field, issuePath] of [
      ["targetIds", "$.diagnostics[0].related[2].targetIds[1]"],
      ["activationRuleIds", "$.diagnostics[0].related[2].activationRuleIds[1]"],
    ] as const) {
      const input = cloneValid();
      setValue(input, ["diagnostics", 0, "related", 2, field], ["z:id", "a:id"]);
      expectIssue(input, issuePath, "invalid-order");
    }
  });

  test("bounds issue volume, dense collections, individual strings, and cumulative text", () => {
    const invalidSources = Array.from({ length: MAX_VALIDATION_ISSUES + 50 }, () => null);
    const sourceResult = validateDiagnosticBundle(cloneValid(), invalidSources as never);
    expect(sourceResult.ok).toBe(false);
    if (sourceResult.ok) throw new Error("expected invalid sources");
    expect(sourceResult.issues).toHaveLength(MAX_VALIDATION_ISSUES);
    expect(sourceResult.issues.at(-1)?.code).toBe(VALIDATION_ISSUE_LIMIT_CODE);

    const dense = cloneValid();
    setValue(
      dense,
      ["diagnostics"],
      new Array(MAX_DIAGNOSTIC_JSON_CONTAINER_ENTRIES + 1).fill(null),
    );
    expectIssue(dense, "$.diagnostics", "resource-limit");

    const oneHugeString = cloneValid();
    setValue(
      oneHugeString,
      ["diagnostics", 0, "message"],
      "x".repeat(MAX_DIAGNOSTIC_JSON_STRING_BYTES + 1),
    );
    expectIssue(oneHugeString, "$.diagnostics[0].message", "resource-limit");

    const cumulative = cloneValid();
    const chunk = "x".repeat(MAX_DIAGNOSTIC_JSON_STRING_BYTES);
    setValue(
      cumulative,
      ["diagnostics"],
      new Array(
        Math.floor(MAX_DIAGNOSTIC_JSON_TOTAL_STRING_BYTES / MAX_DIAGNOSTIC_JSON_STRING_BYTES) + 1,
      ).fill(chunk),
    );
    const cumulativeResult = validateDiagnosticBundle(cumulative, sourceDocuments());
    expect(cumulativeResult.ok).toBe(false);
    if (cumulativeResult.ok) throw new Error("expected cumulative text rejection");
    expect(cumulativeResult.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "resource-limit" })]),
    );
  });
});
