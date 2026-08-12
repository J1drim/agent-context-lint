import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  RESOLUTION_EVENT_TRACE_LIMITS,
  ActivationAlgebraError,
  ActivationAlgebraErrorCode,
  ResolutionEventTraceError,
  ResolutionEventTraceErrorCode,
  createResolutionEventTrace,
  createSyntheticTargetTrace,
  createTraceActivationCallbacks,
  digestResolutionEventTrace,
  evaluateActivationRule,
  normalizeResolutionEventTrace,
  resolveTraceRuleSelection,
  resolveTraceSetting,
  serializeResolutionEventTrace,
  type ResolutionEventTrace,
  type TraceActivationRuleDescriptor,
  type TraceRuleSelectionQuery,
} from "../src/index.js";
import type {
  ActivationRule,
  ActivationRuleId,
  InstructionIr,
  RepositoryRelativePath,
  ResolutionEvent,
  ResolutionEventId,
  ResolutionTargetId,
  Uncertainty,
} from "@agent-context/core";

const KNOWN = { state: "known" } as const;
const TARGET_ID = "target:main" as ResolutionTargetId;
const RULE_MANUAL = "activation:manual" as ActivationRuleId;
const RULE_CONDITIONAL = "activation:conditional" as ActivationRuleId;
const VALID_IR_FIXTURE = new URL(
  "../../core/test/fixtures/instruction-ir.valid.json",
  import.meta.url,
);

function path(value: string): RepositoryRelativePath {
  return value as RepositoryRelativePath;
}

function eventId(value: string): ResolutionEventId {
  return value as ResolutionEventId;
}

function ruleDescriptor(
  kind: "manual" | "conditional",
  id: ActivationRuleId,
  overrides: Partial<TraceActivationRuleDescriptor> = {},
): TraceActivationRuleDescriptor {
  return {
    id,
    documentId: "document:test" as TraceActivationRuleDescriptor["documentId"],
    profileId: "profile:test",
    surfaceId: "profile:test/local",
    specSnapshotId: "profile:test/2026-08-02",
    kind,
    conditions: kind === "conditional" ? ["The trace explicitly selects the rule."] : [],
    ...overrides,
  };
}

function selectionQuery(
  descriptor: TraceActivationRuleDescriptor,
  mode: "manual" | "conditional" = descriptor.kind === "manual" ? "manual" : "conditional",
  targetPath: RepositoryRelativePath = path("src/main.ts"),
): TraceRuleSelectionQuery {
  return { rule: descriptor, targetPath, mode };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} missing`);
  return value;
}

function baseTrace(events?: readonly ResolutionEvent[]): ResolutionEventTrace {
  return {
    recordKind: "agent-context-resolution-event-trace",
    contractVersion: "0.1.0",
    rules: [ruleDescriptor("conditional", RULE_CONDITIONAL), ruleDescriptor("manual", RULE_MANUAL)],
    targets: [{ id: TARGET_ID, path: path("src/main.ts"), purpose: "resolve context" }],
    events: events ?? [
      {
        id: eventId("event:launch"),
        sequence: 0,
        kind: "launch",
        targetId: TARGET_ID,
        uncertainty: KNOWN,
        path: path("."),
        workspaceRoots: [path("."), path("packages")],
        settings: [
          { key: "z.mode", value: { z: true, a: ["one", { z: 2, a: 1 }] } },
          { key: "a.enabled", value: true },
        ],
      },
      {
        id: eventId("event:reference"),
        sequence: 1,
        kind: "reference-path",
        targetId: TARGET_ID,
        uncertainty: KNOWN,
        path: path("src/main.ts"),
      },
    ],
  };
}

type Mutable<T> = T extends boolean | null | number | string | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

function clone<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

function expectTraceError(operation: () => unknown, code: string): ResolutionEventTraceError {
  try {
    operation();
    expect.unreachable(`expected ${code}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResolutionEventTraceError);
    expect(error).toMatchObject({ code });
    return error as ResolutionEventTraceError;
  }
}

function readValidIr(): Mutable<InstructionIr> {
  return JSON.parse(readFileSync(VALID_IR_FIXTURE, "utf8")) as Mutable<InstructionIr>;
}

function rule(kind: "manual" | "conditional", id: ActivationRuleId): ActivationRule {
  const descriptor = ruleDescriptor(kind, id);
  return {
    ...descriptor,
    scopeRoot: path("."),
    include: [],
    exclude: [],
    unknownReason: null,
    evidenceRefs: [{ sourceId: "source:evidence", factId: "TRACE-001" }],
    uncertainty:
      kind === "conditional"
        ? { state: "conditional", conditions: ["Trace selection is required."] }
        : KNOWN,
  } as unknown as ActivationRule;
}

