#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeRepositoryRelativePath } from "../../packages/core/dist/index.js";
import {
  createReadOnlyRepository,
  selectRepositoryRoot,
} from "../../packages/evidence/dist/index.js";

import {
  SEEDED_RECALL_MAX_FILE_BYTES,
  SEEDED_RECALL_REPORT_KIND,
  SEEDED_RECALL_SUPPORTED_CASES,
  adjudicateSeededRecallReviews,
  computeRecallReportSha256,
  createSeededRecallReview,
  validateSeededRecallCorpus,
  validateSeededRecallAdjudication,
  validateSeededRecallReport,
  validateSeededRecallReview,
} from "./contracts.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const LABELS = new Set([
  "false-positive",
  "test-harness-defect",
  "true-positive",
  "uncertain-client-behavior",
]);
const REASONS = new Set([
  "documented-behavior-confirmed",
  "expected-seed-not-proved",
  "fixture-contract-defect",
  "undocumented-or-version-dependent",
]);
const MAX_JSON_DEPTH = 64;
const MAX_JSON_VALUES = 100_000;

function canonicalRepositoryPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== "." &&
    !value.startsWith("../")
  );
}

export async function readBoundedJson(repositoryRoot, repositoryPath) {
  if (!canonicalRepositoryPath(repositoryPath))
    throw new Error("input path must be canonical and repository-relative");
  const selection = await selectRepositoryRoot(repositoryRoot, { mode: "explicit" });
  const repository = await createReadOnlyRepository(selection, {
    maximumDurationMs: 5_000,
    maximumEntries: 8,
    maximumFileBytes: SEEDED_RECALL_MAX_FILE_BYTES,
    maximumMetadataOperations: 256,
    maximumSymlinkDepth: 8,
    maximumTotalBytes: SEEDED_RECALL_MAX_FILE_BYTES,
    maximumTraversalDepth: 64,
  });
  const file = await repository.readFile(canonicalizeRepositoryRelativePath(repositoryPath));
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes());
  } catch {
    throw new Error("input must contain valid UTF-8 JSON");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("input must contain valid UTF-8 JSON");
  }
  const pending = [{ depth: 0, value }];
  let values = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    values += 1;
    if (values > MAX_JSON_VALUES || current.depth > MAX_JSON_DEPTH)
      throw new Error("input JSON exceeds the depth or value limit");
    if (Array.isArray(current.value))
      for (const entry of current.value) pending.push({ depth: current.depth + 1, value: entry });
    else if (current.value !== null && typeof current.value === "object")
      for (const entry of Object.values(current.value))
        pending.push({ depth: current.depth + 1, value: entry });
  }
  if (`${JSON.stringify(value, null, 2)}\n` !== text)
    throw new Error("input must use normalized pretty JSON without duplicate object keys");
  return value;
}

export function createLabelWorksheet(report) {
  if (
    report?.recordKind !== SEEDED_RECALL_REPORT_KIND ||
    report.cases?.length !== SEEDED_RECALL_SUPPORTED_CASES
  )
    throw new Error("a complete seeded-recall report is required");
  if (report.cases.some((entry) => entry.diagnostic === null))
    throw new Error("cannot review a report containing missed cases without fingerprints");
  return Object.freeze({
    cases: Object.freeze(
      report.cases.map((entry) =>
        Object.freeze({
          caseId: entry.caseId,
          label: null,
          pathFingerprint: entry.diagnostic.path,
          reason: null,
          ruleId: entry.expectedRuleId,
          semanticFingerprint: entry.diagnostic.semantic,
        }),
      ),
    ),
    recordKind: "agent-context-seeded-recall-label-worksheet",
    reportSha256: computeRecallReportSha256(report),
  });
}

function labelsFromWorksheet(worksheet, report) {
  if (
    worksheet === null ||
    typeof worksheet !== "object" ||
    Array.isArray(worksheet) ||
    Object.getPrototypeOf(worksheet) !== Object.prototype ||
    Object.keys(worksheet).sort().join("\0") !== "cases\0recordKind\0reportSha256" ||
    worksheet.recordKind !== "agent-context-seeded-recall-label-worksheet" ||
    worksheet.reportSha256 !== computeRecallReportSha256(report) ||
    !Array.isArray(worksheet.cases) ||
    worksheet.cases.length !== SEEDED_RECALL_SUPPORTED_CASES
  )
    throw new Error("label worksheet has an invalid closed contract");
  return worksheet.cases.map((entry, index) => {
    const expected = report.cases[index];
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      Object.keys(entry).sort().join("\0") !==
        "caseId\0label\0pathFingerprint\0reason\0ruleId\0semanticFingerprint" ||
      entry.caseId !== expected?.caseId ||
      entry.ruleId !== expected?.expectedRuleId ||
      entry.pathFingerprint !== expected?.diagnostic?.path ||
      entry.semanticFingerprint !== expected?.diagnostic?.semantic ||
      !LABELS.has(entry.label) ||
      !REASONS.has(entry.reason)
    )
      throw new Error(`label worksheet case ${String(index)} is incomplete or mismatched`);
    return { caseId: entry.caseId, label: entry.label, reason: entry.reason };
  });
}

