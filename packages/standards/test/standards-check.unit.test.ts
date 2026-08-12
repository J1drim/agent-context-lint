import { readFile } from "node:fs/promises";

import { canonicalize } from "@tufjs/canonical-json";
import { describe, expect, test, vi } from "vitest";

import {
  MAX_STANDARDS_CHECK_REQUESTS,
  OfflineTufTrustStore,
  STANDARDS_CHECK_CONTRACT_VERSION,
  StandardsChecker,
} from "../src/index.js";
import { createStandardsRegistryClientFixtureForTest } from "../src/registry-client.js";
import {
  consumeStandardsVerifiedUpdateForH09,
  createStandardsCheckerFixtureForTest,
} from "../src/standards-check.js";

import type {
  StandardsCheckIssue,
  StandardsCheckReport,
  StandardsCheckRequest,
  StandardsCheckResult,
  TufOfflineUpdateBundle,
} from "../src/index.js";

interface FakeRegistry {
  readonly aborts: ReturnType<typeof vi.fn>;
  readonly checker: StandardsChecker;
  readonly paths: string[];
}

interface BundledRepository {
  readonly delegated: Uint8Array;
  readonly pack: Uint8Array;
  readonly packDigest: string;
  readonly root: Uint8Array;
  readonly snapshot: Uint8Array;
  readonly targets: Uint8Array;
  readonly timestamp: Uint8Array;
  readonly trust: OfflineTufTrustStore;
}

const CHECK_TIME = Date.parse("2026-08-02T12:05:00Z");
const REQUEST: StandardsCheckRequest = Object.freeze({
  channel: "stable",
  engineVersion: "1.0.0",
  targetPath: "knowledge/stable/agent-context-bundled.json",
});

function chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let returned = false;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (returned) return Promise.resolve({ done: true, value: undefined });
          returned = true;
          return Promise.resolve({ done: false, value: bytes });
        },
      };
    },
  };
}

async function bundledRepository(): Promise<BundledRepository> {
  const directory = new URL("../bundled/", import.meta.url);
  const [root, timestamp, snapshot, targets, delegated, manifest] = await Promise.all([
    readFile(new URL("metadata/root.json", directory)),
    readFile(new URL("metadata/timestamp.json", directory)),
    readFile(new URL("metadata/snapshot.json", directory)),
    readFile(new URL("metadata/targets.json", directory)),
    readFile(new URL("metadata/standards-stable.json", directory)),
    readFile(new URL("manifest.v0.json", directory), "utf8"),
  ]);
  const parsed = JSON.parse(manifest) as {
    entries: readonly { content: { path: string; sha256: string } }[];
  };
  const packEntry = parsed.entries.find((entry) =>
    entry.content.path.startsWith("packs/sha256-"),
  )?.content;
  if (packEntry === undefined) throw new Error("bundled pack fixture is missing");
  const pack = await readFile(new URL(packEntry.path, directory));
  const bootstrapped = OfflineTufTrustStore.bootstrap(root);
  if (!bootstrapped.ok) throw new Error(JSON.stringify(bootstrapped.issues));
  return {
    delegated,
    pack,
    packDigest: packEntry.sha256,
    root,
    snapshot,
    targets,
    timestamp,
    trust: bootstrapped.value,
  };
}

function objects(repository: BundledRepository): ReadonlyMap<string, Uint8Array> {
  return new Map([
    ["/v1/metadata/timestamp.json", repository.timestamp],
    ["/v1/metadata/1.snapshot.json", repository.snapshot],
    ["/v1/metadata/1.targets.json", repository.targets],
    ["/v1/metadata/1.standards-stable.json", repository.delegated],
    [`/v1/packs/sha256-${repository.packDigest}.json`, repository.pack],
  ]);
}

function fakeRegistry(
  trust: OfflineTufTrustStore,
  selectedObjects: ReadonlyMap<string, Uint8Array>,
  clock: number | (() => number) = CHECK_TIME,
  nonsettlingPath?: string,
): FakeRegistry {
  const paths: string[] = [];
  const aborts = vi.fn((): Promise<void> => Promise.resolve());
  const registry = createStandardsRegistryClientFixtureForTest({
    dns: {
      start: () => ({
        abort: (): Promise<void> => Promise.resolve(),
        result: Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      }),
    },
    transport: {
      start(request) {
        paths.push(request.path);
        const bytes = selectedObjects.get(request.path);
        const response =
          request.path === nonsettlingPath
            ? new Promise<never>(() => undefined)
            : Promise.resolve({
                body: chunks(bytes ?? new Uint8Array()),
                rawHeaders: [
                  "Content-Type",
                  "application/json",
                  "Content-Length",
                  String(bytes?.byteLength ?? 0),
                ],
                statusCode: bytes === undefined ? 404 : 200,
              });
        return {
          abort: aborts,
          connected: Promise.resolve(),
          response,
          secured: Promise.resolve(),
        };
      },
    },
  });
  return {
    aborts,
    checker: createStandardsCheckerFixtureForTest(trust, registry, {
      nowMilliseconds: typeof clock === "function" ? clock : (): number => clock,
    }),
    paths,
  };
}

