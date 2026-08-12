import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runReleaseDryRun } from "./release-dry-run.mjs";
import { validateReleasePolicy } from "./check-release-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("release policy accepts the stable 1.0.0 snapshot with no pending Changesets", async () => {
  const policy = await validateReleasePolicy(root);
  assert.equal(policy.changesets.length, 0);
});

test("release policy rejects malformed summaries and private-package releases", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-release-policy-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  await cp(path.join(root, ".changeset"), path.join(fixture, ".changeset"), { recursive: true });
  const changesetPath = path.join(fixture, ".changeset/fixture.md");
  const original = [
    "---",
    '"@agent-context/core": patch',
    '"@agent-context/lint": patch',
    "---",
    "",
    "Added: fixture release note.",
    "",
  ].join("\n");
  await writeFile(changesetPath, original);
  await writeFile(changesetPath, original.replace("Added:", "Improved:"));
  await assert.rejects(validateReleasePolicy(fixture), /non-conventional summary/u);
  await writeFile(
    changesetPath,
    original.replace('"@agent-context/core": patch', '"@agent-context/rules": patch'),
  );
  await assert.rejects(validateReleasePolicy(fixture), /attempts to release private/u);
});

test("the stable 1.0.0 dry run is deterministic without modifying source", async () => {
  const result = await runReleaseDryRun(root);
  assert.deepEqual(result.releases, []);
});
