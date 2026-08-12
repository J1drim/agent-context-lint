import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

import {
  canonicalJson,
  copyBoundedTree,
  copyBoundedProjectSource,
  createInputManifest,
  digest,
} from "./runtime-inputs.mjs";

const output = process.argv[2];
const networkInput = process.argv[3];
if (process.argv.length !== 4 || !path.isAbsolute(output) || !path.isAbsolute(networkInput))
  throw new Error("invalid output path");
const expectedIntegrity =
  "sha512-M9g8d9qC9J+6g2klxvG4QRgewxMrZwY5vQEvcHX1x89jTF+HAUfBmq50ePrAHfCdiJLogEVIlu3SPumzN1dWPA==";
const expectedSha1 = "6eb0fa6a5dc5ddfa7b802e612a99d7e25ab564a4";

async function run(executable, arguments_, environment = process.env, cwd = "/") {
  const child = spawn(executable, arguments_, {
    cwd,
    env: environment,
    shell: false,
    stdio: "inherit",
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal !== null)
    throw new Error(`runtime preparation failed: ${executable}`);
}

async function normalizeExportTar(archive, sourceDateEpoch) {
  const handle = await open(archive, "r+");
  try {
    const state = await handle.stat();
    if (!state.isFile() || state.size < 1_024 || state.size > 2 * 1024 * 1024 * 1024)
      throw new Error("base rootfs export exceeds its regular-file bounds");
    const header = Buffer.alloc(512);
    let entries = 0;
    let offset = 0;
    while (offset + 512 <= state.size) {
      const read = await handle.read(header, 0, header.length, offset);
      if (read.bytesRead !== header.length) throw new Error("base rootfs export is truncated");
      if (header.every((byte) => byte === 0)) break;
      entries += 1;
      if (entries > 100_000) throw new Error("base rootfs export exceeds its entry bound");
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
      if (name === "" || name.startsWith("/") || name.split("/").includes(".."))
        throw new Error("base rootfs export contains an unsafe member path");
      const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]);
      if (!["0", "1", "2", "5", "x"].includes(type))
        throw new Error("base rootfs export contains an unsupported member type");
      const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/su, "").trim();
      const size = Number.parseInt(sizeText === "" ? "0" : sizeText, 8);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > state.size)
        throw new Error("base rootfs export contains an invalid member size");
      if (type === "x") {
        if (size > 64 * 1024) throw new Error("base rootfs export PAX record exceeds its bound");
        const payload = Buffer.alloc(size);
        const payloadRead = await handle.read(payload, 0, size, offset + 512);
        if (payloadRead.bytesRead !== size)
          throw new Error("base rootfs export PAX record is truncated");
        let cursor = 0;
        while (cursor < payload.length) {
          const separator = payload.indexOf(0x20, cursor);
          if (separator < cursor + 1) throw new Error("base rootfs export PAX length is malformed");
          const lengthText = payload.subarray(cursor, separator).toString("ascii");
          if (!/^[0-9]+$/u.test(lengthText))
            throw new Error("base rootfs export PAX length is malformed");
          const length = Number.parseInt(lengthText, 10);
          const end = cursor + length;
          if (!Number.isSafeInteger(length) || end > payload.length || payload[end - 1] !== 0x0a)
            throw new Error("base rootfs export PAX framing is malformed");
          const assignment = payload.subarray(separator + 1, end - 1);
          const equals = assignment.indexOf(0x3d);
          const key = assignment.subarray(0, equals).toString("ascii");
          if (equals < 1 || !["linkpath", "path"].includes(key))
            throw new Error("base rootfs export PAX record may only extend path identity");
          cursor = end;
        }
      }
      const expectedChecksum = Number.parseInt(
        header.subarray(148, 156).toString("ascii").replace(/\0.*$/su, "").trim(),
        8,
      );
      const checked = Buffer.from(header);
      checked.fill(0x20, 148, 156);
      const actualChecksum = checked.reduce((sum, byte) => sum + byte, 0);
      if (!Number.isSafeInteger(expectedChecksum) || expectedChecksum !== actualChecksum)
        throw new Error("base rootfs export contains an invalid header checksum");
      const mtime = `${sourceDateEpoch.toString(8).padStart(11, "0")}\0`;
      header.write(mtime, 136, 12, "ascii");
      header.fill(0x20, 148, 156);
      const normalizedChecksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${normalizedChecksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
      const written = await handle.write(header, 0, header.length, offset);
      if (written.bytesWritten !== header.length)
        throw new Error("base rootfs export normalization was incomplete");
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (entries < 1 || state.size - offset !== 1_024)
      throw new Error("base rootfs export has an invalid terminator");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

await mkdir(output, { recursive: false, mode: 0o700 });
const assemblyDeadline = Object.freeze({ expiresAt: performance.now() + 540_000 });
const sourceDateEpoch = 1_786_312_800;
const baseRootfsTar = path.join(output, "base-rootfs.v1.tar");
await rename("/output/base-export.v1.tar", baseRootfsTar);
await normalizeExportTar(baseRootfsTar, sourceDateEpoch);
await run("/bin/gzip", ["-9", "-n", baseRootfsTar]);
const pnpmArchive = path.join(output, "pnpm-11.18.0.tgz");
await cp(path.join(networkInput, "pnpm-11.18.0.tgz"), pnpmArchive, {
  errorOnExist: true,
  force: false,
});
const pnpmBytes = await readFile(pnpmArchive);
if (
  `sha512-${digest("sha512", pnpmBytes)}` !== expectedIntegrity ||
  digest("sha1", pnpmBytes) !== expectedSha1
)
  throw new Error("pnpm archive does not match its locked npm integrity and shasum");
const pnpmDirectory = path.join(output, "pnpm");
await copyBoundedTree(path.join(networkInput, "pnpm"), pnpmDirectory, {
  deadline: assemblyDeadline,
});
const store = path.join(output, "store");
await copyBoundedTree(path.join(networkInput, "store"), store, { deadline: assemblyDeadline });
await readFile(path.join(networkInput, "network-complete"));
const project = path.join(output, "project");
await copyBoundedProjectSource("/input", project, { deadline: assemblyDeadline });
const preparationSourceManifestBytes = await readFile(
  path.join(project, "preparation-source-manifest.v1.json"),
);
const preparationSourceManifestSha256 = digest("sha256", preparationSourceManifestBytes);
await writeFile(
  path.join(output, "preparation-source-manifest.v1.json"),
  preparationSourceManifestBytes,
  { flag: "wx", mode: 0o600 },
);
await run(
  "/usr/local/bin/node",
  [
    path.join(pnpmDirectory, "bin/pnpm.cjs"),
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--config.ignore-scripts=true",
    "--config.enable-pre-post-scripts=false",
    "--config.ignore-pnpmfile=true",
    "--config.global-pnpmfile=/dev/null",
    "--config.manage-package-manager-versions=false",
    "--no-runtime",
    "--offline",
    "--store-dir",
    store,
    "--virtual-store-dir",
    path.join(project, "node_modules/.pnpm"),
  ],
  {
    CI: "true",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_HOME: "/tmp/disabled-corepack",
    HOME: "/tmp/home",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    NO_COLOR: "1",
    NO_PROXY: "*",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    npm_config_offline: "true",
    pnpm_config_enable_global_virtual_store: "false",
    pnpm_config_global_pnpmfile: "/dev/null",
    pnpm_config_ignore_pnpmfile: "true",
    pnpm_config_ignore_scripts: "true",
  },
  project,
);
const lockfileBytes = await readFile(path.join(project, "pnpm-lock.yaml"));

const snapshot = path.join(output, "dependency-snapshot");
await mkdir(snapshot, { mode: 0o700 });
async function copyDependencyTrees(source, destination, relative = "") {
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.name === "node_modules" && entry.isDirectory()) {
      await copyBoundedTree(path.join(source, child), path.join(destination, child), {
        allowedLinkRoot: source,
        deadline: assemblyDeadline,
      });
    } else if (entry.isDirectory() && entry.name !== ".git")
      await copyDependencyTrees(source, destination, child);
  }
}
await copyDependencyTrees(project, snapshot);
const modulesMetadataPath = path.join(snapshot, "node_modules/.modules.yaml");
const modulesMetadata = JSON.parse(await readFile(modulesMetadataPath, "utf8"));
if (
  typeof modulesMetadata.prunedAt !== "string" ||
  !Number.isFinite(Date.parse(modulesMetadata.prunedAt))
)
  throw new Error("prepared pnpm modules metadata has an invalid pruning timestamp");
