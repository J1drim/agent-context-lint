import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { validateGeminiResearch } from "./validate-gemini-research.mjs";

const record = JSON.parse(
  fs.readFileSync("docs/profiles/data/gemini-cli-context-facts.v0.json", "utf8"),
);
const map = JSON.parse(
  fs.readFileSync("conformance/contracts/profile-surface-map.v0.json", "utf8"),
);
const fixtures = [
  "conformance/fixtures/v0/gemini-hierarchy-jit.fixture.json",
  "conformance/fixtures/v0/gemini-import-modes.fixture.json",
  "conformance/fixtures/v0/gemini-ignore-memory-ambiguity.fixture.json",
].map((file) => JSON.parse(fs.readFileSync(file, "utf8")));

function clone(value) {
  return structuredClone(value);
}

function assertHasError(errors, pattern) {
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `expected ${pattern}; received:\n${errors.join("\n")}`,
  );
}

test("accepts the canonical Gemini research record and fixtures offline", () => {
  assert.deepEqual(validateGeminiResearch(record, map, fixtures, { workspaceRoot: "." }), []);
});

test("rejects unknown top-level fields", () => {
  const input = clone(record);
  input.accidentalAuthority = true;
  assertHasError(validateGeminiResearch(input, map), /unknown top-level field/);
});

test("rejects duplicate fact identifiers", () => {
  const input = clone(record);
  input.facts.push(clone(input.facts[0]));
  assertHasError(validateGeminiResearch(input, map), /duplicate id GEM-LOC-001/);
});

test("rejects facts with unknown evidence sources", () => {
  const input = clone(record);
  input.facts[0].sources = ["GEM-NOT-A-SOURCE"];
  assertHasError(validateGeminiResearch(input, map), /references unknown source/);
});

test("rejects malformed reviewed source digests", () => {
  const input = clone(record);
  input.provenance.sourceFileDigests["GEM-DOC-MEMORY"] = "sha256:bad";
  assertHasError(validateGeminiResearch(input, map), /sourceFileDigests\.GEM-DOC-MEMORY/);
});

test("rejects reviewed file sources that are not bound to the current immutable revision", () => {
  const input = clone(record);
  input.sources.find((source) => source.id === "GEM-DOC-MEMORY").url =
    "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md";
  assertHasError(validateGeminiResearch(input, map), /immutable current-source URL/);
});

test("rejects a map that omits the exact record version", () => {
  const inputMap = clone(map);
  inputMap.researchRecords = inputMap.researchRecords.filter(
    (entry) => entry.id !== record.recordVersion,
  );
  assertHasError(
    validateGeminiResearch(record, inputMap),
    /must include gemini-cli\/2026-08-02\.0/,
  );
});

test("rejects fixtures that drift from the research snapshot", () => {
  const inputFixtures = clone(fixtures);
  inputFixtures[0].profile.specSnapshotId = "gemini-cli/old";
  assertHasError(validateGeminiResearch(record, map, inputFixtures), /specSnapshotId must equal/);
});

test("rejects fixture evidence not present in the truth record", () => {
  const inputFixtures = clone(fixtures);
  inputFixtures[0].assertions[0].evidenceRefs.push("GEM-INVENTED-999");
  assertHasError(validateGeminiResearch(record, map, inputFixtures), /unknown evidence/);
});

test("rejects missing or escaping local evidence artifacts", () => {
  const input = clone(record);
  input.sources.find((source) => source.id === "GEM-OBS-EQUIVALENCE").artifactPath =
    "docs/profiles/gemini-cli/observations/missing.md";
  assertHasError(
    validateGeminiResearch(input, map, fixtures, { workspaceRoot: "." }),
    /artifact does not exist inside workspace/,
  );
});

test("rejects traversal in local evidence artifact paths", () => {
  const input = clone(record);
  input.sources.find((source) => source.id === "GEM-OBS-EQUIVALENCE").artifactPath =
    "../outside.md";
  assertHasError(validateGeminiResearch(input, map), /artifactPath must be repository-relative/);
});

test("does not invoke accessors on hostile public API input", () => {
  const input = clone(record);
  let invoked = false;
  Object.defineProperty(input, "recordVersion", {
    enumerable: true,
    get() {
      invoked = true;
      return record.recordVersion;
    },
  });
  assertHasError(validateGeminiResearch(input, map), /recordVersion/);
  assert.equal(invoked, false);
});

test("rejects proxied research records", () => {
  assertHasError(validateGeminiResearch(new Proxy(record, {}), map), /plain object/);
});
