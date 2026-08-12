import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectWorkspace, validateDependencyEdge } from "./check-package-boundaries.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the committed workspace satisfies the dependency policy", async () => {
  assert.deepEqual(await inspectWorkspace(rootDirectory), []);
});

test("documented downward package edges are allowed", () => {
  assert.equal(validateDependencyEdge("@agent-context/markdown", "@agent-context/core"), null);
  assert.equal(validateDependencyEdge("@agent-context/resolver", "@agent-context/profiles"), null);
  assert.equal(
    validateDependencyEdge("@agent-context/lint", "@agent-context/formatters", "devDependencies"),
    null,
  );
});

test("upward and cross-layer package edges are rejected", () => {
  assert.match(
    validateDependencyEdge("@agent-context/core", "@agent-context/rules"),
    /edge to @agent-context\/rules is forbidden/,
  );
  assert.match(
    validateDependencyEdge("@agent-context/markdown", "@agent-context/resolver"),
    /edge to @agent-context\/resolver is forbidden/,
  );
});

test("test-kit is development-only and cannot become a runtime edge", () => {
  assert.equal(
    validateDependencyEdge("@agent-context/profiles", "@agent-context/test-kit", "devDependencies"),
    null,
  );
  assert.match(
    validateDependencyEdge("@agent-context/profiles", "@agent-context/test-kit", "dependencies"),
    /edge to @agent-context\/test-kit is forbidden/,
  );
});

test("public artifacts cannot expose private runtime dependencies", () => {
  assert.match(
    validateDependencyEdge("@agent-context/lint", "@agent-context/rules", "dependencies"),
    /public runtime edge to private package @agent-context\/rules is forbidden/,
  );
});
