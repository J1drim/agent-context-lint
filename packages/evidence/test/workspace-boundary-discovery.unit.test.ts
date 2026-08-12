import { readFileSync } from "node:fs";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test, vi } from "vitest";

import {
  buildTargetedDiscoveryIndex,
  createReadOnlyRepository,
  discoverWorkspaceBoundaries,
  discoverWorkspaceBoundariesWithClock,
  IGNORE_ENGINE_DEFAULT_LIMITS,
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  selectRepositoryRoot,
  TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
  WORKSPACE_BOUNDARY_DEFAULT_LIMITS,
  WORKSPACE_BOUNDARY_HARD_LIMITS,
  WorkspaceBoundaryError,
  WorkspaceBoundaryErrorCode,
} from "../src/index.js";
import type {
  DiscoveryCandidate,
  IgnoreEngineResult,
  ReadOnlyRepository,
  TargetedDiscoveryIndex,
  TrackedFileEnumerationResult,
  WorkspaceBoundaryClock,
  WorkspaceBoundaryOptions,
} from "../src/index.js";

interface Fixture {
  readonly files: readonly { readonly content: string; readonly path: string }[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/v0/workspace-boundaries.fixture.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function paths(values: readonly string[]): ReturnType<typeof canonicalizeRepositoryRelativePath>[] {
  return values.map((value) => canonicalizeRepositoryRelativePath(value)).sort();
}

function indexFor(values: readonly string[], uncertain = false): TargetedDiscoveryIndex {
  const enumeration: TrackedFileEnumerationResult = Object.freeze({
    certainty: "tracked",
    indexObjectFormat: "sha1",
    indexVersion: 2,
    limits: TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
    omittedProblems: 0,
    paths: Object.freeze(paths(values)),
    problems: Object.freeze([]),
    reason: "verified-git-index",
    source: "git-index",
  });
  const deferred = uncertain
    ? Object.freeze([
        Object.freeze({
          applicability: "unknown" as const,
          clientVersion: null,
          evidence: "documented" as const,
          factId: "unknown-ignore",
          pattern: "maybe/",
          profileId: "test",
          reason: "unknown",
          retrievedAt: "2026-08-02",
          sourceUrl: "https://example.test",
        }),
      ])
    : Object.freeze([]);
  const ignore: IgnoreEngineResult = Object.freeze({
    appliedProfileFactIds: Object.freeze([]),
    certainty: "exact-tracked-input",
    deferredProfileFacts: deferred,
    ignored: Object.freeze([]),
    limits: IGNORE_ENGINE_DEFAULT_LIMITS,
    omittedProblems: 0,
    paths: enumeration.paths,
    problems: Object.freeze([]),
    profileCertainty: uncertain ? "uncertain-facts-deferred" : "known",
    profileFacts: deferred,
    rules: Object.freeze([]),
    trackingCertainty: "tracked",
  });
  return buildTargetedDiscoveryIndex(enumeration, ignore);
}

async function repositoryAt(root: string): Promise<ReadOnlyRepository> {
  return createReadOnlyRepository(await selectRepositoryRoot(root, { mode: "explicit" }));
}

function fixtureFiles(): Record<string, string> {
  return Object.fromEntries(fixture.files.map((file) => ["repo/" + file.path, file.content]));
}

function memoryRepository(
  files: Readonly<Record<string, Uint8Array | string>>,
): ReadOnlyRepository {
  const content = new Map(
    Object.entries(files).map(([pathValue, value]) => [
      canonicalizeRepositoryRelativePath(pathValue),
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    ]),
  );
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/synthetic",
    inspect: vi.fn(),
    readDirectory: vi.fn(),
    readFile: (input: unknown): Promise<ReadOnlyRepositoryFile> => {
      const pathValue = canonicalizeRepositoryRelativePath(String(input));
      const bytes = content.get(pathValue);
      if (bytes === undefined) {
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "missing",
          "read-file",
          pathValue,
        );
      }
      return Promise.resolve(
        new ReadOnlyRepositoryFile(pathValue, bytes, { device: "1", inode: "1" }, 0),
      );
    },
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
}

describe("C11 workspace and source-boundary discovery", () => {
  test("parses every representative family without executing repository fields", async () => {
    await withTempWorkspace(fixtureFiles(), async (workspace) => {
      const result = await discoverWorkspaceBoundaries(
        await repositoryAt(workspace.resolvePath("repo")),
        indexFor(fixture.files.map((file) => file.path)),
      );
      expect(result.contractVersion).toBe("0.1.0");
      expect(result.evidence).toHaveLength(15);
      expect(result.metrics).toMatchObject({
        boundaryCount: 15,
        contentReads: 11,
        issueCount: 1,
        manifestCount: 15,
        patternCount: 11,
      });
      expect(result.evidence.map((record) => record.family)).toEqual([
        "cargo",
        "bazel-module",
        "bazel-workspace",
        "go-workspace",
        "python-setup-cfg",
        "python-setup-py",
        "lerna",
        "nx",
        "javascript-package",
        "pnpm",
        "python-project",
        "rush",
        "bazel-build",
        "go-module",
        "turbo",
      ]);
      expect(result.evidence.find((record) => record.path === "package.json")).toMatchObject({
        ignoredExecutableFields: ["scripts"],
        packageManager: "pnpm@11.18.0",
        patterns: [{ kind: "include", value: "packages/*" }],
        projectName: "root-🧭",
      });
      expect(result.evidence.find((record) => record.path === "Cargo.toml")).toMatchObject({
        patterns: [
          { kind: "include", value: "crates/*" },
          { kind: "exclude", value: "crates/old" },
        ],
        projectName: "rust-root",
      });
      expect(result.evidence.find((record) => record.path === "pyproject.toml")).toMatchObject({
        patterns: [
          { value: "python-packages/*" },
          { kind: "exclude", value: "python-packages/old" },
        ],
        projectName: "python-root",
      });
      expect(result.evidence.find((record) => record.path === "go.work")?.patterns).toMatchObject([
        { value: "./services/api" },
        { value: "./services/worker" },
      ]);
      expect(result.evidence.find((record) => record.path === "rush.json")).toMatchObject({
        ignoredExecutableFields: ["eventHooks"],
        patterns: [{ value: "libraries/a" }],
      });
      expect(result.evidence.find((record) => record.path === "nx.json")).toMatchObject({
        ignoredExecutableFields: ["plugins", "targetDefaults"],
      });
      expect(result.evidence.find((record) => record.path === "turbo.json")).toMatchObject({
        ignoredExecutableFields: ["tasks"],
      });
      expect(result.evidence.find((record) => record.path === "legacy/setup.py")).toMatchObject({
        parser: "path-marker",
        state: "unsupported",
      });
      expect(
        result.boundaries.find((boundary) => boundary.evidencePath === "services/api/BUILD.bazel"),
      ).toMatchObject({ kind: "source", root: "services/api" });
      expect(
        result.boundaries.find((boundary) => boundary.evidencePath === "services/api/go.mod"),
      ).toMatchObject({ kind: "project", languages: ["go"], root: "services/api" });
      expect(result.uncertaintyReasons).toEqual(["legacy/setup.py:unsupported"]);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.evidence[0]?.patterns)).toBe(true);
      expect(
        result.evidence.find((record) => record.path === "package.json")?.location.range.end,
      ).toMatchObject({ line: 6, utf16Column: 0 });
      expect(
        typeof result.evidence.find((record) => record.path === "package.json")?.location.range.end
          .byteOffset,
      ).toBe("number");
    });
  });

