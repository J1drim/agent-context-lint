import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export const PREPARATION_OWNER_LABEL = "agent-context.h13.preparation";
export const PREPARATION_NONCE_LABEL = "agent-context.h13.preparation-nonce";
export const PREPARATION_OWNER = "agent-context-linter";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function assertExactPreparationConfinement(actual, expected) {
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error("runtime preparation container differs from its confinement policy");
}

export const PREPARATION_CONFIG_KEYS = Object.freeze(
  [
    "ArgsEscaped",
    "AttachStderr",
    "AttachStdin",
    "AttachStdout",
    "Cmd",
    "Domainname",
    "Entrypoint",
    "Env",
    "ExposedPorts",
    "Healthcheck",
    "Hostname",
    "Image",
    "Labels",
    "MacAddress",
    "NetworkDisabled",
    "OnBuild",
    "OpenStdin",
    "Shell",
    "StdinOnce",
    "StopSignal",
    "StopTimeout",
    "Tty",
    "User",
    "Volumes",
    "WorkingDir",
  ].sort(),
);

export const PREPARATION_HOST_CONFIG_KEYS = Object.freeze(
  [
    "Annotations",
    "AutoRemove",
    "Binds",
    "BlkioDeviceReadBps",
    "BlkioDeviceReadIOps",
    "BlkioDeviceWriteBps",
    "BlkioDeviceWriteIOps",
    "BlkioWeight",
    "BlkioWeightDevice",
    "CapAdd",
    "CapDrop",
    "Cgroup",
    "CgroupParent",
    "CgroupnsMode",
    "ConsoleSize",
    "ContainerIDFile",
    "CpuCount",
    "CpuPercent",
    "CpuPeriod",
    "CpuQuota",
    "CpuRealtimePeriod",
    "CpuRealtimeRuntime",
    "CpuShares",
    "CpusetCpus",
    "CpusetMems",
    "DeviceCgroupRules",
    "DeviceRequests",
    "Devices",
    "Dns",
    "DnsOptions",
    "DnsSearch",
    "ExtraHosts",
    "GroupAdd",
    "IOMaximumBandwidth",
    "IOMaximumIOps",
    "Init",
    "IpcMode",
    "Isolation",
    "Links",
    "LogConfig",
    "MaskedPaths",
    "Memory",
    "MemoryReservation",
    "MemorySwap",
    "MemorySwappiness",
    "Mounts",
    "NanoCpus",
    "NetworkMode",
    "OomKillDisable",
    "OomScoreAdj",
    "PidMode",
    "PidsLimit",
    "PortBindings",
    "Privileged",
    "PublishAllPorts",
    "ReadonlyPaths",
    "ReadonlyRootfs",
    "RestartPolicy",
    "Runtime",
    "SecurityOpt",
    "ShmSize",
    "StorageOpt",
    "Sysctls",
    "Tmpfs",
    "UTSMode",
    "Ulimits",
    "UsernsMode",
    "VolumeDriver",
    "VolumesFrom",
  ].sort(),
);

export const PREPARATION_FORBIDDEN_HOST_CONFIG_KEYS = Object.freeze([
  "KernelMemory",
  "KernelMemoryTCP",
]);

function assertExactRawKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== expected.join("\0")
  )
    throw new Error(`runtime preparation ${label} keys differ from Docker 29.5.2 contract`);
}

export function normalizePreparationConfinement(container) {
  assertExactRawKeys(container.Config, PREPARATION_CONFIG_KEYS, "Config");
  assertExactRawKeys(container.HostConfig, PREPARATION_HOST_CONFIG_KEYS, "HostConfig");
  return {
    config: structuredClone(container.Config),
    hostConfig: structuredClone(container.HostConfig),
    mounts: (container.Mounts ?? [])
      .map((mount) => ({
        destination: mount.Destination,
        readOnly: mount.RW === false,
        source: mount.Source,
        type: mount.Type,
      }))
      .toSorted((left, right) =>
        Buffer.compare(Buffer.from(left.destination), Buffer.from(right.destination)),
      ),
    state: { pid: container.State?.Pid, running: container.State?.Running },
  };
}

function remaining(deadline, phase) {
  const value = deadline - performance.now();
  if (value < 1) throw new Error(`runtime preparation deadline expired during ${phase}`);
  return value;
}

function successful(result, phase) {
  if (result.code !== 0 || result.signal !== null || result.timedOut)
    throw new Error(`runtime preparation failed during ${phase}`);
}

async function listOwned(invoke, name, nonce, deadline) {
  const result = await invoke(
    [
      "container",
      "list",
      "--all",
      "--filter",
      `label=${PREPARATION_OWNER_LABEL}=${PREPARATION_OWNER}`,
      "--filter",
      `label=${PREPARATION_NONCE_LABEL}=${nonce}`,
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.ID}}",
    ],
    { capture: true, timeoutMs: Math.min(5_000, remaining(deadline, "reconciliation")) },
  );
  successful(result, "container reconciliation");
  const identities = result.stdout.trim() === "" ? [] : result.stdout.trim().split(/\r?\n/u);
  if (identities.length > 1 || identities.some((identity) => !/^[0-9a-f]{12,64}$/u.test(identity)))
    throw new Error("runtime preparation received ambiguous container identities");
  return identities;
}

