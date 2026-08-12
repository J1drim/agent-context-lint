import { types as nodeTypes } from "node:util";

import { REPOSITORY_ROOT, isRepositoryRelativePath } from "@agent-context/core";
import { profileGlobDialect, type ProfileGlobDialect } from "@agent-context/profiles";

import type {
  ActivationCallbacks,
  ActivationFactDecision,
  GlobActivationRequest,
} from "./activation-algebra.js";

export interface ProfileGlobDialectLimits {
  readonly maxExpandedBytes: number;
  readonly maxExpandedPatterns: number;
  readonly maxInputTextBytes: number;
  readonly maxMatchWork: number;
  readonly maxPatternBytes: number;
  readonly maxPathSegments: number;
  readonly maxTargetBytes: number;
}

export const PROFILE_GLOB_DIALECT_LIMITS: Readonly<ProfileGlobDialectLimits> = Object.freeze({
  maxExpandedBytes: 4_194_304,
  maxExpandedPatterns: 1_000,
  maxInputTextBytes: 65_536,
  maxMatchWork: 1_048_576,
  maxPatternBytes: 16_384,
  maxPathSegments: 1_024,
  maxTargetBytes: 16_384,
});

export const ProfileGlobDialectErrorCode: Readonly<{
  invalidRequest: "PROFILE_GLOB_INVALID_REQUEST";
  resourceLimit: "PROFILE_GLOB_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidRequest: "PROFILE_GLOB_INVALID_REQUEST",
  resourceLimit: "PROFILE_GLOB_RESOURCE_LIMIT",
} as const);

export type ProfileGlobDialectErrorCode =
  (typeof ProfileGlobDialectErrorCode)[keyof typeof ProfileGlobDialectErrorCode];

export class ProfileGlobDialectError extends Error {
  override readonly name = "ProfileGlobDialectError" as const;
  readonly code: ProfileGlobDialectErrorCode;

  constructor(code: ProfileGlobDialectErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type DataRecord = Readonly<Record<string, unknown>>;
type MatchResult = "match" | "no-match" | "unknown";

interface ExpansionSuccess {
  readonly kind: "expanded";
  readonly patterns: readonly string[];
}

interface ExpansionFailure {
  readonly kind: "limit" | "unsupported";
}

type ExpansionResult = ExpansionFailure | ExpansionSuccess;

const REQUEST_KEYS = [
  "ruleId",
  "profileId",
  "surfaceId",
  "scopeRoot",
  "targetPath",
  "pattern",
  "dialectId",
] as const;

function fail(code: ProfileGlobDialectErrorCode, message: string): never {
  throw new ProfileGlobDialectError(code, message);
}

function isDataRecord(value: unknown): value is DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  )
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function dataProperty(record: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return true;
  }
  return false;
}

function textBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function decision(state: ActivationFactDecision["state"], reason: string): ActivationFactDecision {
  return Object.freeze({ state, reason });
}

function invalidInputDecision(): ActivationFactDecision {
  return decision(
    "indeterminate",
    "The glob request contains unsupported text; profile activation remains indeterminate.",
  );
}

function unsupportedDecision(dialect: ProfileGlobDialect): ActivationFactDecision {
  return decision(
    "indeterminate",
    `Dialect ${dialect.id} does not document the requested behavior; activation remains indeterminate.`,
  );
}

