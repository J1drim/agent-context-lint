import { createHash } from "node:crypto";
import { TextDecoder, types as nodeTypes } from "node:util";

import {
  REPOSITORY_ROOT,
  isRepositoryRelativePath,
  type RepositoryRelativePath,
} from "@agent-context/core";
import type { DiscoveryMatcherFact } from "@agent-context/evidence";
import {
  CODEX_CLI_BUILT_IN_PROJECT_INSTRUCTION_NAMES,
  CODEX_CLI_PROFILE,
} from "@agent-context/profiles";
import {
  AGENTS_MARKDOWN_MAX_BYTES,
  AgentsMarkdownError,
  parseAgentsMarkdown,
  type AgentsMarkdownParseResult,
} from "@agent-context/syntax";

export const CODEX_CLI_RESOLVER_CONTRACT_VERSION = "0.1.0" as const;

export interface CodexCliResolverLimits {
  readonly maximumCandidateNames: number;
  readonly maximumEntries: number;
  readonly maximumEntryBytes: number;
  readonly maximumExternalContextBytes: number;
  readonly maximumPathBytes: number;
  readonly maximumPathDepth: number;
  readonly maximumProjectDocBytes: number;
  readonly maximumReasonBytes: number;
  readonly maximumRootMarkerPaths: number;
  readonly maximumRootMarkers: number;
  readonly maximumTotalEntryBytes: number;
  readonly maximumTotalPathBytes: number;
}

export const CODEX_CLI_RESOLVER_LIMITS: Readonly<CodexCliResolverLimits> = Object.freeze({
  maximumCandidateNames: 128,
  maximumEntries: 65_536,
  maximumEntryBytes: 16_777_216,
  maximumExternalContextBytes: 1_048_576,
  maximumPathBytes: 16_384,
  maximumPathDepth: 1_024,
  maximumProjectDocBytes: 16_777_216,
  maximumReasonBytes: 16_384,
  maximumRootMarkerPaths: 65_536,
  maximumRootMarkers: 128,
  maximumTotalEntryBytes: 67_108_864,
  maximumTotalPathBytes: 67_108_864,
});

export type CodexCliRepositoryEntryKind =
  | "broken-symlink"
  | "directory"
  | "external-symlink"
  | "file"
  | "internal-symlink"
  | "unknown"
  | "unreadable-file";

export interface CodexCliRepositoryEntrySnapshot {
  readonly bytes: Uint8Array | null;
  readonly errorCode: string | null;
  readonly kind: CodexCliRepositoryEntryKind;
  readonly path: RepositoryRelativePath;
  readonly resolvedTarget: RepositoryRelativePath | null;
}

export interface CodexCliDiscoverySnapshot {
  readonly certainty: "known" | "uncertain";
  readonly entries: readonly CodexCliRepositoryEntrySnapshot[];
  readonly reason: string;
  readonly rootMarkerPaths: readonly RepositoryRelativePath[];
}

export interface CodexCliEffectiveSettings {
  readonly projectDocFallbackFilenames: readonly string[];
  readonly projectDocMaxBytes: number;
  readonly projectRootMarkers: readonly string[];
}

export type CodexCliExternalContext =
  | { readonly mode: "unavailable" }
  | {
      readonly mode: "supplied";
      readonly globalBase: Uint8Array | null;
      readonly globalOverride: Uint8Array | null;
    };

export interface ResolveCodexCliAgentsInput {
  readonly discovery: CodexCliDiscoverySnapshot;
  readonly externalContext: CodexCliExternalContext;
  readonly launchCwd: RepositoryRelativePath;
  readonly settings: CodexCliEffectiveSettings;
  /** Deliberately independent from launchCwd; it never extends the discovery chain. */
  readonly targetPath: RepositoryRelativePath;
}

export type CodexCliCandidateDecisionState =
  | "missing"
  | "selection-contingent"
  | "selection-unknown"
  | "selected"
  | "shadowed"
  | "skipped-broken-symlink"
  | "skipped-not-file";

export interface CodexCliCandidateDecision {
  readonly candidateIndex: number;
  readonly candidateName: string;
  readonly directory: RepositoryRelativePath;
  readonly entryKind: CodexCliRepositoryEntryKind | null;
  readonly path: RepositoryRelativePath;
  readonly state: CodexCliCandidateDecisionState;
}

export type CodexCliSelectionState =
  | "aggregate-budget-exhausted"
  | "bounded-prefix-empty-after-trim"
  | "content-unavailable-external-symlink"
  | "empty-after-trim"
  | "included"
  | "instruction-read-error"
  | "project-doc-loading-disabled"
  | "selection-unknown";

