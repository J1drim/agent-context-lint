import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { CONFIGURATION_FILE_NAME } from "../../packages/core/src/index.js";
import { selectRepositoryRoot } from "../../packages/evidence/src/index.js";
import { resolveAgentContextConfiguration } from "../../packages/syntax/src/index.js";
import { withTempWorkspace } from "../../packages/test-kit/src/workspace.js";

const execFileAsync = promisify(execFile);

async function runGit(workingDirectory: string, arguments_: readonly string[]): Promise<void> {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  await execFileAsync(
    "git",
    ["-c", `core.hooksPath=${nullDevice}`, "-c", "credential.helper=", ...arguments_],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: workingDirectory,
        PATH: process.env["PATH"] ?? "",
        XDG_CONFIG_HOME: workingDirectory,
      },
      timeout: 10_000,
      windowsHide: true,
    },
  );
}

describe("C01 real repository-root matrix", () => {
  test("selects the nearest of two real nested Git repositories", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const outer = workspace.resolvePath("outer");
      const nested = workspace.resolvePath("outer/packages/nested");
      const start = workspace.resolvePath("outer/packages/nested/src");
      await mkdir(start, { recursive: true });
      await runGit(outer, ["init", "--initial-branch=main"]);
      await runGit(nested, ["init", "--initial-branch=main"]);

      const selected = await selectRepositoryRoot(start, { ceiling: outer });
      expect(selected).toMatchObject({ inspectedAncestors: 1, reason: "git-directory" });
      expect(selected.root).toBe(await realpath(nested));
    });
  });

  test("recognizes a real linked worktree without invoking Git during selection", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const main = workspace.resolvePath("main");
      const linked = workspace.resolvePath("linked worktree");
      await mkdir(main);
      await runGit(main, ["init", "--initial-branch=main"]);
      await writeFile(path.join(main, "tracked.txt"), "fixture\n");
      await runGit(main, ["add", "--", "tracked.txt"]);
      await runGit(main, [
        "-c",
        "user.name=Fixture Author",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture commit",
      ]);
      await runGit(main, ["worktree", "add", "--detach", "--", linked, "HEAD"]);
      await mkdir(path.join(linked, "src"));

      const selected = await selectRepositoryRoot(path.join(linked, "src"), { ceiling: linked });
      expect(selected.reason).toBe("git-worktree-file");
      expect(selected.root).toBe(await realpath(linked));
      expect(selected.gitDirectory).toContain(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    });
  });

  test("hands the selected worktree root to B07 without parent or global configuration", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const main = workspace.resolvePath("main");
      const linked = workspace.resolvePath("linked");
      await mkdir(main);
      await runGit(main, ["init", "--initial-branch=main"]);
      await writeFile(path.join(main, "tracked.txt"), "fixture\n");
      await runGit(main, ["add", "--", "tracked.txt"]);
      await runGit(main, [
        "-c",
        "user.name=Fixture Author",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture commit",
      ]);
      await runGit(main, ["worktree", "add", "--detach", "--", linked, "HEAD"]);
      await mkdir(path.join(linked, "src"));
      await writeFile(
        path.join(main, CONFIGURATION_FILE_NAME),
        "version: 1\ncommands: { packageManager: yarn }\n",
      );
      await writeFile(
        path.join(linked, CONFIGURATION_FILE_NAME),
        "version: 1\ncommands: { packageManager: pnpm }\n",
      );

      const selected = await selectRepositoryRoot(path.join(linked, "src"), { ceiling: linked });
      const configuration = await resolveAgentContextConfiguration(selected.root);
      expect(configuration.ok).toBe(true);
      if (!configuration.ok) throw new Error(JSON.stringify(configuration.issues));
      expect(configuration.value.commands.packageManager).toBe("pnpm");
      expect(configuration.sources).toContainEqual({
        kind: "repository",
        path: CONFIGURATION_FILE_NAME,
      });
    });
  });

  test("returns the exact selected directory for explicit and bounded non-Git inputs", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("plain/child"), { recursive: true });
      const explicit = await selectRepositoryRoot(workspace.resolvePath("plain/child"), {
        mode: "explicit",
      });
      const discovered = await selectRepositoryRoot(workspace.resolvePath("plain/child"), {
        ceiling: workspace.resolvePath("plain"),
      });
      expect(explicit.reason).toBe("explicit-path");
      expect(discovered.reason).toBe("non-git-directory");
      expect(explicit.root).toBe(discovered.root);
      expect(discovered.searchBoundary).toBe("ceiling");
    });
  });
});
