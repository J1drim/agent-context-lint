import { performance } from "node:perf_hooks";
import { types as nodeTypes } from "node:util";

import {
  canonicalizeRepositoryRelativePath,
  compareRepositoryRelativePaths,
  REPOSITORY_ROOT,
} from "@agent-context/core";
import type { ConfigurationSourceLocation, RepositoryRelativePath } from "@agent-context/core";

import { ReadOnlyRepositoryError, ReadOnlyRepositoryErrorCode } from "./read-only-filesystem.js";
import type { ReadOnlyRepository } from "./read-only-filesystem.js";
import type {
  WorkspaceBoundaryDiscoveryResult,
  WorkspaceEvidenceRecord,
} from "./workspace-boundary-discovery.js";

export const EVIDENCE_INDEX_CONTRACT_VERSION = "0.1.0" as const;

export type EvidenceFactCategory =
  | "ci"
  | "lockfile"
  | "manifest"
  | "package-manager"
  | "path"
  | "runtime"
  | "script"
  | "task"
  | "tool";

export type EvidenceFactCertainty = "declared" | "observed-path" | "uncertain";

export interface EvidenceFactProvenance {
  readonly collectorId: string;
  readonly interpretation: "inert-text" | "path-only" | "workspace-evidence";
  readonly sourceState: "complete" | "malformed" | "path-only" | "unavailable" | "unsupported";
}

export interface EvidenceFact {
  readonly category: EvidenceFactCategory;
  readonly certainty: EvidenceFactCertainty;
  readonly id: string;
  readonly location: ConfigurationSourceLocation;
  readonly name: string;
  readonly provenance: EvidenceFactProvenance;
  readonly rawValue: string;
  readonly scope: RepositoryRelativePath;
  readonly value: string;
}

export interface EvidenceConflict {
  readonly category: EvidenceFactCategory;
  readonly factIds: readonly string[];
  readonly name: string;
  readonly scope: RepositoryRelativePath;
  readonly values: readonly string[];
}

export interface EvidenceIndexIssue {
  readonly code:
    "invalid-syntax" | "invalid-type" | "resource-limit" | "unavailable" | "unsupported-syntax";
  readonly location: ConfigurationSourceLocation;
  readonly message: string;
}

export interface EvidenceIndexLimits {
  readonly maximumDepth: number;
  readonly maximumDurationMs: number;
  readonly maximumFacts: number;
  readonly maximumFileBytes: number;
  readonly maximumFiles: number;
  readonly maximumIssues: number;
  readonly maximumLineLength: number;
  readonly maximumLines: number;
  readonly maximumNodes: number;
  readonly maximumPaths: number;
  readonly maximumStringLength: number;
  readonly maximumTotalBytes: number;
}

export const EVIDENCE_INDEX_DEFAULT_LIMITS: Readonly<EvidenceIndexLimits> = Object.freeze({
  maximumDepth: 64,
  maximumDurationMs: 30_000,
  maximumFacts: 250_000,
  maximumFileBytes: 1_048_576,
  maximumFiles: 25_000,
  maximumIssues: 4_096,
  maximumLineLength: 65_536,
  maximumLines: 250_000,
  maximumNodes: 500_000,
  maximumPaths: 200_000,
  maximumStringLength: 65_536,
  maximumTotalBytes: 67_108_864,
});

export const EVIDENCE_INDEX_HARD_LIMITS: Readonly<EvidenceIndexLimits> = Object.freeze({
  maximumDepth: 256,
  maximumDurationMs: 300_000,
  maximumFacts: 1_000_000,
  maximumFileBytes: 16_777_216,
  maximumFiles: 100_000,
  maximumIssues: 100_000,
  maximumLineLength: 1_048_576,
  maximumLines: 1_000_000,
  maximumNodes: 2_000_000,
  maximumPaths: 1_000_000,
  maximumStringLength: 1_048_576,
  maximumTotalBytes: 536_870_912,
});

export interface EvidenceIndexOptions extends Partial<EvidenceIndexLimits> {
  /** Trusted B06 policy; `auto` preserves repository-derived selection evidence. */
  readonly configuredPackageManager?: "auto" | "bun" | "npm" | "pnpm" | "yarn";
  readonly signal?: AbortSignal;
}

export interface EvidenceIndexMetrics {
  readonly conflictCount: number;
  readonly contentReads: number;
  readonly factCount: number;
  readonly issueCount: number;
  readonly pathCount: number;
  readonly totalBytes: number;
}

export interface RepositoryEvidenceIndex {
  readonly conflicts: readonly EvidenceConflict[];
  readonly contractVersion: typeof EVIDENCE_INDEX_CONTRACT_VERSION;
  readonly facts: readonly EvidenceFact[];
  readonly issues: readonly EvidenceIndexIssue[];
  readonly limits: EvidenceIndexLimits;
  readonly metrics: EvidenceIndexMetrics;
  readonly uncertainty: "known" | "uncertain";
  readonly uncertaintyReasons: readonly string[];
}

export const EvidenceIndexErrorCode: Readonly<{
  aborted: "EVIDENCE_INDEX_ABORTED";
  deadlineExceeded: "EVIDENCE_INDEX_DEADLINE_EXCEEDED";
  invalidInput: "EVIDENCE_INDEX_INVALID_INPUT";
  invalidOptions: "EVIDENCE_INDEX_INVALID_OPTIONS";
  limitExceeded: "EVIDENCE_INDEX_LIMIT_EXCEEDED";
}> = Object.freeze({
  aborted: "EVIDENCE_INDEX_ABORTED",
  deadlineExceeded: "EVIDENCE_INDEX_DEADLINE_EXCEEDED",
  invalidInput: "EVIDENCE_INDEX_INVALID_INPUT",
  invalidOptions: "EVIDENCE_INDEX_INVALID_OPTIONS",
  limitExceeded: "EVIDENCE_INDEX_LIMIT_EXCEEDED",
});

export type EvidenceIndexErrorCode =
  (typeof EvidenceIndexErrorCode)[keyof typeof EvidenceIndexErrorCode];

export class EvidenceIndexError extends Error {
  override readonly name = "EvidenceIndexError" as const;
  readonly code: EvidenceIndexErrorCode;
  readonly operation: string;
  readonly path: RepositoryRelativePath | undefined;

