import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants as fileSystemConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createVitestLanePlan,
  installParentCancellation,
  MAXIMUM_SIZE_TEST_FILES,
  MAXIMUM_SIZE_TEST_TIMEOUT_MS,
  parseLinuxProcessStatForTest,
  propagateVitestOutcome,
  readLinuxProcessSnapshotForTest,
  readLinuxProcessStatForTest,
  runManagedCommand,
  runVitestLanePlan,
  selectVitestWorkerCount,
  validateVitestLaneInputs,
} from "./run-vitest-suite.mjs";

test("resource-aware worker selection is exact and bounded", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 7, 8, 1_024].map((value) => selectVitestWorkerCount(value)),
    [1, 2, 2, 2, 3, 4, 4],
  );
  for (const value of [undefined, null, 0, -1, 1.5, Number.NaN, 1_025, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => selectVitestWorkerCount(value), /bounded positive safe integer/u);
  }
});

test("the two lanes have exact disjoint heavy-test membership", async () => {
  await assert.doesNotReject(validateVitestLaneInputs());
  assert.deepEqual(MAXIMUM_SIZE_TEST_FILES, [
    "packages/cli/test/i03-commands.unit.test.ts",
    "packages/cli/test/scan-command.unit.test.ts",
    "packages/formatters/test/sarif.unit.test.ts",
    "packages/formatters/test/stylish.unit.test.ts",
    "packages/resolver/test/target-sampler.unit.test.ts",
    "packages/rules/test/rule-scheduler.unit.test.ts",
    "packages/rules/test/syntax-structure.unit.test.ts",
    "packages/standards/test/standards-cache.unit.test.ts",
  ]);
  const [light, heavy] = createVitestLanePlan({ available: 16 });
  assert.ok(light.arguments.length > 0);
  assert.ok(heavy.arguments.length > 0);
  assert.deepEqual(light.arguments.slice(0, 3), ["run", "--fileParallelism", "--maxWorkers=4"]);
  for (const file of MAXIMUM_SIZE_TEST_FILES) {
    const index = light.arguments.indexOf(file);
    assert.notEqual(index, -1);
    assert.equal(light.arguments[index - 1], "--exclude");
  }
  assert.deepEqual(heavy.arguments, [
    "run",
    ...MAXIMUM_SIZE_TEST_FILES,
    "--no-file-parallelism",
    "--maxWorkers=1",
    `--testTimeout=${String(MAXIMUM_SIZE_TEST_TIMEOUT_MS)}`,
  ]);
  assert.equal(
    light.arguments.some((value) => value.startsWith("--testTimeout=")),
    false,
  );
  assert.equal(MAXIMUM_SIZE_TEST_TIMEOUT_MS, 15_000);
});

test("serial and report plans preserve the same exact lane split", () => {
  const plan = createVitestLanePlan({
    available: 1,
    mode: "serial",
    outputFiles: ["/tmp/light.json", "/tmp/heavy.json"],
  });
  assert.deepEqual(plan[0].arguments.slice(0, 3), [
    "run",
    "--no-file-parallelism",
    "--maxWorkers=1",
  ]);
  assert.ok(plan[0].arguments.includes("--outputFile=/tmp/light.json"));
  assert.ok(plan[1].arguments.includes("--outputFile=/tmp/heavy.json"));
  assert.throws(
    () => createVitestLanePlan({ outputFiles: ["same", "same"] }),
    /two distinct paths/u,
  );
});

test("lane execution stops on the first exit failure and preserves its identity", async () => {
  const calls = [];
  const outcome = await runVitestLanePlan(
    createVitestLanePlan({ available: 2 }),
    async (argumentsValue) => {
      calls.push(argumentsValue);
      return { error: undefined, signal: null, status: 9 };
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(outcome, {
    error: undefined,
    lane: "resource-aware",
    signal: null,
    status: 9,
  });
  assert.equal(propagateVitestOutcome(outcome), 1);
});

test("lane execution preserves child signals and never starts the next lane", async () => {
  let calls = 0;
  const outcome = await runVitestLanePlan(createVitestLanePlan({ available: 2 }), async () => {
    calls += 1;
    return { error: undefined, signal: "SIGTERM", status: null };
  });
  let propagated;
  assert.equal(
    propagateVitestOutcome(outcome, (pid, signal) => {
      propagated = { pid, signal };
    }),
    1,
  );
  assert.equal(calls, 1);
  assert.deepEqual(propagated, { pid: process.pid, signal: "SIGTERM" });
});

test("malformed or empty plans and modes fail closed", async () => {
  assert.throws(() => createVitestLanePlan({ mode: "concurrent" }), /parallel or serial/u);
  await assert.rejects(runVitestLanePlan([]), /exactly two nonempty lanes/u);
  await assert.rejects(
    runVitestLanePlan([
      { arguments: [], name: "empty" },
      { arguments: [], name: "empty" },
    ]),
    /empty lane/u,
  );
});

test("managed command enforces a real deadline and escalates past ignored SIGTERM", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX signal semantics");
  const started = performance.now();
  const outcome = await runManagedCommand(
    process.execPath,
    ["--eval", "process.on('SIGTERM',()=>{});setInterval(()=>{},1_000)"],
    // Leave enough time for the portable POSIX observer to complete its first bounded snapshot even
    // when this contract runs beside the full repository gate on a saturated hosted runner.
    { maximumDurationMs: 300, stdio: "ignore", terminationGraceMs: 100 },
  );
  assert.match(outcome.error.message, /deadline/u);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.status, null);
  assert.ok(performance.now() - started < 2_000);
});

