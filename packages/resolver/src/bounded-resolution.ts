import { types as nodeTypes } from "node:util";

import {
  CONFIGURATION_PROFILE_IDS,
  isRepositoryRelativePath,
  type ClientProfileId,
  type RepositoryRelativePath,
} from "@agent-context/core";

import {
  isIssuedEffectiveContextResolution,
  type EffectiveContextResolution,
} from "./effective-context.js";

export const BOUNDED_RESOLUTION_CONTRACT_VERSION = "0.1.0" as const;
export const BOUNDED_RESOLUTION_RECORD_KIND =
  "agent-context-bounded-effective-context-resolution" as const;

export interface BoundedResolutionLimits {
  readonly maximumConcurrency: number;
  readonly maximumDurationMs: number;
  readonly maximumResultBytes: number;
  readonly maximumTaskIdBytes: number;
  readonly maximumTasks: number;
  readonly maximumTotalResultBytes: number;
}

export const BOUNDED_RESOLUTION_DEFAULT_LIMITS: Readonly<BoundedResolutionLimits> = Object.freeze({
  maximumConcurrency: 8,
  maximumDurationMs: 30_000,
  maximumResultBytes: 33_554_432,
  maximumTaskIdBytes: 512,
  maximumTasks: 65_536,
  maximumTotalResultBytes: 134_217_728,
});

export const BOUNDED_RESOLUTION_HARD_LIMITS: Readonly<BoundedResolutionLimits> = Object.freeze({
  maximumConcurrency: 64,
  maximumDurationMs: 300_000,
  maximumResultBytes: 268_435_456,
  maximumTaskIdBytes: 16_384,
  maximumTasks: 1_000_000,
  maximumTotalResultBytes: 1_073_741_824,
});

export interface EffectiveContextResolutionTaskDescriptor {
  readonly clientVersion: string | null;
  readonly id: string;
  readonly profileId: ClientProfileId;
  readonly profileVersion: string;
  readonly specSnapshotId: string;
  readonly surfaceId: string;
  readonly targetPath: RepositoryRelativePath;
}

export type EffectiveContextResolutionTask = EffectiveContextResolutionTaskDescriptor;

export type EffectiveContextResolutionExecutor = (
  signal: AbortSignal,
) => EffectiveContextResolution | Promise<EffectiveContextResolution>;

export interface BoundedResolutionOptions extends Partial<BoundedResolutionLimits> {
  readonly signal?: AbortSignal | undefined;
}

export interface BoundedResolutionEntry {
  readonly resolution: EffectiveContextResolution;
  readonly taskId: string;
}

export interface BoundedResolutionResult {
  readonly contractVersion: typeof BOUNDED_RESOLUTION_CONTRACT_VERSION;
  readonly entries: readonly BoundedResolutionEntry[];
  readonly recordKind: typeof BOUNDED_RESOLUTION_RECORD_KIND;
}

export const BoundedResolutionErrorCode: Readonly<{
  cancelled: "BOUNDED_RESOLUTION_CANCELLED";
  deadlineExceeded: "BOUNDED_RESOLUTION_DEADLINE_EXCEEDED";
  invalidInput: "BOUNDED_RESOLUTION_INVALID_INPUT";
  invalidOptions: "BOUNDED_RESOLUTION_INVALID_OPTIONS";
  invalidRelationship: "BOUNDED_RESOLUTION_INVALID_RELATIONSHIP";
  resourceLimit: "BOUNDED_RESOLUTION_RESOURCE_LIMIT";
  taskFailed: "BOUNDED_RESOLUTION_TASK_FAILED";
}> = Object.freeze({
  cancelled: "BOUNDED_RESOLUTION_CANCELLED",
  deadlineExceeded: "BOUNDED_RESOLUTION_DEADLINE_EXCEEDED",
  invalidInput: "BOUNDED_RESOLUTION_INVALID_INPUT",
  invalidOptions: "BOUNDED_RESOLUTION_INVALID_OPTIONS",
  invalidRelationship: "BOUNDED_RESOLUTION_INVALID_RELATIONSHIP",
  resourceLimit: "BOUNDED_RESOLUTION_RESOURCE_LIMIT",
  taskFailed: "BOUNDED_RESOLUTION_TASK_FAILED",
});

export type BoundedResolutionErrorCode =
  (typeof BoundedResolutionErrorCode)[keyof typeof BoundedResolutionErrorCode];

export class BoundedResolutionError extends Error {
  readonly code: BoundedResolutionErrorCode;
  readonly failedTaskIndexes: readonly number[];
  override readonly name = "BoundedResolutionError" as const;

