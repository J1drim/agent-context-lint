import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  maintainerWorkflowPath,
  validateMaintainerWorkflow,
  validateMaintainerWorkflowFiles,
} from "./validate-maintainer-workflow.mjs";

test("the committed pre-push hook satisfies the local-only boundary", async () => {
  assert.deepEqual(await validateMaintainerWorkflowFiles(), []);
  assert.deepEqual(validateMaintainerWorkflow(await readFile(maintainerWorkflowPath, "utf8")), []);
});

test("the local hook rejects hosted workflow and mutation capabilities", () => {
  const issues = validateMaintainerWorkflow(
    "#!/bin/sh\nnode scripts/run-local-gate.mjs --verify-push\ngit push\n",
  );
  assert.match(issues.join("\n"), /external mutation/u);
});

test("the local hook rejects an absent report verifier", () => {
  assert.match(
    validateMaintainerWorkflow("#!/bin/sh\nexit 0\n").join("\n"),
    /verify the local gate report/u,
  );
});