test("managed command handles a same-group grandchild according to native identity support", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX process-group semantics");
  const directory = await mkdtemp(path.join(tmpdir(), "svetovid-lane-tree-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const marker = path.join(directory, "orphan-marker");
  const grandchild = [
    "const {writeFileSync}=require('node:fs');",
    `setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'orphan'),2500);`,
    "setTimeout(()=>process.exit(0),2800);",
  ].join("");
  const parent = [
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['--eval',${JSON.stringify(grandchild)}],{stdio:'ignore'});`,
    "child.unref();",
    "setTimeout(()=>process.exit(0),300);",
  ].join("");
  const outcome = await runManagedCommand(process.execPath, ["--eval", parent], {
    maximumDurationMs: 1_000,
    stdio: "ignore",
    terminationGraceMs: 80,
  });
  assert.equal(outcome.status, 0);
  // The marker deadline exceeds the observer's documented two-second snapshot ceiling, so a
  // saturated runner cannot turn normal bounded observation latency into an orphan false positive.
  await new Promise((resolve) => setTimeout(resolve, 2700));
  await assert.rejects(access(marker));
});

test("a lane that kills its direct host cannot orphan a delayed marker on POSIX", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX process-group semantics");
  const directory = await mkdtemp(path.join(tmpdir(), "svetovid-lane-host-loss-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const marker = path.join(directory, "orphan-marker");
  const lane = [
    "const {writeFileSync}=require('node:fs');",
    "process.kill(process.ppid,'SIGKILL');",
    `setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'orphan'),2500);`,
    "setInterval(()=>{},1_000);",
  ].join("");
  const outcome = await runManagedCommand(process.execPath, ["--eval", lane], {
    maximumDurationMs: 1_000,
    stdio: "ignore",
    terminationGraceMs: 100,
  });
  assert.match(outcome.error.message, /lane host exited/u);
  await new Promise((resolve) => setTimeout(resolve, 2700));
  await assert.rejects(access(marker));
});

test("an observed detached POSIX descendant fails the lane and cannot leave a marker", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX session semantics");
  const directory = await mkdtemp(path.join(tmpdir(), "svetovid-lane-escape-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const marker = path.join(directory, "escaped-marker");
  const grandchild = [
    "const {writeFileSync}=require('node:fs');",
    `setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'escaped'),500);`,
    "setTimeout(()=>process.exit(0),700);",
  ].join("");
  const parent = [
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['--eval',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});`,
    "child.unref();",
    "setTimeout(()=>process.exit(0),350);",
  ].join("");
  let calls = 0;
  const outcome = await runVitestLanePlan(createVitestLanePlan({ available: 2 }), async () => {
    calls += 1;
    return runManagedCommand(process.execPath, ["--eval", parent], {
      maximumDurationMs: 1_000,
      stdio: "ignore",
      terminationGraceMs: 80,
    });
  });
  assert.equal(calls, 1);
  assert.match(outcome.error.message, /escaped/u);
  await new Promise((resolve) => setTimeout(resolve, 650));
  if (process.platform === "linux") await assert.rejects(access(marker));
  else await assert.doesNotReject(access(marker));
});

test("Linux stat parsing binds exact start ticks despite hostile process names", () => {
  const fields = [
    "1",
    "2",
    "3",
    ...Array.from({ length: 15 }, (_, index) => String(index + 4)),
    "987654321",
  ];
  assert.deepEqual(
    parseLinuxProcessStatForTest(`123 (name ) S mimic) S ${fields.join(" ")}\n`, 123),
    {
      identity: "123:linux-proc-start:987654321",
      parentPid: 1,
      pid: 123,
      preciseIdentity: "linux-proc-start:987654321",
      processGroupId: 2,
      sessionId: 3,
    },
  );
  assert.equal(
    parseLinuxProcessStatForTest(`123 (traced) t ${fields.join(" ")}\n`, 123).preciseIdentity,
    "linux-proc-start:987654321",
  );
  const kernelWorkerFields = [
    "0",
    "0",
    "0",
    ...Array.from({ length: 15 }, (_, index) => String(index + 4)),
    "987654321",
  ];
  assert.equal(
    parseLinuxProcessStatForTest(`2 (kthreadd) S ${kernelWorkerFields.join(" ")}\n`, 2),
    undefined,
  );
  for (const [processGroupId, sessionId] of [
    ["0", "3"],
    ["2", "0"],
  ]) {
    assert.throws(
      () =>
        parseLinuxProcessStatForTest(
          `123 (mixed-zero) S ${["1", processGroupId, sessionId, ...fields.slice(3)].join(" ")}\n`,
          123,
        ),
      /malformed stat fields/u,
    );
  }
  for (const [text, pid] of [
    ["123 (name) S 1 2 3", 123],
    [`123 (name) S ${fields.join(" ")}\n`, 124],
    [`123 (name) S ${[...fields.slice(0, -1), "01"].join(" ")}\n`, 123],
    [`123 (name) S ${fields.join(" ")}\0`, 123],
    ["x".repeat(16 * 1024 + 1), 123],
  ]) {
    assert.throws(() => parseLinuxProcessStatForTest(text, pid), /Linux process observer/u);
  }
});

test("Linux stat reader uses a bounded no-follow handle and rejects non-race failures", async () => {
  const fields = [
    "1",
    "2",
    "3",
    ...Array.from({ length: 15 }, (_, index) => String(index + 4)),
    "99",
  ];
  const bytes = Buffer.from(`7 (worker) S ${fields.join(" ")}\n`);
  let closed = false;
  const row = await readLinuxProcessStatForTest(7, async (target, flags) => {
    assert.equal(target, "/proc/7/stat");
    const noFollow = Number.isSafeInteger(fileSystemConstants.O_NOFOLLOW)
      ? fileSystemConstants.O_NOFOLLOW
      : 0;
    assert.equal(flags, fileSystemConstants.O_RDONLY | noFollow);
    if (noFollow !== 0) {
      assert.notEqual(flags & noFollow, 0);
    }
    let consumed = false;
    return {
      close: async () => {
        closed = true;
      },
      read: async (buffer, offset) => {
        if (consumed) return { bytesRead: 0 };
        consumed = true;
        bytes.copy(buffer, offset);
        return { bytesRead: bytes.byteLength };
      },
      stat: async () => ({ isFile: () => true }),
    };
  });
  assert.equal(row.preciseIdentity, "linux-proc-start:99");
  assert.equal(closed, true);

  for (const code of ["ENOENT", "ESRCH"]) {
    await assert.doesNotReject(async () => {
      assert.equal(
        await readLinuxProcessStatForTest(7, async () =>
          Promise.reject(Object.assign(new Error("vanished"), { code })),
        ),
        undefined,
      );
    });
  }
  assert.equal(
    await readLinuxProcessStatForTest(7, async () => ({
      close: async () => {},
      stat: async () => Promise.reject(Object.assign(new Error("vanished"), { code: "ESRCH" })),
    })),
    undefined,
  );
  await assert.rejects(
    readLinuxProcessStatForTest(7, async () =>
      Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
    ),
    /denied/u,
  );
  await assert.rejects(
    readLinuxProcessStatForTest(7, async () => ({
      close: async () => {},
      stat: async () => ({ isFile: () => false }),
    })),
    /ordinary file/u,
  );
  await assert.rejects(
    readLinuxProcessStatForTest(7, async () => ({
      close: async () => {},
      read: async (buffer) => {
        buffer.fill(0x31);
        return { bytesRead: buffer.byteLength };
      },
      stat: async () => ({ isFile: () => true }),
    })),
    /output limit/u,
  );
});

