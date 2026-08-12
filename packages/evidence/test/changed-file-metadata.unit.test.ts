import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  CHANGED_FILE_METADATA_LIMITS,
  collectGitChangedFileMetadata,
  createChangedFileScanScope,
  createGitMetadataCapability,
  enumerateTrackedFilesFromGitChangedFileMetadata,
  forceGitChangedFileMetadataFallback,
  isValidGitBaseReference,
  isIssuedChangedFileScanScopeForRepositorySelection,
  isIssuedGitChangedFileMetadata,
  reconcileGitChangedFileMetadata,
  type GitMetadataExecutor,
  type GitMetadataCapability,
  type GitMetadataRequest,
  type GitMetadataResponse,
} from "../src/changed-file-metadata.js";
import { selectRepositoryRoot } from "../src/repository-root.js";

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const MERGE = "3".repeat(40);
function emptyIndex(version: 2 | 3 = 2): Uint8Array {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "ascii");
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(0, 8);
  return Buffer.concat([header, createHash("sha1").update(header).digest()]);
}

const EMPTY_INDEX = emptyIndex();
const EMPTY_INDEX_SHA256 = createHash("sha256").update(EMPTY_INDEX).digest("hex");
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const REPOSITORY_SELECTION = await selectRepositoryRoot(process.cwd(), { mode: "explicit" });

function capability(executor: GitMetadataExecutor): GitMetadataCapability {
  return createGitMetadataCapability(createChangedFileScanScope(REPOSITORY_SELECTION), executor);
}

function response(stdout: string | Uint8Array, exitCode = 0): GitMetadataResponse {
  return {
    exitCode,
    stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout,
  };
}

function successfulExecutor(
  diff: Uint8Array = Buffer.from("M\0src/main.ts\0A\0AGENTS.md\0"),
  indexState: string | Uint8Array = EMPTY_INDEX,
  worktreeState: string | Uint8Array = "",
): {
  readonly executor: GitMetadataExecutor;
  readonly requests: GitMetadataRequest[];
} {
  const requests: GitMetadataRequest[] = [];
  const outputs = [
    response(`${HEAD}\n`),
    response(`${BASE}\n`),
    response(`${MERGE}\n`),
    response(diff),
    response(indexState),
    response(worktreeState),
    response(`${HEAD}\n`),
  ];
  const executor: GitMetadataExecutor = (request) => {
    requests.push(request);
    return outputs[requests.length - 1] ?? response("", 1);
  };
  return { executor, requests };
}

