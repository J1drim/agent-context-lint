import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { auditBundleMetafile, createThirdPartyNotices } from "./build-cli-bundle.mjs";
import { verifyPackedDocumentationExamples } from "./check-documentation-examples.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function absoluteExecutable(environmentName, fallback) {
  const value = process.env[environmentName] ?? fallback;
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw new Error(`${environmentName} must identify an absolute executable path`);
  return value;
}

// H13 injects sealed, digest-verified copies through these variables. Standalone
// package checks retain explicit platform defaults, never PATH lookup.
const packageAuditExecutables = Object.freeze({
  git: absoluteExecutable("AGENT_CONTEXT_PACK_GIT", "/usr/bin/git"),
  node: absoluteExecutable("AGENT_CONTEXT_PACK_NODE", process.execPath),
  shell: absoluteExecutable(
    "AGENT_CONTEXT_PACK_SHELL",
    process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh",
  ),
  tar: absoluteExecutable(
    "AGENT_CONTEXT_PACK_TAR",
    process.platform === "darwin" ? "/usr/bin/bsdtar" : "/usr/bin/tar",
  ),
});

export function packageAuditEnvironment(extra = {}) {
  return {
    ...process.env,
    ...extra,
    npm_config_script_shell: packageAuditExecutables.shell,
  };
}
export const publicPackages = [
  {
    directory: "core",
    name: "@agent-context/core",
    forbiddenFiles: [
      "dist/configuration-parser.d.ts",
      "dist/configuration-parser.d.ts.map",
      "dist/configuration-parser.js",
      "dist/configuration-parser.js.map",
      "dist/suppression.d.ts",
      "dist/suppression.d.ts.map",
      "dist/suppression.js",
      "dist/suppression.js.map",
    ],
    runtimeDependencies: {},
    requiredFiles: [
      "LICENSE",
      "NOTICE",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "dist/index.js",
      "dist/index.js.map",
      "policies/compatibility-policy.v1.json",
      "schemas/agent-context-lint-config.v1.schema.json",
      "schemas/diagnostic-contract.v0.schema.json",
      "schemas/organization-policy-pack.v0.schema.json",
      "schemas/output-contract.v1.schema.json",
      "schemas/sarif-output.v2.1.0.schema.json",
      "schemas/sarif-output.v2.1.0-product-v2.schema.json",
    ],
  },
  {
    directory: "cli",
    name: "@agent-context/lint",
    executable: "dist/cli.js",
    exactFiles: true,
    forbiddenFiles: [
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
    ],
    runtimeDependencies: { "@agent-context/core": "1.0.0" },
    requiredFiles: [
      "LICENSE",
      "NOTICE",
      "dist/cli.js",
      "dist/cli.meta.json",
      "dist/cli.js.map",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "dist/index.js",
      "dist/index.js.map",
      "dist/library-api.d.ts",
      "dist/library-api.d.ts.map",
      "dist/library-api.js",
      "dist/library-api.js.map",
      "THIRD_PARTY_NOTICES",
      "bundled/manifest.v0.json",
      "bundled/metadata/root.json",
      "bundled/metadata/snapshot.json",
      "bundled/metadata/standards-stable.json",
      "bundled/metadata/targets.json",
      "bundled/metadata/timestamp.json",
      "bundled/packs/sha256-71cdbec6d7450b05d88f7f13cc7e1f66b98be2824846b526d358fef644d94e59.json",
      "completions/_agent-context-lint",
      "completions/agent-context-lint.bash",
      "completions/agent-context-lint.fish",
      "git-runtime/sha1/HEAD",
      "git-runtime/sha1/config",
      "git-runtime/sha1/objects/info/.keep",
      "git-runtime/sha1/refs/.keep",
      "git-runtime/sha256/HEAD",
      "git-runtime/sha256/config",
      "git-runtime/sha256/objects/info/.keep",
      "git-runtime/sha256/refs/.keep",
      "man/agent-context-lint.1",
      "reference/agent-context-lint-reference.v1.json",
      "schemas/agent-context-lint-reference.v1.schema.json",
    ],
  },
];

export const standardsPackage = {
  directory: "standards",
  name: "@agent-context/standards",
  private: true,
  runtimeDependencies: {
    "@tufjs/canonical-json": "2.0.0",
    "@tufjs/models": "4.0.0",
    "@agent-context/core": "1.0.0",
    "@agent-context/profiles": "1.0.0",
  },
  requiredFiles: [
    "LICENSE",
    "NOTICE",
    "bundled/manifest.v0.json",
    "bundled/metadata/root.json",
    "bundled/metadata/snapshot.json",
    "bundled/metadata/standards-stable.json",
    "bundled/metadata/targets.json",
    "bundled/metadata/timestamp.json",
    "bundled/packs/sha256-71cdbec6d7450b05d88f7f13cc7e1f66b98be2824846b526d358fef644d94e59.json",
    "dist/bundled-pack-loader.d.ts",
    "dist/bundled-pack-loader.js",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/offline.d.ts",
    "dist/offline.js",
    "dist/offline-standards-status.d.ts",
    "dist/offline-standards-status.js",
    "dist/registry-client.d.ts",
    "dist/registry-client.js",
    "dist/standards-check.d.ts",
    "dist/standards-check.js",
    "dist/standards-cache.d.ts",
    "dist/standards-cache.js",
    "dist/standards-lockfile.d.ts",
    "dist/standards-lockfile.js",
    "dist/standards-update.d.ts",
    "dist/standards-update.js",
    "dist/standards-update-contract.d.ts",
    "dist/standards-update-contract.js",
    "schemas/bundled-pack-manifest.v0.schema.json",
    "schemas/knowledge-pack.v0.schema.json",
    "schemas/offline-standards-status.v0.schema.json",
    "schemas/standards-lockfile.v1.schema.json",
    "schemas/standards-update.v0.schema.json",
    "schemas/tuf-metadata.v0.schema.json",
  ],
};

export const optionalTokenizerPackage = {
  directory: "optional-tokenizers/utf8-byte",
  name: "@agent-context/tokenizer-utf8-byte",
  runtimeDependencies: {},
  requiredFiles: ["LICENSE", "NOTICE", "README.md", "manifest.v1.json", "provider.wasm.b64"],
};

export const packedPackages = [...publicPackages, standardsPackage];

export function exactPnpmInvocation(environment) {
  const launcher = environment.AGENT_CONTEXT_PACK_PNPM ?? environment.npm_execpath;
  const nodeExecutable = environment.AGENT_CONTEXT_PACK_NODE ?? process.execPath;
  if (
    typeof launcher !== "string" ||
    !path.isAbsolute(launcher) ||
    !new Set([".cjs", ".mjs"]).has(path.extname(launcher)) ||
    typeof nodeExecutable !== "string" ||
    !path.isAbsolute(nodeExecutable)
  )
    throw new Error("packaging requires an exact absolute pnpm JavaScript launcher");
  return Object.freeze({ executable: nodeExecutable, prefix: [launcher] });
}

