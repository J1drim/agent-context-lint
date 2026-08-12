import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RULE_FAMILY_DESCRIPTORS,
  RULE_SCHEDULER_CONTRACT_VERSION,
} from "../../packages/rules/dist/rule-scheduler.js";
import { RULE_REGISTRY, RULE_REGISTRY_VERSION } from "../../packages/rules/dist/registry.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;

export const SEEDED_RECALL_CONTRACT_VERSION = "0.1.0";
export const SEEDED_RECALL_CORPUS_KIND = "agent-context-seeded-recall-corpus";
export const SEEDED_RECALL_REPORT_KIND = "agent-context-seeded-recall-report";
export const SEEDED_RECALL_REVIEW_KIND = "agent-context-seeded-recall-review";
export const SEEDED_RECALL_ADJUDICATION_KIND = "agent-context-seeded-recall-adjudication";
export const SEEDED_RECALL_SUPPORTED_CASES = 69;
export const SEEDED_RECALL_MAX_FILE_BYTES = 4 * 1024 * 1024;

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const SCHEMA_DIRECTORY = path.join(REPOSITORY_ROOT, "calibration/schemas");
const LABEL_REASON = Object.freeze({
  "false-positive": "expected-seed-not-proved",
  "test-harness-defect": "fixture-contract-defect",
  "true-positive": "documented-behavior-confirmed",
  "uncertain-client-behavior": "undocumented-or-version-dependent",
});

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
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function schema(name) {
  return JSON.parse(readFileSync(path.join(SCHEMA_DIRECTORY, name), "utf8"));
}

function validator(name) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema(name));
}

const validateCorpusSchema = validator("seeded-recall-corpus.v0.schema.json");
const validateReportSchema = validator("seeded-recall-report.v0.schema.json");
const validateAdjudicationSchema = validator("seeded-recall-adjudication.v0.schema.json");