function processDirectory(entries) {
  return Object.freeze({
    async *[Symbol.asyncIterator]() {
      for (const entry of entries) yield entry;
    },
  });
}

function processEntry(name, directory = true) {
  return Object.freeze({ isDirectory: () => directory, name });
}

test("Linux snapshot derives lineage and identity from one reused PID stat record", async () => {
  const reads = [];
  const snapshot = await readLinuxProcessSnapshotForTest({
    openDirectory: async (target) => {
      assert.equal(target, "/proc");
      return processDirectory([processEntry("self", false), processEntry("42")]);
    },
    readProcessStat: async (pid) => {
      reads.push(pid);
      return Object.freeze({
        identity: "42:linux-proc-start:200",
        parentPid: 900,
        pid: 42,
        preciseIdentity: "linux-proc-start:200",
        processGroupId: 901,
        sessionId: 902,
      });
    },
  });
  assert.deepEqual(reads, [42]);
  assert.deepEqual(snapshot, [
    {
      identity: "42:linux-proc-start:200",
      parentPid: 900,
      pid: 42,
      preciseIdentity: "linux-proc-start:200",
      processGroupId: 901,
      sessionId: 902,
    },
  ]);
});

test("Linux snapshot bounds hostile enumeration and tolerates only vanished processes", async () => {
  const readProcessStat = async (pid) =>
    pid === 2 ? undefined : posixRow(pid, 1, pid, `p:${pid}`);
  assert.deepEqual(
    await readLinuxProcessSnapshotForTest({
      openDirectory: async () => processDirectory([processEntry("2"), processEntry("1")]),
      readProcessStat,
    }),
    [posixRow(1, 1, 1, "p:1")],
  );
  for (const entries of [
    [processEntry("1", false)],
    [processEntry("1"), processEntry("1")],
    [processEntry(String(Number.MAX_SAFE_INTEGER) + "0")],
  ]) {
    await assert.rejects(
      readLinuxProcessSnapshotForTest({
        openDirectory: async () => processDirectory(entries),
        readProcessStat,
      }),
      /Linux/u,
    );
  }
  await assert.rejects(
    readLinuxProcessSnapshotForTest({
      openDirectory: async () =>
        processDirectory(
          Array.from({ length: 32_769 }, (_, index) => processEntry(String(index + 1))),
        ),
      readProcessStat,
    }),
    /PID limit/u,
  );
  await assert.rejects(
    readLinuxProcessSnapshotForTest({
      openDirectory: async () => ({
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 131_073; index += 1) yield processEntry("self", false);
        },
      }),
      readProcessStat,
    }),
    /entry limit/u,
  );
  await assert.rejects(
    readLinuxProcessSnapshotForTest({
      openDirectory: async () => processDirectory([processEntry("1")]),
      readProcessStat: async () => Promise.reject(new Error("stat denied")),
    }),
    /stat denied/u,
  );
});

function posixRow(pid, parentPid, processGroupId, preciseIdentity) {
  return Object.freeze({
    identity: `${String(pid)}:Mon Aug 10 00:00:00 2026`,
    parentPid,
    pid,
    ...(preciseIdentity === undefined ? {} : { preciseIdentity }),
    processGroupId,
    sessionId: processGroupId,
  });
}

class FakeSupervisor extends EventEmitter {
  connected = true;
  cleanupRequests = 0;
  pid = 123;
  send(request, callback) {
    if (request.kind === "cleanup-kill") {
      this.cleanupRequests += 1;
      this.onCleanup?.();
      callback?.(null);
      return;
    }
    queueMicrotask(() =>
      this.emit("message", {
        kind: "lane-result",
        signal: null,
        spawnFailed: false,
        status: 0,
      }),
    );
  }
}

