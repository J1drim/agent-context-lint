import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DOCUMENTATION_COVERAGE_VERSION,
  REQUIRED_DOCUMENTATION_FILES,
  checkDocumentationCoverage,
} from "./check-documentation-coverage.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-doc-coverage-"));
  for (const relativePath of REQUIRED_DOCUMENTATION_FILES) {
    const source = path.join(repositoryRoot, relativePath);
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  return root;
}

test("documentation coverage verifies every required K08 topic and index link", async () => {
  const result = await checkDocumentationCoverage(repositoryRoot);
  assert.equal(result.schemaVersion, DOCUMENTATION_COVERAGE_VERSION);
  assert.equal(result.topicCount, 9);
  assert.equal(result.documentCount, REQUIRED_DOCUMENTATION_FILES.length);
  assert.equal(result.discoverabilityLinkCount, 23);
  assert.equal(result.topics.length, result.topicCount);
  assert.equal((await lstat(path.join(repositoryRoot, "docs/user/README.md"))).isFile(), true);
});

test("documentation coverage fails closed when a required guide is missing", async () => {
  const root = await fixtureRoot();
  await rm(path.join(root, "docs/user/migration.md"));
  await assert.rejects(
    checkDocumentationCoverage(root),
    /documentation coverage missing file: docs\/user\/migration\.md/u,
  );
  await rm(root, { recursive: true, force: true });
});

test("documentation coverage requires the index to expose every guide", async () => {
  const root = await fixtureRoot();
  const indexPath = path.join(root, "docs/user/README.md");
  const index = await readFile(indexPath, "utf8");
  await writeFile(indexPath, index.replace("(migration.md)", "(missing-migration.md)"), "utf8");
  await assert.rejects(checkDocumentationCoverage(root), /missing discoverability link/u);
  await rm(root, { recursive: true, force: true });
});

test("documentation coverage rejects a symlinked required guide", async () => {
  const root = await fixtureRoot();
  const guidePath = path.join(root, "docs/user/migration.md");
  await rm(guidePath);
  await symlink(path.join(repositoryRoot, "docs/user/migration.md"), guidePath);
  await assert.rejects(
    checkDocumentationCoverage(root),
    /documentation coverage requires an ordinary file: docs\/user\/migration\.md/u,
  );
  await rm(root, { recursive: true, force: true });
});
