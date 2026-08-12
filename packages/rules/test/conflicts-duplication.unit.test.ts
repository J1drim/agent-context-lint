import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import type {
  AstNodeId,
  InstructionDocument,
  InstructionIr,
  InstructionStatement,
  InstructionStatementId,
  RepositoryRelativePath,
  SourceDocument,
} from "@agent-context/core";
import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveEffectiveContext,
} from "@agent-context/resolver";
import type {
  ClaudeCodeProfileResolution,
  CodexCliAgentsResolution,
  EffectiveContextResolution,
} from "@agent-context/resolver";
import { describe, expect, test, vi } from "vitest";

import {
  CONFLICTS_DUPLICATION_CONTRACT_VERSION,
  CONFLICTS_DUPLICATION_DEFAULT_LIMITS,
  evaluateConflictsDuplicationRules,
  finalizeConflictsDuplicationSuppressions,
} from "../src/index.js";
import type {
  ConflictsDuplicationInput,
  ConflictsDuplicationOptions,
  ConflictsDuplicationResult,
} from "../src/index.js";

const encoder = new TextEncoder();

interface TextFile {
  readonly path: string;
  readonly text: string;
}

interface BuiltFixture {
  readonly contexts: readonly EffectiveContextResolution[];
  readonly input: ConflictsDuplicationInput;
  readonly ir: InstructionIr;
}

interface PrecisionCase {
  readonly expectedErrorRuleIds: readonly ("ACL250" | "ACL251")[];
  readonly files: readonly TextFile[];
  readonly id: string;
}

interface PrecisionCorpus {
  readonly cases: readonly PrecisionCase[];
  readonly contractVersion: "0.1.0";
  readonly minimumPositiveLabelsPerErrorRule: number;
  readonly precisionThreshold: number;
  readonly recordKind: "agent-context-conflicts-duplication-precision-corpus";
}

const precisionCorpus = JSON.parse(
  readFileSync(
    new URL("./fixtures/conflicts-duplication-precision.v0.json", import.meta.url),
    "utf8",
  ),
) as PrecisionCorpus;

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("synthetic fixture entry is missing");
  return value;
}

function directory(value: string): RepositoryRelativePath {
  const index = value.lastIndexOf("/");
  return path(index < 0 ? "." : value.slice(0, index));
}

function codex(files: readonly TextFile[], targetPath = "pkg/main.ts"): CodexCliAgentsResolution {
  return resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: files.map((file) => ({
        bytes: encoder.encode(file.text),
        errorCode: null,
        kind: "file" as const,
        path: path(file.path),
        resolvedTarget: null,
      })),
      reason: "complete F08 synthetic snapshot",
      rootMarkerPaths: [path(".git")],
    },
    externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: directory(targetPath),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath: path(targetPath),
  });
}

function effective(
  profile: CodexCliAgentsResolution | ClaudeCodeProfileResolution,
  targetPath = "pkg/main.ts",
): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution: profile,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: path(targetPath),
  });
}

