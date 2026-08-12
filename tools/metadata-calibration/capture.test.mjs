import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCalibrationCaptureAccumulator,
  createCapturedCalibrationReport,
  projectCalibrationScan,
  validatePrivateReviewBundle,
} from "./capture.mjs";

const REFERENCE = JSON.parse(
  readFileSync("packages/cli/reference/agent-context-lint-reference.v1.json", "utf8"),
);
const DEFAULT_SEVERITIES = new Map(
  REFERENCE.rules.entries.map((rule) => [rule.id, rule.defaultSeverity]),
);
const ENGINE = Object.freeze({
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
});

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function position(byteOffset = 0) {
  return { byteOffset, line: 0, utf16Column: byteOffset, utf16Offset: byteOffset };
}

function location(index = 0) {
  return {
    path: `private/path-${String(index)}.md`,
    range: { end: position(1), sourceId: `source:${String(index)}`, start: position() },
    sourceDigest: sha(`source-${String(index)}`),
    sourceId: `source:${String(index)}`,
  };
}

function diagnostic(index, severity = "error") {
  return {
    fingerprintBasis: {
      path: { anchor: `private/path-${String(index)}.md`, profileIds: ["codex-cli"] },
      semantic: {
        components: [{ key: "private", value: "review only" }],
        profileIds: ["codex-cli"],
      },
    },
    fingerprints: {
      path: { method: "agent-context-lint/path/v1", value: sha(`path-${String(index)}`) },
      semantic: {
        method: "agent-context-lint/semantic/v1",
        value: sha(`semantic-${String(index)}`),
      },
    },
    id: `diagnostic:${String(index)}`,
    message: `private diagnostic explanation ${String(index)}`,
    primary: location(index),
    related: [],
    ruleId: index % 2 === 0 ? "ACL250" : "ACL301",
    ruleVersion: "1.0.0",
    severity,
    suggestion: null,
  };
}

function output(entries, suppressed = []) {
  const active = entries.filter((entry) => !suppressed.includes(entry.fingerprints.path.value));
  return {
    diagnostics: {
      contractVersion: "0.1.0",
      diagnostics: entries,
      recordKind: "agent-context-diagnostics",
      suppressions: suppressed.map((fingerprint, index) => ({
        directive: location(index + 10_000),
        evidence: [],
        id: `suppression:${String(index)}`,
        matchedPathFingerprints: [fingerprint],
        reason: "fixture",
        state: "suppressed",
        targetRuleIds: ["ACL250"],
      })),
    },
    failureThreshold: "never",
    profileVersions: { "codex-cli": { clientVersion: null, profileVersion: "1.0.0" } },
    recordKind: "agent-context-scan-output",
    schemaVersion: "1.0.0",
    summary: {
      errors: active.filter((entry) => entry.severity === "error").length,
      exitCode: 0,
      infos: active.filter((entry) => entry.severity === "info").length,
      suppressed: new Set(suppressed).size,
      warnings: active.filter((entry) => entry.severity === "warning").length,
    },
  };
}

test("capture projects unsuppressed packaged-default error/warning identities", () => {
  const first = diagnostic(1, "error");
  const second = diagnostic(2, "warning");
  const informational = diagnostic(3, "info");
  const result = projectCalibrationScan(
    "123",
    output([first, second, informational], [second.fingerprints.path.value]),
    DEFAULT_SEVERITIES,
  );
  assert.equal(result.publicDiagnostics.length, 2);
  assert.equal(result.publicDiagnostics[0].severity, "warning");
  assert.equal(result.publicDiagnostics[0].effectiveSeverity, "error");
  assert.equal(result.publicDiagnostics[1].effectiveSeverity, "info");
  assert.equal(result.privateDiagnostics[0].diagnostic.message, first.message);
  const serialized = JSON.stringify(result.publicDiagnostics);
  assert.doesNotMatch(serialized, /private|message|primary|fingerprintBasis/);
});

test("capture rejects malformed identities and summary mismatches", () => {
  const malformed = diagnostic(1);
  malformed.fingerprints.path.value = "not-a-sha";
  assert.throws(
    () => projectCalibrationScan("123", output([malformed]), DEFAULT_SEVERITIES),
    /published B05\/B04 schemas/,
  );
  const mismatched = output([diagnostic(2, "warning")]);
  mismatched.summary.warnings = 0;
  assert.throws(() => projectCalibrationScan("123", mismatched, DEFAULT_SEVERITIES), /summary/);
  const accessor = output([diagnostic(3)]);
  Object.defineProperty(accessor.diagnostics.diagnostics[0].primary, "secret", {
    enumerable: true,
    get: () => "do not inspect",
  });
  assert.throws(() => projectCalibrationScan("123", accessor, DEFAULT_SEVERITIES), /accessors/);
  const unknown = output([diagnostic(4)]);
  unknown.diagnostics.diagnostics[0].repositoryContent = "must not enter private evidence";
  assert.throws(
    () => projectCalibrationScan("123", unknown, DEFAULT_SEVERITIES),
    /published B05\/B04 schemas/,
  );
});

