import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import {
  canonicalizeRepositoryRelativePath,
  type InstructionDocumentId,
  type RepositoryRelativePath,
  type SourceRange,
} from "@agent-context/core";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  type ReadOnlyRepository,
} from "@agent-context/evidence";
import type { ClaudeInstructionCandidateSnapshot } from "@agent-context/resolver";
import {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  compareEffectiveContexts,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveEffectiveContext,
  resolveGeminiCliContext,
  sampleTargets,
} from "@agent-context/resolver";
import type {
  DocumentImportDag,
  EffectiveContextResolution,
  TargetSamplingResult,
} from "@agent-context/resolver";
import { describe, expect, test } from "vitest";

import {
  BUILTIN_ESTIMATE_IDENTITY,
  CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
  CONTEXT_EFFICIENCY_METRICS_LIMITS,
  CONTEXT_EFFICIENCY_SCORE_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_SCORE_RECORD_KIND,
  ContextEfficiencyScoreError,
  ContextEfficiencyScoreErrorCode,
  ContextEfficiencyMetricsError,
  ContextEfficiencyMetricsErrorCode,
  accountOccurrenceTokens,
  analyzeContextEfficiencyMetrics,
  calculateContextEfficiencyScore,
  countEstimatedTokens,
  isIssuedContextEfficiencyMetrics,
} from "../src/index.js";
import type {
  AnalyzeContextEfficiencyMetricsInput,
  ContextEfficiencyMetrics,
  EfficiencyMetricDocumentInput,
  EfficiencyMetricProfileInput,
  EfficiencyMetricStatementInput,
  OccurrenceTokenAccounting,
  OccurrenceTokenDecision,
  ProfileTargetAccounting,
  ProfileTargetIdentity,
  TokenCount,
  TokenizerIdentity,
} from "../src/index.js";

const encoder = new TextEncoder();
const SCORE_SCHEMA = new URL("../schemas/context-efficiency-score.v1.schema.json", import.meta.url);
const SPECIFICATION_SCHEMA = new URL(
  "../schemas/efficiency-score-specification.v1.schema.json",
  import.meta.url,
);
const TOKENIZER_SCHEMA = new URL("../schemas/tokenizer-identity.v1.schema.json", import.meta.url);

interface FixtureDocument {
  readonly contentId: string;
  readonly documentId: InstructionDocumentId;
  readonly path: RepositoryRelativePath;
  readonly sourceId: string;
  readonly text: string;
}

interface MutableInput {
  comparisons: AnalyzeContextEfficiencyMetricsInput["comparisons"];
  contractVersion: string;
  documents: EfficiencyMetricDocumentInput[];
  identity: TokenizerIdentity;
  profiles: EfficiencyMetricProfileInput[];
  recordKind: string;
  statements: EfficiencyMetricStatementInput[];
}

