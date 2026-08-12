import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { isRepositoryRelativePath } from "@agent-context/core";

export const SEMANTIC_PLUGIN_CONTRACT_VERSION = "0.1.0" as const;
export const SEMANTIC_PLUGIN_CONFIGURATION_RECORD_KIND =
  "agent-context-semantic-plugin-configuration" as const;
export const SEMANTIC_PLUGIN_INPUT_RECORD_KIND = "agent-context-semantic-plugin-input" as const;
export const SEMANTIC_PLUGIN_RESULT_RECORD_KIND = "agent-context-semantic-plugin-result" as const;
export const REFERENCE_SEMANTIC_PLUGIN_ID = "reference-contradiction-candidate-v1" as const;
export const REFERENCE_SEMANTIC_PLUGIN_WASM_SHA256 =
  "c0ee64588938369cf39b3422e47f1f33ea478c836c84c355ed3650c4cbb69afb" as const;

export type SemanticPluginId = typeof REFERENCE_SEMANTIC_PLUGIN_ID;
export type SemanticPluginCapability = never;

export interface SemanticPluginConfiguration {
  readonly contractVersion: typeof SEMANTIC_PLUGIN_CONTRACT_VERSION;
  readonly enabled: boolean;
  readonly pluginId: SemanticPluginId | null;
  readonly recordKind: typeof SEMANTIC_PLUGIN_CONFIGURATION_RECORD_KIND;
}

export const SEMANTIC_PLUGIN_DISABLED_CONFIGURATION: Readonly<SemanticPluginConfiguration> =
  Object.freeze({
    contractVersion: SEMANTIC_PLUGIN_CONTRACT_VERSION,
    enabled: false,
    pluginId: null,
    recordKind: SEMANTIC_PLUGIN_CONFIGURATION_RECORD_KIND,
  });

export interface SemanticPluginDescriptor {
  readonly capabilities: readonly SemanticPluginCapability[];
  readonly id: SemanticPluginId;
  readonly module: Readonly<{
    readonly format: "webassembly-v1";
    readonly importedFunctions: 0;
    readonly maximumMemoryBytes: 0;
    readonly sha256: typeof REFERENCE_SEMANTIC_PLUGIN_WASM_SHA256;
  }>;
  readonly version: "1.0.0";
}

export const REFERENCE_SEMANTIC_PLUGIN_DESCRIPTOR: Readonly<SemanticPluginDescriptor> =
  Object.freeze({
    capabilities: Object.freeze([]),
    id: REFERENCE_SEMANTIC_PLUGIN_ID,
    module: Object.freeze({
      format: "webassembly-v1",
      importedFunctions: 0,
      maximumMemoryBytes: 0,
      sha256: REFERENCE_SEMANTIC_PLUGIN_WASM_SHA256,
    }),
    version: "1.0.0",
  });

export interface SemanticPluginDocument {
  readonly documentId: string;
  readonly path: string;
  readonly sourceDigest: string;
  readonly text: string;
}

export interface SemanticPluginInput {
  readonly contractVersion: typeof SEMANTIC_PLUGIN_CONTRACT_VERSION;
  readonly documents: readonly SemanticPluginDocument[];
  readonly recordKind: typeof SEMANTIC_PLUGIN_INPUT_RECORD_KIND;
}

export interface SemanticPluginLimits {
  readonly maximumDocuments: number;
  readonly maximumFindings: number;
  readonly maximumInputBytes: number;
  readonly maximumWorkUnits: number;
}

export interface SemanticPluginOptions extends Partial<SemanticPluginLimits> {
  readonly signal?: AbortSignal | undefined;
}

export const SEMANTIC_PLUGIN_DEFAULT_LIMITS: Readonly<SemanticPluginLimits> = Object.freeze({
  maximumDocuments: 256,
  maximumFindings: 128,
  maximumInputBytes: 1_048_576,
  maximumWorkUnits: 2_097_152,
});

export const SEMANTIC_PLUGIN_HARD_LIMITS: Readonly<SemanticPluginLimits> = Object.freeze({
  maximumDocuments: 2_048,
  maximumFindings: 1_024,
  maximumInputBytes: 8_388_608,
  maximumWorkUnits: 16_777_216,
});

export type SemanticPluginIssueCode =
  | "cancelled"
  | "invalid-configuration"
  | "invalid-input"
  | "invalid-options"
  | "plugin-failure"
  | "resource-limit";

export interface SemanticPluginIssue {
  readonly code: SemanticPluginIssueCode;
  readonly message: string;
  readonly path: string;
}