describe("resolution event trace normalization", () => {
  test("normalizes set-like fields and recursively canonicalizes settings", () => {
    const normalized = normalizeResolutionEventTrace(baseTrace());

    expect(normalized.rules.map((rule) => rule.id)).toEqual([RULE_CONDITIONAL, RULE_MANUAL]);
    expect(normalized.events[0]).toMatchObject({
      kind: "launch",
      workspaceRoots: [".", "packages"],
      settings: [{ key: "a.enabled", value: true }, { key: "z.mode" }],
    });
    const launch = normalized.events[0];
    expect(launch?.kind).toBe("launch");
    if (launch?.kind === "launch") {
      expect(Object.keys(launch.settings[1]?.value as object)).toEqual(["a", "z"]);
      const nested = launch.settings[1]?.value as { readonly a: readonly unknown[] };
      expect(Object.keys(nested.a[1] as object)).toEqual(["a", "z"]);
    }
  });

  test("gives semantically equal permutations byte-identical serialization", () => {
    const first = baseTrace();
    const second = clone(first);
    second.rules.reverse();
    const launch = second.events[0];
    if (launch?.kind !== "launch") throw new Error("fixture launch missing");
    launch.workspaceRoots.reverse();
    launch.settings = [
      { key: "a.enabled", value: true },
      { key: "z.mode", value: { a: ["one", { a: 1, z: 2 }], z: true } },
    ];

    expect(serializeResolutionEventTrace(first)).toBe(serializeResolutionEventTrace(second));
    expect(digestResolutionEventTrace(first)).toBe(digestResolutionEventTrace(second));
  });

  test("preserves sequence order while sorting targets by exact code-unit order", () => {
    const trace = clone(baseTrace());
    trace.targets.push({
      id: "target:Z" as ResolutionTargetId,
      path: path("Z.ts"),
      purpose: "upper",
    });
    trace.targets.push({
      id: "target:a" as ResolutionTargetId,
      path: path("a.ts"),
      purpose: "lower",
    });
    const normalized = normalizeResolutionEventTrace(trace);
    expect(normalized.targets.map((target) => target.id)).toEqual([
      "target:Z",
      "target:a",
      "target:main",
    ]);
    expect(normalized.events.map((event) => event.id)).toEqual(["event:launch", "event:reference"]);
  });

  test("returns deeply immutable regular data", () => {
    const normalized = normalizeResolutionEventTrace(baseTrace());
    const launch = normalized.events[0];
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.events)).toBe(true);
    expect(Object.isFrozen(normalized.targets)).toBe(true);
    expect(Object.isFrozen(launch)).toBe(true);
    if (launch?.kind === "launch") {
      expect(Object.isFrozen(launch.settings)).toBe(true);
      expect(Object.isFrozen(launch.settings[1]?.value)).toBe(true);
    }
  });

  test("extracts only after validating the complete B03 IR", () => {
    const trace = createResolutionEventTrace(readValidIr());
    expect(trace.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(trace.rules.map((rule) => rule.id)).toEqual(["activation:vscode-description"]);

    const invalid = readValidIr();
    invalid.events[1] = clone({ ...required(invalid.events[1], "IR event"), sequence: 99 });
    expectTraceError(
      () => createResolutionEventTrace(invalid),
      ResolutionEventTraceErrorCode.invalidInput,
    );
  });

  test("serializes to a fixed contract and stable digest", () => {
    const serialized = serializeResolutionEventTrace(baseTrace());
    expect(JSON.parse(serialized)).toEqual(normalizeResolutionEventTrace(baseTrace()));
    expect(digestResolutionEventTrace(baseTrace())).toMatch(/^[a-f0-9]{64}$/);
    expect(digestResolutionEventTrace(baseTrace())).toBe(
      "a51c38e4019c95bb353da0556813dead400777490bb11a86c39e2edbca7b5e6a",
    );
  });
});

