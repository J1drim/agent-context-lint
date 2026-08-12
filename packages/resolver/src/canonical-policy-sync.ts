import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
  canonicalizeRepositoryRelativePath,
  computePathFingerprint,
  computeSemanticFingerprint,
  isRepositoryRelativePath,
  validateDiagnosticBundle,
} from "@agent-context/core";
import type {
  AtomicFixPlan,
  ClientProfileId,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticId,
  DocumentFormatId,
  FixPlanId,
  InstructionDocumentId,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
  SourceRange,
  SpecSnapshotId,
  SurfaceId,
} from "@agent-context/core";
import {
  CLAUDE_CODE_PROFILE,
  CODEX_CLI_PROFILE,
  COPILOT_PROFILES,
  CURSOR_SURFACE_PROFILES,
  GEMINI_CLI_PROFILE,
} from "@agent-context/profiles";
import {
  parseAgentsMarkdown,
  parseClaudeInstructionSyntax,
  parseCopilotInstructionSyntax,
  parseCursorRuleSyntax,
  parseGeminiContext,
} from "@agent-context/syntax";

import {
  ReadOnlyRepositoryFile,
  SAFE_FIX_HARD_MINIMUM_CONFIDENCE,
  createSafeFixPipeline,
  issueSafeFixEligibility,
} from "@agent-context/evidence";
import type {
  SafeFixApplyResult,
  SafeFixPipeline,
  SafeFixPreview,
  SafeFixSourceSnapshot,
  ReadOnlyRepository,
} from "@agent-context/evidence";
import type { RepositoryRootSelection } from "@agent-context/evidence";

import { resolveClaudeCodeProfile } from "./claude-code-profile.js";
import { resolveCodexCliAgents } from "./codex-cli-profile.js";
import { resolveCopilotProfile } from "./copilot-profile.js";
import { resolveCursorProfile } from "./cursor-profile.js";
import { resolveGeminiCliContext } from "./gemini-cli-profile.js";

export const CANONICAL_POLICY_SYNC_CONTRACT_VERSION = "1.0.0" as const;
export const CANONICAL_POLICY_PREVIEW_RECORD_KIND =
  "agent-context-canonical-policy-preview" as const;
export const CANONICAL_POLICY_BASE_RECORD_KIND = "agent-context-canonical-policy-base" as const;
export const CANONICAL_POLICY_TARGET_IDS = [
  "claude-code",
  "copilot",
  "cursor-agent",
  "gemini-cli",
] as const;
export const CANONICAL_POLICY_SYNC_LIMITS: Readonly<{
  readonly maximumCanonicalBytes: number;
  readonly maximumDurationMs: number;
  readonly maximumIdentifierBytes: number;
  readonly maximumPatchBytes: number;
  readonly maximumTargetBytes: number;
  readonly maximumTargets: number;
}> = Object.freeze({
  maximumCanonicalBytes: 1_048_576,
  maximumDurationMs: 10_000,
  maximumIdentifierBytes: 128,
  maximumPatchBytes: 4_194_304,
  maximumTargetBytes: 1_048_576,
  maximumTargets: 4,
});

export type CanonicalPolicyTargetId = (typeof CANONICAL_POLICY_TARGET_IDS)[number];
export type CanonicalPolicyMergeState =
  | "already-current"
  | "clean-update"
  | "create-preview"
  | "hand-edit-conflict"
  | "malformed-current"
  | "malformed-prior-base"
  | "missing-current"
  | "unrepresentable"
  | "untracked-existing";
export type CanonicalPolicyPreviewState = "preview-only" | "ready" | "refused" | "unchanged";
export type CanonicalPolicyApplicationState =
  "existing-file-atomic" | "not-applicable" | "preview-only";

export interface CanonicalPolicyProfileIdentity {
  readonly evidenceRefs: readonly string[];
  readonly profileId: ClientProfileId;
  readonly specSnapshotId: SpecSnapshotId;
  readonly surfaceId: SurfaceId;
  readonly uncertainty: "conditional" | "contradiction" | "known" | "unknown";
}

export interface CanonicalPolicyBase {
  readonly canonicalSha256: string;
  readonly content: string;
  readonly formatId: DocumentFormatId;
  readonly generatedSha256: string;
  readonly generatorVersion: typeof CANONICAL_POLICY_SYNC_CONTRACT_VERSION;
  readonly path: RepositoryRelativePath;
  readonly policyId: string;
  readonly recordKind: typeof CANONICAL_POLICY_BASE_RECORD_KIND;
  readonly schemaVersion: typeof CANONICAL_POLICY_SYNC_CONTRACT_VERSION;
  readonly targetId: CanonicalPolicyTargetId;
}

export interface CanonicalPolicyTargetInput {
  readonly current: SafeFixSourceSnapshot | null;
  readonly priorBase: CanonicalPolicyBase | null;
  readonly targetId: CanonicalPolicyTargetId;
}

export interface CanonicalPolicyPreviewRequest {
  readonly canonical: SafeFixSourceSnapshot;
  readonly policyId: string;
  /** Must contain every target exactly once in canonical target-ID order. */
  readonly targets: readonly CanonicalPolicyTargetInput[];
}

export interface CanonicalPolicyTargetPreview {
  readonly afterSha256: string | null;
  readonly application: CanonicalPolicyApplicationState;
  readonly beforeSha256: string | null;
  readonly formatId: DocumentFormatId;
  readonly mergeState: CanonicalPolicyMergeState;
  readonly nextBase: CanonicalPolicyBase | null;
  readonly patch: string;
  readonly patchSha256: string;
  readonly path: RepositoryRelativePath;
  readonly profiles: readonly CanonicalPolicyProfileIdentity[];
  /** Fixed false: syntax/scope parity is not a claim of behavioral equivalence across clients. */
  readonly semanticEquivalenceClaimed: false;
  readonly reason: string | null;
  readonly state: CanonicalPolicyPreviewState;
  readonly targetId: CanonicalPolicyTargetId;
}

export interface CanonicalPolicyPreview {
  readonly canonical: {
    readonly formatId: "agents-markdown";
    readonly path: RepositoryRelativePath;
    readonly profile: CanonicalPolicyProfileIdentity;
    readonly sha256: string;
  };
  readonly contractVersion: typeof CANONICAL_POLICY_SYNC_CONTRACT_VERSION;
  readonly patch: string;
  readonly patchSha256: string;
  readonly policyId: string;
  readonly recordKind: typeof CANONICAL_POLICY_PREVIEW_RECORD_KIND;
  readonly targets: readonly CanonicalPolicyTargetPreview[];
}

export interface CanonicalPolicySynchronizerOptions {
  readonly maximumCanonicalBytes?: number;
  readonly maximumDurationMs?: number;
  readonly maximumPatchBytes?: number;
  readonly maximumTargetBytes?: number;
  readonly signal?: AbortSignal;
}

export interface CanonicalPolicySynchronizer {
  readonly contractVersion: typeof CANONICAL_POLICY_SYNC_CONTRACT_VERSION;
  readonly root: string;
  apply(targetPreview: unknown): Promise<SafeFixApplyResult>;
  preview(request: unknown): Promise<CanonicalPolicyPreview>;
}

export const CanonicalPolicySyncErrorCode: Readonly<{
  readonly aborted: "CANONICAL_POLICY_SYNC_ABORTED";
  readonly deadline: "CANONICAL_POLICY_SYNC_DEADLINE";
  readonly invalidInput: "CANONICAL_POLICY_SYNC_INVALID_INPUT";
  readonly invalidPreview: "CANONICAL_POLICY_SYNC_INVALID_PREVIEW";
  readonly resourceLimit: "CANONICAL_POLICY_SYNC_RESOURCE_LIMIT";
  readonly unsafeSource: "CANONICAL_POLICY_SYNC_UNSAFE_SOURCE";
  readonly unsupportedApply: "CANONICAL_POLICY_SYNC_UNSUPPORTED_APPLY";
}> = Object.freeze({
  aborted: "CANONICAL_POLICY_SYNC_ABORTED",
  deadline: "CANONICAL_POLICY_SYNC_DEADLINE",
  invalidInput: "CANONICAL_POLICY_SYNC_INVALID_INPUT",
  invalidPreview: "CANONICAL_POLICY_SYNC_INVALID_PREVIEW",
  resourceLimit: "CANONICAL_POLICY_SYNC_RESOURCE_LIMIT",
  unsafeSource: "CANONICAL_POLICY_SYNC_UNSAFE_SOURCE",
  unsupportedApply: "CANONICAL_POLICY_SYNC_UNSUPPORTED_APPLY",
} as const);

