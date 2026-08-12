import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  PACKAGE_INSTALL_MATRIX_EVIDENCE_LIMITS,
  PACKAGE_INSTALL_MATRIX_EVIDENCE_SCHEMA,
  canonicalJson,
  createPackageInstallMatrixEvidence,
  main,
  nodeRuntimeSatisfiesReleaseRange,
  packageInstallMatrixReportDigest,
  replayPackageInstallMatrixEvidence,
  validatePackageInstallMatrixEvidence,
} from "./package-install-matrix-evidence.mjs";

const CLI_TARBALL = "a".repeat(64);
const CORE_TARBALL = "b".repeat(64);
const CLI_MANIFEST = "c".repeat(64);
const CORE_MANIFEST = "d".repeat(64);
const NODE_VERSION = "v26.3.0";

function passedManager(manager) {
  return {
    manager,
    runtime: manager === "bun" ? "native" : "node",
    state: "passed",
    nodeVersion: NODE_VERSION,
    managerVersion: manager === "pnpm" ? "11.18.0" : "1.0.0",
    cliManifestSha256: CLI_MANIFEST,
    coreManifestSha256: CORE_MANIFEST,
  };
}

function rawReport(overrides = {}) {
  return {
    artifactKind: "agent-context-package-install-matrix",
    schemaVersion: "0.1.0",
    nodeVersion: NODE_VERSION,
    selectedManagers: ["npm", "pnpm"],
    strict: true,
    managers: [passedManager("npm"), passedManager("pnpm")],
    tarballs: { cliSha256: CLI_TARBALL, coreSha256: CORE_TARBALL },
    ...overrides,
  };
}

async function schemaValidator() {
  const schema = JSON.parse(
    await readFile(
      path.join("docs/contracts", "package-install-matrix-report.v1.schema.json"),
      "utf8",
    ),
  );
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

test("release Node range is explicit and rejects unsupported or prerelease runtimes", () => {
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v24.11.0"), true);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v26.0.0"), true);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v24.10.0"), false);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v25.0.0"), false);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v26.0.0-rc.1"), false);
  assert.equal(nodeRuntimeSatisfiesReleaseRange("v24.18.1+build.1"), true);
});

test("raw matrix is normalized into closed redacted evidence with a canonical digest", async () => {
  const report = createPackageInstallMatrixEvidence(rawReport());
  assert.equal(report.$schema, PACKAGE_INSTALL_MATRIX_EVIDENCE_SCHEMA);
  assert.equal(report.assessment, "passed");
  assert.equal(report.reportSha256, packageInstallMatrixReportDigest(report));
  assert.equal(canonicalJson(report).includes("agent-context-package-install-matrix"), true);
  assert.equal(report.managers[0].managerVersion, "1.0.0");
  assert.equal(report.managers[1].managerVersion, "11.18.0");
  const validate = await schemaValidator();
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  const replay = replayPackageInstallMatrixEvidence(report);
  assert.equal(replay.releaseReady, true);
  assert.equal(replay.success, true);
  assert.deepEqual(replay.passedManagers, ["npm", "pnpm"]);
});

test("strict raw passes require explicit manager runtime and Node attestations", () => {
  assert.throws(
    () =>
      createPackageInstallMatrixEvidence(
        rawReport({
          managers: [
            {
              manager: "npm",
              state: "passed",
              managerVersion: "1.0.0",
              cliManifestSha256: CLI_MANIFEST,
              coreManifestSha256: CORE_MANIFEST,
            },
            passedManager("pnpm"),
          ],
        }),
      ),
    /runtime and Node attestation/u,
  );
});

test("failure reasons are reduced to bounded codes and never retain paths or output text", () => {
  const report = createPackageInstallMatrixEvidence(
    rawReport({
      strict: false,
      managers: [
        passedManager("npm"),
        {
          manager: "pnpm",
          state: "failed",
          reason: "package install linked back into /Users/alice/private-workspace",
          stderrSha256: "e".repeat(64),
          stderrBytes: 17,
        },
      ],
    }),
  );
  assert.equal(report.assessment, "blocked");
  assert.equal(report.managers[1].reason, "workspace-backlink");
  assert.equal(canonicalJson(report).includes("/Users/alice"), false);
  assert.equal(canonicalJson(report).includes("private-workspace"), false);
  assert.equal(canonicalJson(report).includes("package install linked"), false);
  assert.equal(replayPackageInstallMatrixEvidence(report).success, false);
});

