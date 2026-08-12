import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooksDirectory = path.join(rootDirectory, ".githooks");

function runGit(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", arguments_, {
      cwd: rootDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `git exited with ${code}`)),
    );
  });
}

async function ensureHook() {
  const hook = path.join(hooksDirectory, "pre-push");
  const stats = await lstat(hook);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(".githooks/pre-push is unsafe");
  await access(hook, constants.R_OK);
}

const uninstall = process.argv.includes("--uninstall");
if (uninstall) {
  await runGit(["config", "--unset", "core.hooksPath"]).catch(() => undefined);
  process.stdout.write("Local Git hooks disabled for this checkout.\n");
} else {
  await ensureHook();
  await runGit(["config", "core.hooksPath", ".githooks"]);
  process.stdout.write(
    "Local Git hooks installed. pre-push now requires a passing pnpm verify:local report.\n",
  );
}
