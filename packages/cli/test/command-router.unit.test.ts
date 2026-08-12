import { describe, expect, it, vi } from "vitest";

import {
  CLI_AGENT_PROFILES,
  CLI_COMMAND_DEFINITIONS,
  CLI_COMMAND_REGISTRY_VERSION,
  CLI_EXIT_CODES,
  CLI_GLOBAL_OPTIONS,
  CLI_LIMITS,
  CLI_VERSION,
  runCommandRouter,
} from "../src/command-router.js";

import type {
  CliCommandContext,
  CliCommandHandlers,
  CliInvocation,
  CliRunResult,
} from "../src/command-router.js";

interface CapturedInvocation {
  readonly invocation: CliInvocation;
  readonly stderr: string[];
  readonly stdout: string[];
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function captureInvocation(
  argv: readonly string[],
  controller: AbortController = new AbortController(),
): CapturedInvocation {
  const stderr: string[] = [];
  const stdout: string[] = [];
  return {
    invocation: {
      argv,
      signal: controller.signal,
      stderr: { write: (text): void => void stderr.push(text) },
      stdout: { write: (text): void => void stdout.push(text) },
    },
    stderr,
    stdout,
  };
}

async function invoke(
  argv: readonly string[],
  handlers: CliCommandHandlers = {},
): Promise<CapturedInvocation & { readonly result: CliRunResult }> {
  const captured = captureInvocation(argv);
  const result = await runCommandRouter(captured.invocation, handlers);
  return { ...captured, result };
}

describe("command router", () => {
  it("publishes one deeply immutable registry for routing and generated documentation", () => {
    expect(CLI_COMMAND_REGISTRY_VERSION).toBe("1.0.0");
    expect(CLI_COMMAND_DEFINITIONS.map(({ name }) => name)).toEqual([
      "scan",
      "list",
      "explain",
      "rules",
      "init",
      "standards",
      "efficiency",
    ]);
    expect(new Set(CLI_COMMAND_DEFINITIONS.map(({ name }) => name)).size).toBe(
      CLI_COMMAND_DEFINITIONS.length,
    );
    expect(CLI_AGENT_PROFILES).toHaveLength(8);
    const scanSurface = CLI_COMMAND_DEFINITIONS.find(
      (entry) => entry.name === "scan",
    )?.options.find((option) => option.names.includes("--surface"));
    const explainSurface = CLI_COMMAND_DEFINITIONS.find(
      (entry) => entry.name === "explain",
    )?.options.find((option) => option.names.includes("--surface"));
    expect(scanSurface?.values).toContain("claude-code/local-session");
    expect(explainSurface?.values).not.toContain("claude-code/local-session");
    expect(CLI_GLOBAL_OPTIONS.flatMap(({ names }) => names)).toEqual([
      "-h",
      "--help",
      "-V",
      "--version",
    ]);
    expect(Object.isFrozen(CLI_COMMAND_DEFINITIONS)).toBe(true);
    for (const definition of CLI_COMMAND_DEFINITIONS) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.options)).toBe(true);
      expect(Object.isFrozen(definition.validFirstOperands)).toBe(true);
      for (const option of definition.options) {
        expect(Object.isFrozen(option)).toBe(true);
        expect(Object.isFrozen(option.names)).toBe(true);
        expect(Object.isFrozen(option.values)).toBe(true);
      }
    }
  });

  it("renders stable root help for an empty invocation and both help aliases", async () => {
    const empty = await invoke([]);
    const long = await invoke(["--help"]);
    const short = await invoke(["-h"]);

    expect(empty.result).toEqual({ exitCode: 0, operationalError: null });
    expect(empty.stdout).toEqual(long.stdout);
    expect(long.stdout).toEqual(short.stdout);
    expect(empty.stderr).toEqual([]);
    expect(empty.stdout[0]).toContain(`Agent Context Linter ${CLI_VERSION}`);
    expect(empty.stdout[0]).toContain("scan [repository]");
    expect(empty.stdout[0]).toContain("[unavailable]");
    expect(empty.stdout[0]).toContain("130 SIGINT");
  });

  it("renders a deterministic package version for both aliases", async () => {
    const long = await invoke(["--version"]);
    const short = await invoke(["-V"]);

    expect(long.result.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(long.stdout).toEqual([`${CLI_VERSION}\n`]);
    expect(short.stdout).toEqual(long.stdout);
  });

  it.each([
    ["scan", "I02"],
    ["list", "I03"],
    ["explain", "I03"],
    ["rules", "I03"],
    ["init", "I03"],
    ["standards", "H06/H08/H09"],
    ["efficiency", "G09"],
  ] as const)("documents %s honestly as unavailable", async (command, ticket) => {
    const result = await invoke([command, "--help"]);

    expect(result.result.exitCode).toBe(CLI_EXIT_CODES.success);
    expect(result.stderr).toEqual([]);
    expect(result.stdout.join("")).toContain(`implementation is tracked by ${ticket}`);
    expect(result.stdout.join("")).not.toContain("Status: available.");
  });

  it("returns exit 2 when a syntactically valid planned command has no handler", async () => {
    const result = await invoke(["scan"]);

    expect(result.result).toMatchObject({
      exitCode: 2,
      operationalError: { code: "command-unavailable" },
    });
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([
      "agent-context-lint: command is not available in this build.\n" +
        "Run 'agent-context-lint --help' for usage and command availability.\n",
    ]);
  });

  it("admits only the paired changed-file grammar and preserves the exact bounded base ref", async () => {
    let observed: string | null = null;
    const accepted = await invoke(["scan", "--changed", "--base", "origin/main"], {
      scan: (context) => {
        observed = context.changedBaseReference;
        return { status: "success" };
      },
    });
    expect(accepted.result.exitCode).toBe(0);
    expect(observed).toBe("origin/main");

    for (const argv of [
      ["scan", "--changed"],
      ["scan", "--base", "main"],
      ["scan", "--changed", "--changed", "--base", "main"],
      ["scan", "--changed", "--base", "main", "--base", "other"],
      ["scan", "--changed", "--base", "x".repeat(1_025)],
      ["scan", "--changed", "--base", "--format", "json"],
      ["list", "--changed", "--base", "main"],
    ])
      console.log("DEBUG argv", argv, (await invoke(argv)).result);
    for (const argv of [
      ["standards", "status", "--dry-run"],
      ["standards", "check", "--cache", "/tmp/standards-cache"],
      ["standards", "update", "--cache", "relative"],
      ["standards", "update", "--dry-run", "--dry-run"],
      ["standards", "update", "--dry-run", "--cache", "/tmp/standards-cache"],
    ]) {
      expect((await invoke(argv)).result).toMatchObject({
        exitCode: 2,
        operationalError: { code: "invalid-arguments" },
      });
    }
  });

  it.each([
    [["not-a-command"], "unknown-command"],
    [["--wat"], "unknown-option"],
    [["scan", "--wat"], "unknown-option"],
    [["--help", "extra"], "invalid-arguments"],
    [["--version", "extra"], "invalid-arguments"],
    [["explain"], "invalid-arguments"],
    [["explain", "one", "two"], "invalid-arguments"],
    [["rules", "extra"], "invalid-arguments"],
    [["standards"], "invalid-arguments"],
    [["standards", "other"], "invalid-arguments"],
  ] as const)("maps malformed argv %j to a bounded usage failure", async (argv, code) => {
    const result = await invoke(argv);

    expect(result.result).toMatchObject({ exitCode: 2, operationalError: { code } });
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join("")).not.toContain(argv.join(" "));
    expect(Buffer.byteLength(result.stderr.join(""))).toBeLessThan(256);
  });

  it("maps handler success, policy failure, and operational failure to 0, 1, and 2", async () => {
    const success = await invoke(["scan", "fixture"], {
      scan: async ({ operands, writeStdout }) => {
        await writeStdout(`${operands[0] ?? ""}\n`);
        return { status: "success" };
      },
    });
    const policy = await invoke(["scan"], { scan: () => ({ status: "policy-failure" }) });
    const operational = await invoke(["scan"], {
      scan: () => ({ status: "operational-failure" }),
    });

    expect(success.result.exitCode).toBe(0);
    expect(success.stdout).toEqual(["fixture\n"]);
    expect(policy.result.exitCode).toBe(1);
    expect(operational.result).toMatchObject({
      exitCode: 2,
      operationalError: { code: "command-failed" },
    });
  });

  it("passes the scan-only --fix-dry-run capability without treating it as a repository operand", async () => {
    const observed: { fixDryRun?: boolean; operands?: readonly string[] } = {};
    const result = await invoke(["scan", "fixture", "--fix-dry-run"], {
      scan: ({ fixDryRun, operands }) => {
        observed.fixDryRun = fixDryRun;
        observed.operands = operands;
        return { status: "success" };
      },
    });

    expect(result.result.exitCode).toBe(0);
    expect(observed).toEqual({ fixDryRun: true, operands: ["fixture"] });
    expect(
      (
        await invoke(["scan"], {
          scan: ({ fixDryRun }) => ({ status: fixDryRun ? "operational-failure" : "success" }),
        })
      ).result.exitCode,
    ).toBe(0);
    expect((await invoke(["scan", "--fix-dry-run", "--fix-dry-run"])).result).toMatchObject({
      exitCode: 2,
      operationalError: { code: "invalid-arguments" },
    });
    expect((await invoke(["list", "--fix-dry-run"])).result).toMatchObject({
      exitCode: 2,
      operationalError: { code: "invalid-arguments" },
    });
    expect((await invoke(["scan", "--fix-dry-run=1"])).result).toMatchObject({
      exitCode: 2,
      operationalError: { code: "unknown-option" },
    });
    expect(
      (
        await invoke(["scan", "--fix-dry-run", "fixture"], {
          scan: ({ fixDryRun, operands }) => ({
            status: fixDryRun && operands[0] === "fixture" ? "success" : "operational-failure",
          }),
        })
      ).result.exitCode,
    ).toBe(0);
  });

  it("passes standards dry-run and explicit cache capabilities only to update", async () => {
    const observed: Partial<CliCommandContext> = {};
    const result = await invoke(["standards", "update", "--dry-run", "--format", "json"], {
      standards: (context) => {
        Object.assign(observed, context);
        return { status: "success" };
      },
    });
    expect(result.result.exitCode).toBe(0);
    expect(observed).toMatchObject({
      format: "json",
      operands: ["update"],
      standardsCachePath: null,
      standardsDryRun: true,
    });
    for (const argv of [
      ["standards", "status", "--dry-run"],
      ["standards", "check", "--cache", "/tmp/standards-cache"],
      ["standards", "update", "--cache", "relative"],
      ["standards", "update", "--dry-run", "--dry-run"],
      ["standards", "update", "--dry-run", "--cache", "/tmp/standards-cache"],
    ]) {
      console.log("DEBUG", argv, (await invoke(argv)).result);
      expect((await invoke(argv)).result).toMatchObject({
        exitCode: 2,
        operationalError: { code: "invalid-arguments" },
      });
    }
  });

  it("passes only a bounded explicit scan concurrency ceiling", async () => {
    let observed: number | null | undefined;
    const accepted = await invoke(["scan", "fixture", "--maximum-concurrency", "10"], {
      scan: ({ maximumConcurrency }) => {
        observed = maximumConcurrency;
        return { status: "success" };
      },
    });
    expect(accepted.result.exitCode).toBe(0);
    expect(observed).toBe(10);
    for (const argv of [
      ["scan", "--maximum-concurrency", "0"],
      ["scan", "--maximum-concurrency", "11"],
      ["scan", "--maximum-concurrency", "2", "--maximum-concurrency", "3"],
      ["list", "--maximum-concurrency", "1"],
    ])
      expect((await invoke(argv)).result).toMatchObject({
        exitCode: 2,
        operationalError: { code: "invalid-arguments" },
      });
  });

  it("parses the closed I03 agent, trace, and output-format grammar", async () => {
    const observed: Partial<CliCommandContext> = {};
    const result = await invoke(
      [
        "explain",
        "src/index.ts",
        "--agent",
        "cursor-agent",
        "--surface",
        "cursor-agent/cli",
        "--trace",
        "trace.json",
        "--format",
        "json",
      ],
      {
        explain: (context) => {
          Object.assign(observed, context);
          return { status: "success" };
        },
      },
    );

    expect(result.result.exitCode).toBe(0);
    expect(observed).toMatchObject({
      agent: "cursor-agent",
      fixDryRun: false,
      format: "json",
      operands: ["src/index.ts"],
      surface: "cursor-agent/cli",
      tracePath: "trace.json",
    });
    expect(
      (
        await invoke(["rules", "--format", "terminal"], {
          rules: ({ format }) => ({
            status: format === "terminal" ? "success" : "operational-failure",
          }),
        })
      ).result.exitCode,
    ).toBe(0);
  });

  it.each([
    ["list", "--agent", "codex-cli"],
    ["rules", "--trace", "trace.json"],
    ["init", "--format", "json"],
    ["explain", "target", "--agent", "unknown"],
    ["explain", "target", "--agent", "codex-cli", "--agent", "codex-cli"],
    ["explain", "target", "--trace", "a", "--trace", "b"],
    ["explain", "target", "--surface", "cursor-agent/cli"],
    ["explain", "target", "--agent", "codex-cli", "--surface", "cursor-agent/cli"],
    ["explain", "target", "--agent", "cursor-agent", "--surface", "unknown"],
    [
      "explain",
      "target",
      "--agent",
      "cursor-agent",
      "--surface",
      "cursor-agent/cli",
      "--surface",
      "cursor-agent/ide",
    ],
    ["list", "--format", "yaml"],
    ["rules", "--format", "json", "--format", "json"],
    ["explain", "target", "--trace", "--format", "json"],
  ])("rejects invalid I03 option grammar: %j", async (...argv) => {
    const result = await invoke(argv);
    expect(result.result).toMatchObject({
      exitCode: CLI_EXIT_CODES.operationalFailure,
      operationalError: { code: "invalid-arguments" },
    });
  });

  it("parses the closed G09 agent, format, comparison, color, and width grammar", async () => {
    const observed: Partial<CliCommandContext> = {};
    const result = await invoke(
      [
        "efficiency",
        "src/index.ts",
        "--agent",
        "codex-cli",
        "--format",
        "json",
        "--compare",
        "../candidate",
        "--no-color",
        "--width",
        "40",
      ],
      {
        efficiency: (context) => {
          Object.assign(observed, context);
          return { status: "success" };
        },
      },
    );
    expect(result.result.exitCode).toBe(0);
    expect(observed).toMatchObject({
      agent: "codex-cli",
      comparePath: "../candidate",
      format: "json",
      noColor: true,
      operands: ["src/index.ts"],
      width: 40,
    });
    for (const argv of [
      ["efficiency", "--width", "39"],
      ["efficiency", "--width", "241"],
      ["efficiency", "--width", "080"],
      ["efficiency", "--width", "80", "--width", "80"],
      ["efficiency", "--compare", "--format", "json"],
      ["efficiency", "--no-color", "--no-color"],
      ["efficiency", "--agent", "unknown"],
      ["scan", "--width", "80"],
    ])
      expect((await invoke(argv)).result).toMatchObject({
        exitCode: 2,
        operationalError: { code: "invalid-arguments" },
      });
  });

  it("marks installed handlers as available in root and command help", async () => {
    const handlers = { scan: (): { readonly status: "success" } => ({ status: "success" }) };
    const root = await invoke([], handlers);
    const command = await invoke(["scan", "--help"], handlers);

    expect(root.stdout.join("")).toMatch(/scan \[repository\].*\[available\]/u);
    expect(command.stdout.join("")).toContain("Status: available.");
  });

  it("never reflects thrown values, rejection text, or hostile argv", async () => {
    const secret = "SECRET\u001b[31m\nnext-line";
    const thrown = await invoke(["scan"], {
      scan: () => {
        throw new Error(secret);
      },
    });
    const rejected = await invoke(["scan"], {
      scan: () => Promise.reject(new Proxy(new Error(secret), {})),
    });
    const revoked = Proxy.revocable(new Error(secret), {});
    revoked.revoke();
    const revokedRejection = await invoke(["scan"], {
      scan: () => Promise.reject(revoked.proxy),
    });
    const unknown = await invoke([`unknown-${secret}`]);

    for (const result of [thrown, rejected, revokedRejection, unknown]) {
      expect(result.result.exitCode).toBe(2);
      expect(result.stderr.join("")).not.toContain("SECRET");
      expect(result.stderr.join("")).not.toContain("\u001b");
    }
  });

  it("rejects proxy, revoked, accessor, sparse, decorated, symbolic, and control argv", async () => {
    const getter = vi.fn(() => "scan");
    const accessor: string[] = ["scan"];
    Object.defineProperty(accessor, "0", { configurable: true, enumerable: true, get: getter });
    const sparse = Array.from<string>({ length: 2 });
    sparse[0] = "scan";
    const decorated = ["scan"];
    Object.defineProperty(decorated, "extra", { value: "ignored" });
    const symbolic = ["scan"];
    Object.defineProperty(symbolic, Symbol("secret"), { value: "ignored" });
    const revocable = Proxy.revocable(["scan"], {});
    revocable.revoke();
    const cases: unknown[] = [
      new Proxy(["scan"], {}),
      revocable.proxy,
      accessor,
      sparse,
      decorated,
      symbolic,
      ["scan\nforged"],
      ["scan\u202e"],
      ["\ud800"],
      new Array(CLI_LIMITS.maximumArgumentCount + 1).fill("x"),
      ["x".repeat(CLI_LIMITS.maximumArgumentBytes + 1)],
    ];

    for (const argv of cases) {
      const result = await runCommandRouter({
        argv,
        signal: new AbortController().signal,
        stderr: { write: vi.fn() },
        stdout: { write: vi.fn() },
      });
      expect(result).toMatchObject({
        exitCode: 2,
        operationalError: { code: "invalid-invocation" },
      });
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("accepts exact argv limits and rejects the first value beyond them", async () => {
    const maximumArgument = "x".repeat(CLI_LIMITS.maximumArgumentBytes);
    const exactTotal = Array.from({ length: 16 }, () => maximumArgument);
    const overTotal = Array.from({ length: 17 }, () => maximumArgument);
    const exactCount = Array.from({ length: CLI_LIMITS.maximumArgumentCount }, () => "x");
    const overCount = Array.from({ length: CLI_LIMITS.maximumArgumentCount + 1 }, () => "x");

    const exactArgumentResult = await invoke(["scan", maximumArgument], {
      scan: () => ({ status: "success" }),
    });
    const exactTotalResult = await invoke(exactTotal);
    const exactCountResult = await invoke(exactCount);
    const overTotalResult = await runCommandRouter({
      argv: overTotal,
      signal: new AbortController().signal,
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    });
    const overCountResult = await runCommandRouter({
      argv: overCount,
      signal: new AbortController().signal,
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    });

    expect(exactArgumentResult.result.exitCode).toBe(0);
    expect(exactTotalResult.result.operationalError?.code).toBe("unknown-command");
    expect(exactCountResult.result.operationalError?.code).toBe("unknown-command");
    expect(overTotalResult.operationalError?.code).toBe("invalid-invocation");
    expect(overCountResult.operationalError?.code).toBe("invalid-invocation");
  });

  it("rejects proxy and accessor invocation capabilities without invoking traps", async () => {
    const getter = vi.fn(() => []);
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "argv", { enumerable: true, get: getter });
    Object.defineProperty(accessor, "signal", {
      enumerable: true,
      value: new AbortController().signal,
    });
    Object.defineProperty(accessor, "stderr", { enumerable: true, value: { write: vi.fn() } });
    Object.defineProperty(accessor, "stdout", { enumerable: true, value: { write: vi.fn() } });

    const proxyResult = await runCommandRouter(new Proxy({}, {}));
    const accessorResult = await runCommandRouter(accessor);

    expect(proxyResult).toMatchObject({
      exitCode: 2,
      operationalError: { code: "invalid-invocation" },
    });
    expect(accessorResult).toMatchObject({
      exitCode: 2,
      operationalError: { code: "invalid-invocation" },
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects hostile output and handler capabilities without invoking them", async () => {
    const proxiedWrite = new Proxy(vi.fn(), {});
    const outputResult = await runCommandRouter({
      argv: [],
      signal: new AbortController().signal,
      stderr: { write: vi.fn() },
      stdout: { write: proxiedWrite },
    });
    const handler = new Proxy(vi.fn(), {});
    const handlerInvocation = captureInvocation(["scan"]);
    const handlerResult = await runCommandRouter(handlerInvocation.invocation, { scan: handler });
    const registryProxyResult = await runCommandRouter(
      handlerInvocation.invocation,
      new Proxy({}, {}),
    );
    const handlerGetter = vi.fn(() => vi.fn());
    const accessorRegistry = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorRegistry, "scan", { enumerable: true, get: handlerGetter });
    const accessorResult = await runCommandRouter(handlerInvocation.invocation, accessorRegistry);

    expect(outputResult.operationalError?.code).toBe("invalid-invocation");
    expect(handlerResult.operationalError?.code).toBe("invalid-invocation");
    expect(registryProxyResult.operationalError?.code).toBe("invalid-invocation");
    expect(accessorResult.operationalError?.code).toBe("invalid-invocation");
    expect(proxiedWrite).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(handlerGetter).not.toHaveBeenCalled();
  });

  it("returns 130 before parsing when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const captured = captureInvocation(["scan"], controller);
    const handler = vi.fn();

    const result = await runCommandRouter(captured.invocation, { scan: handler });

    expect(result).toEqual({ exitCode: 130, operationalError: null });
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("uses intrinsic AbortSignal state without invoking own or subclass accessors", async () => {
    let callbacks = 0;
    type Behavior = false | true | "throw";
    const callerState = (behavior: Behavior): boolean => {
      callbacks += 1;
      if (behavior === "throw") throw new Error("private-signal-accessor-data");
      return behavior;
    };
    const ownSignal = (behavior: Behavior): AbortSignal => {
      const signal = new AbortController().signal;
      Object.defineProperties(signal, {
        aborted: { get: () => callerState(behavior) },
        addEventListener: { get: () => callerState("throw") },
        removeEventListener: { get: () => callerState("throw") },
      });
      return signal;
    };
    const subclassSignal = (behavior: Behavior): AbortSignal => {
      const signal = new AbortController().signal;
      class CallerSignal extends AbortSignal {
        public override get aborted(): boolean {
          return callerState(behavior);
        }
      }
      Object.setPrototypeOf(signal, CallerSignal.prototype);
      return signal;
    };

    for (const signal of [
      ownSignal(false),
      ownSignal(true),
      ownSignal("throw"),
      subclassSignal(false),
      subclassSignal(true),
      subclassSignal("throw"),
    ]) {
      const captured = captureInvocation([]);
      const result = await runCommandRouter({ ...captured.invocation, signal });
      expect(result.exitCode).toBe(0);
    }

    const abortedController = new AbortController();
    abortedController.abort();
    Object.defineProperty(abortedController.signal, "aborted", {
      get: () => callerState(false),
    });
    const aborted = captureInvocation([]);
    const abortedResult = await runCommandRouter({
      ...aborted.invocation,
      signal: abortedController.signal,
    });

    expect(abortedResult).toEqual({ exitCode: 130, operationalError: null });
    expect(aborted.stdout).toEqual([]);
    expect(callbacks).toBe(0);
  });

  it("rejects forged AbortSignal brands without invoking output", async () => {
    const captured = captureInvocation([]);
    const forgedSignal = Object.create(AbortSignal.prototype) as AbortSignal;

    const result = await runCommandRouter({ ...captured.invocation, signal: forgedSignal });

    expect(result).toMatchObject({
      exitCode: 2,
      operationalError: { code: "invalid-invocation" },
    });
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toEqual([]);
  });

  it("propagates cancellation during an asynchronous command as exit 130", async () => {
    const controller = new AbortController();
    const captured = captureInvocation(["scan"], controller);
    const started = deferred();
    const running = runCommandRouter(captured.invocation, {
      scan: ({ signal }: CliCommandContext) =>
        new Promise((resolve) => {
          started.resolve();
          signal.addEventListener(
            "abort",
            () => {
              resolve({ status: "success" });
            },
            { once: true },
          );
        }),
    });
    await started.promise;
    controller.abort();

    expect(await running).toEqual({ exitCode: 130, operationalError: null });
    expect(captured.stderr).toEqual([]);
  });

  it("stops waiting for non-settling handlers and output capabilities after cancellation", async () => {
    const handlerController = new AbortController();
    const handlerInvocation = captureInvocation(["scan"], handlerController);
    const handlerStarted = deferred();
    const handlerRun = runCommandRouter(handlerInvocation.invocation, {
      scan: () =>
        new Promise(() => {
          handlerStarted.resolve();
        }),
    });
    await handlerStarted.promise;
    handlerController.abort();

    const outputController = new AbortController();
    const outputStarted = deferred();
    const outputRun = runCommandRouter({
      argv: ["--help"],
      signal: outputController.signal,
      stderr: { write: vi.fn() },
      stdout: {
        write: () =>
          new Promise(() => {
            outputStarted.resolve();
          }),
      },
    });
    await outputStarted.promise;
    outputController.abort();

    await expect(handlerRun).resolves.toEqual({ exitCode: 130, operationalError: null });
    await expect(outputRun).resolves.toEqual({ exitCode: 130, operationalError: null });
  });

  it("maps stdout, stderr, and broken-pipe-shaped failures without reflecting them", async () => {
    const stdoutFailure = await runCommandRouter({
      argv: ["--help"],
      signal: new AbortController().signal,
      stderr: { write: vi.fn() },
      stdout: {
        write: () => Promise.reject(Object.assign(new Error("secret"), { code: "EPIPE" })),
      },
    });
    const stderrFailure = await runCommandRouter({
      argv: ["unknown"],
      signal: new AbortController().signal,
      stderr: { write: () => Promise.reject(new Error("secret")) },
      stdout: { write: vi.fn() },
    });
    const synchronousFailure = await runCommandRouter({
      argv: ["--help"],
      signal: new AbortController().signal,
      stderr: { write: vi.fn() },
      stdout: {
        write: () => {
          throw new Error("secret");
        },
      },
    });

    expect(stdoutFailure).toMatchObject({
      exitCode: 2,
      operationalError: { code: "output-failed" },
    });
    expect(stderrFailure).toMatchObject({
      exitCode: 2,
      operationalError: { code: "output-failed" },
    });
    expect(synchronousFailure).toMatchObject({
      exitCode: 2,
      operationalError: { code: "output-failed" },
    });
  });

  it("enforces per-write output bounds for command handlers", async () => {
    const result = await invoke(["scan"], {
      scan: async ({ writeStdout }) => {
        await writeStdout("x".repeat(CLI_LIMITS.maximumOutputChunkBytes + 1));
        return { status: "success" };
      },
    });

    expect(result.result).toMatchObject({
      exitCode: 2,
      operationalError: { code: "output-failed" },
    });
    expect(result.stdout).toEqual([]);
  });

  it("enforces aggregate output and Unicode boundaries for command handlers", async () => {
    const chunk = "x".repeat(CLI_LIMITS.maximumOutputChunkBytes);
    const invocation = captureInvocation(["scan"]);
    const aggregate = await runCommandRouter(
      {
        ...invocation.invocation,
        stdout: { write: vi.fn() },
      },
      {
        scan: async ({ writeStdout }: CliCommandContext) => {
          const writes = CLI_LIMITS.maximumOutputBytes / CLI_LIMITS.maximumOutputChunkBytes + 1;
          for (let index = 0; index < writes; index += 1) await writeStdout(chunk);
          return { status: "success" };
        },
      },
    );
    const malformed = await invoke(["scan"], {
      scan: async ({ writeStdout }) => {
        await writeStdout("\ud800");
        return { status: "success" };
      },
    });

    expect(aggregate.operationalError?.code).toBe("output-failed");
    expect(malformed.result.operationalError?.code).toBe("output-failed");
  });

  it("rejects malformed completion records and leaves results deeply immutable", async () => {
    const proxyCompletion = new Proxy({ status: "success" as const }, {});
    const invalid = await invoke(["scan"], { scan: () => proxyCompletion });
    const invalidStatus = await invoke(["scan"], {
      scan: () => ({ status: "not-a-status" }) as never,
    });
    const usage = await invoke(["unknown"]);

    expect(invalid.result.operationalError?.code).toBe("command-failed");
    expect(invalidStatus.result.operationalError?.code).toBe("command-failed");
    expect(Object.isFrozen(usage.result)).toBe(true);
    expect(Object.isFrozen(usage.result.operationalError)).toBe(true);
  });
});
