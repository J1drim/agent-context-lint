import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeCalibrationDiagnosticFingerprint,
  prettyJson,
  sha256Canonical,
} from "./contracts.mjs";
import { runReviewer } from "./reviewer.mjs";

async function fixture(diagnosticCount = 1) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "metadata-reviewer-"));
  await mkdir(path.join(repositoryRoot, "review"));
  const corpusBytes = await readFile("calibration/metadata/v0/corpus.json");
  const corpus = JSON.parse(corpusBytes.toString("utf8"));
  const diagnostics = Array.from({ length: diagnosticCount }, (_, index) => {
    const diagnosticIdentity = {
      pathFingerprint: (index + 1).toString(16).padStart(64, "0"),
      repositoryId: corpus.repositories[index % corpus.repositories.length].repositoryId,
      ruleId: index % 2 === 0 ? "ACL250" : "ACL301",
      semanticFingerprint: (diagnosticCount + index + 1).toString(16).padStart(64, "0"),
      severity: index % 2 === 0 ? "error" : "warning",
    };
    return {
      diagnosticFingerprint: computeCalibrationDiagnosticFingerprint(diagnosticIdentity),
      effectiveSeverity: diagnosticIdentity.severity,
      ...diagnosticIdentity,
    };
  }).sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.repositoryId}\0${left.ruleId}\0${left.diagnosticFingerprint}`),
      Buffer.from(`${right.repositoryId}\0${right.ruleId}\0${right.diagnosticFingerprint}`),
    ),
  );
  const privateRepositories = [...new Set(diagnostics.map((entry) => entry.repositoryId))].map(
    (repositoryId) => ({
      checkout: { budget: null, inventorySha256: null, quota: null, root: null },
      diagnostics: diagnostics
        .filter((entry) => entry.repositoryId === repositoryId)
        .map((entry) => ({ ...entry, diagnostic: { message: "private fixture" } })),
      fullName: "fixture/repository",
      repositoryId,
    }),
  );
  const privatePayloadSha256 = sha256Canonical({
    recordKind: "agent-context-private-metadata-calibration-review-payload",
    repositories: privateRepositories,
  });
  const report = {
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
    privatePayloadSha256,
    recordKind: "agent-context-metadata-calibration-report",
    sourcePolicy: { fingerprintOnly: true, repositoryContent: false, repositoryPaths: false },
  };
  await writeFile(path.join(repositoryRoot, "review/corpus.json"), corpusBytes);
  await writeFile(path.join(repositoryRoot, "review/report.json"), prettyJson(report));
  const privatePath = path.join(repositoryRoot, "private-review.json");
  await writeFile(
    privatePath,
    prettyJson({
      mustNotCommit: true,
      privatePayloadSha256: report.privatePayloadSha256,
      recordKind: "agent-context-private-metadata-calibration-review-bundle",
      reportSha256: sha256Canonical(report),
      repositories: privateRepositories,
    }),
    { mode: 0o600 },
  );
  return { privatePath, repositoryRoot };
}

test("reviewer CLI emits complete stdout-only reviews and reconstructible adjudication", async () => {
  const { privatePath, repositoryRoot } = await fixture();
  const verified = [];
  const instants = ["2026-08-09T01:00:00.000Z", "2026-08-09T02:00:00.000Z"];
  const options = {
    now: () => instants.shift(),
    repositoryRoot,
    verifyCheckout: async () => verified.push("verified"),
  };
  const worksheet = JSON.parse(
    await runReviewer(["worksheet", "review/corpus.json", "review/report.json", privatePath], {
      ...options,
    }),
  );
  worksheet.labels[0].label = "true-positive";
  worksheet.labels[0].reason = "documented-behavior-confirmed";
  await writeFile(path.join(repositoryRoot, "review/worksheet.json"), prettyJson(worksheet));
  const review = await runReviewer(
    ["review", "review/corpus.json", "review/report.json", privatePath, "review/worksheet.json"],
    options,
  );
  await writeFile(path.join(repositoryRoot, "review/maintainer.json"), review);
  const adjudication = await runReviewer(
    [
      "adjudicate",
      "review/corpus.json",
      "review/report.json",
      privatePath,
      "review/maintainer.json",
    ],
    options,
  );
  await writeFile(path.join(repositoryRoot, "review/adjudication.json"), adjudication);
  assert.equal(
    await runReviewer(
      [
        "validate-adjudication",
        "review/corpus.json",
        "review/report.json",
        privatePath,
        "review/adjudication.json",
        "review/maintainer.json",
      ],
      options,
    ),
    "Metadata calibration adjudication is valid.\n",
  );
  assert.equal(verified.length, 4);
});

test("reviewer CLI emits byte-bound K03 precision evidence from complete artifacts", async () => {
  const { privatePath, repositoryRoot } = await fixture(500);
  const instants = ["2026-08-09T01:00:00.000Z", "2026-08-09T02:00:00.000Z"];
  const options = {
    now: () => instants.shift(),
    repositoryRoot,
    verifyCheckout: async () => {},
  };
  const report = JSON.parse(
    await readFile(path.join(repositoryRoot, "review/report.json"), "utf8"),
  );
  const worksheet = JSON.parse(
    await runReviewer(["worksheet", "review/corpus.json", "review/report.json", privatePath], {
      ...options,
    }),
  );
  worksheet.labels = worksheet.labels.map((entry) => ({
    ...entry,
    label: "true-positive",
    reason: "documented-behavior-confirmed",
  }));
  await writeFile(path.join(repositoryRoot, "review/worksheet.json"), prettyJson(worksheet));
  await writeFile(
    path.join(repositoryRoot, "review/maintainer.json"),
    await runReviewer(
      ["review", "review/corpus.json", "review/report.json", privatePath, "review/worksheet.json"],
      options,
    ),
  );
  await writeFile(
    path.join(repositoryRoot, "review/adjudication.json"),
    await runReviewer(
      [
        "adjudicate",
        "review/corpus.json",
        "review/report.json",
        privatePath,
        "review/maintainer.json",
      ],
      options,
    ),
  );
  for (const [source, destination] of [
    ["calibration/metadata/v0/candidate-snapshot.json", "review/candidates.json"],
    ["calibration/seeded-recall/v0/corpus.json", "review/seeded-corpus.json"],
    ["calibration/seeded-recall/v0/report.json", "review/seeded-report.json"],
  ])
    await writeFile(path.join(repositoryRoot, destination), await readFile(source));
  await writeFile(path.join(repositoryRoot, "review/tuning.json"), "[]\n");
  const evidence = JSON.parse(
    await runReviewer(
      [
        "precision",
        "review/candidates.json",
        "review/corpus.json",
        "review/report.json",
        privatePath,
        "review/maintainer.json",
        "review/adjudication.json",
        "review/seeded-corpus.json",
        "review/seeded-report.json",
        "review/tuning.json",
        "2026-08-09T04:00:00.000Z",
        "/tmp/package",
        "/tmp/package/cli.js",
        "/tmp/node",
        "/usr/bin/git",
      ],
      {
        repositoryRoot,
        inspectHdiutil: async () => ({
          path: "/usr/bin/hdiutil",
          ...report.engine.hdiutil,
        }),
        verifyCheckout: async () => {},
        verifyRuntime: async () => {},
      },
    ),
  );
  assert.equal(evidence.diagnosticCount, 500);
  assert.equal(evidence.precisionGatePassed, true);
  assert.equal(evidence.externalHoldout.releaseTrialRepositoryCount, 0);
});

test("reviewer CLI rejects incomplete worksheets and path escapes", async () => {
  const { privatePath, repositoryRoot } = await fixture();
  const options = {
    now: () => "2026-08-09T01:00:00.000Z",
    repositoryRoot,
    verifyCheckout: async () => {},
  };
  const worksheet = await runReviewer(
    ["worksheet", "review/corpus.json", "review/report.json", privatePath],
    options,
  );
  await writeFile(path.join(repositoryRoot, "review/worksheet.json"), worksheet);
  await assert.rejects(
    runReviewer(
      ["review", "review/corpus.json", "review/report.json", privatePath, "review/worksheet.json"],
      options,
    ),
    /invalid label\/reason pair/,
  );
  await assert.rejects(
    runReviewer(["validate", "../corpus.json", "review/report.json"], { repositoryRoot }),
    /canonical/,
  );
  const mutatedPrivate = JSON.parse(await readFile(privatePath, "utf8"));
  mutatedPrivate.repositories[0].diagnostics[0].diagnostic.message += " mutated";
  await writeFile(privatePath, prettyJson(mutatedPrivate), { mode: 0o600 });
  await assert.rejects(
    runReviewer(["worksheet", "review/corpus.json", "review/report.json", privatePath], {
      ...options,
    }),
    /private review payload differs/,
  );
  const substitutedCheckout = JSON.parse(await readFile(privatePath, "utf8"));
  substitutedCheckout.repositories[0].diagnostics[0].diagnostic.message = "private fixture";
  substitutedCheckout.repositories[0].checkout.root = "/tmp/substituted-checkout";
  await writeFile(privatePath, prettyJson(substitutedCheckout), { mode: 0o600 });
  await assert.rejects(
    runReviewer(["worksheet", "review/corpus.json", "review/report.json", privatePath], {
      ...options,
    }),
    /private review payload differs/,
  );
  await chmod(privatePath, 0o700);
  await assert.rejects(
    runReviewer(["worksheet", "review/corpus.json", "review/report.json", privatePath], {
      ...options,
    }),
    /mode-0600/,
  );
});
