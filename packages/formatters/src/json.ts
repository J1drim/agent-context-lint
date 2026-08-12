import { types as nodeTypes } from "node:util";

import {
  JSON_OUTPUT_SCHEMA_VERSION,
  MAX_DIAGNOSTICS_PER_BUNDLE,
  MAX_OUTPUT_KEY_BYTES,
  MAX_OUTPUT_TEXT_BYTES,
  MAX_OUTPUT_TEXT_CODE_POINTS,
  MAX_OUTPUT_TOTAL_STRING_BYTES,
  serializeNativeOutput,
  validateDiagnosticBundle,
  validateScanJsonOutput,
} from "@agent-context/core";

import type {
  Diagnostic,
  DiagnosticBundle,
  OutputSummary,
  ProfileVersionIdentity,
  ScanJsonOutput,
  SourceDocument,
} from "@agent-context/core";

export const JSON_FORMATTER_DEFAULT_CHUNK_BYTES = 16_384 as const;
export const JSON_FORMATTER_MIN_CHUNK_BYTES = 256 as const;
export const JSON_FORMATTER_MAX_CHUNK_BYTES = 1_048_576 as const;
export const JSON_FORMATTER_MAX_OUTPUT_BYTES: number = MAX_OUTPUT_TOTAL_STRING_BYTES;
export const JSON_FORMATTER_MAX_PROFILE_VERSIONS: number = MAX_DIAGNOSTICS_PER_BUNDLE;

const OPTION_KEYS = new Set(["chunkBytes", "failureThreshold", "profileVersions"]);
const IDENTITY_KEYS = new Set(["clientVersion", "profileVersion"]);
const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

const ABORT_SIGNAL_ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
);
type EventTargetIntrinsic = (...arguments_: readonly unknown[]) => unknown;
const EVENT_TARGET_ADD_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "addEventListener",
)?.value as EventTargetIntrinsic;
const EVENT_TARGET_REMOVE_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "removeEventListener",
)?.value as EventTargetIntrinsic;

export type JsonFormatterFailureThreshold = "error" | "never" | "warning";

export interface JsonFormatterOptions {
  /** Maximum UTF-8 bytes per deterministic sink chunk. */
  readonly chunkBytes?: number;
  readonly failureThreshold?: JsonFormatterFailureThreshold;
  /** Exact B05 profile identity map for the selected scan profiles. */
  readonly profileVersions: Readonly<Record<string, ProfileVersionIdentity>>;
}

export interface JsonFormatterIssue {
  readonly code:
    | "interrupted"
    | "invalid-diagnostics"
    | "invalid-options"
    | "invalid-sink"
    | "resource-limit"
    | "serialization-failed"
    | "sink-failed";
  readonly path: string;
  readonly message: string;
}

export type JsonFormatterResult =
  | {
      readonly ok: true;
      readonly byteLength: number;
      /** Scalar-safe deterministic chunks whose concatenation is exactly `text`. */
      readonly chunks: readonly string[];
      /** Deeply frozen sanitized B05 model represented by `text`. */
      readonly output: ScanJsonOutput;
      /** Compact canonical JSON encoded as UTF-8 and terminated by exactly one LF. */
      readonly text: string;
    }
  | { readonly ok: false; readonly issues: readonly JsonFormatterIssue[] };

export interface JsonChunkSink {
  /** A fulfilled promise acknowledges backpressure for this chunk. */
  readonly write: (chunk: string) => PromiseLike<void> | void;
}

export type JsonFormatterWriteResult =
  | {
      readonly ok: true;
      readonly byteLength: number;
      readonly chunksWritten: number;
      readonly output: ScanJsonOutput;
    }
  | {
      readonly ok: false;
      readonly byteLength: number;
      readonly chunksWritten: number;
      readonly issues: readonly JsonFormatterIssue[];
    };

interface ResolvedOptions {
  readonly chunkBytes: number;
  readonly failureThreshold: JsonFormatterFailureThreshold;
  readonly profileVersions: Readonly<Record<string, ProfileVersionIdentity>>;
}

interface ValidSink {
  readonly receiver: JsonChunkSink;
  readonly write: JsonChunkSink["write"];
}

type ChunkWriteOutcome = "interrupted" | "sink-failed" | "written";

