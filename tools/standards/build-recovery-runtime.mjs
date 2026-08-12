import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  verifyBaseDescriptors,
  verifyInputDirectory,
} from "./container/runtime-inputs.mjs";
import { createRuntimeLockCandidate } from "./recovery-provenance-transition.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const containerDirectory = path.join(root, "tools/standards/container");
const buildLockBytes = await readFile(path.join(containerDirectory, "build-lock.v1.json"));
const lock = JSON.parse(buildLockBytes);
const currentRuntimeLockBytes = await readFile(
  path.join(containerDirectory, "runtime-lock.v1.json"),
);
const currentRuntimeLock = JSON.parse(currentRuntimeLockBytes);
if (
  lock.transition?.state !== "candidate-reviewed-for-build" ||
  !/^[0-9a-f]{64}$/u.test(lock.buildInputs.preparationReviewSha256) ||
  !/^[0-9a-f]{64}$/u.test(lock.buildInputs.preparationSourceManifestSha256)
)
  throw new Error("offline runtime build requires the reviewed two-prepare build-lock transition");
if (process.argv.length !== 3 || process.argv[2] !== "--acknowledge-offline-build")
  throw new Error(
    "usage: node tools/standards/build-recovery-runtime.mjs --acknowledge-offline-build",
  );
await verifyBaseDescriptors(containerDirectory, lock.baseImage);
await verifyInputDirectory(
  path.join(root, ".h13-runtime-inputs-reviewed"),
  lock.buildInputs.manifestSha256,
  await readFile(path.join(root, "pnpm-lock.yaml")),
  lock.packageManager,
  { preparationSourceManifestSha256: lock.buildInputs.preparationSourceManifestSha256 },
);

const docker = "/opt/homebrew/Cellar/docker/29.5.2/bin/docker";
async function run(arguments_, capture = false) {
  const child = spawn(docker, arguments_, {
    cwd: root,
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
    shell: false,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  const result = await new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, 300_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
  if (result.code !== 0 || result.signal !== null || result.timedOut)
    throw new Error("offline runtime build failed");
  return stdout.trim();
}
const buildArguments = (tag) => [
  "build",
  "--platform",
  "linux/arm64",
  "--network",
  "none",
  "--pull=false",
  "--no-cache",
  "--provenance=false",
  "--build-arg",
  `SOURCE_DATE_EPOCH=${lock.buildInputs.sourceDateEpoch}`,
  "--file",
  "tools/standards/container/Dockerfile",
  "--tag",
  tag,
  ".",
];
const candidates = ["agent-context-h13-repro-a:1.0.0", "agent-context-h13-repro-b:1.0.0"];
const identities = [];
for (const candidate of candidates) {
  await run(buildArguments(candidate));
  const image = JSON.parse(
    await run(["image", "inspect", candidate, "--format", "{{json .}}"], true),
  );
  identities.push({
    configuration: {
      cmd: image.Config?.Cmd,
      entrypoint: image.Config?.Entrypoint,
      env: image.Config?.Env,
      user: image.Config?.User,
      workingDirectory: image.Config?.WorkingDir,
    },
    created: image.Created,
    descriptor: image.Descriptor,
    rootfs: image.RootFS,
    size: image.Size,
  });
}
if (JSON.stringify(identities[0]) !== JSON.stringify(identities[1]))
  throw new Error(
    "repeat offline builds produced different OCI config, manifest, or layer identities",
  );
await run(["tag", candidates[0], "agent-context-h13-runtime:1.0.0"]);
const candidateRuntimeLock = createRuntimeLockCandidate(
  currentRuntimeLock,
  lock,
  {
    configurationDigest: identities[0].descriptor?.annotations?.["config.digest"],
    layerDiffIds: identities[0].rootfs?.Layers,
    localReference: "agent-context-h13-runtime:1.0.0",
    platformManifestDigest: identities[0].descriptor?.digest,
    repoDigest: identities[0].descriptor?.digest,
    sizeBytes: identities[0].size,
  },
  {
    buildLockSha256: createHash("sha256").update(buildLockBytes).digest("hex"),
    predecessorRuntimeLockSha256: createHash("sha256")
      .update(currentRuntimeLockBytes)
      .digest("hex"),
  },
);
process.stdout.write(`${canonicalJson({ candidateRuntimeLock, identity: identities[0] })}\n`);
