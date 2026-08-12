import { describe, expect, test, vi } from "vitest";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  INSTRUCTION_IR_SNAPSHOT_LIMITS,
  computePathFingerprint,
  computeSemanticFingerprint,
} from "@agent-context/core";

import { RULE_REGISTRY, canonicalizeRuleDiagnostics, scheduleRuleFamilies } from "../src/index.js";

import { fullRuleSchedulerInput } from "./helpers/rule-scheduler-full-families.js";

import type {
  AtomicFixPlan,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticSourceLocation,
  FixPlanId,
  RelatedEvidenceId,
  SourceRelatedEvidence,
} from "@agent-context/core";
import type {
  RepositoryDriftFamilyRequest,
  RepositoryDriftStatementInput,
  RuleFamilyRequest,
  RuleSchedulerInput,
  RuleSchedulerSuccess,
} from "../src/index.js";

interface BoundaryFixture {
  readonly input: RuleSchedulerInput;
  readonly result: RuleSchedulerSuccess;
}

async function boundaryFixture(): Promise<BoundaryFixture> {
  const input = await fullRuleSchedulerInput();
  const result = await scheduleRuleFamilies(input);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return { input, result };
}

function sourceEvidence(
  id: string,
  label: string,
  location: DiagnosticSourceLocation,
): SourceRelatedEvidence {
  return {
    id: id as RelatedEvidenceId,
    kind: "source",
    label,
    location,
  };
}

function mechanicalPlan(location: DiagnosticSourceLocation): AtomicFixPlan {
  return {
    application: "atomic",
    id: "fix:boundary:detachment" as FixPlanId,
    operations: [
      {
        kind: "text-edit",
        newText: "Run npm run fixed",
        path: location.path,
        range: location.range,
        sourceDigest: location.sourceDigest,
        sourceId: location.sourceId,
      },
    ],
    safety: "mechanical",
    title: "Replace the missing task",
  };
}

function bundleOf(diagnostics: readonly Diagnostic[]): DiagnosticBundle {
  return {
    contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
    diagnostics,
    recordKind: "agent-context-diagnostics",
    suppressions: [],
  };
}

function withDriftRequest(
  input: RuleSchedulerInput,
  update: (request: RepositoryDriftFamilyRequest) => RepositoryDriftFamilyRequest,
): RuleSchedulerInput {
  return {
    ...input,
    families: input.families.map((request): RuleFamilyRequest =>
      request.familyId === "repository-drift" ? update(request) : request,
    ),
  };
}

function replaceFamily(
  input: RuleSchedulerInput,
  familyId: RuleFamilyRequest["familyId"],
  update: (request: RuleFamilyRequest) => RuleFamilyRequest,
): RuleSchedulerInput {
  return {
    ...input,
    families: input.families.map((request) =>
      request.familyId === familyId ? update(request) : request,
    ),
  };
}

