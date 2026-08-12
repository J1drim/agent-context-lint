import { readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";

import {
  ORGANIZATION_POLICY_LIMITS,
  ORGANIZATION_POLICY_PACK_SCHEMA_VERSION,
  ORGANIZATION_POLICY_SETTING_IDS,
  classifyOrganizationPolicyTarget,
  resolveOrganizationPolicy,
  validateOrganizationPolicyPack,
} from "../src/index.js";
import type {
  ConfigurationSourceLocation,
  OrganizationPolicyCapabilities,
  OrganizationPolicyIssueCode,
  OrganizationPolicyOverride,
  OrganizationPolicyValidationResult,
  RepositoryRelativePath,
  ResolveOrganizationPolicyOptions,
  ValidateOrganizationPolicyPackOptions,
  ValidatedOrganizationPolicyPack,
} from "../src/index.js";

const SCHEMA = new URL("../schemas/organization-policy-pack.v0.schema.json", import.meta.url);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const CAPABILITIES: OrganizationPolicyCapabilities = Object.freeze({
  engineVersion: "1.4.0",
  ruleIds: Object.freeze(["ACL001", "ACL106"]),
  ruleRegistryVersion: "1.2.0",
});

const LOCATION: ConfigurationSourceLocation = Object.freeze({
  path: ".agent-context-policy.json" as RepositoryRelativePath,
  range: Object.freeze({
    end: Object.freeze({ byteOffset: 9, line: 1, utf16Column: 9, utf16Offset: 9 }),
    start: Object.freeze({ byteOffset: 0, line: 1, utf16Column: 0, utf16Offset: 0 }),
  }),
});

function pack(): Record<string, unknown> {
  return {
    compatibility: {
      configurationVersion: 1,
      minimumEngineVersion: "1.3.0",
      profileCatalogVersion: "0.1.0",
      ruleRegistryVersion: "1.2.0",
    },
    packId: "area.security-policy",
    packVersion: "2.1.0-rc.1+review.4",
    policies: [
      {
        authority: "enforced",
        id: "require.acl001",
        target: { kind: "rule", ruleId: "ACL001" },
        value: { maxTokens: null, severity: "warning" },
      },
      {
        authority: "default",
        id: "default.package-manager",
        target: { kind: "setting", settingId: "commands.packageManager" },
        value: "pnpm",
      },
      {
        authority: "default",
        id: "default.codex-profile",
        target: { kind: "profile", profileId: "codex-cli" },
        value: true,
      },
      {
        authority: "enforced",
        id: "disable.cursor-ide",
        target: {
          kind: "surface",
          profileId: "cursor-agent",
          surfaceId: "cursor-agent/ide",
        },
        value: false,
      },
      {
        authority: "default",
        id: "default.token-budget",
        target: {
          kind: "setting",
          settingId: "efficiency.budgets.alwaysOnTokens",
        },
        value: 2400,
      },
    ],
    provenance: {
      approvedBy: "area.security-council",
      approvedSource: { path: "policy/approved.json", sha256: HASH_B },
      reviewedAt: "2026-08-02",
      revision: "governance.42",
    },
    recordKind: "agent-context-organization-policy-pack",
    schemaVersion: ORGANIZATION_POLICY_PACK_SCHEMA_VERSION,
  };
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
    throw new TypeError(`${key} is not a record`);
  return candidate as Record<string, unknown>;
}

function policiesAt(value: Record<string, unknown>): Record<string, unknown>[] {
  const candidate = value["policies"];
  if (!Array.isArray(candidate)) throw new TypeError("policies is not an array");
  return candidate as Record<string, unknown>[];
}

function policyAt(value: Record<string, unknown>, index: number): Record<string, unknown> {
  const candidate = policiesAt(value).at(index);
  if (candidate === undefined) throw new TypeError("policy is missing");
  return candidate;
}

function revokedProxy<T extends object>(target: T): T {
  const revocable = Proxy.revocable(target, {});
  revocable.revoke();
  return revocable.proxy;
}

function containsString(value: unknown, text: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") return value.includes(text);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) =>
    containsString((value as Record<PropertyKey, unknown>)[key], text, seen),
  );
}

function validate(value: unknown): OrganizationPolicyValidationResult {
  return validateOrganizationPolicyPack(value, {
    capabilities: CAPABILITIES,
    locate: () => LOCATION,
    locateKey: () => LOCATION,
    origin: {
      path: ".agent-context-policy.json" as RepositoryRelativePath,
      sha256: HASH_A,
    },
  });
}

function validatedPack(value: unknown = pack()): ValidatedOrganizationPolicyPack {
  const result = validate(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected a valid organization policy pack");
  return result.value;
}

function expectIssue(
  result: OrganizationPolicyValidationResult,
  code: OrganizationPolicyIssueCode,
  path?: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected organization policy rejection");
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code, ...(path === undefined ? {} : { path }) }),
    ]),
  );
}

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) =>
    isDeeplyFrozen((value as Record<PropertyKey, unknown>)[key]),
  );
}

