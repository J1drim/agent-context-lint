import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "../packages/core/dist/index.js";
import type {
  DiagnosticBundle,
  InstructionIr,
  RepositoryRelativePath,
  SourceDocument,
} from "../packages/core/dist/index.js";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  loadImportGraph,
} from "../packages/evidence/src/index.js";
import type { ReadOnlyRepository } from "../packages/evidence/src/index.js";
import {
  formatJsonDiagnostics,
  formatSarifDiagnostics,
  formatStylishDiagnostics,
} from "../packages/formatters/src/index.js";
import { evaluateReferencesImports } from "../packages/rules/dist/index.js";
import {
  lexImportReferences,
  matchSuppressionDirectives,
  parseSuppressionDirectives,
} from "../packages/syntax/src/index.js";

function repository(source: string): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/fixture",
    inspect(): ReturnType<ReadOnlyRepository["inspect"]> {
      return Promise.reject(new Error("not used"));
    },
    readDirectory(): ReturnType<ReadOnlyRepository["readDirectory"]> {
      return Promise.reject(new Error("not used"));
    },
    readFile(path): ReturnType<ReadOnlyRepository["readFile"]> {
      const requested = canonicalizeRepositoryRelativePath(String(path));
      if (requested !== "AGENTS.md")
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "fixture path is unavailable",
          "read-file",
          requested,
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          requested,
          new TextEncoder().encode(source),
          { device: "1", inode: "1" },
          0,
        ),
      );
    },
    usage(): ReturnType<ReadOnlyRepository["usage"]> {
      return { elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 };
    },
  };
}

describe("F06 references/imports integration", () => {
  test("packaged rules produce suppressible diagnostics in stylish, JSON, and SARIF", async () => {
    const text =
      "<!-- agent-context-lint-disable-next-line ACL150 -- reviewed missing fixture -->\n@missing.md\n";
    const graph = await loadImportGraph({
      entryPath: canonicalizeRepositoryRelativePath("AGENTS.md"),
      repository: repository(text),
      syntax: "claude-code",
    });
    const graphNode = graph.nodes[0];
    if (graphNode === undefined) throw new Error("missing graph node");
    const syntax = lexImportReferences({
      documentId: graphNode.documentId,
      sourceId: graphNode.sourceId,
      syntax: "claude-code",
      text,
    });
    const source: SourceDocument = {
      bom: "none",
      byteLength: Buffer.byteLength(text, "utf8"),
      encoding: "utf-8",
      id: graphNode.sourceId,
      lineEnding: "lf",
      parseState: syntax.markdown.parseState,
      path: "AGENTS.md" as RepositoryRelativePath,
      rootNodeId: syntax.markdown.rootNodeId,
      sha256: createHash("sha256").update(text).digest("hex"),
      text,
      utf16Length: text.length,
    };
    const ir: InstructionIr = {
      activationRules: [],
      contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
      documents: [
        {
          activationRuleIds: [],
          formatId: "claude-memory-markdown",
          id: graphNode.documentId,
          importIds: syntax.imports.map((reference) => reference.id),
          rootNodeId: syntax.markdown.rootNodeId,
          scopeRoot: "." as RepositoryRelativePath,
          sourceId: graphNode.sourceId,
          statementIds: [],
        },
      ],
      events: [],
      imports: syntax.imports,
      nodes: syntax.markdown.nodes,
      recordKind: "agent-context-instruction-ir",
      sources: [source],
      statements: [],
      targets: [],
    };
    const irValidation = validateInstructionIr(ir);
    if (!irValidation.ok) throw new Error(JSON.stringify(irValidation.issues));
    const evaluation = evaluateReferencesImports({
      contractVersion: "0.1.0",
      graphs: [graph],
      ir: irValidation.value,
      pathSnapshot: { completeness: "complete", paths: [source.path] },
      recordKind: "agent-context-references-imports-rule-input",
      targets: syntax.imports.map((reference) => ({
        formatId: "claude-memory-markdown",
        importId: reference.id,
        markdownLinks: "not-applicable",
        profileId: "claude-code",
        surfaceId: "claude-code/local-session",
      })),
    });
    expect(evaluation.bundle.diagnostics).toEqual([
      expect.objectContaining({ ruleId: "ACL150", severity: "error" }),
    ]);

    const parsed = parseSuppressionDirectives(irValidation.value);
    expect(parsed.issues).toEqual([]);
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
    expect(stylishActive.ok && stylishActive.text).toContain("ACL150");
    expect(stylishSuppressed.ok && stylishSuppressed.text).toContain("1 suppressed");

    const profileVersions = {
      "claude-code": { clientVersion: null, profileVersion: "1.0.0" },
    };
    const json = formatJsonDiagnostics(matched.bundle, evaluation.sources, {
      failureThreshold: "error",
      profileVersions,
    });
    expect(json.ok).toBe(true);
    if (!json.ok) throw new Error(JSON.stringify(json.issues));
    expect(json.output.summary).toMatchObject({ errors: 0, suppressed: 1 });

    const sarif = formatSarifDiagnostics(matched.bundle, evaluation.sources, {
      informationUri: "https://example.test/agent-context-lint",
      profileVersions,
      ruleDocumentationBaseUri: "https://example.test/agent-context-lint/",
      toolVersion: "1.0.0",
    });
    expect(sarif.ok).toBe(true);
    if (!sarif.ok) throw new Error(JSON.stringify(sarif.issues));
    expect(sarif.output.runs[0]?.results).toEqual([]);
    expect(sarif.text).not.toContain("missing fixture");
  });
});
