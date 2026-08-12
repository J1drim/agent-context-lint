import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "@agent-context/core";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  loadImportGraph,
  type ReadOnlyRepository,
} from "@agent-context/evidence";
import type { GeminiSettingsLayerInput } from "@agent-context/syntax";
import { describe, expect, test } from "vitest";

import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  EffectiveContextError,
  EffectiveContextErrorCode,
  buildDocumentImportDag,
  createSyntheticTargetTrace,
  isIssuedEffectiveContextResolution,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveCopilotProfile,
  resolveCursorProfile,
  resolveEffectiveContext,
  resolveGeminiCliContext,
  type ClaudeInstructionCandidateSnapshot,
  type CodexCliAgentsResolution,
  type CursorRuleCandidateSnapshot,
  type DocumentImportDag,
  type EffectiveContextResolution,
  type EffectiveContextProfileResolution,
  type GeminiCliCandidateSnapshot,
} from "../src/index.js";

const encoder = new TextEncoder();

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function resolve(
  profileResolution: EffectiveContextProfileResolution,
  targetPath = path("src/main.ts"),
  importDags: readonly DocumentImportDag[] = [],
): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags,
    profileResolution,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath,
  });
}

function codex(
  options: {
    readonly entries?: readonly { readonly content: string; readonly path: string }[];
    readonly fallbacks?: readonly string[];
    readonly maximumBytes?: number;
  } = {},
): CodexCliAgentsResolution {
  return resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: (
        options.entries ?? [
          { content: "Root policy.\n", path: "AGENTS.md" },
          { content: "App policy.\n", path: "src/AGENTS.md" },
        ]
      ).map((entry) => ({
        bytes: encoder.encode(entry.content),
        errorCode: null,
        kind: "file" as const,
        path: path(entry.path),
        resolvedTarget: null,
      })),
      reason: "complete synthetic snapshot",
      rootMarkerPaths: [path(".git")],
    },
    externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("src"),
    settings: {
      projectDocFallbackFilenames: options.fallbacks ?? [],
      projectDocMaxBytes: options.maximumBytes ?? 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath: path("src/main.ts"),
  });
}

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/synthetic",
    inspect: () => Promise.reject(new Error("not used")),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const sourcePath = path(String(value));
      const source = sources[sourcePath];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "missing synthetic source",
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

function claudeCandidate(
  candidatePath: string,
  kind: ClaudeInstructionCandidateSnapshot["kind"],
  source: string,
): ClaudeInstructionCandidateSnapshot {
  return {
    absolutePath: `/repo/${candidatePath}`,
    bytes: encoder.encode(source),
    importGraph: null,
    kind,
    origin: "repository",
    path: path(candidatePath),
    scopeRoot: path("."),
    symlinkState: "none",
  };
}

function geminiCandidate(
  value: string,
  kind: GeminiCliCandidateSnapshot["kind"] = "file",
): GeminiCliCandidateSnapshot {
  return { identity: `${kind}:${value}`, ignoredBy: [], kind, path: path(value) };
}

function geminiSettings(context: Record<string, unknown> = {}): GeminiSettingsLayerInput {
  return {
    bytes: encoder.encode(JSON.stringify({ context })),
    kind: "workspace",
    path: path(".gemini/settings.json"),
    trustState: "trusted",
  };
}

function cursorCandidate(candidatePath: string, source: string): CursorRuleCandidateSnapshot {
  return { bytes: encoder.encode(source), format: "mdc", path: path(candidatePath) };
}

