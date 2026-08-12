import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  createInstructionIrSnapshot,
} from "@agent-context/core";
import type { InstructionDocumentId, InstructionIrSnapshot } from "@agent-context/core";
import { lexImportReferences, parseAgentsMarkdown } from "@agent-context/syntax";
import {
  loadImportGraph,
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
} from "@agent-context/evidence";
import type { ImportGraphResult, ReadOnlyRepository } from "@agent-context/evidence";
import { describe, expect, test, vi } from "vitest";

import {
  buildDocumentImportDag,
  buildNoImportDocumentDag,
  createSyntheticTargetTrace,
  DOCUMENT_IMPORT_DAG_LIMITS,
  DocumentImportDagError,
  DocumentImportDagErrorCode,
  digestResolutionEventTrace,
} from "../src/index.js";

function repository(sources: Readonly<Record<string, string | Uint8Array>>): ReadOnlyRepository {
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
      const path = canonicalizeRepositoryRelativePath(String(value));
      const source = sources[path];
      if (source === undefined) {
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "fixture path is unavailable",
          "read-file",
          path,
        );
      }
      const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
      return Promise.resolve(
        new ReadOnlyRepositoryFile(path, bytes, { device: "1", inode: path }, 0),
      );
    },
    usage(): ReturnType<ReadOnlyRepository["usage"]> {
      return { elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 };
    },
  };
}

const entryPath = canonicalizeRepositoryRelativePath("AGENTS.md");

function trace(target = "src/main.ts"): ReturnType<typeof createSyntheticTargetTrace> {
  return createSyntheticTargetTrace({
    launchCwd: canonicalizeRepositoryRelativePath("."),
    workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
    targetPath: canonicalizeRepositoryRelativePath(target),
    purpose: "document-import-dag-test",
  });
}

async function graph(
  sources: Readonly<Record<string, string | Uint8Array>>,
): Promise<ImportGraphResult> {
  return loadImportGraph({
    repository: repository(sources),
    entryPath,
    syntax: "claude-code",
  });
}

function mutable<T>(value: T): T {
  return structuredClone(value);
}

function noImportSnapshot(text = "Keep changes focused.\n"): {
  readonly documentId: InstructionDocumentId;
  readonly ir: InstructionIrSnapshot;
} {
  const parsed = parseAgentsMarkdown({
    bytes: new TextEncoder().encode(text),
    contentStatus: "complete",
    path: entryPath,
    scopeRoot: canonicalizeRepositoryRelativePath("."),
  });
  const snapshot = createInstructionIrSnapshot({
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: [parsed.document],
    events: [],
    imports: [],
    nodes: parsed.nodes,
    recordKind: "agent-context-instruction-ir",
    sources: [parsed.source],
    statements: parsed.statements,
    targets: [],
  });
  if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.issues));
  return { documentId: parsed.document.id, ir: snapshot.value };
}

