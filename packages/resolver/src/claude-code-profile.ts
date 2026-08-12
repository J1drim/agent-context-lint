import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  REPOSITORY_ROOT,
  isRepositoryRelativePath,
  type ActivationRuleId,
  type InstructionDocumentId,
  type RepositoryRelativePath,
  type SourceDocumentId,
} from "@agent-context/core";
import type { ImportGraphResult } from "@agent-context/evidence";
import { CLAUDE_CODE_PROFILE } from "@agent-context/profiles";
import {
  parseClaudeInstructionSyntax,
  type ClaudeInstructionFormat,
  type ClaudeInstructionSyntaxResult,
} from "@agent-context/syntax";

import { buildDocumentImportDag, type ImportDagOccurrence } from "./document-import-dag.js";
import { matchProfileGlob } from "./profile-glob-dialects.js";
import { createSyntheticTargetTrace } from "./resolution-event-trace.js";

export const CLAUDE_CODE_PROFILE_RESOLVER_CONTRACT_VERSION = "0.1.0" as const;

export const CLAUDE_CODE_PROFILE_LIMITS: Readonly<{
  maximumCandidates: number;
  maximumCandidateBytes: number;
  maximumEvents: number;
  maximumExclusions: number;
  maximumPathBytes: number;
  maximumPatterns: number;
  maximumTotalBytes: number;
  maximumTotalPathBytes: number;
}> = Object.freeze({
  maximumCandidates: 4_096,
  maximumCandidateBytes: 262_144,
  maximumEvents: 4_096,
  maximumExclusions: 4_096,
  maximumPathBytes: 16_384,
  maximumPatterns: 1_000,
  maximumTotalBytes: 16_777_216,
  maximumTotalPathBytes: 16_777_216,
} as const);

export type ClaudeCandidateKind =
  "memory-alternate" | "memory-local" | "memory-shared" | "project-rule";
export type ClaudeCandidateOrigin = "additional-directory" | "repository";
export type ClaudeSymlinkState = "external" | "internal" | "none" | "unknown";

export interface ClaudeInstructionCandidateSnapshot {
  readonly absolutePath: string | null;
  readonly bytes: Uint8Array;
  readonly importGraph: ImportGraphResult | null;
  readonly kind: ClaudeCandidateKind;
  readonly origin: ClaudeCandidateOrigin;
  readonly path: RepositoryRelativePath;
  readonly scopeRoot: RepositoryRelativePath;
  readonly symlinkState: ClaudeSymlinkState;
}

export type ClaudeRuntimeEvent =
  | { readonly id: string; readonly kind: "compact"; readonly path: null }
  | { readonly id: string; readonly kind: "launch"; readonly path: RepositoryRelativePath }
  | { readonly id: string; readonly kind: "read"; readonly path: RepositoryRelativePath };

export interface ClaudeSettingSourcesSnapshot {
  readonly state: "known" | "unknown";
  readonly values: readonly ("local" | "managed" | "project" | "user")[];
}

export interface ClaudeExclusionSnapshot {
  readonly completeness: "complete" | "partial" | "unknown";
  readonly patterns: readonly string[];
  readonly platformCase: "insensitive" | "sensitive" | "unknown";
}

export interface ClaudeRuntimeSnapshot {
  readonly additionalDirectoryInstructions: "disabled" | "enabled" | "unknown";
  readonly clientVersion: string | null;
  readonly eventTrace: readonly ClaudeRuntimeEvent[];
  readonly exclusions: ClaudeExclusionSnapshot;
  readonly externalContext: "supplied" | "unavailable" | "unknown";
  readonly mode: "bare" | "normal" | "safe" | "unknown";
  readonly settingSources: ClaudeSettingSourcesSnapshot;
}

export interface ResolveClaudeCodeProfileInput {
  readonly candidates: readonly ClaudeInstructionCandidateSnapshot[];
  readonly launchCwd: RepositoryRelativePath;
  readonly repositoryRoot: RepositoryRelativePath;
  readonly runtime: ClaudeRuntimeSnapshot;
}

export type ClaudeLoadState =
  | "approval-required"
  | "excluded"
  | "launch"
  | "on-demand-active"
  | "on-demand-inactive"
  | "unknown";

export type ClaudeProfileDecisionCode =
  | "additional-directory-disabled"
  | "bare-mode"
  | "documented-launch"
  | "documented-on-demand"
  | "documented-on-demand-inactive"
  | "excluded-by-setting"
  | "external-symlink-unknown"
  | "invalid-syntax"
  | "legacy-client-risk"
  | "local-source-disabled"
  | "project-rules-source-disabled"
  | "safe-mode"
  | "unknown-exclusion"
  | "unknown-runtime"
  | "unknown-symlink"
  | "unknown-version";

export interface ClaudeImportDecision {
  readonly depth: number;
  readonly fromDocumentId: InstructionDocumentId | null;
  readonly importId: string | null;
  readonly rawSpecifier: string | null;
  readonly state:
    | "approval-required"
    | "cycle-unknown"
    | "depth-unsupported"
    | "loaded"
    | "unavailable"
    | "unknown";
  readonly targetPath: RepositoryRelativePath | null;
}

