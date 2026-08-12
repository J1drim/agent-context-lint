import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalTrackedPaths,
  packageManagerInvocation,
  workspaceSnapshot,
} from "./test-github-action-clean-install.mjs";

test("clean install uses exact cross-platform frozen no-runtime commands", () => {
  assert.deepEqual(packageManagerInvocation("linux"), {
    arguments: ["install", "--frozen-lockfile", "--no-runtime"],
    executable: "pnpm",
  });
  assert.deepEqual(packageManagerInvocation("win32"), {
    arguments: ["/d", "/s", "/c", "pnpm.cmd install --frozen-lockfile --no-runtime"],
    executable: "cmd.exe",
  });
  assert.throws(() => packageManagerInvocation("aix"), /unsupported clean-install platform/u);
});

test("clean-install tracked inventory rejects malformed, duplicate, and escaping paths", () => {
  assert.deepEqual(canonicalTrackedPaths(Buffer.from("z.txt\0a/b.txt\0")), ["a/b.txt", "z.txt"]);
  for (const source of [
    "",
    "a.txt",
    "../a.txt\0",
    "/a.txt\0",
    "a\\b.txt\0",
    "a//b.txt\0",
    "a.txt\0a.txt\0",
    "a\nb.txt\0",
  ])
    assert.throws(() => canonicalTrackedPaths(Buffer.from(source)), /clean-install action test/u);
  assert.throws(
    () => canonicalTrackedPaths(Buffer.from([0xff, 0x00])),
    /clean-install action test/u,
  );
});

test("workspace snapshots bind source bytes and untracked inventory everywhere", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clean-install-snapshot-"));
  try {
    await mkdir(path.join(root, "source"));
    await writeFile(path.join(root, "source", "tracked.txt"), "one\n", { flag: "wx" });
    const initial = await workspaceSnapshot(root);
    await writeFile(path.join(root, "source", "tracked.txt"), "two\n");
    assert.notEqual(await workspaceSnapshot(root), initial);
    await writeFile(path.join(root, "source", "tracked.txt"), "one\n");
    await writeFile(path.join(root, "source", "untracked.txt"), "new\n", { flag: "wx" });
    assert.notEqual(await workspaceSnapshot(root), initial);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test(
  "workspace snapshots bind POSIX mode changes where chmod is meaningful",
  { skip: process.platform === "win32" ? "Windows does not expose POSIX chmod semantics" : false },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clean-install-mode-snapshot-"));
    try {
      const target = path.join(root, "tracked.txt");
      await writeFile(target, "one\n", { flag: "wx", mode: 0o644 });
      await chmod(target, 0o644);
      const initial = await workspaceSnapshot(root);
      await chmod(target, 0o755);
      assert.notEqual(await workspaceSnapshot(root), initial);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);
