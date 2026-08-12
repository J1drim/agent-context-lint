import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";

import {
  DEFAULT_STANDARDS_LOCKFILE_PATH,
  OfflineTufTrustStore,
  STANDARDS_UPDATE_CONTRACT_VERSION,
  StandardsChecker,
  StandardsUpdater,
  loadBundledKnowledgePack,
  parseCanonicalStandardsLockfile,
  rollbackStandardsUpdate,
  serializeKnowledgePack,
  serializeStandardsLockfile,
} from "../src/index.js";
import { openStandardsCacheFixtureForTest } from "../src/standards-cache.js";
import { createStandardsUpdaterFixtureForTest } from "../src/standards-update.js";

import type {
  KnowledgePack,
  LoadedBundledKnowledgePack,
  StandardsActivationOptions,
  StandardsCache,
  StandardsCheckIssue,
  StandardsCheckReport,
  StandardsLockfile,
  StandardsLockfileAtomicWriteRequest,
  StandardsLockfileAtomicWriteResult,
  StandardsLockfileAtomicWriter,
  StandardsUpdateIssue,
  StandardsUpdateResult,
} from "../src/index.js";

const HASH_B = "b".repeat(64);
const SCHEMA = new URL("../schemas/standards-update.v0.schema.json", import.meta.url);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const BUNDLED_ROOT = new URL("../bundled/metadata/root.json", import.meta.url);
let bundled: LoadedBundledKnowledgePack;
let currentPackText: string;
let currentLockText: string;

interface FixtureCandidate {
  readonly report: StandardsCheckReport;
  readonly targetBytes: Uint8Array;
}

type FixtureCheckResult = StandardsUpdateResult<FixtureCandidate>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function serializePack(pack: unknown): string {
  const result = serializeKnowledgePack(pack);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.text;
}

function serializeLock(lock: unknown): string {
  const result = serializeStandardsLockfile(lock);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.text;
}

function currentLock(): StandardsLockfile {
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
    target: bundled.provenance.target,
    trustedState: bundled.provenance.trustedState,
    verificationTime: bundled.provenance.verificationTime,
  };
}

function candidatePack(): { readonly bytes: Uint8Array; readonly pack: KnowledgePack } {
  const pack = structuredClone(bundled.pack) as KnowledgePack & {
    knowledge: KnowledgePack["knowledge"];
    packVersion: string;
  };
  Object.defineProperty(pack, "packVersion", {
    configurable: true,
    enumerable: true,
    value: "2026.8.1",
  });
  const record = structuredClone(pack.knowledge[0]);
  if (record === undefined) throw new Error("bundled fixture has no knowledge record");
  Object.defineProperty(record, "id", {
    configurable: true,
    enumerable: true,
    value: "knowledge.second",
  });
  Object.defineProperty(record, "ruleIds", {
    configurable: true,
    enumerable: true,
    value: ["ACL106"],
  });
  Object.defineProperty(pack, "knowledge", {
    configurable: true,
    enumerable: true,
    value: [structuredClone(pack.knowledge[0]), record],
  });
  const text = serializePack(pack);
  const parsed = JSON.parse(text) as KnowledgePack;
  return { bytes: Buffer.from(text), pack: parsed };
}

function reportFor(bytes: Uint8Array, pack: KnowledgePack): StandardsCheckReport {
  return Object.freeze({
    acquisitions: Object.freeze([]),
    candidate: bundled.provenance.trustedState,
    checkedAt: bundled.provenance.verificationTime,
    contractVersion: "0.1.0",
    current: bundled.provenance.trustedState,
    recovery: Object.freeze({
      rootVersionsApplied: Object.freeze([]),
      snapshotAuthorityRotated: false,
      timestampAuthorityRotated: false,
    }),
    requestsAttempted: 6,
    target: Object.freeze({
      ...bundled.provenance.target,
      length: bytes.byteLength,
      packVersion: pack.packVersion,
      sha256: sha256(bytes),
    }),
  });
}