  test("rejects ambiguous JSON and reports invalid closed-field types", async () => {
    const files = {
      "bad/package.json": '{"name":"first","name":"second","workspaces":"bad"}',
      "comments/lerna.json": '{// jsonc\\n"packages": ["a"],}',
      "shape/rush.json": '{"projects":[null,{"projectFolder":3}]}',
      "types/package.json": '{"name":4,"packageManager":false,"workspaces":{"packages":[1]}}',
    };
    const result = await discoverWorkspaceBoundaries(
      memoryRepository(files),
      indexFor(Object.keys(files)),
    );
    expect(result.evidence.map((record) => record.state)).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "malformed",
    ]);
    expect(result.evidence[0]?.issues[0]).toMatchObject({ code: "duplicate-key" });
    expect(result.evidence[1]?.issues[0]).toMatchObject({ code: "invalid-syntax" });
    expect(
      result.evidence
        .flatMap((record) => record.issues)
        .some((issue) => issue.code === "invalid-type"),
    ).toBe(true);
  });

  test("does not expand unsupported or unsafe TOML, YAML, and Go constructs", async () => {
    const files = {
      "Cargo.toml": "[workspace]\nmembers = workspace_members()\n",
      "go.work": "go 1.25\nuse /outside/repository\n",
      "pnpm-workspace.yaml": "packages:\n  - &all packages/*\n  - ../outside\n",
      "pyproject.toml": '[project]\nname = 42\n[tool.uv.workspace]\nmembers = ["ok", 7]\n',
    };
    const result = await discoverWorkspaceBoundaries(
      memoryRepository(files),
      indexFor(Object.keys(files)),
    );
    expect(result.evidence.every((record) => record.state === "unsupported")).toBe(true);
    expect(result.evidence.flatMap((record) => record.patterns)).toEqual([]);
    expect(result.evidence.flatMap((record) => record.issues).map((issue) => issue.code)).toContain(
      "invalid-member",
    );
  });

  test("never reads path markers or a forged built-in recognition with the wrong basename", async () => {
    const emptyRepository = memoryRepository({});
    const readFile = vi.fn((input: unknown) => emptyRepository.readFile(input));
    const repository = { ...memoryRepository({}), readFile };
    const valid = indexFor(["BUILD", "MODULE.bazel", "WORKSPACE", "setup.py"]);
    const forged = structuredClone(valid);
    (forged.candidates as unknown as Record<string, unknown>[]).push({
      kinds: ["evidence"],
      path: "secrets.txt",
      recognitions: [
        {
          kind: "evidence",
          origin: "built-in-catalog",
          recognizerId: "evidence.javascript-package",
        },
      ],
      uncertainty: [],
    });
    const result = await discoverWorkspaceBoundaries(repository, forged);
    expect(readFile).not.toHaveBeenCalled();
    expect(result.evidence.map((record) => record.path)).toEqual([
      "BUILD",
      "MODULE.bazel",
      "WORKSPACE",
      "setup.py",
    ]);
  });

  test("makes missing, malformed UTF-8, and upstream uncertainty explicit", async () => {
    const result = await discoverWorkspaceBoundaries(
      memoryRepository({ "invalid/package.json": Uint8Array.from([0x7b, 0xff, 0x7d]) }),
      indexFor(["gone/package.json", "invalid/package.json"], true),
    );
    expect(result.evidence).toMatchObject([
      { issues: [{ code: "unavailable" }], state: "unavailable" },
      { issues: [{ code: "invalid-syntax" }], state: "malformed" },
    ]);
    expect(result.uncertaintyReasons).toContain("upstream-discovery-index:uncertain");
  });

  test.each([
    ["maximumManifests", { "a/package.json": "{}", "b/package.json": "{}" }, 1],
    ["maximumFileBytes", { "package.json": "{}" }, 1],
    ["maximumTotalBytes", { "a/package.json": "{}", "b/package.json": "{}" }, 3],
    ["maximumLineLength", { "package.json": '{"name":"long"}' }, 4],
    ["maximumLines", { "package.json": "{\n\n}" }, 2],
    ["maximumDepth", { "package.json": '{"a":{"b":{"c":1}}}' }, 2],
    ["maximumNodes", { "package.json": '{"a":1,"b":2}' }, 2],
    ["maximumPatterns", { "package.json": '{"workspaces":["a","b"]}' }, 1],
    ["maximumIssues", { "package.json": '{"name":1,"packageManager":2,"workspaces":3}' }, 1],
  ] as const)("enforces the %s resource boundary", async (key, files, limit) => {
    await expect(
      discoverWorkspaceBoundaries(memoryRepository(files), indexFor(Object.keys(files)), {
        [key]: limit,
      }),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.limitExceeded });
  });

  test("validates options, cancellation, deadlines, and capability inputs", async () => {
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({}), indexFor([]), {
        maximumDepth: WORKSPACE_BOUNDARY_HARD_LIMITS.maximumDepth + 1,
      }),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidOptions });
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({}), indexFor([]), {
        unknown: 1,
      } as WorkspaceBoundaryOptions),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidOptions });
    await expect(
      discoverWorkspaceBoundaries(
        memoryRepository({}),
        indexFor([]),
        null as unknown as WorkspaceBoundaryOptions,
      ),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidOptions });
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({}), indexFor([]), {
        signal: {} as AbortSignal,
      }),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidOptions });
    const accessor = {};
    Object.defineProperty(accessor, "maximumDepth", { get: () => 1 });
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({}), indexFor([]), accessor),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidOptions });

    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({}), indexFor([]), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.aborted });

    const moments = [0, 0, 2];
    const clock: WorkspaceBoundaryClock = { now: () => moments.shift() ?? 2 };
    await expect(
      discoverWorkspaceBoundariesWithClock(
        memoryRepository({}),
        indexFor([]),
        { maximumDurationMs: 1 },
        clock,
      ),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.deadlineExceeded });

    await expect(
      discoverWorkspaceBoundaries(new Proxy(memoryRepository({}), {}), indexFor([])),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidInput });
    await expect(
      discoverWorkspaceBoundariesWithClock(memoryRepository({}), indexFor([]), undefined, {
        now: () => Number.NaN,
      }),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidInput });
    const nonFiniteCheckpoint = [0, Number.NaN];
    await expect(
      discoverWorkspaceBoundariesWithClock(memoryRepository({}), indexFor([]), undefined, {
        now: () => nonFiniteCheckpoint.shift() ?? 0,
      }),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidInput });
  });

  test("classifies malformed roots and unterminated subset structures", async () => {
    const files = {
      "array/package.json": "[]",
      "cargo/Cargo.toml": '[workspace\nmembers ["a"]',
      "go.work": "go 1.25\nuse (\n./a\n",
      "pnpm-workspace.yaml": "packages: [a]\n",
    };
    const result = await discoverWorkspaceBoundaries(
      memoryRepository(files),
      indexFor(Object.keys(files)),
    );
    expect(result.evidence.map((record) => record.state)).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "unsupported",
    ]);
  });

  test("rejects malformed discovery-index structures before reads", async () => {
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({}), {} as TargetedDiscoveryIndex),
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({}), {
        contractVersion: "0.1.0",
        candidates: [{ path: "../escape", recognitions: [] }],
        uncertainty: "known",
      } as unknown as TargetedDiscoveryIndex),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidInput });

    const bounded = structuredClone(indexFor(["package.json"]));
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({ "package.json": "{}" }), bounded, {
        maximumCandidates: 1,
        maximumRecognitionsPerCandidate: 1,
      }),
    ).resolves.toMatchObject({ metrics: { manifestCount: 1 } });
    const sparse = structuredClone(bounded);
    (sparse.candidates as DiscoveryCandidate[]).length = 2;
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({}), sparse, { maximumCandidates: 2 }),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.invalidInput });
    const proxied = structuredClone(bounded);
    Object.defineProperty(proxied, "candidates", {
      value: new Proxy(proxied.candidates, {}),
    });
    await expect(discoverWorkspaceBoundaries(memoryRepository({}), proxied)).rejects.toMatchObject({
      code: WorkspaceBoundaryErrorCode.invalidInput,
    });
    const excessive = structuredClone(bounded);
    const firstCandidate = excessive.candidates[0];
    if (firstCandidate === undefined) throw new Error("expected a synthetic candidate");
    (excessive.candidates as DiscoveryCandidate[])[1] = structuredClone(firstCandidate);
    await expect(
      discoverWorkspaceBoundaries(memoryRepository({}), excessive, { maximumCandidates: 1 }),
    ).rejects.toMatchObject({ code: WorkspaceBoundaryErrorCode.limitExceeded });
  });

  test("publishes immutable defaults and stable frozen typed errors", () => {
    expect(WORKSPACE_BOUNDARY_DEFAULT_LIMITS.maximumManifests).toBe(10_000);
    expect(Object.isFrozen(WORKSPACE_BOUNDARY_DEFAULT_LIMITS)).toBe(true);
    const error = new WorkspaceBoundaryError(
      WorkspaceBoundaryErrorCode.invalidInput,
      "bad",
      "test",
      canonicalizeRepositoryRelativePath("package.json"),
    );
    expect(error).toMatchObject({
      code: "WORKSPACE_BOUNDARY_INVALID_INPUT",
      name: "WorkspaceBoundaryError",
      operation: "test",
      path: "package.json",
    });
    expect(Object.isFrozen(error)).toBe(true);
  });
});
