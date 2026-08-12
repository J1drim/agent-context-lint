import { types as nodeTypes } from "node:util";

import {
  CONFIGURATION_PROFILE_IDS,
  serializeNativeOutput,
  type ClientProfileId,
  type RepositoryRelativePath,
  type ScanJsonOutput,
  type SourceDocument,
  isRepositoryRelativePath,
} from "@agent-context/core";

export const LIBRARY_API_CONTRACT_VERSION = "1.0.0" as const;
export const LIBRARY_SCAN_REQUEST_KIND = "agent-context-library-scan-request" as const;
export const LIBRARY_SCAN_CAPABILITY_KIND = "agent-context-library-scan-capability" as const;
export const LIBRARY_PROGRESS_KIND = "agent-context-library-progress" as const;

export interface LibraryApiLimits {
  readonly maximumProfileCount: number;
  readonly maximumProgressUnits: number;
  readonly maximumRepositoryRootBytes: number;
  readonly maximumTargetCount: number;
}

export const LIBRARY_API_LIMITS: Readonly<LibraryApiLimits> = Object.freeze({
  maximumProfileCount: CONFIGURATION_PROFILE_IDS.length,
  maximumProgressUnits: 100_000,
  maximumRepositoryRootBytes: 16_384,
  maximumTargetCount: 100_000,
});

export interface LibraryScanRequest {
  readonly contractVersion: typeof LIBRARY_API_CONTRACT_VERSION;
  readonly profileIds: readonly ClientProfileId[];
  readonly progressUnits: number;
  readonly recordKind: typeof LIBRARY_SCAN_REQUEST_KIND;
  /** Canonical absolute `file:` URL. Filesystem access remains owned by the injected capability. */
  readonly repositoryRoot: string;
  readonly targetPaths: readonly RepositoryRelativePath[];
}

export type LibraryProgressState = "started" | "running" | "completed";

export interface LibraryScanProgress {
  readonly completedUnits: number;
  readonly contractVersion: typeof LIBRARY_API_CONTRACT_VERSION;
  readonly progressUnits: number;
  readonly recordKind: typeof LIBRARY_PROGRESS_KIND;
  readonly sequence: number;
  readonly state: LibraryProgressState;
}

export type LibraryProgressObserver = (progress: LibraryScanProgress) => void;