describe("E05 effective-context resolution", () => {
  test("reconstructs Codex load order, shadowing, semantic ambiguity, and exact assembly", () => {
    const profile = codex({
      entries: [
        { content: "Root.\n", path: "AGENTS.md" },
        { content: "Ignored fallback.\n", path: "FALLBACK.md" },
        { content: "App.\n", path: "src/AGENTS.md" },
      ],
      fallbacks: ["FALLBACK.md"],
    });
    const result = resolve(profile);

    expect(result.sequence).toEqual(
      result.documents.filter((entry) => entry.state === "effective").map((entry) => entry.id),
    );
    expect(result.documents.map((entry) => [entry.path, entry.state])).toEqual([
      ["AGENTS.md", "effective"],
      ["FALLBACK.md", "shadowed"],
      ["src/AGENTS.md", "effective"],
    ]);
    expect(result.assembly).toMatchObject({ state: "exact", text: "Root.\n\n\nApp.\n" });
    expect(result.precedence).toHaveLength(1);
    expect(result.conflicts).toMatchObject([{ precedence: "semantic-winner-unknown" }]);
    expect(result.ambiguities).toContainEqual(
      expect.objectContaining({ kind: "semantic-precedence" }),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ambiguities)).toBe(true);
    expect(isIssuedEffectiveContextResolution(result)).toBe(true);
    expect(isIssuedEffectiveContextResolution(structuredClone(result))).toBe(false);
    expect(isIssuedEffectiveContextResolution(new Proxy(result, {}))).toBe(false);
  });

  test("keeps Codex byte truncation and empty prefixes explicit", () => {
    const truncated = resolve(codex({ maximumBytes: 4 }));
    expect(truncated.documents[0]).toMatchObject({
      availableBytes: 13,
      contentState: "truncated-prefix",
      includedBytes: 4,
      truncation: "prefix",
    });
    expect(truncated.ambiguities).toContainEqual(expect.objectContaining({ kind: "truncation" }));

    const empty = resolve(
      codex({ entries: [{ content: "   more", path: "AGENTS.md" }], maximumBytes: 2 }),
    );
    expect(empty.documents[0]).toMatchObject({
      contentState: "truncated-prefix",
      state: "empty",
      truncation: "prefix",
    });
  });

  test("keeps Codex uncertain selection, unavailable content, and external context explicit", () => {
    const conditionalProfile = resolveCodexCliAgents({
      discovery: {
        certainty: "uncertain",
        entries: [
          {
            bytes: null,
            errorCode: null,
            kind: "unknown",
            path: path("AGENTS.md"),
            resolvedTarget: null,
          },
          {
            bytes: encoder.encode("Fallback.\n"),
            errorCode: null,
            kind: "file",
            path: path("FALLBACK.md"),
            resolvedTarget: null,
          },
        ],
        reason: "incomplete inventory",
        rootMarkerPaths: [path(".git")],
      },
      externalContext: { mode: "unavailable" },
      launchCwd: path("."),
      settings: {
        projectDocFallbackFilenames: ["FALLBACK.md"],
        projectDocMaxBytes: 32_768,
        projectRootMarkers: [".git"],
      },
      targetPath: path("src/main.ts"),
    });
    const result = resolve(conditionalProfile);

    expect(result.documents.map((entry) => [entry.state, entry.contentState])).toEqual([
      ["conditional", "unavailable"],
      ["conditional", "identity-only"],
    ]);
    expect(result.ordering).toBe("partial");
    expect(result.ambiguities.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["activation", "external-context", "partial-profile"]),
    );
  });

  test("retains Claude's partial order, conditional activation, and unresolved sibling order", () => {
    const profile = resolveClaudeCodeProfile({
      candidates: [
        claudeCandidate("CLAUDE.md", "memory-shared", "Root memory.\n"),
        claudeCandidate("src/CLAUDE.md", "memory-shared", "Child memory.\n"),
        claudeCandidate(
          ".claude/rules/typescript.md",
          "project-rule",
          "---\npaths:\n  - 'src/**/*.ts'\n---\nTypeScript.\n",
        ),
        claudeCandidate(".claude/CLAUDE.md", "memory-alternate", "Alternate.\n"),
      ],
      launchCwd: path("src"),
      repositoryRoot: path("."),
      runtime: {
        additionalDirectoryInstructions: "disabled",
        clientVersion: "2.1.217",
        eventTrace: [{ id: "launch", kind: "launch", path: path("src") }],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "supplied",
        mode: "normal",
        settingSources: { state: "known", values: ["local", "managed", "project", "user"] },
      },
    });
    const result = resolve(profile);

    expect(result.precedence.length).toBeGreaterThan(0);
    expect(result.ordering).toBe("partial");
    expect(result.assembly.state).toBe("partial");
    expect(result.ambiguities).toContainEqual(expect.objectContaining({ kind: "precedence" }));
    expect(() => resolve(structuredClone(profile))).toThrow(
      expect.objectContaining({ code: EffectiveContextErrorCode.invalidInput }),
    );
  });

  test("projects Claude inactive and unknown-runtime candidates conservatively", () => {
    const profile = resolveClaudeCodeProfile({
      candidates: [
        claudeCandidate("CLAUDE.md", "memory-shared", "Memory.\n"),
        claudeCandidate(".claude/rules/unknown.md", "project-rule", "Rule.\n"),
      ],
      launchCwd: path("."),
      repositoryRoot: path("."),
      runtime: {
        additionalDirectoryInstructions: "disabled",
        clientVersion: "2.1.217",
        eventTrace: [{ id: "launch", kind: "launch", path: path(".") }],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "unavailable",
        mode: "normal",
        settingSources: { state: "unknown", values: [] },
      },
    });
    const result = resolve(profile);

    expect(result.documents.map((entry) => entry.activation)).toContain("indeterminate");
    expect(result.ambiguities.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["activation", "external-context"]),
    );
  });

  test("does not invent Copilot description activation or general precedence", () => {
    const profile = resolveCopilotProfile({
      candidates: [
        {
          bytes: encoder.encode("---\ndescription: 'Use for APIs'\n---\nAPI policy.\n"),
          format: "path-specific",
          path: path(".github/instructions/api.instructions.md"),
        },
        {
          bytes: encoder.encode("Repository policy.\n"),
          format: "repository-wide",
          path: path(".github/copilot-instructions.md"),
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
    });
    const result = resolve(profile);

    expect(result.documents.map((entry) => entry.activation)).toContain("indeterminate");
    expect(result.ordering).toBe("unordered");
    expect(result.conflicts[0]?.precedence).toBe("unknown-activation");
    expect(result.ambiguities.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["activation", "precedence"]),
    );
    expect(() => resolve(structuredClone(profile))).toThrow(
      expect.objectContaining({ code: EffectiveContextErrorCode.invalidInput }),
    );
  });

  test("projects a single active Copilot document and an inactive document without conflicts", () => {
    const profile = resolveCopilotProfile({
      candidates: [
        {
          bytes: encoder.encode("Repository.\n"),
          format: "repository-wide",
          path: path(".github/copilot-instructions.md"),
        },
        {
          bytes: encoder.encode("---\napplyTo: 'test/**'\n---\nTests.\n"),
          format: "path-specific",
          path: path(".github/instructions/test.instructions.md"),
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
    });
    const result = resolve(profile);
    expect(result.ordering).toBe("total");
    expect(result.documents.map((entry) => entry.activation)).toEqual(["active", "inactive"]);
    expect(result.conflicts).toEqual([]);

    const unprofiledTarget = resolve(profile, path("other/main.ts"));
    expect(unprofiledTarget.documents.every((entry) => entry.activation === "indeterminate")).toBe(
      true,
    );
    expect(unprofiledTarget.ambiguities).toContainEqual(
      expect.objectContaining({ kind: "target-scope", reasonCode: "copilot-target-not-profiled" }),
    );
  });

  test("preserves Gemini's observed startup/JIT order without fabricating assembled text", async () => {
    const sources = { "GEMINI.md": "Root.\n", "src/GEMINI.md": "Child.\n" };
    const profile = await resolveGeminiCliContext({
      boundaryMarkerDirectories: [path(".")],
      candidates: [
        geminiCandidate(".", "directory"),
        geminiCandidate("src", "directory"),
        geminiCandidate("GEMINI.md"),
        geminiCandidate("src/GEMINI.md"),
        geminiCandidate("src/main.ts"),
      ],
      events: [
        { id: "launch", kind: "launch", path: path(".") },
        { id: "read", kind: "read-path", path: path("src/main.ts") },
      ],
      externalContext: "unavailable",
      repository: repository(sources),
      settingsLayers: [geminiSettings()],
      trustState: "trusted",
      workspaceRoots: [path(".")],
    });
    const result = resolve(profile);

    expect(result.documents.map((entry) => entry.path)).toEqual(["GEMINI.md", "src/GEMINI.md"]);
    expect(result.ordering).toBe("total");
    expect(result.precedence).toHaveLength(1);
    expect(result.assembly).toMatchObject({ state: "partial", text: null });
    expect(() => resolve(structuredClone(profile))).toThrow(
      expect.objectContaining({ code: EffectiveContextErrorCode.invalidInput }),
    );
  });

  test("retains Gemini load failures and issue paths as unavailable context", async () => {
    const profile = await resolveGeminiCliContext({
      boundaryMarkerDirectories: [path(".")],
      candidates: [geminiCandidate(".", "directory"), geminiCandidate("GEMINI.md", "unavailable")],
      events: [{ id: "launch", kind: "launch", path: path(".") }],
      externalContext: "explicit-synthetic",
      repository: repository({}),
      settingsLayers: [geminiSettings()],
      trustState: "trusted",
      workspaceRoots: [path(".")],
    });
    const result = resolve(profile);
    expect(result.documents[0]).toMatchObject({
      activation: "indeterminate",
      contentState: "unavailable",
    });
    expect(result.ambiguities.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["activation", "partial-profile"]),
    );
  });

  test("preserves Cursor activation channels and makes a multi-target trace target-ambiguous", () => {
    const profile = resolveCursorProfile({
      candidates: [
        cursorCandidate(".cursor/rules/always.mdc", "---\nalwaysApply: true\n---\nAlways.\n"),
        cursorCandidate(".cursor/rules/auto.mdc", "---\nglobs: 'src/**/*.ts'\n---\nAuto.\n"),
      ],
      runtime: {
        clientVersion: "3.12.30",
        eventState: "present",
        events: [
          { kind: "read-path", sequence: 1, targetPath: path("src/main.ts") },
          { kind: "read-path", sequence: 2, targetPath: path("test/main.ts") },
        ],
        externalContext: "absent",
        projectRules: "enabled",
        surfaceId: "cursor-agent/ide",
        workspaceRoots: [path(".")],
      },
    });
    const result = resolve(profile);

    expect(result.documents.every((entry) => entry.activation === "indeterminate")).toBe(true);
    expect(result.ordering).toBe("unknown");
    expect(result.ambiguities).toContainEqual(
      expect.objectContaining({ kind: "target-scope", reasonCode: "cursor-multi-target-trace" }),
    );
    expect(() => resolve(structuredClone(profile))).toThrow(
      expect.objectContaining({ code: EffectiveContextErrorCode.invalidInput }),
    );
  });

  test("uses Cursor's single-target activation and retains external/reference ambiguity", () => {
    const profile = resolveCursorProfile({
      candidates: [
        cursorCandidate(
          ".cursor/rules/auto.mdc",
          "---\nalwaysApply: false\nglobs: '**/*.ts'\n---\nSee [policy](docs/policy.md).\n",
        ),
      ],
      runtime: {
        clientVersion: "3.12.30",
        eventState: "present",
        events: [{ kind: "reference-path", sequence: 1, targetPath: path("src/main.ts") }],
        externalContext: "present",
        projectRules: "enabled",
        surfaceId: "cursor-agent/ide",
        workspaceRoots: [path(".")],
      },
    });
    const result = resolve(profile);
    expect(result.documents[0]?.activation).toBe("indeterminate");
    expect(result.ambiguities.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["activation", "external-context"]),
    );
  });

  test("projects E04 ordered import occurrences and partial states without reading imported text", async () => {
    const importGraph = await loadImportGraph({
      entryPath: path("AGENTS.md"),
      repository: repository({ "AGENTS.md": "@a.md\n@a.md\n", "a.md": "Imported.\n" }),
      syntax: "claude-code",
    });
    const dag = buildDocumentImportDag({
      graph: importGraph,
      trace: createSyntheticTargetTrace({
        launchCwd: path("."),
        purpose: "effective-context-test",
        targetPath: path("src/main.ts"),
        workspaceRoots: [path(".")],
      }),
    });
    const result = resolve(
      codex({ entries: [{ content: "@a.md\n@a.md\n", path: "AGENTS.md" }] }),
      path("src/main.ts"),
      [dag],
    );

    expect(result.occurrences.map((entry) => entry.state)).toEqual([
      "entry",
      "loaded",
      "already-loaded",
    ]);
    expect(result.occurrences[1]?.contentId).toBe(result.occurrences[2]?.contentId);
    expect(result.occurrences[1]?.id).not.toBe(result.occurrences[2]?.id);
  });

  test("projects partial E04 import failures as import ambiguity", async () => {
    const importGraph = await loadImportGraph({
      entryPath: path("AGENTS.md"),
      repository: repository({ "AGENTS.md": "@missing.md\n" }),
      syntax: "claude-code",
    });
    const dag = buildDocumentImportDag({
      graph: importGraph,
      trace: createSyntheticTargetTrace({
        launchCwd: path("."),
        purpose: "effective-context-test",
        targetPath: path("src/main.ts"),
        workspaceRoots: [path(".")],
      }),
    });
    const result = resolve(
      codex({ entries: [{ content: "@missing.md\n", path: "AGENTS.md" }] }),
      path("src/main.ts"),
      [dag],
    );
    expect(result.occurrences.map((entry) => entry.state)).toEqual(["entry", "unavailable"]);
    expect(result.ambiguities).toContainEqual(
      expect.objectContaining({ kind: "import-resolution" }),
    );
  });

  test("is deterministic and rejects forged profile/DAG records, accessors, proxies, and relationships", async () => {
    const profile = codex();
    const first = resolve(profile);
    expect(JSON.stringify(resolve(profile))).toBe(JSON.stringify(first));

    const forged = structuredClone(profile);
    expect(() => resolve(forged)).toThrow(
      expect.objectContaining({ code: EffectiveContextErrorCode.invalidInput }),
    );
    expect(() => resolveEffectiveContext(new Proxy({}, {}))).toThrow(EffectiveContextError);
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "recordKind", { enumerable: true, get: () => "boom" });
    expect(() => resolveEffectiveContext(accessor)).toThrow(EffectiveContextError);

    const graph = await loadImportGraph({
      entryPath: path("AGENTS.md"),
      repository: repository({ "AGENTS.md": "plain\n" }),
      syntax: "claude-code",
    });
    const dag = buildDocumentImportDag({
      graph,
      trace: createSyntheticTargetTrace({
        launchCwd: path("."),
        purpose: "effective-context-test",
        targetPath: path("src/main.ts"),
        workspaceRoots: [path(".")],
      }),
    });
    expect(() => resolve(profile, path("src/main.ts"), [structuredClone(dag)])).toThrow(
      expect.objectContaining({ code: EffectiveContextErrorCode.invalidInput }),
    );
    expect(() => resolve(profile, path("different.ts"))).toThrow(
      expect.objectContaining({ code: EffectiveContextErrorCode.invalidRelationship }),
    );
  });

  test("rejects closed-input violations and a sparse DAG list", () => {
    const profile = codex();
    const base = {
      contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
      importDags: [],
      profileResolution: profile,
      recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
      targetPath: path("src/main.ts"),
    };
    expect(() => resolveEffectiveContext({ ...base, extra: true })).toThrow(EffectiveContextError);
    expect(() => resolveEffectiveContext({ ...base, contractVersion: "9" })).toThrow(
      EffectiveContextError,
    );
    const sparse = new Array(1) as DocumentImportDag[];
    expect(() => resolveEffectiveContext({ ...base, importDags: sparse })).toThrow(
      EffectiveContextError,
    );
    const hidden = [...base.importDags];
    Object.defineProperty(hidden, "0", { enumerable: false, value: undefined });
    expect(() => resolveEffectiveContext({ ...base, importDags: hidden })).toThrow(
      EffectiveContextError,
    );
    const excessive = new Array(4_097).fill(null);
    expect(() => resolveEffectiveContext({ ...base, importDags: excessive })).toThrow(
      expect.objectContaining({ code: EffectiveContextErrorCode.resourceLimit }),
    );
    for (const malformed of [
      null,
      [],
      Object.create({}),
      { ...base, importDags: null },
      { ...base, profileResolution: { recordKind: "unsupported" } },
      { ...base, targetPath: "../outside" },
    ]) {
      expect(() => resolveEffectiveContext(malformed)).toThrow(EffectiveContextError);
    }
  });

  test("is inventory-order invariant for profiles whose precedence is unknown", () => {
    const candidates = [
      cursorCandidate(".cursor/rules/c.mdc", "---\nalwaysApply: true\n---\nC.\n"),
      cursorCandidate(".cursor/rules/a.mdc", "---\nalwaysApply: true\n---\nA.\n"),
      cursorCandidate(".cursor/rules/b.mdc", "---\nalwaysApply: true\n---\nB.\n"),
    ] as const;
    const runtime = {
      clientVersion: "3.12.30",
      eventState: "present" as const,
      events: [{ kind: "read-path" as const, sequence: 1, targetPath: path("src/main.ts") }],
      externalContext: "absent" as const,
      projectRules: "enabled" as const,
      surfaceId: "cursor-agent/ide" as const,
      workspaceRoots: [path(".")],
    };
    const permutations = [
      candidates,
      [candidates[1], candidates[2], candidates[0]],
      [...candidates].reverse(),
    ];
    const results = permutations.map((items) =>
      resolve(resolveCursorProfile({ candidates: items, runtime })),
    );
    const canonical = JSON.stringify({
      conflicts: results[0]?.conflicts,
      documents: results[0]?.documents,
      sequence: results[0]?.sequence,
    });
    for (const result of results.slice(1))
      expect(
        JSON.stringify({
          conflicts: result.conflicts,
          documents: result.documents,
          sequence: result.sequence,
        }),
      ).toBe(canonical);
  });

  test("fails closed before materializing an unbounded conflict matrix", () => {
    const candidates = Array.from({ length: 363 }, (_, index) =>
      cursorCandidate(
        `.cursor/rules/r${index.toString().padStart(3, "0")}.mdc`,
        "---\nalwaysApply: true\n---\nPolicy.\n",
      ),
    );
    const profile = resolveCursorProfile({
      candidates,
      runtime: {
        clientVersion: "3.12.30",
        eventState: "present",
        events: [{ kind: "read-path", sequence: 1, targetPath: path("src/main.ts") }],
        externalContext: "absent",
        projectRules: "enabled",
        surfaceId: "cursor-agent/ide",
        workspaceRoots: [path(".")],
      },
    });
    expect(() => resolve(profile)).toThrow(
      expect.objectContaining({ code: EffectiveContextErrorCode.resourceLimit }),
    );
  });
});
