import { performance } from "node:perf_hooks";
import { types as nodeTypes } from "node:util";
import { Worker } from "node:worker_threads";

import { countEstimatedTokens } from "./estimate-tokenizer.js";
import {
  BUILTIN_ESTIMATE_PROVIDER_ID,
  MAX_TOKENIZER_INPUT_BYTES,
  TOKENIZER_PLUGIN_CONTRACT_VERSION,
  resolveTokenizerProvider,
} from "./tokenizer-contract.js";

import type {
  ResolvedTokenizerProvider,
  TokenCount,
  TokenizerContractIssue,
} from "./tokenizer-contract.js";

export {
  EXACT_TOKENIZER_MAX_ARTIFACT_TEXT_BYTES,
  loadExactTokenizerArtifact,
} from "./exact-tokenizer-artifact.js";
export type { ArtifactLoadResult, ArtifactRecord } from "./exact-tokenizer-artifact.js";

export const EXACT_TOKENIZER_DEFAULT_TIMEOUT_MS = 1_000 as const;
export const EXACT_TOKENIZER_MIN_TIMEOUT_MS = 10 as const;
export const EXACT_TOKENIZER_MAX_TIMEOUT_MS = 5_000 as const;
export const EXACT_TOKENIZER_TERMINATION_GRACE_MS = 1_000 as const;

const OPTION_KEYS = ["signal", "timeoutMs"] as const;
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

export type ExactTokenizerFallbackCode =
  "provider-failed" | "provider-invalid" | "provider-timeout" | "provider-unavailable";

export interface ExactTokenizerOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TokenizerFallback {
  readonly code: ExactTokenizerFallbackCode;
  readonly message: string;
  readonly requestedProviderId: string;
}

export interface SelectedTokenCount {
  readonly count: TokenCount;
  readonly fallback?: TokenizerFallback;
  readonly requestedProviderId: string;
  readonly resolvedProvider: ResolvedTokenizerProvider;
}

export interface ExactTokenizerIssue {
  readonly code: "cancelled" | "invalid-options";
  readonly message: string;
  readonly path: string;
}

export type SelectedTokenCountResult =
  | { readonly ok: true; readonly value: SelectedTokenCount }
  | {
      readonly issues: readonly (ExactTokenizerIssue | TokenizerContractIssue)[];
      readonly ok: false;
    };

interface ResolvedOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

type WorkerOutcome =
  | {
      readonly status:
        "cancelled" | "containment-failed" | "failed" | "invalid" | "timeout" | "unavailable";
    }
  | { readonly status: "success"; readonly tokens: number };

type WorkerInvocation =
  | { readonly artifact: ArrayBuffer; readonly mode: "artifact" }
  | {
      readonly mode: "installed";
      readonly providerId: string;
      readonly resolutionBaseUrl: string;
    };

let exactTokenizerContainmentAvailable = true;

function issue(
  code: ExactTokenizerIssue["code"],
  path: string,
  message: string,
): ExactTokenizerIssue {
  return Object.freeze({ code, message, path });
}

function failure(entry: ExactTokenizerIssue | TokenizerContractIssue): SelectedTokenCountResult {
  return Object.freeze({ issues: Object.freeze([entry]), ok: false });
}

function intrinsicAbortState(value: unknown): boolean | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    ABORT_SIGNAL_ABORTED_DESCRIPTOR?.get === undefined ||
    typeof EVENT_TARGET_ADD_EVENT_LISTENER !== "function" ||
    typeof EVENT_TARGET_REMOVE_EVENT_LISTENER !== "function"
  ) {
    return undefined;
  }
  try {
    const state: unknown = ABORT_SIGNAL_ABORTED_DESCRIPTOR.get.call(value);
    return typeof state === "boolean" ? state : undefined;
  } catch {
    return undefined;
  }
}

function ownOptions(value: unknown): ReadonlyMap<string, unknown> | undefined {
  if (value === undefined) return new Map();
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    const keys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length > OPTION_KEYS.length ||
      keys.some(
        (key) =>
          typeof key !== "string" || !OPTION_KEYS.includes(key as (typeof OPTION_KEYS)[number]),
      )
    ) {
      return undefined;
    }
    const fields = new Map<string, unknown>();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      fields.set(key as string, descriptor.value as unknown);
    }
    return fields;
  } catch {
    return undefined;
  }
}