async function runDetachedIdentityScenario({
  replacementIdentity,
  revalidatedIdentity = replacementIdentity,
  trackedIdentity,
}) {
  const child = new FakeSupervisor();
  const signals = [];
  let snapshot = 0;
  let groupKilled = false;
  child.onCleanup = () => {
    groupKilled = true;
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  };
  const outcomePromise = runManagedCommand("node", ["lane"], {
    killProcess: (pid, signal) => {
      if (pid < 0) {
        if (groupKilled) throw Object.assign(new Error("missing group"), { code: "ESRCH" });
        return;
      }
      signals.push({ pid, signal });
    },
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async (pid) =>
      pid === 123
        ? posixRow(123, 1, 123, "linux-proc-start:1")
        : posixRow(pid, 1, 999, revalidatedIdentity),
    snapshotProcesses: async () => {
      snapshot += 1;
      if (groupKilled) return Object.freeze([]);
      if (snapshot === 1)
        return Object.freeze([
          posixRow(123, 1, 123, "linux-proc-start:1"),
          posixRow(999, 123, 999, trackedIdentity),
        ]);
      return Object.freeze([
        posixRow(123, 1, 123, "linux-proc-start:1"),
        posixRow(999, 1, 999, replacementIdentity),
      ]);
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  return Object.freeze({ outcome: await outcomePromise, signals });
}

test("same-second detached PID reuse fails without signalling the replacement", async () => {
  const result = await runDetachedIdentityScenario({
    replacementIdentity: "linux-proc-start:11",
    trackedIdentity: "linux-proc-start:10",
  });
  assert.match(result.outcome.error.message, /precise identity/u);
  assert.deepEqual(result.signals, []);
});

test("detached PID reuse after a coherent snapshot is rejected immediately before signal", async () => {
  const result = await runDetachedIdentityScenario({
    replacementIdentity: "linux-proc-start:10",
    revalidatedIdentity: "linux-proc-start:11",
    trackedIdentity: "linux-proc-start:10",
  });
  assert.match(result.outcome.error.message, /immediately before cleanup/u);
  assert.deepEqual(result.signals, []);
});

test("a precisely matched Linux detached PID is terminated but still fails the lane", async () => {
  const result = await runDetachedIdentityScenario({
    replacementIdentity: "linux-proc-start:10",
    trackedIdentity: "linux-proc-start:10",
  });
  assert.match(result.outcome.error.message, /escaped/u);
  assert.deepEqual(result.signals, [
    { pid: 999, signal: "SIGTERM" },
    { pid: 999, signal: "SIGKILL" },
  ]);
});

test("POSIX without a precise identity fails without individually signalling", async () => {
  const result = await runDetachedIdentityScenario({
    replacementIdentity: undefined,
    trackedIdentity: undefined,
  });
  assert.match(result.outcome.error.message, /precise identity/u);
  assert.deepEqual(result.signals, []);
});

test("Linux supervisor replacement rejects external TERM but retains owned cleanup", async () => {
  const child = new FakeSupervisor();
  const signals = [];
  let cleaned = false;
  child.onCleanup = () => {
    cleaned = true;
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  };
  const outcomePromise = runManagedCommand("node", ["lane"], {
    killProcess: (pid, signal) => {
      if (signal === 0 && cleaned)
        throw Object.assign(new Error("missing group"), { code: "ESRCH" });
      if (signal !== 0) signals.push({ pid, signal });
    },
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async () => posixRow(123, 1, 123, "linux-proc-start:11"),
    snapshotProcesses: async () => Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]),
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  const outcome = await outcomePromise;
  assert.match(outcome.error.message, /supervisor identity/u);
  assert.deepEqual(signals, []);
});

async function runSupervisorGroupScenario({
  closeAfterTerm = false,
  initialGroupExists = true,
  revalidatedIdentities,
}) {
  const child = new FakeSupervisor();
  const signals = [];
  const identities = [...revalidatedIdentities];
  let killed = false;
  let probes = 0;
  let revalidations = 0;
  child.onCleanup = () => {
    killed = true;
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  };
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: (pid, signal) => {
      if (signal === 0) {
        probes += 1;
        if (!initialGroupExists || killed)
          throw Object.assign(new Error("missing group"), { code: "ESRCH" });
        return;
      }
      signals.push({ pid, signal });
      if (signal === "SIGTERM" && closeAfterTerm)
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    },
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async () => {
      const identity = identities[Math.min(revalidations, identities.length - 1)];
      revalidations += 1;
      return identity === undefined ? undefined : posixRow(123, 1, 123, identity);
    },
    snapshotProcesses: async () => Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]),
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  return Object.freeze({
    cleanupRequests: child.cleanupRequests,
    outcome,
    probes,
    revalidations,
    signals,
  });
}

test("matching resident Linux supervisor is revalidated before TERM and KILL", async () => {
  const result = await runSupervisorGroupScenario({
    revalidatedIdentities: ["linux-proc-start:10", "linux-proc-start:10"],
  });
  assert.equal(result.outcome.status, 0);
  assert.equal(result.revalidations, 2);
  assert.equal(result.cleanupRequests, 1);
  assert.deepEqual(result.signals, [{ pid: -123, signal: "SIGTERM" }]);
});

test("disappeared supervisor rejects external TERM but retains owned cleanup", async () => {
  const result = await runSupervisorGroupScenario({ revalidatedIdentities: [undefined] });
  assert.match(result.outcome.error.message, /supervisor identity/u);
  assert.equal(result.cleanupRequests, 1);
  assert.deepEqual(result.signals, []);
});

test("ESRCH before TERM prevents a later external reused-PGID signal", async () => {
  const result = await runSupervisorGroupScenario({
    initialGroupExists: false,
    revalidatedIdentities: ["linux-proc-start:10"],
  });
  assert.match(result.outcome.error.message, /disappeared/u);
  assert.equal(result.probes, 2);
  assert.equal(result.revalidations, 1);
  assert.equal(result.cleanupRequests, 1);
  assert.deepEqual(result.signals, []);
});

test("identity change after TERM fails while the resident supervisor owns KILL", async () => {
  const result = await runSupervisorGroupScenario({
    revalidatedIdentities: ["linux-proc-start:10", "linux-proc-start:11"],
  });
  assert.match(result.outcome.error.message, /supervisor identity/u);
  assert.equal(result.cleanupRequests, 1);
  assert.deepEqual(result.signals, [{ pid: -123, signal: "SIGTERM" }]);
});

test("supervisor death between TERM and KILL fails without an unowned group signal", async () => {
  const result = await runSupervisorGroupScenario({
    closeAfterTerm: true,
    revalidatedIdentities: ["linux-proc-start:10"],
  });
  assert.match(result.outcome.error.message, /supervisor exited/u);
  assert.equal(result.cleanupRequests, 0);
  assert.deepEqual(result.signals, [{ pid: -123, signal: "SIGTERM" }]);
});

test("post-TERM observer failure still executes owned-group KILL and fails the lane", async () => {
  const child = new FakeSupervisor();
  const signals = [];
  let afterTerm = false;
  let cleaned = false;
  child.onCleanup = () => {
    cleaned = true;
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  };
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: (pid, signal) => {
      if (signal === 0) {
        if (cleaned) throw Object.assign(new Error("missing group"), { code: "ESRCH" });
        return;
      }
      signals.push({ pid, signal });
      if (signal === "SIGTERM") afterTerm = true;
    },
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async () => posixRow(123, 1, 123, "linux-proc-start:10"),
    snapshotProcesses: async () => {
      if (afterTerm) throw new Error("post-TERM observer failure");
      return Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]);
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  assert.match(outcome.error.message, /post-TERM observer failure/u);
  assert.equal(child.cleanupRequests, 1);
  assert.deepEqual(signals, [{ pid: -123, signal: "SIGTERM" }]);
});

test("POSIX observer capability failures fail closed and suppress lane two", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX observer semantics");
  for (const message of [
    "observer unavailable",
    "observer output overflow",
    "observer malformed",
  ]) {
    let calls = 0;
    const outcome = await runVitestLanePlan(createVitestLanePlan({ available: 2 }), async () => {
      calls += 1;
      return runManagedCommand(process.execPath, ["--eval", "setTimeout(()=>process.exit(0),50)"], {
        maximumDurationMs: 500,
        snapshotProcesses: async () => Promise.reject(new Error(message)),
        stdio: "ignore",
        terminationGraceMs: 100,
      });
    });
    assert.equal(calls, 1);
    assert.match(outcome.error.message, /observer/u);
  }
});