describe("synthetic target trace", () => {
  test.each(["reference-path", "read-path", "write-path"] as const)(
    "projects one target through a %s event",
    (targetEventKind) => {
      const trace = createSyntheticTargetTrace({
        launchCwd: path("packages/app"),
        workspaceRoots: [path("packages"), path(".")],
        targetPath: path("packages/app/src/main.ts"),
        purpose: "explain",
        settings: [{ key: "mode", value: "agent" }],
        targetEventKind,
      });
      expect(trace.events.map((event) => event.kind)).toEqual(["launch", targetEventKind]);
      expect(trace.events[0]?.targetId).toBe(trace.targets[0]?.id);
      expect(trace.events[1]?.targetId).toBe(trace.targets[0]?.id);
    },
  );

  test("derives byte-identical IDs after canonicalization", () => {
    const first = createSyntheticTargetTrace({
      launchCwd: path("."),
      workspaceRoots: [path("packages"), path(".")],
      targetPath: path("src/main.ts"),
      purpose: "explain",
      settings: [
        { key: "z", value: { z: 2, a: 1 } },
        { key: "a", value: true },
      ],
    });
    const second = createSyntheticTargetTrace({
      launchCwd: path("."),
      workspaceRoots: [path("."), path("packages")],
      targetPath: path("src/main.ts"),
      purpose: "explain",
      settings: [
        { key: "a", value: true },
        { key: "z", value: { a: 1, z: 2 } },
      ],
    });
    expect(serializeResolutionEventTrace(first)).toBe(serializeResolutionEventTrace(second));
  });

  test("uses length framing for collision-resistant target identities", () => {
    const left = createSyntheticTargetTrace({
      launchCwd: path("."),
      workspaceRoots: [path(".")],
      targetPath: path("ab"),
      purpose: "c",
    });
    const right = createSyntheticTargetTrace({
      launchCwd: path("."),
      workspaceRoots: [path(".")],
      targetPath: path("a"),
      purpose: "bc",
    });
    expect(left.targets[0]?.id).not.toBe(right.targets[0]?.id);
  });

  test("rejects hostile, incomplete, and unsupported synthetic inputs", () => {
    for (const input of [
      null,
      {},
      {
        launchCwd: ".",
        workspaceRoots: ["."],
        targetPath: "src/main.ts",
        purpose: "explain",
        extra: true,
      },
      {
        launchCwd: ".",
        workspaceRoots: ["."],
        targetPath: "src/main.ts",
        purpose: "explain",
        targetEventKind: "list-directory",
      },
      {
        launchCwd: ".",
        workspaceRoots: ["."],
        targetPath: 1,
        purpose: "explain",
      },
      {
        launchCwd: ".",
        workspaceRoots: ["."],
        targetPath: "src/main.ts",
        purpose: "explain",
        settings: null,
      },
      {
        launchCwd: ".",
        workspaceRoots: ["."],
        targetPath: "src/main.ts",
        purpose: "explain",
        targetEventKind: undefined,
      },
    ]) {
      expect(() => createSyntheticTargetTrace(input as never)).toThrow(ResolutionEventTraceError);
    }
  });
});

