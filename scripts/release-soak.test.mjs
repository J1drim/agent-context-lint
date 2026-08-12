import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { generateReleaseArtifactBundle } from "./release-artifacts.mjs";
import {
  canonicalJson,
  parseSoakArguments,
  RELEASE_SOAK_LIMITS,
  runSoakRehearsal,
} from "./release-soak.mjs";

const execFileAsync = promisify(execFile);

const PASSING_CLI = String.raw`#!/usr/bin/env node
const command = process.argv.slice(2).join(' ');
if (command === '--help') process.stdout.write('Agent Context Linter fixture help\n');
else if (command.startsWith('list ')) process.stdout.write(JSON.stringify({command:'list', files:[]} ) + '\n');
else if (command.startsWith('scan ')) process.stdout.write(JSON.stringify({command:'scan', diagnostics:[]} ) + '\n');
else process.exitCode = 2;
`;

const FAILING_CLI = String.raw`#!/usr/bin/env node
if (process.argv.includes('--help')) process.stdout.write('fixture help\n');
else process.exitCode = 7;
`;

const MALFORMED_CLI = String.raw`#!/usr/bin/env node
if (process.argv.includes('--help')) process.stdout.write('fixture help\n');
else process.stdout.write('not json\n');
`;

async function fixture(t, { candidateSource = PASSING_CLI, previousSource = PASSING_CLI } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-release-soak-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const workspace = path.join(root, "workspace");
  const reports = path.join(root, "reports");
  await mkdir(workspace, { recursive: true });
  await mkdir(reports, { recursive: true });
  await writeFile(path.join(workspace, "AGENTS.md"), "# Fixture instructions\n", "utf8");
  const previousInput = path.join(root, "previous-input");
  const candidateInput = path.join(root, "candidate-input");
  await mkdir(previousInput, { recursive: true });
  await mkdir(candidateInput, { recursive: true });
  const previousCli = path.join(previousInput, "cli.js");
  const candidateCli = path.join(candidateInput, "cli.js");
  await writeFile(previousCli, previousSource, { encoding: "utf8", mode: 0o644 });
  await writeFile(candidateCli, candidateSource, { encoding: "utf8", mode: 0o644 });
  const previousNotes = path.join(root, "previous-notes.md");
  const candidateNotes = path.join(root, "candidate-notes.md");
  const rollback = path.join(root, "rollback.md");
  await writeFile(previousNotes, "# Previous release\n", "utf8");
  await writeFile(candidateNotes, "# Candidate release\n", "utf8");
  await writeFile(
    rollback,
    "# Upgrade and rollback\n\nRestore the previous verified artifact.\n",
    "utf8",
  );
  const previousBundle = path.join(root, "previous-bundle");
  const candidateBundle = path.join(root, "candidate-bundle");
  await generateReleaseArtifactBundle({
    inputDirectory: previousInput,
    outputDirectory: previousBundle,
    releaseNotesPath: previousNotes,
    releaseVersion: "0.1.0",
    rollbackGuidePath: rollback,
  });
  await generateReleaseArtifactBundle({
    inputDirectory: candidateInput,
    outputDirectory: candidateBundle,
    releaseNotesPath: candidateNotes,
    releaseVersion: "0.2.0",
    rollbackGuidePath: rollback,
  });
  const report = path.join(reports, "soak.json");
  return {
    root,
    workspace,
    reports,
    report,
    output: report,
    previousBundle,
    candidateBundle,
    previousCli: path.join(previousBundle, "cli.js"),
    candidateCli: path.join(candidateBundle, "cli.js"),
  };
}

function options(values, overrides = {}) {
  return {
    ...values,
    iterations: 2,
    commandTimeoutMs: 2_000,
    totalTimeoutMs: 20_000,
    ...overrides,
  };
}

test("bounded local rehearsal repeats packaged smoke checks and verifies rollback", async (t) => {
  const values = await fixture(t, { candidateSource: PASSING_CLI.replace("fixture", "candidate") });
  const result = await runSoakRehearsal(options(values));
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, "passed");
  assert.equal(result.report.rollbackVerified, true);
  assert.equal(result.report.phases.length, 2);
  assert.equal(result.report.phases[0].outcomes.length, 6);
  assert.equal(result.report.phases[1].outcomes.length, 6);
  assert.equal(result.report.blockingFindings.length, 0);
  assert.notEqual(result.report.candidate.artifactSha256, result.report.previous.artifactSha256);
  assert.equal(result.report.harness.networkPolicy, "deny-preload");
  assert.equal(result.report.workspace.sha256.length, 64);
});

