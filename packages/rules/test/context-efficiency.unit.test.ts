import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  validateDiagnosticBundle,
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
  isIssuedContextEfficiencyRecommendations,
  projectContextEfficiencyRecommendations,
} from "@agent-context/efficiency";
import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  resolveCodexCliAgents,
  resolveEffectiveContext,
  sampleTargets,
} from "@agent-context/resolver";

import {
  CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_RULE_IDS,
  CONTEXT_EFFICIENCY_RULE_MAX_COMPARISONS,
  evaluateContextEfficiencyRules,
  finalizeContextEfficiencySuppressions,
} from "../src/index.js";

import type {
  ActivationRule,
  AstNode,
  AstNodeId,
  DiagnosticBundle,
  InstructionDocument,
  InstructionDocumentId,
  InstructionIr,
  InstructionStatement,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
  SourceRange,
} from "@agent-context/core";
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
import type { DocumentImportDag, ResolveEffectiveContextInput } from "@agent-context/resolver";
import type { ContextEfficiencyRuleInput } from "../src/index.js";

const encoder = new TextEncoder();
const PRECISION_SCHEMA = new URL(
  "../../../conformance/schemas/context-efficiency-rule-precision.v0.schema.json",
  import.meta.url,
);
const PRECISION_CORPUS = new URL(
  "../../../conformance/fixtures/v0/context-efficiency-rules.precision.json",
  import.meta.url,
);

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
  readonly recommendations: ContextEfficiencyRecommendations;
  readonly score: ContextEfficiencyScore;
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

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function position(text: string, offset: number): SourcePosition {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return {
    byteOffset: Buffer.byteLength(before, "utf8"),
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
  if (!result.ok) throw new Error("fixture count failed");
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
      reason: "F14 inert fixture",
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

function accounting(
  ordinal: number,
  documents: readonly DocumentFixture[],
  repeatLast = false,
  identity: TokenizerIdentity = BUILTIN_ESTIMATE_IDENTITY,
): ProfileTargetAccounting["accounting"] {
  const first = documents[0];
  if (first === undefined) throw new Error("fixture needs a document");
  const occurrences = documents.map((document, index) => ({
    contentId: `content:${digest(document.text)}`,
    depth: index === 0 ? 0 : 1,
    fromDocumentId: index === 0 ? null : first.documentId,
    id: `occurrence:${String(ordinal)}:${String(index)}`,
    importId: index === 0 ? null : `import:${String(ordinal)}:${String(index)}`,
    issueCode: null,
    ordinal: index,
    range: null,
    state: index === 0 ? ("entry" as const) : ("loaded" as const),
    targetDocumentId: document.documentId,
    targetPath: document.path,
  }));
  if (repeatLast) {
    const repeated = documents.at(-1);
    if (repeated === undefined) throw new Error("repeat fixture missing");
    occurrences.push({
      contentId: `content:${digest(repeated.text)}`,
      depth: 1,
      fromDocumentId: first.documentId,
      id: `occurrence:${String(ordinal)}:repeat`,
      importId: `import:${String(ordinal)}:repeat`,
      issueCode: null,
      ordinal: occurrences.length,
      range: null,
      state: "loaded",
      targetDocumentId: repeated.documentId,
      targetPath: repeated.path,
    });
  }
  const byDigest = new Map<string, DocumentFixture[]>();
  for (const document of documents) {
    const key = digest(document.text);
    byDigest.set(key, [...(byDigest.get(key) ?? []), document]);
  }
  const dag = {
    contents: [...byDigest].map(([sha256, members]) => ({
      byteLength: Buffer.byteLength(members[0]?.text ?? "", "utf8"),
      documentIds: members.map((document) => document.documentId),
      id: `content:${sha256}`,
      sha256,
    })),
    contractVersion: "0.1.0",
    documents: documents.map((document, index) => ({
      byteLength: Buffer.byteLength(document.text, "utf8"),
      contentId: `content:${digest(document.text)}`,
      depth: index === 0 ? 0 : 1,
      documentId: document.documentId,
      path: document.path,
      sourceId: `fixture-source:${String(ordinal)}:${String(index)}`,
      state: "loaded" as const,
    })),
    entryDocumentId: first.documentId,
    entryPath: first.path,
    graphState: "complete",
    issues: [],
    occurrences,
    recordKind: "agent-context-document-import-dag",
    traceEventIds: [`event:${String(ordinal)}`],
    traceSha256: digest(`trace:${String(ordinal)}`),
  } as unknown as DocumentImportDag;
  return accountOccurrenceTokens({
    dag,
    documentMeasurements: documents.map((document) => ({
      count: count(document.text, identity),
      documentId: document.documentId,
    })),
    identity,
    occurrenceDecisions: occurrences.map((occurrence) => {
      const document = documents.find((entry) => entry.documentId === occurrence.targetDocumentId);
      if (document === undefined) throw new Error("occurrence document missing");
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
  documents.forEach((document, index) => {
    const fixtureKey = digest(`${document.path}\0${document.text}`).slice(0, 24);
    const sourceId = `source:f14:${fixtureKey}:${String(index)}` as SourceDocumentId;
    const rootId = `node:f14:${fixtureKey}:${String(index)}:root` as AstNodeId;
    const commentMatch = /^<!--[^\n]+-->/.exec(document.text);
    const children: AstNode[] = [];
    if (commentMatch !== null) {
      children.push({
        childIds: [],
        id: `node:f14:${fixtureKey}:${String(index)}:comment` as AstNodeId,
        kind: "html-comment",
        range: range(sourceId, document.text, 0, commentMatch[0].length),
        sourceId,
      });
    }
    const bodyStart =
      commentMatch === null ? 0 : Math.min(document.text.length, commentMatch[0].length + 1);
    const paragraphId = `node:f14:${fixtureKey}:${String(index)}:paragraph` as AstNodeId;
    children.push({
      childIds: [],
      id: paragraphId,
      kind: "paragraph",
      range: range(sourceId, document.text, bodyStart),
      sourceId,
    });
    nodes.push(
      {
        childIds: children.map((entry) => entry.id),
        id: rootId,
        kind: "root",
        range: range(sourceId, document.text),
        sourceId,
      },
      ...children,
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
    const statementId = `statement:f14:${String(index)}` as InstructionStatement["id"];
    statements.push({
      classification: { state: "unclassified" },
      documentId: document.documentId,
      id: statementId,
      nodeIds: [paragraphId],
      range: range(sourceId, document.text, bodyStart),
      text: document.text.slice(bodyStart),
    });
    const activationId = `activation:f14:${String(index)}` as ActivationRule["id"];
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
      evidenceRefs: [{ factId: `fixture:${String(index)}`, sourceId: "fixture:f14" }],
      exclude: [],
      id: activationId,
      include: [],
      kind: "always",
      profileId: "codex-cli",
      scopeRoot: path("."),
      specSnapshotId: "fixture:f14/1.0.0/2026-08-03",
      surfaceId: "codex-cli/local",
      uncertainty: { state: "known" },
      unknownReason: null,
    });
  });
  const value: InstructionIr = {
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
  };
  const result = validateInstructionIr(value);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function metricsFor(input: {
  readonly classificationState?: "complete" | "partial";
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
  if (firstResolution === undefined) throw new Error("profile fixture missing");
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
      classificationState: input.classificationState ?? "complete",
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
        throw new Error("statement source missing");
      return {
        count: count(statement.text, identity),
        statement: {
          documentId: document.documentId,
          nodeIds: statement.nodeIds,
          range: statement.range,
          statementId: `statement:f14:metric:${String(index)}` as never,
          text: statement.text,
        },
      };
    }),
  };
  return analyzeContextEfficiencyMetrics(request);
}

async function partialEvidenceFixture(): Promise<IssuedFixture> {
  const text = "Repository background without complete classification evidence.";
  const target = path("src/partial.ts");
  const resolved = context(target, [{ content: text, path: path("AGENTS.md") }]);
  const documentId = resolved.sourceDocumentIds[0];
  if (documentId === undefined) throw new Error("partial document missing");
  const documents = [{ documentId, path: path("AGENTS.md"), text }];
  const metrics = metricsFor({
    classificationState: "partial",
    contexts: [{ context: resolved, documents }],
    documents,
  });
  const score = calculateContextEfficiencyScore(metrics);
  const recommendations = await projectContextEfficiencyRecommendations({
    contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
    metrics,
    recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
    scenarios: [],
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
    recommendations,
    score,
  };
}

async function scopeFixture(
  text = "Repository background and architecture details. ".repeat(32),
): Promise<IssuedFixture> {
  const targets = [path("src/web.ts"), path("src/api.ts")];
  const contexts = targets.map((target) =>
    context(target, [{ content: text, path: path("AGENTS.md") }]),
  );
  const firstContext = contexts[0];
  const secondContext = contexts[1];
  const secondTarget = targets[1];
  const documentId = firstContext?.sourceDocumentIds[0];
  if (
    documentId === undefined ||
    firstContext === undefined ||
    secondContext === undefined ||
    secondTarget === undefined
  )
    throw new Error("scope fixture incomplete");
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
    id: "recommendation:f14:scope",
    targets: [
      {
        baseline: firstContext.input,
        projected: firstContext.input,
      },
      {
        baseline: secondContext.input,
        projected: context(secondTarget, []).input,
      },
    ],
  };
  const recommendations = await projectContextEfficiencyRecommendations({
    contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
    metrics,
    recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
    scenarios: [scenario],
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
    recommendations,
    score,
  };
}

async function unprovedIntendedScopeFixture(): Promise<IssuedFixture> {
  const text = "Repository background and architecture details. ".repeat(24);
  const targets = [path("src/web.ts"), path("src/api.ts"), path("src/worker.ts")];
  const contexts = targets.map((target) =>
    context(target, [{ content: text, path: path("AGENTS.md") }]),
  );
  const firstContext = contexts[0];
  const secondContext = contexts[1];
  const thirdContext = contexts[2];
  const thirdTarget = targets[2];
  const documentId = firstContext?.sourceDocumentIds[0];
  if (
    documentId === undefined ||
    firstContext === undefined ||
    secondContext === undefined ||
    thirdContext === undefined ||
    thirdTarget === undefined
  )
    throw new Error("multi-target scope fixture incomplete");
  const documents = [{ documentId, path: path("AGENTS.md"), text }];
  const unavailableIdentity: TokenizerIdentity = {
    id: "fixture:unavailable-tokenizer",
    measurement: "exact",
    version: "1.0.0",
  };
  const metrics = metricsFor({
    contexts: contexts.map((entry) => ({ context: entry, documents })),
    documents,
    identity: unavailableIdentity,
  });
  const score = calculateContextEfficiencyScore(metrics);
  const recommendations = await projectContextEfficiencyRecommendations({
    contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
    metrics,
    recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
    scenarios: [
      {
        evidenceDocumentIds: [documentId],
        evidenceId: documentId,
        id: "recommendation:f14:unproved-intended",
        targets: [
          {
            baseline: firstContext.input,
            projected: firstContext.input,
          },
          {
            baseline: secondContext.input,
            projected: secondContext.input,
          },
          {
            baseline: thirdContext.input,
            projected: context(thirdTarget, []).input,
          },
        ],
      },
    ],
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
    recommendations,
    score,
  };
}

async function duplicateFixture(
  text = "Always run the repository verification suite before submitting changes. ".repeat(12),
  vendorSpecific = false,
): Promise<IssuedFixture> {
  const target = path("src/example.ts");
  const baseline = context(target, [
    { content: text, path: path("AGENTS.md") },
    { content: text, path: path("src/AGENTS.md") },
  ]);
  const first = resolvedDocumentId(baseline, path("AGENTS.md"));
  const second = resolvedDocumentId(baseline, path("src/AGENTS.md"));
  const ids = [first, second].sort();
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
  if (cluster === undefined) throw new Error("duplicate cluster missing");
  const recommendations = await projectContextEfficiencyRecommendations({
    contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
    metrics,
    recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
    scenarios: [
      {
        evidenceDocumentIds: ids,
        evidenceId: cluster.id,
        id: "recommendation:f14:duplicate",
        targets: [
          {
            baseline: baseline.input,
            projected: context(target, [{ content: text, path: path("AGENTS.md") }]).input,
          },
        ],
      },
    ],
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
    recommendations,
    score,
  };
}

async function amplificationFixture(
  text = "Use pnpm test for verification. ".repeat(24),
): Promise<IssuedFixture> {
  const target = path("src/amplified.ts");
  const resolved = context(target, [{ content: text, path: path("AGENTS.md") }]);
  const documentId = resolved.sourceDocumentIds[0];
  if (documentId === undefined) throw new Error("amplification document missing");
  const documents = [{ documentId, path: path("AGENTS.md"), text }];
  const metrics = metricsFor({
    contexts: [{ context: resolved, documents, repeatLast: true }],
    documents,
  });
  const score = calculateContextEfficiencyScore(metrics);
  const recommendations = await projectContextEfficiencyRecommendations({
    contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
    metrics,
    recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
    scenarios: [],
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
    recommendations,
    score,
  };
}

async function vendorSpecificDuplicateFixture(
  text = "Always run the complete verification suite before submitting changes. ".repeat(12),
): Promise<IssuedFixture> {
  return duplicateFixture(text, true);
}

function incompatibleScoreFor(fixture: IssuedFixture): ContextEfficiencyScore {
  const exactIdentity: TokenizerIdentity = {
    id: "fixture:exact-tokenizer",
    measurement: "exact",
    version: "1.0.0",
  };
  const source = fixture.ir.sources[0];
  if (source === undefined) throw new Error("source missing");
  const target = path("src/tokenizer.ts");
  const resolved = context(target, [{ content: source.text, path: source.path }]);
  const documentId = resolved.sourceDocumentIds[0];
  if (documentId === undefined) throw new Error("exact document missing");
  const documents = [{ documentId, path: source.path, text: source.text }];
  return calculateContextEfficiencyScore(
    metricsFor({
      contexts: [{ context: resolved, documents }],
      documents,
      identity: exactIdentity,
    }),
  );
}

describe("F14 context-efficiency rules", () => {
  test("validates one positive and one negative precision label for every rule", () => {
    const schema = JSON.parse(readFileSync(PRECISION_SCHEMA, "utf8")) as AnySchema;
    const corpus = JSON.parse(readFileSync(PRECISION_CORPUS, "utf8")) as {
      readonly cases: readonly { readonly expected: string; readonly ruleId: string }[];
    };
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(corpus), JSON.stringify(validate.errors)).toBe(true);
    for (const ruleId of CONTEXT_EFFICIENCY_RULE_IDS)
      expect(
        corpus.cases
          .filter((entry) => entry.ruleId === ruleId)
          .map((entry) => entry.expected)
          .sort(),
      ).toEqual(["finding", "no-finding"]);
  });
  test("emits resolved budget, scope, density, and unbenchmarked projection findings", async () => {
    const fixture = await scopeFixture();
    expect(fixture.recommendations.evaluations).toMatchObject([
      { reasonCodes: [], state: "recommended" },
    ]);
    expect(isIssuedContextEfficiencyRecommendations(fixture.recommendations)).toBe(true);
    expect(isIssuedContextEfficiencyRecommendations({ ...fixture.recommendations })).toBe(false);
    const result = evaluateContextEfficiencyRules(fixture.input, {
      highImpactSavingBasisPoints: 1,
      highImpactSavingTokens: 1,
      minimumDensityBasisPoints: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.diagnostics.map((entry) => entry.ruleId)).toEqual([
      "ACL550",
      "ACL551",
      "ACL553",
      "ACL556",
      "ACL558",
    ]);
    const budgetDiagnostics = result.bundle.diagnostics.filter(
      (entry) => entry.ruleId === "ACL550" || entry.ruleId === "ACL551",
    );
    expect(budgetDiagnostics.map((entry) => entry.ruleId)).toEqual(["ACL550", "ACL551"]);
    expect(budgetDiagnostics[0]?.primary).toEqual(budgetDiagnostics[1]?.primary);
    expect(
      result.uncertainties.filter(
        (entry) => entry.reason === "score-caveated" && /^ACL55[01]$/u.test(entry.ruleId),
      ),
    ).toHaveLength(2);
    expect(result.bundle.diagnostics.every((entry) => !entry.message.includes("ACL350"))).toBe(
      true,
    );
    expect(result.bundle.diagnostics.find((entry) => entry.ruleId === "ACL553")?.message).toContain(
      "quality preservation are not claimed",
    );
    expect(validateDiagnosticBundle(result.bundle, result.sources).ok).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    await expect(
      `${JSON.stringify({ bundle: result.bundle, sources: result.sources }, null, 2)}\n`,
    ).toMatchFileSnapshot("fixtures/context-efficiency.scope.golden.json");
  });

  test("suppresses scope advice when multiple intended targets lack retention proof", async () => {
    const fixture = await unprovedIntendedScopeFixture();
    const evaluation = fixture.recommendations.evaluations[0];
    expect(evaluation?.targetProjections.filter((entry) => entry.role === "intended")).toHaveLength(
      2,
    );
    expect(
      evaluation?.targetProjections
        .filter((entry) => entry.role === "intended")
        .every((entry) => entry.retention.state === "unknown"),
    ).toBe(true);
    expect(evaluation).toMatchObject({ state: "indeterminate" });
    const result = evaluateContextEfficiencyRules(fixture.input, {
      highImpactSavingBasisPoints: 1,
      highImpactSavingTokens: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.bundle.diagnostics.some((entry) => entry.ruleId === "ACL553")).toBe(
      false,
    );
  });

  test("records partial G05 components as uncertainty without findings", async () => {
    const fixture = await partialEvidenceFixture();
    expect(fixture.metrics.state).toBe("partial");
    const result = evaluateContextEfficiencyRules(fixture.input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.uncertainties.map((entry) => entry.ruleId)).toEqual([
      "ACL550",
      "ACL551",
      "ACL552",
      "ACL556",
    ]);
  });

  test("emits only complete exact-duplicate evidence and never claims equivalence", async () => {
    const fixture = await duplicateFixture();
    const result = evaluateContextEfficiencyRules(fixture.input, { duplicateTokens: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const duplicate = result.bundle.diagnostics.find((entry) => entry.ruleId === "ACL552");
    expect(duplicate?.severity).toBe("warning");
    expect(duplicate?.message).toContain("semantic equivalence is not claimed");
    expect(result.bundle.diagnostics.some((entry) => entry.ruleId === "ACL350")).toBe(false);
    const aboveBoundary = evaluateContextEfficiencyRules(fixture.input, {
      duplicateTokens: fixture.metrics.duplication.exact.redundantTokens + 1,
    });
    expect(
      aboveBoundary.ok &&
        aboveBoundary.bundle.diagnostics.some((entry) => entry.ruleId === "ACL552"),
    ).toBe(false);
    expect(result.bundle.diagnostics.some((entry) => entry.ruleId === "ACL555")).toBe(false);
  });

  test("reports material import amplification only above the no-amplification baseline", async () => {
    const fixture = await amplificationFixture();
    const result = evaluateContextEfficiencyRules(fixture.input, {
      importAmplificationBasisPoints: 10_001,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.diagnostics.find((entry) => entry.ruleId === "ACL554")?.message).toContain(
      "20000 basis points",
    );
    const boundary = evaluateContextEfficiencyRules(fixture.input, {
      importAmplificationBasisPoints: 20_001,
    });
    expect(
      boundary.ok && boundary.bundle.diagnostics.some((entry) => entry.ruleId === "ACL554"),
    ).toBe(false);
  });

  test("reports only a reconciled vendor-format exact consolidation projection", async () => {
    const fixture = await vendorSpecificDuplicateFixture();
    const projection = fixture.recommendations.evaluations[0]?.targetProjections[0];
    expect(projection?.baseline.analysisStatus).toBe("partial");
    expect(typeof projection?.baseline.assemblySha256).toBe("string");
    expect(typeof projection?.baseline.tokens).toBe("number");
    expect(typeof projection?.projected.tokens).toBe("number");
    expect(fixture.recommendations.evaluations).toMatchObject([
      { kind: "exact-duplicate-consolidation", reasonCodes: [], state: "recommended" },
    ]);
    const result = evaluateContextEfficiencyRules(fixture.input, {
      duplicateTokens: 1,
      highImpactSavingBasisPoints: 1,
      highImpactSavingTokens: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const consolidation = result.bundle.diagnostics.find((entry) => entry.ruleId === "ACL555");
    expect(consolidation?.fingerprintBasis.semantic.profileIds).toEqual(["codex-cli"]);
    expect(consolidation?.fingerprintBasis.semantic.components).toContainEqual({
      key: "format-ids",
      value: "15:agents-markdown|22:claude-memory-markdown",
    });
    expect(consolidation?.message).toContain(
      "semantic equivalence, necessity, and quality preservation are not claimed",
    );
  });

  test("rejects incompatible tokenizer comparisons without comparing their scores", async () => {
    const fixture = await scopeFixture();
    const sourceDocument = fixture.ir.documents[0];
    if (sourceDocument === undefined) throw new Error("source missing");
    const exactScore = incompatibleScoreFor(fixture);
    const result = evaluateContextEfficiencyRules({
      ...fixture.input,
      tokenizerComparisons: [
        {
          baseline: fixture.score,
          candidate: exactScore,
          id: "comparison:f14:tokenizers",
          sourceDocumentId: sourceDocument.id,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.diagnostics.find((entry) => entry.ruleId === "ACL557")?.message).toContain(
      "incompatible",
    );
    const compatible = evaluateContextEfficiencyRules({
      ...fixture.input,
      tokenizerComparisons: [
        {
          baseline: fixture.score,
          candidate: fixture.score,
          id: "comparison:f14:compatible",
          sourceDocumentId: sourceDocument.id,
        },
      ],
    });
    expect(
      compatible.ok && compatible.bundle.diagnostics.some((entry) => entry.ruleId === "ACL557"),
    ).toBe(false);
  });

  test("records one formatter golden diagnostic for every efficiency rule", async () => {
    const scope = await scopeFixture();
    const sourceDocument = scope.ir.documents[0];
    if (sourceDocument === undefined) throw new Error("source missing");
    const scopeResult = evaluateContextEfficiencyRules(
      {
        ...scope.input,
        tokenizerComparisons: [
          {
            baseline: scope.score,
            candidate: incompatibleScoreFor(scope),
            id: "comparison:f14:formatter",
            sourceDocumentId: sourceDocument.id,
          },
        ],
      },
      { highImpactSavingBasisPoints: 1, highImpactSavingTokens: 1, minimumDensityBasisPoints: 1 },
    );
    const duplicate = await duplicateFixture();
    const duplicateResult = evaluateContextEfficiencyRules(duplicate.input, { duplicateTokens: 1 });
    const amplification = await amplificationFixture();
    const amplificationResult = evaluateContextEfficiencyRules(amplification.input, {
      importAmplificationBasisPoints: 10_001,
    });
    const vendor = await vendorSpecificDuplicateFixture();
    const vendorResult = evaluateContextEfficiencyRules(vendor.input, {
      duplicateTokens: 1,
      highImpactSavingBasisPoints: 1,
      highImpactSavingTokens: 1,
    });
    const results = [scopeResult, duplicateResult, amplificationResult, vendorResult];
    if (results.some((entry) => !entry.ok)) throw new Error("formatter fixture evaluation failed");
    const successfulResults = results.filter(
      (entry): entry is Extract<typeof entry, { readonly ok: true }> => entry.ok,
    );
    const diagnosticByRule = new Map(
      successfulResults
        .flatMap((entry) => entry.bundle.diagnostics)
        .map((entry) => [entry.ruleId, entry]),
    );
    expect([...diagnosticByRule.keys()].sort()).toEqual([...CONTEXT_EFFICIENCY_RULE_IDS]);
    const sources = [
      ...new Map(
        successfulResults
          .flatMap((entry) => entry.sources)
          .map((source) => [source.id, source] as const),
      ).values(),
    ];
    const bundle: DiagnosticBundle = {
      contractVersion: scopeResult.ok ? scopeResult.bundle.contractVersion : "0.1.0",
      diagnostics: [...diagnosticByRule.values()].sort((left, right) =>
        left.ruleId.localeCompare(right.ruleId),
      ),
      recordKind: "agent-context-diagnostics",
      suppressions: [],
    };
    expect(validateDiagnosticBundle(bundle, sources).ok).toBe(true);
    await expect(`${JSON.stringify({ bundle, sources }, null, 2)}\n`).toMatchFileSnapshot(
      "fixtures/context-efficiency.all-rules.golden.json",
    );
  });

  test("fails closed for forged, malformed, unbounded, and cross-analysis evidence", async () => {
    const fixture = await scopeFixture();
    expect(
      evaluateContextEfficiencyRules({ ...fixture.input, contractVersion: "9.9.9" }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-input" }] });
    expect(evaluateContextEfficiencyRules({ ...fixture.input, ir: {} })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-input", path: "$.ir" }],
    });
    expect(
      evaluateContextEfficiencyRules({ ...fixture.input, metrics: { ...fixture.metrics } }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-input", path: "$.metrics" }] });
    expect(
      evaluateContextEfficiencyRules({ ...fixture.input, score: { ...fixture.score } }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-input", path: "$.score" }] });
    expect(
      evaluateContextEfficiencyRules({
        ...fixture.input,
        recommendations: { ...fixture.recommendations },
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-input", path: "$.recommendations" }] });
    expect(evaluateContextEfficiencyRules({ ...fixture.input, extra: true })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-input" }],
    });
    expect(evaluateContextEfficiencyRules(new Proxy({}, {}))).toMatchObject({ ok: false });
    expect(evaluateContextEfficiencyRules(Object.create(null))).toMatchObject({ ok: false });
    expect(
      evaluateContextEfficiencyRules(
        Object.defineProperty({ ...fixture.input }, "metrics", {
          enumerable: true,
          get: () => fixture.metrics,
        }),
      ),
    ).toMatchObject({ ok: false });
    const sparse = new Array(1) as unknown[];
    expect(
      evaluateContextEfficiencyRules({ ...fixture.input, tokenizerComparisons: sparse }),
    ).toMatchObject({ ok: false });
    expect(
      evaluateContextEfficiencyRules({
        ...fixture.input,
        tokenizerComparisons: new Proxy([], {}),
      }),
    ).toMatchObject({ ok: false });
    const foreignArray: unknown[] = [];
    Object.setPrototypeOf(foreignArray, null);
    expect(
      evaluateContextEfficiencyRules({ ...fixture.input, tokenizerComparisons: foreignArray }),
    ).toMatchObject({ ok: false });
    expect(
      evaluateContextEfficiencyRules({
        ...fixture.input,
        tokenizerComparisons: Array.from(
          { length: CONTEXT_EFFICIENCY_RULE_MAX_COMPARISONS + 1 },
          () => ({}),
        ),
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "resource-limit" }] });
    expect(evaluateContextEfficiencyRules(fixture.input, { duplicateTokens: 0 })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-options" }],
    });
    expect(evaluateContextEfficiencyRules(fixture.input, null)).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-options" }],
    });
    expect(evaluateContextEfficiencyRules(fixture.input, { extra: 1 })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-options" }],
    });
    expect(
      evaluateContextEfficiencyRules(
        fixture.input,
        Object.defineProperty({}, "duplicateTokens", { enumerable: true, get: () => 1 }),
      ),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-options" }] });
    expect(evaluateContextEfficiencyRules(fixture.input, new Proxy({}, {}))).toMatchObject({
      ok: false,
    });
    const sourceDocument = fixture.ir.documents[0];
    if (sourceDocument === undefined) throw new Error("source missing");
    expect(
      evaluateContextEfficiencyRules({ ...fixture.input, tokenizerComparisons: [{}] }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-input" }] });
    expect(
      evaluateContextEfficiencyRules({
        ...fixture.input,
        tokenizerComparisons: [
          {
            baseline: fixture.score,
            candidate: fixture.score,
            id: "not valid",
            sourceDocumentId: sourceDocument.id,
          },
        ],
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-input" }] });
    expect(
      evaluateContextEfficiencyRules({
        ...fixture.input,
        tokenizerComparisons: [
          {
            baseline: fixture.score,
            candidate: fixture.score,
            id: "comparison:f14:missing-source",
            sourceDocumentId: "document:missing",
          },
        ],
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-relationship" }] });
    expect(
      evaluateContextEfficiencyRules({
        ...fixture.input,
        tokenizerComparisons: [
          {
            baseline: { ...fixture.score },
            candidate: fixture.score,
            id: "comparison:f14:forged-score",
            sourceDocumentId: sourceDocument.id,
          },
        ],
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-input" }] });
    const other = await duplicateFixture();
    expect(
      evaluateContextEfficiencyRules({ ...fixture.input, recommendations: other.recommendations }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-relationship" }] });
  });

  test("finalizes B08 suppressions for every efficiency rule only from issued evaluations", async () => {
    const text =
      "<!-- agent-context-lint-disable-next-line ACL550, ACL551, ACL553, ACL556, ACL558 -- accepted fixture -->\n" +
      "Repository background and architecture details. ".repeat(32);
    const fixture = await scopeFixture(text);
    const evaluation = evaluateContextEfficiencyRules(fixture.input, {
      highImpactSavingBasisPoints: 1,
      highImpactSavingTokens: 1,
      minimumDensityBasisPoints: 1,
    });
    expect(evaluation.ok).toBe(true);
    const finalized = finalizeContextEfficiencySuppressions(evaluation);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    expect(finalized.suppressedDiagnostics.map((entry) => entry.ruleId).sort()).toEqual([
      "ACL550",
      "ACL551",
      "ACL553",
      "ACL556",
      "ACL558",
    ]);
    expect(finalizeContextEfficiencySuppressions({ ...evaluation })).toMatchObject({ ok: false });
    expect(finalizeContextEfficiencySuppressions(null)).toMatchObject({ ok: false });
    expect(finalizeContextEfficiencySuppressions(new Proxy({}, {}))).toMatchObject({ ok: false });

    const duplicate = await duplicateFixture(
      "<!-- agent-context-lint-disable-next-line ACL552 -- accepted fixture -->\n" +
        "Always run the repository verification suite before submitting changes. ".repeat(12),
    );
    const duplicateEvaluation = evaluateContextEfficiencyRules(duplicate.input, {
      duplicateTokens: 1,
    });
    const duplicateFinalized = finalizeContextEfficiencySuppressions(duplicateEvaluation);
    expect(
      duplicateFinalized.ok &&
        duplicateFinalized.suppressedDiagnostics.some((entry) => entry.ruleId === "ACL552"),
    ).toBe(true);

    const amplification = await amplificationFixture(
      "<!-- agent-context-lint-disable-next-line ACL554 -- accepted fixture -->\n" +
        "Use pnpm test for verification. ".repeat(24),
    );
    const amplificationFinalized = finalizeContextEfficiencySuppressions(
      evaluateContextEfficiencyRules(amplification.input, {
        importAmplificationBasisPoints: 10_001,
      }),
    );
    expect(
      amplificationFinalized.ok &&
        amplificationFinalized.suppressedDiagnostics.some((entry) => entry.ruleId === "ACL554"),
    ).toBe(true);

    const consolidation = await vendorSpecificDuplicateFixture(
      "<!-- agent-context-lint-disable-next-line ACL555 -- accepted fixture -->\n" +
        "Always run the complete verification suite before submitting changes. ".repeat(12),
    );
    const consolidationFinalized = finalizeContextEfficiencySuppressions(
      evaluateContextEfficiencyRules(consolidation.input, { duplicateTokens: 1 }),
    );
    expect(
      consolidationFinalized.ok &&
        consolidationFinalized.suppressedDiagnostics.some((entry) => entry.ruleId === "ACL555"),
    ).toBe(true);

    const tokenizer = await scopeFixture(
      "<!-- agent-context-lint-disable-next-line ACL557 -- accepted fixture -->\n" +
        "Repository background and architecture details. ".repeat(32),
    );
    const tokenizerSource = tokenizer.ir.documents[0];
    if (tokenizerSource === undefined) throw new Error("tokenizer source missing");
    const tokenizerFinalized = finalizeContextEfficiencySuppressions(
      evaluateContextEfficiencyRules({
        ...tokenizer.input,
        tokenizerComparisons: [
          {
            baseline: tokenizer.score,
            candidate: incompatibleScoreFor(tokenizer),
            id: "comparison:f14:suppressed",
            sourceDocumentId: tokenizerSource.id,
          },
        ],
      }),
    );
    expect(
      tokenizerFinalized.ok &&
        tokenizerFinalized.suppressedDiagnostics.some((entry) => entry.ruleId === "ACL557"),
    ).toBe(true);
  });
});
