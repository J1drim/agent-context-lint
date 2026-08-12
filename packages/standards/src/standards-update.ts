import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";

import { parseCanonicalKnowledgePack } from "./knowledge-pack.js";
import {
  MAX_STANDARDS_CACHE_LOCK_ATTEMPTS,
  MAX_STANDARDS_CACHE_LOCK_DELAY_MS,
  MAX_STANDARDS_CACHE_LOCK_WAIT_MS,
  StandardsCache,
} from "./standards-cache.js";
import { consumeStandardsVerifiedUpdateForH09, StandardsChecker } from "./standards-check.js";
import {
  parseCanonicalStandardsLockfile,
  serializeStandardsLockfile,
  updateStandardsLockfile,
} from "./standards-lockfile.js";
import { TUF_PREVIEW_ROLE, TUF_STABLE_ROLE } from "./tuf-trust.js";

import type { KnowledgePack } from "./knowledge-pack.js";
import type { StandardsCacheIssue } from "./standards-cache.js";
import type {
  StandardsCheckIssue,
  StandardsCheckOptions,
  StandardsCheckReport,
  StandardsCheckRequest,
} from "./standards-check.js";
import type {
  StandardsLockfile,
  StandardsLockfileAtomicWriteResult,
  StandardsLockfileAtomicWriter,
  StandardsLockfileExpectedState,
} from "./standards-lockfile.js";
import type { TufTrustedMetadataSummary, TufTrustedStateSnapshot } from "./tuf-trust.js";
import {
  STANDARDS_ROLLBACK_RECEIPT_RECORD_KIND,
  STANDARDS_UPDATE_CONTRACT_VERSION,
  STANDARDS_UPDATE_RECORD_KIND,
} from "./standards-update-contract.js";

export {
  STANDARDS_ROLLBACK_RECEIPT_RECORD_KIND,
  STANDARDS_UPDATE_CONTRACT_VERSION,
  STANDARDS_UPDATE_RECORD_KIND,
} from "./standards-update-contract.js";

export type StandardsUpdateIssueSource =
  "cache" | "candidate-pack" | "check" | "current-lock" | "current-pack" | "update";

export type StandardsUpdateLocalIssueCode =
  | "candidate-binding-mismatch"
  | "candidate-pack-invalid"
  | "current-binding-mismatch"
  | "current-lock-invalid"
  | "current-pack-invalid"
  | "current-trust-mismatch"
  | "invalid-input"
  | "missing-update-authority"
  | "rollback-invalid"
  | "unexpected-failure";

export interface StandardsUpdateIssue {
  readonly code:
    StandardsUpdateLocalIssueCode | StandardsCheckIssue["code"] | StandardsCacheIssue["code"];
  readonly message: string;
  readonly path: string;
  readonly source: StandardsUpdateIssueSource;
}

export type StandardsUpdateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly issues: readonly StandardsUpdateIssue[]; readonly ok: false };

export interface StandardsUpdateRequest {
  readonly check: StandardsCheckRequest;
  readonly currentLockfile: string | Uint8Array;
  readonly currentPack: string | Uint8Array;
}

export interface StandardsUpdateSignerEvidence {
  readonly authorizedKeyCount: 3;
  readonly metadataSha256: string;
  readonly role: typeof TUF_PREVIEW_ROLE | typeof TUF_STABLE_ROLE;
  readonly threshold: 2;
}

export interface StandardsUpdateDiff {
  readonly digest: Readonly<{ readonly current: string; readonly candidate: string }>;
  readonly engineRequirement: Readonly<{
    readonly current: string;
    readonly candidate: string;
  }>;
  readonly rules: Readonly<{
    readonly added: readonly string[];
    readonly removed: readonly string[];
  }>;
  readonly version: Readonly<{ readonly current: string; readonly candidate: string }>;
}

export interface StandardsUpdatePlan {
  readonly candidateLockSha256: string;
  readonly checkedAt: string;
  readonly contractVersion: typeof STANDARDS_UPDATE_CONTRACT_VERSION;
  readonly diff: StandardsUpdateDiff;
  readonly mode: "dry-run" | "update";
  readonly noChanges: boolean;
  readonly recordKind: typeof STANDARDS_UPDATE_RECORD_KIND;
  readonly signer: StandardsUpdateSignerEvidence;
}