async function reconcile(invoke, name, nonce, deadline) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const identities = await listOwned(invoke, name, nonce, deadline);
    if (identities.length === 1) return identities[0];
    if (attempt < 19) await delay(Math.min(250, remaining(deadline, "scheduling margin")));
  }
  return undefined;
}

async function inspectOwned(invoke, identity, name, nonce, image, deadline) {
  const result = await invoke(["container", "inspect", identity, "--format", "{{json .}}"], {
    capture: true,
    timeoutMs: Math.min(5_000, remaining(deadline, "inspection")),
  });
  successful(result, "container inspection");
  let container;
  try {
    container = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("runtime preparation received malformed container inspection", {
      cause: error,
    });
  }
  if (
    !/^[0-9a-f]{64}$/u.test(container?.Id) ||
    (container.Id !== identity && !container.Id.startsWith(identity)) ||
    container.Name !== `/${name}` ||
    container.Config?.Image !== image ||
    container.Config?.Labels?.[PREPARATION_OWNER_LABEL] !== PREPARATION_OWNER ||
    container.Config?.Labels?.[PREPARATION_NONCE_LABEL] !== nonce ||
    Object.keys(container.Config?.Labels ?? {})
      .sort()
      .join(",") !== [PREPARATION_NONCE_LABEL, PREPARATION_OWNER_LABEL].sort().join(",")
  )
    throw new Error("runtime preparation refuses an unowned container identity");
  return container;
}

async function removeOwned(invoke, container, name, nonce, image, deadline) {
  await inspectOwned(invoke, container.Id, name, nonce, image, deadline);
  const removed = await invoke(["container", "rm", "--force", "--volumes", container.Id], {
    capture: true,
    timeoutMs: Math.min(10_000, remaining(deadline, "forced removal")),
  });
  successful(removed, "forced container removal");
  if ((await listOwned(invoke, name, nonce, deadline)).length !== 0)
    throw new Error("runtime preparation left a residual container");
}

export async function withPreparationContainer({
  createArguments,
  commandArguments = [],
  deadline,
  image,
  invoke,
  namePrefix,
  nonce = randomBytes(16).toString("hex"),
  operation,
  validateContainer = () => {},
}) {
  if (!/^[0-9a-f]{32}$/u.test(nonce) || !/^agent-context-h13-[a-z]+$/u.test(namePrefix))
    throw new Error("runtime preparation container identity input is invalid");
  const name = `${namePrefix}-${process.pid}-${nonce}`;
  const available = await invoke(
    ["container", "list", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
    { capture: true, timeoutMs: Math.min(5_000, remaining(deadline, "name preflight")) },
  );
  successful(available, "container name preflight");
  if (available.stdout.trim() !== "")
    throw new Error("runtime preparation container name is unavailable");

  let container;
  let primaryError;
  let result;
  try {
    let created;
    try {
      created = await invoke(
        [
          "container",
          "create",
          "--name",
          name,
          "--label",
          `${PREPARATION_OWNER_LABEL}=${PREPARATION_OWNER}`,
          "--label",
          `${PREPARATION_NONCE_LABEL}=${nonce}`,
          ...createArguments,
          image,
          ...commandArguments,
        ],
        { capture: true, timeoutMs: Math.min(10_000, remaining(deadline, "creation")) },
      );
    } catch (error) {
      primaryError = error;
    }
    const identity = await reconcile(invoke, name, nonce, deadline);
    if (identity !== undefined)
      container = await inspectOwned(invoke, identity, name, nonce, image, deadline);
    if (container !== undefined) validateContainer(container, { image, name, nonce });
    if (primaryError !== undefined) throw primaryError;
    if (
      created.code !== 0 ||
      created.signal !== null ||
      created.timedOut ||
      !/^[0-9a-f]{64}$/u.test(created.stdout.trim()) ||
      container === undefined ||
      created.stdout.trim() !== container.Id
    )
      throw new Error("runtime preparation could not establish the created container identity");
    result = await operation(container.Id, deadline);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  if (container !== undefined) {
    try {
      await removeOwned(invoke, container, name, nonce, image, deadline);
    } catch (error) {
      cleanupError = error;
    }
  } else {
    try {
      const identity = await reconcile(invoke, name, nonce, deadline);
      if (identity !== undefined) {
        const recovered = await inspectOwned(invoke, identity, name, nonce, image, deadline);
        await removeOwned(invoke, recovered, name, nonce, image, deadline);
      }
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== undefined && cleanupError !== undefined)
    throw new AggregateError(
      [primaryError, cleanupError],
      "runtime preparation and cleanup failed",
      {
        cause: primaryError,
      },
    );
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}
