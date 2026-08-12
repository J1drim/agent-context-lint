#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const FORMAT = "agent-context-release-bundle-v1";
const MANIFEST_NAME = "release-manifest.json";
const CHECKSUMS_NAME = "checksums.sha256";
const SBOM_NAME = "sbom.spdx.json";
const RELEASE_NOTES_NAME = "RELEASE_NOTES.md";
const ROLLBACK_NAME = "UPGRADE_AND_ROLLBACK.md";
const RESERVED_NAMES = new Set([
  MANIFEST_NAME,
  CHECKSUMS_NAME,
  SBOM_NAME,
  RELEASE_NOTES_NAME,
  ROLLBACK_NAME,
]);

const compareUtf8 = (left, right) =>
  Math.sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));

function fail(message) {
  throw new Error(`release artifact bundle: ${message}`);
}

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

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    fail(`${label} is not a lowercase SHA-256 digest`);
}

function validateVersion(value) {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
  )
    fail(`release version is not a SemVer value: ${String(value)}`);
  return value;
}

function normalizeRelative(relative, label = "path") {
  if (typeof relative !== "string" || relative.length === 0) fail(`${label} is empty`);
  if (Buffer.byteLength(relative, "utf8") > MAX_PATH_BYTES)
    fail(`${label} exceeds ${MAX_PATH_BYTES} bytes`);
  // eslint-disable-next-line no-control-regex -- path controls are explicitly rejected.
  if (relative.includes("\0") || /[\u0000-\u001f\u007f]/u.test(relative))
    fail(`${label} contains a control character`);
  const normalized = relative.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:(?:\/|$)/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
  )
    fail(`${label} is absolute or escaping: ${relative}`);
  if (normalized === "." || normalized.endsWith("/")) fail(`${label} is not a file path`);
  return normalized;
}

async function ensureDirectory(directory, label) {
  const info = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) {
    await mkdir(directory, { recursive: true });
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} is not a real directory`);
}

async function readBoundedFile(file, label) {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} is not a regular file`);
  if (info.size > BigInt(MAX_FILE_BYTES)) fail(`${label} exceeds ${MAX_FILE_BYTES} bytes`);
  const bytes = await readFile(file);
  const after = await lstat(file, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    after.mode !== info.mode ||
    after.size !== info.size ||
    after.ctimeNs !== info.ctimeNs ||
    after.mtimeNs !== info.mtimeNs ||
    BigInt(bytes.byteLength) !== info.size
  )
    fail(`${label} changed while it was read`);
  return bytes;
}

async function collectFiles(
  root,
  relative = "",
  state = { files: [], paths: new Set(), total: 0 },
) {
  const directory = relative === "" ? root : path.join(root, ...relative.split("/"));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    const candidate = normalizeRelative(relative === "" ? entry.name : `${relative}/${entry.name}`);
    const absolute = path.join(root, ...candidate.split("/"));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) fail(`input contains a symbolic link: ${candidate}`);
    if (info.isDirectory()) {
      await collectFiles(root, candidate, state);
      continue;
    }
    if (!info.isFile()) fail(`input contains a non-regular entry: ${candidate}`);
    if (RESERVED_NAMES.has(candidate)) fail(`input uses reserved control path: ${candidate}`);
    if (state.paths.has(candidate)) fail(`input contains duplicate normalized path: ${candidate}`);
    state.paths.add(candidate);
    if (info.size > MAX_FILE_BYTES) fail(`${candidate} exceeds ${MAX_FILE_BYTES} bytes`);
    state.total += info.size;
    if (state.total > MAX_TOTAL_BYTES) fail(`input exceeds ${MAX_TOTAL_BYTES} aggregate bytes`);
    state.files.push({ absolute, mode: info.mode & 0o777, path: candidate, bytes: info.size });
    if (state.files.length > MAX_FILES) fail(`input exceeds ${MAX_FILES} files`);
  }
  return state;
}

