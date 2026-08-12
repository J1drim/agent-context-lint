import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serializeCoverageMap } from "./normalize-coverage.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coverageDirectory = path.join(rootDirectory, "coverage");
export const COVERAGE_MAX_WORKERS = 1;
const PATH_ARGUMENT_PREFIXES = Object.freeze([
  "--merge-reports=",
  "--outputFile.blob=",
  "--coverage.reportsDirectory=",
]);

function isAbsolutePath(value, platform) {
  return platform === "win32" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

function displayVitestArgument(value) {
  const prefix = PATH_ARGUMENT_PREFIXES.find((candidate) => value.startsWith(candidate));
  return prefix === undefined ? value : `${prefix}<path>`;
}

/**
 * Resolve the package-manager command used by coverage collection.
 *
 * Normal developer invocations retain the platform package-manager lookup. A sealed invocation
 * may provide the exact JavaScript launcher and Node executable through the same environment
 * contract used by the release/package gates. The launcher is then executed by that Node binary,
 * rather than through PATH or a shell. Disabling pnpm's global virtual store for this command also
 * keeps a coverage replay independent from a checkout's prior pnpm metadata.
 */
export function resolvePnpmInvocation(environment = process.env, platform = process.platform) {
  const launcher = environment.AGENT_CONTEXT_PACK_PNPM;
  if (launcher === undefined) {
    return Object.freeze({
      executable: platform === "win32" ? "pnpm.cmd" : "pnpm",
      prefix: Object.freeze([]),
      displayArguments: Object.freeze([]),
      display: "pnpm",
    });
  }
  if (
    typeof launcher !== "string" ||
    !isAbsolutePath(launcher, platform) ||
    !/\.(?:cjs|mjs)$/u.test(launcher)
  ) {
    throw new Error("AGENT_CONTEXT_PACK_PNPM must identify an absolute .cjs or .mjs launcher");
  }
  const nodeExecutable = environment.AGENT_CONTEXT_PACK_NODE;
  if (typeof nodeExecutable !== "string" || !isAbsolutePath(nodeExecutable, platform)) {
    throw new Error("AGENT_CONTEXT_PACK_NODE must identify an absolute executable path");
  }
  const configArgument = "--config.enable-global-virtual-store=false";
  return Object.freeze({
    executable: nodeExecutable,
    prefix: Object.freeze([launcher, configArgument]),
    displayArguments: Object.freeze([configArgument]),
    display: "pnpm",
  });
}

export function runVitest(
  arguments_,
  captureOutput = false,
  spawn = spawnSync,
  environment = process.env,
  platform = process.platform,
) {
  const invocation = resolvePnpmInvocation(environment, platform);
  const commandArguments = [...invocation.prefix, "exec", "vitest", ...arguments_];
  const result = spawn(invocation.executable, commandArguments, {
    cwd: rootDirectory,
    encoding: "utf8",
    shell: false,
    stdio: captureOutput ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join("\n");
    const displayCommand = [
      invocation.display,
      ...invocation.displayArguments,
      "exec",
      "vitest",
      ...arguments_.map(displayVitestArgument),
    ].join(" ");
    throw new Error(
      `Vitest coverage command failed with status ${String(result.status)}${result.signal === null ? "" : ` and signal ${String(result.signal)}`}: ${displayCommand}${output === "" ? "" : `\n${output}`}`,
    );
  }
}

export function coverageCollectionArguments(project, blobPath, reportsDirectory) {
  return Object.freeze([
    "run",
    "--no-color",
    `--project=${project}`,
    "--coverage",
    "--no-file-parallelism",
    `--maxWorkers=${String(COVERAGE_MAX_WORKERS)}`,
    "--reporter=default",
    "--reporter=blob",
    `--outputFile.blob=${blobPath}`,
    `--coverage.reportsDirectory=${reportsDirectory}`,
    "--coverage.reporter=json",
    "--coverage.thresholds.lines=0",
    "--coverage.thresholds.functions=0",
    "--coverage.thresholds.branches=0",
    "--coverage.thresholds.statements=0",
  ]);
}

function collectProject(project, blobPath, reportsDirectory) {
  runVitest(coverageCollectionArguments(project, blobPath, reportsDirectory));
}

export function coverageMergeArguments(blobDirectory, reportsDirectory) {
  return Object.freeze([
    `--merge-reports=${blobDirectory}`,
    "--coverage",
    "--reporter=minimal",
    `--coverage.reportsDirectory=${reportsDirectory}`,
    "--coverage.reporter=text",
    "--coverage.reporter=json",
    "--coverage.reporter=json-summary",
  ]);
}

function mergeReports(blobDirectory, reportsDirectory, captureOutput = false) {
  runVitest(coverageMergeArguments(blobDirectory, reportsDirectory), captureOutput);
}

async function normalizedReport(reportsDirectory) {
  const coverageMap = JSON.parse(
    await readFile(path.join(reportsDirectory, "coverage-final.json"), "utf8"),
  );
  return serializeCoverageMap(coverageMap, rootDirectory);
}

export async function main() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-context-lint-coverage-"));
  try {
    const blobDirectory = path.join(temporaryDirectory, "blobs");
    const reverseBlobDirectory = path.join(temporaryDirectory, "reverse-blobs");
    await Promise.all([mkdir(blobDirectory), mkdir(reverseBlobDirectory)]);
    const unitBlob = path.join(blobDirectory, "01-unit.json");
    const integrationBlob = path.join(blobDirectory, "02-integration.json");

    collectProject("unit", unitBlob, path.join(temporaryDirectory, "unit-coverage"));
    collectProject(
      "integration",
      integrationBlob,
      path.join(temporaryDirectory, "integration-coverage"),
    );

    await rm(coverageDirectory, { force: true, recursive: true });
    mergeReports(blobDirectory, coverageDirectory);
    const forward = await normalizedReport(coverageDirectory);

    await Promise.all([
      copyFile(unitBlob, path.join(reverseBlobDirectory, "02-unit.json")),
      copyFile(integrationBlob, path.join(reverseBlobDirectory, "01-integration.json")),
    ]);
    const reverseCoverage = path.join(temporaryDirectory, "reverse-coverage");
    mergeReports(reverseBlobDirectory, reverseCoverage, true);
    const reverse = await normalizedReport(reverseCoverage);
    if (forward !== reverse) {
      throw new Error("coverage merge changes when blob input order changes");
    }

    await writeFile(path.join(coverageDirectory, "normalized-coverage.json"), forward);
    const hash = createHash("sha256").update(forward).digest("hex");
    console.log(`Normalized merged coverage SHA-256: ${hash} (input order independent).`);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
