import { types as nodeTypes } from "node:util";

import { UNCERTAINTY_STATES } from "./profile-contracts.js";

import type { UncertaintyState } from "./profile-contracts.js";

export type SharedValidationCode =
  | "duplicate-id"
  | "invalid-state"
  | "invalid-value"
  | "missing-field"
  | "resource-limit"
  | "unknown-field";

export type SharedValidationReporter = (
  code: SharedValidationCode,
  path: string,
  message: string,
) => void;

export interface JsonValidationLimits {
  readonly maximumContainerEntries: number;
  readonly maximumKeyBytes: number;
  readonly maximumStringBytes: number;
  readonly maximumTotalStringBytes: number;
  readonly maximumValues: number;
}

export interface UncertaintyValidationOptions {
  readonly maximumTextBytes?: number;
}

export const MAX_VALIDATION_ISSUES = 256 as const;
export const VALIDATION_ISSUE_LIMIT_CODE = "resource-limit" as const;

/** Internal bounded-validation control flow; public validators always catch this signal. */
export class ValidationIssueLimitReached extends Error {
  public constructor() {
    super("validation issue limit reached");
    this.name = "ValidationIssueLimitReached";
  }
}

type UnknownRecord = Record<string, unknown>;

const UNCERTAINTY_STATE_SET: ReadonlySet<string> = new Set(UNCERTAINTY_STATES);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/;
const MAX_JSON_NESTING_DEPTH = 256;

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function isBoundedText(value: string, maximumBytes?: number): boolean {
  return (
    (maximumBytes === undefined || value.length <= maximumBytes) &&
    hasWellFormedUnicode(value) &&
    (maximumBytes === undefined || Buffer.byteLength(value, "utf8") <= maximumBytes)
  );
}

function objectValue(
  value: unknown,
  path: string,
  keys: readonly string[],
  report: SharedValidationReporter,
): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("invalid-value", path, "must be an object");
    return undefined;
  }
  const record = value as UnknownRecord;
  const allowed: ReadonlySet<string> = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) report("unknown-field", `${path}.${key}`, "is not part of the contract");
  }
  return record;
}

function requiredString(
  record: UnknownRecord,
  key: string,
  path: string,
  report: SharedValidationReporter,
  maximumBytes?: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    report("missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || !isBoundedText(value, maximumBytes)) {
    report(
      "invalid-value",
      `${path}.${key}`,
      maximumBytes === undefined
        ? "must be non-empty well-formed Unicode"
        : `must be non-empty well-formed Unicode within ${String(maximumBytes)} UTF-8 bytes`,
    );
    return undefined;
  }
  return value;
}

function validateConditions(
  value: unknown,
  path: string,
  report: SharedValidationReporter,
  maximumBytes?: number,
): void {
  if (!Array.isArray(value)) {
    report("invalid-value", path, "must be an array");
    return;
  }
  if (value.length === 0) report("invalid-value", path, "must contain at least one condition");
  const seen = new Set<string>();
  for (const [index, condition] of value.entries()) {
    if (
      typeof condition !== "string" ||
      condition.length === 0 ||
      !isBoundedText(condition, maximumBytes)
    ) {
      report(
        "invalid-value",
        `${path}[${String(index)}]`,
        maximumBytes === undefined
          ? "must be non-empty well-formed Unicode"
          : `must be non-empty well-formed Unicode within ${String(maximumBytes)} UTF-8 bytes`,
      );
    } else if (seen.has(condition)) {
      report("duplicate-id", `${path}[${String(index)}]`, "duplicates an uncertainty condition");
    } else {
      seen.add(condition);
    }
  }
}

function validateAlternatives(
  value: unknown,
  path: string,
  report: SharedValidationReporter,
  maximumBytes?: number,
): void {
  if (!Array.isArray(value)) {
    report("invalid-value", path, "must be an array");
    return;
  }
  if (value.length < 2) report("invalid-value", path, "must contain at least two alternatives");
  const ids = new Set<string>();
  for (const [index, alternativeValue] of value.entries()) {
    const itemPath = `${path}[${String(index)}]`;
    const alternative = objectValue(alternativeValue, itemPath, ["id", "description"], report);
    if (alternative === undefined) continue;
    const id = requiredString(alternative, "id", itemPath, report, maximumBytes);
    requiredString(alternative, "description", itemPath, report, maximumBytes);
    if (id === undefined) continue;
    if (!IDENTIFIER_PATTERN.test(id)) {
      report("invalid-value", `${itemPath}.id`, "must be a stable identifier");
    } else if (ids.has(id)) {
      report("duplicate-id", path, `contains duplicate alternative '${id}'`);
    }
    ids.add(id);
  }
}

