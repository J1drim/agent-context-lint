import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse, parseDocument } from "yaml";

import { runBoundedCommand } from "./execute.mjs";
import { createPnpmRuntimeSnapshotPair } from "./pnpm-snapshot.mjs";

const PNPM_INVENTORY_CHILD = fileURLToPath(new URL("./pnpm-inventory.mjs", import.meta.url));

function sandboxLiteral(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function ancestorDirectories(value) {
  const ancestors = [];
  let current = path.dirname(value);
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

export function darwinPnpmInventoryPolicy(
  packageRoot,
  nodeExecutable,
  snapshotRoots = [packageRoot],
  inventoryChild = PNPM_INVENTORY_CHILD,
) {
  const nodePackageRoot = path.dirname(path.dirname(nodeExecutable));
  const readableSubpaths = [
    "/System/Library",
    "/usr/lib",
    nodePackageRoot,
    packageRoot,
    ...(Array.isArray(snapshotRoots) ? snapshotRoots : [snapshotRoots]),
  ];
  const readableFiles = ["/dev/null", inventoryChild, nodeExecutable];
  const readableAncestors = [
    ...new Set(
      [...readableSubpaths, ...readableFiles].flatMap((entry) => ancestorDirectories(entry)),
    ),
  ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    "(deny process-exec*)",
    "(deny file-read*)",
    ...readableAncestors.map((entry) => `(allow file-read* (literal "${sandboxLiteral(entry)}"))`),
    ...readableSubpaths.map((entry) => `(allow file-read* (subpath "${sandboxLiteral(entry)}"))`),
    ...readableFiles.map((entry) => `(allow file-read* (literal "${sandboxLiteral(entry)}"))`),
    `(allow process-exec (literal "${sandboxLiteral(nodeExecutable)}"))`,
  ].join(" ");
}

async function openFileAuthority(filePath, expectedSha256, label) {
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    (await realpath(filePath)) !== filePath ||
    !/^[0-9a-f]{64}$/u.test(expectedSha256)
  )
    throw new Error(`${label} authority is not canonical and digest-bound`);
  const parentPath = path.dirname(filePath);
  const parsed = path.parse(parentPath);
  const componentPaths = [parsed.root];
  let componentPath = parsed.root;
  for (const component of parentPath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    componentPath = path.join(componentPath, component);
    componentPaths.push(componentPath);
  }
  const directoryAuthorities = [];
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const sharedTemporaryRoots = new Set(
    await Promise.all(["/tmp", os.tmpdir()].map((entry) => realpath(entry))),
  );
  let fileHandle;
  try {
    for (const directoryPath of componentPaths) {
      const visible = await lstat(directoryPath);
      if (visible.isSymbolicLink() || !visible.isDirectory())
        throw new Error(`${label} authority path contains a non-directory component`);
      const handle = await open(
        directoryPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_DIRECTORY ?? 0),
      );
      const held = await handle.stat();
      if (
        !held.isDirectory() ||
        held.dev !== visible.dev ||
        held.ino !== visible.ino ||
        (await realpath(directoryPath)) !== directoryPath
      ) {
        await handle.close();
        throw new Error(`${label} authority path changed while anchoring`);
      }
      directoryAuthorities.push({
        before: held,
        handle,
        path: directoryPath,
        timestamps:
          uid !== null &&
          held.uid === uid &&
          (held.mode & 0o022) === 0 &&
          ![...sharedTemporaryRoots].some(
            (root) => root === directoryPath || root.startsWith(`${directoryPath}${path.sep}`),
          ),
      });
    }
    fileHandle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const [fileBefore, fileVisible] = await Promise.all([fileHandle.stat(), lstat(filePath)]);
    if (
      !fileBefore.isFile() ||
      fileVisible.isSymbolicLink() ||
      fileVisible.dev !== fileBefore.dev ||
      fileVisible.ino !== fileBefore.ino
    )
      throw new Error(`${label} authority changed while opening`);
    const bytes = await fileHandle.readFile();
    const fileAfterHash = await fileHandle.stat();
    if (
      fileAfterHash.dev !== fileBefore.dev ||
      fileAfterHash.ino !== fileBefore.ino ||
      fileAfterHash.size !== fileBefore.size ||
      fileAfterHash.mtimeMs !== fileBefore.mtimeMs ||
      fileAfterHash.ctimeMs !== fileBefore.ctimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256
    )
      throw new Error(`${label} authority digest or identity differs`);
    return {
      expectedSha256,
      bytes,
      fileBefore,
      fileHandle,
      filePath,
      label,
      directoryAuthorities,
    };
  } catch (error) {
    await fileHandle?.close();
    for (const authority of directoryAuthorities.reverse()) await authority.handle.close();
    throw error;
  }
}

