import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  createInstructionIrSnapshot,
  validateInstructionIr,
} from "@agent-context/core";

import {
  RULE_FAMILY_DESCRIPTORS,
  RULE_FAMILY_IDS,
  RULE_SCHEDULER_CONTRACT_VERSION,
  RULE_SCHEDULER_RECORD_KIND,
  canonicalizeRuleDiagnostics,
  evaluateConflictsDuplicationRules,
  evaluateContextEfficiencyRules,
  evaluatePortabilityRules,
  evaluateSyntaxStructureRules,
  finalizeScheduledSyntaxSuppressions,
  getSyntaxSuppressionFinalizationIssuance,
  planApprovedMechanicalFixes,
  scheduleRuleFamilies,
} from "../src/index.js";

import { fullRuleSchedulerInput } from "./helpers/rule-scheduler-full-families.js";

import type {
  AstNodeId,
  Diagnostic,
  DiagnosticBundle,
  InstructionDocumentId,
  InstructionIr,
  InstructionStatementId,
  SourceDocumentId,
  SourcePosition,
} from "@agent-context/core";
import type {
  RuleDiagnosticCanonicalizationResult,
  RuleFamilyRequest,
  RuleSchedulerInput,
} from "../src/index.js";

function withFamilyOrder(
  input: RuleSchedulerInput,
  families: readonly RuleFamilyRequest[],
): RuleSchedulerInput {
  return { ...input, families };
}

function mutableIrInput(input: RuleSchedulerInput): {
  readonly input: RuleSchedulerInput;
  readonly ir: InstructionIr;
} {
  const syntax = input.families.find((entry) => entry.familyId === "syntax-structure");
  if (syntax?.familyId !== "syntax-structure") throw new Error("syntax fixture missing");
  const ir = structuredClone(syntax.input.ir);
  const families = input.families.map((family): RuleFamilyRequest => {
    if (family.familyId === "repository-drift") return family;
    return { ...family, input: { ...family.input, ir } } as RuleFamilyRequest;
  });
  return { input: withFamilyOrder(input, families), ir };
}

