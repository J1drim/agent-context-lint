import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  captureUpstreamSnapshot,
  canonicalJson,
  upstreamCatalogPath,
  verifyUpstreamSnapshot,
  writeSnapshotArtifacts,
} from "./upstream-snapshotter.mjs";
import { createOfficialSourceTransport } from "./upstream-transport.mjs";
import {
  generateUpstreamReviewArtifacts,
  readReviewInput,
  verifyUpstreamReviewArtifacts,
  writeUpstreamReviewArtifacts,
} from "./upstream-review.mjs";

export const LOCAL_WEEKLY_CHECK_CONTRACT_VERSION = "1.0.0";
export const LOCAL_WEEKLY_CHECK_RECORD_KIND = "agent-context-standards-weekly-check";
export const LOCAL_WEEKLY_ACCEPT_RECORD_KIND = "agent-context-standards-baseline-acceptance";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_FILE = "last-check.v1.json";
const BASELINE_DIRECTORY = "baseline";
const CANDIDATE_DIRECTORY = "candidate";
const REVIEW_DIRECTORY = "review";
const SOURCE_FILE = "upstream-source.v1.json";
const PROVENANCE_FILE = "upstream-provenance.v1.json";

export class LocalWeeklyCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalWeeklyCheckError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LocalWeeklyCheckError(code, message);
}

function defaultStateDirectory() {
  if (process.platform === "darwin")
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "agent-context-lint",
      "standards",
    );
  if (process.platform === "win32")
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "agent-context-lint",
      "standards",
    );
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "agent-context-lint",
    "standards",
  );
}

function validPath(value) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0")
  );
}

