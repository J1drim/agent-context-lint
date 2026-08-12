import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const QUOTA_FILESYSTEM = "APFS";
export const QUOTA_FIXED_RESERVE_BYTES = 192 * 1024 * 1024;
const APFS_CONTENT_HINTS = new Set([
  "Apple_APFS",
  "41504653-0000-11AA-AA11-00306543ECAC",
  "7C3457EF-0000-11AA-AA11-00306543ECAC",
]);

function within(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function exactChild(root, target, expectedName, label) {
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== root || path.basename(resolved) !== expectedName)
    throw new Error(`${label} is not the exact issued K03 work-root child`);
  return resolved;
}

function checkedInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function bytes(value, label) {
  const number = Number(value);
  return checkedInteger(number, label);
}

export function parseHdiutilDeviceIdentities(stdout) {
  if (typeof stdout !== "string") throw new Error("hdiutil attach identity is not text");
  const unique = [
    ...new Set(
      [
        ...stdout.matchAll(
          /<key>dev-entry<\/key>\s*<string>(\/dev\/disk[1-9][0-9]*(?:s[1-9][0-9]*)*)<\/string>/gu,
        ),
      ].map((match) => match[1].replace(/s[1-9][0-9]*$/u, "")),
    ),
  ].sort();
  if (unique.length === 0)
    throw new Error("hdiutil attach did not return a bounded device identity");
  return Object.freeze(unique);
}

export function parseHdiutilDeviceIdentity(stdout) {
  const identities = parseHdiutilDeviceIdentities(stdout);
  if (identities.length !== 1)
    throw new Error("hdiutil attach returned an ambiguous device identity set");
  return identities[0];
}

function decodePlistString(value) {
  return value.replaceAll(
    /&(?:#([0-9]+)|#x([0-9a-fA-F]+)|amp|apos|gt|lt|quot);/gu,
    (entity, decimal, hexadecimal) => {
      if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hexadecimal !== undefined) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return {
        "&amp;": "&",
        "&apos;": "'",
        "&gt;": ">",
        "&lt;": "<",
        "&quot;": '"',
      }[entity];
    },
  );
}

export function parseHdiutilAttachmentInventory(stdout) {
  if (typeof stdout !== "string") throw new Error("hdiutil inventory is not text");
  const imagePattern = /<key>image-path<\/key>\s*<string>([^<]*)<\/string>/gu;
  const images = [...stdout.matchAll(imagePattern)];
  const inventory = new Map();
  let associatedEntries = 0;
  for (const [index, image] of images.entries()) {
    const imagePath = decodePlistString(image[1]);
    if (!path.isAbsolute(imagePath) || imagePath.includes("\0"))
      throw new Error("hdiutil inventory contains an invalid image path");
    const start = image.index + image[0].length;
    const end = images[index + 1]?.index ?? stdout.length;
    const section = stdout.slice(start, end);
    for (const match of section.matchAll(
      /<key>dev-entry<\/key>\s*<string>(\/dev\/disk[1-9][0-9]*(?:s[1-9][0-9]*)*)<\/string>/gu,
    )) {
      associatedEntries += 1;
      const device = match[1].replace(/s[1-9][0-9]*$/u, "");
      const imagePaths = inventory.get(device) ?? new Set();
      imagePaths.add(imagePath);
      if (imagePaths.size !== 1)
        throw new Error("hdiutil inventory associates one device with multiple images");
      inventory.set(device, imagePaths);
    }
  }
  const totalEntries = [
    ...stdout.matchAll(
      /<key>dev-entry<\/key>\s*<string>\/dev\/disk[1-9][0-9]*(?:s[1-9][0-9]*)*<\/string>/gu,
    ),
  ].length;
  if (associatedEntries !== totalEntries)
    throw new Error("hdiutil inventory contains a device without an exact image association");
  return inventory;
}

