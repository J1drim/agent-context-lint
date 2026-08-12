import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  AtomicWriteError,
  AtomicWriteErrorCode,
  createAtomicRepositoryWriter,
  createReadOnlyRepository,
  selectRepositoryRoot,
} from "../../packages/evidence/src/index.js";
import {
  DEFAULT_STANDARDS_LOCKFILE_PATH,
  loadBundledKnowledgePack,
  parseCanonicalStandardsLockfile,
  rollbackStandardsUpdate,
  serializeKnowledgePack,
  serializeStandardsLockfile,
} from "../../packages/standards/src/index.js";
import { openStandardsCacheFixtureForTest } from "../../packages/standards/src/standards-cache.js";
import { createStandardsUpdaterFixtureForTest } from "../../packages/standards/src/standards-update.js";
import { withTempWorkspace } from "../../packages/test-kit/src/workspace.js";

import type {
  KnowledgePack,
  LoadedBundledKnowledgePack,
  StandardsCheckReport,
  StandardsLockfile,
  StandardsUpdater,
} from "../../packages/standards/src/index.js";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function packText(value: unknown): string {
  const result = serializeKnowledgePack(value);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.text;
}

function lockText(value: unknown): string {
  const result = serializeStandardsLockfile(value);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.text;
}

function lockFor(bundle: LoadedBundledKnowledgePack): StandardsLockfile {
  return {
    channel: bundle.pack.channel,
    pack: {
      packId: bundle.pack.packId,
      packVersion: bundle.pack.packVersion,
      publishedAt: bundle.pack.publishedAt,
      schemaVersion: bundle.pack.schemaVersion,
    },
    recordKind: "agent-context-standards-lock",
    schemaVersion: "1.0.0",
    target: bundle.provenance.target,
    trustedState: bundle.provenance.trustedState,
    verificationTime: bundle.provenance.verificationTime,
  };
}

function candidate(bundle: LoadedBundledKnowledgePack): {
  readonly bytes: Uint8Array;
  readonly pack: KnowledgePack;
} {
  const value = structuredClone(bundle.pack) as unknown as Record<string, unknown>;
  value["packVersion"] = "2026.8.1";
  const text = packText(value);
  return { bytes: Buffer.from(text), pack: JSON.parse(text) as KnowledgePack };
}

function updater(
  bundle: LoadedBundledKnowledgePack,
  selected: ReturnType<typeof candidate>,
): StandardsUpdater {
  const report: StandardsCheckReport = Object.freeze({
    acquisitions: Object.freeze([]),
    candidate: bundle.provenance.trustedState,
    checkedAt: bundle.provenance.verificationTime,
    contractVersion: "0.1.0",
    current: bundle.provenance.trustedState,
    recovery: Object.freeze({
      rootVersionsApplied: Object.freeze([]),
      snapshotAuthorityRotated: false,
      timestampAuthorityRotated: false,
    }),
    requestsAttempted: 6,
    target: Object.freeze({
      ...bundle.provenance.target,
      length: selected.bytes.byteLength,
      packVersion: selected.pack.packVersion,
      sha256: sha256(selected.bytes),
    }),
  });
  return createStandardsUpdaterFixtureForTest({
    check: () =>
      Promise.resolve({
        ok: true as const,
        value: { report, targetBytes: new Uint8Array(selected.bytes) },
      }),
  });
}