async function createImmutableAuthorityBundle(authorities) {
  const container = await realpath(await mkdtemp(path.join(os.tmpdir(), "svetovid-authority-")));
  const paths = [];
  try {
    for (const [index, authority] of authorities.entries()) {
      const target = path.join(container, `authority-${String(index)}`);
      await writeFile(target, authority.bytes, { flag: "wx", mode: 0o500 });
      await chmod(target, 0o500);
      const [visible, resolved] = await Promise.all([lstat(target), realpath(target)]);
      if (
        resolved !== target ||
        visible.isSymbolicLink() ||
        !visible.isFile() ||
        createHash("sha256")
          .update(await readFile(target))
          .digest("hex") !== authority.expectedSha256
      )
        throw new Error(`${authority.label} immutable execution copy differs`);
      paths.push(target);
    }
    await chmod(container, 0o500);
    return Object.freeze({ container, paths: Object.freeze(paths) });
  } catch (error) {
    const cleanupErrors = [];
    try {
      await chmod(container, 0o700);
      await rm(container, { force: true, recursive: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError([error, ...cleanupErrors], "immutable authority bundling failed", {
        cause: error,
      });
    throw error;
  }
}

async function verifyFileAuthority(authority) {
  for (const [index, directory] of authority.directoryAuthorities.entries()) {
    const [held, visible, resolved] = await Promise.all([
      directory.handle.stat(),
      lstat(directory.path),
      realpath(directory.path),
    ]);
    if (
      resolved !== directory.path ||
      visible.isSymbolicLink() ||
      !visible.isDirectory() ||
      visible.dev !== directory.before.dev ||
      visible.ino !== directory.before.ino ||
      held.dev !== directory.before.dev ||
      held.ino !== directory.before.ino ||
      (directory.timestamps &&
        (held.mtimeMs !== directory.before.mtimeMs || held.ctimeMs !== directory.before.ctimeMs))
    )
      throw new Error(
        `${authority.label} authority path component ${String(Math.max(0, index - 1))} changed during sandbox execution`,
      );
  }
  const [fileHeld, fileVisible, resolved] = await Promise.all([
    authority.fileHandle.stat(),
    lstat(authority.filePath),
    realpath(authority.filePath),
  ]);
  if (
    resolved !== authority.filePath ||
    fileVisible.isSymbolicLink() ||
    fileVisible.dev !== authority.fileBefore.dev ||
    fileVisible.ino !== authority.fileBefore.ino ||
    fileHeld.dev !== authority.fileBefore.dev ||
    fileHeld.ino !== authority.fileBefore.ino ||
    fileHeld.size !== authority.fileBefore.size ||
    fileHeld.mtimeMs !== authority.fileBefore.mtimeMs ||
    fileHeld.ctimeMs !== authority.fileBefore.ctimeMs
  )
    throw new Error(`${authority.label} authority changed during sandbox execution`);
}

export async function runWithStableFileAuthorities(authorities, operation) {
  const opened = [];
  let bundle;
  let result;
  let failure = null;
  try {
    for (const authority of authorities)
      opened.push(await openFileAuthority(authority.path, authority.sha256, authority.label));
    bundle = await createImmutableAuthorityBundle(opened);
    for (const authority of opened) await verifyFileAuthority(authority);
    try {
      result = await operation(bundle.paths);
    } catch (error) {
      failure = error;
    }
    const identityErrors = [];
    for (const authority of opened) {
      try {
        await verifyFileAuthority(authority);
      } catch (error) {
        identityErrors.push(error);
      }
    }
    if (identityErrors.length > 0)
      failure = new AggregateError(
        failure === null ? identityErrors : [failure, ...identityErrors],
        "sandbox execution authority changed and its result was rejected",
        { cause: identityErrors[0] },
      );
  } finally {
    const closeErrors = [];
    if (bundle !== undefined) {
      try {
        await chmod(bundle.container, 0o700);
        await rm(bundle.container, { force: true, recursive: true });
      } catch (error) {
        closeErrors.push(error);
      }
    }
    for (const authority of opened.reverse()) {
      for (const handle of [
        authority.fileHandle,
        ...authority.directoryAuthorities.toReversed().map((entry) => entry.handle),
      ]) {
        try {
          await handle.close();
        } catch (error) {
          closeErrors.push(error);
        }
      }
    }
    if (closeErrors.length > 0)
      failure = new AggregateError(
        failure === null ? closeErrors : [failure, ...closeErrors],
        "sandbox execution authority handles did not close",
        { cause: closeErrors[0] },
      );
  }
  if (failure !== null) throw failure;
  return result;
}

export async function inspectPnpmRuntimePackageSandboxed(packageRoot, version, options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Object.keys(options).sort().join(",") !==
      "inventoryChildSha256,nodeExecutable,nodeSha256,sandboxExecutable,sandboxSha256"
  )
    throw new Error("pnpm inventory sandbox authority options are not closed");
  const { inventoryChildSha256, nodeExecutable, nodeSha256, sandboxExecutable, sandboxSha256 } =
    options;
  if (sandboxExecutable !== "/usr/bin/sandbox-exec")
    throw new Error("pnpm inventory requires exact /usr/bin/sandbox-exec authority");
  if (
    !/^[0-9a-f]{64}$/.test(inventoryChildSha256) ||
    (await pnpmInventoryChildSha256()) !== inventoryChildSha256
  )
    throw new Error("pnpm inventory child identity differs before sandbox execution");
  const root = await realpath(packageRoot);
  const snapshot = await createPnpmRuntimeSnapshotPair(root);
  let result;
  let failure = null;
  try {
    result = await runWithStableFileAuthorities(
      [
        { label: "sandbox-exec", path: sandboxExecutable, sha256: sandboxSha256 },
        { label: "vendored Node", path: nodeExecutable, sha256: nodeSha256 },
        {
          label: "pnpm inventory child",
          path: PNPM_INVENTORY_CHILD,
          sha256: inventoryChildSha256,
        },
      ],
      ([, immutableNode, immutableChild]) => {
        const policy = darwinPnpmInventoryPolicy(
          root,
          immutableNode,
          snapshot.paths,
          immutableChild,
        );
        return runBoundedCommand(
          sandboxExecutable,
          ["-p", policy, "--", immutableNode, immutableChild, root, ...snapshot.paths, version],
          {
            cwd: snapshot.paths[0],
            environment: {
              HOME: snapshot.paths[0],
              LANG: "C",
              LC_ALL: "C",
              PATH: "/usr/bin:/bin",
            },
            maximumStderrBytes: 16 * 1024,
            maximumStdoutBytes: 4096,
            stdinBytes: "GO\n",
            timeoutMs: 120_000,
          },
        );
      },
    );
  } catch (error) {
    failure = error;
  }
  try {
    await snapshot.remove();
  } catch (error) {
    failure = new AggregateError(
      failure === null ? [error] : [failure, error],
      "sandboxed pnpm runtime snapshot could not be removed",
      { cause: failure ?? error },
    );
  }
  if (failure !== null) throw failure;
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr !== "K03_PNPM_INVENTORY_READY\n" ||
    !result.stdout.endsWith("\n")
  )
    throw new Error("sandboxed pnpm runtime inventory failed");
  let observed;
  try {
    observed = JSON.parse(result.stdout);
  } catch {
    throw new Error("sandboxed pnpm runtime inventory emitted invalid JSON");
  }
  if (
    observed?.path !== root ||
    observed.version !== version ||
    !/^[0-9a-f]{64}$/.test(observed.sha256) ||
    Object.keys(observed).sort().join(",") !== "path,sha256,version"
  )
    throw new Error("sandboxed pnpm runtime inventory identity is invalid");
  return Object.freeze(observed);
}

export async function pnpmInventoryChildSha256() {
  return createHash("sha256")
    .update(await readFile(PNPM_INVENTORY_CHILD))
    .digest("hex");
}

async function readPackage(packageJsonPath, expectedName) {
  const resolved = await realpath(packageJsonPath);
  const value = JSON.parse(await readFile(resolved, "utf8"));
  if (value.name !== expectedName || typeof value.version !== "string")
    throw new Error(`native toolchain package identity differs for ${expectedName}`);
  return Object.freeze({ path: resolved, value });
}

async function readStableJsonFile(filePath, label, boundaries = null) {
  const beforeOpen = boundaries?.beforeOpen ?? null;
  const afterRead = boundaries?.afterRead ?? null;
  if (
    boundaries !== null &&
    (typeof boundaries !== "object" ||
      Object.keys(boundaries).sort().join(",") !==
        ["afterRead", "beforeOpen"].filter((key) => boundaries[key] !== undefined).join(","))
  )
    throw new Error(`${label} read boundaries are invalid`);
  if (
    (beforeOpen !== null && typeof beforeOpen !== "function") ||
    (afterRead !== null && typeof afterRead !== "function")
  )
    throw new Error(`${label} read boundaries are invalid`);
  const resolvedBefore = await realpath(filePath);
  const visibleBefore = await lstat(filePath);
  if (resolvedBefore !== filePath || visibleBefore.isSymbolicLink() || !visibleBefore.isFile())
    throw new Error(`${label} must be canonical and not symlinked`);
  if (beforeOpen !== null) await beforeOpen();
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== visibleBefore.dev || before.ino !== visibleBefore.ino)
      throw new Error(`${label} changed while opening`);
    const bytes = await handle.readFile();
    if (afterRead !== null) await afterRead();
    const [after, visibleAfter, resolvedAfter] = await Promise.all([
      handle.stat(),
      lstat(filePath),
      realpath(filePath),
    ]);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      resolvedAfter !== filePath ||
      visibleAfter.isSymbolicLink() ||
      !visibleAfter.isFile() ||
      visibleAfter.dev !== before.dev ||
      visibleAfter.ino !== before.ino
    )
      throw new Error(`${label} changed while reading`);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} must be valid unique-key UTF-8 JSON`);
    }
    const duplicateCheck = parseDocument(text, { maxAliasCount: 0, uniqueKeys: true });
    if (duplicateCheck.errors.length > 0)
      throw new Error(`${label} must be valid unique-key UTF-8 JSON`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} must be valid unique-key UTF-8 JSON`);
    }
  } finally {
    await handle.close();
  }
}

