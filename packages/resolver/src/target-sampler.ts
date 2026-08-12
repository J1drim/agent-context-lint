import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  REPOSITORY_ROOT,
  compareRepositoryRelativePaths,
  isRepositoryRelativePath,
} from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";
import type { TrackedFileEnumerationReason, WorkspaceBoundary } from "@agent-context/evidence";

import { ACTIVATION_STATES } from "./activation-algebra.js";
import type { ActivationState } from "./activation-algebra.js";

export const TARGET_SAMPLER_CONTRACT_VERSION = "0.1.0" as const;
export const TARGET_SAMPLER_MAX_PATH_CODE_UNITS = 32_768 as const;
export const TARGET_SAMPLER_DEFAULT_LIMITS: Readonly<TargetSamplerLimits> = Object.freeze({
  exhaustiveSourceFileLimit: 1_000,
  maximumActivationFacts: 1_000_000,
  maximumCriticalPaths: 4_096,
  maximumDurationMs: 30_000,
  maximumPaths: 100_000,
  maximumPathTextBytes: 67_108_864,
  maximumRulesPerPath: 4_096,
  maximumSamples: 100_000,
  maximumWorkspaceBoundaries: 10_000,
});
export const TARGET_SAMPLER_HARD_LIMITS: Readonly<TargetSamplerLimits> = Object.freeze({
  exhaustiveSourceFileLimit: 100_000,
  maximumActivationFacts: 10_000_000,
  maximumCriticalPaths: 100_000,
  maximumDurationMs: 300_000,
  maximumPaths: 1_000_000,
  maximumPathTextBytes: 536_870_912,
  maximumRulesPerPath: 100_000,
  maximumSamples: 1_000_000,
  maximumWorkspaceBoundaries: 100_000,
});

export interface TargetSamplerLimits {
  readonly exhaustiveSourceFileLimit: number;
  readonly maximumActivationFacts: number;
  readonly maximumCriticalPaths: number;
  readonly maximumDurationMs: number;
  readonly maximumPaths: number;
  readonly maximumPathTextBytes: number;
  readonly maximumRulesPerPath: number;
  readonly maximumSamples: number;
  readonly maximumWorkspaceBoundaries: number;
}

export interface TargetSamplerOptions extends Partial<TargetSamplerLimits> {
  readonly clock?: TargetSamplerClock;
}

export interface TargetSamplerClock {
  now(): number;
}

export interface TargetActivationFact {
  readonly ruleId: string;
  readonly state: ActivationState;
}

export interface TargetActivationObservation {
  readonly path: RepositoryRelativePath;
  readonly states: readonly TargetActivationFact[];
}

export interface SampleTargetsInput {
  readonly activationObservations: readonly TargetActivationObservation[];
  readonly criticalPaths: readonly RepositoryRelativePath[];
  readonly paths: readonly RepositoryRelativePath[];
  readonly trackingCertainty: "all-files-not-tracked" | "tracked";
  readonly trackingReason: TrackedFileEnumerationReason;
  readonly workspaceBoundaries: readonly WorkspaceBoundary[];
  readonly workspaceUncertainty: "known" | "uncertain";
  readonly workspaceUncertaintyReasons: readonly string[];
}

export type TargetSourceLanguage =
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "dart"
  | "elixir"
  | "erlang"
  | "fsharp"
  | "go"
  | "graphql"
  | "groovy"
  | "haskell"
  | "html"
  | "java"
  | "javascript"
  | "kotlin"
  | "lua"
  | "make"
  | "objective-c"
  | "perl"
  | "php"
  | "powershell"
  | "protobuf"
  | "python"
  | "r"
  | "ruby"
  | "rust"
  | "scala"
  | "shell"
  | "solidity"
  | "sql"
  | "svelte"
  | "swift"
  | "terraform"
  | "typescript"
  | "vue"
  | "zig";

export type TargetCoverageKind =
  | "critical-path"
  | "exhaustive-source-set"
  | "language-directory"
  | "scope-partition"
  | "workspace-root";

