import { performance } from "node:perf_hooks";
import { TextDecoder, types as nodeTypes } from "node:util";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";

import { ReadOnlyRepositoryError, ReadOnlyRepositoryErrorCode } from "./read-only-filesystem.js";
import type { ReadOnlyRepository } from "./read-only-filesystem.js";
import type { TrackedFileEnumerationResult } from "./tracked-file-enumeration.js";
import { BUILT_IN_IGNORE_PATTERNS } from "./built-in-ignore-patterns.js";

export { BUILT_IN_IGNORE_PATTERNS } from "./built-in-ignore-patterns.js";

export interface IgnoreEngineLimits {
  readonly maximumDurationMs: number;
  readonly maximumIgnoreFileBytes: number;
  readonly maximumIgnoreFiles: number;
  readonly maximumMatchWork: number;
  readonly maximumPathDepth: number;
  readonly maximumPaths: number;
  readonly maximumPatternBytes: number;
  readonly maximumPatternLength: number;
  readonly maximumPatterns: number;
  readonly maximumProblems: number;
}

export const IGNORE_ENGINE_DEFAULT_LIMITS: Readonly<IgnoreEngineLimits> = Object.freeze({
  maximumDurationMs: 30_000,
  maximumIgnoreFileBytes: 65_536,
  maximumIgnoreFiles: 1_024,
  maximumMatchWork: 50_000_000,
  maximumPathDepth: 128,
  maximumPaths: 100_000,
  maximumPatternBytes: 4_194_304,
  maximumPatternLength: 4_096,
  maximumPatterns: 10_000,
  maximumProblems: 256,
});

export const IGNORE_ENGINE_HARD_LIMITS: Readonly<IgnoreEngineLimits> = Object.freeze({
  maximumDurationMs: 300_000,
  maximumIgnoreFileBytes: 1_048_576,
  maximumIgnoreFiles: 10_000,
  maximumMatchWork: 200_000_000,
  maximumPathDepth: 1_024,
  maximumPaths: 1_000_000,
  maximumPatternBytes: 16_777_216,
  maximumPatternLength: 16_384,
  maximumPatterns: 100_000,
  maximumProblems: 4_096,
});

export type ProfileIgnoreApplicability =
  "conditional" | "contradiction" | "known-active" | "known-inactive" | "unknown";

export type ProfileIgnoreEvidence =
  "documented" | "documented-versioned" | "observed" | "source-derived";

export interface ProfileIgnoreFact {
  readonly applicability: ProfileIgnoreApplicability;
  readonly clientVersion: string | null;
  readonly evidence: ProfileIgnoreEvidence;
  readonly factId: string;
  readonly pattern: string;
  readonly profileId: string;
  readonly reason: string | null;
  readonly retrievedAt: string;
  readonly sourceUrl: string;
}

export interface IgnoreEngineOptions {
  readonly configurationPatterns?: readonly string[];
  readonly maximumDurationMs?: number;
  readonly maximumIgnoreFileBytes?: number;
  readonly maximumIgnoreFiles?: number;
  readonly maximumMatchWork?: number;
  readonly maximumPathDepth?: number;
  readonly maximumPaths?: number;
  readonly maximumPatternBytes?: number;
  readonly maximumPatternLength?: number;
  readonly maximumPatterns?: number;
  readonly maximumProblems?: number;
  readonly profileFacts?: readonly ProfileIgnoreFact[];
  readonly signal?: AbortSignal;
}

export type IgnoreRuleSourceKind = "built-in" | "configuration" | "gitignore" | "profile";

export interface IgnoreRuleSource {
  readonly factId: string | null;
  readonly kind: IgnoreRuleSourceKind;
  readonly line: number | null;
  readonly path: RepositoryRelativePath | null;
  readonly profileId: string | null;
  readonly sourceUrl: string | null;
}

export interface IgnoreRule {
  readonly basePath: RepositoryRelativePath;
  readonly directoryOnly: boolean;
  readonly id: string;
  readonly negative: boolean;
  readonly pattern: string;
  readonly precedence: number;
  readonly source: IgnoreRuleSource;
  readonly valid: boolean;
}

export interface IgnoredPathDecision {
  readonly certainty: "known" | "tracking-uncertain";
  readonly path: RepositoryRelativePath;
  readonly ruleId: string;
}

export interface IgnoreEngineProblem {
  readonly code: string;
  readonly line: number | null;
  readonly path: RepositoryRelativePath | null;
}

export interface IgnoreEngineResult {
  readonly appliedProfileFactIds: readonly string[];
  readonly certainty: "exact-tracked-input" | "fallback-tracking-uncertain";
  readonly deferredProfileFacts: readonly ProfileIgnoreFact[];
  readonly ignored: readonly IgnoredPathDecision[];
  readonly limits: IgnoreEngineLimits;
  readonly omittedProblems: number;
  readonly paths: readonly RepositoryRelativePath[];
  readonly problems: readonly IgnoreEngineProblem[];
  readonly profileCertainty: "known" | "uncertain-facts-deferred";
  readonly profileFacts: readonly ProfileIgnoreFact[];
  readonly rules: readonly IgnoreRule[];
  readonly trackingCertainty: "fallback-mixed-unknown" | "tracked";
}

