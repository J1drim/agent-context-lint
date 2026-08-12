import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";

import { digest } from "./runtime-inputs.mjs";

const input = process.argv[2];
const output = process.argv[3];
if (process.argv.length !== 4 || !path.isAbsolute(input) || !path.isAbsolute(output))
  throw new Error("invalid network preparation paths");

const pnpmUrl = new URL("https://registry.npmjs.org/pnpm/-/pnpm-11.18.0.tgz");
const expectedIntegrity =
  "sha512-M9g8d9qC9J+6g2klxvG4QRgewxMrZwY5vQEvcHX1x89jTF+HAUfBmq50ePrAHfCdiJLogEVIlu3SPumzN1dWPA==";
const expectedSha1 = "6eb0fa6a5dc5ddfa7b802e612a99d7e25ab564a4";

async function download(url, destination) {
  if (
    url.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("runtime input download destination is outside the approved npm origin");
  await new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: { "accept-encoding": "identity", host: "registry.npmjs.org" },
        servername: "registry.npmjs.org",
      },
      (response) => {
        if (response.statusCode !== 200 || response.headers.location !== undefined) {
          response.resume();
          reject(new Error(`runtime input download refused HTTP ${response.statusCode}`));
          return;
        }
        let bytes = 0;
        const outputStream = createWriteStream(destination, { flags: "wx", mode: 0o600 });
        response.on("data", (chunk) => {
          bytes += chunk.byteLength;
          if (bytes > 16 * 1024 * 1024) request.destroy(new Error("runtime input exceeds limit"));
        });
        response.pipe(outputStream);
        outputStream.once("finish", resolve);
        outputStream.once("error", reject);
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error("runtime input timed out")));
    request.once("error", reject);
  });
}

async function run(executable, arguments_, environment, cwd) {
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
    throw new Error(`runtime network preparation failed: ${executable}`);
}

await mkdir(output, { recursive: false, mode: 0o700 });
const pnpmArchive = path.join(output, "pnpm-11.18.0.tgz");
await download(pnpmUrl, pnpmArchive);
const pnpmBytes = await readFile(pnpmArchive);
if (
  `sha512-${digest("sha512", pnpmBytes)}` !== expectedIntegrity ||
  digest("sha1", pnpmBytes) !== expectedSha1
)
  throw new Error("pnpm archive does not match its locked npm integrity and shasum");
const pnpmDirectory = path.join(output, "pnpm");
await mkdir(pnpmDirectory, { mode: 0o700 });
await run(
  "/usr/bin/tar",
  ["-xzf", pnpmArchive, "--strip-components=1", "-C", pnpmDirectory],
  {},
  "/",
);
const inputLockfile = path.join(input, "pnpm-lock.yaml");
const lockfileState = await lstat(inputLockfile);
if (
  !lockfileState.isFile() ||
  lockfileState.isSymbolicLink() ||
  lockfileState.nlink !== 1 ||
  lockfileState.size > 4 * 1024 * 1024
)
  throw new Error("runtime network lockfile exceeds its regular-file bound");
const lockfileBytes = await readFile(inputLockfile);
const fetchProject = path.join(output, "fetch-project");
await mkdir(fetchProject, { mode: 0o700 });
await writeFile(path.join(fetchProject, "pnpm-lock.yaml"), lockfileBytes, {
  flag: "wx",
  mode: 0o600,
});
await run(
  "/usr/local/bin/node",
  [
    path.join(pnpmDirectory, "bin/pnpm.cjs"),
    "fetch",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--config.ignore-scripts=true",
    "--config.enable-pre-post-scripts=false",
    "--config.ignore-pnpmfile=true",
    "--config.global-pnpmfile=/dev/null",
    "--config.manage-package-manager-versions=false",
    "--no-runtime",
    "--store-dir",
    path.join(output, "store"),
    "--config.registry=https://registry.npmjs.org/",
    "--config.strict-ssl=true",
    "--config.verify-store-integrity=true",
  ],
  {
    CI: "true",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_HOME: "/tmp/disabled-corepack",
    HOME: "/tmp/home",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    NO_COLOR: "1",
    NO_PROXY: "registry.npmjs.org",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    pnpm_config_enable_global_virtual_store: "false",
    pnpm_config_global_pnpmfile: "/dev/null",
    pnpm_config_ignore_pnpmfile: "true",
    pnpm_config_ignore_scripts: "true",
  },
  fetchProject,
);
if (
  digest("sha256", await readFile(path.join(fetchProject, "pnpm-lock.yaml"))) !==
  digest("sha256", lockfileBytes)
)
  throw new Error("runtime network preparation changed its frozen lockfile snapshot");
const marker = await open(path.join(output, "network-complete"), "wx", 0o600);
await marker.close();
