import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runBoundedCommand } from "./execute.mjs";
import {
  _test,
  compareRebuiltEngineIdentity,
  inspectExactSourceInventory,
  materializeEngineCommit,
  replayFinalSource,
  verifyEvidenceCommitLineage,
  verifySourceSubset,
} from "./source-replay.mjs";

async function git(arguments_, cwd) {
  const result = await runBoundedCommand("/usr/bin/git", arguments_, {
    cwd,
    environment: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      LC_ALL: "C",
      PATH: process.env.PATH,
    },
    timeoutMs: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function committedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "k03-source-inventory-"));
  await git(["init", "--quiet"], root);
  await writeFile(path.join(root, "ordinary.txt"), "committed bytes\n");
  await writeFile(path.join(root, "executable.mjs"), "export default 1;\n");
  await chmod(path.join(root, "executable.mjs"), 0o755);
  await git(["add", "ordinary.txt", "executable.mjs"], root);
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Create exact source fixture",
    ],
    root,
  );
  return { commitSha: await git(["rev-parse", "HEAD"], root), root };
}

async function commitFixture(root, message, repositoryPath, bytes = "evidence\n") {
  await mkdir(path.dirname(path.join(root, repositoryPath)), { recursive: true });
  await writeFile(path.join(root, repositoryPath), bytes);
  await git(["add", repositoryPath], root);
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      message,
    ],
    root,
  );
  return git(["rev-parse", "HEAD"], root);
}

test("evidence lineage accepts a clean descendant containing only evidence and documentation", async () => {
  const fixture = await committedFixture();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "k03-lineage-temp-"));
  await commitFixture(
    fixture.root,
    "Add evidence",
    "calibration/metadata/v0/precision-evidence.json",
    "{}\n",
  );
  await commitFixture(fixture.root, "Document evidence", "docs/k03-evidence.md");
  const lineage = await verifyEvidenceCommitLineage({
    engineCommitSha: fixture.commitSha,
    gitExecutable: "/usr/bin/git",
    repositoryRoot: fixture.root,
    temporaryRoot,
  });
  assert.equal(lineage.engineCommitSha, fixture.commitSha);
  assert.equal(lineage.evidenceCommitSha, await git(["rev-parse", "HEAD"], fixture.root));
  assert.deepEqual(lineage.changedPaths, [
    "calibration/metadata/v0/precision-evidence.json",
    "docs/k03-evidence.md",
  ]);
});

test("evidence lineage rejects dirty A, forged E, and a non-ancestor E", async () => {
  const dirty = await committedFixture();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "k03-lineage-temp-"));
  await commitFixture(dirty.root, "Add evidence", "docs/evidence.md");
  await writeFile(path.join(dirty.root, "untracked.txt"), "dirty\n");
  await assert.rejects(
    verifyEvidenceCommitLineage({
      engineCommitSha: dirty.commitSha,
      gitExecutable: "/usr/bin/git",
      repositoryRoot: dirty.root,
      temporaryRoot,
    }),
    /clean tracked worktree/u,
  );

  const forged = await committedFixture();
  await commitFixture(forged.root, "Add evidence", "docs/evidence.md");
  await assert.rejects(
    verifyEvidenceCommitLineage({
      engineCommitSha: "f".repeat(40),
      gitExecutable: "/usr/bin/git",
      repositoryRoot: forged.root,
      temporaryRoot,
    }),
    /source commit resolution failed|forged/u,
  );

  const sibling = await committedFixture();
  const base = sibling.commitSha;
  const evidenceCommit = await commitFixture(sibling.root, "Add evidence", "docs/evidence.md");
  await git(["switch", "--quiet", "--detach", base], sibling.root);
  const otherCommit = await commitFixture(sibling.root, "Change sibling", "docs/sibling.md");
  await git(["switch", "--quiet", "--detach", evidenceCommit], sibling.root);
  await assert.rejects(
    verifyEvidenceCommitLineage({
      engineCommitSha: otherCommit,
      gitExecutable: "/usr/bin/git",
      repositoryRoot: sibling.root,
      temporaryRoot,
    }),
    /not a descendant/u,
  );
});

