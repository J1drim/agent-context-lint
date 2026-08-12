import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runReleaseDryRun } from "./release-dry-run.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicPackages = new Set(["@agent-context/core", "@agent-context/lint"]);
const summaryPattern = /^(Added|Changed|Deprecated|Removed|Fixed|Security): \S/u;

export async function validateReleasePolicy(rootDirectory = defaultRoot) {
  const configPath = path.join(rootDirectory, ".changeset/config.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(".changeset/config.json is not valid JSON", { cause: error });
  }
  const expected = {
    changelog: "./changelog.cjs",
    commit: false,
    access: "public",
    baseBranch: "main",
    updateInternalDependencies: "patch",
    bumpVersionsWithWorkspaceProtocolOnly: true,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (config[key] !== value) throw new Error(`Changesets config has unsafe ${key}`);
  }
  if (config.privatePackages?.version !== false || config.privatePackages?.tag !== false) {
    throw new Error("private packages must not be versioned or tagged");
  }

  const entries = (await readdir(path.join(rootDirectory, ".changeset")))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
  const changesets = [];
  for (const name of entries) {
    const text = await readFile(path.join(rootDirectory, ".changeset", name), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n+([\s\S]*\S)\n?$/u.exec(text);
    if (match === null) throw new Error(`${name} has malformed Changeset frontmatter`);
    const releases = [...match[1].matchAll(/^"([^"]+)": (patch|minor|major)$/gmu)].map(
      ([, packageName, type]) => ({ packageName, type }),
    );
    const nonemptyLines = match[1].split("\n").filter((line) => line.trim() !== "");
    if (releases.length === 0 || releases.length !== nonemptyLines.length) {
      throw new Error(`${name} contains an invalid or empty release set`);
    }
    for (const { packageName } of releases) {
      if (!publicPackages.has(packageName)) {
        throw new Error(`${name} attempts to release private or unknown package ${packageName}`);
      }
    }
    const summary = match[2].trim().replace(/\s+/gu, " ");
    if (!summaryPattern.test(summary)) throw new Error(`${name} has a non-conventional summary`);
    changesets.push({ name, releases, summary });
  }
  return { changesets, config };
}

export async function checkReleasePolicy(rootDirectory = defaultRoot) {
  const policy = await validateReleasePolicy(rootDirectory);
  const dryRun = await runReleaseDryRun(rootDirectory);
  return { ...policy, dryRun };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await checkReleasePolicy();
  console.log(
    result.changesets.length === 0
      ? "Release policy is valid; no package release is pending."
      : `Release policy and deterministic dry run are valid (${result.dryRun.releases.length} releases).`,
  );
}
