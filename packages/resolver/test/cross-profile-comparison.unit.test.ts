import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "@agent-context/core";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  type ReadOnlyRepository,
} from "@agent-context/evidence";
import type { GeminiSettingsLayerInput } from "@agent-context/syntax";
import { describe, expect, test, vi } from "vitest";

import {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
  CROSS_PROFILE_COMPARISON_LIMITS,
  CrossProfileComparisonErrorCode,
  compareEffectiveContexts,
  isIssuedCrossProfileComparison,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveCopilotProfile,
  resolveCursorProfile,
  resolveEffectiveContext,
  resolveGeminiCliContext,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  type CrossProfileComparison,
  type CursorRuleCandidateSnapshot,
  type ClaudeInstructionCandidateSnapshot,
  type EffectiveContextProfileResolution,
  type EffectiveContextResolution,
  type GeminiCliCandidateSnapshot,
} from "../src/index.js";

const encoder = new TextEncoder();

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function effective(
  profileResolution: EffectiveContextProfileResolution,
  targetPath = path("src/main.ts"),
): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath,
  });
}

function codex(
  entries: readonly { readonly content: string; readonly path: string }[] = [
    { content: "Root policy.\n", path: "AGENTS.md" },
    { content: "App policy.\n", path: "src/AGENTS.md" },
  ],
  targetPath = path("src/main.ts"),
  options: {
    readonly fallbacks?: readonly string[];
    readonly maximumBytes?: number;
    readonly unreadablePaths?: ReadonlySet<string>;
  } = {},
): EffectiveContextResolution {
  return effective(
    resolveCodexCliAgents({
      discovery: {
        certainty: "known",
        entries: entries.map((entry) => ({
          bytes:
            options.unreadablePaths?.has(entry.path) === true
              ? null
              : encoder.encode(entry.content),
          errorCode: options.unreadablePaths?.has(entry.path) === true ? "EACCES" : null,
          kind:
            options.unreadablePaths?.has(entry.path) === true
              ? ("unreadable-file" as const)
              : ("file" as const),
          path: path(entry.path),
          resolvedTarget: null,
        })),
        reason: "complete comparison fixture",
        rootMarkerPaths: [path(".git")],
      },
      externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
      launchCwd: path("src"),
      settings: {
        projectDocFallbackFilenames: options.fallbacks ?? [],
        projectDocMaxBytes: options.maximumBytes ?? 32_768,
        projectRootMarkers: [".git"],
      },
      targetPath,
    }),
    targetPath,
  );
}

function claudeCandidate(
  candidatePath: string,
  source: string,
): ClaudeInstructionCandidateSnapshot {
  return {
    absolutePath: `/repo/${candidatePath}`,
    bytes: encoder.encode(source),
    importGraph: null,
    kind: "memory-shared",
    origin: "repository",
    path: path(candidatePath),
    scopeRoot: path("."),
    symlinkState: "none",
  };
}

function claudePartialOrder(): EffectiveContextResolution {
  return effective(
    resolveClaudeCodeProfile({
      candidates: [
        claudeCandidate("CLAUDE.md", "Root.\n"),
        claudeCandidate("other/CLAUDE.md", "Other.\n"),
        claudeCandidate("src/CLAUDE.md", "App.\n"),
      ],
      launchCwd: path("."),
      repositoryRoot: path("."),
      runtime: {
        additionalDirectoryInstructions: "disabled",
        clientVersion: "2.1.33",
        eventTrace: [
          { id: "launch", kind: "launch", path: path(".") },
          { id: "read-other", kind: "read", path: path("other/main.ts") },
          { id: "read-src", kind: "read", path: path("src/main.ts") },
        ],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "supplied",
        mode: "normal",
        settingSources: { state: "known", values: [] },
      },
    }),
  );
}

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/comparison-fixture",
    inspect: () => Promise.reject(new Error("not used")),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const sourcePath = path(String(value));
      const source = sources[sourcePath];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "comparison fixture source unavailable",
          "read-file",
          sourcePath,
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          sourcePath,
          encoder.encode(source),
          { device: "fixture", inode: sourcePath },
          0,
        ),
      );
    },
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
}

function geminiCandidate(
  value: string,
  kind: GeminiCliCandidateSnapshot["kind"] = "file",
): GeminiCliCandidateSnapshot {
  return { identity: `${kind}:${value}`, ignoredBy: [], kind, path: path(value) };
}

