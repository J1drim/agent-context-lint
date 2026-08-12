import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test } from "vitest";

import {
  createReadOnlyRepository,
  enumerateTrackedFiles,
  parseGitIndex,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  selectRepositoryRoot,
  TRACKED_FILE_ENUMERATION_HARD_LIMITS,
  TrackedFileEnumerationErrorCode,
} from "../src/index.js";
import type { ReadOnlyRepository } from "../src/index.js";

interface IndexEntryFixture {
  readonly extendedFlags?: number;
  readonly mode?: number;
  readonly path: string;
  readonly stage?: number;
}

const execFileAsync = promisify(execFile);

interface IndexFixtureOptions {
  readonly extensions?: readonly { readonly data?: Uint8Array; readonly signature: string }[];
  readonly objectFormat?: "sha1" | "sha256";
  readonly version?: 2 | 3 | 4;
}

function be16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}

function be32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function encodeRemove(value: number): Buffer {
  if (value >= 128) throw new Error("fixture removal is intentionally one byte");
  return Buffer.from([value]);
}

function buildIndex(
  entries: readonly IndexEntryFixture[],
  options: IndexFixtureOptions = {},
): Buffer {
  const version = options.version ?? 2;
  const objectFormat = options.objectFormat ?? "sha1";
  const oidBytes = objectFormat === "sha1" ? 20 : 32;
  const header = Buffer.concat([Buffer.from("DIRC"), be32(version), be32(entries.length)]);
  const encoded: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (const fixture of entries) {
    const raw = Buffer.from(fixture.path, "utf8");
    const extended = fixture.extendedFlags !== undefined;
    const flags =
      (extended ? 0x4000 : 0) | ((fixture.stage ?? 0) << 12) | Math.min(raw.length, 0x0fff);
    const fixed = Buffer.alloc(40 + oidBytes);
    fixed.writeUInt32BE(fixture.mode ?? 0o100644, 24);
    let entry = Buffer.concat([
      fixed,
      be16(flags),
      ...(extended ? [be16(fixture.extendedFlags ?? 0)] : []),
    ]);
    if (version === 4) {
      let common = 0;
      while (common < previous.length && common < raw.length && previous[common] === raw[common]) {
        common += 1;
      }
      const remove = previous.length - common;
      entry = Buffer.concat([entry, encodeRemove(remove), raw.subarray(common), Buffer.from([0])]);
    } else {
      entry = Buffer.concat([entry, raw, Buffer.from([0])]);
      entry = Buffer.concat([entry, Buffer.alloc((8 - (entry.length % 8)) % 8)]);
    }
    encoded.push(entry);
    previous = raw;
  }
  const extensions = (options.extensions ?? []).map((extension) => {
    const data = Buffer.from(extension.data ?? new Uint8Array());
    return Buffer.concat([Buffer.from(extension.signature, "ascii"), be32(data.length), data]);
  });
  const content = Buffer.concat([header, ...encoded, ...extensions]);
  return Buffer.concat([content, createHash(objectFormat).update(content).digest()]);
}

function resignSha1(index: Buffer): void {
  const content = index.subarray(0, index.length - 20);
  createHash("sha1").update(content).digest().copy(index, content.length);
}

