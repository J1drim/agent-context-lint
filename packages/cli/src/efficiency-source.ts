import path from "node:path";

import type { ContextEfficiencyReport } from "@agent-context/efficiency/report";

import { runCommandRouter, type CliInvocation } from "./command-router.js";
import type { EfficiencyCommandRequest, EfficiencyCommandSource } from "./efficiency-command.js";
import { createScanCommandHandlers } from "./scan-command.js";

async function scanReport(
  request: EfficiencyCommandRequest,
  repository: string | null,
  workingDirectory: string,
  environment: "ci" | "local",
): Promise<ContextEfficiencyReport> {
  let report: ContextEfficiencyReport | undefined;
  let operationalError: unknown;
  const argv = [
    "scan",
    ...(repository === null ? [] : [repository]),
    "--format",
    "json",
    "--fail-on",
    "never",
    ...(request.agent === null ? [] : ["--profile", request.agent]),
  ];
  const invocation: CliInvocation = Object.freeze({
    argv: Object.freeze(argv),
    signal: request.signal,
    stderr: Object.freeze({ write: (): void => undefined }),
    stdout: Object.freeze({ write: (): void => undefined }),
  });
  const result = await runCommandRouter(
    invocation,
    createScanCommandHandlers({
      environment,
      now: () => `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
      observeEfficiencyReport: (value) => {
        report = value;
      },
      reportError: (error) => {
        operationalError = error;
      },
      workingDirectory,
    }),
  );
  if (result.exitCode === 130) throw new DOMException("efficiency scan cancelled", "AbortError");
  if (result.exitCode !== 0 || report === undefined)
    throw operationalError instanceof Error
      ? operationalError
      : new Error("efficiency scan did not produce a report");
  return report;
}

/** Compose G09 with I02's closed, read-only production scanner. */
export function createScanEfficiencySource(options: {
  readonly environment: "ci" | "local";
  readonly workingDirectory: string;
}): EfficiencyCommandSource {
  const workingDirectory = path.resolve(options.workingDirectory);
  return Object.freeze({
    load: async (request: EfficiencyCommandRequest) => {
      const candidate = await scanReport(
        request,
        request.repository,
        workingDirectory,
        options.environment,
      );
      if (request.comparePath === null) return candidate;
      const baseline = await scanReport(
        request,
        request.comparePath,
        workingDirectory,
        options.environment,
      );
      return Object.freeze({ baseline, candidate });
    },
  });
}
