import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkoutPinnedRepository,
  cleanupCapturedCalibration,
  cleanupIssuedQuotaVolumes,
  createPrivateReviewPublicationGuard,
  executeCalibration,
  inspectPackedEngine,
  inspectHdiutilIdentity,
  inspectCaptureRuntime,
  inspectExecutableIdentity,
  inspectGitRuntime,
  invokePackedCalibrationScan,
  publishPrivateReview,
  publishCapturedCalibration,
  runBoundedCommand,
  validateSandboxPolicyText,
  validateCapturePaths,
  verifyCaptureRuntime,
  verifyFrozenCheckout,
  verifyGitRuntimeIdentity,
  verifyOsReadConfinement,
} from "./execute.mjs";

test("hdiutil identity inspection rejects every substituted executable path", async () => {
  await assert.rejects(
    inspectHdiutilIdentity("/tmp/substituted-hdiutil", async () => ({
      signal: null,
      status: 0,
      stderr: "Usage: fixture",
      stdout: "",
    })),
    /exact \/usr\/bin\/hdiutil/u,
  );
});

test("executable identity inspection rehashes after the actual operation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "precision-executable-postflight-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const executable = path.join(root, "fixture-tool");
  await writeFile(executable, "#!/bin/sh\necho fixture\n", { mode: 0o700 });
  await assert.rejects(
    inspectExecutableIdentity(executable, "fixture executable", ["--version"], async () => {
      await writeFile(executable, "#!/bin/sh\necho changed\n", { mode: 0o700 });
      return { signal: null, status: 0, stderr: "", stdout: "fixture\n" };
    }),
    /changed during execution/u,
  );
});

test("Git HTTPS runtime binds the exec-path link and exact helper target", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "precision-git-runtime-")));
  t.after(() => rm(root, { force: true, recursive: true }));
  const git = path.join(root, "git");
  const execPath = path.join(root, "git-core");
  const target = path.join(execPath, "git-remote-http");
  const helper = path.join(execPath, "git-remote-https");
  await mkdir(execPath);
  await writeFile(git, "fixture git\n", { mode: 0o700 });
  await writeFile(target, "fixture helper\n", { mode: 0o700 });
  await symlink("git-remote-http", helper);
  await symlink("../git", path.join(execPath, "git-index-pack"));
  await symlink("../git", path.join(execPath, "git-unpack-objects"));
  const runtime = await inspectGitRuntime(git, async (_executable, arguments_) => ({
    signal: null,
    status: 0,
    stderr: "",
    stdout: arguments_.includes("--exec-path") ? `${execPath}\n` : "git version 2.50.1\n",
  }));
  const expected = {
    execPath: runtime.execPath,
    children: runtime.children,
    gitPath: runtime.git.path,
    gitSha256: runtime.git.sha256,
    helperLinkTarget: "git-remote-http",
    helperPath: runtime.helper.path,
    helperTarget: runtime.helper.target,
    helperTargetSha256: runtime.helper.targetSha256,
  };
  await verifyGitRuntimeIdentity(expected);
  await writeFile(target, "mutated helper\n", { mode: 0o700 });
  await assert.rejects(verifyGitRuntimeIdentity(expected), /helper target identity changed/u);

  await rm(helper);
  await symlink("../outside-helper", helper);
  await assert.rejects(
    inspectGitRuntime(git, async (_executable, arguments_) => ({
      signal: null,
      status: 0,
      stderr: "",
      stdout: arguments_.includes("--exec-path") ? `${execPath}\n` : "git version 2.50.1\n",
    })),
    /must remain inside/u,
  );
});

test("quota failure cleanup attempts every issued volume before aggregating errors", async () => {
  const cleaned = [];
  const failure = new Error("capture failed");
  await assert.rejects(
    cleanupIssuedQuotaVolumes(
      {
        cleanup: async (state) => {
          cleaned.push(state.id);
          if (state.id !== "second") throw new Error(`cleanup ${state.id} failed`);
        },
      },
      [{ id: "first" }, { id: "second" }, { id: "third" }],
      failure,
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], failure);
      assert.equal(error.errors.length, 3);
      return true;
    },
  );
  assert.deepEqual(cleaned, ["third", "second", "first"]);
});

test("private publication failure cleans every retained volume and aggregates quarantine failures", async (t) => {
  const workRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "k03-publication-fixture-")),
  );
  t.after(() => rm(workRoot, { force: true, recursive: true }));
  const repositories = ["1", "2", "3"].map((repositoryId) => {
    const root = path.join(workRoot, `repository-${repositoryId}`);
    return {
      checkout: {
        quota: {
          imagePath: path.join(workRoot, `quota-${repositoryId}.sparseimage`),
          mount: { path: root },
        },
        root,
      },
      repositoryId,
    };
  });
  const captured = {
    privateReviewBundle: {
      mustNotCommit: true,
      recordKind: "agent-context-private-metadata-calibration-review-bundle",
      repositories,
    },
  };
  const cleaned = [];
  const quotaProvider = {
    cleanup: async (state) => {
      const repositoryId = path.basename(state.mount.path).slice("repository-".length);
      cleaned.push(repositoryId);
      if (repositoryId !== "2") throw new Error(`cleanup ${repositoryId} failed`);
    },
  };
  await assert.rejects(
    publishCapturedCalibration({
      captured,
      cleanup: (provider, bundle, root) =>
        cleanupCapturedCalibration(provider, bundle, root, {
          verifyCheckout: async () => {},
        }),
      guard: { publish: async () => Promise.reject(new Error("publication failed")) },
      quotaProvider,
      workRoot,
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /publication failed.*retained for quarantine/u);
      assert.equal(error.errors[0].message, "publication failed");
      assert.ok(error.errors[1] instanceof AggregateError);
      return true;
    },
  );
  assert.deepEqual(cleaned, ["3", "2", "1"]);
});

