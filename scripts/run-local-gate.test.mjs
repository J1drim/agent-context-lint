import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCAL_GATE_REPORT_VERSION,
  parseLocalGateArguments,
  parsePushReferences,
  validateLocalGateReport,
} from "./run-local-gate.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("local gate arguments support a review report and push verification", () => {
  assert.equal(parseLocalGateArguments(["--report", "review/local-gate.json"]).mode, "run");
  assert.equal(parseLocalGateArguments(["--verify-push"]).mode, "verify-push");
  assert.throws(() => parseLocalGateArguments(["--report"]), /needs a path/u);
});

test("pre-push reference parsing ignores deletes and preserves exact object IDs", () => {
  const references = parsePushReferences(
    [
      "refs/heads/main " + "a".repeat(40) + " refs/heads/main " + "b".repeat(40),
      "(delete) " + "0".repeat(40) + " refs/heads/old " + "c".repeat(40),
    ].join("\n"),
  );
  assert.equal(references.length, 2);
  assert.equal(references[0].localSha, "a".repeat(40));
  assert.throws(
    () => parsePushReferences("refs/heads/main nope refs/heads/main nope\n"),
    /object ID/u,
  );
});

test("a gate report is accepted only for the pushed commit and current lockfile", () => {
  const report = {
    reportVersion: LOCAL_GATE_REPORT_VERSION,
    status: "passed",
    commit: "a".repeat(40),
    lockfileSha256: "b".repeat(64),
    commands: ["pnpm check"],
  };
  assert.equal(
    validateLocalGateReport(report, {
      commit: report.commit,
      lockfileSha256: report.lockfileSha256,
    }),
    report,
  );
  assert.throws(
    () => validateLocalGateReport(report, { commit: "c".repeat(40) }),
    /not pushed commit/u,
  );
  assert.throws(() => validateLocalGateReport({ ...report, status: "failed" }), /did not pass/u);
});

test("the pre-push verifier consumes streamed stdin on the current Node runtime", () => {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).stdout.trim();
  const lockfileSha256 = createHash("sha256")
    .update(readFileSync(path.join(repositoryRoot, "pnpm-lock.yaml")))
    .digest("hex");
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "agent-context-local-gate-test-"));
  const reportPath = path.join(temporaryRoot, "report.json");
  try {
    writeFileSync(
      reportPath,
      JSON.stringify({
        reportVersion: LOCAL_GATE_REPORT_VERSION,
        status: "passed",
        commit,
        lockfileSha256,
        commands: ["pnpm check"],
      }),
      { mode: 0o600 },
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(repositoryRoot, "scripts/run-local-gate.mjs"),
        "--verify-push",
        "--report",
        reportPath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        input: `refs/heads/test ${commit} refs/heads/test ${"b".repeat(40)}\n`,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Local gate report accepted/u);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
