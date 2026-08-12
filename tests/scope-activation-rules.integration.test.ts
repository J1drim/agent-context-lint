import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  INSTRUCTION_IR_CONTRACT_VERSION,
  validateInstructionIr,
} from "../packages/core/dist/index.js";
import type {
  ActivationRule,
  DiagnosticBundle,
  InstructionDocument,
  InstructionIr,
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
import { evaluateActivationRule } from "../packages/resolver/dist/index.js";
import { evaluateScopeActivationRules } from "../packages/rules/dist/index.js";
import {
  matchSuppressionDirectives,
  parseSuppressionDirectives,
} from "../packages/syntax/src/index.js";

function fixture(): InstructionIr {
  const text =
    "<!-- agent-context-lint-disable-next-line ACL200 -- intentionally future-scoped -->\nPolicy\n";
  const sourceId = "source:scope-policy" as SourceDocumentId;
  const parsed = parseMarkdown({ sourceId, text });
  const paragraph = parsed.nodes.find((node) => node.kind === "paragraph");
  if (paragraph === undefined) throw new Error("missing policy paragraph");
  const source: SourceDocument = {
    bom: "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: sourceId,
    lineEnding: "lf",
    parseState: parsed.parseState,
    path: "SCOPED.md" as RepositoryRelativePath,
    rootNodeId: parsed.rootNodeId,
    sha256: createHash("sha256").update(text).digest("hex"),
    text,
    utf16Length: text.length,
  };
  const documentId = "document:scope-policy" as InstructionDocument["id"];
  const ruleId = "activation:scope-policy" as ActivationRule["id"];
  const document: InstructionDocument = {
    activationRuleIds: [ruleId],
    formatId: "fixture-markdown",
    id: documentId,
    importIds: [],
    rootNodeId: parsed.rootNodeId,
    scopeRoot: "." as RepositoryRelativePath,
    sourceId,
    statementIds: [],
  };
  const rule: ActivationRule = {
    conditions: [],
    documentId,
    evidenceRefs: [{ factId: "fact:scope-policy", sourceId: "fixture:scope" }],
    exclude: [],
    id: ruleId,
    include: [
      {
        dialectId: "fixture-glob",
        kind: "glob",
        pattern: "future/**/*.ts",
        sourceRange: paragraph.range,
        uncertainty: { state: "known" },
      },
    ],
    kind: "glob",
    profileId: "profile:test",
    scopeRoot: "." as RepositoryRelativePath,
    specSnapshotId: "profile:test/1.0.0",
    surfaceId: "profile:test/local",
    uncertainty: { state: "known" },
    unknownReason: null,
  };
  const ir: InstructionIr = {
    activationRules: [rule],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: [document],
    events: [],
    imports: [],
    nodes: parsed.nodes,
    recordKind: "agent-context-instruction-ir",
    sources: [source],
    statements: [],
    targets: [],
  };
  const validation = validateInstructionIr(ir);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

describe("F07 packaged scope activation integration", () => {
  test("produces a suppressible ACL200 diagnostic for stylish, JSON, and SARIF", () => {
    const ir = fixture();
    const rule = ir.activationRules[0];
    if (rule === undefined) throw new Error("missing activation rule");
    const result = evaluateScopeActivationRules({
      activationResults: [
        {
          path: "src/main.ts" as RepositoryRelativePath,
          results: [
            {
              result: evaluateActivationRule(rule, {
                callbacks: {
                  matchGlob: () => ({
                    state: "inactive",
                    reason: "Fixture pattern did not match.",
                  }),
                },
                targetPath: "src/main.ts" as RepositoryRelativePath,
              }),
              ruleId: rule.id,
            },
          ],
          targetKind: "source",
        },
      ],
      contractVersion: "0.1.0",
      facts: [
        {
          comparisonGroup: null,
          factId: "resolution:scope-policy",
          nestingState: "known",
          reachabilityState: "reachable",
          ruleId: rule.id,
          scopeMetadataState: "present",
          shadowedByRuleIds: [],
        },
      ],
      ir,
      recordKind: "agent-context-scope-activation-rule-input",
      sampling: {
        criticalPaths: [],
        paths: ["src/main.ts" as RepositoryRelativePath],
        trackingCertainty: "tracked",
        trackingReason: "verified-git-index",
        workspaceBoundaries: [],
        workspaceUncertainty: "known",
        workspaceUncertaintyReasons: [],
      },
    });
    expect(result.bundle.diagnostics).toEqual([
      expect.objectContaining({ ruleId: "ACL200", severity: "error" }),
    ]);

    const parsed = parseSuppressionDirectives(ir);
    expect(parsed.issues).toEqual([]);
    const applicable: DiagnosticBundle = {
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: result.bundle.diagnostics,
      recordKind: "agent-context-diagnostics",
      suppressions: parsed.directives.map((directive) => directive.record),
    };
    const matched = matchSuppressionDirectives(applicable, parsed.directives, result.sources);
    expect(matched.visibleDiagnostics).toEqual([]);
    expect(matched.suppressedDiagnostics).toHaveLength(1);

    const stylish = formatStylishDiagnostics(matched.bundle, result.sources);
    expect(stylish.ok && stylish.text).toContain("1 suppressed");
    const profileVersions = {
      "profile:test": { clientVersion: null, profileVersion: "1.0.0" },
    };
    const json = formatJsonDiagnostics(matched.bundle, result.sources, {
      failureThreshold: "error",
      profileVersions,
    });
    expect(json.ok).toBe(true);
    if (!json.ok) throw new Error(JSON.stringify(json.issues));
    expect(json.output.summary).toMatchObject({ errors: 0, suppressed: 1 });
    const sarif = formatSarifDiagnostics(matched.bundle, result.sources, {
      informationUri: "https://example.test/agent-context-lint",
      profileVersions,
      ruleDocumentationBaseUri: "https://example.test/agent-context-lint/",
      toolVersion: "1.0.0",
    });
    expect(sarif.ok).toBe(true);
    if (!sarif.ok) throw new Error(JSON.stringify(sarif.issues));
    expect(sarif.output.runs[0]?.results).toEqual([]);
  });
});
