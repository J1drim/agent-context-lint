import { createHash, randomBytes } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { verifyBaseDescriptors, verifyInputDirectory } from "./container/runtime-inputs.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(moduleDirectory, "../..");
export const executionReceiptPath = path.join(
  repositoryRoot,
  "tools/standards/evidence/recovery-tabletop-execution.v1.json",
);
export const excludedSourcePaths = Object.freeze([
  "IMPLEMENTATION_STATUS.md",
  "tools/standards/evidence/recovery-tabletop-execution.v1.json",
  "tools/standards/evidence/recovery-tabletop.v1.json",
]);
const schema = JSON.parse(
  readFileSync(
    path.join(moduleDirectory, "schemas/recovery-tabletop-execution.v1.schema.json"),
    "utf8",
  ),
);
const runtimeLock = JSON.parse(
  readFileSync(path.join(moduleDirectory, "container/runtime-lock.v1.json"), "utf8"),
);
const buildLockBytes = readFileSync(path.join(moduleDirectory, "container/build-lock.v1.json"));
const buildLock = JSON.parse(buildLockBytes);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

export const MAX_TRACKED_FILES = 4_096;
export const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
export const OVERALL_DEADLINE_MS = 300_000;
const PROCESS_CLEANUP_DEADLINE_MS = 3_000;
const COMMAND_DEADLINES = Object.freeze({
  "package-audit": 180_000,
  "standards-tools": 60_000,
  "tuf-trust": 60_000,
});
const expectedPackageInventory = Object.freeze([
  Object.freeze({ files: 91, package: "@agent-context/core" }),
  Object.freeze({ files: 37, package: "@agent-context/lint" }),
  Object.freeze({ files: 64, package: "@agent-context/standards" }),
  Object.freeze({ files: 6, package: "@agent-context/tokenizer-utf8-byte" }),
]);
const expectedStandardsTestFiles = Object.freeze([
  "tools/standards/maintainer-review-bundle.test.mjs",
  "tools/standards/upstream-review.test.mjs",
  "tools/standards/upstream-snapshotter.test.mjs",
  "tools/standards/validate-maintainer-workflow.test.mjs",
]);
const expectedTestInventorySha256 = Object.freeze({
  "standards-tools": "cbf1f16cd06e2827629e37739a62e9b8a5100d03a37b3998620a91ec960f67d7",
  "tuf-trust": "7185dd0c646bc34f8e1c1719ffba535a0a1cf00e3701fc97854aee7756d2b7f3",
});
const expectedCommandArgv = Object.freeze({
  "package-audit": Object.freeze(["$NODE", "scripts/check-packed-manifests.mjs"]),
  "standards-tools": Object.freeze([
    "$NODE",
    "--test",
    "--test-reporter=tap",
    ...expectedStandardsTestFiles,
  ]),
  "tuf-trust": Object.freeze([
    "$NODE",
    "node_modules/vitest/vitest.mjs",
    "run",
    "packages/standards/test/tuf-trust.unit.test.ts",
    "--reporter=json",
    "--outputFile=$TEMP/vitest.json",
  ]),
});
const expectedContainerToolchain = Object.freeze({
  canonicalJson: "2.0.0",
  executables: Object.freeze({
    git: Object.freeze({
      path: "/usr/bin/git",
      sha256: "54af380ba6ca1b36305358e99427a31ae4b0af5dc5cb6d0198c6f2f16e97651d",
    }),
    node: Object.freeze({
      path: "/usr/local/bin/node",
      sha256: "a990a8ae388fc285ddbce280e63fca48cfd7695f632b66aec6ed581566eace99",
    }),
    pnpm: Object.freeze({
      path: "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
      sha256: "67b035e322203961795e8e34ca63a08c37a4386eda94107fb3d28f3246d882ad",
    }),
    shell: Object.freeze({
      path: "/bin/sh",
      sha256: "15fc4c72f49c86639a383121eec6fbdbcd32ec9d03db915cb3096928295e1a17",
    }),
    tar: Object.freeze({
      path: "/usr/bin/tar",
      sha256: "fa2df5eddc2295398bf869b103818b45184cfaa99ec66ae1af7ed3bdf4c94423",
    }),
  }),
  git: "git version 2.39.5",
  node: "24.18.1",
  packageManager: "pnpm@11.18.0",
  pnpm: "11.18.0",
  tufModels: "4.0.0",
  typescript: "6.0.2",
  vitest: "4.1.10",
});
const approvedTools = Object.freeze({
  docker: Object.freeze({
    darwin: Object.freeze({
      path: "/opt/homebrew/Cellar/docker/29.5.2/bin/docker",
      sha256: "03a3ffd8b6966ca34a4c62f0479e61cbe2846900a2a14acdd557f8535a2f4b77",
    }),
  }),
  git: Object.freeze({
    path: "/usr/bin/git",
    sha256: "179301dcb41ea78accc3fa0048a7e6f6710d891945a751a34addd622020c1818",
    sealedSha256: "524bfef638734dc694682d3737f0487e2b6f3a2b57522e6d1e54b6b0e474ddfe",
  }),
  codesign: Object.freeze({
    path: "/usr/bin/codesign",
    sha256: "214d455584d19abc0d74d02b9cbc7d3da6bdcb0596c235e6156dd9ed2f4e1ba7",
  }),
});

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export class ContainmentUnsupportedError extends Error {
  constructor(containment) {
    super(`H13 current capture unsupported: ${containment.reason}`);
    this.name = "ContainmentUnsupportedError";
    this.containment = containment;
  }
}

export function assertContainmentSupported(containment) {
  if (containment?.status !== "supported") throw new ContainmentUnsupportedError(containment);
}

export function createDeadline(timeoutMs = OVERALL_DEADLINE_MS) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > OVERALL_DEADLINE_MS)
    throw new Error("execution receipt overall deadline is invalid");
  return Object.freeze({ expiresAt: performance.now() + timeoutMs });
}

function remainingDeadline(deadline, phase) {
  const remaining = Math.floor(deadline.expiresAt - performance.now());
  if (remaining < 1)
    throw new Error(`execution receipt exceeded its overall deadline during ${phase}`);
  return remaining;
}

async function terminateProcessTree(child, deadline) {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    return;
  }
  await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(
      () => {
        killer.kill("SIGKILL");
        resolve();
      },
      Math.min(PROCESS_CLEANUP_DEADLINE_MS, remainingDeadline(deadline, "Windows tree cleanup")),
    );
    timer.unref();
    killer.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    killer.once("error", () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve();
    });
  });
}

