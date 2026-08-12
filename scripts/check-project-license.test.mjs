import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateProjectLicense } from "./check-project-license.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureFiles = [
  "LICENSE",
  "NOTICE",
  "REUSE.toml",
  "README.md",
  "CONTRIBUTING.md",
  "SUPPORT.md",
  "SECURITY.md",
  "package.json",
  "packages/cli/THIRD_PARTY_NOTICES",
];

async function createFixture(t) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-license-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const manifests = [
    "package.json",
    ...(await readdirNames("packages")).map((name) => `packages/${name}/package.json`),
    ...(await readdirNames("optional-tokenizers")).map(
      (name) => `optional-tokenizers/${name}/package.json`,
    ),
  ];
  for (const relative of new Set([...fixtureFiles, ...manifests])) {
    await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true });
    await cp(path.join(root, relative), path.join(fixture, relative));
  }
  return fixture;
}

async function readdirNames(relative) {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(path.join(root, relative), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

test("the repository has canonical, complete Apache-2.0 licensing", async () => {
  const result = await validateProjectLicense(root);
  assert.equal(result.manifests, 14);
  assert.equal(result.licenseSha256.length, 64);
});

test("license validation rejects malformed manifest metadata", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture, "packages/core/package.json"), "{not-json\n");
  await assert.rejects(
    validateProjectLicense(fixture),
    /packages\/core\/package.json is not valid JSON/u,
  );
});

test("license validation rejects a modified license or missing commercial-use clarity", async (t) => {
  const fixture = await createFixture(t);
  const license = await readFile(path.join(fixture, "LICENSE"), "utf8");
  await writeFile(path.join(fixture, "LICENSE"), `${license}modified\n`);
  await assert.rejects(validateProjectLicense(fixture), /not the canonical Apache License/u);

  await cp(path.join(root, "LICENSE"), path.join(fixture, "LICENSE"));
  const readme = await readFile(path.join(fixture, "README.md"), "utf8");
  await writeFile(
    path.join(fixture, "README.md"),
    readme.replace("commercial use", "business use"),
  );
  await assert.rejects(
    validateProjectLicense(fixture),
    /README.md is missing required policy text/u,
  );
});