function options(signal: AbortSignal = new AbortController().signal): { signal: AbortSignal } {
  return { signal };
}

function expectIssue(
  result: StandardsCheckResult<StandardsCheckReport>,
  expected: Partial<StandardsCheckIssue>,
): StandardsCheckIssue {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected standards check failure");
  expect(result.issues).toEqual([expect.objectContaining(expected)]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.issues)).toBe(true);
  expect(Object.isFrozen(result.issues[0])).toBe(true);
  const issue = result.issues[0];
  if (issue === undefined) throw new Error("expected issue");
  return issue;
}

function trustedCurrent(repository: BundledRepository): OfflineTufTrustStore {
  const bundle: TufOfflineUpdateBundle = {
    delegatedTargets: repository.delegated,
    snapshot: repository.snapshot,
    target: repository.pack,
    targets: repository.targets,
    timestamp: repository.timestamp,
  };
  const verified = repository.trust.verifyUpdate(bundle, {
    ...REQUEST,
    startedAt: "2026-08-02T12:05:00Z",
  });
  if (!verified.ok) throw new Error(JSON.stringify(verified.issues));
  return verified.value.state;
}

describe("H08 explicit signed standards check", () => {
  test("acquires one consistent snapshot and returns only a frozen verified comparison", async () => {
    const repository = await bundledRepository();
    const selected = fakeRegistry(repository.trust, objects(repository));
    const before = repository.trust.snapshot();
    const result = await selected.checker.check(REQUEST, options());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value).toMatchObject({
      checkedAt: "2026-08-02T12:05:00Z",
      contractVersion: STANDARDS_CHECK_CONTRACT_VERSION,
      requestsAttempted: 6,
      target: {
        channel: "stable",
        sha256: repository.packDigest,
        targetPath: REQUEST.targetPath,
      },
    });
    expect(result.value.current).toEqual(before);
    expect(result.value.candidate.timestamp?.version).toBe(1);
    expect(result.value.acquisitions).toHaveLength(5);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.acquisitions)).toBe(true);
    expect(result.value).not.toHaveProperty("state");
    expect(result.value).not.toHaveProperty("targetBytes");
    expect(repository.trust.snapshot()).toEqual(before);
    expect(selected.paths).toEqual([
      "/v1/metadata/2.root.json",
      "/v1/metadata/timestamp.json",
      "/v1/metadata/1.snapshot.json",
      "/v1/metadata/1.targets.json",
      "/v1/metadata/1.standards-stable.json",
      `/v1/packs/sha256-${repository.packDigest}.json`,
    ]);
    expect(selected.paths.every((path) => !path.includes("?") && !path.includes("#"))).toBe(true);
  });

  test("hands verified target bytes to H09 exactly once without adding them to the public report", async () => {
    const repository = await bundledRepository();
    const selected = fakeRegistry(repository.trust, objects(repository));
    const result = await selected.checker.check(REQUEST, options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("targetBytes");
    const authority = consumeStandardsVerifiedUpdateForH09(result.value);
    expect(Buffer.from(authority?.targetBytes ?? [])).toEqual(repository.pack);
    expect(authority?.state.snapshot()).toEqual(result.value.candidate);
    expect(consumeStandardsVerifiedUpdateForH09(result.value)).toBeUndefined();
  });

  test("construction and trusted-state inspection are offline until check is invoked", async () => {
    const repository = await bundledRepository();
    const selected = fakeRegistry(repository.trust, objects(repository));
    expect(selected.paths).toEqual([]);
    repository.trust.snapshot();
    expect(selected.paths).toEqual([]);
    await selected.checker.check(REQUEST, options());
    expect(selected.paths.length).toBeGreaterThan(0);
  });

  test("the production check is honestly default-deny with no deployed origin", async () => {
    const repository = await bundledRepository();
    const result = await StandardsChecker.create(repository.trust).check(REQUEST, options());
    expectIssue(result, { code: "registry-unconfigured", phase: "root", source: "registry" });
  });

  test.each([
    null,
    {},
    { channel: "other", engineVersion: "1.0.0", targetPath: REQUEST.targetPath },
    { channel: "stable", engineVersion: "01.0.0", targetPath: REQUEST.targetPath },
    { channel: "stable", engineVersion: "1.0.0", targetPath: "../secret" },
    { channel: "stable", engineVersion: "1.0.0", extra: true, targetPath: REQUEST.targetPath },
  ])("rejects malformed request before clock or network: %j", async (request) => {
    const repository = await bundledRepository();
    const selected = fakeRegistry(repository.trust, objects(repository));
    const result = await selected.checker.check(request as StandardsCheckRequest, options());
    expectIssue(result, { code: "invalid-input", source: "check" });
    expect(selected.paths).toEqual([]);
  });

  test("rejects exotic request records and non-native cancellation before network", async () => {
    const repository = await bundledRepository();
    const selected = fakeRegistry(repository.trust, objects(repository));
    const inherited = Object.create(Date.prototype) as StandardsCheckRequest;
    Object.assign(inherited, REQUEST);
    const symbolic = { ...REQUEST };
    Object.defineProperty(symbolic, Symbol("hidden"), { value: true });
    const accessor = { ...REQUEST };
    Object.defineProperty(accessor, "channel", { get: () => "stable" });
    for (const request of [inherited, symbolic, accessor])
      expectIssue(await selected.checker.check(request, options()), { code: "invalid-input" });
    expectIssue(
      await selected.checker.check(REQUEST, { signal: null } as unknown as { signal: AbortSignal }),
      { code: "invalid-input" },
    );
    expect(selected.paths).toEqual([]);
  });

  test("rejects a forged trusted store before clock or network", async () => {
    const repository = await bundledRepository();
    const selected = fakeRegistry({} as OfflineTufTrustStore, objects(repository), (): number => {
      throw new Error("clock must not run");
    });
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "invalid-input",
      path: "$trust",
    });
    expect(selected.paths).toEqual([]);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, Date.UTC(10_000, 0, 1)])(
    "rejects ambiguous clock value %s before network",
    async (clock) => {
      const repository = await bundledRepository();
      const selected = fakeRegistry(repository.trust, objects(repository), clock);
      expectIssue(await selected.checker.check(REQUEST, options()), {
        code: "invalid-clock",
        phase: "clock",
      });
      expect(selected.paths).toEqual([]);
    },
  );

  test("sanitizes a throwing clock without starting network", async () => {
    const repository = await bundledRepository();
    const selected = fakeRegistry(repository.trust, objects(repository), () => {
      throw new Error("private clock detail");
    });
    const result = await selected.checker.check(REQUEST, options());
    expectIssue(result, { code: "invalid-clock", phase: "clock" });
    expect(JSON.stringify(result)).not.toContain("private clock detail");
    expect(selected.paths).toEqual([]);
  });

  test("rejects signed metadata issued implausibly in the future", async () => {
    const repository = await bundledRepository();
    const selected = fakeRegistry(
      repository.trust,
      objects(repository),
      Date.parse("2026-08-02T11:54:00Z"),
    );
    const issue = expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "invalid-policy",
      source: "trust",
    });
    expect(issue.message).toContain("future");
  });

  test("rejects expired metadata as a visible freeze failure", async () => {
    const repository = await bundledRepository();
    const selected = fakeRegistry(
      repository.trust,
      objects(repository),
      Date.parse("2026-08-03T12:00:00Z"),
    );
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "expired-metadata",
      source: "trust",
    });
  });

  test("rejects a replay against already trusted online metadata without mutating it", async () => {
    const repository = await bundledRepository();
    const current = trustedCurrent(repository);
    const before = current.snapshot();
    const selected = fakeRegistry(current, objects(repository));
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "replay",
      source: "trust",
    });
    expect(current.snapshot()).toEqual(before);
  });

  test("rejects a mix-and-match snapshot before exposing candidate authority", async () => {
    const repository = await bundledRepository();
    const mismatched = new Map(objects(repository));
    const snapshotObject = JSON.parse(Buffer.from(repository.snapshot).toString("utf8")) as {
      signed: { expires: string };
    };
    snapshotObject.signed.expires = "2026-08-08T23:59:59Z";
    mismatched.set("/v1/metadata/1.snapshot.json", Buffer.from(canonicalize(snapshotObject)));
    const selected = fakeRegistry(repository.trust, mismatched);
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "hash-mismatch",
      source: "trust",
    });
  });

  test("rejects wrong target bytes through the signed length/digest binding", async () => {
    const repository = await bundledRepository();
    const mismatched = new Map(objects(repository));
    mismatched.set(
      `/v1/packs/sha256-${repository.packDigest}.json`,
      new Uint8Array(repository.pack.byteLength),
    );
    const selected = fakeRegistry(repository.trust, mismatched);
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "hash-mismatch",
      source: "trust",
    });
  });

  test("rejects malformed and ambiguous routing metadata before derived fetches", async () => {
    const repository = await bundledRepository();
    const malformed = new Map(objects(repository));
    malformed.set("/v1/metadata/timestamp.json", Buffer.from('{"signed":{"meta":{}}}'));
    const selected = fakeRegistry(repository.trust, malformed);
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "invalid-routing-metadata",
      phase: "timestamp",
      source: "check",
    });
    expect(selected.paths).toEqual(["/v1/metadata/2.root.json", "/v1/metadata/timestamp.json"]);
  });

  test.each([
    Uint8Array.of(0xff),
    Buffer.from("\uFEFF{}"),
    Buffer.from("{"),
    Buffer.from("}"),
    Buffer.from("{,}"),
    Buffer.from("[]"),
    Buffer.from("[".repeat(65) + "]".repeat(65)),
    Buffer.from("[" + "0,".repeat(50_001) + "0]"),
    Buffer.from('{"note":"escaped\\nvalue","signed":{"meta":{"snapshot.json":{"version":"1"}}}}'),
  ])("rejects hostile routing JSON without deriving a path", async (timestamp) => {
    const repository = await bundledRepository();
    const hostile = new Map(objects(repository));
    hostile.set("/v1/metadata/timestamp.json", timestamp);
    const selected = fakeRegistry(repository.trust, hostile);
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "invalid-routing-metadata",
      phase: "timestamp",
    });
    expect(selected.paths).toEqual(["/v1/metadata/2.root.json", "/v1/metadata/timestamp.json"]);
  });

  test("rejects an invalid unauthenticated pack route before requesting any pack", async () => {
    const repository = await bundledRepository();
    const hostile = new Map(objects(repository));
    hostile.set(
      "/v1/metadata/1.standards-stable.json",
      Buffer.from(
        JSON.stringify({
          signed: {
            targets: { [REQUEST.targetPath]: { hashes: { sha256: "not-a-digest" } } },
          },
        }),
      ),
    );
    const selected = fakeRegistry(repository.trust, hostile);
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "invalid-routing-metadata",
      phase: "delegated-targets",
    });
    expect(selected.paths.some((path) => path.startsWith("/v1/packs/"))).toBe(false);
  });

  test("propagates a missing required object as a bounded registry failure", async () => {
    const repository = await bundledRepository();
    const missing = new Map(objects(repository));
    missing.delete("/v1/metadata/1.snapshot.json");
    const selected = fakeRegistry(repository.trust, missing);
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "not-found",
      phase: "snapshot",
      source: "registry",
    });
  });

  test("bounds sequential root discovery and never proceeds to online roles", async () => {
    const repository = await bundledRepository();
    const excessive = new Map(objects(repository));
    for (let version = 2; version <= 34; version += 1)
      excessive.set(`/v1/metadata/${String(version)}.root.json`, repository.root);
    const selected = fakeRegistry(repository.trust, excessive);
    expectIssue(await selected.checker.check(REQUEST, options()), {
      code: "root-chain-limit",
      phase: "root",
      source: "check",
    });
    expect(selected.paths).toHaveLength(MAX_STANDARDS_CHECK_REQUESTS - 5);
    expect(selected.paths).not.toContain("/v1/metadata/timestamp.json");
  });

  test("propagates cancellation and confirms active transport cleanup", async () => {
    const repository = await bundledRepository();
    const controller = new AbortController();
    const selected = fakeRegistry(
      repository.trust,
      objects(repository),
      CHECK_TIME,
      "/v1/metadata/timestamp.json",
    );
    const resultPromise = selected.checker.check(REQUEST, options(controller.signal));
    await vi.waitFor(() => {
      expect(selected.paths).toContain("/v1/metadata/timestamp.json");
    });
    controller.abort(new Error("private cancellation reason"));
    const result = await resultPromise;
    expectIssue(result, { code: "cancelled", phase: "timestamp", source: "registry" });
    expect(JSON.stringify(result)).not.toContain("private cancellation reason");
    expect(selected.aborts).toHaveBeenCalled();
  });
});
