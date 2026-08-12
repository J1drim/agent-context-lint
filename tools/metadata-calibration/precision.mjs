import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_VERSION,
  K03_MAINTAINER_AUTHORITY,
  canonicalJson,
  sha256Canonical,
  validateCalibrationAdjudication,
  validateCalibrationCorpus,
  validateCalibrationReport,
  validateCandidateSnapshot,
} from "./contracts.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;

export const PRECISION_EVIDENCE_KIND = "agent-context-metadata-calibration-precision-evidence";
export const MINIMUM_REVIEWED_DIAGNOSTICS = 500;
export const MAXIMUM_UNCERTAIN_DIAGNOSTICS = 25;
export const MAXIMUM_UNCERTAIN_BASIS_POINTS = 500;
export const SUPPORTED_RULE_IDS = Object.freeze([
  ...Array.from({ length: 10 }, (_, index) => `ACL${String(100 + index)}`),
  ...Array.from({ length: 7 }, (_, index) => `ACL${String(150 + index)}`),
  ...Array.from({ length: 7 }, (_, index) => `ACL${String(200 + index)}`),
  ...Array.from({ length: 6 }, (_, index) => `ACL${String(250 + index)}`),
  ...Array.from({ length: 6 }, (_, index) => `ACL${String(300 + index)}`),
  ...Array.from({ length: 6 }, (_, index) => `ACL${String(350 + index)}`),
  ...Array.from({ length: 7 }, (_, index) => `ACL${String(400 + index)}`),
  ...Array.from({ length: 4 }, (_, index) => `ACL${String(450 + index)}`),
  ...Array.from({ length: 7 }, (_, index) => `ACL${String(500 + index)}`),
  ...Array.from({ length: 9 }, (_, index) => `ACL${String(550 + index)}`),
]);
export const FROZEN_CANDIDATE_BYTES_SHA256 =
  "dfebdbb895f855e6705430d94553d77e0643cb8891b1cbab461219ddb827585b";
export const FROZEN_CORPUS_BYTES_SHA256 =
  "3b5a95e1b659facad62003f9be0402f79a412cf6f31a1f7065e85dbdc9ab06b1";
export const FROZEN_SEEDED_RECALL_CORPUS_BYTES_SHA256 =
  "d764ef6eb792d2480fea0202c9364a350511abf588b51b4ade5a0e59ead3896e";
export const FROZEN_SEEDED_RECALL_REPORT_BYTES_SHA256 =
  "370fc6bbe68ad1b8f86bf7d520b4dd155f9fafd3ae55c43dddaae18ef48cd7e2";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIRECTORY = path.resolve(MODULE_DIRECTORY, "../../calibration/schemas");