async function runPnpmPack(packageName, destination) {
  const { executable, prefix } = exactPnpmInvocation(process.env);
  const result = await spawnReviewedAsync(
    executable,
    [...prefix, "--filter", packageName, "pack", "--pack-destination", destination, "--json"],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      env: packageAuditEnvironment(),
      shell: false,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pnpm pack failed for ${packageName}:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

export function spawnReviewedAsync(executable, arguments_, options, confinement = null) {
  const selectedExecutable = confinement?.sandboxExecutable ?? executable;
  const selectedArguments =
    confinement === null
      ? arguments_
      : ["-p", confinement.profile, "--", executable, ...arguments_];
  if (
    confinement !== null &&
    (selectedExecutable !== "/usr/bin/sandbox-exec" ||
      typeof confinement.profile !== "string" ||
      confinement.profile.length === 0 ||
      typeof confinement.verifyAfter !== "function")
  )
    throw new Error("clean build confinement is not an exact reviewed sandbox profile");
  if (cancellationSignalFrom(options)?.aborted === true)
    return Promise.reject(new Error("bounded packaging command was cancelled"));
  return new Promise((resolve, reject) => {
    const {
      reviewedMaximumStderrBytes = 8 * 1024 * 1024,
      reviewedMaximumStdoutBytes = 8 * 1024 * 1024,
      reviewedTimeoutMs = 120_000,
      signal: cancellationSignal,
      ...spawnOptions
    } = options;
    const child = spawn(selectedExecutable, selectedArguments, {
      ...spawnOptions,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failure = null;
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const fail = (error) => {
      if (settled || failure !== null) return;
      failure = error;
      kill();
    };
    const timer = setTimeout(
      () => fail(new Error("bounded packaging command exceeded its deadline")),
      reviewedTimeoutMs,
    );
    const cancel = () => fail(new Error("bounded packaging command was cancelled"));
    cancellationSignal?.addEventListener("abort", cancel, { once: true });
    const collect = (target, chunk, current, maximumBytes, label) => {
      const next = current + chunk.length;
      if (next > maximumBytes) {
        fail(new Error(`bounded packaging ${label} exceeded its byte cap`));
      } else target.push(chunk);
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes, reviewedMaximumStdoutBytes, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes, reviewedMaximumStderrBytes, "stderr");
    });
    child.once("error", fail);
    child.once("close", async (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancellationSignal?.removeEventListener("abort", cancel);
      // A reviewed wrapper may exit while leaving descendants alive with detached
      // stdio. Always terminate the issued process group before returning.
      kill();
      let postflightFailure = null;
      try {
        await confinement?.verifyAfter?.();
      } catch (error) {
        postflightFailure = error;
      }
      if (failure !== null || postflightFailure !== null) {
        reject(
          failure !== null && postflightFailure !== null
            ? new AggregateError(
                [failure, postflightFailure],
                "bounded packaging command and executable postflight failed",
                { cause: failure },
              )
            : (failure ?? postflightFailure),
        );
        return;
      }
      try {
        resolve({
          error: undefined,
          signal,
          status,
          stderr: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderr)),
          stdout: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)),
        });
      } catch {
        kill();
        reject(new Error("bounded packaging command emitted malformed UTF-8"));
      }
    });
  });
}

function cancellationSignalFrom(options) {
  return options?.signal;
}

async function spawnPnpmDirectoryPack(
  workspaceRoot,
  directory,
  destination,
  environment = process.env,
  confinement = null,
) {
  const { executable, prefix } = exactPnpmInvocation(environment);
  const result = await spawnReviewedAsync(
    executable,
    [
      ...prefix,
      "--dir",
      path.join(workspaceRoot, directory),
      "pack",
      "--pack-destination",
      destination,
      "--json",
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: packageAuditEnvironment(environment),
      shell: false,
    },
    confinement,
  );
  return result;
}

async function runPnpmDirectoryPack(
  directory,
  destination,
  workspaceRoot = rootDirectory,
  environment = process.env,
  confinement = null,
) {
  const result = await spawnPnpmDirectoryPack(
    workspaceRoot,
    directory,
    destination,
    environment,
    confinement,
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm pack failed for ${directory}:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function excludedFromCleanBuild(relativePath) {
  return (
    relativePath === "node_modules" ||
    relativePath.endsWith(".tsbuildinfo") ||
    relativePath.includes("/dist/") ||
    relativePath === "packages/cli/THIRD_PARTY_NOTICES" ||
    relativePath.startsWith("packages/cli/bundled/") ||
    relativePath.startsWith("packages/cli/publish/")
  );
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function copyCleanSourceFile(sourceRoot, cleanRoot, relativePath) {
  const sourcePath = path.resolve(sourceRoot, relativePath);
  const targetPath = path.resolve(cleanRoot, relativePath);
  if (!isWithin(sourcePath, sourceRoot) || !isWithin(targetPath, cleanRoot))
    throw new Error(`clean source inventory path escapes its root: ${relativePath}`);
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink())
    throw new Error(`clean source inventory contains a symbolic link: ${relativePath}`);
  if (!sourceStat.isFile())
    throw new Error(`clean source inventory contains a non-regular file: ${relativePath}`);
  const handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== sourceStat.dev ||
      openedStat.ino !== sourceStat.ino
    )
      throw new Error(`clean source file changed while opening: ${relativePath}`);
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes, { flag: "wx", mode: sourceStat.mode & 0o777 });
}

async function assertCleanDependencyIsolation(cleanRoot, sourceRoot) {
  const originalPackages = await realpath(path.join(sourceRoot, "packages"));
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (isWithin(await realpath(absolutePath), originalPackages))
          throw new Error(
            `clean dependency link resolves into original workspace: ${absolutePath}`,
          );
      } else if (entry.isDirectory()) await visit(absolutePath);
    }
  };
  await visit(path.join(cleanRoot, "node_modules"));
}

async function copyPreparedDependencyTrees(sourceRoot, cleanRoot, relative = "") {
  const sourceDirectory = path.join(sourceRoot, relative);
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (entry.name === "node_modules" && entry.isDirectory()) {
      await cp(path.join(sourceDirectory, entry.name), path.join(cleanRoot, relative, entry.name), {
        dereference: false,
        recursive: true,
        verbatimSymlinks: true,
      });
      continue;
    }
    if (entry.isDirectory() && entry.name !== ".git")
      await copyPreparedDependencyTrees(sourceRoot, cleanRoot, path.join(relative, entry.name));
  }
}

async function installCleanDependencies(
  cleanRoot,
  sourceRoot,
  environment = process.env,
  confinement = null,
) {
  const preparedSource = environment.AGENT_CONTEXT_PACK_DEPENDENCY_SOURCE;
  if (preparedSource !== undefined) {
    if (environment.AGENT_CONTEXT_H13_CONTAINED !== "1" || preparedSource !== "/opt/h13/repo")
      throw new Error("prepared dependency trees require the pinned H13 container");
    await copyPreparedDependencyTrees(preparedSource, cleanRoot);
    await assertCleanDependencyIsolation(cleanRoot, sourceRoot);
    return;
  }
  const { executable, prefix } = exactPnpmInvocation(environment);
  const result = await spawnReviewedAsync(
    executable,
    [...prefix, "install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
    {
      cwd: cleanRoot,
      encoding: "utf8",
      env: packageAuditEnvironment({
        ...environment,
        CI: "true",
        npm_config_offline: "true",
      }),
      shell: false,
    },
    confinement,
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`offline clean dependency install failed:\n${result.stderr || result.stdout}`);
  await assertCleanDependencyIsolation(cleanRoot, sourceRoot);
}

export async function createCleanBuildWorkspace(parent, options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? rootDirectory);
  const cleanRoot = await mkdtemp(path.join(parent, "clean-source-"));
  let sourcePaths = options.sourcePaths;
  if (sourcePaths === undefined) {
    const gitExecutable = options.gitExecutable ?? packageAuditExecutables.git;
    if (!path.isAbsolute(gitExecutable))
      throw new Error("clean source inventory Git executable must be absolute");
    const listed = spawnSync(
      gitExecutable,
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: sourceRoot, encoding: null, shell: false },
    );
    if (listed.error) throw listed.error;
    if (listed.status !== 0)
      throw new Error(`clean source inventory failed:\n${listed.stderr.toString("utf8")}`);
    sourcePaths = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  }
  if (
    !Array.isArray(sourcePaths) ||
    sourcePaths.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(sourcePaths).size !== sourcePaths.length
  )
    throw new Error("clean source inventory must be an exact duplicate-free path array");
  const copiedSourcePaths = [];
  for (const relativePath of sourcePaths) {
    if (relativePath.length === 0 || excludedFromCleanBuild(relativePath)) continue;
    await copyCleanSourceFile(sourceRoot, cleanRoot, relativePath);
    copiedSourcePaths.push(relativePath);
  }
  const installConfinement = (await options.createConfinement?.(cleanRoot, "install")) ?? null;
  await installCleanDependencies(cleanRoot, sourceRoot, options.environment, installConfinement);
  const packConfinement = (await options.createConfinement?.(cleanRoot, "pack")) ?? null;
  return Object.freeze({
    cleanRoot,
    confinement: packConfinement,
    sourcePaths: Object.freeze(copiedSourcePaths),
  });
}