  constructor(
    code: BoundedResolutionErrorCode,
    message: string,
    failedTaskIndexes: readonly number[] = [],
  ) {
    super(message);
    this.code = code;
    this.failedTaskIndexes = Object.freeze([...failedTaskIndexes]);
    Object.freeze(this);
  }
}

type DataRecord = Readonly<Record<string, unknown>>;
type TaskFailure = "execution" | "invalid-result";

const DESCRIPTOR_KEYS = new Set([
  "clientVersion",
  "id",
  "profileId",
  "profileVersion",
  "specSnapshotId",
  "surfaceId",
  "targetPath",
]);
const LIMIT_KEYS = new Set(Object.keys(BOUNDED_RESOLUTION_DEFAULT_LIMITS));
const OPTION_KEYS = new Set([...LIMIT_KEYS, "signal"]);
const PROFILE_IDS = new Set<string>(CONFIGURATION_PROFILE_IDS);
const ISSUED_TASKS = new WeakSet<object>();
const TASK_EXECUTORS = new WeakMap<object, EffectiveContextResolutionExecutor>();
const ISSUED_RESULTS = new WeakSet<object>();
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const EVENT_TARGET_ADD = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked only with Reflect.apply.
const EVENT_TARGET_REMOVE = EventTarget.prototype.removeEventListener;

function fail(
  code: BoundedResolutionErrorCode,
  message: string,
  failedTaskIndexes: readonly number[] = [],
): never {
  throw new BoundedResolutionError(code, message, failedTaskIndexes);
}

function dataRecord(
  value: unknown,
  label: string,
  code: BoundedResolutionErrorCode = BoundedResolutionErrorCode.invalidInput,
): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return fail(code, `${label} must be a non-proxy data record`);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return fail(code, `${label} must be a plain data record`);
  return value as DataRecord;
}

function field(
  record: DataRecord,
  key: string,
  label: string,
  code: BoundedResolutionErrorCode,
): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
    return fail(code, `${label} must contain enumerable data fields`);
  return descriptor.value;
}

function closedRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
  code: BoundedResolutionErrorCode = BoundedResolutionErrorCode.invalidInput,
): DataRecord {
  const record = dataRecord(value, label, code);
  const actual = Reflect.ownKeys(record);
  if (
    actual.length !== keys.size ||
    actual.some((key) => typeof key !== "string" || !keys.has(key))
  )
    return fail(code, `${label} has unknown or missing fields`);
  for (const key of actual) field(record, key as string, label, code);
  return record;
}

function denseArray(value: unknown, maximum: number): readonly unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  )
    return fail(
      BoundedResolutionErrorCode.invalidInput,
      "resolution tasks must be a regular array",
    );
  if (value.length > maximum)
    return fail(
      BoundedResolutionErrorCode.resourceLimit,
      "resolution task count exceeds its limit",
    );
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return fail(
      BoundedResolutionErrorCode.invalidInput,
      "resolution tasks must be dense and unextended",
    );
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(
        BoundedResolutionErrorCode.invalidInput,
        "resolution tasks must contain enumerable data entries",
      );
    output.push(descriptor.value);
  }
  return output;
}

function wellFormedText(value: unknown, maximumBytes: number, label: string): string {
  if (typeof value !== "string")
    return fail(BoundedResolutionErrorCode.invalidInput, `${label} must be text`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff)
        return fail(BoundedResolutionErrorCode.invalidInput, `${label} is not well-formed text`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      return fail(BoundedResolutionErrorCode.invalidInput, `${label} is not well-formed text`);
    else if (
      unit <= 0x1f ||
      (unit >= 0x7f && unit <= 0x9f) ||
      unit === 0x061c ||
      unit === 0x200e ||
      unit === 0x200f ||
      (unit >= 0x202a && unit <= 0x202e) ||
      (unit >= 0x2066 && unit <= 0x2069)
    )
      return fail(BoundedResolutionErrorCode.invalidInput, `${label} contains control characters`);
  }
  if (value === "")
    return fail(BoundedResolutionErrorCode.invalidInput, `${label} must not be empty`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes)
    return fail(BoundedResolutionErrorCode.resourceLimit, `${label} exceeds its byte limit`);
  return value;
}

