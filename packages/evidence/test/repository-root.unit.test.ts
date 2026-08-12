import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test } from "vitest";

import {
  REPOSITORY_ROOT_SELECTION_LIMITS,
  RepositoryRootSelectionError,
  RepositoryRootSelectionErrorCode,
  isIssuedRepositoryRootSelection,
  normalizeRepositorySelectionPath,
  selectRepositoryRoot,
  selectRepositoryRootWithFileSystem,
} from "../src/index.js";
import type { RepositoryRootFileSystem } from "../src/index.js";

function expectSelectionError(error: unknown, code: string): boolean {
  expect(error).toBeInstanceOf(RepositoryRootSelectionError);
  expect(error).toMatchObject({ code });
  return true;
}

async function addGitDirectory(root: string): Promise<void> {
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function absoluteAsciiPathWithBytes(byteLength: number): string {
  const root = path.parse(process.cwd()).root;
  const rootBytes = Buffer.byteLength(root, "utf8");
  if (byteLength <= rootBytes) throw new Error("test path length must exceed its host root");
  return `${root}${"x".repeat(byteLength - rootBytes)}`;
}

function boundFileHandleMember(handle: FileHandle, property: PropertyKey): unknown {
  const member = Reflect.get(handle, property, handle) as unknown;
  return typeof member === "function" ? member.bind(handle) : member;
}

describe("C01 host path validation", () => {
  test.each([
    ["posix", "/repo/child///", "/repo/child"],
    ["posix", "/repo/\ud83d\ude80", "/repo/\ud83d\ude80"],
    ["posix", "//repo///child", "/repo/child"],
    ["win32", "C:\\repo\\child\\", "C:\\repo\\child"],
    ["win32", "C:/repo/child//", "C:\\repo\\child"],
    ["win32", "\\\\server\\share\\repo\\", "\\\\server\\share\\repo"],
  ] as const)("normalizes a fully qualified %s path", (flavor, input, expected) => {
    expect(normalizeRepositorySelectionPath(input, flavor)).toBe(expected);
  });

  test.each([
    ["posix", "relative/repo"],
    ["posix", "/repo/../outside"],
    ["posix", "/repo/./child"],
    ["posix", "/repo\\child"],
    ["win32", "C:repo"],
    ["win32", "\\repo"],
    ["win32", "\\\\?\\C:\\repo"],
    ["win32", "\\\\.\\pipe\\repo"],
    ["win32", "/repo"],
  ] as const)("rejects unsupported %s path shape %#", (flavor, input) => {
    expect(() => normalizeRepositorySelectionPath(input, flavor)).toThrow(
      expect.objectContaining({ code: RepositoryRootSelectionErrorCode.invalidPath }),
    );
  });

  test.each([
    `/repo/${String.fromCharCode(0xd800)}`,
    `/repo/${String.fromCharCode(0xdc00)}`,
    "/repo/new\nline",
    "/repo/bidi\u202Ename",
    "/repo/nul\0name",
  ])("rejects malformed Unicode and control input without retaining it %#", (input) => {
    try {
      normalizeRepositorySelectionPath(input, "posix");
      throw new Error("expected invalid path");
    } catch (error: unknown) {
      expectSelectionError(error, RepositoryRootSelectionErrorCode.invalidPath);
      expect(error).toMatchObject({ path: undefined });
    }
  });

  test("rejects every C0, DEL, bidi override, and isolate control", () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, index) => index),
      0x7f,
      ...Array.from({ length: 5 }, (_, index) => 0x202a + index),
      ...Array.from({ length: 4 }, (_, index) => 0x2066 + index),
    ];
    for (const control of controls) {
      expect(() =>
        normalizeRepositorySelectionPath(`/repo/a${String.fromCodePoint(control)}b`, "posix"),
      ).toThrow(expect.objectContaining({ code: RepositoryRootSelectionErrorCode.invalidPath }));
    }
  });

  test("rejects malformed runtime path flavors without coercion", () => {
    let coercions = 0;
    const hostileFlavor = {
      [Symbol.toPrimitive](): string {
        coercions += 1;
        return "posix";
      },
    };
    for (const flavor of ["bogus", null, hostileFlavor, "POSIX"]) {
      expect(() => normalizeRepositorySelectionPath("/repo", flavor)).toThrow(
        expect.objectContaining({
          code: RepositoryRootSelectionErrorCode.invalidOptions,
          operation: "validate-path-flavor",
        }),
      );
    }
    expect(coercions).toBe(0);
  });
});

