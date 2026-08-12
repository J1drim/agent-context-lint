import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertExactPreparationConfinement,
  normalizePreparationConfinement,
  withPreparationContainer,
} from "./preparation-container.mjs";
import { createPreparationSourceSnapshot } from "./preparation-source.mjs";
import {
  canonicalJson,
  verifyBaseDescriptors,
  verifyInputDirectory,
} from "./container/runtime-inputs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const slot = process.argv.find((argument) => argument.startsWith("--slot="))?.slice(7);
if (!["a", "b"].includes(slot))
  throw new Error(
    "usage: node tools/standards/prepare-recovery-runtime.mjs --acknowledge-network --slot=a|b",
  );
const destination = path.join(
  os.tmpdir(),
  `agent-context-h13-${path.basename(root)}-runtime-inputs-${slot}`,
);
const docker = "/opt/homebrew/Cellar/docker/29.5.2/bin/docker";
const base = "node@sha256:9b02ede55039f443ad57453a741813c6cd105873f0f66fee95d25529e1ba0533";
const buildLock = JSON.parse(
  await readFile(path.join(root, "tools/standards/container/build-lock.v1.json"), "utf8"),
);
if (!process.argv.includes("--acknowledge-network") || process.argv.length !== 4)
  throw new Error(
    "usage: node tools/standards/prepare-recovery-runtime.mjs --acknowledge-network --slot=a|b",
  );

const deadline = performance.now() + 1_200_000;
const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "agent-context-h13-prepare-"));
const prepared = path.join(temporaryParent, "prepared");
const networkInput = path.join(temporaryParent, "network-input");
const networkWrite = path.join(temporaryParent, "network-write");
const networkOutput = path.join(networkWrite, "prepared");
const sourceSnapshot = path.join(temporaryParent, "source-snapshot");

function remaining(phase) {
  const value = deadline - performance.now();
  if (value < 1) throw new Error(`runtime preparation deadline expired during ${phase}`);
  return value;
}

async function run(arguments_, { capture = false, timeoutMs = 300_000 } = {}) {
  const child = spawn(docker, arguments_, {
    cwd: root,
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let outputExceeded = false;
  const consume = (target) => (chunk) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > 4 * 1024 * 1024) {
      outputExceeded = true;
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      return;
    }
    if (target === "stdout") stdout += chunk;
    else stderr += chunk;
    if (!capture) (target === "stdout" ? process.stdout : process.stderr).write(chunk);
  };
  child.stdout.on("data", consume("stdout"));
  child.stderr.on("data", consume("stderr"));
  const result = await new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      },
      Math.min(timeoutMs, remaining("Docker client")),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
  if (outputExceeded) throw new Error("runtime preparation Docker output exceeds its bound");
  return { ...result, stderr: stderr.trim(), stdout: stdout.trim() };
}

async function startContainer(identity, phase, timeoutMs) {
  const available = remaining(phase);
  if (available <= 20_000)
    throw new Error(`runtime preparation lacks cleanup reserve during ${phase}`);
  const result = await run(["container", "start", "--attach", identity], {
    timeoutMs: Math.min(timeoutMs, available - 20_000),
  });
  if (result.code !== 0 || result.signal !== null || result.timedOut)
    throw new Error(`runtime preparation failed during ${phase}`);
  const state = await run(["container", "inspect", identity, "--format", "{{json .State}}"], {
    capture: true,
    timeoutMs: Math.min(5_000, remaining(`${phase} state`)),
  });
  const decoded = JSON.parse(state.stdout);
  if (state.code !== 0 || state.signal !== null || state.timedOut || decoded.ExitCode !== 0)
    throw new Error(`runtime preparation container failed during ${phase}`);
}

const commonConfinement = [
  "--pull",
  "never",
  "--platform",
  "linux/arm64",
  "--pid=",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges=true",
  "--pids-limit",
  "128",
  "--memory",
  "4294967296",
  "--memory-swap",
  "4294967296",
  "--cpus",
  "2",
  "--ipc",
  "none",
  "--init",
  "--tmpfs",
  "/tmp:rw,exec,nosuid,nodev,size=536870912,mode=0700",
];

