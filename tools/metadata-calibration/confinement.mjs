import { createHash } from "node:crypto";
import { chmod, lstat, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { runBoundedCommand } from "./execute.mjs";
import {
  canonicalLauncherSha256,
  pnpmInventoryChildSha256,
  verifyPnpmRuntimeIdentity,
} from "./native-toolchain.mjs";

function sandboxLiteral(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0"))
    throw new Error("sandbox path must be canonical and absolute");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizedSandboxLiteral(value) {
  if (
    typeof value !== "string" ||
    (!path.isAbsolute(value) && !/^__K03_(?:WORKSPACE|TEMPORARY)__(?:\/|$)/u.test(value)) ||
    value.includes("\0")
  )
    throw new Error("normalized sandbox path must be absolute or a K03 root token");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function darwinBuildProfileTemplate(
  nodeExecutable,
  helperExecutables = ["/bin/sh", "/usr/bin/env"],
  allowedExecutables = [],
) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-exec*)",
    `(allow process-exec* (literal ${sandboxLiteral(nodeExecutable)}))`,
    ...helperExecutables.map(
      (executable) => `(allow process-exec* (literal ${sandboxLiteral(executable)}))`,
    ),
    ...allowedExecutables.map(
      (executable) => `(allow process-exec* (literal ${sandboxLiteral(executable)}))`,
    ),
    "(deny file-write*)",
    '(allow file-write* (subpath "__K03_WORKSPACE__"))',
    '(allow file-write* (subpath "__K03_TEMPORARY__"))',
    '(allow file-write* (literal "/dev/null"))',
    "",
  ].join("\n");
}

function normalizedDarwinBuildProfileTemplate(
  nodeExecutable,
  helperExecutables,
  allowedExecutables,
) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-exec*)",
    `(allow process-exec* (literal ${normalizedSandboxLiteral(nodeExecutable)}))`,
    ...helperExecutables.map(
      (executable) => `(allow process-exec* (literal ${normalizedSandboxLiteral(executable)}))`,
    ),
    ...allowedExecutables.map(
      (executable) => `(allow process-exec* (literal ${normalizedSandboxLiteral(executable)}))`,
    ),
    "(deny file-write*)",
    '(allow file-write* (subpath "__K03_WORKSPACE__"))',
    '(allow file-write* (subpath "__K03_TEMPORARY__"))',
    '(allow file-write* (literal "/dev/null"))',
    "",
  ].join("\n");
}

async function verifyTool(tool, expectedPath) {
  if (tool?.path !== expectedPath || (await realpath(expectedPath)) !== expectedPath)
    throw new Error(`native confinement proof does not bind ${expectedPath}`);
  const metadata = await lstat(expectedPath);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`reviewed confinement tool is not an ordinary file: ${expectedPath}`);
  const digest = createHash("sha256")
    .update(await readFile(expectedPath))
    .digest("hex");
  if (digest !== tool.sha256)
    throw new Error(`reviewed confinement tool identity changed: ${expectedPath}`);
}

async function verifyBuildTool(tool, expectedPath, workspaceRoot, launcher = false) {
  const resolved = launcher ? path.resolve(expectedPath) : await realpath(expectedPath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`reviewed build tool is not an ordinary file: ${expectedPath}`);
  const bytes = await readFile(resolved, launcher ? "utf8" : null);
  const digest = launcher
    ? canonicalLauncherSha256(bytes, workspaceRoot)
    : createHash("sha256").update(bytes).digest("hex");
  if (digest !== tool?.sha256)
    throw new Error(`reviewed build-tool identity changed: ${expectedPath}`);
  return resolved;
}