  constructor(
    code: EvidenceIndexErrorCode,
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

export interface EvidenceIndexClock {
  now(): number;
}

interface Context {
  readonly clock: EvidenceIndexClock;
  readonly deadline: number;
  readonly limits: EvidenceIndexLimits;
  readonly signal?: AbortSignal;
  contentReads: number;
  nodeCount: number;
  totalBytes: number;
}

interface WorkspaceSnapshot {
  readonly reasons: readonly string[];
  readonly records: readonly WorkspaceEvidenceRecord[];
}

type DraftFact = Omit<EvidenceFact, "id">;

interface TextDocument {
  readonly mapper: SourceMapper;
  readonly path: RepositoryRelativePath;
  readonly text: string;
}

type ReadKind =
  "cargo" | "ci" | "go" | "just" | "make" | "package-json" | "pyproject" | "runtime" | "task-json";

const DEFAULT_CLOCK: EvidenceIndexClock = Object.freeze({ now: () => performance.now() });
const ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
const OPTION_KEYS = new Set([
  ...Object.keys(EVIDENCE_INDEX_HARD_LIMITS),
  "configuredPackageManager",
  "signal",
]);
const CONFIGURED_PACKAGE_MANAGERS = new Set(["auto", "bun", "npm", "pnpm", "yarn"]);
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

const LOCKFILES: Readonly<Record<string, string>> = Object.freeze({
  "Cargo.lock": "cargo",
  "Gemfile.lock": "bundler",
  "Pipfile.lock": "pipenv",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "composer.lock": "composer",
  "go.sum": "go",
  "npm-shrinkwrap.json": "npm",
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "poetry.lock": "poetry",
  "uv.lock": "uv",
  "yarn.lock": "yarn",
});

const TOOL_BASENAMES: Readonly<Record<string, string>> = Object.freeze({
  ".biome.json": "biome",
  ".clang-format": "clang-format",
  ".editorconfig": "editorconfig",
  ".eslintrc": "eslint",
  ".eslintrc.cjs": "eslint",
  ".eslintrc.js": "eslint",
  ".eslintrc.json": "eslint",
  ".eslintrc.mjs": "eslint",
  ".eslintrc.yml": "eslint",
  ".eslintrc.yaml": "eslint",
  ".flake8": "flake8",
  ".golangci.yml": "golangci-lint",
  ".golangci.yaml": "golangci-lint",
  ".pylintrc": "pylint",
  ".prettierrc": "prettier",
  ".prettierrc.cjs": "prettier",
  ".prettierrc.js": "prettier",
  ".prettierrc.json": "prettier",
  ".prettierrc.mjs": "prettier",
  ".prettierrc.yml": "prettier",
  ".prettierrc.yaml": "prettier",
  ".ruff.toml": "ruff",
  ".stylelintrc": "stylelint",
  ".stylelintrc.json": "stylelint",
  "biome.json": "biome",
  "biome.jsonc": "biome",
  "deno.json": "deno",
  "deno.jsonc": "deno",
  "eslint.config.js": "eslint",
  "eslint.config.mjs": "eslint",
  "mypy.ini": "mypy",
  "prettier.config.cjs": "prettier",
  "prettier.config.js": "prettier",
  "prettier.config.mjs": "prettier",
  "ruff.toml": "ruff",
  "rustfmt.toml": "rustfmt",
  "stylelint.config.cjs": "stylelint",
  "stylelint.config.js": "stylelint",
});

const TOOL_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  "@biomejs/biome": "biome",
  "@eslint/js": "eslint",
  "@typescript-eslint/eslint-plugin": "eslint",
  "@typescript-eslint/parser": "eslint",
  eslint: "eslint",
  "eslint-plugin-prettier": "prettier",
  oxlint: "oxlint",
  prettier: "prettier",
  stylelint: "stylelint",
});

function ciProvider(pathValue: RepositoryRelativePath): string | null {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(pathValue)) return "github-actions";
  if (pathValue === ".gitlab-ci.yml" || pathValue === ".gitlab-ci.yaml") return "gitlab-ci";
  if (pathValue === ".circleci/config.yml" || pathValue === ".circleci/config.yaml")
    return "circleci";
  if (pathValue === "azure-pipelines.yml" || pathValue === "azure-pipelines.yaml")
    return "azure-pipelines";
  if (pathValue === ".buildkite/pipeline.yml" || pathValue === ".buildkite/pipeline.yaml")
    return "buildkite";
  if (pathValue === "bitbucket-pipelines.yml" || pathValue === "bitbucket-pipelines.yaml")
    return "bitbucket-pipelines";
  if (basename(pathValue) === "Jenkinsfile") return "jenkins";
  return null;
}

function fail(
  code: EvidenceIndexErrorCode,
  message: string,
  operation: string,
  pathValue?: RepositoryRelativePath,
): never {
  throw new EvidenceIndexError(code, message, operation, pathValue);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !nodeTypes.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function safeMethod(
  value: unknown,
  key: string,
  label: string,
): (...args: readonly unknown[]) => unknown {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    nodeTypes.isProxy(value)
  )
    fail(EvidenceIndexErrorCode.invalidInput, `${label} capability is invalid`, "validate-input");
  let current: object | null = value;
  while (current !== null) {
    if (nodeTypes.isProxy(current))
      fail(EvidenceIndexErrorCode.invalidInput, `${label} capability is invalid`, "validate-input");
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function")
        fail(
          EvidenceIndexErrorCode.invalidInput,
          `${label} capability is invalid`,
          "validate-input",
        );
      return descriptor.value as (...args: readonly unknown[]) => unknown;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  fail(EvidenceIndexErrorCode.invalidInput, `${label} capability is missing`, "validate-input");
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor))
    fail(
      EvidenceIndexErrorCode.invalidInput,
      `missing or accessor property ${key}`,
      "validate-input",
    );
  return descriptor.value;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    fail(
      EvidenceIndexErrorCode.invalidInput,
      `${label} must be an ordinary array`,
      "validate-input",
    );
  if (value.length > maximum)
    fail(
      EvidenceIndexErrorCode.limitExceeded,
      `${label} exceeds its resource limit`,
      "validate-input",
    );
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor))
      fail(EvidenceIndexErrorCode.invalidInput, `${label} must be dense data`, "validate-input");
    output.push(descriptor.value);
  }
  return output;
}

function abortState(value: unknown): boolean | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    ABORTED_DESCRIPTOR?.get === undefined
  )
    return undefined;
  try {
    const state: unknown = ABORTED_DESCRIPTOR.get.call(value);
    return typeof state === "boolean" ? state : undefined;
  } catch {
    return undefined;
  }
}

function snapshotOptions(value: unknown): {
  readonly configuredPackageManager: "auto" | "bun" | "npm" | "pnpm" | "yarn";
  readonly limits: EvidenceIndexLimits;
  readonly signal?: AbortSignal;
} {
  if (value !== undefined && !isPlainRecord(value))
    fail(
      EvidenceIndexErrorCode.invalidOptions,
      "options must be a plain object",
      "validate-options",
    );
  const input = value;
  if (input !== undefined) {
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !OPTION_KEYS.has(key))
        fail(
          EvidenceIndexErrorCode.invalidOptions,
          "options contain an unknown property",
          "validate-options",
        );
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor))
        fail(
          EvidenceIndexErrorCode.invalidOptions,
          "options must not contain accessors",
          "validate-options",
        );
    }
  }
  const limits = {} as Record<keyof EvidenceIndexLimits, number>;
  for (const key of Object.keys(EVIDENCE_INDEX_HARD_LIMITS) as (keyof EvidenceIndexLimits)[]) {
    const candidate = input?.[key] ?? EVIDENCE_INDEX_DEFAULT_LIMITS[key];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) <= 0 ||
      (candidate as number) > EVIDENCE_INDEX_HARD_LIMITS[key]
    )
      fail(
        EvidenceIndexErrorCode.invalidOptions,
        `${key} is outside its supported range`,
        "validate-options",
      );
    limits[key] = candidate as number;
  }
  const signal = input?.["signal"];
  if (signal !== undefined && abortState(signal) === undefined)
    fail(
      EvidenceIndexErrorCode.invalidOptions,
      "signal must be a native AbortSignal",
      "validate-options",
    );
  const configuredPackageManager = input?.["configuredPackageManager"] ?? "auto";
  if (
    typeof configuredPackageManager !== "string" ||
    !CONFIGURED_PACKAGE_MANAGERS.has(configuredPackageManager)
  )
    fail(
      EvidenceIndexErrorCode.invalidOptions,
      "configuredPackageManager is unsupported",
      "validate-options",
    );
  return Object.freeze({
    configuredPackageManager: configuredPackageManager as "auto" | "bun" | "npm" | "pnpm" | "yarn",
    limits: Object.freeze(limits),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  });
}

