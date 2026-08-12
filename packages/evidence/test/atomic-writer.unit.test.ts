import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test } from "vitest";

import {
  ATOMIC_WRITER_CONTRACT_VERSION,
  ATOMIC_WRITER_DEFAULT_MAXIMUM_BYTES,
  AtomicWriteError,
  AtomicWriteErrorCode,
  createAtomicRepositoryWriter,
  createAtomicRepositoryWriterWithFileSystem,
  createReadOnlyRepository,
  selectRepositoryRoot,
} from "../src/index.js";
import type {
  AtomicRepositoryWriter,
  AtomicWriteRequest,
  AtomicWriterFileHandle,
  AtomicWriterFileSystemCapability,
  AtomicWriterTestHooks,
  RepositoryRootSelection,
} from "../src/index.js";

const nativeCapability: AtomicWriterFileSystemCapability = Object.freeze({
  lstat: async (target: string): Promise<BigIntStats> => lstat(target, { bigint: true }),
  open: async (target: string, flags: number, mode?: number): Promise<FileHandle> =>
    open(target, flags, mode),
  platform: process.platform,
  randomToken: (): string => "0123456789abcdef0123456789abcdef",
  realpath: async (target: string): Promise<string> => realpath(target),
  rename: async (source: string, destination: string): Promise<void> => rename(source, destination),
  unlink: async (target: string): Promise<void> => unlink(target),
});

function capability(
  overrides: Partial<AtomicWriterFileSystemCapability> = {},
): AtomicWriterFileSystemCapability {
  return { ...nativeCapability, ...overrides };
}

function bindHandleMember(handle: FileHandle, property: PropertyKey): unknown {
  const member = Reflect.get(handle, property, handle) as unknown;
  return typeof member === "function" ? member.bind(handle) : member;
}

function handleProxy(
  handle: FileHandle,
  overrides: Readonly<Record<PropertyKey, unknown>>,
): AtomicWriterFileHandle {
  return new Proxy(handle, {
    get(target, property): unknown {
      return Object.hasOwn(overrides, property)
        ? Reflect.get(overrides, property)
        : bindHandleMember(target, property);
    },
  });
}

function statsProxy(
  stats: BigIntStats,
  overrides: Readonly<Record<PropertyKey, unknown>>,
): BigIntStats {
  return new Proxy(stats, {
    get(target, property): unknown {
      const member: unknown = Object.hasOwn(overrides, property)
        ? Reflect.get(overrides, property)
        : (Reflect.get(target, property, target) as unknown);
      return typeof member === "function"
        ? (...arguments_: readonly unknown[]): unknown => Reflect.apply(member, target, arguments_)
        : member;
    },
  });
}

