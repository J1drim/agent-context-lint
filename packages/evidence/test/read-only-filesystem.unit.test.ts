import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test } from "vitest";

import {
  createReadOnlyRepository,
  createReadOnlyRepositoryWithFileSystem,
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  READ_ONLY_REPOSITORY_HARD_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  selectRepositoryRoot,
} from "../src/index.js";
import type {
  ReadOnlyRepository,
  ReadOnlyRepositoryFileSystemCapability,
  ReadOnlyRepositoryOptions,
  RepositoryRootSelection,
} from "../src/index.js";

const nativeCapability: ReadOnlyRepositoryFileSystemCapability = Object.freeze({
  lstat: async (target: string): Promise<BigIntStats> => lstat(target, { bigint: true }),
  now: (): number => Date.now(),
  open: async (target: string, flags: number): Promise<FileHandle> => open(target, flags),
  openDirectory: async (target: string) => {
    const handle = await opendir(target, { encoding: "utf8" });
    return {
      close: async (): Promise<void> => handle.close(),
      read: async (): Promise<string | null> => (await handle.read())?.name ?? null,
    };
  },
  readlink: async (target: string): Promise<string> => readlink(target, { encoding: "utf8" }),
  realpath: async (target: string): Promise<string> => realpath(target),
});

function capability(
  overrides: Partial<ReadOnlyRepositoryFileSystemCapability> = {},
): ReadOnlyRepositoryFileSystemCapability {
  return { ...nativeCapability, ...overrides };
}

function bindFileHandleMember(handle: FileHandle, property: PropertyKey): unknown {
  const member = Reflect.get(handle, property, handle) as unknown;
  return typeof member === "function" ? member.bind(handle) : member;
}

function fileHandleProxy(
  handle: FileHandle,
  overrides: Readonly<Record<PropertyKey, unknown>>,
): FileHandle {
  return new Proxy(handle, {
    get(target, property): unknown {
      return Object.hasOwn(overrides, property)
        ? Reflect.get(overrides, property)
        : bindFileHandleMember(target, property);
    },
  });
}

function expectFacadeError(error: unknown, code: string, operation?: string): boolean {
  expect(error).toBeInstanceOf(ReadOnlyRepositoryError);
  expect(error).toMatchObject({ code, ...(operation === undefined ? {} : { operation }) });
  expect(Object.isFrozen(error)).toBe(true);
  return true;
}

async function selectExplicit(root: string): Promise<RepositoryRootSelection> {
  return selectRepositoryRoot(root, { mode: "explicit" });
}

async function facadeAt(
  root: string,
  options?: ReadOnlyRepositoryOptions,
): Promise<ReadOnlyRepository> {
  return createReadOnlyRepository(await selectExplicit(root), options);
}