function issue(
  code: JsonFormatterIssue["code"],
  path: string,
  message: string,
): JsonFormatterIssue {
  return Object.freeze({ code, path, message });
}

function failure(value: JsonFormatterIssue): JsonFormatterResult {
  return Object.freeze({ ok: false, issues: Object.freeze([value]) });
}

function writeFailure(
  value: JsonFormatterIssue,
  chunksWritten: number,
  byteLength: number,
): JsonFormatterWriteResult {
  return Object.freeze({
    ok: false,
    byteLength,
    chunksWritten,
    issues: Object.freeze([value]),
  });
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function isBoundedOutputText(value: string): boolean {
  return (
    value.length > 0 &&
    isWellFormedUnicode(value) &&
    Array.from(value).length <= MAX_OUTPUT_TEXT_CODE_POINTS &&
    Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_TEXT_BYTES
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function dataProperties(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  maximumKeys: number,
):
  | { readonly ok: true; readonly values: ReadonlyMap<string, unknown> }
  | { readonly ok: false; readonly reason: "accessor" | "symbol" | "too-many" | "unknown" } {
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumKeys) return { ok: false, reason: "too-many" };
  const values = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") return { ok: false, reason: "symbol" };
    if (!allowed.has(key)) return { ok: false, reason: "unknown" };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return { ok: false, reason: "accessor" };
    }
    values.set(key, descriptor.value as unknown);
  }
  return { ok: true, values };
}

function optionShapeIssue(
  path: string,
  reason: "accessor" | "symbol" | "too-many" | "unknown",
): JsonFormatterIssue {
  const messages = {
    accessor: "accessor properties are not allowed",
    symbol: "symbol properties are not allowed",
    "too-many": "contains too many fields",
    unknown: "contains an unknown field",
  } as const;
  return issue("invalid-options", path, messages[reason]);
}

function validateProfileVersions(input: unknown):
  | {
      readonly ok: true;
      readonly value: Readonly<Record<string, ProfileVersionIdentity>>;
    }
  | { readonly ok: false; readonly issue: JsonFormatterIssue } {
  if (!plainRecord(input)) {
    return {
      ok: false,
      issue: issue("invalid-options", "$options.profileVersions", "must be a plain data object"),
    };
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length === 0 || keys.length > JSON_FORMATTER_MAX_PROFILE_VERSIONS) {
    return {
      ok: false,
      issue: issue(
        keys.length === 0 ? "invalid-options" : "resource-limit",
        "$options.profileVersions",
        keys.length === 0
          ? "must identify at least one profile"
          : "contains too many profile identities",
      ),
    };
  }
  const entries: [string, ProfileVersionIdentity][] = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      return {
        ok: false,
        issue: issue(
          "invalid-options",
          "$options.profileVersions",
          "symbol properties are not allowed",
        ),
      };
    }
    if (!IDENTIFIER.test(key) || Buffer.byteLength(key, "utf8") > MAX_OUTPUT_KEY_BYTES) {
      return {
        ok: false,
        issue: issue(
          "invalid-options",
          "$options.profileVersions",
          "profile names must be bounded identifiers",
        ),
      };
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor) || !plainRecord(descriptor.value)) {
      return {
        ok: false,
        issue: issue(
          "invalid-options",
          "$options.profileVersions",
          "profile identities must be plain data objects",
        ),
      };
    }
    const identityProperties = dataProperties(descriptor.value, IDENTITY_KEYS, IDENTITY_KEYS.size);
    if (!identityProperties.ok) {
      return {
        ok: false,
        issue: optionShapeIssue("$options.profileVersions", identityProperties.reason),
      };
    }
    const profileVersion = identityProperties.values.get("profileVersion");
    const clientVersion = identityProperties.values.get("clientVersion");
    if (
      identityProperties.values.size !== IDENTITY_KEYS.size ||
      typeof profileVersion !== "string" ||
      !VERSION.test(profileVersion) ||
      !isBoundedOutputText(profileVersion) ||
      (clientVersion !== null &&
        (typeof clientVersion !== "string" || !isBoundedOutputText(clientVersion)))
    ) {
      return {
        ok: false,
        issue: issue(
          "invalid-options",
          "$options.profileVersions",
          "each identity requires a semantic profileVersion and a bounded clientVersion or null",
        ),
      };
    }
    entries.push([key, Object.freeze({ clientVersion, profileVersion })]);
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return { ok: true, value: Object.freeze(Object.fromEntries(entries)) };
}