export interface SemanticPluginFinding {
  readonly code: "contradiction-candidate";
  readonly documentId: string;
  readonly line: number;
  readonly message: "Document contains both always and never directives; manual review is required.";
  readonly path: string;
  readonly sourceDigest: string;
}

export interface SemanticPluginSuccess {
  readonly contractVersion: typeof SEMANTIC_PLUGIN_CONTRACT_VERSION;
  readonly determinism: "non-deterministic";
  readonly enabled: boolean;
  readonly findings: readonly SemanticPluginFinding[];
  readonly networkAccess: "denied";
  readonly ok: true;
  readonly plugin: SemanticPluginDescriptor | null;
  readonly qualityClaim: false;
  readonly recordKind: typeof SEMANTIC_PLUGIN_RESULT_RECORD_KIND;
}

export type SemanticPluginResult =
  SemanticPluginSuccess | { readonly issues: readonly SemanticPluginIssue[]; readonly ok: false };

type DataRecord = Readonly<Record<string, unknown>>;
interface WasmModuleExport {
  readonly kind: string;
  readonly name: string;
}
interface WasmRuntime {
  readonly Instance: new (
    module: unknown,
    imports: Readonly<Record<string, never>>,
  ) => {
    readonly exports: Readonly<
      Record<string, ((...arguments_: readonly number[]) => unknown) | undefined>
    >;
  };
  readonly Module: {
    new (bytes: Uint8Array): unknown;
    exports(module: unknown): readonly WasmModuleExport[];
    imports(module: unknown): readonly unknown[];
  };
  validate(bytes: Uint8Array): boolean;
}

const CONFIGURATION_KEYS = new Set(["contractVersion", "enabled", "pluginId", "recordKind"]);
const INPUT_KEYS = new Set(["contractVersion", "documents", "recordKind"]);
const DOCUMENT_KEYS = new Set(["documentId", "path", "sourceDigest", "text"]);
const OPTION_KEYS = new Set([
  "maximumDocuments",
  "maximumFindings",
  "maximumInputBytes",
  "maximumWorkUnits",
  "signal",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
// Release-owned WebAssembly v1 module equivalent to
// `(func (export "classify") (param i32 i32) (result i32) local.get 0 local.get 1 i32.and)`.
// It has no imports, memory, table, start function, indirect calls, loops, or caller-provided bytes.
const REFERENCE_WASM_BYTES = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
  0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x0c, 0x01, 0x08, 0x63, 0x6c, 0x61, 0x73, 0x73, 0x69, 0x66,
  0x79, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x71, 0x0b,
]);
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with the validated signal.
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function issue(code: SemanticPluginIssueCode, path: string, message: string): SemanticPluginIssue {
  return Object.freeze({ code, message, path });
}

function failure(value: SemanticPluginIssue): SemanticPluginResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function isIssue(value: unknown): value is SemanticPluginIssue {
  return value !== null && typeof value === "object" && Object.hasOwn(value, "code");
}

function record(
  value: unknown,
  keys: ReadonlySet<string>,
  path: string,
  code: "invalid-configuration" | "invalid-input" | "invalid-options",
): DataRecord | SemanticPluginIssue {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return issue(code, path, "must be a non-proxy plain data record");
  try {
    const prototype = Reflect.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ownKeys.length !== keys.size ||
      ownKeys.some((key) => typeof key !== "string" || !keys.has(key))
    )
      return issue(code, path, "has unknown or missing fields");
    const output: Record<string, unknown> = {};
    for (const key of ownKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return issue(code, path, "must contain only enumerable own data fields");
      output[key as string] = descriptor.value;
    }
    return output;
  } catch {
    return issue(code, path, "cannot be inspected safely");
  }
}

function partialRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  path: string,
): DataRecord | SemanticPluginIssue {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return issue("invalid-options", path, "must be a non-proxy plain data record");
  try {
    const prototype = Reflect.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ownKeys.some((key) => typeof key !== "string" || !keys.has(key))
    )
      return issue("invalid-options", path, "has unknown fields");
    const output: Record<string, unknown> = {};
    for (const key of ownKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
        return issue("invalid-options", path, "must contain only enumerable own data fields");
      output[key as string] = descriptor.value;
    }
    return output;
  } catch {
    return issue("invalid-options", path, "cannot be inspected safely");
  }
}

function string(
  value: unknown,
  path: string,
  pattern: RegExp,
  maximumLength: number,
): string | SemanticPluginIssue {
  if (typeof value !== "string" || value.length > maximumLength || !pattern.test(value))
    return issue("invalid-input", path, "is not a valid bounded string");
  return value;
}

function aborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined || ABORTED_GETTER === undefined) return false;
  return Reflect.apply(ABORTED_GETTER, signal, []) === true;
}

function normalizeOptions(
  value: SemanticPluginOptions | undefined,
):
  | { readonly limits: SemanticPluginLimits; readonly signal: AbortSignal | undefined }
  | SemanticPluginIssue {
  if (value === undefined) return { limits: SEMANTIC_PLUGIN_DEFAULT_LIMITS, signal: undefined };
  const inspected = partialRecord(value, OPTION_KEYS, "$options");
  if (isIssue(inspected)) return inspected;
  const selected: Record<keyof SemanticPluginLimits, number> = {
    maximumDocuments: SEMANTIC_PLUGIN_DEFAULT_LIMITS.maximumDocuments,
    maximumFindings: SEMANTIC_PLUGIN_DEFAULT_LIMITS.maximumFindings,
    maximumInputBytes: SEMANTIC_PLUGIN_DEFAULT_LIMITS.maximumInputBytes,
    maximumWorkUnits: SEMANTIC_PLUGIN_DEFAULT_LIMITS.maximumWorkUnits,
  };
  for (const key of Object.keys(selected) as (keyof SemanticPluginLimits)[]) {
    const candidate = inspected[key];
    if (candidate === undefined) continue;
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > SEMANTIC_PLUGIN_HARD_LIMITS[key]
    )
      return issue(
        "invalid-options",
        `$options.${key}`,
        "must be a positive safe integer within its hard limit",
      );
    selected[key] = candidate;
  }
  const signal = inspected["signal"];
  if (signal !== undefined) {
    try {
      if (!(signal instanceof AbortSignal) || nodeTypes.isProxy(signal))
        return issue("invalid-options", "$options.signal", "must be a native AbortSignal");
    } catch {
      return issue("invalid-options", "$options.signal", "cannot be inspected safely");
    }
  }
  return { limits: Object.freeze(selected), signal };
}

function normalizeConfiguration(value: unknown): SemanticPluginConfiguration | SemanticPluginIssue {
  const inspected = record(value, CONFIGURATION_KEYS, "$configuration", "invalid-configuration");
  if (isIssue(inspected)) return inspected;
  if (
    inspected["contractVersion"] !== SEMANTIC_PLUGIN_CONTRACT_VERSION ||
    inspected["recordKind"] !== SEMANTIC_PLUGIN_CONFIGURATION_RECORD_KIND ||
    typeof inspected["enabled"] !== "boolean"
  )
    return issue("invalid-configuration", "$configuration", "has an unsupported contract or state");
  if (!inspected["enabled"] && inspected["pluginId"] !== null)
    return issue("invalid-configuration", "$configuration.pluginId", "must be null while disabled");
  if (inspected["enabled"] && inspected["pluginId"] !== REFERENCE_SEMANTIC_PLUGIN_ID)
    return issue("invalid-configuration", "$configuration.pluginId", "is not a registered plug-in");
  return Object.freeze({
    contractVersion: SEMANTIC_PLUGIN_CONTRACT_VERSION,
    enabled: inspected["enabled"],
    pluginId: inspected["pluginId"] as SemanticPluginId | null,
    recordKind: SEMANTIC_PLUGIN_CONFIGURATION_RECORD_KIND,
  });
}

