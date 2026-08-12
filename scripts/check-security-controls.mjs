import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

import { validateSecretScanBaseline } from "./adjudicate-secret-scan.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const workflowsDirectoryPath = path.join(rootDirectory, ".github", "workflows");
export const dependabotPath = path.join(rootDirectory, ".github", "dependabot.yml");
export const secretScanBaselinePath = path.join(
  rootDirectory,
  "config",
  "secret-scan-baseline.v1.json",
);
export const secretScanAdjudicatorPath = path.join(
  rootDirectory,
  "scripts",
  "adjudicate-secret-scan.mjs",
);

const standaloneAdjudicatorHeader = `import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
`;

function equal(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function parseDependabot(source, issues) {
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  for (const error of document.errors)
    issues.push(`Dependabot configuration invalid YAML: ${error.message}`);
  if (document.errors.length > 0) return {};
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    issues.push(`Dependabot configuration is unsafe: ${error.message}`);
    return {};
  }
}

function validateLocalDependabot(dependabot, issues) {
  const update =
    dependabot !== null && typeof dependabot === "object" && !Array.isArray(dependabot)
      ? dependabot.updates?.[0]
      : undefined;
  if (
    dependabot === null ||
    typeof dependabot !== "object" ||
    Array.isArray(dependabot) ||
    dependabot.version !== 2 ||
    !Array.isArray(dependabot.updates) ||
    dependabot.updates.length !== 1 ||
    !equal(update, {
      "package-ecosystem": "npm",
      directory: "/",
      schedule: {
        interval: "weekly",
        day: "monday",
        time: "06:00",
        timezone: "Europe/Warsaw",
      },
      "open-pull-requests-limit": 10,
      groups: {
        "development-tooling": {
          "dependency-type": "development",
          "update-types": ["minor", "patch"],
        },
      },
      "commit-message": { prefix: "deps" },
    })
  ) {
    issues.push("Dependabot must retain only the weekly root-scoped npm update policy");
  }
}

export function validateSecuritySources(sources) {
  const issues = [];
  if (
    typeof sources.secretAdjudicator !== "string" ||
    sources.secretAdjudicator.length > 256 * 1024 ||
    !sources.secretAdjudicator.startsWith(standaloneAdjudicatorHeader) ||
    /(?:\bimport\s*\(|\brequire\s*\(|\bcreateRequire\b|(?:^|[;\n])\s*import\s)/u.test(
      sources.secretAdjudicator.slice(standaloneAdjudicatorHeader.length),
    )
  ) {
    issues.push("secret-scan adjudicator must load only the exact Node built-ins");
  }
  try {
    validateSecretScanBaseline(Buffer.from(sources.secretBaseline ?? "", "utf8"));
  } catch {
    issues.push("secret-scan baseline must satisfy the closed exact adjudication contract");
  }
  const workflowEntries = sources.workflowEntries ?? [];
  if (!Array.isArray(workflowEntries) || workflowEntries.length > 0)
    issues.push("hosted GitHub Actions workflows are disabled; keep .github/workflows empty");
  const dependabot = parseDependabot(sources.dependabot ?? "", issues);
  validateLocalDependabot(dependabot, issues);
  if (issues.length > 0)
    throw new Error(`Local security control violations:\n- ${issues.join("\n- ")}`);
  return Object.freeze({
    hostedWorkflows: 0,
    dependabot: "npm-weekly",
    secretScan: "local-adjudicator",
  });
}

async function workflowEntries() {
  try {
    return (await readdir(workflowsDirectoryPath, { withFileTypes: true })).map(
      (entry) => entry.name,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function validateCommittedSecurityControls() {
  const [entries, dependabot, secretBaseline, secretAdjudicator] = await Promise.all([
    workflowEntries(),
    readFile(dependabotPath, "utf8"),
    readFile(secretScanBaselinePath, "utf8"),
    readFile(secretScanAdjudicatorPath, "utf8"),
  ]);
  return validateSecuritySources({
    dependabot,
    secretAdjudicator,
    secretBaseline,
    workflowEntries: entries,
  });
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await validateCommittedSecurityControls();
  console.log("Validated local dependency, secret-adjudication, and update controls.");
}
