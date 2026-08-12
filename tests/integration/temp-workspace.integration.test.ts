import { access } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  createTempWorkspace,
  type FixtureFiles,
  TempWorkspace,
  withTempWorkspace,
} from "../../packages/test-kit/src/workspace.js";

async function pathIsMissing(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return true;
    }
    throw error;
  }
}

describe("temporary workspace fixtures", () => {
  test("creates a sorted fixture tree and cleans it after a successful callback", async () => {
    let root = "";
    const value = await withTempWorkspace(
      {
        "z-last.txt": "last",
        "packages/api/AGENTS.md": "# API rules\n",
      },
      async (workspace) => {
        root = workspace.root;
        expect(await workspace.readText("packages/api/AGENTS.md")).toBe("# API rules\n");
        expect(await workspace.exists("z-last.txt")).toBe(true);
        expect(await workspace.exists("missing.txt")).toBe(false);
        return "complete";
      },
    );

    expect(value).toBe("complete");
    expect(await pathIsMissing(root)).toBe(true);
  });

  test("cleans up after a callback failure", async () => {
    let root = "";
    await expect(
      withTempWorkspace({}, (workspace) => {
        root = workspace.root;
        return Promise.reject(new Error("fixture failure"));
      }),
    ).rejects.toThrow("fixture failure");

    expect(await pathIsMissing(root)).toBe(true);
  });

  test("isolates concurrent workspaces and makes cleanup idempotent", async () => {
    const workspaces = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createTempWorkspace({ "shared.txt": `workspace-${String(index)}` }),
      ),
    );
    try {
      expect(new Set(workspaces.map((workspace) => workspace.root))).toHaveLength(8);
      await expect(
        Promise.all(workspaces.map((workspace) => workspace.readText("shared.txt"))),
      ).resolves.toEqual(Array.from({ length: 8 }, (_, index) => `workspace-${String(index)}`));
    } finally {
      await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
      await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
    }
    await expect(
      Promise.all(workspaces.map((workspace) => pathIsMissing(workspace.root))),
    ).resolves.toEqual(Array.from({ length: 8 }, () => true));
    const firstWorkspace = workspaces[0];
    if (firstWorkspace === undefined) {
      throw new Error("fixture setup did not create a workspace");
    }
    expect(() => firstWorkspace.resolvePath("new.txt")).toThrow(/already been cleaned up/);
    await expect(firstWorkspace.exists("new.txt")).rejects.toThrow(/already been cleaned up/);
  });

  test("rejects traversal and host-dependent separators", async () => {
    const workspace = await createTempWorkspace();
    try {
      expect(() => workspace.resolvePath("../escape.txt")).toThrow(/escapes its root/);
      expect(() => workspace.resolvePath("C:\\escape.txt")).toThrow(/forward slashes/);
    } finally {
      await workspace.cleanup();
    }
  });

  test("rejects malformed workspace construction and fixture maps", async () => {
    expect(() => new TempWorkspace("relative")).toThrow(/root must be absolute/);
    const malformed = { "bad.txt": undefined } as unknown as FixtureFiles;
    await expect(createTempWorkspace(malformed)).rejects.toThrow(/undefined contents/);
  });
});