describe("buildNoImportDocumentDag", () => {
  test("issues one deterministic entry occurrence from an issued no-import snapshot", () => {
    const input = noImportSnapshot();
    const first = buildNoImportDocumentDag({ ...input, trace: trace() });
    const second = buildNoImportDocumentDag({ ...input, trace: trace() });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ graphState: "complete", entryDocumentId: input.documentId });
    expect(first.documents).toHaveLength(1);
    expect(first.contents).toHaveLength(1);
    expect(first.occurrences).toEqual([
      expect.objectContaining({ ordinal: 0, state: "entry", targetDocumentId: input.documentId }),
    ]);
    expect(first.traceEventIds).toHaveLength(2);
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("uses the same entry occurrence identity as an equivalent one-node C10 DAG", () => {
    const text = "Keep changes focused.\n";
    const input = noImportSnapshot(text);
    const bridged = buildNoImportDocumentDag({ ...input, trace: trace() });
    const document = input.ir.documents[0];
    const source = input.ir.sources[0];
    if (document === undefined || source === undefined)
      throw new Error("fixture document is absent");
    const imported = buildDocumentImportDag({
      graph: {
        contractVersion: "0.1.0",
        edges: [],
        entryPath: source.path,
        issues: [],
        nodes: [
          {
            byteLength: source.byteLength,
            depth: 0,
            documentId: document.id,
            imports: [],
            path: source.path,
            sha256: source.sha256,
            sourceId: source.id,
            state: "loaded",
          },
        ],
        state: "complete",
        syntax: "claude-code",
        usage: { edges: 0, files: 1, issues: 0, totalBytes: source.byteLength },
      },
      trace: trace(),
    });

    expect(imported.entryDocumentId).toBe(input.documentId);
    expect(bridged.occurrences[0]?.id).toBe(imported.occurrences[0]?.id);
  });

  test("rejects cloned authority, imported documents, unknown IDs, proxies, and accessors", () => {
    const input = noImportSnapshot();
    expect(() => buildNoImportDocumentDag(structuredClone({ ...input, trace: trace() }))).toThrow(
      expect.objectContaining({ code: DocumentImportDagErrorCode.invalidInput }),
    );
    expect(() =>
      buildNoImportDocumentDag({
        ...input,
        documentId: "document:missing" as never,
        trace: trace(),
      }),
    ).toThrow(expect.objectContaining({ code: DocumentImportDagErrorCode.invalidRelationship }));
    expect(() =>
      buildNoImportDocumentDag(new Proxy({ ...input, trace: trace() }, {}) as never),
    ).toThrow(DocumentImportDagError);
    const getter = vi.fn();
    const accessor = { documentId: input.documentId, trace: trace() } as Record<string, unknown>;
    Object.defineProperty(accessor, "ir", { enumerable: true, get: getter });
    expect(() => buildNoImportDocumentDag(accessor as never)).toThrow(DocumentImportDagError);
    expect(getter).not.toHaveBeenCalled();

    const parsed = parseAgentsMarkdown({
      bytes: new TextEncoder().encode("@a.md\n"),
      contentStatus: "complete",
      path: entryPath,
      scopeRoot: canonicalizeRepositoryRelativePath("."),
    });
    const graphReference = lexImportReferences({
      documentId: parsed.document.id,
      sourceId: parsed.source.id,
      syntax: "claude-code",
      text: parsed.source.text,
    }).imports[0];
    if (graphReference === undefined) throw new Error("fixture import is missing");
    const snapshot = createInstructionIrSnapshot({
      activationRules: [],
      contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
      documents: [{ ...parsed.document, importIds: [graphReference.id] }],
      events: [],
      imports: [graphReference],
      nodes: parsed.nodes,
      recordKind: "agent-context-instruction-ir",
      sources: [parsed.source],
      statements: parsed.statements,
      targets: [],
    });
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.issues));
    expect(() =>
      buildNoImportDocumentDag({
        documentId: parsed.document.id,
        ir: snapshot.value,
        trace: trace(),
      }),
    ).toThrow(expect.objectContaining({ code: DocumentImportDagErrorCode.invalidRelationship }));
  });
});