test("the first observer failure remains primary when owned cleanup also fails", async () => {
  const child = new FakeSupervisor();
  child.send = (request, callback) => {
    if (request.kind !== "cleanup-kill") return;
    child.cleanupRequests += 1;
    child.onCleanup?.();
    callback?.(null);
  };
  child.onCleanup = () => {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  };
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: (_pid, signal) => {
      if (signal === 0) return;
    },
    maximumDurationMs: 500,
    platform: "darwin",
    snapshotProcesses: async () => Promise.reject(new Error("first observer failure")),
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  assert.match(outcome.error.message, /first observer failure/u);
  assert.equal(child.cleanupRequests, 1);
  assert.equal(
    outcome.error instanceof AggregateError,
    true,
    `expected observer and cleanup evidence, received: ${String(outcome.error)}`,
  );
  const cleanup = outcome.error.errors[1];
  assert.equal(cleanup instanceof AggregateError, true);
  assert.equal(
    cleanup.errors.some((error) => /supervisor identity/u.test(error.message)),
    true,
  );
  assert.equal(
    cleanup.errors.some((error) => /owned-group SIGKILL/u.test(error.message)),
    true,
  );
});

test("observer failure retains a distinct non-terminal cleanup-channel failure", async () => {
  const child = new FakeSupervisor();
  child.send = () => {};
  let cleanupChannelChecked = false;
  Object.defineProperty(child, "connected", {
    configurable: true,
    get() {
      cleanupChannelChecked = true;
      return false;
    },
  });
  const observerError = new Error("observer-one");
  let snapshotCall = 0;
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: (pid, signal) => {
      if (pid < 0 && signal === 0 && cleanupChannelChecked) {
        throw Object.assign(new Error("missing group"), { code: "ESRCH" });
      }
    },
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async () => posixRow(123, 1, 123, "linux-proc-start:10"),
    snapshotProcesses: async () => {
      snapshotCall += 1;
      if (snapshotCall === 2 || snapshotCall === 3) throw observerError;
      return Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]);
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  assert.equal(
    outcome.error instanceof AggregateError,
    true,
    `expected observer and cleanup evidence, received: ${String(outcome.error)}`,
  );
  assert.equal(outcome.error.errors.length, 2);
  assert.equal(outcome.error.errors[0], observerError);
  assert.notEqual(outcome.error.errors[1], observerError);
  assert.match(outcome.error.errors[1].message, /cleanup channel is not connected/u);
});

test("final observer failure overrides an already completed lane", async () => {
  const child = new FakeSupervisor();
  const observerError = new Error("final observer failure");
  let snapshotCall = 0;
  let terminated = false;
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: (pid, signal) => {
      if (pid < 0 && signal === "SIGTERM") terminated = true;
      if (pid < 0 && signal === 0 && terminated) {
        throw Object.assign(new Error("missing group"), { code: "ESRCH" });
      }
    },
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async () => posixRow(123, 1, 123, "linux-proc-start:10"),
    snapshotProcesses: async () => {
      snapshotCall += 1;
      if (snapshotCall === 2) throw observerError;
      return Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]);
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  assert.equal(outcome.status, null);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.error, observerError);
  assert.equal(terminated, true);
  assert.equal(snapshotCall, 4);
});

test("initial revalidation failure still performs owned cleanup", async () => {
  const child = new FakeSupervisor();
  const observerError = new Error("observer");
  const revalidationError = new Error("revalidation");
  let cleaned = false;
  let snapshotCall = 0;
  child.send = (request, callback) => {
    if (request.kind !== "cleanup-kill") return;
    child.cleanupRequests += 1;
    cleaned = true;
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    callback?.(null);
  };
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: (pid, signal) => {
      if (pid < 0 && signal === 0 && cleaned) {
        throw Object.assign(new Error("missing group"), { code: "ESRCH" });
      }
    },
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async () => Promise.reject(revalidationError),
    snapshotProcesses: async () => {
      snapshotCall += 1;
      if (snapshotCall === 2) throw observerError;
      return Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]);
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  assert.equal(outcome.error instanceof AggregateError, true);
  assert.deepEqual(outcome.error.errors, [observerError, revalidationError]);
  assert.equal(child.cleanupRequests, 1);
  assert.equal(cleaned, true);
});

test("cyclic and malformed cleanup error graphs remain closed outcomes", async (context) => {
  const observerError = new Error("observer");
  const cyclicError = new AggregateError([observerError], "cyclic cleanup");
  cyclicError.errors.push(cyclicError);
  const malformedError = new AggregateError([], "malformed cleanup");
  Object.defineProperty(malformedError, "errors", {
    configurable: true,
    get() {
      throw new Error("untrusted errors getter");
    },
  });
  const repeatedExcludedError = new AggregateError(
    Array.from(
      { length: 256 },
      () => new AggregateError(Array.from({ length: 256 }, () => observerError)),
    ),
    "repeated excluded identity",
  );

  for (const [name, cleanupError] of [
    ["cyclic", cyclicError],
    ["malformed", malformedError],
    ["repeated-excluded-budget", repeatedExcludedError],
  ]) {
    await context.test(name, async () => {
      const child = new FakeSupervisor();
      let cleaned = false;
      let snapshotCall = 0;
      child.send = (request, callback) => {
        if (request.kind !== "cleanup-kill") return;
        child.cleanupRequests += 1;
        cleaned = true;
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        callback?.(null);
      };
      const outcome = await runManagedCommand("node", ["lane"], {
        killProcess: (pid, signal) => {
          if (pid < 0 && signal === 0 && cleaned) {
            throw Object.assign(new Error("missing group"), { code: "ESRCH" });
          }
        },
        maximumDurationMs: 500,
        platform: "linux",
        revalidateProcess: async () => Promise.reject(cleanupError),
        snapshotProcesses: async () => {
          snapshotCall += 1;
          if (snapshotCall === 2) throw observerError;
          return Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]);
        },
        spawnProcess: () => child,
        stdio: "ignore",
        terminationGraceMs: 20,
      });
      assert.equal(outcome.status, null);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.error instanceof AggregateError, true);
      assert.equal(outcome.error.errors[0], observerError);
      const cleanupEvidence = outcome.error.errors[1];
      const normalizationError =
        cleanupEvidence instanceof AggregateError
          ? cleanupEvidence.errors.find((error) =>
              /could not be normalized safely/u.test(error.message),
            )
          : cleanupEvidence;
      assert.match(normalizationError?.message ?? "", /could not be normalized safely/u);
      assert.equal(child.cleanupRequests, 1);
      assert.equal(cleaned, true);
    });
  }
});

