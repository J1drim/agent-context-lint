import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  packCleanCliAndCore,
  packageAuditEnvironment,
  spawnReviewedAsync,
} from "./check-packed-manifests.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;
const PACKAGE_MANAGER_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

const packageManagers = Object.freeze({
  npm: Object.freeze({
    environment: "AGENT_CONTEXT_PACK_NPM",
    runtime: "node",
    arguments: Object.freeze([
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
    ]),
  }),
  pnpm: Object.freeze({
    environment: "AGENT_CONTEXT_PACK_PNPM",
    runtime: "node",
    arguments: Object.freeze(["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"]),
  }),
  yarn: Object.freeze({
    environment: "AGENT_CONTEXT_PACK_YARN",
    runtime: "node",
    arguments: Object.freeze([
      "install",
      "--offline",
      "--ignore-scripts",
      "--non-interactive",
      "--no-lockfile",
    ]),
  }),
  bun: Object.freeze({
    environment: "AGENT_CONTEXT_PACK_BUN",
    runtime: "native",
    arguments: Object.freeze(["install", "--offline", "--ignore-scripts", "--no-save"]),
  }),
});

export const PACKAGE_MANAGER_NAMES = Object.freeze(Object.keys(packageManagers));

const compareUtf8 = (left, right) =>
  Math.sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => [key, canonicalize(value[key])]),
    );
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeErrorMessage(error) {
  if (error instanceof Error && typeof error.message === "string" && error.message.length > 0)
    return error.message.slice(0, 512);
  return "package-manager operation failed";
}

function packageManagerDescriptor(name) {
  if (typeof name !== "string" || !Object.hasOwn(packageManagers, name))
    throw new Error(`unsupported package manager: ${String(name)}`);
  return packageManagers[name];
}

/**
 * Convert an executable-admission or runtime failure to the closed reason vocabulary used by
 * the retained K09 evidence contract. Raw manager messages can contain absolute paths, command
 * output, or host-specific details; none of those belong in a matrix report or terminal summary.
 */
function classifyManagerFailure(error, fallback = "install-failed") {
  const message = error instanceof Error ? error.message : String(error);
  if (/workspace root|links back/u.test(message)) return "workspace-backlink";
  if (/tarball changed/u.test(message)) return "tarball-mutated";
  if (/regular file|executable path|absolute executable/u.test(message))
    return "invalid-executable";
  if (/runtime|identity|license|dependency|version probe|executable CLI/u.test(message))
    return "runtime-validation-failed";
  return fallback;
}

function normalizeManagerVersion(output) {
  const version = typeof output === "string" ? output.trim() : "";
  return PACKAGE_MANAGER_VERSION_PATTERN.test(version) ? version : null;
}

function normalizeNodeVersion(output) {
  const version = typeof output === "string" ? output.trim() : "";
  return /^v\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/u.test(version) ? version : null;
}

export function parsePackageManagerSelection(value) {
  if (value === undefined) return [...PACKAGE_MANAGER_NAMES];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error("--manager requires npm, pnpm, yarn, or bun");
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0 || new Set(names).size !== names.length)
    throw new Error("--manager must contain each package manager at most once");
  names.forEach(packageManagerDescriptor);
  return names;
}

export function nodeRuntimeSatisfiesReleaseRange(version = process.version) {
  if (typeof version !== "string") return false;
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 24 && minor >= 11) || major === 26;
}

export function resolveConfiguredExecutable(name, environment = process.env) {
  const descriptor = packageManagerDescriptor(name);
  const value = environment[descriptor.environment];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value))
    throw new Error(`${descriptor.environment} must be an absolute executable path`);
  return value;
}

