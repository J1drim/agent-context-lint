#!/usr/bin/env node

import path from "node:path";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  K03_MAINTAINER_AUTHORITY,
  canonicalJson,
  validateCalibrationAdjudication,
  validateCalibrationReport,
  validateCalibrationReview,
  validateK03MaintainerAuthority,
} from "./contracts.mjs";
import { validatePrivateReviewBundle } from "./capture.mjs";
import { validateNativeReleaseProof } from "./native-proof.mjs";
import { runBoundedCommand, verifyCaptureRuntime, verifyFrozenCheckout } from "./execute.mjs";
import { validatePrecisionEvidence } from "./precision.mjs";
import { readBoundedArtifactRecord, readBoundedPrivateArtifact } from "./run.mjs";
import { replayFinalSource, verifyEvidenceCommitLineage } from "./source-replay.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const MAXIMUM_COMMITTED_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PATHS = Object.freeze({
  adjudication: "calibration/metadata/v0/adjudication.json",
  candidates: "calibration/metadata/v0/candidate-snapshot.json",
  corpus: "calibration/metadata/v0/corpus.json",
  evidence: "calibration/metadata/v0/precision-evidence.json",
  maintainerAuthority: "calibration/metadata/v0/k03-maintainer-authority.json",
  maintainerReview: "calibration/metadata/v0/review-maintainer.json",
  nativeProof: "calibration/metadata/v0/k03-native-proof.json",
  preTuningAdjudication: "calibration/metadata/v0/pre-tuning-adjudication.json",
  preTuningMaintainerReview: "calibration/metadata/v0/pre-tuning-review-maintainer.json",
  preTuningReport: "calibration/metadata/v0/pre-tuning-report.json",
  report: "calibration/metadata/v0/report.json",
  seededCorpus: "calibration/seeded-recall/v0/corpus.json",
  seededReport: "calibration/seeded-recall/v0/report.json",
});

function environment() {
  const value = Object.create(null);
  for (const key of ["PATH", "SYSTEMROOT", "SystemRoot", "TMPDIR"])
    if (process.env[key] !== undefined) value[key] = process.env[key];
  value.GIT_CONFIG_GLOBAL = "/dev/null";
  value.GIT_CONFIG_NOSYSTEM = "1";
  value.GIT_CONFIG_SYSTEM = "/dev/null";
  value.GIT_OPTIONAL_LOCKS = "0";
  value.GIT_TERMINAL_PROMPT = "0";
  value.LC_ALL = "C";
  return value;
}

async function committedBytes(repositoryRoot, gitExecutable, commitSha, repositoryPath, command) {
  const result = await command(
    gitExecutable,
    [
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "-C",
      repositoryRoot,
      "show",
      `${commitSha}:${repositoryPath}`,
    ],
    {
      cwd: repositoryRoot,
      environment: environment(),
      maximumStderrBytes: 4096,
      maximumStdoutBytes: MAXIMUM_COMMITTED_FILE_BYTES,
      timeoutMs: 30_000,
    },
  );
  if (result.status !== 0 || result.signal !== null)
    throw new Error(`final source commit does not contain ${repositoryPath}`);
  return Buffer.from(result.stdout, "utf8");
}

async function verifyPrivateCapture(report, privatePath, verifyCheckout) {
  if (typeof privatePath !== "string" || !path.isAbsolute(privatePath))
    throw new Error("K03 gate requires an absolute private review bundle path");
  const bundle = await readBoundedPrivateArtifact(privatePath);
  const checked = validatePrivateReviewBundle(report, bundle);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
  for (const repository of bundle.repositories) await verifyCheckout(repository.checkout);
}

