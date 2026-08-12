import { createHash } from "node:crypto";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  validateInstructionIr,
} from "@agent-context/core";
import {
  BUILTIN_ESTIMATE_IDENTITY,
  CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
  accountOccurrenceTokens,
  analyzeContextEfficiencyMetrics,
  calculateContextEfficiencyScore,
  countEstimatedTokens,
  projectContextEfficiencyRecommendations,
} from "@agent-context/efficiency";
import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  buildDocumentImportDag,
  createSyntheticTargetTrace,
  isIssuedDocumentImportDag,
  resolveCodexCliAgents,
  resolveEffectiveContext,
  sampleTargets,
} from "@agent-context/resolver";

import { CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION } from "@agent-context/rules";

import type {
  ActivationRule,
  AstNode,
  AstNodeId,
  ImportReference,
  InstructionDocument,
  InstructionDocumentId,
  InstructionIr,
  InstructionStatement,
  InstructionStatementId,
  ImportReferenceId,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
  SourceRange,
} from "@agent-context/core";
import type { ImportGraphResult } from "@agent-context/evidence";
import type {
  AnalyzeContextEfficiencyMetricsInput,
  ContextEfficiencyMetrics,
  ContextEfficiencyRecommendations,
  ContextEfficiencyScore,
  EfficiencyRecommendationScenario,
  ProfileTargetAccounting,
  TokenCount,
  TokenizerIdentity,
} from "@agent-context/efficiency";
import type { ResolveEffectiveContextInput } from "@agent-context/resolver";
import type {
  ContextEfficiencyRuleInput,
  ContextEfficiencyRuleOptions,
} from "@agent-context/rules";

const encoder = new TextEncoder();

interface DocumentFixture {
  readonly documentId: InstructionDocumentId;
  readonly formatId?: string;
  readonly path: RepositoryRelativePath;
  readonly text: string;
}

interface ContextFixture {
  readonly input: ResolveEffectiveContextInput;
  readonly resolution: ReturnType<typeof resolveEffectiveContext>;
  readonly sourceDocumentIds: readonly InstructionDocumentId[];
}

interface IssuedFixture {
  readonly input: ContextEfficiencyRuleInput;
  readonly ir: InstructionIr;
  readonly metrics: ContextEfficiencyMetrics;
  readonly score: ContextEfficiencyScore;
}

export interface EfficiencyRecallScenario {
  readonly id: string;
  readonly input: ContextEfficiencyRuleInput;
  readonly ir: InstructionIr;
  readonly options: ContextEfficiencyRuleOptions;
}

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function position(text: string, offset: number): SourcePosition {
  const lines = text.slice(0, offset).split("\n");
  return {
    byteOffset: Buffer.byteLength(text.slice(0, offset), "utf8"),
    line: lines.length - 1,
    utf16Column: lines.at(-1)?.length ?? 0,
    utf16Offset: offset,
  };
}

function range(
  sourceId: SourceDocumentId,
  text: string,
  start = 0,
  end = text.length,
): SourceRange {
  return { end: position(text, end), sourceId, start: position(text, start) };
}

function count(text: string, identity: TokenizerIdentity = BUILTIN_ESTIMATE_IDENTITY): TokenCount {
  const result = countEstimatedTokens(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return identity === BUILTIN_ESTIMATE_IDENTITY ? result.value : { ...result.value, identity };
}

function context(
  targetPath: RepositoryRelativePath,
  entries: readonly { readonly content: string; readonly path: RepositoryRelativePath }[],
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
      reason: "complete seeded-recall efficiency snapshot",
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
    resolution,
    sourceDocumentIds: resolution.documents
      .map((document) => document.sourceDocumentId)
      .filter((id): id is InstructionDocumentId => id !== null),
  };
}

function resolvedDocumentId(
  fixture: ContextFixture,
  sourcePath: RepositoryRelativePath,
): InstructionDocumentId {
  const id = fixture.resolution.documents.find(
    (document) => document.path === sourcePath,
  )?.sourceDocumentId;
  if (id === null || id === undefined) throw new Error(`resolved document missing: ${sourcePath}`);
  return id as InstructionDocumentId;
}

