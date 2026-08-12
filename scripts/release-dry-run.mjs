import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicPackages = [
  ["@agent-context/core", "packages/core"],
  ["@agent-context/lint", "packages/cli"],
];

function spawn(command, arguments_, cwd, env = process.env) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8", env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

async function releaseInputs(rootDirectory) {
  const packageNames = (
    await readdir(path.join(rootDirectory, "packages"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const tokenizerNames = (
    await readdir(path.join(rootDirectory, "optional-tokenizers"), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return [
    ".changeset",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ...packageNames.map((name) => `packages/${name}/package.json`),
    ...tokenizerNames.map((name) => `optional-tokenizers/${name}/package.json`),
  ].sort();
}

async function digestInputs(rootDirectory, inputs) {
  const hash = createHash("sha256");
  async function add(relative) {
    const absolute = path.join(rootDirectory, relative);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => undefined);
    if (entries !== undefined) {
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
        await add(path.join(relative, entry.name));
      return;
    }
    hash.update(relative.replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(await readFile(absolute));
    hash.update("\0");
  }
  for (const input of inputs) await add(input);
  return hash.digest("hex");
}

async function makeFixture(rootDirectory, destination, inputs) {
  for (const relative of inputs) {
    const source = path.join(rootDirectory, relative);
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
  spawn("git", ["init", "--quiet", "--initial-branch=main"], destination);
  spawn("git", ["config", "user.name", "Release Dry Run"], destination);
  spawn("git", ["config", "user.email", "release-dry-run.invalid@example.invalid"], destination);
  spawn("git", ["add", "."], destination);
  spawn("git", ["commit", "--quiet", "-m", "release dry-run fixture"], destination);
}

async function runOnce(rootDirectory, changesetsCli, inputs) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-context-release-dry-run-"));
  try {
    await makeFixture(rootDirectory, fixture, inputs);
    const statusPath = path.join(fixture, "status.json");
    const environment = { ...process.env, CI: "true", npm_config_offline: "true" };
    spawn(
      process.execPath,
      [changesetsCli, "status", "--output", statusPath],
      fixture,
      environment,
    );
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    const releases = status.releases
      .filter((release) => release.type !== "none")
      .map(({ name, oldVersion, newVersion, type }) => ({ name, oldVersion, newVersion, type }));
    if (releases.length === 0) return { releases: [], changelogs: {} };

    spawn(process.execPath, [changesetsCli, "version"], fixture, environment);
    const changelogs = {};
    for (const [name, directory] of publicPackages) {
      const release = releases.find((entry) => entry.name === name);
      if (release === undefined) continue;
      const manifest = JSON.parse(
        await readFile(path.join(fixture, directory, "package.json"), "utf8"),
      );
      if (manifest.version !== release.newVersion)
        throw new Error(`${name} dry-run version is incoherent`);
      const changelog = await readFile(path.join(fixture, directory, "CHANGELOG.md"), "utf8");
      if (!changelog.includes(`## ${release.newVersion}`) || !changelog.includes("- Added:")) {
        throw new Error(`${name} dry-run changelog is incomplete or non-conventional`);
      }
      changelogs[name] = changelog;
    }
    for (const release of releases) {
      if (release.oldVersion === "0.0.0" && release.newVersion !== "1.0.0") {
        throw new Error(`${release.name} initial release must be 1.0.0`);
      }
    }
    return { releases, changelogs };
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
}

export async function runReleaseDryRun(rootDirectory = defaultRoot) {
  const inputs = await releaseInputs(rootDirectory);
  const before = await digestInputs(rootDirectory, inputs);
  const changesetsCli = path.join(defaultRoot, "node_modules/@changesets/cli/bin.js");
  const first = await runOnce(rootDirectory, changesetsCli, inputs);
  const second = await runOnce(rootDirectory, changesetsCli, inputs);
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("release dry run is nondeterministic");
  const after = await digestInputs(rootDirectory, inputs);
  if (before !== after) throw new Error("release dry run modified the source checkout");
  return first;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await runReleaseDryRun();
  console.log(
    result.releases.length === 0
      ? "No release is pending; checkout remained unchanged."
      : `Dry run produced ${result.releases.map((entry) => `${entry.name}@${entry.newVersion}`).join(", ")}; checkout remained unchanged.`,
  );
}
