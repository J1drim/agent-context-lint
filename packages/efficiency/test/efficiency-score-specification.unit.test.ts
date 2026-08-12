import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { describe, expect, test } from "vitest";

import {
  DEFAULT_EFFICIENCY_SCORE_SPECIFICATION,
  EFFICIENCY_BROAD_SCOPE_CUTOFF_BASIS_POINTS,
  EFFICIENCY_DENSITY_TARGET_BASIS_POINTS,
  EFFICIENCY_SCORE_BASIS_POINTS,
  EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS,
  EFFICIENCY_SCORE_SPECIFICATION_CONTRACT_VERSION,
  EFFICIENCY_SCORE_SPECIFICATION_RECORD_KIND,
  EFFICIENCY_SCORE_VERSION,
  EfficiencyScoreSpecificationError,
  EfficiencyScoreSpecificationErrorCode,
  createEfficiencyScoreSpecification,
  efficiencyRatioBasisPoints,
  evaluateEfficiencyPenaltyCurve,
  gradeEfficiencyScore,
  isSupportedEfficiencyScoreVersion,
} from "../src/index.js";
import type { PenaltyCurve } from "../src/index.js";

const SCHEMA = new URL("../schemas/efficiency-score-specification.v1.schema.json", import.meta.url);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function curve(id: string): PenaltyCurve {
  const match = DEFAULT_EFFICIENCY_SCORE_SPECIFICATION.components
    .flatMap((component) => component.inputs)
    .find((input) => input.curve.id === id)?.curve;
  if (match === undefined) throw new Error(`curve ${id} missing`);
  return match;
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrow(EfficiencyScoreSpecificationError);
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe("G06 efficiency score specification", () => {
  test("publishes complete immutable defaults and a closed JSON schema", () => {
    const specification = DEFAULT_EFFICIENCY_SCORE_SPECIFICATION;
    expect(specification).toMatchObject({
      configurationVersion: 1,
      contractVersion: EFFICIENCY_SCORE_SPECIFICATION_CONTRACT_VERSION,
      qualityClaim: false,
      recordKind: EFFICIENCY_SCORE_SPECIFICATION_RECORD_KIND,
      scoreVersion: EFFICIENCY_SCORE_VERSION,
    });
    expect(specification.components.map(({ id, weight }) => ({ id, weight }))).toEqual([
      { id: "budgetFit", weight: 30 },
      { id: "scopePrecision", weight: 25 },
      { id: "nonRedundancy", weight: 20 },
      { id: "reachability", weight: 10 },
      { id: "instructionDensity", weight: 10 },
      { id: "crossAgentConsistency", weight: 5 },
    ]);
    expect(specification.components.reduce((sum, component) => sum + component.weight, 0)).toBe(
      100,
    );
    for (const component of specification.components) {
      expect(component.inputs.reduce((sum, input) => sum + input.allocationBasisPoints, 0)).toBe(
        EFFICIENCY_SCORE_BASIS_POINTS,
      );
      expect(Object.isFrozen(component)).toBe(true);
      expect(Object.isFrozen(component.inputs)).toBe(true);
      for (const input of component.inputs) {
        expect(Object.isFrozen(input.curve)).toBe(true);
        expect(Object.isFrozen(input.curve.points)).toBe(true);
      }
    }
    expect(Object.isFrozen(specification)).toBe(true);
    expect(Object.isFrozen(specification.gradeThresholds)).toBe(true);
    expect(EFFICIENCY_DENSITY_TARGET_BASIS_POINTS).toBe(2_000_000);
    expect(EFFICIENCY_BROAD_SCOPE_CUTOFF_BASIS_POINTS).toBe(8_000);

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as AnySchema;
    const validate = ajv.compile(schema);
    expect(validate(specification)).toBe(true);
    expect(validate({ ...specification, unexpected: true })).toBe(false);
    const missing = clone(specification) as unknown as Record<string, unknown>;
    Reflect.deleteProperty(missing, "components");
    expect(validate(missing)).toBe(false);
  });

  test("applies sparse B06 customization without mutating defaults", () => {
    const specification = createEfficiencyScoreSpecification({
      budgets: { alwaysOnTokens: 0, effectiveP95Tokens: 9_999 },
      componentWeights: {
        budgetFit: 40,
        crossAgentConsistency: 0,
        instructionDensity: 10,
        nonRedundancy: 20,
        reachability: 10,
        scopePrecision: 20,
      },
      gradeThresholds: { A: 95, B: 85, C: 65, D: 0 },
      scoreVersion: "1.0.0",
    });
    expect(specification.budgets).toEqual({
      alwaysOnTokens: 0,
      effectiveP95Tokens: 9_999,
      zeroBudgetPolicy: "zero-observed-is-zero-utilization-otherwise-saturate",
    });
    expect(specification.gradeThresholds).toEqual({ A: 95, B: 85, C: 65, D: 0 });
    expect(specification.components.map((component) => component.weight)).toEqual([
      40, 20, 20, 10, 10, 0,
    ]);
    expect(DEFAULT_EFFICIENCY_SCORE_SPECIFICATION.components[0]?.weight).toBe(30);
  });

  test.each([
    { unknown: true },
    { scoreVersion: "2.0.0" },
    { tokenizer: "provider" },
    { budgets: { alwaysOnTokens: -1 } },
    { budgets: { effectiveP95Tokens: Number.NaN } },
    { componentWeights: { budgetFit: 29 } },
    { componentWeights: { typo: 100 } },
    { gradeThresholds: { A: 80, B: 80 } },
    { gradeThresholds: { A: 101 } },
  ])("rejects malformed or relationally invalid B06 score configuration: %j", (value) => {
    expectCode(
      () => createEfficiencyScoreSpecification(value),
      EfficiencyScoreSpecificationErrorCode.invalidConfiguration,
    );
  });

  test("rejects hostile configuration without invoking repository-controlled accessors", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "budgets", {
      enumerable: true,
      get(): unknown {
        calls += 1;
        return {};
      },
    });
    for (const value of [
      accessor,
      new Proxy({}, {}),
      Object.create({ inherited: true }) as object,
      { componentWeights: new Array(2) },
      { cycle: null } as Record<string, unknown>,
    ]) {
      if ("cycle" in value) (value as Record<string, unknown>)["cycle"] = value;
      expectCode(
        () => createEfficiencyScoreSpecification(value),
        EfficiencyScoreSpecificationErrorCode.invalidConfiguration,
      );
    }
    expect(calls).toBe(0);
  });

  test("evaluates every curve endpoint, midpoint, and clamp with exact integer rounding", () => {
    const budget = curve("efficiency:budget-utilization:v1");
    expect(evaluateEfficiencyPenaltyCurve(budget, 0)).toBe(0);
    expect(evaluateEfficiencyPenaltyCurve(budget, 10_000)).toBe(0);
    expect(evaluateEfficiencyPenaltyCurve(budget, 11_250)).toBe(1_250);
    expect(evaluateEfficiencyPenaltyCurve(budget, 13_750)).toBe(4_250);
    expect(evaluateEfficiencyPenaltyCurve(budget, 17_500)).toBe(8_000);
    expect(evaluateEfficiencyPenaltyCurve(budget, 999_999)).toBe(10_000);

    const half: PenaltyCurve = {
      ...clone(budget),
      points: [
        { inputBasisPoints: 0, penaltyBasisPoints: 0 },
        { inputBasisPoints: 2, penaltyBasisPoints: 1 },
        { inputBasisPoints: 3, penaltyBasisPoints: 10_000 },
      ],
    };
    expect(evaluateEfficiencyPenaltyCurve(half, 1)).toBe(1);
  });

  test("rejects malformed and hostile curve records deterministically", () => {
    const source = curve("efficiency:budget-utilization:v1");
    const revoked = Proxy.revocable(clone(source), {});
    revoked.revoke();
    let arrayAccessorCalls = 0;
    const accessorPoints = clone(source.points) as unknown[];
    Object.defineProperty(accessorPoints, "0", {
      enumerable: true,
      get: () => {
        arrayAccessorCalls += 1;
        return source.points[0];
      },
    });
    const invalid: unknown[] = [
      null,
      [],
      { ...clone(source), extra: true },
      { ...clone(source), id: "bad" },
      { ...clone(source), interpolation: "float" },
      { ...clone(source), points: [] },
      { ...clone(source), points: new Array(2) },
      { ...clone(source), points: accessorPoints },
      { ...clone(source), points: Array.from({ length: 33 }, () => source.points[0]) },
      {
        ...clone(source),
        points: [
          { inputBasisPoints: 1, penaltyBasisPoints: 0 },
          { inputBasisPoints: 2, penaltyBasisPoints: 10_000 },
        ],
      },
      {
        ...clone(source),
        points: [
          { inputBasisPoints: 0, penaltyBasisPoints: 0 },
          { inputBasisPoints: 0, penaltyBasisPoints: 10_000 },
        ],
      },
      {
        ...clone(source),
        points: [
          { inputBasisPoints: 0, penaltyBasisPoints: 0 },
          { inputBasisPoints: 1, penaltyBasisPoints: 5_000 },
          { inputBasisPoints: 2, penaltyBasisPoints: 4_000 },
          { inputBasisPoints: 3, penaltyBasisPoints: 10_000 },
        ],
      },
      {
        ...clone(source),
        points: [
          { inputBasisPoints: 0, penaltyBasisPoints: 0 },
          { inputBasisPoints: 1, penaltyBasisPoints: 9_999 },
        ],
      },
      {
        ...clone(source),
        points: [
          { inputBasisPoints: 0, penaltyBasisPoints: 0 },
          { inputBasisPoints: 1, penaltyBasisPoints: Number.NaN },
        ],
      },
      new Proxy(clone(source), {}),
      revoked.proxy,
      Object.assign(Object.create({ inherited: true }) as object, clone(source)),
    ];
    const accessor = clone(source) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "id", { enumerable: true, get: () => source.id });
    invalid.push(accessor);
    const pointAccessor = clone(source) as unknown as { points: Record<string, unknown>[] };
    Object.defineProperty(pointAccessor.points[0], "inputBasisPoints", {
      enumerable: true,
      get: () => 0,
    });
    invalid.push(pointAccessor);
    for (const value of invalid)
      expectCode(
        () => evaluateEfficiencyPenaltyCurve(value, 1),
        EfficiencyScoreSpecificationErrorCode.invalidCurve,
      );
    expect(arrayAccessorCalls).toBe(0);
  });

  test("normalizes ratios exactly, including zero budgets and saturation", () => {
    expect(efficiencyRatioBasisPoints(0, 0)).toBe(0);
    expect(efficiencyRatioBasisPoints(1, 0)).toBe(EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS);
    expect(efficiencyRatioBasisPoints(1, 3)).toBe(3_333);
    expect(efficiencyRatioBasisPoints(2, 3)).toBe(6_667);
    expect(efficiencyRatioBasisPoints(100, 10)).toBe(100_000);
    expect(efficiencyRatioBasisPoints(Number.MAX_SAFE_INTEGER, 1)).toBe(
      EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS,
    );
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"])
      expectCode(
        () => efficiencyRatioBasisPoints(value, 1),
        EfficiencyScoreSpecificationErrorCode.invalidInput,
      );
    expectCode(
      () => efficiencyRatioBasisPoints(1, -1),
      EfficiencyScoreSpecificationErrorCode.invalidInput,
    );
  });

  test("maps inclusive ordered grade boundaries and rejects invalid scores or thresholds", () => {
    const thresholds = { A: 90, B: 80, C: 70, D: 55 };
    expect(
      [100, 90, 89, 80, 79, 70, 69, 55, 54, 0].map((score) =>
        gradeEfficiencyScore(score, thresholds),
      ),
    ).toEqual(["A", "A", "B", "B", "C", "C", "D", "D", "F", "F"]);
    expect(gradeEfficiencyScore(0, { A: 95, B: 85, C: 65, D: 0 })).toBe("D");
    expectCode(
      () => gradeEfficiencyScore(101, thresholds),
      EfficiencyScoreSpecificationErrorCode.invalidInput,
    );
    expectCode(
      () => gradeEfficiencyScore(50, { A: 90, B: 90, C: 70, D: 55 }),
      EfficiencyScoreSpecificationErrorCode.invalidConfiguration,
    );
  });

  test("keeps all curves monotonic and byte-deterministic across a property sweep", () => {
    const first = createEfficiencyScoreSpecification();
    const second = createEfficiencyScoreSpecification({});
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const uniqueCurves = new Map(
      first.components.flatMap((component) =>
        component.inputs.map((input) => [input.curve.id, input.curve] as const),
      ),
    );
    for (const candidate of uniqueCurves.values()) {
      let previous = -1;
      for (let value = 0; value <= 25_000; value += 37) {
        const penalty = evaluateEfficiencyPenaltyCurve(candidate, value);
        expect(penalty).toBeGreaterThanOrEqual(previous);
        expect(penalty).toBeGreaterThanOrEqual(0);
        expect(penalty).toBeLessThanOrEqual(EFFICIENCY_SCORE_BASIS_POINTS);
        previous = penalty;
      }
    }
    expect(isSupportedEfficiencyScoreVersion("1.0.0")).toBe(true);
    expect(isSupportedEfficiencyScoreVersion("1.0.1")).toBe(false);
  });
});
