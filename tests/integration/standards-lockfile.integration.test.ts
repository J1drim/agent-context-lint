import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

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
  parseCanonicalStandardsLockfile,
  serializeStandardsLockfile,
  updateStandardsLockfile,
} from "../../packages/standards/src/index.js";
import { withTempWorkspace } from "../../packages/test-kit/src/workspace.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function summary(role: string): Record<string, unknown> {
  return {
    expires: "2026-08-02T00:00:00Z",
    issuedAt: "2026-07-31T00:00:00Z",
    role,
    sha256: HASH_A,
    version: 1,
  };
}

function lockfile(packVersion: string): Record<string, unknown> {
  return {
    channel: "stable",
    pack: {
      packId: "agent-context-bundled",
      packVersion,
      publishedAt: "2026-08-01",
      schemaVersion: "0.1.0",
    },
    recordKind: "agent-context-standards-lock",
    schemaVersion: "1.0.0",
    target: {
      channel: "stable",
      length: 4096,
      minEngineVersion: "0.0.0",
      packId: "agent-context-bundled",
      packVersion,
      schemaVersion: "0.1.0",
      sha256: HASH_B,
      targetPath: `knowledge/stable/agent-context-bundled-${packVersion}.json`,
    },
    trustedState: {
      contractVersion: "0.1.0",
      delegated: { preview: null, stable: summary("standards-stable") },
      repositoryId: "agent-context-standards",
      root: summary("root"),
      snapshot: summary("snapshot"),
      targets: summary("targets"),
      timestamp: summary("timestamp"),
    },
    verificationTime: "2026-08-01T12:00:00Z",
  };
}

function canonical(value: unknown): string {
  const serialized = serializeStandardsLockfile(value);
  if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
  return serialized.text;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("H04 standards lockfile with the I10 atomic writer", () => {
  test("fails closed instead of creating a missing repository lock", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repository");
      await mkdir(root);
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const writer = await createAtomicRepositoryWriter(selection);

      await expect(
        updateStandardsLockfile(writer, {
          expected: { identity: { device: "1", inode: "1" }, sha256: HASH_A },
          lockfile: lockfile("2026.8.0"),
          path: DEFAULT_STANDARDS_LOCKFILE_PATH,
        }),
      ).rejects.toMatchObject({ committed: false });
      expect(await readdir(root)).toEqual([]);
    });
  });

  test("replaces an observed existing lock and leaves one canonical valid file", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repository");
      await mkdir(root);
      await writeFile(
        workspace.resolvePath(`repository/${DEFAULT_STANDARDS_LOCKFILE_PATH}`),
        canonical(lockfile("2026.8.0")),
      );
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const repository = await createReadOnlyRepository(selection);
      const observed = await repository.readFile(DEFAULT_STANDARDS_LOCKFILE_PATH);
      const writer = await createAtomicRepositoryWriter(selection);
      const result = await updateStandardsLockfile(writer, {
        expected: { identity: observed.identity, sha256: digest(observed.bytes()) },
        lockfile: lockfile("2026.8.1"),
        path: DEFAULT_STANDARDS_LOCKFILE_PATH,
      });

      expect(result.previousSha256).toBe(digest(observed.bytes()));
      const published = await readFile(
        workspace.resolvePath(`repository/${DEFAULT_STANDARDS_LOCKFILE_PATH}`),
      );
      expect(parseCanonicalStandardsLockfile(published)).toMatchObject({
        ok: true,
        value: { pack: { packVersion: "2026.8.1" } },
      });
      expect(result.sha256).toBe(digest(published));
      expect(await readdir(root)).toEqual([DEFAULT_STANDARDS_LOCKFILE_PATH]);
    });
  });

  test("an interrupted pre-commit update leaves the prior canonical lock byte-for-byte intact", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repository");
      await mkdir(root);
      const prior = Buffer.from(canonical(lockfile("2026.8.0")));
      await writeFile(
        workspace.resolvePath(`repository/${DEFAULT_STANDARDS_LOCKFILE_PATH}`),
        prior,
      );
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const repository = await createReadOnlyRepository(selection);
      const observed = await repository.readFile(DEFAULT_STANDARDS_LOCKFILE_PATH);
      const controller = new AbortController();
      controller.abort();
      const writer = await createAtomicRepositoryWriter(selection, { signal: controller.signal });

      let thrown: unknown;
      try {
        await updateStandardsLockfile(writer, {
          expected: { identity: observed.identity, sha256: digest(observed.bytes()) },
          lockfile: lockfile("2026.8.1"),
          path: DEFAULT_STANDARDS_LOCKFILE_PATH,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AtomicWriteError);
      expect(thrown).toMatchObject({ code: AtomicWriteErrorCode.aborted, committed: false });
      const after = await readFile(
        workspace.resolvePath(`repository/${DEFAULT_STANDARDS_LOCKFILE_PATH}`),
      );
      expect(after).toEqual(prior);
      expect(parseCanonicalStandardsLockfile(after)).toMatchObject({ ok: true });
      expect(await readdir(root)).toEqual([DEFAULT_STANDARDS_LOCKFILE_PATH]);
    });
  });

  test("rejects a stale observation without overwriting the concurrently replaced valid lock", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repository");
      const target = workspace.resolvePath(`repository/${DEFAULT_STANDARDS_LOCKFILE_PATH}`);
      await mkdir(root);
      await writeFile(target, canonical(lockfile("2026.8.0")));
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const repository = await createReadOnlyRepository(selection);
      const observed = await repository.readFile(DEFAULT_STANDARDS_LOCKFILE_PATH);
      const concurrent = Buffer.from(canonical(lockfile("2026.8.1")));
      await writeFile(target, concurrent);
      const writer = await createAtomicRepositoryWriter(selection);

      await expect(
        updateStandardsLockfile(writer, {
          expected: { identity: observed.identity, sha256: digest(observed.bytes()) },
          lockfile: lockfile("2026.8.2"),
          path: DEFAULT_STANDARDS_LOCKFILE_PATH,
        }),
      ).rejects.toMatchObject({ code: AtomicWriteErrorCode.concurrentChange, committed: false });
      const after = await readFile(target);
      expect(after).toEqual(concurrent);
      expect(parseCanonicalStandardsLockfile(after)).toMatchObject({
        ok: true,
        value: { pack: { packVersion: "2026.8.1" } },
      });
    });
  });
});
