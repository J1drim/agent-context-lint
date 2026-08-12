import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "@agent-context/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BOUNDED_RESOLUTION_CONTRACT_VERSION,
  BOUNDED_RESOLUTION_HARD_LIMITS,
  BOUNDED_RESOLUTION_RECORD_KIND,
  BoundedResolutionError,
  BoundedResolutionErrorCode,
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  createEffectiveContextResolutionTask,
  isIssuedBoundedResolutionResult,
  resolveCodexCliAgents,
  resolveEffectiveContext,
  resolveEffectiveContextsBounded,
  type EffectiveContextResolution,
  type EffectiveContextResolutionTask,
} from "../src/index.js";

const encoder = new TextEncoder();

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function resolution(
  targetPath: RepositoryRelativePath,
  content = "Root policy.\n",
): EffectiveContextResolution {
  const profile = resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: [
        {
          bytes: encoder.encode(content),
          errorCode: null,
          kind: "file",
          path: path("AGENTS.md"),
          resolvedTarget: null,
        },
      ],
      reason: "complete E10 fixture",
      rootMarkerPaths: [path(".git")],
    },
    externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("."),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath,
  });
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution: profile,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath,
  });
}

function task(
  id: string,
  result: EffectiveContextResolution,
  executor: (
    signal: AbortSignal,
  ) => EffectiveContextResolution | Promise<EffectiveContextResolution> = () => result,
): EffectiveContextResolutionTask {
  return createEffectiveContextResolutionTask(
    {
      clientVersion: result.clientVersion,
      id,
      profileId: result.profileId,
      profileVersion: result.profileVersion,
      specSnapshotId: result.specSnapshotId,
      surfaceId: result.surfaceId,
      targetPath: result.targetPath,
    },
    executor,
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value): void {
      resolvePromise?.(value);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("E10 bounded effective-context resolution", () => {
  test("emits byte-identical stable output across input order, latency, and concurrency", async () => {
    const values = [path("z.ts"), path("a.ts"), path("src/m.ts")].map((target, index) =>
      resolution(target, `Policy ${String(index)}.\n`),
    );
    const delayed = values.map((result, index) =>
      task(`task-${String(index)}`, result, async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, (2 - index) * 2));
        return result;
      }),
    );
    const serial = await resolveEffectiveContextsBounded([...delayed].reverse(), {
      maximumConcurrency: 1,
    });
    const parallel = await resolveEffectiveContextsBounded(delayed, { maximumConcurrency: 3 });

    expect(JSON.stringify(parallel)).toBe(JSON.stringify(serial));
    expect(parallel.entries.map((entry) => entry.resolution.targetPath)).toEqual([
      "a.ts",
      "src/m.ts",
      "z.ts",
    ]);
    expect(parallel).toMatchObject({
      contractVersion: BOUNDED_RESOLUTION_CONTRACT_VERSION,
      recordKind: BOUNDED_RESOLUTION_RECORD_KIND,
    });
  });

  test("stress-runs a large task set byte-identically at serial and maximum scheduling widths", async () => {
    const tasks = Array.from({ length: 128 }, (_, index) => {
      const result = resolution(path(`stress/file-${String(index).padStart(3, "0")}.ts`));
      return task(`stress-${String(index).padStart(3, "0")}`, result, async () => {
        for (let step = 0; step < index % 4; step += 1) await Promise.resolve();
        return result;
      });
    });
    const serial = await resolveEffectiveContextsBounded([...tasks].reverse(), {
      maximumConcurrency: 1,
    });
    const medium = await resolveEffectiveContextsBounded(
      [...tasks.slice(47), ...tasks.slice(0, 47)],
      { maximumConcurrency: 7 },
    );
    const maximum = await resolveEffectiveContextsBounded(tasks, {
      maximumConcurrency: BOUNDED_RESOLUTION_HARD_LIMITS.maximumConcurrency,
    });

    expect(serial.entries).toHaveLength(128);
    expect(JSON.stringify(medium)).toBe(JSON.stringify(serial));
    expect(JSON.stringify(maximum)).toBe(JSON.stringify(serial));
  });

  test("starts work lazily and never exceeds the configured concurrency", async () => {
    const gates = Array.from({ length: 12 }, () => deferred<undefined>());
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const tasks = gates.map((gate, index) => {
      const result = resolution(path(`src/file-${String(index)}.ts`));
      return task(`task-${String(index).padStart(2, "0")}`, result, async () => {
        active += 1;
        started += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate.promise;
        active -= 1;
        return result;
      });
    });
    const pending = resolveEffectiveContextsBounded(tasks, { maximumConcurrency: 3 });
    await vi.waitFor(() => {
      expect(started).toBe(3);
    });
    expect(maximumActive).toBe(3);

    gates[0]?.resolve(undefined);
    await vi.waitFor(() => {
      expect(started).toBe(4);
    });
    for (const gate of gates) gate.resolve(undefined);
    const result = await pending;
    expect(result.entries).toHaveLength(12);
    expect(maximumActive).toBe(3);
    expect(active).toBe(0);
  });

  test("cancels before admission without invoking a task", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private reason"));
    const executor = vi.fn(() => resolution(path("a.ts")));
    const pending = resolveEffectiveContextsBounded(
      [task("a", resolution(path("a.ts")), executor)],
      { signal: controller.signal },
    );
    await expect(pending).rejects.toMatchObject({ code: BoundedResolutionErrorCode.cancelled });
    expect(executor).not.toHaveBeenCalled();
    await expect(pending).rejects.not.toThrow(/private reason/u);
  });

  test("propagates cancellation to active work and admits no queued work", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const seenSignals: AbortSignal[] = [];
    const tasks = Array.from({ length: 5 }, (_, index) => {
      const result = resolution(path(`src/${String(index)}.ts`));
      return task(`task-${String(index)}`, result, (signal) => {
        started.push(String(index));
        seenSignals.push(signal);
        return new Promise<EffectiveContextResolution>((resolveResult) => {
          signal.addEventListener(
            "abort",
            () => {
              resolveResult(result);
            },
            { once: true },
          );
        });
      });
    });
    const pending = resolveEffectiveContextsBounded(tasks, {
      maximumConcurrency: 2,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(started).toHaveLength(2);
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: BoundedResolutionErrorCode.cancelled });
    expect(started).toHaveLength(2);
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
  });

  test("bounds nonsettling work with a deadline and stops queue admission", async () => {
    vi.useFakeTimers();
    let started = 0;
    const tasks = Array.from({ length: 3 }, (_, index) => {
      const result = resolution(path(`${String(index)}.ts`));
      return task(`task-${String(index)}`, result, () => {
        started += 1;
        return new Promise<EffectiveContextResolution>(() => undefined);
      });
    });
    const pending = resolveEffectiveContextsBounded(tasks, {
      maximumConcurrency: 1,
      maximumDurationMs: 10,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: BoundedResolutionErrorCode.deadlineExceeded,
    });
    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    expect(started).toBe(1);
  });

  test("reports task failures by stable sorted indexes without reflecting thrown details", async () => {
    const good = resolution(path("m.ts"));
    const alpha = resolution(path("a.ts"));
    const zulu = resolution(path("z.ts"));
    const tasks = [
      task("z", zulu, async () => {
        await Promise.resolve();
        throw new Error("secret-zulu");
      }),
      task("m", good),
      task("a", alpha, () => {
        throw new Error("secret-alpha");
      }),
    ];
    let caught: unknown;
    try {
      await resolveEffectiveContextsBounded(tasks, { maximumConcurrency: 3 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: BoundedResolutionErrorCode.taskFailed,
      failedTaskIndexes: [0, 2],
    });
    expect(JSON.stringify(caught)).not.toMatch(/secret-alpha|secret-zulu/u);
  });

  test("rejects forged and mismatched task results deterministically", async () => {
    const first = resolution(path("a.ts"));
    const second = resolution(path("b.ts"));
    const forged = structuredClone(first);
    const forgedTask = task("a", first, () => forged);
    const mismatchedTask = task("b", second, () => first);

    await expect(
      resolveEffectiveContextsBounded([mismatchedTask, forgedTask], { maximumConcurrency: 2 }),
    ).rejects.toMatchObject({
      code: BoundedResolutionErrorCode.invalidRelationship,
      failedTaskIndexes: [0, 1],
    });
  });

  test("binds client, profile, and specification versions to the issued result", async () => {
    const result = resolution(path("a.ts"));
    const mismatched = createEffectiveContextResolutionTask(
      {
        clientVersion: result.clientVersion,
        id: "wrong-profile-version",
        profileId: result.profileId,
        profileVersion: "9.9.9",
        specSnapshotId: result.specSnapshotId,
        surfaceId: result.surfaceId,
        targetPath: result.targetPath,
      },
      () => result,
    );
    await expect(resolveEffectiveContextsBounded([mismatched])).rejects.toMatchObject({
      code: BoundedResolutionErrorCode.invalidRelationship,
      failedTaskIndexes: [0],
    });
  });

  test("returns an immutable issued empty result without starting a timer-bound task", async () => {
    const result = await resolveEffectiveContextsBounded([]);
    expect(isIssuedBoundedResolutionResult(result)).toBe(true);
    expect(isIssuedBoundedResolutionResult(structuredClone(result))).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(result.entries).toEqual([]);
  });

  test("freezes task and successful result containers", async () => {
    const resolved = resolution(path("src/main.ts"));
    const selected = task("one", resolved);
    const output = await resolveEffectiveContextsBounded([selected]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.entries)).toBe(true);
    expect(Object.isFrozen(output.entries[0])).toBe(true);
    expect(output.entries[0]?.resolution).toBe(resolved);
  });

  test("rejects duplicate ids and duplicate profile/surface/target relationships before execution", async () => {
    const firstResult = resolution(path("a.ts"));
    const secondResult = resolution(path("b.ts"));
    const executor = vi.fn(() => firstResult);
    const duplicateIds = [task("same", firstResult, executor), task("same", secondResult)];
    await expect(resolveEffectiveContextsBounded(duplicateIds)).rejects.toMatchObject({
      code: BoundedResolutionErrorCode.invalidRelationship,
    });
    expect(executor).not.toHaveBeenCalled();

    const duplicateRelationship = [task("one", firstResult), task("two", firstResult)];
    await expect(resolveEffectiveContextsBounded(duplicateRelationship)).rejects.toMatchObject({
      code: BoundedResolutionErrorCode.invalidRelationship,
    });
  });

  test("rejects forged, cloned, proxy, sparse, accessor, and extended task containers", async () => {
    const resolved = resolution(path("a.ts"));
    const selected = task("a", resolved);
    await expect(resolveEffectiveContextsBounded([structuredClone(selected)])).rejects.toThrow(
      BoundedResolutionError,
    );
    await expect(resolveEffectiveContextsBounded(new Proxy([], {}))).rejects.toThrow(
      BoundedResolutionError,
    );
    const sparse = new Array(2) as EffectiveContextResolutionTask[];
    sparse[0] = selected;
    await expect(resolveEffectiveContextsBounded(sparse)).rejects.toThrow(BoundedResolutionError);
    const accessor = [selected];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => selected });
    await expect(resolveEffectiveContextsBounded(accessor)).rejects.toThrow(BoundedResolutionError);
    const extended = [selected] as EffectiveContextResolutionTask[] & { extra?: boolean };
    extended.extra = true;
    await expect(resolveEffectiveContextsBounded(extended)).rejects.toThrow(BoundedResolutionError);
  });

  test("validates descriptor shape, canonical identities, text, and executor authority", () => {
    const resolved = resolution(path("a.ts"));
    const valid = {
      clientVersion: resolved.clientVersion,
      id: "a",
      profileId: resolved.profileId,
      profileVersion: resolved.profileVersion,
      specSnapshotId: resolved.specSnapshotId,
      surfaceId: resolved.surfaceId,
      targetPath: resolved.targetPath,
    };
    const invalid: unknown[] = [
      null,
      [],
      new Proxy({}, {}),
      { ...valid, extra: true },
      { ...valid, id: "" },
      { ...valid, id: "bad\u0000id" },
      { ...valid, id: "spoof\u202ename" },
      { ...valid, id: "\ud800" },
      { ...valid, id: "\udc00" },
      { ...valid, profileId: "invented" },
      { ...valid, clientVersion: 1 },
      { ...valid, profileVersion: "" },
      { ...valid, specSnapshotId: "" },
      { ...valid, surfaceId: "" },
      { ...valid, targetPath: "../escape" },
    ];
    for (const descriptor of invalid)
      expect(() => createEffectiveContextResolutionTask(descriptor, () => resolved)).toThrow(
        BoundedResolutionError,
      );

    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "id", { enumerable: true, get: () => "a" });
    expect(() => createEffectiveContextResolutionTask(accessor, () => resolved)).toThrow(
      BoundedResolutionError,
    );
    expect(() => createEffectiveContextResolutionTask(valid, null as never)).toThrow(
      BoundedResolutionError,
    );
    expect(() =>
      createEffectiveContextResolutionTask(valid, new Proxy(() => resolved, {})),
    ).toThrow(BoundedResolutionError);
  });

  test("enforces task-id and task-count resource limits before execution", async () => {
    const resolved = resolution(path("a.ts"));
    const longId = "x".repeat(513);
    const selected = createEffectiveContextResolutionTask(
      {
        clientVersion: resolved.clientVersion,
        id: longId,
        profileId: resolved.profileId,
        profileVersion: resolved.profileVersion,
        specSnapshotId: resolved.specSnapshotId,
        surfaceId: resolved.surfaceId,
        targetPath: resolved.targetPath,
      },
      () => resolved,
    );
    await expect(
      resolveEffectiveContextsBounded([selected], { maximumTaskIdBytes: 512 }),
    ).rejects.toMatchObject({ code: BoundedResolutionErrorCode.resourceLimit });
    await expect(
      resolveEffectiveContextsBounded([task("a", resolved), task("b", resolution(path("b.ts")))], {
        maximumTasks: 1,
      }),
    ).rejects.toMatchObject({ code: BoundedResolutionErrorCode.resourceLimit });
  });

  test("enforces per-result and aggregate result byte ceilings", async () => {
    const first = resolution(path("a.ts"));
    const second = resolution(path("b.ts"));
    let resourceSignal: AbortSignal | undefined;
    await expect(
      resolveEffectiveContextsBounded(
        [
          task("a", first, (signal) => {
            resourceSignal = signal;
            return first;
          }),
        ],
        {
          maximumResultBytes: 1,
          maximumTotalResultBytes: 1,
        },
      ),
    ).rejects.toMatchObject({
      code: BoundedResolutionErrorCode.resourceLimit,
      failedTaskIndexes: [],
    });
    expect(resourceSignal?.aborted).toBe(true);
    const firstBytes = Buffer.byteLength(JSON.stringify(first), "utf8");
    const secondBytes = Buffer.byteLength(JSON.stringify(second), "utf8");
    await expect(
      resolveEffectiveContextsBounded([task("a", first), task("b", second)], {
        maximumResultBytes: Math.max(firstBytes, secondBytes),
        maximumTotalResultBytes: firstBytes + secondBytes - 1,
      }),
    ).rejects.toMatchObject({
      code: BoundedResolutionErrorCode.resourceLimit,
      failedTaskIndexes: [],
    });
  });

  test("rejects malformed options, limits, relationships, and signals", async () => {
    const selected = task("a", resolution(path("a.ts")));
    const inherited = Object.create({ maximumConcurrency: 1 }) as Record<string, unknown>;
    const invalidOptions: unknown[] = [
      null,
      [],
      new Proxy({}, {}),
      inherited,
      { extra: 1 },
      { maximumConcurrency: 0 },
      { maximumConcurrency: 1.5 },
      { maximumConcurrency: BOUNDED_RESOLUTION_HARD_LIMITS.maximumConcurrency + 1 },
      { maximumDurationMs: -1 },
      { maximumResultBytes: 2, maximumTotalResultBytes: 1 },
      { signal: {} },
      { signal: new Proxy(new AbortController().signal, {}) },
    ];
    for (const options of invalidOptions)
      await expect(
        resolveEffectiveContextsBounded([selected], options as never),
      ).rejects.toMatchObject({ code: BoundedResolutionErrorCode.invalidOptions });

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "maximumConcurrency", { enumerable: true, get: () => 1 });
    await expect(resolveEffectiveContextsBounded([selected], accessor)).rejects.toMatchObject({
      code: BoundedResolutionErrorCode.invalidOptions,
    });
  });

  test("accepts explicit undefined signal and maximum hard concurrency", async () => {
    const selected = task("a", resolution(path("a.ts")));
    const output = await resolveEffectiveContextsBounded([selected], {
      maximumConcurrency: BOUNDED_RESOLUTION_HARD_LIMITS.maximumConcurrency,
      signal: undefined,
    });
    expect(output.entries).toHaveLength(1);
  });

  test("normalizes UTF-8 task order without locale dependence", async () => {
    const targets = [path("é.ts"), path("z.ts"), path("😀.ts")];
    const tasks = targets.map((target, index) => task(`id-${String(index)}`, resolution(target)));
    const output = await resolveEffectiveContextsBounded(tasks.reverse(), {
      maximumConcurrency: 2,
    });
    expect(output.entries.map((entry) => entry.resolution.targetPath)).toEqual(
      [...targets].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    );
  });
});
