import { describe, expect, it } from "vitest";

import {
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  type ReadOnlyRepository,
} from "@agent-context/evidence";
import { GEMINI_CLI_PROFILE } from "@agent-context/profiles";
import type { GeminiSettingsLayerInput } from "@agent-context/syntax";

import {
  GEMINI_CLI_RESOLVER_LIMITS,
  GeminiCliProfileError,
  resolveGeminiCliContext,
  type GeminiCliCandidateSnapshot,
  type ResolveGeminiCliInput,
} from "../src/index.js";

const encoder = new TextEncoder();

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    inspect(): ReturnType<ReadOnlyRepository["inspect"]> {
      throw new Error("not used");
    },
    limits: {
      maximumDurationMs: 1_000,
      maximumEntries: 10_000,
      maximumFileBytes: 1_048_576,
      maximumMetadataOperations: 10_000,
      maximumSymlinkDepth: 8,
      maximumTotalBytes: 8_388_608,
      maximumTraversalDepth: 64,
    },
    readDirectory(): ReturnType<ReadOnlyRepository["readDirectory"]> {
      throw new Error("not used");
    },
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const path = value as string;
      const text = sources[path];
      if (text === undefined)
        return Promise.reject(
          new ReadOnlyRepositoryError(
            ReadOnlyRepositoryErrorCode.pathUnavailable,
            "missing",
            "readFile",
            path as never,
          ),
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          path as never,
          encoder.encode(text),
          { device: "1", inode: path },
          0,
        ),
      );
    },
    root: "/synthetic",
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
}

function file(
  path: string,
  options: Partial<Pick<GeminiCliCandidateSnapshot, "identity" | "ignoredBy" | "kind">> = {},
): GeminiCliCandidateSnapshot {
  return {
    identity: options.identity ?? path,
    ignoredBy: options.ignoredBy ?? [],
    kind: options.kind ?? "file",
    path: path as never,
  };
}

function directory(path: string): GeminiCliCandidateSnapshot {
  return file(path, { identity: `directory:${path}`, kind: "directory" });
}

function settings(
  context: Record<string, unknown> = {},
  kind: GeminiSettingsLayerInput["kind"] = "workspace",
  trustState: GeminiSettingsLayerInput["trustState"] = "trusted",
): GeminiSettingsLayerInput {
  return {
    bytes: encoder.encode(JSON.stringify({ context })),
    kind,
    path: ".gemini/settings.json" as never,
    trustState,
  };
}

function request(overrides: Partial<ResolveGeminiCliInput> = {}): ResolveGeminiCliInput {
  const sources = {
    "GEMINI.md": "ROOT\n@docs/root.md",
    "docs/root.md": "IMPORTED_ROOT",
    "packages/api/GEMINI.md": "API",
    "packages/api/main.ts": "export {};",
  };
  return {
    boundaryMarkerDirectories: ["." as never],
    candidates: [
      directory("."),
      directory("packages"),
      directory("packages/api"),
      file("GEMINI.md"),
      file("packages/api/GEMINI.md"),
      file("packages/api/main.ts"),
    ],
    events: [
      { id: "launch", kind: "launch", path: "." as never },
      { id: "read-api", kind: "read-path", path: "packages/api/main.ts" as never },
    ],
    externalContext: "unavailable",
    repository: repository(sources),
    settingsLayers: [settings()],
    trustState: "trusted",
    workspaceRoots: ["." as never],
    ...overrides,
  };
}

