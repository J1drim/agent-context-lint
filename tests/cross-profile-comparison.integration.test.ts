import { readFile } from "node:fs/promises";

import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "../packages/core/dist/index.js";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  type ReadOnlyRepository,
} from "../packages/evidence/dist/index.js";
import type { GeminiSettingsLayerInput } from "../packages/syntax/dist/index.js";
import { describe, expect, test } from "vitest";

import {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
  compareEffectiveContexts,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  resolveCodexCliAgents,
  resolveEffectiveContext,
  resolveGeminiCliContext,
  type EffectiveContextProfileResolution,
  type EffectiveContextResolution,
} from "../packages/resolver/dist/index.js";

interface Golden {
  readonly caseId: string;
  readonly contractVersion: "0.1.0";
  readonly expected: {
    readonly analysisStatus: "partial";
    readonly content: "different";
    readonly equivalenceClaim: false;
    readonly ordering: "same";
    readonly overall: "divergent";
    readonly profileIds: readonly ["codex-cli", "gemini-cli"];
    readonly scope: "different";
    readonly semanticRelation: "incompatible-profile-contracts";
    readonly targetPath: "src/main.ts";
  };
}

const encoder = new TextEncoder();
const GOLDEN = new URL(
  "../conformance/fixtures/v0/cross-profile-comparison.golden.json",
  import.meta.url,
);

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function effective(
  profileResolution: EffectiveContextProfileResolution,
): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: path("src/main.ts"),
  });
}

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/cross-profile-golden",
    inspect: () => Promise.reject(new Error("not used")),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const sourcePath = path(String(value));
      const source = sources[sourcePath];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "golden source unavailable",
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

describe("E07 built cross-profile comparison", () => {
  test("matches the profile-safe divergence golden", async () => {
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as Golden;
    const codex = effective(
      resolveCodexCliAgents({
        discovery: {
          certainty: "known",
          entries: [
            ["AGENTS.md", "Root.\n"],
            ["FALLBACK.md", "Shadowed.\n"],
            ["src/AGENTS.md", "App.\n"],
          ].map(([entryPath, content]) => ({
            bytes: encoder.encode(content ?? ""),
            errorCode: null,
            kind: "file" as const,
            path: path(entryPath ?? ""),
            resolvedTarget: null,
          })),
          reason: "complete golden snapshot",
          rootMarkerPaths: [path(".git")],
        },
        externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
        launchCwd: path("src"),
        settings: {
          projectDocFallbackFilenames: ["FALLBACK.md"],
          projectDocMaxBytes: 32_768,
          projectRootMarkers: [".git"],
        },
        targetPath: path("src/main.ts"),
      }),
    );
    const sources = { "AGENTS.md": "Different root.\n", "src/AGENTS.md": "App.\n" };
    const settings: GeminiSettingsLayerInput = {
      bytes: encoder.encode(JSON.stringify({ context: { fileName: "AGENTS.md" } })),
      kind: "workspace",
      path: path(".gemini/settings.json"),
      trustState: "trusted",
    };
    const gemini = effective(
      await resolveGeminiCliContext({
        boundaryMarkerDirectories: [path(".")],
        candidates: [
          { identity: "directory:.", ignoredBy: [], kind: "directory", path: path(".") },
          {
            identity: "directory:src",
            ignoredBy: [],
            kind: "directory",
            path: path("src"),
          },
          ...Object.keys(sources).map((sourcePath) => ({
            identity: `file:${sourcePath}`,
            ignoredBy: [],
            kind: "file" as const,
            path: path(sourcePath),
          })),
          {
            identity: "file:src/main.ts",
            ignoredBy: [],
            kind: "file",
            path: path("src/main.ts"),
          },
        ],
        events: [
          { id: "launch", kind: "launch", path: path(".") },
          { id: "read", kind: "read-path", path: path("src/main.ts") },
        ],
        externalContext: "explicit-synthetic",
        repository: repository(sources),
        settingsLayers: [settings],
        trustState: "trusted",
        workspaceRoots: [path(".")],
      }),
    );

    const comparison = compareEffectiveContexts({
      contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
      recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
      resolutions: [codex, gemini],
    });
    const pair = comparison.pairs[0];
    expect(golden.contractVersion).toBe(CROSS_PROFILE_COMPARISON_CONTRACT_VERSION);
    expect(golden.caseId).toBe("codex-gemini-shared-path-divergence");
    expect({
      analysisStatus: comparison.analysisStatus,
      content: pair?.content.state,
      equivalenceClaim: pair?.equivalenceClaim,
      ordering: pair?.ordering.state,
      overall: pair?.overall,
      profileIds: comparison.profiles.map((profile) => profile.profileId).sort(),
      scope: pair?.scope.state,
      semanticRelation: pair?.semanticRelation,
      targetPath: comparison.targetPath,
    }).toEqual(golden.expected);
  });
});