function abortState(value: unknown): boolean | undefined {
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
  readonly limits: Readonly<BoundedResolutionLimits>;
  readonly signal: AbortSignal | undefined;
} {
  if (value === undefined) return { limits: BOUNDED_RESOLUTION_DEFAULT_LIMITS, signal: undefined };
  const record = dataRecord(
    value,
    "bounded-resolution options",
    BoundedResolutionErrorCode.invalidOptions,
  );
  const actual = Reflect.ownKeys(record);
  if (actual.some((key) => typeof key !== "string" || !OPTION_KEYS.has(key)))
    return fail(
      BoundedResolutionErrorCode.invalidOptions,
      "bounded-resolution options have invalid fields",
    );
  const selected = { ...BOUNDED_RESOLUTION_DEFAULT_LIMITS };
  for (const key of actual) {
    if (key === "signal") continue;
    const limitKey = key as keyof BoundedResolutionLimits;
    const limit = field(
      record,
      limitKey,
      "bounded-resolution options",
      BoundedResolutionErrorCode.invalidOptions,
    );
    if (
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > BOUNDED_RESOLUTION_HARD_LIMITS[limitKey]
    )
      return fail(
        BoundedResolutionErrorCode.invalidOptions,
        "bounded-resolution limits must be positive integers within hard ceilings",
      );
    selected[limitKey] = limit as number;
  }
  if (selected.maximumResultBytes > selected.maximumTotalResultBytes)
    return fail(
      BoundedResolutionErrorCode.invalidOptions,
      "maximumResultBytes must not exceed maximumTotalResultBytes",
    );
  let signal: AbortSignal | undefined;
  if (actual.includes("signal")) {
    const candidate = field(
      record,
      "signal",
      "bounded-resolution options",
      BoundedResolutionErrorCode.invalidOptions,
    );
    if (candidate !== undefined) {
      if (abortState(candidate) === undefined)
        return fail(
          BoundedResolutionErrorCode.invalidOptions,
          "bounded-resolution signal must be a native AbortSignal",
        );
      signal = candidate as AbortSignal;
    }
  }
  return { limits: Object.freeze(selected), signal };
}

