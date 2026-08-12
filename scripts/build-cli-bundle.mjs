import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(rootDirectory, "packages/cli/dist");
const standardsDirectory = path.join(rootDirectory, "packages/standards/bundled");
const cliStandardsDirectory = path.join(rootDirectory, "packages/cli/bundled");
const noticesPath = path.join(rootDirectory, "packages/cli/THIRD_PARTY_NOTICES");
const metafilePath = path.join(outputDirectory, "cli.meta.json");
const forbiddenUnbundledOutputs = [
  path.join(outputDirectory, "bounded-output.d.ts"),
  path.join(outputDirectory, "bounded-output.d.ts.map"),
  path.join(outputDirectory, "bounded-output.js"),
  path.join(outputDirectory, "bounded-output.js.map"),
  path.join(outputDirectory, "git-metadata-executor.d.ts"),
  path.join(outputDirectory, "git-metadata-executor.d.ts.map"),
  path.join(outputDirectory, "git-metadata-executor.js"),
  path.join(outputDirectory, "git-metadata-executor.js.map"),
  path.join(outputDirectory, "git-metadata-executor-production.d.ts"),
  path.join(outputDirectory, "git-metadata-executor-production.d.ts.map"),
  path.join(outputDirectory, "git-metadata-executor-production.js"),
  path.join(outputDirectory, "git-metadata-executor-production.js.map"),
  path.join(outputDirectory, "scan-command.js"),
  path.join(outputDirectory, "scan-command.js.map"),
  path.join(outputDirectory, "scan-command.meta.json"),
];
const allowedExternalPackage = "@agent-context/core";
const nodeBuiltins = new Set(builtinModules.map((specifier) => specifier.replace(/^node:/u, "")));
const forbiddenNetworkBuiltins = new Set([
  "dgram",
  "dns",
  "dns/promises",
  "http",
  "http2",
  "https",
  "net",
  "tls",
]);
// Standards `check` and `update` are the only CLI operations permitted to use network/cache
// capabilities. Keep this allowlist source-scoped so normal scan/help code remains offline.
const standardsNetworkInputs = new Set([
  "packages/standards/src/registry-client.ts",
  "packages/standards/src/standards-cache.ts",
  "packages/standards/dist/registry-client.js",
  "packages/standards/dist/standards-cache.js",
]);

export async function removeForbiddenUnbundledOutputs(outputs) {
  for (const forbiddenOutput of outputs) await rm(forbiddenOutput, { force: true });
}