function validator(name) {
  const schema = JSON.parse(readFileSync(path.join(SCHEMA_DIRECTORY, name), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const validatePrecisionEvidenceSchema = validator(
  "metadata-calibration-precision-evidence.v0.schema.json",
);
const validateSeededRecallCorpusSchema = validator("seeded-recall-corpus.v0.schema.json");
const validateSeededRecallReportSchema = validator("seeded-recall-report.v0.schema.json");

function schemaErrors(check) {
  return (check.errors ?? []).map(
    (error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`,
  );
}

function validationResult(errors) {
  return Object.freeze({ errors: Object.freeze(errors), valid: errors.length === 0 });
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateFrozenCalibrationFrameBytes(candidateBytes, corpusBytes) {
  const errors = [];
  if (!(candidateBytes instanceof Uint8Array) || !(corpusBytes instanceof Uint8Array))
    return validationResult(["frozen calibration artifacts must be supplied as bytes"]);
  if (sha256Bytes(candidateBytes) !== FROZEN_CANDIDATE_BYTES_SHA256)
    errors.push("candidate snapshot bytes differ from the pre-diagnostic K02 freeze");
  if (sha256Bytes(corpusBytes) !== FROZEN_CORPUS_BYTES_SHA256)
    errors.push("selected corpus bytes differ from the pre-diagnostic K02 freeze");
  return validationResult(errors);
}

export function validateFrozenSeededRecallBytes(corpusBytes, reportBytes) {
  const errors = [];
  if (!(corpusBytes instanceof Uint8Array) || !(reportBytes instanceof Uint8Array))
    return validationResult(["frozen seeded-recall artifacts must be supplied as bytes"]);
  if (sha256Bytes(corpusBytes) !== FROZEN_SEEDED_RECALL_CORPUS_BYTES_SHA256)
    errors.push("seeded-recall corpus bytes differ from the pre-K03 F16 freeze");
  if (sha256Bytes(reportBytes) !== FROZEN_SEEDED_RECALL_REPORT_BYTES_SHA256)
    errors.push("seeded-recall report bytes differ from the pre-K03 F16 freeze");
  return validationResult(errors);
}

function parseFrozenJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function ruleResults(decisions) {
  const groups = new Map();
  for (const decision of decisions) {
    const key = `${decision.ruleId}\u0000${decision.severity}`;
    const summary = groups.get(key) ?? {
      falsePositiveCount: 0,
      otherCount: 0,
      ruleId: decision.ruleId,
      severity: decision.severity,
      truePositiveCount: 0,
    };
    if (decision.label === "true-positive") summary.truePositiveCount += 1;
    else if (decision.label === "false-positive") summary.falsePositiveCount += 1;
    else summary.otherCount += 1;
    groups.set(key, summary);
  }
  return [...groups.values()].sort((left, right) =>
    compareUtf8(`${left.ruleId}\u0000${left.severity}`, `${right.ruleId}\u0000${right.severity}`),
  );
}

function falsePositiveAggregates(decisions, candidateSnapshot, corpus) {
  const candidateById = new Map(
    candidateSnapshot.candidates.map((candidate) => [candidate.repositoryId, candidate]),
  );
  const selectedById = new Map(
    corpus.repositories.map((repository) => [repository.repositoryId, repository]),
  );
  const groups = new Map();
  for (const decision of decisions.filter((entry) => entry.label === "false-positive")) {
    const candidate = candidateById.get(decision.repositoryId);
    const selected = selectedById.get(decision.repositoryId);
    if (candidate === undefined || selected === undefined)
      throw new Error("false-positive aggregate repository is outside the frozen frame");
    const value = {
      assignedStratum: selected.assignedStratum,
      count: 0,
      multipleInstructionFormats: candidate.traits.multipleInstructionFormats,
      reason: decision.reason,
      repositoryType: candidate.traits.monorepository ? "monorepository" : "single-repository",
      ruleId: decision.ruleId,
      severity: decision.severity,
    };
    const key = canonicalJson(value);
    const aggregate = groups.get(key) ?? value;
    aggregate.count += 1;
    groups.set(key, aggregate);
  }
  return [...groups.values()].sort((left, right) =>
    compareUtf8(canonicalJson(left), canonicalJson(right)),
  );
}

function validateTuningChanges(
  changes,
  adjudication,
  finalEngine,
  preTuningReportSha256,
  preTuningAdjudicationSha256,
) {
  const falsePositives = new Map(
    adjudication.decisions
      .filter((entry) => entry.label === "false-positive")
      .map((entry) => [entry.diagnosticFingerprint, entry.ruleId]),
  );
  const seen = new Set();
  for (const [index, change] of changes.entries()) {
    const key = `${change.ruleId}\u0000${change.action}`;
    if (seen.has(key)) throw new Error(`tuningChanges[${String(index)}] duplicates a rule/action`);
    seen.add(key);
    if (
      change.codeCommitSha !== finalEngine.commitSha ||
      change.packageSha256 !== finalEngine.packageSha256 ||
      change.preTuningReportSha256 !== preTuningReportSha256 ||
      change.preTuningAdjudicationSha256 !== preTuningAdjudicationSha256
    )
      throw new Error(`tuningChanges[${String(index)}] does not bind the pre/post engine lineage`);
    for (const fingerprint of change.evidenceFingerprints) {
      const evidenceRuleId = falsePositives.get(fingerprint);
      if (evidenceRuleId === undefined)
        throw new Error(
          `tuningChanges[${String(index)}] cites a fingerprint not adjudicated false-positive`,
        );
      if (evidenceRuleId !== change.ruleId)
        throw new Error(
          `tuningChanges[${String(index)}] cites false-positive evidence for a different rule`,
        );
    }
    for (const regression of change.regressionTests) {
      const components = regression.path.split("/");
      if (
        regression.path.includes("\\") ||
        path.posix.normalize(regression.path) !== regression.path ||
        components.some(
          (component) => component === "" || component === "." || component === "..",
        ) ||
        components.length < 3 ||
        components[0] !== "calibration" ||
        components[1] !== "regressions"
      )
        throw new Error(`tuningChanges[${String(index)}] contains a non-canonical regression path`);
    }
    const sortedFingerprints = [...change.evidenceFingerprints].sort(compareUtf8);
    const sortedTests = [...change.regressionTests].sort((left, right) =>
      compareUtf8(`${left.path}\u0000${left.sha256}`, `${right.path}\u0000${right.sha256}`),
    );
    if (
      canonicalJson(change.evidenceFingerprints) !== canonicalJson(sortedFingerprints) ||
      canonicalJson(change.regressionTests) !== canonicalJson(sortedTests)
    )
      throw new Error(`tuningChanges[${String(index)}] evidence and tests must be sorted`);
  }
}

export function validateBoundSeededRecall(corpus, report) {
  const errors = [];
  const expectedRules = [...SUPPORTED_RULE_IDS].sort(compareUtf8);
  const corpusRules = corpus.cases.map((entry) => entry.expectedRuleId).sort(compareUtf8);
  const reportRules = report.cases.map((entry) => entry.expectedRuleId).sort(compareUtf8);
  if (
    new Set(corpusRules).size !== SUPPORTED_RULE_IDS.length ||
    canonicalJson(corpusRules) !== canonicalJson(expectedRules)
  )
    errors.push("seeded corpus must cover each of the exact 69 supported rule IDs once");
  if (
    new Set(reportRules).size !== SUPPORTED_RULE_IDS.length ||
    canonicalJson(reportRules) !== canonicalJson(expectedRules)
  )
    errors.push("seeded report must cover each of the exact 69 supported rule IDs once");
  if (!validateSeededRecallCorpusSchema(corpus))
    return validationResult(schemaErrors(validateSeededRecallCorpusSchema));
  if (!validateSeededRecallReportSchema(report))
    return validationResult(schemaErrors(validateSeededRecallReportSchema));
  if (corpus.cases.length !== 69) errors.push("seeded corpus must retain all 69 supported rules");
  if (report.corpusSha256 !== sha256Canonical(corpus))
    errors.push("seeded report does not bind the canonical seeded corpus");
  if (
    report.runSha256 !==
    sha256Canonical({
      cases: report.cases,
      corpusSha256: report.corpusSha256,
      schedulerVersion: report.schedulerVersion,
    })
  )
    errors.push("seeded report does not bind its deterministic scheduler results");
  let detected = 0;
  for (const [index, entry] of report.cases.entries()) {
    const expected = corpus.cases[index];
    if (
      expected === undefined ||
      entry.caseId !== expected.caseId ||
      entry.expectedRuleId !== expected.expectedRuleId ||
      entry.familyId !== expected.familyId ||
      entry.scenarioId !== expected.scenarioId
    )
      errors.push(`seeded report case ${String(index)} does not match its corpus identity`);
    if (entry.detected) {
      detected += 1;
      if (entry.diagnostic === null || entry.disposition !== "visible")
        errors.push(`seeded report case ${String(index)} has inconsistent detection evidence`);
      if (
        entry.diagnostic !== null &&
        expected !== undefined &&
        (entry.diagnostic.severity !== expected.defaultSeverity ||
          sha256Canonical({
            path: entry.diagnostic.path,
            ruleId: entry.expectedRuleId,
            semantic: entry.diagnostic.semantic,
          }) !== expected.expectedDiagnosticSha256)
      )
        errors.push(`seeded report case ${String(index)} differs from its intended fingerprint`);
    } else if (entry.diagnostic !== null || entry.disposition !== "missed") {
      errors.push(`seeded report case ${String(index)} has evidence for a missed case`);
    }
  }
  const missed = corpus.cases.length - detected;
  if (
    report.summary.supportedCases !== corpus.cases.length ||
    report.summary.detectedCases !== detected ||
    report.summary.missedCases !== missed ||
    report.summary.recallBasisPoints !== Math.floor((detected * 10_000) / corpus.cases.length)
  )
    errors.push("seeded report summary does not reconstruct from case results");
  return validationResult(errors);
}

export function createPrecisionEvidence({
  adjudication,
  candidateBytes,
  corpus,
  corpusBytes,
  engine,
  generatedAt,
  maintainerReview,
  maintainerAuthority = K03_MAINTAINER_AUTHORITY,
  report,
  seededRecallCorpus,
  seededRecallCorpusBytes,
  seededRecallReport,
  seededRecallReportBytes,
  tuningChanges = [],
  preTuningAdjudication = adjudication,
  preTuningEngine = engine,
  preTuningMaintainerReview = maintainerReview,
  preTuningReport = report,
}) {
  if (canonicalJson(maintainerAuthority) !== canonicalJson(K03_MAINTAINER_AUTHORITY))
    throw new Error("precision evidence requires the committed K03 maintainer authority");
  const frozen = validateFrozenCalibrationFrameBytes(candidateBytes, corpusBytes);
  if (!frozen.valid) throw new Error(frozen.errors.join("\n"));
  const candidateSnapshot = parseFrozenJson(candidateBytes, "frozen candidate snapshot");
  const frozenCorpus = parseFrozenJson(corpusBytes, "frozen selected corpus");
  if (canonicalJson(corpus) !== canonicalJson(frozenCorpus))
    throw new Error("in-memory corpus differs from the immutable K02 corpus bytes");
  const candidateCheck = validateCandidateSnapshot(candidateSnapshot);
  if (!candidateCheck.valid) throw new Error(candidateCheck.errors.join("\n"));
  const corpusCheck = validateCalibrationCorpus(corpus, candidateSnapshot);
  if (!corpusCheck.valid) throw new Error(corpusCheck.errors.join("\n"));
  const reportCheck = validateCalibrationReport(report, corpus);
  if (!reportCheck.valid) throw new Error(reportCheck.errors.join("\n"));
  if (canonicalJson(engine) !== canonicalJson(report.engine))
    throw new Error("precision engine must equal the exact public capture engine identity");
  const adjudicationCheck = validateCalibrationAdjudication(adjudication, report, maintainerReview);
  if (!adjudicationCheck.valid) throw new Error(adjudicationCheck.errors.join("\n"));
  if (sha256Bytes(seededRecallCorpusBytes) !== FROZEN_SEEDED_RECALL_CORPUS_BYTES_SHA256)
    throw new Error("seeded-recall corpus bytes differ from the pre-K03 F16 freeze");
  if (
    tuningChanges.length === 0 &&
    sha256Bytes(seededRecallReportBytes) !== FROZEN_SEEDED_RECALL_REPORT_BYTES_SHA256
  )
    throw new Error("seeded-recall report bytes differ from the pre-K03 F16 freeze");
  const frozenSeededCorpus = parseFrozenJson(
    seededRecallCorpusBytes,
    "frozen seeded-recall corpus",
  );
  const frozenSeededReport = parseFrozenJson(
    seededRecallReportBytes,
    "frozen seeded-recall report",
  );
  if (
    canonicalJson(seededRecallCorpus) !== canonicalJson(frozenSeededCorpus) ||
    canonicalJson(seededRecallReport) !== canonicalJson(frozenSeededReport)
  )
    throw new Error("in-memory seeded recall differs from the immutable F16 artifact bytes");
  const seededCheck = validateBoundSeededRecall(seededRecallCorpus, seededRecallReport);
  if (!seededCheck.valid) throw new Error(seededCheck.errors.join("\n"));
  if (
    seededRecallReport.summary.detectedCases !== seededRecallReport.summary.supportedCases ||
    seededRecallReport.summary.recallBasisPoints !== 10_000
  )
    throw new Error("seeded supported-rule recall is not complete");
  if (report.diagnostics.length < MINIMUM_REVIEWED_DIAGNOSTICS)
    throw new Error(`at least ${String(MINIMUM_REVIEWED_DIAGNOSTICS)} diagnostics are required`);
  if (adjudication.summary.resolvedCount !== report.diagnostics.length)
    throw new Error("every calibration diagnostic must be resolved");
  const testHarnessDefectCount = adjudication.decisions.filter(
    (decision) => decision.label === "test-harness-defect",
  ).length;
  if (testHarnessDefectCount > 0)
    throw new Error(
      "test-harness defect requires capture repair and complete K03 recapture before precision evidence",
    );
  const uncertainCount = adjudication.decisions.filter(
    (decision) => decision.label === "uncertain-client-behavior",
  ).length;
  const uncertainBasisPoints = Math.floor((uncertainCount * 10_000) / report.diagnostics.length);
  if (
    uncertainCount > MAXIMUM_UNCERTAIN_DIAGNOSTICS ||
    uncertainBasisPoints > MAXIMUM_UNCERTAIN_BASIS_POINTS
  )
    throw new Error("uncertain client behavior exceeds the bounded K03 release policy");
  if (!adjudication.summary.error.thresholdPassed)
    throw new Error("default-error Wilson 95% lower-bound precision gate failed");
  if (!adjudication.summary.warning.thresholdPassed)
    throw new Error("default-warning Wilson 95% lower-bound precision gate failed");
  const preTuningReportCheck = validateCalibrationReport(preTuningReport, corpus);
  if (!preTuningReportCheck.valid) throw new Error(preTuningReportCheck.errors.join("\n"));
  if (canonicalJson(preTuningEngine) !== canonicalJson(preTuningReport.engine))
    throw new Error("pre-tuning engine must equal the exact pre-tuning report engine identity");
  const preTuningAdjudicationCheck = validateCalibrationAdjudication(
    preTuningAdjudication,
    preTuningReport,
    preTuningMaintainerReview,
  );
  if (!preTuningAdjudicationCheck.valid)
    throw new Error(preTuningAdjudicationCheck.errors.join("\n"));
  if (
    preTuningAdjudication.reportSha256 !== sha256Canonical(preTuningReport) ||
    preTuningEngine.commitSha !== preTuningReport.engine.commitSha ||
    preTuningEngine.packageSha256 !== preTuningReport.engine.packageSha256
  )
    throw new Error("pre-tuning report, adjudication, and engine lineage is incoherent");
  if (
    tuningChanges.length > 0 &&
    (sha256Canonical(preTuningReport) === sha256Canonical(report) ||
      preTuningEngine.commitSha === engine.commitSha ||
      preTuningEngine.packageSha256 === engine.packageSha256)
  )
    throw new Error("tuning requires a distinct post-tuning scan and final packed engine");
  if (
    tuningChanges.length > 0 &&
    Date.parse(preTuningAdjudication.adjudicatedAt) >= Date.parse(engine.captureStartedAt)
  )
    throw new Error("pre-tuning adjudication must strictly predate final capture");
  if (
    tuningChanges.length === 0 &&
    (sha256Canonical(preTuningReport) !== sha256Canonical(report) ||
      canonicalJson(preTuningEngine) !== canonicalJson(engine) ||
      sha256Canonical(preTuningAdjudication) !== sha256Canonical(adjudication))
  )
    throw new Error("no-tuning lineage must use one exact report, adjudication, and engine");
  validateTuningChanges(
    tuningChanges,
    preTuningAdjudication,
    engine,
    sha256Canonical(preTuningReport),
    sha256Canonical(preTuningAdjudication),
  );
  if (Date.parse(generatedAt) <= Date.parse(adjudication.adjudicatedAt))
    throw new Error("precision evidence time must strictly follow adjudication");
  const value = {
    adjudicationSha256: sha256Canonical(adjudication),
    contractVersion: CONTRACT_VERSION,
    corpusSha256: sha256Canonical(corpus),
    diagnosticCount: report.diagnostics.length,
    engine,
    externalHoldout: {
      releaseTrialObserved: false,
      releaseTrialRepositoryCount: 0,
      releaseTrialUsedForSelection: false,
      releaseTrialUsedForTuning: false,
    },
    generatedAt,
    falsePositiveAggregates: falsePositiveAggregates(
      adjudication.decisions,
      candidateSnapshot,
      corpus,
    ),
    lineage: {
      finalEngineSha256: sha256Canonical(engine),
      finalReportSha256: sha256Canonical(report),
      finalSeededRecallReportSha256: sha256Canonical(seededRecallReport),
      engineSourceCommitSha: engine.commitSha,
      preTuningAdjudicationSha256: sha256Canonical(preTuningAdjudication),
      preTuningEngineSha256: sha256Canonical(preTuningEngine),
      preTuningMaintainerReviewSha256: sha256Canonical(preTuningMaintainerReview),
      preTuningReportSha256: sha256Canonical(preTuningReport),
      tuningApplied: tuningChanges.length > 0,
    },
    maintainerAuthoritySha256: sha256Canonical(maintainerAuthority),
    maintainerReviewSha256: sha256Canonical(maintainerReview),
    privatePayloadSha256: report.privatePayloadSha256,
    precision: {
      error: adjudication.summary.error,
      warning: adjudication.summary.warning,
    },
    precisionGatePassed: true,
    recordKind: PRECISION_EVIDENCE_KIND,
    reportSha256: sha256Canonical(report),
    resolvedDiagnosticCount: adjudication.summary.resolvedCount,
    reviewDispositionPolicy: {
      maximumUncertainBasisPoints: MAXIMUM_UNCERTAIN_BASIS_POINTS,
      maximumUncertainCount: MAXIMUM_UNCERTAIN_DIAGNOSTICS,
      testHarnessDefectCount,
      testHarnessDefectsBlock: true,
      uncertainBasisPoints,
      uncertainCount,
    },
    ruleResults: ruleResults(adjudication.decisions),
    seededRecallReportSha256: sha256Canonical(seededRecallReport),
    sourcePolicy: { fingerprintOnly: true, repositoryContent: false, repositoryPaths: false },
    tuningChanges,
  };
  if (!validatePrecisionEvidenceSchema(value))
    throw new Error(schemaErrors(validatePrecisionEvidenceSchema).join("\n"));
  return Object.freeze(value);
}

export function validatePrecisionEvidence(evidence, dependencies) {
  if (!validatePrecisionEvidenceSchema(evidence))
    return validationResult(schemaErrors(validatePrecisionEvidenceSchema));
  let expected;
  try {
    expected = createPrecisionEvidence(dependencies);
  } catch (error) {
    return validationResult([
      error instanceof Error ? error.message : "precision evidence is invalid",
    ]);
  }
  return validationResult(
    canonicalJson(evidence) === canonicalJson(expected)
      ? []
      : ["precision evidence does not reconstruct from its bound artifacts"],
  );
}