test("cleanup aggregation never inspects hostile error messages", async () => {
  const child = new FakeSupervisor();
  child.send = () => {};
  child.connected = false;
  const observerError = new Error("observer");
  const hostileCleanupError = new Error("hostile cleanup");
  Object.defineProperty(hostileCleanupError, "message", {
    configurable: true,
    get() {
      throw new Error("message getter escaped");
    },
  });
  let snapshotCall = 0;
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: () => {},
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async () => Promise.reject(hostileCleanupError),
    snapshotProcesses: async () => {
      snapshotCall += 1;
      if (snapshotCall === 2) throw observerError;
      return Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]);
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 5,
  });
  assert.equal(outcome.error instanceof AggregateError, true);
  assert.equal(outcome.error.errors[0], observerError);
  const cleanup = outcome.error.errors[1];
  assert.equal(cleanup instanceof AggregateError, true);
  assert.equal(cleanup.errors.includes(hostileCleanupError), true);
  assert.equal(
    cleanup.errors.some(
      (error) =>
        Object.getOwnPropertyDescriptor(error, "message")?.value ===
        "Vitest process group did not terminate after owned-group SIGKILL",
    ),
    true,
  );
});

test("a wide cleanup graph cannot hide later terminal evidence", async () => {
  const child = new FakeSupervisor();
  child.send = () => {};
  child.connected = false;
  const observerError = new Error("observer");
  const wideError = new AggregateError(
    Array.from(
      { length: 256 },
      () => new AggregateError(Array.from({ length: 256 }, () => observerError)),
    ),
    "wide cleanup",
  );
  let snapshotCall = 0;
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: () => {},
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async () => Promise.reject(wideError),
    snapshotProcesses: async () => {
      snapshotCall += 1;
      if (snapshotCall === 2) throw observerError;
      return Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]);
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 5,
  });
  assert.equal(outcome.error instanceof AggregateError, true);
  assert.equal(outcome.error.errors[0], observerError);
  const cleanup = outcome.error.errors[1];
  assert.equal(cleanup instanceof AggregateError, true);
  assert.equal(
    cleanup.errors.some(
      (error) =>
        Object.getOwnPropertyDescriptor(error, "message")?.value ===
        "Vitest process group did not terminate after owned-group SIGKILL",
    ),
    true,
  );
  assert.equal(
    cleanup.errors.some((error) =>
      /could not be normalized safely/u.test(
        Object.getOwnPropertyDescriptor(error, "message")?.value ?? "",
      ),
    ),
    true,
  );
});

test("escaped-descendant uncertainty overflow preserves cleanup terminal evidence", async () => {
  const child = new FakeSupervisor();
  child.send = () => {};
  child.connected = false;
  const observerError = new Error("observer");
  const rootRow = posixRow(123, 1, 123, "linux-proc-start:10");
  const escapedRows = Array.from({ length: 257 }, (_, index) =>
    posixRow(1_000 + index, 123, 2_000 + index, `linux-proc-start:${String(index + 20)}`),
  );
  const rows = Object.freeze([rootRow, ...escapedRows]);
  let snapshotCall = 0;
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: () => {},
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async (pid) => Promise.reject(new Error(`revalidation ${String(pid)}`)),
    snapshotProcesses: async () => {
      snapshotCall += 1;
      if (snapshotCall === 2) throw observerError;
      return rows;
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 5,
  });
  assert.equal(outcome.error instanceof AggregateError, true);
  assert.equal(outcome.error.errors[0], observerError);
  const cleanup = outcome.error.errors[1];
  assert.equal(cleanup instanceof AggregateError, true);
  assert.equal(cleanup.errors.length <= 255, true);
  const messages = cleanup.errors.map(
    (error) => Object.getOwnPropertyDescriptor(error, "message")?.value ?? "",
  );
  assert.equal(messages.includes("POSIX cleanup uncertainty limit was exceeded"), true);
  assert.equal(messages.includes("POSIX supervisor cleanup channel is not connected"), true);
  assert.equal(
    messages.includes("Vitest process group did not terminate after owned-group SIGKILL"),
    true,
  );
  assert.equal(messages.includes("escaped POSIX descendants survived cleanup"), true);
  assert.equal(snapshotCall, 4);
});