async function assertExecutable(executable, environmentName) {
  let inspected;
  try {
    inspected = await stat(executable);
  } catch (error) {
    throw new Error(`${environmentName} is unavailable: ${safeErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!inspected.isFile() || (inspected.mode & 0o111) === 0)
    throw new Error(`${environmentName} must identify an executable regular file`);
  return realpath(executable);
}

async function assertPnpmLauncher(executable, environmentName) {
  if (!new Set([".cjs", ".mjs"]).has(path.extname(executable)))
    throw new Error(`${environmentName} must identify an exact .cjs or .mjs launcher`);
  let inspected;
  try {
    inspected = await stat(executable);
  } catch (error) {
    throw new Error(`${environmentName} is unavailable: ${safeErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!inspected.isFile()) throw new Error(`${environmentName} must identify a regular file`);
  return realpath(executable);
}

async function assertNodeLauncher(executable, environmentName) {
  if (!new Set([".js", ".cjs", ".mjs"]).has(path.extname(executable)))
    throw new Error(`${environmentName} must identify an exact .js, .cjs, or .mjs launcher`);
  let inspected;
  try {
    inspected = await stat(executable);
  } catch (error) {
    throw new Error(`${environmentName} is unavailable: ${safeErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!inspected.isFile()) throw new Error(`${environmentName} must identify a regular file`);
  return realpath(executable);
}

async function attestNodeRuntime(executable, expectedVersion, environment, installRoot) {
  let resolved;
  try {
    resolved = await assertExecutable(executable, "AGENT_CONTEXT_PACK_NODE");
  } catch {
    return Object.freeze({ ok: false, reason: "node-runtime-probe-failed" });
  }
  const result = await spawnReviewedAsync(resolved, ["--version"], {
    cwd: installRoot ?? rootDirectory,
    encoding: "utf8",
    env: cleanEnvironment(environment, installRoot),
    shell: false,
    reviewedMaximumStderrBytes: 8 * 1024,
    reviewedMaximumStdoutBytes: 8 * 1024,
    reviewedTimeoutMs: PROBE_TIMEOUT_MS,
  });
  if (result.error || result.signal !== null || result.status !== 0 || result.stderr !== "")
    return Object.freeze({ ok: false, reason: "node-runtime-probe-failed" });
  const version = normalizeNodeVersion(result.stdout);
  if (version === null) return Object.freeze({ ok: false, reason: "node-runtime-invalid" });
  if (expectedVersion !== undefined && version !== expectedVersion)
    return Object.freeze({ ok: false, reason: "node-runtime-mismatch", version });
  if (!nodeRuntimeSatisfiesReleaseRange(version))
    return Object.freeze({ ok: false, reason: "node-engine-mismatch", version });
  return Object.freeze({ ok: true, executable: resolved, version });
}

async function probeManagerVersion(name, executable, nodeExecutable, environment, installRoot) {
  const descriptor = packageManagerDescriptor(name);
  const mediated = descriptor.runtime === "node";
  const command = mediated ? nodeExecutable : executable;
  const arguments_ = mediated ? [executable, "--version"] : ["--version"];
  const result = await spawnReviewedAsync(command, arguments_, {
    cwd: installRoot ?? rootDirectory,
    encoding: "utf8",
    env: cleanEnvironment(environment, installRoot),
    shell: false,
    reviewedMaximumStderrBytes: 8 * 1024,
    reviewedMaximumStdoutBytes: 8 * 1024,
    reviewedTimeoutMs: PROBE_TIMEOUT_MS,
  });
  if (result.error || result.signal !== null || result.status !== 0 || result.stderr !== "")
    return Object.freeze({ ok: false, reason: "manager-version-probe-failed" });
  const version = normalizeManagerVersion(result.stdout);
  if (version === null) return Object.freeze({ ok: false, reason: "manager-version-invalid" });
  return Object.freeze({ ok: true, version });
}

async function expectedPnpmVersion() {
  const manifest = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
  const match = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(manifest.packageManager ?? "");
  if (match === null) throw new Error("repository packageManager must pin an exact pnpm version");
  return match[1];
}

async function assertTarball(filename, label) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || !filename.endsWith(".tgz"))
    throw new Error(`${label} must be an absolute .tgz path`);
  const inspected = await lstat(filename);
  if (!inspected.isFile() || inspected.isSymbolicLink())
    throw new Error(`${label} must be a regular non-symlink file`);
  if (inspected.size > MAX_TARBALL_BYTES)
    throw new Error(`${label} exceeds the ${MAX_TARBALL_BYTES}-byte limit`);
  const bytes = await readFile(filename);
  if (bytes.length === 0) throw new Error(`${label} is empty`);
  // Keep the path used by the package-manager child process in the same canonical
  // namespace as its real cwd. On macOS `os.tmpdir()` is commonly `/var/...` while
  // the kernel reports the child cwd as `/private/var/...`; retaining the lexical
  // spelling can otherwise turn a valid relative `file:` dependency into
  // `/private/private/...` and fail the clean install.
  return Object.freeze({ filename: await realpath(filename), sha256: sha256(bytes) });
}

function relativeFileSpecifier(from, filename) {
  // The tarballs are intentionally outside the disposable fixture. They are still
  // bound to the exact regular files admitted by assertTarball above.
  const relative = path.relative(from, filename);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    // eslint-disable-next-line no-control-regex -- package paths reject controls and bidi marks.
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(relative)
  )
    throw new Error("package fixture tarball path is unsafe");
  return `file:${relative.split(path.sep).join("/")}`;
}

async function createInstallFixture(parent, cliTarball, coreTarball) {
  const fixtureRoot = await realpath(await mkdtemp(path.join(parent, "package-install-")));
  const coreSpecifier = relativeFileSpecifier(fixtureRoot, coreTarball.filename);
  const packageJson = {
    name: "agent-context-lint-package-install-fixture",
    private: true,
    version: "1.0.0",
    dependencies: {
      "@agent-context/core": coreSpecifier,
      "@agent-context/lint": relativeFileSpecifier(fixtureRoot, cliTarball.filename),
    },
    overrides: { "@agent-context/core": coreSpecifier },
    resolutions: { "@agent-context/core": coreSpecifier },
  };
  await writeFile(path.join(fixtureRoot, "package.json"), canonicalJson(packageJson), {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    path.join(fixtureRoot, ".npmrc"),
    "audit=false\nfund=false\nignore-scripts=true\nregistry=https://registry.invalid/\n",
    { encoding: "utf8", mode: 0o600 },
  );
  // pnpm resolves a transitive exact-version dependency from its offline metadata
  // mirror even when the same package is a direct file dependency. Keep that
  // resolution local to this disposable fixture; it never changes the packed
  // manifest or the package under test. Other managers ignore this pnpm file.
  const yamlSpecifier = coreSpecifier.replaceAll("'", "''");
  await writeFile(
    path.join(fixtureRoot, "pnpm-workspace.yaml"),
    `overrides:\n  "@agent-context/core": '${yamlSpecifier}'\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return fixtureRoot;
}

function cleanEnvironment(environment, installRoot = undefined) {
  const isolated =
    typeof installRoot === "string" && path.isAbsolute(installRoot)
      ? {
          HOME: path.join(installRoot, ".home"),
          USERPROFILE: path.join(installRoot, ".home"),
          LOCALAPPDATA: path.join(installRoot, ".local-app-data"),
          APPDATA: path.join(installRoot, ".app-data"),
          XDG_CONFIG_HOME: path.join(installRoot, ".config"),
          XDG_CACHE_HOME: path.join(installRoot, ".cache"),
          npm_config_cache: path.join(installRoot, ".npm-cache"),
          npm_config_userconfig: path.join(installRoot, ".npmrc"),
          pnpm_config_store_dir: path.join(installRoot, ".pnpm-store"),
          YARN_CACHE_FOLDER: path.join(installRoot, ".yarn-cache"),
          BUN_INSTALL_CACHE_DIR: path.join(installRoot, ".bun-cache"),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(installRoot, ".bun-transpiler-cache"),
          BUN_CONFIG_DIR: path.join(installRoot, ".bun-config"),
        }
      : {};
  return packageAuditEnvironment({
    ...environment,
    ...isolated,
    CI: "true",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
    npm_config_registry: "https://registry.invalid/",
  });
}

async function fileDigest(filename) {
  return sha256(await readFile(filename));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function findBacklink(directory, forbiddenRoots) {
  const entries = await readdirSafe(directory);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(candidate);
      if (forbiddenRoots.some((root) => isWithin(root, target))) return candidate;
    } else if (entry.isDirectory()) {
      const found = await findBacklink(candidate, forbiddenRoots);
      if (found !== null) return found;
    }
  }
  return null;
}

async function readdirSafe(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function assertNoWorkspaceBacklinks(installRoot, forbiddenRoots = []) {
  if (!Array.isArray(forbiddenRoots) || forbiddenRoots.some((root) => !path.isAbsolute(root)))
    throw new Error("forbidden package roots must be absolute paths");
  const normalizedRoots = await Promise.all(forbiddenRoots.map((root) => realpath(root)));
  const nodeModules = path.join(installRoot, "node_modules");
  const backlink = await findBacklink(nodeModules, normalizedRoots);
  if (backlink !== null)
    throw new Error(`package install links back into a forbidden workspace root: ${backlink}`);
}

async function readInstalledManifest(installRoot, name) {
  const packageRoot = path.join(installRoot, "node_modules", ...name.split("/"));
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return { manifest, manifestPath, packageRoot };
}

export async function assertInstalledRuntime(installRoot, nodeExecutable = process.execPath) {
  const core = await readInstalledManifest(installRoot, "@agent-context/core");
  const cli = await readInstalledManifest(installRoot, "@agent-context/lint");
  if (core.manifest.name !== "@agent-context/core" || cli.manifest.name !== "@agent-context/lint")
    throw new Error("clean package install resolved an unexpected package identity");
  if (core.manifest.version !== "1.0.0" || cli.manifest.version !== "1.0.0")
    throw new Error("clean package install resolved an unexpected package version");
  if (core.manifest.license !== "Apache-2.0" || cli.manifest.license !== "Apache-2.0")
    throw new Error("clean package install lost the Apache-2.0 package license");
  if (
    JSON.stringify(core.manifest).includes("workspace:") ||
    JSON.stringify(cli.manifest).includes("workspace:")
  )
    throw new Error("clean package install retained a workspace protocol");
  if (cli.manifest.dependencies?.["@agent-context/core"] !== "1.0.0")
    throw new Error("clean CLI package dependency was not normalized to the packed core version");
  const executable = path.join(cli.packageRoot, "dist", "cli.js");
  const executableStat = await stat(executable);
  if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0)
    throw new Error("clean package install lost the executable CLI entry point");
  const probe = await spawnReviewedAsync(nodeExecutable, [executable, "--version"], {
    cwd: installRoot,
    encoding: "utf8",
    env: cleanEnvironment({}, installRoot),
    shell: false,
    reviewedMaximumStderrBytes: MAX_OUTPUT_BYTES,
    reviewedMaximumStdoutBytes: MAX_OUTPUT_BYTES,
    reviewedTimeoutMs: PROBE_TIMEOUT_MS,
  });
  if (probe.error) throw probe.error;
  if (probe.status !== 0 || probe.signal !== null || probe.stderr !== "")
    throw new Error("installed CLI version probe failed");
  if (!/^1\.0\.0\n$/u.test(probe.stdout))
    throw new Error("installed CLI version probe disagrees with its package manifest");
  return Object.freeze({
    cliManifestSha256: await fileDigest(cli.manifestPath),
    coreManifestSha256: await fileDigest(core.manifestPath),
  });
}

function managerResult(name, state, details = {}) {
  return Object.freeze({
    manager: name,
    runtime: packageManagerDescriptor(name).runtime,
    state,
    ...details,
  });
}

export async function runPackageManagerInstall(name, options = {}) {
  const descriptor = packageManagerDescriptor(name);
  const environment = options.environment ?? process.env;
  const installRoot =
    typeof options.installRoot === "string" ? await realpath(options.installRoot) : undefined;
  const requestedNodeVersion = options.nodeVersion ?? process.version;
  if (!nodeRuntimeSatisfiesReleaseRange(requestedNodeVersion))
    return managerResult(name, "blocked", {
      reason: "node-engine-mismatch",
      nodeVersion: requestedNodeVersion,
    });
  const nodeExecutable =
    options.nodeExecutable ?? environment.AGENT_CONTEXT_PACK_NODE ?? process.execPath;
  if (typeof nodeExecutable !== "string" || !path.isAbsolute(nodeExecutable))
    return managerResult(name, "failed", { reason: "invalid-executable" });
  const nodeRuntime = await attestNodeRuntime(
    nodeExecutable,
    requestedNodeVersion,
    environment,
    installRoot,
  );
  if (!nodeRuntime.ok)
    return managerResult(
      name,
      nodeRuntime.reason === "node-engine-mismatch" ? "blocked" : "failed",
      {
        ...(nodeRuntime.version === undefined ? {} : { nodeVersion: nodeRuntime.version }),
        reason: nodeRuntime.reason,
      },
    );
  let executable;
  try {
    executable = resolveConfiguredExecutable(name, environment);
  } catch {
    return managerResult(name, "failed", {
      nodeVersion: nodeRuntime.version,
      reason: "invalid-executable",
    });
  }
  if (executable === null)
    return managerResult(name, "unavailable", {
      nodeVersion: nodeRuntime.version,
      reason: `missing-${descriptor.environment}`,
    });
  let resolvedExecutable;
  try {
    resolvedExecutable =
      name === "pnpm"
        ? await assertPnpmLauncher(executable, descriptor.environment)
        : descriptor.runtime === "node"
          ? await assertNodeLauncher(executable, descriptor.environment)
          : await assertExecutable(executable, descriptor.environment);
  } catch (error) {
    return managerResult(name, "failed", {
      reason:
        name === "pnpm"
          ? "invalid-pnpm-launcher"
          : descriptor.runtime === "node"
            ? "invalid-node-launcher"
            : classifyManagerFailure(error, "invalid-executable"),
      nodeVersion: nodeRuntime.version,
    });
  }
  let expected;
  if (name === "pnpm") {
    try {
      expected = await expectedPnpmVersion();
    } catch {
      return managerResult(name, "failed", {
        nodeVersion: nodeRuntime.version,
        reason: "pnpm-version-probe-failed",
      });
    }
  }
  const version = await probeManagerVersion(
    name,
    resolvedExecutable,
    nodeExecutable,
    environment,
    installRoot,
  );
  if (!version.ok)
    return managerResult(name, "failed", {
      nodeVersion: nodeRuntime.version,
      reason: version.reason,
    });
  const managerVersion = version.version;
  if (expected !== undefined && managerVersion !== expected)
    return managerResult(name, "failed", {
      expectedPnpmVersion: expected,
      managerVersion,
      observedPnpmVersion: managerVersion,
      nodeVersion: nodeRuntime.version,
      reason: "pnpm-version-mismatch",
    });
  const mediated = descriptor.runtime === "node";
  const command = mediated
    ? [nodeExecutable, [resolvedExecutable, ...descriptor.arguments]]
    : [resolvedExecutable, descriptor.arguments];
  const result = await spawnReviewedAsync(command[0], command[1], {
    cwd: installRoot,
    encoding: "utf8",
    env: cleanEnvironment(environment, installRoot),
    shell: false,
    reviewedMaximumStderrBytes: MAX_OUTPUT_BYTES,
    reviewedMaximumStdoutBytes: MAX_OUTPUT_BYTES,
    reviewedTimeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
  });
  if (result.error)
    return managerResult(name, "failed", {
      managerVersion,
      nodeVersion: nodeRuntime.version,
      reason: "install-failed",
    });
  if (result.signal !== null || result.status !== 0)
    return managerResult(name, "failed", {
      managerVersion,
      nodeVersion: nodeRuntime.version,
      reason: "install-failed",
      signal: result.signal,
      status: result.status,
      stderrSha256: sha256(Buffer.from(result.stderr, "utf8")),
      stdoutSha256: sha256(Buffer.from(result.stdout, "utf8")),
      stderrBytes: Buffer.byteLength(result.stderr),
      stdoutBytes: Buffer.byteLength(result.stdout),
    });
  try {
    await assertNoWorkspaceBacklinks(installRoot, options.forbiddenRoots ?? []);
    const installed = await assertInstalledRuntime(installRoot, nodeExecutable);
    return managerResult(name, "passed", {
      managerVersion,
      nodeVersion: nodeRuntime.version,
      ...installed,
    });
  } catch (error) {
    return managerResult(name, "failed", {
      managerVersion,
      nodeVersion: nodeRuntime.version,
      reason: classifyManagerFailure(error),
    });
  }
}

function reportDigest(report) {
  const bytes = Buffer.from(canonicalJson(report), "utf8");
  if (bytes.length > MAX_REPORT_BYTES)
    throw new Error("package install report exceeds its byte cap");
  return sha256(bytes);
}

export async function runPackageInstallMatrix(options = {}) {
  const managers = parsePackageManagerSelection(options.manager);
  const parent = path.resolve(options.parent ?? os.tmpdir());
  const ownParent = options.parent === undefined;
  const temporaryParent = ownParent
    ? await mkdtemp(path.join(parent, "package-install-matrix-"))
    : parent;
  let fixtureRoot;
  try {
    let cliTarball;
    let coreTarball;
    if (options.cliTarball === undefined && options.coreTarball === undefined) {
      const packedDestination = await mkdtemp(path.join(temporaryParent, "packed-"));
      const packed = await packCleanCliAndCore(packedDestination, {
        environment: options.environment,
      });
      cliTarball = await assertTarball(packed.cliFilename, "CLI tarball");
      coreTarball = await assertTarball(packed.coreFilename, "core tarball");
    } else if (options.cliTarball === undefined || options.coreTarball === undefined) {
      throw new Error("CLI and core tarballs must be supplied together");
    } else {
      cliTarball = await assertTarball(options.cliTarball, "CLI tarball");
      coreTarball = await assertTarball(options.coreTarball, "core tarball");
    }
    const results = [];
    for (const manager of managers) {
      fixtureRoot = await createInstallFixture(temporaryParent, cliTarball, coreTarball);
      try {
        const beforeTarballs = [
          await fileDigest(cliTarball.filename),
          await fileDigest(coreTarball.filename),
        ];
        const result = await runPackageManagerInstall(manager, {
          environment: options.environment,
          installRoot: fixtureRoot,
          nodeExecutable: options.nodeExecutable ?? process.execPath,
          nodeVersion: options.nodeVersion,
          forbiddenRoots: options.forbiddenRoots ?? [rootDirectory],
          timeoutMs: options.timeoutMs,
        });
        const afterTarballs = [
          await fileDigest(cliTarball.filename),
          await fileDigest(coreTarball.filename),
        ];
        results.push(
          beforeTarballs.every((digest, index) => digest === afterTarballs[index])
            ? result
            : {
                ...result,
                reason: "tarball-mutated",
                state: "failed",
              },
        );
      } finally {
        await rm(fixtureRoot, { force: true, recursive: true });
        fixtureRoot = undefined;
      }
    }
    const passed = results.filter((entry) => entry.state === "passed").length;
    const report = {
      artifactKind: "agent-context-package-install-matrix",
      schemaVersion: "0.1.0",
      nodeVersion: options.nodeVersion ?? process.version,
      managers: results,
      selectedManagers: managers,
      strict: options.strict === true,
      tarballs: { cliSha256: cliTarball.sha256, coreSha256: coreTarball.sha256 },
    };
    const digest = reportDigest(report);
    const failures = results.filter((entry) => entry.state !== "passed");
    const success =
      options.strict === true
        ? failures.length === 0
        : passed > 0 && failures.every((entry) => entry.state === "unavailable");
    return Object.freeze({ digest, report: Object.freeze(report), success });
  } finally {
    if (fixtureRoot !== undefined) await rm(fixtureRoot, { force: true, recursive: true });
    if (ownParent) await rm(temporaryParent, { force: true, recursive: true });
  }
}

function usage() {
  return [
    "Usage: node scripts/check-package-install-matrix.mjs [--cli-tarball PATH --core-tarball PATH] [options]",
    "",
    "Options:",
    "  --manager npm,pnpm,yarn,bun  managers to exercise (default: all)",
    "  --strict                    require every selected manager to pass",
    "  --format json|terminal       output format (default: terminal)",
    "  --help                      show this message",
    "",
    "Without tarball paths, the exact clean pnpm pack flow creates both artifacts first.",
    "Each AGENT_CONTEXT_PACK_{NPM,PNPM,YARN,BUN} value must be an absolute executable path.",
    "The command never resolves package managers through PATH and never enables registry access.",
  ].join("\n");
}

function parseArguments(arguments_) {
  const options = { format: "terminal" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return { help: true };
    if (argument === "--strict") {
      options.strict = true;
      continue;
    }
    if (
      argument === "--manager" ||
      argument === "--format" ||
      argument === "--cli-tarball" ||
      argument === "--core-tarball"
    ) {
      const value = arguments_[++index];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--manager") options.manager = value;
      else if (argument === "--format") options.format = value;
      else if (argument === "--cli-tarball") options.cliTarball = path.resolve(value);
      else options.coreTarball = path.resolve(value);
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  if (!new Set(["json", "terminal"]).has(options.format))
    throw new Error("--format must be json or terminal");
  if ((options.cliTarball === undefined) !== (options.coreTarball === undefined))
    throw new Error("--cli-tarball and --core-tarball must be supplied together");
  parsePackageManagerSelection(options.manager);
  return options;
}

function renderTerminal(result) {
  const lines = [
    `Package install matrix (${result.report.nodeVersion})`,
    `Tarballs: CLI ${result.report.tarballs.cliSha256}, core ${result.report.tarballs.coreSha256}`,
  ];
  for (const entry of result.report.managers)
    lines.push(`- ${entry.manager}: ${entry.state}${entry.reason ? ` (${entry.reason})` : ""}`);
  lines.push(`Report SHA-256: ${result.digest}`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const result = await runPackageInstallMatrix(options);
    process.stdout.write(
      options.format === "json" ? canonicalJson(result.report) : renderTerminal(result),
    );
    if (!result.success) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(
      `agent-context-lint: package install matrix unavailable: ${safeErrorMessage(error)}\n`,
    );
    process.stderr.write("Run with --help for usage.\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
