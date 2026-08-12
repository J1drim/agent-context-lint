import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { sha256Canonical } from "./contracts.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;

export async function validateNativeReleaseProofStructure(proof, { repositoryRoot }) {
  const schema = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "calibration/schemas/metadata-calibration-native-proof.v0.schema.json",
      ),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(proof))
    throw new Error(
      (validate.errors ?? [])
        .map((error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`)
        .join("\n"),
    );
  if (proof.status === "ready") {
    if (proof.quotaProofSha256 !== sha256Canonical(proof.quotaProof))
      throw new Error("native Darwin quota proof digest does not reconstruct");
    const payload = { ...proof };
    delete payload.proofSha256;
    if (proof.proofSha256 !== sha256Canonical(payload))
      throw new Error("native Darwin release proof digest does not reconstruct");
    if (proof.tools.node.path !== path.resolve(proof.tools.node.path))
      throw new Error("native Darwin release proof Node path is not canonical and absolute");
    if (
      sha256Canonical(proof.filesystem) !==
      sha256Canonical({
        blockCount: proof.quotaProof.blockCount,
        blockSize: proof.quotaProof.blockSize,
        format: "APFS",
        name: proof.quotaProof.filesystemName,
        type: proof.quotaProof.filesystemType,
      })
    )
      throw new Error("native Darwin filesystem relation does not reconstruct from quota proof");
    if (sha256Canonical(proof.tools.hdiutil) !== sha256Canonical(proof.quotaProof.hdiutil))
      throw new Error("native Darwin hdiutil relation differs between tool and quota proof");
    if (sha256Canonical(proof.tools.pnpm) !== sha256Canonical(proof.buildTools.pnpmLauncher))
      throw new Error("native Darwin pnpm launcher relation differs from the build graph");
    if (
      sha256Canonical(proof.buildTools.pnpmLauncher) !== sha256Canonical(proof.buildTools.pnpmEntry)
    )
      throw new Error("native Darwin pnpm launcher does not equal manifest bin.pnpm entry");
    if (
      proof.buildTools.pnpmCompatibilityShim.path === proof.buildTools.pnpmLauncher.path ||
      proof.buildTools.pnpmCompatibilityShim.sha256 === proof.buildTools.pnpmLauncher.sha256
    )
      throw new Error("native Darwin pnpm compatibility shim is not independently bound");
    for (const [name, tool] of Object.entries(proof.buildTools)) {
      const expectedVersion = name.startsWith("pnpm")
        ? "11.18.0"
        : name.startsWith("esbuild")
          ? "0.28.1"
          : "7.0.2";
      if (tool.version !== expectedVersion)
        throw new Error(`native Darwin ${name} version differs from the frozen build graph`);
    }
  }
  return proof;
}

export async function validateNativeReleaseProof(
  proof,
  { repositoryRoot, requireReady = false, verifyLiveReady } = {},
) {
  await validateNativeReleaseProofStructure(proof, { repositoryRoot });
  if (!requireReady) return proof;
  if (proof.status !== "ready")
    throw new Error("K03 ready gate requires a committed native Darwin release proof");
  const verify =
    verifyLiveReady ?? (await import("./native-live-verifier.mjs")).verifyLiveNativeReleaseProof;
  if (typeof verify !== "function")
    throw new Error("K03 ready gate requires a live native proof verifier");
  await verify(proof, { repositoryRoot });
  return proof;
}
