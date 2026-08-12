import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(
  (): {
    readonly compare: ReturnType<typeof vi.fn>;
    readonly issued: WeakSet<object>;
    readonly render: ReturnType<typeof vi.fn>;
    readonly write: ReturnType<typeof vi.fn>;
  } => {
    const issued = new WeakSet<object>();
    return {
      compare: vi.fn(({ baseline, candidate }: { baseline: object; candidate: object }) => ({
        baseline,
        candidate,
        recordKind: "agent-context-efficiency-comparison",
      })),
      issued,
      render: vi.fn(() => "Context efficiency: 0/100 (F)\nStatic analysis only.\n"),
      write: vi.fn(
        async (
          value: { readonly recordKind: string },
          sink: { readonly write: (text: string) => Promise<void> },
        ) => sink.write(`{"recordKind":"${value.recordKind}"}\n`),
      ),
    };
  },
);

vi.mock("@agent-context/efficiency/report", (): object => ({
  compareContextEfficiencyReports: mocks.compare,
  isIssuedContextEfficiencyReport: (value: unknown) =>
    typeof value === "object" && value !== null && mocks.issued.has(value),
  renderContextEfficiencyTerminal: mocks.render,
  writeContextEfficiencyJson: mocks.write,
}));

import { runCommandRouter } from "../src/command-router.js";
import type { CliRunResult } from "../src/command-router.js";
import { createEfficiencyCommandHandlers } from "../src/efficiency-command.js";

function report(): object {
  const value = Object.freeze({ recordKind: "agent-context-efficiency-report" });
  mocks.issued.add(value);
  return value;
}

async function invoke(
  argv: readonly string[],
  handlers: ReturnType<typeof createEfficiencyCommandHandlers>,
): Promise<{
  readonly result: CliRunResult;
  readonly stderr: string[];
  readonly stdout: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runCommandRouter(
    {
      argv,
      signal: new AbortController().signal,
      stderr: { write: (text: string) => void stderr.push(text) },
      stdout: { write: (text: string) => void stdout.push(text) },
    },
    handlers,
  );
  return { result, stderr, stdout };
}

describe("G09 CLI efficiency handler boundary", () => {
  test("passes the closed request to an injected source and remains exit-neutral", async () => {
    const output = report();
    const load = vi.fn(() => output);
    const handlers = createEfficiencyCommandHandlers({ source: { load } });
    const result = await invoke(
      ["efficiency", "./repository", "--agent", "codex-cli", "--no-color", "--width", "40"],
      handlers,
    );
    expect(result.result).toEqual({ exitCode: 0, operationalError: null });
    expect(result.stderr).toEqual([]);
    expect(result.stdout.join("")).toContain("0/100 (F)");
    expect(load).toHaveBeenCalledWith({
      agent: "codex-cli",
      comparePath: null,
      repository: "./repository",
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(mocks.render).toHaveBeenCalledWith(output, { colorMode: "never", width: 40 });
  });

  test("uses genuine report pairs for JSON comparison and awaits output", async () => {
    const baseline = report();
    const candidate = report();
    const handlers = createEfficiencyCommandHandlers({
      source: { load: () => ({ baseline, candidate }) },
    });
    const result = await invoke(
      ["efficiency", "--compare", "candidate", "--format", "json"],
      handlers,
    );
    expect(result.result.exitCode).toBe(0);
    expect(mocks.compare).toHaveBeenCalledWith({ baseline, candidate });
    expect(result.stdout.join("")).toBe('{"recordKind":"agent-context-efficiency-comparison"}\n');
  });

  test("rejects forged source results and hostile capability containers without reflection", async () => {
    const forged = await invoke(
      ["efficiency"],
      createEfficiencyCommandHandlers({ source: { load: () => ({}) } }),
    );
    expect(forged.result).toMatchObject({
      exitCode: 2,
      operationalError: { code: "command-failed" },
    });
    expect(forged.stderr.join("")).not.toContain("invalid result");

    const accessor = {};
    Object.defineProperty(accessor, "source", {
      enumerable: true,
      get: (): object => ({ load: (): object => report() }),
    });
    expect(() => createEfficiencyCommandHandlers(new Proxy({}, {}))).toThrow();
    expect(() => createEfficiencyCommandHandlers(accessor)).toThrow();
    expect(() =>
      createEfficiencyCommandHandlers({ source: { load: new Proxy(() => report(), {}) } }),
    ).toThrow();

    for (const invalid of [
      null,
      [],
      {},
      { source: null },
      { source: [] },
      { source: {} },
      { source: { load: null } },
      { source: { load: (): object => report(), extra: true } },
      { source: { load: (): object => report() }, extra: true },
      Object.create(null, {
        source: { enumerable: false, value: { load: () => report() } },
      }),
    ])
      expect(() => createEfficiencyCommandHandlers(invalid)).toThrow(
        "invalid efficiency command capability",
      );

    const invalidComparison = await invoke(
      ["efficiency", "--compare", "candidate"],
      createEfficiencyCommandHandlers({ source: { load: () => ({}) } }),
    );
    expect(invalidComparison.result.exitCode).toBe(2);

    const forgedPair = await invoke(
      ["efficiency", "--compare", "candidate"],
      createEfficiencyCommandHandlers({
        source: { load: () => ({ baseline: {}, candidate: {} }) },
      }),
    );
    expect(forgedPair.result.exitCode).toBe(2);
  });

  test("chunks large Unicode-safe terminal output and applies terminal defaults", async () => {
    const output = report();
    mocks.render.mockReturnValueOnce(`${"界".repeat(30_000)}\n`);
    const result = await invoke(
      ["efficiency"],
      createEfficiencyCommandHandlers({ source: { load: () => Promise.resolve(output) } }),
    );
    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(1);
    expect(result.stdout.join("")).toBe(`${"界".repeat(30_000)}\n`);
    expect(mocks.render).toHaveBeenCalledWith(output, { colorMode: "ansi", width: 80 });
  });
});