export async function validateK03PrecisionGateEvidence({
  cliEntry,
  command = runBoundedCommand,
  gitExecutable,
  hdiutilExecutable,
  nodeExecutable,
  packageRoot,
  paths = DEFAULT_PATHS,
  privateReviewPath,
  preTuningPrivateReviewPath,
  repositoryRoot = REPOSITORY_ROOT,
  verifyCheckout = verifyFrozenCheckout,
  verifyPrivate = verifyPrivateCapture,
  verifyLineage = verifyEvidenceCommitLineage,
  verifyNativeProof = validateNativeReleaseProof,
  verifyRuntime = verifyCaptureRuntime,
}) {
  const records = Object.fromEntries(
    await Promise.all(
      [
        "adjudication",
        "candidates",
        "corpus",
        "evidence",
        "maintainerAuthority",
        "maintainerReview",
        "nativeProof",
        "report",
        "seededCorpus",
        "seededReport",
      ].map(async (name) => [name, await readBoundedArtifactRecord(repositoryRoot, paths[name])]),
    ),
  );
  const evidence = records.evidence.value;
  const authorityCheck = validateK03MaintainerAuthority(records.maintainerAuthority.value);
  if (!authorityCheck.valid) throw new Error(authorityCheck.errors.join("\n"));
  if (canonicalJson(records.maintainerAuthority.value) !== canonicalJson(K03_MAINTAINER_AUTHORITY))
    throw new Error("K03 gate authority differs from the repository-owned declaration");
  await verifyNativeProof(records.nativeProof.value, { repositoryRoot, requireReady: true });
  await verifyPrivate(records.report.value, privateReviewPath, verifyCheckout);
  let preTuning = {
    adjudication: records.adjudication.value,
    maintainerReview: records.maintainerReview.value,
    report: records.report.value,
  };
  if (evidence.lineage.tuningApplied) {
    const [adjudication, maintainerReview, report] = await Promise.all([
      readBoundedArtifactRecord(repositoryRoot, paths.preTuningAdjudication),
      readBoundedArtifactRecord(repositoryRoot, paths.preTuningMaintainerReview),
      readBoundedArtifactRecord(repositoryRoot, paths.preTuningReport),
    ]);
    preTuning = {
      adjudication: adjudication.value,
      maintainerReview: maintainerReview.value,
      report: report.value,
    };
    await verifyPrivate(preTuning.report, preTuningPrivateReviewPath, verifyCheckout);
    const preReportCheck = validateCalibrationReport(preTuning.report, records.corpus.value);
    const preMaintainerCheck = validateCalibrationReview(
      preTuning.maintainerReview,
      preTuning.report,
    );
    const preAdjudicationCheck = validateCalibrationAdjudication(
      preTuning.adjudication,
      preTuning.report,
      preTuning.maintainerReview,
    );
    for (const check of [preReportCheck, preMaintainerCheck, preAdjudicationCheck])
      if (!check.valid) throw new Error(check.errors.join("\n"));
  }
  const reportCheck = validateCalibrationReport(records.report.value, records.corpus.value);
  const maintainerCheck = validateCalibrationReview(
    records.maintainerReview.value,
    records.report.value,
  );
  const adjudicationCheck = validateCalibrationAdjudication(
    records.adjudication.value,
    records.report.value,
    records.maintainerReview.value,
  );
  for (const check of [reportCheck, maintainerCheck, adjudicationCheck])
    if (!check.valid) throw new Error(check.errors.join("\n"));
  const precisionCheck = validatePrecisionEvidence(evidence, {
    adjudication: records.adjudication.value,
    candidateBytes: records.candidates.bytes,
    corpus: records.corpus.value,
    corpusBytes: records.corpus.bytes,
    engine: records.report.value.engine,
    generatedAt: evidence.generatedAt,
    maintainerAuthority: records.maintainerAuthority.value,
    maintainerReview: records.maintainerReview.value,
    report: records.report.value,
    preTuningAdjudication: preTuning.adjudication,
    preTuningEngine: preTuning.report.engine,
    preTuningMaintainerReview: preTuning.maintainerReview,
    preTuningReport: preTuning.report,
    seededRecallCorpus: records.seededCorpus.value,
    seededRecallCorpusBytes: records.seededCorpus.bytes,
    seededRecallReport: records.seededReport.value,
    seededRecallReportBytes: records.seededReport.bytes,
    tuningChanges: evidence.tuningChanges,
  });
  if (!precisionCheck.valid) throw new Error(precisionCheck.errors.join("\n"));
  if (evidence.lineage.engineSourceCommitSha !== evidence.engine.commitSha)
    throw new Error("precision lineage does not bind the immutable captured engine commit");

  const lineageRoot = await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-lineage-"));
  await chmod(lineageRoot, 0o700);
  let lineage;
  try {
    lineage = await verifyLineage({
      command,
      engineCommitSha: evidence.lineage.engineSourceCommitSha,
      gitExecutable,
      repositoryRoot,
      temporaryRoot: lineageRoot,
    });
  } finally {
    await rm(lineageRoot, { force: true, recursive: true });
  }

  const runtime = await verifyRuntime(
    { engine: evidence.engine },
    { cliEntry, command, gitExecutable, hdiutilExecutable, nodeExecutable, packageRoot },
  );
  return Object.freeze({
    evidence,
    lineage,
    nativeProof: records.nativeProof.value,
    paths,
    records,
    repositoryRoot,
    runtime,
  });
}