export const IgnoreEngineErrorCode: Readonly<{
  aborted: "IGNORE_ENGINE_ABORTED";
  deadlineExceeded: "IGNORE_ENGINE_DEADLINE_EXCEEDED";
  invalidInput: "IGNORE_ENGINE_INVALID_INPUT";
  invalidOptions: "IGNORE_ENGINE_INVALID_OPTIONS";
  limitExceeded: "IGNORE_ENGINE_LIMIT_EXCEEDED";
  malformedInput: "IGNORE_ENGINE_MALFORMED_INPUT";
}> = Object.freeze({
  aborted: "IGNORE_ENGINE_ABORTED",
  deadlineExceeded: "IGNORE_ENGINE_DEADLINE_EXCEEDED",
  invalidInput: "IGNORE_ENGINE_INVALID_INPUT",
  invalidOptions: "IGNORE_ENGINE_INVALID_OPTIONS",
  limitExceeded: "IGNORE_ENGINE_LIMIT_EXCEEDED",
  malformedInput: "IGNORE_ENGINE_MALFORMED_INPUT",
} as const);

export type IgnoreEngineErrorCode =
  (typeof IgnoreEngineErrorCode)[keyof typeof IgnoreEngineErrorCode];

export class IgnoreEngineError extends Error {
  override readonly name = "IgnoreEngineError" as const;
  readonly code: IgnoreEngineErrorCode;
  readonly operation: string;
  readonly path: RepositoryRelativePath | undefined;

  constructor(
    code: IgnoreEngineErrorCode,
    message: string,
    operation: string,
    pathValue?: RepositoryRelativePath,
  ) {
    super(message);
    this.code = code;
    this.operation = operation;
    this.path = pathValue;
    Object.freeze(this);
  }
}

export interface IgnoreEngineClock {
  now(): number;
}

interface OptionsSnapshot {
  readonly configurationPatterns: readonly string[];
  readonly limits: Readonly<IgnoreEngineLimits>;
  readonly profileFacts: readonly ProfileIgnoreFact[];
  readonly signal?: AbortSignal;
}

type CharacterToken =
  | { readonly kind: "any" }
  | { readonly kind: "class"; readonly inverted: boolean; readonly ranges: readonly number[] }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "star" };

interface CompiledPattern {
  readonly components: readonly (readonly CharacterToken[] | "globstar")[];
  readonly hasSlash: boolean;
  readonly trailingGlobstarRequiresChild: boolean;
}

interface InternalRule {
  readonly compiled: CompiledPattern | null;
  readonly rule: IgnoreRule;
  readonly sourceRank: number;
  readonly sourceSequence: number;
}

interface EnumerationSnapshot {
  readonly fallback: boolean;
  readonly omittedProblems: number;
  readonly paths: readonly RepositoryRelativePath[];
  readonly problems: readonly IgnoreEngineProblem[];
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ABORT_SIGNAL_ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
);
const DEFAULT_CLOCK: IgnoreEngineClock = Object.freeze({ now: () => performance.now() });
const OPTION_KEYS = Object.freeze([
  "configurationPatterns",
  ...Object.keys(IGNORE_ENGINE_HARD_LIMITS),
  "profileFacts",
  "signal",
]);
const PROFILE_FACT_KEYS = Object.freeze([
  "applicability",
  "clientVersion",
  "evidence",
  "factId",
  "pattern",
  "profileId",
  "reason",
  "retrievedAt",
  "sourceUrl",
]);
const SOURCE_RANK: Readonly<Record<IgnoreRuleSourceKind, number>> = Object.freeze({
  gitignore: 1,
  profile: 2,
  configuration: 3,
  "built-in": 4,
});

function error(
  code: IgnoreEngineErrorCode,
  message: string,
  operation: string,
  pathValue?: RepositoryRelativePath,
): IgnoreEngineError {
  return new IgnoreEngineError(code, message, operation, pathValue);
}

function plainDataValues(
  value: unknown,
  allowedKeys: readonly string[],
  code: IgnoreEngineErrorCode,
  operation: string,
): ReadonlyMap<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error(code, "ignore-engine data must be a plain object", operation);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > allowedKeys.length ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
  ) {
    throw error(code, "ignore-engine data contains an unknown field", operation);
  }
  const result = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw error(code, "ignore-engine data contains an accessor", operation);
    }
    result.set(key as string, descriptor.value as unknown);
  }
  return result;
}

function snapshotArray(
  value: unknown,
  maximum: number,
  operation: string,
  code: IgnoreEngineErrorCode = IgnoreEngineErrorCode.invalidOptions,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw error(code, "ignore-engine array is invalid", operation);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw error(code, "ignore-engine array is sparse", operation);
    }
    result.push(descriptor.value as unknown);
  }
  const keys = Reflect.ownKeys(value);
  const allowedKeys = new Set<PropertyKey>(["length"]);
  for (let index = 0; index < value.length; index += 1) allowedKeys.add(String(index));
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw error(code, "ignore-engine array has extra fields", operation);
  }
  return result;
}

function abortState(value: unknown): boolean | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    ABORT_SIGNAL_ABORTED_DESCRIPTOR?.get === undefined
  ) {
    return undefined;
  }
  try {
    const state: unknown = ABORT_SIGNAL_ABORTED_DESCRIPTOR.get.call(value);
    return typeof state === "boolean" ? state : undefined;
  } catch {
    return undefined;
  }
}

function unsafeText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit <= 0x1f ||
      (unit >= 0x7f && unit <= 0x9f) ||
      (unit >= 0xd800 && unit <= 0xdfff) ||
      unit === 0xfeff ||
      unit === 0x061c ||
      unit === 0x200e ||
      unit === 0x200f ||
      (unit >= 0x202a && unit <= 0x202e) ||
      (unit >= 0x2066 && unit <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (days[month - 1] ?? 0);
}