describe("explicit selected-rule interpretation", () => {
  function selectionTrace(uncertainty: Uncertainty = KNOWN): ResolutionEventTrace {
    return baseTrace([
      required(baseTrace().events[0], "launch event"),
      {
        id: eventId("event:selection"),
        sequence: 1,
        kind: "rule-selection",
        targetId: TARGET_ID,
        uncertainty,
        ruleIds: [RULE_CONDITIONAL, RULE_MANUAL],
        selectionSource: "model",
      },
      {
        id: eventId("event:manual"),
        sequence: 2,
        kind: "manual-rule-mention",
        targetId: TARGET_ID,
        uncertainty: KNOWN,
        ruleId: RULE_MANUAL,
      },
    ]);
  }

  test("returns active only for explicit known positive evidence", () => {
    const result = resolveTraceRuleSelection(
      selectionTrace(),
      selectionQuery(ruleDescriptor("conditional", RULE_CONDITIONAL)),
    );
    expect(result).toMatchObject({ state: "active", ruleId: RULE_CONDITIONAL });
    expect(result.evidence).toHaveLength(1);
    expect(result.reason).toContain("event:selection");
  });

  test("preserves conditional, unknown, and contradictory evidence as indeterminate", () => {
    for (const uncertainty of [
      { state: "conditional", conditions: ["model relevance"] },
      { state: "unknown", reason: "not observed" },
      {
        state: "contradiction",
        reason: "sources disagree",
        alternatives: [
          { id: "a", description: "selected" },
          { id: "b", description: "not selected" },
        ],
      },
    ] as const) {
      expect(
        resolveTraceRuleSelection(
          selectionTrace(uncertainty),
          selectionQuery(ruleDescriptor("conditional", RULE_CONDITIONAL)),
        ).state,
      ).toBe("indeterminate");
    }
  });

  test("does not turn absent selection into inactive", () => {
    const result = resolveTraceRuleSelection(
      normalizeResolutionEventTrace(baseTrace()),
      selectionQuery(ruleDescriptor("conditional", RULE_CONDITIONAL)),
    );
    expect(result).toMatchObject({ state: "indeterminate", evidence: [] });
    expect(result.reason).toContain("does not prove deselection");
  });

  test("scopes target-specific events and accepts global events", () => {
    const otherTarget = "target:other" as ResolutionTargetId;
    const trace = clone(selectionTrace());
    trace.targets.push({ id: otherTarget, path: path("src/other.ts"), purpose: "other" });
    const selected = trace.events[1];
    if (selected?.kind !== "rule-selection") throw new Error("selection missing");
    trace.events[1] = { ...selected, targetId: otherTarget };
    expect(
      resolveTraceRuleSelection(
        trace,
        selectionQuery(ruleDescriptor("conditional", RULE_CONDITIONAL)),
      ).state,
    ).toBe("indeterminate");
    trace.events[1] = { ...selected, targetId: null };
    expect(
      resolveTraceRuleSelection(
        trace,
        selectionQuery(ruleDescriptor("conditional", RULE_CONDITIONAL)),
      ).state,
    ).toBe("active");
  });

  test("manual mentions activate manual rules but not arbitrary conditional rules", () => {
    const trace = selectionTrace();
    const withoutSelection = clone(trace);
    withoutSelection.events.splice(1, 1);
    withoutSelection.events[1] = clone({
      ...required(withoutSelection.events[1], "manual event"),
      sequence: 1,
    });
    expect(
      resolveTraceRuleSelection(
        withoutSelection,
        selectionQuery(ruleDescriptor("manual", RULE_MANUAL), "manual"),
      ).state,
    ).toBe("active");
    expect(
      resolveTraceRuleSelection(
        withoutSelection,
        selectionQuery(ruleDescriptor("manual", RULE_MANUAL), "conditional"),
      ).state,
    ).toBe("indeterminate");
  });

  test("supplies E01 callbacks without claiming profile-specific condition semantics", () => {
    const callbacks = createTraceActivationCallbacks(selectionTrace());
    const manual = evaluateActivationRule(rule("manual", RULE_MANUAL), {
      targetPath: path("src/main.ts"),
      callbacks,
    });
    const conditional = evaluateActivationRule(rule("conditional", RULE_CONDITIONAL), {
      targetPath: path("src/main.ts"),
      callbacks,
    });
    expect(manual.state).toBe("active");
    expect(conditional.state).toBe("active");
    expect(manual.provenance[0]?.kind).toBe("manual-fact");
    expect(conditional.provenance[0]?.kind).toBe("conditional-fact");
  });

  test.each([
    ["document", { documentId: "document:foreign" }],
    ["profile", { profileId: "profile:foreign" }],
    ["surface", { surfaceId: "profile:test/foreign" }],
    ["specification", { specSnapshotId: "profile:test/foreign-spec" }],
    ["conditions", { conditions: ["Foreign condition with the same rule ID."] }],
  ] as const)("rejects a same-ID foreign %s descriptor before provenance", (_label, override) => {
    const callbacks = createTraceActivationCallbacks(selectionTrace());
    const foreign = {
      ...rule("conditional", RULE_CONDITIONAL),
      ...override,
    } as ActivationRule;
    try {
      evaluateActivationRule(foreign, { targetPath: path("src/main.ts"), callbacks });
      expect.unreachable("foreign rule must not receive selection evidence");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ActivationAlgebraError);
      expect(error).toMatchObject({
        code: ActivationAlgebraErrorCode.callbackFailed,
        cause: {
          code: ResolutionEventTraceErrorCode.invalidRelationship,
        },
      });
    }
  });

  test("rejects an unknown rule query deterministically", () => {
    expectTraceError(
      () =>
        resolveTraceRuleSelection(
          selectionTrace(),
          selectionQuery(ruleDescriptor("manual", "activation:missing" as ActivationRuleId)),
        ),
      ResolutionEventTraceErrorCode.invalidRelationship,
    );
  });

  test("rejects noncanonical rule-selection query targets", () => {
    expectTraceError(
      () =>
        resolveTraceRuleSelection(
          selectionTrace(),
          selectionQuery(
            ruleDescriptor("manual", RULE_MANUAL),
            "manual",
            "../outside" as RepositoryRelativePath,
          ),
        ),
      ResolutionEventTraceErrorCode.invalidPath,
    );
  });

  test("closes the query mode and complete descriptor at runtime", () => {
    const base = selectionQuery(ruleDescriptor("manual", RULE_MANUAL));
    expectTraceError(
      () =>
        resolveTraceRuleSelection(selectionTrace(), {
          ...base,
          mode: "automatic" as never,
        }),
      ResolutionEventTraceErrorCode.invalidState,
    );
    expectTraceError(
      () =>
        resolveTraceRuleSelection(selectionTrace(), {
          ...base,
          rule: { ...base.rule, documentId: "document:foreign" as never },
        }),
      ResolutionEventTraceErrorCode.invalidRelationship,
    );
  });
});

