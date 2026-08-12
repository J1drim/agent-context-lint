import { describe, expect, test } from "vitest";

import {
  buildSeededRecallScenarios,
  executeSeededRecallScenarios,
} from "./helpers/seeded-recall-corpus.js";

const EXPECTED_BY_SCENARIO: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "references-paths": Object.freeze(["ACL150", "ACL151", "ACL152", "ACL153", "ACL154", "ACL156"]),
  "references-unsupported": Object.freeze(["ACL155"]),
  "repository-drift-all": Object.freeze([
    "ACL300",
    "ACL301",
    "ACL302",
    "ACL303",
    "ACL304",
    "ACL305",
  ]),
  "scope-acl200": Object.freeze(["ACL200"]),
  "scope-acl201": Object.freeze(["ACL201"]),
  "scope-acl202": Object.freeze(["ACL202"]),
  "scope-acl203": Object.freeze(["ACL203"]),
  "scope-acl204": Object.freeze(["ACL204"]),
  "scope-acl205": Object.freeze(["ACL205"]),
  "scope-acl206": Object.freeze(["ACL206"]),
  "security-all": Object.freeze([
    "ACL400",
    "ACL401",
    "ACL402",
    "ACL403",
    "ACL404",
    "ACL405",
    "ACL406",
  ]),
  "standards-acl500": Object.freeze(["ACL500"]),
  "standards-acl501": Object.freeze(["ACL501"]),
  "standards-acl502": Object.freeze(["ACL502"]),
  "standards-acl503": Object.freeze(["ACL503"]),
  "standards-acl504": Object.freeze(["ACL504"]),
  "standards-acl505": Object.freeze(["ACL505"]),
  "standards-acl506": Object.freeze(["ACL506"]),
  "conflicts-acl250": Object.freeze(["ACL250"]),
  "conflicts-acl251": Object.freeze(["ACL251"]),
  "conflicts-acl252": Object.freeze(["ACL252"]),
  "conflicts-acl253": Object.freeze(["ACL253"]),
  "conflicts-acl254": Object.freeze(["ACL254"]),
  "conflicts-acl255": Object.freeze(["ACL255"]),
  "document-context-all": Object.freeze([
    "ACL350",
    "ACL351",
    "ACL352",
    "ACL353",
    "ACL354",
    "ACL355",
  ]),
  "efficiency-amplification": Object.freeze(["ACL554"]),
  "efficiency-duplicate": Object.freeze(["ACL552"]),
  "efficiency-scope": Object.freeze(["ACL550", "ACL551", "ACL553", "ACL556", "ACL557", "ACL558"]),
  "efficiency-vendor": Object.freeze(["ACL555"]),
  "portability-cross-agent": Object.freeze(["ACL450", "ACL451", "ACL452"]),
  "portability-editor": Object.freeze(["ACL453"]),
  "syntax-acl100": Object.freeze(["ACL100"]),
  "syntax-acl101": Object.freeze(["ACL101"]),
  "syntax-acl102": Object.freeze(["ACL102"]),
  "syntax-acl103": Object.freeze(["ACL103"]),
  "syntax-acl104": Object.freeze(["ACL104"]),
  "syntax-acl105": Object.freeze(["ACL105"]),
  "syntax-acl106": Object.freeze(["ACL106"]),
  "syntax-acl107": Object.freeze(["ACL107"]),
  "syntax-acl108": Object.freeze(["ACL108"]),
  "syntax-acl109": Object.freeze(["ACL109"]),
});

describe("F16 seeded recall corpus", () => {
  test("runs one genuine seed per registered rule through the public F15 scheduler", async () => {
    const scenarios = await buildSeededRecallScenarios();
    expect(scenarios.map((entry) => entry.id).sort()).toEqual(
      Object.keys(EXPECTED_BY_SCENARIO).sort(),
    );
    const executions = await executeSeededRecallScenarios();
    for (const { result, scenario } of executions) {
      const actual = new Set(result.visibleDiagnostics.map((entry) => entry.ruleId));
      for (const ruleId of EXPECTED_BY_SCENARIO[scenario.id] ?? [])
        expect(actual.has(ruleId), `${scenario.id} must emit ${ruleId}`).toBe(true);
    }
  });
});
