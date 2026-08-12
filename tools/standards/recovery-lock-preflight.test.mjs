import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assessRecoveryLockPair,
  buildLockPath,
  MAX_LOCK_BYTES,
  readRecoveryLockPair,
  runtimeLockPath,
} from "./recovery-lock-preflight.mjs";

const scriptPath = path.join(process.cwd(), "tools/standards/recovery-lock-preflight.mjs");

function encodeLock(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function candidatePair() {
  const [buildBytes, runtimeBytes] = await Promise.all([
    readFile(buildLockPath),
    readFile(runtimeLockPath),
  ]);
  const build = JSON.parse(buildBytes);
  const runtime = JSON.parse(runtimeBytes);
  const buildInputs = {
    ...build.buildInputs,
    manifestSha256: "a".repeat(64),
    preparationReviewSha256: "b".repeat(64),
    preparationSourceManifestSha256: "c".repeat(64),
  };
  build.buildInputs = buildInputs;
  build.transition = {
    predecessorBuildLockSha256: "d".repeat(64),
    state: "candidate-reviewed-for-build",
  };
  const nextBuildBytes = encodeLock(build);
  runtime.buildInputs = structuredClone(buildInputs);
  runtime.buildLockSha256 = digest(nextBuildBytes);
  runtime.transition = {
    predecessorRuntimeLockSha256: "e".repeat(64),
    state: "candidate-reviewed-for-runtime",
  };
  return { build, buildBytes: nextBuildBytes, runtime, runtimeBytes: encodeLock(runtime) };
}

test("the committed stale pair is machine-readable and remains fail-closed", async () => {
  const [buildLockBytes, runtimeLockBytes] = await Promise.all([
    readFile(buildLockPath),
    readFile(runtimeLockPath),
  ]);
  const result = assessRecoveryLockPair({ buildLockBytes, runtimeLockBytes });
  assert.equal(result.state, "blocked");
  assert.equal(result.lockTransitionReadyForOfflineBuild, false);
  assert.equal(result.captureReady, false);
  assert.deepEqual(
    result.issues.map(({ code }) => code),
    [
      "build-lock-preparation-review-digest-invalid",
      "build-lock-preparation-source-digest-invalid",
      "build-lock-transition-not-reviewed",
      "runtime-lock-transition-not-reviewed",
    ],
  );
  assert.equal(result.networkAccess, false);
  assert.equal(result.mutation, false);
  assert.ok(result.buildLockSha256 && result.runtimeLockSha256);
});

test("a reviewed pair is accepted only for the bounded lock transition", async () => {
  const pair = await candidatePair();
  const result = assessRecoveryLockPair({
    buildLockBytes: pair.buildBytes,
    runtimeLockBytes: pair.runtimeBytes,
  });
  assert.equal(result.state, "ready-for-capture");
  assert.equal(result.lockTransitionReadyForOfflineBuild, true);
  assert.equal(result.captureReady, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.buildLockSha256, digest(pair.buildBytes));
  assert.equal(result.runtimeLockSha256, digest(pair.runtimeBytes));
  assert.equal(result.networkAccess, false);
  assert.equal(result.mutation, false);
});

test("a reviewed build candidate remains eligible for offline build when runtime linkage is bad", async () => {
  const pair = await candidatePair();
  pair.runtime.buildLockSha256 = "f".repeat(64);
  const result = assessRecoveryLockPair({
    buildLockBytes: pair.buildBytes,
    runtimeLockBytes: encodeLock(pair.runtime),
  });
  assert.equal(result.state, "ready-for-offline-build");
  assert.equal(result.lockTransitionReadyForOfflineBuild, true);
  assert.equal(result.captureReady, false);
  assert.deepEqual(
    result.issues.map(({ code }) => code),
    ["runtime-lock-build-digest-mismatch"],
  );
});

test("digest, predecessor, input, and runtime image mutations fail closed", async () => {
  const pair = await candidatePair();
  const changedBuild = structuredClone(pair.build);
  changedBuild.transition.predecessorBuildLockSha256 = "not-a-digest";
  const changedRuntime = structuredClone(pair.runtime);
  changedRuntime.buildInputs.sourceDateEpoch += 1;
  changedRuntime.runtimeImage.layerDiffIds = ["bad"];
  const result = assessRecoveryLockPair({
    buildLockBytes: encodeLock(changedBuild),
    runtimeLockBytes: encodeLock(changedRuntime),
  });
  assert.equal(result.captureReady, false);
  assert.ok(result.issues.some(({ code }) => code === "build-lock-predecessor-digest-invalid"));
  assert.ok(result.issues.some(({ code }) => code === "runtime-lock-build-inputs-mismatch"));
  assert.ok(result.issues.some(({ code }) => code === "runtime-image-layer-diff-ids-invalid"));
});

test("oversized, malformed, and duplicate-key lock bytes are rejected before transition use", () => {
  const oversized = Buffer.alloc(MAX_LOCK_BYTES + 1, 0x20);
  const malformed = Buffer.from("{\n", "utf8");
  const duplicate = Buffer.from('{"recordKind":"first","recordKind":"second"}\n', "utf8");
  for (const [buildLockBytes, code] of [
    [oversized, "build-lock-bytes-invalid"],
    [malformed, "build-lock-json-invalid"],
    [duplicate, "build-lock-bytes-noncanonical"],
  ]) {
    const result = assessRecoveryLockPair({
      buildLockBytes,
      runtimeLockBytes: Buffer.from("{}\n", "utf8"),
    });
    assert.ok(result.issues.some((entry) => entry.code === code));
    assert.equal(result.captureReady, false);
  }
});

test("missing or unreadable lock inputs produce stable blocked diagnostics", async () => {
  const missing = path.join(
    path.dirname(buildLockPath),
    `.h13-missing-${process.pid}-${Date.now()}`,
  );
  const pair = await readRecoveryLockPair({
    buildPath: path.join(missing, "build-lock.v1.json"),
    runtimePath: path.join(missing, "runtime-lock.v1.json"),
  });
  const result = assessRecoveryLockPair(pair);
  assert.equal(result.state, "blocked");
  assert.equal(result.lockTransitionReadyForOfflineBuild, false);
  assert.equal(result.captureReady, false);
  assert.deepEqual(
    result.issues.map(({ code }) => code),
    ["build-lock-read-failed", "runtime-lock-read-failed"],
  );
  assert.equal(result.networkAccess, false);
  assert.equal(result.mutation, false);
});

test("the CLI emits stable JSON/text diagnostics and rejects unsupported options", () => {
  const json = spawnSync(process.execPath, [scriptPath, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 2);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.recordKind, "agent-context-h13-recovery-lock-preflight");
  assert.equal(parsed.state, "blocked");
  assert.equal(parsed.networkAccess, false);
  assert.equal(parsed.mutation, false);
  assert.equal(json.stderr, "");

  const text = spawnSync(process.execPath, [scriptPath, "--text"], { encoding: "utf8" });
  assert.equal(text.status, 2);
  assert.match(text.stdout, /^H13 lock preflight state=blocked\n/u);
  assert.match(text.stdout, /networkAccess=false mutation=false/u);

  const unsupported = spawnSync(process.execPath, [scriptPath, "--no-network"], {
    encoding: "utf8",
  });
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /usage:/u);
  assert.equal(unsupported.stdout, "");
  const repeated = spawnSync(process.execPath, [scriptPath, "--text"], { encoding: "utf8" });
  assert.equal(repeated.status, 2);
  assert.equal(repeated.stdout, text.stdout);
});
