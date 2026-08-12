import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type {
  InstructionDocumentId,
  RepositoryRelativePath,
  SourceRange,
} from "@agent-context/core";
import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  resolveCodexCliAgents,
  resolveEffectiveContext,
  sampleTargets,
} from "@agent-context/resolver";
import type { DocumentImportDag, ResolveEffectiveContextInput } from "@agent-context/resolver";
import { describe, expect, test } from "vitest";

import {
  BUILTIN_ESTIMATE_IDENTITY,
  CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS,
  CONTEXT_EFFICIENCY_REPORT_LIMITS,
  CONTEXT_EFFICIENCY_REPORT_RECORD_KIND,
  ContextEfficiencyRecommendationsError,
  ContextEfficiencyRecommendationsErrorCode,
  ContextEfficiencyReportError,
  ContextEfficiencyReportErrorCode,
  accountOccurrenceTokens,
  analyzeContextEfficiencyMetrics,
  calculateContextEfficiencyScore,
  compareContextEfficiencyReports,
  countEstimatedTokens,
  createContextEfficiencyReport,
  isIssuedContextEfficiencyComparison,
  isIssuedContextEfficiencyReport,
  isIssuedContextEfficiencyRecommendations,
  projectContextEfficiencyRecommendations,
  renderContextEfficiencyTerminal,
  serializeContextEfficiencyJson,
  writeContextEfficiencyJson,
} from "../src/index.js";
import type {
  AnalyzeContextEfficiencyMetricsInput,
  ContextEfficiencyMetrics,
  ContextEfficiencyRecommendations,
  ContextEfficiencyReport,
  ContextEfficiencyScore,
  EfficiencyRecommendationScenario,
  ProfileTargetAccounting,
  TokenCount,
} from "../src/index.js";

const encoder = new TextEncoder();
const SCHEMA = new URL(
  "../schemas/context-efficiency-recommendations.v1.schema.json",
  import.meta.url,
);
const GOLDEN = new URL(
  "../../../conformance/fixtures/v0/context-efficiency-recommendations.golden.json",
  import.meta.url,
);
const REPORT_SCHEMA = new URL(
  "../schemas/context-efficiency-report.v1.schema.json",
  import.meta.url,
);
const COMPARISON_SCHEMA = new URL(
  "../schemas/context-efficiency-comparison.v1.schema.json",
  import.meta.url,
);
const SCORE_SCHEMA = new URL("../schemas/context-efficiency-score.v1.schema.json", import.meta.url);
const SPECIFICATION_SCHEMA = new URL(
  "../schemas/efficiency-score-specification.v1.schema.json",
  import.meta.url,
);
const TOKENIZER_SCHEMA = new URL("../schemas/tokenizer-identity.v1.schema.json", import.meta.url);
const REPORT_GOLDEN = new URL(
  "../../../conformance/fixtures/v0/context-efficiency-report.golden.json",
  import.meta.url,
);
const TERMINAL_GOLDEN = new URL(
  "../../../conformance/fixtures/v0/context-efficiency-report.terminal.golden.txt",
  import.meta.url,
);

interface ContextFixture {
  readonly input: ResolveEffectiveContextInput;
  readonly sourceDocumentIds: readonly InstructionDocumentId[];
}

interface AnalysisFixture {
  readonly metrics: ContextEfficiencyMetrics;
  readonly score: ContextEfficiencyScore;
  readonly sourceDocumentId: InstructionDocumentId;
  readonly targets: readonly RepositoryRelativePath[];
}

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function count(text: string): TokenCount {
  const result = countEstimatedTokens(text);
  if (!result.ok) throw new Error("fixture token count failed");
  return result.value;
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function range(sourceId: string, text: string): SourceRange {
  const lines = text.split("\n");
  return {
    end: {
      byteOffset: Buffer.byteLength(text, "utf8"),
      line: lines.length,
      utf16Column: lines.at(-1)?.length ?? 0,
      utf16Offset: text.length,
    },
    sourceId,
    start: { byteOffset: 0, line: 1, utf16Column: 0, utf16Offset: 0 },
  } as SourceRange;
}

function context(
  targetPath: RepositoryRelativePath,
  entries: readonly { readonly content: string; readonly path: RepositoryRelativePath }[],
  externalContext: "supplied" | "unavailable" = "supplied",
): ContextFixture {
  const profileResolution = resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: entries.map((entry) => ({
        bytes: encoder.encode(entry.content),
        errorCode: null,
        kind: "file" as const,
        path: entry.path,
        resolvedTarget: null,
      })),
      reason: "G08 synthetic read-only snapshot",
      rootMarkerPaths: [path(".git")],
    },
    externalContext:
      externalContext === "supplied"
        ? { globalBase: null, globalOverride: null, mode: "supplied" as const }
        : { mode: "unavailable" as const },
    launchCwd: path("src"),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath,
  });
  const input: ResolveEffectiveContextInput = {
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath,
  };
  const resolution = resolveEffectiveContext(input);
  return {
    input,
    sourceDocumentIds: resolution.documents
      .map((document) => document.sourceDocumentId)
      .filter((id): id is InstructionDocumentId => id !== null),
  };
}