export async function assertForbiddenUnbundledOutputsAbsent(outputs) {
  for (const forbiddenOutput of outputs) {
    try {
      await lstat(forbiddenOutput);
      throw new Error(
        `unbundled private executable module remains in dist: ${path.basename(forbiddenOutput)}`,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

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

export function isAbsoluteOrEscaping(candidate) {
  const normalized = candidate.replaceAll("\\", "/");
  return (
    path.isAbsolute(candidate) ||
    candidate.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(candidate) ||
    normalized.split("/").includes("..")
  );
}

export function resolveContainedPath(root, candidate) {
  if (isAbsoluteOrEscaping(candidate)) throw new Error(`unsafe build path: ${candidate}`);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."))
    return resolved;
  throw new Error(`build path escapes its root: ${candidate}`);
}

function isAbsoluteBuildPath(candidate) {
  return (
    path.isAbsolute(candidate) ||
    /^[A-Za-z]:[\\/]/u.test(candidate) ||
    candidate.startsWith("file:")
  );
}

function isAllowedExternal(specifier) {
  return specifier === allowedExternalPackage || nodeBuiltins.has(specifier.replace(/^node:/u, ""));
}

export function auditBundleMetafile(metafile) {
  const failures = [];
  for (const [inputPath, input] of Object.entries(metafile.inputs ?? {})) {
    if (isAbsoluteOrEscaping(inputPath)) failures.push(`absolute or escaping input: ${inputPath}`);
    for (const imported of input.imports ?? []) {
      if (
        imported.path.replace(/^node:/u, "") === "child_process" &&
        (!inputPath.endsWith("packages/cli/src/git-metadata-executor.ts") ||
          imported.kind !== "dynamic-import")
      )
        failures.push(`process capability outside explicit changed mode: ${inputPath}`);
      if (
        forbiddenNetworkBuiltins.has(imported.path.replace(/^node:/u, "")) &&
        !standardsNetworkInputs.has(inputPath.replaceAll("\\", "/"))
      )
        failures.push(`network-capable builtin outside standards operation: ${imported.path}`);
      if (imported.external && !isAllowedExternal(imported.path))
        failures.push(`undeclared external import: ${imported.path}`);
    }
  }
  for (const [outputPath, output] of Object.entries(metafile.outputs ?? {})) {
    const outputUsesStandardsNetworkSource = Object.entries(output.inputs ?? {}).some(
      ([inputPath, contribution]) =>
        standardsNetworkInputs.has(inputPath.replaceAll("\\", "/")) &&
        contribution?.bytesInOutput > 0,
    );
    if (isAbsoluteOrEscaping(outputPath))
      failures.push(`absolute or escaping output: ${outputPath}`);
    for (const imported of output.imports ?? []) {
      if (
        imported.path.replace(/^node:/u, "") === "child_process" &&
        imported.kind !== "dynamic-import"
      )
        failures.push(`eager process capability in offline CLI: ${imported.path}`);
      const networkBuiltin = forbiddenNetworkBuiltins.has(imported.path.replace(/^node:/u, ""));
      if (
        networkBuiltin &&
        (outputPath !== "packages/cli/dist/cli.js" || !outputUsesStandardsNetworkSource)
      )
        failures.push(`network-capable builtin outside standards operation: ${imported.path}`);
      if (!imported.external || !isAllowedExternal(imported.path))
        failures.push(`residual output import: ${imported.path}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`CLI bundle is not closed:\n${failures.sort(compareUtf8).join("\n")}`);
  }
}

async function findPackageRoot(inputPath) {
  let candidate = path.dirname(path.resolve(rootDirectory, inputPath));
  const workspaceRoot = await realpath(rootDirectory);
  while (candidate.startsWith(workspaceRoot)) {
    try {
      const manifestPath = path.join(candidate, "package.json");
      if ((await stat(manifestPath)).isFile()) {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (typeof manifest.name === "string" && typeof manifest.version === "string")
          return candidate;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`cannot locate package metadata for bundled input: ${inputPath}`);
}

async function licenseFiles(packageRoot) {
  const files = [];
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (entry.isFile() && /^(?:licen[cs]e|notice|copying)(?:\..*)?$/iu.test(entry.name))
      files.push(entry.name);
  }
  return files.sort(compareUtf8);
}

function normalizeNoticeText(text, label) {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  // eslint-disable-next-line no-control-regex -- release notices reject unsafe controls.
  if (/\u0000|\u001b|[\u202a-\u202e\u2066-\u2069]/u.test(normalized))
    throw new Error(`unsafe control character in ${label}`);
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

export async function createThirdPartyNotices(metafile) {
  const packages = new Map();
  for (const inputPath of contributingThirdPartyInputs(metafile)) {
    if (!inputPath.includes("node_modules/")) continue;
    const packageRoot = await findPackageRoot(inputPath);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string" ||
      typeof manifest.license !== "string" ||
      manifest.license.trim() === ""
    )
      throw new Error(`incomplete package metadata for bundled input: ${inputPath}`);
    const files = await licenseFiles(packageRoot);
    if (files.length === 0)
      throw new Error(`bundled package ${manifest.name}@${manifest.version} has no license text`);
    const key = `${manifest.name}@${manifest.version}`;
    const existing = packages.get(key);
    if (existing !== undefined && existing.packageRoot !== packageRoot)
      throw new Error(`multiple package roots resolve to ${key}`);
    packages.set(key, {
      files,
      license: manifest.license,
      name: manifest.name,
      packageRoot,
      version: manifest.version,
    });
  }
  if (packages.size === 0) throw new Error("CLI bundle unexpectedly contains no third-party code");

  const sections = [
    "THIRD-PARTY NOTICES",
    "",
    "This file is generated from the exact packages embedded in dist/cli.js.",
    "Do not edit it by hand.",
    "",
  ];
  for (const key of [...packages.keys()].sort(compareUtf8)) {
    const entry = packages.get(key);
    sections.push(`Package: ${entry.name}@${entry.version}`, `License: ${entry.license}`, "");
    for (const file of entry.files) {
      sections.push(`----- ${file} -----`);
      sections.push(
        normalizeNoticeText(
          await readFile(path.join(entry.packageRoot, file), "utf8"),
          `${key}/${file}`,
        ).trimEnd(),
        "",
      );
    }
  }
  return `${sections.join("\n").trimEnd()}\n`;
}

export function contributingThirdPartyInputs(metafile) {
  const inputs = new Set(Object.keys(metafile.inputs ?? {}));
  const contributed = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const [inputPath, contribution] of Object.entries(output.inputs ?? {})) {
      if (!inputs.has(inputPath))
        throw new Error(`bundle output contribution has no input metadata: ${inputPath}`);
      if (
        typeof contribution.bytesInOutput !== "number" ||
        !Number.isSafeInteger(contribution.bytesInOutput) ||
        contribution.bytesInOutput < 0
      )
        throw new Error(`invalid bundle output contribution: ${inputPath}`);
      if (contribution.bytesInOutput > 0 && inputPath.includes("node_modules/"))
        contributed.add(inputPath);
    }
  }
  return [...contributed].sort(compareUtf8);
}

export function auditBundleContents(bundle) {
  if (typeof bundle !== "string") throw new TypeError("CLI bundle contents must be text");
  for (const forbidden of ["bindMetadataFileWithinForTest", "reference binding test"])
    if (bundle.includes(forbidden))
      throw new Error(`CLI bundle retains an internal test seam: ${forbidden}`);
  for (const required of ["createNodeGitMetadataExecutor", "Git metadata output limit is invalid"])
    if (!bundle.includes(required))
      throw new Error(`CLI bundle omits the production Git executor: ${required}`);
}

async function buildOnce() {
  const result = await build({
    absWorkingDir: rootDirectory,
    banner: {
      js: 'import { createRequire as __agentContextCreateRequire } from "node:module"; const require = __agentContextCreateRequire(import.meta.url);',
    },
    bundle: true,
    charset: "utf8",
    entryPoints: ["packages/cli/src/cli.ts"],
    external: [allowedExternalPackage, "node:*"],
    format: "esm",
    legalComments: "external",
    logLevel: "silent",
    metafile: true,
    minify: false,
    outfile: "packages/cli/dist/cli.js",
    packages: "bundle",
    platform: "node",
    sourcemap: "external",
    sourcesContent: false,
    target: "node24",
    treeShaking: true,
    write: false,
  });
  if (result.warnings.length > 0)
    throw new Error(`esbuild emitted warnings: ${JSON.stringify(result.warnings)}`);
  auditBundleMetafile(result.metafile);

  const artifacts = new Map();
  for (const output of result.outputFiles) {
    const relativePath = path.relative(rootDirectory, output.path).split(path.sep).join("/");
    if (isAbsoluteOrEscaping(relativePath))
      throw new Error(`esbuild produced an unsafe artifact path: ${relativePath}`);
    artifacts.set(relativePath, output.contents);
  }
  auditBundleContents(
    Buffer.from(artifacts.get("packages/cli/dist/cli.js") ?? []).toString("utf8"),
  );
  const sourceMapPath = "packages/cli/dist/cli.js.map";
  const sourceMap = JSON.parse(Buffer.from(artifacts.get(sourceMapPath) ?? []).toString("utf8"));
  for (const source of sourceMap.sources ?? []) {
    if (isAbsoluteBuildPath(source)) throw new Error(`absolute path in source map: ${source}`);
  }
  const notice = await createThirdPartyNotices(result.metafile);
  artifacts.set(
    path.relative(rootDirectory, noticesPath).split(path.sep).join("/"),
    Buffer.from(notice, "utf8"),
  );
  artifacts.set(
    path.relative(rootDirectory, metafilePath).split(path.sep).join("/"),
    Buffer.from(`${JSON.stringify(canonicalize(result.metafile), null, 2)}\n`, "utf8"),
  );
  return artifacts;
}

function assertSameArtifacts(first, second) {
  const paths = new Set([...first.keys(), ...second.keys()]);
  for (const artifactPath of [...paths].sort(compareUtf8)) {
    const firstBytes = first.get(artifactPath);
    const secondBytes = second.get(artifactPath);
    if (
      firstBytes === undefined ||
      secondBytes === undefined ||
      sha256(firstBytes) !== sha256(secondBytes)
    )
      throw new Error(`non-deterministic CLI bundle artifact: ${artifactPath}`);
  }
}

async function listFiles(root, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link in standards trust tree: ${child}`);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`non-regular standards trust-tree entry: ${child}`);
  }
  return files.sort(compareUtf8);
}

async function assertExactTree(source, destination) {
  const [sourceFiles, destinationFiles] = await Promise.all([
    listFiles(source),
    listFiles(destination),
  ]);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles))
    throw new Error("CLI bundled standards inventory differs from the signed source tree");
  for (const relativePath of sourceFiles) {
    const [sourceBytes, destinationBytes] = await Promise.all([
      readFile(path.join(source, relativePath)),
      readFile(path.join(destination, relativePath)),
    ]);
    if (sha256(sourceBytes) !== sha256(destinationBytes))
      throw new Error(`CLI bundled standards bytes differ: ${relativePath}`);
  }
}

async function writeArtifacts(artifacts) {
  await mkdir(outputDirectory, { recursive: true });
  for (const [relativePath, bytes] of artifacts) {
    const absolutePath = resolveContainedPath(rootDirectory, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
  }
  await removeForbiddenUnbundledOutputs(forbiddenUnbundledOutputs);
  await rm(cliStandardsDirectory, { force: true, recursive: true });
  await cp(standardsDirectory, cliStandardsDirectory, { recursive: true });
  await assertExactTree(standardsDirectory, cliStandardsDirectory);
}

async function checkArtifacts(artifacts) {
  for (const [relativePath, expected] of artifacts) {
    let actual;
    try {
      actual = await readFile(resolveContainedPath(rootDirectory, relativePath));
    } catch (error) {
      if (error?.code === "ENOENT")
        throw new Error(`missing CLI bundle artifact: ${relativePath}`, { cause: error });
      throw error;
    }
    if (sha256(actual) !== sha256(expected))
      throw new Error(`stale CLI bundle artifact: ${relativePath}`);
  }
  await assertForbiddenUnbundledOutputsAbsent(forbiddenUnbundledOutputs);
  const destinationStat = await lstat(cliStandardsDirectory);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink())
    throw new Error("CLI bundled standards path is not a real directory");
  await assertExactTree(standardsDirectory, cliStandardsDirectory);
}

export async function buildCliBundle({ check = false } = {}) {
  const first = await buildOnce();
  const second = await buildOnce();
  assertSameArtifacts(first, second);
  if (check) await checkArtifacts(first);
  else await writeArtifacts(first);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const argument = process.argv[2] ?? "--check";
  if (!new Set(["--check", "--write"]).has(argument) || process.argv.length > 3)
    throw new Error("usage: node scripts/build-cli-bundle.mjs [--check|--write]");
  await buildCliBundle({ check: argument === "--check" });
}
