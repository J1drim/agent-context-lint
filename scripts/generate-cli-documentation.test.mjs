import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GENERATED_CLI_DOCUMENTATION_PATHS,
  buildCliDocumentationReference,
  findStaleCliDocumentationArtifacts,
  renderCliDocumentationArtifacts,
} from "./generate-cli-documentation.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("I14 generation is deterministic and binds every authoritative registry", async () => {
  const first = await renderCliDocumentationArtifacts();
  const second = await renderCliDocumentationArtifacts();
  assert.deepEqual([...first], [...second]);
  assert.deepEqual([...first.keys()], GENERATED_CLI_DOCUMENTATION_PATHS);

  const reference = await buildCliDocumentationReference();
  assert.equal(reference.commands.length, 7);
  assert.equal(reference.configuration.fileName, ".agent-context-lint.yml");
  assert.match(reference.configuration.schemaSha256, /^[a-f0-9]{64}$/u);
  assert.equal(reference.rules.entries.length, 69);
  assert.deepEqual(
    reference.commands.map(({ name }) => name),
    [...reference.commands.map(({ name }) => name)].sort(),
  );
});

test("I14 check mode reports missing and byte-stale artifacts without writing", async () => {
  const artifacts = await renderCliDocumentationArtifacts();
  let calls = 0;
  const current = await findStaleCliDocumentationArtifacts(artifacts, async (relativePath) => {
    calls += 1;
    return readFile(path.join(rootDirectory, relativePath), "utf8");
  });
  assert.deepEqual(current, []);
  assert.equal(calls, artifacts.size);

  const stale = await findStaleCliDocumentationArtifacts(artifacts, async (relativePath) =>
    relativePath === GENERATED_CLI_DOCUMENTATION_PATHS[0] ? "stale\n" : artifacts.get(relativePath),
  );
  assert.deepEqual(stale, [GENERATED_CLI_DOCUMENTATION_PATHS[0]]);
});

test("every documentation generator is check-only by default", async () => {
  const observedPaths = [
    "docs/api/configuration.md",
    "docs/rules/catalog.md",
    ...GENERATED_CLI_DOCUMENTATION_PATHS,
  ];
  const before = await Promise.all(
    observedPaths.map((relativePath) => readFile(path.join(rootDirectory, relativePath), "utf8")),
  );
  for (const script of [
    "scripts/generate-configuration-reference.mjs",
    "scripts/generate-rule-catalog.mjs",
    "scripts/generate-cli-documentation.mjs",
  ]) {
    const arguments_ =
      script === "scripts/generate-rule-catalog.mjs" ||
      script === "scripts/generate-cli-documentation.mjs"
        ? [
            "--experimental-strip-types",
            "--import",
            path.join(rootDirectory, "tools/seeded-recall/typescript-loader.mjs"),
            path.join(rootDirectory, script),
          ]
        : [path.join(rootDirectory, script)];
    const result = spawnSync(process.execPath, arguments_, {
      cwd: rootDirectory,
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const after = await Promise.all(
    observedPaths.map((relativePath) => readFile(path.join(rootDirectory, relativePath), "utf8")),
  );
  assert.deepEqual(after, before);
});
