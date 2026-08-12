import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractTarball, packCleanCliAndCore } from "../../scripts/check-packed-manifests.mjs";
import { canonicalJson, sha256Canonical } from "./contracts.mjs";
import { createDarwinConfinementFactory } from "./confinement.mjs";
import { inspectPackedEngine, runBoundedCommand } from "./execute.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const NETWORK_GUARD_PATH = path.join(MODULE_DIRECTORY, "build-network-guard.mjs");
const MAXIMUM_SOURCE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_SOURCE_FILES = 20_000;
const MAXIMUM_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const EVIDENCE_ONLY_FILES = new Set([
  "adjudication.json",
  "k03-gate-state.json",
  "k03-native-proof.json",
  "precision-evidence.json",
  "pre-tuning-adjudication.json",
  "pre-tuning-report.json",
  "pre-tuning-review-maintainer.json",
  "report.json",
  "review-maintainer.json",
]);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function replayEnvironment(
  temporaryRoot,
  { allowChildProcesses = false, allowWrites = false } = {},
) {
  const environment = Object.create(null);
  for (const key of ["SYSTEMROOT", "SystemRoot"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.PATH = "/usr/bin:/bin";
  environment.CI = "true";
  environment.COREPACK_ENABLE_NETWORK = "0";
  environment.HOME = temporaryRoot;
  environment.LC_ALL = "C";
  environment.NPM_CONFIG_OFFLINE = "true";
  environment.NO_COLOR = "1";
  environment.TMPDIR = temporaryRoot;
  environment.npm_config_offline = "true";
  if (process.env.npm_execpath !== undefined) environment.npm_execpath = process.env.npm_execpath;
  const permissions = [
    "--permission",
    "--allow-fs-read=*",
    ...(allowWrites ? [`--allow-fs-write=${temporaryRoot}`] : []),
    ...(allowChildProcesses ? ["--allow-child-process"] : []),
  ];
  environment.NODE_OPTIONS = `${permissions.join(" ")} --import=${pathToFileURL(NETWORK_GUARD_PATH).href}`;
  return environment;
}

function gitEnvironment(temporaryRoot) {
  return {
    ...replayEnvironment(temporaryRoot),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function tarEnvironment(temporaryRoot) {
  return Object.freeze({
    HOME: temporaryRoot,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TMPDIR: temporaryRoot,
  });
}

async function git(command, gitExecutable, repositoryRoot, temporaryRoot, options = {}) {
  const result = await command(
    gitExecutable,
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.excludesFile=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "diff.external=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.file.allow=never",
      ...options.arguments_,
    ],
    {
      cwd: repositoryRoot,
      environment: gitEnvironment(temporaryRoot),
      maximumStderrBytes: 64 * 1024,
      maximumStdoutBytes: options.maximumStdoutBytes ?? MAXIMUM_GIT_OUTPUT_BYTES,
      timeoutMs: options.timeoutMs ?? 60_000,
    },
  );
  if (result.status !== 0 || result.signal !== null)
    throw new Error(`${options.label} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function parseTree(output, objectFormat) {
  const entries = [];
  let totalBytes = 0;
  const oidLength = objectFormat === "sha256" ? 64 : objectFormat === "sha1" ? 40 : 0;
  if (oidLength === 0) throw new Error(`unsupported Git object format: ${objectFormat}`);
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 1) throw new Error("final source tree contains a malformed entry");
    const header = /^(?<mode>[0-9]+) (?<type>[^ ]+) (?<objectId>[0-9a-f]+) +(?<size>[0-9]+)$/u.exec(
      record.slice(0, tab),
    )?.groups;
    const repositoryPath = record.slice(tab + 1);
    if (
      header === undefined ||
      !new Set(["100644", "100755"]).has(header.mode) ||
      header.type !== "blob" ||
      !new RegExp(`^[0-9a-f]{${String(oidLength)}}$`, "u").test(header.objectId) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(header.size) ||
      repositoryPath === "" ||
      repositoryPath.includes("\\") ||
      path.posix.isAbsolute(repositoryPath) ||
      repositoryPath
        .split("/")
        .some((component) => component === "" || component === "." || component === "..")
    )
      throw new Error(`final source tree contains an unsafe entry: ${repositoryPath}`);
    const size = Number(header.size);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error(`final source tree contains an invalid size: ${repositoryPath}`);
    totalBytes += size;
    if (entries.length >= MAXIMUM_SOURCE_FILES || totalBytes > MAXIMUM_SOURCE_BYTES)
      throw new Error("final source tree exceeds the K03 replay inventory limit");
    entries.push({
      mode: header.mode,
      objectId: header.objectId,
      path: repositoryPath,
      size,
    });
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new Error("final source tree contains duplicate paths");
  return entries;
}

async function blobIdentity(root, entry, objectFormat) {
  const absolute = path.resolve(root, entry.path);
  if (!isWithin(root, absolute)) throw new Error(`source path escapes its root: ${entry.path}`);
  const lexical = await lstat(absolute);
  if (lexical.isSymbolicLink() || !lexical.isFile())
    throw new Error(`tracked source must be an ordinary file: ${entry.path}`);
  const resolved = await realpath(absolute);
  if (!isWithin(await realpath(root), resolved))
    throw new Error(`tracked source resolves outside its root: ${entry.path}`);
  const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== lexical.dev ||
      before.ino !== lexical.ino ||
      before.size !== entry.size ||
      ((before.mode & 0o111) === 0 ? "100644" : "100755") !== entry.mode
    )
      throw new Error(`tracked source identity differs from the commit: ${entry.path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error(`tracked source changed while hashing: ${entry.path}`);
    const hash = createHash(objectFormat);
    hash.update(`blob ${String(bytes.length)}\0`);
    hash.update(bytes);
    if (hash.digest("hex") !== entry.objectId)
      throw new Error(`tracked source bytes differ from the commit: ${entry.path}`);
  } finally {
    await handle.close();
  }
}

export async function verifySourceSubset(root, inventory, sourcePaths) {
  if (!Array.isArray(sourcePaths) || new Set(sourcePaths).size !== sourcePaths.length)
    throw new Error("clean source subset is not exact and duplicate-free");
  const byPath = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  for (const repositoryPath of sourcePaths) {
    const entry = byPath.get(repositoryPath);
    if (entry === undefined) throw new Error(`clean source subset invented ${repositoryPath}`);
    await blobIdentity(root, entry, inventory.objectFormat);
  }
}

async function rehashReviewedExecutable(executable, expected, label) {
  if (!path.isAbsolute(executable) || (await realpath(executable)) !== executable)
    throw new Error(`${label} executable is not canonical and absolute`);
  const metadata = await lstat(executable);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${label} executable is not an ordinary file`);
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  if (digest !== expected?.sha256) throw new Error(`${label} executable identity changed`);
}

function identityBoundCommand(command, executable, expected, label) {
  if (expected === undefined) return command;
  return async (...arguments_) => {
    await rehashReviewedExecutable(executable, expected, label);
    let result;
    let failure = null;
    try {
      result = await command(...arguments_);
    } catch (error) {
      failure = error;
    }
    let postflightFailure = null;
    try {
      await rehashReviewedExecutable(executable, expected, label);
    } catch (error) {
      postflightFailure = error;
    }
    if (failure !== null && postflightFailure !== null)
      throw new AggregateError(
        [failure, postflightFailure],
        `${label} operation failed and its executable identity changed`,
        { cause: failure },
      );
    if (failure !== null) throw failure;
    if (postflightFailure !== null) throw postflightFailure;
    return result;
  };
}

export async function inspectExactSourceInventory({
  command = runBoundedCommand,
  expectedCommitSha,
  gitExecutable,
  repositoryRoot,
  temporaryRoot,
}) {
  const root = await realpath(repositoryRoot);
  const head = (
    await git(command, gitExecutable, root, temporaryRoot, {
      arguments_: ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
      label: "final source HEAD resolution",
    })
  ).trim();
  if (head !== expectedCommitSha)
    throw new Error("final source HEAD does not equal the expected evidence commit");
  const status = await git(command, gitExecutable, root, temporaryRoot, {
    arguments_: ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    label: "final source cleanliness check",
  });
  if (status !== "") throw new Error("final source replay requires a clean tracked worktree");
  const inventory = await inspectCommitInventory({
    command,
    commitSha: expectedCommitSha,
    gitExecutable,
    repositoryRoot: root,
    temporaryRoot,
  });
  for (const entry of inventory.entries) await blobIdentity(root, entry, inventory.objectFormat);
  return Object.freeze({ ...inventory, commitSha: head });
}

export async function inspectCommitInventory({
  command = runBoundedCommand,
  commitSha,
  gitExecutable,
  repositoryRoot,
  temporaryRoot,
}) {
  const root = await realpath(repositoryRoot);
  const resolvedCommit = (
    await git(command, gitExecutable, root, temporaryRoot, {
      arguments_: ["-C", root, "rev-parse", "--verify", `${commitSha}^{commit}`],
      label: "source commit resolution",
    })
  ).trim();
  if (resolvedCommit !== commitSha) throw new Error("source commit SHA is forged or non-canonical");
  const objectFormat = (
    await git(command, gitExecutable, root, temporaryRoot, {
      arguments_: ["-C", root, "rev-parse", "--show-object-format"],
      label: "final source object-format resolution",
    })
  ).trim();
  const tree = await git(command, gitExecutable, root, temporaryRoot, {
    arguments_: ["-C", root, "ls-tree", "-rlz", "--full-tree", commitSha],
    label: "final source tree inventory",
  });
  const entries = parseTree(tree, objectFormat);
  return Object.freeze({
    commitSha: resolvedCommit,
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
    objectFormat,
    sha256: sha256Canonical({
      commitSha: resolvedCommit,
      entries,
      format: "k03-exact-committed-source-inventory-v1",
      objectFormat,
    }),
  });
}

function evidenceOnlyPath(repositoryPath) {
  if (repositoryPath === "IMPLEMENTATION_STATUS.md" || repositoryPath.startsWith("docs/"))
    return true;
  const prefix = "calibration/metadata/v0/";
  return (
    repositoryPath.startsWith(prefix) &&
    EVIDENCE_ONLY_FILES.has(repositoryPath.slice(prefix.length))
  );
}

export async function verifyEvidenceCommitLineage({
  command = runBoundedCommand,
  engineCommitSha,
  gitExecutable,
  repositoryRoot,
  temporaryRoot,
}) {
  const root = await realpath(repositoryRoot);
  const evidenceCommitSha = (
    await git(command, gitExecutable, root, temporaryRoot, {
      arguments_: ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
      label: "evidence commit resolution",
    })
  ).trim();
  await inspectExactSourceInventory({
    command,
    expectedCommitSha: evidenceCommitSha,
    gitExecutable,
    repositoryRoot: root,
    temporaryRoot,
  });
  await inspectCommitInventory({
    command,
    commitSha: engineCommitSha,
    gitExecutable,
    repositoryRoot: root,
    temporaryRoot,
  });
  const mergeBase = (
    await git(command, gitExecutable, root, temporaryRoot, {
      arguments_: ["-C", root, "merge-base", engineCommitSha, evidenceCommitSha],
      label: "engine-to-evidence ancestry check",
    })
  ).trim();
  if (mergeBase !== engineCommitSha)
    throw new Error("evidence commit is not a descendant of the immutable engine commit");
  const changed = await git(command, gitExecutable, root, temporaryRoot, {
    arguments_: [
      "-C",
      root,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      engineCommitSha,
      evidenceCommitSha,
    ],
    label: "engine-to-evidence path allowlist check",
  });
  const changedPaths = changed.split("\0").filter(Boolean);
  const rejected = changedPaths.filter((entry) => !evidenceOnlyPath(entry));
  if (rejected.length > 0)
    throw new Error(
      `evidence commit changes immutable engine/build inputs: ${rejected.join(", ")}`,
    );
  return Object.freeze({
    changedPaths: Object.freeze(changedPaths),
    engineCommitSha,
    evidenceCommitSha,
  });
}

export async function materializeEngineCommit({
  command = runBoundedCommand,
  commitSha,
  destination,
  gitExecutable,
  repositoryRoot,
  temporaryRoot,
  expectedGit,
  expectedTar,
  createConfinement = null,
}) {
  if (!path.isAbsolute(gitExecutable))
    throw new Error("engine materialization Git executable must be absolute");
  if (expectedGit !== undefined) await rehashReviewedExecutable(gitExecutable, expectedGit, "Git");
  if (expectedTar !== undefined)
    await rehashReviewedExecutable(expectedTar.path, expectedTar, "tar");
  const reviewedGitCommand = identityBoundCommand(command, gitExecutable, expectedGit, "Git");
  const inventory = await inspectCommitInventory({
    command: reviewedGitCommand,
    commitSha,
    gitExecutable,
    repositoryRoot,
    temporaryRoot,
  });
  const materializedRoot = path.join(destination, "engine-source");
  const archivePath = path.join(destination, "engine-source.tar");
  await mkdir(materializedRoot, { mode: 0o700 });
  const archived = await reviewedGitCommand(
    gitExecutable,
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.allow=never",
      "-c",
      "core.attributesFile=/dev/null",
      "-C",
      repositoryRoot,
      "archive",
      "--format=tar",
      commitSha,
    ],
    {
      cwd: repositoryRoot,
      environment: gitEnvironment(temporaryRoot),
      maximumStderrBytes: 64 * 1024,
      maximumStdoutBytes: MAXIMUM_SOURCE_BYTES + 16 * 1024 * 1024,
      stdoutEncoding: "buffer",
      timeoutMs: 120_000,
    },
  );
  if (archived.status !== 0 || archived.signal !== null)
    throw new Error("engine archive command failed");
  if (archived.stderr.length !== 0) throw new Error("engine archive emitted unexpected stderr");
  if (!Buffer.isBuffer(archived.stdout))
    throw new Error("engine archive command did not return bounded binary output");
  await writeFile(archivePath, archived.stdout, { flag: "wx", mode: 0o600 });
  const extractionConfinement =
    createConfinement === null ? null : await createConfinement(materializedRoot, "extract");
  if (expectedTar !== undefined)
    await rehashReviewedExecutable(expectedTar.path, expectedTar, "tar");
  await extractTarball(
    archivePath,
    materializedRoot,
    expectedTar?.path ?? "/usr/bin/bsdtar",
    false,
    extractionConfinement,
    tarEnvironment(temporaryRoot),
  );
  for (const entry of inventory.entries)
    await blobIdentity(materializedRoot, entry, inventory.objectFormat);
  if (expectedGit !== undefined) await rehashReviewedExecutable(gitExecutable, expectedGit, "Git");
  if (expectedTar !== undefined)
    await rehashReviewedExecutable(expectedTar.path, expectedTar, "tar");
  return Object.freeze({
    inventory,
    root: materializedRoot,
    sourcePaths: Object.freeze(inventory.entries.map((entry) => entry.path)),
  });
}

export function compareRebuiltEngineIdentity(expected, rebuilt) {
  const expectedIdentity = {
    knowledgeVersion: expected.knowledgeVersion,
    packageSha256: expected.packageSha256,
    ruleRegistrySha256: expected.ruleRegistrySha256,
    version: expected.version,
  };
  const rebuiltIdentity = {
    knowledgeVersion: rebuilt.knowledgeVersion,
    packageSha256: rebuilt.packageSha256,
    ruleRegistrySha256: rebuilt.ruleRegistrySha256,
    version: rebuilt.engineVersion,
  };
  if (canonicalJson(expectedIdentity) !== canonicalJson(rebuiltIdentity))
    throw new Error("clean rebuilt CLI/core bytes differ from the captured engine identity");
  return rebuiltIdentity;
}

async function extractRuntime(pack, replayRoot, createConfinement, expectedTar) {
  const runtimeRoot = path.join(replayRoot, "rebuilt-runtime");
  const cliExtraction = path.join(replayRoot, "cli-extraction");
  const coreExtraction = path.join(replayRoot, "core-extraction");
  await mkdir(runtimeRoot, { mode: 0o700 });
  await mkdir(cliExtraction, { mode: 0o700 });
  await mkdir(coreExtraction, { mode: 0o700 });
  const [cliConfinement, coreConfinement] = await Promise.all([
    createConfinement(cliExtraction, "extract"),
    createConfinement(coreExtraction, "extract"),
  ]);
  await rehashReviewedExecutable(expectedTar.path, expectedTar, "tar");
  await extractTarball(
    pack.cliFilename,
    cliExtraction,
    expectedTar.path,
    true,
    cliConfinement,
    tarEnvironment(replayRoot),
  );
  await rehashReviewedExecutable(expectedTar.path, expectedTar, "tar");
  await extractTarball(
    pack.coreFilename,
    coreExtraction,
    expectedTar.path,
    true,
    coreConfinement,
    tarEnvironment(replayRoot),
  );
  await rehashReviewedExecutable(expectedTar.path, expectedTar, "tar");
  await rename(path.join(cliExtraction, "package"), path.join(runtimeRoot, "cli"));
  await rename(path.join(coreExtraction, "package"), path.join(runtimeRoot, "core"));
  await chmod(runtimeRoot, 0o700);
  return runtimeRoot;
}

async function runReplayCommand(nodeExecutable, arguments_, cleanRoot, temporaryRoot, label) {
  const result = await runBoundedCommand(nodeExecutable, arguments_, {
    cwd: cleanRoot,
    environment: replayEnvironment(temporaryRoot, { allowWrites: true }),
    maximumStderrBytes: 1024 * 1024,
    maximumStdoutBytes: 1024 * 1024,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (result.status !== 0 || result.signal !== null)
    throw new Error(`${label} failed:\n${result.stderr || result.stdout}`);
  return result;
}

export async function replayFinalSource(
  {
    command = runBoundedCommand,
    engine,
    evidenceCommitSha,
    gitExecutable,
    nativeProof,
    nodeExecutable,
    regressionTests,
    repositoryRoot,
    seededCorpusBytes,
    seededReportBytes,
  },
  dependencies = {},
) {
  const inspectSource = dependencies.inspectSource ?? inspectExactSourceInventory;
  const createConfinement = dependencies.createConfinement ?? createDarwinConfinementFactory;
  const materializeSource = dependencies.materializeSource ?? materializeEngineCommit;
  const packRuntime = dependencies.packRuntime ?? packCleanCliAndCore;
  const extractRebuiltRuntime = dependencies.extractRuntime ?? extractRuntime;
  const inspectEngine = dependencies.inspectEngine ?? inspectPackedEngine;
  const executeReplayCommand = dependencies.runReplayCommand ?? runReplayCommand;
  const executeCommand = dependencies.runBoundedCommand ?? runBoundedCommand;
  const readArtifact = dependencies.readFile ?? readFile;
  const verifyRebuiltSources = dependencies.verifySourceSubset ?? verifySourceSubset;
  const replayRoot = await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-replay-"));
  await chmod(replayRoot, 0o700);
  try {
    if ((await realpath(nodeExecutable)) !== (await realpath(process.execPath)))
      throw new Error("K03 source replay must run under the captured Node executable");
    if (
      typeof process.env.npm_execpath !== "string" ||
      process.env.npm_execpath !== nativeProof?.tools?.pnpm?.path
    )
      throw new Error("K03 source replay requires the exact proof-bound pnpm launcher");
    await rehashReviewedExecutable(
      process.env.npm_execpath,
      nativeProof.tools.pnpm,
      "pnpm launcher",
    );
    const pnpm = await executeCommand(nodeExecutable, [process.env.npm_execpath, "--version"], {
      cwd: repositoryRoot,
      environment: replayEnvironment(replayRoot),
      maximumStderrBytes: 4096,
      maximumStdoutBytes: 4096,
      timeoutMs: 30_000,
    });
    if (
      pnpm.status !== 0 ||
      pnpm.signal !== null ||
      pnpm.stdout.trim() !== nativeProof.tools.pnpm.version
    )
      throw new Error("K03 source replay requires the proof-bound pnpm package identity");
    const before = await inspectSource({
      command,
      expectedCommitSha: evidenceCommitSha,
      gitExecutable,
      repositoryRoot,
      temporaryRoot: replayRoot,
    });
    const packRoot = path.join(replayRoot, "packs");
    await mkdir(packRoot, { mode: 0o700 });
    const createBuildConfinement = createConfinement({
      command,
      environment: replayEnvironment(replayRoot, {
        allowChildProcesses: true,
        allowWrites: true,
      }),
      nativeProof,
      nodeExecutable,
      temporaryRoot: replayRoot,
    });
    const materialized = await materializeSource({
      command,
      commitSha: engine.commitSha,
      destination: replayRoot,
      gitExecutable,
      repositoryRoot,
      temporaryRoot: replayRoot,
      expectedGit: engine.git,
      expectedTar: nativeProof.tools.tar,
      createConfinement: createBuildConfinement,
    });
    const pack = await packRuntime(packRoot, {
      environment: replayEnvironment(replayRoot, {
        allowChildProcesses: true,
        allowWrites: true,
      }),
      createConfinement: createBuildConfinement,
      gitExecutable,
      sourcePaths: materialized.sourcePaths,
      sourceRoot: materialized.root,
    });
    await verifyRebuiltSources(materialized.root, materialized.inventory, materialized.sourcePaths);
    await verifyRebuiltSources(pack.cleanRoot, materialized.inventory, pack.sourcePaths);
    await verifyRebuiltSources(
      pack.replayCleanRoot,
      materialized.inventory,
      pack.replaySourcePaths,
    );
    const after = await inspectSource({
      command,
      expectedCommitSha: evidenceCommitSha,
      gitExecutable,
      repositoryRoot,
      temporaryRoot: replayRoot,
    });
    if (before.sha256 !== after.sha256)
      throw new Error("final source inventory changed during clean rebuild replay");
    const runtimeRoot = await extractRebuiltRuntime(
      pack,
      replayRoot,
      createBuildConfinement,
      nativeProof.tools.tar,
    );
    const rebuilt = await inspectEngine(runtimeRoot, path.join(runtimeRoot, "cli/dist/cli.js"));
    compareRebuiltEngineIdentity(engine, rebuilt);

    const uniqueRegressions = [...new Set(regressionTests.map((entry) => entry.path))].sort(
      (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    if (uniqueRegressions.length > 0)
      await executeReplayCommand(
        nodeExecutable,
        ["--test", "--test-isolation=none", ...uniqueRegressions],
        pack.cleanRoot,
        replayRoot,
        "K03 tuning regression replay",
      );
    await executeReplayCommand(
      nodeExecutable,
      [
        "--experimental-strip-types",
        "--import",
        "./tools/seeded-recall/typescript-loader.mjs",
        "./tools/seeded-recall/run.mjs",
      ],
      pack.cleanRoot,
      replayRoot,
      "F16 seeded-recall replay",
    );
    const [cleanCorpus, cleanReport] = await Promise.all([
      readArtifact(path.join(pack.cleanRoot, "calibration/seeded-recall/v0/corpus.json")),
      readArtifact(path.join(pack.cleanRoot, "calibration/seeded-recall/v0/report.json")),
    ]);
    if (!cleanCorpus.equals(seededCorpusBytes) || !cleanReport.equals(seededReportBytes))
      throw new Error("clean F16 artifacts differ from the precision evidence bytes");
    await verifyRebuiltSources(materialized.root, materialized.inventory, materialized.sourcePaths);
    await verifyRebuiltSources(pack.cleanRoot, materialized.inventory, pack.sourcePaths);
    await verifyRebuiltSources(
      pack.replayCleanRoot,
      materialized.inventory,
      pack.replaySourcePaths,
    );
    return Object.freeze({
      packageSha256: rebuilt.packageSha256,
      sourceInventorySha256: materialized.inventory.sha256,
    });
  } finally {
    await rm(replayRoot, { force: true, recursive: true });
  }
}

export const _test = Object.freeze({ replayEnvironment, runReplayCommand });