export type CanonicalPolicySyncErrorCode =
  (typeof CanonicalPolicySyncErrorCode)[keyof typeof CanonicalPolicySyncErrorCode];

export class CanonicalPolicySyncError extends Error {
  override readonly name = "CanonicalPolicySyncError" as const;
  readonly code: CanonicalPolicySyncErrorCode;
  readonly operation: string;
  readonly path: RepositoryRelativePath | undefined;

  constructor(
    code: CanonicalPolicySyncErrorCode,
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

interface OptionsSnapshot {
  readonly maximumCanonicalBytes: number;
  readonly maximumDurationMs: number;
  readonly maximumPatchBytes: number;
  readonly maximumTargetBytes: number;
  readonly signal?: AbortSignal;
}

interface TargetDescriptor {
  readonly formatId:
    | "claude-memory-markdown"
    | "claude-rule-markdown"
    | "copilot-path-instructions"
    | "copilot-repository-markdown"
    | "cursor-mdc"
    | "gemini-context-markdown";
  readonly path: RepositoryRelativePath;
  readonly profiles: readonly CanonicalPolicyProfileIdentity[];
  readonly targetId: CanonicalPolicyTargetId;
}

interface GeneratedTarget {
  readonly base: CanonicalPolicyBase;
  readonly content: string;
  readonly descriptor: TargetDescriptor;
  readonly digest: string;
}

interface TargetAuthority {
  readonly owner: object;
  readonly safePreview: SafeFixPreview | null;
  readonly state: "preview-only" | "ready";
}

const TARGET_AUTHORITY = new WeakMap<object, TargetAuthority>();
const USED_TARGETS = new WeakSet<object>();
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

function nativeSignalAborted(signal: unknown): boolean {
  return Reflect.get(AbortSignal.prototype, "aborted", signal);
}

function fail(
  code: CanonicalPolicySyncErrorCode,
  message: string,
  operation: string,
  pathValue?: RepositoryRelativePath,
): never {
  throw new CanonicalPolicySyncError(code, message, operation, pathValue);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function ownRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label} must be a plain data object`,
      "validate-input",
    );
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Reflect.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label} cannot be inspected safely`,
      "validate-input",
    );
  }
  if (prototype !== Object.prototype && prototype !== null)
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label} must be a plain data object`,
      "validate-input",
    );
  const allowedSet = new Set(allowed);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowedSet.has(key))
      fail(
        CanonicalPolicySyncErrorCode.invalidInput,
        `${label} has an unknown field`,
        "validate-input",
      );
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor))
      fail(
        CanonicalPolicySyncErrorCode.invalidInput,
        `${label}.${key} must be an own data property`,
        "validate-input",
      );
    output[key] = descriptor.value;
  }
  for (const key of required)
    if (!Object.hasOwn(output, key) || output[key] === undefined)
      fail(
        CanonicalPolicySyncErrorCode.invalidInput,
        `${label}.${key} is required`,
        "validate-input",
      );
  return output;
}

function denseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum)
    fail(
      value !== null && typeof value === "object" && Array.isArray(value) && value.length > maximum
        ? CanonicalPolicySyncErrorCode.resourceLimit
        : CanonicalPolicySyncErrorCode.invalidInput,
      `${label} must be a bounded dense array`,
      "validate-input",
    );
  if (Reflect.ownKeys(value).length !== value.length + 1)
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label} must be a dense data array`,
      "validate-input",
    );
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor))
      fail(
        CanonicalPolicySyncErrorCode.invalidInput,
        `${label} must contain own data items`,
        "validate-input",
      );
    output.push(descriptor.value);
  }
  return output;
}

function integerOption(
  value: unknown,
  label: string,
  hardMaximum: number,
  fallback: number,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    (selected as number) < 1 ||
    (selected as number) > hardMaximum
  )
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label} is outside the supported range`,
      "validate-options",
    );
  return selected as number;
}

function snapshotOptions(value: unknown): OptionsSnapshot {
  if (value === undefined)
    return Object.freeze({
      maximumCanonicalBytes: CANONICAL_POLICY_SYNC_LIMITS.maximumCanonicalBytes,
      maximumDurationMs: CANONICAL_POLICY_SYNC_LIMITS.maximumDurationMs,
      maximumPatchBytes: CANONICAL_POLICY_SYNC_LIMITS.maximumPatchBytes,
      maximumTargetBytes: CANONICAL_POLICY_SYNC_LIMITS.maximumTargetBytes,
    });
  const record = ownRecord(
    value,
    "options",
    [
      "maximumCanonicalBytes",
      "maximumDurationMs",
      "maximumPatchBytes",
      "maximumTargetBytes",
      "signal",
    ],
    [],
  );
  const signal = record["signal"];
  if (signal !== undefined) {
    try {
      if (typeof nativeSignalAborted(signal) !== "boolean") throw new TypeError("invalid signal");
    } catch {
      fail(
        CanonicalPolicySyncErrorCode.invalidInput,
        "options.signal must be a native AbortSignal",
        "validate-options",
      );
    }
  }
  return Object.freeze({
    maximumCanonicalBytes: integerOption(
      record["maximumCanonicalBytes"],
      "options.maximumCanonicalBytes",
      CANONICAL_POLICY_SYNC_LIMITS.maximumCanonicalBytes,
      CANONICAL_POLICY_SYNC_LIMITS.maximumCanonicalBytes,
    ),
    maximumDurationMs: integerOption(
      record["maximumDurationMs"],
      "options.maximumDurationMs",
      CANONICAL_POLICY_SYNC_LIMITS.maximumDurationMs,
      CANONICAL_POLICY_SYNC_LIMITS.maximumDurationMs,
    ),
    maximumPatchBytes: integerOption(
      record["maximumPatchBytes"],
      "options.maximumPatchBytes",
      CANONICAL_POLICY_SYNC_LIMITS.maximumPatchBytes,
      CANONICAL_POLICY_SYNC_LIMITS.maximumPatchBytes,
    ),
    maximumTargetBytes: integerOption(
      record["maximumTargetBytes"],
      "options.maximumTargetBytes",
      CANONICAL_POLICY_SYNC_LIMITS.maximumTargetBytes,
      CANONICAL_POLICY_SYNC_LIMITS.maximumTargetBytes,
    ),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  });
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return nativeSignalAborted(signal);
  } catch {
    return true;
  }
}

function checkBudget(options: OptionsSnapshot, started: bigint, operation: string): void {
  if (signalAborted(options.signal))
    fail(
      CanonicalPolicySyncErrorCode.aborted,
      "canonical policy synchronization was cancelled",
      operation,
    );
  const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (elapsed > options.maximumDurationMs)
    fail(
      CanonicalPolicySyncErrorCode.deadline,
      "canonical policy synchronization exceeded its deadline",
      operation,
    );
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > CANONICAL_POLICY_SYNC_LIMITS.maximumIdentifierBytes ||
    Buffer.byteLength(value, "utf8") > CANONICAL_POLICY_SYNC_LIMITS.maximumIdentifierBytes ||
    !IDENTIFIER.test(value)
  )
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label} must be a bounded lowercase identifier`,
      "validate-input",
    );
  return value;
}