function checkpoint(context: Context, operation: string, pathValue?: RepositoryRelativePath): void {
  if (context.signal !== undefined && abortState(context.signal))
    fail(EvidenceIndexErrorCode.aborted, "evidence collection was aborted", operation, pathValue);
  let now: number;
  try {
    now = context.clock.now();
  } catch {
    fail(EvidenceIndexErrorCode.invalidInput, "clock failed", operation, pathValue);
  }
  if (!Number.isFinite(now))
    fail(
      EvidenceIndexErrorCode.invalidInput,
      "clock returned a non-finite value",
      operation,
      pathValue,
    );
  if (now > context.deadline)
    fail(
      EvidenceIndexErrorCode.deadlineExceeded,
      "evidence collection deadline exceeded",
      operation,
      pathValue,
    );
}

function basename(pathValue: RepositoryRelativePath): string {
  const slash = pathValue.lastIndexOf("/");
  return slash < 0 ? pathValue : pathValue.slice(slash + 1);
}

function dirname(pathValue: RepositoryRelativePath): RepositoryRelativePath {
  const slash = pathValue.lastIndexOf("/");
  return slash < 0
    ? REPOSITORY_ROOT
    : canonicalizeRepositoryRelativePath(pathValue.slice(0, slash));
}

function unsafeText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
      return true;
  }
  return false;
}

function snapshotPaths(value: unknown, context: Context): readonly RepositoryRelativePath[] {
  const values = denseArray(value, context.limits.maximumPaths, "evidence paths");
  const output: RepositoryRelativePath[] = [];
  let previous: string | undefined;
  for (const item of values) {
    checkpoint(context, "validate-paths");
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > context.limits.maximumStringLength ||
      unsafeText(item)
    )
      fail(EvidenceIndexErrorCode.invalidInput, "evidence path is invalid", "validate-paths");
    let canonical: RepositoryRelativePath;
    try {
      canonical = canonicalizeRepositoryRelativePath(item);
    } catch {
      fail(EvidenceIndexErrorCode.invalidInput, "evidence path is invalid", "validate-paths");
    }
    if (canonical === "." || canonical !== item || (previous !== undefined && previous >= item))
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "evidence paths must be canonical, sorted, and unique",
        "validate-paths",
      );
    output.push(canonical);
    previous = item;
  }
  return Object.freeze(output);
}

function snapshotLocation(
  value: unknown,
  expectedPath: RepositoryRelativePath,
): ConfigurationSourceLocation {
  if (!isPlainRecord(value) || ownValue(value, "path") !== expectedPath)
    fail(
      EvidenceIndexErrorCode.invalidInput,
      "workspace location is malformed",
      "validate-workspace",
    );
  const range = ownValue(value, "range");
  if (!isPlainRecord(range))
    fail(EvidenceIndexErrorCode.invalidInput, "workspace range is malformed", "validate-workspace");
  const snapshotPosition = (input: unknown): ConfigurationSourceLocation["range"]["start"] => {
    if (!isPlainRecord(input))
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "workspace position is malformed",
        "validate-workspace",
      );
    const fields = ["byteOffset", "line", "utf16Column", "utf16Offset"] as const;
    const numbers = fields.map((field) => ownValue(input, field));
    if (numbers.some((number) => !Number.isSafeInteger(number) || (number as number) < 0))
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "workspace position is invalid",
        "validate-workspace",
      );
    return Object.freeze({
      byteOffset: numbers[0] as number,
      line: numbers[1] as number,
      utf16Column: numbers[2] as number,
      utf16Offset: numbers[3] as number,
    });
  };
  const start = snapshotPosition(ownValue(range, "start"));
  const end = snapshotPosition(ownValue(range, "end"));
  if (end.byteOffset < start.byteOffset || end.utf16Offset < start.utf16Offset)
    fail(EvidenceIndexErrorCode.invalidInput, "workspace range is reversed", "validate-workspace");
  return Object.freeze({ path: expectedPath, range: Object.freeze({ start, end }) });
}

function snapshotWorkspace(value: unknown, context: Context): WorkspaceSnapshot {
  if (!isPlainRecord(value) || ownValue(value, "contractVersion") !== "0.1.0")
    fail(
      EvidenceIndexErrorCode.invalidInput,
      "workspace evidence contract is invalid",
      "validate-workspace",
    );
  const records = denseArray(
    ownValue(value, "evidence"),
    context.limits.maximumFiles,
    "workspace evidence",
  );
  const output: WorkspaceEvidenceRecord[] = [];
  for (const item of records) {
    if (!isPlainRecord(item))
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "workspace record must be plain data",
        "validate-workspace",
      );
    const pathValue = ownValue(item, "path");
    const family = ownValue(item, "family");
    const state = ownValue(item, "state");
    const location = ownValue(item, "location");
    const projectName = ownValue(item, "projectName");
    const packageManager = ownValue(item, "packageManager");
    const recognizerId = ownValue(item, "recognizerId");
    const rootValue = ownValue(item, "root");
    if (
      typeof pathValue !== "string" ||
      typeof family !== "string" ||
      typeof state !== "string" ||
      !["complete", "malformed", "unavailable", "unsupported"].includes(state) ||
      !isPlainRecord(location) ||
      (projectName !== null && typeof projectName !== "string") ||
      (packageManager !== null && typeof packageManager !== "string") ||
      typeof recognizerId !== "string" ||
      typeof rootValue !== "string" ||
      [family, recognizerId, projectName, packageManager]
        .filter((item): item is string => typeof item === "string")
        .some((item) => item.length > context.limits.maximumStringLength || unsafeText(item))
    )
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "workspace record is malformed",
        "validate-workspace",
      );
    let canonical: RepositoryRelativePath;
    try {
      canonical = canonicalizeRepositoryRelativePath(pathValue);
    } catch {
      fail(EvidenceIndexErrorCode.invalidInput, "workspace path is invalid", "validate-workspace");
    }
    let root: RepositoryRelativePath;
    try {
      root = canonicalizeRepositoryRelativePath(rootValue);
    } catch {
      fail(EvidenceIndexErrorCode.invalidInput, "workspace root is invalid", "validate-workspace");
    }
    if (canonical !== pathValue || root !== rootValue)
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "workspace location is inconsistent",
        "validate-workspace",
      );
    output.push(
      Object.freeze({
        family,
        ignoredExecutableFields: Object.freeze([]),
        issues: Object.freeze([]),
        languages: Object.freeze([]),
        location: snapshotLocation(location, canonical),
        packageManager,
        parser: "path-marker",
        path: canonical,
        patterns: Object.freeze([]),
        projectName,
        recognizerId,
        root,
        state,
      }) as WorkspaceEvidenceRecord,
    );
  }
  const reasons = denseArray(
    ownValue(value, "uncertaintyReasons"),
    context.limits.maximumIssues,
    "workspace uncertainty reasons",
  );
  const copiedReasons: string[] = [];
  for (const reason of reasons) {
    if (
      typeof reason !== "string" ||
      reason.length > context.limits.maximumStringLength ||
      unsafeText(reason)
    )
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "workspace uncertainty reason is invalid",
        "validate-workspace",
      );
    copiedReasons.push(reason);
  }
  return Object.freeze({
    reasons: Object.freeze(copiedReasons),
    records: Object.freeze(output),
  });
}

class SourceMapper {
  readonly #byteOffsets: Uint32Array;
  readonly #lineStarts: readonly number[];
  readonly #path: RepositoryRelativePath;
  readonly #text: string;