export function parseHdiutilMountedQuotaIdentity(stdout, mountRoot) {
  if (typeof stdout !== "string" || typeof mountRoot !== "string" || !path.isAbsolute(mountRoot))
    throw new Error("hdiutil mounted-filesystem identity is invalid");
  const matches = [];
  for (const section of stdout.matchAll(/<dict>([\s\S]*?)<\/dict>/gu)) {
    const values = new Map();
    for (const pair of section[1].matchAll(
      /<key>(dev-entry|content-hint|mount-point)<\/key>\s*<string>([^<]*)<\/string>/gu,
    )) {
      if (values.has(pair[1]))
        throw new Error("hdiutil mounted-filesystem identity contains a duplicate field");
      values.set(pair[1], decodePlistString(pair[2]));
    }
    if (values.get("mount-point") === mountRoot) matches.push(values);
  }
  if (matches.length !== 1)
    throw new Error("hdiutil did not report one exact mounted filesystem identity");
  const [identity] = matches;
  const device = identity.get("dev-entry");
  if (
    !APFS_CONTENT_HINTS.has(identity.get("content-hint")) ||
    typeof device !== "string" ||
    !/^\/dev\/disk[1-9][0-9]*s[1-9][0-9]*$/u.test(device)
  )
    throw new Error(
      `hdiutil mounted filesystem is not an exact Apple_APFS partition (content=${JSON.stringify(identity.get("content-hint"))}, device=${JSON.stringify(device)})`,
    );
  return Object.freeze({
    baseDevice: device.replace(/s[1-9][0-9]*$/u, ""),
    contentHint: identity.get("content-hint"),
    filesystemName: "apfs",
    partitionDevice: device,
  });
}

export function parseDarwinDfGeometry(stdout, mounted) {
  if (typeof stdout !== "string" || mounted === null || typeof mounted !== "object")
    throw new Error("quota df geometry is invalid");
  const lines = stdout.trimEnd().split("\n");
  if (
    lines.length !== 2 ||
    !/^Filesystem +1024-blocks +Used +Available +Capacity +Mounted on$/u.test(lines[0])
  )
    throw new Error("quota df output does not have the exact POSIX header");
  const match = /^(\S+) +([0-9]+) +([0-9]+) +([0-9]+) +([0-9]+)% +(.*)$/u.exec(lines[1]);
  const blockCount = Number(match?.[2]);
  const usedBlocks = Number(match?.[3]);
  const freeBlocks = Number(match?.[4]);
  const capacityPercent = Number(match?.[5]);
  if (
    match === null ||
    match[1] !== mounted.partitionDevice ||
    match[6] !== mounted.mountRoot ||
    !Number.isSafeInteger(blockCount) ||
    !Number.isSafeInteger(usedBlocks) ||
    !Number.isSafeInteger(freeBlocks) ||
    blockCount < 1 ||
    usedBlocks < 0 ||
    freeBlocks < 0 ||
    usedBlocks > blockCount ||
    freeBlocks > blockCount ||
    !Number.isSafeInteger(capacityPercent) ||
    capacityPercent < 0 ||
    capacityPercent > 100
  )
    throw new Error("quota df output does not bind the exact mounted partition geometry");
  return Object.freeze({
    blockCount,
    blockSize: 1024,
    filesystemType: mounted.contentHint,
    filesystemName: mounted.filesystemName,
    freeBlocks,
  });
}

async function attachedDeviceInventory(provider, cwd, executeHdiutil = runHdiutil) {
  const result = await executeHdiutil(provider, ["info", "-plist"], cwd);
  return parseHdiutilAttachmentInventory(result.stdout);
}

async function proveImageDetached(
  provider,
  cwd,
  expectedImagePath,
  executeHdiutil,
  mountExpectation = null,
) {
  let inventory;
  try {
    inventory = await attachedDeviceInventory(provider, cwd, executeHdiutil);
  } catch (cause) {
    const error = new Error(
      "quota detach postflight could not prove the image has no attached devices",
      { cause },
    );
    error.safeToRemoveImage = false;
    throw error;
  }
  const remaining = [...inventory.entries()]
    .filter(([, images]) => images.has(expectedImagePath))
    .map(([device]) => device)
    .sort();
  if (remaining.length > 0) {
    const error = new Error(
      `quota detach postflight found image-bound devices: ${remaining.join(", ")}`,
    );
    error.safeToRemoveImage = false;
    error.retainedDevices = Object.freeze(remaining);
    throw error;
  }
  if (mountExpectation !== null) {
    const observed = await stat(mountExpectation.path);
    if (
      String(observed.dev) !== mountExpectation.hostMount.device ||
      String(observed.ino) !== mountExpectation.hostMount.inode
    ) {
      const error = new Error("quota detach postflight did not restore the issued mount identity");
      error.safeToRemoveImage = false;
      throw error;
    }
  }
}

