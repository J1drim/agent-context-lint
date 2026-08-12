import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  canonicalizeRepositoryRelativePath,
  DEFAULT_AGENT_CONTEXT_CONFIGURATION,
  type RepositoryRelativePath,
} from "../packages/core/dist/index.js";
import { describe, expect, test } from "vitest";

import {
  BOUNDED_RESOLUTION_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  EffectiveContextMemoizationCache,
  createEffectiveContextResolutionTask,
  resolveCodexCliAgents,
  resolveEffectiveContextsBounded,
  sampleTargets,
  type EffectiveContextCacheRequest,
  type EffectiveContextResolutionTask,
} from "../packages/resolver/dist/index.js";

const encoder = new TextEncoder();
const FIXTURE = new URL(
  "../conformance/fixtures/v0/bounded-resolution.fixture.json",
  import.meta.url,
);
const GOLDEN = new URL(
  "../conformance/fixtures/v0/bounded-resolution.golden.json",
  import.meta.url,
);

interface Fixture {
  readonly contractVersion: typeof BOUNDED_RESOLUTION_CONTRACT_VERSION;
  readonly recordKind: "agent-context-bounded-resolution-fixture";
  readonly source: { readonly content: string; readonly path: string };
  readonly targets: readonly { readonly id: string; readonly path: string }[];
}

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function request(
  fixture: Fixture,
  targetPath: RepositoryRelativePath,
  sampling: ReturnType<typeof sampleTargets>,
): EffectiveContextCacheRequest {
  const sourcePath = path(fixture.source.path);
  const profile = resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: [
        {
          bytes: encoder.encode(fixture.source.content),
          errorCode: null,
          kind: "file",
          path: sourcePath,
          resolvedTarget: null,
        },
      ],
      reason: "complete E10 integration fixture",
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
  return {
    configuration: DEFAULT_AGENT_CONTEXT_CONFIGURATION,
    configurationIdentity: { device: "fixture", inode: "configuration" },
    context: {
      contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
      importDags: [],
      profileResolution: profile,
      recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
      targetPath,
    },
    contractVersion: EFFECTIVE_CONTEXT_CACHE_CONTRACT_VERSION,
    documents: [
      {
        bytes: encoder.encode(fixture.source.content),
        identity: { device: "fixture", inode: fixture.source.path },
        path: sourcePath,
        state: "available",
      },
    ],
    recordKind: EFFECTIVE_CONTEXT_CACHE_REQUEST_RECORD_KIND,
    sampling,
    targetIdentity: { device: "fixture", inode: targetPath },
  };
}

describe("E10 built bounded resolver", () => {
  test("composes E08/E09 and matches byte-identical serial, concurrent, cold, warm, and golden output", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as Fixture;
    expect(fixture).toMatchObject({
      contractVersion: BOUNDED_RESOLUTION_CONTRACT_VERSION,
      recordKind: "agent-context-bounded-resolution-fixture",
    });
    const targets = fixture.targets.map((target) => path(target.path));
    const sampling = sampleTargets({
      activationObservations: targets.map((target) => ({
        path: target,
        states: [{ ruleId: "rule:e10-fixture", state: "active" }],
      })),
      criticalPaths: [],
      paths: targets,
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    });
    const cache = new EffectiveContextMemoizationCache();
    const tasks: EffectiveContextResolutionTask[] = fixture.targets.map((target, index) => {
      const cacheRequest = request(fixture, path(target.path), sampling);
      const profile = cacheRequest.context.profileResolution;
      if (profile.recordKind !== "agent-context-codex-cli-agents-resolution")
        throw new Error("E10 fixture profile is not Codex");
      return createEffectiveContextResolutionTask(
        {
          clientVersion: profile.profile.clientVersion,
          id: target.id,
          profileId: profile.profile.profileId,
          profileVersion: profile.profile.contractVersion,
          specSnapshotId: profile.profile.specSnapshotId,
          surfaceId: profile.profile.surfaceId,
          targetPath: cacheRequest.context.targetPath,
        },
        async (signal) => {
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, (index % 3) * 2));
          return cache.resolve(cacheRequest, { signal });
        },
      );
    });

    const concurrentCold = await resolveEffectiveContextsBounded([...tasks].reverse(), {
      maximumConcurrency: 4,
    });
    const serialWarm = await resolveEffectiveContextsBounded(tasks, { maximumConcurrency: 1 });
    const outputBytes = JSON.stringify(concurrentCold);
    const actual = {
      contractVersion: concurrentCold.contractVersion,
      entryCount: concurrentCold.entries.length,
      orderedEntries: concurrentCold.entries.map((entry) => ({
        analysisStatus: entry.resolution.analysisStatus,
        assemblySha256: entry.resolution.assembly.sha256,
        clientVersion: entry.resolution.clientVersion,
        profileId: entry.resolution.profileId,
        profileVersion: entry.resolution.profileVersion,
        specSnapshotId: entry.resolution.specSnapshotId,
        surfaceId: entry.resolution.surfaceId,
        targetPath: entry.resolution.targetPath,
        taskId: entry.taskId,
      })),
      outputSha256: createHash("sha256").update(outputBytes, "utf8").digest("hex"),
      recordKind: concurrentCold.recordKind,
    };
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as typeof actual;

    expect(JSON.stringify(serialWarm)).toBe(JSON.stringify(concurrentCold));
    expect(actual).toEqual(golden);
    expect(cache.stats()).toMatchObject({ entries: 4, hits: 4, misses: 4 });
  });
});
