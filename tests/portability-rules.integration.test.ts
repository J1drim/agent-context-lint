import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  validateInstructionIr,
} from "../packages/core/dist/index.js";
import type {
  InstructionDocument,
  InstructionIr,
  InstructionStatement,
  InstructionStatementId,
  RepositoryRelativePath,
  SourceDocument,
} from "../packages/core/dist/index.js";
import {
  formatJsonDiagnostics,
  formatSarifDiagnostics,
  formatStylishDiagnostics,
} from "../packages/formatters/src/index.js";
import { extractMarkdownContent } from "../packages/markdown/src/index.js";
import {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  compareEffectiveContexts,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveEffectiveContext,
} from "../packages/resolver/dist/index.js";
import type {
  ClaudeCodeProfileResolution,
  CodexCliAgentsResolution,
  EffectiveContextResolution,
} from "../packages/resolver/dist/index.js";
import {
  PORTABILITY_RULE_CONTRACT_VERSION,
  RULE_REGISTRY,
  evaluatePortabilityRules,
} from "../packages/rules/dist/index.js";
import { describe, expect, test } from "vitest";

const encoder = new TextEncoder();

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function codex(): CodexCliAgentsResolution {
  return resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: [
        {
          bytes: encoder.encode("- Use pnpm.\n"),
          errorCode: null,
          kind: "file",
          path: path("AGENTS.md"),
          resolvedTarget: null,
        },
      ],
      reason: "complete F12 integration snapshot",
      rootMarkerPaths: [path(".git")],
    },
    externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("src"),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath: path("src/main.ts"),
  });
}

function claude(): ClaudeCodeProfileResolution {
  return resolveClaudeCodeProfile({
    candidates: [
      {
        absolutePath: "/repo/CLAUDE.md",
        bytes: encoder.encode("- Use npm.\n- Run tests with pnpm.\n"),
        importGraph: null,
        kind: "memory-shared",
        origin: "repository",
        path: path("CLAUDE.md"),
        scopeRoot: path("."),
        symlinkState: "none",
      },
    ],
    launchCwd: path("src"),
    repositoryRoot: path("."),
    runtime: {
      additionalDirectoryInstructions: "disabled",
      clientVersion: "2.1.217",
      eventTrace: [{ id: "event:f12-integration", kind: "launch", path: path("src") }],
      exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
      externalContext: "supplied",
      mode: "normal",
      settingSources: { state: "known", values: ["project"] },
    },
  });
}

function effective(
  profile: CodexCliAgentsResolution | ClaudeCodeProfileResolution,
): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution: profile,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: path("src/main.ts"),
  });
}