function snapshotProfileFact(value: unknown, limits: IgnoreEngineLimits): ProfileIgnoreFact {
  const fields = plainDataValues(
    value,
    PROFILE_FACT_KEYS,
    IgnoreEngineErrorCode.invalidOptions,
    "validate-profile-fact",
  );
  if (fields.size !== PROFILE_FACT_KEYS.length) {
    throw error(
      IgnoreEngineErrorCode.invalidOptions,
      "profile ignore fact is missing a field",
      "validate-profile-fact",
    );
  }
  const applicability = fields.get("applicability");
  const clientVersion = fields.get("clientVersion");
  const evidence = fields.get("evidence");
  const factId = fields.get("factId");
  const pattern = fields.get("pattern");
  const profileId = fields.get("profileId");
  const reason = fields.get("reason");
  const retrievedAt = fields.get("retrievedAt");
  const sourceUrl = fields.get("sourceUrl");
  const applications: readonly ProfileIgnoreApplicability[] = [
    "conditional",
    "contradiction",
    "known-active",
    "known-inactive",
    "unknown",
  ];
  const evidenceStates: readonly ProfileIgnoreEvidence[] = [
    "documented",
    "documented-versioned",
    "observed",
    "source-derived",
  ];
  const uncertain = applicability !== "known-active" && applicability !== "known-inactive";
  if (typeof sourceUrl !== "string" || sourceUrl.length > 2_048) {
    throw error(
      IgnoreEngineErrorCode.invalidOptions,
      "profile ignore fact source URL is invalid",
      "validate-profile-fact",
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw error(
      IgnoreEngineErrorCode.invalidOptions,
      "profile ignore fact source URL is invalid",
      "validate-profile-fact",
    );
  }
  if (
    typeof applicability !== "string" ||
    !applications.includes(applicability as ProfileIgnoreApplicability) ||
    (clientVersion !== null &&
      (typeof clientVersion !== "string" ||
        clientVersion.length === 0 ||
        clientVersion.length > 128 ||
        unsafeText(clientVersion))) ||
    typeof evidence !== "string" ||
    !evidenceStates.includes(evidence as ProfileIgnoreEvidence) ||
    !validIdentifier(factId) ||
    typeof pattern !== "string" ||
    pattern.length === 0 ||
    pattern.length > limits.maximumPatternLength * 2 ||
    unsafeText(pattern) ||
    !validIdentifier(profileId) ||
    (uncertain
      ? typeof reason !== "string" ||
        reason.length === 0 ||
        reason.length > 1_024 ||
        unsafeText(reason)
      : reason !== null) ||
    !validDate(retrievedAt) ||
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== ""
  ) {
    throw error(
      IgnoreEngineErrorCode.invalidOptions,
      "profile ignore fact is invalid",
      "validate-profile-fact",
    );
  }
  return Object.freeze({
    applicability: applicability as ProfileIgnoreApplicability,
    clientVersion,
    evidence: evidence as ProfileIgnoreEvidence,
    factId,
    pattern,
    profileId,
    reason: reason as string | null,
    retrievedAt,
    sourceUrl: parsedUrl.href,
  });
}

function snapshotOptions(value: unknown): OptionsSnapshot {
  if (value === undefined) {
    return Object.freeze({
      configurationPatterns: Object.freeze([]),
      limits: IGNORE_ENGINE_DEFAULT_LIMITS,
      profileFacts: Object.freeze([]),
    });
  }
  const fields = plainDataValues(
    value,
    OPTION_KEYS,
    IgnoreEngineErrorCode.invalidOptions,
    "validate-options",
  );
  const limits = { ...IGNORE_ENGINE_DEFAULT_LIMITS };
  for (const key of Object.keys(IGNORE_ENGINE_HARD_LIMITS) as (keyof IgnoreEngineLimits)[]) {
    if (!fields.has(key)) continue;
    const candidate = fields.get(key);
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > IGNORE_ENGINE_HARD_LIMITS[key]
    ) {
      throw error(
        IgnoreEngineErrorCode.invalidOptions,
        "ignore-engine limit is outside supported bounds",
        "validate-options",
      );
    }
    limits[key] = candidate;
  }
  const configurationValues = fields.has("configurationPatterns")
    ? snapshotArray(
        fields.get("configurationPatterns"),
        limits.maximumPatterns,
        "validate-configuration-patterns",
      )
    : [];
  const configurationPatterns = configurationValues.map((candidate) => {
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > limits.maximumPatternLength * 2 ||
      unsafeText(candidate)
    ) {
      throw error(
        IgnoreEngineErrorCode.invalidOptions,
        "configuration ignore pattern is invalid",
        "validate-configuration-patterns",
      );
    }
    if (!validSuppliedPattern(candidate, limits)) {
      throw error(
        IgnoreEngineErrorCode.invalidOptions,
        "configuration ignore pattern is malformed",
        "validate-configuration-patterns",
      );
    }
    return candidate;
  });
  const profileValues = fields.has("profileFacts")
    ? snapshotArray(fields.get("profileFacts"), limits.maximumPatterns, "validate-profile-facts")
    : [];
  const profileFacts = profileValues.map((candidate) => snapshotProfileFact(candidate, limits));
  const factIds = new Set<string>();
  for (const fact of profileFacts) {
    if (!validSuppliedPattern(fact.pattern, limits)) {
      throw error(
        IgnoreEngineErrorCode.invalidOptions,
        "profile ignore fact pattern is malformed",
        "validate-profile-facts",
      );
    }
    if (factIds.has(fact.factId)) {
      throw error(
        IgnoreEngineErrorCode.invalidOptions,
        "profile ignore fact identifier is duplicated",
        "validate-profile-facts",
      );
    }
    factIds.add(fact.factId);
  }
  const signal = fields.get("signal");
  if (
    (fields.has("signal") && signal === undefined) ||
    (signal !== undefined && abortState(signal) === undefined)
  ) {
    throw error(
      IgnoreEngineErrorCode.invalidOptions,
      "ignore-engine cancellation signal is invalid",
      "validate-options",
    );
  }
  return Object.freeze({
    configurationPatterns: Object.freeze(configurationPatterns),
    limits: Object.freeze(limits),
    profileFacts: Object.freeze(profileFacts),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  });
}