function validateOptions(
  input: unknown,
):
  | { readonly ok: true; readonly value: ResolvedOptions }
  | { readonly ok: false; readonly issue: JsonFormatterIssue } {
  try {
    if (!plainRecord(input)) {
      return {
        ok: false,
        issue: issue("invalid-options", "$options", "must be a plain data object"),
      };
    }
    const properties = dataProperties(input, OPTION_KEYS, OPTION_KEYS.size);
    if (!properties.ok)
      return { ok: false, issue: optionShapeIssue("$options", properties.reason) };
    if (!properties.values.has("profileVersions")) {
      return {
        ok: false,
        issue: issue("invalid-options", "$options.profileVersions", "is required"),
      };
    }
    const profileVersions = validateProfileVersions(properties.values.get("profileVersions"));
    if (!profileVersions.ok) return profileVersions;
    const failureThreshold = properties.values.has("failureThreshold")
      ? properties.values.get("failureThreshold")
      : "error";
    if (
      failureThreshold !== "error" &&
      failureThreshold !== "warning" &&
      failureThreshold !== "never"
    ) {
      return {
        ok: false,
        issue: issue(
          "invalid-options",
          "$options.failureThreshold",
          "must be 'error', 'warning', or 'never'",
        ),
      };
    }
    const chunkBytes = properties.values.has("chunkBytes")
      ? properties.values.get("chunkBytes")
      : JSON_FORMATTER_DEFAULT_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(chunkBytes) ||
      (chunkBytes as number) < JSON_FORMATTER_MIN_CHUNK_BYTES ||
      (chunkBytes as number) > JSON_FORMATTER_MAX_CHUNK_BYTES
    ) {
      return {
        ok: false,
        issue: issue(
          "invalid-options",
          "$options.chunkBytes",
          `must be an integer from ${String(JSON_FORMATTER_MIN_CHUNK_BYTES)} through ${String(JSON_FORMATTER_MAX_CHUNK_BYTES)}`,
        ),
      };
    }
    return {
      ok: true,
      value: Object.freeze({
        chunkBytes: chunkBytes as number,
        failureThreshold,
        profileVersions: profileVersions.value,
      }),
    };
  } catch {
    return {
      ok: false,
      issue: issue("invalid-options", "$options", "must be safely inspectable data"),
    };
  }
}

function activeDiagnostics(bundle: DiagnosticBundle): {
  readonly active: readonly Diagnostic[];
  readonly suppressed: number;
} {
  const suppressed = new Set(
    bundle.suppressions
      .filter((suppression) => suppression.state === "suppressed")
      .flatMap((suppression) => suppression.matchedPathFingerprints),
  );
  return {
    active: bundle.diagnostics.filter(
      (diagnostic) => !suppressed.has(diagnostic.fingerprints.path.value),
    ),
    suppressed: suppressed.size,
  };
}

function outputSummary(
  diagnostics: readonly Diagnostic[],
  suppressed: number,
  failureThreshold: JsonFormatterFailureThreshold,
): OutputSummary {
  let errors = 0;
  let infos = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") errors += 1;
    else if (diagnostic.severity === "warning") warnings += 1;
    else infos += 1;
  }
  const failed =
    failureThreshold === "warning"
      ? errors + warnings > 0
      : failureThreshold === "error"
        ? errors > 0
        : false;
  return Object.freeze({ errors, exitCode: failed ? 1 : 0, infos, suppressed, warnings });
}

function utf8Chunks(value: string, maximumBytes: number): readonly string[] {
  const chunks: string[] = [];
  let chunkBytes = 0;
  let chunkStart = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    // The serialized document is already well-formed Unicode. Compute scalar width directly so
    // chunking remains allocation-free and linear even at the 64 MiB output ceiling.
    const scalarBytes =
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (chunkBytes > 0 && chunkBytes + scalarBytes > maximumBytes) {
      chunks.push(value.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += scalarBytes;
    index += codeUnits;
  }
  if (chunkStart < value.length) chunks.push(value.slice(chunkStart));
  return Object.freeze(chunks);
}

function deepFreeze<T>(value: T): T {
  const root: unknown = value;
  if (root === null || typeof root !== "object") return value;
  const pending: object[] = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const nested: unknown = descriptor.value;
      if (nested !== null && typeof nested === "object") pending.push(nested);
    }
    Object.freeze(current);
  }
  return value;
}

