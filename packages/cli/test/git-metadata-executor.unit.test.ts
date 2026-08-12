import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  collectGitChangedFileMetadata,
  createChangedFileScanScope,
  createGitMetadataCapability,
  selectRepositoryRoot,
  type GitChangedFileMetadata,
  type GitMetadataExecutionPolicy,
  type GitMetadataExecutor,
  type GitMetadataRequest,
} from "@agent-context/evidence";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  bindMetadataFileWithinForTest,
  createNodeGitMetadataExecutor,
  mapGitSpawnFailureForTest,
  OperationContext,
} from "../src/git-metadata-executor.js";
import * as productionFacade from "../src/git-metadata-executor-production.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const policy: GitMetadataExecutionPolicy = Object.freeze({
  disableGlobalConfiguration: true,
  disableSystemConfiguration: true,
  environment: Object.freeze({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  }),
  inheritEnvironment: false,
  maximumDurationMs: 30_000,
  network: "denied",
  repositoryWrites: "denied",
});

async function git(root: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...arguments_], {
    cwd: root,
    encoding: "utf8",
    env: {
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: process.env["PATH"],
    },
    shell: false,
  });
  return result.stdout.trim();
}

async function repository(): Promise<{ readonly base: string; readonly root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-context-i07-git-"));
  roots.push(root);
  await git(root, ["init", "--quiet"]);
  await writeFile(path.join(root, "AGENTS.md"), "# Policy\n", "utf8");
  await writeFile(path.join(root, "src.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(root, "component"), "regular\n", "utf8");
  await git(root, ["add", "--", "AGENTS.md", "component", "src.ts"]);
  await git(root, ["commit", "--quiet", "-m", "initial"]);
  return Object.freeze({ base: await git(root, ["rev-parse", "HEAD"]), root });
}

async function collect(
  root: string,
  base: string,
  maximumOutputBytes?: number,
): Promise<GitChangedFileMetadata> {
  const selection = await selectRepositoryRoot(root, {
    ceiling: root,
    mode: "discover",
  });
  const scope = createChangedFileScanScope(selection);
  const executor = await createNodeGitMetadataExecutor(selection, {
    ...(maximumOutputBytes === undefined ? {} : { maximumOutputBytes }),
  });
  return collectGitChangedFileMetadata(createGitMetadataCapability(scope, executor), {
    baseReference: base,
    signal: new AbortController().signal,
  });
}

function resolveHeadRequest(): GitMetadataRequest {
  return Object.freeze({
    arguments: Object.freeze(["rev-parse", "--verify", "HEAD^{commit}"]),
    kind: "resolve-head",
    policy,
  });
}

function resolveBaseRequest(base: string): GitMetadataRequest {
  return Object.freeze({
    arguments: Object.freeze(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]),
    kind: "resolve-base",
    policy,
  });
}

function diffRequest(base: string): GitMetadataRequest {
  return Object.freeze({
    arguments: Object.freeze([
      "diff-index",
      "--cached",
      "--name-status",
      "-z",
      "--no-renames",
      base,
      "--",
    ]),
    kind: "diff",
    policy,
  });
}

async function contentLedger(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    const names = await readdir(path.join(root, relative), { withFileTypes: true });
    names.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of names) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(path.join(root, child)))
          .digest("hex");
        output.push(`${child}\0${digest}`);
      } else output.push(`${child}\0special`);
    }
  };
  await visit("");
  return Object.freeze(output);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("I07 hermetic Node Git metadata executor", () => {
  test("keeps the lazy production facade limited to the real executor factory", () => {
    expect(Object.keys(productionFacade)).toEqual(["createNodeGitMetadataExecutor"]);
    expect(productionFacade.createNodeGitMetadataExecutor).toBe(createNodeGitMetadataExecutor);
  });

  test("collects committed, staged, and unstaged changes from one exact merge base", async () => {
    const state = await repository();
    await writeFile(path.join(state.root, "committed.ts"), "export {};\n", "utf8");
    await git(state.root, ["add", "--", "committed.ts"]);
    await git(state.root, ["commit", "--quiet", "-m", "committed change"]);
    await writeFile(path.join(state.root, "staged.ts"), "export {};\n", "utf8");
    await git(state.root, ["add", "--", "staged.ts"]);
    await writeFile(path.join(state.root, "src.ts"), "export const value = 2;\n", "utf8");

    const result = await collect(state.root, state.base);

    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.baseCommit).toBe(state.base);
    expect(result.mergeBase).toBe(state.base);
    expect(result.changes).toEqual([
      { path: "committed.ts", previousPath: null, status: "added" },
      { path: "src.ts", previousPath: null, status: "modified" },
      { path: "staged.ts", previousPath: null, status: "added" },
    ]);
  });

  test("falls back for symlink, gitlink, or other unsupported tracked file types", async () => {
    const state = await repository();
    await git(state.root, ["mv", "src.ts", "renamed.ts"]);
    await git(state.root, ["rm", "--quiet", "AGENTS.md"]);
    if (process.platform === "win32") {
      // Windows runners may not grant symlink creation. A Git gitlink is the platform-independent
      // submodule representation and still produces the exact `T` status under test.
      await git(state.root, ["update-index", "--cacheinfo", `160000,${state.base},component`]);
      await rm(path.join(state.root, "component"));
    } else {
      await rm(path.join(state.root, "component"));
      await symlink("renamed.ts", path.join(state.root, "component"));
      await git(state.root, ["add", "--", "component"]);
    }

    const result = await collect(state.root, state.base);

    expect(result).toMatchObject({ reason: "command-failed", state: "fallback" });
  });

  test("leaves relevant-untracked adjudication to the bounded scan inventory", async () => {
    const state = await repository();
    await writeFile(path.join(state.root, ".agent-context-lint.yml"), "version: 1\n", "utf8");

    await expect(collect(state.root, state.base)).resolves.toMatchObject({ state: "ready" });
  });

  test("accepts ordinary executable tracked files while hashing their raw content", async () => {
    if (process.platform === "win32") return;
    const state = await repository();
    await chmod(path.join(state.root, "src.ts"), 0o755);
    await git(state.root, ["add", "--", "src.ts"]);

    await expect(collect(state.root, state.base)).resolves.toMatchObject({ state: "ready" });
  });

  test("does not run repository-configured helpers, hooks, pagers, or external diff programs", async () => {
    const state = await repository();
    const marker = path.join(state.root, "EXECUTED");
    const helper = path.join(state.root, "hostile-helper.sh");
    await writeFile(helper, `#!/bin/sh\nprintf executed > "${marker}"\nexit 0\n`, "utf8");
    await chmod(helper, 0o755);
    await writeFile(
      path.join(state.root, ".gitattributes"),
      "src.ts filter=hostile diff=hostile\n",
      "utf8",
    );
    await git(state.root, ["add", "--", ".gitattributes"]);
    await writeFile(path.join(state.root, "src.ts"), "export const value = 3;\n", "utf8");
    await git(state.root, ["add", "--", "hostile-helper.sh"]);
    await git(state.root, ["config", "core.fsmonitor", helper]);
    await git(state.root, ["config", "core.pager", helper]);
    await git(state.root, ["config", "diff.external", helper]);
    await git(state.root, ["config", "diff.hostile.textconv", helper]);
    await git(state.root, ["config", "filter.hostile.clean", helper]);
    await git(state.root, ["config", "filter.hostile.process", helper]);
    await git(state.root, ["config", "filter.hostile.required", "true"]);
    await git(state.root, ["config", "core.hooksPath", state.root]);

    const before = await contentLedger(state.root);
    const first = await collect(state.root, state.base);
    const second = await collect(state.root, state.base);
    const after = await contentLedger(state.root);

    expect(first).toEqual(second);
    expect(first.state).toBe("ready");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(after).toEqual(before);
  });

  test("rejects repository-local include paths without parsing their targets", async () => {
    const state = await repository();
    const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-config-host-"));
    roots.push(hostRoot);
    const marker = path.join(hostRoot, "EXECUTED");
    const helper = path.join(hostRoot, "helper.sh");
    const included = path.join(hostRoot, "included.config");
    await writeFile(helper, `#!/bin/sh\nprintf executed > "${marker}"\n`, "utf8");
    await chmod(helper, 0o755);
    await writeFile(included, `[core]\n\tfsmonitor = ${helper}\n`, "utf8");
    await git(state.root, ["config", "include.path", included]);

    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });

    await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(
      "configuration includes are unsupported",
    );
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects alternate and promisor object metadata before creating authority", async () => {
    for (const relative of ["objects/info/alternates", "objects/pack/hostile.promisor"]) {
      const state = await repository();
      const target = path.join(state.root, ".git", relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "hostile\n", "utf8");
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(
        "alternate or lazy object metadata is unsupported",
      );
    }
  });

  test("rejects shallow, graft, loose replacement, and private-worktree metadata", async () => {
    for (const relative of ["shallow", "info/grafts", "refs/replace/hostile"]) {
      const state = await repository();
      const target = path.join(state.root, ".git", relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${state.base}\n`, "utf8");
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow("unsupported");
    }

    const linkedState = await repository();
    const linked = path.join(linkedState.root, "linked-private-config");
    await git(linkedState.root, ["worktree", "add", "--quiet", "-b", "private-config", linked]);
    const linkedSelection = await selectRepositoryRoot(linked, {
      ceiling: linked,
      mode: "discover",
    });
    if (linkedSelection.gitDirectory === null) throw new Error("linked Git directory is missing");
    await writeFile(path.join(linkedSelection.gitDirectory, "config.worktree"), "[core]\n", "utf8");
    await expect(createNodeGitMetadataExecutor(linkedSelection)).rejects.toThrow(
      "worktree configuration is unsupported",
    );
  });

  test("rejects unknown repository extensions and packed replacement references", async () => {
    const extensionState = await repository();
    await git(extensionState.root, ["config", "core.repositoryformatversion", "1"]);
    await git(extensionState.root, ["config", "extensions.auditUnknown", "true"]);
    const extensionSelection = await selectRepositoryRoot(extensionState.root, {
      ceiling: extensionState.root,
      mode: "discover",
    });
    await expect(createNodeGitMetadataExecutor(extensionSelection)).rejects.toThrow(
      "repository extension is unsupported",
    );

    const packedState = await repository();
    const tree = await git(packedState.root, ["write-tree"]);
    const replacement = await git(packedState.root, ["commit-tree", tree, "-m", "replacement"]);
    await git(packedState.root, ["replace", packedState.base, replacement]);
    await git(packedState.root, ["pack-refs", "--all", "--prune"]);
    await rm(path.join(packedState.root, ".git", "refs", "replace"), {
      force: true,
      recursive: true,
    });
    const packedSelection = await selectRepositoryRoot(packedState.root, {
      ceiling: packedState.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(packedSelection);
    await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test("uses only exact main core and extensions sections for repository format", async () => {
    const rejected = [
      '[core]\nrepositoryformatversion = 2\n[core "audit"]\nrepositoryformatversion = 0\n',
      "[core]\nrepositoryformatversion = 0\nrepositoryFormatVersion = 0\n",
      '[core]\nrepositoryformatversion = "0"\n',
      "[core]\nrepositoryformatversion = 0\\\n\n",
      "\uFEFF[core]\nrepositoryformatversion = 0\n",
      "[core]\nrepositoryformatversion = 0\0\n",
      "[core.audit]\nrepositoryformatversion = 0\n",
      '[core "audit\\"escaped"]\nrepositoryformatversion = 0\n',
    ];
    for (const config of rejected) {
      const state = await repository();
      await writeFile(path.join(state.root, ".git", "config"), config, "utf8");
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow();
    }

    for (const config of [
      "[CoRe]\nRepositoryFormatVersion = 0\n",
      "[core]\r\nrepositoryformatversion = 0\r\n",
      '[core]\nrepositoryformatversion = 0\n[remote "origin"]\nurl = https://example.invalid/repository.git\nfetch = +refs/heads/*:refs/remotes/origin/*\nfetch = +refs/tags/*:refs/tags/*\n[branch "main"]\nremote = origin\nmerge = refs/heads/main\n',
    ]) {
      const state = await repository();
      await writeFile(path.join(state.root, ".git", "config"), config, "utf8");
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const executor = await createNodeGitMetadataExecutor(selection);
      const scope = createChangedFileScanScope(selection);
      await expect(
        collectGitChangedFileMetadata(createGitMetadataCapability(scope, executor), {
          baseReference: state.base,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ state: "ready" });
    }
  });

  test("rejects malformed core syntax and duplicate object-format declarations", async () => {
    const rejected = [
      '[core "unterminated]\nrepositoryformatversion = 0\n',
      "repositoryformatversion = 0\n",
      "[core]\nrepositoryformatversion\n",
      "[core]\nrepositoryformatversion = 1\n[extensions]\nobjectformat = sha256\nobjectformat = sha256\n",
      "[core]\nrepositoryformatversion = 1\n",
    ];
    for (const config of rejected) {
      const state = await repository();
      await writeFile(path.join(state.root, ".git", "config"), config, "utf8");
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(TypeError);
    }
  });

  test("rejects unsupported object-store entry shapes during preflight", async () => {
    const fixtures = [
      async (root: string): Promise<void> => {
        await mkdir(path.join(root, ".git", "objects", "aa", "nested"), { recursive: true });
      },
      async (root: string): Promise<void> => {
        await mkdir(path.join(root, ".git", "objects", "unsupported"));
      },
      async (root: string): Promise<void> => {
        await writeFile(path.join(root, ".git", "objects", "unexpected"), "x", "utf8");
      },
      async (root: string): Promise<void> => {
        const target = path.join(root, ".git", "objects", "aa");
        await mkdir(target, { recursive: true });
        await symlink(path.join(root, "src.ts"), path.join(target, "linked-object"));
      },
      async (root: string): Promise<void> => {
        await writeFile(path.join(root, ".git", "objects", "unsafe\nname"), "x", "utf8");
      },
      async (root: string): Promise<void> => {
        if (process.platform === "win32")
          await writeFile(path.join(root, ".git", "objects", "special"), "x", "utf8");
        else
          await execFileAsync("/usr/bin/mkfifo", [path.join(root, ".git", "objects", "special")]);
      },
    ] as const;
    for (const arrange of fixtures) {
      const state = await repository();
      await arrange(state.root);
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(TypeError);
    }
  });

  test("bounds stalled operations and closes handles that resolve after the deadline", async () => {
    let release: ((value: { close(): Promise<void> }) => void) | undefined;
    let closed = false;
    const context = new OperationContext(5, undefined, "test operation");
    const pending = context.wait(
      () =>
        new Promise<{ close(): Promise<void> }>((resolve) => {
          release = resolve;
        }),
      async (handle) => {
        await handle.close();
      },
    );

    await expect(pending).rejects.toThrow("exceeded its deadline");
    release?.({
      close(): Promise<void> {
        closed = true;
        return Promise.resolve();
      },
    });
    await vi.waitFor(() => {
      expect(closed).toBe(true);
    });
    context.dispose();
  });

  test("cancels a stalled operation without waiting for its underlying promise", async () => {
    const controller = new AbortController();
    const context = new OperationContext(30_000, controller.signal, "test operation");
    const pending = context.wait(() => new Promise<never>(() => undefined));
    controller.abort();

    await expect(pending).rejects.toThrow("was cancelled");
    context.dispose();
  });

  test("closes a genuine directory handle after operation cancellation", async () => {
    const state = await repository();
    const active = new OperationContext(30_000, undefined, "active directory operation");
    const alreadyClosed = await active.openDirectory(path.join(state.root, ".git"));
    await alreadyClosed.close();
    await expect(active.close(alreadyClosed)).resolves.toBeUndefined();
    active.dispose();

    const controller = new AbortController();
    const context = new OperationContext(30_000, controller.signal, "directory operation");
    const directory = await context.openDirectory(path.join(state.root, ".git"));
    controller.abort();
    await vi.waitFor(() => {
      expect(() => {
        context.checkpoint();
      }).toThrow("directory operation was cancelled");
    });

    await expect(context.close(directory)).resolves.toBeUndefined();
    context.dispose();
  });

  test("cleans a result that crosses the operation deadline before return", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(() => Promise.resolve());
      const context = new OperationContext(5, undefined, "deadline crossing");
      const pending = context.wait(
        async () => {
          await vi.advanceTimersByTimeAsync(5);
          return { close };
        },
        async (value) => value.close(),
      );
      await expect(pending).rejects.toThrow("exceeded its deadline");
      await vi.waitFor(() => {
        expect(close).toHaveBeenCalledOnce();
      });
      context.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("checks the deadline after an operation resolves and cleans the result", async () => {
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(10);
    const close = vi.fn(() => Promise.resolve());
    const context = new OperationContext(5, undefined, "post-operation checkpoint");
    try {
      await expect(
        context.wait(
          () => Promise.resolve({ close }),
          async (value) => value.close(),
        ),
      ).rejects.toThrow("exceeded its deadline");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      context.dispose();
      now.mockRestore();
    }
  });

  test("settles late rejection and cleanup failures after cancellation", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const context = new OperationContext(5, controller.signal, "late cleanup");
      let rejectOperation: ((reason: Error) => void) | undefined;
      const pending = context.wait(
        () =>
          new Promise<{ close(): Promise<void> }>((_resolve, reject) => {
            rejectOperation = reject;
          }),
        () => Promise.reject(new Error("cleanup failure")),
      );
      controller.abort();
      controller.abort();
      await expect(pending).rejects.toThrow("was cancelled");
      rejectOperation?.(new Error("late operation failure"));
      await vi.advanceTimersByTimeAsync(5);

      await expect(
        context.close({ close: () => Promise.reject(new Error("close failure")) }),
      ).resolves.toBeUndefined();
      context.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects cancellation during object-store preflight", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      createNodeGitMetadataExecutor(selection, { signal: controller.signal }),
    ).rejects.toThrow("preflight was cancelled");
  });

  test("fails closed when packed-reference metadata is not an ordinary file", async () => {
    const state = await repository();
    await mkdir(path.join(state.root, ".git", "packed-refs"));
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection);
    await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test("fails closed on non-directory metadata parents and loose-reference components", async () => {
    const metadataParent = await repository();
    await rm(path.join(metadataParent.root, ".git", "info"), { force: true, recursive: true });
    await writeFile(path.join(metadataParent.root, ".git", "info"), "not a directory", "utf8");
    const metadataSelection = await selectRepositoryRoot(metadataParent.root, {
      ceiling: metadataParent.root,
      mode: "discover",
    });
    await expect(createNodeGitMetadataExecutor(metadataSelection)).rejects.toThrow();

    const looseReference = await repository();
    const heads = path.join(looseReference.root, ".git", "refs", "heads");
    await rm(heads, { force: true, recursive: true });
    await writeFile(heads, "not a directory", "utf8");
    const referenceSelection = await selectRepositoryRoot(looseReference.root, {
      ceiling: looseReference.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(referenceSelection);
    await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test.runIf(process.platform !== "win32")(
    "fails closed when guarded metadata directory contents change after Git succeeds",
    async () => {
      const state = await repository();
      const gitDirectory = path.join(state.root, ".git");
      const infoPath = path.join(state.root, ".git", "info");
      const guardPath = path.join(infoPath, "concurrent-guard");
      const beforeGitDirectory = await lstat(gitDirectory, { bigint: true });
      const beforeInfo = await lstat(infoPath, { bigint: true });
      const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-info-guard-"));
      roots.push(hostRoot);
      const gitStatus = path.join(hostRoot, "git-status");
      const marker = path.join(hostRoot, "mutated");
      const release = path.join(hostRoot, "release");
      const executable = path.join(hostRoot, "mutating-git");
      await writeFile(
        executable,
        `#!/bin/sh\n/usr/bin/git "$@"\nstatus=$?\nprintf '%s' "$status" > "${gitStatus}"\nif [ ! -f "${marker}" ]; then\n  printf guard > "${guardPath}"\n  printf done > "${marker}"\n  while [ ! -f "${release}" ]; do\n    /bin/sleep 0.01\n  done\nfi\nexit "$status"\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const executor = await createNodeGitMetadataExecutor(selection, {
        gitExecutable: executable,
      });

      const pending = executor(resolveHeadRequest(), new AbortController().signal);
      try {
        await vi.waitFor(async () => {
          expect(await readFile(marker, "utf8")).toBe("done");
          expect(await readFile(gitStatus, "utf8")).toBe("0");
          const afterGitDirectory = await lstat(gitDirectory, { bigint: true });
          expect(afterGitDirectory.dev).toBe(beforeGitDirectory.dev);
          expect(afterGitDirectory.ino).toBe(beforeGitDirectory.ino);
          expect(afterGitDirectory.ctimeNs).toBe(beforeGitDirectory.ctimeNs);
          expect(afterGitDirectory.mtimeNs).toBe(beforeGitDirectory.mtimeNs);
          const afterInfo = await lstat(infoPath, { bigint: true });
          expect(afterInfo.dev).toBe(beforeInfo.dev);
          expect(afterInfo.ino).toBe(beforeInfo.ino);
          expect(
            afterInfo.ctimeNs !== beforeInfo.ctimeNs || afterInfo.mtimeNs !== beforeInfo.mtimeNs,
          ).toBe(true);
          const guard = await lstat(guardPath, { bigint: true });
          expect(guard.isFile()).toBe(true);
          expect(guard.isSymbolicLink()).toBe(false);
          expect(guard.nlink).toBe(1n);
          expect(await readFile(guardPath, "utf8")).toBe("guard");
        });
      } finally {
        await writeFile(release, "release", "utf8");
      }

      await expect(pending).resolves.toEqual({
        exitCode: 1,
        stdout: new Uint8Array(),
      });
    },
  );

  test("rejects a parent-directory inode replacement at the post-capture guard boundary", async () => {
    const state = await repository();
    const requestedMetadataRoot = path.join(state.root, "metadata-root");
    await mkdir(requestedMetadataRoot);
    const metadataRoot = await realpath(requestedMetadataRoot);
    const movedRoot = path.join(path.dirname(metadataRoot), "metadata-root.original");
    const target = path.join(metadataRoot, "HEAD");
    const targetBytes = `${state.base}\n`;
    await writeFile(target, targetBytes, "utf8");
    const beforeRoot = await lstat(metadataRoot, { bigint: true });
    let hookCalls = 0;

    let failure: unknown;
    try {
      await bindMetadataFileWithinForTest(metadataRoot, "HEAD", 4_096, async () => {
        hookCalls += 1;
        await rename(metadataRoot, movedRoot);
        await mkdir(metadataRoot);
        await writeFile(target, targetBytes, "utf8");
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe("Git metadata path changed while it was captured");
    expect(hookCalls).toBe(1);
    const afterRoot = await lstat(metadataRoot, { bigint: true });
    expect(afterRoot.dev).toBe(beforeRoot.dev);
    expect(afterRoot.ino).not.toBe(beforeRoot.ino);
    expect(afterRoot.isDirectory()).toBe(true);
    expect(afterRoot.isSymbolicLink()).toBe(false);
    const afterTarget = await lstat(target, { bigint: true });
    expect(afterTarget.isFile()).toBe(true);
    expect(afterTarget.isSymbolicLink()).toBe(false);
    expect(afterTarget.nlink).toBe(1n);
    expect(await readFile(target, "utf8")).toBe(targetBytes);
    expect(await readFile(path.join(movedRoot, "HEAD"), "utf8")).toBe(targetBytes);
  });

  test("interrupts an active object-store preflight", async () => {
    const state = await repository();
    const fanout = path.join(state.root, ".git", "objects", "aa");
    await mkdir(fanout, { recursive: true });
    for (let index = 0; index < 2_000; index += 1)
      await writeFile(path.join(fanout, index.toString(16).padStart(38, "0")), "", "utf8");
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const controller = new AbortController();
    const pending = createNodeGitMetadataExecutor(selection, { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 0);

    await expect(pending).rejects.toThrow("preflight was cancelled");
  });

  test("bounds a hostile single-directory loose-object farm", async () => {
    const state = await repository();
    const fanout = path.join(state.root, ".git", "objects", "aa");
    await mkdir(fanout, { recursive: true });
    for (let index = 0; index < 4_100; index += 1)
      await writeFile(path.join(fanout, index.toString(16).padStart(38, "0")), "", "utf8");
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });

    await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(
      "object store exceeds the metadata entry limit",
    );
  });

  test("enforces the independent object-store preflight deadline", async () => {
    const state = await repository();
    const fanout = path.join(state.root, ".git", "objects", "aa");
    await mkdir(fanout, { recursive: true });
    for (let index = 0; index < 1_000; index += 1)
      await writeFile(path.join(fanout, index.toString(16).padStart(38, "0")), "", "utf8");
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });

    await expect(
      createNodeGitMetadataExecutor(selection, { maximumPreflightDurationMs: 1 }),
    ).rejects.toThrow("preflight exceeded its deadline");
  });

  test("rejects loose-object byte ABA after an admitted request", async () => {
    if (process.platform === "win32") return;
    const state = await repository();
    const objectPath = path.join(
      state.root,
      ".git",
      "objects",
      state.base.slice(0, 2),
      state.base.slice(2),
    );
    const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-object-aba-"));
    roots.push(hostRoot);
    const backup = path.join(hostRoot, "object.backup");
    await copyFile(objectPath, backup);
    const executable = path.join(hostRoot, "mutating-git");
    await writeFile(
      executable,
      `#!/bin/sh\n/bin/chmod u+w "${objectPath}"\nprintf x >> "${objectPath}"\nsleep 0.05\n/bin/cp "${backup}" "${objectPath}"\n/bin/chmod 0444 "${objectPath}"\nsleep 0.05\nprintf '${state.base}\\n'\n`,
      "utf8",
    );
    await chmod(executable, 0o755);
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection, { gitExecutable: executable });
    const before = await lstat(objectPath, { bigint: true });

    const result = await executor(resolveHeadRequest(), new AbortController().signal);
    const after = await lstat(objectPath, { bigint: true });
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect(result).toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test.runIf(process.platform !== "win32")(
    "rejects a coherent in-place index and source replacement during the final HEAD boundary",
    async () => {
      const state = await repository();
      const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-final-head-"));
      roots.push(hostRoot);
      const indexPath = path.join(state.root, ".git", "index");
      const sourcePath = path.join(state.root, "src.ts");
      const originalIndex = path.join(hostRoot, "index.original");
      const replacementIndex = path.join(hostRoot, "index.replacement");
      const originalSource = path.join(hostRoot, "source.original");
      const replacementSource = path.join(hostRoot, "source.replacement");
      await copyFile(indexPath, originalIndex);
      await copyFile(sourcePath, originalSource);
      await writeFile(sourcePath, "export const value = 2;\n", "utf8");
      await git(state.root, ["add", "--", "src.ts"]);
      await copyFile(indexPath, replacementIndex);
      await copyFile(sourcePath, replacementSource);
      await copyFile(originalIndex, indexPath);
      await copyFile(originalSource, sourcePath);
      const counter = path.join(hostRoot, "counter");
      const executable = path.join(hostRoot, "final-head-git");
      await writeFile(
        executable,
        `#!/bin/sh\ncount=0\nif [ -f "${counter}" ]; then count=$(/bin/cat "${counter}"); fi\ncase " $* " in\n  *" rev-parse --verify --end-of-options "*) count=$((count + 1)); printf '%s' "$count" > "${counter}" ;;\nesac\n/usr/bin/git "$@"\nstatus=$?\nif [ "$count" = 3 ]; then\n  /bin/cp "${replacementIndex}" "${indexPath}"\n  /bin/cp "${replacementSource}" "${sourcePath}"\nfi\nexit "$status"\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
      const beforeIndex = await lstat(indexPath, { bigint: true });
      const beforeSource = await lstat(sourcePath, { bigint: true });
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const scope = createChangedFileScanScope(selection);
      const executor = await createNodeGitMetadataExecutor(selection, {
        gitExecutable: executable,
      });

      const result = await collectGitChangedFileMetadata(
        createGitMetadataCapability(scope, executor),
        {
          baseReference: state.base,
          signal: new AbortController().signal,
        },
      );
      const afterIndex = await lstat(indexPath, { bigint: true });
      const afterSource = await lstat(sourcePath, { bigint: true });

      expect(result).toMatchObject({ reason: "command-failed", state: "fallback" });
      expect(afterIndex.ino).toBe(beforeIndex.ino);
      expect(afterSource.ino).toBe(beforeSource.ino);
      expect(await readFile(indexPath)).toEqual(await readFile(replacementIndex));
      expect(await readFile(sourcePath)).toEqual(await readFile(replacementSource));
    },
  );

  test.runIf(process.platform !== "win32")(
    "rejects an in-place loose branch ref rewrite during the final HEAD boundary",
    async () => {
      const state = await repository();
      const tree = await git(state.root, ["write-tree"]);
      const movedHead = await git(state.root, [
        "commit-tree",
        tree,
        "-p",
        state.base,
        "-m",
        "moved loose ref",
      ]);
      const branch = await git(state.root, ["symbolic-ref", "--short", "HEAD"]);
      const refPath = path.join(state.root, ".git", "refs", "heads", branch);
      const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-loose-ref-"));
      roots.push(hostRoot);
      const counter = path.join(hostRoot, "counter");
      const mutation = path.join(hostRoot, "mutated");
      const release = path.join(hostRoot, "release");
      const executable = path.join(hostRoot, "mutating-git");
      await writeFile(
        executable,
        `#!/bin/sh\ncount=0\nif [ -f "${counter}" ]; then count=$(/bin/cat "${counter}"); fi\ncase " $* " in\n  *" rev-parse --verify --end-of-options "*) count=$((count + 1)); printf '%s' "$count" > "${counter}" ;;\nesac\n/usr/bin/git "$@"\nstatus=$?\nif [ "$count" = 3 ] && [ ! -f "${mutation}" ]; then\n  printf '%s\\n' "${movedHead}" > "${refPath}"\n  printf done > "${mutation}"\n  while [ ! -f "${release}" ]; do\n    /bin/sleep 0.01\n  done\nfi\nexit "$status"\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const scope = createChangedFileScanScope(selection);
      const executor = await createNodeGitMetadataExecutor(selection, {
        gitExecutable: executable,
      });

      const before = await lstat(refPath, { bigint: true });
      const pending = collectGitChangedFileMetadata(createGitMetadataCapability(scope, executor), {
        baseReference: state.base,
        signal: new AbortController().signal,
      });
      try {
        await vi.waitFor(async () => {
          expect(await readFile(mutation, "utf8")).toBe("done");
          const after = await lstat(refPath, { bigint: true });
          expect(after.ino).toBe(before.ino);
          expect(after.ctimeNs).not.toBe(before.ctimeNs);
          expect(await readFile(refPath, "utf8")).toBe(`${movedHead}\n`);
        });
      } finally {
        await writeFile(release, "release", "utf8");
      }
      const result = await pending;

      expect(await git(state.root, ["rev-parse", "HEAD"])).toBe(movedHead);
      expect(result).toMatchObject({ reason: "command-failed", state: "fallback" });
    },
  );

  test.runIf(process.platform !== "win32")(
    "rejects an in-place packed ref rewrite during the final HEAD boundary",
    async () => {
      const state = await repository();
      await git(state.root, ["branch", "-M", "main"]);
      await git(state.root, ["pack-refs", "--all", "--prune"]);
      const tree = await git(state.root, ["write-tree"]);
      const movedHead = await git(state.root, [
        "commit-tree",
        tree,
        "-p",
        state.base,
        "-m",
        "moved packed ref",
      ]);
      const packedPath = path.join(state.root, ".git", "packed-refs");
      const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-packed-ref-"));
      roots.push(hostRoot);
      const replacement = path.join(hostRoot, "packed-refs.replacement");
      const packedText = await readFile(packedPath, "utf8");
      await writeFile(
        replacement,
        packedText.replace(`${state.base} refs/heads/main`, `${movedHead} refs/heads/main`),
        "utf8",
      );
      const counter = path.join(hostRoot, "counter");
      const mutation = path.join(hostRoot, "mutated");
      const release = path.join(hostRoot, "release");
      const executable = path.join(hostRoot, "mutating-git");
      await writeFile(
        executable,
        `#!/bin/sh\ncount=0\nif [ -f "${counter}" ]; then count=$(/bin/cat "${counter}"); fi\ncase " $* " in\n  *" rev-parse --verify --end-of-options "*) count=$((count + 1)); printf '%s' "$count" > "${counter}" ;;\nesac\n/usr/bin/git "$@"\nstatus=$?\nif [ "$count" = 3 ] && [ ! -f "${mutation}" ]; then\n  /bin/cat "${replacement}" > "${packedPath}"\n  printf done > "${mutation}"\n  while [ ! -f "${release}" ]; do\n    /bin/sleep 0.01\n  done\nfi\nexit "$status"\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const scope = createChangedFileScanScope(selection);
      const executor = await createNodeGitMetadataExecutor(selection, {
        gitExecutable: executable,
      });

      const before = await lstat(packedPath, { bigint: true });
      const pending = collectGitChangedFileMetadata(createGitMetadataCapability(scope, executor), {
        baseReference: state.base,
        signal: new AbortController().signal,
      });
      try {
        await vi.waitFor(async () => {
          expect(await readFile(mutation, "utf8")).toBe("done");
          const after = await lstat(packedPath, { bigint: true });
          expect(after.ino).toBe(before.ino);
          expect(after.ctimeNs).not.toBe(before.ctimeNs);
          expect(await readFile(packedPath, "utf8")).toBe(await readFile(replacement, "utf8"));
        });
      } finally {
        await writeFile(release, "release", "utf8");
      }
      const result = await pending;

      expect(await git(state.root, ["rev-parse", "HEAD"])).toBe(movedHead);
      expect(result).toMatchObject({ reason: "command-failed", state: "fallback" });
    },
  );

  test.runIf(process.platform !== "win32")(
    "rejects a late loose ref that overrides a packed branch during final HEAD",
    async () => {
      const state = await repository();
      await git(state.root, ["branch", "-M", "main"]);
      await git(state.root, ["pack-refs", "--all", "--prune"]);
      const tree = await git(state.root, ["write-tree"]);
      const movedHead = await git(state.root, [
        "commit-tree",
        tree,
        "-p",
        state.base,
        "-m",
        "late loose ref",
      ]);
      const loosePath = path.join(state.root, ".git", "refs", "heads", "main");
      await expect(readFile(loosePath)).rejects.toMatchObject({ code: "ENOENT" });
      const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-late-ref-"));
      roots.push(hostRoot);
      const counter = path.join(hostRoot, "counter");
      const mutation = path.join(hostRoot, "mutated");
      const release = path.join(hostRoot, "release");
      const executable = path.join(hostRoot, "mutating-git");
      await writeFile(
        executable,
        `#!/bin/sh\ncount=0\nif [ -f "${counter}" ]; then count=$(/bin/cat "${counter}"); fi\ncase " $* " in\n  *" rev-parse --verify --end-of-options "*) count=$((count + 1)); printf '%s' "$count" > "${counter}" ;;\nesac\n/usr/bin/git "$@"\nstatus=$?\nif [ "$count" = 3 ] && [ ! -f "${mutation}" ]; then\n  printf '%s\\n' "${movedHead}" > "${loosePath}"\n  printf done > "${mutation}"\n  while [ ! -f "${release}" ]; do\n    /bin/sleep 0.01\n  done\nfi\nexit "$status"\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const scope = createChangedFileScanScope(selection);
      const executor = await createNodeGitMetadataExecutor(selection, {
        gitExecutable: executable,
      });

      const pending = collectGitChangedFileMetadata(createGitMetadataCapability(scope, executor), {
        baseReference: state.base,
        signal: new AbortController().signal,
      });
      try {
        await vi.waitFor(async () => {
          expect(await readFile(mutation, "utf8")).toBe("done");
          expect((await lstat(loosePath)).isFile()).toBe(true);
          expect(await readFile(loosePath, "utf8")).toBe(`${movedHead}\n`);
        });
      } finally {
        await writeFile(release, "release", "utf8");
      }
      const result = await pending;

      expect(await git(state.root, ["rev-parse", "HEAD"])).toBe(movedHead);
      expect(result).toMatchObject({ reason: "command-failed", state: "fallback" });
    },
  );

  test("rejects a hostile command shape before spawning Git", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection);
    const request: GitMetadataRequest = Object.freeze({
      arguments: Object.freeze(["status", "--porcelain"]),
      kind: "diff",
      policy,
    });

    await expect(executor(request, new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test("does not invoke accessors, sparse arrays, proxies, or decorated request records", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection);
    const getter = vi.fn(() => resolveHeadRequest().arguments);
    const accessor = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperties(accessor, {
      arguments: { enumerable: true, get: getter },
      kind: { enumerable: true, value: "resolve-head" },
      policy: { enumerable: true, value: policy },
    });
    const sparse = new Array<string>(3);
    sparse[0] = "rev-parse";
    sparse[1] = "--verify";
    const decorated = [...resolveHeadRequest().arguments] as string[] & { extra?: string };
    decorated.extra = "not admitted";

    for (const request of [
      accessor,
      { arguments: sparse, kind: "resolve-head", policy },
      { arguments: decorated, kind: "resolve-head", policy },
      new Proxy(resolveHeadRequest(), {}),
      {
        arguments: ["rev-parse", "--verify", `HEAD^{commit}${String.fromCharCode(0)}`],
        kind: "resolve-head",
        policy,
      },
      {
        arguments: ["rev-parse", "--verify", `HEAD^{commit}${String.fromCharCode(0x061c)}`],
        kind: "resolve-head",
        policy,
      },
      {
        arguments: ["rev-parse", "--verify", `HEAD^{commit}${String.fromCharCode(0xd800)}`],
        kind: "resolve-head",
        policy,
      },
      {
        arguments: ["rev-parse", "--verify", `HEAD^{commit}${String.fromCharCode(0xdc00)}`],
        kind: "resolve-head",
        policy,
      },
      {
        arguments: ["rev-parse", "--verify", "main^{commit}"],
        kind: "resolve-base",
        policy,
      },
      {
        arguments: resolveHeadRequest().arguments,
        kind: "resolve-head",
        policy: { ...policy, environment: { ...policy.environment, EXTRA: "1" } },
      },
      { arguments: resolveHeadRequest().arguments, kind: "resolve-head", policy: null },
      { arguments: resolveHeadRequest().arguments, kind: "resolve-head", policy: {} },
    ])
      await expect(
        executor(request as GitMetadataRequest, new AbortController().signal),
      ).resolves.toEqual({ exitCode: 1, stdout: new Uint8Array() });
    expect(getter).not.toHaveBeenCalled();

    const revoked = Proxy.revocable([...resolveHeadRequest().arguments], {});
    revoked.revoke();
    await expect(
      executor(
        { arguments: revoked.proxy, kind: "resolve-head", policy },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ exitCode: 1, stdout: new Uint8Array() });
    await expect(executor(resolveHeadRequest(), {} as AbortSignal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
    const unicodeReference = await executor(
      {
        arguments: ["rev-parse", "--verify", "--end-of-options", "branch-😀^{commit}"],
        kind: "resolve-base",
        policy,
      },
      new AbortController().signal,
    );
    expect(unicodeReference.exitCode).not.toBe(0);
    expect(unicodeReference.stdout).toEqual(new Uint8Array());
  });

  test("fails closed when the trusted host output ceiling is exceeded", async () => {
    const state = await repository();
    await writeFile(path.join(state.root, "a-long-changed-path.ts"), "export {};\n", "utf8");
    await git(state.root, ["add", "--", "a-long-changed-path.ts"]);

    await expect(collect(state.root, state.base, 8)).resolves.toMatchObject({
      reason: "command-failed",
      state: "fallback",
    });
  });

  test("admits the exact output ceiling and rejects the next lower byte limit", async () => {
    const state = await repository();
    await writeFile(path.join(state.root, "x.ts"), "export {};\n", "utf8");
    await git(state.root, ["add", "--", "x.ts"]);

    const exactCeiling = (await readFile(path.join(state.root, ".git", "index"))).byteLength;
    await expect(collect(state.root, state.base, exactCeiling)).resolves.toMatchObject({
      state: "ready",
    });
    await expect(collect(state.root, state.base, exactCeiling - 1)).resolves.toMatchObject({
      reason: "command-failed",
      state: "fallback",
    });
  });

  test.runIf(process.platform !== "win32")(
    "applies the output ceiling to stdout and stderr combined",
    async () => {
      const state = await repository();
      const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-output-host-"));
      roots.push(hostRoot);
      const executable = path.join(hostRoot, "bounded-git");
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '${"1".repeat(40)}\\n'\nprintf 'stderr' >&2\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const executor = await createNodeGitMetadataExecutor(selection, {
        gitExecutable: executable,
        maximumOutputBytes: 41,
      });

      await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
        exitCode: 1,
        stdout: new Uint8Array(),
      });
    },
  );

  test("terminates a real spawned Git process at a stricter trusted-host deadline", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection, { maximumDurationMs: 1 });

    await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test("cancels and reaps a real Git subprocess after execution has started", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection);
    const controller = new AbortController();
    const pending = executor(resolveHeadRequest(), controller.signal);
    const timer = setTimeout(() => {
      controller.abort();
    }, 5);

    await expect(pending).resolves.toEqual({ exitCode: 1, stdout: new Uint8Array() });
    clearTimeout(timer);
    expect(controller.signal.aborted).toBe(true);
  });

  test.runIf(process.platform !== "win32")(
    "cancels a controlled trusted process only after its execution marker is visible",
    async () => {
      const state = await repository();
      const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-cancel-host-"));
      roots.push(hostRoot);
      const marker = path.join(hostRoot, "started");
      const executable = path.join(hostRoot, "controlled-git");
      await writeFile(
        executable,
        `#!/bin/sh\ntrap 'printf late-output; while :; do :; done' TERM\nprintf ready > ${JSON.stringify(marker)}\nwhile :; do :; done\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const executor = await createNodeGitMetadataExecutor(selection, {
        gitExecutable: executable,
      });
      const controller = new AbortController();
      const pending = executor(resolveHeadRequest(), controller.signal);
      await vi.waitFor(async () => {
        await expect(readFile(marker, "utf8")).resolves.toBe("ready");
      });
      controller.abort();

      await expect(pending).resolves.toEqual({ exitCode: 1, stdout: new Uint8Array() });
    },
  );

  test.runIf(process.platform !== "win32")(
    "force-kills a trusted process that ignores graceful cancellation",
    async () => {
      const state = await repository();
      const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-stubborn-host-"));
      roots.push(hostRoot);
      const executable = path.join(hostRoot, "stubborn-git");
      await writeFile(executable, "#!/bin/sh\ntrap '' TERM\nwhile :; do printf x; done\n", "utf8");
      await chmod(executable, 0o755);
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const executor = await createNodeGitMetadataExecutor(selection, {
        gitExecutable: executable,
        maximumDurationMs: 1,
      });
      const controller = new AbortController();
      const pending = executor(resolveHeadRequest(), controller.signal);
      const timer = setTimeout(() => {
        controller.abort();
      }, 20);

      await expect(pending).resolves.toEqual({ exitCode: 1, stdout: new Uint8Array() });
      clearTimeout(timer);
    },
  );

  test("fails closed on cancellation and leaves no Git process result", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const scope = createChangedFileScanScope(selection);
    const executor = await createNodeGitMetadataExecutor(selection);
    const controller = new AbortController();
    controller.abort();

    await expect(
      collectGitChangedFileMetadata(createGitMetadataCapability(scope, executor), {
        baseReference: state.base,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ reason: "cancelled", state: "fallback" });
  });

  test("supports a linked worktree while binding the exact .git marker contents", async () => {
    const state = await repository();
    const linked = path.join(state.root, "linked-worktree");
    await git(state.root, ["worktree", "add", "--quiet", "-b", "linked-test", linked]);
    await writeFile(path.join(linked, "src.ts"), "export const value = 4;\n", "utf8");

    const result = await collect(linked, state.base);

    expect(result.state).toBe("ready");
    if (result.state === "ready")
      expect(result.changes).toContainEqual({
        path: "src.ts",
        previousPath: null,
        status: "modified",
      });
  });

  test("resolves a packed branch without exposing repository configuration to Git", async () => {
    const state = await repository();
    await git(state.root, ["branch", "-M", "main"]);
    await git(state.root, ["pack-refs", "--all", "--prune"]);
    await writeFile(path.join(state.root, "src.ts"), "export const value = 8;\n", "utf8");

    const result = await collect(state.root, "main");

    expect(result.state).toBe("ready");
    if (result.state === "ready") expect(result.baseCommit).toBe(state.base);
  });

  test("fails closed for malformed loose HEAD and symbolic-reference records", async () => {
    const fixtures: readonly (string | Uint8Array)[] = [
      Buffer.from([0xff, 0x0a]),
      `${"1".repeat(40)}\ntrailing\n`,
      "ref: main\n",
      "not-an-object\n",
    ];
    for (const contents of fixtures) {
      const state = await repository();
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const executor = await createNodeGitMetadataExecutor(selection);
      await writeFile(path.join(state.root, ".git", "HEAD"), contents);

      await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
        exitCode: 1,
        stdout: new Uint8Array(),
      });
    }
  });

  test("rejects cyclic, excessively deep, and unresolved symbolic HEAD chains", async () => {
    const cycle = await repository();
    const cycleSelection = await selectRepositoryRoot(cycle.root, {
      ceiling: cycle.root,
      mode: "discover",
    });
    const cycleExecutor = await createNodeGitMetadataExecutor(cycleSelection);
    await writeFile(path.join(cycle.root, ".git", "HEAD"), "ref: refs/heads/cycle-a\n");
    await writeFile(
      path.join(cycle.root, ".git", "refs", "heads", "cycle-a"),
      "ref: refs/heads/cycle-b\n",
    );
    await writeFile(
      path.join(cycle.root, ".git", "refs", "heads", "cycle-b"),
      "ref: refs/heads/cycle-a\n",
    );
    await expect(
      cycleExecutor(resolveHeadRequest(), new AbortController().signal),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });

    const deep = await repository();
    const deepSelection = await selectRepositoryRoot(deep.root, {
      ceiling: deep.root,
      mode: "discover",
    });
    const deepExecutor = await createNodeGitMetadataExecutor(deepSelection);
    await writeFile(path.join(deep.root, ".git", "HEAD"), "ref: refs/heads/depth-0\n");
    for (let index = 0; index < 17; index += 1) {
      await writeFile(
        path.join(deep.root, ".git", "refs", "heads", `depth-${String(index)}`),
        `ref: refs/heads/depth-${String(index + 1)}\n`,
      );
    }
    await expect(deepExecutor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual(
      {
        exitCode: 1,
        stdout: new Uint8Array(),
      },
    );

    const unresolved = await repository();
    const unresolvedSelection = await selectRepositoryRoot(unresolved.root, {
      ceiling: unresolved.root,
      mode: "discover",
    });
    const unresolvedExecutor = await createNodeGitMetadataExecutor(unresolvedSelection);
    await writeFile(path.join(unresolved.root, ".git", "HEAD"), "ref: refs/heads/does-not-exist\n");
    await expect(
      unresolvedExecutor(resolveHeadRequest(), new AbortController().signal),
    ).resolves.toEqual({ exitCode: 1, stdout: new Uint8Array() });
  });

  test("rejects malformed and duplicated packed reference inventories", async () => {
    const fixtures = [
      "malformed-record\n",
      `${"1".repeat(40)} invalid-name\n`,
      `${"1".repeat(40)} refs/heads/main\n${"2".repeat(40)} refs/heads/main\n`,
      Buffer.from([0xff, 0x0a]),
    ] as const;
    for (const packed of fixtures) {
      const state = await repository();
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      const executor = await createNodeGitMetadataExecutor(selection);
      await writeFile(path.join(state.root, ".git", "packed-refs"), packed);

      await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
        exitCode: 1,
        stdout: new Uint8Array(),
      });
    }
  });

  test("rejects ambiguous short references before spawning Git", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection);
    await writeFile(path.join(state.root, ".git", "refs", "topic"), `${"1".repeat(40)}\n`);
    await writeFile(path.join(state.root, ".git", "refs", "heads", "topic"), `${"2".repeat(40)}\n`);

    await expect(
      executor(resolveBaseRequest("topic"), new AbortController().signal),
    ).resolves.toEqual({ exitCode: 1, stdout: new Uint8Array() });
  });

  test("rejects unresolved references whose loose paths have absent intermediate directories", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection);
    await expect(
      executor(resolveBaseRequest("deep/topic"), new AbortController().signal),
    ).resolves.toEqual({ exitCode: 1, stdout: new Uint8Array() });
  });

  test("rejects an empty index during executor preflight", async () => {
    const state = await repository();
    await writeFile(path.join(state.root, ".git", "index"), new Uint8Array());
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });

    await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(
      "Git index is unavailable or unsupported",
    );
  });

  test("rejects an unmerged index during executor preflight", async () => {
    const state = await repository();
    await writeFile(path.join(state.root, "src.ts"), "export const value = 2;\n", "utf8");
    await git(state.root, ["add", "--", "src.ts"]);
    await git(state.root, ["commit", "--quiet", "-m", "ours"]);
    const ours = await git(state.root, ["rev-parse", "HEAD"]);
    await git(state.root, ["reset", "--quiet", "--hard", state.base]);
    await writeFile(path.join(state.root, "src.ts"), "export const value = 3;\n", "utf8");
    await git(state.root, ["add", "--", "src.ts"]);
    await git(state.root, ["commit", "--quiet", "-m", "theirs"]);
    const theirs = await git(state.root, ["rev-parse", "HEAD"]);
    await git(state.root, ["reset", "--quiet", "--hard", ours]);
    await expect(git(state.root, ["merge", "--no-commit", "--no-ff", theirs])).rejects.toThrow();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(
      "unmerged Git index entries are unsupported",
    );
  });

  test("rejects normal repositories carrying worktree-only common-directory metadata", async () => {
    const state = await repository();
    await writeFile(path.join(state.root, ".git", "commondir"), ".\n", "utf8");
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(
      "unexpected Git worktree common-directory metadata",
    );
  });

  test("rejects malformed linked-worktree common-directory and backlink records", async () => {
    const common = await repository();
    const commonLinked = path.join(common.root, "invalid-common");
    await git(common.root, ["worktree", "add", "--quiet", "-b", "invalid-common", commonLinked]);
    const commonSelection = await selectRepositoryRoot(commonLinked, {
      ceiling: commonLinked,
      mode: "discover",
    });
    if (commonSelection.gitDirectory === null) throw new Error("linked Git directory is missing");
    await writeFile(path.join(commonSelection.gitDirectory, "commondir"), "../..\nextra\n", "utf8");
    await expect(createNodeGitMetadataExecutor(commonSelection)).rejects.toThrow(
      "common-directory metadata is invalid",
    );

    const backlink = await repository();
    const backlinkLinked = path.join(backlink.root, "invalid-backlink");
    await git(backlink.root, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "invalid-backlink",
      backlinkLinked,
    ]);
    const backlinkSelection = await selectRepositoryRoot(backlinkLinked, {
      ceiling: backlinkLinked,
      mode: "discover",
    });
    if (backlinkSelection.gitDirectory === null) throw new Error("linked Git directory is missing");
    await writeFile(path.join(backlinkSelection.gitDirectory, "gitdir"), "/wrong/path\n", "utf8");
    await expect(createNodeGitMetadataExecutor(backlinkSelection)).rejects.toThrow(
      "backlink does not match",
    );
  });

  test("rejects unsafe packed reference names", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection);
    await writeFile(
      path.join(state.root, ".git", "packed-refs"),
      `${state.base} refs/heads/bad~name\n`,
      "utf8",
    );
    await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test("rejects metadata guard-directory mutation after executor creation", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const executor = await createNodeGitMetadataExecutor(selection);
    await writeFile(path.join(state.root, ".git", "info", "late-metadata"), "x", "utf8");
    await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test("hashes and sorts multiple unstaged regular-file changes", async () => {
    const state = await repository();
    await writeFile(path.join(state.root, "src.ts"), "export const value = 9;\n", "utf8");
    await writeFile(path.join(state.root, "component"), "changed\n", "utf8");
    const result = await collect(state.root, state.base);
    expect(result).toMatchObject({
      changes: [
        { path: "component", status: "modified" },
        { path: "src.ts", status: "modified" },
      ],
      state: "ready",
    });
  });

  test.runIf(process.platform !== "win32")(
    "rejects an unstaged symlink replacement for a regular tracked file",
    async () => {
      const state = await repository();
      await rm(path.join(state.root, "src.ts"));
      await symlink("AGENTS.md", path.join(state.root, "src.ts"));
      await expect(collect(state.root, state.base)).resolves.toMatchObject({
        reason: "command-failed",
        state: "fallback",
      });
    },
  );

  test.runIf(process.platform !== "win32")(
    "rejects malformed Git name-status records before merging worktree evidence",
    async () => {
      for (const command of [
        "printf 'M'",
        "printf '\\377\\000path\\000'",
        "printf 'U\\000path\\000'",
        "printf 'M\\000\\000'",
      ]) {
        const state = await repository();
        const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-name-status-"));
        roots.push(hostRoot);
        const executable = path.join(hostRoot, "malformed-diff-git");
        await writeFile(
          executable,
          `#!/bin/sh\ncase " $* " in\n  *" diff-index "*) ${command}; exit 0 ;;\nesac\nexec /usr/bin/git "$@"\n`,
          "utf8",
        );
        await chmod(executable, 0o755);
        const selection = await selectRepositoryRoot(state.root, {
          ceiling: state.root,
          mode: "discover",
        });
        const executor = await createNodeGitMetadataExecutor(selection, {
          gitExecutable: executable,
        });
        await expect(
          executor(diffRequest(state.base), new AbortController().signal),
        ).resolves.toEqual({ exitCode: 1, stdout: new Uint8Array() });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "merges omitted worktree changes and propagates a failed Git diff",
    async () => {
      for (const [command, exitCode] of [
        ["exit 0", 0],
        ["exit 7", 7],
      ] as const) {
        const state = await repository();
        await writeFile(path.join(state.root, "src.ts"), "export const value = 10;\n", "utf8");
        const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-diff-result-"));
        roots.push(hostRoot);
        const executable = path.join(hostRoot, "controlled-diff-git");
        await writeFile(
          executable,
          `#!/bin/sh\ncase " $* " in\n  *" diff-index "*) ${command} ;;\nesac\nexec /usr/bin/git "$@"\n`,
          "utf8",
        );
        await chmod(executable, 0o755);
        const selection = await selectRepositoryRoot(state.root, {
          ceiling: state.root,
          mode: "discover",
        });
        const executor = await createNodeGitMetadataExecutor(selection, {
          gitExecutable: executable,
        });
        const result = await executor(diffRequest(state.base), new AbortController().signal);
        expect(result.exitCode).toBe(exitCode);
        if (exitCode === 0) expect(Buffer.from(result.stdout)).toEqual(Buffer.from("M\0src.ts\0"));
      }
    },
  );

  test("rejects a repository configuration and index object-format mismatch", async () => {
    const state = await repository();
    await writeFile(
      path.join(state.root, ".git", "config"),
      "[core]\nrepositoryformatversion = 1\n[extensions]\nobjectformat = sha256\n",
      "utf8",
    );
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(
      "index object format does not match",
    );
  });

  test("rejects linked-worktree common-directory mutation", async () => {
    const state = await repository();
    const linked = path.join(state.root, "linked-common-swap");
    await git(state.root, ["worktree", "add", "--quiet", "-b", "common-test", linked]);
    const selection = await selectRepositoryRoot(linked, { ceiling: linked, mode: "discover" });
    const executor = await createNodeGitMetadataExecutor(selection);
    if (selection.gitDirectory === null) throw new Error("linked Git directory is missing");
    await writeFile(path.join(selection.gitDirectory, "commondir"), ".\n", "utf8");

    await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test("rejects a linked worktree with a missing private gitdir backlink", async () => {
    const state = await repository();
    const linked = path.join(state.root, "linked-missing-backlink");
    await git(state.root, ["worktree", "add", "--quiet", "-b", "missing-backlink", linked]);
    const selection = await selectRepositoryRoot(linked, { ceiling: linked, mode: "discover" });
    if (selection.gitDirectory === null) throw new Error("linked Git directory is missing");
    await rm(path.join(selection.gitDirectory, "gitdir"));

    await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow();
  });

  test("rejects an in-place linked-worktree marker mutation before spawning", async () => {
    const state = await repository();
    const linked = path.join(state.root, "linked-marker-swap");
    await git(state.root, ["worktree", "add", "--quiet", "-b", "marker-test", linked]);
    const selection = await selectRepositoryRoot(linked, { ceiling: linked, mode: "discover" });
    const executor = await createNodeGitMetadataExecutor(selection);
    await writeFile(path.join(linked, ".git"), "gitdir: invalid\n", "utf8");

    await expect(executor(resolveHeadRequest(), new AbortController().signal)).resolves.toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
  });

  test("rejects root, Git marker, and executable identity swaps", async () => {
    const rootSwap = await repository();
    const rootSelection = await selectRepositoryRoot(rootSwap.root, {
      ceiling: rootSwap.root,
      mode: "discover",
    });
    const rootExecutor = await createNodeGitMetadataExecutor(rootSelection);
    const movedRoot = `${rootSwap.root}-moved`;
    roots.push(movedRoot);
    await rename(rootSwap.root, movedRoot);
    await mkdir(rootSwap.root);
    await expect(
      rootExecutor(resolveHeadRequest(), new AbortController().signal),
    ).resolves.toMatchObject({ exitCode: 1 });

    const markerSwap = await repository();
    const markerSelection = await selectRepositoryRoot(markerSwap.root, {
      ceiling: markerSwap.root,
      mode: "discover",
    });
    const markerExecutor = await createNodeGitMetadataExecutor(markerSelection);
    await rename(path.join(markerSwap.root, ".git"), path.join(markerSwap.root, ".git-old"));
    await mkdir(path.join(markerSwap.root, ".git"));
    await expect(
      markerExecutor(resolveHeadRequest(), new AbortController().signal),
    ).resolves.toMatchObject({ exitCode: 1 });

    const executableSwap = await repository();
    const hostRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-host-"));
    roots.push(hostRoot);
    const executable = path.join(hostRoot, process.platform === "win32" ? "host.exe" : "host");
    await copyFile(process.execPath, executable);
    if (process.platform !== "win32") await chmod(executable, 0o755);
    const executableSelection = await selectRepositoryRoot(executableSwap.root, {
      ceiling: executableSwap.root,
      mode: "discover",
    });
    const executableExecutor = await createNodeGitMetadataExecutor(executableSelection, {
      gitExecutable: executable,
    });
    await appendFile(executable, Buffer.from([0]));
    await expect(
      executableExecutor(resolveHeadRequest(), new AbortController().signal),
    ).resolves.toMatchObject({ exitCode: 1 });
    await rm(executable);
    await expect(
      executableExecutor(resolveHeadRequest(), new AbortController().signal),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  test("detects an actual concurrent HEAD move between the path probes and final verification", async () => {
    const state = await repository();
    const tree = await git(state.root, ["write-tree"]);
    const movedHead = await git(state.root, ["commit-tree", tree, "-p", state.base, "-m", "moved"]);
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const scope = createChangedFileScanScope(selection);
    const actual = await createNodeGitMetadataExecutor(selection);
    const movingExecutor: GitMetadataExecutor = async (request, signal) => {
      const response = await actual(request, signal);
      if (request.kind === "index-state")
        await git(state.root, ["update-ref", "HEAD", movedHead, state.base]);
      return response;
    };

    await expect(
      collectGitChangedFileMetadata(createGitMetadataCapability(scope, movingExecutor), {
        baseReference: state.base,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ reason: "command-failed", state: "fallback" });
  });

  test("collects exact 64-character identities from a SHA-256 repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-context-i07-sha256-"));
    roots.push(root);
    await git(root, ["init", "--quiet", "--object-format=sha256"]);
    await writeFile(path.join(root, "AGENTS.md"), "# SHA-256\n", "utf8");
    await git(root, ["add", "--", "AGENTS.md"]);
    await git(root, ["commit", "--quiet", "-m", "initial"]);
    const base = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "AGENTS.md"), "# SHA-256 changed\n", "utf8");

    const result = await collect(root, base);

    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.baseCommit).toHaveLength(64);
    expect(result.headCommit).toHaveLength(64);
    expect(result.mergeBase).toHaveLength(64);
  });

  test("returns a bounded failure for an executable that cannot spawn as Git", () => {
    expect(
      mapGitSpawnFailureForTest(() => {
        throw Object.assign(new Error("synthetic spawn rejection"), { code: "ENOEXEC" });
      }),
    ).toEqual({
      exitCode: 1,
      stdout: new Uint8Array(),
    });
    expect(mapGitSpawnFailureForTest(() => Object.freeze({ admitted: true }))).toBeNull();
  });

  test("rejects non-Git, explicit-only, and repository-contained executable authority", async () => {
    const state = await repository();
    const explicit = await selectRepositoryRoot(state.root, { mode: "explicit" });
    await expect(createNodeGitMetadataExecutor(explicit)).rejects.toThrow(
      "requires a discovered Git repository root",
    );

    const discovered = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    await expect(
      createNodeGitMetadataExecutor(discovered, {
        gitExecutable: path.join(state.root, "hostile-helper.sh"),
      }),
    ).rejects.toThrow("trusted Git executable is unavailable");
  });

  test("rejects accessor, proxy, inherited, decorated, nullish, and out-of-range host options", async () => {
    const state = await repository();
    const selection = await selectRepositoryRoot(state.root, {
      ceiling: state.root,
      mode: "discover",
    });
    const getter = vi.fn(() => 1);
    const accessor = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperty(accessor, "maximumOutputBytes", { enumerable: true, get: getter });
    const inherited = Object.create({ maximumOutputBytes: 1 }) as Record<string, unknown>;

    for (const options of [
      accessor,
      inherited,
      Object.assign(Object.create(null) as Record<string, unknown>, { maximumOutputBytes: 1 }),
      new Proxy({ maximumOutputBytes: 1 }, {}),
      { extra: true },
      { gitExecutable: undefined },
      { maximumDurationMs: undefined },
      { maximumOutputBytes: undefined },
    ])
      await expect(createNodeGitMetadataExecutor(selection, options as never)).rejects.toThrow(
        "options are invalid",
      );
    expect(getter).not.toHaveBeenCalled();

    for (const options of [
      { maximumOutputBytes: 0 },
      { maximumOutputBytes: 16_777_217 },
      { maximumDurationMs: 0 },
      { maximumDurationMs: 29_501 },
      { maximumPreflightDurationMs: 0 },
      { maximumPreflightDurationMs: 30_001 },
    ])
      await expect(createNodeGitMetadataExecutor(selection, options)).rejects.toThrow(
        "limit is invalid",
      );

    const hostDirectory = await mkdtemp(path.join(tmpdir(), "agent-context-i07-host-directory-"));
    roots.push(hostDirectory);
    await expect(
      createNodeGitMetadataExecutor(selection, { gitExecutable: hostDirectory }),
    ).rejects.toThrow("trusted Git executable is unavailable");

    for (const gitExecutable of ["", "git", `git${String.fromCharCode(0)}`])
      await expect(createNodeGitMetadataExecutor(selection, { gitExecutable })).rejects.toThrow(
        "trusted Git executable is unavailable",
      );

    const hostLinkRoot = await mkdtemp(path.join(tmpdir(), "agent-context-i07-host-link-"));
    roots.push(hostLinkRoot);
    const hostLink = path.join(hostLinkRoot, "outside-link");
    await symlink(path.join(state.root, "src.ts"), hostLink);
    await expect(
      createNodeGitMetadataExecutor(selection, { gitExecutable: hostLink }),
    ).rejects.toThrow("trusted Git executable is unavailable");
  });

  test.runIf(process.platform !== "win32")(
    "rejects a repository marker replaced by a special file",
    async () => {
      const state = await repository();
      const selection = await selectRepositoryRoot(state.root, {
        ceiling: state.root,
        mode: "discover",
      });
      await rename(path.join(state.root, ".git"), path.join(state.root, ".git-real"));
      await execFileAsync("/usr/bin/mkfifo", [path.join(state.root, ".git")]);

      await expect(createNodeGitMetadataExecutor(selection)).rejects.toThrow(
        "marker has an unsupported file type",
      );
    },
  );

  test("rejects pre-execution root and oversized worktree-marker mutations", async () => {
    const changedRoot = await repository();
    const rootSelection = await selectRepositoryRoot(changedRoot.root, {
      ceiling: changedRoot.root,
      mode: "discover",
    });
    const moved = `${changedRoot.root}-pre-execution`;
    roots.push(moved);
    await rename(changedRoot.root, moved);
    await mkdir(changedRoot.root);
    await expect(createNodeGitMetadataExecutor(rootSelection)).rejects.toThrow(
      "root identity changed",
    );

    const linkedState = await repository();
    const linked = path.join(linkedState.root, "oversized-marker");
    await git(linkedState.root, ["worktree", "add", "--quiet", "-b", "oversized-test", linked]);
    const linkedSelection = await selectRepositoryRoot(linked, {
      ceiling: linked,
      mode: "discover",
    });
    await writeFile(path.join(linked, ".git"), `gitdir: ${"x".repeat(4_096)}\n`, "utf8");
    await expect(createNodeGitMetadataExecutor(linkedSelection)).rejects.toThrow(
      "contents exceed the identity limit",
    );
  });
});