modulesMetadata.prunedAt = new Date(sourceDateEpoch * 1_000).toUTCString();
await writeFile(modulesMetadataPath, `${JSON.stringify(modulesMetadata, null, 2)}\n`);
const workspaceStatePath = path.join(snapshot, "node_modules/.pnpm-workspace-state-v1.json");
const workspaceState = JSON.parse(await readFile(workspaceStatePath, "utf8"));
if (!Number.isSafeInteger(workspaceState.lastValidatedTimestamp))
  throw new Error("prepared pnpm workspace metadata has an invalid validation timestamp");
workspaceState.lastValidatedTimestamp = sourceDateEpoch * 1_000;
await writeFile(workspaceStatePath, `${JSON.stringify(workspaceState, null, 2)}\n`);
for (const forbiddenRuntimePath of ["node_modules/.bin/node", "node_modules/node"])
  try {
    await lstat(path.join(snapshot, forbiddenRuntimePath));
    throw new Error("prepared dependency snapshot unexpectedly contains a managed Node runtime");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
const snapshotBudget = {
  bytes: 0,
  directories: 0,
  expiresAt: performance.now() + 120_000,
  files: 0,
};
async function validateSnapshot(directory, root, depth = 0) {
  snapshotBudget.directories += 1;
  if (
    performance.now() >= snapshotBudget.expiresAt ||
    depth > 128 ||
    snapshotBudget.directories > 16_384
  )
    throw new Error("dependency snapshot exceeds its traversal bounds");
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 8_192)
    throw new Error("dependency snapshot directory exceeds its entry bound");
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    const state = await lstat(child);
    if (entry.isDirectory()) await validateSnapshot(child, root, depth + 1);
    else if (entry.isFile()) {
      snapshotBudget.files += 1;
      snapshotBudget.bytes += state.size;
      if (
        state.nlink !== 1 ||
        state.size > 128 * 1024 * 1024 ||
        snapshotBudget.files > 150_000 ||
        snapshotBudget.bytes > 1024 * 1024 * 1024
      )
        throw new Error(`dependency snapshot exceeds its file bounds: ${child}`);
    } else if (entry.isSymbolicLink()) {
      snapshotBudget.files += 1;
      if (snapshotBudget.files > 150_000)
        throw new Error("dependency snapshot exceeds its file-count bound");
      const target = await readlink(child);
      const resolved = path.resolve(path.dirname(child), target);
      if (
        path.isAbsolute(target) ||
        (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
      )
        throw new Error(`dependency snapshot contains an escaping link: ${child}`);
    } else throw new Error(`dependency snapshot contains a special path: ${child}`);
  }
}
await validateSnapshot(snapshot, snapshot);
const overlay = path.join(output, "runtime-overlay");
await mkdir(path.join(overlay, "opt/h13"), { recursive: true, mode: 0o700 });
await rename(snapshot, path.join(overlay, "opt/h13/repo"));
await cp("/input/tools/standards/container/runner.mjs", path.join(overlay, "opt/h13/runner.mjs"), {
  errorOnExist: true,
  force: false,
});
await mkdir(path.join(overlay, "usr/local/lib/node_modules"), {
  recursive: true,
  mode: 0o700,
});
await rename(pnpmDirectory, path.join(overlay, "usr/local/lib/node_modules/pnpm"));
const overlayTar = path.join(output, "runtime-overlay.v1.tar");
await run("/usr/bin/tar", [
  "--sort=name",
  `--mtime=@${sourceDateEpoch}`,
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "--mode=u+rwX,go+rX,go-w",
  "--format=posix",
  "--pax-option=delete=atime,delete=ctime",
  "-C",
  overlay,
  "-cf",
  overlayTar,
  ".",
]);
await run("/bin/gzip", ["-9", "-n", overlayTar]);
await rm(overlay, { force: true, recursive: true });
await rm(project, { force: true, recursive: true });
await rm(store, { force: true, recursive: true });
const manifest = await createInputManifest(output, lockfileBytes, pnpmBytes, {
  preparationSourceManifestSha256,
});
const manifestPath = path.join(output, "input-manifest.v1.json");
const temporary = `${manifestPath}.tmp`;
const handle = await open(temporary, "wx", 0o600);
try {
  await handle.writeFile(`${canonicalJson(manifest)}\n`);
  await handle.sync();
} finally {
  await handle.close();
}
await rename(temporary, manifestPath);
process.stdout.write(`${digest("sha256", await readFile(manifestPath))}\n`);
