#!/usr/bin/env node

import { chmod, lstat, link, mkdtemp, open, realpath, rm, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectExecutableIdentity,
  inspectHdiutilIdentity,
  inspectSystemHelpIdentity,
  runBoundedCommand,
} from "./execute.mjs";
import {
  QUOTA_FIXED_RESERVE_BYTES,
  cleanupQuotaVolume,
  createDarwinQuotaVolumeProvider,
  freezeQuotaVolume,
  provisionQuotaVolume,
  verifyQuotaVolume,
} from "./quota-volume.mjs";
import { prettyJson, sha256Canonical } from "./contracts.mjs";
import { createDarwinConfinementFactory, darwinPhasePolicySha256 } from "./confinement.mjs";
import { validateNativeReleaseProofStructure } from "./native-proof.mjs";
import {
  inspectNativeBuildGraph,
  inspectNativeToolchain,
  pnpmInventoryChildSha256,
  verifyToolIdentity,
} from "./native-toolchain.mjs";

const LOGICAL_BUDGET_BYTES = 64 * 1024 * 1024;

export function validateEnospcCopyResult(result, destinationSize, payloadSize) {
  if (
    result.status !== 1 ||
    result.signal !== null ||
    !/(?:^|\n)cp: .*: No space left on device(?:\n|$)/u.test(result.stderr) ||
    /File too large|Permission denied/u.test(result.stderr)
  )
    throw new Error("native quota probe did not fail with exact ENOSPC semantics");
  if (
    !Number.isSafeInteger(destinationSize) ||
    destinationSize < 1 ||
    destinationSize >= payloadSize
  )
    throw new Error("native quota ENOSPC proof lacks an exact partial destination state");
}

function environment(home) {
  return Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  });
}

async function runIdentityBoundTool(tool, expectedPath, operation) {
  await verifyToolIdentity(tool, expectedPath);
  let result;
  let failure = null;
  try {
    result = await operation();
  } catch (error) {
    failure = error;
  }
  let postflightFailure = null;
  try {
    await verifyToolIdentity(tool, expectedPath);
  } catch (error) {
    postflightFailure = error;
  }
  if (failure !== null && postflightFailure !== null)
    throw new AggregateError(
      [failure, postflightFailure],
      `native quota operation failed and ${expectedPath} changed during execution`,
      { cause: failure },
    );
  if (failure !== null) throw failure;
  if (postflightFailure !== null) throw postflightFailure;
  return result;
}