test("capture retains frozen checkouts through maintainer review and final gate before cleanup", async (t) => {
  const candidateBytes = await readFile("calibration/metadata/v0/candidate-snapshot.json");
  const corpusBytes = await readFile("calibration/metadata/v0/corpus.json");
  const corpus = JSON.parse(corpusBytes.toString("utf8"));
  const workRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "precision-retained-evidence-")),
  );
  t.after(() => rm(workRoot, { force: true, recursive: true }));
  const events = [];
  const provider = {
    cleanup: async (state) => events.push(`cleanup:${path.basename(state.mount.path)}`),
    provision: async ({ logicalBudgetBytes, repositoryId }) => ({
      logicalBudgetBytes,
      mount: { path: path.join(workRoot, `repository-${repositoryId}`) },
      readOnly: false,
      repositoryId,
    }),
  };
  const captured = await executeCalibration({
    candidateBytes,
    captureRuntime: captureRuntime(),
    checkout: async (repository, destination, { quotaState }) => {
      await mkdir(destination);
      const quota = {
        devices: [`/dev/disk${repository.repositoryId}`],
        imagePath: path.join(workRoot, `quota-${repository.repositoryId}.sparseimage`),
        logicalBudgetBytes: quotaState.logicalBudgetBytes,
        mount: { path: destination },
        readOnly: true,
      };
      return {
        budget: { maximumBytes: 1024, maximumFiles: 10 },
        inventorySha256: "8".repeat(64),
        quota,
        quotaState: { ...quotaState, readOnly: true },
        root: destination,
      };
    },
    corpus,
    corpusBytes,
    generatedAt: "2026-08-09T04:00:00.000Z",
    quotaProvider: provider,
    scan: async (checkoutRoot) => output(path.basename(checkoutRoot).slice("repository-".length)),
    verifyCheckout: async () => events.push("capture-verify"),
    verifyRuntime: async () => {},
    workRoot,
  });
  assert.equal(
    events.some((entry) => entry.startsWith("cleanup:")),
    false,
  );
  for (const phase of ["review-a", "review-b", "final-gate"])
    for (const repository of captured.privateReviewBundle.repositories) {
      assert.equal(repository.checkout.root.startsWith(`${workRoot}${path.sep}`), true);
      events.push(`${phase}:${repository.repositoryId}`);
    }
  await cleanupCapturedCalibration(provider, captured.privateReviewBundle, workRoot, {
    verifyCheckout: async () => events.push("cleanup-preflight"),
  });
  const firstCleanup = events.findIndex((entry) => entry.startsWith("cleanup:"));
  const lastGate = events.findLastIndex((entry) => entry.startsWith("final-gate:"));
  assert.equal(firstCleanup > lastGate, true);
  assert.equal(
    events.filter((entry) => entry.startsWith("cleanup:")).length,
    corpus.repositories.length,
  );
});

const PACKED_REFERENCE = JSON.parse(
  await readFile("packages/cli/reference/agent-context-lint-reference.v1.json", "utf8"),
);
const DEFAULT_SEVERITIES = new Map(
  PACKED_REFERENCE.rules.entries.map((rule) => [rule.id, rule.defaultSeverity]),
);

function captureRuntime() {
  return {
    defaultSeverityByRule: DEFAULT_SEVERITIES,
    engine: {
      captureStartedAt: "2026-08-09T03:59:00.000Z",
      commitSha: "1".repeat(40),
      git: { sha256: "2".repeat(64), version: "git version 2.50.1" },
      gitRemoteHttps: { sha256: "a".repeat(64), version: "fixture-helper" },
      hdiutil: { sha256: "9".repeat(64), version: "hdiutil: 1.0.0" },
      guardSha256: "3".repeat(64),
      knowledgeVersion: "2026.08.0",
      node: { sha256: "4".repeat(64), version: "v26.3.0" },
      sandboxExec: { sha256: "b".repeat(64), version: "fixture-sandbox" },
      packageSha256: "5".repeat(64),
      ruleRegistrySha256: "6".repeat(64),
      runtimeClosureSha256: "7".repeat(64),
      version: "1.0.0-rc.1",
    },
    paths: {
      cliEntry: "/private/fake/cli.js",
      gitExecutable: "/usr/bin/git",
      nodeExecutable: "/private/fake/node",
      packageRoot: "/private/fake/package",
      readablePackageRoots: ["/private/fake/package/cli", "/private/fake/package/core"],
    },
  };
}

