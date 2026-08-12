# Embed Agent Context Linter

The ESM-only `@agent-context/lint` package exposes an asynchronous scan boundary for CI services,
editors, language servers, and other long-lived Node.js 24+ hosts. Importing it performs no I/O and
does not install signal handlers or change process exit state.

```ts
import {
  LIBRARY_API_CONTRACT_VERSION,
  LIBRARY_SCAN_REQUEST_KIND,
  LibraryApiErrorCode,
  createLibraryScanCapability,
  scanAgentContext,
} from "@agent-context/lint";

const engine = createLibraryScanCapability(async (request, context) => {
  // Trusted host composition uses the linter's root-jailed built-in scan engine here.
  // Repository data must never supply this callback.
  const { output, sources } = await runBuiltInScan(request, context.signal, () => {
    context.reportProgress();
  });
  return { output, sources };
});

const controller = new AbortController();

try {
  const result = await scanAgentContext(
    {
      contractVersion: LIBRARY_API_CONTRACT_VERSION,
      profileIds: ["codex-cli", "claude-code"],
      progressUnits: 12,
      recordKind: LIBRARY_SCAN_REQUEST_KIND,
      repositoryRoot: "file:///workspace/project/",
      targetPaths: [".", "src/index.ts"],
    },
    engine,
    {
      signal: controller.signal,
      onProgress(progress) {
        renderProgress(progress.completedUnits, progress.progressUnits);
      },
    },
  );
  consumeScanJson(result);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === LibraryApiErrorCode.cancelled) {
    // The engine has finished cancellation cleanup before this branch runs.
  }
}
```

The progress observer must be synchronous. It receives counts, not filenames or completion timing,
so output is stable across worker schedules. Returning a promise or throwing rejects the operation
with a sanitized typed error.

Use the same `AbortSignal` for the operation lifetime. Cancellation stops new progress, propagates to
the engine, and rejects only after engine cleanup. Do not expect arbitrary JavaScript to be forcibly
terminated: a custom engine must cooperate and settle after releasing every resource.

The returned scan object is validated, sanitized, detached from engine memory, and frozen. Treat it
as immutable. CLI exit codes are intentionally absent from the library lifecycle; applications map
the B05 `summary.exitCode` or typed operational errors according to their own host contract.