  constructor(pathValue: RepositoryRelativePath, text: string) {
    this.#path = pathValue;
    this.#text = text;
    this.#byteOffsets = new Uint32Array(text.length + 1);
    const lineStarts = [0];
    let bytes = 0;
    for (let offset = 0; offset < text.length;) {
      this.#byteOffsets[offset] = bytes;
      const codePoint = text.codePointAt(offset) ?? 0;
      const width = codePoint > 0xffff ? 2 : 1;
      bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      if (width === 2) this.#byteOffsets[offset + 1] = bytes;
      offset += width;
      this.#byteOffsets[offset] = bytes;
      if (codePoint === 0x0a) lineStarts.push(offset);
      else if (codePoint === 0x0d && text.charCodeAt(offset) !== 0x0a) lineStarts.push(offset);
    }
    this.#byteOffsets[text.length] = bytes;
    this.#lineStarts = lineStarts;
  }

  location(offset: number, length = 0): ConfigurationSourceLocation {
    const position = (input: number): ConfigurationSourceLocation["range"]["start"] => {
      const bounded = Math.max(0, Math.min(input, this.#text.length));
      let low = 0;
      let high = this.#lineStarts.length;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if ((this.#lineStarts[middle] ?? 0) <= bounded) low = middle;
        else high = middle;
      }
      return Object.freeze({
        byteOffset: this.#byteOffsets[bounded] ?? 0,
        line: low,
        utf16Column: bounded - (this.#lineStarts[low] ?? 0),
        utf16Offset: bounded,
      });
    };
    return Object.freeze({
      path: this.#path,
      range: Object.freeze({ start: position(offset), end: position(offset + length) }),
    });
  }

  wholeFile(): ConfigurationSourceLocation {
    return this.location(0, this.#text.length);
  }
}

function pathLocation(pathValue: RepositoryRelativePath): ConfigurationSourceLocation {
  const position = Object.freeze({ byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 });
  return Object.freeze({
    path: pathValue,
    range: Object.freeze({ start: position, end: position }),
  });
}

function provenance(
  collectorId: string,
  interpretation: EvidenceFactProvenance["interpretation"],
  sourceState: EvidenceFactProvenance["sourceState"],
): EvidenceFactProvenance {
  return Object.freeze({ collectorId, interpretation, sourceState });
}

function addFact(facts: DraftFact[], fact: DraftFact, context: Context): void {
  if (
    fact.name.length > context.limits.maximumStringLength ||
    fact.rawValue.length > context.limits.maximumStringLength ||
    fact.value.length > context.limits.maximumStringLength
  )
    fail(
      EvidenceIndexErrorCode.limitExceeded,
      "evidence string limit exceeded",
      "retain-fact",
      fact.location.path,
    );
  if (facts.length >= context.limits.maximumFacts)
    fail(
      EvidenceIndexErrorCode.limitExceeded,
      "evidence fact limit exceeded",
      "retain-fact",
      fact.location.path,
    );
  facts.push(deepFreeze(fact));
}

function addIssue(issues: EvidenceIndexIssue[], issue: EvidenceIndexIssue, context: Context): void {
  if (issues.length >= context.limits.maximumIssues)
    fail(
      EvidenceIndexErrorCode.limitExceeded,
      "evidence issue limit exceeded",
      "retain-issue",
      issue.location.path,
    );
  issues.push(deepFreeze(issue));
}

function validateText(text: string, pathValue: RepositoryRelativePath, context: Context): void {
  let lines = 1;
  let lineLength = 0;
  for (const character of text) {
    lineLength += character.length;
    if (character === "\n") {
      lines += 1;
      lineLength = 0;
    }
    if (lineLength > context.limits.maximumLineLength || lines > context.limits.maximumLines)
      fail(
        EvidenceIndexErrorCode.limitExceeded,
        "evidence text limit exceeded",
        "parse",
        pathValue,
      );
  }
}

async function readText(
  readFile: (pathValue: RepositoryRelativePath) => ReturnType<ReadOnlyRepository["readFile"]>,
  pathValue: RepositoryRelativePath,
  context: Context,
  issues: EvidenceIndexIssue[],
): Promise<TextDocument | null> {
  checkpoint(context, "read-evidence", pathValue);
  try {
    const file: unknown = await readFile(pathValue);
    if (typeof file !== "object" || file === null || nodeTypes.isProxy(file))
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "repository returned an invalid file capability",
        "read-evidence",
        pathValue,
      );
    const sizeDescriptor = Object.getOwnPropertyDescriptor(file, "size");
    if (
      sizeDescriptor === undefined ||
      !("value" in sizeDescriptor) ||
      !Number.isSafeInteger(sizeDescriptor.value) ||
      (sizeDescriptor.value as number) < 0
    )
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "repository returned invalid file metadata",
        "read-evidence",
        pathValue,
      );
    const size = sizeDescriptor.value as number;
    const bytesMethod = safeMethod(file, "bytes", "repository file bytes");
    const bytes: unknown = Reflect.apply(bytesMethod, file, []);
    if (
      nodeTypes.isProxy(bytes) ||
      !(bytes instanceof Uint8Array) ||
      Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
      bytes.byteLength !== size
    )
      fail(
        EvidenceIndexErrorCode.invalidInput,
        "repository returned invalid file bytes",
        "read-evidence",
        pathValue,
      );
    context.contentReads += 1;
    if (
      context.contentReads > context.limits.maximumFiles ||
      size > context.limits.maximumFileBytes ||
      context.totalBytes > context.limits.maximumTotalBytes - size
    )
      fail(
        EvidenceIndexErrorCode.limitExceeded,
        "evidence byte or file limit exceeded",
        "read-evidence",
        pathValue,
      );
    context.totalBytes += size;
    let text: string;
    try {
      text = TEXT_DECODER.decode(bytes);
    } catch {
      addIssue(
        issues,
        {
          code: "invalid-syntax",
          location: pathLocation(pathValue),
          message: "evidence file is not valid UTF-8",
        },
        context,
      );
      return null;
    }
    validateText(text, pathValue, context);
    return Object.freeze({ mapper: new SourceMapper(pathValue, text), path: pathValue, text });
  } catch (error: unknown) {
    if (error instanceof EvidenceIndexError) throw error;
    if (error instanceof ReadOnlyRepositoryError) {
      if (error.code === ReadOnlyRepositoryErrorCode.aborted)
        fail(
          EvidenceIndexErrorCode.aborted,
          "repository read was aborted",
          "read-evidence",
          pathValue,
        );
      if (error.code === ReadOnlyRepositoryErrorCode.deadlineExceeded)
        fail(
          EvidenceIndexErrorCode.deadlineExceeded,
          "repository read deadline exceeded",
          "read-evidence",
          pathValue,
        );
      addIssue(
        issues,
        {
          code: "unavailable",
          location: pathLocation(pathValue),
          message: `evidence file could not be read safely (${error.code})`,
        },
        context,
      );
      return null;
    }
    throw error;
  }
}

function jsonBudget(root: unknown, context: Context, pathValue: RepositoryRelativePath): void {
  const stack: { readonly depth: number; readonly value: unknown }[] = [{ depth: 0, value: root }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    context.nodeCount += 1;
    if (
      context.nodeCount > context.limits.maximumNodes ||
      current.depth > context.limits.maximumDepth
    )
      fail(
        EvidenceIndexErrorCode.limitExceeded,
        "JSON structure limit exceeded",
        "parse-json",
        pathValue,
      );
    if (
      typeof current.value === "string" &&
      current.value.length > context.limits.maximumStringLength
    )
      fail(
        EvidenceIndexErrorCode.limitExceeded,
        "JSON string limit exceeded",
        "parse-json",
        pathValue,
      );
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ depth: current.depth + 1, value: item });
    } else if (isPlainRecord(current.value)) {
      for (const key of Object.keys(current.value)) {
        if (key.length > context.limits.maximumStringLength)
          fail(
            EvidenceIndexErrorCode.limitExceeded,
            "JSON key limit exceeded",
            "parse-json",
            pathValue,
          );
        stack.push({ depth: current.depth + 1, value: current.value[key] });
      }
    }
  }
}