function resolveOptions(value: unknown): ResolvedOptions | ExactTokenizerIssue {
  const fields = ownOptions(value);
  if (fields === undefined) {
    return issue("invalid-options", "$options", "options must be a closed plain data object");
  }
  const timeoutMs = fields.get("timeoutMs") ?? EXACT_TOKENIZER_DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < EXACT_TOKENIZER_MIN_TIMEOUT_MS ||
    timeoutMs > EXACT_TOKENIZER_MAX_TIMEOUT_MS
  ) {
    return issue(
      "invalid-options",
      "$options.timeoutMs",
      "timeout must be a bounded integer number of milliseconds",
    );
  }
  const signal = fields.get("signal");
  if (signal !== undefined && intrinsicAbortState(signal) === undefined) {
    return issue("invalid-options", "$options.signal", "signal must be an intrinsic AbortSignal");
  }
  return Object.freeze({ signal: signal as AbortSignal | undefined, timeoutMs });
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EVENT_TARGET_ADD_EVENT_LISTENER, signal, ["abort", listener, { once: true }]);
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EVENT_TARGET_REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
}

async function runExactWorker(
  invocation: WorkerInvocation,
  input: Uint8Array,
  options: ResolvedOptions,
): Promise<WorkerOutcome> {
  if (!exactTokenizerContainmentAvailable) return { status: "containment-failed" };
  if (options.signal !== undefined && intrinsicAbortState(options.signal) !== false) {
    return { status: "cancelled" };
  }
  const inputBuffer = Uint8Array.from(input).buffer;
  let worker: Worker;
  try {
    const workerUrl = import.meta.url.endsWith(".ts")
      ? new URL("./exact-tokenizer-worker.ts", import.meta.url)
      : new URL("./exact-tokenizer-worker.js", import.meta.url);
    const transferList = [inputBuffer];
    if (invocation.mode === "artifact") transferList.push(invocation.artifact);
    worker = new Worker(workerUrl, {
      argv: [],
      env: {},
      execArgv: [],
      name: "acl-exact-tokenizer",
      resourceLimits: {
        codeRangeSizeMb: 8,
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
      stderr: true,
      stdin: false,
      stdout: true,
      transferList,
      workerData: { ...invocation, input: inputBuffer },
    });
  } catch {
    return { status: "failed" };
  }

  return await new Promise<WorkerOutcome>((resolve) => {
    let settling = false;
    const signal = options.signal;
    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal !== undefined) removeAbortListener(signal, onAbort);
      worker.removeAllListeners();
    };
    const finishAfterTermination = (outcome: WorkerOutcome): void => {
      if (settling) return;
      settling = true;
      cleanup();
      let termination: Promise<number>;
      try {
        termination = worker.terminate();
      } catch {
        exactTokenizerContainmentAvailable = false;
        worker.unref();
        resolve({ status: "containment-failed" });
        return;
      }
      let graceTimer: ReturnType<typeof setTimeout>;
      const grace = new Promise<false>((graceResolve) => {
        graceTimer = setTimeout(() => {
          graceResolve(false);
        }, EXACT_TOKENIZER_TERMINATION_GRACE_MS);
      });
      void Promise.race([
        termination.then(
          () => true as const,
          () => false as const,
        ),
        grace,
      ]).then((confirmed) => {
        clearTimeout(graceTimer);
        if (!confirmed) {
          exactTokenizerContainmentAvailable = false;
          worker.unref();
        }
        resolve(confirmed ? outcome : { status: "containment-failed" });
      });
    };
    const onAbort = (): void => {
      finishAfterTermination({ status: "cancelled" });
    };
    const timer = setTimeout(() => {
      finishAfterTermination({ status: "timeout" });
    }, options.timeoutMs);
    timer.unref();
    worker.once("message", (message: unknown) => {
      if (
        message !== null &&
        typeof message === "object" &&
        !nodeTypes.isProxy(message) &&
        Reflect.ownKeys(message).length === 2 &&
        Object.getOwnPropertyDescriptor(message, "ok")?.value === true
      ) {
        const tokens = Object.getOwnPropertyDescriptor(message, "tokens")?.value as unknown;
        if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) {
          finishAfterTermination({ status: "success", tokens });
          return;
        }
      }
      if (
        message !== null &&
        typeof message === "object" &&
        !nodeTypes.isProxy(message) &&
        Object.getOwnPropertyDescriptor(message, "ok")?.value === false
      ) {
        const code = Object.getOwnPropertyDescriptor(message, "code")?.value as unknown;
        if (code === "invalid" || code === "unavailable") {
          finishAfterTermination({ status: code });
          return;
        }
      }
      finishAfterTermination({ status: "failed" });
    });
    worker.once("messageerror", () => {
      finishAfterTermination({ status: "failed" });
    });
    worker.once("error", () => {
      finishAfterTermination({ status: "failed" });
    });
    worker.once("exit", () => {
      if (settling) return;
      settling = true;
      cleanup();
      resolve({ status: "failed" });
    });
    if (signal !== undefined) {
      addAbortListener(signal, onAbort);
      if (intrinsicAbortState(signal) !== false) onAbort();
    }
  });
}

