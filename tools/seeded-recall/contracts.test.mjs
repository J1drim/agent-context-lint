import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RULE_FAMILY_DESCRIPTORS } from "../../packages/rules/dist/rule-scheduler.js";
import { RULE_REGISTRY } from "../../packages/rules/dist/registry.js";
import {
  adjudicateSeededRecallReviews,
  computeRecallRunSha256,
  computeRecallReportSha256,
  createSeededRecallReview,
  computeSeededRecallDiagnosticSha256,
  sha256Canonical,
  validateSeededRecallCorpus,
  validateSeededRecallAdjudication,
  validateSeededRecallReport,
  validateSeededRecallReview,
} from "./contracts.mjs";
import {
  createLabelWorksheet,
  createReviewFromWorksheet,
  readBoundedJson,
  runReviewerCli,
} from "./reviewer.mjs";

const familyByRule = new Map(
  RULE_FAMILY_DESCRIPTORS.flatMap((family) =>
    family.ruleIds.map((ruleId) => [ruleId, family.familyId]),
  ),
);

function corpus() {
  return {
    cases: RULE_REGISTRY.rules.map((rule, index) => ({
      caseId: `seed-${rule.id.toLowerCase()}`,
      defaultSeverity: rule.defaultSeverity,
      expectedDisposition: "visible",
      expectedDiagnosticSha256: computeSeededRecallDiagnosticSha256(
        rule.id,
        index.toString(16).padStart(64, "0"),
        (index + 100).toString(16).padStart(64, "0"),
      ),
      expectedRuleId: rule.id,
      familyId: familyByRule.get(rule.id),
      scenarioId: `scenario-${rule.id.toLowerCase()}`,
      syntheticEvidence: true,
    })),
    contractVersion: "0.1.0",
    recordKind: "agent-context-seeded-recall-corpus",
    registryVersion: "0.1.0",
    schedulerVersion: "0.1.0",
    sourcePolicy: {
      externalRepositoryContent: false,
      kind: "repository-owned-synthetic-only",
    },
  };
}

function report(value = corpus()) {
  const output = {
    cases: value.cases.map((entry, index) => ({
      caseId: entry.caseId,
      detected: true,
      diagnostic: {
        path: index.toString(16).padStart(64, "0"),
        semantic: (index + 100).toString(16).padStart(64, "0"),
        severity: entry.defaultSeverity,
      },
      disposition: "visible",
      expectedRuleId: entry.expectedRuleId,
      familyId: entry.familyId,
      scenarioId: entry.scenarioId,
    })),
    contractVersion: "0.1.0",
    corpusSha256: sha256Canonical(value),
    recordKind: "agent-context-seeded-recall-report",
    runSha256: "0".repeat(64),
    schedulerVersion: "0.1.0",
    summary: {
      detectedCases: 69,
      missedCases: 0,
      recallBasisPoints: 10_000,
      supportedCases: 69,
    },
  };
  output.runSha256 = computeRecallRunSha256(output);
  return output;
}

function labels(value, label = "true-positive") {
  const reasons = {
    "false-positive": "expected-seed-not-proved",
    "test-harness-defect": "fixture-contract-defect",
    "true-positive": "documented-behavior-confirmed",
    "uncertain-client-behavior": "undocumented-or-version-dependent",
  };
  return value.cases.map((entry) => ({
    caseId: entry.caseId,
    label,
    reason: reasons[label],
  }));
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("validates the exact complete 69-rule corpus and deterministic recall report", () => {
  const value = corpus();
  const output = report(value);
  assert.deepEqual(validateSeededRecallCorpus(value), { errors: [], valid: true });
  assert.deepEqual(validateSeededRecallReport(output, value), { errors: [], valid: true });
  assert.equal(computeRecallRunSha256(output), output.runSha256);
  assert.equal(
    computeRecallReportSha256(output),
    computeRecallReportSha256(structuredClone(output)),
  );
});

test("rejects omitted, duplicated, reordered, cross-family, severity-drifted, and stale reports", () => {
  const variants = [];
  const omitted = corpus();
  omitted.cases.pop();
  variants.push(omitted);
  const duplicated = corpus();
  duplicated.cases[1] = structuredClone(duplicated.cases[0]);
  variants.push(duplicated);
  const reordered = corpus();
  [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1], reordered.cases[0]];
  variants.push(reordered);
  const family = corpus();
  family.cases[0].familyId = "security";
  variants.push(family);
  const severity = corpus();
  severity.cases[0].defaultSeverity = "info";
  variants.push(severity);
  for (const value of variants) assert.equal(validateSeededRecallCorpus(value).valid, false);

  const value = corpus();
  const stale = report(value);
  stale.cases[0].detected = false;
  assert.equal(validateSeededRecallReport(stale, value).valid, false);
});

