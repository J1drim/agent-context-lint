import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(moduleDirectory, "../..");
export const buildLockPath = path.join(moduleDirectory, "container/build-lock.v1.json");
export const runtimeLockPath = path.join(moduleDirectory, "container/runtime-lock.v1.json");
export const MAX_LOCK_BYTES = 128 * 1024;
export const PREFLIGHT_CONTRACT_VERSION = "1.0.0";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_BUILD_INPUT_DIGESTS = Object.freeze([
  "manifestSha256",
  "preparationReviewSha256",
  "preparationSourceManifestSha256",
]);
const REQUIRED_RUNTIME_IMAGE_FIELDS = Object.freeze([
  "configurationDigest",
  "layerDiffIds",
  "localReference",
  "platformManifestDigest",
  "repoDigest",
  "sizeBytes",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(code) {
  return Object.freeze({ code });
}

function hasDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function hasSha256(value) {
  return hasDigest(value) || (typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value));
}

function parseLockBytes(bytes, kind) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 2 || bytes.byteLength > MAX_LOCK_BYTES)
    return { value: null, issues: [issue(`${kind}-bytes-invalid`)] };
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { value: null, issues: [issue(`${kind}-json-invalid`)] };
  }
  if (!isRecord(value)) return { value: null, issues: [issue(`${kind}-record-invalid`)] };
  // Lock files are committed as pretty JSON with one final newline. This is a
  // small duplicate-key/canonicality guard before any transition field is used.
  if (JSON.stringify(value, null, 2) + "\n" !== bytes.toString("utf8"))
    return { value: null, issues: [issue(`${kind}-bytes-noncanonical`)] };
  return { value, issues: [] };
}

function validateBuildLock(buildLock, issues) {
  if (!isRecord(buildLock)) {
    issues.push(issue("build-lock-record-invalid"));
    return;
  }
  if (buildLock.recordKind !== "agent-context-h13-runtime-build-lock")
    issues.push(issue("build-lock-record-kind-invalid"));
  if (buildLock.contractVersion !== "1.0.0")
    issues.push(issue("build-lock-contract-version-invalid"));
  if (!isRecord(buildLock.buildInputs)) {
    issues.push(issue("build-lock-inputs-invalid"));
    return;
  }
  if (!hasDigest(buildLock.buildInputs.manifestSha256))
    issues.push(issue("build-lock-manifest-digest-invalid"));
  for (const field of REQUIRED_BUILD_INPUT_DIGESTS.slice(1)) {
    if (!hasDigest(buildLock.buildInputs[field]))
      issues.push(
        issue(
          field === "preparationReviewSha256"
            ? "build-lock-preparation-review-digest-invalid"
            : "build-lock-preparation-source-digest-invalid",
        ),
      );
  }
  if (!Number.isSafeInteger(buildLock.buildInputs.sourceDateEpoch))
    issues.push(issue("build-lock-source-date-epoch-invalid"));
  const transition = buildLock.transition;
  if (!isRecord(transition) || transition.state !== "candidate-reviewed-for-build")
    issues.push(issue("build-lock-transition-not-reviewed"));
  else if (!hasDigest(transition.predecessorBuildLockSha256))
    issues.push(issue("build-lock-predecessor-digest-invalid"));
}

function validateRuntimeLock(runtimeLock, issues) {
  if (!isRecord(runtimeLock)) {
    issues.push(issue("runtime-lock-record-invalid"));
    return;
  }
  if (runtimeLock.recordKind !== "agent-context-h13-containment-runtime-lock")
    issues.push(issue("runtime-lock-record-kind-invalid"));
  if (runtimeLock.contractVersion !== "1.0.0")
    issues.push(issue("runtime-lock-contract-version-invalid"));
  if (!hasDigest(runtimeLock.buildLockSha256))
    issues.push(issue("runtime-lock-build-digest-invalid"));
  if (!isRecord(runtimeLock.buildInputs)) issues.push(issue("runtime-lock-inputs-invalid"));
  const transition = runtimeLock.transition;
  if (!isRecord(transition) || transition.state !== "candidate-reviewed-for-runtime")
    issues.push(issue("runtime-lock-transition-not-reviewed"));
  else if (!hasDigest(transition.predecessorRuntimeLockSha256))
    issues.push(issue("runtime-lock-predecessor-digest-invalid"));
  const image = runtimeLock.runtimeImage;
  if (!isRecord(image)) {
    issues.push(issue("runtime-image-invalid"));
    return;
  }
  for (const field of REQUIRED_RUNTIME_IMAGE_FIELDS) {
    const value = image[field];
    const valid = ["configurationDigest", "platformManifestDigest", "repoDigest"].includes(field)
      ? hasSha256(value)
      : field === "layerDiffIds"
        ? Array.isArray(value) && value.length > 0 && value.every((entry) => hasSha256(entry))
        : field === "sizeBytes"
          ? Number.isSafeInteger(value) && value > 0
          : typeof value === "string" && value.length > 0;
    if (!valid)
      issues.push(
        issue(`runtime-image-${field.replaceAll(/([A-Z])/gu, "-$1").toLowerCase()}-invalid`),
      );
  }
}