function locateJsonKey(
  document: TextDocument,
  key: string,
  start = 0,
): ConfigurationSourceLocation {
  const encoded = JSON.stringify(key);
  const offset = document.text.indexOf(encoded, start);
  return offset < 0
    ? document.mapper.wholeFile()
    : document.mapper.location(offset, encoded.length);
}

function packageManagerName(value: string): string | null {
  const match = /^(npm|pnpm|yarn|bun)(?:@|$)/u.exec(value.trim());
  return match?.[1] ?? null;
}

function packageScope(pathValue: RepositoryRelativePath): RepositoryRelativePath {
  return dirname(pathValue);
}

function parsePackageJson(
  document: TextDocument,
  facts: DraftFact[],
  issues: EvidenceIndexIssue[],
  context: Context,
): void {
  let value: unknown;
  try {
    value = JSON.parse(document.text) as unknown;
  } catch {
    addIssue(
      issues,
      {
        code: "invalid-syntax",
        location: document.mapper.wholeFile(),
        message: "package manifest is not strict JSON",
      },
      context,
    );
    return;
  }
  jsonBudget(value, context, document.path);
  if (!isPlainRecord(value)) {
    addIssue(
      issues,
      {
        code: "invalid-type",
        location: document.mapper.wholeFile(),
        message: "package manifest root must be an object",
      },
      context,
    );
    return;
  }
  const scope = packageScope(document.path);
  const manager = value["packageManager"];
  if (typeof manager === "string") {
    const normalized = packageManagerName(manager);
    if (normalized === null)
      addIssue(
        issues,
        {
          code: "unsupported-syntax",
          location: locateJsonKey(document, "packageManager"),
          message: "packageManager declaration is not a supported package-manager identity",
        },
        context,
      );
    else
      addFact(
        facts,
        {
          category: "package-manager",
          certainty: "declared",
          location: locateJsonKey(document, "packageManager"),
          name: "selected",
          provenance: provenance("f01.package-json", "inert-text", "complete"),
          rawValue: manager,
          scope,
          value: normalized,
        },
        context,
      );
  } else if (manager !== undefined)
    addIssue(
      issues,
      {
        code: "invalid-type",
        location: locateJsonKey(document, "packageManager"),
        message: "packageManager must be a string",
      },
      context,
    );

  const scripts = value["scripts"];
  if (scripts !== undefined && !isPlainRecord(scripts))
    addIssue(
      issues,
      {
        code: "invalid-type",
        location: locateJsonKey(document, "scripts"),
        message: "package scripts must be an object of strings",
      },
      context,
    );
  else if (isPlainRecord(scripts)) {
    const scriptsOffset = document.text.indexOf(JSON.stringify("scripts"));
    for (const name of Object.keys(scripts).sort()) {
      const command = scripts[name];
      if (typeof command !== "string") {
        addIssue(
          issues,
          {
            code: "invalid-type",
            location: locateJsonKey(document, name, Math.max(0, scriptsOffset)),
            message: `package script ${JSON.stringify(name)} must be a string`,
          },
          context,
        );
        continue;
      }
      addFact(
        facts,
        {
          category: "script",
          certainty: "declared",
          location: locateJsonKey(document, name, Math.max(0, scriptsOffset)),
          name,
          provenance: provenance("f01.package-json", "inert-text", "complete"),
          rawValue: command,
          scope,
          value: command,
        },
        context,
      );
    }
  }

  const engines = value["engines"];
  if (engines !== undefined && !isPlainRecord(engines))
    addIssue(
      issues,
      {
        code: "invalid-type",
        location: locateJsonKey(document, "engines"),
        message: "package engines must be an object of strings",
      },
      context,
    );
  else if (isPlainRecord(engines)) {
    const enginesOffset = document.text.indexOf(JSON.stringify("engines"));
    for (const name of Object.keys(engines).sort()) {
      const constraint = engines[name];
      if (typeof constraint !== "string") {
        addIssue(
          issues,
          {
            code: "invalid-type",
            location: locateJsonKey(document, name, Math.max(0, enginesOffset)),
            message: `runtime constraint ${JSON.stringify(name)} must be a string`,
          },
          context,
        );
        continue;
      }
      addFact(
        facts,
        {
          category: "runtime",
          certainty: "declared",
          location: locateJsonKey(document, name, Math.max(0, enginesOffset)),
          name,
          provenance: provenance("f01.package-json", "inert-text", "complete"),
          rawValue: constraint,
          scope,
          value: constraint.trim(),
        },
        context,
      );
    }
  }

  const devEngines = value["devEngines"];
  if (devEngines !== undefined && !isPlainRecord(devEngines))
    addIssue(
      issues,
      {
        code: "invalid-type",
        location: locateJsonKey(document, "devEngines"),
        message: "package devEngines must be an object",
      },
      context,
    );
  else if (isPlainRecord(devEngines)) {
    const runtimeValues = Array.isArray(devEngines["runtime"])
      ? devEngines["runtime"]
      : [devEngines["runtime"]];
    for (const runtimeValue of runtimeValues) {
      if (!isPlainRecord(runtimeValue)) continue;
      const name = runtimeValue["name"];
      const version = runtimeValue["version"];
      if (typeof name === "string" && typeof version === "string")
        addFact(
          facts,
          {
            category: "runtime",
            certainty: "declared",
            location: locateJsonKey(document, "runtime"),
            name,
            provenance: provenance("f01.package-json", "inert-text", "complete"),
            rawValue: version,
            scope,
            value: version.trim(),
          },
          context,
        );
    }
  }

  const volta = value["volta"];
  if (isPlainRecord(volta) && typeof volta["node"] === "string")
    addFact(
      facts,
      {
        category: "runtime",
        certainty: "declared",
        location: locateJsonKey(document, "node", document.text.indexOf(JSON.stringify("volta"))),
        name: "node",
        provenance: provenance("f01.package-json", "inert-text", "complete"),
        rawValue: volta["node"],
        scope,
        value: volta["node"].trim(),
      },
      context,
    );

  for (const [field, tool] of [
    ["eslintConfig", "eslint"],
    ["prettier", "prettier"],
    ["stylelint", "stylelint"],
  ] as const) {
    if (value[field] === undefined) continue;
    if (!isPlainRecord(value[field])) {
      addIssue(
        issues,
        {
          code: "invalid-type",
          location: locateJsonKey(document, field),
          message: `${field} must be an object when used as embedded tool configuration`,
        },
        context,
      );
      continue;
    }
    addFact(
      facts,
      {
        category: "tool",
        certainty: "declared",
        location: locateJsonKey(document, field),
        name: tool,
        provenance: provenance("f01.package-json", "inert-text", "complete"),
        rawValue: field,
        scope,
        value: "configuration",
      },
      context,
    );
  }

  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const dependencies = value[field];
    if (dependencies === undefined) continue;
    if (!isPlainRecord(dependencies)) {
      addIssue(
        issues,
        {
          code: "invalid-type",
          location: locateJsonKey(document, field),
          message: `${field} must be an object`,
        },
        context,
      );
      continue;
    }
    const fieldOffset = document.text.indexOf(JSON.stringify(field));
    for (const packageName of Object.keys(dependencies).sort()) {
      const tool = TOOL_PACKAGES[packageName];
      if (tool === undefined) continue;
      const version = dependencies[packageName];
      if (typeof version !== "string") {
        addIssue(
          issues,
          {
            code: "invalid-type",
            location: locateJsonKey(document, packageName, Math.max(0, fieldOffset)),
            message: `tool dependency ${JSON.stringify(packageName)} must be a string`,
          },
          context,
        );
        continue;
      }
      addFact(
        facts,
        {
          category: "tool",
          certainty: "declared",
          location: locateJsonKey(document, packageName, Math.max(0, fieldOffset)),
          name: tool,
          provenance: provenance("f01.package-json", "inert-text", "complete"),
          rawValue: `${packageName}@${version}`,
          scope,
          value: "dependency",
        },
        context,
      );
    }
  }
}

