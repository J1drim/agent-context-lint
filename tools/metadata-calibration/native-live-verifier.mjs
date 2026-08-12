import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sha256Canonical } from "./contracts.mjs";
import { createDarwinConfinementFactory } from "./confinement.mjs";
import {
  inspectExecutableIdentity,
  inspectHdiutilIdentity,
  inspectSystemHelpIdentity,
  runBoundedCommand,
} from "./execute.mjs";
import { inspectNativeToolchain, verifyToolIdentity } from "./native-toolchain.mjs";
import { runNativeQuotaProbe } from "./quota-native.mjs";

function verifierEnvironment(home) {
  return Object.freeze({
    CI: "true",
    COREPACK_ENABLE_NETWORK: "0",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    NPM_CONFIG_OFFLINE: "true",
    PATH: "/usr/bin:/bin",
    TMPDIR: home,
  });
}

function equalIdentity(observed, expected, label) {
  if (sha256Canonical(observed) !== sha256Canonical(expected))
    throw new Error(`live native ${label} identity differs from the committed proof`);
}

export function verifySemanticQuotaRelation(observed, expected) {
  const stable = (value) => {
    const result = { ...value };
    delete result.blockCount;
    return result;
  };
  if (sha256Canonical(stable(observed)) !== sha256Canonical(stable(expected)))
    throw new Error("live native quota semantic identity differs from the committed proof");
  if (
    !Number.isSafeInteger(observed.blockCount) ||
    !Number.isSafeInteger(expected.blockCount) ||
    observed.blockCount < 1 ||
    expected.blockCount < 1 ||
    Math.abs(observed.blockCount - expected.blockCount) > 1
  )
    throw new Error("live native quota geometry exceeds its one-block tolerance");
}

async function attachedDevices(hdiutil, home) {
  await verifyToolIdentity(hdiutil, "/usr/bin/hdiutil");
  const result = await runBoundedCommand(hdiutil.path, ["info", "-plist"], {
    cwd: home,
    environment: verifierEnvironment(home),
    maximumStderrBytes: 64 * 1024,
    maximumStdoutBytes: 256 * 1024,
    timeoutMs: 120_000,
  });
  await verifyToolIdentity(hdiutil, "/usr/bin/hdiutil");
  if (result.status !== 0 || result.signal !== null)
    throw new Error("live native attachment inventory failed");
  return [
    ...result.stdout.matchAll(/<key>dev-entry<\/key>\s*<string>(\/dev\/disk[^<]+)<\/string>/gu),
  ]
    .map((match) => match[1].replace(/s[1-9][0-9]*$/u, ""))
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .sort();
}

export async function verifyLiveNativeReleaseProof(proof, { repositoryRoot }) {
  if (process.platform !== "darwin" || process.arch !== proof.runner.architecture)
    throw new Error("K03 ready proof requires live verification on its exact Darwin runner class");
  const root = await realpath(repositoryRoot);
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-live-verify-"));
  await chmod(workRoot, 0o700);
  let failure = null;
  try {
    const observedSystemTools = Object.freeze({
      bash: await inspectSystemHelpIdentity("/bin/bash", "bash executable"),
      cp: await inspectSystemHelpIdentity("/bin/cp", "cp executable"),
      dd: await inspectSystemHelpIdentity("/bin/dd", "dd executable"),
      df: await inspectSystemHelpIdentity("/bin/df", "df executable"),
      dirname: await inspectSystemHelpIdentity("/usr/bin/dirname", "dirname executable"),
      env: await inspectSystemHelpIdentity("/usr/bin/env", "env executable"),
      hdiutil: await inspectHdiutilIdentity("/usr/bin/hdiutil"),
      sandboxExec: await inspectSystemHelpIdentity(
        "/usr/bin/sandbox-exec",
        "sandbox-exec executable",
      ),
      sed: await inspectSystemHelpIdentity("/usr/bin/sed", "sed executable"),
      sh: await inspectSystemHelpIdentity("/bin/sh", "sh executable"),
      tar: await inspectExecutableIdentity("/usr/bin/bsdtar", "tar executable", ["--version"]),
      uname: await inspectSystemHelpIdentity("/usr/bin/uname", "uname executable"),
    });
    for (const [name, observed] of Object.entries(observedSystemTools))
      equalIdentity(observed, proof.tools[name], `${name} system tool`);
    const toolchain = await inspectNativeToolchain(root, proof.tools.pnpm.path, {
      inventoryChildSha256: proof.confinement.inventoryChildSha256,
      nodeExecutable: proof.tools.node.path,
      nodeSha256: proof.tools.node.sha256,
      sandboxExecutable: observedSystemTools.sandboxExec.path,
      sandboxSha256: observedSystemTools.sandboxExec.sha256,
    });
    equalIdentity(toolchain.node, proof.tools.node, "vendored Node");
    equalIdentity(toolchain.pnpm, proof.tools.pnpm, "pnpm launcher");
    equalIdentity(toolchain.buildTools, proof.buildTools, "build graph");
    for (const [name, tool] of Object.entries(proof.tools)) {
      await verifyToolIdentity(tool, tool.path);
      if (name === "node" && tool.path !== toolchain.node.path)
        throw new Error("live native Node is not the frozen vendored runtime");
    }
    if ((await realpath(process.execPath)) !== proof.tools.node.path)
      throw new Error("K03 ready verification must execute under the proof-bound vendored Node");

    const devicesBefore = await attachedDevices(proof.tools.hdiutil, workRoot);
    const quotaProof = await runNativeQuotaProbe({
      systemTools: {
        cp: proof.tools.cp,
        dd: proof.tools.dd,
        df: proof.tools.df,
      },
    });
    verifySemanticQuotaRelation(quotaProof, proof.quotaProof);
    const devicesAfter = await attachedDevices(proof.tools.hdiutil, workRoot);
    if (sha256Canonical(devicesBefore) !== sha256Canonical(devicesAfter))
      throw new Error("live native quota verification leaked or replaced an attached device");

    const createConfinement = createDarwinConfinementFactory({
      command: runBoundedCommand,
      environment: verifierEnvironment(workRoot),
      nativeProof: proof,
      nodeExecutable: proof.tools.node.path,
      temporaryRoot: workRoot,
    });
    for (const [phaseRoot, phase] of [
      [root, "install"],
      [root, "pack"],
      [workRoot, "extract"],
    ]) {
      const confinement = await createConfinement(phaseRoot, phase);
      await confinement.verifyAfter();
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await rm(workRoot, { recursive: true });
    } catch (error) {
      failure = new AggregateError(
        failure === null ? [error] : [failure, error],
        "live native proof verification retained its payload root for quarantine",
        { cause: error },
      );
    }
  }
  if (failure !== null) throw failure;
}