export interface ClaudeCandidateDecision {
  readonly activatedBy: readonly string[];
  readonly activation: "active" | "inactive" | "indeterminate";
  readonly code: ClaudeProfileDecisionCode;
  readonly imports: readonly ClaudeImportDecision[];
  readonly kind: ClaudeCandidateKind;
  readonly loadState: ClaudeLoadState;
  readonly orderAfter: readonly RepositoryRelativePath[];
  readonly origin: ClaudeCandidateOrigin;
  readonly path: RepositoryRelativePath;
  readonly reason: string;
  readonly scopeRoot: RepositoryRelativePath;
  readonly syntax: ClaudeInstructionSyntaxResult;
  readonly versionBranch:
    | "2.1.198-to-2.1.206"
    | "2.1.207-to-2.1.210"
    | "2.1.211-to-2.1.216"
    | "2.1.217-or-newer"
    | "before-2.1.198"
    | "unversioned";
}

export interface ClaudeCodeProfileResolution {
  readonly analysisStatus: "complete" | "partial";
  readonly candidates: readonly ClaudeCandidateDecision[];
  readonly contractVersion: typeof CLAUDE_CODE_PROFILE_RESOLVER_CONTRACT_VERSION;
  readonly externalContext: ClaudeRuntimeSnapshot["externalContext"];
  readonly launchCwd: RepositoryRelativePath;
  readonly ordering: "documented-partial-order";
  readonly profile: typeof CLAUDE_CODE_PROFILE;
  readonly recordKind: "agent-context-claude-code-profile-resolution";
  readonly repositoryRoot: RepositoryRelativePath;
  readonly runtime: ClaudeRuntimeSnapshot;
  readonly unresolvedOrdering: readonly string[];
}

const ISSUED_CLAUDE_CODE_RESOLUTIONS = new WeakSet<object>();

/** True only for resolutions produced by this process's D05 resolver. */
export function isIssuedClaudeCodeProfileResolution(
  value: unknown,
): value is ClaudeCodeProfileResolution {
  return typeof value === "object" && value !== null && ISSUED_CLAUDE_CODE_RESOLUTIONS.has(value);
}

export const ClaudeCodeProfileErrorCode: Readonly<{
  invalidInput: "CLAUDE_CODE_PROFILE_INVALID_INPUT";
  resourceLimit: "CLAUDE_CODE_PROFILE_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "CLAUDE_CODE_PROFILE_INVALID_INPUT",
  resourceLimit: "CLAUDE_CODE_PROFILE_RESOURCE_LIMIT",
} as const);
export type ClaudeCodeProfileErrorCode =
  (typeof ClaudeCodeProfileErrorCode)[keyof typeof ClaudeCodeProfileErrorCode];

export class ClaudeCodeProfileError extends Error {
  override readonly name = "ClaudeCodeProfileError" as const;
  readonly code: ClaudeCodeProfileErrorCode;

