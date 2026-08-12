import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  INSTRUCTION_IR_CONTRACT_VERSION,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "../packages/core/dist/index.js";
import type {
  DiagnosticBundle,
  InstructionDocument,
  InstructionIr,
  InstructionStatement,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
} from "../packages/core/dist/index.js";
import {
  formatJsonDiagnostics,
  formatSarifDiagnostics,
  formatStylishDiagnostics,
} from "../packages/formatters/src/index.js";
import { parseMarkdown } from "../packages/markdown/src/index.js";
import { evaluateDocumentContextRules } from "../packages/rules/dist/index.js";
import {
  matchSuppressionDirectives,
  parseSuppressionDirectives,
} from "../packages/syntax/src/index.js";

function sourceAndIr(text: string): {
  readonly ir: InstructionIr;
  readonly source: SourceDocument;
} {
  const sourceId = "source:agents" as SourceDocumentId;
  const parsed = parseMarkdown({ sourceId, text });
  const source: SourceDocument = {
    bom: "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: sourceId,
    lineEnding: "lf",
    parseState: parsed.parseState,
    path: "AGENTS.md" as RepositoryRelativePath,
    rootNodeId: parsed.rootNodeId,
    sha256: createHash("sha256").update(text).digest("hex"),
    text,
    utf16Length: text.length,
  };
  const paragraph = parsed.nodes.find((node) => node.kind === "paragraph");
  if (paragraph === undefined) throw new Error("missing statement paragraph");
  const documentId = "document:agents" as InstructionDocument["id"];
  const statement: InstructionStatement = {
    classification: { state: "unclassified" },
    documentId,
    id: "statement:vague" as InstructionStatement["id"],
    nodeIds: [paragraph.id],
    range: paragraph.range,
    text: text.slice(paragraph.range.start.utf16Offset, paragraph.range.end.utf16Offset),
  };
  const ir: InstructionIr = {
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: [
      {
        activationRuleIds: [],
        formatId: "agents-markdown",
        id: documentId,
        importIds: [],
        rootNodeId: parsed.rootNodeId,
        scopeRoot: "." as RepositoryRelativePath,
        sourceId,
        statementIds: [statement.id],
      },
    ],
    events: [],
    imports: [],
    nodes: parsed.nodes,
    recordKind: "agent-context-instruction-ir",
    sources: [source],
    statements: [statement],
    targets: [],
  };
  const validation = validateInstructionIr(ir);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return { ir: validation.value, source };
}

describe("F10 document context integration", () => {
  test("packaged rules produce suppressible B04 diagnostics in stylish, JSON, and SARIF", () => {
    const fixture = sourceAndIr(
      "<!-- agent-context-lint-disable-next-line ACL352 -- reviewed -->\nFollow best practices.\n",
    );
    const evaluation = evaluateDocumentContextRules({
      contractVersion: "0.1.0",
      importResolutions: [],
      ir: fixture.ir,
      recordKind: "agent-context-document-context-rule-input",
    });
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) throw new Error(JSON.stringify(evaluation.issues));
    expect(evaluation.bundle.diagnostics).toEqual([
      expect.objectContaining({ ruleId: "ACL352", severity: "info" }),
    ]);

    const parsed = parseSuppressionDirectives(fixture.ir);
    expect(parsed.issues).toEqual([]);
    expect(parsed.directives).toHaveLength(1);
    const candidate: DiagnosticBundle = {
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: evaluation.bundle.diagnostics,
      recordKind: "agent-context-diagnostics",
      suppressions: parsed.directives.map((directive) => directive.record),
    };
    const matched = matchSuppressionDirectives(candidate, parsed.directives, evaluation.sources);
    expect(matched.suppressedDiagnostics).toHaveLength(1);
    expect(matched.visibleDiagnostics).toEqual([]);
    expect(validateDiagnosticBundle(matched.bundle, evaluation.sources).ok).toBe(true);

    const stylishActive = formatStylishDiagnostics(evaluation.bundle, evaluation.sources);
    const stylishSuppressed = formatStylishDiagnostics(matched.bundle, evaluation.sources);
    expect(stylishActive.ok && stylishActive.text).toContain("ACL352");
    expect(stylishSuppressed.ok && stylishSuppressed.text).toContain("1 suppressed");

    const profileVersions = {
      "profile:test": { clientVersion: null, profileVersion: "1.0.0" },
    };
    const json = formatJsonDiagnostics(matched.bundle, evaluation.sources, {
      failureThreshold: "error",
      profileVersions,
    });
    expect(json.ok).toBe(true);
    if (!json.ok) throw new Error(JSON.stringify(json.issues));
    expect(json.output.summary).toMatchObject({ infos: 0, suppressed: 1 });

    const sarif = formatSarifDiagnostics(matched.bundle, evaluation.sources, {
      informationUri: "https://example.test/agent-context-lint",
      profileVersions,
      ruleDocumentationBaseUri: "https://example.test/agent-context-lint/",
      toolVersion: "1.0.0",
    });
    expect(sarif.ok).toBe(true);
    if (!sarif.ok) throw new Error(JSON.stringify(sarif.issues));
    expect(sarif.output.runs[0]?.results).toEqual([]);
    expect(sarif.text).not.toContain("Follow best practices");
  });
});
