import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  GA_OBSERVATION_MAX_FILE_BYTES,
  validateGaProfileObservationReview,
} from "./validate-ga-profile-observations.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REVIEW_PATH = "conformance/observations/v0/d16/review.json";
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
});

function loadReview() {
  return JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, REVIEW_PATH), "utf8"));
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function referencedPaths(review) {
  return new Set([
    "conformance/contracts/ga-profile-observation-review.v0.schema.json",
    "conformance/contracts/real-client-observation-plan.v0.schema.json",
    "conformance/contracts/real-client-observation-transcript.v0.schema.json",
    review.inventory.path,
    ...review.entries.flatMap((entry) => [
      entry.plan.path,
      entry.transcript.path,
      ...entry.fixtures.map((reference) => reference.path),
      ...entry.supportingEvidence.map((reference) => reference.path),
    ]),
  ]);
}

function materialize(review = loadReview()) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ga-profile-observations-"));
  temporaryRoots.push(root);
  for (const relative of referencedPaths(review)) {
    const destination = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(REPOSITORY_ROOT, ...relative.split("/")), destination);
  }
  return { review, root };
}

function errorsFor(review, repositoryRoot = REPOSITORY_ROOT) {
  return validateGaProfileObservationReview(review, { repositoryRoot });
}

test("canonical review covers all seven GA surfaces with schema-valid digest-bound evidence", () => {
  assert.deepEqual(errorsFor(loadReview()), []);
});

test("repeated review validation is deterministic", () => {
  const review = loadReview();
  assert.deepEqual(errorsFor(review), errorsFor(structuredClone(review)));
});

test("closed review schema rejects unknown properties", () => {
  const review = loadReview();
  review.unreviewedAuthority = true;
  assert.match(errorsFor(review).join("\n"), /additional properties/u);
});

test("duplicate surface cannot replace a missing GA surface", () => {
  const review = loadReview();
  review.entries[1] = structuredClone(review.entries[0]);
  const errors = errorsFor(review).join("\n");
  assert.match(errors, /duplicates codex-cli/u);
  assert.match(errors, /missing GA observation review for claude-code/u);
});

test("recognized-evidence-only surface cannot enter the GA review", () => {
  const review = loadReview();
  review.entries[0].profileId = "copilot-cloud-agent";
  review.entries[0].surfaceId = "copilot-cloud-agent/github-hosted";
  assert.match(errorsFor(review).join("\n"), /allowed values/u);
});

test("blocked transcript cannot be promoted to matching behavior", () => {
  const review = loadReview();
  review.entries[1].behavioralState = "previously-observed-matching-fixture";
  review.entries[1].unresolvedClaimIds = [];
  assert.match(
    errorsFor(review).join("\n"),
    /blocked observation must remain an explicit unknown/u,
  );
});

test("explicit unknown requires named unresolved claims", () => {
  const review = loadReview();
  review.entries[2].unresolvedClaimIds = [];
  assert.match(errorsFor(review).join("\n"), /must explain an explicit unknown/u);
});

test("plan file substitution is rejected by its exact digest", () => {
  const review = loadReview();
  review.entries[0].plan.sha256 = "0".repeat(64);
  assert.match(errorsFor(review).join("\n"), /sha256 does not match/u);
});

test("fixture file substitution is rejected by its exact digest", () => {
  const review = loadReview();
  review.entries[4].fixtures[0].sha256 = "f".repeat(64);
  assert.match(errorsFor(review).join("\n"), /sha256 does not match/u);
});

test("transcript plan digest is recomputed rather than trusted", () => {
  const { review, root } = materialize();
  const entry = review.entries[0];
  const transcriptPath = path.join(root, ...entry.transcript.path.split("/"));
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  transcript.planDigest = "0".repeat(64);
  const bytes = Buffer.from(`${JSON.stringify(transcript, null, 2)}\n`);
  writeFileSync(transcriptPath, bytes);
  entry.transcript.sha256 = digest(bytes);
  assert.match(errorsFor(review, root).join("\n"), /transcript planDigest is stale/u);
});

