import { readFile } from "node:fs/promises";

import {
  canonicalizeRepositoryRelativePath,
  DEFAULT_AGENT_CONTEXT_CONFIGURATION,
  type RepositoryRelativePath,
} from "../packages/core/dist/index.js";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  loadImportGraph,
  type ReadOnlyRepository,
} from "../packages/evidence/dist/index.js";
import { describe, expect, test } from "vitest";

import {
  EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  EffectiveContextMemoizationCache,
  buildDocumentImportDag,
  createSyntheticTargetTrace,
  resolveCodexCliAgents,
  sampleTargets,
  type EffectiveContextCacheDocumentSnapshot,
  type EffectiveContextCacheRequest,
} from "../packages/resolver/dist/index.js";

const encoder = new TextEncoder();
const GOLDEN = new URL(
  "../conformance/fixtures/v0/effective-context-cache.golden.json",
  import.meta.url,
);

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/cache-fixture",
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

async function request(
  sources: Readonly<Record<string, string>>,
  reverseDependencies = false,
): Promise<EffectiveContextCacheRequest> {
  const targetPath = path("src/main.ts");
  const graph = await loadImportGraph({
    entryPath: path("AGENTS.md"),
    repository: repository(sources),
    syntax: "claude-code",
  });
  const dag = buildDocumentImportDag({
    graph,
    trace: createSyntheticTargetTrace({
      launchCwd: path("."),
      purpose: "e09-integration",
      targetPath,
      workspaceRoots: [path(".")],
    }),
  });
  const profile = resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: [
        {
          bytes: encoder.encode(sources["AGENTS.md"] ?? ""),
          errorCode: null,
          kind: "file",
          path: path("AGENTS.md"),
          resolvedTarget: null,
        },
      ],
      reason: "complete integration fixture",
      rootMarkerPaths: [path(".git")],
    },
    externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("."),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath,
  });
  const sampling = sampleTargets({
    activationObservations: [
      { path: targetPath, states: [{ ruleId: "rule:fixture", state: "active" }] },
    ],
    criticalPaths: [],
    paths: [targetPath],
    trackingCertainty: "tracked",
    trackingReason: "verified-git-index",
    workspaceBoundaries: [],
    workspaceUncertainty: "known",
    workspaceUncertaintyReasons: [],
  });
  const documents: EffectiveContextCacheDocumentSnapshot[] = Object.entries(sources).map(
    ([documentPath, content]) => ({
      bytes: encoder.encode(content),
      identity: { device: "fixture", inode: documentPath },
      path: path(documentPath),
      state: "available",
    }),
  );
  if (reverseDependencies) documents.reverse();
  return {
    configuration: DEFAULT_AGENT_CONTEXT_CONFIGURATION,
    configurationIdentity: { device: "fixture", inode: "configuration" },
    context: {
      contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
      importDags: [dag],
      profileResolution: profile,
      recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
      targetPath,
    },
    contractVersion: EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION,
    documents,
    recordKind: EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND,
    sampling,
    targetIdentity: { device: "fixture", inode: targetPath },
  };
}

describe("E09 built effective-context cache", () => {
  test("matches the committed content-address golden and returns byte-identical warm output", async () => {
    const sources = {
      "AGENTS.md": "Read @docs/policy.md before editing.\n",
      "docs/policy.md": "Use deterministic tests.\n",
    };
    const cache = new EffectiveContextMemoizationCache();
    const first = await request(sources);
    const second = await request(sources, true);
    const cold = cache.resolve(first);
    const warm = cache.resolve(second);
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as {
      readonly key: ReturnType<EffectiveContextMemoizationCache["key"]>;
      readonly resolutionSha256: string;
    };

    expect(cache.key(first)).toEqual(golden.key);
    expect(cache.key(second)).toEqual(golden.key);
    expect(warm).toBe(cold);
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(cold)));
    expect(Buffer.from(digest).toString("hex")).toBe(golden.resolutionSha256);
  });

  test("invalidates imported content without changing the profile-resolution component", async () => {
    const first = await request({
      "AGENTS.md": "Read @docs/policy.md before editing.\n",
      "docs/policy.md": "Use deterministic tests.\n",
    });
    const changed = await request({
      "AGENTS.md": "Read @docs/policy.md before editing.\n",
      "docs/policy.md": "Use deterministic integration tests.\n",
    });
    const cache = new EffectiveContextMemoizationCache();
    const firstKey = cache.key(first);
    const changedKey = cache.key(changed);

    expect(changedKey.profileResolutionSha256).toBe(firstKey.profileResolutionSha256);
    expect(changedKey.importDagSha256).not.toBe(firstKey.importDagSha256);
    expect(changedKey.dependencySha256).not.toBe(firstKey.dependencySha256);
    expect(changedKey.sha256).not.toBe(firstKey.sha256);
  });

  test("rejects missing imported and failed-import dependency identities", async () => {
    const complete = await request({
      "AGENTS.md": "Read @docs/policy.md before editing.\n",
      "docs/policy.md": "Policy.\n",
    });
    const cache = new EffectiveContextMemoizationCache();
    expect(() => cache.resolve({ ...complete, documents: complete.documents.slice(0, 1) })).toThrow(
      /dependency set/u,
    );

    const unavailable = await request({ "AGENTS.md": "Read @missing.md before editing.\n" });
    expect(() => cache.resolve(unavailable)).toThrow(/dependency set/u);
    const withFailure: EffectiveContextCacheRequest = {
      ...unavailable,
      documents: [
        ...unavailable.documents,
        { bytes: null, identity: null, path: path("missing.md"), state: "unavailable" },
      ],
    };
    expect(cache.resolve(withFailure).occurrences).toContainEqual(
      expect.objectContaining({ state: "unavailable", targetPath: "missing.md" }),
    );
  });
});