export interface CodexCliSelectedDocument {
  readonly availableBytes: number | null;
  readonly bytesIncluded: number;
  readonly candidateIndex: number;
  readonly entryKind: CodexCliRepositoryEntryKind;
  readonly path: RepositoryRelativePath;
  readonly resolvedTarget: RepositoryRelativePath | null;
  readonly state: CodexCliSelectionState;
  readonly truncated: boolean;
}

export interface CodexCliContribution {
  readonly bytesIncluded: number;
  readonly path: RepositoryRelativePath;
  readonly syntax: AgentsMarkdownParseResult | null;
  readonly text: string;
  readonly truncated: boolean;
}

export type CodexCliProfileIssueCode =
  | "discovery-uncertain"
  | "external-symlink-target"
  | "filesystem-case-semantics-not-profiled"
  | "instruction-read-error"
  | "selection-kind-unknown"
  | "syntax-resource-limit";

export interface CodexCliProfileIssue {
  readonly code: CodexCliProfileIssueCode;
  readonly path: RepositoryRelativePath | null;
  readonly reason: string;
}

export interface CodexCliRootDecision {
  readonly markerPath: RepositoryRelativePath | null;
  readonly projectRoot: RepositoryRelativePath | null;
  readonly state: "found" | "root-not-found" | "traversal-disabled";
}

export interface CodexCliGlobalContextDecision {
  readonly byteLength: number | null;
  readonly decode: "not-applicable" | "utf8" | "utf8-lossy-replacement";
  readonly sha256: string | null;
  readonly source: "caller-supplied-global-base" | "caller-supplied-global-override" | null;
  readonly state: "base" | "none" | "override" | "unavailable";
  readonly text: string | null;
}

export interface CodexCliDiscoveryDecision {
  readonly certainty: "known" | "uncertain";
  readonly reason: string;
}

export interface CodexCliAgentsResolution {
  readonly analysisStatus: "complete" | "incomplete";
  readonly assembledText: string;
  readonly candidateDecisions: readonly CodexCliCandidateDecision[];
  readonly contractVersion: typeof CODEX_CLI_RESOLVER_CONTRACT_VERSION;
  readonly contributions: readonly CodexCliContribution[];
  readonly discovery: CodexCliDiscoveryDecision;
  readonly effectiveCandidateNames: readonly string[];
  readonly externalContext: CodexCliGlobalContextDecision;
  readonly globDialectId: null;
  readonly issues: readonly CodexCliProfileIssue[];
  readonly launchCwd: RepositoryRelativePath;
  readonly profile: typeof CODEX_CLI_PROFILE;
  readonly projectText: string;
  readonly recordKind: "agent-context-codex-cli-agents-resolution";
  readonly remainingProjectBytes: number;
  readonly root: CodexCliRootDecision;
  readonly searchedDirectories: readonly RepositoryRelativePath[];
  readonly selected: readonly CodexCliSelectedDocument[];
  readonly semanticPrecedence: "root-to-cwd-later-text-winner-unknown";
  readonly settings: CodexCliEffectiveSettings;
  readonly targetPath: RepositoryRelativePath;
}

const ISSUED_CODEX_CLI_RESOLUTIONS = new WeakSet<object>();

/** True only for resolutions produced by this process's D03 resolver. */
export function isIssuedCodexCliAgentsResolution(
  value: unknown,
): value is CodexCliAgentsResolution {
  return typeof value === "object" && value !== null && ISSUED_CODEX_CLI_RESOLUTIONS.has(value);
}

export const CodexCliProfileErrorCode: Readonly<{
  invalidInput: "CODEX_CLI_PROFILE_INVALID_INPUT";
  resourceLimit: "CODEX_CLI_PROFILE_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "CODEX_CLI_PROFILE_INVALID_INPUT",
  resourceLimit: "CODEX_CLI_PROFILE_RESOURCE_LIMIT",
} as const);

export type CodexCliProfileErrorCode =
  (typeof CodexCliProfileErrorCode)[keyof typeof CodexCliProfileErrorCode];

export class CodexCliProfileError extends Error {
  override readonly name = "CodexCliProfileError" as const;
  readonly code: CodexCliProfileErrorCode;

