import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { sanitizeOutputText, validateDiagnosticBundle } from "@agent-context/core";
import type {
  AtomicFixPlan,
  Diagnostic,
  DiagnosticBundle,
  FixOperation,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
} from "@agent-context/core";

import {
  ATOMIC_WRITER_DEFAULT_MAXIMUM_BYTES,
  ATOMIC_WRITER_HARD_MAXIMUM_BYTES,
  AtomicWriteError,
  createAtomicRepositoryWriter,
} from "./atomic-writer.js";
import type {
  AtomicRepositoryWriter,
  AtomicWriteDurability,
  AtomicWriteExpectedIdentity,
} from "./atomic-writer.js";
import { createReadOnlyRepository } from "./read-only-filesystem.js";
import type { ReadOnlyRepository, ReadOnlyRepositoryIdentity } from "./read-only-filesystem.js";
import type { RepositoryRootSelection } from "./repository-root.js";

export const SAFE_FIX_CONTRACT_VERSION = "0.1.0" as const;
export const SAFE_FIX_DEFAULT_MINIMUM_CONFIDENCE = 0.95;
export const SAFE_FIX_HARD_MINIMUM_CONFIDENCE = 0.95;
export const SAFE_FIX_DEFAULT_MAXIMUM_PATCH_BYTES = 33_554_432;
export const SAFE_FIX_HARD_MAXIMUM_PATCH_BYTES = 67_108_864;
export const SAFE_FIX_MAXIMUM_SELECTED_PLANS = 1_024;
export const SAFE_FIX_MAXIMUM_SOURCES = 10_000;
export const SAFE_FIX_MAXIMUM_OPERATIONS = 4_096;
export const SAFE_FIX_MAXIMUM_SOURCE_BYTES = 67_108_864;

export const SafeFixErrorCode: Readonly<{
  aborted: "SAFE_FIX_ABORTED";
  applyFailed: "SAFE_FIX_APPLY_FAILED";
  concurrentChange: "SAFE_FIX_CONCURRENT_CHANGE";
  conflict: "SAFE_FIX_CONFLICT";
  confidenceRejected: "SAFE_FIX_CONFIDENCE_REJECTED";
  invalidInput: "SAFE_FIX_INVALID_INPUT";
  invalidPreview: "SAFE_FIX_INVALID_PREVIEW";
  resourceLimit: "SAFE_FIX_RESOURCE_LIMIT";
  unsupportedOperation: "SAFE_FIX_UNSUPPORTED_OPERATION";
}> = Object.freeze({
  aborted: "SAFE_FIX_ABORTED",
  applyFailed: "SAFE_FIX_APPLY_FAILED",
  concurrentChange: "SAFE_FIX_CONCURRENT_CHANGE",
  conflict: "SAFE_FIX_CONFLICT",
  confidenceRejected: "SAFE_FIX_CONFIDENCE_REJECTED",
  invalidInput: "SAFE_FIX_INVALID_INPUT",
  invalidPreview: "SAFE_FIX_INVALID_PREVIEW",
  resourceLimit: "SAFE_FIX_RESOURCE_LIMIT",
  unsupportedOperation: "SAFE_FIX_UNSUPPORTED_OPERATION",
} as const);

export type SafeFixErrorCode = (typeof SafeFixErrorCode)[keyof typeof SafeFixErrorCode];

export class SafeFixError extends Error {
  override readonly name = "SafeFixError" as const;
  readonly causeCode: string | undefined;
  readonly code: SafeFixErrorCode;
  /** True only when the underlying atomic writer reports that publication already occurred. */
  readonly committed: boolean;
  readonly operation: string;
  readonly paths: readonly RepositoryRelativePath[];

  constructor(
    code: SafeFixErrorCode,
    message: string,
    operation: string,
    committed = false,
    paths: readonly RepositoryRelativePath[] = [],
    causeCode?: string,
  ) {
    super(message);
    this.causeCode = causeCode;
    this.code = code;
    this.committed = committed;
    this.operation = operation;
    this.paths = Object.freeze(
      paths.map((pathValue) => sanitizeOutputText(pathValue) as RepositoryRelativePath),
    );
    Object.freeze(this);
  }
}

export interface SafeFixSourceSnapshot {
  readonly identity: ReadOnlyRepositoryIdentity;
  readonly source: SourceDocument;
}

/** Unforgeable in-memory authority minted only by the post-policy mechanical-rule scheduler. */
export interface SafeFixEligibility {
  readonly contractVersion: typeof SAFE_FIX_CONTRACT_VERSION;
  readonly confidence: number;
  readonly diagnosticId: string;
  readonly planId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
}

export interface TrustedSafeFixEligibilityInput {
  readonly confidence: number;
  readonly diagnosticId: string;
  readonly policyState: "eligible";
  readonly plan: AtomicFixPlan;
  readonly ruleId: string;
  readonly ruleVersion: string;
}

export interface SafeFixPreviewRequest {
  readonly bundle: DiagnosticBundle;
  readonly candidates: readonly SafeFixEligibility[];
  readonly minimumConfidence?: number;
  /** Explicit user selection. Empty selection is a valid no-op preview. */
  readonly selectedPlanIds: readonly string[];
  readonly sources: readonly SafeFixSourceSnapshot[];
}

