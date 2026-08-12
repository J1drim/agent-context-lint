import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCliDocumentationArtifacts,
  assertCliBundleArtifacts,
  assertCliInvocation,
  assertPackedFilePaths,
  publicPackages,
  assertBundledArtifacts,
  assertOptionalTokenizerArtifacts,
  assertProjectLicenseArtifacts,
  assertReproducibleRuntimePacks,
  createCleanBuildWorkspace,
  exactPnpmInvocation,
  packCleanCli,
  optionalTokenizerPackage,
  packageAuditEnvironment,
  spawnReviewedAsync,
  standardsPackage,
} from "./check-packed-manifests.mjs";

function runGit(arguments_, cwd) {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runPnpm(arguments_, cwd) {
  const inheritedPnpm = process.env.npm_execpath;
  const executable = inheritedPnpm?.endsWith(".cjs")
    ? process.execPath
    : process.platform === "win32"
      ? "pnpm.cmd"
      : "pnpm";
  const prefix = /\.m?js$/u.test(inheritedPnpm ?? "") ? [inheritedPnpm] : [];
  const result = spawnSync(executable, [...prefix, ...arguments_], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_offline: "true" },
    shell: false,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function exactTestPnpmEnvironment() {
  if (typeof process.env.npm_execpath === "string" && path.isAbsolute(process.env.npm_execpath)) {
    const launcher = path.join(path.dirname(process.env.npm_execpath), "pnpm.mjs");
    if (existsSync(launcher)) return { ...process.env, npm_execpath: launcher };
  }
  const executable = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) => path.join(directory, process.platform === "win32" ? "pnpm.cmd" : "pnpm"))
    .find(existsSync);
  if (executable === undefined) throw new Error("test pnpm executable is unavailable");
  const launcher = path.join(path.dirname(realpathSync(executable)), "pnpm.mjs");
  if (!existsSync(launcher)) throw new Error("test pnpm JavaScript launcher is unavailable");
  return { ...process.env, npm_execpath: launcher };
}

const core = publicPackages.find(({ name }) => name === "@agent-context/core");
if (core === undefined) throw new Error("core package definition is missing");
const cli = publicPackages.find(({ name }) => name === "@agent-context/lint");
if (cli === undefined) throw new Error("CLI package definition is missing");

const staleSuppressionOutputs = [
  "dist/suppression.d.ts",
  "dist/suppression.d.ts.map",
  "dist/suppression.js",
  "dist/suppression.js.map",
];

