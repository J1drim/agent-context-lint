#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSeededRecallScenarios,
  executeSeededRecallScenarios,
  seededRecallCorpusRecord,
} from "../../packages/rules/test/helpers/seeded-recall-corpus.ts";
import {
  SEEDED_RECALL_CONTRACT_VERSION,
  SEEDED_RECALL_REPORT_KIND,
  SEEDED_RECALL_SUPPORTED_CASES,
  computeRecallRunSha256,
  computeSeededRecallDiagnosticSha256,
  sha256Canonical,
  validateSeededRecallCorpus,
  validateSeededRecallReport,
} from "./contracts.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const ARTIFACT_COMPONENTS = Object.freeze(["calibration", "seeded-recall", "v0"]);
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const PERTURBATIONS = Object.freeze([
  Object.freeze({ maximumConcurrency: 1, scheduleSeed: 0 }),
  Object.freeze({ maximumConcurrency: 4, scheduleSeed: 9_173 }),
  Object.freeze({ maximumConcurrency: 10, scheduleSeed: 0xffff_ffff }),
]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function artifactText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifactPaths(repositoryRoot) {
  const directory = path.join(repositoryRoot, ...ARTIFACT_COMPONENTS);
  return Object.freeze({
    corpus: path.join(directory, "corpus.json"),
    directory,
    report: path.join(directory, "report.json"),
  });
}

function lstatOrNull(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function ensureArtifactDirectory(repositoryRoot, create) {
  const root = path.resolve(repositoryRoot);
  const rootStat = lstatOrNull(root);
  if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("seeded-recall repository root must be an ordinary directory");
  const realRoot = realpathSync(root);
  let current = root;
  for (const component of ARTIFACT_COMPONENTS) {
    current = path.join(current, component);
    let stat = lstatOrNull(current);
    if (stat === null && create) {
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (stat === null) throw new Error(`${path.relative(root, current)} is missing`);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`${path.relative(root, current)} must be an ordinary directory`);
    const real = realpathSync(current);
    if (!real.startsWith(`${realRoot}${path.sep}`) && real !== realRoot)
      throw new Error(`${path.relative(root, current)} escapes the repository root`);
  }
  const targets = artifactPaths(root);
  const parent = lstatSync(targets.directory);
  return Object.freeze({
    ...targets,
    parentIdentity: Object.freeze({
      device: String(parent.dev),
      inode: String(parent.ino),
      realpath: realpathSync(targets.directory),
    }),
  });
}

function assertParentIdentity(targets) {
  const stat = lstatOrNull(targets.directory);
  if (
    stat === null ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    String(stat.dev) !== targets.parentIdentity.device ||
    String(stat.ino) !== targets.parentIdentity.inode ||
    realpathSync(targets.directory) !== targets.parentIdentity.realpath
  )
    throw new Error("seeded-recall artifact directory changed concurrently");
}

function assertWritableTarget(target, repositoryRoot) {
  const stat = lstatOrNull(target);
  if (stat !== null && (stat.isSymbolicLink() || !stat.isFile()))
    throw new Error(`${path.relative(repositoryRoot, target)} must be an ordinary file`);
}

function diagnosticOrder(left, right) {
  return (
    compareUtf8(left.fingerprints.path.value, right.fingerprints.path.value) ||
    compareUtf8(left.fingerprints.semantic.value, right.fingerprints.semantic.value)
  );
}

export function createRecallReport(corpus, executions) {
  const executionByScenario = new Map(executions.map((entry) => [entry.scenario.id, entry]));
  let detectedCases = 0;
  const cases = corpus.cases.map((entry) => {
    const execution = executionByScenario.get(entry.scenarioId);
    if (execution === undefined)
      throw new Error(`scenario execution is missing: ${entry.scenarioId}`);
    const candidates = execution.result.visibleDiagnostics
      .filter((candidate) => candidate.ruleId === entry.expectedRuleId)
      .sort(diagnosticOrder);
    const attributed = candidates.filter(
      (candidate) =>
        computeSeededRecallDiagnosticSha256(
          candidate.ruleId,
          candidate.fingerprints.path.value,
          candidate.fingerprints.semantic.value,
        ) === entry.expectedDiagnosticSha256,
    );
    if (attributed.length > 1)
      throw new Error(`seed attribution is duplicated for ${entry.caseId}`);
    const diagnostic = attributed[0];
    if (diagnostic === undefined)
      return {
        caseId: entry.caseId,
        detected: false,
        diagnostic: null,
        disposition: "missed",
        expectedRuleId: entry.expectedRuleId,
        familyId: entry.familyId,
        scenarioId: entry.scenarioId,
      };
    detectedCases += 1;
    return {
      caseId: entry.caseId,
      detected: true,
      diagnostic: {
        path: diagnostic.fingerprints.path.value,
        semantic: diagnostic.fingerprints.semantic.value,
        severity: diagnostic.severity,
      },
      disposition: "visible",
      expectedRuleId: entry.expectedRuleId,
      familyId: entry.familyId,
      scenarioId: entry.scenarioId,
    };
  });
  const report = {
    cases,
    contractVersion: SEEDED_RECALL_CONTRACT_VERSION,
    corpusSha256: sha256Canonical(corpus),
    recordKind: SEEDED_RECALL_REPORT_KIND,
    runSha256: "0".repeat(64),
    schedulerVersion: corpus.schedulerVersion,
    summary: {
      detectedCases,
      missedCases: SEEDED_RECALL_SUPPORTED_CASES - detectedCases,
      recallBasisPoints: Math.floor((detectedCases * 10_000) / SEEDED_RECALL_SUPPORTED_CASES),
      supportedCases: SEEDED_RECALL_SUPPORTED_CASES,
    },
  };
  report.runSha256 = computeRecallRunSha256(report);
  return report;
}

export async function generateSeededRecallArtifacts() {
  const corpus = seededRecallCorpusRecord();
  const checkedCorpus = validateSeededRecallCorpus(corpus);
  if (!checkedCorpus.valid) throw new Error(checkedCorpus.errors.join("\n"));
  const scenarios = await buildSeededRecallScenarios();
  if (new Set(scenarios.map((entry) => entry.id)).size !== scenarios.length)
    throw new Error("seeded-recall scenario IDs must be unique");
  const reports = [];
  for (const options of PERTURBATIONS) {
    const executions = await executeSeededRecallScenarios(options);
    reports.push(createRecallReport(corpus, executions));
  }
  const [report, ...perturbed] = reports;
  if (report === undefined) throw new Error("seeded-recall perturbation set is empty");
  const expected = artifactText(report);
  for (const candidate of perturbed)
    if (artifactText(candidate) !== expected)
      throw new Error("seeded-recall report changed across scheduler perturbations");
  const checkedReport = validateSeededRecallReport(report, corpus);
  if (!checkedReport.valid) throw new Error(checkedReport.errors.join("\n"));
  if (report.summary.recallBasisPoints !== 10_000)
    throw new Error(`seeded recall is ${String(report.summary.recallBasisPoints)} basis points`);
  return Object.freeze({ corpus, report });
}

function writeAtomic(targets, target, text) {
  const temporary = `${target}.tmp-${String(process.pid)}-${digestForTemporary(text)}`;
  let descriptor;
  try {
    assertParentIdentity(targets);
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, text, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertParentIdentity(targets);
    renameSync(temporary, target);
    assertParentIdentity(targets);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      assertParentIdentity(targets);
      if (lstatOrNull(temporary) !== null) unlinkSync(temporary);
    } catch {
      // Never clean up through a pathname whose captured parent identity no longer matches.
    }
    throw error;
  }
}

function digestForTemporary(text) {
  return sha256Canonical({ text }).slice(0, 12);
}

function compareArtifact(targets, target, expected, repositoryRoot) {
  assertParentIdentity(targets);
  const stat = lstatOrNull(target);
  if (stat === null) throw new Error(`${path.relative(repositoryRoot, target)} is missing`);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`${path.relative(repositoryRoot, target)} must be an ordinary file`);
  if (stat.size > MAX_ARTIFACT_BYTES)
    throw new Error(`${path.relative(repositoryRoot, target)} exceeds the artifact byte limit`);
  let descriptor;
  let actual;
  try {
    descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      String(opened.dev) !== String(stat.dev) ||
      String(opened.ino) !== String(stat.ino) ||
      opened.size > MAX_ARTIFACT_BYTES
    )
      throw new Error(`${path.relative(repositoryRoot, target)} changed concurrently`);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const consumed = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (consumed === 0) break;
      offset += consumed;
    }
    const extra = Buffer.alloc(1);
    if (offset !== bytes.length || readSync(descriptor, extra, 0, 1, offset) !== 0)
      throw new Error(`${path.relative(repositoryRoot, target)} changed concurrently`);
    actual = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertParentIdentity(targets);
  if (actual !== expected)
    throw new Error(
      `${path.relative(repositoryRoot, target)} is stale; run seeded-recall:generate`,
    );
}

