import { createHash } from "node:crypto";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  createInstructionIrSnapshot,
  validateInstructionIr,
} from "@agent-context/core";
import {
  BUILTIN_ESTIMATE_IDENTITY,
  CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
  analyzeContextEfficiencyMetrics,
  calculateContextEfficiencyScore,
  projectContextEfficiencyRecommendations,
} from "@agent-context/efficiency";
import {
  EVIDENCE_INDEX_CONTRACT_VERSION,
  EVIDENCE_INDEX_DEFAULT_LIMITS,
} from "@agent-context/evidence";
import {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  compareEffectiveContexts,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveEffectiveContext,
  sampleTargets,
} from "@agent-context/resolver";
import { loadBundledKnowledgePack } from "@agent-context/standards";

import {
  CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION,
  RULE_FAMILY_IDS,
  RULE_SCHEDULER_CONTRACT_VERSION,
  RULE_SCHEDULER_RECORD_KIND,
} from "../../src/index.js";

import type {
  AstNodeId,
  InstructionDocumentId,
  InstructionIr,
  InstructionStatementId,
  RepositoryRelativePath,
  SourceDocumentId,
  SourcePosition,
} from "@agent-context/core";
import type { RepositoryEvidenceIndex } from "@agent-context/evidence";
import type {
  CrossProfileComparison,
  EffectiveContextProfileResolution,
  EffectiveContextResolution,
} from "@agent-context/resolver";
import type { RuleFamilyRequest, RuleSchedulerInput } from "../../src/index.js";

function minimalIr(
  text = "<!-- agent-context-lint-disable-next-line ACL300 -- reason: fixture -->\nRun npm run missing\nRun npm run another-missing\n",
  parseState: "complete" | "malformed" = "complete",
): InstructionIr {
  const sourceId = "source:scheduler" as SourceDocumentId;
  const rootNodeId = "node:scheduler:root" as AstNodeId;
  const documentId = "document:scheduler" as InstructionDocumentId;
  const lines = text.trimEnd().split("\n");
  let offset = 0;
  const children: InstructionIr["nodes"][number][] = [];
  const statements: InstructionIr["statements"][number][] = [];
  const position = (utf16Offset: number, line: number, utf16Column: number): SourcePosition => ({
    byteOffset: Buffer.byteLength(text.slice(0, utf16Offset), "utf8"),
    line,
    utf16Column,
    utf16Offset,
  });
  for (const [line, lineText] of lines.entries()) {
    const nodeId = `node:scheduler:${String(line)}` as AstNodeId;
    const start = offset;
    const end = start + lineText.length;
    children.push({
      childIds: [],
      id: nodeId,
      kind: lineText.startsWith("<!--") ? "html-comment" : "paragraph",
      range: {
        end: position(end, line, lineText.length),
        sourceId,
        start: position(start, line, 0),
      },
      sourceId,
    });
    if (!lineText.startsWith("<!--"))
      statements.push({
        classification: { state: "unclassified" },
        documentId,
        id: `statement:scheduler:${String(line)}` as InstructionStatementId,
        nodeIds: [nodeId],
        range: {
          end: position(end, line, lineText.length),
          sourceId,
          start: position(start, line, 0),
        },
        text: lineText,
      });
    offset = end + 1;
  }
  const value: InstructionIr = {
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: [
      {
        activationRuleIds: [],
        formatId: "agents-markdown",
        id: documentId,
        importIds: [],
        rootNodeId,
        scopeRoot: canonicalizeRepositoryRelativePath("."),
        sourceId,
        statementIds: statements.map((entry) => entry.id),
      },
    ],
    events: [],
    imports: [],
    nodes: [
      {
        childIds: children.map((entry) => entry.id),
        id: rootNodeId,
        kind: "root",
        range: {
          end: {
            byteOffset: Buffer.byteLength(text, "utf8"),
            line: lines.length,
            utf16Column: 0,
            utf16Offset: text.length,
          },
          sourceId,
          start: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
        },
        sourceId,
      },
      ...children,
    ],
    recordKind: "agent-context-instruction-ir",
    sources: [
      {
        bom: "none",
        byteLength: Buffer.byteLength(text, "utf8"),
        encoding: "utf-8",
        id: sourceId,
        lineEnding: "lf",
        parseState:
          parseState === "complete"
            ? { state: "complete" }
            : { reason: "malformed scheduler fixture", state: "malformed" },
        path: canonicalizeRepositoryRelativePath("AGENTS.md"),
        rootNodeId,
        sha256: createHash("sha256").update(text, "utf8").digest("hex"),
        text,
        utf16Length: text.length,
      },
    ],
    statements,
    targets: [],
  };
  const checked = validateInstructionIr(value);
  if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
  const snapshot = createInstructionIrSnapshot(checked.value);
  if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.issues));
  return snapshot.value;
}

