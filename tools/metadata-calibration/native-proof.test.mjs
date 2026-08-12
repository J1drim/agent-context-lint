import assert from "node:assert/strict";
import test from "node:test";

import { sha256Canonical } from "./contracts.mjs";
import { validateNativeReleaseProof } from "./native-proof.mjs";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

function readyProof() {
  const proof = {
    capturedAt: "2026-08-09T08:00:00.000Z",
    buildTools: {
      esbuildEntry: {
        path: "/opt/reviewed/esbuild/bin/esbuild",
        sha256: "9".repeat(64),
        version: "0.28.1",
      },
      esbuildLauncher: {
        path: "/opt/reviewed/node_modules/.bin/esbuild",
        sha256: "a".repeat(64),
        version: "0.28.1",
      },
      esbuildPackageManifest: {
        path: "/opt/reviewed/esbuild/package.json",
        sha256: "b".repeat(64),
        version: "0.28.1",
      },
      esbuildPlatformBinary: {
        path: "/opt/reviewed/@esbuild/darwin-arm64/bin/esbuild",
        sha256: "6".repeat(64),
        version: "0.28.1",
      },
      esbuildPlatformManifest: {
        path: "/opt/reviewed/@esbuild/darwin-arm64/package.json",
        sha256: "7".repeat(64),
        version: "0.28.1",
      },
      pnpmBundle: {
        path: "/opt/reviewed/pnpm/dist/pnpm.mjs",
        sha256: "1".repeat(64),
        version: "11.18.0",
      },
      pnpmCompatibilityShim: {
        path: "/opt/reviewed/pnpm/bin/pnpm.cjs",
        sha256: "3".repeat(64),
        version: "11.18.0",
      },
      pnpmEntry: {
        path: "/opt/reviewed/pnpm/bin/pnpm.mjs",
        sha256: "2".repeat(64),
        version: "11.18.0",
      },
      pnpmLauncher: {
        path: "/opt/reviewed/pnpm/bin/pnpm.mjs",
        sha256: "2".repeat(64),
        version: "11.18.0",
      },
      pnpmPackageManifest: {
        path: "/opt/reviewed/pnpm/package.json",
        sha256: "4".repeat(64),
        version: "11.18.0",
      },
      pnpmRuntime: {
        path: "/opt/reviewed/pnpm",
        sha256: "5".repeat(64),
        version: "11.18.0",
      },
      typescriptCompiler: {
        path: "/opt/reviewed/typescript/lib/tsc",
        sha256: "d".repeat(64),
        version: "7.0.2",
      },
      typescriptEntry: {
        path: "/opt/reviewed/typescript/bin/tsc",
        sha256: "e".repeat(64),
        version: "7.0.2",
      },
      typescriptLauncher: {
        path: "/opt/reviewed/node_modules/.bin/tsc",
        sha256: "f".repeat(64),
        version: "7.0.2",
      },
      typescriptPackageManifest: {
        path: "/opt/reviewed/typescript/package.json",
        sha256: "0".repeat(64),
        version: "7.0.2",
      },
      typescriptPlatformManifest: {
        path: "/opt/reviewed/typescript-platform/package.json",
        sha256: "1".repeat(64),
        version: "7.0.2",
      },
      typescriptResolver: {
        path: "/opt/reviewed/typescript/lib/getExePath.js",
        sha256: "2".repeat(64),
        version: "7.0.2",
      },
      typescriptRuntimeEntry: {
        path: "/opt/reviewed/typescript/lib/tsc.js",
        sha256: "3".repeat(64),
        version: "7.0.2",
      },
    },
    confinement: {
      arbitraryChildDenied: true,
      curlDenied: true,
      inventoryChildSha256: "4".repeat(64),
      networkDenied: true,
      phasePolicySha256: {
        extract: "1".repeat(64),
        install: "2".repeat(64),
        pack: "3".repeat(64),
      },
      writeEscapeDenied: true,
    },
    cleanup: { devices: 0, images: 0, mounts: 0, payloadRoots: 0 },
    contractVersion: "0.1.0",
    filesystem: {
      blockCount: 32_768,
      blockSize: 4096,
      format: "APFS",
      name: "apfs",
      type: "17",
    },
    quotaProofSha256: "2".repeat(64),
    quotaProof: {
      allocatedResourceCeilingBytes: 134217728,
      blockCount: 32768,
      blockSize: 4096,
      contractVersion: "0.1.0",
      filesystemName: "apfs",
      filesystemType: "17",
      hdiutil: {
        path: "/usr/bin/hdiutil",
        sha256: "3".repeat(64),
        version: "help-sha256:fixture",
      },
      logicalBudgetBytes: 67108864,
      oversizeFastCopyRejected: true,
      recordKind: "agent-context-k03-native-quota-proof",
      reserveBytes: 201326592,
      sourcePolicy: { localPaths: false },
    },
    recordKind: "agent-context-k03-native-release-proof",
    runner: { architecture: "arm64", platform: "darwin" },
    sourcePolicy: { localPaths: false },
    status: "ready",
    tools: {
      bash: { path: "/bin/bash", sha256: "e".repeat(64), version: "darwin-bash-v1" },
      cp: { path: "/bin/cp", sha256: "0".repeat(64), version: "help-sha256:fixture" },
      dd: { path: "/bin/dd", sha256: "1".repeat(64), version: "help-sha256:fixture" },
      df: { path: "/bin/df", sha256: "e".repeat(64), version: "help-sha256:fixture" },
      dirname: {
        path: "/usr/bin/dirname",
        sha256: "2".repeat(64),
        version: "help-sha256:fixture",
      },
      env: { path: "/usr/bin/env", sha256: "b".repeat(64), version: "darwin-env-v1" },
      hdiutil: {
        path: "/usr/bin/hdiutil",
        sha256: "3".repeat(64),
        version: "help-sha256:fixture",
      },
      node: { path: "/opt/reviewed/node", sha256: "4".repeat(64), version: "v26.3.0" },
      pnpm: {
        path: "/opt/reviewed/pnpm/bin/pnpm.mjs",
        sha256: "2".repeat(64),
        version: "11.18.0",
      },
      sandboxExec: {
        path: "/usr/bin/sandbox-exec",
        sha256: "5".repeat(64),
        version: "sandbox-exec fixture",
      },
      sed: {
        path: "/usr/bin/sed",
        sha256: "a".repeat(64),
        version: "help-sha256:fixture",
      },
      sh: { path: "/bin/sh", sha256: "c".repeat(64), version: "darwin-sh-v1" },
      tar: { path: "/usr/bin/bsdtar", sha256: "7".repeat(64), version: "tar fixture" },
      uname: {
        path: "/usr/bin/uname",
        sha256: "d".repeat(64),
        version: "help-sha256:fixture",
      },
    },
  };
  proof.quotaProofSha256 = sha256Canonical(proof.quotaProof);
  return { ...proof, proofSha256: sha256Canonical(proof) };
}