describe("F15 scheduler hostile and boundary behavior", () => {
  test("rejects hostile public canonicalizer inputs without invoking accessors or proxy traps", async () => {
    const { result } = await boundaryFixture();
    let calls = 0;
    const accessorBundle: Record<string, unknown> = {
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      recordKind: "agent-context-diagnostics",
      suppressions: [],
    };
    Object.defineProperty(accessorBundle, "diagnostics", {
      enumerable: true,
      get: () => {
        calls += 1;
        return result.bundle.diagnostics;
      },
    });
    const policy: Record<string, unknown> = { failureThreshold: "error" };
    Object.defineProperty(policy, "severityOverrides", {
      enumerable: true,
      get: () => {
        calls += 1;
        return {};
      },
    });
    const proxyBundle = new Proxy(structuredClone(result.bundle), {
      get: (): undefined => {
        calls += 1;
        return undefined;
      },
    });
    const proxySources = new Proxy([...result.sources], {
      get: (): undefined => {
        calls += 1;
        return undefined;
      },
    });
    const revoked = Proxy.revocable([...result.sources], {});
    revoked.revoke();

    expect(
      canonicalizeRuleDiagnostics(accessorBundle, result.sources, {
        failureThreshold: "error",
        severityOverrides: {},
      }),
    ).toMatchObject({ ok: false });
    expect(canonicalizeRuleDiagnostics(result.bundle, result.sources, policy)).toMatchObject({
      ok: false,
    });
    expect(
      canonicalizeRuleDiagnostics(proxyBundle, result.sources, {
        failureThreshold: "error",
        severityOverrides: {},
      }),
    ).toMatchObject({ ok: false });
    expect(
      canonicalizeRuleDiagnostics(result.bundle, proxySources, {
        failureThreshold: "error",
        severityOverrides: {},
      }),
    ).toMatchObject({ ok: false });
    expect(
      canonicalizeRuleDiagnostics(result.bundle, revoked.proxy, {
        failureThreshold: "error",
        severityOverrides: {},
      }),
    ).toMatchObject({ ok: false });
    expect(calls).toBe(0);
  });

  test("deeply detaches suggestions, fix plans, evidence, and suppression records", async () => {
    const { result } = await boundaryFixture();
    const original = result.visibleDiagnostics[0];
    const suppressedDiagnostic = result.suppressedDiagnostics[0];
    const suppression = result.bundle.suppressions[0];
    if (original === undefined || suppressedDiagnostic === undefined || suppression === undefined)
      throw new Error("fixture is incomplete");
    const diagnostic = structuredClone(original);
    const related = sourceEvidence(
      "evidence:boundary:diagnostic",
      "Original diagnostic evidence",
      diagnostic.primary,
    );
    const suppressionEvidence = sourceEvidence(
      "evidence:boundary:suppression",
      "Original suppression evidence",
      suppression.directive,
    );
    const mutableDiagnostic: Diagnostic = {
      ...diagnostic,
      related: [related],
      suggestion: {
        fixPlan: mechanicalPlan(diagnostic.primary),
        message: "Use the available task.",
      },
    };
    const mutableSuppression = {
      ...structuredClone(suppression),
      evidence: [suppressionEvidence],
    };
    const raw: DiagnosticBundle = {
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: [mutableDiagnostic, structuredClone(suppressedDiagnostic)],
      recordKind: "agent-context-diagnostics",
      suppressions: [mutableSuppression],
    };
    const canonical = canonicalizeRuleDiagnostics(raw, result.sources, {
      failureThreshold: "error",
      severityOverrides: {},
    });
    expect(canonical.ok, JSON.stringify(canonical)).toBe(true);
    if (!canonical.ok) return;
    const before = JSON.stringify(canonical.bundle);

    const mutableSuggestion = mutableDiagnostic.suggestion as unknown as {
      fixPlan: { operations: { newText: string }[]; title: string };
      message: string;
    };
    mutableSuggestion.message = "mutated suggestion";
    mutableSuggestion.fixPlan.title = "mutated plan";
    mutableSuggestion.fixPlan.operations[0] = { newText: "mutated edit" };
    (related as unknown as { label: string; location: { path: string } }).label = "mutated";
    (related as unknown as { location: { path: string } }).location.path = "mutated.md";
    (mutableSuppression as unknown as { reason: string }).reason = "mutated reason";
    (mutableSuppression.targetRuleIds as unknown as string[])[0] = "ACL999";
    (mutableSuppression.matchedPathFingerprints as unknown as string[])[0] = "f".repeat(64);
    (mutableSuppression.directive as unknown as { path: string }).path = "mutated.md";
    (suppressionEvidence as unknown as { label: string }).label = "mutated";

    expect(JSON.stringify(canonical.bundle)).toBe(before);
    const outputDiagnostic = canonical.bundle.diagnostics[0];
    const outputSuppression = canonical.bundle.suppressions[0];
    expect(Object.isFrozen(outputDiagnostic?.suggestion?.fixPlan?.operations[0])).toBe(true);
    expect(Object.isFrozen(outputDiagnostic?.related[0])).toBe(true);
    expect(Object.isFrozen(outputSuppression?.directive)).toBe(true);
    expect(Object.isFrozen(outputSuppression?.evidence[0])).toBe(true);
  });

  test("selects the earliest duplicate primary and preserves canonically merged evidence", async () => {
    const { result } = await boundaryFixture();
    const earlierLocation = result.suppressedDiagnostics[0]?.primary;
    const later = result.visibleDiagnostics[0];
    if (earlierLocation === undefined || later === undefined)
      throw new Error("fixture is incomplete");
    const sharedLocation = later.primary;
    const earlier: Diagnostic = {
      ...later,
      id: `${later.id}:earlier` as Diagnostic["id"],
      primary: earlierLocation,
      related: [sourceEvidence("evidence:boundary:z", "Shared evidence", sharedLocation)],
    };
    const laterDuplicate: Diagnostic = {
      ...later,
      id: `${later.id}:later` as Diagnostic["id"],
      related: [sourceEvidence("evidence:boundary:a", "Shared evidence", sharedLocation)],
    };
    const canonical = canonicalizeRuleDiagnostics(
      bundleOf([laterDuplicate, earlier]),
      result.sources,
      { failureThreshold: "error", severityOverrides: {} },
    );
    expect(canonical.ok, JSON.stringify(canonical)).toBe(true);
    if (!canonical.ok) return;
    const merged = canonical.bundle.diagnostics[0];
    expect(merged?.primary).toEqual(earlierLocation);
    expect(merged?.related.map((entry) => entry.id)).toContain("evidence:boundary:a");
    expect(merged?.related.map((entry) => entry.id)).not.toContain("evidence:boundary:z");
    expect(
      merged?.related.some((entry) => entry.label === "Duplicate diagnostic primary evidence"),
    ).toBe(true);
    expect(
      merged?.related.every((entry, index, values) => {
        const previous = values[index - 1];
        return previous === undefined || previous.id < entry.id;
      }),
    ).toBe(true);
  });

  test("fails closed on conflicting duplicate messages and merged related-evidence overflow", async () => {
    const { result } = await boundaryFixture();
    const base = result.visibleDiagnostics[0];
    if (base === undefined) throw new Error("fixture diagnostic missing");
    const conflict: Diagnostic = {
      ...base,
      id: `${base.id}:conflict` as Diagnostic["id"],
      message: "Conflicting duplicate message.",
    };
    expect(
      canonicalizeRuleDiagnostics(bundleOf([base, conflict]), result.sources, {
        failureThreshold: "error",
        severityOverrides: {},
      }),
    ).toMatchObject({ issues: [{ code: "invalid-output" }], ok: false });

    const evidence = Array.from({ length: 129 }, (_, index) =>
      sourceEvidence(
        `evidence:boundary:overflow:${String(index).padStart(3, "0")}`,
        `Evidence ${String(index)}`,
        base.primary,
      ),
    );
    const left: Diagnostic = {
      ...base,
      id: `${base.id}:overflow-left` as Diagnostic["id"],
      related: evidence.slice(0, 65),
    };
    const right: Diagnostic = {
      ...base,
      id: `${base.id}:overflow-right` as Diagnostic["id"],
      related: evidence.slice(65),
    };
    expect(
      canonicalizeRuleDiagnostics(bundleOf([left, right]), result.sources, {
        failureThreshold: "error",
        severityOverrides: {},
      }),
    ).toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
  });

  test("observes cancellation raised during a seeded completion yield", async () => {
    const input = await fullRuleSchedulerInput();
    const controller = new AbortController();
    const originalImmediate = globalThis.setImmediate;
    let cancelled = false;
    const immediate = vi.spyOn(globalThis, "setImmediate").mockImplementation((callback, ...args) =>
      originalImmediate(() => {
        if (!cancelled) {
          cancelled = true;
          controller.abort("repository-controlled reason");
        }
        callback(...args);
      }),
    );
    try {
      await expect(
        scheduleRuleFamilies(input, { scheduleSeed: 7, signal: controller.signal }),
      ).resolves.toEqual({
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
    } finally {
      immediate.mockRestore();
    }
  });

  test("reuses the complete issued source snapshot without field loss", async () => {
    const { input, result } = await boundaryFixture();
    const syntax = input.families.find((request) => request.familyId === "syntax-structure");
    if (syntax?.familyId !== "syntax-structure") throw new Error("syntax fixture missing");
    expect(result.sources).toHaveLength(syntax.input.ir.sources.length);
    for (const [index, expected] of syntax.input.ir.sources.entries()) {
      const actual = result.sources[index];
      if (actual === undefined) throw new Error("result source missing");
      expect(actual).toBe(expected);
      const keys = Object.keys(expected).sort();
      expect(Object.keys(actual).sort()).toEqual(keys);
      for (const key of keys)
        expect((actual as unknown as Record<string, unknown>)[key]).toEqual(
          (expected as unknown as Record<string, unknown>)[key],
        );
      expect(Object.isFrozen(actual)).toBe(true);
    }
  });

  test("enforces policy and F09 collection bounds before family execution", async () => {
    const input = await fullRuleSchedulerInput();
    const excessiveOverrides = Object.fromEntries(
      Array.from({ length: RULE_REGISTRY.rules.length + 1 }, (_, index) => [
        `ACL-boundary-${String(index)}`,
        "error",
      ]),
    );
    await expect(
      scheduleRuleFamilies({
        ...input,
        policy: { failureThreshold: "error", severityOverrides: excessiveOverrides },
      }),
    ).resolves.toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });

    const drift = input.families.find((request) => request.familyId === "repository-drift");
    if (drift?.familyId !== "repository-drift") throw new Error("drift fixture missing");
    const statement = drift.input.statements[0];
    if (statement === undefined) throw new Error("statement fixture missing");
    const overLimitStatements = Array.from(
      { length: INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumStatements + 1 },
      () => statement,
    );
    await expect(
      scheduleRuleFamilies(
        withDriftRequest(input, (request) => ({
          ...request,
          input: { ...request.input, statements: overLimitStatements },
        })),
      ),
    ).resolves.toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
  });

  test("reports an evaluator family failure for a reconciled but unsupported F09 dialect", async () => {
    const input = await fullRuleSchedulerInput();
    const malformed = withDriftRequest(input, (request) => ({
      ...request,
      input: {
        ...request.input,
        statements: request.input.statements.map((statement, index) =>
          index === 0 ? { ...statement, dialect: "future-shell" as never } : statement,
        ),
      },
    }));
    await expect(scheduleRuleFamilies(malformed)).resolves.toMatchObject({
      issues: [{ code: "family-failure", familyId: "repository-drift" }],
      ok: false,
    });

    const malformedSyntax = replaceFamily(input, "syntax-structure", (request) => {
      if (request.familyId !== "syntax-structure") throw new Error("syntax request mismatch");
      return { ...request, input: { ...request.input, documents: null as never } };
    });
    await expect(scheduleRuleFamilies(malformedSyntax)).resolves.toMatchObject({
      issues: [{ code: "family-failure", familyId: "syntax-structure" }],
      ok: false,
    });
  });

  test("covers closed request, option, and policy descriptor boundaries", async () => {
    const input = await fullRuleSchedulerInput();
    const syntax = input.families.find((request) => request.familyId === "syntax-structure");
    const drift = input.families.find((request) => request.familyId === "repository-drift");
    const security = input.families.find((request) => request.familyId === "security");
    if (
      syntax?.familyId !== "syntax-structure" ||
      drift?.familyId !== "repository-drift" ||
      security?.familyId !== "security"
    )
      throw new Error("family fixtures missing");

    await expect(
      scheduleRuleFamilies({ ...input, families: [syntax, syntax] }),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });
    await expect(scheduleRuleFamilies({ ...input, families: [drift] })).resolves.toMatchObject({
      issues: [{ code: "dependency-failure" }],
      ok: false,
    });
    await expect(
      scheduleRuleFamilies(
        replaceFamily(input, "security", (request) => {
          if (request.familyId !== "security") throw new Error("security request mismatch");
          return { ...request, options: new Proxy({}, {}) };
        }),
      ),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });

    const nullFamilyInput = replaceFamily(input, "security", (request) => {
      if (request.familyId !== "security") throw new Error("security request mismatch");
      return { ...request, input: null as never };
    });
    await expect(scheduleRuleFamilies(nullFamilyInput)).resolves.toMatchObject({
      issues: [{ code: "invalid-input" }],
      ok: false,
    });
    const proxyFamilyInput = replaceFamily(input, "security", (request) => {
      if (request.familyId !== "security") throw new Error("security request mismatch");
      return { ...request, input: new Proxy({ ...request.input }, {}) };
    });
    await expect(scheduleRuleFamilies(proxyFamilyInput)).resolves.toMatchObject({
      issues: [{ code: "invalid-input" }],
      ok: false,
    });
    const missingIr = { ...security.input } as Record<string, unknown>;
    Reflect.deleteProperty(missingIr, "ir");
    await expect(
      scheduleRuleFamilies(
        replaceFamily(input, "security", (request) => ({ ...request, input: missingIr }) as never),
      ),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });

    const foreignInput = Object.assign(
      Object.create({ inherited: true }) as object,
      security.input,
    );
    await expect(
      scheduleRuleFamilies(
        replaceFamily(
          input,
          "security",
          (request) => ({ ...request, input: foreignInput }) as never,
        ),
      ),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });

    const arrayInput = Object.assign([], security.input);
    await expect(
      scheduleRuleFamilies(
        replaceFamily(input, "security", (request) => ({ ...request, input: arrayInput }) as never),
      ),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });

    const accessorInput = { ...security.input } as Record<string, unknown>;
    let calls = 0;
    Object.defineProperty(accessorInput, "statementDialects", {
      enumerable: true,
      get: () => {
        calls += 1;
        return [];
      },
    });
    await expect(
      scheduleRuleFamilies(
        replaceFamily(
          input,
          "security",
          (request) => ({ ...request, input: accessorInput }) as never,
        ),
      ),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });
    expect(calls).toBe(0);

    const accessorFamilies = [...input.families];
    Object.defineProperty(accessorFamilies, "0", {
      enumerable: true,
      get: () => {
        calls += 1;
        return syntax;
      },
    });
    await expect(
      scheduleRuleFamilies({ ...input, families: accessorFamilies }),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });
    expect(calls).toBe(0);

    const overrides = Object.create({ inherited: true }) as Record<string, unknown>;
    await expect(
      scheduleRuleFamilies({
        ...input,
        policy: { failureThreshold: "error", severityOverrides: overrides },
      }),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });
    const accessorOverrides: Record<string, unknown> = {};
    Object.defineProperty(accessorOverrides, "ACL300", {
      enumerable: true,
      get: () => {
        calls += 1;
        return "error";
      },
    });
    await expect(
      scheduleRuleFamilies({
        ...input,
        policy: { failureThreshold: "error", severityOverrides: accessorOverrides },
      }),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });
    expect(calls).toBe(0);
  });

  test("fails closed when reflective admission operations throw", async () => {
    const input = await fullRuleSchedulerInput();
    const security = input.families.find((request) => request.familyId === "security");
    if (security?.familyId !== "security") throw new Error("security fixture missing");

    const ownKeys = Reflect.ownKeys;
    const rawInput = { ...input };
    const inputSpy = vi.spyOn(Reflect, "ownKeys").mockImplementation((target) => {
      if (target === rawInput) throw new TypeError("hostile reflection");
      return Reflect.apply(ownKeys, Reflect, [target]);
    });
    try {
      await expect(scheduleRuleFamilies(rawInput)).resolves.toMatchObject({ ok: false });
    } finally {
      inputSpy.mockRestore();
    }

    const families = [...input.families];
    const arraySpy = vi.spyOn(Reflect, "ownKeys").mockImplementation((target) => {
      if (target === families) throw new TypeError("hostile reflection");
      return Reflect.apply(ownKeys, Reflect, [target]);
    });
    try {
      await expect(scheduleRuleFamilies({ ...input, families })).resolves.toMatchObject({
        ok: false,
      });
    } finally {
      arraySpy.mockRestore();
    }

    const rawOptions = { maximumConcurrency: 1 };
    const getPrototypeOf = Reflect.getPrototypeOf;
    const optionSpy = vi.spyOn(Reflect, "getPrototypeOf").mockImplementation((target) => {
      if (target === rawOptions) throw new TypeError("hostile reflection");
      return Reflect.apply(getPrototypeOf, Reflect, [target]);
    });
    try {
      await expect(scheduleRuleFamilies(input, rawOptions)).resolves.toMatchObject({ ok: false });
    } finally {
      optionSpy.mockRestore();
    }

    const overrides = {};
    const overrideSpy = vi.spyOn(Reflect, "ownKeys").mockImplementation((target) => {
      if (target === overrides) throw new TypeError("hostile reflection");
      return Reflect.apply(ownKeys, Reflect, [target]);
    });
    try {
      await expect(
        scheduleRuleFamilies({
          ...input,
          policy: { failureThreshold: "error", severityOverrides: overrides },
        }),
      ).resolves.toMatchObject({ ok: false });
    } finally {
      overrideSpy.mockRestore();
    }

    const familyInput = security.input;
    const reboundSpy = vi.spyOn(Reflect, "ownKeys").mockImplementation((target) => {
      if (target === familyInput) throw new TypeError("hostile reflection");
      return Reflect.apply(ownKeys, Reflect, [target]);
    });
    try {
      await expect(scheduleRuleFamilies(input)).resolves.toMatchObject({ ok: false });
    } finally {
      reboundSpy.mockRestore();
    }
  });

  test("rejects each exact F09 statement relationship mismatch", async () => {
    const input = await fullRuleSchedulerInput();
    const drift = input.families.find((request) => request.familyId === "repository-drift");
    if (drift?.familyId !== "repository-drift") throw new Error("drift fixture missing");
    const statement = drift.input.statements[0];
    if (statement === undefined) throw new Error("statement fixture missing");
    const candidates: readonly RepositoryDriftStatementInput[] = [
      {
        ...statement,
        nodeIds: [
          ...statement.nodeIds,
          "node:boundary:extra" as (typeof statement.nodeIds)[number],
        ],
      },
      {
        ...statement,
        range: {
          ...statement.range,
          sourceId: "source:boundary:mismatch" as typeof statement.range.sourceId,
        },
      },
      {
        ...statement,
        range: {
          ...statement.range,
          start: { ...statement.range.start, line: statement.range.start.line + 1 },
        },
      },
      { ...statement, text: `${statement.text} changed` },
    ];
    for (const candidate of candidates) {
      const malformed = withDriftRequest(input, (request) => ({
        ...request,
        input: {
          ...request.input,
          statements: request.input.statements.map((entry, index) =>
            index === 0 ? candidate : entry,
          ),
        },
      }));
      await expect(scheduleRuleFamilies(malformed)).resolves.toMatchObject({
        issues: [{ code: "dependency-failure", familyId: "repository-drift" }],
        ok: false,
      });
    }
  });

  test("rejects a B04-valid diagnostic whose rule has no registered scheduler owner", async () => {
    const { result } = await boundaryFixture();
    const base = result.visibleDiagnostics[0];
    if (base === undefined) throw new Error("diagnostic fixture missing");
    const ruleId = "ACL999";
    const ruleVersion = "1.0.0";
    const diagnostic: Diagnostic = {
      ...base,
      fingerprints: {
        path: {
          method: base.fingerprints.path.method,
          value: computePathFingerprint({
            basis: base.fingerprintBasis.path,
            path: base.primary.path,
            ruleId,
            ruleVersion,
          }),
        },
        semantic: {
          method: base.fingerprints.semantic.method,
          value: computeSemanticFingerprint({
            basis: base.fingerprintBasis.semantic,
            ruleId,
            ruleVersion,
          }),
        },
      },
      id: "diagnostic:ACL999:boundary" as Diagnostic["id"],
      ruleId,
      ruleVersion,
    };
    expect(
      canonicalizeRuleDiagnostics(bundleOf([diagnostic]), result.sources, {
        failureThreshold: "error",
        severityOverrides: {},
      }),
    ).toMatchObject({ issues: [{ code: "invalid-output" }], ok: false });
  });

  test("sorts multiple valid suppression records by location and stable ID", async () => {
    const { result } = await boundaryFixture();
    const suppression = result.bundle.suppressions[0];
    if (suppression === undefined) throw new Error("suppression fixture missing");
    const later = {
      ...structuredClone(suppression),
      id: `${suppression.id}:z` as typeof suppression.id,
    };
    const earlier = {
      ...structuredClone(suppression),
      id: `${suppression.id}:a` as typeof suppression.id,
    };
    const canonical = canonicalizeRuleDiagnostics(
      { ...result.bundle, suppressions: [later, earlier] },
      result.sources,
      { failureThreshold: "error", severityOverrides: {} },
    );
    expect(canonical.ok, JSON.stringify(canonical)).toBe(true);
    if (canonical.ok)
      expect(canonical.bundle.suppressions.map((entry) => entry.id)).toEqual([
        earlier.id,
        later.id,
      ]);
  });

  test("enforces the configured diagnostic cap after unused-suppression expansion", async () => {
    const input = await fullRuleSchedulerInput();
    const drift = input.families.find((request) => request.familyId === "repository-drift");
    if (drift?.familyId !== "repository-drift") throw new Error("drift fixture missing");
    const statement = drift.input.statements[0];
    if (statement === undefined) throw new Error("statement fixture missing");
    const evidenceIndex: typeof drift.input.evidenceIndex = {
      ...drift.input.evidenceIndex,
      facts: [
        {
          category: "script",
          certainty: "declared",
          id: "fact:boundary:existing-script",
          location: {
            path: statement.path,
            range: {
              end: { ...statement.range.end },
              start: { ...statement.range.start },
            },
          },
          name: "missing",
          provenance: {
            collectorId: "collector:boundary",
            interpretation: "inert-text",
            sourceState: "complete",
          },
          rawValue: "echo available",
          scope: statement.path,
          value: "echo available",
        },
      ],
      metrics: { ...drift.input.evidenceIndex.metrics, factCount: 1 },
    };
    const candidate = withDriftRequest(input, (request) => ({
      ...request,
      input: { ...request.input, evidenceIndex },
    }));
    await expect(scheduleRuleFamilies(candidate, { maximumDiagnostics: 1 })).resolves.toMatchObject(
      {
        issues: [{ code: "resource-limit", path: "$output.diagnostics" }],
        ok: false,
      },
    );
  });

  test("returns a typed failure if canonical output detachment fails", async () => {
    const { result } = await boundaryFixture();
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementation(() => {
      throw new DOMException("cannot clone", "DataCloneError");
    });
    try {
      expect(
        canonicalizeRuleDiagnostics(result.bundle, result.sources, {
          failureThreshold: "error",
          severityOverrides: {},
        }),
      ).toMatchObject({ issues: [{ code: "invalid-output" }], ok: false });
    } finally {
      clone.mockRestore();
    }
  });
});
