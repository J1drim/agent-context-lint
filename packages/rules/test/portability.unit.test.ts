import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import type {
  AstNode,
  AstNodeId,
  InstructionDocument,
  InstructionDocumentId,
  InstructionIr,
  InstructionStatement,
  InstructionStatementId,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
} from "@agent-context/core";
import {
  CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
  CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  compareEffectiveContexts,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveCursorProfile,
  resolveEffectiveContext,
} from "@agent-context/resolver";
import type {
  CrossProfileComparison,
  CursorRuleCandidateSnapshot,
  EffectiveContextProfileResolution,
  EffectiveContextResolution,
} from "@agent-context/resolver";
import { describe, expect, test } from "vitest";

import {
  PORTABILITY_RULE_CONTRACT_VERSION,
  evaluatePortabilityRules,
  finalizePortabilitySuppressions,
} from "../src/index.js";
import type {
  PortabilityBehaviorObservation,
  PortabilityFormatObservation,
  PortabilityRuleInput,
  PortabilityRuleResult,
} from "../src/index.js";

const encoder = new TextEncoder();

interface SimpleFile {
  readonly formatId: string;
  readonly path: string;
  readonly text: string;
}

interface PortabilityPrecisionCase {
  readonly behaviorKind: PortabilityBehaviorObservation["kind"] | null;
  readonly expectedRuleIds: readonly string[];
  readonly formatInventoryState: PortabilityRuleInput["formatInventoryState"];
  readonly id: string;
  readonly otherBehaviorState: PortabilityBehaviorObservation["state"] | null;
  readonly otherFormatState: PortabilityFormatObservation["state"];
  readonly sharedText: string;
  readonly vendorText: string;
}

interface PortabilityPrecisionCorpus {
  readonly cases: readonly PortabilityPrecisionCase[];
  readonly contractVersion: "0.1.0";
  readonly recordKind: "agent-context-portability-precision-corpus";
}

const precisionCorpus = JSON.parse(
  readFileSync(new URL("./fixtures/portability-precision.v0.json", import.meta.url), "utf8"),
) as PortabilityPrecisionCorpus;

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function idFor(kind: "document" | "source" | "statement", filePath: string, line = 0): string {
  return `${kind}:f12:${hash(`${filePath}:${String(line)}`).slice(0, 32)}`;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required synthetic value is missing");
  return value;
}

