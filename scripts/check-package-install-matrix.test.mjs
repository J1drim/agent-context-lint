import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertInstalledRuntime,
  assertNoWorkspaceBacklinks,
  nodeRuntimeSatisfiesReleaseRange,
  PACKAGE_MANAGER_NAMES,
  parsePackageManagerSelection,
  resolveConfiguredExecutable,
  runPackageInstallMatrix,
  runPackageManagerInstall,
} from "./check-package-install-matrix.mjs";

const EXACT_NODE = path.resolve("node_modules/node/bin/node");
const EXACT_NODE_VERSION = "v24.18.1";

async function fixtureRoot(prefix = "agent-context-package-matrix-test-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeInstalledRuntime(root, version = "1.0.0") {
  const coreRoot = path.join(root, "node_modules/@agent-context/core");
  const cliRoot = path.join(root, "node_modules/@agent-context/lint");
  await mkdir(path.join(coreRoot, "dist"), { recursive: true });
  await mkdir(path.join(cliRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(coreRoot, "package.json"),
    JSON.stringify({ name: "@agent-context/core", version, license: "Apache-2.0" }),
  );
  await writeFile(
    path.join(cliRoot, "package.json"),
    JSON.stringify({
      name: "@agent-context/lint",
      version,
      license: "Apache-2.0",
      dependencies: { "@agent-context/core": version },
    }),
  );
  const entry = path.join(cliRoot, "dist/cli.js");
  await writeFile(entry, '#!/usr/bin/env node\nprocess.stdout.write("1.0.0\\n");\n');
  await chmod(entry, 0o755);
}

test("release Node range is checked without accepting unsupported runtimes", () => {
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v24.11.0"), true);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v24.18.1"), true);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v26.0.0"), true);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v26.3.0"), true);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v24.10.0"), false);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v25.0.0"), false);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v22.14.0"), false);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v26.0.0-rc.1"), false);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v24.18.1-nightly"), false);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v26.3.0+build.1"), true);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("not-a-node"), false);
});

test("package-manager selection is closed and deterministic", () => {
  assert.deepEqual(parsePackageManagerSelection(), PACKAGE_MANAGER_NAMES);
  assert.deepEqual(parsePackageManagerSelection("bun, npm"), ["bun", "npm"]);
  assert.throws(() => parsePackageManagerSelection("npm,npm"), /at most once/u);
  assert.throws(() => parsePackageManagerSelection("cargo"), /unsupported package manager/u);
  assert.throws(() => parsePackageManagerSelection(""), /requires npm/u);
});

test("manager executable configuration never falls back to PATH", () => {
  assert.equal(resolveConfiguredExecutable("npm", {}), null);
  assert.equal(
    resolveConfiguredExecutable("npm", { AGENT_CONTEXT_PACK_NPM: "/tmp/npm" }),
    "/tmp/npm",
  );
  assert.throws(
    () => resolveConfiguredExecutable("npm", { AGENT_CONTEXT_PACK_NPM: "npm" }),
    /absolute executable path/u,
  );
});