  constructor(code: CodexCliProfileErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface Snapshot {
  readonly discovery: CodexCliDiscoverySnapshot;
  readonly externalContext: CodexCliExternalContext;
  readonly launchCwd: RepositoryRelativePath;
  readonly settings: CodexCliEffectiveSettings;
  readonly targetPath: RepositoryRelativePath;
}

const INPUT_KEYS = Object.freeze([
  "discovery",
  "externalContext",
  "launchCwd",
  "settings",
  "targetPath",
]);
const DISCOVERY_KEYS = Object.freeze(["certainty", "entries", "reason", "rootMarkerPaths"]);
const ENTRY_KEYS = Object.freeze(["bytes", "errorCode", "kind", "path", "resolvedTarget"]);
const SETTINGS_KEYS = Object.freeze([
  "projectDocFallbackFilenames",
  "projectDocMaxBytes",
  "projectRootMarkers",
]);
const ENTRY_KINDS = new Set<CodexCliRepositoryEntryKind>([
  "broken-symlink",
  "directory",
  "external-symlink",
  "file",
  "internal-symlink",
  "unknown",
  "unreadable-file",
]);
const SAFE_FILENAME_SHAPE = /^(?!\.{1,2}$)[^/\\]{1,255}$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function safeFilename(value: string): boolean {
  return (
    SAFE_FILENAME_SHAPE.test(value) &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  );
}

function fail(code: CodexCliProfileErrorCode, message: string): never {
  throw new CodexCliProfileError(code, message);
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function dataProperty(record: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function record(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail(CodexCliProfileErrorCode.invalidInput, `${label} must be a regular data record`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail(CodexCliProfileErrorCode.invalidInput, `${label} must be closed`);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        CodexCliProfileErrorCode.invalidInput,
        `${label} must contain enumerable data properties`,
      );
  }
  return value as DataRecord;
}

function denseArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return fail(CodexCliProfileErrorCode.invalidInput, `${label} must be a regular dense array`);
  if (value.length > maximum)
    return fail(CodexCliProfileErrorCode.resourceLimit, `${label} exceeds its item limit`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1)
    return fail(CodexCliProfileErrorCode.invalidInput, `${label} must not have extra properties`);
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      keys[index] !== key ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return fail(
        CodexCliProfileErrorCode.invalidInput,
        `${label} must use canonical data indices`,
      );
  }
  return value;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || !isRepositoryRelativePath(value))
    return fail(
      CodexCliProfileErrorCode.invalidInput,
      `${label} must be a canonical repository path`,
    );
  if (Buffer.byteLength(value, "utf8") > CODEX_CLI_RESOLVER_LIMITS.maximumPathBytes)
    return fail(CodexCliProfileErrorCode.resourceLimit, `${label} exceeds its byte limit`);
  return value;
}

function copyBytes(value: unknown, maximum: number, label: string): Uint8Array {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  )
    return fail(CodexCliProfileErrorCode.invalidInput, `${label} must be a plain Uint8Array`);
  const bytes = value as Uint8Array;
  const keys = Reflect.ownKeys(bytes);
  if (keys.length !== bytes.length)
    return fail(CodexCliProfileErrorCode.invalidInput, `${label} must not have extra properties`);
  for (let index = 0; index < bytes.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(bytes, key);
    if (
      keys[index] !== key ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return fail(
        CodexCliProfileErrorCode.invalidInput,
        `${label} must use canonical data indices`,
      );
  }
  if (bytes.byteLength > maximum)
    return fail(CodexCliProfileErrorCode.resourceLimit, `${label} exceeds its byte limit`);
  return Uint8Array.prototype.slice.call(bytes);
}

function stringArray(
  value: unknown,
  maximum: number,
  label: string,
  allowEmpty: boolean,
): readonly string[] {
  const values = denseArray(value, maximum, label);
  return Object.freeze(
    values.map((entry) => {
      if (typeof entry !== "string" || (!allowEmpty && entry.length === 0))
        return fail(CodexCliProfileErrorCode.invalidInput, `${label} entries must be text`);
      if (entry.length > 0 && !safeFilename(entry))
        return fail(
          CodexCliProfileErrorCode.invalidInput,
          `${label} entries must be safe single filenames`,
        );
      return entry;
    }),
  );
}

function repositoryPathArray(
  value: unknown,
  maximum: number,
  label: string,
): readonly RepositoryRelativePath[] {
  const values = denseArray(value, maximum, label);
  const paths = values.map((entry, index) => pathValue(entry, `${label}[${String(index)}]`));
  if (new Set(paths).size !== paths.length)
    return fail(CodexCliProfileErrorCode.invalidInput, `${label} must not contain duplicates`);
  return Object.freeze(paths);
}

