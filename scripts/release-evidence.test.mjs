import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  canonicalJson,
  createMonitoringReport,
  createRetrospectiveReport,
  main,
  parseEvidenceArguments,
  RELEASE_EVIDENCE_LIMITS,
} from "./release-evidence.mjs";

const DIGEST = "a".repeat(64);
const PREVIOUS_DIGEST = "b".repeat(64);
const EVIDENCE = Object.freeze({ text: "bounded local evidence" });

function monitorInput(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: "offline-local",
    observedAt: "2026-08-11T00:00:00Z",
    release: {
      version: "1.0.0",
      artifactSha256: DIGEST,
      previousVersion: "0.9.0",
      previousArtifactSha256: PREVIOUS_DIGEST,
    },
    checks: [
      { id: "install", kind: "package-install", status: "pass", durationMs: 12, stdout: EVIDENCE },
      { id: "registry", kind: "registry", status: "pass", durationMs: 13, stdout: EVIDENCE },
      { id: "docs", kind: "docs", status: "pass", durationMs: 14, stdout: EVIDENCE },
      { id: "action", kind: "action", status: "pass", durationMs: 15, stdout: EVIDENCE },
      { id: "rollback", kind: "rollback", status: "pass", durationMs: 16, stdout: EVIDENCE },
    ],
    signals: [],
    rollback: { status: "verified", evidence: EVIDENCE },
    policy: {
      networkAccess: "not-used",
      credentials: "none",
      repositoryMutation: "not-observed",
    },
    ...overrides,
  };
}

function retrospectiveInput(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: "offline-local",
    release: { version: "1.0.0", artifactSha256: DIGEST },
    releaseAt: "2026-01-01T00:00:00Z",
    review72h: { status: "complete", observedAt: "2026-01-04T00:00:00Z", notes: EVIDENCE },
    retrospective30d: {
      status: "complete",
      observedAt: "2026-02-01T00:00:00Z",
      notes: EVIDENCE,
    },
    metrics: [
      { id: "install-success", value: 99.5, unit: "percent", denominator: 100, evidence: EVIDENCE },
      { id: "diagnostics-reviewed", value: 12, unit: "count", evidence: EVIDENCE },
    ],
    incidents: [],
    falsePositives: {
      diagnosticsReviewed: 12,
      confirmedFalsePositives: 1,
      escapedFindings: 0,
      evidence: EVIDENCE,
    },
    decisions: [
      {
        id: "retain-offline-default",
        disposition: "keep",
        owner: "maintainer",
        dueDate: "2026-03-01",
        rationale: EVIDENCE,
      },
    ],
    policy: {
      networkAccess: "not-used",
      credentials: "none",
      repositoryMutation: "not-observed",
    },
    ...overrides,
  };
}