function codedError(code: string): Error {
  return Object.assign(new Error("injected filesystem failure"), { code });
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function selectionAt(root: string): Promise<RepositoryRootSelection> {
  return selectRepositoryRoot(root, { mode: "explicit" });
}

async function requestAt(
  selection: RepositoryRootSelection,
  relativePath: string,
  replacement: Uint8Array | string,
): Promise<AtomicWriteRequest> {
  const repository = await createReadOnlyRepository(selection);
  const file = await repository.readFile(relativePath);
  return {
    expected: { identity: file.identity, sha256: digest(file.bytes()) },
    path: canonicalizeRepositoryRelativePath(relativePath),
    replacement: typeof replacement === "string" ? Buffer.from(replacement, "utf8") : replacement,
  };
}

async function writerWith(
  selection: RepositoryRootSelection,
  fileSystem: AtomicWriterFileSystemCapability = nativeCapability,
  hooks: AtomicWriterTestHooks = {},
  options?: unknown,
): Promise<AtomicRepositoryWriter> {
  return createAtomicRepositoryWriterWithFileSystem(selection, options, fileSystem, hooks);
}

function expectAtomicError(
  error: unknown,
  code: string,
  committed = false,
  operation?: string,
): boolean {
  expect(error).toBeInstanceOf(AtomicWriteError);
  expect(error).toMatchObject({
    code,
    committed,
    ...(operation === undefined ? {} : { operation }),
  });
  expect(Object.isFrozen(error)).toBe(true);
  return true;
}

async function writerArtifacts(directory: string): Promise<readonly string[]> {
  return (await readdir(directory)).filter((name) => name.startsWith(".agent-context-lint-"));
}

describe("I10 atomic repository writer", () => {
  test("atomically replaces exact analyzed bytes, preserves mode, and cleans artifacts", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/nested/context.md");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "old");
      if (process.platform !== "win32") await chmod(target, 0o740);
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "nested/context.md", "new context\n");
      const writer = await createAtomicRepositoryWriter(selection);

      const result = await writer.write(request);

      expect(await readFile(target, "utf8")).toBe("new context\n");
      expect(result).toMatchObject({
        bytesWritten: 12,
        contractVersion: ATOMIC_WRITER_CONTRACT_VERSION,
        path: "nested/context.md",
        previousSha256: request.expected.sha256,
        sha256: digest("new context\n"),
      });
      expect(result.identity.device).toMatch(/^(?:0|[1-9][0-9]*)$/u);
      expect(result.identity.inode).toMatch(/^(?:0|[1-9][0-9]*)$/u);
      if (process.platform === "win32") expect(Number.isInteger(result.mode)).toBe(true);
      else expect(result.mode).toBe(0o740);
      expect(["file-and-directory", "file-only"]).toContain(result.durability);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.identity)).toBe(true);
      expect(Object.isFrozen(writer)).toBe(true);
      expect(writer.maximumBytes).toBe(ATOMIC_WRITER_DEFAULT_MAXIMUM_BYTES);
      expect(await writerArtifacts(path.dirname(target))).toEqual([]);
      if (process.platform !== "win32")
        expect(Number((await lstat(target, { bigint: true })).mode & 0o777n)).toBe(0o740);
    });
  });

  test("copies replacement bytes before awaiting filesystem work and supports an empty file", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const target = workspace.resolvePath("repo/file");
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const replacement = Uint8Array.from([110, 101, 119]);
      const request = await requestAt(selection, "file", replacement);
      const writer = await createAtomicRepositoryWriter(selection);
      const pending = writer.write(request);
      replacement.fill(120);
      await pending;
      expect(await readFile(target, "utf8")).toBe("new");

      const emptyRequest = await requestAt(selection, "file", new Uint8Array());
      await writer.write(emptyRequest);
      expect(await readFile(target)).toHaveLength(0);
    });
  });

  test("rejects stale digest and stale identity without creating artifacts", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "replacement");
      const writer = await createAtomicRepositoryWriter(selection);
      const staleDigest = {
        ...request,
        expected: { ...request.expected, sha256: "0".repeat(64) },
      };
      await expect(writer.write(staleDigest)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.concurrentChange),
      );
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await writerArtifacts(root)).toEqual([]);

      const replacementPath = workspace.resolvePath("repo/replacement");
      await writeFile(replacementPath, "old");
      await rename(replacementPath, target);
      await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.concurrentChange),
      );
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await writerArtifacts(root)).toEqual([]);
    });
  });

  test.each(["beforeCommitValidation", "beforeRename"] as const)(
    "detects concurrent content mutation at %s",
    async (hookName) => {
      await withTempWorkspace({}, async (workspace) => {
        const root = workspace.resolvePath("repo");
        const target = workspace.resolvePath("repo/file");
        await mkdir(root);
        await writeFile(target, "old");
        const selection = await selectionAt(root);
        const request = await requestAt(selection, "file", "writer");
        const writer = await writerWith(selection, nativeCapability, {
          [hookName]: async (): Promise<void> => writeFile(target, "concurrent"),
        });

        await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
          expectAtomicError(error, AtomicWriteErrorCode.concurrentChange),
        );
        expect(await readFile(target, "utf8")).toBe("concurrent");
        expect(await writerArtifacts(root)).toEqual([]);
      });
    },
  );

  test("serializes cooperative concurrent writers with an exclusive target lock", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const firstRequest = await requestAt(selection, "file", "first");
      const secondRequest = await requestAt(selection, "file", "second");
      let releaseFirst!: () => void;
      let firstReached!: () => void;
      const reached = new Promise<void>((resolve) => {
        firstReached = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstWriter = await writerWith(selection, nativeCapability, {
        beforeCommitValidation: async () => {
          firstReached();
          await release;
        },
      });
      const secondWriter = await createAtomicRepositoryWriter(selection);
      const first = firstWriter.write(firstRequest);
      await reached;

      await expect(secondWriter.write(secondRequest)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.concurrentChange, false, "acquire-lock"),
      );
      releaseFirst();
      await first;
      expect(await readFile(target, "utf8")).toBe("first");
      expect(await writerArtifacts(root)).toEqual([]);
    });
  });

  test("rejects read-only targets even when the process could override permissions", async () => {
    if (process.platform === "win32") return;
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      await chmod(target, 0o444);
      try {
        const writer = await createAtomicRepositoryWriter(selection);
        await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
          expectAtomicError(error, AtomicWriteErrorCode.readOnly),
        );
        expect(await readFile(target, "utf8")).toBe("old");
        expect(await writerArtifacts(root)).toEqual([]);
      } finally {
        await chmod(target, 0o600);
      }
    });
  });

  test("applies the read-only mode policy under simulated Windows semantics", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const canonicalTarget = path.join(selection.root, "file");
      const injected = capability({
        platform: "win32",
        lstat: async (targetPath) => {
          const stats = await lstat(targetPath, { bigint: true });
          return targetPath === canonicalTarget
            ? statsProxy(stats, { mode: stats.mode & ~0o222n })
            : stats;
        },
      });
      await expect((await writerWith(selection, injected)).write(request)).rejects.toSatisfy(
        (error: unknown) => expectAtomicError(error, AtomicWriteErrorCode.readOnly),
      );
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await writerArtifacts(root)).toEqual([]);
    });
  });

  test("rejects target links, hard links, directories, and linked parents", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(workspace.resolvePath("repo/real"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/real/file"), "old");
      await symlink("real/file", workspace.resolvePath("repo/link"), "file");
      await symlink(
        "real",
        workspace.resolvePath("repo/linked-parent"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await link(workspace.resolvePath("repo/real/file"), workspace.resolvePath("repo/hard"));
      const selection = await selectionAt(root);
      const writer = await createAtomicRepositoryWriter(selection);
      const repository = await createReadOnlyRepository(selection);
      const identity = (await repository.inspect("real")).identity;
      const expected = { identity, sha256: digest("old") };

      for (const candidate of ["link", "hard", "real", "linked-parent/file"]) {
        await expect(
          writer.write({
            expected,
            path: canonicalizeRepositoryRelativePath(candidate),
            replacement: Buffer.from("new"),
          }),
        ).rejects.toSatisfy((error: unknown) =>
          expectAtomicError(
            error,
            candidate === "linked-parent/file"
              ? AtomicWriteErrorCode.unsafePath
              : AtomicWriteErrorCode.unsafeType,
          ),
        );
      }
      expect(await readFile(workspace.resolvePath("repo/real/file"), "utf8")).toBe("old");
    });
  });

  test("fails closed for traversal, absolute, root, malformed, and accessor paths", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/file"), "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const writer = await createAtomicRepositoryWriter(selection);
      for (const candidate of ["../outside", "/absolute", ".", "a\\b", "a//b", "bad\0path"]) {
        await expect(writer.write({ ...request, path: candidate })).rejects.toSatisfy(
          (error: unknown) => expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
        );
      }
      const accessor: unknown = Object.create(null, {
        expected: { enumerable: true, value: request.expected },
        path: { enumerable: true, get: () => "file" },
        replacement: { enumerable: true, value: request.replacement },
      });
      await expect(writer.write(accessor)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
      );
      await expect(writer.write(new Proxy(request, {}))).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
      );
      expect(await readFile(workspace.resolvePath("repo/file"), "utf8")).toBe("old");
    });
  });

  test("cleans the exclusive temporary and lock after an injected crash before commit", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const writer = await writerWith(selection, nativeCapability, {
        afterTemporarySync: () => {
          throw codedError("EINTR");
        },
      });

      await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.ioFailed),
      );
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await writerArtifacts(root)).toEqual([]);
    });
  });

  test.each(["sync", "rename"] as const)(
    "preserves the prior file and cleans artifacts when %s fails",
    async (failure) => {
      await withTempWorkspace({}, async (workspace) => {
        const root = workspace.resolvePath("repo");
        const target = workspace.resolvePath("repo/file");
        await mkdir(root);
        await writeFile(target, "old");
        const selection = await selectionAt(root);
        const request = await requestAt(selection, "file", "new");
        const injected = capability({
          ...(failure === "rename"
            ? { rename: async (): Promise<void> => Promise.reject(codedError("EIO")) }
            : {
                open: async (
                  targetPath: string,
                  flags: number,
                  mode?: number,
                ): Promise<AtomicWriterFileHandle> => {
                  const handle = await open(targetPath, flags, mode);
                  return targetPath.endsWith(".tmp")
                    ? handleProxy(handle, {
                        sync: async (): Promise<void> => Promise.reject(codedError("EIO")),
                      })
                    : handle;
                },
              }),
        });
        const writer = await writerWith(selection, injected);

        await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
          expectAtomicError(error, AtomicWriteErrorCode.ioFailed),
        );
        expect(await readFile(target, "utf8")).toBe("old");
        expect(await writerArtifacts(root)).toEqual([]);
      });
    },
  );

  test("handles partial writes without truncating replacement bytes", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "fragmented-write");
      const injected = capability({
        open: async (targetPath, flags, mode) => {
          const handle = await open(targetPath, flags, mode);
          if (!targetPath.endsWith(".tmp")) return handle;
          return handleProxy(handle, {
            write: async (buffer: Uint8Array, offset: number, length: number, position: number) =>
              handle.write(buffer, offset, Math.min(2, length), position),
          });
        },
      });
      await (await writerWith(selection, injected)).write(request);
      expect(await readFile(target, "utf8")).toBe("fragmented-write");
    });
  });

  test("reports file-only durability when directory fsync is unsupported on Windows", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const injected = capability({
        platform: "win32",
        open: async (targetPath, flags, mode) => {
          if (targetPath === selection.root) throw codedError("EISDIR");
          return open(targetPath, flags, mode);
        },
      });
      const result = await (await writerWith(selection, injected)).write(request);
      expect(result).toMatchObject({ directorySync: "unsupported", durability: "file-only" });
      expect(await readFile(target, "utf8")).toBe("new");
    });
  });

  test("surfaces unexpected directory durability failure as committed state", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const injected = capability({
        open: async (targetPath, flags, mode) => {
          if (targetPath === selection.root) throw codedError("EIO");
          return open(targetPath, flags, mode);
        },
      });

      await expect((await writerWith(selection, injected)).write(request)).rejects.toSatisfy(
        (error: unknown) =>
          expectAtomicError(error, AtomicWriteErrorCode.durabilityFailed, true, "sync-directory"),
      );
      expect(await readFile(target, "utf8")).toBe("new");
      expect(await writerArtifacts(root)).toEqual([]);
    });
  });

  test("flushes the replacement before rename and directory metadata after publication", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const events: string[] = [];
      const injected = capability({
        open: async (targetPath, flags, mode) => {
          const handle = await open(targetPath, flags, mode);
          const temporary = targetPath.endsWith(".tmp");
          return handleProxy(handle, {
            chmod: async (selectedMode: number): Promise<void> => {
              if (temporary) events.push("mode-after-write");
              await handle.chmod(selectedMode);
            },
            sync: async (): Promise<void> => {
              events.push(temporary ? "file-sync" : "directory-sync");
              await handle.sync();
            },
            write: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
              if (temporary) events.push("replacement-write");
              return handle.write(buffer, offset, length, position);
            },
          });
        },
        rename: async (source, destination) => {
          events.push("rename");
          await rename(source, destination);
        },
      });
      await (await writerWith(selection, injected)).write(request);
      expect(events[0]).toBe("replacement-write");
      expect(events.indexOf("replacement-write")).toBeLessThan(events.indexOf("mode-after-write"));
      expect(events.indexOf("mode-after-write")).toBeLessThan(events.indexOf("file-sync"));
      expect(events.indexOf("file-sync")).toBeLessThan(events.indexOf("rename"));
      expect(events.indexOf("rename")).toBeLessThan(events.indexOf("directory-sync"));
      expect(events.filter((event) => event === "directory-sync")).toHaveLength(2);
    });
  });

  test("exhausts bounded temporary collisions and removes its lock", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/file"), "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const token = "aaaaaaaaaaaaaaaa";
      const key = createHash("sha256").update("file").digest("hex").slice(0, 32);
      const collision = path.join(root, `.agent-context-lint-${key}-${token}.tmp`);
      await writeFile(collision, "owned by repository");
      const writer = await writerWith(
        selection,
        capability({ randomToken: () => token }),
        {},
        { maximumTemporaryAttempts: 2 },
      );
      await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.temporaryCollision),
      );
      expect(await readFile(workspace.resolvePath("repo/file"), "utf8")).toBe("old");
      expect(await readFile(collision, "utf8")).toBe("owned by repository");
      expect(await writerArtifacts(root)).toEqual([path.basename(collision)]);
    });
  });

  test("does not unlink a hostile replacement substituted at the temporary path", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const target = workspace.resolvePath("repo/file");
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      let temporaryPath = "";
      const injected = capability({
        open: async (targetPath, flags, mode) => {
          if (targetPath.endsWith(".tmp")) temporaryPath = targetPath;
          return open(targetPath, flags, mode);
        },
      });
      const writer = await writerWith(selection, injected, {
        afterTemporarySync: async () => {
          await unlink(temporaryPath);
          await writeFile(temporaryPath, "attacker replacement");
        },
      });
      await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.concurrentChange),
      );
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await readFile(temporaryPath, "utf8")).toBe("attacker replacement");
    });
  });

  test("honors cancellation before work and immediately before commit", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const target = workspace.resolvePath("repo/file");
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const already = new AbortController();
      already.abort();
      const before = await createAtomicRepositoryWriter(selection, { signal: already.signal });
      await expect(before.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.aborted),
      );

      const during = new AbortController();
      const writer = await writerWith(
        selection,
        nativeCapability,
        {
          beforeCommitValidation: () => {
            during.abort();
          },
        },
        { signal: during.signal },
      );
      await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.aborted),
      );
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await writerArtifacts(root)).toEqual([]);
    });
  });

  test("validates resource bounds, byte views, options, and selection as hostile input", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/file"), "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const writer = await createAtomicRepositoryWriter(selection, { maximumBytes: 3 });
      await expect(writer.write({ ...request, replacement: new Uint8Array(4) })).rejects.toSatisfy(
        (error: unknown) => expectAtomicError(error, AtomicWriteErrorCode.resourceLimit),
      );
      await expect(
        writer.write({ ...request, replacement: new Proxy(new Uint8Array(1), {}) }),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
      );
      await expect(
        writer.write({ ...request, replacement: new Uint8Array(new SharedArrayBuffer(1)) }),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
      );
      for (const options of [
        { maximumBytes: 0 },
        { maximumTemporaryAttempts: 0 },
        { maximumBytes: undefined },
        { unknown: true },
        new Proxy({}, {}),
        new (class Options {
          maximumBytes = 3;
        })(),
      ])
        await expect(
          createAtomicRepositoryWriterWithFileSystem(selection, options, nativeCapability),
        ).rejects.toSatisfy((error: unknown) =>
          expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
        );
      await expect(
        createAtomicRepositoryWriterWithFileSystem(
          { ...selection, identity: { ...selection.identity, inode: "-1" } },
          undefined,
          nativeCapability,
        ),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.invalidSelection),
      );

      for (const invalid of [
        { ...request, expected: { ...request.expected, identity: { device: "x", inode: "1" } } },
        { ...request, expected: { ...request.expected, identity: { device: "1", inode: "x" } } },
        { ...request, expected: { ...request.expected, sha256: "BAD" } },
        { ...request, path: 1 },
        { ...request, extra: true },
      ])
        await expect(writer.write(invalid)).rejects.toSatisfy((error: unknown) =>
          expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
        );
      const optionAccessor = Object.create(null, {
        maximumBytes: { enumerable: true, get: () => 10 },
      }) as unknown;
      await expect(
        createAtomicRepositoryWriterWithFileSystem(selection, optionAccessor, nativeCapability),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
      );
      await expect(
        createAtomicRepositoryWriterWithFileSystem(selection, { signal: {} }, nativeCapability),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
      );
      await expect(
        createAtomicRepositoryWriterWithFileSystem(
          selection,
          undefined,
          capability({
            lstat: async () => Promise.reject(codedError("EIO")),
          }),
        ),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.ioFailed),
      );
      await expect(
        createAtomicRepositoryWriterWithFileSystem(
          { ...selection, identity: { ...selection.identity, inode: "0" } },
          undefined,
          nativeCapability,
        ),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.invalidSelection),
      );
    });
  });

  test("rejects an oversized source, invalid temporary token, and zero-progress write", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "four");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const bounded = await writerWith(selection, nativeCapability, {}, { maximumBytes: 3 });
      await expect(bounded.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.resourceLimit),
      );

      const invalidToken = await writerWith(selection, capability({ randomToken: () => "bad" }));
      await expect(invalidToken.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.invalidInput),
      );

      const noProgress = await writerWith(
        selection,
        capability({
          open: async (targetPath, flags, mode) => {
            const handle = await open(targetPath, flags, mode);
            return targetPath.endsWith(".tmp")
              ? handleProxy(handle, {
                  write: (): Promise<{ readonly bytesWritten: number }> =>
                    Promise.resolve({ bytesWritten: 0 }),
                })
              : handle;
          },
        }),
      );
      await expect(noProgress.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.ioFailed),
      );
      expect(await readFile(target, "utf8")).toBe("four");
      expect(await writerArtifacts(root)).toEqual([]);
    });
  });

  test.each(["open-change", "truncate", "grow", "during-read", "path-replace"] as const)(
    "rejects target race detected at %s",
    async (race) => {
      await withTempWorkspace({}, async (workspace) => {
        const root = workspace.resolvePath("repo");
        const target = workspace.resolvePath("repo/file");
        await mkdir(root);
        await writeFile(target, "original");
        const selection = await selectionAt(root);
        const request = await requestAt(selection, "file", "writer");
        const canonicalTarget = path.join(selection.root, "file");
        let targetOpenCount = 0;
        const injected = capability({
          open: async (targetPath, flags, mode) => {
            const handle = await open(targetPath, flags, mode);
            if (targetPath !== canonicalTarget) return handle;
            targetOpenCount += 1;
            if (targetOpenCount !== 1) return handle;
            let statCount = 0;
            let readCount = 0;
            return handleProxy(handle, {
              close: async (): Promise<void> => {
                await handle.close();
                if (race === "path-replace") {
                  const other = workspace.resolvePath("repo/other");
                  await writeFile(other, "replacement-path");
                  await rename(other, target);
                }
              },
              read: async (
                buffer: Uint8Array,
                offset: number,
                length: number,
                position: number,
              ) => {
                readCount += 1;
                if (race === "truncate" && readCount === 1) return { bytesRead: 0 };
                if (race === "grow" && readCount === 2) await writeFile(target, "original-grown");
                return handle.read(buffer, offset, length, position);
              },
              stat: async (options: { readonly bigint: true }) => {
                statCount += 1;
                if (race === "open-change" && statCount === 1) await writeFile(target, "changed!");
                if (race === "during-read" && statCount === 2) await writeFile(target, "changed!");
                return handle.stat(options);
              },
            });
          },
        });
        const writer = await writerWith(selection, injected);
        await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
          expectAtomicError(error, AtomicWriteErrorCode.concurrentChange),
        );
        expect(await writerArtifacts(root)).toEqual([]);
      });
    },
  );

  test.each(["unsupported", "failure", "close-failure"] as const)(
    "handles directory handle sync %s explicitly",
    async (outcome) => {
      await withTempWorkspace({}, async (workspace) => {
        const root = workspace.resolvePath("repo");
        const target = workspace.resolvePath("repo/file");
        await mkdir(root);
        await writeFile(target, "old");
        const selection = await selectionAt(root);
        const request = await requestAt(selection, "file", "new");
        const injected = capability({
          open: async (targetPath, flags, mode) => {
            const handle = await open(targetPath, flags, mode);
            return targetPath === selection.root
              ? handleProxy(handle, {
                  close:
                    outcome === "close-failure"
                      ? async (): Promise<void> => {
                          await handle.close();
                          throw codedError("EIO");
                        }
                      : async (): Promise<void> => {
                          await handle.close();
                        },
                  sync: (): Promise<void> =>
                    outcome === "close-failure"
                      ? handle.sync()
                      : Promise.reject(codedError(outcome === "unsupported" ? "EINVAL" : "EIO")),
                })
              : handle;
          },
        });
        const pending = (await writerWith(selection, injected)).write(request);
        if (outcome === "unsupported") {
          await expect(pending).resolves.toMatchObject({ durability: "file-only" });
        } else {
          await expect(pending).rejects.toSatisfy((error: unknown) =>
            expectAtomicError(
              error,
              AtomicWriteErrorCode.durabilityFailed,
              true,
              outcome === "close-failure" ? "close-directory" : "sync-directory",
            ),
          );
        }
        expect(await readFile(target, "utf8")).toBe("new");
        expect(await writerArtifacts(root)).toEqual([]);
      });
    },
  );

  test("reports post-commit publication and lock-cleanup failures without claiming rollback", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const changedPublication = capability({
        rename: async (source, destination) => {
          await rename(source, destination);
          await writeFile(destination, "tampered-after-rename");
        },
      });
      await expect(
        (await writerWith(selection, changedPublication)).write(request),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.concurrentChange, true, "verify-published"),
      );
      expect(await writerArtifacts(root)).toEqual([]);

      const nextRequest = await requestAt(selection, "file", "final");
      const cleanupFailure = capability({
        unlink: async (targetPath) => {
          if (targetPath.endsWith(".lock")) throw codedError("EIO");
          await unlink(targetPath);
        },
      });
      await expect(
        (await writerWith(selection, cleanupFailure)).write(nextRequest),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.cleanupFailed, true, "release-lock"),
      );
      expect(await readFile(target, "utf8")).toBe("final");
      expect((await writerArtifacts(root)).some((name) => name.endsWith(".lock"))).toBe(true);
    });
  });

  test("detects lock pathname substitution and leaves the hostile replacement untouched", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      let replacementLock = "";
      const writer = await writerWith(selection, nativeCapability, {
        beforeRename: async () => {
          const lockName = (await writerArtifacts(root)).find((name) => name.endsWith(".lock"));
          if (lockName === undefined) throw new Error("test lock was not created");
          replacementLock = path.join(root, lockName);
          await unlink(replacementLock);
          await writeFile(replacementLock, "hostile replacement");
        },
      });
      await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.cleanupFailed),
      );
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await readFile(replacementLock, "utf8")).toBe("hostile replacement");
    });
  });

  test("attempts lock cleanup even when temporary-handle cleanup reports failure", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      const injected = capability({
        open: async (targetPath, flags, mode) => {
          const handle = await open(targetPath, flags, mode);
          return targetPath.endsWith(".tmp")
            ? handleProxy(handle, {
                close: async (): Promise<void> => {
                  await handle.close();
                  throw codedError("EIO");
                },
              })
            : handle;
        },
      });
      const writer = await writerWith(selection, injected, {
        afterTemporarySync: () => {
          throw new Error("injected crash");
        },
      });
      await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.cleanupFailed, false, "cleanup-temporary"),
      );
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await writerArtifacts(root)).toEqual([]);
    });
  });

  test("revalidates root, parent, and target realpath immediately before commit", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/nested/file");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "nested/file", "new");

      let rootLstats = 0;
      const rootChanged = capability({
        lstat: async (targetPath) => {
          if (targetPath === selection.root) {
            rootLstats += 1;
            if (rootLstats > 1)
              return lstat(path.join(selection.root, "nested/file"), { bigint: true });
          }
          return lstat(targetPath, { bigint: true });
        },
      });
      const rootWriter = await writerWith(selection, rootChanged);
      await expect(rootWriter.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.unsafePath),
      );

      const targetAbsolute = path.join(selection.root, "nested/file");
      const realpathMismatch = capability({
        realpath: async (targetPath) =>
          targetPath === targetAbsolute ? path.join(selection.root, "other") : realpath(targetPath),
      });
      await expect(
        (await writerWith(selection, realpathMismatch)).write(request),
      ).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.unsafePath),
      );

      const movedParent = workspace.resolvePath("repo/moved-parent");
      const parentWriter = await writerWith(selection, nativeCapability, {
        beforeCommitValidation: async () => {
          await rename(workspace.resolvePath("repo/nested"), movedParent);
          await mkdir(workspace.resolvePath("repo/nested"));
          await writeFile(target, "concurrent-parent");
        },
      });
      await expect(parentWriter.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.cleanupFailed),
      );
      expect(await readFile(target, "utf8")).toBe("concurrent-parent");
      expect(await writerArtifacts(movedParent)).toHaveLength(2);
    });
  });

  test.each([
    "lock-open",
    "unsafe-lock",
    "unsafe-lock-unlink",
    "temp-open",
    "temp-growth",
  ] as const)("fails closed and cleans safely for %s", async (failure) => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath("repo/file");
      await mkdir(root);
      await writeFile(target, "old");
      const selection = await selectionAt(root);
      const request = await requestAt(selection, "file", "new");
      let poisoned = false;
      const injected = capability({
        open: async (targetPath, flags, mode) => {
          if (failure === "lock-open" && targetPath.endsWith(".lock")) throw codedError("EIO");
          if (failure === "temp-open" && targetPath.endsWith(".tmp")) throw codedError("EIO");
          const handle = await open(targetPath, flags, mode);
          if (
            (failure === "unsafe-lock" || failure === "unsafe-lock-unlink") &&
            targetPath.endsWith(".lock")
          )
            return handleProxy(handle, {
              stat: async (options: { readonly bigint: true }) => {
                if (!poisoned) {
                  poisoned = true;
                  await link(targetPath, `${targetPath}.alias`);
                }
                return handle.stat(options);
              },
            });
          if (failure === "temp-growth" && targetPath.endsWith(".tmp"))
            return handleProxy(handle, {
              stat: async (options: { readonly bigint: true }) => {
                if (!poisoned) {
                  poisoned = true;
                  await writeFile(targetPath, "growth", { flag: "a" });
                }
                return handle.stat(options);
              },
            });
          return handle;
        },
        unlink: async (targetPath) => {
          if (failure === "unsafe-lock-unlink" && targetPath.endsWith(".lock"))
            throw codedError("EIO");
          await unlink(targetPath);
        },
      });
      await expect((await writerWith(selection, injected)).write(request)).rejects.toSatisfy(
        (error: unknown) =>
          expectAtomicError(
            error,
            failure === "unsafe-lock" ||
              failure === "unsafe-lock-unlink" ||
              failure === "temp-growth"
              ? failure === "unsafe-lock"
                ? AtomicWriteErrorCode.unsafeType
                : failure === "unsafe-lock-unlink"
                  ? AtomicWriteErrorCode.cleanupFailed
                  : AtomicWriteErrorCode.concurrentChange
              : AtomicWriteErrorCode.ioFailed,
          ),
      );
      expect(await readFile(target, "utf8")).toBe("old");
      const artifacts = await writerArtifacts(root);
      if (failure === "unsafe-lock") expect(artifacts).toHaveLength(1);
      else if (failure === "unsafe-lock-unlink") expect(artifacts).toHaveLength(2);
      else expect(artifacts).toEqual([]);
    });
  });

  test("fails without touching a missing target or a pre-existing writer lock", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const selection = await selectionAt(root);
      const writer = await createAtomicRepositoryWriter(selection);
      const absent = {
        expected: { identity: { device: "0", inode: "0" }, sha256: digest("") },
        path: canonicalizeRepositoryRelativePath("missing"),
        replacement: Buffer.from("new"),
      };
      await expect(writer.write(absent)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.ioFailed),
      );

      await writeFile(workspace.resolvePath("repo/file"), "old");
      const request = await requestAt(selection, "file", "new");
      const key = createHash("sha256").update("file").digest("hex").slice(0, 32);
      const lockPath = path.join(root, `.agent-context-lint-${key}.lock`);
      await writeFile(lockPath, "pre-existing");
      await expect(writer.write(request)).rejects.toSatisfy((error: unknown) =>
        expectAtomicError(error, AtomicWriteErrorCode.concurrentChange, false, "acquire-lock"),
      );
      expect(await readFile(lockPath, "utf8")).toBe("pre-existing");
      expect(await readFile(workspace.resolvePath("repo/file"), "utf8")).toBe("old");
    });
  });
});
