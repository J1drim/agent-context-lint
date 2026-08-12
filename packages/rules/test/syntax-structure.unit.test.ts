import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
  computePathFingerprint,
  computeSemanticFingerprint,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import {
  MECHANICAL_FIX_SAFETY_MATRIX,
  REQUIRED_RULE_IDS,
  RULE_REGISTRY,
  evaluateSyntaxStructureRules,
  finalizeSyntaxSuppressions,
  isMechanicalFixSafetyMatrix,
  planApprovedMechanicalFixes,
  renderMechanicalFixSafetyMarkdown,
  validateMechanicalFixSafetyMatrix,
} from "../src/index.js";

import type {
  AstNode,
  AstNodeId,
  Diagnostic,
  DiagnosticId,
  InstructionIr,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
} from "@agent-context/core";
import type { SyntaxDocumentPolicy, SyntaxStructureRuleInput } from "../src/index.js";

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

function positionAt(text: string, offset: number): SourcePosition {
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
    line,
    utf16Column: offset - lineStart,
    utf16Offset: offset,
  };
}

function nodesOf(sourceId: SourceDocumentId, text: string): readonly AstNode[] {
  const children: AstNode[] = [];
  for (const [index, match] of [...text.matchAll(/[^\r\n]+/gu)].entries()) {
    const value = match[0];
    const start = match.index;
    children.push({
      childIds: [],
      id: `node:test:${String(index)}` as AstNodeId,
      kind:
        value.trimStart().startsWith("<!--") && value.trimEnd().endsWith("-->")
          ? "html-comment"
          : "paragraph",
      range: {
        end: positionAt(text, start + value.length),
        sourceId,
        start: positionAt(text, start),
      },
      sourceId,
    });
  }
  return [
    {
      childIds: children.map((node) => node.id),
      id: "node:test:root" as AstNodeId,
      kind: "root",
      range: {
        end: positionAt(text, text.length),
        sourceId,
        start: positionAt(text, 0),
      },
      sourceId,
    },
    ...children,
  ];
}

