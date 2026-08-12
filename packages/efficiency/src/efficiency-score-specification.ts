import { types as nodeTypes } from "node:util";

import {
  CONFIGURATION_CONTRACT_VERSION,
  EFFICIENCY_COMPONENT_KEYS,
  validateAgentContextConfiguration,
} from "@agent-context/core";
import type {
  AgentContextConfiguration,
  EfficiencyComponentKey,
  EfficiencyScoreVersion,
} from "@agent-context/core";

export const EFFICIENCY_SCORE_SPECIFICATION_CONTRACT_VERSION = "0.1.0" as const;
export const EFFICIENCY_SCORE_SPECIFICATION_RECORD_KIND =
  "agent-context-efficiency-score-specification" as const;
export const EFFICIENCY_SCORE_VERSION = "1.0.0" as const;
export const EFFICIENCY_SCORE_BASIS_POINTS = 10_000 as const;
export const EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS = 1_000_000 as const;
export const EFFICIENCY_DENSITY_TARGET_BASIS_POINTS = 2_000_000 as const;
export const EFFICIENCY_BROAD_SCOPE_CUTOFF_BASIS_POINTS = 8_000 as const;

export type EfficiencyGrade = "A" | "B" | "C" | "D" | "F";

export interface EfficiencyGradeThresholds {
  readonly A: number;
  readonly B: number;
  readonly C: number;
  readonly D: number;
}

export interface PenaltyCurvePoint {
  readonly inputBasisPoints: number;
  readonly penaltyBasisPoints: number;
}

export interface PenaltyCurve {
  readonly id: string;
  readonly inputUnit: "basis-points";
  readonly interpolation: "piecewise-linear-round-half-up-v1";
  readonly outOfRange: "clamp-to-endpoints";
  readonly points: readonly PenaltyCurvePoint[];
}

export type EfficiencyMetricNormalization =
  | "budget-utilization-v1"
  | "broad-scope-token-share-v1"
  | "cross-profile-divergence-rate-v1"
  | "dead-scope-token-share-v1"
  | "density-shortfall-v1"
  | "duplicate-token-share-v1"
  | "import-amplification-overhead-v1";

export interface EfficiencyScoreInputSpecification {
  readonly allocationBasisPoints: number;
  readonly curve: PenaltyCurve;
  readonly id: string;
  readonly metricSource: string;
  readonly normalization: EfficiencyMetricNormalization;
  readonly uncertaintyPolicy: "required-complete-evidence";
}

export interface EfficiencyScoreComponentSpecification {
  readonly id: EfficiencyComponentKey;
  readonly inputs: readonly EfficiencyScoreInputSpecification[];
  readonly weight: number;
}

export interface EfficiencyScoreSpecification {
  readonly arithmetic: {
    readonly aggregateFormula: "round-half-up(sum(componentScoreBasisPoints*weight)/10000)";
    readonly componentFormula: "10000-round-half-up(sum(penaltyBasisPoints*allocation)/10000)";
    readonly gradeBoundary: "inclusive-lower-bound";
    readonly integerImplementation: "bigint";
    readonly ratioRounding: "round-half-up";
    readonly scoreBasisPoints: typeof EFFICIENCY_SCORE_BASIS_POINTS;
  };
  readonly budgets: {
    readonly alwaysOnTokens: number;
    readonly effectiveP95Tokens: number;
    readonly zeroBudgetPolicy: "zero-observed-is-zero-utilization-otherwise-saturate";
  };
  readonly components: readonly EfficiencyScoreComponentSpecification[];
  readonly configurationVersion: typeof CONFIGURATION_CONTRACT_VERSION;
  readonly contractVersion: typeof EFFICIENCY_SCORE_SPECIFICATION_CONTRACT_VERSION;
  readonly gradeThresholds: EfficiencyGradeThresholds;
  readonly qualityClaim: false;
  readonly recordKind: typeof EFFICIENCY_SCORE_SPECIFICATION_RECORD_KIND;
  readonly scoreVersion: typeof EFFICIENCY_SCORE_VERSION;
}