export async function packCleanCli(destination, options = {}) {
  const directory = options.directory ?? "packages/cli";
  const { cleanRoot, confinement, sourcePaths } = await createCleanBuildWorkspace(
    destination,
    options,
  );
  try {
    await stat(path.join(cleanRoot, directory, "dist"));
    throw new Error("clean CLI pack fixture unexpectedly contains dist output");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const packResult = await runPnpmDirectoryPack(
    directory,
    destination,
    cleanRoot,
    options.environment,
    confinement,
  );
  return { cleanRoot, confinement, packResult, sourcePaths };
}

export async function packCleanCliAndCore(destination, options = {}) {
  const firstDestination = path.join(destination, "first-runtime-pack");
  const secondDestination = path.join(destination, "second-runtime-pack");
  await mkdir(firstDestination, { mode: 0o700 });
  await mkdir(secondDestination, { mode: 0o700 });
  const first = await packCleanRuntimeOnce(firstDestination, options);
  const second = await packCleanRuntimeOnce(secondDestination, options);
  await assertReproducibleRuntimePacks(first, second);
  return Object.freeze({
    cleanRoot: first.cleanRoot,
    cliFilename: first.cliFilename,
    cliPackResult: first.cliPackResult,
    coreFilename: first.coreFilename,
    corePackResult: first.corePackResult,
    replayCleanRoot: second.cleanRoot,
    replaySourcePaths: second.sourcePaths,
    sourcePaths: first.sourcePaths,
  });
}

export async function assertReproducibleRuntimePacks(first, second) {
  for (const name of ["cli", "core"]) {
    const firstBytes = await readFile(first[`${name}Filename`]);
    const secondBytes = await readFile(second[`${name}Filename`]);
    if (!firstBytes.equals(secondBytes))
      throw new Error(`independent clean ${name} packs are not byte-for-byte reproducible`);
  }
}

async function packCleanRuntimeOnce(destination, options) {
  const cliDestination = path.join(destination, "cli-pack");
  const coreDestination = path.join(destination, "core-pack");
  await mkdir(cliDestination, { mode: 0o700 });
  await mkdir(coreDestination, { mode: 0o700 });
  const cli = await packCleanCli(cliDestination, options);
  const corePackResult = await runPnpmDirectoryPack(
    "packages/core",
    coreDestination,
    cli.cleanRoot,
    options.environment,
    cli.confinement,
  );
  return {
    cleanRoot: cli.cleanRoot,
    cliFilename: packRecord(cli.packResult).filename,
    cliPackResult: cli.packResult,
    coreFilename: packRecord(corePackResult).filename,
    corePackResult,
    sourcePaths: cli.sourcePaths,
  };
}

async function assertCleanCompileFailure(destination) {
  await mkdir(destination, { recursive: true });
  const { cleanRoot } = await createCleanBuildWorkspace(destination);
  const sourcePath = path.join(cleanRoot, "packages/cli/src/index.ts");
  await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\nexport const = ;\n`, "utf8");
  const result = await spawnPnpmDirectoryPack(cleanRoot, "packages/cli", destination);
  if (result.error) throw result.error;
  if (result.status === 0)
    throw new Error("clean CLI pack reused stale output after a production compile failure");
}

function packedFilePaths(packResult) {
  const record = Array.isArray(packResult) ? packResult[0] : packResult;
  return new Set((record.files ?? []).map((file) => (typeof file === "string" ? file : file.path)));
}

function packRecord(packResult) {
  const record = Array.isArray(packResult) ? packResult[0] : packResult;
  if (typeof record?.filename !== "string") {
    throw new Error("pnpm pack did not report a tarball filename");
  }
  return record;
}

function sortedRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      Math.sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))),
    ),
  );
}

export function assertPackedFilePaths(definition, files) {
  if ([...files].some((file) => file.endsWith(".tsbuildinfo"))) {
    throw new Error(`${definition.name} packed TypeScript incremental build metadata`);
  }
  for (const requiredFile of definition.requiredFiles) {
    if (!files.has(requiredFile)) {
      throw new Error(`${definition.name} packed manifest omits ${requiredFile}`);
    }
  }
  for (const forbiddenFile of definition.forbiddenFiles ?? []) {
    if (files.has(forbiddenFile)) {
      throw new Error(`${definition.name} unexpectedly packed ${forbiddenFile}`);
    }
  }
  if (definition.exactFiles === true) {
    const allowed = new Set(["README.md", "package.json", ...definition.requiredFiles]);
    const unexpected = [...files].filter((file) => !allowed.has(file)).sort();
    if (unexpected.length > 0)
      throw new Error(`${definition.name} packed unexpected file ${unexpected[0]}`);
  }
}

export function assertCliInvocation(label, actual, expected) {
  if (actual.error) throw actual.error;
  if (actual.signal !== null) {
    throw new Error(`${label} terminated by ${actual.signal}`);
  }
  if (
    actual.status !== expected.status ||
    actual.stdout !== expected.stdout ||
    actual.stderr !== expected.stderr
  ) {
    throw new Error(
      `${label} mismatch: ${JSON.stringify({
        actual: { status: actual.status, stderr: actual.stderr, stdout: actual.stdout },
        expected,
      })}`,
    );
  }
}

function invokePackedCli(executable, arguments_, direct = false, options = {}) {
  return spawnSync(
    direct ? executable : packageAuditExecutables.node,
    direct ? arguments_ : [executable, ...arguments_],
    {
      cwd: options.cwd ?? path.dirname(executable),
      encoding: "utf8",
      env: packageAuditEnvironment({ NO_COLOR: "1", ...options.env }),
      shell: false,
      timeout: 10_000,
    },
  );
}

async function repositorySnapshot(root) {
  const entries = await bundledFiles(root);
  const snapshot = [];
  for (const relativePath of entries) {
    const bytes = await readFile(path.join(root, relativePath));
    snapshot.push({ path: relativePath, sha256: sha256(bytes) });
  }
  return snapshot;
}

async function createPackedScanFixture(parent, files) {
  const root = await mkdtemp(path.join(parent, "scan-fixture-"));
  for (const [relativePath, text] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, text, "utf8");
  }
  for (const arguments_ of [
    ["init", "--quiet", root],
    ["-C", root, "add", "."],
  ]) {
    const result = spawnSync(packageAuditExecutables.git, arguments_, {
      encoding: "utf8",
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`packed scan fixture Git setup failed: ${result.stderr || result.stdout}`);
  }
  return root;
}

export async function verifyPackedCli(packageDirectory, version) {
  const executable = path.join(packageDirectory, "dist", "cli.js");
  const help = invokePackedCli(executable, ["--help"]);
  assertCliInvocation("packed CLI --help", help, {
    status: 0,
    stderr: "",
    stdout: help.stdout,
  });
  if (
    !help.stdout.startsWith(`Agent Context Linter ${version}\n`) ||
    !help.stdout.includes("scan [repository] [--format stylish|json|sarif]") ||
    !help.stdout.includes("[unavailable]")
  ) {
    throw new Error("packed CLI help omits its version, command grammar, or availability status");
  }
  assertCliInvocation("packed CLI empty invocation", invokePackedCli(executable, []), {
    status: 0,
    stderr: "",
    stdout: help.stdout,
  });
  assertCliInvocation("packed CLI --version", invokePackedCli(executable, ["--version"]), {
    status: 0,
    stderr: "",
    stdout: `${version}\n`,
  });
  const fixtureParent = path.dirname(packageDirectory);
  const fixtureGlobalsPath = path.join(fixtureParent, "scan-capability-fixture-globals.mjs");
  const guardPath = path.join(fixtureParent, "scan-capability-guard.mjs");
  const networkGuardPath = path.join(fixtureParent, "scan-network-capability-guard.mjs");
  await writeFile(
    fixtureGlobalsPath,
    [
      'const placeholder = Object.freeze(function networkPlaceholder() { return "unexpected"; });',
      'for (const key of ["fetch", "WebSocket", "EventSource"]) {',
      "  if (Object.getOwnPropertyDescriptor(globalThis, key) === undefined)",
      "    Object.defineProperty(globalThis, key, { configurable: true, enumerable: false, value: placeholder, writable: true });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    guardPath,
    [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import net from "node:net";',
      'const denied = () => { throw new Error("scan attempted a denied host capability"); };',
      "Object.freeze(denied);",
      "const DeniedNetworkConstructor = Object.freeze(class DeniedNetworkConstructor { constructor() { denied(); } });",
      "const denyGlobal = (key, replacement) => {",
      "  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);",
      "  if (descriptor === undefined) return;",
      "  const replacementDescriptor = { configurable: descriptor.configurable, enumerable: descriptor.enumerable, value: replacement, writable: false };",
      "  if (!Reflect.defineProperty(globalThis, key, replacementDescriptor)) throw new Error(`unable to deny global capability: ${key}`);",
      "};",
      'for (const key of ["exec", "execFile", "fork", "spawn", "spawnSync", "execFileSync", "execSync"]) childProcess[key] = denied;',
      "net.Socket.prototype.connect = denied;",
      'denyGlobal("fetch", denied);',
      'denyGlobal("WebSocket", DeniedNetworkConstructor);',
      'denyGlobal("EventSource", DeniedNetworkConstructor);',
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    networkGuardPath,
    [
      'import net from "node:net";',
      'const denied = () => { throw new Error("scan attempted a denied network capability"); };',
      "Object.freeze(denied);",
      "const DeniedNetworkConstructor = Object.freeze(class DeniedNetworkConstructor { constructor() { denied(); } });",
      "const denyGlobal = (key, replacement) => {",
      "  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);",
      "  if (descriptor === undefined) return;",
      "  const replacementDescriptor = { configurable: descriptor.configurable, enumerable: descriptor.enumerable, value: replacement, writable: false };",
      "  if (!Reflect.defineProperty(globalThis, key, replacementDescriptor)) throw new Error(`unable to deny global capability: ${key}`);",
      "};",
      "net.Socket.prototype.connect = denied;",
      'denyGlobal("fetch", denied);',
      'denyGlobal("WebSocket", DeniedNetworkConstructor);',
      'denyGlobal("EventSource", DeniedNetworkConstructor);',
      "",
    ].join("\n"),
    "utf8",
  );

  // G4/I03/I14: exercise every command that is available in the packed artifact.  These
  // commands run from a disposable repository under a hostile capability guard so the packed
  // smoke verifies user-visible output, exit statuses, and the offline/read-only boundary rather
  // than only checking that the command router advertises a handler.
  const commandSurfaceRoot = await mkdtemp(path.join(fixtureParent, "packed-command-surface-"));
  await mkdir(path.join(commandSurfaceRoot, "src"), { recursive: true });
  await writeFile(
    path.join(commandSurfaceRoot, "AGENTS.md"),
    "Read the repository guide.\n",
    "utf8",
  );
  await writeFile(
    path.join(commandSurfaceRoot, "src", "index.ts"),
    "export const value = 1;\n",
    "utf8",
  );
  const smokeEnvironment = {
    NODE_OPTIONS: `--permission --allow-fs-read=* --import=${pathToFileURL(fixtureGlobalsPath).href} --import=${pathToFileURL(guardPath).href}`,
  };
  const invokeCommandSurface = (label, arguments_, options = {}) => {
    const result = invokePackedCli(executable, arguments_, false, {
      cwd: options.cwd ?? commandSurfaceRoot,
      env: options.env ?? smokeEnvironment,
    });
    assertCliInvocation(label, result, {
      status: options.status ?? 0,
      stderr: options.stderr ?? "",
      stdout: result.stdout,
    });
    return result;
  };
  const listResult = invokeCommandSurface("packed list command", ["list", "--format", "json"]);
  const listOutput = JSON.parse(listResult.stdout);
  if (
    listOutput.recordKind !== "agent-context-instruction-list" ||
    !Array.isArray(listOutput.entries)
  )
    throw new Error("packed list command omitted its instruction-list contract");

  const rulesResult = invokeCommandSurface("packed rules command", ["rules", "--format", "json"]);
  const rulesOutput = JSON.parse(rulesResult.stdout);
  if (
    rulesOutput.recordKind !== "agent-context-rule-list" ||
    !Array.isArray(rulesOutput.rules) ||
    rulesOutput.rules.length !== 69
  )
    throw new Error("packed rules command omitted the complete rule registry");

  const explainResult = invokeCommandSurface("packed explain command", [
    "explain",
    "AGENTS.md",
    "--format",
    "json",
  ]);
  const explainOutput = JSON.parse(explainResult.stdout);
  if (
    explainOutput.recordKind !== "agent-context-explanation" ||
    typeof explainOutput.explanation !== "object" ||
    explainOutput.explanation === null
  )
    throw new Error("packed explain command omitted its explanation contract");

  const efficiencyResult = invokeCommandSurface("packed efficiency command", [
    "efficiency",
    "--format",
    "json",
  ]);
  const efficiencyOutput = JSON.parse(efficiencyResult.stdout);
  if (
    efficiencyOutput.recordKind !== "agent-context-efficiency-report" ||
    !Array.isArray(efficiencyOutput.profiles)
  )
    throw new Error("packed efficiency command omitted its report contract");

  const standardsResult = invokeCommandSurface("packed standards status command", [
    "standards",
    "status",
    "--format",
    "json",
  ]);
  const standardsOutput = JSON.parse(standardsResult.stdout);
  if (
    standardsOutput.recordKind !== "agent-context-offline-standards-status" ||
    standardsOutput.output?.mode !== "status"
  )
    throw new Error("packed standards status omitted its offline status contract");

  const initRoot = await mkdtemp(path.join(fixtureParent, "packed-init-command-"));
  const initResult = invokeCommandSurface("packed init command", ["init"], {
    cwd: initRoot,
    env: { NODE_OPTIONS: "" },
  });
  if (initResult.stdout !== "Created .agent-context-lint.yml.\n")
    throw new Error("packed init command omitted its creation confirmation");
  const initialized = await readFile(path.join(initRoot, ".agent-context-lint.yml"), "utf8");
  if (!initialized.startsWith("# Agent Context Linter configuration.\n"))
    throw new Error("packed init command wrote an unexpected starter configuration");
  invokeCommandSurface("packed init conflict", ["init"], {
    cwd: initRoot,
    env: { NODE_OPTIONS: "" },
    status: 2,
    stderr:
      "agent-context-lint: configuration was not created; the target may already exist or be unsafe.\n" +
      "agent-context-lint: command execution failed.\n" +
      "Run 'agent-context-lint --help' for usage and command availability.\n",
  });
  if ((await readFile(path.join(initRoot, ".agent-context-lint.yml"), "utf8")) !== initialized)
    throw new Error("packed init conflict modified an existing configuration");

  const guardedEnvironment = {
    NODE_OPTIONS: `--permission --allow-fs-read=* --import=${pathToFileURL(fixtureGlobalsPath).href} --import=${pathToFileURL(guardPath).href}`,
  };
  for (const [name, expression] of [
    ["fetch", 'await globalThis.fetch("https://example.invalid/");'],
    ["WebSocket", 'new globalThis.WebSocket("wss://example.invalid/");'],
    ["EventSource", 'new globalThis.EventSource("https://example.invalid/");'],
  ]) {
    const probe = spawnSync(
      packageAuditExecutables.node,
      ["--input-type=module", "--eval", expression],
      {
        encoding: "utf8",
        env: { ...process.env, ...guardedEnvironment },
        shell: false,
        timeout: 10_000,
      },
    );
    if (
      probe.error !== undefined ||
      probe.signal !== null ||
      probe.status === 0 ||
      probe.stdout !== "" ||
      !probe.stderr.includes("scan attempted a denied host capability")
    )
      throw new Error(`packed capability guard did not deny global ${name}`);
  }
  const scanRoot = await createPackedScanFixture(fixtureParent, {
    "AGENTS.md": "Run npm run missing-task before committing.\n",
    "package.json": '{"name":"packed-scan-fixture","scripts":{"test":"vitest"}}\n',
  });
  const scanArguments = [
    "scan",
    scanRoot,
    "--format",
    "json",
    "--rule",
    "ACL300",
    "--fail-on",
    "warning",
    "--profile",
    "codex-cli",
  ];
  const beforeScan = await repositorySnapshot(scanRoot);
  const firstScan = invokePackedCli(executable, scanArguments, false, {
    env: guardedEnvironment,
  });
  if (firstScan.error) throw firstScan.error;
  if (firstScan.signal !== null || firstScan.status !== 1 || firstScan.stderr !== "")
    throw new Error("packed guarded scan did not produce the expected policy failure");
  const parsedScan = JSON.parse(firstScan.stdout);
  if (
    parsedScan.recordKind !== "agent-context-scan-output" ||
    !parsedScan.diagnostics?.diagnostics?.some((entry) => entry.ruleId === "ACL300")
  )
    throw new Error("packed guarded scan omitted its genuine ACL300 diagnostic");
  assertCliInvocation(
    "packed CLI deterministic guarded scan",
    invokePackedCli(executable, scanArguments, false, { env: guardedEnvironment }),
    { status: 1, stderr: "", stdout: firstScan.stdout },
  );
  if (JSON.stringify(await repositorySnapshot(scanRoot)) !== JSON.stringify(beforeScan))
    throw new Error("packed guarded scan modified its repository fixture");

  const changedRoot = await createPackedScanFixture(fixtureParent, {
    ".github/copilot-instructions.md": "Run npm run missing-task before committing.\n",
    "package.json": '{"name":"packed-changed-fixture","scripts":{"test":"vitest"}}\n',
    "src/main.ts": "export const value = 1;\n",
  });
  const committed = spawnSync(
    packageAuditExecutables.git,
    [
      "-C",
      changedRoot,
      "-c",
      "user.name=Packed Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture base",
    ],
    { encoding: "utf8", shell: false },
  );
  if (committed.error) throw committed.error;
  if (committed.status !== 0)
    throw new Error(
      `packed changed fixture commit failed: ${committed.stderr || committed.stdout}`,
    );
  const resolvedBase = spawnSync(
    packageAuditExecutables.git,
    ["-C", changedRoot, "rev-parse", "HEAD"],
    {
      encoding: "utf8",
      shell: false,
    },
  );
  if (resolvedBase.error) throw resolvedBase.error;
  if (resolvedBase.status !== 0)
    throw new Error(
      `packed changed fixture base resolution failed: ${resolvedBase.stderr || resolvedBase.stdout}`,
    );
  const baseCommit = resolvedBase.stdout.trim();
  await writeFile(path.join(changedRoot, "src/main.ts"), "export const value = 2;\n", "utf8");
  const changedArguments = [
    "scan",
    changedRoot,
    "--changed",
    "--base",
    baseCommit,
    "--format",
    "json",
    "--rule",
    "ACL300",
    "--fail-on",
    "never",
    "--profile",
    "copilot-vscode",
    "--surface",
    "copilot-vscode/local-chat",
  ];
  const changedEnvironment = {
    NODE_OPTIONS: `--permission --allow-fs-read=* --allow-child-process --disable-warning=SecurityWarning --import=${pathToFileURL(fixtureGlobalsPath).href} --import=${pathToFileURL(networkGuardPath).href}`,
  };
  const beforeChanged = await repositorySnapshot(changedRoot);
  const firstChanged = invokePackedCli(executable, changedArguments, false, {
    env: changedEnvironment,
  });
  if (
    firstChanged.error ||
    firstChanged.signal !== null ||
    firstChanged.status !== 0 ||
    firstChanged.stderr !== ""
  )
    throw new Error(
      `packed explicit changed scan did not complete under bounded process authority: ${JSON.stringify(
        {
          error: firstChanged.error?.message ?? null,
          signal: firstChanged.signal,
          status: firstChanged.status,
          stderr: firstChanged.stderr,
        },
      )}`,
    );
  const parsedChanged = JSON.parse(firstChanged.stdout);
  if (!parsedChanged.diagnostics?.diagnostics?.some((entry) => entry.ruleId === "ACL300"))
    throw new Error("packed explicit changed scan omitted its genuine ACL300 diagnostic");
  assertCliInvocation(
    "packed CLI deterministic explicit changed scan",
    invokePackedCli(executable, changedArguments, false, { env: changedEnvironment }),
    { status: 0, stderr: "", stdout: firstChanged.stdout },
  );
  if (JSON.stringify(await repositorySnapshot(changedRoot)) !== JSON.stringify(beforeChanged))
    throw new Error("packed explicit changed scan modified its repository fixture");

  const assertChangedFallback = (label, root, base) => {
    const result = invokePackedCli(
      executable,
      changedArguments.map((argument, index) =>
        index === 1 ? root : index === 4 ? base : argument,
      ),
      false,
      { env: changedEnvironment },
    );
    if (
      result.error ||
      result.signal !== null ||
      result.status !== 0 ||
      result.stderr !==
        "agent-context-lint: changed-file mode used the full scan (git-metadata-unavailable).\n"
    )
      throw new Error(
        `${label} did not force the packed changed scan to full mode: ${JSON.stringify({
          error: result.error?.message ?? null,
          signal: result.signal,
          status: result.status,
          stderr: result.stderr,
        })}`,
      );
  };
  const gitDirectory = path.join(changedRoot, ".git");
  await writeFile(path.join(gitDirectory, "shallow"), `${baseCommit}\n`, "utf8");
  assertChangedFallback("packed shallow repository", changedRoot, baseCommit);
  await rm(path.join(gitDirectory, "shallow"));

  const commonConfigPath = path.join(gitDirectory, "config");
  const commonConfig = await readFile(commonConfigPath, "utf8");
  await writeFile(commonConfigPath, `${commonConfig}[extensions]\n\tauditUnknown = true\n`, "utf8");
  assertChangedFallback("packed unknown Git extension", changedRoot, baseCommit);
  await writeFile(commonConfigPath, commonConfig, "utf8");

  const unsupportedMainConfig = commonConfig.replace(
    "repositoryformatversion = 0",
    "repositoryformatversion = 2",
  );
  if (unsupportedMainConfig === commonConfig)
    throw new Error("packed Git fixture did not expose its main repository format");
  await writeFile(
    commonConfigPath,
    `${unsupportedMainConfig}[core "audit"]\n\trepositoryformatversion = 0\n`,
    "utf8",
  );
  assertChangedFallback("packed main-section Git format", changedRoot, baseCommit);
  await writeFile(commonConfigPath, commonConfig, "utf8");

  await mkdir(path.join(gitDirectory, "info"), { recursive: true });
  await writeFile(path.join(gitDirectory, "info", "grafts"), `${baseCommit}\n`, "utf8");
  assertChangedFallback("packed Git graft", changedRoot, baseCommit);
  await rm(path.join(gitDirectory, "info", "grafts"));

  await mkdir(path.join(gitDirectory, "refs", "replace"), { recursive: true });
  await writeFile(
    path.join(gitDirectory, "refs", "replace", baseCommit),
    `${baseCommit}\n`,
    "utf8",
  );
  assertChangedFallback("packed Git replacement", changedRoot, baseCommit);
  await rm(path.join(gitDirectory, "refs", "replace"), { recursive: true });

  const linkedRoot = path.join(fixtureParent, "packed-linked-backlink");
  const linked = spawnSync(
    packageAuditExecutables.git,
    ["-C", changedRoot, "worktree", "add", "--quiet", "-b", "packed-backlink", linkedRoot],
    { encoding: "utf8", shell: false },
  );
  if (linked.error) throw linked.error;
  if (linked.status !== 0)
    throw new Error(`packed linked-worktree fixture failed: ${linked.stderr || linked.stdout}`);
  const linkedMarker = await readFile(path.join(linkedRoot, ".git"), "utf8");
  const linkedGitDirectory = linkedMarker.trim().slice("gitdir: ".length);
  await rm(path.join(linkedGitDirectory, "gitdir"));
  await writeFile(path.join(linkedRoot, "src", "main.ts"), "export const value = 3;\n", "utf8");
  assertChangedFallback("packed missing worktree backlink", linkedRoot, baseCommit);

  const directive =
    "<!-- agent-context-lint-disable-next-line ACL100 -- reason: packed fixture -->\n";
  const previewRoot = await createPackedScanFixture(fixtureParent, {
    "AGENTS.md": `${directive}Body\n`,
  });
  const beforePreview = await repositorySnapshot(previewRoot);
  const preview = invokePackedCli(
    executable,
    ["scan", previewRoot, "--rule", "ACL109", "--fail-on", "never", "--fix-dry-run"],
    false,
    { env: guardedEnvironment },
  );
  if (
    preview.error ||
    preview.signal !== null ||
    preview.status !== 0 ||
    preview.stderr !== "" ||
    !preview.stdout.includes("ACL109") ||
    !preview.stdout.includes(`-${directive.trimEnd()}`)
  )
    throw new Error("packed guarded fix preview did not produce its stable read-only patch");
  if (JSON.stringify(await repositorySnapshot(previewRoot)) !== JSON.stringify(beforePreview))
    throw new Error("packed guarded fix preview modified its repository fixture");
  assertCliInvocation(
    "packed CLI rejects fix preview on non-scan commands",
    invokePackedCli(executable, ["list", "--fix-dry-run"]),
    {
      status: 2,
      stderr:
        "agent-context-lint: invalid command arguments.\n" +
        "Run 'agent-context-lint --help' for usage and command availability.\n",
      stdout: "",
    },
  );
  assertCliInvocation(
    "packed CLI rejects severity outside an explicit rule selection",
    invokePackedCli(executable, ["scan", "--rule", "ACL100", "--severity", "ACL101=error"]),
    {
      status: 2,
      stderr:
        "agent-context-lint: invalid command arguments.\n" +
        "Run 'agent-context-lint --help' for usage and command availability.\n",
      stdout: "",
    },
  );
  assertCliInvocation(
    "packed CLI unknown command",
    invokePackedCli(executable, ["untrusted-command"]),
    {
      status: 2,
      stderr:
        "agent-context-lint: unknown command.\n" +
        "Run 'agent-context-lint --help' for usage and command availability.\n",
      stdout: "",
    },
  );
  if (process.platform !== "win32") {
    assertCliInvocation("packed CLI executable", invokePackedCli(executable, ["--version"], true), {
      status: 0,
      stderr: "",
      stdout: `${version}\n`,
    });
  }

  const importProbe = [
    "const before = process.listenerCount('SIGINT');",
    "const beforeExitCode = process.exitCode;",
    "const originalOn = process.on;",
    "process.on = function (event, ...listeners) {",
    "  if (event === 'SIGINT') throw new Error('library import installed a signal listener');",
    "  return originalOn.call(this, event, ...listeners);",
    "};",
    "process.exit = () => { throw new Error('library import called process.exit'); };",
    "await import(process.argv[1]);",
    "if (process.listenerCount('SIGINT') !== before || process.exitCode !== beforeExitCode) {",
    "  throw new Error('library import changed process state');",
    "}",
    "process.stdout.write('import-ok\\n');",
  ].join("\n");
  const indexUrl = pathToFileURL(path.join(packageDirectory, "dist", "index.js")).href;
  const imported = spawnSync(
    packageAuditExecutables.node,
    ["--input-type=module", "--eval", importProbe, indexUrl],
    {
      cwd: packageDirectory,
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
    },
  );
  assertCliInvocation("packed library import", imported, {
    status: 0,
    stderr: "",
    stdout: "import-ok\n",
  });
}

async function installPackedCore(cliPackageRoot, packedCoreRoot) {
  const scope = path.join(cliPackageRoot, "node_modules", "@agent-context");
  await mkdir(scope, { recursive: true });
  await cp(packedCoreRoot, path.join(scope, "core"), { recursive: true });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key])]),
    );
  return value;
}

export async function assertProjectLicenseArtifacts(packageRoot) {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.license !== "Apache-2.0") {
    throw new Error(`${manifest.name ?? "package"} does not declare Apache-2.0`);
  }
  for (const name of ["LICENSE", "NOTICE"]) {
    const [canonical, packed] = await Promise.all([
      readFile(path.join(rootDirectory, name)),
      readFile(path.join(packageRoot, name)),
    ]);
    if (!canonical.equals(packed)) throw new Error(`packed ${name} differs from repository root`);
  }
  if (manifest.name === "@agent-context/lint") {
    const thirdParty = await readFile(path.join(packageRoot, "THIRD_PARTY_NOTICES"));
    const projectNotice = await readFile(path.join(packageRoot, "NOTICE"));
    if (thirdParty.equals(projectNotice)) throw new Error("third-party notices replaced NOTICE");
  }
}

export async function assertCliDocumentationArtifacts(packageRoot, extractedRoot) {
  const referencePath = path.join(packageRoot, "reference/agent-context-lint-reference.v1.json");
  const schemaPath = path.join(packageRoot, "schemas/agent-context-lint-reference.v1.schema.json");
  const referenceBytes = await readFile(referencePath);
  const reference = JSON.parse(referenceBytes.toString("utf8"));
  if (
    referenceBytes.toString("utf8") !== `${JSON.stringify(canonicalizeJson(reference), null, 2)}\n`
  )
    throw new Error("packed CLI machine reference is not deterministic canonical JSON");

  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(reference))
    throw new Error(
      `packed CLI machine reference is schema-invalid: ${ajv.errorsText(validate.errors)}`,
    );

  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (
    reference.product?.cliVersion !== manifest.version ||
    reference.commands?.length !== 7 ||
    reference.rules?.entries?.length !== 69 ||
    manifest.exports?.["./reference/agent-context-lint-reference.v1.json"] !==
      "./reference/agent-context-lint-reference.v1.json" ||
    manifest.exports?.["./schemas/agent-context-lint-reference.v1.schema.json"] !==
      "./schemas/agent-context-lint-reference.v1.schema.json"
  )
    throw new Error(
      "packed CLI machine reference does not match its package or complete registries",
    );

  const coreSchemaBytes = await readFile(
    path.join(extractedRoot, "core/package/schemas/agent-context-lint-config.v1.schema.json"),
  );
  const coreSchema = JSON.parse(coreSchemaBytes.toString("utf8"));
  if (
    reference.configuration?.schemaSha256 !== sha256(coreSchemaBytes) ||
    JSON.stringify(canonicalizeJson(reference.configuration?.schema)) !==
      JSON.stringify(canonicalizeJson(coreSchema))
  )
    throw new Error("packed CLI machine reference does not bind the packed configuration schema");

  for (const relativePath of [
    "completions/_agent-context-lint",
    "completions/agent-context-lint.bash",
    "completions/agent-context-lint.fish",
    "man/agent-context-lint.1",
  ]) {
    const absolutePath = path.join(packageRoot, relativePath);
    const fileStat = await lstat(absolutePath);
    const text = await readFile(absolutePath, "utf8");
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      !text.endsWith("\n") ||
      text.includes("\r") ||
      // eslint-disable-next-line no-control-regex -- release artifacts must reject controls.
      /[\u0000\u001b\u202a-\u202e\u2066-\u2069]/u.test(text)
    )
      throw new Error(`packed CLI documentation artifact is unsafe: ${relativePath}`);
  }
}

export async function assertCliBundleArtifacts(packageRoot) {
  const metafile = JSON.parse(await readFile(path.join(packageRoot, "dist/cli.meta.json"), "utf8"));
  auditBundleMetafile(metafile);
  const notices = await readFile(path.join(packageRoot, "THIRD_PARTY_NOTICES"), "utf8");
  if (notices !== (await createThirdPartyNotices(metafile)))
    throw new Error("packed CLI third-party notices do not match the bundled package inventory");

  const sourceMap = JSON.parse(await readFile(path.join(packageRoot, "dist/cli.js.map"), "utf8"));
  if (
    (sourceMap.sources ?? []).some(
      (source) =>
        path.isAbsolute(source) || /^[A-Za-z]:[\\/]/u.test(source) || source.startsWith("file:"),
    )
  )
    throw new Error("packed CLI source map contains an absolute build path");

  const sourceBundle = path.join(rootDirectory, "packages/standards/bundled");
  const packedBundle = path.join(packageRoot, "bundled");
  const [sourceFiles, packedFiles] = await Promise.all([
    bundledFiles(sourceBundle),
    bundledFiles(packedBundle),
  ]);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(packedFiles))
    throw new Error("packed CLI standards inventory differs from the signed source tree");
  for (const relativePath of sourceFiles) {
    const [sourceBytes, packedBytes] = await Promise.all([
      readFile(path.join(sourceBundle, relativePath)),
      readFile(path.join(packedBundle, relativePath)),
    ]);
    if (sha256(sourceBytes) !== sha256(packedBytes))
      throw new Error(`packed CLI standards bytes differ: ${relativePath}`);
  }
}

function descriptors(manifest) {
  return manifest.entries.flatMap((entry) => [
    entry.content,
    entry.metadata.root,
    entry.metadata.timestamp,
    entry.metadata.snapshot,
    entry.metadata.targets,
    entry.metadata.delegatedTargets,
  ]);
}

async function bundledFiles(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`packed bundle contains a symbolic link: ${child}`);
    if (entry.isDirectory()) result.push(...(await bundledFiles(root, child)));
    else if (entry.isFile()) result.push(child);
    else throw new Error(`packed bundle contains a non-regular entry: ${child}`);
  }
  return result.sort();
}

export async function assertBundledArtifacts(packageRoot) {
  const manifestPath = path.join(packageRoot, "bundled", "manifest.v0.json");
  const manifestBytes = await readFile(manifestPath);
  const loader = await readFile(path.join(packageRoot, "dist", "bundled-pack-loader.js"), "utf8");
  const lengthMatch = /export const BUNDLED_MANIFEST_LENGTH\s*=\s*([\d_]+)/u.exec(loader);
  const digestMatch = /export const BUNDLED_MANIFEST_SHA256\s*=\s*["']([a-f0-9]{64})["']/u.exec(
    loader,
  );
  if (lengthMatch === null || digestMatch === null) {
    throw new Error("standards loader omits its compiled bundled manifest anchor");
  }
  const compiledLength = Number(lengthMatch[1].replaceAll("_", ""));
  if (manifestBytes.byteLength !== compiledLength || sha256(manifestBytes) !== digestMatch[1]) {
    throw new Error("packed bundled manifest differs from the compiled trust anchor");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (JSON.stringify(manifest) !== manifestBytes.toString("utf8")) {
    throw new Error("packed bundled manifest is not compact canonical JSON");
  }
  const contentDescriptors = new Set(manifest.entries.map((entry) => entry.content));
  const manifestDescriptors = descriptors(manifest);
  const expectedFiles = new Set([
    "manifest.v0.json",
    ...manifestDescriptors.map(({ path }) => path),
  ]);
  const actualFiles = await bundledFiles(path.join(packageRoot, "bundled"));
  if (
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((file) => !expectedFiles.has(file))
  ) {
    throw new Error("packed bundle contains an unmanifested or missing artifact");
  }
  for (const descriptor of manifestDescriptors) {
    if (
      typeof descriptor?.path !== "string" ||
      typeof descriptor?.length !== "number" ||
      typeof descriptor?.sha256 !== "string"
    ) {
      throw new Error("packed bundled manifest contains a malformed descriptor");
    }
    const bundledRoot = path.join(packageRoot, "bundled");
    const absolute = path.resolve(bundledRoot, descriptor.path);
    if (!absolute.startsWith(`${bundledRoot}${path.sep}`)) {
      throw new Error("packed bundled descriptor escapes its root");
    }
    const artifactStat = await lstat(absolute);
    if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
      throw new Error(`packed bundled artifact is not a regular file: ${descriptor.path}`);
    }
    if (!(await realpath(absolute)).startsWith(`${await realpath(bundledRoot)}${path.sep}`)) {
      throw new Error(`packed bundled artifact resolves outside its root: ${descriptor.path}`);
    }
    const bytes = await readFile(absolute);
    if (bytes.byteLength !== descriptor.length || sha256(bytes) !== descriptor.sha256) {
      throw new Error(`packed bundled artifact differs from its descriptor: ${descriptor.path}`);
    }
    if (
      contentDescriptors.has(descriptor) &&
      descriptor.path !== `packs/sha256-${descriptor.sha256}.json`
    ) {
      throw new Error("packed knowledge pack is not content addressed");
    }
    if (/BEGIN [A-Z ]*PRIVATE KEY|privateKey/iu.test(bytes.toString("utf8"))) {
      throw new Error(`packed bundled artifact contains private-key material: ${descriptor.path}`);
    }
  }
}

export async function assertOptionalTokenizerArtifacts(packageRoot) {
  const entries = await bundledFiles(packageRoot);
  if (
    JSON.stringify(entries) !==
    JSON.stringify([
      "LICENSE",
      "NOTICE",
      "README.md",
      "manifest.v1.json",
      "package.json",
      "provider.wasm.b64",
    ])
  ) {
    throw new Error("optional tokenizer package contains executable or unreviewed files");
  }
  const packageManifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (
    packageManifest.name !== optionalTokenizerPackage.name ||
    packageManifest.scripts !== undefined ||
    packageManifest.dependencies !== undefined ||
    packageManifest.optionalDependencies !== undefined ||
    packageManifest.peerDependencies !== undefined
  ) {
    throw new Error("optional tokenizer package has an executable or dependency capability");
  }
  const manifestBytes = await readFile(path.join(packageRoot, "manifest.v1.json"));
  if (
    sha256(manifestBytes) !== "6b07fd8d56cd45aa939cedf1b065611191c5403750d2a6e030a011cdc42c7705"
  ) {
    throw new Error("optional tokenizer manifest differs from the engine trust anchor");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const encoded = await readFile(path.join(packageRoot, "provider.wasm.b64"), "utf8");
  if (!encoded.endsWith("\n"))
    throw new Error("optional tokenizer artifact is not canonical base64");
  const artifact = Buffer.from(encoded.slice(0, -1), "base64");
  if (
    `${artifact.toString("base64")}\n` !== encoded ||
    sha256(artifact) !== manifest.artifact?.sha256 ||
    sha256(artifact) !== "7bc6247983e4fbd1eaa3cbd92600448d952aac151e79c5b4b87002347742fb26"
  ) {
    throw new Error("optional tokenizer artifact differs from its reviewed digest");
  }
}

export async function extractTarball(
  filename,
  destination,
  tarExecutable = packageAuditExecutables.tar,
  compressed = true,
  confinement = null,
  environment = { LC_ALL: "C", PATH: "/usr/bin:/bin" },
) {
  if (!path.isAbsolute(tarExecutable))
    throw new Error("tar extraction executable must be absolute");
  const result = await spawnReviewedAsync(
    tarExecutable,
    [compressed ? "-xzf" : "-xf", filename, "-C", destination],
    {
      encoding: "utf8",
      cwd: destination,
      env: environment,
      shell: false,
    },
    confinement,
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tar extraction failed:\n${result.stderr || result.stdout}`);
  }
}