export async function runBounded(argv, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > OVERALL_DEADLINE_MS ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_COMMAND_OUTPUT_BYTES
  )
    throw new Error("execution receipt subprocess bounds are invalid");
  const absoluteDeadline =
    options.deadline ?? Object.freeze({ expiresAt: performance.now() + timeoutMs + 3_000 });
  const commandTimeoutMs = Math.min(
    timeoutMs,
    remainingDeadline(absoluteDeadline, "subprocess start"),
  );
  const started = performance.now();
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd ?? repositoryRoot,
    detached: process.platform !== "win32",
    env: options.env ?? { ...process.env, NO_COLOR: "1" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let outputExceeded = false;
  let cleanupTimer;
  let rejectCleanup;
  let terminationPromise;
  const forcedCleanup = new Promise((_, reject) => {
    rejectCleanup = reject;
  });
  const requestTermination = () => {
    if (terminationPromise !== undefined) return;
    terminationPromise = terminateProcessTree(child, absoluteDeadline).catch(rejectCleanup);
    cleanupTimer = setTimeout(
      () => rejectCleanup(new Error("execution receipt subprocess cleanup exceeded its deadline")),
      Math.min(
        PROCESS_CLEANUP_DEADLINE_MS,
        remainingDeadline(absoluteDeadline, "subprocess cleanup"),
      ),
    );
    cleanupTimer.unref();
  };
  const collect = (target) => (chunk) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > maxOutputBytes) {
      outputExceeded = true;
      requestTermination();
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  let spawnError;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    requestTermination();
  }, commandTimeoutMs);
  timeout.unref();
  const result = await Promise.race([closed, forcedCleanup]);
  if (terminationPromise !== undefined) await terminationPromise;
  clearTimeout(timeout);
  clearTimeout(cleanupTimer);
  const durationMs = Math.max(0, Math.ceil(performance.now() - started));
  if (spawnError !== undefined) throw spawnError;
  if (outputExceeded) throw new Error("execution receipt subprocess output exceeds its byte limit");
  const stdoutBytes = Buffer.concat(stdout);
  const stderrBytes = Buffer.concat(stderr);
  const encoding = Object.hasOwn(options, "encoding") ? options.encoding : "utf8";
  return Object.freeze({
    durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    stderr: encoding === null ? stderrBytes : stderrBytes.toString(encoding),
    stdout: encoding === null ? stdoutBytes : stdoutBytes.toString(encoding),
    timedOut,
  });
}

function sanitizedGitEnvironment() {
  return Object.freeze({
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_KEY_2: "submodule.recurse",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_VALUE_1: os.devNull,
    GIT_CONFIG_VALUE_2: "false",
    GIT_OPTIONAL_LOCKS: "0",
    HOME: repositoryRoot,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: os.tmpdir(),
  });
}

async function runGit(argv, deadline = createDeadline(30_000)) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-git-"));
  try {
    const git = await sealApprovedExecutable(
      "git",
      approvedTools.git.path,
      approvedTools.git.sha256,
      directory,
      deadline,
      { adHocSignOnDarwin: true, sealedSha256: approvedTools.git.sealedSha256 },
    );
    const result = await runBounded([git.path, "-C", repositoryRoot, ...argv], {
      deadline,
      encoding: null,
      env: sanitizedGitEnvironment(),
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      timeoutMs: Math.min(10_000, remainingDeadline(deadline, "Git command")),
    });
    await git.assertUnchanged(deadline);
    return result;
  } finally {
    await cleanupWithinDeadline(directory, deadline);
  }
}

async function gitOutput(argv, deadline) {
  const result = await runGit(argv, deadline);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut)
    throw new Error("execution receipt could not inspect Git source closure");
  if (!(result.stdout instanceof Uint8Array) || result.stdout.byteLength > MAX_GIT_OUTPUT_BYTES)
    throw new Error("execution receipt Git output exceeds its byte limit");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new Error("execution receipt Git output must be valid UTF-8");
  }
}

function closurePathspec() {
  return [".", ...excludedSourcePaths.map((entry) => `:(exclude)${entry}`)];
}

function statIdentity(value) {
  return `${value.dev}:${value.ino}:${value.mode}:${value.mtimeNs}:${value.ctimeNs}`;
}

