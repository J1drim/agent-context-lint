import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executeSeededRecallScenarios,
  seededRecallCorpusRecord,
} from "../../packages/rules/test/helpers/seeded-recall-corpus.ts";
import {
  _test,
  createRecallReport,
  generateSeededRecallArtifacts,
  runSeededRecallCli,
} from "./run.mjs";

const tinyArtifacts = Object.freeze({
  corpus: Object.freeze({ recordKind: "synthetic-corpus" }),
  report: Object.freeze({ recordKind: "synthetic-report" }),
});

function expectedText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixtureRoot() {
  return mkdtempSync(path.join(tmpdir(), "seeded-recall-runner-"));
}

function createArtifactDirectory(root) {
  const target = path.join(root, "calibration/seeded-recall/v0");
  mkdirSync(target, { recursive: true });
  return target;
}

async function withoutStdout(callback) {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    await callback();
    return output;
  } finally {
    process.stdout.write = original;
  }
}

function injectedOptions(root) {
  return { generate: () => Promise.resolve(tinyArtifacts), repositoryRoot: root };
}

function propertyNames(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) propertyNames(entry, output);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      output.add(key);
      propertyNames(entry, output);
    }
  }
  return output;
}

test("generates a fingerprint-only 69/69 report from deterministic public-scheduler runs", async () => {
  const { corpus, report } = await generateSeededRecallArtifacts();
  assert.equal(corpus.cases.length, 69);
  assert.deepEqual(report.summary, {
    detectedCases: 69,
    missedCases: 0,
    recallBasisPoints: 10_000,
    supportedCases: 69,
  });
  const keys = propertyNames(report);
  for (const forbidden of ["fingerprintBasis", "message", "source", "sourceText", "suggestion"])
    assert.equal(keys.has(forbidden), false);
});

test("does not count a suppressed expected diagnostic as seeded recall", async () => {
  const corpus = seededRecallCorpusRecord();
  const executions = await executeSeededRecallScenarios({
    maximumConcurrency: 3,
    scheduleSeed: 17,
  });
  const firstCase = corpus.cases[0];
  assert.ok(firstCase);
  const mutated = executions.map((entry) => {
    if (entry.scenario.id !== firstCase.scenarioId) return entry;
    const expected = entry.result.visibleDiagnostics.find(
      (diagnostic) => diagnostic.ruleId === firstCase.expectedRuleId,
    );
    assert.ok(expected);
    return {
      ...entry,
      result: {
        ...entry.result,
        suppressedDiagnostics: [...entry.result.suppressedDiagnostics, expected],
        visibleDiagnostics: entry.result.visibleDiagnostics.filter(
          (diagnostic) => diagnostic !== expected,
        ),
      },
    };
  });
  const report = createRecallReport(corpus, mutated);
  assert.deepEqual(report.cases[0], {
    caseId: firstCase.caseId,
    detected: false,
    diagnostic: null,
    disposition: "missed",
    expectedRuleId: firstCase.expectedRuleId,
    familyId: firstCase.familyId,
    scenarioId: firstCase.scenarioId,
  });
  assert.equal(report.summary.detectedCases, 68);
  assert.equal(report.summary.missedCases, 1);
});

test("replacement same-rule evidence cannot satisfy the intended seeded identity", async () => {
  const corpus = seededRecallCorpusRecord();
  const executions = await executeSeededRecallScenarios({
    maximumConcurrency: 2,
    scheduleSeed: 23,
  });
  const firstCase = corpus.cases[0];
  assert.ok(firstCase);
  const mutated = executions.map((entry) => {
    if (entry.scenario.id !== firstCase.scenarioId) return entry;
    const expected = entry.result.visibleDiagnostics.find(
      (diagnostic) => diagnostic.ruleId === firstCase.expectedRuleId,
    );
    assert.ok(expected);
    const unrelated = {
      ...expected,
      fingerprints: {
        ...expected.fingerprints,
        path: { ...expected.fingerprints.path, value: "f".repeat(64) },
        semantic: { ...expected.fingerprints.semantic, value: "e".repeat(64) },
      },
    };
    return {
      ...entry,
      result: {
        ...entry.result,
        visibleDiagnostics: entry.result.visibleDiagnostics.map((diagnostic) =>
          diagnostic === expected ? unrelated : diagnostic,
        ),
      },
    };
  });
  const report = createRecallReport(corpus, mutated);
  assert.equal(report.cases[0]?.detected, false);
  assert.equal(report.cases[0]?.disposition, "missed");
  assert.equal(report.summary.detectedCases, 68);
});

test("check mode accepts current artifacts and rejects missing or stale artifacts", async () => {
  const current = fixtureRoot();
  const directory = createArtifactDirectory(current);
  writeFileSync(path.join(directory, "corpus.json"), expectedText(tinyArtifacts.corpus));
  writeFileSync(path.join(directory, "report.json"), expectedText(tinyArtifacts.report));
  assert.equal(
    await withoutStdout(() => runSeededRecallCli([], injectedOptions(current))),
    "Seeded recall is 69/69 and committed artifacts are current.\n",
  );

  const missing = fixtureRoot();
  createArtifactDirectory(missing);
  await assert.rejects(() => runSeededRecallCli([], injectedOptions(missing)), /is missing/u);

  const stale = fixtureRoot();
  const staleDirectory = createArtifactDirectory(stale);
  writeFileSync(path.join(staleDirectory, "corpus.json"), "stale\n");
  writeFileSync(path.join(staleDirectory, "report.json"), expectedText(tinyArtifacts.report));
  await assert.rejects(() => runSeededRecallCli([], injectedOptions(stale)), /is stale/u);
});