async function facade(root: string, signal?: AbortSignal): Promise<ReadOnlyRepository> {
  const selection = await selectRepositoryRoot(root, { mode: "explicit" });
  return createReadOnlyRepository(selection, {
    maximumFileBytes: TRACKED_FILE_ENUMERATION_HARD_LIMITS.maximumIndexBytes,
    maximumTotalBytes: TRACKED_FILE_ENUMERATION_HARD_LIMITS.maximumIndexBytes,
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("C03 Git index parser", () => {
  test.each([2, 3, 4] as const)("parses sorted version %i entries", (version) => {
    const parsed = parseGitIndex(
      buildIndex([{ path: "AGENTS.md" }, { path: "src/a.ts" }, { path: "src/b.ts" }], {
        version,
      }),
    );
    expect(parsed).toMatchObject({
      objectFormat: "sha1",
      paths: ["AGENTS.md", "src/a.ts", "src/b.ts"],
      version,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.paths)).toBe(true);
  });

  test("detects and verifies a SHA-256 index", () => {
    expect(
      parseGitIndex(buildIndex([{ path: "file.md" }], { objectFormat: "sha256", version: 3 })),
    ).toMatchObject({ objectFormat: "sha256", version: 3 });
  });

  test("accepts optional extensions and rejects required, split, and sparse extensions", () => {
    expect(
      parseGitIndex(
        buildIndex([{ path: "file" }], {
          extensions: [{ data: Buffer.from("opaque"), signature: "TREE" }],
        }),
      ).paths,
    ).toEqual(["file"]);
    for (const signature of ["link", "sdir", "abcd"]) {
      expect(() =>
        parseGitIndex(buildIndex([{ path: "file" }], { extensions: [{ signature }] })),
      ).toThrow("Git index cannot be used safely");
    }
  });

  test("accepts supported modes, merge stages, and v3 extended flags", () => {
    const entries: IndexEntryFixture[] = [
      { mode: 0o100644, path: "a", stage: 1 },
      { mode: 0o100755, path: "a", stage: 2 },
      { mode: 0o120000, path: "link" },
      { extendedFlags: 0x2000, mode: 0o160000, path: "submodule" },
    ];
    expect(parseGitIndex(buildIndex(entries, { version: 3 })).paths).toEqual([
      "a",
      "link",
      "submodule",
    ]);
  });

  test("rejects a stage-zero entry mixed with merge stages for the same path", () => {
    expect(() =>
      parseGitIndex(
        buildIndex([
          { path: "a", stage: 0 },
          { path: "a", stage: 1 },
        ]),
      ),
    ).toThrow("Git index cannot be used safely");
  });

  test("rejects a saturated pathname-length sentinel for a short path", () => {
    const index = buildIndex([{ path: "a" }]);
    index.writeUInt16BE(0x0fff, 72);
    resignSha1(index);
    expect(() => parseGitIndex(index)).toThrow("Git index cannot be used safely");
  });

  test.each([
    [
      "bad signature",
      (index: Buffer): Buffer => {
        index[0] = 0;
        return index;
      },
    ],
    [
      "bad checksum",
      (index: Buffer): Buffer => {
        index.writeUInt8(index.readUInt8(index.length - 1) ^ 1, index.length - 1);
        return index;
      },
    ],
    ["truncated", (index: Buffer): Buffer => index.subarray(0, index.length - 10)],
    [
      "unsupported version",
      (index: Buffer): Buffer => {
        index.writeUInt32BE(5, 4);
        return index;
      },
    ],
    [
      "entry count",
      (index: Buffer): Buffer => {
        index.writeUInt32BE(2, 8);
        return index;
      },
    ],
    [
      "bad mode",
      (index: Buffer): Buffer => {
        index.writeUInt32BE(0o100600, 12 + 24);
        return index;
      },
    ],
    [
      "bad name length",
      (index: Buffer): Buffer => {
        index.writeUInt16BE(9, 12 + 60);
        return index;
      },
    ],
  ] as const)("rejects malformed input: %s", (_label, mutate) => {
    const index = buildIndex([{ path: "file" }]);
    const mutated = mutate(index);
    if (_label !== "bad checksum" && _label !== "truncated") resignSha1(mutated);
    expect(() => parseGitIndex(mutated)).toThrow("Git index cannot be used safely");
  });

  test("rejects invalid extended flags, sparse entries, v4 removals, padding, and extension lengths", () => {
    expect(() =>
      parseGitIndex(buildIndex([{ extendedFlags: 0, path: "a" }], { version: 2 })),
    ).toThrow();
    expect(() =>
      parseGitIndex(buildIndex([{ extendedFlags: 1, path: "a" }], { version: 3 })),
    ).toThrow();
    expect(() => parseGitIndex(buildIndex([{ mode: 0o040000, path: "a" }]))).toThrow();
    expect(() =>
      parseGitIndex(buildIndex([{ extendedFlags: 0x4000, path: "a" }], { version: 3 })),
    ).toThrow();

    const removal = buildIndex([{ path: "a" }], { version: 4 });
    removal[12 + 62] = 1;
    resignSha1(removal);
    expect(() => parseGitIndex(removal)).toThrow();

    const v4 = buildIndex([{ path: "a" }], { version: 4 });
    const unterminatedContent = v4.subarray(0, v4.length - 21);
    const unterminated = Buffer.concat([
      unterminatedContent,
      createHash("sha1").update(unterminatedContent).digest(),
    ]);
    expect(() => parseGitIndex(unterminated)).toThrow();

    const excessiveVarintContent = Buffer.concat([v4.subarray(0, 12 + 62), Buffer.alloc(10, 0x80)]);
    const excessiveVarint = Buffer.concat([
      excessiveVarintContent,
      createHash("sha1").update(excessiveVarintContent).digest(),
    ]);
    expect(() => parseGitIndex(excessiveVarint)).toThrow();

    const padding = buildIndex([{ path: "ab" }]);
    padding[12 + 65] = 1;
    resignSha1(padding);
    expect(() => parseGitIndex(padding)).toThrow();

    const extensionLength = buildIndex([{ path: "a" }], { extensions: [{ signature: "TREE" }] });
    extensionLength.writeUInt32BE(100, 12 + 64 + 4);
    resignSha1(extensionLength);
    expect(() => parseGitIndex(extensionLength)).toThrow();
  });

  test.each([
    ["traversal", "../outside"],
    ["absolute", "/outside"],
    ["git metadata", ".git/config"],
    ["backslash", "a\\b"],
    ["empty component", "a//b"],
    ["trailing slash", "a/"],
    ["control", "a\nb"],
    ["bidi", "a\u202Eb"],
  ])("rejects an unsafe index path: %s", (_label, path) => {
    expect(() => parseGitIndex(buildIndex([{ path }]))).toThrow("Git index cannot be used safely");
  });

  test("rejects non-UTF-8, case collisions, path-prefix collisions, and unsorted entries", () => {
    const invalidUtf8 = buildIndex([{ path: "x" }]);
    invalidUtf8[12 + 62] = 0xff;
    const content = invalidUtf8.subarray(0, invalidUtf8.length - 20);
    createHash("sha1").update(content).digest().copy(invalidUtf8, content.length);
    expect(() => parseGitIndex(invalidUtf8)).toThrow();
    for (const entries of [
      [{ path: "A" }, { path: "a" }],
      [{ path: "a" }, { path: "a/b" }],
      [{ path: "z" }, { path: "a" }],
    ]) {
      expect(() => parseGitIndex(buildIndex(entries))).toThrow();
    }
  });

  test("enforces byte, entry, and option bounds without coercion", () => {
    const index = buildIndex([{ path: "a" }, { path: "b" }]);
    expect(() => parseGitIndex(index, { maximumIndexEntries: 1 })).toThrow();
    expect(() => parseGitIndex(index, { maximumIndexBytes: 1 })).toThrow();
    expect(() => parseGitIndex(buildIndex([{ path: "a/b" }]), { maximumDepth: 1 })).toThrow();
    expect(() => parseGitIndex(buildIndex([{ path: "x".repeat(16_385) }]))).toThrow();
    for (const options of [null, [], new Proxy({}, {}), { unknown: 1 }, { maximumFiles: 0 }]) {
      expect(() => parseGitIndex(index, options as never)).toThrow(
        expect.objectContaining({ code: TrackedFileEnumerationErrorCode.invalidOptions }),
      );
    }
    let reads = 0;
    const accessor = Object.defineProperty({}, "maximumFiles", {
      get() {
        reads += 1;
        return 1;
      },
    });
    expect(() => parseGitIndex(index, accessor)).toThrow(
      expect.objectContaining({ code: TrackedFileEnumerationErrorCode.invalidOptions }),
    );
    expect(reads).toBe(0);
  });
});

describe("C03 tracked-file enumeration", () => {
  test("uses an ordinary in-root index and excludes untracked files", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/.git"), { recursive: true });
      await mkdir(workspace.resolvePath("repo/src"));
      await writeFile(workspace.resolvePath("repo/.git/index"), buildIndex([{ path: "src/a.ts" }]));
      await writeFile(workspace.resolvePath("repo/src/a.ts"), "tracked");
      await writeFile(workspace.resolvePath("repo/src/untracked.ts"), "untracked");

      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));

      expect(result).toMatchObject({
        certainty: "tracked",
        indexObjectFormat: "sha1",
        indexVersion: 2,
        omittedProblems: 0,
        paths: ["src/a.ts"],
        problems: [],
        reason: "verified-git-index",
        source: "git-index",
      });
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  test("falls back deterministically without Git metadata and labels untracked uncertainty", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/z"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/b"), "b");
      await writeFile(workspace.resolvePath("repo/a"), "a");
      await writeFile(workspace.resolvePath("repo/z/c"), "c");

      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));

      expect(result).toMatchObject({
        certainty: "all-files-not-tracked",
        paths: ["a", "b", "z/c"],
        reason: "git-directory-missing",
        source: "filesystem-fallback",
      });
    });
  });

  test("records and skips only a per-file size refusal during filesystem fallback", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/oversized.bin"), Buffer.alloc(16_777_217));
      await writeFile(workspace.resolvePath("repo/source.ts"), "export {};\n");

      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));

      expect(result.paths).toEqual(["source.ts"]);
      expect(result.problems).toContainEqual({
        code: ReadOnlyRepositoryErrorCode.limitExceeded,
        path: "oversized.bin",
      });
    });
  });

  test("does not read a linked-worktree gitfile or external gitdir", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      await writeFile(workspace.resolvePath("repo/.git"), "gitdir: ../external/worktrees/repo\n");
      await writeFile(workspace.resolvePath("repo/file"), "content");

      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));

      expect(result).toMatchObject({
        paths: ["file"],
        reason: "git-worktree-external-metadata",
        source: "filesystem-fallback",
      });
    });
  });

  test.each([
    ["malformed", Buffer.from("not an index"), "git-index-malformed"],
    [
      "split",
      buildIndex([{ path: "tracked" }], { extensions: [{ signature: "link" }] }),
      "git-index-unsupported",
    ],
    [
      "sparse",
      buildIndex([{ path: "tracked" }], { extensions: [{ signature: "sdir" }] }),
      "git-index-unsupported",
    ],
  ] as const)("falls back for a %s index", async (_label, index, reason) => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/.git"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/.git/index"), index);
      await writeFile(workspace.resolvePath("repo/file"), "content");
      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));
      expect(result).toMatchObject({ paths: ["file"], reason, source: "filesystem-fallback" });
    });
  });

  test("falls back when the index is missing and never returns .git contents", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/.git/objects"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/.git/objects/secret"), "not content evidence");
      await writeFile(workspace.resolvePath("repo/file"), "content");
      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));
      expect(result).toMatchObject({ paths: ["file"], reason: "git-index-missing" });
    });
  });

  test("prunes non-negatable built-in directory roots during fallback", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/vendor/project/.git/objects"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/vendor/project/.git/objects/secret"), "metadata");
      await writeFile(workspace.resolvePath("repo/vendor/project/file"), "content");

      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));

      expect(result.paths).toEqual([]);
      expect(result.problems).toContainEqual({
        code: "BUILT_IN_DIRECTORY_PRUNED",
        path: "vendor",
      });
    });
  });

  test("prunes unanchored built-in directory roots inside a monorepo", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/packages/app/node_modules/dependency"), {
        recursive: true,
      });
      await writeFile(
        workspace.resolvePath("repo/packages/app/node_modules/dependency/index.js"),
        "throw new Error('must not be inspected');\n",
      );
      await writeFile(workspace.resolvePath("repo/packages/app/source.ts"), "export {};\n");

      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));

      expect(result.paths).toEqual(["packages/app/source.ts"]);
      expect(result.problems).toContainEqual({
        code: "BUILT_IN_DIRECTORY_PRUNED",
        path: "packages/app/node_modules",
      });
    });
  });

  test("does not apply directory-only built-in patterns to regular files", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/packages/app"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/packages/app/vendor"), "regular file\n");

      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));

      expect(result.paths).toEqual(["packages/app/vendor"]);
      expect(result.problems).not.toContainEqual({
        code: "BUILT_IN_DIRECTORY_PRUNED",
        path: "packages/app/vendor",
      });
    });
  });

  test("keeps a real linked worktree stable with an oversized high-entry ignored subtree", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const source = workspace.resolvePath("source");
      const linked = workspace.resolvePath("linked");
      await mkdir(source, { recursive: true });
      await execFileAsync("git", ["init", "--quiet", source]);
      await writeFile(workspace.resolvePath("source/tracked.ts"), "export {};\n");
      await execFileAsync("git", ["-C", source, "add", "."]);
      await execFileAsync("git", [
        "-C",
        source,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ]);
      await execFileAsync("git", [
        "-C",
        source,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        linked,
        "HEAD",
      ]);
      await mkdir(workspace.resolvePath("linked/node_modules/package"), { recursive: true });
      await writeFile(
        workspace.resolvePath("linked/node_modules/package/oversized.bin"),
        Buffer.alloc(16_777_217),
      );
      for (let index = 0; index < 32; index += 1)
        await writeFile(
          workspace.resolvePath(`linked/node_modules/package/file-${String(index)}.js`),
          "export {};\n",
        );

      const result = await enumerateTrackedFiles(await facade(linked), {
        maximumDirectories: 2,
        maximumFiles: 2,
      });

      expect(result).toMatchObject({
        certainty: "all-files-not-tracked",
        paths: ["tracked.ts"],
        reason: "git-worktree-external-metadata",
        source: "filesystem-fallback",
      });
      expect(result.problems).toContainEqual({
        code: "BUILT_IN_DIRECTORY_PRUNED",
        path: "node_modules",
      });
    });
  });

  test("falls back when C02 refuses an oversized index", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/.git"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/.git/index"), Buffer.alloc(1_048_577));
      await writeFile(workspace.resolvePath("repo/file"), "content");
      const selection = await selectRepositoryRoot(workspace.resolvePath("repo"), {
        mode: "explicit",
      });
      const result = await enumerateTrackedFiles(await createReadOnlyRepository(selection));
      expect(result).toMatchObject({ paths: ["file"], reason: "git-index-unsupported" });
    });
  });

  test("does not accept an index reached through an in-root symlink", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/.git"), { recursive: true });
      await writeFile(
        workspace.resolvePath("repo/.git/real-index"),
        buildIndex([{ path: "file" }]),
      );
      await symlink("real-index", workspace.resolvePath("repo/.git/index"));
      await writeFile(workspace.resolvePath("repo/file"), "content");

      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));

      expect(result).toMatchObject({ paths: ["file"], reason: "git-metadata-unsafe" });
    });
  });

  test("records a directory disappearance and deduplicates repeated directory identities", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/a"), { recursive: true });
      await mkdir(workspace.resolvePath("repo/b"), { recursive: true });
      await mkdir(workspace.resolvePath("repo/c"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/a/one"), "1");
      await writeFile(workspace.resolvePath("repo/b/two"), "2");
      await writeFile(workspace.resolvePath("repo/c/three"), "3");
      const underlying = await facade(workspace.resolvePath("repo"));
      const a = await underlying.readDirectory("a");
      const wrapped: ReadOnlyRepository = {
        inspect: (path) => underlying.inspect(path),
        limits: underlying.limits,
        readDirectory: async (path) => {
          if (path === "b") return underlying.readDirectory("missing");
          const result = await underlying.readDirectory(path);
          return path === "c" ? Object.freeze({ ...result, identity: a.identity }) : result;
        },
        readFile: (path) => underlying.readFile(path),
        root: underlying.root,
        usage: () => underlying.usage(),
      };

      const result = await enumerateTrackedFiles(wrapped);

      expect(result.paths).toEqual(["a/one"]);
      expect(result.problems).toContainEqual({
        code: "READ_ONLY_REPOSITORY_PATH_UNAVAILABLE",
        path: "b",
      });
      expect(result.problems).toContainEqual({ code: "DIRECTORY_IDENTITY_REPEATED", path: "c" });
      expect(result.omittedProblems).toBe(0);
    });
  });

  test("records finite external-link and directory-link problems without escaping", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/real"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/real/file"), "content");
      await writeFile(workspace.resolvePath("outside"), "secret");
      await symlink(workspace.resolvePath("outside"), workspace.resolvePath("repo/external"));
      await symlink(
        "real",
        workspace.resolvePath("repo/alias"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const result = await enumerateTrackedFiles(await facade(workspace.resolvePath("repo")));

      expect(result.paths).toEqual(["real/file"]);
      expect(result.problems).toEqual([
        { code: "DIRECTORY_LINK_SKIPPED", path: "alias" },
        { code: "READ_ONLY_REPOSITORY_OUTSIDE_ROOT", path: "external" },
      ]);
      const boundedProblems = await enumerateTrackedFiles(
        await facade(workspace.resolvePath("repo")),
        { maximumProblems: 1 },
      );
      expect(boundedProblems.problems).toHaveLength(1);
      expect(boundedProblems.omittedProblems).toBe(1);
    });
  });

  test("enforces fallback file/depth/directory limits", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo/a/b"), { recursive: true });
      await writeFile(workspace.resolvePath("repo/one"), "1");
      await writeFile(workspace.resolvePath("repo/two"), "2");
      const repository = await facade(workspace.resolvePath("repo"));
      await expect(enumerateTrackedFiles(repository, { maximumFiles: 1 })).rejects.toMatchObject({
        code: TrackedFileEnumerationErrorCode.limitExceeded,
      });
      const repository2 = await facade(workspace.resolvePath("repo"));
      await expect(enumerateTrackedFiles(repository2, { maximumDepth: 1 })).rejects.toMatchObject({
        code: TrackedFileEnumerationErrorCode.limitExceeded,
      });
      const repository3 = await facade(workspace.resolvePath("repo"));
      await expect(
        enumerateTrackedFiles(repository3, { maximumDirectories: 1 }),
      ).rejects.toMatchObject({ code: TrackedFileEnumerationErrorCode.limitExceeded });
    });
  });

  test("propagates cancellation instead of relabeling it as fallback uncertainty", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const controller = new AbortController();
      const repository = await facade(workspace.resolvePath("repo"), controller.signal);
      controller.abort();
      await expect(enumerateTrackedFiles(repository)).rejects.toMatchObject({
        code: "READ_ONLY_REPOSITORY_ABORTED",
      });
    });
  });

  test("propagates C02 path-change races instead of falling back", async () => {
    await withTempWorkspace({}, async (workspace) => {
      await mkdir(workspace.resolvePath("repo"));
      const underlying = await facade(workspace.resolvePath("repo"));
      const repository: ReadOnlyRepository = {
        inspect: () =>
          Promise.reject(
            new ReadOnlyRepositoryError(
              ReadOnlyRepositoryErrorCode.pathChanged,
              "fixture race",
              "inspect",
            ),
          ),
        limits: underlying.limits,
        readDirectory: (path) => underlying.readDirectory(path),
        readFile: (path) => underlying.readFile(path),
        root: underlying.root,
        usage: () => underlying.usage(),
      };

      await expect(enumerateTrackedFiles(repository)).rejects.toMatchObject({
        code: ReadOnlyRepositoryErrorCode.pathChanged,
      });
    });
  });
});
