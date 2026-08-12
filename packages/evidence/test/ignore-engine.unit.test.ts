import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir, symlink, writeFile } from "node:fs/promises";

import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test } from "vitest";

import {
  applyIgnoreRules,
  applyIgnoreRulesWithClock,
  createReadOnlyRepository,
  enumerateTrackedFiles,
  IgnoreEngineErrorCode,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  selectRepositoryRoot,
  TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
} from "../src/index.js";
import type {
  IgnoreEngineClock,
  IgnoreEngineOptions,
  ProfileIgnoreFact,
  ReadOnlyRepository,
  TrackedFileEnumerationResult,
} from "../src/index.js";

interface ConformanceCase {
  readonly expectedIgnored: boolean;
  readonly id: string;
  readonly path: string;
  readonly patterns: readonly string[];
}

interface ConformanceFixture {
  readonly cases: readonly ConformanceCase[];
  readonly recordKind: "gitignore-conformance-fixture";
  readonly retrievedAt: string;
  readonly schemaVersion: 1;
  readonly sourceUrl: string;
}

const fixturePath = new URL(
  "../../../conformance/fixtures/v0/gitignore-2.55.0.fixture.json",
  import.meta.url,
);
const conformance = JSON.parse(await readFile(fixturePath, "utf8")) as ConformanceFixture;

async function facade(root: string, signal?: AbortSignal): Promise<ReadOnlyRepository> {
  const selection = await selectRepositoryRoot(root, { mode: "explicit" });
  return createReadOnlyRepository(selection, signal === undefined ? undefined : { signal });
}

function enumeration(
  paths: readonly string[],
  source: "filesystem-fallback" | "git-index" = "git-index",
): TrackedFileEnumerationResult {
  return {
    certainty: source === "git-index" ? "tracked" : "all-files-not-tracked",
    limits: TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
    omittedProblems: 0,
    paths: paths as TrackedFileEnumerationResult["paths"],
    problems: [],
    reason: source === "git-index" ? "verified-git-index" : "git-directory-missing",
    source,
    ...(source === "git-index" ? { indexObjectFormat: "sha1", indexVersion: 2 } : {}),
  };
}

test("preserves upstream enumeration incompleteness through ignore evaluation", async () => {
  await withTempWorkspace({}, async (workspace) => {
    const repository = await facade(workspace.root);
    const input = {
      ...enumeration([], "filesystem-fallback"),
      omittedProblems: 2,
      problems: [
        {
          code: "READ_ONLY_REPOSITORY_PATH_OUTSIDE",
          path: "escape" as TrackedFileEnumerationResult["problems"][number]["path"],
        },
      ],
    } as TrackedFileEnumerationResult;

    const result = await applyIgnoreRules(repository, input);

    expect(result.omittedProblems).toBe(2);
    expect(result.problems).toContainEqual({
      code: "READ_ONLY_REPOSITORY_PATH_OUTSIDE",
      line: null,
      path: "escape",
    });
  });
});

async function writeCandidate(root: string, relativePath: string): Promise<void> {
  const absolute = `${root}/${relativePath}`;
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, "candidate");
}

function profileFact(overrides: Partial<ProfileIgnoreFact> = {}): ProfileIgnoreFact {
  return {
    applicability: "known-active",
    clientVersion: "1.0.0",
    evidence: "documented-versioned",
    factId: "profile-ignore-1",
    pattern: "*.profile",
    profileId: "fixture-profile",
    reason: null,
    retrievedAt: "2026-08-02",
    sourceUrl: "https://example.com/spec",
    ...overrides,
  };
}

