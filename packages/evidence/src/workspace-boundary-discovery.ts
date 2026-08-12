import { performance } from "node:perf_hooks";
import { types as nodeTypes } from "node:util";

import {
  canonicalizeRepositoryRelativePath,
  compareRepositoryRelativePaths,
  REPOSITORY_ROOT,
} from "@agent-context/core";
import type { ConfigurationSourceLocation, RepositoryRelativePath } from "@agent-context/core";

import type { TargetedDiscoveryIndex } from "./discovery-index.js";
import { ReadOnlyRepositoryError, ReadOnlyRepositoryErrorCode } from "./read-only-filesystem.js";
import type { ReadOnlyRepository } from "./read-only-filesystem.js";

export const WORKSPACE_BOUNDARY_CONTRACT_VERSION = "0.1.0" as const;

export type WorkspaceEvidenceFamily =
  | "bazel-build"
  | "bazel-module"
  | "bazel-workspace"
  | "cargo"
  | "go-module"
  | "go-workspace"
  | "javascript-package"
  | "lerna"
  | "nx"
  | "pnpm"
  | "python-project"
  | "python-setup-cfg"
  | "python-setup-py"
  | "rush"
  | "turbo";

export type WorkspaceLanguage = "bazel" | "go" | "javascript" | "python" | "rust";
export type WorkspaceEvidenceState = "complete" | "malformed" | "unavailable" | "unsupported";

export interface WorkspaceBoundaryLimits {
  readonly maximumCandidates: number;
  readonly maximumDepth: number;
  readonly maximumDurationMs: number;
  readonly maximumFileBytes: number;
  readonly maximumIssues: number;
  readonly maximumLineLength: number;
  readonly maximumLines: number;
  readonly maximumManifests: number;
  readonly maximumNodes: number;
  readonly maximumPatternLength: number;
  readonly maximumPatterns: number;
  readonly maximumRecognitionsPerCandidate: number;
  readonly maximumTotalBytes: number;
}

export const WORKSPACE_BOUNDARY_DEFAULT_LIMITS: Readonly<WorkspaceBoundaryLimits> = Object.freeze({
  maximumCandidates: 100_000,
  maximumDepth: 64,
  maximumDurationMs: 30_000,
  maximumFileBytes: 1_048_576,
  maximumIssues: 1_000,
  maximumLineLength: 65_536,
  maximumLines: 100_000,
  maximumManifests: 10_000,
  maximumNodes: 100_000,
  maximumPatternLength: 4_096,
  maximumPatterns: 10_000,
  maximumRecognitionsPerCandidate: 32,
  maximumTotalBytes: 67_108_864,
});

export const WORKSPACE_BOUNDARY_HARD_LIMITS: Readonly<WorkspaceBoundaryLimits> = Object.freeze({
  maximumCandidates: 1_000_000,
  maximumDepth: 256,
  maximumDurationMs: 300_000,
  maximumFileBytes: 16_777_216,
  maximumIssues: 100_000,
  maximumLineLength: 1_048_576,
  maximumLines: 1_000_000,
  maximumManifests: 100_000,
  maximumNodes: 1_000_000,
  maximumPatternLength: 16_384,
  maximumPatterns: 100_000,
  maximumRecognitionsPerCandidate: 256,
  maximumTotalBytes: 536_870_912,
});

export interface WorkspaceBoundaryOptions extends Partial<WorkspaceBoundaryLimits> {
  readonly signal?: AbortSignal;
}

export interface WorkspaceBoundaryClock {
  now(): number;
}

export interface WorkspaceEvidenceIssue {
  readonly code:
    | "duplicate-key"
    | "invalid-member"
    | "invalid-syntax"
    | "invalid-type"
    | "resource-limit"
    | "unsupported-syntax"
    | "unavailable";
  readonly location: ConfigurationSourceLocation;
  readonly message: string;
}

export interface WorkspaceMemberPattern {
  readonly kind: "exclude" | "include";
  readonly location: ConfigurationSourceLocation;
  readonly value: string;
}

export interface WorkspaceEvidenceRecord {
  readonly family: WorkspaceEvidenceFamily;
  readonly ignoredExecutableFields: readonly string[];
  readonly issues: readonly WorkspaceEvidenceIssue[];
  readonly languages: readonly WorkspaceLanguage[];
  readonly location: ConfigurationSourceLocation;
  readonly packageManager: string | null;
  readonly parser: "ini-subset" | "json" | "path-marker" | "toml-subset" | "yaml-subset";
  readonly path: RepositoryRelativePath;
  readonly patterns: readonly WorkspaceMemberPattern[];
  readonly projectName: string | null;
  readonly recognizerId: string;
  readonly root: RepositoryRelativePath;
  readonly state: WorkspaceEvidenceState;
}

export interface WorkspaceBoundary {
  readonly evidencePath: RepositoryRelativePath;
  readonly family: WorkspaceEvidenceFamily;
  readonly kind: "project" | "source" | "workspace";
  readonly languages: readonly WorkspaceLanguage[];
  readonly root: RepositoryRelativePath;
}

export interface WorkspaceBoundaryMetrics {
  readonly boundaryCount: number;
  readonly contentReads: number;
  readonly issueCount: number;
  readonly manifestCount: number;
  readonly patternCount: number;
  readonly totalBytes: number;
}

