import { getEventListeners } from "node:events";

import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
  type ScanJsonOutput,
} from "@agent-context/core";
import { describe, expect, test, vi } from "vitest";

import {
  LIBRARY_API_CONTRACT_VERSION,
  LIBRARY_PROGRESS_KIND,
  LIBRARY_SCAN_CAPABILITY_KIND,
  LIBRARY_SCAN_REQUEST_KIND,
  LibraryApiErrorCode,
  createLibraryScanCapability,
  isIssuedLibraryScanCapability,
  isLibraryApiError,
  scanAgentContext,
  type LibraryScanCapability,
  type LibraryScanExecutionContext,
  type LibraryScanExecutionResult,
  type LibraryScanProgress,
  type LibraryScanRequest,
} from "../src/index.js";

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function request(overrides: Partial<LibraryScanRequest> = {}): LibraryScanRequest {
  return {
    contractVersion: LIBRARY_API_CONTRACT_VERSION,
    profileIds: ["codex-cli"],
    progressUnits: 2,
    recordKind: LIBRARY_SCAN_REQUEST_KIND,
    repositoryRoot: "file:///workspace/project/",
    targetPaths: [path("src/z.ts"), path("src/a.ts")],
    ...overrides,
  };
}

function output(profileVersion = "0.1.0"): ScanJsonOutput {
  return {
    diagnostics: {
      contractVersion: "0.1.0",
      diagnostics: [],
      recordKind: "agent-context-diagnostics",
      suppressions: [],
    },
    failureThreshold: "error",
    profileVersions: {
      "codex-cli": { clientVersion: null, profileVersion },
    },
    recordKind: "agent-context-scan-output",
    schemaVersion: "1.0.0",
    summary: { errors: 0, exitCode: 0, infos: 0, suppressed: 0, warnings: 0 },
  };
}

function successCapability(
  implementation: (
    request: LibraryScanRequest,
    context: LibraryScanExecutionContext,
  ) => Promise<void> = async (_request, context) => {
    context.reportProgress();
    await Promise.resolve();
    context.reportProgress();
  },
): LibraryScanCapability {
  return createLibraryScanCapability(async (scanRequest, context) => {
    await implementation(scanRequest, context);
    return { output: output(), sources: [] };
  });
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to reject");
}