function containedPackagePath(packageRoot, relative, label) {
  if (
    typeof relative !== "string" ||
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative
      .split("/")
      .some((component) => component === "" || component === "." || component === "..")
  )
    throw new Error(`${label} is not a closed package-relative path`);
  const absolute = path.resolve(packageRoot, relative);
  if (absolute !== packageRoot && !absolute.startsWith(`${packageRoot}${path.sep}`))
    throw new Error(`${label} escapes its owning package`);
  return absolute;
}

async function validatePnpmOwner(candidate, executable, value) {
  const packageRoot = path.dirname(candidate);
  if (
    value.name !== "pnpm" ||
    typeof value.version !== "string" ||
    value.bin === null ||
    typeof value.bin !== "object" ||
    Array.isArray(value.bin) ||
    value.bin.pnpm !== "bin/pnpm.mjs" ||
    value.main !== value.bin.pnpm ||
    value.exports?.["."] !== "./package.json"
  )
    throw new Error("pnpm owning manifest does not expose the closed canonical launcher mapping");
  const mappedLauncher = containedPackagePath(packageRoot, value.bin.pnpm, "pnpm bin.pnpm");
  if (mappedLauncher !== executable || (await realpath(mappedLauncher)) !== mappedLauncher)
    throw new Error("pnpm bin.pnpm mapping does not resolve exactly to the supplied launcher");
  for (const [relative, label] of [
    ["bin/pnpm.cjs", "pnpm compatibility shim"],
    ["bin/pnpm.mjs", "pnpm launcher"],
    ["dist/pnpm.mjs", "pnpm bundled runtime"],
  ]) {
    const absolute = containedPackagePath(packageRoot, relative, label);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (await realpath(absolute)) !== absolute)
      throw new Error(`${label} is not a contained canonical ordinary file`);
  }
}

