import assert from "node:assert/strict";
import test from "node:test";

import { runCleanup } from "./cleanup.mjs";

test("cleanup CLI requires final-gate acknowledgement and binds report/private inputs", async () => {
  await assert.rejects(runCleanup([]), /acknowledge-successful-final-k03-gate/u);
  const corpus = { recordKind: "fixture-corpus" };
  const report = { recordKind: "fixture-report" };
  const bundle = { recordKind: "fixture-private" };
  const calls = [];
  const output = await runCleanup(
    [
      "calibration/metadata/v0/corpus.json",
      "calibration/metadata/v0/report.json",
      "/private/tmp/k03/private-review.json",
      "/private/tmp/k03",
      "--acknowledge-successful-final-k03-gate",
    ],
    {
      cleanupCapture: async (provider, observedBundle, workRoot) => {
        assert.equal(typeof provider.cleanup, "function");
        assert.equal(typeof provider.verify, "function");
        assert.equal(observedBundle, bundle);
        assert.equal(workRoot, "/private/tmp/k03");
        calls.push("cleanup");
        return { cleanedRepositories: 50 };
      },
      inspectHdiutil: async () => ({
        path: "/usr/bin/hdiutil",
        sha256: "1".repeat(64),
        version: "fixture",
      }),
      readCorpus: async (corpusPath) => {
        assert.equal(corpusPath, "calibration/metadata/v0/corpus.json");
        calls.push("corpus");
        return corpus;
      },
      readPrivate: async (privatePath) => {
        assert.equal(privatePath, "/private/tmp/k03/private-review.json");
        calls.push("private");
        return bundle;
      },
      readReport: async (reportPath) => {
        assert.equal(reportPath, "calibration/metadata/v0/report.json");
        calls.push("report");
        return report;
      },
      validateBundle: (observedReport, observedBundle) => {
        assert.equal(observedReport, report);
        assert.equal(observedBundle, bundle);
        calls.push("validate");
        return { errors: [], valid: true };
      },
      validateReport: (observedReport, observedCorpus) => {
        assert.equal(observedReport, report);
        assert.equal(observedCorpus, corpus);
        calls.push("validate-report");
        return { errors: [], valid: true };
      },
    },
  );
  assert.deepEqual(calls, [
    "corpus",
    "report",
    "private",
    "validate-report",
    "validate",
    "cleanup",
  ]);
  assert.equal(
    output,
    "Cleaned 50 frozen K03 quota volumes after the acknowledged successful final gate.\n",
  );
});
