import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  K03_MAINTAINER_AUTHORITY,
  K03_MAINTAINER_AUTHORITY_SHA256,
  adjudicateCalibrationReview,
  canonicalJson,
  computeCalibrationDiagnosticFingerprint,
  createCalibrationReview,
  createCalibrationWorksheet,
  selectCalibrationCorpus,
  sha256Canonical,
  validateCalibrationAdjudication,
  validateCalibrationCorpus,
  validateCalibrationReport,
  validateCalibrationReview,
  validateK03MaintainerAuthority,
  validateCandidateSnapshot,
  wilson95,
} from "./contracts.mjs";

async function artifacts() {
  return {
    corpus: JSON.parse(await readFile("calibration/metadata/v0/corpus.json", "utf8")),
    snapshot: JSON.parse(await readFile("calibration/metadata/v0/candidate-snapshot.json", "utf8")),
  };
}

function clone(value) {
  return structuredClone(value);
}

test("the frozen candidates and selected 50-repository corpus reconstruct exactly", async () => {
  const { corpus, snapshot } = await artifacts();
  assert.deepEqual(validateCandidateSnapshot(snapshot), { errors: [], valid: true });
  assert.deepEqual(validateCalibrationCorpus(corpus, snapshot), { errors: [], valid: true });
  assert.equal(canonicalJson(selectCalibrationCorpus(snapshot)), canonicalJson(corpus));
  assert.equal(corpus.repositories.length, 50);
  assert.deepEqual(
    Object.fromEntries(
      ["agents-md", "claude", "copilot", "cursor", "gemini"].map((format) => [
        format,
        corpus.repositories.filter((entry) => entry.assignedStratum === format).length,
      ]),
    ),
    { "agents-md": 10, claude: 10, copilot: 10, cursor: 10, gemini: 10 },
  );
});

test("candidate contracts reject source-bearing fields and unbound metadata", async () => {
  const { snapshot } = await artifacts();
  for (const forbidden of ["content", "descriptionExcerpt", "readme", "text_matches"]) {
    const malformed = clone(snapshot);
    malformed.candidates[0][forbidden] = "repository source must not be persisted";
    assert.equal(validateCandidateSnapshot(malformed).valid, false, forbidden);
  }
  const unbound = clone(snapshot);
  unbound.candidates[0].instructionEvidence[0].metadataUrl = "https://api.github.com/unbound";
  assert.match(validateCandidateSnapshot(unbound).errors.join("\n"), /pinned commit/);
  const licenseContentEndpoint = clone(snapshot);
  licenseContentEndpoint.candidates[0].license.metadataUrl += "/license";
  assert.match(
    validateCandidateSnapshot(licenseContentEndpoint).errors.join("\n"),
    /content-free repository metadata/,
  );
});

test("selection rejects stale candidate and coverage evidence", async () => {
  const { corpus, snapshot } = await artifacts();
  const stale = clone(corpus);
  stale.selection.candidateSnapshotSha256 = "0".repeat(64);
  assert.match(validateCalibrationCorpus(stale, snapshot).errors.join("\n"), /does not bind/);
  const reordered = clone(corpus);
  [reordered.repositories[0], reordered.repositories[1]] = [
    reordered.repositories[1],
    reordered.repositories[0],
  ];
  assert.match(validateCalibrationCorpus(reordered, snapshot).errors.join("\n"), /reconstruct/);
});

