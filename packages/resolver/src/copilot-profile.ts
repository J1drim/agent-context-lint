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
import {
  copilotProfile,
  type CopilotProfileDescriptor,
  type CopilotProfileId,
} from "@agent-context/profiles";
import {
  parseCopilotInstructionSyntax,
  type CopilotInstructionFormat,
  type CopilotInstructionSyntaxResult,
} from "@agent-context/syntax";

import { matchProfileGlob } from "./profile-glob-dialects.js";

export const COPILOT_PROFILE_RESOLVER_CONTRACT_VERSION = "0.1.0" as const;

export interface CopilotProfileResolverLimits {
  readonly maximumCandidates: number;
  readonly maximumCandidateBytes: number;
  readonly maximumLocations: number;
  readonly maximumPathBytes: number;
  readonly maximumTargets: number;
  readonly maximumTotalCandidateBytes: number;
  readonly maximumTotalPathBytes: number;
}

export const COPILOT_PROFILE_RESOLVER_LIMITS: Readonly<CopilotProfileResolverLimits> =
  Object.freeze({
    maximumCandidates: 4_096,
    maximumCandidateBytes: 262_144,
    maximumLocations: 4_096,
    maximumPathBytes: 16_384,
    maximumTargets: 4_096,
    maximumTotalCandidateBytes: 16_777_216,
    maximumTotalPathBytes: 16_777_216,
  });

export interface CopilotInstructionCandidateSnapshot {
  readonly bytes: Uint8Array;
  readonly format: CopilotInstructionFormat;
  readonly path: RepositoryRelativePath;
}

export type CopilotRuntimeEventState = "absent" | "present" | "unknown";
export type CopilotRuntimeSettingState = "disabled" | "enabled" | "unknown";

export interface CopilotCliStandardLocation {
  readonly kind:
    | "current-working-directory"
    | "intermediate-directory"
    | "repository-root"
    | "working-directory";
  readonly path: RepositoryRelativePath;
}

export interface CopilotCliRuntimeSnapshot {
  readonly disabledPaths: readonly RepositoryRelativePath[];
  readonly eventState: CopilotRuntimeEventState;
  readonly kind: "copilot-cli";
  readonly standardLocations: readonly CopilotCliStandardLocation[];
  readonly targetPaths: readonly RepositoryRelativePath[];
}

export interface CopilotVscodeInstructionFolder {
  readonly path: RepositoryRelativePath;
  readonly workspaceRoot: RepositoryRelativePath;
}

export interface CopilotVscodeRuntimeSnapshot {
  readonly applyingInstructions: CopilotRuntimeSettingState;
  readonly eventState: CopilotRuntimeEventState;
  readonly instructionFolders: readonly CopilotVscodeInstructionFolder[];
  readonly kind: "copilot-vscode";
  readonly manualAttachments: readonly RepositoryRelativePath[];
  readonly targetPaths: readonly RepositoryRelativePath[];
  readonly workspaceRoots: readonly RepositoryRelativePath[];
}

export interface CopilotCloudAgentRuntimeSnapshot {
  readonly eventState: CopilotRuntimeEventState;
  readonly kind: "copilot-cloud-agent";
  readonly repositoryRoot: RepositoryRelativePath;
  readonly targetPaths: readonly RepositoryRelativePath[];
}

export interface CopilotCodeReviewRuntimeSnapshot {
  readonly customInstructions: CopilotRuntimeSettingState;
  readonly eventState: CopilotRuntimeEventState;
  readonly kind: "copilot-code-review";
  readonly repositoryRoot: RepositoryRelativePath;
  readonly targetPaths: readonly RepositoryRelativePath[];
}

export type CopilotRuntimeSnapshot =
  | CopilotCliRuntimeSnapshot
  | CopilotCloudAgentRuntimeSnapshot
  | CopilotCodeReviewRuntimeSnapshot
  | CopilotVscodeRuntimeSnapshot;

export interface ResolveCopilotProfileInput {
  readonly candidates: readonly CopilotInstructionCandidateSnapshot[];
  readonly profileId: CopilotProfileId;
  readonly runtime: CopilotRuntimeSnapshot;
}

export type CopilotDiscoveryState = "documented" | "not-discovered" | "unknown";
export type CopilotActivationState = "active" | "inactive" | "indeterminate";
export type CopilotEligibilityState = "allowed" | "denied" | "indeterminate";

