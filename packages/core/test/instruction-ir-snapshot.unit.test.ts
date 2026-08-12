import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  INSTRUCTION_IR_SNAPSHOT_CONTRACT_VERSION,
  INSTRUCTION_IR_SNAPSHOT_LIMITS,
  createInstructionIrSnapshot,
  getInstructionIrSnapshotProvenance,
  isIssuedInstructionIrSnapshot,
} from "../src/index.js";
import type {
  InstructionIrSnapshot,
  InstructionIrSnapshotResult,
  InstructionIrValidationIssue,
} from "../src/index.js";

const VALID_FIXTURE = new URL("./fixtures/instruction-ir.valid.json", import.meta.url);

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(VALID_FIXTURE, "utf8")) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("expected record");
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("expected array");
  return value;
}

function firstRecord(value: unknown): Record<string, unknown> {
  const first = array(value)[0];
  return record(first);
}

function successful(value: unknown): InstructionIrSnapshot {
  const result = createInstructionIrSnapshot(value);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function issues(value: unknown): readonly InstructionIrValidationIssue[] {
  const result = createInstructionIrSnapshot(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected snapshot admission to fail");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.issues)).toBe(true);
  return result.issues;
}

function expectIssue(
  value: unknown,
  code: InstructionIrValidationIssue["code"],
  path?: string,
): void {
  expect(issues(value)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code, ...(path === undefined ? {} : { path }) }),
    ]),
  );
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const pending: object[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    expect(Object.isFrozen(current)).toBe(true);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if (!("value" in descriptor)) continue;
      const child: unknown = descriptor.value;
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
}

function firstSetting(input: Record<string, unknown>): Record<string, unknown> {
  return firstRecord(firstRecord(input["events"])["settings"]);
}