async function findOwningPackage(executable, expectedName, manifestReadBoundaries = null) {
  if (!path.isAbsolute(executable) || (await realpath(executable)) !== executable)
    throw new Error(`native toolchain ${expectedName} launcher must be canonical and unsymlinked`);
  let directory = path.dirname(executable);
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(directory, "package.json");
    let candidateMetadata;
    try {
      candidateMetadata = await lstat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
        continue;
      }
      throw error;
    }
    if (!candidateMetadata.isFile() || candidateMetadata.isSymbolicLink())
      throw new Error(`native toolchain encountered a hostile ${expectedName} package boundary`);
    const value = await readStableJsonFile(
      candidate,
      `${expectedName} owning manifest`,
      manifestReadBoundaries,
    );
    if (value.name === expectedName) {
      if (expectedName === "pnpm") await validatePnpmOwner(candidate, executable, value);
      if (typeof value.version !== "string")
        throw new Error(`native toolchain package identity differs for ${expectedName}`);
      return Object.freeze({ path: candidate, value });
    }
    throw new Error(`native toolchain crossed a decoy package boundary before ${expectedName}`);
  }
  throw new Error(`native toolchain cannot locate the owning ${expectedName} package`);
}

export async function digestTool(executable, version) {
  const resolved = await realpath(executable);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`native toolchain entry is not an ordinary file: ${executable}`);
  return Object.freeze({
    path: resolved,
    sha256: createHash("sha256")
      .update(await readFile(resolved))
      .digest("hex"),
    version,
  });
}