function sourceFor(
  bytes: Uint8Array,
  pack: KnowledgePack,
): { readonly check: ReturnType<typeof vi.fn>; readonly updater: StandardsUpdater } {
  const check = vi.fn((): Promise<FixtureCheckResult> =>
    Promise.resolve({
      ok: true as const,
      value: Object.freeze({ report: reportFor(bytes, pack), targetBytes: new Uint8Array(bytes) }),
    }),
  );
  return { check, updater: createStandardsUpdaterFixtureForTest({ check }) };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    check: {
      channel: "stable",
      engineVersion: "1.0.0",
      targetPath: bundled.provenance.target.targetPath,
    },
    currentLockfile: currentLockText,
    currentPack: currentPackText,
    ...overrides,
  };
}

function checkOptions(): { readonly signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

async function cacheFixture(
  hooks: Parameters<typeof openStandardsCacheFixtureForTest>[1] = {},
): Promise<{ readonly cache: StandardsCache; readonly root: string }> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-context-h09-")));
  onTestFinished(async () => rm(directory, { force: true, recursive: true }));
  const root = path.join(directory, "cache");
  const opened = await openStandardsCacheFixtureForTest(root, hooks);
  if (!opened.ok) throw new Error(JSON.stringify(opened.issues));
  return { cache: opened.value, root };
}

async function cache(): Promise<StandardsCache> {
  return (await cacheFixture()).cache;
}

function writer(options: { readonly fail?: Error } = {}): {
  readonly calls: StandardsLockfileAtomicWriteRequest[];
  readonly writer: StandardsLockfileAtomicWriter;
} {
  const calls: StandardsLockfileAtomicWriteRequest[] = [];
  return {
    calls,
    writer: {
      write(request): Promise<StandardsLockfileAtomicWriteResult> {
        const selected = request as StandardsLockfileAtomicWriteRequest;
        calls.push(selected);
        if (options.fail !== undefined) return Promise.reject(options.fail);
        const result: StandardsLockfileAtomicWriteResult = Object.freeze({
          bytesWritten: selected.replacement.byteLength,
          contractVersion: "0.1.0",
          directorySync: "synced",
          durability: "file-and-directory",
          identity: Object.freeze({ device: "9", inode: String(calls.length + 9) }),
          mode: 0o600,
          path: selected.path,
          previousSha256: selected.expected.sha256,
          sha256: sha256(selected.replacement),
        });
        return Promise.resolve(result);
      },
    },
  };
}

function activationOptions(
  selectedCache: StandardsCache,
  selectedWriter: StandardsLockfileAtomicWriter,
): StandardsActivationOptions {
  return {
    cache: selectedCache,
    cacheLock: { maxAttempts: 1, retryDelayMs: 0 },
    expected: { identity: { device: "1", inode: "2" }, sha256: sha256(currentLockText) },
    path: DEFAULT_STANDARDS_LOCKFILE_PATH,
    signal: new AbortController().signal,
    writer: selectedWriter,
  };
}

function expectIssue<T>(
  result: StandardsUpdateResult<T>,
  code: StandardsUpdateIssue["code"],
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected update failure");
  expect(result.issues).toEqual([expect.objectContaining({ code })]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.issues)).toBe(true);
}

beforeAll(async () => {
  const loaded = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  bundled = loaded.value;
  currentPackText = serializePack(bundled.pack);
  currentLockText = serializeLock(currentLock());
});

