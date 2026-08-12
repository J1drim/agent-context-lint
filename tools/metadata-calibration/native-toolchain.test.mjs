import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBoundedCommand } from "./execute.mjs";
import {
  darwinPnpmInventoryPolicy,
  inspectNativeBuildGraph,
  inspectNativeToolchain,
  inspectPnpmLauncherIdentity,
  inspectPnpmLauncherIdentityWithManifestBoundariesForTests,
  inspectPnpmLauncherIdentityWithManifestReadBoundaryForTests,
  inspectPnpmRuntimePackageSandboxed,
  pnpmInventoryChildSha256,
  runWithStableFileAuthorities,
} from "./native-toolchain.mjs";
import { inspectPnpmRuntimePackage } from "./pnpm-inventory.mjs";
import { createPnpmRuntimeSnapshotPair } from "./pnpm-snapshot.mjs";

const repositoryRoot = new URL("../..", import.meta.url).pathname;
const inventoryChild = new URL("./pnpm-inventory.mjs", import.meta.url).pathname;

test("pnpm inventory policy admits only literal traversal ancestors", () => {
  const policy = darwinPnpmInventoryPolicy(
    "/private/var/calibration/pnpm",
    "/private/var/toolchain/node/bin/node",
    ["/private/var/snapshots/runtime-a", "/private/var/snapshots/runtime-b"],
    "/private/var/tools/pnpm-inventory.mjs",
  );
  for (const ancestor of ["/", "/private", "/private/var", "/private/var/snapshots"])
    assert.ok(policy.includes(`(allow file-read* (literal "${ancestor}"))`), ancestor);
  assert.equal(policy.includes('(subpath "/private/var/snapshots")'), false);
  assert.ok(policy.includes('(subpath "/private/var/snapshots/runtime-a")'));
  assert.ok(policy.includes('(literal "/private/var/tools/pnpm-inventory.mjs")'));
});

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