function geminiSettings(fileName = "AGENTS.md"): GeminiSettingsLayerInput {
  return {
    bytes: encoder.encode(JSON.stringify({ context: { fileName } })),
    kind: "workspace",
    path: path(".gemini/settings.json"),
    trustState: "trusted",
  };
}

async function gemini(
  sources: Readonly<Record<string, string>> = {
    "AGENTS.md": "Root policy.\n",
    "src/AGENTS.md": "App policy.\n",
  },
  fileName = "AGENTS.md",
): Promise<EffectiveContextResolution> {
  const files = Object.keys(sources).sort();
  return effective(
    await resolveGeminiCliContext({
      boundaryMarkerDirectories: [path(".")],
      candidates: [
        geminiCandidate(".", "directory"),
        geminiCandidate("src", "directory"),
        ...files.map((file) => geminiCandidate(file)),
        geminiCandidate("src/main.ts"),
      ],
      events: [
        { id: "launch", kind: "launch", path: path(".") },
        { id: "read", kind: "read-path", path: path("src/main.ts") },
      ],
      externalContext: "explicit-synthetic",
      repository: repository(sources),
      settingsLayers: [geminiSettings(fileName)],
      trustState: "trusted",
      workspaceRoots: [path(".")],
    }),
  );
}

function copilotConditional(): EffectiveContextResolution {
  return effective(
    resolveCopilotProfile({
      candidates: [
        {
          bytes: encoder.encode("---\ndescription: Selected by model\n---\nConditional.\n"),
          format: "path-specific",
          path: path(".github/instructions/conditional.instructions.md"),
        },
      ],
      profileId: "copilot-vscode",
      runtime: {
        applyingInstructions: "enabled",
        eventState: "present",
        instructionFolders: [{ path: path(".github/instructions"), workspaceRoot: path(".") }],
        kind: "copilot-vscode",
        manualAttachments: [],
        targetPaths: [path("src/main.ts")],
        workspaceRoots: [path(".")],
      },
    }),
  );
}

function cursorConditional(
  surfaceId: "cursor-agent/cli" | "cursor-agent/ide",
  candidatePath = ".cursor/rules/conditional.mdc",
): EffectiveContextResolution {
  const candidate: CursorRuleCandidateSnapshot = {
    bytes: encoder.encode("---\nglobs: '**/*.ts'\n---\nConditional.\n"),
    format: "mdc",
    path: path(candidatePath),
  };
  return effective(
    resolveCursorProfile({
      candidates: [candidate],
      runtime: {
        clientVersion: surfaceId === "cursor-agent/cli" ? "2026.05.24-dda726e" : "3.12.30",
        eventState: "present",
        events: [{ kind: "reference-path", sequence: 1, targetPath: path("src/main.ts") }],
        externalContext: "absent",
        projectRules: "enabled",
        surfaceId,
        workspaceRoots: [path(".")],
      },
    }),
  );
}

function compare(resolutions: readonly EffectiveContextResolution[]): CrossProfileComparison {
  return compareEffectiveContexts({
    contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
    recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
    resolutions,
  });
}