test("hostile escaped-signal error codes cannot skip owned cleanup", async () => {
  const child = new FakeSupervisor();
  const observerError = new Error("observer");
  const hostileSignalError = new Error("hostile signal failure");
  Object.defineProperty(hostileSignalError, "code", {
    configurable: true,
    get() {
      throw new Error("code getter escaped");
    },
  });
  const fabricatedCodeError = new Proxy(new Error("fabricated code"), {
    getOwnPropertyDescriptor(target, property) {
      if (property === "code") {
        return { configurable: true, enumerable: true, value: "ESRCH", writable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const revokedCodeError = Proxy.revocable(new Error("revoked code"), {});
  revokedCodeError.revoke();
  const rows = Object.freeze([
    posixRow(123, 1, 123, "linux-proc-start:10"),
    posixRow(456, 123, 999, "linux-proc-start:20"),
    posixRow(789, 123, 998, "linux-proc-start:21"),
  ]);
  let cleaned = false;
  let injected = false;
  let snapshotCall = 0;
  child.onCleanup = () => {
    cleaned = true;
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  };
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: (pid, signal) => {
      if (pid === 456 && signal === "SIGTERM" && !injected) {
        injected = true;
        throw hostileSignalError;
      }
      if (pid === 456 && signal === "SIGKILL") throw fabricatedCodeError;
      if (pid === 789 && signal === "SIGTERM") throw revokedCodeError.proxy;
      if (pid < 0 && signal === 0 && cleaned) {
        throw Object.assign(new Error("missing group"), { code: "ESRCH" });
      }
    },
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async (pid) =>
      pid === 123
        ? posixRow(123, 1, 123, "linux-proc-start:10")
        : pid === 456
          ? posixRow(456, 123, 999, "linux-proc-start:20")
          : posixRow(789, 123, 998, "linux-proc-start:21"),
    snapshotProcesses: async () => {
      snapshotCall += 1;
      if (snapshotCall === 2) throw observerError;
      return cleaned ? Object.freeze([]) : rows;
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  assert.equal(outcome.error instanceof AggregateError, true);
  assert.equal(outcome.error.errors[0], observerError);
  const cleanup = outcome.error.errors[1];
  assert.equal(cleanup instanceof AggregateError, true);
  assert.equal(cleanup.errors.includes(hostileSignalError), true);
  assert.equal(cleanup.errors.includes(fabricatedCodeError), true);
  assert.equal(
    cleanup.errors.some(
      (error) =>
        Object.getOwnPropertyDescriptor(error, "message")?.value ===
        "POSIX cleanup error graph could not be normalized safely",
    ),
    true,
  );
  assert.equal(child.cleanupRequests, 1);
  assert.equal(cleaned, true);
  assert.equal(snapshotCall, 4);
});

test("pre-cleanup POSIX probe and TERM failures still perform owned cleanup", async (context) => {
  for (const failurePoint of ["probe", "term", "wait"]) {
    await context.test(failurePoint, async () => {
      const child = new FakeSupervisor();
      const observerError = new Error(`observer-${failurePoint}`);
      const cleanupError = Object.assign(new Error(`cleanup-${failurePoint}`), {
        code: "EACCES",
      });
      let cleaned = false;
      let snapshotCall = 0;
      let termSent = false;
      let injected = false;
      child.send = (request, callback) => {
        if (request.kind !== "cleanup-kill") return;
        child.cleanupRequests += 1;
        cleaned = true;
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        callback?.(null);
      };
      const outcome = await runManagedCommand("node", ["lane"], {
        killProcess: (pid, signal) => {
          if (pid >= 0) return;
          if (signal === 0) {
            if (cleaned) throw Object.assign(new Error("missing group"), { code: "ESRCH" });
            if (!injected && (failurePoint === "probe" || (failurePoint === "wait" && termSent))) {
              injected = true;
              throw cleanupError;
            }
            return;
          }
          if (signal === "SIGTERM") {
            termSent = true;
            if (!injected && failurePoint === "term") {
              injected = true;
              throw cleanupError;
            }
          }
        },
        maximumDurationMs: 500,
        platform: "linux",
        revalidateProcess: async () => posixRow(123, 1, 123, "linux-proc-start:10"),
        snapshotProcesses: async () => {
          snapshotCall += 1;
          if (snapshotCall === 2) throw observerError;
          return Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]);
        },
        spawnProcess: () => child,
        stdio: "ignore",
        terminationGraceMs: 20,
      });
      assert.equal(outcome.error instanceof AggregateError, true);
      assert.deepEqual(outcome.error.errors, [observerError, cleanupError]);
      assert.equal(child.cleanupRequests, 1);
      assert.equal(cleaned, true);
      assert.equal(injected, true);
    });
  }
});

test("observer failure retains cleanup-channel and terminal evidence", async () => {
  const child = new FakeSupervisor();
  child.send = () => {};
  child.connected = false;
  const observerError = new Error("observer");
  let snapshotCall = 0;
  const outcome = await runManagedCommand("node", ["lane"], {
    killProcess: () => {},
    maximumDurationMs: 500,
    platform: "linux",
    revalidateProcess: async () => posixRow(123, 1, 123, "linux-proc-start:10"),
    snapshotProcesses: async () => {
      snapshotCall += 1;
      if (snapshotCall === 2 || snapshotCall === 3) throw observerError;
      return Object.freeze([posixRow(123, 1, 123, "linux-proc-start:10")]);
    },
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 5,
  });
  assert.equal(outcome.error instanceof AggregateError, true);
  assert.equal(outcome.error.errors[0], observerError);
  const cleanup = outcome.error.errors[1];
  assert.equal(cleanup instanceof AggregateError, true);
  assert.equal(cleanup.errors.length, 2);
  assert.equal(cleanup.errors.includes(observerError), false);
  assert.match(cleanup.errors[0].message, /cleanup channel is not connected/u);
  assert.match(cleanup.errors[1].message, /did not terminate after owned-group SIGKILL/u);
});

test("stale POSIX process-group identity fails without signalling the reused group", async () => {
  const child = new FakeSupervisor();
  const signals = [];
  let cleaned = false;
  child.onCleanup = () => {
    cleaned = true;
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  };
  const outcomePromise = runManagedCommand("node", ["lane"], {
    killProcess: (pid, signal) => {
      if (signal === 0 && cleaned)
        throw Object.assign(new Error("missing group"), { code: "ESRCH" });
      signals.push({ pid, signal });
    },
    maximumDurationMs: 500,
    platform: "linux",
    snapshotProcesses: async () =>
      Object.freeze([
        Object.freeze({
          identity: "999:Mon Aug 10 00:00:00 2026",
          parentPid: 1,
          pid: 999,
          processGroupId: 123,
        }),
      ]),
    spawnProcess: () => child,
    stdio: "ignore",
    terminationGraceMs: 20,
  });
  const outcome = await outcomePromise;
  assert.match(outcome.error.message, /supervisor identity/u);
  assert.deepEqual(
    signals.filter((entry) => entry.signal !== 0),
    [],
  );
});

test("parent cancellation terminates the active tree and suppresses the second lane", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX process-group semantics");
  const controller = new AbortController();
  let calls = 0;
  setTimeout(() => controller.abort("SIGINT"), 60);
  const outcome = await runVitestLanePlan(createVitestLanePlan({ available: 2 }), async () => {
    calls += 1;
    return runManagedCommand(process.execPath, ["--eval", "setInterval(()=>{},1_000)"], {
      maximumDurationMs: 2_000,
      signal: controller.signal,
      stdio: "ignore",
      terminationGraceMs: 50,
    });
  });
  assert.equal(calls, 1);
  assert.match(outcome.error.message, /cancelled/u);
});

test("managed command reports spawn failure, normal exit, and child signal exactly", async (context) => {
  const missing = await runManagedCommand(path.join(tmpdir(), "missing-svetovid-executable"), [], {
    maximumDurationMs: 500,
    stdio: "ignore",
  });
  assert.ok(missing.error);
  assert.equal(missing.status, null);

  const exited = await runManagedCommand(process.execPath, ["--eval", "process.exit(7)"], {
    maximumDurationMs: 500,
    stdio: "ignore",
  });
  assert.equal(exited.error, undefined);
  assert.equal(exited.status, 7);

  if (process.platform === "win32") return context.skip("POSIX child signal identity");
  const signalled = await runManagedCommand(
    process.execPath,
    ["--eval", "process.kill(process.pid,'SIGTERM')"],
    { maximumDurationMs: 500, stdio: "ignore" },
  );
  assert.equal(signalled.error, undefined);
  assert.equal(signalled.signal, "SIGTERM");
  assert.equal(signalled.status, null);
});

test("parent signal listeners abort once and are removed", () => {
  const target = new EventEmitter();
  const controller = new AbortController();
  const remove = installParentCancellation(target, controller);
  target.emit("SIGTERM");
  assert.equal(controller.signal.reason, "SIGTERM");
  remove();
  assert.equal(target.listenerCount("SIGINT"), 0);
  assert.equal(target.listenerCount("SIGTERM"), 0);
});

test("Windows cleanup invokes the bounded trusted taskkill tree strategy", async () => {
  const calls = [];
  class FakeChild extends EventEmitter {
    pid = 4321;
    kill() {}
    send() {
      queueMicrotask(() =>
        this.emit("message", {
          kind: "lane-result",
          signal: null,
          spawnFailed: false,
          status: 0,
        }),
      );
    }
  }
  const lane = new FakeChild();
  const killer = new FakeChild();
  const spawnProcess = (executable, argumentsValue, options) => {
    calls.push({ argumentsValue, executable, options });
    if (calls.length === 1) return lane;
    queueMicrotask(() => killer.emit("close", 0, null));
    return killer;
  };
  const executable = "C:\\Windows\\System32\\taskkill.exe";
  const outcome = await runManagedCommand("node.exe", ["lane"], {
    env: { SystemRoot: "C:\\Windows" },
    maximumDurationMs: 500,
    platform: "win32",
    spawnProcess,
    stdio: "ignore",
    terminationGraceMs: 50,
    windowsTaskkillExecutable: executable,
  });
  assert.equal(outcome.status, 0);
  assert.equal(calls[1].executable, executable);
  assert.deepEqual(calls[1].argumentsValue, ["/PID", "4321", "/T", "/F"]);
  assert.equal(calls[1].options.shell, false);
  assert.ok(calls[0].options.stdio.includes("ipc"));
});

test("Windows supervisor loss suppresses taskkill reuse and the next lane", async () => {
  let laneCalls = 0;
  let spawnCalls = 0;
  class LostSupervisor extends EventEmitter {
    pid = 4321;
    send() {
      queueMicrotask(() => {
        this.emit("message", {
          kind: "lane-result",
          signal: null,
          spawnFailed: false,
          status: 0,
        });
        this.emit("close", 0, null);
      });
    }
  }
  const outcome = await runVitestLanePlan(createVitestLanePlan({ available: 2 }), async () => {
    laneCalls += 1;
    return runManagedCommand("node.exe", ["lane"], {
      env: { SystemRoot: "C:\\Windows" },
      maximumDurationMs: 500,
      platform: "win32",
      spawnProcess: () => {
        spawnCalls += 1;
        return new LostSupervisor();
      },
      stdio: "ignore",
      terminationGraceMs: 50,
      windowsTaskkillExecutable: "C:\\Windows\\System32\\taskkill.exe",
    });
  });
  assert.equal(laneCalls, 1);
  assert.equal(spawnCalls, 1);
  assert.match(outcome.error.message, /supervisor exited/u);
});

test("Windows cleanup failure overrides a successful leader and suppresses lane two", async () => {
  let laneCalls = 0;
  class FakeChild extends EventEmitter {
    pid = 7654;
    kill() {}
    send() {
      queueMicrotask(() =>
        this.emit("message", {
          kind: "lane-result",
          signal: null,
          spawnFailed: false,
          status: 0,
        }),
      );
    }
  }
  const spawnProcess = (_executable, _argumentsValue, options) => {
    const child = new FakeChild();
    if (!options.stdio.includes?.("ipc")) queueMicrotask(() => child.emit("close", 1, null));
    return child;
  };
  const outcome = await runVitestLanePlan(createVitestLanePlan({ available: 2 }), async () => {
    laneCalls += 1;
    return runManagedCommand("node.exe", ["lane"], {
      env: { SystemRoot: "C:\\Windows" },
      maximumDurationMs: 500,
      platform: "win32",
      spawnProcess,
      stdio: "ignore",
      terminationGraceMs: 50,
      windowsTaskkillExecutable: "C:\\Windows\\System32\\taskkill.exe",
    });
  });
  assert.equal(laneCalls, 1);
  assert.match(outcome.error.message, /did not confirm/u);
});

test("Windows waits for taskkill close after forced helper termination and fails closed", async () => {
  class FakeChild extends EventEmitter {
    pid = 8765;
    send() {
      queueMicrotask(() =>
        this.emit("message", {
          kind: "lane-result",
          signal: null,
          spawnFailed: false,
          status: 0,
        }),
      );
    }
    kill() {
      setTimeout(() => this.emit("close", null, "SIGKILL"), 2);
    }
  }
  const lane = new FakeChild();
  let calls = 0;
  const outcome = await runManagedCommand("node.exe", ["lane"], {
    env: { SystemRoot: "C:\\Windows" },
    maximumDurationMs: 500,
    platform: "win32",
    spawnProcess: () => {
      calls += 1;
      return calls === 1 ? lane : new FakeChild();
    },
    stdio: "ignore",
    terminationGraceMs: 60,
    windowsTaskkillExecutable: "C:\\Windows\\System32\\taskkill.exe",
  });
  assert.match(outcome.error.message, /did not confirm/u);
});

test("grandchild fixture is not accidentally readable before creation", async () => {
  // Negative control for the marker assertion above: readFile rejects absent files.
  await assert.rejects(readFile(path.join(tmpdir(), "svetovid-never-created-marker")));
});
