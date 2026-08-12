import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FeatureFlagManifestError,
  resolveFeatureFlag,
  validateFeatureManifest,
} from "./verify-feature-flags.mjs";

const committedManifest = JSON.parse(
  await readFile(new URL("../config/feature-flags.json", import.meta.url), "utf8"),
);

function copyManifest() {
  return structuredClone(committedManifest);
}

test("committed manifest passes development validation", () => {
  assert.equal(validateFeatureManifest(committedManifest), committedManifest);
});

test("GA validation identifies every incomplete committed-scope flag", () => {
  assert.throws(
    () => validateFeatureManifest(committedManifest, { mode: "ga" }),
    (error) => {
      assert.ok(error instanceof FeatureFlagManifestError);
      assert.match(error.message, /profile\.cursor/u);
      assert.match(error.message, /profile\.gemini-cli/u);
      return true;
    },
  );
});

test("GA validation accepts stable, enabled committed-scope flags", () => {
  const manifest = copyManifest();
  for (const flag of manifest.flags) {
    flag.maturity = "stable";
    flag.defaultEnabled = true;
    delete flag.rationale;
  }
  assert.equal(validateFeatureManifest(manifest, { mode: "ga" }), manifest);
});

test("GA validation does not require post-GA flags to be enabled", () => {
  const manifest = copyManifest();
  for (const flag of manifest.flags) {
    flag.releaseScope = "post-ga";
  }
  assert.equal(validateFeatureManifest(manifest, { mode: "ga" }), manifest);
});

test("manifest rejects unknown fields", () => {
  const manifest = copyManifest();
  manifest.flags[0].percentageRollout = 10;
  assert.throws(() => validateFeatureManifest(manifest), /not supported/u);
});

test("manifest rejects unsorted and duplicate flag identifiers", () => {
  const unsorted = copyManifest();
  unsorted.flags.reverse();
  assert.throws(() => validateFeatureManifest(unsorted), /sorted by id/u);

  const duplicate = copyManifest();
  duplicate.flags.push(structuredClone(duplicate.flags[1]));
  assert.throws(() => validateFeatureManifest(duplicate), /duplicate id/u);
});

test("manifest rejects invalid identifiers and kind mismatches", () => {
  const invalidIdentifier = copyManifest();
  invalidIdentifier.flags[0].id = "cursor";
  assert.throws(() => validateFeatureManifest(invalidIdentifier), /id is invalid/u);

  const mismatchedKind = copyManifest();
  mismatchedKind.flags[0].kind = "rule";
  assert.throws(() => validateFeatureManifest(mismatchedKind), /kind does not match/u);
});

test("manifest rejects invalid flag field values", () => {
  const manifest = copyManifest();
  manifest.flags[0].defaultEnabled = "false";
  manifest.flags[0].owner = "team";
  manifest.flags[0].targetGate = "G10";
  manifest.flags[0].tickets = [];
  assert.throws(
    () => validateFeatureManifest(manifest),
    (error) => error.problems.length === 4,
  );
});

test("manifest requires a rationale only before stable maturity", () => {
  const missingRationale = copyManifest();
  delete missingRationale.flags[0].rationale;
  assert.throws(() => validateFeatureManifest(missingRationale), /rationale is required/u);

  const staleRationale = copyManifest();
  staleRationale.flags[0].maturity = "stable";
  assert.throws(() => validateFeatureManifest(staleRationale), /must be removed/u);
});

test("resolution returns immutable defaults with evaluation metadata", () => {
  const evaluation = resolveFeatureFlag(committedManifest, "profile.cursor");
  assert.deepEqual(evaluation, {
    id: "profile.cursor",
    enabled: false,
    reason: "manifest-default",
    maturity: "experimental",
    releaseScope: "ga",
  });
  assert.ok(Object.isFrozen(evaluation));
});

test("resolution accepts explicit typed overrides", () => {
  assert.deepEqual(
    resolveFeatureFlag(committedManifest, "profile.cursor", {
      "profile.cursor": true,
    }),
    {
      id: "profile.cursor",
      enabled: true,
      reason: "explicit-override",
      maturity: "experimental",
      releaseScope: "ga",
    },
  );
});

test("resolution fails closed for unknown or untyped overrides", () => {
  assert.throws(
    () => resolveFeatureFlag(committedManifest, "profile.unknown"),
    /Unknown feature flag/u,
  );
  assert.throws(
    () =>
      resolveFeatureFlag(committedManifest, "profile.cursor", {
        "profile.unknown": true,
      }),
    /Unknown feature flag override/u,
  );
  assert.throws(
    () =>
      resolveFeatureFlag(committedManifest, "profile.cursor", {
        "profile.cursor": "yes",
      }),
    /must be a boolean/u,
  );
});
