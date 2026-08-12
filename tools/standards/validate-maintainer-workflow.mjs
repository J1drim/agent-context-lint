import { access, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const maintainerWorkflowPath = path.join(root, ".githooks", "pre-push");

/**
 * Compatibility-named export retained for recovery tooling. The release snapshot has no hosted
 * maintainer workflow; this validator checks the local pre-push boundary instead.
 */
export function validateMaintainerWorkflow(source) {
  const issues = [];
  if (typeof source !== "string" || !source.startsWith("#!/bin/sh\n"))
    issues.push("local pre-push hook must start with the POSIX shell header");
  if (typeof source === "string" && !source.includes("--verify-push"))
    issues.push("local pre-push hook must verify the local gate report");
  if (typeof source === "string" && /\r|pull_request_target|secrets\.|git push|gh pr/u.test(source))
    issues.push("local pre-push hook contains a hosted workflow or external mutation capability");
  return issues;
}

export async function validateMaintainerWorkflowFiles() {
  const source = await readFile(maintainerWorkflowPath, "utf8");
  const issues = validateMaintainerWorkflow(source);
  const stats = await lstat(maintainerWorkflowPath);
  if (stats.isSymbolicLink() || !stats.isFile())
    issues.push("pre-push hook must be a regular file");
  await access(maintainerWorkflowPath, constants.R_OK);
  if (process.platform !== "win32" && (stats.mode & 0o111) === 0)
    issues.push("pre-push hook must be executable on POSIX hosts");
  return issues;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const issues = await validateMaintainerWorkflowFiles();
  if (issues.length > 0) {
    process.stderr.write(`${issues.map((issue) => `- ${issue}`).join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("Local pre-push controls validated.\n");
}