function accounting(
  ordinal: number,
  documents: readonly DocumentFixture[],
  repeatLast = false,
  identity: TokenizerIdentity = BUILTIN_ESTIMATE_IDENTITY,
): ProfileTargetAccounting["accounting"] {
  const first = documents[0];
  if (first === undefined) throw new Error("efficiency scenario needs a document");
  const firstSourceId = `source:recall:efficiency:${String(ordinal)}:0` as SourceDocumentId;
  const targets = [...documents.slice(1)];
  if (repeatLast) {
    const repeated = documents.at(-1);
    if (repeated === undefined) throw new Error("repeat efficiency scenario is empty");
    targets.push(repeated);
  }
  const references: ImportReference[] = targets.map((target, index) => {
    const sourceRange = range(firstSourceId, first.text, 0, 0);
    return {
      documentId: first.documentId,
      id: `import:recall:${String(ordinal)}:${String(index)}` as ImportReferenceId,
      kind: "vendor-import",
      nodeId: `node:recall:efficiency:${String(ordinal)}:${String(index)}` as AstNodeId,
      range: sourceRange,
      rawSpecifier: target.path,
      specifierRange: sourceRange,
      state: "recognized",
      targetKind: "repository-path-candidate",
      uncertainty: { state: "known" },
    };
  });
  const nodes: ImportGraphResult["nodes"] = documents.map((document, index) => ({
    byteLength: Buffer.byteLength(document.text, "utf8"),
    depth: index === 0 ? 0 : 1,
    documentId: document.documentId,
    imports: index === 0 ? references : [],
    path: document.path,
    sha256: digest(document.text),
    sourceId: `source:recall:efficiency:${String(ordinal)}:${String(index)}` as SourceDocumentId,
    state: "loaded",
  }));
  const graph: ImportGraphResult = {
    contractVersion: "0.1.0",
    edges: targets.map((target, index) => {
      const reference = references[index];
      if (reference === undefined) throw new Error("efficiency import reference is missing");
      return {
        depth: 1,
        fromDocumentId: first.documentId,
        import: reference,
        issueCode: null,
        state: index < documents.length - 1 ? "loaded" : "already-loaded",
        targetDocumentId: target.documentId,
        targetPath: target.path,
      };
    }),
    entryPath: first.path,
    issues: [],
    nodes,
    state: "complete",
    syntax: "claude-code",
    usage: {
      edges: references.length,
      files: documents.length,
      issues: 0,
      totalBytes: nodes.reduce((sum, node) => sum + node.byteLength, 0),
    },
  };
  const dag = buildDocumentImportDag({
    graph,
    trace: createSyntheticTargetTrace({
      launchCwd: path("."),
      purpose: `seeded-recall-efficiency-${String(ordinal)}`,
      targetPath: first.path,
      workspaceRoots: [path(".")],
    }),
  });
  if (!isIssuedDocumentImportDag(dag))
    throw new Error("efficiency accounting requires a production-issued E04 DAG");
  return accountOccurrenceTokens({
    dag,
    documentMeasurements: documents.map((document) => ({
      count: count(document.text, identity),
      documentId: document.documentId,
    })),
    identity,
    occurrenceDecisions: dag.occurrences.map((occurrence) => {
      const document = documents.find((entry) => entry.documentId === occurrence.targetDocumentId);
      if (document === undefined) throw new Error("efficiency occurrence document is missing");
      return {
        activation: "always" as const,
        count: count(document.text, identity),
        disposition: "included" as const,
        occurrenceId: occurrence.id,
        sourceBytesConsumed: Buffer.byteLength(document.text, "utf8"),
      };
    }),
  });
}