/** Internal worker conformance seam; it is intentionally absent from the package export map. */
export async function runExactTokenizerWorkerForTest(
  artifact: Uint8Array,
  input: Uint8Array,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WorkerOutcome> {
  return await runExactWorker(
    { artifact: Uint8Array.from(artifact).buffer, mode: "artifact" },
    Uint8Array.from(input),
    Object.freeze({ signal, timeoutMs }),
  );
}

function fallbackMessage(code: ExactTokenizerFallbackCode): string {
  switch (code) {
    case "provider-unavailable":
      return "optional tokenizer package is not installed";
    case "provider-invalid":
      return "optional tokenizer package failed integrity or ABI validation";
    case "provider-timeout":
      return "optional tokenizer exceeded its execution deadline";
    case "provider-failed":
      return "optional tokenizer failed without exposing provider-controlled details";
  }
}

function successfulSelection(
  count: TokenCount,
  requestedProviderId: string,
  resolvedProvider: ResolvedTokenizerProvider,
  fallbackCode?: ExactTokenizerFallbackCode,
): SelectedTokenCountResult {
  const fallback =
    fallbackCode === undefined
      ? undefined
      : Object.freeze({
          code: fallbackCode,
          message: fallbackMessage(fallbackCode),
          requestedProviderId,
        });
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      count,
      ...(fallback === undefined ? {} : { fallback }),
      requestedProviderId,
      resolvedProvider,
    }),
  });
}

function estimateFallback(
  input: string,
  requestedProviderId: string,
  fallbackCode?: ExactTokenizerFallbackCode,
): SelectedTokenCountResult {
  const estimate = countEstimatedTokens(input);
  const provider = resolveTokenizerProvider(BUILTIN_ESTIMATE_PROVIDER_ID);
  if (!estimate.ok) return Object.freeze({ issues: estimate.issues, ok: false });
  if (!provider.ok) return Object.freeze({ issues: provider.issues, ok: false });
  return successfulSelection(estimate.value, requestedProviderId, provider.value, fallbackCode);
}

/**
 * Internal conformance seam with a caller-selected package-resolution base. Public callers use
 * `countTokensWithProvider`, whose base is fixed to the installed efficiency package.
 */
export async function countTokensWithProviderAtBase(
  providerId: unknown,
  input: unknown,
  optionsInput: unknown,
  resolutionBaseUrl: string,
): Promise<SelectedTokenCountResult> {
  const provider = resolveTokenizerProvider(providerId);
  if (!provider.ok) return Object.freeze({ issues: provider.issues, ok: false });
  const options = resolveOptions(optionsInput);
  if ("code" in options) return failure(options);
  const deadline = performance.now() + options.timeoutMs;
  if (options.signal !== undefined && intrinsicAbortState(options.signal) !== false) {
    return failure(issue("cancelled", "$options.signal", "tokenizer operation was cancelled"));
  }
  if (typeof input !== "string") {
    const estimate = countEstimatedTokens(input);
    return Object.freeze({ issues: estimate.ok ? [] : estimate.issues, ok: false });
  }
  if (input.length > MAX_TOKENIZER_INPUT_BYTES)
    return estimateFallback(input, provider.value.providerId);
  const estimate = countEstimatedTokens(input);
  if (!estimate.ok) return Object.freeze({ issues: estimate.issues, ok: false });
  if (provider.value.execution === "builtin") {
    return successfulSelection(estimate.value, provider.value.providerId, provider.value);
  }

  const encoded = new TextEncoder().encode(input);
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) {
    return estimateFallback(input, provider.value.providerId, "provider-timeout");
  }
  const outcome = await runExactWorker(
    {
      mode: "installed",
      providerId: provider.value.providerId,
      resolutionBaseUrl,
    },
    encoded,
    Object.freeze({ signal: options.signal, timeoutMs: Math.ceil(remainingMs) }),
  );
  if (outcome.status === "cancelled") {
    return failure(issue("cancelled", "$options.signal", "tokenizer operation was cancelled"));
  }
  if (outcome.status !== "success") {
    const fallbackCode: ExactTokenizerFallbackCode =
      outcome.status === "timeout"
        ? "provider-timeout"
        : outcome.status === "unavailable"
          ? "provider-unavailable"
          : outcome.status === "invalid"
            ? "provider-invalid"
            : "provider-failed";
    return estimateFallback(input, provider.value.providerId, fallbackCode);
  }
  return successfulSelection(
    Object.freeze({
      contractVersion: TOKENIZER_PLUGIN_CONTRACT_VERSION,
      identity: provider.value.identity,
      inputCodeUnits: input.length,
      inputUtf8Bytes: encoded.byteLength,
      tokens: outcome.tokens,
    }),
    provider.value.providerId,
    provider.value,
  );
}

/** Select a release-owned tokenizer, degrading missing or failed optional packages to G02. */
export async function countTokensWithProvider(
  providerId: unknown,
  input: unknown,
  options?: ExactTokenizerOptions,
): Promise<SelectedTokenCountResult> {
  return await countTokensWithProviderAtBase(providerId, input, options, import.meta.url);
}