test("malformed configured manager paths become a stable redacted failure", async () => {
  const root = await fixtureRoot("agent-context-package-matrix-invalid-config-");
  try {
    const privateMarker = path.join(root, "private-manager-path");
    const result = await runPackageManagerInstall("npm", {
      environment: { AGENT_CONTEXT_PACK_NPM: privateMarker },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
    });
    assert.deepEqual(result, {
      manager: "npm",
      runtime: "node",
      nodeVersion: EXACT_NODE_VERSION,
      reason: "invalid-node-launcher",
      state: "failed",
    });
    assert.equal(JSON.stringify(result).includes(privateMarker), false);

    const relative = await runPackageManagerInstall("npm", {
      environment: { AGENT_CONTEXT_PACK_NPM: "npm" },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
    });
    assert.deepEqual(relative, {
      manager: "npm",
      runtime: "node",
      nodeVersion: EXACT_NODE_VERSION,
      reason: "invalid-executable",
      state: "failed",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("unsupported Node blocks every manager before executable discovery", async () => {
  for (const manager of PACKAGE_MANAGER_NAMES) {
    const result = await runPackageManagerInstall(manager, { nodeVersion: "v22.14.0" });
    assert.deepEqual(result, {
      manager,
      runtime: manager === "bun" ? "native" : "node",
      state: "blocked",
      reason: "node-engine-mismatch",
      nodeVersion: "v22.14.0",
    });
  }
});

test("pnpm configuration retains the exact JavaScript-launcher release boundary", async () => {
  const root = await fixtureRoot();
  try {
    const shim = path.join(root, "pnpm-shim");
    await writeFile(shim, "#!/bin/sh\nexit 0\n");
    await chmod(shim, 0o755);
    const result = await runPackageManagerInstall("pnpm", {
      environment: { AGENT_CONTEXT_PACK_PNPM: shim },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
    });
    assert.deepEqual(result, {
      manager: "pnpm",
      runtime: "node",
      nodeVersion: EXACT_NODE_VERSION,
      reason: "invalid-pnpm-launcher",
      state: "failed",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("pnpm install evidence rejects a launcher with the wrong pinned version", async () => {
  const root = await fixtureRoot();
  try {
    const launcher = path.join(root, "pnpm.mjs");
    await writeFile(launcher, 'process.stdout.write("11.12.0\\n");\n');
    const result = await runPackageManagerInstall("pnpm", {
      environment: { AGENT_CONTEXT_PACK_PNPM: launcher },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
    });
    assert.deepEqual(result, {
      expectedPnpmVersion: "11.18.0",
      manager: "pnpm",
      runtime: "node",
      managerVersion: "11.12.0",
      observedPnpmVersion: "11.12.0",
      nodeVersion: EXACT_NODE_VERSION,
      reason: "pnpm-version-mismatch",
      state: "failed",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Node-mediated managers reject extensionless shebang launchers instead of using ambient PATH", async () => {
  const root = await fixtureRoot("agent-context-package-matrix-shebang-");
  try {
    const launcher = path.join(root, "npm-shim");
    await writeFile(
      launcher,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'1.0.0\\n\'; fi\n',
    );
    await chmod(launcher, 0o755);
    const result = await runPackageManagerInstall("npm", {
      environment: { AGENT_CONTEXT_PACK_NPM: launcher },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
    });
    assert.deepEqual(result, {
      manager: "npm",
      runtime: "node",
      nodeVersion: EXACT_NODE_VERSION,
      reason: "invalid-node-launcher",
      state: "failed",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a selected Node executable is attested before a manager can run", async () => {
  const root = await fixtureRoot("agent-context-package-matrix-node-attestation-");
  try {
    const fakeNode = path.join(root, "node-mismatch.sh");
    const launcher = path.join(root, "npm.mjs");
    await writeFile(fakeNode, "#!/bin/sh\nprintf 'v22.14.0\\n'\n");
    await chmod(fakeNode, 0o755);
    await writeFile(launcher, 'process.stdout.write("1.0.0\\n");\n');
    const result = await runPackageManagerInstall("npm", {
      environment: { AGENT_CONTEXT_PACK_NPM: launcher },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: fakeNode,
    });
    assert.deepEqual(result, {
      manager: "npm",
      runtime: "node",
      nodeVersion: "v22.14.0",
      reason: "node-runtime-mismatch",
      state: "failed",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Bun is explicitly admitted as a native manager while the installed CLI uses attested Node", async () => {
  const root = await fixtureRoot("agent-context-package-matrix-bun-native-");
  try {
    const manager = path.join(root, "bun");
    await writeFile(
      manager,
      [
        "#!/bin/sh",
        "set -eu",
        'if [ "$1" = "--version" ]; then printf "1.0.0\\n"; exit 0; fi',
        "mkdir -p node_modules/@agent-context/core/dist node_modules/@agent-context/lint/dist",
        'printf \'{"name":"@agent-context/core","version":"1.0.0","license":"Apache-2.0"}\\n\' > node_modules/@agent-context/core/package.json',
        'printf \'{"name":"@agent-context/lint","version":"1.0.0","license":"Apache-2.0","dependencies":{"@agent-context/core":"1.0.0"}}\\n\' > node_modules/@agent-context/lint/package.json',
        "printf 'process.stdout.write(\\\"1.0.0\\\\n\\\");\\n' > node_modules/@agent-context/lint/dist/cli.js",
        "chmod 755 node_modules/@agent-context/lint/dist/cli.js",
      ].join("\n"),
    );
    await chmod(manager, 0o755);
    const result = await runPackageManagerInstall("bun", {
      environment: { AGENT_CONTEXT_PACK_BUN: manager },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
    });
    assert.equal(result.state, "passed", JSON.stringify(result));
    assert.equal(result.runtime, "native");
    assert.equal(result.nodeVersion, EXACT_NODE_VERSION);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("non-pnpm manager versions are probed before install and malformed output fails closed", async () => {
  const root = await fixtureRoot("agent-context-package-matrix-version-probe-");
  try {
    const manager = path.join(root, "npm-version-invalid.mjs");
    const privateMarker = path.join(root, "private-version-output");
    await writeFile(
      manager,
      `if (process.argv[2] === "--version") process.stdout.write(${JSON.stringify(privateMarker)} + "\\n");\n`,
    );
    const result = await runPackageManagerInstall("npm", {
      environment: { AGENT_CONTEXT_PACK_NPM: manager },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
    });
    assert.deepEqual(result, {
      manager: "npm",
      runtime: "node",
      nodeVersion: EXACT_NODE_VERSION,
      reason: "manager-version-invalid",
      state: "failed",
    });
    assert.equal(JSON.stringify(result).includes(privateMarker), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("manager install failures retain only a stable code and output digests", async () => {
  const root = await fixtureRoot("agent-context-package-matrix-install-failure-");
  try {
    const manager = path.join(root, "npm-failure.mjs");
    const privateMarker = path.join(root, "private-manager-output");
    await writeFile(
      manager,
      `if (process.argv[2] === "--version") process.stdout.write("1.0.0\\n");\nelse { process.stderr.write(${JSON.stringify(privateMarker)} + "\\n"); process.exitCode = 17; }\n`,
    );
    const result = await runPackageManagerInstall("npm", {
      environment: { AGENT_CONTEXT_PACK_NPM: manager },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
    });
    assert.equal(result.manager, "npm");
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "install-failed");
    assert.equal(result.status, 17);
    assert.equal(typeof result.stderrSha256, "string");
    assert.equal(JSON.stringify(result).includes(privateMarker), false);
    assert.equal(JSON.stringify(result).includes("private-manager-output"), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("missing managers are reported unavailable, never passed", async () => {
  const root = await fixtureRoot();
  try {
    const cliTarball = path.join(root, "cli.tgz");
    const coreTarball = path.join(root, "core.tgz");
    await writeFile(cliTarball, "cli tarball fixture\n");
    await writeFile(coreTarball, "core tarball fixture\n");
    const result = await runPackageInstallMatrix({
      cliTarball,
      coreTarball,
      environment: {},
      manager: "npm,pnpm",
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
      parent: root,
      strict: true,
    });
    assert.equal(result.success, false);
    assert.deepEqual(
      result.report.managers.map(({ manager, state }) => ({ manager, state })),
      [
        { manager: "npm", state: "unavailable" },
        { manager: "pnpm", state: "unavailable" },
      ],
    );
    assert.equal(
      result.report.managers.some(({ state }) => state === "passed"),
      false,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("default temporary fixture canonicalizes macOS symlinked temp paths before install", async () => {
  const root = await fixtureRoot("agent-context-package-matrix-canonical-path-");
  const canonicalRoot = await realpath(root);
  const parentAlias = path.join(canonicalRoot, "parent-alias");
  const manager = path.join(canonicalRoot, "manager.mjs");
  const cliTarball = path.join(canonicalRoot, "agent-context-lint.tgz");
  const coreTarball = path.join(canonicalRoot, "agent-context-core.tgz");
  try {
    await symlink(canonicalRoot, parentAlias, "dir");
    await writeFile(cliTarball, "cli tarball fixture\n");
    await writeFile(coreTarball, "core tarball fixture\n");
    await writeFile(
      manager,
      `#!${process.execPath}
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.argv[2] === "--version") {
  process.stdout.write("1.0.0\\n");
  process.exit(0);
}

const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
for (const specifier of Object.values(packageJson.dependencies)) {
  if (typeof specifier !== "string" || !specifier.startsWith("file:")) process.exit(21);
  if (!existsSync(path.resolve(process.cwd(), specifier.slice(5)))) process.exit(22);
}

const coreRoot = path.join(process.cwd(), "node_modules/@agent-context/core");
const cliRoot = path.join(process.cwd(), "node_modules/@agent-context/lint");
await mkdir(path.join(coreRoot), { recursive: true });
await mkdir(path.join(cliRoot, "dist"), { recursive: true });
await writeFile(path.join(coreRoot, "package.json"), JSON.stringify({
  name: "@agent-context/core", version: "1.0.0", license: "Apache-2.0",
}));
await writeFile(path.join(cliRoot, "package.json"), JSON.stringify({
  name: "@agent-context/lint", version: "1.0.0", license: "Apache-2.0",
  dependencies: { "@agent-context/core": "1.0.0" },
}));
const cliExecutable = path.join(cliRoot, "dist/cli.js");
await writeFile(cliExecutable, "process.stdout.write('1.0.0' + String.fromCharCode(10));\\n");
await chmod(cliExecutable, 0o755);
`,
    );
    await chmod(manager, 0o755);
    const result = await runPackageInstallMatrix({
      cliTarball,
      coreTarball,
      environment: { AGENT_CONTEXT_PACK_NPM: manager },
      manager: "npm",
      nodeExecutable: EXACT_NODE,
      nodeVersion: EXACT_NODE_VERSION,
      parent: parentAlias,
      strict: true,
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.report.managers, [
      {
        manager: "npm",
        runtime: "node",
        managerVersion: "1.0.0",
        nodeVersion: EXACT_NODE_VERSION,
        state: "passed",
        cliManifestSha256: result.report.managers[0].cliManifestSha256,
        coreManifestSha256: result.report.managers[0].coreManifestSha256,
      },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("tarball admission rejects symlinks and oversized paths before fixture creation", async () => {
  const root = await fixtureRoot();
  try {
    const target = path.join(root, "target.tgz");
    const link = path.join(root, "cli.tgz");
    await writeFile(target, "target\n");
    await symlink(target, link);
    await assert.rejects(
      runPackageInstallMatrix({
        cliTarball: link,
        coreTarball: target,
        manager: "npm",
        parent: root,
        nodeVersion: EXACT_NODE_VERSION,
        nodeExecutable: EXACT_NODE,
      }),
      /regular non-symlink/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("installed runtime validation checks identity, license, dependency, executable, and version", async () => {
  const root = await fixtureRoot();
  try {
    await writeInstalledRuntime(root);
    const result = await assertInstalledRuntime(root, process.execPath);
    assert.equal(typeof result.cliManifestSha256, "string");
    assert.equal(result.cliManifestSha256.length, 64);

    await writeFile(
      path.join(root, "node_modules/@agent-context/lint/package.json"),
      JSON.stringify({
        name: "@agent-context/lint",
        version: "1.0.0",
        license: "Apache-2.0",
        dependencies: { "@agent-context/core": "workspace:*" },
      }),
    );
    await assert.rejects(assertInstalledRuntime(root, process.execPath), /workspace protocol/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("workspace backlinks in an installed dependency tree fail closed", async () => {
  const root = await fixtureRoot();
  const forbidden = await fixtureRoot("agent-context-package-matrix-source-");
  try {
    const links = path.join(root, "node_modules/@agent-context");
    await mkdir(links, { recursive: true });
    await symlink(forbidden, path.join(links, "source-backlink"));
    await assert.rejects(assertNoWorkspaceBacklinks(root, [forbidden]), /links back/u);
    await assert.doesNotReject(assertNoWorkspaceBacklinks(root, []));
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(forbidden, { force: true, recursive: true });
  }
});

test("a bounded fake npm command proves successful status still requires installed artifacts", async () => {
  const root = await fixtureRoot();
  try {
    const fakeManager = path.join(root, "fake-npm.mjs");
    await writeFile(
      fakeManager,
      [
        'import { chmod, mkdir, writeFile } from "node:fs/promises";',
        'import path from "node:path";',
        "const fixture = `${process.cwd()}${path.sep}`;",
        'const isolated = [process.env.HOME, process.env.npm_config_cache, process.env.pnpm_config_store_dir, process.env.YARN_CACHE_FOLDER, process.env.BUN_INSTALL_CACHE_DIR, process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, process.env.BUN_CONFIG_DIR].every((value) => typeof value === "string" && value.startsWith(fixture));',
        "if (!isolated) process.exitCode = 31;",
        'if (process.argv[2] === "--version") { process.stdout.write("1.0.0\\n"); }',
        "else {",
        '  const coreRoot = path.join(process.cwd(), "node_modules/@agent-context/core");',
        '  const cliRoot = path.join(process.cwd(), "node_modules/@agent-context/lint");',
        '  await mkdir(path.join(coreRoot, "dist"), { recursive: true });',
        '  await mkdir(path.join(cliRoot, "dist"), { recursive: true });',
        '  await writeFile(path.join(coreRoot, "package.json"), JSON.stringify({ name: "@agent-context/core", version: "1.0.0", license: "Apache-2.0" }));',
        '  await writeFile(path.join(cliRoot, "package.json"), JSON.stringify({ name: "@agent-context/lint", version: "1.0.0", license: "Apache-2.0", dependencies: { "@agent-context/core": "1.0.0" } }));',
        '  const cli = path.join(cliRoot, "dist/cli.js");',
        '  await writeFile(cli, "process.stdout.write(String.fromCharCode(49,46,48,46,48,10));\\n");',
        "  await chmod(cli, 0o755);",
        "}",
      ].join("\n"),
    );
    const result = await runPackageManagerInstall("npm", {
      environment: { AGENT_CONTEXT_PACK_NPM: fakeManager },
      installRoot: root,
      nodeVersion: EXACT_NODE_VERSION,
      nodeExecutable: EXACT_NODE,
    });
    assert.equal(result.state, "passed", JSON.stringify(result));
    assert.equal(result.managerVersion, "1.0.0");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