function validateMarkdown(bytes, label) {
  const text = bytes.toString("utf8");
  if (text.trim() === "") fail(`${label} is empty`);
  // Reject terminal controls and bidi overrides in release instructions. Markdown prose remains
  // otherwise untouched; preserving the author's bytes is part of the artifact contract.
  // eslint-disable-next-line no-control-regex -- release text must reject terminal and bidi controls.
  if (/\u0000|\u001b|[\u202a-\u202e\u2066-\u2069]/u.test(text))
    fail(`${label} contains unsafe control characters`);
  if (!/^\s*#/mu.test(text)) fail(`${label} must contain a Markdown heading`);
  return bytes;
}

function validateSpdx(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} is not an object`);
  if (value.spdxVersion !== "SPDX-2.3") fail(`${label} must use SPDX-2.3`);
  if (value.dataLicense !== "CC0-1.0") fail(`${label} must use CC0-1.0 data licensing`);
  if (typeof value.SPDXID !== "string" || value.SPDXID !== "SPDXRef-DOCUMENT")
    fail(`${label} has an invalid document SPDXID`);
  if (typeof value.name !== "string" || value.name.trim() === "") fail(`${label} has no name`);
  if (
    typeof value.documentNamespace !== "string" ||
    !/^https:\/\/[^\s]+$/u.test(value.documentNamespace)
  )
    fail(`${label} has an invalid document namespace`);
  if (
    value.creationInfo === null ||
    typeof value.creationInfo !== "object" ||
    Array.isArray(value.creationInfo)
  )
    fail(`${label} has invalid creationInfo`);
  const packages = Array.isArray(value.packages) ? value.packages : [];
  const files = Array.isArray(value.files) ? value.files : [];
  if (packages.length === 0 && files.length === 0) fail(`${label} has no packages or files`);
  for (const [index, file] of files.entries()) {
    if (file === null || typeof file !== "object" || typeof file.fileName !== "string")
      fail(`${label} file ${index} is invalid`);
    if (!Array.isArray(file.checksums) || file.checksums.length === 0)
      fail(`${label} file ${index} has no checksum`);
    for (const checksum of file.checksums) {
      if (checksum?.algorithm !== "SHA256")
        fail(`${label} file ${index} has a non-SHA256 checksum`);
      validateSha256(checksum?.checksumValue, `${label} file ${index} checksum`);
    }
  }
  for (const [index, pkg] of packages.entries()) {
    if (pkg === null || typeof pkg !== "object" || typeof pkg.name !== "string")
      fail(`${label} package ${index} is invalid`);
  }
  return value;
}

function makeInventorySbom(version, payloadEntries) {
  const payloadDigest = sha256(
    Buffer.from(payloadEntries.map((entry) => `${entry.path}\0${entry.sha256}\0`).join(""), "utf8"),
  );
  const files = payloadEntries.map((entry, index) => ({
    SPDXID: `SPDXRef-File-${String(index + 1).padStart(6, "0")}`,
    checksums: [{ algorithm: "SHA256", checksumValue: entry.sha256 }],
    fileName: entry.path,
    licenseConcluded: "NOASSERTION",
    licenseInfoInFiles: ["NOASSERTION"],
  }));
  return {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      created: "1970-01-01T00:00:00Z",
      creators: ["Tool: agent-context-linter-release-artifacts/1"],
    },
    dataLicense: "CC0-1.0",
    documentNamespace: `https://agent-context.invalid/release/${encodeURIComponent(version)}/${payloadDigest}`,
    files,
    name: `agent-context-linter-release-${version}`,
    spdxVersion: "SPDX-2.3",
  };
}

