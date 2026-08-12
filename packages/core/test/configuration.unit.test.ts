import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { describe, expect, test } from "vitest";

import {
  CONFIGURATION_FILE_NAME,
  CONFIGURATION_PROFILE_IDS,
  CONFIGURATION_PROFILE_KEYS,
  CONFIGURATION_RULE_SEVERITIES,
  CONFIGURATION_SOURCE_LIMITS,
  CONFIGURATION_SURFACE_IDS,
  CONFIGURATION_SURFACES_BY_PROFILE,
  CONFIGURATION_UNKNOWN_KEY_POLICY,
  CONFIGURATION_VALUE_LIMITS,
  DEFAULT_AGENT_CONTEXT_CONFIGURATION,
  EFFICIENCY_COMPONENT_KEYS,
  EFFICIENCY_SCORE_VERSIONS,
  EFFICIENCY_TOKENIZERS,
  PACKAGE_MANAGERS,
  STANDARDS_CHANNELS,
  appendConfigurationPathProperty,
  validateAgentContextConfiguration,
} from "../src/index.js";
import type { ConfigurationValidationCode, ConfigurationValidationResult } from "../src/index.js";

const SCHEMA = new URL("../schemas/agent-context-lint-config.v1.schema.json", import.meta.url);
const GENERATOR = new URL("../../../scripts/generate-configuration-reference.mjs", import.meta.url);
const REFERENCE = new URL("../../../docs/api/configuration.md", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

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

describe("B06 configuration defaults and vocabulary", () => {
  test("defines complete immutable defaults for every canonical profile and surface", () => {
    const result = validateAgentContextConfiguration({ version: 1 });
    expect(result).toEqual({ issues: [], ok: true, value: DEFAULT_AGENT_CONTEXT_CONFIGURATION });
    expect(CONFIGURATION_FILE_NAME).toBe(".agent-context-lint.yml");
    expect(Object.isFrozen(DEFAULT_AGENT_CONTEXT_CONFIGURATION)).toBe(true);
    for (const profileId of CONFIGURATION_PROFILE_IDS) {
      expect(DEFAULT_AGENT_CONTEXT_CONFIGURATION.profiles[profileId].enabled).toBe(true);
      expect(Object.keys(DEFAULT_AGENT_CONTEXT_CONFIGURATION.profiles[profileId].surfaces)).toEqual(
        CONFIGURATION_SURFACES_BY_PROFILE[profileId],
      );
      expect(Object.isFrozen(CONFIGURATION_SURFACES_BY_PROFILE[profileId])).toBe(true);
    }
  });

  test("freezes every exported vocabulary without allowing defaults to drift", () => {
    const vocabularies: readonly (readonly string[])[] = [
      CONFIGURATION_PROFILE_IDS,
      CONFIGURATION_PROFILE_KEYS,
      CONFIGURATION_RULE_SEVERITIES,
      CONFIGURATION_SURFACE_IDS,
      CONFIGURATION_UNKNOWN_KEY_POLICY.ruleOptionKeys,
      EFFICIENCY_COMPONENT_KEYS,
      EFFICIENCY_SCORE_VERSIONS,
      EFFICIENCY_TOKENIZERS,
      PACKAGE_MANAGERS,
      STANDARDS_CHANNELS,
      ...Object.values(CONFIGURATION_SURFACES_BY_PROFILE),
    ];
    const expectedCursorSurfaces = Object.keys(
      DEFAULT_AGENT_CONTEXT_CONFIGURATION.profiles["cursor-agent"].surfaces,
    );
    expect(Object.isFrozen(CONFIGURATION_SURFACES_BY_PROFILE)).toBe(true);
    for (const vocabulary of vocabularies) {
      expect(Object.isFrozen(vocabulary)).toBe(true);
      expect(() => (vocabulary as unknown as string[]).pop()).toThrow(TypeError);
    }
    expect(
      Object.keys(DEFAULT_AGENT_CONTEXT_CONFIGURATION.profiles["cursor-agent"].surfaces),
    ).toEqual(expectedCursorSurfaces);
  });

  test("normalizes object key order and rule order deterministically", () => {
    const first = validateAgentContextConfiguration({
      version: 1,
      rules: { ACL999: "off", ACL001: "info" },
      commands: { packageManager: "bun" },
    });
    const second = validateAgentContextConfiguration({
      commands: { packageManager: "bun" },
      rules: { ACL001: "info", ACL999: "off" },
      version: 1,
    });
    expect(first).toEqual(second);
    expect(first.ok && Object.keys(first.value.rules)).toEqual(["ACL001", "ACL999"]);
  });
});

describe("closed schema and boundary validation", () => {
  test("encodes literal dangerous keys without ambiguous paths or prototype pollution", () => {
    expect(appendConfigurationPathProperty("$", "profiles")).toBe("$.profiles");
    for (const key of [
      "profiles.codexCli",
      "profiles[codexCli]",
      'profiles["codexCli"]',
      "__proto__",
      "constructor",
    ]) {
      const input = JSON.parse(`{"version":1,${JSON.stringify(key)}:true}`) as unknown;
      const path = `$[${JSON.stringify(key)}]`;
      expectIssue(validateAgentContextConfiguration(input), path, "unknown-field");
    }
    expect(Object.prototype).not.toHaveProperty("configurationPolluted");
    const prototypeInput = JSON.parse(
      '{"version":1,"__proto__":{"configurationPolluted":true}}',
    ) as unknown;
    expectIssue(
      validateAgentContextConfiguration(prototypeInput),
      '$["__proto__"]',
      "unknown-field",
    );
    expect(Object.prototype).not.toHaveProperty("configurationPolluted");
    expect({}).not.toHaveProperty("configurationPolluted");
  });

  test.each([
    [{ version: 1, typo: true }, "$.typo", "unknown-field"],
    [{ version: 1, limits: { maxFileByte: 1 } }, "$.limits.maxFileByte", "unknown-field"],
    [{ version: 1, profiles: { unknown: true } }, "$.profiles.unknown", "unknown-field"],
    [
      { version: 1, profiles: { codexCli: { surfaces: { "cursor-agent/ide": true } } } },
      '$.profiles.codexCli.surfaces["cursor-agent/ide"]',
      "unknown-field",
    ],
    [{ version: 1, rules: { BAD001: "error" } }, "$.rules.BAD001", "unknown-field"],
    [
      { version: 1, rules: { ACL001: { severity: "error", undocumented: true } } },
      "$.rules.ACL001.undocumented",
      "unknown-field",
    ],
    [{ rules: {} }, "$.version", "missing-field"],
    [{ version: 2 }, "$.version", "invalid-value"],
    [
      { version: 1, rules: { ACL001: { maxTokens: 1 } } },
      "$.rules.ACL001.severity",
      "missing-field",
    ],
    [{ version: 1, ignore: ["same/**", "same/**"] }, "$.ignore[1]", "invalid-value"],
    [{ version: 1, ignore: ["/absolute/**"] }, "$.ignore[0]", "invalid-value"],
    [{ version: 1, ignore: ["../escape/**"] }, "$.ignore[0]", "invalid-value"],
    [
      { version: 1, standards: { lockfile: "../escape.json" } },
      "$.standards.lockfile",
      "invalid-value",
    ],
  ] as const)("rejects %j", (input, path, code) => {
    expectIssue(validateAgentContextConfiguration(input), path, code);
  });

  test.each([
    ["maxDiagnostics", 1, 100_000],
    ["maxFileBytes", 1_024, 16_777_216],
    ["maxFiles", 1, 1_000_000],
    ["maxImportDepth", 1, 64],
    ["maxImportFanOut", 1, 4_096],
    ["maxTotalBytes", 1_024, 1_073_741_824],
    ["maxTraversalDepth", 1, 1_024],
  ] as const)(
    "accepts both inclusive limits and rejects adjacent values for %s",
    (key, min, max) => {
      expect(validateAgentContextConfiguration({ version: 1, limits: { [key]: min } }).ok).toBe(
        true,
      );
      expect(validateAgentContextConfiguration({ version: 1, limits: { [key]: max } }).ok).toBe(
        true,
      );
      expectIssue(
        validateAgentContextConfiguration({ version: 1, limits: { [key]: min - 1 } }),
        `$.limits.${key}`,
        "invalid-value",
      );
      expectIssue(
        validateAgentContextConfiguration({ version: 1, limits: { [key]: max + 1 } }),
        `$.limits.${key}`,
        "invalid-value",
      );
    },
  );

  test("bounds rule and ignore collections before normalizing them", () => {
    const rules = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`ACL${String(index).padStart(3, "0")}`, "off"]),
    );
    expectIssue(
      validateAgentContextConfiguration({ version: 1, rules }),
      "$.rules",
      "resource-limit",
    );
    expectIssue(
      validateAgentContextConfiguration({
        version: 1,
        ignore: Array.from({ length: 257 }, (_, i) => `p${String(i)}`),
      }),
      "$.ignore",
      "resource-limit",
    );
  });

  test("validates scoring-version, ordered-grade, and exact-weight relationships", () => {
    expect(
      validateAgentContextConfiguration({
        efficiency: {
          componentWeights: {
            budgetFit: 35,
            crossAgentConsistency: 5,
            instructionDensity: 10,
            nonRedundancy: 20,
            reachability: 10,
            scopePrecision: 20,
          },
          gradeThresholds: { A: 95, B: 85, C: 65, D: 0 },
          scoreVersion: "1.0.0",
        },
        version: 1,
      }).ok,
    ).toBe(true);
    expectIssue(
      validateAgentContextConfiguration({
        efficiency: { gradeThresholds: { A: 90, B: 90 } },
        version: 1,
      }),
      "$.efficiency.gradeThresholds",
      "invalid-value",
    );
    expectIssue(
      validateAgentContextConfiguration({
        efficiency: { componentWeights: { budgetFit: 29 } },
        version: 1,
      }),
      "$.efficiency.componentWeights",
      "invalid-value",
    );
    expectIssue(
      validateAgentContextConfiguration({
        efficiency: { scoreVersion: "2.0.0" },
        version: 1,
      }),
      "$.efficiency.scoreVersion",
      "invalid-value",
    );
  });

  test.each([
    [[], "$"],
    [{ version: 1, profiles: [] }, "$.profiles"],
    [{ version: 1, profiles: { codexCli: 3 } }, "$.profiles.codexCli"],
    [{ version: 1, profiles: { codexCli: { enabled: "yes" } } }, "$.profiles.codexCli.enabled"],
    [{ version: 1, profiles: { codexCli: { surfaces: [] } } }, "$.profiles.codexCli.surfaces"],
    [
      {
        version: 1,
        profiles: { codexCli: { surfaces: { "codex-cli/local-cli-single-cwd": "yes" } } },
      },
      '$.profiles.codexCli.surfaces["codex-cli/local-cli-single-cwd"]',
    ],
    [{ version: 1, rules: [] }, "$.rules"],
    [{ version: 1, rules: { ACL001: "fatal" } }, "$.rules.ACL001"],
    [{ version: 1, rules: { ACL001: null } }, "$.rules.ACL001"],
    [{ version: 1, ignore: {} }, "$.ignore"],
    [{ version: 1, commands: { packageManager: "cargo" } }, "$.commands.packageManager"],
    [{ version: 1, security: { allowAbsolutePaths: "yes" } }, "$.security.allowAbsolutePaths"],
  ] as const)(
    "rejects invalid section forms without returning partial defaults: %j",
    (input, path) => {
      expectIssue(validateAgentContextConfiguration(input), path, "invalid-value");
    },
  );

  test("caps decoded-value issues and does not swallow unexpected locator failures", () => {
    const rules = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`BAD${String(index).padStart(3, "0")}`, "off"]),
    );
    const result = validateAgentContextConfiguration({ version: 1, rules });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.issues).toHaveLength(256);
    expect(result.issues.at(-1)).toMatchObject({ code: "resource-limit", path: "$" });

    expect(() =>
      validateAgentContextConfiguration(
        { version: 2 },
        {
          locate: () => {
            throw new Error("locator failed");
          },
        },
      ),
    ).toThrow("locator failed");
  });
});