function snapshotEnumeration(value: unknown, limits: IgnoreEngineLimits): EnumerationSnapshot {
  const fields = plainDataValues(
    value,
    [
      "certainty",
      "indexObjectFormat",
      "indexVersion",
      "limits",
      "omittedProblems",
      "paths",
      "problems",
      "reason",
      "source",
    ],
    IgnoreEngineErrorCode.invalidInput,
    "validate-enumeration",
  );
  const source = fields.get("source");
  const certainty = fields.get("certainty");
  if (
    (source !== "git-index" && source !== "filesystem-fallback") ||
    (source === "git-index" && certainty !== "tracked") ||
    (source === "filesystem-fallback" && certainty !== "all-files-not-tracked")
  ) {
    throw error(
      IgnoreEngineErrorCode.invalidInput,
      "tracked-file enumeration provenance is inconsistent",
      "validate-enumeration",
    );
  }
  const candidates = snapshotArray(
    fields.get("paths"),
    limits.maximumPaths,
    "validate-enumeration-paths",
    IgnoreEngineErrorCode.invalidInput,
  );
  const paths: RepositoryRelativePath[] = [];
  let previous: string | undefined;
  for (const candidate of candidates) {
    if (
      typeof candidate !== "string" ||
      candidate.length > 16_384 ||
      Buffer.byteLength(candidate, "utf8") > 16_384
    ) {
      throw error(
        IgnoreEngineErrorCode.invalidInput,
        "enumerated path is not a string",
        "validate-enumeration",
      );
    }
    let canonical: RepositoryRelativePath;
    try {
      canonical = canonicalizeRepositoryRelativePath(candidate, "posix");
    } catch {
      throw error(
        IgnoreEngineErrorCode.invalidInput,
        "enumerated path is not canonical",
        "validate-enumeration",
      );
    }
    if (
      canonical !== candidate ||
      canonical === "." ||
      canonical.split("/").length > limits.maximumPathDepth ||
      (previous !== undefined && previous >= canonical)
    ) {
      throw error(
        IgnoreEngineErrorCode.invalidInput,
        "enumerated paths must be canonical, unique, sorted, and bounded",
        "validate-enumeration",
      );
    }
    paths.push(canonical);
    previous = canonical;
  }
  const omittedProblems = fields.get("omittedProblems");
  if (
    typeof omittedProblems !== "number" ||
    !Number.isSafeInteger(omittedProblems) ||
    omittedProblems < 0
  )
    throw error(
      IgnoreEngineErrorCode.invalidInput,
      "enumeration omitted-problem count is invalid",
      "validate-enumeration",
    );
  const problemValues = snapshotArray(
    fields.get("problems"),
    limits.maximumPaths,
    "validate-enumeration-problems",
    IgnoreEngineErrorCode.invalidInput,
  );
  const problems: IgnoreEngineProblem[] = problemValues.map((problem) => {
    const problemFields = plainDataValues(
      problem,
      ["code", "path"],
      IgnoreEngineErrorCode.invalidInput,
      "validate-enumeration-problems",
    );
    const code = problemFields.get("code");
    const problemPath = problemFields.get("path");
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      code.length > 256 ||
      typeof problemPath !== "string"
    )
      throw error(
        IgnoreEngineErrorCode.invalidInput,
        "enumeration problem is invalid",
        "validate-enumeration-problems",
      );
    let canonical: RepositoryRelativePath;
    try {
      canonical = canonicalizeRepositoryRelativePath(problemPath, "posix");
    } catch {
      throw error(
        IgnoreEngineErrorCode.invalidInput,
        "enumeration problem path is invalid",
        "validate-enumeration-problems",
      );
    }
    if (canonical !== problemPath)
      throw error(
        IgnoreEngineErrorCode.invalidInput,
        "enumeration problem path is not canonical",
        "validate-enumeration-problems",
      );
    return Object.freeze({ code, line: null, path: canonical });
  });
  return Object.freeze({
    fallback: source === "filesystem-fallback",
    omittedProblems,
    paths: Object.freeze(paths),
    problems: Object.freeze(problems),
  });
}

class WorkBudget {
  readonly #clock: IgnoreEngineClock;
  readonly #limits: IgnoreEngineLimits;
  readonly #signal: AbortSignal | undefined;
  readonly #startedAt: number;
  #lastNow: number;
  #lastCheckpointWork = 0;
  #work = 0;

  constructor(
    limits: IgnoreEngineLimits,
    signal: AbortSignal | undefined,
    clock: IgnoreEngineClock,
  ) {
    this.#clock = clock;
    this.#limits = limits;
    this.#signal = signal;
    this.#startedAt = this.#readClock();
    this.#lastNow = this.#startedAt;
    this.checkpoint();
  }