async function main() {
  const destination = await mkdtemp(path.join(os.tmpdir(), "agent-context-lint-pack-"));
  let packedCoreFilename;
  try {
    const cleanRuntime = await packCleanCliAndCore(destination, { environment: process.env });
    for (const definition of packedPackages) {
      const sourceManifest = JSON.parse(
        await readFile(
          path.join(rootDirectory, "packages", definition.directory, "package.json"),
          "utf8",
        ),
      );
      if (
        sourceManifest.name !== definition.name ||
        (definition.private === true
          ? sourceManifest.private !== true
          : sourceManifest.private === true)
      ) {
        throw new Error(`${definition.name} source manifest has unexpected publication status`);
      }
      if (Object.keys(sourceManifest.exports ?? {}).some((entry) => entry.includes("*"))) {
        throw new Error(`${definition.name} uses a wildcard public export`);
      }

      const cleanCli =
        definition.name === "@agent-context/lint"
          ? { cleanRoot: cleanRuntime.cleanRoot, packResult: cleanRuntime.cliPackResult }
          : undefined;
      const packResult =
        definition.name === "@agent-context/core"
          ? cleanRuntime.corePackResult
          : (cleanCli?.packResult ?? (await runPnpmPack(definition.name, destination)));
      if (definition.name === "@agent-context/core") {
        packedCoreFilename = packRecord(packResult).filename;
      }
      const files = packedFilePaths(packResult);
      assertPackedFilePaths(definition, files);
      if (definition.name === "@agent-context/lint") {
        const repeatDestination = path.join(destination, "repeat-cli-pack");
        await mkdir(repeatDestination);
        const repeatResult = await runPnpmDirectoryPack(
          "packages/cli",
          repeatDestination,
          cleanCli.cleanRoot,
        );
        if (
          JSON.stringify([...files].sort()) !==
            JSON.stringify([...packedFilePaths(repeatResult)].sort()) ||
          sha256(await readFile(packRecord(packResult).filename)) !==
            sha256(await readFile(packRecord(repeatResult).filename))
        )
          throw new Error("clean CLI pack is not byte-for-byte reproducible");
        await assertCleanCompileFailure(path.join(destination, "compile-failure"));
      }

      const extractionDirectory = path.join(destination, definition.directory);
      await mkdir(extractionDirectory);
      await extractTarball(packRecord(packResult).filename, extractionDirectory);
      const stagedManifest = JSON.parse(
        await readFile(path.join(extractionDirectory, "package", "package.json"), "utf8"),
      );
      if (
        JSON.stringify(sortedRecord(stagedManifest.dependencies ?? {})) !==
        JSON.stringify(sortedRecord(definition.runtimeDependencies))
      ) {
        throw new Error(`${definition.name} has unexpected packed runtime dependencies`);
      }
      if (JSON.stringify(stagedManifest).includes("workspace:")) {
        throw new Error(`${definition.name} retains a workspace protocol in its packed manifest`);
      }
      if (stagedManifest.version !== sourceManifest.version) {
        throw new Error(`${definition.name} packed version differs from its source manifest`);
      }
      await assertProjectLicenseArtifacts(path.join(extractionDirectory, "package"));
      if (definition.executable !== undefined) {
        if (packedCoreFilename === undefined) {
          throw new Error("packed CLI verification requires the exact packed core artifact");
        }
        await installPackedCore(
          path.join(extractionDirectory, "package"),
          path.join(destination, "core", "package"),
        );
        const executable = await stat(
          path.join(extractionDirectory, "package", definition.executable),
        );
        if ((executable.mode & 0o111) === 0) {
          throw new Error(`${definition.name} CLI entry is not executable`);
        }
        await verifyPackedCli(path.join(extractionDirectory, "package"), stagedManifest.version);
        await assertCliDocumentationArtifacts(
          path.join(extractionDirectory, "package"),
          destination,
        );
        await assertCliBundleArtifacts(path.join(extractionDirectory, "package"));
        await verifyPackedDocumentationExamples(
          path.join(extractionDirectory, "package"),
          path.join(rootDirectory, "docs/api/command-reference.md"),
        );
      }
      if (definition === standardsPackage) {
        await assertBundledArtifacts(path.join(extractionDirectory, "package"));
      }
      console.log(`${definition.name} packed with ${files.size} files.`);
    }

    const definition = optionalTokenizerPackage;
    const packResult = await runPnpmDirectoryPack(definition.directory, destination);
    const files = packedFilePaths(packResult);
    assertPackedFilePaths(definition, files);
    const extractionDirectory = path.join(destination, "tokenizer-utf8-byte");
    await mkdir(extractionDirectory);
    await extractTarball(packRecord(packResult).filename, extractionDirectory);
    const packageRoot = path.join(extractionDirectory, "package");
    const stagedManifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (Object.keys(stagedManifest.exports ?? {}).some((entry) => entry.includes("*"))) {
      throw new Error(`${definition.name} uses a wildcard public export`);
    }
    await assertProjectLicenseArtifacts(packageRoot);
    await assertOptionalTokenizerArtifacts(packageRoot);
    console.log(`${definition.name} packed with ${files.size} files.`);
  } finally {
    await rm(destination, { force: true, recursive: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