export interface WorkspaceBoundaryDiscoveryResult {
  readonly boundaries: readonly WorkspaceBoundary[];
  readonly contractVersion: typeof WORKSPACE_BOUNDARY_CONTRACT_VERSION;
  readonly evidence: readonly WorkspaceEvidenceRecord[];
  readonly limits: WorkspaceBoundaryLimits;
  readonly metrics: WorkspaceBoundaryMetrics;
  readonly uncertainty: "known" | "uncertain";
  readonly uncertaintyReasons: readonly string[];
}

export const WorkspaceBoundaryErrorCode: Readonly<{
  aborted: "WORKSPACE_BOUNDARY_ABORTED";
  deadlineExceeded: "WORKSPACE_BOUNDARY_DEADLINE_EXCEEDED";
  invalidInput: "WORKSPACE_BOUNDARY_INVALID_INPUT";
  invalidOptions: "WORKSPACE_BOUNDARY_INVALID_OPTIONS";
  limitExceeded: "WORKSPACE_BOUNDARY_LIMIT_EXCEEDED";
}> = Object.freeze({
  aborted: "WORKSPACE_BOUNDARY_ABORTED",
  deadlineExceeded: "WORKSPACE_BOUNDARY_DEADLINE_EXCEEDED",
  invalidInput: "WORKSPACE_BOUNDARY_INVALID_INPUT",
  invalidOptions: "WORKSPACE_BOUNDARY_INVALID_OPTIONS",
  limitExceeded: "WORKSPACE_BOUNDARY_LIMIT_EXCEEDED",
} as const);

export type WorkspaceBoundaryErrorCode =
  (typeof WorkspaceBoundaryErrorCode)[keyof typeof WorkspaceBoundaryErrorCode];

export class WorkspaceBoundaryError extends Error {
  override readonly name = "WorkspaceBoundaryError" as const;
  readonly code: WorkspaceBoundaryErrorCode;
  readonly operation: string;
  readonly path: RepositoryRelativePath | undefined;

  constructor(
    code: WorkspaceBoundaryErrorCode,
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

interface RecognizerDefinition {
  readonly basenames: readonly string[];
  readonly family: WorkspaceEvidenceFamily;
  readonly languages: readonly WorkspaceLanguage[];
  readonly parser: WorkspaceEvidenceRecord["parser"];
  readonly recognizerId: string;
}

interface ParseOutput {
  readonly ignoredExecutableFields?: readonly string[];
  readonly issues?: readonly DraftIssue[];
  readonly packageManager?: string | null;
  readonly patterns?: readonly DraftPattern[];
  readonly projectName?: string | null;
  readonly state?: WorkspaceEvidenceState;
}

interface DraftIssue {
  readonly code: WorkspaceEvidenceIssue["code"];
  readonly message: string;
  readonly offset?: number;
}

interface DraftPattern {
  readonly kind: WorkspaceMemberPattern["kind"];
  readonly offset: number;
  readonly value: string;
}

interface JsonStringToken {
  readonly offset: number;
  readonly value: string;
}

interface JsonScan {
  readonly issues: readonly DraftIssue[];
  readonly valueStrings: readonly JsonStringToken[];
}

interface Context {
  readonly clock: WorkspaceBoundaryClock;
  readonly deadline: number;
  readonly limits: WorkspaceBoundaryLimits;
  readonly signal?: AbortSignal;
  issueCount: number;
  patternCount: number;
  totalBytes: number;
}

interface SelectedEvidence {
  readonly items: readonly {
    readonly definition: RecognizerDefinition;
    readonly path: RepositoryRelativePath;
  }[];
  readonly upstreamUncertainty: "known" | "uncertain";
}

class DraftIssueList extends Array<DraftIssue> {
  readonly #context: Context;

  constructor(context: Context) {
    super();
    this.#context = context;
  }

  override push(...items: DraftIssue[]): number {
    if (this.#context.issueCount + this.length + items.length > this.#context.limits.maximumIssues)
      fail(WorkspaceBoundaryErrorCode.limitExceeded, "retained issue limit exceeded", "parse");
    return super.push(...items);
  }
}

const DEFAULT_CLOCK: WorkspaceBoundaryClock = Object.freeze({ now: () => performance.now() });
const OPTION_KEYS = new Set([...Object.keys(WORKSPACE_BOUNDARY_HARD_LIMITS), "signal"]);
const ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");

const DEFINITIONS: readonly RecognizerDefinition[] = Object.freeze([
  define("evidence.bazel-build", "bazel-build", ["BUILD", "BUILD.bazel"], ["bazel"], "path-marker"),
  define("evidence.bazel-module", "bazel-module", ["MODULE.bazel"], ["bazel"], "path-marker"),
  define(
    "evidence.bazel-workspace",
    "bazel-workspace",
    ["WORKSPACE", "WORKSPACE.bazel"],
    ["bazel"],
    "path-marker",
  ),
  define("evidence.cargo-manifest", "cargo", ["Cargo.toml"], ["rust"], "toml-subset"),
  define("evidence.go-module", "go-module", ["go.mod"], ["go"], "ini-subset"),
  define("evidence.go-workspace", "go-workspace", ["go.work"], ["go"], "ini-subset"),
  define(
    "evidence.javascript-package",
    "javascript-package",
    ["package.json"],
    ["javascript"],
    "json",
  ),
  define("evidence.lerna", "lerna", ["lerna.json"], ["javascript"], "json"),
  define("evidence.nx", "nx", ["nx.json"], ["javascript"], "json"),
  define("evidence.pnpm-workspace", "pnpm", ["pnpm-workspace.yaml"], ["javascript"], "yaml-subset"),
  define(
    "evidence.python-project",
    "python-project",
    ["pyproject.toml"],
    ["python"],
    "toml-subset",
  ),
  define("evidence.python-setup-cfg", "python-setup-cfg", ["setup.cfg"], ["python"], "ini-subset"),
  define("evidence.python-setup-py", "python-setup-py", ["setup.py"], ["python"], "path-marker"),
  define("evidence.rush", "rush", ["rush.json"], ["javascript"], "json"),
  define("evidence.turbo", "turbo", ["turbo.json"], ["javascript"], "json"),
]);

const DEFINITION_BY_ID = new Map(
  DEFINITIONS.map((definition) => [definition.recognizerId, definition]),
);

function define(
  recognizerId: string,
  family: WorkspaceEvidenceFamily,
  basenames: readonly string[],
  languages: readonly WorkspaceLanguage[],
  parser: WorkspaceEvidenceRecord["parser"],
): RecognizerDefinition {
  return Object.freeze({
    basenames: Object.freeze([...basenames]),
    family,
    languages: Object.freeze([...languages]),
    parser,
    recognizerId,
  });
}

function fail(
  code: WorkspaceBoundaryErrorCode,
  message: string,
  operation: string,
  pathValue?: RepositoryRelativePath,
): never {
  throw new WorkspaceBoundaryError(code, message, operation, pathValue);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !nodeTypes.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      `missing or accessor property ${key}`,
      "validate-input",
    );
  }
  return descriptor.value;
}

function snapshotDataArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (nodeTypes.isProxy(value)) {
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      label + " must be a bounded ordinary array",
      "validate-input",
    );
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      label + " must be a bounded ordinary array",
      "validate-input",
    );
  }
  if (value.length > maximum)
    fail(
      WorkspaceBoundaryErrorCode.limitExceeded,
      label + " exceeds its resource limit",
      "validate-input",
    );
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(
        WorkspaceBoundaryErrorCode.invalidInput,
        label + " must be dense data without accessors",
        "validate-input",
      );
    }
    output.push(descriptor.value);
  }
  return output;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined || ABORTED_DESCRIPTOR?.get === undefined) return false;
  try {
    return ABORTED_DESCRIPTOR.get.call(signal) === true;
  } catch {
    fail(
      WorkspaceBoundaryErrorCode.invalidOptions,
      "signal must be an AbortSignal",
      "validate-options",
    );
  }
}