export interface TargetCoverageCriterion {
  readonly candidateCount: number;
  readonly id: string;
  readonly kind: TargetCoverageKind;
  readonly selectedPath: RepositoryRelativePath | null;
  readonly status: "covered" | "unavailable";
}

export interface SampledTarget {
  readonly activationPartitionId: string | null;
  readonly language: TargetSourceLanguage | null;
  readonly path: RepositoryRelativePath;
  readonly reasons: readonly string[];
}

export interface TargetSamplingProvenance {
  readonly trackingCertainty: "all-files-not-tracked" | "tracked";
  readonly trackingReason: TrackedFileEnumerationReason;
  readonly workspaceUncertainty: "known" | "uncertain";
  readonly workspaceUncertaintyReasons: readonly string[];
}

export interface TargetSamplingMetrics {
  readonly activationFactCount: number;
  readonly criticalPathCount: number;
  readonly languageDirectoryCount: number;
  readonly partitionCount: number;
  readonly sourcePathCount: number;
  readonly trackedPathCount: number;
  readonly workspaceRootCount: number;
}

export interface TargetSamplingResult {
  readonly recordKind: "agent-context-target-sampling";
  readonly contractVersion: typeof TARGET_SAMPLER_CONTRACT_VERSION;
  readonly coverage: readonly TargetCoverageCriterion[];
  readonly limits: TargetSamplerLimits;
  readonly metrics: TargetSamplingMetrics;
  readonly provenance: TargetSamplingProvenance;
  readonly selected: readonly SampledTarget[];
  readonly state: "complete" | "partial";
  readonly strategy: "exhaustive" | "stratified";
}

const ISSUED_TARGET_SAMPLING_RESULTS = new WeakSet<object>();

/** True only for sampling proofs produced by this process's E08 sampler. */
export function isIssuedTargetSamplingResult(value: unknown): value is TargetSamplingResult {
  return typeof value === "object" && value !== null && ISSUED_TARGET_SAMPLING_RESULTS.has(value);
}

export const TargetSamplerErrorCode: Readonly<{
  deadlineExceeded: "TARGET_SAMPLER_DEADLINE_EXCEEDED";
  invalidInput: "TARGET_SAMPLER_INVALID_INPUT";
  invalidOptions: "TARGET_SAMPLER_INVALID_OPTIONS";
  invalidRelationship: "TARGET_SAMPLER_INVALID_RELATIONSHIP";
  resourceLimit: "TARGET_SAMPLER_RESOURCE_LIMIT";
}> = Object.freeze({
  deadlineExceeded: "TARGET_SAMPLER_DEADLINE_EXCEEDED",
  invalidInput: "TARGET_SAMPLER_INVALID_INPUT",
  invalidOptions: "TARGET_SAMPLER_INVALID_OPTIONS",
  invalidRelationship: "TARGET_SAMPLER_INVALID_RELATIONSHIP",
  resourceLimit: "TARGET_SAMPLER_RESOURCE_LIMIT",
} as const);

export type TargetSamplerErrorCode =
  (typeof TargetSamplerErrorCode)[keyof typeof TargetSamplerErrorCode];

export class TargetSamplerError extends Error {
  readonly code: TargetSamplerErrorCode;

