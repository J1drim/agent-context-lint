import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_GATE_REPORT_VERSION = 1;
export const DEFAULT_REPORT_PATH = path.join(rootDirectory, ".git", "local-gate-result.json");
const ZERO_SHA = /^(?:0){40}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitOutput(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function parseLocalGateArguments(arguments_) {
  const options = { mode: "run", reportPath: DEFAULT_REPORT_PATH };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--verify-push" || argument === "--verify") {
      options.mode = "verify-push";
      continue;
    }
    if (argument === "--run") {
      options.mode = "run";
      continue;
    }
    if (argument === "--report") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) throw new Error("--report needs a path");
      options.reportPath = path.resolve(rootDirectory, value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.mode = "help";
      continue;
    }
    throw new Error(`unknown local gate option: ${argument}`);
  }
  return options;
}

export function parsePushReferences(source) {
  const references = [];
  for (const line of source.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4) throw new Error("pre-push input has an invalid reference line");
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if (!/^(?:[0-9a-f]{40})$/u.test(localSha) || !/^(?:[0-9a-f]{40})$/u.test(remoteSha))
      throw new Error("pre-push input contains an invalid object ID");
    references.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return references;
}

function pnpmInvocation() {
  const launcher = process.env.AGENT_CONTEXT_LOCAL_GATE_PNPM ?? process.env.npm_execpath;
  if (
    typeof launcher === "string" &&
    path.isAbsolute(launcher) &&
    [".cjs", ".mjs"].includes(path.extname(launcher))
  ) {
    return { executable: process.execPath, arguments: [launcher, "check"] };
  }
  return { executable: "pnpm", arguments: ["check"] };
}

async function writeReport(reportPath, report) {
  const parent = path.dirname(reportPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(reportPath);
    if (existing.isSymbolicLink() || !existing.isFile())
      throw new Error("local gate report path must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${reportPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, reportPath);
}

export async function readLocalGateReport(reportPath = DEFAULT_REPORT_PATH) {
  let value;
  try {
    value = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw new Error(`no readable local gate report at ${reportPath}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("local gate report must be an object");
  return value;
}

export function validateLocalGateReport(report, { commit, lockfileSha256 } = {}) {
  if (report.reportVersion !== LOCAL_GATE_REPORT_VERSION)
    throw new Error("local gate report version is unsupported");
  if (report.status !== "passed") throw new Error("local gate did not pass");
  if (!/^[0-9a-f]{40}$/u.test(report.commit)) throw new Error("local gate commit is invalid");
  if (!/^[0-9a-f]{64}$/u.test(report.lockfileSha256))
    throw new Error("local gate lockfile digest is invalid");
  if (commit !== undefined && report.commit !== commit)
    throw new Error(`local gate report is for ${report.commit}, not pushed commit ${commit}`);
  if (lockfileSha256 !== undefined && report.lockfileSha256 !== lockfileSha256)
    throw new Error("local gate report does not match the current lockfile");
  if (
    !Array.isArray(report.commands) ||
    report.commands.length !== 1 ||
    report.commands[0] !== "pnpm check"
  )
    throw new Error("local gate report command inventory is invalid");
  return report;
}

async function verifyPush(reportPath, input) {
  const references = parsePushReferences(input);
  const pushed = references.filter(({ localSha }) => !ZERO_SHA.test(localSha));
  if (pushed.length === 0) return;
  const lockfileSha256 = sha256(await readFile(path.join(rootDirectory, "pnpm-lock.yaml")));
  const report = await readLocalGateReport(reportPath);
  for (const reference of pushed)
    validateLocalGateReport(report, { commit: reference.localSha, lockfileSha256 });
  process.stdout.write(
    `Local gate report accepted for ${pushed.map(({ localSha }) => localSha).join(", ")}.\n`,
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function runGate(reportPath) {
  const startedAt = new Date().toISOString();
  const commit = gitOutput(["rev-parse", "HEAD"]);
  const lockfileBytes = await readFile(path.join(rootDirectory, "pnpm-lock.yaml"));
  const invocation = pnpmInvocation();
  const started = Date.now();
  const child = spawn(invocation.executable, invocation.arguments, {
    cwd: rootDirectory,
    env: { ...process.env, CI: "true" },
    shell: false,
    stdio: "inherit",
  });
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error, exitCode: null, signal: null }));
    child.once("close", (exitCode, signal) => resolve({ error: null, exitCode, signal }));
  });
  const report = {
    reportVersion: LOCAL_GATE_REPORT_VERSION,
    status: result.error === null && result.exitCode === 0 ? "passed" : "failed",
    commit,
    lockfileSha256: sha256(lockfileBytes),
    node: process.version,
    pnpm: "11.18.0",
    commands: ["pnpm check"],
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode: result.exitCode,
    signal: result.signal,
  };
  await writeReport(DEFAULT_REPORT_PATH, report);
  if (reportPath !== DEFAULT_REPORT_PATH) await writeReport(reportPath, report);
  process.stdout.write(`Local gate ${report.status}; report: ${reportPath}\n`);
  if (result.error !== null) throw result.error;
  if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm verify:local -- --report local-gate-report.json",
      "  node scripts/run-local-gate.mjs --verify-push < pre-push-input.txt",
      "",
      "A successful run writes .git/local-gate-result.json. The pre-push hook accepts only a",
      "passing report for every pushed commit and the current pnpm-lock.yaml digest.",
    ].join("\n") + "\n",
  );
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const options = parseLocalGateArguments(process.argv.slice(2));
  if (options.mode === "help") printHelp();
  else if (options.mode === "verify-push") await verifyPush(options.reportPath, await readStdin());
  else await runGate(options.reportPath);
}