async function validator(filename) {
  const schema = JSON.parse(await readFile(path.join("docs/contracts", filename), "utf8"));
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

test("monitor report is deterministic, redacts output, and remains explicitly pre-publication", async () => {
  const first = createMonitoringReport(monitorInput());
  const second = createMonitoringReport(monitorInput());
  assert.deepEqual(first, second);
  assert.equal(first.assessment, "preflight-ready");
  assert.equal(first.policy.publicationVerification, "pending-external");
  assert.equal(first.policy.monitoringDuration, "not-established");
  const serialized = canonicalJson(first);
  assert.equal(serialized.includes("bounded local evidence"), false);
  assert.equal(first.reportSha256.length, 64);
  assert.equal(serialized.length <= RELEASE_EVIDENCE_LIMITS.MAX_OUTPUT_BYTES, true);
  const validate = await validator("release-monitoring-report.v1.schema.json");
  assert.equal(validate(first), true, JSON.stringify(validate.errors));
});

test("unknown external checks produce pending-external rather than a false pass", () => {
  const input = monitorInput({
    checks: monitorInput().checks.map((check) =>
      check.id === "registry" ? { ...check, status: "unknown", evidence: EVIDENCE } : check,
    ),
  });
  const report = createMonitoringReport(input);
  assert.equal(report.assessment, "pending-external");
  assert.equal(report.checks.find(({ id }) => id === "registry").status, "unknown");
});

test("failures, triggered P1 signals, and failed rollback block the monitor report", () => {
  const input = monitorInput({
    checks: monitorInput().checks.map((check) =>
      check.id === "docs" ? { ...check, status: "fail", evidence: EVIDENCE } : check,
    ),
    signals: [
      { id: "crash-rate", severity: "P1", state: "triggered", count: 1, evidence: EVIDENCE },
    ],
    rollback: { status: "failed", evidence: EVIDENCE },
  });
  const report = createMonitoringReport(input);
  assert.equal(report.assessment, "blocked");
});

test("monitor validation rejects hostile fields, credentials, duplicates, and unsafe policy", () => {
  assert.throws(
    () => createMonitoringReport({ ...monitorInput(), secret: "token=leaked" }),
    /unknown field secret/u,
  );
  assert.throws(
    () =>
      createMonitoringReport({
        ...monitorInput(),
        policy: { networkAccess: "used", credentials: "none", repositoryMutation: "not-observed" },
      }),
    /policy\.networkAccess is invalid/u,
  );
  assert.throws(
    () =>
      createMonitoringReport({
        ...monitorInput(),
        checks: monitorInput().checks.map((check, index) =>
          index === 1 ? { ...check, id: "install" } : check,
        ),
      }),
    /checks contains duplicate/u,
  );
  assert.throws(
    () =>
      createMonitoringReport({
        ...monitorInput(),
        checks: monitorInput().checks.map((check) =>
          check.id === "install" ? { ...check, stdout: { text: "token=do-not-store" } } : check,
        ),
      }),
    /credential/u,
  );
  assert.throws(
    () => createMonitoringReport({ ...monitorInput(), rollback: { status: "verified" } }),
    /rollback\.evidence is required/u,
  );
});

test("monitor report requires a newer distinct release", () => {
  assert.throws(
    () =>
      createMonitoringReport({
        ...monitorInput(),
        release: { ...monitorInput().release, version: "0.8.0" },
      }),
    /newer/u,
  );
  assert.throws(
    () =>
      createMonitoringReport({
        ...monitorInput(),
        release: { ...monitorInput().release, previousArtifactSha256: DIGEST },
      }),
    /distinct digests/u,
  );
});

test("complete retrospective validates 72-hour and 30-day boundaries and redacts narrative", async () => {
  const report = createRetrospectiveReport(retrospectiveInput());
  assert.equal(report.assessment, "ready-for-human-review");
  assert.equal(report.policy.humanReview, "required");
  assert.equal(canonicalJson(report).includes("bounded local evidence"), false);
  const validate = await validator("release-retrospective-report.v1.schema.json");
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
});

test("pending retrospective cannot be mistaken for the 72-hour or 30-day gate", () => {
  const report = createRetrospectiveReport(
    retrospectiveInput({
      review72h: { status: "pending" },
      retrospective30d: { status: "pending" },
    }),
  );
  assert.equal(report.assessment, "pending-external");
  assert.equal(report.review72h.observedAt, undefined);
  assert.equal(report.retrospective30d.observedAt, undefined);
});

test("open P0/P1 incidents block retrospective and require remediation evidence", () => {
  const incident = {
    id: "release-crash",
    severity: "P1",
    status: "open",
    owner: "maintainer",
    dueDate: "2026-03-01",
    summary: EVIDENCE,
    impact: EVIDENCE,
    remediation: EVIDENCE,
  };
  assert.equal(
    createRetrospectiveReport(retrospectiveInput({ incidents: [incident] })).assessment,
    "blocked",
  );
  assert.throws(
    () =>
      createRetrospectiveReport(
        retrospectiveInput({ incidents: [{ ...incident, remediation: undefined }] }),
      ),
    /remediation is required/u,
  );
});

test("retrospective rejects early observations, invalid metrics, duplicate IDs, and unowned decisions", () => {
  assert.throws(
    () =>
      createRetrospectiveReport(
        retrospectiveInput({
          review72h: { status: "complete", observedAt: "2026-01-02T00:00:00Z" },
        }),
      ),
    /at least 72 hours/u,
  );
  assert.throws(
    () =>
      createRetrospectiveReport(
        retrospectiveInput({
          metrics: [{ id: "bad", value: 2, unit: "ratio", evidence: EVIDENCE }],
        }),
      ),
    /ratio must be between/u,
  );
  assert.throws(
    () =>
      createRetrospectiveReport(
        retrospectiveInput({
          decisions: retrospectiveInput().decisions.map((decision) => ({ ...decision, owner: "" })),
        }),
      ),
    /owner must be/u,
  );
  assert.throws(
    () =>
      createRetrospectiveReport(
        retrospectiveInput({
          metrics: retrospectiveInput().metrics.concat({
            ...retrospectiveInput().metrics[0],
            id: "diagnostics-reviewed",
          }),
        }),
      ),
    /metrics contains duplicate/u,
  );
});

test("CLI argument parser is closed and requires distinct absolute paths", () => {
  assert.deepEqual(
    parseEvidenceArguments([
      "monitor",
      "--input",
      "/tmp/input.json",
      "--output",
      "/tmp/output.json",
    ]),
    { command: "monitor", input: "/tmp/input.json", output: "/tmp/output.json" },
  );
  assert.throws(
    () => parseEvidenceArguments(["monitor", "--input", "relative", "--output", "/tmp/out"]),
    /absolute path/u,
  );
  assert.throws(
    () => parseEvidenceArguments(["monitor", "--input", "/tmp/a", "--output", "/tmp/a"]),
    /different files/u,
  );
  assert.throws(
    () =>
      parseEvidenceArguments([
        "monitor",
        "--input",
        "/tmp/a",
        "--output",
        "/tmp/b",
        "--network",
        "yes",
      ]),
    /unknown option/u,
  );
});

test("reports cannot be changed into permissive artifacts without schema failure", async () => {
  const validateMonitor = await validator("release-monitoring-report.v1.schema.json");
  const monitor = createMonitoringReport(monitorInput());
  assert.equal(validateMonitor({ ...monitor, credentials: "secret" }), false);
  const validateRetro = await validator("release-retrospective-report.v1.schema.json");
  const retrospective = createRetrospectiveReport(retrospectiveInput());
  assert.equal(
    validateRetro({
      ...retrospective,
      policy: { ...retrospective.policy, credentials: "ambient" },
    }),
    false,
  );
});

test("CLI writes one canonical report and refuses an existing output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-evidence-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input.json");
  const output = path.join(root, "monitor.json");
  await writeFile(input, canonicalJson(monitorInput()), { encoding: "utf8", mode: 0o600 });
  assert.equal(await main(["monitor", "--input", input, "--output", output]), 0);
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.assessment, "preflight-ready");
  await assert.rejects(
    main(["monitor", "--input", input, "--output", output]),
    (error) => error?.code === "EEXIST",
  );
});