describe("B11 closed local organization policy contract", () => {
  test("accepts the complete data-only capability set and matches the public schema", () => {
    const value = pack();
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as AnySchema;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    expect(ajv.validate(schema, value), ajv.errorsText()).toBe(true);
    const executable = pack();
    executable["command"] = "npm test";
    expect(ajv.validate(schema, executable)).toBe(false);
    const invalidSetting = pack();
    policyAt(invalidSetting, 1)["value"] = "deno";
    expect(ajv.validate(schema, invalidSetting)).toBe(false);

    const result = validate(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.document.policies.map((policy) => policy.id)).toEqual([
      "default.codex-profile",
      "default.package-manager",
      "default.token-budget",
      "disable.cursor-ide",
      "require.acl001",
    ]);
    expect(result.value.origin).toEqual({
      path: ".agent-context-policy.json",
      sha256: HASH_A,
    });
    expect(isDeeplyFrozen(result)).toBe(true);
    expect(Object.isFrozen(ORGANIZATION_POLICY_LIMITS)).toBe(true);
    expect(Object.isFrozen(ORGANIZATION_POLICY_SETTING_IDS)).toBe(true);

    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      readonly exports: Readonly<Record<string, string>>;
    };
    expect(manifest.exports["./schemas/organization-policy-pack.v0.schema.json"]).toBe(
      "./schemas/organization-policy-pack.v0.schema.json",
    );
  });

  test("classifies only registered rule, profile, surface, and closed setting targets", () => {
    expect(
      classifyOrganizationPolicyTarget({ kind: "rule", ruleId: "ACL106" }, CAPABILITIES),
    ).toEqual({
      key: "rule:ACL106",
      ok: true,
      target: { kind: "rule", ruleId: "ACL106" },
    });
    expect(
      classifyOrganizationPolicyTarget(
        { kind: "surface", profileId: "cursor-agent", surfaceId: "cursor-agent/cli" },
        CAPABILITIES,
      ),
    ).toEqual({
      key: "surface:cursor-agent:cursor-agent/cli",
      ok: true,
      target: {
        kind: "surface",
        profileId: "cursor-agent",
        surfaceId: "cursor-agent/cli",
      },
    });
    const unknownRule = classifyOrganizationPolicyTarget(
      { kind: "rule", ruleId: "ACL999" },
      CAPABILITIES,
    );
    expect(unknownRule.ok).toBe(false);
    if (!unknownRule.ok) {
      expect(unknownRule.issue.code).toBe("unsupported-target");
      expect(isDeeplyFrozen(unknownRule)).toBe(true);
    }
    const unsafeSetting = classifyOrganizationPolicyTarget(
      { kind: "setting", settingId: "security.allowNetworkReferences" },
      CAPABILITIES,
    );
    expect(unsafeSetting.ok).toBe(false);
    if (!unsafeSetting.ok) expect(unsafeSetting.issue.code).toBe("unsupported-target");
    const wrongSurface = classifyOrganizationPolicyTarget(
      { kind: "surface", profileId: "codex-cli", surfaceId: "cursor-agent/cli" },
      CAPABILITIES,
    );
    expect(wrongSurface.ok).toBe(false);
    if (!wrongSurface.ok) expect(wrongSurface.issue.code).toBe("unsupported-target");

    for (const capabilities of [
      { ...CAPABILITIES, engineVersion: "latest" },
      { ...CAPABILITIES, ruleRegistryVersion: "v1" },
      { ...CAPABILITIES, ruleIds: ["bad"] },
      { ...CAPABILITIES, ruleIds: ["ACL001", "ACL001"] },
      { ...CAPABILITIES, ruleIds: "ACL001" as unknown as readonly string[] },
    ]) {
      expect(
        classifyOrganizationPolicyTarget({ kind: "rule", ruleId: "ACL001" }, capabilities).ok,
      ).toBe(false);
    }
  });

  test("classifies hostile targets and capabilities without dereferencing accessors or proxies", () => {
    let calls = 0;
    const target = Object.defineProperty({}, "kind", {
      enumerable: true,
      get(): string {
        calls += 1;
        return "rule";
      },
    });
    const targetResult = classifyOrganizationPolicyTarget(target, CAPABILITIES);
    expect(targetResult.ok).toBe(false);
    expect(isDeeplyFrozen(targetResult)).toBe(true);

    const capabilities = new Proxy(CAPABILITIES, {
      get(): never {
        calls += 1;
        throw new Error("capabilities proxy executed");
      },
    });
    const capabilityResult = classifyOrganizationPolicyTarget(
      { kind: "rule", ruleId: "ACL001" },
      capabilities,
    );
    expect(capabilityResult.ok).toBe(false);
    expect(isDeeplyFrozen(capabilityResult)).toBe(true);
    expect(calls).toBe(0);

    for (const hostileTarget of [
      revokedProxy({ kind: "rule", ruleId: "ACL001" }),
      revokedProxy([{ kind: "rule", ruleId: "ACL001" }]),
      revokedProxy(() => ({ kind: "rule", ruleId: "ACL001" })),
    ]) {
      const result = classifyOrganizationPolicyTarget(hostileTarget, CAPABILITIES);
      expect(result.ok).toBe(false);
      expect(isDeeplyFrozen(result)).toBe(true);
    }

    const revokedRules = classifyOrganizationPolicyTarget(
      { kind: "rule", ruleId: "ACL001" },
      { ...CAPABILITIES, ruleIds: revokedProxy(["ACL001"]) },
    );
    expect(revokedRules.ok).toBe(false);
    expect(isDeeplyFrozen(revokedRules)).toBe(true);
  });

  test("rejects executable authority, unknown fields, unsupported rules, and duplicate targets", () => {
    const executable = pack();
    executable["command"] = "npm test";
    expectIssue(validate(executable), "forbidden-field", "$.command");

    const unknownRule = pack();
    ((unknownRule["policies"] as unknown[])[0] as { target: { ruleId: string } }).target.ruleId =
      "ACL999";
    expectIssue(validate(unknownRule), "unsupported-target", "$.policies[0].target.ruleId");

    const duplicate = pack();
    (duplicate["policies"] as unknown[]).push({
      authority: "default",
      id: "duplicate.package-manager",
      target: { kind: "setting", settingId: "commands.packageManager" },
      value: "npm",
    });
    expectIssue(validate(duplicate), "duplicate-target", "$.policies[5].target");

    const extra = pack();
    ((extra["policies"] as unknown[])[0] as Record<string, unknown>)["fix"] = "rewrite";
    expectIssue(validate(extra), "unknown-field", "$.policies[0].fix");
  });

  test("rejects malformed provenance, compatibility, origin, values, dates, and semantic versions", () => {
    const cases: readonly [string, (value: Record<string, unknown>) => void][] = [
      [
        "$.packVersion",
        (value): void => {
          value["packVersion"] = "1.2.3-01";
        },
      ],
      [
        "$.provenance.reviewedAt",
        (value): void => {
          (value["provenance"] as Record<string, unknown>)["reviewedAt"] = "2026-02-31";
        },
      ],
      [
        "$.compatibility.ruleRegistryVersion",
        (value): void => {
          (value["compatibility"] as Record<string, unknown>)["ruleRegistryVersion"] = "1.3.0";
        },
      ],
      [
        "$.policies[1].value",
        (value): void => {
          ((value["policies"] as unknown[])[1] as Record<string, unknown>)["value"] = "deno";
        },
      ],
      [
        "$.provenance.approvedSource.path",
        (value): void => {
          const provenance = value["provenance"] as Record<string, unknown>;
          (provenance["approvedSource"] as Record<string, unknown>)["path"] = "../outside.json";
        },
      ],
    ];
    for (const [path, mutate] of cases) {
      const value = pack();
      mutate(value);
      const result = validate(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.some((candidate) => candidate.path === path)).toBe(true);
    }

    const badOrigin = validateOrganizationPolicyPack(pack(), {
      capabilities: CAPABILITIES,
      origin: { path: "." as RepositoryRelativePath, sha256: "A".repeat(64) },
    });
    expectIssue(badOrigin, "invalid-value", "$origin.path");
    expectIssue(badOrigin, "invalid-value", "$origin.sha256");
  });

  test("fails closed across missing, wrong-shaped, and unsupported document branches", () => {
    const mutations: readonly ((value: Record<string, unknown>) => void)[] = [
      (value): void => {
        Reflect.deleteProperty(value, "recordKind");
      },
      (value): void => {
        value["recordKind"] = "organization-policy";
      },
      (value): void => {
        value["schemaVersion"] = "9.0.0";
      },
      (value): void => {
        value["packId"] = "not stable!";
      },
      (value): void => {
        value["compatibility"] = null;
      },
      (value): void => {
        Reflect.deleteProperty(recordAt(value, "compatibility"), "configurationVersion");
      },
      (value): void => {
        recordAt(value, "compatibility")["configurationVersion"] = 2;
      },
      (value): void => {
        recordAt(value, "compatibility")["profileCatalogVersion"] = "9.0.0";
      },
      (value): void => {
        recordAt(value, "compatibility")["minimumEngineVersion"] = "not-semver";
      },
      (value): void => {
        recordAt(value, "compatibility")["minimumEngineVersion"] = "2.0.0";
      },
      (value): void => {
        recordAt(value, "compatibility")["ruleRegistryVersion"] = "not-semver";
      },
      (value): void => {
        value["provenance"] = null;
      },
      (value): void => {
        recordAt(value, "provenance")["approvedBy"] = "bad authority";
      },
      (value): void => {
        Reflect.deleteProperty(recordAt(value, "provenance"), "revision");
      },
      (value): void => {
        recordAt(value, "provenance")["revision"] = "";
      },
      (value): void => {
        recordAt(value, "provenance")["approvedSource"] = null;
      },
      (value): void => {
        Reflect.deleteProperty(recordAt(recordAt(value, "provenance"), "approvedSource"), "path");
      },
      (value): void => {
        recordAt(recordAt(value, "provenance"), "approvedSource")["sha256"] = "bad";
      },
      (value): void => {
        recordAt(recordAt(value, "provenance"), "approvedSource")["path"] =
          ".agent-context-policy.json";
      },
      (value): void => {
        value["policies"] = null;
      },
      (value): void => {
        value["policies"] = Array.from({ length: 513 }, (_, index) => ({
          authority: "default",
          id: `p.${String(index)}`,
          target: { kind: "profile", profileId: "codex-cli" },
          value: true,
        }));
      },
      (value): void => {
        value["policies"] = [null];
      },
      (value): void => {
        Reflect.deleteProperty(policyAt(value, 0), "id");
      },
      (value): void => {
        Reflect.deleteProperty(policyAt(value, 0), "authority");
      },
      (value): void => {
        policyAt(value, 0)["authority"] = "absolute";
      },
      (value): void => {
        policyAt(value, 1)["id"] = policyAt(value, 0)["id"];
      },
      (value): void => {
        policyAt(value, 0)["target"] = null;
      },
      (value): void => {
        recordAt(policyAt(value, 0), "target")["kind"] = "plugin";
      },
      (value): void => {
        Reflect.deleteProperty(recordAt(policyAt(value, 0), "target"), "kind");
      },
      (value): void => {
        recordAt(policyAt(value, 2), "target")["profileId"] = "unknown";
      },
      (value): void => {
        recordAt(policyAt(value, 2), "target")["ruleId"] = "ACL001";
      },
      (value): void => {
        recordAt(policyAt(value, 3), "target")["profileId"] = "unknown";
      },
      (value): void => {
        recordAt(policyAt(value, 3), "target")["surfaceId"] = "cursor-agent/unknown";
      },
      (value): void => {
        recordAt(policyAt(value, 3), "target")["ruleId"] = "ACL001";
      },
      (value): void => {
        recordAt(policyAt(value, 0), "target")["profileId"] = "codex-cli";
      },
      (value): void => {
        recordAt(policyAt(value, 1), "target")["profileId"] = "codex-cli";
      },
      (value): void => {
        policyAt(value, 2)["value"] = "true";
      },
      (value): void => {
        policyAt(value, 3)["value"] = 1;
      },
      (value): void => {
        policyAt(value, 0)["value"] = null;
      },
      (value): void => {
        Reflect.deleteProperty(recordAt(policyAt(value, 0), "value"), "severity");
      },
      (value): void => {
        Reflect.deleteProperty(recordAt(policyAt(value, 0), "value"), "maxTokens");
      },
      (value): void => {
        recordAt(policyAt(value, 0), "value")["maxTokens"] = 0;
      },
      (value): void => {
        recordAt(policyAt(value, 0), "value")["severity"] = "fatal";
      },
    ];
    for (const mutate of mutations) {
      const value = pack();
      mutate(value);
      expect(validate(value).ok).toBe(false);
    }
  });

  test("accepts every allowlisted scalar setting at its B06 boundary", () => {
    const cases: readonly [string, unknown][] = [
      ["commands.packageManager", "yarn"],
      ["efficiency.tokenizer", "estimate"],
      ["efficiency.scoreVersion", "1.0.0"],
      ["standards.channel", "preview"],
      ["standards.requireCurrentInCI", true],
      ["standards.maxAgeDays", 365],
      ["efficiency.budgets.alwaysOnTokens", 0],
      ["efficiency.budgets.effectiveP95Tokens", 10_000_000],
      ["efficiency.componentWeights.budgetFit", 100],
      ["efficiency.componentWeights.crossAgentConsistency", 0],
      ["efficiency.gradeThresholds.A", 100],
      ["efficiency.gradeThresholds.D", 0],
    ];
    for (const [settingId, settingValue] of cases) {
      const value = pack();
      value["policies"] = [
        {
          authority: "default",
          id: "setting.boundary",
          target: { kind: "setting", settingId },
          value: settingValue,
        },
      ];
      expect(validate(value).ok).toBe(true);
    }
  });

  test("uses complete SemVer precedence for the minimum engine boundary", () => {
    const cases: readonly [string, string, boolean][] = [
      ["1.4.0", "1.4.0-beta.1", true],
      ["1.4.0-beta.1", "1.4.0", false],
      ["1.4.0-2", "1.4.0-10", false],
      ["1.4.0-alpha", "1.4.0-1", true],
      ["2.0.0", "1.999999999999999999999.0", true],
    ];
    for (const [engineVersion, minimumEngineVersion, expected] of cases) {
      const value = pack();
      recordAt(value, "compatibility")["minimumEngineVersion"] = minimumEngineVersion;
      const result = validateOrganizationPolicyPack(value, {
        capabilities: { ...CAPABILITIES, engineVersion },
        origin: {
          path: ".agent-context-policy.json" as RepositoryRelativePath,
          sha256: HASH_A,
        },
      });
      expect(result.ok).toBe(expected);
    }
  });

  test("rejects hostile JavaScript values without executing accessors and bounds resources", () => {
    let calls = 0;
    const accessor = pack();
    Object.defineProperty(accessor, "packId", {
      enumerable: true,
      get(): string {
        calls += 1;
        return "hostile";
      },
    });
    expectIssue(validate(accessor), "invalid-value");
    expect(calls).toBe(0);

    const cyclic = pack();
    cyclic["cycle"] = cyclic;
    expectIssue(validate(cyclic), "invalid-value", "$.cycle");

    const sparse = pack();
    sparse["policies"] = new Array(2);
    expectIssue(validate(sparse), "invalid-value", "$.policies");

    const exotic = pack();
    Object.setPrototypeOf(exotic, new Date());
    expectIssue(validate(exotic), "invalid-value", "$");

    const malformedUnicode = pack();
    malformedUnicode["packId"] = "bad\ud800";
    expectIssue(validate(malformedUnicode), "invalid-value", "$.packId");

    const bidi = pack();
    bidi["packId"] = "safe\u202Ehidden";
    expectIssue(validate(bidi), "invalid-value", "$.packId");

    const oversized = pack();
    oversized["packId"] = "x".repeat(1_000_000);
    expectIssue(validate(oversized), "invalid-value", "$.packId");

    const revoked = Proxy.revocable(pack(), {});
    revoked.revoke();
    expectIssue(validate(revoked.proxy), "invalid-value", "$");

    for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, -0, 1n, Symbol("policy")]) {
      const value = pack();
      value["unsafe"] = unsafe;
      expect(validate(value).ok).toBe(false);
    }

    const repeated = pack();
    repeated["repeat"] = repeated["compatibility"];
    expectIssue(validate(repeated), "invalid-value");

    const extraArray = pack();
    Object.defineProperty(extraArray["policies"] as unknown[], "extra", {
      enumerable: true,
      value: true,
    });
    expectIssue(validate(extraArray), "invalid-value", "$.policies");

    const symbolKey = pack();
    Object.defineProperty(symbolKey, Symbol("policy"), { enumerable: true, value: true });
    expectIssue(validate(symbolKey), "invalid-value", "$");

    const hugeContainer: Record<string, unknown> = {};
    for (let index = 0; index <= ORGANIZATION_POLICY_LIMITS.maximumContainerEntries; index += 1)
      hugeContainer[`key${String(index)}`] = null;
    expect(validate(hugeContainer).ok).toBe(false);

    let skippedAccessorCalls = 0;
    const oversizedContainer: Record<string, unknown> = {};
    Object.defineProperty(oversizedContainer, "accessor", {
      enumerable: true,
      get(): null {
        skippedAccessorCalls += 1;
        return null;
      },
    });
    for (let index = 0; index < ORGANIZATION_POLICY_LIMITS.maximumContainerEntries; index += 1)
      oversizedContainer[`key${String(index)}`] = null;
    const oversizedContainerResult = validate(oversizedContainer);
    expectIssue(oversizedContainerResult, "resource-limit", "$");
    if (!oversizedContainerResult.ok)
      expect(oversizedContainerResult.issues.length).toBeLessThanOrEqual(
        ORGANIZATION_POLICY_LIMITS.maximumIssues,
      );
    expect(skippedAccessorCalls).toBe(0);

    const hugeText = pack();
    hugeText["extra"] = Array.from({ length: 17 }, () => "x".repeat(4096));
    expectIssue(validate(hugeText), "resource-limit");

    const deepKey = "k".repeat(ORGANIZATION_POLICY_LIMITS.maximumKeyBytes);
    let deeplyNested: unknown = null;
    for (let depth = 0; depth <= ORGANIZATION_POLICY_LIMITS.maximumValues; depth += 1)
      deeplyNested = { [deepKey]: deeplyNested };
    const deeplyNestedResult = validate(deeplyNested);
    expectIssue(deeplyNestedResult, "resource-limit");
    if (!deeplyNestedResult.ok) {
      expect(deeplyNestedResult.issues.length).toBeLessThanOrEqual(
        ORGANIZATION_POLICY_LIMITS.maximumIssues,
      );
      expect(
        deeplyNestedResult.issues.every(
          (candidate) => Buffer.byteLength(candidate.path, "utf8") <= 4_096,
        ),
      ).toBe(true);
    }
  });

  test("returns frozen failures for revoked object, array, and callable proxies", () => {
    for (const hostileInput of [
      revokedProxy(pack()),
      revokedProxy([pack()]),
      revokedProxy(() => pack()),
    ]) {
      const result = validate(hostileInput);
      expect(result.ok).toBe(false);
      expect(isDeeplyFrozen(result)).toBe(true);
    }

    for (const hostileOptions of [
      revokedProxy({}),
      revokedProxy([]),
      revokedProxy(() => CAPABILITIES),
    ]) {
      const result = validateOrganizationPolicyPack(
        pack(),
        hostileOptions as unknown as ValidateOrganizationPolicyPackOptions,
      );
      expect(result.ok).toBe(false);
      expect(isDeeplyFrozen(result)).toBe(true);
    }

    let calls = 0;
    const revokedLocator = revokedProxy(() => {
      calls += 1;
      return LOCATION;
    });
    const locatorResult = validateOrganizationPolicyPack(pack(), {
      capabilities: CAPABILITIES,
      locate: revokedLocator,
      origin: {
        path: ".agent-context-policy.json" as RepositoryRelativePath,
        sha256: HASH_A,
      },
    });
    expect(locatorResult.ok).toBe(false);
    expect(isDeeplyFrozen(locatorResult)).toBe(true);
    expect(calls).toBe(0);

    const revokedOrigin = validateOrganizationPolicyPack(pack(), {
      capabilities: CAPABILITIES,
      origin: revokedProxy({
        path: ".agent-context-policy.json" as RepositoryRelativePath,
        sha256: HASH_A,
      }),
    });
    expect(revokedOrigin.ok).toBe(false);
    expect(isDeeplyFrozen(revokedOrigin)).toBe(true);

    const plainArrayOptions = validateOrganizationPolicyPack(
      pack(),
      [] as unknown as ValidateOrganizationPolicyPackOptions,
    );
    expect(plainArrayOptions.ok).toBe(false);
    expect(isDeeplyFrozen(plainArrayOptions)).toBe(true);
  });

  test("rejects isolated and reversed UTF-16 surrogates at every public text boundary", () => {
    const validPair = pack();
    recordAt(validPair, "provenance")["revision"] = "review-😀";
    expect(validate(validPair).ok).toBe(true);

    const malformedTexts = ["\ud800", "\udc00", "\udc00\ud800"] as const;
    const authentic = validatedPack();
    for (const malformed of malformedTexts) {
      const malformedPack = pack();
      malformedPack["packId"] = `pack${malformed}`;
      const packResult = validate(malformedPack);

      const originResult = validateOrganizationPolicyPack(pack(), {
        capabilities: CAPABILITIES,
        origin: {
          path: `policy${malformed}.json` as RepositoryRelativePath,
          sha256: `${malformed}${HASH_A}`,
        },
      });

      const capabilityResult = validateOrganizationPolicyPack(pack(), {
        capabilities: {
          ...CAPABILITIES,
          engineVersion: `1.4.0${malformed}`,
          ruleIds: [`ACL${malformed}`],
        },
        origin: {
          path: ".agent-context-policy.json" as RepositoryRelativePath,
          sha256: HASH_A,
        },
      });

      const targetResult = classifyOrganizationPolicyTarget(
        { kind: "rule", ruleId: `ACL${malformed}` },
        CAPABILITIES,
      );

      const overrideResult = resolveOrganizationPolicy({
        capabilities: CAPABILITIES,
        cli: [
          {
            id: `override${malformed}`,
            source: { argument: `--value=${malformed}`, kind: "cli" },
            target: { kind: "profile", profileId: "codex-cli" },
            value: true,
          },
        ],
        pack: authentic,
      });

      const repositoryLocationResult = resolveOrganizationPolicy({
        capabilities: CAPABILITIES,
        pack: authentic,
        repository: [
          {
            id: "repository.location",
            source: {
              kind: "repository",
              location: {
                ...structuredClone(LOCATION),
                path: `policy${malformed}.json` as RepositoryRelativePath,
              },
            },
            target: { kind: "profile", profileId: "codex-cli" },
            value: true,
          },
        ],
      });

      const invalidForLocation = pack();
      invalidForLocation["unknown"] = true;
      const locate = vi.fn((path: string) => {
        void path;
        return {
          ...structuredClone(LOCATION),
          path: `policy${malformed}.json` as RepositoryRelativePath,
        };
      });
      const locationResult = validateOrganizationPolicyPack(invalidForLocation, {
        capabilities: CAPABILITIES,
        locate,
        origin: {
          path: ".agent-context-policy.json" as RepositoryRelativePath,
          sha256: HASH_A,
        },
      });

      for (const result of [
        packResult,
        originResult,
        capabilityResult,
        targetResult,
        overrideResult,
        repositoryLocationResult,
        locationResult,
      ]) {
        expect(result.ok).toBe(false);
        expect(isDeeplyFrozen(result)).toBe(true);
        expect(containsString(result, malformed)).toBe(false);
      }
      expect(locate).toHaveBeenCalled();
      expect(locate.mock.calls.every(([path]) => !path.includes(malformed))).toBe(true);
    }
  });

  test("rejects enormous public strings before downstream parsing and reflection", () => {
    const enormous = "x".repeat(1_000_000);
    const malformedPack = pack();
    malformedPack["packId"] = enormous;
    const authentic = validatedPack();
    const locate = vi.fn((path: string) => {
      void path;
      return {
        ...structuredClone(LOCATION),
        path: enormous as RepositoryRelativePath,
      };
    });
    const locatedPack = pack();
    locatedPack["unknown"] = true;

    const results = [
      validate(malformedPack),
      validateOrganizationPolicyPack(pack(), {
        capabilities: CAPABILITIES,
        origin: { path: enormous as RepositoryRelativePath, sha256: HASH_A },
      }),
      classifyOrganizationPolicyTarget(
        { kind: "rule", ruleId: "ACL001" },
        { ...CAPABILITIES, engineVersion: enormous, ruleIds: [enormous] },
      ),
      classifyOrganizationPolicyTarget({ kind: "rule", ruleId: enormous }, CAPABILITIES),
      resolveOrganizationPolicy({
        capabilities: CAPABILITIES,
        cli: [
          {
            id: enormous,
            source: { argument: enormous, kind: "cli" },
            target: { kind: "profile", profileId: "codex-cli" },
            value: true,
          },
        ],
        pack: authentic,
      }),
      validateOrganizationPolicyPack(locatedPack, {
        capabilities: CAPABILITIES,
        locate,
        origin: {
          path: ".agent-context-policy.json" as RepositoryRelativePath,
          sha256: HASH_A,
        },
      }),
    ];

    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(isDeeplyFrozen(result)).toBe(true);
      expect(containsString(result, enormous)).toBe(false);
      const issues =
        "issues" in result
          ? result.issues
          : result.ok
            ? ((): never => {
                throw new Error("expected enormous input rejection");
              })()
            : [result.issue];
      expect(issues.length).toBeLessThanOrEqual(ORGANIZATION_POLICY_LIMITS.maximumIssues);
      expect(
        issues.every(
          (candidate) =>
            Buffer.byteLength(candidate.path, "utf8") <= 4_096 &&
            Buffer.byteLength(candidate.message, "utf8") <= 1_024,
        ),
      ).toBe(true);
    }
    expect(locate).toHaveBeenCalled();
    expect(locate.mock.calls.every(([path]) => path !== enormous)).toBe(true);
  });

  test("returns source-located, immutable validation issues", () => {
    const invalid = pack();
    invalid["unknown"] = true;
    const result = validate(invalid);
    expectIssue(result, "unknown-field", "$.unknown");
    if (result.ok) return;
    expect(result.issues[0]?.location).toEqual(LOCATION);
    expect(isDeeplyFrozen(result)).toBe(true);
  });

  test("snapshots validation options and callback locations without executing accessors", () => {
    let calls = 0;
    const accessorOptions = Object.defineProperty({}, "capabilities", {
      enumerable: true,
      get(): OrganizationPolicyCapabilities {
        calls += 1;
        return CAPABILITIES;
      },
    });
    const accessorResult = validateOrganizationPolicyPack(
      pack(),
      accessorOptions as ValidateOrganizationPolicyPackOptions,
    );
    expect(accessorResult.ok).toBe(false);
    expect(calls).toBe(0);

    const capabilityAccessor = Object.defineProperty(
      { engineVersion: "1.4.0", ruleRegistryVersion: "1.2.0" },
      "ruleIds",
      {
        enumerable: true,
        get(): readonly string[] {
          calls += 1;
          return ["ACL001"];
        },
      },
    );
    const capabilityResult = validateOrganizationPolicyPack(pack(), {
      capabilities: capabilityAccessor as OrganizationPolicyCapabilities,
      origin: {
        path: ".agent-context-policy.json" as RepositoryRelativePath,
        sha256: HASH_A,
      },
    });
    expect(capabilityResult.ok).toBe(false);
    expect(calls).toBe(0);

    const originAccessor = Object.defineProperty({}, "path", {
      enumerable: true,
      get(): string {
        calls += 1;
        return ".agent-context-policy.json";
      },
    });
    const originResult = validateOrganizationPolicyPack(pack(), {
      capabilities: CAPABILITIES,
      origin: originAccessor as ValidateOrganizationPolicyPackOptions["origin"],
    });
    expect(originResult.ok).toBe(false);
    expect(calls).toBe(0);

    const oversizedOptions: Record<string, unknown> = {};
    Object.defineProperty(oversizedOptions, "capabilities", {
      enumerable: true,
      get(): OrganizationPolicyCapabilities {
        calls += 1;
        return CAPABILITIES;
      },
    });
    for (let index = 0; index < 1_000; index += 1)
      oversizedOptions[`unknown${String(index)}`] = null;
    const oversizedOptionsResult = validateOrganizationPolicyPack(
      pack(),
      oversizedOptions as unknown as ValidateOrganizationPolicyPackOptions,
    );
    expect(oversizedOptionsResult.ok).toBe(false);
    expect(isDeeplyFrozen(oversizedOptionsResult)).toBe(true);
    expect(calls).toBe(0);

    const proxyLocator = new Proxy(() => LOCATION, {
      apply(): ConfigurationSourceLocation {
        calls += 1;
        return LOCATION;
      },
    });
    const proxyLocatorResult = validateOrganizationPolicyPack(pack(), {
      capabilities: CAPABILITIES,
      locate: proxyLocator,
      origin: {
        path: ".agent-context-policy.json" as RepositoryRelativePath,
        sha256: HASH_A,
      },
    });
    expect(proxyLocatorResult.ok).toBe(false);
    expect(calls).toBe(0);

    const invalidLocateKeyResult = validateOrganizationPolicyPack(pack(), {
      capabilities: CAPABILITIES,
      locateKey: 1,
      origin: {
        path: ".agent-context-policy.json" as RepositoryRelativePath,
        sha256: HASH_A,
      },
    } as unknown as ValidateOrganizationPolicyPackOptions);
    expect(invalidLocateKeyResult.ok).toBe(false);
    expect(isDeeplyFrozen(invalidLocateKeyResult)).toBe(true);

    const oversizedOrigin: Record<string, unknown> = { sha256: HASH_A };
    Object.defineProperty(oversizedOrigin, "path", {
      enumerable: true,
      get(): string {
        calls += 1;
        return ".agent-context-policy.json";
      },
    });
    for (let index = 0; index < 1_000; index += 1)
      oversizedOrigin[`unknown${String(index)}`] = null;
    expect(
      validateOrganizationPolicyPack(pack(), {
        capabilities: CAPABILITIES,
        origin: oversizedOrigin as unknown as ValidateOrganizationPolicyPackOptions["origin"],
      }).ok,
    ).toBe(false);
    expect(calls).toBe(0);

    const hugePathResult = validateOrganizationPolicyPack(pack(), {
      capabilities: CAPABILITIES,
      origin: { path: "x".repeat(100_000) as RepositoryRelativePath, sha256: HASH_A },
    });
    expect(hugePathResult.ok).toBe(false);
    if (!hugePathResult.ok) {
      expect(hugePathResult.issues.every((issue) => Buffer.byteLength(issue.path) <= 4_096)).toBe(
        true,
      );
      expect(
        hugePathResult.issues.every((issue) => Buffer.byteLength(issue.message) <= 1_024),
      ).toBe(true);
    }

    const invalid = pack();
    invalid["unknown"] = true;
    const mutableLocation = structuredClone(LOCATION);
    const located = validateOrganizationPolicyPack(invalid, {
      capabilities: CAPABILITIES,
      locateKey: () => mutableLocation,
      origin: {
        path: ".agent-context-policy.json" as RepositoryRelativePath,
        sha256: HASH_A,
      },
    });
    expect(located.ok).toBe(false);
    if (!located.ok) {
      const unknown = located.issues.find((candidate) => candidate.code === "unknown-field");
      expect(unknown?.location).toEqual(mutableLocation);
      expect(unknown?.location).not.toBe(mutableLocation);
    }
    expect(Object.isFrozen(mutableLocation)).toBe(false);
    expect(Object.isFrozen(mutableLocation.range)).toBe(false);

    const hostileLocation = Object.defineProperty({}, "path", {
      enumerable: true,
      get(): string {
        calls += 1;
        return ".agent-context-policy.json";
      },
    });
    const hostileLocated = validateOrganizationPolicyPack(invalid, {
      capabilities: CAPABILITIES,
      locateKey: () => hostileLocation as ConfigurationSourceLocation,
      origin: {
        path: ".agent-context-policy.json" as RepositoryRelativePath,
        sha256: HASH_A,
      },
    });
    expect(hostileLocated.ok).toBe(false);
    expect(calls).toBe(0);

    const hugeCallbackLocation = structuredClone(LOCATION) as {
      path: RepositoryRelativePath;
      range: ConfigurationSourceLocation["range"];
    };
    hugeCallbackLocation.path = "x".repeat(100_000) as RepositoryRelativePath;
    const hugeLocated = validateOrganizationPolicyPack(invalid, {
      capabilities: CAPABILITIES,
      locateKey: () => hugeCallbackLocation,
      origin: {
        path: ".agent-context-policy.json" as RepositoryRelativePath,
        sha256: HASH_A,
      },
    });
    expect(hugeLocated.ok).toBe(false);
    if (!hugeLocated.ok)
      expect(
        hugeLocated.issues
          .filter((issue) => issue.code === "unknown-field")
          .every((issue) => issue.location === null),
      ).toBe(true);
    expect(Object.isFrozen(hugeCallbackLocation)).toBe(false);
  });
});

