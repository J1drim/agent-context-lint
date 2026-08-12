import assert from "node:assert/strict";
import test from "node:test";

import { validateLocalPolicy } from "./check-local-policy.mjs";

const packageJson = {
  scripts: {
    "verify:local": "node scripts/run-local-gate.mjs",
    "hooks:install": "node scripts/install-git-hooks.mjs",
  },
};
const dependabot = {
  version: 2,
  updates: [
    {
      "package-ecosystem": "npm",
      directory: "/",
      schedule: { interval: "weekly", day: "monday", time: "06:00", timezone: "Europe/Warsaw" },
      "open-pull-requests-limit": 10,
      groups: {
        "development-tooling": {
          "dependency-type": "development",
          "update-types": ["minor", "patch"],
        },
      },
      "commit-message": { prefix: "deps" },
    },
  ],
};

function sources(overrides = {}) {
  return {
    workflowEntries: [],
    hook: "#!/bin/sh\nexec node scripts/run-local-gate.mjs --verify-push\n",
    packageJson,
    dependabot,
    ...overrides,
  };
}

test("local policy accepts a hook-only repository", () => {
  assert.deepEqual(validateLocalPolicy(sources()), {
    hostedWorkflows: 0,
    hook: "pre-push",
    report: ".git/local-gate-result.json",
  });
});

test("local policy rejects any hosted workflow entry", () => {
  assert.throws(
    () => validateLocalPolicy(sources({ workflowEntries: ["ci.yml"] })),
    /no hosted workflow definitions/u,
  );
});

test("local policy rejects a missing report gate or GitHub Actions Dependabot target", () => {
  assert.throws(() => validateLocalPolicy(sources({ hook: "#!/bin/sh\nexit 0\n" })), /pre-push/u);
  assert.throws(
    () =>
      validateLocalPolicy(
        sources({
          dependabot: { ...dependabot, updates: [{ "package-ecosystem": "github-actions" }] },
        }),
      ),
    /weekly npm update policy/u,
  );
});
