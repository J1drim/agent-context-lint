import { readFileSync } from "node:fs";

import {
  CONFIGURATION_SOURCE_LIMITS,
  DEFAULT_AGENT_CONTEXT_CONFIGURATION,
} from "@agent-context/core";
import type {
  ConfigurationValidationCode,
  ConfigurationValidationResult,
  RepositoryRelativePath,
} from "@agent-context/core";
import { describe, expect, test } from "vitest";

import { parseAgentContextConfiguration } from "../src/index.js";

const VALID_YAML = new URL("./fixtures/configuration.valid.yml", import.meta.url);

function expectIssue(
  result: ConfigurationValidationResult,
  path: string,
  code?: ConfigurationValidationCode,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected configuration rejection");
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ...(code === undefined ? {} : { code }), path }),
    ]),
  );
}

describe("B06 YAML configuration composition", () => {
  test("parses the complete fixture through syntax and returns the frozen core contract", () => {
    const result = parseAgentContextConfiguration(readFileSync(VALID_YAML, "utf8"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.profiles["claude-code"]).toEqual({
      enabled: false,
      surfaces: { "claude-code/local-session": true },
    });
    expect(result.value.profiles["cursor-agent"].surfaces).toEqual({
      "cursor-agent/cli": false,
      "cursor-agent/ide": true,
    });
    expect(result.value.rules).toEqual({
      ACL001: { maxTokens: null, severity: "error" },
      ACL123: { maxTokens: 4000, severity: "warning" },
    });
    expect(result.value.commands.packageManager).toBe("pnpm");
    expect(result.value.standards.lockfile).toBe("config/standards.lock.json");
    expect(result.value.efficiency.scoreVersion).toBe("1.0.0");
    expect(result.value.efficiency.componentWeights).toEqual({
      budgetFit: 35,
      crossAgentConsistency: 5,
      instructionDensity: 10,
      nonRedundancy: 20,
      reachability: 10,
      scopePrecision: 20,
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.profiles["cursor-agent"].surfaces)).toBe(true);
    expect(parseAgentContextConfiguration("version: 1\n")).toEqual({
      issues: [],
      ok: true,
      value: DEFAULT_AGENT_CONTEXT_CONFIGURATION,
    });
  });

  test("source-locates an unknown key using its key token coordinates", () => {
    const result = parseAgentContextConfiguration("# é\nversion: 1\nunknown: true\n", {
      path: "config/lint.yml" as RepositoryRelativePath,
    });
    expectIssue(result, "$.unknown", "unknown-field");
    if (result.ok) throw new Error("expected rejection");
    const issue = result.issues.find((candidate) => candidate.path === "$.unknown");
    expect(issue?.location?.path).toBe("config/lint.yml");
    expect(issue?.location?.range).toEqual({
      end: { byteOffset: 23, line: 2, utf16Column: 7, utf16Offset: 22 },
      start: { byteOffset: 16, line: 2, utf16Column: 0, utf16Offset: 15 },
    });
  });

  test.each([
    {
      nested: "profiles:\n  codexCli: false\n",
      nestedLines: 2,
      unknownKey: "profiles.codexCli",
    },
    {
      nested: "rules:\n  ACL001:\n    severity: error\n",
      nestedLines: 3,
      unknownKey: "rules.ACL001.severity",
    },
  ])("keeps $unknownKey evidence distinct from nested authority in both orders", (fixture) => {
    const unknownLine = `${fixture.unknownKey}: true\n`;
    for (const [source, expectedLine] of [
      [`version: 1\n${unknownLine}${fixture.nested}`, 1],
      [`version: 1\n${fixture.nested}${unknownLine}`, 1 + fixture.nestedLines],
    ] as const) {
      const result = parseAgentContextConfiguration(source);
      const expectedPath = `$[${JSON.stringify(fixture.unknownKey)}]`;
      expectIssue(result, expectedPath, "unknown-field");
      if (result.ok) throw new Error("expected collision-shaped key rejection");
      const issue = result.issues.find((candidate) => candidate.path === expectedPath);
      expect(issue?.location?.range.start).toMatchObject({ line: expectedLine, utf16Column: 0 });
      expect(issue?.location?.range.end).toMatchObject({
        line: expectedLine,
        utf16Column: fixture.unknownKey.length,
      });
    }
  });

  test.each(["profiles[codexCli]", 'profiles["codexCli"]', "rules.ACL001[severity]"])(
    "encodes and source-locates bracketed or dotted key %s without path ambiguity",
    (key) => {
      const source = `version: 1\n${JSON.stringify(key)}: true\n`;
      const expectedPath = `$[${JSON.stringify(key)}]`;
      const result = parseAgentContextConfiguration(source);
      expectIssue(result, expectedPath, "unknown-field");
      if (result.ok) throw new Error("expected dangerous key rejection");
      const issue = result.issues.find((candidate) => candidate.path === expectedPath);
      expect(issue?.location?.range.start).toMatchObject({ line: 1, utf16Column: 0 });
      expect(issue?.location?.range.end.utf16Column).toBeGreaterThan(key.length);
    },
  );

  test("source-locates prototype-shaped keys without polluting any prototype", () => {
    expect(Object.prototype).not.toHaveProperty("configurationPolluted");
    const source =
      "version: 1\n__proto__: { configurationPolluted: true }\nconstructor:\n  prototype:\n    configurationPolluted: true\n";
    const result = parseAgentContextConfiguration(source);
    expectIssue(result, '$["__proto__"]', "unknown-field");
    expectIssue(result, '$["constructor"]', "unknown-field");
    if (result.ok) throw new Error("expected prototype-shaped key rejection");
    expect(
      result.issues.find((candidate) => candidate.path === '$["__proto__"]')?.location?.range.start,
    ).toMatchObject({ line: 1, utf16Column: 0 });
    expect(
      result.issues.find((candidate) => candidate.path === '$["constructor"]')?.location?.range
        .start,
    ).toMatchObject({ line: 2, utf16Column: 0 });
    expect(Object.prototype).not.toHaveProperty("configurationPolluted");
    expect({}).not.toHaveProperty("configurationPolluted");
  });

  test.each([
    ["version: 1\nversion: 1\n", "duplicate-key"],
    ["version: &v 1\nrules: { ACL001: *v }\n", "alias-forbidden"],
    ["version: !!int 1\n", "alias-forbidden"],
    ["!!str version: 1\n", "alias-forbidden"],
    ["&key version: 1\n", "alias-forbidden"],
    ["&key version: 1\n*key: 2\n", "invalid-yaml"],
    ["defaults: &defaults { version: 1 }\n<<: *defaults\n", "alias-forbidden"],
    ["<<: { version: 1 }\nversion: 1\n", "unknown-field"],
    ["!!merge <<: { version: 1 }\n", "invalid-yaml"],
    ["? [version]\n: 1\n", "invalid-yaml"],
    ["version: [\n", "invalid-yaml"],
    ["version: yes\n", "invalid-value"],
    ["%FOO bar\n---\nversion: 1\n", "invalid-yaml"],
  ] as const)("rejects unsafe or malformed YAML", (yaml, code) => {
    const result = parseAgentContextConfiguration(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.code === code)).toBe(true);
  });

  test("locates missing nested fields through their nearest YAML parent", () => {
    const result = parseAgentContextConfiguration(
      "version: 1\nrules:\n  ACL001:\n    maxTokens: 10\n",
    );
    expectIssue(result, "$.rules.ACL001.severity", "missing-field");
    if (result.ok) throw new Error("expected rejection");
    expect(result.issues[0]?.location?.range.start.line).toBe(3);
  });

  test("source-locates invalid scoring relationships without returning defaults", () => {
    const gradeResult = parseAgentContextConfiguration(
      "version: 1\nefficiency:\n  gradeThresholds:\n    A: 80\n    B: 80\n",
    );
    expectIssue(gradeResult, "$.efficiency.gradeThresholds", "invalid-value");
    if (gradeResult.ok) throw new Error("expected grade relationship rejection");
    expect(gradeResult.issues[0]?.location?.range.start.line).toBe(3);

    const weightResult = parseAgentContextConfiguration(
      "version: 1\nefficiency:\n  componentWeights:\n    budgetFit: 29\n",
    );
    expectIssue(weightResult, "$.efficiency.componentWeights", "invalid-value");
    if (weightResult.ok) throw new Error("expected weight relationship rejection");
    expect(weightResult.issues[0]?.location?.range.start.line).toBe(3);
  });

  test("enforces byte, scalar, collection, node, and depth bounds", () => {
    expectIssue(
      parseAgentContextConfiguration(`version: 1\n#${"é".repeat(32_765)}`),
      "$",
      "resource-limit",
    );
    expectIssue(
      parseAgentContextConfiguration(`version: 1\nignore:\n  - ${"a".repeat(16_385)}\n`),
      "$.ignore[0]",
      "resource-limit",
    );
    expectIssue(
      parseAgentContextConfiguration(`${"k".repeat(1_025)}: 1\nversion: 1\n`),
      "$",
      "invalid-yaml",
    );
    expectIssue(
      parseAgentContextConfiguration(
        `version: 1\nignore: [${Array.from({ length: 2_049 }, () => "x").join(",")}]\n`,
      ),
      "$.ignore",
      "resource-limit",
    );
    let nested = "1";
    for (let depth = 0; depth < 34; depth += 1) nested = `[${nested}]`;
    const depthResult = parseAgentContextConfiguration(`version: 1\nignore: ${nested}\n`);
    expect(depthResult.ok).toBe(false);
    if (!depthResult.ok) {
      expect(depthResult.issues.some((issue) => issue.code === "resource-limit")).toBe(true);
    }

    const nodeBound = `{${Array.from(
      { length: CONFIGURATION_SOURCE_LIMITS.maximumCollectionEntries },
      (_, index) => `k${String(index)}: ${String(index)}`,
    ).join(",")}}`;
    const nodeResult = parseAgentContextConfiguration(nodeBound);
    expect(nodeResult.ok).toBe(false);
    if (!nodeResult.ok) {
      expect(
        nodeResult.issues.some(
          (issue) => issue.code === "resource-limit" && issue.message.includes("YAML nodes"),
        ),
      ).toBe(true);
    }
  });

  test("derives complete preflight ranges for BOM, CRLF, multibyte, and malformed input", () => {
    const malformed = "\ufeffversion: 1\r\n# 😀\r\n#\ud800";
    const malformedResult = parseAgentContextConfiguration(malformed);
    expectIssue(malformedResult, "$", "invalid-value");
    if (malformedResult.ok) throw new Error("expected malformed Unicode rejection");
    expect(malformedResult.issues[0]?.location?.range).toEqual({
      end: {
        byteOffset: Buffer.byteLength(malformed, "utf8"),
        line: 2,
        utf16Column: 2,
        utf16Offset: malformed.length,
      },
      start: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
    });

    const oversized = `\ufeff# é\r\n${"😀".repeat(16_384)}`;
    const oversizedResult = parseAgentContextConfiguration(oversized);
    expectIssue(oversizedResult, "$", "resource-limit");
    if (oversizedResult.ok) throw new Error("expected source byte-limit rejection");
    expect(oversizedResult.issues[0]?.location?.range).toEqual({
      end: {
        byteOffset: Buffer.byteLength(oversized, "utf8"),
        line: 1,
        utf16Column: 32_768,
        utf16Offset: oversized.length,
      },
      start: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
    });
  });

  test("rejects malformed Unicode and invalid explicit source paths", () => {
    expectIssue(parseAgentContextConfiguration("version: 1\n#\ud800"), "$", "invalid-value");
    expectIssue(parseAgentContextConfiguration("version: 1\n#\udc00"), "$", "invalid-value");
    expect(parseAgentContextConfiguration("version: 1\n# 😀\n").ok).toBe(true);
    expectIssue(parseAgentContextConfiguration("null\n"), "$", "invalid-value");
    expectIssue(parseAgentContextConfiguration(""), "$", "invalid-value");
    expect(() =>
      parseAgentContextConfiguration("version: 1\n", {
        path: "../outside.yml" as RepositoryRelativePath,
      }),
    ).toThrow(TypeError);
  });

  test("caps structural issue reporting deterministically", () => {
    const anchored = Array.from(
      { length: 300 },
      (_, index) => `  ACL${String(index).padStart(3, "0")}: &a${String(index)} off`,
    ).join("\n");
    const result = parseAgentContextConfiguration(`version: 1\nrules:\n${anchored}\n`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.issues).toHaveLength(CONFIGURATION_SOURCE_LIMITS.maximumIssues);
    expect(result.issues.at(-1)).toMatchObject({ code: "resource-limit", path: "$" });
  });
});
