import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertOrdinaryActionFile,
  assertSameActionBuilds,
  auditActionBundleContents,
  buildGithubAction,
  compareActionAssetCopy,
  typescriptBuildInvocation,
} from "./build-github-action.mjs";

test("the committed GitHub Action bundle and immutable assets are reproducible", async () => {
  await assert.doesNotReject(buildGithubAction("check"));
});

test("the GitHub Action builder rejects unknown modes", async () => {
  await assert.rejects(buildGithubAction("unknown"), /mode must be check or write/u);
});

test("the TypeScript build uses the already-provisioned exact Node process", () => {
  const executable = path.resolve("/reviewed/node");
  const invocation = typescriptBuildInvocation(executable);
  assert.equal(invocation.executable, executable);
  assert.deepEqual(invocation.arguments.slice(-3), ["-b", "--pretty", "false"]);
  assert.match(
    invocation.arguments[0],
    /node_modules[/\\]@typescript[/\\]native[/\\]bin[/\\]tsc$/u,
  );
  assert.throws(
    () => typescriptBuildInvocation("node_modules/node/bin/node"),
    /absolute current Node executable/u,
  );
  assert.ok(!JSON.stringify(invocation).includes("node_modules/node/bin/node"));
});

test("the action bundle content audit rejects test seams and missing production execution", () => {
  const valid = "createNodeGitMetadataExecutor Git metadata output limit is invalid";
  assert.doesNotThrow(() => auditActionBundleContents(valid));
  for (const forbidden of ["bindMetadataFileWithinForTest", "reference binding test"])
    assert.throws(() => auditActionBundleContents(`${valid} ${forbidden}`), /internal test seam/u);
  for (const required of ["createNodeGitMetadataExecutor", "Git metadata output limit is invalid"])
    assert.throws(
      () => auditActionBundleContents(valid.replace(required, "removed")),
      /omits the production Git executor/u,
    );
});

test("double-build comparison covers bundle, notices, and canonical metafile bytes", () => {
  const valid = {
    artifact: Buffer.from("bundle"),
    metafile: '{"inputs":{}}\n',
    notices: "notices\n",
  };
  assert.doesNotThrow(() => assertSameActionBuilds(valid, structuredClone(valid)));
  for (const key of ["artifact", "metafile", "notices"])
    assert.throws(
      () => assertSameActionBuilds(valid, { ...valid, [key]: `${String(valid[key])}drift` }),
      new RegExp(`non-deterministic GitHub Action build artifact: ${key}`, "u"),
    );
});

test("committed files and copied asset roots reject symlinks in isolated directories", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-context-i09-action-assets-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const sourceFile = path.join(root, "source.txt");
  const ordinaryFile = path.join(root, "ordinary.txt");
  const linkedFile = path.join(root, "linked.txt");
  await Promise.all([writeFile(sourceFile, "asset"), writeFile(ordinaryFile, "asset")]);
  await symlink(sourceFile, linkedFile, "file");
  await assert.doesNotReject(assertOrdinaryActionFile(ordinaryFile, "fixture"));
  await assert.rejects(
    assertOrdinaryActionFile(linkedFile, "fixture"),
    /ordinary non-symbolic file/u,
  );
  await assert.rejects(
    compareActionAssetCopy(sourceFile, linkedFile),
    /ordinary non-symbolic file/u,
  );

  const sourceTree = path.join(root, "source-tree");
  await mkdir(sourceTree);
  await writeFile(path.join(sourceTree, "asset.json"), "{}\n");
  for (const name of ["bundled", "git-runtime"]) {
    const linkedRoot = path.join(root, name);
    await symlink(sourceTree, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      compareActionAssetCopy(sourceTree, linkedRoot),
      /asset destination is not a real directory/u,
    );
  }
});
