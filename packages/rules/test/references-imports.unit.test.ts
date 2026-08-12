import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  validateInstructionIr,
} from "@agent-context/core";
import type {
  DocumentFormatId,
  InstructionDocument,
  InstructionIr,
  RepositoryRelativePath,
  SourceDocument,
} from "@agent-context/core";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  loadImportGraph,
} from "@agent-context/evidence";
import type { ImportGraphResult, ReadOnlyRepository } from "@agent-context/evidence";
import { lexImportReferences } from "@agent-context/syntax";
import type { ImportDialect } from "@agent-context/syntax";

import {
  ReferencesImportsError,
  ReferencesImportsErrorCode,
  evaluateReferencesImports,
} from "../src/index.js";
import type { ReferenceProfileTarget, ReferencesImportsInput } from "../src/index.js";

type Sources = Readonly<Record<string, string>>;

function fixtureRepository(sources: Sources, caseInsensitive = false): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/fixture",
    inspect(): ReturnType<ReadOnlyRepository["inspect"]> {
      return Promise.reject(new Error("not used"));
    },
    readDirectory(): ReturnType<ReadOnlyRepository["readDirectory"]> {
      return Promise.reject(new Error("not used"));
    },
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const requested = canonicalizeRepositoryRelativePath(String(value));
      const actual =
        Object.keys(sources).find(
          (path) =>
            path === requested ||
            (caseInsensitive && path.toLowerCase() === requested.toLowerCase()),
        ) ?? requested;
      const source = sources[actual];
      if (source === undefined)
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
          { device: "1", inode: String(Object.keys(sources).indexOf(actual) + 1) },
          0,
        ),
      );
    },
    usage(): ReturnType<ReadOnlyRepository["usage"]> {
      return { elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 };
    },
  };
}

function lineEnding(text: string): SourceDocument["lineEnding"] {
  if (text.includes("\r\n")) return "crlf";
  if (text.includes("\n")) return "lf";
  if (text.includes("\r")) return "cr";
  return "none";
}

function formatFor(syntax: ImportDialect): DocumentFormatId {
  if (syntax === "gemini-cli") return "gemini-context-markdown";
  if (syntax === "cursor-agent") return "cursor-mdc";
  if (syntax === "copilot-cli") return "copilot-repository-markdown";
  return "claude-memory-markdown";
}