/**
 * Produce the complete native scan JSON document before any external write. Validated diagnostic
 * array order is preserved; scheduling, deduplication, severity policy, and sorting belong to F15.
 */
export function formatJsonDiagnostics(
  input: unknown,
  sources: readonly SourceDocument[],
  options: JsonFormatterOptions,
): JsonFormatterResult {
  const resolvedOptions = validateOptions(options);
  if (!resolvedOptions.ok) return failure(resolvedOptions.issue);
  try {
    const diagnostics = validateDiagnosticBundle(input, sources);
    if (!diagnostics.ok) {
      const exhausted = diagnostics.issues.some((candidate) => candidate.code === "resource-limit");
      return failure(
        issue(
          exhausted ? "resource-limit" : "invalid-diagnostics",
          "$",
          exhausted
            ? "diagnostic bundle or source registry exceeds a B04 resource limit"
            : "diagnostic bundle or source registry failed B04 validation",
        ),
      );
    }
    const selected = activeDiagnostics(diagnostics.value);
    const summary = outputSummary(
      selected.active,
      selected.suppressed,
      resolvedOptions.value.failureThreshold,
    );
    const candidate: ScanJsonOutput = {
      recordKind: "agent-context-scan-output",
      schemaVersion: JSON_OUTPUT_SCHEMA_VERSION,
      profileVersions: resolvedOptions.value.profileVersions,
      failureThreshold: resolvedOptions.value.failureThreshold,
      diagnostics: diagnostics.value,
      summary,
    };
    const contract = validateScanJsonOutput(candidate, sources);
    if (!contract.ok) {
      const profileMismatch = contract.issues.some(
        (contractIssue) => contractIssue.path === "$.profileVersions",
      );
      return failure(
        issue(
          profileMismatch ? "invalid-options" : "serialization-failed",
          profileMismatch ? "$options.profileVersions" : "$",
          profileMismatch
            ? "must exactly identify profiles used by diagnostic fingerprints"
            : "constructed scan output failed B05 validation",
        ),
      );
    }
    const serialized = serializeNativeOutput(contract.value, sources);
    if (!serialized.ok) {
      return failure(
        issue(
          "serialization-failed",
          "$",
          "safe redaction could not preserve the B05 output contract",
        ),
      );
    }
    const byteLength = Buffer.byteLength(serialized.text, "utf8");
    if (byteLength > JSON_FORMATTER_MAX_OUTPUT_BYTES) {
      return failure(
        issue("resource-limit", "$", "serialized JSON exceeds the formatter byte limit"),
      );
    }
    const parsed = JSON.parse(serialized.text) as unknown;
    const emittedContract = validateScanJsonOutput(parsed, sources);
    if (!emittedContract.ok) {
      return failure(issue("serialization-failed", "$", "serialized JSON failed B05 validation"));
    }
    const output = deepFreeze(emittedContract.value);
    const chunks = utf8Chunks(serialized.text, resolvedOptions.value.chunkBytes);
    return Object.freeze({ ok: true, byteLength, chunks, output, text: serialized.text });
  } catch {
    return failure(
      issue("invalid-diagnostics", "$", "diagnostics must be safely inspectable data"),
    );
  }
}

function validateSink(
  input: unknown,
):
  | { readonly ok: true; readonly value: ValidSink }
  | { readonly ok: false; readonly issue: JsonFormatterIssue } {
  try {
    if (!plainRecord(input)) {
      return {
        ok: false,
        issue: issue("invalid-sink", "$sink", "must be a plain data object"),
      };
    }
    const properties = dataProperties(input, new Set(["write"]), 1);
    const write = properties.ok ? properties.values.get("write") : undefined;
    if (
      !properties.ok ||
      properties.values.size !== 1 ||
      typeof write !== "function" ||
      nodeTypes.isProxy(write)
    ) {
      return {
        ok: false,
        issue: issue("invalid-sink", "$sink", "must contain exactly one callable data property"),
      };
    }
    return {
      ok: true,
      value: {
        receiver: input as unknown as JsonChunkSink,
        write: write as JsonChunkSink["write"],
      },
    };
  } catch {
    return {
      ok: false,
      issue: issue("invalid-sink", "$sink", "must be safely inspectable data"),
    };
  }
}