async function copyPayload(input, staging) {
  const state = await collectFiles(input);
  const entries = [];
  for (const file of state.files) {
    const bytes = await readBoundedFile(file.absolute, `input/${file.path}`);
    const target = path.join(staging, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    // Read and verify the source before writing the staging copy. Using cp first and
    // hashing a later source read leaves a TOCTOU window where the manifest could
    // authenticate bytes different from those copied into the bundle.
    await writeFile(target, bytes, { flag: "wx", mode: file.mode });
    entries.push({ bytes: bytes.byteLength, path: file.path, sha256: sha256(bytes) });
  }
  return entries.sort((left, right) => compareUtf8(left.path, right.path));
}

function checksumsText(entries) {
  return `${entries
    .slice()
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map((entry) => `${entry.sha256}  ${entry.path}`)
    .join("\n")}\n`;
}

async function listBundleFiles(root, relative = "", result = []) {
  const directory = relative === "" ? root : path.join(root, ...relative.split("/"));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    const candidate = normalizeRelative(relative === "" ? entry.name : `${relative}/${entry.name}`);
    const absolute = path.join(root, ...candidate.split("/"));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) fail(`bundle contains a symbolic link: ${candidate}`);
    if (info.isDirectory()) await listBundleFiles(root, candidate, result);
    else if (info.isFile()) {
      if (info.size > MAX_FILE_BYTES) fail(`${candidate} exceeds ${MAX_FILE_BYTES} bytes`);
      result.push({ absolute, bytes: info.size, path: candidate });
    } else fail(`bundle contains a non-regular entry: ${candidate}`);
    if (result.length > MAX_FILES) fail(`bundle exceeds ${MAX_FILES} files`);
  }
  return result;
}

async function writeJson(file, value) {
  await writeFile(file, canonicalJson(value), { flag: "wx" });
}