test("native proof distinguishes the explicit pending state from digest-bound readiness", async () => {
  const pending = {
    contractVersion: "0.1.0",
    reason: "native release proof has not been captured",
    recordKind: "agent-context-k03-native-release-proof",
    status: "feature-unavailable",
  };
  assert.equal(
    (await validateNativeReleaseProof(pending, { repositoryRoot })).status,
    "feature-unavailable",
  );
  await assert.rejects(
    validateNativeReleaseProof(pending, { repositoryRoot, requireReady: true }),
    /requires a committed native Darwin release proof/u,
  );
  assert.equal(
    (
      await validateNativeReleaseProof(readyProof(), {
        repositoryRoot,
        requireReady: true,
        verifyLiveReady: async () => {},
      })
    ).status,
    "ready",
  );
  await assert.rejects(
    validateNativeReleaseProof(readyProof(), { repositoryRoot, requireReady: true }),
    /live native|Darwin runner class|ENOENT/u,
  );
});

test("native proof rejects digest drift and open fields", async () => {
  const drifted = readyProof();
  drifted.filesystem.blockSize = 8192;
  await assert.rejects(
    validateNativeReleaseProof(drifted, { repositoryRoot, requireReady: true }),
    /digest does not reconstruct/u,
  );
  await assert.rejects(
    validateNativeReleaseProof(
      { ...readyProof(), selfAssertedNativeValidation: true },
      { repositoryRoot, requireReady: true },
    ),
    /additional properties|exactly one schema/u,
  );
});

test("native proof reconstructs filesystem and hdiutil cross-record relations", async () => {
  const filesystemDrift = readyProof();
  filesystemDrift.filesystem.blockCount += 1;
  filesystemDrift.proofSha256 = sha256Canonical(
    Object.fromEntries(Object.entries(filesystemDrift).filter(([name]) => name !== "proofSha256")),
  );
  await assert.rejects(
    validateNativeReleaseProof(filesystemDrift, { repositoryRoot }),
    /filesystem relation/u,
  );
  const hdiutilDrift = readyProof();
  hdiutilDrift.tools.hdiutil = { ...hdiutilDrift.tools.hdiutil, version: "different" };
  hdiutilDrift.proofSha256 = sha256Canonical(
    Object.fromEntries(Object.entries(hdiutilDrift).filter(([name]) => name !== "proofSha256")),
  );
  await assert.rejects(
    validateNativeReleaseProof(hdiutilDrift, { repositoryRoot }),
    /hdiutil relation/u,
  );
});

test("native proof binds the complete pnpm, esbuild, and TypeScript graph relations", async () => {
  const launcherDrift = readyProof();
  launcherDrift.tools.pnpm = { ...launcherDrift.tools.pnpm, sha256: "f".repeat(64) };
  launcherDrift.proofSha256 = sha256Canonical(
    Object.fromEntries(Object.entries(launcherDrift).filter(([name]) => name !== "proofSha256")),
  );
  await assert.rejects(
    validateNativeReleaseProof(launcherDrift, { repositoryRoot }),
    /pnpm launcher relation/u,
  );
  for (const name of Object.keys(readyProof().buildTools)) {
    const versionDrift = readyProof();
    versionDrift.buildTools[name] = { ...versionDrift.buildTools[name], version: "0.0.0" };
    versionDrift.proofSha256 = sha256Canonical(
      Object.fromEntries(Object.entries(versionDrift).filter(([key]) => key !== "proofSha256")),
    );
    await assert.rejects(
      validateNativeReleaseProof(versionDrift, { repositoryRoot }),
      /pnpm launcher relation|manifest bin\.pnpm entry|version differs from the frozen build graph/u,
      name,
    );
  }
});