async function unlinkDetachedQuotaImage(
  provider,
  cwd,
  imagePath,
  expectedImage,
  executeHdiutil,
  mountExpectation,
) {
  if (mountExpectation !== null) {
    const observed = await stat(mountExpectation.path);
    if (
      String(observed.dev) !== mountExpectation.hostMount.device ||
      String(observed.ino) !== mountExpectation.hostMount.inode
    ) {
      const error = new Error(
        "quota image unlink did not observe the restored host mount identity",
      );
      error.safeToRemoveImage = false;
      throw error;
    }
  }
  const observedImage = await imageIdentity(imagePath);
  if (
    observedImage.device !== expectedImage.device ||
    observedImage.inode !== expectedImage.inode
  ) {
    const error = new Error("quota image changed before unlink; retained for quarantine");
    error.safeToRemoveImage = false;
    throw error;
  }
  let inventory;
  try {
    inventory = await attachedDeviceInventory(provider, cwd, executeHdiutil);
  } catch (cause) {
    const error = new Error(
      "quota image unlink could not obtain its mandatory final attachment inventory",
      { cause },
    );
    error.safeToRemoveImage = false;
    throw error;
  }
  const retainedDevices = [...inventory.entries()]
    .filter(([, images]) => images.has(imagePath))
    .map(([device]) => device)
    .sort();
  if (retainedDevices.length > 0) {
    const error = new Error(
      `quota image unlink final inventory found attached devices: ${retainedDevices.join(", ")}`,
    );
    error.safeToRemoveImage = false;
    error.retainedDevices = Object.freeze(retainedDevices);
    throw error;
  }
  await unlink(imagePath);
}

export async function snapshotAttachedDeviceIdentities(provider, cwd) {
  return Object.freeze([...(await attachedDeviceInventory(provider, cwd)).keys()].sort());
}

function recoveryAggregate(
  errors,
  message,
  issuedDevices,
  {
    cause = errors.at(-1),
    retainedDevices = [],
    safeToRemoveImage = retainedDevices.length === 0,
  } = {},
) {
  const error = new AggregateError(
    errors,
    `${message}; issued devices: ${issuedDevices.join(", ") || "none"}`,
    { cause },
  );
  error.issuedDevices = Object.freeze([...issuedDevices]);
  error.retainedDevices = Object.freeze([...retainedDevices]);
  error.safeToRemoveImage = safeToRemoveImage;
  return error;
}

async function recoverNewAttachments(
  provider,
  before,
  expectedImagePath,
  cwd,
  executeHdiutil,
  mountExpectation = null,
) {
  let after;
  try {
    after = await attachedDeviceInventory(provider, cwd, executeHdiutil);
  } catch (error) {
    throw recoveryAggregate(
      [error],
      "quota attachment recovery inventory failed; unknown devices retained for quarantine",
      [],
      { safeToRemoveImage: false },
    );
  }
  const { issued, unexpected } = recoverNewAttachmentIdentities(before, after, expectedImagePath);
  const detachErrors = [];
  const retainedDevices = [];
  for (const device of issued) {
    try {
      await executeHdiutil(provider, ["detach", device], cwd);
    } catch (error) {
      detachErrors.push(error);
      retainedDevices.push(device);
    }
  }
  if (unexpected.length > 0)
    detachErrors.push(
      new Error(`concurrent unbound devices were not detached: ${unexpected.join(", ")}`),
    );
  if (retainedDevices.length === 0) {
    try {
      await proveImageDetached(provider, cwd, expectedImagePath, executeHdiutil, mountExpectation);
    } catch (error) {
      detachErrors.push(error);
      retainedDevices.push(...(error.retainedDevices ?? issued));
    }
  }
  if (detachErrors.length > 0)
    throw recoveryAggregate(
      detachErrors,
      "quota attachment recovery was incomplete; failed or unbound devices retained for quarantine",
      issued,
      { retainedDevices },
    );
  return issued.length;
}

export function recoverNewAttachmentIdentities(before, after, expectedImagePath) {
  const newDevices = [...after.keys()].filter((entry) => !before.has(entry)).sort();
  const issued = newDevices.filter((device) => after.get(device)?.has(expectedImagePath));
  const unexpected = newDevices.filter((device) => !issued.includes(device));
  return Object.freeze({
    issued: Object.freeze(issued),
    unexpected: Object.freeze(unexpected),
  });
}

