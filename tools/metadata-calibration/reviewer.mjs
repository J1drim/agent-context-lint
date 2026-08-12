#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  K03_MAINTAINER_REVIEWER_ID,
  adjudicateCalibrationReview,
  canonicalJson,
  createCalibrationReview,
  createCalibrationWorksheet,
  prettyJson,
  validateCalibrationAdjudication,
  validateCalibrationReport,
  validateCalibrationReview,
} from "./contracts.mjs";
import { createPrecisionEvidence } from "./precision.mjs";
import { validatePrivateReviewBundle } from "./capture.mjs";
import { inspectHdiutilIdentity, verifyCaptureRuntime, verifyFrozenCheckout } from "./execute.mjs";
import {
  readBoundedArtifact,
  readBoundedArtifactRecord,
  readBoundedPrivateArtifact,
} from "./run.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");

function usage() {
  return [
    "Usage:",
    "  node tools/metadata-calibration/reviewer.mjs validate <corpus.json> <report.json> [review.json]",
    "  node tools/metadata-calibration/reviewer.mjs worksheet <corpus.json> <report.json> <absolute-private-review.json>",
    "  node tools/metadata-calibration/reviewer.mjs review <corpus.json> <report.json> <absolute-private-review.json> <worksheet.json>",
    "  node tools/metadata-calibration/reviewer.mjs adjudicate <corpus.json> <report.json> <absolute-private-review.json> <review.json>",
    "  node tools/metadata-calibration/reviewer.mjs validate-adjudication <corpus.json> <report.json> <absolute-private-review.json> <adjudication.json> <review.json>",
    "  node tools/metadata-calibration/reviewer.mjs precision <candidate.json> <corpus.json> <report.json> <absolute-private-review.json> <review.json> <adjudication.json> <seeded-corpus.json> <seeded-report.json> <tuning.json> <generated-at> <package-root> <cli-entry> <node> <git> [--pre-tuning <report.json> <review.json> <adjudication.json> --pre-private <absolute-private-review.json>]",
  ].join("\n");
}

function parsePrecisionLineageArguments(arguments_) {
  const parsed = { prePrivate: null, preTuning: null };
  for (let index = 0; index < arguments_.length;) {
    const option = arguments_[index];
    if (option === "--pre-private") {
      if (parsed.prePrivate !== null || arguments_[index + 1] === undefined)
        throw new Error(usage());
      parsed.prePrivate = arguments_[index + 1];
      index += 2;
    } else if (option === "--pre-tuning") {
      if (parsed.preTuning !== null || arguments_.slice(index + 1, index + 4).length !== 3)
        throw new Error(usage());
      parsed.preTuning = {
        adjudication: arguments_[index + 3],
        maintainerReview: arguments_[index + 2],
        report: arguments_[index + 1],
      };
      index += 4;
    } else {
      throw new Error(usage());
    }
  }
  return parsed;
}

async function boundReport(repositoryRoot, corpusPath, reportPath) {
  const corpus = await readBoundedArtifact(repositoryRoot, corpusPath);
  const report = await readBoundedArtifact(repositoryRoot, reportPath);
  const checked = validateCalibrationReport(report, corpus);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
  return { corpus, report };
}

async function boundPrivateReport(repositoryRoot, corpusPath, reportPath, privatePath) {
  const bound = await boundReport(repositoryRoot, corpusPath, reportPath);
  const privateBundle = await readBoundedPrivateArtifact(privatePath);
  const checked = validatePrivateReviewBundle(bound.report, privateBundle);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
  return { ...bound, privateBundle };
}

async function boundVerifiedPrivateReport(
  repositoryRoot,
  corpusPath,
  reportPath,
  privatePath,
  verifyCheckout,
) {
  const bound = await boundPrivateReport(repositoryRoot, corpusPath, reportPath, privatePath);
  for (const repository of bound.privateBundle.repositories)
    await verifyCheckout(repository.checkout);
  return bound;
}

