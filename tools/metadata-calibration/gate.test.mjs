import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  K03_MAINTAINER_AUTHORITY,
  adjudicateCalibrationReview,
  computeCalibrationDiagnosticFingerprint,
  createCalibrationReview,
  createCalibrationWorksheet,
  prettyJson,
  sha256Canonical,
} from "./contracts.mjs";
import { inspectExecutableIdentity, runBoundedCommand } from "./execute.mjs";
import { validateK03PrecisionGateEvidence, verifyK03CommittedLineage } from "./gate.mjs";
import { createPrecisionEvidence } from "./precision.mjs";

async function git(arguments_, cwd) {
  const result = await runBoundedCommand("/usr/bin/git", arguments_, {
    cwd,
    environment: process.env,
    timeoutMs: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function checkEvidence(options) {
  const context = await validateK03PrecisionGateEvidence(options);
  await verifyK03CommittedLineage({ command: options.command ?? runBoundedCommand, ...context });
  return {
    diagnosticCount: context.evidence.diagnosticCount,
    precisionGatePassed: context.evidence.precisionGatePassed,
    tuningChangeCount: context.evidence.tuningChanges.length,
  };
}

test("canonical offline K03 gate reconstructs evidence and committed F16 bytes", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "precision-gate-"));
  await git(["init", "--quiet"], repositoryRoot);
  const seededReportPath = "calibration/seeded-recall/v0/report.json";
  const seededCorpusPath = "calibration/seeded-recall/v0/corpus.json";
  const regressionPath = "calibration/regressions/k03-rule-threshold.test.mjs";
  const regressionBytes = Buffer.from("export const k03Regression = true;\n", "utf8");
  await mkdir(path.join(repositoryRoot, "calibration/seeded-recall/v0"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "calibration/regressions"), { recursive: true });
  const seededReportBytes = await readFile(seededReportPath);
  const seededCorpusBytes = await readFile(seededCorpusPath);
  await writeFile(path.join(repositoryRoot, seededReportPath), seededReportBytes);
  await writeFile(path.join(repositoryRoot, seededCorpusPath), seededCorpusBytes);
  await writeFile(path.join(repositoryRoot, regressionPath), regressionBytes);
  await git(["add", seededReportPath, seededCorpusPath, regressionPath], repositoryRoot);
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Create synthetic precision gate source",
    ],
    repositoryRoot,
  );
  const commitSha = await git(["rev-parse", "HEAD"], repositoryRoot);
  const gitIdentity = await inspectExecutableIdentity("/usr/bin/git", "Git executable", [
    "--version",
  ]);
  const candidateBytes = await readFile("calibration/metadata/v0/candidate-snapshot.json");
  const corpusBytes = await readFile("calibration/metadata/v0/corpus.json");
  const corpus = JSON.parse(corpusBytes.toString("utf8"));
  const diagnostics = Array.from({ length: 500 }, (_, index) => {
    const identity = {
      pathFingerprint: (index + 1).toString(16).padStart(64, "0"),
      repositoryId: corpus.repositories[index % corpus.repositories.length].repositoryId,
      ruleId: index % 2 === 0 ? "ACL250" : "ACL301",
      semanticFingerprint: (index + 501).toString(16).padStart(64, "0"),
      severity: index % 2 === 0 ? "error" : "warning",
    };
    return {
      diagnosticFingerprint: computeCalibrationDiagnosticFingerprint(identity),
      effectiveSeverity: identity.severity,
      ...identity,
    };
  }).sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.repositoryId}\0${left.ruleId}\0${left.diagnosticFingerprint}`),
      Buffer.from(`${right.repositoryId}\0${right.ruleId}\0${right.diagnosticFingerprint}`),
    ),
  );
  const engine = {
    captureStartedAt: "2026-08-09T00:00:00.000Z",
    commitSha,
    git: { sha256: gitIdentity.sha256, version: gitIdentity.version },
    gitRemoteHttps: { sha256: "a".repeat(64), version: "fixture-helper" },
    hdiutil: { sha256: "9".repeat(64), version: "hdiutil: 1.0.0" },
    guardSha256: "3".repeat(64),
    knowledgeVersion: "2026.08.0",
    node: { sha256: "4".repeat(64), version: "v26.3.0" },
    sandboxExec: { sha256: "b".repeat(64), version: "fixture-sandbox" },
    packageSha256: "5".repeat(64),
    ruleRegistrySha256: "6".repeat(64),
    runtimeClosureSha256: "7".repeat(64),
    version: "1.0.0-rc.1",
  };
  const report = {
    contractVersion: "0.1.0",
    corpusSha256: sha256Canonical(corpus),
    diagnostics,
    engine,
    engineVersion: engine.version,
    generatedAt: "2026-08-09T01:00:00.000Z",
    knowledgeVersion: engine.knowledgeVersion,
    privatePayloadSha256: "8".repeat(64),
    recordKind: "agent-context-metadata-calibration-report",
    sourcePolicy: { fingerprintOnly: true, repositoryContent: false, repositoryPaths: false },
  };
  const worksheet = createCalibrationWorksheet(report);
  worksheet.labels = worksheet.labels.map((entry) => ({
    ...entry,
    label: "true-positive",
    reason: "documented-behavior-confirmed",
  }));
  const maintainerReview = createCalibrationReview(
    report,
    worksheet,
    "jakub-niezgoda",
    "2026-08-09T02:00:00.000Z",
  );
  const adjudication = adjudicateCalibrationReview(
    report,
    maintainerReview,
    "2026-08-09T03:00:00.000Z",
  );
  const seededCorpus = JSON.parse(seededCorpusBytes.toString("utf8"));
  const seededReport = JSON.parse(seededReportBytes.toString("utf8"));
  const evidence = createPrecisionEvidence({
    adjudication,
    candidateBytes,
    corpus,
    corpusBytes,
    engine,
    generatedAt: "2026-08-09T05:00:00.000Z",
    maintainerReview,
    report,
    seededRecallCorpus: seededCorpus,
    seededRecallCorpusBytes: seededCorpusBytes,
    seededRecallReport: seededReport,
    seededRecallReportBytes: seededReportBytes,
  });
  const metadataRoot = path.join(repositoryRoot, "calibration/metadata/v0");
  await mkdir(metadataRoot, { recursive: true });
  const artifacts = {
    "adjudication.json": adjudication,
    "candidate-snapshot.json": JSON.parse(candidateBytes.toString("utf8")),
    "corpus.json": corpus,
    "k03-maintainer-authority.json": K03_MAINTAINER_AUTHORITY,
    "k03-native-proof.json": { status: "ready" },
    "precision-evidence.json": evidence,
    "report.json": report,
    "review-maintainer.json": maintainerReview,
  };
  for (const [name, value] of Object.entries(artifacts))
    await writeFile(
      path.join(metadataRoot, name),
      name === "candidate-snapshot.json"
        ? candidateBytes
        : name === "corpus.json"
          ? corpusBytes
          : prettyJson(value),
    );
  let runtimeVerificationCount = 0;
  let privateVerificationCount = 0;
  const gateOptions = {
    cliEntry: "/fixture/package/cli.js",
    gitExecutable: "/usr/bin/git",
    hdiutilExecutable: "/usr/bin/hdiutil",
    nodeExecutable: "/fixture/node",
    packageRoot: "/fixture/package",
    repositoryRoot,
    verifyLineage: async ({ engineCommitSha }) => ({
      changedPaths: [],
      engineCommitSha,
      evidenceCommitSha: commitSha,
    }),
    verifyNativeProof: async () => {},
    verifyPrivate: async (boundReport) => {
      assert.match(boundReport.recordKind, /metadata-calibration-report/);
      privateVerificationCount += 1;
    },
    verifyRuntime: async (expected, options) => {
      assert.equal(expected.engine.packageSha256, report.engine.packageSha256);
      runtimeVerificationCount += 1;
      return { paths: { gitExecutable: options.gitExecutable } };
    },
  };
  assert.deepEqual(await checkEvidence(gateOptions), {
    diagnosticCount: 500,
    precisionGatePassed: true,
    tuningChangeCount: 0,
  });
  assert.equal(runtimeVerificationCount, 1);
  assert.equal(privateVerificationCount, 1);
  await assert.rejects(
    checkEvidence({
      ...gateOptions,
      verifyRuntime: async () => {
        throw new Error("packed runtime bytes changed");
      },
    }),
    /runtime bytes changed/,
  );

  const preTuningEngine = {
    ...engine,
    captureStartedAt: "2026-08-08T22:00:00.000Z",
    commitSha: "a".repeat(40),
    packageSha256: "b".repeat(64),
    runtimeClosureSha256: "c".repeat(64),
  };
  const preTuningReport = {
    ...report,
    engine: preTuningEngine,
    engineVersion: preTuningEngine.version,
    generatedAt: "2026-08-08T23:00:00.000Z",
  };
  const preWorksheet = createCalibrationWorksheet(preTuningReport);
  preWorksheet.labels = preWorksheet.labels.map((entry, index) => ({
    ...entry,
    label: index === 0 ? "false-positive" : "true-positive",
    reason: index === 0 ? "rule-threshold" : "documented-behavior-confirmed",
  }));
  const preMaintainerReview = createCalibrationReview(
    preTuningReport,
    preWorksheet,
    "jakub-niezgoda",
    "2026-08-08T23:10:00.000Z",
  );
  const preAdjudication = adjudicateCalibrationReview(
    preTuningReport,
    preMaintainerReview,
    "2026-08-08T23:20:00.000Z",
  );
  const falsePositive = preAdjudication.decisions.find(
    (decision) => decision.label === "false-positive",
  );
  const tuningChanges = [
    {
      action: "rule-threshold-tightened",
      codeCommitSha: commitSha,
      evidenceFingerprints: [falsePositive.diagnosticFingerprint],
      packageSha256: engine.packageSha256,
      preTuningAdjudicationSha256: sha256Canonical(preAdjudication),
      preTuningReportSha256: sha256Canonical(preTuningReport),
      regressionTests: [
        {
          path: regressionPath,
          sha256: createHash("sha256").update(regressionBytes).digest("hex"),
        },
      ],
      ruleId: falsePositive.ruleId,
    },
  ];
  const tunedEvidence = createPrecisionEvidence({
    adjudication,
    candidateBytes,
    corpus,
    corpusBytes,
    engine,
    generatedAt: "2026-08-09T05:00:00.000Z",
    maintainerReview,
    preTuningAdjudication: preAdjudication,
    preTuningEngine,
    preTuningMaintainerReview: preMaintainerReview,
    preTuningReport,
    report,
    seededRecallCorpus: seededCorpus,
    seededRecallCorpusBytes: seededCorpusBytes,
    seededRecallReport: seededReport,
    seededRecallReportBytes: seededReportBytes,
    tuningChanges,
  });
  for (const [name, value] of Object.entries({
    "pre-tuning-adjudication.json": preAdjudication,
    "pre-tuning-report.json": preTuningReport,
    "pre-tuning-review-maintainer.json": preMaintainerReview,
    "precision-evidence.json": tunedEvidence,
  }))
    await writeFile(path.join(metadataRoot, name), prettyJson(value));
  assert.deepEqual(await checkEvidence(gateOptions), {
    diagnosticCount: 500,
    precisionGatePassed: true,
    tuningChangeCount: 1,
  });
  assert.equal(runtimeVerificationCount, 2);
  assert.equal(privateVerificationCount, 4);
  const wrongRegressionChanges = [
    {
      ...tuningChanges[0],
      regressionTests: [{ path: regressionPath, sha256: "f".repeat(64) }],
    },
  ];
  const wrongRegressionEvidence = createPrecisionEvidence({
    adjudication,
    candidateBytes,
    corpus,
    corpusBytes,
    engine,
    generatedAt: "2026-08-09T05:00:00.000Z",
    maintainerReview,
    preTuningAdjudication: preAdjudication,
    preTuningEngine,
    preTuningMaintainerReview: preMaintainerReview,
    preTuningReport,
    report,
    seededRecallCorpus: seededCorpus,
    seededRecallCorpusBytes: seededCorpusBytes,
    seededRecallReport: seededReport,
    seededRecallReportBytes: seededReportBytes,
    tuningChanges: wrongRegressionChanges,
  });
  await writeFile(
    path.join(metadataRoot, "precision-evidence.json"),
    prettyJson(wrongRegressionEvidence),
  );
  await assert.rejects(checkEvidence(gateOptions), /regression.*committed digest/i);
  await writeFile(path.join(metadataRoot, "precision-evidence.json"), prettyJson(tunedEvidence));
  await writeFile(
    path.join(metadataRoot, "pre-tuning-review-maintainer.json"),
    prettyJson({ ...preMaintainerReview, reviewedAt: "2026-08-08T23:15:00.000Z" }),
  );
  await assert.rejects(checkEvidence(gateOptions), /maintainer review|reconstruct/i);
  await writeFile(
    path.join(metadataRoot, "pre-tuning-review-maintainer.json"),
    prettyJson(preMaintainerReview),
  );

  const staleSeeded = JSON.parse(seededReportBytes.toString("utf8"));
  staleSeeded.runSha256 = "f".repeat(64);
  await writeFile(path.join(repositoryRoot, seededReportPath), prettyJson(staleSeeded));
  await assert.rejects(checkEvidence(gateOptions), /immutable F16|scheduler|seeded/i);
});