export async function attachQuotaVolumeWithRecovery(
  provider,
  arguments_,
  cwd,
  devicesBeforeAttach,
  expectedImagePath,
  executeHdiutil = runHdiutil,
  mountExpectation = null,
) {
  let attached;
  try {
    attached = await executeHdiutil(provider, arguments_, cwd);
  } catch (error) {
    try {
      await recoverNewAttachments(
        provider,
        devicesBeforeAttach,
        expectedImagePath,
        cwd,
        executeHdiutil,
        mountExpectation,
      );
    } catch (recoveryError) {
      throw recoveryAggregate(
        [error, recoveryError],
        "quota attach failed and recovery was incomplete",
        recoveryError.issuedDevices ?? [],
        {
          cause: error,
          retainedDevices: recoveryError.retainedDevices ?? [],
          safeToRemoveImage: recoveryError.safeToRemoveImage === true,
        },
      );
    }
    throw error;
  }
  try {
    const reported = parseHdiutilDeviceIdentities(attached.stdout);
    const after = await attachedDeviceInventory(provider, cwd, executeHdiutil);
    const { issued, unexpected } = recoverNewAttachmentIdentities(
      devicesBeforeAttach,
      after,
      expectedImagePath,
    );
    if (
      unexpected.length > 0 ||
      issued.length === 0 ||
      reported.length !== issued.length ||
      reported.some((device, index) => device !== issued[index])
    ) {
      const recoveryErrors = [];
      const retainedDevices = [];
      for (const device of issued) {
        try {
          await executeHdiutil(provider, ["detach", device], cwd);
        } catch (detachError) {
          recoveryErrors.push(detachError);
          retainedDevices.push(device);
        }
      }
      if (retainedDevices.length === 0) {
        try {
          await proveImageDetached(
            provider,
            cwd,
            expectedImagePath,
            executeHdiutil,
            mountExpectation,
          );
        } catch (error) {
          recoveryErrors.push(error);
          retainedDevices.push(...(error.retainedDevices ?? issued));
        }
      }
      if (unexpected.length > 0)
        recoveryErrors.push(
          new Error(`concurrent unbound devices were not detached: ${unexpected.join(", ")}`),
        );
      const identityError = new Error(
        "hdiutil attach output does not equal every exact image-bound base device",
      );
      throw recoveryAggregate(
        [identityError, ...recoveryErrors],
        "quota successful attachment identity was inconsistent",
        issued,
        {
          cause: identityError,
          retainedDevices,
          safeToRemoveImage: retainedDevices.length === 0,
        },
      );
    }
    return Object.freeze(issued);
  } catch (error) {
    if (error?.issuedDevices !== undefined) throw error;
    let recovered;
    try {
      recovered = await recoverNewAttachments(
        provider,
        devicesBeforeAttach,
        expectedImagePath,
        cwd,
        executeHdiutil,
        mountExpectation,
      );
    } catch (recoveryError) {
      throw recoveryAggregate(
        [error, recoveryError],
        "quota attach returned no identity and recovery was incomplete",
        recoveryError.issuedDevices ?? [],
        {
          cause: error,
          retainedDevices: recoveryError.retainedDevices ?? [],
          safeToRemoveImage: recoveryError.safeToRemoveImage === true,
        },
      );
    }
    if (!recovered)
      throw new AggregateError(
        [error],
        "quota attach returned no identity and created no recoverable device",
        { cause: error },
      );
    throw error;
  }
}

async function runHdiutil(provider, arguments_, cwd) {
  const result = await withVerifiedProviderTool(provider.hdiutil, "/usr/bin/hdiutil", () =>
    provider.command(provider.hdiutil.path, arguments_, {
      cwd,
      environment: provider.environment,
      maximumStderrBytes: 64 * 1024,
      maximumStdoutBytes: 256 * 1024,
      timeoutMs: 120_000,
    }),
  );
  if (result.status !== 0 || result.signal !== null) {
    const sanitized = result.stderr.trim().replaceAll(cwd, "<work-root>");
    throw new Error(
      `reviewed hdiutil quota-volume operation failed (status=${String(result.status)}, signal=${JSON.stringify(result.signal)}, stderr=${JSON.stringify(sanitized)})`,
    );
  }
  return result;
}

async function verifyProviderTool(tool, expectedPath) {
  if (tool?.path !== expectedPath || (await realpath(expectedPath)) !== expectedPath)
    throw new Error(`quota provider does not bind ${expectedPath}`);
  const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(expectedPath));
  if (createHash("sha256").update(bytes).digest("hex") !== tool.sha256)
    throw new Error(`quota provider tool identity changed: ${expectedPath}`);
}

async function withVerifiedProviderTool(tool, expectedPath, operation) {
  await verifyProviderTool(tool, expectedPath);
  let failure = null;
  let result;
  try {
    result = await operation();
  } catch (error) {
    failure = error;
  }
  try {
    await verifyProviderTool(tool, expectedPath);
  } catch (verificationError) {
    if (failure !== null)
      throw new AggregateError(
        [failure, verificationError],
        `quota provider operation failed and ${expectedPath} changed during execution`,
        { cause: verificationError },
      );
    throw verificationError;
  }
  if (failure !== null) throw failure;
  return result;
}

