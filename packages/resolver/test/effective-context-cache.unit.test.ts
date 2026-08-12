import {
  canonicalizeRepositoryRelativePath,
  DEFAULT_AGENT_CONTEXT_CONFIGURATION,
  type AgentContextConfiguration,
  type RepositoryRelativePath,
} from "@agent-context/core";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  loadImportGraph,
  type ReadOnlyRepository,
  type WorkspaceBoundary,
} from "@agent-context/evidence";
import { describe, expect, test } from "vitest";

import {
  EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  EffectiveContextCacheError,
  EffectiveContextCacheErrorCode,
  EffectiveContextMemoizationCache,
  buildDocumentImportDag,
  createSyntheticTargetTrace,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveCopilotProfile,
  resolveCursorProfile,
  resolveGeminiCliContext,
  sampleTargets,
  type CodexCliAgentsResolution,
  type EffectiveContextCacheDocumentSnapshot,
  type EffectiveContextCacheOptions,
  type EffectiveContextCacheRequest,
  type EffectiveContextProfileResolution,
  type TargetSamplingResult,
} from "../src/index.js";

const encoder = new TextEncoder();

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

interface Source {
  readonly content: string;
  readonly path: RepositoryRelativePath;
}

function codex(
  sources: readonly Source[] = [
    { content: "Root policy.\n", path: path("AGENTS.md") },
    { content: "Source policy.\n", path: path("src/AGENTS.md") },
  ],
  targetPath = path("src/main.ts"),
): CodexCliAgentsResolution {
  return resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: sources.map((source) => ({
        bytes: encoder.encode(source.content),
        errorCode: null,
        kind: "file" as const,
        path: source.path,
        resolvedTarget: null,
      })),
      reason: "complete cache fixture",
      rootMarkerPaths: [path(".git")],
    },
    externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("src"),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath,
  });
}

function workspace(root: RepositoryRelativePath): WorkspaceBoundary {
  return {
    evidencePath: path(root === "." ? "package.json" : `${root}/package.json`),
    family: "javascript-package",
    kind: "workspace",
    languages: ["javascript"],
    root,
  };
}

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/cache-unit",
    inspect: () => Promise.reject(new Error("not used")),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const selected = path(String(value));
      const source = sources[selected];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "fixture unavailable",
          "read-file",
          selected,
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          selected,
          encoder.encode(source),
          { device: "fixture", inode: selected },
          0,
        ),
      );
    },
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
}

function sampling(
  selectedPath = path("src/main.ts"),
  extras: readonly RepositoryRelativePath[] = [],
): TargetSamplingResult {
  const paths = [selectedPath, ...extras];
  return sampleTargets({
    activationObservations: paths.map((sourcePath) => ({
      path: sourcePath,
      states: [{ ruleId: "rule:agents", state: "active" }],
    })),
    criticalPaths: [],
    paths,
    trackingCertainty: "tracked",
    trackingReason: "verified-git-index",
    workspaceBoundaries: [workspace(path("."))],
    workspaceUncertainty: "known",
    workspaceUncertaintyReasons: [],
  });
}

function dependency(source: Source, generation = "1"): EffectiveContextCacheDocumentSnapshot {
  return {
    bytes: encoder.encode(source.content),
    identity: { device: "fixture", inode: `${source.path}:${generation}` },
    path: source.path,
    state: "available",
  };
}

function configuration(
  overrides: Partial<AgentContextConfiguration> = {},
): AgentContextConfiguration {
  return {
    ...structuredClone(DEFAULT_AGENT_CONTEXT_CONFIGURATION),
    ...overrides,
  };
}