test("already-redacted runner reason codes remain stable during evidence conversion", () => {
  const report = createPackageInstallMatrixEvidence(
    rawReport({
      strict: false,
      managers: [
        passedManager("npm"),
        { manager: "pnpm", state: "failed", reason: "invalid-pnpm-launcher" },
      ],
    }),
  );
  assert.equal(report.managers[1].reason, "invalid-pnpm-launcher");
  assert.equal(replayPackageInstallMatrixEvidence(report).releaseReady, false);
});

test("manager-version diagnostics remain bounded and are accepted for every manager", () => {
  const report = createPackageInstallMatrixEvidence(
    rawReport({
      strict: false,
      managers: [
        { manager: "npm", state: "failed", reason: "manager-version-invalid" },
        { manager: "pnpm", state: "failed", reason: "manager-version-probe-failed" },
      ],
    }),
  );
  assert.deepEqual(
    report.managers.map(({ manager, reason, managerVersion }) => ({
      manager,
      reason,
      managerVersion,
    })),
    [
      { manager: "npm", reason: "manager-version-invalid", managerVersion: undefined },
      { manager: "pnpm", reason: "manager-version-probe-failed", managerVersion: undefined },
    ],
  );
  assert.throws(
    () =>
      createPackageInstallMatrixEvidence(
        rawReport({
          managers: [
            passedManager("npm"),
            { ...passedManager("pnpm"), managerVersion: "v11.18.0" },
          ],
        }),
      ),
    /stable package-manager version/u,
  );
});

test("failed runtime attestation retains the observed mismatch without minting a pass", () => {
  const report = createPackageInstallMatrixEvidence(
    rawReport({
      strict: false,
      managers: [
        {
          manager: "npm",
          runtime: "node",
          state: "failed",
          nodeVersion: "v22.14.0",
          reason: "node-runtime-mismatch",
        },
        passedManager("pnpm"),
      ],
    }),
  );
  assert.equal(report.managers[0].nodeVersion, "v22.14.0");
  assert.equal(report.managers[0].reason, "node-runtime-mismatch");
  assert.equal(replayPackageInstallMatrixEvidence(report).releaseReady, false);
});

test("unavailable managers remain pending external and never become a non-strict success", () => {
  const report = createPackageInstallMatrixEvidence(
    rawReport({
      strict: false,
      managers: [
        passedManager("npm"),
        { manager: "pnpm", state: "unavailable", reason: "missing-AGENT_CONTEXT_PACK_PNPM" },
      ],
    }),
  );
  assert.equal(report.assessment, "pending-external");
  const replay = replayPackageInstallMatrixEvidence(report);
  assert.equal(replay.releaseReady, false);
  assert.equal(replay.success, false);
  assert.deepEqual(replay.unavailableManagers, ["pnpm"]);
});

test("strict gaps are blocked even when a manager passed", () => {
  const report = createPackageInstallMatrixEvidence(
    rawReport({
      managers: [
        passedManager("npm"),
        { manager: "pnpm", state: "unavailable", reason: "missing-AGENT_CONTEXT_PACK_PNPM" },
      ],
    }),
  );
  assert.equal(report.assessment, "blocked");
  assert.equal(replayPackageInstallMatrixEvidence(report).success, false);
});

test("unsupported Node evidence is retained only as blocked and cannot release", () => {
  const report = createPackageInstallMatrixEvidence(
    rawReport({
      nodeVersion: "v22.14.0",
      managers: [
        {
          manager: "npm",
          state: "blocked",
          nodeVersion: "v22.14.0",
          reason: "node-engine-mismatch",
        },
        {
          manager: "pnpm",
          state: "blocked",
          nodeVersion: "v22.14.0",
          reason: "node-engine-mismatch",
        },
      ],
    }),
  );
  assert.equal(report.assessment, "blocked");
  const replay = replayPackageInstallMatrixEvidence(report);
  assert.equal(replay.nodeReleaseSupported, false);
  assert.equal(replay.releaseReady, false);
});

test("expected tarball and Node identities are checked during replay", () => {
  const report = createPackageInstallMatrixEvidence(rawReport());
  assert.throws(
    () =>
      validatePackageInstallMatrixEvidence(report, {
        expectedTarballs: { cliSha256: "e".repeat(64), coreSha256: CORE_TARBALL },
      }),
    /CLI tarball digest/u,
  );
  assert.throws(
    () => validatePackageInstallMatrixEvidence(report, { nodeVersion: "v24.11.0" }),
    /Node version/u,
  );
});

