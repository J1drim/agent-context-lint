import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serializeVitestReport } from "./deterministic-report.mjs";
import { runVitestSuite } from "./run-vitest-suite.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readNormalizedReport(filePath) {
  const report = JSON.parse(await readFile(filePath, "utf8"));
  return serializeVitestReport(report, rootDirectory);
}

async function readNormalizedReports(filePaths) {
  return (await Promise.all(filePaths.map(readNormalizedReport))).join("");
}

async function requireSuccessfulReplay(mode, outputFiles) {
  const outcome = await runVitestSuite({ mode, outputFiles });
  if (outcome.status !== 0 || outcome.signal !== null || outcome.error !== undefined) {
    throw new Error(`Vitest ${mode} determinism replay failed in ${String(outcome.lane)}`);
  }
}

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-context-lint-determinism-"));
  try {
    const serialPaths = [
      path.join(directory, "serial-light.json"),
      path.join(directory, "serial-maximum-size.json"),
    ];
    const parallelPaths = [
      path.join(directory, "parallel-light.json"),
      path.join(directory, "parallel-maximum-size.json"),
    ];
    await requireSuccessfulReplay("serial", serialPaths);
    await requireSuccessfulReplay("parallel", parallelPaths);

    const [serial, parallel] = await Promise.all([
      readNormalizedReports(serialPaths),
      readNormalizedReports(parallelPaths),
    ]);
    if (serial !== parallel) {
      throw new Error("normalized serial and parallel Vitest results differ");
    }
    const hash = createHash("sha256").update(serial).digest("hex");
    console.log(`Deterministic Vitest report SHA-256: ${hash} (serial = parallel).`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

await main();