export async function inspectSystemTool(executable, command = runBoundedCommand) {
  const identity = await digestTool(executable, "pending-observed-help");
  let result;
  let failure = null;
  try {
    result = await command(identity.path, ["--help"], {
      cwd: path.dirname(identity.path),
      environment: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maximumStderrBytes: 16 * 1024,
      maximumStdoutBytes: 16 * 1024,
      timeoutMs: 30_000,
    });
  } catch (error) {
    failure = error;
  }
  let postflightFailure = null;
  try {
    const after = await digestTool(identity.path, identity.version);
    if (after.sha256 !== identity.sha256)
      throw new Error(`system tool changed during inspection: ${executable}`);
  } catch (error) {
    postflightFailure = error;
  }
  if (failure !== null && postflightFailure !== null)
    throw new AggregateError(
      [failure, postflightFailure],
      `system tool inspection failed and its executable identity changed: ${executable}`,
      { cause: failure },
    );
  if (failure !== null) throw failure;
  if (postflightFailure !== null) throw postflightFailure;
  const output = `${result.stdout}\0${result.stderr}`;
  if (result.signal !== null || output.length < 1)
    throw new Error(`system tool has no bounded observed help identity: ${executable}`);
  return Object.freeze({
    path: identity.path,
    sha256: identity.sha256,
    version: `help-sha256:${createHash("sha256").update(output).digest("hex")}`,
  });
}