function checkpoint(context: Context, operation: string, pathValue?: RepositoryRelativePath): void {
  if (isAborted(context.signal)) {
    fail(
      WorkspaceBoundaryErrorCode.aborted,
      "workspace discovery was aborted",
      operation,
      pathValue,
    );
  }
  const now = context.clock.now();
  if (!Number.isFinite(now)) {
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      "clock returned a non-finite value",
      operation,
      pathValue,
    );
  }
  if (now > context.deadline) {
    fail(
      WorkspaceBoundaryErrorCode.deadlineExceeded,
      "workspace discovery deadline exceeded",
      operation,
      pathValue,
    );
  }
}

function snapshotOptions(options: WorkspaceBoundaryOptions | undefined): {
  readonly limits: WorkspaceBoundaryLimits;
  readonly signal?: AbortSignal;
} {
  if (options !== undefined && !isPlainRecord(options)) {
    fail(
      WorkspaceBoundaryErrorCode.invalidOptions,
      "options must be a plain data object",
      "validate-options",
    );
  }
  const input: Record<string, unknown> | undefined = options;
  if (input !== undefined) {
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !OPTION_KEYS.has(key)) {
        fail(
          WorkspaceBoundaryErrorCode.invalidOptions,
          "options contain an unknown property",
          "validate-options",
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        fail(
          WorkspaceBoundaryErrorCode.invalidOptions,
          "options must not contain accessors",
          "validate-options",
        );
      }
    }
  }
  const limits = {} as Record<keyof WorkspaceBoundaryLimits, number>;
  for (const key of Object.keys(
    WORKSPACE_BOUNDARY_HARD_LIMITS,
  ) as (keyof WorkspaceBoundaryLimits)[]) {
    const value =
      input === undefined || !(key in input) ? WORKSPACE_BOUNDARY_DEFAULT_LIMITS[key] : input[key];
    if (
      !Number.isSafeInteger(value) ||
      (value as number) <= 0 ||
      (value as number) > WORKSPACE_BOUNDARY_HARD_LIMITS[key]
    ) {
      fail(
        WorkspaceBoundaryErrorCode.invalidOptions,
        `${key} is outside its supported range`,
        "validate-options",
      );
    }
    limits[key] = value as number;
  }
  const signal = input?.["signal"];
  if (signal !== undefined) isAborted(signal as AbortSignal);
  return {
    limits: Object.freeze(limits),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  };
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

  location(offset: number): ConfigurationSourceLocation {
    const bounded = Math.max(0, Math.min(offset, this.#text.length));
    let low = 0;
    let high = this.#lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.#lineStarts[middle] ?? 0) <= bounded) low = middle;
      else high = middle;
    }
    const position = Object.freeze({
      byteOffset: this.#byteOffsets[bounded] ?? 0,
      line: low,
      utf16Column: bounded - (this.#lineStarts[low] ?? 0),
      utf16Offset: bounded,
    });
    return Object.freeze({
      path: this.#path,
      range: Object.freeze({ start: position, end: position }),
    });
  }

  wholeFile(): ConfigurationSourceLocation {
    const start = this.location(0).range.start;
    const end = this.location(this.#text.length).range.start;
    return Object.freeze({ path: this.#path, range: Object.freeze({ start, end }) });
  }
}

function validateTextBounds(
  text: string,
  context: Context,
  pathValue: RepositoryRelativePath,
): void {
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.length > context.limits.maximumLines) {
    fail(
      WorkspaceBoundaryErrorCode.limitExceeded,
      "manifest line limit exceeded",
      "parse",
      pathValue,
    );
  }
  for (const line of lines) {
    if (line.length > context.limits.maximumLineLength) {
      fail(
        WorkspaceBoundaryErrorCode.limitExceeded,
        "manifest line-length limit exceeded",
        "parse",
        pathValue,
      );
    }
  }
}

function safePattern(value: string, context: Context): boolean {
  if (
    value.length === 0 ||
    value.length > context.limits.maximumPatternLength ||
    value.includes("\\")
  )
    return false;
  if (/^[A-Za-z]:/u.test(value) || value.startsWith("/") || value.includes("\0")) return false;
  return !value.split("/").includes("..");
}

function addPattern(output: DraftPattern[], pattern: DraftPattern, context: Context): void {
  context.patternCount += 1;
  if (context.patternCount > context.limits.maximumPatterns) {
    fail(WorkspaceBoundaryErrorCode.limitExceeded, "workspace pattern limit exceeded", "parse");
  }
  output.push(pattern);
}

function jsonBudget(value: unknown, context: Context): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > context.limits.maximumNodes || depth > context.limits.maximumDepth) {
      fail(WorkspaceBoundaryErrorCode.limitExceeded, "JSON structure limit exceeded", "parse-json");
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else if (isPlainRecord(current)) {
      for (const item of Object.values(current)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function scanJsonDuplicates(text: string, context: Context): JsonScan {
  const issues: DraftIssue[] = new DraftIssueList(context);
  const valueStrings: JsonStringToken[] = [];
  let cursor = 0;
  let nodes = 0;
  const whitespace = (): void => {
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const stringToken = (): { readonly offset: number; readonly value: string } => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") cursor += 2;
      else if (text[cursor] === '"') {
        cursor += 1;
        return { offset: start, value: JSON.parse(text.slice(start, cursor)) as string };
      } else cursor += 1;
    }
    throw new SyntaxError("unterminated JSON string");
  };
  const value = (depth: number): void => {
    whitespace();
    nodes += 1;
    if (nodes > context.limits.maximumNodes || depth > context.limits.maximumDepth) {
      fail(WorkspaceBoundaryErrorCode.limitExceeded, "JSON structure limit exceeded", "parse-json");
    }
    if (text[cursor] === "{") object(depth + 1);
    else if (text[cursor] === "[") array(depth + 1);
    else if (text[cursor] === '"') valueStrings.push(stringToken());
    else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
        text.slice(cursor),
      );
      if (match === null) throw new SyntaxError("invalid JSON value");
      cursor += match[0].length;
    }
  };
  const object = (depth: number): void => {
    cursor += 1;
    whitespace();
    const keys = new Set<string>();
    if (text[cursor] === "}") {
      cursor += 1;
      return;
    }
    for (;;) {
      whitespace();
      if (text[cursor] !== '"') throw new SyntaxError("invalid JSON object key");
      const key = stringToken();
      if (keys.has(key.value))
        issues.push({
          code: "duplicate-key",
          message: `duplicate JSON key ${JSON.stringify(key.value)}`,
          offset: key.offset,
        });
      keys.add(key.value);
      whitespace();
      if (text[cursor] !== ":") throw new SyntaxError("missing JSON colon");
      cursor += 1;
      value(depth);
      whitespace();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ",") throw new SyntaxError("missing JSON comma");
      cursor += 1;
    }
  };
  const array = (depth: number): void => {
    cursor += 1;
    whitespace();
    if (text[cursor] === "]") {
      cursor += 1;
      return;
    }
    for (;;) {
      value(depth);
      whitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      if (text[cursor] !== ",") throw new SyntaxError("missing JSON comma");
      cursor += 1;
    }
  };
  value(0);
  whitespace();
  if (cursor !== text.length) throw new SyntaxError("trailing JSON input");
  return { issues, valueStrings };
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  issues: DraftIssue[],
): string | null {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== "string") {
    issues.push({ code: "invalid-type", message: `${key} must be a string` });
    return null;
  }
  return value;
}