export async function generateReleaseArtifactBundle({
  inputDirectory,
  outputDirectory,
  releaseVersion,
  sbomPath,
  releaseNotesPath,
  rollbackGuidePath,
}) {
  const version = validateVersion(releaseVersion);
  const input = path.resolve(inputDirectory);
  const output = path.resolve(outputDirectory);
  const inputInfo = await lstat(input).catch(() => undefined);
  if (inputInfo === undefined || !inputInfo.isDirectory() || inputInfo.isSymbolicLink())
    fail("input must be a real directory");
  const outputInfo = await lstat(output).catch(() => undefined);
  if (outputInfo !== undefined) fail("output already exists; refusing to overwrite it");
  const notes = validateMarkdown(
    await readBoundedFile(path.resolve(releaseNotesPath), "release notes"),
    "release notes",
  );
  const rollback = validateMarkdown(
    await readBoundedFile(path.resolve(rollbackGuidePath), "upgrade/rollback guide"),
    "upgrade/rollback guide",
  );
  let sbom;
  if (sbomPath !== undefined) {
    const bytes = await readBoundedFile(path.resolve(sbomPath), "SBOM");
    try {
      sbom = validateSpdx(JSON.parse(bytes.toString("utf8")), "SBOM");
    } catch (error) {
      if (error instanceof SyntaxError) fail("SBOM is not valid JSON");
      throw error;
    }
  }

  const parent = path.dirname(output);
  await ensureDirectory(parent, "output parent");
  const staging = await mkdtemp(path.join(parent, ".agent-context-release-"));
  try {
    const payload = await copyPayload(input, staging);
    const supplemental = [
      {
        bytes: notes.byteLength,
        path: RELEASE_NOTES_NAME,
        sha256: sha256(notes),
        kind: "release-notes",
      },
      {
        bytes: rollback.byteLength,
        path: ROLLBACK_NAME,
        sha256: sha256(rollback),
        kind: "upgrade-rollback",
      },
    ];
    await writeFile(path.join(staging, RELEASE_NOTES_NAME), notes, { flag: "wx" });
    await writeFile(path.join(staging, ROLLBACK_NAME), rollback, { flag: "wx" });
    const inventory = sbom ?? makeInventorySbom(version, payload);
    validateSpdx(inventory, "generated SBOM");
    const sbomBytes = Buffer.from(canonicalJson(inventory), "utf8");
    await writeFile(path.join(staging, SBOM_NAME), sbomBytes, { flag: "wx" });
    supplemental.push({
      bytes: sbomBytes.byteLength,
      path: SBOM_NAME,
      sha256: sha256(sbomBytes),
      kind: sbomPath === undefined ? "artifact-inventory-sbom" : "dependency-sbom",
    });
    const allEntries = [...payload, ...supplemental].sort((left, right) =>
      compareUtf8(left.path, right.path),
    );
    const manifest = {
      $schema: "https://agent-context.invalid/schemas/release-artifact-manifest.v1.schema.json",
      artifactFormat: FORMAT,
      claims: {
        networkAccess: false,
        npmPublication: "not-performed",
        repositoryMutation: false,
        secretsRead: false,
        signature: "not-produced",
      },
      generatedBy: "agent-context-linter-release-artifacts/1",
      files: allEntries,
      releaseVersion: version,
      schemaVersion: 1,
      signature: {
        state: "not-produced",
        reason: "This offline generator never reads private signing keys or publishes artifacts.",
      },
      provenance: {
        state: "not-published",
        reason: "npm provenance is established only by a reviewed npm publication workflow.",
      },
    };
    await writeJson(path.join(staging, MANIFEST_NAME), manifest);
    const manifestBytes = await readBoundedFile(path.join(staging, MANIFEST_NAME), MANIFEST_NAME);
    const checksumEntries = [
      ...allEntries,
      { bytes: manifestBytes.byteLength, path: MANIFEST_NAME, sha256: sha256(manifestBytes) },
    ];
    await writeFile(path.join(staging, CHECKSUMS_NAME), checksumsText(checksumEntries), {
      flag: "wx",
    });
    await rename(staging, output);
    return { bundleDirectory: output, fileCount: allEntries.length, releaseVersion: version };
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

function parseChecksums(text) {
  const lines = text.split("\n");
  if (lines.at(-1) !== "") fail("checksums file must end with exactly one newline");
  const entries = [];
  const seen = new Set();
  for (const line of lines.slice(0, -1)) {
    const match = /^(?<sha>[0-9a-f]{64}) {2}(?<path>[^\s].*)$/u.exec(line);
    if (match === null) fail(`invalid checksum line: ${line}`);
    const relative = normalizeRelative(match.groups.path, "checksum path");
    if (seen.has(relative)) fail(`duplicate checksum path: ${relative}`);
    seen.add(relative);
    entries.push({ path: relative, sha256: match.groups.sha });
  }
  return entries.sort((left, right) => compareUtf8(left.path, right.path));
}

export async function verifyReleaseArtifactBundle(bundleDirectory, { expectedVersion } = {}) {
  const bundle = path.resolve(bundleDirectory);
  const info = await lstat(bundle).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink())
    fail("bundle must be a real directory");
  const files = await listBundleFiles(bundle);
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  for (const required of [
    MANIFEST_NAME,
    CHECKSUMS_NAME,
    SBOM_NAME,
    RELEASE_NOTES_NAME,
    ROLLBACK_NAME,
  ])
    if (!byPath.has(required)) fail(`bundle is missing ${required}`);
  let manifest;
  try {
    manifest = JSON.parse(
      (await readBoundedFile(byPath.get(MANIFEST_NAME).absolute, MANIFEST_NAME)).toString("utf8"),
    );
  } catch (error) {
    if (error instanceof SyntaxError) fail("manifest is not valid JSON");
    throw error;
  }
  if (manifest?.artifactFormat !== FORMAT || manifest?.schemaVersion !== 1)
    fail("manifest format/schema is unsupported");
  validateVersion(manifest.releaseVersion);
  if (expectedVersion !== undefined && manifest.releaseVersion !== expectedVersion)
    fail(`manifest release version does not match ${expectedVersion}`);
  if (manifest.claims?.networkAccess !== false || manifest.claims?.repositoryMutation !== false)
    fail("manifest has unsafe capability claims");
  if (manifest.claims?.npmPublication !== "not-performed" || manifest.claims?.secretsRead !== false)
    fail("manifest claims publication or secret access");
  if (
    manifest.signature?.state !== "not-produced" ||
    manifest.provenance?.state !== "not-published"
  )
    fail("manifest makes an unverified signature or provenance claim");
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  if (manifestFiles.length === 0 || manifestFiles.some((entry) => entry?.path === undefined))
    fail("manifest file inventory is empty or malformed");
  const expectedEntries = new Map();
  for (const entry of manifestFiles) {
    const relative = normalizeRelative(entry.path, "manifest path");
    if (relative === MANIFEST_NAME || relative === CHECKSUMS_NAME)
      fail("manifest includes control files");
    validateSha256(entry.sha256, `manifest ${relative}`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES)
      fail(`manifest byte count is invalid for ${relative}`);
    if (expectedEntries.has(relative)) fail(`manifest duplicates ${relative}`);
    expectedEntries.set(relative, entry);
  }
  const actualPayload = files.filter(
    (entry) => entry.path !== MANIFEST_NAME && entry.path !== CHECKSUMS_NAME,
  );
  if (
    actualPayload.length !== expectedEntries.size ||
    actualPayload.some((entry) => !expectedEntries.has(entry.path))
  )
    fail("bundle files differ from manifest inventory");
  for (const entry of actualPayload) {
    const bytes = await readBoundedFile(entry.absolute, entry.path);
    const expected = expectedEntries.get(entry.path);
    if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256)
      fail(`manifest digest mismatch: ${entry.path}`);
  }
  validateMarkdown(
    await readBoundedFile(byPath.get(RELEASE_NOTES_NAME).absolute, RELEASE_NOTES_NAME),
    RELEASE_NOTES_NAME,
  );
  validateMarkdown(
    await readBoundedFile(byPath.get(ROLLBACK_NAME).absolute, ROLLBACK_NAME),
    ROLLBACK_NAME,
  );
  let sbom;
  try {
    sbom = JSON.parse(
      (await readBoundedFile(byPath.get(SBOM_NAME).absolute, SBOM_NAME)).toString("utf8"),
    );
  } catch (error) {
    if (error instanceof SyntaxError) fail("SBOM is not valid JSON");
    throw error;
  }
  validateSpdx(sbom, SBOM_NAME);
  const checksums = parseChecksums(
    (await readBoundedFile(byPath.get(CHECKSUMS_NAME).absolute, CHECKSUMS_NAME)).toString("utf8"),
  );
  const checksumFiles = files
    .filter((entry) => entry.path !== CHECKSUMS_NAME)
    .map((entry) => entry.path)
    .sort(compareUtf8);
  if (
    checksums.length !== checksumFiles.length ||
    checksums.some((entry, index) => entry.path !== checksumFiles[index])
  )
    fail("checksums inventory does not match bundle files");
  for (const entry of checksums) {
    const bytes = await readBoundedFile(byPath.get(entry.path).absolute, entry.path);
    if (sha256(bytes) !== entry.sha256) fail(`checksum mismatch: ${entry.path}`);
  }
  return Object.freeze({
    fileCount: actualPayload.length,
    releaseVersion: manifest.releaseVersion,
    signature: manifest.signature.state,
    provenance: manifest.provenance.state,
    verified: true,
  });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "generate" && command !== "verify")
    fail("usage: release-artifacts.mjs generate|verify [options]");
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const next = rest[index + 1];
    if (
      ![
        "--input",
        "--output",
        "--version",
        "--sbom",
        "--release-notes",
        "--rollback-guide",
        "--bundle",
      ].includes(flag)
    )
      fail(`unknown option: ${flag}`);
    if (next === undefined || next.startsWith("--")) fail(`missing value for ${flag}`);
    if (options[flag.slice(2)] !== undefined) fail(`duplicate option: ${flag}`);
    options[flag.slice(2)] = next;
    index += 1;
  }
  if (command === "generate") {
    for (const required of ["input", "output", "version", "release-notes", "rollback-guide"])
      if (options[required] === undefined) fail(`generate requires --${required}`);
  } else if (options.bundle === undefined) fail("verify requires --bundle");
  return options;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = parseArgs(process.argv.slice(2));
  const result =
    options.command === "generate"
      ? await generateReleaseArtifactBundle({
          inputDirectory: options.input,
          outputDirectory: options.output,
          releaseVersion: options.version,
          releaseNotesPath: options["release-notes"],
          rollbackGuidePath: options["rollback-guide"],
          sbomPath: options.sbom,
        })
      : await verifyReleaseArtifactBundle(options.bundle, { expectedVersion: options.version });
  console.log(JSON.stringify(result));
}
