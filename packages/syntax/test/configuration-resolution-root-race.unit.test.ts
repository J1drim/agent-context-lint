import { mkdir } from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";

import { CONFIGURATION_FILE_NAME } from "@agent-context/core";
import { withTempWorkspace } from "@agent-context/test-kit";
import { afterEach, describe, expect, test, vi } from "vitest";

const race = vi.hoisted(() => ({
  lstatCalls: new Map<string, number>(),
  lstatReplacement: undefined as
    { readonly atCall: number; readonly root: string; readonly statusFrom: string } | undefined,
  realpathRedirect: undefined as { readonly from: string; readonly to: string } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (
      filePath: string,
      options?: { readonly bigint?: boolean },
    ): Promise<BigIntStats | Stats> => {
      const calls = (race.lstatCalls.get(filePath) ?? 0) + 1;
      race.lstatCalls.set(filePath, calls);
      const replacement = race.lstatReplacement;
      const inspectedPath =
        replacement?.root === filePath && replacement.atCall === calls
          ? replacement.statusFrom
          : filePath;
      return options?.bigint === true
        ? actual.lstat(inspectedPath, { bigint: true })
        : actual.lstat(inspectedPath);
    },
    realpath: async (filePath: string): Promise<string> => {
      const redirect = race.realpathRedirect;
      return actual.realpath(redirect?.from === filePath ? redirect.to : filePath);
    },
  };
});

const { resolveAgentContextConfiguration } = await import("../src/index.js");

afterEach(() => {
  race.lstatCalls.clear();
  race.lstatReplacement = undefined;
  race.realpathRedirect = undefined;
});

describe("B07 repository-root race rejection", () => {
  test("identity-checks the realpath result against the initially selected root", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("selected"));
      await mkdir(workspace.resolvePath("replacement"));
      race.realpathRedirect = {
        from: workspace.resolvePath("selected"),
        to: workspace.resolvePath("replacement"),
      };

      const result = await resolveAgentContextConfiguration(workspace.resolvePath("selected"));
      expect(result).toMatchObject({
        issues: [{ code: "repository-root-changed", source: "repository" }],
        ok: false,
      });
    });
  });

  test.each([
    ["absent", {}],
    ["read", { [CONFIGURATION_FILE_NAME]: "version: 1\n" }],
  ] as const)("rechecks root identity after an %s configuration outcome", async (_name, files) => {
    await withTempWorkspace(files, async (workspace) => {
      await mkdir(workspace.resolvePath("replacement"));
      race.lstatReplacement = {
        atCall: 2,
        root: workspace.root,
        statusFrom: workspace.resolvePath("replacement"),
      };

      const result = await resolveAgentContextConfiguration(workspace.root);
      expect(result).toMatchObject({
        issues: [{ code: "repository-root-changed", source: "repository" }],
        ok: false,
      });
    });
  });
});
