import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnection, createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import {
  MAX_STANDARDS_CACHE_LOCK_ATTEMPTS,
  MAX_STANDARDS_CACHE_LOCK_DELAY_MS,
  MAX_STANDARDS_CACHE_LOCK_WAIT_MS,
  MAX_STANDARDS_CACHE_QUARANTINE_ENTRIES,
  MAX_STANDARDS_CACHE_RELEASE_CLAIMS,
  STANDARDS_CACHE_CONTRACT_VERSION,
  STANDARDS_CACHE_LAYOUT_VERSION,
  StandardsCache,
} from "../src/index.js";
import { openStandardsCacheFixtureForTest } from "../src/standards-cache.js";

import type {
  StandardsCacheIssueCode,
  StandardsCacheResult,
  StandardsCacheWriteLock,
} from "../src/index.js";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lockDebrisName(token: string, port = 1): string {
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  return `lock-owner-${token}-port-${String(port)}-key-${key.toString("hex")}.partial`;
}

async function workspace(): Promise<string> {
  const selected = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-context-h05-")));
  onTestFinished(async () => rm(selected, { force: true, recursive: true }));
  return selected;
}

async function cacheWithHooks(
  hooks: Parameters<typeof openStandardsCacheFixtureForTest>[1] = {},
): Promise<{ cache: StandardsCache; root: string }> {
  const root = path.join(await workspace(), "cache");
  const opened = await openStandardsCacheFixtureForTest(root, hooks);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(JSON.stringify(opened.issues));
  return { cache: opened.value, root };
}

function options(
  overrides: Partial<{ maxAttempts: number; retryDelayMs: number; signal: AbortSignal }> = {},
): { maxAttempts: number; retryDelayMs: number; signal: AbortSignal } {
  return {
    maxAttempts: 1,
    retryDelayMs: 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function lock(cache: StandardsCache): Promise<StandardsCacheWriteLock> {
  const acquired = await cache.acquireWriteLock(options());
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error(JSON.stringify(acquired.issues));
  onTestFinished(async () => {
    await acquired.value.release();
  });
  return acquired.value;
}

async function directoryNames(absolute: string): Promise<string[]> {
  const directory = await opendir(absolute);
  const names: string[] = [];
  try {
    for await (const entry of directory) names.push(entry.name);
  } finally {
    await directory.close().catch(() => undefined);
  }
  return names;
}

async function lockAuthorityPaths(temporaryDirectory: string): Promise<string[]> {
  const selected: string[] = [];
  for (const name of await directoryNames(temporaryDirectory)) {
    const candidate = path.join(temporaryDirectory, name);
    const stats = await lstat(candidate);
    if (stats.isDirectory()) {
      for (const nested of await directoryNames(candidate))
        if (nested.startsWith("lock-owner-")) selected.push(path.join(candidate, nested));
    } else if (name.startsWith("lock-owner-")) selected.push(candidate);
  }
  return selected.sort();
}

async function temporaryTreeSnapshot(temporaryDirectory: string): Promise<string[]> {
  const snapshot: string[] = [];
  for (const name of (await directoryNames(temporaryDirectory)).sort()) {
    const candidate = path.join(temporaryDirectory, name);
    const stats = await lstat(candidate);
    if (!stats.isDirectory()) {
      snapshot.push(`${name}:file:${(await readFile(candidate)).toString("hex")}`);
      continue;
    }
    snapshot.push(`${name}:directory`);
    for (const nested of (await directoryNames(candidate)).sort())
      snapshot.push(
        `${name}/${nested}:file:${(await readFile(path.join(candidate, nested))).toString("hex")}`,
      );
  }
  return snapshot;
}

function expectIssue<T>(result: StandardsCacheResult<T>, code: StandardsCacheIssueCode): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected cache failure");
  expect(result.issues).toEqual([expect.objectContaining({ code })]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.issues)).toBe(true);
  expect(Object.isFrozen(result.issues[0])).toBe(true);
}

function artifactPath(root: string, kind: "artifact" | "state", digest: string): string {
  return path.join(
    root,
    STANDARDS_CACHE_LAYOUT_VERSION,
    kind === "artifact" ? "artifacts" : "state",
    "sha256",
    digest.slice(0, 2),
    `${digest.slice(2)}.bin`,
  );
}