function repositoryPath(value: unknown, label: string): RepositoryRelativePath {
  if (typeof value !== "string" || value.length > 16_384 || !isRepositoryRelativePath(value))
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label} must be a canonical repository path`,
      "validate-input",
    );
  return value;
}

function sourceSnapshot(
  value: unknown,
  label: string,
  maximumBytes: number,
): SafeFixSourceSnapshot {
  const record = ownRecord(value, label, ["identity", "source"]);
  const identity = ownRecord(record["identity"], `${label}.identity`, ["device", "inode"]);
  for (const key of ["device", "inode"])
    if (typeof identity[key] !== "string" || !/^(?:0|[1-9][0-9]{0,63})$/u.test(identity[key]))
      fail(
        CanonicalPolicySyncErrorCode.invalidInput,
        `${label}.identity.${key} is invalid`,
        "validate-input",
      );
  const sourceRecord = ownRecord(record["source"], `${label}.source`, [
    "id",
    "path",
    "encoding",
    "bom",
    "text",
    "byteLength",
    "utf16Length",
    "sha256",
    "lineEnding",
    "parseState",
    "rootNodeId",
  ]);
  const text = sourceRecord["text"];
  const digest = sourceRecord["sha256"];
  const byteLength = sourceRecord["byteLength"];
  const utf16Length = sourceRecord["utf16Length"];
  if (typeof text !== "string" || typeof digest !== "string" || !SHA256.test(digest))
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label}.source text or digest is invalid`,
      "validate-input",
    );
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > maximumBytes)
    fail(
      CanonicalPolicySyncErrorCode.resourceLimit,
      `${label}.source exceeds its byte limit`,
      "validate-input",
    );
  if (byteLength !== bytes.byteLength || utf16Length !== text.length || sha256(bytes) !== digest)
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label}.source lengths or digest do not match`,
      "validate-input",
    );
  if (sourceRecord["encoding"] !== "utf-8")
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label}.source encoding is unsupported`,
      "validate-input",
    );
  const pathValue = repositoryPath(sourceRecord["path"], `${label}.source.path`);
  const sourceId = sourceRecord["id"];
  const rootNodeId = sourceRecord["rootNodeId"];
  if (
    typeof sourceId !== "string" ||
    typeof rootNodeId !== "string" ||
    sourceId.length > 512 ||
    rootNodeId.length > 512 ||
    !/^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u.test(sourceId) ||
    !/^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u.test(rootNodeId)
  )
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label}.source identities are invalid`,
      "validate-input",
    );
  const bom = sourceRecord["bom"];
  if ((bom !== "none" && bom !== "utf-8") || (bom === "utf-8") !== text.startsWith("\uFEFF"))
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label}.source BOM state is invalid`,
      "validate-input",
    );
  const expectedLineEnding = ((): SourceDocument["lineEnding"] => {
    let cr = false;
    let crlf = false;
    let lf = false;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 0x0d) {
        if (text.charCodeAt(index + 1) === 0x0a) {
          crlf = true;
          index += 1;
        } else cr = true;
      } else if (text.charCodeAt(index) === 0x0a) lf = true;
    }
    const count = Number(cr) + Number(crlf) + Number(lf);
    return count === 0 ? "none" : count > 1 ? "mixed" : crlf ? "crlf" : cr ? "cr" : "lf";
  })();
  if (sourceRecord["lineEnding"] !== expectedLineEnding)
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label}.source line-ending state is invalid`,
      "validate-input",
    );
  const parseStateRecord = ownRecord(
    sourceRecord["parseState"],
    `${label}.source.parseState`,
    ["reason", "state"],
    ["state"],
  );
  const parseStateValue = parseStateRecord["state"];
  if (
    parseStateValue !== "complete" &&
    parseStateValue !== "malformed" &&
    parseStateValue !== "partial"
  )
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label}.source parse state is invalid`,
      "validate-input",
    );
  const reason = parseStateRecord["reason"];
  if (
    (parseStateValue === "complete" && reason !== undefined) ||
    (parseStateValue !== "complete" &&
      (typeof reason !== "string" || reason.length === 0 || reason.length > 2_048))
  )
    fail(
      CanonicalPolicySyncErrorCode.invalidInput,
      `${label}.source parse-state reason is invalid`,
      "validate-input",
    );
  const source: SourceDocument = Object.freeze({
    bom,
    byteLength: bytes.byteLength,
    encoding: "utf-8",
    id: sourceId as SourceDocumentId,
    lineEnding: expectedLineEnding,
    parseState:
      parseStateValue === "complete"
        ? Object.freeze({ state: "complete" as const })
        : Object.freeze({ reason: reason as string, state: parseStateValue }),
    path: pathValue,
    rootNodeId: rootNodeId as SourceDocument["rootNodeId"],
    sha256: digest,
    text,
    utf16Length: text.length,
  });
  return Object.freeze({
    identity: Object.freeze({
      device: identity["device"] as string,
      inode: identity["inode"] as string,
    }),
    source,
  });
}

function scopeRoot(pathValue: RepositoryRelativePath): RepositoryRelativePath {
  const index = pathValue.lastIndexOf("/");
  return canonicalizeRepositoryRelativePath(index < 0 ? "." : pathValue.slice(0, index));
}

function scopedPath(root: RepositoryRelativePath, suffix: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(root === "." ? suffix : `${root}/${suffix}`);
}

function sourcePosition(text: string, offset: number): SourcePosition {
  const prefix = text.slice(0, offset);
  let line = 0;
  let column = 0;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] === "\r") {
      if (prefix[index + 1] === "\n") continue;
      line += 1;
      column = 0;
    } else if (prefix[index] === "\n") {
      line += 1;
      column = 0;
    } else column += 1;
  }
  return Object.freeze({
    byteOffset: Buffer.byteLength(prefix, "utf8"),
    line,
    utf16Column: column,
    utf16Offset: offset,
  });
}

function sourceRange(source: SourceDocument): SourceRange {
  return Object.freeze({
    end: sourcePosition(source.text, source.text.length),
    sourceId: source.id,
    start: sourcePosition(source.text, 0),
  });
}

function profileIdentity(value: CanonicalPolicyProfileIdentity): CanonicalPolicyProfileIdentity {
  return Object.freeze({
    ...value,
    evidenceRefs: Object.freeze([...new Set(value.evidenceRefs)].sort(compareUtf8)),
  });
}

const CODEX_IDENTITY = profileIdentity({
  evidenceRefs: CODEX_CLI_PROFILE.evidenceRefs,
  profileId: CODEX_CLI_PROFILE.profileId,
  specSnapshotId: CODEX_CLI_PROFILE.specSnapshotId,
  surfaceId: CODEX_CLI_PROFILE.surfaceId,
  uncertainty: "known",
});

function copilotIdentities(
  formatId: "copilot-path-instructions" | "copilot-repository-markdown",
): readonly CanonicalPolicyProfileIdentity[] {
  return Object.freeze(
    COPILOT_PROFILES.filter((profile) => profile.releaseClass === "ga-required")
      .map((profile) => {
        const claim = profile.formats.find((item) => item.formatId === formatId);
        return profileIdentity({
          evidenceRefs: [...profile.evidenceRefs, ...(claim?.evidenceRefs ?? [])],
          profileId: profile.profileId,
          specSnapshotId: profile.specSnapshotId,
          surfaceId: profile.surfaceId,
          uncertainty: claim?.uncertainty ?? "unknown",
        });
      })
      .sort((left, right) => compareUtf8(left.profileId, right.profileId)),
  );
}