test("capture rejects non-data arrays before any caller-controlled iteration", () => {
  const entry = diagnostic(10);
  for (const badArray of [
    new Proxy([entry], {}),
    new (class extends Array {})(entry),
    new Array(1),
  ]) {
    const candidate = output([entry]);
    candidate.diagnostics.diagnostics = badArray;
    assert.throws(
      () => projectCalibrationScan("123", candidate, DEFAULT_SEVERITIES),
      /proxies|Array.prototype|dense/,
    );
  }

  const accessorArray = [entry];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => entry });
  const withAccessor = output([entry]);
  withAccessor.diagnostics.diagnostics = accessorArray;
  assert.throws(() => projectCalibrationScan("123", withAccessor, DEFAULT_SEVERITIES), /accessors/);
});

test("capture enforces published schema versions, fingerprint methods, and output relations", () => {
  const wrongSchema = output([diagnostic(20)]);
  wrongSchema.schemaVersion = "2.0.0";
  assert.throws(
    () => projectCalibrationScan("123", wrongSchema, DEFAULT_SEVERITIES),
    /published B05\/B04 schemas/,
  );

  const wrongContract = output([diagnostic(21)]);
  wrongContract.diagnostics.contractVersion = "0.2.0";
  assert.throws(
    () => projectCalibrationScan("123", wrongContract, DEFAULT_SEVERITIES),
    /published B05\/B04 schemas/,
  );

  const wrongMethod = output([diagnostic(22)]);
  wrongMethod.diagnostics.diagnostics[0].fingerprints.path.method = "sha256-path-v1";
  assert.throws(
    () => projectCalibrationScan("123", wrongMethod, DEFAULT_SEVERITIES),
    /published B05\/B04 schemas/,
  );

  const wrongInfos = output([diagnostic(23, "info")]);
  wrongInfos.summary.infos = 0;
  assert.throws(() => projectCalibrationScan("123", wrongInfos, DEFAULT_SEVERITIES), /summary/);

  const wrongExit = output([diagnostic(24)]);
  wrongExit.failureThreshold = "error";
  assert.throws(() => projectCalibrationScan("123", wrongExit, DEFAULT_SEVERITIES), /exit code/);

  const wrongProfiles = output([diagnostic(25)]);
  wrongProfiles.profileVersions = {
    "claude-code": { clientVersion: null, profileVersion: "1.0.0" },
  };
  assert.throws(
    () => projectCalibrationScan("123", wrongProfiles, DEFAULT_SEVERITIES),
    /profile identities/,
  );
});

test("capture uses packaged default severity and rejects aggregate excess before retention", async () => {
  const overridden = projectCalibrationScan(
    "123",
    output([diagnostic(30, "warning")]),
    DEFAULT_SEVERITIES,
  );
  assert.equal(overridden.publicDiagnostics[0].severity, "error");
  assert.equal(overridden.publicDiagnostics[0].effectiveSeverity, "warning");

  const corpus = JSON.parse(await readFile("calibration/metadata/v0/corpus.json", "utf8"));
  const accumulator = createCalibrationCaptureAccumulator({
    corpus,
    defaultSeverityByRule: DEFAULT_SEVERITIES,
    engine: ENGINE,
    generatedAt: "2026-08-09T04:00:00.000Z",
    limits: { maximumDiagnostics: 1 },
  });
  accumulator.add(corpus.repositories[0].repositoryId, output([diagnostic(32)]));
  assert.throws(
    () => accumulator.add(corpus.repositories[1].repositoryId, output([diagnostic(34)])),
    /aggregate calibration capture/,
  );
  assert.deepEqual(accumulator.state(), {
    diagnosticCount: 1,
    privateBytes: accumulator.state().privateBytes,
    publicBytes: accumulator.state().publicBytes,
    repositoryCount: 1,
  });
});

test("complete capture binds all 50 selected repositories and keeps explanations private", async () => {
  const corpus = JSON.parse(await readFile("calibration/metadata/v0/corpus.json", "utf8"));
  const repositoryOutputs = new Map(
    corpus.repositories.map((repository, index) => [
      repository.repositoryId,
      output([diagnostic(index * 2), diagnostic(index * 2 + 1, "warning")]),
    ]),
  );
  const captured = createCapturedCalibrationReport({
    corpus,
    defaultSeverityByRule: DEFAULT_SEVERITIES,
    engine: ENGINE,
    generatedAt: "2026-08-09T04:00:00.000Z",
    repositoryOutputs,
  });
  assert.equal(captured.report.diagnostics.length, 100);
  assert.equal(captured.privateReviewBundle.repositories.length, 50);
  assert.equal(captured.privateReviewBundle.mustNotCommit, true);
  assert.equal(
    validatePrivateReviewBundle(captured.report, captured.privateReviewBundle).valid,
    true,
  );
  const wrapperInjection = structuredClone(captured.privateReviewBundle);
  wrapperInjection.repositories[0].checkout.unboundSourcePath = "/private/source";
  assert.match(
    validatePrivateReviewBundle(captured.report, wrapperInjection).errors.join("\n"),
    /unbound wrapper fields/,
  );
  assert.doesNotMatch(JSON.stringify(captured.report), /private\/path|review only|explanation/);
  repositoryOutputs.delete(corpus.repositories[0].repositoryId);
  assert.throws(
    () =>
      createCapturedCalibrationReport({
        corpus,
        defaultSeverityByRule: DEFAULT_SEVERITIES,
        engine: ENGINE,
        generatedAt: "2026-08-09T04:00:00.000Z",
        repositoryOutputs,
      }),
    /exactly one scan output/,
  );
});