describe("H05 hostile standards cache and process lock", () => {
  test("creates only the fixed restrictive layout without ambient authority", async () => {
    const env = { ...process.env };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { cache, root } = await cacheWithHooks();
    expect(Object.isFrozen(cache)).toBe(true);
    expect(STANDARDS_CACHE_CONTRACT_VERSION).toBe("0.1.0");
    expect(STANDARDS_CACHE_LAYOUT_VERSION).toBe("v1");
    expect(MAX_STANDARDS_CACHE_QUARANTINE_ENTRIES).toBe(64);
    expect(MAX_STANDARDS_CACHE_RELEASE_CLAIMS).toBe(64);
    expect(MAX_STANDARDS_CACHE_LOCK_ATTEMPTS).toBe(100);
    expect(MAX_STANDARDS_CACHE_LOCK_DELAY_MS).toBe(1_000);
    expect(MAX_STANDARDS_CACHE_LOCK_WAIT_MS).toBe(30_000);
    for (const relative of [
      "",
      "v1",
      "v1/artifacts",
      "v1/artifacts/sha256",
      "v1/state",
      "v1/state/sha256",
      "v1/locks",
      "v1/temporary",
      "v1/quarantine",
    ]) {
      const stats = await lstat(path.join(root, relative));
      expect(stats.isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(stats.mode & 0o777).toBe(0o700);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(process.env).toEqual(env);
    fetchSpy.mockRestore();
  });

  test("stores and reads bounded content-addressed artifact and state bytes defensively", async () => {
    const { cache, root } = await cacheWithHooks();
    const writer = await lock(cache);
    for (const [kind, raw] of [
      ["artifact", Buffer.from("verified knowledge bytes")],
      ["state", Buffer.from("verified metadata bytes")],
    ] as const) {
      const expected = sha256(raw);
      const stored = await cache.storeEntry(writer, { bytes: raw, kind, sha256: expected });
      expect(stored.ok).toBe(true);
      if (!stored.ok) throw new Error(JSON.stringify(stored.issues));
      raw[0] = 0;
      expect(Buffer.from(stored.value.bytes).toString()).not.toContain("\0");
      const read = await cache.readEntry({ kind, length: stored.value.length, sha256: expected });
      expect(read).toEqual(stored);
      expect(read.ok && read.value.origin).toBe("untrusted-cache");
      expect(Object.isFrozen(read)).toBe(true);
      expect(Object.isFrozen(stored.value)).toBe(true);
      const stats = await lstat(artifactPath(root, kind, expected));
      expect(stats.nlink).toBe(1);
      if (process.platform !== "win32") expect(stats.mode & 0o777).toBe(0o600);
      expectIssue(
        await cache.storeEntry(writer, { bytes: stored.value.bytes, kind, sha256: expected }),
        "entry-exists",
      );
      expectIssue(
        await cache.readEntry({ kind, length: stored.value.length - 1, sha256: expected }),
        "digest-mismatch",
      );
    }
    expect(await writer.release()).toEqual({ ok: true, value: { released: true } });
    expectIssue(await writer.release(), "lock-invalid");
  });

  test("rejects malformed roots, requests, candidates, byte views, and wait policies", async () => {
    expectIssue(await StandardsCache.open("relative/cache"), "invalid-input");
    expectIssue(await StandardsCache.open("/"), "invalid-input");
    expectIssue(await StandardsCache.open(new Proxy({}, {})), "invalid-input");
    const { cache } = await cacheWithHooks();
    let getterCalls = 0;
    const accessorRequest = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessorRequest, {
      kind: {
        enumerable: true,
        get(): string {
          getterCalls += 1;
          return "artifact";
        },
      },
      length: { enumerable: true, value: 1 },
      sha256: { enumerable: true, value: "0".repeat(64) },
    });
    expectIssue(await cache.readEntry(accessorRequest), "invalid-input");
    expect(getterCalls).toBe(0);
    for (const [request, code] of [
      [null, "invalid-input"],
      [{}, "invalid-input"],
      [{ kind: "other", length: 1, sha256: "0".repeat(64) }, "invalid-input"],
      [{ kind: "artifact", length: 0, sha256: "0".repeat(64) }, "resource-limit"],
      [{ kind: "state", length: 512 * 1024 + 1, sha256: "0".repeat(64) }, "resource-limit"],
      [{ kind: "artifact", length: 1, sha256: "ABC" }, "invalid-input"],
      [{ kind: "artifact", length: 1, sha256: "0".repeat(64), extra: true }, "invalid-input"],
    ] as const)
      expectIssue(await cache.readEntry(request), code);
    const writer = await lock(cache);
    for (const candidate of [
      null,
      { bytes: Buffer.from("x"), kind: "other", sha256: sha256("x") },
      { bytes: Buffer.from("x"), kind: "artifact", sha256: "bad" },
      { bytes: "x", kind: "artifact", sha256: sha256("x") },
      {
        bytes: new (class extends Uint8Array {})([1]),
        kind: "artifact",
        sha256: sha256(Uint8Array.of(1)),
      },
      { bytes: new Uint8Array(0), kind: "artifact", sha256: sha256("") },
      {
        bytes: new Uint8Array(new SharedArrayBuffer(1)),
        kind: "artifact",
        sha256: sha256(Uint8Array.of(0)),
      },
    ])
      expect((await cache.storeEntry(writer, candidate)).ok).toBe(false);
    expectIssue(
      await cache.storeEntry(writer, {
        bytes: Buffer.from("wrong"),
        kind: "artifact",
        sha256: "0".repeat(64),
      }),
      "digest-mismatch",
    );
    const bytes = Buffer.from("x");
    Object.defineProperty(bytes, "extra", { value: true });
    expectIssue(
      await cache.storeEntry(writer, { bytes, kind: "artifact", sha256: sha256(bytes) }),
      "invalid-input",
    );
    expectIssue(await cache.acquireWriteLock(options({ maxAttempts: 101 })), "resource-limit");
    expectIssue(
      await cache.acquireWriteLock(options({ maxAttempts: 100, retryDelayMs: 1_000 })),
      "resource-limit",
    );
    expectIssue(
      await cache.acquireWriteLock({ maxAttempts: 1, retryDelayMs: 0, signal: {} }),
      "invalid-input",
    );
    const accessorSignal = new AbortController().signal;
    let abortedGetterCalls = 0;
    Object.defineProperty(accessorSignal, "aborted", {
      get(): boolean {
        abortedGetterCalls += 1;
        return false;
      },
    });
    expectIssue(
      await cache.acquireWriteLock({ maxAttempts: 1, retryDelayMs: 0, signal: accessorSignal }),
      "invalid-input",
    );
    expect(abortedGetterCalls).toBe(0);
    expectIssue(
      await cache.acquireWriteLock({
        maxAttempts: 1,
        retryDelayMs: 0,
        signal: new Proxy(new AbortController().signal, {}),
      }),
      "invalid-input",
    );
    await writer.release();
  });

  test("rejects pre-existing root and layout poisoning while permitting safe idempotent reopen", async () => {
    const parent = await workspace();
    const root = path.join(parent, "cache");
    const first = await StandardsCache.open(root);
    expect(first.ok).toBe(true);
    expect((await StandardsCache.open(root)).ok).toBe(true);

    const fileRoot = path.join(parent, "file-root");
    await writeFile(fileRoot, "x");
    expectIssue(await StandardsCache.open(fileRoot), "unsafe-cache");

    if (process.platform !== "win32") {
      const permissiveRoot = path.join(parent, "permissive-root");
      await mkdir(permissiveRoot, { mode: 0o755 });
      await chmod(permissiveRoot, 0o755);
      expectIssue(await StandardsCache.open(permissiveRoot), "unsafe-cache");

      const unwritableParent = path.join(parent, "unwritable-parent");
      await mkdir(unwritableParent, { mode: 0o700 });
      await chmod(unwritableParent, 0o500);
      try {
        expectIssue(await StandardsCache.open(path.join(unwritableParent, "cache")), "io-failure");
      } finally {
        await chmod(unwritableParent, 0o700);
      }
    }

    const poisoned = path.join(parent, "poisoned");
    await mkdir(path.join(poisoned, "v1"), { recursive: true });
    if (process.platform !== "win32") {
      await chmod(poisoned, 0o700);
      await chmod(path.join(poisoned, "v1"), 0o700);
    }
    await writeFile(path.join(poisoned, "v1/artifacts"), "x");
    expectIssue(await StandardsCache.open(poisoned), "unsafe-cache");

    if (process.platform !== "win32") {
      const permissiveLayout = path.join(parent, "permissive-layout");
      await mkdir(path.join(permissiveLayout, "v1"), { recursive: true, mode: 0o700 });
      await chmod(permissiveLayout, 0o700);
      await chmod(path.join(permissiveLayout, "v1"), 0o755);
      expectIssue(await StandardsCache.open(permissiveLayout), "unsafe-cache");
    }

    const linkedParent = path.join(parent, "linked-parent");
    await symlink(parent, linkedParent, "dir");
    expectIssue(await StandardsCache.open(path.join(linkedParent, "child")), "unsafe-cache");
  });

  test("rejects relaxed permissions and a replaced cache root", async () => {
    if (process.platform !== "win32") {
      const directory = await cacheWithHooks();
      await chmod(path.join(directory.root, "v1/state"), 0o755);
      expectIssue(
        await directory.cache.readEntry({
          kind: "state",
          length: 1,
          sha256: "0".repeat(64),
        }),
        "unsafe-cache",
      );

      const entry = await cacheWithHooks();
      const writer = await lock(entry.cache);
      const raw = Buffer.from("private-entry");
      const expected = sha256(raw);
      expect(
        (
          await entry.cache.storeEntry(writer, {
            bytes: raw,
            kind: "artifact",
            sha256: expected,
          })
        ).ok,
      ).toBe(true);
      await chmod(artifactPath(entry.root, "artifact", expected), 0o644);
      expectIssue(
        await entry.cache.readEntry({ kind: "artifact", length: raw.length, sha256: expected }),
        "unsafe-cache",
      );
      expectIssue(
        await entry.cache.quarantineCorruptEntry(writer, {
          kind: "artifact",
          length: raw.length,
          sha256: expected,
        }),
        "unsafe-cache",
      );
      await writer.release();
    }

    const replaced = await cacheWithHooks();
    await rename(replaced.root, `${replaced.root}.previous`);
    await mkdir(replaced.root, { mode: 0o700 });
    expectIssue(
      await replaced.cache.readEntry({
        kind: "artifact",
        length: 1,
        sha256: "0".repeat(64),
      }),
      "concurrent-change",
    );
  });

  test("provides exclusive bounded cancellable lock capabilities without trusting lock text", async () => {
    const duringWait = new AbortController();
    let abortAtRetryBoundary = false;
    const { cache, root } = await cacheWithHooks({
      beforeLockRetryWait(): void {
        if (abortAtRetryBoundary) duringWait.abort();
      },
    });
    const first = await lock(cache);
    expectIssue(
      await cache.acquireWriteLock(options({ maxAttempts: 2, retryDelayMs: 1 })),
      "lock-timeout",
    );
    const cancelled = new AbortController();
    cancelled.abort("hostile reason");
    expectIssue(
      await cache.acquireWriteLock(
        options({ maxAttempts: 2, retryDelayMs: 1, signal: cancelled.signal }),
      ),
      "cancelled",
    );
    abortAtRetryBoundary = true;
    const waiting = cache.acquireWriteLock(
      options({ maxAttempts: 3, retryDelayMs: 20, signal: duringWait.signal }),
    );
    expectIssue(await waiting, "cancelled");
    const other = (await cacheWithHooks()).cache;
    expectIssue(
      await other.storeEntry(first, {
        bytes: Buffer.from("x"),
        kind: "artifact",
        sha256: sha256("x"),
      }),
      "lock-invalid",
    );
    expectIssue(
      await cache.storeEntry(null, {
        bytes: Buffer.from("x"),
        kind: "artifact",
        sha256: sha256("x"),
      }),
      "lock-invalid",
    );
    expectIssue(
      await cache.storeEntry(
        {},
        { bytes: Buffer.from("x"), kind: "artifact", sha256: sha256("x") },
      ),
      "lock-invalid",
    );
    const lockPrototype = Reflect.getPrototypeOf(first);
    if (lockPrototype === null) throw new TypeError("lock prototype missing");
    const constructorDescriptor = Reflect.getOwnPropertyDescriptor(lockPrototype, "constructor") as
      { value?: unknown } | undefined;
    const lockConstructor: unknown = constructorDescriptor?.value;
    if (typeof lockConstructor !== "function") throw new TypeError("lock constructor missing");
    const unregistered = Reflect.construct(lockConstructor, []) as object;
    expectIssue(await (unregistered as StandardsCacheWriteLock).release(), "lock-invalid");
    await writeFile(path.join(root, "v1/locks/writer.v0.json"), "forged");
    expectIssue(
      await cache.storeEntry(first, {
        bytes: Buffer.from("displaced-writer"),
        kind: "artifact",
        sha256: sha256("displaced-writer"),
      }),
      "concurrent-change",
    );
    expectIssue(await first.release(), "concurrent-change");
    expect(await readFile(path.join(root, "v1/locks/writer.v0.json"), "utf8")).toBe("forged");
  });

  test("bounds and validates retained crash-safe generation aliases", async () => {
    const selected = await cacheWithHooks();
    const locksDirectory = path.join(selected.root, "v1/locks");
    await writeFile(path.join(locksDirectory, "unexpected"), "hostile", { mode: 0o600 });
    expectIssue(await selected.cache.acquireWriteLock(options()), "unsafe-cache");
    await unlink(path.join(locksDirectory, "unexpected"));
    for (let index = 0; index < MAX_STANDARDS_CACHE_RELEASE_CLAIMS; index += 1) {
      const generation = await lock(selected.cache);
      expect(await generation.release()).toEqual({ ok: true, value: { released: true } });
    }
    expect(await lockAuthorityPaths(path.join(selected.root, "v1/temporary"))).toHaveLength(64);
    const finalGeneration = await lock(selected.cache);
    expect(await lockAuthorityPaths(path.join(selected.root, "v1/temporary"))).toHaveLength(65);
    expect(await finalGeneration.release()).toEqual({ ok: true, value: { released: true } });
    const beforeRejected = await temporaryTreeSnapshot(path.join(selected.root, "v1/temporary"));
    const locksBeforeRejected = await temporaryTreeSnapshot(locksDirectory);
    expectIssue(await selected.cache.acquireWriteLock(options()), "resource-limit");
    expect(await temporaryTreeSnapshot(path.join(selected.root, "v1/temporary"))).toEqual(
      beforeRejected,
    );
    expect(await temporaryTreeSnapshot(locksDirectory)).toEqual(locksBeforeRejected);
    const retained = (await directoryNames(locksDirectory)).filter((name) =>
      name.startsWith(".writer.generation-"),
    );
    expect(retained).toHaveLength(MAX_STANDARDS_CACHE_RELEASE_CLAIMS);
  });

  test("rejects every malformed retained-generation shape without following it", async () => {
    for (const shape of [
      "malformed",
      "symlink",
      "hardlink",
      "directory",
      "fifo",
      "copy",
      "cycle",
      "orphan",
    ] as const) {
      if (shape === "fifo" && process.platform === "win32") continue;
      const selected = await cacheWithHooks();
      const first = await lock(selected.cache);
      expect((await first.release()).ok).toBe(true);
      const second = await lock(selected.cache);
      expect((await second.release()).ok).toBe(true);
      const locksDirectory = path.join(selected.root, "v1/locks");
      const entries = await directoryNames(locksDirectory);
      const generation = entries.find((name) => name.startsWith(".writer.generation-"));
      if (generation === undefined) throw new Error("expected retained generation");
      const ownerPath = path.join(locksDirectory, generation);
      if (shape === "malformed") await writeFile(ownerPath, "{}");
      else if (shape === "symlink") {
        await unlink(ownerPath);
        await symlink(path.join(locksDirectory, "writer.v0.json"), ownerPath);
      } else if (shape === "hardlink") {
        await link(ownerPath, path.join(selected.root, "owner-hardlink"));
      } else if (shape === "directory") {
        await unlink(ownerPath);
        await mkdir(ownerPath, { mode: 0o700 });
      } else if (shape === "fifo") {
        await unlink(ownerPath);
        const made = spawnSync("mkfifo", [ownerPath], { encoding: "utf8" });
        expect(made.status).toBe(0);
      } else if (shape === "copy") {
        const record = await readFile(ownerPath);
        await rename(ownerPath, path.join(selected.root, "displaced-copied-generation"));
        await writeFile(ownerPath, record, { mode: 0o600 });
      } else if (shape === "cycle") {
        const generationToken = generation.slice(".writer.generation-".length, -".v0.json".length);
        const owner = await lstat(ownerPath);
        const temporaryDirectory = path.join(selected.root, "v1/temporary");
        const aliases = await lockAuthorityPaths(temporaryDirectory);
        let selectedAlias: string | undefined;
        for (const alias of aliases) {
          const candidate = await lstat(alias);
          if (candidate.dev === owner.dev && candidate.ino === owner.ino) selectedAlias = alias;
        }
        if (selectedAlias === undefined) throw new Error("expected generation authority alias");
        await rename(
          selectedAlias,
          path.join(
            path.dirname(selectedAlias),
            path
              .basename(selectedAlias)
              .replace(/^lock-owner-[a-f0-9]{64}/u, `lock-owner-${generationToken}`),
          ),
        );
      } else {
        await writeFile(
          path.join(locksDirectory, `.writer.generation-${"f".repeat(64)}.v0.json`),
          await readFile(ownerPath),
          { mode: 0o600 },
        );
      }
      const result = await selected.cache.acquireWriteLock(options());
      if (shape === "malformed") {
        expect(result.ok).toBe(true);
        if (result.ok) expect((await result.value.release()).ok).toBe(true);
      } else expectIssue(result, "unsafe-cache");
    }
  });

  test("excludes a separate writer process and releases across the process boundary", async () => {
    const { cache, root } = await cacheWithHooks();
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const moduleUrl = pathToFileURL(path.join(packageRoot, "dist/index.js")).href;
    const childSource = `
      import { StandardsCache } from ${JSON.stringify(moduleUrl)};
      const opened = await StandardsCache.open(process.argv[1]);
      if (!opened.ok) throw new Error(JSON.stringify(opened.issues));
      const acquired = await opened.value.acquireWriteLock({
        maxAttempts: 1,
        retryDelayMs: 0,
        signal: new AbortController().signal,
      });
      if (!acquired.ok) throw new Error(JSON.stringify(acquired.issues));
      process.stdout.write("READY\\n");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      const released = await acquired.value.release();
      if (!released.ok) throw new Error(JSON.stringify(released.issues));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource, root], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    onTestFinished(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const ready = await new Promise<Buffer>((resolve, reject) => {
      child.stdout.once("data", (value: unknown) => {
        if (Buffer.isBuffer(value)) resolve(value);
        else reject(new TypeError("child process emitted non-buffer stdout"));
      });
      child.once("error", reject);
    });
    expect(ready.toString()).toBe("READY\n");
    expectIssue(await cache.acquireWriteLock(options()), "lock-timeout");
    child.stdin.end("release\n");
    const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
        child.once("error", reject);
      },
    );
    expect(exited).toEqual({ code: 0, signal: null });
    const acquired = await lock(cache);
    expect((await acquired.release()).ok).toBe(true);
  });

  test("bounds holder connections, request bytes, idle time, and release cleanup", async () => {
    const selected = await cacheWithHooks();
    const writer = await lock(selected.cache);
    const record = await readFile(path.join(selected.root, "v1/locks/writer.v0.json"), "utf8");
    const portText = /"holderPort":([0-9]+)/u.exec(record)?.[1];
    if (portText === undefined) throw new Error("expected holder port");
    const port = Number(portText);

    const oversized = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      oversized.once("connect", resolve);
      oversized.once("error", reject);
    });
    const oversizedClosed = new Promise<void>((resolve) => {
      oversized.once("close", () => {
        resolve();
      });
    });
    oversized.write(`${"a".repeat(65)}\n`, "ascii");
    await oversizedClosed;

    const invalid = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      invalid.once("connect", resolve);
      invalid.once("error", reject);
    });
    const invalidClosed = new Promise<void>((resolve) => {
      invalid.once("close", () => {
        resolve();
      });
    });
    invalid.write("not-a-challenge\n", "ascii");
    await invalidClosed;

    const idle = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      idle.once("connect", resolve);
      idle.once("error", reject);
    });
    const idleClosed = new Promise<void>((resolve) => {
      idle.once("close", () => {
        resolve();
      });
    });
    const drip = globalThis.setInterval(() => {
      idle.write("a", "ascii");
    }, 400);
    const idleStarted = performance.now();
    await idleClosed;
    globalThis.clearInterval(drip);
    expect(performance.now() - idleStarted).toBeLessThan(1_400);

    const heldConnections = Array.from({ length: 9 }, () =>
      createConnection({ host: "127.0.0.1", port }),
    );
    await Promise.all(
      heldConnections.map(
        (socket) =>
          new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
          }),
      ),
    );
    const closures = heldConnections.map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.destroyed) resolve();
          else
            socket.once("close", () => {
              resolve();
            });
        }),
    );
    expect(await writer.release()).toEqual({ ok: true, value: { released: true } });
    await Promise.all(closures);
  });

  test("rejects forged lock directories and owner hard links", async () => {
    const forged = await cacheWithHooks();
    await symlink(forged.root, path.join(forged.root, "v1/locks/writer.v0.json"));
    expectIssue(await forged.cache.acquireWriteLock(options()), "unsafe-cache");

    let linkedOwner = false;
    const owner = await cacheWithHooks({
      async afterLockOwnerWrite(ownerPath): Promise<void> {
        linkedOwner = true;
        await link(ownerPath, `${ownerPath}.hardlink`);
      },
    });
    expectIssue(await owner.cache.acquireWriteLock(options()), "unsafe-cache");
    expect(linkedOwner).toBe(true);
  });

  test("rejects linked layout components, linked entries, hard links, and special files", async () => {
    const symbolic = await cacheWithHooks();
    await rm(path.join(symbolic.root, "v1/state"), { recursive: true });
    await symlink(
      path.join(symbolic.root, "v1/artifacts"),
      path.join(symbolic.root, "v1/state"),
      "dir",
    );
    expectIssue(
      await symbolic.cache.readEntry({ kind: "artifact", length: 1, sha256: "0".repeat(64) }),
      "unsafe-cache",
    );

    for (const kind of ["symlink", "hardlink", "directory", "fifo"] as const) {
      if (kind === "fifo" && process.platform === "win32") continue;
      const selected = await cacheWithHooks();
      const raw = Buffer.from(`unsafe-${kind}`);
      const expected = sha256(raw);
      const target = artifactPath(selected.root, "artifact", expected);
      await mkdir(path.dirname(target), { recursive: true });
      await chmod(path.dirname(target), 0o700);
      if (kind === "symlink") await symlink(path.join(selected.root, "outside"), target);
      else if (kind === "directory") await mkdir(target);
      else if (kind === "hardlink") {
        const outside = path.join(selected.root, "outside");
        await writeFile(outside, raw);
        await link(outside, target);
      } else {
        const made = spawnSync("mkfifo", [target], { encoding: "utf8" });
        expect(made.status).toBe(0);
      }
      expectIssue(
        await selected.cache.readEntry({ kind: "artifact", length: raw.length, sha256: expected }),
        "unsafe-cache",
      );
    }
  });

  test("detects concurrent entry truncation and temporary-file substitution", async () => {
    let opened = false;
    const selected = await cacheWithHooks({
      async afterEntryOpen(absolute): Promise<void> {
        if (opened) return;
        opened = true;
        await truncate(absolute, 1);
      },
    });
    const raw = Buffer.from("race-sensitive-entry");
    const expected = sha256(raw);
    const writer = await lock(selected.cache);
    expectIssue(
      await selected.cache.storeEntry(writer, { bytes: raw, kind: "artifact", sha256: expected }),
      "concurrent-change",
    );
    await writer.release();

    let substituted = false;
    const publication = await cacheWithHooks({
      async beforePublish(temporary): Promise<void> {
        substituted = true;
        await unlink(temporary);
        await writeFile(temporary, "attacker");
      },
    });
    const publicationLock = await lock(publication.cache);
    expectIssue(
      await publication.cache.storeEntry(publicationLock, {
        bytes: raw,
        kind: "artifact",
        sha256: expected,
      }),
      "concurrent-change",
    );
    expect(substituted).toBe(true);
    await publicationLock.release();
  });

  test("detects pre-open and post-read path replacement plus temporary growth", async () => {
    const repetitions = 64;
    for (const phase of ["pre-open", "post-read"] as const) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        let armed = false;
        const selected = await cacheWithHooks({
          async afterEntryLstat(absolute): Promise<void> {
            if (!armed || phase !== "pre-open") return;
            armed = false;
            const bytes = await readFile(absolute);
            await unlink(absolute);
            await writeFile(absolute, bytes);
          },
          async afterEntryRead(absolute): Promise<void> {
            if (!armed || phase !== "post-read") return;
            armed = false;
            const bytes = await readFile(absolute);
            await unlink(absolute);
            await writeFile(absolute, bytes);
          },
        });
        const raw = Buffer.from(`replace-${phase}-${String(repetition)}`);
        const expected = sha256(raw);
        const writer = await lock(selected.cache);
        expect(
          (
            await selected.cache.storeEntry(writer, {
              bytes: raw,
              kind: "artifact",
              sha256: expected,
            })
          ).ok,
        ).toBe(true);
        armed = true;
        expectIssue(
          await selected.cache.readEntry({
            kind: "artifact",
            length: raw.length,
            sha256: expected,
          }),
          "concurrent-change",
        );
        await writer.release();
      }
    }

    const temporary = await cacheWithHooks({
      async afterTemporaryWrite(temporaryPath): Promise<void> {
        await writeFile(temporaryPath, "grew-after-write", { flag: "a" });
      },
    });
    const temporaryLock = await lock(temporary.cache);
    const raw = Buffer.from("temporary-growth");
    expectIssue(
      await temporary.cache.storeEntry(temporaryLock, {
        bytes: raw,
        kind: "artifact",
        sha256: sha256(raw),
      }),
      "concurrent-change",
    );
    await temporaryLock.release();

    let publicationReplacement = "";
    const linked = await cacheWithHooks({
      async afterPublishLink(temporaryPath): Promise<void> {
        publicationReplacement = temporaryPath;
        await unlink(temporaryPath);
        await writeFile(temporaryPath, "replacement", { mode: 0o600 });
      },
    });
    const linkedLock = await lock(linked.cache);
    expectIssue(
      await linked.cache.storeEntry(linkedLock, {
        bytes: raw,
        kind: "artifact",
        sha256: sha256(raw),
      }),
      "concurrent-change",
    );
    expect(await readFile(publicationReplacement, "utf8")).toBe("replacement");
    await linkedLock.release();

    let finalReplacement = "";
    const published = await cacheWithHooks({
      async afterPublishUnlink(finalPath): Promise<void> {
        finalReplacement = finalPath;
        await unlink(finalPath);
        await writeFile(finalPath, "replacement", { mode: 0o600 });
      },
    });
    const publishedLock = await lock(published.cache);
    expectIssue(
      await published.cache.storeEntry(publishedLock, {
        bytes: raw,
        kind: "artifact",
        sha256: sha256(raw),
      }),
      "concurrent-change",
    );
    expect(await readFile(finalReplacement, "utf8")).toBe("replacement");
    await publishedLock.release();
  });

  test.each(["pre-open", "post-read"] as const)(
    "classifies %s path disappearance as a concurrent change",
    async (phase) => {
      let armed = false;
      const selected = await cacheWithHooks({
        async afterEntryLstat(absolute): Promise<void> {
          if (!armed || phase !== "pre-open") return;
          armed = false;
          await unlink(absolute);
        },
        async afterEntryRead(absolute): Promise<void> {
          if (!armed || phase !== "post-read") return;
          armed = false;
          await unlink(absolute);
        },
      });
      const raw = Buffer.from(`disappear-${phase}`);
      const expected = sha256(raw);
      const writer = await lock(selected.cache);
      expect(
        (
          await selected.cache.storeEntry(writer, {
            bytes: raw,
            kind: "artifact",
            sha256: expected,
          })
        ).ok,
      ).toBe(true);
      armed = true;
      expectIssue(
        await selected.cache.readEntry({
          kind: "artifact",
          length: raw.length,
          sha256: expected,
        }),
        "concurrent-change",
      );
      expect(armed).toBe(false);
      await writer.release();
    },
  );

  test("detects growth, same-length mutation, and sanitized primitive hook failures", async () => {
    for (const mode of ["grow", "mutate"] as const) {
      let armed = false;
      const selected = await cacheWithHooks({
        async afterEntryOpen(absolute): Promise<void> {
          if (!armed) return;
          armed = false;
          if (mode === "grow") await writeFile(absolute, "x", { flag: "a" });
          else {
            const bytes = await readFile(absolute);
            bytes[0] = bytes[0] === 0 ? 1 : 0;
            await writeFile(absolute, bytes);
          }
        },
      });
      const raw = Buffer.from(`read-${mode}`);
      const expected = sha256(raw);
      const writer = await lock(selected.cache);
      expect(
        (
          await selected.cache.storeEntry(writer, {
            bytes: raw,
            kind: "artifact",
            sha256: expected,
          })
        ).ok,
      ).toBe(true);
      armed = true;
      expectIssue(
        await selected.cache.readEntry({ kind: "artifact", length: raw.length, sha256: expected }),
        "concurrent-change",
      );
      await writer.release();
    }

    let armed = false;
    const throwing = await cacheWithHooks({
      afterEntryOpen(): void {
        if (!armed) return;
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- fault injection covers arbitrary rejection values.
        throw "hostile primitive";
      },
    });
    const raw = Buffer.from("hook-failure");
    const expected = sha256(raw);
    const writer = await lock(throwing.cache);
    expect(
      (
        await throwing.cache.storeEntry(writer, {
          bytes: raw,
          kind: "artifact",
          sha256: expected,
        })
      ).ok,
    ).toBe(true);
    armed = true;
    expectIssue(
      await throwing.cache.readEntry({ kind: "artifact", length: raw.length, sha256: expected }),
      "io-failure",
    );
    await writer.release();
  });

  test("rejects the exact hardlink re-alias release race without mutating the replacement", async () => {
    let replacementOwner = "";
    let displacedOwner = "";
    let immutableOwner = Buffer.alloc(0);
    const selected = await cacheWithHooks({
      async beforeLockOwnerRelease(ownerPath): Promise<void> {
        replacementOwner = ownerPath;
        displacedOwner = path.join(path.dirname(ownerPath), "displaced-owner.v0.json");
        immutableOwner = await readFile(ownerPath);
        await rename(ownerPath, displacedOwner);
        await writeFile(replacementOwner, immutableOwner, { mode: 0o600 });
      },
    });
    const writer = await lock(selected.cache);
    expectIssue(await writer.release(), "concurrent-change");
    expect((await lstat(replacementOwner)).nlink).toBe(1);
    expect(await readFile(replacementOwner)).toEqual(immutableOwner);
    expect((await lstat(displacedOwner)).isFile()).toBe(true);
    expectIssue(await selected.cache.acquireWriteLock(options()), "unsafe-cache");
  });

  test("keeps published owner bytes immutable and fails closed on stable torn generations", async () => {
    const selected = await cacheWithHooks();
    const ownerPath = path.join(selected.root, "v1/locks/writer.v0.json");
    const writer = await lock(selected.cache);
    const published = await readFile(ownerPath);
    expect(published.toString("utf8")).toContain('"holderPublicKey":');
    expect(await writer.release()).toEqual({ ok: true, value: { released: true } });
    expect(await readFile(ownerPath)).toEqual(published);
    await truncate(ownerPath, Math.floor(published.length / 2));
    const recovered = await lock(selected.cache);
    expect((await recovered.release()).ok).toBe(true);

    const empty = await cacheWithHooks();
    await mkdir(path.join(empty.root, "v1/locks/writer.v0.json"), { mode: 0o700 });
    expectIssue(await empty.cache.acquireWriteLock(options()), "unsafe-cache");
  });

  test("publishes no authoritative empty state and preserves post-link failures", async () => {
    for (const phase of ["temporary", "before-link"] as const) {
      let armed = true;
      const selected = await cacheWithHooks({
        async afterLockOwnerTemporaryWrite(): Promise<void> {
          await Promise.resolve();
          if (phase === "temporary" && armed) {
            armed = false;
            throw new Error("injected temporary failure");
          }
        },
        beforeLockOwnerPublish(): void {
          if (phase === "before-link" && armed) {
            armed = false;
            throw new Error("injected pre-link failure");
          }
        },
      });
      expectIssue(await selected.cache.acquireWriteLock(options()), "io-failure");
      expect(await directoryNames(path.join(selected.root, "v1/locks"))).toEqual([]);
      expect(await directoryNames(path.join(selected.root, "v1/temporary"))).toHaveLength(1);
      const successor = await lock(selected.cache);
      expect((await successor.release()).ok).toBe(true);
    }

    let failAfterLink = true;
    const retained = await cacheWithHooks({
      afterLockOwnerWrite(): void {
        if (!failAfterLink) return;
        failAfterLink = false;
        throw new Error("injected post-link failure");
      },
    });
    expectIssue(await retained.cache.acquireWriteLock(options()), "io-failure");
    const generations = await directoryNames(path.join(retained.root, "v1/locks"));
    const debris = await lockAuthorityPaths(path.join(retained.root, "v1/temporary"));
    expect(generations).toEqual(["writer.v0.json"]);
    expect(debris).toHaveLength(1);
    const debrisPath = debris[0];
    if (debrisPath === undefined) throw new Error("expected retained temporary alias");
    const generationPath = path.join(retained.root, "v1/locks/writer.v0.json");
    expect((await lstat(generationPath)).nlink).toBe(2);
    expect(await readFile(debrisPath)).toEqual(await readFile(generationPath));
    const successor = await lock(retained.cache);
    expect((await successor.release()).ok).toBe(true);
    expect(await directoryNames(path.join(retained.root, "v1/locks"))).toHaveLength(2);

    const controller = new AbortController();
    const cancelled = await cacheWithHooks({
      afterLockOwnerWrite(): void {
        controller.abort();
      },
    });
    expectIssue(
      await cancelled.cache.acquireWriteLock(options({ signal: controller.signal })),
      "cancelled",
    );
    expect(await directoryNames(path.join(cancelled.root, "v1/locks"))).toEqual(["writer.v0.json"]);
    const afterCancellation = await lock(cancelled.cache);
    expect((await afterCancellation.release()).ok).toBe(true);
  });

  test("allows only the exact known temporary hardlink alias", async () => {
    let failAfterLink = true;
    const selected = await cacheWithHooks({
      afterLockOwnerWrite(): void {
        if (!failAfterLink) return;
        failAfterLink = false;
        throw new Error("retain exact alias");
      },
    });
    expectIssue(await selected.cache.acquireWriteLock(options()), "io-failure");
    const accepted = await lock(selected.cache);
    expect((await accepted.release()).ok).toBe(true);

    const hostile = await cacheWithHooks();
    const writer = await lock(hostile.cache);
    expect((await writer.release()).ok).toBe(true);
    await link(
      path.join(hostile.root, "v1/locks/writer.v0.json"),
      path.join(hostile.root, "unexpected-owner-alias"),
    );
    expectIssue(await hostile.cache.acquireWriteLock(options()), "unsafe-cache");

    let retainWrongAlias = true;
    const wrongAlias = await cacheWithHooks({
      afterLockOwnerWrite(): void {
        if (!retainWrongAlias) return;
        retainWrongAlias = false;
        throw new Error("retain alias before substitution");
      },
    });
    expectIssue(await wrongAlias.cache.acquireWriteLock(options()), "io-failure");
    const [temporaryPath] = await lockAuthorityPaths(path.join(wrongAlias.root, "v1/temporary"));
    if (temporaryPath === undefined) throw new Error("expected known temporary alias");
    await rename(temporaryPath, path.join(wrongAlias.root, "displaced-known-alias"));
    await writeFile(temporaryPath, "replacement", { mode: 0o600 });
    expectIssue(await wrongAlias.cache.acquireWriteLock(options()), "unsafe-cache");

    const missingAlias = await cacheWithHooks();
    const missingAliasWriter = await lock(missingAlias.cache);
    expect((await missingAliasWriter.release()).ok).toBe(true);
    const [stableAlias] = await lockAuthorityPaths(path.join(missingAlias.root, "v1/temporary"));
    if (stableAlias === undefined) throw new Error("expected stable authority alias");
    await unlink(stableAlias);
    const oneLinkRecovery = await lock(missingAlias.cache);
    expect((await oneLinkRecovery.release()).ok).toBe(true);

    const broadGeneration = await cacheWithHooks();
    const broadWriter = await lock(broadGeneration.cache);
    expect((await broadWriter.release()).ok).toBe(true);
    await chmod(path.join(broadGeneration.root, "v1/locks/writer.v0.json"), 0o644);
    expectIssue(await broadGeneration.cache.acquireWriteLock(options()), "unsafe-cache");
  });

  test("leaves no loser temporary when concurrent publishers race the same flat generation", async () => {
    let entered!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let pauseFirst = true;
    const selected = await cacheWithHooks({
      async beforeLockOwnerPublish(): Promise<void> {
        if (!pauseFirst) return;
        pauseFirst = false;
        entered();
        await allowed;
      },
    });
    const loser = selected.cache.acquireWriteLock(options());
    await paused;
    const winner = await lock(selected.cache);
    resume();
    expectIssue(await loser, "lock-timeout");
    expect(await directoryNames(path.join(selected.root, "v1/temporary"))).toHaveLength(2);
    expect(await directoryNames(path.join(selected.root, "v1/locks"))).toEqual(["writer.v0.json"]);
    expect((await winner.release()).ok).toBe(true);
  });

  test("atomically arbitrates the final authority slot under concurrent acquisition", async () => {
    let entered!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let pauseFinal = false;
    const selected = await cacheWithHooks({
      async beforeLockOwnerPublish(): Promise<void> {
        if (!pauseFinal) return;
        pauseFinal = false;
        entered();
        await allowed;
      },
    });
    for (let index = 0; index < MAX_STANDARDS_CACHE_RELEASE_CLAIMS; index += 1) {
      const generation = await lock(selected.cache);
      expect((await generation.release()).ok).toBe(true);
    }
    pauseFinal = true;
    const finalAcquisition = selected.cache.acquireWriteLock(options());
    await paused;
    const contenders = await Promise.all(
      Array.from({ length: 16 }, () => selected.cache.acquireWriteLock(options())),
    );
    for (const contender of contenders) expectIssue(contender, "resource-limit");
    expect(await lockAuthorityPaths(path.join(selected.root, "v1/temporary"))).toHaveLength(65);
    resume();
    const final = await finalAcquisition;
    expect(final.ok).toBe(true);
    if (!final.ok) throw new Error(JSON.stringify(final.issues));
    expect((await final.value.release()).ok).toBe(true);
    expect(await lockAuthorityPaths(path.join(selected.root, "v1/temporary"))).toHaveLength(65);
  });

  test("bounds private lock temporary debris without treating it as authority", async () => {
    const selected = await cacheWithHooks();
    const temporaryDirectory = path.join(selected.root, "v1/temporary");
    for (let index = 0; index < MAX_STANDARDS_CACHE_RELEASE_CLAIMS + 2; index += 1)
      await writeFile(
        path.join(
          temporaryDirectory,
          lockDebrisName(index.toString(16).padStart(64, "0"), index + 1),
        ),
        "orphan",
        { mode: 0o600 },
      );
    expectIssue(await selected.cache.acquireWriteLock(options()), "resource-limit");
  });

  test("rejects malformed, overlapping, and over-capacity authority slots", async () => {
    const malformed = await cacheWithHooks();
    await writeFile(path.join(malformed.root, "v1/temporary/lock-owner-slot-bad"), "x", {
      mode: 0o600,
    });
    expectIssue(await malformed.cache.acquireWriteLock(options()), "unsafe-cache");

    const outOfRange = await cacheWithHooks();
    await mkdir(path.join(outOfRange.root, "v1/temporary/lock-owner-slot-65"), { mode: 0o700 });
    expectIssue(await outOfRange.cache.acquireWriteLock(options()), "unsafe-cache");

    const crowded = await cacheWithHooks();
    const crowdedSlot = path.join(crowded.root, "v1/temporary/lock-owner-slot-00");
    await mkdir(crowdedSlot, { mode: 0o700 });
    await writeFile(path.join(crowdedSlot, "first"), "x", { mode: 0o600 });
    await writeFile(path.join(crowdedSlot, "second"), "x", { mode: 0o600 });
    expectIssue(await crowded.cache.acquireWriteLock(options()), "unsafe-cache");

    const overlapping = await cacheWithHooks();
    const overlappingTemporary = path.join(overlapping.root, "v1/temporary");
    await mkdir(path.join(overlappingTemporary, "lock-owner-slot-00"), { mode: 0o700 });
    await writeFile(path.join(overlappingTemporary, lockDebrisName("a".repeat(64))), "orphan", {
      mode: 0o600,
    });
    expectIssue(await overlapping.cache.acquireWriteLock(options()), "unsafe-cache");

    const overCapacity = await cacheWithHooks();
    const overCapacityTemporary = path.join(overCapacity.root, "v1/temporary");
    for (let index = 0; index <= MAX_STANDARDS_CACHE_RELEASE_CLAIMS; index += 1)
      await writeFile(
        path.join(
          overCapacityTemporary,
          lockDebrisName(index.toString(16).padStart(64, "0"), index + 1),
        ),
        "orphan",
        { mode: 0o600 },
      );
    await mkdir(path.join(overCapacityTemporary, "lock-owner-slot-64"), { mode: 0o700 });
    expectIssue(await overCapacity.cache.acquireWriteLock(options()), "resource-limit");
  });

  test("rejects malformed flat generations and private debris", async () => {
    const unrelated = await cacheWithHooks();
    await writeFile(
      path.join(unrelated.root, "v1/temporary/artifact-deadbeef.partial"),
      "unrelated",
      { mode: 0o600 },
    );
    const unrelatedLock = await lock(unrelated.cache);
    expect((await unrelatedLock.release()).ok).toBe(true);

    const malformed = await cacheWithHooks();
    await writeFile(path.join(malformed.root, "v1/temporary/lock-owner-bad.partial"), "x", {
      mode: 0o600,
    });
    expectIssue(await malformed.cache.acquireWriteLock(options()), "unsafe-cache");

    const directoryDebris = await cacheWithHooks();
    await mkdir(path.join(directoryDebris.root, "v1/temporary", lockDebrisName("b".repeat(64))), {
      mode: 0o700,
    });
    expectIssue(await directoryDebris.cache.acquireWriteLock(options()), "unsafe-cache");

    for (const name of [
      lockDebrisName("c".repeat(64)).replace("-port-1-", "-port-99999-"),
      lockDebrisName("d".repeat(64)).replace(
        /-key-[a-f0-9]{88}\.partial$/u,
        `-key-${"0".repeat(88)}.partial`,
      ),
    ]) {
      const malformedAuthority = await cacheWithHooks();
      await writeFile(path.join(malformedAuthority.root, "v1/temporary", name), "x", {
        mode: 0o600,
      });
      expectIssue(await malformedAuthority.cache.acquireWriteLock(options()), "unsafe-cache");
    }

    const broad = await cacheWithHooks();
    await writeFile(
      path.join(broad.root, `v1/temporary/lock-owner-${"a".repeat(64)}.partial`),
      "x",
      { mode: 0o644 },
    );
    expectIssue(await broad.cache.acquireWriteLock(options()), "unsafe-cache");

    const orphanAlias = await cacheWithHooks();
    const outside = path.join(orphanAlias.root, "orphan-owner");
    await writeFile(outside, "orphan", { mode: 0o600 });
    await link(
      outside,
      path.join(orphanAlias.root, `v1/temporary/lock-owner-${"b".repeat(64)}.partial`),
    );
    expectIssue(await orphanAlias.cache.acquireWriteLock(options()), "unsafe-cache");

    const duplicateGeneration = await cacheWithHooks();
    const duplicateWriter = await lock(duplicateGeneration.cache);
    expect((await duplicateWriter.release()).ok).toBe(true);
    await link(
      path.join(duplicateGeneration.root, "v1/locks/writer.v0.json"),
      path.join(duplicateGeneration.root, `v1/locks/.writer.generation-${"e".repeat(64)}.v0.json`),
    );
    expectIssue(await duplicateGeneration.cache.acquireWriteLock(options()), "unsafe-cache");

    const liveFork = await cacheWithHooks();
    const liveWriter = await lock(liveFork.cache);
    await writeFile(
      path.join(liveFork.root, `v1/locks/.writer.generation-${"f".repeat(64)}.v0.json`),
      await readFile(path.join(liveFork.root, "v1/locks/writer.v0.json")),
      { mode: 0o600 },
    );
    expectIssue(await liveFork.cache.acquireWriteLock(options()), "unsafe-cache");
    expect((await liveWriter.release()).ok).toBe(true);

    const overflow = await cacheWithHooks();
    for (let index = 0; index < MAX_STANDARDS_CACHE_RELEASE_CLAIMS + 2; index += 1)
      await writeFile(
        path.join(
          overflow.root,
          `v1/locks/.writer.generation-${index.toString(16).padStart(64, "0")}.v0.json`,
        ),
        "x",
        { mode: 0o600 },
      );
    expectIssue(await overflow.cache.acquireWriteLock(options()), "resource-limit");
  });

  test("fails closed for private replacement and invalid linked publication shapes", async () => {
    let replacementPath = "";
    let replaceOnce = true;
    const replaced = await cacheWithHooks({
      async beforeLockOwnerPublish(temporaryPath): Promise<void> {
        if (!replaceOnce) return;
        replaceOnce = false;
        await rename(temporaryPath, path.join(replaced.root, "displaced-private-owner"));
        await writeFile(temporaryPath, "replacement", { mode: 0o600 });
        replacementPath = temporaryPath;
      },
    });
    expectIssue(await replaced.cache.acquireWriteLock(options()), "concurrent-change");
    expect(await directoryNames(path.join(replaced.root, "v1/locks"))).toEqual([]);
    expect(await readFile(replacementPath, "utf8")).toBe("replacement");
    const afterReplacement = await lock(replaced.cache);
    expect((await afterReplacement.release()).ok).toBe(true);

    const invalidTemporary = await cacheWithHooks({
      async afterLockOwnerTemporaryWrite(temporaryPath): Promise<void> {
        await chmod(temporaryPath, 0o644);
      },
    });
    expectIssue(await invalidTemporary.cache.acquireWriteLock(options()), "unsafe-cache");

    const extraLink = await cacheWithHooks({
      async afterLockOwnerWrite(ownerPath): Promise<void> {
        await link(ownerPath, path.join(extraLink.root, "unexpected-published-alias"));
      },
    });
    expectIssue(await extraLink.cache.acquireWriteLock(options()), "unsafe-cache");

    const changedMode = await cacheWithHooks({
      async afterLockOwnerWrite(ownerPath): Promise<void> {
        await chmod(ownerPath, 0o644);
      },
    });
    expectIssue(await changedMode.cache.acquireWriteLock(options()), "unsafe-cache");
  });

  test("verifies exact published bytes and never unlinks a substituted stable alias", async () => {
    let mutateOnce = true;
    const mutated = await cacheWithHooks({
      async afterLockOwnerWrite(ownerPath): Promise<void> {
        if (!mutateOnce) return;
        mutateOnce = false;
        const record = await readFile(ownerPath, "utf8");
        const token = /"nextToken":"([a-f0-9]{64})"/u.exec(record)?.[1];
        if (token === undefined) throw new Error("expected next token");
        const changed = `${token.startsWith("0") ? "1" : "0"}${token.slice(1)}`;
        await writeFile(ownerPath, record.replace(token, changed), { mode: 0o600 });
      },
    });
    expectIssue(await mutated.cache.acquireWriteLock(options()), "concurrent-change");
    const recoveredMutation = await lock(mutated.cache);
    expect((await recoveredMutation.release()).ok).toBe(true);

    let corruptOnce = true;
    const corrupted = await cacheWithHooks({
      async afterLockOwnerWrite(ownerPath): Promise<void> {
        if (!corruptOnce) return;
        corruptOnce = false;
        await writeFile(ownerPath, "malformed", { mode: 0o600 });
      },
    });
    expectIssue(await corrupted.cache.acquireWriteLock(options()), "concurrent-change");
    const recoveredCorruption = await lock(corrupted.cache);
    expect((await recoveredCorruption.release()).ok).toBe(true);

    let substituteOnce = true;
    let replacementPath = "";
    const substituted = await cacheWithHooks({
      async afterLockOwnerWrite(): Promise<void> {
        if (!substituteOnce) return;
        substituteOnce = false;
        const temporaryDirectory = path.join(substituted.root, "v1/temporary");
        const [name] = await lockAuthorityPaths(temporaryDirectory);
        if (name === undefined) throw new Error("expected stable alias");
        replacementPath = name;
        await rename(replacementPath, path.join(substituted.root, "displaced-stable-alias"));
        await writeFile(replacementPath, "do-not-delete", { mode: 0o600 });
      },
    });
    expectIssue(await substituted.cache.acquireWriteLock(options()), "unsafe-cache");
    expect(await readFile(replacementPath, "utf8")).toBe("do-not-delete");
    expectIssue(await substituted.cache.acquireWriteLock(options()), "unsafe-cache");
  });

  test("rejects stable same-width owner mutation even while the holder remains live", async () => {
    const selected = await cacheWithHooks();
    const writer = await lock(selected.cache);
    const ownerPath = path.join(selected.root, "v1/locks/writer.v0.json");
    const active = await readFile(ownerPath, "utf8");
    const device = /"ownerDev":"([0-9]+)"/u.exec(active)?.[1];
    if (device === undefined) throw new Error("expected owner identity");
    const changed = `${device.slice(0, -1)}${device.endsWith("0") ? "1" : "0"}`;
    const forged = active.replace(`"ownerDev":"${device}"`, `"ownerDev":"${changed}"`);
    expect(forged).toHaveLength(active.length);
    await writeFile(ownerPath, forged, { mode: 0o600 });
    expectIssue(await selected.cache.acquireWriteLock(options()), "lock-timeout");
    expectIssue(await writer.release(), "concurrent-change");

    const invalidKey = await cacheWithHooks();
    const invalidKeyWriter = await lock(invalidKey.cache);
    const invalidKeyOwner = path.join(invalidKey.root, "v1/locks/writer.v0.json");
    const validRecord = await readFile(invalidKeyOwner, "utf8");
    expect(await invalidKeyWriter.release()).toEqual({ ok: true, value: { released: true } });
    const publicKey = /"holderPublicKey":"([^"]+)"/u.exec(validRecord)?.[1];
    if (publicKey === undefined) throw new Error("expected holder public key");
    const malformedKey = Buffer.alloc(44).toString("base64");
    expect(malformedKey).toHaveLength(publicKey.length);
    await writeFile(
      invalidKeyOwner,
      validRecord.replace(
        `"holderPublicKey":"${publicKey}"`,
        `"holderPublicKey":"${malformedKey}"`,
      ),
    );
    const invalidKeyRecovered = await lock(invalidKey.cache);
    expect((await invalidKeyRecovered.release()).ok).toBe(true);

    for (const malformedPublicKey of [
      "=".repeat(publicKey.length),
      generateKeyPairSync("x25519")
        .publicKey.export({ format: "der", type: "spki" })
        .toString("base64"),
    ]) {
      const malformed = await cacheWithHooks();
      const malformedWriter = await lock(malformed.cache);
      const malformedOwner = path.join(malformed.root, "v1/locks/writer.v0.json");
      const malformedRecord = await readFile(malformedOwner, "utf8");
      expect(await malformedWriter.release()).toEqual({ ok: true, value: { released: true } });
      const encoded = /"holderPublicKey":"([^"]+)"/u.exec(malformedRecord)?.[1];
      if (encoded === undefined) throw new Error("expected holder public key");
      expect(malformedPublicKey).toHaveLength(encoded.length);
      await writeFile(
        malformedOwner,
        malformedRecord.replace(
          `"holderPublicKey":"${encoded}"`,
          `"holderPublicKey":"${malformedPublicKey}"`,
        ),
      );
      const malformedRecovered = await lock(malformed.cache);
      expect((await malformedRecovered.release()).ok).toBe(true);
    }

    const noncanonical = await cacheWithHooks();
    const noncanonicalWriter = await lock(noncanonical.cache);
    const noncanonicalOwner = path.join(noncanonical.root, "v1/locks/writer.v0.json");
    expect(await noncanonicalWriter.release()).toEqual({ ok: true, value: { released: true } });
    await writeFile(noncanonicalOwner, `${await readFile(noncanonicalOwner, "utf8")}\n`);
    const noncanonicalRecovered = await lock(noncanonical.cache);
    expect((await noncanonicalRecovered.release()).ok).toBe(true);
  });

  test("does not treat an unrelated listener reusing a released holder port as live authority", async () => {
    const selected = await cacheWithHooks();
    const writer = await lock(selected.cache);
    const ownerPath = path.join(selected.root, "v1/locks/writer.v0.json");
    const record = await readFile(ownerPath, "utf8");
    const portText = /"holderPort":([0-9]+)/u.exec(record)?.[1];
    if (portText === undefined) throw new Error("expected holder port");
    expect(await writer.release()).toEqual({ ok: true, value: { released: true } });

    for (const response of ["wrong-signature", "oversized", "empty", "stall"] as const) {
      const sockets = new Set<ReturnType<typeof createConnection>>();
      const impostor = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.once("data", () => {
          if (response === "wrong-signature")
            socket.end(`${Buffer.alloc(64).toString("base64")}\n`);
          else if (response === "oversized") socket.end(`${"x".repeat(90)}\n`);
          else if (response === "empty") socket.end();
          else socket.setTimeout(1_200, () => socket.destroy());
        });
      });
      await new Promise<void>((resolve, reject) => {
        impostor.once("error", reject);
        impostor.listen({ exclusive: true, host: "127.0.0.1", port: Number(portText) }, resolve);
      });
      expectIssue(await selected.cache.acquireWriteLock(options()), "lock-timeout");
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        impostor.close(() => {
          resolve();
        }),
      );
    }
    const successor = await lock(selected.cache);
    expect((await successor.release()).ok).toBe(true);
  });

  test("shares one monotonic deadline and contains drip-probe callback expiry", async () => {
    const selected = await cacheWithHooks();
    const writer = await lock(selected.cache);
    const record = await readFile(path.join(selected.root, "v1/locks/writer.v0.json"), "utf8");
    const portText = /"holderPort":([0-9]+)/u.exec(record)?.[1];
    if (portText === undefined) throw new Error("expected holder port");
    expect(await writer.release()).toEqual({ ok: true, value: { released: true } });
    const sockets = new Set<ReturnType<typeof createConnection>>();
    const stalled = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        const drip = globalThis.setInterval(() => {
          socket.write("x");
        }, 400);
        socket.once("close", () => {
          globalThis.clearInterval(drip);
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      stalled.once("error", reject);
      stalled.listen({ exclusive: true, host: "127.0.0.1", port: Number(portText) }, resolve);
    });
    const controller = new AbortController();
    const cancellation = globalThis.setTimeout(() => {
      controller.abort();
    }, 50);
    expectIssue(
      await selected.cache.acquireWriteLock(
        options({ maxAttempts: 3, retryDelayMs: 0, signal: controller.signal }),
      ),
      "cancelled",
    );
    globalThis.clearTimeout(cancellation);
    const started = performance.now();
    expectIssue(
      await selected.cache.acquireWriteLock(options({ maxAttempts: 3, retryDelayMs: 0 })),
      "lock-timeout",
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(1_400);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) =>
      stalled.close(() => {
        resolve();
      }),
    );
    const successor = await lock(selected.cache);
    expect((await successor.release()).ok).toBe(true);
  });

  test("enforces cancellation and expiry at bind, retry, acquisition, and cleanup boundaries", async () => {
    const bindCancellation = new AbortController();
    const binding = await cacheWithHooks({
      beforeLockHolderListen(): void {
        bindCancellation.abort();
        throw new Error("late bind hook failure");
      },
    });
    expectIssue(
      await binding.cache.acquireWriteLock(options({ signal: bindCancellation.signal })),
      "cancelled",
    );

    const retryCancellation = new AbortController();
    const retrying = await cacheWithHooks({
      beforeLockRetryWait(): void {
        globalThis.setTimeout(() => {
          retryCancellation.abort();
        }, 25);
      },
    });
    const held = await lock(retrying.cache);
    expectIssue(
      await retrying.cache.acquireWriteLock(
        options({ maxAttempts: 2, retryDelayMs: 500, signal: retryCancellation.signal }),
      ),
      "cancelled",
    );
    expect((await held.release()).ok).toBe(true);

    let expireOnce = true;
    const acquisitionExpiry = await cacheWithHooks({
      async afterLockOwnerTemporaryWrite(): Promise<void> {
        if (!expireOnce) return;
        expireOnce = false;
        await new Promise((resolve) => globalThis.setTimeout(resolve, 920));
      },
    });
    expectIssue(await acquisitionExpiry.cache.acquireWriteLock(options()), "lock-timeout");
    expect(await directoryNames(path.join(acquisitionExpiry.root, "v1/locks"))).toEqual([]);
    expect(await directoryNames(path.join(acquisitionExpiry.root, "v1/temporary"))).toHaveLength(1);
    const reacquired = await lock(acquisitionExpiry.cache);
    expect((await reacquired.release()).ok).toBe(true);
  });

  test("classifies same-length corruption and moves only that entry into bounded quarantine", async () => {
    const { cache, root } = await cacheWithHooks();
    const writer = await lock(cache);
    const good = Buffer.from("last-known-good");
    const corrupt = Buffer.from("cache-corruption");
    const goodDigest = sha256(good);
    const corruptDigest = sha256(corrupt);
    expect(
      (await cache.storeEntry(writer, { bytes: good, kind: "artifact", sha256: goodDigest })).ok,
    ).toBe(true);
    expect(
      (await cache.storeEntry(writer, { bytes: corrupt, kind: "artifact", sha256: corruptDigest }))
        .ok,
    ).toBe(true);
    const corruptPath = artifactPath(root, "artifact", corruptDigest);
    await chmod(corruptPath, 0o600);
    const changed = Buffer.from(corrupt);
    changed[0] = changed[0] === 0 ? 1 : 0;
    await writeFile(corruptPath, changed);
    expectIssue(
      await cache.readEntry({ kind: "artifact", length: changed.length, sha256: corruptDigest }),
      "digest-mismatch",
    );
    const quarantined = await cache.quarantineCorruptEntry(writer, {
      kind: "artifact",
      length: changed.length,
      sha256: corruptDigest,
    });
    expect(quarantined.ok).toBe(true);
    if (!quarantined.ok) throw new Error(JSON.stringify(quarantined.issues));
    expect(quarantined.value.path).toMatch(/^quarantine\/artifact-sha256-[a-f0-9-]+\.corrupt$/u);
    expect(await readFile(path.join(root, "v1", quarantined.value.path))).toEqual(changed);
    expectIssue(
      await cache.readEntry({ kind: "artifact", length: changed.length, sha256: corruptDigest }),
      "cache-miss",
    );
    await writeFile(corruptPath, changed, { mode: 0o600 });
    await chmod(corruptPath, 0o600);
    const repeated = await cache.quarantineCorruptEntry(writer, {
      kind: "artifact",
      length: changed.length,
      sha256: corruptDigest,
    });
    expect(repeated).toEqual(quarantined);
    expectIssue(
      await cache.readEntry({ kind: "artifact", length: changed.length, sha256: corruptDigest }),
      "cache-miss",
    );
    expect(
      (await cache.readEntry({ kind: "artifact", length: good.length, sha256: goodDigest })).ok,
    ).toBe(true);
    expectIssue(
      await cache.quarantineCorruptEntry(writer, {
        kind: "artifact",
        length: good.length,
        sha256: goodDigest,
      }),
      "invalid-input",
    );
    await writer.release();
  });

  test("fails closed when quarantine is full and preserves the corrupt source", async () => {
    const { cache, root } = await cacheWithHooks();
    const writer = await lock(cache);
    const raw = Buffer.from("full-quarantine");
    const expected = sha256(raw);
    await cache.storeEntry(writer, { bytes: raw, kind: "artifact", sha256: expected });
    const target = artifactPath(root, "artifact", expected);
    const changed = Buffer.from(raw);
    changed[0] = 0;
    await writeFile(target, changed);
    for (let index = 0; index < MAX_STANDARDS_CACHE_QUARANTINE_ENTRIES; index += 1)
      await writeFile(
        path.join(root, "v1/quarantine", `${String(index).padStart(2, "0")}.corrupt`),
        "x",
      );
    expectIssue(
      await cache.quarantineCorruptEntry(writer, {
        kind: "artifact",
        length: changed.length,
        sha256: expected,
      }),
      "quarantine-full",
    );
    expect(await readFile(target)).toEqual(changed);
    await writer.release();
  });

  test("rejects missing quarantine targets, unsafe quarantine contents, and collisions", async () => {
    const missing = await cacheWithHooks();
    const missingLock = await lock(missing.cache);
    expectIssue(
      await missing.cache.quarantineCorruptEntry(missingLock, {
        kind: "artifact",
        length: 1,
        sha256: "0".repeat(64),
      }),
      "cache-miss",
    );
    await mkdir(path.join(missing.root, "v1/quarantine/unsafe-directory"));
    const raw = Buffer.from("unsafe-quarantine");
    const expected = sha256(raw);
    await missing.cache.storeEntry(missingLock, { bytes: raw, kind: "artifact", sha256: expected });
    const changed = Buffer.from(raw);
    changed[0] = 0;
    await writeFile(artifactPath(missing.root, "artifact", expected), changed);
    expectIssue(
      await missing.cache.quarantineCorruptEntry(missingLock, {
        kind: "artifact",
        length: changed.length,
        sha256: expected,
      }),
      "unsafe-cache",
    );
    await missingLock.release();

    const collision = await cacheWithHooks();
    const collisionLock = await lock(collision.cache);
    await collision.cache.storeEntry(collisionLock, {
      bytes: raw,
      kind: "artifact",
      sha256: expected,
    });
    await writeFile(artifactPath(collision.root, "artifact", expected), changed);
    const observed = sha256(changed);
    await writeFile(
      path.join(collision.root, `v1/quarantine/artifact-sha256-${expected}-${observed}.corrupt`),
      "different-but-same-length".slice(0, changed.length),
    );
    const collisionPath = path.join(
      collision.root,
      `v1/quarantine/artifact-sha256-${expected}-${observed}.corrupt`,
    );
    if (process.platform !== "win32") {
      await chmod(collisionPath, 0o644);
      expectIssue(
        await collision.cache.quarantineCorruptEntry(collisionLock, {
          kind: "artifact",
          length: changed.length,
          sha256: expected,
        }),
        "unsafe-cache",
      );
    }
    await chmod(collisionPath, 0o600);
    expectIssue(
      await collision.cache.quarantineCorruptEntry(collisionLock, {
        kind: "artifact",
        length: changed.length,
        sha256: expected,
      }),
      "unsafe-cache",
    );
    expect(await readFile(artifactPath(collision.root, "artifact", expected))).toEqual(changed);
    await collisionLock.release();
  });

  test("preserves a corrupt source replaced after classification", async () => {
    let armed = false;
    const selected = await cacheWithHooks({
      async beforeQuarantineSourceRemove(absolute): Promise<void> {
        if (!armed) return;
        armed = false;
        const bytes = await readFile(absolute);
        await unlink(absolute);
        await writeFile(absolute, bytes);
      },
    });
    const raw = Buffer.from("quarantine-race");
    const expected = sha256(raw);
    const writer = await lock(selected.cache);
    await selected.cache.storeEntry(writer, { bytes: raw, kind: "artifact", sha256: expected });
    const target = artifactPath(selected.root, "artifact", expected);
    const changed = Buffer.from(raw);
    changed[0] = 0;
    await writeFile(target, changed);
    armed = true;
    expectIssue(
      await selected.cache.quarantineCorruptEntry(writer, {
        kind: "artifact",
        length: changed.length,
        sha256: expected,
      }),
      "concurrent-change",
    );
    expect(await readFile(target)).toEqual(changed);
    await writer.release();
  });

  test("preserves corrupt source data when a quarantine output gains another link", async () => {
    let linkedPath = "";
    const selected = await cacheWithHooks({
      async afterQuarantineWrite(absolute): Promise<void> {
        linkedPath = absolute;
        await link(absolute, `${absolute}.hardlink`);
      },
    });
    const raw = Buffer.from("quarantine-link-race");
    const expected = sha256(raw);
    const writer = await lock(selected.cache);
    expect(
      (
        await selected.cache.storeEntry(writer, {
          bytes: raw,
          kind: "artifact",
          sha256: expected,
        })
      ).ok,
    ).toBe(true);
    const target = artifactPath(selected.root, "artifact", expected);
    const changed = Buffer.from(raw);
    changed[0] = changed[0] === 0 ? 1 : 0;
    await writeFile(target, changed);
    expectIssue(
      await selected.cache.quarantineCorruptEntry(writer, {
        kind: "artifact",
        length: changed.length,
        sha256: expected,
      }),
      "concurrent-change",
    );
    expect(linkedPath).not.toBe("");
    expect(await readFile(target)).toEqual(changed);
    await writer.release();

    const throwing = await cacheWithHooks({
      afterQuarantineWrite(): never {
        throw new Error("fault injection after quarantine write");
      },
    });
    const throwingWriter = await lock(throwing.cache);
    expect(
      (
        await throwing.cache.storeEntry(throwingWriter, {
          bytes: raw,
          kind: "artifact",
          sha256: expected,
        })
      ).ok,
    ).toBe(true);
    const throwingTarget = artifactPath(throwing.root, "artifact", expected);
    await writeFile(throwingTarget, changed);
    expectIssue(
      await throwing.cache.quarantineCorruptEntry(throwingWriter, {
        kind: "artifact",
        length: changed.length,
        sha256: expected,
      }),
      "io-failure",
    );
    expect(await readFile(throwingTarget)).toEqual(changed);
    await throwingWriter.release();
  });
});