function stringArray(value: unknown, field: string, issues: DraftIssue[]): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    issues.push({ code: "invalid-type", message: `${field} must be an array of strings` });
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function patternsFromStrings(
  values: readonly string[],
  kind: WorkspaceMemberPattern["kind"],
  text: string,
  issues: DraftIssue[],
  context: Context,
  tokens: readonly JsonStringToken[],
): DraftPattern[] {
  const patterns: DraftPattern[] = [];
  let tokenIndex = 0;
  for (const value of values) {
    while (tokenIndex < tokens.length && tokens[tokenIndex]?.value !== value) tokenIndex += 1;
    const token = tokens[tokenIndex];
    const offset = token?.offset ?? Math.max(0, text.indexOf(JSON.stringify(value)));
    tokenIndex += token === undefined ? 0 : 1;
    if (!safePattern(value, context)) {
      issues.push({
        code: "invalid-member",
        message: `unsafe or unsupported workspace member ${JSON.stringify(value)}`,
        offset,
      });
    } else {
      addPattern(patterns, { kind, offset, value }, context);
    }
  }
  return patterns;
}

function parseJson(text: string, family: WorkspaceEvidenceFamily, context: Context): ParseOutput {
  let value: unknown;
  const issues: DraftIssue[] = new DraftIssueList(context);
  let scan: JsonScan;
  try {
    scan = scanJsonDuplicates(text, context);
    issues.push(...scan.issues);
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof WorkspaceBoundaryError) throw error;
    return {
      issues: [{ code: "invalid-syntax", message: "manifest is not strict JSON" }],
      state: "malformed",
    };
  }
  jsonBudget(value, context);
  if (!isPlainRecord(value))
    return {
      issues: [{ code: "invalid-type", message: "manifest root must be an object" }],
      state: "malformed",
    };
  if (issues.some((issue) => issue.code === "duplicate-key")) return { issues, state: "malformed" };

  let projectName: string | null = null;
  let packageManager: string | null = null;
  let includes: readonly string[] = [];
  const ignored: string[] = [];
  if (family === "javascript-package") {
    projectName = stringField(value, "name", issues);
    packageManager = stringField(value, "packageManager", issues);
    const workspaces = value["workspaces"];
    if (Array.isArray(workspaces)) includes = stringArray(workspaces, "workspaces", issues);
    else if (isPlainRecord(workspaces))
      includes = stringArray(workspaces["packages"], "workspaces.packages", issues);
    else if (workspaces !== undefined)
      issues.push({ code: "invalid-type", message: "workspaces must be an array or object" });
    if (value["scripts"] !== undefined) ignored.push("scripts");
  } else if (family === "lerna") {
    includes = stringArray(value["packages"], "packages", issues);
    packageManager = stringField(value, "npmClient", issues);
    if (value["command"] !== undefined) ignored.push("command");
  } else if (family === "rush") {
    const projects = value["projects"];
    if (!Array.isArray(projects))
      issues.push({ code: "invalid-type", message: "projects must be an array" });
    else {
      const folders: string[] = [];
      for (const project of projects) {
        if (!isPlainRecord(project) || typeof project["projectFolder"] !== "string")
          issues.push({
            code: "invalid-type",
            message: "each Rush project needs a string projectFolder",
          });
        else folders.push(project["projectFolder"]);
      }
      includes = folders;
    }
    if (value["eventHooks"] !== undefined) ignored.push("eventHooks");
  } else if (family === "nx") {
    if (value["plugins"] !== undefined) ignored.push("plugins");
    if (value["targetDefaults"] !== undefined) ignored.push("targetDefaults");
  } else if (family === "turbo") {
    if (value["tasks"] !== undefined) ignored.push("tasks");
    if (value["pipeline"] !== undefined) ignored.push("pipeline");
  }
  return {
    ignoredExecutableFields: ignored,
    issues,
    packageManager,
    patterns: patternsFromStrings(includes, "include", text, issues, context, scan.valueStrings),
    projectName,
    state: issues.length === 0 ? "complete" : "malformed",
  };
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && !escaped)
      quote = quote === null ? character : quote === character ? null : quote;
    if (character === "#" && quote === null) return line.slice(0, index);
    escaped = false;
  }
  return line;
}

