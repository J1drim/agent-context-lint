import { readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import AjvDraft04Import from "ajv-draft-04";
import addFormatsImport from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import {
  canonicalizeRepositoryRelativePath,
  computePathFingerprint,
  computeSemanticFingerprint,
  validateInstructionIr,
  validateSarifOutput,
} from "@agent-context/core";
import { RULE_REGISTRY } from "@agent-context/rules";

import { computeGithubPrimaryLocationLineHashes, formatSarifDiagnostics } from "../src/index.js";

import type { SourceDocument } from "@agent-context/core";
import type { SarifFormatterOptions } from "../src/index.js";

const DIAGNOSTICS = new URL("../../core/test/fixtures/diagnostics.valid.json", import.meta.url);
const IR = new URL("../../core/test/fixtures/instruction-ir.valid.json", import.meta.url);
const GOLDEN = new URL("./fixtures/sarif.valid.json", import.meta.url);
const GITHUB_ANNOTATION = new URL(
  "./fixtures/github-code-scanning.annotation.json",
  import.meta.url,
);
const OFFICIAL_SCHEMA = new URL(
  "../../../third_party/oasis-sarif-2.1.0-errata01/sarif-schema-2.1.0.json",
  import.meta.url,
);
const LOCAL_SCHEMA = new URL(
  "../../core/schemas/sarif-output.v2.1.0-product-v2.schema.json",
  import.meta.url,
);
const ESCAPE = String.fromCharCode(0x1b);
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const AjvDraft04 = AjvDraft04Import.default;
const addFormats = addFormatsImport.default;

function json(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function bundle(): Record<string, unknown> {
  return structuredClone(json(DIAGNOSTICS)) as Record<string, unknown>;
}

function sources(): readonly SourceDocument[] {
  const validation = validateInstructionIr(json(IR));
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value.sources;
}

function options(): SarifFormatterOptions {
  return {
    toolVersion: "1.2.3",
    informationUri: "https://agent-context-lint.dev/",
    ruleDocumentationBaseUri: "https://agent-context-lint.dev/",
    profileVersions: {
      "codex-cli": { profileVersion: "1.0.0", clientVersion: "0.146.0" },
    },
  };
}

function firstRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!Array.isArray(value) || value[0] === null || typeof value[0] !== "object")
    throw new TypeError(`expected ${key} to contain an object`);
  return value[0] as Record<string, unknown>;
}

function diagnosticVariant(
  template: Record<string, unknown>,
  suffix: string,
): Record<string, unknown> {
  const diagnostic = structuredClone(template);
  const pathBasis = { anchor: `statement:${suffix}`, profileIds: ["codex-cli"] };
  const semanticBasis = {
    components: [{ key: "case", value: suffix }],
    profileIds: ["codex-cli"],
  };
  diagnostic["id"] = `diagnostic:${suffix}`;
  diagnostic["message"] = `${suffix}-order-marker`;
  diagnostic["related"] = [];
  diagnostic["suggestion"] = null;
  diagnostic["fingerprintBasis"] = { path: pathBasis, semantic: semanticBasis };
  diagnostic["fingerprints"] = {
    path: {
      method: "agent-context-lint/path/v1",
      value: computePathFingerprint({
        ruleId: "ACL250",
        ruleVersion: "1.0.0",
        path: canonicalizeRepositoryRelativePath("AGENTS.md"),
        basis: pathBasis,
      }),
    },
    semantic: {
      method: "agent-context-lint/semantic/v1",
      value: computeSemanticFingerprint({
        ruleId: "ACL250",
        ruleVersion: "1.0.0",
        basis: semanticBasis,
      }),
    },
  };
  return diagnostic;
}