export interface SafeFixPipelineOptions {
  readonly maximumBytes?: number;
  readonly maximumPatchBytes?: number;
  readonly signal?: AbortSignal;
}

export interface SafeFixPreviewChange {
  readonly afterSha256: string;
  readonly beforeSha256: string | null;
  readonly destinationPath: RepositoryRelativePath | null;
  readonly editCount: number;
  readonly kind: "create-document" | "move-document" | "text-edit";
  readonly path: RepositoryRelativePath;
}

export interface SafeFixPreview {
  readonly changes: readonly SafeFixPreviewChange[];
  readonly contractVersion: typeof SAFE_FIX_CONTRACT_VERSION;
  readonly minimumConfidence: number;
  /** Terminal-safe deterministic Git-style review patch; it is not an application authority. */
  readonly patch: string;
  readonly patchSha256: string;
  readonly selectedPlanIds: readonly string[];
}

export interface SafeFixApplyResult {
  readonly appliedPaths: readonly RepositoryRelativePath[];
  readonly contractVersion: typeof SAFE_FIX_CONTRACT_VERSION;
  readonly durability: AtomicWriteDurability | "not-applicable";
  readonly patchSha256: string;
  readonly selectedPlanIds: readonly string[];
}

export interface SafeFixPipeline {
  readonly contractVersion: typeof SAFE_FIX_CONTRACT_VERSION;
  readonly maximumBytes: number;
  readonly maximumPatchBytes: number;
  readonly root: string;
  apply(preview: unknown): Promise<SafeFixApplyResult>;
  preview(request: unknown): SafeFixPreview;
}

interface OptionsSnapshot {
  readonly maximumBytes: number;
  readonly maximumPatchBytes: number;
  readonly signal?: AbortSignal;
}

interface SourceSnapshot {
  readonly identity: AtomicWriteExpectedIdentity;
  readonly sourceId: SourceDocumentId;
  readonly path: RepositoryRelativePath;
  readonly sha256: string;
  readonly text: string;
}

interface PreparedEdit {
  readonly end: number;
  readonly newText: string;
  readonly path: RepositoryRelativePath;
  readonly planId: string;
  readonly sourceId: SourceDocumentId;
  readonly start: number;
}

interface PreparedTextChange {
  readonly afterBytes: Uint8Array;
  readonly afterSha256: string;
  readonly beforeBytes: Uint8Array;
  readonly beforeSha256: string;
  readonly editCount: number;
  readonly identity: AtomicWriteExpectedIdentity;
  readonly path: RepositoryRelativePath;
}

interface PreparedPreview {
  readonly owner: object;
  readonly publicPreview: SafeFixPreview;
  readonly textChanges: readonly PreparedTextChange[];
  readonly unsupportedPaths: readonly RepositoryRelativePath[];
}

const PREVIEW_STATE = new WeakMap<object, PreparedPreview>();
const APPLIED_PREVIEWS = new WeakSet<object>();
interface EligibilityState {
  readonly confidence: number;
  readonly diagnosticId: string;
  readonly planDigest: string;
  readonly planId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
}
const ELIGIBILITY_STATE = new WeakMap<object, EligibilityState>();
const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");

function fail(
  code: SafeFixErrorCode,
  message: string,
  operation: string,
  committed = false,
  paths: readonly RepositoryRelativePath[] = [],
  causeCode?: string,
): never {
  throw new SafeFixError(code, message, operation, committed, paths, causeCode);
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
    fail(SafeFixErrorCode.invalidInput, `${label} must be a plain data object`, "validate-input");
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(SafeFixErrorCode.invalidInput, `${label} cannot be inspected safely`, "validate-input");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null)
    fail(SafeFixErrorCode.invalidInput, `${label} must be a plain data object`, "validate-input");
  const allowedSet = new Set(allowed);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowedSet.has(key))
      fail(SafeFixErrorCode.invalidInput, `${label} has an unknown field`, "validate-input");
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor))
      fail(
        SafeFixErrorCode.invalidInput,
        `${label}.${key} must be an own data property`,
        "validate-input",
      );
    output[key] = descriptor.value;
  }
  for (const key of required)
    if (!Object.hasOwn(output, key) || output[key] === undefined)
      fail(SafeFixErrorCode.invalidInput, `${label}.${key} is required`, "validate-input");
  return output;
}

function denseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value)
  )
    fail(SafeFixErrorCode.invalidInput, `${label} must be a dense array`, "validate-input");
  if (value.length > maximum)
    fail(SafeFixErrorCode.resourceLimit, `${label} exceeds its item limit`, "validate-input");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1)
    fail(SafeFixErrorCode.invalidInput, `${label} must be a dense data array`, "validate-input");
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor))
      fail(SafeFixErrorCode.invalidInput, `${label} must contain own data items`, "validate-input");
    output.push(descriptor.value);
  }
  return output;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 512 || !IDENTIFIER.test(value))
    fail(
      SafeFixErrorCode.invalidInput,
      `${label} must be a bounded stable identifier`,
      "validate-input",
    );
  return value;
}

function decimalIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,63})$/u.test(value))
    fail(
      SafeFixErrorCode.invalidInput,
      `${label} must be a decimal filesystem identity`,
      "validate-input",
    );
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function confidence(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    value < 0 ||
    value > 1
  )
    fail(
      SafeFixErrorCode.invalidInput,
      `${label} must be a finite number from 0 through 1`,
      "validate-input",
    );
  return value;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32)
    fail(
      SafeFixErrorCode.resourceLimit,
      "eligibility plan nesting exceeds its limit",
      "issue-eligibility",
    );
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))
    return JSON.stringify(value);
  if (typeof value !== "object" || nodeTypes.isProxy(value))
    fail(
      SafeFixErrorCode.invalidInput,
      "eligibility plan must be inert JSON data",
      "issue-eligibility",
    );
  if (Array.isArray(value)) {
    const items = denseArray(value, "eligibility.plan", SAFE_FIX_MAXIMUM_OPERATIONS);
    return `[${items.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null)
    fail(
      SafeFixErrorCode.invalidInput,
      "eligibility plan must be plain JSON data",
      "issue-eligibility",
    );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string"))
    fail(
      SafeFixErrorCode.invalidInput,
      "eligibility plan cannot contain symbols",
      "issue-eligibility",
    );
  return `{${(keys as string[])
    .sort(compareUtf8)
    .map((key) => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined)
        fail(
          SafeFixErrorCode.invalidInput,
          "eligibility plan must contain own JSON data",
          "issue-eligibility",
        );
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1)}`;
    })
    .join(",")}}`;
}

function fixPlanDigest(plan: AtomicFixPlan): string {
  return createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");
}

/**
 * Trusted I12/F15 boundary. Never mint this capability from repository/configuration data or for a
 * disabled, suppressed, baselined, or safety-unproved rule result.
 */
export function issueSafeFixEligibility(inputValue: unknown): SafeFixEligibility {
  const input = ownRecord(inputValue, "eligibility", [
    "confidence",
    "diagnosticId",
    "plan",
    "policyState",
    "ruleId",
    "ruleVersion",
  ]);
  if (input["policyState"] !== "eligible")
    fail(
      SafeFixErrorCode.confidenceRejected,
      "only post-policy eligible fixes may be authorized",
      "issue-eligibility",
    );
  const plan = input["plan"] as AtomicFixPlan;
  const planRecord = ownRecord(plan, "eligibility.plan", [
    "application",
    "id",
    "operations",
    "safety",
    "title",
  ]);
  const state: EligibilityState = Object.freeze({
    confidence: confidence(input["confidence"], "eligibility.confidence"),
    diagnosticId: identifier(input["diagnosticId"], "eligibility.diagnosticId"),
    planDigest: fixPlanDigest(plan),
    planId: identifier(planRecord["id"], "eligibility.plan.id"),
    ruleId: identifier(input["ruleId"], "eligibility.ruleId"),
    ruleVersion: identifier(input["ruleVersion"], "eligibility.ruleVersion"),
  });
  const eligibility: SafeFixEligibility = Object.freeze({
    confidence: state.confidence,
    contractVersion: SAFE_FIX_CONTRACT_VERSION,
    diagnosticId: state.diagnosticId,
    planId: state.planId,
    ruleId: state.ruleId,
    ruleVersion: state.ruleVersion,
  });
  ELIGIBILITY_STATE.set(eligibility, state);
  return eligibility;
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  return ABORTED_DESCRIPTOR?.get?.call(signal) !== false;
}

function validateOptions(value: unknown): OptionsSnapshot {
  if (value === undefined)
    return Object.freeze({
      maximumBytes: ATOMIC_WRITER_DEFAULT_MAXIMUM_BYTES,
      maximumPatchBytes: SAFE_FIX_DEFAULT_MAXIMUM_PATCH_BYTES,
    });
  const record = ownRecord(value, "options", ["maximumBytes", "maximumPatchBytes", "signal"], []);
  const maximumBytes = record["maximumBytes"] ?? ATOMIC_WRITER_DEFAULT_MAXIMUM_BYTES;
  const maximumPatchBytes = record["maximumPatchBytes"] ?? SAFE_FIX_DEFAULT_MAXIMUM_PATCH_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    (maximumBytes as number) < 1 ||
    (maximumBytes as number) > ATOMIC_WRITER_HARD_MAXIMUM_BYTES
  )
    fail(
      SafeFixErrorCode.invalidInput,
      "options.maximumBytes is outside the supported range",
      "validate-options",
    );
  if (
    !Number.isSafeInteger(maximumPatchBytes) ||
    (maximumPatchBytes as number) < 1 ||
    (maximumPatchBytes as number) > SAFE_FIX_HARD_MAXIMUM_PATCH_BYTES
  )
    fail(
      SafeFixErrorCode.invalidInput,
      "options.maximumPatchBytes is outside the supported range",
      "validate-options",
    );
  const signal = record["signal"];
  if (signal !== undefined) {
    try {
      if (ABORTED_DESCRIPTOR?.get?.call(signal) === undefined)
        throw new TypeError("invalid signal");
    } catch {
      fail(
        SafeFixErrorCode.invalidInput,
        "options.signal must be a native AbortSignal",
        "validate-options",
      );
    }
  }
  return Object.freeze({
    maximumBytes: maximumBytes as number,
    maximumPatchBytes: maximumPatchBytes as number,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  });
}

