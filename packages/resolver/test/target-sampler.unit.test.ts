import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";
import type { WorkspaceBoundary } from "@agent-context/evidence";
import { describe, expect, test } from "vitest";

import {
  TARGET_SAMPLER_DEFAULT_LIMITS,
  TARGET_SAMPLER_MAX_PATH_CODE_UNITS,
  TargetSamplerError,
  TargetSamplerErrorCode,
  classifyTargetSourcePath,
  isIssuedTargetSamplingResult,
  sampleTargets,
} from "../src/index.js";
import type { SampleTargetsInput, TargetActivationFact, TargetSamplerClock } from "../src/index.js";

interface MutableObservation {
  path: RepositoryRelativePath;
  states: TargetActivationFact[];
}

interface MutableInput {
  activationObservations: MutableObservation[];
  criticalPaths: RepositoryRelativePath[];
  paths: RepositoryRelativePath[];
  trackingCertainty: SampleTargetsInput["trackingCertainty"];
  trackingReason: SampleTargetsInput["trackingReason"];
  workspaceBoundaries: WorkspaceBoundary[];
  workspaceUncertainty: SampleTargetsInput["workspaceUncertainty"];
  workspaceUncertaintyReasons: string[];
}

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

const TRACKED = [
  path("README.md"),
  path("apps/api/main.ts"),
  path("apps/api/test.ts"),
  path("apps/web/main.tsx"),
  path("script.py"),
];

describe("E08 source-path classification", () => {
  test("shares exact basename and case-insensitive extension behavior with sampling", () => {
    expect(classifyTargetSourcePath(path("src/main.TS"))).toBe("typescript");
    expect(classifyTargetSourcePath(path("cmd/tool/Makefile"))).toBe("make");
    expect(classifyTargetSourcePath(path("cmd/tool/makefile"))).toBeNull();
    expect(classifyTargetSourcePath(path("AGENTS.md"))).toBeNull();
    expect(classifyTargetSourcePath(path("archive.ts.txt"))).toBeNull();
  });

  test("rejects roots, escapes, non-strings, proxies, and malformed Unicode", () => {
    for (const value of [".", "../main.ts", "/main.ts", 7, new Proxy({}, {}), "bad\ud800.ts"])
      expect(() => classifyTargetSourcePath(value)).toThrow(
        expect.objectContaining({ code: TargetSamplerErrorCode.invalidInput }),
      );
    expect(() =>
      classifyTargetSourcePath(`${"a".repeat(TARGET_SAMPLER_MAX_PATH_CODE_UNITS)}.ts`),
    ).toThrow(expect.objectContaining({ code: TargetSamplerErrorCode.invalidInput }));
  });
});

function workspace(
  root: string,
  family: "javascript-package" | "python-project" = "javascript-package",
): WorkspaceBoundary {
  return {
    evidencePath: path(root === "." ? "package.json" : `${root}/package.json`),
    family,
    kind: "workspace",
    languages: family === "python-project" ? ["python"] : ["javascript"],
    root: canonicalizeRepositoryRelativePath(root),
  };
}

function facts(
  target: RepositoryRelativePath,
  first: "active" | "inactive" | "indeterminate",
  second: "active" | "inactive" | "indeterminate",
): MutableObservation {
  return {
    path: target,
    states: [
      { ruleId: "rule:a", state: first },
      { ruleId: "rule:b", state: second },
    ],
  };
}

function input(): MutableInput {
  return {
    activationObservations: [
      facts(path("apps/api/main.ts"), "active", "inactive"),
      facts(path("apps/api/test.ts"), "active", "inactive"),
      facts(path("apps/web/main.tsx"), "active", "active"),
      facts(path("script.py"), "inactive", "inactive"),
    ],
    criticalPaths: [path("README.md")],
    paths: [...TRACKED],
    trackingCertainty: "tracked",
    trackingReason: "verified-git-index",
    workspaceBoundaries: [workspace("apps/api"), workspace("apps/web"), workspace(".")],
    workspaceUncertainty: "known",
    workspaceUncertaintyReasons: [],
  };
}

