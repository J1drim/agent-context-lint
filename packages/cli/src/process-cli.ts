import { CLI_EXIT_CODES, runCommandRouter } from "./command-router.js";

import type {
  CliCommandHandlers,
  CliExitCode,
  CliInvocation,
  CliOutput,
  CliRunResult,
} from "./command-router.js";

export interface SigintSource {
  readonly addListener: (listener: () => void) => void;
  readonly removeListener: (listener: () => void) => void;
}

export interface ProcessCliHost {
  readonly argv: readonly string[];
  readonly setExitCode: (exitCode: CliExitCode) => void;
  readonly sigint: SigintSource;
  readonly stderr: CliOutput;
  readonly stdout: CliOutput;
}

export interface CallbackWritable {
  readonly off: (event: "error", listener: (error: unknown) => void) => unknown;
  readonly once: (event: "error", listener: (error: unknown) => void) => unknown;
  readonly write: (text: string, callback: (error?: Error | null) => void) => boolean;
}

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

function intrinsicAbortState(signal: AbortSignal): boolean | undefined {
  if (ABORT_SIGNAL_ABORTED_DESCRIPTOR?.get === undefined) return undefined;
  try {
    const state: unknown = ABORT_SIGNAL_ABORTED_DESCRIPTOR.get.call(signal);
    return typeof state === "boolean" ? state : undefined;
  } catch {
    return undefined;
  }
}

function addIntrinsicAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EVENT_TARGET_ADD_EVENT_LISTENER, signal, ["abort", listener, { once: true }]);
}

function removeIntrinsicAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EVENT_TARGET_REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
}

export function createNodeWritableOutput(stream: CallbackWritable): CliOutput {
  return Object.freeze({
    write: (text: string, signal: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        if (intrinsicAbortState(signal) !== false) {
          reject(new Error("stream write failed"));
          return;
        }
        let settled = false;
        let abortListenerInstalled = false;
        const settle = (failed: boolean): void => {
          if (settled) return;
          settled = true;
          try {
            stream.off("error", onError);
          } catch {
            // The fixed failure below remains authoritative for a hostile stream capability.
          }
          if (abortListenerInstalled) removeIntrinsicAbortListener(signal, onAbort);
          if (failed) reject(new Error("stream write failed"));
          else resolve();
        };
        const onAbort = (): void => {
          settle(true);
        };
        const onError = (): void => {
          settle(true);
        };
        try {
          stream.once("error", onError);
        } catch {
          settle(true);
          return;
        }
        addIntrinsicAbortListener(signal, onAbort);
        abortListenerInstalled = true;
        if (intrinsicAbortState(signal) !== false) {
          settle(true);
          return;
        }
        try {
          stream.write(text, (error): void => {
            settle(error !== undefined && error !== null);
          });
        } catch {
          settle(true);
        }
      }),
  });
}

function operationalResult(): CliRunResult {
  return Object.freeze({
    exitCode: CLI_EXIT_CODES.operationalFailure,
    operationalError: Object.freeze({
      category: "operational",
      code: "invalid-invocation",
      message: "invalid CLI invocation",
      retryable: false,
    }),
  });
}

export async function runProcessCli(
  host: ProcessCliHost,
  handlers: CliCommandHandlers = Object.freeze({}),
): Promise<CliRunResult> {
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort();
  };
  let listenerInstalled = false;
  let result = operationalResult();
  try {
    host.sigint.addListener(interrupt);
    listenerInstalled = true;
    const invocation: CliInvocation = Object.freeze({
      argv: host.argv,
      signal: controller.signal,
      stderr: host.stderr,
      stdout: host.stdout,
    });
    result = await runCommandRouter(invocation, handlers);
  } catch {
    result = operationalResult();
  } finally {
    if (listenerInstalled) {
      try {
        host.sigint.removeListener(interrupt);
      } catch {
        result = operationalResult();
      }
    }
    host.setExitCode(result.exitCode);
  }
  return result;
}