describe("C04 official Git ignore conformance corpus", () => {
  test("fixture provenance is pinned to the current official manual", () => {
    expect(conformance).toMatchObject({
      recordKind: "gitignore-conformance-fixture",
      retrievedAt: "2026-08-02",
      schemaVersion: 1,
      sourceUrl: "https://git-scm.com/docs/gitignore/2.55.0",
    });
    expect(conformance.cases.length).toBeGreaterThanOrEqual(20);
  });

  test.each(conformance.cases)("matches official case $id", async (fixture) => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/.gitignore"), `${fixture.patterns.join("\n")}\n`);
      await writeCandidate(root, fixture.path);
      const repository = await facade(root);
      const files = await enumerateTrackedFiles(repository);

      const result = await applyIgnoreRules(repository, files);

      expect(result.ignored.some((decision) => decision.path === fixture.path)).toBe(
        fixture.expectedIgnored,
      );
    });
  });
});

describe("C04 source ordering and provenance", () => {
  test("does not read or apply .gitignore to a verified tracked set", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const underlying = await facade(root);
      let reads = 0;
      const repository: ReadOnlyRepository = {
        inspect: (path) => underlying.inspect(path),
        limits: underlying.limits,
        readDirectory: (path) => underlying.readDirectory(path),
        readFile: (path) => {
          reads += 1;
          return underlying.readFile(path);
        },
        root: underlying.root,
        usage: () => underlying.usage(),
      };

      const result = await applyIgnoreRules(repository, enumeration([".gitignore", "tracked.log"]));

      expect(result.paths).toEqual([".gitignore", "tracked.log"]);
      expect(result.certainty).toBe("exact-tracked-input");
      expect(reads).toBe(0);
    });
  });

  test("lets nested .gitignore override a parent rule", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(workspace.resolvePath("repo/Documentation"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/.gitignore"), "*.html\n");
      await writeFile(workspace.resolvePath("repo/Documentation/.gitignore"), "!foo.html\n");
      await writeFile(workspace.resolvePath("repo/Documentation/foo.html"), "foo");
      await writeFile(workspace.resolvePath("repo/Documentation/bar.html"), "bar");
      const repository = await facade(root);

      const result = await applyIgnoreRules(repository, await enumerateTrackedFiles(repository));

      expect(result.paths).toContain("Documentation/foo.html");
      expect(result.trackingCertainty).toBe("fallback-mixed-unknown");
      expect(result.ignored).toContainEqual(
        expect.objectContaining({
          path: "Documentation/bar.html",
          certainty: "tracking-uncertain",
        }),
      );
    });
  });

  test("never reads a nested ignore file below an excluded parent", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(workspace.resolvePath("repo/foo"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/.gitignore"), "foo/\n");
      await writeFile(workspace.resolvePath("repo/foo/.gitignore"), "!bar.txt\n");
      await writeFile(workspace.resolvePath("repo/foo/bar.txt"), "bar");
      const underlying = await facade(root);
      const readPaths: unknown[] = [];
      const repository: ReadOnlyRepository = {
        inspect: (path) => underlying.inspect(path),
        limits: underlying.limits,
        readDirectory: (path) => underlying.readDirectory(path),
        readFile: (path) => {
          readPaths.push(path);
          return underlying.readFile(path);
        },
        root: underlying.root,
        usage: () => underlying.usage(),
      };
      const files = await enumerateTrackedFiles(repository);
      readPaths.length = 0;

      const result = await applyIgnoreRules(repository, files);

      expect(result.ignored).toContainEqual(expect.objectContaining({ path: "foo/bar.txt" }));
      expect(readPaths).toEqual([".gitignore"]);
    });
  });

  test("applies fixed source precedence and defers uncertain profile facts", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const repository = await facade(root);
      const uncertain = profileFact({
        applicability: "unknown",
        factId: "unknown-ignore",
        pattern: "unknown.txt",
        reason: "client behavior is not documented",
      });
      const inactive = profileFact({
        applicability: "known-inactive",
        factId: "inactive-ignore",
        pattern: "inactive.txt",
      });
      const result = await applyIgnoreRules(
        repository,
        enumeration([
          ".git/config",
          "inactive.txt",
          "keep.profile",
          "node_modules/AGENTS.md",
          "unknown.txt",
        ]),
        {
          configurationPatterns: ["!keep.profile", "!node_modules/"],
          profileFacts: [profileFact(), uncertain, inactive],
        },
      );

      expect(result.paths).toEqual(["inactive.txt", "keep.profile", "unknown.txt"]);
      expect(result.ignored).toContainEqual(
        expect.objectContaining({ path: "node_modules/AGENTS.md", certainty: "known" }),
      );
      expect(result.ignored).toContainEqual(
        expect.objectContaining({ path: ".git/config", certainty: "known" }),
      );
      expect(result.appliedProfileFactIds).toEqual(["profile-ignore-1"]);
      expect(result.deferredProfileFacts).toEqual([uncertain]);
      expect(result.profileFacts).toEqual([profileFact(), uncertain, inactive]);
      expect(result.profileCertainty).toBe("uncertain-facts-deferred");
      expect(result.trackingCertainty).toBe("tracked");
      expect(
        result.rules.find((rule) => rule.source.kind === "built-in")?.precedence,
      ).toBeGreaterThan(
        result.rules.find((rule) => rule.source.kind === "configuration")?.precedence ?? 0,
      );
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.rules)).toBe(true);
    });
  });
});