test("tampering, unknown fields, duplicate managers, and inconsistent state fail closed", () => {
  const report = createPackageInstallMatrixEvidence(rawReport());
  assert.throws(
    () => validatePackageInstallMatrixEvidence({ ...report, reportSha256: "e".repeat(64) }),
    /reportSha256/u,
  );
  assert.throws(
    () => validatePackageInstallMatrixEvidence({ ...report, hostile: true }),
    /unknown field hostile/u,
  );
  assert.throws(
    () => createPackageInstallMatrixEvidence(rawReport({ selectedManagers: ["npm", "npm"] })),
    /duplicate managers/u,
  );
  assert.throws(
    () =>
      createPackageInstallMatrixEvidence(
        rawReport({ managers: [passedManager("pnpm"), passedManager("npm")] }),
      ),
    /match selectedManagers order/u,
  );
  assert.throws(
    () =>
      createPackageInstallMatrixEvidence(
        rawReport({
          managers: [
            { manager: "npm", state: "unavailable", reason: "install-failed" },
            passedManager("pnpm"),
          ],
        }),
      ),
    /unavailable state requires/u,
  );
  assert.throws(
    () =>
      createPackageInstallMatrixEvidence(
        rawReport({ tarballs: { cliSha256: CLI_TARBALL, coreSha256: CLI_TARBALL } }),
      ),
    /must be distinct/u,
  );
  assert.throws(
    () =>
      createPackageInstallMatrixEvidence(
        rawReport({
          managers: [
            passedManager("npm"),
            {
              manager: "pnpm",
              state: "failed",
              reason: "pnpm-version-mismatch",
              observedPnpmVersion: "token=must-not-be-retained",
            },
          ],
        }),
      ),
    /stable package-manager version/u,
  );
});

test("evidence bounds and policy remain closed", () => {
  const report = createPackageInstallMatrixEvidence(rawReport());
  assert.deepEqual(report.limits, PACKAGE_INSTALL_MATRIX_EVIDENCE_LIMITS);
  assert.deepEqual(report.policy, {
    networkAccess: "not-used",
    credentials: "none",
    repositoryMutation: "not-observed",
    sourcePaths: "not-retained",
  });
  assert.throws(
    () =>
      validatePackageInstallMatrixEvidence({
        ...report,
        policy: { ...report.policy, networkAccess: "used" },
      }),
    /policy\.networkAccess/u,
  );
  assert.throws(
    () =>
      validatePackageInstallMatrixEvidence({
        ...report,
        limits: { ...report.limits, MAX_INPUT_BYTES: 1 },
      }),
    /limits\.MAX_INPUT_BYTES/u,
  );
});

test("CLI persists canonical evidence exclusively and returns a nonzero gate for pending state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-package-evidence-test-"));
  try {
    const input = path.join(root, "raw.json");
    const output = path.join(root, "retained.json");
    await writeFile(input, canonicalJson(rawReport()), { encoding: "utf8", mode: 0o600 });
    const success = await main(["--input", input, "--output", output, "--format", "json"]);
    assert.equal(success, 0);
    const retained = JSON.parse(await readFile(output, "utf8"));
    assert.equal(retained.artifactFormat, "agent-context-package-install-matrix-v1");
    assert.equal(await main(["--input", input, "--output", output]), 2);

    const pendingInput = path.join(root, "pending.json");
    const pendingOutput = path.join(root, "pending-retained.json");
    await writeFile(
      pendingInput,
      canonicalJson(
        rawReport({
          strict: false,
          managers: [
            passedManager("npm"),
            { manager: "pnpm", state: "unavailable", reason: "missing-pnpm" },
          ],
        }),
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    assert.equal(
      await main(["--input", pendingInput, "--output", pendingOutput, "--format", "terminal"]),
      2,
    );
    assert.equal(JSON.parse(await readFile(pendingOutput, "utf8")).assessment, "pending-external");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI expected tarball identity mismatch fails without writing output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-package-evidence-hostile-"));
  try {
    const input = path.join(root, "raw.json");
    const output = path.join(root, "retained.json");
    await writeFile(input, canonicalJson(rawReport()), { encoding: "utf8", mode: 0o600 });
    assert.equal(
      await main(["--input", input, "--output", output, "--expected-cli-sha256", "e".repeat(64)]),
      2,
    );
    await assert.rejects(readFile(output, "utf8"), /ENOENT/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