function parseTomlArray(raw: string): readonly string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const values: string[] = [];
  let cursor = 1;
  while (cursor < trimmed.length - 1) {
    while (/[\s,]/u.test(trimmed[cursor] ?? "")) cursor += 1;
    if (cursor >= trimmed.length - 1) break;
    const quote = trimmed[cursor];
    if (quote !== '"' && quote !== "'") return null;
    const start = cursor;
    cursor += 1;
    while (cursor < trimmed.length && trimmed[cursor] !== quote) {
      if (quote === '"' && trimmed[cursor] === "\\") cursor += 2;
      else cursor += 1;
    }
    if (cursor >= trimmed.length) return null;
    cursor += 1;
    const token = trimmed.slice(start, cursor);
    try {
      values.push(quote === '"' ? (JSON.parse(token) as string) : token.slice(1, -1));
    } catch {
      return null;
    }
    while (/\s/u.test(trimmed[cursor] ?? "")) cursor += 1;
    if (trimmed[cursor] !== "," && cursor !== trimmed.length - 1) return null;
  }
  return values;
}

function parseTomlString(raw: string): string | null {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return null;
    }
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : null;
}

function parseToml(text: string, family: WorkspaceEvidenceFamily, context: Context): ParseOutput {
  const lines = text.split(/\r\n|\r|\n/u);
  const lineOffsets: number[] = [];
  let nextOffset = 0;
  for (const line of lines) {
    lineOffsets.push(nextOffset);
    nextOffset += line.length + 1;
  }
  const issues: DraftIssue[] = new DraftIssueList(context);
  const patterns: DraftPattern[] = [];
  let section = "";
  let projectName: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index] ?? "";
    const line = stripTomlComment(original).trim();
    const lineOffset = lineOffsets[index] ?? 0;
    if (line === "") continue;
    const table = /^\[([^\]]+)\]$/u.exec(line);
    if (table !== null) {
      section = table[1]?.trim() ?? "";
      continue;
    }
    if (line.startsWith("[")) {
      issues.push({
        code: "invalid-syntax",
        message: "malformed TOML table header",
        offset: lineOffset,
      });
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line);
    if (assignment === null) {
      if (/^(?:exclude|members|name)\b/u.test(line))
        issues.push({
          code: "invalid-syntax",
          message: "malformed relevant TOML assignment",
          offset: lineOffset,
        });
      continue;
    }
    const key = assignment[1] ?? "";
    let raw = assignment[2] ?? "";
    if (
      (key === "members" || key === "exclude") &&
      raw.trim().startsWith("[") &&
      !raw.includes("]")
    ) {
      while (++index < lines.length) {
        const next = stripTomlComment(lines[index] ?? "");
        raw += `\n${next}`;
        if (next.includes("]")) break;
      }
    }
    const relevantWorkspace =
      (family === "cargo" && section === "workspace") ||
      (family === "python-project" && section === "tool.uv.workspace");
    if (relevantWorkspace && (key === "members" || key === "exclude")) {
      const values = parseTomlArray(raw);
      if (values === null)
        issues.push({
          code: "unsupported-syntax",
          message: `${section}.${key} must be a bounded string array`,
          offset: lineOffset,
        });
      else {
        for (const value of values) {
          if (!safePattern(value, context))
            issues.push({
              code: "invalid-member",
              message: `unsafe workspace member ${JSON.stringify(value)}`,
              offset: lineOffset,
            });
          else
            addPattern(
              patterns,
              { kind: key === "members" ? "include" : "exclude", offset: lineOffset, value },
              context,
            );
        }
      }
    }
    const nameSection = family === "cargo" ? "package" : "project";
    if (section === nameSection && key === "name") {
      projectName = parseTomlString(raw);
      if (projectName === null)
        issues.push({
          code: "unsupported-syntax",
          message: `${nameSection}.name must be a basic or literal string`,
          offset: lineOffset,
        });
    }
  }
  return {
    issues,
    patterns,
    projectName,
    state:
      issues.length === 0
        ? "complete"
        : issues.some((issue) => issue.code === "invalid-syntax")
          ? "malformed"
          : "unsupported",
  };
}