export function canonicalLauncherSha256(text, workspaceRoot) {
  const targetRoot = /^# cmd-shim-target=(?<root>.+)\/node_modules\//mu.exec(text)?.groups?.root;
  if (targetRoot === undefined || !path.isAbsolute(targetRoot))
    throw new Error("native toolchain launcher lacks an exact pnpm shim target");
  return createHash("sha256")
    .update(text.replaceAll(targetRoot, "__WORKSPACE__").replaceAll(workspaceRoot, "__WORKSPACE__"))
    .digest("hex");
}

async function launcherIdentity(executable, version, workspaceRoot) {
  const metadata = await lstat(executable);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`native toolchain launcher is not an ordinary file: ${executable}`);
  return Object.freeze({
    path: path.resolve(executable),
    sha256: canonicalLauncherSha256(await readFile(executable, "utf8"), workspaceRoot),
    version,
  });
}

function assertLockIdentities(lock, workspacePackage) {
  const importer = lock.importers?.["."]?.devDependencies;
  const catalog = lock.catalogs?.default;
  const pnpmVersion = /^pnpm@(?<version>[^+]+)$/u.exec(workspacePackage.packageManager)?.groups
    ?.version;
  if (
    pnpmVersion === undefined ||
    workspacePackage.devEngines?.runtime?.name !== "node" ||
    importer?.node?.specifier !== `runtime:${workspacePackage.devEngines.runtime.version}` ||
    importer?.node?.version !== `runtime:${workspacePackage.devEngines.runtime.version}` ||
    catalog?.["@typescript/native"]?.specifier !== "npm:typescript@7.0.2" ||
    catalog?.["@typescript/native"]?.version !== "7.0.2" ||
    importer?.["@typescript/native"]?.version !== "typescript@7.0.2" ||
    importer?.esbuild?.specifier !== "0.28.1" ||
    importer?.esbuild?.version !== "0.28.1"
  )
    throw new Error("native toolchain package and lock identities are inconsistent");
  return Object.freeze({
    esbuild: importer.esbuild.version,
    node: workspacePackage.devEngines.runtime.version,
    pnpm: pnpmVersion,
    typescript: catalog["@typescript/native"].version,
  });
}