async function deadlineReadFile(handle, deadline, phase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingDeadline(deadline, phase));
  timer.unref();
  try {
    return await handle.readFile({ signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function inspectApprovedExecutable(name, executablePath, expectedDigest, deadline) {
  remainingDeadline(deadline, `${name} identity`);
  if (!path.isAbsolute(executablePath))
    throw new Error(`execution receipt ${name} path must be absolute`);
  const pathState = await lstat(executablePath, { bigint: true });
  if (!pathState.isFile() || pathState.isSymbolicLink())
    throw new Error(`execution receipt refuses unapproved ${name} executable type`);
  const handle = await open(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  let identity;
  try {
    const before = await handle.stat({ bigint: true });
    bytes = await deadlineReadFile(handle, deadline, `${name} hashing`);
    const after = await handle.stat({ bigint: true });
    identity = statIdentity(after);
    if (statIdentity(before) !== identity || after.size !== BigInt(bytes.byteLength))
      throw new Error(`execution receipt detected concurrent ${name} executable change`);
  } finally {
    await handle.close();
  }
  const digest = sha256(bytes);
  if (digest !== expectedDigest)
    throw new Error(`execution receipt ${name} executable digest is not approved`);
  return Object.freeze({ digest, identity, path: executablePath });
}

export async function sealApprovedExecutable(
  name,
  executablePath,
  expectedDigest,
  privateDirectory,
  deadline,
  options = {},
) {
  const inspected = await inspectApprovedExecutable(name, executablePath, expectedDigest, deadline);
  const source = await open(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const sealedPath = path.join(privateDirectory, name);
  const destination = await open(
    sealedPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o500,
  );
  try {
    const before = await source.stat({ bigint: true });
    const bytes = await deadlineReadFile(source, deadline, `${name} sealing`);
    if (sha256(bytes) !== expectedDigest)
      throw new Error(`execution receipt detected ${name} replacement while sealing`);
    await destination.writeFile(bytes);
    await destination.sync();
    const after = await source.stat({ bigint: true });
    if (statIdentity(before) !== statIdentity(after) || inspected.identity !== statIdentity(after))
      throw new Error(`execution receipt detected concurrent ${name} executable replacement`);
  } finally {
    await Promise.allSettled([source.close(), destination.close()]);
  }
  let sealedDigest = expectedDigest;
  if (options.adHocSignOnDarwin === true && process.platform === "darwin") {
    const signer = await inspectApprovedExecutable(
      "codesign",
      approvedTools.codesign.path,
      approvedTools.codesign.sha256,
      deadline,
    );
    const signerState = await lstat(signer.path, { bigint: true });
    if (signerState.uid !== 0n || (signerState.mode & 0o22n) !== 0n)
      throw new Error("execution receipt refuses mutable codesign authority");
    await chmod(sealedPath, 0o700);
    const signed = await runBounded([signer.path, "--force", "--sign", "-", sealedPath], {
      deadline,
      maxOutputBytes: 64 * 1024,
      timeoutMs: Math.min(10_000, remainingDeadline(deadline, `${name} ad-hoc signing`)),
    });
    if (signed.exitCode !== 0 || signed.signal !== null || signed.timedOut)
      throw new Error(`execution receipt could not sign sealed ${name} executable`);
    sealedDigest = options.sealedSha256;
    if (!/^[0-9a-f]{64}$/u.test(sealedDigest))
      throw new Error(`execution receipt lacks approved sealed ${name} digest`);
  }
  await chmod(sealedPath, 0o500);
  const sealed = await inspectApprovedExecutable(name, sealedPath, sealedDigest, deadline);
  const sealedState = await lstat(sealedPath, { bigint: true });
  if (sealedState.nlink !== 1n)
    throw new Error(`execution receipt refuses hard-linked sealed ${name} executable`);
  return Object.freeze({
    ...sealed,
    async assertUnchanged(currentDeadline) {
      const current = await inspectApprovedExecutable(
        name,
        sealedPath,
        sealedDigest,
        currentDeadline,
      );
      const state = await lstat(sealedPath, { bigint: true });
      if (current.identity !== sealed.identity || state.nlink !== 1n)
        throw new Error(`execution receipt detected sealed ${name} executable replacement`);
    },
  });
}

export async function probeExecutionContainment({ deadline = createDeadline(10_000) } = {}) {
  const checkedAt = new Date().toISOString();
  const unsupported = (reason) =>
    Object.freeze({
      capabilityCheckedAt: checkedAt,
      mechanism: "docker-linux-pid-namespace-v1",
      reason,
      status: "unsupported",
    });
  const platformApproval = approvedTools.docker[process.platform];
  if (platformApproval === undefined) return unsupported("platform-unsupported");
  let directory;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-docker-"));
    const docker = await sealApprovedExecutable(
      "docker",
      platformApproval.path,
      platformApproval.sha256,
      directory,
      deadline,
    );
    const version = await runBounded([docker.path, "version", "--format", "{{json .}}"], {
      deadline,
      maxOutputBytes: 64 * 1024,
      timeoutMs: Math.min(5_000, remainingDeadline(deadline, "Docker capability probe")),
    });
    await docker.assertUnchanged(deadline);
    if (version.exitCode !== 0 || version.signal !== null || version.timedOut)
      return unsupported("docker-daemon-unavailable");
    let identity;
    try {
      identity = JSON.parse(version.stdout);
    } catch {
      return unsupported("docker-daemon-unavailable");
    }
    if (
      identity?.Client?.Version !== "29.5.2" ||
      identity?.Client?.GitCommit !== "79eb04c7d8" ||
      identity?.Server?.Version !== "29.5.2" ||
      identity?.Server?.GitCommit !== "568f755" ||
      identity?.Server?.Os !== "linux" ||
      identity?.Server?.Arch !== "arm64"
    )
      return unsupported("docker-daemon-unavailable");
    const runtime = runtimeLock.runtimeImage;
    try {
      if (sha256(buildLockBytes) !== runtimeLock.buildLockSha256)
        throw new Error("runtime build lock digest differs from the runtime lock");
      await verifyBaseDescriptors(path.join(moduleDirectory, "container"), buildLock.baseImage);
      await verifyInputDirectory(
        path.join(repositoryRoot, ".h13-runtime-inputs-reviewed"),
        buildLock.buildInputs.manifestSha256,
        await readFile(path.join(repositoryRoot, "pnpm-lock.yaml")),
        buildLock.packageManager,
        {
          deadline,
          preparationSourceManifestSha256: buildLock.buildInputs.preparationSourceManifestSha256,
        },
      );
    } catch {
      return unsupported("pinned-runtime-inputs-unavailable");
    }
    const imageReference = `${runtime.localReference}@${runtime.repoDigest}`;
    const imageProbe = await runBounded(
      [docker.path, "image", "inspect", imageReference, "--format", "{{json .}}"],
      {
        deadline,
        maxOutputBytes: 256 * 1024,
        timeoutMs: Math.min(5_000, remainingDeadline(deadline, "runtime image probe")),
      },
    );
    await docker.assertUnchanged(deadline);
    if (imageProbe.exitCode !== 0 || imageProbe.signal !== null || imageProbe.timedOut)
      return unsupported("pinned-offline-runtime-unavailable");
    let image;
    try {
      image = JSON.parse(imageProbe.stdout);
    } catch {
      return unsupported("pinned-offline-runtime-unavailable");
    }
    const expectedRepoDigest = `${runtime.localReference.split(":")[0]}@${runtime.repoDigest}`;
    if (
      image?.Os !== "linux" ||
      image?.Architecture !== "arm64" ||
      image?.Descriptor?.digest !== runtime.platformManifestDigest ||
      image?.Descriptor?.annotations?.["config.digest"] !== runtime.configurationDigest ||
      canonicalJson(image?.RootFS?.Layers) !== canonicalJson(runtime.layerDiffIds) ||
      image?.Size !== runtime.sizeBytes ||
      !image?.RepoDigests?.includes(expectedRepoDigest)
    )
      return unsupported("pinned-offline-runtime-unavailable");
    return Object.freeze({
      capabilityCheckedAt: checkedAt,
      dockerClient: Object.freeze({
        gitCommit: identity.Client.GitCommit,
        sha256: platformApproval.sha256,
        version: identity.Client.Version,
      }),
      dockerServer: Object.freeze({
        architecture: identity.Server.Arch,
        gitCommit: identity.Server.GitCommit,
        operatingSystem: identity.Server.Os,
        version: identity.Server.Version,
      }),
      mechanism: "docker-linux-pid-namespace-v1",
      runtimeImage: Object.freeze({
        baseConfigurationDigest: buildLock.baseImage.configurationDigest,
        baseIndexDigest: buildLock.baseImage.indexDigest,
        basePlatformManifestDigest: buildLock.baseImage.platformManifestDigest,
        buildInputManifestSha256: buildLock.buildInputs.manifestSha256,
        preparationReviewSha256: buildLock.buildInputs.preparationReviewSha256,
        preparationSourceManifestSha256: buildLock.buildInputs.preparationSourceManifestSha256,
        buildLockSha256: runtimeLock.buildLockSha256,
        configurationDigest: runtime.configurationDigest,
        layerDiffIds: runtime.layerDiffIds,
        platformManifestDigest: runtime.platformManifestDigest,
        repoDigest: runtime.repoDigest,
        repository: runtime.localReference.split(":")[0],
        sourceDateEpoch: buildLock.buildInputs.sourceDateEpoch,
        sizeBytes: runtime.sizeBytes,
      }),
      status: "supported",
    });
  } catch (error) {
    if (error?.code === "ENOENT") return unsupported("docker-client-unavailable");
    return unsupported("docker-daemon-unavailable");
  } finally {
    if (directory !== undefined) await cleanupWithinDeadline(directory, deadline);
  }
}

let containerSequence = 0;

const H13_NONCE_LABEL = "agent-context.h13.nonce";
const H13_OWNER_LABEL = "agent-context.h13.owner";
const H13_OWNER = "recovery-capture-v1";
const containerTmpfs = Object.freeze({
  "/tmp": "rw,exec,nosuid,nodev,size=2147483648,mode=0700,uid=65532,gid=65532",
  "/workspace": "rw,exec,nosuid,nodev,size=2147483648,mode=0700,uid=65532,gid=65532",
});

function expectedConfinement(runtime, command) {
  return {
    config: {
      attachStderr: true,
      attachStdin: false,
      attachStdout: true,
      command: ["/opt/h13/runner.mjs", "--command", command],
      domainname: "",
      entrypoint: ["/usr/local/bin/node"],
      image: `${runtime.repository}@${runtime.repoDigest}`,
      labels: [H13_NONCE_LABEL, H13_OWNER_LABEL],
      openStdin: false,
      stdinOnce: false,
      tty: false,
      user: "65532:65532",
      workingDirectory: "/opt/h13/repo",
    },
    hostConfig: {
      autoRemove: false,
      capAdd: null,
      capDrop: ["ALL"],
      cgroupNamespaceMode: "private",
      init: true,
      ipcMode: "none",
      memory: 4_294_967_296,
      memorySwap: 4_294_967_296,
      nanoCpus: 2_000_000_000,
      networkMode: "none",
      pidMode: "private",
      pidsLimit: 128,
      privileged: false,
      publishAllPorts: false,
      readonlyRootFilesystem: true,
      restartPolicy: { maximumRetryCount: 0, name: "no" },
      securityOptions: ["no-new-privileges=true"],
      tmpfs: containerTmpfs,
    },
    imageConfigurationDigest: runtime.configurationDigest,
    imageManifestDigest: runtime.platformManifestDigest,
    mounts: [
      {
        destination: "/input",
        mode: "",
        propagation: "rprivate",
        readWrite: false,
        source: repositoryRoot,
        type: "bind",
      },
    ],
    networkSettings: { networks: ["none"], publishedPorts: [] },
    pullPolicy: "never",
  };
}

export function normalizeContainerConfinement(container) {
  const labels = container?.Config?.Labels;
  if (
    labels === null ||
    typeof labels !== "object" ||
    typeof labels[H13_NONCE_LABEL] !== "string" ||
    !/^[0-9a-f]{32}$/u.test(labels[H13_NONCE_LABEL]) ||
    labels[H13_OWNER_LABEL] !== H13_OWNER ||
    Object.keys(labels).sort().join(",") !== [H13_NONCE_LABEL, H13_OWNER_LABEL].sort().join(",")
  )
    throw new Error("contained command labels differ from the accountable identity");
  return {
    config: {
      attachStderr: container.Config.AttachStderr,
      attachStdin: container.Config.AttachStdin,
      attachStdout: container.Config.AttachStdout,
      command: container.Config.Cmd,
      domainname: container.Config.Domainname,
      entrypoint: container.Config.Entrypoint,
      image: container.Config.Image,
      labels: Object.keys(labels).sort(),
      openStdin: container.Config.OpenStdin,
      stdinOnce: container.Config.StdinOnce,
      tty: container.Config.Tty,
      user: container.Config.User,
      workingDirectory: container.Config.WorkingDir,
    },
    hostConfig: {
      autoRemove: container.HostConfig.AutoRemove,
      capAdd: container.HostConfig.CapAdd,
      capDrop: container.HostConfig.CapDrop,
      cgroupNamespaceMode: container.HostConfig.CgroupnsMode,
      init: container.HostConfig.Init,
      ipcMode: container.HostConfig.IpcMode,
      memory: container.HostConfig.Memory,
      memorySwap: container.HostConfig.MemorySwap,
      nanoCpus: container.HostConfig.NanoCpus,
      networkMode: container.HostConfig.NetworkMode,
      pidMode: container.HostConfig.PidMode === "" ? "private" : container.HostConfig.PidMode,
      pidsLimit: container.HostConfig.PidsLimit,
      privileged: container.HostConfig.Privileged,
      publishAllPorts: container.HostConfig.PublishAllPorts,
      readonlyRootFilesystem: container.HostConfig.ReadonlyRootfs,
      restartPolicy: {
        maximumRetryCount: container.HostConfig.RestartPolicy?.MaximumRetryCount,
        name: container.HostConfig.RestartPolicy?.Name,
      },
      securityOptions: container.HostConfig.SecurityOpt,
      tmpfs: container.HostConfig.Tmpfs,
    },
    imageConfigurationDigest: container.ImageManifestDescriptor?.annotations?.["config.digest"],
    imageManifestDigest: container.ImageManifestDescriptor?.digest,
    mounts: (container.Mounts ?? []).map((mount) => ({
      destination: mount.Destination,
      mode: mount.Mode,
      propagation: mount.Propagation,
      readWrite: mount.RW,
      source: mount.Source,
      type: mount.Type,
    })),
    networkSettings: {
      networks: Object.keys(container.NetworkSettings?.Networks ?? {}).sort(),
      publishedPorts: Object.keys(container.NetworkSettings?.Ports ?? {}).sort(),
    },
    pullPolicy: "never",
  };
}

export function assertContainerConfinement(container, runtime, command) {
  const actual = normalizeContainerConfinement(container);
  const expected = expectedConfinement(runtime, command);
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error("contained command actual confinement differs from accountable policy");
  const normalized = structuredClone(actual);
  normalized.config.command = ["/opt/h13/runner.mjs", "--command", "$COMMAND"];
  normalized.mounts[0].source = "$REPOSITORY_ROOT";
  assertConfinementConfiguration(normalized, runtime);
  return Object.freeze({
    details: Object.freeze(normalized),
    sha256: sha256(Buffer.from(canonicalJson(normalized), "utf8")),
  });
}

export function assertConfinementConfiguration(configuration, runtime) {
  const accountableRuntime =
    runtime ??
    Object.freeze({
      ...runtimeLock.runtimeImage,
      repository: runtimeLock.runtimeImage.localReference.split(":")[0],
    });
  const expected = expectedConfinement(accountableRuntime, "$COMMAND");
  expected.mounts[0].source = "$REPOSITORY_ROOT";
  if (canonicalJson(configuration) !== canonicalJson(expected))
    throw new Error(
      `execution receipt confinement configuration differs from accountable policy: ${JSON.stringify(
        {
          actualSha256: sha256(Buffer.from(canonicalJson(configuration), "utf8")),
          expectedSha256: sha256(Buffer.from(canonicalJson(expected), "utf8")),
          paths: differingPaths(configuration, expected),
        },
      )}`,
    );
}

function differingPaths(actual, expected, path_ = "$", differences = []) {
  if (differences.length >= 32) return differences;
  if (
    actual === null ||
    expected === null ||
    typeof actual !== "object" ||
    typeof expected !== "object"
  ) {
    if (canonicalJson(actual) !== canonicalJson(expected)) differences.push(path_);
    return differences;
  }
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  for (const key of keys) {
    if (!(key in actual) || !(key in expected)) differences.push(`${path_}.${key}`);
    else differingPaths(actual[key], expected[key], `${path_}.${key}`, differences);
    if (differences.length >= 32) break;
  }
  return differences;
}

async function listLabeledContainers(docker, name, nonce, deadline) {
  const listed = await runBounded(
    [
      docker.path,
      "container",
      "list",
      "--all",
      "--filter",
      `label=${H13_NONCE_LABEL}=${nonce}`,
      "--filter",
      `label=${H13_OWNER_LABEL}=${H13_OWNER}`,
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.ID}}",
    ],
    {
      deadline,
      maxOutputBytes: 64 * 1024,
      timeoutMs: Math.min(5_000, remainingDeadline(deadline, "container reconciliation") - 1),
    },
  );
  if (listed.exitCode !== 0 || listed.signal !== null || listed.timedOut)
    throw new Error("execution receipt could not reconcile container identity");
  const identities = listed.stdout.split(/\r?\n/u).filter(Boolean);
  if (identities.some((identity) => !/^[0-9a-f]{12,64}$/u.test(identity)) || identities.length > 1)
    throw new Error("execution receipt received ambiguous container identities");
  return identities;
}

async function reconcileContainer(docker, name, nonce, deadline, allowSchedulingMargin) {
  const attempts = allowSchedulingMargin ? 20 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const identities = await listLabeledContainers(docker, name, nonce, deadline);
    if (identities.length === 1) return identities[0];
    if (attempt + 1 < attempts)
      await delay(Math.min(250, remainingDeadline(deadline, "container scheduling margin") - 1));
  }
  return undefined;
}

async function assertContainerNameAvailable(docker, name, deadline) {
  const listed = await runBounded(
    [
      docker.path,
      "container",
      "list",
      "--all",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.ID}}",
    ],
    {
      deadline,
      maxOutputBytes: 64 * 1024,
      timeoutMs: Math.min(5_000, remainingDeadline(deadline, "container name preflight") - 1),
    },
  );
  if (
    listed.exitCode !== 0 ||
    listed.signal !== null ||
    listed.timedOut ||
    listed.stdout.trim() !== ""
  )
    throw new Error("execution receipt container name is unavailable");
}

