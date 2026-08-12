import assert from "node:assert/strict";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  MAX_TABLETOP_BYTES,
  assessTabletopEvidence,
  expectedScenarios,
  parseTabletopRecord,
  reviewSubjectSha256,
  tabletopRecordPath,
  validateTabletopRecord,
} from "./recovery-tabletop.mjs";
import {
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_GIT_OUTPUT_BYTES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILE_BYTES,
  MAX_TRACKED_FILES,
  OVERALL_DEADLINE_MS,
  assertContainmentSupported,
  assertConfinementConfiguration,
  assertRegularSourceStat,
  assertSourceStateStable,
  canonicalJson,
  collectSourceClosure,
  createDeadline,
  executionReceiptPath,
  executionReceiptSha256,
  guardSourceExecution,
  parseTapTests,
  probeExecutionContainment,
  runContainmentAdversary,
  runBounded,
  runContainmentCreateAdversary,
  sealApprovedExecutable,
  sha256,
  validateExecutionReceipt,
} from "./recovery-tabletop-receipt.mjs";
import {
  copyBoundedProjectSource,
  copyBoundedTree,
  createInputManifest,
  digest as runtimeInputDigest,
  verifyBaseDescriptors,
  verifyInputDirectory,
} from "./container/runtime-inputs.mjs";
import {
  PREPARATION_CONFIG_KEYS,
  PREPARATION_FORBIDDEN_HOST_CONFIG_KEYS,
  PREPARATION_HOST_CONFIG_KEYS,
  assertExactPreparationConfinement,
  normalizePreparationConfinement,
  withPreparationContainer,
} from "./preparation-container.mjs";
import {
  PreparationGitError,
  assertNoRepositoryHooks,
  createPreparationSourceSnapshot,
  isAbsentGitConfigValue,
} from "./preparation-source.mjs";
import {
  assertReviewedLockTransition,
  createBuildLockCandidate,
  createReviewedPreparationTransition,
  createRuntimeLockCandidate,
} from "./recovery-provenance-transition.mjs";

const record = parseTabletopRecord(await readFile(tabletopRecordPath));
const receipt = parseTabletopRecord(await readFile(executionReceiptPath));

function clone(value) {
  return structuredClone(value);
}

async function git(cwd, arguments_) {
  const child = spawn("/usr/bin/git", ["-C", cwd, ...arguments_], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "ignore",
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null });
}

function bindReceipt(targetRecord, targetReceipt) {
  const receiptDigest = executionReceiptSha256(targetReceipt);
  targetRecord.executionReceipt.sha256 = receiptDigest;
  targetRecord.executionReceipt.sourceClosureSha256 = targetReceipt.sourceClosure.sha256;
  targetRecord.review.executionReceiptSha256 = receiptDigest;
  targetRecord.review.sourceClosureSha256 = targetReceipt.sourceClosure.sha256;
}

function review(targetRecord) {
  targetRecord.review.reviewSubjectSha256 = reviewSubjectSha256(targetRecord);
}

function bind(targetRecord, targetReceipt) {
  bindReceipt(targetRecord, targetReceipt);
  review(targetRecord);
}

test("replays supported contained evidence while preserving the pending review decision", async () => {
  assert.deepEqual(validateExecutionReceipt(receipt), { issues: [], schemaValid: true });
  assert.deepEqual(validateTabletopRecord(record), { issues: [], schemaValid: true });
  const assessment = await assessTabletopEvidence(record, { executionReceipt: receipt });
  assert.equal(assessment.evidenceValid, false);
  assert.equal(assessment.releaseAccepted, false);
  assert.equal(assessment.sourceMatchesReceipt, false);
  assert.equal(assessment.verificationMode, "historical-attestation");
  assert.deepEqual(assessment.issues, ["current exercised source closure differs from receipt"]);
  assert.equal(receipt.captureStatus, "supported");
  assert.equal(receipt.containment.status, "supported");
  assert.equal(receipt.commands[0].tests.length, 24);
  assert.equal(receipt.commands[1].tests.length, 40);
  assert.equal(receipt.packageInventory.length, 4);
  assert.equal(receipt.toolchain.packageManager, "pnpm@11.18.0");
  assert.ok(receipt.commands.every((command) => !command.timedOut && command.signal === null));
});