function assertBaseContainerIdentity(container) {
  if (
    container.Image !== buildLock.baseImage.platformManifestDigest ||
    container.ImageManifestDescriptor?.digest !== buildLock.baseImage.platformManifestDigest ||
    (container.ImageManifestDescriptor?.annotations?.["config.digest"] !== undefined &&
      container.ImageManifestDescriptor.annotations["config.digest"] !==
        buildLock.baseImage.configurationDigest)
  )
    throw new Error("runtime preparation container differs from the locked OCI identity");
}

let expectedBaseRuntimeConfiguration;

const defaultMaskedPaths = [
  "/proc/asound",
  "/proc/acpi",
  "/proc/interrupts",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/proc/sched_debug",
  "/proc/scsi",
  "/sys/firmware",
  "/sys/devices/virtual/powercap",
];
const defaultReadonlyPaths = [
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger",
];

function assertPreparationConfinement(
  container,
  { command, entrypoint, image, mounts, networkMode, nonce },
) {
  const actual = normalizePreparationConfinement(container);
  const expected = {
    config: {
      ArgsEscaped: false,
      AttachStderr: true,
      AttachStdin: false,
      AttachStdout: true,
      Cmd: command,
      Domainname: "",
      Entrypoint: [entrypoint],
      Env: expectedBaseRuntimeConfiguration?.Env,
      ExposedPorts: expectedBaseRuntimeConfiguration?.ExposedPorts ?? null,
      Healthcheck: expectedBaseRuntimeConfiguration?.Healthcheck ?? null,
      Hostname: container.Id.slice(0, 12),
      Image: image,
      Labels: {
        "agent-context.h13.preparation": "agent-context-linter",
        "agent-context.h13.preparation-nonce": nonce,
      },
      MacAddress: expectedBaseRuntimeConfiguration?.MacAddress ?? "",
      NetworkDisabled: false,
      OnBuild: expectedBaseRuntimeConfiguration?.OnBuild ?? null,
      OpenStdin: false,
      Shell: expectedBaseRuntimeConfiguration?.Shell ?? null,
      StdinOnce: false,
      StopSignal: expectedBaseRuntimeConfiguration?.StopSignal ?? "",
      StopTimeout: expectedBaseRuntimeConfiguration?.StopTimeout ?? null,
      Tty: false,
      User: expectedBaseRuntimeConfiguration?.User ?? "",
      Volumes: expectedBaseRuntimeConfiguration?.Volumes ?? null,
      WorkingDir: expectedBaseRuntimeConfiguration?.WorkingDir ?? "",
    },
    hostConfig: {
      Annotations: null,
      AutoRemove: false,
      Binds: null,
      BlkioDeviceReadBps: [],
      BlkioDeviceReadIOps: [],
      BlkioDeviceWriteBps: [],
      BlkioDeviceWriteIOps: [],
      BlkioWeight: 0,
      BlkioWeightDevice: [],
      CapAdd: null,
      CapDrop: ["ALL"],
      Cgroup: "",
      CgroupParent: "",
      CgroupnsMode: "private",
      ConsoleSize: [0, 0],
      ContainerIDFile: "",
      CpuCount: 0,
      CpuPercent: 0,
      CpuPeriod: 0,
      CpuQuota: 0,
      CpuRealtimePeriod: 0,
      CpuRealtimeRuntime: 0,
      CpuShares: 0,
      CpusetCpus: "",
      CpusetMems: "",
      DeviceCgroupRules: null,
      DeviceRequests: null,
      Devices: [],
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: null,
      GroupAdd: null,
      IOMaximumBandwidth: 0,
      IOMaximumIOps: 0,
      Init: true,
      IpcMode: "none",
      Isolation: "",
      Links: null,
      LogConfig: { Config: {}, Type: "json-file" },
      MaskedPaths: defaultMaskedPaths,
      Memory: 4_294_967_296,
      MemoryReservation: 0,
      MemorySwap: 4_294_967_296,
      MemorySwappiness: null,
      Mounts: mounts.map((mount) => ({
        Consistency: "",
        ReadOnly: mount.readOnly,
        Source: mount.source,
        Target: mount.destination,
        Type: mount.type,
      })),
      NanoCpus: 2_000_000_000,
      NetworkMode: networkMode,
      OomKillDisable: null,
      OomScoreAdj: 0,
      PidMode: "",
      PidsLimit: 128,
      PortBindings: {},
      Privileged: false,
      PublishAllPorts: false,
      ReadonlyPaths: defaultReadonlyPaths,
      ReadonlyRootfs: true,
      RestartPolicy: { MaximumRetryCount: 0, Name: "no" },
      Runtime: "runc",
      SecurityOpt: ["no-new-privileges=true"],
      ShmSize: 67_108_864,
      StorageOpt: {},
      Sysctls: null,
      Tmpfs: { "/tmp": "rw,exec,nosuid,nodev,size=536870912,mode=0700" },
      UTSMode: "",
      Ulimits: null,
      UsernsMode: "",
      VolumeDriver: "",
      VolumesFrom: null,
    },
    mounts: mounts.toSorted((left, right) =>
      Buffer.compare(Buffer.from(left.destination), Buffer.from(right.destination)),
    ),
    state: { pid: 0, running: false },
  };
  assertExactPreparationConfinement(actual, expected);
}