describe("C04 hostile inputs, filesystem failures, and limits", () => {
  test("rejects malformed UTF-8 and unsafe pattern text", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/.gitignore"), Buffer.from([0xff]));
      const repository = await facade(root);
      await expect(
        applyIgnoreRules(repository, await enumerateTrackedFiles(repository)),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.malformedInput });

      for (const content of [
        Buffer.from([0xef, 0xbb, 0xbf, 0x78]),
        Buffer.from("bad\tpattern\n"),
      ]) {
        await writeFile(workspace.resolvePath("repo/.gitignore"), content);
        const nextRepository = await facade(root);
        await expect(
          applyIgnoreRules(nextRepository, await enumerateTrackedFiles(nextRepository)),
        ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.malformedInput });
      }

      for (const pattern of [
        "bad\u0000pattern",
        "bad\u0080pattern",
        "bad\ud800pattern",
        "bad\ufeffpattern",
        "bad\u061cpattern",
        "bad\u200epattern",
        "bad\u200fpattern",
        "bad\u202epattern",
        "bad\u2066pattern",
      ]) {
        await expect(
          applyIgnoreRules(repository, enumeration(["file"]), {
            configurationPatterns: [pattern],
          }),
        ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidOptions });
      }
    });
  });

  test("skips a symlinked ignore file and records explicit provenance", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/patterns"), "*.log\n");
      await symlink("patterns", workspace.resolvePath("repo/.gitignore"));
      await writeFile(workspace.resolvePath("repo/file.log"), "log");
      const repository = await facade(root);

      const result = await applyIgnoreRules(repository, await enumerateTrackedFiles(repository));

      expect(result.paths).toContain("file.log");
      expect(result.problems).toContainEqual({
        code: "IGNORE_FILE_LINK_SKIPPED",
        line: null,
        path: ".gitignore",
      });
    });
  });

  test("reports a non-file ignore path without attempting a content read", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(workspace.resolvePath("repo/.gitignore"), { recursive: true });
      const underlying = await facade(root);
      let reads = 0;
      const repository: ReadOnlyRepository = {
        inspect: (path) => underlying.inspect(path),
        limits: underlying.limits,
        readDirectory: (path) => underlying.readDirectory(path),
        readFile: (path) => {
          reads += 1;
          return underlying.readFile(path);
        },
        root: underlying.root,
        usage: () => underlying.usage(),
      };
      const result = await applyIgnoreRules(
        repository,
        enumeration([".gitignore"], "filesystem-fallback"),
      );
      expect(result.problems).toContainEqual({
        code: "IGNORE_FILE_UNSAFE_TYPE",
        line: null,
        path: ".gitignore",
      });
      expect(reads).toBe(0);
    });
  });

  test("accepts CRLF pattern files without retaining carriage returns", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/.gitignore"), "*.log\r\n");
      await writeFile(workspace.resolvePath("repo/file.log"), "log");
      const repository = await facade(root);
      const result = await applyIgnoreRules(repository, await enumerateTrackedFiles(repository));
      expect(result.ignored).toContainEqual(expect.objectContaining({ path: "file.log" }));
    });
  });

  test("propagates a C02 path-change race", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/.gitignore"), "*.log\n");
      const underlying = await facade(root);
      const files = await enumerateTrackedFiles(underlying);
      const repository: ReadOnlyRepository = {
        inspect: (path) => underlying.inspect(path),
        limits: underlying.limits,
        readDirectory: (path) => underlying.readDirectory(path),
        readFile: () =>
          Promise.reject(
            new ReadOnlyRepositoryError(
              ReadOnlyRepositoryErrorCode.pathChanged,
              "fixture race",
              "read-file",
            ),
          ),
        root: underlying.root,
        usage: () => underlying.usage(),
      };

      await expect(applyIgnoreRules(repository, files)).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
      });
    });
  });

  test("bounds retained invalid-pattern problems and counts omissions", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/.gitignore"), "bad\\\nother\\\nthird\\\n");
      const repository = await facade(root);
      const result = await applyIgnoreRules(repository, await enumerateTrackedFiles(repository), {
        maximumProblems: 2,
      });
      expect(result.problems).toHaveLength(2);
      expect(result.omittedProblems).toBe(1);
    });
  });

  test("enforces file, pattern, path, work, cancellation, and deadline limits", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/.gitignore"), "*.log\n");
      const repository = await facade(root);
      const fallback = await enumerateTrackedFiles(repository);
      await expect(
        applyIgnoreRules(repository, fallback, { maximumIgnoreFileBytes: 1 }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.limitExceeded });
      await expect(
        applyIgnoreRules(repository, fallback, { maximumPatternBytes: 164 }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.limitExceeded });
      await expect(
        applyIgnoreRules(repository, enumeration(["a", "b"]), { maximumPaths: 1 }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidInput });
      await expect(
        applyIgnoreRules(repository, enumeration(["file"]), { maximumPatterns: 1 }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.limitExceeded });
      await expect(
        applyIgnoreRules(repository, enumeration(["file"]), { maximumMatchWork: 1 }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.limitExceeded });

      const controller = new AbortController();
      controller.abort();
      await expect(
        applyIgnoreRules(repository, enumeration(["file"]), { signal: controller.signal }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.aborted });

      const times = [0, 2];
      const clock: IgnoreEngineClock = { now: () => times.shift() ?? 2 };
      await expect(
        applyIgnoreRulesWithClock(
          repository,
          enumeration(["file"]),
          { maximumDurationMs: 1 },
          clock,
        ),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.deadlineExceeded });
    });
  });

  test("rejects proxies, accessors, sparse arrays, bad facts, and forged enumerations before reads", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const repository = await facade(root);
      const sparse = new Array<string>(1);
      let reads = 0;
      const accessor = Object.defineProperty({}, "configurationPatterns", {
        get() {
          reads += 1;
          return [];
        },
      });
      for (const options of [
        new Proxy({}, {}),
        accessor,
        { configurationPatterns: sparse },
        { profileFacts: [new Proxy(profileFact(), {})] },
        { profileFacts: [profileFact({ sourceUrl: "http://example.com" })] },
      ]) {
        await expect(
          applyIgnoreRules(repository, enumeration(["file"]), options as IgnoreEngineOptions),
        ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidOptions });
      }
      await expect(
        applyIgnoreRules(repository, new Proxy(enumeration(["file"]), {})),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidInput });
      expect(reads).toBe(0);
    });
  });

  test("validates every option and profile-fact field without coercion", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const repository = await facade(root);
      const extraArray = Object.assign(["*.log"], { extra: true });
      const extraNumericArray = ["*.log"];
      Object.defineProperty(extraNumericArray, "2", { value: "*.tmp" });
      const invalidOptions: unknown[] = [
        null,
        [],
        { unknown: true },
        { maximumDurationMs: 0 },
        { maximumDurationMs: 300_001 },
        { maximumDurationMs: Number.NaN },
        { signal: undefined },
        { signal: null },
        { signal: {} },
        { signal: new Proxy({}, {}) },
        { configurationPatterns: extraArray },
        { configurationPatterns: extraNumericArray },
        { configurationPatterns: [1] },
        { profileFacts: [{ applicability: "known-active" }] },
        { profileFacts: [profileFact(), profileFact()] },
        { profileFacts: [profileFact({ applicability: "sometimes" as never })] },
        { profileFacts: [profileFact({ clientVersion: "" })] },
        { profileFacts: [profileFact({ evidence: "unknown" as never })] },
        { profileFacts: [profileFact({ factId: "Bad Fact" })] },
        { profileFacts: [profileFact({ profileId: "Bad Profile" })] },
        { profileFacts: [profileFact({ pattern: "bad\\" })] },
        { profileFacts: [profileFact({ reason: "unexpected" })] },
        {
          profileFacts: [profileFact({ applicability: "conditional", reason: null })],
        },
        { profileFacts: [profileFact({ retrievedAt: "not-a-date" })] },
        { profileFacts: [profileFact({ retrievedAt: "2026-02-30" })] },
        { profileFacts: [profileFact({ sourceUrl: "https://user@example.com" })] },
        { profileFacts: [profileFact({ sourceUrl: null as never })] },
      ];
      for (const options of invalidOptions) {
        await expect(
          applyIgnoreRules(repository, enumeration(["file"]), options as IgnoreEngineOptions),
        ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidOptions });
      }
    });
  });

  test("rejects inconsistent, malformed, unsorted, deep, and accessor enumerations", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const repository = await facade(root);
      const accessor = Object.defineProperty({}, "source", { get: () => "git-index" });
      const extraPaths = Object.assign(["file"], { extra: true });
      const invalidEnumerations: unknown[] = [
        accessor,
        { certainty: "tracked", paths: ["file"], source: "filesystem-fallback" },
        { certainty: "tracked", paths: [1], source: "git-index" },
        { certainty: "tracked", paths: ["../file"], source: "git-index" },
        { certainty: "tracked", paths: ["b", "a"], source: "git-index" },
        { certainty: "tracked", paths: ["a", "a"], source: "git-index" },
        { certainty: "tracked", paths: extraPaths, source: "git-index" },
        { certainty: "tracked", paths: ["a/b"], source: "git-index" },
      ];
      for (const candidate of invalidEnumerations) {
        await expect(
          applyIgnoreRules(repository, candidate as TrackedFileEnumerationResult, {
            maximumPathDepth: 1,
          }),
        ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidInput });
      }
    });
  });

  test("rejects unsafe pattern length/depth and invalid trusted clocks", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const repository = await facade(root);
      await expect(
        applyIgnoreRules(repository, enumeration(["file"]), {
          configurationPatterns: ["x".repeat(4_097)],
        }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidOptions });
      await expect(
        applyIgnoreRules(repository, enumeration(["file"]), {
          configurationPatterns: ["a/b"],
          maximumPathDepth: 1,
        }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidOptions });
      for (const pattern of ["a//b", "/", "!", "bad\\", "# comment"]) {
        await expect(
          applyIgnoreRules(repository, enumeration(["file"]), {
            configurationPatterns: [pattern],
          }),
        ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidOptions });
      }
      for (const clock of [
        { now: (): number => Number.NaN },
        {
          now: (): number => {
            throw new Error("clock failed");
          },
        },
      ]) {
        await expect(
          applyIgnoreRulesWithClock(repository, enumeration(["file"]), undefined, clock),
        ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.invalidOptions });
      }
    });
  });

  test("bounds ignore-file count and total pattern bytes", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(workspace.resolvePath("repo/a"), { recursive: true });
      await mkdir(workspace.resolvePath("repo/b"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/.gitignore"), "\n");
      await writeFile(workspace.resolvePath("repo/a/.gitignore"), "\n");
      await writeFile(workspace.resolvePath("repo/b/.gitignore"), "\n");
      const repository = await facade(root);
      const files = await enumerateTrackedFiles(repository);
      await expect(
        applyIgnoreRules(repository, files, { maximumIgnoreFiles: 1 }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.limitExceeded });
      await expect(
        applyIgnoreRules(repository, files, { maximumPatterns: 21 }),
      ).resolves.toMatchObject({ problems: [] });
      await expect(
        applyIgnoreRules(repository, enumeration(["file"]), { maximumPatternBytes: 1 }),
      ).rejects.toMatchObject({ code: IgnoreEngineErrorCode.limitExceeded });
    });
  });

  test("records unavailable ignore files and rejects identity changes", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/.gitignore"), "*.log\n");
      const underlying = await facade(root);
      const missing = await applyIgnoreRules(
        underlying,
        enumeration([".gitignore", "file.log"], "filesystem-fallback"),
      );
      expect(missing.problems).toEqual([]);

      const unavailable: ReadOnlyRepository = {
        inspect: () =>
          Promise.reject(
            new ReadOnlyRepositoryError(
              ReadOnlyRepositoryErrorCode.pathUnavailable,
              "gone",
              "inspect",
            ),
          ),
        limits: underlying.limits,
        readDirectory: (path) => underlying.readDirectory(path),
        readFile: (path) => underlying.readFile(path),
        root: underlying.root,
        usage: () => underlying.usage(),
      };
      const unavailableResult = await applyIgnoreRules(
        unavailable,
        enumeration([".gitignore", "file.log"], "filesystem-fallback"),
      );
      expect(unavailableResult.problems).toContainEqual(
        expect.objectContaining({ code: ReadOnlyRepositoryErrorCode.pathUnavailable }),
      );

      const plainFailure: ReadOnlyRepository = {
        inspect: () => Promise.reject(new Error("opaque failure")),
        limits: underlying.limits,
        readDirectory: (path) => underlying.readDirectory(path),
        readFile: (path) => underlying.readFile(path),
        root: underlying.root,
        usage: () => underlying.usage(),
      };
      const plainFailureResult = await applyIgnoreRules(
        plainFailure,
        enumeration([".gitignore", "file.log"], "filesystem-fallback"),
      );
      expect(plainFailureResult.problems).toContainEqual(
        expect.objectContaining({ code: "IGNORE_FILE_UNAVAILABLE" }),
      );

      const readUnavailable: ReadOnlyRepository = {
        inspect: (path) => underlying.inspect(path),
        limits: underlying.limits,
        readDirectory: (path) => underlying.readDirectory(path),
        readFile: () =>
          Promise.reject(
            new ReadOnlyRepositoryError(
              ReadOnlyRepositoryErrorCode.pathUnavailable,
              "gone",
              "read-file",
            ),
          ),
        root: underlying.root,
        usage: () => underlying.usage(),
      };
      const readUnavailableResult = await applyIgnoreRules(
        readUnavailable,
        enumeration([".gitignore", "file.log"], "filesystem-fallback"),
      );
      expect(readUnavailableResult.problems).toContainEqual(
        expect.objectContaining({ code: ReadOnlyRepositoryErrorCode.pathUnavailable }),
      );

      const changed: ReadOnlyRepository = {
        inspect: (path) => underlying.inspect(path),
        limits: underlying.limits,
        readDirectory: (path) => underlying.readDirectory(path),
        readFile: async (path) => {
          const file = await underlying.readFile(path);
          return new ReadOnlyRepositoryFile(
            file.path,
            file.bytes(),
            { ...file.identity, inode: `${file.identity.inode}0` },
            file.linkDepth,
          );
        },
        root: underlying.root,
        usage: () => underlying.usage(),
      };
      await expect(
        applyIgnoreRules(changed, enumeration([".gitignore", "file.log"], "filesystem-fallback")),
      ).rejects.toMatchObject({ code: ReadOnlyRepositoryErrorCode.pathChanged });
    });
  });
});