const encoder = new TextEncoder();

function effective(
  profileResolution: EffectiveContextProfileResolution,
): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: canonicalizeRepositoryRelativePath("src/main.ts"),
  });
}

function portabilityComparison(): CrossProfileComparison {
  const targetPath = canonicalizeRepositoryRelativePath("src/main.ts");
  const codex = effective(
    resolveCodexCliAgents({
      discovery: {
        certainty: "known",
        entries: [
          {
            bytes: encoder.encode("Repository instructions.\n"),
            errorCode: null,
            kind: "file",
            path: canonicalizeRepositoryRelativePath("AGENTS.md"),
            resolvedTarget: null,
          },
        ],
        reason: "complete scheduler fixture",
        rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
      },
      externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
      launchCwd: canonicalizeRepositoryRelativePath("src"),
      settings: {
        projectDocFallbackFilenames: [],
        projectDocMaxBytes: 32_768,
        projectRootMarkers: [".git"],
      },
      targetPath,
    }),
  );
  const claude = effective(
    resolveClaudeCodeProfile({
      candidates: [
        {
          absolutePath: "/fixture/CLAUDE.md",
          bytes: encoder.encode("Repository instructions.\n"),
          importGraph: null,
          kind: "memory-shared",
          origin: "repository",
          path: canonicalizeRepositoryRelativePath("CLAUDE.md"),
          scopeRoot: canonicalizeRepositoryRelativePath("."),
          symlinkState: "none",
        },
      ],
      launchCwd: canonicalizeRepositoryRelativePath("."),
      repositoryRoot: canonicalizeRepositoryRelativePath("."),
      runtime: {
        additionalDirectoryInstructions: "disabled",
        clientVersion: "2.1.33",
        eventTrace: [
          { id: "scheduler-launch", kind: "launch", path: canonicalizeRepositoryRelativePath(".") },
        ],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "supplied",
        mode: "normal",
        settingSources: { state: "known", values: [] },
      },
    }),
  );
  return compareEffectiveContexts({
    contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
    recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
    resolutions: [codex, claude],
  });
}

function emptyEvidence(): RepositoryEvidenceIndex {
  return Object.freeze({
    conflicts: Object.freeze([]),
    contractVersion: EVIDENCE_INDEX_CONTRACT_VERSION,
    facts: Object.freeze([]),
    issues: Object.freeze([]),
    limits: EVIDENCE_INDEX_DEFAULT_LIMITS,
    metrics: Object.freeze({
      conflictCount: 0,
      contentReads: 0,
      factCount: 0,
      issueCount: 0,
      pathCount: 0,
      totalBytes: 0,
    }),
    uncertainty: "known",
    uncertaintyReasons: Object.freeze([]),
  });
}