async function inspectContainer(docker, identity, deadline, phase) {
  const inspected = await runBounded(
    [docker.path, "container", "inspect", identity, "--format", "{{json .}}"],
    {
      deadline,
      maxOutputBytes: 256 * 1024,
      timeoutMs: Math.min(5_000, remainingDeadline(deadline, phase) - 1),
    },
  );
  if (inspected.exitCode !== 0 || inspected.signal !== null || inspected.timedOut)
    throw new Error(`execution receipt could not ${phase}`);
  try {
    return JSON.parse(inspected.stdout);
  } catch (error) {
    throw new Error(`execution receipt received malformed ${phase}`, { cause: error });
  }
}

async function removeOwnedContainer(docker, container, runtime, name, nonce, deadline) {
  if (
    container?.Name !== `/${name}` ||
    container?.Config?.Labels?.[H13_NONCE_LABEL] !== nonce ||
    container?.Config?.Labels?.[H13_OWNER_LABEL] !== H13_OWNER ||
    container?.Config?.Image !== `${runtime.repository}@${runtime.repoDigest}` ||
    container?.ImageManifestDescriptor?.digest !== runtime.platformManifestDigest ||
    container?.ImageManifestDescriptor?.annotations?.["config.digest"] !==
      runtime.configurationDigest ||
    !/^[0-9a-f]{64}$/u.test(container?.Id)
  )
    throw new Error("execution receipt refuses cleanup of an unowned container identity");
  const removed = await runBounded(
    [docker.path, "container", "rm", "--force", "--volumes", container.Id],
    {
      deadline,
      maxOutputBytes: 64 * 1024,
      timeoutMs: Math.min(10_000, remainingDeadline(deadline, "container removal") - 1),
    },
  );
  if (removed.exitCode !== 0 || removed.signal !== null || removed.timedOut)
    throw new Error("execution receipt could not remove the contained process tree");
  if ((await listLabeledContainers(docker, name, nonce, deadline)).length !== 0)
    throw new Error("execution receipt detected a residual contained process tree");
}