export async function verifyK03CommittedLineage({
  command,
  evidence,
  paths,
  records,
  repositoryRoot,
  runtime,
}) {
  const seededCorpusAtCommit = await committedBytes(
    repositoryRoot,
    runtime.paths.gitExecutable,
    evidence.lineage.engineSourceCommitSha,
    paths.seededCorpus,
    command,
  );
  if (!seededCorpusAtCommit.equals(records.seededCorpus.bytes))
    throw new Error("final engine commit does not contain the exact F16 corpus bytes");
  const seededAtCommit = await committedBytes(
    repositoryRoot,
    runtime.paths.gitExecutable,
    evidence.lineage.engineSourceCommitSha,
    paths.seededReport,
    command,
  );
  if (!seededAtCommit.equals(records.seededReport.bytes))
    throw new Error("final engine commit does not contain the exact F16 report bytes");
  for (const change of evidence.tuningChanges) {
    for (const regression of change.regressionTests) {
      const bytes = await committedBytes(
        repositoryRoot,
        runtime.paths.gitExecutable,
        change.codeCommitSha,
        regression.path,
        command,
      );
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== regression.sha256)
        throw new Error(`tuning regression ${regression.path} differs from its committed digest`);
    }
  }
}

export async function checkK03PrecisionGate(options) {
  const context = await validateK03PrecisionGateEvidence(options);
  const { evidence, lineage, nativeProof, records, repositoryRoot, runtime } = context;
  await replayFinalSource({
    engine: evidence.engine,
    evidenceCommitSha: lineage.evidenceCommitSha,
    gitExecutable: runtime.paths.gitExecutable,
    nativeProof,
    nodeExecutable: options.nodeExecutable,
    regressionTests: evidence.tuningChanges.flatMap((change) => change.regressionTests),
    repositoryRoot,
    seededCorpusBytes: records.seededCorpus.bytes,
    seededReportBytes: records.seededReport.bytes,
  });
  await verifyK03CommittedLineage({ command: options.command ?? runBoundedCommand, ...context });
  return Object.freeze({
    diagnosticCount: evidence.diagnosticCount,
    precisionGatePassed: evidence.precisionGatePassed,
    tuningChangeCount: evidence.tuningChanges.length,
  });
}

function usage() {
  return "Usage: AGENT_CONTEXT_LINT_K03_GIT=<absolute-git> AGENT_CONTEXT_LINT_K03_HDIUTIL=/usr/bin/hdiutil AGENT_CONTEXT_LINT_K03_NODE=<absolute-node> AGENT_CONTEXT_LINT_K03_PACKAGE_ROOT=<absolute-extracted-package-root> AGENT_CONTEXT_LINT_K03_CLI_ENTRY=<absolute-packed-cli-entry> AGENT_CONTEXT_LINT_K03_PRIVATE_REVIEW=<absolute-private-review> [AGENT_CONTEXT_LINT_K03_PRE_PRIVATE_REVIEW=<absolute-pre-tuning-private-review>] node tools/metadata-calibration/gate.mjs";
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const arguments_ = process.argv.slice(2);
  const gitExecutable = process.env.AGENT_CONTEXT_LINT_K03_GIT;
  const nodeExecutable = process.env.AGENT_CONTEXT_LINT_K03_NODE;
  const hdiutilExecutable = process.env.AGENT_CONTEXT_LINT_K03_HDIUTIL;
  const packageRoot = process.env.AGENT_CONTEXT_LINT_K03_PACKAGE_ROOT;
  const cliEntry = process.env.AGENT_CONTEXT_LINT_K03_CLI_ENTRY;
  const privateReviewPath = process.env.AGENT_CONTEXT_LINT_K03_PRIVATE_REVIEW;
  const preTuningPrivateReviewPath = process.env.AGENT_CONTEXT_LINT_K03_PRE_PRIVATE_REVIEW;
  if (
    arguments_.length !== 0 ||
    gitExecutable === undefined ||
    hdiutilExecutable === undefined ||
    nodeExecutable === undefined ||
    packageRoot === undefined ||
    cliEntry === undefined ||
    privateReviewPath === undefined
  ) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
  } else {
    try {
      const result = await checkK03PrecisionGate({
        cliEntry,
        gitExecutable,
        hdiutilExecutable,
        nodeExecutable,
        packageRoot,
        privateReviewPath,
        preTuningPrivateReviewPath,
      });
      process.stdout.write(
        `K03 precision evidence is valid (${String(result.diagnosticCount)} diagnostics, ${String(result.tuningChangeCount)} tuning changes).\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : "K03 precision gate failed"}\n`,
      );
      process.exitCode = 1;
    }
  }
}