function packFilename(packResult) {
  const record = Array.isArray(packResult) ? packResult[0] : packResult;
  assert.equal(typeof record?.filename, "string");
  return record.filename;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("sealed package tools admit the pinned pnpm launcher and override hostile shell config", () => {
  const cjs = exactPnpmInvocation({
    AGENT_CONTEXT_PACK_NODE: process.execPath,
    AGENT_CONTEXT_PACK_PNPM: "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
  });
  assert.deepEqual(cjs, {
    executable: process.execPath,
    prefix: ["/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs"],
  });
  const environment = packageAuditEnvironment({ npm_config_script_shell: "/tmp/hostile-shell" });
  assert.equal(path.isAbsolute(environment.npm_config_script_shell), true);
  assert.notEqual(environment.npm_config_script_shell, "/tmp/hostile-shell");
  assert.throws(
    () =>
      exactPnpmInvocation({
        AGENT_CONTEXT_PACK_NODE: process.execPath,
        AGENT_CONTEXT_PACK_PNPM: "/usr/local/lib/node_modules/pnpm/bin/pnpm.js",
      }),
    /exact absolute pnpm/u,
  );
});

async function assertNoOrphanAfterFailure(root, mode) {
  const marker = path.join(root, `${mode}-orphan.txt`);
  const childSource = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 300); setInterval(() => {}, 1000);`;
  const parentPrefix = `const { spawn } = require("node:child_process"); const issued = spawn(process.execPath, ["--eval", ${JSON.stringify(childSource)}], { stdio: "ignore" }); issued.unref();`;
  const controller = new AbortController();
  const source =
    mode === "timeout" || mode === "cancel"
      ? `${parentPrefix} setInterval(() => {}, 1000);`
      : mode === "stdout"
        ? `${parentPrefix} process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000);`
        : `${parentPrefix} require("node:fs").writeSync(1, Buffer.from([255]));`;
  const running = spawnReviewedAsync(process.execPath, ["--eval", source], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    reviewedMaximumStdoutBytes: mode === "stdout" ? 64 : 8192,
    reviewedTimeoutMs: mode === "timeout" ? 50 : 5_000,
    shell: false,
    signal: mode === "cancel" ? controller.signal : undefined,
  });
  if (mode === "cancel") setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, /cancelled|deadline|byte cap|malformed UTF-8/u);
  await wait(450);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
}

test("bounded packaging failures kill every issued process-group descendant", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-pack-process-group-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await Promise.all(
    ["timeout", "cancel", "stdout", "utf8"].map((mode) => assertNoOrphanAfterFailure(root, mode)),
  );
});

test("bounded packaging enforces pre-abort and successful process-group cleanup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-pack-success-group-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const marker = path.join(root, "orphan.txt");
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    spawnReviewedAsync(process.execPath, ["--eval", "process.exit(0)"], {
      cwd: root,
      env: process.env,
      signal: preAborted.signal,
    }),
    /cancelled/u,
  );
  const child = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 250); setInterval(() => {}, 1000);`;
  const parent = `require("node:child_process").spawn(process.execPath, ["--eval", ${JSON.stringify(child)}], { stdio: "ignore" }).unref();`;
  const result = await spawnReviewedAsync(process.execPath, ["--eval", parent], {
    cwd: root,
    env: process.env,
    reviewedTimeoutMs: 5_000,
  });
  assert.equal(result.status, 0);
  await wait(350);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("bounded packaging always performs confinement postflight verification", async () => {
  let successfulPostflights = 0;
  const confinement = {
    profile: "(version 1)\n(allow default)\n",
    sandboxExecutable: "/usr/bin/sandbox-exec",
    verifyAfter: async () => {
      successfulPostflights += 1;
    },
  };
  const success = await spawnReviewedAsync(
    process.execPath,
    ["--eval", "process.exit(0)"],
    {},
    confinement,
  );
  assert.equal(Number.isInteger(success.status), true);
  assert.equal(successfulPostflights, 1);

  await assert.rejects(
    spawnReviewedAsync(
      process.execPath,
      ["--eval", "process.exit(0)"],
      {},
      {
        profile: "fixture",
        sandboxExecutable: "/usr/bin/sandbox-exec",
        verifyAfter: async () => {
          throw new Error("postflight changed");
        },
      },
    ),
    /postflight changed|ENOENT|sandbox/u,
  );
  assert.throws(
    () =>
      spawnReviewedAsync(
        process.execPath,
        ["--eval", "process.exit(0)"],
        {},
        {
          profile: "fixture",
          sandboxExecutable: "/usr/bin/sandbox-exec",
        },
      ),
    /exact reviewed sandbox profile/u,
  );
});