test("bounds subprocess termination, source resources, and execution-time source stability", async () => {
  const timeout = await runBounded([process.execPath, "-e", "setTimeout(() => {}, 10_000)"], {
    maxOutputBytes: 1024,
    timeoutMs: 50,
  });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.exitCode, null);
  assert.equal(timeout.signal, "SIGKILL");
  assert.ok(timeout.durationMs < 2_000);
  const overflowStarted = Date.now();
  await assert.rejects(
    runBounded([process.execPath, "-e", "for (;;) process.stdout.write('xxxxxxxxxxxxxxxx')"], {
      maxOutputBytes: 1_024,
      timeoutMs: 5_000,
    }),
    /output exceeds/u,
  );
  assert.ok(Date.now() - overflowStarted < 2_000);
  await assert.rejects(
    runBounded([process.execPath, "-e", ""], { timeoutMs: OVERALL_DEADLINE_MS + 1 }),
    /subprocess bounds/u,
  );
  assert.deepEqual(
    [MAX_TRACKED_FILES, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_BYTES, MAX_GIT_OUTPUT_BYTES],
    [4_096, 4 * 1024 * 1024, 32 * 1024 * 1024, 4 * 1024 * 1024],
  );
  assert.equal(MAX_COMMAND_OUTPUT_BYTES, 16 * 1024 * 1024);
  const hostileGitEnvironment = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/forbidden/objects",
    GIT_CONFIG_GLOBAL: "/forbidden/config",
    GIT_DIR: "/forbidden/git-dir",
    GIT_INDEX_FILE: "/forbidden/index",
    GIT_OBJECT_DIRECTORY: "/forbidden/object-dir",
    GIT_WORK_TREE: "/forbidden/worktree",
  };
  const originalGitEnvironment = Object.fromEntries(
    Object.keys(hostileGitEnvironment).map((key) => [key, process.env[key]]),
  );
  const currentClosure = await collectSourceClosure();
  assert.notEqual(currentClosure.sha256, receipt.sourceClosure.sha256);
  try {
    Object.assign(process.env, hostileGitEnvironment);
    const sanitizedClosure = await collectSourceClosure();
    assert.equal(sanitizedClosure.sha256, currentClosure.sha256);
  } finally {
    for (const [key, value] of Object.entries(originalGitEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-hardlink-"));
  try {
    const source = path.join(fixture, "source");
    const alias = path.join(fixture, "alias");
    await writeFile(source, "proof", { flag: "wx" });
    await link(source, alias);
    const hardLinkStat = await lstat(source, { bigint: true });
    assert.throws(() => assertRegularSourceStat(hardLinkStat, "source"), /non-regular source/u);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
  for (const field of [
    "algorithm",
    "excludedPaths",
    "gitHead",
    "indexSha256",
    "sha256",
    "totalBytes",
    "trackedFileCount",
    "trackedInventorySha256",
    "untrackedFileCount",
    "workingMetadataSha256",
  ]) {
    const changed = clone(receipt.sourceClosure);
    changed[field] =
      typeof changed[field] === "number"
        ? changed[field] + 1
        : Array.isArray(changed[field])
          ? changed[field].slice(1)
          : "0".repeat(64);
    assert.throws(
      () => assertSourceStateStable(receipt.sourceClosure, changed),
      /source mutation/u,
    );
  }

  const descendantFixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-tree-"));
  try {
    const marker = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "fixtures/recovery-mutation-sentinel.txt",
    );
    const original = await readFile(marker);
    const containment = await probeExecutionContainment({ deadline: createDeadline(20_000) });
    if (containment.status === "supported") {
      assert.doesNotThrow(() => assertContainmentSupported(containment));
      await assert.rejects(
        runContainmentAdversary({ deadline: createDeadline(30_000) }),
        /output exceeds/u,
      );
      await delay(800);
      assert.deepEqual(await readFile(marker), original);
    } else {
      assert.ok(
        [
          "docker-client-unavailable",
          "docker-daemon-unavailable",
          "pinned-offline-runtime-unavailable",
          "pinned-runtime-inputs-unavailable",
          "platform-unsupported",
        ].includes(containment.reason),
      );
      assert.throws(
        () => assertContainmentSupported(containment),
        (error) => error.containment?.reason === containment.reason,
      );
    }
  } finally {
    await rm(descendantFixture, { force: true, recursive: true });
  }

  const executableFixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-sealed-"));
  try {
    const source = path.join(executableFixture, "candidate");
    const sealedDirectory = await mkdtemp(path.join(executableFixture, "sealed-"));
    const approvedBytes = await readFile("/usr/bin/true");
    const substitutedBytes = await readFile("/usr/bin/false");
    await writeFile(source, approvedBytes, { flag: "wx", mode: 0o500 });
    await chmod(source, 0o500);
    const sealed = await sealApprovedExecutable(
      "candidate",
      source,
      sha256(approvedBytes),
      sealedDirectory,
      createDeadline(10_000),
    );
    await chmod(source, 0o700);
    await writeFile(source, substitutedBytes);
    await writeFile(source, approvedBytes);
    const executed = await runBounded([sealed.path], { timeoutMs: 1_000 });
    assert.equal(executed.exitCode, 0);
    await sealed.assertUnchanged(createDeadline(10_000));
  } finally {
    await rm(executableFixture, { force: true, recursive: true });
  }

  const sentinel = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "fixtures/recovery-mutation-sentinel.txt",
  );
  const originalSentinel = await readFile(sentinel);
  try {
    await assert.rejects(
      guardSourceExecution(async () => {
        const script = `const fs=require("node:fs");const p=${JSON.stringify(sentinel)};const b=Buffer.from(${JSON.stringify(originalSentinel.toString("base64"))},"base64");fs.writeFileSync(p,"mutated during command");fs.writeFileSync(p,b)`;
        const result = await runBounded([process.execPath, "-e", script], { timeoutMs: 5_000 });
        assert.equal(result.exitCode, 0);
      }),
      /source mutation/u,
    );
  } finally {
    await writeFile(sentinel, originalSentinel);
  }
  await assert.rejects(collectSourceClosure({ deadline: createDeadline(1) }), /overall deadline/u);
});