function normalizeDescriptor(
  value: unknown,
  maximumTaskIdBytes: number,
): EffectiveContextResolutionTaskDescriptor {
  const record = closedRecord(value, DESCRIPTOR_KEYS, "resolution task descriptor");
  const rawClientVersion = field(
    record,
    "clientVersion",
    "resolution task descriptor",
    BoundedResolutionErrorCode.invalidInput,
  );
  const clientVersion =
    rawClientVersion === null
      ? null
      : wellFormedText(
          rawClientVersion,
          BOUNDED_RESOLUTION_HARD_LIMITS.maximumTaskIdBytes,
          "resolution task client version",
        );
  const id = wellFormedText(
    field(record, "id", "resolution task descriptor", BoundedResolutionErrorCode.invalidInput),
    maximumTaskIdBytes,
    "resolution task id",
  );
  const profileId = field(
    record,
    "profileId",
    "resolution task descriptor",
    BoundedResolutionErrorCode.invalidInput,
  );
  if (typeof profileId !== "string" || !PROFILE_IDS.has(profileId))
    return fail(BoundedResolutionErrorCode.invalidInput, "resolution task profile is invalid");
  const profileVersion = wellFormedText(
    field(
      record,
      "profileVersion",
      "resolution task descriptor",
      BoundedResolutionErrorCode.invalidInput,
    ),
    BOUNDED_RESOLUTION_HARD_LIMITS.maximumTaskIdBytes,
    "resolution task profile version",
  );
  const specSnapshotId = wellFormedText(
    field(
      record,
      "specSnapshotId",
      "resolution task descriptor",
      BoundedResolutionErrorCode.invalidInput,
    ),
    BOUNDED_RESOLUTION_HARD_LIMITS.maximumTaskIdBytes,
    "resolution task specification snapshot",
  );
  const surfaceId = wellFormedText(
    field(
      record,
      "surfaceId",
      "resolution task descriptor",
      BoundedResolutionErrorCode.invalidInput,
    ),
    BOUNDED_RESOLUTION_HARD_LIMITS.maximumTaskIdBytes,
    "resolution task surface",
  );
  const targetPath = field(
    record,
    "targetPath",
    "resolution task descriptor",
    BoundedResolutionErrorCode.invalidInput,
  );
  if (typeof targetPath !== "string" || !isRepositoryRelativePath(targetPath))
    return fail(BoundedResolutionErrorCode.invalidInput, "resolution task target is invalid");
  return Object.freeze({
    clientVersion,
    id,
    profileId,
    profileVersion,
    specSnapshotId,
    surfaceId,
    targetPath,
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareTasks(
  left: EffectiveContextResolutionTask,
  right: EffectiveContextResolutionTask,
): number {
  return (
    compareUtf8(left.profileId, right.profileId) ||
    compareUtf8(left.surfaceId, right.surfaceId) ||
    compareUtf8(left.profileVersion, right.profileVersion) ||
    compareUtf8(left.specSnapshotId, right.specSnapshotId) ||
    compareUtf8(left.clientVersion ?? "", right.clientVersion ?? "") ||
    compareUtf8(left.targetPath, right.targetPath) ||
    compareUtf8(left.id, right.id)
  );
}

function taskRelationshipKey(task: EffectiveContextResolutionTask): string {
  return JSON.stringify([
    task.profileId,
    task.surfaceId,
    task.profileVersion,
    task.specSnapshotId,
    task.clientVersion,
    task.targetPath,
  ]);
}

function normalizeTasks(
  value: unknown,
  limits: BoundedResolutionLimits,
): readonly EffectiveContextResolutionTask[] {
  const raw = denseArray(value, limits.maximumTasks);
  const ids = new Set<string>();
  const relationships = new Set<string>();
  const tasks = raw.map((task) => {
    if (
      task === null ||
      typeof task !== "object" ||
      !ISSUED_TASKS.has(task) ||
      !Object.isFrozen(task)
    )
      return fail(
        BoundedResolutionErrorCode.invalidInput,
        "resolution task was not issued by the E10 task factory",
      );
    const normalized = normalizeDescriptor(task, limits.maximumTaskIdBytes);
    if (ids.has(normalized.id))
      return fail(
        BoundedResolutionErrorCode.invalidRelationship,
        "resolution task ids must be unique",
      );
    ids.add(normalized.id);
    const relationship = taskRelationshipKey(normalized);
    if (relationships.has(relationship))
      return fail(
        BoundedResolutionErrorCode.invalidRelationship,
        "profile, version, surface, specification, and target task relationships must be unique",
      );
    relationships.add(relationship);
    return task as EffectiveContextResolutionTask;
  });
  return Object.freeze(tasks.sort(compareTasks));
}

function taskMatchesResult(
  task: EffectiveContextResolutionTask,
  result: EffectiveContextResolution,
): boolean {
  return (
    result.profileId === task.profileId &&
    result.profileVersion === task.profileVersion &&
    result.clientVersion === task.clientVersion &&
    result.specSnapshotId === task.specSnapshotId &&
    result.surfaceId === task.surfaceId &&
    result.targetPath === task.targetPath
  );
}

/**
 * Mint one internal work item. The executor is an explicit trusted application capability and must
 * never originate in repository/configuration/standards data or an untrusted plug-in.
 */
export function createEffectiveContextResolutionTask(
  descriptor: unknown,
  executor: EffectiveContextResolutionExecutor,
): EffectiveContextResolutionTask {
  const normalized = normalizeDescriptor(
    descriptor,
    BOUNDED_RESOLUTION_HARD_LIMITS.maximumTaskIdBytes,
  );
  if (typeof executor !== "function" || nodeTypes.isProxy(executor))
    return fail(
      BoundedResolutionErrorCode.invalidInput,
      "resolution task executor must be a direct trusted function",
    );
  const task = Object.freeze({ ...normalized });
  ISSUED_TASKS.add(task);
  TASK_EXECUTORS.set(task, executor);
  return task;
}

/** True only for an immutable batch issued by this process's E10 scheduler. */
export function isIssuedBoundedResolutionResult(value: unknown): value is BoundedResolutionResult {
  return typeof value === "object" && value !== null && ISSUED_RESULTS.has(value);
}

/**
 * Resolve a bounded task set with lazy queue admission. Completion timing never controls output
 * ordering, and scheduling options are deliberately absent from the result contract.
 */
export async function resolveEffectiveContextsBounded(
  value: unknown,
  options?: BoundedResolutionOptions,
): Promise<BoundedResolutionResult> {
  const normalizedOptions = normalizeOptions(options);
  const { limits, signal } = normalizedOptions;
  if (signal !== undefined && abortState(signal) !== false)
    return fail(BoundedResolutionErrorCode.cancelled, "bounded resolution was cancelled");
  const tasks = normalizeTasks(value, limits);
  if (tasks.length === 0) {
    const entries: readonly BoundedResolutionEntry[] = Object.freeze([]);
    const result = Object.freeze({
      contractVersion: BOUNDED_RESOLUTION_CONTRACT_VERSION,
      entries,
      recordKind: BOUNDED_RESOLUTION_RECORD_KIND,
    });
    ISSUED_RESULTS.add(result);
    return result;
  }

  const controller = new AbortController();
  let stopped: "cancelled" | "deadline" | "resource" | undefined;
  let stopRace: (() => void) | undefined;
  const stopPromise = new Promise<"stopped">((resolve) => {
    stopRace = (): void => {
      resolve("stopped");
    };
  });
  const stop = (reason: "cancelled" | "deadline" | "resource"): void => {
    if (stopped !== undefined) return;
    stopped = reason;
    controller.abort();
    stopRace?.();
  };
  const onAbort = (): void => {
    stop("cancelled");
  };
  if (signal !== undefined) {
    Reflect.apply(EVENT_TARGET_ADD, signal, ["abort", onAbort, { once: true }]);
    if (abortState(signal) !== false) stop("cancelled");
  }
  const timer = setTimeout(() => {
    stop("deadline");
  }, limits.maximumDurationMs);

  const resolutions = Array.from(
    { length: tasks.length },
    (): EffectiveContextResolution | undefined => undefined,
  );
  const failures = Array.from({ length: tasks.length }, (): TaskFailure | undefined => undefined);
  let nextIndex = 0;
  let retainedResultBytes = 0;
  const worker = async (): Promise<void> => {
    while (stopped === undefined) {
      const index = nextIndex;
      if (index >= tasks.length) return;
      nextIndex += 1;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index was checked against task length.
      const task = tasks[index]!;
      const executor = TASK_EXECUTORS.get(task);
      /* v8 ignore next -- the issuance set and executor map are populated atomically */
      if (executor === undefined) {
        failures[index] = "invalid-result";
        continue;
      }
      let resolution: unknown;
      try {
        resolution = await Reflect.apply(executor, undefined, [controller.signal]);
      } catch {
        failures[index] = "execution";
        continue;
      }
      if (!isIssuedEffectiveContextResolution(resolution) || !taskMatchesResult(task, resolution)) {
        failures[index] = "invalid-result";
        continue;
      }
      const bytes = Buffer.byteLength(JSON.stringify(resolution), "utf8");
      if (
        bytes > limits.maximumResultBytes ||
        retainedResultBytes + bytes > limits.maximumTotalResultBytes
      ) {
        stop("resource");
        return;
      }
      retainedResultBytes += bytes;
      resolutions[index] = resolution;
    }
  };

  try {
    const workerCount = Math.min(limits.maximumConcurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    const completion = Promise.all(workers).then(() => "complete" as const);
    const outcome = await Promise.race([completion, stopPromise]);
    if (outcome === "stopped" || stopped !== undefined) {
      if (stopped === "deadline")
        return fail(
          BoundedResolutionErrorCode.deadlineExceeded,
          "bounded resolution exceeded its deadline",
        );
      if (stopped === "resource")
        return fail(
          BoundedResolutionErrorCode.resourceLimit,
          "bounded resolution results exceed configured byte limits",
        );
      return fail(BoundedResolutionErrorCode.cancelled, "bounded resolution was cancelled");
    }
    if (signal !== undefined && abortState(signal) !== false)
      return fail(BoundedResolutionErrorCode.cancelled, "bounded resolution was cancelled");

    const invalidIndexes: number[] = [];
    const failedIndexes: number[] = [];
    for (let index = 0; index < failures.length; index += 1) {
      if (failures[index] === "invalid-result") invalidIndexes.push(index);
      else if (failures[index] === "execution") failedIndexes.push(index);
    }
    if (invalidIndexes.length > 0)
      return fail(
        BoundedResolutionErrorCode.invalidRelationship,
        "resolution tasks returned results for invalid profile, version, surface, specification, or target relationships",
        invalidIndexes,
      );
    if (failedIndexes.length > 0)
      return fail(
        BoundedResolutionErrorCode.taskFailed,
        "one or more bounded resolution tasks failed",
        failedIndexes,
      );

    const entries = tasks.map((task, index): BoundedResolutionEntry => {
      const resolution = resolutions[index];
      /* v8 ignore next -- failure accounting covers every missing issued result */
      if (resolution === undefined)
        return fail(
          BoundedResolutionErrorCode.invalidRelationship,
          "bounded resolution lost a completed task result",
          [index],
        );
      return Object.freeze({ resolution, taskId: task.id });
    });
    const result = Object.freeze({
      contractVersion: BOUNDED_RESOLUTION_CONTRACT_VERSION,
      entries: Object.freeze(entries),
      recordKind: BOUNDED_RESOLUTION_RECORD_KIND,
    });
    ISSUED_RESULTS.add(result);
    return result;
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) Reflect.apply(EVENT_TARGET_REMOVE, signal, ["abort", onAbort]);
  }
}
