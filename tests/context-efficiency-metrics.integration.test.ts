import { readFile } from "node:fs/promises";

import {
  canonicalizeRepositoryRelativePath,
  type InstructionDocumentId,
  type RepositoryRelativePath,
  type SourceRange,
} from "../packages/core/dist/index.js";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  type ReadOnlyRepository,
} from "../packages/evidence/dist/index.js";
import {
  BUILTIN_ESTIMATE_IDENTITY,
  CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
  accountOccurrenceTokens,
  analyzeContextEfficiencyMetrics,
  calculateContextEfficiencyScore,
  countEstimatedTokens,
  type AnalyzeContextEfficiencyMetricsInput,
  type ContextEfficiencyMetrics,
  type OccurrenceTokenAccounting,
  type ProfileTargetIdentity,
  type TokenCount,
} from "../packages/efficiency/dist/index.js";
import {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  compareEffectiveContexts,
  resolveCodexCliAgents,
  resolveEffectiveContext,
  resolveGeminiCliContext,
  sampleTargets,
  type DocumentImportDag,
  type EffectiveContextProfileResolution,
  type EffectiveContextResolution,
} from "../packages/resolver/dist/index.js";
import type { GeminiSettingsLayerInput } from "../packages/syntax/dist/index.js";
import { describe, expect, test } from "vitest";

const GOLDEN = new URL(
  "../conformance/fixtures/v0/context-efficiency-metrics.golden.json",
  import.meta.url,
);
const SCORE_GOLDEN = new URL(
  "../conformance/fixtures/v0/efficiency-score-specification.golden.json",
  import.meta.url,
);
const encoder = new TextEncoder();
const AGENTS_TEXT = "Run pnpm test.\nRun pnpm test.\n";
const DEAD_TEXT = "Reference notes only.\n";
const AGENTS_ID = "document:agents" as InstructionDocumentId;
const DEAD_ID = "document:dead" as InstructionDocumentId;

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function count(value: string): TokenCount {
  const result = countEstimatedTokens(value);
  if (!result.ok) throw new Error("golden token input is invalid");
  return result.value;
}

function sourceRange(sourceId: string, start: number, end: number): SourceRange {
  return {
    end: { byteOffset: end, line: 1, utf16Column: end, utf16Offset: end },
    sourceId,
    start: { byteOffset: start, line: 1, utf16Column: start, utf16Offset: start },
  } as SourceRange;
}

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/g05-golden",
    inspect: () => Promise.reject(new Error("not used")),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const sourcePath = path(String(value));
      const source = sources[sourcePath];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "golden source missing",
          "read-file",
          sourcePath,
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          sourcePath,
          encoder.encode(source),
          { device: "golden", inode: sourcePath },
          0,
        ),
      );
    },
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
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

function profile(result: EffectiveContextResolution): ProfileTargetIdentity {
  return {
    clientVersion: result.clientVersion,
    profileId: result.profileId,
    profileVersion: result.profileVersion,
    specSnapshotId: result.specSnapshotId,
    surfaceId: result.surfaceId,
  };
}