function snapshotSources(value: unknown): {
  readonly publicSources: readonly SourceDocument[];
  readonly sources: ReadonlyMap<string, SourceSnapshot>;
} {
  const values = denseArray(value, "request.sources", SAFE_FIX_MAXIMUM_SOURCES);
  const publicSources: SourceDocument[] = [];
  const snapshots = new Map<string, SourceSnapshot>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const [index, item] of values.entries()) {
    const record = ownRecord(item, `request.sources[${String(index)}]`, ["identity", "source"]);
    const identityRecord = ownRecord(
      record["identity"],
      `request.sources[${String(index)}].identity`,
      ["device", "inode"],
    );
    const source = record["source"] as SourceDocument;
    publicSources.push(source);
    const sourceRecord = ownRecord(source, `request.sources[${String(index)}].source`, [
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
    const sourceId = identifier(
      sourceRecord["id"],
      `request.sources[${String(index)}].source.id`,
    ) as SourceDocumentId;
    const pathValue = sourceRecord["path"];
    const sha256 = sourceRecord["sha256"];
    const text = sourceRecord["text"];
    if (
      typeof pathValue !== "string" ||
      typeof sha256 !== "string" ||
      !SHA256.test(sha256) ||
      typeof text !== "string"
    )
      fail(
        SafeFixErrorCode.invalidInput,
        "source snapshot has invalid path, digest, or text",
        "validate-input",
      );
    if (snapshots.has(sourceId) || paths.has(pathValue))
      fail(
        SafeFixErrorCode.conflict,
        "source snapshots must have unique IDs and paths",
        "plan-preview",
      );
    if (text.length > SAFE_FIX_MAXIMUM_SOURCE_BYTES)
      fail(
        SafeFixErrorCode.resourceLimit,
        "source snapshot text exceeds the aggregate byte ceiling",
        "validate-input",
      );
    const bytes = Buffer.from(text, "utf8");
    totalBytes += bytes.byteLength;
    if (
      bytes.byteLength > ATOMIC_WRITER_HARD_MAXIMUM_BYTES ||
      totalBytes > SAFE_FIX_MAXIMUM_SOURCE_BYTES ||
      digest(bytes) !== sha256
    )
      fail(
        totalBytes > SAFE_FIX_MAXIMUM_SOURCE_BYTES
          ? SafeFixErrorCode.resourceLimit
          : SafeFixErrorCode.invalidInput,
        "source snapshot bytes exceed limits or do not match their digest",
        "validate-input",
      );
    snapshots.set(
      sourceId,
      Object.freeze({
        identity: Object.freeze({
          device: decimalIdentity(
            identityRecord["device"],
            `request.sources[${String(index)}].identity.device`,
          ),
          inode: decimalIdentity(
            identityRecord["inode"],
            `request.sources[${String(index)}].identity.inode`,
          ),
        }),
        path: pathValue as RepositoryRelativePath,
        sha256,
        sourceId,
        text,
      }),
    );
    paths.add(pathValue);
  }
  return { publicSources, sources: snapshots };
}

function selectedIdentifiers(value: unknown): readonly string[] {
  const values = denseArray(value, "request.selectedPlanIds", SAFE_FIX_MAXIMUM_SELECTED_PLANS);
  const output = values.map((item, index) =>
    identifier(item, `request.selectedPlanIds[${String(index)}]`),
  );
  for (let index = 1; index < output.length; index += 1)
    if (compareUtf8(output[index - 1] ?? "", output[index] ?? "") >= 0)
      fail(
        SafeFixErrorCode.invalidInput,
        "selected plan IDs must be unique and UTF-8 sorted",
        "validate-input",
      );
  return Object.freeze(output);
}

function snapshotCandidates(value: unknown): ReadonlyMap<string, EligibilityState> {
  const values = denseArray(value, "request.candidates", SAFE_FIX_MAXIMUM_SELECTED_PLANS);
  const output = new Map<string, EligibilityState>();
  let previous = "";
  for (const [index, item] of values.entries()) {
    if (typeof item !== "object" || item === null || nodeTypes.isProxy(item))
      fail(
        SafeFixErrorCode.invalidInput,
        "candidate must be an engine-issued eligibility capability",
        "validate-input",
      );
    const state = ELIGIBILITY_STATE.get(item);
    if (state === undefined)
      fail(
        SafeFixErrorCode.invalidInput,
        "candidate must be an engine-issued eligibility capability",
        "validate-input",
      );
    const planId = state.planId;
    if (index > 0 && compareUtf8(previous, planId) >= 0)
      fail(
        SafeFixErrorCode.invalidInput,
        "candidates must have unique UTF-8-sorted plan IDs",
        "validate-input",
      );
    previous = planId;
    output.set(planId, state);
  }
  return output;
}

function escapePatchText(value: string): string {
  return sanitizeOutputText(value).replaceAll("\\", "\\\\");
}

function quotedPath(prefix: "a" | "b" | "", pathValue: RepositoryRelativePath): string {
  const safePath = sanitizeOutputText(pathValue);
  const value = prefix === "" ? safePath : `${prefix}/${safePath}`;
  return /[^\x21-\x7e]/u.test(value) || value.includes('"') ? JSON.stringify(value) : value;
}

interface PatchLine {
  readonly ended: boolean;
  readonly text: string;
}

function patchLines(text: string): readonly PatchLine[] {
  if (text.length === 0) return [];
  const lines: PatchLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit !== 0x0a && unit !== 0x0d) continue;
    if (unit === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1;
    lines.push({ ended: true, text: text.slice(start, index + 1).replace(/\n$/u, "") });
    start = index + 1;
  }
  if (start < text.length) lines.push({ ended: false, text: text.slice(start) });
  return lines;
}

