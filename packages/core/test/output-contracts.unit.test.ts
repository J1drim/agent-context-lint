import { readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import {
  BASELINE_OUTPUT_SCHEMA_VERSION,
  EFFICIENCY_OUTPUT_SCHEMA_VERSION,
  JSON_OUTPUT_SCHEMA_VERSION,
  MAX_BASELINE_ENTRIES,
  MAX_EFFICIENCY_RECOMMENDATIONS,
  MAX_OUTPUT_TEXT_CODE_POINTS,
  MAX_SARIF_RESULTS,
  MAX_TERMINAL_LINES,
  OUTPUT_COMPATIBILITY_CHANGES,
  OUTPUT_RECORD_KINDS,
  SARIF_OUTPUT_SCHEMA_VERSION,
  SARIF_SCHEMA_URI,
  SARIF_VERSION,
  STANDARDS_OUTPUT_SCHEMA_VERSION,
  TERMINAL_OUTPUT_SCHEMA_VERSION,
  classifyOutputCompatibility,
  decodeSarifArtifactUri,
  encodeSarifArtifactUri,
  isKnownOutputRecordKind,
  isNativeOutput,
  isSarifOutput,
  serializeNativeOutput,
  serializeSarifOutput,
  serializeTerminalOutput,
  sanitizeOutputJson,
  validateBaselineOutput,
  validateEfficiencyOutput,
  validateInstructionIr,
  validateNativeOutput,
  validateSarifOutput,
  validateScanJsonOutput,
  validateStandardsOutput,
  validateTerminalOutput,
} from "../src/index.js";

import type {
  NativeOutputDocument,
  OutputValidationCode,
  OutputValidationResult,
  SourceDocument,
} from "../src/index.js";

const OUTPUT_SCHEMA = new URL("../schemas/output-contract.v1.schema.json", import.meta.url);
const SARIF_SCHEMA = new URL(
  "../schemas/sarif-output.v2.1.0-product-v2.schema.json",
  import.meta.url,
);
const DIAGNOSTIC_SCHEMA = new URL("../schemas/diagnostic-contract.v0.schema.json", import.meta.url);
const DIAGNOSTICS = new URL("./fixtures/diagnostics.valid.json", import.meta.url);
const IR = new URL("./fixtures/instruction-ir.valid.json", import.meta.url);
const SARIF_FIXTURE = new URL("./fixtures/sarif-output.valid.json", import.meta.url);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function json(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function sources(): readonly SourceDocument[] {
  const result = validateInstructionIr(json(IR));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value.sources;
}

function summary(): Record<string, unknown> {
  return { errors: 0, warnings: 1, infos: 0, suppressed: 0, exitCode: 1 };
}

function terminal(): Record<string, unknown> {
  return {
    recordKind: "agent-context-terminal-output",
    schemaVersion: "1.0.0",
    colorMode: "never",
    width: 80,
    lines: ["AGENTS.md:1:1 warning ACL100: message"],
    summary: summary(),
  };
}

function scan(): Record<string, unknown> {
  return {
    recordKind: "agent-context-scan-output",
    schemaVersion: "1.0.0",
    profileVersions: {
      "codex-cli": { profileVersion: "1.0.0", clientVersion: "0.146.0" },
    },
    failureThreshold: "error",
    diagnostics: json(DIAGNOSTICS),
    summary: { errors: 1, warnings: 0, infos: 0, suppressed: 0, exitCode: 1 },
  };
}

function efficiency(): Record<string, unknown> {
  return {
    recordKind: "agent-context-efficiency-output",
    schemaVersion: "1.0.0",
    profileId: "codex-cli",
    profileVersion: "1.0.0",
    clientVersion: "0.146.0",
    surfaceId: "cli",
    specSnapshotId: "codex-2026-08-02",
    tokenizer: { id: "o200k_base", version: "2026-08-02", measurement: "exact" },
    sampleCount: 20,
    tokenStatistics: { minimum: 100, median: 110, p95: 125, maximum: 130 },
    score: { version: "1.0.0", value: 88.5, grade: "B" },
    recommendations: [
      {
        id: "deduplicate-context",
        title: "Remove repeated context",
        path: "AGENTS.md",
        baselineTokens: 130,
        projectedTokens: 110,
        confidence: "high",
        caveats: ["Benchmark before applying"],
        benchmarkStatus: "passed",
      },
    ],
  };
}

function standards(): Record<string, unknown> {
  const artifact = {
    channel: "stable",
    version: "2026.08.0",
    digest: HASH_A,
    retrievedAt: "2026-08-02T12:00:00.000Z",
  };
  return {
    recordKind: "agent-context-standards-output",
    schemaVersion: "1.0.0",
    mode: "status",
    channel: "stable",
    bundled: artifact,
    locked: structuredClone(artifact),
    cachedLatest: null,
    activation: "locked",
    freshness: "current",
    problems: [],
  };
}

function baseline(): Record<string, unknown> {
  return {
    recordKind: "agent-context-baseline-output",
    schemaVersion: "1.0.0",
    diagnosticContractVersion: "0.1.0",
    engineVersion: "1.0.0",
    fingerprintMethods: {
      path: "agent-context-lint/path/v1",
      semantic: "agent-context-lint/semantic/v1",
    },
    createdAt: "2026-08-02T12:00:00.000Z",
    expiresAt: "2026-09-02T12:00:00.000Z",
    sourceRevision: HASH_A,
    profileVersions: {
      "codex-cli": {
        profileVersion: "1.0.0",
        clientVersion: "0.146.0",
        surfaceIds: ["codex-cli/local-cli-single-cwd"],
        specSnapshotIds: ["codex-cli/0.146.0/2026-08-01"],
      },
    },
    entries: [
      {
        ruleId: "ACL100",
        ruleVersion: "1.0.0",
        severity: "warning",
        path: "AGENTS.md",
        semanticFingerprint: HASH_A,
        pathFingerprint: HASH_B,
        provenanceFingerprint: HASH_A,
        profileIds: ["codex-cli"],
        surfaceIds: ["codex-cli/local-cli-single-cwd"],
        specSnapshotIds: ["codex-cli/0.146.0/2026-08-01"],
        firstSeenAt: "2026-08-02T12:00:00.000Z",
        expiresAt: null,
      },
    ],
  };
}

function sarif(): Record<string, unknown> {
  return structuredClone(json(SARIF_FIXTURE)) as Record<string, unknown>;
}

function at(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`expected ${key} to be an object`);
  }
  return value as Record<string, unknown>;
}