describe("Gemini CLI profile resolver", () => {
  it("pins an immutable stable/current profile descriptor", () => {
    expect(GEMINI_CLI_PROFILE).toMatchObject({
      clientVersion: "0.53.1",
      currentSourceSha: "f47d6c6f7a1308d81f9f57acf7d279f0928c5249",
      specSnapshotId: "gemini-cli/2026-08-02.0",
      stableSourceSha: "19a68016bdc9cd4177a155846dd51f282c3c1c59",
    });
    expect(Object.isFrozen(GEMINI_CLI_PROFILE)).toBe(true);
  });

  it("loads startup ancestors then injects descendant context on a read event", async () => {
    const result = await resolveGeminiCliContext(request());
    expect(result.events.map((event) => event.added)).toEqual([
      ["GEMINI.md"],
      ["packages/api/GEMINI.md"],
    ]);
    expect(result.documents.map((document) => [document.path, document.phase])).toEqual([
      ["GEMINI.md", "static"],
      ["packages/api/GEMINI.md", "jit"],
    ]);
    expect(result.documents[0]?.importGraph?.nodes.map((node) => node.path)).toEqual([
      "GEMINI.md",
      "docs/root.md",
    ]);
    expect(result.loadedPaths).toEqual(["GEMINI.md", "packages/api/GEMINI.md"]);
  });

  it("applies custom filenames and final lexicographic project ordering", async () => {
    const sources = { "GEMINI.md": "DEFAULT", "TEAM.md": "TEAM" };
    const result = await resolveGeminiCliContext(
      request({
        candidates: [directory("."), file("TEAM.md"), file("GEMINI.md")],
        events: [{ id: "launch", kind: "launch", path: "." as never }],
        repository: repository(sources),
        settingsLayers: [settings({ fileName: ["TEAM.md", "TEAM.md"] })],
      }),
    );
    expect(result.settings.values.fileNames).toEqual(["TEAM.md", "GEMINI.md"]);
    expect(result.events[0]?.added).toEqual(["GEMINI.md", "TEAM.md"]);
  });

  it("deduplicates file identities and does not let ignores deactivate memory", async () => {
    const result = await resolveGeminiCliContext(
      request({
        candidates: [
          directory("."),
          file("GEMINI.md", { identity: "same" }),
          file("TEAM.md", { identity: "same", ignoredBy: [".geminiignore"] }),
        ],
        events: [{ id: "launch", kind: "launch", path: "." as never }],
        repository: repository({ "GEMINI.md": "ROOT", "TEAM.md": "ALIAS" }),
        settingsLayers: [settings({ fileName: "TEAM.md" })],
      }),
    );
    expect(result.documents).toHaveLength(1);
    expect(result.issues.map((entry) => entry.code)).toContain("ignore-memory-contradiction");
  });

  it("suppresses all project and JIT context when trust is absent", async () => {
    const result = await resolveGeminiCliContext(request({ trustState: "untrusted" }));
    expect(result.loadedPaths).toEqual([]);
    expect(result.events.every((event) => event.state === "ignored-untrusted")).toBe(true);
    expect(result.issues.map((entry) => entry.code)).toContain("untrusted-workspace");
  });

  it("reports targets outside every trusted root", async () => {
    const result = await resolveGeminiCliContext(
      request({
        events: [
          { id: "launch", kind: "launch", path: "packages" as never },
          { id: "outside", kind: "read-path", path: "other/main.ts" as never },
        ],
        workspaceRoots: ["packages" as never],
      }),
    );
    expect(result.events[1]?.state).toBe("outside-roots");
    expect(result.issues.map((entry) => entry.code)).toContain("target-outside-roots");
  });

  it("clears loaded identities and rediscovers static context on memory reload", async () => {
    const result = await resolveGeminiCliContext(
      request({
        events: [
          { id: "launch", kind: "launch", path: "." as never },
          { id: "reload", kind: "memory-reload", path: null },
        ],
      }),
    );
    expect(result.events.map((event) => event.added)).toEqual([["GEMINI.md"], ["GEMINI.md"]]);
    expect(result.documents.filter((entry) => entry.path === "GEMINI.md")).toHaveLength(2);
  });

  it("adds a directory and refreshes it only when the pinned dynamic flag is true", async () => {
    const result = await resolveGeminiCliContext(
      request({
        candidates: [
          directory("."),
          directory("extra"),
          file("GEMINI.md"),
          file("extra/GEMINI.md"),
        ],
        events: [
          { id: "launch", kind: "launch", path: "." as never },
          { id: "add", kind: "directory-add", path: "extra" as never },
        ],
        repository: repository({ "GEMINI.md": "ROOT", "extra/GEMINI.md": "EXTRA" }),
        settingsLayers: [settings({ loadMemoryFromIncludeDirectories: true })],
      }),
    );
    expect(result.events[1]?.added).toEqual(["extra/GEMINI.md"]);
    expect(result.workspaceRoots).toEqual([".", "extra"]);
  });

  it("reports unavailable include roots and contradicted settings separately", async () => {
    const result = await resolveGeminiCliContext(
      request({
        settingsLayers: [settings({ discoveryMaxDirs: 1, includeDirectories: ["missing"] })],
      }),
    );
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["include-root-unavailable", "settings-contradiction"]),
    );
  });

  it("applies a finite safety cap to flat imports and reports partial import failures", async () => {
    const result = await resolveGeminiCliContext(
      request({
        candidates: [directory("."), file("GEMINI.md")],
        events: [{ id: "launch", kind: "launch", path: "." as never }],
        repository: repository({ "GEMINI.md": "@missing.md\n@/absolute.md" }),
        settingsLayers: [settings({ importFormat: "flat" })],
      }),
    );
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "absolute-import-unsupported",
        "flat-import-depth-safety-cap",
        "import-partial",
      ]),
    );
  });

  it("keeps unavailable selected candidates explicit", async () => {
    const result = await resolveGeminiCliContext(
      request({
        candidates: [directory("."), file("GEMINI.md", { identity: null, kind: "unavailable" })],
        events: [{ id: "launch", kind: "launch", path: "." as never }],
        repository: repository({}),
      }),
    );
    expect(result.documents[0]).toMatchObject({ state: "unavailable", syntax: null });
    expect(result.issues.map((entry) => entry.code)).toContain("candidate-unavailable");
  });

  it("is deterministic and freezes every returned collection", async () => {
    const input = request();
    const first = await resolveGeminiCliContext(input);
    expect(JSON.stringify(await resolveGeminiCliContext(input))).toBe(JSON.stringify(first));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.documents)).toBe(true);
    expect(Object.isFrozen(first.events[0]?.added)).toBe(true);
  });

  it("rejects proxies, accessors, unknown fields, duplicates, and malformed traces", async () => {
    await expect(resolveGeminiCliContext(new Proxy(request(), {}))).rejects.toBeInstanceOf(
      GeminiCliProfileError,
    );
    await expect(resolveGeminiCliContext({ ...request(), extra: true } as never)).rejects.toThrow();
    await expect(
      resolveGeminiCliContext({
        ...request(),
        candidates: [file("GEMINI.md"), file("GEMINI.md")],
      }),
    ).rejects.toThrow();
    await expect(resolveGeminiCliContext({ ...request(), events: [] })).rejects.toThrow();
    await expect(
      resolveGeminiCliContext({
        ...request(),
        events: [{ id: "reload", kind: "memory-reload", path: null }],
      }),
    ).rejects.toThrow();
  });

  it("enforces aggregate candidate and event limits before resolution", async () => {
    const candidates = Array.from(
      { length: GEMINI_CLI_RESOLVER_LIMITS.maximumCandidates + 1 },
      (_, index) => file(`f${String(index)}`),
    );
    await expect(resolveGeminiCliContext({ ...request(), candidates })).rejects.toMatchObject({
      code: "GEMINI_CLI_PROFILE_RESOURCE_LIMIT",
    });
  });

  it("caps issue accumulation for large authorized unavailable inventories", async () => {
    const names = Array.from({ length: 33 }, (_, index) => `TEAM${String(index)}.md`);
    const roots = Array.from({ length: 121 }, (_, index) => `root${String(index)}` as never);
    const candidates = roots.flatMap((root) =>
      [...names, "GEMINI.md"].map((name) =>
        file(`${String(root)}/${name}`, { kind: "unavailable" }),
      ),
    );
    const result = await resolveGeminiCliContext(
      request({
        candidates,
        events: [{ id: "launch", kind: "launch", path: "." as never }],
        repository: repository({}),
        settingsLayers: [settings({ fileName: names })],
        workspaceRoots: roots,
      }),
    );
    expect(result.issues).toHaveLength(GEMINI_CLI_RESOLVER_LIMITS.maximumIssues);
  });

  it("rejects malformed nested candidate, event, root, trust, and external snapshots", async () => {
    const base = request();
    const sparseEvents = [base.events[0]];
    sparseEvents.length = 2;
    const cases: unknown[] = [
      { ...base, repository: null },
      { ...base, repository: new Proxy(base.repository, {}) },
      { ...base, candidates: {} },
      { ...base, candidates: [{ ...file("GEMINI.md"), kind: "bad" }] },
      { ...base, candidates: [{ ...file("GEMINI.md"), identity: 7 }] },
      { ...base, candidates: [{ ...file("GEMINI.md"), identity: "" }] },
      { ...base, candidates: [{ ...file("GEMINI.md"), ignoredBy: {} }] },
      { ...base, candidates: [{ ...file("GEMINI.md"), ignoredBy: [7] }] },
      { ...base, events: sparseEvents },
      {
        ...base,
        events: [
          { id: "same", kind: "launch", path: "." },
          { id: "same", kind: "read-path", path: "x" },
        ],
      },
      { ...base, events: [{ id: "x", kind: "bad", path: "." }] },
      { ...base, events: [{ id: "x", kind: "launch", path: null }] },
      { ...base, events: [{ id: "x", kind: "launch", path: "../escape" }] },
      { ...base, workspaceRoots: [] },
      { ...base, workspaceRoots: ["../escape"] },
      { ...base, boundaryMarkerDirectories: ["../escape"] },
      { ...base, externalContext: "bad" },
      { ...base, trustState: "bad" },
      { ...base, settingsLayers: {} },
    ];
    for (const candidate of cases)
      await expect(resolveGeminiCliContext(candidate as never)).rejects.toBeInstanceOf(
        GeminiCliProfileError,
      );
  });

  it("rejects non-enumerable nested fields and overlong paths and identities", async () => {
    const hidden = file("GEMINI.md") as unknown as Record<string, unknown>;
    Object.defineProperty(hidden, "kind", { enumerable: false, value: "file" });
    await expect(
      resolveGeminiCliContext({ ...request(), candidates: [hidden as never] }),
    ).rejects.toThrow();
    await expect(
      resolveGeminiCliContext({
        ...request(),
        candidates: [file("x".repeat(GEMINI_CLI_RESOLVER_LIMITS.maximumPathBytes + 1))],
      }),
    ).rejects.toMatchObject({ code: "GEMINI_CLI_PROFILE_RESOURCE_LIMIT" });
    await expect(
      resolveGeminiCliContext({
        ...request(),
        candidates: [
          file("GEMINI.md", {
            identity: "x".repeat(GEMINI_CLI_RESOLVER_LIMITS.maximumIdentityBytes + 1),
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: "GEMINI_CLI_PROFILE_INVALID_INPUT" });
  });

  it("maps invalid settings layers to profile errors", async () => {
    await expect(
      resolveGeminiCliContext({
        ...request(),
        settingsLayers: [{ ...settings(), kind: "invalid" as never }],
      }),
    ).rejects.toBeInstanceOf(GeminiCliProfileError);
  });

  it("supports disabled boundaries, available include roots, and directory JIT events", async () => {
    const result = await resolveGeminiCliContext(
      request({
        boundaryMarkerDirectories: [],
        candidates: [
          directory("."),
          directory("include"),
          directory("include/deep"),
          file("GEMINI.md"),
          file("include/GEMINI.md"),
          file("include/deep/GEMINI.md"),
        ],
        events: [
          { id: "launch", kind: "launch", path: "." as never },
          { id: "list", kind: "list-directory", path: "include/deep" as never },
        ],
        repository: repository({
          "GEMINI.md": "ROOT",
          "include/GEMINI.md": "INCLUDE",
          "include/deep/GEMINI.md": "DEEP",
        }),
        settingsLayers: [settings({ includeDirectories: ["include"], memoryBoundaryMarkers: [] })],
      }),
    );
    expect(result.events[0]?.added).toEqual(["GEMINI.md", "include/GEMINI.md"]);
    expect(result.events[1]?.added).toEqual(["include/deep/GEMINI.md"]);
  });

  it("keeps directory additions inert when dynamic refresh is disabled", async () => {
    const result = await resolveGeminiCliContext(
      request({
        candidates: [
          directory("."),
          directory("extra"),
          file("GEMINI.md"),
          file("extra/GEMINI.md"),
        ],
        events: [
          { id: "launch", kind: "launch", path: "." as never },
          { id: "add", kind: "directory-add", path: "extra" as never },
        ],
        repository: repository({ "GEMINI.md": "ROOT", "extra/GEMINI.md": "EXTRA" }),
      }),
    );
    expect(result.events[1]?.added).toEqual([]);
    expect(result.workspaceRoots).toContain("extra");
  });

  it("contains nested imports at the nearest memory boundary and retains syntax failures", async () => {
    const oversized = "x".repeat(600_000);
    const result = await resolveGeminiCliContext(
      request({
        boundaryMarkerDirectories: ["packages/api" as never],
        candidates: [
          directory("packages"),
          directory("packages/api"),
          file("packages/api/GEMINI.md"),
        ],
        events: [{ id: "launch", kind: "launch", path: "packages/api" as never }],
        repository: repository({
          "outside.md": "OUTSIDE",
          "packages/api/GEMINI.md": oversized + "\n@../../outside.md",
        }),
        workspaceRoots: ["packages/api" as never],
      }),
    );
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["syntax-failed", "import-partial"]),
    );
  });
});