  consume(amount = 1): void {
    this.#work += amount;
    if (!Number.isSafeInteger(this.#work) || this.#work > this.#limits.maximumMatchWork) {
      throw error(
        IgnoreEngineErrorCode.limitExceeded,
        "ignore matching work limit was exceeded",
        "match-limit",
      );
    }
    if (this.#work - this.#lastCheckpointWork >= 1_024) this.checkpoint();
  }

  checkpoint(): void {
    const state = this.#signal === undefined ? false : abortState(this.#signal);
    if (state === undefined) {
      throw error(
        IgnoreEngineErrorCode.invalidOptions,
        "ignore-engine cancellation signal changed identity",
        "cancel",
      );
    }
    if (state)
      throw error(IgnoreEngineErrorCode.aborted, "ignore operation was cancelled", "cancel");
    this.#lastNow = Math.max(this.#lastNow, this.#readClock());
    if (this.#lastNow - this.#startedAt > this.#limits.maximumDurationMs) {
      throw error(
        IgnoreEngineErrorCode.deadlineExceeded,
        "ignore operation deadline was exceeded",
        "deadline",
      );
    }
    this.#lastCheckpointWork = this.#work;
  }

  #readClock(): number {
    let value: number;
    try {
      value = this.#clock.now();
    } catch {
      throw error(IgnoreEngineErrorCode.invalidOptions, "trusted ignore clock failed", "clock");
    }
    if (!Number.isFinite(value)) {
      throw error(IgnoreEngineErrorCode.invalidOptions, "trusted ignore clock is invalid", "clock");
    }
    return value;
  }
}

function stripTrailingSpaces(value: string): string {
  let result = value;
  while (result.endsWith(" ")) {
    let slashes = 0;
    for (let index = result.length - 2; index >= 0 && result[index] === "\\"; index -= 1)
      slashes += 1;
    if (slashes % 2 === 1) {
      const escapeIndex = result.length - 1 - slashes;
      result = `${result.slice(0, escapeIndex)}${result.slice(escapeIndex + 1)}`;
      break;
    }
    result = result.slice(0, -1);
  }
  return result;
}

function patternComponents(value: string): readonly string[] | undefined {
  const components: string[] = [];
  let component = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && value[index + 1] === "/") {
      components.push(component);
      component = "";
      index += 1;
    } else if (character === "/") {
      components.push(component);
      component = "";
    } else {
      component += character ?? "";
    }
  }
  components.push(component);
  if (components.some((part) => part.length === 0)) return undefined;
  return components;
}

function normalizeEscapedSeparators(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] === "/") {
      result += "/";
      index += 1;
    } else {
      result += value.charAt(index);
    }
  }
  return result;
}

function compileClass(
  characters: readonly string[],
  start: number,
): readonly [CharacterToken | undefined, number] {
  let index = start + 1;
  let inverted = false;
  if (characters[index] === "!" || characters[index] === "^") {
    inverted = true;
    index += 1;
  }
  const values: string[] = [];
  if (characters[index] === "]") values.push(characters[index++] ?? "]");
  let closed = false;
  while (index < characters.length) {
    let character = characters[index];
    if (character === "]" && values.length > 0) {
      closed = true;
      index += 1;
      break;
    }
    if (character === "\\" && index + 1 < characters.length) {
      index += 1;
      character = characters[index];
    }
    if (character !== undefined) values.push(character);
    index += 1;
  }
  if (!closed) return [undefined, start + 1];
  const ranges: number[] = [];
  for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
    const first = values[valueIndex];
    if (first === undefined) continue;
    const firstCode = first.codePointAt(0) ?? 0;
    if (values[valueIndex + 1] === "-" && values[valueIndex + 2] !== undefined) {
      const lastCode = values[valueIndex + 2]?.codePointAt(0) ?? firstCode;
      ranges.push(firstCode, lastCode);
      valueIndex += 2;
    } else {
      ranges.push(firstCode, firstCode);
    }
  }
  return [{ inverted, kind: "class", ranges: Object.freeze(ranges) }, index];
}

function compileComponent(value: string): readonly CharacterToken[] | undefined {
  const characters = Array.from(value);
  const tokens: CharacterToken[] = [];
  for (let index = 0; index < characters.length;) {
    const character = characters[index];
    if (character === "\\") {
      const escaped = characters[index + 1];
      if (escaped === undefined) return undefined;
      tokens.push(Object.freeze({ kind: "literal", value: escaped }));
      index += 2;
    } else if (character === "*") {
      while (characters[index] === "*") index += 1;
      tokens.push(Object.freeze({ kind: "star" }));
    } else if (character === "?") {
      tokens.push(Object.freeze({ kind: "any" }));
      index += 1;
    } else if (character === "[") {
      const [token, next] = compileClass(characters, index);
      if (token === undefined) {
        tokens.push(Object.freeze({ kind: "literal", value: "[" }));
      } else {
        tokens.push(Object.freeze(token));
      }
      index = next;
    } else {
      tokens.push(Object.freeze({ kind: "literal", value: character ?? "" }));
      index += 1;
    }
  }
  return Object.freeze(tokens);
}

function compilePattern(value: string, hasSlash: boolean): CompiledPattern | null {
  const rawComponents = patternComponents(value);
  if (rawComponents === undefined) return null;
  const components: (readonly CharacterToken[] | "globstar")[] = [];
  for (const component of rawComponents) {
    if (hasSlash && component === "**") {
      components.push("globstar");
    } else {
      const compiled = compileComponent(component);
      if (compiled === undefined) return null;
      components.push(compiled);
    }
  }
  return Object.freeze({
    components: Object.freeze(components),
    hasSlash,
    trailingGlobstarRequiresChild:
      hasSlash && components.length > 1 && components[components.length - 1] === "globstar",
  });
}

function safePatternText(value: string, limits: IgnoreEngineLimits): void {
  if (
    unsafeText(value) ||
    Array.from(value).length > limits.maximumPatternLength ||
    value.split("/").length > limits.maximumPathDepth
  ) {
    throw error(
      IgnoreEngineErrorCode.malformedInput,
      "ignore pattern contains unsafe or excessive text",
      "parse-pattern",
    );
  }
}