async function runContainedCommand(
  docker,
  containment,
  command,
  deadline,
  timeoutMs,
  maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
  testCreateAdversary,
) {
  const runtime = containment.runtimeImage;
  const imageReference = `${runtime.repository}@${runtime.repoDigest}`;
  containerSequence += 1;
  const nonce = randomBytes(16).toString("hex");
  const containerName = `agent-context-h13-${process.pid}-${containerSequence}-${nonce}`;
  let container;
  let commandResult;
  let cleanupError;
  let primaryError;
  try {
    await assertContainerNameAvailable(docker, containerName, deadline);
    let create;
    try {
      create = await runBounded(
        [
          docker.path,
          "container",
          "create",
          "--name",
          containerName,
          "--label",
          `${H13_NONCE_LABEL}=${nonce}`,
          "--label",
          `${H13_OWNER_LABEL}=${H13_OWNER}`,
          "--pull",
          "never",
          "--network",
          "none",
          "--pid=",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges=true",
          "--pids-limit",
          "128",
          "--memory",
          "4294967296",
          "--memory-swap",
          "4294967296",
          "--cpus",
          "2",
          "--ipc",
          "none",
          "--init",
          "--user",
          "65532:65532",
          "--tmpfs",
          "/workspace:rw,exec,nosuid,nodev,size=2147483648,mode=0700,uid=65532,gid=65532",
          "--tmpfs",
          "/tmp:rw,exec,nosuid,nodev,size=2147483648,mode=0700,uid=65532,gid=65532",
          "--mount",
          `type=bind,src=${repositoryRoot},dst=/input,readonly`,
          "--entrypoint",
          "/usr/local/bin/node",
          imageReference,
          "/opt/h13/runner.mjs",
          "--command",
          command,
        ],
        {
          deadline,
          maxOutputBytes: 64 * 1024,
          timeoutMs:
            testCreateAdversary === "timeout"
              ? 1
              : Math.min(10_000, remainingDeadline(deadline, "container creation") - 1),
        },
      );
      if (testCreateAdversary === "malformed-stdout") create = { ...create, stdout: "hostile" };
      if (testCreateAdversary === "transport-error")
        throw new Error("simulated lost create transport after daemon acceptance");
    } catch (error) {
      primaryError = error;
    }
    const reconciled = await reconcileContainer(docker, containerName, nonce, deadline, true);
    if (reconciled !== undefined)
      container = await inspectContainer(
        docker,
        reconciled,
        deadline,
        "inspect reconciled container identity",
      );
    if (primaryError === undefined) {
      if (
        create.exitCode !== 0 ||
        create.signal !== null ||
        create.timedOut ||
        !/^[0-9a-f]{64}$/u.test(create.stdout.trim()) ||
        container === undefined ||
        create.stdout.trim() !== container.Id
      )
        throw new Error("execution receipt could not establish the created container identity");
    } else throw primaryError;
    const confinement = assertContainerConfinement(container, runtime, command);
    const cleanupReserve = 20_000;
    const commandBudget = Math.min(
      timeoutMs,
      remainingDeadline(deadline, `${command} containment`) - cleanupReserve,
    );
    if (commandBudget < 1)
      throw new Error("execution receipt lacks time for contained command cleanup");
    const result = await runBounded([docker.path, "container", "start", "--attach", container.Id], {
      deadline,
      maxOutputBytes,
      timeoutMs: commandBudget,
    });
    const state = await runBounded(
      [docker.path, "container", "inspect", container.Id, "--format", "{{json .State}}"],
      {
        deadline,
        maxOutputBytes: 64 * 1024,
        timeoutMs: Math.min(5_000, remainingDeadline(deadline, "container state") - 1),
      },
    );
    if (state.exitCode !== 0 || state.signal !== null || state.timedOut)
      throw new Error("execution receipt could not inspect contained command state");
    let stateRecord;
    try {
      stateRecord = JSON.parse(state.stdout);
    } catch {
      throw new Error("execution receipt received malformed container state");
    }
    commandResult = Object.freeze({
      ...result,
      exitCode: stateRecord.ExitCode,
      signal: null,
      timedOut: result.timedOut,
      confinement,
    });
  } catch (error) {
    primaryError = error;
  }
  if (container !== undefined) {
    try {
      const current = await inspectContainer(
        docker,
        container.Id,
        deadline,
        "inspect container before mandatory cleanup",
      );
      await removeOwnedContainer(docker, current, runtime, containerName, nonce, deadline);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== undefined && cleanupError !== undefined)
    throw new AggregateError(
      [primaryError, cleanupError],
      "contained command and mandatory process-tree cleanup both failed",
      { cause: primaryError },
    );
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return commandResult;
}

async function recordDirectoryAncestry(absolutePath, canonicalRoot, directories, deadline) {
  let directory = path.dirname(absolutePath);
  while (directory !== repositoryRoot) {
    remainingDeadline(deadline, "directory ancestry");
    if (!directory.startsWith(`${repositoryRoot}${path.sep}`))
      throw new Error("execution receipt detected invalid directory ancestry");
    if (!directories.has(directory)) {
      const state = await lstat(directory, { bigint: true });
      if (!state.isDirectory() || state.isSymbolicLink())
        throw new Error("execution receipt refuses unstable directory ancestry");
      const canonical = await realpath(directory);
      if (!canonical.startsWith(`${canonicalRoot}${path.sep}`))
        throw new Error("execution receipt refuses directory ancestry outside repository");
      directories.set(directory, statIdentity(state));
    }
    directory = path.dirname(directory);
  }
}

async function assertDirectoryAncestryStable(directories, deadline) {
  for (const [directory, identity] of directories) {
    remainingDeadline(deadline, "directory ancestry recheck");
    const state = await lstat(directory, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink() || statIdentity(state) !== identity)
      throw new Error("execution receipt detected concurrent directory ancestry change");
  }
}

export function assertRegularSourceStat(state, repositoryPath) {
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1n)
    throw new Error(`execution receipt refuses non-regular source path: ${repositoryPath}`);
  if (state.size > BigInt(MAX_SOURCE_FILE_BYTES))
    throw new Error(`execution receipt source file exceeds its byte limit: ${repositoryPath}`);
}

