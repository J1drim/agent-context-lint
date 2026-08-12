import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

import { renderRuleCatalogMarkdown } from "../packages/rules/src/registry.ts";
import { renderMechanicalFixSafetyDataMarkdown } from "../packages/rules/src/mechanical-fix-safety-data.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "docs", "rules", "catalog.md");
const safetyDestination = path.join(root, "docs", "rules", "mechanical-fix-safety.md");
const prettierConfig = (await prettier.resolveConfig(destination)) ?? {};
const expected = await prettier.format(renderRuleCatalogMarkdown(), {
  ...prettierConfig,
  filepath: destination,
});
const safetyExpected = await prettier.format(renderMechanicalFixSafetyDataMarkdown(), {
  ...prettierConfig,
  filepath: safetyDestination,
});
const argument = process.argv[2];
const write = argument === "--write";

if (
  process.argv.length > 3 ||
  (argument !== undefined && argument !== "--check" && argument !== "--write")
) {
  throw new TypeError("usage: node scripts/generate-rule-catalog.mjs [--check|--write]");
}

if (!write) {
  let actual;
  let safetyActual;
  try {
    actual = await readFile(destination, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new TypeError("generated rule catalog is missing; run pnpm rules:docs", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    safetyActual = await readFile(safetyDestination, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new TypeError(
        "generated mechanical-fix safety matrix is missing; run pnpm rules:docs",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  if (actual !== expected)
    throw new TypeError("generated rule catalog is stale; run pnpm rules:docs");
  if (safetyActual !== safetyExpected)
    throw new TypeError("generated mechanical-fix safety matrix is stale; run pnpm rules:docs");
  process.stdout.write(
    "Generated rule catalog and mechanical-fix matrix are current (69 rules).\n",
  );
} else {
  await writeFile(destination, expected, { encoding: "utf8", flag: "w" });
  await writeFile(safetyDestination, safetyExpected, { encoding: "utf8", flag: "w" });
  process.stdout.write("Generated rule catalog and mechanical-fix matrix (69 rules).\n");
}