export type CopilotProfileDecisionCode =
  | "documented-auto"
  | "documented-disabled"
  | "documented-exclusion"
  | "documented-no-match"
  | "documented-not-discovered"
  | "manual-attachment"
  | "malformed-syntax"
  | "missing-runtime-event"
  | "unknown-discovery"
  | "unknown-event-state"
  | "unknown-glob-semantics"
  | "unknown-setting-state"
  | "unknown-target-state"
  | "vscode-description-contradiction";

export interface CopilotTargetDecision {
  readonly code: CopilotProfileDecisionCode;
  readonly reason: string;
  readonly state: CopilotActivationState;
  readonly targetPath: RepositoryRelativePath;
}

export interface CopilotCandidateDecision {
  readonly activation: CopilotActivationState;
  readonly code: CopilotProfileDecisionCode;
  readonly discovery: CopilotDiscoveryState;
  readonly eligibility: CopilotEligibilityState;
  readonly format: CopilotInstructionFormat;
  readonly path: RepositoryRelativePath;
  readonly reason: string;
  readonly scopeRoot: RepositoryRelativePath | null;
  readonly syntax: CopilotInstructionSyntaxResult;
  readonly targetDecisions: readonly CopilotTargetDecision[];
}

export interface CopilotProfileResolution {
  readonly analysisStatus: "complete" | "partial";
  readonly candidates: readonly CopilotCandidateDecision[];
  readonly contractVersion: typeof COPILOT_PROFILE_RESOLVER_CONTRACT_VERSION;
  readonly profile: CopilotProfileDescriptor;
  readonly recordKind: "agent-context-copilot-profile-resolution";
  readonly runtimeKind: CopilotProfileId;
}

const ISSUED_COPILOT_RESOLUTIONS = new WeakSet<object>();

/** True only for resolutions produced by this process's D08 resolver. */
export function isIssuedCopilotProfileResolution(
  value: unknown,
): value is CopilotProfileResolution {
  return typeof value === "object" && value !== null && ISSUED_COPILOT_RESOLUTIONS.has(value);
}

export const CopilotProfileErrorCode: Readonly<{
  invalidInput: "COPILOT_PROFILE_INVALID_INPUT";
  resourceLimit: "COPILOT_PROFILE_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "COPILOT_PROFILE_INVALID_INPUT",
  resourceLimit: "COPILOT_PROFILE_RESOURCE_LIMIT",
} as const);

export type CopilotProfileErrorCode =
  (typeof CopilotProfileErrorCode)[keyof typeof CopilotProfileErrorCode];

export class CopilotProfileError extends Error {
  override readonly name = "CopilotProfileError" as const;
  readonly code: CopilotProfileErrorCode;

