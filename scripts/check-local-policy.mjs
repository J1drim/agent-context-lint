import { access, lstat, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const workflowsDirectoryPath = path.join(rootDirectory, ".github", "workflows");
export const hookPath = path.join(rootDirectory, ".githooks", "pre-push");
export const packageJsonPath = path.join(rootDirectory, "package.json");
export const dependabotPath = path.join(rootDirectory, ".github", "dependabot.yml");

function equal(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function validateLocalPolicy({ workflowEntries, hook, packageJson, dependabot }) {
  const issues = [];
  if (!Array.isArray(workflowEntries) || workflowEntries.length !== 0)
    issues.push(".github/workflows must contain no hosted workflow definitions");
  if (
    typeof hook !== "string" ||
    !hook.startsWith("#!/bin/sh\n") ||
    !hook.includes("--verify-push")
  )
    issues.push(".githooks/pre-push must delegate to the local report verifier");
  if (typeof hook === "string" && /\r/u.test(hook)) issues.push("pre-push hook must use LF bytes");
  if (
    packageJson?.scripts?.["verify:local"] !== "node scripts/run-local-gate.mjs" ||
    packageJson?.scripts?.["hooks:install"] !== "node scripts/install-git-hooks.mjs"
  )
    issues.push("package scripts must expose the documented local gate and hook installer");
  if (
    dependabot?.version !== 2 ||
    !Array.isArray(dependabot.updates) ||
    dependabot.updates.length !== 1 ||
    !equal(dependabot.updates[0], {
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
  )
    issues.push("Dependabot must retain only the weekly npm update policy");
  if (issues.length > 0)
    throw new Error(`Local repository policy violations:\n- ${issues.join("\n- ")}`);
  return Object.freeze({
    hostedWorkflows: 0,
    hook: "pre-push",
    report: ".git/local-gate-result.json",
  });
}

async function readWorkflowEntries() {
  try {
    const entries = await readdir(workflowsDirectoryPath, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function validateCommittedLocalPolicy() {
  const [workflowEntries, hook, packageSource, dependabotSource] = await Promise.all([
    readWorkflowEntries(),
    readFile(hookPath, "utf8"),
    readFile(packageJsonPath, "utf8"),
    readFile(dependabotPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);
  const { parseDocument } = await import("yaml");
  const document = parseDocument(dependabotSource, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error("Dependabot configuration contains invalid YAML");
  const dependabot = document.toJS({ maxAliasCount: 0 });
  const result = validateLocalPolicy({ workflowEntries, hook, packageJson, dependabot });
  const stats = await lstat(hookPath);
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new Error("pre-push hook is not a regular file");
  await access(hookPath, constants.R_OK);
  if (process.platform !== "win32" && (stats.mode & 0o111) === 0)
    throw new Error("pre-push hook must be executable on POSIX hosts");
  return result;
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  await validateCommittedLocalPolicy();
  console.log(
    "Validated local-only repository policy, pre-push gate, and Dependabot configuration.",
  );
}