describe("public library scan facade", () => {
  test("returns a canonical detached output and bounded deterministic progress", async () => {
    const events: LibraryScanProgress[] = [];
    const mutable = output();
    const seenRequests: LibraryScanRequest[] = [];
    const capability = createLibraryScanCapability(async (scanRequest, context) => {
      seenRequests.push(scanRequest);
      context.reportProgress();
      await Promise.resolve();
      context.reportProgress();
      return { output: mutable, sources: [] };
    });

    const result = await scanAgentContext(request(), capability, {
      onProgress: (event) => events.push(event),
    });
    (
      mutable.profileVersions as Record<
        string,
        { clientVersion: string | null; profileVersion: string }
      >
    )["codex-cli"] = {
      clientVersion: "mutated",
      profileVersion: "9.9.9",
    };

    expect(result).toEqual(output());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics.diagnostics)).toBe(true);
    expect(seenRequests[0]).toEqual(request({ targetPaths: [path("src/a.ts"), path("src/z.ts")] }));
    expect(Object.isFrozen(seenRequests[0])).toBe(true);
    expect(Object.isFrozen(seenRequests[0]?.targetPaths)).toBe(true);
    expect(events).toEqual([
      {
        completedUnits: 0,
        contractVersion: LIBRARY_API_CONTRACT_VERSION,
        progressUnits: 2,
        recordKind: LIBRARY_PROGRESS_KIND,
        sequence: 0,
        state: "started",
      },
      {
        completedUnits: 1,
        contractVersion: LIBRARY_API_CONTRACT_VERSION,
        progressUnits: 2,
        recordKind: LIBRARY_PROGRESS_KIND,
        sequence: 1,
        state: "running",
      },
      {
        completedUnits: 2,
        contractVersion: LIBRARY_API_CONTRACT_VERSION,
        progressUnits: 2,
        recordKind: LIBRARY_PROGRESS_KIND,
        sequence: 2,
        state: "running",
      },
      {
        completedUnits: 2,
        contractVersion: LIBRARY_API_CONTRACT_VERSION,
        progressUnits: 2,
        recordKind: LIBRARY_PROGRESS_KIND,
        sequence: 3,
        state: "completed",
      },
    ]);
    expect(events.every(Object.isFrozen)).toBe(true);
  });

  test("makes progress and results byte-identical across scheduling orders", async () => {
    const run = async (delays: readonly number[]): Promise<string> => {
      const events: LibraryScanProgress[] = [];
      const capability = createLibraryScanCapability(async (_scanRequest, context) => {
        await Promise.all(
          delays.map(
            (delay) =>
              new Promise<void>((resolve) => {
                setTimeout(() => {
                  context.reportProgress();
                  resolve();
                }, delay);
              }),
          ),
        );
        return { output: output(), sources: [] };
      });
      const result = await scanAgentContext(request({ progressUnits: 3 }), capability, {
        onProgress: (event) => events.push(event),
      });
      return JSON.stringify({ events, result });
    };

    expect(await run([9, 1, 5])).toBe(await run([1, 9, 5]));
  });

  test("propagates mid-scan cancellation and waits for engine cleanup", async () => {
    const controller = new AbortController();
    const events: LibraryScanProgress[] = [];
    let interval: ReturnType<typeof setInterval> | undefined;
    let cleaned = false;
    const capability = createLibraryScanCapability(
      (_scanRequest, { reportProgress, signal }) =>
        new Promise((_resolve, reject) => {
          interval = setInterval(() => undefined, 1_000);
          reportProgress();
          signal.addEventListener(
            "abort",
            () => {
              if (interval !== undefined) clearInterval(interval);
              cleaned = true;
              reject(new Error("repository secret must not escape"));
            },
            { once: true },
          );
        }),
    );
    const running = scanAgentContext(request(), capability, {
      onProgress: (event) => events.push(event),
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(events).toHaveLength(2);
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort("hostile cancellation reason");

    const error = await captureError(running);
    expect(error).toMatchObject({
      category: "cancellation",
      code: LibraryApiErrorCode.cancelled,
      message: "the library scan was cancelled",
      retryable: true,
    });
    expect(cleaned).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(JSON.stringify(error)).not.toContain("hostile");
  });

  test("rejects pre-cancellation without invoking the engine or installing listeners", async () => {
    const controller = new AbortController();
    controller.abort(new Error("do not reflect"));
    const executor = vi.fn(() => Promise.resolve({ output: output(), sources: [] }));
    const capability = createLibraryScanCapability(executor);

    const error = await captureError(
      scanAgentContext(request({ progressUnits: 0 }), capability, {
        signal: controller.signal,
      }),
    );

    expect(isLibraryApiError(error)).toBe(true);
    expect(error).toMatchObject({ code: LibraryApiErrorCode.cancelled });
    expect(executor).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("brands only genuine same-process operational errors", async () => {
    const error = await captureError(scanAgentContext(request(), {}));

    expect(isLibraryApiError(error)).toBe(true);
    expect(isLibraryApiError(null)).toBe(false);
    expect(isLibraryApiError(() => undefined)).toBe(false);
    expect(isLibraryApiError({ ...(error as object) })).toBe(false);
    expect(isLibraryApiError(new Proxy(error as object, {}))).toBe(false);
  });

  test("uses the intrinsic native signal state rather than an own hostile getter", async () => {
    const controller = new AbortController();
    const ownGetter = vi.fn(() => false);
    Object.defineProperty(controller.signal, "aborted", { get: ownGetter });

    await expect(
      scanAgentContext(request(), successCapability(), { signal: controller.signal }),
    ).resolves.toEqual(output());
    expect(ownGetter).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("rejects forged, cloned, proxied, and callback-proxy capabilities", async () => {
    const capability = successCapability();
    const forged = {
      contractVersion: LIBRARY_API_CONTRACT_VERSION,
      recordKind: LIBRARY_SCAN_CAPABILITY_KIND,
    };

    expect(isIssuedLibraryScanCapability(capability)).toBe(true);
    expect(isIssuedLibraryScanCapability(structuredClone(capability))).toBe(false);
    expect(isIssuedLibraryScanCapability(new Proxy(capability, {}))).toBe(false);
    for (const candidate of [forged, structuredClone(capability), new Proxy(capability, {})]) {
      const error = await captureError(scanAgentContext(request(), candidate));
      expect(error).toMatchObject({ code: LibraryApiErrorCode.invalidCapability });
    }
    expect(() =>
      createLibraryScanCapability(
        new Proxy(() => Promise.resolve({ output: output(), sources: [] }), {}),
      ),
    ).toThrow(expect.objectContaining({ code: LibraryApiErrorCode.invalidCapability }));
  });

  test("rejects hostile request containers without invoking proxy traps or accessors", async () => {
    const trap = vi.fn(() => {
      throw new Error("trap");
    });
    const proxy = new Proxy(request(), {
      get: trap,
      getOwnPropertyDescriptor: trap,
      ownKeys: trap,
    });
    const accessor = { ...request() };
    Object.defineProperty(accessor, "repositoryRoot", {
      enumerable: true,
      get: trap,
    });
    const revoked = Proxy.revocable(request(), {});
    revoked.revoke();

    for (const candidate of [proxy, accessor, revoked.proxy]) {
      const error = await captureError(scanAgentContext(candidate, successCapability()));
      expect(error).toMatchObject({ code: LibraryApiErrorCode.invalidInput });
    }
    expect(trap).not.toHaveBeenCalled();
  });

  test.each([
    ["unknown request field", { ...request(), unexpected: true }, LibraryApiErrorCode.invalidInput],
    [
      "bad version",
      request({ contractVersion: "2.0.0" as "1.0.0" }),
      LibraryApiErrorCode.invalidInput,
    ],
    [
      "non-file root",
      request({ repositoryRoot: "https://example.test/repo" }),
      LibraryApiErrorCode.invalidInput,
    ],
    ["empty root", request({ repositoryRoot: "" }), LibraryApiErrorCode.invalidInput],
    ["malformed root", request({ repositoryRoot: "not a URL" }), LibraryApiErrorCode.invalidInput],
    [
      "oversized root",
      request({ repositoryRoot: `file:///${"a".repeat(16_385)}` }),
      LibraryApiErrorCode.resourceLimit,
    ],
    [
      "noncanonical root",
      request({ repositoryRoot: "file:///repo/../project/" }),
      LibraryApiErrorCode.invalidInput,
    ],
    ["empty profiles", request({ profileIds: [] }), LibraryApiErrorCode.invalidInput],
    [
      "duplicate profile",
      request({ profileIds: ["codex-cli", "codex-cli"] }),
      LibraryApiErrorCode.invalidInput,
    ],
    [
      "unknown profile",
      { ...request(), profileIds: ["unknown"] },
      LibraryApiErrorCode.invalidInput,
    ],
    [
      "duplicate target",
      request({ targetPaths: [path("a"), path("a")] }),
      LibraryApiErrorCode.invalidInput,
    ],
    [
      "invalid target",
      request({ targetPaths: ["../escape" as RepositoryRelativePath] }),
      LibraryApiErrorCode.invalidInput,
    ],
    ["negative units", request({ progressUnits: -1 }), LibraryApiErrorCode.invalidInput],
    ["excess units", request({ progressUnits: 100_001 }), LibraryApiErrorCode.resourceLimit],
  ])("rejects %s", async (_label, candidate, code) => {
    const error = await captureError(scanAgentContext(candidate, successCapability()));
    expect(error).toMatchObject({ code });
  });

  test("rejects sparse, extended, accessor, and oversized arrays", async () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = "codex-cli";
    const extended = ["codex-cli"];
    Object.defineProperty(extended, "extra", { enumerable: true, value: true });
    const accessor = ["codex-cli"];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => "codex-cli" });
    const oversized = Array.from({ length: 9 }, () => "codex-cli");

    for (const profileIds of [sparse, extended, accessor]) {
      const error = await captureError(
        scanAgentContext({ ...request(), profileIds }, successCapability()),
      );
      expect(error).toMatchObject({ code: LibraryApiErrorCode.invalidInput });
    }
    const limitError = await captureError(
      scanAgentContext({ ...request(), profileIds: oversized }, successCapability()),
    );
    expect(limitError).toMatchObject({ code: LibraryApiErrorCode.resourceLimit });
  });

  test("rejects forged signals, option accessors, proxy observers, and option proxies", async () => {
    const trap = vi.fn(() => {
      throw new Error("trap");
    });
    const accessor = Object.defineProperty({}, "signal", { enumerable: true, get: trap });
    const proxyOptions = new Proxy({}, { ownKeys: trap });
    const cases = [
      { signal: { aborted: false } as AbortSignal },
      { signal: Object.create(AbortSignal.prototype) as AbortSignal },
      accessor,
      { onProgress: new Proxy(() => undefined, {}) },
      proxyOptions,
      { unknown: true },
    ];
    for (const options of cases) {
      const error = await captureError(
        Reflect.apply(scanAgentContext, undefined, [
          request(),
          successCapability(),
          options,
        ]) as Promise<unknown>,
      );
      expect(error).toMatchObject({ code: LibraryApiErrorCode.invalidOptions });
    }
    expect(trap).not.toHaveBeenCalled();
  });

  test("accepts explicit undefined options and rejects exotic request records", async () => {
    await expect(
      scanAgentContext(request(), successCapability(), {
        onProgress: undefined,
        signal: undefined,
      }),
    ).resolves.toEqual(output());
    const exotic = Object.assign(Object.create({ inherited: true }) as object, request());
    const error = await captureError(scanAgentContext(exotic, successCapability()));
    expect(error).toMatchObject({ code: LibraryApiErrorCode.invalidInput });
  });

  test.each([
    [
      "synchronous engine throw",
      (): LibraryScanCapability =>
        createLibraryScanCapability(() => {
          throw new Error("SECRET");
        }),
    ],
    [
      "rejected engine",
      (): LibraryScanCapability =>
        createLibraryScanCapability(() => Promise.reject(new Error("SECRET"))),
    ],
    [
      "non-promise engine",
      (): LibraryScanCapability =>
        createLibraryScanCapability((() => ({ output: output(), sources: [] })) as unknown as (
          request: LibraryScanRequest,
          context: LibraryScanExecutionContext,
        ) => Promise<LibraryScanExecutionResult>),
    ],
  ])("sanitizes %s", async (_label, makeCapability) => {
    const error = await captureError(scanAgentContext(request(), makeCapability()));
    expect(error).toMatchObject({
      code: LibraryApiErrorCode.engineFailed,
      message: "the library scan engine failed",
    });
    expect(String(error)).not.toContain("SECRET");
  });

  test("uses the intrinsic promise continuation without invoking an own then accessor", async () => {
    const trap = vi.fn(() => {
      throw new Error("SECRET then accessor");
    });
    const capability = createLibraryScanCapability((_request, context) => {
      context.reportProgress();
      context.reportProgress();
      const pending = Promise.resolve({ output: output(), sources: [] });
      void Object.defineProperty(pending, "then", { get: trap });
      return pending;
    });

    await expect(scanAgentContext(request(), capability)).resolves.toEqual(output());
    expect(trap).not.toHaveBeenCalled();
  });

  test("sanitizes invalid engine outputs, including proxies and unknown fields", async () => {
    const trap = vi.fn(() => {
      throw new Error("SECRET");
    });
    const invalidOutputs = [
      { output: { ...output(), extra: "SECRET" }, sources: [] },
      { output: output(), sources: new Proxy([], { get: trap, ownKeys: trap }) },
      new Proxy({ output: output(), sources: [] }, { ownKeys: trap }),
      { output: output(), sources: [], extra: true },
    ];
    for (const invalid of invalidOutputs) {
      const capability = createLibraryScanCapability((_request, context) => {
        context.reportProgress();
        context.reportProgress();
        return Promise.resolve(invalid as LibraryScanExecutionResult);
      });
      const error = await captureError(scanAgentContext(request(), capability));
      expect(error).toMatchObject({
        code: LibraryApiErrorCode.invalidResult,
        message: "the library scan engine returned an invalid result",
      });
    }
    expect(trap).not.toHaveBeenCalled();
  });

  test("fails closed on progress underflow, overflow, throws, and asynchronous observers", async () => {
    const underflow = createLibraryScanCapability((_request, context) => {
      context.reportProgress();
      return Promise.resolve({ output: output(), sources: [] });
    });
    const overflow = createLibraryScanCapability((_request, context) => {
      context.reportProgress();
      context.reportProgress();
      context.reportProgress();
      context.reportProgress();
      return Promise.resolve({ output: output(), sources: [] });
    });
    const progressThrow = successCapability();

    expect(await captureError(scanAgentContext(request(), underflow))).toMatchObject({
      code: LibraryApiErrorCode.invalidResult,
    });
    expect(await captureError(scanAgentContext(request(), overflow))).toMatchObject({
      code: LibraryApiErrorCode.resourceLimit,
    });
    expect(
      await captureError(
        scanAgentContext(request(), progressThrow, {
          onProgress: () => {
            throw new Error("SECRET");
          },
        }),
      ),
    ).toMatchObject({ code: LibraryApiErrorCode.progressFailed });
    expect(
      await captureError(
        scanAgentContext(request(), progressThrow, {
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- hostile async observer.
          onProgress: () => Promise.reject(new Error("SECRET")),
        }),
      ),
    ).toMatchObject({ code: LibraryApiErrorCode.progressFailed });
    const hostilePromise = Promise.resolve();
    const catchTrap = vi.fn(() => {
      throw new Error("SECRET catch accessor");
    });
    void Object.defineProperty(hostilePromise, "catch", { get: catchTrap });
    expect(
      await captureError(
        scanAgentContext(request(), progressThrow, {
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- hostile async observer.
          onProgress: () => hostilePromise,
        }),
      ),
    ).toMatchObject({ code: LibraryApiErrorCode.progressFailed });
    expect(catchTrap).not.toHaveBeenCalled();
  });

  test("lets cancellation from the completed observer win before publishing a result", async () => {
    const controller = new AbortController();
    const error = await captureError(
      scanAgentContext(request(), successCapability(), {
        onProgress: (progress) => {
          if (progress.state === "completed") controller.abort();
        },
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({ code: LibraryApiErrorCode.cancelled });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("ignores progress retained by an engine after its promise settles", async () => {
    const events: LibraryScanProgress[] = [];
    let retainedReport = (): void => undefined;
    const capability = createLibraryScanCapability((_request, context) => {
      retainedReport = context.reportProgress;
      context.reportProgress();
      context.reportProgress();
      return Promise.resolve({ output: output(), sources: [] });
    });

    await scanAgentContext(request(), capability, {
      onProgress: (progress) => {
        events.push(progress);
      },
    });
    retainedReport();

    expect(events.map((event) => event.state)).toEqual([
      "started",
      "running",
      "running",
      "completed",
    ]);
  });

  test("uses captured abort-controller intrinsics after host prototype mutation", async () => {
    const abort = vi.spyOn(AbortController.prototype, "abort").mockImplementation(() => {
      throw new Error("host mutation");
    });

    await expect(scanAgentContext(request(), successCapability())).resolves.toEqual(output());
    expect(abort).not.toHaveBeenCalled();
    abort.mockRestore();
  });

  test("does not touch process exit state or global process handlers", async () => {
    const exitCode = process.exitCode;
    const signals = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"] as const;
    const counts = signals.map((event) => process.listenerCount(event));
    const exit = vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("process.exit must not be called");
    });

    await scanAgentContext(request(), successCapability());

    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
    expect(signals.map((event) => process.listenerCount(event))).toEqual(counts);
    exit.mockRestore();
  });
});