function accounting(
  targetIndex: number,
  documents: readonly {
    readonly documentId: InstructionDocumentId;
    readonly path: RepositoryRelativePath;
    readonly text: string;
  }[],
): ProfileTargetAccounting["accounting"] {
  const entry = documents[0];
  if (entry === undefined) throw new Error("fixture needs an entry document");
  const documentsByDigest = new Map<string, typeof documents>();
  for (const document of documents) {
    const digest = hash(document.text);
    documentsByDigest.set(digest, [...(documentsByDigest.get(digest) ?? []), document]);
  }
  const dag = {
    recordKind: "agent-context-document-import-dag",
    contractVersion: "0.1.0",
    contents: [...documentsByDigest].map(([digest, members]) => ({
      byteLength: Buffer.byteLength(members[0]?.text ?? "", "utf8"),
      documentIds: members.map((document) => document.documentId),
      id: `content:${digest}`,
      sha256: digest,
    })),
    documents: documents.map((document, index) => ({
      byteLength: Buffer.byteLength(document.text, "utf8"),
      contentId: `content:${hash(document.text)}`,
      depth: index === 0 ? 0 : 1,
      documentId: document.documentId,
      path: document.path,
      sourceId: `source:${String(index)}`,
      state: "loaded" as const,
    })),
    entryDocumentId: entry.documentId,
    entryPath: entry.path,
    graphState: "complete",
    issues: [],
    occurrences: documents.map((document, index) => ({
      contentId: `content:${hash(document.text)}`,
      depth: index === 0 ? 0 : 1,
      fromDocumentId: index === 0 ? null : entry.documentId,
      id: `occurrence:${String(targetIndex)}:${String(index)}`,
      importId: index === 0 ? null : `import:${String(targetIndex)}:${String(index)}`,
      issueCode: null,
      ordinal: index,
      range: null,
      state: index === 0 ? ("entry" as const) : ("loaded" as const),
      targetDocumentId: document.documentId,
      targetPath: document.path,
    })),
    traceEventIds: [`event:${String(targetIndex)}`],
    traceSha256: (targetIndex + 1).toString(16).repeat(64),
  } as unknown as DocumentImportDag;
  return accountOccurrenceTokens({
    dag,
    documentMeasurements: documents.map((document) => ({
      count: count(document.text),
      documentId: document.documentId,
    })),
    identity: BUILTIN_ESTIMATE_IDENTITY,
    occurrenceDecisions: documents.map((document, index) => ({
      activation: "always" as const,
      count: count(document.text),
      disposition: "included" as const,
      occurrenceId: `occurrence:${String(targetIndex)}:${String(index)}`,
      sourceBytesConsumed: Buffer.byteLength(document.text, "utf8"),
    })),
  });
}

function analysisFixture(
  targets: readonly RepositoryRelativePath[] = [path("src/web.ts"), path("src/api.ts")],
): AnalysisFixture {
  const text = "Use the shared formatter.\n";
  const firstTarget = targets[0];
  if (firstTarget === undefined) throw new Error("first target missing");
  const baseline = context(firstTarget, [{ content: text, path: path("AGENTS.md") }]);
  const sourceDocumentId = baseline.sourceDocumentIds[0];
  if (sourceDocumentId === undefined) throw new Error("source document identity missing");
  const firstResolution = resolveEffectiveContext(baseline.input);
  const sample = sampleTargets({
    activationObservations: targets.map((target) => ({ path: target, states: [] })),
    criticalPaths: [],
    paths: [...targets],
    trackingCertainty: "tracked",
    trackingReason: "verified-git-index",
    workspaceBoundaries: [],
    workspaceUncertainty: "known",
    workspaceUncertaintyReasons: [],
  });
  const accountings = targets.map((target, index) => ({
    accounting: accounting(index, [
      { documentId: sourceDocumentId, path: path("AGENTS.md"), text },
    ]),
    path: target,
  }));
  const input: AnalyzeContextEfficiencyMetricsInput = {
    comparisons: [],
    contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
    documents: [
      {
        classificationState: "complete",
        count: count(text),
        documentId: sourceDocumentId,
        path: path("AGENTS.md"),
      },
    ],
    identity: BUILTIN_ESTIMATE_IDENTITY,
    profiles: [
      {
        accountings,
        profile: {
          clientVersion: firstResolution.clientVersion,
          profileId: firstResolution.profileId,
          profileVersion: firstResolution.profileVersion,
          specSnapshotId: firstResolution.specSnapshotId,
          surfaceId: firstResolution.surfaceId,
        },
        sampling: sample,
      },
    ],
    recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
    statements: [],
  };
  const metrics = analyzeContextEfficiencyMetrics(input);
  return { metrics, score: calculateContextEfficiencyScore(metrics), sourceDocumentId, targets };
}

function duplicateFixture(): {
  readonly metrics: ContextEfficiencyMetrics;
  readonly scenario: EfficiencyRecommendationScenario;
  readonly score: ContextEfficiencyScore;
} {
  const text = "Run tests now.\n";
  const target = path("src/web.ts");
  const baseline = context(target, [
    { content: text, path: path("AGENTS.md") },
    { content: text, path: path("src/AGENTS.md") },
  ]);
  const sourceDocumentIds = [...baseline.sourceDocumentIds].sort();
  const firstId = sourceDocumentIds[0];
  const secondId = sourceDocumentIds[1];
  if (firstId === undefined || secondId === undefined) throw new Error("duplicate IDs missing");
  const resolution = resolveEffectiveContext(baseline.input);
  const sample = sampleTargets({
    activationObservations: [{ path: target, states: [] }],
    criticalPaths: [],
    paths: [target],
    trackingCertainty: "tracked",
    trackingReason: "verified-git-index",
    workspaceBoundaries: [],
    workspaceUncertainty: "known",
    workspaceUncertaintyReasons: [],
  });
  const documents = [
    { documentId: firstId, path: path("AGENTS.md"), text },
    { documentId: secondId, path: path("src/AGENTS.md"), text },
  ];
  const metrics = analyzeContextEfficiencyMetrics({
    comparisons: [],
    contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
    documents: documents.map((document) => ({
      classificationState: "complete" as const,
      count: count(text),
      documentId: document.documentId,
      path: document.path,
    })),
    identity: BUILTIN_ESTIMATE_IDENTITY,
    profiles: [
      {
        accountings: [{ accounting: accounting(7, documents), path: target }],
        profile: {
          clientVersion: resolution.clientVersion,
          profileId: resolution.profileId,
          profileVersion: resolution.profileVersion,
          specSnapshotId: resolution.specSnapshotId,
          surfaceId: resolution.surfaceId,
        },
        sampling: sample,
      },
    ],
    recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
    statements: documents.map((document, index) => ({
      count: count(text),
      statement: {
        documentId: document.documentId,
        nodeIds: [`node:duplicate:${String(index)}`] as never,
        range: range(`source:duplicate:${String(index)}`, text),
        statementId: `statement:duplicate:${String(index)}` as never,
        text,
      },
    })),
  });
  const cluster = metrics.duplication.exact.clusters[0];
  if (cluster === undefined) throw new Error("exact duplicate cluster missing");
  return {
    metrics,
    scenario: {
      evidenceDocumentIds: sourceDocumentIds,
      evidenceId: cluster.id,
      id: "recommendation:duplicate:tests",
      targets: [
        {
          baseline: baseline.input,
          projected: context(target, [{ content: text, path: path("AGENTS.md") }]).input,
        },
      ],
    },
    score: calculateContextEfficiencyScore(metrics),
  };
}