async function gitCheckoutRuntime() {
  const bootstrap = await runBoundedCommand("/usr/bin/git", ["--exec-path"], {
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 30_000,
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  const exactGit = await realpath(path.join(bootstrap.stdout.trim(), "git-index-pack"));
  const runtime = await inspectGitRuntime(exactGit);
  const linkTarget =
    runtime.helper.path === runtime.helper.target ? null : await readlink(runtime.helper.path);
  return {
    gitExecutable: runtime.git.path,
    gitExecPath: runtime.execPath,
    gitRequiredChildren: runtime.children,
    gitRemoteHttpsLinkTarget: linkTarget,
    gitRemoteHttpsPath: runtime.helper.path,
    gitRemoteHttpsTarget: runtime.helper.target,
    gitRemoteHttpsTargetSha256: runtime.helper.targetSha256,
    gitSha256: runtime.git.sha256,
    sandboxExecutable: "/usr/bin/sandbox-exec",
    sandboxSha256: createHash("sha256")
      .update(await readFile("/usr/bin/sandbox-exec"))
      .digest("hex"),
  };
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function position(byteOffset = 0) {
  return { byteOffset, line: 0, utf16Column: byteOffset, utf16Offset: byteOffset };
}

function location(repositoryId) {
  return {
    path: "AGENTS.md",
    range: { end: position(1), sourceId: `source:${repositoryId}`, start: position() },
    sourceDigest: sha(`source:${repositoryId}`),
    sourceId: `source:${repositoryId}`,
  };
}

function output(repositoryId) {
  const diagnostic = {
    fingerprintBasis: {
      path: { anchor: "AGENTS.md", profileIds: ["codex-cli"] },
      semantic: {
        components: [{ key: "rule", value: "fixture" }],
        profileIds: ["codex-cli"],
      },
    },
    fingerprints: {
      path: { method: "agent-context-lint/path/v1", value: sha(`path:${repositoryId}`) },
      semantic: {
        method: "agent-context-lint/semantic/v1",
        value: sha(`semantic:${repositoryId}`),
      },
    },
    id: `diagnostic:${repositoryId}`,
    message: "private review explanation",
    primary: location(repositoryId),
    related: [],
    ruleId: "ACL250",
    ruleVersion: "1.0.0",
    severity: "error",
    suggestion: null,
  };
  return {
    diagnostics: {
      contractVersion: "0.1.0",
      diagnostics: [diagnostic],
      recordKind: "agent-context-diagnostics",
      suppressions: [],
    },
    failureThreshold: "never",
    profileVersions: { "codex-cli": { clientVersion: null, profileVersion: "1.0.0" } },
    recordKind: "agent-context-scan-output",
    schemaVersion: "1.0.0",
    summary: { errors: 1, exitCode: 0, infos: 0, suppressed: 0, warnings: 0 },
  };
}

async function fakeQuota(destination, logicalBudgetBytes = 64 * 1024 * 1024) {
  await mkdir(destination, { mode: 0o700 });
  const state = {
    logicalBudgetBytes,
    mount: { path: destination },
    readOnly: false,
  };
  const provider = {
    evidence: (value) => ({ logicalBudgetBytes: value.logicalBudgetBytes, readOnly: true }),
    freeze: async (value) => ({ ...value, readOnly: true }),
  };
  return { provider, state };
}

async function packedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "precision-package-"));
  const cliRoot = path.join(root, "node_modules/@agent-context/lint");
  const coreRoot = path.join(root, "node_modules/@agent-context/core");
  const cliEntry = path.join(cliRoot, "dist/cli.js");
  const packText = '{"packVersion":"2026.8.0"}\n';
  const packSha256 = sha(packText);
  await mkdir(path.dirname(cliEntry), { recursive: true });
  await mkdir(path.join(coreRoot, "dist"), { recursive: true });
  await mkdir(path.join(cliRoot, "bundled/metadata"), { recursive: true });
  await mkdir(path.join(cliRoot, "bundled/packs"), { recursive: true });
  await writeFile(cliEntry, "process.stdout.write('fixture');\n");
  await writeFile(path.join(cliRoot, "dist/index.js"), "export {};\n");
  await writeFile(path.join(cliRoot, "dist/index.d.ts"), "export {};\n");
  const cliManifest = {
    bin: { "agent-context-lint": "./dist/cli.js" },
    dependencies: { "@agent-context/core": "1.0.0-rc.1" },
    description: "fixture",
    engines: { node: "^24.11.0 || ^26.0.0" },
    exports: {
      ".": {
        default: "./dist/index.js",
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      "./reference/agent-context-lint-reference.v1.json":
        "./reference/agent-context-lint-reference.v1.json",
      "./schemas/agent-context-lint-reference.v1.schema.json":
        "./schemas/agent-context-lint-reference.v1.schema.json",
    },
    name: "@agent-context/lint",
    man: ["./man/agent-context-lint.1"],
    publishConfig: { access: "public" },
    sideEffects: false,
    type: "module",
    types: "./dist/index.d.ts",
    version: "1.0.0-rc.1",
  };
  await writeFile(path.join(cliRoot, "package.json"), `${JSON.stringify(cliManifest)}\n`);
  for (const relativePath of [
    "reference/agent-context-lint-reference.v1.json",
    "schemas/agent-context-lint-reference.v1.schema.json",
  ]) {
    const absolutePath = path.join(cliRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(
      absolutePath,
      relativePath.startsWith("reference/") ? `${JSON.stringify(PACKED_REFERENCE)}\n` : "{}\n",
    );
  }
  const coreManifest = {
    description: "fixture",
    engines: { node: "^24.11.0 || ^26.0.0" },
    exports: {
      ".": {
        default: "./dist/index.js",
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      "./policies/compatibility-policy.v1.json": "./policies/compatibility-policy.v1.json",
      "./schemas/agent-context-lint-config.v1.schema.json":
        "./schemas/agent-context-lint-config.v1.schema.json",
      "./schemas/diagnostic-baseline.v1.schema.json":
        "./schemas/diagnostic-baseline.v1.schema.json",
      "./schemas/diagnostic-contract.v0.schema.json":
        "./schemas/diagnostic-contract.v0.schema.json",
      "./schemas/organization-policy-pack.v0.schema.json":
        "./schemas/organization-policy-pack.v0.schema.json",
      "./schemas/output-contract.v1.schema.json": "./schemas/output-contract.v1.schema.json",
      "./schemas/sarif-output.v2.1.0-product-v2.schema.json":
        "./schemas/sarif-output.v2.1.0-product-v2.schema.json",
      "./schemas/sarif-output.v2.1.0.schema.json": "./schemas/sarif-output.v2.1.0.schema.json",
    },
    name: "@agent-context/core",
    files: ["dist", "policies", "schemas"],
    publishConfig: { access: "public" },
    sideEffects: false,
    type: "module",
    types: "./dist/index.d.ts",
    version: "1.0.0-rc.1",
  };
  await writeFile(path.join(coreRoot, "package.json"), `${JSON.stringify(coreManifest)}\n`);
  await writeFile(path.join(coreRoot, "dist/index.js"), "export {};\n");
  await writeFile(path.join(coreRoot, "dist/index.d.ts"), "export {};\n");
  for (const relativePath of [
    "policies/compatibility-policy.v1.json",
    "schemas/agent-context-lint-config.v1.schema.json",
    "schemas/diagnostic-baseline.v1.schema.json",
    "schemas/diagnostic-contract.v0.schema.json",
    "schemas/organization-policy-pack.v0.schema.json",
    "schemas/output-contract.v1.schema.json",
    "schemas/sarif-output.v2.1.0-product-v2.schema.json",
    "schemas/sarif-output.v2.1.0.schema.json",
  ]) {
    const absolutePath = path.join(coreRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "{}\n");
  }
  await writeFile(
    path.join(cliRoot, "bundled/metadata/standards-stable.json"),
    `${JSON.stringify({
      signed: {
        targets: {
          "knowledge/stable/agent-context-bundled.json": {
            custom: { packVersion: "2026.8.0" },
            hashes: { sha256: packSha256 },
            length: Buffer.byteLength(packText),
          },
        },
      },
    })}\n`,
  );
  await writeFile(path.join(cliRoot, `bundled/packs/sha256-${packSha256}.json`), packText);
  return { cliEntry, cliManifest, cliRoot, coreManifest, coreRoot, packSha256, root };
}

test("execution covers the immutable 50-repository frame in repository-ID order", async () => {
  const candidateBytes = await readFile("calibration/metadata/v0/candidate-snapshot.json");
  const corpusBytes = await readFile("calibration/metadata/v0/corpus.json");
  const corpus = JSON.parse(corpusBytes.toString("utf8"));
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "precision-execute-"));
  const checkedOut = [];
  const scanned = [];
  const result = await executeCalibration({
    candidateBytes,
    captureRuntime: captureRuntime(),
    checkout: async (repository, destination) => {
      checkedOut.push(repository.repositoryId);
      await mkdir(destination);
      return {
        budget: { maximumBytes: 1024, maximumFiles: 10 },
        inventorySha256: "8".repeat(64),
        root: destination,
      };
    },
    corpus,
    corpusBytes,
    generatedAt: "2026-08-09T04:00:00.000Z",
    scan: async (checkoutRoot) => {
      const repositoryId = path.basename(checkoutRoot).slice("repository-".length);
      scanned.push(repositoryId);
      return output(repositoryId);
    },
    verifyCheckout: async () => {},
    verifyRuntime: async () => {},
    workRoot,
  });
  const expected = corpus.repositories
    .map((entry) => entry.repositoryId)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  assert.deepEqual(checkedOut, expected);
  assert.deepEqual(scanned, expected);
  assert.equal(result.report.diagnostics.length, 50);
  assert.equal(result.privateReviewBundle.repositories.length, 50);
  const staleCorpus = structuredClone(corpus);
  [staleCorpus.repositories[0], staleCorpus.repositories[1]] = [
    staleCorpus.repositories[1],
    staleCorpus.repositories[0],
  ];
  await assert.rejects(
    executeCalibration({
      candidateBytes,
      captureRuntime: captureRuntime(),
      checkout: async () => {
        throw new Error("stale corpus must fail before checkout");
      },
      corpus: staleCorpus,
      corpusBytes,
      generatedAt: "2026-08-09T04:00:00.000Z",
      scan: async () => output("1"),
      verifyCheckout: async () => {},
      verifyRuntime: async () => {},
      workRoot,
    }),
    /immutable K02 corpus bytes/,
  );
});

test("checkout uses only pinned HTTPS Git operations and verifies detached HEAD", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "precision-checkout-parent-"));
  const checkout = path.join(destination, "checkout");
  const calls = [];
  const repository = {
    diskUsageKiB: 1024,
    fullName: "owner/repository",
    pinnedCommitSha: "a".repeat(40),
    pinnedTreeSha: "b".repeat(40),
    repositoryId: "123",
  };
  const quota = await fakeQuota(checkout);
  const reviewedGit = await gitCheckoutRuntime();
  await checkoutPinnedRepository(repository, checkout, {
    command: async (executable, arguments_, options) => {
      calls.push({ arguments_, executable, options });
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: arguments_.includes("HEAD^{tree}")
          ? `${repository.pinnedTreeSha}\n`
          : arguments_.includes("rev-parse")
            ? `${repository.pinnedCommitSha}\n`
            : "",
      };
    },
    environment: {},
    ...reviewedGit,
    quotaProvider: quota.provider,
    quotaState: quota.state,
  });
  assert.equal(calls.length, 7);
  assert.equal(
    calls.every((entry) => entry.executable === "/usr/bin/sandbox-exec"),
    true,
  );
  assert.equal(
    calls.every(
      (entry) =>
        entry.options.environment.GIT_EXEC_PATH === reviewedGit.gitExecPath &&
        entry.options.environment.GIT_ASKPASS === "/dev/null" &&
        entry.options.environment.GIT_TERMINAL_PROMPT === "0",
    ),
    true,
  );
  const processPolicy = calls[0].arguments_[1];
  assert.equal(processPolicy.includes(reviewedGit.gitRemoteHttpsPath), true);
  assert.equal(processPolicy.includes(reviewedGit.gitRemoteHttpsTarget), true);
  for (const child of reviewedGit.gitRequiredChildren)
    assert.equal(processPolicy.includes(child.path), true);
  assert.equal(processPolicy.includes("/bin/sh"), false);
  assert.equal(
    calls.some((entry) => entry.arguments_.includes("https://github.com/owner/repository.git")),
    true,
  );
  assert.equal(
    calls.some((entry) => entry.arguments_.includes("--detach")),
    true,
  );
  assert.equal(
    calls.some((entry) => entry.arguments_.includes("--filter=blob:none")),
    true,
  );
  assert.equal(
    calls.some((entry) => entry.arguments_.includes("submodule")),
    false,
  );
  assert.equal(
    calls.some((entry) => entry.arguments_.includes("--no-recurse-submodules")),
    true,
  );

  const wrongTreeDestination = path.join(destination, "wrong-tree");
  const wrongTreeQuota = await fakeQuota(wrongTreeDestination);
  await assert.rejects(
    checkoutPinnedRepository(repository, wrongTreeDestination, {
      command: async (_executable, arguments_) => ({
        signal: null,
        status: 0,
        stderr: "",
        stdout: arguments_.includes("HEAD^{tree}")
          ? `${"c".repeat(40)}\n`
          : arguments_.includes("rev-parse")
            ? `${repository.pinnedCommitSha}\n`
            : "",
      }),
      environment: {},
      ...reviewedGit,
      quotaProvider: wrongTreeQuota.provider,
      quotaState: wrongTreeQuota.state,
    }),
    /checkout tree differs/,
  );

  const oversizedDestination = path.join(destination, "oversized");
  const oversizedQuota = await fakeQuota(oversizedDestination);
  let populated = false;
  await assert.rejects(
    checkoutPinnedRepository({ ...repository, diskUsageKiB: 1 }, oversizedDestination, {
      command: async (_executable, arguments_) => {
        if (arguments_.includes("--detach") && !populated) {
          populated = true;
          const handle = await open(path.join(oversizedDestination, "oversized.bin"), "w");
          await handle.truncate(64 * 1024 * 1024 + 1);
          await handle.close();
        }
        return {
          signal: null,
          status: 0,
          stderr: "",
          stdout: arguments_.includes("HEAD^{tree}")
            ? `${repository.pinnedTreeSha}\n`
            : arguments_.includes("rev-parse")
              ? `${repository.pinnedCommitSha}\n`
              : "",
        };
      },
      environment: {},
      ...reviewedGit,
      quotaProvider: oversizedQuota.provider,
      quotaState: oversizedQuota.state,
    }),
    /byte budget/,
  );
});