export function validateQuotaFilesystemGeometry({
  allocatedResourceCeilingBytes,
  blockCount: blockCountValue,
  blockSize: blockSizeValue,
  filesystemType,
  filesystemName,
  freeBlocks: freeBlocksValue,
  logicalBudgetBytes,
  logicalCeilingApplied = true,
  payloadMayConsumeBudget = false,
}) {
  const blockSize = bytes(blockSizeValue, "quota filesystem block size");
  const blockCount = bytes(blockCountValue, "quota filesystem block count");
  const freeBlocks = Number(freeBlocksValue);
  if (!Number.isSafeInteger(freeBlocks) || freeBlocks < 0 || freeBlocks > blockCount)
    throw new Error("quota filesystem free-block count is invalid");
  const totalBytes = blockSize * blockCount;
  const freeBytes = blockSize * freeBlocks;
  const reserveBytes = totalBytes - freeBytes;
  if (filesystemName !== "apfs")
    throw new Error(
      `quota filesystem must have the exact mounted APFS identity (name=${JSON.stringify(filesystemName)}, type=${JSON.stringify(String(filesystemType))})`,
    );
  const logicalTolerance = blockSize;
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > allocatedResourceCeilingBytes ||
    (logicalCeilingApplied &&
      ((!payloadMayConsumeBudget && freeBytes < logicalBudgetBytes - logicalTolerance) ||
        freeBytes > logicalBudgetBytes + logicalTolerance)) ||
    (!logicalCeilingApplied && freeBytes < logicalBudgetBytes) ||
    (!payloadMayConsumeBudget && reserveBytes > QUOTA_FIXED_RESERVE_BYTES)
  )
    throw new Error(
      `quota filesystem geometry exceeds its logical budget and fixed reserve (total=${String(totalBytes)}, free=${String(freeBytes)}, allocated=${String(reserveBytes)}, ceiling=${String(allocatedResourceCeilingBytes)}, logical=${String(logicalBudgetBytes)})`,
    );
  return Object.freeze({
    blockCount,
    blockSize,
    filesystemType: String(filesystemType),
    filesystemName,
    freeBlocks,
    initialAllocatedBytes: reserveBytes,
    freeBytes,
    logicalCeilingApplied,
  });
}

async function volumeGeometry(
  provider,
  mountRoot,
  logicalBudgetBytes,
  allocatedResourceCeilingBytes,
  issuedDevices,
  logicalCeilingApplied = true,
  payloadMayConsumeBudget = false,
) {
  const inventory = await runHdiutil(provider, ["info", "-plist"], mountRoot);
  const mounted = parseHdiutilMountedQuotaIdentity(inventory.stdout, mountRoot);
  if (!issuedDevices.includes(mounted.baseDevice))
    throw new Error("hdiutil mounted filesystem does not belong to an issued device");
  const df = await withVerifiedProviderTool(provider.df, "/bin/df", () =>
    provider.command(provider.df.path, ["-kP", mountRoot], {
      cwd: mountRoot,
      environment: provider.environment,
      maximumStderrBytes: 4096,
      maximumStdoutBytes: 4096,
      timeoutMs: 30_000,
    }),
  );
  if (df.status !== 0 || df.signal !== null) throw new Error("quota df geometry inspection failed");
  try {
    const observed = parseDarwinDfGeometry(df.stdout, { ...mounted, mountRoot });
    return validateQuotaFilesystemGeometry({
      allocatedResourceCeilingBytes,
      ...observed,
      logicalBudgetBytes,
      logicalCeilingApplied,
      payloadMayConsumeBudget,
    });
  } catch (cause) {
    throw new Error(
      `${cause instanceof Error ? cause.message : "quota filesystem geometry is invalid"}; sanitized df=${JSON.stringify(df.stdout.replaceAll(mountRoot, "<mount>"))}`,
      { cause },
    );
  }
}

async function allocateLogicalReserve(provider, mountRoot, geometry, logicalBudgetBytes) {
  const excessBytes = geometry.freeBytes - logicalBudgetBytes;
  const fillerBlocks = Math.floor(excessBytes / geometry.blockSize);
  if (fillerBlocks < 1) return null;
  const fillerPath = path.join(mountRoot, ".agent-context-k03-reserve");
  const result = await withVerifiedProviderTool(provider.dd, "/bin/dd", () =>
    provider.command(
      provider.dd.path,
      [
        "if=/dev/zero",
        `of=${fillerPath}`,
        `bs=${String(geometry.blockSize)}`,
        `count=${String(fillerBlocks)}`,
      ],
      {
        cwd: mountRoot,
        environment: provider.environment,
        maximumStderrBytes: 64 * 1024,
        maximumStdoutBytes: 4096,
        timeoutMs: 120_000,
      },
    ),
  );
  if (result.status !== 0 || result.signal !== null)
    throw new Error("quota reserve allocation failed before checkout");
  const metadata = await lstat(fillerPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1)
    throw new Error("quota reserve allocation did not create its exact ordinary filler");
  return Object.freeze({ path: fillerPath, size: metadata.size });
}

