import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import {
  canonicalizeRepositoryRelativePath,
  type ActivationRule,
  type ActivationRuleId,
  type ClientProfileId,
  type InstructionDocumentId,
  type SurfaceId,
} from "@agent-context/core";
import { PROFILE_GLOB_DIALECT_IDS } from "@agent-context/profiles";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  PROFILE_GLOB_DIALECT_LIMITS,
  ProfileGlobDialectError,
  ProfileGlobDialectErrorCode,
  createProfileGlobActivationCallbacks,
  evaluateActivationRule,
  matchProfileGlob,
  type ActivationFactDecision,
  type GlobActivationRequest,
} from "../src/index.js";

const FIXTURE = new URL(
  "../../../conformance/fixtures/v0/profile-glob-dialects.fixture.json",
  import.meta.url,
);
const CONTROL_SEQUENCE = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]`,
  "u",
);

interface FixtureCase {
  readonly comparisonGroup: string | null;
  readonly expectedState: ActivationFactDecision["state"];
  readonly id: string;
  readonly request: GlobActivationRequest;
}

interface FixtureProvenance {
  readonly dialectIds: readonly string[];
  readonly id: string;
}

function dataRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError(`${label} must be a plain object`);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  expect(Object.keys(record).sort()).toEqual([...expected].sort());
}

function boundedTextArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum)
    throw new TypeError(`${label} must be a non-empty bounded array`);
  if (Reflect.ownKeys(value).length !== value.length + 1)
    throw new TypeError(`${label} must be a dense data array`);
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0))
    throw new TypeError(`${label} entries must be non-empty text`);
  return value as readonly string[];
}

function fixtureProvenance(value: unknown): FixtureProvenance {
  const record = dataRecord(value, "fixture provenance");
  exactKeys(record, [
    "assumptions",
    "clientVersion",
    "dialectIds",
    "id",
    "observedDifferences",
    "retrievedAt",
    "sourceUrls",
    "versionStatus",
  ]);
  if (typeof record["id"] !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record["id"]))
    throw new TypeError("fixture provenance id must be a kebab identifier");
  if (record["clientVersion"] !== null && typeof record["clientVersion"] !== "string")
    throw new TypeError("fixture clientVersion must be text or null");
  if (record["retrievedAt"] !== "2026-08-02")
    throw new TypeError("fixture provenance retrieval date must match the snapshot");
  if (typeof record["versionStatus"] !== "string" || record["versionStatus"].length === 0)
    throw new TypeError("fixture versionStatus must be non-empty text");
  const dialectIds = boundedTextArray(record["dialectIds"], "fixture dialectIds", 16);
  const sourceUrls = boundedTextArray(record["sourceUrls"], "fixture sourceUrls", 8);
  if (sourceUrls.some((sourceUrl) => !sourceUrl.startsWith("https://")))
    throw new TypeError("fixture sourceUrls must use HTTPS");
  boundedTextArray(record["assumptions"], "fixture assumptions", 16);
  boundedTextArray(record["observedDifferences"], "fixture observedDifferences", 16);
  return Object.freeze({ dialectIds: Object.freeze([...dialectIds]), id: record["id"] });
}

function fixtureRequest(value: unknown): GlobActivationRequest {
  const record = dataRecord(value, "fixture request");
  exactKeys(record, [
    "dialectId",
    "pattern",
    "profileId",
    "ruleId",
    "scopeRoot",
    "surfaceId",
    "targetPath",
  ]);
  for (const key of ["pattern", "profileId", "ruleId", "scopeRoot", "surfaceId", "targetPath"])
    if (typeof record[key] !== "string") throw new TypeError(`fixture request ${key} must be text`);
  if (record["dialectId"] !== null && typeof record["dialectId"] !== "string")
    throw new TypeError("fixture request dialectId must be text or null");
  return Object.freeze({
    dialectId: record["dialectId"],
    pattern: record["pattern"] as string,
    profileId: record["profileId"] as ClientProfileId,
    ruleId: record["ruleId"] as ActivationRuleId,
    scopeRoot: canonicalizeRepositoryRelativePath(record["scopeRoot"] as string),
    surfaceId: record["surfaceId"] as SurfaceId,
    targetPath: canonicalizeRepositoryRelativePath(record["targetPath"] as string),
  });
}

async function loadFixture(): Promise<readonly FixtureCase[]> {
  const parsed: unknown = JSON.parse(await readFile(FIXTURE, "utf8"));
  const root = dataRecord(parsed, "fixture");
  exactKeys(root, ["cases", "provenance", "recordKind", "retrievedAt", "schemaVersion"]);
  expect(root["recordKind"]).toBe("agent-context-profile-glob-dialect-fixture");
  expect(root["schemaVersion"]).toBe(1);
  expect(root["retrievedAt"]).toBe("2026-08-02");
  if (!Array.isArray(root["provenance"]) || root["provenance"].length > 16)
    throw new TypeError("fixture provenance must be a bounded array");
  const provenance = root["provenance"].map(fixtureProvenance);
  expect(new Set(provenance.map((entry) => entry.id)).size).toBe(provenance.length);
  const documentedDialectIds = provenance.flatMap((entry) => entry.dialectIds).sort();
  expect(new Set(documentedDialectIds).size).toBe(documentedDialectIds.length);
  expect(documentedDialectIds).toEqual([...PROFILE_GLOB_DIALECT_IDS].sort());
  if (!Array.isArray(root["cases"]) || root["cases"].length > 64)
    throw new TypeError("fixture cases must be a bounded array");
  const cases = root["cases"].map((value): FixtureCase => {
    const record = dataRecord(value, "fixture case");
    exactKeys(record, ["comparisonGroup", "expectedState", "id", "request"]);
    if (typeof record["id"] !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(record["id"]))
      throw new TypeError("fixture case id must be a kebab identifier");
    if (record["comparisonGroup"] !== null && typeof record["comparisonGroup"] !== "string")
      throw new TypeError("comparisonGroup must be text or null");
    if (
      record["expectedState"] !== "active" &&
      record["expectedState"] !== "inactive" &&
      record["expectedState"] !== "indeterminate"
    )
      throw new TypeError("expectedState must be an activation state");
    return Object.freeze({
      comparisonGroup: record["comparisonGroup"],
      expectedState: record["expectedState"],
      id: record["id"],
      request: fixtureRequest(record["request"]),
    });
  });
  expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
  expect(Buffer.byteLength(JSON.stringify(cases), "utf8")).toBeLessThanOrEqual(65_536);
  return Object.freeze(cases);
}

const cases = await loadFixture();

function request(overrides: Partial<GlobActivationRequest> = {}): GlobActivationRequest {
  return {
    dialectId: "claude-code/project-rule-paths/2026-08-01",
    pattern: "src/**/*.ts",
    profileId: "claude-code",
    ruleId: "activation:e02" as ActivationRuleId,
    scopeRoot: canonicalizeRepositoryRelativePath("."),
    surfaceId: "claude-code/local-session",
    targetPath: canonicalizeRepositoryRelativePath("src/api/index.ts"),
    ...overrides,
  };
}

function activationRule(
  globRequest: GlobActivationRequest,
  exclude: readonly ActivationRule["exclude"][number][] = [],
): ActivationRule {
  return {
    conditions: [],
    documentId: "document:e02" as InstructionDocumentId,
    evidenceRefs: [{ sourceId: "claude-memory-docs", factId: "CC-RULE-04" }],
    exclude,
    id: globRequest.ruleId,
    include: [
      {
        dialectId: globRequest.dialectId,
        kind: "glob",
        pattern: globRequest.pattern,
        sourceRange: null,
        uncertainty: { state: "known" },
      },
    ],
    kind: "glob",
    profileId: globRequest.profileId,
    scopeRoot: globRequest.scopeRoot,
    specSnapshotId: "claude-code/2026-08-01",
    surfaceId: globRequest.surfaceId,
    uncertainty: { state: "known" },
    unknownReason: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("E02 cross-profile conformance fixture", () => {
  test.each(cases)(
    "resolves $id with profile-owned semantics",
    ({ request: input, expectedState }) => {
      const first = matchProfileGlob(input);
      const second = matchProfileGlob(input);
      expect(first).toEqual(second);
      expect(first.state).toBe(expectedState);
      expect(first.reason).not.toMatch(CONTROL_SEQUENCE);
      expect(Object.isFrozen(first)).toBe(true);
    },
  );

  test("proves the same pattern intentionally differs by profile-owned base", () => {
    const compared = cases.filter(
      (entry) => entry.comparisonGroup === "same-pattern-different-base",
    );
    expect(compared).toHaveLength(3);
    expect(new Set(compared.map((entry) => entry.request.pattern))).toEqual(new Set(["*.md"]));
    expect(compared.map((entry) => matchProfileGlob(entry.request).state)).toEqual([
      "inactive",
      "active",
      "indeterminate",
    ]);
  });
});

describe("E02 activation-algebra integration", () => {
  test("supplies exactly one frozen profile glob callback to E01", () => {
    const callbacks = createProfileGlobActivationCallbacks();
    expect(Object.keys(callbacks)).toEqual(["matchGlob"]);
    expect(Object.isFrozen(callbacks)).toBe(true);
    const result = evaluateActivationRule(activationRule(request()), {
      callbacks,
      targetPath: canonicalizeRepositoryRelativePath("src/api/index.ts"),
    });
    expect(result.state).toBe("active");
    expect(result.provenance).toHaveLength(1);
    expect(result.provenance[0]).toMatchObject({
      kind: "glob-selector",
      observedState: "active",
    });
  });

  test("keeps an unknown dialect indeterminate through the complete E01 rule", () => {
    const input = request({ dialectId: "unregistered/glob/1" });
    const result = evaluateActivationRule(activationRule(input), {
      callbacks: createProfileGlobActivationCallbacks(),
      targetPath: input.targetPath,
    });
    expect(result.state).toBe("indeterminate");
    expect(result.provenance[0]?.description).toBe(
      "No profile-owned semantics are registered for the requested glob dialect.",
    );
  });

  test("applies profile-owned includes and excludes without a default matcher", () => {
    const input = request();
    const exclusion: ActivationRule["exclude"][number] = {
      dialectId: input.dialectId,
      kind: "glob",
      pattern: "src/generated/**",
      sourceRange: null,
      uncertainty: { state: "known" },
    };
    const callbacks = createProfileGlobActivationCallbacks();
    expect(
      evaluateActivationRule(activationRule(input, [exclusion]), {
        callbacks,
        targetPath: canonicalizeRepositoryRelativePath("src/api/index.ts"),
      }).state,
    ).toBe("active");
    expect(
      evaluateActivationRule(
        activationRule(
          request({ targetPath: canonicalizeRepositoryRelativePath("src/generated/index.ts") }),
          [exclusion],
        ),
        {
          callbacks,
          targetPath: canonicalizeRepositoryRelativePath("src/generated/index.ts"),
        },
      ).state,
    ).toBe("inactive");
  });
});

describe("E02 hostile input and resource bounds", () => {
  test("rejects proxies, accessors, symbols, and unknown request fields without invoking them", () => {
    const getter = vi.fn(() => "*.md");
    const accessor = { ...request() } as Record<string, unknown>;
    Object.defineProperty(accessor, "pattern", { enumerable: true, get: getter });
    expect(() => matchProfileGlob(accessor as never)).toThrow(ProfileGlobDialectError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => matchProfileGlob(new Proxy(request(), {}) as never)).toThrow(
      ProfileGlobDialectError,
    );
    const revoked = Proxy.revocable(request(), {});
    revoked.revoke();
    expect(() => matchProfileGlob(revoked.proxy as never)).toThrow(ProfileGlobDialectError);
    expect(() => matchProfileGlob({ ...request(), extra: true } as never)).toThrow(
      ProfileGlobDialectError,
    );
    const symbol = { ...request(), [Symbol("extra")]: true };
    expect(() => matchProfileGlob(symbol as never)).toThrow(ProfileGlobDialectError);
    expect(() => matchProfileGlob([] as never)).toThrow(ProfileGlobDialectError);
    expect(() => matchProfileGlob(new Date() as never)).toThrow(ProfileGlobDialectError);
    expect(() => matchProfileGlob({ ...request(), pattern: "" })).toThrow(
      expect.objectContaining({ code: ProfileGlobDialectErrorCode.invalidRequest }),
    );
  });

  test("fails with a typed resource error before matching oversized text", () => {
    const oversizedPattern = "a".repeat(PROFILE_GLOB_DIALECT_LIMITS.maxPatternBytes + 1);
    expect(() => matchProfileGlob(request({ pattern: oversizedPattern }))).toThrow(
      expect.objectContaining({ code: ProfileGlobDialectErrorCode.resourceLimit }),
    );
    const oversizedTarget = canonicalizeRepositoryRelativePath(
      "a".repeat(PROFILE_GLOB_DIALECT_LIMITS.maxTargetBytes + 1),
    );
    expect(() => matchProfileGlob(request({ targetPath: oversizedTarget }))).toThrow(
      expect.objectContaining({ code: ProfileGlobDialectErrorCode.resourceLimit }),
    );
    expect(() =>
      matchProfileGlob(
        request({
          profileId: "p".repeat(40_000),
          ruleId: "r".repeat(30_000) as ActivationRuleId,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: ProfileGlobDialectErrorCode.resourceLimit }));
  });

  test("rejects noncanonical scope and target paths at the direct boundary", () => {
    expect(() => matchProfileGlob(request({ targetPath: "../escape" as never }))).toThrow(
      expect.objectContaining({ code: ProfileGlobDialectErrorCode.invalidRequest }),
    );
    expect(() => matchProfileGlob(request({ scopeRoot: "a/../b" as never }))).toThrow(
      expect.objectContaining({ code: ProfileGlobDialectErrorCode.invalidRequest }),
    );
  });

  test("bounds pathological wildcard work and returns a deterministic safe unknown", () => {
    const hostile = request({
      pattern: `${"*a".repeat(4_000)}b`,
      targetPath: canonicalizeRepositoryRelativePath("a".repeat(12_000)),
    });
    const first = matchProfileGlob(hostile);
    expect(first).toEqual(matchProfileGlob(hostile));
    expect(first.state).toBe("indeterminate");
    expect(first.reason).not.toMatch(CONTROL_SEQUENCE);
  });

  test("implements Claude's finite over-budget brace behavior without expanding it", () => {
    const alternatives = Array.from({ length: 1_001 }, (_, index) => String(index)).join(",");
    const first = matchProfileGlob(request({ pattern: `{${alternatives}}` }));
    expect(first).toMatchObject({ state: "inactive" });
    expect(first).toEqual(matchProfileGlob(request({ pattern: `{${alternatives}}` })));
    const vscode = matchProfileGlob(
      request({
        dialectId: "copilot-vscode/apply-to/2026-08-01",
        pattern: `{${alternatives}}`,
        profileId: "copilot-vscode",
        surfaceId: "copilot-vscode/local-chat",
      }),
    );
    expect(vscode.state).toBe("indeterminate");
  });

  test("bounds expanded bytes independently from expansion count", () => {
    const alternatives = Array.from({ length: 500 }, (_, index) => String(index)).join(",");
    const pattern = `{${alternatives}}${"x".repeat(10_000)}`;
    expect(Buffer.byteLength(pattern, "utf8")).toBeLessThan(
      PROFILE_GLOB_DIALECT_LIMITS.maxPatternBytes,
    );
    expect(matchProfileGlob(request({ pattern })).state).toBe("inactive");
  });

  test("treats malformed, nested, and empty brace forms as unknown", () => {
    for (const pattern of ["src/{ts,tsx", "src/ts,tsx}", "src/{a,{b,c}}", "src/{a,}.ts"])
      expect(matchProfileGlob(request({ pattern })).state).toBe("indeterminate");
  });

  test("handles a target equal to a VS Code scope root without escaping its base", () => {
    const result = matchProfileGlob(
      request({
        dialectId: "copilot-vscode/apply-to/2026-08-01",
        pattern: ".",
        profileId: "copilot-vscode",
        scopeRoot: canonicalizeRepositoryRelativePath("packages/app"),
        surfaceId: "copilot-vscode/local-chat",
        targetPath: canonicalizeRepositoryRelativePath("packages/app"),
      }),
    );
    expect(result.state).toBe("inactive");
  });

  test("bounds segment-product work before a pathological path matrix completes", () => {
    const pattern = Array.from({ length: 1_024 }, () => "a").join("/");
    const targetPath = canonicalizeRepositoryRelativePath(pattern);
    expect(matchProfileGlob(request({ pattern, targetPath })).state).toBe("indeterminate");
    expect(matchProfileGlob(request({ pattern: `${pattern}/a`, targetPath })).state).toBe(
      "indeterminate",
    );
  });

  test("keeps combined dotfile and case behavior unknown", () => {
    expect(
      matchProfileGlob(
        request({ pattern: "*.MD", targetPath: canonicalizeRepositoryRelativePath(".hidden.md") }),
      ).state,
    ).toBe("indeterminate");
  });

  test("does not reflect malformed Unicode or terminal controls in decisions", () => {
    for (const pattern of ["bad\ud800*.md", "\u001b[31m*.md", "\u202e*.md"]) {
      const result = matchProfileGlob(request({ pattern }));
      expect(result.state).toBe("indeterminate");
      expect(result.reason).not.toMatch(CONTROL_SEQUENCE);
      expect(result.reason).not.toContain(pattern);
    }
  });

  test("returns unknown for unsupported syntax instead of borrowing library defaults", () => {
    for (const pattern of ["src/?.ts", "src/[ab].ts", "src/***.ts", "src\\*.ts", "!src/**"])
      expect(matchProfileGlob(request({ pattern })).state).toBe("indeterminate");
  });
});