test("preparation excludes its own outputs and bounds copied source", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-prepare-source-"));
  try {
    const source = path.join(fixture, "source");
    const destination = path.join(fixture, "destination");
    await mkdir(path.join(source, ".h13-runtime-inputs.prepare-loop/prepared/project"), {
      recursive: true,
    });
    await mkdir(path.join(source, ".h13-runtime-inputs"), { recursive: true });
    await mkdir(path.join(source, "node_modules"), { recursive: true });
    await writeFile(path.join(source, "kept"), "kept");
    await writeFile(
      path.join(source, ".h13-runtime-inputs.prepare-loop/prepared/project/recursive"),
      "excluded",
    );
    await writeFile(path.join(source, ".h13-runtime-inputs/cache"), "excluded");
    await writeFile(path.join(source, "node_modules/dependency"), "excluded");
    assert.deepEqual(await copyBoundedProjectSource(source, destination), {
      bytes: 4,
      directories: 1,
      files: 1,
    });
    assert.equal(await readFile(path.join(destination, "kept"), "utf8"), "kept");
    await assert.rejects(
      copyBoundedProjectSource(source, path.join(fixture, "bounded"), { maxFiles: 1, maxBytes: 3 }),
      /bounded inventory/u,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("verifies raw OCI descriptors and every prepared runtime input byte", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-provenance-"));
  try {
    const containerDirectory = fileURLToPath(new URL("./container/", import.meta.url));
    const buildLock = JSON.parse(
      await readFile(path.join(containerDirectory, "build-lock.v1.json"), "utf8"),
    );
    const descriptors = path.join(fixture, "descriptors");
    await mkdir(descriptors);
    for (const name of ["base-config.v1.json", "base-index.v1.json", "base-platform.v1.json"])
      await cp(path.join(containerDirectory, name), path.join(descriptors, name));
    await verifyBaseDescriptors(descriptors, buildLock.baseImage);
    await writeFile(path.join(descriptors, "base-index.v1.json"), "{}\n");
    await assert.rejects(
      verifyBaseDescriptors(descriptors, buildLock.baseImage),
      /base index bytes/u,
    );

    const inputs = path.join(fixture, "inputs");
    await mkdir(inputs);
    const pnpmBytes = Buffer.from("pinned-pnpm-fixture");
    const lockfileBytes = Buffer.from("lockfile-fixture");
    await writeFile(path.join(inputs, "pnpm-11.18.0.tgz"), pnpmBytes);
    await writeFile(path.join(inputs, "dependencies.v1.tar.gz"), "dependency-fixture");
    const manifest = await createInputManifest(inputs, lockfileBytes, pnpmBytes);
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
    await writeFile(path.join(inputs, "input-manifest.v1.json"), manifestBytes);
    const expectedPackageManager = {
      integrity: manifest.pnpm.integrity,
      shasum: manifest.pnpm.sha1,
    };
    const manifestDigest = runtimeInputDigest("sha256", manifestBytes);
    await verifyInputDirectory(inputs, manifestDigest, lockfileBytes, expectedPackageManager);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      verifyInputDirectory(inputs, manifestDigest, lockfileBytes, expectedPackageManager, {
        signal: cancelled.signal,
      }),
      /cancelled/u,
    );
    await assert.rejects(
      verifyInputDirectory(inputs, manifestDigest, lockfileBytes, {
        ...expectedPackageManager,
        shasum: "0".repeat(40),
      }),
      /integrity or shasum/u,
    );
    await writeFile(path.join(inputs, "dependencies.v1.tar.gz"), "tampered");
    await assert.rejects(
      verifyInputDirectory(inputs, manifestDigest, lockfileBytes, expectedPackageManager),
      /inventory differs/u,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("bounds prepared-input traversal and honors deadlines and cancellation", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-input-bounds-"));
  try {
    const source = path.join(fixture, "source");
    await mkdir(source);
    await writeFile(path.join(source, "large"), "12345");
    await assert.rejects(
      copyBoundedProjectSource(source, path.join(fixture, "large-copy"), { maxFileBytes: 4 }),
      /bounded inventory/u,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      copyBoundedProjectSource(source, path.join(fixture, "cancelled-copy"), {
        signal: controller.signal,
      }),
      /cancelled/u,
    );
    await assert.rejects(
      createInputManifest(source, Buffer.from("lock"), Buffer.from("pnpm"), {
        deadline: { expiresAt: performance.now() - 1 },
      }),
      /deadline/u,
    );
    const deep = path.join(source, "a", "b", "c");
    await mkdir(deep, { recursive: true });
    await assert.rejects(
      copyBoundedProjectSource(source, path.join(fixture, "deep-copy"), { maxDepth: 1 }),
      /directory bounds/u,
    );
    await assert.rejects(
      createInputManifest(source, Buffer.from("lock"), Buffer.from("pnpm"), { maxDepth: 1 }),
      /directory bounds/u,
    );
    await assert.rejects(
      copyBoundedTree(source, path.join(fixture, "tree-copy"), { maxBytes: 4 }),
      /bounded inventory/u,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("snapshots exact tracked index/worktree bytes and rejects untracked, ignored, and hook state", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-source-"));
  try {
    const repository = path.join(fixture, "repository");
    await mkdir(repository);
    await git(repository, ["init", "--initial-branch=main"]);
    await writeFile(path.join(repository, ".gitignore"), "ignored\n");
    await writeFile(path.join(repository, "tracked"), "one\n");
    await mkdir(path.join(repository, "nested"));
    await writeFile(path.join(repository, "nested/file"), "nested\n");
    await git(repository, ["add", ".gitignore", "tracked", "nested/file"]);
    await git(repository, [
      "-c",
      "user.name=H13",
      "-c",
      "user.email=h13@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const first = await createPreparationSourceSnapshot(
      repository,
      path.join(fixture, "snapshot-a"),
    );
    assert.equal(first.manifest.trackedFileCount, 3);
    assert.equal(await readFile(path.join(fixture, "snapshot-a", "tracked"), "utf8"), "one\n");
    await writeFile(path.join(repository, ".pnpmfile.cjs"), "module.exports = { hooks: {} };\n");
    await git(repository, ["add", ".pnpmfile.cjs"]);
    await assert.rejects(
      createPreparationSourceSnapshot(repository, path.join(fixture, "snapshot-pnpmfile")),
      /pnpm project hook file/u,
    );
    await git(repository, ["reset", "--hard", "HEAD"]);
    await writeFile(path.join(repository, "package.json"), '{"pnpm":{"pnpmfile":"./hook.cjs"}}\n');
    await git(repository, ["add", "package.json"]);
    await assert.rejects(
      createPreparationSourceSnapshot(repository, path.join(fixture, "snapshot-package-hook")),
      /package pnpm hook setting/u,
    );
    await git(repository, ["reset", "--hard", "HEAD"]);
    await writeFile(path.join(repository, ".npmrc"), "pnpmfile=./hook.cjs\n");
    await git(repository, ["add", ".npmrc"]);
    await assert.rejects(
      createPreparationSourceSnapshot(repository, path.join(fixture, "snapshot-config-hook")),
      /pnpm hook configuration/u,
    );
    await git(repository, ["reset", "--hard", "HEAD"]);
    await writeFile(path.join(repository, "untracked"), "refuse");
    await assert.rejects(
      createPreparationSourceSnapshot(repository, path.join(fixture, "snapshot-b")),
      /untracked/u,
    );
    await rm(path.join(repository, "untracked"));
    await writeFile(path.join(repository, "ignored"), "refuse");
    await assert.rejects(
      createPreparationSourceSnapshot(repository, path.join(fixture, "snapshot-c")),
      /ignored/u,
    );
    await rm(path.join(repository, "ignored"));
    await rm(path.join(repository, "nested"), { recursive: true });
    await mkdir(path.join(fixture, "external"));
    await writeFile(path.join(fixture, "external/file"), "nested\n");
    await symlink(path.join(fixture, "external"), path.join(repository, "nested"));
    await assert.rejects(
      createPreparationSourceSnapshot(repository, path.join(fixture, "snapshot-d")),
      /untracked|directory ancestry/u,
    );
    await git(repository, ["config", "core.hooksPath", ".hooks"]);
    await assert.rejects(
      createPreparationSourceSnapshot(repository, path.join(fixture, "snapshot-e")),
      /hooksPath/u,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test("accepts only exact Git absent-config status and propagates every other query failure", async () => {
  const absent = new PreparationGitError("absent", {
    exitCode: 1,
    outputExceeded: false,
    signal: null,
    timedOut: false,
  });
  assert.equal(isAbsentGitConfigValue(absent), true);
  for (const mutation of [
    { exitCode: 2 },
    { outputExceeded: true },
    { signal: "SIGKILL" },
    { timedOut: true },
  ]) {
    const failure = new PreparationGitError("failed", {
      exitCode: 1,
      outputExceeded: false,
      signal: null,
      timedOut: false,
      ...mutation,
    });
    assert.equal(isAbsentGitConfigValue(failure), false);
    await assert.rejects(
      assertNoRepositoryHooks("/unreached", performance.now() + 1_000, async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
  }
  assert.equal(isAbsentGitConfigValue(new Error("lookalike Git query failed")), false);
});

test("requires two identical reviewed preparations and an exact build/runtime lock transition", () => {
  const sourceManifest = { recordKind: "source", rows: [{ path: "a", sha256: "a".repeat(64) }] };
  const sourceSha256 = runtimeInputDigest(
    "sha256",
    Buffer.from(`${canonicalJson(sourceManifest)}\n`),
  );
  const inputManifest = {
    preparationSourceManifestSha256: sourceSha256,
    recordKind: "inputs",
  };
  const review = createReviewedPreparationTransition({
    first: { inputManifest, sourceManifest },
    second: { inputManifest: clone(inputManifest), sourceManifest: clone(sourceManifest) },
    reviewedAt: "2026-08-10T12:00:00Z",
    reviewerId: "jakub-niezgoda",
  });
  const build = createBuildLockCandidate(
    { buildInputs: { manifestSha256: "0".repeat(64) }, recordKind: "build" },
    review,
  );
  assert.throws(
    () =>
      createBuildLockCandidate(
        { buildInputs: { manifestSha256: "0".repeat(64) }, recordKind: "build" },
        review,
        { predecessorBuildLockSha256: "not-a-digest" },
      ),
    /predecessor build lock/u,
  );
  const runtime = createRuntimeLockCandidate(
    { buildInputs: {}, recordKind: "runtime", runtimeImage: {} },
    build,
    { configurationDigest: `sha256:${"b".repeat(64)}` },
  );
  assert.equal(assertReviewedLockTransition(build, runtime).state, "reviewed-lock-pair");
  const changedRuntime = clone(runtime);
  changedRuntime.buildInputs.preparationSourceManifestSha256 = "c".repeat(64);
  assert.throws(() => assertReviewedLockTransition(build, changedRuntime), /reviewed transition/u);
  const changedInput = clone(inputManifest);
  changedInput.extra = true;
  assert.throws(
    () =>
      createReviewedPreparationTransition({
        first: { inputManifest, sourceManifest },
        second: { inputManifest: changedInput, sourceManifest },
        reviewedAt: "2026-08-10T12:00:00Z",
        reviewerId: "jakub-niezgoda",
      }),
    /different input manifests/u,
  );
});

test("rejects every Env, User, Tmpfs, and HostConfig confinement mutation", () => {
  const container = {
    Config: {
      ArgsEscaped: false,
      AttachStderr: true,
      AttachStdin: false,
      AttachStdout: true,
      Cmd: ["command"],
      Domainname: "",
      Entrypoint: ["/node"],
      Env: ["PATH=/usr/bin"],
      ExposedPorts: null,
      Healthcheck: null,
      Hostname: "aaaaaaaaaaaa",
      Image: "node@sha256:locked",
      Labels: {
        "agent-context.h13.preparation": "agent-context-linter",
        "agent-context.h13.preparation-nonce": "1".repeat(32),
      },
      MacAddress: "",
      NetworkDisabled: false,
      OnBuild: null,
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      User: "",
      Shell: null,
      StopSignal: "",
      StopTimeout: null,
      Volumes: null,
      WorkingDir: "",
    },
    HostConfig: {
      Annotations: null,
      AutoRemove: false,
      Binds: null,
      BlkioDeviceReadBps: [],
      BlkioDeviceReadIOps: [],
      BlkioDeviceWriteBps: [],
      BlkioDeviceWriteIOps: [],
      BlkioWeight: 0,
      BlkioWeightDevice: [],
      CapAdd: null,
      CapDrop: ["ALL"],
      CgroupnsMode: "private",
      Cgroup: "",
      CgroupParent: "",
      ConsoleSize: [0, 0],
      ContainerIDFile: "",
      CpuCount: 0,
      CpuPercent: 0,
      CpuPeriod: 0,
      CpuQuota: 0,
      CpuRealtimePeriod: 0,
      CpuRealtimeRuntime: 0,
      CpuShares: 0,
      CpusetCpus: "",
      CpusetMems: "",
      DeviceCgroupRules: null,
      DeviceRequests: null,
      Devices: [],
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: null,
      GroupAdd: null,
      IOMaximumBandwidth: 0,
      IOMaximumIOps: 0,
      Init: true,
      IpcMode: "none",
      Isolation: "",
      Links: null,
      LogConfig: { Config: {}, Type: "json-file" },
      MaskedPaths: ["/proc/kcore"],
      Memory: 4_294_967_296,
      MemoryReservation: 0,
      MemorySwap: 4_294_967_296,
      MemorySwappiness: null,
      Mounts: [
        {
          Consistency: "",
          ReadOnly: true,
          Source: "/source",
          Target: "/input",
          Type: "bind",
        },
      ],
      NanoCpus: 2_000_000_000,
      NetworkMode: "none",
      OomKillDisable: null,
      OomScoreAdj: 0,
      PidMode: "",
      PidsLimit: 128,
      Privileged: false,
      PortBindings: {},
      PublishAllPorts: false,
      ReadonlyRootfs: true,
      ReadonlyPaths: ["/proc/sys"],
      RestartPolicy: { MaximumRetryCount: 0, Name: "no" },
      Runtime: "runc",
      SecurityOpt: ["no-new-privileges=true"],
      ShmSize: 67_108_864,
      StorageOpt: {},
      Sysctls: null,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=536870912,mode=0700" },
      Ulimits: null,
      UsernsMode: "",
      UTSMode: "",
      VolumeDriver: "",
      VolumesFrom: null,
    },
    Mounts: [{ Destination: "/input", RW: false, Source: "/source", Type: "bind" }],
    State: { Pid: 0, Running: false },
  };
  assert.deepEqual(Object.keys(container.Config).sort(), PREPARATION_CONFIG_KEYS);
  assert.deepEqual(Object.keys(container.HostConfig).sort(), PREPARATION_HOST_CONFIG_KEYS);
  for (const forbidden of PREPARATION_FORBIDDEN_HOST_CONFIG_KEYS) {
    const forbiddenMutation = clone(container);
    forbiddenMutation.HostConfig[forbidden] = 1;
    assert.throws(
      () => normalizePreparationConfinement(forbiddenMutation),
      /keys differ from Docker 29\.5\.2 contract/u,
      forbidden,
    );
  }
  const expected = normalizePreparationConfinement(container);
  assert.deepEqual(Object.keys(expected.hostConfig).sort(), PREPARATION_HOST_CONFIG_KEYS);
  const deviceMutation = clone(container);
  deviceMutation.HostConfig.Devices = [{ PathOnHost: "/dev/mem" }];
  assert.throws(
    () =>
      assertExactPreparationConfinement(normalizePreparationConfinement(deviceMutation), expected),
    /confinement policy/u,
  );
  const logEgressMutation = clone(container);
  logEgressMutation.HostConfig.LogConfig = {
    Config: { "syslog-address": "tcp://198.51.100.10:514" },
    Type: "syslog",
  };
  assert.throws(
    () =>
      assertExactPreparationConfinement(
        normalizePreparationConfinement(logEgressMutation),
        expected,
      ),
    /confinement policy/u,
  );
  for (const ownerKey of ["Config", "HostConfig"])
    for (const field of Object.keys(container[ownerKey])) {
      const rawMutation = clone(container);
      const current = rawMutation[ownerKey][field];
      rawMutation[ownerKey][field] =
        typeof current === "boolean"
          ? !current
          : typeof current === "number"
            ? current + 1
            : current === null
              ? "unexpected"
              : Array.isArray(current)
                ? [...current, "unexpected"]
                : { unexpected: true };
      assert.throws(
        () =>
          assertExactPreparationConfinement(normalizePreparationConfinement(rawMutation), expected),
        /confinement policy/u,
        `${ownerKey}.${field}`,
      );
    }
  for (const ownerKey of ["Config", "HostConfig"])
    for (const mode of ["missing", "unknown"]) {
      const rawMutation = clone(container);
      if (mode === "missing") delete rawMutation[ownerKey][Object.keys(rawMutation[ownerKey])[0]];
      else rawMutation[ownerKey].UnexpectedField = true;
      assert.throws(
        () => normalizePreparationConfinement(rawMutation),
        /keys differ from Docker 29\.5\.2 contract/u,
        `${ownerKey}.${mode}`,
      );
    }
  assert.doesNotThrow(() => assertExactPreparationConfinement(expected, clone(expected)));
  const leafPaths = [];
  const visit = (value, path_) => {
    if (value !== null && typeof value === "object")
      for (const [key, child] of Object.entries(value)) visit(child, [...path_, key]);
    else leafPaths.push(path_);
  };
  visit(expected, []);
  for (const path_ of leafPaths) {
    const changed = clone(expected);
    let owner = changed;
    for (const key of path_.slice(0, -1)) owner = owner[key];
    const key = path_.at(-1);
    const current = owner[key];
    owner[key] =
      typeof current === "boolean"
        ? !current
        : typeof current === "number"
          ? current + 1
          : `${current}-changed`;
    assert.throws(
      () => assertExactPreparationConfinement(changed, expected),
      /confinement policy/u,
    );
  }
});

test("reconciles and removes preparation containers after hostile Docker outcomes", async () => {
  const identity = "a".repeat(64);
  for (const [modeIndex, mode] of [
    "malformed-stdout",
    "lost-transport",
    "start-timeout",
  ].entries()) {
    let exists = false;
    let removed = false;
    let nonce;
    let name;
    let createArguments;
    const invoke = async (arguments_) => {
      if (arguments_[0] === "container" && arguments_[1] === "create") {
        createArguments = arguments_;
        name = arguments_[arguments_.indexOf("--name") + 1];
        nonce =
          arguments_[
            arguments_.findIndex((value) =>
              value.startsWith("agent-context.h13.preparation-nonce="),
            )
          ].split("=")[1];
        exists = true;
        if (mode === "lost-transport") throw new Error("lost transport");
        return {
          code: 0,
          signal: null,
          timedOut: false,
          stdout: mode === "malformed-stdout" ? "hostile" : identity,
        };
      }
      if (arguments_[0] === "container" && arguments_[1] === "list")
        return { code: 0, signal: null, timedOut: false, stdout: exists ? identity : "" };
      if (arguments_[0] === "container" && arguments_[1] === "inspect")
        return {
          code: 0,
          signal: null,
          timedOut: false,
          stdout: JSON.stringify({
            Config: {
              Image: "node@sha256:locked",
              Labels: {
                "agent-context.h13.preparation": "agent-context-linter",
                "agent-context.h13.preparation-nonce": nonce,
              },
            },
            Id: identity,
            Name: `/${name}`,
          }),
        };
      if (arguments_[0] === "container" && arguments_[1] === "rm") {
        exists = false;
        removed = true;
        return { code: 0, signal: null, timedOut: false, stdout: identity };
      }
      throw new Error(`unexpected Docker invocation: ${arguments_.join(" ")}`);
    };
    await assert.rejects(
      withPreparationContainer({
        createArguments: [],
        deadline: performance.now() + 10_000,
        image: "node@sha256:locked",
        invoke,
        namePrefix: "agent-context-h13-test",
        nonce: `${modeIndex + 1}`.repeat(32),
        operation: async () => {
          if (mode === "start-timeout") throw new Error("Docker client timed out");
        },
      }),
      /identity|transport|timed out/u,
    );
    assert.equal(exists, false);
    assert.equal(removed, true);
    assert.ok(createArguments.includes(`agent-context.h13.preparation-nonce=${nonce}`));
    assert.ok(createArguments.includes("agent-context.h13.preparation=agent-context-linter"));
  }
  await assert.rejects(
    withPreparationContainer({
      createArguments: [],
      deadline: performance.now() + 1_000,
      image: "node@sha256:locked",
      invoke: async () => assert.fail("invalid identity reached Docker"),
      namePrefix: "hostile/name",
      nonce: "not-random",
      operation: async () => {},
    }),
    /identity input/u,
  );
});

test("keeps repository bytes and lifecycle hooks out of networked preparation", async () => {
  const standardsDirectory = fileURLToPath(new URL("./", import.meta.url));
  const preparationContainerDirectory = path.join(standardsDirectory, "container");
  const hostSource = await readFile(
    path.join(standardsDirectory, "prepare-recovery-runtime.mjs"),
    "utf8",
  );
  const networkSource = await readFile(
    path.join(preparationContainerDirectory, "prepare-network-inside.mjs"),
    "utf8",
  );
  const offlineSource = await readFile(
    path.join(preparationContainerDirectory, "prepare-runtime-inside.mjs"),
    "utf8",
  );
  const networkTransaction = hostSource.slice(
    hostSource.indexOf('namePrefix: "agent-context-h13-network"') - 1_500,
    hostSource.indexOf('namePrefix: "agent-context-h13-network"') + 200,
  );
  assert.match(networkTransaction, /src=\$\{networkInput\},dst=\/network-input,readonly/u);
  assert.doesNotMatch(networkTransaction, /src=\$\{root\},dst=\/input/u);
  assert.doesNotMatch(hostSource, /await run\(\[\s*"run"/u);
  for (const requiredControl of [
    '"--pids-limit"',
    '"--memory"',
    '"--memory-swap"',
    '"--cpus"',
    '"--cap-drop"',
    '"no-new-privileges=true"',
  ])
    assert.ok(hostSource.includes(requiredControl));
  assert.match(networkSource, /--ignore-scripts/u);
  assert.match(networkSource, /--config\.ignore-pnpmfile=true/u);
  assert.match(networkSource, /--config\.global-pnpmfile=\/dev\/null/u);
  assert.match(networkSource, /pnpm_config_ignore_pnpmfile: "true"/u);
  assert.match(networkSource, /--no-runtime/u);
  assert.match(networkSource, /const fetchProject = path\.join\(output, "fetch-project"\)/u);
  assert.match(networkSource, /writeFile\(path\.join\(fetchProject, "pnpm-lock\.yaml"\)/u);
  assert.match(networkSource, /https:\/\/registry\.npmjs\.org\//u);
  assert.doesNotMatch(networkSource, /\/input\/tools|copyBoundedProjectSource/u);
  assert.match(offlineSource, /"--offline"/u);
  assert.match(offlineSource, /"--ignore-scripts"/u);
  assert.match(offlineSource, /"--config\.ignore-pnpmfile=true"/u);
  assert.match(offlineSource, /"--config\.global-pnpmfile=\/dev\/null"/u);
  assert.match(offlineSource, /pnpm_config_ignore_pnpmfile: "true"/u);
  assert.match(offlineSource, /"--no-runtime"/u);
  assert.doesNotMatch(offlineSource, /"rebuild"|node:https|https\.get/u);
});

test("binds every inspected confinement field and reconciles hostile create outcomes", async () => {
  const leafPaths = [];
  const visit = (value, path_) => {
    if (value !== null && typeof value === "object")
      for (const [key, child] of Object.entries(value)) visit(child, [...path_, key]);
    else leafPaths.push(path_);
  };
  visit(receipt.containment.configuration, []);
  assert.ok(leafPaths.length > 30);
  for (const leafPath of leafPaths) {
    const changedConfiguration = clone(receipt.containment.configuration);
    let owner = changedConfiguration;
    for (const key of leafPath.slice(0, -1)) owner = owner[key];
    const key = leafPath.at(-1);
    const current = owner[key];
    owner[key] =
      typeof current === "boolean"
        ? !current
        : typeof current === "number"
          ? current + 1
          : current === null
            ? "changed"
            : `${current}-changed`;
    assert.throws(
      () => assertConfinementConfiguration(changedConfiguration),
      /confinement configuration/u,
    );
    const changedReceipt = clone(receipt);
    changedReceipt.containment.configuration = changedConfiguration;
    changedReceipt.containment.configurationSha256 = sha256(
      Buffer.from(canonicalJson(changedConfiguration), "utf8"),
    );
    assert.match(validateExecutionReceipt(changedReceipt).issues.join("\n"), /confinement/u);
  }
  const runtimeLeafPaths = [];
  const visitRuntime = (value, path_) => {
    if (value !== null && typeof value === "object")
      for (const [key, child] of Object.entries(value)) visitRuntime(child, [...path_, key]);
    else runtimeLeafPaths.push(path_);
  };
  visitRuntime(receipt.containment.runtimeImage, []);
  assert.ok(runtimeLeafPaths.length >= 14);
  for (const leafPath of runtimeLeafPaths) {
    const changedReceipt = clone(receipt);
    let owner = changedReceipt.containment.runtimeImage;
    for (const key of leafPath.slice(0, -1)) owner = owner[key];
    const key = leafPath.at(-1);
    const current = owner[key];
    owner[key] = typeof current === "number" ? current + 1 : `${current}-changed`;
    assert.notEqual(validateExecutionReceipt(changedReceipt).issues.length, 0);
  }
  const containment = await probeExecutionContainment({ deadline: createDeadline(20_000) });
  if (containment.status === "supported") {
    for (const mode of ["malformed-stdout", "transport-error", "timeout"])
      await assert.rejects(
        runContainmentCreateAdversary(mode, { deadline: createDeadline(30_000) }),
        /create|transport|container identity|subprocess/u,
      );
  } else {
    for (const mode of ["malformed-stdout", "transport-error", "timeout"])
      await assert.rejects(
        runContainmentCreateAdversary(mode, { deadline: createDeadline(30_000) }),
        (error) => error.containment?.reason === containment.reason,
      );
  }
});

test("rejects every individual normative action and scenario evidence substitution", () => {
  for (const [scenarioIndex, scenario] of expectedScenarios.entries()) {
    for (let actionIndex = 0; actionIndex < scenario.actions.length; actionIndex += 1) {
      const changed = clone(record);
      changed.scenarios[scenarioIndex].actions.splice(actionIndex, 1);
      assert.match(validateTabletopRecord(changed).issues.join("\n"), /normative action/u);
    }
    for (const field of ["expected", "inject", "observed", "outcome"]) {
      const changed = clone(record);
      changed.scenarios[scenarioIndex][field] = field === "outcome" ? "failed" : "substituted";
      assert.match(validateTabletopRecord(changed).issues.join("\n"), /scenario inject/u);
    }
  }
});

test("rejects test, result, package, toolchain, exit, source, and reviewer receipt substitutions", async () => {
  assert.deepEqual(parseTapTests("TAP version 13\n# Subtest: proof\nok 1 - proof\n"), [
    { identity: "proof", outcome: "passed" },
  ]);
  for (const invalidTap of [
    "# Subtest: proof\nnot ok 1 - proof\n",
    "# Subtest: proof\nok 1 - proof # SKIP unavailable\n",
    "# Subtest: proof\nok 1 - proof # TODO later\n",
    "# Subtest: proof\nBail out! unavailable\n",
    "# Subtest: proof\n",
  ])
    assert.throws(() => parseTapTests(invalidTap), /execution receipt/u);

  const mutations = [
    (value) => {
      value.commands[0].tests[0].identity = "substituted";
    },
    (value) => {
      value.commands[0].argv[1] = "forged-runner.mjs";
    },
    (value) => {
      value.commands[0].tests[0].outcome = "failed";
    },
    (value) => {
      value.commands[1].tests.splice(0, 1);
    },
    (value) => {
      value.packageInventory[0].files += 1;
    },
    (value) => {
      value.toolchain.node = "24.18.2";
    },
    (value) => {
      value.commands[2].exitCode = 1;
      value.overallExitCode = 1;
    },
    (value) => {
      value.commands[0].timedOut = true;
      value.commands[0].exitCode = null;
      value.commands[0].signal = "SIGKILL";
      value.overallExitCode = 1;
    },
    (value) => {
      value.commands[0].durationMs = value.commands[0].deadlineMs + 1_001;
    },
    (value) => {
      value.commands[0].deadlineMs = 300_000;
    },
    (value) => {
      value.durationMs += 10_000;
    },
    (value) => {
      value.packageInventory[3] = clone(value.packageInventory[0]);
    },
    (value) => {
      value.sourceClosure.sha256 = "0".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const changedReceipt = clone(receipt);
    mutate(changedReceipt);
    const unbound = await assessTabletopEvidence(record, { executionReceipt: changedReceipt });
    assert.equal(unbound.releaseAccepted, false);
    assert.notEqual(unbound.issues.length, 0);
  }

  const reboundSource = clone(receipt);
  reboundSource.sourceClosure.sha256 = "0".repeat(64);
  const reboundRecord = clone(record);
  bindReceipt(reboundRecord, reboundSource);
  assert.match(validateTabletopRecord(reboundRecord).issues.join("\n"), /review subject/u);
  review(reboundRecord);
  const sourceResult = await assessTabletopEvidence(reboundRecord, {
    executionReceipt: reboundSource,
  });
  assert.equal(sourceResult.releaseAccepted, false);
  assert.match(sourceResult.issues.join("\n"), /source closure/u);

  const reboundBase = clone(receipt);
  reboundBase.sourceClosure.gitHead = "0".repeat(40);
  const reboundBaseRecord = clone(record);
  bind(reboundBaseRecord, reboundBase);
  const baseResult = await assessTabletopEvidence(reboundBaseRecord, {
    executionReceipt: reboundBase,
  });
  assert.equal(baseResult.releaseAccepted, false);
  assert.match(baseResult.issues.join("\n"), /source closure/u);

  const failedReceipt = clone(receipt);
  failedReceipt.commands[2].exitCode = 1;
  failedReceipt.overallExitCode = 1;
  const failedRecord = clone(record);
  bind(failedRecord, failedReceipt);
  const failedAssessment = await assessTabletopEvidence(failedRecord, {
    executionReceipt: failedReceipt,
  });
  assert.equal(validateExecutionReceipt(failedReceipt).schemaValid, true);
  assert.equal(failedAssessment.releaseAccepted, false);
  assert.match(failedAssessment.issues.join("\n"), /failed command/u);

  const fullyReboundForgery = clone(receipt);
  fullyReboundForgery.commands[0].tests = fullyReboundForgery.commands[0].tests.map(
    (entry, index) => ({ ...entry, identity: `forged TUF identity ${index}` }),
  );
  fullyReboundForgery.commands[1].tests = fullyReboundForgery.commands[1].tests.map(
    (entry, index) => ({ ...entry, identity: `forged standards identity ${index}` }),
  );
  fullyReboundForgery.commands[0].argv[1] = "forged-runner.mjs";
  fullyReboundForgery.packageInventory[0].files += 1;
  const fullyReboundRecord = clone(record);
  bind(fullyReboundRecord, fullyReboundForgery);
  const forgedAssessment = await assessTabletopEvidence(fullyReboundRecord, {
    executionReceipt: fullyReboundForgery,
  });
  assert.equal(forgedAssessment.releaseAccepted, false);
  assert.match(forgedAssessment.issues.join("\n"), /accountable|exact/u);

  const missingReceiptField = clone(receipt);
  delete missingReceiptField.toolchain.vitest;
  assert.equal(validateExecutionReceipt(missingReceiptField).schemaValid, false);

  const reviewer = clone(record);
  reviewer.review.reviewedAt = "2026-08-09T20:30:01Z";
  assert.match(validateTabletopRecord(reviewer).issues.join("\n"), /review subject/u);
  const reviewerIdentity = clone(record);
  reviewerIdentity.review.reviewerId = "substitute";
  assert.equal(validateTabletopRecord(reviewerIdentity).schemaValid, false);
});

test("keeps P0-P3 open and rejected records valid but never release accepted", async () => {
  for (const severity of ["P0", "P1", "P2", "P3"]) {
    const changed = clone(record);
    changed.findings.push({
      foundAt: "2026-08-09T20:31:00Z",
      id: `H13-90${severity.slice(1)}`,
      owner: "jakub-niezgoda",
      resolution: null,
      resolvedAt: null,
      severity,
      status: "open",
      summary: `${severity} exercise finding remains open.`,
      targetDate: "2026-08-10",
      targetMilestone: "G5",
    });
    review(changed);
    assert.equal(validateTabletopRecord(changed).schemaValid, true);
    const assessment = await assessTabletopEvidence(changed, { executionReceipt: receipt });
    assert.equal(assessment.evidenceValid, false);
    assert.equal(assessment.releaseAccepted, false);
    assert.ok(assessment.issues.includes("current exercised source closure differs from receipt"));
  }

  const rejected = clone(record);
  rejected.review.decision = "rejected";
  rejected.releaseAcceptance.decision = "rejected";
  review(rejected);
  const rejectedAssessment = await assessTabletopEvidence(rejected, { executionReceipt: receipt });
  assert.equal(rejectedAssessment.evidenceValid, false);
  assert.equal(rejectedAssessment.releaseAccepted, false);
});

test("binds the complete reviewed subject and enforces review chronology", async () => {
  for (const field of Object.keys(record.findings[0])) {
    const changed = clone(record);
    const current = changed.findings[0][field];
    changed.findings[0][field] =
      typeof current === "string" ? `${current} changed` : current === null ? "changed" : null;
    assert.notEqual(reviewSubjectSha256(changed), record.review.reviewSubjectSha256);
  }
  const mutations = [
    (value) => {
      value.executionReceipt.sourceClosureSha256 = "0".repeat(64);
    },
    (value) => {
      value.scenarios[0].observed += " changed";
    },
    (value) => {
      value.findings[0].summary += " changed";
    },
    (value) => {
      value.findings[0].resolution += " changed";
    },
    (value) => {
      value.findings[0].targetMilestone = "G6";
    },
    (value) => {
      value.releaseAcceptance.decision = "accepted";
    },
    (value) => {
      value.review.decision = "accepted";
    },
  ];
  for (const mutate of mutations) {
    const changed = clone(record);
    mutate(changed);
    assert.match(validateTabletopRecord(changed).issues.join("\n"), /review subject/u);
  }

  const backdatedFindingReview = clone(record);
  backdatedFindingReview.review.reviewedAt = backdatedFindingReview.findings.at(-1).resolvedAt;
  review(backdatedFindingReview);
  assert.match(validateTabletopRecord(backdatedFindingReview).issues.join("\n"), /must precede/u);

  const backdatedCaptureReview = clone(record);
  backdatedCaptureReview.review.reviewedAt = receipt.capturedAt;
  review(backdatedCaptureReview);
  const backdatedAssessment = await assessTabletopEvidence(backdatedCaptureReview, {
    executionReceipt: receipt,
  });
  assert.equal(backdatedAssessment.releaseAccepted, false);
  assert.match(backdatedAssessment.issues.join("\n"), /follow completed evidence capture/u);

  const rebound = clone(record);
  const changedReceipt = clone(receipt);
  changedReceipt.toolchain.vitest = "4.1.11";
  bindReceipt(rebound, changedReceipt);
  assert.match(validateTabletopRecord(rebound).issues.join("\n"), /review subject/u);

  const probeFailure = await assessTabletopEvidence(record, {
    executionReceipt: receipt,
    toolchainProbe() {
      throw new Error("bounded probe unavailable");
    },
  });
  assert.equal(probeFailure.releaseAccepted, false);
  assert.equal(probeFailure.runtimeMatchesReceipt, false);
  assert.equal(
    probeFailure.runtimeProbeIssue,
    "current toolchain probe failed within its bounded contract",
  );
});

test("rejects invalid finding chronology, duplicates, state contradictions, and missing fields", () => {
  const chronology = clone(record);
  chronology.findings[0].resolvedAt = "2026-08-09T19:00:00Z";
  assert.match(validateTabletopRecord(chronology).issues.join("\n"), /chronology/u);

  const duplicate = clone(record);
  duplicate.findings.push(clone(duplicate.findings[0]));
  assert.match(validateTabletopRecord(duplicate).issues.join("\n"), /unique/u);

  const contradiction = clone(record);
  contradiction.findings[0].status = "open";
  assert.match(validateTabletopRecord(contradiction).issues.join("\n"), /must not claim/u);

  const missing = clone(record);
  delete missing.findings[0].owner;
  assert.equal(validateTabletopRecord(missing).schemaValid, false);
});

test("rejects malformed, duplicate-key, non-UTF-8, marked, empty, and oversized input", () => {
  for (const input of [
    Buffer.from("{"),
    Buffer.from([0xff, 0xff]),
    Buffer.from("\ufeff{}"),
    Buffer.from('{"x":"\0"}'),
    Buffer.from('{"x":1,"x":2}'),
    Buffer.alloc(0),
    Buffer.alloc(MAX_TABLETOP_BYTES + 1, 0x20),
  ])
    assert.throws(() => parseTabletopRecord(input), /tabletop record/u);
  assert.throws(() => parseTabletopRecord("{}"), /must be bytes/u);
});
