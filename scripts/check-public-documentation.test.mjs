import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_GUIDES = Object.freeze([
  "README.md",
  "docs/user/getting-started.md",
  "docs/user/commands.md",
  "docs/user/scanning.md",
]);

const IMPLICIT_NPX_PATTERN = /\bnpx\s+agent-context-lint\b/u;
const SAFE_NPX_PATTERN = /\bnpx\s+--no-install\s+agent-context-lint\b/u;

test("public guides require npx --no-install for local CLI execution", async () => {
  for (const relativePath of PUBLIC_GUIDES) {
    const source = await readFile(path.join(rootDirectory, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      IMPLICIT_NPX_PATTERN,
      `${relativePath} permits an implicit npx download`,
    );
    assert.match(source, SAFE_NPX_PATTERN, `${relativePath} has no safe npx invocation`);
  }
});

test("the public-guide guard catches a hostile implicit-download example", () => {
  const hostile = "Run `npx agent-context-lint scan` when the local binary is unavailable.";
  assert.match(hostile, IMPLICIT_NPX_PATTERN);
  assert.doesNotMatch(hostile, SAFE_NPX_PATTERN);
});
