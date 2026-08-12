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
  CURSOR_GLOB_DIALECT_ID,
  CURSOR_PROFILE_ID,
  cursorSurfaceProfile,
  type CursorSurfaceId,
  type CursorSurfaceProfileDescriptor,
} from "@agent-context/profiles";
import {
  parseCursorRuleSyntax,
  type CursorRuleFormat,
  type CursorRuleSyntaxResult,
} from "@agent-context/syntax";

import { matchProfileGlob } from "./profile-glob-dialects.js";

export const CURSOR_PROFILE_RESOLVER_CONTRACT_VERSION = "0.1.0" as const;

export interface CursorProfileResolverLimits {
  readonly maximumCandidateBytes: number;
  readonly maximumCandidates: number;
  readonly maximumEvents: number;
  readonly maximumPathBytes: number;
  readonly maximumRuleNameBytes: number;
  readonly maximumTotalCandidateBytes: number;
  readonly maximumTotalPathBytes: number;
  readonly maximumWorkspaceRoots: number;
}

export const CURSOR_PROFILE_RESOLVER_LIMITS: Readonly<CursorProfileResolverLimits> = Object.freeze({
  maximumCandidateBytes: 262_144,
  maximumCandidates: 4_096,
  maximumEvents: 16_384,
  maximumPathBytes: 16_384,
  maximumRuleNameBytes: 4_096,
  maximumTotalCandidateBytes: 16_777_216,
  maximumTotalPathBytes: 16_777_216,
  maximumWorkspaceRoots: 4_096,
});

export interface CursorRuleCandidateSnapshot {
  readonly bytes: Uint8Array;
  readonly format: CursorRuleFormat;
  readonly path: RepositoryRelativePath;
}

export type CursorRuntimeEventState = "absent" | "present" | "unknown";
export type CursorProjectRulesSetting = "disabled" | "enabled" | "unknown";
export type CursorExternalContextState = "absent" | "present" | "unknown";

export interface CursorPathRuntimeEvent {
  readonly kind: "read-path" | "reference-path" | "write-path";
  readonly sequence: number;
  readonly targetPath: RepositoryRelativePath;
}

export interface CursorManualRuntimeEvent {
  readonly candidatePath: RepositoryRelativePath | null;
  readonly kind: "manual-rule-mention";
  readonly ruleName: string;
  readonly sequence: number;
  readonly targetPath: RepositoryRelativePath;
}

export interface CursorAgentSelectionRuntimeEvent {
  readonly candidatePath: RepositoryRelativePath;
  readonly kind: "agent-rule-selection";
  readonly selection: "not-selected" | "selected" | "unknown";
  readonly sequence: number;
  readonly targetPath: RepositoryRelativePath;
}

export type CursorRuntimeEvent =
  CursorAgentSelectionRuntimeEvent | CursorManualRuntimeEvent | CursorPathRuntimeEvent;

export interface CursorRuntimeSnapshot {
  readonly clientVersion: string | null;
  readonly eventState: CursorRuntimeEventState;
  readonly events: readonly CursorRuntimeEvent[];
  readonly externalContext: CursorExternalContextState;
  readonly projectRules: CursorProjectRulesSetting;
  readonly surfaceId: CursorSurfaceId;
  readonly workspaceRoots: readonly RepositoryRelativePath[];
}

export interface ResolveCursorProfileInput {
  readonly candidates: readonly CursorRuleCandidateSnapshot[];
  readonly runtime: CursorRuntimeSnapshot;
}

export type CursorActivationState = "active" | "inactive" | "indeterminate";
export type CursorChannelState = CursorActivationState | "not-applicable";
export type CursorEligibilityState = "eligible" | "ineligible" | "indeterminate";
export type CursorSelectionState = "indeterminate" | "not-applicable" | "not-selected" | "selected";
export type CursorDiscoveryState = "documented" | "not-discovered" | "unknown";
export type CursorVersionState = "compatible" | "unknown" | "unsupported";

export type CursorProfileDecisionCode =
  | "agent-selection"
  | "always-event"
  | "auto-event"
  | "external-context"
  | "legacy-conditional"
  | "manual-mention"
  | "malformed-syntax"
  | "mixed-mode"
  | "no-runtime-event"
  | "not-discovered"
  | "project-rules-disabled"
  | "project-rules-setting-unknown"
  | "unsupported-version"
  | "unknown-mode"
  | "unknown-surface-support"
  | "unknown-version";

export interface CursorActivationChannels {
  readonly agentRequested: CursorSelectionState;
  readonly always: CursorChannelState;
  readonly autoAttached: CursorChannelState;
  readonly manual: CursorChannelState;
}