function validateRequest(input: unknown): GlobActivationRequest {
  if (!isDataRecord(input)) {
    fail(ProfileGlobDialectErrorCode.invalidRequest, "profile glob request must be a data record");
  }
  const keys = Object.keys(input).sort();
  const expected = [...REQUEST_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(ProfileGlobDialectErrorCode.invalidRequest, "profile glob request must be closed");
  }
  let inputBytes = 0;
  for (const key of REQUEST_KEYS) {
    const value = dataProperty(input, key);
    if (key === "dialectId" && value === null) continue;
    if (typeof value !== "string" || value.length === 0) {
      fail(ProfileGlobDialectErrorCode.invalidRequest, `profile glob ${key} must be text`);
    }
    inputBytes += textBytes(value);
  }
  if (inputBytes > PROFILE_GLOB_DIALECT_LIMITS.maxInputTextBytes) {
    fail(ProfileGlobDialectErrorCode.resourceLimit, "profile glob request exceeds its text limit");
  }
  const pattern = dataProperty(input, "pattern") as string;
  const targetPath = dataProperty(input, "targetPath") as string;
  const scopeRoot = dataProperty(input, "scopeRoot") as string;
  if (textBytes(pattern) > PROFILE_GLOB_DIALECT_LIMITS.maxPatternBytes) {
    fail(ProfileGlobDialectErrorCode.resourceLimit, "profile glob pattern exceeds its byte limit");
  }
  if (textBytes(targetPath) > PROFILE_GLOB_DIALECT_LIMITS.maxTargetBytes) {
    fail(ProfileGlobDialectErrorCode.resourceLimit, "profile glob target exceeds its byte limit");
  }
  if (!isRepositoryRelativePath(targetPath) || !isRepositoryRelativePath(scopeRoot)) {
    fail(
      ProfileGlobDialectErrorCode.invalidRequest,
      "profile glob paths must be canonical repository-relative paths",
    );
  }
  return input as unknown as GlobActivationRequest;
}

function relativeToScope(
  targetPath: string,
  scopeRoot: string,
): { readonly inside: boolean; readonly path: string } {
  if (scopeRoot === REPOSITORY_ROOT) return { inside: true, path: targetPath };
  if (targetPath === scopeRoot) return { inside: true, path: REPOSITORY_ROOT };
  const prefix = `${scopeRoot}/`;
  return targetPath.startsWith(prefix)
    ? { inside: true, path: targetPath.slice(prefix.length) }
    : { inside: false, path: targetPath };
}

function braceExpansion(pattern: string, dialect: ProfileGlobDialect): ExpansionResult {
  let values: readonly string[] = [pattern];
  for (;;) {
    let expanded = false;
    const next: string[] = [];
    let nextBytes = 0;
    for (const value of values) {
      const open = value.indexOf("{");
      const closeWithoutOpen = value.indexOf("}");
      if (open < 0) {
        if (closeWithoutOpen >= 0) return { kind: "unsupported" };
        nextBytes += textBytes(value);
        if (nextBytes > PROFILE_GLOB_DIALECT_LIMITS.maxExpandedBytes) return { kind: "limit" };
        next.push(value);
        continue;
      }
      if (dialect.braceExpansion !== "documented") return { kind: "unsupported" };
      const close = value.indexOf("}", open + 1);
      const nestedOpen = value.indexOf("{", open + 1);
      if (close < 0 || (nestedOpen >= 0 && nestedOpen < close)) return { kind: "unsupported" };
      const body = value.slice(open + 1, close);
      const alternatives = body.split(",");
      if (alternatives.length < 2 || alternatives.some((alternative) => alternative.length === 0))
        return { kind: "unsupported" };
      expanded = true;
      for (const alternative of alternatives) {
        const candidate = `${value.slice(0, open)}${alternative}${value.slice(close + 1)}`;
        const profileCount = dialect.braceExpansionMaximumPatterns;
        if (
          next.length + 1 > PROFILE_GLOB_DIALECT_LIMITS.maxExpandedPatterns ||
          (profileCount !== null && next.length + 1 > profileCount)
        )
          return { kind: "limit" };
        nextBytes += textBytes(candidate);
        const profileBytes = dialect.braceExpansionMaximumBytes;
        if (
          nextBytes > PROFILE_GLOB_DIALECT_LIMITS.maxExpandedBytes ||
          (profileBytes !== null && nextBytes > profileBytes)
        )
          return { kind: "limit" };
        next.push(candidate);
      }
    }
    values = next;
    if (!expanded) return { kind: "expanded", patterns: Object.freeze([...values]) };
  }
}

function malformedBracketExpression(pattern: string): boolean {
  let open = false;
  for (const scalar of pattern) {
    if (scalar === "[") {
      if (open) return true;
      open = true;
    } else if (scalar === "]") {
      if (!open) return true;
      open = false;
    }
  }
  return open;
}

function asciiFold(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    output += String.fromCharCode(unit >= 0x41 && unit <= 0x5a ? unit + 0x20 : unit);
  }
  return output;
}

class WorkBudget {
  #work = 0;

  get exhausted(): boolean {
    return this.#work > PROFILE_GLOB_DIALECT_LIMITS.maxMatchWork;
  }