function scopeScenario(fixture: AnalysisFixture): EfficiencyRecommendationScenario {
  const text = "Use the shared formatter.\n";
  const web = fixture.targets[0];
  const api = fixture.targets[1];
  if (web === undefined || api === undefined) throw new Error("targets missing");
  return {
    evidenceDocumentIds: [fixture.sourceDocumentId],
    evidenceId: fixture.sourceDocumentId,
    id: "recommendation:scope:formatter",
    targets: [
      {
        baseline: context(web, [{ content: text, path: path("AGENTS.md") }]).input,
        projected: context(web, [{ content: text, path: path("AGENTS.md") }]).input,
      },
      {
        baseline: context(api, [{ content: text, path: path("AGENTS.md") }]).input,
        projected: context(api, []).input,
      },
    ],
  };
}

function request(fixture: AnalysisFixture, scenarios = [scopeScenario(fixture)]): unknown {
  return {
    contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
    metrics: fixture.metrics,
    recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
    scenarios,
    score: fixture.score,
  };
}

describe("G08 context-efficiency recommendations", () => {
  test("reruns E05 and emits a quantified profile-safe scope projection", async () => {
    const fixture = analysisFixture();
    const result = await projectContextEfficiencyRecommendations(request(fixture));

    expect(result.state).toBe("complete");
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      affectedPaths: ["src/api.ts", "src/web.ts"],
      baselineTokens: 14,
      estimatedSavingBasisPoints: 5000,
      estimatedSavingTokens: 7,
      projectedTokens: 7,
      qualityClaim: false,
      semanticQualityPreservationClaim: false,
      state: "recommended",
    });
    expect(
      result.recommendations[0]?.targetProjections.find((entry) => entry.role === "intended")
        ?.retention.state,
    ).toBe("proved");
    expect(result.recommendations[0]?.caveatCodes).toContain("quality-not-empirically-verified");
    expect(result.recommendations[0]?.caveatCodes).toContain("target-necessity-not-inferred");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.recommendations[0]?.targetProjections)).toBe(true);
    expect(isIssuedContextEfficiencyRecommendations(result)).toBe(true);
    expect(isIssuedContextEfficiencyRecommendations(Object.freeze({ ...result }))).toBe(false);

    const projection = {
      contractVersion: result.contractVersion,
      qualityClaim: result.qualityClaim,
      recommendation: result.recommendations.map((entry) => ({
        affectedPaths: entry.affectedPaths,
        baselineTokens: entry.baselineTokens,
        caveatCodes: entry.caveatCodes,
        confidence: entry.confidence,
        estimatedSavingBasisPoints: entry.estimatedSavingBasisPoints,
        estimatedSavingTokens: entry.estimatedSavingTokens,
        evidence: entry.evidence,
        id: entry.id,
        kind: entry.kind,
        projectedTokens: entry.projectedTokens,
        reasonCodes: entry.reasonCodes,
        state: entry.state,
        targets: entry.targetProjections.map((target) => ({
          baselineTokens: target.baseline.tokens,
          path: target.baseline.targetPath,
          projectedTokens: target.projected.tokens,
          retention: target.retention,
          role: target.role,
        })),
      })),
      recordKind: result.recordKind,
      semanticQualityPreservationClaim: result.semanticQualityPreservationClaim,
      sourceScoreConfidence: result.sourceScoreConfidence,
      state: result.state,
      tokenizer: result.tokenizer,
    };
    expect(projection).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")) as unknown);
  });

  test("is byte deterministic under scenario and target input ordering", async () => {
    const fixture = analysisFixture();
    const first = scopeScenario(fixture);
    const second = { ...first, id: "recommendation:scope:formatter:second" };
    const ordered = await projectContextEfficiencyRecommendations(
      request(fixture, [first, second]),
    );
    const permuted = await projectContextEfficiencyRecommendations(
      request(fixture, [
        { ...second, targets: [...second.targets].reverse() },
        { ...first, targets: [...first.targets].reverse() },
      ]),
    );
    expect(JSON.stringify(permuted)).toBe(JSON.stringify(ordered));
  });

  test("consolidates only G05-proven exact duplicates while retaining unique content", async () => {
    const fixture = duplicateFixture();
    const result = await projectContextEfficiencyRecommendations({
      contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
      metrics: fixture.metrics,
      recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
      scenarios: [fixture.scenario],
      score: fixture.score,
    });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      estimatedSavingTokens: count("Run tests now.\n").tokens,
      kind: "exact-duplicate-consolidation",
      state: "recommended",
    });
    expect(result.recommendations[0]?.targetProjections[0]?.retention).toMatchObject({
      missingContentSha256s: [],
      mode: "unique-content-identities",
      state: "proved",
    });
    expect(result.recommendations[0]?.caveatCodes).toContain("profile-resolution-uncertainty");
  });

  test("declines missing target coverage and non-savings", async () => {
    const fixture = analysisFixture();
    const scenario = scopeScenario(fixture);
    const onlyIntended = scenario.targets[0];
    if (onlyIntended === undefined) throw new Error("intended fixture missing");
    const result = await projectContextEfficiencyRecommendations(
      request(fixture, [
        {
          ...scenario,
          targets: [onlyIntended],
        },
      ]),
    );
    const evaluation = result.evaluations[0];
    expect(evaluation?.state).toBe("not-recommended");
    expect(evaluation?.reasonCodes).toContain("missing-affected-target");
    expect(evaluation?.reasonCodes).toContain("no-saving-target");
  });

  test("rejects duplicate scenario and target identities and mismatched profile/target pairs", async () => {
    const fixture = analysisFixture();
    const scenario = scopeScenario(fixture);
    const intended = scenario.targets[0];
    if (intended === undefined) throw new Error("intended fixture missing");
    await expect(
      projectContextEfficiencyRecommendations(request(fixture, [scenario, scenario])),
    ).rejects.toMatchObject({
      code: ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
    });
    await expect(
      projectContextEfficiencyRecommendations(
        request(fixture, [{ ...scenario, targets: [intended, intended] }]),
      ),
    ).rejects.toMatchObject({
      code: ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
    });
    await expect(
      projectContextEfficiencyRecommendations(
        request(fixture, [
          {
            ...scenario,
            targets: [
              {
                ...intended,
                projected: context(path("src/other.ts"), [
                  { content: "Use the shared formatter.\n", path: path("AGENTS.md") },
                ]).input,
              },
            ],
          },
        ]),
      ),
    ).rejects.toMatchObject({
      code: ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
    });
  });

  test("fails closed when a target changes outside the measured evidence", async () => {
    const fixture = analysisFixture();
    const scenario = scopeScenario(fixture);
    const intended = scenario.targets[0];
    const saving = scenario.targets[1];
    if (intended === undefined) throw new Error("intended target missing");
    if (saving === undefined) throw new Error("saving target missing");
    const changed = context(path("src/web.ts"), [
      { content: "Use a different formatter.\n", path: path("AGENTS.md") },
    ]).input;
    const result = await projectContextEfficiencyRecommendations(
      request(fixture, [{ ...scenario, targets: [{ ...intended, projected: changed }, saving] }]),
    );
    expect(result.recommendations).toHaveLength(0);
    const evaluation = result.evaluations[0];
    expect(evaluation?.state).toBe("not-recommended");
    expect(evaluation?.reasonCodes).toContain("evidence-incomplete");
  });

  test("keeps partial, unavailable, and baseline-mismatch evidence indeterminate", async () => {
    const fixture = analysisFixture();
    const scenario = scopeScenario(fixture);
    const intended = scenario.targets[0];
    const saving = scenario.targets[1];
    if (intended === undefined) throw new Error("intended target missing");
    if (saving === undefined) throw new Error("saving target missing");
    const partial = context(
      path("src/api.ts"),
      [{ content: "Use the shared formatter.\n", path: path("AGENTS.md") }],
      "unavailable",
    ).input;
    const result = await projectContextEfficiencyRecommendations(
      request(fixture, [{ ...scenario, targets: [intended, { ...saving, projected: partial }] }]),
    );
    expect(result.state).toBe("partial");
    const evaluation = result.evaluations[0];
    expect(evaluation?.state).toBe("indeterminate");
    expect(evaluation?.reasonCodes).toContain("projection-partial");
    expect(evaluation?.reasonCodes).toContain("tokenizer-unavailable");
    expect(
      result.evaluations[0]?.targetProjections.find(
        (entry) => entry.baseline.targetPath === "src/api.ts",
      )?.projected.ambiguityIds.length,
    ).toBeGreaterThan(0);
  });

  test("rejects forged authority, cross-target pairs, hostile records, cancellation, and limits", async () => {
    const fixture = analysisFixture();
    const base = request(fixture) as Record<string, unknown>;
    await expect(
      projectContextEfficiencyRecommendations({ ...base, metrics: { ...fixture.metrics } }),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });
    await expect(
      projectContextEfficiencyRecommendations({ ...base, score: { ...fixture.score } }),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });
    await expect(
      projectContextEfficiencyRecommendations({ ...base, scenarios: [new Proxy({}, {})] }),
    ).rejects.toBeInstanceOf(ContextEfficiencyRecommendationsError);
    const sparse = new Array(1) as unknown[];
    await expect(
      projectContextEfficiencyRecommendations({ ...base, scenarios: sparse }),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });
    await expect(
      projectContextEfficiencyRecommendations({
        ...base,
        scenarios: Array.from(
          { length: CONTEXT_EFFICIENCY_RECOMMENDATIONS_LIMITS.maximumScenarios + 1 },
          () => ({}),
        ),
      }),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.resourceLimit });
    const controller = new AbortController();
    controller.abort();
    await expect(
      projectContextEfficiencyRecommendations(base, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.cancelled });
    await expect(
      projectContextEfficiencyRecommendations(base, new Proxy({}, {}) as never),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });
    await expect(projectContextEfficiencyRecommendations(base, {})).resolves.toBeDefined();
  });

  test("enforces the closed scenario grammar before running any projection", async () => {
    const fixture = analysisFixture();
    const scenario = scopeScenario(fixture);
    const firstTarget = scenario.targets[0];
    if (firstTarget === undefined) throw new Error("first target missing");
    const base = request(fixture) as Record<string, unknown>;
    const invalidInputs: unknown[] = [
      { ...base, contractVersion: "9.0.0" },
      { ...base, extra: true },
      { ...base, scenarios: [{ ...scenario, id: "not valid" }] },
      { ...base, scenarios: [{ ...scenario, kind: "compress-prose" }] },
      { ...base, scenarios: [{ ...scenario, evidenceDocumentIds: [] }] },
      {
        ...base,
        scenarios: [
          {
            ...scenario,
            evidenceDocumentIds: [fixture.sourceDocumentId, fixture.sourceDocumentId],
          },
        ],
      },
      { ...base, scenarios: [{ ...scenario, targets: [] }] },
      {
        ...base,
        scenarios: [{ ...scenario, targets: [{ ...firstTarget, role: "quality-preserved" }] }],
      },
    ];
    for (const invalid of invalidInputs)
      await expect(projectContextEfficiencyRecommendations(invalid)).rejects.toBeInstanceOf(
        ContextEfficiencyRecommendationsError,
      );

    const accessor = { ...scenario } as Record<string, unknown>;
    Object.defineProperty(accessor, "id", { enumerable: true, get: () => "recommendation:bad" });
    await expect(
      projectContextEfficiencyRecommendations({ ...base, scenarios: [accessor] }),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });

    const unsafeEntry = [scenario];
    Object.defineProperty(unsafeEntry, "0", { enumerable: true, get: () => scenario });
    await expect(
      projectContextEfficiencyRecommendations({ ...base, scenarios: unsafeEntry }),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });

    await expect(
      projectContextEfficiencyRecommendations(base, { extra: true } as never),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });
    const optionAccessor = {};
    Object.defineProperty(optionAccessor, "signal", { enumerable: true, get: () => undefined });
    await expect(
      projectContextEfficiencyRecommendations(base, optionAccessor),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });
    await expect(
      projectContextEfficiencyRecommendations(base, { signal: null } as never),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });
    await expect(
      projectContextEfficiencyRecommendations(base, {
        signal: Object.create(AbortSignal.prototype) as AbortSignal,
      }),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });
  });

  test("binds G07 to the exact G05 report and requires complete affected-target coverage", async () => {
    const fixture = analysisFixture();
    const duplicate = duplicateFixture();
    const scenario = scopeScenario(fixture);
    const intended = scenario.targets[0];
    const saving = scenario.targets[1];
    if (intended === undefined || saving === undefined) throw new Error("targets missing");
    await expect(
      projectContextEfficiencyRecommendations({
        ...(request(fixture) as Record<string, unknown>),
        score: duplicate.score,
      }),
    ).rejects.toMatchObject({
      code: ContextEfficiencyRecommendationsErrorCode.invalidRelationship,
    });

    const result = await projectContextEfficiencyRecommendations(
      request(fixture, [{ ...scenario, targets: [saving] }]),
    );
    const evaluation = result.evaluations[0];
    expect(evaluation?.state).toBe("not-recommended");
    expect(evaluation?.reasonCodes).toContain("missing-affected-target");
    expect(evaluation?.reasonCodes).toContain("no-intended-target");

    const invalidResolver = {
      ...scenario,
      targets: [{ ...intended, baseline: {} }],
    };
    await expect(
      projectContextEfficiencyRecommendations(request(fixture, [invalidResolver as never])),
    ).rejects.toMatchObject({ code: ContextEfficiencyRecommendationsErrorCode.invalidInput });
  });

  test("validates the complete immutable result against its closed schema", async () => {
    const fixture = analysisFixture();
    const result = await projectContextEfficiencyRecommendations(request(fixture));
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(JSON.parse(JSON.stringify(result)))).toBe(true);
    expect(validate({ ...result, executable: "pnpm test" })).toBe(false);
  });
});