describe("settings state", () => {
  function settingTrace(): ResolutionEventTrace {
    const launch = clone(baseTrace().events[0]);
    if (launch?.kind !== "launch") throw new Error("launch missing");
    launch.settings = [{ key: "mode", value: "launch" }];
    return baseTrace([
      launch,
      {
        id: eventId("event:uncertain-setting"),
        sequence: 1,
        kind: "settings-change",
        targetId: TARGET_ID,
        uncertainty: { state: "unknown", reason: "live reload is undocumented" },
        settings: [{ key: "mode", value: "uncertain" }],
      },
      {
        id: eventId("event:known-setting"),
        sequence: 2,
        kind: "settings-change",
        targetId: TARGET_ID,
        uncertainty: KNOWN,
        settings: [{ key: "mode", value: { z: 2, a: 1 } }],
      },
    ]);
  }

  test("uses the last applicable known assignment", () => {
    expect(
      resolveTraceSetting(settingTrace(), { key: "mode", targetPath: path("src/main.ts") }),
    ).toEqual({
      state: "known",
      key: "mode",
      value: { a: 1, z: 2 },
      eventId: "event:known-setting",
      sequence: 2,
    });
  });

  test("retains a final uncertain assignment and reports unrecorded keys", () => {
    const trace = clone(settingTrace());
    trace.events.pop();
    expect(
      resolveTraceSetting(trace, { key: "mode", targetPath: path("src/main.ts") }),
    ).toMatchObject({
      state: "indeterminate",
      eventId: "event:uncertain-setting",
    });
    expect(resolveTraceSetting(trace, { key: "missing", targetPath: path("src/main.ts") })).toEqual(
      {
        state: "unrecorded",
        key: "missing",
      },
    );
  });

  test("ignores assignments attached to another target", () => {
    const trace = clone(settingTrace());
    const otherId = "target:other" as ResolutionTargetId;
    trace.targets.push({ id: otherId, path: path("src/other.ts"), purpose: "other" });
    const latest = trace.events[2];
    if (latest?.kind !== "settings-change") throw new Error("setting missing");
    trace.events[2] = { ...latest, targetId: otherId };
    expect(
      resolveTraceSetting(trace, { key: "mode", targetPath: path("src/main.ts") }),
    ).toMatchObject({
      state: "indeterminate",
      eventId: "event:uncertain-setting",
    });
  });

  test("rejects malformed setting query keys and targets", () => {
    expectTraceError(
      () => resolveTraceSetting(settingTrace(), { key: "", targetPath: path("src/main.ts") }),
      ResolutionEventTraceErrorCode.invalidInput,
    );
    expectTraceError(
      () =>
        resolveTraceSetting(settingTrace(), {
          key: "mode",
          targetPath: "../outside" as RepositoryRelativePath,
        }),
      ResolutionEventTraceErrorCode.invalidPath,
    );
  });
});