  constructor(code: CopilotProfileErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface Snapshot {
  readonly candidates: readonly CopilotInstructionCandidateSnapshot[];
  readonly profile: CopilotProfileDescriptor;
  readonly runtime: CopilotRuntimeSnapshot;
}

interface DiscoveryDecision {
  readonly scopeRoot: RepositoryRelativePath | null;
  readonly state: CopilotDiscoveryState;
}

const INPUT_KEYS = Object.freeze(["candidates", "profileId", "runtime"]);
const CANDIDATE_KEYS = Object.freeze(["bytes", "format", "path"]);
const CLI_RUNTIME_KEYS = Object.freeze([
  "disabledPaths",
  "eventState",
  "kind",
  "standardLocations",
  "targetPaths",
]);
const CLI_LOCATION_KEYS = Object.freeze(["kind", "path"]);
const VSCODE_RUNTIME_KEYS = Object.freeze([
  "applyingInstructions",
  "eventState",
  "instructionFolders",
  "kind",
  "manualAttachments",
  "targetPaths",
  "workspaceRoots",
]);
const VSCODE_FOLDER_KEYS = Object.freeze(["path", "workspaceRoot"]);
const CLOUD_RUNTIME_KEYS = Object.freeze(["eventState", "kind", "repositoryRoot", "targetPaths"]);
const REVIEW_RUNTIME_KEYS = Object.freeze([
  "customInstructions",
  "eventState",
  "kind",
  "repositoryRoot",
  "targetPaths",
]);
const EVENT_STATES = new Set<CopilotRuntimeEventState>(["absent", "present", "unknown"]);
const SETTING_STATES = new Set<CopilotRuntimeSettingState>(["disabled", "enabled", "unknown"]);
const FORMATS = new Set<CopilotInstructionFormat>(["path-specific", "repository-wide"]);
const CLI_LOCATION_KINDS = new Set<CopilotCliStandardLocation["kind"]>([
  "current-working-directory",
  "intermediate-directory",
  "repository-root",
  "working-directory",
]);

const REASONS: Readonly<Record<CopilotProfileDecisionCode, string>> = Object.freeze({
  "documented-auto": "The documented profile event and selector make this instruction active.",
  "documented-disabled": "Explicit client state disables this instruction for the current event.",
  "documented-exclusion": "A documented hosted exclusion disables this instruction surface.",
  "documented-no-match": "Every target is a documented non-match for this instruction.",
  "documented-not-discovered": "The candidate is outside this surface's documented discovery set.",
  "manual-attachment": "Explicit request state manually attaches this instruction.",
  "malformed-syntax": "Malformed or non-authoritative syntax cannot establish activation.",
  "missing-runtime-event": "No matching runtime event exists for this resolution.",
  "unknown-discovery": "The supplied repository state cannot prove profile discovery.",
  "unknown-event-state": "The runtime event state is unavailable.",
  "unknown-glob-semantics": "The profile snapshot does not define enough glob behavior.",
  "unknown-setting-state": "The relevant client setting state is unavailable.",
  "unknown-target-state": "No bounded runtime target establishes path activation.",
  "vscode-description-contradiction":
    "Current VS Code documentation conflicts on description-only automatic activation.",
});

function fail(code: CopilotProfileErrorCode, message: string): never {
  throw new CopilotProfileError(code, message);
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function property(record: DataRecord, key: string): unknown {
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
    return fail(CopilotProfileErrorCode.invalidInput, `${label} must be a regular data record`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail(CopilotProfileErrorCode.invalidInput, `${label} must be closed`);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        CopilotProfileErrorCode.invalidInput,
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
    return fail(CopilotProfileErrorCode.invalidInput, `${label} must be a regular dense array`);
  if (value.length > maximum)
    return fail(CopilotProfileErrorCode.resourceLimit, `${label} exceeds its item limit`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1)
    return fail(CopilotProfileErrorCode.invalidInput, `${label} must not have extra properties`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      keys[index] !== String(index) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      return fail(CopilotProfileErrorCode.invalidInput, `${label} must use canonical data indices`);
  }
  return value;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || !isRepositoryRelativePath(value))
    return fail(
      CopilotProfileErrorCode.invalidInput,
      `${label} must be a canonical repository path`,
    );
  if (Buffer.byteLength(value, "utf8") > COPILOT_PROFILE_RESOLVER_LIMITS.maximumPathBytes)
    return fail(CopilotProfileErrorCode.resourceLimit, `${label} exceeds its byte limit`);
  return value;
}

function pathArray(
  value: unknown,
  maximum: number,
  label: string,
  allowEmpty = false,
): readonly RepositoryRelativePath[] {
  const input = denseArray(value, maximum, label);
  if (!allowEmpty && input.length === 0)
    return fail(CopilotProfileErrorCode.invalidInput, `${label} must not be empty`);
  const paths = input.map((entry, index) => pathValue(entry, `${label}[${String(index)}]`));
  if (new Set(paths).size !== paths.length)
    return fail(CopilotProfileErrorCode.invalidInput, `${label} must not contain duplicates`);
  return Object.freeze([...paths].sort(compareCodeUnits));
}

function copyBytes(value: unknown): Uint8Array {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  )
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot candidate bytes are invalid");
  const bytes = value as Uint8Array;
  if (Reflect.ownKeys(bytes).length !== bytes.length)
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot candidate bytes have extra fields");
  for (let index = 0; index < bytes.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(bytes, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        CopilotProfileErrorCode.invalidInput,
        "Copilot candidate bytes are not canonical",
      );
  }
  if (bytes.byteLength > COPILOT_PROFILE_RESOLVER_LIMITS.maximumCandidateBytes)
    return fail(CopilotProfileErrorCode.resourceLimit, "Copilot candidate exceeds its byte limit");
  return Uint8Array.prototype.slice.call(bytes);
}

function eventState(value: unknown): CopilotRuntimeEventState {
  if (typeof value !== "string" || !EVENT_STATES.has(value as CopilotRuntimeEventState))
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot event state is invalid");
  return value as CopilotRuntimeEventState;
}

function settingState(value: unknown): CopilotRuntimeSettingState {
  if (typeof value !== "string" || !SETTING_STATES.has(value as CopilotRuntimeSettingState))
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot setting state is invalid");
  return value as CopilotRuntimeSettingState;
}

function containsPath(root: string, path: string): boolean {
  return root === REPOSITORY_ROOT || path === root || path.startsWith(`${root}/`);
}

function joinPath(root: RepositoryRelativePath, suffix: string): RepositoryRelativePath {
  return (root === REPOSITORY_ROOT ? suffix : `${root}/${suffix}`) as RepositoryRelativePath;
}

function cliLocations(value: unknown): readonly CopilotCliStandardLocation[] {
  const values = denseArray(
    value,
    COPILOT_PROFILE_RESOLVER_LIMITS.maximumLocations,
    "Copilot CLI standard locations",
  );
  if (values.length === 0)
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot CLI locations must not be empty");
  const locations = values.map((entry): CopilotCliStandardLocation => {
    const input = record(entry, CLI_LOCATION_KEYS, "Copilot CLI standard location");
    const kind = property(input, "kind");
    if (
      typeof kind !== "string" ||
      !CLI_LOCATION_KINDS.has(kind as CopilotCliStandardLocation["kind"])
    )
      return fail(CopilotProfileErrorCode.invalidInput, "Copilot CLI location kind is invalid");
    return Object.freeze({
      kind: kind as CopilotCliStandardLocation["kind"],
      path: pathValue(property(input, "path"), "Copilot CLI location path"),
    });
  });
  const identities = locations.map((entry) => `${entry.path}\0${entry.kind}`);
  if (new Set(identities).size !== identities.length)
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot CLI locations must be unique");
  return Object.freeze(
    [...locations].sort(
      (left, right) =>
        compareCodeUnits(left.path, right.path) || compareCodeUnits(left.kind, right.kind),
    ),
  );
}

function vscodeFolders(
  value: unknown,
  workspaceRoots: readonly RepositoryRelativePath[],
): readonly CopilotVscodeInstructionFolder[] {
  const values = denseArray(
    value,
    COPILOT_PROFILE_RESOLVER_LIMITS.maximumLocations,
    "VS Code instruction folders",
  );
  const folders = values.map((entry): CopilotVscodeInstructionFolder => {
    const input = record(entry, VSCODE_FOLDER_KEYS, "VS Code instruction folder");
    const path = pathValue(property(input, "path"), "VS Code instruction folder path");
    const workspaceRoot = pathValue(
      property(input, "workspaceRoot"),
      "VS Code instruction folder workspace root",
    );
    if (!workspaceRoots.includes(workspaceRoot) || !containsPath(workspaceRoot, path))
      return fail(
        CopilotProfileErrorCode.invalidInput,
        "VS Code instruction folder must belong to a declared workspace root",
      );
    return Object.freeze({ path, workspaceRoot });
  });
  const identities = folders.map((entry) => `${entry.path}\0${entry.workspaceRoot}`);
  if (new Set(identities).size !== identities.length)
    return fail(CopilotProfileErrorCode.invalidInput, "VS Code instruction folders must be unique");
  return Object.freeze(
    [...folders].sort(
      (left, right) =>
        compareCodeUnits(left.path, right.path) ||
        compareCodeUnits(left.workspaceRoot, right.workspaceRoot),
    ),
  );
}

function runtimeSnapshot(value: unknown): CopilotRuntimeSnapshot {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value))
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot runtime snapshot is invalid");
  const kind = property(value as DataRecord, "kind");
  if (kind === "copilot-cli") {
    const input = record(value, CLI_RUNTIME_KEYS, "Copilot CLI runtime");
    return Object.freeze({
      disabledPaths: pathArray(
        property(input, "disabledPaths"),
        COPILOT_PROFILE_RESOLVER_LIMITS.maximumCandidates,
        "Copilot CLI disabled paths",
        true,
      ),
      eventState: eventState(property(input, "eventState")),
      kind,
      standardLocations: cliLocations(property(input, "standardLocations")),
      targetPaths: pathArray(
        property(input, "targetPaths"),
        COPILOT_PROFILE_RESOLVER_LIMITS.maximumTargets,
        "Copilot CLI target paths",
      ),
    });
  }
  if (kind === "copilot-vscode") {
    const input = record(value, VSCODE_RUNTIME_KEYS, "Copilot VS Code runtime");
    const workspaceRoots = pathArray(
      property(input, "workspaceRoots"),
      COPILOT_PROFILE_RESOLVER_LIMITS.maximumLocations,
      "VS Code workspace roots",
    );
    return Object.freeze({
      applyingInstructions: settingState(property(input, "applyingInstructions")),
      eventState: eventState(property(input, "eventState")),
      instructionFolders: vscodeFolders(property(input, "instructionFolders"), workspaceRoots),
      kind,
      manualAttachments: pathArray(
        property(input, "manualAttachments"),
        COPILOT_PROFILE_RESOLVER_LIMITS.maximumCandidates,
        "VS Code manual attachments",
        true,
      ),
      targetPaths: pathArray(
        property(input, "targetPaths"),
        COPILOT_PROFILE_RESOLVER_LIMITS.maximumTargets,
        "VS Code target paths",
      ),
      workspaceRoots,
    });
  }
  if (kind === "copilot-cloud-agent") {
    const input = record(value, CLOUD_RUNTIME_KEYS, "Copilot cloud-agent runtime");
    return Object.freeze({
      eventState: eventState(property(input, "eventState")),
      kind,
      repositoryRoot: pathValue(property(input, "repositoryRoot"), "hosted repository root"),
      targetPaths: pathArray(
        property(input, "targetPaths"),
        COPILOT_PROFILE_RESOLVER_LIMITS.maximumTargets,
        "cloud-agent target paths",
      ),
    });
  }
  if (kind === "copilot-code-review") {
    const input = record(value, REVIEW_RUNTIME_KEYS, "Copilot code-review runtime");
    return Object.freeze({
      customInstructions: settingState(property(input, "customInstructions")),
      eventState: eventState(property(input, "eventState")),
      kind,
      repositoryRoot: pathValue(property(input, "repositoryRoot"), "review repository root"),
      targetPaths: pathArray(
        property(input, "targetPaths"),
        COPILOT_PROFILE_RESOLVER_LIMITS.maximumTargets,
        "code-review target paths",
      ),
    });
  }
  return fail(CopilotProfileErrorCode.invalidInput, "Copilot runtime kind is invalid");
}