export async function collectSourceClosure({ deadline = createDeadline(30_000) } = {}) {
  remainingDeadline(deadline, "tracked discovery");
  const trackedOutput = await gitOutput(["ls-files", "-z"], deadline);
  const tracked = trackedOutput
    .split("\0")
    .filter(Boolean)
    .filter((entry) => !excludedSourcePaths.includes(entry))
    .sort();
  if (tracked.length === 0 || tracked.length > MAX_TRACKED_FILES)
    throw new Error("execution receipt tracked source count exceeds its bound");
  const untracked = (
    await gitOutput(["ls-files", "--others", "--exclude-standard", "-z"], deadline)
  )
    .split("\0")
    .filter(Boolean)
    .filter((entry) => !excludedSourcePaths.includes(entry));
  if (untracked.length !== 0)
    throw new Error(`execution receipt refuses ${untracked.length} untracked source path(s)`);
  const worktreeCheck = await runGit(["diff", "--quiet", "--", ...closurePathspec()], deadline);
  if (worktreeCheck.exitCode !== 0 || worktreeCheck.signal !== null || worktreeCheck.timedOut)
    throw new Error("execution receipt requires indexed and working source bytes to match");
  const indexRows = (await gitOutput(["ls-files", "--stage", "-z"], deadline))
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const separator = row.indexOf("\t");
      if (separator < 1) throw new Error("execution receipt encountered malformed Git index data");
      return { metadata: row.slice(0, separator), path: row.slice(separator + 1) };
    })
    .filter((row) => !excludedSourcePaths.includes(row.path))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (
    indexRows.length !== tracked.length ||
    indexRows.some((row, index) => row.path !== tracked[index])
  )
    throw new Error("execution receipt tracked and indexed inventories differ");
  const canonicalRoot = await realpath(repositoryRoot);
  const rootState = await lstat(repositoryRoot, { bigint: true });
  if (!rootState.isDirectory() || rootState.isSymbolicLink())
    throw new Error("execution receipt refuses unstable repository ancestry");
  const rootIdentity = statIdentity(rootState);
  const directories = new Map();
  const rows = [];
  const metadataRows = [];
  let totalBytes = 0;
  for (const repositoryPath of tracked) {
    remainingDeadline(deadline, "source closure read");
    const absolutePath = path.resolve(repositoryRoot, repositoryPath);
    if (!absolutePath.startsWith(`${repositoryRoot}${path.sep}`))
      throw new Error(`execution receipt refuses path outside repository: ${repositoryPath}`);
    const linkStat = await lstat(absolutePath, { bigint: true });
    assertRegularSourceStat(linkStat, repositoryPath);
    await recordDirectoryAncestry(absolutePath, canonicalRoot, directories, deadline);
    const canonicalPath = await realpath(absolutePath);
    if (!canonicalPath.startsWith(`${canonicalRoot}${path.sep}`))
      throw new Error(`execution receipt refuses path outside repository: ${repositoryPath}`);
    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const before = await handle.stat({ bigint: true });
      bytes = await deadlineReadFile(handle, deadline, "source file read");
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        after.size !== BigInt(bytes.byteLength)
      )
        throw new Error(`execution receipt detected concurrent source change: ${repositoryPath}`);
    } finally {
      await handle.close();
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SOURCE_BYTES)
      throw new Error("execution receipt aggregate source bytes exceed their limit");
    rows.push({ bytes: bytes.byteLength, path: repositoryPath, sha256: sha256(bytes) });
    metadataRows.push({ identity: statIdentity(linkStat), path: repositoryPath });
  }
  await assertDirectoryAncestryStable(directories, deadline);
  const rootAfter = await lstat(repositoryRoot, { bigint: true });
  if (
    !rootAfter.isDirectory() ||
    rootAfter.isSymbolicLink() ||
    statIdentity(rootAfter) !== rootIdentity
  )
    throw new Error("execution receipt detected concurrent repository ancestry change");
  return Object.freeze({
    algorithm: "all-tracked-indexed-bytes-v2",
    excludedPaths: excludedSourcePaths,
    gitHead: (await gitOutput(["rev-parse", "HEAD"], deadline)).trim(),
    indexSha256: sha256(Buffer.from(canonicalJson(indexRows), "utf8")),
    sha256: sha256(Buffer.from(canonicalJson(rows), "utf8")),
    totalBytes,
    trackedInventorySha256: sha256(Buffer.from(canonicalJson(tracked), "utf8")),
    trackedFileCount: rows.length,
    untrackedFileCount: 0,
    workingMetadataSha256: sha256(Buffer.from(canonicalJson(metadataRows), "utf8")),
  });
}

export function assertSourceStateStable(before, after) {
  if (canonicalJson(before) !== canonicalJson(after))
    throw new Error("execution receipt detected source mutation during command execution");
}

export async function guardSourceExecution(operation, { deadline = createDeadline() } = {}) {
  const before = await collectSourceClosure({ deadline });
  remainingDeadline(deadline, "guarded execution");
  const result = await operation(deadline);
  const after = await collectSourceClosure({ deadline });
  assertSourceStateStable(before, after);
  return Object.freeze({ after, before, result });
}

