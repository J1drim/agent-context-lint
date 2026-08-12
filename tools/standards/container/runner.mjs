import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const input = "/input";
const workspace = "/workspace";
const dependencySource = "/opt/h13/repo";
const tools = Object.freeze({
  git: "/usr/bin/git",
  node: "/usr/local/bin/node",
  pnpm: "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
  shell: "/bin/sh",
  tar: "/usr/bin/tar",
});

async function copyCurrentSource(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".h13-runtime-inputs" ||
      entry.name.startsWith(".h13-runtime-inputs.prepare-")
    )
      continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`H13 input contains a symbolic link: ${from}`);
    if (entry.isDirectory()) await copyCurrentSource(from, to);
    else if (entry.isFile()) await cp(from, to, { errorOnExist: true, force: false });
    else throw new Error(`H13 input contains a non-regular path: ${from}`);
  }
}

async function copyDependencyTrees(source, relative = "") {
  const directory = path.join(source, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" && entry.isDirectory()) {
      await cp(path.join(directory, entry.name), path.join(workspace, relative, entry.name), {
        dereference: false,
        recursive: true,
        verbatimSymlinks: true,
      });
      continue;
    }
    if (entry.isDirectory() && entry.name !== ".git")
      await copyDependencyTrees(source, path.join(relative, entry.name));
  }
}

async function run(executable, arguments_, environment = process.env) {
  const child = spawn(executable, arguments_, {
    cwd: workspace,
    env: environment,
    shell: false,
    stdio: "inherit",
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  if (result.signal !== null || result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

if (process.argv.length < 4 || process.argv[2] !== "--command")
  throw new Error(
    "usage: runner.mjs --command <inspect-tools|tuf-trust|standards-tools|package-audit>",
  );
const command = process.argv[3];
await mkdir(workspace, { recursive: true });
await copyCurrentSource(input, workspace);
await copyDependencyTrees(dependencySource);

const environment = {
  ...process.env,
  AGENT_CONTEXT_H13_CONTAINED: "1",
  AGENT_CONTEXT_PACK_GIT: tools.git,
  AGENT_CONTEXT_PACK_DEPENDENCY_SOURCE: dependencySource,
  AGENT_CONTEXT_PACK_NODE: tools.node,
  AGENT_CONTEXT_PACK_PNPM: tools.pnpm,
  AGENT_CONTEXT_PACK_SHELL: tools.shell,
  AGENT_CONTEXT_PACK_TAR: tools.tar,
  CI: "true",
  HOME: "/tmp/home",
  NO_COLOR: "1",
  npm_execpath: tools.pnpm,
  pnpm_config_enable_global_virtual_store: "false",
  PATH: "/usr/local/bin:/usr/bin:/bin",
};
await mkdir(environment.HOME, { recursive: true });
await rm(path.join(workspace, ".git"), { force: true, recursive: true });
await run(tools.git, ["init", "--quiet"], environment);
await run(tools.git, ["add", "--all"], environment);

if (command === "containment-adversary") {
  await new Promise(() => {
    const source = `process.on("SIGTERM",()=>{});setTimeout(()=>{try{require("node:fs").writeFileSync("/input/tools/standards/fixtures/recovery-mutation-sentinel.txt","escaped containment")}catch{}},500);for(;;)process.stdout.write("detached-output-overflow\\n")`;
    spawn(tools.node, ["-e", source], {
      cwd: workspace,
      detached: true,
      env: environment,
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    }).unref();
    setInterval(() => {}, 1_000);
  });
} else if (command === "inspect-tools") {
  const digest = async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  const packageVersion = async (file) => JSON.parse(await readFile(file, "utf8")).version;
  process.stdout.write(
    `${JSON.stringify({
      canonicalJson: await packageVersion(
        "packages/standards/node_modules/@tufjs/canonical-json/package.json",
      ),
      executables: {
        git: { path: tools.git, sha256: await digest(tools.git) },
        node: { path: tools.node, sha256: await digest(tools.node) },
        pnpm: { path: tools.pnpm, sha256: await digest(tools.pnpm) },
        shell: { path: tools.shell, sha256: await digest(tools.shell) },
        tar: { path: tools.tar, sha256: await digest(tools.tar) },
      },
      git: await new Promise((resolve, reject) => {
        const child = spawn(tools.git, ["--version"], { shell: false });
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve(output.trim()) : reject(new Error("git probe failed")),
        );
      }),
      node: process.versions.node,
      packageManager: "pnpm@11.18.0",
      pnpm: "11.18.0",
      tufModels: await packageVersion("packages/standards/node_modules/@tufjs/models/package.json"),
      typescript: await packageVersion("node_modules/typescript/package.json"),
      vitest: await packageVersion("node_modules/vitest/package.json"),
    })}\n`,
  );
} else if (command === "tuf-trust")
  await run(
    tools.node,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "packages/standards/test/tuf-trust.unit.test.ts",
      "--reporter=json",
    ],
    environment,
  );
else if (command === "standards-tools")
  await run(
    tools.node,
    [
      "--test",
      "--test-reporter=tap",
      "tools/standards/maintainer-review-bundle.test.mjs",
      "tools/standards/upstream-review.test.mjs",
      "tools/standards/upstream-snapshotter.test.mjs",
      "tools/standards/validate-maintainer-workflow.test.mjs",
    ],
    environment,
  );
else if (command === "package-audit")
  await run(tools.node, ["scripts/check-packed-manifests.mjs"], environment);
else throw new Error(`unsupported H13 command: ${command}`);
