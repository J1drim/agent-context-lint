import { createHash } from "node:crypto";
import path from "node:path";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  compareRepositoryRelativePaths,
  createInstructionIrSnapshot,
  type ActivationRule,
  type ActivationRuleId,
  type AgentContextConfiguration,
  type AstNodeId,
  type DiagnosticBundle,
  type InstructionDocument,
  type InstructionDocumentId,
  type InstructionIr,
  type InstructionIrSnapshot,
  type ProfileVersionIdentity,
  type RepositoryRelativePath,
  type SourceRange,
} from "@agent-context/core";
import {
  BUILTIN_ESTIMATE_IDENTITY,
  CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
  analyzeContextEfficiencyMetrics,
  accountOccurrenceTokens,
  calculateContextEfficiencyScore,
  combineOccurrenceTokenAccountings,
  countEstimatedTokens,
  createContextEfficiencyReport,
  projectContextEfficiencyRecommendations,
  type ContextEfficiencyReport,
  type ContextEfficiencyMetrics,
  type EfficiencyRecommendationScenario,
  type EfficiencyMetricProfileInput,
} from "@agent-context/efficiency/scan-runtime";
import {
  applyIgnoreRules,
  buildTargetedDiscoveryIndex,
  collectGitChangedFileMetadata,
  collectRepositoryEvidence,
  createChangedFileScanScope,
  createGitMetadataCapability,
  createSafeFixPipeline,
  createReadOnlyRepository,
  discoverWorkspaceBoundaries,
  enumerateTrackedFilesFromGitChangedFileMetadata,
  enumerateRepositoryFilesForUntrackedProof,
  enumerateTrackedFiles,
  forceGitChangedFileMetadataFallback,
  loadImportGraph,
  reconcileGitChangedFileMetadata,
  selectRepositoryRoot,
  type ChangedFileScanScope,
  type DiscoveryCandidate,
  type GitChangedFileMetadata,
  type GitMetadataCapability,
  type GitMetadataExecutor,
  type ImportGraphResult,
  type ReadOnlyRepository,
  type ReadOnlyRepositoryIdentity,
  type RepositoryRootSelection,
  type SafeFixPreview,
} from "@agent-context/evidence";
import {
  formatSarifDiagnostics,
  formatStylishDiagnostics,
  writeJsonDiagnostics,
} from "@agent-context/formatters";
import { CLAUDE_CODE_PROFILE, cursorSurfaceProfile, copilotProfile } from "@agent-context/profiles";
import {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  TARGET_SAMPLER_DEFAULT_LIMITS,
  compareEffectiveContexts,
  createProfileGlobActivationCallbacks,
  evaluateActivationRule,
  activationFact,
  buildDocumentImportDag,
  buildNoImportDocumentDag,
  classifyTargetSourcePath,
  createSyntheticTargetTrace,
  resolveEffectiveContext,
  sampleTargets,
  type EffectiveContextProfileResolution,
  type EffectiveContextResolution,
  type ResolveEffectiveContextInput,
  type TargetActivationObservation,
} from "@agent-context/resolver";
import {
  CHANGED_FILE_MODE_CONTRACT_VERSION,
  CHANGED_FILE_MODE_INPUT_KIND,
  CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION,
  RULE_FAMILY_DESCRIPTORS,
  RULE_REGISTRY,
  RULE_SCHEDULER_CONTRACT_VERSION,
  RULE_SCHEDULER_RECORD_KIND,
  createChangedFileModeEvidenceAuthority,
  evaluateSyntaxStructureRules,
  finalizeSyntaxSuppressions,
  planApprovedMechanicalFixes,
  planChangedFileMode,
  scheduleRuleFamilies,
  type RuleFamilyId,
  type RuleFamilyRequest,
  type ChangedFileModeResult,
  type PortabilityFormatObservation,
  type RuleSchedulerFailureThreshold,
  type RuleSchedulerSeverity,
} from "@agent-context/rules";
import {
  createOfflineStandardsStatus,
  loadBundledKnowledgePack,
} from "@agent-context/standards/offline";
import {
  lexImportReferences,
  parseAgentsMarkdown,
  parseClaudeInstructionSyntax,
  parseCopilotInstructionSyntax,
  parseCursorRuleSyntax,
  parseGeminiContext,
  resolveAgentContextConfiguration,
  type FrontmatterDialect,
} from "@agent-context/syntax";

import packageManifest from "../package.json" with { type: "json" };
import { writeBoundedOutput } from "./bounded-output.js";
import { allResolutions, type CandidateBytes, type RepositoryContext } from "./i03-commands.js";
import type {
  CliAgentProfile,
  CliCommandContext,
  CliCommandHandler,
  CliCommandHandlers,
  CliSurfaceId,
} from "./command-router.js";
import { CLI_LIMITS } from "./command-router.js";

const surfaces = (...values: CliSurfaceId[]): readonly CliSurfaceId[] => Object.freeze(values);
const agentProfiles = (...values: CliAgentProfile[]): readonly CliAgentProfile[] =>
  Object.freeze(values);
const SCAN_CLI_VERSION = packageManifest.version;
const MAX_SCAN_ACTIVATION_EVALUATIONS = 1_000_000;
const PROFILE_SURFACES: Readonly<Record<CliAgentProfile, readonly CliSurfaceId[]>> = Object.freeze({
  "claude-code": surfaces("claude-code/local-session"),
  "codex-cli": surfaces("codex-cli/local-cli-single-cwd"),
  "copilot-cli": surfaces("copilot-cli/local-terminal"),
  "copilot-cloud-agent": surfaces("copilot-cloud-agent/github-hosted"),
  "copilot-code-review": surfaces("copilot-code-review/github-hosted"),
  "copilot-vscode": surfaces("copilot-vscode/local-chat"),
  "cursor-agent": surfaces("cursor-agent/cli", "cursor-agent/ide"),
  "gemini-cli": surfaces("gemini-cli/local-terminal"),
});

interface ScanOptions {
  readonly createGitMetadataExecutor?:
    | ((selection: RepositoryRootSelection, signal: AbortSignal) => Promise<GitMetadataExecutor>)
    | undefined;
  readonly environment: "ci" | "local";
  readonly now: () => string;
  readonly observeChangedFileMode?: ((result: ChangedFileModeResult) => void) | undefined;
  readonly observeActivationRules?:
    ((rules: InstructionIrSnapshot["activationRules"]) => void) | undefined;
  readonly observeEfficiencyReport?: ((report: ContextEfficiencyReport) => void) | undefined;
  readonly observeEfficiencyScenarios?:
    | ((
        metrics: ContextEfficiencyMetrics,
        scenarios: readonly EfficiencyRecommendationScenario[],
      ) => void)
    | undefined;
  readonly observeMetricProfiles?:
    ((profiles: readonly EfficiencyMetricProfileInput[]) => void) | undefined;
  readonly observePortabilityFormatObservations?:
    ((observations: readonly PortabilityFormatObservation[]) => void) | undefined;
  readonly observeParsed?: ((repository: ParsedRepository) => void) | undefined;
  readonly observeSampling?: ((sampling: ReturnType<typeof sampleTargets>) => void) | undefined;
  readonly reportError?: ((error: unknown) => void) | undefined;
  readonly workingDirectory: string;
}

interface ParsedRepository {
  readonly activationSpecs: readonly {
    readonly dialectIds: Readonly<Partial<Record<CliAgentProfile, string>>>;
    readonly documentId: InstructionDocumentId;
    readonly metadataState: "missing" | "present" | "unknown";
    readonly mode: "always" | "pattern" | "unknown";
    readonly patterns: readonly { readonly pattern: string; readonly range: SourceRange | null }[];
    readonly profileIds: readonly CliAgentProfile[];
    readonly scopeRoot: RepositoryRelativePath;
  }[];
  readonly documentAuthorities: ReadonlyMap<InstructionDocumentId, ScanAuthority>;
  readonly graphs: readonly {
    readonly authority: ScanAuthority;
    readonly graph: ImportGraphResult;
  }[];
  readonly importResolutions: readonly {
    readonly importId: string;
    readonly provenance: {
      readonly collectorId: string;
      readonly factId: string;
      readonly valueDigest: string;
    };
    readonly targetSourceId: string;
  }[];
  readonly importAuthorities: ReadonlyMap<string, ScanAuthority>;
  readonly importFormatIds: ReadonlyMap<string, string>;
  readonly ir: InstructionIrSnapshot;
  readonly policies: readonly {
    readonly dialect: FrontmatterDialect | null;
    readonly fields: readonly {
      readonly globSyntax: "none" | "path-glob-v1";
      readonly name: string;
      readonly types: readonly ("boolean" | "number" | "string" | "string-array")[];
    }[];
    readonly format: readonly [];
    readonly location: readonly [];
    readonly sourceId: string;
    readonly vendorId: string;
  }[];
  readonly sourceIdentities: readonly {
    readonly identity: ReadOnlyRepositoryIdentity;
    readonly path: RepositoryRelativePath;
  }[];
}

interface ScanAuthority {
  readonly profiles: readonly CliAgentProfile[];
  readonly surfaces: readonly CliSurfaceId[];
}

interface RepositoryReadLedger {
  readonly observations: Map<string, string>;
  unstable: boolean;
}

interface CandidateActivationSpec {
  readonly dialectIds: Readonly<Partial<Record<CliAgentProfile, string>>>;
  readonly metadataState: "missing" | "present" | "unknown";
  readonly mode: "always" | "pattern" | "unknown";
  readonly patterns: readonly {
    readonly pattern: string;
    readonly range: SourceRange | null;
  }[];
  readonly profileIds: readonly CliAgentProfile[];
  readonly scopeRoot: RepositoryRelativePath;
}

function syntaxRuleInput(parsed: ParsedRepository): {
  readonly contractVersion: "0.1.0";
  readonly documents: ParsedRepository["policies"];
  readonly ir: InstructionIrSnapshot;
  readonly recordKind: "agent-context-syntax-structure-rule-input";
} {
  return Object.freeze({
    contractVersion: "0.1.0",
    documents: parsed.policies,
    ir: parsed.ir,
    recordKind: "agent-context-syntax-structure-rule-input",
  });
}

function hasRecognition(candidate: DiscoveryCandidate, id: string): boolean {
  return candidate.recognitions.some((entry) => entry.recognizerId === id);
}

function directoryOf(value: RepositoryRelativePath): RepositoryRelativePath {
  const slash = value.lastIndexOf("/");
  return (slash < 0 ? "." : value.slice(0, slash)) as RepositoryRelativePath;
}

function syntaxPolicy(candidate: DiscoveryCandidate): {
  readonly dialect: FrontmatterDialect | null;
  readonly fields: readonly {
    readonly globSyntax: "none" | "path-glob-v1";
    readonly name: string;
    readonly types: readonly ("boolean" | "number" | "string" | "string-array")[];
  }[];
  readonly vendorId: string;
} {
  if (hasRecognition(candidate, "instruction.cursor-mdc"))
    return {
      dialect: "mdc",
      fields: [
        { globSyntax: "none", name: "alwaysApply", types: ["boolean"] },
        { globSyntax: "none", name: "description", types: ["string"] },
        { globSyntax: "path-glob-v1", name: "globs", types: ["string", "string-array"] },
      ],
      vendorId: "cursor",
    };
  if (hasRecognition(candidate, "instruction.claude-rules"))
    return {
      dialect: "yaml",
      fields: [{ globSyntax: "path-glob-v1", name: "paths", types: ["string-array"] }],
      vendorId: "claude-code",
    };
  if (hasRecognition(candidate, "instruction.copilot-path"))
    return {
      dialect: "yaml",
      fields: [
        { globSyntax: "path-glob-v1", name: "applyTo", types: ["string", "string-array"] },
        { globSyntax: "none", name: "description", types: ["string"] },
        { globSyntax: "none", name: "excludeAgent", types: ["string"] },
        { globSyntax: "none", name: "name", types: ["string"] },
      ],
      vendorId: "github-copilot",
    };
  return { dialect: null, fields: [], vendorId: "markdown" };
}

function importDialect(
  candidate: DiscoveryCandidate,
): "claude-code" | "copilot-cli" | "cursor-agent" | "gemini-cli" | null {
  if (candidate.recognitions.some((entry) => entry.recognizerId.startsWith("instruction.claude-")))
    return "claude-code";
  if (candidate.recognitions.some((entry) => entry.recognizerId.startsWith("instruction.copilot-")))
    return "copilot-cli";
  if (candidate.recognitions.some((entry) => entry.recognizerId.startsWith("instruction.cursor-")))
    return "cursor-agent";
  if (hasRecognition(candidate, "instruction.gemini-context")) return "gemini-cli";
  return null;
}