test("checkout arguments execute against a disposable Git repository with exact HEAD and tree", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "precision-git-source-"));
  const destinationParent = await mkdtemp(path.join(os.tmpdir(), "precision-git-destination-"));
  const runGit = async (arguments_, cwd = source) => {
    const result = await runBoundedCommand("git", arguments_, {
      cwd,
      environment: process.env,
      timeoutMs: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await runGit(["init", "--quiet"]);
  await writeFile(path.join(source, "AGENTS.md"), "Synthetic checkout fixture.\n");
  await runGit(["add", "AGENTS.md"]);
  await runGit([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Create synthetic checkout fixture",
  ]);
  const pinnedCommitSha = await runGit(["rev-parse", "HEAD"]);
  const pinnedTreeSha = await runGit(["rev-parse", "HEAD^{tree}"]);
  const destination = path.join(destinationParent, "checkout");
  const quota = await fakeQuota(destination);
  const transportAdapter = async (executable, arguments_, options) => {
    assert.equal(executable, "/usr/bin/sandbox-exec");
    const gitExecutable = arguments_[2];
    const adapted = arguments_.slice(3);
    const remoteIndex = adapted.indexOf("origin");
    if (
      adapted.includes("remote") &&
      adapted.includes("add") &&
      remoteIndex >= 0 &&
      remoteIndex + 1 < adapted.length
    )
      adapted[remoteIndex + 1] = source;
    const policyIndex = adapted.indexOf("protocol.file.allow=never");
    if (policyIndex >= 0) adapted[policyIndex] = "protocol.file.allow=always";
    return runBoundedCommand(gitExecutable, adapted, options);
  };
  const checkoutResult = await checkoutPinnedRepository(
    {
      diskUsageKiB: 1024,
      fullName: "synthetic/fixture",
      pinnedCommitSha,
      pinnedTreeSha,
      repositoryId: "123",
    },
    destination,
    {
      command: transportAdapter,
      environment: process.env,
      gitExecutable: "/usr/bin/git",
      ...(await gitCheckoutRuntime()),
      quotaProvider: quota.provider,
      quotaState: quota.state,
    },
  );
  assert.equal(
    await readFile(path.join(destination, "AGENTS.md"), "utf8"),
    "Synthetic checkout fixture.\n",
  );
  assert.equal(await runGit(["-C", destination, "remote"], destination), "");
  await assert.rejects(writeFile(path.join(destination, "AGENTS.md"), "mutated\n"), /EACCES/);
  assert.equal(
    await runGit(["-C", destination, "rev-parse", "HEAD"], destination),
    pinnedCommitSha,
  );
  assert.equal(
    await runGit(["-C", destination, "rev-parse", "HEAD^{tree}"], destination),
    pinnedTreeSha,
  );
  await verifyFrozenCheckout(checkoutResult, { verifyQuota: async () => {} });
  const instructionPath = path.join(destination, "AGENTS.md");
  const instructionBytes = await readFile(instructionPath);
  const instructionMetadata = await stat(instructionPath);
  await chmod(instructionPath, 0o644);
  await writeFile(instructionPath, Buffer.alloc(instructionBytes.length, 0x78));
  await utimes(instructionPath, instructionMetadata.atime, instructionMetadata.mtime);
  await chmod(instructionPath, 0o444);
  await assert.rejects(
    verifyFrozenCheckout(checkoutResult, { verifyQuota: async () => {} }),
    /checkout inventory changed/,
  );
});

test("bounded command rejects excess output and timeouts", async () => {
  await assert.rejects(
    runBoundedCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
      cwd: process.cwd(),
      environment: process.env,
      maximumStdoutBytes: 16,
      timeoutMs: 10_000,
    }),
    /stdout exceeded/,
  );
  await assert.rejects(
    runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      environment: process.env,
      timeoutMs: 20,
    }),
    /timeout/,
  );
});