export async function runSeededRecallCli(
  arguments_,
  {
    beforeArtifactOpen = () => {},
    generate = generateSeededRecallArtifacts,
    repositoryRoot = REPOSITORY_ROOT,
  } = {},
) {
  const write =
    arguments_.length === 2 &&
    arguments_[0] === "--write" &&
    arguments_[1] === "--acknowledge-reviewed-update";
  if (arguments_.length !== 0 && !write)
    throw new Error("Usage: run.mjs [--write --acknowledge-reviewed-update]");
  const artifacts = await generate();
  const corpusText = artifactText(artifacts.corpus);
  const reportText = artifactText(artifacts.report);
  if (write) {
    const targets = ensureArtifactDirectory(repositoryRoot, true);
    assertWritableTarget(targets.corpus, repositoryRoot);
    assertWritableTarget(targets.report, repositoryRoot);
    beforeArtifactOpen();
    writeAtomic(targets, targets.corpus, corpusText);
    writeAtomic(targets, targets.report, reportText);
    process.stdout.write("Updated reviewed seeded-recall corpus and report.\n");
    return;
  }
  const targets = ensureArtifactDirectory(repositoryRoot, false);
  beforeArtifactOpen();
  compareArtifact(targets, targets.corpus, corpusText, repositoryRoot);
  compareArtifact(targets, targets.report, reportText, repositoryRoot);
  process.stdout.write("Seeded recall is 69/69 and committed artifacts are current.\n");
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runSeededRecallCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "seeded-recall check failed"}\n`,
    );
    process.exitCode = 1;
  }
}

export const _test = Object.freeze({
  MAX_ARTIFACT_BYTES,
  PERTURBATIONS,
  artifactPaths,
  ensureArtifactDirectory,
});