function entrySnapshot(value: unknown): CodexCliRepositoryEntrySnapshot {
  const input = record(value, ENTRY_KEYS, "Codex repository entry");
  const kind = dataProperty(input, "kind");
  if (typeof kind !== "string" || !ENTRY_KINDS.has(kind as CodexCliRepositoryEntryKind))
    return fail(CodexCliProfileErrorCode.invalidInput, "Codex repository entry kind is invalid");
  const typedKind = kind as CodexCliRepositoryEntryKind;
  const path = pathValue(dataProperty(input, "path"), "Codex repository entry path");
  const bytesValue = dataProperty(input, "bytes");
  const resolvedTargetValue = dataProperty(input, "resolvedTarget");
  const errorCodeValue = dataProperty(input, "errorCode");
  const carriesBytes = typedKind === "file" || typedKind === "internal-symlink";
  if (carriesBytes !== (bytesValue !== null))
    return fail(
      CodexCliProfileErrorCode.invalidInput,
      "Only readable Codex repository entries may carry bytes",
    );
  const bytes = carriesBytes
    ? copyBytes(bytesValue, CODEX_CLI_RESOLVER_LIMITS.maximumEntryBytes, "Codex repository bytes")
    : null;
  const resolvedTarget =
    typedKind === "internal-symlink"
      ? pathValue(resolvedTargetValue, "Codex internal symlink target")
      : null;
  if ((typedKind === "internal-symlink") !== (resolvedTargetValue !== null))
    return fail(
      CodexCliProfileErrorCode.invalidInput,
      "Only internal Codex symlinks may carry a resolved target",
    );
  let errorCode: string | null = null;
  if (typedKind === "unreadable-file") {
    if (typeof errorCodeValue !== "string" || !SAFE_ERROR_CODE.test(errorCodeValue))
      return fail(
        CodexCliProfileErrorCode.invalidInput,
        "Unreadable entries need a safe error code",
      );
    errorCode = errorCodeValue;
  } else if (errorCodeValue !== null)
    return fail(
      CodexCliProfileErrorCode.invalidInput,
      "Readable entries cannot carry an error code",
    );
  return Object.freeze({
    bytes,
    errorCode,
    kind: typedKind,
    path,
    resolvedTarget,
  });
}

function externalContext(value: unknown): CodexCliExternalContext {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value))
    return fail(CodexCliProfileErrorCode.invalidInput, "Codex external context is invalid");
  const mode: unknown = dataProperty(value as DataRecord, "mode");
  if (mode === "unavailable") {
    record(value, ["mode"], "Codex unavailable external context");
    return Object.freeze({ mode });
  }
  if (mode !== "supplied")
    return fail(CodexCliProfileErrorCode.invalidInput, "Codex external context mode is invalid");
  const supplied = record(
    value,
    ["globalBase", "globalOverride", "mode"],
    "Codex supplied external context",
  );
  const baseValue = dataProperty(supplied, "globalBase");
  const overrideValue = dataProperty(supplied, "globalOverride");
  return Object.freeze({
    globalBase:
      baseValue === null
        ? null
        : copyBytes(
            baseValue,
            CODEX_CLI_RESOLVER_LIMITS.maximumExternalContextBytes,
            "Codex global base",
          ),
    globalOverride:
      overrideValue === null
        ? null
        : copyBytes(
            overrideValue,
            CODEX_CLI_RESOLVER_LIMITS.maximumExternalContextBytes,
            "Codex global override",
          ),
    mode,
  });
}

function settings(value: unknown): CodexCliEffectiveSettings {
  const input = record(value, SETTINGS_KEYS, "Codex effective settings");
  const projectDocMaxBytes = dataProperty(input, "projectDocMaxBytes");
  if (
    !Number.isSafeInteger(projectDocMaxBytes) ||
    (projectDocMaxBytes as number) < 0 ||
    (projectDocMaxBytes as number) > CODEX_CLI_RESOLVER_LIMITS.maximumProjectDocBytes
  )
    return fail(
      CodexCliProfileErrorCode.resourceLimit,
      "Codex project document budget is outside the supported safety bound",
    );
  return Object.freeze({
    projectDocFallbackFilenames: stringArray(
      dataProperty(input, "projectDocFallbackFilenames"),
      CODEX_CLI_RESOLVER_LIMITS.maximumCandidateNames,
      "Codex fallback filenames",
      true,
    ),
    projectDocMaxBytes: projectDocMaxBytes as number,
    projectRootMarkers: stringArray(
      dataProperty(input, "projectRootMarkers"),
      CODEX_CLI_RESOLVER_LIMITS.maximumRootMarkers,
      "Codex project root markers",
      false,
    ),
  });
}