test("bounded command enforces pre-abort, live cancellation, binary stdout, and fatal stderr", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "precision-command-cancel-"));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const marker = path.join(temporary, "started.txt");
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    runBoundedCommand(
      process.execPath,
      ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
      {
        cwd: temporary,
        environment: process.env,
        signal: preAborted.signal,
        timeoutMs: 5_000,
      },
    ),
    /cancelled/u,
  );
  await assert.rejects(readFile(marker), /ENOENT/u);

  const live = new AbortController();
  const running = runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: temporary,
    environment: process.env,
    signal: live.signal,
    timeoutMs: 5_000,
  });
  setTimeout(() => live.abort(), 25);
  await assert.rejects(running, /cancelled/u);

  const binary = await runBoundedCommand(
    process.execPath,
    ["-e", "require('node:fs').writeSync(1, Buffer.from([0, 255, 1]))"],
    {
      cwd: temporary,
      environment: process.env,
      stdoutEncoding: "buffer",
      timeoutMs: 5_000,
    },
  );
  assert.deepEqual(binary.stdout, Buffer.from([0, 255, 1]));
  await assert.rejects(
    runBoundedCommand(
      process.execPath,
      ["-e", "require('node:fs').writeSync(2, Buffer.from([255]))"],
      { cwd: temporary, environment: process.env, timeoutMs: 5_000 },
    ),
    /malformed UTF-8/u,
  );
});