function targetDescriptor(
  targetId: CanonicalPolicyTargetId,
  root: RepositoryRelativePath,
  policyId: string,
): TargetDescriptor {
  if (targetId === "claude-code") {
    const rootPolicy = root === ".";
    return Object.freeze({
      formatId: rootPolicy ? "claude-memory-markdown" : "claude-rule-markdown",
      path: rootPolicy
        ? canonicalizeRepositoryRelativePath("CLAUDE.md")
        : canonicalizeRepositoryRelativePath(`.claude/rules/canonical-${policyId}.md`),
      profiles: Object.freeze([
        profileIdentity({
          evidenceRefs: CLAUDE_CODE_PROFILE.evidenceRefs,
          profileId: CLAUDE_CODE_PROFILE.profileId,
          specSnapshotId: CLAUDE_CODE_PROFILE.specSnapshotId,
          surfaceId: CLAUDE_CODE_PROFILE.surfaceId,
          uncertainty: "known",
        }),
      ]),
      targetId,
    });
  }
  if (targetId === "copilot") {
    const rootPolicy = root === ".";
    const formatId = rootPolicy ? "copilot-repository-markdown" : "copilot-path-instructions";
    return Object.freeze({
      formatId,
      path: rootPolicy
        ? canonicalizeRepositoryRelativePath(".github/copilot-instructions.md")
        : canonicalizeRepositoryRelativePath(
            `.github/instructions/canonical-${policyId}.instructions.md`,
          ),
      profiles: copilotIdentities(formatId),
      targetId,
    });
  }
  if (targetId === "gemini-cli") {
    return Object.freeze({
      formatId: "gemini-context-markdown",
      path: scopedPath(root, "GEMINI.md"),
      profiles: Object.freeze([
        profileIdentity({
          evidenceRefs: GEMINI_CLI_PROFILE.evidenceRefs,
          profileId: GEMINI_CLI_PROFILE.profileId,
          specSnapshotId: GEMINI_CLI_PROFILE.specSnapshotId,
          surfaceId: GEMINI_CLI_PROFILE.surfaceId,
          uncertainty: "known",
        }),
      ]),
      targetId,
    });
  }
  return Object.freeze({
    formatId: "cursor-mdc",
    path: scopedPath(root, `.cursor/rules/canonical-${policyId}.mdc`),
    profiles: Object.freeze(
      CURSOR_SURFACE_PROFILES.map((profile) =>
        profileIdentity({
          evidenceRefs: profile.evidenceRefs,
          profileId: profile.profileId,
          specSnapshotId: profile.specSnapshotId,
          surfaceId: profile.surfaceId,
          uncertainty: root === "." ? "known" : "unknown",
        }),
      ).sort((left, right) => compareUtf8(left.surfaceId, right.surfaceId)),
    ),
    targetId,
  });
}

function profileDigest(profiles: readonly CanonicalPolicyProfileIdentity[]): string {
  return sha256(JSON.stringify(profiles));
}

function header(descriptor: TargetDescriptor, policyId: string, canonicalSha256: string): string {
  const data = {
    canonicalSha256,
    formatId: descriptor.formatId,
    generatorVersion: CANONICAL_POLICY_SYNC_CONTRACT_VERSION,
    policyId,
    profileIdentitySha256: profileDigest(descriptor.profiles),
    targetId: descriptor.targetId,
  };
  return `<!-- agent-context-lint-canonical-policy:${JSON.stringify(data)} -->`;
}

function scopePattern(root: RepositoryRelativePath): string {
  return root === "." ? "**" : `${root}/**`;
}

function canonicalBody(source: SourceDocument): string {
  const withoutBom = source.text.startsWith("\uFEFF") ? source.text.slice(1) : source.text;
  return withoutBom.endsWith("\n") || withoutBom.endsWith("\r") ? withoutBom : `${withoutBom}\n`;
}

function renderTarget(
  descriptor: TargetDescriptor,
  source: SourceDocument,
  policyId: string,
): string {
  const marker = header(descriptor, policyId, source.sha256);
  const body = canonicalBody(source);
  const root = scopeRoot(source.path);
  if (descriptor.formatId === "claude-rule-markdown")
    return `---\npaths:\n  - ${JSON.stringify(scopePattern(root))}\n---\n${marker}\n${body}`;
  if (descriptor.formatId === "copilot-path-instructions")
    return `---\napplyTo: ${JSON.stringify(scopePattern(root))}\n---\n${marker}\n${body}`;
  if (descriptor.formatId === "cursor-mdc") {
    const scoped = root !== ".";
    return scoped
      ? `---\nalwaysApply: false\nglobs:\n  - "**"\n---\n${marker}\n${body}`
      : `---\nalwaysApply: true\n---\n${marker}\n${body}`;
  }
  return `${marker}\n${body}`;
}

interface HeaderRecord {
  readonly canonicalSha256: string;
  readonly formatId: string;
  readonly generatorVersion: string;
  readonly policyId: string;
  readonly profileIdentitySha256: string;
  readonly targetId: string;
}

function parseHeader(content: string): HeaderRecord | null {
  const match = /(?:^|\n)<!-- agent-context-lint-canonical-policy:(\{[^\n]*\}) -->\n/u.exec(
    content,
  );
  if (match?.[1] === undefined || Buffer.byteLength(match[1], "utf8") > 2_048) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  try {
    const record = ownRecord(parsed, "generated header", [
      "canonicalSha256",
      "formatId",
      "generatorVersion",
      "policyId",
      "profileIdentitySha256",
      "targetId",
    ]);
    if (
      ![record["canonicalSha256"], record["profileIdentitySha256"]].every(
        (item) => typeof item === "string" && SHA256.test(item),
      )
    )
      return null;
    if (
      ![
        record["formatId"],
        record["generatorVersion"],
        record["policyId"],
        record["targetId"],
      ].every((item) => typeof item === "string")
    )
      return null;
    return record as unknown as HeaderRecord;
  } catch {
    return null;
  }
}

function documentIdentity(content: string): {
  readonly documentId: InstructionDocumentId;
  readonly sourceId: SourceDocumentId;
} {
  const digest = sha256(content);
  return {
    documentId: `document:${digest}` as InstructionDocumentId,
    sourceId: `source:${digest}` as SourceDocumentId,
  };
}

function validateGeneratedSyntax(
  descriptor: TargetDescriptor,
  content: string,
  canonicalSha256: string,
  policyId: string,
): boolean {
  const parsedHeader = parseHeader(content);
  if (
    parsedHeader?.canonicalSha256 !== canonicalSha256 ||
    parsedHeader.formatId !== descriptor.formatId ||
    parsedHeader.generatorVersion !== CANONICAL_POLICY_SYNC_CONTRACT_VERSION ||
    parsedHeader.policyId !== policyId ||
    parsedHeader.profileIdentitySha256 !== profileDigest(descriptor.profiles) ||
    parsedHeader.targetId !== descriptor.targetId
  )
    return false;
  const bytes = Uint8Array.from(Buffer.from(content, "utf8"));
  const ids = documentIdentity(content);
  try {
    if (
      descriptor.formatId === "claude-memory-markdown" ||
      descriptor.formatId === "claude-rule-markdown"
    ) {
      const result = parseClaudeInstructionSyntax({
        bytes,
        documentId: ids.documentId,
        format: descriptor.formatId === "claude-memory-markdown" ? "memory" : "project-rule",
        sourceId: ids.sourceId,
      });
      if (result.state !== "complete" || result.text !== content) return false;
      if (descriptor.formatId === "claude-rule-markdown" && result.paths.state !== "valid")
        return false;
      return true;
    }
    if (
      descriptor.formatId === "copilot-path-instructions" ||
      descriptor.formatId === "copilot-repository-markdown"
    ) {
      const result = parseCopilotInstructionSyntax({
        bytes,
        documentId: ids.documentId,
        format:
          descriptor.formatId === "copilot-path-instructions" ? "path-specific" : "repository-wide",
        sourceId: ids.sourceId,
      });
      if (result.state !== "complete" || result.text !== content) return false;
      return (
        descriptor.formatId !== "copilot-path-instructions" || result.applyTo.state === "valid"
      );
    }
    if (descriptor.formatId === "cursor-mdc") {
      const result = parseCursorRuleSyntax({
        bytes,
        documentId: ids.documentId,
        format: "mdc",
        path: descriptor.path,
        sourceId: ids.sourceId,
      });
      return (
        result.state === "complete" &&
        result.text === content &&
        result.alwaysApply.state === "valid" &&
        (result.globs.state === "valid"
          ? result.alwaysApply.value === false
          : result.alwaysApply.value === true)
      );
    }
    const result = parseGeminiContext({
      bytes,
      contentStatus: "complete",
      path: descriptor.path,
      scopeRoot: scopeRoot(descriptor.path),
    });
    return (
      result.decode === "utf8" &&
      result.source.parseState.state === "complete" &&
      result.source.text === content
    );
  } catch {
    return false;
  }
}