  constructor(code: ClaudeCodeProfileErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;
interface Snapshot {
  readonly candidates: readonly ClaudeInstructionCandidateSnapshot[];
  readonly launchCwd: RepositoryRelativePath;
  readonly repositoryRoot: RepositoryRelativePath;
  readonly runtime: ClaudeRuntimeSnapshot;
}

const INPUT_KEYS = Object.freeze(["candidates", "launchCwd", "repositoryRoot", "runtime"]);
const CANDIDATE_KEYS = Object.freeze([
  "absolutePath",
  "bytes",
  "importGraph",
  "kind",
  "origin",
  "path",
  "scopeRoot",
  "symlinkState",
]);
const RUNTIME_KEYS = Object.freeze([
  "additionalDirectoryInstructions",
  "clientVersion",
  "eventTrace",
  "exclusions",
  "externalContext",
  "mode",
  "settingSources",
]);
const EVENT_KEYS = Object.freeze(["id", "kind", "path"]);
const SETTING_KEYS = Object.freeze(["state", "values"]);
const EXCLUSION_KEYS = Object.freeze(["completeness", "patterns", "platformCase"]);
const EVENT_ID = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const KINDS = new Set<ClaudeCandidateKind>([
  "memory-alternate",
  "memory-local",
  "memory-shared",
  "project-rule",
]);
const ORIGINS = new Set<ClaudeCandidateOrigin>(["additional-directory", "repository"]);
const SYMLINK_STATES = new Set<ClaudeSymlinkState>(["external", "internal", "none", "unknown"]);
const REASONS: Readonly<Record<ClaudeProfileDecisionCode, string>> = Object.freeze({
  "additional-directory-disabled": "Additional-directory instruction discovery is disabled.",
  "bare-mode": "Bare mode disables automatic project instruction discovery.",
  "documented-launch": "The documented launch chain includes this instruction.",
  "documented-on-demand": "A documented read event activates this instruction.",
  "documented-on-demand-inactive": "No supplied read event activates this instruction.",
  "excluded-by-setting": "A supplied absolute claudeMdExcludes pattern excludes this source.",
  "external-symlink-unknown": "The candidate symlink leaves the authorized repository boundary.",
  "invalid-syntax": "Malformed or unsupported syntax cannot establish instruction authority.",
  "legacy-client-risk": "The configured legacy client predates the safe documented behavior.",
  "local-source-disabled": "The active setting-source list excludes local instructions.",
  "project-rules-source-disabled": "The active modern client excludes project rules.",
  "safe-mode": "Safe mode disables managed, user, and project CLAUDE.md customizations.",
  "unknown-exclusion": "The supplied settings cannot prove whether this absolute path is excluded.",
  "unknown-runtime": "Required invocation or event state was not supplied.",
  "unknown-symlink": "Symlink target, containment, or cycle behavior is not established.",
  "unknown-version": "The client version is required to select this documented behavior branch.",
});

function fail(code: ClaudeCodeProfileErrorCode, message: string): never {
  throw new ClaudeCodeProfileError(code, message);
}

function record(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail(ClaudeCodeProfileErrorCode.invalidInput, `${label} must be a plain data record`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail(ClaudeCodeProfileErrorCode.invalidInput, `${label} must be closed`);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        ClaudeCodeProfileErrorCode.invalidInput,
        `${label} must contain enumerable data properties`,
      );
  }
  return value as DataRecord;
}

function property(value: DataRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function dense(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return fail(ClaudeCodeProfileErrorCode.invalidInput, `${label} must be a regular dense array`);
  if (value.length > maximum)
    return fail(ClaudeCodeProfileErrorCode.resourceLimit, `${label} exceeds its item limit`);
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return fail(ClaudeCodeProfileErrorCode.invalidInput, `${label} must not have extra fields`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(ClaudeCodeProfileErrorCode.invalidInput, `${label} must have canonical indices`);
  }
  return value;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || !isRepositoryRelativePath(value))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, `${label} must be a repository path`);
  if (Buffer.byteLength(value, "utf8") > CLAUDE_CODE_PROFILE_LIMITS.maximumPathBytes)
    return fail(ClaudeCodeProfileErrorCode.resourceLimit, `${label} exceeds its byte limit`);
  return value;
}

function absolutePath(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    return fail(
      ClaudeCodeProfileErrorCode.invalidInput,
      `${label} must be a normalized absolute path`,
    );
  if (Buffer.byteLength(value, "utf8") > CLAUDE_CODE_PROFILE_LIMITS.maximumPathBytes)
    return fail(ClaudeCodeProfileErrorCode.resourceLimit, `${label} exceeds its byte limit`);
  return value;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !EVENT_ID.test(value)
  )
    return fail(ClaudeCodeProfileErrorCode.invalidInput, `${label} must be a stable identifier`);
  return value;
}

function contains(root: string, path: string): boolean {
  return root === REPOSITORY_ROOT || path === root || path.startsWith(`${root}/`);
}

function directory(path: RepositoryRelativePath): RepositoryRelativePath {
  const index = path.lastIndexOf("/");
  return (index < 0 ? REPOSITORY_ROOT : path.slice(0, index)) as RepositoryRelativePath;
}

function join(root: RepositoryRelativePath, suffix: string): RepositoryRelativePath {
  return (root === REPOSITORY_ROOT ? suffix : `${root}/${suffix}`) as RepositoryRelativePath;
}

function compare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function copyBytes(value: unknown): Uint8Array {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  )
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "candidate bytes are invalid");
  const input = value as Uint8Array;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== input.length)
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "candidate bytes have extra fields");
  for (let index = 0; index < input.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      keys[index] !== key ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return fail(ClaudeCodeProfileErrorCode.invalidInput, "candidate bytes are not canonical");
  }
  if (input.byteLength > CLAUDE_CODE_PROFILE_LIMITS.maximumCandidateBytes)
    return fail(ClaudeCodeProfileErrorCode.resourceLimit, "candidate exceeds its byte limit");
  return Uint8Array.prototype.slice.call(input);
}

function locationMatches(candidate: ClaudeInstructionCandidateSnapshot): boolean {
  if (!contains(candidate.scopeRoot, candidate.path)) return false;
  const base = candidate.path.slice(candidate.path.lastIndexOf("/") + 1);
  if (candidate.kind === "memory-shared") return base === "CLAUDE.md";
  if (candidate.kind === "memory-local") return base === "CLAUDE.local.md";
  if (candidate.kind === "memory-alternate")
    return candidate.path === join(candidate.scopeRoot, ".claude/CLAUDE.md");
  const rulesRoot = join(candidate.scopeRoot, ".claude/rules");
  return (
    contains(rulesRoot, candidate.path) && candidate.path !== rulesRoot && base.endsWith(".md")
  );
}