function makeRule(
  rawValue: string,
  source: IgnoreRuleSource,
  basePath: RepositoryRelativePath,
  sourceSequence: number,
  limits: IgnoreEngineLimits,
): InternalRule | null {
  safePatternText(rawValue, limits);
  let value = stripTrailingSpaces(rawValue);
  if (value.length === 0 || value.startsWith("#")) return null;
  let negative = false;
  if (value.startsWith("!")) {
    negative = true;
    value = value.slice(1);
  }
  value = normalizeEscapedSeparators(value);
  let directoryOnly = false;
  if (value.endsWith("/")) {
    directoryOnly = true;
    value = value.slice(0, -1);
  }
  const anchored = value.startsWith("/");
  if (anchored) value = value.slice(1);
  const hasSlash = anchored || value.includes("/");
  const compiled = value.length === 0 ? null : compilePattern(value, hasSlash);
  const sourceRank = SOURCE_RANK[source.kind];
  const precedence = sourceRank * 1_000_000 + sourceSequence;
  const id = `${source.kind}:${source.path ?? source.factId ?? "root"}:${String(source.line ?? sourceSequence)}`;
  return Object.freeze({
    compiled,
    rule: Object.freeze({
      basePath,
      directoryOnly,
      id,
      negative,
      pattern: rawValue,
      precedence,
      source: Object.freeze(source),
      valid: compiled !== null,
    }),
    sourceRank,
    sourceSequence,
  });
}

function validSuppliedPattern(value: string, limits: IgnoreEngineLimits): boolean {
  try {
    safePatternText(value, limits);
  } catch {
    return false;
  }
  let normalized = stripTrailingSpaces(value);
  if (normalized.length === 0 || normalized.startsWith("#")) return false;
  if (normalized.startsWith("!")) normalized = normalized.slice(1);
  normalized = normalizeEscapedSeparators(normalized);
  if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized.startsWith("/")) normalized = normalized.slice(1);
  if (normalized.length === 0) return false;
  return compilePattern(normalized, normalized.includes("/")) !== null;
}

function classMatches(
  token: Extract<CharacterToken, { kind: "class" }>,
  character: string,
): boolean {
  const code = character.codePointAt(0) ?? 0;
  let matched = false;
  for (let index = 0; index < token.ranges.length; index += 2) {
    const first = token.ranges[index] ?? 0;
    const last = token.ranges[index + 1] ?? first;
    if (code >= first && code <= last) {
      matched = true;
      break;
    }
  }
  return token.inverted ? !matched : matched;
}

function componentMatches(
  tokens: readonly CharacterToken[],
  value: string,
  budget: WorkBudget,
): boolean {
  const characters = Array.from(value);
  let previous = new Array<boolean>(characters.length + 1).fill(false);
  previous[0] = true;
  for (const token of tokens) {
    const next = new Array<boolean>(characters.length + 1).fill(false);
    if (token.kind === "star") next[0] = previous[0] ?? false;
    for (let index = 1; index <= characters.length; index += 1) {
      budget.consume();
      const character = characters[index - 1] ?? "";
      if (token.kind === "star") {
        next[index] = (previous[index] ?? false) || (next[index - 1] ?? false);
      } else if (token.kind === "any") {
        next[index] = previous[index - 1] ?? false;
      } else if (token.kind === "literal") {
        next[index] = (previous[index - 1] ?? false) && token.value === character;
      } else {
        next[index] = (previous[index - 1] ?? false) && classMatches(token, character);
      }
    }
    previous = next;
  }
  return previous[characters.length] ?? false;
}

function compiledMatches(compiled: CompiledPattern, value: string, budget: WorkBudget): boolean {
  budget.consume(Math.max(1, value.length));
  const pathComponents = value.split("/");
  if (!compiled.hasSlash) {
    const component = compiled.components[0];
    return component !== undefined && component !== "globstar"
      ? componentMatches(component, pathComponents[pathComponents.length - 1] ?? "", budget)
      : false;
  }
  if (
    compiled.trailingGlobstarRequiresChild &&
    pathComponents.length < compiled.components.length
  ) {
    return false;
  }
  let previous = new Array<boolean>(pathComponents.length + 1).fill(false);
  previous[0] = true;
  for (const component of compiled.components) {
    const next = new Array<boolean>(pathComponents.length + 1).fill(false);
    if (component === "globstar") next[0] = previous[0] ?? false;
    for (let index = 1; index <= pathComponents.length; index += 1) {
      budget.consume();
      if (component === "globstar") {
        next[index] = (previous[index] ?? false) || (next[index - 1] ?? false);
      } else {
        next[index] =
          (previous[index - 1] ?? false) &&
          componentMatches(component, pathComponents[index - 1] ?? "", budget);
      }
    }
    previous = next;
  }
  return previous[pathComponents.length] ?? false;
}

function relativeToBase(
  pathValue: RepositoryRelativePath,
  basePath: RepositoryRelativePath,
): string | undefined {
  if (basePath === ".") return pathValue;
  return pathValue.startsWith(`${basePath}/`) ? pathValue.slice(basePath.length + 1) : undefined;
}

function matchingRule(
  pathValue: RepositoryRelativePath,
  directory: boolean,
  rules: readonly InternalRule[],
  budget: WorkBudget,
): InternalRule | undefined {
  let selected: InternalRule | undefined;
  for (const rule of rules) {
    budget.consume();
    if (rule.compiled === null || (rule.rule.directoryOnly && !directory)) continue;
    const relative = relativeToBase(pathValue, rule.rule.basePath);
    if (relative === undefined || !compiledMatches(rule.compiled, relative, budget)) continue;
    if (
      selected === undefined ||
      rule.sourceRank > selected.sourceRank ||
      (rule.sourceRank === selected.sourceRank && rule.sourceSequence > selected.sourceSequence)
    ) {
      selected = rule;
    }
  }
  return selected;
}