test("installed build graph binds and executes the frozen native packages", async () => {
  const graph = await inspectNativeBuildGraph(repositoryRoot);
  assert.equal(graph.node.version, "24.18.1");
  assert.deepEqual(Object.keys(graph.buildTools), [
    "esbuildEntry",
    "esbuildLauncher",
    "esbuildPackageManifest",
    "esbuildPlatformBinary",
    "esbuildPlatformManifest",
    "typescriptCompiler",
    "typescriptEntry",
    "typescriptLauncher",
    "typescriptPackageManifest",
    "typescriptPlatformManifest",
    "typescriptResolver",
    "typescriptRuntimeEntry",
  ]);
  for (const [name, { sha256, version }] of Object.entries(graph.buildTools)) {
    assert.match(sha256, /^[0-9a-f]{64}$/u, name);
    assert.equal(version, name.startsWith("esbuild") ? "0.28.1" : "7.0.2", name);
  }
  for (const name of [
    "esbuildLauncher",
    "esbuildPlatformBinary",
    "typescriptCompiler",
    "typescriptLauncher",
  ]) {
    const tool = graph.buildTools[name];
    const result = await runBoundedCommand(tool.path, ["--version"], {
      cwd: repositoryRoot,
      environment: { HOME: repositoryRoot, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maximumStderrBytes: 4096,
      maximumStdoutBytes: 4096,
      timeoutMs: 30_000,
    });
    assert.equal(result.signal, null, name);
    assert.equal(result.status, 0, result.stderr || name);
    assert.equal(result.stdout.trim().replace(/^Version /u, ""), tool.version, name);
  }
  const entry = graph.buildTools.typescriptEntry;
  const entryResult = await runBoundedCommand(graph.node.path, [entry.path, "--version"], {
    cwd: repositoryRoot,
    environment: { HOME: repositoryRoot, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maximumStderrBytes: 4096,
    maximumStdoutBytes: 4096,
    timeoutMs: 30_000,
  });
  assert.equal(entryResult.signal, null);
  assert.equal(entryResult.status, 0, entryResult.stderr);
  assert.equal(entryResult.stdout.trim(), `Version ${entry.version}`);
  const esbuildEntry = graph.buildTools.esbuildEntry;
  const esbuildEntryResult = await runBoundedCommand(esbuildEntry.path, ["--version"], {
    cwd: repositoryRoot,
    environment: { HOME: repositoryRoot, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maximumStderrBytes: 4096,
    maximumStdoutBytes: 4096,
    timeoutMs: 30_000,
  });
  assert.equal(esbuildEntryResult.signal, null);
  assert.equal(esbuildEntryResult.status, 0, esbuildEntryResult.stderr);
  assert.equal(esbuildEntryResult.stdout.trim(), esbuildEntry.version);
});

test("pnpm runtime identity binds worker, built-in configuration, and transitive package files", async () => {
  const inherited = process.env.npm_execpath;
  if (typeof inherited !== "string" || !path.isAbsolute(inherited)) return;
  const packageRoot = path.dirname(path.dirname(realpathSync(inherited)));
  const temporary = await mkdtemp(path.join(os.tmpdir(), "k03-pnpm-runtime-"));
  const copiedPath = path.join(temporary, "pnpm");
  await cp(packageRoot, copiedPath, { recursive: true });
  const copied = await realpath(copiedPath);
  const before = await inspectPnpmRuntimePackage(copied, "11.18.0");
  await appendFile(path.join(copied, "dist/worker.js"), "\n// adversarial mutation\n");
  const afterWorker = await inspectPnpmRuntimePackage(copied, "11.18.0");
  assert.notEqual(afterWorker.sha256, before.sha256);
  await appendFile(path.join(copied, "dist/pnpmrc"), "\nfetch-retries=99\n");
  const afterConfig = await inspectPnpmRuntimePackage(copied, "11.18.0");
  assert.notEqual(afterConfig.sha256, afterWorker.sha256);
  const reflink = path.join(copied, "dist/node_modules/@reflink/reflink/binding.js");
  if (existsSync(reflink)) {
    await appendFile(reflink, "\n// adversarial mutation\n");
    assert.notEqual(
      (await inspectPnpmRuntimePackage(copied, "11.18.0")).sha256,
      afterConfig.sha256,
    );
  }
});

test("pnpm snapshot acquisition rejects a changing ordinary-file content fixed point", async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "k03-pnpm-fixed-point-")));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const runtime = path.join(temporary, "runtime.js");
  await writeFile(runtime, "export const value = 1;\n");
  await assert.rejects(
    inspectPnpmRuntimePackage(temporary, "11.18.0", {
      afterFirstSnapshot: () => appendFile(runtime, "export const changed = true;\n"),
    }),
    /content fixed point/u,
  );
});

test("confined pnpm traversal never reads a queued symlink into an allowed outside tree", async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "k03-pnpm-swap-")));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const packageRoot = path.join(temporary, "package");
  const nested = path.join(packageRoot, "nested");
  const heldNested = path.join(temporary, "nested-held");
  const reviewedNode = (await inspectNativeBuildGraph(repositoryRoot)).node.path;
  const outside = path.dirname(path.dirname(reviewedNode));
  await mkdir(packageRoot);
  await mkdir(nested);
  await writeFile(path.join(packageRoot, "package.json"), '{"name":"pnpm"}\n');
  await writeFile(path.join(nested, "runtime.js"), "export {};\n");
  const reads = [];
  try {
    const observed = await inspectPnpmRuntimePackage(packageRoot, "11.18.0", {
      afterRootEnqueue: async () => {
        await rename(nested, heldNested);
        await symlink(outside, nested);
      },
      fileReadObserver: ({ absolute }) => reads.push(absolute),
    });
    assert.equal(observed.path, packageRoot);
  } finally {
    if ((await lstat(nested)).isSymbolicLink()) await rm(nested);
    await rename(heldNested, nested);
  }
  assert.equal(
    reads.some((entry) => entry.startsWith(`${outside}${path.sep}`)),
    false,
  );
  assert.equal(
    reads.every((entry) => entry.includes("svetovid-pnpm-snapshot-")),
    true,
  );
});

