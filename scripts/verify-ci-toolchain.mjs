import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function validateToolchainVersions(actualNode, actualPnpm, expectedNode, expectedPnpm) {
  if (actualNode !== expectedNode) {
    throw new Error(`Node.js version mismatch: expected ${expectedNode}, received ${actualNode}`);
  }
  if (actualPnpm !== expectedPnpm) {
    throw new Error(`pnpm version mismatch: expected ${expectedPnpm}, received ${actualPnpm}`);
  }
}

export function pnpmVersionInvocation(platform = process.platform) {
  return platform === "win32"
    ? Object.freeze({
        arguments: Object.freeze(["/d", "/s", "/c", "pnpm.cmd --version"]),
        executable: "cmd.exe",
      })
    : Object.freeze({ arguments: Object.freeze(["--version"]), executable: "pnpm" });
}

function readPnpmVersion() {
  const invocation = pnpmVersionInvocation();
  return execFileSync(invocation.executable, invocation.arguments, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  }).trim();
}

const isDirectInvocation =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectInvocation) {
  const [expectedNode, expectedPnpm, ...unexpected] = process.argv.slice(2);
  if (expectedNode === undefined || expectedPnpm === undefined || unexpected.length > 0) {
    throw new Error("usage: node scripts/verify-ci-toolchain.mjs <node-version> <pnpm-version>");
  }
  const actualNode = process.versions.node;
  const actualPnpm = readPnpmVersion();
  validateToolchainVersions(actualNode, actualPnpm, expectedNode, expectedPnpm);
  console.log(`Verified Node.js ${actualNode} and pnpm ${actualPnpm}.`);
}