async function imageIdentity(imagePath) {
  const metadata = await lstat(imagePath);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o600 ||
    (uid !== null && metadata.uid !== uid)
  )
    throw new Error("quota image must be an owned exact mode-0600 ordinary file");
  return Object.freeze({ device: String(metadata.dev), inode: String(metadata.ino) });
}

async function mountIdentity(mountRoot, expectedPermissions) {
  const resolved = await realpath(mountRoot);
  const metadata = await stat(resolved);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== expectedPermissions ||
    (uid !== null && metadata.uid !== uid)
  )
    throw new Error("quota mounted root has unexpected ownership or permissions");
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino),
    path: resolved,
    permissions: metadata.mode & 0o777,
  });
}

export function createDarwinQuotaVolumeProvider({ command, cp, dd, df, environment, hdiutil }) {
  if (process.platform !== "darwin")
    throw new Error("K03 quota-volume capture is feature-unavailable outside Darwin");
  if (
    hdiutil?.path !== "/usr/bin/hdiutil" ||
    !/^[0-9a-f]{64}$/.test(hdiutil.sha256) ||
    typeof hdiutil.version !== "string"
  )
    throw new Error("K03 quota capture requires the exact reviewed /usr/bin/hdiutil identity");
  for (const [name, tool] of Object.entries({ cp, dd, df })) {
    if (
      tool?.path !== `/bin/${name}` ||
      !/^[0-9a-f]{64}$/.test(tool.sha256) ||
      typeof tool.version !== "string"
    )
      throw new Error(`K03 quota capture requires the exact reviewed /bin/${name} identity`);
  }
  const provider = { command, cp, dd, df, environment, hdiutil };
  return Object.freeze({
    ...provider,
    cleanup: (state) => cleanupQuotaVolume(provider, state),
    evidence: quotaEvidence,
    freeze: (state) => freezeQuotaVolume(provider, state),
    provision: (options) => provisionQuotaVolume(provider, options),
    verify: (state) => verifyQuotaVolume(provider, state),
  });
}