export interface StandardsRollbackReceipt {
  readonly activatedLockSha256: string;
  readonly activatedVersion: string;
  readonly contractVersion: typeof STANDARDS_UPDATE_CONTRACT_VERSION;
  readonly path: string;
  readonly previousLockSha256: string;
  readonly previousVersion: string;
  readonly recordKind: typeof STANDARDS_ROLLBACK_RECEIPT_RECORD_KIND;
}

export interface StandardsActivationOptions extends StandardsCheckOptions {
  readonly cache: StandardsCache;
  readonly cacheLock: Readonly<{ readonly maxAttempts: number; readonly retryDelayMs: number }>;
  readonly expected: StandardsLockfileExpectedState;
  readonly path: string;
  readonly writer: StandardsLockfileAtomicWriter;
}

export interface StandardsActivationReport {
  readonly activation: "activated" | "unchanged";
  readonly cache: "not-needed" | "reused" | "stored";
  readonly plan: StandardsUpdatePlan;
  readonly receipt: StandardsRollbackReceipt | null;
  readonly write: StandardsLockfileAtomicWriteResult | null;
}

export interface StandardsRollbackReport {
  readonly contractVersion: typeof STANDARDS_UPDATE_CONTRACT_VERSION;
  readonly recordKind: "agent-context-standards-rollback";
  readonly restoredVersion: string;
  readonly replacedVersion: string;
  readonly write: StandardsLockfileAtomicWriteResult;
}

interface VerifiedCandidate {
  readonly report: StandardsCheckReport;
  readonly targetBytes: Uint8Array;
}

interface UpdateSource {
  check(
    request: StandardsCheckRequest,
    options: StandardsCheckOptions,
  ): Promise<StandardsUpdateResult<VerifiedCandidate>>;
}

interface PreparedUpdate {
  readonly candidateBytes: Uint8Array;
  readonly candidateLock: StandardsLockfile;
  readonly plan: StandardsUpdatePlan;
  readonly previousLock: StandardsLockfile;
}

interface RollbackState {
  readonly expected: StandardsLockfileExpectedState;
  readonly path: string;
  readonly previousLock: StandardsLockfile;
  readonly previousVersion: string;
  readonly replacedVersion: string;
}

const ROLLBACK_BY_RECEIPT = new WeakMap<StandardsRollbackReceipt, RollbackState>();
let constructStandardsUpdater: (source: UpdateSource) => StandardsUpdater;

class UpdateFailure extends Error {
  readonly issue: StandardsUpdateIssue;

  constructor(
    code: StandardsUpdateLocalIssueCode,
    source: StandardsUpdateIssueSource,
    path: string,
    message: string,
  ) {
    super(message);
    this.issue = Object.freeze({ code, message, path, source });
  }
}

function fail(
  code: StandardsUpdateLocalIssueCode,
  source: StandardsUpdateIssueSource,
  path: string,
  message: string,
): never {
  throw new UpdateFailure(code, source, path, message);
}

function success<T>(value: T): StandardsUpdateResult<T> {
  return Object.freeze({ ok: true, value });
}

function failure<T>(error: unknown): StandardsUpdateResult<T> {
  const issue =
    error instanceof UpdateFailure
      ? error.issue
      : Object.freeze({
          code: "unexpected-failure" as const,
          message: "standards update failed closed",
          path: "$",
          source: "update" as const,
        });
  return Object.freeze({ issues: Object.freeze([issue]), ok: false });
}

function mappedFailure<T>(
  issue: StandardsCheckIssue | StandardsCacheIssue,
  source: "cache" | "check",
): StandardsUpdateResult<T> {
  return Object.freeze({
    issues: Object.freeze([
      Object.freeze({ code: issue.code, message: issue.message, path: issue.path, source }),
    ]),
    ok: false,
  });
}

function requiredIssue<T>(issues: readonly T[], source: "cache" | "check"): T {
  const issue = issues[0];
  if (issue === undefined)
    fail(
      "unexpected-failure",
      source,
      `$${source}`,
      `${source} operation returned no failure evidence`,
    );
  return issue;
}