test("evidence lineage rejects engine, build, lock, F16, and regression changes", async () => {
  const forbiddenPaths = [
    "packages/core/src/engine.ts",
    "scripts/build.mjs",
    "pnpm-lock.yaml",
    "calibration/seeded-recall/v0/report.json",
    "calibration/regressions/k03.test.mjs",
  ];
  for (const repositoryPath of forbiddenPaths) {
    const fixture = await committedFixture();
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "k03-lineage-temp-"));
    await commitFixture(fixture.root, "Mutate immutable input", repositoryPath);
    await assert.rejects(
      verifyEvidenceCommitLineage({
        engineCommitSha: fixture.commitSha,
        gitExecutable: "/usr/bin/git",
        repositoryRoot: fixture.root,
        temporaryRoot,
      }),
      new RegExp(repositoryPath.replaceAll("/", "\\/"), "u"),
    );
  }
});

test("exact source inventory binds clean HEAD path, mode, size, and Git blob bytes", async () => {
  const fixture = await committedFixture();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "k03-source-temp-"));
  await git(["config", "core.fsmonitor", "!exit 93"], fixture.root);
  await git(["config", "core.untrackedCache", "true"], fixture.root);
  const first = await inspectExactSourceInventory({
    expectedCommitSha: fixture.commitSha,
    gitExecutable: "/usr/bin/git",
    repositoryRoot: fixture.root,
    temporaryRoot,
  });
  assert.equal(first.commitSha, fixture.commitSha);
  assert.deepEqual(
    first.entries.map(({ mode, path: repositoryPath }) => [mode, repositoryPath]),
    [
      ["100755", "executable.mjs"],
      ["100644", "ordinary.txt"],
    ],
  );
  const target = path.join(fixture.root, "ordinary.txt");
  const before = await lstat(target);
  await writeFile(target, "hostile__ bytes\n");
  await utimes(target, before.atime, before.mtime);
  await assert.rejects(
    inspectExactSourceInventory({
      expectedCommitSha: fixture.commitSha,
      gitExecutable: "/usr/bin/git",
      repositoryRoot: fixture.root,
      temporaryRoot,
    }),
    /clean tracked worktree|bytes differ/u,
  );
});

test("engine commit materialization reconstructs exact E bytes in a separate tree", async () => {
  const fixture = await committedFixture();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "k03-materialize-temp-"));
  const destination = await mkdtemp(path.join(os.tmpdir(), "k03-materialize-output-"));
  const archiveOptions = [];
  const boundedCommand = async (executable, arguments_, options) => {
    if (arguments_.includes("archive")) archiveOptions.push(options);
    return runBoundedCommand(executable, arguments_, options);
  };
  const materialized = await materializeEngineCommit({
    command: boundedCommand,
    commitSha: fixture.commitSha,
    destination,
    gitExecutable: "/usr/bin/git",
    repositoryRoot: fixture.root,
    temporaryRoot,
  });
  assert.notEqual(materialized.root, fixture.root);
  assert.equal(
    await readFile(path.join(materialized.root, "ordinary.txt"), "utf8"),
    "committed bytes\n",
  );
  assert.equal((await lstat(path.join(materialized.root, "executable.mjs"))).mode & 0o111, 0o111);
  assert.deepEqual(materialized.sourcePaths, ["executable.mjs", "ordinary.txt"]);
  assert.equal(archiveOptions.length, 1);
  assert.equal(archiveOptions[0].stdoutEncoding, "buffer");
  assert.equal(archiveOptions[0].maximumStderrBytes, 64 * 1024);
  assert.equal(Number.isSafeInteger(archiveOptions[0].maximumStdoutBytes), true);
  assert.equal(Number.isSafeInteger(archiveOptions[0].timeoutMs), true);
  await writeFile(path.join(materialized.root, "ordinary.txt"), "mutated source\n");
  await assert.rejects(
    verifySourceSubset(materialized.root, materialized.inventory, materialized.sourcePaths),
    /differs from the commit/u,
  );
});