function candidateSnapshot(value: unknown): CopilotInstructionCandidateSnapshot {
  const input = record(value, CANDIDATE_KEYS, "Copilot instruction candidate");
  const format = property(input, "format");
  if (typeof format !== "string" || !FORMATS.has(format as CopilotInstructionFormat))
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot candidate format is invalid");
  return Object.freeze({
    bytes: copyBytes(property(input, "bytes")),
    format: format as CopilotInstructionFormat,
    path: pathValue(property(input, "path"), "Copilot candidate path"),
  });
}

function snapshot(value: unknown): Snapshot {
  const input = record(value, INPUT_KEYS, "Copilot profile request");
  const profileId = property(input, "profileId");
  if (typeof profileId !== "string")
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot profile identity is invalid");
  const profile = copilotProfile(profileId);
  if (profile === undefined)
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot profile identity is unsupported");
  const runtime = runtimeSnapshot(property(input, "runtime"));
  if (runtime.kind !== profile.profileId)
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot runtime does not match its profile");
  const values = denseArray(
    property(input, "candidates"),
    COPILOT_PROFILE_RESOLVER_LIMITS.maximumCandidates,
    "Copilot candidates",
  );
  const candidates = values.map(candidateSnapshot);
  let totalBytes = 0;
  let totalPathBytes = 0;
  for (const candidate of candidates) {
    totalBytes += candidate.bytes.byteLength;
    totalPathBytes += Buffer.byteLength(candidate.path, "utf8");
  }
  const runtimePaths =
    runtime.kind === "copilot-cli"
      ? [
          ...runtime.disabledPaths,
          ...runtime.targetPaths,
          ...runtime.standardLocations.map((entry) => entry.path),
        ]
      : runtime.kind === "copilot-vscode"
        ? [
            ...runtime.manualAttachments,
            ...runtime.targetPaths,
            ...runtime.workspaceRoots,
            ...runtime.instructionFolders.flatMap((entry) => [entry.path, entry.workspaceRoot]),
          ]
        : [runtime.repositoryRoot, ...runtime.targetPaths];
  totalPathBytes += runtimePaths.reduce((sum, path) => sum + Buffer.byteLength(path, "utf8"), 0);
  if (totalBytes > COPILOT_PROFILE_RESOLVER_LIMITS.maximumTotalCandidateBytes)
    return fail(CopilotProfileErrorCode.resourceLimit, "Copilot candidates exceed total bytes");
  if (totalPathBytes > COPILOT_PROFILE_RESOLVER_LIMITS.maximumTotalPathBytes)
    return fail(CopilotProfileErrorCode.resourceLimit, "Copilot request exceeds total path bytes");
  const identities = candidates.map((candidate) => `${candidate.path}\0${candidate.format}`);
  if (new Set(identities).size !== identities.length)
    return fail(CopilotProfileErrorCode.invalidInput, "Copilot candidates must be unique");
  return Object.freeze({
    candidates: Object.freeze(
      [...candidates].sort(
        (left, right) =>
          compareCodeUnits(left.path, right.path) || compareCodeUnits(left.format, right.format),
      ),
    ),
    profile,
    runtime,
  });
}