async function cleanupWithinDeadline(targetPath, deadline) {
  let timer;
  const cleanupMs = Math.max(
    1,
    Math.min(PROCESS_CLEANUP_DEADLINE_MS, Math.floor(deadline.expiresAt - performance.now())),
  );
  try {
    await Promise.race([
      rm(targetPath, { force: true, recursive: true }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("execution receipt temporary cleanup exceeded its deadline")),
          cleanupMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function parseTapTests(source) {
  if (/^\s*not ok\b/mu.test(source))
    throw new Error("execution receipt encountered a failing TAP test");
  if (/^\s*ok [0-9]+ - .*#[ \t]*(?:SKIP|TODO)\b/imu.test(source))
    throw new Error("execution receipt refuses skipped or todo TAP tests");
  if (/^Bail out!/mu.test(source)) throw new Error("execution receipt encountered a TAP bailout");
  const tests = source
    .split(/\r?\n/u)
    .map((line) => /^\s*# Subtest: (?<identity>.+)$/u.exec(line)?.groups?.identity)
    .filter((identity) => identity !== undefined)
    .map((identity) => ({ identity, outcome: "passed" }))
    .sort((left, right) => left.identity.localeCompare(right.identity, "en"));
  const passingResults = source.match(/^\s*ok [0-9]+ - /gmu)?.length ?? 0;
  if (tests.length === 0 || passingResults !== tests.length)
    throw new Error("execution receipt could not pair TAP test identities with outcomes");
  return tests;
}

function parsePackageInventory(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => /^(?<package>@\S+) packed with (?<files>[0-9]+) files\.$/u.exec(line)?.groups)
    .filter((groups) => groups !== undefined)
    .map((groups) => ({ files: Number.parseInt(groups.files, 10), package: groups.package }))
    .sort((left, right) => left.package.localeCompare(right.package, "en"));
}

function completedCommand(id, argv, result, tests) {
  return {
    argv,
    deadlineMs: result.deadlineMs,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    id,
    signal: result.signal,
    tests,
    timedOut: result.timedOut,
  };
}

export async function captureExecutionReceipt() {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const deadline = createDeadline(OVERALL_DEADLINE_MS);
  const containment = await probeExecutionContainment({ deadline });
  assertContainmentSupported(containment);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-"));
  let payload;
  try {
    remainingDeadline(deadline, "temporary directory creation");
    const docker = await sealApprovedExecutable(
      "docker",
      approvedTools.docker[process.platform].path,
      approvedTools.docker[process.platform].sha256,
      temporaryDirectory,
      deadline,
    );
    const guarded = await guardSourceExecution(
      async (activeDeadline) => {
        const confinements = [];
        const inspectToolchain = async () => {
          const inspection = await runContainedCommand(
            docker,
            containment,
            "inspect-tools",
            activeDeadline,
            30_000,
          );
          if (inspection.exitCode !== 0 || inspection.signal !== null || inspection.timedOut)
            throw new Error(
              `execution receipt could not inspect contained executable identities: ${JSON.stringify(
                {
                  exitCode: inspection.exitCode,
                  signal: inspection.signal,
                  stderr: inspection.stderr.slice(0, 4_096),
                  stderrSha256: sha256(Buffer.from(inspection.stderr, "utf8")),
                  stdout: inspection.stdout.slice(0, 4_096),
                  stdoutSha256: sha256(Buffer.from(inspection.stdout, "utf8")),
                  timedOut: inspection.timedOut,
                },
              )}`,
            );
          confinements.push(inspection.confinement);
          remainingDeadline(activeDeadline, "contained toolchain parse");
          return JSON.parse(inspection.stdout);
        };
        const toolchainBefore = await inspectToolchain();
        const execute = async (id) => {
          const deadlineMs = Math.min(
            COMMAND_DEADLINES[id],
            remainingDeadline(activeDeadline, `${id} execution`) - 15_000,
          );
          const result = {
            ...(await runContainedCommand(docker, containment, id, activeDeadline, deadlineMs)),
            deadlineMs,
          };
          confinements.push(result.confinement);
          await docker.assertUnchanged(activeDeadline);
          return result;
        };

        const tufResult = await execute("tuf-trust");
        if (tufResult.exitCode !== 0 || tufResult.signal !== null || tufResult.timedOut)
          throw new Error("execution receipt TUF command failed or exceeded its deadline");
        remainingDeadline(activeDeadline, "Vitest report parse");
        const vitestReport = JSON.parse(tufResult.stdout);
        const tufTests = vitestReport.testResults
          .flatMap((result) => result.assertionResults)
          .map((test) => ({ identity: test.fullName, outcome: test.status }))
          .sort((left, right) => left.identity.localeCompare(right.identity, "en"));

        const standardsTestFiles = (
          await gitOutput(["ls-files", "-z", "tools/standards/*.test.mjs"], activeDeadline)
        )
          .split("\0")
          .filter(Boolean)
          .filter((entry) => entry !== "tools/standards/recovery-tabletop.test.mjs")
          .sort();
        if (canonicalJson(standardsTestFiles) !== canonicalJson(expectedStandardsTestFiles))
          throw new Error(
            "execution receipt standards discovery differs from accountable inventory",
          );
        const standardsResult = await execute("standards-tools");
        if (
          standardsResult.exitCode !== 0 ||
          standardsResult.signal !== null ||
          standardsResult.timedOut
        )
          throw new Error("execution receipt standards command failed or exceeded its deadline");
        remainingDeadline(activeDeadline, "TAP result normalization");
        const standardsTests = parseTapTests(standardsResult.stdout);

        const packageResult = await execute("package-audit");
        if (packageResult.exitCode !== 0 || packageResult.signal !== null || packageResult.timedOut)
          throw new Error("execution receipt package command failed or exceeded its deadline");
        remainingDeadline(activeDeadline, "package result normalization");
        const packageInventory = parsePackageInventory(packageResult.stdout);

        const commands = [
          completedCommand("tuf-trust", expectedCommandArgv["tuf-trust"], tufResult, tufTests),
          completedCommand(
            "standards-tools",
            expectedCommandArgv["standards-tools"],
            standardsResult,
            standardsTests,
          ),
          completedCommand(
            "package-audit",
            expectedCommandArgv["package-audit"],
            packageResult,
            [],
          ),
        ];
        const toolchainAfter = await inspectToolchain();
        if (canonicalJson(toolchainBefore) !== canonicalJson(toolchainAfter))
          throw new Error("execution receipt detected toolchain mutation during command execution");
        if (
          confinements.length !== 5 ||
          confinements.some((entry) => canonicalJson(entry) !== canonicalJson(confinements[0]))
        )
          throw new Error("execution receipt contained commands used different confinement");
        return {
          commands,
          confinement: confinements[0],
          packageInventory,
          toolchain: toolchainAfter,
        };
      },
      { deadline },
    );
    payload = { ...guarded.result, sourceClosure: guarded.after };
  } finally {
    await cleanupWithinDeadline(temporaryDirectory, deadline);
  }
  remainingDeadline(deadline, "capture completion");
  const durationMs = Math.ceil(performance.now() - started);
  return {
    capturedAt: new Date().toISOString(),
    commands: payload.commands,
    captureStatus: "supported",
    containment: {
      ...containment,
      configuration: payload.confinement.details,
      configurationSha256: payload.confinement.sha256,
    },
    contractVersion: "1.3.0",
    durationMs,
    overallDeadlineMs: OVERALL_DEADLINE_MS,
    overallExitCode: payload.commands.some((command) => command.exitCode !== 0) ? 1 : 0,
    packageInventory: payload.packageInventory,
    recordKind: "agent-context-standards-recovery-execution",
    sourceClosure: payload.sourceClosure,
    startedAt,
    toolchain: payload.toolchain,
  };
}

export function validateExecutionReceipt(receipt) {
  const schemaValid = validateSchema(receipt);
  const issues = schemaValid
    ? []
    : (validateSchema.errors ?? []).map(
        (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      );
  if (!schemaValid) return { issues, schemaValid: false };
  if (receipt.captureStatus !== receipt.containment.status)
    issues.push("execution receipt containment and capture status differ");
  if (receipt.containment.status === "supported") {
    try {
      assertConfinementConfiguration(receipt.containment.configuration);
    } catch (error) {
      issues.push(error.message);
    }
    if (
      receipt.containment.configurationSha256 !==
      sha256(Buffer.from(canonicalJson(receipt.containment.configuration), "utf8"))
    )
      issues.push("execution receipt confinement digest differs from its configuration");
    const expectedProvenance = {
      baseConfigurationDigest: buildLock.baseImage.configurationDigest,
      baseIndexDigest: buildLock.baseImage.indexDigest,
      basePlatformManifestDigest: buildLock.baseImage.platformManifestDigest,
      buildInputManifestSha256: buildLock.buildInputs.manifestSha256,
      preparationReviewSha256: buildLock.buildInputs.preparationReviewSha256,
      preparationSourceManifestSha256: buildLock.buildInputs.preparationSourceManifestSha256,
      buildLockSha256: runtimeLock.buildLockSha256,
      sourceDateEpoch: buildLock.buildInputs.sourceDateEpoch,
    };
    const actualProvenance = Object.fromEntries(
      Object.keys(expectedProvenance).map((key) => [key, receipt.containment.runtimeImage[key]]),
    );
    if (canonicalJson(actualProvenance) !== canonicalJson(expectedProvenance))
      issues.push("execution receipt runtime provenance differs from accountable inputs");
  }
  if (
    receipt.commands.map((command) => command.id).join(",") !==
    "tuf-trust,standards-tools,package-audit"
  )
    issues.push("execution command inventory changed");
  for (const command of receipt.commands) {
    if (canonicalJson(command.argv) !== canonicalJson(expectedCommandArgv[command.id]))
      issues.push(`${command.id} argv differs from accountable inventory`);
  }
  if (receipt.overallExitCode !== 0 || receipt.commands.some((command) => command.exitCode !== 0))
    issues.push("execution receipt contains a failed command");
  if (
    receipt.commands.some(
      (command) =>
        command.timedOut ||
        command.signal !== null ||
        command.deadlineMs > COMMAND_DEADLINES[command.id] ||
        command.durationMs > command.deadlineMs + 1_000,
    )
  )
    issues.push("execution receipt contains an unbounded or terminated command");
  if (
    Date.parse(receipt.capturedAt) < Date.parse(receipt.startedAt) ||
    receipt.durationMs > receipt.overallDeadlineMs + 1_000 ||
    Math.abs(Date.parse(receipt.capturedAt) - Date.parse(receipt.startedAt) - receipt.durationMs) >
      2_000 ||
    receipt.commands.reduce((sum, command) => sum + command.durationMs, 0) >
      receipt.durationMs + 1_000
  )
    issues.push("execution receipt overall timing is inconsistent");
  for (const command of receipt.commands.slice(0, 2)) {
    if (command.tests.length === 0 || command.tests.some((entry) => entry.outcome !== "passed"))
      issues.push(`${command.id} contains missing or non-passing test results`);
    if (new Set(command.tests.map((entry) => entry.identity)).size !== command.tests.length)
      issues.push(`${command.id} contains duplicate test identities`);
    if (
      sha256(Buffer.from(canonicalJson(command.tests), "utf8")) !==
      expectedTestInventorySha256[command.id]
    )
      issues.push(`${command.id} differs from the exact accountable test inventory`);
  }
  if (canonicalJson(receipt.packageInventory) !== canonicalJson(expectedPackageInventory))
    issues.push("package audit inventory must match exact accountable names and file counts");
  if (canonicalJson(receipt.toolchain) !== canonicalJson(expectedContainerToolchain))
    issues.push("execution receipt toolchain differs from approved executable identities");
  return { issues, schemaValid: true };
}

export async function verifyCurrentSourceClosure(receipt) {
  const deadline = createDeadline(30_000);
  const current = await collectSourceClosure({ deadline });
  const currentHead = current.gitHead;
  const currentBytes = { ...current };
  delete currentBytes.gitHead;
  delete currentBytes.workingMetadataSha256;
  const receiptHead = receipt.sourceClosure.gitHead;
  const receiptBytes = { ...receipt.sourceClosure };
  delete receiptBytes.gitHead;
  delete receiptBytes.workingMetadataSha256;
  const capturedHeadIsAncestor =
    (await runGit(["merge-base", "--is-ancestor", receiptHead, currentHead], deadline)).exitCode ===
    0;
  return {
    capturedHeadIsAncestor,
    current,
    matches: capturedHeadIsAncestor && canonicalJson(currentBytes) === canonicalJson(receiptBytes),
  };
}

export function executionReceiptSha256(receipt) {
  return sha256(Buffer.from(canonicalJson(receipt), "utf8"));
}

export async function currentToolchain() {
  const deadline = createDeadline(60_000);
  const containment = await probeExecutionContainment({ deadline });
  assertContainmentSupported(containment);
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-current-"));
  try {
    const docker = await sealApprovedExecutable(
      "docker",
      approvedTools.docker[process.platform].path,
      approvedTools.docker[process.platform].sha256,
      directory,
      deadline,
    );
    const result = await runContainedCommand(
      docker,
      containment,
      "inspect-tools",
      deadline,
      30_000,
    );
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut)
      throw new Error("current contained toolchain probe failed");
    return JSON.parse(result.stdout);
  } finally {
    await cleanupWithinDeadline(directory, deadline);
  }
}

export async function runContainmentAdversary({ deadline = createDeadline(30_000) } = {}) {
  const containment = await probeExecutionContainment({ deadline });
  assertContainmentSupported(containment);
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-adversary-"));
  try {
    const docker = await sealApprovedExecutable(
      "docker",
      approvedTools.docker[process.platform].path,
      approvedTools.docker[process.platform].sha256,
      directory,
      deadline,
    );
    return await runContainedCommand(
      docker,
      containment,
      "containment-adversary",
      deadline,
      5_000,
      4_096,
    );
  } finally {
    await cleanupWithinDeadline(directory, deadline);
  }
}

export async function runContainmentCreateAdversary(
  mode,
  { deadline = createDeadline(30_000) } = {},
) {
  if (!["malformed-stdout", "timeout", "transport-error"].includes(mode))
    throw new Error("invalid containment create adversary");
  const containment = await probeExecutionContainment({ deadline });
  assertContainmentSupported(containment);
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-create-adversary-"));
  try {
    const docker = await sealApprovedExecutable(
      "docker",
      approvedTools.docker[process.platform].path,
      approvedTools.docker[process.platform].sha256,
      directory,
      deadline,
    );
    return await runContainedCommand(
      docker,
      containment,
      "inspect-tools",
      deadline,
      5_000,
      4_096,
      mode,
    );
  } finally {
    await cleanupWithinDeadline(directory, deadline);
  }
}