test("actual sandbox-exec denies an active queued pnpm inventory escape when available", async (t) => {
  if (process.platform !== "darwin") return;
  const reviewedNode = (await inspectNativeBuildGraph(repositoryRoot)).node.path;
  const capability = await runBoundedCommand(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1) (allow default)", "--", reviewedNode, "--version"],
    {
      cwd: os.tmpdir(),
      environment: { HOME: os.tmpdir(), LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maximumStderrBytes: 4096,
      maximumStdoutBytes: 4096,
      timeoutMs: 30_000,
    },
  );
  if (
    capability.status === 71 &&
    capability.signal === null &&
    capability.stderr === "sandbox-exec: sandbox_apply: Operation not permitted\n"
  ) {
    t.skip("managed runner denies nested sandbox-exec; native Darwin proof remains unavailable");
    return;
  }
  assert.equal(capability.status, 0, capability.stderr);
  assert.equal(capability.signal, null);

  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "k03-pnpm-native-swap-")));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const packageRoot = path.join(temporary, "package");
  const nested = path.join(packageRoot, "nested");
  const heldNested = path.join(temporary, "nested-held");
  const outside = path.dirname(path.dirname(reviewedNode));
  await mkdir(packageRoot);
  await mkdir(nested);
  await writeFile(path.join(packageRoot, "package.json"), '{"name":"pnpm"}\n');
  await writeFile(path.join(nested, "runtime.js"), "export {};\n");
  const snapshot = await createPnpmRuntimeSnapshotPair(packageRoot);
  t.after(() => snapshot.remove());
  let mutationObserved = false;
  const policy = darwinPnpmInventoryPolicy(packageRoot, reviewedNode, snapshot.paths);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", policy, "--", reviewedNode, inventoryChild, packageRoot, ...snapshot.paths, "11.18.0"],
      {
        cwd: packageRoot,
        env: { HOME: packageRoot, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    let mutation = Promise.resolve();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      if (!mutationObserved && Buffer.concat(stderr).includes("K03_PNPM_INVENTORY_READY\n")) {
        mutationObserved = true;
        mutation = (async () => {
          await rename(nested, heldNested);
          await symlink(outside, nested);
          child.stdin.end("GO\n");
        })();
        mutation.catch(reject);
      }
    });
    child.once("error", reject);
    child.once("close", async (status, signal) => {
      try {
        await mutation;
        if (mutationObserved) {
          await rm(nested);
          await rename(heldNested, nested);
        }
        resolve({
          signal,
          status,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
  assert.equal(mutationObserved, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(JSON.parse(result.stdout).path, packageRoot);

  const graph = await inspectNativeBuildGraph(repositoryRoot);
  const authoritative = await inspectPnpmRuntimePackageSandboxed(packageRoot, "11.18.0", {
    inventoryChildSha256: await pnpmInventoryChildSha256(),
    nodeExecutable: graph.node.path,
    nodeSha256: graph.node.sha256,
    sandboxExecutable: "/usr/bin/sandbox-exec",
    sandboxSha256: await sha256("/usr/bin/sandbox-exec"),
  });
  assert.equal(authoritative.path, packageRoot);
  assert.match(authoritative.sha256, /^[0-9a-f]{64}$/u);
});

test("pnpm launcher is accepted only when its package identity is exactly 11.18.0", async () => {
  const inherited = process.env.npm_execpath;
  const executable =
    typeof inherited === "string" && path.isAbsolute(inherited)
      ? inherited
      : (process.env.PATH ?? "")
          .split(path.delimiter)
          .map((directory) => path.join(directory, "pnpm"))
          .find(existsSync);
  assert.notEqual(executable, undefined, "host pnpm launcher is unavailable");
  const resolved = realpathSync(executable);
  const launcher = path.join(path.dirname(resolved), "pnpm.mjs");
  const identity = await inspectPnpmLauncherIdentity(launcher);
  if (identity.version === "11.18.0") {
    assert.equal(identity.path, launcher);
    await assert.rejects(
      inspectNativeToolchain(repositoryRoot, launcher),
      /exact proof-bound pnpm inventory sandbox/u,
    );
    await assert.rejects(
      inspectPnpmLauncherIdentity(path.join(path.dirname(launcher), "pnpm.cjs")),
      /bin\.pnpm mapping does not resolve exactly/u,
    );
  } else {
    assert.notEqual(identity.version, "11.18.0");
    await assert.rejects(
      inspectNativeToolchain(repositoryRoot, launcher),
      /pnpm JavaScript launcher differs from the packageManager identity/u,
    );
  }
});

test("authoritative pnpm inventory rejects injected output, zero digests, and Node ABA", async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "k03-pnpm-authority-")));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const packageRoot = path.join(temporary, "package");
  await mkdir(packageRoot);
  await writeFile(path.join(packageRoot, "package.json"), '{"name":"pnpm"}\n');
  const graph = await inspectNativeBuildGraph(repositoryRoot);
  const exact = {
    inventoryChildSha256: await pnpmInventoryChildSha256(),
    nodeExecutable: graph.node.path,
    nodeSha256: graph.node.sha256,
    sandboxExecutable: "/usr/bin/sandbox-exec",
    sandboxSha256: await sha256("/usr/bin/sandbox-exec"),
  };
  await assert.rejects(
    inspectPnpmRuntimePackageSandboxed(packageRoot, "11.18.0", {
      ...exact,
      command: async () => ({
        signal: null,
        status: 0,
        stderr: "K03_PNPM_INVENTORY_READY\n",
        stdout: `${JSON.stringify({ path: packageRoot, sha256: "0".repeat(64), version: "11.18.0" })}\n`,
      }),
    }),
    /options are not closed/u,
  );
  await assert.rejects(
    inspectPnpmRuntimePackageSandboxed(packageRoot, "11.18.0", {
      ...exact,
      nodeSha256: "0".repeat(64),
    }),
    /authority digest or identity differs/u,
  );

  const mutableNode = path.join(temporary, "node");
  const heldNode = path.join(temporary, "node-held");
  await cp(graph.node.path, mutableNode);
  const snapshot = await createPnpmRuntimeSnapshotPair(packageRoot);
  t.after(() => snapshot.remove());
  let readyBoundaryReached = false;
  await assert.rejects(
    runWithStableFileAuthorities(
      [{ label: "fixture Node", path: mutableNode, sha256: await sha256(mutableNode) }],
      ([immutableNode]) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            immutableNode,
            [inventoryChild, packageRoot, ...snapshot.paths, "11.18.0"],
            {
              cwd: packageRoot,
              env: { HOME: packageRoot, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          const stderr = [];
          let mutation = Promise.resolve();
          child.stderr.on("data", (chunk) => {
            stderr.push(chunk);
            if (
              !readyBoundaryReached &&
              Buffer.concat(stderr).includes("K03_PNPM_INVENTORY_READY\n")
            ) {
              readyBoundaryReached = true;
              mutation = (async () => {
                await rename(mutableNode, heldNode);
                await writeFile(mutableNode, "replacement node bytes\n", { mode: 0o700 });
                await rm(mutableNode);
                await rename(heldNode, mutableNode);
                child.stdin.end("GO\n");
              })();
              mutation.catch(reject);
            }
          });
          child.once("error", reject);
          child.once("close", async (status, signal) => {
            try {
              await mutation;
              resolve({ signal, status });
            } catch (error) {
              reject(error);
            }
          });
        }),
    ),
    (error) =>
      error instanceof AggregateError &&
      error.message === "sandbox execution authority changed and its result was rejected" &&
      error.errors.some(
        (entry) =>
          entry instanceof Error &&
          entry.message ===
            "fixture Node authority path component 6 changed during sandbox execution",
      ),
  );
  assert.equal(readyBoundaryReached, true);
});