function candidateAuthority(candidate: DiscoveryCandidate): ScanAuthority {
  if (candidate.recognitions.some((entry) => entry.recognizerId.startsWith("instruction.claude-")))
    return Object.freeze({
      profiles: agentProfiles("claude-code"),
      surfaces: surfaces("claude-code/local-session"),
    });
  if (candidate.recognitions.some((entry) => entry.recognizerId.startsWith("instruction.copilot-")))
    return Object.freeze({
      profiles: agentProfiles(
        "copilot-cli",
        "copilot-cloud-agent",
        "copilot-code-review",
        "copilot-vscode",
      ),
      surfaces: surfaces(
        "copilot-cli/local-terminal",
        "copilot-cloud-agent/github-hosted",
        "copilot-code-review/github-hosted",
        "copilot-vscode/local-chat",
      ),
    });
  if (candidate.recognitions.some((entry) => entry.recognizerId.startsWith("instruction.cursor-")))
    return Object.freeze({
      profiles: agentProfiles("cursor-agent"),
      surfaces: surfaces("cursor-agent/cli", "cursor-agent/ide"),
    });
  if (hasRecognition(candidate, "instruction.gemini-context"))
    return Object.freeze({
      profiles: agentProfiles("gemini-cli"),
      surfaces: surfaces("gemini-cli/local-terminal"),
    });
  return Object.freeze({
    profiles: agentProfiles("codex-cli"),
    surfaces: surfaces("codex-cli/local-cli-single-cwd"),
  });
}

function importGraphAuthority(
  candidate: DiscoveryCandidate,
  dialect: Exclude<ReturnType<typeof importDialect>, null>,
): ScanAuthority {
  // Copilot's `@` import contract belongs to the CLI surface. Other Copilot surfaces may support
  // the containing instruction format, but their reference behavior is unsupported or unknown.
  if (dialect === "copilot-cli")
    return Object.freeze({
      profiles: agentProfiles("copilot-cli"),
      surfaces: surfaces("copilot-cli/local-terminal"),
    });
  return candidateAuthority(candidate);
}

function authorityApplies(
  authority: ScanAuthority,
  context: Pick<EffectiveContextResolution, "profileId" | "surfaceId">,
): boolean {
  return (
    authority.profiles.includes(context.profileId as CliAgentProfile) &&
    authority.surfaces.includes(context.surfaceId as CliSurfaceId)
  );
}

function filterParsedRepository(
  parsed: ParsedRepository,
  contexts: readonly Pick<EffectiveContextResolution, "profileId" | "surfaceId">[],
): ParsedRepository {
  const applies = (authority: ScanAuthority): boolean =>
    contexts.some((context) => authorityApplies(authority, context));
  const selectedDocumentIds = new Set<string>(
    parsed.ir.documents.flatMap((document) => {
      const authority = parsed.documentAuthorities.get(document.id);
      return authority !== undefined && applies(authority) ? [document.id] : [];
    }),
  );
  const selectedSourceIds = new Set<string>(
    parsed.ir.documents
      .filter((document) => selectedDocumentIds.has(document.id))
      .map((document) => document.sourceId),
  );
  const selectedImports = parsed.ir.imports.filter((reference) => {
    const authority = parsed.importAuthorities.get(reference.id);
    return (
      selectedDocumentIds.has(reference.documentId) && authority !== undefined && applies(authority)
    );
  });
  const selectedImportIds = new Set<string>(selectedImports.map((reference) => reference.id));
  const selectedDocuments = parsed.ir.documents
    .filter((document) => selectedDocumentIds.has(document.id))
    .map((document) =>
      Object.freeze({
        ...document,
        importIds: Object.freeze(document.importIds.filter((id) => selectedImportIds.has(id))),
      }),
    );
  const snapshot = createInstructionIrSnapshot({
    ...parsed.ir,
    activationRules: parsed.ir.activationRules.filter((rule) =>
      selectedDocumentIds.has(rule.documentId),
    ),
    documents: selectedDocuments,
    imports: selectedImports,
    nodes: parsed.ir.nodes.filter((node) => selectedSourceIds.has(node.sourceId)),
    sources: parsed.ir.sources.filter((source) => selectedSourceIds.has(source.id)),
    statements: parsed.ir.statements.filter((statement) =>
      selectedDocumentIds.has(statement.documentId),
    ),
  });
  if (!snapshot.ok)
    throw new Error(
      `authority-filtered repository IR is invalid: ${JSON.stringify(snapshot.issues)}`,
    );
  return Object.freeze({
    activationSpecs: Object.freeze(
      parsed.activationSpecs.filter((spec) => selectedDocumentIds.has(spec.documentId)),
    ),
    documentAuthorities: new Map(
      [...parsed.documentAuthorities].filter(([id]) => selectedDocumentIds.has(id)),
    ),
    graphs: Object.freeze(parsed.graphs.filter(({ authority }) => applies(authority))),
    importAuthorities: new Map(
      [...parsed.importAuthorities].filter(([id]) => selectedImportIds.has(id)),
    ),
    importFormatIds: new Map(
      [...parsed.importFormatIds].filter(([id]) => selectedImportIds.has(id)),
    ),
    importResolutions: Object.freeze(
      parsed.importResolutions.filter(
        (resolution) =>
          selectedImportIds.has(resolution.importId) &&
          selectedSourceIds.has(resolution.targetSourceId),
      ),
    ),
    ir: snapshot.value,
    policies: Object.freeze(
      parsed.policies.filter((policy) => selectedSourceIds.has(policy.sourceId)),
    ),
    sourceIdentities: Object.freeze(
      parsed.sourceIdentities.filter((entry) =>
        snapshot.value.sources.some((source) => source.path === entry.path),
      ),
    ),
  });
}

function portabilityFormatState(
  formatId: string,
  profileId: CliAgentProfile,
  surfaceId: CliSurfaceId,
): "conditional" | "recognized" | "supported" | "unknown" | "unsupported" {
  if (profileId === "codex-cli") return formatId === "agents-markdown" ? "supported" : "unknown";
  if (profileId === "claude-code")
    return CLAUDE_CODE_PROFILE.formatIds.includes(
      formatId as (typeof CLAUDE_CODE_PROFILE.formatIds)[number],
    )
      ? "supported"
      : "unknown";
  if (profileId === "gemini-cli")
    return formatId === "gemini-context-markdown" ? "supported" : "unknown";
  if (profileId === "cursor-agent")
    return (
      cursorSurfaceProfile(surfaceId)?.formats.find((entry) => entry.formatId === formatId)
        ?.support ?? "unknown"
    );
  const claim = copilotProfile(profileId)?.formats.find((entry) => entry.formatId === formatId);
  if (claim === undefined) return "unknown";
  if (claim.support === "not-listed") return "recognized";
  return claim.support;
}

function specializedImports(
  candidate: DiscoveryCandidate,
  bytes: Uint8Array,
  parsed: ReturnType<typeof parseAgentsMarkdown>,
): InstructionIr["imports"] {
  if (hasRecognition(candidate, "instruction.gemini-context"))
    return parseGeminiContext({
      bytes,
      contentStatus: "complete",
      path: candidate.path,
      scopeRoot: directoryOf(candidate.path),
    }).imports;
  if (candidate.recognitions.some((entry) => entry.recognizerId.startsWith("instruction.claude-")))
    return parseClaudeInstructionSyntax({
      bytes,
      documentId: parsed.document.id,
      format: hasRecognition(candidate, "instruction.claude-rules") ? "project-rule" : "memory",
      sourceId: parsed.source.id,
    }).imports;
  if (candidate.recognitions.some((entry) => entry.recognizerId.startsWith("instruction.copilot-")))
    return parseCopilotInstructionSyntax({
      bytes,
      documentId: parsed.document.id,
      format: hasRecognition(candidate, "instruction.copilot-path")
        ? "path-specific"
        : "repository-wide",
      sourceId: parsed.source.id,
    }).imports;
  if (candidate.recognitions.some((entry) => entry.recognizerId.startsWith("instruction.cursor-")))
    return parseCursorRuleSyntax({
      bytes,
      documentId: parsed.document.id,
      format: hasRecognition(candidate, "instruction.cursor-mdc") ? "mdc" : "legacy",
      path: candidate.path,
      sourceId: parsed.source.id,
    }).references;
  const dialect = importDialect(candidate);
  return dialect === null
    ? Object.freeze([])
    : lexImportReferences({
        documentId: parsed.document.id,
        sourceId: parsed.source.id,
        syntax: dialect,
        text: parsed.source.text,
      }).imports;
}

function candidateActivationSpec(
  candidate: DiscoveryCandidate,
  bytes: Uint8Array,
  parsed: ReturnType<typeof parseAgentsMarkdown>,
): CandidateActivationSpec | null {
  if (hasRecognition(candidate, "instruction.cursor-mdc")) {
    const syntax = parseCursorRuleSyntax({
      bytes,
      documentId: parsed.document.id,
      format: "mdc",
      path: candidate.path,
      sourceId: parsed.source.id,
    });
    return Object.freeze({
      dialectIds: Object.freeze({ "cursor-agent": "cursor-agent/mdc-globs/2026-08-01" }),
      metadataState:
        syntax.globs.state === "valid"
          ? "present"
          : syntax.globs.state === "absent"
            ? "missing"
            : "unknown",
      mode:
        syntax.modeSyntax.classification === "always" && syntax.modeSyntax.state === "known-syntax"
          ? "always"
          : syntax.globs.state === "valid" && (syntax.globs.value?.patterns.length ?? 0) > 0
            ? "pattern"
            : "unknown",
      patterns: Object.freeze(
        (syntax.globs.value?.patterns ?? []).map((entry) =>
          Object.freeze({ pattern: entry.value, range: entry.range }),
        ),
      ),
      profileIds: agentProfiles("cursor-agent"),
      scopeRoot: syntax.location.scopeRoot ?? directoryOf(candidate.path),
    });
  }
  if (hasRecognition(candidate, "instruction.copilot-path")) {
    const syntax = parseCopilotInstructionSyntax({
      bytes,
      documentId: parsed.document.id,
      format: "path-specific",
      sourceId: parsed.source.id,
    });
    const dialects: Readonly<Partial<Record<CliAgentProfile, string>>> = Object.freeze({
      "copilot-cli": "copilot-cli/apply-to/2026-08-01",
      "copilot-cloud-agent": "copilot-cloud-agent/apply-to/2026-08-01",
      "copilot-code-review": "copilot-code-review/apply-to/2026-08-01",
      "copilot-vscode": "copilot-vscode/apply-to/2026-08-01",
    });
    return Object.freeze({
      dialectIds: dialects,
      metadataState:
        syntax.applyTo.state === "valid"
          ? "present"
          : syntax.applyTo.state === "absent"
            ? "missing"
            : "unknown",
      mode: syntax.applyTo.state === "valid" ? "pattern" : "unknown",
      patterns: Object.freeze(
        (syntax.applyTo.value ?? []).map((pattern) =>
          Object.freeze({ pattern, range: syntax.applyTo.range }),
        ),
      ),
      profileIds: agentProfiles(
        "copilot-cli",
        "copilot-cloud-agent",
        "copilot-code-review",
        "copilot-vscode",
      ),
      scopeRoot: "." as RepositoryRelativePath,
    });
  }
  if (hasRecognition(candidate, "instruction.claude-rules")) {
    const syntax = parseClaudeInstructionSyntax({
      bytes,
      documentId: parsed.document.id,
      format: "project-rule",
      sourceId: parsed.source.id,
    });
    return Object.freeze({
      dialectIds: Object.freeze({ "claude-code": "claude-code/rules-paths/2026-08-01" }),
      metadataState:
        syntax.paths.state === "valid"
          ? "present"
          : syntax.paths.state === "absent"
            ? "missing"
            : "unknown",
      mode:
        syntax.paths.state === "absent"
          ? "always"
          : syntax.paths.state === "valid"
            ? "pattern"
            : "unknown",
      patterns: Object.freeze(
        (syntax.paths.value ?? []).map((pattern) =>
          Object.freeze({ pattern, range: syntax.paths.range }),
        ),
      ),
      profileIds: agentProfiles("claude-code"),
      scopeRoot: "." as RepositoryRelativePath,
    });
  }
  return null;
}

function remapParsedDocument(
  parsed: ReturnType<typeof parseAgentsMarkdown>,
  graphNode: ImportGraphResult["nodes"][number],
  formatId: string,
  syntax: Exclude<ReturnType<typeof importDialect>, null>,
): {
  readonly document: InstructionIr["documents"][number];
  readonly imports: InstructionIr["imports"];
  readonly nodes: InstructionIr["nodes"];
  readonly source: InstructionIr["sources"][number];
  readonly statements: InstructionIr["statements"];
} {
  const graphSyntax = lexImportReferences({
    documentId: graphNode.documentId,
    sourceId: graphNode.sourceId,
    syntax,
    text: parsed.source.text,
  });
  if (graphSyntax.markdown.nodes.length !== parsed.nodes.length)
    throw new Error("graph syntax and parsed document nodes differ");
  const parsedNodeIds = new Map(
    parsed.nodes.map((node, index) => {
      const syntaxNode = graphSyntax.markdown.nodes[index];
      if (syntaxNode === undefined) throw new Error("graph syntax node is unavailable");
      return [syntaxNode.id, node.id] as const;
    }),
  );
  const mappedNodeId = (id: AstNodeId): AstNodeId => {
    const mapped = parsedNodeIds.get(id);
    if (mapped === undefined) throw new Error("parsed node relationship is unavailable");
    return mapped;
  };
  const statements = parsed.statements.map((statement) => {
    const statementId = `statement:${createHash("sha256")
      .update(graphNode.documentId, "utf8")
      .update("\0", "utf8")
      .update(statement.id, "utf8")
      .digest("hex")}` as typeof statement.id;
    return Object.freeze({
      ...statement,
      documentId: graphNode.documentId,
      id: statementId,
    });
  });
  const imports = graphNode.imports.map((item) =>
    Object.freeze({
      ...item,
      documentId: graphNode.documentId,
      nodeId: mappedNodeId(item.nodeId),
      range: Object.freeze({ ...item.range, sourceId: parsed.source.id }),
      specifierRange: Object.freeze({ ...item.specifierRange, sourceId: parsed.source.id }),
    }),
  );
  return Object.freeze({
    document: Object.freeze({
      ...parsed.document,
      formatId,
      id: graphNode.documentId,
      importIds: Object.freeze(imports.map((entry) => entry.id)),
      statementIds: Object.freeze(statements.map((statement) => statement.id)),
    }),
    imports: Object.freeze(imports),
    nodes: parsed.nodes,
    source: parsed.source,
    statements: Object.freeze(statements),
  });
}