describe("G09 context-efficiency reports", () => {
  async function reportFixture(): Promise<{
    readonly fixture: AnalysisFixture;
    readonly recommendations: ContextEfficiencyRecommendations;
    readonly report: ContextEfficiencyReport;
  }> {
    const fixture = analysisFixture();
    const recommendations = await projectContextEfficiencyRecommendations(request(fixture));
    const report = createContextEfficiencyReport({
      metrics: fixture.metrics,
      recommendations,
      scope: { kind: "repository", targetPath: null },
      score: fixture.score,
    });
    return { fixture, recommendations, report };
  }

  async function unavailableReportFixture(): Promise<ContextEfficiencyReport> {
    const sampling = sampleTargets({
      activationObservations: [],
      criticalPaths: [],
      paths: [],
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    });
    const metrics = analyzeContextEfficiencyMetrics({
      comparisons: [],
      contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
      documents: [],
      identity: BUILTIN_ESTIMATE_IDENTITY,
      profiles: [
        {
          accountings: [],
          profile: {
            clientVersion: null,
            profileId: "codex-cli",
            profileVersion: "0.1.0",
            specSnapshotId: "codex-cli/unavailable-test",
            surfaceId: "codex-cli/unavailable-test",
          },
          sampling,
        },
      ],
      recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
      statements: [],
    });
    const score = calculateContextEfficiencyScore(metrics);
    const recommendations = await projectContextEfficiencyRecommendations({
      contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
      metrics,
      recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
      scenarios: [],
      score,
    });
    return createContextEfficiencyReport({
      metrics,
      recommendations,
      scope: { kind: "repository", targetPath: null },
      score,
    });
  }

  test("binds the report to genuine G05/G07/G08 evidence without inventing claims", async () => {
    const { fixture, recommendations, report } = await reportFixture();
    expect(isIssuedContextEfficiencyRecommendations(recommendations)).toBe(true);
    expect(report).toMatchObject({
      qualityClaim: false,
      recordKind: CONTEXT_EFFICIENCY_REPORT_RECORD_KIND,
      schemaVersion: "1.0.0",
      semanticQualityPreservationClaim: false,
      source: {
        configurationSha256: fixture.score.identities.configurationSha256,
        metricsSha256: fixture.score.identities.metricsSha256,
        scoreSpecificationSha256: fixture.score.identities.specificationSha256,
      },
      tokenizer: BUILTIN_ESTIMATE_IDENTITY,
    });
    expect(report.score).toBe(fixture.score);
    expect(report.recommendations).toBe(recommendations);
    expect(report.profiles).toHaveLength(1);
    expect(report.profiles[0]).toMatchObject({
      effectiveTokens: { maximum: 7, minimum: 7, p50: 7, p95: 7 },
      profileId: "codex-cli",
      sampleCount: 2,
      surfaceId: "codex-cli/local-cli-single-cwd",
    });
    expect(Object.isFrozen(report)).toBe(true);
  });

  test("validates single and comparison documents against their closed schemas", async () => {
    const { report } = await reportFixture();
    const comparison = compareContextEfficiencyReports({ baseline: report, candidate: report });
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const schema of [TOKENIZER_SCHEMA, SPECIFICATION_SCHEMA, SCORE_SCHEMA, SCHEMA])
      ajv.addSchema(JSON.parse(readFileSync(schema, "utf8")) as AnySchema);
    const validateReport = ajv.compile(
      JSON.parse(readFileSync(REPORT_SCHEMA, "utf8")) as AnySchema,
    );
    const validateComparison = ajv.compile(
      JSON.parse(readFileSync(COMPARISON_SCHEMA, "utf8")) as AnySchema,
    );
    expect(validateReport(JSON.parse(serializeContextEfficiencyJson(report)))).toBe(true);
    expect(validateComparison(JSON.parse(serializeContextEfficiencyJson(comparison)))).toBe(true);
    expect(validateReport({ ...report, command: "pnpm test" })).toBe(false);
    expect(validateReport({ ...report, scope: { kind: "target", targetPath: "src/api.ts" } })).toBe(
      false,
    );
    expect(validateComparison({ ...comparison, qualityClaim: true })).toBe(false);
  });

  test("emits stable canonical JSON and exit-neutral accessible terminal output", async () => {
    const { report } = await reportFixture();
    const json = serializeContextEfficiencyJson(report);
    expect(serializeContextEfficiencyJson(report)).toBe(json);
    expect(json.endsWith("\n")).toBe(true);
    expect(json.indexOf('"profiles"')).toBeLessThan(json.indexOf('"qualityClaim"'));
    const plain = renderContextEfficiencyTerminal(report, { colorMode: "never", width: 48 });
    expect(plain).toContain("Context efficiency report");
    expect(plain).toContain("quality and semantic prese\nrvation are not claimed.");
    const escape = String.fromCodePoint(0x1b);
    expect(plain).not.toContain(`${escape}[`);
    expect(plain).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/u);
    const colored = renderContextEfficiencyTerminal(report, { colorMode: "ansi", width: 48 });
    expect(
      colored
        .replaceAll(`${escape}[36m`, "")
        .replaceAll(`${escape}[33m`, "")
        .replaceAll(`${escape}[0m`, ""),
    ).toBe(plain);

    const projection = {
      profiles: report.profiles.map((profile) => ({
        alwaysOnTokens: profile.alwaysOnTokens,
        completeSampleCount: profile.completeSampleCount,
        effectiveTokens: profile.effectiveTokens,
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        sampleCount: profile.sampleCount,
        samplingState: profile.samplingState,
        samplingStrategy: profile.samplingStrategy,
        specSnapshotId: profile.specSnapshotId,
        state: profile.state,
        surfaceId: profile.surfaceId,
      })),
      qualityClaim: report.qualityClaim,
      recommendations: report.recommendations.recommendations.map((entry) => ({
        baselineTokens: entry.baselineTokens,
        caveatCodes: entry.caveatCodes,
        confidence: entry.confidence,
        estimatedSavingBasisPoints: entry.estimatedSavingBasisPoints,
        estimatedSavingTokens: entry.estimatedSavingTokens,
        id: entry.id,
        projectedTokens: entry.projectedTokens,
        reasonCodes: entry.reasonCodes,
        state: entry.state,
      })),
      schemaVersion: report.schemaVersion,
      score: {
        caveatCodes: report.score.caveatCodes,
        confidence: report.score.confidence,
        grade: report.score.grade,
        score: report.score.score,
        state: report.score.state,
        uncertaintyCodes: report.score.uncertaintyCodes,
      },
      semanticQualityPreservationClaim: report.semanticQualityPreservationClaim,
      state: report.state,
      tokenizer: report.tokenizer,
    };
    expect(projection).toEqual(JSON.parse(readFileSync(REPORT_GOLDEN, "utf8")) as unknown);
    expect(renderContextEfficiencyTerminal(report, { colorMode: "never", width: 240 })).toBe(
      readFileSync(TERMINAL_GOLDEN, "utf8"),
    );
  });

  test("keeps conservative display width for Unicode repository paths", async () => {
    const fixture = analysisFixture([path("src/界面.ts"), path("src/api.ts")]);
    const recommendations = await projectContextEfficiencyRecommendations(request(fixture));
    const report = createContextEfficiencyReport({
      metrics: fixture.metrics,
      recommendations,
      scope: { kind: "repository", targetPath: null },
      score: fixture.score,
    });
    const terminal = renderContextEfficiencyTerminal(report, {
      colorMode: "never",
      width: 40,
    });
    expect(terminal).toContain("界面");
    for (const line of terminal.trimEnd().split("\n")) {
      const width = Array.from(line).reduce(
        (sum, scalar) => sum + ((scalar.codePointAt(0) ?? 0) <= 0x7e ? 1 : 2),
        0,
      );
      expect(width).toBeLessThanOrEqual(40);
    }
  });

  test("compares compatible sources and preserves unavailable deltas", async () => {
    const { report } = await reportFixture();
    const comparison = compareContextEfficiencyReports({ baseline: report, candidate: report });
    expect(comparison).toMatchObject({
      qualityClaim: false,
      recordKind: "agent-context-efficiency-comparison",
      score: {
        baseline: report.score.score,
        candidate: report.score.score,
        delta: report.score.score === null ? null : 0,
      },
      semanticQualityPreservationClaim: false,
    });
    expect(comparison.caveatCodes).toEqual([
      "quality-not-empirically-verified",
      "semantic-equivalence-not-proven",
      "static-analysis-only",
    ]);
    expect(renderContextEfficiencyTerminal(comparison, { width: 40 })).toContain(
      "Static comparison only",
    );
  });

  test("reports empty aggregate evidence as unavailable without zero substitution", async () => {
    const report = await unavailableReportFixture();
    expect(report).toMatchObject({
      profiles: [
        {
          alwaysOnTokens: null,
          clientVersion: null,
          effectiveTokens: null,
          sampleCount: 0,
          state: "empty",
        },
      ],
      state: "unavailable",
    });
    expect(report.score.score).toBeNull();
    const terminal = renderContextEfficiencyTerminal(report);
    expect(terminal).toContain("Score: unavailable");
    expect(terminal).toContain("p50 unavailable");
    const comparison = compareContextEfficiencyReports({ baseline: report, candidate: report });
    expect(comparison.score).toEqual({ baseline: null, candidate: null, delta: null });
    expect(renderContextEfficiencyTerminal(comparison)).toContain(
      "Score baseline/candidate/delta: unavailable / unavailable / unavailable",
    );
  });

  test("streams bounded chunks sequentially and honors cancellation", async () => {
    const { report } = await reportFixture();
    const chunks: string[] = [];
    let active = 0;
    let maximumActive = 0;
    await writeContextEfficiencyJson(report, {
      write: async (text: string) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        chunks.push(text);
        active -= 1;
      },
    });
    expect(maximumActive).toBe(1);
    expect(chunks.join("")).toBe(serializeContextEfficiencyJson(report));

    const controller = new AbortController();
    controller.abort();
    const writes: string[] = [];
    await expect(
      writeContextEfficiencyJson(
        report,
        { write: (text: string) => void writes.push(text) },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: ContextEfficiencyReportErrorCode.cancelled });
    expect(writes).toEqual([]);

    const fixture = analysisFixture();
    const baseScenario = scopeScenario(fixture);
    const scenarios = Array.from({ length: 64 }, (_, index) => ({
      ...baseScenario,
      id: `${baseScenario.id}:${String(index).padStart(2, "0")}`,
    }));
    const recommendations = await projectContextEfficiencyRecommendations(
      request(fixture, scenarios),
    );
    const largeReport = createContextEfficiencyReport({
      metrics: fixture.metrics,
      recommendations,
      scope: { kind: "repository", targetPath: null },
      score: fixture.score,
    });
    const boundedChunks: string[] = [];
    await writeContextEfficiencyJson(largeReport, {
      write: (text: string) => void boundedChunks.push(text),
    });
    expect(boundedChunks.length).toBeGreaterThan(1);
    for (const chunk of boundedChunks)
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(
        CONTEXT_EFFICIENCY_REPORT_LIMITS.maximumOutputChunkBytes,
      );
  });

  test("rejects forged authority, incompatible identities, accessors, proxies, and unsafe options", async () => {
    const { fixture, recommendations, report } = await reportFixture();
    const differentFixture = analysisFixture([path("src/other.ts")]);
    expect(() =>
      createContextEfficiencyReport({
        metrics: { ...fixture.metrics },
        recommendations,
        scope: { kind: "repository", targetPath: null },
        score: fixture.score,
      }),
    ).toThrow(ContextEfficiencyReportError);
    expect(() =>
      createContextEfficiencyReport({
        metrics: differentFixture.metrics,
        recommendations,
        scope: { kind: "repository", targetPath: null },
        score: fixture.score,
      }),
    ).toThrow(expect.objectContaining({ code: ContextEfficiencyReportErrorCode.incompatible }));
    expect(() =>
      createContextEfficiencyReport({
        metrics: fixture.metrics,
        recommendations: { ...recommendations },
        scope: { kind: "repository", targetPath: null },
        score: fixture.score,
      }),
    ).toThrow(ContextEfficiencyReportError);
    const configuredScore = calculateContextEfficiencyScore(fixture.metrics, {
      budgets: { alwaysOnTokens: 0, effectiveP95Tokens: 1 },
    });
    const configuredRecommendations = await projectContextEfficiencyRecommendations({
      ...(request(fixture) as Record<string, unknown>),
      score: configuredScore,
    });
    const configuredReport = createContextEfficiencyReport({
      metrics: fixture.metrics,
      recommendations: configuredRecommendations,
      scope: { kind: "repository", targetPath: null },
      score: configuredScore,
    });
    expect(() =>
      compareContextEfficiencyReports({ baseline: report, candidate: configuredReport }),
    ).toThrow(expect.objectContaining({ code: ContextEfficiencyReportErrorCode.incompatible }));
    expect(() =>
      createContextEfficiencyReport({
        metrics: fixture.metrics,
        recommendations,
        scope: { kind: "target", targetPath: path("src/api.ts") },
        score: fixture.score,
      }),
    ).toThrow(expect.objectContaining({ code: ContextEfficiencyReportErrorCode.invalidInput }));
    expect(() => compareContextEfficiencyReports(new Proxy({}, {}))).toThrow(
      ContextEfficiencyReportError,
    );
    const accessor = {};
    Object.defineProperty(accessor, "metrics", { enumerable: true, get: () => fixture.metrics });
    Object.defineProperties(accessor, {
      recommendations: { enumerable: true, value: recommendations },
      scope: { enumerable: true, value: { kind: "repository", targetPath: null } },
      score: { enumerable: true, value: fixture.score },
    });
    expect(() => createContextEfficiencyReport(accessor)).toThrow(ContextEfficiencyReportError);
    expect(() =>
      renderContextEfficiencyTerminal(report, { colorMode: "never", width: 39 }),
    ).toThrow(ContextEfficiencyReportError);
    await expect(
      writeContextEfficiencyJson(report, { write: () => Promise.reject(new Error("secret")) }),
    ).rejects.toMatchObject({ code: ContextEfficiencyReportErrorCode.outputFailed });
  });

  test("fails closed for malformed records, scopes, output capabilities, and render options", async () => {
    const { fixture, recommendations, report } = await reportFixture();
    expect(isIssuedContextEfficiencyReport(report)).toBe(true);
    expect(isIssuedContextEfficiencyReport(null)).toBe(false);
    expect(isIssuedContextEfficiencyReport({ ...report })).toBe(false);
    const comparison = compareContextEfficiencyReports({ baseline: report, candidate: report });
    expect(isIssuedContextEfficiencyComparison(comparison)).toBe(true);
    expect(isIssuedContextEfficiencyComparison(null)).toBe(false);
    expect(isIssuedContextEfficiencyComparison({ ...comparison })).toBe(false);

    for (const invalid of [
      null,
      [],
      {},
      Object.create({}),
      { metrics: fixture.metrics, recommendations, scope: {}, score: fixture.score },
      {
        metrics: fixture.metrics,
        recommendations,
        scope: { kind: "repository", targetPath: null },
        score: {},
      },
      {
        metrics: fixture.metrics,
        recommendations: {},
        scope: { kind: "repository", targetPath: null },
        score: fixture.score,
      },
      {
        extra: true,
        metrics: fixture.metrics,
        recommendations,
        scope: { kind: "repository", targetPath: null },
        score: fixture.score,
      },
    ])
      expect(() => createContextEfficiencyReport(invalid)).toThrow(ContextEfficiencyReportError);

    expect(() => compareContextEfficiencyReports({ baseline: report, candidate: {} })).toThrow(
      ContextEfficiencyReportError,
    );
    expect(() => serializeContextEfficiencyJson({ ...report })).toThrow(
      ContextEfficiencyReportError,
    );

    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "width", { enumerable: true, get: () => 80 });
    for (const invalid of [
      null,
      [],
      new Proxy({}, {}),
      Object.create({}),
      { extra: true },
      accessorOptions,
      { colorMode: "auto" },
      { width: 40.5 },
      { width: 241 },
    ])
      expect(() => renderContextEfficiencyTerminal(report, invalid)).toThrow(
        ContextEfficiencyReportError,
      );

    const sinkAccessor = {};
    const noOpWrite = (): void => undefined;
    Object.defineProperty(sinkAccessor, "write", {
      enumerable: true,
      get: (): typeof noOpWrite => noOpWrite,
    });
    for (const invalidSink of [
      null,
      {},
      { write: null },
      { write: new Proxy(() => undefined, {}) },
      sinkAccessor,
    ])
      await expect(writeContextEfficiencyJson(report, invalidSink)).rejects.toBeInstanceOf(
        ContextEfficiencyReportError,
      );

    for (const invalidOptions of [
      null,
      [],
      new Proxy({}, {}),
      { extra: true },
      { signal: null },
      { signal: new Proxy(new AbortController().signal, {}) },
    ])
      await expect(
        writeContextEfficiencyJson(report, { write: () => undefined }, invalidOptions),
      ).rejects.toBeInstanceOf(ContextEfficiencyReportError);

    await expect(
      writeContextEfficiencyJson(report, {
        write: () => {
          throw new Error("secret");
        },
      }),
    ).rejects.toMatchObject({ code: ContextEfficiencyReportErrorCode.outputFailed });
  });

  test("races an outstanding sink with cancellation and handles signaled sink outcomes", async () => {
    const { report } = await reportFixture();
    const successful = new AbortController();
    await expect(
      writeContextEfficiencyJson(
        report,
        { write: async () => Promise.resolve() },
        { signal: successful.signal },
      ),
    ).resolves.toBeUndefined();

    const rejected = new AbortController();
    await expect(
      writeContextEfficiencyJson(
        report,
        { write: async () => Promise.reject(new Error("secret")) },
        { signal: rejected.signal },
      ),
    ).rejects.toMatchObject({ code: ContextEfficiencyReportErrorCode.outputFailed });

    const abortedBySink = new AbortController();
    await expect(
      writeContextEfficiencyJson(
        report,
        {
          write: () => {
            abortedBySink.abort();
            return Promise.resolve();
          },
        },
        { signal: abortedBySink.signal },
      ),
    ).rejects.toMatchObject({ code: ContextEfficiencyReportErrorCode.cancelled });

    const controller = new AbortController();
    let started!: () => void;
    const sinkStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = writeContextEfficiencyJson(
      report,
      {
        write: () => {
          started();
          return new Promise<void>(() => undefined);
        },
      },
      { signal: controller.signal },
    );
    await sinkStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: ContextEfficiencyReportErrorCode.cancelled,
    });
  });
});