test("file authorities reject a transient grandparent tree substitution before pathname spawn", async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "k03-tree-authority-")));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const graph = await inspectNativeBuildGraph(repositoryRoot);
  const grandparent = path.join(temporary, "authority-tree");
  const heldGrandparent = path.join(temporary, "authority-tree-held");
  const executable = path.join(grandparent, "nested", "node");
  const hostileMarker = path.join(temporary, "hostile-ran");
  await mkdir(path.dirname(executable), { recursive: true });
  await cp(graph.node.path, executable);

  await assert.rejects(
    runWithStableFileAuthorities(
      [{ label: "tree fixture Node", path: executable, sha256: await sha256(executable) }],
      async ([immutableNode]) => {
        await rename(grandparent, heldGrandparent);
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, `#!/bin/sh\nprintf hostile > '${hostileMarker}'\n`, {
          mode: 0o700,
        });
        const result = await runBoundedCommand(immutableNode, ["--version"], {
          cwd: path.dirname(executable),
          environment: { HOME: temporary, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
          maximumStderrBytes: 4096,
          maximumStdoutBytes: 4096,
          timeoutMs: 30_000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(hostileMarker), false);
        await rm(grandparent, { recursive: true });
        await rename(heldGrandparent, grandparent);
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.message === "sandbox execution authority changed and its result was rejected" &&
      error.errors.some(
        (entry) =>
          entry instanceof Error &&
          entry.message ===
            "tree fixture Node authority path component 6 changed during sandbox execution",
      ),
  );
});

test("file authorities tolerate unrelated shared-parent directory activity", async (t) => {
  const graph = await inspectNativeBuildGraph(repositoryRoot);
  const sharedParent = "/private/tmp";
  const authorityRoot = await mkdtemp(path.join(sharedParent, "k03-shared-authority-"));
  t.after(() => rm(authorityRoot, { force: true, recursive: true }));
  const resolvedNode = path.join(authorityRoot, "node");
  await cp(graph.node.path, resolvedNode);
  await runWithStableFileAuthorities(
    [
      {
        label: "shared-parent fixture Node",
        path: resolvedNode,
        sha256: await sha256(resolvedNode),
      },
    ],
    async ([immutableNode]) => {
      const unrelated = await mkdtemp(path.join(sharedParent, "k03-unrelated-shared-parent-"));
      try {
        const result = await runBoundedCommand(immutableNode, ["--version"], {
          cwd: repositoryRoot,
          environment: { HOME: repositoryRoot, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
          maximumStderrBytes: 4096,
          maximumStdoutBytes: 4096,
          timeoutMs: 30_000,
        });
        assert.equal(result.status, 0, result.stderr);
      } finally {
        await rm(unrelated, { recursive: true });
      }
    },
  );
});

test("pnpm owner rejects decoy package boundaries and mismatched bin paths", async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "k03-pnpm-owner-")));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const decoy = path.join(temporary, "decoy");
  await mkdir(path.join(decoy, "bin"), { recursive: true });
  await writeFile(
    path.join(decoy, "package.json"),
    JSON.stringify({ bin: { pnpm: "bin/pnpm.mjs" }, main: "bin/pnpm.mjs", name: "decoy" }),
  );
  await writeFile(path.join(decoy, "bin/pnpm.mjs"), "export {};\n");
  await assert.rejects(
    inspectPnpmLauncherIdentity(path.join(decoy, "bin/pnpm.mjs")),
    /decoy package boundary/u,
  );

  const mismatch = path.join(temporary, "mismatch");
  await mkdir(path.join(mismatch, "bin"), { recursive: true });
  await mkdir(path.join(mismatch, "dist"));
  await writeFile(
    path.join(mismatch, "package.json"),
    JSON.stringify({
      bin: { pnpm: "dist/pnpm.mjs" },
      exports: { ".": "./package.json" },
      main: "dist/pnpm.mjs",
      name: "pnpm",
      version: "11.18.0",
    }),
  );
  await writeFile(path.join(mismatch, "bin/pnpm.cjs"), "import('./pnpm.mjs')\n");
  await writeFile(path.join(mismatch, "bin/pnpm.mjs"), "export {};\n");
  await writeFile(path.join(mismatch, "dist/pnpm.mjs"), "export {};\n");
  await assert.rejects(
    inspectPnpmLauncherIdentity(path.join(mismatch, "dist/pnpm.mjs")),
    /closed canonical launcher mapping/u,
  );

  for (const [name, setup, pattern] of [
    [
      "malformed",
      async (candidate) => writeFile(candidate, '{"name":"pnpm",'),
      /valid unique-key UTF-8 JSON/u,
    ],
    [
      "duplicate-key",
      async (candidate) =>
        writeFile(candidate, '{"name":"pnpm","name":"decoy","version":"11.18.0"}'),
      /valid unique-key UTF-8 JSON/u,
    ],
    [
      "invalid-utf8",
      async (candidate) => writeFile(candidate, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])),
      /valid unique-key UTF-8 JSON/u,
    ],
    ["directory", async (candidate) => mkdir(candidate), /hostile pnpm package boundary/u],
    [
      "broken-symlink",
      async (candidate) => symlink(path.join(temporary, "missing-manifest"), candidate),
      /hostile pnpm package boundary/u,
    ],
  ]) {
    const outer = path.join(temporary, `nearest-${name}`);
    const inner = path.join(outer, "inner");
    const launcher = path.join(inner, "bin/pnpm.mjs");
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(
      path.join(outer, "package.json"),
      JSON.stringify({ name: "pnpm", version: "11.18.0" }),
    );
    await writeFile(launcher, "export {};\n");
    await setup(path.join(inner, "package.json"));
    await assert.rejects(inspectPnpmLauncherIdentity(launcher), pattern, name);
  }

  const racing = path.join(temporary, "identity-race");
  const racingManifest = path.join(racing, "package.json");
  const racingLauncher = path.join(racing, "bin/pnpm.mjs");
  await mkdir(path.dirname(racingLauncher), { recursive: true });
  await mkdir(path.join(racing, "dist"));
  await writeFile(
    racingManifest,
    JSON.stringify({
      bin: { pnpm: "bin/pnpm.mjs" },
      exports: { ".": "./package.json" },
      main: "bin/pnpm.mjs",
      name: "pnpm",
      version: "11.18.0",
    }),
  );
  await writeFile(path.join(racing, "bin/pnpm.cjs"), "import('./pnpm.mjs');\n");
  await writeFile(racingLauncher, "export {};\n");
  await writeFile(path.join(racing, "dist/pnpm.mjs"), "export {};\n");
  await assert.rejects(
    inspectPnpmLauncherIdentityWithManifestReadBoundaryForTests(racingLauncher, () =>
      appendFile(racingManifest, " "),
    ),
    /changed while reading/u,
  );

  const manifestBytes = await readFile(racingManifest);
  const preOpenHeld = path.join(racing, "package.pre-open.json");
  try {
    await assert.rejects(
      inspectPnpmLauncherIdentityWithManifestBoundariesForTests(racingLauncher, {
        beforeOpen: async () => {
          await rename(racingManifest, preOpenHeld);
          await writeFile(racingManifest, manifestBytes);
        },
      }),
      /changed while opening/u,
    );
  } finally {
    if (existsSync(preOpenHeld)) {
      await rm(racingManifest, { force: true });
      await rename(preOpenHeld, racingManifest);
    }
  }

  const postOpenHeld = path.join(racing, "package.post-open.json");
  try {
    await assert.rejects(
      inspectPnpmLauncherIdentityWithManifestBoundariesForTests(racingLauncher, {
        afterRead: async () => {
          await rename(racingManifest, postOpenHeld);
          await writeFile(racingManifest, manifestBytes);
        },
      }),
      /changed while reading/u,
    );
  } finally {
    if (existsSync(postOpenHeld)) {
      await rm(racingManifest, { force: true });
      await rename(postOpenHeld, racingManifest);
    }
  }
});
