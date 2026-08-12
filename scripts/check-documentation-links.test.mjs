import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { checkDocumentationLinks } from "./check-documentation-links.mjs";

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), "agent-context-doc-links-"));
}

test("accepts local files, same-file anchors, duplicate headings, and external URLs", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "docs"));
  await writeFile(
    path.join(root, "README.md"),
    "# Start here\n\n[guide](docs/guide.md#api) [second](docs/guide.md#api-1) [remote](https://example.test/missing)\n\n```md\n[ignored](missing.md)\n```\n",
  );
  await writeFile(path.join(root, "docs", "guide.md"), "# API\n\n## API\n");
  await assert.doesNotReject(checkDocumentationLinks(root));
});

test("ignores generated npm publish trees while checking source documentation", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "publish"));
  await writeFile(path.join(root, "README.md"), "# Source\n");
  await writeFile(path.join(root, "publish", "README.md"), "[generated](missing.md)\n");
  await assert.doesNotReject(checkDocumentationLinks(root));
});

test("rejects missing files and anchors with source locations", async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, "README.md"),
    "# Home\n\n[missing](docs/nope.md)\n[bad anchor](README.md#nope)\n",
  );
  await assert.rejects(
    checkDocumentationLinks(root),
    /README\.md:3: missing local documentation target docs\/nope\.md[\s\S]*README\.md:4: missing heading anchor README\.md#nope/u,
  );
});

test("reports malformed percent-encoded anchors instead of throwing", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "README.md"), "# Home\n\n[bad anchor](README.md#bad%ZZ)\n");
  await assert.rejects(checkDocumentationLinks(root), /missing heading anchor README\.md#bad%ZZ/u);
});

test("rejects symbolic links in the documentation tree before reading them", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "README.md"), "# Home\n");
  await writeFile(path.join(root, "outside.md"), "# Outside\n");
  await symlink(path.join(root, "outside.md"), path.join(root, "linked.md"));
  await assert.rejects(checkDocumentationLinks(root), /symbolic link/u);
});