function ownData(value: unknown, keys: readonly string[], path: string): Map<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    fail("invalid-input", "update", path, "must be a non-proxy plain data object");
  const prototype = Reflect.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail("invalid-input", "update", path, "fields do not match the closed contract");
  const fields = new Map<string, unknown>();
  for (const key of ownKeys as readonly string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      fail("invalid-input", "update", path, "must contain only own data properties");
    fields.set(key, descriptor.value as unknown);
  }
  return fields;
}

function ordinaryBytes(value: unknown, path: string): string | Uint8Array {
  if (typeof value === "string") return value;
  if (!nodeTypes.isUint8Array(value) || nodeTypes.isProxy(value))
    fail("invalid-input", "update", path, "must be canonical text or ordinary bytes");
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
    fail("invalid-input", "update", path, "must be canonical text or ordinary bytes");
  const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype);
  if (typedArrayPrototype === null)
    fail("invalid-input", "update", path, "must be canonical text or ordinary bytes");
  const byteLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get?.call(
    value,
  ) as number | undefined;
  if (byteLength === undefined)
    fail("invalid-input", "update", path, "must be canonical text or ordinary bytes");
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== byteLength ||
    ownKeys.some(
      (key, index) =>
        typeof key !== "string" ||
        key !== String(index) ||
        !Object.hasOwn(value, key) ||
        Reflect.getOwnPropertyDescriptor(value, key)?.get !== undefined,
    )
  )
    fail("invalid-input", "update", path, "must contain only ordinary byte elements");
  const buffer = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get?.call(
    value,
  ) as ArrayBuffer | SharedArrayBuffer | undefined;
  if (
    buffer === undefined ||
    (typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer)
  )
    fail("invalid-input", "update", path, "must not share mutable memory across agents");
  return new Uint8Array(value);
}

function hasAtomicWriteMethod(value: object): boolean {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 4; depth += 1) {
    if (nodeTypes.isProxy(current)) return false;
    const descriptor = Reflect.getOwnPropertyDescriptor(current, "write");
    if (descriptor !== undefined)
      return "value" in descriptor && typeof descriptor.value === "function";
    current = Reflect.getPrototypeOf(current);
  }
  return false;
}

function validateRequest(value: unknown): StandardsUpdateRequest {
  const fields = ownData(value, ["check", "currentLockfile", "currentPack"], "$request");
  return Object.freeze({
    check: fields.get("check") as StandardsCheckRequest,
    currentLockfile: ordinaryBytes(fields.get("currentLockfile"), "$request.currentLockfile"),
    currentPack: ordinaryBytes(fields.get("currentPack"), "$request.currentPack"),
  });
}

function nativeSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    !nodeTypes.isProxy(value) &&
    value instanceof AbortSignal &&
    Reflect.getPrototypeOf(value) === AbortSignal.prototype &&
    !Reflect.ownKeys(value).some((key) => typeof key === "string")
  );
}