test("exact source inventory rejects HEAD drift, untracked files, and tracked symlinks", async () => {
  const fixture = await committedFixture();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "k03-source-temp-"));
  await assert.rejects(
    inspectExactSourceInventory({
      expectedCommitSha: "f".repeat(40),
      gitExecutable: "/usr/bin/git",
      repositoryRoot: fixture.root,
      temporaryRoot,
    }),
    /HEAD does not equal/u,
  );
  await writeFile(path.join(fixture.root, "untracked.txt"), "untracked\n");
  await assert.rejects(
    inspectExactSourceInventory({
      expectedCommitSha: fixture.commitSha,
      gitExecutable: "/usr/bin/git",
      repositoryRoot: fixture.root,
      temporaryRoot,
    }),
    /clean tracked worktree/u,
  );

  const symlinkRoot = await mkdtemp(path.join(os.tmpdir(), "k03-source-symlink-"));
  await git(["init", "--quiet"], symlinkRoot);
  await writeFile(path.join(symlinkRoot, "target.txt"), "target\n");
  await symlink("target.txt", path.join(symlinkRoot, "link.txt"));
  await git(["add", "target.txt", "link.txt"], symlinkRoot);
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Create unsafe source fixture",
    ],
    symlinkRoot,
  );
  await assert.rejects(
    inspectExactSourceInventory({
      expectedCommitSha: await git(["rev-parse", "HEAD"], symlinkRoot),
      gitExecutable: "/usr/bin/git",
      repositoryRoot: symlinkRoot,
      temporaryRoot,
    }),
    /unsafe entry/u,
  );
});

test("rebuilt identity comparison covers both packed package inventories", () => {
  const expected = {
    knowledgeVersion: "2026.08.0",
    packageSha256: "1".repeat(64),
    ruleRegistrySha256: "2".repeat(64),
    version: "1.0.0-rc.1",
  };
  const rebuilt = {
    engineVersion: expected.version,
    knowledgeVersion: expected.knowledgeVersion,
    packageSha256: expected.packageSha256,
    ruleRegistrySha256: expected.ruleRegistrySha256,
  };
  assert.deepEqual(compareRebuiltEngineIdentity(expected, rebuilt), expected);
  assert.throws(
    () => compareRebuiltEngineIdentity(expected, { ...rebuilt, packageSha256: "3".repeat(64) }),
    /CLI\/core bytes differ/u,
  );
});

test("source-replay network guard denies import-free global networking", async () => {
  const guard = pathToFileURL(
    path.resolve("tools/metadata-calibration/build-network-guard.mjs"),
  ).href;
  for (const expression of [
    'await fetch("https://example.invalid/")',
    'new WebSocket("wss://example.invalid/")',
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", guard, "--input-type=module", "--eval", expression],
      { encoding: "utf8", shell: false },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /K03 source replay attempted a denied network capability/u);
  }
  assert.match(
    await readFile(new URL("./build-network-guard.mjs", import.meta.url), "utf8"),
    /fetch/u,
  );
});

async function injectedReplay({
  drift = false,
  identityMismatch = false,
  reportBytes = Buffer.from("report\n"),
} = {}) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "k03-replay-source-"));
  const corpusBytes = Buffer.from("corpus\n");
  const engine = {
    commitSha: "1".repeat(40),
    knowledgeVersion: "2026.08.0",
    packageSha256: "2".repeat(64),
    ruleRegistrySha256: "3".repeat(64),
    version: "1.0.0-rc.1",
  };
  let inventoryCall = 0;
  const invocations = [];
  const previousPnpm = process.env.npm_execpath;
  process.env.npm_execpath = path.resolve("package.json");
  const pnpmSha256 = createHash("sha256")
    .update(await readFile(process.env.npm_execpath))
    .digest("hex");
  try {
    const result = await replayFinalSource(
      {
        engine,
        evidenceCommitSha: "4".repeat(40),
        gitExecutable: "/usr/bin/git",
        nativeProof: {
          status: "ready",
          tools: {
            pnpm: { path: process.env.npm_execpath, sha256: pnpmSha256, version: "11.18.0" },
            tar: { sha256: "0".repeat(64) },
          },
        },
        nodeExecutable: process.execPath,
        regressionTests: [{ path: "calibration/regressions/k03-replay.test.mjs" }],
        repositoryRoot,
        seededCorpusBytes: corpusBytes,
        seededReportBytes: Buffer.from("report\n"),
      },
      {
        createConfinement: () => () => null,
        verifySourceSubset: async () => {},
        extractRuntime: async (_pack, replayRoot) => {
          const runtime = path.join(replayRoot, "fake-runtime");
          await mkdir(path.join(runtime, "cli/dist"), { recursive: true });
          await writeFile(path.join(runtime, "cli/dist/cli.js"), "// fake\n");
          return runtime;
        },
        inspectEngine: async () => ({
          engineVersion: engine.version,
          knowledgeVersion: engine.knowledgeVersion,
          packageSha256: identityMismatch ? "9".repeat(64) : engine.packageSha256,
          ruleRegistrySha256: engine.ruleRegistrySha256,
        }),
        inspectSource: async () => ({
          sha256: drift && inventoryCall++ > 0 ? "b".repeat(64) : "a".repeat(64),
        }),
        materializeSource: async () => ({
          inventory: { sha256: "c".repeat(64) },
          root: repositoryRoot,
          sourcePaths: [],
        }),
        packRuntime: async (packRoot) => {
          const cleanRoot = path.join(packRoot, "clean-root");
          await mkdir(path.join(cleanRoot, "calibration/regressions"), { recursive: true });
          await mkdir(path.join(cleanRoot, "calibration/seeded-recall/v0"), {
            recursive: true,
          });
          await mkdir(path.join(cleanRoot, "tools/seeded-recall"), { recursive: true });
          await writeFile(
            path.join(cleanRoot, "calibration/regressions/k03-replay.test.mjs"),
            'import test from "node:test"; test("actual replay regression", () => {});\n',
          );
          await writeFile(
            path.join(cleanRoot, "tools/seeded-recall/typescript-loader.mjs"),
            "// imported replay loader fixture\n",
          );
          await writeFile(
            path.join(cleanRoot, "tools/seeded-recall/run.mjs"),
            'process.stdout.write("injected F16 replay ran\\n");\n',
          );
          await writeFile(
            path.join(cleanRoot, "calibration/seeded-recall/v0/corpus.json"),
            corpusBytes,
          );
          await writeFile(
            path.join(cleanRoot, "calibration/seeded-recall/v0/report.json"),
            reportBytes,
          );
          return { cleanRoot };
        },
        runBoundedCommand: async () => ({
          signal: null,
          status: 0,
          stderr: "",
          stdout: "11.18.0\n",
        }),
        runReplayCommand: async (...arguments_) => {
          invocations.push(arguments_[1]);
          return _test.runReplayCommand(...arguments_);
        },
      },
    );
    return { invocations, result };
  } finally {
    if (previousPnpm === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousPnpm;
  }
}

