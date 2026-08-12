import { mkdir, symlink, writeFile } from "node:fs/promises";

import {
  CONFIGURATION_FILE_NAME,
  CONFIGURATION_SOURCE_LIMITS,
  DEFAULT_AGENT_CONTEXT_CONFIGURATION,
} from "@agent-context/core";
import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test } from "vitest";

import type { ConfigurationResolutionResult } from "../src/index.js";
import {
  isIssuedConfigurationResolutionSuccess,
  resolveAgentContextConfiguration,
} from "../src/index.js";

function expectFailure(result: ConfigurationResolutionResult, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected configuration resolution to fail");
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
}

describe("B07 configuration resolution", () => {
  test("returns only the frozen B06 defaults when repository configuration is missing", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const result = await resolveAgentContextConfiguration(workspace.root);
      expect(result).toEqual({
        issues: [],
        ok: true,
        sources: [{ kind: "defaults", path: null }],
        value: DEFAULT_AGENT_CONTEXT_CONFIGURATION,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.sources)).toBe(true);
      expect(isIssuedConfigurationResolutionSuccess(result)).toBe(true);
      expect(isIssuedConfigurationResolutionSuccess(structuredClone(result))).toBe(false);
    });
  });

  test("applies CLI settings over repository settings over defaults without mutating a layer", async () => {
    const repositorySource = `version: 1
commands:
  packageManager: pnpm
limits:
  maxFiles: 20
  maxDiagnostics: 30
profiles:
  cursorAgent:
    enabled: false
    surfaces:
      cursor-agent/cli: false
rules:
  ACL001:
    severity: warning
    maxTokens: 100
ignore:
  - generated/**
`;
    const cliOverrides = {
      commands: { packageManager: "npm" },
      limits: { maxFiles: 40 },
      profiles: { cursorAgent: { enabled: true } },
      rules: { ACL001: { severity: "error" } },
      ignore: ["vendor/**"],
    };
    await withTempWorkspace({ [CONFIGURATION_FILE_NAME]: repositorySource }, async (workspace) => {
      const result = await resolveAgentContextConfiguration(workspace.root, { cliOverrides });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.sources).toEqual([
        { kind: "defaults", path: null },
        { kind: "repository", path: CONFIGURATION_FILE_NAME },
        { kind: "cli", path: null },
      ]);
      expect(result.value.commands.packageManager).toBe("npm");
      expect(result.value.limits).toMatchObject({ maxDiagnostics: 30, maxFiles: 40 });
      expect(result.value.profiles["cursor-agent"]).toEqual({
        enabled: true,
        surfaces: { "cursor-agent/cli": false, "cursor-agent/ide": true },
      });
      expect(result.value.rules["ACL001"]).toEqual({ maxTokens: 100, severity: "error" });
      expect(result.value.ignore).toEqual(["vendor/**"]);
      expect(result.value.limits.maxFileBytes).toBe(
        DEFAULT_AGENT_CONTEXT_CONFIGURATION.limits.maxFileBytes,
      );
      expect(cliOverrides).toEqual({
        commands: { packageManager: "npm" },
        ignore: ["vendor/**"],
        limits: { maxFiles: 40 },
        profiles: { cursorAgent: { enabled: true } },
        rules: { ACL001: { severity: "error" } },
      });
    });
  });

  test("supports the profile boolean shorthand as a replacing CLI value", async () => {
    await withTempWorkspace(
      {
        [CONFIGURATION_FILE_NAME]:
          "version: 1\nprofiles:\n  cursorAgent:\n    surfaces:\n      cursor-agent/cli: false\n",
      },
      async (workspace) => {
        const result = await resolveAgentContextConfiguration(workspace.root, {
          cliOverrides: { profiles: { cursorAgent: false } },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(JSON.stringify(result.issues));
        expect(result.value.profiles["cursor-agent"]).toEqual({
          enabled: false,
          surfaces: { "cursor-agent/cli": true, "cursor-agent/ide": true },
        });
      },
    );
  });

  test("fails closed on malformed repository YAML and preserves exact source evidence", async () => {
    await withTempWorkspace(
      { [CONFIGURATION_FILE_NAME]: "version: 1\nunknown: true\n" },
      async (workspace) => {
        const result = await resolveAgentContextConfiguration(workspace.root, {
          cliOverrides: { commands: { packageManager: "npm" } },
        });
        expectFailure(result, "unknown-field");
        if (result.ok) throw new Error("expected failure");
        expect(result.sources).toEqual([
          { kind: "defaults", path: null },
          { kind: "repository", path: CONFIGURATION_FILE_NAME },
        ]);
        expect(result.issues[0]).toMatchObject({
          configurationPath: CONFIGURATION_FILE_NAME,
          path: "$.unknown",
          source: "repository",
        });
        expect(result.issues[0]?.location).toMatchObject({
          path: CONFIGURATION_FILE_NAME,
          range: { start: { line: 1, utf16Column: 0 } },
        });
      },
    );
  });

  test.each([
    [{ unknown: true }, "unknown-field", "$.unknown"],
    [{ version: 1 }, "invalid-cli-overrides", "$.version"],
    [{ limits: { maxFiles: 0 } }, "invalid-value", "$.limits.maxFiles"],
    [{ rules: { ACL001: { maxTokens: 5 } } }, "missing-field", "$.rules.ACL001.severity"],
  ] as const)("rejects malformed CLI override %#", async (cliOverrides, code, issuePath) => {
    await withTempWorkspace({}, async (workspace) => {
      const result = await resolveAgentContextConfiguration(workspace.root, { cliOverrides });
      expectFailure(result, code);
      if (!result.ok) {
        expect(result.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: issuePath, source: "cli" })]),
        );
      }
    });
  });

  test("does not invoke option or override accessors and rejects proxies", async () => {
    await withTempWorkspace({}, async (workspace) => {
      let reads = 0;
      const accessorOptions = Object.defineProperty({}, "cliOverrides", {
        enumerable: true,
        get(): unknown {
          reads += 1;
          return {};
        },
      });
      expectFailure(
        await resolveAgentContextConfiguration(workspace.root, accessorOptions),
        "invalid-options",
      );
      expect(reads).toBe(0);

      const proxy = new Proxy(
        {},
        {
          ownKeys: (): (string | symbol)[] => {
            reads += 1;
            return [];
          },
        },
      );
      expectFailure(
        await resolveAgentContextConfiguration(workspace.root, { cliOverrides: proxy }),
        "invalid-cli-overrides",
      );
      expect(reads).toBe(0);

      const nested = Object.defineProperty({}, "packageManager", {
        enumerable: true,
        get(): string {
          reads += 1;
          return "npm";
        },
      });
      expectFailure(
        await resolveAgentContextConfiguration(workspace.root, {
          cliOverrides: { commands: nested },
        }),
        "invalid-cli-overrides",
      );
      expect(reads).toBe(0);

      expect(Object.prototype).not.toHaveProperty("configurationPolluted");
      const prototypeKey = JSON.parse('{"__proto__":{"configurationPolluted":true}}') as unknown;
      expectFailure(
        await resolveAgentContextConfiguration(workspace.root, { cliOverrides: prototypeKey }),
        "unknown-field",
      );
      expect(Object.prototype).not.toHaveProperty("configurationPolluted");
      expect({}).not.toHaveProperty("configurationPolluted");
    });
  });

  test("rejects a deterministic property-negative corpus of non-JSON CLI values", async () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const sparse = new Array(2);
    sparse[1] = "x";
    const symbolObject = { commands: {} } as Record<PropertyKey, unknown>;
    symbolObject[Symbol("secret")] = true;
    const malformedUnicode = `x${String.fromCharCode(0xd800)}`;
    const malformedLowSurrogate = `x${String.fromCharCode(0xdc00)}`;
    const excessiveValues = {
      first: Array.from({ length: 2_048 }, () => null),
      second: Array.from({ length: 2_048 }, () => null),
    };
    let excessiveDepth: unknown = null;
    for (let depth = 0; depth <= 256; depth += 1) excessiveDepth = [excessiveDepth];
    const cases: readonly unknown[] = [
      undefined,
      null,
      [],
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      new Date(0),
      cycle,
      sparse,
      symbolObject,
      { ignore: ["😀/**", malformedUnicode] },
      { ignore: [malformedUnicode] },
      { ignore: [malformedLowSurrogate] },
      { ignore: ["a".repeat(16_385)] },
      { ignore: ["é".repeat(8_193)] },
      excessiveValues,
      excessiveDepth,
      Object.create({ inherited: true }),
    ];
    await withTempWorkspace({}, async (workspace) => {
      for (const cliOverrides of cases) {
        const result = await resolveAgentContextConfiguration(workspace.root, { cliOverrides });
        expectFailure(result, "invalid-cli-overrides");
      }
    });
  });

  test("rejects unsafe configuration entries, oversized bytes, and malformed UTF-8", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath(CONFIGURATION_FILE_NAME));
      expectFailure(
        await resolveAgentContextConfiguration(workspace.root),
        "configuration-file-type",
      );
    });
    await withTempWorkspace({}, async (workspace) => {
      await writeFile(
        workspace.resolvePath(CONFIGURATION_FILE_NAME),
        Buffer.alloc(CONFIGURATION_SOURCE_LIMITS.maximumBytes + 1, 0x20),
      );
      expectFailure(await resolveAgentContextConfiguration(workspace.root), "resource-limit");
    });
    await withTempWorkspace(
      { [CONFIGURATION_FILE_NAME]: Uint8Array.from([0x76, 0x3a, 0x20, 0xff]) },
      async (workspace) => {
        expectFailure(await resolveAgentContextConfiguration(workspace.root), "invalid-value");
      },
    );
  });

  test("rejects configuration symlinks without reading their target", async () => {
    await withTempWorkspace(
      { "outside.yml": "version: 1\ncommands: { packageManager: npm }\n" },
      async (workspace) => {
        await symlink("outside.yml", workspace.resolvePath(CONFIGURATION_FILE_NAME));
        expectFailure(
          await resolveAgentContextConfiguration(workspace.root),
          "configuration-symlink",
        );
      },
    );
  });

  test("returns stable output across repeated resolutions", async () => {
    await withTempWorkspace(
      { [CONFIGURATION_FILE_NAME]: "version: 1\ncommands: { packageManager: pnpm }\n" },
      async (workspace) => {
        const first = await resolveAgentContextConfiguration(workspace.root, {
          cliOverrides: { limits: { maxFiles: 17 } },
        });
        const second = await resolveAgentContextConfiguration(workspace.root, {
          cliOverrides: { limits: { maxFiles: 17 } },
        });
        expect(second).toEqual(first);
      },
    );
  });
});
