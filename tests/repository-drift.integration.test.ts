import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "../packages/core/dist/index.js";
import type {
  AstNode,
  InstructionDocumentId,
  InstructionIr,
  InstructionStatementId,
  SourceDocument,
  SourceDocumentId,
} from "../packages/core/dist/index.js";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryFile,
  WORKSPACE_BOUNDARY_CONTRACT_VERSION,
  WORKSPACE_BOUNDARY_DEFAULT_LIMITS,
  collectRepositoryEvidence,
} from "../packages/evidence/src/index.js";
import type {
  ReadOnlyRepository,
  WorkspaceBoundaryDiscoveryResult,
} from "../packages/evidence/src/index.js";
import {
  formatJsonDiagnostics,
  formatSarifDiagnostics,
  formatStylishDiagnostics,
} from "../packages/formatters/src/index.js";
import { parseMarkdown } from "../packages/markdown/src/index.js";
import { evaluateRepositoryDrift } from "../packages/rules/src/index.js";
import {
  matchSuppressionDirectives,
  parseSuppressionDirectives,
} from "../packages/syntax/src/index.js";

function lineEndingOf(text: string): SourceDocument["lineEnding"] {
  return text.includes("\n") ? "lf" : "none";
}

function sourceAndIr(text: string): {
  readonly ir: InstructionIr;
  readonly source: SourceDocument;
} {
  const sourceId = "source:AGENTS.md" as SourceDocumentId;
  const parsed = parseMarkdown({ sourceId, text });
  const source: SourceDocument = {
    bom: "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: sourceId,
    lineEnding: lineEndingOf(text),
    parseState: parsed.parseState,
    path: canonicalizeRepositoryRelativePath("AGENTS.md"),
    rootNodeId: parsed.rootNodeId,
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
    nodes: parsed.nodes,
    recordKind: "agent-context-instruction-ir",
    sources: [source],
    statements: [],
    targets: [],
  };
  const result = validateInstructionIr(candidate);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return { ir: result.value, source };
}

function packageWorkspace(): WorkspaceBoundaryDiscoveryResult {
  const zero = { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 };
  const root = canonicalizeRepositoryRelativePath(".");
  const path = canonicalizeRepositoryRelativePath("package.json");
  return {
    boundaries: [
      {
        evidencePath: path,
        family: "javascript-package",
        kind: "project",
        languages: ["javascript"],
        root,
      },
    ],
    contractVersion: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
    evidence: [
      {
        family: "javascript-package",
        ignoredExecutableFields: [],
        issues: [],
        languages: ["javascript"],
        location: { path, range: { end: zero, start: zero } },
        packageManager: "npm@11.18.0",
        parser: "json",
        path,
        patterns: [],
        projectName: "fixture",
        recognizerId: "c11.package-json",
        root,
        state: "complete",
      },
    ],
    limits: WORKSPACE_BOUNDARY_DEFAULT_LIMITS,
    metrics: {
      boundaryCount: 1,
      contentReads: 1,
      issueCount: 0,
      manifestCount: 1,
      patternCount: 0,
      totalBytes: 0,
    },
    uncertainty: "known",
    uncertaintyReasons: [],
  };
}

