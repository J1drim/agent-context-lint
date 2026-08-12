import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adjudicateCalibrationReview,
  computeCalibrationDiagnosticFingerprint,
  createCalibrationReview,
  createCalibrationWorksheet,
  sha256Canonical,
} from "./contracts.mjs";
import {
  FROZEN_CANDIDATE_BYTES_SHA256,
  FROZEN_CORPUS_BYTES_SHA256,
  FROZEN_SEEDED_RECALL_CORPUS_BYTES_SHA256,
  FROZEN_SEEDED_RECALL_REPORT_BYTES_SHA256,
  createPrecisionEvidence,
  validateBoundSeededRecall,
  validateFrozenCalibrationFrameBytes,
  validateFrozenSeededRecallBytes,
  validatePrecisionEvidence,
} from "./precision.mjs";

async function fixture() {
  const candidateBytes = await readFile("calibration/metadata/v0/candidate-snapshot.json");
  const corpusBytes = await readFile("calibration/metadata/v0/corpus.json");
  const corpus = JSON.parse(corpusBytes.toString("utf8"));
  const seededRecallCorpusBytes = await readFile("calibration/seeded-recall/v0/corpus.json");
  const seededRecallReportBytes = await readFile("calibration/seeded-recall/v0/report.json");
  const seededRecallCorpus = JSON.parse(seededRecallCorpusBytes.toString("utf8"));
  const seededRecallReport = JSON.parse(seededRecallReportBytes.toString("utf8"));
  const diagnostics = Array.from({ length: 500 }, (_, index) => {
    const repository = corpus.repositories[index % corpus.repositories.length];
    const counter = index.toString(16).padStart(64, "0");
    const inverse = (1000 - index).toString(16).padStart(64, "0");
    const identity = {
      pathFingerprint: counter,
      repositoryId: repository.repositoryId,
      ruleId: index % 2 === 0 ? "ACL250" : "ACL301",
      semanticFingerprint: inverse,
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
  const report = {
    contractVersion: "0.1.0",
    corpusSha256: sha256Canonical(corpus),
    diagnostics,
    engine: {
      captureStartedAt: "2026-08-09T03:59:00.000Z",
      commitSha: "1".repeat(40),
      git: { sha256: "2".repeat(64), version: "git version 2.50.1" },
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
    },
    engineVersion: "1.0.0-rc.1",
    generatedAt: "2026-08-09T04:00:00.000Z",
    knowledgeVersion: "2026.08.0",
    privatePayloadSha256: "8".repeat(64),
    recordKind: "agent-context-metadata-calibration-report",
    sourcePolicy: { fingerprintOnly: true, repositoryContent: false, repositoryPaths: false },
  };
  const worksheet = () => {
    const value = createCalibrationWorksheet(report);
    value.labels = value.labels.map((entry) => ({
      ...entry,
      label: "true-positive",
      reason: "documented-behavior-confirmed",
    }));
    return value;
  };
  const maintainerReview = createCalibrationReview(
    report,
    worksheet(),
    "jakub-niezgoda",
    "2026-08-09T05:00:00.000Z",
  );
  const adjudication = adjudicateCalibrationReview(
    report,
    maintainerReview,
    "2026-08-09T05:01:00.000Z",
  );
  return {
    adjudication,
    candidateBytes,
    corpus,
    corpusBytes,
    maintainerReview,
    report,
    seededRecallCorpus,
    seededRecallCorpusBytes,
    seededRecallReport,
    seededRecallReportBytes,
  };
}

test("the immutable K02 selection bytes are pinned before K03 diagnostics", async () => {
  const values = await fixture();
  assert.deepEqual(validateFrozenCalibrationFrameBytes(values.candidateBytes, values.corpusBytes), {
    errors: [],
    valid: true,
  });
  assert.equal(
    FROZEN_CANDIDATE_BYTES_SHA256,
    "dfebdbb895f855e6705430d94553d77e0643cb8891b1cbab461219ddb827585b",
  );
  assert.equal(
    FROZEN_CORPUS_BYTES_SHA256,
    "3b5a95e1b659facad62003f9be0402f79a412cf6f31a1f7065e85dbdc9ab06b1",
  );
  assert.equal(
    FROZEN_SEEDED_RECALL_CORPUS_BYTES_SHA256,
    "d764ef6eb792d2480fea0202c9364a350511abf588b51b4ade5a0e59ead3896e",
  );
  assert.equal(
    FROZEN_SEEDED_RECALL_REPORT_BYTES_SHA256,
    "370fc6bbe68ad1b8f86bf7d520b4dd155f9fafd3ae55c43dddaae18ef48cd7e2",
  );
  assert.deepEqual(
    validateFrozenSeededRecallBytes(values.seededRecallCorpusBytes, values.seededRecallReportBytes),
    { errors: [], valid: true },
  );
  const changed = Buffer.concat([values.candidateBytes, Buffer.from(" ")]);
  assert.match(
    validateFrozenCalibrationFrameBytes(changed, values.corpusBytes).errors.join("\n"),
    /pre-diagnostic K02 freeze/,
  );
});

test("precision evidence gates on two-sided Wilson lower bounds and seeded recall", async () => {
  const values = await fixture();
  const dependencies = {
    ...values,
    engine: values.report.engine,
    generatedAt: "2026-08-09T06:00:00.000Z",
    tuningChanges: [],
  };
  const evidence = createPrecisionEvidence(dependencies);
  assert.equal(evidence.diagnosticCount, 500);
  assert.equal(evidence.resolvedDiagnosticCount, 500);
  assert.equal(evidence.precision.error.lowerWilsonBasisPoints, 9848);
  assert.equal(evidence.precision.warning.lowerWilsonBasisPoints, 9848);
  assert.equal(evidence.externalHoldout.releaseTrialRepositoryCount, 0);
  assert.equal(validatePrecisionEvidence(evidence, dependencies).valid, true);

  const tooSmall = { ...values.report, diagnostics: values.report.diagnostics.slice(0, 499) };
  assert.throws(
    () => createPrecisionEvidence({ ...dependencies, report: tooSmall }),
    /at least 500 diagnostics|does not bind/,
  );
  const incompleteRecall = structuredClone(values.seededRecallReport);
  incompleteRecall.summary.recallBasisPoints = 9999;
  assert.throws(
    () => createPrecisionEvidence({ ...dependencies, seededRecallReport: incompleteRecall }),
    /recall|summary/i,
  );

  const substitutedCorpus = structuredClone(values.corpus);
  [substitutedCorpus.repositories[0], substitutedCorpus.repositories[1]] = [
    substitutedCorpus.repositories[1],
    substitutedCorpus.repositories[0],
  ];
  assert.throws(
    () => createPrecisionEvidence({ ...dependencies, corpus: substitutedCorpus }),
    /immutable K02 corpus bytes/,
  );
  const substitutedRecall = structuredClone(values.seededRecallReport);
  substitutedRecall.generatedAt = "2026-08-09T05:00:00.000Z";
  assert.throws(
    () => createPrecisionEvidence({ ...dependencies, seededRecallReport: substitutedRecall }),
    /immutable F16 artifact bytes/,
  );

  const falsePositiveWorksheet = createCalibrationWorksheet(values.report);
  falsePositiveWorksheet.labels = falsePositiveWorksheet.labels.map((entry, index) => ({
    ...entry,
    label: index === 0 ? "false-positive" : "true-positive",
    reason: index === 0 ? "rule-threshold" : "documented-behavior-confirmed",
  }));
  const falseMaintainerReview = createCalibrationReview(
    values.report,
    falsePositiveWorksheet,
    "jakub-niezgoda",
    "2026-08-09T05:10:00.000Z",
  );
  const falseAdjudication = adjudicateCalibrationReview(
    values.report,
    falseMaintainerReview,
    "2026-08-09T05:11:00.000Z",
  );
  assert.throws(
    () =>
      createPrecisionEvidence({
        ...dependencies,
        adjudication: falseAdjudication,
        maintainerReview: falseMaintainerReview,
        tuningChanges: [
          {
            action: "rule-threshold-tightened",
            evidenceFingerprints: [falseAdjudication.decisions[0].diagnosticFingerprint],
            codeCommitSha: values.report.engine.commitSha,
            packageSha256: values.report.engine.packageSha256,
            preTuningAdjudicationSha256: sha256Canonical(falseAdjudication),
            preTuningReportSha256: sha256Canonical(values.report),
            regressionTests: [
              {
                path: "calibration/regressions/k03-wrong-rule.test.mjs",
                sha256: "9".repeat(64),
              },
            ],
            ruleId: falseAdjudication.decisions[0].ruleId === "ACL250" ? "ACL301" : "ACL250",
          },
        ],
      }),
    /distinct post-tuning scan/,
  );
});

test("precision evidence blocks harness defects and bounds uncertain dispositions", async () => {
  const values = await fixture();
  const disposition = (label, reason, count) => {
    const worksheet = createCalibrationWorksheet(values.report);
    worksheet.labels = worksheet.labels.map((entry, index) =>
      index < count
        ? { ...entry, label, reason }
        : { ...entry, label: "true-positive", reason: "documented-behavior-confirmed" },
    );
    const maintainerReview = createCalibrationReview(
      values.report,
      worksheet,
      "jakub-niezgoda",
      "2026-08-09T05:10:00.000Z",
    );
    const adjudication = adjudicateCalibrationReview(
      values.report,
      maintainerReview,
      "2026-08-09T05:11:00.000Z",
    );
    return {
      adjudication,
      maintainerReview,
    };
  };
  const dependencies = {
    ...values,
    engine: values.report.engine,
    generatedAt: "2026-08-09T06:00:00.000Z",
    tuningChanges: [],
  };
  assert.throws(
    () =>
      createPrecisionEvidence({
        ...dependencies,
        ...disposition("test-harness-defect", "fixture-or-scan-defect", 1),
      }),
    /capture repair and complete K03 recapture/u,
  );
  assert.throws(
    () =>
      createPrecisionEvidence({
        ...dependencies,
        ...disposition("uncertain-client-behavior", "profile-semantics-unknown", 26),
      }),
    /bounded K03 release policy/u,
  );
  const bounded = createPrecisionEvidence({
    ...dependencies,
    ...disposition("uncertain-client-behavior", "profile-semantics-unknown", 25),
  });
  assert.deepEqual(bounded.reviewDispositionPolicy, {
    maximumUncertainBasisPoints: 500,
    maximumUncertainCount: 25,
    testHarnessDefectCount: 0,
    testHarnessDefectsBlock: true,
    uncertainBasisPoints: 500,
    uncertainCount: 25,
  });
});

test("tuned precision lineage binds pre-tuning false positives to a distinct final engine", async () => {
  const values = await fixture();
  const preTuningEngine = {
    ...values.report.engine,
    captureStartedAt: "2026-08-09T01:00:00.000Z",
    commitSha: "a".repeat(40),
    packageSha256: "b".repeat(64),
    runtimeClosureSha256: "c".repeat(64),
  };
  const preTuningReport = {
    ...values.report,
    engine: preTuningEngine,
    engineVersion: preTuningEngine.version,
    generatedAt: "2026-08-09T02:00:00.000Z",
    knowledgeVersion: preTuningEngine.knowledgeVersion,
  };
  const worksheet = createCalibrationWorksheet(preTuningReport);
  worksheet.labels = worksheet.labels.map((entry, index) => ({
    ...entry,
    label: index === 0 ? "false-positive" : "true-positive",
    reason: index === 0 ? "rule-threshold" : "documented-behavior-confirmed",
  }));
  const preTuningMaintainerReview = createCalibrationReview(
    preTuningReport,
    worksheet,
    "jakub-niezgoda",
    "2026-08-09T02:10:00.000Z",
  );
  const preTuningAdjudication = adjudicateCalibrationReview(
    preTuningReport,
    preTuningMaintainerReview,
    "2026-08-09T02:20:00.000Z",
  );
  assert.equal(preTuningMaintainerReview.reportSha256, sha256Canonical(preTuningReport));
  const falsePositive = preTuningAdjudication.decisions.find(
    (decision) => decision.label === "false-positive",
  );
  const tuningChanges = [
    {
      action: "rule-threshold-tightened",
      codeCommitSha: values.report.engine.commitSha,
      evidenceFingerprints: [falsePositive.diagnosticFingerprint],
      packageSha256: values.report.engine.packageSha256,
      preTuningAdjudicationSha256: sha256Canonical(preTuningAdjudication),
      preTuningReportSha256: sha256Canonical(preTuningReport),
      regressionTests: [
        {
          path: "calibration/regressions/k03-rule-threshold.test.mjs",
          sha256: "d".repeat(64),
        },
      ],
      ruleId: falsePositive.ruleId,
    },
  ];
  const evidence = createPrecisionEvidence({
    ...values,
    engine: values.report.engine,
    generatedAt: "2026-08-09T06:00:00.000Z",
    preTuningAdjudication,
    preTuningEngine,
    preTuningMaintainerReview,
    preTuningReport,
    tuningChanges,
  });
  assert.equal(evidence.lineage.tuningApplied, true);
  assert.equal(evidence.tuningChanges.length, 1);
  assert.equal(evidence.lineage.engineSourceCommitSha, values.report.engine.commitSha);
  for (const regressionPath of [
    "calibration/regressions//k03.test.mjs",
    "calibration/regressions/./k03.test.mjs",
    "calibration/regressions/nested/../k03.test.mjs",
    "calibration\\regressions\\k03.test.mjs",
  ])
    assert.throws(
      () =>
        createPrecisionEvidence({
          ...values,
          engine: values.report.engine,
          generatedAt: "2026-08-09T06:00:00.000Z",
          preTuningAdjudication,
          preTuningEngine,
          preTuningMaintainerReview,
          preTuningReport,
          tuningChanges: [
            {
              ...tuningChanges[0],
              regressionTests: [{ ...tuningChanges[0].regressionTests[0], path: regressionPath }],
            },
          ],
        }),
      /non-canonical regression path|must match pattern/u,
    );

  assert.throws(
    () =>
      createPrecisionEvidence({
        ...values,
        engine: values.report.engine,
        generatedAt: "2026-08-09T06:00:00.000Z",
        preTuningAdjudication: {
          ...preTuningAdjudication,
          adjudicatedAt: "2026-08-09T04:30:00.000Z",
        },
        preTuningEngine,
        preTuningMaintainerReview,
        preTuningReport,
        tuningChanges,
      }),
    /strictly predate final capture/,
  );

  assert.throws(
    () =>
      createPrecisionEvidence({
        ...values,
        engine: values.report.engine,
        generatedAt: "2026-08-09T06:00:00.000Z",
        preTuningAdjudication,
        preTuningEngine,
        preTuningMaintainerReview,
        preTuningReport,
        tuningChanges: [
          {
            ...tuningChanges[0],
            codeCommitSha: preTuningEngine.commitSha,
          },
        ],
      }),
    /pre\/post engine lineage/,
  );
});

test("seeded replay requires exact unique coverage of all 69 supported rules", async () => {
  const values = await fixture();
  const corpus = structuredClone(values.seededRecallCorpus);
  const report = structuredClone(values.seededRecallReport);
  corpus.cases[1].expectedRuleId = corpus.cases[0].expectedRuleId;
  report.cases[1].expectedRuleId = report.cases[0].expectedRuleId;
  const checked = validateBoundSeededRecall(corpus, report);
  assert.equal(checked.valid, false);
  assert.match(checked.errors.join("\n"), /exact 69 supported rule IDs once/);
});

test("false-positive aggregates reconstruct rule, reason, stratum, and repository traits", async () => {
  const values = await fixture();
  const worksheet = createCalibrationWorksheet(values.report);
  worksheet.labels = worksheet.labels.map((entry, index) => ({
    ...entry,
    label: index === 0 ? "false-positive" : "true-positive",
    reason: index === 0 ? "classifier-boundary" : "documented-behavior-confirmed",
  }));
  const maintainerReview = createCalibrationReview(
    values.report,
    worksheet,
    "jakub-niezgoda",
    "2026-08-09T05:10:00.000Z",
  );
  const adjudication = adjudicateCalibrationReview(
    values.report,
    maintainerReview,
    "2026-08-09T05:11:00.000Z",
  );
  const evidence = createPrecisionEvidence({
    ...values,
    adjudication,
    engine: values.report.engine,
    generatedAt: "2026-08-09T06:00:00.000Z",
    maintainerReview,
  });
  assert.equal(evidence.falsePositiveAggregates.length, 1);
  const falsePositive = adjudication.decisions[0];
  const candidate = JSON.parse(values.candidateBytes.toString("utf8")).candidates.find(
    (entry) => entry.repositoryId === falsePositive.repositoryId,
  );
  const selected = values.corpus.repositories.find(
    (entry) => entry.repositoryId === falsePositive.repositoryId,
  );
  assert.deepEqual(evidence.falsePositiveAggregates[0], {
    assignedStratum: selected.assignedStratum,
    count: 1,
    multipleInstructionFormats: candidate.traits.multipleInstructionFormats,
    reason: "classifier-boundary",
    repositoryType: candidate.traits.monorepository ? "monorepository" : "single-repository",
    ruleId: falsePositive.ruleId,
    severity: falsePositive.severity,
  });
});