export async function workspaceBuildGraph(rootValue) {
  const root = await realpath(rootValue);
  const typescriptPackageManifest = await realpath(
    path.join(root, "node_modules/@typescript/native/package.json"),
  );
  const esbuildPackageManifest = await realpath(
    path.join(root, "node_modules/esbuild/package.json"),
  );
  const typescriptPackageRoot = path.dirname(typescriptPackageManifest);
  const esbuildPackageRoot = path.dirname(esbuildPackageManifest);
  const requireFromTypescript = createRequire(typescriptPackageManifest);
  const requireFromEsbuild = createRequire(esbuildPackageManifest);
  const platformPackage = requireFromTypescript.resolve(
    `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
  );
  const esbuildPlatformPackage = requireFromEsbuild.resolve(
    `@esbuild/${process.platform}-${process.arch}/package.json`,
  );
  return Object.freeze({
    esbuildEntry: path.join(esbuildPackageRoot, "bin/esbuild"),
    esbuildLauncher: path.join(root, "node_modules/.bin/esbuild"),
    esbuildPackageManifest,
    esbuildPlatformBinary: path.join(path.dirname(esbuildPlatformPackage), "bin/esbuild"),
    esbuildPlatformManifest: esbuildPlatformPackage,
    typescriptCompiler: path.join(path.dirname(platformPackage), "lib/tsc"),
    typescriptEntry: path.join(typescriptPackageRoot, "bin/tsc"),
    typescriptLauncher: path.join(root, "node_modules/.bin/tsc"),
    typescriptPackageManifest,
    typescriptPlatformManifest: platformPackage,
    typescriptResolver: path.join(typescriptPackageRoot, "lib/getExePath.js"),
    typescriptRuntimeEntry: path.join(typescriptPackageRoot, "lib/tsc.js"),
  });
}

function normalizePolicyPath(value, workspaceRoot, temporaryRoot) {
  for (const [root, token] of [
    [workspaceRoot, "__K03_WORKSPACE__"],
    [temporaryRoot, "__K03_TEMPORARY__"],
  ]) {
    if (value === root) return token;
    if (value.startsWith(`${root}${path.sep}`))
      return `${token}/${path.relative(root, value).split(path.sep).join("/")}`;
  }
  return value;
}

export function normalizedDarwinPhasePolicy({
  allowedExecutables,
  helperExecutables,
  nodeExecutable,
  temporaryRoot,
  workspaceRoot,
}) {
  const normalizeAllowed = (values) =>
    [
      ...new Set(values.map((value) => normalizePolicyPath(value, workspaceRoot, temporaryRoot))),
    ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const normalizeFixed = (values) =>
    [...new Set(values)].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
  return normalizedDarwinBuildProfileTemplate(
    nodeExecutable,
    normalizeFixed(helperExecutables),
    normalizeAllowed(allowedExecutables),
  );
}

export function darwinPhasePolicySha256(options) {
  return createHash("sha256").update(normalizedDarwinPhasePolicy(options)).digest("hex");
}

const EXECUTABLE_BUILD_TOOLS = new Set([
  "esbuildEntry",
  "esbuildLauncher",
  "esbuildPlatformBinary",
  "typescriptCompiler",
  "typescriptEntry",
  "typescriptLauncher",
]);

async function confinedCommand(profile, executable, arguments_, cwd, environment, command) {
  return command("/usr/bin/sandbox-exec", ["-p", profile, "--", executable, ...arguments_], {
    cwd,
    environment,
    maximumStderrBytes: 64 * 1024,
    maximumStdoutBytes: 64 * 1024,
    timeoutMs: 30_000,
  });
}

async function assertParentConfinement({
  command,
  environment,
  nodeExecutable,
  profile,
  temporaryRoot,
  workspaceRoot,
}) {
  const allowedPath = path.join(workspaceRoot, "confinement-probe.txt");
  const newExecutable = path.join(workspaceRoot, "newly-created-executable");
  await writeFile(newExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(newExecutable, 0o700);
  const outsidePath = path.join(
    path.dirname(temporaryRoot),
    `k03-write-escape-${path.basename(temporaryRoot)}.txt`,
  );
  const allowed = await confinedCommand(
    profile,
    nodeExecutable,
    [
      "--input-type=module",
      "--eval",
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(allowedPath)}, "ok\\n");`,
    ],
    workspaceRoot,
    environment,
    command,
  );
  if (allowed.status !== 0 || allowed.signal !== null)
    throw new Error("Darwin parent confinement denied its exact workspace write probe");
  await unlink(allowedPath);
  const denialProbes = [
    [newExecutable, []],
    ["/usr/bin/curl", ["--version"]],
    [nodeExecutable, ["--input-type=module", "--eval", 'await fetch("https://example.invalid/")']],
    [
      nodeExecutable,
      [
        "--input-type=module",
        "--eval",
        'import { spawnSync } from "node:child_process"; const result = spawnSync("/usr/bin/curl", ["--version"]); if (result.status !== 0) process.exit(91);',
      ],
    ],
    [
      nodeExecutable,
      [
        "--input-type=module",
        "--eval",
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(outsidePath)}, "escape");`,
      ],
    ],
  ];
  for (const [executable, arguments_] of denialProbes) {
    const denied = await confinedCommand(
      profile,
      executable,
      arguments_,
      workspaceRoot,
      environment,
      command,
    );
    if (denied.status === 0 && denied.signal === null)
      throw new Error("Darwin parent confinement accepted a mandatory denial probe");
  }
  await unlink(newExecutable);
  try {
    await lstat(outsidePath);
    await unlink(outsidePath);
    throw new Error("Darwin parent confinement created its write-escape probe");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createDarwinConfinementFactory({
  command = runBoundedCommand,
  environment,
  nativeProof,
  nodeExecutable,
  temporaryRoot,
}) {
  if (process.platform !== "darwin")
    throw new Error("K03 clean build confinement is feature-unavailable outside Darwin");
  if (nativeProof?.status !== "ready" || nativeProof.runner.platform !== "darwin")
    throw new Error("K03 clean build requires a validated native Darwin proof");
  const helperExecutables = [
    nativeProof.tools.bash.path,
    nativeProof.tools.sh.path,
    nativeProof.tools.env.path,
    nativeProof.tools.dirname.path,
    nativeProof.tools.sed.path,
    nativeProof.tools.uname.path,
  ];
  return async (workspaceRoot, phase = "pack") => {
    const root = await realpath(workspaceRoot);
    const temporary = await realpath(temporaryRoot);
    const verifyPhaseTools = async () => {
      await verifyTool(nativeProof.tools.sandboxExec, "/usr/bin/sandbox-exec");
      await verifyTool(nativeProof.tools.node, await realpath(nodeExecutable));
      await verifyTool(nativeProof.tools.bash, "/bin/bash");
      await verifyTool(nativeProof.tools.sh, "/bin/sh");
      await verifyTool(nativeProof.tools.env, "/usr/bin/env");
      await verifyTool(nativeProof.tools.dirname, "/usr/bin/dirname");
      await verifyTool(nativeProof.tools.sed, "/usr/bin/sed");
      await verifyTool(nativeProof.tools.uname, "/usr/bin/uname");
      if ((await pnpmInventoryChildSha256()) !== nativeProof.confinement.inventoryChildSha256)
        throw new Error("pnpm inventory child differs from the committed native proof");
      const buildExecutables = [];
      for (const [name, expected] of Object.entries(nativeProof.buildTools)) {
        if (!name.startsWith("pnpm")) continue;
        if (name === "pnpmRuntime")
          await verifyPnpmRuntimeIdentity(expected, {
            inventoryChildSha256: nativeProof.confinement.inventoryChildSha256,
            nodeExecutable,
            nodeSha256: nativeProof.tools.node.sha256,
            sandboxExecutable: nativeProof.tools.sandboxExec.path,
            sandboxSha256: nativeProof.tools.sandboxExec.sha256,
          });
        else await verifyBuildTool(expected, expected.path, root);
      }
      if (phase === "pack") {
        const graph = await workspaceBuildGraph(root);
        for (const [name, expected] of Object.entries(nativeProof.buildTools)) {
          if (name.startsWith("pnpm")) continue;
          const executable = await verifyBuildTool(
            expected,
            graph[name],
            root,
            name.endsWith("Launcher"),
          );
          if (EXECUTABLE_BUILD_TOOLS.has(name)) buildExecutables.push(executable);
        }
      } else if (phase === "extract") {
        await verifyTool(nativeProof.tools.tar, nativeProof.tools.tar.path);
        buildExecutables.push(nativeProof.tools.tar.path);
      } else if (phase !== "install") throw new Error("unknown clean-build confinement phase");
      return buildExecutables;
    };
    const buildExecutables = await verifyPhaseTools();
    const normalizedPolicySha256 = darwinPhasePolicySha256({
      allowedExecutables: buildExecutables,
      helperExecutables,
      nodeExecutable,
      temporaryRoot: temporary,
      workspaceRoot: root,
    });
    if (normalizedPolicySha256 !== nativeProof.confinement.phasePolicySha256?.[phase])
      throw new Error(`Darwin ${phase} confinement policy differs from the committed native proof`);
    const phaseTemplate = darwinBuildProfileTemplate(
      nodeExecutable,
      helperExecutables,
      buildExecutables,
    );
    const profile = phaseTemplate
      .replaceAll("__K03_WORKSPACE__", root.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))
      .replaceAll("__K03_TEMPORARY__", temporary.replaceAll("\\", "\\\\").replaceAll('"', '\\"'));
    await assertParentConfinement({
      command,
      environment,
      nodeExecutable,
      profile,
      temporaryRoot: temporary,
      workspaceRoot: root,
    });
    if (phase === "install") {
      await verifyTool(nativeProof.tools.pnpm, nativeProof.tools.pnpm.path);
      const pnpm = await confinedCommand(
        profile,
        nodeExecutable,
        [nativeProof.tools.pnpm.path, "--version"],
        root,
        environment,
        command,
      );
      if (
        pnpm.status !== 0 ||
        pnpm.signal !== null ||
        pnpm.stdout.trim() !== nativeProof.tools.pnpm.version
      )
        throw new Error("confined pnpm launcher probe differs from the native proof");
    }
    if (phase === "pack") {
      const graph = await workspaceBuildGraph(root);
      const probes = [
        [graph.esbuildLauncher, nativeProof.buildTools.esbuildLauncher.version],
        [graph.typescriptLauncher, `Version ${nativeProof.buildTools.typescriptLauncher.version}`],
      ];
      for (const [executable, expectedVersion] of probes) {
        const probe = await confinedCommand(
          profile,
          executable,
          ["--version"],
          root,
          environment,
          command,
        );
        if (
          probe.status !== 0 ||
          probe.signal !== null ||
          probe.stdout.trim() !== expectedVersion
        ) {
          const sanitize = (value) =>
            value.replaceAll(root, "<workspace>").replaceAll(temporary, "<temporary>");
          throw new Error(
            `confined native build-tool probe failed for ${path.basename(executable)} (status=${String(probe.status)}, signal=${JSON.stringify(probe.signal)}, stdout=${JSON.stringify(sanitize(probe.stdout))}, stderr=${JSON.stringify(sanitize(probe.stderr))})`,
          );
        }
      }
    }
    return Object.freeze({
      profile,
      sandboxExecutable: "/usr/bin/sandbox-exec",
      verifyAfter: async () => {
        const observedExecutables = await verifyPhaseTools();
        const observedProfile = darwinBuildProfileTemplate(
          nodeExecutable,
          helperExecutables,
          observedExecutables,
        )
          .replaceAll("__K03_WORKSPACE__", root.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))
          .replaceAll(
            "__K03_TEMPORARY__",
            temporary.replaceAll("\\", "\\\\").replaceAll('"', '\\"'),
          );
        if (observedProfile !== profile)
          throw new Error("Darwin confinement profile changed during the reviewed operation");
        const observedPolicySha256 = darwinPhasePolicySha256({
          allowedExecutables: observedExecutables,
          helperExecutables,
          nodeExecutable,
          temporaryRoot: temporary,
          workspaceRoot: root,
        });
        if (observedPolicySha256 !== normalizedPolicySha256)
          throw new Error(
            "Darwin normalized confinement policy changed during the reviewed operation",
          );
      },
    });
  };
}
