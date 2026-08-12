import { lstat, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  copyBoundedTree,
  digest,
  verifyInputDirectory,
} from "./container/runtime-inputs.mjs";
import {
  createBuildLockCandidate,
  createReviewedPreparationTransition,
} from "./recovery-provenance-transition.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (
  process.argv.length !== 5 ||
  process.argv[2] !== "--acknowledge-reviewed-preparations" ||
  process.argv[3] !== "--reviewer=jakub-niezgoda" ||
  !process.argv[4].startsWith("--reviewed-at=")
)
  throw new Error(
    "usage: node tools/standards/review-recovery-preparations.mjs --acknowledge-reviewed-preparations --reviewer=jakub-niezgoda --reviewed-at=<ISO-UTC>",
  );

const currentBuildLockBytes = await readFile(
  path.join(root, "tools/standards/container/build-lock.v1.json"),
);
const currentBuildLock = JSON.parse(currentBuildLockBytes);

async function readPreparation(slot) {
  const directory = path.join(
    os.tmpdir(),
    `agent-context-h13-${path.basename(root)}-runtime-inputs-${slot}`,
  );
  const inputBytes = await readFile(path.join(directory, "input-manifest.v1.json"));
  const sourceBytes = await readFile(path.join(directory, "preparation-source-manifest.v1.json"));
  const inputManifest = JSON.parse(inputBytes);
  const sourceManifest = JSON.parse(sourceBytes);
  if (
    digest("sha256", sourceBytes) !== inputManifest.preparationSourceManifestSha256 ||
    `${canonicalJson(inputManifest)}\n` !== inputBytes.toString("utf8") ||
    `${canonicalJson(sourceManifest)}\n` !== sourceBytes.toString("utf8")
  )
    throw new Error(`H13 preparation ${slot} is not canonical or source-bound`);
  await verifyInputDirectory(
    directory,
    digest("sha256", inputBytes),
    await readFile(path.join(root, "pnpm-lock.yaml")),
    currentBuildLock.packageManager,
    { preparationSourceManifestSha256: digest("sha256", sourceBytes) },
  );
  return { inputManifest, sourceManifest };
}

const review = createReviewedPreparationTransition({
  first: await readPreparation("a"),
  second: await readPreparation("b"),
  reviewedAt: process.argv[4].slice("--reviewed-at=".length),
  reviewerId: "jakub-niezgoda",
});
const candidateBuildLock = createBuildLockCandidate(currentBuildLock, review, {
  predecessorBuildLockSha256: digest("sha256", currentBuildLockBytes),
});
const reviewedInputs = path.join(root, ".h13-runtime-inputs-reviewed");
try {
  await lstat(reviewedInputs);
  throw new Error("H13 reviewed runtime input destination already exists");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
try {
  await copyBoundedTree(
    path.join(os.tmpdir(), `agent-context-h13-${path.basename(root)}-runtime-inputs-a`),
    reviewedInputs,
  );
  await verifyInputDirectory(
    reviewedInputs,
    review.inputManifestSha256,
    await readFile(path.join(root, "pnpm-lock.yaml")),
    currentBuildLock.packageManager,
    { preparationSourceManifestSha256: review.preparationSourceManifestSha256 },
  );
} catch (error) {
  await rm(reviewedInputs, { force: true, recursive: true });
  throw error;
}
process.stdout.write(`${canonicalJson({ candidateBuildLock, review })}\n`);