test("creates fingerprint-only reviews and requires independent primary reviewers", () => {
  const output = report();
  const first = createSeededRecallReview(output, "reviewer-a", "primary", labels(output));
  const second = createSeededRecallReview(output, "reviewer-b", "primary", labels(output));
  assert.deepEqual(validateSeededRecallReview(first, output), { errors: [], valid: true });
  assert.equal(JSON.stringify(first).includes("source text"), false);
  const adjudicated = adjudicateSeededRecallReviews(output, first, second);
  assert.deepEqual(adjudicated.summary, {
    agreementCount: 69,
    resolvedCount: 69,
    thirdReviewCount: 0,
    unresolvedCount: 0,
  });
  assert.throws(() => adjudicateSeededRecallReviews(output, first, first), /distinct/u);
});

test("uses an independent third review only for disagreements and preserves unresolved labels", () => {
  const output = report();
  const first = createSeededRecallReview(output, "reviewer-a", "primary", labels(output));
  const changed = labels(output);
  changed[0] = {
    caseId: output.cases[0].caseId,
    label: "test-harness-defect",
    reason: "fixture-contract-defect",
  };
  const second = createSeededRecallReview(output, "reviewer-b", "primary", changed);
  const unresolved = adjudicateSeededRecallReviews(output, first, second);
  assert.equal(unresolved.summary.unresolvedCount, 1);
  assert.equal(unresolved.decisions[0].label, null);
  const third = createSeededRecallReview(output, "reviewer-c", "tie-breaker", labels(output));
  const resolved = adjudicateSeededRecallReviews(output, first, second, third);
  assert.equal(resolved.summary.thirdReviewCount, 1);
  assert.equal(resolved.decisions[0].label, "true-positive");
});

test("semantically validates persisted adjudications against report and reviewer evidence", () => {
  const output = report();
  const first = createSeededRecallReview(output, "reviewer-a", "primary", labels(output));
  const changed = labels(output);
  changed[0] = {
    caseId: output.cases[0].caseId,
    label: "test-harness-defect",
    reason: "fixture-contract-defect",
  };
  const second = createSeededRecallReview(output, "reviewer-b", "primary", changed);
  const third = createSeededRecallReview(output, "reviewer-c", "tie-breaker", labels(output));
  const adjudication = adjudicateSeededRecallReviews(output, first, second, third);
  assert.deepEqual(validateSeededRecallAdjudication(adjudication, output, first, second, third), {
    errors: [],
    valid: true,
  });
  const variants = [];
  const stale = structuredClone(adjudication);
  stale.reportSha256 = "f".repeat(64);
  variants.push(stale);
  const reordered = structuredClone(adjudication);
  [reordered.decisions[0], reordered.decisions[1]] = [
    reordered.decisions[1],
    reordered.decisions[0],
  ];
  variants.push(reordered);
  const duplicated = structuredClone(adjudication);
  duplicated.decisions[1] = structuredClone(duplicated.decisions[0]);
  variants.push(duplicated);
  const inconsistent = structuredClone(adjudication);
  inconsistent.decisions[0].resolution = "unresolved";
  variants.push(inconsistent);
  const summary = structuredClone(adjudication);
  summary.summary.agreementCount += 1;
  variants.push(summary);
  const reviewers = structuredClone(adjudication);
  reviewers.primaryReviewerIds = ["reviewer-b", "reviewer-a"];
  variants.push(reviewers);
  const tieBreaker = structuredClone(adjudication);
  tieBreaker.tieBreakerReviewerId = "reviewer-a";
  variants.push(tieBreaker);
  for (const value of variants)
    assert.equal(
      validateSeededRecallAdjudication(value, output, first, second, third).valid,
      false,
    );
});

