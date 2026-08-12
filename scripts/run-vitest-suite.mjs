import { spawn } from "node:child_process";
import { constants as fileSystemConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestExecutable = path.join(rootDirectory, "node_modules", "vitest", "vitest.mjs");
const MAXIMUM_AVAILABLE_PARALLELISM = 1_024;
export const LANE_TIMEOUT_MS = 10 * 60 * 1_000;
export const TERMINATION_GRACE_MS = 1_000;
export const MAXIMUM_SIZE_TEST_TIMEOUT_MS = 15_000;
const CLEANUP_POLL_MS = 10;
const HELPER_KILL_RESERVE_MS = 50;
const POSIX_OBSERVER_INTERVAL_MS = 100;
const POSIX_SNAPSHOT_MAXIMUM_BYTES = 4 * 1024 * 1024;
const POSIX_SNAPSHOT_TIMEOUT_MS = 2_000;
const LINUX_PROCESS_STAT_MAXIMUM_BYTES = 16 * 1024;
const LINUX_NO_FOLLOW_FLAG = Number.isSafeInteger(fileSystemConstants.O_NOFOLLOW)
  ? fileSystemConstants.O_NOFOLLOW
  : 0;
const LINUX_PROCESS_DIRECTORY_MAXIMUM_ENTRIES = 131_072;
const LINUX_PROCESS_SNAPSHOT_MAXIMUM_PIDS = 32_768;
const PROCESS_LANE_HOST_SOURCE = String.raw`
const { spawn } = require("node:child_process");
let accepted = false;
let reported = false;
process.on("message", (request) => {
  if (accepted || request === null || typeof request !== "object" || request.kind !== "start" ||
      typeof request.executable !== "string" || !Array.isArray(request.arguments)) process.exit(125);
  accepted = true;
  let child;
  const report = (result) => {
    if (reported) return;
    reported = true;
    process.send?.({ kind: "lane-result", ...result });
  };
  try {
    child = spawn(request.executable, request.arguments, {
      cwd: process.cwd(), env: process.env, shell: false,
      stdio: request.ignoreOutput ? "ignore" : "inherit", windowsHide: true
    });
  } catch {
    report({ spawnFailed: true, status: null, signal: null });
    return;
  }
  child.once("error", () => report({ spawnFailed: true, status: null, signal: null }));
  child.once("close", (status, signal) => report({ spawnFailed: false, status, signal }));
});
process.on("disconnect", () => process.exit(125));
setInterval(() => {}, 60_000);
`;
const PROCESS_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const laneHostSource = ${JSON.stringify(PROCESS_LANE_HOST_SOURCE)};
let accepted = false;
let reported = false;
process.on("SIGTERM", () => {});
const report = (result) => {
  if (reported) return;
  reported = true;
  process.send?.({ kind: "lane-result", ...result });
};
process.on("message", (request) => {
  if (request === null || typeof request !== "object") process.exit(125);
  if (request.kind === "cleanup-kill" && accepted && process.platform !== "win32") {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.send?.({ kind: "cleanup-error" });
    }
    return;
  }
  if (accepted || request.kind !== "start" || typeof request.executable !== "string" ||
      !Array.isArray(request.arguments)) process.exit(125);
  accepted = true;
  let host;
  try {
    host = spawn(process.execPath, ["--eval", laneHostSource], {
      cwd: process.cwd(), env: process.env, shell: false,
      stdio: ["ignore", request.ignoreOutput ? "ignore" : "inherit",
              request.ignoreOutput ? "ignore" : "inherit", "ipc"], windowsHide: true
    });
    host.send(request);
  } catch {
    report({ spawnFailed: true, status: null, signal: null });
    return;
  }
  host.once("error", () => report({ spawnFailed: true, status: null, signal: null }));
  host.once("message", (message) => {
    if (message?.kind !== "lane-result") {
      report({ spawnFailed: true, status: null, signal: null });
      return;
    }
    report(message);
  });
  host.once("close", () => {
    if (!reported)
      report({ spawnFailed: false, status: null, supervisionLost: true, signal: null });
  });
});
process.on("disconnect", () => process.exit(125));
setInterval(() => {}, 60_000);
`;
const NativeAggregateError = AggregateError;
const NativeError = Error;
const MAXIMUM_CLEANUP_ERROR_GRAPH_DEPTH = 32;
const MAXIMUM_CLEANUP_ERROR_GRAPH_NODES = 256;
const MAXIMUM_REGULAR_CLEANUP_UNCERTAINTIES = 239;
const MAXIMUM_PRESERVED_CLEANUP_UNCERTAINTIES = 15;

export const MAXIMUM_SIZE_TEST_FILES = Object.freeze([
  "packages/cli/test/i03-commands.unit.test.ts",
  "packages/cli/test/scan-command.unit.test.ts",
  "packages/formatters/test/sarif.unit.test.ts",
  "packages/formatters/test/stylish.unit.test.ts",
  "packages/resolver/test/target-sampler.unit.test.ts",
  "packages/rules/test/rule-scheduler.unit.test.ts",
  "packages/rules/test/syntax-structure.unit.test.ts",
  "packages/standards/test/standards-cache.unit.test.ts",
]);

const LIGHT_LANE_SENTINEL = "packages/core/test/repository-path.unit.test.ts";
const FORWARD_SIGNALS = Object.freeze(["SIGINT", "SIGTERM"]);

export function selectVitestWorkerCount(observedAvailableParallelism) {
  if (
    !Number.isSafeInteger(observedAvailableParallelism) ||
    observedAvailableParallelism < 1 ||
    observedAvailableParallelism > MAXIMUM_AVAILABLE_PARALLELISM
  ) {
    throw new TypeError("available parallelism must be a bounded positive safe integer");
  }
  if (observedAvailableParallelism === 1) return 1;
  return Math.min(4, Math.max(2, Math.floor(observedAvailableParallelism / 2)));
}

function reportArguments(outputFile) {
  if (outputFile === undefined) return [];
  if (typeof outputFile !== "string" || !path.isAbsolute(outputFile)) {
    throw new TypeError("Vitest report paths must be absolute");
  }
  return ["--no-color", "--reporter=json", `--outputFile=${outputFile}`];
}

export function createVitestLanePlan({
  available = availableParallelism(),
  mode = "parallel",
  outputFiles,
} = {}) {
  if (mode !== "parallel" && mode !== "serial") {
    throw new TypeError("Vitest lane mode must be parallel or serial");
  }
  if (
    outputFiles !== undefined &&
    (!Array.isArray(outputFiles) || outputFiles.length !== 2 || outputFiles[0] === outputFiles[1])
  ) {
    throw new TypeError("Vitest lane reports require two distinct paths");
  }
  const lightConcurrency =
    mode === "serial"
      ? ["--no-file-parallelism", "--maxWorkers=1"]
      : ["--fileParallelism", `--maxWorkers=${String(selectVitestWorkerCount(available))}`];
  const exclusions = MAXIMUM_SIZE_TEST_FILES.flatMap((file) => ["--exclude", file]);
  return Object.freeze([
    Object.freeze({
      arguments: Object.freeze([
        "run",
        ...lightConcurrency,
        ...exclusions,
        ...reportArguments(outputFiles?.[0]),
      ]),
      name: "resource-aware",
    }),
    Object.freeze({
      arguments: Object.freeze([
        "run",
        ...MAXIMUM_SIZE_TEST_FILES,
        "--no-file-parallelism",
        "--maxWorkers=1",
        `--testTimeout=${String(MAXIMUM_SIZE_TEST_TIMEOUT_MS)}`,
        ...reportArguments(outputFiles?.[1]),
      ]),
      name: "maximum-size-sequential",
    }),
  ]);
}

async function requireOrdinaryContainedFile(relativePath) {
  const absolute = path.join(rootDirectory, relativePath);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (await realpath(absolute)) !== absolute) {
    throw new TypeError(`Vitest lane path is not an ordinary repository file: ${relativePath}`);
  }
}

async function requireInstalledVitest() {
  const metadata = await lstat(vitestExecutable);
  const resolved = await realpath(vitestExecutable);
  const dependencyRoot = path.join(rootDirectory, "node_modules", ".pnpm");
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !resolved.startsWith(`${dependencyRoot}${path.sep}`) ||
    !resolved.endsWith(`${path.sep}node_modules${path.sep}vitest${path.sep}vitest.mjs`)
  ) {
    throw new TypeError("Vitest executable is not the installed pinned dependency");
  }
}

export async function validateVitestLaneInputs() {
  await requireInstalledVitest();
  await requireOrdinaryContainedFile(LIGHT_LANE_SENTINEL);
  for (const file of MAXIMUM_SIZE_TEST_FILES) await requireOrdinaryContainedFile(file);
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function safeOwnErrorCode(error) {
  try {
    if (utilTypes.isProxy(error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function processGroupExists(pid, platform, killProcess) {
  if (platform === "win32") return true;
  try {
    killProcess(-pid, 0);
    return true;
  } catch (error) {
    const code = safeOwnErrorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForGroupExit(pid, platform, killProcess, maximumDurationMs, now) {
  if (platform === "win32") return false;
  const deadline = now() + maximumDurationMs;
  do {
    if (!processGroupExists(pid, platform, killProcess)) return true;
    await delay(Math.min(CLEANUP_POLL_MS, Math.max(1, Math.ceil(deadline - now()))));
  } while (now() < deadline);
  return !processGroupExists(pid, platform, killProcess);
}

function signalGroup(pid, signal, platform, killProcess) {
  if (platform === "win32") return false;
  try {
    killProcess(-pid, signal);
    return true;
  } catch (error) {
    if (safeOwnErrorCode(error) === "ESRCH") return false;
    throw error;
  }
}

function requestOwnedGroupKill(supervisor) {
  return new Promise((resolve, reject) => {
    if (supervisor.connected !== true) {
      reject(new Error("POSIX supervisor cleanup channel is not connected"));
      return;
    }
    supervisor.send({ kind: "cleanup-kill" }, (error) => {
      if (error === null || error === undefined) resolve(true);
      else reject(error);
    });
  });
}

function parsePosixProcessSnapshot(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match === null) throw new Error("POSIX process observer returned malformed output");
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const processGroupId = Number(match[3]);
    if (![pid, parentPid, processGroupId].every((value) => Number.isSafeInteger(value))) {
      throw new Error("POSIX process observer returned an invalid identity");
    }
    rows.push(
      Object.freeze({
        identity: `${match[1]}:${match[4]}`,
        parentPid,
        pid,
        processGroupId,
      }),
    );
  }
  return Object.freeze(rows);
}

export function parseLinuxProcessStatForTest(text, expectedPid) {
  if (
    typeof text !== "string" ||
    !Number.isSafeInteger(expectedPid) ||
    expectedPid < 1 ||
    text.length > LINUX_PROCESS_STAT_MAXIMUM_BYTES ||
    text.includes("\0")
  ) {
    throw new Error("Linux process observer returned an invalid stat record");
  }
  const match = /^(\d+) \((.*)\) ([A-Za-z]) ([^\n]+)\n?$/u.exec(text);
  if (match === null || Number(match[1]) !== expectedPid) {
    throw new Error("Linux process observer returned a mismatched stat identity");
  }
  const fields = match[4].split(" ");
  const parentPid = Number(fields[0]);
  const processGroupId = Number(fields[1]);
  const sessionId = Number(fields[2]);
  const startTicks = fields[18];
  const requiredIdentifiers = [fields[0], fields[1], fields[2], startTicks];
  if (
    fields.length < 19 ||
    fields.length > 128 ||
    !requiredIdentifiers.every((value) => /^(?:0|[1-9]\d*)$/u.test(value)) ||
    ![parentPid, processGroupId, sessionId].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !/^(?:0|[1-9]\d*)$/u.test(startTicks)
  ) {
    throw new Error("Linux process observer returned malformed stat fields");
  }
  // A host PID namespace can expose kernel workers to a GitHub-hosted runner. Linux reports both
  // their process-group and session identifiers as zero; they cannot be descendants of the
  // positive-PID userspace lane and have no signalable process group. Omit only that exact kernel
  // shape. A partially zero identity remains observer uncertainty and fails closed.
  if (processGroupId === 0 && sessionId === 0) return undefined;
  if (processGroupId < 1 || sessionId < 1) {
    throw new Error("Linux process observer returned malformed stat fields");
  }
  return Object.freeze({
    identity: `${String(expectedPid)}:linux-proc-start:${startTicks}`,
    parentPid,
    pid: expectedPid,
    preciseIdentity: `linux-proc-start:${startTicks}`,
    processGroupId,
    sessionId,
  });
}

async function readLinuxProcessStat(pid, openFile = open) {
  let handle;
  try {
    handle = await openFile(
      `/proc/${String(pid)}/stat`,
      fileSystemConstants.O_RDONLY | LINUX_NO_FOLLOW_FLAG,
    );
  } catch (error) {
    const code = safeOwnErrorCode(error);
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Linux process stat is not an ordinary file");
    const buffer = Buffer.alloc(LINUX_PROCESS_STAT_MAXIMUM_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > LINUX_PROCESS_STAT_MAXIMUM_BYTES) {
      throw new Error("Linux process stat exceeded its output limit");
    }
    return parseLinuxProcessStatForTest(buffer.subarray(0, offset).toString("utf8"), pid);
  } catch (error) {
    const code = safeOwnErrorCode(error);
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  } finally {
    await handle.close();
  }
}

/** @internal Linux no-follow stat-reader seam for hostile file tests. */
export function readLinuxProcessStatForTest(pid, openFile) {
  return readLinuxProcessStat(pid, openFile);
}

async function readPortablePosixProcessSnapshot() {
  const observer = spawn("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    env: { LC_ALL: "C" },
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  observer.stdout.on("data", (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > POSIX_SNAPSHOT_MAXIMUM_BYTES) {
      overflow = true;
      observer.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
  });
  const result = await new Promise((resolve) => {
    let settled = false;
    let forced = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
      resolve(value);
    };
    const forceTimer = setTimeout(() => {
      forced = true;
      observer.kill("SIGKILL");
    }, POSIX_SNAPSHOT_TIMEOUT_MS - HELPER_KILL_RESERVE_MS);
    const deadlineTimer = setTimeout(() => {
      observer.kill("SIGKILL");
      finish({
        error: new Error("POSIX process observer did not close within its deadline"),
        status: null,
      });
    }, POSIX_SNAPSHOT_TIMEOUT_MS);
    observer.once("error", (error) => finish({ error, status: null }));
    observer.once("close", (status) =>
      finish({
        error: forced ? new Error("POSIX process observer required forced cleanup") : undefined,
        status,
      }),
    );
  });
  if (overflow) throw new Error("POSIX process observer exceeded its output limit");
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("POSIX process observer failed closed", { cause: result.error });
  }
  return parsePosixProcessSnapshot(Buffer.concat(chunks).toString("utf8"));
}

async function readLinuxProcessSnapshot({
  openDirectory = opendir,
  readProcessStat = readLinuxProcessStat,
} = {}) {
  const directory = await openDirectory("/proc");
  const pids = [];
  let entries = 0;
  for await (const entry of directory) {
    entries += 1;
    if (entries > LINUX_PROCESS_DIRECTORY_MAXIMUM_ENTRIES) {
      throw new Error("Linux process directory exceeded its entry limit");
    }
    if (!/^[1-9]\d*$/u.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error("Linux numeric process entry is not a directory");
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid))
      throw new Error("Linux process directory contains an invalid PID");
    pids.push(pid);
    if (pids.length > LINUX_PROCESS_SNAPSHOT_MAXIMUM_PIDS) {
      throw new Error("Linux process snapshot exceeded its PID limit");
    }
  }
  pids.sort((left, right) => left - right);
  for (let index = 1; index < pids.length; index += 1) {
    if (pids[index] === pids[index - 1]) {
      throw new Error("Linux process directory contains a duplicate PID");
    }
  }
  const rows = [];
  for (const pid of pids) {
    const row = await readProcessStat(pid);
    // A process may vanish after the numeric directory entry is enumerated. Every other read or
    // parse failure is observer uncertainty and propagates fail-closed.
    if (row !== undefined) rows.push(row);
  }
  return Object.freeze(rows);
}

/** @internal Linux single-source process snapshot seam for hostile enumeration tests. */
export function readLinuxProcessSnapshotForTest(options) {
  return readLinuxProcessSnapshot(options);
}

async function readPosixProcessSnapshot() {
  return process.platform === "linux"
    ? readLinuxProcessSnapshot()
    : readPortablePosixProcessSnapshot();
}

function createPosixLineageObserver(rootPid, snapshotProcesses) {
  const tracked = new Map();
  const precise = new Map();
  const escaped = new Map();
  let latest = Object.freeze([]);
  let stopping = false;
  let failure;
  let reportFailure;
  const failurePromise = new Promise((resolve) => {
    reportFailure = resolve;
  });

  const observe = (rows) => {
    latest = rows;
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const root = byPid.get(rootPid);
    if (root !== undefined) {
      const known = tracked.get(rootPid);
      if (known !== undefined && known !== root.identity)
        throw new Error("POSIX lane root PID identity changed");
      tracked.set(rootPid, root.identity);
      if (root.preciseIdentity !== undefined) {
        const knownPrecise = precise.get(rootPid);
        if (knownPrecise !== undefined && knownPrecise !== root.preciseIdentity)
          throw new Error("POSIX lane root precise identity changed");
        precise.set(rootPid, root.preciseIdentity);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const parentIdentity = tracked.get(row.parentPid);
        if (parentIdentity === undefined || tracked.has(row.pid)) continue;
        const parent = byPid.get(row.parentPid);
        if (parent === undefined || parent.identity !== parentIdentity) continue;
        tracked.set(row.pid, row.identity);
        if (row.preciseIdentity !== undefined) precise.set(row.pid, row.preciseIdentity);
        changed = true;
      }
    }
    for (const [pid, identity] of tracked) {
      const row = byPid.get(pid);
      if (row !== undefined && row.identity !== identity)
        throw new Error("POSIX descendant PID identity changed");
      if (
        row?.preciseIdentity !== undefined &&
        precise.has(pid) &&
        precise.get(pid) !== row.preciseIdentity
      )
        throw new Error("POSIX descendant precise identity changed");
      if (row?.preciseIdentity !== undefined && !precise.has(pid))
        precise.set(pid, row.preciseIdentity);
      if (row !== undefined && pid !== rootPid && row.processGroupId !== rootPid)
        escaped.set(pid, identity);
    }
  };

  const running = (async () => {
    try {
      while (!stopping) {
        observe(await snapshotProcesses([rootPid, ...tracked.keys()]));
        await delay(POSIX_OBSERVER_INTERVAL_MS);
      }
    } catch (error) {
      failure = error;
      reportFailure({ kind: "observer-failed" });
    }
  })();

  return Object.freeze({
    failurePromise,
    async stop() {
      stopping = true;
      await running;
      if (failure === undefined) {
        try {
          observe(await snapshotProcesses([rootPid, ...tracked.keys()]));
        } catch (error) {
          failure = error;
        }
      }
      return Object.freeze({
        error: failure,
        escaped: Object.freeze(new Map(escaped)),
        latest,
        precise: Object.freeze(new Map(precise)),
        tracked: Object.freeze(new Map(tracked)),
      });
    },
  });
}

async function runWindowsTaskkill(pid, spawnProcess, timeoutMs, executable, now) {
  const killer = spawnProcess(executable, ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  return new Promise((resolve) => {
    let settled = false;
    let forced = false;
    const started = now();
    const deadline = started + timeoutMs;
    const forceAt = Math.max(
      started + 1,
      deadline - Math.min(HELPER_KILL_RESERVE_MS, Math.max(1, timeoutMs / 4)),
    );
    const force = () => {
      const remaining = forceAt - now();
      if (remaining > 0) {
        forceTimer = setTimeout(force, Math.ceil(remaining));
        return;
      }
      forced = true;
      killer.kill("SIGKILL");
    };
    const expire = () => {
      const remaining = deadline - now();
      if (remaining > 0) {
        deadlineTimer = setTimeout(expire, Math.ceil(remaining));
        return;
      }
      killer.kill("SIGKILL");
      finish({
        error: new Error("Windows taskkill did not close within its cleanup deadline"),
        status: null,
      });
    };
    let forceTimer = setTimeout(force, Math.max(1, Math.ceil(forceAt - started)));
    let deadlineTimer = setTimeout(expire, timeoutMs);
    const clearTimers = () => {
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    killer.once("error", (error) => finish({ error, status: null }));
    killer.once("close", (status) =>
      finish({
        error: forced ? new Error("Windows taskkill required forced helper cleanup") : undefined,
        status,
      }),
    );
  });
}

async function terminateProcessTree(
  pid,
  {
    killProcess,
    leaderIsClosed,
    now,
    platform,
    posixObservation,
    revalidateProcess,
    snapshotProcesses,
    spawnProcess,
    supervisor,
    terminationGraceMs,
    windowsTaskkillExecutable,
  },
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  if (platform === "win32") {
    if (leaderIsClosed()) {
      throw new Error("Windows lane supervisor exited before process-tree cleanup");
    }
    const result = await runWindowsTaskkill(
      pid,
      spawnProcess,
      terminationGraceMs,
      windowsTaskkillExecutable,
      now,
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new Error("Windows taskkill did not confirm process-tree termination", {
        cause: result.error,
      });
    }
    return;
  }
  // Observer failure is reported by runManagedCommand. Track every distinct cleanup
  // uncertainty independently so later teardown evidence cannot be masked.
  const regularUncertainties = [];
  const preservedUncertainties = [];
  let uncertaintiesTruncated = false;
  const recordUncertainty = (error, preserve = false) => {
    if (regularUncertainties.includes(error) || preservedUncertainties.includes(error)) return;
    const target = preserve ? preservedUncertainties : regularUncertainties;
    const maximum = preserve
      ? MAXIMUM_PRESERVED_CLEANUP_UNCERTAINTIES
      : MAXIMUM_REGULAR_CLEANUP_UNCERTAINTIES;
    if (target.length < maximum) target.push(error);
    else uncertaintiesTruncated = true;
  };
  const byPid = new Map(posixObservation.latest.map((row) => [row.pid, row]));
  const escapedAtCleanup = [...posixObservation.escaped].some(
    ([escapedPid, identity]) => byPid.get(escapedPid)?.identity === identity,
  );
  const leaderIdentity = posixObservation.tracked.get(pid);
  const leaderPreciseIdentity = posixObservation.precise.get(pid);
  const groupIsCurrent = async (rows) => {
    const currentLeader = rows.find((row) => row.pid === pid);
    if (
      currentLeader !== undefined &&
      !leaderIsClosed() &&
      leaderIdentity === currentLeader.identity &&
      (leaderPreciseIdentity === undefined ||
        leaderPreciseIdentity === currentLeader.preciseIdentity)
    ) {
      if (platform !== "linux") return true;
      if (leaderPreciseIdentity === undefined) return false;
      const revalidated = await revalidateProcess(pid);
      return (
        revalidated !== undefined &&
        revalidated.pid === pid &&
        revalidated.preciseIdentity === leaderPreciseIdentity &&
        revalidated.processGroupId === pid &&
        revalidated.sessionId === pid
      );
    }
    return false;
  };

  const signalCurrentGroup = async (rows, signal) => {
    let exists;
    try {
      exists = processGroupExists(pid, platform, killProcess);
    } catch (error) {
      recordUncertainty(error);
      return false;
    }
    if (!exists) {
      recordUncertainty(new Error("POSIX supervisor process group disappeared before cleanup"));
      return false;
    }
    let current;
    try {
      current = await groupIsCurrent(rows);
    } catch (error) {
      recordUncertainty(error);
      return false;
    }
    if (!current) {
      recordUncertainty(
        new Error("POSIX supervisor identity could not be proven immediately before cleanup"),
      );
      return false;
    }
    try {
      return signalGroup(pid, signal, platform, killProcess);
    } catch (error) {
      recordUncertainty(error);
      return false;
    }
  };

  const signalEscaped = async (rows, signal) => {
    for (const [escapedPid, identity] of posixObservation.escaped) {
      const row = rows.find((candidate) => candidate.pid === escapedPid);
      if (row === undefined) continue;
      if (row.identity !== identity) {
        recordUncertainty(new Error("escaped descendant PID identity changed before cleanup"));
        continue;
      }
      const preciseIdentity = posixObservation.precise.get(escapedPid);
      if (preciseIdentity === undefined || row.preciseIdentity !== preciseIdentity) {
        recordUncertainty(
          new Error("escaped descendant precise identity could not be proven current"),
        );
        continue;
      }
      let revalidated;
      try {
        revalidated = await revalidateProcess(escapedPid);
      } catch (error) {
        recordUncertainty(error);
        continue;
      }
      if (
        revalidated === undefined ||
        revalidated.preciseIdentity !== preciseIdentity ||
        revalidated.pid !== escapedPid
      ) {
        recordUncertainty(
          new Error("escaped descendant identity changed immediately before cleanup"),
        );
        continue;
      }
      try {
        killProcess(escapedPid, signal);
      } catch (error) {
        if (safeOwnErrorCode(error) !== "ESRCH") recordUncertainty(error);
      }
    }
  };

  await signalEscaped(posixObservation.latest, "SIGTERM");
  const termSignalled = await signalCurrentGroup(posixObservation.latest, "SIGTERM");
  let groupExited = false;
  if (termSignalled) {
    try {
      groupExited = await waitForGroupExit(pid, platform, killProcess, terminationGraceMs, now);
    } catch (error) {
      recordUncertainty(error);
    }
  }
  if (groupExited && leaderIsClosed())
    recordUncertainty(new Error("POSIX supervisor exited before cleanup completed"));
  let refreshed;
  try {
    refreshed = await snapshotProcesses([
      pid,
      ...posixObservation.tracked.keys(),
      ...posixObservation.escaped.keys(),
    ]);
  } catch (error) {
    recordUncertainty(error);
    refreshed = Object.freeze([]);
  }
  await signalEscaped(refreshed, "SIGKILL");
  if (!groupExited) {
    if (leaderIsClosed()) {
      recordUncertainty(new Error("POSIX supervisor exited before owned-group cleanup"));
    } else {
      if (platform === "linux" && leaderPreciseIdentity !== undefined) {
        try {
          const revalidated = await revalidateProcess(pid);
          if (
            revalidated === undefined ||
            revalidated.pid !== pid ||
            revalidated.preciseIdentity !== leaderPreciseIdentity ||
            revalidated.processGroupId !== pid ||
            revalidated.sessionId !== pid
          ) {
            recordUncertainty(
              new Error("POSIX supervisor identity changed before owned-group cleanup"),
            );
          }
        } catch (error) {
          recordUncertainty(error, true);
        }
      }
      try {
        await requestOwnedGroupKill(supervisor);
      } catch (error) {
        recordUncertainty(error, true);
      }
      let ownedGroupExited = false;
      try {
        ownedGroupExited = await waitForGroupExit(
          pid,
          platform,
          killProcess,
          terminationGraceMs,
          now,
        );
      } catch (error) {
        recordUncertainty(error, true);
      }
      if (!ownedGroupExited)
        recordUncertainty(
          new Error("Vitest process group did not terminate after owned-group SIGKILL"),
          true,
        );
    }
  }
  let finalRows;
  try {
    finalRows = await snapshotProcesses([
      pid,
      ...posixObservation.tracked.keys(),
      ...posixObservation.escaped.keys(),
    ]);
  } catch (error) {
    recordUncertainty(error, true);
    finalRows = Object.freeze([]);
  }
  let escapedSurvivors = 0;
  for (const [escapedPid, identity] of posixObservation.escaped) {
    const row = finalRows.find((candidate) => candidate.pid === escapedPid);
    if (row !== undefined && row.identity === identity) escapedSurvivors += 1;
  }
  if (escapedSurvivors > 0)
    recordUncertainty(new Error("escaped POSIX descendants survived cleanup"), true);
  if (escapedAtCleanup)
    recordUncertainty(new Error("POSIX descendant escaped its assigned process group"), true);
  const uncertainties = [
    ...regularUncertainties,
    ...(uncertaintiesTruncated
      ? [new NativeError("POSIX cleanup uncertainty limit was exceeded")]
      : []),
    ...preservedUncertainties,
  ];
  if (uncertainties.length === 1) throw uncertainties[0];
  if (uncertainties.length > 1) {
    throw new NativeAggregateError(
      uncertainties,
      safeErrorMessage(uncertainties[0], "POSIX process-tree cleanup failed closed"),
    );
  }
}

function deadlineRace(deadline, now) {
  let timer;
  const promise = new Promise((resolve) => {
    const check = () => {
      const remaining = deadline - now();
      if (remaining <= 0) {
        resolve({ kind: "deadline" });
        return;
      }
      timer = setTimeout(check, Math.max(1, Math.ceil(remaining)));
    };
    check();
  });
  return { cancel: () => clearTimeout(timer), promise };
}

function cancellationRace(signal) {
  if (signal === undefined) return { cancel() {}, promise: new Promise(() => {}) };
  if (signal.aborted)
    return {
      cancel() {},
      promise: Promise.resolve({ kind: "cancelled", reason: signal.reason }),
    };
  let listener;
  const promise = new Promise((resolve) => {
    listener = () => resolve({ kind: "cancelled", reason: signal.reason });
    signal.addEventListener("abort", listener, { once: true });
  });
  return { cancel: () => signal.removeEventListener("abort", listener), promise };
}

function excludeErrorIdentity(error, excluded) {
  const expandedAggregates = new WeakSet();
  const queue = [{ depth: 0, entry: error }];
  const retained = [];
  let visitedNodes = 0;
  let truncated = false;
  const unsafeGraphError = () =>
    new NativeError("POSIX cleanup error graph could not be normalized safely");

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (visitedNodes >= MAXIMUM_CLEANUP_ERROR_GRAPH_NODES) {
      truncated = true;
      break;
    }
    const { depth, entry } = queue[cursor];
    visitedNodes += 1;
    if (entry === undefined || entry === excluded) continue;
    if (depth > MAXIMUM_CLEANUP_ERROR_GRAPH_DEPTH) {
      truncated = true;
      continue;
    }
    let isAggregate;
    try {
      isAggregate = entry instanceof NativeAggregateError;
    } catch {
      retained.push(unsafeGraphError());
      continue;
    }
    if (!isAggregate) {
      retained.push(entry);
      continue;
    }
    if (expandedAggregates.has(entry)) {
      retained.push(unsafeGraphError());
      continue;
    }
    expandedAggregates.add(entry);

    let errors;
    let length;
    try {
      const errorsDescriptor = Object.getOwnPropertyDescriptor(entry, "errors");
      if (
        errorsDescriptor === undefined ||
        !("value" in errorsDescriptor) ||
        !Array.isArray(errorsDescriptor.value)
      ) {
        retained.push(unsafeGraphError());
        continue;
      }
      errors = errorsDescriptor.value;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(errors, "length");
      length = lengthDescriptor?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAXIMUM_CLEANUP_ERROR_GRAPH_NODES
      ) {
        retained.push(unsafeGraphError());
        continue;
      }
    } catch {
      retained.push(unsafeGraphError());
      continue;
    }

    const pendingNodes = queue.length - (cursor + 1);
    const availableNodes = Math.max(
      0,
      MAXIMUM_CLEANUP_ERROR_GRAPH_NODES - visitedNodes - pendingNodes,
    );
    const admittedLength = Math.min(length, availableNodes);
    try {
      for (let index = 0; index < admittedLength; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(errors, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          retained.push(unsafeGraphError());
          break;
        }
        queue.push({ depth: depth + 1, entry: descriptor.value });
      }
    } catch {
      retained.push(unsafeGraphError());
    }
    if (admittedLength < length) truncated = true;
  }

  if (truncated) retained.push(unsafeGraphError());
  if (retained.length === 0) return undefined;
  if (retained.length === 1) return retained[0];
  return new NativeAggregateError(retained, "POSIX process-tree cleanup failed closed");
}

function safeErrorMessage(error, fallback) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : fallback;
  } catch {
    return fallback;
  }
}

function defaultWindowsTaskkillExecutable(platform, environment) {
  if (platform !== "win32") return undefined;
  const systemRoot = environment.SystemRoot;
  if (
    typeof systemRoot !== "string" ||
    systemRoot.length < 3 ||
    systemRoot.length > 512 ||
    systemRoot.includes("\0") ||
    !path.win32.isAbsolute(systemRoot)
  ) {
    throw new TypeError("Windows SystemRoot must identify the trusted taskkill location");
  }
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

/** Run one command in a separately managed process tree. Exported for real subprocess tests. */
export async function runManagedCommand(
  executable,
  argumentsValue,
  {
    cwd = rootDirectory,
    env = process.env,
    killProcess = process.kill,
    maximumDurationMs = LANE_TIMEOUT_MS,
    now = performance.now.bind(performance),
    platform = process.platform,
    revalidateProcess = (pid) =>
      platform === "linux" ? readLinuxProcessStat(pid) : Promise.resolve(undefined),
    signal,
    snapshotProcesses = readPosixProcessSnapshot,
    spawnProcess = spawn,
    stdio = "inherit",
    terminationGraceMs = TERMINATION_GRACE_MS,
    windowsTaskkillExecutable = defaultWindowsTaskkillExecutable(platform, env),
  } = {},
) {
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1) {
    throw new TypeError("lane deadline must be a bounded positive safe integer");
  }
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new TypeError("lane termination grace must be a bounded positive safe integer");
  }
  const started = now();
  const deadline = started + maximumDurationMs;
  if (!Number.isFinite(started) || !Number.isFinite(deadline)) {
    throw new TypeError("monotonic lane clock returned an invalid value");
  }
  if (signal?.aborted) {
    return Object.freeze({
      error: new Error("Vitest lane was cancelled"),
      signal: null,
      status: null,
    });
  }

  let child;
  try {
    child = spawnProcess(process.execPath, ["--eval", PROCESS_SUPERVISOR_SOURCE], {
      cwd,
      detached: platform !== "win32",
      env,
      shell: false,
      stdio: [
        "ignore",
        stdio === "ignore" ? "ignore" : "inherit",
        stdio === "ignore" ? "ignore" : "inherit",
        "ipc",
      ],
      windowsHide: true,
    });
    child.send({
      arguments: argumentsValue,
      executable,
      ignoreOutput: stdio === "ignore",
      kind: "start",
    });
  } catch (error) {
    return Object.freeze({ error, signal: null, status: null });
  }

  let leaderClosed = false;
  const completion = new Promise((resolve) => {
    child.once("error", (error) =>
      resolve({ error, kind: "complete", signal: null, status: null }),
    );
    let reported = false;
    child.once("message", (message) => {
      if (message?.kind !== "lane-result") {
        resolve({
          error: new Error("lane supervisor returned an invalid result"),
          kind: "complete",
          signal: null,
          status: null,
        });
        return;
      }
      reported = true;
      resolve({
        error: message.supervisionLost
          ? new Error("Vitest lane host exited before reporting")
          : message.spawnFailed
            ? new Error("Vitest lane failed to start")
            : undefined,
        kind: "complete",
        signal: message.signal,
        status: message.status,
      });
    });
    child.once("close", () => {
      leaderClosed = true;
      if (!reported)
        resolve({
          error: new Error("lane supervisor exited before reporting"),
          kind: "complete",
          signal: null,
          status: null,
        });
    });
  });
  const posixObserver =
    platform === "win32" ? undefined : createPosixLineageObserver(child.pid, snapshotProcesses);
  const deadlineWait = deadlineRace(deadline, now);
  const cancellationWait = cancellationRace(signal);
  const winner = await Promise.race([
    completion,
    deadlineWait.promise,
    cancellationWait.promise,
    ...(posixObserver === undefined ? [] : [posixObserver.failurePromise]),
  ]);
  deadlineWait.cancel();
  cancellationWait.cancel();
  const posixObservation = await posixObserver?.stop();

  let cleanupError;
  try {
    // Always sweep the private process tree. A successful leader may still have orphaned descendants.
    await terminateProcessTree(child.pid, {
      killProcess,
      leaderIsClosed: () => leaderClosed,
      now,
      platform,
      posixObservation,
      revalidateProcess,
      snapshotProcesses,
      spawnProcess,
      supervisor: child,
      terminationGraceMs,
      windowsTaskkillExecutable,
    });
  } catch (error) {
    cleanupError = error;
  }
  if (winner.kind === "observer-failed" || posixObservation?.error !== undefined) {
    const observerError =
      posixObservation?.error ?? new Error("POSIX process observer failed closed");
    const distinctCleanupError = excludeErrorIdentity(cleanupError, observerError);
    return Object.freeze({
      error:
        distinctCleanupError === undefined
          ? observerError
          : new NativeAggregateError(
              [observerError, distinctCleanupError],
              safeErrorMessage(observerError, "POSIX process observer failed closed"),
            ),
      signal: null,
      status: null,
    });
  }
  if (cleanupError !== undefined) {
    return Object.freeze({ error: cleanupError, signal: null, status: null });
  }
  if (winner.kind === "deadline") {
    return Object.freeze({
      error: new Error("Vitest lane exceeded its deadline"),
      signal: null,
      status: null,
    });
  }
  if (winner.kind === "cancelled") {
    return Object.freeze({
      error: new Error("Vitest lane was cancelled"),
      signal: null,
      status: null,
    });
  }
  return Object.freeze({
    error: winner.error,
    signal: winner.signal ?? null,
    status: winner.status ?? null,
  });
}

function spawnVitest(argumentsValue, options) {
  return runManagedCommand(process.execPath, [vitestExecutable, ...argumentsValue], options);
}

export async function runVitestLanePlan(plan, execute = spawnVitest, options) {
  if (!Array.isArray(plan) || plan.length !== 2) {
    throw new TypeError("Vitest lane plan must contain exactly two nonempty lanes");
  }
  for (const lane of plan) {
    if (
      lane === null ||
      typeof lane !== "object" ||
      !Array.isArray(lane.arguments) ||
      lane.arguments.length < 1
    ) {
      throw new TypeError("Vitest lane plan contains an empty lane");
    }
    const result = await execute(lane.arguments, options);
    if (result === null || typeof result !== "object") {
      throw new TypeError("Vitest lane executor returned an invalid result");
    }
    if (result.error !== undefined || result.signal !== null || result.status !== 0) {
      return Object.freeze({
        error: result.error,
        lane: lane.name,
        signal: result.signal ?? null,
        status: result.status ?? null,
      });
    }
  }
  return Object.freeze({ lane: null, signal: null, status: 0 });
}

export async function runVitestSuite(options = {}) {
  await validateVitestLaneInputs();
  return runVitestLanePlan(createVitestLanePlan(options), spawnVitest, options);
}

export function propagateVitestOutcome(outcome, signalProcess = process.kill) {
  if (outcome.signal !== null) {
    signalProcess(process.pid, outcome.signal);
    return 1;
  }
  return outcome.status === 0 ? 0 : 1;
}

export function installParentCancellation(targetProcess, controller) {
  const listeners = new Map();
  for (const signal of FORWARD_SIGNALS) {
    const listener = () => controller.abort(signal);
    listeners.set(signal, listener);
    targetProcess.once(signal, listener);
  }
  return () => {
    for (const [signal, listener] of listeners) targetProcess.removeListener(signal, listener);
  };
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError("run-vitest-suite accepts no arguments");
  const controller = new AbortController();
  const removeParentListeners = installParentCancellation(process, controller);
  try {
    const outcome = await runVitestSuite({ signal: controller.signal });
    if (outcome.error !== undefined) {
      console.error(
        `Vitest ${outcome.lane} lane failed to start, was cancelled, or exceeded its deadline.`,
      );
    }
    if (controller.signal.aborted && FORWARD_SIGNALS.includes(controller.signal.reason)) {
      process.kill(process.pid, controller.signal.reason);
      return;
    }
    process.exitCode = propagateVitestOutcome(outcome);
  } finally {
    removeParentListeners();
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