export const EfficiencyScoreSpecificationErrorCode: Readonly<{
  invalidConfiguration: "EFFICIENCY_SCORE_INVALID_CONFIGURATION";
  invalidCurve: "EFFICIENCY_SCORE_INVALID_CURVE";
  invalidInput: "EFFICIENCY_SCORE_INVALID_INPUT";
}> = Object.freeze({
  invalidConfiguration: "EFFICIENCY_SCORE_INVALID_CONFIGURATION",
  invalidCurve: "EFFICIENCY_SCORE_INVALID_CURVE",
  invalidInput: "EFFICIENCY_SCORE_INVALID_INPUT",
} as const);

export type EfficiencyScoreSpecificationErrorCode =
  (typeof EfficiencyScoreSpecificationErrorCode)[keyof typeof EfficiencyScoreSpecificationErrorCode];

export class EfficiencyScoreSpecificationError extends Error {
  readonly code: EfficiencyScoreSpecificationErrorCode;
  override readonly name = "EfficiencyScoreSpecificationError" as const;

  constructor(code: EfficiencyScoreSpecificationErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

const CURVE_KEYS = ["id", "inputUnit", "interpolation", "outOfRange", "points"] as const;
const POINT_KEYS = ["inputBasisPoints", "penaltyBasisPoints"] as const;
const CURVE_ID_PATTERN = /^efficiency:[a-z0-9]+(?:-[a-z0-9]+)*:v1$/u;
const MAX_CURVE_POINTS = 32;

function fail(code: EfficiencyScoreSpecificationErrorCode, message: string): never {
  throw new EfficiencyScoreSpecificationError(code, message);
}

function dataRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  )
    return fail(
      EfficiencyScoreSpecificationErrorCode.invalidCurve,
      `${label} must be a data record`,
    );
  let prototype: object | null;
  let actual: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    actual = Reflect.ownKeys(value);
  } catch {
    return fail(EfficiencyScoreSpecificationErrorCode.invalidCurve, `${label} cannot be inspected`);
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail(
      EfficiencyScoreSpecificationErrorCode.invalidCurve,
      `${label} has unexpected fields`,
    );
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        EfficiencyScoreSpecificationErrorCode.invalidCurve,
        `${label}.${key} must be an own data field`,
      );
  }
  return value as DataRecord;
}

function property(value: DataRecord, key: string): unknown {
  return Reflect.getOwnPropertyDescriptor(value, key)?.value;
}

