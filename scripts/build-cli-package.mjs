import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildCliBundle } from "./build-cli-bundle.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDirectory = path.join(rootDirectory, "packages/cli");
const publishDirectory = path.join(cliDirectory, "publish");
const compareUtf8 = (left, right) =>
  Math.sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => [key, canonicalize(value[key])]),
    );
  return value;
}

function compileWorkspace() {
  const node =
    process.env.AGENT_CONTEXT_PACK_NODE ?? path.join(rootDirectory, "node_modules/node/bin/node");
  if (!path.isAbsolute(node)) throw new Error("production Node executable must be absolute");
  const tsc = path.join(rootDirectory, "node_modules/@typescript/native/bin/tsc");
  const result = spawnSync(node, [tsc, "-b", "--pretty", "false"], {
    cwd: rootDirectory,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`production TypeScript build failed:\n${result.stderr || result.stdout}`);
}

async function createPublishManifest() {
  const [manifest, coreManifest] = await Promise.all([
    readFile(path.join(cliDirectory, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(rootDirectory, "packages/core/package.json"), "utf8").then(JSON.parse),
  ]);
  delete manifest.devDependencies;
  delete manifest.files;
  delete manifest.scripts;
  manifest.dependencies = { "@agent-context/core": coreManifest.version };
  manifest.publishConfig = { access: manifest.publishConfig.access };
  return `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;
}

export async function buildCliPackage() {
  compileWorkspace();
  await buildCliBundle();
  await rm(publishDirectory, { force: true, recursive: true });
  await mkdir(publishDirectory, { recursive: true });
  for (const relativePath of ["LICENSE", "NOTICE"])
    await cp(path.join(rootDirectory, relativePath), path.join(publishDirectory, relativePath));
  for (const relativePath of [
    "README.md",
    "THIRD_PARTY_NOTICES",
    "bundled",
    "completions",
    "git-runtime",
    "man",
    "reference",
    "schemas",
  ])
    await cp(path.join(cliDirectory, relativePath), path.join(publishDirectory, relativePath), {
      recursive: true,
    });
  await mkdir(path.join(publishDirectory, "dist"), { recursive: true });
  for (const file of [
    "cli.js",
    "cli.js.map",
    "cli.meta.json",
    "index.d.ts",
    "index.d.ts.map",
    "index.js",
    "index.js.map",
    "library-api.d.ts",
    "library-api.d.ts.map",
    "library-api.js",
    "library-api.js.map",
  ])
    await cp(path.join(cliDirectory, "dist", file), path.join(publishDirectory, "dist", file));
  await writeFile(path.join(publishDirectory, "package.json"), await createPublishManifest());
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildCliPackage();