  constructor(code: TargetSamplerErrorCode, message: string) {
    super(message);
    this.name = "TargetSamplerError";
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface Candidate {
  readonly directory: RepositoryRelativePath;
  readonly language: TargetSourceLanguage;
  readonly partitionId: string;
  readonly path: RepositoryRelativePath;
}

interface NormalizedWorkspace {
  readonly id: string;
  readonly root: RepositoryRelativePath;
}

interface CoverageGroup {
  count: number;
  readonly first: RepositoryRelativePath;
}

const LANGUAGE_EXTENSIONS: Readonly<Record<string, TargetSourceLanguage>> = Object.freeze({
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".cts": "typescript",
  ".cxx": "cpp",
  ".dart": "dart",
  ".eex": "elixir",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".fs": "fsharp",
  ".fsx": "fsharp",
  ".go": "go",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".gradle": "groovy",
  ".groovy": "groovy",
  ".h": "c",
  ".hs": "haskell",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".html": "html",
  ".hxx": "cpp",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".less": "css",
  ".lua": "lua",
  ".m": "objective-c",
  ".mm": "objective-c",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".pl": "perl",
  ".pm": "perl",
  ".php": "php",
  ".proto": "protobuf",
  ".ps1": "powershell",
  ".py": "python",
  ".pyi": "python",
  ".r": "r",
  ".rb": "ruby",
  ".rs": "rust",
  ".sass": "css",
  ".scala": "scala",
  ".scss": "css",
  ".sh": "shell",
  ".sol": "solidity",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".tf": "terraform",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "vue",
  ".zig": "zig",
});
const LANGUAGE_BASENAMES: Readonly<Record<string, TargetSourceLanguage>> = Object.freeze({
  Dockerfile: "shell",
  GNUmakefile: "make",
  Makefile: "make",
});
const LIMIT_KEYS = Object.freeze(Object.keys(TARGET_SAMPLER_DEFAULT_LIMITS).sort());
const ID_PATTERN = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const TRACKING_REASONS = new Set<TrackedFileEnumerationReason>([
  "git-directory-missing",
  "git-index-malformed",
  "git-index-missing",
  "git-index-unsupported",
  "git-metadata-unsafe",
  "git-worktree-external-metadata",
  "verified-git-index",
]);
const WORKSPACE_FAMILIES = new Set([
  "bazel-build",
  "bazel-module",
  "bazel-workspace",
  "cargo",
  "go-module",
  "go-workspace",
  "javascript-package",
  "lerna",
  "nx",
  "pnpm",
  "python-project",
  "python-setup-cfg",
  "python-setup-py",
  "rush",
  "turbo",
]);
const WORKSPACE_LANGUAGES = new Set(["bazel", "go", "javascript", "python", "rust"]);

function fail(code: TargetSamplerErrorCode, message: string): never {
  throw new TargetSamplerError(code, message);
}

function record(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    fail(TargetSamplerErrorCode.invalidInput, `${label} must be a non-proxy data record`);
  }
  let prototype: object | null;
  let actual: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    actual = Reflect.ownKeys(value);
  } catch {
    fail(TargetSamplerErrorCode.invalidInput, `${label} cannot be inspected safely`);
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail(TargetSamplerErrorCode.invalidInput, `${label} has unexpected fields`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(TargetSamplerErrorCode.invalidInput, `${label}.${key} must be an own data property`);
    }
  }
  return value as DataRecord;
}

function property(value: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(TargetSamplerErrorCode.invalidInput, `${label} must be a regular dense array`);
  }
  if (value.length > maximum)
    fail(TargetSamplerErrorCode.resourceLimit, `${label} exceeds its item limit`);
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    fail(TargetSamplerErrorCode.invalidInput, `${label} must be dense and unextended`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail(TargetSamplerErrorCode.invalidInput, `${label} contains an unsafe entry`);
    }
  }
  return value;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (
    typeof value !== "string" ||
    value.length > TARGET_SAMPLER_MAX_PATH_CODE_UNITS ||
    !isRepositoryRelativePath(value) ||
    value === REPOSITORY_ROOT
  ) {
    fail(TargetSamplerErrorCode.invalidInput, `${label} must be a canonical repository file path`);
  }
  return value;
}

