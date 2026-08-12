import { createHash } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, readlink, symlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_DEADLINE_MS = 30_000;

function createBudget(options, defaults) {
  const values = { ...defaults, ...options };
  for (const key of Object.keys(defaults))
    if (!Number.isInteger(values[key]) || values[key] < 1)
      throw new Error(`runtime input ${key} bound is invalid`);
  const expiresAt = options?.deadline?.expiresAt ?? performance.now() + DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(expiresAt)) throw new Error("runtime input deadline is invalid");
  return { ...values, bytes: 0, directories: 0, files: 0, expiresAt, signal: options?.signal };
}

function checkBudget(budget, phase) {
  if (budget.signal?.aborted) throw new Error(`runtime input cancelled during ${phase}`);
  if (performance.now() >= budget.expiresAt)
    throw new Error(`runtime input deadline expired during ${phase}`);
}

async function hashRegularFile(absolute, expectedState, budget) {
  const handle = await open(absolute, "r");
  try {
    const openedState = await handle.stat();
    if (
      !openedState.isFile() ||
      openedState.nlink !== 1 ||
      openedState.dev !== expectedState.dev ||
      openedState.ino !== expectedState.ino ||
      openedState.size !== expectedState.size ||
      openedState.mtimeMs !== expectedState.mtimeMs
    )
      throw new Error("runtime input changed before hashing");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < expectedState.size) {
      checkBudget(budget, "input hashing");
      const length = Math.min(buffer.byteLength, expectedState.size - offset);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) throw new Error("runtime input changed while hashing");
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const finalState = await handle.stat();
    if (
      finalState.dev !== openedState.dev ||
      finalState.ino !== openedState.ino ||
      finalState.size !== openedState.size ||
      finalState.mtimeMs !== openedState.mtimeMs
    )
      throw new Error("runtime input changed while hashing");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function digest(algorithm, bytes) {
  return createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha512" ? "base64" : "hex");
}

export async function copyBoundedProjectSource(source, destination, options = {}) {
  const budget = createBudget(options, {
    maxBytes: 32 * 1024 * 1024,
    maxDepth: 64,
    maxDirectories: 1_024,
    maxEntriesPerDirectory: 4_096,
    maxFiles: 4_096,
    maxFileBytes: 2 * 1024 * 1024,
  });
  const copyDirectory = async (relative = "", depth = 0) => {
    checkBudget(budget, "source traversal");
    budget.directories += 1;
    if (depth > budget.maxDepth || budget.directories > budget.maxDirectories)
      throw new Error("runtime preparation source exceeds its directory bounds");
    await mkdir(path.join(destination, relative), { recursive: true, mode: 0o700 });
    const entries = await readdir(path.join(source, relative), { withFileTypes: true });
    if (entries.length > budget.maxEntriesPerDirectory)
      throw new Error("runtime preparation source directory exceeds its entry bound");
    for (const entry of entries) {
      checkBudget(budget, "source copy");
      const child = path.join(relative, entry.name);
      const parts = child.split(path.sep);
      if (
        parts.some(
          (part) =>
            part === ".git" ||
            part === "node_modules" ||
            part === ".h13-runtime-inputs" ||
            part.startsWith(".h13-runtime-inputs.prepare-"),
        )
      )
        continue;
      const absolute = path.join(source, child);
      const state = await lstat(absolute);
      if (entry.isDirectory()) await copyDirectory(child, depth + 1);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        budget.files += 1;
        budget.bytes += state.size;
        if (
          state.nlink !== 1 ||
          state.size > budget.maxFileBytes ||
          budget.files > budget.maxFiles ||
          budget.bytes > budget.maxBytes
        )
          throw new Error("runtime preparation source exceeds its bounded inventory");
        await cp(absolute, path.join(destination, child), { errorOnExist: true, force: false });
      } else throw new Error(`runtime preparation source contains an unsafe path: ${child}`);
    }
  };
  await copyDirectory();
  return Object.freeze({
    bytes: budget.bytes,
    directories: budget.directories,
    files: budget.files,
  });
}