describe("H09 standards update transaction", () => {
  test("dry-run reports rules, engine requirement, digest, and signer without write authority", async () => {
    const candidate = candidatePack();
    const selected = sourceFor(candidate.bytes, candidate.pack);
    const plan = await selected.updater.dryRun(request(), checkOptions());
    expect(plan).toMatchObject({
      ok: true,
      value: {
        contractVersion: STANDARDS_UPDATE_CONTRACT_VERSION,
        diff: {
          digest: { current: bundled.provenance.target.sha256, candidate: sha256(candidate.bytes) },
          engineRequirement: { current: "0.0.0", candidate: "0.0.0" },
          rules: { added: ["ACL106"], removed: [] },
          version: { current: "2026.8.0", candidate: "2026.8.1" },
        },
        mode: "dry-run",
        noChanges: false,
        signer: { authorizedKeyCount: 3, role: "standards-stable", threshold: 2 },
      },
    });
    expect(selected.check).toHaveBeenCalledOnce();
  });

  test("publishes verified bytes before one atomic activation and rolls back once", async () => {
    const candidate = candidatePack();
    const selected = sourceFor(candidate.bytes, candidate.pack);
    const selectedCache = await cache();
    const selectedWriter = writer();
    const activated = await selected.updater.activate(
      request(),
      activationOptions(selectedCache, selectedWriter.writer),
    );
    expect(activated).toMatchObject({
      ok: true,
      value: { activation: "activated", cache: "stored", plan: { mode: "update" } },
    });
    if (!activated.ok || activated.value.receipt === null) throw new Error("expected receipt");
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(activated.value)).toBe(true);
    expect(selectedWriter.calls).toHaveLength(1);
    expect(
      parseCanonicalStandardsLockfile(selectedWriter.calls[0]?.replacement ?? ""),
    ).toMatchObject({
      ok: true,
      value: { pack: { packVersion: "2026.8.1" } },
    });
    expect(
      await selectedCache.readEntry({
        kind: "artifact",
        length: candidate.bytes.byteLength,
        sha256: sha256(candidate.bytes),
      }),
    ).toMatchObject({ ok: true });

    const rolledBack = await rollbackStandardsUpdate(
      selectedWriter.writer,
      activated.value.receipt,
    );
    expect(rolledBack).toMatchObject({
      ok: true,
      value: { replacedVersion: "2026.8.1", restoredVersion: "2026.8.0" },
    });
    if (!rolledBack.ok) throw new Error("expected rollback");
    expect(validate(rolledBack.value)).toBe(true);
    expect(selectedWriter.calls).toHaveLength(2);
    expect(
      parseCanonicalStandardsLockfile(selectedWriter.calls[1]?.replacement ?? ""),
    ).toMatchObject({
      ok: true,
      value: { pack: { packVersion: "2026.8.0" } },
    });
    expectIssue(
      await rollbackStandardsUpdate(selectedWriter.writer, activated.value.receipt),
      "rollback-invalid",
    );
  });

  test("is idempotent when the canonical candidate lock is already active", async () => {
    const bytes = Buffer.from(currentPackText);
    const selected = sourceFor(bytes, bundled.pack);
    const selectedCache = await cache();
    const selectedWriter = writer();
    const result = await selected.updater.activate(
      request(),
      activationOptions(selectedCache, selectedWriter.writer),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { activation: "unchanged", cache: "not-needed", receipt: null, write: null },
    });
    expect(selectedWriter.calls).toEqual([]);
  });

  test.each([
    [{ currentLockfile: "{}" }, "current-lock-invalid"],
    [{ currentPack: "{}" }, "current-pack-invalid"],
  ] as const)("rejects invalid current evidence %#", async (overrides, code) => {
    const candidate = candidatePack();
    const result = await sourceFor(candidate.bytes, candidate.pack).updater.dryRun(
      request(overrides),
      checkOptions(),
    );
    expectIssue(result, code);
  });

  test("rejects a valid current pack whose digest is not the lock binding", async () => {
    const different = structuredClone(bundled.pack) as unknown as Record<string, unknown>;
    different["packVersion"] = "2026.8.9";
    const candidate = candidatePack();
    expectIssue(
      await sourceFor(candidate.bytes, candidate.pack).updater.dryRun(
        request({ currentPack: serializePack(different) }),
        checkOptions(),
      ),
      "current-binding-mismatch",
    );
  });

  test("rejects current trust substitution before candidate activation", async () => {
    const changed = currentLock();
    const trustedState = structuredClone(changed.trustedState);
    (trustedState.root as unknown as Record<string, unknown>)["sha256"] = HASH_B;
    const candidate = candidatePack();
    expectIssue(
      await sourceFor(candidate.bytes, candidate.pack).updater.dryRun(
        request({ currentLockfile: serializeLock({ ...changed, trustedState }) }),
        checkOptions(),
      ),
      "current-trust-mismatch",
    );
  });

  test.each(["invalid-signature", "rollback"] as const)(
    "preserves H08 %s rejection and performs no write",
    async (code) => {
      const issue: StandardsCheckIssue = Object.freeze({
        code,
        message: "verified metadata rejected",
        path: "$bundle",
        phase: "trust",
        source: "trust",
      });
      const updater = createStandardsUpdaterFixtureForTest({
        check: () =>
          Promise.resolve(
            Object.freeze({
              issues: Object.freeze([{ ...issue, source: "check" as const }]),
              ok: false,
            }),
          ),
      });
      expectIssue(await updater.dryRun(request(), checkOptions()), code);
    },
  );

  test("fails closed on malformed candidate bytes and target binding substitution", async () => {
    const malformed = Buffer.from("{}");
    expectIssue(
      await sourceFor(malformed, bundled.pack).updater.dryRun(request(), checkOptions()),
      "candidate-pack-invalid",
    );
    const candidate = candidatePack();
    const check = (): Promise<FixtureCheckResult> =>
      Promise.resolve({
        ok: true as const,
        value: { report: reportFor(candidate.bytes, bundled.pack), targetBytes: candidate.bytes },
      });
    expectIssue(
      await createStandardsUpdaterFixtureForTest({ check }).dryRun(request(), checkOptions()),
      "candidate-binding-mismatch",
    );
  });

  test.each(["missing-signer", "invalid-state"] as const)(
    "rejects candidate authority with %s evidence",
    async (mode) => {
      const candidate = candidatePack();
      const original = reportFor(candidate.bytes, candidate.pack);
      const report = {
        ...structuredClone(original),
        current: original.current,
      };
      if (mode === "missing-signer")
        (report.candidate.delegated as { stable: unknown }).stable = null;
      else (report.candidate.root as unknown as { sha256: string }).sha256 = "bad";
      const updater = createStandardsUpdaterFixtureForTest({
        check: () =>
          Promise.resolve({
            ok: true as const,
            value: { report, targetBytes: candidate.bytes },
          }),
      });
      expectIssue(await updater.dryRun(request(), checkOptions()), "candidate-binding-mismatch");
    },
  );

  test("cache contention aborts before lock mutation", async () => {
    const candidate = candidatePack();
    const selected = sourceFor(candidate.bytes, candidate.pack);
    const selectedCache = await cache();
    const held = await selectedCache.acquireWriteLock({
      maxAttempts: 1,
      retryDelayMs: 0,
      signal: new AbortController().signal,
    });
    if (!held.ok) throw new Error(JSON.stringify(held.issues));
    const selectedWriter = writer();
    expectIssue(
      await selected.updater.activate(
        request(),
        activationOptions(selectedCache, selectedWriter.writer),
      ),
      "lock-timeout",
    );
    expect(selectedWriter.calls).toEqual([]);
    await held.value.release();
  });

  test("rejects corrupt cached candidate bytes before lock mutation", async () => {
    const candidate = candidatePack();
    const selected = await cacheFixture();
    const digest = sha256(candidate.bytes);
    const parent = path.join(selected.root, "v1", "artifacts", "sha256", digest.slice(0, 2));
    await mkdir(parent, { mode: 0o700 });
    const corrupt = new Uint8Array(candidate.bytes);
    corrupt[0] = (corrupt[0] ?? 0) ^ 1;
    await writeFile(path.join(parent, `${digest.slice(2)}.bin`), corrupt, { mode: 0o600 });
    const selectedWriter = writer();
    expectIssue(
      await sourceFor(candidate.bytes, candidate.pack).updater.activate(
        request(),
        activationOptions(selected.cache, selectedWriter.writer),
      ),
      "digest-mismatch",
    );
    expect(selectedWriter.calls).toEqual([]);
  });

  test("reuses a candidate published by a cache race before lock mutation", async () => {
    const candidate = candidatePack();
    const digest = sha256(candidate.bytes);
    let root = "";
    const selected = await cacheFixture({
      afterLockOwnerWrite: async () => {
        const parent = path.join(root, "v1", "artifacts", "sha256", digest.slice(0, 2));
        await mkdir(parent, { mode: 0o700 });
        await writeFile(path.join(parent, `${digest.slice(2)}.bin`), candidate.bytes, {
          mode: 0o600,
        });
      },
    });
    root = selected.root;
    const selectedWriter = writer();
    const result = await sourceFor(candidate.bytes, candidate.pack).updater.activate(
      request(),
      activationOptions(selected.cache, selectedWriter.writer),
    );
    expect(result).toMatchObject({ ok: true, value: { cache: "reused" } });
    expect(selectedWriter.calls).toHaveLength(1);
  });

  test.each(["store", "release"] as const)(
    "fails closed when cache %s cannot complete",
    async (phase) => {
      const candidate = candidatePack();
      const selected = await cacheFixture(
        phase === "store"
          ? { afterTemporaryWrite: (): Promise<never> => Promise.reject(new Error("store failed")) }
          : {
              beforeLockOwnerRelease: (): Promise<never> =>
                Promise.reject(new Error("release failed")),
            },
      );
      const selectedWriter = writer();
      expectIssue(
        await sourceFor(candidate.bytes, candidate.pack).updater.activate(
          request(),
          activationOptions(selected.cache, selectedWriter.writer),
        ),
        "io-failure",
      );
      expect(selectedWriter.calls).toEqual([]);
    },
  );

  test("propagates interruption/concurrency writer truth without claiming rollback", async () => {
    const candidate = candidatePack();
    const selectedCache = await cache();
    const interruption = Object.assign(new Error("atomic write interrupted"), { committed: false });
    const selectedWriter = writer({ fail: interruption });
    await expect(
      sourceFor(candidate.bytes, candidate.pack).updater.activate(
        request(),
        activationOptions(selectedCache, selectedWriter.writer),
      ),
    ).rejects.toBe(interruption);
    expect(selectedWriter.calls).toHaveLength(1);
  });

  test("retains an authentic receipt after a precommit rollback interruption", async () => {
    const candidate = candidatePack();
    const selectedCache = await cache();
    const activatingWriter = writer();
    const activated = await sourceFor(candidate.bytes, candidate.pack).updater.activate(
      request(),
      activationOptions(selectedCache, activatingWriter.writer),
    );
    if (!activated.ok || activated.value.receipt === null) throw new Error("expected receipt");
    const interruption = Object.assign(new Error("rollback interrupted"), { committed: false });
    const interruptedWriter = writer({ fail: interruption });
    await expect(
      rollbackStandardsUpdate(interruptedWriter.writer, activated.value.receipt),
    ).rejects.toBe(interruption);
    const retryWriter = writer();
    expect(
      await rollbackStandardsUpdate(retryWriter.writer, activated.value.receipt),
    ).toMatchObject({
      ok: true,
      value: { restoredVersion: "2026.8.0" },
    });
    expect(interruptedWriter.calls).toHaveLength(1);
    expect(retryWriter.calls).toHaveLength(1);
  });

  test("rejects forged, copied, proxied, and reused rollback receipts", async () => {
    const selectedWriter = writer();
    for (const receipt of [
      {},
      structuredClone({ recordKind: "agent-context-standards-rollback-receipt" }),
      new Proxy({}, {}),
    ])
      expectIssue(
        await rollbackStandardsUpdate(selectedWriter.writer, receipt),
        "rollback-invalid",
      );
    expect(selectedWriter.calls).toEqual([]);
  });

  test("rejects hostile update request containers before checking", async () => {
    const candidate = candidatePack();
    const accessor = request();
    Object.defineProperty(accessor, "currentPack", {
      enumerable: true,
      get: () => currentPackText,
    });
    const exotic = request();
    Object.setPrototypeOf(exotic, { hostile: true });
    for (const value of [
      null,
      [],
      accessor,
      exotic,
      new Proxy(request(), {}),
      { ...request(), extra: true },
    ])
      expectIssue(
        await sourceFor(candidate.bytes, candidate.pack).updater.dryRun(value, checkOptions()),
        "invalid-input",
      );
  });

  test("rejects hostile activation capabilities and bounds before checking or mutation", async () => {
    const candidate = candidatePack();
    const selectedCache = await cache();
    const selectedWriter = writer();
    const valid = activationOptions(selectedCache, selectedWriter.writer);
    const accessorWriter = {};
    Object.defineProperty(accessorWriter, "write", {
      enumerable: true,
      get: () => vi.fn(),
    });
    const proxiedPrototypeWriter = {};
    Reflect.setPrototypeOf(proxiedPrototypeWriter, new Proxy({}, {}));
    const cases: unknown[] = [
      { ...valid, writer: {} },
      { ...valid, writer: accessorWriter },
      { ...valid, writer: new Proxy(selectedWriter.writer, {}) },
      { ...valid, writer: proxiedPrototypeWriter },
      { ...valid, cache: {} },
      { ...valid, path: "../agent-context-standards.lock.json" },
      { ...valid, path: "." },
      { ...valid, path: 1 },
      { ...valid, expected: { ...valid.expected, sha256: "bad" } },
      {
        ...valid,
        expected: { ...valid.expected, identity: { device: "-1", inode: "2" } },
      },
      {
        ...valid,
        expected: { ...valid.expected, identity: { device: "1", inode: "02" } },
      },
      {
        ...valid,
        expected: { ...valid.expected, identity: { device: "1".repeat(65), inode: "2" } },
      },
      { ...valid, signal: {} },
      { ...valid, cacheLock: { maxAttempts: 101, retryDelayMs: 0 } },
      { ...valid, cacheLock: { maxAttempts: 31, retryDelayMs: 1_000 } },
      { ...valid, extra: true },
    ];
    for (const options of cases) {
      const selected = sourceFor(candidate.bytes, candidate.pack);
      expectIssue(await selected.updater.activate(request(), options), "invalid-input");
      expect(selected.check).not.toHaveBeenCalled();
    }
    expect(selectedWriter.calls).toEqual([]);
  });

  test("rejects an updater constructed without an authentic checker", () => {
    expect(() => StandardsUpdater.create({} as never)).toThrow(TypeError);
  });

  test("composes the production checker and preserves its default-deny failure", async () => {
    const trust = OfflineTufTrustStore.bootstrap(readFileSync(BUNDLED_ROOT));
    if (!trust.ok) throw new Error(JSON.stringify(trust.issues));
    const updater = StandardsUpdater.create(StandardsChecker.create(trust.value));
    expectIssue(await updater.dryRun(request(), checkOptions()), "registry-unconfigured");
  });

  test("rejects exotic and shared byte containers before checking", async () => {
    const candidate = candidatePack();
    class ExoticBytes extends Uint8Array {}
    const exotic = new Uint8Array(Buffer.from(currentPackText));
    Object.defineProperty(exotic, "extra", { enumerable: false, value: true });
    const inputs: unknown[] = [1, exotic, new ExoticBytes(Buffer.from(currentPackText))];
    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new Uint8Array(new SharedArrayBuffer(Buffer.byteLength(currentPackText)));
      shared.set(Buffer.from(currentPackText));
      inputs.push(shared);
    }
    for (const currentPack of inputs) {
      const selected = sourceFor(candidate.bytes, candidate.pack);
      expectIssue(
        await selected.updater.dryRun(request({ currentPack }), checkOptions()),
        "invalid-input",
      );
      expect(selected.check).not.toHaveBeenCalled();
    }
  });

  test("rejects malformed activation input before checking or writing", async () => {
    const candidate = candidatePack();
    const selected = sourceFor(candidate.bytes, candidate.pack);
    const selectedWriter = writer();
    expectIssue(
      await selected.updater.activate(
        { ...request(), currentPack: 1 },
        activationOptions(await cache(), selectedWriter.writer),
      ),
      "invalid-input",
    );
    expect(selected.check).not.toHaveBeenCalled();
    expect(selectedWriter.calls).toEqual([]);
  });

  test("binds rollback source bytes to the observed lock digest before checking", async () => {
    const candidate = candidatePack();
    const selected = sourceFor(candidate.bytes, candidate.pack);
    const selectedWriter = writer();
    const options = activationOptions(await cache(), selectedWriter.writer);
    const result = await selected.updater.activate(request(), {
      ...options,
      expected: { ...options.expected, sha256: HASH_B },
    });
    expectIssue(result, "current-binding-mismatch");
    expect(selected.check).not.toHaveBeenCalled();
    expect(selectedWriter.calls).toEqual([]);
  });

  test("does not expose candidate bytes or rollback lock data in public reports", async () => {
    const candidate = candidatePack();
    const result = await sourceFor(candidate.bytes, candidate.pack).updater.dryRun(
      request(),
      checkOptions(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("targetBytes");
    expect(result.value).not.toHaveProperty("candidateLock");
    expect(JSON.stringify(result.value)).not.toContain(currentLockText);
  });

  test("publishes a closed schema and packaged runtime for deterministic update reports", async () => {
    const candidate = candidatePack();
    const result = await sourceFor(candidate.bytes, candidate.pack).updater.dryRun(
      request(),
      checkOptions(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(result.value)).toBe(true);
    expect(validate({ ...result.value, targetBytes: [] })).toBe(false);
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      exports?: Record<string, unknown>;
      files?: string[];
    };
    expect(manifest.files).toContain("schemas");
    expect(manifest.exports?.["./schemas/standards-update.v0.schema.json"]).toBe(
      "./schemas/standards-update.v0.schema.json",
    );
  });
});