function candidateSnapshot(value: unknown): ClaudeInstructionCandidateSnapshot {
  const input = record(value, CANDIDATE_KEYS, "Claude candidate");
  const kind = property(input, "kind");
  const origin = property(input, "origin");
  const symlinkState = property(input, "symlinkState");
  if (typeof kind !== "string" || !KINDS.has(kind as ClaudeCandidateKind))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "candidate kind is invalid");
  if (typeof origin !== "string" || !ORIGINS.has(origin as ClaudeCandidateOrigin))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "candidate origin is invalid");
  if (typeof symlinkState !== "string" || !SYMLINK_STATES.has(symlinkState as ClaudeSymlinkState))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "candidate symlink state is invalid");
  const graph = property(input, "importGraph");
  if (graph !== null && (typeof graph !== "object" || nodeTypes.isProxy(graph)))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "candidate import graph is invalid");
  const output = Object.freeze({
    absolutePath: absolutePath(property(input, "absolutePath"), "candidate absolutePath"),
    bytes: copyBytes(property(input, "bytes")),
    importGraph: graph as ImportGraphResult | null,
    kind: kind as ClaudeCandidateKind,
    origin: origin as ClaudeCandidateOrigin,
    path: pathValue(property(input, "path"), "candidate path"),
    scopeRoot: pathValue(property(input, "scopeRoot"), "candidate scopeRoot"),
    symlinkState: symlinkState as ClaudeSymlinkState,
  });
  if (!locationMatches(output))
    return fail(
      ClaudeCodeProfileErrorCode.invalidInput,
      "candidate location does not match its kind",
    );
  return output;
}

function settingSources(value: unknown): ClaudeSettingSourcesSnapshot {
  const input = record(value, SETTING_KEYS, "Claude setting sources");
  const state = property(input, "state");
  if (state !== "known" && state !== "unknown")
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "setting-source state is invalid");
  const raw = dense(property(input, "values"), 4, "Claude setting sources values");
  const allowed = new Set(["local", "managed", "project", "user"]);
  if (raw.some((entry) => typeof entry !== "string" || !allowed.has(entry)))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "setting-source value is invalid");
  const values = raw as readonly ("local" | "managed" | "project" | "user")[];
  if (new Set(values).size !== values.length)
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "setting sources must be unique");
  return Object.freeze({ state, values: Object.freeze([...values].sort(compare)) });
}

function exclusions(value: unknown): ClaudeExclusionSnapshot {
  const input = record(value, EXCLUSION_KEYS, "Claude exclusions");
  const completeness = property(input, "completeness");
  const platformCase = property(input, "platformCase");
  if (!new Set(["complete", "partial", "unknown"]).has(completeness as string))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "exclusion completeness is invalid");
  if (!new Set(["insensitive", "sensitive", "unknown"]).has(platformCase as string))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "exclusion case behavior is invalid");
  const raw = dense(
    property(input, "patterns"),
    CLAUDE_CODE_PROFILE_LIMITS.maximumExclusions,
    "Claude exclusion patterns",
  );
  if (
    raw.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.includes("\0") ||
        Buffer.byteLength(entry, "utf8") > CLAUDE_CODE_PROFILE_LIMITS.maximumPathBytes,
    )
  )
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "exclusion pattern is invalid");
  const patterns = raw as readonly string[];
  if (new Set(patterns).size !== patterns.length)
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "exclusion patterns must be unique");
  return Object.freeze({
    completeness: completeness as ClaudeExclusionSnapshot["completeness"],
    patterns: Object.freeze([...patterns].sort(compare)),
    platformCase: platformCase as ClaudeExclusionSnapshot["platformCase"],
  });
}

function events(value: unknown, launchCwd: RepositoryRelativePath): readonly ClaudeRuntimeEvent[] {
  const raw = dense(value, CLAUDE_CODE_PROFILE_LIMITS.maximumEvents, "Claude event trace");
  if (raw.length === 0)
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "event trace is empty");
  const output = raw.map((entry, index): ClaudeRuntimeEvent => {
    const input = record(entry, EVENT_KEYS, "Claude event");
    const id = text(property(input, "id"), "event id");
    const kind = property(input, "kind");
    const rawPath = property(input, "path");
    if (kind === "compact") {
      if (rawPath !== null)
        return fail(ClaudeCodeProfileErrorCode.invalidInput, "compact event path must be null");
      return Object.freeze({ id, kind, path: null });
    }
    if (kind !== "launch" && kind !== "read")
      return fail(ClaudeCodeProfileErrorCode.invalidInput, "event kind is invalid");
    const eventPath = pathValue(rawPath, "event path");
    if ((index === 0) !== (kind === "launch") || (kind === "launch" && eventPath !== launchCwd))
      return fail(
        ClaudeCodeProfileErrorCode.invalidInput,
        "event trace must start with the matching launch event",
      );
    return Object.freeze({ id, kind, path: eventPath });
  });
  if (new Set(output.map((entry) => entry.id)).size !== output.length)
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "event ids must be unique");
  return Object.freeze(output);
}