function snapshot(value: ResolveCodexCliAgentsInput): Snapshot {
  const input = record(value, INPUT_KEYS, "Codex profile input");
  const discoveryInput = record(
    dataProperty(input, "discovery"),
    DISCOVERY_KEYS,
    "Codex discovery snapshot",
  );
  const certainty = dataProperty(discoveryInput, "certainty");
  const reason = dataProperty(discoveryInput, "reason");
  if ((certainty !== "known" && certainty !== "uncertain") || typeof reason !== "string")
    return fail(CodexCliProfileErrorCode.invalidInput, "Codex discovery certainty is invalid");
  if (Buffer.byteLength(reason, "utf8") > CODEX_CLI_RESOLVER_LIMITS.maximumReasonBytes)
    return fail(CodexCliProfileErrorCode.resourceLimit, "Codex discovery reason exceeds its limit");
  const entryValues = denseArray(
    dataProperty(discoveryInput, "entries"),
    CODEX_CLI_RESOLVER_LIMITS.maximumEntries,
    "Codex repository entries",
  );
  const entries = entryValues
    .map(entrySnapshot)
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    return fail(CodexCliProfileErrorCode.invalidInput, "Codex repository entries must be unique");
  let totalBytes = 0;
  let totalPathBytes = 0;
  for (const entry of entries) {
    totalBytes += entry.bytes?.byteLength ?? 0;
    totalPathBytes += Buffer.byteLength(entry.path, "utf8");
    if (totalBytes > CODEX_CLI_RESOLVER_LIMITS.maximumTotalEntryBytes)
      return fail(
        CodexCliProfileErrorCode.resourceLimit,
        "Codex repository bytes exceed the limit",
      );
    if (totalPathBytes > CODEX_CLI_RESOLVER_LIMITS.maximumTotalPathBytes)
      return fail(
        CodexCliProfileErrorCode.resourceLimit,
        "Codex repository paths exceed the limit",
      );
  }
  const rootMarkerPaths = repositoryPathArray(
    dataProperty(discoveryInput, "rootMarkerPaths"),
    CODEX_CLI_RESOLVER_LIMITS.maximumRootMarkerPaths,
    "Codex root marker paths",
  );
  for (const markerPath of rootMarkerPaths) {
    totalPathBytes += Buffer.byteLength(markerPath, "utf8");
    if (totalPathBytes > CODEX_CLI_RESOLVER_LIMITS.maximumTotalPathBytes)
      return fail(
        CodexCliProfileErrorCode.resourceLimit,
        "Codex repository paths exceed the limit",
      );
  }
  return Object.freeze({
    discovery: Object.freeze({
      certainty,
      entries: Object.freeze(entries),
      reason,
      rootMarkerPaths,
    }),
    externalContext: externalContext(dataProperty(input, "externalContext")),
    launchCwd: pathValue(dataProperty(input, "launchCwd"), "Codex launch CWD"),
    settings: settings(dataProperty(input, "settings")),
    targetPath: pathValue(dataProperty(input, "targetPath"), "Codex target path"),
  });
}

function parentDirectory(path: RepositoryRelativePath): RepositoryRelativePath {
  if (path === REPOSITORY_ROOT) return REPOSITORY_ROOT;
  const slash = path.lastIndexOf("/");
  return (slash < 0 ? REPOSITORY_ROOT : path.slice(0, slash)) as RepositoryRelativePath;
}

function joinPath(directory: RepositoryRelativePath, name: string): RepositoryRelativePath {
  const joined = (
    directory === REPOSITORY_ROOT ? name : `${directory}/${name}`
  ) as RepositoryRelativePath;
  if (Buffer.byteLength(joined, "utf8") > CODEX_CLI_RESOLVER_LIMITS.maximumPathBytes)
    return fail(CodexCliProfileErrorCode.resourceLimit, "Codex candidate path exceeds its limit");
  return joined;
}

function ancestorsFrom(path: RepositoryRelativePath): readonly RepositoryRelativePath[] {
  const ancestors: RepositoryRelativePath[] = [];
  let current = path;
  for (;;) {
    ancestors.push(current);
    if (current === REPOSITORY_ROOT) break;
    current = parentDirectory(current);
    if (ancestors.length > CODEX_CLI_RESOLVER_LIMITS.maximumPathDepth)
      return fail(
        CodexCliProfileErrorCode.resourceLimit,
        "Codex launch CWD exceeds the depth limit",
      );
  }
  return Object.freeze(ancestors);
}

function effectiveCandidateNames(fallbacks: readonly string[]): readonly string[] {
  const names: string[] = [...CODEX_CLI_BUILT_IN_PROJECT_INSTRUCTION_NAMES];
  const seen = new Set(names);
  for (const fallback of fallbacks) {
    if (fallback.length === 0 || seen.has(fallback)) continue;
    seen.add(fallback);
    names.push(fallback);
  }
  return Object.freeze(names);
}

