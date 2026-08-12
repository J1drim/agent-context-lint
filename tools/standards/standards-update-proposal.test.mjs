import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareStandardsUpdateProposal,
  StandardsUpdateProposalError,
} from "./standards-update-proposal.mjs";

const BASE = {
  recordKind: "agent-context-upstream-review",
  status: "draft-human-review-required",
  semanticAssessment: "not-performed",
  publicationAuthorized: false,
  candidate: { sourceArtifactSha256: "a".repeat(64) },
  summary: { changedSectionCount: 1, rawOnlyChangedSourceCount: 0 },
};
const SCAFFOLD = {
  artifactKind: "upstream-fixture-update-scaffold",
  status: "draft-unreviewed",
  publicationAuthorized: false,
};
const COMMON = {};

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "agent-context-standards-proposal-"));
}

function bytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

test("changed evidence stages only bounded review files and a manifest", async () => {
  const root = await temporaryDirectory();
  try {
    const output = path.join(root, "docs/standards/updates/current");
    const result = await prepareStandardsUpdateProposal({
      ...COMMON,
      reviewBytes: bytes(BASE),
      scaffoldBytes: bytes(SCAFFOLD),
      markdownBytes: Buffer.from("# review\n", "utf8"),
      outputDirectory: output,
    });
    assert.equal(result.changed, true);
    assert.equal(result.outputDirectory, path.resolve(output));
    for (const file of [
      "upstream-review.v1.json",
      "upstream-fixture-scaffold.v1.json",
      "upstream-review.v1.md",
      "proposal-manifest.v1.json",
      "pull-request-body.md",
    ]) {
      const content = await readFile(path.join(output, file), "utf8");
      assert.ok(content.length > 0, file);
    }
    const body = await readFile(path.join(output, "pull-request-body.md"), "utf8");
    assert.match(body, /Semantic interpretation was not performed/u);
    assert.match(body, /Proposal manifest/u);
    const manifest = JSON.parse(
      await readFile(path.join(output, "proposal-manifest.v1.json"), "utf8"),
    );
    assert.equal(manifest.publicationAuthorized, false);
    assert.equal(manifest.semanticAssessment, "not-performed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged evidence does not create proposal files", async () => {
  const root = await temporaryDirectory();
  try {
    const output = path.join(root, "docs/standards/updates/current");
    const result = await prepareStandardsUpdateProposal({
      ...COMMON,
      reviewBytes: bytes({
        ...BASE,
        summary: { changedSectionCount: 0, rawOnlyChangedSourceCount: 0 },
      }),
      scaffoldBytes: bytes(SCAFFOLD),
      markdownBytes: Buffer.from("# unchanged\n", "utf8"),
      outputDirectory: output,
    });
    assert.deepEqual(result, { changed: false, outputDirectory: null });
    await assert.rejects(readFile(path.join(output, "proposal-manifest.v1.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal refuses an attempted automatic publication", async () => {
  await assert.rejects(
    prepareStandardsUpdateProposal({
      ...COMMON,
      reviewBytes: bytes({ ...BASE, publicationAuthorized: true }),
      scaffoldBytes: bytes(SCAFFOLD),
      markdownBytes: Buffer.from("# review\n", "utf8"),
      outputDirectory: "proposal-output",
    }),
    (error) => error instanceof StandardsUpdateProposalError && error.code === "invalid-input",
  );
});
