import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { actionMetadataPath, validateActionMetadataSource } from "./check-action-metadata.mjs";

const metadata = await readFile(actionMetadataPath, "utf8");

test("reusable action metadata satisfies the closed local contract", () => {
  assert.equal(validateActionMetadataSource(metadata).name, "Agent Context Linter");
});

test("metadata rejects runtime, identity, and input drift", () => {
  for (const source of [
    metadata.replace("using: node24", "using: node20"),
    metadata.replace("description: Run", "description: Changed"),
    metadata.replace("default: warning", "default: never"),
    `${metadata}\nextra: true\n`,
  ])
    assert.throws(() => validateActionMetadataSource(source), /violations/u);
});

test("metadata rejects duplicate YAML keys", () => {
  assert.throws(
    () => validateActionMetadataSource(`${metadata}\nname: duplicate\n`),
    /invalid YAML/u,
  );
});