function pathSpecificUnder(root: RepositoryRelativePath, path: RepositoryRelativePath): boolean {
  const folder = joinPath(root, ".github/instructions");
  return containsPath(folder, path) && path !== folder && path.endsWith(".instructions.md");
}

function discoverCli(
  candidate: CopilotInstructionCandidateSnapshot,
  runtime: CopilotCliRuntimeSnapshot,
): DiscoveryDecision {
  const matches = runtime.standardLocations.filter((location) =>
    candidate.format === "repository-wide"
      ? candidate.path === joinPath(location.path, ".github/copilot-instructions.md")
      : pathSpecificUnder(location.path, candidate.path),
  );
  if (matches.length === 0) return { scopeRoot: null, state: "not-discovered" };
  const eligible =
    candidate.format === "path-specific"
      ? matches.filter((location) => location.kind !== "intermediate-directory")
      : matches;
  if (eligible.length === 0) return { scopeRoot: null, state: "not-discovered" };
  const roots = [...new Set(eligible.map((location) => location.path))];
  if (roots.length > 1) return { scopeRoot: null, state: "unknown" };
  return { scopeRoot: roots[0] ?? null, state: "documented" };
}

function discoverVscode(
  candidate: CopilotInstructionCandidateSnapshot,
  runtime: CopilotVscodeRuntimeSnapshot,
): DiscoveryDecision {
  if (candidate.format === "repository-wide") {
    const roots = runtime.workspaceRoots.filter(
      (root) => candidate.path === joinPath(root, ".github/copilot-instructions.md"),
    );
    return roots.length === 1
      ? { scopeRoot: roots[0] ?? null, state: "documented" }
      : roots.length === 0
        ? { scopeRoot: null, state: "not-discovered" }
        : { scopeRoot: null, state: "unknown" };
  }
  const folders = runtime.instructionFolders.filter(
    (folder) =>
      containsPath(folder.path, candidate.path) &&
      candidate.path !== folder.path &&
      candidate.path.endsWith(".instructions.md"),
  );
  const roots = [...new Set(folders.map((folder) => folder.workspaceRoot))];
  return roots.length === 1
    ? { scopeRoot: roots[0] ?? null, state: "documented" }
    : roots.length === 0
      ? { scopeRoot: null, state: "not-discovered" }
      : { scopeRoot: null, state: "unknown" };
}

