import { canonicalJson, digest } from "./container/runtime-inputs.mjs";

function sha256(value) {
  return digest("sha256", Buffer.from(`${canonicalJson(value)}\n`));
}

function exactDigest(value, field) {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`H13 ${field} digest is invalid`);
  return value;
}

export function createReviewedPreparationTransition({ first, second, reviewerId, reviewedAt }) {
  if (canonicalJson(first.inputManifest) !== canonicalJson(second.inputManifest))
    throw new Error("reviewed H13 preparations have different input manifests");
  if (canonicalJson(first.sourceManifest) !== canonicalJson(second.sourceManifest))
    throw new Error("reviewed H13 preparations have different source manifests");
  if (reviewerId !== "jakub-niezgoda" || !Number.isFinite(Date.parse(reviewedAt)))
    throw new Error("H13 preparation review identity or time is invalid");
  const inputManifestSha256 = sha256(first.inputManifest);
  const preparationSourceManifestSha256 = sha256(first.sourceManifest);
  if (
    first.inputManifest.preparationSourceManifestSha256 !== preparationSourceManifestSha256 ||
    second.inputManifest.preparationSourceManifestSha256 !== preparationSourceManifestSha256
  )
    throw new Error("reviewed H13 input manifest is not bound to its source manifest");
  return Object.freeze({
    contractVersion: "1.0.0",
    inputManifestSha256,
    preparationSourceManifestSha256,
    recordKind: "agent-context-h13-reviewed-preparation-transition",
    reviewedAt,
    reviewedPrepareCount: 2,
    reviewerId,
    state: "reviewed-for-build",
  });
}

export function createBuildLockCandidate(currentBuildLock, review, options = {}) {
  if (review.state !== "reviewed-for-build" || review.reviewedPrepareCount !== 2)
    throw new Error("H13 build-lock candidate requires a two-prepare review");
  const predecessorBuildLockSha256 = options.predecessorBuildLockSha256 ?? sha256(currentBuildLock);
  exactDigest(predecessorBuildLockSha256, "predecessor build lock");
  return Object.freeze({
    ...structuredClone(currentBuildLock),
    buildInputs: {
      ...structuredClone(currentBuildLock.buildInputs),
      manifestSha256: exactDigest(review.inputManifestSha256, "input manifest"),
      preparationReviewSha256: sha256(review),
      preparationSourceManifestSha256: exactDigest(
        review.preparationSourceManifestSha256,
        "preparation source manifest",
      ),
    },
    transition: {
      predecessorBuildLockSha256,
      state: "candidate-reviewed-for-build",
    },
  });
}

export function createRuntimeLockCandidate(
  currentRuntimeLock,
  buildLockCandidate,
  runtimeImage,
  options = {},
) {
  if (buildLockCandidate.transition?.state !== "candidate-reviewed-for-build")
    throw new Error("H13 runtime-lock candidate requires a reviewed build-lock candidate");
  const buildLockSha256 = options.buildLockSha256 ?? sha256(buildLockCandidate);
  exactDigest(buildLockSha256, "build lock");
  const predecessorRuntimeLockSha256 =
    options.predecessorRuntimeLockSha256 ?? sha256(currentRuntimeLock);
  exactDigest(predecessorRuntimeLockSha256, "predecessor runtime lock");
  return Object.freeze({
    ...structuredClone(currentRuntimeLock),
    buildInputs: structuredClone(buildLockCandidate.buildInputs),
    buildLockSha256,
    runtimeImage: structuredClone(runtimeImage),
    transition: {
      predecessorRuntimeLockSha256,
      state: "candidate-reviewed-for-runtime",
    },
  });
}

export function assertReviewedLockTransition(buildLock, runtimeLock, options = {}) {
  const buildLockSha256 = options.buildLockSha256 ?? sha256(buildLock);
  if (
    buildLock.transition?.state !== "candidate-reviewed-for-build" ||
    runtimeLock.transition?.state !== "candidate-reviewed-for-runtime" ||
    runtimeLock.buildLockSha256 !== buildLockSha256 ||
    canonicalJson(runtimeLock.buildInputs) !== canonicalJson(buildLock.buildInputs)
  )
    throw new Error("H13 candidate build/runtime locks are not one reviewed transition");
  return Object.freeze({
    buildLockSha256: runtimeLock.buildLockSha256,
    preparationReviewSha256: buildLock.buildInputs.preparationReviewSha256,
    preparationSourceManifestSha256: buildLock.buildInputs.preparationSourceManifestSha256,
    state: "reviewed-lock-pair",
  });
}