function validateActivationOptions(value: unknown): StandardsActivationOptions {
  const fields = ownData(
    value,
    ["cache", "cacheLock", "expected", "path", "signal", "writer"],
    "$options",
  );
  const cache = fields.get("cache");
  const signal = fields.get("signal");
  const writer = fields.get("writer");
  if (!(cache instanceof StandardsCache))
    fail("invalid-input", "update", "$options.cache", "must be a standards cache capability");
  if (!nativeSignal(signal))
    fail("invalid-input", "update", "$options.signal", "must be a native AbortSignal");
  if (
    writer === null ||
    typeof writer !== "object" ||
    nodeTypes.isProxy(writer) ||
    !hasAtomicWriteMethod(writer)
  )
    fail("invalid-input", "update", "$options.writer", "must be an atomic writer capability");
  const lockFields = ownData(
    fields.get("cacheLock"),
    ["maxAttempts", "retryDelayMs"],
    "$options.cacheLock",
  );
  const maxAttempts = lockFields.get("maxAttempts");
  const retryDelayMs = lockFields.get("retryDelayMs");
  if (
    !Number.isSafeInteger(maxAttempts) ||
    (maxAttempts as number) < 1 ||
    (maxAttempts as number) > MAX_STANDARDS_CACHE_LOCK_ATTEMPTS
  )
    fail("invalid-input", "update", "$options.cacheLock.maxAttempts", "must be a positive integer");
  if (
    !Number.isSafeInteger(retryDelayMs) ||
    (retryDelayMs as number) < 0 ||
    (retryDelayMs as number) > MAX_STANDARDS_CACHE_LOCK_DELAY_MS ||
    (maxAttempts as number) * (retryDelayMs as number) > MAX_STANDARDS_CACHE_LOCK_WAIT_MS
  )
    fail(
      "invalid-input",
      "update",
      "$options.cacheLock.retryDelayMs",
      "must be a non-negative integer",
    );
  const expectedFields = ownData(
    fields.get("expected"),
    ["identity", "sha256"],
    "$options.expected",
  );
  const expectedSha256 = expectedFields.get("sha256");
  const identityFields = ownData(
    expectedFields.get("identity"),
    ["device", "inode"],
    "$options.expected.identity",
  );
  const device = identityFields.get("device");
  const inode = identityFields.get("inode");
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256))
    fail("invalid-input", "update", "$options.expected.sha256", "must be a SHA-256 digest");
  if (typeof device !== "string" || !/^(0|[1-9][0-9]{0,63})$/u.test(device))
    fail(
      "invalid-input",
      "update",
      "$options.expected.identity.device",
      "must be a decimal identity",
    );
  if (typeof inode !== "string" || !/^(0|[1-9][0-9]{0,63})$/u.test(inode))
    fail(
      "invalid-input",
      "update",
      "$options.expected.identity.inode",
      "must be a decimal identity",
    );
  const pathValue = fields.get("path");
  if (typeof pathValue !== "string")
    fail("invalid-input", "update", "$options.path", "must be a canonical repository file path");
  try {
    if (canonicalizeRepositoryRelativePath(pathValue) !== pathValue || pathValue === ".")
      throw new TypeError("noncanonical path");
  } catch {
    fail("invalid-input", "update", "$options.path", "must be a canonical repository file path");
  }
  return Object.freeze({
    cache,
    cacheLock: Object.freeze({
      maxAttempts: maxAttempts as number,
      retryDelayMs: retryDelayMs as number,
    }),
    expected: Object.freeze({
      identity: Object.freeze({ device, inode }),
      sha256: expectedSha256,
    }),
    path: pathValue,
    signal,
    writer: writer as StandardsLockfileAtomicWriter,
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameSummary(
  left: TufTrustedMetadataSummary | null,
  right: TufTrustedMetadataSummary | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.expires === right.expires &&
      left.issuedAt === right.issuedAt &&
      left.role === right.role &&
      left.sha256 === right.sha256 &&
      left.version === right.version)
  );
}

function sameState(left: TufTrustedStateSnapshot, right: TufTrustedStateSnapshot): boolean {
  return (
    sameSummary(left.root, right.root) &&
    sameSummary(left.snapshot, right.snapshot) &&
    sameSummary(left.targets, right.targets) &&
    sameSummary(left.timestamp, right.timestamp) &&
    sameSummary(left.delegated.preview, right.delegated.preview) &&
    sameSummary(left.delegated.stable, right.delegated.stable)
  );
}

function bindPack(
  pack: KnowledgePack,
  lock: StandardsLockfile,
  bytes: string | Uint8Array,
  source: "current-pack" | "candidate-pack",
): void {
  const mismatchCode =
    source === "current-pack" ? "current-binding-mismatch" : "candidate-binding-mismatch";
  const length = typeof bytes === "string" ? Buffer.byteLength(bytes, "utf8") : bytes.byteLength;
  if (
    length !== lock.target.length ||
    sha256(bytes) !== lock.target.sha256 ||
    pack.channel !== lock.channel ||
    pack.packId !== lock.pack.packId ||
    pack.packVersion !== lock.pack.packVersion ||
    pack.publishedAt !== lock.pack.publishedAt ||
    pack.packId !== lock.target.packId ||
    pack.packVersion !== lock.target.packVersion
  )
    fail(
      mismatchCode,
      source,
      `$request.${source === "current-pack" ? "currentPack" : "candidate"}`,
      "pack bytes do not match verified lock bindings",
    );
}