test("fixture profile substitution is rejected after valid D01 parsing", () => {
  const { review, root } = materialize();
  const entry = review.entries[2];
  const fixturePath = path.join(root, ...entry.fixtures[0].path.split("/"));
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  fixture.profile.profileId = "copilot-vscode";
  fixture.profile.surfaceId = "copilot-vscode/local-chat";
  const bytes = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`);
  writeFileSync(fixturePath, bytes);
  entry.fixtures[0].sha256 = digest(bytes);
  assert.match(errorsFor(review, root).join("\n"), /profile\/surface does not match/u);
});

test("first-party source substitution is rejected", () => {
  const review = loadReview();
  review.entries[4].clientPin.sourceUrl = "https://example.invalid/release/v0.53.1";
  assert.match(errorsFor(review).join("\n"), /not an approved first-party source/u);
});

test("future release metadata is rejected", () => {
  const review = loadReview();
  review.entries[2].clientPin.publishedAt = "2027-01-01T00:00:00Z";
  assert.match(errorsFor(review).join("\n"), /publishedAt is after the review/u);
});

test("non-exact fixture relation requires a mismatch disposition", () => {
  const review = loadReview();
  review.entries[3].mismatches = [];
  assert.match(errorsFor(review).join("\n"), /must document non-exact fixture version evidence/u);
});

test("symlinked evidence cannot escape or alias the review root", () => {
  const { review, root } = materialize();
  const reference = review.entries[5].supportingEvidence[0];
  const evidencePath = path.join(root, ...reference.path.split("/"));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
  temporaryRoots.push(outside);
  writeFileSync(outside, readFileSync(evidencePath));
  unlinkSync(evidencePath);
  symlinkSync(outside, evidencePath);
  assert.match(errorsFor(review, root).join("\n"), /ordinary non-symbolic-link file/u);
});

test("oversized referenced evidence is rejected before hashing", () => {
  const { review, root } = materialize();
  const reference = review.entries[6].supportingEvidence[0];
  const evidencePath = path.join(root, ...reference.path.split("/"));
  const bytes = Buffer.alloc(GA_OBSERVATION_MAX_FILE_BYTES + 1, 0x61);
  writeFileSync(evidencePath, bytes);
  reference.sha256 = digest(bytes);
  assert.match(errorsFor(review, root).join("\n"), /exceeds 4194304 bytes/u);
});

test("an unresolved repository root fails closed", () => {
  assert.deepEqual(errorsFor(loadReview(), path.join(os.tmpdir(), "missing-ga-review-root")), [
    "repository root could not be resolved",
  ]);
});

test("missing contract schema fails before artifact review", () => {
  const { review, root } = materialize();
  unlinkSync(
    path.join(root, "conformance/contracts/real-client-observation-transcript.v0.schema.json"),
  );
  assert.deepEqual(errorsFor(review, root), ["observation schemas could not be compiled"]);
});

test("missing referenced evidence returns a bounded error", () => {
  const { review, root } = materialize();
  const reference = review.entries[0].supportingEvidence[0];
  unlinkSync(path.join(root, ...reference.path.split("/")));
  assert.match(errorsFor(review, root).join("\n"), /path could not be read safely/u);
});

test("malformed transcript JSON is rejected without throwing", () => {
  const { review, root } = materialize();
  const reference = review.entries[0].transcript;
  const transcriptPath = path.join(root, ...reference.path.split("/"));
  const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
  writeFileSync(transcriptPath, bytes);
  reference.sha256 = digest(bytes);
  assert.match(errorsFor(review, root).join("\n"), /must contain valid UTF-8 JSON/u);
});

test("transcript parity rejects field, fixture, and behavioral-sequence drift", () => {
  const { review, root } = materialize();
  const entry = review.entries[0];
  const transcriptPath = path.join(root, ...entry.transcript.path.split("/"));
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  transcript.caseId = "substituted-case";
  transcript.fixtureDigest = "0".repeat(64);
  transcript.fixtureManifest[0].sha256 = "f".repeat(64);
  transcript.actualLoadedSourceSequence = ["AGENTS.md"];
  const bytes = Buffer.from(`${JSON.stringify(transcript, null, 2)}\n`);
  writeFileSync(transcriptPath, bytes);
  entry.transcript.sha256 = digest(bytes);
  const errors = errorsFor(review, root).join("\n");
  assert.match(errors, /plan\/transcript caseId values differ/u);
  assert.match(errors, /transcript fixtureDigest is stale/u);
  assert.match(errors, /fixture manifest does not match/u);
  assert.match(errors, /must not claim behavioral source loading/u);
});

test("failed metadata result cannot satisfy a matching observation", () => {
  const { review, root } = materialize();
  const entry = review.entries[0];
  const transcriptPath = path.join(root, ...entry.transcript.path.split("/"));
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  transcript.result.status = "failed";
  transcript.result.versionMatched = false;
  const bytes = Buffer.from(`${JSON.stringify(transcript, null, 2)}\n`);
  writeFileSync(transcriptPath, bytes);
  entry.transcript.sha256 = digest(bytes);
  assert.match(errorsFor(review, root).join("\n"), /not a successful matching version probe/u);
});

test("canonical surface version and matching-state uncertainty are cross-checked", () => {
  const review = loadReview();
  review.entries[0].clientPin.version = "0.146.1";
  review.entries[0].unresolvedClaimIds = ["unexpected-gap"];
  const errors = errorsFor(review).join("\n");
  assert.match(errors, /differs from the canonical surface inventory/u);
  assert.match(errors, /must be empty for a matching fixture/u);
});

test("entry profile cannot be substituted independently of its plan", () => {
  const review = loadReview();
  const entry = review.entries[0];
  entry.profileId = "cursor-agent";
  entry.surfaceId = "cursor-agent/ide";
  entry.id = "cursor-agent/cursor-agent/ide";
  entry.clientPin.sourceUrl = "https://cursor.com/docs/rules";
  entry.clientPin.version = "3.12.30";
  assert.match(errorsFor(review).join("\n"), /plan profile\/surface does not match/u);
});

test("release evidence must be retrieved on the review date", () => {
  const review = loadReview();
  review.entries[0].clientPin.retrievedAt = "2026-08-01";
  assert.match(errorsFor(review).join("\n"), /retrievedAt must equal the review date/u);
});

test("schema-invalid transcript is reported at its entry", () => {
  const { review, root } = materialize();
  const entry = review.entries[1];
  const transcriptPath = path.join(root, ...entry.transcript.path.split("/"));
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  delete transcript.result;
  const bytes = Buffer.from(`${JSON.stringify(transcript, null, 2)}\n`);
  writeFileSync(transcriptPath, bytes);
  entry.transcript.sha256 = digest(bytes);
  assert.match(errorsFor(review, root).join("\n"), /transcript.*required/u);
});

test("exact fixture version is checked against the client pin", () => {
  const review = loadReview();
  review.entries[2].clientPin.version = "1.0.78";
  assert.match(errorsFor(review).join("\n"), /client version does not exactly match the pin/u);
});

test("unpinned relation requires a null-version fixture", () => {
  const review = loadReview();
  const exactFixture = structuredClone(review.entries[2].fixtures[0]);
  review.entries[3].fixtures = [exactFixture];
  assert.match(errorsFor(review).join("\n"), /claims an unpinned fixture/u);
});

test("plans, transcripts, and fixtures cannot be shared across surface owners", () => {
  const review = loadReview();
  review.entries[1].fixtures = [structuredClone(review.entries[0].fixtures[0])];
  assert.match(errorsFor(review).join("\n"), /reuses a plan, transcript, or fixture/u);
});

test("command-line validator accepts the canonical review and rejects malformed invocation", () => {
  const tool = path.join(REPOSITORY_ROOT, "tools/conformance/validate-ga-profile-observations.mjs");
  const valid = spawnSync(process.execPath, [tool, path.join(REPOSITORY_ROOT, REVIEW_PATH)], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /valid .*conformance\/observations\/v0\/d16\/review\.json/u);

  const usage = spawnSync(process.execPath, [tool], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage:/u);
});

test("command-line validator reports invalid evidence and malformed JSON", () => {
  const tool = path.join(REPOSITORY_ROOT, "tools/conformance/validate-ga-profile-observations.mjs");
  const root = mkdtempSync(path.join(os.tmpdir(), "ga-profile-observations-cli-"));
  temporaryRoots.push(root);

  const invalidReview = loadReview();
  invalidReview.entries[0].plan.sha256 = "0".repeat(64);
  const invalidPath = path.join(root, "invalid-review.json");
  writeFileSync(invalidPath, `${JSON.stringify(invalidReview)}\n`);
  const invalid = spawnSync(process.execPath, [tool, invalidPath], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /sha256 does not match/u);

  const malformedPath = path.join(root, "malformed-review.json");
  writeFileSync(malformedPath, "{");
  const malformed = spawnSync(process.execPath, [tool, malformedPath], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /JSON/u);
});