function runtime(value: unknown, launchCwd: RepositoryRelativePath): ClaudeRuntimeSnapshot {
  const input = record(value, RUNTIME_KEYS, "Claude runtime");
  const additional = property(input, "additionalDirectoryInstructions");
  const external = property(input, "externalContext");
  const mode = property(input, "mode");
  if (!new Set(["disabled", "enabled", "unknown"]).has(additional as string))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "additional-directory state is invalid");
  if (!new Set(["supplied", "unavailable", "unknown"]).has(external as string))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "external-context state is invalid");
  if (!new Set(["bare", "normal", "safe", "unknown"]).has(mode as string))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "runtime mode is invalid");
  const clientVersion = property(input, "clientVersion");
  if (clientVersion !== null && (typeof clientVersion !== "string" || !SEMVER.test(clientVersion)))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "client version is invalid");
  return Object.freeze({
    additionalDirectoryInstructions:
      additional as ClaudeRuntimeSnapshot["additionalDirectoryInstructions"],
    clientVersion,
    eventTrace: events(property(input, "eventTrace"), launchCwd),
    exclusions: exclusions(property(input, "exclusions")),
    externalContext: external as ClaudeRuntimeSnapshot["externalContext"],
    mode: mode as ClaudeRuntimeSnapshot["mode"],
    settingSources: settingSources(property(input, "settingSources")),
  });
}

function snapshot(value: unknown): Snapshot {
  const input = record(value, INPUT_KEYS, "Claude profile request");
  const launchCwd = pathValue(property(input, "launchCwd"), "launchCwd");
  const repositoryRoot = pathValue(property(input, "repositoryRoot"), "repositoryRoot");
  if (!contains(repositoryRoot, launchCwd))
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "launchCwd must be within repositoryRoot");
  const raw = dense(
    property(input, "candidates"),
    CLAUDE_CODE_PROFILE_LIMITS.maximumCandidates,
    "Claude candidates",
  );
  const candidates = raw.map(candidateSnapshot);
  if (
    candidates.some((entry) => entry.origin === "repository" && entry.scopeRoot !== repositoryRoot)
  )
    return fail(
      ClaudeCodeProfileErrorCode.invalidInput,
      "repository candidate scopeRoot is invalid",
    );
  const identities = candidates.map((entry) => `${entry.path}\0${entry.kind}\0${entry.origin}`);
  if (new Set(identities).size !== identities.length)
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "candidates must be unique");
  const totalBytes = candidates.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  const totalPathBytes = candidates.reduce(
    (sum, entry) =>
      sum +
      Buffer.byteLength(entry.path, "utf8") +
      Buffer.byteLength(entry.scopeRoot, "utf8") +
      (entry.absolutePath === null ? 0 : Buffer.byteLength(entry.absolutePath, "utf8")),
    Buffer.byteLength(launchCwd, "utf8") + Buffer.byteLength(repositoryRoot, "utf8"),
  );
  if (totalBytes > CLAUDE_CODE_PROFILE_LIMITS.maximumTotalBytes)
    return fail(ClaudeCodeProfileErrorCode.resourceLimit, "candidate bytes exceed aggregate limit");
  if (totalPathBytes > CLAUDE_CODE_PROFILE_LIMITS.maximumTotalPathBytes)
    return fail(ClaudeCodeProfileErrorCode.resourceLimit, "paths exceed aggregate limit");
  return Object.freeze({
    candidates: Object.freeze(
      [...candidates].sort(
        (left, right) => compare(left.path, right.path) || compare(left.kind, right.kind),
      ),
    ),
    launchCwd,
    repositoryRoot,
    runtime: runtime(property(input, "runtime"), launchCwd),
  });
}