function irOf(
  text: string,
  path = ".github/instructions/test.instructions.md",
  exactHtmlComment?: { readonly end: number; readonly start: number },
): InstructionIr {
  const sourceId = "source:test" as SourceDocumentId;
  const nodes =
    exactHtmlComment === undefined
      ? nodesOf(sourceId, text)
      : [
          {
            childIds: ["node:test:exact-comment" as AstNodeId],
            id: "node:test:root" as AstNodeId,
            kind: "root" as const,
            range: {
              end: positionAt(text, text.length),
              sourceId,
              start: positionAt(text, 0),
            },
            sourceId,
          },
          {
            childIds: [],
            id: "node:test:exact-comment" as AstNodeId,
            kind: "html-comment" as const,
            range: {
              end: positionAt(text, exactHtmlComment.end),
              sourceId,
              start: positionAt(text, exactHtmlComment.start),
            },
            sourceId,
          },
        ];
  const source: SourceDocument = {
    bom: "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: sourceId,
    lineEnding: lineEndingOf(text),
    parseState: { state: "complete" },
    path: path as RepositoryRelativePath,
    rootNodeId: "node:test:root" as AstNodeId,
    sha256: createHash("sha256").update(text).digest("hex"),
    text,
    utf16Length: text.length,
  };
  const candidate: InstructionIr = {
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: [],
    events: [],
    imports: [],
    nodes,
    recordKind: "agent-context-instruction-ir",
    sources: [source],
    statements: [],
    targets: [],
  };
  const validation = validateInstructionIr(candidate);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

const evidence = Object.freeze({
  evidenceRefId: "fixture:profile-evidence",
  retrievedAt: "2026-08-02",
  revision: "fixture-v1",
  url: "https://example.test/profile/syntax",
});

function policy(overrides: Partial<SyntaxDocumentPolicy> = {}): SyntaxDocumentPolicy {
  return {
    dialect: "yaml",
    fields: [
      { globSyntax: "none", name: "count", types: ["number"] },
      { globSyntax: "none", name: "description", types: ["string"] },
      { globSyntax: "path-glob-v1", name: "globs", types: ["string", "string-array"] },
    ],
    format: [],
    location: [],
    sourceId: "source:test",
    vendorId: "fixture-vendor",
    ...overrides,
  };
}

function input(
  text: string,
  overrides: Partial<SyntaxDocumentPolicy> = {},
): SyntaxStructureRuleInput {
  return {
    contractVersion: "0.1.0",
    documents: [policy(overrides)],
    ir: irOf(text),
    recordKind: "agent-context-syntax-structure-rule-input",
  };
}

function twoSourceInput(firstText: string, secondText = firstText): SyntaxStructureRuleInput {
  const first = irOf(firstText, ".claude/rules/first.md");
  const second = irOf(secondText, ".claude/rules/second.md");
  const firstSource = first.sources[0];
  const sourceToRemap = second.sources[0];
  if (firstSource === undefined || sourceToRemap === undefined)
    throw new Error("two-source fixture parser returned no source");
  const secondSourceId = "source:second" as SourceDocumentId;
  const secondNodeId = (id: AstNodeId): AstNodeId =>
    id.replace("node:test", "node:second") as AstNodeId;
  const secondNodes = second.nodes.map((node) => ({
    ...node,
    childIds: node.childIds.map(secondNodeId),
    id: secondNodeId(node.id),
    range: { ...node.range, sourceId: secondSourceId },
    sourceId: secondSourceId,
  }));
  const secondSource = {
    ...sourceToRemap,
    id: secondSourceId,
    rootNodeId: secondNodeId(sourceToRemap.rootNodeId),
  } as SourceDocument;
  const candidate: InstructionIr = {
    ...first,
    nodes: [...first.nodes, ...secondNodes],
    sources: [...first.sources, secondSource],
  };
  const validated = validateInstructionIr(candidate);
  if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
  return {
    contractVersion: "0.1.0",
    documents: [policy({ sourceId: firstSource.id }), policy({ sourceId: secondSourceId })],
    ir: validated.value,
    recordKind: "agent-context-syntax-structure-rule-input",
  };
}

function ruleIds(text: string, overrides: Partial<SyntaxDocumentPolicy> = {}): readonly string[] {
  const result = evaluateSyntaxStructureRules(input(text, overrides));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(validateDiagnosticBundle(result.bundle, result.sources).ok).toBe(true);
  return result.bundle.diagnostics.map((diagnostic) => diagnostic.ruleId);
}

describe("F05 syntax and structure rules", () => {
  test("keeps identical cross-path findings semantically stable and uniquely addressable", () => {
    const invalid = "---\ncount: many\n---\nBody\n";
    const result = evaluateSyntaxStructureRules(twoSourceInput(invalid));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const diagnostics = result.bundle.diagnostics.filter((entry) => entry.ruleId === "ACL101");
    expect(diagnostics).toHaveLength(2);
    expect(new Set(diagnostics.map((entry) => entry.fingerprints.semantic.value)).size).toBe(1);
    expect(new Set(diagnostics.map((entry) => entry.fingerprints.path.value)).size).toBe(2);
    expect(new Set(diagnostics.map((entry) => entry.id)).size).toBe(2);
    expect(result.bundle.suppressions).toEqual([]);
    expect(validateDiagnosticBundle(result.bundle, result.sources).ok).toBe(true);

    const malformedDirective = "<!-- agent-context-lint-disable ACL100 -->\nBody\n";
    const withOneSuppression = evaluateSyntaxStructureRules(
      twoSourceInput(
        `<!-- agent-context-lint-disable-next-line ACL108 -- first-file exception -->\n${malformedDirective}`,
        malformedDirective,
      ),
    );
    expect(withOneSuppression.ok).toBe(true);
    if (!withOneSuppression.ok) throw new Error(JSON.stringify(withOneSuppression.issues));
    const finalized = finalizeSyntaxSuppressions(withOneSuppression);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    expect(finalized.suppressedDiagnostics).toHaveLength(1);
    expect(finalized.visibleDiagnostics.filter((entry) => entry.ruleId === "ACL108")).toHaveLength(
      1,
    );
    expect(finalized.suppressedDiagnostics[0]?.primary.path).toBe(".claude/rules/first.md");
    expect(
      finalized.visibleDiagnostics.find((entry) => entry.ruleId === "ACL108")?.primary.path,
    ).toBe(".claude/rules/second.md");
    const independentlyAddressed = [
      finalized.suppressedDiagnostics[0],
      finalized.visibleDiagnostics.find((entry) => entry.ruleId === "ACL108"),
    ];
    expect(
      new Set(independentlyAddressed.map((entry) => entry?.fingerprints.semantic.value)).size,
    ).toBe(1);
    expect(
      new Set(independentlyAddressed.map((entry) => entry?.fingerprints.path.value)).size,
    ).toBe(2);
    expect(new Set(independentlyAddressed.map((entry) => entry?.id)).size).toBe(2);
  });

  test.each([
    ["ACL100", "---\ndescription: [\n---\nBody\n", {}],
    ["ACL101", "---\ncount: many\n---\nBody\n", {}],
    ["ACL102", "---\ndescriptin: text\n---\nBody\n", {}],
    ["ACL103", "---\nglobs: src/[abc\n---\nBody\n", {}],
    ["ACL104", "   \r\n", { dialect: null, fields: [] }],
    [
      "ACL105",
      "Body\n",
      {
        dialect: null,
        fields: [],
        location: [
          {
            evidence,
            profileId: "profile:test",
            specSnapshotId: "profile:test/2026-08-02",
            state: "unsupported",
            surfaceId: "profile:test/local",
          },
        ],
      },
    ],
    [
      "ACL106",
      "Body\n",
      {
        dialect: null,
        fields: [],
        format: [
          {
            evidence,
            profileId: "profile:test",
            specSnapshotId: "profile:test/2026-08-02",
            state: "deprecated",
            surfaceId: "profile:test/local",
          },
        ],
      },
    ],
    ["ACL107", "---\ndescription: one\ndescription: two\n---\nBody\n", {}],
    ["ACL108", "<!-- agent-context-lint-disable ACL100 -->\nBody\n", { dialect: null, fields: [] }],
  ])("emits %s for its positive case", (ruleId, text, overrides) => {
    expect(ruleIds(text, overrides as Partial<SyntaxDocumentPolicy>)).toContain(ruleId);
  });

  test("keeps a supplied matching ACL250 diagnostic suppressed without treating omission as authority", () => {
    const text = "<!-- agent-context-lint-disable-next-line ACL250 -- cross-family -->\nBody\n";
    const request = input(text, { dialect: null, fields: [] });
    const evaluation = evaluateSyntaxStructureRules(request);
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    const source = evaluation.sources[0];
    const target = request.ir.nodes.find((node) => node.kind === "paragraph");
    if (source === undefined || target === undefined)
      throw new Error("target fixture is incomplete");
    const ruleId = "ACL250";
    const ruleVersion = "1.0.0";
    const pathBasis = { anchor: "statement:cross-family", profileIds: [] } as const;
    const semanticBasis = {
      components: [{ key: "fixture", value: "matching-cross-family" }],
      profileIds: [],
    } as const;
    const diagnostic: Diagnostic = {
      fingerprintBasis: { path: pathBasis, semantic: semanticBasis },
      fingerprints: {
        path: {
          method: PATH_FINGERPRINT_METHOD,
          value: computePathFingerprint({
            basis: pathBasis,
            path: source.path,
            ruleId,
            ruleVersion,
          }),
        },
        semantic: {
          method: SEMANTIC_FINGERPRINT_METHOD,
          value: computeSemanticFingerprint({ basis: semanticBasis, ruleId, ruleVersion }),
        },
      },
      id: "diagnostic:fixture:acl250" as DiagnosticId,
      message: "Cross-family fixture diagnostic",
      primary: {
        path: source.path,
        range: target.range,
        sourceDigest: source.sha256,
        sourceId: source.id,
      },
      related: [],
      ruleId,
      ruleVersion,
      severity: "warning",
      suggestion: null,
    };
    const finalized = finalizeSyntaxSuppressions(evaluation, [diagnostic]);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    expect(finalized.bundle.suppressions[0]?.state).toBe("suppressed");
    expect(finalized.bundle.diagnostics.some((entry) => entry.ruleId === "ACL109")).toBe(false);
    const planned = planApprovedMechanicalFixes(finalized);
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    expect(planned.candidates).toEqual([]);
  });

  test("emits ACL109 only after resolving an issued B08 context", () => {
    const evaluation = evaluateSyntaxStructureRules(
      input("<!-- agent-context-lint-disable-next-line ACL100 -- stale -->\nBody\n", {
        dialect: null,
        fields: [],
      }),
    );
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    expect(evaluation.bundle.diagnostics).toEqual([]);
    expect(evaluation.bundle.suppressions).toHaveLength(1);
    const finalized = finalizeSyntaxSuppressions(evaluation);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    expect(finalized.bundle.diagnostics.map((entry) => entry.ruleId)).toEqual(["ACL109"]);
    expect(finalized.bundle.suppressions[0]?.state).toBe("unused");
  });

  test("publishes an exhaustive fail-closed per-rule mechanical-fix safety matrix", async () => {
    expect(MECHANICAL_FIX_SAFETY_MATRIX.rules.map((entry) => entry.ruleId)).toEqual(
      REQUIRED_RULE_IDS,
    );
    expect(MECHANICAL_FIX_SAFETY_MATRIX.rules).toHaveLength(69);
    expect(
      MECHANICAL_FIX_SAFETY_MATRIX.rules.filter((entry) => entry.decision === "approved"),
    ).toEqual([
      expect.objectContaining({
        reason: "approved-exact-unused-suppression",
        ruleId: "ACL109",
      }),
    ]);
    expect(RULE_REGISTRY.rules.filter((entry) => entry.fixSafety === "mechanical")).toEqual([
      expect.objectContaining({ id: "ACL109" }),
    ]);
    expect(Object.isFrozen(MECHANICAL_FIX_SAFETY_MATRIX)).toBe(true);
    expect(Object.isFrozen(MECHANICAL_FIX_SAFETY_MATRIX.rules)).toBe(true);
    expect(MECHANICAL_FIX_SAFETY_MATRIX.rules.every((entry) => Object.isFrozen(entry))).toBe(true);
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/mechanical-fix-safety.v0.schema.json", import.meta.url),
        "utf8",
      ),
    ) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(MECHANICAL_FIX_SAFETY_MATRIX), JSON.stringify(validate.errors)).toBe(true);
    expect(validateMechanicalFixSafetyMatrix(MECHANICAL_FIX_SAFETY_MATRIX)).toEqual({
      issues: [],
      valid: true,
    });
    expect(isMechanicalFixSafetyMatrix(MECHANICAL_FIX_SAFETY_MATRIX)).toBe(true);
    const rendered = renderMechanicalFixSafetyMarkdown();
    expect(rendered).toContain("| ACL109 | **Approved, conditional** |");
    expect(rendered).toContain("| ACL108 | Refused |");
    expect(rendered.match(/^\| ACL\d{3} \|/gmu)).toHaveLength(69);
  });

  test("rejects duplicate, omitted, substituted, reordered, and policy-drifted matrix entries", () => {
    const mutate = (
      change: (rules: Record<string, unknown>[], root: Record<string, unknown>) => void,
    ): ReturnType<typeof validateMechanicalFixSafetyMatrix> => {
      const root = structuredClone(MECHANICAL_FIX_SAFETY_MATRIX) as unknown as Record<
        string,
        unknown
      >;
      const rules = root["rules"] as Record<string, unknown>[];
      change(rules, root);
      const result = validateMechanicalFixSafetyMatrix(root);
      expect(result.valid, JSON.stringify(result.issues)).toBe(false);
      return result;
    };
    expect(
      mutate((rules) => {
        rules[1] = structuredClone(rules[0] ?? {});
      }).issues.some((issue) => issue.code === "invalid-order"),
    ).toBe(true);
    expect(
      mutate((rules) => {
        rules.pop();
      }).issues.some((issue) => issue.path === "$.rules"),
    ).toBe(true);
    expect(
      mutate((rules) => {
        if (rules[2] !== undefined) rules[2]["ruleId"] = "ACL599";
      }).issues.some((issue) => issue.code === "invalid-order"),
    ).toBe(true);
    expect(
      mutate((rules) => {
        [rules[0], rules[1]] = [rules[1] ?? {}, rules[0] ?? {}];
      }).issues.filter((issue) => issue.code === "invalid-order"),
    ).toHaveLength(2);
    expect(
      mutate((rules) => {
        const approved = rules.find((entry) => entry["ruleId"] === "ACL109");
        if (approved !== undefined) approved["decision"] = "refused";
      }).issues.some((issue) => issue.path.endsWith(".decision")),
    ).toBe(true);
    expect(
      mutate((rules) => {
        const first = rules[0];
        if (first !== undefined) first["reason"] = "security-sensitive";
      }).issues.some((issue) => issue.path.endsWith(".reason")),
    ).toBe(true);
    expect(
      mutate((rules) => {
        const first = rules[0];
        if (first !== undefined) first["proof"] = "A plausible but unreviewed replacement proof.";
      }).issues.some((issue) => issue.path.endsWith(".proof")),
    ).toBe(true);
    const proxied = new Proxy(MECHANICAL_FIX_SAFETY_MATRIX, {
      ownKeys: (): never => {
        throw new Error("must not run");
      },
    });
    expect(validateMechanicalFixSafetyMatrix(proxied)).toMatchObject({ valid: false });
  });

  test("schema itself fixes all 69 positions and shares malformed-Unicode rejection", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../schemas/mechanical-fix-safety.v0.schema.json", import.meta.url),
        "utf8",
      ),
    ) as AnySchema & Record<string, unknown>;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const rulesSchema = (schema["properties"] as Record<string, unknown>)["rules"] as Record<
      string,
      unknown
    >;
    const prefixItems = rulesSchema["prefixItems"] as {
      readonly properties: { readonly ruleId: { readonly const: string } };
    }[];
    expect(prefixItems.map((item) => item.properties.ruleId.const)).toEqual(REQUIRED_RULE_IDS);

    interface MutableRule {
      decision: string;
      proof: string;
      reason: string;
      ruleId: string;
    }
    interface MutableMatrix {
      rules: MutableRule[];
    }
    const clone = (): MutableMatrix =>
      structuredClone(MECHANICAL_FIX_SAFETY_MATRIX) as unknown as MutableMatrix;

    const reordered = clone();
    const firstRule = reordered.rules[0];
    const secondRule = reordered.rules[1];
    if (firstRule === undefined || secondRule === undefined)
      throw new Error("matrix is incomplete");
    [reordered.rules[0], reordered.rules[1]] = [secondRule, firstRule];
    expect(validate(reordered)).toBe(false);

    const omitted = clone();
    omitted.rules.pop();
    expect(validate(omitted)).toBe(false);

    const malformedUnicode = clone();
    const malformedRule = malformedUnicode.rules[0];
    if (malformedRule === undefined) throw new Error("matrix is incomplete");
    malformedRule.proof = "isolated high surrogate: \ud800";
    expect(validate(malformedUnicode)).toBe(false);
    expect(validateMechanicalFixSafetyMatrix(malformedUnicode).valid).toBe(false);

    const exactFourKiB = clone();
    const exactRule = exactFourKiB.rules[0];
    if (exactRule === undefined) throw new Error("matrix is incomplete");
    exactRule.proof = "😀".repeat(1_024);
    expect(Buffer.byteLength(exactRule.proof, "utf8")).toBe(4_096);
    expect(validate(exactFourKiB), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validateMechanicalFixSafetyMatrix(exactFourKiB).issues.some(
        (issue) => issue.message === "must be bounded well-formed Unicode",
      ),
    ).toBe(false);

    const overFourKiB = clone();
    const overRule = overFourKiB.rules[0];
    if (overRule === undefined) throw new Error("matrix is incomplete");
    overRule.proof = "😀".repeat(1_025);
    expect(Buffer.byteLength(overRule.proof, "utf8")).toBe(4_100);
    expect(validate(overFourKiB)).toBe(false);
    expect(
      validateMechanicalFixSafetyMatrix(overFourKiB).issues.some(
        (issue) => issue.message === "must be bounded well-formed Unicode",
      ),
    ).toBe(true);
  });

  test.each(["\n", "\r\n"])(
    "plans only the exact parser-owned ACL109 comment with hostile Unicode and %s",
    (newline) => {
      const prefix = `Heading 🧭${newline}`;
      const directive = "<!-- agent-context-lint-disable-next-line ACL100 -- stale Żółw 🧪 -->";
      const suffix = `${newline}Body${newline}`;
      const text = `${prefix}${directive}${suffix}`;
      const evaluation = evaluateSyntaxStructureRules(input(text, { dialect: null, fields: [] }));
      expect(evaluation.ok).toBe(true);
      if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
      const finalized = finalizeSyntaxSuppressions(evaluation);
      expect(finalized.ok).toBe(true);
      if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
      const planned = planApprovedMechanicalFixes(finalized);
      expect(planned.ok).toBe(true);
      if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
      expect(planned.candidates).toHaveLength(1);
      expect(planned.eligiblePlanIds).toEqual([planned.candidates[0]?.planId]);
      const diagnostic = planned.bundle.diagnostics.find((entry) => entry.ruleId === "ACL109");
      const operation = diagnostic?.suggestion?.fixPlan?.operations[0];
      expect(operation).toMatchObject({
        kind: "text-edit",
        newText: "",
        sourceDigest: evaluation.sources[0]?.sha256,
      });
      if (operation?.kind !== "text-edit") throw new Error("missing approved text edit");
      expect(operation.range.start.byteOffset).toBe(Buffer.byteLength(prefix, "utf8"));
      expect(operation.range.end.byteOffset).toBe(
        Buffer.byteLength(`${prefix}${directive}`, "utf8"),
      );
      const after = `${text.slice(0, operation.range.start.utf16Offset)}${operation.newText}${text.slice(operation.range.end.utf16Offset)}`;
      expect(after).toBe(`${prefix}${suffix}`);
      expect(after.slice(0, prefix.length)).toBe(prefix);
      expect(after.slice(prefix.length)).toBe(suffix);

      const second = evaluateSyntaxStructureRules(input(after, { dialect: null, fields: [] }));
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error(JSON.stringify(second.issues));
      const secondFinalized = finalizeSyntaxSuppressions(second);
      expect(secondFinalized.ok).toBe(true);
      if (!secondFinalized.ok) throw new Error(JSON.stringify(secondFinalized.issues));
      const secondPlan = planApprovedMechanicalFixes(secondFinalized);
      expect(secondPlan.ok).toBe(true);
      if (!secondPlan.ok) throw new Error(JSON.stringify(secondPlan.issues));
      expect(secondPlan.eligiblePlanIds).toEqual([]);
    },
  );

  test("approves an exact inline comment range and preserves same-line neighbors", () => {
    const prefix = "Visible prefix ";
    const directive =
      "<!-- agent-context-lint-disable-next-line ACL100 -- exact inline comment -->";
    const suffix = " visible suffix\nTarget line\n";
    const text = `${prefix}${directive}${suffix}`;
    const request = input(text, { dialect: null, fields: [] });
    const evaluation = evaluateSyntaxStructureRules({
      ...request,
      ir: irOf(text, ".github/instructions/test.instructions.md", {
        end: prefix.length + directive.length,
        start: prefix.length,
      }),
    });
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    const finalized = finalizeSyntaxSuppressions(evaluation);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    const planned = planApprovedMechanicalFixes(finalized);
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    const operation = planned.bundle.diagnostics.find((entry) => entry.ruleId === "ACL109")
      ?.suggestion?.fixPlan?.operations[0];
    if (operation?.kind !== "text-edit") throw new Error("inline exact edit was not approved");
    expect(operation.range.start.utf16Offset).toBe(prefix.length);
    expect(operation.range.end.utf16Offset).toBe(prefix.length + directive.length);
    expect(
      `${text.slice(0, operation.range.start.utf16Offset)}${text.slice(operation.range.end.utf16Offset)}`,
    ).toBe(`${prefix}${suffix}`);
  });

  test.each([
    ["one leading space", " ", ""],
    ["three leading spaces", "   ", ""],
    ["one trailing space", "", " "],
    ["leading and trailing spaces", "  ", "  "],
  ])("refuses a parser range containing %s", (_name, leading, trailing) => {
    const directive = "<!-- agent-context-lint-disable-next-line ACL100 -- wider parser range -->";
    const text = `${leading}${directive}${trailing}\nTarget line\n`;
    const evaluation = evaluateSyntaxStructureRules(input(text, { dialect: null, fields: [] }));
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    const finalized = finalizeSyntaxSuppressions(evaluation);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    expect(finalized.bundle.diagnostics.map((entry) => entry.ruleId)).toContain("ACL109");
    const planned = planApprovedMechanicalFixes(finalized);
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    expect(planned.eligiblePlanIds).toEqual([]);
    expect(
      planned.bundle.diagnostics.find((entry) => entry.ruleId === "ACL109")?.suggestion?.fixPlan,
    ).toBeNull();
  });

  test("property: every approved mutation changes only its declared UTF-8 range", () => {
    const atoms = ["alpha", "Żółw", "🧭", "e\u0301", "\tindent", "安全"];
    const atomAt = (index: number): string => atoms[index % atoms.length] ?? "";
    for (let ordinal = 0; ordinal < 64; ordinal += 1) {
      const newline = ordinal % 2 === 0 ? "\n" : "\r\n";
      const prefix = `${atomAt(ordinal)} ${String(ordinal)}${newline}`;
      const directive = `<!-- agent-context-lint-disable-next-line ACL${String(100 + (ordinal % 9))} -- stale ${atomAt(ordinal * 5)} -->`;
      const suffix = `${newline}${atomAt(ordinal * 3)} body ${String(ordinal)}${newline}`;
      const text = `${prefix}${directive}${suffix}`;
      const evaluation = evaluateSyntaxStructureRules(input(text, { dialect: null, fields: [] }));
      if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
      const finalized = finalizeSyntaxSuppressions(evaluation);
      if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
      const planned = planApprovedMechanicalFixes(finalized);
      if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
      const operation = planned.bundle.diagnostics.find((entry) => entry.ruleId === "ACL109")
        ?.suggestion?.fixPlan?.operations[0];
      if (operation?.kind !== "text-edit") throw new Error("missing property-test edit");
      const beforeBytes = Buffer.from(text, "utf8");
      const replacement = Buffer.from(operation.newText, "utf8");
      const afterBytes = Buffer.concat([
        beforeBytes.subarray(0, operation.range.start.byteOffset),
        replacement,
        beforeBytes.subarray(operation.range.end.byteOffset),
      ]);
      expect(
        beforeBytes
          .subarray(0, operation.range.start.byteOffset)
          .equals(afterBytes.subarray(0, operation.range.start.byteOffset)),
      ).toBe(true);
      expect(
        beforeBytes
          .subarray(operation.range.end.byteOffset)
          .equals(afterBytes.subarray(operation.range.start.byteOffset + replacement.byteLength)),
      ).toBe(true);
      expect(afterBytes.toString("utf8")).toBe(`${prefix}${suffix}`);
      expect(operation.range.end.byteOffset - operation.range.start.byteOffset).toBe(
        Buffer.byteLength(directive, "utf8"),
      );
    }
  });

  test("plans the parser hard maximum with bounded identity lookup and deterministic order", () => {
    const text = Array.from(
      { length: 1_024 },
      (_, index) =>
        `<!-- agent-context-lint-disable-next-line ACL100 -- stale ${String(index)} -->\nBody ${String(index)}\n`,
    ).join("");
    const evaluation = evaluateSyntaxStructureRules(input(text, { dialect: null, fields: [] }));
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    const finalized = finalizeSyntaxSuppressions(evaluation);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    const first = planApprovedMechanicalFixes(finalized);
    const second = planApprovedMechanicalFixes(finalized);
    if (!first.ok || !second.ok) throw new Error("maximum planning unexpectedly failed");
    expect(first.candidates).toHaveLength(1_024);
    expect(first.eligiblePlanIds).toEqual(second.eligiblePlanIds);
    expect(new Set(first.eligiblePlanIds).size).toBe(1_024);
    expect(first.eligiblePlanIds).toEqual(
      [...first.eligiblePlanIds].sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      ),
    );
  }, 60_000);

  test("rejects forged, copied, and proxied finalizations without minting I11 authority", () => {
    const evaluation = evaluateSyntaxStructureRules(
      input("<!-- agent-context-lint-disable-next-line ACL100 -- stale -->\nBody\n", {
        dialect: null,
        fields: [],
      }),
    );
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    const finalized = finalizeSyntaxSuppressions(evaluation);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    for (const forged of [
      { ...finalized },
      structuredClone(finalized),
      new Proxy(finalized, {}),
      null,
    ]) {
      const result = planApprovedMechanicalFixes(forged);
      expect(result).toMatchObject({
        issues: [expect.objectContaining({ code: "invalid-input" })],
        ok: false,
      });
    }
    expect(planApprovedMechanicalFixes(finalized).ok).toBe(true);
  });

  test.each([
    ["omitted cross-family", "ACL250", true],
    ["mixed-family", "ACL100, ACL250", true],
    ["post-match ACL109", "ACL109", true],
    ["wildcard", "ACL*", false],
  ])("keeps %s suppression targets refusal-only", (_name, targets, emitsAcl109) => {
    const evaluation = evaluateSyntaxStructureRules(
      input(
        `<!-- agent-context-lint-disable-next-line ${targets} -- incomplete authority -->\nBody\n`,
        { dialect: null, fields: [] },
      ),
    );
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    const finalized = finalizeSyntaxSuppressions(evaluation);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    expect(finalized.bundle.diagnostics.some((entry) => entry.ruleId === "ACL109")).toBe(
      emitsAcl109,
    );
    const planned = planApprovedMechanicalFixes(finalized);
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    expect(planned.candidates).toEqual([]);
    expect(planned.eligiblePlanIds).toEqual([]);
    expect(
      planned.bundle.diagnostics
        .filter((entry) => entry.ruleId === "ACL109")
        .every((entry) => entry.suggestion?.fixPlan === null),
    ).toBe(true);
  });

  test("retains the frozen B04 v0 text-edit shape while binding the fragment through the plan ID", () => {
    const text = "<!-- agent-context-lint-disable-next-line ACL100 -- stale -->\nBody remains.\n";
    const evaluation = evaluateSyntaxStructureRules(input(text, { dialect: null, fields: [] }));
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    const finalized = finalizeSyntaxSuppressions(evaluation);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    const planned = planApprovedMechanicalFixes(finalized);
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    const plan = planned.bundle.diagnostics.find((entry) => entry.ruleId === "ACL109")?.suggestion
      ?.fixPlan;
    const operation = plan?.operations[0];
    expect(operation).toBeDefined();
    expect(Object.keys(operation ?? {}).sort()).toEqual([
      "kind",
      "newText",
      "path",
      "range",
      "sourceDigest",
      "sourceId",
    ]);
    expect(plan?.id).toMatch(/^fix:acl109:[a-f0-9]{32}$/u);
  });

  test("suppresses ACL108 through the real B08 matcher and does not emit ACL109", () => {
    const evaluation = evaluateSyntaxStructureRules(
      input(
        "<!-- agent-context-lint-disable-next-line ACL108 -- malformed fixture -->\n<!-- agent-context-lint-disable ACL100 -->\nBody\n",
        { dialect: null, fields: [] },
      ),
    );
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    const finalized = finalizeSyntaxSuppressions(evaluation);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    expect(finalized.suppressedDiagnostics.map((entry) => entry.ruleId)).toEqual(["ACL108"]);
    expect(finalized.visibleDiagnostics.map((entry) => entry.ruleId)).not.toContain("ACL109");
    expect(finalized.bundle.suppressions[0]?.state).toBe("suppressed");
  });

  test("keeps valid, unknown, and non-applicable profile observations silent", () => {
    expect(
      ruleIds("---\ndescription: text\nglobs: src/**\ncount: 1\n---\nBody\n", {
        format: [
          {
            evidence,
            profileId: "profile:test",
            specSnapshotId: "profile:test/2026-08-02",
            state: "current",
            surfaceId: "profile:test/local",
          },
        ],
        location: [
          {
            evidence,
            profileId: "profile:test",
            specSnapshotId: "profile:test/2026-08-02",
            state: "unknown",
            surfaceId: "profile:test/local",
          },
        ],
      }),
    ).toEqual([]);
  });

  test("sorts multiple profile observations and same-range diagnostics deterministically", () => {
    const first = {
      evidence,
      profileId: "profile:a",
      specSnapshotId: "profile:a/2026-08-02",
      state: "unsupported" as const,
      surfaceId: "profile:a/local",
    };
    const second = {
      evidence,
      profileId: "profile:b",
      specSnapshotId: "profile:b/2026-08-02",
      state: "unsupported" as const,
      surfaceId: "profile:b/local",
    };
    const result = evaluateSyntaxStructureRules(
      input("Body\n", {
        dialect: null,
        fields: [],
        format: [{ ...first, state: "deprecated" }],
        location: [second, first],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.bundle.diagnostics.map((entry) => entry.ruleId)).toEqual([
      "ACL105",
      "ACL105",
      "ACL106",
    ]);
    expect(
      evaluateSyntaxStructureRules(input("Body\n", { dialect: null, fields: [] })),
    ).toMatchObject({
      ok: true,
    });
  });

  test("covers glob boundaries and vendor-aware suggestions deterministically", () => {
    const valid = "a".repeat(4_096);
    expect(ruleIds(`---\nglobs: ${valid}\n---\nBody\n`)).toEqual([]);
    expect(ruleIds("---\nglobs: src/**/file?.ts\n---\nBody\n")).toEqual([]);
    expect(ruleIds("---\nglobs: src/[abc]/{one,two}\n---\nBody\n")).toEqual([]);
    expect(ruleIds("---\nunknown: value\n---\nBody\n", { fields: [] })).toContain("ACL102");
    const tied = evaluateSyntaxStructureRules(
      input("---\ncap: value\n---\nBody\n", {
        fields: [
          { globSyntax: "none", name: "car", types: ["string"] },
          { globSyntax: "none", name: "cat", types: ["string"] },
        ],
      }),
    );
    expect(tied.ok).toBe(true);
    if (!tied.ok) throw new Error(JSON.stringify(tied.issues));
    expect(tied.bundle.diagnostics[0]?.message).not.toContain("did you mean");
    const result = evaluateSyntaxStructureRules(input("---\ndescriptin: text\n---\nBody\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.bundle.diagnostics[0]?.message).toContain("did you mean 'description'");
    expect(evaluateSyntaxStructureRules(input("---\ndescriptin: text\n---\nBody\n"))).toEqual(
      result,
    );
  });

  test.each([
    "",
    "a".repeat(4_097),
    "/absolute",
    "src/",
    "src//file",
    "src\\file",
    "src/../file",
    "src/\u0001file",
    "src/[[a]",
    "src/a]",
    "src/{{a,b}",
    "src/a}",
    "src/{a}",
    "src/{a,}",
    "src/{a,b",
    "src/**file",
  ])("rejects the documented path-glob boundary %j", (pattern) => {
    expect(ruleIds(`---\nglobs: ${JSON.stringify(pattern)}\n---\nBody\n`)).toContain("ACL103");
  });

  test("covers accepted field value shapes and empty frontmatter bodies", () => {
    expect(
      ruleIds("---\nenabled: true\nglobs: [src/**, test/**]\n---\nBody\n", {
        fields: [
          { globSyntax: "none", name: "enabled", types: ["boolean"] },
          { globSyntax: "path-glob-v1", name: "globs", types: ["string-array"] },
        ],
      }),
    ).toEqual([]);
    expect(
      ruleIds("---\nconfig:\n  nested: true\n---\nBody\n", {
        fields: [{ globSyntax: "none", name: "config", types: ["string"] }],
      }),
    ).toContain("ACL101");
    expect(ruleIds("---\ndescription: text\n---\n")).toContain("ACL104");
    expect(
      ruleIds("---\ndescription: text\nglobs: src/**\n---\nBody\n", { dialect: "mdc" }),
    ).toEqual([]);
    expect(ruleIds("---\ndescription: [\n---\nBody\n", { dialect: "mdc" })).toContain("ACL100");
    expect(ruleIds("---\ndescription: text\n", { dialect: "mdc" })).toContain("ACL100");
  });

  test("rejects closed-policy boundary violations", () => {
    const base = input("Body\n", { dialect: null, fields: [] });
    const observation = {
      evidence,
      profileId: "profile:test",
      specSnapshotId: "profile:test/2026-08-02",
      state: "current" as const,
      surfaceId: "profile:test/local",
    };
    const invalidDocuments: readonly unknown[] = [
      null,
      new Proxy([], {}),
      Object.setPrototypeOf([], null),
      Object.assign(new Array(1), { extra: true }),
      [null],
      [new Date()],
      [{ ...policy({ dialect: null, fields: [] }), sourceId: "unknown:source" }],
      [{ ...policy(), dialect: "invalid" }],
      [{ ...policy(), fields: null }],
      [{ ...policy(), fields: [null] }],
      [
        {
          ...policy(),
          fields: [
            { globSyntax: "none", name: "same", types: ["string"] },
            { globSyntax: "none", name: "same", types: ["string"] },
          ],
        },
      ],
      [{ ...policy(), fields: [{ globSyntax: "bad", name: "field", types: ["string"] }] }],
      [
        {
          ...policy(),
          fields: [{ globSyntax: "path-glob-v1", name: "field", types: ["number"] }],
        },
      ],
      [{ ...policy(), format: null }],
      [{ ...policy(), format: [null] }],
      [
        {
          ...policy(),
          format: [{ ...observation, evidence: { ...evidence, url: "http://example.test" } }],
        },
      ],
      [
        {
          ...policy(),
          format: [{ ...observation, evidence: { ...evidence, url: "://" } }],
        },
      ],
      [
        {
          ...policy(),
          format: [{ ...observation, evidence: { ...evidence, retrievedAt: "2026-02-30" } }],
        },
      ],
      [
        {
          ...policy(),
          format: [observation, observation],
        },
      ],
      [policy(), policy()],
    ];
    for (const documents of invalidDocuments) {
      expect(evaluateSyntaxStructureRules({ ...base, documents })).toMatchObject({ ok: false });
    }
    expect(evaluateSyntaxStructureRules({ ...base, ir: {} })).toMatchObject({ ok: false });
  });

  test("fails closed for malformed and hostile API inputs without invoking accessors", () => {
    expect(evaluateSyntaxStructureRules({})).toMatchObject({ ok: false });
    expect(evaluateSyntaxStructureRules(new Proxy({}, {}))).toMatchObject({ ok: false });
    let invoked = false;
    const hostile = {
      get contractVersion(): string {
        invoked = true;
        return "0.1.0";
      },
      documents: [],
      ir: irOf("Body\n"),
      recordKind: "agent-context-syntax-structure-rule-input",
    };
    expect(evaluateSyntaxStructureRules(hostile)).toMatchObject({ ok: false });
    expect(invoked).toBe(false);
    expect(finalizeSyntaxSuppressions({ ok: true })).toMatchObject({ ok: false });
    const valid = evaluateSyntaxStructureRules(input("Body\n", { dialect: null, fields: [] }));
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error(JSON.stringify(valid.issues));
    expect(finalizeSyntaxSuppressions(valid, null)).toMatchObject({ ok: false });
    expect(finalizeSyntaxSuppressions(valid, [{}])).toMatchObject({ ok: false });
    expect(finalizeSyntaxSuppressions(valid, Object.setPrototypeOf([], null))).toMatchObject({
      ok: false,
    });
    expect(finalizeSyntaxSuppressions(null)).toMatchObject({ ok: false });
    expect(finalizeSyntaxSuppressions(new Proxy({}, {}))).toMatchObject({ ok: false });
  });
});