function lines(
  document: TextDocument,
): readonly { readonly offset: number; readonly text: string }[] {
  const output: { offset: number; text: string }[] = [];
  let offset = 0;
  const newline = /\r\n|\r|\n/gu;
  for (const match of document.text.matchAll(newline)) {
    output.push({ offset, text: document.text.slice(offset, match.index) });
    offset = match.index + match[0].length;
  }
  output.push({ offset, text: document.text.slice(offset) });
  return output;
}

function addTask(
  document: TextDocument,
  name: string,
  provider: string,
  offset: number,
  facts: DraftFact[],
  context: Context,
  rawValue = name,
): void {
  addFact(
    facts,
    {
      category: "task",
      certainty: "declared",
      location: document.mapper.location(offset, name.length),
      name,
      provenance: provenance(`f01.${provider}`, "inert-text", "complete"),
      rawValue,
      scope: dirname(document.path),
      value: provider,
    },
    context,
  );
}

function parseMake(
  document: TextDocument,
  facts: DraftFact[],
  issues: EvidenceIndexIssue[],
  context: Context,
): void {
  for (const line of lines(document)) {
    if (/^\s/u.test(line.text) || line.text.startsWith("#")) continue;
    const match = /^([^:=#][^:=]*?):(?:\s|$)/u.exec(line.text);
    if (match === null) continue;
    for (const target of (match[1] ?? "").trim().split(/\s+/u)) {
      if (
        target.length === 0 ||
        target.startsWith(".") ||
        target.includes("%") ||
        /[$(){}]/u.test(target)
      )
        continue;
      addTask(document, target, "make", line.offset + line.text.indexOf(target), facts, context);
    }
  }
  if (/\$\(eval\b|\$\(shell\b|^include\s/mu.test(document.text))
    addIssue(
      issues,
      {
        code: "unsupported-syntax",
        location: document.mapper.wholeFile(),
        message: "dynamic Make constructs were retained as uncertainty and not expanded",
      },
      context,
    );
}

function parseJust(
  document: TextDocument,
  facts: DraftFact[],
  issues: EvidenceIndexIssue[],
  context: Context,
): void {
  for (const line of lines(document)) {
    if (/^\s/u.test(line.text) || line.text.startsWith("#") || line.text.startsWith("@")) continue;
    const match = /^([A-Za-z0-9_-]+)(?:\s+[^:]+)?:\s*(.*)$/u.exec(line.text);
    if (match?.[1] !== undefined)
      addTask(document, match[1], "just", line.offset, facts, context, match[2] ?? "");
  }
  if (/^(?:import|mod)\s/mu.test(document.text))
    addIssue(
      issues,
      {
        code: "unsupported-syntax",
        location: document.mapper.wholeFile(),
        message: "Just imports/modules were not followed",
      },
      context,
    );
}

function parseKeyValueDocument(
  document: TextDocument,
  kind: "cargo" | "go" | "pyproject",
  facts: DraftFact[],
  context: Context,
): void {
  let section = "";
  const emittedTools = new Set<string>();
  for (const line of lines(document)) {
    const trimmed = line.text.trim();
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(trimmed);
    if (sectionMatch?.[1] !== undefined) {
      section = sectionMatch[1];
      if (
        kind === "pyproject" &&
        ["tool.black", "tool.mypy", "tool.pyright", "tool.ruff", "tool.ruff.lint"].includes(section)
      ) {
        const tool = section.slice("tool.".length).split(".")[0] ?? section;
        if (!emittedTools.has(tool)) {
          emittedTools.add(tool);
          addFact(
            facts,
            {
              category: "tool",
              certainty: "declared",
              location: document.mapper.location(line.offset, line.text.length),
              name: tool,
              provenance: provenance("f01.pyproject", "inert-text", "complete"),
              rawValue: section,
              scope: dirname(document.path),
              value: "configuration",
            },
            context,
          );
        }
      }
      continue;
    }
    if (kind === "go") {
      const match = /^(go|toolchain)\s+([^\s/]+)$/u.exec(trimmed);
      if (match?.[1] !== undefined && match[2] !== undefined)
        addFact(
          facts,
          {
            category: "runtime",
            certainty: "declared",
            location: document.mapper.location(line.offset, line.text.length),
            name: match[1] === "go" ? "go" : "go-toolchain",
            provenance: provenance("f01.go-mod", "inert-text", "complete"),
            rawValue: match[2],
            scope: dirname(document.path),
            value: match[2],
          },
          context,
        );
      continue;
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(["'])(.*?)\2\s*(?:#.*)?$/u.exec(trimmed);
    if (assignment?.[1] === undefined || assignment[3] === undefined) continue;
    const key = assignment[1];
    const value = assignment[3];
    if (kind === "cargo" && section === "package" && key === "rust-version")
      addFact(
        facts,
        {
          category: "runtime",
          certainty: "declared",
          location: document.mapper.location(line.offset, line.text.length),
          name: "rust",
          provenance: provenance("f01.cargo-toml", "inert-text", "complete"),
          rawValue: value,
          scope: dirname(document.path),
          value,
        },
        context,
      );
    if (kind === "cargo" && section === "alias")
      addTask(document, key, "cargo-alias", line.offset, facts, context, value);
    if (kind === "pyproject" && section === "project" && key === "requires-python")
      addFact(
        facts,
        {
          category: "runtime",
          certainty: "declared",
          location: document.mapper.location(line.offset, line.text.length),
          name: "python",
          provenance: provenance("f01.pyproject", "inert-text", "complete"),
          rawValue: value,
          scope: dirname(document.path),
          value,
        },
        context,
      );
    if (
      kind === "pyproject" &&
      ["tool.poe.tasks", "tool.pdm.scripts", "tool.hatch.envs.default.scripts"].includes(section)
    )
      addTask(document, key, `pyproject:${section}`, line.offset, facts, context, value);
  }
}

function parseRuntimeFile(document: TextDocument, facts: DraftFact[], context: Context): void {
  const base = basename(document.path);
  const values = document.text
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const mapping: Readonly<Record<string, string>> = Object.freeze({
    ".go-version": "go",
    ".java-version": "java",
    ".node-version": "node",
    ".nvmrc": "node",
    ".python-version": "python",
    ".ruby-version": "ruby",
    "rust-toolchain": "rust",
  });
  const runtime = mapping[base];
  if (runtime !== undefined && values[0] !== undefined)
    addFact(
      facts,
      {
        category: "runtime",
        certainty: "declared",
        location: document.mapper.location(document.text.indexOf(values[0]), values[0].length),
        name: runtime,
        provenance: provenance("f01.runtime-file", "inert-text", "complete"),
        rawValue: values[0],
        scope: dirname(document.path),
        value: values[0],
      },
      context,
    );
  if (base === ".tool-versions") {
    for (const line of values) {
      const match = /^(nodejs|python|golang|rust)\s+(.+)$/u.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined)
        addFact(
          facts,
          {
            category: "runtime",
            certainty: "declared",
            location: document.mapper.location(document.text.indexOf(line), line.length),
            name: match[1] === "nodejs" ? "node" : match[1] === "golang" ? "go" : match[1],
            provenance: provenance("f01.tool-versions", "inert-text", "complete"),
            rawValue: match[2],
            scope: dirname(document.path),
            value: match[2],
          },
          context,
        );
    }
  }
  if (base === "rust-toolchain.toml") {
    const match = /^\s*channel\s*=\s*(["'])(.*?)\1/mu.exec(document.text);
    if (match?.[2] !== undefined)
      addFact(
        facts,
        {
          category: "runtime",
          certainty: "declared",
          location: document.mapper.location(match.index, match[0].length),
          name: "rust",
          provenance: provenance("f01.rust-toolchain", "inert-text", "complete"),
          rawValue: match[2],
          scope: dirname(document.path),
          value: match[2],
        },
        context,
      );
  }
}

function parseCi(
  document: TextDocument,
  facts: DraftFact[],
  issues: EvidenceIndexIssue[],
  context: Context,
): void {
  let inJobs = false;
  for (const line of lines(document)) {
    if (/^jobs:\s*(?:#.*)?$/u.test(line.text)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S/u.test(line.text) && !line.text.startsWith("#")) inJobs = false;
    const job = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/u.exec(line.text) : null;
    if (job?.[1] !== undefined)
      addFact(
        facts,
        {
          category: "ci",
          certainty: "declared",
          location: document.mapper.location(line.offset + 2, job[1].length),
          name: job[1],
          provenance: provenance("f01.github-workflow", "inert-text", "complete"),
          rawValue: job[1],
          scope: REPOSITORY_ROOT,
          value: "job",
        },
        context,
      );
    const step = /^\s*-?\s*(run|uses):\s*(.*?)\s*$/u.exec(line.text);
    if (step?.[1] !== undefined && step[2] !== undefined) {
      if (/[>|]\s*$/u.test(step[2])) {
        addIssue(
          issues,
          {
            code: "unsupported-syntax",
            location: document.mapper.location(line.offset, line.text.length),
            message: "multiline CI command is intentionally not expanded",
          },
          context,
        );
      } else {
        addFact(
          facts,
          {
            category: "ci",
            certainty: "declared",
            location: document.mapper.location(line.offset, line.text.length),
            name: step[1],
            provenance: provenance("f01.github-workflow", "inert-text", "complete"),
            rawValue: step[2],
            scope: REPOSITORY_ROOT,
            value: step[2],
          },
          context,
        );
      }
    }
  }
}

function parseTaskJson(
  document: TextDocument,
  facts: DraftFact[],
  issues: EvidenceIndexIssue[],
  context: Context,
): void {
  let value: unknown;
  try {
    value = JSON.parse(document.text) as unknown;
  } catch {
    addIssue(
      issues,
      {
        code: "invalid-syntax",
        location: document.mapper.wholeFile(),
        message: "task manifest is not strict JSON",
      },
      context,
    );
    return;
  }
  jsonBudget(value, context, document.path);
  if (!isPlainRecord(value)) return;
  const base = basename(document.path);
  const field =
    base === "turbo.json" && isPlainRecord(value["tasks"])
      ? "tasks"
      : base === "turbo.json" && isPlainRecord(value["pipeline"])
        ? "pipeline"
        : base === "nx.json" && isPlainRecord(value["targetDefaults"])
          ? "targetDefaults"
          : null;
  if (field === null) return;
  const taskMap = value[field] as Record<string, unknown>;
  const fieldOffset = document.text.indexOf(JSON.stringify(field));
  for (const name of Object.keys(taskMap).sort())
    addTask(
      document,
      name,
      base === "nx.json" ? "nx" : "turbo",
      Math.max(0, document.text.indexOf(JSON.stringify(name), fieldOffset)),
      facts,
      context,
    );
}

function readKind(
  pathValue: RepositoryRelativePath,
  completeManifestPaths: ReadonlySet<string>,
): ReadKind | null {
  const base = basename(pathValue);
  if (base === "package.json" && completeManifestPaths.has(pathValue)) return "package-json";
  if (
    (base === "Cargo.toml" && completeManifestPaths.has(pathValue)) ||
    /(?:^|\/)\.cargo\/config(?:\.toml)?$/u.test(pathValue)
  )
    return "cargo";
  if (base === "pyproject.toml" && completeManifestPaths.has(pathValue)) return "pyproject";
  if (base === "go.mod" && completeManifestPaths.has(pathValue)) return "go";
  if (["Makefile", "makefile", "GNUmakefile"].includes(base)) return "make";
  if (["Justfile", "justfile"].includes(base)) return "just";
  if (
    [
      ".nvmrc",
      ".go-version",
      ".java-version",
      ".node-version",
      ".python-version",
      ".ruby-version",
      ".tool-versions",
      "rust-toolchain",
      "rust-toolchain.toml",
    ].includes(base)
  )
    return "runtime";
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(pathValue)) return "ci";
  if (["nx.json", "turbo.json"].includes(base) && completeManifestPaths.has(pathValue))
    return "task-json";
  return null;
}

function compareFacts(left: DraftFact, right: DraftFact): number {
  return (
    compareRepositoryRelativePaths(left.scope, right.scope) ||
    compareText(left.category, right.category) ||
    compareText(left.name, right.name) ||
    compareText(left.value, right.value) ||
    compareRepositoryRelativePaths(left.location.path, right.location.path) ||
    left.location.range.start.byteOffset - right.location.range.start.byteOffset ||
    compareText(left.rawValue, right.rawValue)
  );
}

function compareText(left: string, right: string): -1 | 0 | 1 {
  return left === right ? 0 : left < right ? -1 : 1;
}

function deepFreeze<T>(value: T): T {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    Object.isFrozen(value)
  )
    return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function buildConflicts(facts: readonly EvidenceFact[]): readonly EvidenceConflict[] {
  const groups = new Map<string, EvidenceFact[]>();
  for (const fact of facts) {
    if (
      fact.category !== "package-manager" &&
      fact.category !== "runtime" &&
      fact.category !== "script" &&
      fact.category !== "task"
    )
      continue;
    const key = `${fact.category}\0${fact.scope}\0${fact.name}`;
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }
  const conflicts: EvidenceConflict[] = [];
  for (const group of groups.values()) {
    const values = [...new Set(group.map((fact) => fact.value))].sort();
    if (values.length < 2) continue;
    const first = group[0];
    if (first === undefined) continue;
    conflicts.push(
      deepFreeze({
        category: first.category,
        factIds: group.map((fact) => fact.id).sort(),
        name: first.name,
        scope: first.scope,
        values,
      }),
    );
  }
  return Object.freeze(
    conflicts.sort(
      (left, right) =>
        compareRepositoryRelativePaths(left.scope, right.scope) ||
        compareText(left.category, right.category) ||
        compareText(left.name, right.name),
    ),
  );
}

/**
 * Build repository facts from a C02 read-only capability, a validated C11 boundary result, and the
 * caller's already-filtered path inventory. Command-shaped values are retained only as inert text.
 */
export async function collectRepositoryEvidence(
  repository: ReadOnlyRepository,
  workspace: WorkspaceBoundaryDiscoveryResult,
  paths: readonly RepositoryRelativePath[],
  options?: EvidenceIndexOptions,
): Promise<RepositoryEvidenceIndex> {
  return collectRepositoryEvidenceWithClock(repository, workspace, paths, options, DEFAULT_CLOCK);
}

/** Trusted-clock entry point for deterministic deadline verification. */
export async function collectRepositoryEvidenceWithClock(
  repository: ReadOnlyRepository,
  workspace: WorkspaceBoundaryDiscoveryResult,
  paths: readonly RepositoryRelativePath[],
  options: EvidenceIndexOptions | undefined,
  clock: EvidenceIndexClock,
): Promise<RepositoryEvidenceIndex> {
  const readFileMethod = safeMethod(repository, "readFile", "repository readFile");
  const nowMethod = safeMethod(clock, "now", "clock");
  const readFile = (
    pathValue: RepositoryRelativePath,
  ): ReturnType<ReadOnlyRepository["readFile"]> =>
    Reflect.apply(readFileMethod, repository, [pathValue]) as ReturnType<
      ReadOnlyRepository["readFile"]
    >;
  const safeClock: EvidenceIndexClock = Object.freeze({
    now: (): number => Reflect.apply(nowMethod, clock, []) as number,
  });
  const snapshot = snapshotOptions(options);
  let started: number;
  try {
    started = safeClock.now();
  } catch {
    fail(EvidenceIndexErrorCode.invalidInput, "clock failed", "validate-input");
  }
  if (!Number.isFinite(started))
    fail(
      EvidenceIndexErrorCode.invalidInput,
      "clock returned a non-finite value",
      "validate-input",
    );
  const context: Context = {
    clock: safeClock,
    contentReads: 0,
    deadline: started + snapshot.limits.maximumDurationMs,
    limits: snapshot.limits,
    nodeCount: 0,
    ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
    totalBytes: 0,
  };
  const inventory = snapshotPaths(paths, context);
  const workspaceSnapshot = snapshotWorkspace(workspace, context);
  const records = workspaceSnapshot.records;
  const facts: DraftFact[] = [];
  const issues: EvidenceIndexIssue[] = [];
  const completeManifestPaths = new Set(
    records.filter((record) => record.state === "complete").map((record) => record.path),
  );

  if (snapshot.configuredPackageManager !== "auto")
    addFact(
      facts,
      {
        category: "package-manager",
        certainty: "declared",
        location: pathLocation(".agent-context-lint.yml" as RepositoryRelativePath),
        name: "selected",
        provenance: provenance("b06.configuration", "inert-text", "complete"),
        rawValue: snapshot.configuredPackageManager,
        scope: REPOSITORY_ROOT,
        value: snapshot.configuredPackageManager,
      },
      context,
    );

  for (const pathValue of inventory) {
    checkpoint(context, "index-path", pathValue);
    addFact(
      facts,
      {
        category: "path",
        certainty: "observed-path",
        location: pathLocation(pathValue),
        name: pathValue,
        provenance: provenance("f01.path-inventory", "path-only", "path-only"),
        rawValue: pathValue,
        scope: dirname(pathValue),
        value: "present",
      },
      context,
    );
    const lockManager = LOCKFILES[basename(pathValue)];
    if (lockManager !== undefined) {
      addFact(
        facts,
        {
          category: "lockfile",
          certainty: "observed-path",
          location: pathLocation(pathValue),
          name: lockManager,
          provenance: provenance("f01.lockfile-catalog", "path-only", "path-only"),
          rawValue: basename(pathValue),
          scope: dirname(pathValue),
          value: "present",
        },
        context,
      );
      addFact(
        facts,
        {
          category: "package-manager",
          certainty: "observed-path",
          location: pathLocation(pathValue),
          name: "selected",
          provenance: provenance("f01.lockfile-catalog", "path-only", "path-only"),
          rawValue: basename(pathValue),
          scope: dirname(pathValue),
          value: lockManager,
        },
        context,
      );
    }
    const tool = TOOL_BASENAMES[basename(pathValue)];
    if (tool !== undefined)
      addFact(
        facts,
        {
          category: "tool",
          certainty: "observed-path",
          location: pathLocation(pathValue),
          name: tool,
          provenance: provenance("f01.tool-config-catalog", "path-only", "path-only"),
          rawValue: pathValue,
          scope: dirname(pathValue),
          value: "configuration",
        },
        context,
      );
    const provider = ciProvider(pathValue);
    if (provider !== null)
      addFact(
        facts,
        {
          category: "ci",
          certainty: "observed-path",
          location: pathLocation(pathValue),
          name: provider,
          provenance: provenance("f01.ci-path-catalog", "path-only", "path-only"),
          rawValue: pathValue,
          scope: REPOSITORY_ROOT,
          value: "configuration",
        },
        context,
      );
  }

  for (const record of records) {
    const rawValue = record.projectName ?? record.family;
    addFact(
      facts,
      {
        category: "manifest",
        certainty: record.state === "complete" ? "declared" : "uncertain",
        location: record.location,
        name: record.family,
        provenance: provenance(record.recognizerId, "workspace-evidence", record.state),
        rawValue,
        scope: record.root,
        value: record.state,
      },
      context,
    );
    if (record.packageManager !== null && record.family !== "javascript-package") {
      const normalized = packageManagerName(record.packageManager) ?? record.packageManager;
      addFact(
        facts,
        {
          category: "package-manager",
          certainty: record.state === "complete" ? "declared" : "uncertain",
          location: record.location,
          name: "selected",
          provenance: provenance(record.recognizerId, "workspace-evidence", record.state),
          rawValue: record.packageManager,
          scope: record.root,
          value: normalized,
        },
        context,
      );
    }
  }

  for (const pathValue of inventory) {
    const kind = readKind(pathValue, completeManifestPaths);
    if (kind === null) continue;
    const document = await readText(readFile, pathValue, context, issues);
    if (document === null) continue;
    if (kind === "package-json") parsePackageJson(document, facts, issues, context);
    else if (kind === "make") parseMake(document, facts, issues, context);
    else if (kind === "just") parseJust(document, facts, issues, context);
    else if (kind === "cargo" || kind === "go" || kind === "pyproject")
      parseKeyValueDocument(document, kind, facts, context);
    else if (kind === "runtime") parseRuntimeFile(document, facts, context);
    else if (kind === "ci") parseCi(document, facts, issues, context);
    else parseTaskJson(document, facts, issues, context);
  }

  checkpoint(context, "publish");
  facts.sort(compareFacts);
  const publishedFacts: EvidenceFact[] = facts.map((fact, index) =>
    deepFreeze({ ...fact, id: `evidence:${String(index + 1).padStart(8, "0")}` }),
  );
  const conflicts = buildConflicts(publishedFacts);
  issues.sort(
    (left, right) =>
      compareRepositoryRelativePaths(left.location.path, right.location.path) ||
      left.location.range.start.byteOffset - right.location.range.start.byteOffset ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
  const reasons = [
    ...new Set([
      ...workspaceSnapshot.reasons,
      ...issues.map((issue) => `${issue.location.path}:${issue.code}`),
    ]),
  ].sort();
  return deepFreeze({
    conflicts,
    contractVersion: EVIDENCE_INDEX_CONTRACT_VERSION,
    facts: publishedFacts,
    issues,
    limits: context.limits,
    metrics: {
      conflictCount: conflicts.length,
      contentReads: context.contentReads,
      factCount: publishedFacts.length,
      issueCount: issues.length,
      pathCount: inventory.length,
      totalBytes: context.totalBytes,
    },
    uncertainty: reasons.length === 0 ? "known" : "uncertain",
    uncertaintyReasons: reasons,
  });
}