describe("hostile decoded values", () => {
  test("rejects proxies, accessors, cycles, sparse arrays, exotic prototypes, symbols, and invalid numbers", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({ version: 1 }, "rules", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });
    const cycle: Record<string, unknown> = { version: 1 };
    cycle["self"] = cycle;
    const sparse = ["ok"];
    sparse.length = 2;
    const hostile: readonly unknown[] = [
      new Proxy({ version: 1 }, {}),
      accessor,
      cycle,
      { version: 1, ignore: sparse },
      Object.assign(Object.create({ inherited: true }) as object, { version: 1 }),
      { version: 1, [Symbol("hidden")]: true },
      { version: 1, limits: { maxFiles: Number.NaN } },
      { version: 1, limits: { maxFiles: -0 } },
      { version: 1, rules: { ACL001: { maxTokens: Number.POSITIVE_INFINITY, severity: "error" } } },
      { version: 1, ignore: ["\ud800"] },
    ];
    for (const input of hostile) expect(validateAgentContextConfiguration(input).ok).toBe(false);
    expect(getterCalls).toBe(0);
  });
});

describe("schema, runtime, documentation, and package alignment", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = readJson(SCHEMA) as AnySchema;
  const validateSchema = ajv.compile(schema);

  test.each([
    { version: 1 },
    { version: 1, profiles: { codexCli: false } },
    { version: 1, rules: { ACL001: "warning" } },
    { version: 1, rules: { ACL999: { maxTokens: 1, severity: "off" } } },
    { version: 1, rules: { ACL999: { maxTokens: null, severity: "off" } } },
    { version: 1, standards: { lockfile: "config/standards.json" } },
    { version: 1, limits: { maxFiles: 1_000_000 } },
    { version: 1, ignore: ["😀".repeat(1_024)] },
  ])("accepts the same valid decoded fixtures: %j", (input) => {
    expect(validateSchema(input)).toBe(true);
    expect(validateAgentContextConfiguration(input).ok).toBe(true);
  });

  test.each([
    {},
    { version: 2 },
    { version: 1, extra: true },
    { version: 1, profiles: { unknown: true } },
    { version: 1, profiles: { "codex-cli": true } },
    { version: 1, rules: { acl001: "warning" } },
    { version: 1, rules: { ACL001: { severity: "warning", typo: true } } },
    { version: 1, limits: { maxFiles: 0 } },
    { version: 1, ignore: ["a", "a"] },
    { version: 1, standards: { lockfile: "." } },
    { version: 1, standards: { lockfile: "a//b" } },
    { version: 1, ignore: ["😀".repeat(1_025)] },
    { version: 1, ignore: ["line\nbreak"] },
    { version: 1, ignore: ["\ud800"] },
    { version: 1, ignore: ["\udc00"] },
    { version: 1, standards: { lockfile: "bad\ud800.json" } },
    { version: 1, standards: { lockfile: "bad\udc00.json" } },
  ])("rejects the same invalid decoded fixtures: %j", (input) => {
    expect(validateSchema(input)).toBe(false);
    expect(validateAgentContextConfiguration(input).ok).toBe(false);
  });

  test("documents the intentional portable-schema and runtime resource-limit differential", () => {
    const ignore = Array.from(
      { length: 65 },
      (_, index) => `${"a".repeat(1_020)}${String(index).padStart(4, "0")}`,
    );
    const input = { ignore, version: 1 };
    expect(validateSchema(input)).toBe(true);
    expectIssue(validateAgentContextConfiguration(input), "$.ignore[63]", "resource-limit");
  });

  test("keeps generated reference documentation current and all limits documented", () => {
    execFileSync(process.execPath, [fileURLToPath(GENERATOR), "--check"], {
      cwd: fileURLToPath(ROOT),
      stdio: "pipe",
    });
    expect(CONFIGURATION_SOURCE_LIMITS).toEqual({
      maximumAliases: 0,
      maximumBytes: 65_536,
      maximumCollectionEntries: 2_048,
      maximumDepth: 32,
      maximumIssues: 256,
      maximumNodes: 4_096,
      maximumScalarBytes: 16_384,
    });
    expect(CONFIGURATION_VALUE_LIMITS).toEqual({
      maximumContainerEntries: 2_048,
      maximumKeyBytes: 256,
      maximumStringBytes: 16_384,
      maximumTotalStringBytes: 65_536,
      maximumValues: 4_096,
    });
    const reference = readFileSync(REFERENCE, "utf8");
    for (const key of Object.keys(CONFIGURATION_VALUE_LIMITS)) {
      expect(reference).toContain(`\`${key}\``);
    }
    expect(reference).toContain("cannot be expressed portably in JSON Schema");
  });
});
