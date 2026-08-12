#!/usr/bin/env node

import process from "node:process";

import { createNodeWritableOutput, runProcessCli } from "./process-cli.js";
import type { CliCommandHandlers, CliCommandName } from "./command-router.js";

const stdout = createNodeWritableOutput(process.stdout);
const stderr = createNodeWritableOutput(process.stderr);
const command = process.argv[2];
const i03Commands = new Set<CliCommandName>(["explain", "init", "list", "rules"]);
// Keep the initial map empty so root/command help reports only handlers that were actually
// loaded.  The selected command is imported below before dispatch; a failed lazy import must
// remain unavailable rather than being represented by a marker that makes help claim success.
let handlers: CliCommandHandlers = Object.freeze({});
if (command === "scan") {
  try {
    handlers = Object.freeze({
      ...handlers,
      ...(await import("./scan-command.js")).createScanCommandHandlers({
        createGitMetadataExecutor: async (selection, signal) =>
          (await import("./git-metadata-executor-production.js")).createNodeGitMetadataExecutor(
            selection,
            { signal },
          ),
        environment: process.env["CI"] === undefined ? "local" : "ci",
        now: () => `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
        workingDirectory: process.cwd(),
      }),
    });
  } catch {
    // Leave the map empty so dispatch and help both report the lazy composition failure safely.
  }
} else if (command === "efficiency") {
  try {
    const [{ createEfficiencyCommandHandlers }, { createScanEfficiencySource }] = await Promise.all(
      [import("./efficiency-command.js"), import("./efficiency-source.js")],
    );
    handlers = Object.freeze({
      ...handlers,
      ...createEfficiencyCommandHandlers({
        source: createScanEfficiencySource({
          environment: process.env["CI"] === undefined ? "local" : "ci",
          workingDirectory: process.cwd(),
        }),
      }),
    });
  } catch {
    // Leave the map empty so dispatch and help both report the lazy composition failure safely.
  }
} else if (i03Commands.has(command as CliCommandName)) {
  try {
    handlers = Object.freeze({
      ...handlers,
      ...(await import("./i03-commands.js")).createI03CommandHandlers({
        workingDirectory: process.cwd(),
      }),
    });
  } catch {
    // Leave the map empty so dispatch and help both report the lazy composition failure safely.
  }
} else if (command === "standards") {
  try {
    handlers = Object.freeze({
      ...handlers,
      ...(await import("./standards-command.js")).createStandardsCommandHandlers({
        workingDirectory: process.cwd(),
      }),
    });
  } catch {
    // Leave the map empty so dispatch and help both report the lazy composition failure safely.
  }
}

await runProcessCli(
  {
    argv: process.argv.slice(2),
    setExitCode: (exitCode): void => {
      process.exitCode = exitCode;
    },
    sigint: {
      addListener: (listener): void => {
        process.on("SIGINT", listener);
      },
      removeListener: (listener): void => {
        process.off("SIGINT", listener);
      },
    },
    stderr,
    stdout,
  },
  handlers,
);