/** Build all ten requests using only genuine production-issued authorities. */
export async function fullRuleSchedulerInput(
  options: { readonly parseState?: "complete" | "malformed" } = {},
): Promise<RuleSchedulerInput> {
  const ir = minimalIr(undefined, options.parseState);
  const samplingInput = {
    criticalPaths: Object.freeze([]),
    paths: Object.freeze([]) as readonly RepositoryRelativePath[],
    trackingCertainty: "tracked" as const,
    trackingReason: "verified-git-index" as const,
    workspaceBoundaries: Object.freeze([]),
    workspaceUncertainty: "known" as const,
    workspaceUncertaintyReasons: Object.freeze([]),
  };
  const sampling = sampleTargets({ ...samplingInput, activationObservations: [] });
  const metrics = analyzeContextEfficiencyMetrics({
    comparisons: [],
    contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
    documents: [],
    identity: BUILTIN_ESTIMATE_IDENTITY,
    profiles: [
      {
        accountings: [],
        profile: {
          clientVersion: "fixture",
          profileId: "codex-cli",
          profileVersion: "fixture",
          specSnapshotId: "fixture:scheduler",
          surfaceId: "codex-cli/local",
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
  const loaded = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const source = ir.sources[0];
  if (source === undefined) throw new Error("scheduler fixture source is missing");
  const sourceId = source.id;
  const families: RuleFamilyRequest[] = [
    {
      familyId: "syntax-structure",
      input: {
        contractVersion: "0.1.0",
        documents: [
          {
            dialect: null,
            fields: [],
            format: [],
            location: [],
            sourceId,
            vendorId: "fixture",
          },
        ],
        ir,
        recordKind: "agent-context-syntax-structure-rule-input",
      },
      options: undefined,
    },
    {
      familyId: "references-imports",
      input: {
        contractVersion: "0.1.0",
        graphs: [],
        ir,
        pathSnapshot: { completeness: "complete", paths: [] },
        recordKind: "agent-context-references-imports-rule-input",
        targets: [],
      },
      options: undefined,
    },
    {
      familyId: "scope-activation",
      input: {
        activationResults: [],
        contractVersion: "0.1.0",
        facts: [],
        ir,
        recordKind: "agent-context-scope-activation-rule-input",
        sampling: samplingInput,
      },
      options: undefined,
    },
    {
      familyId: "conflicts-duplication",
      input: {
        contexts: [],
        contractVersion: "0.1.0",
        ir,
        recordKind: "agent-context-conflicts-duplication-rule-input",
      },
      options: undefined,
    },
    {
      familyId: "repository-drift",
      input: {
        evidenceIndex: emptyEvidence(),
        statements: ir.statements.map((statement) => ({
          dialect: "posix-shell",
          documentId: statement.documentId,
          nodeIds: statement.nodeIds,
          path: source.path,
          range: statement.range,
          sourceDigest: source.sha256,
          statementId: statement.id,
          text: statement.text,
        })),
      },
      options: undefined,
    },
    {
      familyId: "document-context",
      input: {
        contractVersion: "0.1.0",
        importResolutions: [],
        ir,
        recordKind: "agent-context-document-context-rule-input",
      },
      options: undefined,
    },
    {
      familyId: "security",
      input: {
        contractVersion: "0.1.0",
        ir,
        recordKind: "agent-context-security-rule-input",
        statementDialects: [],
      },
      options: undefined,
    },
    {
      familyId: "portability",
      input: {
        behaviorObservations: [],
        comparisons: [portabilityComparison()],
        contractVersion: "0.1.0",
        formatInventoryState: "complete",
        formatObservations: [],
        ir,
        recordKind: "agent-context-portability-rule-input",
      },
      options: undefined,
    },
    {
      familyId: "standards-freshness",
      input: {
        anchorSourceId: sourceId,
        contractVersion: "0.1.0",
        deprecatedSyntax: [],
        environment: "local",
        ir,
        liveUpdates: [],
        previewEnabled: false,
        recordKind: "agent-context-standards-freshness-rule-input",
        statusRequest: {
          asOf: "2026-08-08T00:00:00Z",
          bundled: loaded.value,
          cachedLatest: null,
          engineVersion: "0.0.0",
          lockfile: null,
          maxAgeDays: 365,
        },
      },
      options: undefined,
    },
    {
      familyId: "context-efficiency",
      input: {
        contractVersion: CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION,
        ir,
        metrics,
        recommendations,
        recordKind: "agent-context-efficiency-rule-input",
        score,
        tokenizerComparisons: [],
      },
      options: undefined,
    },
  ];
  if (families.length !== RULE_FAMILY_IDS.length)
    throw new Error("fixture family set is incomplete");
  return {
    contractVersion: RULE_SCHEDULER_CONTRACT_VERSION,
    families,
    policy: { failureThreshold: "error", severityOverrides: {} },
    recordKind: RULE_SCHEDULER_RECORD_KIND,
  };
}
