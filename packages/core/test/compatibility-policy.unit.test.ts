import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  COMPATIBILITY_CLASSES,
  COMPATIBILITY_POLICY,
  COMPATIBILITY_POLICY_LIMITS,
  COMPATIBILITY_POLICY_VERSION,
  COMPATIBILITY_SURFACE_IDS,
  MAX_COMPATIBILITY_CHANGE_ID_BYTES,
  MAX_COMPATIBILITY_SURFACE_ID_BYTES,
  classifyCompatibilityChange,
  validateCompatibilityPolicy,
} from "../src/index.js";
import type {
  CompatibilityClass,
  CompatibilityPolicyValidationCode,
  CompatibilityPolicyValidationResult,
  CompatibilitySurfaceId,
} from "../src/index.js";

const POLICY = new URL("../policies/compatibility-policy.v1.json", import.meta.url);
const MIGRATIONS = new URL("./fixtures/compatibility-migrations.v1.json", import.meta.url);
const MANIFEST = new URL("../package.json", import.meta.url);

interface MigrationFixtureCase {
  readonly id: string;
  readonly surfaceId: CompatibilitySurfaceId;
  readonly changeId: string;
  readonly classification: CompatibilityClass;
  readonly migrationRequired: boolean;
}

interface MigrationFixtureDocument {
  readonly recordKind: "agent-context-compatibility-migration-fixtures";
  readonly fixtureVersion: "1.0.0";
  readonly cases: readonly MigrationFixtureCase[];
}

function json(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function clonePolicy(): Record<string, unknown> {
  return structuredClone(COMPATIBILITY_POLICY) as unknown as Record<string, unknown>;
}

function expectIssue(
  result: CompatibilityPolicyValidationResult,
  code: CompatibilityPolicyValidationCode,
  path?: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected compatibility policy rejection");
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code, ...(path === undefined ? {} : { path }) }),
    ]),
  );
}

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeeplyFrozen);
}