/** Validate the B02 uncertainty union for reuse by every higher-level contract. */
export function validateUncertaintyValue(
  value: unknown,
  path: string,
  report: SharedValidationReporter,
  options: UncertaintyValidationOptions = {},
): UncertaintyState | undefined {
  const record = objectValue(
    value,
    path,
    ["state", "conditions", "reason", "alternatives"],
    report,
  );
  if (record === undefined) return undefined;
  const state = requiredString(record, "state", path, report, options.maximumTextBytes);
  if (state === undefined) return undefined;
  if (!UNCERTAINTY_STATE_SET.has(state)) {
    report("invalid-state", `${path}.state`, `has unsupported state '${state}'`);
    return undefined;
  }

  if (state === "known") {
    for (const forbidden of ["conditions", "reason", "alternatives"]) {
      if (record[forbidden] !== undefined) {
        report("invalid-value", `${path}.${forbidden}`, `is not allowed for ${state} uncertainty`);
      }
    }
  } else if (state === "conditional") {
    if (record["conditions"] === undefined)
      report("missing-field", `${path}.conditions`, "is required");
    else
      validateConditions(
        record["conditions"],
        `${path}.conditions`,
        report,
        options.maximumTextBytes,
      );
    for (const forbidden of ["reason", "alternatives"]) {
      if (record[forbidden] !== undefined) {
        report(
          "invalid-value",
          `${path}.${forbidden}`,
          "is not allowed for conditional uncertainty",
        );
      }
    }
  } else if (state === "unknown") {
    requiredString(record, "reason", path, report, options.maximumTextBytes);
    for (const forbidden of ["conditions", "alternatives"]) {
      if (record[forbidden] !== undefined) {
        report("invalid-value", `${path}.${forbidden}`, "is not allowed for unknown uncertainty");
      }
    }
  } else {
    requiredString(record, "reason", path, report, options.maximumTextBytes);
    if (record["alternatives"] === undefined) {
      report("missing-field", `${path}.alternatives`, "is required");
    } else {
      validateAlternatives(
        record["alternatives"],
        `${path}.alternatives`,
        report,
        options.maximumTextBytes,
      );
    }
    if (record["conditions"] !== undefined) {
      report("invalid-value", `${path}.conditions`, "is not allowed for contradiction uncertainty");
    }
  }
  return state as UncertaintyState;
}

type JsonTraversalFrame =
  | {
      readonly depth: number;
      readonly kind: "enter";
      readonly path: string;
      readonly value: unknown;
    }
  | {
      readonly depth: number;
      readonly expectedIndex: number;
      readonly index: number;
      readonly keys: readonly PropertyKey[];
      readonly kind: "array";
      readonly length: number;
      readonly path: string;
      readonly value: readonly unknown[];
    }
  | {
      readonly depth: number;
      readonly index: number;
      readonly keys: readonly PropertyKey[];
      readonly kind: "object";
      readonly path: string;
      readonly value: object;
    }
  | { readonly kind: "leave"; readonly value: object };

const MAX_ARRAY_INDEX = 0xffff_fffe;

function canonicalArrayIndex(key: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index <= MAX_ARRAY_INDEX ? index : undefined;
}