function accounting(repeat: boolean, traceDigit: string): OccurrenceTokenAccounting {
  const occurrences = [
    {
      contentId: `content:${"1".repeat(64)}`,
      depth: 0,
      fromDocumentId: null,
      id: `occurrence:${traceDigit}:entry`,
      importId: null,
      issueCode: null,
      ordinal: 0,
      range: null,
      state: "entry" as const,
      targetDocumentId: AGENTS_ID,
      targetPath: path("AGENTS.md"),
    },
    {
      contentId: `content:${"2".repeat(64)}`,
      depth: 1,
      fromDocumentId: AGENTS_ID,
      id: `occurrence:${traceDigit}:dead`,
      importId: `import:${traceDigit}:dead`,
      issueCode: null,
      ordinal: 1,
      range: null,
      state: "loaded" as const,
      targetDocumentId: DEAD_ID,
      targetPath: path("rules/dead.md"),
    },
  ];
  if (repeat)
    occurrences.push({
      contentId: `content:${"1".repeat(64)}`,
      depth: 1,
      fromDocumentId: AGENTS_ID,
      id: `occurrence:${traceDigit}:repeat`,
      importId: `import:${traceDigit}:repeat`,
      issueCode: null,
      ordinal: 2,
      range: null,
      state: "loaded",
      targetDocumentId: AGENTS_ID,
      targetPath: path("AGENTS.md"),
    });
  const dag = {
    recordKind: "agent-context-document-import-dag",
    contractVersion: "0.1.0",
    contents: [
      {
        byteLength: Buffer.byteLength(AGENTS_TEXT),
        documentIds: [AGENTS_ID],
        id: `content:${"1".repeat(64)}`,
        sha256: "1".repeat(64),
      },
      {
        byteLength: Buffer.byteLength(DEAD_TEXT),
        documentIds: [DEAD_ID],
        id: `content:${"2".repeat(64)}`,
        sha256: "2".repeat(64),
      },
    ],
    documents: [
      {
        byteLength: Buffer.byteLength(AGENTS_TEXT),
        contentId: `content:${"1".repeat(64)}`,
        depth: 0,
        documentId: AGENTS_ID,
        path: path("AGENTS.md"),
        sourceId: "source:agents",
        state: "loaded",
      },
      {
        byteLength: Buffer.byteLength(DEAD_TEXT),
        contentId: `content:${"2".repeat(64)}`,
        depth: 1,
        documentId: DEAD_ID,
        path: path("rules/dead.md"),
        sourceId: "source:dead",
        state: "loaded",
      },
    ],
    entryDocumentId: AGENTS_ID,
    entryPath: path("AGENTS.md"),
    graphState: "complete",
    issues: [],
    occurrences,
    traceEventIds: [`event:${traceDigit}`],
    traceSha256: traceDigit.repeat(64),
  } as unknown as DocumentImportDag;
  const agentsCount = count(AGENTS_TEXT);
  return accountOccurrenceTokens({
    dag,
    documentMeasurements: [
      { count: agentsCount, documentId: AGENTS_ID },
      { count: count(DEAD_TEXT), documentId: DEAD_ID },
    ],
    identity: BUILTIN_ESTIMATE_IDENTITY,
    occurrenceDecisions: occurrences.map((occurrence) =>
      occurrence.targetDocumentId === DEAD_ID
        ? {
            activation: null,
            count: null,
            disposition: "excluded" as const,
            occurrenceId: occurrence.id,
            sourceBytesConsumed: null,
          }
        : {
            activation: "always" as const,
            count: agentsCount,
            disposition: "included" as const,
            occurrenceId: occurrence.id,
            sourceBytesConsumed: Buffer.byteLength(AGENTS_TEXT),
          },
    ),
  });
}

function reconstructScore(metrics: ContextEfficiencyMetrics): unknown {
  const result = calculateContextEfficiencyScore(metrics);
  return {
    components: result.components.map((component) => ({
      id: component.id,
      inputs: component.inputs.map((input) => ({
        allocationBasisPoints: input.allocationBasisPoints,
        id: input.id,
        inputBasisPoints: input.inputBasisPoints,
        penaltyBasisPoints: input.penaltyBasisPoints,
      })),
      scoreBasisPoints: component.scoreBasisPoints,
      weight: component.weight,
    })),
    grade: result.grade,
    normalizedInputs: Object.fromEntries(
      result.components.flatMap((component) =>
        component.inputs.map((input) => [input.id, input.inputBasisPoints]),
      ),
    ),
    score: result.score,
    scoreVersion: result.specification.scoreVersion,
  };
}