function request(
  options: {
    readonly configuration?: AgentContextConfiguration;
    readonly configurationGeneration?: string;
    readonly documents?: readonly EffectiveContextCacheDocumentSnapshot[];
    readonly profile?: EffectiveContextProfileResolution;
    readonly samples?: TargetSamplingResult;
    readonly sources?: readonly Source[];
    readonly targetPath?: RepositoryRelativePath;
  } = {},
): EffectiveContextCacheRequest {
  const sources =
    options.sources ??
    ([
      { content: "Root policy.\n", path: path("AGENTS.md") },
      { content: "Source policy.\n", path: path("src/AGENTS.md") },
    ] as const);
  const targetPath = options.targetPath ?? path("src/main.ts");
  return {
    configuration: options.configuration ?? configuration(),
    configurationIdentity: {
      device: "fixture",
      inode: `configuration:${options.configurationGeneration ?? "1"}`,
    },
    context: {
      contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
      importDags: [],
      profileResolution: options.profile ?? codex(sources, targetPath),
      recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
      targetPath,
    },
    contractVersion: EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION,
    documents: options.documents ?? sources.map((source) => dependency(source)),
    recordKind: EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND,
    sampling: options.samples ?? sampling(targetPath),
    targetIdentity: { device: "fixture", inode: targetPath },
  };
}