export async function runReviewer(
  arguments_,
  {
    repositoryRoot = REPOSITORY_ROOT,
    inspectHdiutil = () => inspectHdiutilIdentity("/usr/bin/hdiutil"),
    now = () => new Date().toISOString(),
    verifyCheckout = verifyFrozenCheckout,
    verifyRuntime = verifyCaptureRuntime,
  } = {},
) {
  const [command, ...rest] = arguments_;
  if (command === "validate") {
    if (rest.length < 2 || rest.length > 3) throw new Error(usage());
    const { report } = await boundReport(repositoryRoot, rest[0], rest[1]);
    if (rest[2] !== undefined) {
      const review = await readBoundedArtifact(repositoryRoot, rest[2]);
      const checked = validateCalibrationReview(review, report);
      if (!checked.valid) throw new Error(checked.errors.join("\n"));
    }
    return "Metadata calibration artifacts are valid.\n";
  }
  if (command === "worksheet") {
    if (rest.length !== 3) throw new Error(usage());
    const { report } = await boundVerifiedPrivateReport(
      repositoryRoot,
      rest[0],
      rest[1],
      rest[2],
      verifyCheckout,
    );
    return prettyJson(createCalibrationWorksheet(report));
  }
  if (command === "review") {
    if (rest.length !== 4) throw new Error(usage());
    const { report } = await boundVerifiedPrivateReport(
      repositoryRoot,
      rest[0],
      rest[1],
      rest[2],
      verifyCheckout,
    );
    const worksheet = await readBoundedArtifact(repositoryRoot, rest[3]);
    return prettyJson(
      createCalibrationReview(report, worksheet, K03_MAINTAINER_REVIEWER_ID, now()),
    );
  }
  if (command === "adjudicate") {
    if (rest.length !== 4) throw new Error(usage());
    const { report } = await boundVerifiedPrivateReport(
      repositoryRoot,
      rest[0],
      rest[1],
      rest[2],
      verifyCheckout,
    );
    const maintainerReview = await readBoundedArtifact(repositoryRoot, rest[3]);
    return prettyJson(adjudicateCalibrationReview(report, maintainerReview, now()));
  }
  if (command === "validate-adjudication") {
    if (rest.length !== 5) throw new Error(usage());
    const { report } = await boundVerifiedPrivateReport(
      repositoryRoot,
      rest[0],
      rest[1],
      rest[2],
      verifyCheckout,
    );
    const adjudication = await readBoundedArtifact(repositoryRoot, rest[3]);
    const maintainerReview = await readBoundedArtifact(repositoryRoot, rest[4]);
    const checked = validateCalibrationAdjudication(adjudication, report, maintainerReview);
    if (!checked.valid) throw new Error(checked.errors.join("\n"));
    return "Metadata calibration adjudication is valid.\n";
  }
  if (command === "precision") {
    if (rest.length < 14) throw new Error(usage());
    const lineageArguments = parsePrecisionLineageArguments(rest.slice(14));
    const candidate = await readBoundedArtifactRecord(repositoryRoot, rest[0]);
    const corpus = await readBoundedArtifactRecord(repositoryRoot, rest[1]);
    const report = await readBoundedArtifact(repositoryRoot, rest[2]);
    const privateBundle = await readBoundedPrivateArtifact(rest[3]);
    const privateCheck = validatePrivateReviewBundle(report, privateBundle);
    if (!privateCheck.valid) throw new Error(privateCheck.errors.join("\n"));
    for (const repository of privateBundle.repositories) await verifyCheckout(repository.checkout);
    const hdiutil = await inspectHdiutil();
    if (
      hdiutil.path !== "/usr/bin/hdiutil" ||
      canonicalJson({ sha256: hdiutil.sha256, version: hdiutil.version }) !==
        canonicalJson(report.engine.hdiutil)
    )
      throw new Error("precision release hdiutil identity differs from the capture engine");
    await verifyRuntime(
      { engine: report.engine },
      {
        cliEntry: rest[11],
        gitExecutable: rest[13],
        hdiutilExecutable: "/usr/bin/hdiutil",
        nodeExecutable: rest[12],
        packageRoot: rest[10],
      },
    );
    const maintainerReview = await readBoundedArtifact(repositoryRoot, rest[4]);
    const adjudication = await readBoundedArtifact(repositoryRoot, rest[5]);
    const seededCorpus = await readBoundedArtifactRecord(repositoryRoot, rest[6]);
    const seededReport = await readBoundedArtifactRecord(repositoryRoot, rest[7]);
    const tuningChanges = await readBoundedArtifact(repositoryRoot, rest[8]);
    if (!Array.isArray(tuningChanges)) throw new Error("tuning artifact must be a JSON array");
    let preTuningReport = report;
    let preTuningMaintainerReview = maintainerReview;
    let preTuningAdjudication = adjudication;
    if (tuningChanges.length > 0) {
      if (lineageArguments.preTuning === null)
        throw new Error("tuned precision requires exact pre-tuning review artifacts");
      preTuningReport = await readBoundedArtifact(
        repositoryRoot,
        lineageArguments.preTuning.report,
      );
      preTuningMaintainerReview = await readBoundedArtifact(
        repositoryRoot,
        lineageArguments.preTuning.maintainerReview,
      );
      preTuningAdjudication = await readBoundedArtifact(
        repositoryRoot,
        lineageArguments.preTuning.adjudication,
      );
      if (lineageArguments.prePrivate === null)
        throw new Error("tuned precision requires the exact pre-tuning private review bundle");
      const prePrivateBundle = await readBoundedPrivateArtifact(lineageArguments.prePrivate);
      const prePrivateCheck = validatePrivateReviewBundle(preTuningReport, prePrivateBundle);
      if (!prePrivateCheck.valid) throw new Error(prePrivateCheck.errors.join("\n"));
      for (const repository of prePrivateBundle.repositories)
        await verifyCheckout(repository.checkout);
    } else if (lineageArguments.preTuning !== null || lineageArguments.prePrivate !== null) {
      throw new Error("pre-tuning review arguments require a non-empty tuning artifact");
    }
    return prettyJson(
      createPrecisionEvidence({
        adjudication,
        candidateBytes: candidate.bytes,
        corpus: corpus.value,
        corpusBytes: corpus.bytes,
        engine: report.engine,
        generatedAt: rest[9],
        maintainerReview,
        report,
        preTuningAdjudication,
        preTuningEngine: preTuningReport.engine,
        preTuningMaintainerReview,
        preTuningReport,
        seededRecallCorpus: seededCorpus.value,
        seededRecallCorpusBytes: seededCorpus.bytes,
        seededRecallReport: seededReport.value,
        seededRecallReportBytes: seededReport.bytes,
        tuningChanges,
      }),
    );
  }
  throw new Error(usage());
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(await runReviewer(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "metadata calibration reviewer failed"}\n`,
    );
    process.exitCode = 1;
  }
}