describe("I07 Git changed-file metadata boundary", () => {
  it("issues deterministic merge-base metadata through a hermetic read-only request sequence", async () => {
    const fixture = successfulExecutor();
    const result = await collectGitChangedFileMetadata(capability(fixture.executor), {
      baseReference: "origin/main",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      baseCommit: BASE,
      baseReference: "origin/main",
      changes: [
        { path: "AGENTS.md", previousPath: null, status: "added" },
        { path: "src/main.ts", previousPath: null, status: "modified" },
      ],
      contractVersion: "0.1.0",
      headCommit: HEAD,
      indexObjectFormat: "sha1",
      indexStateSha256: EMPTY_INDEX_SHA256,
      indexVersion: 2,
      mergeBase: MERGE,
      recordKind: "agent-context-git-changed-file-metadata",
      state: "ready",
      trackedPaths: [],
      worktreeStateSha256: EMPTY_SHA256,
    });
    expect(fixture.requests.map(({ kind }) => kind)).toEqual([
      "resolve-head",
      "resolve-base",
      "merge-bases",
      "diff",
      "index-state",
      "worktree-state",
      "resolve-head",
    ]);
    expect(fixture.requests[1]?.arguments).toEqual([
      "rev-parse",
      "--verify",
      "--end-of-options",
      "origin/main^{commit}",
    ]);
    expect(fixture.requests[2]?.arguments).toEqual(["merge-base", "--all", BASE, HEAD]);
    expect(fixture.requests[3]?.arguments).toEqual([
      "diff-index",
      "--cached",
      "--name-status",
      "-z",
      "--no-renames",
      MERGE,
      "--",
    ]);
    expect(fixture.requests[4]?.arguments).toEqual(["read-index"]);
    expect(fixture.requests[5]?.arguments).toEqual(["read-worktree-state"]);
    expect(fixture.requests[6]?.arguments).toEqual(["rev-parse", "--verify", "HEAD^{commit}"]);
    for (const request of fixture.requests) {
      expect(request.policy).toEqual({
        disableGlobalConfiguration: true,
        disableSystemConfiguration: true,
        environment: {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
        },
        inheritEnvironment: false,
        maximumDurationMs: CHANGED_FILE_METADATA_LIMITS.maximumCommandDurationMs,
        network: "denied",
        repositoryWrites: "denied",
      });
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.arguments)).toBe(true);
      expect(Object.isFrozen(request.policy.environment)).toBe(true);
    }
    expect(isIssuedGitChangedFileMetadata(result)).toBe(true);
    expect(isIssuedGitChangedFileMetadata(structuredClone(result))).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects an option-looking leading-dash ref before issuing any command", async () => {
    const fixture = successfulExecutor();
    const result = await collectGitChangedFileMetadata(capability(fixture.executor), {
      baseReference: "-hostile-ref",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ reason: "invalid-base-reference", state: "fallback" });
    expect(fixture.requests).toEqual([]);
  });

  it("rejects control, bidi, surrogate, and byte-oversized base references", () => {
    expect(isValidGitBaseReference("main")).toBe(true);
    expect(isValidGitBaseReference("main😀")).toBe(true);
    for (const value of [
      "",
      "main\u0000hidden",
      "main\u007fhidden",
      "main\u061chidden",
      "main\u200ehidden",
      "main\u202ahidden",
      "main\u2066hidden",
      `main${String.fromCharCode(0xdc00)}`,
      `main${String.fromCharCode(0xd800)}x`,
      "😀".repeat(CHANGED_FILE_METADATA_LIMITS.maximumBaseReferenceBytes / 2 + 1),
    ]) {
      expect(isValidGitBaseReference(value)).toBe(false);
    }
  });

  it("binds issued scan scopes to the exact repository selection identity", () => {
    const scope = createChangedFileScanScope(REPOSITORY_SELECTION);
    expect(isIssuedChangedFileScanScopeForRepositorySelection(scope, REPOSITORY_SELECTION)).toBe(
      true,
    );
    expect(isIssuedChangedFileScanScopeForRepositorySelection(null, REPOSITORY_SELECTION)).toBe(
      false,
    );
    expect(isIssuedChangedFileScanScopeForRepositorySelection(scope, {})).toBe(false);
    expect(() => createGitMetadataCapability({} as never, vi.fn())).toThrow(TypeError);
  });

  it("reuses byte-equivalent ready metadata issued for one scan scope", async () => {
    const scope = createChangedFileScanScope(REPOSITORY_SELECTION);
    const beforeFixture = successfulExecutor();
    const afterFixture = successfulExecutor();
    const before = await collectGitChangedFileMetadata(
      createGitMetadataCapability(scope, beforeFixture.executor),
      { baseReference: "main", signal: new AbortController().signal },
    );
    const after = await collectGitChangedFileMetadata(
      createGitMetadataCapability(scope, afterFixture.executor),
      { baseReference: "main", signal: new AbortController().signal },
    );

    expect(reconcileGitChangedFileMetadata(scope, before, after)).toBe(after);
  });

  it("fails closed when ready and fallback metadata differ across the scan interval", async () => {
    const scope = createChangedFileScanScope(REPOSITORY_SELECTION);
    const readyFixture = successfulExecutor();
    const before = await collectGitChangedFileMetadata(
      createGitMetadataCapability(scope, readyFixture.executor),
      { baseReference: "main", signal: new AbortController().signal },
    );
    const after = await collectGitChangedFileMetadata(
      createGitMetadataCapability(scope, () => response("", 1)),
      { baseReference: "main", signal: new AbortController().signal },
    );

    expect(reconcileGitChangedFileMetadata(scope, before, after)).toMatchObject({
      baseReference: "main",
      reason: "repository-changed",
      state: "fallback",
    });
  });

  it("fails closed when changed content or index state drifts with the same path set", async () => {
    const scope = createChangedFileScanScope(REPOSITORY_SELECTION);
    for (const [beforeFixture, afterFixture] of [
      [
        successfulExecutor(undefined, EMPTY_INDEX, "worktree-v2"),
        successfulExecutor(undefined, EMPTY_INDEX, "worktree-v3"),
      ],
      [
        successfulExecutor(undefined, emptyIndex(2), "worktree-v2"),
        successfulExecutor(undefined, emptyIndex(3), "worktree-v2"),
      ],
    ] as const) {
      const before = await collectGitChangedFileMetadata(
        createGitMetadataCapability(scope, beforeFixture.executor),
        { baseReference: "main", signal: new AbortController().signal },
      );
      const after = await collectGitChangedFileMetadata(
        createGitMetadataCapability(scope, afterFixture.executor),
        { baseReference: "main", signal: new AbortController().signal },
      );
      expect(reconcileGitChangedFileMetadata(scope, before, after)).toMatchObject({
        reason: "repository-changed",
        state: "fallback",
      });
    }
  });

  it("reuses the second issued fallback when the failure reason remains stable", async () => {
    const scope = createChangedFileScanScope(REPOSITORY_SELECTION);
    const before = await collectGitChangedFileMetadata(
      createGitMetadataCapability(scope, () => response("", 1)),
      { baseReference: "main", signal: new AbortController().signal },
    );
    const after = await collectGitChangedFileMetadata(
      createGitMetadataCapability(scope, () => response("", 1)),
      { baseReference: "main", signal: new AbortController().signal },
    );

    expect(reconcileGitChangedFileMetadata(scope, before, after)).toBe(after);
  });

  it("rejects forged and cross-scope metadata during reconciliation", async () => {
    const scope = createChangedFileScanScope(REPOSITORY_SELECTION);
    const otherScope = createChangedFileScanScope(REPOSITORY_SELECTION);
    const firstFixture = successfulExecutor();
    const otherFixture = successfulExecutor();
    const first = await collectGitChangedFileMetadata(
      createGitMetadataCapability(scope, firstFixture.executor),
      { baseReference: "main", signal: new AbortController().signal },
    );
    const other = await collectGitChangedFileMetadata(
      createGitMetadataCapability(otherScope, otherFixture.executor),
      { baseReference: "main", signal: new AbortController().signal },
    );

    expect(() => reconcileGitChangedFileMetadata(scope, first, structuredClone(first))).toThrow(
      TypeError,
    );
    expect(() => reconcileGitChangedFileMetadata(scope, first, other)).toThrow(TypeError);
  });

  it("parses copy, delete, rename, type, and scored statuses without path quoting", async () => {
    const fixture = successfulExecutor(
      Buffer.from("C87\0old.ts\0copy.ts\0D\0gone.ts\0R100\0before.ts\0after.ts\0T\0link.ts\0"),
    );
    const result = await collectGitChangedFileMetadata(capability(fixture.executor), {
      baseReference: "main",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      changes: [
        { path: "after.ts", previousPath: "before.ts", status: "renamed" },
        { path: "copy.ts", previousPath: "old.ts", status: "copied" },
        { path: "gone.ts", previousPath: null, status: "deleted" },
        { path: "link.ts", previousPath: null, status: "type-changed" },
      ],
      state: "ready",
    });
  });

  it.each([
    [Buffer.from(`${MERGE}\n${"4".repeat(40)}\n`), "multiple-merge-bases"],
    [Buffer.from(""), "no-merge-base"],
    [Buffer.from(MERGE), "invalid-command-output"],
    [Buffer.from("not-an-object\n"), "invalid-command-output"],
  ] as const)("falls back for unsafe merge-base output", async (mergeOutput, reason) => {
    let call = 0;
    const authority = capability(() => {
      call += 1;
      return (
        [response(`${HEAD}\n`), response(`${BASE}\n`), response(mergeOutput)][call - 1] ??
        response("")
      );
    });
    await expect(
      collectGitChangedFileMetadata(authority, {
        baseReference: "main",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ reason, state: "fallback" });
  });

  it.each([
    [Buffer.from("U\0conflict.ts\0"), "unsupported-change-state"],
    [Buffer.from("M\0unterminated"), "invalid-command-output"],
    [Buffer.from("M\0../escape\0"), "invalid-command-output"],
    [Buffer.from("M\0.git/config\0"), "invalid-command-output"],
    [Buffer.from([0x4d, 0, 0xff, 0]), "invalid-command-output"],
    [Buffer.from([0xc1, 0, 0x78, 0]), "invalid-command-output"],
    [Buffer.from("M\0same.ts\0M\0same.ts\0"), "invalid-command-output"],
    [Buffer.from("A1\0scored.ts\0"), "unsupported-change-state"],
    [Buffer.from("R101\0old.ts\0new.ts\0"), "unsupported-change-state"],
    [Buffer.from("R100\0old.ts\0new.ts\0M\0old.ts\0"), "invalid-command-output"],
  ] as const)("falls back for hostile NUL diff data", async (diff, reason) => {
    const fixture = successfulExecutor(diff);
    await expect(
      collectGitChangedFileMetadata(capability(fixture.executor), {
        baseReference: "main",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ reason, state: "fallback" });
  });

  it("bounds refs, command output, path counts, cancellation, and command failure", async () => {
    const signal = new AbortController();
    signal.abort();
    const never = vi.fn();
    await expect(
      collectGitChangedFileMetadata(capability(never), {
        baseReference: "main",
        signal: signal.signal,
      }),
    ).resolves.toMatchObject({ reason: "cancelled", state: "fallback" });
    expect(never).not.toHaveBeenCalled();

    const overRef = successfulExecutor();
    await expect(
      collectGitChangedFileMetadata(capability(overRef.executor), {
        baseReference: "x".repeat(CHANGED_FILE_METADATA_LIMITS.maximumBaseReferenceBytes + 1),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ reason: "invalid-base-reference", state: "fallback" });
    expect(overRef.requests).toEqual([]);

    for (const invalidReference of ["main\nother", String.fromCharCode(0xd800)]) {
      const invalid = successfulExecutor();
      await expect(
        collectGitChangedFileMetadata(capability(invalid.executor), {
          baseReference: invalidReference,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ reason: "invalid-base-reference", state: "fallback" });
      expect(invalid.requests).toEqual([]);
    }

    const failure = capability(() => response("private stderr data", 1));
    const failed = await collectGitChangedFileMetadata(failure, {
      baseReference: "private-ref",
      signal: new AbortController().signal,
    });
    expect(failed).toMatchObject({ reason: "command-failed", state: "fallback" });
    expect(JSON.stringify(failed)).not.toContain("stderr");
    expect(JSON.stringify(failed)).not.toContain("private-ref^{commit}");
  });

  it("issues an explicit conservative fallback for a relevant untracked scan path", async () => {
    const scope = createChangedFileScanScope(REPOSITORY_SELECTION);
    const fixture = successfulExecutor();
    const metadata = await collectGitChangedFileMetadata(
      createGitMetadataCapability(scope, fixture.executor),
      { baseReference: "main", signal: new AbortController().signal },
    );
    expect(forceGitChangedFileMetadataFallback(scope, metadata, "untracked-files")).toMatchObject({
      reason: "untracked-files",
      state: "fallback",
    });
  });

  it("only enumerates tracked paths from ready metadata issued for the same scope", async () => {
    const scope = createChangedFileScanScope(REPOSITORY_SELECTION);
    const fixture = successfulExecutor();
    const metadata = await collectGitChangedFileMetadata(
      createGitMetadataCapability(scope, fixture.executor),
      { baseReference: "main", signal: new AbortController().signal },
    );
    expect(enumerateTrackedFilesFromGitChangedFileMetadata(scope, metadata)).toMatchObject({
      certainty: "tracked",
      indexObjectFormat: "sha1",
      indexVersion: 2,
      paths: [],
      source: "git-index",
    });

    const otherScope = createChangedFileScanScope(REPOSITORY_SELECTION);
    expect(() => enumerateTrackedFilesFromGitChangedFileMetadata(otherScope, metadata)).toThrow(
      TypeError,
    );
    const fallbackMetadata = forceGitChangedFileMetadataFallback(
      scope,
      metadata,
      "untracked-files",
    );
    expect(() => enumerateTrackedFilesFromGitChangedFileMetadata(scope, fallbackMetadata)).toThrow(
      TypeError,
    );
    expect(() =>
      forceGitChangedFileMetadataFallback(otherScope, metadata, "untracked-files"),
    ).toThrow(TypeError);
  });

  it.each([
    [0, "command-failed"],
    [1, "command-failed"],
    [2, "command-failed"],
    [3, "command-failed"],
    [4, "command-failed"],
    [5, "command-failed"],
    [6, "command-failed"],
  ] as const)(
    "fails closed when command phase %i exits unsuccessfully",
    async (failedAt, reason) => {
      const fixture = successfulExecutor();
      const executor: GitMetadataExecutor = (request, signal) => {
        const index = fixture.requests.length;
        if (index === failedAt) {
          fixture.requests.push(request);
          return response("untrusted diagnostic", 128);
        }
        return fixture.executor(request, signal);
      };
      await expect(
        collectGitChangedFileMetadata(capability(executor), {
          baseReference: "main",
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ reason, state: "fallback" });
      expect(fixture.requests).toHaveLength(failedAt + 1);
    },
  );

  it.each([
    [0, response(`${HEAD}\r\n`)],
    [1, response(`${BASE}\nextra\n`)],
    [2, response(`${MERGE}\r\n`)],
    [3, response("R100\0same.ts\0same.ts\0")],
    [4, response("not-an-index")],
    [6, response(`${HEAD}\nextra\n`)],
  ] as const)("rejects malformed output from command phase %i", async (malformedAt, malformed) => {
    const fixture = successfulExecutor();
    const executor: GitMetadataExecutor = (request, signal) => {
      const index = fixture.requests.length;
      if (index === malformedAt) {
        fixture.requests.push(request);
        return malformed;
      }
      return fixture.executor(request, signal);
    };
    await expect(
      collectGitChangedFileMetadata(capability(executor), {
        baseReference: "main",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ reason: "invalid-command-output", state: "fallback" });
  });

  it.each([
    null,
    { exitCode: 0 },
    { exitCode: 0.5, stdout: new Uint8Array() },
    { exitCode: 0, stdout: "not bytes" },
    Object.assign(Object.create(null), { exitCode: 0, stdout: new Uint8Array() }),
    { exitCode: 0, stdout: new Proxy(new Uint8Array(), {}) },
  ])("rejects malformed trusted-executor responses", async (malformed) => {
    await expect(
      collectGitChangedFileMetadata(
        capability(() => malformed as never),
        {
          baseReference: "main",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({ reason: "command-failed", state: "fallback" });
  });

  it.each([0, 1, 2, 3, 4, 5, 6])(
    "maps a rejected trusted command at phase %i to a bounded fallback",
    async (rejectedAt) => {
      const fixture = successfulExecutor();
      const executor: GitMetadataExecutor = (request, signal) => {
        const index = fixture.requests.length;
        if (index === rejectedAt) {
          fixture.requests.push(request);
          return Promise.reject(new Error("untrusted failure detail"));
        }
        return fixture.executor(request, signal);
      };
      await expect(
        collectGitChangedFileMetadata(capability(executor), {
          baseReference: "main",
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ reason: "command-failed", state: "fallback" });
      expect(fixture.requests).toHaveLength(rejectedAt + 1);
    },
  );

  it.each([
    Buffer.from("M\0\0"),
    Buffer.from("M\0trailing/\0"),
    Buffer.from("M\0back\\slash\0"),
    Buffer.from("R100\0old.ts\0new.ts\0A\0old.ts\0"),
  ])("rejects empty, non-canonical, and colliding diff paths", async (diff) => {
    const fixture = successfulExecutor(diff);
    await expect(
      collectGitChangedFileMetadata(capability(fixture.executor), {
        baseReference: "main",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ reason: "invalid-command-output", state: "fallback" });
  });

  it("accepts an empty diff and rejects non-canonical line termination and prior-path collisions", async () => {
    const empty = successfulExecutor(new Uint8Array());
    await expect(
      collectGitChangedFileMetadata(capability(empty.executor), {
        baseReference: "main",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ changes: [], state: "ready" });

    for (const [phase, output] of [
      [2, response(`${MERGE}\n\n`)],
      [3, response("M\0a.ts\0R100\0a.ts\0z.ts\0")],
    ] as const) {
      const fixture = successfulExecutor();
      const executor: GitMetadataExecutor = (request, signal) => {
        const index = fixture.requests.length;
        if (index === phase) {
          fixture.requests.push(request);
          return output;
        }
        return fixture.executor(request, signal);
      };
      await expect(
        collectGitChangedFileMetadata(capability(executor), {
          baseReference: "main",
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ reason: "invalid-command-output", state: "fallback" });
    }
  });

  it("rejects unissued authority and invalid AbortSignal records", async () => {
    await expect(
      collectGitChangedFileMetadata({} as GitMetadataCapability, {
        baseReference: "main",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("capability is not issued");

    const invalidSignal = Object.create(AbortSignal.prototype) as AbortSignal;
    const executor = vi.fn<GitMetadataExecutor>();
    await expect(
      collectGitChangedFileMetadata(capability(executor), {
        baseReference: "main",
        signal: invalidSignal,
      }),
    ).resolves.toMatchObject({ reason: "command-failed", state: "fallback" });
    expect(executor).not.toHaveBeenCalled();

    await expect(
      collectGitChangedFileMetadata(capability(executor), {
        baseReference: "main",
        signal: {} as AbortSignal,
      }),
    ).resolves.toMatchObject({ reason: "command-failed", state: "fallback" });
  });

  it("rejects a concurrent HEAD move after the content and index snapshot", async () => {
    const movedHead = "9".repeat(40);
    const outputs = [
      response(`${HEAD}\n`),
      response(`${BASE}\n`),
      response(`${MERGE}\n`),
      response("M\0src/main.ts\0"),
      response(EMPTY_INDEX),
      response(""),
      response(`${movedHead}\n`),
    ];
    let call = 0;
    await expect(
      collectGitChangedFileMetadata(
        capability(() => {
          const output = outputs[call];
          call += 1;
          return output ?? response("", 1);
        }),
        { baseReference: "main", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ reason: "repository-changed", state: "fallback" });
  });

  it("settles cancellation even when the trusted executor ignores its signal", async () => {
    const controller = new AbortController();
    const pending = collectGitChangedFileMetadata(
      capability(() => new Promise(() => undefined)),
      { baseReference: "main", signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ reason: "cancelled", state: "fallback" });
  });

  it("settles the command deadline when the trusted executor never resolves", async () => {
    vi.useFakeTimers();
    try {
      const pending = collectGitChangedFileMetadata(
        capability(() => new Promise(() => undefined)),
        { baseReference: "main", signal: new AbortController().signal },
      );
      await vi.advanceTimersByTimeAsync(CHANGED_FILE_METADATA_LIMITS.maximumCommandDurationMs);
      await expect(pending).resolves.toMatchObject({ reason: "command-failed", state: "fallback" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    `${"a".repeat(39)}\n`,
    `${"a".repeat(41)}\n`,
    `${"a".repeat(63)}\n`,
    `${"a".repeat(65)}\n`,
    HEAD,
    `${HEAD} \n`,
    `${HEAD}\n\n`,
  ])("requires canonical exact-width object IDs", async (headOutput) => {
    const authority = capability(() => response(headOutput));
    await expect(
      collectGitChangedFileMetadata(authority, {
        baseReference: "main",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ reason: "invalid-command-output", state: "fallback" });
  });

  it("rejects mixed SHA-1 and SHA-256 object evidence before diff", async () => {
    const requests: GitMetadataRequest[] = [];
    const outputs = [
      response(`${HEAD}\n`),
      response(`${"b".repeat(64)}\n`),
      response(`${MERGE}\n`),
    ];
    const result = await collectGitChangedFileMetadata(
      capability((request) => {
        requests.push(request);
        return outputs[requests.length - 1] ?? response("", 1);
      }),
      { baseReference: "main", signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ reason: "invalid-command-output", state: "fallback" });
    expect(requests.map(({ kind }) => kind)).toEqual([
      "resolve-head",
      "resolve-base",
      "merge-bases",
    ]);
  });

  it("rejects hostile capabilities, responses, and input records without executing getters", async () => {
    expect(() =>
      createGitMetadataCapability(
        createChangedFileScanScope(REPOSITORY_SELECTION),
        new Proxy(vi.fn(), {}),
      ),
    ).toThrow(TypeError);
    expect(() => createChangedFileScanScope(structuredClone(REPOSITORY_SELECTION))).toThrow(
      TypeError,
    );
    const getter = vi.fn(() => "main");
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "baseReference", { enumerable: true, get: getter });
    Object.defineProperty(input, "signal", {
      enumerable: true,
      value: new AbortController().signal,
    });
    const executor = vi.fn(() => new Proxy(response(`${HEAD}\n`), {}));
    await expect(
      collectGitChangedFileMetadata(capability(executor), input as never),
    ).resolves.toMatchObject({ reason: "command-failed", state: "fallback" });
    expect(getter).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });
});