function excludedBy(
  pathValue: RepositoryRelativePath,
  file: boolean,
  rules: readonly InternalRule[],
  budget: WorkBudget,
): InternalRule | undefined {
  const components = pathValue.split("/");
  const directoryCount = file ? components.length - 1 : components.length;
  for (let depth = 1; depth <= directoryCount; depth += 1) {
    const directory = components.slice(0, depth).join("/") as RepositoryRelativePath;
    budget.consume(Math.max(1, directory.length));
    const rule = matchingRule(directory, true, rules, budget);
    if (rule !== undefined && !rule.rule.negative) return rule;
  }
  if (file) {
    const rule = matchingRule(pathValue, false, rules, budget);
    if (rule !== undefined && !rule.rule.negative) return rule;
  }
  return undefined;
}

function fatalFacadeError(value: unknown): boolean {
  if (!(value instanceof ReadOnlyRepositoryError)) return false;
  const fatalCodes = new Set<ReadOnlyRepositoryErrorCode>([
    ReadOnlyRepositoryErrorCode.aborted,
    ReadOnlyRepositoryErrorCode.concurrentOperation,
    ReadOnlyRepositoryErrorCode.deadlineExceeded,
    ReadOnlyRepositoryErrorCode.invalidOptions,
    ReadOnlyRepositoryErrorCode.invalidSelection,
    ReadOnlyRepositoryErrorCode.limitExceeded,
    ReadOnlyRepositoryErrorCode.pathChanged,
  ]);
  return fatalCodes.has(value.code);
}

function decodeIgnoreFile(bytes: Uint8Array, pathValue: RepositoryRelativePath): string {
  try {
    const text = UTF8.decode(bytes);
    if (
      text.startsWith("\uFEFF") ||
      unsafeText(text.replaceAll("\r\n", "\n").replaceAll("\n", ""))
    ) {
      throw new Error("unsafe text");
    }
    return text;
  } catch {
    throw error(
      IgnoreEngineErrorCode.malformedInput,
      "ignore file is not safe UTF-8 text",
      "decode-ignore-file",
      pathValue,
    );
  }
}

function baseOfIgnoreFile(pathValue: RepositoryRelativePath): RepositoryRelativePath {
  const slash = pathValue.lastIndexOf("/");
  return slash === -1
    ? canonicalizeRepositoryRelativePath(".")
    : canonicalizeRepositoryRelativePath(pathValue.slice(0, slash));
}

function frozenProblem(
  code: string,
  pathValue: RepositoryRelativePath | null,
  line: number | null = null,
): IgnoreEngineProblem {
  return Object.freeze({ code, line, path: pathValue });
}

/** Apply C04 with the production monotonic clock. */
export async function applyIgnoreRules(
  repository: ReadOnlyRepository,
  enumeration: TrackedFileEnumerationResult,
  options?: IgnoreEngineOptions,
): Promise<IgnoreEngineResult> {
  return applyIgnoreRulesWithClock(repository, enumeration, options, DEFAULT_CLOCK);
}