function observationAt(values: MutableObservation[], index: number): MutableObservation {
  const value = values[index];
  if (value === undefined) throw new Error("test observation fixture is incomplete");
  return value;
}

function pathAt(values: RepositoryRelativePath[], index: number): RepositoryRelativePath {
  const value = values[index];
  if (value === undefined) throw new Error("test path fixture is incomplete");
  return value;
}

describe("E08 deterministic target sampler", () => {
  test("exhaustively selects every source in a small repository plus critical non-source paths", () => {
    const result = sampleTargets(input());

    expect(result.strategy).toBe("exhaustive");
    expect(result.state).toBe("complete");
    expect(result.selected.map((target) => target.path)).toEqual([
      "README.md",
      "apps/api/main.ts",
      "apps/api/test.ts",
      "apps/web/main.tsx",
      "script.py",
    ]);
    expect(result.metrics).toEqual({
      activationFactCount: 8,
      criticalPathCount: 1,
      languageDirectoryCount: 3,
      partitionCount: 3,
      sourcePathCount: 4,
      trackedPathCount: 5,
      workspaceRootCount: 3,
    });
    expect(result.coverage.filter((item) => item.kind === "workspace-root")).toEqual([
      {
        candidateCount: 4,
        id: ".",
        kind: "workspace-root",
        selectedPath: "apps/api/main.ts",
        status: "covered",
      },
      {
        candidateCount: 2,
        id: "apps/api",
        kind: "workspace-root",
        selectedPath: "apps/api/main.ts",
        status: "covered",
      },
      {
        candidateCount: 1,
        id: "apps/web",
        kind: "workspace-root",
        selectedPath: "apps/web/main.tsx",
        status: "covered",
      },
    ]);
    expect(result.coverage.filter((item) => item.kind === "scope-partition")).toHaveLength(3);
    expect(result.coverage.filter((item) => item.kind === "language-directory")).toHaveLength(3);
    expect(result.selected[1]?.reasons).toEqual(
      expect.arrayContaining([
        "exhaustive-source-set:all",
        "language-directory:typescript:apps/api",
        "workspace-root:apps/api",
      ]),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.selected)).toBe(true);
    expect(Object.isFrozen(result.selected[0]?.reasons)).toBe(true);
    expect(isIssuedTargetSamplingResult(result)).toBe(true);
    expect(isIssuedTargetSamplingResult(structuredClone(result))).toBe(false);
  });

  test("stratifies a large repository while covering every workspace, activation partition, language directory, and critical path", () => {
    const result = sampleTargets(input(), { exhaustiveSourceFileLimit: 2 });

    expect(result.strategy).toBe("stratified");
    expect(result.selected.map((target) => target.path)).toEqual([
      "README.md",
      "apps/api/main.ts",
      "apps/web/main.tsx",
      "script.py",
    ]);
    expect(result.selected.map((target) => target.activationPartitionId)).toEqual([
      null,
      expect.stringMatching(/^partition:[a-f0-9]{64}$/u),
      expect.stringMatching(/^partition:[a-f0-9]{64}$/u),
      expect.stringMatching(/^partition:[a-f0-9]{64}$/u),
    ]);
    expect(result.coverage.every((item) => item.status === "covered")).toBe(true);
  });

  test("is invariant to path, workspace, observation, state, and uncertainty-reason order", () => {
    const first = input();
    first.workspaceUncertainty = "uncertain";
    first.workspaceUncertaintyReasons = [
      "upstream-discovery-index:uncertain",
      "legacy/setup.py:unsupported",
    ];
    const second = structuredClone(first);
    second.paths.reverse();
    second.workspaceBoundaries.reverse();
    second.activationObservations.reverse();
    for (const observation of second.activationObservations) observation.states.reverse();
    second.workspaceUncertaintyReasons.reverse();

    expect(sampleTargets(second, { exhaustiveSourceFileLimit: 2 })).toEqual(
      sampleTargets(first, { exhaustiveSourceFileLimit: 2 }),
    );
    expect(sampleTargets(second).state).toBe("partial");
  });

  test("emits unavailable proof and partial state for missing critical paths and empty workspaces", () => {
    const value = input();
    value.criticalPaths = [path("missing/critical.ts")];
    value.workspaceBoundaries = [...value.workspaceBoundaries, workspace("empty")];
    value.trackingCertainty = "all-files-not-tracked";
    value.trackingReason = "git-index-missing";
    const result = sampleTargets(value, { exhaustiveSourceFileLimit: 2 });

    expect(result.state).toBe("partial");
    expect(result.coverage).toContainEqual({
      candidateCount: 0,
      id: "missing/critical.ts",
      kind: "critical-path",
      selectedPath: null,
      status: "unavailable",
    });
    expect(result.coverage).toContainEqual({
      candidateCount: 0,
      id: "empty",
      kind: "workspace-root",
      selectedPath: null,
      status: "unavailable",
    });
  });

  test("requires exactly one common-universe activation observation per source path", () => {
    const missing = input();
    missing.activationObservations = missing.activationObservations.slice(1);
    expect(() => sampleTargets(missing)).toThrow(
      expect.objectContaining({ code: TargetSamplerErrorCode.invalidRelationship }),
    );

    const duplicate = input();
    duplicate.activationObservations = [
      ...duplicate.activationObservations,
      observationAt(duplicate.activationObservations, 0),
    ];
    expect(() => sampleTargets(duplicate)).toThrow(TargetSamplerError);

    const inconsistent = input();
    inconsistent.activationObservations[1] = {
      path: path("apps/api/test.ts"),
      states: [{ ruleId: "rule:a", state: "active" }],
    };
    expect(() => sampleTargets(inconsistent)).toThrow(TargetSamplerError);

    const duplicateRule = input();
    duplicateRule.activationObservations[0] = {
      path: path("apps/api/main.ts"),
      states: [
        { ruleId: "rule:a", state: "active" },
        { ruleId: "rule:a", state: "inactive" },
      ],
    };
    expect(() => sampleTargets(duplicateRule)).toThrow(TargetSamplerError);
  });

  test("rejects malformed paths, workspace facts, activation states, and upstream provenance", () => {
    const cases: ((value: MutableInput) => void)[] = [
      (value): void => {
        value.paths = [...value.paths, pathAt(value.paths, 0)];
      },
      (value): void => {
        value.trackingReason = "invented" as never;
      },
      (value): void => {
        value.workspaceUncertainty = "maybe" as never;
      },
      (value): void => {
        value.workspaceUncertaintyReasons = ["unsafe reason"];
      },
      (value): void => {
        (value.workspaceBoundaries[0] as { family: string }).family = "unknown";
      },
      (value): void => {
        (value.workspaceBoundaries[0] as { kind: string }).kind = "unknown";
      },
      (value): void => {
        (value.workspaceBoundaries[0]?.languages as string[])[0] = "unknown";
      },
      (value): void => {
        (value.activationObservations[0]?.states[0] as { state: string }).state = "maybe";
      },
      (value): void => {
        (value.activationObservations[0]?.states[0] as { ruleId: string }).ruleId = "bad rule";
      },
    ];
    for (const change of cases) {
      const value = structuredClone(input());
      change(value);
      expect(() => sampleTargets(value)).toThrow(TargetSamplerError);
    }
    const oversizedRoot = structuredClone(input());
    (oversizedRoot.workspaceBoundaries[0] as { root: string }).root = "w".repeat(
      TARGET_SAMPLER_MAX_PATH_CODE_UNITS + 1,
    );
    expect(() => sampleTargets(oversizedRoot)).toThrow(
      expect.objectContaining({ code: TargetSamplerErrorCode.invalidInput }),
    );
  });

  test("enforces sample, fact, path, and deadline resource ceilings", () => {
    expect(() =>
      sampleTargets(input(), { exhaustiveSourceFileLimit: 2, maximumSamples: 1 }),
    ).toThrow(expect.objectContaining({ code: TargetSamplerErrorCode.resourceLimit }));
    expect(() => sampleTargets(input(), { maximumActivationFacts: 1 })).toThrow(
      expect.objectContaining({ code: TargetSamplerErrorCode.resourceLimit }),
    );
    expect(() => sampleTargets(input(), { maximumPaths: 1 })).toThrow(
      expect.objectContaining({ code: TargetSamplerErrorCode.resourceLimit }),
    );

    let current = -40_000;
    const clock: TargetSamplerClock = {
      now(): number {
        current += 40_000;
        return current;
      },
    };
    expect(() => sampleTargets(input(), { clock })).toThrow(
      expect.objectContaining({ code: TargetSamplerErrorCode.deadlineExceeded }),
    );
  });

  test("rejects proxies, accessors, sparse arrays, extended arrays, and hostile options", () => {
    expect(() => sampleTargets(new Proxy(input(), {}) as never)).toThrow(TargetSamplerError);
    let reads = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "paths", {
      enumerable: true,
      get(): never {
        reads += 1;
        throw new Error("unsafe");
      },
    });
    Object.assign(accessor, {
      activationObservations: [],
      criticalPaths: [],
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    });
    expect(() => sampleTargets(accessor as never)).toThrow(TargetSamplerError);
    expect(reads).toBe(0);

    const sparse = input();
    sparse.paths = new Array(100_001) as RepositoryRelativePath[];
    expect(() => sampleTargets(sparse)).toThrow(
      expect.objectContaining({ code: TargetSamplerErrorCode.resourceLimit }),
    );
    const extended = input();
    (extended.paths as RepositoryRelativePath[] & { extra?: boolean }).extra = true;
    expect(() => sampleTargets(extended)).toThrow(TargetSamplerError);
    expect(() => sampleTargets(input(), { unknown: 1 } as never)).toThrow(TargetSamplerError);
    expect(() => sampleTargets(input(), { maximumPaths: 0 })).toThrow(TargetSamplerError);
  });

  test("handles a repository with no recognized source files deterministically", () => {
    const result = sampleTargets({
      activationObservations: [],
      criticalPaths: [path("README.md")],
      paths: [path("README.md")],
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    });
    expect(result.strategy).toBe("exhaustive");
    expect(result.metrics.sourcePathCount).toBe(0);
    expect(result.selected).toEqual([
      {
        activationPartitionId: null,
        language: null,
        path: "README.md",
        reasons: ["critical-path:README.md"],
      },
    ]);
  });

  test("recognizes representative source languages and extensionless build targets", () => {
    const languagePaths = [
      "Dockerfile",
      "Makefile",
      "app/main.go",
      "contract/main.sol",
      "infra/main.tf",
      "native/main.mm",
      "schema/main.proto",
      "ui/main.svelte",
      "ui/main.vue",
      "web/main.scss",
    ].map(path);
    const result = sampleTargets({
      activationObservations: languagePaths.map((target) => ({ path: target, states: [] })),
      criticalPaths: [],
      paths: languagePaths,
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    });
    expect(
      Object.fromEntries(result.selected.map((target) => [target.path, target.language])),
    ).toEqual({
      Dockerfile: "shell",
      Makefile: "make",
      "app/main.go": "go",
      "contract/main.sol": "solidity",
      "infra/main.tf": "terraform",
      "native/main.mm": "objective-c",
      "schema/main.proto": "protobuf",
      "ui/main.svelte": "svelte",
      "ui/main.vue": "vue",
      "web/main.scss": "css",
    });
  });

  test("rejects contradictory upstream certainty and unsafe nested array entries", () => {
    const tracking = input();
    tracking.trackingCertainty = "tracked";
    tracking.trackingReason = "git-index-missing";
    expect(() => sampleTargets(tracking)).toThrow(TargetSamplerError);

    const workspaceEvidence = input();
    workspaceEvidence.workspaceUncertainty = "known";
    workspaceEvidence.workspaceUncertaintyReasons = ["upstream-discovery-index:uncertain"];
    expect(() => sampleTargets(workspaceEvidence)).toThrow(TargetSamplerError);

    const duplicateReason = input();
    duplicateReason.workspaceUncertainty = "uncertain";
    duplicateReason.workspaceUncertaintyReasons = ["reason:one", "reason:one"];
    expect(() => sampleTargets(duplicateReason)).toThrow(TargetSamplerError);

    const unsafe = input();
    const paths = [...unsafe.paths];
    let reads = 0;
    Object.defineProperty(paths, "0", {
      enumerable: true,
      get(): never {
        reads += 1;
        throw new Error("unsafe");
      },
    });
    unsafe.paths = paths;
    expect(() => sampleTargets(unsafe)).toThrow(TargetSamplerError);
    expect(reads).toBe(0);
  });

  test("rejects clock failures, non-finite time, and additional hard limits", () => {
    expect(() =>
      sampleTargets(input(), {
        clock: {
          now(): never {
            throw new Error("clock failed");
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: TargetSamplerErrorCode.invalidOptions }));
    expect(() => sampleTargets(input(), { clock: { now: (): number => Number.NaN } })).toThrow(
      expect.objectContaining({ code: TargetSamplerErrorCode.invalidOptions }),
    );
    expect(() => sampleTargets(input(), { maximumPathTextBytes: 1 })).toThrow(
      expect.objectContaining({ code: TargetSamplerErrorCode.resourceLimit }),
    );
    expect(() => sampleTargets(input(), { maximumRulesPerPath: 1 })).toThrow(
      expect.objectContaining({ code: TargetSamplerErrorCode.resourceLimit }),
    );
  });

  test("repeats byte-identically", () => {
    const expected = JSON.stringify(sampleTargets(input(), { exhaustiveSourceFileLimit: 2 }));
    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(sampleTargets(input(), { exhaustiveSourceFileLimit: 2 }))).toBe(
        expected,
      );
    }
    expect(TARGET_SAMPLER_DEFAULT_LIMITS.maximumPaths).toBe(100_000);
  });

  test("stratifies the maximum supported 100,000-path repository deterministically", () => {
    const paths = Array.from({ length: TARGET_SAMPLER_DEFAULT_LIMITS.maximumPaths }, (_, index) =>
      path(`src/file-${index.toString().padStart(5, "0")}.ts`),
    );
    const value: MutableInput = {
      activationObservations: paths.map((target) => ({ path: target, states: [] })),
      criticalPaths: [],
      paths,
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    };

    const first = sampleTargets(value);
    const second = sampleTargets(value);

    expect(first).toEqual(second);
    expect(first.strategy).toBe("stratified");
    expect(first.state).toBe("complete");
    expect(first.metrics).toEqual({
      activationFactCount: 0,
      criticalPathCount: 0,
      languageDirectoryCount: 1,
      partitionCount: 1,
      sourcePathCount: 100_000,
      trackedPathCount: 100_000,
      workspaceRootCount: 0,
    });
    const activationPartitionId = first.selected[0]?.activationPartitionId;
    expect(activationPartitionId).toMatch(/^partition:[a-f0-9]{64}$/u);
    if (activationPartitionId === null || activationPartitionId === undefined) {
      throw new Error("maximum-scale sample is missing its activation partition");
    }
    expect(first.selected).toEqual([
      {
        activationPartitionId,
        language: "typescript",
        path: "src/file-00000.ts",
        reasons: ["language-directory:typescript:src", `scope-partition:${activationPartitionId}`],
      },
    ]);
  });
});
