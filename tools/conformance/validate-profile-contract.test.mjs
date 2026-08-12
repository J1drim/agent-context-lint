import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { validateFixture, validateProfileMap } from "./validate-profile-contract.mjs";

const map = JSON.parse(
  fs.readFileSync("conformance/contracts/profile-surface-map.v0.json", "utf8"),
);
const deterministicFixture = JSON.parse(
  fs.readFileSync("conformance/fixtures/v0/codex-root-order.fixture.json", "utf8"),
);
const ambiguousFixture = JSON.parse(
  fs.readFileSync(
    "conformance/fixtures/v0/copilot-vscode-description-ambiguity.fixture.json",
    "utf8",
  ),
);

function clone(value) {
  return structuredClone(value);
}

function assertHasError(errors, pattern) {
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `expected an error matching ${pattern}, received:\n${errors.join("\n")}`,
  );
}

test("canonical profile/surface mapping is internally consistent", () => {
  assert.deepEqual(validateProfileMap(map), []);
});

test("canonical inventory preserves all profile and surface identities", () => {
  assert.deepEqual(
    map.profiles.map((profile) => profile.id),
    [
      "codex-cli",
      "claude-code",
      "copilot-cli",
      "copilot-vscode",
      "copilot-cloud-agent",
      "copilot-code-review",
      "gemini-cli",
      "cursor-agent",
    ],
  );
  assert.deepEqual(
    map.surfaces.map((surface) => surface.id),
    [
      "codex-cli/local-cli-single-cwd",
      "claude-code/local-session",
      "copilot-cli/local-terminal",
      "copilot-vscode/local-chat",
      "copilot-cloud-agent/github-hosted",
      "copilot-code-review/github-hosted",
      "gemini-cli/local-terminal",
      "cursor-agent/ide",
      "cursor-agent/cli",
    ],
  );
});

test("canonical inventory pins default names and root-marker states", () => {
  const byId = new Map(map.surfaces.map((surface) => [surface.id, surface]));
  assert.deepEqual(byId.get("codex-cli/local-cli-single-cwd").rootMarkers.default, [".git"]);
  assert.deepEqual(byId.get("gemini-cli/local-terminal").rootMarkers.default, [".git"]);
  assert.deepEqual(byId.get("claude-code/local-session").rootMarkers.default, []);
  assert.equal(byId.get("copilot-cli/local-terminal").rootMarkers.evidenceStatus, "unknown");
  assert.ok(byId.get("cursor-agent/cli").defaultInstructionNames.includes("CLAUDE.md"));
  assert.ok(byId.get("cursor-agent/ide").defaultInstructionNames.includes(".cursorrules"));
});

test("accepts deterministic fixture with explicitly empty ambiguities", () => {
  assert.deepEqual(validateFixture(deterministicFixture, map), []);
});

test("accepts an explicitly empty instruction file", () => {
  const fixture = clone(deterministicFixture);
  fixture.repository.files[0].content = "";
  assert.deepEqual(validateFixture(fixture, map), []);
});

test("accepts fixture with referenced contradiction alternatives", () => {
  assert.deepEqual(validateFixture(ambiguousFixture, map), []);
});

test("rejects missing provenance", () => {
  const fixture = clone(deterministicFixture);
  delete fixture.provenance;
  assertHasError(validateFixture(fixture, map), /fixture\.provenance must be an object/);
});

test("rejects empty provenance sources", () => {
  const fixture = clone(deterministicFixture);
  fixture.provenance.sources = [];
  assertHasError(validateFixture(fixture, map), /fixture\.provenance\.sources must not be empty/);
});

test("rejects fixture that omits explicit ambiguity collection", () => {
  const fixture = clone(deterministicFixture);
  delete fixture.expectedGraph.ambiguities;
  assertHasError(
    validateFixture(fixture, map),
    /fixture\.expectedGraph\.ambiguities must be an array/,
  );
});

test("rejects complete analysis status when ambiguities exist", () => {
  const fixture = clone(ambiguousFixture);
  fixture.expectedGraph.analysisStatus = "complete";
  assertHasError(
    validateFixture(fixture, map),
    /analysisStatus cannot be complete when ambiguities are present/,
  );
});

test("rejects non-deterministic assertion without ambiguity reference", () => {
  const fixture = clone(ambiguousFixture);
  delete fixture.assertions[1].ambiguityId;
  assertHasError(
    validateFixture(fixture, map),
    /fixture\.assertions\[1\]\.ambiguityId must be a non-empty string/,
  );
});

test("rejects unresolved ambiguity identifier", () => {
  const fixture = clone(ambiguousFixture);
  fixture.expectedGraph.edges[0].ambiguityId = "ambiguity-does-not-exist";
  assertHasError(
    validateFixture(fixture, map),
    /ambiguityId references unknown ambiguity ambiguity-does-not-exist/,
  );
});

test("rejects ambiguity with fewer than two alternatives", () => {
  const fixture = clone(ambiguousFixture);
  fixture.expectedGraph.ambiguities[0].alternatives.pop();
  assertHasError(
    validateFixture(fixture, map),
    /alternatives must contain at least two alternatives/,
  );
});

test("rejects mismatched profile and surface", () => {
  const fixture = clone(deterministicFixture);
  fixture.profile.profileId = "gemini-cli";
  assertHasError(validateFixture(fixture, map), /fixture profile\/surface pair is invalid/);
});

test("rejects client version that differs from the mapped pinned surface", () => {
  const fixture = clone(deterministicFixture);
  fixture.profile.clientVersion = "0.145.0";
  assertHasError(
    validateFixture(fixture, map),
    /clientVersion must equal mapped surface version 0\.146\.0/,
  );
});

test("rejects provenance that omits the selected specification snapshot", () => {
  const fixture = clone(deterministicFixture);
  fixture.provenance.researchRecordIds = ["gemini-cli/2026-08-01.0"];
  assertHasError(
    validateFixture(fixture, map),
    /researchRecordIds must include fixture\.profile\.specSnapshotId/,
  );
});

test("rejects a document format not mapped to the selected surface", () => {
  const fixture = clone(deterministicFixture);
  fixture.repository.files[0].formatId = "cursor-mdc";
  assertHasError(
    validateFixture(fixture, map),
    /formatId is not mapped to surface codex-cli\/local-cli-single-cwd/,
  );
});

test("rejects repository path traversal", () => {
  const fixture = clone(deterministicFixture);
  fixture.repository.files[0].path = "../AGENTS.md";
  assertHasError(
    validateFixture(fixture, map),
    /must be a canonical repository-relative POSIX path/,
  );
});

test("rejects mutable source without an explanation", () => {
  const fixture = clone(ambiguousFixture);
  delete fixture.provenance.sources[0].mutableSourceReason;
  assertHasError(validateFixture(fixture, map), /mutableSourceReason must be a non-empty string/);
});

test("rejects duplicate graph identifiers and broken edge endpoints", () => {
  const fixture = clone(deterministicFixture);
  fixture.expectedGraph.nodes[1].id = fixture.expectedGraph.nodes[0].id;
  fixture.expectedGraph.edges[0].to = "missing-node";
  const errors = validateFixture(fixture, map);
  assertHasError(errors, /duplicate id/);
  assertHasError(errors, /to references unknown node missing-node/);
});

test("rejects unordered event traces", () => {
  const fixture = clone(ambiguousFixture);
  fixture.eventTrace[1].sequence = 5;
  assertHasError(
    validateFixture(fixture, map),
    /sequence must equal its zero-based array position/,
  );
});