function buildIr(documents: readonly DocumentFixture[]): InstructionIr {
  const sources: SourceDocument[] = [];
  const nodes: AstNode[] = [];
  const irDocuments: InstructionDocument[] = [];
  const statements: InstructionStatement[] = [];
  const activationRules: ActivationRule[] = [];
  for (const [index, document] of documents.entries()) {
    const key = digest(`${document.path}\0${document.text}`).slice(0, 24);
    const sourceId = `source:recall:f14:${key}:${String(index)}` as SourceDocumentId;
    const rootId = `node:recall:f14:${key}:${String(index)}:root` as AstNodeId;
    const paragraphId = `node:recall:f14:${key}:${String(index)}:paragraph` as AstNodeId;
    nodes.push(
      {
        childIds: [paragraphId],
        id: rootId,
        kind: "root",
        range: range(sourceId, document.text),
        sourceId,
      },
      {
        childIds: [],
        id: paragraphId,
        kind: "paragraph",
        range: range(sourceId, document.text),
        sourceId,
      },
    );
    sources.push({
      bom: "none",
      byteLength: Buffer.byteLength(document.text, "utf8"),
      encoding: "utf-8",
      id: sourceId,
      lineEnding: document.text.includes("\n") ? "lf" : "none",
      parseState: { state: "complete" },
      path: document.path,
      rootNodeId: rootId,
      sha256: digest(document.text),
      text: document.text,
      utf16Length: document.text.length,
    });
    const statementId = `statement:recall:f14:${String(index)}` as InstructionStatement["id"];
    statements.push({
      classification: { state: "unclassified" },
      documentId: document.documentId,
      id: statementId,
      nodeIds: [paragraphId],
      range: range(sourceId, document.text),
      text: document.text,
    });
    const activationId = `activation:recall:f14:${String(index)}` as ActivationRule["id"];
    irDocuments.push({
      activationRuleIds: [activationId],
      formatId: document.formatId ?? "agents-markdown",
      id: document.documentId,
      importIds: [],
      rootNodeId: rootId,
      scopeRoot: path("."),
      sourceId,
      statementIds: [statementId],
    });
    activationRules.push({
      conditions: [],
      documentId: document.documentId,
      evidenceRefs: [{ factId: `fixture:recall:${String(index)}`, sourceId: "fixture:recall:f14" }],
      exclude: [],
      id: activationId,
      include: [],
      kind: "always",
      profileId: "codex-cli",
      scopeRoot: path("."),
      specSnapshotId: "fixture:seeded-recall-f14/2026-08-08",
      surfaceId: "codex-cli/local",
      uncertainty: { state: "known" },
      unknownReason: null,
    });
  }
  const result = validateInstructionIr({
    activationRules,
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: irDocuments,
    events: [],
    imports: [],
    nodes,
    recordKind: "agent-context-instruction-ir",
    sources,
    statements,
    targets: [],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function metricsFor(input: {
  readonly contexts: readonly {
    readonly context: ContextFixture;
    readonly documents: readonly DocumentFixture[];
    readonly repeatLast?: boolean;
  }[];
  readonly documents: readonly DocumentFixture[];
  readonly identity?: TokenizerIdentity;
}): ContextEfficiencyMetrics {
  const identity = input.identity ?? BUILTIN_ESTIMATE_IDENTITY;
  const targets = input.contexts.map((entry) => entry.context.resolution.targetPath);
  const sampling = sampleTargets({
    activationObservations: targets.map((target) => ({ path: target, states: [] })),
    criticalPaths: [],
    paths: targets,
    trackingCertainty: "tracked",
    trackingReason: "verified-git-index",
    workspaceBoundaries: [],
    workspaceUncertainty: "known",
    workspaceUncertaintyReasons: [],
  });
  const firstResolution = input.contexts[0]?.context.resolution;
  if (firstResolution === undefined) throw new Error("efficiency profile fixture is missing");
  const ir = buildIr(input.documents);
  const sourceByDocument = new Map(
    ir.documents.map((document) => [
      document.id,
      ir.sources.find((source) => source.id === document.sourceId),
    ]),
  );
  const request: AnalyzeContextEfficiencyMetricsInput = {
    comparisons: [],
    contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
    documents: input.documents.map((document) => ({
      classificationState: "complete",
      count: count(document.text, identity),
      documentId: document.documentId,
      path: document.path,
    })),
    identity,
    profiles: [
      {
        accountings: input.contexts.map((entry, index) => ({
          accounting: accounting(index, entry.documents, entry.repeatLast, identity),
          path: entry.context.resolution.targetPath,
        })),
        profile: {
          clientVersion: firstResolution.clientVersion,
          profileId: firstResolution.profileId,
          profileVersion: firstResolution.profileVersion,
          specSnapshotId: firstResolution.specSnapshotId,
          surfaceId: firstResolution.surfaceId,
        },
        sampling,
      },
    ],
    recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
    statements: input.documents.map((document, index) => {
      const source = sourceByDocument.get(document.documentId);
      const statement = ir.statements.find((entry) => entry.documentId === document.documentId);
      if (source === undefined || statement === undefined)
        throw new Error("efficiency statement source is missing");
      return {
        count: count(statement.text, identity),
        statement: {
          documentId: document.documentId,
          nodeIds: statement.nodeIds,
          range: statement.range,
          statementId: `statement:recall:f14:metric:${String(index)}` as InstructionStatementId,
          text: statement.text,
        },
      };
    }),
  };
  return analyzeContextEfficiencyMetrics(request);
}

async function issued(
  documents: readonly DocumentFixture[],
  metrics: ContextEfficiencyMetrics,
  scenarios: readonly EfficiencyRecommendationScenario[],
  score: ContextEfficiencyScore,
): Promise<IssuedFixture> {
  const recommendations: ContextEfficiencyRecommendations =
    await projectContextEfficiencyRecommendations({
      contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
      metrics,
      recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
      scenarios,
      score,
    });
  const ir = buildIr(documents);
  return {
    input: {
      contractVersion: CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION,
      ir,
      metrics,
      recommendations,
      recordKind: "agent-context-efficiency-rule-input",
      score,
      tokenizerComparisons: [],
    },
    ir,
    metrics,
    score,
  };
}

async function scopeFixture(): Promise<IssuedFixture> {
  const text = "Repository background and architecture details. ".repeat(32);
  const targets = [path("src/web.ts"), path("src/api.ts")];
  const contexts = targets.map((target) =>
    context(target, [{ content: text, path: path("AGENTS.md") }]),
  );
  const first = contexts[0];
  const second = contexts[1];
  if (first === undefined || second === undefined)
    throw new Error("scope efficiency contexts are incomplete");
  const documentId = resolvedDocumentId(first, path("AGENTS.md"));
  const documents = [{ documentId, path: path("AGENTS.md"), text }];
  const metrics = metricsFor({
    contexts: contexts.map((entry) => ({ context: entry, documents })),
    documents,
  });
  const score = calculateContextEfficiencyScore(metrics, {
    budgets: { alwaysOnTokens: 1, effectiveP95Tokens: 1 },
  });
  const scenario: EfficiencyRecommendationScenario = {
    evidenceDocumentIds: [documentId],
    evidenceId: documentId,
    id: "recommendation:recall:f14:scope",
    targets: [
      { baseline: first.input, projected: first.input },
      {
        baseline: second.input,
        projected: context(second.input.targetPath, []).input,
      },
    ],
  };
  return issued(documents, metrics, [scenario], score);
}

async function duplicateFixture(vendorSpecific = false): Promise<IssuedFixture> {
  const text = "Always run the repository verification suite before submitting changes. ".repeat(
    12,
  );
  const target = path("src/example.ts");
  const baseline = context(target, [
    { content: text, path: path("AGENTS.md") },
    { content: text, path: path("src/AGENTS.md") },
  ]);
  const first = resolvedDocumentId(baseline, path("AGENTS.md"));
  const second = resolvedDocumentId(baseline, path("src/AGENTS.md"));
  const documents = [
    { documentId: first, path: path("AGENTS.md"), text },
    {
      documentId: second,
      formatId: vendorSpecific ? "claude-memory-markdown" : "agents-markdown",
      path: path("src/AGENTS.md"),
      text,
    },
  ];
  const metrics = metricsFor({ contexts: [{ context: baseline, documents }], documents });
  const score = calculateContextEfficiencyScore(metrics);
  const cluster = metrics.duplication.exact.clusters[0];
  if (cluster === undefined) throw new Error("efficiency duplicate cluster is missing");
  return issued(
    documents,
    metrics,
    [
      {
        evidenceDocumentIds: [first, second].sort(),
        evidenceId: cluster.id,
        id: `recommendation:recall:f14:${vendorSpecific ? "vendor" : "duplicate"}`,
        targets: [
          {
            baseline: baseline.input,
            projected: context(target, [{ content: text, path: path("AGENTS.md") }]).input,
          },
        ],
      },
    ],
    score,
  );
}

async function amplificationFixture(): Promise<IssuedFixture> {
  const text = "Use pnpm test for verification. ".repeat(24);
  const target = path("src/amplified.ts");
  const resolved = context(target, [{ content: text, path: path("AGENTS.md") }]);
  const documentId = resolvedDocumentId(resolved, path("AGENTS.md"));
  const documents = [{ documentId, path: path("AGENTS.md"), text }];
  const metrics = metricsFor({
    contexts: [{ context: resolved, documents, repeatLast: true }],
    documents,
  });
  return issued(documents, metrics, [], calculateContextEfficiencyScore(metrics));
}

function incompatibleScoreFor(fixture: IssuedFixture): ContextEfficiencyScore {
  const exactIdentity: TokenizerIdentity = {
    id: "fixture:seeded-recall-exact-tokenizer",
    measurement: "exact",
    version: "1.0.0",
  };
  const source = fixture.ir.sources[0];
  if (source === undefined) throw new Error("efficiency tokenizer source is missing");
  const resolved = context(path("src/tokenizer.ts"), [{ content: source.text, path: source.path }]);
  const documentId = resolvedDocumentId(resolved, source.path);
  const documents = [{ documentId, path: source.path, text: source.text }];
  return calculateContextEfficiencyScore(
    metricsFor({
      contexts: [{ context: resolved, documents }],
      documents,
      identity: exactIdentity,
    }),
  );
}

export async function buildEfficiencyRecallScenarios(): Promise<
  readonly EfficiencyRecallScenario[]
> {
  const scope = await scopeFixture();
  const scopeDocument = scope.ir.documents[0];
  if (scopeDocument === undefined) throw new Error("efficiency scope document is missing");
  const duplicate = await duplicateFixture();
  const amplification = await amplificationFixture();
  const vendor = await duplicateFixture(true);
  return Object.freeze([
    {
      id: "efficiency-scope",
      input: {
        ...scope.input,
        tokenizerComparisons: [
          {
            baseline: scope.score,
            candidate: incompatibleScoreFor(scope),
            id: "comparison:recall:f14:tokenizers",
            sourceDocumentId: scopeDocument.id,
          },
        ],
      },
      ir: scope.ir,
      options: {
        highImpactSavingBasisPoints: 1,
        highImpactSavingTokens: 1,
        minimumDensityBasisPoints: 1,
      },
    },
    {
      id: "efficiency-duplicate",
      input: duplicate.input,
      ir: duplicate.ir,
      options: { duplicateTokens: 1 },
    },
    {
      id: "efficiency-amplification",
      input: amplification.input,
      ir: amplification.ir,
      options: { importAmplificationBasisPoints: 10_001 },
    },
    {
      id: "efficiency-vendor",
      input: vendor.input,
      ir: vendor.ir,
      options: { duplicateTokens: 1, highImpactSavingBasisPoints: 1, highImpactSavingTokens: 1 },
    },
  ]);
}
