import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  CONFIGURATION_FILE_NAME,
  DEFAULT_AGENT_CONTEXT_CONFIGURATION,
} from "../../packages/core/src/index.js";
import { resolveAgentContextConfiguration } from "../../packages/syntax/src/index.js";
import { withTempWorkspace } from "../../packages/test-kit/src/workspace.js";

describe("B07 repository configuration boundary", () => {
  test("reads exactly the root configuration and never searches a parent or home-style location", async () => {
    await withTempWorkspace(
      {
        [CONFIGURATION_FILE_NAME]: "version: 1\ncommands: { packageManager: yarn }\n",
        ".config/agent-context-lint/config.yml": "version: 1\ncommands: { packageManager: bun }\n",
      },
      async (workspace) => {
        await mkdir(workspace.resolvePath("child"));
        const child = await resolveAgentContextConfiguration(workspace.resolvePath("child"));
        expect(child.ok).toBe(true);
        if (!child.ok) throw new Error(JSON.stringify(child.issues));
        expect(child.value).toEqual(DEFAULT_AGENT_CONTEXT_CONFIGURATION);
        expect(child.sources).toEqual([{ kind: "defaults", path: null }]);

        await workspace.write(
          `child/${CONFIGURATION_FILE_NAME}`,
          "version: 1\ncommands: { packageManager: pnpm }\n",
        );
        const explicitRoot = await resolveAgentContextConfiguration(workspace.resolvePath("child"));
        expect(explicitRoot.ok).toBe(true);
        if (!explicitRoot.ok) throw new Error(JSON.stringify(explicitRoot.issues));
        expect(explicitRoot.value.commands.packageManager).toBe("pnpm");
      },
    );
  });

  test("rejects relative, missing, file, and leaf-symlink repository roots", async () => {
    const relative = await resolveAgentContextConfiguration("relative/repository");
    expect(relative).toMatchObject({ ok: false, issues: [{ code: "invalid-repository-root" }] });

    await withTempWorkspace({ "file-root": "not a directory" }, async (workspace) => {
      const missing = await resolveAgentContextConfiguration(workspace.resolvePath("missing"));
      expect(missing).toMatchObject({
        ok: false,
        issues: [{ code: "repository-root-unavailable" }],
      });
      const file = await resolveAgentContextConfiguration(workspace.resolvePath("file-root"));
      expect(file).toMatchObject({ ok: false, issues: [{ code: "invalid-repository-root" }] });
      await mkdir(workspace.resolvePath("real-root"));
      await symlink(
        workspace.resolvePath("real-root"),
        workspace.resolvePath("linked-root"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const linked = await resolveAgentContextConfiguration(workspace.resolvePath("linked-root"));
      expect(linked).toMatchObject({ ok: false, issues: [{ code: "invalid-repository-root" }] });
    });
  });

  test("rejects malformed-Unicode root aliases before filesystem path coercion", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const replacementRoot = workspace.resolvePath("bad\uFFFD");
      await mkdir(replacementRoot);
      await workspace.write(
        `bad\uFFFD/${CONFIGURATION_FILE_NAME}`,
        "version: 1\ncommands: { packageManager: npm }\n",
      );

      for (const malformedUnit of [0xd800, 0xdc00]) {
        const malformedAlias = `${workspace.root}${path.sep}bad${String.fromCharCode(malformedUnit)}`;
        const result = await resolveAgentContextConfiguration(malformedAlias);
        expect(result).toMatchObject({
          ok: false,
          issues: [
            {
              code: "invalid-repository-root",
              message: "repository root must be well-formed Unicode without NUL bytes",
            },
          ],
        });
      }
    });
  });

  test("inspects the selected root leaf before trailing separators can dereference it", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const realRoot = workspace.resolvePath("real-root");
      const linkedRoot = workspace.resolvePath("linked-root");
      await mkdir(realRoot);
      await workspace.write(
        `real-root/${CONFIGURATION_FILE_NAME}`,
        "version: 1\ncommands: { packageManager: npm }\n",
      );
      await symlink(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

      const separators = process.platform === "win32" ? ["\\", "/"] : [path.sep];
      for (const separator of separators) {
        const linked = await resolveAgentContextConfiguration(`${linkedRoot}${separator}`);
        expect(linked).toMatchObject({
          ok: false,
          issues: [{ code: "invalid-repository-root" }],
        });
      }

      const directory = await resolveAgentContextConfiguration(`${realRoot}${path.sep}`);
      expect(directory.ok).toBe(true);
      if (!directory.ok) throw new Error(JSON.stringify(directory.issues));
      expect(directory.value.commands.packageManager).toBe("npm");
    });
  });

  test("resolves a complete conflict matrix with repository and CLI layers", async () => {
    const matrix = [
      { expected: "auto", files: {}, options: undefined },
      {
        expected: "pnpm",
        files: { [CONFIGURATION_FILE_NAME]: "version: 1\ncommands: { packageManager: pnpm }\n" },
        options: undefined,
      },
      {
        expected: "npm",
        files: { [CONFIGURATION_FILE_NAME]: "version: 1\ncommands: { packageManager: pnpm }\n" },
        options: { cliOverrides: { commands: { packageManager: "npm" } } },
      },
      {
        expected: "bun",
        files: {},
        options: { cliOverrides: { commands: { packageManager: "bun" } } },
      },
    ] as const;
    for (const fixture of matrix) {
      await withTempWorkspace(fixture.files, async (workspace) => {
        const result = await resolveAgentContextConfiguration(workspace.root, fixture.options);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(JSON.stringify(result.issues));
        expect(result.value.commands.packageManager).toBe(fixture.expected);
      });
    }
  });
});