function schemaErrors(validate) {
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`,
  );
}

function result(errors) {
  return Object.freeze({ errors: Object.freeze(errors), valid: errors.length === 0 });
}

function exactRuleFamilyMap() {
  return new Map(
    RULE_FAMILY_DESCRIPTORS.flatMap((family) =>
      family.ruleIds.map((ruleId) => [ruleId, family.familyId]),
    ),
  );
}

export function validateSeededRecallCorpus(corpus) {
  const errors = [];
  if (!validateCorpusSchema(corpus)) return result(schemaErrors(validateCorpusSchema));
  const expectedRules = RULE_REGISTRY.rules;
  const familyByRule = exactRuleFamilyMap();
  const seenCases = new Set();
  const seenRules = new Set();
  for (const [index, entry] of corpus.cases.entries()) {
    const expected = expectedRules[index];
    if (entry.caseId !== `seed-${entry.expectedRuleId.toLowerCase()}`)
      errors.push(`$.cases[${String(index)}].caseId must be derived from expectedRuleId`);
    if (seenCases.has(entry.caseId)) errors.push(`$.cases[${String(index)}].caseId is duplicated`);
    if (seenRules.has(entry.expectedRuleId))
      errors.push(`$.cases[${String(index)}].expectedRuleId is duplicated`);
    seenCases.add(entry.caseId);
    seenRules.add(entry.expectedRuleId);
    if (expected === undefined || entry.expectedRuleId !== expected.id)
      errors.push(`$.cases[${String(index)}].expectedRuleId must follow RULE_REGISTRY order`);
    if (expected !== undefined && entry.defaultSeverity !== expected.defaultSeverity)
      errors.push(`$.cases[${String(index)}].defaultSeverity differs from RULE_REGISTRY`);
    if (entry.familyId !== familyByRule.get(entry.expectedRuleId))
      errors.push(`$.cases[${String(index)}].familyId differs from the F15 dependency graph`);
  }
  if (seenRules.size !== SEEDED_RECALL_SUPPORTED_CASES)
    errors.push("$.cases must contain one unique case for every supported rule");
  return result(errors);
}

export function computeRecallRunSha256(report) {
  return sha256Canonical({
    cases: report.cases,
    corpusSha256: report.corpusSha256,
    schedulerVersion: report.schedulerVersion,
  });
}

export function computeSeededRecallDiagnosticSha256(ruleId, pathFingerprint, semanticFingerprint) {
  return sha256Canonical({ path: pathFingerprint, ruleId, semantic: semanticFingerprint });
}

export function computeRecallReportSha256(report) {
  return sha256Canonical(report);
}

export function validateSeededRecallReport(report, corpus) {
  const errors = [];
  const corpusValidation = validateSeededRecallCorpus(corpus);
  if (!corpusValidation.valid)
    errors.push(...corpusValidation.errors.map((entry) => `corpus: ${entry}`));
  if (!validateReportSchema(report))
    return result([...errors, ...schemaErrors(validateReportSchema)]);
  const expectedCorpusSha256 = sha256Canonical(corpus);
  if (report.corpusSha256 !== expectedCorpusSha256)
    errors.push("$.corpusSha256 does not bind the canonical corpus");
  if (report.runSha256 !== computeRecallRunSha256(report))
    errors.push("$.runSha256 does not bind the deterministic scheduler results");
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
      errors.push(`$.cases[${String(index)}] does not match the corpus case identity`);
    if (entry.detected) {
      detected += 1;
      if (entry.diagnostic === null || entry.disposition !== "visible")
        errors.push(`$.cases[${String(index)}] has inconsistent detection evidence`);
      if (
        entry.diagnostic !== null &&
        expected !== undefined &&
        entry.diagnostic.severity !== expected.defaultSeverity
      )
        errors.push(`$.cases[${String(index)}].diagnostic.severity differs from registry policy`);
      if (
        entry.diagnostic !== null &&
        expected !== undefined &&
        computeSeededRecallDiagnosticSha256(
          entry.expectedRuleId,
          entry.diagnostic.path,
          entry.diagnostic.semantic,
        ) !== expected.expectedDiagnosticSha256
      )
        errors.push(
          `$.cases[${String(index)}].diagnostic does not match the intended seed identity`,
        );
    } else if (entry.diagnostic !== null || entry.disposition !== "missed") {
      errors.push(`$.cases[${String(index)}] has evidence for a missed case`);
    }
  }
  const missed = SEEDED_RECALL_SUPPORTED_CASES - detected;
  const recallBasisPoints = Math.floor((detected * 10_000) / SEEDED_RECALL_SUPPORTED_CASES);
  if (
    report.summary.detectedCases !== detected ||
    report.summary.missedCases !== missed ||
    report.summary.recallBasisPoints !== recallBasisPoints
  )
    errors.push("$.summary does not reconstruct from case results");
  return result(errors);
}

function reviewKey(entry) {
  return `${entry.caseId}\u0000${entry.ruleId}\u0000${entry.pathFingerprint}\u0000${entry.semanticFingerprint}`;
}

function expectedReviewEntries(report) {
  return report.cases.map((entry) => ({
    caseId: entry.caseId,
    pathFingerprint: entry.diagnostic?.path ?? null,
    ruleId: entry.expectedRuleId,
    semanticFingerprint: entry.diagnostic?.semantic ?? null,
  }));
}

export function validateSeededRecallReview(review, report, { requirePrimary = false } = {}) {
  const errors = [];
  if (!validateAdjudicationSchema(review)) return result(schemaErrors(validateAdjudicationSchema));
  if (review.recordKind !== SEEDED_RECALL_REVIEW_KIND)
    return result([`$.recordKind must equal ${SEEDED_RECALL_REVIEW_KIND}`]);
  if (requirePrimary && review.role !== "primary") errors.push("$.role must be primary");
  if (review.reportSha256 !== computeRecallReportSha256(report))
    errors.push("$.reportSha256 does not bind the canonical recall report");
  const expected = expectedReviewEntries(report);
  const seen = new Set();
  for (const [index, entry] of review.labels.entries()) {
    const target = expected[index];
    if (
      target === undefined ||
      entry.caseId !== target.caseId ||
      entry.ruleId !== target.ruleId ||
      entry.pathFingerprint !== target.pathFingerprint ||
      entry.semanticFingerprint !== target.semanticFingerprint
    )
      errors.push(`$.labels[${String(index)}] does not match the report fingerprint identity`);
    const key = reviewKey(entry);
    if (seen.has(key)) errors.push(`$.labels[${String(index)}] duplicates a fingerprint label`);
    seen.add(key);
    if (LABEL_REASON[entry.label] !== entry.reason)
      errors.push(`$.labels[${String(index)}].reason does not match its closed label reason`);
  }
  return result(errors);
}

export function validateSeededRecallAdjudication(
  adjudication,
  report,
  first,
  second,
  tieBreaker = null,
) {
  const errors = [];
  if (!validateAdjudicationSchema(adjudication))
    return result(schemaErrors(validateAdjudicationSchema));
  if (adjudication.recordKind !== SEEDED_RECALL_ADJUDICATION_KIND)
    return result([`$.recordKind must equal ${SEEDED_RECALL_ADJUDICATION_KIND}`]);
  if (adjudication.reportSha256 !== computeRecallReportSha256(report))
    errors.push("$.reportSha256 does not bind the canonical recall report");
  let expected;
  try {
    expected = adjudicateSeededRecallReviews(report, first, second, tieBreaker);
  } catch (error) {
    errors.push(`reviews: ${error instanceof Error ? error.message : "review set is invalid"}`);
    return result(errors);
  }
  if (canonicalJson(adjudication.decisions) !== canonicalJson(expected.decisions))
    errors.push("$.decisions do not reconstruct from the bound reviews");
  if (canonicalJson(adjudication.summary) !== canonicalJson(expected.summary))
    errors.push("$.summary does not reconstruct from the decisions");
  if (canonicalJson(adjudication.primaryReviewerIds) !== canonicalJson(expected.primaryReviewerIds))
    errors.push("$.primaryReviewerIds do not match the distinct sorted primary reviewers");
  if (adjudication.tieBreakerReviewerId !== expected.tieBreakerReviewerId)
    errors.push("$.tieBreakerReviewerId does not match the independent third-review usage");
  return result(errors);
}

export function createSeededRecallReview(report, reviewerId, role, labels) {
  const entries = expectedReviewEntries(report);
  const byCase = new Map(labels.map((entry) => [entry.caseId, entry]));
  const review = {
    contractVersion: SEEDED_RECALL_CONTRACT_VERSION,
    labels: entries.map((entry) => {
      const supplied = byCase.get(entry.caseId);
      if (supplied === undefined) throw new Error(`missing label for ${entry.caseId}`);
      if (entry.pathFingerprint === null || entry.semanticFingerprint === null)
        throw new Error(`cannot review missed case ${entry.caseId} without a fingerprint`);
      return {
        caseId: entry.caseId,
        label: supplied.label,
        pathFingerprint: entry.pathFingerprint,
        reason: supplied.reason,
        ruleId: entry.ruleId,
        semanticFingerprint: entry.semanticFingerprint,
      };
    }),
    recordKind: SEEDED_RECALL_REVIEW_KIND,
    reportSha256: computeRecallReportSha256(report),
    reviewerId,
    role,
  };
  const checked = validateSeededRecallReview(review, report);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
  return Object.freeze(review);
}

export function adjudicateSeededRecallReviews(report, first, second, tieBreaker = null) {
  for (const review of [first, second]) {
    const checked = validateSeededRecallReview(review, report, { requirePrimary: true });
    if (!checked.valid) throw new Error(checked.errors.join("\n"));
  }
  if (first.reviewerId === second.reviewerId)
    throw new Error("primary reviews must come from distinct reviewers");
  if (tieBreaker !== null) {
    const checked = validateSeededRecallReview(tieBreaker, report);
    if (!checked.valid || tieBreaker.role !== "tie-breaker")
      throw new Error(
        checked.valid ? "third review must have the tie-breaker role" : checked.errors.join("\n"),
      );
    if ([first.reviewerId, second.reviewerId].includes(tieBreaker.reviewerId))
      throw new Error("tie-breaker reviewer must be independent");
  }
  let agreementCount = 0;
  let thirdReviewCount = 0;
  let unresolvedCount = 0;
  const decisions = first.labels.map((left, index) => {
    const right = second.labels[index];
    if (right === undefined || reviewKey(left) !== reviewKey(right))
      throw new Error("primary review inventories differ");
    let chosen = left;
    let resolution = "agreement";
    if (left.label === right.label && left.reason === right.reason) agreementCount += 1;
    else {
      const third = tieBreaker?.labels[index];
      if (third === undefined || reviewKey(left) !== reviewKey(third)) {
        unresolvedCount += 1;
        resolution = "unresolved";
        chosen = null;
      } else {
        thirdReviewCount += 1;
        resolution = "third-review";
        chosen = third;
      }
    }
    return {
      caseId: left.caseId,
      label: chosen?.label ?? null,
      pathFingerprint: left.pathFingerprint,
      reason: chosen?.reason ?? null,
      resolution,
      ruleId: left.ruleId,
      semanticFingerprint: left.semanticFingerprint,
    };
  });
  const adjudication = {
    contractVersion: SEEDED_RECALL_CONTRACT_VERSION,
    decisions,
    primaryReviewerIds: [first.reviewerId, second.reviewerId].sort(compareUtf8),
    recordKind: SEEDED_RECALL_ADJUDICATION_KIND,
    reportSha256: computeRecallReportSha256(report),
    summary: {
      agreementCount,
      resolvedCount: decisions.length - unresolvedCount,
      thirdReviewCount,
      unresolvedCount,
    },
    tieBreakerReviewerId: thirdReviewCount > 0 ? (tieBreaker?.reviewerId ?? null) : null,
  };
  if (!validateAdjudicationSchema(adjudication))
    throw new Error(schemaErrors(validateAdjudicationSchema).join("\n"));
  return Object.freeze(adjudication);
}

export function contractVersions() {
  return Object.freeze({
    corpus: SEEDED_RECALL_CONTRACT_VERSION,
    registry: RULE_REGISTRY_VERSION,
    scheduler: RULE_SCHEDULER_CONTRACT_VERSION,
  });
}