function rootDecision(input: Snapshot): {
  readonly root: CodexCliRootDecision;
  readonly directories: readonly RepositoryRelativePath[];
} {
  if (input.settings.projectRootMarkers.length === 0)
    return Object.freeze({
      directories: Object.freeze([input.launchCwd]),
      root: Object.freeze({ markerPath: null, projectRoot: null, state: "traversal-disabled" }),
    });
  const markerPaths = new Set(input.discovery.rootMarkerPaths);
  const ancestors = ancestorsFrom(input.launchCwd);
  for (const directory of ancestors) {
    for (const marker of input.settings.projectRootMarkers) {
      const markerPath = joinPath(directory, marker);
      if (!markerPaths.has(markerPath)) continue;
      const rootIndex = ancestors.indexOf(directory);
      return Object.freeze({
        directories: Object.freeze(ancestors.slice(0, rootIndex + 1).reverse()),
        root: Object.freeze({ markerPath, projectRoot: directory, state: "found" }),
      });
    }
  }
  return Object.freeze({
    directories: Object.freeze([input.launchCwd]),
    root: Object.freeze({ markerPath: null, projectRoot: null, state: "root-not-found" }),
  });
}

function issue(
  code: CodexCliProfileIssueCode,
  reason: string,
  path: RepositoryRelativePath | null = null,
): CodexCliProfileIssue {
  return Object.freeze({ code, path, reason });
}

function safeDecode(bytes: Uint8Array): {
  readonly decode: "utf8" | "utf8-lossy-replacement";
  readonly text: string;
} {
  const text = Buffer.from(bytes).toString("utf8");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Object.freeze({ decode: "utf8", text });
  } catch {
    return Object.freeze({ decode: "utf8-lossy-replacement", text });
  }
}

function globalContextDecision(context: CodexCliExternalContext): CodexCliGlobalContextDecision {
  if (context.mode === "unavailable")
    return Object.freeze({
      byteLength: null,
      decode: "not-applicable",
      sha256: null,
      source: null,
      state: "unavailable",
      text: null,
    });
  for (const [state, bytes] of [
    ["override", context.globalOverride],
    ["base", context.globalBase],
  ] as const) {
    if (bytes === null) continue;
    const decoded = safeDecode(bytes);
    if (decoded.text.trim().length === 0) continue;
    return Object.freeze({
      byteLength: bytes.byteLength,
      decode: decoded.decode,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source:
        state === "override" ? "caller-supplied-global-override" : "caller-supplied-global-base",
      state,
      text: decoded.text,
    });
  }
  return Object.freeze({
    byteLength: null,
    decode: "not-applicable",
    sha256: null,
    source: null,
    state: "none",
    text: null,
  });
}

function syntaxForContribution(
  path: RepositoryRelativePath,
  bytes: Uint8Array,
  truncated: boolean,
  issues: CodexCliProfileIssue[],
): AgentsMarkdownParseResult | null {
  if (bytes.byteLength > AGENTS_MARKDOWN_MAX_BYTES) {
    issues.push(
      issue(
        "syntax-resource-limit",
        "The model-visible AGENTS prefix exceeds the bounded Markdown syntax parser limit.",
        path,
      ),
    );
    return null;
  }
  try {
    return parseAgentsMarkdown({
      bytes,
      contentStatus: truncated ? "truncated" : "complete",
      path,
      scopeRoot: parentDirectory(path),
    });
  } catch (error) {
    if (error instanceof AgentsMarkdownError) {
      issues.push(
        issue(
          "syntax-resource-limit",
          "The bounded AGENTS syntax adapter could not represent the selected source prefix.",
          path,
        ),
      );
      return null;
    }
    throw error;
  }
}

function selectedStateWithoutBytes(kind: CodexCliRepositoryEntryKind): CodexCliSelectionState {
  if (kind === "external-symlink") return "content-unavailable-external-symlink";
  if (kind === "unreadable-file") return "instruction-read-error";
  return "selection-unknown";
}

/**
 * Creates the C05 recognizers required for configured Codex fallback filenames. Built-in AGENTS
 * names remain owned by C05's fixed catalog, so only effective additional names are returned.
 */