function setDiagnosticRule(
  diagnostic: Record<string, unknown>,
  ruleId: string,
  severity: "error" | "info" | "warning",
): void {
  const basis = diagnostic["fingerprintBasis"] as {
    path: { anchor: string; profileIds: readonly string[] };
    semantic: {
      components: readonly { key: string; value: string }[];
      profileIds: readonly string[];
    };
  };
  diagnostic["ruleId"] = ruleId;
  diagnostic["severity"] = severity;
  diagnostic["fingerprints"] = {
    path: {
      method: "agent-context-lint/path/v1",
      value: computePathFingerprint({
        ruleId,
        ruleVersion: "1.0.0",
        path: canonicalizeRepositoryRelativePath("AGENTS.md"),
        basis: basis.path,
      }),
    },
    semantic: {
      method: "agent-context-lint/semantic/v1",
      value: computeSemanticFingerprint({ ruleId, ruleVersion: "1.0.0", basis: basis.semantic }),
    },
  };
}

function replaceExactString(value: unknown, before: string, after: string): void {
  if (Array.isArray(value)) {
    for (const item of value) replaceExactString(item, before, after);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (child === before) (value as Record<string, unknown>)[key] = after;
    else replaceExactString(child, before, after);
  }
}

describe("I06 SARIF formatter", () => {
  test("renders deterministic canonical SARIF with complete GitHub metadata and provenance", () => {
    const result = formatSarifDiagnostics(bundle(), sources(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(JSON.parse(result.text)).toEqual(json(GOLDEN));
    expect(result.text.endsWith("\n")).toBe(true);
    expect(result.text.endsWith("\n\n")).toBe(false);
    expect(result.byteLength).toBe(Buffer.byteLength(result.text));
    expect(validateSarifOutput(result.output).ok).toBe(true);
    const run = result.output.runs[0];
    expect(run?.properties.agentContextSchemaVersion).toBe("2.0.0");
    expect(run?.tool.driver.rules[0]).toMatchObject({
      id: "ACL250",
      helpUri: "https://agent-context-lint.dev/docs/rules/catalog.md#acl250",
      properties: { "problem.severity": "error" },
    });
    expect(run?.results[0]).toMatchObject({
      ruleId: "ACL250",
      level: "error",
      properties: {
        agentContextRuleVersion: "1.0.0",
        profileIds: ["codex-cli"],
        surfaceIds: ["codex-cli/local-cli-single-cwd"],
        specSnapshotIds: ["codex-cli/0.146.0/2026-08-01"],
      },
    });
    expect(run?.results[0]?.partialFingerprints).toEqual({
      primaryLocationLineHash: "9ac30a333ce4a531:1",
      "agentContextPath/v1": "dde482dcc539531e5e98bd71063388925f7f566e97a2cca924eb567a47072916",
      "agentContextSemantic/v1": "6c049bc33df348a479d475fcc462b6f98e6d17c12846a284870e22bf8894ba02",
    });
  });

  test("satisfies the exact OASIS schema and the closed product v2 schema", () => {
    const result = formatSarifDiagnostics(bundle(), sources(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const official = new AjvDraft04({ allErrors: true, strict: true, strictRequired: false });
    addFormats(official);
    const local = new Ajv2020({ allErrors: true, strict: true });
    const validateOfficial = official.compile(json(OFFICIAL_SCHEMA) as AnySchema);
    const validateLocal = local.compile(json(LOCAL_SCHEMA) as AnySchema);
    expect(validateOfficial(result.output), JSON.stringify(validateOfficial.errors)).toBe(true);
    expect(validateLocal(result.output), JSON.stringify(validateLocal.errors)).toBe(true);
  });

  test("pins the fields GitHub uses to create and correlate a code-scanning annotation", () => {
    const result = formatSarifDiagnostics(bundle(), sources(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const run = result.output.runs[0];
    const annotation = run?.results[0];
    const rule = run?.tool.driver.rules[annotation?.ruleIndex ?? -1];
    const primary = annotation?.locations[0].physicalLocation;
    expect({
      artifactUri: primary?.artifactLocation.uri,
      region: primary?.region,
      level: annotation?.level,
      ruleId: annotation?.ruleId,
      helpUri: rule?.helpUri,
      partialFingerprints: annotation?.partialFingerprints,
      provenance:
        annotation === undefined
          ? undefined
          : {
              profileIds: annotation.properties.profileIds,
              surfaceIds: annotation.properties.surfaceIds,
              specSnapshotIds: annotation.properties.specSnapshotIds,
            },
    }).toEqual(json(GITHUB_ANNOTATION));
  });

  test("matches GitHub rolling-hash behavior across whitespace, CRLF, duplicate lines, and EOF", () => {
    const lf = computeGithubPrimaryLocationLineHashes("alpha\nbeta\nalpha\n");
    const crlf = computeGithubPrimaryLocationLineHashes(" a l p h a \r\n\tbeta\r\nalpha\r\n");
    expect([...lf]).toEqual([
      [1, "8d07ce75f7b3af45:1"],
      [2, "ca140c3f893ffa65:1"],
      [3, "26f09ff008857193:1"],
      [4, "c129715d7a2bc9a3:1"],
    ]);
    expect([...crlf]).toEqual([...lf]);
    expect(computeGithubPrimaryLocationLineHashes("").get(1)).toBe("c129715d7a2bc9a3:1");
    expect(computeGithubPrimaryLocationLineHashes("x".repeat(150)).size).toBe(1);
  });

  test("preserves active caller order while sorting the referenced rule table", () => {
    const candidate = bundle();
    const template = firstRecord(candidate, "diagnostics");
    const alpha = diagnosticVariant(template, "alpha");
    const omega = diagnosticVariant(template, "omega");
    candidate["diagnostics"] = [omega, alpha];
    candidate["suppressions"] = [];
    const result = formatSarifDiagnostics(candidate, sources(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.output.runs[0]?.results.map((item) => item.message.text)).toEqual([
      "omega-order-marker",
      "alpha-order-marker",
    ]);
    expect(result.output.runs[0]?.tool.driver.rules.map((rule) => rule.id)).toEqual(["ACL250"]);
    expect(formatSarifDiagnostics(candidate, sources(), options())).toEqual(result);
  });

  test("maps error, warning, and informational rule metadata while keeping result order", () => {
    const candidate = bundle();
    const template = firstRecord(candidate, "diagnostics");
    const warningMetadata = RULE_REGISTRY.rules.find((rule) => rule.defaultSeverity === "warning");
    const infoMetadata = RULE_REGISTRY.rules.find((rule) => rule.defaultSeverity === "info");
    if (warningMetadata === undefined || infoMetadata === undefined)
      throw new Error("registry must contain warning and info rules");
    const errorDiagnostic = diagnosticVariant(template, "error");
    const warningDiagnostic = diagnosticVariant(template, "warning");
    const infoDiagnostic = diagnosticVariant(template, "info");
    setDiagnosticRule(errorDiagnostic, "ACL250", "error");
    setDiagnosticRule(warningDiagnostic, warningMetadata.id, "warning");
    setDiagnosticRule(infoDiagnostic, infoMetadata.id, "info");
    candidate["diagnostics"] = [infoDiagnostic, errorDiagnostic, warningDiagnostic];
    candidate["suppressions"] = [];
    const result = formatSarifDiagnostics(candidate, sources(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const run = result.output.runs[0];
    expect(run?.results.map((item) => item.level)).toEqual(["note", "error", "warning"]);
    expect(run?.tool.driver.rules.map((rule) => rule.id)).toEqual(
      [infoMetadata.id, "ACL250", warningMetadata.id].sort(),
    );
    expect(
      run?.tool.driver.rules.find((rule) => rule.id === infoMetadata.id)?.properties[
        "problem.severity"
      ],
    ).toBe("recommendation");
  });

  test("omits suppressed diagnostics without mutating the B04 bundle", () => {
    const candidate = bundle();
    const diagnostic = firstRecord(candidate, "diagnostics");
    const suppression = firstRecord(candidate, "suppressions");
    const path = (diagnostic["fingerprints"] as Record<string, Record<string, unknown>>)["path"]?.[
      "value"
    ];
    suppression["state"] = "suppressed";
    suppression["matchedPathFingerprints"] = [path];
    const before = JSON.stringify(candidate);
    const result = formatSarifDiagnostics(candidate, sources(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.output.runs[0]?.results).toEqual([]);
    expect(result.output.runs[0]?.tool.driver.rules).toEqual([]);
    expect(JSON.stringify(candidate)).toBe(before);
    formatSarifDiagnostics(candidate, sources(), options());
    expect(JSON.stringify(candidate)).toBe(before);
  });

  test("emits consecutive related-location ids and GitHub message links after stable deduplication", () => {
    const candidate = bundle();
    const diagnostic = firstRecord(candidate, "diagnostics");
    diagnostic["message"] = "x".repeat(4_096);
    const related = diagnostic["related"] as Record<string, unknown>[];
    const repository = related[1];
    const resolution = related[2];
    const primary = diagnostic["primary"] as Record<string, unknown>;
    const other = structuredClone(primary);
    other["range"] = {
      sourceId: "source:agents",
      start: { byteOffset: 0, utf16Offset: 0, line: 0, utf16Column: 0 },
      end: { byteOffset: 7, utf16Offset: 7, line: 0, utf16Column: 7 },
    };
    if (repository === undefined) throw new Error("missing repository evidence");
    repository["locations"] = [other, structuredClone(other)];
    if (resolution === undefined) throw new Error("missing resolution evidence");
    const resolutionLocation = structuredClone(primary);
    resolutionLocation["range"] = {
      sourceId: "source:agents",
      start: { byteOffset: 32, utf16Offset: 30, line: 4, utf16Column: 0 },
      end: { byteOffset: 46, utf16Offset: 44, line: 4, utf16Column: 14 },
    };
    resolution["sourceLocations"] = [resolutionLocation];
    const result = formatSarifDiagnostics(candidate, sources(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const output = result.output.runs[0]?.results[0];
    expect(output?.relatedLocations).toHaveLength(2);
    expect(output?.relatedLocations[0]).toMatchObject({
      id: 1,
      message: { text: "Workspace package manager" },
    });
    expect(output?.message.text).toContain("[related location 1](1)");
    expect(output?.message.text).toContain("[related location 2](2)");
    expect(Array.from(output?.message.text ?? "")).toHaveLength(4_096);
  });

  test("uses canonical relative artifact URIs for spaces and Unicode without host paths", () => {
    const candidate = bundle();
    const selectedSources = structuredClone(sources()) as SourceDocument[];
    replaceExactString(candidate, "AGENTS.md", "docs/agent context-✓.md");
    const diagnostic = firstRecord(candidate, "diagnostics");
    const basis = diagnostic["fingerprintBasis"] as {
      path: { anchor: string; profileIds: readonly string[] };
    };
    const fingerprints = diagnostic["fingerprints"] as Record<string, Record<string, unknown>>;
    if (fingerprints["path"] === undefined) throw new Error("missing path fingerprint");
    fingerprints["path"]["value"] = computePathFingerprint({
      ruleId: "ACL250",
      ruleVersion: "1.0.0",
      path: canonicalizeRepositoryRelativePath("docs/agent context-✓.md"),
      basis: basis.path,
    });
    if (selectedSources[0] === undefined) throw new Error("missing source");
    (selectedSources[0] as { path: string }).path = "docs/agent context-✓.md";
    const result = formatSarifDiagnostics(candidate, selectedSources, options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const uri =
      result.output.runs[0]?.results[0]?.locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe("docs/agent%20context-%E2%9C%93.md");
    expect(result.text).not.toContain("/private/");
  });

  test("redacts secrets and neutralizes ANSI, controls, bidi, and hostile Markdown labels", () => {
    const candidate = bundle();
    const diagnostic = firstRecord(candidate, "diagnostics");
    diagnostic["message"] =
      `password=top-secret ${ESCAPE}[31mforged${ESCAPE}[0m\n${BIDI_OVERRIDE} SECRET_CANARY_I06`;
    const related = diagnostic["related"] as Record<string, unknown>[];
    const source = related[0];
    if (source === undefined) throw new Error("missing evidence");
    source["label"] = "](${ESCAPE}[31m SECRET_CANARY_I06";
    const result = formatSarifDiagnostics(candidate, sources(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.text).not.toContain("top-secret");
    expect(result.text).not.toContain("SECRET_CANARY_I06");
    expect(result.text).not.toContain(ESCAPE);
    expect(result.text).not.toContain(BIDI_OVERRIDE);
    expect(result.text).toContain("password=REDACTED");
  });

  test.each([
    ["missing options", undefined],
    ["unknown field", { ...options(), unknown: true }],
    ["bad version", { ...options(), toolVersion: "latest" }],
    ["credential URI", { ...options(), informationUri: "https://user:secret@example.test/" }],
    [
      "non-directory docs",
      { ...options(), ruleDocumentationBaseUri: "https://example.test/rules?q=1" },
    ],
    [
      "missing profile",
      {
        ...options(),
        profileVersions: { other: { profileVersion: "1.0.0", clientVersion: null } },
      },
    ],
  ])("fails closed for %s", (_name, input) => {
    const result = formatSarifDiagnostics(bundle(), sources(), input as SarifFormatterOptions);
    expect(result.ok).toBe(false);
  });

  test("bounds client-version text and exercises closed nested profile validation", () => {
    const emptyClient = {
      ...options(),
      profileVersions: {
        "codex-cli": { profileVersion: "1.0.0", clientVersion: "" },
      },
    };
    const emptyResult = formatSarifDiagnostics(bundle(), sources(), emptyClient);
    expect(emptyResult.ok).toBe(true);
    if (!emptyResult.ok) throw new Error(JSON.stringify(emptyResult.issues));
    expect(emptyResult.output.runs[0]?.properties.profileVersions["codex-cli"]?.clientVersion).toBe(
      "REDACTED",
    );

    const longClient = {
      ...options(),
      profileVersions: {
        "codex-cli": { profileVersion: "1.0.0", clientVersion: "x".repeat(5_000) },
      },
    };
    const longResult = formatSarifDiagnostics(bundle(), sources(), longClient);
    expect(longResult.ok).toBe(true);
    if (!longResult.ok) throw new Error(JSON.stringify(longResult.issues));
    expect(
      longResult.output.runs[0]?.properties.profileVersions["codex-cli"]?.clientVersion,
    ).toHaveLength(4_096);

    class NonPlainOptions {
      readonly marker = true;
    }
    class NonPlainProfiles {
      readonly marker = true;
    }
    const symbolOptions = { ...options(), [Symbol("unknown")]: true };
    const symbolProfiles = {
      "codex-cli": options().profileVersions["codex-cli"],
      [Symbol("x")]: 1,
    };
    const accessorProfiles = Object.defineProperty({}, "codex-cli", {
      enumerable: true,
      get: () => options().profileVersions["codex-cli"],
    });
    const malformedProfiles: readonly unknown[] = [
      null,
      [],
      {},
      new NonPlainProfiles(),
      { "bad profile": { profileVersion: "1.0.0", clientVersion: null } },
      { "codex-cli": { profileVersion: "1.0.0" } },
      { "codex-cli": { profileVersion: "latest", clientVersion: null } },
      { "codex-cli": { profileVersion: "1.0.0", clientVersion: 7 } },
      symbolProfiles,
      accessorProfiles,
    ];
    for (const profileVersions of malformedProfiles)
      expect(
        formatSarifDiagnostics(bundle(), sources(), {
          ...options(),
          profileVersions,
        } as SarifFormatterOptions).ok,
      ).toBe(false);
    expect(
      formatSarifDiagnostics(
        bundle(),
        sources(),
        new NonPlainOptions() as unknown as SarifFormatterOptions,
      ).ok,
    ).toBe(false);
    expect(formatSarifDiagnostics(bundle(), sources(), symbolOptions).ok).toBe(false);
    for (const informationUri of ["https://example.test/%zz", "https://["])
      expect(formatSarifDiagnostics(bundle(), sources(), { ...options(), informationUri }).ok).toBe(
        false,
      );
  });

  test("rejects a valid diagnostic set whose completed SARIF exceeds the byte budget", () => {
    const candidate = bundle();
    const template = firstRecord(candidate, "diagnostics");
    candidate["diagnostics"] = Array.from({ length: 2_500 }, (_value, index) => {
      const diagnostic = diagnosticVariant(template, String(index).padStart(4, "0"));
      diagnostic["message"] = "x".repeat(4_096);
      return diagnostic;
    });
    candidate["suppressions"] = [];
    expect(formatSarifDiagnostics(candidate, sources(), options())).toMatchObject({
      ok: false,
      issues: [
        { code: "resource-limit", message: "SARIF output exceeds the formatter byte budget" },
      ],
    });
  });

  test("rejects accessors, unknown rules, malformed bundles, and revoked proxies without throwing", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "toolVersion", {
      get() {
        calls += 1;
        return "1.0.0";
      },
    });
    expect(formatSarifDiagnostics(bundle(), sources(), accessor as SarifFormatterOptions).ok).toBe(
      false,
    );
    expect(calls).toBe(0);
    const unknown = bundle();
    const unknownDiagnostic = firstRecord(unknown, "diagnostics");
    unknownDiagnostic["ruleId"] = "ACL149";
    const unknownBasis = unknownDiagnostic["fingerprintBasis"] as {
      path: { anchor: string; profileIds: readonly string[] };
      semantic: {
        components: readonly { key: string; value: string }[];
        profileIds: readonly string[];
      };
    };
    unknownDiagnostic["fingerprints"] = {
      path: {
        method: "agent-context-lint/path/v1",
        value: computePathFingerprint({
          ruleId: "ACL149",
          ruleVersion: "1.0.0",
          path: canonicalizeRepositoryRelativePath("AGENTS.md"),
          basis: unknownBasis.path,
        }),
      },
      semantic: {
        method: "agent-context-lint/semantic/v1",
        value: computeSemanticFingerprint({
          ruleId: "ACL149",
          ruleVersion: "1.0.0",
          basis: unknownBasis.semantic,
        }),
      },
    };
    expect(formatSarifDiagnostics(unknown, sources(), options())).toMatchObject({
      ok: false,
      issues: [{ code: "missing-rule-metadata" }],
    });
    expect(formatSarifDiagnostics({}, sources(), options()).ok).toBe(false);
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(() => formatSarifDiagnostics(revocable.proxy, sources(), options())).not.toThrow();
    expect(formatSarifDiagnostics(revocable.proxy, sources(), options()).ok).toBe(false);
  });

  test("returns deeply immutable success and failure models", () => {
    const success = formatSarifDiagnostics(bundle(), sources(), options());
    const failed = formatSarifDiagnostics({}, sources(), options());
    expect(Object.isFrozen(success)).toBe(true);
    expect(Object.isFrozen(failed)).toBe(true);
    if (success.ok) {
      expect(Object.isFrozen(success.output)).toBe(true);
      expect(Object.isFrozen(success.output.runs)).toBe(true);
      expect(Object.isFrozen(success.output.runs[0]?.results)).toBe(true);
      expect(Object.isFrozen(success.output.runs[0]?.tool.driver.rules[0]?.help)).toBe(true);
    }
    if (!failed.ok) {
      expect(Object.isFrozen(failed.issues)).toBe(true);
      expect(Object.isFrozen(failed.issues[0])).toBe(true);
    }
  });
});