export interface CursorTargetDecision {
  readonly autoActivation: CursorChannelState;
  readonly eventKind: CursorPathRuntimeEvent["kind"];
  readonly globEligibility: CursorEligibilityState | "not-applicable";
  readonly locationEligibility: CursorEligibilityState;
  readonly reason: string;
  readonly sequence: number;
  readonly targetPath: RepositoryRelativePath;
  readonly versionSupport: CursorVersionState;
}

export interface CursorReferenceDecision {
  readonly candidateBases: readonly ["rule-directory", "workspace-root"];
  readonly rawSpecifier: string;
  readonly reason: string;
  readonly referenceId: string;
  readonly state: CursorActivationState;
}

export interface CursorCandidateDecision {
  readonly activation: CursorActivationState;
  readonly channels: CursorActivationChannels;
  readonly code: CursorProfileDecisionCode;
  readonly discovery: CursorDiscoveryState;
  readonly format: CursorRuleFormat;
  readonly mechanicalActivation: CursorActivationState;
  readonly path: RepositoryRelativePath;
  readonly reason: string;
  readonly references: readonly CursorReferenceDecision[];
  readonly ruleName: string;
  readonly scopeRoot: RepositoryRelativePath | null;
  readonly syntax: CursorRuleSyntaxResult;
  readonly targetDecisions: readonly CursorTargetDecision[];
  readonly versionState: CursorVersionState;
}

export interface CursorProfileResolution {
  readonly analysisStatus: "complete" | "partial";
  readonly candidates: readonly CursorCandidateDecision[];
  readonly contractVersion: typeof CURSOR_PROFILE_RESOLVER_CONTRACT_VERSION;
  readonly externalContext: CursorExternalContextState;
  readonly profile: CursorSurfaceProfileDescriptor;
  readonly recordKind: "agent-context-cursor-profile-resolution";
  readonly runtime: CursorRuntimeSnapshot;
}

const ISSUED_CURSOR_RESOLUTIONS = new WeakSet<object>();

/** True only for resolutions produced by this process's D13 resolver. */
export function isIssuedCursorProfileResolution(value: unknown): value is CursorProfileResolution {
  return typeof value === "object" && value !== null && ISSUED_CURSOR_RESOLUTIONS.has(value);
}

export const CursorProfileErrorCode: Readonly<{
  invalidInput: "CURSOR_PROFILE_INVALID_INPUT";
  resourceLimit: "CURSOR_PROFILE_RESOURCE_LIMIT";
}> = Object.freeze({
  invalidInput: "CURSOR_PROFILE_INVALID_INPUT",
  resourceLimit: "CURSOR_PROFILE_RESOURCE_LIMIT",
});

export type CursorProfileErrorCode =
  (typeof CursorProfileErrorCode)[keyof typeof CursorProfileErrorCode];

export class CursorProfileError extends Error {
  override readonly name = "CursorProfileError" as const;
  readonly code: CursorProfileErrorCode;

