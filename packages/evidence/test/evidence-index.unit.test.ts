import { readFileSync } from "node:fs";
import { symlink } from "node:fs/promises";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test, vi } from "vitest";

import {
  buildTargetedDiscoveryIndex,
  collectRepositoryEvidence,
  collectRepositoryEvidenceWithClock,
  createReadOnlyRepository,
  discoverWorkspaceBoundaries,
  EVIDENCE_INDEX_HARD_LIMITS,
  EvidenceIndexErrorCode,
  IGNORE_ENGINE_DEFAULT_LIMITS,
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  selectRepositoryRoot,
  TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
} from "../src/index.js";
import type {
  EvidenceIndexClock,
  IgnoreEngineResult,
  ReadOnlyRepository,
  TargetedDiscoveryIndex,
  TrackedFileEnumerationResult,
  WorkspaceBoundaryDiscoveryResult,
} from "../src/index.js";

interface Fixture {
  readonly files: readonly { readonly content: string; readonly path: string }[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/v0/repository-evidence.fixture.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

function paths(values: readonly string[]): ReturnType<typeof canonicalizeRepositoryRelativePath>[] {
  return values.map((value) => canonicalizeRepositoryRelativePath(value)).sort();
}

function indexFor(values: readonly string[]): TargetedDiscoveryIndex {
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
  const ignore: IgnoreEngineResult = Object.freeze({
    appliedProfileFactIds: Object.freeze([]),
    certainty: "exact-tracked-input",
    deferredProfileFacts: Object.freeze([]),
    ignored: Object.freeze([]),
    limits: IGNORE_ENGINE_DEFAULT_LIMITS,
    omittedProblems: 0,
    paths: enumeration.paths,
    problems: Object.freeze([]),
    profileCertainty: "known",
    profileFacts: Object.freeze([]),
    rules: Object.freeze([]),
    trackingCertainty: "tracked",
  });
  return buildTargetedDiscoveryIndex(enumeration, ignore);
}

async function repositoryAt(root: string): Promise<ReadOnlyRepository> {
  return createReadOnlyRepository(await selectRepositoryRoot(root, { mode: "explicit" }));
}

function fixtureFiles(): Record<string, string> {
  return Object.fromEntries(fixture.files.map((file) => [`repo/${file.path}`, file.content]));
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
    readFile: vi.fn((input: unknown): Promise<ReadOnlyRepositoryFile> => {
      const pathValue = canonicalizeRepositoryRelativePath(String(input));
      const bytes = content.get(pathValue);
      if (bytes === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "missing",
          "read-file",
          pathValue,
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(pathValue, bytes, { device: "1", inode: pathValue }, 0),
      );
    }),
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
}

async function workspaceFor(
  repository: ReadOnlyRepository,
  values: readonly string[],
): Promise<WorkspaceBoundaryDiscoveryResult> {
  return discoverWorkspaceBoundaries(repository, indexFor(values));
}

describe("F01 inert repository evidence index", () => {
  test("indexes every evidence family, retains conflicts, and never executes command-shaped text", async () => {
    await withTempWorkspace(fixtureFiles(), async (workspace) => {
      const repository = await repositoryAt(workspace.resolvePath("repo"));
      const inventory = paths(fixture.files.map((file) => file.path));
      const boundaries = await workspaceFor(repository, inventory);
      const result = await collectRepositoryEvidence(repository, boundaries, inventory);

      expect(result.contractVersion).toBe("0.1.0");
      expect(new Set(result.facts.map((fact) => fact.category))).toEqual(
        new Set([
          "ci",
          "lockfile",
          "manifest",
          "package-manager",
          "path",
          "runtime",
          "script",
          "task",
          "tool",
        ]),
      );
      expect(
        result.facts.find((fact) => fact.category === "script" && fact.name === "substitute"),
      ).toMatchObject({
        certainty: "declared",
        rawValue: "echo $(touch SHOULD_NOT_EXIST) `touch SHOULD_NOT_EXIST`",
        value: "echo $(touch SHOULD_NOT_EXIST) `touch SHOULD_NOT_EXIST`",
      });
      expect(
        result.facts
          .filter((fact) => fact.category === "task")
          .map((fact) => `${fact.value}:${fact.name}`),
      ).toEqual(
        expect.arrayContaining([
          "just:check",
          "make:build",
          "make:danger",
          "make:test",
          "pyproject:tool.poe.tasks:test",
          "turbo:build",
          "turbo:test",
        ]),
      );
      expect(result.facts.filter((fact) => fact.category === "ci")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "verify", value: "job" }),
          expect.objectContaining({ name: "uses", value: "actions/checkout@v4" }),
          expect.objectContaining({ name: "run", value: "pnpm test" }),
        ]),
      );
      expect(
        result.facts.filter((fact) => fact.category === "tool").map((fact) => fact.name),
      ).toEqual(expect.arrayContaining(["eslint", "prettier"]));
      expect(
        result.conflicts.find((conflict) => conflict.category === "package-manager"),
      ).toMatchObject({ name: "selected", values: ["npm", "pnpm"] });
      expect(result.conflicts.find((conflict) => conflict.category === "runtime")).toMatchObject({
        name: "node",
        values: ["20.18.0", "^24.11.0"],
      });
      expect(result.issues.map((issue) => issue.code)).toContain("unsupported-syntax");
      expect(
        result.facts.find((fact) => fact.name === "substitute")?.location.range.start.line,
      ).toBe(6);
      await expect(workspace.exists("repo/SHOULD_NOT_EXIST")).resolves.toBe(false);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.facts)).toBe(true);
      expect(Object.isFrozen(result.facts[0]?.provenance)).toBe(true);

      const repeated = await collectRepositoryEvidence(repository, boundaries, inventory);
      expect(JSON.stringify(repeated)).toBe(JSON.stringify(result));
    });
  });

  test("keeps malformed, unavailable, dynamic, and multiline evidence explicitly uncertain", async () => {
    const files = {
      ".github/workflows/ci.yml":
        "jobs:\n  test:\n    steps:\n      - run: |\n          touch never\n",
      ".nvmrc": Uint8Array.from([0xff]),
      Makefile: "$(eval $(shell touch never))\n",
      "bad/package.json": "{bad",
      "package.json": '{"scripts":{"good":"echo ok","bad":7},"engines":7}',
    };
    const repository = memoryRepository(files);
    const inventory = paths(Object.keys(files));
    const boundaries = await workspaceFor(repository, inventory);
    const result = await collectRepositoryEvidence(repository, boundaries, inventory);

    expect(result.uncertainty).toBe("uncertain");
    expect(result.facts.find((fact) => fact.location.path === "bad/package.json")).toMatchObject({
      category: "manifest",
      certainty: "uncertain",
      value: "malformed",
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["invalid-syntax", "invalid-type", "unsupported-syntax"]),
    );
    expect(
      result.facts.find((fact) => fact.category === "script" && fact.name === "good"),
    ).toBeDefined();
    expect(
      result.facts.find((fact) => fact.category === "script" && fact.name === "bad"),
    ).toBeUndefined();
  });

  test("covers the closed lockfile, CI, tool-config, and C11 package-manager catalogs", async () => {
    const files = {
      ".buildkite/pipeline.yml": "steps: []",
      ".circleci/config.yml": "version: 2.1",
      ".eslintrc.json": "{}",
      ".gitlab-ci.yml": "test: {}",
      ".prettierrc.json": "{}",
      ".ruff.toml": "",
      "Cargo.lock": "",
      "Gemfile.lock": "",
      Jenkinsfile: "pipeline {}",
      "Pipfile.lock": "{}",
      "azure-pipelines.yml": "steps: []",
      "bitbucket-pipelines.yml": "pipelines: {}",
      "bun.lock": "",
      "composer.lock": "{}",
      "go.sum": "",
      "lerna.json": '{"packages":[],"npmClient":"yarn"}',
      "npm-shrinkwrap.json": "{}",
      "package-lock.json": "{}",
      "pnpm-lock.yaml": "",
      "poetry.lock": "",
      "rustfmt.toml": "",
      "uv.lock": "",
      "yarn.lock": "",
    };
    const repository = memoryRepository(files);
    const inventory = paths(Object.keys(files));
    const boundaries = await workspaceFor(repository, inventory);
    const result = await collectRepositoryEvidence(repository, boundaries, inventory);

    expect([
      ...new Set(
        result.facts.filter((fact) => fact.category === "lockfile").map((fact) => fact.name),
      ),
    ]).toEqual([
      "bun",
      "bundler",
      "cargo",
      "composer",
      "go",
      "npm",
      "pipenv",
      "pnpm",
      "poetry",
      "uv",
      "yarn",
    ]);
    expect(result.facts.filter((fact) => fact.category === "ci").map((fact) => fact.name)).toEqual([
      "azure-pipelines",
      "bitbucket-pipelines",
      "buildkite",
      "circleci",
      "gitlab-ci",
      "jenkins",
    ]);
    expect(
      result.facts.filter((fact) => fact.category === "tool").map((fact) => fact.name),
    ).toEqual(["eslint", "prettier", "ruff", "rustfmt"]);
    expect(
      result.facts.find(
        (fact) =>
          fact.category === "package-manager" && fact.provenance.collectorId === "evidence.lerna",
      ),
    ).toMatchObject({ rawValue: "yarn", value: "yarn" });
  });

  test("extracts bounded Cargo, Go, pyproject, runtime-file, Nx, and legacy Turbo facts", async () => {
    const files = {
      ".cargo/config.toml": '[alias]\nverify = "test --all"\n',
      ".go-version": "1.25.0\n",
      ".java-version": "21\n",
      ".ruby-version": "3.4.1\rignored\r",
      ".tool-versions": "nodejs 24.18.1\npython 3.13.2\ngolang 1.25.0\nrust 1.88.0\nunknown 1\n",
      "Cargo.toml": '[package]\nname = "crate"\nrust-version = "1.88"\n',
      "go.mod": "module example.test/project\ngo 1.25\ntoolchain go1.25.1\n",
      "nx.json": '{"targetDefaults":{"lint":{}}}',
      "package.json":
        '{"scripts":4,"engines":{"node":7},"devEngines":{"runtime":{"name":"node","version":"24.18.1"}},"volta":{"node":"22.14.0"},"eslintConfig":{},"prettier":{},"stylelint":{},"dependencies":4,"devDependencies":{"eslint":7}}',
      "pyproject.toml":
        '[project]\nname = "python-project"\nrequires-python = ">=3.13"\n[tool.ruff]\nline-length = "100"\n[tool.ruff.lint]\nselect = "E"\n',
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.88.0"\n',
      "turbo.json": '{"pipeline":{"legacy-build":{}}}',
    };
    const repository = memoryRepository(files);
    const inventory = paths(Object.keys(files));
    const boundaries = await workspaceFor(repository, inventory);
    const result = await collectRepositoryEvidence(repository, boundaries, inventory);

    expect(
      result.facts
        .filter((fact) => fact.category === "runtime")
        .map((fact) => `${fact.name}:${fact.value}`),
    ).toEqual(
      expect.arrayContaining([
        "go:1.25.0",
        "go:1.25",
        "go-toolchain:go1.25.1",
        "java:21",
        "node:22.14.0",
        "node:24.18.1",
        "python:3.13.2",
        "python:>=3.13",
        "ruby:3.4.1",
        "rust:1.88",
        "rust:1.88.0",
      ]),
    );
    expect(result.facts.filter((fact) => fact.category === "task")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "verify", value: "cargo-alias" }),
        expect.objectContaining({ name: "lint", value: "nx" }),
        expect.objectContaining({ name: "legacy-build", value: "turbo" }),
      ]),
    );
    expect(
      result.facts.filter((fact) => fact.category === "tool").map((fact) => fact.name),
    ).toEqual(expect.arrayContaining(["eslint", "prettier", "ruff", "stylelint"]));
    expect(result.issues.filter((issue) => issue.code === "invalid-type")).toHaveLength(4);
  });

  test("reads only the closed allowlist and keeps an external symlink unavailable", async () => {
    await withTempWorkspace(
      {
        outside: "secret-outside",
        "repo/ordinary.txt": "must-not-read",
        "repo/package.json": "{}",
      },
      async (workspace) => {
        await symlink(workspace.resolvePath("outside"), workspace.resolvePath("repo/.nvmrc"));
        const repository = await repositoryAt(workspace.resolvePath("repo"));
        const inventory = paths([".nvmrc", "ordinary.txt", "package.json"]);
        const boundaries = await workspaceFor(repository, inventory);
        const result = await collectRepositoryEvidence(repository, boundaries, inventory);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]?.code).toBe("unavailable");
        expect(result.issues[0]?.location.path).toBe(".nvmrc");
        expect(result.metrics.contentReads).toBe(1);
        expect(result.facts.find((fact) => fact.name === "ordinary.txt")).toMatchObject({
          category: "path",
          provenance: { interpretation: "path-only" },
        });
      },
    );
  });

  test.each([
    ["maximumPaths", { a: "", b: "" }, 1],
    ["maximumFacts", { "package-lock.json": "" }, 2],
    ["maximumFileBytes", { ".nvmrc": "12" }, 1],
    ["maximumTotalBytes", { ".nvmrc": "12" }, 1],
    ["maximumLineLength", { ".nvmrc": "123" }, 2],
    ["maximumLines", { ".nvmrc": "1\n2" }, 1],
    ["maximumStringLength", { ".nvmrc": "1234567" }, 6],
  ] as const)("enforces the %s limit", async (key, files, limit) => {
    const repository = memoryRepository(files);
    const inventory = paths(Object.keys(files));
    const boundaries = await workspaceFor(repository, inventory);
    await expect(
      collectRepositoryEvidence(repository, boundaries, inventory, { [key]: limit }),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.limitExceeded });
  });

  test("bounds JSON depth/nodes, issue retention, file count, and hard option ceilings", async () => {
    const repository = memoryRepository({
      ".nvmrc": Uint8Array.from([0xff]),
      ".python-version": Uint8Array.from([0xff]),
      "package.json": '{"nested":{"a":{"b":1}}}',
    });
    const inventory = paths([".nvmrc", ".python-version", "package.json"]);
    const boundaries = await workspaceFor(repository, inventory);
    await expect(
      collectRepositoryEvidence(repository, boundaries, inventory, { maximumDepth: 2 }),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.limitExceeded });
    await expect(
      collectRepositoryEvidence(repository, boundaries, inventory, { maximumNodes: 2 }),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.limitExceeded });
    await expect(
      collectRepositoryEvidence(repository, boundaries, inventory, { maximumIssues: 1 }),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.limitExceeded });
    await expect(
      collectRepositoryEvidence(repository, boundaries, inventory, { maximumFiles: 1 }),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.limitExceeded });
    await expect(
      collectRepositoryEvidence(repository, boundaries, inventory, {
        maximumFacts: EVIDENCE_INDEX_HARD_LIMITS.maximumFacts + 1,
      }),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidOptions });
  });

  test("rejects hostile API data, cancellation, and deadline exhaustion", async () => {
    const repository = memoryRepository({ "package.json": "{}" });
    const inventory = paths(["package.json"]);
    const boundaries = await workspaceFor(repository, inventory);
    await expect(
      collectRepositoryEvidence(repository, boundaries, ["b", "a"] as never),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });
    const sparse = new Array<string>(2);
    sparse[1] = "package.json";
    await expect(
      collectRepositoryEvidence(repository, boundaries, sparse as never),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });
    await expect(
      collectRepositoryEvidence(repository, boundaries, new Proxy([], {}) as never),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });
    const accessorOptions = Object.defineProperty({}, "maximumFacts", { get: () => 10 });
    await expect(
      collectRepositoryEvidence(repository, boundaries, inventory, accessorOptions),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidOptions });
    await expect(
      collectRepositoryEvidence(new Proxy(repository, {}) as never, boundaries, inventory),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });
    const accessorRepository = Object.defineProperty({ ...repository }, "readFile", {
      get:
        () =>
        (pathValue: unknown): Promise<ReadOnlyRepositoryFile> =>
          repository.readFile(pathValue),
    });
    await expect(
      collectRepositoryEvidence(accessorRepository as never, boundaries, inventory),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });
    await expect(
      collectRepositoryEvidence(repository, new Proxy(boundaries, {}) as never, inventory),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });
    const forgedBoundaries = structuredClone(boundaries);
    Object.defineProperty(forgedBoundaries.evidence[0] as object, "projectName", {
      get: () => "side-effect",
    });
    await expect(
      collectRepositoryEvidence(repository, forgedBoundaries, inventory),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });

    const controller = new AbortController();
    controller.abort();
    await expect(
      collectRepositoryEvidence(repository, boundaries, inventory, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.aborted });

    const times = [0, 2];
    const clock: EvidenceIndexClock = { now: () => times.shift() ?? 2 };
    await expect(
      collectRepositoryEvidenceWithClock(
        repository,
        boundaries,
        inventory,
        { maximumDurationMs: 1 },
        clock,
      ),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.deadlineExceeded });
    await expect(
      collectRepositoryEvidenceWithClock(repository, boundaries, inventory, undefined, {
        now: () => {
          throw new Error("clock failure");
        },
      }),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });
    await expect(
      collectRepositoryEvidenceWithClock(repository, boundaries, inventory, undefined, {
        now: () => Number.NaN,
      }),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });
  });

  test("rejects forged file capabilities before reading metadata or bytes", async () => {
    const repository = memoryRepository({ ".nvmrc": "20" });
    const inventory = paths([".nvmrc"]);
    const boundaries = await workspaceFor(repository, inventory);
    const forged = {
      ...repository,
      readFile: vi.fn(() =>
        Promise.resolve(
          Object.defineProperty(
            {
              bytes: (): Uint8Array => new Uint8Array(),
            },
            "size",
            { get: () => 0 },
          ),
        ),
      ),
    };
    await expect(
      collectRepositoryEvidence(forged as never, boundaries, inventory),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });

    const mismatched = {
      ...repository,
      readFile: vi.fn(() =>
        Promise.resolve({
          bytes: (): Uint8Array => Uint8Array.from([1]),
          size: 2,
        }),
      ),
    };
    await expect(
      collectRepositoryEvidence(mismatched as never, boundaries, inventory),
    ).rejects.toMatchObject({ code: EvidenceIndexErrorCode.invalidInput });
  });

  test("does not swallow unknown repository capability failures", async () => {
    const repository = memoryRepository({ ".nvmrc": "20" });
    const inventory = paths([".nvmrc"]);
    const boundaries = await workspaceFor(repository, inventory);
    const failure = new Error("capability contract failure");
    const failing = { ...repository, readFile: vi.fn(() => Promise.reject(failure)) };
    await expect(collectRepositoryEvidence(failing, boundaries, inventory)).rejects.toBe(failure);
  });
});