test("worksheet conversion rejects prototype, extra-field, wrong-fingerprint, and incomplete labels", () => {
  const output = report();
  const worksheet = structuredClone(createLabelWorksheet(output));
  for (const entry of worksheet.cases) {
    entry.label = "true-positive";
    entry.reason = "documented-behavior-confirmed";
  }
  assert.equal(
    createReviewFromWorksheet(output, worksheet, "reviewer-a", "primary").labels.length,
    69,
  );
  const extra = structuredClone(worksheet);
  extra.cases[0].sourceText = "must never be accepted";
  assert.throws(
    () => createReviewFromWorksheet(output, extra, "reviewer-a", "primary"),
    /incomplete or mismatched/u,
  );
  const wrong = structuredClone(worksheet);
  wrong.cases[0].pathFingerprint = "f".repeat(64);
  assert.throws(
    () => createReviewFromWorksheet(output, wrong, "reviewer-a", "primary"),
    /incomplete or mismatched/u,
  );
  const inherited = Object.create({ sourceText: "hidden" });
  Object.assign(inherited, worksheet.cases[0]);
  const hostile = structuredClone(worksheet);
  hostile.cases[0] = inherited;
  assert.throws(
    () => createReviewFromWorksheet(output, hostile, "reviewer-a", "primary"),
    /incomplete or mismatched/u,
  );
});

test("bounded reader and CLI validate only root-jailed ordinary JSON files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "seeded-recall-review-"));
  const outside = mkdtempSync(path.join(tmpdir(), "seeded-recall-outside-"));
  mkdirSync(path.join(root, "data"));
  const value = corpus();
  const output = report(value);
  writeFileSync(path.join(root, "data/corpus.json"), jsonText(value));
  writeFileSync(path.join(root, "data/report.json"), jsonText(output));
  writeFileSync(path.join(root, "data/malformed.json"), Buffer.from([0xff]));
  const first = createSeededRecallReview(output, "reviewer-a", "primary", labels(output));
  const second = createSeededRecallReview(output, "reviewer-b", "primary", labels(output));
  const adjudication = adjudicateSeededRecallReviews(output, first, second);
  writeFileSync(path.join(root, "data/first.json"), jsonText(first));
  writeFileSync(path.join(root, "data/second.json"), jsonText(second));
  writeFileSync(path.join(root, "data/adjudication.json"), jsonText(adjudication));
  writeFileSync(path.join(outside, "report.json"), jsonText(output));
  symlinkSync(outside, path.join(root, "escaped"));
  assert.deepEqual(await readBoundedJson(root, "data/corpus.json"), value);
  await assert.rejects(() => readBoundedJson(root, "../outside.json"), /canonical/u);
  await assert.rejects(() => readBoundedJson(root, "/tmp/outside.json"), /canonical/u);
  await assert.rejects(() => readBoundedJson(root, "escaped/report.json"), /outside|symlink/u);
  await assert.rejects(() => readBoundedJson(root, "data/malformed.json"), /UTF-8 JSON/u);
  writeFileSync(
    path.join(root, "data/duplicate.json"),
    '{\n  "outer": {\n    "value": 1,\n    "value": 2\n  }\n}\n',
  );
  await assert.rejects(
    () => readBoundedJson(root, "data/duplicate.json"),
    /duplicate object keys/u,
  );
  writeFileSync(path.join(root, "data/non-normalized.json"), '{"value":1}\n');
  await assert.rejects(
    () => readBoundedJson(root, "data/non-normalized.json"),
    /normalized pretty JSON/u,
  );
  const deeplyNested = jsonText(JSON.parse(`${"[".repeat(66)}0${"]".repeat(66)}`));
  writeFileSync(path.join(root, "data/deep.json"), deeplyNested);
  await assert.rejects(() => readBoundedJson(root, "data/deep.json"), /depth or value limit/u);
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  try {
    await runReviewerCli(["validate", "data/corpus.json", "data/report.json"], {
      repositoryRoot: root,
    });
    await runReviewerCli(
      [
        "validate-adjudication",
        "data/corpus.json",
        "data/report.json",
        "data/adjudication.json",
        "data/first.json",
        "data/second.json",
      ],
      { repositoryRoot: root },
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(
    stdout,
    "Seeded recall artifacts are valid.\nSeeded recall adjudication is valid.\n",
  );
  await assert.rejects(
    () =>
      runReviewerCli(
        ["worksheet", "data/corpus.json", "data/report.json", "--write", "data/existing.json"],
        { repositoryRoot: root },
      ),
    /Usage/u,
  );
  const stale = report(value);
  stale.cases[0].disposition = "suppressed";
  stale.runSha256 = computeRecallRunSha256(stale);
  writeFileSync(path.join(root, "data/stale-report.json"), jsonText(stale));
  await assert.rejects(
    () =>
      runReviewerCli(["worksheet", "data/corpus.json", "data/stale-report.json"], {
        repositoryRoot: root,
      }),
    /allowed values|inconsistent detection evidence/u,
  );
});