function validateSignal(input: unknown): input is AbortSignal | undefined {
  if (input === undefined) return true;
  if (
    input === null ||
    typeof input !== "object" ||
    nodeTypes.isProxy(input) ||
    ABORT_SIGNAL_ABORTED_DESCRIPTOR?.get === undefined ||
    typeof EVENT_TARGET_ADD_EVENT_LISTENER !== "function" ||
    typeof EVENT_TARGET_REMOVE_EVENT_LISTENER !== "function"
  )
    return false;
  try {
    const state: unknown = ABORT_SIGNAL_ABORTED_DESCRIPTOR.get.call(input);
    return typeof state === "boolean";
  } catch {
    return false;
  }
}

function isAborted(signal: AbortSignal): boolean {
  if (ABORT_SIGNAL_ABORTED_DESCRIPTOR?.get === undefined) return true;
  try {
    const state: unknown = ABORT_SIGNAL_ABORTED_DESCRIPTOR.get.call(signal);
    return state === true;
  } catch {
    return true;
  }
}

async function writeChunk(
  sink: ValidSink,
  chunk: string,
  signal: AbortSignal | undefined,
): Promise<ChunkWriteOutcome> {
  if (signal === undefined) {
    try {
      await Reflect.apply(sink.write, sink.receiver, [chunk]);
      return "written";
    } catch {
      return "sink-failed";
    }
  }
  if (isAborted(signal)) return "interrupted";
  return await new Promise<ChunkWriteOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ChunkWriteOutcome): void => {
      if (settled) return;
      settled = true;
      Reflect.apply(EVENT_TARGET_REMOVE_EVENT_LISTENER, signal, ["abort", onAbort]);
      resolve(outcome);
    };
    const onAbort = (): void => {
      finish("interrupted");
    };
    Reflect.apply(EVENT_TARGET_ADD_EVENT_LISTENER, signal, ["abort", onAbort, { once: true }]);
    if (isAborted(signal)) {
      finish("interrupted");
      return;
    }
    try {
      const returned = Reflect.apply(sink.write, sink.receiver, [chunk]) as unknown;
      Promise.resolve(returned).then(
        () => {
          finish("written");
        },
        () => {
          finish("sink-failed");
        },
      );
    } catch {
      finish("sink-failed");
    }
  });
}

/**
 * Preflight the complete B05 document, then write one bounded chunk at a time while awaiting sink
 * backpressure. Preflight failure writes nothing; a later sink failure or abort reports the exact
 * acknowledged prefix so callers can discard a non-atomic destination.
 */
export async function writeJsonDiagnostics(
  input: unknown,
  sources: readonly SourceDocument[],
  options: JsonFormatterOptions,
  sink: JsonChunkSink,
  signal?: AbortSignal,
): Promise<JsonFormatterWriteResult> {
  const validatedSink = validateSink(sink);
  if (!validatedSink.ok) return writeFailure(validatedSink.issue, 0, 0);
  if (!validateSignal(signal)) {
    return writeFailure(
      issue("invalid-options", "$signal", "must be an intrinsic AbortSignal"),
      0,
      0,
    );
  }
  if (signal !== undefined && isAborted(signal)) {
    return writeFailure(issue("interrupted", "$signal", "output was cancelled"), 0, 0);
  }
  const formatted = formatJsonDiagnostics(input, sources, options);
  if (!formatted.ok) {
    return Object.freeze({
      ok: false,
      byteLength: 0,
      chunksWritten: 0,
      issues: formatted.issues,
    });
  }
  let byteLength = 0;
  let chunksWritten = 0;
  for (const chunk of formatted.chunks) {
    const outcome = await writeChunk(validatedSink.value, chunk, signal);
    if (outcome !== "written") {
      return writeFailure(
        issue(
          outcome,
          outcome === "interrupted" ? "$signal" : "$sink",
          outcome === "interrupted" ? "output was cancelled" : "sink did not accept output",
        ),
        chunksWritten,
        byteLength,
      );
    }
    chunksWritten += 1;
    byteLength += Buffer.byteLength(chunk, "utf8");
  }
  return Object.freeze({
    ok: true,
    byteLength,
    chunksWritten,
    output: formatted.output,
  });
}