describe("buildDocumentImportDag", () => {
  test("preserves repeated ordered occurrences while deduplicating identical content", async () => {
    const inputGraph = await graph({
      "AGENTS.md": "@a.md\n@b.md\n@a.md\n",
      "a.md": "same\n",
      "b.md": "same\n",
    });
    const inputTrace = trace();
    const first = buildDocumentImportDag({ graph: inputGraph, trace: inputTrace });
    const second = buildDocumentImportDag({ graph: inputGraph, trace: inputTrace });

    expect(first.documents.map((document) => document.path)).toEqual(["AGENTS.md", "a.md", "b.md"]);
    expect(first.contents).toHaveLength(2);
    const shared = first.contents.find((content) => content.documentIds.length === 2);
    expect(shared?.documentIds).toEqual(
      [first.documents[1]?.documentId, first.documents[2]?.documentId].sort(),
    );
    expect(first.occurrences.map((occurrence) => occurrence.state)).toEqual([
      "entry",
      "loaded",
      "loaded",
      "already-loaded",
    ]);
    expect(first.occurrences.slice(1).map((occurrence) => occurrence.targetPath)).toEqual([
      "a.md",
      "b.md",
      "a.md",
    ]);
    expect(first.occurrences[1]?.id).not.toBe(first.occurrences[3]?.id);
    expect(first.occurrences[1]?.contentId).toBe(first.occurrences[3]?.contentId);
    expect(first.traceSha256).toBe(digestResolutionEventTrace(inputTrace));
    expect(first.traceEventIds).toEqual(inputTrace.events.map((event) => event.id));
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.contents[0]?.documentIds)).toBe(true);
  });

  test("retains finite cycle evidence without creating an object cycle", async () => {
    const result = buildDocumentImportDag({
      graph: await graph({ "AGENTS.md": "@a.md\n", "a.md": "@AGENTS.md\n" }),
      trace: trace(),
    });

    expect(result.graphState).toBe("partial");
    expect(result.occurrences.map((occurrence) => occurrence.state)).toEqual([
      "entry",
      "loaded",
      "cycle",
    ]);
    expect(result.occurrences[2]).toMatchObject({
      issueCode: "IMPORT_GRAPH_CYCLE",
      targetDocumentId: result.entryDocumentId,
      targetPath: "AGENTS.md",
    });
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "IMPORT_GRAPH_CYCLE", path: "a.md" }),
    ]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test("retains partial missing-target evidence and a distinct occurrence attempt", async () => {
    const result = buildDocumentImportDag({
      graph: await graph({ "AGENTS.md": "@missing.md\n@safe.md\n", "safe.md": "safe" }),
      trace: trace(),
    });
    expect(result.occurrences.map((occurrence) => occurrence.state)).toEqual([
      "entry",
      "unavailable",
      "loaded",
    ]);
    expect(result.occurrences[1]).toMatchObject({
      contentId: null,
      issueCode: "IMPORT_GRAPH_READ_FAILED",
      targetDocumentId: null,
      targetPath: "missing.md",
    });
    expect(result.documents.map((document) => document.path)).toEqual(["AGENTS.md", "safe.md"]);
  });

  test("preserves rejected, ambiguous, limited, and parse-failed states without reinterpretation", async () => {
    const decisions = buildDocumentImportDag({
      graph: await graph({
        "AGENTS.md": "@https://example.com/a\n@file.md,\n@a.md\n",
        "a.md": "@b.md\n",
        "b.md": "b",
      }),
      trace: trace(),
    });
    expect(decisions.occurrences.map((occurrence) => occurrence.state)).toEqual([
      "entry",
      "rejected",
      "ambiguous",
      "loaded",
      "loaded",
    ]);

    const limitedGraph = await loadImportGraph(
      {
        repository: repository({ "AGENTS.md": "@a.md\n", "a.md": "a" }),
        entryPath,
        syntax: "claude-code",
      },
      { maxDepth: 0 },
    );
    const limited = buildDocumentImportDag({ graph: limitedGraph, trace: trace() });
    expect(limited.occurrences[1]?.state).toBe("limit-exceeded");

    const parseFailed = buildDocumentImportDag({
      graph: await graph({
        "AGENTS.md": "@bad.md\n",
        "bad.md": new Uint8Array([0xc3, 0x28]),
      }),
      trace: trace(),
    });
    expect(parseFailed.documents[1]).toMatchObject({ path: "bad.md", state: "parse-failed" });
    expect(parseFailed.occurrences[1]).toMatchObject({ state: "loaded", targetPath: "bad.md" });
  });

  test("binds the same graph to different ordered trace provenance without changing occurrences", async () => {
    const inputGraph = await graph({ "AGENTS.md": "@a.md\n", "a.md": "a" });
    const first = buildDocumentImportDag({ graph: inputGraph, trace: trace("src/a.ts") });
    const second = buildDocumentImportDag({ graph: inputGraph, trace: trace("src/b.ts") });
    expect(first.traceSha256).not.toBe(second.traceSha256);
    expect(first.traceEventIds).not.toEqual(second.traceEventIds);
    expect(first.occurrences).toEqual(second.occurrences);
    expect(first.contents).toEqual(second.contents);
  });

  test("returns a bounded empty occurrence set when the entry read failed", async () => {
    const result = buildDocumentImportDag({ graph: await graph({}), trace: trace() });
    expect(result.entryDocumentId).toBeNull();
    expect(result.documents).toEqual([]);
    expect(result.contents).toEqual([]);
    expect(result.occurrences).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "IMPORT_GRAPH_READ_FAILED", path: "AGENTS.md" }),
    ]);
  });

  test("rejects graph relationship, usage, syntax, version, and state forgeries", async () => {
    const valid = await graph({ "AGENTS.md": "@a.md\n", "a.md": "a" });
    const cases: ((candidate: ImportGraphResult) => void)[] = [
      (candidate): void => {
        (candidate as { contractVersion: string }).contractVersion = "9.0.0";
      },
      (candidate): void => {
        (candidate as { syntax: string }).syntax = "unknown";
      },
      (candidate): void => {
        (candidate.usage as { edges: number }).edges += 1;
      },
      (candidate): void => {
        (candidate.usage as { totalBytes: number }).totalBytes += 1;
      },
      (candidate): void => {
        (candidate as { state: string }).state = "partial";
      },
      (candidate): void => {
        (candidate.edges[0] as { fromDocumentId: string }).fromDocumentId = "document:missing";
      },
      (candidate): void => {
        const reference = candidate.edges[0]?.import as { documentId: string };
        reference.documentId = "document:other";
      },
      (candidate): void => {
        (candidate.edges[0] as { targetDocumentId: string }).targetDocumentId = "document:missing";
      },
      (candidate): void => {
        const range = candidate.edges[0]?.import.specifierRange as { sourceId: string };
        range.sourceId = "source:other";
      },
    ];
    for (const change of cases) {
      const candidate = mutable(valid);
      change(candidate);
      expect(() => buildDocumentImportDag({ graph: candidate, trace: trace() })).toThrow(
        DocumentImportDagError,
      );
    }
  });

  test("rejects malformed graph scalars, ranges, records, and edge relationships", async () => {
    const valid = await graph({ "AGENTS.md": "@a.md\n", "a.md": "a" });
    const changes: ((candidate: ImportGraphResult) => void)[] = [
      (candidate): void => {
        Object.assign(candidate, { extra: true });
      },
      (candidate): void => {
        (candidate as { nodes: unknown }).nodes = {};
      },
      (candidate): void => {
        Object.defineProperty(candidate.nodes, "0", {
          get: () => candidate.nodes[0],
          enumerable: true,
        });
      },
      (candidate): void => {
        (candidate.nodes[0] as { documentId: string }).documentId = "bad id";
      },
      (candidate): void => {
        (candidate.nodes[0] as { path: string }).path = "../escape";
      },
      (candidate): void => {
        (candidate.nodes[0] as { byteLength: number }).byteLength = -1;
      },
      (candidate): void => {
        const specifier = candidate.edges[0]?.import.specifierRange;
        if (specifier === undefined) throw new Error("fixture edge is missing");
        (specifier.end as { byteOffset: number }).byteOffset = specifier.start.byteOffset - 1;
      },
      (candidate): void => {
        (candidate.nodes[0] as { state: string }).state = "unknown";
      },
      (candidate): void => {
        (candidate.nodes[0] as { sha256: string }).sha256 = "BAD";
      },
      (candidate): void => {
        (candidate.edges[0] as { state: string }).state = "unknown";
      },
      (candidate): void => {
        (candidate.edges[0] as { issueCode: string }).issueCode = "UNKNOWN";
      },
      (candidate): void => {
        (candidate.edges[0]?.import as { rawSpecifier: unknown }).rawSpecifier = 1;
      },
      (candidate): void => {
        (candidate as { entryPath: string }).entryPath = ".";
      },
      (candidate): void => {
        (candidate as { state: string }).state = "unknown";
      },
      (candidate): void => {
        (candidate.edges[0] as { targetPath: string }).targetPath = "other.md";
      },
      (candidate): void => {
        (candidate.edges[0] as { targetDocumentId: null }).targetDocumentId = null;
      },
      (candidate): void => {
        (candidate.edges[0] as { issueCode: string }).issueCode = "IMPORT_GRAPH_READ_FAILED";
      },
    ];
    for (const change of changes) {
      const candidate = mutable(valid);
      change(candidate);
      expect(() => buildDocumentImportDag({ graph: candidate, trace: trace() })).toThrow(
        DocumentImportDagError,
      );
    }

    const issueGraph = mutable(await graph({ "AGENTS.md": "@missing.md\n" }));
    (issueGraph.issues[0] as { code: string }).code = "UNKNOWN";
    expect(() => buildDocumentImportDag({ graph: issueGraph, trace: trace() })).toThrow(
      DocumentImportDagError,
    );

    const failedTarget = mutable(await graph({ "AGENTS.md": "@missing.md\n" }));
    (failedTarget.edges[0] as { targetDocumentId: string }).targetDocumentId =
      failedTarget.nodes[0]?.documentId ?? "document:missing";
    (failedTarget.edges[0] as { targetPath: string }).targetPath = "AGENTS.md";
    expect(() => buildDocumentImportDag({ graph: failedTarget, trace: trace() })).toThrow(
      expect.objectContaining({ code: DocumentImportDagErrorCode.invalidRelationship }),
    );

    const duplicateImport = mutable(
      await graph({ "AGENTS.md": "@a.md\n@b.md\n", "a.md": "a", "b.md": "b" }),
    );
    const firstImportId = duplicateImport.edges[0]?.import.id;
    if (firstImportId === undefined) throw new Error("fixture import is missing");
    (duplicateImport.edges[1]?.import as { id: string }).id = firstImportId;
    expect(() => buildDocumentImportDag({ graph: duplicateImport, trace: trace() })).toThrow(
      DocumentImportDagError,
    );
  });

  test("rejects missing entries, duplicate document identities, and cumulative reference overflow", async () => {
    const valid = await graph({ "AGENTS.md": "ok" });
    const missing = mutable(valid);
    (missing.nodes[0] as { path: string }).path = "other.md";
    expect(() => buildDocumentImportDag({ graph: missing, trace: trace() })).toThrow(
      expect.objectContaining({ code: DocumentImportDagErrorCode.invalidRelationship }),
    );

    const duplicate = mutable(valid);
    const mutableDuplicate = duplicate as unknown as {
      nodes: unknown[];
      usage: { files: number; totalBytes: number };
    };
    mutableDuplicate.nodes.push(structuredClone(duplicate.nodes[0]));
    mutableDuplicate.usage.files = 2;
    mutableDuplicate.usage.totalBytes *= 2;
    expect(() => buildDocumentImportDag({ graph: duplicate, trace: trace() })).toThrow(
      expect.objectContaining({ code: DocumentImportDagErrorCode.invalidRelationship }),
    );

    const excessive = mutable(valid);
    const node = excessive.nodes[0];
    if (node === undefined) throw new Error("fixture node is missing");
    const mutableExcessive = excessive as unknown as {
      nodes: { readonly byteLength: number; readonly imports: readonly unknown[] }[];
      usage: { files: number; totalBytes: number };
    };
    mutableExcessive.nodes = Array.from({ length: 65 }, (_, index) => ({
      ...structuredClone(node),
      documentId: `document:copy-${String(index)}`,
      imports: Array.from({ length: 4_096 }, () => null),
      path: `copy-${String(index)}.md`,
      sourceId: `source:copy-${String(index)}`,
    }));
    mutableExcessive.usage.files = mutableExcessive.nodes.length;
    mutableExcessive.usage.totalBytes = mutableExcessive.nodes.length * node.byteLength;
    expect(() => buildDocumentImportDag({ graph: excessive, trace: trace() })).toThrow(
      expect.objectContaining({ code: DocumentImportDagErrorCode.resourceLimit }),
    );
  });

  test("rejects a forged content collision with conflicting lengths", async () => {
    const candidate = mutable(
      await graph({ "AGENTS.md": "@a.md\n@b.md\n", "a.md": "a", "b.md": "b" }),
    );
    const first = candidate.nodes[1];
    const second = candidate.nodes[2];
    if (first === undefined || second === undefined) throw new Error("fixture graph is incomplete");
    (second as { sha256: string }).sha256 = first.sha256;
    (candidate.usage as { totalBytes: number }).totalBytes += 1;
    (second as { byteLength: number }).byteLength += 1;
    expect(() => buildDocumentImportDag({ graph: candidate, trace: trace() })).toThrow(
      expect.objectContaining({ code: DocumentImportDagErrorCode.invalidRelationship }),
    );
  });

  test("rejects proxy, accessor, sparse, extended, and oversized containers without invoking code", async () => {
    const valid = await graph({ "AGENTS.md": "ok" });
    const getter = vi.fn();
    const accessor = { trace: trace() } as Record<string, unknown>;
    Object.defineProperty(accessor, "graph", { get: getter, enumerable: true });
    expect(() => buildDocumentImportDag(accessor as never)).toThrow(DocumentImportDagError);
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      buildDocumentImportDag(new Proxy({ graph: valid, trace: trace() }, {}) as never),
    ).toThrow(DocumentImportDagError);

    const sparse = mutable(valid) as unknown as { nodes: unknown[] };
    sparse.nodes = new Array(DOCUMENT_IMPORT_DAG_LIMITS.maxDocuments + 1);
    expect(() => buildDocumentImportDag({ graph: sparse as never, trace: trace() })).toThrow(
      expect.objectContaining({ code: DocumentImportDagErrorCode.resourceLimit }),
    );

    const extended = mutable(valid) as unknown as { edges: unknown[] };
    Object.defineProperty(extended.edges, "extra", { value: true });
    expect(() => buildDocumentImportDag({ graph: extended as never, trace: trace() })).toThrow(
      expect.objectContaining({ code: DocumentImportDagErrorCode.invalidInput }),
    );
  });

  test("passes malformed traces through E03's closed validation boundary", async () => {
    const valid = await graph({ "AGENTS.md": "ok" });
    expect(() => buildDocumentImportDag({ graph: valid, trace: {} as never })).toThrow(
      expect.objectContaining({ code: "EVENT_TRACE_INVALID_INPUT" }),
    );
  });
});