test("the rehearsal report is deterministic and contains no command output", async (t) => {
  const values = await fixture(t, { candidateSource: PASSING_CLI.replace("fixture", "candidate") });
  const first = await runSoakRehearsal(options(values, { iterations: 1 }));
  const second = await runSoakRehearsal(options(values, { iterations: 1 }));
  assert.deepEqual(first.report, second.report);
  const serialized = canonicalJson(first.report);
  assert.equal(serialized.includes("Agent Context Linter fixture help"), false);
  assert.equal(Buffer.byteLength(serialized, "utf8") <= RELEASE_SOAK_LIMITS.MAX_REPORT_BYTES, true);
});

test("accepted P2/P3 exceptions carry owner, due date, and rationale digest", async (t) => {
  const values = await fixture(t);
  const findings = path.join(values.root, "findings.json");
  await writeFile(
    findings,
    JSON.stringify([
      {
        id: "docs.example",
        severity: "P2",
        status: "accepted",
        owner: "maintainer",
        dueDate: "2026-09-01",
        rationale: "A documentation-only exception for the local rehearsal.",
      },
    ]),
  );
  const result = await runSoakRehearsal(options({ ...values, findings }));
  assert.equal(result.report.status, "passed");
  assert.deepEqual(result.report.findings[0], {
    id: "docs.example",
    severity: "P2",
    status: "accepted",
    owner: "maintainer",
    dueDate: "2026-09-01",
    rationaleSha256: "bb36af85861ddf5b11d805ff1cc4406907346246b25b54e667033a7b54dc689e",
  });
});

test("open P0/P1 input blocks execution before either phase", async (t) => {
  const values = await fixture(t);
  const findings = path.join(values.root, "findings.json");
  await writeFile(
    findings,
    JSON.stringify([
      {
        id: "crash",
        severity: "P1",
        status: "open",
        owner: "maintainer",
        dueDate: "2026-08-20",
        rationale: "Known crash remains under investigation.",
      },
    ]),
  );
  const result = await runSoakRehearsal(options({ ...values, findings }));
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.status, "blocked-p0-p1");
  assert.equal(result.report.rollbackVerified, false);
  assert.deepEqual(result.report.phases, []);
  assert.deepEqual(result.report.blockingFindings, [{ id: "crash", severity: "P1" }]);
});