export async function provisionQuotaVolume(
  provider,
  { logicalBudgetBytes, repositoryId, workRoot },
) {
  checkedInteger(logicalBudgetBytes, "logical checkout budget");
  if (!/^[1-9][0-9]{0,19}$/.test(repositoryId)) throw new Error("repository ID is invalid");
  const root = await realpath(workRoot);
  const mountRoot = exactChild(
    root,
    path.join(root, `repository-${repositoryId}`),
    `repository-${repositoryId}`,
    "quota mount root",
  );
  const imagePath = exactChild(
    root,
    path.join(root, `quota-${repositoryId}.sparseimage`),
    `quota-${repositoryId}.sparseimage`,
    "quota image",
  );
  const allocatedResourceCeilingBytes = logicalBudgetBytes + QUOTA_FIXED_RESERVE_BYTES;
  if (
    !Number.isSafeInteger(allocatedResourceCeilingBytes) ||
    allocatedResourceCeilingBytes % 512 !== 0
  )
    throw new Error("quota allocated resource ceiling is invalid");
  const allocatedResourceCeilingSectors = allocatedResourceCeilingBytes / 512;
  await mkdir(mountRoot, { mode: 0o700 });
  const rootMetadata = await stat(mountRoot);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if ((rootMetadata.mode & 0o777) !== 0o700 || (uid !== null && rootMetadata.uid !== uid))
    throw new Error("quota mount path must be owned exact mode 0700 before attach");
  const hostMount = Object.freeze({
    device: String(rootMetadata.dev),
    inode: String(rootMetadata.ino),
  });
  let devices = [];
  let image = null;
  let devicesBeforeAttach;
  try {
    await runHdiutil(
      provider,
      [
        "create",
        "-quiet",
        "-size",
        `${String(allocatedResourceCeilingSectors)}b`,
        "-fs",
        QUOTA_FILESYSTEM,
        "-volname",
        `K03-${repositoryId}`,
        "-type",
        "SPARSE",
        imagePath,
      ],
      root,
    );
    await chmod(imagePath, 0o600);
    image = await imageIdentity(imagePath);
    devicesBeforeAttach = await attachedDeviceInventory(provider, root);
    devices = await attachQuotaVolumeWithRecovery(
      provider,
      [
        "attach",
        "-plist",
        "-nobrowse",
        "-owners",
        "on",
        "-readwrite",
        "-mountpoint",
        mountRoot,
        imagePath,
      ],
      root,
      devicesBeforeAttach,
      imagePath,
      runHdiutil,
      { hostMount, path: mountRoot },
    );
    await chmod(mountRoot, 0o700);
    const mount = await mountIdentity(mountRoot, 0o700);
    if (mount.device === hostMount.device)
      throw new Error("hdiutil did not mount the issued filesystem at the exact mount root");
    const geometry = await volumeGeometry(
      provider,
      mountRoot,
      logicalBudgetBytes,
      allocatedResourceCeilingBytes,
      devices,
      false,
    );
    const reserveFiller = await allocateLogicalReserve(
      provider,
      mountRoot,
      geometry,
      logicalBudgetBytes,
    );
    const boundedGeometry = await volumeGeometry(
      provider,
      mountRoot,
      logicalBudgetBytes,
      allocatedResourceCeilingBytes,
      devices,
      true,
    );
    return Object.freeze({
      allocatedResourceCeilingBytes,
      devices,
      filesystem: boundedGeometry,
      hdiutil: provider.hdiutil,
      hostMount,
      image,
      imagePath,
      logicalBudgetBytes,
      mount,
      readOnly: false,
      reserveBytes: QUOTA_FIXED_RESERVE_BYTES,
      reserveFiller,
      workRoot: root,
    });
  } catch (error) {
    if (error?.safeToRemoveImage === false)
      throw new Error(
        "K03 quota volume is feature-unavailable: attachment cleanup could not prove the issued image is unused; retained for quarantine",
        { cause: error },
      );
    if (devices.length > 0) {
      const detachErrors = [];
      for (const device of devices) {
        try {
          await runHdiutil(provider, ["detach", device], root);
        } catch (detachError) {
          detachErrors.push(detachError);
        }
      }
      if (detachErrors.length > 0)
        throw new AggregateError(
          [error, ...detachErrors],
          "K03 quota provisioning failed and issued devices were retained for quarantine",
          { cause: error },
        );
      try {
        await proveImageDetached(provider, root, imagePath, runHdiutil, {
          hostMount,
          path: mountRoot,
        });
      } catch (postflightError) {
        const uncertain = new AggregateError(
          [error, postflightError],
          "K03 quota provisioning failed and detach postflight was uncertain; retained for quarantine",
          { cause: error },
        );
        uncertain.safeToRemoveImage = false;
        throw uncertain;
      }
    }
    if (image !== null) {
      try {
        await unlinkDetachedQuotaImage(provider, root, imagePath, image, runHdiutil, {
          hostMount,
          path: mountRoot,
        });
      } catch (cleanupError) {
        const uncertain = new AggregateError(
          [error, cleanupError],
          "K03 quota provisioning failed and final image-unlink proof was uncertain; retained for quarantine",
          { cause: cleanupError },
        );
        uncertain.safeToRemoveImage = false;
        uncertain.retainedDevices = cleanupError.retainedDevices ?? Object.freeze([]);
        throw uncertain;
      }
    }
    try {
      await rmdir(mountRoot);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT")
        throw new AggregateError(
          [error, cleanupError],
          "K03 quota provisioning failed and its mount path was retained for quarantine",
          { cause: cleanupError },
        );
    }
    throw new Error(
      `K03 quota volume is feature-unavailable: ${error instanceof Error ? error.message : "unknown failure"}`,
      { cause: error },
    );
  }
}

export async function detachIssuedDevices(provider, state, executeHdiutil = runHdiutil) {
  if (!Array.isArray(state.devices) || state.devices.length === 0)
    throw new Error("quota state has no exact issued device set");
  const inventory = await attachedDeviceInventory(provider, state.workRoot, executeHdiutil);
  const imageBoundDevices = [...inventory.entries()]
    .filter(([, images]) => images.has(state.imagePath))
    .map(([device]) => device)
    .sort();
  const unissued = imageBoundDevices.filter((device) => !state.devices.includes(device));
  if (unissued.length > 0) {
    const error = new Error(
      `quota detach inventory found unissued image-bound devices: ${unissued.join(", ")}`,
    );
    error.safeToRemoveImage = false;
    error.retainedDevices = Object.freeze(imageBoundDevices);
    throw error;
  }
  const detachErrors = [];
  for (const device of imageBoundDevices) {
    try {
      const result = await executeHdiutil(provider, ["detach", device], state.workRoot);
      if (result.status !== 0) throw new Error("quota device detach failed");
    } catch (error) {
      detachErrors.push(error);
    }
  }
  try {
    await proveImageDetached(provider, state.workRoot, state.imagePath, executeHdiutil, {
      hostMount: state.hostMount,
      path: state.mount.path,
    });
  } catch (postflightError) {
    throw new AggregateError(
      [...detachErrors, postflightError],
      detachErrors.length > 0
        ? "one or more exact issued quota devices could not be detached; retained for quarantine"
        : "quota detach postflight failed; retained for quarantine",
      { cause: postflightError },
    );
  }
  const mountAfter = await stat(state.mount.path);
  if (
    String(mountAfter.dev) !== state.hostMount.device ||
    String(mountAfter.ino) !== state.hostMount.inode
  )
    throw new Error("quota device remains mounted after detach");
}

