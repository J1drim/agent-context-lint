import { createHash } from "node:crypto";

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
import { extractMarkdownContent } from "../packages/markdown/src/index.js";
import {
  formatJsonDiagnostics,
  formatSarifDiagnostics,
  formatStylishDiagnostics,
} from "../packages/formatters/src/index.js";
import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveEffectiveContext,
} from "../packages/resolver/dist/index.js";
import type {
  ClaudeCodeProfileResolution,
  CodexCliAgentsResolution,
  EffectiveContextResolution,
} from "../packages/resolver/dist/index.js";
import { evaluateConflictsDuplicationRules } from "../packages/rules/dist/index.js";
import { describe, expect, test } from "vitest";

const encoder = new TextEncoder();

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function effective(
  profile: CodexCliAgentsResolution | ClaudeCodeProfileResolution,
): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution: profile,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: path("pkg/main.ts"),
  });
}

function codex(): CodexCliAgentsResolution {
  return resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: [
        {
          bytes: encoder.encode(
            [
              "- Always use pnpm.",
              "- Run make verify.",
              "- Use prettier to format source files.",
              "- Always run pnpm tests before submitting changes.",
              "- Run pnpm lint.",
              "",
            ].join("\n"),
          ),
          errorCode: null,
          kind: "file",
          path: path("AGENTS.md"),
          resolvedTarget: null,
        },
        {
          bytes: encoder.encode(
            [
              "- Always use npm.",
              "- Do not run make verify.",
              "- Use biome to format source files.",
              "- Always run pnpm tests before submitting any changes.",
              "- Run pnpm lint.",
              "",
            ].join("\n"),
          ),
          errorCode: null,
          kind: "file",
          path: path("pkg/AGENTS.md"),
          resolvedTarget: null,
        },
      ],
      reason: "complete integration snapshot",
      rootMarkerPaths: [path(".git")],
    },
    externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("pkg"),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath: path("pkg/main.ts"),
  });
}

function claude(): ClaudeCodeProfileResolution {
  return resolveClaudeCodeProfile({
    candidates: [
      {
        absolutePath: "/repo/CLAUDE.md",
        bytes: encoder.encode("- Always use npm.\n"),
        importGraph: null,
        kind: "memory-shared",
        origin: "repository",
        path: path("CLAUDE.md"),
        scopeRoot: path("."),
        symlinkState: "none",
      },
    ],
    launchCwd: path("pkg"),
    repositoryRoot: path("."),
    runtime: {
      additionalDirectoryInstructions: "disabled",
      clientVersion: "2.1.217",
      eventTrace: [{ id: "event:f08-integration", kind: "launch", path: path("pkg") }],
      exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
      externalContext: "supplied",
      mode: "normal",
      settingSources: { state: "known", values: ["project"] },
    },
  });
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
    throw new Error("missing synthetic Claude candidate");
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
    id: `statement:claude-integration:${String(index)}` as InstructionStatementId,
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

function checked(value: InstructionIr): InstructionIr {
  const result = validateInstructionIr(value);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
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

describe("F08 packaged conflicts/duplication formatter integration", () => {
  test("renders ACL250-ACL255 through stylish, JSON, and SARIF deterministically", () => {
    const codexProfile = codex();
    const claudeProfile = claude();
    const ir = combine(codexIr(codexProfile), claudeIr(claudeProfile));
    const result = evaluateConflictsDuplicationRules({
      contexts: [effective(codexProfile), effective(claudeProfile)],
      contractVersion: "0.1.0",
      ir,
      recordKind: "agent-context-conflicts-duplication-rule-input",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(new Set(result.bundle.diagnostics.map((entry) => entry.ruleId))).toEqual(
      new Set(["ACL250", "ACL251", "ACL252", "ACL253", "ACL254", "ACL255"]),
    );

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
    expect(stylish.ok).toBe(true);
    expect(json.ok).toBe(true);
    expect(sarif.ok).toBe(true);
    const outputs = [
      stylish.ok ? stylish.text : "",
      json.ok ? json.text : "",
      sarif.ok ? sarif.text : "",
    ];
    for (const ruleId of ["ACL250", "ACL251", "ACL252", "ACL253", "ACL254", "ACL255"])
      for (const output of outputs) expect(output).toContain(ruleId);
    expect(formatStylishDiagnostics(result.bundle, result.sources, { color: "never" })).toEqual(
      stylish,
    );
    expect(formatJsonDiagnostics(result.bundle, result.sources, formatterOptions)).toEqual(json);
  });
});