async function parseRepository(
  candidates: readonly CandidateBytes[],
  repository: ReadOnlyRepository,
  limits: Pick<AgentContextConfiguration["limits"], "maxImportDepth" | "maxImportFanOut">,
  signal: AbortSignal,
): Promise<ParsedRepository> {
  const sources: InstructionIr["sources"][number][] = [];
  const documents: InstructionIr["documents"][number][] = [];
  const nodes: InstructionIr["nodes"][number][] = [];
  const statements: InstructionIr["statements"][number][] = [];
  const imports: InstructionIr["imports"][number][] = [];
  const policies: ParsedRepository["policies"][number][] = [];
  const graphs: ParsedRepository["graphs"][number][] = [];
  const documentAuthorities = new Map<InstructionDocumentId, ScanAuthority>();
  const activationSpecs: ParsedRepository["activationSpecs"][number][] = [];
  const sourceIdentities: ParsedRepository["sourceIdentities"][number][] = [];
  const importResolutions: ParsedRepository["importResolutions"][number][] = [];
  const importAuthorities = new Map<string, ScanAuthority>();
  const importFormatIds = new Map<string, string>();
  const seenDocumentIds = new Set<InstructionDocumentId>();
  const seenImportResolutions = new Set<string>();
  const seenSourcePaths = new Set<RepositoryRelativePath>();
  const physicalFiles = new Map(
    candidates.map(
      ({ bytes, candidate, identity }) =>
        [candidate.path, Object.freeze({ bytes: (): Uint8Array => bytes, identity })] as const,
    ),
  );
  const ordered = [...candidates].sort((left, right) => {
    const leftImport = importDialect(left.candidate) === null ? 1 : 0;
    const rightImport = importDialect(right.candidate) === null ? 1 : 0;
    return (
      leftImport - rightImport ||
      compareRepositoryRelativePaths(left.candidate.path, right.candidate.path)
    );
  });
  const setPolicy = (policy: ParsedRepository["policies"][number], prefer: boolean): void => {
    const index = policies.findIndex((entry) => entry.sourceId === policy.sourceId);
    if (index === -1) policies.push(policy);
    else if (prefer) policies[index] = policy;
  };
  for (const { bytes, candidate, identity } of ordered) {
    const parsed = parseAgentsMarkdown({
      bytes,
      contentStatus: "complete",
      path: candidate.path,
      scopeRoot: directoryOf(candidate.path),
    });
    // Always invoke the vendor adapter for its closed syntax validation. C10 remains authoritative
    // for the recursively loaded occurrence graph when this format supports imports.
    const discoveredImports = specializedImports(candidate, bytes, parsed);
    const activationSpec = candidateActivationSpec(candidate, bytes, parsed);
    const formatId = candidate.recognitions.find((entry) => entry.kind === "instruction")?.formatId;
    const dialect = importDialect(candidate);
    const authority = candidateAuthority(candidate);
    if (dialect !== null) {
      if (signal.aborted) throw new DOMException("scan cancelled", "AbortError");
      const graph = await loadImportGraph(
        {
          entryPath: candidate.path,
          repository,
          syntax: dialect,
        },
        {
          maxDepth: limits.maxImportDepth,
          maxFanOut: limits.maxImportFanOut,
        },
      );
      {
        const graphAuthority = importGraphAuthority(candidate, dialect);
        const canonicalImports = new Map<string, InstructionIr["imports"][number]>();
        const canonicalSourceByDocument = new Map<
          InstructionDocumentId,
          InstructionIr["sources"][number]["id"]
        >();
        const canonicalSourceByPath = new Map<
          RepositoryRelativePath,
          InstructionIr["sources"][number]["id"]
        >();
        for (const graphNode of graph.nodes) {
          if (seenDocumentIds.has(graphNode.documentId)) continue;
          const file =
            physicalFiles.get(graphNode.path) ?? (await repository.readFile(graphNode.path));
          physicalFiles.set(graphNode.path, file);
          const generic = parseAgentsMarkdown({
            bytes: file.bytes(),
            contentStatus: "complete",
            path: graphNode.path,
            scopeRoot: directoryOf(graphNode.path),
          });
          const remapped = remapParsedDocument(
            generic,
            graphNode,
            graphNode.path === candidate.path
              ? (formatId ?? generic.document.formatId)
              : `${dialect}-import`,
            dialect,
          );
          const graphPolicy = syntaxPolicy(candidate);
          if (!seenSourcePaths.has(graphNode.path)) {
            sources.push(remapped.source);
            nodes.push(...remapped.nodes);
            sourceIdentities.push(Object.freeze({ identity: file.identity, path: graphNode.path }));
            seenSourcePaths.add(graphNode.path);
          }
          documents.push(remapped.document);
          statements.push(...remapped.statements);
          imports.push(...remapped.imports);
          for (const item of remapped.imports) {
            canonicalImports.set(item.id, item);
            importAuthorities.set(item.id, graphAuthority);
            importFormatIds.set(item.id, formatId ?? generic.document.formatId);
          }
          canonicalSourceByDocument.set(graphNode.documentId, remapped.source.id);
          canonicalSourceByPath.set(graphNode.path, remapped.source.id);
          setPolicy(
            {
              dialect: graphNode.path === candidate.path ? graphPolicy.dialect : null,
              fields:
                graphNode.path === candidate.path
                  ? Object.freeze(
                      graphPolicy.fields.map((entry) =>
                        Object.freeze({ ...entry, types: Object.freeze(entry.types) }),
                      ),
                    )
                  : Object.freeze([]),
              format: Object.freeze([]),
              location: Object.freeze([]),
              sourceId: remapped.source.id,
              vendorId: graphNode.path === candidate.path ? graphPolicy.vendorId : dialect,
            },
            graphNode.path === candidate.path,
          );
          if (graphNode.path === candidate.path && activationSpec !== null)
            activationSpecs.push(
              Object.freeze({
                ...activationSpec,
                documentId: graphNode.documentId,
                patterns: Object.freeze(
                  activationSpec.patterns.map((pattern) =>
                    Object.freeze({
                      ...pattern,
                      range:
                        pattern.range === null
                          ? null
                          : Object.freeze({ ...pattern.range, sourceId: remapped.source.id }),
                    }),
                  ),
                ),
              }),
            );
          seenDocumentIds.add(graphNode.documentId);
          documentAuthorities.set(
            graphNode.documentId,
            graphNode.path === candidate.path ? authority : graphAuthority,
          );
        }
        const canonicalGraph: ImportGraphResult = Object.freeze({
          ...graph,
          edges: Object.freeze(
            graph.edges.map((edge) =>
              Object.freeze({
                ...edge,
                import: canonicalImports.get(edge.import.id) ?? edge.import,
              }),
            ),
          ),
          issues: Object.freeze(
            graph.issues.map((issue) => {
              const sourceId = canonicalSourceByPath.get(issue.path);
              return sourceId === undefined || issue.range === null
                ? issue
                : Object.freeze({
                    ...issue,
                    range: Object.freeze({ ...issue.range, sourceId }),
                  });
            }),
          ),
          nodes: Object.freeze(
            graph.nodes.map((node) =>
              Object.freeze({
                ...node,
                imports: Object.freeze(
                  node.imports.map((item) => canonicalImports.get(item.id) ?? item),
                ),
                sourceId: canonicalSourceByDocument.get(node.documentId) ?? node.sourceId,
              }),
            ),
          ),
        });
        graphs.push(Object.freeze({ authority: graphAuthority, graph: canonicalGraph }));
        const sourceByDocument = new Map(documents.map((entry) => [entry.id, entry.sourceId]));
        const digestBySource = new Map(sources.map((entry) => [entry.id, entry.sha256]));
        for (const edge of graph.edges) {
          if (edge.targetDocumentId === null) continue;
          if (seenImportResolutions.has(edge.import.id)) continue;
          const targetSourceId = sourceByDocument.get(edge.targetDocumentId);
          const valueDigest =
            targetSourceId === undefined ? undefined : digestBySource.get(targetSourceId);
          if (targetSourceId === undefined || valueDigest === undefined) continue;
          importResolutions.push(
            Object.freeze({
              importId: edge.import.id,
              provenance: Object.freeze({
                collectorId: "c10.import-graph",
                factId: edge.import.id,
                valueDigest,
              }),
              targetSourceId,
            }),
          );
          seenImportResolutions.add(edge.import.id);
        }
        continue;
      }
    }
    const document: InstructionDocument = Object.freeze({
      ...parsed.document,
      formatId: formatId ?? parsed.document.formatId,
      importIds: Object.freeze(discoveredImports.map((entry) => entry.id)),
    });
    const policy = syntaxPolicy(candidate);
    if (seenDocumentIds.has(document.id)) continue;
    if (!seenSourcePaths.has(candidate.path)) {
      sources.push(parsed.source);
      nodes.push(...parsed.nodes);
      sourceIdentities.push(Object.freeze({ identity, path: candidate.path }));
      seenSourcePaths.add(candidate.path);
    }
    documents.push(document);
    statements.push(...parsed.statements);
    imports.push(...discoveredImports);
    setPolicy(
      {
        dialect: policy.dialect,
        fields: Object.freeze(
          policy.fields.map((entry) =>
            Object.freeze({ ...entry, types: Object.freeze(entry.types) }),
          ),
        ),
        format: Object.freeze([]),
        location: Object.freeze([]),
        sourceId: parsed.source.id,
        vendorId: policy.vendorId,
      },
      true,
    );
    if (activationSpec !== null)
      activationSpecs.push(Object.freeze({ ...activationSpec, documentId: document.id }));
    seenDocumentIds.add(document.id);
    documentAuthorities.set(document.id, authority);
  }
  const snapshot = createInstructionIrSnapshot({
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents,
    events: [],
    imports,
    nodes,
    recordKind: "agent-context-instruction-ir",
    sources,
    statements,
    targets: [],
  });
  if (!snapshot.ok)
    throw new Error(`parsed repository IR is invalid: ${JSON.stringify(snapshot.issues)}`);
  return Object.freeze({
    activationSpecs: Object.freeze(activationSpecs),
    documentAuthorities,
    graphs: Object.freeze(graphs),
    importResolutions: Object.freeze(importResolutions),
    importAuthorities,
    importFormatIds,
    ir: snapshot.value,
    policies: Object.freeze(policies),
    sourceIdentities: Object.freeze(sourceIdentities),
  });
}

function enabledProfiles(
  configuration: AgentContextConfiguration,
  command: CliCommandContext,
): readonly CliAgentProfile[] {
  const selected =
    command.profiles.length === 0
      ? (Object.keys(PROFILE_SURFACES) as CliAgentProfile[])
      : [...command.profiles];
  const surfaceOwners =
    command.surfaces.length === 0
      ? null
      : new Set(
          command.surfaces.map(
            (surface) =>
              Object.entries(PROFILE_SURFACES).find(([, values]) => values.includes(surface))?.[0],
          ),
        );
  return Object.freeze(
    selected.filter(
      (profile) =>
        configuration.profiles[profile].enabled &&
        (surfaceOwners === null || surfaceOwners.has(profile)),
    ),
  );
}

function includedRepository(
  repository: ReadOnlyRepository,
  includedPaths: readonly RepositoryRelativePath[],
): ReadOnlyRepository {
  const included = new Set(includedPaths);
  return Object.freeze({
    inspect: (relativePath: unknown) => repository.inspect(relativePath),
    limits: repository.limits,
    readDirectory: (relativePath: unknown) => repository.readDirectory(relativePath),
    readFile: async (relativePath: unknown) => {
      if (typeof relativePath !== "string" || !included.has(relativePath as RepositoryRelativePath))
        throw new Error("path is outside the C04 included universe");
      return repository.readFile(relativePath);
    },
    root: repository.root,
    usage: () => repository.usage(),
  });
}

function repositoryEntrySignature(
  operation: "inspect" | "read-directory" | "read-file",
  entry: Awaited<ReturnType<ReadOnlyRepository["inspect"]>>,
  bytes?: Uint8Array,
  entries?: readonly RepositoryRelativePath[],
): string {
  const digest = createHash("sha256");
  digest.update(`agent-context-repository-read-v1\0${operation}\0${entry.path}\0`);
  digest.update(
    `${entry.type}\0${entry.identity.device}\0${entry.identity.inode}\0${String(entry.linkDepth)}\0${String(entry.size)}\0`,
  );
  if (bytes !== undefined) digest.update(bytes);
  if (entries !== undefined)
    for (const child of entries) digest.update(Buffer.from(`${child}\0`, "utf8"));
  return digest.digest("hex");
}