describe("G05 built context-efficiency metrics", () => {
  test("matches the evidence-linked golden through compiled package boundaries", async () => {
    const codex = effective(
      resolveCodexCliAgents({
        discovery: {
          certainty: "known",
          entries: [
            {
              bytes: encoder.encode(AGENTS_TEXT),
              errorCode: null,
              kind: "file",
              path: path("AGENTS.md"),
              resolvedTarget: null,
            },
          ],
          reason: "G05 golden",
          rootMarkerPaths: [path(".git")],
        },
        externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
        launchCwd: path("."),
        settings: {
          projectDocFallbackFilenames: [],
          projectDocMaxBytes: 32_768,
          projectRootMarkers: [".git"],
        },
        targetPath: path("src/main.ts"),
      }),
    );
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
          { identity: "file:AGENTS.md", ignoredBy: [], kind: "file", path: path("AGENTS.md") },
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
        repository: repository({ "AGENTS.md": "Different processed content.\n" }),
        settingsLayers: [settings],
        trustState: "trusted",
        workspaceRoots: [path(".")],
      }),
    );
    const targetSampling = sampleTargets({
      activationObservations: [{ path: path("src/main.ts"), states: [] }],
      criticalPaths: [],
      paths: [path("src/main.ts")],
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    });
    const codexProfile = {
      accountings: [{ accounting: accounting(true, "a"), path: path("src/main.ts") }],
      profile: profile(codex),
      sampling: targetSampling,
    };
    const geminiProfile = {
      accountings: [{ accounting: accounting(false, "b"), path: path("src/main.ts") }],
      profile: profile(gemini),
      sampling: targetSampling,
    };
    const metricInput: AnalyzeContextEfficiencyMetricsInput = {
      comparisons: [
        compareEffectiveContexts({
          contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
          recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
          resolutions: [codex, gemini],
        }),
      ],
      contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
      documents: [
        {
          classificationState: "complete",
          count: count(AGENTS_TEXT),
          documentId: AGENTS_ID,
          path: path("AGENTS.md"),
        },
        {
          classificationState: "complete",
          count: count(DEAD_TEXT),
          documentId: DEAD_ID,
          path: path("rules/dead.md"),
        },
      ],
      identity: BUILTIN_ESTIMATE_IDENTITY,
      profiles: [codexProfile, geminiProfile],
      recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
      statements: [
        {
          count: count("Run pnpm test."),
          statement: {
            documentId: AGENTS_ID,
            nodeIds: ["node:first"] as never,
            range: sourceRange("source:agents", 0, 14),
            statementId: "statement:first" as never,
            text: "Run pnpm test.",
          },
        },
        {
          count: count("Run pnpm test."),
          statement: {
            documentId: AGENTS_ID,
            nodeIds: ["node:second"] as never,
            range: sourceRange("source:agents", 15, 29),
            statementId: "statement:second" as never,
            text: "Run pnpm test.",
          },
        },
        {
          count: count("Reference notes only."),
          statement: {
            documentId: DEAD_ID,
            nodeIds: ["node:dead"] as never,
            range: sourceRange("source:dead", 0, 21),
            statementId: "statement:dead" as never,
            text: "Reference notes only.",
          },
        },
      ],
    };
    const result = analyzeContextEfficiencyMetrics(metricInput);
    const projection = {
      amplification: result.amplification.map((metric) => ({
        profileId: metric.profile.profileId,
        target: metric.targets[0],
      })),
      broadScope: result.broadScope.map((metric) => ({
        documents: metric.documents.map((document) => ({
          coverageBasisPoints: document.coverageBasisPoints,
          effectiveTokens: document.effectiveTokens,
          path: document.path,
        })),
        profileId: metric.profile.profileId,
      })),
      deadScope: result.deadScope.map((metric) => ({
        paths: metric.documents.map((document) => document.path),
        profileId: metric.profile.profileId,
        tokens: metric.tokens,
      })),
      density: result.density,
      divergence: result.divergence,
      duplication: result.duplication,
      recordKind: result.recordKind,
      state: result.state,
    };
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as unknown;
    expect(projection).toEqual(golden);
    expect(JSON.stringify(projection)).not.toContain(AGENTS_TEXT);

    const completeMetrics = analyzeContextEfficiencyMetrics({
      ...metricInput,
      comparisons: [],
      profiles: [codexProfile],
    });
    expect(completeMetrics.state).toBe("complete");
    const scoreProjection = reconstructScore(completeMetrics);
    const scoreGolden = JSON.parse(await readFile(SCORE_GOLDEN, "utf8")) as unknown;
    expect(scoreProjection).toEqual(scoreGolden);
    expect(JSON.stringify(scoreProjection)).not.toContain(AGENTS_TEXT);

    const score = calculateContextEfficiencyScore(completeMetrics);
    expect(score).toMatchObject({
      caveatCodes: ["estimated-tokenizer"],
      confidence: "limited-static-evidence",
      grade: "F",
      qualityClaim: false,
      score: 52,
      semanticQualityPreservationClaim: false,
      state: "caveated",
    });
    expect(score.identities.metricsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(score.components[0]?.inputs[0]?.evidence)).toBe(true);
  });
});