describe("C02 read-only repository facade", () => {
  test("reads deterministic frozen entries and returns defensive byte copies", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/z"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/b.txt"), "beta");
      await writeFile(workspace.resolvePath("repo/a.txt"), "alpha");
      const facade = await facadeAt(workspace.resolvePath("repo"));

      const directory = await facade.readDirectory(".");
      const entry = await facade.inspect("a.txt");
      const file = await facade.readFile("a.txt");
      const first = file.bytes();
      first[0] = 0;

      expect(directory).toMatchObject({
        entries: ["a.txt", "b.txt", "z"],
        path: ".",
        size: 0,
        type: "directory",
      });
      expect(entry).toMatchObject({ path: "a.txt", size: 5, type: "file" });
      expect(Buffer.from(file.bytes()).toString("utf8")).toBe("alpha");
      expect(Object.isFrozen(facade)).toBe(true);
      expect(Object.isFrozen(facade.limits)).toBe(true);
      expect(Object.isFrozen(directory)).toBe(true);
      expect(Object.isFrozen(directory.entries)).toBe(true);
      expect(Object.isFrozen(file)).toBe(true);
      expect(facade.limits).toEqual(READ_ONLY_REPOSITORY_DEFAULT_LIMITS);
      expect(facade.usage()).toMatchObject({ entries: 6, totalBytes: 5 });
    });
  });

  test("accepts C01 canonicalization through an intermediate directory link", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("real/repo"), { recursive: true });
      await writeFile(workspace.resolvePath("real/repo/context.md"), "safe");
      await symlink(
        workspace.resolvePath("real"),
        workspace.resolvePath("alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const selection = await selectExplicit(workspace.resolvePath("alias/repo"));

      const facade = await createReadOnlyRepository(selection);

      expect(facade.root).toBe(await realpath(workspace.resolvePath("real/repo")));
      expect(Buffer.from((await facade.readFile("context.md")).bytes()).toString()).toBe("safe");
    });
  });

  test("follows stable in-root component and terminal links", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/real/nested"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/real/nested/file.md"), "linked");
      await symlink(
        "real",
        workspace.resolvePath("repo/alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await symlink("real/nested/file.md", workspace.resolvePath("repo/file-link.md"), "file");
      const facade = await facadeAt(workspace.resolvePath("repo"));

      const throughComponent = await facade.readFile("alias/nested/file.md");
      const terminal = await facade.readFile("file-link.md");

      expect(throughComponent.linkDepth).toBe(1);
      expect(terminal.linkDepth).toBe(1);
      expect(Buffer.from(terminal.bytes()).toString()).toBe("linked");
    });
  });

  test("rejects an external link before inspecting its target", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("outside.txt"), "secret");
      await symlink(workspace.resolvePath("outside.txt"), workspace.resolvePath("repo/link"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const inspected: string[] = [];
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          lstat: async (target) => {
            inspected.push(target);
            return nativeCapability.lstat(target);
          },
        }),
      );
      inspected.length = 0;

      await expect(facade.readFile("link")).rejects.toSatisfy((error: unknown) =>
        expectFacadeError(error, ReadOnlyRepositoryErrorCode.outsideRoot, "resolve-link"),
      );
      expect(inspected).not.toContain(workspace.resolvePath("outside.txt"));
    });
  });

  test("detects symbolic-link loops and enforces link depth", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await symlink("b", workspace.resolvePath("repo/a"));
      await symlink("a", workspace.resolvePath("repo/b"));
      const facade = await facadeAt(workspace.resolvePath("repo"));
      await expect(facade.inspect("a")).rejects.toSatisfy((error: unknown) =>
        expectFacadeError(error, ReadOnlyRepositoryErrorCode.symlinkLoop),
      );

      const bounded = await facadeAt(workspace.resolvePath("repo"), { maximumSymlinkDepth: 1 });
      await expect(bounded.inspect("a")).rejects.toSatisfy((error: unknown) =>
        expectFacadeError(error, ReadOnlyRepositoryErrorCode.limitExceeded, "resolve-link"),
      );
    });
  });

  test.each([
    "../outside",
    "/absolute",
    "a\\b",
    "a//b",
    "./a",
    "a/../b",
    "bad\nname",
    "bidi\u202Ename",
    String.fromCharCode(0xd800),
    String.fromCharCode(0xdc00),
  ])("rejects noncanonical or unsafe repository-relative input %#", async (input) => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const facade = await facadeAt(workspace.resolvePath("repo"));
      await expect(facade.inspect(input)).rejects.toSatisfy((error: unknown) =>
        expectFacadeError(error, ReadOnlyRepositoryErrorCode.invalidPath, "validate-path"),
      );
    });
  });

  test("rejects non-string and overlong paths without coercion", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const facade = await facadeAt(workspace.resolvePath("repo"));
      let coercions = 0;
      const hostile = {
        toString(): string {
          coercions += 1;
          return "safe";
        },
      };
      for (const input of [hostile, null, 1, "x".repeat(16_385)]) {
        await expect(facade.inspect(input)).rejects.toMatchObject({
          code: ReadOnlyRepositoryErrorCode.invalidPath,
        });
      }
      expect(coercions).toBe(0);
    });
  });

  test("reports unavailable paths with a sanitized platform code", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const facade = await facadeAt(workspace.resolvePath("repo"));
      await expect(facade.inspect("missing")).rejects.toSatisfy((error: unknown) => {
        expectFacadeError(error, ReadOnlyRepositoryErrorCode.pathUnavailable, "lstat");
        expect(error).toMatchObject({ causeCode: "ENOENT", path: "missing" });
        return true;
      });
    });
  });

  test("rejects file/directory mismatches, hard links, and oversized inspection", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/directory"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/file"), "12345");
      await link(workspace.resolvePath("repo/file"), workspace.resolvePath("repo/hard-link"));
      await writeFile(workspace.resolvePath("repo/large"), "12345");
      const facade = await facadeAt(workspace.resolvePath("repo"), { maximumFileBytes: 4 });

      await expect(facade.readFile("directory")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.notFile,
      });
      await expect(facade.readDirectory("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.notDirectory,
      });
      await expect(facade.inspect("hard-link")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.hardLink,
      });
      await expect(facade.inspect("large")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        operation: "file-size",
      });
    });
  });

  test("rejects special filesystem objects without opening them", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "x");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const original = await lstat(workspace.resolvePath("repo/file"), { bigint: true });
      const special = Object.create(original) as BigIntStats;
      Object.defineProperties(special, {
        isDirectory: { value: (): boolean => false },
        isFile: { value: (): boolean => false },
        isFIFO: { value: (): boolean => true },
      });
      let opens = 0;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          lstat: async (target) =>
            target === path.join(selection.root, "file") ? special : nativeCapability.lstat(target),
          open: async (target, flags) => {
            opens += 1;
            return nativeCapability.open(target, flags);
          },
        }),
      );

      await expect(facade.inspect("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.unsafeType,
      });
      await expect(facade.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.notFile,
      });
      expect(opens).toBe(0);
    });
  });

  test("accepts the exact file-size boundary and rejects one byte beyond it before open", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/exact"), "1234");
      await writeFile(workspace.resolvePath("repo/large"), "12345");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      let opens = 0;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        { maximumFileBytes: 4 },
        capability({
          open: async (target, flags) => {
            opens += 1;
            return nativeCapability.open(target, flags);
          },
        }),
      );
      expect(Buffer.from((await facade.readFile("exact")).bytes()).toString()).toBe("1234");
      await expect(facade.readFile("large")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        operation: "file-size",
      });
      expect(opens).toBe(1);
    });
  });

  test("enforces aggregate byte, entry, traversal, and metadata limits", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/a/b"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/a/b/file"), "1234");

      const bytes = await facadeAt(workspace.resolvePath("repo"), { maximumTotalBytes: 7 });
      await bytes.readFile("a/b/file");
      await expect(bytes.readFile("a/b/file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        operation: "byte-limit",
      });

      const entries = await facadeAt(workspace.resolvePath("repo"), { maximumEntries: 1 });
      await expect(entries.readDirectory(".")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        operation: "entry-limit",
      });

      const depth = await facadeAt(workspace.resolvePath("repo"), { maximumTraversalDepth: 2 });
      await expect(depth.inspect("a/b/file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        operation: "path-depth",
      });

      const metadata = await facadeAt(workspace.resolvePath("repo"), {
        maximumMetadataOperations: 4,
      });
      await expect(metadata.inspect("a")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        operation: "metadata-limit",
      });
    });
  });

  test("streams directory entries and stops materialization at the entry limit", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      let reads = 0;
      let closes = 0;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        { maximumEntries: 3 },
        capability({
          openDirectory: () =>
            Promise.resolve({
              close: (): Promise<void> => {
                closes += 1;
                return Promise.resolve();
              },
              read: (): Promise<string> => {
                reads += 1;
                return Promise.resolve(`entry-${String(reads)}`);
              },
            }),
        }),
      );

      await expect(facade.readDirectory(".")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        operation: "entry-limit",
      });
      expect(reads).toBe(3);
      expect(closes).toBe(1);
      expect(facade.usage().entries).toBe(3);
    });
  });

  test("bounds initial root validation and does not start work beyond its metadata budget", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      let realpaths = 0;
      let canonicalStats = 0;
      await expect(
        createReadOnlyRepositoryWithFileSystem(
          selection,
          { maximumMetadataOperations: 2 },
          capability({
            lstat: async (target) => {
              if (target === selection.root) canonicalStats += 1;
              return nativeCapability.lstat(target);
            },
            realpath: async (target) => {
              realpaths += 1;
              return nativeCapability.realpath(target);
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        operation: "metadata-limit",
      });
      expect(realpaths).toBe(1);
      expect(canonicalStats).toBe(1);

      await expect(
        createReadOnlyRepositoryWithFileSystem(
          selection,
          { maximumDurationMs: 5 },
          capability({ realpath: async () => new Promise<string>(() => undefined) }),
        ),
      ).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.deadlineExceeded,
        operation: "deadline",
      });

      const controller = new AbortController();
      await expect(
        createReadOnlyRepositoryWithFileSystem(
          selection,
          { signal: controller.signal },
          capability({
            lstat: async () =>
              new Promise<BigIntStats>(() => {
                setImmediate(() => {
                  controller.abort();
                });
              }),
          }),
        ),
      ).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.aborted,
        operation: "cancel",
      });
    });
  });

  test("validates all configurable limits against immutable hard caps", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      expect(Object.isFrozen(READ_ONLY_REPOSITORY_HARD_LIMITS)).toBe(true);
      for (const key of Object.keys(
        READ_ONLY_REPOSITORY_HARD_LIMITS,
      ) as (keyof typeof READ_ONLY_REPOSITORY_HARD_LIMITS)[]) {
        for (const value of [0, -1, 1.5, Number.NaN, READ_ONLY_REPOSITORY_HARD_LIMITS[key] + 1]) {
          await expect(createReadOnlyRepository(selection, { [key]: value })).rejects.toMatchObject(
            {
              code: ReadOnlyRepositoryErrorCode.invalidOptions,
            },
          );
        }
      }
    });
  });

  test("rejects hostile option and selection containers without invoking accessors", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      let reads = 0;
      const accessor = Object.defineProperty({}, "maximumEntries", {
        enumerable: true,
        get() {
          reads += 1;
          return 1;
        },
      });
      for (const options of [
        null,
        [],
        new Proxy({}, {}),
        { unknown: 1 },
        accessor,
        { signal: undefined },
      ]) {
        await expect(
          createReadOnlyRepository(selection, options as ReadOnlyRepositoryOptions),
        ).rejects.toMatchObject({ code: ReadOnlyRepositoryErrorCode.invalidOptions });
      }
      expect(reads).toBe(0);

      const malformed = { ...selection, identity: { ...selection.identity, device: "01" } };
      await expect(
        createReadOnlyRepository(malformed as RepositoryRootSelection),
      ).rejects.toMatchObject({ code: ReadOnlyRepositoryErrorCode.invalidSelection });
      await expect(createReadOnlyRepository(new Proxy(selection, {}))).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.invalidSelection,
      });
    });
  });

  test("honors initial, in-flight, and deadline cancellation checkpoints", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "x");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const initiallyAborted = new AbortController();
      initiallyAborted.abort();
      await expect(
        createReadOnlyRepository(selection, { signal: initiallyAborted.signal }),
      ).rejects.toMatchObject({ code: ReadOnlyRepositoryErrorCode.aborted });

      const abortAfterCreation = new AbortController();
      const cancelled = await createReadOnlyRepository(selection, {
        signal: abortAfterCreation.signal,
      });
      abortAfterCreation.abort();
      await expect(cancelled.inspect("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.aborted,
        operation: "cancel",
      });

      const controller = new AbortController();
      let ready = false;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        { signal: controller.signal },
        capability({
          lstat: async (target) => {
            const stats = await nativeCapability.lstat(target);
            if (ready && target.endsWith(`${path.sep}file`)) controller.abort();
            return stats;
          },
        }),
      );
      ready = true;
      await expect(facade.inspect("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.aborted,
      });

      let readyForDeadline = false;
      const deadline = await createReadOnlyRepositoryWithFileSystem(
        selection,
        { maximumDurationMs: 5 },
        capability({
          lstat: async (target) => {
            if (readyForDeadline && target.endsWith(`${path.sep}file`)) {
              return new Promise<BigIntStats>(() => undefined);
            }
            return nativeCapability.lstat(target);
          },
        }),
      );
      readyForDeadline = true;
      await expect(deadline.inspect("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.deadlineExceeded,
      });
    });
  });

  test("handles fragmented reads and requires explicit EOF at the advertised size", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "fragmented");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            return fileHandleProxy(handle, {
              read: async (buffer: Buffer, offset: number, length: number, position: number) =>
                handle.read(buffer, offset, Math.min(1, length), position),
            });
          },
        }),
      );

      expect(Buffer.from((await facade.readFile("file")).bytes()).toString()).toBe("fragmented");
    });
  });

  test.each([
    ["early EOF", 0],
    ["invalid fragment", -1],
  ] as const)("rejects %s from an injected file handle", async (_label, fragment) => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "data");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            return fileHandleProxy(handle, {
              read: () => Promise.resolve({ buffer: Buffer.alloc(0), bytesRead: fragment }),
            });
          },
        }),
      );
      await expect(facade.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
      });
    });
  });

  test("detects file growth and identity changes observed through the opened handle", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "data");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const growing = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            return fileHandleProxy(handle, {
              read: (buffer: Buffer, offset: number) => {
                buffer[offset] = 1;
                return Promise.resolve({ buffer, bytesRead: 1 });
              },
            });
          },
        }),
      );
      await expect(growing.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
      });

      const changed = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            const actual = await handle.stat({ bigint: true });
            const replacement = Object.create(actual) as BigIntStats;
            Object.defineProperty(replacement, "ino", { value: actual.ino + 1n });
            return fileHandleProxy(handle, { stat: () => Promise.resolve(replacement) });
          },
        }),
      );
      await expect(changed.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
      });

      const changedAfterRead = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            const actual = await handle.stat({ bigint: true });
            const replacement = Object.create(actual) as BigIntStats;
            Object.defineProperty(replacement, "mtimeNs", { value: actual.mtimeNs + 1n });
            let stats = 0;
            return fileHandleProxy(handle, {
              stat: () => {
                stats += 1;
                return Promise.resolve(stats === 1 ? actual : replacement);
              },
            });
          },
        }),
      );
      await expect(changedAfterRead.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
        operation: "read-file",
      });
    });
  });

  test("detects persistent path and root replacement races", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/directory"), { recursive: true });
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const original = await lstat(workspace.resolvePath("repo/directory"), { bigint: true });
      const replacement = Object.create(original) as BigIntStats;
      Object.defineProperty(replacement, "ino", { value: original.ino + 1n });
      let directoryReads = 0;
      const changedPath = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          lstat: async (target) => {
            if (target === path.join(selection.root, "directory")) {
              directoryReads += 1;
              return directoryReads > 1 ? replacement : original;
            }
            return nativeCapability.lstat(target);
          },
        }),
      );
      await expect(changedPath.readDirectory("directory")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
      });

      const rootStats = await lstat(selection.root, { bigint: true });
      const changedRootStats = Object.create(rootStats) as BigIntStats;
      Object.defineProperty(changedRootStats, "ino", { value: rootStats.ino + 1n });
      let initialized = false;
      const changedRoot = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          lstat: async (target) =>
            initialized && target === selection.root
              ? changedRootStats
              : nativeCapability.lstat(target),
        }),
      );
      initialized = true;
      await expect(changedRoot.inspect(".")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
        operation: "recheck-root",
      });
    });
  });

  test("detects replacement of a symbolic link while its target is read", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "safe");
      await symlink("file", workspace.resolvePath("repo/link"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const original = await lstat(path.join(selection.root, "link"), { bigint: true });
      const changed = Object.create(original) as BigIntStats;
      Object.defineProperty(changed, "ino", { value: original.ino + 1n });
      let linkStats = 0;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          lstat: async (target) => {
            if (target === path.join(selection.root, "link")) {
              linkStats += 1;
              return linkStats === 1 ? original : changed;
            }
            return nativeCapability.lstat(target);
          },
        }),
      );

      await expect(facade.inspect("link")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
        operation: "resolve-link",
      });
    });
  });

  test("preserves primary read failures over cleanup failures and reports standalone close failure", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "data");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const closeError = Object.assign(new Error("close"), { code: "EIO" });
      const standalone = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            return fileHandleProxy(handle, {
              close: async () => {
                await handle.close();
                throw closeError;
              },
            });
          },
        }),
      );
      await expect(standalone.readFile("file")).rejects.toMatchObject({
        causeCode: "EIO",
        code: ReadOnlyRepositoryErrorCode.closeFailed,
      });

      const primary = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            return fileHandleProxy(handle, {
              close: async () => {
                await handle.close();
                throw closeError;
              },
              read: () => Promise.resolve({ buffer: Buffer.alloc(0), bytesRead: -1 }),
            });
          },
        }),
      );
      await expect(primary.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
      });
    });
  });

  test("closes a handle when cancellation arrives during open", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "data");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const controller = new AbortController();
      let closes = 0;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        { signal: controller.signal },
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            controller.abort();
            return fileHandleProxy(handle, {
              close: async () => {
                closes += 1;
                await handle.close();
              },
            });
          },
        }),
      );
      await expect(facade.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.aborted,
      });
      expect(closes).toBe(1);
    });
  });

  test("classifies cancellation during successful close as cancellation", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "data");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const controller = new AbortController();
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        { signal: controller.signal },
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            return fileHandleProxy(handle, {
              close: async () => {
                await handle.close();
                controller.abort();
              },
            });
          },
        }),
      );

      await expect(facade.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.aborted,
        operation: "cancel",
      });
    });
  });

  test("rejects concurrent operations so budget accounting remains deterministic", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "data");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let block = false;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          lstat: async (target) => {
            if (block && target.endsWith(`${path.sep}file`)) await gate;
            return nativeCapability.lstat(target);
          },
        }),
      );
      block = true;
      const first = facade.inspect("file");
      await Promise.resolve();
      await expect(facade.inspect("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.concurrentOperation,
      });
      release?.();
      await expect(first).resolves.toMatchObject({ path: "file" });
    });
  });

  test("rejects invalid trusted results and never reflects hostile cause accessors", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          openDirectory: () => {
            const names: (string | null)[] = ["safe", "../outside", null];
            return Promise.resolve({
              close: (): Promise<void> => Promise.resolve(),
              read: (): Promise<string | null> => Promise.resolve(names.shift() ?? null),
            });
          },
        }),
      );
      await expect(facade.readDirectory(".")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.invalidPath,
        operation: "validate-directory-entry",
      });

      let reads = 0;
      const hostile = Object.defineProperty(new Error("hostile"), "code", {
        get() {
          reads += 1;
          return "SECRET";
        },
      });
      const failureFacade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          lstat: async (target) => {
            if (target === selection.root) return nativeCapability.lstat(target);
            throw hostile;
          },
        }),
      );
      await expect(failureFacade.inspect("missing")).rejects.toMatchObject({
        causeCode: undefined,
        code: ReadOnlyRepositoryErrorCode.pathUnavailable,
      });
      expect(reads).toBe(0);

      const proxiedFailure = new Proxy(new Error("proxied"), {});
      const proxyFacade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          lstat: async (target) => {
            if (target === selection.root) return nativeCapability.lstat(target);
            throw proxiedFailure;
          },
        }),
      );
      await expect(proxyFacade.inspect("missing")).rejects.toMatchObject({
        causeCode: undefined,
        code: ReadOnlyRepositoryErrorCode.pathUnavailable,
      });
    });
  });

  test("maps directory capability failures and always closes streamed handles", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const platformFailure = Object.assign(new Error("io"), { code: "EIO" });

      const openFailure = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({ openDirectory: async () => Promise.reject(platformFailure) }),
      );
      await expect(openFailure.readDirectory(".")).rejects.toMatchObject({
        causeCode: "EIO",
        code: ReadOnlyRepositoryErrorCode.readFailed,
        operation: "open-directory",
      });

      const readFailure = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          openDirectory: () =>
            Promise.resolve({
              close: (): Promise<void> => Promise.resolve(),
              read: (): Promise<string | null> => Promise.reject(platformFailure),
            }),
        }),
      );
      await expect(readFailure.readDirectory(".")).rejects.toMatchObject({
        causeCode: "EIO",
        code: ReadOnlyRepositoryErrorCode.readFailed,
        operation: "read-directory-entry",
      });

      const invalidEntry = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          openDirectory: () =>
            Promise.resolve({
              close: (): Promise<void> => Promise.resolve(),
              read: (): Promise<string | null> => Promise.resolve(1 as unknown as string),
            }),
        }),
      );
      await expect(invalidEntry.readDirectory(".")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.readFailed,
        operation: "read-directory-entry",
      });

      const closeFailure = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          openDirectory: () =>
            Promise.resolve({
              close: (): Promise<void> => Promise.reject(platformFailure),
              read: (): Promise<null> => Promise.resolve(null),
            }),
        }),
      );
      await expect(closeFailure.readDirectory(".")).rejects.toMatchObject({
        causeCode: "EIO",
        code: ReadOnlyRepositoryErrorCode.closeFailed,
        operation: "close-directory",
      });
    });
  });

  test("maps link and file-handle failures to stable typed errors", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "data");
      await symlink("file", workspace.resolvePath("repo/link"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      const platformFailure = Object.assign(new Error("io"), { code: "EIO" });

      const linkFailure = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({ readlink: async () => Promise.reject(platformFailure) }),
      );
      await expect(linkFailure.inspect("link")).rejects.toMatchObject({
        causeCode: "EIO",
        code: ReadOnlyRepositoryErrorCode.pathUnavailable,
        operation: "readlink",
      });

      const openFailure = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({ open: async () => Promise.reject(platformFailure) }),
      );
      await expect(openFailure.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.readFailed,
        operation: "open-file",
      });

      const statFailure = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            return fileHandleProxy(handle, {
              stat: async () => Promise.reject(platformFailure),
            });
          },
        }),
      );
      await expect(statFailure.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.readFailed,
        operation: "stat-file",
      });

      const readFailure = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            const handle = await nativeCapability.open(target, flags);
            return fileHandleProxy(handle, {
              read: async () => Promise.reject(platformFailure),
            });
          },
        }),
      );
      await expect(readFailure.readFile("file")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.readFailed,
        operation: "read-file",
      });
    });
  });

  test("rejects unsafe link targets, expanded depth, and non-directory path components", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/a/b/c"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/file"), "data");
      await symlink("file", workspace.resolvePath("repo/link"));
      await symlink("a/b/c", workspace.resolvePath("repo/deep"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));

      const unsafeLink = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          readlink: async (target) =>
            target.endsWith(`${path.sep}link`) ? "bad\nlink" : nativeCapability.readlink(target),
        }),
      );
      await expect(unsafeLink.inspect("link")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.invalidPath,
        operation: "resolve-link",
      });

      const malformedAbsolute = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          readlink: async (target) =>
            target.endsWith(`${path.sep}link`)
              ? `${selection.root}${path.sep}..${path.sep}outside`
              : nativeCapability.readlink(target),
        }),
      );
      await expect(malformedAbsolute.inspect("link")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.outsideRoot,
        operation: "resolve-link",
      });

      if (process.platform !== "win32") {
        const backslashTarget = await createReadOnlyRepositoryWithFileSystem(
          selection,
          undefined,
          capability({
            readlink: async (target) =>
              target.endsWith(`${path.sep}link`) ? "a\\b" : nativeCapability.readlink(target),
          }),
        );
        await expect(backslashTarget.inspect("link")).rejects.toMatchObject({
          code: ReadOnlyRepositoryErrorCode.invalidPath,
          operation: "resolve-link",
        });
      }

      const expanded = await createReadOnlyRepository(selection, { maximumTraversalDepth: 2 });
      await expect(expanded.inspect("deep")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        operation: "resolve-path",
      });

      const facade = await createReadOnlyRepository(selection);
      await expect(facade.inspect("file/child")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.notDirectory,
        operation: "resolve-path",
      });
    });
  });

  test("rejects invalid selections, root identity changes, and initialization failures", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      for (const malformed of [
        { ...selection, root: `${selection.root}${path.sep}.` },
        { ...selection, root: `${selection.root}${path.sep}` },
        { ...selection, root: "relative" },
      ]) {
        await expect(
          createReadOnlyRepository(malformed as RepositoryRootSelection),
        ).rejects.toMatchObject({ code: ReadOnlyRepositoryErrorCode.invalidSelection });
      }

      const wrongIdentity = {
        ...selection,
        identity: { ...selection.identity, inode: String(BigInt(selection.identity.inode) + 1n) },
      };
      await expect(
        createReadOnlyRepository(wrongIdentity as RepositoryRootSelection),
      ).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.invalidSelection,
        operation: "validate-root",
      });

      await expect(
        createReadOnlyRepositoryWithFileSystem(
          selection,
          undefined,
          capability({ lstat: async () => Promise.reject(new Error("failure")) }),
        ),
      ).rejects.toMatchObject({
        causeCode: undefined,
        code: ReadOnlyRepositoryErrorCode.invalidSelection,
        operation: "validate-root",
      });
    });
  });

  test("rejects invalid clocks both during initialization and facade use", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      for (const now of [
        (): number => Number.NaN,
        (): number => {
          throw new Error("clock");
        },
      ]) {
        await expect(
          createReadOnlyRepositoryWithFileSystem(selection, undefined, capability({ now })),
        ).rejects.toMatchObject({
          code: ReadOnlyRepositoryErrorCode.invalidOptions,
          operation: "clock",
        });
      }

      let ready = false;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          now: () => {
            if (ready) throw new Error("clock");
            return Date.now();
          },
        }),
      );
      ready = true;
      await expect(facade.inspect(".")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.invalidOptions,
        operation: "clock",
      });

      let invalid = false;
      const nonFinite = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({ now: () => (invalid ? Number.POSITIVE_INFINITY : Date.now()) }),
      );
      invalid = true;
      await expect(nonFinite.inspect(".")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.invalidOptions,
        operation: "clock",
      });

      // Keep the real timer comfortably above filesystem scheduling jitter. The injected clock,
      // rather than host load, is the behavior under test in these two cases.
      const injectedDeadlineMs = 1_000;
      let expired = false;
      const elapsed = await createReadOnlyRepositoryWithFileSystem(
        selection,
        { maximumDurationMs: injectedDeadlineMs },
        capability({ now: () => (expired ? injectedDeadlineMs + 1 : 0) }),
      );
      expired = true;
      await expect(elapsed.inspect(".")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.deadlineExceeded,
        operation: "deadline",
      });

      let ticks = 0;
      await expect(
        createReadOnlyRepositoryWithFileSystem(
          selection,
          { maximumDurationMs: injectedDeadlineMs },
          capability({
            now: () => {
              ticks += 1;
              return ticks > 1 ? injectedDeadlineMs + 1 : 0;
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.deadlineExceeded,
        operation: "deadline",
      });
    });
  });

  test("uses a monotonic production clock and never regains time after an injected rollback", async () => {
    const implementation = await readFile(
      new URL("../src/read-only-filesystem.ts", import.meta.url),
      "utf8",
    );
    expect(implementation).toContain("performance.now()");
    expect(implementation).not.toContain("Date.now()");

    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      let time = 0;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        { maximumDurationMs: 10 },
        capability({ now: () => time }),
      );

      time = 9;
      expect(facade.usage().elapsedMs).toBe(9);
      time = 1;
      expect(facade.usage().elapsedMs).toBe(9);
      time = 11;
      await expect(facade.inspect(".")).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.deadlineExceeded,
        operation: "deadline",
      });
    });
  });

  test("uses read-only no-follow open flags and exposes no command-execution capability", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/file"), "data");
      const selection = await selectExplicit(workspace.resolvePath("repo"));
      let observedFlags = 0;
      const facade = await createReadOnlyRepositoryWithFileSystem(
        selection,
        undefined,
        capability({
          open: async (target, flags) => {
            observedFlags = flags;
            return nativeCapability.open(target, flags);
          },
        }),
      );
      await facade.readFile("file");
      expect(observedFlags & (constants.O_WRONLY | constants.O_RDWR)).toBe(constants.O_RDONLY);
      if (process.platform !== "win32") {
        expect(observedFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      }
      expect(Object.keys(nativeCapability)).toEqual([
        "lstat",
        "now",
        "open",
        "openDirectory",
        "readlink",
        "realpath",
      ]);
    });
  });
});