function semanticRepresentationIssue(
  descriptor: TargetDescriptor,
  content: string,
  canonical: ReturnType<typeof parseAgentsMarkdown>,
): string | null {
  if (
    canonical.nodes.some((node) => node.kind === "link" || node.kind === "html-comment") ||
    /^(?:\uFEFF)?---(?:\r\n|\r|\n)/u.test(canonical.source.text)
  )
    return "Canonical Markdown contains a link, HTML comment, or frontmatter-like prefix whose target-client meaning is not losslessly portable.";
  const bytes = Uint8Array.from(Buffer.from(content, "utf8"));
  const ids = documentIdentity(content);
  if (
    descriptor.formatId === "claude-memory-markdown" ||
    descriptor.formatId === "claude-rule-markdown"
  ) {
    const parsed = parseClaudeInstructionSyntax({
      bytes,
      documentId: ids.documentId,
      format: descriptor.formatId === "claude-memory-markdown" ? "memory" : "project-rule",
      sourceId: ids.sourceId,
    });
    if (parsed.imports.length > 0)
      return "Target parsing would reinterpret canonical text as Claude imports.";
  } else if (
    descriptor.formatId === "copilot-path-instructions" ||
    descriptor.formatId === "copilot-repository-markdown"
  ) {
    const parsed = parseCopilotInstructionSyntax({
      bytes,
      documentId: ids.documentId,
      format:
        descriptor.formatId === "copilot-path-instructions" ? "path-specific" : "repository-wide",
      sourceId: ids.sourceId,
    });
    if (parsed.imports.length > 0)
      return "Target parsing would reinterpret canonical text as Copilot references.";
  } else if (descriptor.formatId === "cursor-mdc") {
    const parsed = parseCursorRuleSyntax({
      bytes,
      documentId: ids.documentId,
      format: "mdc",
      path: descriptor.path,
      sourceId: ids.sourceId,
    });
    if (parsed.references.length > 0)
      return "Target parsing would reinterpret canonical text as Cursor references.";
  } else {
    const parsed = parseGeminiContext({
      bytes,
      contentStatus: "complete",
      path: descriptor.path,
      scopeRoot: scopeRoot(descriptor.path),
    });
    if (parsed.imports.length > 0)
      return "Target parsing would reinterpret canonical text as Gemini imports.";
  }
  return null;
}

function probeInside(root: RepositoryRelativePath): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(
    root === "." ? "src/__acl_sync_probe__.ts" : `${root}/__acl_sync_probe__.ts`,
  );
}

const PROBE_OUTSIDE = canonicalizeRepositoryRelativePath("__acl_sync_outside_probe__.ts");

function validateCanonicalCodexParity(
  source: SourceDocument,
  root: RepositoryRelativePath,
): string | null {
  const entry = Object.freeze({
    bytes: Uint8Array.from(Buffer.from(source.text, "utf8")),
    errorCode: null,
    kind: "file" as const,
    path: source.path,
    resolvedTarget: null,
  });
  const resolve = (
    launchCwd: RepositoryRelativePath,
    targetPath: RepositoryRelativePath,
  ): ReturnType<typeof resolveCodexCliAgents> =>
    resolveCodexCliAgents({
      discovery: {
        certainty: "known",
        entries: [entry],
        reason: "complete canonical-policy source snapshot",
        rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
      },
      externalContext: { mode: "unavailable" },
      launchCwd,
      settings: {
        projectDocFallbackFilenames: [],
        projectDocMaxBytes: CODEX_CLI_PROFILE.defaultProjectDocMaxBytes,
        projectRootMarkers: [".git"],
      },
      targetPath,
    });
  const inside = resolve(root, probeInside(root));
  if (
    inside.selected.length !== 1 ||
    inside.selected[0]?.path !== source.path ||
    inside.projectText !== source.text
  )
    return "Codex resolver does not consume the complete canonical source for its in-scope working directory.";
  if (
    root !== "." &&
    resolve(canonicalizeRepositoryRelativePath("."), PROBE_OUTSIDE).selected.length !== 0
  )
    return "Codex resolver broadens the canonical source beyond its directory scope.";
  return null;
}

