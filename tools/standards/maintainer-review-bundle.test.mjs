import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  MAINTAINER_BUNDLE_FILE,
  MaintainerBundleError,
  createMaintainerReviewBundle,
  runMaintainerBundleCli,
  verifyMaintainerReviewBundle,
} from "./maintainer-review-bundle.mjs";

const context = {
  runAttempt: "2",
  runId: "123456789",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
};
const files = [
  "baseline/upstream-provenance.v1.json",
  "baseline/upstream-source.v1.json",
  "candidate/upstream-provenance.v1.json",
  "candidate/upstream-source.v1.json",
  "review/upstream-fixture-scaffold.v1.json",
  "review/upstream-review.v1.json",
  "review/upstream-review.v1.md",
];

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "svetovid-h12-"));
  const root = path.join(temporary, "bundle");
  await Promise.all([
    mkdir(path.join(root, "baseline"), { recursive: true }),
    mkdir(path.join(root, "candidate"), { recursive: true }),
    mkdir(path.join(root, "review"), { recursive: true }),
  ]);
  await Promise.all(
    files.map((relative, index) =>
      writeFile(path.join(root, relative), `fixture-${index}\n`, { mode: 0o600 }),
    ),
  );
  return { root: await realpath(root), temporary };
}

async function expectCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => error instanceof MaintainerBundleError && error.code === code,
  );
}

test("creates a canonical closed manifest and replays exact bytes", async (t) => {
  const selected = await fixture();
  t.after(() => rm(selected.temporary, { force: true, recursive: true }));
  const created = await createMaintainerReviewBundle(selected.root, context);
  assert.match(created.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(
    created.manifest.files.map((entry) => entry.path),
    files,
  );
  const manifestBytes = await readFile(path.join(selected.root, MAINTAINER_BUNDLE_FILE));
  assert.equal(manifestBytes.at(-1), 0x0a);
  const schema = JSON.parse(
    await readFile(new URL("./schemas/maintainer-review-bundle.v1.schema.json", import.meta.url)),
  );
  assert.equal(new Ajv2020({ strict: true }).compile(schema)(created.manifest), true);
  assert.equal(
    (await verifyMaintainerReviewBundle(selected.root, context, created.manifestSha256)).files,
    7,
  );
  await expectCode(() => createMaintainerReviewBundle(selected.root, context), "invalid-bundle");
});

test("fails closed on content, manifest, context, and inventory substitution", async (t) => {
  for (const mutation of ["content", "manifest", "context", "extra"]) {
    await t.test(mutation, async (nested) => {
      const selected = await fixture();
      nested.after(() => rm(selected.temporary, { force: true, recursive: true }));
      const created = await createMaintainerReviewBundle(selected.root, context);
      if (mutation === "content") await writeFile(path.join(selected.root, files[0]), "tampered\n");
      if (mutation === "manifest") {
        const selectedManifest = path.join(selected.root, MAINTAINER_BUNDLE_FILE);
        const value = JSON.parse(await readFile(selectedManifest, "utf8"));
        value.unexpected = true;
        await writeFile(selectedManifest, `${JSON.stringify(value)}\n`);
      }
      if (mutation === "extra") await writeFile(path.join(selected.root, "review/extra"), "x");
      const selectedContext = mutation === "context" ? { ...context, runId: "987" } : context;
      await assert.rejects(
        () => verifyMaintainerReviewBundle(selected.root, selectedContext, created.manifestSha256),
        MaintainerBundleError,
      );
    });
  }
});

test("rejects aliases, hard links, invalid metadata, and noncanonical JSON", async (t) => {
  await t.test("aliased root", async (nested) => {
    const selected = await fixture();
    nested.after(() => rm(selected.temporary, { force: true, recursive: true }));
    const alias = path.join(selected.temporary, "alias");
    await symlink(selected.root, alias);
    await expectCode(() => createMaintainerReviewBundle(alias, context), "unsafe-path");
  });
  await t.test("symbolic link", async (nested) => {
    const selected = await fixture();
    nested.after(() => rm(selected.temporary, { force: true, recursive: true }));
    await rm(path.join(selected.root, files[0]));
    await symlink(path.join(selected.root, files[1]), path.join(selected.root, files[0]));
    await expectCode(() => createMaintainerReviewBundle(selected.root, context), "unsafe-path");
  });
  await t.test("hard link", async (nested) => {
    const selected = await fixture();
    nested.after(() => rm(selected.temporary, { force: true, recursive: true }));
    await rm(path.join(selected.root, files[0]));
    await link(path.join(selected.root, files[1]), path.join(selected.root, files[0]));
    await expectCode(() => createMaintainerReviewBundle(selected.root, context), "unsafe-path");
  });
  await t.test("invalid run metadata", async (nested) => {
    const selected = await fixture();
    nested.after(() => rm(selected.temporary, { force: true, recursive: true }));
    await expectCode(
      () => createMaintainerReviewBundle(selected.root, { ...context, runAttempt: "0" }),
      "invalid-context",
    );
  });
  await t.test("noncanonical manifest", async (nested) => {
    const selected = await fixture();
    nested.after(() => rm(selected.temporary, { force: true, recursive: true }));
    const created = await createMaintainerReviewBundle(selected.root, context);
    const manifest = path.join(selected.root, MAINTAINER_BUNDLE_FILE);
    await writeFile(manifest, ` ${await readFile(manifest, "utf8")}`);
    await assert.rejects(
      () => verifyMaintainerReviewBundle(selected.root, context, created.manifestSha256),
      MaintainerBundleError,
    );
  });
});

test("CLI accepts only the fixed create and verify argument order", async (t) => {
  const selected = await fixture();
  t.after(() => rm(selected.temporary, { force: true, recursive: true }));
  const output = await runMaintainerBundleCli([
    "create",
    "--root",
    selected.root,
    "--source-commit",
    context.sourceCommit,
    "--run-id",
    context.runId,
    "--run-attempt",
    context.runAttempt,
  ]);
  const digest = output.trim();
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.match(
    await runMaintainerBundleCli([
      "verify",
      "--root",
      selected.root,
      "--source-commit",
      context.sourceCommit,
      "--run-id",
      context.runId,
      "--run-attempt",
      context.runAttempt,
      "--manifest-sha256",
      digest,
    ]),
    /^Verified 7 fixed files/u,
  );
  await expectCode(() => runMaintainerBundleCli(["create", "--root", selected.root]), "usage");
});
