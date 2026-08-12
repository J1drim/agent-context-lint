import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalApacheSha256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const expectedNotice =
  "Agent Context Linter\nCopyright 2026 Jakub Niezgoda\n\n" +
  "This product includes software developed by Jakub Niezgoda.\n";

async function packageManifestPaths(rootDirectory) {
  const packageNames = (
    await readdir(path.join(rootDirectory, "packages"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const tokenizerNames = (
    await readdir(path.join(rootDirectory, "optional-tokenizers"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return [
    "package.json",
    ...packageNames.map((name) => `packages/${name}/package.json`),
    ...tokenizerNames.map((name) => `optional-tokenizers/${name}/package.json`),
  ].sort();
}

function assertIncludes(text, needle, file) {
  if (!text.includes(needle)) throw new Error(`${file} is missing required policy text: ${needle}`);
}

export async function validateProjectLicense(rootDirectory = defaultRoot) {
  const license = await readFile(path.join(rootDirectory, "LICENSE"));
  const licenseHash = createHash("sha256").update(license).digest("hex");
  if (licenseHash !== canonicalApacheSha256) {
    throw new Error("LICENSE is not the canonical Apache License 2.0 text");
  }
  const notice = await readFile(path.join(rootDirectory, "NOTICE"), "utf8");
  if (notice !== expectedNotice) throw new Error("NOTICE attribution is not canonical");

  const manifestPaths = await packageManifestPaths(rootDirectory);
  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(rootDirectory, manifestPath), "utf8"));
    } catch (error) {
      throw new Error(`${manifestPath} is not valid JSON`, { cause: error });
    }
    const mustDeclare =
      manifestPath === "package.json" ||
      manifest.private !== true ||
      manifestPath === "packages/standards/package.json";
    if (
      (mustDeclare && manifest.license !== "Apache-2.0") ||
      (!mustDeclare && manifest.license !== undefined && manifest.license !== "Apache-2.0")
    ) {
      throw new Error(`${manifestPath} has missing or conflicting Apache-2.0 metadata`);
    }
  }

  for (const manifestPath of [
    "packages/core/package.json",
    "packages/cli/package.json",
    "optional-tokenizers/utf8-byte/package.json",
  ]) {
    const manifest = JSON.parse(await readFile(path.join(rootDirectory, manifestPath), "utf8"));
    if (manifest.private === true || manifest.publishConfig?.access !== "public") {
      throw new Error(`${manifestPath} must explicitly remain a public package`);
    }
    for (const artifact of ["LICENSE", "NOTICE"]) {
      if (!manifest.files?.includes(artifact)) {
        throw new Error(`${manifestPath} must pack ${artifact}`);
      }
    }
  }

  const reuse = await readFile(path.join(rootDirectory, "REUSE.toml"), "utf8");
  for (const required of [
    "version = 1",
    'SPDX-FileCopyrightText = "2026 Jakub Niezgoda"',
    'SPDX-License-Identifier = "Apache-2.0"',
    '"packages/**/*.ts"',
    '"scripts/**/*.mjs"',
  ])
    assertIncludes(reuse, required, "REUSE.toml");

  const thirdParty = await readFile(
    path.join(rootDirectory, "packages/cli/THIRD_PARTY_NOTICES"),
    "utf8",
  );
  if (thirdParty === notice || !thirdParty.includes("License:")) {
    throw new Error("CLI third-party notices were lost or replaced by project NOTICE");
  }

  const policyFiles = ["README.md", "CONTRIBUTING.md", "SUPPORT.md", "SECURITY.md"];
  const policies = new Map(
    await Promise.all(
      policyFiles.map(async (file) => [
        file,
        (await readFile(path.join(rootDirectory, file), "utf8")).replace(/\s+/gu, " "),
      ]),
    ),
  );
  assertIncludes(policies.get("README.md"), "permits commercial use", "README.md");
  assertIncludes(
    policies.get("README.md"),
    "not a condition of exercising the Apache-2.0 license",
    "README.md",
  );
  for (const file of ["README.md", "SUPPORT.md", "SECURITY.md"])
    assertIncludes(policies.get(file), "jakub.niezgoda@areaautomation.com", file);
  assertIncludes(policies.get("CONTRIBUTING.md"), "Apache License 2.0", "CONTRIBUTING.md");

  return { licenseSha256: licenseHash, manifests: manifestPaths.length };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await validateProjectLicense();
  console.log(
    `Project licensing is valid (${result.manifests} manifests; LICENSE sha256 ${result.licenseSha256}).`,
  );
}
