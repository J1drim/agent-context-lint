import { readFileSync } from "node:fs";

import { validateStandardsOutput } from "@agent-context/core";
import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { beforeAll, describe, expect, test, vi } from "vitest";

import {
  MAX_OFFLINE_STANDARDS_STATUS_ISSUES,
  MAX_STANDARDS_MAX_AGE_DAYS,
  MIN_STANDARDS_MAX_AGE_DAYS,
  OFFLINE_STANDARDS_STATUS_CONTRACT_VERSION,
  createOfflineStandardsStatus,
  loadBundledKnowledgePack,
  serializeStandardsLockfile,
} from "../src/index.js";
import type {
  LoadedBundledKnowledgePack,
  OfflineStandardsStatusIssueCode,
  OfflineStandardsStatusResult,
} from "../src/index.js";

const SCHEMA = new URL("../schemas/offline-standards-status.v0.schema.json", import.meta.url);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const HASH_B = "b".repeat(64);

let bundled: LoadedBundledKnowledgePack;

beforeAll(async () => {
  const loaded = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  bundled = loaded.value;
});

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asOf: "2026-08-02T12:00:00Z",
    bundled,
    cachedLatest: null,
    engineVersion: "0.0.0",
    lockfile: null,
    maxAgeDays: 30,
    ...overrides,
  };
}

function cached(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "stable",
    checkedAt: "2026-08-01T12:00:00Z",
    minEngineVersion: "0.0.0",
    origin: "untrusted-offline-cache",
    packVersion: "2026.8.0",
    sha256: HASH_B,
    ...overrides,
  };
}

function lockValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: bundled.pack.channel,
    pack: {
      packId: bundled.pack.packId,
      packVersion: bundled.pack.packVersion,
      publishedAt: bundled.pack.publishedAt,
      schemaVersion: bundled.pack.schemaVersion,
    },
    recordKind: "agent-context-standards-lock",
    schemaVersion: "1.0.0",
    target: structuredClone(bundled.provenance.target),
    trustedState: structuredClone(bundled.provenance.trustedState),
    verificationTime: bundled.provenance.verificationTime,
    ...overrides,
  };
}

function lock(overrides: Record<string, unknown> = {}): string {
  const serialized = serializeStandardsLockfile(lockValue(overrides));
  if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
  return serialized.text;
}

function lockAtVersion(packVersion: string): string {
  const value = lockValue();
  (value["pack"] as Record<string, unknown>)["packVersion"] = packVersion;
  (value["target"] as Record<string, unknown>)["packVersion"] = packVersion;
  const serialized = serializeStandardsLockfile(value);
  if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
  return serialized.text;
}

function expectFailure(
  result: OfflineStandardsStatusResult,
  code: OfflineStandardsStatusIssueCode,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected status failure");
  expect(result.issues).toEqual([expect.objectContaining({ code })]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.issues)).toBe(true);
}

function expectProblem(
  result: OfflineStandardsStatusResult,
  code: OfflineStandardsStatusIssueCode,
): void {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(result.value.issues).toContainEqual(expect.objectContaining({ code }));
  expect(result.value.output.problems).toContain(code);
}

