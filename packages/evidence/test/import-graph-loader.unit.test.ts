import { randomUUID } from "node:crypto";
import { symlink } from "node:fs/promises";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";
import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_IMPORT_GRAPH_LIMITS,
  createReadOnlyRepository,
  ImportGraphLoaderError,
  loadImportGraph,
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  selectRepositoryRoot,
} from "../src/index.js";
import type { ReadOnlyRepository } from "../src/index.js";

function repository(
  sources: Readonly<Record<string, string | Uint8Array>>,
  reads: string[] = [],
  identities: Readonly<Record<string, { readonly device: string; readonly inode: string }>> = {},
): ReadOnlyRepository {
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
      const pathValue = canonicalizeRepositoryRelativePath(String(value));
      reads.push(pathValue);
      const source = sources[pathValue];
      if (source === undefined) {
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "fixture path is unavailable",
          "read-file",
          pathValue,
        );
      }
      const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          pathValue,
          bytes,
          identities[pathValue] ?? {
            device: "1",
            inode: String(Object.keys(sources).indexOf(pathValue) + 1),
          },
          0,
        ),
      );
    },
    usage(): ReturnType<ReadOnlyRepository["usage"]> {
      return { elapsedMs: 0, entries: reads.length, metadataOperations: 0, totalBytes: 0 };
    },
  };
}

const entryPath = canonicalizeRepositoryRelativePath("AGENTS.md");