function rules(pack: KnowledgePack): readonly string[] {
  return Object.freeze(
    [...new Set(pack.knowledge.flatMap((record) => [...record.ruleIds]))].sort(),
  );
}

function difference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return Object.freeze(left.filter((value) => !rightSet.has(value)));
}

function candidateLock(report: StandardsCheckReport, pack: KnowledgePack): StandardsLockfile {
  const candidate: StandardsLockfile = Object.freeze({
    channel: report.target.channel,
    pack: Object.freeze({
      packId: pack.packId,
      packVersion: pack.packVersion,
      publishedAt: pack.publishedAt,
      schemaVersion: pack.schemaVersion,
    }),
    recordKind: "agent-context-standards-lock",
    schemaVersion: "1.0.0",
    target: report.target,
    trustedState: report.candidate,
    verificationTime: report.checkedAt,
  });
  return candidate;
}

function signer(report: StandardsCheckReport): StandardsUpdateSignerEvidence {
  const metadata = report.candidate.delegated[report.target.channel];
  if (metadata === null)
    fail(
      "candidate-binding-mismatch",
      "candidate-pack",
      "$candidate.trustedState.delegated",
      "verified candidate has no selected signer role",
    );
  return Object.freeze({
    authorizedKeyCount: 3,
    metadataSha256: metadata.sha256,
    role: report.target.channel === "stable" ? TUF_STABLE_ROLE : TUF_PREVIEW_ROLE,
    threshold: 2,
  });
}

function productionSource(checker: StandardsChecker): UpdateSource {
  return Object.freeze({
    async check(
      request: StandardsCheckRequest,
      options: StandardsCheckOptions,
    ): Promise<StandardsUpdateResult<VerifiedCandidate>> {
      const checked = await checker.check(request, options);
      if (!checked.ok) return mappedFailure(requiredIssue(checked.issues, "check"), "check");
      const verified = consumeStandardsVerifiedUpdateForH09(checked.value);
      if (verified === undefined)
        return failure(
          new UpdateFailure(
            "missing-update-authority",
            "check",
            "$check",
            "verified update authority is unavailable",
          ),
        );
      if (!sameState(verified.state.snapshot(), checked.value.candidate))
        return failure(
          new UpdateFailure(
            "missing-update-authority",
            "check",
            "$check.candidate",
            "verified update state does not match the comparison report",
          ),
        );
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          report: checked.value,
          targetBytes: new Uint8Array(verified.targetBytes),
        }),
      });
    },
  });
}

async function ensureArtifact(
  cache: StandardsCache,
  bytes: Uint8Array,
  digest: string,
  lockOptions: StandardsActivationOptions["cacheLock"],
  signal: AbortSignal,
): Promise<StandardsUpdateResult<"reused" | "stored">> {
  const request = Object.freeze({
    kind: "artifact" as const,
    length: bytes.byteLength,
    sha256: digest,
  });
  const existing = await cache.readEntry(request);
  if (existing.ok) return success("reused");
  const existingIssue = requiredIssue(existing.issues, "cache");
  if (existingIssue.code !== "cache-miss") return mappedFailure(existingIssue, "cache");
  const acquired = await cache.acquireWriteLock({ ...lockOptions, signal });
  if (!acquired.ok) return mappedFailure(requiredIssue(acquired.issues, "cache"), "cache");
  let result: StandardsUpdateResult<"reused" | "stored">;
  try {
    const stored = await cache.storeEntry(acquired.value, {
      bytes: new Uint8Array(bytes),
      kind: "artifact",
      sha256: digest,
    });
    if (stored.ok) result = success("stored");
    else if (stored.issues[0]?.code === "entry-exists") {
      const raced = await cache.readEntry(request);
      result = raced.ok
        ? success("reused")
        : mappedFailure(requiredIssue(raced.issues, "cache"), "cache");
    } else result = mappedFailure(requiredIssue(stored.issues, "cache"), "cache");
  } catch (error) {
    result = failure(error);
  }
  const released = await acquired.value.release();
  if (!released.ok) return mappedFailure(requiredIssue(released.issues, "cache"), "cache");
  return result;
}