function versionCompare(left: string, right: string): number {
  const l = left.split(".").map(Number);
  const r = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (l[index] ?? 0) - (r[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function versionBranch(version: string | null): ClaudeCandidateDecision["versionBranch"] {
  if (version === null) return "unversioned";
  if (versionCompare(version, "2.1.198") < 0) return "before-2.1.198";
  if (versionCompare(version, "2.1.207") < 0) return "2.1.198-to-2.1.206";
  if (versionCompare(version, "2.1.211") < 0) return "2.1.207-to-2.1.210";
  if (versionCompare(version, "2.1.217") < 0) return "2.1.211-to-2.1.216";
  return "2.1.217-or-newer";
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

type ExclusionDecision = "excluded" | "not-excluded" | "unknown";

function excluded(
  candidate: ClaudeInstructionCandidateSnapshot,
  snapshotValue: ClaudeExclusionSnapshot,
): ExclusionDecision {
  if (snapshotValue.patterns.length === 0)
    return snapshotValue.completeness === "complete" ? "not-excluded" : "unknown";
  if (candidate.absolutePath === null || snapshotValue.platformCase !== "sensitive")
    return "unknown";
  let unsupported = false;
  for (const pattern of snapshotValue.patterns) {
    if (!pattern.startsWith("/")) {
      unsupported = true;
      continue;
    }
    if (!pattern.includes("*")) {
      if (pattern === candidate.absolutePath) return "excluded";
      continue;
    }
    if (pattern.endsWith("/**") && !pattern.slice(0, -3).includes("*")) {
      const root = pattern.slice(0, -3);
      if (candidate.absolutePath === root || candidate.absolutePath.startsWith(`${root}/`))
        return "excluded";
      continue;
    }
    unsupported = true;
  }
  return snapshotValue.completeness === "complete" && !unsupported ? "not-excluded" : "unknown";
}

function syntaxFor(candidate: ClaudeInstructionCandidateSnapshot): ClaudeInstructionSyntaxResult {
  const digest = createHash("sha256")
    .update(candidate.path)
    .update("\0")
    .update(candidate.bytes)
    .digest("hex");
  const format: ClaudeInstructionFormat =
    candidate.kind === "project-rule" ? "project-rule" : "memory";
  return parseClaudeInstructionSyntax({
    bytes: candidate.bytes,
    documentId: `document:claude:${digest}` as InstructionDocumentId,
    format,
    sourceId: `source:claude:${digest}` as SourceDocumentId,
  });
}

function importState(occurrence: ImportDagOccurrence): ClaudeImportDecision["state"] {
  if (occurrence.depth > CLAUDE_CODE_PROFILE.importDepth) return "depth-unsupported";
  if (occurrence.issueCode === "IMPORT_GRAPH_ROOT_BOUNDARY") return "approval-required";
  if (occurrence.state === "cycle") return "cycle-unknown";
  if (occurrence.state === "loaded" || occurrence.state === "already-loaded") return "loaded";
  if (occurrence.state === "unavailable" || occurrence.state === "rejected") return "unavailable";
  return "unknown";
}

function importsFor(
  candidate: ClaudeInstructionCandidateSnapshot,
  syntax: ClaudeInstructionSyntaxResult,
  launchCwd: RepositoryRelativePath,
): readonly ClaudeImportDecision[] {
  if (candidate.importGraph === null) {
    return Object.freeze(
      syntax.imports.map((entry) =>
        Object.freeze({
          depth: 1,
          fromDocumentId: syntax.documentId,
          importId: entry.id,
          rawSpecifier: entry.rawSpecifier,
          state: "unknown" as const,
          targetPath: null,
        }),
      ),
    );
  }
  let dag;
  try {
    dag = buildDocumentImportDag({
      graph: candidate.importGraph,
      trace: createSyntheticTargetTrace({
        launchCwd,
        purpose: "claude-import-resolution",
        targetPath: candidate.path,
        workspaceRoots: [candidate.scopeRoot],
      }),
    });
  } catch {
    return fail(ClaudeCodeProfileErrorCode.invalidInput, "candidate import graph is invalid");
  }
  if (dag.entryPath !== candidate.path)
    return fail(
      ClaudeCodeProfileErrorCode.invalidInput,
      "candidate import graph entry mismatches path",
    );
  const rawById = new Map([
    ...syntax.imports.map((entry) => [entry.id, entry.rawSpecifier] as const),
    ...candidate.importGraph.edges.map(
      (entry) => [entry.import.id, entry.import.rawSpecifier] as const,
    ),
  ]);
  return Object.freeze(
    dag.occurrences
      .filter((entry) => entry.state !== "entry")
      .map((entry) =>
        Object.freeze({
          depth: entry.depth,
          fromDocumentId: entry.fromDocumentId,
          importId: entry.importId,
          rawSpecifier: entry.importId === null ? null : (rawById.get(entry.importId) ?? null),
          state: importState(entry),
          targetPath: entry.targetPath,
        }),
      ),
  );
}

interface ActivationDecision {
  readonly activatedBy: readonly string[];
  readonly activation: ClaudeCandidateDecision["activation"];
  readonly code: ClaudeProfileDecisionCode;
  readonly loadState: ClaudeLoadState;
}

function fixed(
  activation: ClaudeCandidateDecision["activation"],
  code: ClaudeProfileDecisionCode,
  loadState: ClaudeLoadState,
  activatedBy: readonly string[] = [],
): ActivationDecision {
  return Object.freeze({
    activation,
    activatedBy: Object.freeze([...activatedBy]),
    code,
    loadState,
  });
}

function readEventsAfterLastCompact(
  runtimeValue: ClaudeRuntimeSnapshot,
): readonly Extract<ClaudeRuntimeEvent, { kind: "read" }>[] {
  let start = 0;
  for (let index = 0; index < runtimeValue.eventTrace.length; index += 1)
    if (runtimeValue.eventTrace[index]?.kind === "compact") start = index + 1;
  return runtimeValue.eventTrace.slice(start).filter((entry) => entry.kind === "read");
}

function hadCompact(runtimeValue: ClaudeRuntimeSnapshot): boolean {
  return runtimeValue.eventTrace.some((entry) => entry.kind === "compact");
}

function ruleActivation(
  candidate: ClaudeInstructionCandidateSnapshot,
  syntax: ClaudeInstructionSyntaxResult,
  runtimeValue: ClaudeRuntimeSnapshot,
): ActivationDecision {
  const reads = readEventsAfterLastCompact(runtimeValue);
  if (syntax.paths.state === "absent") {
    if (hadCompact(runtimeValue)) return fixed("indeterminate", "unknown-runtime", "unknown");
    return fixed("active", "documented-launch", "launch", [runtimeValue.eventTrace[0]?.id ?? ""]);
  }
  if (syntax.paths.value === null) return fixed("indeterminate", "invalid-syntax", "unknown");
  if (
    syntax.paths.value.some((pattern) => pattern.includes("{")) &&
    (runtimeValue.clientVersion === null ||
      versionCompare(runtimeValue.clientVersion, "2.1.217") < 0)
  )
    return fixed(
      "indeterminate",
      runtimeValue.clientVersion === null ? "unknown-version" : "legacy-client-risk",
      "unknown",
    );
  if (
    syntax.paths.value.some(malformedBracketExpression) &&
    (runtimeValue.clientVersion === null ||
      versionCompare(runtimeValue.clientVersion, "2.1.207") < 0)
  )
    return fixed(
      "indeterminate",
      runtimeValue.clientVersion === null ? "unknown-version" : "legacy-client-risk",
      "unknown",
    );
  const activeEvents: string[] = [];
  let indeterminate = false;
  for (const event of reads) {
    let eventActive = false;
    for (const [index, pattern] of syntax.paths.value.entries()) {
      const result = matchProfileGlob({
        dialectId: CLAUDE_CODE_PROFILE.ruleGlobDialectId,
        pattern,
        profileId: CLAUDE_CODE_PROFILE.profileId,
        ruleId: `activation:claude:${index.toString(36)}` as ActivationRuleId,
        scopeRoot: candidate.scopeRoot,
        surfaceId: CLAUDE_CODE_PROFILE.surfaceId,
        targetPath: event.path,
      });
      if (result.state === "active") eventActive = true;
      if (result.state === "indeterminate") indeterminate = true;
    }
    if (eventActive) activeEvents.push(event.id);
  }
  if (activeEvents.length > 0)
    return fixed("active", "documented-on-demand", "on-demand-active", activeEvents);
  if (indeterminate) return fixed("indeterminate", "unknown-runtime", "unknown");
  return fixed("inactive", "documented-on-demand-inactive", "on-demand-inactive");
}

function memoryActivation(
  candidate: ClaudeInstructionCandidateSnapshot,
  runtimeValue: ClaudeRuntimeSnapshot,
  launchCwd: RepositoryRelativePath,
  repositoryRoot: RepositoryRelativePath,
): ActivationDecision {
  const candidateDirectory = directory(candidate.path);
  const reads = readEventsAfterLastCompact(runtimeValue);
  const matchingReads = reads.filter((event) => contains(candidateDirectory, event.path));
  if (hadCompact(runtimeValue)) {
    if (
      candidate.origin === "repository" &&
      candidate.kind === "memory-shared" &&
      candidateDirectory === repositoryRoot
    )
      return fixed("active", "documented-launch", "launch", [runtimeValue.eventTrace[0]?.id ?? ""]);
    if (!contains(candidateDirectory, launchCwd) && matchingReads.length > 0)
      return fixed(
        "active",
        "documented-on-demand",
        "on-demand-active",
        matchingReads.map((entry) => entry.id),
      );
    return fixed("indeterminate", "unknown-runtime", "unknown");
  }
  if (candidate.kind === "memory-alternate")
    return fixed("active", "documented-launch", "launch", [runtimeValue.eventTrace[0]?.id ?? ""]);
  if (contains(candidateDirectory, launchCwd))
    return fixed("active", "documented-launch", "launch", [runtimeValue.eventTrace[0]?.id ?? ""]);
  if (matchingReads.length > 0)
    return fixed(
      "active",
      "documented-on-demand",
      "on-demand-active",
      matchingReads.map((entry) => entry.id),
    );
  return fixed("inactive", "documented-on-demand-inactive", "on-demand-inactive");
}

function activation(
  candidate: ClaudeInstructionCandidateSnapshot,
  syntax: ClaudeInstructionSyntaxResult,
  input: Snapshot,
): ActivationDecision {
  const runtimeValue = input.runtime;
  if (runtimeValue.mode === "bare") return fixed("inactive", "bare-mode", "excluded");
  if (runtimeValue.mode === "safe") return fixed("inactive", "safe-mode", "excluded");
  if (runtimeValue.mode === "unknown") return fixed("indeterminate", "unknown-runtime", "unknown");
  if (candidate.origin === "additional-directory") {
    if (runtimeValue.additionalDirectoryInstructions === "disabled")
      return fixed("inactive", "additional-directory-disabled", "excluded");
    if (runtimeValue.additionalDirectoryInstructions === "unknown")
      return fixed("indeterminate", "unknown-runtime", "unknown");
  }
  if (runtimeValue.settingSources.state === "unknown")
    return fixed("indeterminate", "unknown-runtime", "unknown");
  if (candidate.kind === "memory-local" && !runtimeValue.settingSources.values.includes("local"))
    return fixed("inactive", "local-source-disabled", "excluded");
  if (
    candidate.kind === "project-rule" &&
    !runtimeValue.settingSources.values.includes("project")
  ) {
    if (runtimeValue.clientVersion === null)
      return fixed("indeterminate", "unknown-version", "unknown");
    if (versionCompare(runtimeValue.clientVersion, "2.1.211") >= 0)
      return fixed("inactive", "project-rules-source-disabled", "excluded");
    return fixed("indeterminate", "legacy-client-risk", "unknown");
  }
  const exclusion = excluded(candidate, runtimeValue.exclusions);
  if (exclusion === "excluded") return fixed("inactive", "excluded-by-setting", "excluded");
  if (exclusion === "unknown") return fixed("indeterminate", "unknown-exclusion", "unknown");
  if (candidate.symlinkState === "external")
    return fixed("indeterminate", "external-symlink-unknown", "unknown");
  if (candidate.symlinkState !== "none")
    return fixed("indeterminate", "unknown-symlink", "unknown");
  if (syntax.state === "malformed" || candidate.bytes.byteLength === 0)
    return fixed("indeterminate", "invalid-syntax", "unknown");
  return candidate.kind === "project-rule"
    ? ruleActivation(candidate, syntax, runtimeValue)
    : memoryActivation(candidate, runtimeValue, input.launchCwd, input.repositoryRoot);
}

function orderAfter(
  candidate: ClaudeInstructionCandidateSnapshot,
  candidates: readonly ClaudeInstructionCandidateSnapshot[],
): readonly RepositoryRelativePath[] {
  const currentDirectory = directory(candidate.path);
  return Object.freeze(
    candidates
      .filter((other) => {
        if (other.path === candidate.path || other.origin !== candidate.origin) return false;
        if (candidate.kind === "project-rule" || other.kind === "project-rule") return false;
        const otherDirectory = directory(other.path);
        if (otherDirectory !== currentDirectory)
          return contains(otherDirectory, currentDirectory) && otherDirectory !== currentDirectory;
        return candidate.kind === "memory-local" && other.kind === "memory-shared";
      })
      .map((entry) => entry.path)
      .sort(compare),
  );
}

function unresolvedOrdering(decisions: readonly ClaudeCandidateDecision[]): readonly string[] {
  const active = decisions.filter((entry) => entry.activation === "active");
  const hasAlternate = active.some((entry) => entry.kind === "memory-alternate");
  const hasSharedOrRule = active.some(
    (entry) => entry.kind === "memory-shared" || entry.kind === "project-rule",
  );
  return hasAlternate && hasSharedOrRule
    ? Object.freeze(["CLAUDE.md, .claude/CLAUDE.md, and unconditional project-rule sibling order"])
    : Object.freeze([]);
}

/** Resolve a closed repository/runtime snapshot without filesystem, command, environment, or client access. */
export function resolveClaudeCodeProfile(rawInput: unknown): ClaudeCodeProfileResolution {
  const input = snapshot(rawInput);
  const candidates = Object.freeze(
    input.candidates.map((candidate): ClaudeCandidateDecision => {
      const syntax = syntaxFor(candidate);
      const selected = activation(candidate, syntax, input);
      return Object.freeze({
        activatedBy: selected.activatedBy,
        activation: selected.activation,
        code: selected.code,
        imports: importsFor(candidate, syntax, input.launchCwd),
        kind: candidate.kind,
        loadState: selected.loadState,
        orderAfter: orderAfter(candidate, input.candidates),
        origin: candidate.origin,
        path: candidate.path,
        reason: REASONS[selected.code],
        scopeRoot: candidate.scopeRoot,
        syntax,
        versionBranch: versionBranch(input.runtime.clientVersion),
      });
    }),
  );
  const orderingIssues = unresolvedOrdering(candidates);
  const partial =
    input.runtime.externalContext !== "supplied" ||
    orderingIssues.length > 0 ||
    candidates.some(
      (entry) =>
        entry.activation === "indeterminate" ||
        entry.syntax.state !== "complete" ||
        entry.imports.some((importEntry) => importEntry.state !== "loaded"),
    );
  const result: ClaudeCodeProfileResolution = Object.freeze({
    analysisStatus: partial ? "partial" : "complete",
    candidates,
    contractVersion: CLAUDE_CODE_PROFILE_RESOLVER_CONTRACT_VERSION,
    externalContext: input.runtime.externalContext,
    launchCwd: input.launchCwd,
    ordering: "documented-partial-order",
    profile: CLAUDE_CODE_PROFILE,
    recordKind: "agent-context-claude-code-profile-resolution",
    repositoryRoot: input.repositoryRoot,
    runtime: input.runtime,
    unresolvedOrdering: orderingIssues,
  });
  ISSUED_CLAUDE_CODE_RESOLUTIONS.add(result);
  return result;
}