function compareBuildInputs(buildLock, runtimeLock, issues) {
  if (!isRecord(buildLock?.buildInputs) || !isRecord(runtimeLock?.buildInputs)) return;
  if (JSON.stringify(buildLock.buildInputs) !== JSON.stringify(runtimeLock.buildInputs))
    issues.push(issue("runtime-lock-build-inputs-mismatch"));
}

/**
 * Inspect the committed/candidate H13 lock pair without network, Docker, Git,
 * subprocess, clock, or mutation capability. A ready result only proves the
 * lock transition is internally bound; preparation inputs, image availability,
 * and contained capture still require the explicit H13 commands.
 */
export function assessRecoveryLockPair({ buildLockBytes, runtimeLockBytes, readIssues = [] }) {
  const normalizedReadIssues = readIssues.filter(
    (entry) =>
      isRecord(entry) &&
      (entry.code === "build-lock-read-failed" || entry.code === "runtime-lock-read-failed"),
  );
  const buildReadFailed = normalizedReadIssues.some(
    (entry) => entry.code === "build-lock-read-failed",
  );
  const runtimeReadFailed = normalizedReadIssues.some(
    (entry) => entry.code === "runtime-lock-read-failed",
  );
  const buildParsed = buildReadFailed
    ? { value: null, issues: [] }
    : parseLockBytes(buildLockBytes, "build-lock");
  const runtimeParsed = runtimeReadFailed
    ? { value: null, issues: [] }
    : parseLockBytes(runtimeLockBytes, "runtime-lock");
  const issues = [...normalizedReadIssues, ...buildParsed.issues, ...runtimeParsed.issues];
  if (buildParsed.value !== null) validateBuildLock(buildParsed.value, issues);
  if (runtimeParsed.value !== null) validateRuntimeLock(runtimeParsed.value, issues);
  compareBuildInputs(buildParsed.value, runtimeParsed.value, issues);

  const buildDigest = Buffer.isBuffer(buildLockBytes) ? sha256(buildLockBytes) : null;
  const runtimeDigest = Buffer.isBuffer(runtimeLockBytes) ? sha256(runtimeLockBytes) : null;
  if (runtimeParsed.value !== null && buildDigest !== null) {
    if (runtimeParsed.value.buildLockSha256 !== buildDigest)
      issues.push(issue("runtime-lock-build-digest-mismatch"));
  }
  const uniqueIssues = [...new Map(issues.map((entry) => [entry.code, entry])).values()].sort(
    (a, b) => a.code.localeCompare(b.code),
  );
  const buildReady =
    buildParsed.value !== null && uniqueIssues.every(({ code }) => !code.startsWith("build-lock-"));
  const captureReady = buildReady && uniqueIssues.length === 0;
  return Object.freeze({
    captureReady,
    contractVersion: PREFLIGHT_CONTRACT_VERSION,
    recordKind: "agent-context-h13-recovery-lock-preflight",
    buildLockSha256: buildDigest,
    runtimeLockSha256: runtimeDigest,
    issues: Object.freeze(uniqueIssues),
    lockTransitionReadyForOfflineBuild: buildReady,
    networkAccess: false,
    mutation: false,
    state: captureReady ? "ready-for-capture" : buildReady ? "ready-for-offline-build" : "blocked",
  });
}

function textReport(result) {
  const lines = [
    `H13 lock preflight state=${result.state}`,
    `offlineBuildReady=${String(result.lockTransitionReadyForOfflineBuild)} captureReady=${String(result.captureReady)}`,
    `networkAccess=false mutation=false`,
  ];
  if (result.issues.length > 0)
    lines.push(`issues=${result.issues.map(({ code }) => code).join(",")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Read both lock inputs without exposing host filesystem errors. The caller
 * still decides how to render the resulting deterministic issue codes.
 */
export async function readRecoveryLockPair({
  buildPath = buildLockPath,
  runtimePath = runtimeLockPath,
} = {}) {
  const readLock = async (lockPath, kind) => {
    try {
      return { bytes: await readFile(lockPath), issue: null };
    } catch {
      // Do not expose host paths or filesystem error text in the machine report.
      return { bytes: null, issue: issue(`${kind}-read-failed`) };
    }
  };
  const [build, runtime] = await Promise.all([
    readLock(buildPath, "build-lock"),
    readLock(runtimePath, "runtime-lock"),
  ]);
  return Object.freeze({
    buildLockBytes: build.bytes,
    readIssues: Object.freeze([build.issue, runtime.issue].filter((entry) => entry !== null)),
    runtimeLockBytes: runtime.bytes,
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.some((argument) => !["--json", "--text"].includes(argument)) ||
    (arguments_.includes("--json") && arguments_.includes("--text"))
  ) {
    process.stderr.write(
      "usage: node tools/standards/recovery-lock-preflight.mjs [--json|--text]\n",
    );
    process.exitCode = 2;
    return;
  }
  const result = assessRecoveryLockPair(await readRecoveryLockPair());
  if (arguments_.includes("--text")) process.stdout.write(textReport(result));
  else process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.captureReady) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