function checked(value: InstructionIr): InstructionIr {
  const result = validateInstructionIr(value);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codexIr(profile: CodexCliAgentsResolution): InstructionIr {
  const syntax = profile.contributions.flatMap((entry) =>
    entry.syntax === null ? [] : [entry.syntax],
  );
  return checked({
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: syntax.map((entry) => entry.document),
    events: [],
    imports: [],
    nodes: syntax.flatMap((entry) => entry.nodes),
    recordKind: "agent-context-instruction-ir",
    sources: syntax.map((entry) => entry.source),
    statements: syntax.flatMap((entry) => entry.statements),
    targets: [],
  });
}

function claudeIr(profile: ClaudeCodeProfileResolution): InstructionIr {
  const candidate = profile.candidates[0];
  if (candidate?.syntax.text === null || candidate === undefined)
    throw new Error("missing F12 Claude fixture candidate");
  const text = candidate.syntax.text;
  const extracted = extractMarkdownContent({ sourceId: candidate.syntax.sourceId, text });
  const source: SourceDocument = {
    bom: "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: candidate.syntax.sourceId,
    lineEnding: "lf",
    parseState: extracted.parseState,
    path: candidate.path,
    rootNodeId: extracted.rootNodeId,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    text,
    utf16Length: text.length,
  };
  const statements = extracted.statements.map((entry, index): InstructionStatement => ({
    classification: { state: "unclassified" },
    documentId: candidate.syntax.documentId,
    id: `statement:f12-integration:${String(index)}` as InstructionStatementId,
    nodeIds: [entry.nodeId],
    range: entry.range,
    text: entry.original,
  }));
  const document: InstructionDocument = {
    activationRuleIds: [],
    formatId: "claude-memory-markdown",
    id: candidate.syntax.documentId,
    importIds: [],
    rootNodeId: extracted.rootNodeId,
    scopeRoot: path("."),
    sourceId: source.id,
    statementIds: statements.map((entry) => entry.id),
  };
  return checked({
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: [document],
    events: [],
    imports: [],
    nodes: extracted.nodes,
    recordKind: "agent-context-instruction-ir",
    sources: [source],
    statements,
    targets: [],
  });
}

function combine(left: InstructionIr, right: InstructionIr): InstructionIr {
  return checked({
    activationRules: [...left.activationRules, ...right.activationRules],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: [...left.documents, ...right.documents],
    events: [...left.events, ...right.events],
    imports: [...left.imports, ...right.imports],
    nodes: [...left.nodes, ...right.nodes],
    recordKind: "agent-context-instruction-ir",
    sources: [...left.sources, ...right.sources],
    statements: [...left.statements, ...right.statements],
    targets: [...left.targets, ...right.targets],
  });
}

describe("F12 packaged portability formatter integration", () => {
  test("composes issued profiles, E07 comparison, rules, registry, and all formatters", () => {
    const codexProfile = codex();
    const claudeProfile = claude();
    const codexContext = effective(codexProfile);
    const claudeContext = effective(claudeProfile);
    const comparison = compareEffectiveContexts({
      contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
      recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
      resolutions: [codexContext, claudeContext],
    });
    const ir = combine(codexIr(codexProfile), claudeIr(claudeProfile));
    const shared = ir.documents.find((entry) => entry.formatId === "agents-markdown");
    const vendor = ir.documents.find((entry) => entry.formatId === "claude-memory-markdown");
    const importStatement =
      vendor === undefined
        ? undefined
        : ir.statements.find(
            (entry) => entry.documentId === vendor.id && entry.text.includes("Run tests"),
          );
    if (shared === undefined || vendor === undefined || importStatement === undefined)
      throw new Error("incomplete F12 integration IR");
    const result = evaluatePortabilityRules({
      behaviorObservations: [
        {
          behaviorId: "f12-import",
          documentId: vendor.id,
          kind: "import",
          profileId: "claude-code",
          state: "supported",
          statementId: importStatement.id,
          surfaceId: "claude-code/local-session",
        },
        {
          behaviorId: "f12-import",
          documentId: vendor.id,
          kind: "import",
          profileId: "codex-cli",
          state: "unsupported",
          statementId: importStatement.id,
          surfaceId: "codex-cli/local-cli-single-cwd",
        },
      ],
      comparisons: [comparison],
      contractVersion: PORTABILITY_RULE_CONTRACT_VERSION,
      formatInventoryState: "complete",
      formatObservations: [
        {
          documentId: shared.id,
          profileId: "codex-cli",
          state: "supported",
          surfaceId: "codex-cli/local-cli-single-cwd",
        },
        {
          documentId: shared.id,
          profileId: "claude-code",
          state: "recognized",
          surfaceId: "claude-code/local-session",
        },
        {
          documentId: vendor.id,
          profileId: "claude-code",
          state: "supported",
          surfaceId: "claude-code/local-session",
        },
        {
          documentId: vendor.id,
          profileId: "codex-cli",
          state: "unsupported",
          surfaceId: "codex-cli/local-cli-single-cwd",
        },
      ],
      ir,
      recordKind: "agent-context-portability-rule-input",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.ok).toBe(true);

    const projection = {
      contractVersion: result.contractVersion,
      diagnosticRuleIds: [
        ...new Set(result.bundle.diagnostics.map((entry) => entry.ruleId)),
      ].sort(),
      registry: RULE_REGISTRY.rules
        .filter((entry) => entry.id.startsWith("ACL45"))
        .map((entry) => ({
          id: entry.id,
          precisionStatus: entry.precisionStatus,
        })),
      uncertaintyReasons: [...new Set(result.uncertainties.map((entry) => entry.reason))].sort(),
    };
    const golden = JSON.parse(
      readFileSync(
        new URL("../conformance/fixtures/v0/portability-rules.golden.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    expect(projection).toEqual(golden);

    const stylish = formatStylishDiagnostics(result.bundle, result.sources, { color: "never" });
    const formatterOptions = {
      failureThreshold: "error" as const,
      profileVersions: {
        "claude-code": { clientVersion: "2.1.217", profileVersion: "1.0.0" },
        "codex-cli": { clientVersion: null, profileVersion: "1.0.0" },
      },
    };
    const json = formatJsonDiagnostics(result.bundle, result.sources, formatterOptions);
    const sarif = formatSarifDiagnostics(result.bundle, result.sources, {
      informationUri: "https://example.test/agent-context-lint",
      profileVersions: formatterOptions.profileVersions,
      ruleDocumentationBaseUri: "https://example.test/agent-context-lint/",
      toolVersion: "1.0.0",
    });
    if (!json.ok) throw new Error(JSON.stringify(json.issues));
    if (!sarif.ok) throw new Error(JSON.stringify(sarif.issues));
    expect(stylish.ok).toBe(true);
    expect(json.ok).toBe(true);
    expect(sarif.ok).toBe(true);
    for (const output of [stylish.ok ? stylish.text : "", json.text, sarif.text])
      for (const ruleId of projection.diagnosticRuleIds) expect(output).toContain(ruleId);
    expect(formatJsonDiagnostics(result.bundle, result.sources, formatterOptions)).toEqual(json);
  });
});