describe("engine-owned B03 snapshots", () => {
  test("exports frozen fixed limits and a versioned provenance contract", () => {
    expect(INSTRUCTION_IR_SNAPSHOT_CONTRACT_VERSION).toBe("0.1.0");
    expect(Object.isFrozen(INSTRUCTION_IR_SNAPSHOT_LIMITS)).toBe(true);
    expect(INSTRUCTION_IR_SNAPSHOT_LIMITS).toMatchObject({
      maximumEvents: 16_384,
      maximumNodes: 50_000,
      maximumSources: 1_024,
      maximumStatements: 100_000,
      maximumTotalSourceUtf8Bytes: 16_777_216,
    });

    const result = createInstructionIrSnapshot(fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance).toMatchObject({
      algorithm: "sha256-canonical-b03-v1",
      contractVersion: "0.1.0",
      instructionIrContractVersion: "0.1.0",
      recordKind: "agent-context-instruction-ir-snapshot-provenance",
    });
    expect(result.provenance.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.provenance.counts).toEqual({
      activationRules: 1,
      documents: 1,
      events: 4,
      imports: 1,
      nodes: 7,
      sources: 1,
      statements: 1,
      targets: 1,
    });
    expect(result.provenance.usage).toMatchObject({
      sourceUtf16CodeUnits: 46,
      sourceUtf8Bytes: 48,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expectDeepFrozen(result.provenance);
  });

  test("detaches and recursively freezes every admitted B03 value", () => {
    const input = fixture();
    const result = createInstructionIrSnapshot(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshot = result.value;
    expect(snapshot).not.toBe(input);
    for (const key of [
      "sources",
      "documents",
      "nodes",
      "imports",
      "statements",
      "activationRules",
      "targets",
      "events",
    ] as const)
      expect(snapshot[key]).not.toBe(input[key]);
    expectDeepFrozen(snapshot);

    const originalSource = firstRecord(input["sources"]);
    const originalParseState = record(originalSource["parseState"]);
    const originalDocument = firstRecord(input["documents"]);
    const originalNode = firstRecord(input["nodes"]);
    const originalNodeRange = record(originalNode["range"]);
    const originalNodeStart = record(originalNodeRange["start"]);
    const originalEvents = array(input["events"]);
    const originalSettingValue = firstSetting(input)["value"];
    originalSource["path"] = "changed.md";
    originalSource["text"] = "changed";
    originalSource["sha256"] = "0".repeat(64);
    originalParseState["state"] = "malformed";
    array(originalDocument["importIds"]).length = 0;
    originalNodeStart["byteOffset"] = 9;
    originalEvents.length = 0;
    if (Array.isArray(originalSettingValue)) originalSettingValue.push("changed");

    expect(snapshot.sources[0]?.path).toBe("AGENTS.md");
    expect(snapshot.sources[0]?.text).toContain("Use 🧭 paths.");
    expect(snapshot.sources[0]?.parseState).toEqual({ state: "complete" });
    expect(snapshot.documents[0]?.importIds).toEqual(["import:guide"]);
    expect(snapshot.nodes[0]?.range.start.byteOffset).toBe(0);
    expect(snapshot.events).toHaveLength(4);
    expect(() => {
      (snapshot.sources as unknown[]).push("forbidden");
    }).toThrow(TypeError);
    expect(getInstructionIrSnapshotProvenance(snapshot)).toBe(result.provenance);
  });

  test("uses exact same-process object identity as authority", () => {
    const firstInput = fixture();
    const secondInput = fixture();
    firstSetting(firstInput)["value"] = { alpha: 1, beta: 2 };
    firstSetting(secondInput)["value"] = { beta: 2, alpha: 1 };
    const first = createInstructionIrSnapshot(firstInput);
    const second = createInstructionIrSnapshot(secondInput);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).not.toBe(second.value);
    expect(first.provenance.digest).toBe(second.provenance.digest);
    expect(isIssuedInstructionIrSnapshot(first.value)).toBe(true);
    expect(isIssuedInstructionIrSnapshot(second.value)).toBe(true);

    const serialized = JSON.parse(JSON.stringify(first.value)) as unknown;
    expect(isIssuedInstructionIrSnapshot(serialized)).toBe(false);
    expect(getInstructionIrSnapshotProvenance(serialized)).toBeUndefined();
    const reissued = createInstructionIrSnapshot(serialized);
    expect(reissued.ok).toBe(true);
    if (reissued.ok) expect(reissued.provenance.digest).toBe(first.provenance.digest);
    expect(isIssuedInstructionIrSnapshot(new Proxy(first.value, {}))).toBe(false);
    expect(isIssuedInstructionIrSnapshot(null)).toBe(false);
    expect(isIssuedInstructionIrSnapshot(true)).toBe(false);
  });

  test("preserves safe acyclic aliases while freezing their one detached copy", () => {
    const input = fixture();
    const shared = { enabled: true, names: ["one", "two"] };
    firstSetting(input)["value"] = shared;
    const secondSetting = record(array(firstRecord(input["events"])["settings"])[1]);
    secondSetting["value"] = shared;
    const snapshot = successful(input);
    const settings = array(
      snapshot.events[0]?.kind === "launch" ? snapshot.events[0].settings : [],
    );
    const firstValue = record(record(settings[0])["value"]);
    const secondValue = record(record(settings[1])["value"]);
    expect(firstValue).toBe(secondValue);
    expect(firstValue).not.toBe(shared);
    expectDeepFrozen(firstValue);
    shared.enabled = false;
    expect(firstValue["enabled"]).toBe(true);
  });
});

describe("hostile JSON admission", () => {
  test("rejects root, nested, and revoked proxies without invoking traps", () => {
    let calls = 0;
    const rootProxy = new Proxy(fixture(), {
      ownKeys(): never {
        calls += 1;
        throw new Error("must not run");
      },
    });
    expectIssue(rootProxy, "invalid-json", "$");
    expect(calls).toBe(0);

    const nested = fixture();
    firstSetting(nested)["value"] = new Proxy(
      {},
      {
        get(): never {
          calls += 1;
          throw new Error("must not run");
        },
      },
    );
    expectIssue(nested, "invalid-json");
    expect(calls).toBe(0);

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const revoked = fixture();
    firstSetting(revoked)["value"] = revocable.proxy;
    expectIssue(revoked, "invalid-json");
  });

  test("rejects accessors without invocation", () => {
    let calls = 0;
    const root = fixture();
    Object.defineProperty(root, "events", {
      enumerable: true,
      get(): unknown {
        calls += 1;
        return [];
      },
    });
    expectIssue(root, "invalid-json", "$.events");
    expect(calls).toBe(0);

    const nested = fixture();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      get(): string {
        calls += 1;
        return "must not run";
      },
    });
    firstSetting(nested)["value"] = hostile;
    expectIssue(nested, "invalid-json");
    expect(calls).toBe(0);
  });

  test("rejects exotic prototypes, symbols, non-enumerable fields, and unsupported values", () => {
    const cases: unknown[] = [];

    const exotic = fixture();
    firstSetting(exotic)["value"] = Object.create({ inherited: true }) as object;
    cases.push(exotic);

    const symbol = fixture();
    const withSymbol = { accepted: true };
    Object.defineProperty(withSymbol, Symbol("hidden"), { enumerable: true, value: true });
    firstSetting(symbol)["value"] = withSymbol;
    cases.push(symbol);

    const hidden = fixture();
    const withHidden = { accepted: true };
    Object.defineProperty(withHidden, "hidden", { enumerable: false, value: true });
    firstSetting(hidden)["value"] = withHidden;
    cases.push(hidden);

    for (const unsupported of [undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      const input = fixture();
      firstSetting(input)["value"] = unsupported;
      cases.push(input);
    }
    for (const input of cases) expectIssue(input, "invalid-json");
  });

  test("rejects hostile root and array prototypes before semantic validation", () => {
    expectIssue([], "invalid-json", "$");

    const exoticRoot = fixture();
    Reflect.setPrototypeOf(exoticRoot, { inherited: true });
    expectIssue(exoticRoot, "invalid-json", "$");

    const symbolRoot = fixture();
    Object.defineProperty(symbolRoot, Symbol("root"), { enumerable: true, value: true });
    expectIssue(symbolRoot, "invalid-json");

    const exoticArray = fixture();
    const value: unknown[] = [true];
    Reflect.setPrototypeOf(value, null);
    firstSetting(exoticArray)["value"] = value;
    expectIssue(exoticArray, "invalid-json");
  });

  test("rejects cycles but accepts null-prototype JSON records", () => {
    const cyclicValue: Record<string, unknown> = {};
    cyclicValue["self"] = cyclicValue;
    const cyclic = fixture();
    firstSetting(cyclic)["value"] = cyclicValue;
    expectIssue(cyclic, "invalid-json");

    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype["safe"] = [true, null, "value"];
    const accepted = fixture();
    firstSetting(accepted)["value"] = nullPrototype;
    const snapshot = successful(accepted);
    const event = snapshot.events[0];
    expect(event?.kind).toBe("launch");
    if (event?.kind === "launch")
      expect(event.settings[0]?.value).toEqual({ safe: [true, null, "value"] });
  });

  test("rejects sparse, extended, and excessively deep arrays", () => {
    const sparse = fixture();
    const sparseValue = new Array<unknown>(2);
    sparseValue[1] = true;
    firstSetting(sparse)["value"] = sparseValue;
    expectIssue(sparse, "invalid-json");

    const extended = fixture();
    const extendedValue: unknown[] = [true];
    Object.defineProperty(extendedValue, "extra", { enumerable: true, value: false });
    firstSetting(extended)["value"] = extendedValue;
    expectIssue(extended, "invalid-json");

    const nonCanonical = fixture();
    const nonCanonicalValue = new Array<unknown>(1);
    Object.defineProperty(nonCanonicalValue, "01", { enumerable: true, value: false });
    firstSetting(nonCanonical)["value"] = nonCanonicalValue;
    expectIssue(nonCanonical, "invalid-json");

    const accessor = fixture();
    const accessorValue = new Array<unknown>(1);
    let calls = 0;
    Object.defineProperty(accessorValue, "0", {
      enumerable: true,
      get(): boolean {
        calls += 1;
        return true;
      },
    });
    firstSetting(accessor)["value"] = accessorValue;
    expectIssue(accessor, "invalid-json");
    expect(calls).toBe(0);

    const deep = fixture();
    let nested: unknown = true;
    for (let index = 0; index < 257; index += 1) nested = [nested];
    firstSetting(deep)["value"] = nested;
    expectIssue(deep, "invalid-json");
  });

  test("rejects malformed Unicode in keys and values", () => {
    const badValue = fixture();
    firstSetting(badValue)["value"] = "\ud800";
    expectIssue(badValue, "invalid-json");

    const badKey = fixture();
    firstSetting(badKey)["value"] = { ["\udc00"]: true };
    expectIssue(badKey, "invalid-json");
  });
});

describe("snapshot resource boundaries", () => {
  const rootCollections = [
    ["sources", "maximumSources"],
    ["documents", "maximumDocuments"],
    ["nodes", "maximumNodes"],
    ["imports", "maximumImports"],
    ["statements", "maximumStatements"],
    ["activationRules", "maximumActivationRules"],
    ["targets", "maximumTargets"],
    ["events", "maximumEvents"],
  ] as const;

  test.each(rootCollections)(
    "checks %s length before enumerating entries",
    (collection, limitKey) => {
      const atLimit = fixture();
      atLimit[collection] = new Array(INSTRUCTION_IR_SNAPSHOT_LIMITS[limitKey]);
      const atLimitIssues = issues(atLimit);
      expect(atLimitIssues[0]?.code).toBe("invalid-json");

      const overLimit = fixture();
      overLimit[collection] = new Array(INSTRUCTION_IR_SNAPSHOT_LIMITS[limitKey] + 1);
      expectIssue(overLimit, "resource-limit", `$.${collection}`);
    },
  );

  test("enforces source per-item and aggregate UTF-8/UTF-16 limits", () => {
    const exactText = "a".repeat(INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSourceUtf8Bytes);
    const exact = fixture();
    firstRecord(exact["sources"])["text"] = exactText;
    expect(issues(exact)[0]?.code).not.toBe("resource-limit");

    const over = fixture();
    firstRecord(over["sources"])["text"] = `${exactText}a`;
    expectIssue(over, "resource-limit", "$.sources[0].text");

    const utf8 = fixture();
    firstRecord(utf8["sources"])["text"] = "é".repeat(
      INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSourceUtf8Bytes / 2 + 1,
    );
    expectIssue(utf8, "resource-limit", "$.sources[0].text");

    const aggregateExact = fixture();
    const source = firstRecord(aggregateExact["sources"]);
    source["text"] = exactText;
    aggregateExact["sources"] = new Array(32).fill(source);
    expect(issues(aggregateExact)[0]?.code).not.toBe("resource-limit");

    const aggregateOver = fixture();
    const repeatedSource = firstRecord(aggregateOver["sources"]);
    repeatedSource["text"] = exactText;
    aggregateOver["sources"] = [
      ...Array.from({ length: 32 }, () => repeatedSource),
      { ...repeatedSource, text: "a" },
    ];
    expectIssue(aggregateOver, "resource-limit", "$.sources[32].text");

    const aggregateUtf8 = fixture();
    const utf8Source = firstRecord(aggregateUtf8["sources"]);
    utf8Source["text"] = "é".repeat(INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSourceUtf8Bytes / 2);
    aggregateUtf8["sources"] = new Array(33).fill(utf8Source);
    expectIssue(aggregateUtf8, "resource-limit", "$.sources[32].text");

    const missingText = fixture();
    Reflect.deleteProperty(firstRecord(missingText["sources"]), "text");
    expectIssue(missingText, "missing-field", "$.sources[0].text");
  });

  test("enforces nested activation and event cardinalities", () => {
    const cases: readonly [path: string, mutate: (input: Record<string, unknown>) => void][] = [
      [
        "$.activationRules[0]",
        (input): void => {
          firstRecord(input["activationRules"])["include"] = new Array(
            INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSelectorsPerActivationRule + 1,
          ).fill(null);
        },
      ],
      [
        "$.activationRules[0].conditions",
        (input): void => {
          firstRecord(input["activationRules"])["conditions"] = new Array(
            INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumConditionsPerActivationRule + 1,
          ).fill("condition");
        },
      ],
      [
        "$.activationRules[0].evidenceRefs",
        (input): void => {
          firstRecord(input["activationRules"])["evidenceRefs"] = new Array(
            INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumEvidenceRefsPerActivationRule + 1,
          ).fill(null);
        },
      ],
      [
        "$.events[0].workspaceRoots",
        (input): void => {
          firstRecord(input["events"])["workspaceRoots"] = new Array(
            INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumWorkspaceRootsPerEvent + 1,
          ).fill(".");
        },
      ],
      [
        "$.events[0].settings",
        (input): void => {
          firstRecord(input["events"])["settings"] = new Array(
            INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSettingsPerEvent + 1,
          ).fill(null);
        },
      ],
      [
        "$.events[0].ruleIds",
        (input): void => {
          firstRecord(input["events"])["ruleIds"] = new Array(
            INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSelectedRulesPerEvent + 1,
          ).fill("activation:vscode-description");
        },
      ],
    ];
    for (const [path, mutate] of cases) {
      const input = fixture();
      mutate(input);
      expectIssue(input, "resource-limit", path);
    }
  });

  test("enforces aggregate references and activation collections at exact plus-one edges", () => {
    const nodeExact = fixture();
    const node = firstRecord(nodeExact["nodes"]);
    node["childIds"] = new Array(
      INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumNodeChildReferences - 3,
    ).fill("node:heading");
    expect(issues(nodeExact)[0]?.code).not.toBe("resource-limit");
    const nodeOver = fixture();
    firstRecord(nodeOver["nodes"])["childIds"] = new Array(
      INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumNodeChildReferences - 2,
    ).fill("node:heading");
    expectIssue(nodeOver, "resource-limit");

    const statementExact = fixture();
    const statement = firstRecord(statementExact["statements"]);
    statement["nodeIds"] = new Array(100_000).fill("node:heading");
    statementExact["statements"] = new Array(10).fill(statement);
    expect(issues(statementExact)[0]?.code).not.toBe("resource-limit");
    const statementOver = fixture();
    const repeatedStatement = firstRecord(statementOver["statements"]);
    repeatedStatement["nodeIds"] = new Array(100_000).fill("node:heading");
    statementOver["statements"] = [
      ...Array.from({ length: 10 }, () => repeatedStatement),
      { ...repeatedStatement, nodeIds: ["node:heading"] },
    ];
    expectIssue(statementOver, "resource-limit", "$.statements[10].nodeIds");

    const aggregateCases: readonly [
      field: "conditions" | "evidenceRefs" | "include",
      perRule: number,
      aggregate: number,
      issuePath: string,
    ][] = [
      [
        "include",
        INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumSelectorsPerActivationRule,
        INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumActivationSelectors,
        "$.activationRules[16]",
      ],
      [
        "conditions",
        INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumConditionsPerActivationRule,
        INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumActivationConditions,
        "$.activationRules[64].conditions",
      ],
      [
        "evidenceRefs",
        INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumEvidenceRefsPerActivationRule,
        INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumActivationEvidenceRefs,
        "$.activationRules[16].evidenceRefs",
      ],
    ];
    for (const [field, perRule, aggregate, issuePath] of aggregateCases) {
      const exact = fixture();
      const activation = firstRecord(exact["activationRules"]);
      activation[field] = new Array(perRule).fill(field === "conditions" ? "condition" : null);
      const repetitions = aggregate / perRule;
      exact["activationRules"] = new Array(repetitions).fill(activation);
      expect(issues(exact)[0]?.code).not.toBe("resource-limit");

      const over = fixture();
      const repeated = firstRecord(over["activationRules"]);
      repeated[field] = new Array(perRule).fill(field === "conditions" ? "condition" : null);
      over["activationRules"] = [
        ...Array.from({ length: repetitions }, () => repeated),
        { ...repeated, [field]: [field === "conditions" ? "condition" : null] },
      ];
      expectIssue(over, "resource-limit", issuePath);
    }
  });

  test("enforces event JSON, container, key, string, cumulative-string, and value budgets", () => {
    const eventValuesExact = fixture();
    firstSetting(eventValuesExact)["value"] = new Array(
      INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumEventJsonValues - 3,
    ).fill(null);
    expect(createInstructionIrSnapshot(eventValuesExact).ok).toBe(true);

    const eventValues = fixture();
    firstSetting(eventValues)["value"] = new Array(
      INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumEventJsonValues,
    ).fill(null);
    expectIssue(eventValues, "resource-limit", "$.events");

    const container = fixture();
    firstSetting(container)["value"] = new Array(
      INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumContainerEntries + 1,
    );
    expectIssue(container, "resource-limit");

    const objectContainer = fixture();
    const tooManyFields: Record<string, unknown> = {};
    for (
      let index = 0;
      index < INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumContainerEntries + 1;
      index += 1
    )
      tooManyFields[`k${String(index)}`] = null;
    firstSetting(objectContainer)["value"] = tooManyFields;
    expectIssue(objectContainer, "resource-limit");

    const key = fixture();
    firstSetting(key)["value"] = {
      ["k".repeat(INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumKeyBytes + 1)]: true,
    };
    expectIssue(key, "resource-limit");

    const string = fixture();
    firstSetting(string)["value"] = "s".repeat(
      INSTRUCTION_IR_SNAPSHOT_LIMITS.maximumStringBytes + 1,
    );
    expectIssue(string, "resource-limit");

    const multibyteString = fixture();
    firstSetting(multibyteString)["value"] = "é".repeat(600_000);
    expectIssue(multibyteString, "resource-limit");

    const cumulative = fixture();
    const repeatedString = "s".repeat(1_024);
    firstSetting(cumulative)["value"] = new Array(70_000).fill(repeatedString);
    expectIssue(cumulative, "resource-limit");

    const values = fixture();
    const shared = new Array(40).fill(null);
    firstSetting(values)["value"] = new Array(100_000).fill(shared);
    expectIssue(values, "resource-limit");

    const malformedEvents = fixture();
    malformedEvents["events"] = [null];
    expect(issues(malformedEvents)).not.toHaveLength(0);

    const malformedSettings = fixture();
    firstRecord(malformedSettings["events"])["settings"] = [null];
    expect(issues(malformedSettings)).not.toHaveLength(0);
  });

  test("returns deterministic immutable failures without reflecting hostile values", () => {
    const input = fixture();
    firstSetting(input)["value"] = "secret-token-123\ud800";
    const first = createInstructionIrSnapshot(input);
    const second = createInstructionIrSnapshot(input);
    expect(first).toEqual(second);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(JSON.stringify(first)).not.toContain("secret-token-123");
    expect(first.issues.every((entry) => Object.isFrozen(entry))).toBe(true);
  });
});

// Compile-time coverage for the public discriminated result; runtime tests above cover both arms.
function resultIsSuccess(result: InstructionIrSnapshotResult): boolean {
  return result.ok;
}

expect(resultIsSuccess(createInstructionIrSnapshot(fixture()))).toBe(true);