function absolutePath(value, label) {
  if (!validPath(value)) fail("invalid-input", `${label} is invalid`);
  const selected = path.resolve(value);
  if (selected === path.parse(selected).root)
    fail("unsafe-path", `${label} cannot be a filesystem root`);
  return selected;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function assertOutsideRepository(selected, label) {
  if (inside(rootDirectory, selected))
    fail("unsafe-path", `${label} must be outside the repository`);
}

async function ensureDirectory(selected, label) {
  try {
    const before = await lstat(selected);
    if (before.isSymbolicLink() || !before.isDirectory())
      fail("unsafe-path", `${label} must be a real directory`);
    return await realpath(selected);
  } catch (error) {
    if (error instanceof LocalWeeklyCheckError || error?.code !== "ENOENT") throw error;
    await mkdir(selected, { mode: 0o700, recursive: true });
    const after = await lstat(selected);
    if (after.isSymbolicLink() || !after.isDirectory())
      fail("unsafe-path", `${label} could not be created safely`);
    return await realpath(selected);
  }
}

async function replaceDirectory(source, target) {
  const parent = path.dirname(target);
  await ensureDirectory(parent, "state directory");
  const backup = `${target}.old-${process.pid}-${randomBytes(6).toString("hex")}`;
  let moved = false;
  try {
    try {
      const current = await lstat(target);
      if (current.isSymbolicLink() || !current.isDirectory())
        fail("unsafe-path", "state entry is not a real directory");
      await rename(target, backup);
      moved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(source, target);
    await rm(backup, { force: true, recursive: true });
  } catch (error) {
    await rm(target, { force: true, recursive: true }).catch(() => {});
    if (moved) await rename(backup, target).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomically(selected, value) {
  const parent = path.dirname(selected);
  await ensureDirectory(parent, "state directory");
  const existing = await lstat(selected).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null && (existing.isSymbolicLink() || !existing.isFile()))
    fail("unsafe-output", "state output must be a regular file");
  const bytes = canonicalJson(value);
  const temporary = `${selected}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFileSecure(temporary, bytes);
    await rename(temporary, selected);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeFileSecure(selected, bytes) {
  const existing = await lstat(selected).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) fail("unsafe-output", "state output already exists");
  const handle = await open(selected, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function snapshotPaths(directory) {
  return {
    provenance: path.join(directory, PROVENANCE_FILE),
    source: path.join(directory, SOURCE_FILE),
  };
}

async function readSnapshot(directory, label) {
  const paths = snapshotPaths(directory);
  const sourceBytes = await readReviewInput(paths.source);
  const provenanceBytes = await readReviewInput(paths.provenance);
  const verified = verifyUpstreamSnapshot({
    catalogBytes: await readFile(upstreamCatalogPath),
    provenanceBytes,
    sourceBytes,
  });
  return Object.freeze({
    label,
    provenanceBytes,
    sourceBytes,
    sourceArtifactSha256: verified.sourceArtifactSha256,
    retrievedAt: verified.retrievedAt,
    sources: verified.sources,
  });
}

async function captureToDirectory(directory, { now, signal, transport }) {
  const catalogBytes = await readFile(upstreamCatalogPath);
  const milliseconds = now === undefined ? Date.now() : now;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < Date.UTC(1970, 0, 1))
    fail("invalid-date", "local standards clock is invalid");
  const retrievedAt = new Date(milliseconds).toISOString().slice(0, 10);
  const artifacts = await captureUpstreamSnapshot({
    catalogBytes,
    retrievedAt,
    signal,
    transport: transport ?? createOfficialSourceTransport(),
  });
  await writeSnapshotArtifacts(directory, artifacts);
  return readSnapshot(directory, "candidate");
}

function stateRecord({ status, checkedAt, baseline, candidate, review, message = null }) {
  return Object.freeze({
    candidate: Object.freeze({
      retrievedAt: candidate.retrievedAt,
      sourceArtifactSha256: candidate.sourceArtifactSha256,
      sources: candidate.sources,
    }),
    checkedAt,
    contractVersion: LOCAL_WEEKLY_CHECK_CONTRACT_VERSION,
    message,
    recordKind: LOCAL_WEEKLY_CHECK_RECORD_KIND,
    review: review === null ? null : Object.freeze(review),
    status,
    baseline:
      baseline === null
        ? null
        : Object.freeze({
            retrievedAt: baseline.retrievedAt,
            sourceArtifactSha256: baseline.sourceArtifactSha256,
            sources: baseline.sources,
          }),
  });
}

function checkedAt(now) {
  const milliseconds = now === undefined ? Date.now() : now;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < Date.UTC(1970, 0, 1))
    fail("invalid-date", "local standards clock is invalid");
  return new Date(milliseconds).toISOString();
}

async function readState(stateDirectory) {
  const selected = path.join(stateDirectory, STATE_FILE);
  try {
    const value = JSON.parse((await readReviewInput(selected, 256 * 1024)).toString("utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.contractVersion !== LOCAL_WEEKLY_CHECK_CONTRACT_VERSION ||
      value.recordKind !== LOCAL_WEEKLY_CHECK_RECORD_KIND
    )
      fail("invalid-state", "local standards state has an unsupported contract");
    return value;
  } catch (error) {
    if (error instanceof LocalWeeklyCheckError) throw error;
    if (error?.code === "ENOENT") return null;
    fail("invalid-state", "local standards state is unreadable");
  }
}

function parseArguments(arguments_) {
  const options = {
    acknowledgeNetwork: false,
    acceptBaseline: false,
    failOnChange: false,
    format: "terminal",
    initialize: false,
    mode: "check",
    outputDirectory: null,
    stateDirectory: defaultStateDirectory(),
  };
  const values = [...arguments_];
  if (values[0] === "--") values.shift();
  if (values[0] === "check" || values[0] === "accept") options.mode = values.shift();
  if (values[0] === "--") values.shift();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--acknowledge-network") options.acknowledgeNetwork = true;
    else if (argument === "--accept-baseline") options.acceptBaseline = true;
    else if (argument === "--initialize") options.initialize = true;
    else if (argument === "--fail-on-change") options.failOnChange = true;
    else if (argument === "--format") {
      const format = values[++index];
      if (format !== "terminal" && format !== "json")
        fail("usage", "--format must be terminal or json");
      options.format = format;
    } else if (argument === "--state-dir" || argument === "--output-dir") {
      const value = values[++index];
      if (!validPath(value) || value.startsWith("-")) fail("usage", `${argument} needs a path`);
      if (argument === "--state-dir") options.stateDirectory = value;
      else options.outputDirectory = value;
    } else if (argument === "--help" || argument === "-h") options.mode = "help";
    else fail("usage", `unknown local standards option: ${argument}`);
  }
  if (options.mode === "accept") options.acceptBaseline = true;
  if (
    options.acceptBaseline &&
    (options.initialize || options.acknowledgeNetwork || options.failOnChange)
  )
    fail("usage", "baseline acceptance cannot be combined with check options");
  if (options.initialize && options.mode !== "check")
    fail("usage", "--initialize is valid only for check");
  return options;
}

export function parseLocalWeeklyArguments(arguments_) {
  return Object.freeze(parseArguments(arguments_));
}

export async function runLocalWeeklyCheck({
  acknowledgeNetwork = false,
  acceptBaseline = false,
  initialize = false,
  now,
  outputDirectory = null,
  signal = new AbortController().signal,
  stateDirectory = defaultStateDirectory(),
  transport,
} = {}) {
  const requestedState = absolutePath(stateDirectory, "state directory");
  const state = await ensureDirectory(requestedState, "state directory");
  assertOutsideRepository(state, "state directory");
  if (acceptBaseline) {
    const candidate = await readSnapshot(path.join(state, CANDIDATE_DIRECTORY), "candidate");
    const previous = await readState(state);
    if (previous?.status !== "changed")
      fail("invalid-state", "no changed candidate is awaiting acceptance");
    const baselineStageRoot = await realpath(await mkdtemp(path.join(state, ".baseline-stage-")));
    const baselineStage = path.join(baselineStageRoot, BASELINE_DIRECTORY);
    try {
      await writeSnapshotArtifacts(baselineStage, {
        sourceBytes: candidate.sourceBytes,
        provenanceBytes: candidate.provenanceBytes,
        sourceArtifact: null,
        provenanceArtifact: null,
      });
      await replaceDirectory(baselineStage, path.join(state, BASELINE_DIRECTORY));
      await rm(baselineStageRoot, { force: true, recursive: true });
    } catch (error) {
      await rm(baselineStageRoot, { force: true, recursive: true });
      throw error;
    }
    const result = Object.freeze({
      acceptedAt: checkedAt(now),
      baseline: Object.freeze({
        retrievedAt: candidate.retrievedAt,
        sourceArtifactSha256: candidate.sourceArtifactSha256,
      }),
      contractVersion: LOCAL_WEEKLY_CHECK_CONTRACT_VERSION,
      recordKind: LOCAL_WEEKLY_ACCEPT_RECORD_KIND,
      status: "baseline-accepted",
    });
    await writeJsonAtomically(
      path.join(state, STATE_FILE),
      stateRecord({
        status: "baseline-accepted",
        checkedAt: result.acceptedAt,
        baseline: candidate,
        candidate,
        review: null,
        message: "candidate promoted after explicit maintainer acceptance",
      }),
    );
    return result;
  }
  if (!acknowledgeNetwork)
    fail(
      "network-acknowledgement-required",
      "pass --acknowledge-network before fetching official sources",
    );
  const baselineDirectory = path.join(state, BASELINE_DIRECTORY);
  const candidateStageRoot = await realpath(await mkdtemp(path.join(state, ".candidate-stage-")));
  const candidateStage = path.join(candidateStageRoot, CANDIDATE_DIRECTORY);
  try {
    const candidate = await captureToDirectory(candidateStage, { now, signal, transport });
    const baselineExists = await lstat(baselineDirectory)
      .then(() => true)
      .catch((error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
    if (!baselineExists) {
      if (!initialize) fail("baseline-required", "no baseline exists; rerun with --initialize");
      await replaceDirectory(candidateStage, path.join(state, CANDIDATE_DIRECTORY));
      const baselineStageRoot = await realpath(await mkdtemp(path.join(state, ".baseline-stage-")));
      const baselineStage = path.join(baselineStageRoot, BASELINE_DIRECTORY);
      try {
        await writeSnapshotArtifacts(baselineStage, {
          sourceBytes: candidate.sourceBytes,
          provenanceBytes: candidate.provenanceBytes,
          sourceArtifact: null,
          provenanceArtifact: null,
        });
        await replaceDirectory(baselineStage, baselineDirectory);
        await rm(baselineStageRoot, { force: true, recursive: true });
      } catch (error) {
        await rm(baselineStageRoot, { force: true, recursive: true });
        throw error;
      }
      const result = stateRecord({
        status: "baseline-initialized",
        checkedAt: checkedAt(now),
        baseline: candidate,
        candidate,
        review: null,
        message: "baseline created from a verified official-source snapshot",
      });
      await writeJsonAtomically(path.join(state, STATE_FILE), result);
      return result;
    }
    const baseline = await readSnapshot(baselineDirectory, "baseline");
    const review = generateUpstreamReviewArtifacts({
      baselineProvenanceBytes: baseline.provenanceBytes,
      baselineSourceBytes: baseline.sourceBytes,
      candidateProvenanceBytes: candidate.provenanceBytes,
      candidateSourceBytes: candidate.sourceBytes,
      catalogBytes: await readFile(upstreamCatalogPath),
    });
    const verifiedReview = verifyUpstreamReviewArtifacts({
      baselineProvenanceBytes: baseline.provenanceBytes,
      baselineSourceBytes: baseline.sourceBytes,
      candidateProvenanceBytes: candidate.provenanceBytes,
      candidateSourceBytes: candidate.sourceBytes,
      catalogBytes: await readFile(upstreamCatalogPath),
      markdownBytes: review.markdownBytes,
      reviewBytes: review.reviewBytes,
      scaffoldBytes: review.scaffoldBytes,
    });
    const changed =
      review.reviewArtifact.summary.changedSectionCount > 0 ||
      review.reviewArtifact.summary.rawOnlyChangedSourceCount > 0;
    await replaceDirectory(candidateStage, path.join(state, CANDIDATE_DIRECTORY));
    let reviewDirectory = null;
    if (changed) {
      const selectedOutput =
        outputDirectory === null
          ? path.join(state, REVIEW_DIRECTORY)
          : absolutePath(outputDirectory, "output directory");
      assertOutsideRepository(selectedOutput, "output directory");
      const reviewStageRoot = await realpath(
        await mkdtemp(path.join(path.dirname(selectedOutput), ".review-stage-")),
      );
      const reviewStage = path.join(reviewStageRoot, REVIEW_DIRECTORY);
      try {
        await writeUpstreamReviewArtifacts(reviewStage, review);
        await replaceDirectory(reviewStage, selectedOutput);
        await rm(reviewStageRoot, { force: true, recursive: true });
        reviewDirectory = selectedOutput;
      } catch (error) {
        await rm(reviewStageRoot, { force: true, recursive: true });
        throw error;
      }
    }
    const result = stateRecord({
      status: changed ? "changed" : "unchanged",
      checkedAt: checkedAt(now),
      baseline,
      candidate,
      review: {
        changedSections: verifiedReview.changedSections,
        reviewArtifactSha256: verifiedReview.reviewArtifactSha256,
        directory: reviewDirectory,
      },
      message: changed
        ? "official source changes require human review"
        : "no bounded source changes detected",
    });
    await writeJsonAtomically(path.join(state, STATE_FILE), result);
    await rm(candidateStageRoot, { force: true, recursive: true });
    return result;
  } finally {
    await rm(candidateStageRoot, { force: true, recursive: true });
  }
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm standards:weekly -- --initialize --acknowledge-network",
      "  pnpm standards:weekly -- --acknowledge-network",
      "  pnpm standards:weekly:accept",
      "",
      `State defaults outside the repository (${defaultStateDirectory()}).`,
      "The check downloads only the six compiled official documentation sources, verifies bounded",
      "snapshots, compares them with the retained baseline, and never changes rules automatically.",
      "Pass --fail-on-change when a scheduler should report a changed source as exit code 10.",
    ].join("\n") + "\n",
  );
}

async function main(arguments_) {
  const options = parseArguments(arguments_);
  if (options.mode === "help") {
    printHelp();
    return;
  }
  const result = await runLocalWeeklyCheck(options);
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify(result)}\n`
      : [
          "Local standards weekly check",
          `Result: ${result.status}`,
          `Checked at: ${result.checkedAt ?? result.acceptedAt}`,
          result.candidate === undefined ? "" : `Sources: ${String(result.candidate.sources)}`,
          result.review?.changedSections === undefined
            ? ""
            : `Changed sections: ${String(result.review.changedSections)}`,
          result.review?.directory === null || result.review?.directory === undefined
            ? ""
            : `Review: ${result.review.directory}`,
          "",
        ].join("\n"),
  );
  if (options.failOnChange && result.status === "changed") process.exitCode = 10;
}

const invoked =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof LocalWeeklyCheckError ? error.code : "unexpected-failure";
    process.stderr.write(
      `${code}: ${error instanceof Error ? error.message : "local standards check failed closed"}\n`,
    );
    process.exitCode = 1;
  }
}