function first(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!Array.isArray(value) || value[0] === null || typeof value[0] !== "object") {
    throw new TypeError(`expected ${key} to contain an object`);
  }
  return value[0] as Record<string, unknown>;
}

function expectInvalid(
  result: OutputValidationResult<unknown>,
  code?: OutputValidationCode,
  path?: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid output");
  expect(
    result.issues.some(
      (issue) =>
        (code === undefined || issue.code === code) && (path === undefined || issue.path === path),
    ),
    JSON.stringify(result.issues),
  ).toBe(true);
}

describe("B05 schema vocabulary and positive contracts", () => {
  test("exports all independently versioned contract families and resource ceilings", () => {
    expect([
      TERMINAL_OUTPUT_SCHEMA_VERSION,
      JSON_OUTPUT_SCHEMA_VERSION,
      SARIF_OUTPUT_SCHEMA_VERSION,
      EFFICIENCY_OUTPUT_SCHEMA_VERSION,
      STANDARDS_OUTPUT_SCHEMA_VERSION,
      BASELINE_OUTPUT_SCHEMA_VERSION,
    ]).toEqual(["1.0.0", "1.0.0", "2.0.0", "1.0.0", "1.0.0", "1.0.0"]);
    expect(SARIF_VERSION).toBe("2.1.0");
    expect(SARIF_SCHEMA_URI).toContain("errata01/os/schemas");
    expect(OUTPUT_RECORD_KINDS).toHaveLength(5);
    expect(OUTPUT_COMPATIBILITY_CHANGES).toEqual(["patch", "minor", "major"]);
    expect([
      MAX_TERMINAL_LINES,
      MAX_EFFICIENCY_RECOMMENDATIONS,
      MAX_BASELINE_ENTRIES,
      MAX_SARIF_RESULTS,
    ]).toEqual([100_000, 10_000, 100_000, 10_000]);
    expect(isKnownOutputRecordKind("agent-context-baseline-output")).toBe(true);
    expect(isKnownOutputRecordKind("future-output")).toBe(false);
  });

  test("accepts every native family through its dedicated and dispatch validators", () => {
    const cases = [
      [terminal(), validateTerminalOutput],
      [efficiency(), validateEfficiencyOutput],
      [standards(), validateStandardsOutput],
      [baseline(), validateBaselineOutput],
    ] as const;
    for (const [value, validator] of cases) {
      expect(validator(value), JSON.stringify(validator(value))).toMatchObject({ ok: true });
      expect(validateNativeOutput(value)).toMatchObject({ ok: true });
      expect(isNativeOutput(value)).toBe(true);
    }
    expect(validateScanJsonOutput(scan(), sources())).toMatchObject({ ok: true });
    expect(validateNativeOutput(scan(), sources())).toMatchObject({ ok: true });
  });

  test("accepts the supported SARIF subset", () => {
    expect(validateSarifOutput(sarif())).toMatchObject({ ok: true });
    expect(isSarifOutput(sarif())).toBe(true);
  });

  test("published Draft 2020-12 schemas accept every positive runtime fixture", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(json(DIAGNOSTIC_SCHEMA) as AnySchema);
    const native = ajv.compile(json(OUTPUT_SCHEMA) as AnySchema);
    for (const value of [terminal(), scan(), efficiency(), standards(), baseline()]) {
      expect(native(value), JSON.stringify(native.errors)).toBe(true);
    }
    const sarifValidator = ajv.compile(json(SARIF_SCHEMA) as AnySchema);
    expect(sarifValidator(sarif()), JSON.stringify(sarifValidator.errors)).toBe(true);
  });
});