export async function runNativeQuotaProbe({ systemTools } = {}) {
  if (process.platform !== "darwin")
    throw new Error("native K03 quota probe is feature-unavailable outside Darwin");
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-native-quota-"));
  await chmod(workRoot, 0o700);
  const probeEnvironment = environment(workRoot);
  const hdiutil = await inspectHdiutilIdentity("/usr/bin/hdiutil");
  const [cp, dd, df] = await Promise.all([
    systemTools?.cp ?? inspectSystemHelpIdentity("/bin/cp", "cp executable"),
    systemTools?.dd ?? inspectSystemHelpIdentity("/bin/dd", "dd executable"),
    systemTools?.df ?? inspectSystemHelpIdentity("/bin/df", "df executable"),
  ]);
  const provider = createDarwinQuotaVolumeProvider({
    command: runBoundedCommand,
    cp,
    dd,
    df,
    environment: probeEnvironment,
    hdiutil,
  });
  let state = null;
  const payload = path.join(workRoot, "hostile-fast-copy-source.bin");
  const payloadMiB = Math.ceil(
    (LOGICAL_BUDGET_BYTES + QUOTA_FIXED_RESERVE_BYTES + 8 * 1024 * 1024) / (1024 * 1024),
  );
  let failure = null;
  let proof = null;
  try {
    state = await provisionQuotaVolume(provider, {
      logicalBudgetBytes: LOGICAL_BUDGET_BYTES,
      repositoryId: "1",
      workRoot,
    });
    const generated = await runIdentityBoundTool(dd, "/bin/dd", () =>
      runBoundedCommand(
        dd.path,
        ["if=/dev/zero", `of=${payload}`, "bs=1048576", `count=${String(payloadMiB)}`],
        { cwd: workRoot, environment: probeEnvironment, timeoutMs: 120_000 },
      ),
    );
    if (generated.status !== 0 || generated.signal !== null)
      throw new Error("native quota probe could not create its bounded hostile payload");
    const copied = await runIdentityBoundTool(cp, "/bin/cp", () =>
      runBoundedCommand(cp.path, [payload, path.join(state.mount.path, "hostile-fast-copy.bin")], {
        cwd: workRoot,
        environment: probeEnvironment,
        maximumStderrBytes: 64 * 1024,
        maximumStdoutBytes: 4096,
        timeoutMs: 120_000,
      }),
    );
    const partial = await lstat(path.join(state.mount.path, "hostile-fast-copy.bin"));
    if (!partial.isFile() || partial.isSymbolicLink())
      throw new Error("native quota ENOSPC destination is not an ordinary partial file");
    validateEnospcCopyResult(copied, partial.size, payloadMiB * 1024 * 1024);
    await chmod(state.mount.path, 0o555);
    state = await freezeQuotaVolume(provider, state);
    await verifyQuotaVolume(provider, state);
    proof = Object.freeze({
      allocatedResourceCeilingBytes: state.allocatedResourceCeilingBytes,
      blockCount: state.filesystem.blockCount,
      blockSize: state.filesystem.blockSize,
      contractVersion: "0.1.0",
      filesystemType: state.filesystem.filesystemType,
      filesystemName: state.filesystem.filesystemName,
      hdiutil: state.hdiutil,
      logicalBudgetBytes: state.logicalBudgetBytes,
      oversizeFastCopyRejected: true,
      recordKind: "agent-context-k03-native-quota-proof",
      reserveBytes: state.reserveBytes,
      sourcePolicy: { localPaths: false },
    });
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    if (state !== null) {
      try {
        await cleanupQuotaVolume(provider, state);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      const metadata = await lstat(payload);
      if (!metadata.isFile() || metadata.isSymbolicLink())
        cleanupErrors.push(
          new Error("native quota payload changed identity; retained for quarantine"),
        );
      else await unlink(payload);
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupErrors.push(error);
    }
    try {
      await rmdir(workRoot);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0)
      failure = new AggregateError(
        failure === null ? cleanupErrors : [failure, ...cleanupErrors],
        "native K03 quota probe failed to clean every issued resource",
        { cause: cleanupErrors.at(0) },
      );
  }
  if (failure !== null) throw failure;
  return proof;
}

export const NATIVE_ASSEMBLY_STAGES = Object.freeze([
  "toolchain",
  "system-tools",
  "quota",
  "confinement",
  "validation",
]);

export async function runNativeAssemblyPipeline(operations) {
  const context = Object.create(null);
  for (const name of NATIVE_ASSEMBLY_STAGES) {
    if (typeof operations?.[name] !== "function")
      throw new Error(`native proof assembly lacks its ${name} stage`);
    try {
      context[name] = await operations[name](Object.freeze({ ...context }));
    } catch (error) {
      throw new Error(`native proof assembly failed during ${name}`, { cause: error });
    }
  }
  return Object.freeze({ ...context });
}

export async function assembleNativeReleaseProof({ acknowledge = false } = {}) {
  if (acknowledge !== true)
    throw new Error("native proof assembly requires explicit release-capture acknowledgement");
  const pnpmPath = process.env.npm_execpath;
  if (typeof pnpmPath !== "string" || !path.isAbsolute(pnpmPath))
    throw new Error("native proof assembly requires the exact absolute pnpm launcher");
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await runNativeAssemblyPipeline({
    toolchain: async () => {
      const [bootstrapSandboxExec, inventoryChildSha256, nodeExecutable] = await Promise.all([
        inspectSystemHelpIdentity("/usr/bin/sandbox-exec", "sandbox-exec executable"),
        pnpmInventoryChildSha256(),
        realpath(process.execPath),
      ]);
      const toolchain = await inspectNativeToolchain(repositoryRoot, pnpmPath, {
        inventoryChildSha256,
        nodeExecutable,
        nodeSha256: (await inspectNativeBuildGraph(repositoryRoot)).node.sha256,
        sandboxExecutable: bootstrapSandboxExec.path,
        sandboxSha256: bootstrapSandboxExec.sha256,
      });
      if (nodeExecutable !== toolchain.node.path)
        throw new Error("native proof assembly must run under the frozen vendored Node executable");
      return Object.freeze({ ...toolchain, bootstrapSandboxExec, inventoryChildSha256 });
    },
    "system-tools": async (context) => {
      const [sandboxExec, tar, hdiutil, bash, sh, env, cp, dd, df, dirname, sed, uname] =
        await Promise.all([
          inspectSystemHelpIdentity("/usr/bin/sandbox-exec", "sandbox-exec executable"),
          inspectExecutableIdentity("/usr/bin/bsdtar", "tar executable", ["--version"]),
          inspectHdiutilIdentity("/usr/bin/hdiutil"),
          inspectSystemHelpIdentity("/bin/bash", "bash executable"),
          inspectSystemHelpIdentity("/bin/sh", "sh executable"),
          inspectSystemHelpIdentity("/usr/bin/env", "env executable"),
          inspectSystemHelpIdentity("/bin/cp", "cp executable"),
          inspectSystemHelpIdentity("/bin/dd", "dd executable"),
          inspectSystemHelpIdentity("/bin/df", "df executable"),
          inspectSystemHelpIdentity("/usr/bin/dirname", "dirname executable"),
          inspectSystemHelpIdentity("/usr/bin/sed", "sed executable"),
          inspectSystemHelpIdentity("/usr/bin/uname", "uname executable"),
        ]);
      if (sha256Canonical(sandboxExec) !== sha256Canonical(context.toolchain.bootstrapSandboxExec))
        throw new Error("sandbox-exec identity changed after authoritative pnpm inventory");
      return Object.freeze({
        bash,
        cp,
        dd,
        df,
        dirname,
        env,
        hdiutil,
        sandboxExec,
        sed,
        sh,
        tar,
        uname,
      });
    },
    quota: async (context) =>
      runNativeQuotaProbe({
        systemTools: {
          cp: context["system-tools"].cp,
          dd: context["system-tools"].dd,
          df: context["system-tools"].df,
        },
      }),
    confinement: async (context) => {
      const toolchain = context.toolchain;
      const systemTools = context["system-tools"];
      const quotaProof = context.quota;
      const helperExecutables = [
        systemTools.bash.path,
        systemTools.sh.path,
        systemTools.env.path,
        systemTools.dirname.path,
        systemTools.sed.path,
        systemTools.uname.path,
      ];
      const packExecutables = [
        "esbuildEntry",
        "esbuildLauncher",
        "esbuildPlatformBinary",
        "typescriptCompiler",
        "typescriptEntry",
        "typescriptLauncher",
      ].map((name) => toolchain.buildTools[name].path);
      const policyDigest = (allowedExecutables, workspaceRoot) =>
        darwinPhasePolicySha256({
          allowedExecutables,
          helperExecutables,
          nodeExecutable: toolchain.node.path,
          temporaryRoot: repositoryRoot,
          workspaceRoot,
        });
      const payload = {
        capturedAt: new Date().toISOString(),
        buildTools: toolchain.buildTools,
        cleanup: { devices: 0, images: 0, mounts: 0, payloadRoots: 0 },
        confinement: {
          arbitraryChildDenied: true,
          curlDenied: true,
          inventoryChildSha256: toolchain.inventoryChildSha256,
          networkDenied: true,
          phasePolicySha256: {
            extract: policyDigest([systemTools.tar.path], repositoryRoot),
            install: policyDigest([], repositoryRoot),
            pack: policyDigest(packExecutables, repositoryRoot),
          },
          writeEscapeDenied: true,
        },
        contractVersion: "0.1.0",
        filesystem: {
          blockCount: quotaProof.blockCount,
          blockSize: quotaProof.blockSize,
          format: "APFS",
          name: quotaProof.filesystemName,
          type: quotaProof.filesystemType,
        },
        quotaProof,
        quotaProofSha256: sha256Canonical(quotaProof),
        recordKind: "agent-context-k03-native-release-proof",
        runner: { architecture: process.arch, platform: process.platform },
        sourcePolicy: { localPaths: false },
        status: "ready",
        tools: { ...systemTools, node: toolchain.node, pnpm: toolchain.pnpm },
      };
      const probeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-native-proof-"));
      try {
        const createConfinement = createDarwinConfinementFactory({
          environment: environment(probeRoot),
          nativeProof: { ...payload, proofSha256: sha256Canonical(payload) },
          nodeExecutable: toolchain.node.path,
          temporaryRoot: probeRoot,
        });
        for (const phase of ["install", "pack"]) {
          const confinement = await createConfinement(repositoryRoot, phase);
          await confinement.verifyAfter();
        }
      } finally {
        await rm(probeRoot, { recursive: true });
      }
      return Object.freeze({ ...payload, proofSha256: sha256Canonical(payload) });
    },
    validation: async (context) => {
      await validateNativeReleaseProofStructure(context.confinement, { repositoryRoot });
      return context.confinement;
    },
  });
  return result.validation;
}

async function publishNativeProof(outputPath) {
  if (!path.isAbsolute(outputPath)) throw new Error("native proof output must be absolute");
  const parent = await realpath(path.dirname(outputPath));
  if (outputPath !== path.join(parent, path.basename(outputPath)))
    throw new Error("native proof output parent or final component is substituted");
  const parentBefore = await lstat(parent);
  const temporary = path.join(parent, `.${path.basename(outputPath)}.tmp-${String(process.pid)}`);
  let temporaryCreated = false;
  let failure = null;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(prettyJson(await assembleNativeReleaseProof({ acknowledge: true })));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const parentAfterAssembly = await lstat(parent);
    if (
      parentAfterAssembly.dev !== parentBefore.dev ||
      parentAfterAssembly.ino !== parentBefore.ino
    )
      throw new Error("native proof output parent changed during assembly");
    await link(temporary, outputPath);
    await unlink(temporary);
    temporaryCreated = false;
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (error?.code === "EEXIST")
      failure = new Error("native proof output already exists; edits are rejected", {
        cause: error,
      });
    else failure = error;
  } finally {
    if (temporaryCreated) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (error?.code !== "ENOENT")
          failure = new AggregateError(
            failure === null ? [error] : [failure, error],
            "native proof temporary output was retained for quarantine",
            { cause: error },
          );
      }
    }
  }
  if (failure !== null) throw failure;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [acknowledgement, outputFlag, outputPath] = process.argv.slice(2);
    if (
      acknowledgement !== "--acknowledge-native-release-capture" ||
      outputFlag !== "--output" ||
      outputPath === undefined
    )
      throw new Error(
        "Usage: quota-native.mjs --acknowledge-native-release-capture --output <absolute-new-file>",
      );
    await publishNativeProof(outputPath);
    process.stdout.write("Native K03 release proof captured atomically.\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "native K03 quota probe failed"}\n`,
    );
    process.exitCode = 1;
  }
}