describe("event variants and invalid state", () => {
  test.each([
    ["reference-path", { path: "src/main.ts" }],
    ["read-path", { path: "src/main.ts" }],
    ["write-path", { path: "src/main.ts" }],
    ["list-directory", { path: "src" }],
    ["directory-add", { path: "packages/new" }],
    ["manual-rule-mention", { ruleId: RULE_MANUAL }],
    ["rule-selection", { ruleIds: [RULE_MANUAL], selectionSource: "user" }],
    ["settings-change", { settings: [{ key: "mode", value: "agent" }] }],
    ["memory-show", {}],
    ["memory-list", {}],
    ["memory-reload", {}],
    ["compact", {}],
    ["review-request", {}],
    ["review-push", {}],
    ["hosted-task-start", {}],
    ["client-restart", {}],
  ] as const)("accepts the B03 %s event without inventing payload", (kind, payload) => {
    const event = {
      id: `event:${kind}` as ResolutionEventId,
      sequence: 1,
      kind,
      targetId: TARGET_ID,
      uncertainty: KNOWN,
      ...payload,
    } as ResolutionEvent;
    expect(
      normalizeResolutionEventTrace(baseTrace([required(baseTrace().events[0], "launch"), event]))
        .events[1],
    ).toMatchObject({ kind });
  });

  test("accepts a launch-only trace and does not invent CWD/workspace containment", () => {
    const launch = clone(required(baseTrace().events[0], "launch"));
    if (launch.kind !== "launch") throw new Error("launch missing");
    launch.targetId = null;
    launch.path = path("apps");
    launch.workspaceRoots = [path("packages")];
    const trace = clone(baseTrace([launch]));
    trace.targets = [];
    expect(normalizeResolutionEventTrace(trace)).toMatchObject({
      targets: [],
      events: [{ kind: "launch", path: "apps", workspaceRoots: ["packages"], targetId: null }],
    });
  });

  const invalidMutations: readonly [string, (trace: Mutable<ResolutionEventTrace>) => void][] = [
    [
      "wrong record kind",
      (trace: Mutable<ResolutionEventTrace>): void => {
        (trace as unknown as { recordKind: string }).recordKind = "wrong";
      },
    ],
    [
      "wrong version",
      (trace: Mutable<ResolutionEventTrace>): void => {
        (trace as unknown as { contractVersion: string }).contractVersion = "9";
      },
    ],
    [
      "duplicate target",
      (trace: Mutable<ResolutionEventTrace>): void => {
        trace.targets.push(required(trace.targets[0], "target"));
      },
    ],
    [
      "root target path",
      (trace: Mutable<ResolutionEventTrace>): void => {
        required(trace.targets[0], "target").path = path(".");
      },
    ],
    [
      "invalid target ID",
      (trace: Mutable<ResolutionEventTrace>): void => {
        (required(trace.targets[0], "target") as unknown as { id: string }).id = "bad id";
      },
    ],
    [
      "sequence gap",
      (trace: Mutable<ResolutionEventTrace>): void => {
        required(trace.events[1], "event").sequence = 9;
      },
    ],
    [
      "duplicate event ID",
      (trace: Mutable<ResolutionEventTrace>): void => {
        required(trace.events[1], "event").id = required(trace.events[0], "launch").id;
      },
    ],
    [
      "non-numeric sequence",
      (trace: Mutable<ResolutionEventTrace>): void => {
        (required(trace.events[1], "event") as unknown as { sequence: unknown }).sequence = "1";
      },
    ],
    [
      "launch not first",
      (trace: Mutable<ResolutionEventTrace>): void => {
        trace.events.reverse();
      },
    ],
    [
      "second launch",
      (trace: Mutable<ResolutionEventTrace>): void => {
        trace.events.push({
          ...required(trace.events[0], "launch"),
          sequence: 2,
          id: eventId("event:again"),
        });
      },
    ],
    [
      "unknown target",
      (trace: Mutable<ResolutionEventTrace>): void => {
        required(trace.events[1], "event").targetId = "target:missing" as ResolutionTargetId;
      },
    ],
    [
      "unknown rule",
      (trace: Mutable<ResolutionEventTrace>): void => {
        trace.events.push({
          id: eventId("event:manual"),
          sequence: 2,
          kind: "manual-rule-mention",
          targetId: null,
          uncertainty: KNOWN,
          ruleId: "activation:missing" as ActivationRuleId,
        });
      },
    ],
    [
      "empty setting change",
      (trace: Mutable<ResolutionEventTrace>): void => {
        trace.events.push({
          id: eventId("event:settings"),
          sequence: 2,
          kind: "settings-change",
          targetId: null,
          uncertainty: KNOWN,
          settings: [],
        });
      },
    ],
    [
      "empty workspace roots",
      (trace: Mutable<ResolutionEventTrace>): void => {
        const launch = required(trace.events[0], "launch");
        if (launch.kind !== "launch") throw new Error("launch missing");
        launch.workspaceRoots = [];
      },
    ],
    [
      "duplicate workspace roots",
      (trace: Mutable<ResolutionEventTrace>): void => {
        const launch = required(trace.events[0], "launch");
        if (launch.kind !== "launch") throw new Error("launch missing");
        launch.workspaceRoots = [path("."), path(".")];
      },
    ],
    [
      "control-bearing setting key",
      (trace: Mutable<ResolutionEventTrace>): void => {
        const launch = required(trace.events[0], "launch");
        if (launch.kind !== "launch") throw new Error("launch missing");
        launch.settings = [{ key: "bad\nkey", value: true }];
      },
    ],
    [
      "duplicate setting key",
      (trace: Mutable<ResolutionEventTrace>): void => {
        const launch = required(trace.events[0], "launch");
        if (launch.kind !== "launch") throw new Error("launch missing");
        launch.settings = [
          { key: "same", value: true },
          { key: "same", value: false },
        ];
      },
    ],
    [
      "empty conditional uncertainty",
      (trace: Mutable<ResolutionEventTrace>): void => {
        required(trace.events[1], "event").uncertainty = {
          state: "conditional",
          conditions: [],
        };
      },
    ],
    [
      "duplicate conditional uncertainty",
      (trace: Mutable<ResolutionEventTrace>): void => {
        required(trace.events[1], "event").uncertainty = {
          state: "conditional",
          conditions: ["same", "same"],
        };
      },
    ],
    [
      "underspecified contradiction",
      (trace: Mutable<ResolutionEventTrace>): void => {
        required(trace.events[1], "event").uncertainty = {
          state: "contradiction",
          reason: "one alternative",
          alternatives: [{ id: "one", description: "only" }],
        };
      },
    ],
    [
      "duplicate contradiction IDs",
      (trace: Mutable<ResolutionEventTrace>): void => {
        required(trace.events[1], "event").uncertainty = {
          state: "contradiction",
          reason: "duplicate IDs",
          alternatives: [
            { id: "same", description: "one" },
            { id: "same", description: "two" },
          ],
        };
      },
    ],
    [
      "unsupported uncertainty state",
      (trace: Mutable<ResolutionEventTrace>): void => {
        (required(trace.events[1], "event") as unknown as { uncertainty: unknown }).uncertainty = {
          state: "maybe",
        };
      },
    ],
  ];

  test.each(invalidMutations)("rejects %s", (_name, mutate) => {
    const trace = clone(baseTrace());
    mutate(trace);
    expect(() => normalizeResolutionEventTrace(trace)).toThrow(ResolutionEventTraceError);
  });

  test("rejects noncanonical paths and impossible event fields", () => {
    const invalidPath = clone(baseTrace());
    const event = invalidPath.events[1];
    if (event === undefined || !("path" in event)) throw new Error("path event missing");
    invalidPath.events[1] = { ...event, path: "../outside" as RepositoryRelativePath };
    expectTraceError(
      () => normalizeResolutionEventTrace(invalidPath),
      ResolutionEventTraceErrorCode.invalidPath,
    );

    const impossible = clone(baseTrace()) as unknown as {
      events: [object, { settings: unknown[] }];
    };
    impossible.events[1].settings = [];
    expectTraceError(
      () => normalizeResolutionEventTrace(impossible),
      ResolutionEventTraceErrorCode.invalidEvent,
    );
  });
});

