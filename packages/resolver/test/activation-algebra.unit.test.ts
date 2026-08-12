import { describe, expect, test, vi } from "vitest";

import {
  ActivationAlgebraError,
  ActivationAlgebraErrorCode,
  activationComplement,
  activationDifference,
  activationFact,
  activationIntersection,
  activationUnion,
  evaluateActivationRule,
  serializeActivationResult,
  type ActivationFactDecision,
  type ActivationResult,
  type ActivationState,
  type ConditionalActivationRequest,
  type GlobActivationRequest,
} from "../src/index.js";
import type {
  ActivationRule,
  ActivationSelector,
  RepositoryRelativePath,
} from "@agent-context/core";

const STATES = ["active", "inactive", "indeterminate"] as const;

function fact(state: ActivationState, key: string = state): ActivationResult {
  return activationFact(state, key, `${key} is ${state}`);
}

function directory(path: string): ActivationSelector {
  return {
    kind: "directory-tree",
    path: path as RepositoryRelativePath,
    sourceRange: null,
  };
}

function glob(pattern: string, dialectId: string | null = "test-glob-v1"): ActivationSelector {
  return {
    kind: "glob",
    pattern,
    dialectId,
    sourceRange: null,
    uncertainty:
      dialectId === null ? { state: "unknown", reason: "dialect is unknown" } : { state: "known" },
  };
}

function rule(
  kind: ActivationRule["kind"],
  overrides: Partial<ActivationRule> = {},
): ActivationRule {
  const include =
    kind === "directory-tree" ? [directory("src")] : kind === "glob" ? [glob("src/**")] : [];
  return {
    id: "activation:test",
    documentId: "document:test",
    profileId: "profile-test",
    surfaceId: "profile-test/local",
    specSnapshotId: "profile-test/2026-08-02",
    kind,
    scopeRoot: "." as RepositoryRelativePath,
    include,
    exclude: [],
    conditions: kind === "conditional" ? ["The profile selects the rule as relevant."] : [],
    unknownReason: kind === "unknown" ? "Activation semantics are not documented." : null,
    evidenceRefs: [{ sourceId: "official-source", factId: "ACT-001" }],
    uncertainty:
      kind === "unknown"
        ? { state: "unknown", reason: "Activation semantics are not documented." }
        : kind === "conditional"
          ? { state: "conditional", conditions: ["Profile selection is required."] }
          : { state: "known" },
    ...overrides,
  } as ActivationRule;
}

function stateOfUnion(left: ActivationState, right: ActivationState): ActivationState {
  if (left === "active" || right === "active") return "active";
  return left === "indeterminate" || right === "indeterminate" ? "indeterminate" : "inactive";
}

function stateOfIntersection(left: ActivationState, right: ActivationState): ActivationState {
  if (left === "inactive" || right === "inactive") return "inactive";
  return left === "indeterminate" || right === "indeterminate" ? "indeterminate" : "active";
}

function revokedProxy<T extends object>(target: T): T {
  const revocable = Proxy.revocable(target, {});
  revocable.revoke();
  return revocable.proxy;
}