  constructor(code: CursorProfileErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;

interface Snapshot {
  readonly candidates: readonly CursorRuleCandidateSnapshot[];
  readonly profile: CursorSurfaceProfileDescriptor;
  readonly runtime: CursorRuntimeSnapshot;
}

const INPUT_KEYS = Object.freeze(["candidates", "runtime"]);
const CANDIDATE_KEYS = Object.freeze(["bytes", "format", "path"]);
const RUNTIME_KEYS = Object.freeze([
  "clientVersion",
  "eventState",
  "events",
  "externalContext",
  "projectRules",
  "surfaceId",
  "workspaceRoots",
]);
const PATH_EVENT_KEYS = Object.freeze(["kind", "sequence", "targetPath"]);
const MANUAL_EVENT_KEYS = Object.freeze([
  "candidatePath",
  "kind",
  "ruleName",
  "sequence",
  "targetPath",
]);
const AGENT_EVENT_KEYS = Object.freeze([
  "candidatePath",
  "kind",
  "selection",
  "sequence",
  "targetPath",
]);
const PATH_EVENT_KINDS = new Set(["read-path", "reference-path", "write-path"]);
const EVENT_STATES = new Set(["absent", "present", "unknown"]);
const PROJECT_RULE_STATES = new Set(["disabled", "enabled", "unknown"]);
const EXTERNAL_CONTEXT_STATES = new Set(["absent", "present", "unknown"]);
const SELECTION_STATES = new Set(["not-selected", "selected", "unknown"]);
const FORMATS = new Set(["legacy", "mdc"]);
const SURFACES = new Set(["cursor-agent/ide", "cursor-agent/cli"]);
const STABLE_TEXT = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const REFERENCE_BASES: readonly ["rule-directory", "workspace-root"] = Object.freeze([
  "rule-directory",
  "workspace-root",
]);

const REASONS: Readonly<Record<CursorProfileDecisionCode, string>> = Object.freeze({
  "agent-selection": "Agent Requested activation remains separate from mechanical activation.",
  "always-event": "The documented Always channel is active for the supplied runtime event.",
  "auto-event":
    "The Auto channel is evaluated only from supplied path events and Cursor's dialect.",
  "external-context": "Unseen user or team context can change the effective Cursor context.",
  "legacy-conditional":
    "Legacy syntax is recognized but its activation and MDC precedence are unknown.",
  "manual-mention": "A supplied explicit rule mention selects the Manual channel.",
  "malformed-syntax": "Malformed or non-authoritative rule syntax cannot establish activation.",
  "mixed-mode": "Undocumented field-channel interaction keeps final activation indeterminate.",
  "no-runtime-event": "No complete runtime event trace was supplied; activation is not fabricated.",
  "not-discovered": "The candidate is outside the supplied workspace discovery roots.",
  "project-rules-disabled": "The supplied client setting disables MDC project rules.",
  "project-rules-setting-unknown": "The project-rules setting is unavailable.",
  "unsupported-version": "The supplied client version predates documented MDC support.",
  "unknown-mode": "Missing or unsupported mode syntax cannot establish activation.",
  "unknown-surface-support":
    "This format is not independently established for the selected surface.",
  "unknown-version": "The supplied client version is not covered by the pinned profile evidence.",
});

function fail(code: CursorProfileErrorCode, message: string): never {
  throw new CursorProfileError(code, message);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function record(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return fail(CursorProfileErrorCode.invalidInput, `${label} must be a plain record`);
  }
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return fail(CursorProfileErrorCode.invalidInput, `${label} cannot be inspected`);
  }
  if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length) {
    return fail(CursorProfileErrorCode.invalidInput, `${label} must be closed`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== "string" || !keys.includes(key)) {
      return fail(CursorProfileErrorCode.invalidInput, `${label} has an unknown field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(CursorProfileErrorCode.invalidInput, `${label} must use enumerable data fields`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function array(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value)) {
    return fail(CursorProfileErrorCode.invalidInput, `${label} must be an array`);
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return fail(CursorProfileErrorCode.invalidInput, `${label} cannot be inspected`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    prototype !== Array.prototype ||
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number"
  ) {
    return fail(CursorProfileErrorCode.invalidInput, `${label} must be an ordinary array`);
  }
  const length = lengthDescriptor.value;
  if (length > maximum) {
    return fail(CursorProfileErrorCode.resourceLimit, `${label} exceeds its item limit`);
  }
  if (keys.length !== length + 1) {
    return fail(CursorProfileErrorCode.invalidInput, `${label} must be dense and closed`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(CursorProfileErrorCode.invalidInput, `${label} must contain only data elements`);
    }
    output.push(descriptor.value);
  }
  return Object.freeze(output);
}

function enumValue(value: unknown, values: ReadonlySet<string>, label: string): string {
  if (typeof value !== "string" || !values.has(value)) {
    return fail(CursorProfileErrorCode.invalidInput, `${label} is unsupported`);
  }
  return value;
}

function pathValue(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || !isRepositoryRelativePath(value)) {
    return fail(CursorProfileErrorCode.invalidInput, `${label} must be repository-relative`);
  }
  if (Buffer.byteLength(value, "utf8") > CURSOR_PROFILE_RESOLVER_LIMITS.maximumPathBytes) {
    return fail(CursorProfileErrorCode.resourceLimit, `${label} exceeds its byte limit`);
  }
  return value;
}

function snapshotBytes(value: unknown): Uint8Array {
  if (
    TYPED_ARRAY_BYTE_LENGTH === undefined ||
    !nodeTypes.isUint8Array(value) ||
    nodeTypes.isProxy(value)
  ) {
    return fail(
      CursorProfileErrorCode.invalidInput,
      "candidate bytes must be an intrinsic Uint8Array",
    );
  }
  let length: number;
  try {
    length = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as number;
  } catch {
    return fail(CursorProfileErrorCode.invalidInput, "candidate bytes cannot be inspected");
  }
  if (length > CURSOR_PROFILE_RESOLVER_LIMITS.maximumCandidateBytes) {
    return fail(CursorProfileErrorCode.resourceLimit, "candidate bytes exceed their byte limit");
  }
  const output = new Uint8Array(length);
  try {
    Reflect.apply(UINT8_ARRAY_SET, output, [value]);
  } catch {
    return fail(CursorProfileErrorCode.invalidInput, "candidate bytes cannot be copied");
  }
  return output;
}

function sequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(
      CursorProfileErrorCode.invalidInput,
      "event sequence must be a non-negative integer",
    );
  }
  return value;
}

function ruleName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !STABLE_TEXT.test(value) ||
    Buffer.byteLength(value, "utf8") > CURSOR_PROFILE_RESOLVER_LIMITS.maximumRuleNameBytes
  ) {
    return fail(CursorProfileErrorCode.invalidInput, "manual ruleName must be bounded stable text");
  }
  return value;
}

function candidateSnapshot(value: unknown): CursorRuleCandidateSnapshot {
  const input = record(value, CANDIDATE_KEYS, "candidate");
  return Object.freeze({
    bytes: snapshotBytes(input["bytes"]),
    format: enumValue(input["format"], FORMATS, "candidate format") as CursorRuleFormat,
    path: pathValue(input["path"], "candidate path"),
  });
}

function eventSnapshot(value: unknown): CursorRuntimeEvent {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    return fail(CursorProfileErrorCode.invalidInput, "event must be a plain record");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string"
  ) {
    return fail(CursorProfileErrorCode.invalidInput, "event kind must be a data field");
  }
  if (PATH_EVENT_KINDS.has(descriptor.value)) {
    const input = record(value, PATH_EVENT_KEYS, "path event");
    return Object.freeze({
      kind: descriptor.value as CursorPathRuntimeEvent["kind"],
      sequence: sequence(input["sequence"]),
      targetPath: pathValue(input["targetPath"], "event targetPath"),
    });
  }
  if (descriptor.value === "manual-rule-mention") {
    const input = record(value, MANUAL_EVENT_KEYS, "manual event");
    const candidatePath = input["candidatePath"];
    return Object.freeze({
      candidatePath:
        candidatePath === null ? null : pathValue(candidatePath, "manual candidatePath"),
      kind: "manual-rule-mention",
      ruleName: ruleName(input["ruleName"]),
      sequence: sequence(input["sequence"]),
      targetPath: pathValue(input["targetPath"], "manual targetPath"),
    });
  }
  if (descriptor.value === "agent-rule-selection") {
    const input = record(value, AGENT_EVENT_KEYS, "agent selection event");
    return Object.freeze({
      candidatePath: pathValue(input["candidatePath"], "selection candidatePath"),
      kind: "agent-rule-selection",
      selection: enumValue(
        input["selection"],
        SELECTION_STATES,
        "agent selection",
      ) as CursorAgentSelectionRuntimeEvent["selection"],
      sequence: sequence(input["sequence"]),
      targetPath: pathValue(input["targetPath"], "selection targetPath"),
    });
  }
  return fail(CursorProfileErrorCode.invalidInput, "event kind is unsupported");
}

function validateInput(value: unknown): Snapshot {
  const input = record(value, INPUT_KEYS, "Cursor profile input");
  const candidateValues = array(
    input["candidates"],
    CURSOR_PROFILE_RESOLVER_LIMITS.maximumCandidates,
    "candidates",
  );
  const candidates = candidateValues.map(candidateSnapshot).sort((left, right) => {
    const pathOrder = compareText(left.path, right.path);
    return pathOrder === 0 ? compareText(left.format, right.format) : pathOrder;
  });
  let candidateBytes = 0;
  const candidatePaths = new Set<string>();
  for (const candidate of candidates) {
    candidateBytes += candidate.bytes.byteLength;
    if (candidateBytes > CURSOR_PROFILE_RESOLVER_LIMITS.maximumTotalCandidateBytes) {
      return fail(
        CursorProfileErrorCode.resourceLimit,
        "candidates exceed their aggregate byte limit",
      );
    }
    if (candidatePaths.has(candidate.path)) {
      return fail(CursorProfileErrorCode.invalidInput, "candidate paths must be unique");
    }
    candidatePaths.add(candidate.path);
  }

  const runtimeInput = record(input["runtime"], RUNTIME_KEYS, "runtime");
  const surfaceId = enumValue(runtimeInput["surfaceId"], SURFACES, "surfaceId") as CursorSurfaceId;
  const profile = cursorSurfaceProfile(surfaceId);
  if (profile === undefined)
    return fail(CursorProfileErrorCode.invalidInput, "surface profile is unavailable");
  const roots = array(
    runtimeInput["workspaceRoots"],
    CURSOR_PROFILE_RESOLVER_LIMITS.maximumWorkspaceRoots,
    "workspaceRoots",
  )
    .map((root) => pathValue(root, "workspace root"))
    .sort(compareText);
  if (roots.length === 0 || new Set(roots).size !== roots.length) {
    return fail(CursorProfileErrorCode.invalidInput, "workspaceRoots must be non-empty and unique");
  }
  const events = array(
    runtimeInput["events"],
    CURSOR_PROFILE_RESOLVER_LIMITS.maximumEvents,
    "events",
  )
    .map(eventSnapshot)
    .sort((left, right) => left.sequence - right.sequence || compareText(left.kind, right.kind));
  if (new Set(events.map((event) => event.sequence)).size !== events.length) {
    return fail(CursorProfileErrorCode.invalidInput, "event sequences must be unique");
  }
  const eventState = enumValue(
    runtimeInput["eventState"],
    EVENT_STATES,
    "eventState",
  ) as CursorRuntimeEventState;
  if (eventState === "present" && events.length === 0) {
    return fail(CursorProfileErrorCode.invalidInput, "present eventState requires an event");
  }
  if (eventState === "absent" && events.length !== 0) {
    return fail(CursorProfileErrorCode.invalidInput, "absent eventState forbids events");
  }
  const clientVersion = runtimeInput["clientVersion"];
  if (
    clientVersion !== null &&
    (typeof clientVersion !== "string" ||
      clientVersion.length === 0 ||
      clientVersion.length > 128 ||
      !STABLE_TEXT.test(clientVersion))
  ) {
    return fail(CursorProfileErrorCode.invalidInput, "clientVersion must be null or stable text");
  }
  let totalPathBytes = candidates.reduce(
    (total, candidate) => total + Buffer.byteLength(candidate.path, "utf8"),
    0,
  );
  for (const root of roots) totalPathBytes += Buffer.byteLength(root, "utf8");
  for (const event of events) {
    totalPathBytes += Buffer.byteLength(event.targetPath, "utf8");
    if ("candidatePath" in event && event.candidatePath !== null) {
      totalPathBytes += Buffer.byteLength(event.candidatePath, "utf8");
    }
  }
  if (totalPathBytes > CURSOR_PROFILE_RESOLVER_LIMITS.maximumTotalPathBytes) {
    return fail(
      CursorProfileErrorCode.resourceLimit,
      "Cursor profile paths exceed their aggregate limit",
    );
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    profile,
    runtime: Object.freeze({
      clientVersion,
      eventState,
      events: Object.freeze(events),
      externalContext: enumValue(
        runtimeInput["externalContext"],
        EXTERNAL_CONTEXT_STATES,
        "externalContext",
      ) as CursorExternalContextState,
      projectRules: enumValue(
        runtimeInput["projectRules"],
        PROJECT_RULE_STATES,
        "projectRules",
      ) as CursorProjectRulesSetting,
      surfaceId,
      workspaceRoots: Object.freeze(roots),
    }),
  });
}

function isInside(path: RepositoryRelativePath, root: RepositoryRelativePath): boolean {
  return root === REPOSITORY_ROOT || path === root || path.startsWith(`${root}/`);
}

function discovery(
  path: RepositoryRelativePath,
  roots: readonly RepositoryRelativePath[],
): CursorDiscoveryState {
  const matches = roots.filter((root) => isInside(path, root)).length;
  return matches === 0 ? "not-discovered" : matches === 1 ? "documented" : "unknown";
}

function parseIdeVersion(value: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (match === null) return null;
  const values = match.slice(1).map(Number);
  if (values.some((entry) => !Number.isSafeInteger(entry))) return null;
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}

function atLeast(value: readonly number[], expected: readonly number[]): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    const current = value[index] ?? 0;
    const boundary = expected[index] ?? 0;
    if (current !== boundary) return current > boundary;
  }
  return true;
}

function versionState(runtime: CursorRuntimeSnapshot): CursorVersionState {
  if (runtime.clientVersion === null) return "unknown";
  if (runtime.surfaceId === "cursor-agent/cli") {
    return runtime.clientVersion === "2026.05.24-dda726e" ? "compatible" : "unknown";
  }
  const parsed = parseIdeVersion(runtime.clientVersion);
  if (parsed === null) return "unknown";
  return atLeast(parsed, [0, 45, 0]) ? "compatible" : "unsupported";
}

function readWriteVersion(runtime: CursorRuntimeSnapshot): CursorVersionState {
  if (runtime.surfaceId === "cursor-agent/cli") return "unknown";
  if (runtime.clientVersion === null) return "unknown";
  const parsed = parseIdeVersion(runtime.clientVersion);
  return parsed !== null && atLeast(parsed, [0, 49, 0]) ? "compatible" : "unsupported";
}

function derivedRuleName(path: RepositoryRelativePath, format: CursorRuleFormat): string {
  if (format === "legacy") return ".cursorrules";
  const filename = path.split("/").at(-1) ?? path;
  return filename.endsWith(".mdc") ? filename.slice(0, -4) : filename;
}

function stableIds(path: RepositoryRelativePath): {
  readonly documentId: InstructionDocumentId;
  readonly sourceId: SourceDocumentId;
} {
  const digest = createHash("sha256").update(path).digest("hex");
  return Object.freeze({
    documentId: `document:cursor:${digest}` as InstructionDocumentId,
    sourceId: `source:cursor:${digest}` as SourceDocumentId,
  });
}

function channelState(values: readonly CursorChannelState[]): CursorActivationState {
  if (values.includes("active")) return "active";
  if (values.includes("indeterminate")) return "indeterminate";
  return "inactive";
}

function locationForTarget(
  targetPath: RepositoryRelativePath,
  scopeRoot: RepositoryRelativePath | null,
): CursorEligibilityState {
  if (scopeRoot === null) return "indeterminate";
  return isInside(targetPath, scopeRoot) ? "eligible" : "ineligible";
}

function targetDecisions(
  path: RepositoryRelativePath,
  syntax: CursorRuleSyntaxResult,
  runtime: CursorRuntimeSnapshot,
): readonly CursorTargetDecision[] {
  const patterns = syntax.globs.value?.patterns ?? [];
  return Object.freeze(
    runtime.events
      .filter((event): event is CursorPathRuntimeEvent => PATH_EVENT_KINDS.has(event.kind))
      .map((event): CursorTargetDecision => {
        const locationEligibility = locationForTarget(event.targetPath, syntax.location.scopeRoot);
        const eventVersion =
          event.kind === "reference-path" ? versionState(runtime) : readWriteVersion(runtime);
        if (locationEligibility === "ineligible") {
          return Object.freeze({
            autoActivation: "inactive",
            eventKind: event.kind,
            globEligibility: patterns.length === 0 ? "not-applicable" : "ineligible",
            locationEligibility,
            reason: "The target event is outside the rule's nested scope.",
            sequence: event.sequence,
            targetPath: event.targetPath,
            versionSupport: eventVersion,
          });
        }
        if (patterns.length === 0) {
          return Object.freeze({
            autoActivation: "not-applicable",
            eventKind: event.kind,
            globEligibility: "not-applicable",
            locationEligibility,
            reason: "The rule has no non-empty glob syntax signal.",
            sequence: event.sequence,
            targetPath: event.targetPath,
            versionSupport: eventVersion,
          });
        }
        if (eventVersion !== "compatible") {
          return Object.freeze({
            autoActivation: eventVersion === "unsupported" ? "inactive" : "indeterminate",
            eventKind: event.kind,
            globEligibility: "indeterminate",
            locationEligibility,
            reason: "This path event is not covered by the supplied client-version evidence.",
            sequence: event.sequence,
            targetPath: event.targetPath,
            versionSupport: eventVersion,
          });
        }
        let sawUnknown = locationEligibility === "indeterminate";
        let sawActive = false;
        for (const pattern of patterns) {
          const matched = matchProfileGlob({
            dialectId: CURSOR_GLOB_DIALECT_ID,
            pattern: pattern.value,
            profileId: CURSOR_PROFILE_ID,
            ruleId: `cursor:${path}` as ActivationRuleId,
            scopeRoot: syntax.location.scopeRoot ?? REPOSITORY_ROOT,
            surfaceId: runtime.surfaceId,
            targetPath: event.targetPath,
          });
          if (matched.state === "active") sawActive = true;
          else if (matched.state === "indeterminate") sawUnknown = true;
        }
        const globEligibility: CursorEligibilityState = sawActive
          ? "eligible"
          : sawUnknown
            ? "indeterminate"
            : "ineligible";
        return Object.freeze({
          autoActivation:
            locationEligibility === "eligible" && globEligibility === "eligible"
              ? "active"
              : globEligibility === "ineligible"
                ? "inactive"
                : "indeterminate",
          eventKind: event.kind,
          globEligibility,
          locationEligibility,
          reason:
            globEligibility === "indeterminate"
              ? "Cursor's profile-owned glob dialect does not document enough behavior."
              : "Location and documented glob facts determine this Auto event.",
          sequence: event.sequence,
          targetPath: event.targetPath,
          versionSupport: eventVersion,
        });
      }),
  );
}

function alwaysChannel(
  syntax: CursorRuleSyntaxResult,
  runtime: CursorRuntimeSnapshot,
): CursorChannelState {
  if (syntax.alwaysApply.value !== true) return "not-applicable";
  if (runtime.eventState !== "present") return "indeterminate";
  if (syntax.location.scopeRoot === REPOSITORY_ROOT) return "active";
  const eligibility = runtime.events.map((event) =>
    locationForTarget(event.targetPath, syntax.location.scopeRoot),
  );
  return eligibility.includes("eligible")
    ? "active"
    : eligibility.includes("indeterminate")
      ? "indeterminate"
      : "inactive";
}

function autoChannel(
  syntax: CursorRuleSyntaxResult,
  targets: readonly CursorTargetDecision[],
): CursorChannelState {
  if (syntax.globs.state !== "valid") return "not-applicable";
  if (targets.length === 0) return "indeterminate";
  return channelState(targets.map((target) => target.autoActivation));
}

function manualChannel(
  candidatePath: RepositoryRelativePath,
  name: string,
  syntax: CursorRuleSyntaxResult,
  runtime: CursorRuntimeSnapshot,
  nameCounts: ReadonlyMap<string, number>,
): CursorChannelState {
  if (syntax.modeSyntax.classification !== "manual") return "not-applicable";
  const events = runtime.events.filter(
    (event): event is CursorManualRuntimeEvent => event.kind === "manual-rule-mention",
  );
  if (events.length === 0) return runtime.eventState === "present" ? "inactive" : "indeterminate";
  let sawAmbiguous = false;
  for (const event of events) {
    if (event.ruleName !== name) continue;
    if (locationForTarget(event.targetPath, syntax.location.scopeRoot) !== "eligible") continue;
    if (event.candidatePath === candidatePath) return "active";
    if (event.candidatePath === null) {
      if ((nameCounts.get(name) ?? 0) === 1) return "active";
      sawAmbiguous = true;
    }
  }
  return sawAmbiguous ? "indeterminate" : "inactive";
}

function agentSelection(
  candidatePath: RepositoryRelativePath,
  syntax: CursorRuleSyntaxResult,
  runtime: CursorRuntimeSnapshot,
): CursorSelectionState {
  if (syntax.description.state !== "valid") return "not-applicable";
  const selected = runtime.events
    .filter(
      (event): event is CursorAgentSelectionRuntimeEvent =>
        event.kind === "agent-rule-selection" && event.candidatePath === candidatePath,
    )
    .filter(
      (event) => locationForTarget(event.targetPath, syntax.location.scopeRoot) === "eligible",
    )
    .at(-1);
  return selected?.selection === "selected"
    ? "selected"
    : selected?.selection === "not-selected"
      ? "not-selected"
      : "indeterminate";
}

function referenceDecisions(
  syntax: CursorRuleSyntaxResult,
  activation: CursorActivationState,
): readonly CursorReferenceDecision[] {
  return Object.freeze(
    syntax.references.map((reference) =>
      Object.freeze({
        candidateBases: REFERENCE_BASES,
        rawSpecifier: reference.rawSpecifier,
        reason:
          activation === "inactive"
            ? "The containing rule is inactive, so the reference is not loaded."
            : "The containing rule may contribute, but Cursor's reference base is undocumented.",
        referenceId: reference.id,
        state: activation === "inactive" ? "inactive" : "indeterminate",
      }),
    ),
  );
}

function decideCandidate(
  candidate: CursorRuleCandidateSnapshot,
  snapshot: Snapshot,
  nameCounts: ReadonlyMap<string, number>,
  coexistence: boolean,
): CursorCandidateDecision {
  const ids = stableIds(candidate.path);
  const syntax = parseCursorRuleSyntax({
    bytes: candidate.bytes,
    documentId: ids.documentId,
    format: candidate.format,
    path: candidate.path,
    sourceId: ids.sourceId,
  });
  const name = derivedRuleName(candidate.path, candidate.format);
  const discovered = discovery(candidate.path, snapshot.runtime.workspaceRoots);
  const version = versionState(snapshot.runtime);
  const targets = targetDecisions(candidate.path, syntax, snapshot.runtime);
  const channels: CursorActivationChannels = Object.freeze({
    agentRequested: agentSelection(candidate.path, syntax, snapshot.runtime),
    always: alwaysChannel(syntax, snapshot.runtime),
    autoAttached: autoChannel(syntax, targets),
    manual: manualChannel(candidate.path, name, syntax, snapshot.runtime, nameCounts),
  });
  const mechanical = channelState([channels.always, channels.autoAttached, channels.manual]);

  let activation: CursorActivationState = "indeterminate";
  let code: CursorProfileDecisionCode = "unknown-mode";
  if (discovered === "not-discovered") {
    activation = "inactive";
    code = "not-discovered";
  } else if (syntax.state === "malformed") {
    activation = "inactive";
    code = "malformed-syntax";
  } else if (candidate.format === "mdc" && version === "unsupported") {
    activation = "inactive";
    code = "unsupported-version";
  } else if (version === "unknown") {
    code = "unknown-version";
  } else if (candidate.format === "legacy") {
    code =
      snapshot.profile.formats.find((format) => format.formatId === "cursor-legacy-rules")
        ?.support === "supported"
        ? "legacy-conditional"
        : "unknown-surface-support";
  } else if (snapshot.runtime.projectRules === "disabled") {
    activation = "inactive";
    code = "project-rules-disabled";
  } else if (snapshot.runtime.projectRules === "unknown") {
    code = "project-rules-setting-unknown";
  } else if (snapshot.runtime.eventState !== "present") {
    code = "no-runtime-event";
  } else if (
    coexistence ||
    syntax.modeSyntax.classification === "mixed" ||
    syntax.modeSyntax.state === "conditional" ||
    (mechanical !== "inactive" &&
      syntax.location.scopeRoot !== REPOSITORY_ROOT &&
      ["always", "auto-attached"].includes(syntax.modeSyntax.classification))
  ) {
    code = "mixed-mode";
  } else if (syntax.modeSyntax.classification === "always") {
    activation = mechanical;
    code = "always-event";
  } else if (syntax.modeSyntax.classification === "auto-attached") {
    activation = mechanical;
    code = "auto-event";
  } else if (syntax.modeSyntax.classification === "manual") {
    activation = mechanical;
    code = "manual-mention";
  } else if (syntax.modeSyntax.classification === "agent-requested") {
    activation =
      channels.agentRequested === "selected"
        ? "active"
        : channels.agentRequested === "not-selected"
          ? "inactive"
          : "indeterminate";
    code = "agent-selection";
  }
  if (discovered === "unknown" && activation !== "inactive") activation = "indeterminate";
  if (snapshot.runtime.externalContext !== "absent" && activation === "active") {
    code = "external-context";
  }
  return Object.freeze({
    activation,
    channels,
    code,
    discovery: discovered,
    format: candidate.format,
    mechanicalActivation: mechanical,
    path: candidate.path,
    reason: REASONS[code],
    references: referenceDecisions(syntax, activation),
    ruleName: name,
    scopeRoot: syntax.location.scopeRoot,
    syntax,
    targetDecisions: targets,
    versionState: version,
  });
}

/**
 * Resolve authorized Cursor snapshots against an explicit runtime trace. This function is pure,
 * offline, read-only, and model-free; Agent Requested relevance changes only through supplied
 * agent-rule-selection events.
 */
export function resolveCursorProfile(rawInput: unknown): CursorProfileResolution {
  const snapshot = validateInput(rawInput);
  const nameCounts = new Map<string, number>();
  for (const candidate of snapshot.candidates) {
    const name = derivedRuleName(candidate.path, candidate.format);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const hasLegacy = snapshot.candidates.some((candidate) => candidate.format === "legacy");
  const hasMdc = snapshot.candidates.some((candidate) => candidate.format === "mdc");
  const coexistence = hasLegacy && hasMdc;
  const candidates = Object.freeze(
    snapshot.candidates.map((candidate) =>
      decideCandidate(candidate, snapshot, nameCounts, coexistence),
    ),
  );
  const result: CursorProfileResolution = Object.freeze({
    analysisStatus:
      snapshot.runtime.externalContext === "absent" &&
      candidates.every((candidate) => candidate.activation !== "indeterminate")
        ? "complete"
        : "partial",
    candidates,
    contractVersion: CURSOR_PROFILE_RESOLVER_CONTRACT_VERSION,
    externalContext: snapshot.runtime.externalContext,
    profile: snapshot.profile,
    recordKind: "agent-context-cursor-profile-resolution",
    runtime: snapshot.runtime,
  });
  ISSUED_CURSOR_RESOLUTIONS.add(result);
  return result;
}