describe("hostile input and resource boundaries", () => {
  test("rejects hostile selection queries without coercion or property execution", () => {
    let invoked = false;
    const coercible = {
      [Symbol.toPrimitive](): string {
        invoked = true;
        throw new Error("must not coerce");
      },
    };
    const base = clone(selectionQuery(ruleDescriptor("manual", RULE_MANUAL)));
    const hostileFields = [
      ["mode", coercible],
      ["mode", Symbol("manual")],
      ["targetPath", coercible],
      ["targetPath", "\ud800"],
      ["targetPath", "a".repeat(RESOLUTION_EVENT_TRACE_LIMITS.maxTextBytes + 1)],
    ] as const;
    for (const [field, value] of hostileFields) {
      const query = clone(base) as unknown as Record<string, unknown>;
      query[field] = value;
      expect(() => resolveTraceRuleSelection(baseTrace(), query as never)).toThrow(
        ResolutionEventTraceError,
      );
    }
    const hostileRule = clone(base) as unknown as {
      rule: Record<string, unknown>;
    };
    hostileRule.rule["documentId"] = coercible;
    expect(() => resolveTraceRuleSelection(baseTrace(), hostileRule as never)).toThrow(
      ResolutionEventTraceError,
    );
    const nestedRuleProxy = new Proxy(base.rule, {
      ownKeys(): never {
        invoked = true;
        throw new Error("must not inspect nested rule");
      },
    });
    expect(() =>
      resolveTraceRuleSelection(baseTrace(), { ...base, rule: nestedRuleProxy }),
    ).toThrow(ResolutionEventTraceError);
    const symbolRule = clone(base.rule) as unknown as Record<PropertyKey, unknown>;
    symbolRule[Symbol("hidden")] = true;
    expect(() =>
      resolveTraceRuleSelection(baseTrace(), { ...base, rule: symbolRule as never }),
    ).toThrow(ResolutionEventTraceError);
    for (const conditions of [
      ["\ud800"],
      ["a".repeat(RESOLUTION_EVENT_TRACE_LIMITS.maxTextBytes + 1)],
      new Proxy(["condition"], {
        ownKeys(): never {
          invoked = true;
          throw new Error("must not inspect conditions");
        },
      }),
    ]) {
      const conditional = selectionQuery(ruleDescriptor("conditional", RULE_CONDITIONAL));
      expect(() =>
        resolveTraceRuleSelection(baseTrace(), {
          ...conditional,
          rule: { ...conditional.rule, conditions },
        }),
      ).toThrow(ResolutionEventTraceError);
    }

    const accessor = clone(base);
    Object.defineProperty(accessor, "targetPath", {
      enumerable: true,
      get(): never {
        invoked = true;
        throw new Error("must not read");
      },
    });
    expect(() => resolveTraceRuleSelection(baseTrace(), accessor)).toThrow(
      ResolutionEventTraceError,
    );
    const proxy = new Proxy(base, {
      ownKeys(): never {
        invoked = true;
        throw new Error("must not inspect");
      },
    });
    expect(() => resolveTraceRuleSelection(baseTrace(), proxy)).toThrow(ResolutionEventTraceError);
    const symbolQuery = clone(base) as Record<PropertyKey, unknown>;
    symbolQuery[Symbol("hidden")] = true;
    expect(() => resolveTraceRuleSelection(baseTrace(), symbolQuery as never)).toThrow(
      ResolutionEventTraceError,
    );
    expect(invoked).toBe(false);
  });

  test("rejects hostile setting queries with the same key policy as trace settings", () => {
    let invoked = false;
    const coercible = {
      [Symbol.toPrimitive](): string {
        invoked = true;
        throw new Error("must not coerce");
      },
    };
    for (const query of [
      null,
      { key: "bad\nkey", targetPath: "src/main.ts" },
      { key: "\ud800", targetPath: "src/main.ts" },
      {
        key: "a".repeat(RESOLUTION_EVENT_TRACE_LIMITS.maxTextBytes + 1),
        targetPath: "src/main.ts",
      },
      { key: coercible, targetPath: "src/main.ts" },
      { key: Symbol("mode"), targetPath: "src/main.ts" },
      { key: "mode", targetPath: coercible },
      { key: "mode", targetPath: "src/main.ts", extra: true },
    ]) {
      expect(() => resolveTraceSetting(baseTrace(), query as never)).toThrow(
        ResolutionEventTraceError,
      );
    }
    const accessor = { key: "mode", targetPath: "src/main.ts" };
    Object.defineProperty(accessor, "key", {
      enumerable: true,
      get(): never {
        invoked = true;
        throw new Error("must not read");
      },
    });
    expect(() => resolveTraceSetting(baseTrace(), accessor as never)).toThrow(
      ResolutionEventTraceError,
    );
    const proxy = new Proxy(
      { key: "mode", targetPath: "src/main.ts" },
      {
        ownKeys(): never {
          invoked = true;
          throw new Error("must not inspect");
        },
      },
    );
    expect(() => resolveTraceSetting(baseTrace(), proxy as never)).toThrow(
      ResolutionEventTraceError,
    );
    expect(invoked).toBe(false);
  });

  test("rejects direct hostile callback requests before reading fields", () => {
    let invoked = false;
    const callbacks = createTraceActivationCallbacks(baseTrace());
    const proxy = new Proxy(
      {},
      {
        ownKeys(): never {
          invoked = true;
          throw new Error("must not inspect");
        },
      },
    );
    expect(() => required(callbacks.resolveManual, "manual callback")(proxy as never)).toThrow(
      ResolutionEventTraceError,
    );
    expect(invoked).toBe(false);
  });

  test("rejects proxies and revoked proxies before invoking traps", () => {
    let trapInvoked = false;
    const proxy = new Proxy(baseTrace(), {
      ownKeys(): (string | symbol)[] {
        trapInvoked = true;
        throw new Error("must not run");
      },
    });
    expectTraceError(
      () => normalizeResolutionEventTrace(proxy),
      ResolutionEventTraceErrorCode.invalidInput,
    );
    const revoked = Proxy.revocable(baseTrace(), {});
    revoked.revoke();
    expectTraceError(
      () => normalizeResolutionEventTrace(revoked.proxy),
      ResolutionEventTraceErrorCode.invalidInput,
    );
    expect(trapInvoked).toBe(false);
  });

  test("rejects accessors without invoking them", () => {
    let invoked = false;
    const trace = clone(baseTrace());
    Object.defineProperty(trace.events[0], "path", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("must not run");
      },
    });
    expectTraceError(
      () => normalizeResolutionEventTrace(trace),
      ResolutionEventTraceErrorCode.invalidEvent,
    );
    expect(invoked).toBe(false);
  });

  test("rejects sparse, exotic, symbol-keyed, and cyclic JSON values", () => {
    const sparse = new Array<unknown>(2);
    sparse[0] = true;
    const exotic = Object.create({ inherited: true }) as Record<string, unknown>;
    exotic["value"] = true;
    const symbolKeyed: Record<PropertyKey, unknown> = { value: true };
    symbolKeyed[Symbol("hidden")] = true;
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    for (const value of [sparse, exotic, symbolKeyed, cyclic]) {
      const trace = clone(baseTrace());
      const launch = trace.events[0];
      if (launch?.kind !== "launch") throw new Error("launch missing");
      launch.settings = [{ key: "hostile", value: value as never }];
      expect(() => normalizeResolutionEventTrace(trace)).toThrow(ResolutionEventTraceError);
    }
  });

  test("bounds text bytes at the documented UTF-8 boundary", () => {
    const accepted = clone(baseTrace());
    accepted.targets[0] = {
      ...required(accepted.targets[0], "target"),
      purpose: "a".repeat(RESOLUTION_EVENT_TRACE_LIMITS.maxTextBytes),
    };
    expect(() => normalizeResolutionEventTrace(accepted)).not.toThrow();

    const rejected = clone(baseTrace());
    rejected.targets[0] = {
      ...required(rejected.targets[0], "target"),
      purpose: "a".repeat(RESOLUTION_EVENT_TRACE_LIMITS.maxTextBytes + 1),
    };
    expectTraceError(
      () => normalizeResolutionEventTrace(rejected),
      ResolutionEventTraceErrorCode.resourceLimit,
    );
  });

  test("rejects oversized collections from declared length before walking entries", () => {
    const trace = clone(baseTrace()) as unknown as { events: unknown[] };
    trace.events = new Array(RESOLUTION_EVENT_TRACE_LIMITS.maxEvents + 1);
    const startedAt = performance.now();
    expectTraceError(
      () => normalizeResolutionEventTrace(trace),
      ResolutionEventTraceErrorCode.resourceLimit,
    );
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  test("bounds JSON nesting and rejects non-JSON numbers and malformed Unicode", () => {
    let deep: unknown = null;
    for (let index = 0; index <= RESOLUTION_EVENT_TRACE_LIMITS.maxJsonDepth; index += 1) {
      deep = { next: deep };
    }
    const cases: readonly [string, unknown][] = [
      ["deep nesting", deep],
      ["NaN", Number.NaN],
      ["infinity", Number.POSITIVE_INFINITY],
      ["negative zero", -0],
      ["bigint", 1n],
      ["malformed Unicode", "\ud800"],
    ];
    for (const [label, value] of cases) {
      const trace = clone(baseTrace());
      const launch = trace.events[0];
      if (launch?.kind !== "launch") throw new Error("launch missing");
      launch.settings = [{ key: "hostile", value: value as never }];
      expect(() => normalizeResolutionEventTrace(trace), `${label} must be rejected`).toThrow(
        ResolutionEventTraceError,
      );
    }
  });

  test("is stable across deterministic permutations", () => {
    const expected = serializeResolutionEventTrace(baseTrace());
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const trace = clone(baseTrace());
      if (iteration % 2 === 0) trace.rules.reverse();
      const launch = trace.events[0];
      if (launch?.kind !== "launch") throw new Error("launch missing");
      if (iteration % 3 === 0) launch.workspaceRoots.reverse();
      if (iteration % 5 === 0) launch.settings.reverse();
      expect(serializeResolutionEventTrace(trace)).toBe(expected);
    }
  });
});