function simpleIr(files: readonly SimpleFile[]): InstructionIr {
  const sources: SourceDocument[] = [];
  const documents: InstructionDocument[] = [];
  const nodes: AstNode[] = [];
  const statements: InstructionStatement[] = [];
  for (const file of files) {
    const sourceId = idFor("source", file.path) as SourceDocumentId;
    const documentId = idFor("document", file.path) as InstructionDocumentId;
    const rootNodeId = `ast:f12:${hash(`${file.path}:root`).slice(0, 32)}` as AstNodeId;
    const lines = file.text.endsWith("\n")
      ? file.text.slice(0, -1).split("\n")
      : file.text.split("\n");
    const childIds: AstNodeId[] = [];
    let offset = 0;
    for (const [line, text] of lines.entries()) {
      const nodeId = `ast:f12:${hash(`${file.path}:${String(line)}`).slice(0, 32)}` as AstNodeId;
      const statementId = idFor("statement", file.path, line) as InstructionStatementId;
      const range = {
        end: {
          byteOffset: offset + Buffer.byteLength(text, "utf8"),
          line,
          utf16Column: text.length,
          utf16Offset: offset + text.length,
        },
        sourceId,
        start: { byteOffset: offset, line, utf16Column: 0, utf16Offset: offset },
      };
      childIds.push(nodeId);
      const comment = text.startsWith("<!--") && text.endsWith("-->");
      nodes.push({
        childIds: [],
        id: nodeId,
        kind: comment ? "html-comment" : "paragraph",
        range,
        sourceId,
      });
      if (!comment)
        statements.push({
          classification: { state: "unclassified" },
          documentId,
          id: statementId,
          nodeIds: [nodeId],
          range,
          text,
        });
      offset += text.length + 1;
    }
    const endLine = Math.max(0, lines.length - 1);
    const endText = required(lines.at(-1));
    const rootRange = {
      end: {
        byteOffset: Buffer.byteLength(file.text, "utf8"),
        line: file.text.endsWith("\n") ? endLine + 1 : endLine,
        utf16Column: file.text.endsWith("\n") ? 0 : endText.length,
        utf16Offset: file.text.length,
      },
      sourceId,
      start: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
    };
    nodes.push({ childIds, id: rootNodeId, kind: "root", range: rootRange, sourceId });
    const documentStatements = statements.filter((entry) => entry.documentId === documentId);
    documents.push({
      activationRuleIds: [],
      formatId: file.formatId,
      id: documentId,
      importIds: [],
      rootNodeId,
      scopeRoot: path("."),
      sourceId,
      statementIds: documentStatements.map((entry) => entry.id),
    });
    sources.push({
      bom: "none",
      byteLength: Buffer.byteLength(file.text, "utf8"),
      encoding: "utf-8",
      id: sourceId,
      lineEnding: file.text.includes("\n") ? "lf" : "none",
      parseState: { state: "complete" },
      path: path(file.path),
      rootNodeId,
      sha256: hash(file.text),
      text: file.text,
      utf16Length: file.text.length,
    });
  }
  const validation = validateInstructionIr({
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents,
    events: [],
    imports: [],
    nodes,
    recordKind: "agent-context-instruction-ir",
    sources,
    statements,
    targets: [],
  });
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
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

function codex(text: string): EffectiveContextResolution {
  return effective(
    resolveCodexCliAgents({
      discovery: {
        certainty: "known",
        entries: [
          {
            bytes: encoder.encode(text),
            errorCode: null,
            kind: "file",
            path: path("AGENTS.md"),
            resolvedTarget: null,
          },
        ],
        reason: "complete F12 synthetic snapshot",
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
    }),
  );
}

function claude(text: string, clientVersion = "2.1.33"): EffectiveContextResolution {
  return effective(
    resolveClaudeCodeProfile({
      candidates: [
        {
          absolutePath: "/repo/CLAUDE.md",
          bytes: encoder.encode(text),
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
        clientVersion,
        eventTrace: [{ id: "launch", kind: "launch", path: path(".") }],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "supplied",
        mode: "normal",
        settingSources: { state: "known", values: [] },
      },
    }),
  );
}

function cursor(
  surfaceId: "cursor-agent/cli" | "cursor-agent/ide",
  include: boolean,
): EffectiveContextResolution {
  const candidate: CursorRuleCandidateSnapshot = {
    bytes: encoder.encode("---\nalwaysApply: true\n---\nUse editor diagnostics.\n"),
    format: "mdc",
    path: path(".cursor/rules/editor.mdc"),
  };
  return effective(
    resolveCursorProfile({
      candidates: include ? [candidate] : [],
      runtime: {
        clientVersion: surfaceId === "cursor-agent/cli" ? "2026.05.24-dda726e" : "3.12.30",
        eventState: "present",
        events: [{ kind: "reference-path", sequence: 1, targetPath: path("src/main.ts") }],
        externalContext: "absent",
        projectRules: "enabled",
        surfaceId,
        workspaceRoots: [path(".")],
      },
    }),
  );
}

function compare(values: readonly EffectiveContextResolution[]): CrossProfileComparison {
  return compareEffectiveContexts({
    contractVersion: CROSS_PROFILE_COMPARISON_CONTRACT_VERSION,
    recordKind: CROSS_PROFILE_COMPARISON_INPUT_RECORD_KIND,
    resolutions: values,
  });
}

function formatObservation(
  documentId: string,
  profileId: string,
  surfaceId: string,
  state: PortabilityFormatObservation["state"],
): PortabilityFormatObservation {
  return {
    documentId,
    profileId,
    state,
    surfaceId,
  };
}

function behaviorObservation(
  behaviorId: string,
  documentId: string,
  statementId: string,
  profileId: string,
  surfaceId: string,
  kind: PortabilityBehaviorObservation["kind"],
  state: PortabilityBehaviorObservation["state"],
): PortabilityBehaviorObservation {
  return {
    behaviorId,
    documentId,
    kind,
    profileId,
    state,
    statementId,
    surfaceId,
  };
}

function evaluate(
  input: PortabilityRuleInput,
): Extract<PortabilityRuleResult, { readonly ok: true }> {
  const result = evaluatePortabilityRules(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(validateDiagnosticBundle(result.bundle, input.ir.sources).ok).toBe(true);
  return result;
}

function crossAgentFixture(inventory: "complete" | "partial" = "complete"): PortabilityRuleInput {
  const ir = simpleIr([
    { formatId: "agents-markdown", path: "AGENTS.md", text: "Use pnpm.\n" },
    {
      formatId: "claude-memory-markdown",
      path: "CLAUDE.md",
      text: "Use npm.\nRun tests with pnpm.\n",
    },
  ]);
  const comparison = compare([codex("Use pnpm.\n"), claude("Use npm.\nRun tests with pnpm.\n")]);
  const shared = idFor("document", "AGENTS.md");
  const vendor = idFor("document", "CLAUDE.md");
  return {
    behaviorObservations: [
      behaviorObservation(
        "claude-import",
        vendor,
        idFor("statement", "CLAUDE.md", 1),
        "claude-code",
        "claude-code/local-session",
        "import",
        "supported",
      ),
      behaviorObservation(
        "claude-import",
        vendor,
        idFor("statement", "CLAUDE.md", 1),
        "codex-cli",
        "codex-cli/local-cli-single-cwd",
        "import",
        "unsupported",
      ),
    ],
    comparisons: [comparison],
    contractVersion: PORTABILITY_RULE_CONTRACT_VERSION,
    formatInventoryState: inventory,
    formatObservations: [
      formatObservation(shared, "claude-code", "claude-code/local-session", "recognized"),
      formatObservation(shared, "codex-cli", "codex-cli/local-cli-single-cwd", "supported"),
      formatObservation(vendor, "claude-code", "claude-code/local-session", "supported"),
      formatObservation(vendor, "codex-cli", "codex-cli/local-cli-single-cwd", "unsupported"),
    ],
    ir,
    recordKind: "agent-context-portability-rule-input",
  };
}

function precisionInput(entry: PortabilityPrecisionCase): PortabilityRuleInput {
  const sharedText = `${entry.sharedText}\n`;
  const vendorText = `${entry.vendorText}\n`;
  const ir = simpleIr([
    { formatId: "agents-markdown", path: "AGENTS.md", text: sharedText },
    { formatId: "claude-memory-markdown", path: "CLAUDE.md", text: vendorText },
  ]);
  const shared = idFor("document", "AGENTS.md");
  const vendor = idFor("document", "CLAUDE.md");
  const behaviors =
    entry.behaviorKind === null || entry.otherBehaviorState === null
      ? []
      : [
          behaviorObservation(
            `${entry.id}-behavior`,
            vendor,
            idFor("statement", "CLAUDE.md"),
            "claude-code",
            "claude-code/local-session",
            entry.behaviorKind,
            "supported",
          ),
          behaviorObservation(
            `${entry.id}-behavior`,
            vendor,
            idFor("statement", "CLAUDE.md"),
            "codex-cli",
            "codex-cli/local-cli-single-cwd",
            entry.behaviorKind,
            entry.otherBehaviorState,
          ),
        ];
  return {
    behaviorObservations: behaviors,
    comparisons: [compare([codex(sharedText), claude(vendorText)])],
    contractVersion: PORTABILITY_RULE_CONTRACT_VERSION,
    formatInventoryState: entry.formatInventoryState,
    formatObservations: [
      formatObservation(shared, "claude-code", "claude-code/local-session", "recognized"),
      formatObservation(shared, "codex-cli", "codex-cli/local-cli-single-cwd", "supported"),
      formatObservation(vendor, "claude-code", "claude-code/local-session", "supported"),
      formatObservation(
        vendor,
        "codex-cli",
        "codex-cli/local-cli-single-cwd",
        entry.otherFormatState,
      ),
    ],
    ir,
    recordKind: "agent-context-portability-rule-input",
  };
}

describe("F12 portability rules", () => {
  test("keeps the versioned portability precision corpus stable", () => {
    expect(precisionCorpus).toMatchObject({
      contractVersion: "0.1.0",
      recordKind: "agent-context-portability-precision-corpus",
    });
    expect(precisionCorpus.cases).toHaveLength(16);
    for (const entry of precisionCorpus.cases) {
      const input = precisionInput(entry);
      const evaluated = evaluatePortabilityRules(input);
      if (!evaluated.ok) throw new Error(`${entry.id}: ${JSON.stringify(evaluated.issues)}`);
      expect(evaluated.ok, entry.id).toBe(true);
      expect(validateDiagnosticBundle(evaluated.bundle, input.ir.sources).ok, entry.id).toBe(true);
      const result = evaluated;
      const actual = [
        ...new Set(result.bundle.diagnostics.map((diagnostic) => diagnostic.ruleId)),
      ].sort();
      expect(actual, entry.id).toEqual([...entry.expectedRuleIds].sort());
    }
  });

  test("emits vendor-only, cross-format drift, and unsupported-composition diagnostics", () => {
    const input = crossAgentFixture();
    const result = evaluate(input);
    expect(new Set(result.bundle.diagnostics.map((entry) => entry.ruleId))).toEqual(
      new Set(["ACL450", "ACL451", "ACL452"]),
    );
    expect(result.bundle.diagnostics.every((entry) => !entry.message.includes("npm"))).toBe(true);
    expect(result.bundle.diagnostics.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(evaluate(input)).toEqual(result);
  });

  test("does not claim a missing shared equivalent from a partial inventory", () => {
    const result = evaluate(crossAgentFixture("partial"));
    expect(result.bundle.diagnostics.some((entry) => entry.ruleId === "ACL450")).toBe(false);
    expect(result.uncertainties.some((entry) => entry.reason === "format-inventory-partial")).toBe(
      true,
    );
  });

  test("does not flag a vendor copy when a high-confidence shared equivalent exists", () => {
    const input = crossAgentFixture();
    const ir = simpleIr([
      { formatId: "agents-markdown", path: "AGENTS.md", text: "Use npm.\n" },
      { formatId: "claude-memory-markdown", path: "CLAUDE.md", text: "Use npm.\n" },
    ]);
    const result = evaluate({ ...input, behaviorObservations: [], ir });
    expect(result.bundle.diagnostics.map((entry) => entry.ruleId)).toEqual([]);
  });

  test("emits editor-only behavior only when a non-editor surface is explicitly unsupported", () => {
    const ir = simpleIr([
      {
        formatId: "cursor-mdc",
        path: ".cursor/rules/editor.mdc",
        text: "Use editor diagnostics.\n",
      },
    ]);
    const comparison = compare([
      cursor("cursor-agent/ide", true),
      cursor("cursor-agent/cli", false),
    ]);
    const documentId = idFor("document", ".cursor/rules/editor.mdc");
    const statementId = idFor("statement", ".cursor/rules/editor.mdc");
    const result = evaluate({
      behaviorObservations: [
        behaviorObservation(
          "editor-diagnostics",
          documentId,
          statementId,
          "cursor-agent",
          "cursor-agent/ide",
          "editor-feature",
          "supported",
        ),
        behaviorObservation(
          "editor-diagnostics",
          documentId,
          statementId,
          "cursor-agent",
          "cursor-agent/cli",
          "editor-feature",
          "unsupported",
        ),
      ],
      comparisons: [comparison],
      contractVersion: PORTABILITY_RULE_CONTRACT_VERSION,
      formatInventoryState: "partial",
      formatObservations: [
        formatObservation(documentId, "cursor-agent", "cursor-agent/ide", "supported"),
        formatObservation(documentId, "cursor-agent", "cursor-agent/cli", "unsupported"),
      ],
      ir,
      recordKind: "agent-context-portability-rule-input",
    });
    expect(result.bundle.diagnostics.map((entry) => entry.ruleId)).toEqual(["ACL453"]);
  });

  test("preserves conditional support as uncertainty instead of unsupported behavior", () => {
    const input = crossAgentFixture();
    const conditional = input.behaviorObservations.map((entry) =>
      entry.profileId === "codex-cli" ? { ...entry, state: "conditional" as const } : entry,
    );
    const result = evaluate({ ...input, behaviorObservations: conditional });
    expect(result.bundle.diagnostics.some((entry) => entry.ruleId === "ACL452")).toBe(false);
    expect(
      result.uncertainties.some((entry) => entry.reason === "behavior-support-indeterminate"),
    ).toBe(true);
  });

  test("treats explicitly unsupported nesting as composition portability evidence", () => {
    const input = crossAgentFixture();
    const nesting = input.behaviorObservations.map((entry) => ({
      ...entry,
      behaviorId: "nested-policy",
      kind: "nesting" as const,
    }));
    const result = evaluate({ ...input, behaviorObservations: nesting });
    expect(result.bundle.diagnostics.some((entry) => entry.ruleId === "ACL452")).toBe(true);
  });

  test("requires issued E07 comparisons and exact selected profile identities", () => {
    const input = crossAgentFixture();
    expect(
      evaluatePortabilityRules({ ...input, comparisons: [{ ...input.comparisons[0] }] }),
    ).toMatchObject({
      issues: [{ code: "invalid-input", path: "$.comparisons" }],
      ok: false,
    });
    expect(
      evaluatePortabilityRules({
        ...input,
        formatObservations: [
          { ...required(input.formatObservations[0]), surfaceId: "codex-cli/not-real" },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  test("rejects hostile records, proxies, sparse arrays, duplicates, and bounded-resource excess", () => {
    const input = crossAgentFixture();
    const getter = Object.defineProperty({}, "recordKind", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute");
      },
    });
    expect(evaluatePortabilityRules(getter)).toMatchObject({ ok: false });
    expect(evaluatePortabilityRules(new Proxy(input, {}))).toMatchObject({ ok: false });
    const sparse = Array(1) as PortabilityRuleInput["comparisons"];
    expect(evaluatePortabilityRules({ ...input, comparisons: sparse })).toMatchObject({
      ok: false,
    });
    expect(
      evaluatePortabilityRules({
        ...input,
        formatObservations: [input.formatObservations[0], input.formatObservations[0]],
      }),
    ).toMatchObject({ ok: false });
    expect(evaluatePortabilityRules(input, { maximumPairWork: 1 })).toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
  });

  test("validates every option without invoking option accessors", () => {
    const input = crossAgentFixture();
    expect(evaluatePortabilityRules(input, null)).toMatchObject({
      issues: [{ code: "invalid-options" }],
      ok: false,
    });
    expect(evaluatePortabilityRules(input, { extra: 1 })).toMatchObject({ ok: false });
    expect(evaluatePortabilityRules(input, { maximumStatements: 0 })).toMatchObject({ ok: false });
    expect(evaluatePortabilityRules(input, { maximumStatements: 1_000_001 })).toMatchObject({
      ok: false,
    });
    const accessor = Object.defineProperty({}, "maximumStatements", {
      enumerable: true,
      get: () => {
        throw new Error("must not run");
      },
    });
    expect(evaluatePortabilityRules(input, accessor)).toMatchObject({ ok: false });
  });

  test("rejects closed-contract drift before evaluating evidence", () => {
    const input = crossAgentFixture();
    expect(evaluatePortabilityRules({})).toMatchObject({ ok: false });
    expect(evaluatePortabilityRules({ ...input, recordKind: "wrong" })).toMatchObject({
      ok: false,
    });
    expect(evaluatePortabilityRules({ ...input, formatInventoryState: "unknown" })).toMatchObject({
      ok: false,
    });
    expect(evaluatePortabilityRules({ ...input, ir: {} })).toMatchObject({ ok: false });
    expect(evaluatePortabilityRules({ ...input, comparisons: [] })).toMatchObject({ ok: false });
    expect(evaluatePortabilityRules({ ...input, comparisons: null })).toMatchObject({ ok: false });
    expect(
      evaluatePortabilityRules({
        ...input,
        comparisons: [input.comparisons[0], input.comparisons[0]],
      }),
    ).toMatchObject({ ok: false });
    const extended = [...input.comparisons] as unknown[] & { extra?: boolean };
    extended.extra = true;
    expect(evaluatePortabilityRules({ ...input, comparisons: extended })).toMatchObject({
      ok: false,
    });
    const replacement = { ...input } as Record<string, unknown>;
    delete replacement["recordKind"];
    replacement["unexpected"] = true;
    expect(evaluatePortabilityRules(replacement)).toMatchObject({ ok: false });
    const accessor = { ...input } as Record<string, unknown>;
    Object.defineProperty(accessor, "recordKind", {
      enumerable: true,
      get: () => {
        throw new Error("must not run");
      },
    });
    expect(evaluatePortabilityRules(accessor)).toMatchObject({ ok: false });
    const indexedAccessor = [...input.comparisons];
    Object.defineProperty(indexedAccessor, "0", {
      enumerable: true,
      get: () => {
        throw new Error("must not run");
      },
    });
    expect(evaluatePortabilityRules({ ...input, comparisons: indexedAccessor })).toMatchObject({
      ok: false,
    });
  });

  test("validates format observations against B03 and exact E07 profile/surface evidence", () => {
    const input = crossAgentFixture();
    const first = required(input.formatObservations[0]);
    expect(
      evaluatePortabilityRules({
        ...input,
        formatObservations: [{ ...first, unexpected: true }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluatePortabilityRules({
        ...input,
        formatObservations: [{ ...first, documentId: "document:f12:not-present" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluatePortabilityRules({
        ...input,
        formatObservations: [{ ...first, profileId: "missing-profile" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluatePortabilityRules({
        ...input,
        formatObservations: [{ ...first, state: "maybe" }],
      }),
    ).toMatchObject({ ok: false });
    expect(evaluatePortabilityRules(input, { maximumFormatObservations: 1 })).toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
  });

  test("validates behavior ownership, identity, state, and aggregate limits", () => {
    const input = crossAgentFixture();
    const first = required(input.behaviorObservations[0]);
    expect(
      evaluatePortabilityRules({
        ...input,
        behaviorObservations: [{ ...first, unexpected: true }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluatePortabilityRules({
        ...input,
        behaviorObservations: [{ ...first, statementId: idFor("statement", "AGENTS.md") }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluatePortabilityRules({
        ...input,
        behaviorObservations: [{ ...first, surfaceId: "claude-code/not-real" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluatePortabilityRules({
        ...input,
        behaviorObservations: [first, first],
      }),
    ).toMatchObject({ ok: false });
    expect(evaluatePortabilityRules(input, { maximumBehaviorObservations: 1 })).toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
  });

  test("enforces statement, text, diagnostic, and uncertainty output ceilings", () => {
    const input = crossAgentFixture();
    expect(evaluatePortabilityRules(input, { maximumStatements: 1 })).toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
    expect(evaluatePortabilityRules(input, { maximumTextLength: 3 })).toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
    expect(evaluatePortabilityRules(input, { maximumDiagnostics: 1 })).toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
    const conditional = input.formatObservations.map((entry) => ({
      ...entry,
      state: "conditional" as const,
    }));
    expect(
      evaluatePortabilityRules(
        { ...input, behaviorObservations: [], formatObservations: conditional },
        { maximumUncertainties: 1 },
      ),
    ).toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
  });

  test("deduplicates repeated issued target evidence and preserves deterministic targets", () => {
    const input = crossAgentFixture();
    const second = compare([codex("Use pnpm.\n"), claude("Use npm.\nRun tests with pnpm.\n")]);
    const result = evaluate({ ...input, comparisons: [...input.comparisons, second] });
    expect(result.bundle.diagnostics).toEqual(evaluate(input).bundle.diagnostics);
    expect(result.metrics.comparisonCount).toBe(2);
  });

  test("merges profile evidence for the same finding without duplicating diagnostics", () => {
    const input = crossAgentFixture();
    const cursorComparison = compare([
      claude("Use npm.\nRun tests with pnpm.\n"),
      cursor("cursor-agent/cli", false),
    ]);
    const vendor = idFor("document", "CLAUDE.md");
    const result = evaluate({
      ...input,
      comparisons: [...input.comparisons, cursorComparison],
      formatObservations: [
        ...input.formatObservations,
        formatObservation(vendor, "cursor-agent", "cursor-agent/cli", "unsupported"),
      ],
    });
    const vendorOnly = result.bundle.diagnostics.filter((entry) => entry.ruleId === "ACL450");
    expect(vendorOnly.length).toBeGreaterThan(0);
    expect(
      vendorOnly.every((entry) => entry.fingerprintBasis.path.profileIds.includes("cursor-agent")),
    ).toBe(true);
  });

  test("rejects mixed client versions for one selected profile/surface", () => {
    const input = crossAgentFixture();
    const secondVersion = compare([codex("Use pnpm.\n"), claude("Use npm.\n", "2.1.34")]);
    expect(
      evaluatePortabilityRules({ ...input, comparisons: [...input.comparisons, secondVersion] }),
    ).toMatchObject({ issues: [{ code: "invalid-input", path: "$.comparisons" }], ok: false });
  });

  test("does not call a non-editor behavior editor-only", () => {
    const input = crossAgentFixture();
    const vendor = idFor("document", "CLAUDE.md");
    const statement = idFor("statement", "CLAUDE.md", 1);
    const result = evaluate({
      ...input,
      behaviorObservations: [
        behaviorObservation(
          "terminal-feature",
          vendor,
          statement,
          "claude-code",
          "claude-code/local-session",
          "editor-feature",
          "supported",
        ),
        behaviorObservation(
          "terminal-feature",
          vendor,
          statement,
          "codex-cli",
          "codex-cli/local-cli-single-cwd",
          "editor-feature",
          "unsupported",
        ),
      ],
    });
    expect(result.bundle.diagnostics.some((entry) => entry.ruleId === "ACL453")).toBe(false);
  });

  test("does not infer shared absence when shared policy is not classifiable", () => {
    const input = crossAgentFixture();
    const ir = simpleIr([
      { formatId: "agents-markdown", path: "AGENTS.md", text: "Be excellent.\n" },
      { formatId: "claude-memory-markdown", path: "CLAUDE.md", text: "Use npm.\n" },
    ]);
    const result = evaluate({ ...input, behaviorObservations: [], ir });
    expect(result.bundle.diagnostics.some((entry) => entry.ruleId === "ACL450")).toBe(false);
    expect(result.uncertainties.some((entry) => entry.reason === "statement-unclassified")).toBe(
      true,
    );
  });

  test("retains vendor and comparison uncertainty without inventing a diagnostic", () => {
    const input = crossAgentFixture();
    const ir = simpleIr([
      { formatId: "agents-markdown", path: "AGENTS.md", text: "Use pnpm.\n" },
      { formatId: "claude-memory-markdown", path: "CLAUDE.md", text: "Be excellent.\n" },
    ]);
    const unclassified = evaluate({ ...input, behaviorObservations: [], ir });
    expect(unclassified.uncertainties).toContainEqual(
      expect.objectContaining({
        documentId: idFor("document", "CLAUDE.md"),
        reason: "statement-unclassified",
      }),
    );

    const matchingCursor = compare([
      cursor("cursor-agent/ide", true),
      cursor("cursor-agent/cli", true),
    ]);
    const editorIr = simpleIr([
      {
        formatId: "cursor-mdc",
        path: ".cursor/rules/editor.mdc",
        text: "Use editor diagnostics.\n",
      },
    ]);
    const documentId = idFor("document", ".cursor/rules/editor.mdc");
    const statementId = idFor("statement", ".cursor/rules/editor.mdc");
    const result = evaluate({
      behaviorObservations: [
        behaviorObservation(
          "editor-diagnostics",
          documentId,
          statementId,
          "cursor-agent",
          "cursor-agent/ide",
          "editor-feature",
          "supported",
        ),
        behaviorObservation(
          "editor-diagnostics",
          documentId,
          statementId,
          "cursor-agent",
          "cursor-agent/cli",
          "editor-feature",
          "unsupported",
        ),
      ],
      comparisons: [matchingCursor],
      contractVersion: PORTABILITY_RULE_CONTRACT_VERSION,
      formatInventoryState: "partial",
      formatObservations: [],
      ir: editorIr,
      recordKind: "agent-context-portability-rule-input",
    });
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.uncertainties).toContainEqual(
      expect.objectContaining({ reason: "comparison-indeterminate" }),
    );
  });

  test("suppression finalization accepts only an issued evaluation", () => {
    const input = crossAgentFixture();
    const ir = simpleIr([
      { formatId: "agents-markdown", path: "AGENTS.md", text: "Use pnpm.\n" },
      {
        formatId: "claude-memory-markdown",
        path: "CLAUDE.md",
        text: "<!-- agent-context-lint-disable-next-line ACL450 -- reviewed exception -->\nUse npm.\n",
      },
    ]);
    const result = evaluate({ ...input, behaviorObservations: [], ir });
    const finalized = finalizePortabilitySuppressions(result);
    expect(finalized).toMatchObject({ ok: true });
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    expect(finalized.suppressedDiagnostics.map((entry) => entry.ruleId)).toContain("ACL450");
    expect(finalized.visibleDiagnostics.map((entry) => entry.ruleId)).not.toContain("ACL450");
    expect(finalized.bundle.suppressions).toMatchObject([{ state: "suppressed" }]);
    expect(finalizePortabilitySuppressions({ ...result })).toMatchObject({ ok: false });
    expect(finalizePortabilitySuppressions(new Proxy(result, {}))).toMatchObject({ ok: false });
  });
});