function validateJsonValueIterative(
  value: unknown,
  path: string,
  report: SharedValidationReporter,
  limits?: JsonValidationLimits,
): boolean {
  const ancestors = new WeakSet<object>();
  const stack: JsonTraversalFrame[] = [{ depth: 0, kind: "enter", path, value }];
  let inspectedStringBytes = 0;
  let inspectedValues = 0;
  let valid = true;
  const inspectString = (
    candidate: string,
    candidatePath: string,
    maximumBytes: number,
  ): boolean => {
    if (candidate.length > maximumBytes) {
      report(
        "resource-limit",
        candidatePath,
        `must not exceed ${String(maximumBytes)} UTF-8 bytes`,
      );
      valid = false;
      return false;
    }
    if (!hasWellFormedUnicode(candidate)) {
      report("invalid-value", candidatePath, "must be well-formed Unicode");
      valid = false;
      return false;
    }
    const bytes = Buffer.byteLength(candidate, "utf8");
    if (bytes > maximumBytes) {
      report(
        "resource-limit",
        candidatePath,
        `must not exceed ${String(maximumBytes)} UTF-8 bytes`,
      );
      valid = false;
      return false;
    }
    inspectedStringBytes += bytes;
    if (limits !== undefined && inspectedStringBytes > limits.maximumTotalStringBytes) {
      report(
        "resource-limit",
        candidatePath,
        `JSON text must not exceed ${String(limits.maximumTotalStringBytes)} cumulative UTF-8 bytes`,
      );
      valid = false;
      return false;
    }
    return true;
  };
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.kind === "array") {
      if (frame.index >= frame.keys.length) {
        if (frame.expectedIndex !== frame.length) {
          report("invalid-value", frame.path, "must be a dense array with every index present");
          valid = false;
        }
        continue;
      }
      const key = frame.keys[frame.index];
      stack.push({ ...frame, index: frame.index + 1 });
      if (key === "length") continue;
      if (typeof key !== "string") {
        report("invalid-value", `${frame.path}.${String(key)}`, "symbol keys are not JSON data");
        valid = false;
        continue;
      }
      if (limits !== undefined && !inspectString(key, frame.path, limits.maximumKeyBytes))
        return false;
      const arrayIndex = canonicalArrayIndex(key);
      if (arrayIndex === undefined || arrayIndex >= frame.length) {
        report(
          "invalid-value",
          `${frame.path}.${key}`,
          "array properties must be canonical in-range indices",
        );
        valid = false;
        continue;
      }
      if (arrayIndex !== frame.expectedIndex) {
        report("invalid-value", frame.path, "must be a dense array with every index present");
        valid = false;
      }
      stack[stack.length - 1] = {
        ...frame,
        expectedIndex: arrayIndex + 1,
        index: frame.index + 1,
      };
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        report("invalid-value", `${frame.path}[${key}]`, "accessor properties are not JSON data");
        valid = false;
      } else if (!descriptor.enumerable) {
        report("invalid-value", `${frame.path}[${key}]`, "JSON array indices must be enumerable");
        valid = false;
      } else {
        stack.push({
          depth: frame.depth + 1,
          kind: "enter",
          path: `${frame.path}[${key}]`,
          value: descriptor.value,
        });
      }
      continue;
    }
    if (frame.kind === "object") {
      if (frame.index >= frame.keys.length) continue;
      const key = frame.keys[frame.index];
      stack.push({ ...frame, index: frame.index + 1 });
      if (typeof key !== "string") {
        report("invalid-value", `${frame.path}.${String(key)}`, "symbol keys are not JSON data");
        valid = false;
        continue;
      }
      if (limits !== undefined && !inspectString(key, frame.path, limits.maximumKeyBytes))
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        report("invalid-value", `${frame.path}.${key}`, "accessor properties are not JSON data");
        valid = false;
      } else if (!descriptor.enumerable) {
        report(
          "invalid-value",
          `${frame.path}.${key}`,
          "JSON object properties must be enumerable",
        );
        valid = false;
      } else {
        stack.push({
          depth: frame.depth + 1,
          kind: "enter",
          path: `${frame.path}.${key}`,
          value: descriptor.value,
        });
      }
      continue;
    }
    const current = frame.value;
    inspectedValues += 1;
    if (limits !== undefined && inspectedValues > limits.maximumValues) {
      report(
        "resource-limit",
        frame.path,
        `must not contain more than ${String(limits.maximumValues)} JSON values`,
      );
      return false;
    }
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      if (limits !== undefined && !inspectString(current, frame.path, limits.maximumStringBytes))
        return false;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        report(
          "invalid-value",
          frame.path,
          "must be a finite JSON number other than negative zero",
        );
        valid = false;
      }
      continue;
    }
    if (typeof current !== "object") {
      report("invalid-value", frame.path, "must be a JSON value");
      valid = false;
      continue;
    }
    if (nodeTypes.isProxy(current)) {
      report("invalid-value", frame.path, "proxies are not JSON data");
      valid = false;
      continue;
    }
    if (frame.depth >= MAX_JSON_NESTING_DEPTH) {
      report(
        "invalid-value",
        frame.path,
        `must not exceed ${String(MAX_JSON_NESTING_DEPTH)} nested JSON containers`,
      );
      valid = false;
      continue;
    }
    if (ancestors.has(current)) {
      report("invalid-value", frame.path, "must not contain a reference cycle");
      valid = false;
      continue;
    }
    ancestors.add(current);
    stack.push({ kind: "leave", value: current });
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          report("invalid-value", frame.path, "must be a plain JSON array");
          valid = false;
        }
        const length: unknown = Object.getOwnPropertyDescriptor(current, "length")
          ?.value as unknown;
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
          report("invalid-value", frame.path, "must expose a canonical array length");
          valid = false;
          continue;
        }
        if (limits !== undefined && length > limits.maximumContainerEntries) {
          report(
            "resource-limit",
            frame.path,
            `arrays must not contain more than ${String(limits.maximumContainerEntries)} entries`,
          );
          valid = false;
          continue;
        }
        stack.push({
          depth: frame.depth,
          expectedIndex: 0,
          index: 0,
          keys: Reflect.ownKeys(current),
          kind: "array",
          length,
          path: frame.path,
          value: current,
        });
      } else {
        const prototype = Object.getPrototypeOf(current) as object | null;
        if (prototype !== Object.prototype && prototype !== null) {
          report("invalid-value", frame.path, "must be a plain JSON object");
          valid = false;
        }
        const keys = Reflect.ownKeys(current);
        if (limits !== undefined && keys.length > limits.maximumContainerEntries) {
          report(
            "resource-limit",
            frame.path,
            `objects must not contain more than ${String(limits.maximumContainerEntries)} properties`,
          );
          valid = false;
          continue;
        }
        stack.push({
          depth: frame.depth,
          index: 0,
          keys,
          kind: "object",
          path: frame.path,
          value: current,
        });
      }
    } catch (error) {
      if (error instanceof ValidationIssueLimitReached) throw error;
      report("invalid-value", frame.path, "must be safely inspectable JSON data");
      valid = false;
    }
  }
  return valid;
}

/** Validate an unknown runtime value without relying on TypeScript's permissive `number` type. */
export function validateJsonValue(
  value: unknown,
  path: string,
  report: SharedValidationReporter,
  limits?: JsonValidationLimits,
): boolean {
  return validateJsonValueIterative(value, path, report, limits);
}