export class StandardsUpdater {
  readonly #source: UpdateSource;

  private constructor(source: UpdateSource) {
    this.#source = source;
    Object.freeze(this);
  }

  static {
    constructStandardsUpdater = (source): StandardsUpdater => new StandardsUpdater(source);
  }

  static create(checker: StandardsChecker): StandardsUpdater {
    if (!(checker instanceof StandardsChecker))
      throw new TypeError("standards updater requires a production checker");
    return new StandardsUpdater(productionSource(checker));
  }

  async #prepare(
    input: unknown,
    options: StandardsCheckOptions,
    mode: "dry-run" | "update",
    expectedSha256?: string,
  ): Promise<StandardsUpdateResult<PreparedUpdate>> {
    try {
      const request = validateRequest(input);
      const parsedLock = parseCanonicalStandardsLockfile(request.currentLockfile);
      if (!parsedLock.ok)
        fail(
          "current-lock-invalid",
          "current-lock",
          "$request.currentLockfile",
          "current lockfile is invalid",
        );
      if (expectedSha256 !== undefined && sha256(parsedLock.canonicalJson) !== expectedSha256)
        fail(
          "current-binding-mismatch",
          "current-lock",
          "$request.currentLockfile",
          "current lock bytes do not match the observed file digest",
        );
      const parsedCurrent = parseCanonicalKnowledgePack(request.currentPack);
      if (!parsedCurrent.ok)
        fail(
          "current-pack-invalid",
          "current-pack",
          "$request.currentPack",
          "current pack is invalid",
        );
      bindPack(parsedCurrent.value, parsedLock.value, request.currentPack, "current-pack");
      const checked = await this.#source.check(request.check, options);
      if (!checked.ok) return checked;
      if (!sameState(parsedLock.value.trustedState, checked.value.report.current))
        fail(
          "current-trust-mismatch",
          "current-lock",
          "$request.currentLockfile.trustedState",
          "current lock does not match H08 trusted state",
        );
      const parsedCandidate = parseCanonicalKnowledgePack(checked.value.targetBytes);
      if (!parsedCandidate.ok)
        fail(
          "candidate-pack-invalid",
          "candidate-pack",
          "$candidate",
          "verified candidate pack is invalid",
        );
      const nextLock = candidateLock(checked.value.report, parsedCandidate.value);
      bindPack(parsedCandidate.value, nextLock, checked.value.targetBytes, "candidate-pack");
      const signerEvidence = signer(checked.value.report);
      const serialized = serializeStandardsLockfile(nextLock);
      if (!serialized.ok)
        fail(
          "candidate-binding-mismatch",
          "candidate-pack",
          "$candidate",
          "candidate lock bindings are invalid",
        );
      const currentRules = rules(parsedCurrent.value);
      const candidateRules = rules(parsedCandidate.value);
      const plan: StandardsUpdatePlan = Object.freeze({
        candidateLockSha256: sha256(serialized.text),
        checkedAt: checked.value.report.checkedAt,
        contractVersion: STANDARDS_UPDATE_CONTRACT_VERSION,
        diff: Object.freeze({
          digest: Object.freeze({
            current: parsedLock.value.target.sha256,
            candidate: nextLock.target.sha256,
          }),
          engineRequirement: Object.freeze({
            current: parsedLock.value.target.minEngineVersion,
            candidate: nextLock.target.minEngineVersion,
          }),
          rules: Object.freeze({
            added: difference(candidateRules, currentRules),
            removed: difference(currentRules, candidateRules),
          }),
          version: Object.freeze({
            current: parsedLock.value.pack.packVersion,
            candidate: nextLock.pack.packVersion,
          }),
        }),
        mode,
        noChanges: serialized.text === parsedLock.canonicalJson,
        recordKind: STANDARDS_UPDATE_RECORD_KIND,
        signer: signerEvidence,
      });
      return success(
        Object.freeze({
          candidateBytes: new Uint8Array(checked.value.targetBytes),
          candidateLock: nextLock,
          plan,
          previousLock: parsedLock.value,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  }

  async dryRun(
    request: unknown,
    options: StandardsCheckOptions,
  ): Promise<StandardsUpdateResult<StandardsUpdatePlan>> {
    const prepared = await this.#prepare(request, options, "dry-run");
    return prepared.ok ? success(prepared.value.plan) : prepared;
  }

  async activate(
    request: unknown,
    optionsInput: unknown,
  ): Promise<StandardsUpdateResult<StandardsActivationReport>> {
    let options: StandardsActivationOptions;
    try {
      options = validateActivationOptions(optionsInput);
    } catch (error) {
      return failure(error);
    }
    const prepared = await this.#prepare(request, options, "update", options.expected.sha256);
    if (!prepared.ok) return prepared;
    if (prepared.value.plan.noChanges)
      return success(
        Object.freeze({
          activation: "unchanged",
          cache: "not-needed",
          plan: prepared.value.plan,
          receipt: null,
          write: null,
        }),
      );
    const cached = await ensureArtifact(
      options.cache,
      prepared.value.candidateBytes,
      prepared.value.candidateLock.target.sha256,
      options.cacheLock,
      options.signal,
    );
    if (!cached.ok) return cached;
    const path = options.path;
    const write = await updateStandardsLockfile(options.writer, {
      expected: options.expected,
      lockfile: prepared.value.candidateLock,
      path,
    });
    const receipt: StandardsRollbackReceipt = Object.freeze({
      activatedLockSha256: write.sha256,
      activatedVersion: prepared.value.candidateLock.pack.packVersion,
      contractVersion: STANDARDS_UPDATE_CONTRACT_VERSION,
      path,
      previousLockSha256: write.previousSha256,
      previousVersion: prepared.value.previousLock.pack.packVersion,
      recordKind: STANDARDS_ROLLBACK_RECEIPT_RECORD_KIND,
    });
    ROLLBACK_BY_RECEIPT.set(
      receipt,
      Object.freeze({
        expected: Object.freeze({ identity: write.identity, sha256: write.sha256 }),
        path,
        previousLock: prepared.value.previousLock,
        previousVersion: prepared.value.previousLock.pack.packVersion,
        replacedVersion: prepared.value.candidateLock.pack.packVersion,
      }),
    );
    return success(
      Object.freeze({
        activation: "activated",
        cache: cached.value,
        plan: prepared.value.plan,
        receipt,
        write,
      }),
    );
  }
}

export async function rollbackStandardsUpdate(
  writer: StandardsLockfileAtomicWriter,
  receipt: unknown,
): Promise<StandardsUpdateResult<StandardsRollbackReport>> {
  try {
    if (receipt === null || typeof receipt !== "object" || nodeTypes.isProxy(receipt))
      fail("rollback-invalid", "update", "$receipt", "rollback receipt is not authentic");
    const state = ROLLBACK_BY_RECEIPT.get(receipt as StandardsRollbackReceipt);
    if (state === undefined)
      fail(
        "rollback-invalid",
        "update",
        "$receipt",
        "rollback receipt is not authentic or was already used",
      );
    const write = await updateStandardsLockfile(writer, {
      expected: state.expected,
      lockfile: state.previousLock,
      path: state.path,
    });
    ROLLBACK_BY_RECEIPT.delete(receipt as StandardsRollbackReceipt);
    return success(
      Object.freeze({
        contractVersion: STANDARDS_UPDATE_CONTRACT_VERSION,
        recordKind: "agent-context-standards-rollback",
        replacedVersion: state.replacedVersion,
        restoredVersion: state.previousVersion,
        write,
      }),
    );
  } catch (error) {
    if (error instanceof UpdateFailure) return failure(error);
    throw error;
  }
}

/** @internal Deterministic H09 test seam; never exported from the package root. */
export function createStandardsUpdaterFixtureForTest(source: UpdateSource): StandardsUpdater {
  return constructStandardsUpdater(source);
}
