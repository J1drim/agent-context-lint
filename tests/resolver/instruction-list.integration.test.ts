import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "../../packages/core/dist/index.js";
import {
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  type ReadOnlyRepository,
} from "../../packages/evidence/dist/index.js";
import { describe, expect, it } from "vitest";

import {
  buildInstructionList,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveCopilotProfile,
  resolveCursorProfile,
  resolveGeminiCliContext,
} from "../../packages/resolver/src/index.js";

const encoder = new TextEncoder();
const path = (value: string): RepositoryRelativePath => canonicalizeRepositoryRelativePath(value);

function repository(files: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    inspect(): ReturnType<ReadOnlyRepository["inspect"]> {
      throw new Error("not used by this integration fixture");
    },
    limits: {
      maximumDurationMs: 1_000,
      maximumEntries: 100,
      maximumFileBytes: 1_048_576,
      maximumMetadataOperations: 100,
      maximumSymlinkDepth: 8,
      maximumTotalBytes: 8_388_608,
      maximumTraversalDepth: 64,
    },
    readDirectory(): ReturnType<ReadOnlyRepository["readDirectory"]> {
      throw new Error("not used by this integration fixture");
    },
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const candidatePath = value as string;
      const repositoryPath = candidatePath as RepositoryRelativePath;
      const content = files[candidatePath];
      if (content === undefined) {
        return Promise.reject(
          new ReadOnlyRepositoryError(
            ReadOnlyRepositoryErrorCode.pathUnavailable,
            "missing synthetic file",
            "readFile",
            repositoryPath,
          ),
        );
      }
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          repositoryPath,
          encoder.encode(content),
          { device: "fixture", inode: candidatePath },
          0,
        ),
      );
    },
    root: "/synthetic-read-only",
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
}

describe("instruction list resolver integration", () => {
  it("projects real results from every GA profile resolver without reading or executing repository commands", async () => {
    const codex = resolveCodexCliAgents({
      discovery: {
        certainty: "known",
        entries: [
          {
            bytes: encoder.encode("Codex instructions.\n"),
            errorCode: null,
            kind: "file",
            path: path("AGENTS.md"),
            resolvedTarget: null,
          },
        ],
        reason: "complete synthetic snapshot",
        rootMarkerPaths: [],
      },
      externalContext: { mode: "unavailable" },
      launchCwd: path("."),
      settings: {
        projectDocFallbackFilenames: [],
        projectDocMaxBytes: 32_768,
        projectRootMarkers: [],
      },
      targetPath: path("src/index.ts"),
    });

    const claude = resolveClaudeCodeProfile({
      candidates: [
        {
          absolutePath: "/synthetic/CLAUDE.md",
          bytes: encoder.encode("Claude instructions.\n"),
          importGraph: null,
          kind: "memory-shared",
          origin: "repository",
          path: path("CLAUDE.md"),
          scopeRoot: path("."),
          symlinkState: "none",
        },
      ],
      launchCwd: path("."),
      repositoryRoot: path("."),
      runtime: {
        additionalDirectoryInstructions: "disabled",
        clientVersion: "2.1.217",
        eventTrace: [{ id: "launch", kind: "launch", path: path(".") }],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "supplied",
        mode: "normal",
        settingSources: { state: "known", values: ["project"] },
      },
    });

    const copilot = resolveCopilotProfile({
      candidates: [
        {
          bytes: encoder.encode("Copilot instructions.\n"),
          format: "repository-wide",
          path: path(".github/copilot-instructions.md"),
        },
      ],
      profileId: "copilot-cli",
      runtime: {
        disabledPaths: [],
        eventState: "present",
        kind: "copilot-cli",
        standardLocations: [{ kind: "repository-root", path: path(".") }],
        targetPaths: [path("src/index.ts")],
      },
    });

    const cursor = resolveCursorProfile({
      candidates: [
        {
          bytes: encoder.encode("---\nalwaysApply: true\n---\nCursor instructions.\n"),
          format: "mdc",
          path: path(".cursor/rules/always.mdc"),
        },
      ],
      runtime: {
        clientVersion: "3.12.30",
        eventState: "present",
        events: [{ kind: "read-path", sequence: 1, targetPath: path("src/index.ts") }],
        externalContext: "absent",
        projectRules: "enabled",
        surfaceId: "cursor-agent/ide",
        workspaceRoots: [path(".")],
      },
    });

    const geminiCandidates = [
      { identity: "gemini", ignoredBy: [], kind: "file" as const, path: path("GEMINI.md") },
    ];
    const gemini = await resolveGeminiCliContext({
      boundaryMarkerDirectories: [path(".")],
      candidates: geminiCandidates,
      events: [{ id: "launch", kind: "launch", path: path(".") }],
      externalContext: "explicit-synthetic",
      repository: repository({ "GEMINI.md": "Gemini instructions.\n" }),
      settingsLayers: [],
      trustState: "trusted",
      workspaceRoots: [path(".")],
    });

    const listed = buildInstructionList({
      claudeCode: [claude],
      codexCli: [codex],
      copilot: [copilot],
      cursor: [cursor],
      geminiCli: [{ candidates: geminiCandidates, resolution: gemini }],
    });

    expect(listed.entries.map((item) => [item.profileId, item.path, item.state])).toEqual([
      ["cursor-agent", ".cursor/rules/always.mdc", "supported"],
      ["copilot-cli", ".github/copilot-instructions.md", "supported"],
      ["codex-cli", "AGENTS.md", "supported"],
      ["claude-code", "CLAUDE.md", "supported"],
      ["gemini-cli", "GEMINI.md", "supported"],
    ]);
    expect(listed.summary).toEqual({
      conditional: 0,
      ignored: 0,
      malformed: 0,
      recognized: 0,
      supported: 5,
      total: 5,
    });
  });
});