export interface LibraryScanOptions {
  readonly onProgress?: LibraryProgressObserver | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface LibraryScanExecutionResult {
  readonly output: ScanJsonOutput;
  readonly sources: readonly SourceDocument[];
}

export interface LibraryScanExecutionContext {
  /** Report one completed deterministic work unit. No repository-controlled identity is exposed. */
  readonly reportProgress: () => void;
  readonly signal: AbortSignal;
}

export type LibraryScanExecutor = (
  request: LibraryScanRequest,
  context: LibraryScanExecutionContext,
) => Promise<LibraryScanExecutionResult>;

/** Opaque same-process authority to perform filesystem-backed scan work. */
export interface LibraryScanCapability {
  readonly contractVersion: typeof LIBRARY_API_CONTRACT_VERSION;
  readonly recordKind: typeof LIBRARY_SCAN_CAPABILITY_KIND;
}

export const LibraryApiErrorCode: Readonly<{
  cancelled: "LIBRARY_CANCELLED";
  engineFailed: "LIBRARY_ENGINE_FAILED";
  invalidCapability: "LIBRARY_INVALID_CAPABILITY";
  invalidInput: "LIBRARY_INVALID_INPUT";
  invalidOptions: "LIBRARY_INVALID_OPTIONS";
  invalidResult: "LIBRARY_INVALID_RESULT";
  progressFailed: "LIBRARY_PROGRESS_FAILED";
  resourceLimit: "LIBRARY_RESOURCE_LIMIT";
}> = Object.freeze({
  cancelled: "LIBRARY_CANCELLED",
  engineFailed: "LIBRARY_ENGINE_FAILED",
  invalidCapability: "LIBRARY_INVALID_CAPABILITY",
  invalidInput: "LIBRARY_INVALID_INPUT",
  invalidOptions: "LIBRARY_INVALID_OPTIONS",
  invalidResult: "LIBRARY_INVALID_RESULT",
  progressFailed: "LIBRARY_PROGRESS_FAILED",
  resourceLimit: "LIBRARY_RESOURCE_LIMIT",
});

export type LibraryApiErrorCode = (typeof LibraryApiErrorCode)[keyof typeof LibraryApiErrorCode];

export type LibraryApiErrorCategory = "cancellation" | "input" | "operational" | "resource";

const ERROR_DEFINITIONS: Readonly<
  Record<
    LibraryApiErrorCode,
    Readonly<{
      readonly category: LibraryApiErrorCategory;
      readonly message: string;
      readonly retryable: boolean;
    }>
  >
> = Object.freeze({
  LIBRARY_CANCELLED: Object.freeze({
    category: "cancellation",
    message: "the library scan was cancelled",
    retryable: true,
  }),
  LIBRARY_ENGINE_FAILED: Object.freeze({
    category: "operational",
    message: "the library scan engine failed",
    retryable: false,
  }),
  LIBRARY_INVALID_CAPABILITY: Object.freeze({
    category: "input",
    message: "the library scan capability is invalid",
    retryable: false,
  }),
  LIBRARY_INVALID_INPUT: Object.freeze({
    category: "input",
    message: "the library scan request is invalid",
    retryable: false,
  }),
  LIBRARY_INVALID_OPTIONS: Object.freeze({
    category: "input",
    message: "the library scan options are invalid",
    retryable: false,
  }),
  LIBRARY_INVALID_RESULT: Object.freeze({
    category: "operational",
    message: "the library scan engine returned an invalid result",
    retryable: false,
  }),
  LIBRARY_PROGRESS_FAILED: Object.freeze({
    category: "operational",
    message: "the library progress observer failed",
    retryable: false,
  }),
  LIBRARY_RESOURCE_LIMIT: Object.freeze({
    category: "resource",
    message: "the library scan exceeded a resource limit",
    retryable: false,
  }),
});

const ISSUED_ERRORS = new WeakSet<object>();

export class LibraryApiError extends Error {
  readonly category: LibraryApiErrorCategory;
  readonly code: LibraryApiErrorCode;
  override readonly name = "LibraryApiError" as const;
  readonly retryable: boolean;

  private constructor(code: LibraryApiErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.category = definition.category;
    this.code = code;
    this.retryable = definition.retryable;
    ISSUED_ERRORS.add(this);
    Object.freeze(this);
  }

  static create(code: LibraryApiErrorCode): LibraryApiError {
    return new LibraryApiError(code);
  }
}

export function isLibraryApiError(value: unknown): value is LibraryApiError {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    !nodeTypes.isProxy(value) &&
    ISSUED_ERRORS.has(value)
  );
}

type DataRecord = Readonly<Record<string, unknown>>;
type StopReason = "cancelled" | "progress" | "resource";

const PROFILE_IDS = new Set<string>(CONFIGURATION_PROFILE_IDS);
const REQUEST_KEYS = new Set([
  "contractVersion",
  "profileIds",
  "progressUnits",
  "recordKind",
  "repositoryRoot",
  "targetPaths",
]);
const OPTION_KEYS = new Set(["onProgress", "signal"]);
const EXECUTION_RESULT_KEYS = new Set(["output", "sources"]);
const CAPABILITY_EXECUTORS = new WeakMap<object, LibraryScanExecutor>();
const ISSUED_CAPABILITIES = new WeakSet<object>();
const NATIVE_ABORT_CONTROLLER = AbortController;
const NATIVE_URL = URL;
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with an issued controller.
const ABORT_CONTROLLER_ABORT = AbortController.prototype.abort;
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with an issued controller.
const ABORT_CONTROLLER_SIGNAL_GETTER = Object.getOwnPropertyDescriptor(
  AbortController.prototype,
  "signal",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with the checked receiver.
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with the checked receiver.
const EVENT_TARGET_ADD = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with the checked receiver.
const EVENT_TARGET_REMOVE = EventTarget.prototype.removeEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- called only with a native promise.
const PROMISE_THEN = Promise.prototype.then;

function fail(code: LibraryApiErrorCode): never {
  throw LibraryApiError.create(code);
}

function dataRecord(value: unknown, code: LibraryApiErrorCode): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  )
    return fail(code);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(code);
  return value as DataRecord;
}

function closedRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  code: LibraryApiErrorCode,
): DataRecord {
  const record = dataRecord(value, code);
  const actual = Reflect.ownKeys(record);
  if (
    actual.length !== keys.size ||
    actual.some((key) => typeof key !== "string" || !keys.has(key))
  )
    return fail(code);
  for (const key of actual) {
    const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(code);
  }
  return record;
}

function optionalClosedRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  code: LibraryApiErrorCode,
): DataRecord {
  if (value === undefined) return Object.freeze({});
  const record = dataRecord(value, code);
  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== "string" || !keys.has(key))) return fail(code);
  for (const key of actual) {
    const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(code);
  }
  return record;
}

function ownValue(record: DataRecord, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  /* v8 ignore next -- callers validate that all requested fields are own data properties. */
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function denseArray(
  value: unknown,
  maximum: number,
  code: LibraryApiErrorCode,
): readonly unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail(
      value instanceof Array && value.length > maximum ? LibraryApiErrorCode.resourceLimit : code,
    );
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalFileUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > LIBRARY_API_LIMITS.maximumRepositoryRootBytes
  )
    return fail(
      typeof value === "string" &&
        Buffer.byteLength(value, "utf8") > LIBRARY_API_LIMITS.maximumRepositoryRootBytes
        ? LibraryApiErrorCode.resourceLimit
        : LibraryApiErrorCode.invalidInput,
    );
  let parsed: URL;
  try {
    parsed = new NATIVE_URL(value);
  } catch {
    return fail(LibraryApiErrorCode.invalidInput);
  }
  if (
    parsed.protocol !== "file:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.toString() !== value
  )
    return fail(LibraryApiErrorCode.invalidInput);
  return value;
}

function normalizeStringArray<T extends string>(
  value: unknown,
  maximum: number,
  member: (entry: unknown) => entry is T,
): readonly T[] {
  const entries = denseArray(value, maximum, LibraryApiErrorCode.invalidInput);
  const result: T[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!member(entry) || seen.has(entry)) return fail(LibraryApiErrorCode.invalidInput);
    seen.add(entry);
    result.push(entry);
  }
  return Object.freeze(result.sort(compareUtf8));
}

function normalizeRequest(value: unknown): LibraryScanRequest {
  const record = closedRecord(value, REQUEST_KEYS, LibraryApiErrorCode.invalidInput);
  if (
    ownValue(record, "contractVersion") !== LIBRARY_API_CONTRACT_VERSION ||
    ownValue(record, "recordKind") !== LIBRARY_SCAN_REQUEST_KIND
  )
    return fail(LibraryApiErrorCode.invalidInput);
  const progressUnits = ownValue(record, "progressUnits");
  if (!Number.isSafeInteger(progressUnits) || (progressUnits as number) < 0)
    return fail(LibraryApiErrorCode.invalidInput);
  if ((progressUnits as number) > LIBRARY_API_LIMITS.maximumProgressUnits)
    return fail(LibraryApiErrorCode.resourceLimit);
  const profileIds = normalizeStringArray(
    ownValue(record, "profileIds"),
    LIBRARY_API_LIMITS.maximumProfileCount,
    (entry): entry is ClientProfileId => typeof entry === "string" && PROFILE_IDS.has(entry),
  );
  if (profileIds.length === 0) return fail(LibraryApiErrorCode.invalidInput);
  const targetPaths = normalizeStringArray(
    ownValue(record, "targetPaths"),
    LIBRARY_API_LIMITS.maximumTargetCount,
    (entry): entry is RepositoryRelativePath =>
      typeof entry === "string" && isRepositoryRelativePath(entry),
  );
  return Object.freeze({
    contractVersion: LIBRARY_API_CONTRACT_VERSION,
    profileIds,
    progressUnits: progressUnits as number,
    recordKind: LIBRARY_SCAN_REQUEST_KIND,
    repositoryRoot: canonicalFileUrl(ownValue(record, "repositoryRoot")),
    targetPaths,
  });
}