export async function inspectNativeBuildGraph(repositoryRoot) {
  const root = await realpath(repositoryRoot);
  const workspacePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = parse(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const versions = assertLockIdentities(lock, workspacePackage);
  const nodePackage = await readPackage(path.join(root, "node_modules/node/package.json"), "node");
  const typescriptPackage = await readPackage(
    path.join(root, "node_modules/@typescript/native/package.json"),
    "typescript",
  );
  const esbuildPackage = await readPackage(
    path.join(root, "node_modules/esbuild/package.json"),
    "esbuild",
  );
  if (
    nodePackage.value.version !== versions.node ||
    typescriptPackage.value.version !== versions.typescript ||
    esbuildPackage.value.version !== versions.esbuild
  )
    throw new Error("installed native toolchain differs from the frozen lock identities");

  const requireFromTypescript = createRequire(typescriptPackage.path);
  const platformPackageName = `@typescript/typescript-${process.platform}-${process.arch}`;
  const platformPackage = await readPackage(
    requireFromTypescript.resolve(`${platformPackageName}/package.json`),
    platformPackageName,
  );
  if (platformPackage.value.version !== versions.typescript)
    throw new Error("TypeScript native compiler differs from its launcher package");
  const esbuildPlatformName = `@esbuild/${process.platform}-${process.arch}`;
  const esbuildPlatformPackage = await readPackage(
    createRequire(esbuildPackage.path).resolve(`${esbuildPlatformName}/package.json`),
    esbuildPlatformName,
  );
  if (esbuildPlatformPackage.value.version !== versions.esbuild)
    throw new Error("esbuild platform binary differs from its launcher package");

  const paths = {
    esbuildEntry: path.join(root, "node_modules/esbuild/bin/esbuild"),
    esbuildLauncher: path.join(root, "node_modules/.bin/esbuild"),
    esbuildPackageManifest: esbuildPackage.path,
    esbuildPlatformManifest: esbuildPlatformPackage.path,
    esbuildPlatformBinary: path.join(path.dirname(esbuildPlatformPackage.path), "bin/esbuild"),
    node: path.join(root, "node_modules/node/bin/node"),
    typescriptCompiler: path.join(path.dirname(platformPackage.path), "lib/tsc"),
    typescriptEntry: path.join(root, "node_modules/@typescript/native/bin/tsc"),
    typescriptLauncher: path.join(root, "node_modules/.bin/tsc"),
    typescriptPackageManifest: typescriptPackage.path,
    typescriptPlatformManifest: platformPackage.path,
    typescriptResolver: path.join(root, "node_modules/@typescript/native/lib/getExePath.js"),
    typescriptRuntimeEntry: path.join(root, "node_modules/@typescript/native/lib/tsc.js"),
  };
  const [
    node,
    esbuildLauncher,
    esbuildEntry,
    esbuildPackageManifest,
    esbuildPlatformManifest,
    esbuildPlatformBinary,
    typescriptLauncher,
    typescriptEntry,
    typescriptCompiler,
    typescriptPackageManifest,
    typescriptPlatformManifest,
    typescriptResolver,
    typescriptRuntimeEntry,
  ] = await Promise.all([
    digestTool(paths.node, versions.node),
    launcherIdentity(paths.esbuildLauncher, versions.esbuild, root),
    digestTool(paths.esbuildEntry, versions.esbuild),
    digestTool(paths.esbuildPackageManifest, versions.esbuild),
    digestTool(paths.esbuildPlatformManifest, versions.esbuild),
    digestTool(paths.esbuildPlatformBinary, versions.esbuild),
    launcherIdentity(paths.typescriptLauncher, versions.typescript, root),
    digestTool(paths.typescriptEntry, versions.typescript),
    digestTool(paths.typescriptCompiler, versions.typescript),
    digestTool(paths.typescriptPackageManifest, versions.typescript),
    digestTool(paths.typescriptPlatformManifest, versions.typescript),
    digestTool(paths.typescriptResolver, versions.typescript),
    digestTool(paths.typescriptRuntimeEntry, versions.typescript),
  ]);
  return Object.freeze({
    buildTools: Object.freeze({
      esbuildEntry,
      esbuildLauncher,
      esbuildPackageManifest,
      esbuildPlatformBinary,
      esbuildPlatformManifest,
      typescriptCompiler,
      typescriptEntry,
      typescriptLauncher,
      typescriptPackageManifest,
      typescriptPlatformManifest,
      typescriptResolver,
      typescriptRuntimeEntry,
    }),
    node,
    versions,
  });
}

export async function inspectNativeToolchain(repositoryRoot, pnpmLauncher, sandbox) {
  const graph = await inspectNativeBuildGraph(repositoryRoot);
  if (typeof pnpmLauncher !== "string" || !path.isAbsolute(pnpmLauncher))
    throw new Error("native toolchain requires an exact absolute pnpm JavaScript launcher");
  const pnpmPackage = await findOwningPackage(pnpmLauncher, "pnpm");
  if (pnpmPackage.value.version !== graph.versions.pnpm)
    throw new Error("pnpm JavaScript launcher differs from the packageManager identity");
  const pnpmRoot = path.dirname(pnpmPackage.path);
  if (
    sandbox?.nodeExecutable !== graph.node.path ||
    sandbox?.sandboxExecutable !== "/usr/bin/sandbox-exec"
  )
    throw new Error("native toolchain requires the exact proof-bound pnpm inventory sandbox");
  const pnpmPaths = {
    pnpmBundle: path.join(pnpmRoot, "dist/pnpm.mjs"),
    pnpmCompatibilityShim: path.join(pnpmRoot, "bin/pnpm.cjs"),
    pnpmEntry: path.join(pnpmRoot, "bin/pnpm.mjs"),
    pnpmLauncher,
    pnpmPackageManifest: pnpmPackage.path,
  };
  const [
    pnpmBundle,
    pnpmCompatibilityShim,
    pnpmEntry,
    pnpmLauncherIdentity,
    pnpmPackageManifest,
    pnpmRuntime,
  ] = await Promise.all([
    digestTool(pnpmPaths.pnpmBundle, graph.versions.pnpm),
    digestTool(pnpmPaths.pnpmCompatibilityShim, graph.versions.pnpm),
    digestTool(pnpmPaths.pnpmEntry, graph.versions.pnpm),
    digestTool(pnpmPaths.pnpmLauncher, graph.versions.pnpm),
    digestTool(pnpmPaths.pnpmPackageManifest, graph.versions.pnpm),
    inspectPnpmRuntimePackageSandboxed(pnpmRoot, graph.versions.pnpm, sandbox),
  ]);
  return Object.freeze({
    ...graph,
    buildTools: Object.freeze({
      ...graph.buildTools,
      pnpmBundle,
      pnpmCompatibilityShim,
      pnpmEntry,
      pnpmLauncher: pnpmLauncherIdentity,
      pnpmPackageManifest,
      pnpmRuntime,
    }),
    pnpm: pnpmLauncherIdentity,
  });
}

export async function verifyPnpmRuntimeIdentity(identity, sandbox) {
  if (sandbox === null || sandbox === undefined)
    throw new Error("pnpm runtime identity requires its exact proof-bound sandbox");
  const observed = await inspectPnpmRuntimePackageSandboxed(
    identity?.path,
    identity?.version,
    sandbox,
  );
  if (observed.sha256 !== identity?.sha256)
    throw new Error("pnpm runtime package identity changed");
  return observed;
}

export async function inspectPnpmLauncherIdentity(pnpmLauncher) {
  if (typeof pnpmLauncher !== "string" || !path.isAbsolute(pnpmLauncher))
    throw new Error("pnpm launcher must be exact and absolute");
  const owner = await findOwningPackage(pnpmLauncher, "pnpm");
  return digestTool(pnpmLauncher, owner.value.version);
}

/** @internal Deterministic identity-race seam for owning-manifest regression tests. */
export async function inspectPnpmLauncherIdentityWithManifestReadBoundaryForTests(
  pnpmLauncher,
  afterManifestRead,
) {
  if (typeof pnpmLauncher !== "string" || !path.isAbsolute(pnpmLauncher))
    throw new Error("pnpm launcher must be exact and absolute");
  const owner = await findOwningPackage(pnpmLauncher, "pnpm", { afterRead: afterManifestRead });
  return digestTool(pnpmLauncher, owner.value.version);
}

/** @internal Deterministic pre/post-open pathname race seam for manifest regression tests. */
export async function inspectPnpmLauncherIdentityWithManifestBoundariesForTests(
  pnpmLauncher,
  boundaries,
) {
  if (typeof pnpmLauncher !== "string" || !path.isAbsolute(pnpmLauncher))
    throw new Error("pnpm launcher must be exact and absolute");
  const owner = await findOwningPackage(pnpmLauncher, "pnpm", boundaries);
  return digestTool(pnpmLauncher, owner.value.version);
}

export async function verifyToolIdentity(tool, expectedPath = tool?.path) {
  if (tool?.path !== expectedPath)
    throw new Error(`native tool proof does not bind ${expectedPath}`);
  const observed = await digestTool(expectedPath, tool.version);
  if (observed.sha256 !== tool.sha256)
    throw new Error(`native tool identity changed: ${expectedPath}`);
  return observed;
}