  consume(amount = 1): boolean {
    this.#work += amount;
    return this.#work <= PROFILE_GLOB_DIALECT_LIMITS.maxMatchWork;
  }
}

function segmentMatch(
  pattern: string,
  value: string,
  dotWildcards: boolean,
  foldCase: boolean,
  budget: WorkBudget,
): MatchResult {
  const patternScalars = Array.from(foldCase ? asciiFold(pattern) : pattern);
  const valueScalars = Array.from(foldCase ? asciiFold(value) : value);
  if (
    !dotWildcards &&
    valueScalars[0] === "." &&
    (patternScalars[0] === "*" || patternScalars[0] === "?")
  )
    return "no-match";
  let prior = new Uint8Array(valueScalars.length + 1);
  prior[0] = 1;
  for (const token of patternScalars) {
    const current = new Uint8Array(valueScalars.length + 1);
    for (let index = 0; index <= valueScalars.length; index += 1) {
      if (!budget.consume()) return "unknown";
      if (token === "*") {
        if (prior[index] === 1 || (index > 0 && current[index - 1] === 1)) current[index] = 1;
      } else if (token === "?") {
        if (index > 0 && prior[index - 1] === 1) current[index] = 1;
      } else if (index > 0 && prior[index - 1] === 1 && valueScalars[index - 1] === token) {
        current[index] = 1;
      }
    }
    prior = current;
  }
  return prior[valueScalars.length] === 1 ? "match" : "no-match";
}

function pathMatch(
  pattern: string,
  path: string,
  dotWildcards: boolean,
  foldCase: boolean,
  budget: WorkBudget,
): MatchResult {
  const patternSegments = pattern.split("/");
  const pathSegments = path === REPOSITORY_ROOT ? [] : path.split("/");
  if (
    patternSegments.length > PROFILE_GLOB_DIALECT_LIMITS.maxPathSegments ||
    pathSegments.length > PROFILE_GLOB_DIALECT_LIMITS.maxPathSegments
  )
    return "unknown";
  const rows = Array.from(
    { length: patternSegments.length + 1 },
    () => new Uint8Array(pathSegments.length + 1),
  );
  const firstRow = rows[0];
  if (firstRow === undefined) return "unknown";
  firstRow[0] = 1;
  for (let patternIndex = 0; patternIndex < patternSegments.length; patternIndex += 1) {
    const segment = patternSegments[patternIndex];
    const priorRow = rows[patternIndex];
    const currentRow = rows[patternIndex + 1];
    if (segment === undefined || priorRow === undefined || currentRow === undefined)
      return "unknown";
    for (let pathIndex = 0; pathIndex <= pathSegments.length; pathIndex += 1) {
      if (!budget.consume()) return "unknown";
      if (segment === "**") {
        if (priorRow[pathIndex] === 1) currentRow[pathIndex] = 1;
        const pathSegment = pathSegments[pathIndex];
        if (
          pathSegment !== undefined &&
          currentRow[pathIndex] === 1 &&
          (dotWildcards || !pathSegment.startsWith("."))
        )
          currentRow[pathIndex + 1] = 1;
      } else if (priorRow[pathIndex] === 1) {
        const pathSegment = pathSegments[pathIndex];
        if (pathSegment === undefined) continue;
        const matched = segmentMatch(segment, pathSegment, dotWildcards, foldCase, budget);
        if (matched === "unknown") return "unknown";
        if (matched === "match") currentRow[pathIndex + 1] = 1;
      }
    }
  }
  const finalRow = rows[patternSegments.length];
  return finalRow?.[pathSegments.length] === 1 ? "match" : "no-match";
}

function hasNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1)
    if (value.charCodeAt(index) > 0x7f) return true;
  return false;
}