function parsePnpmYaml(text: string, context: Context): ParseOutput {
  const lines = text.split(/\r\n|\r|\n/u);
  const issues: DraftIssue[] = new DraftIssueList(context);
  const patterns: DraftPattern[] = [];
  let inPackages = false;
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const packages = /^packages\s*:(.*)$/u.exec(trimmed);
    if (packages !== null && line.length === trimmed.length) {
      inPackages = true;
      if ((packages[1] ?? "").trim() !== "")
        issues.push({
          code: "unsupported-syntax",
          message: "packages must use a block sequence",
          offset,
        });
      offset += line.length + 1;
      continue;
    }
    if (inPackages && trimmed !== "" && !trimmed.startsWith("#") && line.length === trimmed.length)
      inPackages = false;
    if (inPackages && trimmed.startsWith("-")) {
      const raw = trimmed.slice(1).trim();
      if (
        raw.startsWith("&") ||
        raw.startsWith("*") ||
        raw.startsWith("{") ||
        raw.startsWith("[") ||
        raw.startsWith("!<")
      )
        issues.push({
          code: "unsupported-syntax",
          message: "YAML tags, aliases, anchors, and flow collections are not supported",
          offset,
        });
      else {
        let value: string;
        if (
          (raw.startsWith('"') && raw.endsWith('"')) ||
          (raw.startsWith("'") && raw.endsWith("'"))
        ) {
          try {
            value = raw.startsWith('"')
              ? (JSON.parse(raw) as string)
              : raw.slice(1, -1).replaceAll("''", "'");
          } catch {
            value = "";
          }
        } else value = raw.replace(/\s+#.*$/u, "").trim();
        const excluded = value.startsWith("!");
        if (excluded) value = value.slice(1);
        if (!safePattern(value, context))
          issues.push({
            code: "invalid-member",
            message: "pnpm package pattern is unsafe or malformed",
            offset,
          });
        else
          addPattern(patterns, { kind: excluded ? "exclude" : "include", offset, value }, context);
      }
    } else if (inPackages && trimmed !== "" && !trimmed.startsWith("#")) {
      issues.push({
        code: "invalid-syntax",
        message: "packages entries must be sequence items",
        offset,
      });
    }
    offset += line.length + 1;
  }
  return {
    issues,
    patterns,
    packageManager: "pnpm",
    state:
      issues.length === 0
        ? "complete"
        : issues.some((issue) => issue.code === "invalid-syntax")
          ? "malformed"
          : "unsupported",
  };
}

function parseGo(text: string, family: WorkspaceEvidenceFamily, context: Context): ParseOutput {
  const issues: DraftIssue[] = new DraftIssueList(context);
  const patterns: DraftPattern[] = [];
  let projectName: string | null = null;
  let inUse = false;
  let offset = 0;
  for (const original of text.split(/\r\n|\r|\n/u)) {
    const line = original.replace(/\/\/.*$/u, "").trim();
    if (family === "go-module" && line.startsWith("module ")) projectName = line.slice(7).trim();
    if (family === "go-workspace") {
      if (line === "use (") inUse = true;
      else if (inUse && line === ")") inUse = false;
      else {
        const candidate = inUse ? line : line.startsWith("use ") ? line.slice(4).trim() : "";
        if (candidate !== "") {
          const value = candidate.split(/\s+/u)[0] ?? "";
          if (!safePattern(value, context))
            issues.push({
              code: "invalid-member",
              message: "Go workspace path is outside the supported in-repository grammar",
              offset,
            });
          else addPattern(patterns, { kind: "include", offset, value }, context);
        }
      }
    }
    offset += original.length + 1;
  }
  if (inUse)
    issues.push({
      code: "invalid-syntax",
      message: "unterminated Go workspace use block",
      offset: text.length,
    });
  return {
    issues,
    patterns,
    projectName,
    state:
      issues.length === 0
        ? "complete"
        : issues.some((issue) => issue.code === "invalid-syntax")
          ? "malformed"
          : "unsupported",
  };
}