function preparationValidator(policy) {
  return (container, identity) => {
    assertBaseContainerIdentity(container);
    assertPreparationConfinement(container, { ...identity, ...policy });
  };
}

try {
  const preparationSource = await createPreparationSourceSnapshot(root, sourceSnapshot, {
    deadline: { expiresAt: deadline },
  });
  const baseDescriptors = await verifyBaseDescriptors(
    path.join(root, "tools/standards/container"),
    buildLock.baseImage,
  );
  expectedBaseRuntimeConfiguration = baseDescriptors.configuration.config ?? {};
  const pulled = await run(["pull", "--platform", "linux/arm64", base], { timeoutMs: 300_000 });
  if (pulled.code !== 0 || pulled.signal !== null || pulled.timedOut)
    throw new Error("runtime preparation base pull failed");
  const inspectedResult = await run(["image", "inspect", base, "--format", "{{json .}}"], {
    capture: true,
    timeoutMs: 10_000,
  });
  if (inspectedResult.code !== 0 || inspectedResult.signal !== null || inspectedResult.timedOut)
    throw new Error("runtime preparation base inspection failed");
  const inspectedBaseImage = JSON.parse(inspectedResult.stdout);
  if (
    inspectedBaseImage.Id !== buildLock.baseImage.platformManifestDigest ||
    inspectedBaseImage.Descriptor?.digest !== buildLock.baseImage.platformManifestDigest ||
    !inspectedBaseImage.RepoDigests?.includes(base) ||
    inspectedBaseImage.Architecture !== baseDescriptors.configuration.architecture ||
    inspectedBaseImage.Os !== baseDescriptors.configuration.os ||
    inspectedBaseImage.Variant !== baseDescriptors.configuration.variant ||
    canonicalJson(inspectedBaseImage.Config?.Env) !==
      canonicalJson(baseDescriptors.configuration.config?.Env) ||
    canonicalJson(inspectedBaseImage.Config?.Entrypoint) !==
      canonicalJson(baseDescriptors.configuration.config?.Entrypoint) ||
    canonicalJson(inspectedBaseImage.Config?.Cmd) !==
      canonicalJson(baseDescriptors.configuration.config?.Cmd) ||
    canonicalJson(inspectedBaseImage.RootFS?.Layers) !==
      canonicalJson(baseDescriptors.configuration.rootfs?.diff_ids)
  )
    throw new Error("local base image differs from the complete locked OCI identity");

  await withPreparationContainer({
    createArguments: [...commonConfinement, "--network", "none", "--entrypoint", "/bin/true"],
    deadline,
    image: base,
    invoke: run,
    namePrefix: "agent-context-h13-base",
    operation: async (identity) => {
      const exported = await run([
        "container",
        "export",
        "--output",
        path.join(temporaryParent, "base-export.v1.tar"),
        identity,
      ]);
      if (exported.code !== 0 || exported.signal !== null || exported.timedOut)
        throw new Error("base rootfs export failed");
    },
    validateContainer: preparationValidator({
      command: null,
      entrypoint: "/bin/true",
      mounts: [],
      networkMode: "none",
    }),
  });

  await mkdir(networkInput, { mode: 0o700 });
  await mkdir(networkWrite, { mode: 0o700 });
  const lockfilePath = path.join(sourceSnapshot, "pnpm-lock.yaml");
  const lockfileState = await lstat(lockfilePath, { bigint: true });
  if (
    !lockfileState.isFile() ||
    lockfileState.isSymbolicLink() ||
    lockfileState.nlink !== 1n ||
    lockfileState.size > 4n * 1024n * 1024n
  )
    throw new Error("runtime preparation lockfile is outside its regular-file bounds");
  const networkLockfileBytes = await readFile(lockfilePath);
  const lockfileStateAfter = await lstat(lockfilePath, { bigint: true });
  if (
    lockfileState.dev !== lockfileStateAfter.dev ||
    lockfileState.ino !== lockfileStateAfter.ino ||
    lockfileState.size !== lockfileStateAfter.size ||
    lockfileState.mtimeNs !== lockfileStateAfter.mtimeNs
  )
    throw new Error("runtime preparation lockfile changed while it was snapshotted");
  await writeFile(path.join(networkInput, "pnpm-lock.yaml"), networkLockfileBytes, {
    flag: "wx",
    mode: 0o600,
  });
  await cp(
    path.join(sourceSnapshot, "tools/standards/container/prepare-network-inside.mjs"),
    path.join(networkInput, "prepare-network-inside.mjs"),
    { errorOnExist: true, force: false },
  );
  await cp(
    path.join(sourceSnapshot, "tools/standards/container/runtime-inputs.mjs"),
    path.join(networkInput, "runtime-inputs.mjs"),
    { errorOnExist: true, force: false },
  );
  await withPreparationContainer({
    commandArguments: [
      "/network-input/prepare-network-inside.mjs",
      "/network-input",
      "/output/prepared",
    ],
    createArguments: [
      ...commonConfinement,
      "--network",
      "bridge",
      "--mount",
      `type=bind,src=${networkInput},dst=/network-input,readonly`,
      "--mount",
      `type=bind,src=${networkWrite},dst=/output`,
      "--entrypoint",
      "/usr/local/bin/node",
    ],
    deadline,
    image: base,
    invoke: run,
    namePrefix: "agent-context-h13-network",
    operation: (identity) => startContainer(identity, "network fetch", 600_000),
    validateContainer: preparationValidator({
      command: ["/network-input/prepare-network-inside.mjs", "/network-input", "/output/prepared"],
      entrypoint: "/usr/local/bin/node",
      mounts: [
        { destination: "/network-input", readOnly: true, source: networkInput, type: "bind" },
        { destination: "/output", readOnly: false, source: networkWrite, type: "bind" },
      ],
      networkMode: "bridge",
    }),
  });
  await withPreparationContainer({
    commandArguments: [
      "/input/tools/standards/container/prepare-runtime-inside.mjs",
      "/output/prepared",
      "/network-input",
    ],
    createArguments: [
      ...commonConfinement,
      "--network",
      "none",
      "--mount",
      `type=bind,src=${sourceSnapshot},dst=/input,readonly`,
      "--mount",
      `type=bind,src=${networkOutput},dst=/network-input,readonly`,
      "--mount",
      `type=bind,src=${temporaryParent},dst=/output`,
      "--entrypoint",
      "/usr/local/bin/node",
    ],
    deadline,
    image: base,
    invoke: run,
    namePrefix: "agent-context-h13-offline",
    operation: (identity) => startContainer(identity, "offline assembly", 600_000),
    validateContainer: preparationValidator({
      command: [
        "/input/tools/standards/container/prepare-runtime-inside.mjs",
        "/output/prepared",
        "/network-input",
      ],
      entrypoint: "/usr/local/bin/node",
      mounts: [
        { destination: "/input", readOnly: true, source: sourceSnapshot, type: "bind" },
        { destination: "/network-input", readOnly: true, source: networkOutput, type: "bind" },
        { destination: "/output", readOnly: false, source: temporaryParent, type: "bind" },
      ],
      networkMode: "none",
    }),
  });

  const manifestBytes = await readFile(path.join(prepared, "input-manifest.v1.json"));
  const expected = (await import("node:crypto"))
    .createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  await verifyInputDirectory(prepared, expected, networkLockfileBytes, buildLock.packageManager, {
    preparationSourceManifestSha256: preparationSource.manifestSha256,
  });
  try {
    const state = await lstat(destination);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error("unsafe runtime input destination");
    await rm(destination, { force: true, recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await chmod(prepared, 0o700);
  await rename(prepared, destination);
  process.stdout.write(`Prepared H13 runtime inputs ${expected}.\n`);
} finally {
  await rm(temporaryParent, { force: true, recursive: true });
}
