import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  SARIF_OUTPUT_LEGACY_SCHEMA_VERSION,
  SARIF_OUTPUT_SCHEMA_VERSION,
  detectSarifOutputProductVersion,
  migrateSarifOutputV1,
  serializeSarifOutput,
  validateSarifOutput,
  validateSarifOutputV1,
} from "../src/index.js";

const V1 = new URL("./fixtures/sarif-output.v1.valid.json", import.meta.url);
const V2 = new URL("./fixtures/sarif-output.valid.json", import.meta.url);

function fixture(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

describe("I06 SARIF product subset v2 compatibility", () => {
  test("keeps v1 and v2 validation and negotiation disjoint", () => {
    const v1 = fixture(V1);
    const v2 = fixture(V2);
    expect(validateSarifOutputV1(v1).ok).toBe(true);
    expect(validateSarifOutput(v1).ok).toBe(false);
    expect(validateSarifOutput(v2).ok).toBe(true);
    expect(validateSarifOutputV1(v2).ok).toBe(false);
    expect(detectSarifOutputProductVersion(v1)).toBe(SARIF_OUTPUT_LEGACY_SCHEMA_VERSION);
    expect(detectSarifOutputProductVersion(v2)).toBe(SARIF_OUTPUT_SCHEMA_VERSION);
    expect(detectSarifOutputProductVersion({ version: "2.1.0" })).toBeUndefined();
  });

  test("requires regeneration for valid v1 and reports invalid v1 without guessing", () => {
    expect(migrateSarifOutputV1(fixture(V1))).toEqual({
      ok: false,
      code: "regeneration-required",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      reason:
        "SARIF product subset v2 must be regenerated from diagnostics and source documents; v1 does not contain enough provenance or GitHub line-hash input",
    });
    const invalid = migrateSarifOutputV1({});
    expect(invalid.ok).toBe(false);
    expect(invalid.code).toBe("invalid-v1");
  });

  test("current serialization fails closed for legacy and malformed fingerprints", () => {
    expect(serializeSarifOutput(fixture(V1)).ok).toBe(false);
    const malformed = structuredClone(fixture(V2)) as Record<string, unknown>;
    const runs = malformed["runs"] as Record<string, unknown>[];
    const results = runs[0]?.["results"] as Record<string, unknown>[];
    const fingerprints = results[0]?.["partialFingerprints"] as Record<string, unknown>;
    fingerprints["primaryLocationLineHash"] = "not-a-github-hash";
    const validation = validateSarifOutput(malformed);
    expect(validation.ok).toBe(false);
    if (validation.ok) throw new Error("expected malformed fingerprint rejection");
    expect(validation.issues.some((issue) => issue.path.includes("primaryLocationLineHash"))).toBe(
      true,
    );
  });
});