function irFromCodex(profile: CodexCliAgentsResolution): InstructionIr {
  const syntax = profile.contributions.flatMap((entry) =>
    entry.syntax === null ? [] : [entry.syntax],
  );
  return validatedIr({
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

function lineEnding(text: string): SourceDocument["lineEnding"] {
  if (text.includes("\r\n")) return "crlf";
  if (text.includes("\r")) return "mixed";
  return text.includes("\n") ? "lf" : "none";
}

function irFromClaude(profile: ClaudeCodeProfileResolution): InstructionIr {
  const sources: SourceDocument[] = [];
  const documents: InstructionDocument[] = [];
  const statements: InstructionStatement[] = [];
  const nodes = [];
  for (const candidate of profile.candidates) {
    const text = candidate.syntax.text;
    if (text === null) throw new Error("synthetic Claude syntax unexpectedly unavailable");
    const prefix = createHash("sha256").update(candidate.path).digest("hex");
    const rootNodeId = `ast:claude-f08:${prefix}:root` as AstNodeId;
    const candidateNodes: InstructionIr["nodes"][number][] = [];
    const candidateStatements: InstructionStatement[] = [];
    const rootChildren: AstNodeId[] = [];
    const lines = text.split("\n");
    let offset = 0;
    for (const [index, line] of lines.entries()) {
      if (line.length > 0) {
        const markerLength = line.startsWith("- ") ? 2 : 0;
        const nodeId = `ast:claude-f08:${prefix}:${String(index)}` as AstNodeId;
        const statementId =
          `statement:claude-f08:${prefix}:${String(index)}` as InstructionStatementId;
        const range = {
          end: {
            byteOffset: offset + line.length,
            line: index,
            utf16Column: line.length,
            utf16Offset: offset + line.length,
          },
          sourceId: candidate.syntax.sourceId,
          start: {
            byteOffset: offset + markerLength,
            line: index,
            utf16Column: markerLength,
            utf16Offset: offset + markerLength,
          },
        };
        rootChildren.push(nodeId);
        candidateNodes.push({
          childIds: [],
          id: nodeId,
          kind: "paragraph",
          range,
          sourceId: candidate.syntax.sourceId,
        });
        candidateStatements.push({
          classification: { state: "unclassified" },
          documentId: candidate.syntax.documentId,
          id: statementId,
          nodeIds: [nodeId],
          range,
          text: line.slice(markerLength),
        });
      }
      offset += line.length + 1;
    }
    const endLine = lines.length - 1;
    const endColumn = required(lines.at(-1)).length;
    candidateNodes.unshift({
      childIds: rootChildren,
      id: rootNodeId,
      kind: "root",
      range: {
        end: {
          byteOffset: Buffer.byteLength(text, "utf8"),
          line: endLine,
          utf16Column: endColumn,
          utf16Offset: text.length,
        },
        sourceId: candidate.syntax.sourceId,
        start: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
      },
      sourceId: candidate.syntax.sourceId,
    });
    const source: SourceDocument = {
      bom: "none",
      byteLength: Buffer.byteLength(text, "utf8"),
      encoding: "utf-8",
      id: candidate.syntax.sourceId,
      lineEnding: lineEnding(text),
      parseState: { state: "complete" },
      path: candidate.path,
      rootNodeId,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      text,
      utf16Length: text.length,
    };
    sources.push(source);
    nodes.push(...candidateNodes);
    statements.push(...candidateStatements);
    documents.push({
      activationRuleIds: [],
      formatId:
        candidate.syntax.format === "memory" ? "claude-memory-markdown" : "claude-rule-markdown",
      id: candidate.syntax.documentId,
      importIds: [],
      rootNodeId,
      scopeRoot: candidate.scopeRoot,
      sourceId: source.id,
      statementIds: candidateStatements.map((entry) => entry.id),
    });
  }
  return validatedIr({
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
}

function validatedIr(value: InstructionIr): InstructionIr {
  const validation = validateInstructionIr(value);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

function combineIr(...values: readonly InstructionIr[]): InstructionIr {
  return validatedIr({
    activationRules: values.flatMap((entry) => entry.activationRules),
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: values.flatMap((entry) => entry.documents),
    events: values.flatMap((entry) => entry.events),
    imports: values.flatMap((entry) => entry.imports),
    nodes: values.flatMap((entry) => entry.nodes),
    recordKind: "agent-context-instruction-ir",
    sources: values.flatMap((entry) => entry.sources),
    statements: values.flatMap((entry) => entry.statements),
    targets: values.flatMap((entry) => entry.targets),
  });
}

function fixture(files: readonly TextFile[], targetPath = "pkg/main.ts"): BuiltFixture {
  const profile = codex(files, targetPath);
  const context = effective(profile, targetPath);
  const ir = irFromCodex(profile);
  return {
    contexts: [context],
    input: {
      contexts: [context],
      contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
      ir,
      recordKind: "agent-context-conflicts-duplication-rule-input",
    },
    ir,
  };
}

function evaluate(
  built: BuiltFixture,
  options?: ConflictsDuplicationOptions,
): Extract<ConflictsDuplicationResult, { readonly ok: true }> {
  const result = evaluateConflictsDuplicationRules(built.input, options);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(result.ok).toBe(true);
  expect(validateDiagnosticBundle(result.bundle, built.ir.sources).ok).toBe(true);
  return result;
}

function ids(
  result: Extract<ConflictsDuplicationResult, { readonly ok: true }>,
): readonly string[] {
  return result.bundle.diagnostics.map((entry) => entry.ruleId);
}

function claude(text: string): ClaudeCodeProfileResolution {
  return resolveClaudeCodeProfile({
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
    launchCwd: path("pkg"),
    repositoryRoot: path("."),
    runtime: {
      additionalDirectoryInstructions: "disabled",
      clientVersion: "2.1.217",
      eventTrace: [{ id: "event:f08-launch", kind: "launch", path: path("pkg") }],
      exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
      externalContext: "supplied",
      mode: "normal",
      settingSources: { state: "known", values: ["project"] },
    },
  });
}

describe("F08 structured conflicts and duplication", () => {
  test("emits ACL250, ACL251, and ACL252 only for high-confidence effective conflicts", () => {
    const packageManagers = evaluate(
      fixture([
        { path: "AGENTS.md", text: "- Always use pnpm.\n" },
        { path: "pkg/AGENTS.md", text: "- Always use npm.\n" },
      ]),
    );
    expect(ids(packageManagers)).toContain("ACL250");
    expect(
      packageManagers.bundle.diagnostics.find((entry) => entry.ruleId === "ACL250"),
    ).toMatchObject({
      related: [{ kind: "source" }],
      severity: "error",
    });

    const polarity = evaluate(
      fixture([
        { path: "AGENTS.md", text: "- Run pnpm test.\n" },
        { path: "pkg/AGENTS.md", text: "- Do not run pnpm test.\n" },
      ]),
    );
    expect(ids(polarity)).toContain("ACL251");

    const formatter = evaluate(
      fixture([
        { path: "AGENTS.md", text: "- Use prettier to format source files.\n" },
        { path: "pkg/AGENTS.md", text: "- Use biome to format source files.\n" },
      ]),
    );
    expect(ids(formatter)).toContain("ACL252");

    const compatible = evaluate(
      fixture([
        { path: "AGENTS.md", text: "- Always use pnpm.\n- Run unit tests.\n" },
        { path: "pkg/AGENTS.md", text: "- Do not use npm.\n- Run integration tests.\n" },
      ]),
    );
    expect(
      ids(compatible).filter((id) => id === "ACL250" || id === "ACL251" || id === "ACL252"),
    ).toEqual([]);
  });

  test("uses F04 near and exact clusters for ACL253 and inherited ACL255", () => {
    const near = evaluate(
      fixture([
        { path: "AGENTS.md", text: "- Always run pnpm tests before submitting changes.\n" },
        { path: "pkg/AGENTS.md", text: "- Always run pnpm tests before submitting any changes.\n" },
      ]),
    );
    expect(ids(near)).toContain("ACL253");
    expect(near.metrics.nearClusterCount).toBeGreaterThan(0);

    const exact = evaluate(
      fixture([
        { path: "AGENTS.md", text: "- Run pnpm test.\n" },
        { path: "pkg/AGENTS.md", text: "- Run pnpm test.\n" },
      ]),
    );
    expect(ids(exact)).toContain("ACL255");
    expect(ids(exact)).not.toContain("ACL253");
  });

  test("reports ACL254 across real Codex and Claude effective contexts for one target", () => {
    const codexProfile = codex([{ path: "AGENTS.md", text: "- Always use pnpm.\n" }]);
    const claudeProfile = claude("- Always use npm.\n");
    const contexts = [effective(codexProfile), effective(claudeProfile)];
    const ir = combineIr(irFromCodex(codexProfile), irFromClaude(claudeProfile));
    const result = evaluate({
      contexts,
      input: {
        contexts,
        contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
        ir,
        recordKind: "agent-context-conflicts-duplication-rule-input",
      },
      ir,
    });
    const diagnostic = result.bundle.diagnostics.find((entry) => entry.ruleId === "ACL254");
    expect(diagnostic).toMatchObject({ primary: { path: "CLAUDE.md" }, severity: "warning" });
    expect(diagnostic?.fingerprintBasis.path.profileIds).toEqual(["claude-code", "codex-cli"]);
  });

  test("classifies explicit testing, build, formatting, and commit workflow selections", () => {
    for (const [workflow, first, second] of [
      ["testing", "Run only unit tests.", "Run only integration tests."],
      ["build", "Run only build debug.", "Run only build release."],
      ["formatting", "Run only format TypeScript.", "Run only format Python."],
      ["commit", "Run only commit staged files.", "Run only commit all files."],
    ] as const) {
      const result = evaluate(
        fixture([
          { path: "AGENTS.md", text: `- ${first}\n` },
          { path: "pkg/AGENTS.md", text: `- ${second}\n` },
        ]),
      );
      expect(ids(result), workflow).toContain("ACL252");
    }
    const unrelated = evaluate(
      fixture([
        { path: "AGENTS.md", text: "- Run only deploy production.\n" },
        { path: "pkg/AGENTS.md", text: "- Run only publish packages.\n" },
      ]),
    );
    expect(ids(unrelated)).not.toContain("ACL252");
  });

  test("detects formatting, ownership, and polarity divergence in vendor context", () => {
    const codexProfile = codex([
      {
        path: "AGENTS.md",
        text: "- Formatting must be done with prettier.\n- src/api is owned by platform-team.\n- Run pnpm test.\n",
      },
    ]);
    const claudeProfile = claude(
      "- Formatting must be done with biome.\n- src/api is owned by api-team.\n- Do not run pnpm test.\n",
    );
    const contexts = [effective(codexProfile), effective(claudeProfile)];
    const ir = combineIr(irFromCodex(codexProfile), irFromClaude(claudeProfile));
    const result = evaluate({
      contexts,
      input: {
        contexts,
        contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
        ir,
        recordKind: "agent-context-conflicts-duplication-rule-input",
      },
      ir,
    });
    expect(ids(result).filter((id) => id === "ACL254")).toHaveLength(3);

    const selectionProfile = codex([{ path: "AGENTS.md", text: "- Always use pnpm.\n" }]);
    const commandProfile = claude("- Run pnpm test.\n");
    const compatibleContexts = [effective(selectionProfile), effective(commandProfile)];
    const compatibleIr = combineIr(irFromCodex(selectionProfile), irFromClaude(commandProfile));
    const compatible = evaluate({
      contexts: compatibleContexts,
      input: {
        contexts: compatibleContexts,
        contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
        ir: compatibleIr,
        recordKind: "agent-context-conflicts-duplication-rule-input",
      },
      ir: compatibleIr,
    });
    expect(ids(compatible)).not.toContain("ACL254");
  });

  test("excludes conditional, unavailable, and truncated-out content and retains uncertainty", () => {
    const truncatedProfile = resolveCodexCliAgents({
      discovery: {
        certainty: "known",
        entries: [
          {
            bytes: encoder.encode("- Always use pnpm.\n- Always use npm.\n"),
            errorCode: null,
            kind: "file",
            path: path("AGENTS.md"),
            resolvedTarget: null,
          },
        ],
        reason: "complete synthetic snapshot",
        rootMarkerPaths: [path(".git")],
      },
      externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
      launchCwd: path("pkg"),
      settings: {
        projectDocFallbackFilenames: [],
        projectDocMaxBytes: 20,
        projectRootMarkers: [".git"],
      },
      targetPath: path("pkg/main.ts"),
    });
    const context = resolveEffectiveContext({
      contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
      importDags: [],
      profileResolution: truncatedProfile,
      recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
      targetPath: path("pkg/main.ts"),
    });
    const ir = irFromCodex(truncatedProfile);
    const result = evaluate({
      contexts: [context],
      input: {
        contexts: [context],
        contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
        ir,
        recordKind: "agent-context-conflicts-duplication-rule-input",
      },
      ir,
    });
    expect(ids(result)).not.toContain("ACL250");
    expect(result.uncertainties.map((entry) => entry.reason)).toContain("truncated-content");
  });

  test("matches only parser-issued targeted suppressions and rejects forged evaluation objects", () => {
    const built = fixture([
      { path: "AGENTS.md", text: "- Always use pnpm.\n" },
      {
        path: "pkg/AGENTS.md",
        text: "<!-- agent-context-lint-disable-next-line ACL250 -- standalone package -->\n- Always use npm.\n",
      },
    ]);
    const evaluated = evaluate(built);
    const finalized = finalizeConflictsDuplicationSuppressions(evaluated);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
    expect(finalized.visibleDiagnostics.map((entry) => entry.ruleId)).not.toContain("ACL250");
    expect(finalized.suppressedDiagnostics.map((entry) => entry.ruleId)).toContain("ACL250");
    expect(finalized.bundle.suppressions).toMatchObject([{ state: "suppressed" }]);
    expect(finalizeConflictsDuplicationSuppressions(structuredClone(evaluated))).toMatchObject({
      ok: false,
    });
    expect(finalizeConflictsDuplicationSuppressions(null)).toMatchObject({ ok: false });
    expect(finalizeConflictsDuplicationSuppressions("issued")).toMatchObject({ ok: false });
    expect(finalizeConflictsDuplicationSuppressions(new Proxy(evaluated, {}))).toMatchObject({
      ok: false,
    });
  });

  test("fails closed on proxies, accessors, sparse arrays, forged E05 results, and limits", () => {
    const built = fixture([{ path: "AGENTS.md", text: "- Always use pnpm.\n" }]);
    const trap = vi.fn();
    expect(
      evaluateConflictsDuplicationRules(new Proxy(built.input, { ownKeys: trap })),
    ).toMatchObject({ ok: false });
    expect(trap).not.toHaveBeenCalled();

    const accessor = { ...built.input } as Record<string, unknown>;
    Object.defineProperty(accessor, "ir", { enumerable: true, get: trap });
    expect(evaluateConflictsDuplicationRules(accessor)).toMatchObject({ ok: false });
    expect(trap).not.toHaveBeenCalled();

    const sparse = new Array<EffectiveContextResolution>(2);
    sparse[1] = required(built.contexts[0]);
    expect(evaluateConflictsDuplicationRules({ ...built.input, contexts: sparse })).toMatchObject({
      ok: false,
    });
    expect(
      evaluateConflictsDuplicationRules({
        ...built.input,
        contexts: [structuredClone(built.contexts[0])],
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluateConflictsDuplicationRules(built.input, {
        ...CONFLICTS_DUPLICATION_DEFAULT_LIMITS,
        maximumStatements: 2,
      }),
    ).toMatchObject({ ok: true });
    expect(
      evaluateConflictsDuplicationRules(
        fixture(
          [
            { path: "AGENTS.md", text: "- Always use pnpm.\n" },
            { path: "pkg/AGENTS.md", text: "- Always use npm.\n" },
            { path: "pkg/sub/AGENTS.md", text: "- Always use yarn.\n" },
          ],
          "pkg/sub/main.ts",
        ).input,
        { ...CONFLICTS_DUPLICATION_DEFAULT_LIMITS, maximumComparisons: 1 },
      ),
    ).toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
  });

  test("validates closed input and partial limit options without invoking hostile properties", () => {
    const built = fixture([{ path: "AGENTS.md", text: "- Always use pnpm.\n" }]);
    const invalid = (input: unknown, options?: unknown): void => {
      expect(evaluateConflictsDuplicationRules(input, options)).toMatchObject({ ok: false });
    };

    invalid(null);
    invalid([]);
    invalid({ ...built.input, extra: true });
    invalid({ ...built.input, recordKind: "wrong-kind" });
    invalid(Object.assign(Object.create({ inherited: true }), built.input));
    const hiddenInput = { ...built.input } as Record<string, unknown>;
    Object.defineProperty(hiddenInput, "ir", { enumerable: false, value: built.ir });
    invalid(hiddenInput);

    invalid(built.input, null);
    invalid(built.input, { unknown: 1 });
    invalid(built.input, { maximumStatements: 0 });
    invalid(built.input, { maximumStatements: Number.MAX_SAFE_INTEGER });
    const optionTrap = vi.fn();
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "maximumStatements", {
      enumerable: true,
      get: optionTrap,
    });
    invalid(built.input, accessorOptions);
    expect(optionTrap).not.toHaveBeenCalled();
    expect(evaluateConflictsDuplicationRules(built.input, { maximumStatements: 10 })).toMatchObject(
      {
        ok: true,
      },
    );

    const nullPrototypeInput = Object.assign(
      Object.create(null) as Record<PropertyKey, unknown>,
      built.input,
    );
    expect(evaluateConflictsDuplicationRules(nullPrototypeInput)).toMatchObject({ ok: true });
  });

  test("snapshots untrusted IR as bounded JSON and rejects hostile data before B03 validation", () => {
    const built = fixture([{ path: "AGENTS.md", text: "- Always use pnpm.\n" }]);
    interface MutableIr {
      sources: Record<PropertyKey, unknown>[];
      statements: Record<PropertyKey, unknown>[];
      [key: PropertyKey]: unknown;
    }
    const rejectIr = (ir: unknown, options?: ConflictsDuplicationOptions): void => {
      expect(evaluateConflictsDuplicationRules({ ...built.input, ir }, options)).toMatchObject({
        ok: false,
      });
    };
    const clone = (): MutableIr => structuredClone(built.ir) as unknown as MutableIr;

    rejectIr(null);
    const nonFinite = clone();
    required(nonFinite.sources[0])["byteLength"] = Number.NaN;
    rejectIr(nonFinite);
    const callable = clone();
    required(callable.sources[0])["text"] = (): string => "untrusted";
    rejectIr(callable);
    const cycle = clone();
    required(cycle.sources[0])["cycle"] = cycle;
    rejectIr(cycle);
    const symbol = clone();
    required(symbol.sources[0])[Symbol("hidden")] = true;
    rejectIr(symbol);
    const foreignPrototype = clone();
    required(foreignPrototype.sources[0])["text"] = new Date(0);
    rejectIr(foreignPrototype);
    const accessor = clone();
    const trap = vi.fn();
    Object.defineProperty(required(accessor.sources[0]), "text", { enumerable: true, get: trap });
    rejectIr(accessor);
    expect(trap).not.toHaveBeenCalled();

    const sparse = clone();
    Reflect.deleteProperty(sparse.statements, "0");
    rejectIr(sparse);
    const extended = clone();
    Object.defineProperty(extended.statements, "extra", { enumerable: true, value: true });
    rejectIr(extended);
    const customArray = clone();
    Object.setPrototypeOf(
      customArray.statements,
      Object.create(Array.prototype) as Record<PropertyKey, unknown>,
    );
    rejectIr(customArray);
    const hiddenEntry = clone();
    Object.defineProperty(hiddenEntry.statements, "0", {
      enumerable: false,
      value: hiddenEntry.statements[0],
    });
    rejectIr(hiddenEntry);

    const deeplyNested = clone();
    let nested: Record<string, unknown> = {};
    required(deeplyNested.sources[0])["text"] = nested;
    for (let depth = 0; depth < 66; depth += 1) {
      const next: Record<string, unknown> = {};
      nested["next"] = next;
      nested = next;
    }
    rejectIr(deeplyNested);
    rejectIr(built.ir, { maximumInputNodes: 1 });
    rejectIr(built.ir, { maximumStringBytes: 1 });

    const longStatement = fixture([{ path: "AGENTS.md", text: "- Always use pnpm.\n" }]);
    rejectIr(longStatement.ir, { maximumTextLength: 1 });
    const twoStatements = fixture([
      { path: "AGENTS.md", text: "- Always use pnpm.\n- Run tests.\n" },
    ]);
    rejectIr(twoStatements.ir, { maximumStatements: 1 });
  });

  test("bounds context certainty, uncertainties, diagnostics, and repeated target findings", () => {
    const files = [
      { path: "AGENTS.md", text: "- Always use pnpm.\n- Run pnpm test.\n" },
      { path: "pkg/AGENTS.md", text: "- Always use npm.\n- Do not run pnpm test.\n" },
    ];
    const firstProfile = codex(files, "pkg/main.ts");
    const secondProfile = codex(files, "pkg/other.ts");
    const contexts = [
      effective(firstProfile, "pkg/main.ts"),
      effective(secondProfile, "pkg/other.ts"),
    ];
    const ir = irFromCodex(firstProfile);
    const input: ConflictsDuplicationInput = {
      contexts,
      contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
      ir,
      recordKind: "agent-context-conflicts-duplication-rule-input",
    };
    const result = evaluate({ contexts, input, ir });
    expect(ids(result).filter((id) => id === "ACL250")).toHaveLength(1);

    expect(
      evaluateConflictsDuplicationRules({ ...input, contexts: [contexts[0], contexts[0]] }),
    ).toMatchObject({
      ok: false,
    });
    expect(evaluateConflictsDuplicationRules(input, { maximumContexts: 1 })).toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
    expect(evaluateConflictsDuplicationRules(input, { maximumDiagnostics: 1 })).toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });

    const extended = [contexts[0]];
    Object.defineProperty(extended, "extra", { enumerable: true, value: true });
    expect(evaluateConflictsDuplicationRules({ ...input, contexts: extended })).toMatchObject({
      ok: false,
    });
    const hidden = [contexts[0]];
    Object.defineProperty(hidden, "0", { enumerable: false, value: contexts[0] });
    expect(evaluateConflictsDuplicationRules({ ...input, contexts: hidden })).toMatchObject({
      ok: false,
    });
    expect(
      evaluateConflictsDuplicationRules({ ...input, contexts: new Proxy([contexts[0]], {}) }),
    ).toMatchObject({ ok: false });

    const conditionalProfile = resolveCodexCliAgents({
      discovery: {
        certainty: "uncertain",
        entries: [
          {
            bytes: null,
            errorCode: null,
            kind: "unknown",
            path: path("AGENTS.md"),
            resolvedTarget: null,
          },
          {
            bytes: encoder.encode("Fallback.\n"),
            errorCode: null,
            kind: "file",
            path: path("FALLBACK.md"),
            resolvedTarget: null,
          },
        ],
        reason: "incomplete inventory",
        rootMarkerPaths: [path(".git")],
      },
      externalContext: { mode: "unavailable" },
      launchCwd: path("."),
      settings: {
        projectDocFallbackFilenames: ["FALLBACK.md"],
        projectDocMaxBytes: 32_768,
        projectRootMarkers: [".git"],
      },
      targetPath: path("pkg/main.ts"),
    });
    const conditional = effective(conditionalProfile);
    const conditionalIr = irFromCodex(conditionalProfile);
    const conditionalInput: ConflictsDuplicationInput = {
      contexts: [conditional],
      contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
      ir: conditionalIr,
      recordKind: "agent-context-conflicts-duplication-rule-input",
    };
    const conditionalResult = evaluate({
      contexts: [conditional],
      input: conditionalInput,
      ir: conditionalIr,
    });
    expect(conditionalResult.uncertainties.map((entry) => entry.reason)).toContain(
      "conditional-document",
    );
    expect(
      evaluateConflictsDuplicationRules(conditionalInput, { maximumUncertainties: 1 }),
    ).toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });

    const empty = validatedIr({
      activationRules: [],
      contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
      documents: [],
      events: [],
      imports: [],
      nodes: [],
      recordKind: "agent-context-instruction-ir",
      sources: [],
      statements: [],
      targets: [],
    });
    const unmapped = evaluateConflictsDuplicationRules({
      ...input,
      contexts: [contexts[0]],
      ir: empty,
    });
    expect(unmapped.ok).toBe(true);
    if (!unmapped.ok) throw new Error(JSON.stringify(unmapped.issues));
    expect(unmapped.uncertainties.map((entry) => entry.reason)).toContain(
      "effective-document-unmapped",
    );
  });

  test("ignores same-document and inactive duplication opportunities", () => {
    const repeated = evaluate(
      fixture([
        {
          path: "AGENTS.md",
          text: "- Always run pnpm tests before submitting changes.\n- Always run pnpm tests before submitting any changes.\n- Run pnpm test.\n- Run pnpm test.\n",
        },
      ]),
    );
    expect(ids(repeated)).not.toContain("ACL253");
    expect(ids(repeated)).not.toContain("ACL255");

    const codexProfile = codex([{ path: "AGENTS.md", text: "- Run pnpm test.\n" }]);
    const claudeProfile = claude("- Run pnpm test.\n");
    const contexts = [effective(codexProfile), effective(claudeProfile)];
    const ir = combineIr(irFromCodex(codexProfile), irFromClaude(claudeProfile));
    const inactive = evaluate({
      contexts,
      input: {
        contexts,
        contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
        ir,
        recordKind: "agent-context-conflicts-duplication-rule-input",
      },
      ir,
    });
    expect(ids(inactive)).not.toContain("ACL255");

    const shadowedProfile = resolveCodexCliAgents({
      discovery: {
        certainty: "known",
        entries: [
          {
            bytes: encoder.encode("Primary.\n"),
            errorCode: null,
            kind: "file",
            path: path("AGENTS.md"),
            resolvedTarget: null,
          },
          {
            bytes: encoder.encode("Fallback.\n"),
            errorCode: null,
            kind: "file",
            path: path("FALLBACK.md"),
            resolvedTarget: null,
          },
        ],
        reason: "complete inventory",
        rootMarkerPaths: [path(".git")],
      },
      externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
      launchCwd: path("pkg"),
      settings: {
        projectDocFallbackFilenames: ["FALLBACK.md"],
        projectDocMaxBytes: 32_768,
        projectRootMarkers: [".git"],
      },
      targetPath: path("pkg/main.ts"),
    });
    const shadowedContext = effective(shadowedProfile);
    const shadowedIr = irFromCodex(shadowedProfile);
    const shadowed = evaluate({
      contexts: [shadowedContext],
      input: {
        contexts: [shadowedContext],
        contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
        ir: shadowedIr,
        recordKind: "agent-context-conflicts-duplication-rule-input",
      },
      ir: shadowedIr,
    });
    expect(shadowed.metrics.statementCount).toBeGreaterThan(0);

    const partialClaudeProfile = resolveClaudeCodeProfile({
      candidates: [
        {
          absolutePath: "/repo/CLAUDE.md",
          bytes: encoder.encode("- Run pnpm test.\n"),
          importGraph: null,
          kind: "memory-shared",
          origin: "repository",
          path: path("CLAUDE.md"),
          scopeRoot: path("."),
          symlinkState: "none",
        },
        {
          absolutePath: "/repo/.claude/rules/repeat.md",
          bytes: encoder.encode("- Run pnpm test.\n"),
          importGraph: null,
          kind: "project-rule",
          origin: "repository",
          path: path(".claude/rules/repeat.md"),
          scopeRoot: path("."),
          symlinkState: "none",
        },
      ],
      launchCwd: path("pkg"),
      repositoryRoot: path("."),
      runtime: {
        additionalDirectoryInstructions: "disabled",
        clientVersion: "2.1.217",
        eventTrace: [{ id: "event:f08-repeat", kind: "launch", path: path("pkg") }],
        exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
        externalContext: "supplied",
        mode: "normal",
        settingSources: { state: "known", values: ["project"] },
      },
    });
    const claudeContext = effective(partialClaudeProfile);
    const claudeIr = irFromClaude(partialClaudeProfile);
    const claudeRepeat = evaluate({
      contexts: [claudeContext],
      input: {
        contexts: [claudeContext],
        contractVersion: CONFLICTS_DUPLICATION_CONTRACT_VERSION,
        ir: claudeIr,
        recordKind: "agent-context-conflicts-duplication-rule-input",
      },
      ir: claudeIr,
    });
    expect(claudeRepeat.metrics.exactClusterCount).toBeGreaterThan(0);
  });

  test("is byte-deterministic and meets the labeled default-error precision gate", () => {
    expect(precisionCorpus).toMatchObject({
      contractVersion: "0.1.0",
      minimumPositiveLabelsPerErrorRule: 8,
      precisionThreshold: 0.95,
      recordKind: "agent-context-conflicts-duplication-precision-corpus",
    });
    const first = precisionCorpus.cases.map((entry) => {
      const result = evaluate(fixture(entry.files));
      const actual = result.bundle.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.ruleId)
        .sort();
      expect(actual, entry.id).toEqual(entry.expectedErrorRuleIds);
      return { actual, id: entry.id, output: JSON.stringify(result) };
    });
    const second = precisionCorpus.cases.map((entry) => {
      const result = evaluate(fixture(entry.files));
      return {
        actual: ids(result)
          .filter((id) => id === "ACL250" || id === "ACL251")
          .sort(),
        id: entry.id,
        output: JSON.stringify(result),
      };
    });
    expect(second).toEqual(first);
    for (const ruleId of ["ACL250", "ACL251"] as const) {
      const positives = precisionCorpus.cases.filter((entry) =>
        entry.expectedErrorRuleIds.includes(ruleId),
      );
      expect(positives.length).toBeGreaterThanOrEqual(
        precisionCorpus.minimumPositiveLabelsPerErrorRule,
      );
      let truePositives = 0;
      let falsePositives = 0;
      for (const [index, prediction] of first.entries()) {
        if (!prediction.actual.includes(ruleId)) continue;
        if (precisionCorpus.cases[index]?.expectedErrorRuleIds.includes(ruleId) === true)
          truePositives += 1;
        else falsePositives += 1;
      }
      expect(truePositives / Math.max(1, truePositives + falsePositives)).toBeGreaterThanOrEqual(
        precisionCorpus.precisionThreshold,
      );
    }
  });
});