function discoverHosted(
  candidate: CopilotInstructionCandidateSnapshot,
  repositoryRoot: RepositoryRelativePath,
): DiscoveryDecision {
  const discovered =
    candidate.format === "repository-wide"
      ? candidate.path === joinPath(repositoryRoot, ".github/copilot-instructions.md")
      : pathSpecificUnder(repositoryRoot, candidate.path);
  return discovered
    ? { scopeRoot: repositoryRoot, state: "documented" }
    : { scopeRoot: null, state: "not-discovered" };
}

function discovery(
  candidate: CopilotInstructionCandidateSnapshot,
  runtime: CopilotRuntimeSnapshot,
): DiscoveryDecision {
  if (runtime.kind === "copilot-cli") return discoverCli(candidate, runtime);
  if (runtime.kind === "copilot-vscode") return discoverVscode(candidate, runtime);
  return discoverHosted(candidate, runtime.repositoryRoot);
}

function fixedTargetDecision(
  targetPath: RepositoryRelativePath,
  state: CopilotActivationState,
  code: CopilotProfileDecisionCode,
): CopilotTargetDecision {
  return Object.freeze({ code, reason: REASONS[code], state, targetPath });
}

function allTargets(
  targetPaths: readonly RepositoryRelativePath[],
  state: CopilotActivationState,
  code: CopilotProfileDecisionCode,
): readonly CopilotTargetDecision[] {
  return Object.freeze(
    targetPaths.map((targetPath) => fixedTargetDecision(targetPath, state, code)),
  );
}

