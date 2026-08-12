import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { recognizeBuiltInInstructionPath } from "../../packages/evidence/built-in-instruction-paths.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;

export const CONTRACT_VERSION = "0.1.0";
export const CANDIDATE_KIND = "agent-context-metadata-calibration-candidates";
export const CORPUS_KIND = "agent-context-metadata-calibration-corpus";
export const REPORT_KIND = "agent-context-metadata-calibration-report";
export const REVIEW_KIND = "agent-context-metadata-calibration-review";
export const ADJUDICATION_KIND = "agent-context-metadata-calibration-adjudication";
export const FORMAT_STRATA = Object.freeze(["agents-md", "claude", "copilot", "cursor", "gemini"]);
export const TARGET_PER_STRATUM = 10;
export const TARGET_REPOSITORIES = 50;
export const SELECTION_SEED_SHA256 = createHash("sha256")
  .update("agent-context-lint:k02:metadata-calibration:v0:2026-08-09", "utf8")
  .digest("hex");

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIRECTORY = path.resolve(MODULE_DIRECTORY, "../../calibration/schemas");
const K03_MAINTAINER_AUTHORITY_PATH = path.resolve(
  MODULE_DIRECTORY,
  "../../calibration/metadata/v0/k03-maintainer-authority.json",
);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort(compareUtf8))
      result[key] = canonicalValue(value[key]);
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("canonical JSON rejects non-finite numbers");
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function createValidator(name) {
  const schema = JSON.parse(readFileSync(path.join(SCHEMA_DIRECTORY, name), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const schemaValidators = Object.freeze({
  adjudication: createValidator("metadata-calibration-adjudication.v0.schema.json"),
  maintainerAuthority: createValidator("metadata-calibration-maintainer-authority.v0.schema.json"),
  candidates: createValidator("metadata-calibration-candidates.v0.schema.json"),
  corpus: createValidator("metadata-calibration-corpus.v0.schema.json"),
  report: createValidator("metadata-calibration-report.v0.schema.json"),
});

export const K03_MAINTAINER_AUTHORITY = Object.freeze(
  JSON.parse(readFileSync(K03_MAINTAINER_AUTHORITY_PATH, "utf8")),
);
if (!schemaValidators.maintainerAuthority(K03_MAINTAINER_AUTHORITY))
  throw new Error(
    `committed K03 maintainer authority is invalid: ${schemaErrors(schemaValidators.maintainerAuthority).join("; ")}`,
  );
export const K03_MAINTAINER_REVIEWER_ID = K03_MAINTAINER_AUTHORITY.reviewerId;
export const K03_MAINTAINER_AUTHORITY_SHA256 = sha256Canonical(K03_MAINTAINER_AUTHORITY);

export function validateK03MaintainerAuthority(authority) {
  const errors = [];
  if (!schemaValidators.maintainerAuthority(authority))
    return validationResult(schemaErrors(schemaValidators.maintainerAuthority));
  if (canonicalJson(authority) !== canonicalJson(K03_MAINTAINER_AUTHORITY))
    errors.push("maintainer authority differs from the closed repository-owned declaration");
  return validationResult(errors);
}

function schemaErrors(validator) {
  return (validator.errors ?? []).map(
    (error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`,
  );
}

function validationResult(errors) {
  return Object.freeze({ errors: Object.freeze(errors), valid: errors.length === 0 });
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareUtf8);
}

function evidenceKey(evidence) {
  return `${evidence.format}\u0000${evidence.path}`;
}

function stratumForRecognizer(recognizerId) {
  if (recognizerId.startsWith("instruction.agents-")) return "agents-md";
  if (recognizerId.startsWith("instruction.claude-")) return "claude";
  if (recognizerId.startsWith("instruction.copilot-")) return "copilot";
  if (recognizerId.startsWith("instruction.cursor-")) return "cursor";
  if (recognizerId === "instruction.gemini-context") return "gemini";
  throw new Error(`unsupported built-in instruction recognizer ${recognizerId}`);
}

export function calibrationFormatsForPath(pathValue) {
  return Object.freeze(
    sortedUnique(
      recognizeBuiltInInstructionPath(pathValue).map((entry) =>
        stratumForRecognizer(entry.recognizerId),
      ),
    ),
  );
}

function expectedRepositoryUrl(fullName) {
  return `https://github.com/${fullName}`;
}

function expectedApiUrl(fullName) {
  return `https://api.github.com/repos/${fullName}`;
}

function expectedMetadataUrl(repository) {
  return `${repository.apiUrl}/git/trees/${repository.pinnedTreeSha}`;
}

export function validateCandidateSnapshot(snapshot) {
  const errors = [];
  if (!schemaValidators.candidates(snapshot))
    return validationResult(schemaErrors(schemaValidators.candidates));
  if (snapshot.recordKind !== CANDIDATE_KIND)
    errors.push(`$.recordKind must equal ${CANDIDATE_KIND}`);
  const queryFormats = snapshot.retrieval.queries.map((entry) => entry.format);
  if (canonicalJson(queryFormats) !== canonicalJson(FORMAT_STRATA))
    errors.push("$.retrieval.queries must use every format exactly once in contract order");
  if (snapshot.retrieval.queries.some((entry) => entry.incompleteResults))
    errors.push("$.retrieval.queries must not contain incomplete GitHub search results");
  const repositoryIds = new Set();
  const fullNames = new Set();
  let priorName = "";
  for (const [index, repository] of snapshot.candidates.entries()) {
    const pointer = `$.candidates[${String(index)}]`;
    if (priorName && compareUtf8(priorName.toLowerCase(), repository.fullName.toLowerCase()) >= 0)
      errors.push("$.candidates must be strictly sorted by case-insensitive fullName");
    priorName = repository.fullName;
    if (repositoryIds.has(repository.repositoryId))
      errors.push(`${pointer}.repositoryId duplicates another candidate`);
    repositoryIds.add(repository.repositoryId);
    const folded = repository.fullName.toLowerCase();
    if (fullNames.has(folded)) errors.push(`${pointer}.fullName duplicates another candidate`);
    fullNames.add(folded);
    if (repository.repositoryUrl !== expectedRepositoryUrl(repository.fullName))
      errors.push(`${pointer}.repositoryUrl is not the canonical GitHub repository URL`);
    if (repository.apiUrl !== expectedApiUrl(repository.fullName))
      errors.push(`${pointer}.apiUrl is not the canonical GitHub API URL`);
    if (repository.publicSourceEvidence.url !== repository.repositoryUrl)
      errors.push(`${pointer}.publicSourceEvidence.url must equal repositoryUrl`);
    if (repository.publicSourceEvidence.observedAt !== snapshot.retrieval.retrievedAt)
      errors.push(`${pointer}.publicSourceEvidence.observedAt must equal retrieval time`);
    if (["NOASSERTION", "OTHER"].includes(repository.license.spdxId))
      errors.push(`${pointer}.license.spdxId must be an explicit public-source license identity`);
    if (repository.license.metadataUrl !== repository.apiUrl)
      errors.push(`${pointer}.license.metadataUrl must bind the content-free repository metadata`);
    const evidenceKeys = repository.instructionEvidence.map(evidenceKey);
    if (canonicalJson(evidenceKeys) !== canonicalJson(sortedUnique(evidenceKeys)))
      errors.push(`${pointer}.instructionEvidence must be unique and sorted by format/path`);
    for (const [evidenceIndex, evidence] of repository.instructionEvidence.entries()) {
      const recognizedFormats = calibrationFormatsForPath(evidence.path);
      if (recognizedFormats.length !== 1 || recognizedFormats[0] !== evidence.format)
        errors.push(
          `${pointer}.instructionEvidence[${String(evidenceIndex)}] is not recognized by the production discovery catalog`,
        );
      if (evidence.metadataUrl !== expectedMetadataUrl(repository))
        errors.push(
          `${pointer}.instructionEvidence[${String(evidenceIndex)}].metadataUrl must bind the pinned commit`,
        );
    }
    const formats = sortedUnique(
      repository.instructionEvidence.flatMap((entry) => calibrationFormatsForPath(entry.path)),
    );
    if (canonicalJson(repository.strata) !== canonicalJson(formats))
      errors.push(`${pointer}.strata must equal the sorted evidence formats`);
    if (repository.traits.multipleInstructionFormats !== formats.length > 1)
      errors.push(`${pointer}.traits.multipleInstructionFormats does not reconstruct`);
    if (repository.traits.monorepository !== repository.monorepoEvidencePaths.length > 0)
      errors.push(`${pointer}.traits.monorepository does not reconstruct`);
    if (
      canonicalJson(repository.monorepoEvidencePaths) !==
      canonicalJson(sortedUnique(repository.monorepoEvidencePaths))
    )
      errors.push(`${pointer}.monorepoEvidencePaths must be unique and sorted`);
  }
  return validationResult(errors);
}

function rankFor(seed, stratum, fullName) {
  return createHash("sha256")
    .update(`${seed}:${stratum}:${fullName.toLowerCase()}`, "utf8")
    .digest("hex");
}

export function selectCalibrationCorpus(snapshot, { seedSha256 = SELECTION_SEED_SHA256 } = {}) {
  const checked = validateCandidateSnapshot(snapshot);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
  if (!/^[0-9a-f]{64}$/.test(seedSha256))
    throw new Error("selection seed must be a SHA-256 hex value");
  const selected = [];
  const used = new Set();
  const formatOrder = FORMAT_STRATA.map((format) => ({
    eligible: snapshot.candidates.filter((candidate) => candidate.strata.includes(format)).length,
    format,
  })).sort(
    (left, right) => left.eligible - right.eligible || compareUtf8(left.format, right.format),
  );
  for (const { format } of formatOrder) {
    const ranked = snapshot.candidates
      .filter((candidate) => candidate.strata.includes(format) && !used.has(candidate.repositoryId))
      .map((candidate) => ({ candidate, rank: rankFor(seedSha256, format, candidate.fullName) }))
      .sort((left, right) => compareUtf8(left.rank, right.rank));
    if (ranked.length < TARGET_PER_STRATUM)
      throw new Error(
        `stratum ${format} has only ${String(ranked.length)} unused eligible candidates`,
      );
    for (const entry of ranked.slice(0, TARGET_PER_STRATUM)) {
      used.add(entry.candidate.repositoryId);
      selected.push({
        assignedStratum: format,
        fullName: entry.candidate.fullName,
        pinnedCommitSha: entry.candidate.pinnedCommitSha,
        rank: entry.rank,
        repositoryId: entry.candidate.repositoryId,
      });
    }
  }
  selected.sort((left, right) =>
    compareUtf8(
      `${left.assignedStratum}\u0000${left.rank}`,
      `${right.assignedStratum}\u0000${right.rank}`,
    ),
  );
  const corpus = {
    contractVersion: CONTRACT_VERSION,
    recordKind: CORPUS_KIND,
    repositories: selected,
    selection: {
      algorithm: "sha256-ranked-stratified-v1",
      candidateSnapshotSha256: sha256Canonical(snapshot),
      minimumMonorepositories: 1,
      minimumMultipleFormatRepositories: 1,
      repositoriesPerStratum: TARGET_PER_STRATUM,
      seedSha256,
      targetRepositoryCount: TARGET_REPOSITORIES,
    },
    sourcePolicy: snapshot.sourcePolicy,
  };
  const corpusResult = validateCalibrationCorpus(corpus, snapshot);
  if (!corpusResult.valid) throw new Error(corpusResult.errors.join("\n"));
  return Object.freeze(corpus);
}

export function validateCalibrationCorpus(corpus, snapshot) {
  const errors = [];
  if (!schemaValidators.corpus(corpus))
    return validationResult(schemaErrors(schemaValidators.corpus));
  const snapshotResult = validateCandidateSnapshot(snapshot);
  if (!snapshotResult.valid) return snapshotResult;
  if (corpus.recordKind !== CORPUS_KIND) errors.push(`$.recordKind must equal ${CORPUS_KIND}`);
  if (corpus.selection.candidateSnapshotSha256 !== sha256Canonical(snapshot))
    errors.push("$.selection.candidateSnapshotSha256 does not bind the candidate snapshot");
  const expected = selectWithoutValidation(snapshot, corpus.selection.seedSha256);
  if (canonicalJson(corpus.repositories) !== canonicalJson(expected))
    errors.push("$.repositories do not reconstruct from the declared selection algorithm");
  const byId = new Map(snapshot.candidates.map((candidate) => [candidate.repositoryId, candidate]));
  const selectedCandidates = corpus.repositories.map((entry) => byId.get(entry.repositoryId));
  if (!selectedCandidates.some((entry) => entry?.traits.monorepository))
    errors.push("$.repositories must include at least one metadata-evidenced monorepository");
  if (!selectedCandidates.some((entry) => entry?.traits.multipleInstructionFormats))
    errors.push("$.repositories must include at least one multiple-format repository");
  return validationResult(errors);
}

function selectWithoutValidation(snapshot, seedSha256) {
  const selected = [];
  const used = new Set();
  const formatOrder = FORMAT_STRATA.map((format) => ({
    eligible: snapshot.candidates.filter((candidate) => candidate.strata.includes(format)).length,
    format,
  })).sort(
    (left, right) => left.eligible - right.eligible || compareUtf8(left.format, right.format),
  );
  for (const { format } of formatOrder) {
    const ranked = snapshot.candidates
      .filter((candidate) => candidate.strata.includes(format) && !used.has(candidate.repositoryId))
      .map((candidate) => ({ candidate, rank: rankFor(seedSha256, format, candidate.fullName) }))
      .sort((left, right) => compareUtf8(left.rank, right.rank));
    for (const entry of ranked.slice(0, TARGET_PER_STRATUM)) {
      used.add(entry.candidate.repositoryId);
      selected.push({
        assignedStratum: format,
        fullName: entry.candidate.fullName,
        pinnedCommitSha: entry.candidate.pinnedCommitSha,
        rank: entry.rank,
        repositoryId: entry.candidate.repositoryId,
      });
    }
  }
  return selected.sort((left, right) =>
    compareUtf8(
      `${left.assignedStratum}\u0000${left.rank}`,
      `${right.assignedStratum}\u0000${right.rank}`,
    ),
  );
}

function diagnosticKey(entry) {
  return `${entry.repositoryId}\u0000${entry.ruleId}\u0000${entry.diagnosticFingerprint}`;
}

/**
 * Derive the public K03 diagnostic identity from already-public B04 identities. The domain tag and
 * length-delimited canonical JSON array make this a new identity rather than an undocumented alias
 * of either B04 fingerprint. Repository paths, messages, snippets, and fingerprint bases are never
 * inputs to the committed calibration record.
 */
export function computeCalibrationDiagnosticFingerprint(entry) {
  const values = [
    entry?.repositoryId,
    entry?.ruleId,
    entry?.pathFingerprint,
    entry?.semanticFingerprint,
    entry?.severity,
  ];
  if (
    !/^[1-9][0-9]{0,19}$/.test(values[0]) ||
    !/^ACL[1-5][0-9]{2}$/.test(values[1]) ||
    !/^[0-9a-f]{64}$/.test(values[2]) ||
    !/^[0-9a-f]{64}$/.test(values[3]) ||
    !new Set(["error", "warning"]).has(values[4])
  )
    throw new Error("calibration diagnostic identity is invalid");
  return createHash("sha256")
    .update(canonicalJson(["agent-context-lint:k03:diagnostic:v1", ...values]), "utf8")
    .digest("hex");
}

export function validateCalibrationReport(report, corpus) {
  const errors = [];
  if (!schemaValidators.report(report))
    return validationResult(schemaErrors(schemaValidators.report));
  if (report.recordKind !== REPORT_KIND) errors.push(`$.recordKind must equal ${REPORT_KIND}`);
  if (report.corpusSha256 !== sha256Canonical(corpus))
    errors.push("$.corpusSha256 does not bind the corpus");
  if (
    report.engineVersion !== report.engine.version ||
    report.knowledgeVersion !== report.engine.knowledgeVersion
  )
    errors.push("$.engineVersion and $.knowledgeVersion must equal the captured engine identity");
  if (Date.parse(report.engine.captureStartedAt) >= Date.parse(report.generatedAt))
    errors.push("$.generatedAt must strictly follow $.engine.captureStartedAt");
  const repositoryIds = new Set(corpus.repositories.map((entry) => entry.repositoryId));
  const keys = report.diagnostics.map(diagnosticKey);
  if (canonicalJson(keys) !== canonicalJson(sortedUnique(keys)))
    errors.push("$.diagnostics must be unique and sorted by repository/rule/fingerprint");
  for (const [index, entry] of report.diagnostics.entries()) {
    if (!repositoryIds.has(entry.repositoryId))
      errors.push(`$.diagnostics[${String(index)}].repositoryId is not in the bound corpus`);
    if (entry.diagnosticFingerprint !== computeCalibrationDiagnosticFingerprint(entry))
      errors.push(
        `$.diagnostics[${String(index)}].diagnosticFingerprint does not reconstruct from its public identity`,
      );
  }
  return validationResult(errors);
}

function reviewIdentity(entry) {
  return {
    diagnosticFingerprint: entry.diagnosticFingerprint,
    repositoryId: entry.repositoryId,
    ruleId: entry.ruleId,
    severity: entry.severity,
  };
}

export function createCalibrationWorksheet(report) {
  if (!schemaValidators.report(report))
    throw new Error(schemaErrors(schemaValidators.report).join("\n"));
  return {
    labels: report.diagnostics.map((entry) => ({
      ...reviewIdentity(entry),
      label: null,
      reason: null,
    })),
    recordKind: "agent-context-metadata-calibration-label-worksheet",
    privatePayloadSha256: report.privatePayloadSha256,
    reportSha256: sha256Canonical(report),
  };
}

const ALLOWED_REASONS = Object.freeze({
  "false-positive": new Set([
    "classifier-boundary",
    "repository-evidence-mismatch",
    "rule-threshold",
    "scope-resolution",
  ]),
  "test-harness-defect": new Set(["fixture-or-scan-defect"]),
  "true-positive": new Set(["documented-behavior-confirmed"]),
  "uncertain-client-behavior": new Set(["insufficient-evidence", "profile-semantics-unknown"]),
});

export function createCalibrationReview(report, worksheet, reviewerId, reviewedAt) {
  if (reviewerId !== K03_MAINTAINER_REVIEWER_ID)
    throw new Error("reviewer ID is not the committed K03 maintainer identity");
  const expected = createCalibrationWorksheet(report);
  if (
    worksheet?.recordKind !== expected.recordKind ||
    worksheet.reportSha256 !== expected.reportSha256 ||
    worksheet.privatePayloadSha256 !== expected.privatePayloadSha256
  )
    throw new Error("worksheet does not bind the report and exact private review payload");
  if (
    typeof reviewedAt !== "string" ||
    !Number.isFinite(Date.parse(reviewedAt)) ||
    Date.parse(reviewedAt) <= Date.parse(report.generatedAt)
  )
    throw new Error("review completion time must strictly follow capture completion");
  if (!Array.isArray(worksheet.labels) || worksheet.labels.length !== expected.labels.length)
    throw new Error("worksheet label count differs from the report");
  const labels = worksheet.labels.map((entry, index) => {
    const identity = expected.labels[index];
    if (canonicalJson(reviewIdentity(entry)) !== canonicalJson(reviewIdentity(identity)))
      throw new Error(`worksheet label ${String(index)} identity differs from the report`);
    if (
      !Object.hasOwn(ALLOWED_REASONS, entry.label) ||
      !ALLOWED_REASONS[entry.label].has(entry.reason)
    )
      throw new Error(`worksheet label ${String(index)} has an invalid label/reason pair`);
    return { ...reviewIdentity(entry), label: entry.label, reason: entry.reason };
  });
  return {
    contractVersion: CONTRACT_VERSION,
    labels,
    maintainerAuthoritySha256: K03_MAINTAINER_AUTHORITY_SHA256,
    privatePayloadSha256: report.privatePayloadSha256,
    recordKind: REVIEW_KIND,
    reportSha256: expected.reportSha256,
    reviewedAt,
    reviewerId,
    role: "maintainer",
  };
}

export function validateCalibrationReview(review, report) {
  const errors = [];
  if (!schemaValidators.adjudication(review))
    return validationResult(schemaErrors(schemaValidators.adjudication));
  if (review.recordKind !== REVIEW_KIND)
    return validationResult([`$.recordKind must equal ${REVIEW_KIND}`]);
  if (review.reviewerId !== K03_MAINTAINER_REVIEWER_ID)
    errors.push("$.reviewerId is not the committed K03 maintainer identity");
  if (review.maintainerAuthoritySha256 !== K03_MAINTAINER_AUTHORITY_SHA256)
    errors.push("$.maintainerAuthoritySha256 does not bind the committed authority record");
  if (review.reportSha256 !== sha256Canonical(report))
    errors.push("$.reportSha256 does not bind the report");
  if (review.privatePayloadSha256 !== report.privatePayloadSha256)
    errors.push("$.privatePayloadSha256 does not bind the exact private review payload");
  if (Date.parse(review.reviewedAt) <= Date.parse(report.generatedAt))
    errors.push("$.reviewedAt must strictly follow capture completion");
  if (review.labels.length !== report.diagnostics.length)
    errors.push("$.labels must cover every report diagnostic");
  for (const [index, entry] of review.labels.entries()) {
    const expected = report.diagnostics[index];
    if (
      expected === undefined ||
      canonicalJson(reviewIdentity(entry)) !== canonicalJson(reviewIdentity(expected))
    )
      errors.push(`$.labels[${String(index)}] identity differs from the report`);
    if (!ALLOWED_REASONS[entry.label]?.has(entry.reason))
      errors.push(`$.labels[${String(index)}] has an invalid label/reason pair`);
  }
  return validationResult(errors);
}

export function wilson95(successes, total) {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(total) ||
    successes < 0 ||
    total < 0 ||
    successes > total
  )
    throw new Error("Wilson counts must be non-negative safe integers with successes <= total");
  if (total === 0)
    return {
      denominator: 0,
      falsePositiveCount: 0,
      lowerWilsonBasisPoints: 0,
      precisionBasisPoints: 0,
      truePositiveCount: 0,
      upperWilsonBasisPoints: 0,
    };
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((proportion * (1 - proportion)) / total + (z * z) / (4 * total * total))) /
    denominator;
  return {
    denominator: total,
    falsePositiveCount: total - successes,
    lowerWilsonBasisPoints: Math.max(0, Math.floor((center - margin) * 10_000)),
    precisionBasisPoints: Math.floor(proportion * 10_000),
    truePositiveCount: successes,
    upperWilsonBasisPoints: Math.min(10_000, Math.ceil((center + margin) * 10_000)),
  };
}

function precision(decisions, severity) {
  const eligible = decisions.filter(
    (entry) =>
      entry.severity === severity && ["true-positive", "false-positive"].includes(entry.label),
  );
  const base = wilson95(
    eligible.filter((entry) => entry.label === "true-positive").length,
    eligible.length,
  );
  const thresholdBasisPoints = severity === "error" ? 9500 : 8500;
  return {
    ...base,
    thresholdBasisPoints,
    // The point estimate alone is not a confidence gate. K03 passes only when the conservative
    // two-sided 95% Wilson lower bound reaches the configured release threshold.
    thresholdPassed: base.denominator > 0 && base.lowerWilsonBasisPoints >= thresholdBasisPoints,
  };
}

export function adjudicateCalibrationReview(report, review, adjudicatedAt) {
  const checked = validateCalibrationReview(review, report);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
  if (review.role !== "maintainer") throw new Error("one maintainer review is required");
  if (
    typeof adjudicatedAt !== "string" ||
    !Number.isFinite(Date.parse(adjudicatedAt)) ||
    Date.parse(adjudicatedAt) <= Date.parse(review.reviewedAt)
  )
    throw new Error("adjudication time must strictly follow the bound maintainer review");
  const decisions = report.diagnostics.map((diagnostic, index) => ({
    ...reviewIdentity(diagnostic),
    label: review.labels[index].label,
    reason: review.labels[index].reason,
    resolution: "maintainer-review",
  }));
  const summary = {
    error: precision(decisions, "error"),
    resolvedCount: decisions.length,
    warning: precision(decisions, "warning"),
  };
  return {
    adjudicatedAt,
    contractVersion: CONTRACT_VERSION,
    decisions,
    maintainerAuthoritySha256: K03_MAINTAINER_AUTHORITY_SHA256,
    maintainerReviewerId: review.reviewerId,
    maintainerReviewSha256: sha256Canonical(review),
    privatePayloadSha256: report.privatePayloadSha256,
    recordKind: ADJUDICATION_KIND,
    reportSha256: sha256Canonical(report),
    summary,
  };
}

export function validateCalibrationAdjudication(adjudication, report, review) {
  if (!schemaValidators.adjudication(adjudication))
    return validationResult(schemaErrors(schemaValidators.adjudication));
  let expected;
  try {
    expected = adjudicateCalibrationReview(report, review, adjudication.adjudicatedAt);
  } catch (error) {
    return validationResult([error instanceof Error ? error.message : "review is invalid"]);
  }
  return validationResult(
    canonicalJson(adjudication) === canonicalJson(expected)
      ? []
      : ["adjudication does not reconstruct from the bound maintainer review"],
  );
}