function repositoryWithPackageJson(content: string): ReadOnlyRepository {
  const path = canonicalizeRepositoryRelativePath("package.json");
  const bytes = new TextEncoder().encode(content);
  return {
    inspect: vi.fn(),
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    readDirectory: vi.fn(),
    readFile: vi.fn((input: unknown): Promise<ReadOnlyRepositoryFile> => {
      expect(input).toBe(path);
      return Promise.resolve(
        new ReadOnlyRepositoryFile(path, bytes, { device: "fixture", inode: "package" }, 0),
      );
    }),
    root: "/synthetic",
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
}

function statementNode(ir: InstructionIr): AstNode {
  const node = ir.nodes.find(
    (candidate) => candidate.kind === "paragraph" && candidate.range.start.line === 1,
  );
  if (node === undefined) throw new Error("missing statement paragraph");
  return node;
}

describe("F09 end-to-end contracts", () => {
  test("composes a real F01 index with F02/F03, formatters, and targeted suppression", async () => {
    const markdown = [
      "<!-- agent-context-lint-disable-next-line ACL300 -- fixture intentionally demonstrates drift -->",
      "Run npm run missing",
    ].join("\n");
    const { ir, source } = sourceAndIr(markdown);
    const parsedSuppressions = parseSuppressionDirectives(ir);
    expect(parsedSuppressions.issues).toEqual([]);
    const directive = parsedSuppressions.directives[0];
    if (directive === undefined) throw new Error("missing suppression directive");
    const node = statementNode(ir);
    const repository = repositoryWithPackageJson(
      JSON.stringify({ name: "fixture", packageManager: "npm@11.18.0", scripts: { build: "tsc" } }),
    );
    const evidence = await collectRepositoryEvidence(repository, packageWorkspace(), [
      canonicalizeRepositoryRelativePath("package.json"),
    ]);
    expect(evidence.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "package-manager", value: "npm" }),
        expect.objectContaining({ category: "script", name: "build" }),
      ]),
    );

    const drift = evaluateRepositoryDrift(
      [
        {
          dialect: "posix-shell",
          documentId: "document:AGENTS.md" as InstructionDocumentId,
          nodeIds: [node.id],
          path: source.path,
          range: directive.target.range,
          sourceDigest: source.sha256,
          statementId: "statement:missing-script" as InstructionStatementId,
          text: "Run npm run missing",
        },
      ],
      evidence,
    );
    expect(drift.bundle.diagnostics).toHaveLength(1);
    expect(drift.bundle.diagnostics[0]).toMatchObject({ ruleId: "ACL300", severity: "error" });
    expect(validateDiagnosticBundle(drift.bundle, [source])).toMatchObject({ ok: true });

    const profileVersions = {
      "codex-cli": { clientVersion: "0.1.0", profileVersion: "2026.8.2" },
    } as const;
    const json = formatJsonDiagnostics(drift.bundle, [source], { profileVersions });
    const stylish = formatStylishDiagnostics(drift.bundle, [source], { color: "never" });
    const sarif = formatSarifDiagnostics(drift.bundle, [source], {
      informationUri: "https://agent-context-lint.dev/",
      profileVersions,
      ruleDocumentationBaseUri: "https://agent-context-lint.dev/",
      toolVersion: "0.1.0",
    });
    if (!json.ok) throw new Error(JSON.stringify(json.issues));
    if (!stylish.ok) throw new Error(JSON.stringify(stylish.issues));
    if (!sarif.ok) throw new Error(JSON.stringify(sarif.issues));
    expect(json.ok).toBe(true);
    expect(stylish.ok).toBe(true);
    expect(sarif.ok).toBe(true);
    expect(json.text).toContain("ACL300");
    expect(stylish.text).toContain("ACL300");
    expect(sarif.text).toContain("ACL300");

    const suppressionBundle = {
      ...drift.bundle,
      suppressions: [directive.record],
    };
    const suppressed = matchSuppressionDirectives(
      suppressionBundle,
      parsedSuppressions.directives,
      [source],
    );
    expect(suppressed.suppressedDiagnostics).toHaveLength(1);
    expect(suppressed.visibleDiagnostics).toEqual([]);
    expect(suppressed.bundle.suppressions[0]).toMatchObject({
      state: "suppressed",
      targetRuleIds: ["ACL300"],
    });
  });

  test("never reads files or invokes network while evaluating an already-collected index", async () => {
    const sourceText = "Run pnpm run absent";
    const input = sourceAndIr(sourceText);
    const repository = repositoryWithPackageJson(
      JSON.stringify({ name: "fixture", packageManager: "pnpm@11.18.0", scripts: {} }),
    );
    const evidence = await collectRepositoryEvidence(repository, packageWorkspace(), [
      canonicalizeRepositoryRelativePath("package.json"),
    ]);
    const readFileMock = vi.mocked(Reflect.get(repository, "readFile"));
    const readsAfterCollection = readFileMock.mock.calls.length;
    const fetch = vi.spyOn(globalThis, "fetch");
    const node = input.ir.nodes.find((candidate) => candidate.kind === "paragraph");
    if (node === undefined) throw new Error("missing paragraph");
    evaluateRepositoryDrift(
      [
        {
          dialect: "posix-shell",
          documentId: "document:AGENTS.md" as InstructionDocumentId,
          nodeIds: [node.id],
          path: input.source.path,
          range: node.range,
          sourceDigest: input.source.sha256,
          statementId: "statement:offline" as InstructionStatementId,
          text: sourceText,
        },
      ],
      evidence,
    );
    expect(readFileMock).toHaveBeenCalledTimes(readsAfterCollection);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