function aggregateTargetState(targets: readonly CopilotTargetDecision[]): CopilotActivationState {
  if (targets.some((target) => target.state === "active")) return "active";
  if (targets.every((target) => target.state === "inactive")) return "inactive";
  return "indeterminate";
}

function aggregateTargetCode(
  targets: readonly CopilotTargetDecision[],
): CopilotProfileDecisionCode {
  if (targets.some((target) => target.state === "active")) return "documented-auto";
  if (targets.every((target) => target.state === "inactive")) return "documented-no-match";
  return targets.some((target) => target.code === "unknown-glob-semantics")
    ? "unknown-glob-semantics"
    : "unknown-target-state";
}

function globTargets(
  syntax: CopilotInstructionSyntaxResult,
  profile: CopilotProfileDescriptor,
  scopeRoot: RepositoryRelativePath,
  targets: readonly RepositoryRelativePath[],
): readonly CopilotTargetDecision[] {
  const claim = profile.formats.find((entry) => entry.formatId === "copilot-path-instructions");
  const dialectId = claim?.globDialectId;
  const patterns = syntax.applyTo.value;
  if (dialectId === undefined || dialectId === null || patterns === null)
    return allTargets(targets, "indeterminate", "unknown-target-state");
  return Object.freeze(
    targets.map((targetPath) => {
      let sawIndeterminate = false;
      for (const [index, pattern] of patterns.entries()) {
        const result = matchProfileGlob({
          dialectId,
          pattern,
          profileId: profile.profileId,
          ruleId: `activation:copilot:${index.toString(36)}` as ActivationRuleId,
          scopeRoot,
          surfaceId: profile.surfaceId,
          targetPath,
        });
        if (result.state === "active")
          return fixedTargetDecision(targetPath, "active", "documented-auto");
        if (result.state === "indeterminate") sawIndeterminate = true;
      }
      return sawIndeterminate
        ? fixedTargetDecision(targetPath, "indeterminate", "unknown-glob-semantics")
        : fixedTargetDecision(targetPath, "inactive", "documented-no-match");
    }),
  );
}

function syntaxFor(candidate: CopilotInstructionCandidateSnapshot): CopilotInstructionSyntaxResult {
  const identity = createHash("sha256")
    .update(candidate.path, "utf8")
    .update("\0", "utf8")
    .update(candidate.bytes)
    .digest("hex");
  return parseCopilotInstructionSyntax({
    bytes: candidate.bytes,
    documentId: `document:copilot:${identity}` as InstructionDocumentId,
    format: candidate.format,
    sourceId: `source:copilot:${identity}` as SourceDocumentId,
  });
}

function targetPaths(runtime: CopilotRuntimeSnapshot): readonly RepositoryRelativePath[] {
  return runtime.targetPaths;
}

function runtimeEventState(runtime: CopilotRuntimeSnapshot): CopilotRuntimeEventState {
  return runtime.eventState;
}