function matchDocumentedSubset(
  pattern: string,
  path: string,
  dialect: ProfileGlobDialect,
  budget: WorkBudget,
): MatchResult {
  if (
    pattern.startsWith("/") ||
    pattern.startsWith("./") ||
    pattern.startsWith("../") ||
    pattern.endsWith("/") ||
    pattern.includes("//") ||
    pattern.includes("\\") ||
    pattern.startsWith("!")
  )
    return "unknown";
  if (pattern.includes("[") || pattern.includes("]")) {
    if (dialect.bracketExpressions === "invalid-is-no-match" && malformedBracketExpression(pattern))
      return "no-match";
    return "unknown";
  }
  if (pattern.includes("?") && dialect.questionMark !== "documented") return "unknown";
  for (const segment of pattern.split("/")) {
    if (segment.includes("**") && segment !== "**") return "unknown";
    if (segment.includes("*") && dialect.star !== "documented") return "unknown";
    if (segment === "**" && dialect.globstar !== "documented") return "unknown";
  }
  const sensitiveWithoutDots = pathMatch(pattern, path, false, false, budget);
  if (sensitiveWithoutDots !== "no-match") return sensitiveWithoutDots;
  const sensitiveWithDots = pathMatch(pattern, path, true, false, budget);
  if (sensitiveWithDots !== "no-match") return "unknown";
  const foldedWithoutDots = pathMatch(pattern, path, false, true, budget);
  if (foldedWithoutDots !== "no-match") return "unknown";
  const foldedWithDots = pathMatch(pattern, path, true, true, budget);
  if (foldedWithDots !== "no-match") return "unknown";
  if (hasNonAscii(pattern) || hasNonAscii(path)) return "unknown";
  return "no-match";
}

/**
 * Resolves one E01 glob request only through the exact profile/dialect owner in the closed catalog.
 * Unknown IDs, owner mismatches, and undocumented behavior never inherit another profile's matcher.
 */
export function matchProfileGlob(input: GlobActivationRequest): ActivationFactDecision {
  const request = validateRequest(input);
  if (
    !hasWellFormedUnicode(request.pattern) ||
    hasControl(request.pattern) ||
    !hasWellFormedUnicode(request.ruleId) ||
    !hasWellFormedUnicode(request.profileId) ||
    !hasWellFormedUnicode(request.surfaceId) ||
    (request.dialectId !== null && !hasWellFormedUnicode(request.dialectId))
  )
    return invalidInputDecision();
  if (request.dialectId === null) {
    return decision(
      "indeterminate",
      "The activation selector has no profile-owned glob dialect; activation remains indeterminate.",
    );
  }
  const dialect = profileGlobDialect(request.dialectId);
  if (dialect === undefined) {
    return decision(
      "indeterminate",
      "No profile-owned semantics are registered for the requested glob dialect.",
    );
  }
  if (dialect.profileId !== request.profileId || !dialect.surfaceIds.includes(request.surfaceId)) {
    return decision(
      "indeterminate",
      `Dialect ${dialect.id} is not owned by the requested profile surface; activation remains indeterminate.`,
    );
  }
  if (dialect.patternBase === "unknown") return unsupportedDecision(dialect);
  const relative =
    dialect.patternBase === "repository-root"
      ? { inside: true, path: request.targetPath as string }
      : relativeToScope(request.targetPath, request.scopeRoot);
  if (!relative.inside) {
    return decision(
      "inactive",
      `Target is outside the scope-root base owned by dialect ${dialect.id}.`,
    );
  }
  const expansion = braceExpansion(request.pattern, dialect);
  if (expansion.kind !== "expanded") {
    if (expansion.kind === "unsupported") return unsupportedDecision(dialect);
    return dialect.braceLimitResult === "literal-no-match"
      ? decision(
          "inactive",
          `Dialect ${dialect.id} defines over-budget brace expansion as a literal non-match.`,
        )
      : unsupportedDecision(dialect);
  }
  const budget = new WorkBudget();
  let sawUnknown = false;
  for (const pattern of expansion.patterns) {
    const result = matchDocumentedSubset(pattern, relative.path, dialect, budget);
    if (result === "match") {
      return decision(
        "active",
        `Dialect ${dialect.id} matched the target under its documented subset.`,
      );
    }
    if (result === "unknown") sawUnknown = true;
    if (budget.exhausted) return unsupportedDecision(dialect);
  }
  return sawUnknown
    ? unsupportedDecision(dialect)
    : decision("inactive", `Dialect ${dialect.id} did not match the target.`);
}

/** Supplies E01 with only the closed E02 matcher; manual/conditional facts remain caller-owned. */
export function createProfileGlobActivationCallbacks(): ActivationCallbacks {
  return Object.freeze({ matchGlob: matchProfileGlob });
}