function normalizeInput(
  value: unknown,
  limits: SemanticPluginLimits,
): readonly SemanticPluginDocument[] | SemanticPluginIssue {
  const inspected = record(value, INPUT_KEYS, "$input", "invalid-input");
  if (isIssue(inspected)) return inspected;
  if (
    inspected["contractVersion"] !== SEMANTIC_PLUGIN_CONTRACT_VERSION ||
    inspected["recordKind"] !== SEMANTIC_PLUGIN_INPUT_RECORD_KIND
  )
    return issue("invalid-input", "$input", "has an unsupported contract");
  const documents = inspected["documents"];
  if (!Array.isArray(documents) || nodeTypes.isProxy(documents))
    return issue("invalid-input", "$input.documents", "must be a non-proxy dense array");
  if (documents.length > limits.maximumDocuments)
    return issue("resource-limit", "$input.documents", "exceeds the bounded dense document list");
  const normalized: SemanticPluginDocument[] = [];
  const documentIds = new Set<string>();
  const paths = new Set<string>();
  let bytes = 0;
  let workUnits = 0;
  for (let index = 0; index < documents.length; index += 1) {
    if (!Object.hasOwn(documents, index))
      return issue("invalid-input", `$input.documents[${String(index)}]`, "must not be sparse");
    const item = record(
      documents[index],
      DOCUMENT_KEYS,
      `$input.documents[${String(index)}]`,
      "invalid-input",
    );
    if (isIssue(item)) return item;
    const documentId = string(
      item["documentId"],
      `$input.documents[${String(index)}].documentId`,
      SAFE_ID,
      256,
    );
    if (typeof documentId !== "string") return documentId;
    const path = item["path"];
    if (
      typeof path !== "string" ||
      path === "." ||
      path.length > 4096 ||
      !isRepositoryRelativePath(path)
    )
      return issue(
        "invalid-input",
        `$input.documents[${String(index)}].path`,
        "must be a bounded canonical repository-relative path",
      );
    const sourceDigest = string(
      item["sourceDigest"],
      `$input.documents[${String(index)}].sourceDigest`,
      SHA256,
      64,
    );
    if (typeof sourceDigest !== "string") return sourceDigest;
    if (documentIds.has(documentId))
      return issue(
        "invalid-input",
        `$input.documents[${String(index)}].documentId`,
        "must be unique",
      );
    if (paths.has(path))
      return issue("invalid-input", `$input.documents[${String(index)}].path`, "must be unique");
    documentIds.add(documentId);
    paths.add(path);
    const pathBytes = Buffer.byteLength(path, "utf8");
    if (pathBytes > limits.maximumInputBytes - bytes)
      return issue("resource-limit", "$input.documents", "exceeds the aggregate input byte limit");
    bytes += pathBytes;
    const text = item["text"];
    if (typeof text !== "string")
      return issue(
        "invalid-input",
        `$input.documents[${String(index)}].text`,
        "must be NUL-free text",
      );
    // UTF-8 uses at least one byte per UTF-16 code unit. Reject oversized strings by their O(1)
    // length before invoking any linear string or encoding operation on hostile content.
    if (text.length > limits.maximumInputBytes - bytes)
      return issue("resource-limit", "$input.documents", "exceeds the aggregate input byte limit");
    if (text.length > limits.maximumWorkUnits - workUnits)
      return issue("resource-limit", "$input.documents", "exceeds the plug-in work limit");
    if (text.includes("\0"))
      return issue(
        "invalid-input",
        `$input.documents[${String(index)}].text`,
        "must be NUL-free text",
      );
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > limits.maximumInputBytes)
      return issue("resource-limit", "$input.documents", "exceeds the aggregate input byte limit");
    workUnits += text.length;
    normalized.push(Object.freeze({ documentId, path, sourceDigest, text }));
  }
  return Object.freeze(normalized);
}

function disabledSuccess(): SemanticPluginSuccess {
  return Object.freeze({
    contractVersion: SEMANTIC_PLUGIN_CONTRACT_VERSION,
    determinism: "non-deterministic",
    enabled: false,
    findings: Object.freeze([]),
    networkAccess: "denied",
    ok: true,
    plugin: null,
    qualityClaim: false,
    recordKind: SEMANTIC_PLUGIN_RESULT_RECORD_KIND,
  });
}

/** Returns a detached copy of the fixed release-owned module for audit and reproducibility. */
export function getReferenceSemanticPluginModuleBytes(): Uint8Array {
  return Uint8Array.from(REFERENCE_WASM_BYTES);
}

function instantiateReferencePlugin():
  ((alwaysPresent: number, neverPresent: number) => number) | SemanticPluginIssue {
  try {
    const runtime = (globalThis as { readonly WebAssembly?: WasmRuntime }).WebAssembly;
    if (runtime === undefined)
      return issue("plugin-failure", "$plugin.module", "WebAssembly runtime is unavailable");
    const bytes = Uint8Array.from(REFERENCE_WASM_BYTES);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== REFERENCE_SEMANTIC_PLUGIN_WASM_SHA256 || !runtime.validate(bytes))
      return issue("plugin-failure", "$plugin.module", "release-owned module integrity failed");
    const module = new runtime.Module(bytes);
    if (runtime.Module.imports(module).length !== 0)
      return issue(
        "plugin-failure",
        "$plugin.module",
        "release-owned module requested capabilities",
      );
    const exports = runtime.Module.exports(module);
    const soleExport = exports.at(0);
    if (exports.length !== 1 || soleExport?.name !== "classify" || soleExport.kind !== "function")
      return issue("plugin-failure", "$plugin.module", "release-owned module exports are invalid");
    const instance = new runtime.Instance(module, Object.freeze({}));
    const classify = instance.exports["classify"];
    if (typeof classify !== "function")
      return issue("plugin-failure", "$plugin.module", "release-owned entry point is missing");
    return (alwaysPresent, neverPresent) => {
      const value = classify(alwaysPresent, neverPresent);
      if (typeof value !== "number" || (value !== 0 && value !== 1))
        throw new TypeError("invalid WebAssembly result");
      return value;
    };
  } catch {
    return issue("plugin-failure", "$plugin.module", "release-owned module could not execute");
  }
}