export function createCodexCliFallbackDiscoveryMatcherFacts(
  fallbackFilenames: readonly string[],
): readonly DiscoveryMatcherFact[] {
  const names = effectiveCandidateNames(
    stringArray(
      fallbackFilenames,
      CODEX_CLI_RESOLVER_LIMITS.maximumCandidateNames,
      "Codex fallback filenames",
      true,
    ),
  ).slice(CODEX_CLI_BUILT_IN_PROJECT_INSTRUCTION_NAMES.length);
  return Object.freeze(
    names.map((name, index): DiscoveryMatcherFact => {
      const identity = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 16);
      return Object.freeze({
        applicability: "known-active",
        candidateKind: "instruction",
        clientVersion: CODEX_CLI_PROFILE.clientVersion,
        evidence: "source-derived",
        factId: `codex-cli.project-doc-fallback.${identity}`,
        formatId: "agents-markdown",
        matcher: Object.freeze({ kind: "basename", value: name }),
        profileId: CODEX_CLI_PROFILE.profileId,
        reason: null,
        recognizerId: `instruction.codex-fallback.${index.toString(36)}.${identity}`,
        retrievedAt: CODEX_CLI_PROFILE.retrievedAt,
        sourceUrl:
          "https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/agents_md.rs",
      });
    }),
  );
}