function parseSetupCfg(text: string): ParseOutput {
  let section = "";
  let projectName: string | null = null;
  for (const original of text.split(/\r\n|\r|\n/u)) {
    const line = original.trim();
    const table = /^\[([^\]]+)\]$/u.exec(line);
    if (table !== null) section = table[1]?.trim() ?? "";
    else if (section === "metadata") {
      const name = /^name\s*=\s*(.+)$/u.exec(line);
      if (name !== null) projectName = name[1]?.trim() ?? null;
    }
  }
  return { projectName, state: "complete" };
}

function boundaryKind(record: WorkspaceEvidenceRecord): WorkspaceBoundary["kind"] {
  if (record.family === "bazel-build") return "source";
  if (
    [
      "bazel-module",
      "bazel-workspace",
      "go-workspace",
      "lerna",
      "nx",
      "pnpm",
      "rush",
      "turbo",
    ].includes(record.family)
  )
    return "workspace";
  return record.patterns.some((pattern) => pattern.kind === "include") ? "workspace" : "project";
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

function compareText(left: string, right: string): -1 | 0 | 1 {
  return left === right ? 0 : left < right ? -1 : 1;
}

function parseContent(
  text: string,
  definition: RecognizerDefinition,
  context: Context,
): ParseOutput {
  if (definition.parser === "json") return parseJson(text, definition.family, context);
  if (definition.parser === "toml-subset") return parseToml(text, definition.family, context);
  if (definition.family === "pnpm") return parsePnpmYaml(text, context);
  if (definition.family === "go-module" || definition.family === "go-workspace")
    return parseGo(text, definition.family, context);
  return parseSetupCfg(text);
}

function validateCandidatePath(value: unknown): RepositoryRelativePath {
  if (typeof value !== "string")
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      "candidate path must be a string",
      "validate-input",
    );
  let canonical: RepositoryRelativePath;
  try {
    canonical = canonicalizeRepositoryRelativePath(value);
  } catch {
    fail(WorkspaceBoundaryErrorCode.invalidInput, "candidate path is invalid", "validate-input");
  }
  if (canonical !== value)
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      "candidate path is not canonical",
      "validate-input",
    );
  return canonical;
}

function selectEvidence(index: TargetedDiscoveryIndex, context: Context): SelectedEvidence {
  if (!isPlainRecord(index) || ownValue(index, "contractVersion") !== "0.1.0")
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      "discovery index contract is invalid",
      "validate-input",
    );
  const candidates = snapshotDataArray(
    ownValue(index, "candidates"),
    "discovery candidates",
    context.limits.maximumCandidates,
  );
  const uncertainty = ownValue(index, "uncertainty");
  if (uncertainty !== "known" && uncertainty !== "uncertain")
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      "discovery uncertainty is invalid",
      "validate-input",
    );
  const selected = new Map<
    string,
    { readonly definition: RecognizerDefinition; readonly path: RepositoryRelativePath }
  >();
  for (const candidate of candidates) {
    checkpoint(context, "select-evidence");
    if (!isPlainRecord(candidate))
      fail(
        WorkspaceBoundaryErrorCode.invalidInput,
        "candidate must be plain data",
        "validate-input",
      );
    const pathValue = validateCandidatePath(ownValue(candidate, "path"));
    const recognitions = snapshotDataArray(
      ownValue(candidate, "recognitions"),
      "candidate recognitions",
      context.limits.maximumRecognitionsPerCandidate,
    );
    for (const recognition of recognitions) {
      if (!isPlainRecord(recognition))
        fail(
          WorkspaceBoundaryErrorCode.invalidInput,
          "recognition must be plain data",
          "validate-input",
        );
      const id = ownValue(recognition, "recognizerId");
      const definition = typeof id === "string" ? DEFINITION_BY_ID.get(id) : undefined;
      if (definition === undefined) continue;
      if (
        ownValue(recognition, "origin") !== "built-in-catalog" ||
        ownValue(recognition, "kind") !== "evidence" ||
        !definition.basenames.includes(basename(pathValue))
      )
        continue;
      selected.set(`${pathValue}\0${definition.recognizerId}`, { definition, path: pathValue });
      if (selected.size > context.limits.maximumManifests)
        fail(
          WorkspaceBoundaryErrorCode.limitExceeded,
          "manifest count limit exceeded",
          "select-evidence",
        );
    }
  }
  return {
    items: [...selected.values()].sort(
      (left, right) =>
        compareRepositoryRelativePaths(left.path, right.path) ||
        compareText(left.definition.recognizerId, right.definition.recognizerId),
    ),
    upstreamUncertainty: uncertainty,
  };
}

function unavailableOutput(error: ReadOnlyRepositoryError): ParseOutput {
  return {
    issues: [{ code: "unavailable", message: `manifest could not be read safely (${error.code})` }],
    state: "unavailable",
  };
}

/**
 * Parse only C05-selected, built-in manifest evidence through C02. Repository scripts, tools,
 * plugins, Starlark, and Python source are never evaluated or imported.
 */
export async function discoverWorkspaceBoundaries(
  repository: ReadOnlyRepository,
  index: TargetedDiscoveryIndex,
  options?: WorkspaceBoundaryOptions,
): Promise<WorkspaceBoundaryDiscoveryResult> {
  return discoverWorkspaceBoundariesWithClock(repository, index, options, DEFAULT_CLOCK);
}