test("CLI rejects unacknowledged and extra generation arguments", async () => {
  const options = injectedOptions(fixtureRoot());
  for (const arguments_ of [
    ["--write"],
    ["--acknowledge-reviewed-update"],
    ["--write", "--acknowledge-reviewed-update", "extra"],
  ])
    await assert.rejects(() => runSeededRecallCli(arguments_, options), /Usage/u);
});

test("acknowledged generation creates and deliberately replaces both fixed artifacts", async () => {
  const root = fixtureRoot();
  const output = await withoutStdout(() =>
    runSeededRecallCli(["--write", "--acknowledge-reviewed-update"], injectedOptions(root)),
  );
  const targets = _test.artifactPaths(root);
  assert.equal(readFileSync(targets.corpus, "utf8"), expectedText(tinyArtifacts.corpus));
  assert.equal(readFileSync(targets.report, "utf8"), expectedText(tinyArtifacts.report));
  writeFileSync(targets.corpus, "reviewed old value\n");
  await withoutStdout(() =>
    runSeededRecallCli(["--write", "--acknowledge-reviewed-update"], injectedOptions(root)),
  );
  assert.equal(readFileSync(targets.corpus, "utf8"), expectedText(tinyArtifacts.corpus));
  assert.equal(output, "Updated reviewed seeded-recall corpus and report.\n");
  assert.equal(
    readdirSync(targets.directory).some((entry) => entry.includes(".tmp-")),
    false,
  );
});

test("check mode bounds artifact reads and rejects symlinks and special targets", async () => {
  const oversized = fixtureRoot();
  const oversizedDirectory = createArtifactDirectory(oversized);
  writeFileSync(
    path.join(oversizedDirectory, "corpus.json"),
    Buffer.alloc(_test.MAX_ARTIFACT_BYTES + 1),
  );
  writeFileSync(path.join(oversizedDirectory, "report.json"), expectedText(tinyArtifacts.report));
  await assert.rejects(() => runSeededRecallCli([], injectedOptions(oversized)), /byte limit/u);

  const symlinked = fixtureRoot();
  const symlinkedDirectory = createArtifactDirectory(symlinked);
  const outside = fixtureRoot();
  const outsideFile = path.join(outside, "corpus.json");
  writeFileSync(outsideFile, expectedText(tinyArtifacts.corpus));
  symlinkSync(outsideFile, path.join(symlinkedDirectory, "corpus.json"));
  writeFileSync(path.join(symlinkedDirectory, "report.json"), expectedText(tinyArtifacts.report));
  await assert.rejects(() => runSeededRecallCli([], injectedOptions(symlinked)), /ordinary file/u);

  const special = fixtureRoot();
  const specialDirectory = createArtifactDirectory(special);
  mkdirSync(path.join(specialDirectory, "corpus.json"));
  writeFileSync(path.join(specialDirectory, "report.json"), expectedText(tinyArtifacts.report));
  await assert.rejects(() => runSeededRecallCli([], injectedOptions(special)), /ordinary file/u);
});

test("generation rejects symlinked parents and targets without leaving temporary artifacts", async () => {
  const parentRoot = fixtureRoot();
  const outside = fixtureRoot();
  mkdirSync(path.join(parentRoot, "calibration"));
  symlinkSync(outside, path.join(parentRoot, "calibration/seeded-recall"));
  await assert.rejects(
    () =>
      runSeededRecallCli(["--write", "--acknowledge-reviewed-update"], injectedOptions(parentRoot)),
    /ordinary directory/u,
  );
  assert.deepEqual(readdirSync(outside), []);

  const targetRoot = fixtureRoot();
  const targetDirectory = createArtifactDirectory(targetRoot);
  const outsideFile = path.join(outside, "outside.json");
  writeFileSync(outsideFile, "outside\n");
  symlinkSync(outsideFile, path.join(targetDirectory, "corpus.json"));
  await assert.rejects(
    () =>
      runSeededRecallCli(["--write", "--acknowledge-reviewed-update"], injectedOptions(targetRoot)),
    /ordinary file/u,
  );
  assert.equal(readFileSync(outsideFile, "utf8"), "outside\n");
  assert.equal(
    readdirSync(targetDirectory).some((entry) => entry.includes(".tmp-")),
    false,
  );
});

test("generation rejects a captured parent replacement without writing outside the root", async () => {
  const root = fixtureRoot();
  const directory = createArtifactDirectory(root);
  const movedDirectory = `${directory}-captured`;
  const outside = fixtureRoot();
  const options = {
    ...injectedOptions(root),
    beforeArtifactOpen() {
      renameSync(directory, movedDirectory);
      symlinkSync(outside, directory);
    },
  };
  await assert.rejects(
    () => runSeededRecallCli(["--write", "--acknowledge-reviewed-update"], options),
    /artifact directory changed concurrently/u,
  );
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(
    readdirSync(movedDirectory).some((entry) => entry.includes(".tmp-")),
    false,
  );
});