function graphIr(graph: ImportGraphResult, sources: Sources): InstructionIr {
  const nodes = [];
  const imports = [];
  const sourceDocuments: SourceDocument[] = [];
  const documents: InstructionDocument[] = [];
  for (const graphNode of graph.nodes) {
    const text =
      sources[graphNode.path] ??
      sources[
        Object.keys(sources).find((path) => path.toLowerCase() === graphNode.path.toLowerCase()) ??
          ""
      ];
    if (text === undefined) throw new Error(`missing fixture bytes for ${graphNode.path}`);
    const syntax = lexImportReferences({
      documentId: graphNode.documentId,
      sourceId: graphNode.sourceId,
      syntax: graph.syntax,
      text,
    });
    expect(syntax.imports).toEqual(graphNode.imports);
    nodes.push(...syntax.markdown.nodes);
    imports.push(...syntax.imports);
    sourceDocuments.push({
      bom: text.startsWith("\uFEFF") ? "utf-8" : "none",
      byteLength: Buffer.byteLength(text, "utf8"),
      encoding: "utf-8",
      id: graphNode.sourceId,
      lineEnding: lineEnding(text),
      parseState: syntax.markdown.parseState,
      path: graphNode.path,
      rootNodeId: syntax.markdown.rootNodeId,
      sha256: createHash("sha256").update(text).digest("hex"),
      text,
      utf16Length: text.length,
    });
    documents.push({
      activationRuleIds: [],
      formatId: formatFor(graph.syntax),
      id: graphNode.documentId,
      importIds: syntax.imports.map((reference) => reference.id),
      rootNodeId: syntax.markdown.rootNodeId,
      scopeRoot: "." as RepositoryRelativePath,
      sourceId: graphNode.sourceId,
      statementIds: [],
    });
  }
  const ir: InstructionIr = {
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents,
    events: [],
    imports,
    nodes,
    recordKind: "agent-context-instruction-ir",
    sources: sourceDocuments,
    statements: [],
    targets: [],
  };
  const validation = validateInstructionIr(ir);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

function claudeTargets(ir: InstructionIr): readonly ReferenceProfileTarget[] {
  return ir.imports.map((reference) => ({
    formatId: "claude-memory-markdown",
    importId: reference.id,
    markdownLinks: "not-applicable",
    profileId: "claude-code",
    surfaceId: "claude-code/local-session",
  }));
}

function replaceReference(
  ir: InstructionIr,
  changes: Partial<InstructionIr["imports"][number]>,
): InstructionIr {
  const first = ir.imports[0];
  if (first === undefined) throw new Error("missing reference");
  const candidate: InstructionIr = {
    ...ir,
    imports: [{ ...first, ...changes }, ...ir.imports.slice(1)],
  };
  const validation = validateInstructionIr(candidate);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

function input(
  ir: InstructionIr,
  graphs: readonly ImportGraphResult[],
  paths: readonly string[],
  targets: readonly ReferenceProfileTarget[] = claudeTargets(ir),
  completeness: "complete" | "partial" = "complete",
): ReferencesImportsInput {
  return {
    contractVersion: "0.1.0",
    graphs,
    ir,
    pathSnapshot: {
      completeness,
      paths: [...paths].sort().map((path) => canonicalizeRepositoryRelativePath(path)),
    },
    recordKind: "agent-context-references-imports-rule-input",
    targets,
  };
}

async function graph(
  sources: Sources,
  entry = "AGENTS.md",
  syntax: ImportDialect = "claude-code",
  caseInsensitive = false,
): Promise<ImportGraphResult> {
  return loadImportGraph({
    entryPath: canonicalizeRepositoryRelativePath(entry),
    repository: fixtureRepository(sources, caseInsensitive),
    syntax,
  });
}

describe("F06 reference and import rules", () => {
  test("emits ACL150, ACL151, ACL152, ACL153, ACL154, and ACL156 from real C10 evidence", async () => {
    const sources = {
      "dir/AGENTS.md": [
        "@missing.md",
        "@cycle.md",
        "@../../outside.md",
        "@/Users/example/policy.md",
        "@https://example.test/policy.md",
        "@docs/policy.md",
      ].join("\n"),
      "dir/Docs/Policy.md": "Portable policy\n",
      "dir/cycle.md": "@AGENTS.md\n",
    };
    const loaded = await graph(sources, "dir/AGENTS.md", "claude-code", true);
    const ir = graphIr(loaded, sources);
    const result = evaluateReferencesImports(
      input(ir, [loaded], ["dir/AGENTS.md", "dir/Docs/Policy.md", "dir/cycle.md"]),
    );

    expect(result.bundle.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      "ACL150",
      "ACL152",
      "ACL153",
      "ACL154",
      "ACL156",
      "ACL151",
    ]);
    expect(result.bundle.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
      "error",
      "error",
      "warning",
      "warning",
      "warning",
      "error",
    ]);
    expect(result.metrics).toMatchObject({ diagnosticCount: 6, graphCount: 1, referenceCount: 7 });
    expect(result.uncertainties).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bundle.diagnostics[0]?.primary.range.start)).toBe(true);
  });

  test("emits ACL155 only for profile-and-format combinations that definitely reject the syntax", async () => {
    const sources = { "AGENTS.md": "@docs/policy.md\n", "docs/policy.md": "ok\n" };
    const loaded = await graph(sources);
    const ir = graphIr(loaded, sources);
    const reference = ir.imports[0];
    if (reference === undefined) throw new Error("missing reference");
    const targets: ReferenceProfileTarget[] = [
      {
        formatId: "agents-markdown",
        importId: reference.id,
        markdownLinks: "not-applicable",
        profileId: "codex-cli",
        surfaceId: "codex-cli/local-cli-single-cwd",
      },
      {
        formatId: "cursor-mdc",
        importId: reference.id,
        markdownLinks: "not-applicable",
        profileId: "cursor-agent",
        surfaceId: "cursor-agent/ide",
      },
    ];
    const result = evaluateReferencesImports(
      input(ir, [loaded], ["AGENTS.md", "docs/policy.md"], targets),
    );
    expect(result.bundle.diagnostics).toEqual([expect.objectContaining({ ruleId: "ACL155" })]);
    expect(result.bundle.diagnostics[0]?.fingerprintBasis.semantic.profileIds).toEqual([
      "codex-cli",
    ]);
    expect(result.uncertainties).toEqual([
      expect.objectContaining({
        profileId: "cursor-agent",
        reason: "profile-reference-behavior-unknown",
        ruleId: "ACL155",
      }),
    ]);
  });

  test("honors separate Copilot surface reference claims and VS Code setting state", async () => {
    const sources = {
      ".github/copilot-instructions.md": "@docs/policy.md\n",
      ".github/docs/policy.md": "ok",
    };
    const loaded = await graph(sources, ".github/copilot-instructions.md", "copilot-cli");
    const ir = graphIr(loaded, sources);
    const reference = ir.imports[0];
    if (reference === undefined) throw new Error("missing reference");
    const result = evaluateReferencesImports(
      input(
        ir,
        [loaded],
        [".github/copilot-instructions.md", ".github/docs/policy.md"],
        [
          {
            formatId: "copilot-repository-markdown",
            importId: reference.id,
            markdownLinks: "not-applicable",
            profileId: "copilot-cli",
            surfaceId: "copilot-cli/local-terminal",
          },
          {
            formatId: "copilot-repository-markdown",
            importId: reference.id,
            markdownLinks: "disabled",
            profileId: "copilot-vscode",
            surfaceId: "copilot-vscode/local-chat",
          },
          {
            formatId: "copilot-repository-markdown",
            importId: reference.id,
            markdownLinks: "not-applicable",
            profileId: "copilot-cloud-agent",
            surfaceId: "copilot-cloud-agent/github-hosted",
          },
        ],
      ),
    );
    expect(result.bundle.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(["ACL155"]);
    expect(result.bundle.diagnostics[0]?.fingerprintBasis.semantic.profileIds).toEqual([
      "copilot-vscode",
    ]);
    expect(result.uncertainties).toEqual([
      expect.objectContaining({ profileId: "copilot-cloud-agent", ruleId: "ACL155" }),
    ]);
  });

  test("does not turn partial, unreadable, ambiguous, malformed, or resource-limited evidence into absence", async () => {
    const missingSources = { "AGENTS.md": "@missing.md\n" };
    const missingGraph = await graph(missingSources);
    const missingIr = graphIr(missingGraph, missingSources);
    const partial = evaluateReferencesImports(
      input(missingIr, [missingGraph], [], undefined, "partial"),
    );
    expect(partial.bundle.diagnostics).toEqual([]);
    expect(partial.uncertainties).toEqual([
      expect.objectContaining({ reason: "path-snapshot-partial", ruleId: "ACL150" }),
    ]);

    const existingButUnreadable = evaluateReferencesImports(
      input(missingIr, [missingGraph], ["AGENTS.md", "missing.md"]),
    );
    expect(existingButUnreadable.bundle.diagnostics).toEqual([]);
    expect(existingButUnreadable.uncertainties).toEqual([
      expect.objectContaining({ reason: "target-unavailable-not-missing", ruleId: "ACL150" }),
    ]);

    const ambiguousSources = { "AGENTS.md": "@name\n@bad\u0000tail\n@döcs/policy.md\n" };
    const ambiguousGraph = await graph(ambiguousSources);
    const ambiguousIr = graphIr(ambiguousGraph, ambiguousSources);
    const ambiguous = evaluateReferencesImports(
      input(ambiguousIr, [ambiguousGraph], ["AGENTS.md"]),
    );
    expect(ambiguous.bundle.diagnostics).toEqual([]);
    expect(ambiguous.uncertainties.map((entry) => entry.reason)).toEqual([
      "ambiguous-reference",
      "malformed-reference",
      "ambiguous-reference",
    ]);

    const depthSources = { "AGENTS.md": "@a.md\n", "a.md": "@b.md\n", "b.md": "ok" };
    const limitedGraph = await loadImportGraph(
      {
        entryPath: canonicalizeRepositoryRelativePath("AGENTS.md"),
        repository: fixtureRepository(depthSources),
        syntax: "claude-code",
      },
      { maxDepth: 1 },
    );
    const limitedIr = graphIr(limitedGraph, depthSources);
    const limited = evaluateReferencesImports(
      input(limitedIr, [limitedGraph], ["AGENTS.md", "a.md", "b.md"]),
    );
    expect(limited.bundle.diagnostics).toEqual([]);
    expect(limited.uncertainties).toEqual([
      expect.objectContaining({ reason: "graph-resource-limit", ruleId: "ACL150" }),
    ]);
  });

  test("keeps non-ASCII and colliding case folds unknown instead of guessing", async () => {
    const sources = { "AGENTS.md": "@docs/policy.md\n", "Docs/Policy.md": "ok" };
    const loaded = await graph(sources, "AGENTS.md", "claude-code", true);
    const ir = graphIr(loaded, sources);
    const result = evaluateReferencesImports(
      input(ir, [loaded], ["AGENTS.md", "DOCS/POLICY.MD", "Docs/Policy.md"]),
    );
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.uncertainties).toEqual([
      expect.objectContaining({ reason: "ambiguous-case-match", ruleId: "ACL156" }),
    ]);
  });

  test("covers the complete D03-D13 support matrix without borrowing behavior between surfaces", async () => {
    const sources = { "AGENTS.md": "@https://example.test/policy.md\n" };
    const loaded = await graph(sources);
    const vendorIr = graphIr(loaded, sources);
    const reference = vendorIr.imports[0];
    if (reference === undefined) throw new Error("missing reference");
    const remoteUnknown = evaluateReferencesImports(
      input(
        vendorIr,
        [loaded],
        ["AGENTS.md"],
        [
          {
            formatId: "cursor-legacy-rules",
            importId: reference.id,
            markdownLinks: "not-applicable",
            profileId: "cursor-agent",
            surfaceId: "cursor-agent/cli",
          },
          {
            formatId: "copilot-repository-markdown",
            importId: reference.id,
            markdownLinks: "not-applicable",
            profileId: "copilot-code-review",
            surfaceId: "copilot-code-review/github-hosted",
          },
        ],
      ),
    );
    expect(remoteUnknown.bundle.diagnostics).toEqual([]);
    expect(remoteUnknown.uncertainties.map((entry) => entry.profileId)).toEqual([
      "copilot-code-review",
      "cursor-agent",
    ]);

    const markdownIr = replaceReference(vendorIr, { kind: "markdown-link" });
    const markdownReference = markdownIr.imports[0];
    if (markdownReference === undefined) throw new Error("missing markdown reference");
    const profileMatrix: readonly ReferenceProfileTarget[] = [
      {
        formatId: "claude-memory-markdown",
        importId: markdownReference.id,
        markdownLinks: "not-applicable",
        profileId: "claude-code",
        surfaceId: "claude-code/local-session",
      },
      {
        formatId: "gemini-context-markdown",
        importId: markdownReference.id,
        markdownLinks: "not-applicable",
        profileId: "gemini-cli",
        surfaceId: "gemini-cli/local-terminal",
      },
      {
        formatId: "copilot-repository-markdown",
        importId: markdownReference.id,
        markdownLinks: "enabled",
        profileId: "copilot-vscode",
        surfaceId: "copilot-vscode/local-chat",
      },
    ];
    const matrix = evaluateReferencesImports(input(markdownIr, [], ["AGENTS.md"], profileMatrix));
    expect(matrix.bundle.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(["ACL154"]);
    expect(matrix.bundle.diagnostics[0]?.fingerprintBasis.semantic.profileIds).toEqual([
      "claude-code",
      "gemini-cli",
    ]);

    const localSources = { "AGENTS.md": "@a.md\n", "a.md": "ok" };
    const localGraph = await graph(localSources);
    const localIr = graphIr(localGraph, localSources);
    const localReference = localIr.imports[0];
    if (localReference === undefined) throw new Error("missing local reference");
    const unknownSetting = evaluateReferencesImports(
      input(
        localIr,
        [localGraph],
        ["AGENTS.md", "a.md"],
        [
          {
            formatId: "copilot-repository-markdown",
            importId: localReference.id,
            markdownLinks: "unknown",
            profileId: "copilot-vscode",
            surfaceId: "copilot-vscode/local-chat",
          },
          {
            formatId: "copilot-path-instructions",
            importId: localReference.id,
            markdownLinks: "not-applicable",
            profileId: "copilot-cli",
            surfaceId: "copilot-cli/local-terminal",
          },
        ],
      ),
    );
    expect(unknownSetting.bundle.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      "ACL155",
    ]);
    expect(unknownSetting.uncertainties).toEqual([
      expect.objectContaining({ profileId: "copilot-vscode", ruleId: "ACL155" }),
    ]);
  });

  test("is byte-deterministic and reaches 100% precision on a 120-case labeled path corpus", async () => {
    const references = Array.from({ length: 120 }, (_, index) => `@docs/p${String(index)}.md`).join(
      "\n",
    );
    const sources: Record<string, string> = { "AGENTS.md": `${references}\n` };
    for (let index = 0; index < 114; index += 1) sources[`docs/p${String(index)}.md`] = "ok\n";
    const loaded = await graph(sources);
    const ir = graphIr(loaded, sources);
    const paths = Object.keys(sources).sort();
    const first = evaluateReferencesImports(input(ir, [loaded], paths));
    const second = evaluateReferencesImports(input(ir, [loaded], paths));
    const predictions = new Set(
      first.bundle.diagnostics
        .filter((diagnostic) => diagnostic.ruleId === "ACL150")
        .map((diagnostic) => diagnostic.primary.range.start.line),
    );
    const expected = new Set([114, 115, 116, 117, 118, 119]);
    expect(predictions).toEqual(expected);
    expect(first).toEqual(second);
    const truePositives = [...predictions].filter((line) => expected.has(line)).length;
    const precision = truePositives / Math.max(1, predictions.size);
    expect(precision).toBe(1);
  });

  test("rejects hostile containers, inconsistent graphs, invalid profile tuples, and hard-limit excess", async () => {
    const sources = { "AGENTS.md": "@a.md\n", "a.md": "ok" };
    const loaded = await graph(sources);
    const ir = graphIr(loaded, sources);
    const valid = input(ir, [loaded], ["AGENTS.md", "a.md"]);
    const getter = vi.fn();
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "graphs", { enumerable: true, get: getter });
    expect(() => evaluateReferencesImports(accessor as never)).toThrow(ReferencesImportsError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => evaluateReferencesImports(new Proxy(valid, {}) as never)).toThrow(
      ReferencesImportsError,
    );
    expect(() =>
      evaluateReferencesImports({
        ...valid,
        pathSnapshot: { completeness: "complete", paths: ["a.md", "a.md"] },
      } as never),
    ).toThrow(ReferencesImportsError);
    expect(() =>
      evaluateReferencesImports({
        ...valid,
        targets: valid.targets.map((target) => ({ ...target, surfaceId: "wrong/surface" })),
      }),
    ).toThrow(ReferencesImportsError);
    const cloned = structuredClone(loaded);
    const tampered = {
      ...cloned,
      usage: { ...cloned.usage, files: cloned.usage.files + 1 },
    };
    expect(() => evaluateReferencesImports({ ...valid, graphs: [tampered] })).toThrow(
      expect.objectContaining({ code: ReferencesImportsErrorCode.dependencyFailure }),
    );
    expect(() => evaluateReferencesImports(valid, { maximumPaths: 0 })).toThrow(
      expect.objectContaining({ code: ReferencesImportsErrorCode.invalidOptions }),
    );
    expect(() =>
      evaluateReferencesImports(valid, {
        maximumPaths: 2_000_001,
      }),
    ).toThrow(expect.objectContaining({ code: ReferencesImportsErrorCode.invalidOptions }));
  });

  test("rejects every closed-contract boundary and enforces diagnostic and uncertainty limits", async () => {
    const sources = { "AGENTS.md": "@a.md\n", "a.md": "ok" };
    const loaded = await graph(sources);
    const ir = graphIr(loaded, sources);
    const valid = input(ir, [loaded], ["AGENTS.md", "a.md"]);
    const invalidInputs: unknown[] = [
      null,
      { ...valid, extra: true },
      { ...valid, contractVersion: "9.0.0" },
      { ...valid, ir: { ...ir, contractVersion: "9.0.0" } },
      { ...valid, pathSnapshot: { completeness: "unknown", paths: [] } },
      { ...valid, pathSnapshot: { completeness: "complete", paths: ["."] } },
      { ...valid, pathSnapshot: { completeness: "complete", paths: ["b.md", "a.md"] } },
      { ...valid, targets: [] },
      { ...valid, targets: [{ ...valid.targets[0], importId: "import:missing" }] },
      { ...valid, targets: [{ ...valid.targets[0], profileId: "unknown-agent" }] },
      { ...valid, targets: [valid.targets[0], valid.targets[0]] },
      { ...valid, targets: [{ ...valid.targets[0], formatId: "bad format" }] },
      { ...valid, targets: [{ ...valid.targets[0], markdownLinks: "enabled" }] },
      {
        ...valid,
        targets: [
          {
            ...valid.targets[0],
            markdownLinks: "not-applicable",
            profileId: "copilot-vscode",
            surfaceId: "copilot-vscode/local-chat",
            formatId: "copilot-repository-markdown",
          },
        ],
      },
      {
        ...valid,
        targets: [
          {
            ...valid.targets[0],
            profileId: "codex-cli",
            surfaceId: "wrong/codex",
            formatId: "agents-markdown",
          },
        ],
      },
      {
        ...valid,
        targets: [
          {
            ...valid.targets[0],
            profileId: "gemini-cli",
            surfaceId: "wrong/gemini",
            formatId: "gemini-context-markdown",
          },
        ],
      },
      {
        ...valid,
        targets: [
          {
            ...valid.targets[0],
            profileId: "cursor-agent",
            surfaceId: "wrong/cursor",
            formatId: "cursor-mdc",
          },
        ],
      },
      {
        ...valid,
        targets: [
          {
            ...valid.targets[0],
            profileId: "copilot-cli",
            surfaceId: "wrong/copilot",
            formatId: "copilot-repository-markdown",
          },
        ],
      },
      {
        ...valid,
        targets: [
          {
            ...valid.targets[0],
            profileId: "copilot-cli",
            surfaceId: "copilot-cli/local-terminal",
            formatId: "copilot-repository-markdown",
            markdownLinks: "enabled",
          },
        ],
      },
    ];
    for (const invalid of invalidInputs)
      expect(() => evaluateReferencesImports(invalid as never)).toThrow(
        expect.objectContaining({ code: ReferencesImportsErrorCode.invalidInput }),
      );

    const sparsePaths = Array(2) as string[];
    sparsePaths[0] = "AGENTS.md";
    expect(() =>
      evaluateReferencesImports({
        ...valid,
        pathSnapshot: { completeness: "complete", paths: sparsePaths as never },
      }),
    ).toThrow(ReferencesImportsError);
    const nonEnumerablePaths = ["AGENTS.md"];
    Object.defineProperty(nonEnumerablePaths, "0", {
      configurable: true,
      enumerable: false,
      value: "AGENTS.md",
      writable: true,
    });
    expect(() =>
      evaluateReferencesImports({
        ...valid,
        pathSnapshot: { completeness: "complete", paths: nonEnumerablePaths as never },
      }),
    ).toThrow(ReferencesImportsError);
    expect(() => evaluateReferencesImports(valid, null as never)).toThrow(
      expect.objectContaining({ code: ReferencesImportsErrorCode.invalidOptions }),
    );
    expect(() => evaluateReferencesImports(valid, { extra: 1 } as never)).toThrow(
      expect.objectContaining({ code: ReferencesImportsErrorCode.invalidOptions }),
    );
    const optionGetter = vi.fn();
    const accessorOptions = {} as Record<string, unknown>;
    Object.defineProperty(accessorOptions, "maximumPaths", { enumerable: true, get: optionGetter });
    expect(() => evaluateReferencesImports(valid, accessorOptions)).toThrow(ReferencesImportsError);
    expect(optionGetter).not.toHaveBeenCalled();
    expect(() => evaluateReferencesImports(valid, { maximumPaths: 1 })).toThrow(
      expect.objectContaining({ code: ReferencesImportsErrorCode.resourceLimit }),
    );
    expect(() => evaluateReferencesImports(valid, { maximumTextBytes: 1 })).toThrow(
      expect.objectContaining({ code: ReferencesImportsErrorCode.invalidInput }),
    );

    const omittedLoadedTarget = input(ir, [loaded], ["AGENTS.md"]);
    expect(() => evaluateReferencesImports(omittedLoadedTarget)).toThrow(
      expect.objectContaining({ code: ReferencesImportsErrorCode.invalidInput }),
    );
    const partialLoaded = evaluateReferencesImports(
      input(ir, [loaded], ["AGENTS.md"], undefined, "partial"),
    );
    expect(partialLoaded.bundle.diagnostics).toEqual([]);

    const absoluteSources = {
      "AGENTS.md": "@/a.md\n@/b.md\n",
    };
    const absoluteGraph = await graph(absoluteSources);
    const absoluteIr = graphIr(absoluteGraph, absoluteSources);
    expect(() =>
      evaluateReferencesImports(input(absoluteIr, [absoluteGraph], ["AGENTS.md"]), {
        maximumDiagnostics: 1,
      }),
    ).toThrow(expect.objectContaining({ code: ReferencesImportsErrorCode.resourceLimit }));

    const localReference = ir.imports[0];
    if (localReference === undefined) throw new Error("missing local reference");
    const duplicateUnknownTargets: ReferenceProfileTarget[] = [
      {
        formatId: "cursor-mdc",
        importId: localReference.id,
        markdownLinks: "not-applicable",
        profileId: "cursor-agent",
        surfaceId: "cursor-agent/ide",
      },
      {
        formatId: "cursor-legacy-rules",
        importId: localReference.id,
        markdownLinks: "not-applicable",
        profileId: "cursor-agent",
        surfaceId: "cursor-agent/ide",
      },
    ];
    const deduplicated = evaluateReferencesImports(
      input(ir, [loaded, loaded], ["AGENTS.md", "a.md"], duplicateUnknownTargets),
    );
    expect(deduplicated.uncertainties).toHaveLength(1);
    const [firstUnknownTarget] = duplicateUnknownTargets;
    if (firstUnknownTarget === undefined) throw new Error("missing unknown target");
    const enabledVendor = evaluateReferencesImports(
      input(
        ir,
        [loaded],
        ["AGENTS.md", "a.md"],
        [
          {
            formatId: "copilot-repository-markdown",
            importId: localReference.id,
            markdownLinks: "enabled",
            profileId: "copilot-vscode",
            surfaceId: "copilot-vscode/local-chat",
          },
        ],
      ),
    );
    expect(enabledVendor.bundle.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      "ACL155",
    ]);
    expect(() =>
      evaluateReferencesImports(
        input(
          ir,
          [loaded],
          ["AGENTS.md", "a.md"],
          [
            firstUnknownTarget,
            {
              ...firstUnknownTarget,
              profileId: "copilot-cloud-agent",
              surfaceId: "copilot-cloud-agent/github-hosted",
              formatId: "copilot-repository-markdown",
            },
          ],
        ),
        { maximumUncertainties: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: ReferencesImportsErrorCode.resourceLimit }));
  });
});