/** Trusted-clock form used for deterministic cancellation/deadline verification. */
export async function discoverWorkspaceBoundariesWithClock(
  repository: ReadOnlyRepository,
  index: TargetedDiscoveryIndex,
  options: WorkspaceBoundaryOptions | undefined,
  clock: WorkspaceBoundaryClock,
): Promise<WorkspaceBoundaryDiscoveryResult> {
  if (
    nodeTypes.isProxy(repository) ||
    typeof repository.readFile !== "function" ||
    nodeTypes.isProxy(clock) ||
    typeof clock.now !== "function"
  ) {
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      "repository and clock capabilities are invalid",
      "validate-input",
    );
  }
  const snapshot = snapshotOptions(options);
  const started = clock.now();
  if (!Number.isFinite(started))
    fail(
      WorkspaceBoundaryErrorCode.invalidInput,
      "clock returned a non-finite value",
      "validate-input",
    );
  const context: Context = {
    clock,
    deadline: started + snapshot.limits.maximumDurationMs,
    issueCount: 0,
    limits: snapshot.limits,
    patternCount: 0,
    ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
    totalBytes: 0,
  };
  checkpoint(context, "select-evidence");
  const selected = selectEvidence(index, context);
  const records: WorkspaceEvidenceRecord[] = [];
  let contentReads = 0;
  for (const item of selected.items) {
    checkpoint(context, "read-manifest", item.path);
    const root = dirname(item.path);
    let text = "";
    let output: ParseOutput = { state: "complete" };
    if (item.definition.parser === "path-marker") {
      output =
        item.definition.family === "python-setup-py"
          ? {
              issues: [
                {
                  code: "unsupported-syntax",
                  message: "setup.py is executable Python and is intentionally not parsed",
                },
              ],
              state: "unsupported",
            }
          : { state: "complete" };
    } else {
      try {
        const file = await repository.readFile(item.path);
        contentReads += 1;
        if (file.size > context.limits.maximumFileBytes)
          fail(
            WorkspaceBoundaryErrorCode.limitExceeded,
            "manifest byte limit exceeded",
            "read-manifest",
            item.path,
          );
        context.totalBytes += file.size;
        if (context.totalBytes > context.limits.maximumTotalBytes)
          fail(
            WorkspaceBoundaryErrorCode.limitExceeded,
            "total manifest byte limit exceeded",
            "read-manifest",
            item.path,
          );
        let validUtf8 = true;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes());
        } catch {
          validUtf8 = false;
          output = {
            issues: [{ code: "invalid-syntax", message: "manifest is not valid UTF-8" }],
            state: "malformed",
          };
        }
        if (validUtf8) {
          validateTextBounds(text, context, item.path);
          output = parseContent(text, item.definition, context);
        }
      } catch (error: unknown) {
        if (error instanceof WorkspaceBoundaryError) throw error;
        if (error instanceof ReadOnlyRepositoryError) {
          if (error.code === ReadOnlyRepositoryErrorCode.aborted)
            fail(WorkspaceBoundaryErrorCode.aborted, error.message, "read-manifest", item.path);
          if (error.code === ReadOnlyRepositoryErrorCode.deadlineExceeded)
            fail(
              WorkspaceBoundaryErrorCode.deadlineExceeded,
              error.message,
              "read-manifest",
              item.path,
            );
          output = unavailableOutput(error);
        } else throw error;
      }
    }
    const mapper = new SourceMapper(item.path, text);
    const location = mapper.wholeFile();
    const issues = (output.issues ?? []).map((issue) =>
      Object.freeze({
        code: issue.code,
        location: issue.offset === undefined ? location : mapper.location(issue.offset),
        message: issue.message,
      }),
    );
    context.issueCount += issues.length;
    if (context.issueCount > context.limits.maximumIssues)
      fail(
        WorkspaceBoundaryErrorCode.limitExceeded,
        "retained issue limit exceeded",
        "parse",
        item.path,
      );
    const patterns = (output.patterns ?? []).map((pattern) =>
      Object.freeze({
        kind: pattern.kind,
        location: mapper.location(pattern.offset),
        value: pattern.value,
      }),
    );
    records.push(
      deepFreeze({
        family: item.definition.family,
        ignoredExecutableFields: [...(output.ignoredExecutableFields ?? [])].sort(),
        issues,
        languages: [...item.definition.languages],
        location,
        packageManager: output.packageManager ?? null,
        parser: item.definition.parser,
        path: item.path,
        patterns,
        projectName: output.projectName ?? null,
        recognizerId: item.definition.recognizerId,
        root,
        state: output.state ?? "complete",
      }),
    );
  }
  checkpoint(context, "publish");
  const boundaries = records
    .map((record) =>
      deepFreeze({
        evidencePath: record.path,
        family: record.family,
        kind: boundaryKind(record),
        languages: [...record.languages],
        root: record.root,
      }),
    )
    .sort(
      (left, right) =>
        compareRepositoryRelativePaths(left.root, right.root) ||
        compareText(left.kind, right.kind) ||
        compareText(left.family, right.family) ||
        compareRepositoryRelativePaths(left.evidencePath, right.evidencePath),
    );
  const reasons = records
    .filter((record) => record.state !== "complete")
    .map((record) => `${record.path}:${record.state}`)
    .sort();
  if (selected.upstreamUncertainty === "uncertain")
    reasons.push("upstream-discovery-index:uncertain");
  return deepFreeze({
    boundaries,
    contractVersion: WORKSPACE_BOUNDARY_CONTRACT_VERSION,
    evidence: records,
    limits: context.limits,
    metrics: {
      boundaryCount: boundaries.length,
      contentReads,
      issueCount: context.issueCount,
      manifestCount: records.length,
      patternCount: context.patternCount,
      totalBytes: context.totalBytes,
    },
    uncertainty: reasons.length === 0 ? "known" : "uncertain",
    uncertaintyReasons: reasons,
  });
}