async function runReferencePlugin(
  documents: readonly SemanticPluginDocument[],
  limits: SemanticPluginLimits,
  signal: AbortSignal | undefined,
): Promise<SemanticPluginResult> {
  const classify = instantiateReferencePlugin();
  if (typeof classify !== "function") return failure(classify);
  const findings: SemanticPluginFinding[] = [];
  let workUnits = 0;
  for (const document of documents) {
    if (aborted(signal))
      return failure(issue("cancelled", "$options.signal", "operation was cancelled"));
    workUnits += document.text.length;
    if (workUnits > limits.maximumWorkUnits)
      return failure(issue("resource-limit", "$input.documents", "exceeds the plug-in work limit"));
    const lines = document.text.split(/\r\n|[\n\r]/u);
    let alwaysLine = 0;
    let neverLine = 0;
    for (const [index, line] of lines.entries()) {
      if (alwaysLine === 0 && /\balways\b/iu.test(line)) alwaysLine = index + 1;
      if (neverLine === 0 && /\bnever\b/iu.test(line)) neverLine = index + 1;
    }
    let selected: number;
    try {
      selected = classify(alwaysLine > 0 ? 1 : 0, neverLine > 0 ? 1 : 0);
    } catch {
      return failure(
        issue("plugin-failure", "$plugin.output", "release-owned module returned invalid output"),
      );
    }
    if (selected === 1) {
      if (findings.length >= limits.maximumFindings)
        return failure(issue("resource-limit", "$output.findings", "exceeds the finding limit"));
      findings.push(
        Object.freeze({
          code: "contradiction-candidate",
          documentId: document.documentId,
          line: Math.min(alwaysLine, neverLine),
          message: "Document contains both always and never directives; manual review is required.",
          path: document.path,
          sourceDigest: document.sourceDigest,
        }),
      );
    }
    await Promise.resolve();
  }
  if (aborted(signal))
    return failure(issue("cancelled", "$options.signal", "operation was cancelled"));
  findings.sort((left, right) => {
    const pathOrder = Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    );
    if (pathOrder !== 0) return pathOrder;
    if (left.line !== right.line) return left.line - right.line;
    const documentOrder = Buffer.compare(
      Buffer.from(left.documentId, "utf8"),
      Buffer.from(right.documentId, "utf8"),
    );
    if (documentOrder !== 0) return documentOrder;
    return Buffer.compare(
      Buffer.from(left.sourceDigest, "utf8"),
      Buffer.from(right.sourceDigest, "utf8"),
    );
  });
  return Object.freeze({
    contractVersion: SEMANTIC_PLUGIN_CONTRACT_VERSION,
    determinism: "non-deterministic",
    enabled: true,
    findings: Object.freeze(findings),
    networkAccess: "denied",
    ok: true,
    plugin: REFERENCE_SEMANTIC_PLUGIN_DESCRIPTOR,
    qualityClaim: false,
    recordKind: SEMANTIC_PLUGIN_RESULT_RECORD_KIND,
  });
}

/**
 * Runs only a statically registered, release-owned semantic plug-in. The public boundary accepts
 * data, never code or capabilities. Results are deliberately separate from deterministic B04/F15
 * diagnostics and are always labeled non-deterministic.
 */
export async function runSemanticRulePlugin(
  input: unknown,
  configuration: unknown = SEMANTIC_PLUGIN_DISABLED_CONFIGURATION,
  options?: SemanticPluginOptions,
): Promise<SemanticPluginResult> {
  const normalizedOptions = normalizeOptions(options);
  if (isIssue(normalizedOptions)) return failure(normalizedOptions);
  if (aborted(normalizedOptions.signal))
    return failure(issue("cancelled", "$options.signal", "operation was cancelled"));
  const normalizedConfiguration = normalizeConfiguration(configuration);
  if (isIssue(normalizedConfiguration)) return failure(normalizedConfiguration);
  if (!normalizedConfiguration.enabled) return disabledSuccess();
  const documents = normalizeInput(input, normalizedOptions.limits);
  if (isIssue(documents)) return failure(documents);
  return runReferencePlugin(documents, normalizedOptions.limits, normalizedOptions.signal);
}