function suppressionFixture(includeStatement = true): {
  readonly input: RuleSchedulerInput;
  readonly syntaxInput: RuleFamilyRequest["input"];
} {
  const directive = "<!-- agent-context-lint-disable-next-line ACL300 -- reason: fixture -->";
  const statementText = "Run npm run missing";
  const secondStatementText = "Run npm run another-missing";
  const text = `${directive}\n${statementText}\n${secondStatementText}\n`;
  const sourceId = "source:scheduler:suppression" as SourceDocumentId;
  const rootNodeId = "node:scheduler:suppression:root" as AstNodeId;
  const commentNodeId = "node:scheduler:suppression:comment" as AstNodeId;
  const statementNodeId = "node:scheduler:suppression:statement" as AstNodeId;
  const secondStatementNodeId = "node:scheduler:suppression:statement-2" as AstNodeId;
  const documentId = "document:scheduler:suppression" as InstructionDocumentId;
  const statementId = "statement:scheduler:suppression" as InstructionStatementId;
  const secondStatementId = "statement:scheduler:suppression-2" as InstructionStatementId;
  const position = (utf16Offset: number, line: number, utf16Column: number): SourcePosition => ({
    byteOffset: Buffer.byteLength(text.slice(0, utf16Offset), "utf8"),
    line,
    utf16Column,
    utf16Offset,
  });
  const statementStart = directive.length + 1;
  const secondStatementStart = statementStart + statementText.length + 1;
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
        statementIds: [statementId, secondStatementId],
      },
    ],
    events: [],
    imports: [],
    nodes: [
      {
        childIds: [commentNodeId, statementNodeId, secondStatementNodeId],
        id: rootNodeId,
        kind: "root",
        range: { end: position(text.length, 3, 0), sourceId, start: position(0, 0, 0) },
        sourceId,
      },
      {
        childIds: [],
        id: commentNodeId,
        kind: "html-comment",
        range: {
          end: position(directive.length, 0, directive.length),
          sourceId,
          start: position(0, 0, 0),
        },
        sourceId,
      },
      {
        childIds: [],
        id: statementNodeId,
        kind: "paragraph",
        range: {
          end: position(statementStart + statementText.length, 1, statementText.length),
          sourceId,
          start: position(statementStart, 1, 0),
        },
        sourceId,
      },
      {
        childIds: [],
        id: secondStatementNodeId,
        kind: "paragraph",
        range: {
          end: position(
            secondStatementStart + secondStatementText.length,
            2,
            secondStatementText.length,
          ),
          sourceId,
          start: position(secondStatementStart, 2, 0),
        },
        sourceId,
      },
    ],
    recordKind: "agent-context-instruction-ir",
    sources: [
      {
        bom: "none",
        byteLength: Buffer.byteLength(text, "utf8"),
        encoding: "utf-8",
        id: sourceId,
        lineEnding: "lf",
        parseState: { state: "complete" },
        path: canonicalizeRepositoryRelativePath("AGENTS.md"),
        rootNodeId,
        sha256: createHash("sha256").update(text, "utf8").digest("hex"),
        text,
        utf16Length: text.length,
      },
    ],
    statements: [
      {
        classification: { state: "unclassified" },
        documentId,
        id: statementId,
        nodeIds: [statementNodeId],
        range: {
          end: position(statementStart + statementText.length, 1, statementText.length),
          sourceId,
          start: position(statementStart, 1, 0),
        },
        text: statementText,
      },
      {
        classification: { state: "unclassified" },
        documentId,
        id: secondStatementId,
        nodeIds: [secondStatementNodeId],
        range: {
          end: position(
            secondStatementStart + secondStatementText.length,
            2,
            secondStatementText.length,
          ),
          sourceId,
          start: position(secondStatementStart, 2, 0),
        },
        text: secondStatementText,
      },
    ],
    targets: [],
  };
  const validated = validateInstructionIr(value);
  if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
  const issued = createInstructionIrSnapshot(validated.value);
  if (!issued.ok) throw new Error(JSON.stringify(issued.issues));
  const ir = issued.value;
  const source = ir.sources[0];
  if (source === undefined) throw new Error("fixture source missing");
  const syntaxInput = {
    contractVersion: "0.1.0" as const,
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
    recordKind: "agent-context-syntax-structure-rule-input" as const,
  };
  const evidenceIndex = {
    conflicts: [],
    contractVersion: "0.1.0" as const,
    facts: [],
    issues: [],
    limits: {},
    metrics: {},
    uncertainty: "known" as const,
    uncertaintyReasons: [],
  } as never;
  return {
    input: {
      contractVersion: RULE_SCHEDULER_CONTRACT_VERSION,
      families: [
        { familyId: "syntax-structure", input: syntaxInput, options: undefined },
        {
          familyId: "repository-drift",
          input: {
            evidenceIndex,
            statements: includeStatement
              ? ir.statements.map((statement) => ({
                  dialect: "posix-shell" as const,
                  documentId: statement.documentId,
                  nodeIds: statement.nodeIds,
                  path: source.path,
                  range: statement.range,
                  sourceDigest: source.sha256,
                  statementId: statement.id,
                  text: statement.text,
                }))
              : [],
          },
          options: undefined,
        },
      ],
      policy: { failureThreshold: "error", severityOverrides: {} },
      recordKind: RULE_SCHEDULER_RECORD_KIND,
    },
    syntaxInput,
  };
}