describe("B10 canonical compatibility authority", () => {
  test("publishes one validated, deeply immutable policy with every required surface", () => {
    const artifact = json(POLICY);
    const result = validateCompatibilityPolicy(artifact);
    expect(result).toEqual({
      ok: true,
      value: COMPATIBILITY_POLICY,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(COMPATIBILITY_POLICY_VERSION).toBe("1.0.0");
    expect(COMPATIBILITY_CLASSES).toEqual(["patch", "minor", "major"]);
    expect(COMPATIBILITY_POLICY.surfaces.map((surface) => surface.id)).toEqual(
      COMPATIBILITY_SURFACE_IDS,
    );
    expect(isDeeplyFrozen(COMPATIBILITY_POLICY)).toBe(true);
    expect(Object.isFrozen(COMPATIBILITY_CLASSES)).toBe(true);
    expect(Object.isFrozen(COMPATIBILITY_SURFACE_IDS)).toBe(true);
    expect(Object.isFrozen(COMPATIBILITY_POLICY_LIMITS)).toBe(true);
    expect(() => (COMPATIBILITY_POLICY.surfaces as unknown as unknown[]).pop()).toThrow(TypeError);
    const manifest = json(MANIFEST) as { readonly exports?: Readonly<Record<string, string>> };
    expect(manifest.exports?.["./policies/compatibility-policy.v1.json"]).toBe(
      "./policies/compatibility-policy.v1.json",
    );
  });

  test("makes notice, support, migration, ownership, and emergency controls operational", () => {
    const seenChanges = new Set<string>();
    for (const surface of COMPATIBILITY_POLICY.surfaces) {
      expect(surface.window.minimumNoticeDays).toBeGreaterThanOrEqual(30);
      expect(surface.window.minimumDeprecationMinorReleases).toBeGreaterThanOrEqual(1);
      expect(surface.window.minimumPriorMajorSupportDays).toBeGreaterThanOrEqual(365);
      expect(surface.migration.requiredFor).toEqual(["minor", "major"]);
      expect(surface.migration.evidence.length).toBeGreaterThanOrEqual(3);
      expect(surface.owners.length).toBeGreaterThan(0);
      expect(surface.reviewers.length).toBeGreaterThanOrEqual(2);
      expect(surface.invariants.length).toBeGreaterThanOrEqual(3);
      for (const classification of COMPATIBILITY_CLASSES) {
        expect(surface.changes[classification].length).toBeGreaterThanOrEqual(2);
        for (const change of surface.changes[classification]) {
          const identity = `${surface.id}:${change}`;
          expect(seenChanges.has(identity)).toBe(false);
          seenChanges.add(identity);
        }
      }
    }
    expect(COMPATIBILITY_POLICY.emergency.maximumBreakGlassHours).toBe(4);
    expect(COMPATIBILITY_POLICY.emergency.reviewWithinHours).toBe(24);
    expect(COMPATIBILITY_POLICY.emergency.requiredApprovals).toEqual(
      expect.arrayContaining(["security-reviewers", "affected-domain-owner"]),
    );
    expect(COMPATIBILITY_POLICY.emergency.nonWaivable).toEqual(
      expect.arrayContaining([
        "repository-root-filesystem-boundary",
        "signature-digest-schema-channel-and-engine-verification",
        "secret-redaction-and-no-external-repository-mutation",
      ]),
    );
  });

  test("aligns schema, profile, and H01 knowledge-pack invariants", () => {
    const byId = new Map(
      COMPATIBILITY_POLICY.surfaces.map((surface) => [surface.id, surface] as const),
    );
    expect(byId.get("output-schema")?.invariants.join(" ")).toContain("schema-$id-recordKind");
    expect(byId.get("profile-behavior")?.invariants.join(" ")).toContain("new-dated-snapshot");
    const pack = byId.get("knowledge-pack");
    expect(pack?.releaseScheme).toBe("semantic");
    expect(pack?.versionAuthority).toContain("H01 exact-SemVer packVersion");
    expect(pack?.invariants.join(" ")).toContain("h02-h03-tuf-verification");
    expect(pack?.invariants.join(" ")).toContain(
      "packVersion-schemaVersion-adapterVersion-rulesetVersion-and-minEngineVersion",
    );
  });

  test("separates finite maintenance support from indefinite public package availability", () => {
    const byId = new Map(
      COMPATIBILITY_POLICY.surfaces.map((surface) => [surface.id, surface] as const),
    );
    expect(COMPATIBILITY_POLICY.semver.publishedPublicPackageAvailability).toBe("indefinite");
    expect(COMPATIBILITY_POLICY.semver.externalTakedownBehavior).toContain(
      "outside project control",
    );
    const runtimeRetentionValues: readonly string[] = COMPATIBILITY_POLICY.surfaces.map(
      (surface) => surface.window.publishedArtifactRetention,
    );
    expect(new Set(runtimeRetentionValues)).toEqual(new Set(["indefinite"]));
    for (const id of ["cli", "public-library"] as const) {
      const surface = byId.get(id);
      expect(surface?.window.minimumPriorMajorSupportDays).toBe(365);
      expect(surface?.window.publishedArtifactRetention).toBe("indefinite");
      expect(surface?.invariants).toEqual(
        expect.arrayContaining([
          "published-package-availability-is-indefinite-and-independent-of-maintenance-support",
          "end-of-life-uses-npm-deprecation-not-project-initiated-unpublish",
        ]),
      );
    }
  });
});

describe("closed policy validation", () => {
  test("rejects unsupported identity, missing, unknown, altered, and wrong-shape fields", () => {
    const unsupported = clonePolicy();
    unsupported["policyVersion"] = "2.0.0";
    const unsupportedResult = validateCompatibilityPolicy(unsupported);
    expectIssue(unsupportedResult, "unsupported-version", "$.policyVersion");
    expect(Object.isFrozen(unsupportedResult)).toBe(true);
    if (unsupportedResult.ok) throw new Error("expected policy rejection");
    expect(Object.isFrozen(unsupportedResult.issues)).toBe(true);
    expect(unsupportedResult.issues.every((issue) => Object.isFrozen(issue))).toBe(true);

    const missing = clonePolicy();
    Reflect.deleteProperty(missing, "status");
    expectIssue(validateCompatibilityPolicy(missing), "missing-field", "$.status");

    const unknown = clonePolicy();
    unknown["__proto__.shadow"] = true;
    expectIssue(validateCompatibilityPolicy(unknown), "unknown-field", '$["__proto__.shadow"]');

    const altered = clonePolicy();
    altered["effectiveDate"] = "2099-01-01";
    expectIssue(validateCompatibilityPolicy(altered), "invalid-value", "$.effectiveDate");

    const wrongObject = clonePolicy();
    wrongObject["semver"] = "unsafe";
    expectIssue(validateCompatibilityPolicy(wrongObject), "invalid-value", "$.semver");

    const wrongArray = clonePolicy();
    wrongArray["surfaces"] = "unsafe";
    expectIssue(validateCompatibilityPolicy(wrongArray), "invalid-value", "$.surfaces");

    const shorter = clonePolicy();
    (shorter["surfaces"] as unknown[]).pop();
    expectIssue(validateCompatibilityPolicy(shorter), "invalid-value", "$.surfaces");
  });

  test("rejects hostile runtime values without invoking accessors", () => {
    let calls = 0;
    const accessor = clonePolicy();
    Object.defineProperty(accessor, "status", {
      enumerable: true,
      get(): string {
        calls += 1;
        return "normative";
      },
    });
    expectIssue(validateCompatibilityPolicy(accessor), "invalid-value");
    expect(calls).toBe(0);

    const cycle = clonePolicy();
    cycle["cycle"] = cycle;
    expectIssue(validateCompatibilityPolicy(cycle), "invalid-value", "$.cycle");

    const sparse = clonePolicy();
    sparse["surfaces"] = new Array(COMPATIBILITY_SURFACE_IDS.length);
    expectIssue(validateCompatibilityPolicy(sparse), "invalid-value", "$.surfaces");

    const symbol = clonePolicy();
    Object.defineProperty(symbol, Symbol("authority"), { enumerable: true, value: true });
    expectIssue(validateCompatibilityPolicy(symbol), "invalid-value");

    const exotic = clonePolicy();
    Object.setPrototypeOf(exotic, new Date());
    expectIssue(validateCompatibilityPolicy(exotic), "invalid-value", "$");

    const revoked = Proxy.revocable(clonePolicy(), {});
    revoked.revoke();
    expectIssue(validateCompatibilityPolicy(revoked.proxy), "invalid-value", "$");
  });

  test("enforces bounded policy input", () => {
    const oversized = clonePolicy();
    oversized["effectiveDate"] = "x".repeat(COMPATIBILITY_POLICY_LIMITS.maximumStringBytes + 1);
    expectIssue(validateCompatibilityPolicy(oversized), "resource-limit", "$.effectiveDate");
  });
});

describe("migration classification fixtures", () => {
  test("classifies every frozen migration case from the machine policy", () => {
    const fixture = json(MIGRATIONS) as MigrationFixtureDocument;
    expect(fixture.recordKind).toBe("agent-context-compatibility-migration-fixtures");
    expect(fixture.fixtureVersion).toBe("1.0.0");
    expect(new Set(fixture.cases.map((entry) => entry.id)).size).toBe(fixture.cases.length);
    for (const entry of fixture.cases) {
      expect(classifyCompatibilityChange(entry.surfaceId, entry.changeId)).toMatchObject({
        ok: true,
        surfaceId: entry.surfaceId,
        changeId: entry.changeId,
        classification: entry.classification,
        migrationRequired: entry.migrationRequired,
      });
    }
  });

  test("fails closed for unknown surfaces and unreviewed changes", () => {
    const unknownSurface = classifyCompatibilityChange("future-surface", "rename");
    expect(unknownSurface).toEqual({
      code: "invalid-surface",
      ok: false,
      reason: "unsupported compatibility surface",
    });
    expect(Object.isFrozen(unknownSurface)).toBe(true);
    const unknownChange = classifyCompatibilityChange("cli", "silent-new-default");
    expect(unknownChange).toEqual({
      code: "invalid-change",
      ok: false,
      reason: "unrecognized compatibility change; classify at the higher risk until reviewed",
    });
    expect(Object.isFrozen(unknownChange)).toBe(true);
  });

  test("bounds untrusted identifiers and never reflects controls, bidi text, or secrets", () => {
    const canary = "COMPATIBILITY_SECRET_CANARY";
    const hostileInputs: readonly unknown[] = [
      null,
      42,
      {},
      "",
      "cli\nforged-output",
      `cli\u202EsecretdiB`,
      canary,
      "x".repeat(MAX_COMPATIBILITY_SURFACE_ID_BYTES + 1),
    ];
    for (const input of hostileInputs) {
      const result = classifyCompatibilityChange(input, canary);
      expect(result).toEqual({
        code: "invalid-surface",
        ok: false,
        reason: "unsupported compatibility surface",
      });
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(Object.isFrozen(result)).toBe(true);
    }

    for (const input of [
      null,
      {},
      "change\u001b[31m",
      `change\u2066${canary}\u2069`,
      canary,
      "x".repeat(MAX_COMPATIBILITY_CHANGE_ID_BYTES + 1),
    ]) {
      const result = classifyCompatibilityChange("cli", input);
      expect(result).toEqual({
        code: "invalid-change",
        ok: false,
        reason: "unrecognized compatibility change; classify at the higher risk until reviewed",
      });
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(Object.isFrozen(result)).toBe(true);
    }

    const accepted = classifyCompatibilityChange(
      "cli",
      "add-command-or-option-with-no-default-behavior-change",
    );
    expect(accepted.ok).toBe(true);
    expect(Object.isFrozen(accepted)).toBe(true);
  });
});