describe("E07 cross-profile comparison", () => {
  test("reports an observational match without collapsing incompatible semantics", async () => {
    const codexResult = codex();
    const geminiResult = await gemini();
    const result = compare([geminiResult, codexResult]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      content: { state: "same", unknownPaths: [] },
      equivalenceClaim: false,
      ordering: { state: "same", witness: null },
      overall: "observational-match",
      scope: { state: "same", unknownPaths: [] },
      semanticRelation: "incompatible-profile-contracts",
    });
    expect(result.profiles.map((profile) => profile.profileId).sort()).toEqual([
      "codex-cli",
      "gemini-cli",
    ]);
    expect(result.analysisStatus).toBe("partial");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.pairs[0]?.content)).toBe(true);
    expect(isIssuedCrossProfileComparison(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Root policy");
  });

  test("highlights known scope and content divergence with digest-only evidence", async () => {
    const result = compare([codex(), await gemini({ "AGENTS.md": "Different root.\n" })]);
    const pair = result.pairs[0];

    expect(pair?.overall).toBe("divergent");
    expect(pair?.scope).toMatchObject({ state: "different", unknownPaths: [] });
    expect(pair?.scope.differences).toContainEqual(
      expect.objectContaining({ path: "src/AGENTS.md" }),
    );
    expect(pair?.content).toMatchObject({ state: "different", unknownPaths: [] });
    expect(pair?.content.differences).toEqual([expect.objectContaining({ path: "AGENTS.md" })]);
    expect(pair?.content.differences[0]?.leftSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(pair)).not.toContain("Different root");
  });

  test("retains conditional scope and unavailable comparison dimensions as unknown", () => {
    const result = compare([codex(), copilotConditional()]);
    const pair = result.pairs[0];

    expect(pair?.scope.state).toBe("unknown");
    expect(pair?.scope.unknownPaths).toEqual([
      ".github/instructions/conditional.instructions.md",
      "AGENTS.md",
      "src/AGENTS.md",
    ]);
    expect(pair?.scope.reasonCodes).toContain("conditional-activation");
    expect(pair?.ordering).toMatchObject({
      reasonCodes: ["fewer-than-two-common-included-paths"],
      state: "not-applicable",
    });
    expect(pair?.content).toMatchObject({
      reasonCodes: ["no-common-included-paths"],
      state: "not-applicable",
    });
    expect(result.analysisStatus).toBe("partial");
  });

  test("keeps IDE and CLI surface contracts separate when both scopes are incomplete", () => {
    const result = compare([
      cursorConditional("cursor-agent/ide", ".cursor/rules/ide.mdc"),
      cursorConditional("cursor-agent/cli", ".cursor/rules/cli.mdc"),
    ]);
    const pair = result.pairs[0];

    expect(pair?.semanticRelation).toBe("distinct-surface-contracts");
    expect(pair?.equivalenceClaim).toBe(false);
    expect(pair?.scope).toMatchObject({
      reasonCodes: ["conditional-activation", "left-scope-incomplete", "right-scope-incomplete"],
      state: "unknown",
      unknownPaths: [".cursor/rules/cli.mdc", ".cursor/rules/ide.mdc"],
    });
  });

  test("does not compare partial profile order as total", () => {
    const codexResult = codex(
      [
        { content: "Root.\n", path: "CLAUDE.md" },
        { content: "App.\n", path: "src/CLAUDE.md" },
      ],
      path("src/main.ts"),
      { fallbacks: ["CLAUDE.md"] },
    );
    const result = compare([codexResult, claudePartialOrder()]);
    const ordering = result.pairs[0]?.ordering;

    expect(ordering?.commonIncludedPaths).toEqual(["CLAUDE.md", "src/CLAUDE.md"]);
    expect(ordering?.state).toBe("unknown");
    expect(ordering?.reasonCodes).toEqual(
      expect.arrayContaining([expect.stringMatching(/order-not-total$/u)]),
    );
    expect(ordering?.witness).toBeNull();
  });

  test("keeps unreadable content and matching truncated prefixes unknown", async () => {
    const unreadable = codex(
      [{ content: "not available", path: "AGENTS.md" }],
      path("src/main.ts"),
      { unreadablePaths: new Set(["AGENTS.md"]) },
    );
    const unreadableComparison = compare([unreadable, await gemini({ "AGENTS.md": "Visible.\n" })]);
    expect(
      unreadableComparison.profiles.find((profile) => profile.profileId === "codex-cli")?.counts,
    ).toMatchObject({ included: 1, unavailableContent: 1 });
    expect(unreadableComparison.pairs[0]?.content).toMatchObject({
      state: "unknown",
      unknownPaths: ["AGENTS.md"],
    });
    expect(unreadableComparison.pairs[0]?.content.reasonCodes).toEqual(
      expect.arrayContaining([expect.stringMatching(/content-incomplete$/u)]),
    );

    const truncated = codex(
      [{ content: "Prefix and remainder", path: "AGENTS.md" }],
      path("src/main.ts"),
      { maximumBytes: 6 },
    );
    const prefixComparison = compare([truncated, await gemini({ "AGENTS.md": "Prefix" })]);
    expect(prefixComparison.pairs[0]?.content).toMatchObject({
      reasonCodes: ["truncated-content-prefix"],
      state: "unknown",
      unknownPaths: ["AGENTS.md"],
    });
  });

  test("counts recognized exclusions separately from absent paths", async () => {
    const withShadow = codex(
      [
        { content: "Root.\n", path: "AGENTS.md" },
        { content: "Shadow.\n", path: "FALLBACK.md" },
      ],
      path("src/main.ts"),
      { fallbacks: ["FALLBACK.md"] },
    );
    const result = compare([withShadow, await gemini({ "AGENTS.md": "Root.\n" })]);

    expect(
      result.profiles.find((profile) => profile.profileId === "codex-cli")?.counts.excluded,
    ).toBe(1);
    const difference = result.pairs[0]?.scope.differences.find(
      (entry) => entry.path === "FALLBACK.md",
    );
    expect(difference).toBeDefined();
    expect(new Set([difference?.leftState, difference?.rightState])).toEqual(
      new Set(["absent", "excluded"]),
    );
  });

  test("is deterministic across input order and accounts for every pair", async () => {
    const profiles = [codex(), await gemini(), copilotConditional()] as const;
    const forward = compare(profiles);
    const reverse = compare([...profiles].reverse());

    expect(reverse).toEqual(forward);
    expect(forward.profiles).toHaveLength(3);
    expect(forward.pairs).toHaveLength(3);
    expect(new Set(forward.pairs.map((pair) => pair.id))).toHaveLength(3);
  });

  test("rejects forged, duplicate, cross-target, sparse, extended, and hostile inputs", async () => {
    const codexResult = codex();
    const geminiResult = await gemini();
    expect(() => compare([structuredClone(codexResult), geminiResult])).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }),
    );
    expect(() => compare([codexResult, codexResult])).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidRelationship }),
    );
    expect(() => compare([codexResult, codex()])).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidRelationship }),
    );
    expect(() => compare([codexResult, codex([], path("other.ts"))])).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidRelationship }),
    );

    const sparse = new Array<EffectiveContextResolution>(2);
    sparse[0] = codexResult;
    expect(() =>
      compareEffectiveContexts({
        contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
        recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
        resolutions: sparse,
      }),
    ).toThrow(expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }));

    const extended = [codexResult, geminiResult] as EffectiveContextResolution[] & { extra?: true };
    extended.extra = true;
    expect(() => compare(extended)).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }),
    );

    const accessor = vi.fn();
    const hostile = Object.defineProperty({}, "contractVersion", {
      enumerable: true,
      get: accessor,
    });
    expect(() => compareEffectiveContexts(hostile as never)).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }),
    );
    expect(accessor).not.toHaveBeenCalled();
    const exactAccessor = {
      recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
      resolutions: [codexResult, geminiResult],
    } as Record<string, unknown>;
    Object.defineProperty(exactAccessor, "contractVersion", {
      enumerable: true,
      get: accessor,
    });
    expect(() => compareEffectiveContexts(exactAccessor as never)).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }),
    );
    expect(accessor).not.toHaveBeenCalled();
    expect(() => compareEffectiveContexts(new Proxy({}, {}) as never)).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }),
    );
    expect(() => compareEffectiveContexts(null as never)).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }),
    );
    expect(() => compareEffectiveContexts([] as never)).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }),
    );
    expect(() => compareEffectiveContexts(Object.create(null) as never)).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }),
    );
    expect(() =>
      compareEffectiveContexts({
        contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
        recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
        resolutions: null,
      } as never),
    ).toThrow(expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }));

    const hiddenEntry = [codexResult, geminiResult];
    Object.defineProperty(hiddenEntry, "1", {
      configurable: true,
      enumerable: false,
      value: geminiResult,
      writable: true,
    });
    expect(() => compare(hiddenEntry)).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }),
    );
  });

  test("enforces closed identity, cardinality, and profile resource limits", async () => {
    const codexResult = codex();
    const geminiResult = await gemini();
    expect(() =>
      compareEffectiveContexts({
        contractVersion: "1.0.0",
        recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
        resolutions: [codexResult, geminiResult],
      } as never),
    ).toThrow(expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }));
    expect(() =>
      compareEffectiveContexts({
        contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
        recordKind: "wrong-kind",
        resolutions: [codexResult, geminiResult],
      } as never),
    ).toThrow(expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }));
    expect(() =>
      compareEffectiveContexts({
        contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
        extra: true,
        recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
        resolutions: [codexResult, geminiResult],
      } as never),
    ).toThrow(expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidInput }));
    expect(() => compare([codexResult])).toThrow(
      expect.objectContaining({ code: CrossProfileComparisonErrorCode.invalidRelationship }),
    );
    expect(() =>
      compare(
        Array.from(
          { length: CROSS_PROFILE_COMPARISON_LIMITS.maximumProfiles + 1 },
          () => codexResult,
        ),
      ),
    ).toThrow(expect.objectContaining({ code: CrossProfileComparisonErrorCode.resourceLimit }));
  });
});
