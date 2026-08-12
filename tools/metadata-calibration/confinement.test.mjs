import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDarwinConfinementFactory,
  darwinBuildProfileTemplate,
  darwinPhasePolicySha256,
  normalizedDarwinPhasePolicy,
  workspaceBuildGraph,
} from "./confinement.mjs";
import { runBoundedCommand } from "./execute.mjs";
import {
  inspectNativeBuildGraph,
  inspectNativeToolchain,
  pnpmInventoryChildSha256,
} from "./native-toolchain.mjs";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

test("Darwin build profile denies network, writes, and arbitrary executable children", () => {
  const profile = darwinBuildProfileTemplate("/opt/reviewed/node");
  assert.match(profile, /\(deny network\*\)/u);
  assert.match(profile, /\(deny process-exec\*\)/u);
  assert.match(profile, /\(deny file-write\*\)/u);
  assert.match(profile, /literal "\/opt\/reviewed\/node"/u);
  assert.doesNotMatch(profile, /usr\/bin\/curl/u);
  assert.match(profile, /__K03_WORKSPACE__/u);
  assert.match(profile, /__K03_TEMPORARY__/u);
});

test("normalized phase policies bind complete sorted executable allowlists", () => {
  const options = {
    allowedExecutables: ["/work/node_modules/.bin/tsc", "/work/node_modules/.bin/esbuild"],
    helperExecutables: ["/usr/bin/env", "/bin/sh"],
    nodeExecutable: "/work/node_modules/node/bin/node",
    temporaryRoot: "/temporary",
    workspaceRoot: "/work",
  };
  const normalized = normalizedDarwinPhasePolicy(options);
  assert.match(normalized, /literal "\/work\/node_modules\/node\/bin\/node"/u);
  assert.match(normalized, /__K03_WORKSPACE__\/node_modules\/.bin\/esbuild/u);
  assert.match(normalized, /__K03_WORKSPACE__\/node_modules\/.bin\/tsc/u);
  assert.equal(
    darwinPhasePolicySha256(options),
    darwinPhasePolicySha256({
      ...options,
      allowedExecutables: [...options.allowedExecutables].reverse(),
      helperExecutables: [...options.helperExecutables].reverse(),
    }),
  );
  assert.notEqual(
    darwinPhasePolicySha256(options),
    darwinPhasePolicySha256({ ...options, allowedExecutables: [] }),
  );
  assert.equal(
    darwinPhasePolicySha256(options),
    darwinPhasePolicySha256({
      ...options,
      allowedExecutables: options.allowedExecutables.map((entry) =>
        entry.replace("/work/", "/clean-replay/"),
      ),
      workspaceRoot: "/clean-replay",
    }),
  );
});