export async function copyBoundedTree(source, destination, options = {}) {
  const allowedLinkRoot = options.allowedLinkRoot ?? source;
  if (!path.isAbsolute(allowedLinkRoot))
    throw new Error("runtime preparation tree link root must be absolute");
  const budget = createBudget(options, {
    maxBytes: 1024 * 1024 * 1024,
    maxDepth: 128,
    maxDirectories: 16_384,
    maxEntriesPerDirectory: 8_192,
    maxFiles: 150_000,
    maxFileBytes: 128 * 1024 * 1024,
  });
  const copyDirectory = async (sourceDirectory, destinationDirectory, depth) => {
    checkBudget(budget, "tree traversal");
    budget.directories += 1;
    if (depth > budget.maxDepth || budget.directories > budget.maxDirectories)
      throw new Error("runtime preparation tree exceeds its directory bounds");
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    if (entries.length > budget.maxEntriesPerDirectory)
      throw new Error("runtime preparation tree directory exceeds its entry bound");
    for (const entry of entries) {
      checkBudget(budget, "tree copy");
      const sourceChild = path.join(sourceDirectory, entry.name);
      const destinationChild = path.join(destinationDirectory, entry.name);
      const state = await lstat(sourceChild);
      if (entry.isDirectory()) await copyDirectory(sourceChild, destinationChild, depth + 1);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        budget.files += 1;
        budget.bytes += state.size;
        if (
          state.nlink !== 1 ||
          state.size > budget.maxFileBytes ||
          budget.files > budget.maxFiles ||
          budget.bytes > budget.maxBytes
        )
          throw new Error("runtime preparation tree exceeds its bounded inventory");
        await cp(sourceChild, destinationChild, { errorOnExist: true, force: false });
      } else if (entry.isSymbolicLink()) {
        budget.files += 1;
        if (budget.files > budget.maxFiles)
          throw new Error("runtime preparation tree exceeds its bounded inventory");
        const target = await readlink(sourceChild);
        const resolved = path.resolve(path.dirname(sourceChild), target);
        if (
          path.isAbsolute(target) ||
          (resolved !== allowedLinkRoot && !resolved.startsWith(`${allowedLinkRoot}${path.sep}`))
        )
          throw new Error("runtime preparation tree contains an escaping link");
        await symlink(target, destinationChild);
      } else throw new Error("runtime preparation tree contains a special path");
    }
  };
  await copyDirectory(source, destination, 0);
  return Object.freeze({
    bytes: budget.bytes,
    directories: budget.directories,
    files: budget.files,
  });
}

async function inventory(root, relative, depth, budget) {
  checkBudget(budget, "input inventory");
  budget.directories += 1;
  if (depth > budget.maxDepth || budget.directories > budget.maxDirectories)
    throw new Error("runtime input exceeds its directory bounds");
  const entries = [];
  const directoryEntries = await readdir(path.join(root, relative), { withFileTypes: true });
  if (directoryEntries.length > budget.maxEntriesPerDirectory)
    throw new Error("runtime input directory exceeds its entry bound");
  for (const entry of directoryEntries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  )) {
    checkBudget(budget, "input inventory");
    const child = path.posix.join(relative, entry.name);
    if (child === "input-manifest.v1.json") continue;
    const absolute = path.join(root, child);
    const state = await lstat(absolute);
    if (entry.isDirectory()) entries.push(...(await inventory(root, child, depth + 1, budget)));
    else if (entry.isFile()) {
      budget.files += 1;
      budget.bytes += state.size;
      if (
        state.nlink !== 1 ||
        state.size > budget.maxFileBytes ||
        budget.files > budget.maxFiles ||
        budget.bytes > budget.maxBytes
      )
        throw new Error("runtime input exceeds its bounded inventory");
      entries.push({
        path: child,
        sha256: await hashRegularFile(absolute, state, budget),
        size: state.size,
      });
    } else if (entry.isSymbolicLink())
      throw new Error(`runtime input may not be a symlink: ${child}`);
    else throw new Error(`runtime input must be regular: ${child}`);
  }
  return entries;
}

export async function createInputManifest(root, lockfileBytes, pnpmBytes, options = {}) {
  const budget = createBudget(options, {
    maxBytes: 1024 * 1024 * 1024,
    maxDepth: 8,
    maxDirectories: 32,
    maxEntriesPerDirectory: 64,
    maxFiles: 32,
    maxFileBytes: 512 * 1024 * 1024,
  });
  const entries = await inventory(root, "", 0, budget);
  const manifest = {
    contractVersion: "1.0.0",
    entries,
    lockfileSha256: digest("sha256", lockfileBytes),
    pnpm: {
      integrity: `sha512-${digest("sha512", pnpmBytes)}`,
      sha1: digest("sha1", pnpmBytes),
      sha256: digest("sha256", pnpmBytes),
    },
    recordKind: "agent-context-h13-runtime-inputs",
  };
  if (options.preparationSourceManifestSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/u.test(options.preparationSourceManifestSha256))
      throw new Error("runtime input preparation source digest is invalid");
    manifest.preparationSourceManifestSha256 = options.preparationSourceManifestSha256;
  }
  return manifest;
}