describe("closed negative, boundary, and relationship validation", () => {
  test("rejects unknown kinds, fields, missing fields, and unsupported versions", () => {
    expect(validateNativeOutput({ recordKind: "future-output" })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-state", path: "$.recordKind" }],
    });
    expect(validateNativeOutput({})).toMatchObject({
      ok: false,
      issues: [{ code: "missing-field", path: "$.recordKind" }],
    });
    const unknown = terminal();
    unknown["extra"] = true;
    expectInvalid(validateTerminalOutput(unknown), "unknown-field", "$.extra");
    const future = baseline();
    future["schemaVersion"] = "1.1.0";
    expectInvalid(validateBaselineOutput(future), "unsupported-version");
    const wrongKind = standards();
    wrongKind["recordKind"] = "agent-context-baseline-output";
    expectInvalid(validateStandardsOutput(wrongKind), "invalid-state");
  });

  test("rejects malformed summaries and accepts bounded text for serializer sanitization", () => {
    const output = terminal();
    at(output, "summary")["exitCode"] = 3;
    expect(validateTerminalOutput(output)).toMatchObject({ ok: false });
    for (const unsafe of ["plain\u001b[2J", "plain\u202econfused", "line\nspoof"]) {
      const malicious = terminal();
      malicious["lines"] = [unsafe];
      expect(validateTerminalOutput(malicious)).toMatchObject({ ok: true });
      const serialized = serializeTerminalOutput(malicious);
      expect(serialized).toMatchObject({ ok: true });
      if (serialized.ok) {
        const body = serialized.text.slice(0, -1);
        expect(
          Array.from(body).every((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return !(
              codePoint <= 0x1f ||
              (codePoint >= 0x7f && codePoint <= 0x9f) ||
              (codePoint >= 0x202a && codePoint <= 0x202e)
            );
          }),
        ).toBe(true);
      }
    }
    const colored = terminal();
    colored["colorMode"] = "ansi";
    colored["lines"] = ["\u001b[31mwarning\u001b[0m"];
    expect(validateTerminalOutput(colored)).toMatchObject({ ok: true });
    const inconsistentScan = scan();
    at(inconsistentScan, "summary")["warnings"] = 1;
    expectInvalid(
      validateScanJsonOutput(inconsistentScan, sources()),
      "invalid-relationship",
      "$.summary",
    );
  });

  test("rejects unsorted identities, invalid repository paths, and impossible efficiency claims", () => {
    const output = efficiency();
    at(output, "tokenStatistics")["minimum"] = 200;
    first(output, "recommendations")["projectedTokens"] = 999;
    first(output, "recommendations")["path"] = "../outside";
    const second = structuredClone(first(output, "recommendations"));
    second["id"] = "aaa";
    (output["recommendations"] as unknown[]).push(second);
    const result = validateEfficiencyOutput(output);
    expectInvalid(result, "invalid-relationship", "$.tokenStatistics");
    expectInvalid(result, "invalid-path");
    expectInvalid(result, "invalid-order");
  });

  test("rejects invalid standards artifacts and malformed optional states", () => {
    const output = standards();
    at(output, "bundled")["digest"] = "not-a-digest";
    output["locked"] = 5;
    output["cachedLatest"] = undefined;
    output["problems"] = ["z", "a", "a"];
    expect(validateStandardsOutput(output)).toMatchObject({ ok: false });
    const missingLock = standards();
    missingLock["locked"] = null;
    expectInvalid(validateStandardsOutput(missingLock), "invalid-relationship", "$.activation");
    const wrongChannel = standards();
    at(wrongChannel, "bundled")["channel"] = "preview";
    expectInvalid(
      validateStandardsOutput(wrongChannel),
      "invalid-relationship",
      "$.bundled.channel",
    );
  });

  test("rejects baseline escape paths, invalid expiry, duplicate entries, and unsorted profile keys", () => {
    const output = baseline();
    output["expiresAt"] = "2025-01-01T00:00:00.000Z";
    output["profileVersions"] = { zebra: "1.0.0", alpha: "1.0.0" };
    const entry = first(output, "entries");
    entry["path"] = "/absolute";
    (output["entries"] as unknown[]).push(structuredClone(entry));
    const result = validateBaselineOutput(output);
    expectInvalid(result, "invalid-path");
    expectInvalid(result, "duplicate-id");
    expectInvalid(result, "invalid-relationship");
    const chronology = baseline();
    first(chronology, "entries")["firstSeenAt"] = "2026-08-03T12:00:00.000Z";
    expectInvalid(
      validateBaselineOutput(chronology),
      "invalid-relationship",
      "$.entries[0].firstSeenAt",
    );
    const wrongDiagnosticVersion = baseline();
    wrongDiagnosticVersion["diagnosticContractVersion"] = "0.2.0";
    expectInvalid(validateBaselineOutput(wrongDiagnosticVersion), "unsupported-version");
  });

  test("rejects scan envelopes whose B04 payload is not valid against the B03 sources", () => {
    const output = scan();
    at(output, "diagnostics")["contractVersion"] = "99.0.0";
    expectInvalid(
      validateScanJsonOutput(output, sources()),
      undefined,
      "$.diagnostics.contractVersion",
    );
  });

  test("enforces scan profile identity and failure-threshold exit semantics", () => {
    const noProfiles = scan();
    noProfiles["profileVersions"] = {};
    expectInvalid(
      validateScanJsonOutput(noProfiles, sources()),
      "invalid-value",
      "$.profileVersions",
    );
    const missingClient = scan();
    Reflect.deleteProperty(at(at(missingClient, "profileVersions"), "codex-cli"), "clientVersion");
    expectInvalid(validateScanJsonOutput(missingClient, sources()), "missing-field");
    const unrelatedProfile = scan();
    unrelatedProfile["profileVersions"] = {
      "cursor-agent": { profileVersion: "1.0.0", clientVersion: "1.2.3" },
    };
    expectInvalid(
      validateScanJsonOutput(unrelatedProfile, sources()),
      "invalid-relationship",
      "$.profileVersions",
    );
    const extraProfile = scan();
    extraProfile["profileVersions"] = {
      "codex-cli": { profileVersion: "1.0.0", clientVersion: "0.146.0" },
      "cursor-agent": { profileVersion: "1.0.0", clientVersion: "1.2.3" },
    };
    expectInvalid(
      validateScanJsonOutput(extraProfile, sources()),
      "invalid-relationship",
      "$.profileVersions",
    );
    const never = scan();
    never["failureThreshold"] = "never";
    expectInvalid(
      validateScanJsonOutput(never, sources()),
      "invalid-relationship",
      "$.summary.exitCode",
    );
  });

  test("rejects SARIF traversal, rule mismatch, reversed regions, bad fingerprints, and extra fields", () => {
    const output = sarif();
    const run = first(output, "runs");
    const result = first(run, "results");
    result["ruleId"] = "ACL999";
    result["extra"] = true;
    const location = first(result, "locations");
    at(at(location, "physicalLocation"), "artifactLocation")["uri"] = "../outside";
    at(at(location, "physicalLocation"), "region")["endColumn"] = 0;
    at(result, "partialFingerprints")["bad"] = "not-a-hash";
    const validation = validateSarifOutput(output);
    expectInvalid(validation, "invalid-relationship");
    expectInvalid(validation, "invalid-path");
    expectInvalid(validation, "unknown-field");
    const badUri = sarif();
    const badDriver = at(at(first(badUri, "runs"), "tool"), "driver");
    badDriver["informationUri"] = "https://user:pass@example.test/tool";
    expectInvalid(
      validateSarifOutput(badUri),
      "invalid-value",
      "$.runs[0].tool.driver.informationUri",
    );
    const duplicateRelated = sarif();
    const duplicateResult = first(first(duplicateRelated, "runs"), "results");
    const related = duplicateResult["relatedLocations"] as unknown[];
    related.push(structuredClone(related[0]));
    expectInvalid(validateSarifOutput(duplicateRelated), "duplicate-id");
  });
});

