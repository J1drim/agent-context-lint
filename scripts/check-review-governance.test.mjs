import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("the release snapshot excludes planning and implementation-status artifacts", async () => {
  await assert.rejects(source("agent-context-linter-implementation-plan.md"), { code: "ENOENT" });
  await assert.rejects(source("IMPLEMENTATION_STATUS.md"), { code: "ENOENT" });
});

test("current review procedures require one maintainer and an agent audit, not multiple humans", async () => {
  const paths = [
    "docs/api/seeded-recall-contracts.md",
    "docs/security/seeded-recall-review.md",
    "docs/user/reviewing-seeded-recall.md",
    "docs/profiles/official-example-conformance.md",
  ];
  const documents = await Promise.all(paths.map(source));
  for (const document of documents) {
    assert.match(document, /sole-maintainer policy|sole human reviewer|accountable maintainer/u);
    assert.match(document, /audit agent|agent audit/u);
    assert.doesNotMatch(document, /Two distinct primary reviewers are required/u);
    assert.doesNotMatch(document, /Two primary reviewers and any tie-breaker must/u);
    assert.doesNotMatch(document, /local maintainer plus an independent QA reviewer must/u);
  }
});

test("ownership policy scopes multi-maintainer rules to its inactive future profile", async () => {
  const ownership = await source("docs/governance/ownership.md");
  const current = ownership.split("## Future multi-maintainer alias directory (inactive)", 1)[0];
  assert.match(current, /Current operating mode: sole maintainer/u);
  assert.match(current, /No second human reviewer/u);
  assert.doesNotMatch(
    current,
    /at least two approvals|two people authorize|author MUST NOT approve/u,
  );
  assert.match(ownership, /Future multi-maintainer review matrix \(inactive\)/u);
});