function recordRepositoryRead(ledger: RepositoryReadLedger, key: string, signature: string): void {
  const previous = ledger.observations.get(key);
  if (previous !== undefined && previous !== signature) ledger.unstable = true;
  else ledger.observations.set(key, signature);
}

function recordingRepository(repository: ReadOnlyRepository): {
  readonly ledger: RepositoryReadLedger;
  readonly repository: ReadOnlyRepository;
} {
  const ledger: RepositoryReadLedger = { observations: new Map(), unstable: false };
  const wrapped: ReadOnlyRepository = Object.freeze({
    inspect: async (relativePath: unknown) => {
      const entry = await repository.inspect(relativePath);
      recordRepositoryRead(
        ledger,
        `inspect\0${entry.path}`,
        repositoryEntrySignature("inspect", entry),
      );
      return entry;
    },
    limits: repository.limits,
    readDirectory: async (relativePath: unknown) => {
      const directory = await repository.readDirectory(relativePath);
      recordRepositoryRead(
        ledger,
        `read-directory\0${directory.path}`,
        repositoryEntrySignature("read-directory", directory, undefined, directory.entries),
      );
      return directory;
    },
    readFile: async (relativePath: unknown) => {
      const file = await repository.readFile(relativePath);
      const bytes = file.bytes();
      recordRepositoryRead(
        ledger,
        `read-file\0${file.path}`,
        repositoryEntrySignature("read-file", file, bytes),
      );
      return file;
    },
    root: repository.root,
    usage: () => repository.usage(),
  });
  return Object.freeze({ ledger, repository: wrapped });
}