function decision(
  candidate: CopilotInstructionCandidateSnapshot,
  profile: CopilotProfileDescriptor,
  runtime: CopilotRuntimeSnapshot,
): CopilotCandidateDecision {
  const discovered = discovery(candidate, runtime);
  const syntax = syntaxFor(candidate);
  const targets = targetPaths(runtime);
  const finish = (
    activation: CopilotActivationState,
    code: CopilotProfileDecisionCode,
    eligibility: CopilotEligibilityState,
    targetDecisions: readonly CopilotTargetDecision[],
  ): CopilotCandidateDecision =>
    Object.freeze({
      activation,
      code,
      discovery: discovered.state,
      eligibility,
      format: candidate.format,
      path: candidate.path,
      reason: REASONS[code],
      scopeRoot: discovered.scopeRoot,
      syntax,
      targetDecisions,
    });

  if (discovered.state === "not-discovered")
    return finish(
      "inactive",
      "documented-not-discovered",
      "denied",
      allTargets(targets, "inactive", "documented-not-discovered"),
    );
  if (discovered.state === "unknown" || discovered.scopeRoot === null)
    return finish(
      "indeterminate",
      "unknown-discovery",
      "indeterminate",
      allTargets(targets, "indeterminate", "unknown-discovery"),
    );
  if (
    syntax.state === "malformed" ||
    (candidate.format === "path-specific" &&
      syntax.scopeAuthority === "denied" &&
      syntax.applyTo.state !== "absent")
  )
    return finish(
      "indeterminate",
      "malformed-syntax",
      "denied",
      allTargets(targets, "indeterminate", "malformed-syntax"),
    );
  if (runtime.kind === "copilot-cli" && runtime.disabledPaths.includes(candidate.path))
    return finish(
      "inactive",
      "documented-disabled",
      "denied",
      allTargets(targets, "inactive", "documented-disabled"),
    );
  if (
    candidate.format === "path-specific" &&
    ((runtime.kind === "copilot-cloud-agent" && syntax.excludeAgent.value === "cloud-agent") ||
      (runtime.kind === "copilot-code-review" && syntax.excludeAgent.value === "code-review"))
  )
    return finish(
      "inactive",
      "documented-exclusion",
      "denied",
      allTargets(targets, "inactive", "documented-exclusion"),
    );
  if (runtime.kind === "copilot-code-review" && runtime.customInstructions === "disabled")
    return finish(
      "inactive",
      "documented-disabled",
      "denied",
      allTargets(targets, "inactive", "documented-disabled"),
    );
  if (runtime.kind === "copilot-code-review" && runtime.customInstructions === "unknown")
    return finish(
      "indeterminate",
      "unknown-setting-state",
      "indeterminate",
      allTargets(targets, "indeterminate", "unknown-setting-state"),
    );
  const event = runtimeEventState(runtime);
  if (event === "absent")
    return finish(
      "inactive",
      "missing-runtime-event",
      "denied",
      allTargets(targets, "inactive", "missing-runtime-event"),
    );
  if (event === "unknown")
    return finish(
      "indeterminate",
      "unknown-event-state",
      "indeterminate",
      allTargets(targets, "indeterminate", "unknown-event-state"),
    );
  if (
    runtime.kind === "copilot-vscode" &&
    candidate.format === "path-specific" &&
    runtime.manualAttachments.includes(candidate.path)
  )
    return finish(
      "active",
      "manual-attachment",
      "allowed",
      allTargets(targets, "active", "manual-attachment"),
    );
  if (candidate.format === "repository-wide")
    return finish(
      "active",
      "documented-auto",
      "allowed",
      allTargets(targets, "active", "documented-auto"),
    );
  if (runtime.kind === "copilot-vscode" && runtime.applyingInstructions === "disabled")
    return finish(
      "inactive",
      "documented-disabled",
      "denied",
      allTargets(targets, "inactive", "documented-disabled"),
    );
  if (runtime.kind === "copilot-vscode" && runtime.applyingInstructions === "unknown")
    return finish(
      "indeterminate",
      "unknown-setting-state",
      "indeterminate",
      allTargets(targets, "indeterminate", "unknown-setting-state"),
    );
  if (syntax.applyTo.state === "absent")
    return finish(
      "indeterminate",
      runtime.kind === "copilot-vscode"
        ? "vscode-description-contradiction"
        : "unknown-target-state",
      "indeterminate",
      allTargets(
        targets,
        "indeterminate",
        runtime.kind === "copilot-vscode"
          ? "vscode-description-contradiction"
          : "unknown-target-state",
      ),
    );
  const resolvedTargets = globTargets(syntax, profile, discovered.scopeRoot, targets);
  const activation = aggregateTargetState(resolvedTargets);
  const code = aggregateTargetCode(resolvedTargets);
  return finish(
    activation,
    code,
    activation === "active" ? "allowed" : activation === "inactive" ? "denied" : "indeterminate",
    resolvedTargets,
  );
}

/**
 * Resolve repository-owned D07 instruction snapshots for exactly one Copilot surface. All client,
 * setting, event, and target state must be supplied explicitly; this function performs no I/O,
 * environment access, command execution, network activity, clock read, or model selection.
 */
export function resolveCopilotProfile(
  inputValue: ResolveCopilotProfileInput,
): CopilotProfileResolution {
  const input = snapshot(inputValue);
  const candidates = Object.freeze(
    input.candidates.map((candidate) => decision(candidate, input.profile, input.runtime)),
  );
  const result: CopilotProfileResolution = Object.freeze({
    analysisStatus: candidates.every(
      (candidate) =>
        candidate.activation !== "indeterminate" && candidate.syntax.state === "complete",
    )
      ? "complete"
      : "partial",
    candidates,
    contractVersion: COPILOT_PROFILE_RESOLVER_CONTRACT_VERSION,
    profile: input.profile,
    recordKind: "agent-context-copilot-profile-resolution",
    runtimeKind: input.runtime.kind,
  });
  ISSUED_COPILOT_RESOLUTIONS.add(result);
  return result;
}