/** Resolves the pinned single-CWD Codex CLI AGENTS chain from an authorized, data-only snapshot. */
export function resolveCodexCliAgents(
  inputValue: ResolveCodexCliAgentsInput,
): CodexCliAgentsResolution {
  const input = snapshot(inputValue);
  const candidates = effectiveCandidateNames(input.settings.projectDocFallbackFilenames);
  const rootResult = rootDecision(input);
  const entryByPath = new Map(input.discovery.entries.map((entry) => [entry.path, entry]));
  const candidateDecisions: CodexCliCandidateDecision[] = [];
  const selectedEntries: {
    readonly entry: CodexCliRepositoryEntrySnapshot;
    readonly index: number;
  }[] = [];
  const issues: CodexCliProfileIssue[] = [];
  if (input.discovery.certainty === "uncertain")
    issues.push(
      issue(
        "discovery-uncertain",
        "The upstream discovery inventory is incomplete, so profile selection is incomplete.",
      ),
    );

  for (const directory of rootResult.directories) {
    let selection: "none" | "selected" | "unknown" = "none";
    for (const [candidateIndex, candidateName] of candidates.entries()) {
      const path = joinPath(directory, candidateName);
      const entry = entryByPath.get(path);
      if (selection !== "none") {
        if (entry !== undefined)
          candidateDecisions.push(
            Object.freeze({
              candidateIndex,
              candidateName,
              directory,
              entryKind: entry.kind,
              path,
              state: selection === "selected" ? "shadowed" : "selection-contingent",
            }),
          );
        continue;
      }
      if (entry === undefined) {
        candidateDecisions.push(
          Object.freeze({
            candidateIndex,
            candidateName,
            directory,
            entryKind: null,
            path,
            state: "missing",
          }),
        );
        continue;
      }
      if (entry.kind === "directory") {
        candidateDecisions.push(
          Object.freeze({
            candidateIndex,
            candidateName,
            directory,
            entryKind: entry.kind,
            path,
            state: "skipped-not-file",
          }),
        );
        continue;
      }
      if (entry.kind === "broken-symlink") {
        candidateDecisions.push(
          Object.freeze({
            candidateIndex,
            candidateName,
            directory,
            entryKind: entry.kind,
            path,
            state: "skipped-broken-symlink",
          }),
        );
        continue;
      }
      selection = entry.kind === "unknown" ? "unknown" : "selected";
      selectedEntries.push(Object.freeze({ entry, index: candidateIndex }));
      candidateDecisions.push(
        Object.freeze({
          candidateIndex,
          candidateName,
          directory,
          entryKind: entry.kind,
          path,
          state: entry.kind === "unknown" ? "selection-unknown" : "selected",
        }),
      );
    }
  }

  for (const entry of input.discovery.entries) {
    const basename = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    if (
      candidates.some(
        (candidate) => candidate !== basename && candidate.toLowerCase() === basename.toLowerCase(),
      )
    )
      issues.push(
        issue(
          "filesystem-case-semantics-not-profiled",
          "A case-variant instruction filename has no portable Codex selection result.",
          entry.path,
        ),
      );
  }

  const selectedDocuments: CodexCliSelectedDocument[] = [];
  const contributions: CodexCliContribution[] = [];
  let remaining = input.settings.projectDocMaxBytes;
  for (const selected of selectedEntries) {
    const entry = selected.entry;
    if (entry.bytes === null) {
      const state = selectedStateWithoutBytes(entry.kind);
      selectedDocuments.push(
        Object.freeze({
          availableBytes: null,
          bytesIncluded: 0,
          candidateIndex: selected.index,
          entryKind: entry.kind,
          path: entry.path,
          resolvedTarget: entry.resolvedTarget,
          state,
          truncated: false,
        }),
      );
      if (entry.kind === "external-symlink")
        issues.push(
          issue(
            "external-symlink-target",
            "Codex may read this selected link, but the linter never follows it outside the repository.",
            entry.path,
          ),
        );
      else if (entry.kind === "unreadable-file")
        issues.push(
          issue(
            "instruction-read-error",
            "The selected Codex instruction file could not be read through the safe facade.",
            entry.path,
          ),
        );
      else
        issues.push(
          issue(
            "selection-kind-unknown",
            "The selected candidate type is not portable enough for a deterministic content result.",
            entry.path,
          ),
        );
      continue;
    }
    const completeText = safeDecode(entry.bytes).text;
    if (completeText.trim().length === 0) {
      selectedDocuments.push(
        Object.freeze({
          availableBytes: entry.bytes.byteLength,
          bytesIncluded: 0,
          candidateIndex: selected.index,
          entryKind: entry.kind,
          path: entry.path,
          resolvedTarget: entry.resolvedTarget,
          state: "empty-after-trim",
          truncated: false,
        }),
      );
      continue;
    }
    if (remaining === 0) {
      selectedDocuments.push(
        Object.freeze({
          availableBytes: entry.bytes.byteLength,
          bytesIncluded: 0,
          candidateIndex: selected.index,
          entryKind: entry.kind,
          path: entry.path,
          resolvedTarget: entry.resolvedTarget,
          state:
            input.settings.projectDocMaxBytes === 0
              ? "project-doc-loading-disabled"
              : "aggregate-budget-exhausted",
          truncated: false,
        }),
      );
      continue;
    }
    const bytesIncluded = Math.min(remaining, entry.bytes.byteLength);
    const visibleBytes = Uint8Array.prototype.slice.call(
      entry.bytes,
      0,
      bytesIncluded,
    ) as Uint8Array;
    const truncated = bytesIncluded < entry.bytes.byteLength;
    const text = safeDecode(visibleBytes).text;
    if (text.trim().length === 0) {
      selectedDocuments.push(
        Object.freeze({
          availableBytes: entry.bytes.byteLength,
          bytesIncluded: 0,
          candidateIndex: selected.index,
          entryKind: entry.kind,
          path: entry.path,
          resolvedTarget: entry.resolvedTarget,
          state: "bounded-prefix-empty-after-trim",
          truncated,
        }),
      );
      continue;
    }
    remaining -= bytesIncluded;
    selectedDocuments.push(
      Object.freeze({
        availableBytes: entry.bytes.byteLength,
        bytesIncluded,
        candidateIndex: selected.index,
        entryKind: entry.kind,
        path: entry.path,
        resolvedTarget: entry.resolvedTarget,
        state: "included",
        truncated,
      }),
    );
    contributions.push(
      Object.freeze({
        bytesIncluded,
        path: entry.path,
        syntax: syntaxForContribution(entry.path, visibleBytes, truncated, issues),
        text,
        truncated,
      }),
    );
  }

  const projectText = contributions.map((contribution) => contribution.text).join("\n\n");
  const globalContext = globalContextDecision(input.externalContext);
  const assembledText =
    globalContext.text !== null && projectText.length > 0
      ? `${globalContext.text}\n\n--- project-doc ---\n\n${projectText}`
      : (globalContext.text ?? projectText);
  const result: CodexCliAgentsResolution = Object.freeze({
    analysisStatus: issues.length === 0 ? "complete" : "incomplete",
    assembledText,
    candidateDecisions: Object.freeze(candidateDecisions),
    contractVersion: CODEX_CLI_RESOLVER_CONTRACT_VERSION,
    contributions: Object.freeze(contributions),
    discovery: Object.freeze({
      certainty: input.discovery.certainty,
      reason: input.discovery.reason,
    }),
    effectiveCandidateNames: candidates,
    externalContext: globalContext,
    globDialectId: CODEX_CLI_PROFILE.globDialectId,
    issues: Object.freeze(issues),
    launchCwd: input.launchCwd,
    profile: CODEX_CLI_PROFILE,
    projectText,
    recordKind: "agent-context-codex-cli-agents-resolution",
    remainingProjectBytes: remaining,
    root: rootResult.root,
    searchedDirectories: rootResult.directories,
    selected: Object.freeze(selectedDocuments),
    semanticPrecedence: "root-to-cwd-later-text-winner-unknown",
    settings: input.settings,
    targetPath: input.targetPath,
  });
  ISSUED_CODEX_CLI_RESOLUTIONS.add(result);
  return result;
}