describe("C01 repository-root selection", () => {
  test("uses bounded defaults and stops a non-Git search at the filesystem root", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("project"));

      const result = await selectRepositoryRoot(workspace.resolvePath("project"));
      expect(isIssuedRepositoryRootSelection(result)).toBe(true);
      expect(isIssuedRepositoryRootSelection(structuredClone(result))).toBe(false);

      expect(result).toMatchObject({
        gitDirectory: null,
        reason: "non-git-directory",
        searchBoundary: "filesystem-root",
      });
    });
  });

  test("stops before crossing an observed filesystem-device boundary", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("project/child"), { recursive: true });
      const canonicalParent = await realpath(workspace.resolvePath("project"));
      const crossDeviceFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => {
          const stats = await lstat(target, { bigint: true });
          if (target !== canonicalParent) return stats;
          const observed = Object.create(stats) as BigIntStats;
          Object.defineProperty(observed, "dev", { value: stats.dev + 1n });
          return observed;
        },
        open,
        realpath,
      };

      const result = await selectRepositoryRootWithFileSystem(
        workspace.resolvePath("project/child"),
        undefined,
        crossDeviceFileSystem,
      );
      expect(result).toMatchObject({
        inspectedAncestors: 0,
        reason: "non-git-directory",
        searchBoundary: "filesystem-device",
      });
      expect(result.root).toBe(await realpath(workspace.resolvePath("project/child")));
    });
  });

  test("returns a deeply frozen non-Git fallback bounded by the supplied ceiling", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("project/src"), { recursive: true });
      const result = await selectRepositoryRoot(workspace.resolvePath("project/src"), {
        ceiling: workspace.resolvePath("project"),
      });
      expect(result).toMatchObject({
        gitDirectory: null,
        inspectedAncestors: 1,
        reason: "non-git-directory",
        searchBoundary: "ceiling",
      });
      expect(result.root).toBe(await realpath(workspace.resolvePath("project/src")));
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.identity)).toBe(true);
    });
  });

  test("selects the nearest nested Git repository and ignores a farther outer marker", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await addGitDirectory(workspace.resolvePath("outer"));
      await addGitDirectory(workspace.resolvePath("outer/packages/nested"));
      await mkdir(workspace.resolvePath("outer/packages/nested/src"), { recursive: true });

      const result = await selectRepositoryRoot(
        workspace.resolvePath("outer/packages/nested/src"),
        {
          ceiling: workspace.resolvePath("outer"),
        },
      );
      expect(result.reason).toBe("git-directory");
      expect(result.root).toBe(await realpath(workspace.resolvePath("outer/packages/nested")));
      expect(result.inspectedAncestors).toBe(1);
      expect(result.gitDirectory).toBe(path.join(result.root, ".git"));
    });
  });

  test("gives an explicit directory authority over ancestor Git discovery", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await addGitDirectory(workspace.resolvePath("outer"));
      await mkdir(workspace.resolvePath("outer/subdirectory"), { recursive: true });
      const result = await selectRepositoryRoot(workspace.resolvePath("outer/subdirectory"), {
        mode: "explicit",
      });
      expect(result).toMatchObject({
        gitDirectory: null,
        inspectedAncestors: 0,
        reason: "explicit-path",
        searchBoundary: null,
      });
      expect(result.root).toBe(await realpath(workspace.resolvePath("outer/subdirectory")));
    });
  });

  test("rejects terminal links but canonicalizes a stable intermediate link", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await addGitDirectory(workspace.resolvePath("real/repository"));
      await mkdir(workspace.resolvePath("real/repository/src"), { recursive: true });
      await symlink(
        workspace.resolvePath("real"),
        workspace.resolvePath("alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await symlink(
        workspace.resolvePath("real/repository"),
        workspace.resolvePath("leaf-link"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const throughIntermediate = await selectRepositoryRoot(
        workspace.resolvePath("alias/repository/src"),
        {
          ceiling: workspace.resolvePath("alias/repository"),
        },
      );
      expect(throughIntermediate.reason).toBe("git-directory");
      expect(throughIntermediate.root).toBe(
        await realpath(workspace.resolvePath("real/repository")),
      );
      expect(throughIntermediate.lexicalRoot).toBe(workspace.resolvePath("alias/repository"));

      await expect(
        selectRepositoryRoot(`${workspace.resolvePath("leaf-link")}${path.sep}`, {
          mode: "explicit",
        }),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.pathSymlink),
      );
    });
  });

  test("rejects a real canonical path containing a forbidden control character", async () => {
    await withTempWorkspace({}, async (workspace) => {
      if (process.platform === "win32") {
        await mkdir(workspace.resolvePath("project"));
        const project = workspace.resolvePath("project");
        const invalidCanonicalFileSystem: RepositoryRootFileSystem = {
          lstat: async (target) => lstat(target, { bigint: true }),
          open,
          realpath: () => Promise.resolve(`${path.parse(project).root}forbidden\ncanonical`),
        };
        await expect(
          selectRepositoryRootWithFileSystem(
            project,
            { mode: "explicit" },
            invalidCanonicalFileSystem,
          ),
        ).rejects.toSatisfy((error: unknown) =>
          expectSelectionError(error, RepositoryRootSelectionErrorCode.invalidPath),
        );
        return;
      }

      await mkdir(workspace.resolvePath("forbidden\nparent/repository"), { recursive: true });
      await symlink(
        workspace.resolvePath("forbidden\nparent"),
        workspace.resolvePath("alias"),
        "dir",
      );
      await expect(
        selectRepositoryRoot(workspace.resolvePath("alias/repository"), { mode: "explicit" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectSelectionError(error, RepositoryRootSelectionErrorCode.invalidPath);
        expect(error).toMatchObject({ path: undefined });
        return true;
      });
    });
  });

  test("fails closed on a malformed nearest marker instead of searching an outer repository", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await addGitDirectory(workspace.resolvePath("outer"));
      await mkdir(workspace.resolvePath("outer/nested/src"), { recursive: true });
      await writeFile(workspace.resolvePath("outer/nested/.git"), "not a gitfile\n");
      await expect(
        selectRepositoryRoot(workspace.resolvePath("outer/nested/src"), {
          ceiling: workspace.resolvePath("outer"),
        }),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerInvalid),
      );
    });
  });

  test("accepts a bounded relative gitfile target with a regular HEAD marker", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("metadata"));
      await writeFile(workspace.resolvePath("metadata/HEAD"), "ref: refs/heads/main\n");
      await mkdir(workspace.resolvePath("project"));
      await writeFile(workspace.resolvePath("project/.git"), "gitdir: ../metadata\r\n");

      const result = await selectRepositoryRoot(workspace.resolvePath("project"), {
        ceiling: workspace.resolvePath("project"),
      });
      expect(result.reason).toBe("git-worktree-file");
      expect(result.gitDirectory).toBe(await realpath(workspace.resolvePath("metadata")));
    });
  });

  test("accepts a stable gitfile delivered in multiple short read fragments", async () => {
    await withTempWorkspace(
      {
        "metadata/HEAD": "ref: refs/heads/main\n",
        "project/.git": "gitdir: ../metadata\n",
      },
      async (workspace) => {
        const project = await realpath(workspace.resolvePath("project"));
        const marker = path.join(project, ".git");
        const fragmentedFileSystem: RepositoryRootFileSystem = {
          lstat: async (target) => lstat(target, { bigint: true }),
          open: async (target, flags) => {
            const handle = await open(target, flags);
            if (target !== marker) return handle;
            return new Proxy(handle, {
              get(fileHandle, property): unknown {
                if (property === "read") {
                  return (
                    buffer: Uint8Array,
                    offset: number,
                    length: number,
                    position: number,
                  ): Promise<{ readonly buffer: Uint8Array; readonly bytesRead: number }> =>
                    fileHandle.read(buffer, offset, Math.min(length, 3), position);
                }
                return boundFileHandleMember(fileHandle, property);
              },
            });
          },
          realpath,
        };

        const result = await selectRepositoryRootWithFileSystem(
          project,
          { ceiling: project },
          fragmentedFileSystem,
        );
        expect(result.reason).toBe("git-worktree-file");
        expect(result.gitDirectory).toBe(await realpath(workspace.resolvePath("metadata")));
      },
    );
  });

  test.each([
    ["empty", new Uint8Array()],
    ["empty target", "gitdir: \n"],
    ["invalid UTF-8", Uint8Array.from([0x67, 0x69, 0x74, 0x64, 0x69, 0x72, 0x3a, 0x20, 0xff])],
    ["multiple lines", "gitdir: metadata\nsecond line\n"],
    ["unsupported target grammar", "gitdir: /tmp\\metadata\n"],
    ["missing target", "gitdir: missing-metadata\n"],
    ["oversized", `gitdir: ${"x".repeat(REPOSITORY_ROOT_SELECTION_LIMITS.maximumGitfileBytes)}\n`],
  ] as const)("rejects a %s gitfile", async (_label, contents) => {
    await withTempWorkspace({ "project/.git": contents }, async (workspace) => {
      await expect(
        selectRepositoryRoot(workspace.resolvePath("project"), {
          ceiling: workspace.resolvePath("project"),
        }),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerInvalid),
      );
    });
  });

  test("rejects a short gitfile read that hides malformed trailing content", async () => {
    const acceptedPrefix = Buffer.from("gitdir: ../metadata\n", "utf8");
    await withTempWorkspace(
      {
        "metadata/HEAD": "ref: refs/heads/main\n",
        "project/.git": Buffer.concat([acceptedPrefix, Buffer.from("trailing-content\n")]),
      },
      async (workspace) => {
        const project = await realpath(workspace.resolvePath("project"));
        const marker = path.join(project, ".git");
        const shortReadFileSystem: RepositoryRootFileSystem = {
          lstat: async (target) => lstat(target, { bigint: true }),
          open: async (target, flags) => {
            const handle = await open(target, flags);
            if (target !== marker) return handle;
            let readCalls = 0;
            return new Proxy(handle, {
              get(fileHandle, property): unknown {
                if (property === "read") {
                  return (
                    buffer: Uint8Array,
                    offset: number,
                  ): Promise<{ readonly buffer: Uint8Array; readonly bytesRead: number }> => {
                    readCalls += 1;
                    if (readCalls === 1) {
                      buffer.set(acceptedPrefix, offset);
                      return Promise.resolve({ buffer, bytesRead: acceptedPrefix.byteLength });
                    }
                    return Promise.resolve({ buffer, bytesRead: 0 });
                  };
                }
                return boundFileHandleMember(fileHandle, property);
              },
            });
          },
          realpath,
        };

        await expect(
          selectRepositoryRootWithFileSystem(project, { ceiling: project }, shortReadFileSystem),
        ).rejects.toSatisfy((error: unknown) =>
          expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerChanged),
        );
      },
    );
  });

  test("fails closed on a zero-progress gitfile read", async () => {
    await withTempWorkspace(
      {
        "metadata/HEAD": "ref: refs/heads/main\n",
        "project/.git": "gitdir: ../metadata\n",
      },
      async (workspace) => {
        const project = await realpath(workspace.resolvePath("project"));
        const marker = path.join(project, ".git");
        const zeroReadFileSystem: RepositoryRootFileSystem = {
          lstat: async (target) => lstat(target, { bigint: true }),
          open: async (target, flags) => {
            const handle = await open(target, flags);
            if (target !== marker) return handle;
            return new Proxy(handle, {
              get(fileHandle, property): unknown {
                if (property === "read") {
                  return (
                    buffer: Uint8Array,
                  ): Promise<{
                    readonly buffer: Uint8Array;
                    readonly bytesRead: number;
                  }> => Promise.resolve({ buffer, bytesRead: 0 });
                }
                return boundFileHandleMember(fileHandle, property);
              },
            });
          },
          realpath,
        };

        await expect(
          selectRepositoryRootWithFileSystem(project, { ceiling: project }, zeroReadFileSystem),
        ).rejects.toSatisfy((error: unknown) =>
          expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerChanged),
        );
      },
    );
  });

  test("fails closed on an invalid gitfile fragment length", async () => {
    await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      const invalidReadFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open: async (target, flags) => {
          const handle = await open(target, flags);
          if (target !== marker) return handle;
          return new Proxy(handle, {
            get(fileHandle, property): unknown {
              if (property === "read") {
                return (
                  buffer: Uint8Array,
                ): Promise<{
                  readonly buffer: Uint8Array;
                  readonly bytesRead: number;
                }> => Promise.resolve({ buffer, bytesRead: Number.NaN });
              }
              return boundFileHandleMember(fileHandle, property);
            },
          });
        },
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, invalidReadFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerChanged),
      );
    });
  });

  test("fails closed when a gitfile grows beyond its opened-handle size", async () => {
    await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      const growingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open: async (target, flags) => {
          const handle = await open(target, flags);
          if (target !== marker) return handle;
          return new Proxy(handle, {
            get(fileHandle, property): unknown {
              if (property === "read") {
                return (
                  buffer: Uint8Array,
                  _offset: number,
                  length: number,
                ): Promise<{ readonly buffer: Uint8Array; readonly bytesRead: number }> =>
                  Promise.resolve({ buffer, bytesRead: length });
              }
              return boundFileHandleMember(fileHandle, property);
            },
          });
        },
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, growingFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerChanged),
      );
    });
  });

  test("fails closed when gitfile metadata changes after a complete read", async () => {
    await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      const changingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open: async (target, flags) => {
          const handle = await open(target, flags);
          if (target !== marker) return handle;
          let statCalls = 0;
          return new Proxy(handle, {
            get(fileHandle, property): unknown {
              if (property === "stat") {
                return async (): Promise<BigIntStats> => {
                  statCalls += 1;
                  const stats = await fileHandle.stat({ bigint: true });
                  if (statCalls === 2) {
                    Object.defineProperty(stats, "mtimeNs", { value: stats.mtimeNs + 1n });
                  }
                  return stats;
                };
              }
              return boundFileHandleMember(fileHandle, property);
            },
          });
        },
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, changingFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerChanged),
      );
    });
  });

  test("counts every fragmented gitfile read against the global operation budget", async () => {
    const markerContents = `gitdir: ${"x".repeat(
      REPOSITORY_ROOT_SELECTION_LIMITS.maximumGitfileBytes - "gitdir: ".length,
    )}`;
    await withTempWorkspace({ "project/.git": markerContents }, async (workspace) => {
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      const byteReadFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open: async (target, flags) => {
          const handle = await open(target, flags);
          if (target !== marker) return handle;
          return new Proxy(handle, {
            get(fileHandle, property): unknown {
              if (property === "read") {
                return (
                  buffer: Uint8Array,
                  offset: number,
                  length: number,
                  position: number,
                ): Promise<{ readonly buffer: Uint8Array; readonly bytesRead: number }> =>
                  fileHandle.read(buffer, offset, Math.min(length, 1), position);
              }
              return boundFileHandleMember(fileHandle, property);
            },
          });
        },
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, byteReadFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.limitExceeded),
      );
    });
  });

  test("rejects a .git directory without the required regular HEAD marker", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("project/.git"), { recursive: true });
      await expect(
        selectRepositoryRoot(workspace.resolvePath("project"), {
          ceiling: workspace.resolvePath("project"),
        }),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerInvalid),
      );
    });
  });

  test("fails closed when a worktree marker cannot be opened safely", async () => {
    await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      const unavailable = Object.assign(new Error("denied"), { code: "EACCES" });
      const failingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open: async (target, flags) => {
          if (target === marker) throw unavailable;
          return open(target, flags);
        },
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, failingFileSystem),
      ).rejects.toSatisfy((error: unknown) => {
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerUnavailable);
        expect(error).toMatchObject({ causeCode: "EACCES", operation: "open-gitfile" });
        return true;
      });
    });
  });

  test("sanitizes malformed, active, and proxied platform cause codes", async () => {
    await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      let accessorCalls = 0;
      const accessorError = new Error("private-accessor-data");
      Object.defineProperty(accessorError, "code", {
        get(): string {
          accessorCalls += 1;
          return "EACCES";
        },
      });
      let proxyTraps = 0;
      const proxyError = new Proxy(new Error("private-proxy-data"), {
        getOwnPropertyDescriptor(): never {
          proxyTraps += 1;
          throw new Error("proxy descriptor trap must remain inert");
        },
        getPrototypeOf(): never {
          proxyTraps += 1;
          throw new Error("proxy prototype trap must remain inert");
        },
      });
      const invalidErrors: readonly Error[] = [
        accessorError,
        proxyError,
        Object.assign(new Error("private-number-data"), { code: 17 }),
        Object.assign(new Error("private-control-data"), { code: "EIO\nSECRET" }),
        Object.assign(new Error("private-oversized-data"), { code: "E".repeat(33) }),
      ];

      for (const thrown of invalidErrors) {
        const failingFileSystem: RepositoryRootFileSystem = {
          lstat: async (target) => lstat(target, { bigint: true }),
          open: (target, flags) =>
            target === marker ? Promise.reject(thrown) : open(target, flags),
          realpath,
        };
        await expect(
          selectRepositoryRootWithFileSystem(project, { ceiling: project }, failingFileSystem),
        ).rejects.toSatisfy((error: unknown) => {
          expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerUnavailable);
          expect(error).toMatchObject({ causeCode: undefined, operation: "open-gitfile" });
          expect(typeof (error as RepositoryRootSelectionError).causeCode).toBe("undefined");
          expect(Object.isFrozen(error)).toBe(true);
          expect((error as Error).message).not.toContain("private-");
          return true;
        });
      }
      expect(accessorCalls).toBe(0);
      expect(proxyTraps).toBe(0);
    });
  });

  test.each([
    ["initial", 1],
    ["completed", 2],
  ] as const)(
    "maps an %s gitfile stat rejection without exposing its message",
    async (_label, failAt) => {
      await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
        const project = await realpath(workspace.resolvePath("project"));
        const marker = path.join(project, ".git");
        const rawFailure = Object.assign(new Error("private-stat-data"), { code: "EIO" });
        const failingFileSystem: RepositoryRootFileSystem = {
          lstat: async (target) => lstat(target, { bigint: true }),
          open: async (target, flags) => {
            const handle = await open(target, flags);
            if (target !== marker) return handle;
            let statCalls = 0;
            return new Proxy(handle, {
              get(fileHandle, property): unknown {
                if (property === "stat") {
                  return (): Promise<BigIntStats> => {
                    statCalls += 1;
                    if (statCalls === failAt) return Promise.reject(rawFailure);
                    return fileHandle.stat({ bigint: true });
                  };
                }
                return boundFileHandleMember(fileHandle, property);
              },
            });
          },
          realpath,
        };

        await expect(
          selectRepositoryRootWithFileSystem(project, { ceiling: project }, failingFileSystem),
        ).rejects.toSatisfy((error: unknown) => {
          expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerUnavailable);
          expect(error).toMatchObject({ causeCode: "EIO", operation: "stat-gitfile" });
          expect((error as Error).message).not.toContain("private-stat-data");
          return true;
        });
      });
    },
  );

  test.each([
    ["read failure alone", false],
    ["primary read and secondary close failures", true],
  ] as const)("preserves the bounded primary error for %s", async (_label, failClose) => {
    await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      const readFailure = Object.assign(new Error("private-read-data"), { code: "EIO" });
      const closeFailure = Object.assign(new Error("private-close-data"), { code: "EBADF" });
      const failingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open: async (target, flags) => {
          const handle = await open(target, flags);
          if (target !== marker) return handle;
          return new Proxy(handle, {
            get(fileHandle, property): unknown {
              if (property === "read") {
                return (): Promise<never> => Promise.reject(readFailure);
              }
              if (property === "close" && failClose) {
                return async (): Promise<void> => {
                  await fileHandle.close();
                  throw closeFailure;
                };
              }
              return boundFileHandleMember(fileHandle, property);
            },
          });
        },
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, failingFileSystem),
      ).rejects.toSatisfy((error: unknown) => {
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerUnavailable);
        expect(error).toMatchObject({ causeCode: "EIO", operation: "read-gitfile" });
        expect((error as Error).message).not.toContain("private-read-data");
        expect((error as Error).message).not.toContain("private-close-data");
        return true;
      });
    });
  });

  test("detects a worktree marker changed between inspection and open", async () => {
    await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      const racingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open: async (target, flags) => {
          if (target === marker) await writeFile(target, "gitdir: ../replacement-metadata\n");
          return open(target, flags);
        },
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, racingFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerChanged),
      );
    });
  });

  test("maps a worktree marker close failure without leaking its handle", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("metadata"));
      await writeFile(workspace.resolvePath("metadata/HEAD"), "ref: refs/heads/main\n");
      await mkdir(workspace.resolvePath("project"));
      await writeFile(workspace.resolvePath("project/.git"), "gitdir: ../metadata\n");
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      const unavailable = Object.assign(new Error("close failed"), { code: "EIO" });
      const failingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open: async (target, flags) => {
          const handle = await open(target, flags);
          if (target !== marker) return handle;
          const close = handle.close.bind(handle);
          handle.close = async (): Promise<void> => {
            await close();
            throw unavailable;
          };
          return handle;
        },
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, failingFileSystem),
      ).rejects.toSatisfy((error: unknown) => {
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerUnavailable);
        expect(error).toMatchObject({ causeCode: "EIO", operation: "close-gitfile" });
        return true;
      });
    });
  });

  test("rejects linked Git markers without following them", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await addGitDirectory(workspace.resolvePath("metadata"));
      await mkdir(workspace.resolvePath("project"));
      await symlink(
        workspace.resolvePath("metadata/.git"),
        workspace.resolvePath("project/.git"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        selectRepositoryRoot(workspace.resolvePath("project"), {
          ceiling: workspace.resolvePath("project"),
        }),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerInvalid),
      );
    });
  });

  test("rejects a Git marker with an unsupported special-file type", async () => {
    await withTempWorkspace({ "project/.git": "device-placeholder" }, async (workspace) => {
      const project = await realpath(workspace.resolvePath("project"));
      const marker = path.join(project, ".git");
      const specialStats = await lstat(marker, { bigint: true });
      Object.defineProperties(specialStats, {
        isDirectory: { value: (): boolean => false },
        isFile: { value: (): boolean => false },
        isSymbolicLink: { value: (): boolean => false },
      });
      const specialFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) =>
          target === marker ? specialStats : lstat(target, { bigint: true }),
        open,
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, specialFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerInvalid),
      );
    });
  });

  test("validates options without invoking accessors and supports cancellation", async () => {
    let reads = 0;
    const options = Object.defineProperty({}, "mode", {
      enumerable: true,
      get(): string {
        reads += 1;
        return "explicit";
      },
    });
    await expect(
      selectRepositoryRoot("/not-inspected", options as { mode: "explicit" }),
    ).rejects.toSatisfy((error: unknown) =>
      expectSelectionError(error, RepositoryRootSelectionErrorCode.invalidOptions),
    );
    expect(reads).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(
      selectRepositoryRoot("/not-inspected", { signal: controller.signal }),
    ).rejects.toSatisfy((error: unknown) =>
      expectSelectionError(error, RepositoryRootSelectionErrorCode.aborted),
    );
  });

  test("uses the intrinsic AbortSignal state without invoking own or subclass accessors", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("project"));
      let callbacks = 0;
      const rawFailure = new Error("private-signal-accessor-data");
      type Behavior = false | true | "throw";
      const state = (behavior: Behavior): boolean => {
        callbacks += 1;
        if (behavior === "throw") throw rawFailure;
        return behavior;
      };
      const ownSignal = (behavior: Behavior): AbortSignal => {
        const signal = new AbortController().signal;
        Object.defineProperty(signal, "aborted", { get: () => state(behavior) });
        return signal;
      };
      const subclassSignal = (behavior: Behavior): AbortSignal => {
        const signal = new AbortController().signal;
        class CallerSignal extends AbortSignal {
          override get aborted(): boolean {
            return state(behavior);
          }
        }
        Object.setPrototypeOf(signal, CallerSignal.prototype);
        return signal;
      };

      for (const signal of [
        ownSignal(false),
        ownSignal(true),
        ownSignal("throw"),
        subclassSignal(false),
        subclassSignal(true),
        subclassSignal("throw"),
      ]) {
        const selected = await selectRepositoryRoot(workspace.resolvePath("project"), {
          mode: "explicit",
          signal,
        });
        expect(selected.reason).toBe("explicit-path");
      }

      const abortedController = new AbortController();
      abortedController.abort();
      Object.defineProperty(abortedController.signal, "aborted", {
        get: () => state(false),
      });
      await expect(
        selectRepositoryRoot(workspace.resolvePath("project"), {
          mode: "explicit",
          signal: abortedController.signal,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectSelectionError(error, RepositoryRootSelectionErrorCode.aborted);
        expect((error as Error).message).not.toContain("private-signal-accessor-data");
        return true;
      });
      expect(callbacks).toBe(0);
    });
  });

  test("maps an invalid AbortSignal brand to a frozen typed option failure", async () => {
    const forgedSignal = Object.create(AbortSignal.prototype) as AbortSignal;
    await expect(
      selectRepositoryRoot("/not-inspected", { signal: forgedSignal }),
    ).rejects.toSatisfy((error: unknown) => {
      expectSelectionError(error, RepositoryRootSelectionErrorCode.invalidOptions);
      expect(error).toMatchObject({ operation: "validate-options" });
      expect(Object.isFrozen(error)).toBe(true);
      return true;
    });
  });

  test.each([null, [], new Proxy({}, {}), Object.create(null)])(
    "rejects a non-plain option container %# before filesystem access",
    async (options) => {
      await expect(selectRepositoryRoot("/not-inspected", options as never)).rejects.toSatisfy(
        (error: unknown) =>
          expectSelectionError(error, RepositoryRootSelectionErrorCode.invalidOptions),
      );
    },
  );

  test("bounds option reflection and rejects revoked signal values before filesystem access", async () => {
    let callbacks = 0;
    let operations = 0;
    const largeOptions: Record<string, unknown> = {};
    for (let index = 0; index < 10_000; index += 1) {
      largeOptions[`unknown${String(index)}`] = index;
    }
    Object.defineProperty(largeOptions, "active", {
      enumerable: true,
      get(): boolean {
        callbacks += 1;
        return true;
      },
    });
    const symbolOptions = { [Symbol("unknown")]: true };
    const revokedSignal = Proxy.revocable(new AbortController().signal, {});
    revokedSignal.revoke();
    const noAccessFileSystem: RepositoryRootFileSystem = {
      lstat: () => {
        operations += 1;
        return Promise.reject(new Error("filesystem must not be reached"));
      },
      open: () => {
        operations += 1;
        return Promise.reject(new Error("filesystem must not be reached"));
      },
      realpath: () => {
        operations += 1;
        return Promise.reject(new Error("filesystem must not be reached"));
      },
    };

    for (const options of [largeOptions, symbolOptions, { signal: revokedSignal.proxy }]) {
      await expect(
        selectRepositoryRootWithFileSystem("/not-inspected", options as never, noAccessFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.invalidOptions),
      );
    }
    expect(callbacks).toBe(0);
    expect(operations).toBe(0);
  });

  test.each(["lstat", "realpath"] as const)(
    "observes cancellation immediately after an awaited %s operation",
    async (operation) => {
      await withTempWorkspace({}, async (workspace) => {
        await mkdir(workspace.resolvePath("project"));
        const controller = new AbortController();
        const cancellingFileSystem: RepositoryRootFileSystem = {
          lstat: async (target) => {
            const stats = await lstat(target, { bigint: true });
            if (operation === "lstat") controller.abort();
            return stats;
          },
          open,
          realpath: async (target) => {
            const canonical = await realpath(target);
            if (operation === "realpath") controller.abort();
            return canonical;
          },
        };

        await expect(
          selectRepositoryRootWithFileSystem(
            workspace.resolvePath("project"),
            { mode: "explicit", signal: controller.signal },
            cancellingFileSystem,
          ),
        ).rejects.toSatisfy((error: unknown) =>
          expectSelectionError(error, RepositoryRootSelectionErrorCode.aborted),
        );
      });
    },
  );

  test.each([
    ["successful cleanup", false],
    ["failing cleanup", true],
  ] as const)(
    "closes an opened gitfile exactly once after cancellation with %s",
    async (_label, failClose) => {
      await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
        const project = await realpath(workspace.resolvePath("project"));
        const marker = path.join(project, ".git");
        const controller = new AbortController();
        const closeFailure = Object.assign(new Error("private-close-data"), { code: "EIO" });
        let closes = 0;
        const cancellingFileSystem: RepositoryRootFileSystem = {
          lstat: async (target) => lstat(target, { bigint: true }),
          open: async (target, flags) => {
            const handle = await open(target, flags);
            if (target !== marker) return handle;
            controller.abort();
            return new Proxy(handle, {
              get(fileHandle, property): unknown {
                if (property === "close") {
                  return async (): Promise<void> => {
                    closes += 1;
                    await fileHandle.close();
                    if (failClose) throw closeFailure;
                  };
                }
                return boundFileHandleMember(fileHandle, property);
              },
            });
          },
          realpath,
        };

        await expect(
          selectRepositoryRootWithFileSystem(
            project,
            { ceiling: project, signal: controller.signal },
            cancellingFileSystem,
          ),
        ).rejects.toSatisfy((error: unknown) => {
          expectSelectionError(error, RepositoryRootSelectionErrorCode.aborted);
          expect(error).toMatchObject({ causeCode: undefined, operation: "cancel" });
          expect((error as Error).message).not.toContain("private-close-data");
          return true;
        });
        expect(closes).toBe(1);
      });
    },
  );

  test.each(["stat", "read"] as const)(
    "preserves cancellation and closes after an awaited gitfile %s operation",
    async (operation) => {
      await withTempWorkspace({ "project/.git": "gitdir: ../metadata\n" }, async (workspace) => {
        const project = await realpath(workspace.resolvePath("project"));
        const marker = path.join(project, ".git");
        const controller = new AbortController();
        let closes = 0;
        const cancellingFileSystem: RepositoryRootFileSystem = {
          lstat: async (target) => lstat(target, { bigint: true }),
          open: async (target, flags) => {
            const handle = await open(target, flags);
            if (target !== marker) return handle;
            return new Proxy(handle, {
              get(fileHandle, property): unknown {
                if (property === "stat") {
                  return async (): Promise<BigIntStats> => {
                    const stats = await fileHandle.stat({ bigint: true });
                    if (operation === "stat") controller.abort();
                    return stats;
                  };
                }
                if (property === "read") {
                  return async (
                    buffer: Uint8Array,
                    offset: number,
                    length: number,
                    position: number,
                  ): Promise<{ readonly buffer: Uint8Array; readonly bytesRead: number }> => {
                    const result = await fileHandle.read(buffer, offset, length, position);
                    if (operation === "read") controller.abort();
                    return result;
                  };
                }
                if (property === "close") {
                  return async (): Promise<void> => {
                    closes += 1;
                    await fileHandle.close();
                  };
                }
                return boundFileHandleMember(fileHandle, property);
              },
            });
          },
          realpath,
        };

        await expect(
          selectRepositoryRootWithFileSystem(
            project,
            { ceiling: project, signal: controller.signal },
            cancellingFileSystem,
          ),
        ).rejects.toSatisfy((error: unknown) =>
          expectSelectionError(error, RepositoryRootSelectionErrorCode.aborted),
        );
        expect(closes).toBe(1);
      });
    },
  );

  test.each([
    { maximumAncestorDepth: -1 },
    { maximumAncestorDepth: 0.5 },
    { maximumAncestorDepth: REPOSITORY_ROOT_SELECTION_LIMITS.maximumAncestorDepth + 1 },
    { mode: "unknown" },
    { ceiling: 42 },
    { mode: "explicit", ceiling: "/ceiling" },
    { signal: {} },
  ])("rejects malformed option set %# before filesystem access", async (options) => {
    await expect(selectRepositoryRoot("/not-inspected", options as never)).rejects.toSatisfy(
      (error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.invalidOptions),
    );
  });

  test("enforces the caller-lowered ancestor-depth bound", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("one/two"), { recursive: true });
      await expect(
        selectRepositoryRoot(workspace.resolvePath("one/two"), {
          ceiling: workspace.root,
          maximumAncestorDepth: 0,
        }),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.limitExceeded),
      );
    });
  });

  test("rejects repository paths beyond the component resource bound before filesystem access", async () => {
    const root = path.parse(process.cwd()).root;
    const tooDeep = path.join(
      root,
      ...Array.from(
        { length: REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathComponents + 1 },
        () => "x",
      ),
    );

    await expect(selectRepositoryRoot(tooDeep, { mode: "explicit" })).rejects.toSatisfy(
      (error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.limitExceeded),
    );
  });

  test("rejects oversized start and ceiling paths before any filesystem operation", async () => {
    const oversizedAscii = absoluteAsciiPathWithBytes(
      REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathBytes + 1,
    );
    const oversizedWide = `${path.parse(process.cwd()).root}${"é".repeat(
      Math.floor(REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathBytes / 2) + 1,
    )}`;
    let operations = 0;
    const noAccessFileSystem: RepositoryRootFileSystem = {
      lstat: () => {
        operations += 1;
        return Promise.reject(new Error("filesystem must not be reached"));
      },
      open: () => {
        operations += 1;
        return Promise.reject(new Error("filesystem must not be reached"));
      },
      realpath: () => {
        operations += 1;
        return Promise.reject(new Error("filesystem must not be reached"));
      },
    };

    for (const start of [oversizedAscii, oversizedWide]) {
      await expect(
        selectRepositoryRootWithFileSystem(start, { mode: "explicit" }, noAccessFileSystem),
      ).rejects.toSatisfy((error: unknown) => {
        expectSelectionError(error, RepositoryRootSelectionErrorCode.limitExceeded);
        expect(error).toMatchObject({ operation: "path-bytes", path: undefined });
        return true;
      });
    }
    await expect(
      selectRepositoryRootWithFileSystem(
        absoluteAsciiPathWithBytes(32),
        { ceiling: oversizedAscii },
        noAccessFileSystem,
      ),
    ).rejects.toSatisfy((error: unknown) =>
      expectSelectionError(error, RepositoryRootSelectionErrorCode.limitExceeded),
    );
    expect(operations).toBe(0);
  });

  test("bounds canonical and generated marker paths before inspecting them", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("directory"));
      const directoryStats = await lstat(workspace.resolvePath("directory"), { bigint: true });
      const oversizedCanonical = absoluteAsciiPathWithBytes(
        REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathBytes + 1,
      );
      const canonicalLstats: string[] = [];
      const invalidCanonicalFileSystem: RepositoryRootFileSystem = {
        lstat: (target) => {
          canonicalLstats.push(target);
          return Promise.resolve(directoryStats);
        },
        open,
        realpath: () => Promise.resolve(oversizedCanonical),
      };
      await expect(
        selectRepositoryRootWithFileSystem(
          absoluteAsciiPathWithBytes(32),
          { mode: "explicit" },
          invalidCanonicalFileSystem,
        ),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.limitExceeded),
      );
      expect(canonicalLstats).not.toContain(oversizedCanonical);

      const maximumStart = absoluteAsciiPathWithBytes(
        REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathBytes,
      );
      const markerLstats: string[] = [];
      const markerFileSystem: RepositoryRootFileSystem = {
        lstat: (target) => {
          markerLstats.push(target);
          return Promise.resolve(directoryStats);
        },
        open,
        realpath: (target) => Promise.resolve(target),
      };
      await expect(
        selectRepositoryRootWithFileSystem(maximumStart, undefined, markerFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.limitExceeded),
      );
      expect(
        markerLstats.every(
          (target) =>
            Buffer.byteLength(target, "utf8") <= REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathBytes,
        ),
      ).toBe(true);
    });
  });

  test("bounds generated HEAD and gitdir paths before filesystem inspection", async () => {
    await withTempWorkspace({ gitfile: "gitdir: metadata\n" }, async (workspace) => {
      await mkdir(workspace.resolvePath("directory"));
      const directoryStats = await lstat(workspace.resolvePath("directory"), { bigint: true });
      const gitfileStats = await lstat(workspace.resolvePath("gitfile"), { bigint: true });
      const markerSuffixBytes = Buffer.byteLength(`${path.sep}.git`, "utf8");
      const start = absoluteAsciiPathWithBytes(
        REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathBytes - markerSuffixBytes,
      );
      const marker = path.join(start, ".git");

      const headLstats: string[] = [];
      const headFileSystem: RepositoryRootFileSystem = {
        lstat: (target) => {
          headLstats.push(target);
          return Promise.resolve(directoryStats);
        },
        open,
        realpath: (target) => Promise.resolve(target),
      };
      await expect(
        selectRepositoryRootWithFileSystem(start, undefined, headFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.limitExceeded),
      );
      expect(headLstats.some((target) => target.endsWith(`${path.sep}HEAD`))).toBe(false);

      const gitdirLstats: string[] = [];
      const gitdirFileSystem: RepositoryRootFileSystem = {
        lstat: (target) => {
          gitdirLstats.push(target);
          return Promise.resolve(target === marker ? gitfileStats : directoryStats);
        },
        open: (_target, flags) => open(workspace.resolvePath("gitfile"), flags),
        realpath: (target) => Promise.resolve(target),
      };
      await expect(
        selectRepositoryRootWithFileSystem(start, undefined, gitdirFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerInvalid),
      );
      expect(
        gitdirLstats.every(
          (target) =>
            Buffer.byteLength(target, "utf8") <= REPOSITORY_ROOT_SELECTION_LIMITS.maximumPathBytes,
        ),
      ).toBe(true);
    });
  });

  test("rejects a ceiling that is not an ancestor of the selected start directory", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("project/src"), { recursive: true });
      await mkdir(workspace.resolvePath("unrelated"));

      await expect(
        selectRepositoryRoot(workspace.resolvePath("project/src"), {
          ceiling: workspace.resolvePath("unrelated"),
        }),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.invalidOptions),
      );
    });
  });

  test("rejects file components and maps canonicalization failures", async () => {
    await withTempWorkspace({ file: "not a directory" }, async (workspace) => {
      await expect(
        selectRepositoryRoot(workspace.resolvePath("file"), { mode: "explicit" }),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.pathNotDirectory),
      );

      await mkdir(workspace.resolvePath("project"));
      const project = workspace.resolvePath("project");
      const unavailable = Object.assign(new Error("denied"), { code: "EACCES" });
      const failingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open,
        realpath: async (target) => {
          if (target === project) throw unavailable;
          return realpath(target);
        },
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { mode: "explicit" }, failingFileSystem),
      ).rejects.toSatisfy((error: unknown) => {
        expectSelectionError(error, RepositoryRootSelectionErrorCode.pathUnavailable);
        expect(error).toMatchObject({ causeCode: "EACCES", operation: "realpath" });
        return true;
      });
    });
  });

  test("maps an inaccessible HEAD in a discovered marker to a marker failure", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await addGitDirectory(workspace.resolvePath("project"));
      const project = await realpath(workspace.resolvePath("project"));
      const head = path.join(project, ".git", "HEAD");
      const unavailable = Object.assign(new Error("denied"), { code: "EACCES" });
      const failingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => {
          if (target === head) throw unavailable;
          return lstat(target, { bigint: true });
        },
        open,
        realpath,
      };

      await expect(
        selectRepositoryRootWithFileSystem(project, { ceiling: project }, failingFileSystem),
      ).rejects.toSatisfy((error: unknown) => {
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerUnavailable);
        expect(error).toMatchObject({ causeCode: "EACCES", operation: "inspect-git-marker" });
        return true;
      });
    });
  });

  test("detects a marker that appears during a non-Git selection", async () => {
    await withTempWorkspace({ "decoy-file": "x" }, async (workspace) => {
      await mkdir(workspace.resolvePath("project"));
      const lexicalProject = workspace.resolvePath("project");
      const project = await realpath(lexicalProject);
      const marker = path.join(project, ".git");
      const realFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open,
        realpath,
      };
      let markerReads = 0;
      let projectRealpaths = 0;
      let markerAppeared = false;
      const racingFileSystem: RepositoryRootFileSystem = {
        ...realFileSystem,
        lstat: async (target) => {
          if (target === marker) {
            markerReads += 1;
            if (markerAppeared) return lstat(workspace.resolvePath("decoy-file"), { bigint: true });
          }
          return realFileSystem.lstat(target);
        },
        realpath: async (target) => {
          const canonical = await realpath(target);
          if (target === lexicalProject) {
            projectRealpaths += 1;
            if (projectRealpaths === 3) markerAppeared = true;
          }
          return canonical;
        },
      };
      await expect(
        selectRepositoryRootWithFileSystem(
          lexicalProject,
          { ceiling: lexicalProject },
          racingFileSystem,
        ),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerChanged),
      );
      expect(markerAppeared).toBe(true);
      expect(markerReads).toBe(2);
    });
  });

  test("detects a nearer marker that appears before an outer Git marker is accepted", async () => {
    await withTempWorkspace({ "decoy-file": "x" }, async (workspace) => {
      await addGitDirectory(workspace.resolvePath("outer"));
      await mkdir(workspace.resolvePath("outer/child"));
      const outer = await realpath(workspace.resolvePath("outer"));
      const child = await realpath(workspace.resolvePath("outer/child"));
      const nearerMarker = path.join(child, ".git");
      let outerRealpaths = 0;
      let nearerMarkerAppeared = false;
      let nearerMarkerReads = 0;
      const racingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => {
          if (target === nearerMarker) {
            nearerMarkerReads += 1;
            if (nearerMarkerAppeared)
              return lstat(workspace.resolvePath("decoy-file"), { bigint: true });
          }
          return lstat(target, { bigint: true });
        },
        open,
        realpath: async (target) => {
          const canonical = await realpath(target);
          if (target === outer) {
            outerRealpaths += 1;
            if (outerRealpaths === 2) nearerMarkerAppeared = true;
          }
          return canonical;
        },
      };

      await expect(
        selectRepositoryRootWithFileSystem(child, { ceiling: outer }, racingFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.gitMarkerChanged),
      );
      expect(nearerMarkerAppeared).toBe(true);
      expect(nearerMarkerReads).toBe(2);
    });
  });

  test("ignores content timestamp changes in a stable intermediate directory", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("project"));
      const project = await realpath(workspace.resolvePath("project"));
      const workspaceRoot = await realpath(workspace.root);
      let workspaceReads = 0;
      const mutatingFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => {
          if (target === workspaceRoot) {
            workspaceReads += 1;
            if (workspaceReads === 3) await mkdir(workspace.resolvePath("unrelated-sibling"));
          }
          return lstat(target, { bigint: true });
        },
        open,
        realpath,
      };

      const result = await selectRepositoryRootWithFileSystem(
        project,
        { mode: "explicit" },
        mutatingFileSystem,
      );

      expect(result.root).toBe(project);
      expect(result.reason).toBe("explicit-path");
      expect(workspaceReads).toBeGreaterThanOrEqual(3);
    });
  });

  test("detects replacement of the selected directory during final identity checks", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("project"));
      await mkdir(workspace.resolvePath("replacement"));
      const project = await realpath(workspace.resolvePath("project"));
      const replacement = await realpath(workspace.resolvePath("replacement"));
      const realFileSystem: RepositoryRootFileSystem = {
        lstat: async (target) => lstat(target, { bigint: true }),
        open,
        realpath,
      };
      let projectReads = 0;
      const racingFileSystem: RepositoryRootFileSystem = {
        ...realFileSystem,
        lstat: async (target) => {
          if (target === project) {
            projectReads += 1;
            if (projectReads >= 3) return lstat(replacement, { bigint: true });
          }
          return realFileSystem.lstat(target);
        },
      };
      await expect(
        selectRepositoryRootWithFileSystem(project, { mode: "explicit" }, racingFileSystem),
      ).rejects.toSatisfy((error: unknown) =>
        expectSelectionError(error, RepositoryRootSelectionErrorCode.pathChanged),
      );
    });
  });
});