function boundedInteger(
  value: unknown,
  maximum: number,
  label: string,
  code: EfficiencyScoreSpecificationErrorCode = EfficiencyScoreSpecificationErrorCode.invalidInput,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    return fail(
      code,
      `${label} must be a non-negative safe integer no greater than ${String(maximum)}`,
    );
  return value;
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function point(inputBasisPoints: number, penaltyBasisPoints: number): PenaltyCurvePoint {
  return Object.freeze({ inputBasisPoints, penaltyBasisPoints });
}

function curve(id: string, points: readonly PenaltyCurvePoint[]): PenaltyCurve {
  return deepFreeze({
    id,
    inputUnit: "basis-points" as const,
    interpolation: "piecewise-linear-round-half-up-v1" as const,
    outOfRange: "clamp-to-endpoints" as const,
    points,
  });
}

const BUDGET_CURVE = curve("efficiency:budget-utilization:v1", [
  point(0, 0),
  point(10_000, 0),
  point(12_500, 2_500),
  point(15_000, 6_000),
  point(20_000, 10_000),
]);
const BROAD_SCOPE_CURVE = curve("efficiency:broad-scope-token-share:v1", [
  point(0, 0),
  point(2_500, 0),
  point(5_000, 2_000),
  point(7_500, 6_000),
  point(10_000, 10_000),
]);
const EXACT_DUPLICATE_CURVE = curve("efficiency:exact-duplicate-token-share:v1", [
  point(0, 0),
  point(500, 0),
  point(1_500, 5_000),
  point(3_000, 10_000),
]);
const NEAR_DUPLICATE_CURVE = curve("efficiency:near-duplicate-token-share:v1", [
  point(0, 0),
  point(1_000, 0),
  point(2_500, 4_000),
  point(5_000, 10_000),
]);
const DEAD_SCOPE_CURVE = curve("efficiency:dead-scope-token-share:v1", [
  point(0, 0),
  point(500, 0),
  point(2_000, 4_000),
  point(5_000, 10_000),
]);
const AMPLIFICATION_CURVE = curve("efficiency:import-amplification-overhead:v1", [
  point(0, 0),
  point(500, 0),
  point(1_500, 3_000),
  point(3_000, 7_000),
  point(5_000, 10_000),
]);
const DENSITY_CURVE = curve("efficiency:instruction-density-shortfall:v1", [
  point(0, 0),
  point(2_500, 0),
  point(5_000, 5_000),
  point(7_500, 8_000),
  point(10_000, 10_000),
]);
const DIVERGENCE_CURVE = curve("efficiency:cross-profile-divergence-rate:v1", [
  point(0, 0),
  point(1_000, 1_000),
  point(2_500, 3_500),
  point(5_000, 7_000),
  point(10_000, 10_000),
]);

function input(
  id: string,
  allocationBasisPoints: number,
  metricSource: string,
  normalization: EfficiencyMetricNormalization,
  penaltyCurve: PenaltyCurve,
): EfficiencyScoreInputSpecification {
  return Object.freeze({
    allocationBasisPoints,
    curve: penaltyCurve,
    id,
    metricSource,
    normalization,
    uncertaintyPolicy: "required-complete-evidence" as const,
  });
}

const INPUTS_BY_COMPONENT: Readonly<
  Record<EfficiencyComponentKey, readonly EfficiencyScoreInputSpecification[]>
> = deepFreeze({
  budgetFit: [
    input(
      "always-on-p95-budget",
      5_000,
      "G05.distributions.targets.alwaysOnTokens",
      "budget-utilization-v1",
      BUDGET_CURVE,
    ),
    input(
      "effective-p95-budget",
      5_000,
      "G05.distributions.statistics.p95",
      "budget-utilization-v1",
      BUDGET_CURVE,
    ),
  ],
  scopePrecision: [
    input(
      "broad-scope-token-share",
      10_000,
      "G05.broadScope.documents",
      "broad-scope-token-share-v1",
      BROAD_SCOPE_CURVE,
    ),
  ],
  nonRedundancy: [
    input(
      "exact-duplicate-token-share",
      7_000,
      "G05.duplication.exact.redundantTokens",
      "duplicate-token-share-v1",
      EXACT_DUPLICATE_CURVE,
    ),
    input(
      "near-duplicate-token-share",
      3_000,
      "G05.duplication.near.similarityCandidateTokens",
      "duplicate-token-share-v1",
      NEAR_DUPLICATE_CURVE,
    ),
  ],
  reachability: [
    input(
      "dead-scope-token-share",
      6_000,
      "G05.deadScope.tokens",
      "dead-scope-token-share-v1",
      DEAD_SCOPE_CURVE,
    ),
    input(
      "import-amplification-overhead",
      4_000,
      "G05.amplification.statistics.p95BasisPoints",
      "import-amplification-overhead-v1",
      AMPLIFICATION_CURVE,
    ),
  ],
  instructionDensity: [
    input(
      "instruction-density-shortfall",
      10_000,
      "G05.density.actionablePerThousandBasisPoints",
      "density-shortfall-v1",
      DENSITY_CURVE,
    ),
  ],
  crossAgentConsistency: [
    input(
      "cross-profile-divergence-rate",
      10_000,
      "G05.divergence.divergentPairTargetCount/observedPairTargetCount",
      "cross-profile-divergence-rate-v1",
      DIVERGENCE_CURVE,
    ),
  ],
});

function normalizeConfiguration(inputValue: unknown): AgentContextConfiguration["efficiency"] {
  const input = inputValue === undefined ? {} : inputValue;
  const validation = validateAgentContextConfiguration({
    efficiency: input,
    version: CONFIGURATION_CONTRACT_VERSION,
  });
  if (!validation.ok) {
    const issue = validation.issues[0];
    return fail(
      EfficiencyScoreSpecificationErrorCode.invalidConfiguration,
      issue === undefined
        ? "efficiency configuration is invalid"
        : `${issue.path}: ${issue.message}`,
    );
  }
  return validation.value.efficiency;
}

/** Create the immutable score formula selected by a sparse B06 efficiency configuration. */
export function createEfficiencyScoreSpecification(
  inputValue?: unknown,
): EfficiencyScoreSpecification {
  const configuration = normalizeConfiguration(inputValue);
  const components = EFFICIENCY_COMPONENT_KEYS.map((id) =>
    Object.freeze({
      id,
      inputs: INPUTS_BY_COMPONENT[id],
      weight: configuration.componentWeights[id],
    }),
  );
  return deepFreeze({
    arithmetic: {
      aggregateFormula: "round-half-up(sum(componentScoreBasisPoints*weight)/10000)" as const,
      componentFormula: "10000-round-half-up(sum(penaltyBasisPoints*allocation)/10000)" as const,
      gradeBoundary: "inclusive-lower-bound" as const,
      integerImplementation: "bigint" as const,
      ratioRounding: "round-half-up" as const,
      scoreBasisPoints: EFFICIENCY_SCORE_BASIS_POINTS,
    },
    budgets: {
      ...configuration.budgets,
      zeroBudgetPolicy: "zero-observed-is-zero-utilization-otherwise-saturate" as const,
    },
    components,
    configurationVersion: CONFIGURATION_CONTRACT_VERSION,
    contractVersion: EFFICIENCY_SCORE_SPECIFICATION_CONTRACT_VERSION,
    gradeThresholds: { ...configuration.gradeThresholds },
    qualityClaim: false as const,
    recordKind: EFFICIENCY_SCORE_SPECIFICATION_RECORD_KIND,
    scoreVersion: EFFICIENCY_SCORE_VERSION,
  });
}

function normalizedCurve(value: unknown): readonly PenaltyCurvePoint[] {
  const record = dataRecord(value, CURVE_KEYS, "curve");
  const id = property(record, "id");
  if (typeof id !== "string" || !CURVE_ID_PATTERN.test(id))
    return fail(EfficiencyScoreSpecificationErrorCode.invalidCurve, "curve.id is invalid");
  if (
    property(record, "inputUnit") !== "basis-points" ||
    property(record, "interpolation") !== "piecewise-linear-round-half-up-v1" ||
    property(record, "outOfRange") !== "clamp-to-endpoints"
  )
    return fail(
      EfficiencyScoreSpecificationErrorCode.invalidCurve,
      "curve arithmetic metadata is invalid",
    );
  const rawPoints = property(record, "points");
  if (
    nodeTypes.isProxy(rawPoints) ||
    !Array.isArray(rawPoints) ||
    Reflect.getPrototypeOf(rawPoints) !== Array.prototype ||
    rawPoints.length < 2 ||
    rawPoints.length > MAX_CURVE_POINTS ||
    Reflect.ownKeys(rawPoints).length !== rawPoints.length + 1
  )
    return fail(
      EfficiencyScoreSpecificationErrorCode.invalidCurve,
      "curve.points must be a bounded dense array",
    );
  const pointValues: unknown[] = [];
  for (let index = 0; index < rawPoints.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(rawPoints, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        EfficiencyScoreSpecificationErrorCode.invalidCurve,
        `curve.points[${String(index)}] must be an own data entry`,
      );
    pointValues.push(descriptor.value);
  }
  const points = pointValues.map((rawPoint, index) => {
    const pointRecord = dataRecord(rawPoint, POINT_KEYS, `curve.points[${String(index)}]`);
    return {
      inputBasisPoints: boundedInteger(
        property(pointRecord, "inputBasisPoints"),
        EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS,
        `curve.points[${String(index)}].inputBasisPoints`,
        EfficiencyScoreSpecificationErrorCode.invalidCurve,
      ),
      penaltyBasisPoints: boundedInteger(
        property(pointRecord, "penaltyBasisPoints"),
        EFFICIENCY_SCORE_BASIS_POINTS,
        `curve.points[${String(index)}].penaltyBasisPoints`,
        EfficiencyScoreSpecificationErrorCode.invalidCurve,
      ),
    };
  });
  const firstPoint = points[0];
  const finalPoint = points.at(-1);
  /* v8 ignore start -- the validated 2..32 length proves both endpoints */
  if (firstPoint === undefined || finalPoint === undefined)
    return fail(EfficiencyScoreSpecificationErrorCode.invalidCurve, "curve endpoints are missing");
  /* v8 ignore stop */
  if (firstPoint.inputBasisPoints !== 0 || firstPoint.penaltyBasisPoints !== 0)
    return fail(EfficiencyScoreSpecificationErrorCode.invalidCurve, "curve must start at (0, 0)");
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      previous === undefined ||
      current === undefined ||
      current.inputBasisPoints <= previous.inputBasisPoints ||
      current.penaltyBasisPoints < previous.penaltyBasisPoints
    )
      return fail(
        EfficiencyScoreSpecificationErrorCode.invalidCurve,
        "curve points must increase by input and not decrease by penalty",
      );
  }
  if (finalPoint.penaltyBasisPoints !== EFFICIENCY_SCORE_BASIS_POINTS)
    return fail(
      EfficiencyScoreSpecificationErrorCode.invalidCurve,
      "curve must terminate at the maximum penalty",
    );
  return points;
}