/** Trusted clock-injected form for deterministic deadline verification. */
export async function applyIgnoreRulesWithClock(
  repository: ReadOnlyRepository,
  enumeration: TrackedFileEnumerationResult,
  options: IgnoreEngineOptions | undefined,
  clock: IgnoreEngineClock,
): Promise<IgnoreEngineResult> {
  const snapshot = snapshotOptions(options);
  const input = snapshotEnumeration(enumeration, snapshot.limits);
  const budget = new WorkBudget(snapshot.limits, snapshot.signal, clock);
  const rules: InternalRule[] = [];
  const problems: IgnoreEngineProblem[] = input.problems.slice(0, snapshot.limits.maximumProblems);
  let omittedProblems =
    input.omittedProblems + Math.max(0, input.problems.length - snapshot.limits.maximumProblems);
  let patternBytes = 0;
  let sourceSequence = 0;
  const recordProblem = (problem: IgnoreEngineProblem): void => {
    if (problems.length < snapshot.limits.maximumProblems) problems.push(problem);
    else omittedProblems += 1;
  };
  const consumePatternBytes = (amount: number): void => {
    patternBytes += amount;
    if (patternBytes > snapshot.limits.maximumPatternBytes) {
      throw error(
        IgnoreEngineErrorCode.limitExceeded,
        "ignore pattern resource limit was exceeded",
        "pattern-limit",
      );
    }
  };
  const addRule = (
    raw: string,
    source: IgnoreRuleSource,
    base: RepositoryRelativePath,
    countBytes = true,
  ): void => {
    if (countBytes) consumePatternBytes(Buffer.byteLength(raw, "utf8"));
    const nextSequence = sourceSequence + 1;
    const rule = makeRule(raw, source, base, nextSequence, snapshot.limits);
    if (rule === null) return;
    if (rules.length >= snapshot.limits.maximumPatterns) {
      throw error(
        IgnoreEngineErrorCode.limitExceeded,
        "ignore pattern resource limit was exceeded",
        "pattern-limit",
      );
    }
    sourceSequence = nextSequence;
    rules.push(rule);
    if (!rule.rule.valid) {
      recordProblem(frozenProblem("INVALID_PATTERN_NEVER_MATCHES", source.path, source.line));
    }
  };

  for (const [index, pattern] of BUILT_IN_IGNORE_PATTERNS.entries()) {
    addRule(
      pattern,
      {
        factId: null,
        kind: "built-in",
        line: index + 1,
        path: null,
        profileId: null,
        sourceUrl: null,
      },
      canonicalizeRepositoryRelativePath("."),
    );
  }
  for (const [index, pattern] of snapshot.configurationPatterns.entries()) {
    addRule(
      pattern,
      {
        factId: null,
        kind: "configuration",
        line: index + 1,
        path: null,
        profileId: null,
        sourceUrl: null,
      },
      canonicalizeRepositoryRelativePath("."),
    );
  }
  const deferredProfileFacts = snapshot.profileFacts.filter(
    (fact) =>
      fact.applicability === "conditional" ||
      fact.applicability === "contradiction" ||
      fact.applicability === "unknown",
  );
  const appliedProfileFactIds: string[] = [];
  for (const fact of snapshot.profileFacts) {
    if (fact.applicability !== "known-active") continue;
    appliedProfileFactIds.push(fact.factId);
    addRule(
      fact.pattern,
      {
        factId: fact.factId,
        kind: "profile",
        line: null,
        path: null,
        profileId: fact.profileId,
        sourceUrl: fact.sourceUrl,
      },
      canonicalizeRepositoryRelativePath("."),
    );
  }

  if (input.fallback) {
    const ignoreFiles = input.paths
      .filter((pathValue) => pathValue === ".gitignore" || pathValue.endsWith("/.gitignore"))
      .sort((left, right) => {
        const depth = left.split("/").length - right.split("/").length;
        return depth === 0 ? left.localeCompare(right, "en-US") : depth;
      });
    if (ignoreFiles.length > snapshot.limits.maximumIgnoreFiles) {
      throw error(
        IgnoreEngineErrorCode.limitExceeded,
        "ignore file count limit was exceeded",
        "ignore-file-limit",
      );
    }
    for (const ignorePath of ignoreFiles) {
      budget.checkpoint();
      const base = baseOfIgnoreFile(ignorePath);
      if (base !== "." && excludedBy(base, false, rules, budget) !== undefined) continue;
      let inspected;
      try {
        inspected = await repository.inspect(ignorePath);
      } catch (cause: unknown) {
        if (fatalFacadeError(cause)) throw cause;
        recordProblem(
          frozenProblem(
            cause instanceof ReadOnlyRepositoryError ? cause.code : "IGNORE_FILE_UNAVAILABLE",
            ignorePath,
          ),
        );
        continue;
      }
      if (inspected.type !== "file") {
        recordProblem(frozenProblem("IGNORE_FILE_UNSAFE_TYPE", ignorePath));
        continue;
      }
      if (inspected.linkDepth !== 0) {
        recordProblem(frozenProblem("IGNORE_FILE_LINK_SKIPPED", ignorePath));
        continue;
      }
      if (inspected.size > snapshot.limits.maximumIgnoreFileBytes) {
        throw error(
          IgnoreEngineErrorCode.limitExceeded,
          "ignore file byte limit was exceeded",
          "ignore-file-limit",
          ignorePath,
        );
      }
      let file;
      try {
        file = await repository.readFile(ignorePath);
      } catch (cause: unknown) {
        if (fatalFacadeError(cause)) throw cause;
        recordProblem(
          frozenProblem(
            cause instanceof ReadOnlyRepositoryError ? cause.code : "IGNORE_FILE_UNAVAILABLE",
            ignorePath,
          ),
        );
        continue;
      }
      if (
        file.linkDepth !== 0 ||
        file.identity.device !== inspected.identity.device ||
        file.identity.inode !== inspected.identity.inode
      ) {
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathChanged,
          "ignore file identity changed before read",
          "ignore-file-race",
          ignorePath,
        );
      }
      const bytes = file.bytes();
      if (bytes.byteLength > snapshot.limits.maximumIgnoreFileBytes) {
        throw error(
          IgnoreEngineErrorCode.limitExceeded,
          "ignore file byte limit was exceeded",
          "ignore-file-limit",
          ignorePath,
        );
      }
      consumePatternBytes(bytes.byteLength);
      const text = decodeIgnoreFile(bytes, ignorePath);
      const lines = text.split("\n");
      for (const [index, rawLine] of lines.entries()) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        addRule(
          line,
          {
            factId: null,
            kind: "gitignore",
            line: index + 1,
            path: ignorePath,
            profileId: null,
            sourceUrl: "https://git-scm.com/docs/gitignore/2.55.0",
          },
          base,
          false,
        );
      }
    }
  }

  const included: RepositoryRelativePath[] = [];
  const ignored: IgnoredPathDecision[] = [];
  for (const pathValue of input.paths) {
    budget.consume();
    const rule = excludedBy(pathValue, true, rules, budget);
    if (rule === undefined) included.push(pathValue);
    else {
      ignored.push(
        Object.freeze({
          certainty:
            input.fallback && rule.rule.source.kind === "gitignore"
              ? "tracking-uncertain"
              : "known",
          path: pathValue,
          ruleId: rule.rule.id,
        }),
      );
    }
  }
  budget.checkpoint();
  return Object.freeze({
    appliedProfileFactIds: Object.freeze(appliedProfileFactIds),
    certainty: input.fallback ? "fallback-tracking-uncertain" : "exact-tracked-input",
    deferredProfileFacts: Object.freeze(deferredProfileFacts),
    ignored: Object.freeze(ignored),
    limits: snapshot.limits,
    omittedProblems,
    paths: Object.freeze(included),
    problems: Object.freeze(
      problems.sort((left, right) => {
        const leftPath = left.path ?? "";
        const rightPath = right.path ?? "";
        return leftPath === rightPath
          ? (left.line ?? 0) - (right.line ?? 0)
          : leftPath.localeCompare(rightPath, "en-US");
      }),
    ),
    profileCertainty: deferredProfileFacts.length === 0 ? "known" : "uncertain-facts-deferred",
    profileFacts: snapshot.profileFacts,
    rules: Object.freeze(rules.map((rule) => rule.rule)),
    trackingCertainty: input.fallback ? "fallback-mixed-unknown" : "tracked",
  });
}