function renderBody(prefix: "-" | "+", text: string): string {
  return patchLines(text)
    .map(
      (line) =>
        `${prefix}${escapePatchText(line.text)}\n${line.ended ? "" : "\\ No newline at end of file\n"}`,
    )
    .join("");
}

function renderTextPatch(
  change: PreparedTextChange,
  beforeText: string,
  afterText: string,
): string {
  const oldLines = patchLines(beforeText).length;
  const newLines = patchLines(afterText).length;
  return [
    `diff --git ${quotedPath("a", change.path)} ${quotedPath("b", change.path)}\n`,
    `--- ${quotedPath("a", change.path)}\n`,
    `+++ ${quotedPath("b", change.path)}\n`,
    `@@ -${oldLines === 0 ? "0,0" : `1,${String(oldLines)}`} +${newLines === 0 ? "0,0" : `1,${String(newLines)}`} @@\n`,
    renderBody("-", beforeText),
    renderBody("+", afterText),
  ].join("");
}

function renderCreatePatch(
  operation: Extract<FixOperation, { readonly kind: "create-document" }>,
): string {
  const lineCount = patchLines(operation.content).length;
  return [
    `diff --git ${quotedPath("a", operation.path)} ${quotedPath("b", operation.path)}\n`,
    "new file mode 100644\n",
    "--- /dev/null\n",
    `+++ ${quotedPath("b", operation.path)}\n`,
    `@@ -0,0 +${lineCount === 0 ? "0,0" : `1,${String(lineCount)}`} @@\n`,
    renderBody("+", operation.content),
  ].join("");
}

function renderMovePatch(
  operation: Extract<FixOperation, { readonly kind: "move-document" }>,
): string {
  return [
    `diff --git ${quotedPath("a", operation.path)} ${quotedPath("b", operation.destinationPath)}\n`,
    "similarity index 100%\n",
    `rename from ${quotedPath("", operation.path)}\n`,
    `rename to ${quotedPath("", operation.destinationPath)}\n`,
  ].join("");
}

function plansById(
  bundle: DiagnosticBundle,
): ReadonlyMap<string, { readonly diagnostic: Diagnostic; readonly plan: AtomicFixPlan }> {
  const output = new Map<
    string,
    { readonly diagnostic: Diagnostic; readonly plan: AtomicFixPlan }
  >();
  for (const diagnostic of bundle.diagnostics) {
    const plan = diagnostic.suggestion?.fixPlan;
    if (plan !== null && plan !== undefined) output.set(plan.id, { diagnostic, plan });
  }
  return output;
}

function rangesOverlap(left: PreparedEdit, right: PreparedEdit): boolean {
  if (left.sourceId !== right.sourceId) return false;
  if (left.start === right.start) return true;
  return left.start < right.end && right.start < left.end;
}

function applyEdits(
  source: SourceSnapshot,
  edits: readonly PreparedEdit[],
): { readonly bytes: Uint8Array; readonly text: string } {
  const ordered = [...edits].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    parts.push(source.text.slice(cursor, edit.start), edit.newText);
    cursor = edit.end;
  }
  parts.push(source.text.slice(cursor));
  const text = parts.join("");
  return { bytes: Uint8Array.from(Buffer.from(text, "utf8")), text };
}

function freezeChange(change: SafeFixPreviewChange): SafeFixPreviewChange {
  return Object.freeze(change);
}

class RepositorySafeFixPipeline implements SafeFixPipeline {
  readonly contractVersion = SAFE_FIX_CONTRACT_VERSION;
  readonly maximumBytes: number;
  readonly maximumPatchBytes: number;
  readonly root: string;
  readonly #options: OptionsSnapshot;
  readonly #reader: ReadOnlyRepository;
  readonly #writer: AtomicRepositoryWriter;
  readonly #owner = Object.freeze({});

  constructor(
    options: OptionsSnapshot,
    reader: ReadOnlyRepository,
    writer: AtomicRepositoryWriter,
  ) {
    this.#options = options;
    this.#reader = reader;
    this.#writer = writer;
    this.maximumBytes = options.maximumBytes;
    this.maximumPatchBytes = options.maximumPatchBytes;
    this.root = writer.root;
    Object.freeze(this);
  }

