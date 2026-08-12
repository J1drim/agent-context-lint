#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateNativeReleaseProof } from "./native-proof.mjs";
import { readBoundedArtifactRecord } from "./run.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const STATE_PATH = "calibration/metadata/v0/k03-gate-state.json";
const STATUS_MARKER_PATTERN = /^K03 gate-state status:\s*`([^`\r\n]+)`\s*$/gmu;
const K03_STATUSES = new Set(["feature-unavailable", "ready"]);

/**
 * Read the one machine-owned K03 state marker from the implementation ledger.
 * Historical prose is deliberately ignored: readiness must be updated through
 * this exact line in the same change as the committed gate-state artifact.
 * The public release snapshot intentionally omits the planning ledger; in that
 * snapshot the signed, schema-validated gate-state artifact is authoritative.
 */
export function readK03StatusMarker(implementationStatus) {
  if (typeof implementationStatus !== "string")
    throw new TypeError("IMPLEMENTATION_STATUS.md must be text");
  const matches = [...implementationStatus.matchAll(STATUS_MARKER_PATTERN)];
  if (matches.length !== 1)
    throw new Error(
      "IMPLEMENTATION_STATUS.md must contain exactly one K03 gate-state status marker",
    );
  const status = matches[0][1];
  if (!K03_STATUSES.has(status))
    throw new Error(
      `IMPLEMENTATION_STATUS.md contains unsupported K03 gate-state status: ${status}`,
    );
  return status;
}

export async function checkK03GateState({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const [schema, stateRecord, implementationStatus] = await Promise.all([
    readFile(
      path.join(
        repositoryRoot,
        "calibration/schemas/metadata-calibration-gate-state.v0.schema.json",
      ),
      "utf8",
    ).then(JSON.parse),
    readBoundedArtifactRecord(repositoryRoot, STATE_PATH),
    readFile(path.join(repositoryRoot, "IMPLEMENTATION_STATUS.md"), "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  const state = stateRecord.value;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(state))
    throw new Error(
      (validate.errors ?? [])
        .map((error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`)
        .join("\n"),
    );
  const statusMarker =
    implementationStatus === null ? state.status : readK03StatusMarker(implementationStatus);
  if (state.status !== statusMarker)
    throw new Error("K03 gate state differs from IMPLEMENTATION_STATUS.md marker");
  const nativeProof = (await readBoundedArtifactRecord(repositoryRoot, state.nativeProofPath))
    .value;
  await validateNativeReleaseProof(nativeProof, {
    repositoryRoot,
    requireReady: state.status === "ready",
  });
  if ((nativeProof.status === "ready") !== (state.status === "ready"))
    throw new Error("K03 gate state differs from its committed native release proof");
  return state;
}

/**
 * Serialize the repository-owned K03 state for automation without adding any
 * release authority. The caller must still run the full release mode once the
 * state becomes ready.
 */
export function formatK03GateState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

async function runReadyGate() {
  const { checkK03PrecisionGate } = await import("./gate.mjs");
  return checkK03PrecisionGate({
    cliEntry: process.env.AGENT_CONTEXT_LINT_K03_CLI_ENTRY,
    gitExecutable: process.env.AGENT_CONTEXT_LINT_K03_GIT,
    hdiutilExecutable: process.env.AGENT_CONTEXT_LINT_K03_HDIUTIL,
    nodeExecutable: process.env.AGENT_CONTEXT_LINT_K03_NODE,
    packageRoot: process.env.AGENT_CONTEXT_LINT_K03_PACKAGE_ROOT,
    preTuningPrivateReviewPath: process.env.AGENT_CONTEXT_LINT_K03_PRE_PRIVATE_REVIEW,
    privateReviewPath: process.env.AGENT_CONTEXT_LINT_K03_PRIVATE_REVIEW,
  });
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const arguments_ = process.argv.slice(2);
    if (
      arguments_.length > 1 ||
      (arguments_.length === 1 && !["--json", "--release"].includes(arguments_[0]))
    )
      throw new Error("Usage: node tools/metadata-calibration/gate-state.mjs [--json|--release]");
    if (arguments_.length === 1 && arguments_[0] === "--json") {
      const state = await checkK03GateState();
      process.stdout.write(formatK03GateState(state));
      process.exitCode = 0;
    } else {
      const state = await checkK03GateState();
      if (state.status === "ready") {
        const result = await runReadyGate();
        process.stdout.write(
          `K03 precision release gate passed for ${String(result.diagnosticCount)} diagnostics.\n`,
        );
      } else if (arguments_[0] === "--release") {
        throw new Error(`K03 release is blocked: ${state.blockers.join(", ")}`);
      } else {
        process.stdout.write(
          `K03 precision is explicitly ${state.status}: ${state.blockers.join(", ")}\n`,
        );
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "K03 gate state failed"}\n`);
    process.exitCode = 1;
  }
}