test("clean packing isolates workspace links from stale output and is reproducible", async (t) => {
  const packagingEnvironment = exactTestPnpmEnvironment();
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-clean-pack-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const sourceRoot = path.join(fixture, "source");
  const coreRoot = path.join(sourceRoot, "packages/core");
  const cliRoot = path.join(sourceRoot, "packages/cli");
  await mkdir(path.join(coreRoot, "src"), { recursive: true });
  await mkdir(path.join(coreRoot, "dist"), { recursive: true });
  await mkdir(path.join(cliRoot, "dist"), { recursive: true });
  await writeFile(path.join(sourceRoot, ".gitignore"), "ignored/\nnode_modules/\n", "utf8");
  await writeFile(path.join(sourceRoot, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(path.join(sourceRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    path.join(coreRoot, "package.json"),
    '{"name":"@fixture/core","private":true,"version":"1.0.0"}\n',
  );
  await writeFile(path.join(coreRoot, "src/value.txt"), "fresh-source\n", "utf8");
  await writeFile(path.join(coreRoot, "dist/value.txt"), "corrupted-original-core-dist\n", "utf8");
  await writeFile(path.join(cliRoot, "dist/compiled.txt"), "corrupted-original-cli-dist\n", "utf8");
  await writeFile(
    path.join(cliRoot, "build.mjs"),
    [
      'import { mkdir, readFile, writeFile } from "node:fs/promises";',
      'const value = await readFile(new URL("./node_modules/@fixture/core/src/value.txt", import.meta.url));',
      'await mkdir(new URL("./dist/", import.meta.url), { recursive: true });',
      'await writeFile(new URL("./dist/compiled.txt", import.meta.url), value);',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cliRoot, "package.json"),
    `${JSON.stringify({ dependencies: { "@fixture/core": "workspace:*" }, files: ["dist"], name: "clean-pack-fixture", scripts: { prepack: "node build.mjs" }, version: "1.0.0" })}\n`,
    "utf8",
  );
  await mkdir(path.join(sourceRoot, "ignored"), { recursive: true });
  await writeFile(path.join(sourceRoot, "ignored/poison.txt"), "must-not-copy\n", "utf8");
  runPnpm(["install", "--lockfile-only", "--ignore-scripts"], sourceRoot);
  runGit(["init", "--quiet"], sourceRoot);
  runGit(
    [
      "add",
      ".gitignore",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "packages/core/package.json",
      "packages/core/src/value.txt",
      "packages/core/dist/value.txt",
      "packages/cli/package.json",
      "packages/cli/dist/compiled.txt",
    ],
    sourceRoot,
  );
  const status = spawnSync("git", ["status", "--short"], {
    cwd: sourceRoot,
    encoding: "utf8",
    shell: false,
  });
  if (status.error) throw status.error;
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.includes("?? packages/cli/build.mjs"), true);

  const firstDestination = path.join(fixture, "first");
  const secondDestination = path.join(fixture, "second");
  await mkdir(firstDestination);
  await mkdir(secondDestination);
  const first = await packCleanCli(firstDestination, {
    environment: packagingEnvironment,
    sourceRoot,
  });
  const second = await packCleanCli(secondDestination, {
    environment: packagingEnvironment,
    sourceRoot,
  });
  const firstTarball = await readFile(packFilename(first.packResult));
  const secondTarball = await readFile(packFilename(second.packResult));
  assert.deepEqual(firstTarball, secondTarball);
  const extracted = spawnSync(
    "tar",
    ["-xOf", packFilename(first.packResult), "package/dist/compiled.txt"],
    { encoding: "utf8", shell: false },
  );
  if (extracted.error) throw extracted.error;
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.equal(extracted.stdout, "fresh-source\n");
  await assert.rejects(readFile(path.join(first.cleanRoot, "ignored/poison.txt")), {
    code: "ENOENT",
  });
  assert.equal(
    await realpath(path.join(first.cleanRoot, "packages/cli/node_modules/@fixture/core")),
    await realpath(path.join(first.cleanRoot, "packages/core")),
  );

  await writeFile(path.join(cliRoot, "build.mjs"), 'throw new Error("compile failed");\n');
  const failureDestination = path.join(fixture, "failure");
  await mkdir(failureDestination);
  await assert.rejects(
    packCleanCli(failureDestination, { environment: packagingEnvironment, sourceRoot }),
    /compile failed/u,
  );

  const outside = path.join(fixture, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    path.join(sourceRoot, "hostile-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const symlinkDestination = path.join(fixture, "symlink");
  await mkdir(symlinkDestination);
  await assert.rejects(
    createCleanBuildWorkspace(symlinkDestination, { sourceRoot }),
    /clean source inventory contains a symbolic link: hostile-link$/u,
  );
});

test("dual runtime packing fails closed when either independent package differs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-runtime-pack-identity-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const paths = {};
  for (const side of ["first", "second"])
    for (const name of ["cli", "core"]) {
      const filename = path.join(root, `${side}-${name}.tgz`);
      await writeFile(filename, `${name}-identical\n`);
      paths[`${side}${name[0].toUpperCase()}${name.slice(1)}Filename`] = filename;
    }
  await assert.doesNotReject(
    assertReproducibleRuntimePacks(
      { cliFilename: paths.firstCliFilename, coreFilename: paths.firstCoreFilename },
      { cliFilename: paths.secondCliFilename, coreFilename: paths.secondCoreFilename },
    ),
  );
  await writeFile(paths.secondCoreFilename, "core-mutated\n");
  await assert.rejects(
    assertReproducibleRuntimePacks(
      { cliFilename: paths.firstCliFilename, coreFilename: paths.firstCoreFilename },
      { cliFilename: paths.secondCliFilename, coreFilename: paths.secondCoreFilename },
    ),
    /independent clean core packs are not byte-for-byte reproducible/u,
  );
});

test("the core package explicitly rejects every stale suppression build output", () => {
  for (const staleOutput of staleSuppressionOutputs) {
    assert.ok(core.forbiddenFiles.includes(staleOutput));
    assert.throws(
      () => assertPackedFilePaths(core, new Set([...core.requiredFiles, staleOutput])),
      new RegExp(`unexpectedly packed ${staleOutput.replaceAll(".", "\\.")}$`, "u"),
    );
  }
});

test("packed-file policy accepts the required core artifact set", () => {
  assert.doesNotThrow(() => assertPackedFilePaths(core, new Set(core.requiredFiles)));
});

test("the CLI package requires runtime, completion, manual, schema, and reference artifacts", () => {
  for (const required of [
    "LICENSE",
    "NOTICE",
    "completions/_agent-context-lint",
    "completions/agent-context-lint.bash",
    "completions/agent-context-lint.fish",
    "man/agent-context-lint.1",
    "reference/agent-context-lint-reference.v1.json",
    "schemas/agent-context-lint-reference.v1.schema.json",
    "THIRD_PARTY_NOTICES",
    "dist/cli.meta.json",
    "bundled/manifest.v0.json",
  ])
    assert.ok(cli.requiredFiles.includes(required));
  assert.doesNotThrow(() => assertPackedFilePaths(cli, new Set(cli.requiredFiles)));
});

test("packed project licensing requires exact root bytes and preserves third-party notices", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-pack-license-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  await Promise.all([
    cp(fileURLToPath(new URL("../LICENSE", import.meta.url)), path.join(fixture, "LICENSE")),
    cp(fileURLToPath(new URL("../NOTICE", import.meta.url)), path.join(fixture, "NOTICE")),
    writeFile(
      path.join(fixture, "package.json"),
      `${JSON.stringify({ name: "@agent-context/lint", license: "Apache-2.0" })}\n`,
    ),
    writeFile(path.join(fixture, "THIRD_PARTY_NOTICES"), "independent third-party terms\n"),
  ]);
  await assertProjectLicenseArtifacts(fixture);
  await writeFile(path.join(fixture, "NOTICE"), "changed\n");
  await assert.rejects(
    assertProjectLicenseArtifacts(fixture),
    /packed NOTICE differs from repository root/u,
  );
});

test("the source CLI bundle passes the closed-bundle and notice audit", async () => {
  await assertCliBundleArtifacts(fileURLToPath(new URL("../packages/cli/", import.meta.url)));
});

test("the CLI package rejects every private unbundled command runtime", () => {
  for (const forbidden of [
    "dist/bounded-output.d.ts",
    "dist/bounded-output.d.ts.map",
    "dist/bounded-output.js",
    "dist/bounded-output.js.map",
    "dist/git-metadata-executor.d.ts",
    "dist/git-metadata-executor.d.ts.map",
    "dist/git-metadata-executor.js",
    "dist/git-metadata-executor.js.map",
    "dist/git-metadata-executor-production.d.ts",
    "dist/git-metadata-executor-production.d.ts.map",
    "dist/git-metadata-executor-production.js",
    "dist/git-metadata-executor-production.js.map",
    "dist/scan-command.js",
    "dist/scan-command.js.map",
    "dist/scan-command.meta.json",
  ]) {
    assert.ok(cli.forbiddenFiles.includes(forbidden));
    assert.throws(
      () => assertPackedFilePaths(cli, new Set([...cli.requiredFiles, forbidden])),
      new RegExp(`unexpectedly packed ${forbidden.replaceAll(".", "\\.")}$`, "u"),
    );
  }
});

test("the CLI package rejects every file outside its explicit public inventory", () => {
  for (const extra of [
    "dist/internal.js",
    "dist/internal.js.map",
    "dist/internal.meta.json",
    "private.key",
    "secret.txt",
  ])
    assert.throws(
      () => assertPackedFilePaths(cli, new Set([...cli.requiredFiles, extra])),
      new RegExp(`packed unexpected file ${extra.replaceAll(".", "\\.")}$`, "u"),
    );
});

test("packed-file policy rejects missing required files and build metadata", () => {
  assert.throws(
    () =>
      assertPackedFilePaths(
        core,
        new Set(core.requiredFiles.filter((file) => file !== "dist/index.d.ts")),
      ),
    /packed manifest omits dist\/index\.d\.ts$/u,
  );
  assert.throws(
    () => assertPackedFilePaths(core, new Set([...core.requiredFiles, "dist/cache.tsbuildinfo"])),
    /packed TypeScript incremental build metadata$/u,
  );
});

test("packed CLI invocation policy accepts exact status and streams", () => {
  assert.doesNotThrow(() =>
    assertCliInvocation(
      "fixture",
      { error: undefined, signal: null, status: 0, stderr: "", stdout: "ok\n" },
      { status: 0, stderr: "", stdout: "ok\n" },
    ),
  );
});

test("packed CLI invocation policy rejects errors, signals, status, and stream drift", () => {
  assert.throws(
    () =>
      assertCliInvocation(
        "fixture",
        { error: new Error("spawn"), signal: null, status: null, stderr: "", stdout: "" },
        { status: 0, stderr: "", stdout: "" },
      ),
    /spawn/u,
  );
  assert.throws(
    () =>
      assertCliInvocation(
        "fixture",
        { error: undefined, signal: "SIGINT", status: null, stderr: "", stdout: "" },
        { status: 0, stderr: "", stdout: "" },
      ),
    /terminated by SIGINT/u,
  );
  assert.throws(
    () =>
      assertCliInvocation(
        "fixture",
        { error: undefined, signal: null, status: 2, stderr: "bad", stdout: "bad" },
        { status: 0, stderr: "", stdout: "" },
      ),
    /fixture mismatch/u,
  );
});

test("the standards package requires trust, cache, check, and update runtimes", () => {
  assert.ok(standardsPackage.requiredFiles.includes("dist/standards-cache.js"));
  assert.ok(standardsPackage.requiredFiles.includes("dist/standards-cache.d.ts"));
  assert.ok(standardsPackage.requiredFiles.includes("dist/registry-client.js"));
  assert.ok(standardsPackage.requiredFiles.includes("dist/registry-client.d.ts"));
  assert.ok(standardsPackage.requiredFiles.includes("dist/standards-check.js"));
  assert.ok(standardsPackage.requiredFiles.includes("dist/standards-check.d.ts"));
  assert.ok(standardsPackage.requiredFiles.includes("dist/standards-update.js"));
  assert.ok(standardsPackage.requiredFiles.includes("dist/standards-update.d.ts"));
  assert.ok(standardsPackage.requiredFiles.includes("schemas/standards-update.v0.schema.json"));
  assert.doesNotThrow(() =>
    assertPackedFilePaths(standardsPackage, new Set(standardsPackage.requiredFiles)),
  );
});

test("the source standards package passes the bundled anchor and descriptor audit", async () => {
  await assertBundledArtifacts(fileURLToPath(new URL("../packages/standards/", import.meta.url)));
});

test("the optional tokenizer package is data-only and matches its engine trust anchor", async () => {
  assert.doesNotThrow(() =>
    assertPackedFilePaths(
      optionalTokenizerPackage,
      new Set(["package.json", ...optionalTokenizerPackage.requiredFiles]),
    ),
  );
  await assertOptionalTokenizerArtifacts(
    fileURLToPath(new URL("../optional-tokenizers/utf8-byte/", import.meta.url)),
  );
});

async function standardsFixture(t) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-pack-audit-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const source = fileURLToPath(new URL("../packages/standards/", import.meta.url));
  await cp(path.join(source, "bundled"), path.join(fixture, "bundled"), { recursive: true });
  await cp(path.join(source, "dist"), path.join(fixture, "dist"), { recursive: true });
  return fixture;
}

async function cliDocumentationFixture(t) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-cli-doc-audit-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const packageRoot = path.join(fixture, "cli", "package");
  const coreRoot = path.join(fixture, "core", "package");
  const source = fileURLToPath(new URL("../packages/cli/", import.meta.url));
  await mkdir(packageRoot, { recursive: true });
  await mkdir(path.join(coreRoot, "schemas"), { recursive: true });
  await cp(path.join(source, "completions"), path.join(packageRoot, "completions"), {
    recursive: true,
  });
  await cp(path.join(source, "man"), path.join(packageRoot, "man"), { recursive: true });
  await cp(path.join(source, "reference"), path.join(packageRoot, "reference"), {
    recursive: true,
  });
  await cp(path.join(source, "schemas"), path.join(packageRoot, "schemas"), {
    recursive: true,
  });
  await cp(path.join(source, "package.json"), path.join(packageRoot, "package.json"));
  await cp(
    fileURLToPath(
      new URL("../packages/core/schemas/agent-context-lint-config.v1.schema.json", import.meta.url),
    ),
    path.join(coreRoot, "schemas", "agent-context-lint-config.v1.schema.json"),
  );
  return { coreRoot, fixture, packageRoot };
}