function rootValue(value: unknown, label: string): RepositoryRelativePath {
  if (
    typeof value !== "string" ||
    value.length > TARGET_SAMPLER_MAX_PATH_CODE_UNITS ||
    !isRepositoryRelativePath(value)
  ) {
    fail(TargetSamplerErrorCode.invalidInput, `${label} must be a canonical repository path`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail(TargetSamplerErrorCode.invalidInput, `${label} must be bounded text`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(TargetSamplerErrorCode.invalidOptions, `${label} must be a bounded positive integer`);
  }
  return value;
}

function resolveOptions(value: TargetSamplerOptions | undefined): {
  readonly clock: TargetSamplerClock;
  readonly limits: TargetSamplerLimits;
} {
  if (value === undefined)
    return {
      clock: Object.freeze({ now: (): number => performance.now() }),
      limits: TARGET_SAMPLER_DEFAULT_LIMITS,
    };
  const input: unknown = value;
  if (
    input === null ||
    typeof input !== "object" ||
    nodeTypes.isProxy(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    fail(TargetSamplerErrorCode.invalidOptions, "options must be a non-proxy data record");
  }
  const actual = Reflect.ownKeys(input);
  if (
    actual.some((key) => typeof key !== "string" || (key !== "clock" && !LIMIT_KEYS.includes(key)))
  ) {
    fail(TargetSamplerErrorCode.invalidOptions, "options contain an unknown field");
  }
  const values = { ...TARGET_SAMPLER_DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) continue;
    if (!descriptor.enumerable || !("value" in descriptor))
      fail(TargetSamplerErrorCode.invalidOptions, `options.${key} must be data`);
    const hard = TARGET_SAMPLER_HARD_LIMITS[key as keyof TargetSamplerLimits];
    values[key as keyof TargetSamplerLimits] = positiveInteger(
      descriptor.value,
      `options.${key}`,
      hard,
    );
  }
  const clockDescriptor = Object.getOwnPropertyDescriptor(input, "clock");
  if (
    clockDescriptor !== undefined &&
    (!clockDescriptor.enumerable || !("value" in clockDescriptor))
  )
    fail(TargetSamplerErrorCode.invalidOptions, "options.clock must be data");
  const clockValue: unknown =
    clockDescriptor === undefined ? undefined : (clockDescriptor.value as unknown);
  if (
    clockValue !== undefined &&
    (clockValue === null ||
      typeof clockValue !== "object" ||
      nodeTypes.isProxy(clockValue) ||
      (Object.getPrototypeOf(clockValue) !== Object.prototype &&
        Object.getPrototypeOf(clockValue) !== null))
  )
    fail(TargetSamplerErrorCode.invalidOptions, "options.clock is invalid");
  const nowDescriptor =
    clockValue === undefined ? undefined : Object.getOwnPropertyDescriptor(clockValue, "now");
  if (
    clockValue !== undefined &&
    (Reflect.ownKeys(clockValue).length !== 1 ||
      nowDescriptor === undefined ||
      !nowDescriptor.enumerable ||
      !("value" in nowDescriptor) ||
      typeof nowDescriptor.value !== "function")
  )
    fail(TargetSamplerErrorCode.invalidOptions, "options.clock.now is invalid");
  const nowFunction: (() => unknown) | undefined =
    nowDescriptor !== undefined && "value" in nowDescriptor
      ? (nowDescriptor.value as () => unknown)
      : undefined;
  const clock: TargetSamplerClock = Object.freeze({
    now: (): number =>
      nowFunction === undefined
        ? performance.now()
        : (Reflect.apply(nowFunction, clockValue, []) as number),
  });
  return Object.freeze({ clock, limits: Object.freeze(values) });
}

function readClock(clock: TargetSamplerClock): number {
  let now: number;
  try {
    now = clock.now();
  } catch {
    fail(TargetSamplerErrorCode.invalidOptions, "options.clock.now failed");
  }
  if (!Number.isFinite(now))
    fail(TargetSamplerErrorCode.invalidOptions, "options.clock.now must be finite");
  return now;
}

function checkDeadline(clock: TargetSamplerClock, deadline: number): void {
  const now = readClock(clock);
  if (now > deadline)
    fail(TargetSamplerErrorCode.deadlineExceeded, "target sampling deadline exceeded");
}

function directoryOf(path: RepositoryRelativePath): RepositoryRelativePath {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? REPOSITORY_ROOT : (path.slice(0, slash) as RepositoryRelativePath);
}

function classifyNormalizedTargetSourcePath(
  path: RepositoryRelativePath,
): TargetSourceLanguage | null {
  const rawName = path.slice(path.lastIndexOf("/") + 1);
  const basenameLanguage = LANGUAGE_BASENAMES[rawName];
  if (basenameLanguage !== undefined) return basenameLanguage;
  const name = rawName.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : (LANGUAGE_EXTENSIONS[name.slice(dot)] ?? null);
}

/** Classify one canonical repository file path with E08's exact source-language table. */
export function classifyTargetSourcePath(value: unknown): TargetSourceLanguage | null {
  if (
    typeof value !== "string" ||
    value.length > TARGET_SAMPLER_MAX_PATH_CODE_UNITS ||
    !isRepositoryRelativePath(value) ||
    value === REPOSITORY_ROOT
  )
    fail(TargetSamplerErrorCode.invalidInput, "source path must be a canonical repository file");
  return classifyNormalizedTargetSourcePath(value);
}

function underRoot(path: RepositoryRelativePath, root: RepositoryRelativePath): boolean {
  return root === REPOSITORY_ROOT || path.startsWith(`${root}/`);
}

function lowerBound(paths: readonly RepositoryRelativePath[], value: string): number {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const path = paths[middle];
    if (path !== undefined && path < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function underRootRange(
  paths: readonly RepositoryRelativePath[],
  root: RepositoryRelativePath,
): { readonly count: number; readonly first: RepositoryRelativePath | null } {
  if (root === REPOSITORY_ROOT) {
    return Object.freeze({ count: paths.length, first: paths[0] ?? null });
  }
  const prefix = `${root}/`;
  const start = lowerBound(paths, prefix);
  const end = lowerBound(paths, `${prefix}\u{10ffff}`);
  const first = paths[start];
  return Object.freeze({
    count: end - start,
    first: first !== undefined && underRoot(first, root) ? first : null,
  });
}

function partitionId(states: readonly TargetActivationFact[]): string {
  const hash = createHash("sha256").update("target-activation-partition-v1", "utf8");
  for (const fact of states) {
    for (const field of [fact.ruleId, fact.state]) {
      hash
        .update("\0", "utf8")
        .update(String(Buffer.byteLength(field, "utf8")), "ascii")
        .update(":", "ascii")
        .update(field, "utf8");
    }
  }
  return `partition:${hash.digest("hex")}`;
}

function partitionSignature(states: readonly TargetActivationFact[]): string {
  return states
    .map((fact) => `${String(fact.ruleId.length)}:${fact.ruleId}:${fact.state}`)
    .join("|");
}

function criterion(
  kind: TargetCoverageKind,
  id: string,
  paths: readonly RepositoryRelativePath[],
): TargetCoverageCriterion {
  return Object.freeze({
    candidateCount: paths.length,
    id,
    kind,
    selectedPath: paths[0] ?? null,
    status: paths.length === 0 ? "unavailable" : "covered",
  });
}

/** Select a deterministic coverage-complete target set without reading or executing repository content. */
export function sampleTargets(
  inputValue: SampleTargetsInput,
  optionsValue?: TargetSamplerOptions,
): TargetSamplingResult {
  const { clock, limits } = resolveOptions(optionsValue);
  const started = readClock(clock);
  const deadline = started + limits.maximumDurationMs;
  if (!Number.isFinite(deadline))
    fail(TargetSamplerErrorCode.invalidOptions, "sampling deadline is outside finite range");
  const input = record(
    inputValue,
    [
      "activationObservations",
      "criticalPaths",
      "paths",
      "trackingCertainty",
      "trackingReason",
      "workspaceBoundaries",
      "workspaceUncertainty",
      "workspaceUncertaintyReasons",
    ],
    "input",
  );
  const rawPaths = denseArray(property(input, "paths"), limits.maximumPaths, "paths");
  let pathBytes = 0;
  const paths = rawPaths
    .map((value, index) => {
      if (index % 1_024 === 0) checkDeadline(clock, deadline);
      const path = pathValue(value, `paths[${String(index)}]`);
      pathBytes += Buffer.byteLength(path, "utf8");
      if (pathBytes > limits.maximumPathTextBytes)
        fail(TargetSamplerErrorCode.resourceLimit, "path text exceeds its byte limit");
      return path;
    })
    .sort(compareRepositoryRelativePaths);
  if (new Set(paths).size !== paths.length)
    fail(TargetSamplerErrorCode.invalidRelationship, "paths must be unique");
  const tracked = new Set<RepositoryRelativePath>(paths);
  const trackingCertainty = property(input, "trackingCertainty");
  if (trackingCertainty !== "tracked" && trackingCertainty !== "all-files-not-tracked")
    fail(TargetSamplerErrorCode.invalidInput, "trackingCertainty is invalid");
  const trackingReason = property(input, "trackingReason");
  if (
    typeof trackingReason !== "string" ||
    !TRACKING_REASONS.has(trackingReason as TrackedFileEnumerationReason)
  ) {
    fail(TargetSamplerErrorCode.invalidInput, "trackingReason is invalid");
  }
  const normalizedTrackingReason = trackingReason as TrackedFileEnumerationReason;
  if ((trackingCertainty === "tracked") !== (normalizedTrackingReason === "verified-git-index")) {
    fail(TargetSamplerErrorCode.invalidRelationship, "tracking certainty and reason disagree");
  }
  const workspaceUncertainty = property(input, "workspaceUncertainty");
  if (workspaceUncertainty !== "known" && workspaceUncertainty !== "uncertain")
    fail(TargetSamplerErrorCode.invalidInput, "workspaceUncertainty is invalid");
  const uncertaintyReasons = denseArray(
    property(input, "workspaceUncertaintyReasons"),
    1_000,
    "workspaceUncertaintyReasons",
  )
    .map((value, index) => {
      const reason = boundedText(value, `workspaceUncertaintyReasons[${String(index)}]`, 1_024);
      if (!ID_PATTERN.test(reason))
        fail(
          TargetSamplerErrorCode.invalidInput,
          `workspaceUncertaintyReasons[${String(index)}] is invalid`,
        );
      return reason;
    })
    .sort();
  if (new Set(uncertaintyReasons).size !== uncertaintyReasons.length)
    fail(
      TargetSamplerErrorCode.invalidRelationship,
      "workspace uncertainty reasons must be unique",
    );
  if ((workspaceUncertainty === "known") !== (uncertaintyReasons.length === 0)) {
    fail(
      TargetSamplerErrorCode.invalidRelationship,
      "workspace uncertainty state and reasons disagree",
    );
  }

  const rawWorkspaces = denseArray(
    property(input, "workspaceBoundaries"),
    limits.maximumWorkspaceBoundaries,
    "workspaceBoundaries",
  );
  const workspaceMap = new Map<string, NormalizedWorkspace>();
  for (const [index, value] of rawWorkspaces.entries()) {
    if (index % 1_024 === 0) checkDeadline(clock, deadline);
    const label = `workspaceBoundaries[${String(index)}]`;
    const item = record(value, ["evidencePath", "family", "kind", "languages", "root"], label);
    pathValue(property(item, "evidencePath"), `${label}.evidencePath`);
    const family = boundedText(property(item, "family"), `${label}.family`);
    if (!WORKSPACE_FAMILIES.has(family))
      fail(TargetSamplerErrorCode.invalidInput, `${label}.family is invalid`);
    const kind = property(item, "kind");
    if (kind !== "project" && kind !== "source" && kind !== "workspace")
      fail(TargetSamplerErrorCode.invalidInput, `${label}.kind is invalid`);
    const languages = denseArray(property(item, "languages"), 16, `${label}.languages`);
    for (const [languageIndex, language] of languages.entries()) {
      if (typeof language !== "string" || !WORKSPACE_LANGUAGES.has(language))
        fail(
          TargetSamplerErrorCode.invalidInput,
          `${label}.languages[${String(languageIndex)}] is invalid`,
        );
    }
    const root = rootValue(property(item, "root"), `${label}.root`);
    workspaceMap.set(root, Object.freeze({ id: root, root }));
  }
  const workspaces = [...workspaceMap.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

  const sources = paths.flatMap((path) => {
    const language = classifyNormalizedTargetSourcePath(path);
    return language === null ? [] : [{ directory: directoryOf(path), language, path }];
  });
  const sourceSet = new Set(sources.map((source) => source.path));
  const rawObservations = denseArray(
    property(input, "activationObservations"),
    limits.maximumPaths,
    "activationObservations",
  );
  const observations = new Map<RepositoryRelativePath, readonly TargetActivationFact[]>();
  let activationFactCount = 0;
  let ruleUniverse: readonly string[] | undefined;
  for (const [index, value] of rawObservations.entries()) {
    if (index % 1_024 === 0) checkDeadline(clock, deadline);
    const label = `activationObservations[${String(index)}]`;
    const item = record(value, ["path", "states"], label);
    const path = pathValue(property(item, "path"), `${label}.path`);
    if (!sourceSet.has(path) || observations.has(path))
      fail(
        TargetSamplerErrorCode.invalidRelationship,
        `${label}.path must identify one unique source path`,
      );
    const rawStates = denseArray(
      property(item, "states"),
      limits.maximumRulesPerPath,
      `${label}.states`,
    );
    activationFactCount += rawStates.length;
    if (activationFactCount > limits.maximumActivationFacts)
      fail(TargetSamplerErrorCode.resourceLimit, "activation facts exceed their total limit");
    const states = rawStates
      .map((stateValue, stateIndex) => {
        const stateLabel = `${label}.states[${String(stateIndex)}]`;
        const stateRecord = record(stateValue, ["ruleId", "state"], stateLabel);
        const ruleId = boundedText(property(stateRecord, "ruleId"), `${stateLabel}.ruleId`);
        if (!ID_PATTERN.test(ruleId))
          fail(TargetSamplerErrorCode.invalidInput, `${stateLabel}.ruleId is invalid`);
        const state = property(stateRecord, "state");
        if (!ACTIVATION_STATES.includes(state as ActivationState))
          fail(TargetSamplerErrorCode.invalidInput, `${stateLabel}.state is invalid`);
        return Object.freeze({ ruleId, state: state as ActivationState });
      })
      .sort((left, right) =>
        left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0,
      );
    const ruleIds = states.map((state) => state.ruleId);
    if (new Set(ruleIds).size !== ruleIds.length)
      fail(TargetSamplerErrorCode.invalidRelationship, `${label}.states contain duplicate rules`);
    if (ruleUniverse === undefined) ruleUniverse = ruleIds;
    else if (
      ruleUniverse.length !== ruleIds.length ||
      ruleUniverse.some((id, ruleIndex) => id !== ruleIds[ruleIndex])
    )
      fail(
        TargetSamplerErrorCode.invalidRelationship,
        "every source observation must cover the same rule universe",
      );
    observations.set(path, Object.freeze(states));
  }
  if (observations.size !== sources.length)
    fail(
      TargetSamplerErrorCode.invalidRelationship,
      "every source path needs exactly one activation observation",
    );
  const partitionIds = new Map<string, string>();
  const candidates: Candidate[] = sources.map((source) => {
    const states = observations.get(source.path) ?? [];
    const signature = partitionSignature(states);
    const existing = partitionIds.get(signature);
    const id = existing ?? partitionId(states);
    partitionIds.set(signature, id);
    return Object.freeze({ ...source, partitionId: id });
  });

  const rawCritical = denseArray(
    property(input, "criticalPaths"),
    limits.maximumCriticalPaths,
    "criticalPaths",
  );
  const criticalPaths = rawCritical
    .map((value, index) => pathValue(value, `criticalPaths[${String(index)}]`))
    .sort(compareRepositoryRelativePaths);
  if (new Set(criticalPaths).size !== criticalPaths.length)
    fail(TargetSamplerErrorCode.invalidRelationship, "critical paths must be unique");

  const coverage: TargetCoverageCriterion[] = [];
  const reasons = new Map<RepositoryRelativePath, Set<string>>();
  const select = (path: RepositoryRelativePath | null, reason: string): void => {
    if (path === null) return;
    const current = reasons.get(path) ?? new Set<string>();
    current.add(reason);
    reasons.set(path, current);
    if (reasons.size > limits.maximumSamples)
      fail(TargetSamplerErrorCode.resourceLimit, "required coverage exceeds maximumSamples");
  };
  const strategy = sources.length <= limits.exhaustiveSourceFileLimit ? "exhaustive" : "stratified";
  if (strategy === "exhaustive") {
    for (const source of sources) select(source.path, "exhaustive-source-set:all");
    coverage.push(
      Object.freeze({
        candidateCount: sources.length,
        id: "all",
        kind: "exhaustive-source-set",
        selectedPath: sources[0]?.path ?? null,
        status: "covered",
      }),
    );
  }
  for (const path of criticalPaths) {
    const criterionValue = criterion("critical-path", path, tracked.has(path) ? [path] : []);
    coverage.push(criterionValue);
    select(criterionValue.selectedPath, `critical-path:${path}`);
  }
  const candidatePaths = candidates.map((candidate) => candidate.path);
  for (const workspace of workspaces) {
    const range = underRootRange(candidatePaths, workspace.root);
    const criterionValue: TargetCoverageCriterion = Object.freeze({
      candidateCount: range.count,
      id: workspace.id,
      kind: "workspace-root",
      selectedPath: range.first,
      status: range.first === null ? "unavailable" : "covered",
    });
    coverage.push(criterionValue);
    select(criterionValue.selectedPath, `workspace-root:${workspace.id}`);
  }
  const partitions = new Map<string, CoverageGroup>();
  const languageDirectories = new Map<string, CoverageGroup>();
  for (const candidate of candidates) {
    const partition = partitions.get(candidate.partitionId);
    if (partition === undefined)
      partitions.set(candidate.partitionId, { count: 1, first: candidate.path });
    else partition.count += 1;
    const languageDirectoryId = `${candidate.language}:${candidate.directory}`;
    const languageDirectory = languageDirectories.get(languageDirectoryId);
    if (languageDirectory === undefined)
      languageDirectories.set(languageDirectoryId, { count: 1, first: candidate.path });
    else languageDirectory.count += 1;
  }
  for (const [id, group] of [...partitions].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const criterionValue: TargetCoverageCriterion = Object.freeze({
      candidateCount: group.count,
      id,
      kind: "scope-partition",
      selectedPath: group.first,
      status: "covered",
    });
    coverage.push(criterionValue);
    select(criterionValue.selectedPath, `scope-partition:${id}`);
  }
  for (const [id, group] of [...languageDirectories].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const criterionValue: TargetCoverageCriterion = Object.freeze({
      candidateCount: group.count,
      id,
      kind: "language-directory",
      selectedPath: group.first,
      status: "covered",
    });
    coverage.push(criterionValue);
    select(criterionValue.selectedPath, `language-directory:${id}`);
  }
  checkDeadline(clock, deadline);
  coverage.sort((left, right) =>
    left.kind < right.kind
      ? -1
      : left.kind > right.kind
        ? 1
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
  );
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  const selected = [...reasons.entries()]
    .sort(([left], [right]) => compareRepositoryRelativePaths(left, right))
    .map(([path, pathReasons]) => {
      const candidate = candidateByPath.get(path);
      return Object.freeze({
        activationPartitionId: candidate?.partitionId ?? null,
        language: candidate?.language ?? null,
        path,
        reasons: Object.freeze([...pathReasons].sort()),
      });
    });
  const unavailable = coverage.some((item) => item.status === "unavailable");
  const state =
    trackingCertainty === "tracked" && workspaceUncertainty === "known" && !unavailable
      ? "complete"
      : "partial";
  const result: TargetSamplingResult = Object.freeze({
    recordKind: "agent-context-target-sampling",
    contractVersion: TARGET_SAMPLER_CONTRACT_VERSION,
    coverage: Object.freeze(coverage),
    limits,
    metrics: Object.freeze({
      activationFactCount,
      criticalPathCount: criticalPaths.length,
      languageDirectoryCount: languageDirectories.size,
      partitionCount: partitions.size,
      sourcePathCount: sources.length,
      trackedPathCount: paths.length,
      workspaceRootCount: workspaces.length,
    }),
    provenance: Object.freeze({
      trackingCertainty,
      trackingReason: normalizedTrackingReason,
      workspaceUncertainty,
      workspaceUncertaintyReasons: Object.freeze(uncertaintyReasons),
    }),
    selected: Object.freeze(selected),
    state,
    strategy,
  });
  ISSUED_TARGET_SAMPLING_RESULTS.add(result);
  return result;
}