describe("untrusted JSON, canonical serialization, and schema differential behavior", () => {
  test("reports bounded issues across malformed nested shapes", () => {
    const malformed: (readonly [unknown, (value: unknown) => OutputValidationResult<unknown>])[] =
      [];

    const terminalShape = terminal();
    terminalShape["width"] = 19;
    terminalShape["lines"] = [1];
    Reflect.deleteProperty(terminalShape, "summary");
    malformed.push([terminalShape, validateTerminalOutput], [null, validateTerminalOutput]);

    const efficiencyShape = efficiency();
    efficiencyShape["tokenizer"] = null;
    efficiencyShape["score"] = null;
    efficiencyShape["recommendations"] = [null];
    Reflect.deleteProperty(efficiencyShape, "sampleCount");
    malformed.push([efficiencyShape, validateEfficiencyOutput]);

    const efficiencyFields = efficiency();
    at(efficiencyFields, "tokenizer")["measurement"] = "guessed";
    at(efficiencyFields, "score")["value"] = Number.NaN;
    const recommendation = first(efficiencyFields, "recommendations");
    recommendation["title"] = "";
    recommendation["caveats"] = [1];
    recommendation["benchmarkStatus"] = "unknown";
    malformed.push([efficiencyFields, validateEfficiencyOutput]);

    const standardsShape = standards();
    standardsShape["bundled"] = null;
    Reflect.deleteProperty(standardsShape, "locked");
    standardsShape["cachedLatest"] = 1;
    standardsShape["activation"] = "cachedLatest";
    standardsShape["problems"] = [1];
    malformed.push([standardsShape, validateStandardsOutput]);

    const baselineShape = baseline();
    baselineShape["profileVersions"] = null;
    baselineShape["entries"] = [null];
    baselineShape["sourceRevision"] = "bad";
    malformed.push([baselineShape, validateBaselineOutput]);

    const baselineFields = baseline();
    const baselineEntry = first(baselineFields, "entries");
    Reflect.deleteProperty(baselineEntry, "firstSeenAt");
    baselineEntry["expiresAt"] = "bad";
    baselineEntry["semanticFingerprint"] = "bad";
    malformed.push([baselineFields, validateBaselineOutput]);

    for (const [value, validator] of malformed) expectInvalid(validator(value));
  });

  test("reports malformed SARIF containers without trusting nested members", () => {
    const cases: unknown[] = [null, {}, { version: "2.1.0", $schema: SARIF_SCHEMA_URI, runs: [] }];

    const missingRun = sarif();
    missingRun["runs"] = [null];
    cases.push(missingRun);

    const missingDriver = sarif();
    first(missingDriver, "runs")["tool"] = null;
    cases.push(missingDriver);

    const missingRules = sarif();
    const missingRulesRun = first(missingRules, "runs");
    at(at(missingRulesRun, "tool"), "driver")["rules"] = [null];
    missingRulesRun["results"] = [null];
    missingRulesRun["properties"] = null;
    cases.push(missingRules);

    const missingLocations = sarif();
    const missingLocationsResult = first(first(missingLocations, "runs"), "results");
    missingLocationsResult["message"] = null;
    missingLocationsResult["locations"] = [null];
    missingLocationsResult["relatedLocations"] = [null];
    missingLocationsResult["partialFingerprints"] = null;
    cases.push(missingLocations);

    const missingPhysicalParts = sarif();
    const missingPhysicalResult = first(first(missingPhysicalParts, "runs"), "results");
    const primary = first(missingPhysicalResult, "locations");
    primary["physicalLocation"] = null;
    const related = first(missingPhysicalResult, "relatedLocations");
    at(related, "physicalLocation")["artifactLocation"] = null;
    at(related, "physicalLocation")["region"] = null;
    cases.push(missingPhysicalParts);

    for (const value of cases) expectInvalid(validateSarifOutput(value));
  });

  test("caps validation issue collection", () => {
    const noisy = terminal();
    for (let index = 0; index < 300; index += 1) noisy[`unknown${String(index)}`] = true;
    const result = validateTerminalOutput(noisy);
    expectInvalid(result, "resource-limit", "$");
    if (result.ok) throw new Error("expected issue cap");
    expect(result.issues).toHaveLength(256);
  });

  test("rejects proxies, accessors, cycles, sparse arrays, non-finite numbers, and oversized data", () => {
    expectInvalid(validateTerminalOutput(new Proxy(terminal(), {})), "invalid-json");
    const accessor = terminal();
    Object.defineProperty(accessor, "width", { enumerable: true, get: () => 80 });
    expect(validateTerminalOutput(accessor)).toMatchObject({ ok: false });
    const cyclic = terminal();
    cyclic["cycle"] = cyclic;
    expect(validateTerminalOutput(cyclic)).toMatchObject({ ok: false });
    const sparse = terminal();
    sparse["lines"] = new Array(2);
    expect(validateTerminalOutput(sparse)).toMatchObject({ ok: false });
    const oversized = terminal();
    oversized["lines"] = ["x".repeat(MAX_OUTPUT_TEXT_CODE_POINTS + 1)];
    expect(validateTerminalOutput(oversized)).toMatchObject({ ok: false });
    const revoked = Proxy.revocable(terminal(), {});
    revoked.revoke();
    expect(() => validateNativeOutput(revoked.proxy)).not.toThrow();
    expect(() => serializeNativeOutput(revoked.proxy)).not.toThrow();
    expectInvalid(validateNativeOutput(revoked.proxy), "invalid-json");
    expect(serializeNativeOutput(revoked.proxy)).toMatchObject({ ok: false });
  });

  test("serializes validated JSON and SARIF to stable canonical bytes", () => {
    const native = serializeNativeOutput(baseline());
    expect(native).toMatchObject({ ok: true });
    if (!native.ok) throw new Error("expected serialized native output");
    expect(native.text.endsWith("\n")).toBe(true);
    expect(native.text.indexOf('"createdAt"')).toBeLessThan(native.text.indexOf('"entries"'));
    expect(serializeNativeOutput(JSON.parse(native.text))).toEqual(native);

    const sarifResult = serializeSarifOutput(sarif());
    expect(sarifResult).toMatchObject({ ok: true });
    if (!sarifResult.ok) throw new Error("expected serialized SARIF output");
    expect(sarifResult.text.startsWith('{"version":"2.1.0","$schema":')).toBe(true);
    expect(serializeSarifOutput(JSON.parse(sarifResult.text))).toEqual(sarifResult);
  });

  test("renders terminal lines only after validation", () => {
    expect(serializeTerminalOutput(terminal())).toEqual({
      ok: true,
      text: "AGENTS.md:1:1 warning ACL100: message\n",
    });
    const empty = terminal();
    empty["lines"] = [];
    expect(serializeTerminalOutput(empty)).toEqual({ ok: true, text: "" });
    const invalid = terminal();
    invalid["lines"] = ["\u001b]8;;https://evil.example\u0007link"];
    expect(serializeTerminalOutput(invalid)).toMatchObject({ ok: true });
  });

  test("sanitizes secrets, controls, bidi state, and caller-provided SGR in every serializer", () => {
    const hostile = "SECRET_CANARY_OUTPUT \u001b[31mred\u001b[0m \u200fRLM \u061cALM line\nspoof";
    const assertInert = (text: string): void => {
      expect(text).toContain("REDACTED");
      expect(text).not.toContain("SECRET_CANARY");
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\u200f");
      expect(text).not.toContain("\u061c");
    };

    const terminalOutput = terminal();
    terminalOutput["colorMode"] = "ansi";
    terminalOutput["lines"] = [hostile];
    const terminalResult = serializeTerminalOutput(terminalOutput);
    if (!terminalResult.ok) throw new Error(JSON.stringify(terminalResult.issues));
    assertInert(terminalResult.text);
    expect(terminalResult.text.slice(0, -1)).not.toContain("\n");

    const nativeOutput = standards();
    at(nativeOutput, "bundled")["version"] = hostile;
    const nativeResult = serializeNativeOutput(nativeOutput);
    if (!nativeResult.ok) throw new Error(JSON.stringify(nativeResult.issues));
    assertInert(nativeResult.text);
    const parsedNative = JSON.parse(nativeResult.text) as unknown;
    if (parsedNative === null || typeof parsedNative !== "object" || Array.isArray(parsedNative))
      throw new Error("expected serialized native object");
    expect(at(parsedNative as Record<string, unknown>, "bundled")["version"]).toContain("REDACTED");

    const sarifOutput = sarif();
    at(first(first(sarifOutput, "runs"), "results"), "message")["text"] = hostile;
    const sarifResult = serializeSarifOutput(sarifOutput);
    if (!sarifResult.ok) throw new Error(JSON.stringify(sarifResult.issues));
    assertInert(sarifResult.text);
  });

  test("round-trips only canonical percent-encoded repository-relative SARIF URIs", () => {
    const path = "docs/żółć file.md";
    const encoded = encodeSarifArtifactUri(path);
    expect(encoded).toBe("docs/%C5%BC%C3%B3%C5%82%C4%87%20file.md");
    expect(encoded === undefined ? undefined : decodeSarifArtifactUri(encoded)).toBe(path);
    expect(encodeSarifArtifactUri("docs/a(b).md")).toBe("docs/a%28b%29.md");
    for (const invalid of [
      "docs/żółć.md",
      "docs/%",
      "docs/%c5%bc.md",
      "docs/a?b.md",
      "docs/a#b.md",
      "docs/%2Fescape.md",
      "docs/%FF.md",
    ]) {
      expect(decodeSarifArtifactUri(invalid)).toBeUndefined();
    }
  });

  test("sanitizes dynamic object keys without collision loss", () => {
    const sanitized = sanitizeOutputJson({ SECRET_CANARY_A: 1, SECRET_CANARY_B: 2 });
    expect(sanitized).toEqual({ REDACTED: 1, "REDACTED-2": 2 });
    expect(sanitizeOutputJson(42)).toBe(42);
  });

  test("aligns schema code-point limits with runtime UTF-8 limits", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(json(DIAGNOSTIC_SCHEMA) as AnySchema);
    const nativeSchema = ajv.compile(json(OUTPUT_SCHEMA) as AnySchema);
    const boundary = terminal();
    boundary["lines"] = ["😀".repeat(MAX_OUTPUT_TEXT_CODE_POINTS)];
    expect(nativeSchema(boundary), JSON.stringify(nativeSchema.errors)).toBe(true);
    expect(validateTerminalOutput(boundary)).toMatchObject({ ok: true });
    const over = terminal();
    over["lines"] = ["x".repeat(MAX_OUTPUT_TEXT_CODE_POINTS + 1)];
    expect(nativeSchema(over)).toBe(false);
    expect(validateTerminalOutput(over)).toMatchObject({ ok: false });
  });

  test("keeps bounded version, SARIF URI, and GitHub fingerprint limits schema/runtime equivalent", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(json(DIAGNOSTIC_SCHEMA) as AnySchema);
    const nativeSchema = ajv.compile(json(OUTPUT_SCHEMA) as AnySchema);
    const sarifSchema = ajv.compile(json(SARIF_SCHEMA) as AnySchema);

    const versionBoundary = efficiency();
    versionBoundary["profileVersion"] = `${"1".repeat(4_092)}.0.0`;
    expect(nativeSchema(versionBoundary), JSON.stringify(nativeSchema.errors)).toBe(true);
    expect(validateEfficiencyOutput(versionBoundary)).toMatchObject({ ok: true });
    const versionOver = structuredClone(versionBoundary);
    versionOver["profileVersion"] = `${"1".repeat(4_093)}.0.0`;
    expect(nativeSchema(versionOver)).toBe(false);
    expect(validateEfficiencyOutput(versionOver)).toMatchObject({ ok: false });

    const uriPrefix = "https://example.test/";
    const uriBoundary = sarif();
    at(at(first(uriBoundary, "runs"), "tool"), "driver")["informationUri"] =
      uriPrefix + "a".repeat(MAX_OUTPUT_TEXT_CODE_POINTS - uriPrefix.length);
    expect(sarifSchema(uriBoundary), JSON.stringify(sarifSchema.errors)).toBe(true);
    expect(validateSarifOutput(uriBoundary)).toMatchObject({ ok: true });
    const uriOver = structuredClone(uriBoundary);
    at(at(first(uriOver, "runs"), "tool"), "driver")["informationUri"] =
      uriPrefix + "a".repeat(MAX_OUTPUT_TEXT_CODE_POINTS + 1 - uriPrefix.length);
    expect(sarifSchema(uriOver)).toBe(false);
    expect(validateSarifOutput(uriOver)).toMatchObject({ ok: false });

    const fingerprintBoundary = sarif();
    const boundaryResult = first(first(fingerprintBoundary, "runs"), "results");
    const boundaryFingerprints = boundaryResult["partialFingerprints"] as Record<string, unknown>;
    boundaryFingerprints["primaryLocationLineHash"] = `${"a".repeat(4_094)}:1`;
    expect(sarifSchema(fingerprintBoundary), JSON.stringify(sarifSchema.errors)).toBe(true);
    expect(validateSarifOutput(fingerprintBoundary)).toMatchObject({ ok: true });
    const fingerprintOver = structuredClone(fingerprintBoundary);
    const overFingerprints = first(first(fingerprintOver, "runs"), "results")[
      "partialFingerprints"
    ] as Record<string, unknown>;
    overFingerprints["primaryLocationLineHash"] = `${"a".repeat(4_095)}:1`;
    expect(sarifSchema(fingerprintOver)).toBe(false);
    expect(validateSarifOutput(fingerprintOver)).toMatchObject({ ok: false });
  });

  test("rejects syntactically shaped but impossible or noncanonical UTC timestamps", () => {
    for (const invalid of ["2026-02-30T12:00:00.000Z", "2026-08-02T12:00:00Z"]) {
      const output = standards();
      at(output, "bundled")["retrievedAt"] = invalid;
      expectInvalid(validateStandardsOutput(output), "invalid-value", "$.bundled.retrievedAt");
    }
  });

  test("schema and runtime reject the same closed-shape mutations", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(json(DIAGNOSTIC_SCHEMA) as AnySchema);
    const nativeSchema = ajv.compile(json(OUTPUT_SCHEMA) as AnySchema);
    const mutations: NativeOutputDocument[] = [];
    for (const fixture of [terminal(), efficiency(), standards(), baseline()]) {
      const missing = structuredClone(fixture);
      Reflect.deleteProperty(missing, "schemaVersion");
      mutations.push(missing as unknown as NativeOutputDocument);
      const extra = structuredClone(fixture);
      extra["unexpected"] = true;
      mutations.push(extra as unknown as NativeOutputDocument);
    }
    for (const value of mutations) {
      expect(nativeSchema(value)).toBe(false);
      expect(validateNativeOutput(value).ok).toBe(false);
    }
    const sarifSchema = ajv.compile(json(SARIF_SCHEMA) as AnySchema);
    const invalidSarif = sarif();
    invalidSarif["version"] = "2.2.0";
    expect(sarifSchema(invalidSarif)).toBe(false);
    expect(validateSarifOutput(invalidSarif).ok).toBe(false);
  });
});

describe("output compatibility policy", () => {
  test("classifies patch, additive minor, newer producer, and breaking major changes", () => {
    expect(classifyOutputCompatibility("1.2.4", "1.2.3")).toEqual({
      change: "patch",
      compatible: true,
      reason: "patch revisions do not change the accepted document shape",
    });
    expect(classifyOutputCompatibility("1.1.0", "1.2.0")).toMatchObject({
      change: "minor",
      compatible: true,
    });
    expect(classifyOutputCompatibility("1.3.0", "1.2.0")).toMatchObject({
      change: "minor",
      compatible: false,
    });
    expect(classifyOutputCompatibility("2.0.0", "1.9.0")).toMatchObject({
      change: "major",
      compatible: false,
    });
    expect(classifyOutputCompatibility("v1", "1.0.0")).toMatchObject({
      change: "major",
      compatible: false,
    });
    const huge = "9".repeat(80);
    expect(classifyOutputCompatibility(`1.${huge}.0`, `1.${"8".repeat(80)}.0`)).toMatchObject({
      change: "minor",
      compatible: false,
    });
    expect(classifyOutputCompatibility(`${huge}.1.0`, `${huge}.2.0`)).toMatchObject({
      change: "minor",
      compatible: true,
    });
  });
});