function nativeAbortState(value: unknown): boolean | undefined {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return undefined;
  if (ABORTED_GETTER === undefined) return undefined;
  try {
    const state: unknown = Reflect.apply(ABORTED_GETTER, value, []);
    return typeof state === "boolean" ? state : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptions(value: unknown): {
  readonly onProgress: LibraryProgressObserver | undefined;
  readonly signal: AbortSignal | undefined;
} {
  const record = optionalClosedRecord(value, OPTION_KEYS, LibraryApiErrorCode.invalidOptions);
  let signal: AbortSignal | undefined;
  let onProgress: LibraryProgressObserver | undefined;
  if (Reflect.has(record, "signal")) {
    const candidate = ownValue(record, "signal");
    if (candidate !== undefined) {
      if (nativeAbortState(candidate) === undefined)
        return fail(LibraryApiErrorCode.invalidOptions);
      signal = candidate as AbortSignal;
    }
  }
  if (Reflect.has(record, "onProgress")) {
    const candidate = ownValue(record, "onProgress");
    if (candidate !== undefined) {
      if (typeof candidate !== "function" || nodeTypes.isProxy(candidate))
        return fail(LibraryApiErrorCode.invalidOptions);
      onProgress = candidate as LibraryProgressObserver;
    }
  }
  return { onProgress, signal };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalOutput(value: unknown, sources: unknown): ScanJsonOutput {
  if (
    sources === null ||
    typeof sources !== "object" ||
    nodeTypes.isProxy(sources) ||
    !Array.isArray(sources) ||
    Reflect.getPrototypeOf(sources) !== Array.prototype
  )
    return fail(LibraryApiErrorCode.invalidResult);
  const serialized = serializeNativeOutput(value, sources as readonly SourceDocument[]);
  if (!serialized.ok) return fail(LibraryApiErrorCode.invalidResult);
  try {
    return deepFreeze(JSON.parse(serialized.text) as ScanJsonOutput);
  } catch {
    /* v8 ignore next -- successful core serialization always emits JSON. */
    return fail(LibraryApiErrorCode.invalidResult);
  }
}

function progressRecord(
  completedUnits: number,
  progressUnits: number,
  sequence: number,
  state: LibraryProgressState,
): LibraryScanProgress {
  return Object.freeze({
    completedUnits,
    contractVersion: LIBRARY_API_CONTRACT_VERSION,
    progressUnits,
    recordKind: LIBRARY_PROGRESS_KIND,
    sequence,
    state,
  });
}

/** Mint a trusted scan engine authority. Executable callbacks must never originate in repository data. */
export function createLibraryScanCapability(executor: LibraryScanExecutor): LibraryScanCapability {
  if (typeof executor !== "function" || nodeTypes.isProxy(executor))
    return fail(LibraryApiErrorCode.invalidCapability);
  const capability = Object.freeze({
    contractVersion: LIBRARY_API_CONTRACT_VERSION,
    recordKind: LIBRARY_SCAN_CAPABILITY_KIND,
  });
  ISSUED_CAPABILITIES.add(capability);
  CAPABILITY_EXECUTORS.set(capability, executor);
  return capability;
}

export function isIssuedLibraryScanCapability(value: unknown): value is LibraryScanCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    !nodeTypes.isProxy(value) &&
    Object.isFrozen(value) &&
    ISSUED_CAPABILITIES.has(value)
  );
}

function errorForStop(reason: StopReason): LibraryApiErrorCode {
  if (reason === "cancelled") return LibraryApiErrorCode.cancelled;
  if (reason === "progress") return LibraryApiErrorCode.progressFailed;
  return LibraryApiErrorCode.resourceLimit;
}

/**
 * Run one public scan. Cancellation does not settle until the trusted engine has released its work,
 * so a rejected call cannot leave API-owned listeners or falsely claim that cleanup is complete.
 */
export async function scanAgentContext(
  requestValue: unknown,
  capabilityValue: unknown,
  optionsValue?: LibraryScanOptions,
): Promise<ScanJsonOutput> {
  const request = normalizeRequest(requestValue);
  const options = normalizeOptions(optionsValue);
  if (!isIssuedLibraryScanCapability(capabilityValue))
    return fail(LibraryApiErrorCode.invalidCapability);
  const executor = CAPABILITY_EXECUTORS.get(capabilityValue);
  /* v8 ignore next -- issuance and executor registration occur atomically. */
  if (executor === undefined) return fail(LibraryApiErrorCode.invalidCapability);
  if (options.signal !== undefined && nativeAbortState(options.signal) !== false)
    return fail(LibraryApiErrorCode.cancelled);

  const controller = new NATIVE_ABORT_CONTROLLER();
  /* v8 ignore next -- supported Node lines always expose the native signal getter. */
  const derivedSignal =
    ABORT_CONTROLLER_SIGNAL_GETTER === undefined
      ? controller.signal
      : (Reflect.apply(ABORT_CONTROLLER_SIGNAL_GETTER, controller, []) as AbortSignal);
  let stopped: StopReason | undefined;
  let closed = false;
  let settleStop = (): void => undefined;
  const stopPromise = new Promise<"stopped">((resolve) => {
    settleStop = (): void => {
      resolve("stopped");
    };
  });
  const stop = (reason: StopReason): void => {
    if (stopped !== undefined) return;
    stopped = reason;
    Reflect.apply(ABORT_CONTROLLER_ABORT, controller, []);
    settleStop();
  };
  const onAbort = (): void => {
    stop("cancelled");
  };
  const stoppedReason = (): StopReason | undefined => stopped;
  if (options.signal !== undefined) {
    Reflect.apply(EVENT_TARGET_ADD, options.signal, ["abort", onAbort, { once: true }]);
    /* v8 ignore next -- closes the unavoidable check/listen race for a native signal. */
    if (nativeAbortState(options.signal) !== false) stop("cancelled");
  }

  let completedUnits = 0;
  let sequence = 0;
  const emit = (state: LibraryProgressState): void => {
    if (options.onProgress === undefined || stopped !== undefined || closed) return;
    let returned: unknown;
    try {
      returned = Reflect.apply(
        options.onProgress as (...arguments_: readonly unknown[]) => unknown,
        undefined,
        [progressRecord(completedUnits, request.progressUnits, sequence, state)],
      );
    } catch {
      stop("progress");
      return;
    }
    if (nodeTypes.isPromise(returned)) {
      void Reflect.apply(PROMISE_THEN, returned, [undefined, (): undefined => undefined]);
      stop("progress");
      return;
    }
    sequence += 1;
  };
  const reportProgress = (): void => {
    if (stopped !== undefined || closed) return;
    if (completedUnits >= request.progressUnits) {
      stop("resource");
      return;
    }
    completedUnits += 1;
    emit("running");
  };
  const context: LibraryScanExecutionContext = Object.freeze({
    reportProgress,
    signal: derivedSignal,
  });

  try {
    emit("started");
    const outcomeStop = stoppedReason();
    if (outcomeStop !== undefined) return fail(errorForStop(outcomeStop));
    let pending: unknown;
    try {
      pending = Reflect.apply(executor, undefined, [request, context]);
    } catch {
      return fail(LibraryApiErrorCode.engineFailed);
    }
    if (nodeTypes.isProxy(pending) || !nodeTypes.isPromise(pending)) {
      stop("resource");
      return fail(LibraryApiErrorCode.engineFailed);
    }
    const execution = Reflect.apply(PROMISE_THEN, pending, [
      (value: unknown): Readonly<{ readonly status: "fulfilled"; readonly value: unknown }> =>
        Object.freeze({ status: "fulfilled", value }),
      (): Readonly<{ readonly status: "rejected" }> => Object.freeze({ status: "rejected" }),
    ]) as Promise<
      | Readonly<{ readonly status: "fulfilled"; readonly value: unknown }>
      | Readonly<{ readonly status: "rejected" }>
    >;
    const first = await Promise.race([execution, stopPromise]);
    const outcome = first === "stopped" ? await execution : first;
    if (stopped !== undefined) return fail(errorForStop(stopped));
    if (outcome.status === "rejected") return fail(LibraryApiErrorCode.engineFailed);
    /* v8 ignore next -- the installed native listener records this race as `stopped` first. */
    if (options.signal !== undefined && nativeAbortState(options.signal) !== false)
      return fail(LibraryApiErrorCode.cancelled);
    if (completedUnits !== request.progressUnits) return fail(LibraryApiErrorCode.invalidResult);
    const result = closedRecord(
      outcome.value,
      EXECUTION_RESULT_KEYS,
      LibraryApiErrorCode.invalidResult,
    );
    const output = canonicalOutput(ownValue(result, "output"), ownValue(result, "sources"));
    emit("completed");
    const completionStop = stoppedReason();
    if (completionStop !== undefined) return fail(errorForStop(completionStop));
    return output;
  } finally {
    closed = true;
    Reflect.apply(ABORT_CONTROLLER_ABORT, controller, []);
    if (options.signal !== undefined)
      Reflect.apply(EVENT_TARGET_REMOVE, options.signal, ["abort", onAbort]);
  }
}