describe("H06 deterministic offline standards status", () => {
  test("reports authenticated bundled state without claiming global freshness", () => {
    const now = vi.spyOn(Date, "now");
    const result = createOfflineStandardsStatus(request());
    expect(result).toMatchObject({
      ok: true,
      value: {
        age: {
          bundled: { ageDays: 0, maximumAgeDays: 30, origin: "bundled", status: "current" },
          locked: null,
          policySelection: "bundled",
        },
        asOf: "2026-08-02T12:00:00Z",
        contractVersion: OFFLINE_STANDARDS_STATUS_CONTRACT_VERSION,
        issues: [],
        lastCheckedAt: null,
        output: {
          activation: "bundled",
          cachedLatest: null,
          channel: "stable",
          freshness: "offline-unknown",
          locked: null,
          mode: "status",
          problems: [],
        },
      },
    });
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
    if (!result.ok) return;
    expect(result.value.output.bundled).toEqual({
      channel: "stable",
      digest: bundled.provenance.contentSha256,
      retrievedAt: "2026-08-02T12:00:00.000Z",
      version: "2026.8.0",
    });
    expect(validateStandardsOutput(result.value.output)).toMatchObject({ ok: true });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.age)).toBe(true);
    expect(Object.isFrozen(result.value.output)).toBe(true);
  });

  test("recognizes a lock that resolves to the exact authenticated bundled content", () => {
    const result = createOfflineStandardsStatus(request({ lockfile: Buffer.from(lock()) }));
    expect(result).toMatchObject({
      ok: true,
      value: {
        age: {
          locked: { ageDays: 0, origin: "locked", status: "current" },
          policySelection: "locked",
        },
        issues: [],
        output: { activation: "locked", locked: { version: "2026.8.0" } },
      },
    });
  });

  test("shows a different valid lock but does not authenticate its unavailable content", () => {
    const value = lockValue();
    (value["pack"] as Record<string, unknown>)["packVersion"] = "2026.7.0";
    (value["target"] as Record<string, unknown>)["packVersion"] = "2026.7.0";
    const serialized = serializeStandardsLockfile(value);
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
    const result = createOfflineStandardsStatus(request({ lockfile: serialized.text }));
    expectProblem(result, "lock-authority-unauthenticated");
    if (!result.ok) return;
    expect(result.value.output).toMatchObject({
      activation: "bundled",
      locked: { version: "2026.7.0" },
    });
    expect(result.value.age.policySelection).toBe("locked");
  });

  test("does not trust a repository-authored verification time for matching content", () => {
    const result = createOfflineStandardsStatus(
      request({
        asOf: "2026-08-02T12:00:01Z",
        lockfile: lock({ verificationTime: "2026-08-02T12:00:01Z" }),
      }),
    );
    expectProblem(result, "lock-authority-unauthenticated");
    if (!result.ok) return;
    expect(result.value.output).toMatchObject({
      activation: "bundled",
      locked: { retrievedAt: "2026-08-02T12:00:01.000Z" },
    });
  });

  test("uses inclusive UTC calendar-day age boundaries and reports selected staleness", () => {
    const boundary = createOfflineStandardsStatus(
      request({ asOf: "2026-09-01T23:59:59Z", maxAgeDays: 30 }),
    );
    expect(boundary).toMatchObject({
      ok: true,
      value: { age: { bundled: { ageDays: 30, status: "current" } }, issues: [] },
    });
    const stale = createOfflineStandardsStatus(
      request({ asOf: "2026-09-02T00:00:00Z", maxAgeDays: 30 }),
    );
    expectProblem(stale, "selected-pack-stale");
    if (stale.ok) expect(stale.value.age.bundled).toMatchObject({ ageDays: 31, status: "stale" });
  });

  test("calculates locked age independently and applies it to selected-policy staleness", () => {
    const older = lockValue();
    (older["pack"] as Record<string, unknown>)["publishedAt"] = "2026-07-02";
    const serialized = serializeStandardsLockfile(older);
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
    const result = createOfflineStandardsStatus(
      request({ lockfile: serialized.text, maxAgeDays: 30 }),
    );
    expectProblem(result, "selected-pack-stale");
    if (!result.ok) return;
    expect(result.value.age).toMatchObject({
      bundled: { ageDays: 0, status: "current" },
      locked: { ageDays: 31, status: "stale" },
      policySelection: "locked",
    });
    expect(result.value.output.activation).toBe("bundled");
  });

  test.each([
    ["2026.8.0", "current"],
    ["2026.8.0+registry.7", "current"],
    ["2026.7.9", "current"],
    ["2026.8.1", "update-available"],
    ["2026.8.1-alpha.1", "update-available"],
  ] as const)("labels cached version %s as %s only as of its check", (packVersion, freshness) => {
    const result = createOfflineStandardsStatus(request({ cachedLatest: cached({ packVersion }) }));
    expect(result).toMatchObject({
      ok: true,
      value: {
        lastCheckedAt: "2026-08-01T12:00:00Z",
        output: {
          cachedLatest: { retrievedAt: "2026-08-01T12:00:00.000Z", version: packVersion },
          freshness,
        },
      },
    });
  });

  test.each([
    ["2026.8.0-alpha", "2026.8.0", "update-available"],
    ["2026.8.0", "2026.8.0-alpha", "current"],
    ["2026.8.0-alpha.1", "2026.8.0-alpha.2", "update-available"],
    ["2026.8.0-alpha.2", "2026.8.0-alpha.10", "update-available"],
    ["2026.8.0-beta", "2026.8.0-alpha", "current"],
    ["2026.8.0-alpha.1", "2026.8.0-alpha.beta", "update-available"],
    ["2026.8.0-alpha.beta", "2026.8.0-alpha.1", "current"],
    ["2026.8.0-alpha", "2026.8.0-alpha.1", "update-available"],
    ["2026.8.0-alpha.1", "2026.8.0-alpha", "current"],
    ["2026.8.0-alpha.1", "2026.8.0-alpha.1", "current"],
  ] as const)(
    "uses SemVer precedence for selected %s and cached %s",
    (selectedVersion, cachedVersion, freshness) => {
      const result = createOfflineStandardsStatus(
        request({
          cachedLatest: cached({ packVersion: cachedVersion }),
          lockfile: lockAtVersion(selectedVersion),
        }),
      );
      expect(result).toMatchObject({ ok: true, value: { output: { freshness } } });
    },
  );

  test("keeps an engine-incompatible cached update informational and explicit", () => {
    const result = createOfflineStandardsStatus(
      request({
        cachedLatest: cached({ minEngineVersion: "1.0.0", packVersion: "2027.1.0" }),
      }),
    );
    expectProblem(result, "cached-engine-incompatible");
    if (result.ok) {
      expect(result.value.output.freshness).toBe("update-available");
      expect(result.value.output.activation).toBe("bundled");
    }
  });

  test("fails cached wrong-channel, future, and malformed observations closed as offline problems", () => {
    const wrongChannel = createOfflineStandardsStatus(
      request({ cachedLatest: cached({ channel: "preview" }) }),
    );
    expectProblem(wrongChannel, "cached-channel-mismatch");
    if (wrongChannel.ok) expect(wrongChannel.value.output.cachedLatest).toBeNull();

    const future = createOfflineStandardsStatus(
      request({ cachedLatest: cached({ checkedAt: "2026-08-02T12:00:01Z" }) }),
    );
    expectProblem(future, "cached-from-future");

    for (const cachedLatest of [
      {},
      cached({ origin: "live" }),
      cached({ sha256: "bad" }),
      new Proxy(cached(), {}),
    ]) {
      const malformed = createOfflineStandardsStatus(request({ cachedLatest }));
      expectProblem(malformed, "cached-latest-invalid");
    }
  });

  test("reports malformed, wrong-channel, future, and incompatible locks without throwing", () => {
    expectProblem(createOfflineStandardsStatus(request({ lockfile: "{}" })), "invalid-lockfile");

    const preview = lockValue({ channel: "preview" });
    (preview["target"] as Record<string, unknown>)["channel"] = "preview";
    (preview["target"] as Record<string, unknown>)["targetPath"] =
      "knowledge/preview/agent-context-bundled-2026.8.0.json";
    const delegated = (preview["trustedState"] as Record<string, unknown>)["delegated"] as Record<
      string,
      unknown
    >;
    const previewSummary = structuredClone(delegated["stable"]);
    (previewSummary as Record<string, unknown>)["role"] = "standards-preview";
    delegated["preview"] = previewSummary;
    const previewLock = serializeStandardsLockfile(preview);
    if (!previewLock.ok) throw new Error(JSON.stringify(previewLock.issues));
    expectProblem(
      createOfflineStandardsStatus(request({ lockfile: previewLock.text })),
      "lock-channel-mismatch",
    );

    const futureLock = lockValue({ verificationTime: "2026-08-02T12:00:01Z" });
    const futureSerialized = serializeStandardsLockfile(futureLock);
    if (!futureSerialized.ok) throw new Error(JSON.stringify(futureSerialized.issues));
    expectProblem(
      createOfflineStandardsStatus(request({ lockfile: futureSerialized.text })),
      "lock-from-future",
    );

    const incompatible = lockValue();
    (incompatible["target"] as Record<string, unknown>)["minEngineVersion"] = "1.0.0";
    const incompatibleSerialized = serializeStandardsLockfile(incompatible);
    if (!incompatibleSerialized.ok) throw new Error(JSON.stringify(incompatibleSerialized.issues));
    expectProblem(
      createOfflineStandardsStatus(request({ lockfile: incompatibleSerialized.text })),
      "lock-engine-incompatible",
    );
    const incompatibleResult = createOfflineStandardsStatus(
      request({ lockfile: incompatibleSerialized.text }),
    );
    expectProblem(incompatibleResult, "lock-authority-unauthenticated");
    if (incompatibleResult.ok) expect(incompatibleResult.value.output.activation).toBe("bundled");
  });

  test("accepts both supported max-age boundaries and freezes sorted problem evidence", () => {
    for (const maxAgeDays of [MIN_STANDARDS_MAX_AGE_DAYS, MAX_STANDARDS_MAX_AGE_DAYS])
      expect(createOfflineStandardsStatus(request({ maxAgeDays }))).toMatchObject({ ok: true });

    const different = lockValue();
    (different["pack"] as Record<string, unknown>)["packVersion"] = "2026.7.0";
    (different["target"] as Record<string, unknown>)["packVersion"] = "2026.7.0";
    const serialized = serializeStandardsLockfile(different);
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
    const result = createOfflineStandardsStatus(
      request({
        asOf: "2026-09-02T00:00:00Z",
        cachedLatest: cached({ minEngineVersion: "1.0.0" }),
        lockfile: serialized.text,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.issues.map(({ code }) => code)).toEqual([
      "cached-engine-incompatible",
      "lock-authority-unauthenticated",
      "selected-pack-stale",
    ]);
    expect(result.value.output.problems).toEqual([
      "cached-engine-incompatible",
      "lock-authority-unauthenticated",
      "selected-pack-stale",
    ]);
    expect(Object.isFrozen(result.value.issues)).toBe(true);
    expect(Object.isFrozen(result.value.output.problems)).toBe(true);
  });

  test.each([
    [(): unknown => null, "invalid-input"],
    [(): unknown => [], "invalid-input"],
    [(): unknown => ({}), "invalid-input"],
    [(): unknown => request({ asOf: "invalid" }), "invalid-clock"],
    [(): unknown => request({ asOf: "2026-02-30T00:00:00Z" }), "invalid-clock"],
    [(): unknown => request({ engineVersion: "latest" }), "invalid-input"],
    [(): unknown => request({ engineVersion: `${"1".repeat(257)}.0.0` }), "invalid-input"],
    [(): unknown => request({ maxAgeDays: MIN_STANDARDS_MAX_AGE_DAYS - 1 }), "invalid-input"],
    [(): unknown => request({ maxAgeDays: 1.5 }), "invalid-input"],
    [(): unknown => request({ maxAgeDays: Number.NaN }), "invalid-input"],
    [(): unknown => request({ maxAgeDays: MAX_STANDARDS_MAX_AGE_DAYS + 1 }), "invalid-input"],
    [(): unknown => request({ bundled: structuredClone(bundled) }), "unauthenticated-bundle"],
    [(): unknown => request({ lockfile: new DataView(new ArrayBuffer(8)) }), "invalid-input"],
    [(): unknown => request({ asOf: "2026-08-02T11:59:59Z" }), "invalid-clock"],
  ] as const)("rejects invalid envelope %#", (input, code) => {
    expectFailure(createOfflineStandardsStatus(input()), code);
  });

  test("rejects accessors, symbols, proxies, exotic prototypes, and unexpected fields", () => {
    const accessor = request();
    Object.defineProperty(accessor, "asOf", {
      enumerable: true,
      get: () => "2026-08-02T12:00:00Z",
    });
    const symbol = request();
    Object.defineProperty(symbol, Symbol("x"), { value: true });
    const exotic = request();
    Object.setPrototypeOf(exotic, { inherited: true });
    for (const input of [
      accessor,
      symbol,
      exotic,
      new Proxy(request(), {}),
      { ...request(), extra: true },
    ])
      expectFailure(createOfflineStandardsStatus(input), "invalid-input");
  });

  test("accepts a closed null-prototype request without invoking inherited behavior", () => {
    const input = request();
    Object.setPrototypeOf(input, null);
    expect(createOfflineStandardsStatus(input)).toMatchObject({ ok: true });
  });

  test("is deterministic, schema-valid, and packaged with the runtime", () => {
    const first = createOfflineStandardsStatus(
      request({ cachedLatest: cached(), lockfile: lock() }),
    );
    const second = createOfflineStandardsStatus(
      request({ cachedLatest: cached(), lockfile: lock() }),
    );
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(first.value)).toBe(true);
    expect(first.value.issues.length).toBeLessThanOrEqual(MAX_OFFLINE_STANDARDS_STATUS_ISSUES);
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      exports?: Record<string, unknown>;
      files?: string[];
    };
    expect(manifest.files).toContain("schemas");
    expect(manifest.exports?.["./schemas/offline-standards-status.v0.schema.json"]).toBe(
      "./schemas/offline-standards-status.v0.schema.json",
    );
  });
});