test("the source CLI documentation artifacts pass the packed integrity audit", async (t) => {
  const fixture = await cliDocumentationFixture(t);
  await assertCliDocumentationArtifacts(fixture.packageRoot, fixture.fixture);
});

test("the packed documentation audit rejects reference, schema-binding, and text drift", async (t) => {
  const referenceFixture = await cliDocumentationFixture(t);
  await writeFile(
    path.join(referenceFixture.packageRoot, "reference/agent-context-lint-reference.v1.json"),
    "{}\n",
    "utf8",
  );
  await assert.rejects(
    assertCliDocumentationArtifacts(referenceFixture.packageRoot, referenceFixture.fixture),
    /schema-invalid|does not match/u,
  );

  const schemaFixture = await cliDocumentationFixture(t);
  await writeFile(
    path.join(schemaFixture.coreRoot, "schemas/agent-context-lint-config.v1.schema.json"),
    "{}\n",
    "utf8",
  );
  await assert.rejects(
    assertCliDocumentationArtifacts(schemaFixture.packageRoot, schemaFixture.fixture),
    /does not bind the packed configuration schema$/u,
  );

  const completionFixture = await cliDocumentationFixture(t);
  await writeFile(
    path.join(completionFixture.packageRoot, "completions/agent-context-lint.bash"),
    "\u001b[31munsafe\n",
    "utf8",
  );
  await assert.rejects(
    assertCliDocumentationArtifacts(completionFixture.packageRoot, completionFixture.fixture),
    /documentation artifact is unsafe/u,
  );
});

test("the bundled audit rejects manifest-anchor and content-address mismatches", async (t) => {
  const manifestFixture = await standardsFixture(t);
  const manifestPath = path.join(manifestFixture, "bundled", "manifest.v0.json");
  await chmod(manifestPath, 0o600);
  await writeFile(manifestPath, "{}", "utf8");
  await assert.rejects(
    assertBundledArtifacts(manifestFixture),
    /manifest differs from the compiled trust anchor$/u,
  );

  const contentFixture = await standardsFixture(t);
  const contentPath = path.join(
    contentFixture,
    "bundled/packs/sha256-71cdbec6d7450b05d88f7f13cc7e1f66b98be2824846b526d358fef644d94e59.json",
  );
  await chmod(contentPath, 0o600);
  await writeFile(contentPath, "{}", "utf8");
  await assert.rejects(
    assertBundledArtifacts(contentFixture),
    /artifact differs from its descriptor/u,
  );

  const extraFixture = await standardsFixture(t);
  await writeFile(path.join(extraFixture, "bundled", "private-key.pem"), "PRIVATE KEY", "utf8");
  await assert.rejects(assertBundledArtifacts(extraFixture), /unmanifested or missing artifact$/u);
});