export async function freezeQuotaVolume(provider, state) {
  await detachIssuedDevices(provider, state);
  let devices = [];
  const devicesBeforeAttach = await attachedDeviceInventory(provider, state.workRoot);
  try {
    devices = await attachQuotaVolumeWithRecovery(
      provider,
      [
        "attach",
        "-plist",
        "-nobrowse",
        "-owners",
        "on",
        "-readonly",
        "-mountpoint",
        state.mount.path,
        state.imagePath,
      ],
      state.workRoot,
      devicesBeforeAttach,
      state.imagePath,
      runHdiutil,
      { hostMount: state.hostMount, path: state.mount.path },
    );
    const mount = await mountIdentity(state.mount.path, 0o555);
    const geometry = await volumeGeometry(
      provider,
      mount.path,
      state.logicalBudgetBytes,
      state.allocatedResourceCeilingBytes,
      devices,
      true,
      true,
    );
    return Object.freeze({ ...state, devices, filesystem: geometry, mount, readOnly: true });
  } catch (error) {
    const detachErrors = [];
    for (const device of devices) {
      try {
        await runHdiutil(provider, ["detach", device], state.workRoot);
      } catch (detachError) {
        detachErrors.push(detachError);
      }
    }
    if (detachErrors.length > 0)
      throw new AggregateError(
        [error, ...detachErrors],
        "quota read-only remount failed and new devices were retained for quarantine",
        { cause: error },
      );
    if (devices.length > 0) {
      try {
        await proveImageDetached(provider, state.workRoot, state.imagePath, runHdiutil, {
          hostMount: state.hostMount,
          path: state.mount.path,
        });
      } catch (postflightError) {
        const uncertain = new AggregateError(
          [error, postflightError],
          "quota read-only remount failed and detach postflight was uncertain; retained for quarantine",
          { cause: error },
        );
        uncertain.safeToRemoveImage = false;
        throw uncertain;
      }
    }
    throw error;
  }
}

export function quotaEvidence(state) {
  const evidence = { ...state };
  delete evidence.workRoot;
  return Object.freeze(evidence);
}

export async function verifyQuotaVolume(provider, state) {
  if (state?.readOnly !== true) throw new Error("review checkout quota volume is not read-only");
  const image = await imageIdentity(state.imagePath);
  if (image.device !== state.image.device || image.inode !== state.image.inode)
    throw new Error("quota image identity changed after capture");
  const mount = await mountIdentity(state.mount.path, state.mount.permissions);
  if (mount.device !== state.mount.device || mount.inode !== state.mount.inode)
    throw new Error("quota mount identity changed after capture");
  const geometry = await volumeGeometry(
    provider,
    mount.path,
    state.logicalBudgetBytes,
    state.allocatedResourceCeilingBytes,
    state.devices,
    true,
    true,
  );
  if (
    geometry.blockSize !== state.filesystem.blockSize ||
    geometry.blockCount !== state.filesystem.blockCount ||
    geometry.filesystemType !== state.filesystem.filesystemType ||
    geometry.filesystemName !== state.filesystem.filesystemName
  )
    throw new Error("quota filesystem identity changed after capture");
}

export async function cleanupQuotaVolume(provider, state, executeHdiutil = runHdiutil) {
  const root = await realpath(state.workRoot);
  if (!within(root, state.mount.path) || !within(root, state.imagePath))
    throw new Error("quota cleanup target escaped the issued work root");
  const resolvedMount = await realpath(state.mount.path);
  if (resolvedMount !== state.mount.path)
    throw new Error("quota cleanup mount path identity changed; retained for quarantine");
  const observedMount = await stat(resolvedMount);
  const observedDevice = String(observedMount.dev);
  const observedInode = String(observedMount.ino);
  if (observedDevice === state.mount.device && observedInode === state.mount.inode) {
    await detachIssuedDevices(provider, state, executeHdiutil);
  } else if (observedDevice !== state.hostMount.device || observedInode !== state.hostMount.inode) {
    throw new Error("quota cleanup found an unissued mount identity; retained for quarantine");
  }
  await unlinkDetachedQuotaImage(provider, root, state.imagePath, state.image, executeHdiutil, {
    hostMount: state.hostMount,
    path: state.mount.path,
  });
  await rmdir(state.mount.path);
}
