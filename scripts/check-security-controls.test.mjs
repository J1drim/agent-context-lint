import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  dependabotPath,
  secretScanAdjudicatorPath,
  secretScanBaselinePath,
  validateSecuritySources,
} from "./check-security-controls.mjs";

const sources = {
  dependabot: await readFile(dependabotPath, "utf8"),
  secretAdjudicator: await readFile(secretScanAdjudicatorPath, "utf8"),
  secretBaseline: await readFile(secretScanBaselinePath, "utf8"),
  workflowEntries: [],
};

function mutate(field, from, to) {
  assert.ok(sources[field].includes(from), `mutation source missing from ${field}: ${from}`);
  return { ...sources, [field]: sources[field].replace(from, to) };
}

test("committed local security controls satisfy the local-only contract", () => {
  assert.deepEqual(validateSecuritySources(sources), {
    hostedWorkflows: 0,
    dependabot: "npm-weekly",
    secretScan: "local-adjudicator",
  });
});

test("hosted workflow definitions are rejected", () => {
  assert.throws(
    () => validateSecuritySources({ ...sources, workflowEntries: ["ci.yml"] }),
    /workflows are disabled/u,
  );
});

test("Dependabot cannot reintroduce the GitHub Actions ecosystem", () => {
  assert.throws(
    () =>
      validateSecuritySources(
        mutate("dependabot", "package-ecosystem: npm", "package-ecosystem: github-actions"),
      ),
    /npm update policy/u,
  );
});

test("the local secret adjudicator remains dependency-free and the baseline remains closed", () => {
  assert.throws(
    () =>
      validateSecuritySources({
        ...sources,
        secretAdjudicator: `${sources.secretAdjudicator}\nawait import("yaml");\n`,
      }),
    /exact Node built-ins/u,
  );
  assert.throws(() => validateSecuritySources({ ...sources, secretBaseline: "{}\n" }), /baseline/u);
});
