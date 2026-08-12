import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  validateInstructionIr,
} from "../packages/core/dist/index.js";
import type {
  AstNode,
  AstNodeId,
  InstructionIr,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
} from "../packages/core/dist/index.js";
import {
  formatJsonDiagnostics,
  formatSarifDiagnostics,
  formatStylishDiagnostics,
} from "../packages/formatters/src/index.js";
import {
  evaluateSyntaxStructureRules,
  finalizeSyntaxSuppressions,
} from "../packages/rules/dist/index.js";
import type {
  SyntaxDocumentPolicy,
  SyntaxStructureRuleInput,
} from "../packages/rules/dist/index.js";

function positionAt(text: string, offset: number): SourcePosition {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
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
  for (const [index, match] of [...text.matchAll(/[^\n]+/gu)].entries()) {
    const value = match[0];
    const start = match.index;
    children.push({
      childIds: [],
      id: `node:formatter:${String(index)}` as AstNodeId,
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
      id: "node:formatter:root" as AstNodeId,
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

function fixture(text: string, overrides: Partial<SyntaxDocumentPolicy>): SyntaxStructureRuleInput {
  const sourceId = "source:formatter-fixture" as SourceDocumentId;
  const nodes = nodesOf(sourceId, text);
  const source: SourceDocument = {
    bom: "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: sourceId,
    lineEnding: text.includes("\n") ? "lf" : "none",
    parseState: { state: "complete" },
    path: ".github/instructions/fixture.instructions.md" as RepositoryRelativePath,
    rootNodeId: "node:formatter:root" as AstNodeId,
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
  return {
    contractVersion: "0.1.0",
    documents: [
      {
        dialect: "yaml",
        fields: [
          { globSyntax: "none", name: "count", types: ["number"] },
          { globSyntax: "none", name: "description", types: ["string"] },
          { globSyntax: "path-glob-v1", name: "globs", types: ["string"] },
        ],
        format: [],
        location: [],
        sourceId,
        vendorId: "fixture-vendor",
        ...overrides,
      },
    ],
    ir: validation.value,
    recordKind: "agent-context-syntax-structure-rule-input",
  };
}

const evidence = {
  evidenceRefId: "fixture:profile-evidence",
  retrievedAt: "2026-08-02",
  revision: "fixture-v1",
  url: "https://example.test/profile/syntax",
};

const cases: readonly [string, string, Partial<SyntaxDocumentPolicy>][] = [
  ["ACL100", "---\ndescription: [\n---\nBody\n", {}],
  ["ACL101", "---\ncount: many\n---\nBody\n", {}],
  ["ACL102", "---\ndescriptin: text\n---\nBody\n", {}],
  ["ACL103", "---\nglobs: src/[abc\n---\nBody\n", {}],
  ["ACL104", " \n", { dialect: null, fields: [] }],
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
  [
    "ACL109",
    "<!-- agent-context-lint-disable-next-line ACL100 -- stale -->\nBody\n",
    { dialect: null, fields: [] },
  ],
];

describe("F05 packaged formatter integration", () => {
  test.each(cases)("renders %s through stylish, JSON, and SARIF", (ruleId, text, overrides) => {
    const evaluation = evaluateSyntaxStructureRules(fixture(text, overrides));
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    const output = ruleId === "ACL109" ? finalizeSyntaxSuppressions(evaluation) : evaluation;
    expect(output.ok).toBe(true);
    if (!output.ok) throw new Error(JSON.stringify(output.issues));
    expect(output.bundle.diagnostics.map((entry) => entry.ruleId)).toContain(ruleId);

    const stylish = formatStylishDiagnostics(output.bundle, evaluation.sources);
    expect(stylish.ok && stylish.text).toContain(ruleId);

    const formatterOptions = {
      failureThreshold: "error" as const,
      profileVersions: {
        "profile:test": { clientVersion: null, profileVersion: "1.0.0" },
      },
    };
    const json = formatJsonDiagnostics(output.bundle, evaluation.sources, formatterOptions);
    expect(json.ok).toBe(true);
    if (!json.ok) throw new Error(JSON.stringify(json.issues));
    expect(json.text).toContain(ruleId);

    const sarif = formatSarifDiagnostics(output.bundle, evaluation.sources, {
      informationUri: "https://example.test/agent-context-lint",
      profileVersions: formatterOptions.profileVersions,
      ruleDocumentationBaseUri: "https://example.test/agent-context-lint/",
      toolVersion: "1.0.0",
    });
    expect(sarif.ok).toBe(true);
    if (!sarif.ok) throw new Error(JSON.stringify(sarif.issues));
    expect(sarif.text).toContain(ruleId);
  });

  test.each(cases)("suppresses %s only on its exact B08 target line", (ruleId, text, overrides) => {
    const donorEvaluation = evaluateSyntaxStructureRules(fixture(text, overrides));
    expect(donorEvaluation.ok).toBe(true);
    if (!donorEvaluation.ok) throw new Error(JSON.stringify(donorEvaluation.issues));
    const donorOutput =
      ruleId === "ACL109" ? finalizeSyntaxSuppressions(donorEvaluation) : donorEvaluation;
    expect(donorOutput.ok).toBe(true);
    if (!donorOutput.ok) throw new Error(JSON.stringify(donorOutput.issues));
    const donor = donorOutput.bundle.diagnostics.find((entry) => entry.ruleId === ruleId);
    if (donor === undefined) throw new Error(`missing donor diagnostic ${ruleId}`);

    const targetInput = fixture(
      `<!-- agent-context-lint-disable-next-line ${ruleId} -- exact fixture -->\nBody\n`,
      { dialect: null, fields: [] },
    );
    const targetEvaluation = evaluateSyntaxStructureRules(targetInput);
    expect(targetEvaluation.ok).toBe(true);
    if (!targetEvaluation.ok) throw new Error(JSON.stringify(targetEvaluation.issues));
    const source = targetEvaluation.sources[0];
    const target = targetInput.ir.nodes.find((node) => node.kind === "paragraph");
    if (source === undefined || target === undefined)
      throw new Error("missing target fixture data");
    const attached = {
      ...donor,
      primary: {
        path: source.path,
        range: target.range,
        sourceDigest: source.sha256,
        sourceId: source.id,
      },
      related: [],
    };
    const finalized = finalizeSyntaxSuppressions(targetEvaluation, [attached]);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    expect(finalized.suppressedDiagnostics.map((entry) => entry.ruleId)).toContain(ruleId);
    expect(finalized.bundle.suppressions[0]?.state).toBe("suppressed");
    expect(finalized.bundle.diagnostics.filter((entry) => entry.ruleId === "ACL109")).toHaveLength(
      ruleId === "ACL109" ? 1 : 0,
    );
  });
});