  preview(requestValue: unknown): SafeFixPreview {
    if (signalAborted(this.#options.signal))
      fail(SafeFixErrorCode.aborted, "fix preview was cancelled", "preview");
    const request = ownRecord(
      requestValue,
      "request",
      ["bundle", "candidates", "minimumConfidence", "selectedPlanIds", "sources"],
      ["bundle", "candidates", "selectedPlanIds", "sources"],
    );
    const { publicSources, sources } = snapshotSources(request["sources"]);
    const validation = validateDiagnosticBundle(request["bundle"], publicSources);
    if (!validation.ok)
      fail(
        SafeFixErrorCode.invalidInput,
        "diagnostic bundle or source registry is invalid",
        "validate-bundle",
      );
    const selectedPlanIds = selectedIdentifiers(request["selectedPlanIds"]);
    const candidates = snapshotCandidates(request["candidates"]);
    const minimumConfidence = confidence(
      request["minimumConfidence"] ?? SAFE_FIX_DEFAULT_MINIMUM_CONFIDENCE,
      "request.minimumConfidence",
    );
    if (minimumConfidence < SAFE_FIX_HARD_MINIMUM_CONFIDENCE)
      fail(
        SafeFixErrorCode.confidenceRejected,
        "minimum confidence is below the mechanical-fix safety floor",
        "confidence-gate",
      );
    const available = plansById(validation.value);
    const operations: { readonly operation: FixOperation; readonly planId: string }[] = [];
    for (const planId of selectedPlanIds) {
      const candidate = candidates.get(planId);
      const selected = available.get(planId);
      if (selected === undefined)
        fail(
          SafeFixErrorCode.invalidInput,
          "selected plan is not present in the diagnostic bundle",
          "select-plan",
        );
      if (candidate?.diagnosticId !== selected.diagnostic.id)
        fail(
          SafeFixErrorCode.invalidInput,
          "selected plan is not bound to its exact diagnostic candidate",
          "select-plan",
        );
      if (candidate.confidence < minimumConfidence)
        fail(
          SafeFixErrorCode.confidenceRejected,
          "selected plan does not meet the confidence threshold",
          "confidence-gate",
        );
      if (
        candidate.ruleId !== selected.diagnostic.ruleId ||
        candidate.ruleVersion !== selected.diagnostic.ruleVersion ||
        candidate.planDigest !== fixPlanDigest(selected.plan)
      )
        fail(
          SafeFixErrorCode.invalidInput,
          "eligibility capability does not match the exact diagnostic rule and plan",
          "select-plan",
        );
      const suppressed = validation.value.suppressions.some(
        (record) =>
          record.state === "suppressed" &&
          (record.matchedPathFingerprints.includes(selected.diagnostic.fingerprints.path.value) ||
            record.matchedPathFingerprints.includes(
              selected.diagnostic.fingerprints.semantic.value,
            )),
      );
      if (suppressed)
        fail(
          SafeFixErrorCode.confidenceRejected,
          "suppressed diagnostics cannot contribute automatic edits",
          "policy-gate",
        );
      for (const operation of selected.plan.operations) {
        if (operations.length >= SAFE_FIX_MAXIMUM_OPERATIONS)
          fail(
            SafeFixErrorCode.resourceLimit,
            "selected plans exceed the aggregate operation limit",
            "select-plan",
          );
        operations.push({ operation, planId });
      }
    }

    const edits: PreparedEdit[] = [];
    const moveSources = new Set<string>();
    const editedSources = new Set<string>();
    const destinations = new Set<string>();
    const existingPaths = new Set([...sources.values()].map((source) => source.path));
    const previewChanges: SafeFixPreviewChange[] = [];
    const unsupportedPaths: RepositoryRelativePath[] = [];
    const patchParts: string[] = [];
    const patchItems: {
      readonly kind: SafeFixPreviewChange["kind"];
      readonly path: RepositoryRelativePath;
      readonly text: string;
    }[] = [];
    let patchBytes = 0;
    const addPatch = (part: string): void => {
      patchBytes += Buffer.byteLength(part, "utf8");
      if (patchBytes > this.maximumPatchBytes)
        fail(
          SafeFixErrorCode.resourceLimit,
          "deterministic preview patch exceeds its byte limit",
          "render-patch",
        );
      patchParts.push(part);
    };
    const queuePatch = (
      pathValue: RepositoryRelativePath,
      kind: SafeFixPreviewChange["kind"],
      text: string,
    ): void => {
      patchItems.push({ kind, path: pathValue, text });
    };
    const createsAndMoves: { readonly operation: FixOperation; readonly planId: string }[] = [];
    for (const selected of operations) {
      const operation = selected.operation;
      if (operation.kind === "text-edit") {
        const edit: PreparedEdit = Object.freeze({
          end: operation.range.end.utf16Offset,
          newText: operation.newText,
          path: operation.path,
          planId: selected.planId,
          sourceId: operation.sourceId,
          start: operation.range.start.utf16Offset,
        });
        edits.push(edit);
        editedSources.add(operation.sourceId);
      } else {
        createsAndMoves.push(selected);
        const destination =
          operation.kind === "create-document" ? operation.path : operation.destinationPath;
        if (destinations.has(destination) || existingPaths.has(destination))
          fail(
            SafeFixErrorCode.conflict,
            "selected plan destination is not absent or is shared",
            "plan-preview",
            false,
            [destination],
          );
        destinations.add(destination);
        unsupportedPaths.push(operation.path);
        if (operation.kind === "move-document") {
          if (moveSources.has(operation.sourceId))
            fail(
              SafeFixErrorCode.conflict,
              "selected plans move one source more than once",
              "plan-preview",
              false,
              [operation.path],
            );
          moveSources.add(operation.sourceId);
        }
      }
    }
    edits.sort(
      (left, right) =>
        compareUtf8(left.sourceId, right.sourceId) ||
        left.start - right.start ||
        left.end - right.end ||
        compareUtf8(left.planId, right.planId),
    );
    for (let index = 1; index < edits.length; index += 1) {
      const prior = edits[index - 1];
      const current = edits[index];
      if (prior !== undefined && current !== undefined && rangesOverlap(prior, current))
        fail(
          SafeFixErrorCode.conflict,
          "selected plans contain overlapping edits",
          "plan-preview",
          false,
          [current.path],
        );
    }
    for (const sourceId of moveSources)
      if (editedSources.has(sourceId))
        fail(
          SafeFixErrorCode.conflict,
          "selected plans both edit and move one source",
          "plan-preview",
        );

    const textChanges: PreparedTextChange[] = [];
    const editsBySource = new Map<string, PreparedEdit[]>();
    for (const edit of edits) {
      const selected = editsBySource.get(edit.sourceId) ?? [];
      selected.push(edit);
      editsBySource.set(edit.sourceId, selected);
    }
    for (const [sourceId, sourceEdits] of [...editsBySource].sort((left, right) =>
      compareUtf8(left[1][0]?.path ?? "", right[1][0]?.path ?? ""),
    )) {
      const source = sources.get(sourceId);
      if (source === undefined)
        fail(
          SafeFixErrorCode.invalidInput,
          "selected edit references an unknown source",
          "plan-preview",
        );
      const applied = applyEdits(source, sourceEdits);
      if (applied.bytes.byteLength > this.maximumBytes)
        fail(
          SafeFixErrorCode.resourceLimit,
          "planned replacement exceeds the write byte limit",
          "plan-preview",
          false,
          [source.path],
        );
      const afterSha256 = digest(applied.bytes);
      if (afterSha256 === source.sha256)
        fail(
          SafeFixErrorCode.conflict,
          "selected edits produce no source change",
          "plan-preview",
          false,
          [source.path],
        );
      const change: PreparedTextChange = Object.freeze({
        afterBytes: Uint8Array.from(applied.bytes),
        afterSha256,
        beforeBytes: Uint8Array.from(Buffer.from(source.text, "utf8")),
        beforeSha256: source.sha256,
        editCount: sourceEdits.length,
        identity: source.identity,
        path: source.path,
      });
      textChanges.push(change);
      previewChanges.push(
        freezeChange({
          afterSha256,
          beforeSha256: source.sha256,
          destinationPath: null,
          editCount: sourceEdits.length,
          kind: "text-edit",
          path: source.path,
        }),
      );
      queuePatch(change.path, "text-edit", renderTextPatch(change, source.text, applied.text));
    }
    for (const selected of createsAndMoves.sort((left, right) => {
      const leftPath =
        left.operation.kind === "move-document"
          ? left.operation.destinationPath
          : left.operation.path;
      const rightPath =
        right.operation.kind === "move-document"
          ? right.operation.destinationPath
          : right.operation.path;
      return compareUtf8(leftPath, rightPath);
    })) {
      const operation = selected.operation;
      if (operation.kind === "create-document") {
        previewChanges.push(
          freezeChange({
            afterSha256: operation.contentDigest,
            beforeSha256: null,
            destinationPath: null,
            editCount: 0,
            kind: operation.kind,
            path: operation.path,
          }),
        );
        queuePatch(operation.path, operation.kind, renderCreatePatch(operation));
      } else if (operation.kind === "move-document") {
        const source = sources.get(operation.sourceId);
        if (source === undefined)
          fail(
            SafeFixErrorCode.invalidInput,
            "selected move references an unknown source",
            "plan-preview",
          );
        previewChanges.push(
          freezeChange({
            afterSha256: source.sha256,
            beforeSha256: source.sha256,
            destinationPath: operation.destinationPath,
            editCount: 0,
            kind: operation.kind,
            path: operation.path,
          }),
        );
        queuePatch(operation.path, operation.kind, renderMovePatch(operation));
      }
    }
    previewChanges.sort(
      (left, right) => compareUtf8(left.path, right.path) || compareUtf8(left.kind, right.kind),
    );
    patchItems.sort(
      (left, right) => compareUtf8(left.path, right.path) || compareUtf8(left.kind, right.kind),
    );
    for (const item of patchItems) addPatch(item.text);
    const patch = patchParts.join("");
    const publicPreview: SafeFixPreview = Object.freeze({
      changes: Object.freeze(previewChanges),
      contractVersion: SAFE_FIX_CONTRACT_VERSION,
      minimumConfidence,
      patch,
      patchSha256: createHash("sha256").update(patch, "utf8").digest("hex"),
      selectedPlanIds,
    });
    PREVIEW_STATE.set(
      publicPreview,
      Object.freeze({
        owner: this.#owner,
        publicPreview,
        textChanges: Object.freeze(textChanges),
        unsupportedPaths: Object.freeze([...unsupportedPaths].sort(compareUtf8)),
      }),
    );
    return publicPreview;
  }

  async apply(previewValue: unknown): Promise<SafeFixApplyResult> {
    if (
      typeof previewValue !== "object" ||
      previewValue === null ||
      nodeTypes.isProxy(previewValue)
    )
      fail(
        SafeFixErrorCode.invalidPreview,
        "apply requires an unmodified preview from this pipeline",
        "apply",
      );
    const prepared = PREVIEW_STATE.get(previewValue);
    if (prepared === undefined)
      fail(
        SafeFixErrorCode.invalidPreview,
        "apply requires one unused, unmodified preview from this pipeline",
        "apply",
      );
    if (prepared.owner !== this.#owner || APPLIED_PREVIEWS.has(previewValue))
      fail(
        SafeFixErrorCode.invalidPreview,
        "apply requires one unused, unmodified preview from this pipeline",
        "apply",
      );
    APPLIED_PREVIEWS.add(previewValue);
    if (prepared.unsupportedPaths.length > 0)
      fail(
        SafeFixErrorCode.unsupportedOperation,
        "creation and move plans are preview-only until a portable no-clobber transaction is available",
        "apply",
        false,
        prepared.unsupportedPaths,
      );
    if (prepared.textChanges.length > 1)
      fail(
        SafeFixErrorCode.unsupportedOperation,
        "portable crash-safe application is limited to one existing file per preview",
        "apply",
        false,
        prepared.textChanges.map((change) => change.path),
      );
    if (signalAborted(this.#options.signal))
      fail(SafeFixErrorCode.aborted, "fix application was cancelled", "preflight");

    for (const change of prepared.textChanges) {
      let file;
      try {
        file = await this.#reader.readFile(change.path);
      } catch (error) {
        const causeCode =
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : undefined;
        fail(
          SafeFixErrorCode.concurrentChange,
          "selected source could not be revalidated",
          "preflight",
          false,
          [change.path],
          causeCode,
        );
      }
      const currentBytes = file.bytes();
      if (
        file.identity.device !== change.identity.device ||
        file.identity.inode !== change.identity.inode ||
        digest(currentBytes) !== change.beforeSha256 ||
        !Buffer.from(currentBytes).equals(Buffer.from(change.beforeBytes))
      )
        fail(
          SafeFixErrorCode.concurrentChange,
          "selected source changed after preview",
          "preflight",
          false,
          [change.path],
        );
    }

    const change = prepared.textChanges[0];
    if (change === undefined)
      return Object.freeze({
        appliedPaths: Object.freeze([]),
        contractVersion: SAFE_FIX_CONTRACT_VERSION,
        durability: "not-applicable",
        patchSha256: prepared.publicPreview.patchSha256,
        selectedPlanIds: prepared.publicPreview.selectedPlanIds,
      });
    let durability: AtomicWriteDurability;
    try {
      const result = await this.#writer.write({
        expected: { identity: change.identity, sha256: change.beforeSha256 },
        path: change.path,
        replacement: change.afterBytes,
      });
      durability = result.durability;
    } catch (error) {
      const causeCode = error instanceof AtomicWriteError ? error.code : undefined;
      const committed = error instanceof AtomicWriteError && error.committed;
      if (
        !committed &&
        (signalAborted(this.#options.signal) || causeCode === "ATOMIC_WRITE_ABORTED")
      )
        fail(
          SafeFixErrorCode.aborted,
          "fix application was cancelled before commit",
          "apply",
          false,
          [],
          causeCode,
        );
      fail(
        SafeFixErrorCode.applyFailed,
        committed
          ? "single-file fix committed but its durability or cleanup could not be proven"
          : "single-file fix failed before commit",
        "apply",
        committed,
        committed ? [change.path] : [],
        causeCode,
      );
    }
    return Object.freeze({
      appliedPaths: Object.freeze([change.path]),
      contractVersion: SAFE_FIX_CONTRACT_VERSION,
      durability,
      patchSha256: prepared.publicPreview.patchSha256,
      selectedPlanIds: prepared.publicPreview.selectedPlanIds,
    });
  }
}

export async function createSafeFixPipeline(
  selection: RepositoryRootSelection,
  options?: SafeFixPipelineOptions,
): Promise<SafeFixPipeline> {
  const selectedOptions = validateOptions(options);
  try {
    const reader = await createReadOnlyRepository(selection, {
      maximumFileBytes: selectedOptions.maximumBytes,
      maximumTotalBytes: ATOMIC_WRITER_HARD_MAXIMUM_BYTES,
      ...(selectedOptions.signal === undefined ? {} : { signal: selectedOptions.signal }),
    });
    const writer = await createAtomicRepositoryWriter(selection, {
      maximumBytes: selectedOptions.maximumBytes,
      ...(selectedOptions.signal === undefined ? {} : { signal: selectedOptions.signal }),
    });
    return new RepositorySafeFixPipeline(selectedOptions, reader, writer);
  } catch (error) {
    if (error instanceof SafeFixError) throw error;
    const causeCode =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    if (signalAborted(selectedOptions.signal))
      fail(
        SafeFixErrorCode.aborted,
        "safe fix pipeline construction was cancelled",
        "create-pipeline",
        false,
        [],
        causeCode,
      );
    fail(
      SafeFixErrorCode.invalidInput,
      "safe fix pipeline could not bind the repository selection",
      "create-pipeline",
      false,
      [],
      causeCode,
    );
  }
}