describe("H09 standards update with H04/H05/I10", () => {
  test("activates one canonical lock and restores the exact prior lock through real CAS", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const loaded = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
      const bundle = loaded.value;
      const currentPack = packText(bundle.pack);
      const currentLock = lockText(lockFor(bundle));
      const next = candidate(bundle);
      const root = workspace.resolvePath("repository");
      const cacheRoot = path.join(await realpath(workspace.root), "cache");
      await mkdir(root);
      const lockPath = workspace.resolvePath(`repository/${DEFAULT_STANDARDS_LOCKFILE_PATH}`);
      await writeFile(lockPath, currentLock);
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const repository = await createReadOnlyRepository(selection);
      const observed = await repository.readFile(DEFAULT_STANDARDS_LOCKFILE_PATH);
      const writer = await createAtomicRepositoryWriter(selection);
      const openedCache = await openStandardsCacheFixtureForTest(cacheRoot, {});
      if (!openedCache.ok) throw new Error(JSON.stringify(openedCache.issues));
      const result = await updater(bundle, next).activate(
        {
          check: {
            channel: "stable",
            engineVersion: "1.0.0",
            targetPath: bundle.provenance.target.targetPath,
          },
          currentLockfile: observed.bytes(),
          currentPack,
        },
        {
          cache: openedCache.value,
          cacheLock: { maxAttempts: 1, retryDelayMs: 0 },
          expected: { identity: observed.identity, sha256: sha256(observed.bytes()) },
          path: DEFAULT_STANDARDS_LOCKFILE_PATH,
          signal: new AbortController().signal,
          writer,
        },
      );
      expect(result).toMatchObject({ ok: true, value: { activation: "activated" } });
      if (!result.ok || result.value.receipt === null) throw new Error("expected receipt");
      expect(parseCanonicalStandardsLockfile(await readFile(lockPath))).toMatchObject({
        ok: true,
        value: { pack: { packVersion: "2026.8.1" } },
      });
      const rolledBack = await rollbackStandardsUpdate(writer, result.value.receipt);
      expect(rolledBack).toMatchObject({ ok: true });
      expect(await readFile(lockPath, "utf8")).toBe(currentLock);
      expect(await readdir(root)).toEqual([DEFAULT_STANDARDS_LOCKFILE_PATH]);
    });
  });

  test("dry-run leaves the repository and unopened cache root byte-for-byte absent", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const loaded = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
      const bundle = loaded.value;
      const prior = lockText(lockFor(bundle));
      const root = workspace.resolvePath("repository");
      await mkdir(root);
      const lockPath = workspace.resolvePath(`repository/${DEFAULT_STANDARDS_LOCKFILE_PATH}`);
      await writeFile(lockPath, prior);
      const result = await updater(bundle, candidate(bundle)).dryRun(
        {
          check: {
            channel: "stable",
            engineVersion: "1.0.0",
            targetPath: bundle.provenance.target.targetPath,
          },
          currentLockfile: prior,
          currentPack: packText(bundle.pack),
        },
        { signal: new AbortController().signal },
      );
      expect(result).toMatchObject({ ok: true, value: { mode: "dry-run" } });
      expect(await readFile(lockPath, "utf8")).toBe(prior);
      expect(await readdir(workspace.root)).toEqual(["repository"]);
    });
  });

  test("concurrent replacement and precommit cancellation preserve the observed lock truth", async () => {
    for (const mode of ["concurrent", "cancelled"] as const) {
      await withTempWorkspace({}, async (workspace) => {
        const loaded = await loadBundledKnowledgePack({
          channel: "stable",
          engineVersion: "0.0.0",
        });
        if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
        const bundle = loaded.value;
        const prior = lockText(lockFor(bundle));
        const root = workspace.resolvePath("repository");
        await mkdir(root);
        const lockPath = workspace.resolvePath(`repository/${DEFAULT_STANDARDS_LOCKFILE_PATH}`);
        await writeFile(lockPath, prior);
        const selection = await selectRepositoryRoot(root, { mode: "explicit" });
        const repository = await createReadOnlyRepository(selection);
        const observed = await repository.readFile(DEFAULT_STANDARDS_LOCKFILE_PATH);
        const concurrentLock = structuredClone(lockFor(bundle));
        (concurrentLock.pack as { packVersion: string }).packVersion = "2026.7.9";
        (concurrentLock.target as { packVersion: string }).packVersion = "2026.7.9";
        const concurrent = Buffer.from(mode === "concurrent" ? lockText(concurrentLock) : prior);
        const controller = new AbortController();
        if (mode === "concurrent") await writeFile(lockPath, concurrent);
        const writer = await createAtomicRepositoryWriter(selection, { signal: controller.signal });
        const openedCache = await openStandardsCacheFixtureForTest(
          path.join(await realpath(workspace.root), `cache-${mode}`),
          {},
        );
        if (!openedCache.ok) throw new Error(JSON.stringify(openedCache.issues));
        const next = candidate(bundle);
        if (mode === "cancelled") {
          const acquired = await openedCache.value.acquireWriteLock({
            maxAttempts: 1,
            retryDelayMs: 0,
            signal: new AbortController().signal,
          });
          if (!acquired.ok) throw new Error(JSON.stringify(acquired.issues));
          const stored = await openedCache.value.storeEntry(acquired.value, {
            bytes: next.bytes,
            kind: "artifact",
            sha256: sha256(next.bytes),
          });
          if (!stored.ok) throw new Error(JSON.stringify(stored.issues));
          await acquired.value.release();
          controller.abort();
        }
        let thrown: unknown;
        try {
          await updater(bundle, next).activate(
            {
              check: {
                channel: "stable",
                engineVersion: "1.0.0",
                targetPath: bundle.provenance.target.targetPath,
              },
              currentLockfile: prior,
              currentPack: packText(bundle.pack),
            },
            {
              cache: openedCache.value,
              cacheLock: { maxAttempts: 1, retryDelayMs: 0 },
              expected: { identity: observed.identity, sha256: sha256(observed.bytes()) },
              path: DEFAULT_STANDARDS_LOCKFILE_PATH,
              signal: controller.signal,
              writer,
            },
          );
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(AtomicWriteError);
        expect(thrown).toMatchObject({
          code:
            mode === "concurrent"
              ? AtomicWriteErrorCode.concurrentChange
              : AtomicWriteErrorCode.aborted,
          committed: false,
        });
        expect(await readFile(lockPath)).toEqual(concurrent);
      });
    }
  });
});