export function createReviewFromWorksheet(report, worksheet, reviewerId, role) {
  return createSeededRecallReview(report, reviewerId, role, labelsFromWorksheet(worksheet, report));
}

export function serializeReviewArtifact(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function usage() {
  return [
    "Usage:",
    "  node tools/seeded-recall/reviewer.mjs validate <corpus.json> <report.json> [review.json]",
    "  node tools/seeded-recall/reviewer.mjs validate-adjudication <corpus.json> <report.json> <adjudication.json> <first.json> <second.json> [third.json]",
    "  node tools/seeded-recall/reviewer.mjs worksheet <corpus.json> <report.json>",
    "  node tools/seeded-recall/reviewer.mjs review <corpus.json> <report.json> <worksheet.json> <reviewer-id> <primary|tie-breaker>",
    "  node tools/seeded-recall/reviewer.mjs adjudicate <corpus.json> <report.json> <first.json> <second.json> [third.json]",
  ].join("\n");
}

function validateCompleteReport(corpus, report) {
  const checked = validateSeededRecallReport(report, corpus);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
}

export async function runReviewerCli(arguments_, { repositoryRoot = DEFAULT_ROOT } = {}) {
  const [command, ...rest] = arguments_;
  if (command === "validate") {
    if (rest.length < 2 || rest.length > 3) throw new Error(usage());
    const corpus = await readBoundedJson(repositoryRoot, rest[0]);
    const report = await readBoundedJson(repositoryRoot, rest[1]);
    const corpusResult = validateSeededRecallCorpus(corpus);
    const reportResult = validateSeededRecallReport(report, corpus);
    const errors = [...corpusResult.errors, ...reportResult.errors];
    if (rest[2] !== undefined) {
      const review = await readBoundedJson(repositoryRoot, rest[2]);
      errors.push(...validateSeededRecallReview(review, report).errors);
    }
    if (errors.length > 0) throw new Error(errors.join("\n"));
    process.stdout.write("Seeded recall artifacts are valid.\n");
    return;
  }
  if (command === "worksheet") {
    if (rest.length !== 2) throw new Error(usage());
    const corpus = await readBoundedJson(repositoryRoot, rest[0]);
    const report = await readBoundedJson(repositoryRoot, rest[1]);
    validateCompleteReport(corpus, report);
    process.stdout.write(serializeReviewArtifact(createLabelWorksheet(report)));
    return;
  }
  if (command === "validate-adjudication") {
    if (rest.length < 5 || rest.length > 6) throw new Error(usage());
    const corpus = await readBoundedJson(repositoryRoot, rest[0]);
    const report = await readBoundedJson(repositoryRoot, rest[1]);
    validateCompleteReport(corpus, report);
    const adjudication = await readBoundedJson(repositoryRoot, rest[2]);
    const first = await readBoundedJson(repositoryRoot, rest[3]);
    const second = await readBoundedJson(repositoryRoot, rest[4]);
    const third = rest[5] === undefined ? null : await readBoundedJson(repositoryRoot, rest[5]);
    const checked = validateSeededRecallAdjudication(adjudication, report, first, second, third);
    if (!checked.valid) throw new Error(checked.errors.join("\n"));
    process.stdout.write("Seeded recall adjudication is valid.\n");
    return;
  }
  if (command === "review") {
    if (rest.length !== 5) throw new Error(usage());
    const corpus = await readBoundedJson(repositoryRoot, rest[0]);
    const report = await readBoundedJson(repositoryRoot, rest[1]);
    validateCompleteReport(corpus, report);
    const worksheet = await readBoundedJson(repositoryRoot, rest[2]);
    process.stdout.write(
      serializeReviewArtifact(createReviewFromWorksheet(report, worksheet, rest[3], rest[4])),
    );
    return;
  }
  if (command === "adjudicate") {
    if (rest.length < 4 || rest.length > 5) throw new Error(usage());
    const corpus = await readBoundedJson(repositoryRoot, rest[0]);
    const report = await readBoundedJson(repositoryRoot, rest[1]);
    validateCompleteReport(corpus, report);
    const first = await readBoundedJson(repositoryRoot, rest[2]);
    const second = await readBoundedJson(repositoryRoot, rest[3]);
    const third = rest[4] === undefined ? null : await readBoundedJson(repositoryRoot, rest[4]);
    process.stdout.write(
      serializeReviewArtifact(adjudicateSeededRecallReviews(report, first, second, third)),
    );
    return;
  }
  throw new Error(usage());
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runReviewerCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "reviewer failed"}\n`);
    process.exitCode = 1;
  }
}

export const _test = Object.freeze({ canonicalRepositoryPath, labelsFromWorksheet });
