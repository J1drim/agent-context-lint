import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256 } from "./upstream-snapshotter.mjs";

export const MAINTAINER_BUNDLE_VERSION = "1.0.0";
export const MAINTAINER_BUNDLE_FILE = "maintainer-review-bundle.v1.json";
export const MAX_MAINTAINER_BUNDLE_FILE_BYTES = 10 * 1024 * 1024;

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/u;
const FIXED_FILES = [
  "baseline/upstream-provenance.v1.json",
  "baseline/upstream-source.v1.json",
  "candidate/upstream-provenance.v1.json",
  "candidate/upstream-source.v1.json",
  "review/upstream-fixture-scaffold.v1.json",
  "review/upstream-review.v1.json",
  "review/upstream-review.v1.md",
];

export class MaintainerBundleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new MaintainerBundleError(code, message);
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid-bundle", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail("invalid-bundle", `${label} fields do not match the closed contract`);
  return value;
}

function positiveInteger(value, label) {
  if (typeof value !== "string" || !POSITIVE_INTEGER.test(value))
    fail("invalid-context", `${label} must be a bounded positive decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("invalid-context", `${label} is outside safe bounds`);
  return parsed;
}

function validatedContext({ runAttempt, runId, sourceCommit }) {
  if (typeof sourceCommit !== "string" || !SHA40.test(sourceCommit))
    fail("invalid-context", "source commit must be a full lowercase SHA-1 object identifier");
  return {
    runAttempt: positiveInteger(runAttempt, "workflow run attempt"),
    runId: positiveInteger(runId, "workflow run id"),
    sourceCommit,
  };
}

async function canonicalRoot(rootDirectory) {
  if (typeof rootDirectory !== "string" || rootDirectory.length < 1 || rootDirectory.length > 4096)
    fail("unsafe-path", "bundle root is invalid");
  const selected = path.resolve(rootDirectory);
  let canonical;
  try {
    canonical = await realpath(selected);
    if (canonical !== selected) fail("unsafe-path", "bundle root must use its canonical real path");
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail("unsafe-path", "bundle root must be a real directory");
  } catch (error) {
    if (error instanceof MaintainerBundleError) throw error;
    fail("unsafe-path", "bundle root is unavailable");
  }
  return canonical;
}

async function safeRead(root, relative, maximum = MAX_MAINTAINER_BUNDLE_FILE_BYTES) {
  const selected = path.resolve(root, relative);
  if (path.dirname(selected) === selected || !selected.startsWith(`${root}${path.sep}`))
    fail("unsafe-path", "bundle file escaped its root");
  let canonical;
  try {
    canonical = await realpath(selected);
  } catch {
    fail("unsafe-path", "bundle file is unavailable");
  }
  if (canonical !== selected) fail("unsafe-path", "bundle file traverses an alias or link");
  const before = await lstat(selected);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    fail("unsafe-path", "bundle file must be a single-link regular file");
  if (before.size < 1 || before.size > maximum)
    fail("resource-limit", "bundle file has an invalid byte length");
  const handle = await open(selected, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      fail("concurrent-change", "bundle file changed before it was read");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      fail("concurrent-change", "bundle file changed while it was read");
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseCanonicalJson(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid-bundle", "bundle manifest is not valid UTF-8 JSON");
  }
  let canonical;
  try {
    canonical = canonicalJson(value);
  } catch {
    fail("invalid-bundle", "bundle manifest cannot be canonicalized");
  }
  if (!canonical.equals(bytes)) fail("invalid-bundle", "bundle manifest is not canonical JSON");
  return value;
}

async function fileRecords(root) {
  const records = [];
  for (const relative of FIXED_FILES) {
    const bytes = await safeRead(root, relative);
    records.push({ bytes: bytes.byteLength, path: relative, sha256: sha256(bytes) });
  }
  return records;
}

async function validateInventory(root, includeManifest) {
  const expectedDirectories = new Set(["baseline", "candidate", "review"]);
  const expectedFiles = new Set(
    includeManifest ? [...FIXED_FILES, MAINTAINER_BUNDLE_FILE] : FIXED_FILES,
  );
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const selected = path.join(directory, entry.name);
      const metadata = await lstat(selected);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink())
        fail("unsafe-path", "bundle inventory contains a symbolic link");
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relative))
          fail("invalid-bundle", "bundle inventory contains an unexpected directory");
        await visit(selected, relative);
      } else if (!entry.isFile() || !expectedFiles.has(relative))
        fail("invalid-bundle", "bundle inventory contains an unexpected entry");
    }
  };
  await visit(root, "");
  for (const directory of expectedDirectories) {
    const metadata = await lstat(path.join(root, directory));
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail("invalid-bundle", "bundle inventory is missing a fixed directory");
  }
}

export async function createMaintainerReviewBundle(rootDirectory, context) {
  const root = await canonicalRoot(rootDirectory);
  const validated = validatedContext(context);
  await validateInventory(root, false);
  const records = await fileRecords(root);
  await validateInventory(root, false);
  const manifest = {
    artifactKind: "standards-maintainer-review-bundle",
    contractVersion: MAINTAINER_BUNDLE_VERSION,
    files: records,
    sourceCommit: validated.sourceCommit,
    workflow: { runAttempt: validated.runAttempt, runId: validated.runId },
  };
  const bytes = canonicalJson(manifest);
  const selected = path.join(root, MAINTAINER_BUNDLE_FILE);
  let handle;
  try {
    handle = await open(
      selected,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") fail("unsafe-output", "bundle manifest already exists");
    if (error instanceof MaintainerBundleError) throw error;
    fail("unsafe-output", "bundle manifest could not be written exclusively");
  } finally {
    await handle?.close();
  }
  return { manifest, manifestSha256: sha256(bytes) };
}

export async function verifyMaintainerReviewBundle(rootDirectory, context, expectedManifestSha256) {
  const root = await canonicalRoot(rootDirectory);
  const validated = validatedContext(context);
  if (typeof expectedManifestSha256 !== "string" || !SHA256.test(expectedManifestSha256))
    fail("invalid-context", "expected manifest digest must be lowercase SHA-256");
  await validateInventory(root, true);
  const bytes = await safeRead(root, MAINTAINER_BUNDLE_FILE, 64 * 1024);
  if (sha256(bytes) !== expectedManifestSha256)
    fail("integrity-failure", "bundle manifest digest does not match the producing job");
  const manifest = exactObject(
    parseCanonicalJson(bytes),
    ["artifactKind", "contractVersion", "files", "sourceCommit", "workflow"],
    "manifest",
  );
  if (
    manifest.artifactKind !== "standards-maintainer-review-bundle" ||
    manifest.contractVersion !== MAINTAINER_BUNDLE_VERSION ||
    manifest.sourceCommit !== validated.sourceCommit
  )
    fail("invalid-bundle", "bundle identity or source commit does not match");
  const workflow = exactObject(manifest.workflow, ["runAttempt", "runId"], "workflow");
  if (workflow.runAttempt !== validated.runAttempt || workflow.runId !== validated.runId)
    fail("invalid-bundle", "bundle workflow replay identity does not match");
  if (!Array.isArray(manifest.files) || manifest.files.length !== FIXED_FILES.length)
    fail("invalid-bundle", "bundle file inventory is incomplete");
  const actual = await fileRecords(root);
  await validateInventory(root, true);
  manifest.files.forEach((entry, index) => {
    exactObject(entry, ["bytes", "path", "sha256"], `file ${index}`);
    if (
      entry.path !== FIXED_FILES[index] ||
      entry.bytes !== actual[index].bytes ||
      entry.sha256 !== actual[index].sha256
    )
      fail("integrity-failure", "bundle file inventory does not match the downloaded bytes");
  });
  return { files: actual.length, manifestSha256: expectedManifestSha256 };
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_;
  const flags = ["--root", "--source-commit", "--run-id", "--run-attempt"];
  if (command === "verify") flags.push("--manifest-sha256");
  if ((command !== "create" && command !== "verify") || rest.length !== flags.length * 2)
    fail("usage", "expected create or verify with the complete fixed argument set");
  const values = {};
  for (const [index, flag] of flags.entries()) {
    if (rest[index * 2] !== flag || typeof rest[index * 2 + 1] !== "string")
      fail("usage", "bundle arguments must use the documented fixed order");
    values[flag] = rest[index * 2 + 1];
  }
  return { command, values };
}

export async function runMaintainerBundleCli(arguments_) {
  const selected = parseArguments(arguments_);
  const context = {
    runAttempt: selected.values["--run-attempt"],
    runId: selected.values["--run-id"],
    sourceCommit: selected.values["--source-commit"],
  };
  if (selected.command === "create") {
    const result = await createMaintainerReviewBundle(selected.values["--root"], context);
    return `${result.manifestSha256}\n`;
  }
  const result = await verifyMaintainerReviewBundle(
    selected.values["--root"],
    context,
    selected.values["--manifest-sha256"],
  );
  return `Verified ${result.files} fixed files in maintainer bundle ${result.manifestSha256}.\n`;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    process.stdout.write(await runMaintainerBundleCli(process.argv.slice(2)));
  } catch (error) {
    const message =
      error instanceof MaintainerBundleError
        ? `${error.code}: ${error.message}`
        : "unexpected-failure: maintainer bundle failed closed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