function reportFor(corpus) {
  const repositories = corpus.repositories.slice(0, 4);
  const diagnostics = repositories.map((repository, index) => {
    const identity = {
      pathFingerprint: `${index + 5}`.repeat(64).slice(0, 64),
      repositoryId: repository.repositoryId,
      ruleId: `ACL${index % 2 === 0 ? "250" : "301"}`,
      semanticFingerprint: `${index + 3}`.repeat(64).slice(0, 64),
      severity: index % 2 === 0 ? "error" : "warning",
    };
    return {
      diagnosticFingerprint: computeCalibrationDiagnosticFingerprint(identity),
      effectiveSeverity: identity.severity,
      ...identity,
    };
  });
  diagnostics.sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.repositoryId}\0${left.ruleId}\0${left.diagnosticFingerprint}`),
      Buffer.from(`${right.repositoryId}\0${right.ruleId}\0${right.diagnosticFingerprint}`),
    ),
  );
  return {
    contractVersion: "0.1.0",
    corpusSha256: sha256Canonical(corpus),
    diagnostics,
    engine: {
      captureStartedAt: "2026-08-08T23:59:00.000Z",
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
    generatedAt: "2026-08-09T00:00:00.000Z",
    knowledgeVersion: "2026.08.0",
    privatePayloadSha256: "8".repeat(64),
    recordKind: "agent-context-metadata-calibration-report",
    sourcePolicy: { fingerprintOnly: true, repositoryContent: false, repositoryPaths: false },
  };
}

function completedWorksheet(report, labels) {
  const worksheet = createCalibrationWorksheet(report);
  worksheet.labels = worksheet.labels.map((entry, index) => ({
    ...entry,
    label: labels[index],
    reason:
      labels[index] === "true-positive"
        ? "documented-behavior-confirmed"
        : labels[index] === "false-positive"
          ? "classifier-boundary"
          : labels[index] === "test-harness-defect"
            ? "fixture-or-scan-defect"
            : "profile-semantics-unknown",
  }));
  return worksheet;
}

test("fingerprint-only reviews bind every diagnostic and reconstruct Wilson summaries", async () => {
  const { corpus } = await artifacts();
  const report = reportFor(corpus);
  assert.equal(validateCalibrationReport(report, corpus).valid, true);
  const forgedFingerprint = clone(report);
  forgedFingerprint.diagnostics[0].diagnosticFingerprint = "f".repeat(64);
  assert.match(
    validateCalibrationReport(forgedFingerprint, corpus).errors.join("\n"),
    /does not reconstruct/,
  );
  let errorIndex = 0;
  const agreedLabels = report.diagnostics.map((diagnostic) => {
    if (diagnostic.severity === "warning") return "true-positive";
    const label = errorIndex === 0 ? "true-positive" : "false-positive";
    errorIndex += 1;
    return label;
  });
  const maintainerReview = createCalibrationReview(
    report,
    completedWorksheet(report, agreedLabels),
    "jakub-niezgoda",
    "2026-08-09T01:00:00.000Z",
  );
  assert.equal(validateCalibrationReview(maintainerReview, report).valid, true);
  assert.equal(maintainerReview.maintainerAuthoritySha256, K03_MAINTAINER_AUTHORITY_SHA256);
  assert.equal(validateK03MaintainerAuthority(K03_MAINTAINER_AUTHORITY).valid, true);
  assert.equal(
    validateK03MaintainerAuthority({ ...K03_MAINTAINER_AUTHORITY, reviewerId: "other" }).valid,
    false,
  );
  const adjudication = adjudicateCalibrationReview(
    report,
    maintainerReview,
    "2026-08-09T02:00:00.000Z",
  );
  assert.equal(adjudication.summary.resolvedCount, report.diagnostics.length);
  assert.equal(adjudication.summary.error.denominator, 2);
  assert.equal(adjudication.summary.error.precisionBasisPoints, 5000);
  assert.equal(adjudication.summary.warning.precisionBasisPoints, 10_000);
  assert.equal(validateCalibrationAdjudication(adjudication, report, maintainerReview).valid, true);
  const retimedReview = clone(maintainerReview);
  retimedReview.reviewedAt = "2026-08-09T01:30:00.000Z";
  assert.equal(validateCalibrationAdjudication(adjudication, report, retimedReview).valid, false);
  const stale = clone(maintainerReview);
  stale.reportSha256 = "f".repeat(64);
  assert.equal(validateCalibrationReview(stale, report).valid, false);
});

test("Wilson calculations use conservative integer bounds and reject malformed counts", () => {
  assert.deepEqual(wilson95(0, 0), {
    denominator: 0,
    falsePositiveCount: 0,
    lowerWilsonBasisPoints: 0,
    precisionBasisPoints: 0,
    truePositiveCount: 0,
    upperWilsonBasisPoints: 0,
  });
  assert.equal(wilson95(73, 73).lowerWilsonBasisPoints, 9500);
  assert.equal(wilson95(72, 72).lowerWilsonBasisPoints, 9493);
  assert.equal(wilson95(22, 22).lowerWilsonBasisPoints, 8513);
  assert.throws(() => wilson95(2, 1), /successes <= total/);
  assert.throws(() => wilson95(0.5, 1), /safe integers/);
});