test("candidate failures remain P1 findings while the previous artifact is still rehearsed", async (t) => {
  const values = await fixture(t, { candidateSource: FAILING_CLI });
  const result = await runSoakRehearsal(options(values, { iterations: 1 }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed-p1");
  assert.equal(result.report.rollbackVerified, true);
  assert.equal(result.report.phases[0].blockingFindings.length, 2);
  assert.equal(result.report.phases[1].blockingFindings.length, 0);
});

test("network and process capabilities are denied and failures are not treated as passes", async (t) => {
  const denied = String.raw`#!/usr/bin/env node
require('node:net').createConnection({host:'127.0.0.1', port:9});
`;
  const values = await fixture(t, { candidateSource: denied });
  const result = await runSoakRehearsal(options(values, { iterations: 1 }));
  assert.equal(result.report.status, "failed-p1");
  assert.equal(result.report.rollbackVerified, true);
  assert.equal(result.report.phases[0].blockingFindings.length > 0, true);
});

test("workspace mutation makes rollback unverifiable and fails closed", async (t) => {
  const mutating = String.raw`#!/usr/bin/env node
require('node:fs').writeFileSync('unexpected.txt', 'mutation');
if (process.argv.includes('--help')) process.stdout.write('help\n');
else process.stdout.write(JSON.stringify({ok:true}) + '\n');
`;
  const values = await fixture(t, { candidateSource: mutating });
  const result = await runSoakRehearsal(options(values, { iterations: 1 }));
  assert.equal(result.report.status, "failed-p1");
  assert.equal(result.report.rollbackVerified, false);
  assert.equal(result.report.phases[1].skipped, "workspace-mutated");
  assert.equal(
    result.report.blockingFindings.some(({ id }) => id === "workspace.mutated"),
    true,
  );
});

test("empty-directory and directory-mode mutations are detected by the workspace digest", async (t) => {
  const mutating = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
  fs.mkdirSync('new-empty-directory', { recursive: true });
  fs.chmodSync('mode-directory', 0o700);
if (process.argv.includes('--help')) process.stdout.write('help\n');
else process.stdout.write(JSON.stringify({ok:true}) + '\n');
`;
  const values = await fixture(t, { candidateSource: mutating });
  await mkdir(path.join(values.workspace, "mode-directory"));
  await chmod(path.join(values.workspace, "mode-directory"), 0o755);
  const result = await runSoakRehearsal(options(values, { iterations: 1 }));
  assert.equal(result.report.status, "failed-p1");
  assert.equal(result.report.rollbackVerified, false);
  assert.equal(
    result.report.blockingFindings.some(({ id }) => id === "workspace.mutated"),
    true,
  );
});

test("timeouts and malformed JSON are bounded and become P1 findings", async (t) => {
  const hanging = String.raw`#!/usr/bin/env node
setTimeout(() => {}, 5000);
`;
  const values = await fixture(t, { candidateSource: hanging });
  const timeoutResult = await runSoakRehearsal(
    options(values, { iterations: 1, commandTimeoutMs: 25, totalTimeoutMs: 5_000 }),
  );
  assert.equal(timeoutResult.report.status, "failed-p1");
  assert.equal(
    timeoutResult.report.phases[0].outcomes.some(({ timedOut }) => timedOut),
    true,
  );

  const malformedValues = await fixture(t, { candidateSource: MALFORMED_CLI });
  const malformedResult = await runSoakRehearsal(options(malformedValues, { iterations: 1 }));
  assert.equal(malformedResult.report.status, "failed-p1");
  assert.equal(
    malformedResult.report.phases[0].outcomes.some(({ invalidOutput }) => invalidOutput),
    true,
  );
});

test("input paths and release ordering are closed", async (t) => {
  const values = await fixture(t);
  assert.throws(
    () =>
      parseSoakArguments([
        "run",
        "--candidate-bundle",
        "/tmp/candidate",
        "--previous-bundle",
        "/tmp/previous",
        "--candidate-cli",
        "/tmp/candidate.js",
        "--previous-cli",
        "/tmp/previous.js",
        "--workspace",
        "/tmp/workspace",
        "--output",
        "/tmp/report.json",
        "--iterations",
        "33",
      ]),
    /between 1 and 32/u,
  );
  await assert.rejects(
    runSoakRehearsal(options({ ...values, candidateCli: path.join(values.root, "outside.js") })),
    /candidate CLI must be an existing regular/u,
  );
  await assert.rejects(
    runSoakRehearsal(options({ ...values, previousBundle: values.candidateBundle })),
    /candidate and previous bundles must be different/u,
  );
  await assert.rejects(
    runSoakRehearsal(options({ ...values, output: path.join(values.workspace, "report.json") })),
    /report output must be outside/u,
  );
});

test("the CLI writes a bounded report and uses exit 1 for a failed rehearsal", async (t) => {
  const values = await fixture(t, { candidateSource: FAILING_CLI });
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "release-soak.mjs");
  const result = await execFileAsync(
    process.execPath,
    [
      script,
      "run",
      "--candidate-bundle",
      values.candidateBundle,
      "--previous-bundle",
      values.previousBundle,
      "--candidate-cli",
      values.candidateCli,
      "--previous-cli",
      values.previousCli,
      "--workspace",
      values.workspace,
      "--output",
      values.report,
      "--iterations",
      "1",
    ],
    { cwd: values.root, encoding: "utf8" },
  ).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /"status":"failed-p1"/u);
  const report = JSON.parse(await readFile(values.report, "utf8"));
  assert.equal(report.status, "failed-p1");
  assert.equal(
    Buffer.byteLength(JSON.stringify(report), "utf8") < RELEASE_SOAK_LIMITS.MAX_REPORT_BYTES,
    true,
  );
});
