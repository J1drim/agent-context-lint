import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import type { ScanJsonOutput } from "../packages/core/dist/index.js";

import {
  LIBRARY_API_CONTRACT_VERSION,
  LIBRARY_PROGRESS_KIND,
  LIBRARY_SCAN_REQUEST_KIND,
  LibraryApiErrorCode,
  createLibraryScanCapability,
  scanAgentContext,
} from "../packages/cli/dist/index.js";

const execFileAsync = promisify(execFile);
const BUILT_LIBRARY_URL = new URL("../packages/cli/dist/index.js", import.meta.url).href;

function emptyOutput(): ScanJsonOutput {
  return {
    diagnostics: {
      contractVersion: "0.1.0",
      diagnostics: [],
      recordKind: "agent-context-diagnostics",
      suppressions: [],
    },
    failureThreshold: "error",
    profileVersions: {
      "codex-cli": { clientVersion: null, profileVersion: "0.1.0" },
    },
    recordKind: "agent-context-scan-output",
    schemaVersion: "1.0.0",
    summary: { errors: 0, exitCode: 0, infos: 0, suppressed: 0, warnings: 0 },
  };
}

describe("E11 built public library", () => {
  test("exports and executes the production facade from built package output", async () => {
    const progress: unknown[] = [];
    const capability = createLibraryScanCapability((_request, context) => {
      context.reportProgress();
      return Promise.resolve({ output: emptyOutput(), sources: [] });
    });

    const result = await scanAgentContext(
      {
        contractVersion: LIBRARY_API_CONTRACT_VERSION,
        profileIds: ["codex-cli"],
        progressUnits: 1,
        recordKind: LIBRARY_SCAN_REQUEST_KIND,
        repositoryRoot: "file:///integration/repository/",
        targetPaths: [],
      },
      capability,
      { onProgress: (event) => progress.push(event) },
    );

    expect(result).toEqual(emptyOutput());
    expect(progress).toHaveLength(3);
    expect(progress).toMatchObject([
      { recordKind: LIBRARY_PROGRESS_KIND, sequence: 0, state: "started" },
      { recordKind: LIBRARY_PROGRESS_KIND, sequence: 1, state: "running" },
      { recordKind: LIBRARY_PROGRESS_KIND, sequence: 2, state: "completed" },
    ]);
  });

  test("an embedded process cancels mid-scan, releases handles, and exits naturally", async () => {
    const script = `
      import { getEventListeners } from "node:events";
      const before = {
        exitCode: process.exitCode ?? null,
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
        uncaught: process.listenerCount("uncaughtException"),
        unhandled: process.listenerCount("unhandledRejection"),
      };
      let exitCalls = 0;
      process.exit = () => { exitCalls += 1; throw new Error("unexpected process.exit"); };
      const api = await import(${JSON.stringify(BUILT_LIBRARY_URL)});
      const controller = new AbortController();
      let cleaned = false;
      let progress = 0;
      const capability = api.createLibraryScanCapability((_request, context) =>
        new Promise((_resolve, reject) => {
          const interval = setInterval(() => undefined, 1000);
          context.signal.addEventListener("abort", () => {
            clearInterval(interval);
            cleaned = true;
            reject(new Error("SECRET repository content"));
          }, { once: true });
          context.reportProgress();
          queueMicrotask(() => controller.abort("SECRET cancellation reason"));
        })
      );
      let error;
      try {
        await api.scanAgentContext({
          contractVersion: api.LIBRARY_API_CONTRACT_VERSION,
          profileIds: ["codex-cli"],
          progressUnits: 2,
          recordKind: api.LIBRARY_SCAN_REQUEST_KIND,
          repositoryRoot: "file:///embedded/repository/",
          targetPaths: [],
        }, capability, {
          onProgress: () => { progress += 1; },
          signal: controller.signal,
        });
      } catch (caught) {
        error = caught;
      }
      const after = {
        exitCode: process.exitCode ?? null,
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
        uncaught: process.listenerCount("uncaughtException"),
        unhandled: process.listenerCount("unhandledRejection"),
      };
      console.log(JSON.stringify({
        after,
        before,
        cleaned,
        code: error?.code,
        errorText: String(error),
        exitCalls,
        progress,
        signalListeners: getEventListeners(controller.signal, "abort").length,
      }));
    `;

    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 3_000,
      },
    );
    const evidence = JSON.parse(stdout) as Record<string, unknown>;

    expect(stderr).toBe("");
    expect(evidence).toEqual({
      after: evidence["before"],
      before: evidence["before"],
      cleaned: true,
      code: LibraryApiErrorCode.cancelled,
      errorText: "LibraryApiError: the library scan was cancelled",
      exitCalls: 0,
      progress: 2,
      signalListeners: 0,
    });
    expect(stdout).not.toContain("SECRET");
  });
});
