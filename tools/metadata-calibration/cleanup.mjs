#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePrivateReviewBundle } from "./capture.mjs";
import { validateCalibrationReport } from "./contracts.mjs";
import {
  cleanupCapturedCalibration,
  inspectHdiutilIdentity,
  runBoundedCommand,
} from "./execute.mjs";
import { cleanupQuotaVolume, verifyQuotaVolume } from "./quota-volume.mjs";
import { readBoundedArtifact, readBoundedPrivateArtifact } from "./run.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const ACKNOWLEDGEMENT = "--acknowledge-successful-final-k03-gate";

function usage() {
  return `Usage: node tools/metadata-calibration/cleanup.mjs <corpus.json> <report.json> <absolute-private-review.json> <absolute-work-root> ${ACKNOWLEDGEMENT}`;
}

function environment() {
  const value = Object.create(null);
  for (const key of ["PATH", "SYSTEMROOT", "SystemRoot", "TMPDIR"])
    if (process.env[key] !== undefined) value[key] = process.env[key];
  value.HOME = os.tmpdir();
  value.LANG = "C";
  value.LC_ALL = "C";
  return value;
}

export async function runCleanup(
  arguments_,
  {
    cleanupCapture = cleanupCapturedCalibration,
    command = runBoundedCommand,
    inspectHdiutil = () => inspectHdiutilIdentity("/usr/bin/hdiutil", command),
    readCorpus = (artifactPath) => readBoundedArtifact(repositoryRoot, artifactPath),
    readPrivate = readBoundedPrivateArtifact,
    readReport = (artifactPath) => readBoundedArtifact(repositoryRoot, artifactPath),
    repositoryRoot = REPOSITORY_ROOT,
    validateBundle = validatePrivateReviewBundle,
    validateReport = validateCalibrationReport,
  } = {},
) {
  if (arguments_.length !== 5 || arguments_[4] !== ACKNOWLEDGEMENT) throw new Error(usage());
  const [corpusPath, reportPath, privatePath, workRoot] = arguments_;
  const corpus = await readCorpus(corpusPath);
  const report = await readReport(reportPath);
  const bundle = await readPrivate(privatePath);
  const reportCheck = validateReport(report, corpus);
  if (!reportCheck.valid) throw new Error(reportCheck.errors.join("\n"));
  const checked = validateBundle(report, bundle);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
  const hdiutil = await inspectHdiutil();
  const provider = Object.freeze({
    cleanup: (state) => cleanupQuotaVolume({ command, environment: environment(), hdiutil }, state),
    verify: verifyQuotaVolume,
  });
  const receipt = await cleanupCapture(provider, bundle, workRoot);
  return `Cleaned ${String(receipt.cleanedRepositories)} frozen K03 quota volumes after the acknowledged successful final gate.\n`;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(await runCleanup(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "K03 cleanup failed"}\n`);
    process.exitCode = 1;
  }
}