describe("F15 deterministic rule scheduler", () => {
  test("declares one immutable static family graph covering F05-F14", () => {
    expect(RULE_FAMILY_DESCRIPTORS.map((entry) => entry.familyId).sort()).toEqual(
      [...RULE_FAMILY_IDS].sort(),
    );
    expect(RULE_FAMILY_DESCRIPTORS.map((entry) => entry.ticketId).sort()).toEqual([
      "F05",
      "F06",
      "F07",
      "F08",
      "F09",
      "F10",
      "F11",
      "F12",
      "F13",
      "F14",
    ]);
    expect(Object.isFrozen(RULE_FAMILY_DESCRIPTORS)).toBe(true);
    for (const descriptor of RULE_FAMILY_DESCRIPTORS) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.dependencies)).toBe(true);
      expect(Object.isFrozen(descriptor.ruleIds)).toBe(true);
    }
  });

  test("runs all genuine production families and returns a deeply immutable B04 result", async () => {
    const input = await fullRuleSchedulerInput();
    const efficiency = input.families.find((entry) => entry.familyId === "context-efficiency");
    if (efficiency?.familyId !== "context-efficiency") throw new Error("fixture missing");
    expect(evaluateContextEfficiencyRules(efficiency.input)).toMatchObject({ ok: true });
    const portability = input.families.find((entry) => entry.familyId === "portability");
    if (portability?.familyId !== "portability") throw new Error("fixture missing");
    const portabilityResult = evaluatePortabilityRules(portability.input);
    expect(portabilityResult.ok, JSON.stringify(portabilityResult)).toBe(true);
    const result = await scheduleRuleFamilies(input);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.families.map((entry) => entry.familyId).sort()).toEqual(
      [...RULE_FAMILY_IDS].sort(),
    );
    expect(result.executionOrder[0]).toBe("syntax-structure");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bundle)).toBe(true);
    expect(Object.isFrozen(result.sources[0])).toBe(true);
    const syntax = input.families.find((entry) => entry.familyId === "syntax-structure");
    if (syntax?.familyId !== "syntax-structure") throw new Error("syntax fixture missing");
    expect(result.sources[0]).toBe(syntax.input.ir.sources[0]);
    expect(result.sources[0]).toEqual(syntax.input.ir.sources[0]);
    expect(getSyntaxSuppressionFinalizationIssuance(result)).toBeNull();
    expect(getSyntaxSuppressionFinalizationIssuance(result.bundle)).toBeNull();
    expect(planApprovedMechanicalFixes(result)).toMatchObject({ ok: false });
  });

  test("is byte-stable across registration order, concurrency, and completion perturbations", async () => {
    const input = await fullRuleSchedulerInput();
    const expected = await scheduleRuleFamilies(input, { maximumConcurrency: 1, scheduleSeed: 0 });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const expectedBytes = JSON.stringify(expected.bundle);
    const orders = [
      [...input.families].reverse(),
      [...input.families].sort((left, right) => right.familyId.localeCompare(left.familyId)),
      [...input.families].sort((left, right) => left.familyId.localeCompare(right.familyId)),
    ];
    for (const [index, families] of orders.entries()) {
      const result = await scheduleRuleFamilies(withFamilyOrder(input, families), {
        maximumConcurrency: index + 2,
        scheduleSeed: index + 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(JSON.stringify(result.bundle)).toBe(expectedBytes);
    }
  });

  test("does not perturb the event loop when the default schedule seed is zero", async () => {
    const immediate = vi.spyOn(globalThis, "setImmediate");
    try {
      expect((await scheduleRuleFamilies(await fullRuleSchedulerInput())).ok).toBe(true);
      expect(immediate).not.toHaveBeenCalled();
    } finally {
      immediate.mockRestore();
    }
  });

  test("detaches B03 synchronously so later caller mutation cannot affect evaluation", async () => {
    const fixture = mutableIrInput(await fullRuleSchedulerInput());
    const pending = scheduleRuleFamilies(fixture.input, { scheduleSeed: 17 });
    const source = fixture.ir.sources[0] as unknown as { path: string; text: string };
    source.path = "MUTATED.md";
    source.text = "hostile mutation";
    const result = await pending;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.sources[0]?.path).toBe("AGENTS.md");
    expect(result.sources[0]?.text).toContain("Run npm run missing");
  });

  test("admits synchronous evaluator outputs before ordinary input or option mutation", async () => {
    const fixture = suppressionFixture();
    const syntax = fixture.input.families.find((entry) => entry.familyId === "syntax-structure");
    const drift = fixture.input.families.find((entry) => entry.familyId === "repository-drift");
    if (syntax?.familyId !== "syntax-structure" || drift?.familyId !== "repository-drift")
      throw new Error("fixture families missing");
    const options = { maximumDiagnostics: 100 };
    const input: RuleSchedulerInput = {
      ...fixture.input,
      families: fixture.input.families.map((entry) =>
        entry.familyId === "repository-drift" ? { ...entry, options } : entry,
      ),
    };
    const pending = scheduleRuleFamilies(input, { scheduleSeed: 29 });
    (syntax.input.documents as unknown[]).length = 0;
    (drift.input.statements as unknown[]).length = 0;
    options.maximumDiagnostics = 0;
    const result = await pending;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok)
      expect(result.suppressedDiagnostics.map((entry) => entry.ruleId)).toContain("ACL300");
  });

  test("rejects malformed, executable, duplicate, and cancelled requests without throwing", async () => {
    const input = await fullRuleSchedulerInput();
    const firstFamily = input.families[0];
    if (firstFamily === undefined) throw new Error("family fixture missing");
    const duplicate = withFamilyOrder(input, [...input.families, firstFamily]);
    await expect(scheduleRuleFamilies(duplicate)).resolves.toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
    await expect(scheduleRuleFamilies(new Proxy({}, {}))).resolves.toMatchObject({ ok: false });
    await expect(
      scheduleRuleFamilies({ ...input, policy: { failureThreshold: () => true } }),
    ).resolves.toMatchObject({ ok: false });
    const controller = new AbortController();
    controller.abort("repository-controlled reason");
    await expect(scheduleRuleFamilies(input, { signal: controller.signal })).resolves.toEqual({
      issues: [
        {
          code: "cancelled",
          familyId: null,
          message: "scheduling was cancelled",
          path: "$options.signal",
        },
      ],
      ok: false,
    });
  });

  test("rejects closed-contract violations across input, policy, and family requests", async () => {
    const input = await fullRuleSchedulerInput();
    const syntax = input.families.find((entry) => entry.familyId === "syntax-structure");
    if (syntax?.familyId !== "syntax-structure") throw new Error("syntax fixture missing");
    const cases: unknown[] = [
      null,
      {},
      { ...input, contractVersion: "9.9.9" },
      { ...input, families: [] },
      { ...input, policy: { failureThreshold: "fatal", severityOverrides: {} } },
      { ...input, policy: { failureThreshold: "error", severityOverrides: null } },
      { ...input, policy: { failureThreshold: "error", severityOverrides: { ACL999: "error" } } },
      { ...input, policy: { failureThreshold: "error", severityOverrides: { ACL300: "fatal" } } },
      {
        ...input,
        families: [{ familyId: "future-family", input: {}, options: undefined }],
      },
      {
        ...input,
        families: [{ ...syntax, input: () => undefined }],
      },
      {
        ...input,
        families: [{ ...syntax, options: {} }],
      },
      {
        ...input,
        families: [{ ...syntax, input: { ...syntax.input, ir: {} } }],
      },
      {
        ...input,
        families: input.families.map((entry) =>
          entry.familyId === "security"
            ? { ...entry, input: { ...entry.input, ir: structuredClone(syntax.input.ir) } }
            : entry,
        ),
      },
    ];
    for (const candidate of cases)
      await expect(scheduleRuleFamilies(candidate)).resolves.toMatchObject({ ok: false });

    const accessor: Record<string, unknown> = { ...input };
    Object.defineProperty(accessor, "policy", { enumerable: true, get: () => input.policy });
    await expect(scheduleRuleFamilies(accessor)).resolves.toMatchObject({ ok: false });
    const sparse = [...input.families];
    Reflect.deleteProperty(sparse, "0");
    await expect(scheduleRuleFamilies({ ...input, families: sparse })).resolves.toMatchObject({
      ok: false,
    });
  });

  test("validates operational limits and reports a deadline after async perturbation", async () => {
    const input = await fullRuleSchedulerInput();
    for (const options of [
      null,
      [],
      new Date(),
      { maximumConcurrency: 0 },
      { maximumConcurrency: 11 },
      { maximumDiagnostics: 0 },
      { maximumDurationMs: 0 },
      { scheduleSeed: -1 },
      { unknown: true },
      { signal: {} },
    ])
      await expect(scheduleRuleFamilies(input, options)).resolves.toMatchObject({
        issues: [{ code: "invalid-options" }],
        ok: false,
      });
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "maximumConcurrency", {
      enumerable: true,
      get: () => 1,
    });
    await expect(scheduleRuleFamilies(input, accessorOptions)).resolves.toMatchObject({
      ok: false,
    });

    let now = 0;
    const originalImmediate = globalThis.setImmediate;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const immediate = vi.spyOn(globalThis, "setImmediate").mockImplementation((callback, ...args) =>
      originalImmediate(() => {
        now = 2;
        callback(...args);
      }),
    );
    try {
      await expect(
        scheduleRuleFamilies(input, { maximumDurationMs: 1, scheduleSeed: 1 }),
      ).resolves.toMatchObject({ issues: [{ code: "deadline-exceeded" }], ok: false });
    } finally {
      immediate.mockRestore();
      clock.mockRestore();
    }
  });

  test("cancels during seeded completion perturbation without reflecting its reason", async () => {
    const controller = new AbortController();
    const originalImmediate = globalThis.setImmediate;
    const immediate = vi.spyOn(globalThis, "setImmediate").mockImplementation((callback, ...args) =>
      originalImmediate(() => {
        controller.abort("untrusted secret reason");
        callback(...args);
      }),
    );
    try {
      const result = await scheduleRuleFamilies(await fullRuleSchedulerInput(), {
        scheduleSeed: 7,
        signal: controller.signal,
      });
      expect(result).toMatchObject({ issues: [{ code: "cancelled" }], ok: false });
      expect(JSON.stringify(result)).not.toContain("untrusted secret reason");
    } finally {
      immediate.mockRestore();
    }
  });

  test("F08 reuses an issued snapshot while serialized lookalikes take bounded admission", async () => {
    const input = await fullRuleSchedulerInput();
    const request = input.families.find((entry) => entry.familyId === "conflicts-duplication");
    if (request?.familyId !== "conflicts-duplication") throw new Error("F08 fixture missing");
    const issued = evaluateConflictsDuplicationRules(request.input, { maximumStringBytes: 128 });
    const serialized = evaluateConflictsDuplicationRules(
      { ...request.input, ir: structuredClone(request.input.ir) },
      { maximumStringBytes: 128 },
    );
    expect(issued.ok, JSON.stringify(issued)).toBe(true);
    expect(serialized).toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
  });

  test("applies off/severity policy before suppression and all failure thresholds", async () => {
    const fixture = suppressionFixture();
    const withPolicy = (
      failureThreshold: "error" | "never" | "warning",
      severity: "off" | "warning",
    ): RuleSchedulerInput => ({
      ...fixture.input,
      policy: { failureThreshold, severityOverrides: { ACL300: severity } },
    });
    const disabledAtError = await scheduleRuleFamilies(withPolicy("error", "off"));
    expect(disabledAtError.ok).toBe(true);
    if (disabledAtError.ok) {
      expect(disabledAtError.bundle.diagnostics.map((entry) => entry.ruleId)).toEqual(["ACL109"]);
      expect(disabledAtError.summary.shouldFail).toBe(false);
      expect(disabledAtError.summary.suppressedCount).toBe(0);
    }
    const disabledAtWarning = await scheduleRuleFamilies(withPolicy("warning", "off"));
    expect(disabledAtWarning.ok).toBe(true);
    if (disabledAtWarning.ok) expect(disabledAtWarning.summary.shouldFail).toBe(true);
    const warning = await scheduleRuleFamilies(withPolicy("warning", "warning"));
    expect(warning.ok).toBe(true);
    if (warning.ok) {
      expect(warning.summary.active.warning).toBe(1);
      expect(warning.summary.shouldFail).toBe(true);
    }
    const never = await scheduleRuleFamilies(withPolicy("never", "warning"));
    expect(never.ok).toBe(true);
    if (never.ok) expect(never.summary.shouldFail).toBe(false);
    await expect(
      scheduleRuleFamilies(fixture.input, { maximumDiagnostics: 1 }),
    ).resolves.toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
  });

  test("requires F09 to reconcile every snapshot statement exactly once", async () => {
    await expect(scheduleRuleFamilies(suppressionFixture(false).input)).resolves.toMatchObject({
      issues: [
        {
          code: "dependency-failure",
          familyId: "repository-drift",
          path: "$.families.repository-drift.input.statements",
        },
      ],
      ok: false,
    });
  });

  test("canonicalizes complete F09 statement input order before evaluation", async () => {
    const fixture = suppressionFixture();
    const expected = await scheduleRuleFamilies(fixture.input);
    expect(expected.ok).toBe(true);
    const reversed: RuleSchedulerInput = {
      ...fixture.input,
      families: fixture.input.families.map((entry) =>
        entry.familyId === "repository-drift"
          ? {
              ...entry,
              input: { ...entry.input, statements: [...entry.input.statements].reverse() },
            }
          : entry,
      ),
    };
    const actual = await scheduleRuleFamilies(reversed, { scheduleSeed: 31 });
    expect(actual.ok, JSON.stringify(actual)).toBe(true);
    if (expected.ok && actual.ok) expect(actual.bundle).toEqual(expected.bundle);
  });

  test("rejects hostile nested F09 statement data without invoking it", async () => {
    const base = suppressionFixture().input;
    const drift = base.families.find((entry) => entry.familyId === "repository-drift");
    if (drift?.familyId !== "repository-drift") throw new Error("drift fixture missing");
    const statement = drift.input.statements[0];
    if (statement === undefined) throw new Error("statement fixture missing");
    let calls = 0;
    const accessorRange = {
      end: statement.range.end,
      sourceId: statement.range.sourceId,
      get start(): SourcePosition {
        calls += 1;
        return statement.range.start;
      },
    };
    const withStatement = (candidate: unknown): RuleSchedulerInput => ({
      ...base,
      families: base.families.map((entry) =>
        entry.familyId === "repository-drift"
          ? { ...entry, input: { ...entry.input, statements: [candidate] } }
          : entry,
      ) as readonly RuleFamilyRequest[],
    });
    await expect(
      scheduleRuleFamilies(withStatement({ ...statement, range: accessorRange })),
    ).resolves.toMatchObject({ ok: false });
    expect(calls).toBe(0);
    const proxyNodeIds = new Proxy([...statement.nodeIds], {
      get(): undefined {
        calls += 1;
        return undefined;
      },
    });
    await expect(
      scheduleRuleFamilies(withStatement({ ...statement, nodeIds: proxyNodeIds })),
    ).resolves.toMatchObject({ ok: false });
    expect(calls).toBe(0);
    const revoked = Proxy.revocable([...statement.nodeIds], {});
    revoked.revoke();
    await expect(
      scheduleRuleFamilies(withStatement({ ...statement, nodeIds: revoked.proxy })),
    ).resolves.toMatchObject({ ok: false });
  });

  test("applies exact B08 suppression to raw diagnostics before fingerprint deduplication", async () => {
    const fixture = suppressionFixture();
    const scheduled = await scheduleRuleFamilies(fixture.input);
    expect(scheduled.ok, JSON.stringify(scheduled)).toBe(true);
    if (!scheduled.ok) return;
    const diagnostic = scheduled.bundle.diagnostics.find((entry) => entry.ruleId === "ACL300");
    expect(diagnostic).toBeDefined();
    expect(scheduled.summary.suppressedCount).toBe(1);
    expect(scheduled.suppressedDiagnostics.map((entry) => entry.ruleId)).toContain("ACL300");

    const syntax = evaluateSyntaxStructureRules(fixture.syntaxInput);
    expect(syntax.ok).toBe(true);
    if (!syntax.ok || diagnostic === undefined) return;
    const alternate: Diagnostic = {
      ...diagnostic,
      id: `${diagnostic.id}:alternate` as Diagnostic["id"],
      primary: {
        ...diagnostic.primary,
        range:
          syntax.sources[0]?.text === undefined
            ? diagnostic.primary.range
            : (syntax.bundle.suppressions[0]?.directive.range ?? diagnostic.primary.range),
      },
    };
    const raw: DiagnosticBundle = {
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: [alternate, diagnostic],
      recordKind: "agent-context-diagnostics",
      suppressions: syntax.bundle.suppressions,
    };
    const finalized = finalizeScheduledSyntaxSuppressions(syntax, raw.diagnostics);
    expect(finalized.ok, JSON.stringify(finalized)).toBe(true);
    if (!finalized.ok) return;
    expect(getSyntaxSuppressionFinalizationIssuance(finalized)).toBe("scheduled-reporting");
    expect(planApprovedMechanicalFixes(finalized)).toMatchObject({ ok: false });
    const canonical = canonicalizeRuleDiagnostics(finalized.bundle, syntax.sources, {
      failureThreshold: "error",
      severityOverrides: {},
    });
    expect(canonical.ok, JSON.stringify(canonical)).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.bundle.diagnostics).toHaveLength(1);
    expect(canonical.bundle.diagnostics[0]?.primary.range.start.line).toBe(0);
    expect(
      canonical.bundle.diagnostics[0]?.related.some(
        (entry) => entry.kind === "source" && entry.location.range.start.line === 1,
      ),
    ).toBe(true);
    expect(canonical.bundle.suppressions[0]?.matchedPathFingerprints).toEqual([
      diagnostic.fingerprints.path.value,
    ]);
  });

  test("allows max-minus-one raw diagnostics plus ACL109 and reports max overflow", async () => {
    const fixture = suppressionFixture();
    const scheduled = await scheduleRuleFamilies(fixture.input);
    if (!scheduled.ok) throw new Error(JSON.stringify(scheduled));
    const syntax = evaluateSyntaxStructureRules(fixture.syntaxInput);
    if (!syntax.ok) throw new Error(JSON.stringify(syntax));
    const visible = scheduled.visibleDiagnostics[0];
    if (visible === undefined) throw new Error("visible diagnostic fixture missing");
    const diagnostics = (count: number): readonly Diagnostic[] =>
      Array.from({ length: count }, (_, index) => ({
        ...visible,
        id: `${visible.id}:${String(index)}` as Diagnostic["id"],
      }));
    const exact = finalizeScheduledSyntaxSuppressions(syntax, diagnostics(9_999));
    expect(exact.ok, JSON.stringify(exact)).toBe(true);
    if (exact.ok) expect(exact.bundle.diagnostics).toHaveLength(10_000);
    const exceeded = finalizeScheduledSyntaxSuppressions(syntax, diagnostics(10_000));
    expect(exceeded).toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
  });

  test("canonical output is deeply detached and duplicate IDs fail before matching", async () => {
    const scheduled = await scheduleRuleFamilies(suppressionFixture().input);
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) return;
    const diagnostic = scheduled.bundle.diagnostics[0];
    if (diagnostic === undefined) throw new Error("diagnostic fixture missing");
    const mutableDiagnostic = structuredClone(diagnostic);
    const mutableSuppressions = structuredClone(scheduled.bundle.suppressions);
    (mutableDiagnostic as { suggestion: Diagnostic["suggestion"] }).suggestion = {
      fixPlan: null,
      message: "Use a declared task.",
    };
    (mutableDiagnostic as { related: Diagnostic["related"] }).related = [
      {
        id: "evidence:scheduler:mutable" as never,
        kind: "source",
        label: "Mutable evidence",
        location: mutableDiagnostic.primary,
      },
    ];
    const raw: DiagnosticBundle = {
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: [mutableDiagnostic],
      recordKind: "agent-context-diagnostics",
      suppressions: mutableSuppressions,
    };
    const canonical = canonicalizeRuleDiagnostics(raw, scheduled.sources, {
      failureThreshold: "error",
      severityOverrides: { ACL300: "warning" },
    });
    expect(canonical.ok, JSON.stringify(canonical)).toBe(true);
    if (!canonical.ok) return;
    const before = JSON.stringify(canonical.bundle);
    (mutableDiagnostic.primary as { path: string }).path = "changed.md";
    (mutableDiagnostic.primary.range.start as { line: number }).line = 999;
    (mutableDiagnostic.fingerprints.path as { value: string }).value = "f".repeat(64);
    (mutableDiagnostic.fingerprintBasis.path as unknown as { anchor: string }).anchor = "changed";
    (mutableDiagnostic.suggestion as { message: string }).message = "changed";
    (mutableDiagnostic.related[0] as { label: string }).label = "changed";
    const mutableSuppression = mutableSuppressions[0];
    if (mutableSuppression !== undefined) {
      (mutableSuppression.directive as { path: string }).path = "changed.md";
      (mutableSuppression as { reason: string | null }).reason = "changed";
    }
    (mutableSuppressions as unknown[]).length = 0;
    (raw.diagnostics as unknown[]).length = 0;
    expect(JSON.stringify(canonical.bundle)).toBe(before);
    expect(Object.isFrozen(canonical.bundle.diagnostics[0]?.primary.range.start)).toBe(true);
    expect(canonical.bundle.diagnostics[0]?.severity).toBe("warning");

    const duplicateIds: DiagnosticBundle = {
      ...scheduled.bundle,
      diagnostics: [diagnostic, diagnostic],
    };
    expect(
      canonicalizeRuleDiagnostics(duplicateIds, scheduled.sources, {
        failureThreshold: "error",
        severityOverrides: {},
      }),
    ).toMatchObject({ issues: [{ code: "invalid-output" }], ok: false });
  });

  test("fails closed when fingerprint duplicates disagree about suggestions", async () => {
    const scheduled = await scheduleRuleFamilies(suppressionFixture().input);
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) return;
    const diagnostic = scheduled.bundle.diagnostics[0];
    if (diagnostic === undefined) throw new Error("diagnostic fixture missing");
    const duplicate = (suffix: string, message: string | null): Diagnostic => ({
      ...diagnostic,
      id: `${diagnostic.id}:${suffix}` as Diagnostic["id"],
      suggestion: message === null ? null : { fixPlan: null, message },
    });
    const canonicalize = (
      diagnostics: readonly Diagnostic[],
    ): RuleDiagnosticCanonicalizationResult =>
      canonicalizeRuleDiagnostics(
        {
          contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
          diagnostics,
          recordKind: "agent-context-diagnostics",
          suppressions: [],
        },
        scheduled.sources,
        { failureThreshold: "error", severityOverrides: {} },
      );
    expect(
      canonicalize([duplicate("null", null), duplicate("one", "Use the task that exists.")]),
    ).toMatchObject({ issues: [{ code: "invalid-output" }], ok: false });
    expect(
      canonicalize([
        duplicate("one", "Use the task that exists."),
        duplicate("two", "Use another task."),
      ]),
    ).toMatchObject({ issues: [{ code: "invalid-output" }], ok: false });
    const equal = canonicalize([
      duplicate("one", "Use the task that exists."),
      duplicate("two", "Use the task that exists."),
    ]);
    expect(equal.ok, JSON.stringify(equal)).toBe(true);
    if (equal.ok)
      expect(equal.bundle.diagnostics[0]?.suggestion?.message).toBe("Use the task that exists.");
  });

  test("merges severity/evidence and rejects message or evidence-ID conflicts", async () => {
    const scheduled = await scheduleRuleFamilies(suppressionFixture().input);
    if (!scheduled.ok) throw new Error(JSON.stringify(scheduled));
    const diagnostic = scheduled.bundle.diagnostics[0];
    if (diagnostic === undefined) throw new Error("diagnostic fixture missing");
    const evidence = {
      id: "evidence:scheduler:test" as never,
      kind: "source" as const,
      label: "First evidence",
      location: diagnostic.primary,
    };
    const duplicate = (suffix: string, overrides: Partial<Diagnostic> = {}): Diagnostic => ({
      ...diagnostic,
      id: `${diagnostic.id}:${suffix}` as Diagnostic["id"],
      ...overrides,
    });
    const run = (diagnostics: readonly Diagnostic[]): RuleDiagnosticCanonicalizationResult =>
      canonicalizeRuleDiagnostics(
        {
          contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
          diagnostics,
          recordKind: "agent-context-diagnostics",
          suppressions: [],
        },
        scheduled.sources,
        { failureThreshold: "error", severityOverrides: {} },
      );
    expect(
      run([duplicate("a"), duplicate("b", { message: "Conflicting diagnostic message." })]),
    ).toMatchObject({ issues: [{ code: "invalid-output" }], ok: false });
    expect(
      run([
        duplicate("a", { related: [evidence] }),
        duplicate("b", {
          related: [{ ...evidence, label: "Different evidence with reused ID" }],
        }),
      ]),
    ).toMatchObject({ issues: [{ code: "invalid-output" }], ok: false });
    const merged = run([
      duplicate("a", { related: [evidence], severity: "info" }),
      duplicate("b", {
        related: [{ ...evidence, id: "evidence:scheduler:test-2" as never }],
        severity: "error",
      }),
    ]);
    expect(merged.ok, JSON.stringify(merged)).toBe(true);
    if (merged.ok) {
      expect(merged.bundle.diagnostics[0]?.severity).toBe("error");
      expect(merged.bundle.diagnostics[0]?.related).toHaveLength(1);
    }
  });

  test("canonicalizer rejects hostile containers and nested accessors without invocation", async () => {
    const scheduled = await scheduleRuleFamilies(suppressionFixture().input);
    if (!scheduled.ok) throw new Error(JSON.stringify(scheduled));
    expect(
      canonicalizeRuleDiagnostics(new Proxy({}, {}), scheduled.sources, {
        failureThreshold: "error",
        severityOverrides: {},
      }),
    ).toMatchObject({ ok: false });
    const diagnostic = structuredClone(scheduled.bundle.diagnostics[0]);
    if (diagnostic === undefined) throw new Error("diagnostic fixture missing");
    let calls = 0;
    Object.defineProperty(diagnostic.primary.range, "start", {
      enumerable: true,
      get: (): unknown => {
        calls += 1;
        return {};
      },
    });
    expect(
      canonicalizeRuleDiagnostics(
        {
          contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
          diagnostics: [diagnostic],
          recordKind: "agent-context-diagnostics",
          suppressions: [],
        },
        scheduled.sources,
        { failureThreshold: "error", severityOverrides: {} },
      ),
    ).toMatchObject({ ok: false });
    expect(calls).toBe(0);
  });
});