function expectAlgebraError(
  operation: () => unknown,
  code: (typeof ActivationAlgebraErrorCode)[keyof typeof ActivationAlgebraErrorCode],
  cause?: unknown,
): void {
  try {
    operation();
    expect.unreachable(`expected ${code}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ActivationAlgebraError);
    expect(error).toMatchObject(cause === undefined ? { code } : { code, cause });
  }
}

function keyFor(
  result: ActivationResult,
  kind: (typeof result.provenance)[number]["kind"],
): string {
  const provenance = result.provenance.find((fact) => fact.kind === kind);
  expect(provenance, `missing ${kind} provenance`).toBeDefined();
  return provenance?.key ?? "";
}

describe("three-valued activation set algebra", () => {
  test.each(STATES.flatMap((left) => STATES.map((right) => [left, right] as const)))(
    "implements the union truth table for %s and %s",
    (left, right) => {
      expect(
        activationUnion([fact(left, `left-${left}`), fact(right, `right-${right}`)]).state,
      ).toBe(stateOfUnion(left, right));
    },
  );

  test.each(STATES.flatMap((left) => STATES.map((right) => [left, right] as const)))(
    "implements the intersection truth table for %s and %s",
    (left, right) => {
      expect(
        activationIntersection([fact(left, `left-${left}`), fact(right, `right-${right}`)]).state,
      ).toBe(stateOfIntersection(left, right));
    },
  );

  test.each([
    ["active", "inactive"],
    ["inactive", "active"],
    ["indeterminate", "indeterminate"],
  ] as const)("implements complement %s -> %s", (input, output) => {
    const source = fact(input);
    const actual = activationComplement(source);
    expect(actual.state).toBe(output);
    expect(actual.provenance).toEqual(source.provenance);
  });

  test.each(STATES.flatMap((left) => STATES.map((right) => [left, right] as const)))(
    "implements difference for %s minus %s",
    (left, right) => {
      const complement =
        right === "active" ? "inactive" : right === "inactive" ? "active" : "indeterminate";
      expect(
        activationDifference(fact(left, `left-${left}`), fact(right, `right-${right}`)).state,
      ).toBe(stateOfIntersection(left, complement));
    },
  );

  test("defines the empty-set and universal-set identities", () => {
    expect(activationUnion([])).toEqual({ state: "inactive", provenance: [] });
    expect(activationIntersection([])).toEqual({ state: "active", provenance: [] });
  });

  test.each(STATES)("is commutative and idempotent for %s", (state) => {
    const left = fact(state, "left");
    const right = fact(state, "right");
    expect(serializeActivationResult(activationUnion([left, right]))).toBe(
      serializeActivationResult(activationUnion([right, left])),
    );
    expect(serializeActivationResult(activationIntersection([left, right]))).toBe(
      serializeActivationResult(activationIntersection([right, left])),
    );
    expect(activationUnion([left, left])).toEqual(left);
    expect(activationIntersection([left, left])).toEqual(left);
  });

  test.each(STATES.flatMap((a) => STATES.flatMap((b) => STATES.map((c) => [a, b, c] as const))))(
    "is associative for %s, %s, %s",
    (a, b, c) => {
      const left = fact(a, "a");
      const middle = fact(b, "b");
      const right = fact(c, "c");
      expect(
        serializeActivationResult(activationUnion([activationUnion([left, middle]), right])),
      ).toBe(serializeActivationResult(activationUnion([left, activationUnion([middle, right])])));
      expect(
        serializeActivationResult(
          activationIntersection([activationIntersection([left, middle]), right]),
        ),
      ).toBe(
        serializeActivationResult(
          activationIntersection([left, activationIntersection([middle, right])]),
        ),
      );
    },
  );

  test.each(STATES.flatMap((left) => STATES.map((right) => [left, right] as const)))(
    "obeys De Morgan for %s and %s",
    (leftState, rightState) => {
      const left = fact(leftState, "left");
      const right = fact(rightState, "right");
      expect(activationComplement(activationUnion([left, right])).state).toBe(
        activationIntersection([activationComplement(left), activationComplement(right)]).state,
      );
      expect(activationComplement(activationIntersection([left, right])).state).toBe(
        activationUnion([activationComplement(left), activationComplement(right)]).state,
      );
    },
  );

  test("keeps only a deterministic minimal decisive proof", () => {
    const activeA = fact("active", "a");
    const activeZ = fact("active", "z");
    const inactiveA = fact("inactive", "a-inactive");
    const inactiveZ = fact("inactive", "z-inactive");
    const unknown = fact("indeterminate", "unknown");

    expect(activationUnion([inactiveA, activeZ, unknown, activeA]).provenance).toEqual(
      activeA.provenance,
    );
    expect(activationIntersection([activeA, inactiveZ, unknown, inactiveA]).provenance).toEqual(
      inactiveA.provenance,
    );
    expect(activationUnion([unknown, inactiveA]).provenance).toHaveLength(2);
    expect(activationIntersection([unknown, activeA]).provenance).toHaveLength(2);
  });

  test("canonicalizes proof order with explicit JS code-unit ordering", () => {
    const result = activationIntersection([
      fact("active", "é"),
      fact("active", "a"),
      fact("active", "e\u0301"),
      fact("active", "A"),
    ]);
    expect(result.provenance.map(({ key }) => key)).toEqual(["A", "a", "e\u0301", "é"]);
    expect(serializeActivationResult(result)).toBe(
      serializeActivationResult(
        activationIntersection([
          fact("active", "A"),
          fact("active", "e\u0301"),
          fact("active", "a"),
          fact("active", "é"),
        ]),
      ),
    );
  });

  test("returns deeply immutable plain results and canonical JSON", () => {
    const result = activationIntersection([fact("active", "b"), fact("active", "a")]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.provenance)).toBe(true);
    expect(result.provenance.every(Object.isFrozen)).toBe(true);
    expect(serializeActivationResult(result)).toBe(
      '{"state":"active","provenance":[{"key":"a","kind":"caller-fact","observedState":"active","description":"a is active"},{"key":"b","kind":"caller-fact","observedState":"active","description":"b is active"}]}',
    );
  });
});

describe("B03 activation-rule evaluation", () => {
  test("activates an always rule and applies a non-root scope", () => {
    expect(
      evaluateActivationRule(rule("always"), {
        targetPath: "src/main.ts" as RepositoryRelativePath,
      }).state,
    ).toBe("active");
    const scoped = rule("always", { scopeRoot: "packages/api" as RepositoryRelativePath });
    expect(
      evaluateActivationRule(scoped, {
        targetPath: "packages/api/index.ts" as RepositoryRelativePath,
      }).state,
    ).toBe("active");
    const outside = evaluateActivationRule(scoped, {
      targetPath: "packages/web/index.ts" as RepositoryRelativePath,
    });
    expect(outside.state).toBe("inactive");
    expect(outside.provenance.map(({ kind }) => kind)).toEqual(["scope-root"]);
  });

  test("matches directory selectors at exact component boundaries", () => {
    const directoryRule = rule("directory-tree");
    expect(
      evaluateActivationRule(directoryRule, { targetPath: "src" as RepositoryRelativePath }).state,
    ).toBe("active");
    expect(
      evaluateActivationRule(directoryRule, {
        targetPath: "src/lib/index.ts" as RepositoryRelativePath,
      }).state,
    ).toBe("active");
    expect(
      evaluateActivationRule(directoryRule, {
        targetPath: "src-other/index.ts" as RepositoryRelativePath,
      }).state,
    ).toBe("inactive");
  });

  test("delegates glob dialect behavior without defining shared syntax", () => {
    const requests: GlobActivationRequest[] = [];
    const result = evaluateActivationRule(rule("glob"), {
      targetPath: "src/main.ts" as RepositoryRelativePath,
      callbacks: {
        matchGlob(request): ActivationFactDecision {
          requests.push(request);
          expect(Object.isFrozen(request)).toBe(true);
          return { state: "active", reason: "test dialect matched the selected path" };
        },
      },
    });
    expect(result.state).toBe("active");
    expect(requests).toEqual([
      {
        ruleId: "activation:test",
        profileId: "profile-test",
        surfaceId: "profile-test/local",
        scopeRoot: ".",
        targetPath: "src/main.ts",
        pattern: "src/**",
        dialectId: "test-glob-v1",
      },
    ]);
  });

  test("does not guess when a required glob callback is absent", () => {
    const result = evaluateActivationRule(rule("glob", { include: [glob("**", null)] }), {
      targetPath: "src/main.ts" as RepositoryRelativePath,
    });
    expect(result.state).toBe("indeterminate");
    expect(result.provenance[0]?.description).toBe("No profile-owned glob matcher was supplied.");
  });

  test("resolves manual facts only through the caller callback", () => {
    expect(
      evaluateActivationRule(rule("manual"), {
        targetPath: "src/main.ts" as RepositoryRelativePath,
      }).state,
    ).toBe("indeterminate");
    expect(
      evaluateActivationRule(rule("manual"), {
        targetPath: "src/main.ts" as RepositoryRelativePath,
        callbacks: {
          resolveManual(request): ActivationFactDecision {
            expect(request).toMatchObject({
              ruleId: "activation:test",
              documentId: "document:test",
              profileId: "profile-test",
              surfaceId: "profile-test/local",
              specSnapshotId: "profile-test/2026-08-02",
              conditions: [],
            });
            expect(Object.isFrozen(request.conditions)).toBe(true);
            return { state: "inactive", reason: "the user did not mention this rule" };
          },
        },
      }).state,
    ).toBe("inactive");
  });

  test("passes B03 conditional conditions as one frozen predicate", () => {
    const conditional = rule("conditional", {
      conditions: ["model selected the rule", "surface supports selection"],
    });
    const resolver = vi.fn((request: ConditionalActivationRequest) => {
      expect(request).toMatchObject({
        ruleId: "activation:test",
        documentId: "document:test",
        profileId: "profile-test",
        surfaceId: "profile-test/local",
        specSnapshotId: "profile-test/2026-08-02",
      });
      expect(request.conditions).toEqual(["model selected the rule", "surface supports selection"]);
      expect(Object.isFrozen(request.conditions)).toBe(true);
      return { state: "active", reason: "the complete conditional fact is satisfied" } as const;
    });
    expect(
      evaluateActivationRule(conditional, {
        targetPath: "src/main.ts" as RepositoryRelativePath,
        callbacks: { resolveConditional: resolver },
      }).state,
    ).toBe("active");
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  test("propagates unknown activation unless a path predicate decides inactivity", () => {
    const unknown = rule("unknown", { include: [directory("src")] });
    expect(
      evaluateActivationRule(unknown, { targetPath: "src/main.ts" as RepositoryRelativePath })
        .state,
    ).toBe("indeterminate");
    const outside = evaluateActivationRule(unknown, {
      targetPath: "docs/index.md" as RepositoryRelativePath,
    });
    expect(outside.state).toBe("inactive");
    expect(outside.provenance.map(({ kind }) => kind)).toEqual(["directory-selector"]);
  });

  test("unions includes and gives a definite exclude final precedence", () => {
    const matcher = vi.fn(() => ({ state: "active", reason: "the test dialect matched" }) as const);
    const includeExclude = rule("glob", {
      include: [directory("docs"), glob("src/**"), glob("src/**")],
      exclude: [glob("src/**")],
    });
    const result = evaluateActivationRule(includeExclude, {
      targetPath: "src/main.ts" as RepositoryRelativePath,
      callbacks: { matchGlob: matcher },
    });
    expect(result.state).toBe("inactive");
    expect(result.provenance).toHaveLength(1);
    expect(result.provenance[0]).toMatchObject({ kind: "glob-selector", observedState: "active" });
    expect(matcher).toHaveBeenCalledTimes(1);
  });

  test("propagates an indeterminate exclusion over an eligible target", () => {
    const result = evaluateActivationRule(
      rule("always", { exclude: [glob("generated/**", null)] }),
      {
        targetPath: "src/main.ts" as RepositoryRelativePath,
      },
    );
    expect(result.state).toBe("indeterminate");
    expect(result.provenance.map(({ kind }) => kind)).toEqual(["always", "glob-selector"]);
  });

  test("does not request dynamic facts for targets outside scope", () => {
    const callback = vi.fn(() => ({ state: "active", reason: "selected" }) as const);
    const result = evaluateActivationRule(
      rule("conditional", { scopeRoot: "packages/api" as RepositoryRelativePath }),
      {
        targetPath: "packages/web/index.ts" as RepositoryRelativePath,
        callbacks: { resolveConditional: callback },
      },
    );
    expect(result.state).toBe("inactive");
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("activation provenance identity", () => {
  const targetPath = "src/main.ts" as RepositoryRelativePath;
  const conditionalCallbacks = {
    resolveConditional: (): ActivationFactDecision => ({
      state: "active",
      reason: "the complete conditional predicate is true",
    }),
  };

  test("frames ordered condition tuples without concatenation collisions", () => {
    const left = evaluateActivationRule(rule("conditional", { conditions: ["ab", "c"] }), {
      targetPath,
      callbacks: conditionalCallbacks,
    });
    const right = evaluateActivationRule(rule("conditional", { conditions: ["a", "bc"] }), {
      targetPath,
      callbacks: conditionalCallbacks,
    });

    expect(keyFor(left, "conditional-fact")).not.toBe(keyFor(right, "conditional-fact"));
  });

  test("keys conditional facts by the complete rule identity and predicate", () => {
    const identityVariants: readonly Partial<ActivationRule>[] = [
      {},
      { id: "activation:other" as ActivationRule["id"] },
      { documentId: "document:other" as ActivationRule["documentId"] },
      { profileId: "profile-other" },
      { surfaceId: "profile-test/other" },
      { specSnapshotId: "profile-test/2026-08-03" },
    ];
    const identityKeys = identityVariants.map((overrides) =>
      keyFor(
        evaluateActivationRule(rule("conditional", overrides), {
          targetPath,
          callbacks: conditionalCallbacks,
        }),
        "conditional-fact",
      ),
    );
    expect(new Set(identityKeys).size).toBe(identityVariants.length);

    const base = evaluateActivationRule(rule("conditional"), {
      targetPath,
      callbacks: conditionalCallbacks,
    });
    const changedTarget = evaluateActivationRule(rule("conditional"), {
      targetPath: "src/other.ts" as RepositoryRelativePath,
      callbacks: conditionalCallbacks,
    });
    const changedCondition = evaluateActivationRule(
      rule("conditional", { conditions: ["a different complete predicate"] }),
      { targetPath, callbacks: conditionalCallbacks },
    );
    expect(keyFor(changedTarget, "conditional-fact")).not.toBe(keyFor(base, "conditional-fact"));
    expect(keyFor(changedCondition, "conditional-fact")).not.toBe(keyFor(base, "conditional-fact"));
  });

  test("includes the relevant rule domain in trigger, scope, and selector facts", () => {
    const always = evaluateActivationRule(rule("always"), { targetPath });
    const changedSnapshot = evaluateActivationRule(
      rule("always", { specSnapshotId: "profile-test/2026-08-03" }),
      { targetPath },
    );
    expect(keyFor(always, "always")).not.toBe(keyFor(changedSnapshot, "always"));

    const scoped = evaluateActivationRule(
      rule("always", { scopeRoot: "src" as RepositoryRelativePath }),
      { targetPath },
    );
    const changedScopeProfile = evaluateActivationRule(
      rule("always", {
        profileId: "profile-other",
        scopeRoot: "src" as RepositoryRelativePath,
      }),
      { targetPath },
    );
    expect(keyFor(scoped, "scope-root")).not.toBe(keyFor(changedScopeProfile, "scope-root"));

    const selected = evaluateActivationRule(rule("directory-tree"), { targetPath });
    const changedSelectorSurface = evaluateActivationRule(
      rule("directory-tree", { surfaceId: "profile-test/other" }),
      { targetPath },
    );
    expect(keyFor(selected, "directory-selector")).not.toBe(
      keyFor(changedSelectorSurface, "directory-selector"),
    );

    const unknown = evaluateActivationRule(rule("unknown"), { targetPath });
    const changedReason = evaluateActivationRule(
      rule("unknown", {
        unknownReason: "The profile explicitly reports a different unknown predicate.",
      }),
      { targetPath },
    );
    expect(keyFor(unknown, "unknown-rule")).not.toBe(keyFor(changedReason, "unknown-rule"));

    const matchGlob = (): ActivationFactDecision => ({ state: "active", reason: "matched" });
    const rootGlob = evaluateActivationRule(rule("glob"), {
      targetPath,
      callbacks: { matchGlob },
    });
    const scopedGlob = evaluateActivationRule(
      rule("glob", { scopeRoot: "src" as RepositoryRelativePath }),
      { targetPath, callbacks: { matchGlob } },
    );
    expect(keyFor(rootGlob, "glob-selector")).not.toBe(keyFor(scopedGlob, "glob-selector"));
  });

  test("serializes repeated evaluations and duplicate proofs deterministically", () => {
    const first = evaluateActivationRule(rule("conditional"), {
      targetPath,
      callbacks: conditionalCallbacks,
    });
    const second = evaluateActivationRule(rule("conditional"), {
      targetPath,
      callbacks: conditionalCallbacks,
    });
    expect(serializeActivationResult(second)).toBe(serializeActivationResult(first));
    expect(serializeActivationResult(activationIntersection([first, second, first]))).toBe(
      serializeActivationResult(first),
    );
  });
});

describe("malformed and resource-bounded input", () => {
  test("rejects malformed algebra records, arrays, states, text, and Unicode", () => {
    expect(() => activationUnion({} as never)).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );

    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get(): string {
        return "not read";
      },
    });
    expect(() => activationUnion(accessorArray as never)).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );

    const extraProperty: unknown[] = [];
    Object.defineProperty(extraProperty, "extra", { enumerable: true, value: true });
    expect(() => activationUnion(extraProperty as never)).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );
    const symbolArray: unknown[] = [];
    Object.defineProperty(symbolArray, Symbol("extra"), { enumerable: true, value: true });
    expect(() => activationUnion(symbolArray as never)).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );
    const hiddenArray: unknown[] = [];
    Object.defineProperty(hiddenArray, "hidden", { enumerable: false, value: true });
    expect(() => activationUnion(hiddenArray as never)).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );
    expect(() =>
      activationUnion([{ state: "active", provenance: [], extra: true } as never]),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }));
    const symbolResult = { state: "active", provenance: [] };
    Object.defineProperty(symbolResult, Symbol("extra"), { enumerable: true, value: true });
    expect(() => activationUnion([symbolResult as never])).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );
    expect(() => activationUnion([{ state: "active", provenance: [null] } as never])).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );
    expect(() => activationFact("invalid" as ActivationState, "key", "description")).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );
    expect(() => activationFact("active", "", "description")).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );
    expect(() => activationFact("active", "\ud800", "description")).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
    );
    expect(() => activationFact("active", "key", "x".repeat(16_385))).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }),
    );
  });

  test("rejects invalid and conflicting externally constructed provenance", () => {
    const base = {
      key: "key",
      kind: "caller-fact",
      observedState: "active",
      description: "description",
    } as const;
    for (const provenance of [
      [{ ...base, kind: "invalid-kind" }],
      [{ ...base, observedState: "invalid-state" }],
      [{ ...base, description: "" }],
    ]) {
      expect(() => activationUnion([{ state: "active", provenance } as never])).toThrow(
        expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidResult }),
      );
    }
    const duplicate = { state: "active", provenance: [base, base] } as const;
    expect(activationUnion([duplicate])).toEqual({ state: "active", provenance: [base] });
  });

  test("rejects non-canonical targets", () => {
    expect(() =>
      evaluateActivationRule(rule("always"), {
        targetPath: "src/../outside" as RepositoryRelativePath,
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidTargetPath }));
    expect(() =>
      evaluateActivationRule(rule("always"), {
        targetPath: `src/${String.fromCharCode(0xd800)}` as RepositoryRelativePath,
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidTargetPath }));
    expect(() =>
      evaluateActivationRule(rule("always"), {
        targetPath: "x".repeat(16_385) as RepositoryRelativePath,
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }));
  });

  test("bounds derived keys and descriptions for maximum-size valid values", () => {
    const largeId = "a".repeat(16_384);
    const largePath = "p".repeat(16_384) as RepositoryRelativePath;
    const result = evaluateActivationRule(
      rule("directory-tree", {
        id: largeId as ActivationRule["id"],
        include: [directory(largePath)],
      }),
      { targetPath: largePath },
    );
    expect(result.state).toBe("active");
    expect(result.provenance).toHaveLength(1);
    expect(result.provenance[0]?.key).toMatch(/^directory-selector:[a-f0-9]{64}$/);
    expect(result.provenance[0]?.description).toMatch(/sha256:[a-f0-9]{64}; 16384 bytes/);
    expect(Buffer.byteLength(result.provenance[0]?.description ?? "", "utf8")).toBeLessThan(1_024);
  });

  test("rejects proxies and accessors without invoking traps or getters", () => {
    let getterCalled = false;
    const input = Object.defineProperty({}, "targetPath", {
      enumerable: true,
      get(): string {
        getterCalled = true;
        return "src/main.ts";
      },
    });
    expect(() => evaluateActivationRule(rule("always"), input as never)).toThrow(
      ActivationAlgebraError,
    );
    expect(getterCalled).toBe(false);

    const proxiedRule = new Proxy(rule("always"), {});
    expect(() =>
      evaluateActivationRule(proxiedRule, { targetPath: "src/main.ts" as RepositoryRelativePath }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidRule }));

    expect(() => evaluateActivationRule(rule("always"), new Date() as never)).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidTargetPath }),
    );
  });

  test("rejects revoked proxies at every public aggregate trust boundary", () => {
    const targetPath = "src/main.ts" as RepositoryRelativePath;
    const provenance = {
      key: "key",
      kind: "caller-fact",
      observedState: "active",
      description: "description",
    } as const;

    expectAlgebraError(
      () => evaluateActivationRule(revokedProxy(rule("always")), { targetPath }),
      ActivationAlgebraErrorCode.invalidRule,
    );
    expectAlgebraError(
      () => evaluateActivationRule(rule("always"), revokedProxy({ targetPath })),
      ActivationAlgebraErrorCode.invalidTargetPath,
    );
    expectAlgebraError(
      () =>
        evaluateActivationRule(rule("manual"), {
          targetPath,
          callbacks: revokedProxy({}),
        }),
      ActivationAlgebraErrorCode.invalidCallback,
    );
    expectAlgebraError(
      () => activationUnion(revokedProxy([] as ActivationResult[])),
      ActivationAlgebraErrorCode.invalidResult,
    );
    expectAlgebraError(
      () => activationUnion([revokedProxy(fact("active"))]),
      ActivationAlgebraErrorCode.invalidResult,
    );
    expectAlgebraError(
      () => activationUnion([{ state: "active", provenance: revokedProxy([provenance]) }]),
      ActivationAlgebraErrorCode.invalidResult,
    );
    expectAlgebraError(
      () => activationUnion([{ state: "active", provenance: [revokedProxy(provenance)] }]),
      ActivationAlgebraErrorCode.invalidResult,
    );
  });

  test("rejects revoked proxies in every B03 rule array boundary", () => {
    const targetPath = "src/main.ts" as RepositoryRelativePath;
    const cases: readonly ActivationRule[] = [
      rule("directory-tree", { include: revokedProxy([directory("src")]) }),
      rule("always", { exclude: revokedProxy([directory("vendor")]) }),
      rule("conditional", { conditions: revokedProxy(["selected"]) }),
      rule("always", {
        evidenceRefs: revokedProxy([{ sourceId: "official-source", factId: "ACT-001" }]),
      }),
      rule("directory-tree", { include: [revokedProxy(directory("src"))] }),
      rule("always", {
        evidenceRefs: [revokedProxy({ sourceId: "official-source", factId: "ACT-001" })],
      }),
    ];
    for (const malformed of cases) {
      expectAlgebraError(
        () => evaluateActivationRule(malformed, { targetPath }),
        ActivationAlgebraErrorCode.invalidRule,
      );
    }
  });

  test("rejects a revoked callback result as a stable library error", () => {
    expectAlgebraError(
      () =>
        evaluateActivationRule(rule("manual"), {
          targetPath: "src/main.ts" as RepositoryRelativePath,
          callbacks: {
            resolveManual: () => revokedProxy({ state: "active", reason: "selected" }),
          },
        }),
      ActivationAlgebraErrorCode.invalidCallback,
    );
  });

  test.each([
    ["invalid kind", rule("always", { kind: "invalid" as ActivationRule["kind"] })],
    ["invalid scope", rule("always", { scopeRoot: "../outside" as RepositoryRelativePath })],
    ["non-array include", rule("always", { include: null as never })],
    ["non-record selector", rule("always", { include: [null as never] })],
    [
      "open directory selector",
      rule("directory-tree", { include: [{ ...directory("src"), extra: true } as never] }),
    ],
    ["invalid directory path", rule("directory-tree", { include: [directory("../src")] })],
    [
      "open glob selector",
      rule("glob", { include: [{ ...glob("src/**"), extra: true } as never] }),
    ],
    ["empty glob", rule("glob", { include: [glob("")] })],
    [
      "invalid glob dialect",
      rule("glob", { include: [{ ...glob("src/**"), dialectId: 42 } as never] }),
    ],
    [
      "invalid selector kind",
      rule("always", { include: [{ kind: "other", sourceRange: null } as never] }),
    ],
    ["duplicate conditions", rule("conditional", { conditions: ["same", "same"] })],
    ["missing evidence", rule("always", { evidenceRefs: [] })],
    ["always conditions", rule("always", { conditions: ["not allowed"] })],
    ["directory kind mismatch", rule("directory-tree", { include: [glob("src/**")] })],
    ["glob kind mismatch", rule("glob", { include: [directory("src")] })],
    ["conditional without conditions", rule("conditional", { conditions: [] })],
    ["unknown without reason", rule("unknown", { unknownReason: null })],
    ["reason on known kind", rule("always", { unknownReason: "not allowed" })],
  ] as const)("rejects a malformed B03 rule: %s", (_label, malformedRule) => {
    expect(() =>
      evaluateActivationRule(malformedRule, {
        targetPath: "src/main.ts" as RepositoryRelativePath,
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidRule }));
  });

  test("rejects sparse billion-length arrays in constant bounded work", () => {
    const sparse: ActivationSelector[] = [];
    sparse.length = 1_000_000_000;
    const malformed = rule("directory-tree", { include: sparse });
    const started = performance.now();
    expect(() =>
      evaluateActivationRule(malformed, { targetPath: "src/main.ts" as RepositoryRelativePath }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }));
    expect(performance.now() - started).toBeLessThan(100);

    const operands: ActivationResult[] = [];
    operands.length = 1_000_000_000;
    expect(() => activationUnion(operands)).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }),
    );
  });

  test("enforces selector and cumulative provenance limits", () => {
    const selectors = Array.from({ length: 4_097 }, () => directory("src"));
    expect(() =>
      evaluateActivationRule(rule("directory-tree", { include: selectors }), {
        targetPath: "src/main.ts" as RepositoryRelativePath,
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }));

    const operands = Array.from({ length: 4_097 }, (_, index) => fact("active", String(index)));
    expect(() => activationIntersection(operands)).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }),
    );

    const include = Array.from({ length: 4_096 }, () => directory("src"));
    expect(() =>
      evaluateActivationRule(rule("directory-tree", { include, exclude: [directory("vendor")] }), {
        targetPath: "src/main.ts" as RepositoryRelativePath,
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }));

    const largeConditions = Array.from(
      { length: 65 },
      (_, index) => `${String(index).padStart(4, "0")}${"x".repeat(16_380)}`,
    );
    expect(() =>
      evaluateActivationRule(rule("conditional", { conditions: largeConditions }), {
        targetPath: "src/main.ts" as RepositoryRelativePath,
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }));

    const manyFacts = Array.from({ length: 4_096 }, (_, index) => ({
      key: `key-${String(index)}`,
      kind: "caller-fact" as const,
      observedState: "active" as const,
      description: `fact ${String(index)}`,
    }));
    expect(() =>
      activationIntersection([
        { state: "active", provenance: manyFacts },
        activationFact("active", "one-more", "one more fact"),
      ]),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }));

    const textHeavyOperands = Array.from({ length: 65 }, (_, index) =>
      activationFact(
        "active",
        `key-${String(index)}`,
        `${"x".repeat(16_380)}${String(index).padStart(4, "0")}`,
      ),
    );
    expect(() => activationUnion(textHeavyOperands)).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }),
    );
  });

  test("rejects malformed callback containers, members, states, and reasons", () => {
    const targetPath = "src/main.ts" as RepositoryRelativePath;
    expect(() =>
      evaluateActivationRule(rule("manual"), { targetPath, callbacks: [] as never }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidCallback }));
    expect(() =>
      evaluateActivationRule(rule("manual"), {
        targetPath,
        callbacks: { extra: (): void => undefined } as never,
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidCallback }));
    expect(() =>
      evaluateActivationRule(rule("manual"), {
        targetPath,
        callbacks: { resolveManual: 42 } as never,
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidCallback }));
    expect(() =>
      evaluateActivationRule(rule("manual"), {
        targetPath,
        callbacks: {
          resolveManual: () => ({ state: "invalid", reason: "bad state" }) as never,
        },
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidCallback }));
    expect(() =>
      evaluateActivationRule(rule("manual"), {
        targetPath,
        callbacks: {
          resolveManual: () => ({ state: "active", reason: "x".repeat(16_385) }),
        },
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }));

    const symbolDecision = { state: "active", reason: "selected" };
    Object.defineProperty(symbolDecision, Symbol("extra"), { enumerable: true, value: true });
    expect(() =>
      evaluateActivationRule(rule("manual"), {
        targetPath,
        callbacks: { resolveManual: () => symbolDecision as ActivationFactDecision },
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidCallback }));
  });

  test("rejects malformed callback results without reclassifying normalization errors", () => {
    expect(() =>
      evaluateActivationRule(rule("manual"), {
        targetPath: "src/main.ts" as RepositoryRelativePath,
        callbacks: { resolveManual: () => ({ state: "active" }) as never },
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.invalidCallback }));

    expect(() =>
      evaluateActivationRule(rule("manual"), {
        targetPath: "src/main.ts" as RepositoryRelativePath,
        callbacks: {
          resolveManual: () => ({ state: "active", reason: "x".repeat(16_385) }),
        },
      }),
    ).toThrow(expect.objectContaining({ code: ActivationAlgebraErrorCode.resourceLimit }));
  });

  test("wraps exceptions thrown by every callback, including forged library errors", () => {
    const targetPath = "src/main.ts" as RepositoryRelativePath;
    const globCause = new Error("glob implementation failed");
    const manualCause = new ActivationAlgebraError(
      ActivationAlgebraErrorCode.invalidCallback,
      "forged callback-owned library error",
    );
    const conditionalCause = new Error("conditional implementation failed");

    expectAlgebraError(
      () =>
        evaluateActivationRule(rule("glob"), {
          targetPath,
          callbacks: {
            matchGlob(): ActivationFactDecision {
              throw globCause;
            },
          },
        }),
      ActivationAlgebraErrorCode.callbackFailed,
      globCause,
    );
    expectAlgebraError(
      () =>
        evaluateActivationRule(rule("manual"), {
          targetPath,
          callbacks: {
            resolveManual(): ActivationFactDecision {
              throw manualCause;
            },
          },
        }),
      ActivationAlgebraErrorCode.callbackFailed,
      manualCause,
    );
    expectAlgebraError(
      () =>
        evaluateActivationRule(rule("conditional"), {
          targetPath,
          callbacks: {
            resolveConditional(): ActivationFactDecision {
              throw conditionalCause;
            },
          },
        }),
      ActivationAlgebraErrorCode.callbackFailed,
      conditionalCause,
    );
  });

  test("rejects conflicting facts that claim one provenance key", () => {
    const left = activationFact("active", "same-key", "first description");
    const right = activationFact("active", "same-key", "second description");
    expect(() => activationIntersection([left, right])).toThrow(
      expect.objectContaining({ code: ActivationAlgebraErrorCode.conflictingProvenance }),
    );
  });

  test("handles repeated adversarial composition without recursive growth", () => {
    let result = activationFact("indeterminate", "unknown", "fact is unknown");
    for (let index = 0; index < 10_000; index += 1) {
      result = activationComplement(activationComplement(result));
      result = activationIntersection([result, result]);
    }
    expect(result).toEqual(activationFact("indeterminate", "unknown", "fact is unknown"));
  });
});