describe("loadImportGraph", () => {
  test("loads a deterministic depth-first graph while preserving source-order edge occurrences", async () => {
    const reads: string[] = [];
    const fixture = repository(
      {
        "AGENTS.md": "@docs/a.md\n@docs/b.md\n@docs/a.md\n",
        "docs/a.md": "@nested/c.md\n",
        "docs/b.md": "B\n",
        "docs/nested/c.md": "C\n",
      },
      reads,
    );

    const first = await loadImportGraph({ repository: fixture, entryPath, syntax: "claude-code" });
    const second = await loadImportGraph({
      repository: repository(
        {
          "AGENTS.md": "@docs/a.md\n@docs/b.md\n@docs/a.md\n",
          "docs/a.md": "@nested/c.md\n",
          "docs/b.md": "B\n",
          "docs/nested/c.md": "C\n",
        },
        [],
        {
          "AGENTS.md": { device: "different", inode: "101" },
          "docs/a.md": { device: "different", inode: "102" },
          "docs/b.md": { device: "different", inode: "103" },
          "docs/nested/c.md": { device: "different", inode: "104" },
        },
      ),
      entryPath,
      syntax: "claude-code",
    });

    expect(first.state).toBe("complete");
    expect(first.nodes.map((node) => node.path)).toEqual([
      "AGENTS.md",
      "docs/a.md",
      "docs/nested/c.md",
      "docs/b.md",
    ]);
    expect(first.edges.map((edge) => [edge.import.rawSpecifier, edge.state])).toEqual([
      ["docs/a.md", "loaded"],
      ["nested/c.md", "loaded"],
      ["docs/b.md", "loaded"],
      ["docs/a.md", "already-loaded"],
    ]);
    expect(reads).toEqual(["AGENTS.md", "docs/a.md", "docs/nested/c.md", "docs/b.md"]);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nodes[0]?.imports)).toBe(true);
  });

  test("reports a finite source-located cycle and never rereads the active target", async () => {
    const reads: string[] = [];
    const result = await loadImportGraph({
      repository: repository(
        { "AGENTS.md": "@docs/a.md\n", "docs/a.md": "@../AGENTS.md\n" },
        reads,
      ),
      entryPath,
      syntax: "claude-code",
    });

    expect(result.state).toBe("partial");
    expect(result.edges.map((edge) => edge.state)).toEqual(["loaded", "cycle"]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      code: "IMPORT_GRAPH_CYCLE",
      path: "docs/a.md",
      targetPath: "AGENTS.md",
    });
    expect(result.issues[0]?.range?.sourceId).toBe(result.nodes[1]?.sourceId);
    expect(reads).toEqual(["AGENTS.md", "docs/a.md"]);
  });

  test("detects an active file reached through a different in-root symlink identity", async () => {
    const reads: string[] = [];
    const sameIdentity = { device: "7", inode: "11" };
    const result = await loadImportGraph({
      repository: repository({ "AGENTS.md": "@alias.md\n", "alias.md": "@alias.md\n" }, reads, {
        "AGENTS.md": sameIdentity,
        "alias.md": sameIdentity,
      }),
      entryPath,
      syntax: "claude-code",
    });

    expect(reads).toEqual(["AGENTS.md", "alias.md"]);
    expect(result.nodes.map((node) => node.path)).toEqual(["AGENTS.md"]);
    expect(result.edges).toEqual([
      expect.objectContaining({
        state: "cycle",
        targetDocumentId: result.nodes[0]?.documentId,
        targetPath: "alias.md",
      }),
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "IMPORT_GRAPH_CYCLE", targetPath: "alias.md" }),
    ]);
  });

  test("composes with the real C02 facade and contains an external symlink target", async () => {
    await withTempWorkspace(
      {
        "outside.md": "SECRET_OUTSIDE_CONTENT",
        "project/AGENTS.md": "@safe.md\n@escape.md\n",
        "project/safe.md": "safe",
      },
      async (workspace): Promise<void> => {
        await symlink(
          workspace.resolvePath("outside.md"),
          workspace.resolvePath("project/escape.md"),
        );
        const selection = await selectRepositoryRoot(workspace.resolvePath("project"), {
          mode: "explicit",
        });
        const facade = await createReadOnlyRepository(selection);
        const result = await loadImportGraph({
          repository: facade,
          entryPath,
          syntax: "claude-code",
        });

        expect(result.nodes.map((node) => node.path)).toEqual(["AGENTS.md", "safe.md"]);
        expect(result.edges.map((edge) => edge.state)).toEqual(["loaded", "unavailable"]);
        expect(result.issues).toEqual([
          expect.objectContaining({
            code: "IMPORT_GRAPH_READ_FAILED",
            path: "AGENTS.md",
            targetPath: "escape.md",
          }),
        ]);
        expect(JSON.stringify(result)).not.toContain("SECRET_OUTSIDE_CONTENT");
      },
    );
  });

  test("rejects escapes, absolute paths, URLs, malformed, and ambiguous references without reads", async () => {
    const reads: string[] = [];
    const result = await loadImportGraph({
      repository: repository(
        {
          "dir/AGENTS.md": [
            "@../../escape.md",
            "@/absolute.md",
            "@https://example.com/a",
            "@file.md,",
            "@file\u0000tail",
          ].join("\n"),
        },
        reads,
      ),
      entryPath: canonicalizeRepositoryRelativePath("dir/AGENTS.md"),
      syntax: "claude-code",
    });

    expect(reads).toEqual(["dir/AGENTS.md"]);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges.map((edge) => edge.state)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "ambiguous",
      "ambiguous",
    ]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "IMPORT_GRAPH_ROOT_BOUNDARY",
      "IMPORT_GRAPH_TARGET_REJECTED",
      "IMPORT_GRAPH_TARGET_REJECTED",
      "IMPORT_GRAPH_AMBIGUOUS_REFERENCE",
      "IMPORT_GRAPH_AMBIGUOUS_REFERENCE",
    ]);
    expect(result.issues.every((issue) => issue.range !== null)).toBe(true);
  });

  test("contains missing targets as source-located partial failures", async () => {
    const result = await loadImportGraph({
      repository: repository({ "AGENTS.md": "@missing.md\n@present.md\n", "present.md": "ok" }),
      entryPath,
      syntax: "claude-code",
    });

    expect(result.nodes.map((node) => node.path)).toEqual(["AGENTS.md", "present.md"]);
    expect(result.edges.map((edge) => edge.state)).toEqual(["unavailable", "loaded"]);
    expect(result.issues[0]).toMatchObject({
      code: "IMPORT_GRAPH_READ_FAILED",
      path: "AGENTS.md",
      targetPath: "missing.md",
    });
    expect(result.issues[0]?.range?.sourceId).toBe(result.nodes[0]?.sourceId);
  });

  test("normalizes safe dot and empty path segments before a jailed read", async () => {
    const reads: string[] = [];
    const result = await loadImportGraph({
      repository: repository(
        {
          "dir/AGENTS.md": "@./a.md\n@nested//b.md\n",
          "dir/a.md": "a",
          "dir/nested/b.md": "b",
        },
        reads,
      ),
      entryPath: canonicalizeRepositoryRelativePath("dir/AGENTS.md"),
      syntax: "claude-code",
    });
    expect(result.state).toBe("complete");
    expect(reads).toEqual(["dir/AGENTS.md", "dir/a.md", "dir/nested/b.md"]);
  });

  test("preserves a UTF-8 BOM so import byte and UTF-16 ranges stay source-exact", async () => {
    const result = await loadImportGraph({
      repository: repository({ "AGENTS.md": "\uFEFF@a.md\n", "a.md": "a" }),
      entryPath,
      syntax: "claude-code",
    });
    expect(result.edges[0]?.import.range.start).toMatchObject({
      byteOffset: 3,
      utf16Offset: 1,
    });
    expect(result.edges[0]?.import.specifierRange.start).toMatchObject({
      byteOffset: 4,
      utf16Offset: 2,
    });
  });

  test("enforces depth at the exact boundary", async () => {
    const sources = {
      "AGENTS.md": "@a.md\n",
      "a.md": "@b.md\n",
      "b.md": "@c.md\n",
      "c.md": "done",
    };
    const result = await loadImportGraph(
      { repository: repository(sources), entryPath, syntax: "claude-code" },
      { maxDepth: 2 },
    );

    expect(result.nodes.map((node) => node.path)).toEqual(["AGENTS.md", "a.md", "b.md"]);
    expect(result.edges.map((edge) => edge.state)).toEqual(["loaded", "loaded", "limit-exceeded"]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "IMPORT_GRAPH_DEPTH_LIMIT", targetPath: "c.md" }),
    ]);
  });

  test("bounds loaded fan-out while retaining one decision for every lexical occurrence", async () => {
    const result = await loadImportGraph(
      {
        repository: repository({
          "AGENTS.md": "@a.md\n@b.md\n@c.md\n",
          "a.md": "a",
          "b.md": "b",
          "c.md": "c",
        }),
        entryPath,
        syntax: "claude-code",
      },
      { maxFanOut: 2 },
    );

    expect(result.nodes.map((node) => node.path)).toEqual(["AGENTS.md", "a.md", "b.md"]);
    expect(result.edges.map((edge) => edge.state)).toEqual(["loaded", "loaded", "limit-exceeded"]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "IMPORT_GRAPH_FAN_OUT_LIMIT",
        importId: result.edges[2]?.import.id,
      }),
    ]);
  });

  test("enforces unique-file and aggregate-byte ceilings before accepting another node", async () => {
    const files = {
      "AGENTS.md": "@a.md\n@b.md\n",
      "a.md": "12345",
      "b.md": "67890",
    };
    const fileLimited = await loadImportGraph(
      { repository: repository(files), entryPath, syntax: "claude-code" },
      { maxFiles: 2 },
    );
    expect(fileLimited.nodes.map((node) => node.path)).toEqual(["AGENTS.md", "a.md"]);
    expect(fileLimited.edges.at(-1)).toMatchObject({
      issueCode: "IMPORT_GRAPH_FILE_LIMIT",
      state: "limit-exceeded",
      targetPath: "b.md",
    });

    const rootBytes = new TextEncoder().encode(files["AGENTS.md"]).byteLength;
    const byteLimited = await loadImportGraph(
      { repository: repository(files), entryPath, syntax: "claude-code" },
      { maxTotalBytes: rootBytes + 5 },
    );
    expect(byteLimited.nodes.map((node) => node.path)).toEqual(["AGENTS.md", "a.md"]);
    expect(byteLimited.usage.totalBytes).toBe(rootBytes + 5);
    expect(byteLimited.edges.at(-1)).toMatchObject({
      issueCode: "IMPORT_GRAPH_TOTAL_BYTES_LIMIT",
      state: "limit-exceeded",
    });
  });

  test("contains invalid UTF-8 and per-file overflow without leaking content", async () => {
    const invalid = await loadImportGraph({
      repository: repository({ "AGENTS.md": new Uint8Array([0xc3, 0x28]) }),
      entryPath,
      syntax: "claude-code",
    });
    expect(invalid.nodes[0]).toMatchObject({ state: "parse-failed", byteLength: 2 });
    expect(invalid.issues).toEqual([
      expect.objectContaining({ code: "IMPORT_GRAPH_INVALID_UTF8", range: null }),
    ]);
    expect(JSON.stringify(invalid)).not.toContain("�");

    const importedInvalid = await loadImportGraph({
      repository: repository({
        "AGENTS.md": "@bad.md\n",
        "bad.md": new Uint8Array([0xc3, 0x28]),
      }),
      entryPath,
      syntax: "claude-code",
    });
    expect(importedInvalid.edges[0]).toMatchObject({ state: "loaded", targetPath: "bad.md" });
    expect(importedInvalid.nodes[1]).toMatchObject({ state: "parse-failed", path: "bad.md" });
    expect(importedInvalid.issues[0]).toMatchObject({
      code: "IMPORT_GRAPH_INVALID_UTF8",
      path: "AGENTS.md",
      targetPath: "bad.md",
    });
    expect(importedInvalid.issues[0]?.range?.sourceId).toBe(importedInvalid.nodes[0]?.sourceId);

    const tooLarge = await loadImportGraph(
      { repository: repository({ "AGENTS.md": "12345" }), entryPath, syntax: "claude-code" },
      { maxFileBytes: 4 },
    );
    expect(tooLarge.nodes).toEqual([]);
    expect(tooLarge.issues).toEqual([
      expect.objectContaining({ code: "IMPORT_GRAPH_FILE_TOO_LARGE", path: "AGENTS.md" }),
    ]);
  });

  test("retains a bounded parse-failed node when C09 rejects pathological Markdown", async () => {
    const pathological = "a\n\n".repeat(25_001);
    const result = await loadImportGraph({
      repository: repository({ "AGENTS.md": pathological }),
      entryPath,
      syntax: "claude-code",
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      byteLength: new TextEncoder().encode(pathological).byteLength,
      imports: [],
      state: "parse-failed",
    });
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "IMPORT_GRAPH_LEX_FAILED", range: null }),
    ]);
  });

  test("caps issue materialization independently from ordered edge decisions", async () => {
    const result = await loadImportGraph(
      {
        repository: repository({
          "AGENTS.md": "@https://a.example\n@https://b.example\n@https://c.example\n",
        }),
        entryPath,
        syntax: "claude-code",
      },
      { maxIssues: 1 },
    );
    expect(result.issues).toHaveLength(1);
    expect(result.edges).toHaveLength(3);
    expect(result.usage.issues).toBe(1);
    expect(result.state).toBe("partial");
  });

  test("halts expansion at the global ordered-edge ceiling", async () => {
    const result = await loadImportGraph(
      {
        repository: repository({
          "AGENTS.md": "@https://a.example\n@https://b.example\n@https://c.example\n",
        }),
        entryPath,
        syntax: "claude-code",
      },
      { maxEdges: 2 },
    );
    expect(result.edges).toHaveLength(2);
    expect(result.usage.edges).toBe(2);
    expect(result.issues.at(-1)).toMatchObject({
      code: "IMPORT_GRAPH_EDGE_LIMIT",
      importId: result.nodes[0]?.imports[2]?.id,
      path: "AGENTS.md",
    });

    const nested = await loadImportGraph(
      {
        repository: repository({ "AGENTS.md": "@a.md\n", "a.md": "@b.md\n", "b.md": "b" }),
        entryPath,
        syntax: "claude-code",
      },
      { maxEdges: 1 },
    );
    expect(nested.nodes.map((node) => node.path)).toEqual(["AGENTS.md", "a.md"]);
    expect(nested.edges).toEqual([
      expect.objectContaining({ state: "loaded", targetPath: "a.md" }),
    ]);
    expect(nested.issues).toEqual([
      expect.objectContaining({ code: "IMPORT_GRAPH_EDGE_LIMIT", path: "a.md" }),
    ]);
  });

  test("rejects widened, fractional, unknown, accessor, proxy, and malformed inputs before reading", async () => {
    const readFile = vi.fn();
    const fixture = repository({ "AGENTS.md": "ok" });
    const cases: (readonly [unknown, string])[] = [
      [{ maxDepth: DEFAULT_IMPORT_GRAPH_LIMITS.maxDepth + 1 }, "maxDepth"],
      [{ maxFiles: 1.5 }, "maxFiles"],
      [{ maxDepth: -1 }, "maxDepth"],
    ];
    for (const [limits, name] of cases) {
      await expect(
        loadImportGraph({ repository: fixture, entryPath, syntax: "claude-code" }, limits as never),
      ).rejects.toMatchObject({
        code: "IMPORT_GRAPH_INVALID_LIMIT",
        limitName: name,
      });
    }
    await expect(
      loadImportGraph({ repository: fixture, entryPath, syntax: "claude-code" }, {
        maxDepth: 1,
        extra: 2,
      } as never),
    ).rejects.toBeInstanceOf(ImportGraphLoaderError);
    await expect(
      loadImportGraph(
        { repository: fixture, entryPath, syntax: "claude-code" },
        new Proxy({}, {}) as never,
      ),
    ).rejects.toBeInstanceOf(ImportGraphLoaderError);
    await expect(
      loadImportGraph({ repository: fixture, entryPath, syntax: "claude-code" }, null as never),
    ).rejects.toMatchObject({ code: "IMPORT_GRAPH_INVALID_LIMIT", limitName: null });

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "maxFiles", { get: readFile, enumerable: true });
    await expect(
      loadImportGraph({ repository: fixture, entryPath, syntax: "claude-code" }, accessor),
    ).rejects.toBeInstanceOf(ImportGraphLoaderError);
    expect(readFile).not.toHaveBeenCalled();

    const inputAccessor = { entryPath, syntax: "claude-code" } as Record<string, unknown>;
    Object.defineProperty(inputAccessor, "repository", { get: readFile, enumerable: true });
    await expect(loadImportGraph(inputAccessor as never)).rejects.toMatchObject({
      code: "IMPORT_GRAPH_INVALID_INPUT",
    });
    expect(readFile).not.toHaveBeenCalled();

    await expect(loadImportGraph(null as never)).rejects.toMatchObject({
      code: "IMPORT_GRAPH_INVALID_INPUT",
    });
    await expect(
      loadImportGraph({ repository: fixture, entryPath } as never),
    ).rejects.toMatchObject({
      code: "IMPORT_GRAPH_INVALID_INPUT",
    });
    await expect(
      loadImportGraph({
        repository: fixture,
        entryPath,
        syntax: "claude-code",
        extra: true,
      } as never),
    ).rejects.toMatchObject({ code: "IMPORT_GRAPH_INVALID_INPUT" });
    await expect(
      loadImportGraph({ repository: fixture, entryPath: 1 as never, syntax: "claude-code" }),
    ).rejects.toMatchObject({ code: "IMPORT_GRAPH_INVALID_INPUT" });
    await expect(
      loadImportGraph({
        repository: fixture,
        entryPath: "a/../b" as RepositoryRelativePath,
        syntax: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_GRAPH_INVALID_INPUT" });

    await expect(
      loadImportGraph({ repository: {} as ReadOnlyRepository, entryPath, syntax: "claude-code" }),
    ).rejects.toMatchObject({ code: "IMPORT_GRAPH_INVALID_INPUT" });
    const inertUsage = (): ReturnType<ReadOnlyRepository["usage"]> => ({
      elapsedMs: 0,
      entries: 0,
      metadataOperations: 0,
      totalBytes: 0,
    });
    const accessorRepository = { usage: inertUsage } as Record<string, unknown>;
    Object.defineProperty(accessorRepository, "readFile", { get: readFile });
    await expect(
      loadImportGraph({
        repository: accessorRepository as unknown as ReadOnlyRepository,
        entryPath,
        syntax: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_GRAPH_INVALID_INPUT" });
    expect(readFile).not.toHaveBeenCalled();

    const proxyPrototype = new Proxy({}, {});
    const proxyChainRepository = Object.assign(Object.create(proxyPrototype) as object, {
      usage: inertUsage,
    });
    await expect(
      loadImportGraph({
        repository: proxyChainRepository as ReadOnlyRepository,
        entryPath,
        syntax: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_GRAPH_INVALID_INPUT" });

    await expect(
      loadImportGraph({
        repository: fixture,
        entryPath: "." as RepositoryRelativePath,
        syntax: "claude-code",
      }),
    ).rejects.toMatchObject({
      code: "IMPORT_GRAPH_INVALID_INPUT",
    });
    await expect(
      loadImportGraph({ repository: new Proxy(fixture, {}), entryPath, syntax: "claude-code" }),
    ).rejects.toMatchObject({
      code: "IMPORT_GRAPH_INVALID_INPUT",
    });
    await expect(
      loadImportGraph({ repository: fixture, entryPath, syntax: `bad-${randomUUID()}` as never }),
    ).rejects.toMatchObject({
      code: "IMPORT_GRAPH_INVALID_INPUT",
    });
  });
});