test("workspace graph resolves distinct canonical owners in the actual pnpm layout", async () => {
  const [workspace, inspected] = await Promise.all([
    workspaceBuildGraph(repositoryRoot),
    inspectNativeBuildGraph(repositoryRoot),
  ]);
  assert.equal(
    workspace.typescriptPackageManifest,
    inspected.buildTools.typescriptPackageManifest.path,
  );
  assert.equal(workspace.esbuildPackageManifest, inspected.buildTools.esbuildPackageManifest.path);
  assert.notEqual(workspace.typescriptPackageManifest, workspace.esbuildPackageManifest);
  assert.match(workspace.typescriptPackageManifest, /node_modules\/.pnpm\//u);
  assert.match(workspace.esbuildPackageManifest, /node_modules\/.pnpm\//u);
  assert.equal(
    workspace.typescriptEntry.startsWith(path.dirname(workspace.typescriptPackageManifest)),
    true,
  );
  assert.equal(
    workspace.esbuildEntry.startsWith(path.dirname(workspace.esbuildPackageManifest)),
    true,
  );
});

test("Darwin factory verifies the complete actual pnpm-layout pack graph", async (t) => {
  if (process.platform !== "darwin" || typeof process.env.npm_execpath !== "string") return;
  const temporaryRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "k03-confinement-factory-")),
  );
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const canonicalRoot = await realpath(repositoryRoot);
  const pnpmLauncher = path.join(path.dirname(process.env.npm_execpath), "pnpm.mjs");
  const graph = await inspectNativeBuildGraph(canonicalRoot);
  const inventoryChildSha256 = await pnpmInventoryChildSha256();
  const identity = async (toolPath) => ({
    path: await realpath(toolPath),
    sha256: createHash("sha256")
      .update(await readFile(await realpath(toolPath)))
      .digest("hex"),
    version: "reviewed-system-tool",
  });
  const [sandboxExec, bash, sh, env, dirname, sed, uname] = await Promise.all([
    identity("/usr/bin/sandbox-exec"),
    identity("/bin/bash"),
    identity("/bin/sh"),
    identity("/usr/bin/env"),
    identity("/usr/bin/dirname"),
    identity("/usr/bin/sed"),
    identity("/usr/bin/uname"),
  ]);
  const capability = await runBoundedCommand(
    sandboxExec.path,
    ["-p", "(version 1) (allow default)", "--", graph.node.path, "--version"],
    {
      cwd: temporaryRoot,
      environment: { HOME: temporaryRoot, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
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
    t.skip("managed runner denies native sandbox-exec factory verification");
    return;
  }
  assert.equal(capability.status, 0, capability.stderr);
  assert.equal(capability.signal, null);
  let confinementProbe = 0;
  const command = async (executable, arguments_, options) => {
    assert.equal(executable, "/usr/bin/sandbox-exec");
    assert.equal(arguments_[0], "-p");
    assert.equal(arguments_[2], "--");
    const target = arguments_[3];
    const targetArguments = arguments_.slice(4);
    if (targetArguments[0]?.endsWith("/pnpm-inventory.mjs"))
      return runBoundedCommand(target, targetArguments, options);
    confinementProbe += 1;
    if (confinementProbe >= 2 && confinementProbe <= 6)
      return { signal: null, status: 1, stderr: "", stdout: "" };
    return runBoundedCommand(target, targetArguments, options);
  };
  const toolchain = await inspectNativeToolchain(canonicalRoot, pnpmLauncher, {
    inventoryChildSha256,
    nodeExecutable: graph.node.path,
    nodeSha256: graph.node.sha256,
    sandboxExecutable: "/usr/bin/sandbox-exec",
    sandboxSha256: sandboxExec.sha256,
  });
  const helperExecutables = [bash.path, sh.path, env.path, dirname.path, sed.path, uname.path];
  const executableNames = [
    "esbuildEntry",
    "esbuildLauncher",
    "esbuildPlatformBinary",
    "typescriptCompiler",
    "typescriptEntry",
    "typescriptLauncher",
  ];
  const nativeProof = {
    buildTools: toolchain.buildTools,
    confinement: {
      inventoryChildSha256,
      phasePolicySha256: {
        pack: darwinPhasePolicySha256({
          allowedExecutables: executableNames.map((name) => toolchain.buildTools[name].path),
          helperExecutables,
          nodeExecutable: toolchain.node.path,
          temporaryRoot,
          workspaceRoot: canonicalRoot,
        }),
      },
    },
    runner: { platform: "darwin" },
    status: "ready",
    tools: {
      bash,
      dirname,
      env,
      node: toolchain.node,
      pnpm: toolchain.pnpm,
      sandboxExec,
      sed,
      sh,
      uname,
    },
  };
  const createConfinement = createDarwinConfinementFactory({
    command,
    environment: {
      HOME: temporaryRoot,
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      TMPDIR: temporaryRoot,
    },
    nativeProof,
    nodeExecutable: toolchain.node.path,
    temporaryRoot,
  });
  const confinement = await createConfinement(canonicalRoot, "pack");
  await confinement.verifyAfter();
});

test("Darwin confinement factory never accepts a pending or absent native proof", () => {
  assert.throws(
    () =>
      createDarwinConfinementFactory({
        environment: {},
        nativeProof: { status: "feature-unavailable" },
        nodeExecutable: process.execPath,
        temporaryRoot: "/tmp/k03-confinement-fixture",
      }),
    /feature-unavailable outside Darwin|validated native Darwin proof/u,
  );
});