export async function verifyInputDirectory(
  root,
  expectedManifestSha256,
  lockfileBytes,
  expectedPackageManager,
  options = {},
) {
  const readBounded = async (relative, maxBytes) => {
    const budget = createBudget(options, {
      maxBytes,
      maxDepth: 1,
      maxDirectories: 1,
      maxEntriesPerDirectory: 1,
      maxFiles: 1,
      maxFileBytes: maxBytes,
    });
    checkBudget(budget, `reading ${relative}`);
    const absolute = path.join(root, relative);
    const state = await lstat(absolute);
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > maxBytes)
      throw new Error(`H13 runtime input ${relative} exceeds its regular-file bound`);
    const bytes = await readFile(absolute);
    checkBudget(budget, `reading ${relative}`);
    if (bytes.byteLength !== state.size)
      throw new Error(`H13 runtime input ${relative} changed while it was read`);
    return bytes;
  };
  const manifestBytes = await readBounded("input-manifest.v1.json", 4 * 1024 * 1024);
  if (digest("sha256", manifestBytes) !== expectedManifestSha256)
    throw new Error("H13 runtime input manifest digest differs from the lock");
  const manifest = JSON.parse(manifestBytes);
  const pnpmBytes = await readBounded("pnpm-11.18.0.tgz", 16 * 1024 * 1024);
  const actual = await createInputManifest(root, lockfileBytes, pnpmBytes, options);
  if (canonicalJson(actual) !== canonicalJson(manifest))
    throw new Error("H13 runtime input inventory differs from its manifest");
  if (
    expectedPackageManager !== undefined &&
    (manifest.pnpm.integrity !== expectedPackageManager.integrity ||
      manifest.pnpm.sha1 !== expectedPackageManager.shasum)
  )
    throw new Error("H13 pnpm archive differs from its npm integrity or shasum");
  if (
    options.preparationSourceManifestSha256 !== undefined &&
    manifest.preparationSourceManifestSha256 !== options.preparationSourceManifestSha256
  )
    throw new Error("H13 runtime input preparation source differs from the reviewed manifest");
  return manifest;
}

export async function verifyBaseDescriptors(root, baseImage) {
  const indexBytes = await readFile(path.join(root, "base-index.v1.json"));
  const platformBytes = await readFile(path.join(root, "base-platform.v1.json"));
  const storedConfigurationBytes = await readFile(path.join(root, "base-config.v1.json"));
  if (
    storedConfigurationBytes.at(-1) !== 0x0a ||
    storedConfigurationBytes.at(-2) === 0x0a ||
    storedConfigurationBytes.includes(0x0d)
  )
    throw new Error("H13 base configuration envelope is not one LF-terminated raw JSON record");
  const configurationBytes = storedConfigurationBytes.subarray(0, -1);
  if (`sha256:${digest("sha256", indexBytes)}` !== baseImage.indexDigest)
    throw new Error("H13 base index bytes differ from the runtime lock");
  if (`sha256:${digest("sha256", platformBytes)}` !== baseImage.platformManifestDigest)
    throw new Error("H13 base platform manifest bytes differ from the runtime lock");
  if (`sha256:${digest("sha256", configurationBytes)}` !== baseImage.configurationDigest)
    throw new Error("H13 base configuration bytes differ from the runtime lock");
  const index = JSON.parse(indexBytes);
  const platform = JSON.parse(platformBytes);
  const configuration = JSON.parse(configurationBytes);
  const descriptor = index.manifests.find(
    (entry) =>
      entry.platform?.os === "linux" &&
      entry.platform?.architecture === "arm64" &&
      entry.platform?.variant === "v8",
  );
  if (
    descriptor?.digest !== baseImage.platformManifestDigest ||
    descriptor?.size !== platformBytes.byteLength ||
    platform.config?.digest !== baseImage.configurationDigest ||
    platform.config?.size !== configurationBytes.byteLength ||
    configuration.architecture !== "arm64" ||
    configuration.variant !== "v8" ||
    configuration.os !== "linux" ||
    configuration.rootfs?.diff_ids?.length !== platform.layers?.length
  )
    throw new Error("H13 base OCI descriptor chain differs from the runtime lock");
  return Object.freeze({ configuration, index, platform });
}