test("bounded command kills same-group descendants before a successful return", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "precision-command-success-group-"));
  t.after(() => rm(temporary, { force: true, recursive: true }));
  const marker = path.join(temporary, "orphan.txt");
  const child = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 250); setInterval(() => {}, 1000);`;
  const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" }).unref();`;
  const result = await runBoundedCommand(process.execPath, ["-e", parent], {
    cwd: temporary,
    environment: process.env,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, 0);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(readFile(marker), /ENOENT/u);
});

test("bounded command kills the complete process group and enforces a pre-write tree ceiling", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "precision-process-tree-"));
  const marker = path.join(temporary, "survived.txt");
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 250)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}]); setInterval(() => {}, 1000)`;
  await assert.rejects(
    runBoundedCommand(process.execPath, ["-e", parent], {
      cwd: temporary,
      environment: process.env,
      timeoutMs: 50,
    }),
    /timeout/,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(readFile(marker), /ENOENT/);

  const quotaRoot = await mkdtemp(path.join(os.tmpdir(), "precision-tree-quota-"));
  const target = path.join(quotaRoot, "growing.bin");
  const writer = `const fs=require('node:fs');const fd=fs.openSync(${JSON.stringify(target)},'w');const chunk=Buffer.alloc(8192);setInterval(()=>fs.writeSync(fd,chunk),10)`;
  await assert.rejects(
    runBoundedCommand(process.execPath, ["-e", writer], {
      cwd: quotaRoot,
      environment: process.env,
      monitorTree: {
        maximumBytes: 64 * 1024,
        maximumFiles: 10,
        rejectAtLimit: true,
        root: quotaRoot,
      },
      timeoutMs: 5_000,
    }),
    /byte budget/,
  );
  assert.equal((await stat(target)).size <= 64 * 1024, true);
});

test("packed engine identity is derived from bounded extracted artifacts", async () => {
  const fixture = await packedFixture();
  const identity = await inspectPackedEngine(fixture.root, fixture.cliEntry);
  assert.equal(identity.engineVersion, "1.0.0-rc.1");
  assert.equal(identity.knowledgeVersion, "2026.8.0");
  assert.match(identity.packageSha256, /^[0-9a-f]{64}$/);
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "precision-outside-")), "cli.js");
  await writeFile(outside, "export {};\n");
  await assert.rejects(
    inspectPackedEngine(fixture.root, outside),
    /contained|inside the extracted/,
  );
  await writeFile(
    path.join(fixture.cliRoot, `bundled/packs/sha256-${fixture.packSha256}.json`),
    "corrupt\n",
  );
  await assert.rejects(inspectPackedEngine(fixture.root, fixture.cliEntry), /differs from/);
});

test("packed engine rejects internal entry substitution, symlinks, and open runtime contracts", async () => {
  const internal = await packedFixture();
  const internalEntry = path.join(internal.cliRoot, "dist/internal.js");
  await writeFile(internalEntry, "export {};\n");
  await assert.rejects(
    inspectPackedEngine(internal.root, internalEntry),
    /does not equal the packed manifest executable/,
  );

  const linkedBin = await packedFixture();
  const realEntry = path.join(linkedBin.cliRoot, "dist/real-cli.js");
  await rename(linkedBin.cliEntry, realEntry);
  await symlink(realEntry, linkedBin.cliEntry);
  await assert.rejects(
    inspectPackedEngine(linkedBin.root, linkedBin.cliEntry),
    /symbolic links|regular file/,
  );

  const linkedMetadata = await packedFixture();
  const metadata = path.join(linkedMetadata.cliRoot, "bundled/metadata");
  const realMetadata = path.join(linkedMetadata.cliRoot, "bundled/metadata-real");
  await rename(metadata, realMetadata);
  await symlink(realMetadata, metadata);
  await assert.rejects(
    inspectPackedEngine(linkedMetadata.root, linkedMetadata.cliEntry),
    /symbolic links/,
  );

  const openDependencies = await packedFixture();
  await writeFile(
    path.join(openDependencies.cliRoot, "package.json"),
    `${JSON.stringify({
      ...openDependencies.cliManifest,
      dependencies: {
        ...openDependencies.cliManifest.dependencies,
        unexpected: "1.0.0",
      },
    })}\n`,
  );
  await assert.rejects(
    inspectPackedEngine(openDependencies.root, openDependencies.cliEntry),
    /closed runtime dependency/,
  );

  const openExports = await packedFixture();
  await writeFile(
    path.join(openExports.cliRoot, "package.json"),
    `${JSON.stringify({
      ...openExports.cliManifest,
      exports: { ...openExports.cliManifest.exports, "./internal": "./dist/internal.js" },
    })}\n`,
  );
  await assert.rejects(
    inspectPackedEngine(openExports.root, openExports.cliEntry),
    /closed export map/,
  );

  const coreDependency = await packedFixture();
  await writeFile(
    path.join(coreDependency.coreRoot, "package.json"),
    `${JSON.stringify({ ...coreDependency.coreManifest, dependencies: { unexpected: "1.0.0" } })}\n`,
  );
  await assert.rejects(
    inspectPackedEngine(coreDependency.root, coreDependency.cliEntry),
    /core manifest.*unexpected or missing fields/,
  );

  const lifecycle = await packedFixture();
  await writeFile(
    path.join(lifecycle.cliRoot, "package.json"),
    `${JSON.stringify({ ...lifecycle.cliManifest, scripts: { postinstall: "node exploit.js" } })}\n`,
  );
  await assert.rejects(
    inspectPackedEngine(lifecycle.root, lifecycle.cliEntry),
    /lifecycle scripts/,
  );

  const duplicateManifest = await packedFixture();
  const manifestText = JSON.stringify(duplicateManifest.cliManifest);
  await writeFile(
    path.join(duplicateManifest.cliRoot, "package.json"),
    `${manifestText.slice(0, -1)},"name":"@agent-context/lint"}\n`,
  );
  await assert.rejects(
    inspectPackedEngine(duplicateManifest.root, duplicateManifest.cliEntry),
    /unique-key UTF-8 JSON/,
  );

  const publicPackage = await packedFixture();
  await chmod(publicPackage.root, 0o777);
  await assert.rejects(
    inspectPackedEngine(publicPackage.root, publicPackage.cliEntry),
    /package root.*exact mode 0700/,
  );
});

test("capture runtime verification rejects post-inspection package mutation", async () => {
  const fixture = await packedFixture();
  const reviewedGit = (await gitCheckoutRuntime()).gitExecutable;
  const runtime = await inspectCaptureRuntime({
    cliEntry: fixture.cliEntry,
    gitExecutable: reviewedGit,
    hdiutilExecutable: "/usr/bin/hdiutil",
    nodeExecutable: process.execPath,
    packageRoot: fixture.root,
  });
  await writeFile(path.join(fixture.cliRoot, "dist/index.js"), "export const mutated = true;\n");
  await assert.rejects(
    verifyCaptureRuntime(runtime, {
      cliEntry: fixture.cliEntry,
      gitExecutable: reviewedGit,
      hdiutilExecutable: "/usr/bin/hdiutil",
      nodeExecutable: process.execPath,
      packageRoot: fixture.root,
    }),
    /runtime identity changed/,
  );
});

test("capture roots and private publication reject symlink and path substitution", async (t) => {
  const realRoot = await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-paths-"));
  t.after(() => rm(realRoot, { force: true, recursive: true }));
  const linkParent = await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-link-parent-"));
  t.after(() => rm(linkParent, { force: true, recursive: true }));
  const linkedRoot = path.join(linkParent, "linked-root");
  await symlink(realRoot, linkedRoot);
  await assert.rejects(
    validateCapturePaths(linkedRoot, path.join(linkedRoot, "private-review.json")),
    /symbolic link/,
  );
  await assert.rejects(
    validateCapturePaths(realRoot, path.join(realRoot, "renamed.json")),
    /fixed direct child/,
  );
  const paths = await validateCapturePaths(realRoot, path.join(realRoot, "private-review.json"));
  const outside = path.join(linkParent, "outside.json");
  await writeFile(outside, "outside\n");
  await symlink(outside, paths.privateOutput);
  await assert.rejects(
    publishPrivateReview(paths.workRoot, paths.privateOutput, { private: true }),
    /EEXIST|exist/i,
  );
  assert.equal(await readFile(outside, "utf8"), "outside\n");

  const publicRoot = await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-public-"));
  t.after(() => rm(publicRoot, { force: true, recursive: true }));
  await chmod(publicRoot, 0o777);
  await assert.rejects(
    validateCapturePaths(publicRoot, path.join(publicRoot, "private-review.json")),
    /owned.*0700|mode 0700/,
  );
});

test("held publication identity rejects a queued output-file replacement", async (t) => {
  const workRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "agent-context-k03-publish-race-")),
  );
  t.after(() => rm(workRoot, { force: true, recursive: true }));
  const privateOutput = path.join(workRoot, "private-review.json");
  const displaced = path.join(workRoot, "displaced-review.json");
  const guard = await createPrivateReviewPublicationGuard(workRoot, privateOutput);
  await rename(privateOutput, displaced);
  await writeFile(privateOutput, "substitute\n", { mode: 0o600 });
  await assert.rejects(guard.publish({ secret: "held bytes" }), /identity changed/u);
  await guard.close();
  assert.equal(await readFile(privateOutput, "utf8"), "substitute\n");
  assert.equal(await readFile(displaced, "utf8"), "");
});

test("live scan boundary uses the OS network/write sandbox and Node permission model", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "precision-sandbox-"));
  const checkoutRoot = path.join(temporary, "checkout");
  const packageRoot = path.join(temporary, "package");
  await mkdir(checkoutRoot);
  await mkdir(packageRoot);
  const cliEntry = path.join(packageRoot, "cli.mjs");
  await writeFile(
    cliEntry,
    "process.stdout.write(JSON.stringify({recordKind:'agent-context-scan-output'})+'\\n');\n",
  );
  if (process.platform !== "darwin") {
    await assert.rejects(
      invokePackedCalibrationScan(checkoutRoot, {
        cliEntry,
        environment: process.env,
        nodeExecutable: process.execPath,
        readablePackageRoots: [packageRoot],
      }),
      /fails closed/,
    );
    return;
  }
  let invocation;
  assert.deepEqual(
    await invokePackedCalibrationScan(checkoutRoot, {
      cliEntry,
      command: async (executable, arguments_) => {
        invocation = { arguments_, executable };
        return {
          signal: null,
          status: 0,
          stderr: "",
          stdout: '{"recordKind":"agent-context-scan-output"}\n',
        };
      },
      environment: process.env,
      nodeExecutable: process.execPath,
      readablePackageRoots: [packageRoot],
    }),
    { recordKind: "agent-context-scan-output" },
  );
  assert.equal(invocation.executable, "/usr/bin/sandbox-exec");
  assert.equal(
    invocation.arguments_.some((entry) => entry.includes("(deny network*)")),
    true,
  );
  assert.equal(
    invocation.arguments_.some((entry) => entry.includes("(deny file-read*)")),
    true,
  );
  assert.equal(invocation.arguments_.includes("--permission"), true);
  assert.equal(
    invocation.arguments_.some((entry) => entry.startsWith("--allow-fs-read=")),
    true,
  );
  assert.equal(invocation.arguments_.includes("--allow-child-process"), false);
  await assert.rejects(
    invokePackedCalibrationScan(checkoutRoot, {
      cliEntry,
      command: async () => ({
        signal: null,
        status: 0,
        stderr: "",
        stdout: '{"recordKind":"agent-context-scan-output","recordKind":"forged"}\n',
      }),
      environment: process.env,
      nodeExecutable: process.execPath,
      readablePackageRoots: [packageRoot],
    }),
    /unique-key JSON/,
  );

  let probeInvocation;
  await verifyOsReadConfinement({
    command: async (executable, arguments_) => {
      probeInvocation = { arguments_, executable };
      return { signal: null, status: 0, stderr: "", stdout: "" };
    },
    environment: process.env,
    nodeExecutable: process.execPath,
    readablePackageRoots: [packageRoot],
    workRoot: temporary,
  });
  assert.equal(
    probeInvocation.arguments_.some((entry) => entry.includes("outside")),
    true,
  );
  assert.equal(
    probeInvocation.arguments_.some((entry) => entry.includes("deny file-read")),
    true,
  );
  assert.throws(
    () => validateSandboxPolicyText("(deny network*) (deny file-write*) (deny process-exec*)"),
    /missing \(deny file-read\*\)/,
  );
  await assert.rejects(
    verifyOsReadConfinement({
      command: async () => ({ signal: null, status: 42, stderr: "", stdout: "" }),
      environment: process.env,
      nodeExecutable: process.execPath,
      readablePackageRoots: [packageRoot],
      workRoot: await mkdtemp(path.join(os.tmpdir(), "precision-probe-failure-")),
    }),
    /did not deny.*symlink escape/,
  );
});