const DOCUMENTS: readonly FixtureDocument[] = Object.freeze([
  {
    contentId: `content:${"1".repeat(64)}`,
    documentId: "document:agents" as InstructionDocumentId,
    path: path("AGENTS.md"),
    sourceId: "source:agents",
    text: "Always run pnpm test.\nRepository instructions.\n",
  },
  {
    contentId: `content:${"2".repeat(64)}`,
    documentId: "document:claude" as InstructionDocumentId,
    path: path("CLAUDE.md"),
    sourceId: "source:claude",
    text: "Always run pnpm test.\nClaude instructions.\n",
  },
  {
    contentId: `content:${"3".repeat(64)}`,
    documentId: "document:dead" as InstructionDocumentId,
    path: path("rules/dead.md"),
    sourceId: "source:dead",
    text: "Never edit generated files.\n",
  },
  {
    contentId: `content:${"4".repeat(64)}`,
    documentId: "document:broad" as InstructionDocumentId,
    path: path("rules/broad.md"),
    sourceId: "source:broad",
    text: "Always run pnpm tests.\nShared broad instructions.\n",
  },
]);

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing test fixture: ${label}`);
  return value;
}

function count(value: string, identity = BUILTIN_ESTIMATE_IDENTITY): TokenCount {
  const measured = countEstimatedTokens(value);
  if (!measured.ok) throw new Error("test token fixture exceeded estimate limits");
  return identity === BUILTIN_ESTIMATE_IDENTITY ? measured.value : { ...measured.value, identity };
}

function documentById(documentId: InstructionDocumentId): FixtureDocument {
  const value = DOCUMENTS.find((document) => document.documentId === documentId);
  if (value === undefined) throw new Error("test document is missing");
  return value;
}

function range(sourceId: string, text: string): SourceRange {
  return {
    end: {
      byteOffset: Buffer.byteLength(text, "utf8"),
      line: 1,
      utf16Column: text.length,
      utf16Offset: text.length,
    },
    sourceId,
    start: { byteOffset: 0, line: 1, utf16Column: 0, utf16Offset: 0 },
  } as SourceRange;
}

function statement(
  documentId: InstructionDocumentId,
  statementId: string,
  text: string,
  identity = BUILTIN_ESTIMATE_IDENTITY,
): EfficiencyMetricStatementInput {
  const document = documentById(documentId);
  return {
    count: count(text, identity),
    statement: {
      documentId,
      nodeIds: [`node:${statementId}`] as never,
      range: range(document.sourceId, text),
      statementId: `statement:${statementId}` as never,
      text,
    },
  };
}

function sampling(
  targets: readonly RepositoryRelativePath[],
  partial = false,
  stratified = false,
): TargetSamplingResult {
  return sampleTargets(
    {
      activationObservations: targets.map((target) => ({ path: target, states: [] })),
      criticalPaths: stratified ? [...targets] : [],
      paths: [...targets],
      trackingCertainty: partial ? "all-files-not-tracked" : "tracked",
      trackingReason: partial ? "git-index-missing" : "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    },
    stratified ? { exhaustiveSourceFileLimit: 1 } : undefined,
  );
}

function dag(
  entryId: InstructionDocumentId,
  targetIndex: number,
  repeatBroad: boolean,
  partial: boolean,
): DocumentImportDag {
  const orderedDocuments = [
    documentById(entryId),
    ...DOCUMENTS.filter((document) => document.documentId !== entryId),
  ];
  const occurrences = orderedDocuments.map((document, index) => ({
    contentId: document.contentId,
    depth: index === 0 ? 0 : 1,
    fromDocumentId: index === 0 ? null : entryId,
    id: `occurrence:${String(targetIndex)}:${String(index)}`,
    importId: index === 0 ? null : `import:${String(targetIndex)}:${String(index)}`,
    issueCode: null,
    ordinal: index,
    range: null,
    state: index === 0 ? ("entry" as const) : ("loaded" as const),
    targetDocumentId: document.documentId,
    targetPath: document.path,
  }));
  if (repeatBroad) {
    const broad = documentById("document:broad" as InstructionDocumentId);
    occurrences.push({
      contentId: broad.contentId,
      depth: 1,
      fromDocumentId: entryId,
      id: `occurrence:${String(targetIndex)}:broad-repeat`,
      importId: `import:${String(targetIndex)}:broad-repeat`,
      issueCode: null,
      ordinal: occurrences.length,
      range: null,
      state: "loaded",
      targetDocumentId: broad.documentId,
      targetPath: broad.path,
    });
  }
  return {
    recordKind: "agent-context-document-import-dag",
    contractVersion: "0.1.0",
    contents: DOCUMENTS.map((document) => ({
      byteLength: Buffer.byteLength(document.text, "utf8"),
      documentIds: [document.documentId],
      id: document.contentId,
      sha256: document.contentId.slice("content:".length),
    })),
    documents: DOCUMENTS.map((document) => ({
      byteLength: Buffer.byteLength(document.text, "utf8"),
      contentId: document.contentId,
      depth: document.documentId === entryId ? 0 : 1,
      documentId: document.documentId,
      path: document.path,
      sourceId: document.sourceId,
      state: "loaded" as const,
    })),
    entryDocumentId: entryId,
    entryPath: documentById(entryId).path,
    graphState: partial ? "partial" : "complete",
    issues: partial
      ? [
          {
            code: "IMPORT_GRAPH_READ_FAILED",
            importId: null,
            path: documentById(entryId).path,
            range: null,
            targetPath: path("missing.md"),
          },
        ]
      : [],
    occurrences,
    traceEventIds: [`event:${String(targetIndex)}`],
    traceSha256: ((targetIndex % 15) + 1).toString(16).repeat(64),
  } as unknown as DocumentImportDag;
}

function accounting(
  includedIds: readonly InstructionDocumentId[],
  targetIndex: number,
  repeatBroad = false,
  partial = false,
  identity = BUILTIN_ESTIMATE_IDENTITY,
): OccurrenceTokenAccounting {
  const entryId = includedIds[0];
  if (entryId === undefined) throw new Error("test accounting needs an entry");
  const graph = dag(entryId, targetIndex, repeatBroad, partial);
  const decisions: OccurrenceTokenDecision[] = graph.occurrences.map((occurrence) => {
    const included =
      occurrence.targetDocumentId !== null && includedIds.includes(occurrence.targetDocumentId);
    if (!included) {
      return {
        activation: null,
        count: null,
        disposition:
          partial && occurrence.targetDocumentId === ("document:dead" as InstructionDocumentId)
            ? "unknown"
            : "excluded",
        occurrenceId: occurrence.id,
        sourceBytesConsumed: null,
      };
    }
    const document = documentById(occurrence.targetDocumentId);
    return {
      activation: "always",
      count: count(document.text, identity),
      disposition: "included",
      occurrenceId: occurrence.id,
      sourceBytesConsumed: Buffer.byteLength(document.text, "utf8"),
    };
  });
  return accountOccurrenceTokens({
    dag: graph,
    documentMeasurements: DOCUMENTS.map((document) => ({
      count: count(document.text, identity),
      documentId: document.documentId,
    })),
    identity,
    occurrenceDecisions: decisions,
  });
}

function codex(target: RepositoryRelativePath): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution: resolveCodexCliAgents({
      discovery: {
        certainty: "known",
        entries: [
          {
            bytes: encoder.encode("Always run pnpm test.\n"),
            errorCode: null,
            kind: "file",
            path: path("AGENTS.md"),
            resolvedTarget: null,
          },
        ],
        reason: "G05 unit fixture",
        rootMarkerPaths: [path(".git")],
      },
      externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
      launchCwd: path("."),
      settings: {
        projectDocFallbackFilenames: [],
        projectDocMaxBytes: 32_768,
        projectRootMarkers: [".git"],
      },
      targetPath: target,
    }),
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: target,
  });
}

function claudeCandidate(): ClaudeInstructionCandidateSnapshot {
  return {
    absolutePath: "/repo/CLAUDE.md",
    bytes: encoder.encode("Always run pnpm test.\n"),
    importGraph: null,
    kind: "memory-shared",
    origin: "repository",
    path: path("CLAUDE.md"),
    scopeRoot: path("."),
    symlinkState: "none",
  };
}

function claude(target: RepositoryRelativePath): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution: resolveClaudeCodeProfile({
      candidates: [claudeCandidate()],
      launchCwd: path("."),
      repositoryRoot: path("."),
      runtime: {
        additionalDirectoryInstructions: "disabled",
        clientVersion: "2.1.217",
        eventTrace: [
          { id: "launch", kind: "launch", path: path(".") },
          { id: "read", kind: "read", path: target },
        ],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "supplied",
        mode: "normal",
        settingSources: { state: "known", values: [] },
      },
    }),
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: target,
  });
}

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/g05-fixture",
    inspect: () => Promise.reject(new Error("not used")),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const sourcePath = path(String(value));
      const source = sources[sourcePath];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "fixture source missing",
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

async function geminiWithOptions(
  target: RepositoryRelativePath,
  sourceText: string,
  trustState: "trusted" | "untrusted" | "unknown",
): Promise<EffectiveContextResolution> {
  const profileResolution = await resolveGeminiCliContext({
    boundaryMarkerDirectories: [path(".")],
    candidates: [
      { identity: "directory:.", ignoredBy: [], kind: "directory", path: path(".") },
      { identity: "file:AGENTS.md", ignoredBy: [], kind: "file", path: path("AGENTS.md") },
      { identity: `file:${target}`, ignoredBy: [], kind: "file", path: target },
    ],
    events: [
      { id: "launch", kind: "launch", path: path(".") },
      { id: "read", kind: "read-path", path: target },
    ],
    externalContext: "explicit-synthetic",
    repository: repository({ "AGENTS.md": sourceText }),
    settingsLayers: [
      {
        bytes: encoder.encode(JSON.stringify({ context: { fileName: "AGENTS.md" } })),
        kind: "workspace",
        path: path(".gemini/settings.json"),
        trustState: "trusted",
      },
    ],
    trustState,
    workspaceRoots: [path(".")],
  });
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: target,
  });
}

async function gemini(target: RepositoryRelativePath): Promise<EffectiveContextResolution> {
  return geminiWithOptions(target, "Run a different command.\n", "trusted");
}

function profileIdentity(result: EffectiveContextResolution): ProfileTargetIdentity {
  return {
    clientVersion: result.clientVersion,
    profileId: result.profileId,
    profileVersion: result.profileVersion,
    specSnapshotId: result.specSnapshotId,
    surfaceId: result.surfaceId,
  };
}

function fixture(
  options: { identity?: TokenizerIdentity; partial?: boolean; stratified?: boolean } = {},
): MutableInput {
  const identity = options.identity ?? BUILTIN_ESTIMATE_IDENTITY;
  const targets = [path("src/a.ts"), path("src/b.ts")];
  const codexResults = targets.map(codex);
  const claudeResults = targets.map(claude);
  const firstCodex = codexResults[0];
  const firstClaude = claudeResults[0];
  if (firstCodex === undefined || firstClaude === undefined)
    throw new Error("profile fixture is incomplete");
  const comparisons = targets.map((_, index) =>
    compareEffectiveContexts({
      contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
      recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
      resolutions: [codexResults[index], claudeResults[index]] as EffectiveContextResolution[],
    }),
  );
  const sampled = sampling(targets, options.partial === true, options.stratified === true);
  const codexAccountings: ProfileTargetAccounting[] = targets.map((target, index) => ({
    accounting: accounting(
      ["document:agents", "document:broad"] as InstructionDocumentId[],
      index,
      index === 0,
      options.partial === true && index === 1,
      identity,
    ),
    path: target,
  }));
  const claudeAccountings: ProfileTargetAccounting[] = targets.map((target, index) => ({
    accounting: accounting(
      ["document:claude", "document:broad"] as InstructionDocumentId[],
      index + 2,
      false,
      false,
      identity,
    ),
    path: target,
  }));
  return {
    comparisons,
    contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
    documents: DOCUMENTS.map((document) => ({
      classificationState:
        options.partial === true && document.documentId === "document:dead"
          ? "partial"
          : "complete",
      count: count(document.text, identity),
      documentId: document.documentId,
      path: document.path,
    })),
    identity,
    profiles: [
      { accountings: codexAccountings, profile: profileIdentity(firstCodex), sampling: sampled },
      {
        accountings: claudeAccountings,
        profile: profileIdentity(firstClaude),
        sampling: sampled,
      },
    ] as EfficiencyMetricProfileInput[],
    recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
    statements: [
      statement(
        "document:agents" as InstructionDocumentId,
        "agents",
        "Always run pnpm test.",
        identity,
      ),
      statement(
        "document:claude" as InstructionDocumentId,
        "claude",
        "Always run pnpm test.",
        identity,
      ),
      statement(
        "document:dead" as InstructionDocumentId,
        "dead",
        "Never edit generated files.",
        identity,
      ),
      statement(
        "document:broad" as InstructionDocumentId,
        "broad",
        "Always run pnpm tests.",
        identity,
      ),
      statement(
        "document:broad" as InstructionDocumentId,
        "description",
        "Shared repository notes.",
        identity,
      ),
    ],
  };
}

function analyze(input: MutableInput = fixture()): ContextEfficiencyMetrics {
  return analyzeContextEfficiencyMetrics(input as AnalyzeContextEfficiencyMetricsInput);
}

function scoreMetrics(
  options: { identity?: TokenizerIdentity; partial?: boolean; stratified?: boolean } = {},
): ContextEfficiencyMetrics {
  const input = fixture(options);
  input.comparisons = [];
  input.profiles = input.profiles.slice(0, 1);
  return analyze(input);
}

describe("G05 context-efficiency metrics", () => {
  test("reconciles duplicate, scope, amplification, density, and divergence evidence", () => {
    const result = analyze();

    expect(result.state).toBe("partial");
    expect(result.duplication.exact.clusters).toHaveLength(1);
    expect(result.duplication.exact.redundantTokens).toBe(count("Always run pnpm test.").tokens);
    expect(result.duplication.near.similarity.algorithm).toBe(
      "unicode-code-point-trigram-jaccard-v1",
    );
    expect(result.deadScope.every((metric) => metric.state === "measured")).toBe(true);
    expect(
      result.deadScope.every((metric) =>
        metric.documents.some((document) => document.path === "rules/dead.md"),
      ),
    ).toBe(true);
    expect(
      result.broadScope.every((metric) =>
        metric.documents.some((doc) => doc.path === "rules/broad.md"),
      ),
    ).toBe(true);
    expect(
      result.broadScope
        .flatMap((metric) => metric.documents)
        .find((doc) => doc.path === "rules/broad.md")?.coverageBasisPoints,
    ).toBe(10_000);
    expect(
      result.amplification.find((metric) => metric.profile.profileId === "codex-cli")?.targets[0]
        ?.amplificationBasisPoints,
    ).toBeGreaterThan(10_000);
    expect(result.density.actionableStatementCount).toBe(4);
    expect(result.density.statementCount).toBe(5);
    expect(result.divergence).toMatchObject({
      divergentPairTargetCount: 2,
      expectedPairTargetCount: 2,
      observedPairTargetCount: 2,
      qualityClaim: false,
      semanticEquivalenceClaim: false,
      state: "partial",
    });
    expect(result.divergence.exactRepeatedPolicyTokens).toBeGreaterThan(0);
    expect(result.divergence.observations[0]).toMatchObject({
      equivalenceClaim: false,
      qualityClaim: false,
    });
    expect(JSON.stringify(result)).not.toContain("Repository instructions");
    expect(isIssuedContextEfficiencyMetrics(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.divergence.observations[0]?.paths)).toBe(true);
  });

  test("is byte-deterministic under all accepted input order permutations", () => {
    const first = fixture();
    const second = fixture();
    second.documents.reverse();
    second.statements.reverse();
    second.profiles.reverse();
    second.comparisons = [...second.comparisons].reverse();
    for (const profile of second.profiles)
      (profile.accountings as ProfileTargetAccounting[]).reverse();

    expect(JSON.stringify(analyze(second))).toBe(JSON.stringify(analyze(first)));
  });

  test("retains document, path, range, target, and token provenance for every metric family", () => {
    const result = analyze();
    expect(result.duplication.exact.clusters[0]?.canonical).toMatchObject({
      documentId: "document:agents",
      path: "AGENTS.md",
      statementId: "statement:agents",
      tokens: count("Always run pnpm test.").tokens,
    });
    expect(result.duplication.exact.clusters[0]?.canonical.range).toBeDefined();
    const nearRepresentative = result.duplication.near.clusters[0]?.representative;
    expect(typeof nearRepresentative?.documentId).toBe("string");
    expect(typeof nearRepresentative?.path).toBe("string");

    const dead = result.deadScope[0]?.documents.find(
      (document) => document.path === "rules/dead.md",
    );
    expect(dead).toMatchObject({
      documentId: "document:dead",
      path: "rules/dead.md",
      tokens: count("Never edit generated files.\n").tokens,
    });
    const broad = result.broadScope[0]?.documents.find(
      (document) => document.path === "rules/broad.md",
    );
    expect(broad).toMatchObject({
      documentId: "document:broad",
      path: "rules/broad.md",
      tokens: count("Always run pnpm tests.\nShared broad instructions.\n").tokens,
    });
    expect(broad?.targets.find((target) => target.path === "src/a.ts")?.tokens).toBeGreaterThan(0);

    const amplificationContribution = result.amplification[0]?.targets[0]?.contributions[0];
    expect(typeof amplificationContribution?.documentId).toBe("string");
    expect(typeof amplificationContribution?.path).toBe("string");
    expect(typeof amplificationContribution?.tokens).toBe("number");
    const densityContribution = result.density.documents[0]?.actionableStatements[0];
    expect(typeof densityContribution?.statementId).toBe("string");
    expect(typeof densityContribution?.range.sourceId).toBe("string");
    expect(
      result.divergence.observations
        .flatMap((observation) => observation.paths)
        .some(
          (evidence) =>
            typeof evidence.path === "string" &&
            (evidence.leftTokens !== null || evidence.rightTokens !== null),
        ),
    ).toBe(true);
    expect(
      result.divergence.observations
        .flatMap((observation) => observation.exactRepeatedPolicy)
        .flatMap((cluster) => cluster.members)
        .every(
          (member) =>
            typeof member.documentId === "string" &&
            typeof member.path === "string" &&
            typeof member.tokens === "number" &&
            member.range.sourceId.length > 0,
        ),
    ).toBe(true);
  });

  test("preserves partial sampling, accounting, classification, and missing comparison evidence", () => {
    const input = fixture({ partial: true, stratified: true });
    input.comparisons = input.comparisons.slice(0, 1);
    const result = analyze(input);

    expect(result.state).toBe("partial");
    expect(result.deadScope.every((metric) => metric.state === "unknown")).toBe(true);
    expect(result.deadScope[0]?.tokens).toBeNull();
    expect(result.density.state).toBe("partial");
    const partialProfile = result.amplification.find(
      (metric) => metric.profile.profileId === "codex-cli",
    );
    expect(partialProfile?.state).toBe("partial");
    expect(partialProfile?.targets[1]).toMatchObject({
      amplificationBasisPoints: null,
      repeatedTokens: null,
      state: "partial",
    });
    expect(result.divergence).toMatchObject({
      expectedPairTargetCount: 2,
      observedPairTargetCount: 1,
      state: "partial",
    });
    expect(result.divergence.missing).toEqual([
      expect.objectContaining({ targetPath: "src/b.ts" }),
    ]);
  });

  test("handles empty documents, empty samples, and zero-token amplification without invented values", () => {
    const input = fixture();
    input.comparisons = [];
    input.profiles = [
      {
        accountings: [],
        profile: required(input.profiles[0], "first profile").profile,
        sampling: sampling([]),
      },
    ];
    input.documents = [];
    input.statements = [];
    const result = analyze(input);

    expect(result.state).toBe("complete");
    expect(result.density).toMatchObject({
      actionablePerThousandBasisPoints: null,
      rawTokens: 0,
      state: "empty",
    });
    expect(result.amplification[0]).toMatchObject({
      state: "empty",
      statistics: null,
      targets: [],
    });
    expect(result.divergence).toMatchObject({ expectedPairTargetCount: 0, state: "complete" });
  });

  test("rejects contract, relationship, tokenizer, and hostile container failures", () => {
    const cases: readonly [() => MutableInput, string][] = [
      [
        (): MutableInput => {
          const input = fixture();
          input.contractVersion = "9.0.0";
          return input;
        },
        ContextEfficiencyMetricsErrorCode.invalidInput,
      ],
      [
        (): MutableInput => {
          const input = fixture();
          input.recordKind = "wrong";
          return input;
        },
        ContextEfficiencyMetricsErrorCode.invalidInput,
      ],
      [
        (): MutableInput => {
          const input = fixture();
          input.documents.push(required(input.documents[0], "first document"));
          return input;
        },
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
      ],
      [
        (): MutableInput => {
          const input = fixture();
          input.statements.push(required(input.statements[0], "first statement"));
          return input;
        },
        ContextEfficiencyMetricsErrorCode.invalidRelationship,
      ],
      [
        (): MutableInput => {
          const input = fixture();
          input.identity = { id: "exact", measurement: "exact", version: "1" };
          return input;
        },
        ContextEfficiencyMetricsErrorCode.incompatibleTokenizer,
      ],
    ];
    for (const [create, code] of cases)
      expect(() => analyze(create())).toThrow(expect.objectContaining({ code }));

    const proxy = new Proxy(fixture(), {});
    expect(() =>
      analyzeContextEfficiencyMetrics(proxy as unknown as AnalyzeContextEfficiencyMetricsInput),
    ).toThrow(ContextEfficiencyMetricsError);
    const sparse = fixture();
    sparse.documents.length += 1;
    expect(() => analyze(sparse)).toThrow(
      expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.invalidInput }),
    );
    const accessor = fixture();
    Object.defineProperty(accessor, "documents", { enumerable: true, get: () => [] });
    expect(() => analyze(accessor)).toThrow(
      expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.invalidInput }),
    );
    expect(isIssuedContextEfficiencyMetrics({})).toBe(false);
  });

  test("rejects forged E07 evidence and mismatched profile/accounting relationships", () => {
    const forged = fixture();
    const comparison = forged.comparisons[0];
    if (comparison === undefined) throw new Error("comparison fixture is missing");
    forged.comparisons = [structuredClone(comparison)];
    expect(() => analyze(forged)).toThrow(
      expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.invalidInput }),
    );

    const mismatched = fixture();
    const firstDocument = mismatched.documents[0];
    if (firstDocument === undefined) throw new Error("test document missing");
    mismatched.documents[0] = { ...firstDocument, path: path("other.md") };
    expect(() => analyze(mismatched)).toThrow(
      expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.invalidRelationship }),
    );
  });

  test("fails closed for malformed document, statement, profile, and tokenizer records", () => {
    function invalid(
      mutator: (input: MutableInput) => void,
      code: string = ContextEfficiencyMetricsErrorCode.invalidInput,
    ): void {
      const input = fixture();
      mutator(input);
      expect(() => analyze(input)).toThrow(expect.objectContaining({ code }));
    }

    const extra = { ...fixture(), extra: true };
    expect(() =>
      analyzeContextEfficiencyMetrics(extra as unknown as AnalyzeContextEfficiencyMetricsInput),
    ).toThrow(expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.invalidInput }));
    invalid((input) => {
      input.documents = {} as never;
    });
    invalid((input) => {
      Object.defineProperty(input.documents, "0", {
        enumerable: true,
        get: () => input.documents[1],
      });
    });
    invalid((input) => {
      const document = input.documents[0];
      if (document === undefined) throw new Error("document fixture missing");
      input.documents[0] = { ...document, classificationState: "invalid" as never };
    });
    invalid((input) => {
      const document = input.documents[0];
      if (document === undefined) throw new Error("document fixture missing");
      input.documents[0] = { ...document, documentId: "bad id" as never };
    });
    invalid((input) => {
      const document = input.documents[0];
      if (document === undefined) throw new Error("document fixture missing");
      input.documents[0] = { ...document, path: "." as never };
    });
    invalid((input) => {
      const document = input.documents[0];
      if (document === undefined) throw new Error("document fixture missing");
      input.documents[0] = {
        ...document,
        count: { ...document.count, contractVersion: "9.0.0" as never },
      };
    });
    invalid((input) => {
      const document = input.documents[0];
      if (document === undefined) throw new Error("document fixture missing");
      input.documents[0] = { ...document, count: { ...document.count, tokens: -1 } };
    });
    invalid((input) => {
      const item = input.statements[0];
      if (item === undefined) throw new Error("statement fixture missing");
      input.statements[0] = {
        ...item,
        statement: { ...item.statement, text: Symbol("hostile") as never },
      };
    });
    invalid((input) => {
      const item = input.statements[0];
      if (item === undefined) throw new Error("statement fixture missing");
      input.statements[0] = {
        ...item,
        statement: {
          ...item.statement,
          documentId: "document:missing" as InstructionDocumentId,
        },
      };
    }, ContextEfficiencyMetricsErrorCode.invalidRelationship);
    invalid((input) => {
      const item = input.statements[0];
      if (item === undefined) throw new Error("statement fixture missing");
      input.statements[0] = {
        ...item,
        count: { ...item.count, inputCodeUnits: item.count.inputCodeUnits + 1 },
      };
    }, ContextEfficiencyMetricsErrorCode.invalidRelationship);
    invalid((input) => {
      input.profiles = [];
    }, ContextEfficiencyMetricsErrorCode.invalidRelationship);
    invalid((input) => {
      const profile = input.profiles[0];
      if (profile === undefined) throw new Error("profile fixture missing");
      input.profiles[0] = { ...profile, accountings: [] };
    });
    invalid((input) => {
      const profile = input.profiles[0];
      if (profile === undefined) throw new Error("profile fixture missing");
      input.profiles.push(profile);
    }, ContextEfficiencyMetricsErrorCode.invalidRelationship);
    invalid((input) => {
      input.identity = { id: "bad id", measurement: "estimate", version: "1" };
    });
  });

  test("validates cross-profile coverage without fabricating missing pair evidence", () => {
    const duplicate = fixture();
    duplicate.comparisons = [duplicate.comparisons[0], duplicate.comparisons[0]] as never;
    expect(() => analyze(duplicate)).toThrow(
      expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.invalidRelationship }),
    );

    const mismatchedProfile = fixture();
    const profile = mismatchedProfile.profiles[0];
    if (profile === undefined) throw new Error("profile fixture missing");
    mismatchedProfile.profiles[0] = {
      ...profile,
      profile: { ...profile.profile, specSnapshotId: "snapshot:other" },
    };
    expect(() => analyze(mismatchedProfile)).toThrow(
      expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.invalidRelationship }),
    );

    const missing = fixture();
    missing.comparisons = [];
    expect(analyze(missing).divergence.missing.map((item) => item.targetPath)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);

    const disjoint = fixture();
    disjoint.comparisons = [];
    const first = disjoint.profiles[0];
    const second = disjoint.profiles[1];
    if (first === undefined || second === undefined) throw new Error("profile fixture missing");
    disjoint.profiles = [
      {
        ...first,
        accountings: first.accountings.slice(0, 1),
        sampling: sampling([path("src/a.ts")]),
      },
      {
        ...second,
        accountings: second.accountings.slice(1),
        sampling: sampling([path("src/b.ts")]),
      },
    ];
    expect(analyze(disjoint).divergence).toMatchObject({
      expectedPairTargetCount: 0,
      observedPairTargetCount: 0,
      state: "complete",
    });

    const absentTarget = fixture();
    const absentComparison = absentTarget.comparisons[1];
    if (absentComparison === undefined) throw new Error("comparison fixture missing");
    absentTarget.comparisons = [absentComparison];
    absentTarget.profiles = absentTarget.profiles.map((item) => ({
      ...item,
      accountings: item.accountings.slice(0, 1),
      sampling: sampling([path("src/a.ts")]),
    }));
    expect(() => analyze(absentTarget)).toThrow(
      expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.invalidRelationship }),
    );

    const sameTargetPairs = fixture();
    sameTargetPairs.comparisons = [];
    const left = sameTargetPairs.profiles[0];
    const right = sameTargetPairs.profiles[1];
    if (left === undefined || right === undefined) throw new Error("profile fixture missing");
    const targetSampling = sampling([path("src/a.ts")]);
    sameTargetPairs.profiles = [
      { ...left, accountings: left.accountings.slice(0, 1), sampling: targetSampling },
      { ...right, accountings: right.accountings.slice(0, 1), sampling: targetSampling },
      {
        ...right,
        accountings: right.accountings.slice(0, 1),
        profile: {
          clientVersion: null,
          profileId: "fixture-third",
          profileVersion: "0.1.0",
          specSnapshotId: "fixture-third/2026-08-02",
          surfaceId: "fixture-third/local",
        },
        sampling: targetSampling,
      },
    ];
    expect(analyze(sameTargetPairs).divergence.missing).toHaveLength(3);
  });

  test("links same-path content divergence without treating it as semantic inequality", async () => {
    const input = fixture();
    const targets = [path("src/a.ts"), path("src/b.ts")];
    const codexResults = targets.map(codex);
    const geminiResults = await Promise.all(targets.map(gemini));
    const codexProfile = input.profiles.find(
      (profile) => profile.profile.profileId === "codex-cli",
    );
    if (codexProfile === undefined) throw new Error("Codex profile fixture missing");
    input.profiles = [
      codexProfile,
      {
        accountings: codexProfile.accountings,
        profile: profileIdentity(required(geminiResults[0], "first Gemini result")),
        sampling: codexProfile.sampling,
      },
    ];
    input.comparisons = targets.map((_, index) =>
      compareEffectiveContexts({
        contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
        recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
        resolutions: [
          required(codexResults[index], `Codex result ${String(index)}`),
          required(geminiResults[index], `Gemini result ${String(index)}`),
        ],
      }),
    );

    const result = analyze(input);
    const evidence = result.divergence.observations[0]?.paths.find(
      (item) => item.path === "AGENTS.md",
    );
    expect(evidence).toMatchObject({
      kinds: ["content-different"],
      leftState: "included",
      rightState: "included",
    });
    expect(result.divergence.observations[0]).toMatchObject({
      equivalenceClaim: false,
      qualityClaim: false,
      state: "divergent",
    });
    expect(result.divergence.observations[0]?.contentDifferentEffectiveTokens).toBeGreaterThan(0);
    expect(result.divergence.observations[0]?.exactRepeatedPolicy).toEqual([]);
  });

  test("represents zero-token loaded context as non-applicable amplification", () => {
    const emptyDocument: FixtureDocument = {
      contentId: `content:${"9".repeat(64)}`,
      documentId: "document:empty" as InstructionDocumentId,
      path: path("EMPTY.md"),
      sourceId: "source:empty",
      text: "",
    };
    const target = path("src/empty.ts");
    const emptyCount = count("");
    const emptyDag = {
      recordKind: "agent-context-document-import-dag",
      contractVersion: "0.1.0",
      contents: [
        {
          byteLength: 0,
          documentIds: [emptyDocument.documentId],
          id: emptyDocument.contentId,
          sha256: "9".repeat(64),
        },
      ],
      documents: [
        {
          byteLength: 0,
          contentId: emptyDocument.contentId,
          depth: 0,
          documentId: emptyDocument.documentId,
          path: emptyDocument.path,
          sourceId: emptyDocument.sourceId,
          state: "loaded",
        },
      ],
      entryDocumentId: emptyDocument.documentId,
      entryPath: emptyDocument.path,
      graphState: "complete",
      issues: [],
      occurrences: [
        {
          contentId: emptyDocument.contentId,
          depth: 0,
          fromDocumentId: null,
          id: "occurrence:empty",
          importId: null,
          issueCode: null,
          ordinal: 0,
          range: null,
          state: "entry",
          targetDocumentId: emptyDocument.documentId,
          targetPath: emptyDocument.path,
        },
      ],
      traceEventIds: ["event:empty"],
      traceSha256: "9".repeat(64),
    } as unknown as DocumentImportDag;
    const emptyAccounting = accountOccurrenceTokens({
      dag: emptyDag,
      documentMeasurements: [{ count: emptyCount, documentId: emptyDocument.documentId }],
      identity: BUILTIN_ESTIMATE_IDENTITY,
      occurrenceDecisions: [
        {
          activation: "always",
          count: emptyCount,
          disposition: "included",
          occurrenceId: "occurrence:empty",
          sourceBytesConsumed: 0,
        },
      ],
    });
    const base = fixture();
    const input: MutableInput = {
      comparisons: [],
      contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
      documents: [
        {
          classificationState: "complete",
          count: emptyCount,
          documentId: emptyDocument.documentId,
          path: emptyDocument.path,
        },
      ],
      identity: BUILTIN_ESTIMATE_IDENTITY,
      profiles: [
        {
          accountings: [{ accounting: emptyAccounting, path: target }],
          profile: { ...base.profiles[0]?.profile, clientVersion: null } as ProfileTargetIdentity,
          sampling: sampling([target]),
        },
      ],
      recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
      statements: [],
    };
    const result = analyze(input);

    expect(result.density.documents[0]).toMatchObject({ state: "empty", tokens: 0 });
    expect(result.amplification[0]?.targets[0]).toMatchObject({
      amplificationBasisPoints: null,
      effectiveTokens: 0,
      repeatedTokens: 0,
      state: "not-applicable",
      uniqueTokens: 0,
    });
    expect(result.broadScope[0]?.documents[0]).toMatchObject({
      coverageBasisPoints: 10_000,
      effectiveTokens: 0,
    });
  });

  test("retains unobserved-document and stratified-sample uncertainty independently", () => {
    const input = fixture();
    input.comparisons = [];
    input.documents.push({
      classificationState: "complete",
      count: count("Unobserved."),
      documentId: "document:unobserved" as InstructionDocumentId,
      path: path("rules/unobserved.md"),
    });
    input.profiles = input.profiles.map((profile) => ({
      ...profile,
      sampling: { ...profile.sampling, strategy: "stratified" },
    }));

    const result = analyze(input);
    expect(result.deadScope.every((metric) => metric.state === "unknown")).toBe(true);
    expect(result.deadScope[0]?.reasonCodes).toEqual([
      "sample-not-exhaustive",
      "documents-unobserved",
    ]);
    expect(result.deadScope[0]?.unobservedDocuments).toEqual([
      expect.objectContaining({
        documentId: "document:unobserved",
        path: "rules/unobserved.md",
        tokens: count("Unobserved.").tokens,
      }),
    ]);
    expect(
      result.broadScope.every(
        (metric) => !metric.documents.some((document) => document.path === "rules/unobserved.md"),
      ),
    ).toBe(true);
  });

  test("does not calculate breadth from a sample with no complete target observations", () => {
    const input = fixture({ partial: true });
    input.comparisons = [];
    const codexProfile = input.profiles.find(
      (profile) => profile.profile.profileId === "codex-cli",
    );
    if (codexProfile === undefined) throw new Error("Codex profile fixture missing");
    input.profiles = [
      {
        ...codexProfile,
        accountings: codexProfile.accountings.slice(1),
        sampling: sampling([path("src/b.ts")], true),
      },
    ];

    const result = analyze(input);
    expect(result.broadScope[0]?.documents.every((document) => document.state === "unknown")).toBe(
      true,
    );
    expect(
      result.broadScope[0]?.documents.every(
        (document) => document.coverageBasisPoints === null && document.completeTargetCount === 0,
      ),
    ).toBe(true);
  });

  test("rejects safe-integer overflow rather than wrapping aggregate token metrics", () => {
    const input = fixture();
    input.comparisons = [];
    input.profiles = [
      {
        accountings: [],
        profile: required(input.profiles[0], "first profile").profile,
        sampling: sampling([]),
      },
    ];
    input.statements = [];
    input.documents = input.documents.slice(0, 2).map((document) => ({
      ...document,
      count: { ...document.count, tokens: Number.MAX_SAFE_INTEGER },
    }));
    expect(() => analyze(input)).toThrow(
      expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.resourceLimit }),
    );
  });

  test("enforces aggregate resource bounds before materializing unbounded evidence", () => {
    const input = fixture();
    input.profiles = Array.from(
      { length: CONTEXT_EFFICIENCY_METRICS_LIMITS.maximumProfiles + 1 },
      () => required(input.profiles[0], "first profile"),
    );
    expect(() => analyze(input)).toThrow(
      expect.objectContaining({ code: ContextEfficiencyMetricsErrorCode.resourceLimit }),
    );
  });
});

describe("G07 context-efficiency scores", () => {
  test("calculates every component and validates the immutable result against the closed schema", () => {
    const metrics = scoreMetrics();
    const first = calculateContextEfficiencyScore(metrics);
    const second = calculateContextEfficiencyScore(metrics, {});

    expect(first).toMatchObject({
      caveatCodes: ["estimated-tokenizer"],
      confidence: "limited-static-evidence",
      contractVersion: CONTEXT_EFFICIENCY_SCORE_CONTRACT_VERSION,
      qualityClaim: false,
      recordKind: CONTEXT_EFFICIENCY_SCORE_RECORD_KIND,
      semanticQualityPreservationClaim: false,
      state: "caveated",
    });
    expect(first.score).toEqual(expect.any(Number));
    expect(first.grade).toMatch(/^[ABCDF]$/u);
    expect(first.components.map((component) => component.id)).toEqual([
      "budgetFit",
      "scopePrecision",
      "nonRedundancy",
      "reachability",
      "instructionDensity",
      "crossAgentConsistency",
    ]);
    expect(first.components.every((component) => component.score !== null)).toBe(true);
    expect(first.components.flatMap((component) => component.inputs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          denominator: 2_500,
          id: "always-on-p95-budget",
          state: "complete",
        }),
        expect.objectContaining({ id: "broad-scope-token-share", state: "complete" }),
        expect.objectContaining({ id: "dead-scope-token-share", state: "complete" }),
      ]),
    );
    const evidence = first.components.flatMap((component) =>
      component.inputs.flatMap((input) => input.evidence),
    );
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "broad-scope-document", valueUnit: "basis-points" }),
        expect.objectContaining({ id: "cross-profile-divergence", valueUnit: "count" }),
      ]),
    );
    expect(evidence.every((item) => item.value !== null || item.valueUnit === null)).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(
      typeof first.components
        .flatMap((component) => component.inputs)
        .find((input) => input.id === "always-on-p95-budget")?.numerator,
    ).toBe("number");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.configuration.componentWeights)).toBe(true);
    expect(first.identities.configurationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.identities.metricsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.identities.specificationSha256).toMatch(/^[a-f0-9]{64}$/u);

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(JSON.parse(readFileSync(TOKENIZER_SCHEMA, "utf8")) as AnySchema);
    ajv.addSchema(JSON.parse(readFileSync(SPECIFICATION_SCHEMA, "utf8")) as AnySchema);
    const validate = ajv.compile(JSON.parse(readFileSync(SCORE_SCHEMA, "utf8")) as AnySchema);
    expect(validate(first), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...first, qualityClaim: true })).toBe(false);
    expect(validate({ ...first, surprise: true })).toBe(false);
  });

  test("reports complete confidence for exhaustive evidence with an exact tokenizer identity", () => {
    const exactIdentity: TokenizerIdentity = {
      id: "test.exact-tokenizer",
      measurement: "exact",
      version: "1.0.0",
    };
    const result = calculateContextEfficiencyScore(scoreMetrics({ identity: exactIdentity }));

    expect(result).toMatchObject({
      caveatCodes: [],
      confidence: "complete-static-evidence",
      state: "complete",
      tokenizer: exactIdentity,
      uncertaintyCodes: [],
    });
    expect(result.grade).toMatch(/^[ABCDF]$/u);
    expect(typeof result.score).toBe("number");
  });

  test("propagates partial and unobserved evidence without inventing a score", () => {
    const partial = calculateContextEfficiencyScore(analyze(fixture({ partial: true })));

    expect(partial).toMatchObject({
      confidence: "unavailable",
      grade: null,
      score: null,
      state: "unavailable",
    });
    expect(partial.uncertaintyCodes).toEqual(
      expect.arrayContaining([
        "amplification-partial",
        "broad-scope-partial",
        "dead-scope-unknown",
        "density-partial",
        "distribution-partial",
        "divergence-partial",
        "sampling-partial",
      ]),
    );
    expect(
      partial.components
        .flatMap((component) => component.inputs)
        .filter((input) => input.state === "unavailable")
        .every(
          (input) =>
            input.inputBasisPoints === null &&
            input.penaltyBasisPoints === null &&
            input.numerator === null &&
            input.denominator === null &&
            input.reasonCodes.length > 0,
        ),
    ).toBe(true);
  });

  test("propagates a real E07 indeterminate pair into an unavailable consistency score", async () => {
    const target = path("src/a.ts");
    const codexResult = codex(target);
    const geminiResult = await geminiWithOptions(target, "Always run pnpm test.\n", "unknown");
    const comparison = compareEffectiveContexts({
      contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
      recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
      resolutions: [codexResult, geminiResult],
    });
    expect(comparison.pairs[0]?.overall).toBe("indeterminate");

    const input = fixture();
    const firstProfile = required(input.profiles[0], "first profile");
    const secondProfile = required(input.profiles[1], "second profile");
    input.comparisons = [comparison];
    input.profiles = [
      {
        accountings: firstProfile.accountings.slice(0, 1),
        profile: profileIdentity(codexResult),
        sampling: sampling([target]),
      },
      {
        accountings: secondProfile.accountings.slice(0, 1),
        profile: profileIdentity(geminiResult),
        sampling: sampling([target]),
      },
    ];
    const result = calculateContextEfficiencyScore(analyze(input));

    expect(result.score).toBeNull();
    expect(result.uncertaintyCodes).toEqual(
      expect.arrayContaining(["divergence-indeterminate", "divergence-partial"]),
    );
    expect(
      result.components.find((component) => component.id === "crossAgentConsistency"),
    ).toMatchObject({
      reasonCodes: ["divergence-indeterminate", "divergence-partial"],
      score: null,
      state: "unavailable",
    });
  });

  test("keeps sampled evidence explicit and lets only zero-weight uncertainty be ignored", () => {
    const metrics = scoreMetrics({ stratified: true });
    const result = calculateContextEfficiencyScore(metrics, {
      componentWeights: {
        budgetFit: 40,
        crossAgentConsistency: 5,
        instructionDensity: 10,
        nonRedundancy: 20,
        reachability: 0,
        scopePrecision: 25,
      },
    });

    expect(result.score).toEqual(expect.any(Number));
    expect(result.state).toBe("caveated");
    expect(result.confidence).toBe("limited-static-evidence");
    expect(result.caveatCodes).toEqual([
      "estimated-tokenizer",
      "sampling-stratified",
      "zero-weight-component-unavailable",
    ]);
    expect(result.components.find((component) => component.id === "reachability")).toMatchObject({
      reasonCodes: ["dead-scope-unknown"],
      score: null,
      scoreBasisPoints: null,
      state: "ignored-unavailable",
      weight: 0,
    });
    expect(
      result.components
        .flatMap((component) => component.inputs)
        .some((input) => input.state === "sampled"),
    ).toBe(true);
  });

  test("treats complete empty metric families as neutral but an empty target distribution as unknown", () => {
    const input = fixture();
    input.comparisons = [];
    input.profiles = [
      {
        accountings: [],
        profile: required(input.profiles[0], "first profile").profile,
        sampling: sampling([]),
      },
    ];
    input.documents = [];
    input.statements = [];
    const result = calculateContextEfficiencyScore(analyze(input));

    expect(result.score).toBeNull();
    expect(result.uncertaintyCodes).toEqual(["distribution-empty"]);
    expect(
      result.components
        .flatMap((component) => component.inputs)
        .find((input) => input.id === "instruction-density-shortfall"),
    ).toMatchObject({ denominator: 0, inputBasisPoints: 0, numerator: 0 });
    expect(
      result.components
        .flatMap((component) => component.inputs)
        .find((input) => input.id === "import-amplification-overhead"),
    ).toMatchObject({ denominator: 0, inputBasisPoints: 0, numerator: 0 });
  });

  test("applies custom budgets, weights, thresholds, and configuration identity deterministically", () => {
    const metrics = scoreMetrics();
    const defaults = calculateContextEfficiencyScore(metrics);
    const configured = calculateContextEfficiencyScore(metrics, {
      budgets: { alwaysOnTokens: 0, effectiveP95Tokens: 1 },
      gradeThresholds: { A: 100, B: 99, C: 98, D: 0 },
    });

    expect(configured.configuration.budgets).toMatchObject({
      alwaysOnTokens: 0,
      effectiveP95Tokens: 1,
    });
    expect(configured.components[0]?.inputs.map((input) => input.inputBasisPoints)).toEqual([
      1_000_000, 380_000,
    ]);
    expect(configured.grade).toBe("D");
    expect(configured.identities.configurationSha256).not.toBe(
      defaults.identities.configurationSha256,
    );
    expect(configured.identities.metricsSha256).toBe(defaults.identities.metricsSha256);
  });

  test("rejects forged metrics and hostile configuration containers before property execution", () => {
    for (const value of [{}, structuredClone(scoreMetrics()), new Proxy({}, {})]) {
      expect(() => calculateContextEfficiencyScore(value)).toThrow(ContextEfficiencyScoreError);
      expect(() => calculateContextEfficiencyScore(value)).toThrow(
        expect.objectContaining({ code: ContextEfficiencyScoreErrorCode.invalidMetrics }),
      );
    }

    let calls = 0;
    const hostile = Object.defineProperty({}, "budgets", {
      enumerable: true,
      get: () => {
        calls += 1;
        return {};
      },
    });
    expect(() => calculateContextEfficiencyScore(scoreMetrics(), hostile)).toThrow(
      expect.objectContaining({ code: "EFFICIENCY_SCORE_INVALID_CONFIGURATION" }),
    );
    expect(calls).toBe(0);
  });
});
