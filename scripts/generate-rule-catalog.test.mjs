import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generated catalog check succeeds without ignored build output", async () => {
  const fixtureRoot = await mkdtemp(path.join(repositoryRoot, ".rule-catalog-clean-checkout-"));
  try {
    await mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "packages", "rules", "src"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "docs", "rules"), { recursive: true });
    await cp(
      path.join(repositoryRoot, "scripts", "generate-rule-catalog.mjs"),
      path.join(fixtureRoot, "scripts", "generate-rule-catalog.mjs"),
    );
    await cp(
      path.join(repositoryRoot, "packages", "rules", "src", "registry.ts"),
      path.join(fixtureRoot, "packages", "rules", "src", "registry.ts"),
    );
    await cp(
      path.join(repositoryRoot, "packages", "rules", "src", "rule-examples.ts"),
      path.join(fixtureRoot, "packages", "rules", "src", "rule-examples.ts"),
    );
    await cp(
      path.join(repositoryRoot, "packages", "rules", "src", "mechanical-fix-safety-data.ts"),
      path.join(fixtureRoot, "packages", "rules", "src", "mechanical-fix-safety-data.ts"),
    );
    await cp(
      path.join(repositoryRoot, "docs", "rules", "catalog.md"),
      path.join(fixtureRoot, "docs", "rules", "catalog.md"),
    );
    await cp(
      path.join(repositoryRoot, "docs", "rules", "mechanical-fix-safety.md"),
      path.join(fixtureRoot, "docs", "rules", "mechanical-fix-safety.md"),
    );
    await mkdir(path.join(fixtureRoot, "tools", "seeded-recall"), { recursive: true });
    await cp(
      path.join(repositoryRoot, "tools", "seeded-recall", "typescript-loader.mjs"),
      path.join(fixtureRoot, "tools", "seeded-recall", "typescript-loader.mjs"),
    );
    const source = await readFile(
      path.join(fixtureRoot, "scripts", "generate-rule-catalog.mjs"),
      "utf8",
    );
    assert.doesNotMatch(source, /packages\/rules\/dist/u);
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        path.join(fixtureRoot, "tools", "seeded-recall", "typescript-loader.mjs"),
        path.join(fixtureRoot, "scripts", "generate-rule-catalog.mjs"),
        "--check",
      ],
      { cwd: fixtureRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(
      output,
      "Generated rule catalog and mechanical-fix matrix are current (69 rules).\n",
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