async function repositoryReadsStillMatch(
  ledger: RepositoryReadLedger,
  repository: ReadOnlyRepository,
): Promise<boolean> {
  if (ledger.unstable) return false;
  try {
    for (const [key, expected] of ledger.observations) {
      const separator = key.indexOf("\0");
      const operation = key.slice(0, separator);
      const relativePath = key.slice(separator + 1);
      let observed: string;
      if (operation === "inspect") {
        const entry = await repository.inspect(relativePath);
        observed = repositoryEntrySignature("inspect", entry);
      } else if (operation === "read-directory") {
        const directory = await repository.readDirectory(relativePath);
        observed = repositoryEntrySignature(
          "read-directory",
          directory,
          undefined,
          directory.entries,
        );
      } else if (operation === "read-file") {
        const file = await repository.readFile(relativePath);
        observed = repositoryEntrySignature("read-file", file, file.bytes());
      } else return false;
      if (observed !== expected) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function configurationFingerprint(
  resolution: Awaited<ReturnType<typeof resolveAgentContextConfiguration>>,
): string {
  return createHash("sha256").update(JSON.stringify(resolution)).digest("hex");
}

function inventoryIsComplete(result: {
  readonly omittedProblems: number;
  readonly problems: readonly { readonly code: string }[];
}): boolean {
  return (
    result.omittedProblems === 0 &&
    result.problems.every((problem) => problem.code === "BUILT_IN_DIRECTORY_PRUNED")
  );
}

function selectedSurfaces(
  profile: CliAgentProfile,
  configuration: AgentContextConfiguration,
  command: CliCommandContext,
): readonly CliSurfaceId[] {
  return PROFILE_SURFACES[profile].filter(
    (surface) =>
      configuration.profiles[profile].surfaces[surface] !== false &&
      (command.surfaces.length === 0 || command.surfaces.includes(surface)),
  );
}

function flattenResolutions(
  value: Awaited<ReturnType<typeof allResolutions>>,
  profiles: readonly CliAgentProfile[],
  configuration: AgentContextConfiguration,
  command: CliCommandContext,
): readonly EffectiveContextProfileResolution[] {
  const selected = new Set(profiles);
  const output: EffectiveContextProfileResolution[] = [];
  if (selected.has("claude-code")) output.push(...value.claudeCode);
  if (selected.has("codex-cli")) output.push(...value.codexCli);
  output.push(
    ...value.copilot.filter((entry) => selected.has(entry.profile.profileId as CliAgentProfile)),
  );
  output.push(
    ...value.cursor.filter(
      (entry) =>
        selected.has("cursor-agent") &&
        selectedSurfaces("cursor-agent", configuration, command).includes(
          entry.profile.surfaceId as CliSurfaceId,
        ),
    ),
  );
  if (selected.has("gemini-cli")) output.push(...value.geminiCli.map((entry) => entry.resolution));
  return Object.freeze(
    output.filter((entry) =>
      selectedSurfaces(entry.profile.profileId as CliAgentProfile, configuration, command).includes(
        entry.profile.surfaceId as CliSurfaceId,
      ),
    ),
  );
}

export function aggregateProfileVersions(
  contexts: readonly Pick<
    EffectiveContextResolution,
    "clientVersion" | "profileId" | "profileVersion"
  >[],
  usedProfiles: ReadonlySet<string>,
): Readonly<Record<string, ProfileVersionIdentity>> {
  const output: Record<string, ProfileVersionIdentity> = Object.create(null) as Record<
    string,
    ProfileVersionIdentity
  >;
  const grouped = new Map<
    string,
    Pick<EffectiveContextResolution, "clientVersion" | "profileId" | "profileVersion">[]
  >();
  for (const context of contexts) {
    if (usedProfiles.size > 0 && !usedProfiles.has(context.profileId)) continue;
    const group = grouped.get(context.profileId) ?? [];
    group.push(context);
    grouped.set(context.profileId, group);
  }
  for (const [profileId, group] of grouped) {
    const profileVersionValues = new Set(group.map((entry) => entry.profileVersion));
    if (profileVersionValues.size !== 1)
      throw new Error(`selected surfaces disagree on the ${profileId} profile contract version`);
    const profileVersion = group[0]?.profileVersion;
    if (profileVersion === undefined)
      throw new Error("profile version group is unexpectedly empty");
    const clientVersions = new Set(group.map((entry) => entry.clientVersion));
    output[profileId] = Object.freeze({
      clientVersion: clientVersions.size === 1 ? (group[0]?.clientVersion ?? null) : null,
      profileVersion,
    });
  }
  return Object.freeze(output);
}

function attachActivationRules(
  parsed: ParsedRepository,
  contexts: readonly EffectiveContextResolution[],
): ParsedRepository {
  const rules: ActivationRule[] = [];
  const rulesByDocument = new Map<string, string[]>();
  const identities = [
    ...new Map(contexts.map((entry) => [`${entry.profileId}\0${entry.surfaceId}`, entry])).values(),
  ];
  for (const [specIndex, spec] of parsed.activationSpecs.entries()) {
    const document = parsed.ir.documents.find((entry) => entry.id === spec.documentId);
    if (document === undefined) throw new Error("activation document is unavailable");
    for (const context of identities) {
      const profileId = context.profileId as CliAgentProfile;
      if (!spec.profileIds.includes(profileId)) continue;
      const dialectId = spec.dialectIds[profileId] ?? null;
      const id = `activation:scan:${specIndex.toString(36)}:${context.profileId}:${context.surfaceId}`;
      const uncertainty =
        spec.mode !== "unknown"
          ? ({ state: "known" } as const)
          : ({
              reason: "Path-specific activation metadata is missing or could not be interpreted.",
              state: "unknown",
            } as const);
      rules.push(
        Object.freeze({
          conditions: Object.freeze([]),
          documentId: spec.documentId,
          evidenceRefs: Object.freeze([
            Object.freeze({
              factId: `syntax-activation:${specIndex.toString(36)}`,
              sourceId: document.sourceId,
            }),
          ]),
          exclude: Object.freeze([]),
          id: id as ActivationRuleId,
          include: Object.freeze(
            spec.patterns.map((entry) =>
              Object.freeze({
                dialectId,
                kind: "glob" as const,
                pattern: entry.pattern,
                sourceRange: entry.range,
                uncertainty: { state: "known" as const },
              }),
            ),
          ),
          kind:
            spec.mode === "always"
              ? ("always" as const)
              : spec.mode === "pattern"
                ? ("glob" as const)
                : ("unknown" as const),
          profileId: context.profileId,
          scopeRoot: spec.scopeRoot,
          specSnapshotId: context.specSnapshotId,
          surfaceId: context.surfaceId,
          uncertainty,
          unknownReason: uncertainty.state === "known" ? null : uncertainty.reason,
        }),
      );
      const documentRules = rulesByDocument.get(spec.documentId) ?? [];
      documentRules.push(id);
      rulesByDocument.set(spec.documentId, documentRules);
    }
  }
  if (rules.length === 0) return parsed;
  const snapshot = createInstructionIrSnapshot({
    ...parsed.ir,
    activationRules: rules,
    documents: parsed.ir.documents.map((document) =>
      Object.freeze({
        ...document,
        activationRuleIds: Object.freeze(
          (rulesByDocument.get(document.id) ?? []).map((id) => id as ActivationRuleId),
        ),
      }),
    ),
  });
  if (!snapshot.ok)
    throw new Error(
      `activation-enriched repository IR is invalid: ${JSON.stringify(snapshot.issues)}`,
    );
  return Object.freeze({ ...parsed, ir: snapshot.value });
}

function activationResultsForPaths(
  parsed: ParsedRepository,
  paths: readonly RepositoryRelativePath[],
): readonly {
  readonly path: RepositoryRelativePath;
  readonly results: readonly {
    readonly result: ReturnType<typeof activationFact>;
    readonly ruleId: string;
  }[];
  readonly targetKind: "source";
}[] {
  const callbacks = createProfileGlobActivationCallbacks();
  return Object.freeze(
    paths.map((path) => ({
      path,
      results: Object.freeze(
        parsed.ir.activationRules.map((rule) => ({
          result:
            rule.kind === "unknown"
              ? activationFact(
                  "indeterminate",
                  `scan:${rule.id}:${path}`,
                  rule.unknownReason ?? "Activation is unknown.",
                )
              : evaluateActivationRule(rule, { callbacks, targetPath: path }),
          ruleId: rule.id,
        })),
      ),
      targetKind: "source" as const,
    })),
  );
}

function samplingActivationObservations(
  observations: ReturnType<typeof activationResultsForPaths>,
): readonly TargetActivationObservation[] {
  return Object.freeze(
    observations.map((observation) =>
      Object.freeze({
        path: observation.path,
        states: Object.freeze(
          observation.results.map((entry) => ({
            ruleId: entry.ruleId,
            state: entry.result.state,
          })),
        ),
      }),
    ),
  );
}

function activationEvidence(
  parsed: ParsedRepository,
  contexts: readonly EffectiveContextResolution[],
  sampling: ReturnType<typeof sampleTargets>,
  workspaceBoundaries: readonly { readonly root: RepositoryRelativePath }[],
  activationResults: ReturnType<typeof activationResultsForPaths>,
): {
  readonly activationResults: readonly {
    readonly path: RepositoryRelativePath;
    readonly results: readonly {
      readonly result: ReturnType<typeof activationFact>;
      readonly ruleId: string;
    }[];
    readonly targetKind: "source";
  }[];
  readonly facts: readonly {
    readonly comparisonGroup: string | null;
    readonly factId: string;
    readonly nestingState: "known" | "unknown";
    readonly reachabilityState: "conditional" | "reachable" | "unknown" | "unreachable";
    readonly ruleId: string;
    readonly scopeMetadataState: "missing" | "present" | "unknown";
    readonly shadowedByRuleIds: readonly string[];
  }[];
} {
  const specByDocument = new Map(parsed.activationSpecs.map((entry) => [entry.documentId, entry]));
  const contextIdentities = new Set(
    contexts.map((entry) => `${entry.profileId}\0${entry.surfaceId}`),
  );
  const activeRules = parsed.ir.activationRules.filter((rule) =>
    contextIdentities.has(`${rule.profileId}\0${rule.surfaceId}`),
  );
  const facts = activeRules.map((rule) => {
    const spec = specByDocument.get(rule.documentId);
    const source = parsed.ir.sources.find(
      (entry) =>
        entry.id ===
        parsed.ir.documents.find((document) => document.id === rule.documentId)?.sourceId,
    );
    const relevant = contexts
      .filter((entry) => entry.profileId === rule.profileId && entry.surfaceId === rule.surfaceId)
      .flatMap((entry) => entry.documents.filter((document) => document.path === source?.path));
    const states = new Set(relevant.map((entry) => entry.state));
    const reachabilityState =
      relevant.length === 0 || states.has("unavailable")
        ? ("unknown" as const)
        : states.has("conditional") ||
            (states.has("effective") &&
              (states.has("inactive") || states.has("shadowed") || states.has("empty")))
          ? ("conditional" as const)
          : states.has("effective") || states.has("empty")
            ? ("reachable" as const)
            : states.size === 1 && states.has("inactive") && sampling.strategy === "exhaustive"
              ? ("unreachable" as const)
              : ("unknown" as const);
    const scopeProven =
      spec?.scopeRoot === "." ||
      workspaceBoundaries.some((boundary) => boundary.root === spec?.scopeRoot);
    return Object.freeze({
      comparisonGroup: `document:${rule.documentId}`,
      factId: `resolution:${rule.id}`,
      nestingState: scopeProven ? ("known" as const) : ("unknown" as const),
      reachabilityState,
      ruleId: rule.id,
      scopeMetadataState: spec?.metadataState ?? ("unknown" as const),
      shadowedByRuleIds: Object.freeze([]),
    });
  });
  return Object.freeze({
    activationResults: Object.freeze(activationResults),
    facts: Object.freeze(facts),
  });
}

function selectedFamilies(command: CliCommandContext): ReadonlySet<RuleFamilyId> {
  if (command.rules.length === 0)
    return new Set(RULE_FAMILY_DESCRIPTORS.map((entry) => entry.familyId));
  const selected = new Set<RuleFamilyId>(["syntax-structure"]);
  for (const descriptor of RULE_FAMILY_DESCRIPTORS)
    if (descriptor.ruleIds.some((ruleId) => command.rules.includes(ruleId)))
      selected.add(descriptor.familyId);
  return selected;
}

function policy(
  command: CliCommandContext,
  configuration: AgentContextConfiguration,
): {
  readonly failureThreshold: RuleSchedulerFailureThreshold;
  readonly severityOverrides: Readonly<Record<string, RuleSchedulerSeverity>>;
} {
  const overrides: Record<string, RuleSchedulerSeverity> = Object.create(null) as Record<
    string,
    RuleSchedulerSeverity
  >;
  const knownRuleIds: ReadonlySet<string> = new Set(RULE_REGISTRY.rules.map((entry) => entry.id));
  for (const [ruleId, setting] of Object.entries(configuration.rules))
    if (knownRuleIds.has(ruleId)) overrides[ruleId] = setting.severity;
  if (command.rules.length > 0)
    for (const rule of RULE_REGISTRY.rules)
      if (!command.rules.includes(rule.id)) overrides[rule.id] = "off";
  for (const entry of command.severityOverrides) overrides[entry.ruleId] = entry.severity;
  if (
    configuration.security.allowAbsolutePaths &&
    configuration.rules["ACL153"] === undefined &&
    !command.severityOverrides.some((entry) => entry.ruleId === "ACL153")
  )
    overrides["ACL153"] = "off";
  if (
    configuration.security.allowNetworkReferences &&
    configuration.rules["ACL154"] === undefined &&
    !command.severityOverrides.some((entry) => entry.ruleId === "ACL154")
  )
    overrides["ACL154"] = "off";
  if (!configuration.standards.requireCurrentInCI) overrides["ACL505"] = "off";
  return Object.freeze({
    failureThreshold: command.failureThreshold ?? "error",
    severityOverrides: Object.freeze(overrides),
  });
}

export async function writeBoundedScanOutput(
  writeStdout: (text: string) => Promise<void>,
  output: string,
): Promise<void> {
  await writeBoundedOutput(output, writeStdout);
}

interface ChangedScanState {
  readonly capability: GitMetadataCapability;
  readonly metadata: GitChangedFileMetadata;
  readonly selection: RepositoryRootSelection;
  readonly scope: ChangedFileScanScope;
}

const unavailableGitMetadataExecutor: GitMetadataExecutor = () =>
  Object.freeze({ exitCode: 1, stdout: new Uint8Array() });

async function collectChangedScanState(
  command: CliCommandContext,
  scanSelection: RepositoryRootSelection,
  createExecutor: ScanOptions["createGitMetadataExecutor"],
): Promise<ChangedScanState | null> {
  if (command.changedBaseReference === null) return null;
  const gitSelection = await selectRepositoryRoot(scanSelection.root, {
    mode: "discover",
    signal: command.signal,
  });
  const sameRepository =
    gitSelection.root === scanSelection.root &&
    gitSelection.identity.device === scanSelection.identity.device &&
    gitSelection.identity.inode === scanSelection.identity.inode;
  const scope = createChangedFileScanScope(gitSelection);
  let executor = unavailableGitMetadataExecutor;
  if (sameRepository && createExecutor !== undefined)
    try {
      executor = await createExecutor(gitSelection, command.signal);
    } catch {
      // An unavailable trusted executable is an explicit full-scan fallback, never an operational
      // failure and never a reason to retry with repository or PATH-selected process authority.
    }
  const capability = createGitMetadataCapability(scope, executor);
  const metadata = await collectGitChangedFileMetadata(capability, {
    baseReference: command.changedBaseReference,
    signal: command.signal,
  });
  return Object.freeze({ capability, metadata, scope, selection: gitSelection });
}

async function stableChangedMetadata(
  state: ChangedScanState,
  command: CliCommandContext,
): Promise<GitChangedFileMetadata> {
  if (command.changedBaseReference === null)
    throw new TypeError("changed metadata recheck requires an explicit base reference");
  const after = await collectGitChangedFileMetadata(state.capability, {
    baseReference: command.changedBaseReference,
    signal: command.signal,
  });
  return reconcileGitChangedFileMetadata(state.scope, state.metadata, after);
}

function changedCriticalPaths(
  state: ChangedScanState | null,
  includedPaths: readonly RepositoryRelativePath[],
): Readonly<{ readonly complete: boolean; readonly paths: readonly RepositoryRelativePath[] }> {
  if (state?.metadata.state !== "ready")
    return Object.freeze({ complete: true, paths: Object.freeze([]) });
  const included = new Set(includedPaths);
  const paths = [
    ...new Set(
      state.metadata.changes.flatMap((change) =>
        [change.path, change.previousPath].filter(
          (value): value is RepositoryRelativePath =>
            value !== null && included.has(value) && classifyTargetSourcePath(value) !== null,
        ),
      ),
    ),
  ].sort(compareRepositoryRelativePaths);
  return Object.freeze({
    complete: paths.length <= TARGET_SAMPLER_DEFAULT_LIMITS.maximumCriticalPaths,
    paths: Object.freeze(paths.slice(0, TARGET_SAMPLER_DEFAULT_LIMITS.maximumCriticalPaths)),
  });
}

function selectedDiagnosticBundle(
  bundle: DiagnosticBundle,
  changed: ChangedFileModeResult | null,
): DiagnosticBundle {
  if (changed === null || changed.mode === "full") return bundle;
  const included = new Set(changed.includedDiagnosticIds);
  const diagnostics = Object.freeze(bundle.diagnostics.filter((entry) => included.has(entry.id)));
  const fingerprints = new Set(diagnostics.map((entry) => entry.fingerprints.path.value));
  const relevantPaths = new Set([
    ...changed.selectedPaths,
    ...diagnostics.map((entry) => entry.primary.path),
  ]);
  const suppressions = Object.freeze(
    bundle.suppressions.flatMap((entry) => {
      const matchedPathFingerprints = entry.matchedPathFingerprints.filter((fingerprint) =>
        fingerprints.has(fingerprint),
      );
      if (matchedPathFingerprints.length === 0 && !relevantPaths.has(entry.directive.path))
        return [];
      return [
        Object.freeze({
          ...entry,
          matchedPathFingerprints: Object.freeze(matchedPathFingerprints),
        }),
      ];
    }),
  );
  return Object.freeze({
    contractVersion: bundle.contractVersion,
    diagnostics,
    recordKind: bundle.recordKind,
    suppressions,
  });
}

function selectedPolicyFailure(
  changed: ChangedFileModeResult | null,
  scheduled: Awaited<ReturnType<typeof scheduleRuleFamilies>> & { readonly ok: true },
  threshold: RuleSchedulerFailureThreshold,
): boolean {
  if (changed === null || changed.mode === "full") return scheduled.summary.shouldFail;
  const included = new Set(changed.includedDiagnosticIds);
  const severities = scheduled.visibleDiagnostics
    .filter((entry) => included.has(entry.id))
    .map((entry) => entry.severity);
  return threshold === "warning"
    ? severities.some((severity) => severity === "error" || severity === "warning")
    : threshold === "error"
      ? severities.includes("error")
      : false;
}

export function classifyOccurrenceDecision(
  context: {
    readonly documents: readonly {
      readonly path: RepositoryRelativePath;
      readonly state: EffectiveContextResolution["documents"][number]["state"];
    }[];
  },
  dag: Pick<ReturnType<typeof buildDocumentImportDag>, "entryDocumentId" | "entryPath">,
  occurrence: ReturnType<typeof buildDocumentImportDag>["occurrences"][number],
): {
  readonly activation: "always" | "conditional" | null;
  readonly disposition: "excluded" | "included" | "unknown";
} {
  const entry = context.documents.find((document) => document.path === dag.entryPath);
  const own =
    occurrence.targetPath === null
      ? undefined
      : context.documents.find((document) => document.path === occurrence.targetPath);
  const isEntryOccurrence =
    occurrence.state === "entry" && occurrence.targetDocumentId === dag.entryDocumentId;
  // Imported graph nodes are not necessarily independent D-profile candidates. Once C10 proves a
  // loaded edge, their activation inherits the containing entry document unless E05 has a more
  // specific document decision for that path.
  const state =
    own?.state ??
    (isEntryOccurrence || ["loaded", "already-loaded"].includes(occurrence.state)
      ? entry?.state
      : undefined);
  if (state === "inactive" || state === "shadowed")
    return Object.freeze({ activation: null, disposition: "excluded" });
  if (!["entry", "loaded", "already-loaded"].includes(occurrence.state))
    return Object.freeze({ activation: null, disposition: "unknown" });
  if (state === "effective" || state === "empty")
    return Object.freeze({ activation: "always", disposition: "included" });
  if (state === "conditional")
    return Object.freeze({ activation: "conditional", disposition: "included" });
  return Object.freeze({ activation: null, disposition: "unknown" });
}

async function familyRequests(
  initialParsed: ParsedRepository,
  context: RepositoryContext,
  candidates: readonly CandidateBytes[],
  command: CliCommandContext,
  changedCriticalPaths: readonly RepositoryRelativePath[],
  runtime: Pick<
    ScanOptions,
    | "environment"
    | "now"
    | "observeActivationRules"
    | "observeEfficiencyReport"
    | "observeEfficiencyScenarios"
    | "observeMetricProfiles"
    | "observePortabilityFormatObservations"
    | "observeSampling"
  >,
): Promise<{
  readonly contexts: readonly EffectiveContextResolution[];
  readonly families: readonly RuleFamilyRequest[];
}> {
  let parsed = initialParsed;
  const workspace = await discoverWorkspaceBoundaries(context.repository, context.discovery, {
    signal: command.signal,
  });
  const evidence = await collectRepositoryEvidence(
    context.repository,
    workspace,
    context.includedPaths,
    {
      configuredPackageManager: context.configuration.commands.packageManager,
      signal: command.signal,
    },
  );
  const samplingInput = {
    criticalPaths: changedCriticalPaths,
    paths: context.includedPaths,
    trackingCertainty: context.trackingCertainty,
    trackingReason: context.trackingReason,
    workspaceBoundaries: workspace.boundaries,
    workspaceUncertainty: workspace.uncertainty,
    workspaceUncertaintyReasons: workspace.uncertaintyReasons,
  } as const;
  const profiles = enabledProfiles(context.configuration, command);
  if (profiles.length === 0) throw new Error("scan selected no enabled profiles");
  const identityResolutions = flattenResolutions(
    await allResolutions(context, candidates, "." as RepositoryRelativePath),
    profiles,
    context.configuration,
    command,
  );
  const identityContexts = identityResolutions.map((entry) =>
    resolveEffectiveContext({
      contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
      importDags: [],
      profileResolution: entry,
      recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
      targetPath: "." as RepositoryRelativePath,
    }),
  );
  parsed = filterParsedRepository(parsed, identityContexts);
  parsed = attachActivationRules(parsed, identityContexts);
  runtime.observeActivationRules?.(parsed.ir.activationRules);
  const sourcePaths = context.includedPaths.filter(
    (path) => classifyTargetSourcePath(path) !== null,
  );
  if (
    parsed.ir.activationRules.length > 0 &&
    sourcePaths.length >
      Math.floor(MAX_SCAN_ACTIVATION_EVALUATIONS / parsed.ir.activationRules.length)
  )
    throw new Error("activation evaluation matrix exceeds the scan work limit");
  const allActivationResults = activationResultsForPaths(parsed, sourcePaths);
  const sampling = sampleTargets({
    ...samplingInput,
    activationObservations: samplingActivationObservations(allActivationResults),
  });
  runtime.observeSampling?.(sampling);
  const targets =
    sampling.selected.length === 0
      ? Object.freeze(["." as RepositoryRelativePath])
      : Object.freeze(sampling.selected.map((entry) => entry.path));
  const contexts: EffectiveContextResolution[] = [];
  const inputsByContext = new Map<EffectiveContextResolution, ResolveEffectiveContextInput>();
  const dagsByContext = new Map<
    EffectiveContextResolution,
    readonly ReturnType<typeof buildDocumentImportDag>[]
  >();
  const comparison = [];
  for (const target of targets) {
    const resolutions = flattenResolutions(
      await allResolutions(context, candidates, target),
      profiles,
      context.configuration,
      command,
    );
    const targetContexts = resolutions.map((entry) => {
      const baseInput: ResolveEffectiveContextInput = {
        contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
        importDags: [],
        profileResolution: entry,
        recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
        targetPath: target,
      };
      const base = resolveEffectiveContext(baseInput);
      const documentPaths = new Set(base.documents.map((document) => document.path));
      // `.` is the repository identity used only when there are no source targets to sample. It is
      // deliberately not a synthetic file path and therefore must not enter target trace evidence.
      const applicableDags = Object.freeze(
        target === "."
          ? []
          : parsed.graphs
              .filter(
                ({ authority, graph }) =>
                  authorityApplies(authority, base) && documentPaths.has(graph.entryPath),
              )
              .map(({ graph }) =>
                buildDocumentImportDag({
                  graph,
                  trace: createSyntheticTargetTrace({
                    launchCwd: "." as RepositoryRelativePath,
                    purpose: "scan-effective-context",
                    targetPath: target,
                    workspaceRoots: ["." as RepositoryRelativePath],
                  }),
                }),
              ),
      );
      const resolvedInput: ResolveEffectiveContextInput =
        applicableDags.length === 0
          ? baseInput
          : {
              ...baseInput,
              importDags: applicableDags,
            };
      const resolved = applicableDags.length === 0 ? base : resolveEffectiveContext(resolvedInput);
      dagsByContext.set(resolved, applicableDags);
      inputsByContext.set(resolved, resolvedInput);
      return resolved;
    });
    contexts.push(...targetContexts);
    if (targetContexts.length >= 2)
      comparison.push(
        compareEffectiveContexts({
          contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
          recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
          resolutions: targetContexts,
        }),
      );
  }
  const frozenContexts = Object.freeze(contexts);
  const activation = activationEvidence(
    parsed,
    frozenContexts,
    sampling,
    workspace.boundaries,
    allActivationResults,
  );
  const primaryDocuments = [
    ...new Map(
      [...parsed.ir.documents].reverse().map((document) => {
        const source = parsed.ir.sources.find((entry) => entry.id === document.sourceId);
        if (source === undefined) throw new Error("document source relationship is missing");
        return [source.path, Object.freeze({ document, source })] as const;
      }),
    ).values(),
  ];
  const primaryDocumentByPath = new Map(
    primaryDocuments.map((entry) => [entry.source.path, entry.document]),
  );
  const documentCounts = primaryDocuments.map(({ document, source }) => {
    const count = countEstimatedTokens(source.text);
    if (!count.ok) throw new Error("document exceeds tokenizer limits");
    return {
      classificationState:
        source.parseState.state === "complete" ? ("complete" as const) : ("partial" as const),
      count: count.value,
      documentId: document.id,
      path: source.path,
    };
  });
  const primaryDocumentIds = new Set(primaryDocuments.map((entry) => entry.document.id));
  const statementCounts = parsed.ir.statements
    .filter((statement) => primaryDocumentIds.has(statement.documentId))
    .map((statement) => {
      const count = countEstimatedTokens(statement.text);
      if (!count.ok) throw new Error("statement exceeds tokenizer limits");
      return {
        count: count.value,
        statement: {
          documentId: statement.documentId,
          nodeIds: statement.nodeIds,
          range: statement.range,
          statementId: statement.id,
          text: statement.text,
        },
      };
    });
  // Empty profile/target combinations still need an issued E04 shape for F04 accounting. Build
  // that shape from a closed zero-document C10 transport instead of probing a repository path:
  // linked worktrees represent `.git` as a regular pointer file, and repository metadata is never
  // instruction content.
  const emptyGraph: ImportGraphResult = Object.freeze({
    contractVersion: "0.1.0",
    edges: Object.freeze([]),
    entryPath: ".agent-context-lint/empty-context" as RepositoryRelativePath,
    issues: Object.freeze([]),
    nodes: Object.freeze([]),
    state: "complete",
    syntax: "claude-code",
    usage: Object.freeze({ edges: 0, files: 0, issues: 0, totalBytes: 0 }),
  });
  const metricProfiles = [
    ...new Map(
      frozenContexts.map((entry) => [`${entry.profileId}\0${entry.surfaceId}`, entry]),
    ).values(),
  ].map((identityContext) => {
    const accountings = sampling.selected.flatMap((sample) => {
      const targetContext = frozenContexts.find(
        (entry) =>
          entry.targetPath === sample.path &&
          entry.profileId === identityContext.profileId &&
          entry.surfaceId === identityContext.surfaceId,
      );
      if (targetContext === undefined) return [];
      const applicableDocumentPaths = new Set(
        targetContext.documents
          .filter((document) => ["conditional", "effective", "empty"].includes(document.state))
          .map((document) => document.path),
      );
      // F04 metrics inventory physical documents, not dialect interpretations. Keep an import DAG
      // only when every occurrence already names that path's canonical metric document. When two
      // dialects interpret one physical source, the non-primary interpretation is retained in IR
      // and rule inputs while efficiency falls back to the same physical documents without
      // fabricating cross-dialect occurrence identities.
      const applicableImportDags = Object.freeze(
        (dagsByContext.get(targetContext) ?? []).filter(
          (dag) =>
            dag.graphState === "complete" &&
            dag.documents.every(
              (document) => primaryDocumentByPath.get(document.path)?.id === document.documentId,
            ),
        ),
      );
      const importDagPaths = new Set(
        applicableImportDags.flatMap((dag) => dag.documents.map((document) => document.path)),
      );
      const noImportDags = [...applicableDocumentPaths].flatMap((documentPath) => {
        if (importDagPaths.has(documentPath)) return [];
        const document = primaryDocumentByPath.get(documentPath);
        if (document?.importIds.length !== 0) return [];
        return [
          buildNoImportDocumentDag({
            documentId: document.id,
            ir: parsed.ir,
            trace: createSyntheticTargetTrace({
              launchCwd: "." as RepositoryRelativePath,
              purpose: "scan-target-accounting",
              targetPath: sample.path,
              workspaceRoots: ["." as RepositoryRelativePath],
            }),
          }),
        ];
      });
      const dags = [...applicableImportDags, ...noImportDags];
      if (dags.length === 0)
        dags.push(
          buildDocumentImportDag({
            graph: emptyGraph,
            trace: createSyntheticTargetTrace({
              launchCwd: "." as RepositoryRelativePath,
              purpose: "scan-empty-target-accounting",
              targetPath: sample.path,
              workspaceRoots: ["." as RepositoryRelativePath],
            }),
          }),
        );
      const baseAccountings = dags.map((dag) => {
        const measurements = dag.documents.map((document) => {
          const measurement = documentCounts.find(
            (entry) => entry.documentId === document.documentId,
          );
          if (measurement === undefined) throw new Error("accounting measurement is unavailable");
          return { count: measurement.count, documentId: document.documentId };
        });
        const accounting = accountOccurrenceTokens({
          dag,
          documentMeasurements: measurements,
          identity: BUILTIN_ESTIMATE_IDENTITY,
          occurrenceDecisions: dag.occurrences.map((occurrence) => {
            const document = dag.documents.find(
              (entry) => entry.documentId === occurrence.targetDocumentId,
            );
            const measurement = measurements.find(
              (entry) => entry.documentId === occurrence.targetDocumentId,
            );
            const decision = classifyOccurrenceDecision(targetContext, dag, occurrence);
            const included = decision.disposition === "included";
            return {
              activation: decision.activation,
              count: included ? (measurement?.count ?? null) : null,
              disposition: decision.disposition,
              occurrenceId: occurrence.id,
              sourceBytesConsumed: included ? (document?.byteLength ?? null) : null,
            };
          }),
        });
        return accounting;
      });
      const firstAccounting = baseAccountings[0];
      if (firstAccounting === undefined)
        throw new Error("target accounting construction produced no result");
      return [
        {
          accounting:
            baseAccountings.length === 1
              ? firstAccounting
              : combineOccurrenceTokenAccountings({ accountings: baseAccountings }),
          path: sample.path,
        },
      ];
    });
    return {
      accountings,
      profile: {
        clientVersion: identityContext.clientVersion,
        profileId: identityContext.profileId,
        profileVersion: identityContext.profileVersion,
        specSnapshotId: identityContext.specSnapshotId,
        surfaceId: identityContext.surfaceId,
      },
      sampling,
    };
  });
  runtime.observeMetricProfiles?.(metricProfiles);
  const metrics = analyzeContextEfficiencyMetrics({
    comparisons: comparison.filter((entry) =>
      sampling.selected.some((sample) => sample.path === entry.targetPath),
    ),
    contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
    documents: documentCounts,
    identity: BUILTIN_ESTIMATE_IDENTITY,
    profiles: metricProfiles,
    recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
    statements: statementCounts,
  });
  const score = calculateContextEfficiencyScore(metrics, context.configuration.efficiency);
  const recommendationScenarios: EfficiencyRecommendationScenario[] = [];
  for (const cluster of metrics.duplication.exact.clusters.slice(0, 128)) {
    const evidenceDocumentIds = [
      cluster.canonical.documentId,
      ...cluster.duplicates.map((entry) => entry.documentId),
    ].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    const evidenceDocuments = evidenceDocumentIds.map((documentId) =>
      parsed.ir.documents.find((document) => document.id === documentId),
    );
    if (evidenceDocuments.some((document) => document === undefined)) continue;
    const evidencePaths = evidenceDocuments.map((document) => {
      const source = parsed.ir.sources.find((entry) => entry.id === document?.sourceId);
      return source?.path;
    });
    // A whole-document removal is a valid counterfactual only when each exact-statement witness
    // identifies a distinct discovered file and none of those files owns imports. G08 still proves
    // unique-content retention and rejects documents containing unrelated instructions.
    if (
      evidencePaths.some((entry) => entry === undefined) ||
      new Set(evidencePaths).size !== evidencePaths.length ||
      evidenceDocuments.some((document) => (document?.importIds.length ?? 1) !== 0) ||
      evidencePaths.some(
        (entry) => !candidates.some((candidate) => candidate.candidate.path === entry),
      )
    )
      continue;
    const canonicalDocument = parsed.ir.documents.find(
      (document) => document.id === cluster.canonical.documentId,
    );
    const canonicalPath = parsed.ir.sources.find(
      (entry) => entry.id === canonicalDocument?.sourceId,
    )?.path;
    if (canonicalPath === undefined) continue;
    const removedPaths = new Set(
      evidencePaths.filter((entry): entry is RepositoryRelativePath => entry !== canonicalPath),
    );
    if (removedPaths.size === 0) continue;
    const projectedCandidates = Object.freeze(
      candidates.filter((candidate) => !removedPaths.has(candidate.candidate.path)),
    );
    const affected = metrics.amplification.flatMap((profile) =>
      profile.targets
        .filter((target) =>
          target.contributions.some((entry) => evidenceDocumentIds.includes(entry.documentId)),
        )
        .map((target) => Object.freeze({ profile: profile.profile, targetPath: target.path })),
    );
    if (affected.length === 0 || affected.length > 4_096) continue;
    const projectedByTarget = new Map<
      RepositoryRelativePath,
      readonly EffectiveContextProfileResolution[]
    >();
    let complete = true;
    const scenarioTargets: {
      readonly baseline: ResolveEffectiveContextInput;
      readonly projected: ResolveEffectiveContextInput;
    }[] = [];
    for (const affectedTarget of affected) {
      const baselineContext = frozenContexts.find(
        (entry) =>
          entry.targetPath === affectedTarget.targetPath &&
          entry.profileId === affectedTarget.profile.profileId &&
          entry.surfaceId === affectedTarget.profile.surfaceId &&
          entry.profileVersion === affectedTarget.profile.profileVersion &&
          entry.specSnapshotId === affectedTarget.profile.specSnapshotId &&
          entry.clientVersion === affectedTarget.profile.clientVersion,
      );
      const baseline =
        baselineContext === undefined ? undefined : inputsByContext.get(baselineContext);
      if (baseline === undefined) {
        complete = false;
        break;
      }
      if (
        baseline.importDags.some((dag) =>
          dag.occurrences.some((occurrence) => occurrence.state !== "entry"),
        )
      ) {
        complete = false;
        break;
      }
      const measuredBaseline = Object.freeze({ ...baseline, importDags: Object.freeze([]) });
      const normalizedBaseline = resolveEffectiveContext(measuredBaseline);
      if (
        baselineContext?.assembly.sha256 !== normalizedBaseline.assembly.sha256 ||
        baselineContext.assembly.byteLength !== normalizedBaseline.assembly.byteLength
      ) {
        complete = false;
        break;
      }
      let projectedProfiles = projectedByTarget.get(affectedTarget.targetPath);
      if (projectedProfiles === undefined) {
        projectedProfiles = flattenResolutions(
          await allResolutions(context, projectedCandidates, affectedTarget.targetPath),
          profiles,
          context.configuration,
          command,
        );
        projectedByTarget.set(affectedTarget.targetPath, projectedProfiles);
      }
      const projectedProfile = projectedProfiles.find(
        (entry) =>
          entry.profile.profileId === affectedTarget.profile.profileId &&
          entry.profile.surfaceId === affectedTarget.profile.surfaceId &&
          entry.profile.contractVersion === affectedTarget.profile.profileVersion &&
          entry.profile.specSnapshotId === affectedTarget.profile.specSnapshotId,
      );
      if (projectedProfile === undefined) {
        complete = false;
        break;
      }
      scenarioTargets.push(
        Object.freeze({
          baseline: measuredBaseline,
          projected: Object.freeze({
            ...baseline,
            importDags: Object.freeze([]),
            profileResolution: projectedProfile,
          }),
        }),
      );
    }
    if (!complete || scenarioTargets.length !== affected.length) continue;
    recommendationScenarios.push(
      Object.freeze({
        evidenceDocumentIds: Object.freeze(evidenceDocumentIds),
        evidenceId: cluster.id,
        id: `recommendation:exact:${cluster.id}`,
        targets: Object.freeze(scenarioTargets),
      }),
    );
  }
  const recommendations = await projectContextEfficiencyRecommendations({
    contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
    metrics,
    recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
    scenarios: Object.freeze(recommendationScenarios),
    score,
  });
  runtime.observeEfficiencyScenarios?.(metrics, recommendationScenarios);
  runtime.observeEfficiencyReport?.(
    createContextEfficiencyReport({
      metrics,
      recommendations,
      scope: { kind: "repository", targetPath: null },
      score,
    }),
  );
  const referenceTargets: {
    readonly formatId: string;
    readonly importId: InstructionIr["imports"][number]["id"];
    readonly markdownLinks: "not-applicable" | "unknown";
    readonly profileId: CliAgentProfile;
    readonly surfaceId: CliSurfaceId;
  }[] = [];
  const referenceTargetIdentities = new Set<string>();
  for (const item of parsed.ir.imports) {
    const formatId =
      parsed.importFormatIds.get(item.id) ??
      parsed.ir.documents.find((document) => document.id === item.documentId)?.formatId ??
      "unknown";
    for (const entry of frozenContexts) {
      const authority = parsed.importAuthorities.get(item.id);
      if (authority === undefined || !authorityApplies(authority, entry)) continue;
      const identity = `${item.id}\0${formatId}\0${entry.profileId}\0${entry.surfaceId}`;
      if (referenceTargetIdentities.has(identity)) continue;
      referenceTargetIdentities.add(identity);
      referenceTargets.push({
        formatId,
        importId: item.id,
        markdownLinks: entry.profileId === "copilot-vscode" ? "unknown" : "not-applicable",
        profileId: entry.profileId as CliAgentProfile,
        surfaceId: entry.surfaceId as CliSurfaceId,
      });
    }
  }
  const portabilityProfiles = [
    ...new Map(
      frozenContexts.map((entry) => [`${entry.profileId}\0${entry.surfaceId}`, entry]),
    ).values(),
  ];
  const portabilityFormatObservations = parsed.ir.documents.flatMap((document) =>
    portabilityProfiles.map((entry) => ({
      documentId: document.id,
      profileId: entry.profileId as CliAgentProfile,
      state: portabilityFormatState(
        document.formatId,
        entry.profileId as CliAgentProfile,
        entry.surfaceId as CliSurfaceId,
      ),
      surfaceId: entry.surfaceId,
    })),
  );
  runtime.observePortabilityFormatObservations?.(portabilityFormatObservations);
  const families: RuleFamilyRequest[] = [
    {
      familyId: "syntax-structure",
      input: syntaxRuleInput(parsed),
      options: undefined,
    },
    {
      familyId: "references-imports",
      input: {
        contractVersion: "0.1.0",
        graphs: parsed.graphs.map((entry) => entry.graph),
        ir: parsed.ir,
        pathSnapshot: {
          completeness: context.discovery.uncertainty === "known" ? "complete" : "partial",
          paths: context.includedPaths,
        },
        recordKind: "agent-context-references-imports-rule-input",
        targets: referenceTargets,
      },
      options: undefined,
    },
    {
      familyId: "scope-activation",
      input: {
        activationResults: activation.activationResults,
        contractVersion: "0.1.0",
        facts: activation.facts,
        ir: parsed.ir,
        recordKind: "agent-context-scope-activation-rule-input",
        sampling: samplingInput,
      },
      options: undefined,
    },
    {
      familyId: "conflicts-duplication",
      input: {
        contexts: frozenContexts,
        contractVersion: "0.1.0",
        ir: parsed.ir,
        recordKind: "agent-context-conflicts-duplication-rule-input",
      },
      options: undefined,
    },
    {
      familyId: "repository-drift",
      input: {
        evidenceIndex: evidence,
        statements: parsed.ir.statements.map((statement) => {
          const source = parsed.ir.sources.find((entry) => entry.id === statement.range.sourceId);
          if (source === undefined) throw new Error("statement source relationship is missing");
          return {
            // Repository instruction commands use the portable argv subset accepted by POSIX
            // shells unless an explicit profile-specific dialect is available. Keeping this
            // deterministic also lets F09 validate ordinary npm/pnpm/make/just invocations;
            // `auto` intentionally classifies those marker-free commands as uncertain.
            dialect: "posix-shell" as const,
            documentId: statement.documentId,
            nodeIds: statement.nodeIds,
            path: source.path,
            range: statement.range,
            sourceDigest: source.sha256,
            statementId: statement.id,
            text: statement.text,
          };
        }),
      },
      options: undefined,
    },
    {
      familyId: "document-context",
      input: {
        contractVersion: "0.1.0",
        importResolutions: parsed.importResolutions,
        ir: parsed.ir,
        recordKind: "agent-context-document-context-rule-input",
      },
      options:
        context.configuration.rules["ACL350"]?.maxTokens === null ||
        context.configuration.rules["ACL350"]?.maxTokens === undefined
          ? undefined
          : { maxAlwaysOnTokens: context.configuration.rules["ACL350"].maxTokens },
    },
    {
      familyId: "security",
      input: {
        contractVersion: "0.1.0",
        ir: parsed.ir,
        recordKind: "agent-context-security-rule-input",
        statementDialects: parsed.ir.statements.map((entry) => ({
          dialect: "auto" as const,
          statementId: entry.id,
        })),
      },
      options: undefined,
    },
    {
      familyId: "portability",
      input: {
        behaviorObservations: [],
        comparisons: comparison,
        contractVersion: "0.1.0",
        formatInventoryState: context.discovery.uncertainty === "known" ? "complete" : "partial",
        formatObservations: portabilityFormatObservations,
        ir: parsed.ir,
        recordKind: "agent-context-portability-rule-input",
      },
      options: undefined,
    },
    {
      familyId: "context-efficiency",
      input: {
        contractVersion: CONTEXT_EFFICIENCY_RULE_CONTRACT_VERSION,
        ir: parsed.ir,
        metrics,
        recommendations,
        recordKind: "agent-context-efficiency-rule-input",
        score,
        tokenizerComparisons: [],
      },
      options: undefined,
    },
  ];
  if (parsed.ir.sources[0] !== undefined) {
    // H03 currently ships one immutable stable pack. Preview is an opt-in standards mode, not a
    // second bundled artifact; offline scans therefore retain stable bundled evidence while
    // enabling preview-specific rule policy below.
    const bundled = await loadBundledKnowledgePack({
      channel: "stable",
      engineVersion: SCAN_CLI_VERSION,
    });
    if (!bundled.ok) throw new Error("bundled standards unavailable");
    let lockfile: Uint8Array | null = null;
    if (context.includedPaths.includes(context.configuration.standards.lockfile))
      try {
        lockfile = (
          await context.repository.readFile(context.configuration.standards.lockfile)
        ).bytes();
      } catch {
        lockfile = null;
      }
    const statusRequest = Object.freeze({
      asOf: runtime.now(),
      bundled: bundled.value,
      cachedLatest: null,
      engineVersion: SCAN_CLI_VERSION,
      lockfile,
      maxAgeDays: context.configuration.standards.maxAgeDays,
    });
    const status = createOfflineStandardsStatus(statusRequest);
    if (!status.ok) throw new Error("offline standards status unavailable");
    const selectedPack =
      status.value.output.activation === "locked" && status.value.output.locked !== null
        ? Object.freeze({
            digest: status.value.output.locked.digest,
            origin: "locked" as const,
            version: status.value.output.locked.version,
          })
        : Object.freeze({
            digest: status.value.output.bundled.digest,
            origin: "bundled" as const,
            version: status.value.output.bundled.version,
          });
    const deprecatedSyntax = parsed.ir.documents.flatMap((document) => {
      if (document.formatId !== "cursor-legacy-rules") return [];
      const source = parsed.ir.sources.find((entry) => entry.id === document.sourceId);
      if (source === undefined) return [];
      const root = parsed.ir.nodes.find((entry) => entry.id === document.rootNodeId);
      const deprecationRange =
        root?.childIds
          .map((id) => parsed.ir.nodes.find((entry) => entry.id === id))
          .find((entry) => entry !== undefined && entry.kind !== "html-comment")?.range ??
        root?.range;
      if (deprecationRange === undefined) return [];
      return [
        Object.freeze({
          deprecatedSince: "2026-08-02",
          evidence: Object.freeze({
            evidenceRefId: "CURSOR-SURFACE-01",
            retrievedAt: "2026-08-02",
            revision: null,
            url: "https://cursor.com/docs/rules",
          }),
          pack: selectedPack,
          profileId: "cursor-agent",
          range: deprecationRange,
          replacementId: "cursor-mdc",
          sourceId: source.id,
          specSnapshotId: "cursor/2026-08-01",
          subjectId: "cursor-legacy-rules",
          surfaceId: "cursor-agent/ide",
        }),
      ];
    });
    families.push({
      familyId: "standards-freshness",
      input: {
        anchorSourceId: parsed.ir.sources[0].id,
        contractVersion: "0.1.0",
        deprecatedSyntax,
        environment: runtime.environment,
        ir: parsed.ir,
        liveUpdates: [],
        previewEnabled: context.configuration.standards.channel === "preview",
        recordKind: "agent-context-standards-freshness-rule-input",
        statusRequest,
      },
      options: undefined,
    });
  }
  const selected = selectedFamilies(command);
  return Object.freeze({
    contexts: frozenContexts,
    families: Object.freeze(
      families.filter(
        (entry) =>
          selected.has(entry.familyId) &&
          !(entry.familyId === "portability" && comparison.length === 0),
      ),
    ),
  });
}

async function scan(
  command: CliCommandContext,
  options: ScanOptions,
): Promise<"success" | "policy-failure"> {
  const selectedPath =
    command.operands[0] === undefined
      ? options.workingDirectory
      : path.resolve(options.workingDirectory, command.operands[0]);
  const selection = await selectRepositoryRoot(selectedPath, {
    mode: command.operands[0] === undefined ? "discover" : "explicit",
    signal: command.signal,
  });
  const changedState = await collectChangedScanState(
    command,
    selection,
    options.createGitMetadataExecutor,
  );
  const configuration = await resolveAgentContextConfiguration(selection.root);
  if (!configuration.ok) throw new Error("repository configuration is invalid");
  const initialConfigurationFingerprint = configurationFingerprint(configuration);
  const repositoryOptions = Object.freeze({
    maximumEntries: configuration.value.limits.maxFiles,
    maximumFileBytes: 16_777_216,
    maximumTotalBytes: configuration.value.limits.maxTotalBytes,
    maximumTraversalDepth: configuration.value.limits.maxTraversalDepth,
    signal: command.signal,
  });
  const initialRepository = recordingRepository(
    await createReadOnlyRepository(selection, repositoryOptions),
  );
  const repository = initialRepository.repository;
  const enumerationOptions = Object.freeze({
    maximumDepth: configuration.value.limits.maxTraversalDepth,
    maximumFiles: configuration.value.limits.maxFiles,
  });
  const enumeration =
    changedState?.metadata.state === "ready"
      ? enumerateTrackedFilesFromGitChangedFileMetadata(
          changedState.scope,
          changedState.metadata,
          enumerationOptions,
        )
      : await enumerateTrackedFiles(repository, enumerationOptions);
  const untrackedRepository =
    changedState?.metadata.state === "ready"
      ? recordingRepository(await createReadOnlyRepository(selection, repositoryOptions))
      : null;
  const untrackedEnumeration =
    untrackedRepository !== null
      ? await enumerateRepositoryFilesForUntrackedProof(
          untrackedRepository.repository,
          enumerationOptions,
        )
      : null;
  const ignored = await applyIgnoreRules(repository, enumeration, {
    configurationPatterns: configuration.value.ignore,
    maximumPaths: configuration.value.limits.maxFiles,
    signal: command.signal,
  });
  const untrackedIgnored =
    untrackedEnumeration === null || untrackedRepository === null
      ? null
      : await applyIgnoreRules(untrackedRepository.repository, untrackedEnumeration, {
          configurationPatterns: configuration.value.ignore,
          maximumPaths: configuration.value.limits.maxFiles,
          signal: command.signal,
        });
  const trackedPaths =
    changedState?.metadata.state === "ready" ? new Set(changedState.metadata.trackedPaths) : null;
  const hasRelevantUntracked =
    trackedPaths !== null && untrackedIgnored !== null
      ? untrackedIgnored.paths.some((pathValue) => !trackedPaths.has(pathValue))
      : false;
  const effectiveEnumeration =
    hasRelevantUntracked && untrackedEnumeration !== null ? untrackedEnumeration : enumeration;
  const effectiveIgnored =
    hasRelevantUntracked && untrackedIgnored !== null ? untrackedIgnored : ignored;
  const discoveryOptions = Object.freeze({
    maximumCandidates: configuration.value.limits.maxFiles,
    maximumPaths: configuration.value.limits.maxFiles,
    signal: command.signal,
  });
  const planningDiscovery = buildTargetedDiscoveryIndex(enumeration, ignored, discoveryOptions);
  const discovery = hasRelevantUntracked
    ? buildTargetedDiscoveryIndex(effectiveEnumeration, effectiveIgnored, discoveryOptions)
    : planningDiscovery;
  const context: RepositoryContext = Object.freeze({
    configuration: configuration.value,
    discovery,
    includedPaths: effectiveIgnored.paths,
    importRepository: includedRepository(repository, effectiveIgnored.paths),
    repository,
    selection,
    trackingCertainty: effectiveEnumeration.certainty,
    trackingReason: effectiveEnumeration.reason,
  });
  const candidates: CandidateBytes[] = [];
  for (const candidate of discovery.candidates) {
    if (!candidate.kinds.includes("instruction")) continue;
    const file = await repository.readFile(candidate.path);
    if (file.size > configuration.value.limits.maxFileBytes)
      throw new Error("instruction file exceeds configured limit");
    candidates.push(Object.freeze({ bytes: file.bytes(), candidate, identity: file.identity }));
  }
  const parsed = await parseRepository(
    Object.freeze(candidates),
    includedRepository(repository, effectiveIgnored.paths),
    configuration.value.limits,
    command.signal,
  );
  options.observeParsed?.(parsed);
  const changedTargets = changedCriticalPaths(changedState, effectiveIgnored.paths);
  const prepared = await familyRequests(
    parsed,
    context,
    candidates,
    command,
    changedTargets.paths,
    options,
  );
  if (prepared.contexts.length === 0) throw new Error("scan selected no enabled profile surfaces");
  const scheduled = await scheduleRuleFamilies(
    {
      contractVersion: RULE_SCHEDULER_CONTRACT_VERSION,
      families: prepared.families,
      policy: policy(command, configuration.value),
      recordKind: RULE_SCHEDULER_RECORD_KIND,
    },
    {
      ...(command.maximumConcurrency === null || command.maximumConcurrency === undefined
        ? {}
        : { maximumConcurrency: command.maximumConcurrency }),
      maximumDiagnostics: configuration.value.limits.maxDiagnostics,
      signal: command.signal,
    },
  );
  if (!scheduled.ok) throw new Error(`rule scheduling failed: ${JSON.stringify(scheduled.issues)}`);
  let changedResult: ChangedFileModeResult | null = null;
  if (changedState !== null) {
    let metadata = await stableChangedMetadata(changedState, command);
    let relevantInventoryChanged = false;
    let lateRelevantUntracked = false;
    if (changedState.metadata.state === "ready" && metadata.state === "ready") {
      const finalRepository = await createReadOnlyRepository(selection, {
        maximumEntries: configuration.value.limits.maxFiles,
        maximumFileBytes: 16_777_216,
        maximumTotalBytes: configuration.value.limits.maxTotalBytes,
        maximumTraversalDepth: configuration.value.limits.maxTraversalDepth,
        signal: command.signal,
      });
      const finalEnumeration = await enumerateRepositoryFilesForUntrackedProof(
        finalRepository,
        enumerationOptions,
      );
      const finalIgnored = await applyIgnoreRules(finalRepository, finalEnumeration, {
        configurationPatterns: configuration.value.ignore,
        maximumPaths: configuration.value.limits.maxFiles,
        signal: command.signal,
      });
      const initialPaths = untrackedIgnored?.paths ?? Object.freeze([]);
      relevantInventoryChanged =
        untrackedEnumeration === null ||
        untrackedIgnored === null ||
        !inventoryIsComplete(untrackedEnumeration) ||
        !inventoryIsComplete(untrackedIgnored) ||
        !inventoryIsComplete(finalEnumeration) ||
        !inventoryIsComplete(finalIgnored) ||
        initialPaths.length !== finalIgnored.paths.length ||
        initialPaths.some((entry, index) => entry !== finalIgnored.paths[index]);
      const finalTrackedPaths = new Set(metadata.trackedPaths);
      lateRelevantUntracked = finalIgnored.paths.some((entry) => !finalTrackedPaths.has(entry));
      const finalConfiguration = await resolveAgentContextConfiguration(selection.root);
      const configurationStable =
        finalConfiguration.ok &&
        configurationFingerprint(finalConfiguration) === initialConfigurationFingerprint;
      const [repositoryStable, untrackedRepositoryStable] = await Promise.all([
        createReadOnlyRepository(selection, repositoryOptions).then((fresh) =>
          repositoryReadsStillMatch(initialRepository.ledger, fresh),
        ),
        untrackedRepository === null
          ? Promise.resolve(false)
          : createReadOnlyRepository(selection, repositoryOptions).then((fresh) =>
              repositoryReadsStillMatch(untrackedRepository.ledger, fresh),
            ),
      ]);
      relevantInventoryChanged ||=
        !configurationStable || !repositoryStable || !untrackedRepositoryStable;
      if (!relevantInventoryChanged) {
        metadata = await stableChangedMetadata(changedState, command);
        const postGitConfiguration = await resolveAgentContextConfiguration(selection.root);
        const postGitConfigurationStable =
          postGitConfiguration.ok &&
          configurationFingerprint(postGitConfiguration) === initialConfigurationFingerprint;
        const [postGitRepositoryStable, postGitUntrackedRepositoryStable] = await Promise.all([
          createReadOnlyRepository(selection, repositoryOptions).then((fresh) =>
            repositoryReadsStillMatch(initialRepository.ledger, fresh),
          ),
          untrackedRepository === null
            ? Promise.resolve(false)
            : createReadOnlyRepository(selection, repositoryOptions).then((fresh) =>
                repositoryReadsStillMatch(untrackedRepository.ledger, fresh),
              ),
        ]);
        relevantInventoryChanged ||=
          !postGitConfigurationStable ||
          !postGitRepositoryStable ||
          !postGitUntrackedRepositoryStable;
      }
    }
    if (relevantInventoryChanged)
      metadata = forceGitChangedFileMetadataFallback(
        changedState.scope,
        metadata,
        lateRelevantUntracked ? "untracked-files" : "repository-changed",
      );
    else if (hasRelevantUntracked)
      metadata = forceGitChangedFileMetadataFallback(
        changedState.scope,
        metadata,
        "untracked-files",
      );
    try {
      const evidence = createChangedFileModeEvidenceAuthority(
        changedState.scope,
        changedState.selection,
        configuration,
        planningDiscovery,
        prepared.contexts,
        scheduled,
        changedTargets.complete,
      );
      changedResult = planChangedFileMode({
        contractVersion: CHANGED_FILE_MODE_CONTRACT_VERSION,
        evidence,
        metadata,
        recordKind: CHANGED_FILE_MODE_INPUT_KIND,
        scope: changedState.scope,
      });
    } catch (error) {
      // The complete result remains authoritative when issued evidence cannot prove a safe subset.
      // This path is deliberately non-reflective and cannot weaken configuration/parser findings.
      options.reportError?.(error);
      changedResult = planChangedFileMode(null as never);
    }
    if (changedResult.mode === "full")
      await command.writeStderr(
        `agent-context-lint: changed-file mode used the full scan (${changedResult.reason ?? "invalid-input"}).\n`,
      );
    options.observeChangedFileMode?.(changedResult);
  }
  const renderedBundle = selectedDiagnosticBundle(scheduled.bundle, changedResult);
  const includedDiagnosticIds =
    changedResult?.mode === "changed" ? new Set(changedResult.includedDiagnosticIds) : null;
  // Dependency-expanded paths remain visible, but changed mode must never preview a mutation to
  // an unchanged dependency. Fix authority is deliberately narrower than diagnostic authority.
  const changedWritablePaths =
    changedResult?.mode === "changed" ? new Set(changedResult.changedPaths) : null;
  const fixPreview = command.fixDryRun
    ? await (async (): Promise<SafeFixPreview> => {
        const evaluated = evaluateSyntaxStructureRules(syntaxRuleInput(parsed));
        if (!evaluated.ok) throw new Error("complete fix evaluation failed");
        const finalized = finalizeSyntaxSuppressions(evaluated);
        if (!finalized.ok) throw new Error("complete fix suppression matching failed");
        const planned = planApprovedMechanicalFixes(finalized);
        if (!planned.ok) throw new Error("approved mechanical fix planning failed");
        const explicitlySuppressedAcl109 = new Set(
          scheduled.visibleDiagnostics
            .filter(
              (diagnostic) =>
                diagnostic.ruleId === "ACL109" &&
                scheduled.bundle.suppressions.some(
                  (suppression) =>
                    suppression.directive.sourceId === diagnostic.primary.sourceId &&
                    suppression.directive.range.end.line + 1 ===
                      diagnostic.primary.range.start.line &&
                    suppression.targetRuleIds.includes("ACL109"),
                ),
            )
            .map((diagnostic) => diagnostic.id),
        );
        const visibleAcl109 = new Set<string>(
          scheduled.visibleDiagnostics
            .filter(
              (diagnostic) =>
                diagnostic.ruleId === "ACL109" &&
                !explicitlySuppressedAcl109.has(diagnostic.id) &&
                (includedDiagnosticIds === null || includedDiagnosticIds.has(diagnostic.id)) &&
                (changedWritablePaths === null ||
                  changedWritablePaths.has(diagnostic.primary.path)),
            )
            .map((diagnostic) => diagnostic.id),
        );
        const authorizedCandidates = planned.candidates.filter((candidate) =>
          visibleAcl109.has(candidate.diagnosticId),
        );
        const identitiesByPath = new Map(
          parsed.sourceIdentities.map((entry) => [entry.path, entry.identity] as const),
        );
        const sourceSnapshots = planned.sources.map((source) => {
          const identity = identitiesByPath.get(source.path);
          if (identity === undefined) throw new Error("fix source identity is unavailable");
          return Object.freeze({ identity, source });
        });
        const pipeline = await createSafeFixPipeline(selection, {
          maximumBytes: configuration.value.limits.maxFileBytes,
          signal: command.signal,
        });
        return pipeline.preview({
          bundle: planned.bundle,
          candidates: authorizedCandidates,
          selectedPlanIds: authorizedCandidates.map((candidate) => candidate.planId),
          sources: sourceSnapshots,
        });
      })()
    : null;
  const usedProfiles = new Set(
    renderedBundle.diagnostics.flatMap((diagnostic) => [
      ...diagnostic.fingerprintBasis.path.profileIds,
      ...diagnostic.fingerprintBasis.semantic.profileIds,
    ]),
  );
  const versions = aggregateProfileVersions(prepared.contexts, usedProfiles);
  const threshold = command.failureThreshold ?? "error";
  const shouldFail = selectedPolicyFailure(changedResult, scheduled, threshold);
  if (command.format === "json") {
    const rendered = await writeJsonDiagnostics(
      renderedBundle,
      scheduled.sources,
      {
        chunkBytes: Math.floor(CLI_LIMITS.maximumOutputChunkBytes / 2),
        failureThreshold: threshold,
        profileVersions: versions,
      },
      { write: (text): Promise<void> => command.writeStdout(text) },
      command.signal,
    );
    if (!rendered.ok)
      throw new Error(`diagnostic formatting failed: ${JSON.stringify(rendered.issues)}`);
    return shouldFail ? "policy-failure" : "success";
  }
  const rendered =
    command.format === "sarif"
      ? formatSarifDiagnostics(renderedBundle, scheduled.sources, {
          informationUri: "https://github.com/area-automation/agent-context-linter",
          profileVersions: versions,
          ruleDocumentationBaseUri:
            "https://github.com/area-automation/agent-context-linter/blob/main/",
          toolVersion: SCAN_CLI_VERSION,
        })
      : formatStylishDiagnostics(renderedBundle, scheduled.sources, {
          color: "never",
          failureThreshold: threshold,
        });
  if (!rendered.ok)
    throw new Error(`diagnostic formatting failed: ${JSON.stringify(rendered.issues)}`);
  const output = fixPreview === null ? rendered.text : `${rendered.text}${fixPreview.patch}`;
  await writeBoundedScanOutput(command.writeStdout, output);
  return shouldFail ? "policy-failure" : "success";
}

export function createScanCommandHandlers(options: ScanOptions): CliCommandHandlers {
  const snapshot: ScanOptions = Object.freeze({
    ...(options.createGitMetadataExecutor === undefined
      ? {}
      : { createGitMetadataExecutor: options.createGitMetadataExecutor }),
    environment: options.environment,
    now: options.now,
    ...(options.observeChangedFileMode === undefined
      ? {}
      : { observeChangedFileMode: options.observeChangedFileMode }),
    ...(options.observeActivationRules === undefined
      ? {}
      : { observeActivationRules: options.observeActivationRules }),
    ...(options.observeEfficiencyReport === undefined
      ? {}
      : { observeEfficiencyReport: options.observeEfficiencyReport }),
    ...(options.observeEfficiencyScenarios === undefined
      ? {}
      : { observeEfficiencyScenarios: options.observeEfficiencyScenarios }),
    ...(options.observeMetricProfiles === undefined
      ? {}
      : { observeMetricProfiles: options.observeMetricProfiles }),
    ...(options.observePortabilityFormatObservations === undefined
      ? {}
      : {
          observePortabilityFormatObservations: options.observePortabilityFormatObservations,
        }),
    ...(options.observeParsed === undefined ? {} : { observeParsed: options.observeParsed }),
    ...(options.reportError === undefined ? {} : { reportError: options.reportError }),
    ...(options.observeSampling === undefined ? {} : { observeSampling: options.observeSampling }),
    workingDirectory: path.resolve(options.workingDirectory),
  });
  const handler: CliCommandHandler = async (command) => {
    try {
      return { status: await scan(command, snapshot) };
    } catch (error) {
      snapshot.reportError?.(error);
      await command.writeStderr("agent-context-lint: unable to scan repository.\n");
      return { status: "operational-failure" };
    }
  };
  return Object.freeze({ scan: handler });
}
