import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  MAX_CURSOR_FACTS_BYTES,
  loadCursorRuleFacts,
  validateCursorRuleFacts,
} from "./validate-cursor-rule-facts.mjs";

const FACTS_PATH = "docs/profiles/data/cursor-rule-facts.v0.json";
const canonical = JSON.parse(fs.readFileSync(FACTS_PATH, "utf8"));

function clone(value = canonical) {
  return structuredClone(value);
}

function assertHasError(errors, pattern) {
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `expected error matching ${pattern}, received:\n${errors.join("\n")}`,
  );
}

test("accepts the complete pinned Cursor research truth table", () => {
  assert.deepEqual(validateCursorRuleFacts(canonical), []);
  assert.equal(canonical.facts.length, 71);
  assert.deepEqual(
    canonical.canonicalModes.map((mode) => mode.id),
    ["always", "auto-attached", "agent-requested", "manual"],
  );
});

test("pins IDE and CLI as separate observed surfaces", () => {
  assert.deepEqual(
    canonical.surfaces.map(({ id, clientVersion }) => [id, clientVersion]),
    [
      ["cursor-agent/ide", "3.12.30"],
      ["cursor-agent/cli", "2026.05.24-dda726e"],
    ],
  );
});

test("preserves mixed activation forms and relevance as non-deterministic", () => {
  const byId = new Map(canonical.facts.map((fact) => [fact.id, fact]));
  assert.equal(byId.get("CURSOR-MODE-05").state, "unknown");
  assert.equal(byId.get("CURSOR-MODE-07").state, "unknown");
  assert.equal(byId.get("CURSOR-MODE-13").state, "model-selected");
  assert.equal(byId.get("CURSOR-NEST-05").state, "unknown");
  assert.equal(byId.get("CURSOR-REF-03").state, "unknown");
});

test("rejects unknown top-level fields", () => {
  const value = clone();
  value.command = "run client";
  assertHasError(validateCursorRuleFacts(value), /keys must be exactly/);
});

test("rejects a missing truth-table boundary case", () => {
  const value = clone();
  value.facts.pop();
  assertHasError(validateCursorRuleFacts(value), /facts\.facts must contain 71 to 71 entries/);
});

test("rejects reordered or mislabeled facts", () => {
  const value = clone();
  [value.facts[0], value.facts[1]] = [value.facts[1], value.facts[0]];
  value.facts[2].topic = "glob";
  const errors = validateCursorRuleFacts(value);
  assertHasError(errors, /facts\.facts\[0\]\.id must be CURSOR-MDC-01/);
  assertHasError(errors, /topic does not match CURSOR-MDC-03/);
});

test("rejects undeclared sources and unofficial source substitutions", () => {
  const value = clone();
  value.facts[0].sources = ["CURSOR-COMMUNITY"];
  value.sources[0].url = "https://example.invalid/cursor-rules";
  const errors = validateCursorRuleFacts(value);
  assertHasError(errors, /unsupported value CURSOR-COMMUNITY/);
  assertHasError(errors, /approved location for CURSOR-RULES/);
});

test("rejects deterministic Always promotion of model-selected evidence", () => {
  const value = clone();
  value.facts.find((fact) => fact.id === "CURSOR-MODE-13").activationMode = "always";
  assertHasError(
    validateCursorRuleFacts(value),
    /cannot turn model-selected evidence into Always activation/,
  );
});

test("rejects enabling paid observation or dropping a forbidden capability", () => {
  const value = clone();
  value.observationPolicy.paidRequestsAuthorized = true;
  value.observationPolicy.forbiddenNow.pop();
  const errors = validateCursorRuleFacts(value);
  assertHasError(errors, /paidRequestsAuthorized must be false/);
  assertHasError(errors, /must include upstream-mutation/);
});

test("returns validation errors for hostile scalar and collection shapes", () => {
  const value = clone();
  value.facts[0].id = 1;
  value.observationPolicy.forbiddenNow = "model-request";
  const errors = validateCursorRuleFacts(value);
  assertHasError(errors, /facts\.facts\[0\]\.id must be CURSOR-MDC-01/);
  assertHasError(errors, /forbiddenNow must contain 1 to 100 entries/);
  assertHasError(errors, /forbiddenNow must include credential-read/);
});

test("loads an ordinary bounded JSON file", () => {
  assert.deepEqual(loadCursorRuleFacts(FACTS_PATH), canonical);
});

test("rejects malformed, encoding-invalid, oversized, and symlink inputs before authority", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-facts-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const malformed = path.join(directory, "malformed.json");
  fs.writeFileSync(malformed, "{");
  assert.throws(() => loadCursorRuleFacts(malformed), /malformed JSON/);

  const nul = path.join(directory, "nul.json");
  fs.writeFileSync(nul, Buffer.from([0x7b, 0x00, 0x7d]));
  assert.throws(() => loadCursorRuleFacts(nul), /contains NUL bytes/);

  const bom = path.join(directory, "bom.json");
  fs.writeFileSync(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
  assert.throws(() => loadCursorRuleFacts(bom), /must not contain a UTF-8 BOM/);

  const invalidUtf8 = path.join(directory, "invalid-utf8.json");
  fs.writeFileSync(invalidUtf8, Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x7d]));
  assert.throws(() => loadCursorRuleFacts(invalidUtf8), /is not valid UTF-8/);

  const oversized = path.join(directory, "oversized.json");
  fs.writeFileSync(oversized, Buffer.alloc(MAX_CURSOR_FACTS_BYTES + 1, 0x20));
  assert.throws(() => loadCursorRuleFacts(oversized), /exceeds 524288 bytes/);

  const link = path.join(directory, "facts-link.json");
  fs.symlinkSync(path.resolve(FACTS_PATH), link);
  assert.throws(() => loadCursorRuleFacts(link), /must be an ordinary file/);
});

test("command-line validation reports success and malformed failure without executing input", (t) => {
  const success = spawnSync(
    process.execPath,
    ["tools/conformance/validate-cursor-rule-facts.mjs", FACTS_PATH],
    { encoding: "utf8" },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /validated 71 Cursor facts/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-facts-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const malformed = path.join(directory, "malformed.json");
  fs.writeFileSync(malformed, "not-json");
  const failure = spawnSync(
    process.execPath,
    ["tools/conformance/validate-cursor-rule-facts.mjs", malformed],
    { encoding: "utf8" },
  );
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /malformed JSON/);
  assert.equal(failure.stdout, "");
});