describe("E09 effective-context memoization", () => {
  test("returns the exact issued E05 result on a content-addressed warm hit", () => {
    const cache = new EffectiveContextMemoizationCache();
    const firstRequest = request();
    const cold = cache.resolve(firstRequest);
    const warm = cache.resolve(
      request({ profile: codex(), samples: sampling(path("src/main.ts")) }),
    );

    expect(warm).toBe(cold);
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
    expect(cache.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
    expect(Object.isFrozen(warm)).toBe(true);
    expect(cache.key(firstRequest)).toEqual(cache.key(request()));
  });

  test("invalidates independently on semantic configuration and configuration identity changes", () => {
    const cache = new EffectiveContextMemoizationCache();
    const base = request();
    const changedConfiguration = configuration({
      ...configuration(),
      commands: { packageManager: "pnpm" },
    });

    const baseKey = cache.key(base);
    const valueKey = cache.key(request({ configuration: changedConfiguration }));
    const identityKey = cache.key(request({ configurationGeneration: "2" }));

    expect(valueKey.configurationSha256).not.toBe(baseKey.configurationSha256);
    expect(valueKey.sourceIdentitySha256).toBe(baseKey.sourceIdentitySha256);
    expect(identityKey.configurationSha256).toBe(baseKey.configurationSha256);
    expect(identityKey.sourceIdentitySha256).not.toBe(baseKey.sourceIdentitySha256);
    expect(new Set([baseKey.sha256, valueKey.sha256, identityKey.sha256])).toHaveLength(3);
  });

  test("invalidates content and source identity separately while retaining target/profile/spec keys", () => {
    const cache = new EffectiveContextMemoizationCache();
    const sources = [
      { content: "Root policy.\n", path: path("AGENTS.md") },
      { content: "Source policy.\n", path: path("src/AGENTS.md") },
    ] as const;
    const contentSources = [sources[0], { ...sources[1], content: "Changed policy.\n" }];
    const base = cache.key(request({ sources }));
    const content = cache.key(request({ sources: contentSources }));
    const identityDocuments = sources.map((source) => dependency(source, "2"));
    const sourceIdentity = cache.key(request({ documents: identityDocuments, sources }));
    const targetIdentity = cache.key({
      ...request({ sources }),
      targetIdentity: { device: "fixture", inode: "src/main.ts:2" },
    });

    expect(content.dependencySha256).not.toBe(base.dependencySha256);
    expect(content.profileResolutionSha256).not.toBe(base.profileResolutionSha256);
    expect(sourceIdentity.dependencySha256).toBe(base.dependencySha256);
    expect(sourceIdentity.profileResolutionSha256).toBe(base.profileResolutionSha256);
    expect(sourceIdentity.sourceIdentitySha256).not.toBe(base.sourceIdentitySha256);
    expect(targetIdentity.dependencySha256).toBe(base.dependencySha256);
    expect(targetIdentity.profileResolutionSha256).toBe(base.profileResolutionSha256);
    expect(targetIdentity.sourceIdentitySha256).not.toBe(base.sourceIdentitySha256);
    expect(content.targetPath).toBe(base.targetPath);
    expect(content.profileId).toBe(base.profileId);
    expect(content.profileVersion).toBe(base.profileVersion);
    expect(content.specSnapshotId).toBe(base.specSnapshotId);
  });

  test("uses only the selected target's E08 proof, not unrelated sampled targets", () => {
    const cache = new EffectiveContextMemoizationCache();
    const one = cache.key(request({ samples: sampling(path("src/main.ts")) }));
    const many = cache.key(
      request({ samples: sampling(path("src/main.ts"), [path("src/other.ts")]) }),
    );

    expect(many.samplingSha256).toBe(one.samplingSha256);
    expect(many.sha256).toBe(one.sha256);
  });

  test("keeps addresses order-invariant and content-sensitive across a deterministic property corpus", () => {
    const cache = new EffectiveContextMemoizationCache();
    const addresses = new Set<string>();
    for (let index = 0; index < 32; index += 1) {
      const sources = [
        { content: `Root ${String(index)}.\n`, path: path("AGENTS.md") },
        { content: `Source ${String(index % 7)}.\n`, path: path("src/AGENTS.md") },
      ];
      const forward = request({ sources });
      const reverse: EffectiveContextCacheRequest = {
        ...forward,
        documents: [...forward.documents].reverse(),
      };
      const forwardKey = cache.key(forward);
      expect(cache.key(reverse)).toEqual(forwardKey);
      expect(cache.key(request({ sources }))).toEqual(forwardKey);
      addresses.add(forwardKey.sha256);
    }
    expect(addresses).toHaveLength(32);
  });

  test("preserves unknown and ambiguous E05 state through warm reuse", () => {
    const profile = resolveCodexCliAgents({
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
        ],
        reason: "incomplete inventory",
        rootMarkerPaths: [path(".git")],
      },
      externalContext: { mode: "unavailable" },
      launchCwd: path("."),
      settings: {
        projectDocFallbackFilenames: [],
        projectDocMaxBytes: 32_768,
        projectRootMarkers: [".git"],
      },
      targetPath: path("src/main.ts"),
    });
    const documents: EffectiveContextCacheDocumentSnapshot[] = [
      { bytes: null, identity: null, path: path("AGENTS.md"), state: "unavailable" },
    ];
    const cache = new EffectiveContextMemoizationCache();
    const input = request({ documents, profile, sources: [], targetPath: path("src/main.ts") });
    const cold = cache.resolve(input);
    const warm = cache.resolve(input);

    expect(warm).toBe(cold);
    expect(warm.analysisStatus).toBe("partial");
    expect(warm.documents[0]).toMatchObject({
      activation: "indeterminate",
      contentState: "unavailable",
    });
    expect(warm.ambiguities.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["activation", "external-context", "partial-profile"]),
    );
  });

  test("requires an exact dependency closure and a genuine E08-selected target", () => {
    const cache = new EffectiveContextMemoizationCache();
    const missing = request();
    const incomplete = { ...missing, documents: missing.documents.slice(0, 1) };
    expect(() => cache.resolve(incomplete)).toThrow(
      expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidRelationship }),
    );

    const extra = {
      ...missing,
      documents: [
        ...missing.documents,
        dependency({ content: "unrelated", path: path("README.md") }),
      ],
    };
    expect(() => cache.resolve(extra)).toThrow(EffectiveContextCacheError);

    const unselected = request({ samples: sampling(path("other.ts")) });
    expect(() => cache.resolve(unselected)).toThrow(
      expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidRelationship }),
    );

    expect(() =>
      cache.resolve({ ...missing, sampling: structuredClone(missing.sampling) }),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidInput }));
  });

  test("fails closed for forged profiles, hostile containers, relationships, and byte views", () => {
    const cache = new EffectiveContextMemoizationCache();
    const valid = request();
    expect(() =>
      cache.resolve({
        ...valid,
        context: {
          ...valid.context,
          profileResolution: structuredClone(valid.context.profileResolution),
        },
      }),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidInput }));
    expect(() => cache.resolve(new Proxy({}, {}))).toThrow(EffectiveContextCacheError);
    expect(() => cache.resolve({ ...valid, extra: true })).toThrow(EffectiveContextCacheError);

    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "documents", { enumerable: true, get: () => [] });
    expect(() => cache.resolve(accessor)).toThrow(EffectiveContextCacheError);

    const sparse = new Array(2) as EffectiveContextCacheDocumentSnapshot[];
    const firstDocument = valid.documents[0];
    if (firstDocument === undefined) throw new Error("cache test fixture is incomplete");
    sparse[0] = firstDocument;
    expect(() => cache.resolve({ ...valid, documents: sparse })).toThrow(
      EffectiveContextCacheError,
    );
    expect(() =>
      cache.resolve({ ...valid, documents: [valid.documents[0], valid.documents[0]] }),
    ).toThrow(
      expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidRelationship }),
    );
    expect(() =>
      cache.resolve({
        ...valid,
        documents: [
          { ...valid.documents[0], bytes: new Proxy(new Uint8Array([1]), {}) },
          valid.documents[1],
        ],
      }),
    ).toThrow(EffectiveContextCacheError);
  });

  test("cancellation, options, and limits do not poison cache state", () => {
    const cache = new EffectiveContextMemoizationCache();
    const controller = new AbortController();
    controller.abort();
    expect(() => cache.resolve(request(), { signal: controller.signal })).toThrow(
      expect.objectContaining({ code: EffectiveContextCacheErrorCode.cancelled }),
    );
    expect(cache.stats()).toMatchObject({ entries: 0, hits: 0, misses: 0 });
    expect(() => cache.resolve(request(), { signal: {} as AbortSignal })).toThrow(
      expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidOptions }),
    );
    expect(() => new EffectiveContextMemoizationCache({ maximumEntries: 0 })).toThrow(
      expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidOptions }),
    );
    expect(
      () => new EffectiveContextMemoizationCache({ maximumEntryBytes: 20, maximumWeightBytes: 10 }),
    ).toThrow(EffectiveContextCacheError);
    expect(() =>
      new EffectiveContextMemoizationCache({ maximumDependencyBytes: 1 }).resolve(request()),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.resourceLimit }));
  });

  test("evicts deterministically, bounds oversized values, and clears optimization state", () => {
    const cache = new EffectiveContextMemoizationCache({ maximumEntries: 1 });
    cache.resolve(request());
    const changed = [
      { content: "Different root.\n", path: path("AGENTS.md") },
      { content: "Source policy.\n", path: path("src/AGENTS.md") },
    ];
    cache.resolve(request({ sources: changed }));
    expect(cache.stats()).toMatchObject({ entries: 1, evictions: 1, misses: 2 });
    cache.resolve(request());
    expect(cache.stats()).toMatchObject({ evictions: 2, misses: 3 });
    cache.clear();
    expect(cache.stats()).toMatchObject({ entries: 0, weightBytes: 0 });

    const oversized = new EffectiveContextMemoizationCache({
      maximumEntryBytes: 1,
      maximumWeightBytes: 1,
    });
    const first = oversized.resolve(request());
    const second = oversized.resolve(request());
    expect(second).not.toBe(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(oversized.stats()).toMatchObject({ entries: 0, misses: 2, oversizedResults: 2 });
  });

  test("produces immutable stable key metadata without reflecting repository content", () => {
    const cache = new EffectiveContextMemoizationCache();
    const key = cache.key(request());
    expect(key).toMatchObject({
      contractVersion: "0.1.0",
      profileId: "codex-cli",
      profileVersion: "0.1.0",
      recordKind: "agent-context-effective-context-cache-key",
      surfaceId: "codex-cli/local-cli-single-cwd",
      targetPath: "src/main.ts",
    });
    for (const digest of [
      key.configurationSha256,
      key.dependencySha256,
      key.importDagSha256,
      key.profileResolutionSha256,
      key.samplingSha256,
      key.sha256,
      key.sourceIdentitySha256,
    ])
      expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(key)).not.toContain("Root policy");
    expect(Object.isFrozen(key)).toBe(true);
    expect(Object.isFrozen(cache.stats())).toBe(true);
  });

  test("accepts every genuine GA profile branch and exposes profile/spec divergence", async () => {
    const claude = resolveClaudeCodeProfile({
      candidates: [],
      launchCwd: path("."),
      repositoryRoot: path("."),
      runtime: {
        additionalDirectoryInstructions: "disabled",
        clientVersion: "2.1.217",
        eventTrace: [{ id: "launch", kind: "launch", path: path(".") }],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "supplied",
        mode: "normal",
        settingSources: { state: "known", values: ["local", "managed", "project", "user"] },
      },
    });
    const olderClaude = resolveClaudeCodeProfile({
      candidates: [],
      launchCwd: path("."),
      repositoryRoot: path("."),
      runtime: {
        additionalDirectoryInstructions: "disabled",
        clientVersion: "2.1.216",
        eventTrace: [{ id: "launch", kind: "launch", path: path(".") }],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "supplied",
        mode: "normal",
        settingSources: { state: "known", values: ["local", "managed", "project", "user"] },
      },
    });
    const copilot = resolveCopilotProfile({
      candidates: [],
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
    const cursor = resolveCursorProfile({
      candidates: [],
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
    const gemini = await resolveGeminiCliContext({
      boundaryMarkerDirectories: [path(".")],
      candidates: [],
      events: [{ id: "launch", kind: "launch", path: path(".") }],
      externalContext: "explicit-synthetic",
      repository: repository({}),
      settingsLayers: [],
      trustState: "trusted",
      workspaceRoots: [path(".")],
    });
    const cache = new EffectiveContextMemoizationCache();
    const base = request();
    const keys = [claude, copilot, cursor, gemini].map((profile) =>
      cache.key({ ...base, context: { ...base.context, profileResolution: profile } }),
    );

    expect(keys.map((key) => key.profileId)).toEqual([
      "claude-code",
      "copilot-vscode",
      "cursor-agent",
      "gemini-cli",
    ]);
    expect(new Set(keys.map((key) => key.specSnapshotId)).size).toBe(4);
    expect(new Set(keys.map((key) => key.sha256)).size).toBe(4);
    const olderKey = cache.key({
      ...base,
      context: { ...base.context, profileResolution: olderClaude },
    });
    expect(olderKey.profileVersion).toBe(keys[0]?.profileVersion);
    expect(olderKey.specSnapshotId).toBe(keys[0]?.specSnapshotId);
    expect(olderKey.profileResolutionSha256).not.toBe(keys[0]?.profileResolutionSha256);
    expect(olderKey.sha256).not.toBe(keys[0]?.sha256);
  });

  test("binds E04 entry, loaded import, occurrence, trace, and content identities", async () => {
    const sources = {
      "AGENTS.md": "Read @docs/policy.md\n",
      "docs/policy.md": "Policy.\n",
    };
    const graph = await loadImportGraph({
      entryPath: path("AGENTS.md"),
      repository: repository(sources),
      syntax: "claude-code",
    });
    const dag = buildDocumentImportDag({
      graph,
      trace: createSyntheticTargetTrace({
        launchCwd: path("."),
        purpose: "e09-unit",
        targetPath: path("src/main.ts"),
        workspaceRoots: [path(".")],
      }),
    });
    const base = request({
      documents: Object.entries(sources).map(([sourcePath, content]) =>
        dependency({ content, path: path(sourcePath) }),
      ),
      profile: codex([{ content: sources["AGENTS.md"], path: path("AGENTS.md") }]),
      sources: [{ content: sources["AGENTS.md"], path: path("AGENTS.md") }],
    });
    const withDag: EffectiveContextCacheRequest = {
      ...base,
      context: { ...base.context, importDags: [dag] },
    };
    const cache = new EffectiveContextMemoizationCache();
    const result = cache.resolve(withDag);

    expect(result.occurrences.map((entry) => entry.targetPath)).toEqual([
      "AGENTS.md",
      "docs/policy.md",
    ]);
    expect(cache.resolve(withDag)).toBe(result);
  });

  test("rejects malformed records, arrays, identities, paths, states, and dependency relations", () => {
    const cache = new EffectiveContextMemoizationCache();
    const valid = request();
    const malformed: unknown[] = [null, [], 1, Object.create(new Date())];
    for (const value of malformed)
      expect(() => cache.resolve(value)).toThrow(EffectiveContextCacheError);

    const hiddenRequest = { ...valid } as Record<string, unknown>;
    Object.defineProperty(hiddenRequest, "sampling", {
      enumerable: false,
      value: valid.sampling,
    });
    expect(() => cache.resolve(hiddenRequest)).toThrow(EffectiveContextCacheError);
    expect(() => cache.resolve({ ...valid, documents: null })).toThrow(EffectiveContextCacheError);

    const extended = [...valid.documents] as EffectiveContextCacheDocumentSnapshot[] & {
      extra?: boolean;
    };
    extended.extra = true;
    expect(() => cache.resolve({ ...valid, documents: extended })).toThrow(
      EffectiveContextCacheError,
    );
    expect(() =>
      new EffectiveContextMemoizationCache({ maximumDependencyFiles: 1 }).resolve(valid),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.resourceLimit }));

    const hiddenIndex = [...valid.documents];
    Object.defineProperty(hiddenIndex, "0", { enumerable: false, value: hiddenIndex[0] });
    expect(() => cache.resolve({ ...valid, documents: hiddenIndex })).toThrow(
      EffectiveContextCacheError,
    );
    expect(() =>
      cache.resolve({
        ...valid,
        documents: [{ ...valid.documents[0], state: "invented" }, valid.documents[1]],
      }),
    ).toThrow(EffectiveContextCacheError);
    expect(() =>
      cache.resolve({
        ...valid,
        documents: [{ ...valid.documents[0], bytes: null }, valid.documents[1]],
      }),
    ).toThrow(
      expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidRelationship }),
    );
    expect(() =>
      cache.resolve({
        ...valid,
        documents: [
          {
            ...valid.documents[0],
            bytes: encoder.encode("claimed"),
            identity: null,
            state: "unavailable",
          },
          valid.documents[1],
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidRelationship }),
    );
    expect(() =>
      cache.resolve({
        ...valid,
        documents: [
          { ...valid.documents[0], bytes: null, identity: null, state: "unavailable" },
          valid.documents[1],
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: EffectiveContextCacheErrorCode.invalidRelationship }),
    );
    expect(() =>
      cache.resolve({
        ...valid,
        documents: [
          { ...valid.documents[0], bytes: encoder.encode("x"), identity: null },
          valid.documents[1],
        ],
      }),
    ).toThrow(EffectiveContextCacheError);
    expect(() =>
      cache.resolve({
        ...valid,
        documents: [{ ...valid.documents[0], path: "../escape" }, valid.documents[1]],
      }),
    ).toThrow(EffectiveContextCacheError);
  });

  test("rejects invalid identity text, byte storage, canonical budgets, and aggregate bytes", () => {
    const valid = request();
    const invalidIdentities: unknown[] = [
      { device: "", inode: "1" },
      { device: 1, inode: "1" },
      { device: "\ud800", inode: "1" },
      { device: "\udc00", inode: "1" },
      { device: "fixture", inode: "" },
    ];
    for (const identity of invalidIdentities)
      expect(() =>
        new EffectiveContextMemoizationCache().resolve({
          ...valid,
          documents: [{ ...valid.documents[0], identity }, valid.documents[1]],
        }),
      ).toThrow(EffectiveContextCacheError);
    const unicodeIdentity = {
      ...valid,
      documents: [
        { ...valid.documents[0], identity: { device: "😀", inode: "1" } },
        valid.documents[1],
      ],
    };
    expect(() => new EffectiveContextMemoizationCache().key(unicodeIdentity)).not.toThrow();

    expect(() =>
      new EffectiveContextMemoizationCache({ maximumIdentityBytes: 1 }).resolve(valid),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.resourceLimit }));
    expect(() =>
      new EffectiveContextMemoizationCache({ maximumPathBytes: 1 }).resolve(valid),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.resourceLimit }));
    expect(() =>
      new EffectiveContextMemoizationCache().resolve({
        ...valid,
        documents: [
          { ...valid.documents[0], bytes: new DataView(new ArrayBuffer(1)) },
          valid.documents[1],
        ],
      }),
    ).toThrow(EffectiveContextCacheError);
    const sharedBytes = new Uint8Array(new SharedArrayBuffer(1));
    expect(() =>
      new EffectiveContextMemoizationCache().resolve({
        ...valid,
        documents: [{ ...valid.documents[0], bytes: sharedBytes }, valid.documents[1]],
      }),
    ).toThrow(EffectiveContextCacheError);
    const detachedBytes = new Uint8Array([1]);
    structuredClone(detachedBytes.buffer, { transfer: [detachedBytes.buffer] });
    expect(() =>
      new EffectiveContextMemoizationCache().resolve({
        ...valid,
        documents: [{ ...valid.documents[0], bytes: detachedBytes }, valid.documents[1]],
      }),
    ).toThrow(EffectiveContextCacheError);
    expect(() =>
      new EffectiveContextMemoizationCache({ maximumDependencyBytes: 20 }).resolve(valid),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.resourceLimit }));
    const tiny = request({
      documents: [
        dependency({ content: "x", path: path("AGENTS.md") }),
        dependency({ content: "y", path: path("src/AGENTS.md") }),
      ],
      sources: [
        { content: "x", path: path("AGENTS.md") },
        { content: "y", path: path("src/AGENTS.md") },
      ],
    });
    expect(() =>
      new EffectiveContextMemoizationCache({ maximumDependencyBytes: 1 }).resolve(tiny),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.resourceLimit }));
    expect(() =>
      new EffectiveContextMemoizationCache({ maximumCanonicalNodes: 1 }).key(valid),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.resourceLimit }));
    expect(() =>
      new EffectiveContextMemoizationCache({ maximumCanonicalTextBytes: 1 }).key(valid),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.resourceLimit }));
    expect(() =>
      new EffectiveContextMemoizationCache({ maximumCanonicalTextBytes: 10 }).key(valid),
    ).toThrow(expect.objectContaining({ code: EffectiveContextCacheErrorCode.resourceLimit }));
  });

  test("rejects invalid context, request, configuration, DAG, signal, and option contracts", () => {
    const valid = request();
    const cache = new EffectiveContextMemoizationCache();
    expect(() => cache.resolve({ ...valid, recordKind: "wrong" })).toThrow(
      EffectiveContextCacheError,
    );
    expect(() =>
      cache.resolve({ ...valid, context: { ...valid.context, recordKind: "wrong" } }),
    ).toThrow(EffectiveContextCacheError);
    expect(() =>
      cache.resolve({ ...valid, context: { ...valid.context, importDags: [{}] } }),
    ).toThrow(EffectiveContextCacheError);
    expect(() =>
      cache.resolve({
        ...valid,
        context: {
          ...valid.context,
          profileResolution: { recordKind: "unknown" },
        },
      }),
    ).toThrow(EffectiveContextCacheError);
    expect(() =>
      cache.resolve({
        ...valid,
        configuration: { ...valid.configuration, commands: { packageManager: "invalid" } },
      }),
    ).toThrow(EffectiveContextCacheError);
    expect(() => cache.resolve(valid, { signal: undefined })).not.toThrow();
    expect(() => cache.resolve(valid, {})).not.toThrow();
    expect(() => cache.resolve(valid, new Proxy({ signal: undefined }, {}))).toThrow(
      EffectiveContextCacheError,
    );
    expect(() => new EffectiveContextMemoizationCache({ unknown: 1 } as never)).toThrow(
      EffectiveContextCacheError,
    );
    const inheritedOptions = Object.create(new Date()) as unknown as EffectiveContextCacheOptions;
    expect(() => new EffectiveContextMemoizationCache(inheritedOptions)).toThrow(
      EffectiveContextCacheError,
    );
    expect(() => new EffectiveContextMemoizationCache({ maximumEntries: 1.5 })).toThrow(
      EffectiveContextCacheError,
    );
    expect(() => new EffectiveContextMemoizationCache({ maximumEntries: 65_537 })).toThrow(
      EffectiveContextCacheError,
    );
  });
});