describe("B11 deterministic precedence and conflict behavior", () => {
  function repository(
    id: string,
    target: OrganizationPolicyOverride["target"],
    value: OrganizationPolicyOverride["value"],
  ): OrganizationPolicyOverride {
    return {
      id,
      source: { kind: "repository", location: structuredClone(LOCATION) },
      target,
      value,
    };
  }

  function cli(
    id: string,
    target: OrganizationPolicyOverride["target"],
    value: OrganizationPolicyOverride["value"],
  ): OrganizationPolicyOverride {
    return { id, source: { argument: `--${id}`, kind: "cli" }, target, value };
  }

  test("applies pack defaults below repository and CLI while enforced values require agreement", () => {
    const ruleTarget = { kind: "rule", ruleId: "ACL001" } as const;
    const settingTarget = { kind: "setting", settingId: "commands.packageManager" } as const;
    const result = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      cli: [cli("cli.package", settingTarget, "bun")],
      pack: validatedPack(),
      repository: [
        repository("repo.package", settingTarget, "npm"),
        repository("repo.rule", ruleTarget, { maxTokens: null, severity: "warning" }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.assignments.find((entry) => entry.targetKey === "setting:commands.packageManager"),
    ).toEqual(
      expect.objectContaining({ source: { argument: "--cli.package", kind: "cli" }, value: "bun" }),
    );
    const rule = result.assignments.find((entry) => entry.targetKey === "rule:ACL001");
    expect(rule?.source.kind).toBe("organization");
    if (rule?.source.kind === "organization") expect(rule.source.authority).toBe("enforced");
    expect(
      result.events
        .filter((entry) => entry.targetKey === "setting:commands.packageManager")
        .map((entry) => entry.source.kind),
    ).toEqual(["organization", "repository", "cli"]);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "confirmed", targetKey: "rule:ACL001" }),
      ]),
    );
    expect(isDeeplyFrozen(result)).toBe(true);
  });

  test("fails the complete resolution on an enforced conflict and reports both sources", () => {
    const result = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      cli: [
        cli("cli.rule", { kind: "rule", ruleId: "ACL001" }, { maxTokens: null, severity: "off" }),
      ],
      pack: validatedPack(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "conflict",
        location: null,
        relatedLocation: LOCATION,
      }),
    ]);
    expect("assignments" in result).toBe(false);
  });

  test("rejects duplicate, malformed, and capability-mismatched override layers", () => {
    const target = { kind: "setting", settingId: "standards.maxAgeDays" } as const;
    const duplicate = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      cli: [cli("one", target, 20), cli("two", { ...target }, 30)],
      pack: validatedPack(),
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok)
      expect(duplicate.issues.some((issue) => issue.code === "duplicate-target")).toBe(true);

    const wrongSource = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      pack: validatedPack(),
      repository: [cli("wrong", target, 20)],
    });
    expect(wrongSource.ok).toBe(false);
    if (!wrongSource.ok)
      expect(wrongSource.issues.some((issue) => issue.code === "invalid-value")).toBe(true);

    const mismatched = resolveOrganizationPolicy({
      capabilities: { ...CAPABILITIES, ruleIds: ["ACL106"], ruleRegistryVersion: "1.2.1" },
      pack: validatedPack(),
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok)
      expect(mismatched.issues.some((issue) => issue.code === "unsupported-version")).toBe(true);
  });

  test("requires module-authenticated validated packs before any pack dereference", () => {
    const authentic = validatedPack();
    const cloned = structuredClone(authentic);
    const clonedResult = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      pack: cloned,
    });
    expect(clonedResult.ok).toBe(false);

    const forged = structuredClone(authentic) as unknown as {
      document: { policies: { target: { settingId?: string }; value: unknown }[] };
    };
    const packageManager = forged.document.policies.find(
      (policy) => policy.target.settingId === "commands.packageManager",
    );
    if (packageManager === undefined) throw new Error("package-manager policy is missing");
    packageManager.value = "curl";
    const forgedResult = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      pack: forged as unknown as ValidatedOrganizationPolicyPack,
    });
    expect(forgedResult.ok).toBe(false);
    expect("assignments" in forgedResult).toBe(false);

    let calls = 0;
    const accessorPack = Object.defineProperty({}, "document", {
      enumerable: true,
      get(): never {
        calls += 1;
        throw new Error("pack accessor executed");
      },
    }) as ValidatedOrganizationPolicyPack;
    const accessorResult = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      pack: accessorPack,
    });
    expect(accessorResult.ok).toBe(false);
    expect(calls).toBe(0);

    const proxyPack = new Proxy(authentic, {
      get(): never {
        calls += 1;
        throw new Error("pack proxy executed");
      },
    });
    expect(resolveOrganizationPolicy({ capabilities: CAPABILITIES, pack: proxyPack }).ok).toBe(
      false,
    );
    expect(calls).toBe(0);

    expect(() => {
      (authentic.document.policies[0] as { value: unknown }).value = "curl";
    }).toThrow(TypeError);
    expect(resolveOrganizationPolicy({ capabilities: CAPABILITIES, pack: authentic }).ok).toBe(
      true,
    );

    const accessorOptions = Object.defineProperty({}, "pack", {
      enumerable: true,
      get(): ValidatedOrganizationPolicyPack {
        calls += 1;
        return authentic;
      },
    });
    expect(resolveOrganizationPolicy(accessorOptions as ResolveOrganizationPolicyOptions).ok).toBe(
      false,
    );

    const capabilityAccessor = Object.defineProperty(
      { engineVersion: "1.4.0", ruleRegistryVersion: "1.2.0" },
      "ruleIds",
      {
        enumerable: true,
        get(): readonly string[] {
          calls += 1;
          return ["ACL001"];
        },
      },
    );
    expect(
      resolveOrganizationPolicy({
        capabilities: capabilityAccessor as OrganizationPolicyCapabilities,
        pack: authentic,
      }).ok,
    ).toBe(false);
    expect(calls).toBe(0);

    const oversizedOptions: Record<string, unknown> = {};
    Object.defineProperty(oversizedOptions, "pack", {
      enumerable: true,
      get(): ValidatedOrganizationPolicyPack {
        calls += 1;
        return authentic;
      },
    });
    for (let index = 0; index < 1_000; index += 1)
      oversizedOptions[`unknown${String(index)}`] = null;
    const oversizedResult = resolveOrganizationPolicy(
      oversizedOptions as unknown as ResolveOrganizationPolicyOptions,
    );
    expect(oversizedResult.ok).toBe(false);
    expect(isDeeplyFrozen(oversizedResult)).toBe(true);
    expect(calls).toBe(0);
  });

  test("contains revoked resolver options, capabilities, and override layers", () => {
    const authentic = validatedPack();
    for (const hostileOptions of [
      revokedProxy({}),
      revokedProxy([]),
      revokedProxy(() => authentic),
    ]) {
      const result = resolveOrganizationPolicy(
        hostileOptions as unknown as ResolveOrganizationPolicyOptions,
      );
      expect(result.ok).toBe(false);
      expect(isDeeplyFrozen(result)).toBe(true);
    }

    for (const hostileLayer of [revokedProxy([]), revokedProxy({}), revokedProxy(() => [])]) {
      const result = resolveOrganizationPolicy({
        capabilities: CAPABILITIES,
        cli: hostileLayer as unknown as readonly OrganizationPolicyOverride[],
        pack: authentic,
      });
      expect(result.ok).toBe(false);
      expect(isDeeplyFrozen(result)).toBe(true);
    }

    const revokedRuleIds = resolveOrganizationPolicy({
      capabilities: { ...CAPABILITIES, ruleIds: revokedProxy(["ACL001"]) },
      pack: authentic,
    });
    expect(revokedRuleIds.ok).toBe(false);
    expect(isDeeplyFrozen(revokedRuleIds)).toBe(true);
  });

  test("rejects hostile and non-canonical override layer shapes without partial output", () => {
    const resolveCli = (layer: unknown): ReturnType<typeof resolveOrganizationPolicy> =>
      resolveOrganizationPolicy({
        capabilities: CAPABILITIES,
        cli: layer,
        pack: validatedPack(),
      } as unknown as ResolveOrganizationPolicyOptions);

    const malformedLayers: readonly unknown[] = [
      null,
      [1],
      [{}],
      [
        {
          id: "bad",
          source: { argument: "--bad", extra: true, kind: "cli" },
          target: { kind: "profile", profileId: "codex-cli" },
          value: true,
        },
      ],
      [
        {
          id: "repository.extra",
          source: { extra: true, kind: "repository", location: LOCATION },
          target: { kind: "profile", profileId: "codex-cli" },
          value: true,
        },
      ],
      [
        {
          extra: true,
          id: "bad",
          source: { argument: "--bad", kind: "cli" },
          target: { kind: "profile", profileId: "codex-cli" },
          value: true,
        },
      ],
      [
        {
          id: "bad id",
          source: { argument: "--bad", kind: "cli" },
          target: { kind: "profile", profileId: "codex-cli" },
          value: true,
        },
      ],
      [
        {
          id: "same",
          source: { argument: "--one", kind: "cli" },
          target: { kind: "profile", profileId: "codex-cli" },
          value: true,
        },
        {
          id: "same",
          source: { argument: "--two", kind: "cli" },
          target: { kind: "profile", profileId: "cursor-agent" },
          value: true,
        },
      ],
      [
        {
          id: "target",
          source: { argument: "--target", kind: "cli" },
          target: { kind: "plugin" },
          value: true,
        },
      ],
      [
        {
          id: "value",
          source: { argument: "--value", kind: "cli" },
          target: { kind: "profile", profileId: "codex-cli" },
          value: "yes",
        },
      ],
      Array.from({ length: 513 }, (_, index) => ({
        id: `cli.${String(index)}`,
        source: { argument: `--${String(index)}`, kind: "cli" },
        target: { kind: "setting", settingId: "standards.maxAgeDays" },
        value: index + 1,
      })),
      Array.from({ length: ORGANIZATION_POLICY_LIMITS.maximumPolicies + 1 }, () => null),
    ];
    for (const [index, layer] of malformedLayers.entries()) {
      const result = resolveCli(layer);
      expect(result.ok, `malformed layer ${String(index)}`).toBe(false);
      expect("assignments" in result).toBe(false);
    }

    let calls = 0;
    const accessor = Object.defineProperty({}, "id", {
      enumerable: true,
      get(): string {
        calls += 1;
        return "hostile";
      },
    });
    expect(resolveCli([accessor]).ok).toBe(false);
    expect(calls).toBe(0);

    const invalidLocation = repository(
      "invalid.location",
      { kind: "profile", profileId: "codex-cli" },
      true,
    ) as { source: { location: Record<string, unknown> } } & OrganizationPolicyOverride;
    const mutableLocation = invalidLocation.source.location as unknown as { range: unknown };
    mutableLocation.range = { start: {}, end: {} };
    const repositoryResult = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      pack: validatedPack(),
      repository: [invalidLocation],
    });
    expect(repositoryResult.ok).toBe(false);

    const tooManyIssues = resolveCli(
      Array.from({ length: 200 }, (_, index) => ({
        extra: true,
        id: `invalid id ${String(index)}`,
        source: { argument: "--invalid", extra: true, kind: "cli" },
        target: { kind: "plugin" },
        value: true,
      })),
    );
    expect(tooManyIssues.ok).toBe(false);
    if (!tooManyIssues.ok) {
      expect(tooManyIssues.issues).toHaveLength(ORGANIZATION_POLICY_LIMITS.maximumIssues);
      expect(isDeeplyFrozen(tooManyIssues)).toBe(true);
      expect(tooManyIssues.issues.every((issue) => !issue.path.includes("invalid id"))).toBe(true);
    }
  });

  test("rejects primitive enforced conflicts and older resolver capabilities", () => {
    const conflict = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      cli: [
        cli(
          "cursor.ide",
          { kind: "surface", profileId: "cursor-agent", surfaceId: "cursor-agent/ide" },
          true,
        ),
      ],
      pack: validatedPack(),
    });
    expect(conflict.ok).toBe(false);

    const older = resolveOrganizationPolicy({
      capabilities: { ...CAPABILITIES, engineVersion: "1.2.0" },
      pack: validatedPack(),
    });
    expect(older.ok).toBe(false);
    if (!older.ok)
      expect(older.issues.some((issue) => issue.code === "unsupported-version")).toBe(true);
  });

  test("is invariant to policy and override input ordering", () => {
    const value = pack();
    const policies = value["policies"] as unknown[];
    value["policies"] = [...policies].reverse();
    const first = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      cli: [
        cli("cli.max-age", { kind: "setting", settingId: "standards.maxAgeDays" }, 45),
        cli("cli.package", { kind: "setting", settingId: "commands.packageManager" }, "bun"),
      ],
      pack: validatedPack(value),
    });
    const second = resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      cli: [
        cli("cli.package", { kind: "setting", settingId: "commands.packageManager" }, "bun"),
        cli("cli.max-age", { kind: "setting", settingId: "standards.maxAgeDays" }, 45),
      ],
      pack: validatedPack(),
    });
    expect(first).toEqual(second);
  });

  test("does not mutate caller-owned pack, capability, or override data", () => {
    const value = pack();
    const before = structuredClone(value);
    const override = cli(
      "cli.package",
      { kind: "setting", settingId: "commands.packageManager" },
      "bun",
    );
    const overrideBefore = structuredClone(override);
    resolveOrganizationPolicy({
      capabilities: CAPABILITIES,
      cli: [override],
      pack: validatedPack(value),
    });
    expect(value).toEqual(before);
    expect(override).toEqual(overrideBefore);
    expect(Object.isFrozen(value)).toBe(false);
    expect(Object.isFrozen(override)).toBe(false);
    expect(Object.isFrozen(override.target)).toBe(false);
    expect(CAPABILITIES.ruleIds).toEqual(["ACL001", "ACL106"]);
  });

  test("contains failures from a source locator", () => {
    const locate = vi.fn(() => {
      throw new Error("hostile locator");
    });
    const result = validateOrganizationPolicyPack(pack(), {
      capabilities: CAPABILITIES,
      locate,
      locateKey: locate,
      origin: {
        path: ".agent-context-policy.json" as RepositoryRelativePath,
        sha256: HASH_A,
      },
    });
    expect(result.ok).toBe(true);
    expect(locate).toHaveBeenCalled();
  });
});
