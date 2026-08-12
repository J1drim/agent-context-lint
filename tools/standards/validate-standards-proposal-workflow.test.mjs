import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  standardsProposalWorkflowPath,
  validateCommittedStandardsProposalWorkflow,
  validateStandardsProposalWorkflowSource,
} from "./validate-standards-proposal-workflow.mjs";

test("the committed standards proposal tool satisfies the local-only contract", async () => {
  assert.deepEqual(await validateCommittedStandardsProposalWorkflow(), {
    hostedWorkflow: false,
    publication: "human-review",
  });
});

test("the proposal tool rejects hosted run references and publication commands", async () => {
  const source = await readFile(standardsProposalWorkflowPath, "utf8");
  const issues = validateStandardsProposalWorkflowSource(
    `${source}\nhttps://github.com/x/actions/runs/1\n`,
  );
  assert.match(issues.join("\n"), /hosted runs/u);
});

test("the proposal tool rejects missing draft status", async () => {
  const source = await readFile(standardsProposalWorkflowPath, "utf8");
  assert.match(
    validateStandardsProposalWorkflowSource(
      source.replace('status: "draft-human-review-required"', ""),
    ).join("\n"),
    /draft human-review/u,
  );
});
