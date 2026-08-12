import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import {
  auditBundleContents,
  auditBundleMetafile,
  createThirdPartyNotices,
} from "./build-cli-bundle.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const actionDirectory = path.join(rootDirectory, "action");
const outputPath = path.join(actionDirectory, "dist", "index.js");
const copies = Object.freeze([
  [path.join(rootDirectory, "packages", "standards", "bundled"), "bundled"],
  [path.join(rootDirectory, "packages", "cli", "git-runtime"), "git-runtime"],
]);
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function auditActionBundleContents(bundle) {
  auditBundleContents(bundle);
}

export function assertSameActionBuilds(first, second) {
  for (const key of ["artifact", "metafile", "notices"]) {
    const left = first?.[key];
    const right = second?.[key];
    if (
      (typeof left !== "string" && !Buffer.isBuffer(left) && !(left instanceof Uint8Array)) ||
      (typeof right !== "string" && !Buffer.isBuffer(right) && !(right instanceof Uint8Array)) ||
      sha256(left) !== sha256(right)
    )
      throw new Error(`non-deterministic GitHub Action build artifact: ${key}`);
  }
}

export function typescriptBuildInvocation(nodeExecutable = process.execPath) {
  if (typeof nodeExecutable !== "string" || !path.isAbsolute(nodeExecutable))
    throw new Error("TypeScript build requires an absolute current Node executable");
  const tsc = path.join(rootDirectory, "node_modules", "@typescript", "native", "bin", "tsc");
  return Object.freeze({
    arguments: Object.freeze([tsc, "-b", "--pretty", "false"]),
    executable: nodeExecutable,
  });
}

function compileWorkspace() {
  const invocation = typescriptBuildInvocation();
  const result = spawnSync(invocation.executable, invocation.arguments, {
    cwd: rootDirectory,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`production TypeScript build failed:\n${result.stderr || result.stdout}`);
}

async function bundleOnce() {
  const result = await build({
    absWorkingDir: rootDirectory,
    banner: {
      js: 'import { createRequire as __agentContextCreateRequire } from "node:module"; const require = __agentContextCreateRequire(import.meta.url);',
    },
    bundle: true,
    charset: "utf8",
    entryPoints: ["action/src/index.mjs"],
    external: ["node:*"],
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    minify: false,
    outfile: "action/dist/index.js",
    packages: "bundle",
    platform: "node",
    sourcemap: false,
    target: "node24",
    treeShaking: true,
    write: false,
  });
  if (result.warnings.length > 0)
    throw new Error(`GitHub Action bundle warnings: ${JSON.stringify(result.warnings)}`);
  auditBundleMetafile(result.metafile);
  const output = result.outputFiles.find((file) => path.resolve(file.path) === outputPath);
  if (output === undefined || result.outputFiles.length !== 1)
    throw new Error("GitHub Action build produced an unexpected artifact inventory");
  auditActionBundleContents(Buffer.from(output.contents).toString("utf8"));
  const notices = (await createThirdPartyNotices(result.metafile)).replace(
    "embedded in dist/cli.js",
    "embedded in action/dist/index.js",
  );
  const metafile = `${JSON.stringify(canonicalize(result.metafile), null, 2)}\n`;
  return Object.freeze({ artifact: output.contents, metafile, notices });
}

async function filesBelow(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    const relative = path.posix.join(prefix.split(path.sep).join("/"), entry.name);
    const absolute = path.join(root, ...relative.split("/"));
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink())
      throw new Error(`action asset must not be symbolic: ${relative}`);
    if (metadata.isDirectory()) files.push(...(await filesBelow(root, relative)));
    else if (metadata.isFile()) files.push(relative);
    else throw new Error(`action asset must be a regular file: ${relative}`);
  }
  return files;
}

export async function assertOrdinaryActionFile(target, label = target) {
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`GitHub Action ${label} must be an ordinary non-symbolic file`);
}

export async function compareActionAssetCopy(source, destination) {
  const sourceMetadata = await lstat(source);
  if (sourceMetadata.isFile()) {
    await assertOrdinaryActionFile(destination, "asset destination");
    const [expected, actual] = await Promise.all([readFile(source), readFile(destination)]);
    if (!expected.equals(actual)) throw new Error(`stale GitHub Action asset: ${destination}`);
    return;
  }
  if (!sourceMetadata.isDirectory())
    throw new Error(`invalid GitHub Action source asset: ${source}`);
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink())
    throw new Error(`GitHub Action asset destination is not a real directory: ${destination}`);
  const [expectedFiles, actualFiles] = await Promise.all([
    filesBelow(source),
    filesBelow(destination),
  ]);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles))
    throw new Error(`stale GitHub Action asset inventory: ${destination}`);
  for (const relative of expectedFiles) {
    const [expected, actual] = await Promise.all([
      readFile(path.join(source, ...relative.split("/"))),
      readFile(path.join(destination, ...relative.split("/"))),
    ]);
    if (!expected.equals(actual))
      throw new Error(`stale GitHub Action asset: ${path.join(destination, relative)}`);
  }
}

export async function buildGithubAction(mode) {
  if (mode !== "check" && mode !== "write") throw new Error("mode must be check or write");
  compileWorkspace();
  const first = await bundleOnce();
  const second = await bundleOnce();
  assertSameActionBuilds(first, second);
  const { artifact, notices } = first;
  if (mode === "write") {
    await rm(path.join(actionDirectory, "dist"), { force: true, recursive: true });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, artifact);
    await writeFile(path.join(actionDirectory, "THIRD_PARTY_NOTICES"), notices);
    for (const [source, relative] of copies) {
      const destination = path.join(actionDirectory, relative);
      await rm(destination, { force: true, recursive: true });
      await cp(source, destination, { recursive: true });
      await compareActionAssetCopy(source, destination);
    }
    return;
  }
  await Promise.all([
    assertOrdinaryActionFile(outputPath, "committed bundle"),
    assertOrdinaryActionFile(
      path.join(actionDirectory, "THIRD_PARTY_NOTICES"),
      "committed notices",
    ),
  ]);
  const committed = await readFile(outputPath);
  if (!Buffer.from(artifact).equals(committed))
    throw new Error("committed GitHub Action bundle is stale; run pnpm action:build");
  if ((await readFile(path.join(actionDirectory, "THIRD_PARTY_NOTICES"), "utf8")) !== notices)
    throw new Error("committed GitHub Action third-party notices are stale");
  for (const [source, relative] of copies)
    await compareActionAssetCopy(source, path.join(actionDirectory, relative));
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode =
    process.argv[2] === "--write" ? "write" : process.argv[2] === "--check" ? "check" : null;
  if (mode === null || process.argv.length !== 3)
    throw new Error("usage: build-github-action.mjs --write|--check");
  await buildGithubAction(mode);
  console.log(`GitHub Action ${mode === "write" ? "built" : "artifact verified"}.`);
}