/** Evaluate a published penalty curve with integer, platform-independent interpolation. */
export function evaluateEfficiencyPenaltyCurve(curveValue: unknown, inputValue: unknown): number {
  const inputBasisPoints = boundedInteger(
    inputValue,
    EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS,
    "inputBasisPoints",
  );
  const points = normalizedCurve(curveValue);
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined)
    return fail(EfficiencyScoreSpecificationErrorCode.invalidCurve, "curve has no endpoints");
  if (inputBasisPoints <= first.inputBasisPoints) return first.penaltyBasisPoints;
  if (inputBasisPoints >= last.inputBasisPoints) return last.penaltyBasisPoints;
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (left === undefined || right === undefined || inputBasisPoints > right.inputBasisPoints)
      continue;
    const inputOffset = BigInt(inputBasisPoints - left.inputBasisPoints);
    const inputSpan = BigInt(right.inputBasisPoints - left.inputBasisPoints);
    const penaltySpan = BigInt(right.penaltyBasisPoints - left.penaltyBasisPoints);
    return left.penaltyBasisPoints + Number(roundHalfUp(inputOffset * penaltySpan, inputSpan));
  }
  return fail(EfficiencyScoreSpecificationErrorCode.invalidCurve, "curve segment is unavailable");
}

/** Normalize a non-negative ratio to basis points with exact half-up rounding. */
export function efficiencyRatioBasisPoints(
  numeratorValue: unknown,
  denominatorValue: unknown,
): number {
  const numerator = boundedInteger(numeratorValue, Number.MAX_SAFE_INTEGER, "numerator");
  const denominator = boundedInteger(denominatorValue, Number.MAX_SAFE_INTEGER, "denominator");
  if (denominator === 0) return numerator === 0 ? 0 : EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS;
  const result = roundHalfUp(
    BigInt(numerator) * BigInt(EFFICIENCY_SCORE_BASIS_POINTS),
    BigInt(denominator),
  );
  return Number(
    result > BigInt(EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS)
      ? BigInt(EFFICIENCY_SCORE_MAX_CURVE_INPUT_BASIS_POINTS)
      : result,
  );
}

/** Map an integer 0-100 score to an inclusive B06 grade threshold. */
export function gradeEfficiencyScore(
  scoreValue: unknown,
  thresholdsValue: unknown,
): EfficiencyGrade {
  const score = boundedInteger(scoreValue, 100, "score");
  const configuration = normalizeConfiguration({ gradeThresholds: thresholdsValue });
  const thresholds = configuration.gradeThresholds;
  if (score >= thresholds.A) return "A";
  if (score >= thresholds.B) return "B";
  if (score >= thresholds.C) return "C";
  if (score >= thresholds.D) return "D";
  return "F";
}

/** Public default specification; callers receive a deeply immutable canonical value. */
export const DEFAULT_EFFICIENCY_SCORE_SPECIFICATION: EfficiencyScoreSpecification =
  createEfficiencyScoreSpecification();

/** Type guard for the sole supported v1 score formula identity. */
export function isSupportedEfficiencyScoreVersion(value: unknown): value is EfficiencyScoreVersion {
  return value === EFFICIENCY_SCORE_VERSION;
}
