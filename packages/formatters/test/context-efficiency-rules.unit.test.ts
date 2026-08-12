import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  formatJsonDiagnostics,
  formatSarifDiagnostics,
  formatStylishDiagnostics,
} from "../src/index.js";

import type { DiagnosticBundle, SourceDocument } from "@agent-context/core";

const GOLDEN = new URL(
  "../../rules/test/fixtures/context-efficiency.all-rules.golden.json",
  import.meta.url,
);

interface Golden {
  readonly bundle: DiagnosticBundle;
  readonly sources: readonly SourceDocument[];
}

function golden(): Golden {
  return JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;
}

describe("F14 formatter integration", () => {
  test("renders ACL550-ACL558 evidence through stylish, JSON, and SARIF", () => {
    const fixture = golden();
    const profileVersions = {
      "codex-cli": { clientVersion: null, profileVersion: "1.0.0" },
    };
    const stylish = formatStylishDiagnostics(fixture.bundle, fixture.sources);
    const json = formatJsonDiagnostics(fixture.bundle, fixture.sources, { profileVersions });
    const sarif = formatSarifDiagnostics(fixture.bundle, fixture.sources, {
      informationUri: "https://agent-context-lint.dev/",
      profileVersions,
      ruleDocumentationBaseUri: "https://agent-context-lint.dev/",
      toolVersion: "1.0.0",
    });
    expect(stylish.ok, JSON.stringify(stylish)).toBe(true);
    expect(json.ok, JSON.stringify(json)).toBe(true);
    expect(sarif.ok, JSON.stringify(sarif)).toBe(true);
    if (!stylish.ok || !json.ok || !sarif.ok) return;
    expect(stylish.text).toContain("ACL550");
    expect(stylish.text).toContain("ACL558");
    expect(JSON.parse(json.text)).toMatchObject({
      summary: { errors: 0, infos: 5, warnings: 4 },
    });
    const sarifOutput = JSON.parse(sarif.text) as {
      readonly runs: readonly { readonly results: readonly { readonly ruleId: string }[] }[];
      readonly version: string;
    };
    expect(sarifOutput.version).toBe("2.1.0");
    expect(sarifOutput.runs[0]?.results.map((entry) => entry.ruleId)).toEqual([
      "ACL550",
      "ACL551",
      "ACL552",
      "ACL553",
      "ACL554",
      "ACL555",
      "ACL556",
      "ACL557",
      "ACL558",
    ]);
  });
});