function syntheticRepository(
  pathValue: RepositoryRelativePath,
  content: string,
): ReadOnlyRepository {
  return Object.freeze({
    inspect: () => Promise.reject(new Error("not used")),
    limits: Object.freeze({
      maximumDurationMs: 1_000,
      maximumEntries: 32,
      maximumFileBytes: 1_048_576,
      maximumMetadataOperations: 64,
      maximumSymlinkDepth: 1,
      maximumTotalBytes: 2_097_152,
      maximumTraversalDepth: 16,
    }),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile: (requested: RepositoryRelativePath) =>
      requested === pathValue
        ? Promise.resolve(
            new ReadOnlyRepositoryFile(
              pathValue,
              Uint8Array.from(Buffer.from(content, "utf8")),
              { device: "1", inode: "1" },
              0,
            ),
          )
        : Promise.reject(new Error("synthetic path unavailable")),
    root: "/canonical-policy-synthetic",
    usage: () => Object.freeze({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  });
}

function directoryCandidates(pathValue: RepositoryRelativePath): readonly {
  readonly identity: string;
  readonly ignoredBy: readonly string[];
  readonly kind: "directory";
  readonly path: RepositoryRelativePath;
}[] {
  const segments = pathValue.split("/").slice(0, -1);
  const paths: RepositoryRelativePath[] = [canonicalizeRepositoryRelativePath(".")];
  let current = "";
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    if (current === "." || current.endsWith(".cursor/rules") || current.includes(".cursor/rules/"))
      continue;
    paths.push(canonicalizeRepositoryRelativePath(current));
  }
  return Object.freeze(
    [...new Set(paths)].map((item) =>
      Object.freeze({
        identity: `directory:${item}`,
        ignoredBy: Object.freeze([]),
        kind: "directory" as const,
        path: item,
      }),
    ),
  );
}

async function validateResolverParity(
  descriptor: TargetDescriptor,
  content: string,
  root: RepositoryRelativePath,
): Promise<string | null> {
  const bytes = Uint8Array.from(Buffer.from(content, "utf8"));
  const inside = probeInside(root);
  if (descriptor.targetId === "claude-code") {
    const candidate = {
      absolutePath: `/repository/${descriptor.path}`,
      bytes,
      importGraph: null,
      kind:
        descriptor.formatId === "claude-rule-markdown"
          ? ("project-rule" as const)
          : ("memory-shared" as const),
      origin: "repository" as const,
      path: descriptor.path,
      scopeRoot: canonicalizeRepositoryRelativePath("."),
      symlinkState: "none" as const,
    };
    const resolve = (target: RepositoryRelativePath): ReturnType<typeof resolveClaudeCodeProfile> =>
      resolveClaudeCodeProfile({
        candidates: [candidate],
        launchCwd: canonicalizeRepositoryRelativePath("."),
        repositoryRoot: canonicalizeRepositoryRelativePath("."),
        runtime: {
          additionalDirectoryInstructions: "disabled",
          clientVersion: "2.1.217",
          eventTrace: [
            { id: "launch", kind: "launch", path: canonicalizeRepositoryRelativePath(".") },
            { id: "read", kind: "read", path: target },
          ],
          exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
          externalContext: "supplied",
          mode: "normal",
          settingSources: { state: "known", values: ["local", "managed", "project", "user"] },
        },
      });
    if (resolve(inside).candidates[0]?.activation !== "active")
      return "Claude resolver did not activate the generated file for the canonical scope probe.";
    if (root !== "." && resolve(PROBE_OUTSIDE).candidates[0]?.activation === "active")
      return "Claude resolver broadened the generated file beyond the canonical scope.";
    return null;
  }
  if (descriptor.targetId === "copilot") {
    if (descriptor.formatId !== "copilot-repository-markdown")
      return "Copilot path-specific scope semantics are not known consistently across required GA surfaces.";
    const candidate = { bytes, format: "repository-wide" as const, path: descriptor.path };
    for (const profile of COPILOT_PROFILES.filter((item) => item.releaseClass === "ga-required")) {
      const input =
        profile.profileId === "copilot-cli"
          ? {
              candidates: [candidate],
              profileId: profile.profileId,
              runtime: {
                disabledPaths: [],
                eventState: "present" as const,
                kind: "copilot-cli" as const,
                standardLocations: [
                  {
                    kind: "repository-root" as const,
                    path: canonicalizeRepositoryRelativePath("."),
                  },
                ],
                targetPaths: [inside],
              },
            }
          : {
              candidates: [candidate],
              profileId: profile.profileId,
              runtime: {
                applyingInstructions: "enabled" as const,
                eventState: "present" as const,
                instructionFolders: [
                  {
                    path: canonicalizeRepositoryRelativePath(".github/instructions"),
                    workspaceRoot: canonicalizeRepositoryRelativePath("."),
                  },
                ],
                kind: "copilot-vscode" as const,
                manualAttachments: [],
                targetPaths: [inside],
                workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
              },
            };
      if (resolveCopilotProfile(input).candidates[0]?.activation !== "active")
        return `Copilot resolver did not preserve root scope for ${profile.profileId}.`;
    }
    return null;
  }
  if (descriptor.targetId === "cursor-agent") {
    const candidate = { bytes, format: "mdc" as const, path: descriptor.path };
    for (const profile of CURSOR_SURFACE_PROFILES) {
      const resolve = (target: RepositoryRelativePath): ReturnType<typeof resolveCursorProfile> =>
        resolveCursorProfile({
          candidates: [candidate],
          runtime: {
            clientVersion: profile.clientVersion,
            eventState: "present",
            events: [{ kind: "reference-path", sequence: 1, targetPath: target }],
            externalContext: "absent",
            projectRules: "enabled",
            surfaceId: profile.surfaceId,
            workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
          },
        });
      if (resolve(inside).candidates[0]?.activation !== "active")
        return `Cursor resolver did not activate the generated rule inside scope on ${profile.surfaceId}.`;
      if (root !== "." && resolve(PROBE_OUTSIDE).candidates[0]?.activation === "active")
        return `Cursor resolver broadened the generated rule on ${profile.surfaceId}.`;
    }
    return null;
  }
  const repository = syntheticRepository(descriptor.path, content);
  const fileCandidate = Object.freeze({
    identity: `file:${descriptor.path}`,
    ignoredBy: Object.freeze([]),
    kind: "file" as const,
    path: descriptor.path,
  });
  const resolve = (target: RepositoryRelativePath): ReturnType<typeof resolveGeminiCliContext> =>
    resolveGeminiCliContext({
      boundaryMarkerDirectories: [canonicalizeRepositoryRelativePath(".")],
      candidates: [...directoryCandidates(descriptor.path), fileCandidate],
      events: [
        { id: "launch", kind: "launch", path: canonicalizeRepositoryRelativePath(".") },
        { id: "read", kind: "read-path", path: target },
      ],
      externalContext: "unavailable",
      repository,
      settingsLayers: [],
      trustState: "trusted",
      workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
    });
  const insideResult = await resolve(inside);
  if (!insideResult.loadedPaths.includes(descriptor.path))
    return "Gemini resolver did not load the generated context inside canonical scope.";
  if (root !== "." && (await resolve(PROBE_OUTSIDE)).loadedPaths.includes(descriptor.path))
    return "Gemini resolver broadened the generated context beyond canonical scope.";
  return null;
}

function generatedTarget(
  descriptor: TargetDescriptor,
  source: SourceDocument,
  policyId: string,
  maximumBytes: number,
): GeneratedTarget {
  const content = renderTarget(descriptor, source, policyId);
  if (Buffer.byteLength(content, "utf8") > maximumBytes)
    fail(
      CanonicalPolicySyncErrorCode.resourceLimit,
      "generated target exceeds its byte limit",
      "generate",
      descriptor.path,
    );
  const digest = sha256(content);
  if (!validateGeneratedSyntax(descriptor, content, source.sha256, policyId))
    fail(
      CanonicalPolicySyncErrorCode.unsafeSource,
      `generated target ${descriptor.path} failed its real syntax round-trip`,
      "round-trip",
      descriptor.path,
    );
  const base: CanonicalPolicyBase = Object.freeze({
    canonicalSha256: source.sha256,
    content,
    formatId: descriptor.formatId,
    generatedSha256: digest,
    generatorVersion: CANONICAL_POLICY_SYNC_CONTRACT_VERSION,
    path: descriptor.path,
    policyId,
    recordKind: CANONICAL_POLICY_BASE_RECORD_KIND,
    schemaVersion: CANONICAL_POLICY_SYNC_CONTRACT_VERSION,
    targetId: descriptor.targetId,
  });
  return Object.freeze({ base, content, descriptor, digest });
}

function validatePriorBase(value: unknown, generated: GeneratedTarget): CanonicalPolicyBase | null {
  try {
    const record = ownRecord(value, "priorBase", [
      "canonicalSha256",
      "content",
      "formatId",
      "generatedSha256",
      "generatorVersion",
      "path",
      "policyId",
      "recordKind",
      "schemaVersion",
      "targetId",
    ]);
    if (
      record["recordKind"] !== CANONICAL_POLICY_BASE_RECORD_KIND ||
      record["schemaVersion"] !== CANONICAL_POLICY_SYNC_CONTRACT_VERSION ||
      record["generatorVersion"] !== CANONICAL_POLICY_SYNC_CONTRACT_VERSION ||
      record["targetId"] !== generated.descriptor.targetId ||
      record["path"] !== generated.descriptor.path ||
      record["formatId"] !== generated.descriptor.formatId ||
      record["policyId"] !== generated.base.policyId ||
      typeof record["canonicalSha256"] !== "string" ||
      !SHA256.test(record["canonicalSha256"]) ||
      typeof record["generatedSha256"] !== "string" ||
      !SHA256.test(record["generatedSha256"]) ||
      typeof record["content"] !== "string" ||
      record["content"].length > CANONICAL_POLICY_SYNC_LIMITS.maximumTargetBytes ||
      sha256(record["content"]) !== record["generatedSha256"] ||
      !validateGeneratedSyntax(
        generated.descriptor,
        record["content"],
        record["canonicalSha256"],
        generated.base.policyId,
      )
    )
      return null;
    return value as CanonicalPolicyBase;
  } catch {
    return null;
  }
}

function makePlan(
  source: SourceDocument,
  generated: GeneratedTarget,
  create: boolean,
): AtomicFixPlan {
  return Object.freeze({
    application: "atomic",
    id: `canonical-sync:${generated.descriptor.targetId}:${generated.digest.slice(0, 16)}` as FixPlanId,
    operations: Object.freeze(
      create
        ? [
            {
              content: generated.content,
              contentDigest: generated.digest,
              destinationPrecondition: "absent" as const,
              kind: "create-document" as const,
              path: generated.descriptor.path,
            },
          ]
        : [
            {
              kind: "text-edit" as const,
              newText: generated.content,
              path: source.path,
              range: sourceRange(source),
              sourceDigest: source.sha256,
              sourceId: source.id,
            },
          ],
    ),
    safety: "mechanical",
    title: `Synchronize ${generated.descriptor.targetId} canonical policy`,
  });
}

function makeDiagnostic(
  primary: SourceDocument,
  plan: AtomicFixPlan,
  generated: GeneratedTarget,
): Diagnostic {
  const profileIds = [
    ...new Set(generated.descriptor.profiles.map((profile) => profile.profileId)),
  ].sort(compareUtf8);
  const ruleId = "ACL254";
  const ruleVersion = CANONICAL_POLICY_SYNC_CONTRACT_VERSION;
  const pathBasis = { anchor: `canonical-sync:${generated.descriptor.targetId}`, profileIds };
  const semanticBasis = {
    components: [
      { key: "canonicalSha256", value: generated.base.canonicalSha256 },
      { key: "targetId", value: generated.descriptor.targetId },
    ],
    profileIds,
  };
  return Object.freeze({
    fingerprintBasis: Object.freeze({
      path: Object.freeze(pathBasis),
      semantic: Object.freeze({
        ...semanticBasis,
        components: Object.freeze(semanticBasis.components.map((item) => Object.freeze(item))),
      }),
    }),
    fingerprints: Object.freeze({
      path: Object.freeze({
        method: PATH_FINGERPRINT_METHOD,
        value: computePathFingerprint({
          basis: pathBasis,
          path: primary.path,
          ruleId,
          ruleVersion,
        }),
      }),
      semantic: Object.freeze({
        method: SEMANTIC_FINGERPRINT_METHOD,
        value: computeSemanticFingerprint({ basis: semanticBasis, ruleId, ruleVersion }),
      }),
    }),
    id: `diagnostic:canonical-sync:${generated.descriptor.targetId}` as DiagnosticId,
    message: "Vendor policy differs from its canonical generated form",
    primary: Object.freeze({
      path: primary.path,
      range: sourceRange(primary),
      sourceDigest: primary.sha256,
      sourceId: primary.id,
    }),
    related: Object.freeze([]),
    ruleId,
    ruleVersion,
    severity: "warning",
    suggestion: Object.freeze({
      fixPlan: plan,
      message: "Review the canonical-policy synchronization preview",
    }),
  });
}

function safePreview(
  pipeline: SafeFixPipeline,
  primary: SafeFixSourceSnapshot,
  generated: GeneratedTarget,
  create: boolean,
): SafeFixPreview {
  const plan = makePlan(primary.source, generated, create);
  const diagnostic = makeDiagnostic(primary.source, plan, generated);
  const bundle: DiagnosticBundle = Object.freeze({
    contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
    diagnostics: Object.freeze([diagnostic]),
    recordKind: "agent-context-diagnostics",
    suppressions: Object.freeze([]),
  });
  const validation = validateDiagnosticBundle(bundle, [primary.source]);
  if (!validation.ok)
    fail(
      CanonicalPolicySyncErrorCode.unsafeSource,
      "generated safe-fix diagnostic failed contract validation",
      "preview-fix",
      generated.descriptor.path,
    );
  const eligibility = issueSafeFixEligibility({
    confidence: 1,
    diagnosticId: diagnostic.id,
    plan,
    policyState: "eligible",
    ruleId: diagnostic.ruleId,
    ruleVersion: diagnostic.ruleVersion,
  });
  return pipeline.preview({
    bundle,
    candidates: [eligibility],
    minimumConfidence: SAFE_FIX_HARD_MINIMUM_CONFIDENCE,
    selectedPlanIds: [eligibility.planId],
    sources: [primary],
  });
}

function refusedTarget(
  generated: GeneratedTarget,
  beforeSha256: string | null,
  mergeState: CanonicalPolicyMergeState,
  reason: string,
): CanonicalPolicyTargetPreview {
  return Object.freeze({
    afterSha256: generated.digest,
    application: "not-applicable",
    beforeSha256,
    formatId: generated.descriptor.formatId,
    mergeState,
    nextBase: generated.base,
    patch: "",
    patchSha256: sha256(""),
    path: generated.descriptor.path,
    profiles: generated.descriptor.profiles,
    reason,
    semanticEquivalenceClaimed: false,
    state: "refused",
    targetId: generated.descriptor.targetId,
  });
}

function unrepresentableTarget(
  generated: GeneratedTarget,
  beforeSha256: string | null,
  reason: string,
): CanonicalPolicyTargetPreview {
  return Object.freeze({
    afterSha256: null,
    application: "not-applicable",
    beforeSha256,
    formatId: generated.descriptor.formatId,
    mergeState: "unrepresentable",
    nextBase: null,
    patch: "",
    patchSha256: sha256(""),
    path: generated.descriptor.path,
    profiles: generated.descriptor.profiles,
    reason,
    semanticEquivalenceClaimed: false,
    state: "refused",
    targetId: generated.descriptor.targetId,
  });
}

class RepositoryCanonicalPolicySynchronizer implements CanonicalPolicySynchronizer {
  readonly contractVersion = CANONICAL_POLICY_SYNC_CONTRACT_VERSION;
  readonly root: string;
  readonly #options: OptionsSnapshot;
  readonly #owner = Object.freeze({});
  readonly #pipeline: SafeFixPipeline;

  constructor(options: OptionsSnapshot, pipeline: SafeFixPipeline) {
    this.#options = options;
    this.#pipeline = pipeline;
    this.root = pipeline.root;
    Object.freeze(this);
  }

  async preview(requestValue: unknown): Promise<CanonicalPolicyPreview> {
    const started = process.hrtime.bigint();
    checkBudget(this.#options, started, "preview");
    const request = ownRecord(requestValue, "request", ["canonical", "policyId", "targets"]);
    const policyId = identifier(request["policyId"], "request.policyId");
    const canonical = sourceSnapshot(
      request["canonical"],
      "request.canonical",
      this.#options.maximumCanonicalBytes,
    );
    if (
      !/(?:^|\/)AGENTS\.md$/u.test(canonical.source.path) ||
      canonical.source.parseState.state !== "complete"
    )
      fail(
        CanonicalPolicySyncErrorCode.unsafeSource,
        "canonical source must be one complete AGENTS.md document",
        "validate-canonical",
        canonical.source.path,
      );
    const parsedCanonical = parseAgentsMarkdown({
      bytes: Uint8Array.from(Buffer.from(canonical.source.text, "utf8")),
      contentStatus: "complete",
      path: canonical.source.path,
      scopeRoot: scopeRoot(canonical.source.path),
    });
    if (
      parsedCanonical.decode !== "utf8" ||
      parsedCanonical.source.parseState.state !== "complete" ||
      parsedCanonical.source.sha256 !== canonical.source.sha256 ||
      parsedCanonical.source.text !== canonical.source.text
    )
      fail(
        CanonicalPolicySyncErrorCode.unsafeSource,
        "canonical source failed its real AGENTS parser round-trip",
        "validate-canonical",
        canonical.source.path,
      );
    const rawTargets = denseArray(
      request["targets"],
      "request.targets",
      CANONICAL_POLICY_SYNC_LIMITS.maximumTargets,
    );
    if (rawTargets.length !== CANONICAL_POLICY_TARGET_IDS.length)
      fail(
        CanonicalPolicySyncErrorCode.invalidInput,
        "request.targets must contain every supported target",
        "validate-input",
      );
    const root = scopeRoot(canonical.source.path);
    const canonicalRepresentationIssue = validateCanonicalCodexParity(canonical.source, root);
    if (canonicalRepresentationIssue !== null)
      fail(
        CanonicalPolicySyncErrorCode.unsafeSource,
        canonicalRepresentationIssue,
        "validate-canonical-profile",
        canonical.source.path,
      );
    const targetInputs = rawTargets.map((value, index) => {
      const record = ownRecord(value, `request.targets[${String(index)}]`, [
        "current",
        "priorBase",
        "targetId",
      ]);
      if (record["targetId"] !== CANONICAL_POLICY_TARGET_IDS[index])
        fail(
          CanonicalPolicySyncErrorCode.invalidInput,
          "request.targets must use canonical target-ID order",
          "validate-input",
        );
      return record;
    });
    const outputs: CanonicalPolicyTargetPreview[] = [];
    let aggregateBytes = 0;
    for (const targetInput of targetInputs) {
      checkBudget(this.#options, started, "preview-target");
      const targetId = targetInput["targetId"] as CanonicalPolicyTargetId;
      const generated = generatedTarget(
        targetDescriptor(targetId, root, policyId),
        canonical.source,
        policyId,
        this.#options.maximumTargetBytes,
      );
      const currentValue = targetInput["current"];
      const priorValue = targetInput["priorBase"];
      let target: CanonicalPolicyTargetPreview;
      let representationIssue = semanticRepresentationIssue(
        generated.descriptor,
        generated.content,
        parsedCanonical,
      );
      if (representationIssue === null) {
        try {
          representationIssue = await validateResolverParity(
            generated.descriptor,
            generated.content,
            root,
          );
        } catch {
          fail(
            CanonicalPolicySyncErrorCode.unsafeSource,
            "generated target failed its real profile-resolver round-trip",
            "resolve-round-trip",
            generated.descriptor.path,
          );
        }
      }
      if (
        representationIssue === null &&
        generated.descriptor.profiles.some((profile) => profile.uncertainty !== "known")
      )
        representationIssue =
          "At least one required target profile has conditional, contradictory, or unknown activation semantics.";
      checkBudget(this.#options, started, "preview-target-resolved");
      if (representationIssue !== null) {
        const current =
          currentValue === null
            ? null
            : sourceSnapshot(
                currentValue,
                `request.targets.${targetId}.current`,
                this.#options.maximumTargetBytes,
              );
        target = unrepresentableTarget(
          generated,
          current?.source.sha256 ?? null,
          representationIssue,
        );
      } else if (currentValue === null) {
        if (priorValue !== null)
          target = refusedTarget(
            generated,
            null,
            "missing-current",
            "Previously generated target is missing; automatic recreation is refused.",
          );
        else {
          const preview = safePreview(this.#pipeline, canonical, generated, true);
          target = Object.freeze({
            afterSha256: generated.digest,
            application: "preview-only",
            beforeSha256: null,
            formatId: generated.descriptor.formatId,
            mergeState: "create-preview",
            nextBase: generated.base,
            patch: preview.patch,
            patchSha256: preview.patchSha256,
            path: generated.descriptor.path,
            profiles: generated.descriptor.profiles,
            reason:
              "Creation is preview-only and has no write authority under the existing I11 portable transaction boundary.",
            semanticEquivalenceClaimed: false,
            state: "preview-only",
            targetId,
          });
          TARGET_AUTHORITY.set(
            target,
            Object.freeze({ owner: this.#owner, safePreview: null, state: "preview-only" }),
          );
        }
      } else {
        const current = sourceSnapshot(
          currentValue,
          `request.targets.${targetId}.current`,
          this.#options.maximumTargetBytes,
        );
        if (current.source.path !== generated.descriptor.path)
          fail(
            CanonicalPolicySyncErrorCode.invalidInput,
            "current target path does not match its canonical destination",
            "validate-target",
            current.source.path,
          );
        const currentSyntaxValid =
          current.source.parseState.state === "complete" &&
          validateGeneratedSyntax(
            generated.descriptor,
            current.source.text,
            parseHeader(current.source.text)?.canonicalSha256 ?? "",
            policyId,
          );
        const prior = priorValue === null ? null : validatePriorBase(priorValue, generated);
        if (!currentSyntaxValid)
          target = refusedTarget(
            generated,
            current.source.sha256,
            "malformed-current",
            "Current target is not a valid generated vendor document; overwrite is refused.",
          );
        else if (priorValue !== null && prior === null)
          target = refusedTarget(
            generated,
            current.source.sha256,
            "malformed-prior-base",
            "Prior-base metadata is malformed, mismatched, or fails parser round-trip.",
          );
        else if (
          current.source.sha256 === generated.digest &&
          current.source.text === generated.content
        )
          target = Object.freeze({
            afterSha256: generated.digest,
            application: "not-applicable",
            beforeSha256: current.source.sha256,
            formatId: generated.descriptor.formatId,
            mergeState: "already-current",
            nextBase: generated.base,
            patch: "",
            patchSha256: sha256(""),
            path: generated.descriptor.path,
            profiles: generated.descriptor.profiles,
            reason: null,
            semanticEquivalenceClaimed: false,
            state: "unchanged",
            targetId,
          });
        else if (prior === null)
          target = refusedTarget(
            generated,
            current.source.sha256,
            "untracked-existing",
            "Existing target has no valid prior generated base; overwrite is refused.",
          );
        else if (
          current.source.sha256 !== prior.generatedSha256 ||
          current.source.text !== prior.content
        )
          target = refusedTarget(
            generated,
            current.source.sha256,
            "hand-edit-conflict",
            "Current and regenerated targets both differ from the prior base; any hand edit or uncertain merge is refused.",
          );
        else {
          const preview = safePreview(this.#pipeline, current, generated, false);
          target = Object.freeze({
            afterSha256: generated.digest,
            application: "existing-file-atomic",
            beforeSha256: current.source.sha256,
            formatId: generated.descriptor.formatId,
            mergeState: "clean-update",
            nextBase: generated.base,
            patch: preview.patch,
            patchSha256: preview.patchSha256,
            path: generated.descriptor.path,
            profiles: generated.descriptor.profiles,
            reason: null,
            semanticEquivalenceClaimed: false,
            state: "ready",
            targetId,
          });
          TARGET_AUTHORITY.set(
            target,
            Object.freeze({ owner: this.#owner, safePreview: preview, state: "ready" }),
          );
        }
      }
      aggregateBytes += Buffer.byteLength(target.patch, "utf8");
      if (aggregateBytes > this.#options.maximumPatchBytes)
        fail(
          CanonicalPolicySyncErrorCode.resourceLimit,
          "aggregate canonical-policy patch exceeds its byte limit",
          "render-patch",
        );
      outputs.push(target);
    }
    const patch = outputs.map((target) => target.patch).join("");
    return Object.freeze({
      canonical: Object.freeze({
        formatId: "agents-markdown",
        path: canonical.source.path,
        profile: CODEX_IDENTITY,
        sha256: canonical.source.sha256,
      }),
      contractVersion: CANONICAL_POLICY_SYNC_CONTRACT_VERSION,
      patch,
      patchSha256: sha256(patch),
      policyId,
      recordKind: CANONICAL_POLICY_PREVIEW_RECORD_KIND,
      targets: Object.freeze(outputs),
    });
  }

  async apply(targetValue: unknown): Promise<SafeFixApplyResult> {
    if (targetValue === null || typeof targetValue !== "object" || nodeTypes.isProxy(targetValue))
      fail(
        CanonicalPolicySyncErrorCode.invalidPreview,
        "apply requires an issued target preview",
        "apply",
      );
    const authority = TARGET_AUTHORITY.get(targetValue);
    if (authority?.owner !== this.#owner || USED_TARGETS.has(targetValue))
      fail(
        CanonicalPolicySyncErrorCode.invalidPreview,
        "apply requires one unused target preview from this synchronizer",
        "apply",
      );
    USED_TARGETS.add(targetValue);
    const target = targetValue as CanonicalPolicyTargetPreview;
    if (authority.state === "preview-only" || target.mergeState === "create-preview")
      fail(
        CanonicalPolicySyncErrorCode.unsupportedApply,
        "new vendor files are preview-only under I11's existing no-clobber transaction boundary",
        "apply",
        target.path,
      );
    if (target.state !== "ready")
      fail(
        CanonicalPolicySyncErrorCode.invalidPreview,
        "only a clean existing-file update can be applied",
        "apply",
        target.path,
      );
    if (authority.safePreview === null)
      fail(
        CanonicalPolicySyncErrorCode.invalidPreview,
        "target preview has no application authority",
        "apply",
        target.path,
      );
    return this.#pipeline.apply(authority.safePreview);
  }
}

export async function createCanonicalPolicySynchronizer(
  selection: RepositoryRootSelection,
  options?: CanonicalPolicySynchronizerOptions,
): Promise<CanonicalPolicySynchronizer> {
  const selected = snapshotOptions(options);
  if (signalAborted(selected.signal))
    fail(
      CanonicalPolicySyncErrorCode.aborted,
      "canonical policy synchronization was cancelled",
      "create",
    );
  const pipeline = await createSafeFixPipeline(selection, {
    maximumBytes: selected.maximumTargetBytes,
    maximumPatchBytes: selected.maximumPatchBytes,
    ...(selected.signal === undefined ? {} : { signal: selected.signal }),
  });
  return new RepositoryCanonicalPolicySynchronizer(selected, pipeline);
}