test("replayFinalSource actually executes the exact regression and F16 commands", async () => {
  const replay = await injectedReplay();
  assert.equal(replay.result.sourceInventorySha256, "c".repeat(64));
  assert.deepEqual(replay.invocations, [
    ["--test", "--test-isolation=none", "calibration/regressions/k03-replay.test.mjs"],
    [
      "--experimental-strip-types",
      "--import",
      "./tools/seeded-recall/typescript-loader.mjs",
      "./tools/seeded-recall/run.mjs",
    ],
  ]);
});

test("replayFinalSource rejects source drift and reconstructed F16 byte drift", async () => {
  await assert.rejects(injectedReplay({ drift: true }), /source inventory changed/u);
  await assert.rejects(
    injectedReplay({ identityMismatch: true }),
    /rebuilt CLI\/core bytes differ/u,
  );
  await assert.rejects(
    injectedReplay({ reportBytes: Buffer.from("mutated report\n") }),
    /clean F16 artifacts differ/u,
  );
});

test("reviewed build permissions allow required children but deny network, detached children, and write escape", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "k03-build-permissions-"));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const allowed = path.join(parent, "allowed");
  const outside = path.join(parent, "outside.txt");
  await mkdir(allowed);
  const environment = _test.replayEnvironment(allowed, {
    allowChildProcesses: true,
    allowWrites: true,
  });
  const childWrite = path.join(allowed, "child-write.txt");
  const success = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { spawnSync } from "node:child_process"; const result = spawnSync(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(childWrite)}, "ok\\n");`)}], { encoding: "utf8", env: process.env }); if (result.status !== 0) throw new Error(result.stderr);`,
    ],
    { encoding: "utf8", env: environment, shell: false },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.equal(await readFile(childWrite, "utf8"), "ok\n");
  for (const expression of [
    'await fetch("https://example.invalid/")',
    'import { spawn } from "node:child_process"; spawn(process.execPath, ["--version"], { detached: true });',
    'import { execFile } from "node:child_process"; execFile(process.execPath, ["--version"], { detached: true }, () => {});',
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(outside)}, "denied");`,
  ]) {
    const denied = spawnSync(process.execPath, ["--input-type=module", "--eval", expression], {
      encoding: "utf8",
      env: environment,
      shell: false,
    });
    assert.notEqual(denied.status, 0);
  }
  await assert.rejects(readFile(outside), { code: "ENOENT" });
});
