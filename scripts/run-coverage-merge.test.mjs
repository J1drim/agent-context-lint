import assert from "node:assert/strict";
import test from "node:test";

import {
  COVERAGE_MAX_WORKERS,
  coverageCollectionArguments,
  coverageMergeArguments,
  resolvePnpmInvocation,
  runVitest,
} from "./run-coverage-merge.mjs";
import { normalizeCoverageMap } from "./normalize-coverage.mjs";

test("coverage normalization preserves status while discarding variable positive hit counts", () => {
  const source = {
    "/workspace/source.ts": {
      all: { nested: [3, 0] },
      b: { 0: [0, 7] },
      f: { 0: 12 },
      path: "/workspace/source.ts",
      s: { 0: 0, 1: 99 },
    },
  };
  assert.deepEqual(normalizeCoverageMap(source, "/workspace"), {
    "<workspace>/source.ts": {
      all: { nested: [3, 0] },
      b: { 0: [0, 1] },
      f: { 0: 1 },
      path: "<workspace>/source.ts",
      s: { 0: 0, 1: 1 },
    },
  });
  assert.equal(source["/workspace/source.ts"].s[1], 99);
  assert.deepEqual(
    normalizeCoverageMap(
      {
        "/workspace/source.ts": {
          b: { 0: [0, Number.MAX_SAFE_INTEGER] },
          f: { 0: Number.MAX_SAFE_INTEGER },
          path: "/workspace/source.ts",
          s: { 0: 0, 1: Number.MAX_SAFE_INTEGER },
        },
      },
      "/workspace",
    )["<workspace>/source.ts"],
    {
      b: { 0: [0, 1] },
      f: { 0: 1 },
      path: "<workspace>/source.ts",
      s: { 0: 0, 1: 1 },
    },
  );
});

test("coverage normalization rejects every malformed counter container and count boundary", () => {
  const valid = () => ({
    b: { 0: [0, 1] },
    f: { 0: 1 },
    path: "/workspace/source.ts",
    s: { 0: 1 },
  });
  const cases = [
    ["null statement counts", { ...valid(), s: null }, /coverage s counts must be an object/u],
    ["scalar statement counts", { ...valid(), s: 1 }, /coverage s counts must be an object/u],
    ["array statement counts", { ...valid(), s: [] }, /coverage s counts must be an object/u],
    ["null function counts", { ...valid(), f: null }, /coverage f counts must be an object/u],
    ["scalar function counts", { ...valid(), f: 1 }, /coverage f counts must be an object/u],
    ["array function counts", { ...valid(), f: [] }, /coverage f counts must be an object/u],
    ["null branch counts", { ...valid(), b: null }, /coverage b counts must be an object/u],
    ["scalar branch counts", { ...valid(), b: 1 }, /coverage b counts must be an object/u],
    ["array branch counts", { ...valid(), b: [] }, /coverage b counts must be an object/u],
    ["non-array branch arm", { ...valid(), b: { 0: {} } }, /branch counts must be arrays/u],
    ["negative count", { ...valid(), s: { 0: -1 } }, /non-negative safe integer/u],
    ["fractional count", { ...valid(), f: { 0: 1.5 } }, /non-negative safe integer/u],
    [
      "unsafe integer count",
      { ...valid(), b: { 0: [Number.MAX_SAFE_INTEGER + 1] } },
      /non-negative safe integer/u,
    ],
  ];
  for (const [label, record, expected] of cases) {
    assert.throws(
      () => normalizeCoverageMap({ "/workspace/source.ts": record }, "/workspace"),
      expected,
      label,
    );
  }
});

test("coverage collection uses a closed deterministic Vitest command", () => {
  assert.equal(COVERAGE_MAX_WORKERS, 1);
  assert.deepEqual(coverageCollectionArguments("unit", "/tmp/unit.json", "/tmp/reports"), [
    "run",
    "--no-color",
    "--project=unit",
    "--coverage",
    "--no-file-parallelism",
    "--maxWorkers=1",
    "--reporter=default",
    "--reporter=blob",
    "--outputFile.blob=/tmp/unit.json",
    "--coverage.reportsDirectory=/tmp/reports",
    "--coverage.reporter=json",
    "--coverage.thresholds.lines=0",
    "--coverage.thresholds.functions=0",
    "--coverage.thresholds.branches=0",
    "--coverage.thresholds.statements=0",
  ]);
  assert.equal(Object.isFrozen(coverageCollectionArguments("unit", "blob", "reports")), true);
});

test("coverage merge retains all reports and applies thresholds only after collection", () => {
  assert.deepEqual(coverageMergeArguments("/tmp/blobs", "/tmp/reports"), [
    "--merge-reports=/tmp/blobs",
    "--coverage",
    "--reporter=minimal",
    "--coverage.reportsDirectory=/tmp/reports",
    "--coverage.reporter=text",
    "--coverage.reporter=json",
    "--coverage.reporter=json-summary",
  ]);
});

test("coverage can use a sealed absolute Node and pnpm launcher without exposing its paths", () => {
  const environment = {
    AGENT_CONTEXT_PACK_NODE: "/sealed/node",
    AGENT_CONTEXT_PACK_PNPM: "/sealed/pnpm.mjs",
  };
  assert.deepEqual(resolvePnpmInvocation(environment, "darwin"), {
    executable: "/sealed/node",
    prefix: ["/sealed/pnpm.mjs", "--config.enable-global-virtual-store=false"],
    displayArguments: ["--config.enable-global-virtual-store=false"],
    display: "pnpm",
  });
  assert.throws(
    () => resolvePnpmInvocation({ ...environment, AGENT_CONTEXT_PACK_PNPM: "/sealed/pnpm" }),
    /absolute \.cjs or \.mjs launcher/u,
  );
  assert.throws(
    () => resolvePnpmInvocation({ AGENT_CONTEXT_PACK_PNPM: "/sealed/pnpm.mjs" }),
    /absolute executable path/u,
  );
  assert.throws(
    () =>
      resolvePnpmInvocation(
        { AGENT_CONTEXT_PACK_PNPM: "pnpm.mjs", AGENT_CONTEXT_PACK_NODE: "C:\\sealed\\node" },
        "win32",
      ),
    /absolute \.cjs or \.mjs launcher/u,
  );
});

test("sealed coverage invocation executes the launcher through the admitted Node", () => {
  const calls = [];
  runVitest(
    ["run", "--project=unit"],
    true,
    (executable, arguments_, options) => {
      calls.push({ executable, arguments_, options });
      return { error: undefined, signal: null, status: 0, stderr: "", stdout: "" };
    },
    {
      AGENT_CONTEXT_PACK_NODE: "/sealed/node",
      AGENT_CONTEXT_PACK_PNPM: "/sealed/pnpm.mjs",
    },
    "darwin",
  );
  assert.deepEqual(calls, [
    {
      executable: "/sealed/node",
      arguments_: [
        "/sealed/pnpm.mjs",
        "--config.enable-global-virtual-store=false",
        "exec",
        "vitest",
        "run",
        "--project=unit",
      ],
      options: {
        cwd: process.cwd(),
        encoding: "utf8",
        shell: false,
        stdio: "pipe",
      },
    },
  ]);
});

test("coverage failure summaries redact sealed and temporary path arguments", () => {
  assert.throws(
    () =>
      runVitest(
        [
          "run",
          "--outputFile.blob=/private/tmp/blob.json",
          "--coverage.reportsDirectory=/private/tmp/reports",
          "--merge-reports=/private/tmp/blobs",
        ],
        true,
        () => ({
          error: undefined,
          signal: null,
          status: 1,
          stderr: undefined,
          stdout: undefined,
        }),
        {
          AGENT_CONTEXT_PACK_NODE: "/sealed/node",
          AGENT_CONTEXT_PACK_PNPM: "/sealed/pnpm.mjs",
        },
        "darwin",
      ),
    (error) => {
      assert.match(error.message, /pnpm --config\.enable-global-virtual-store=false exec vitest/u);
      assert.match(error.message, /--outputFile\.blob=<path>/u);
      assert.doesNotMatch(error.message, /\/private\/tmp|\/sealed/u);
      return true;
    },
  );
});

test("coverage command failures retain the command, status, signal, stdout, and stderr", () => {
  assert.throws(
    () =>
      runVitest(
        ["run", "--project=unit"],
        true,
        (executable, arguments_, options) => {
          assert.match(executable, /^pnpm(?:\.cmd)?$/u);
          assert.deepEqual(arguments_, ["exec", "vitest", "run", "--project=unit"]);
          assert.equal(options.shell, false);
          assert.equal(options.stdio, "pipe");
          return {
            error: undefined,
            signal: "SIGTERM",
            status: 9,
            stderr: "complete stderr",
            stdout: "complete stdout",
          };
        },
        {},
        process.platform,
      ),
    (error) => {
      assert.match(error.message, /status 9 and signal SIGTERM/u);
      assert.match(error.message, /pnpm(?:\.cmd)? exec vitest run --project=unit/u);
      assert.match(error.message, /complete stdout/u);
      assert.match(error.message, /complete stderr/u);
      return true;
    },
  );

  assert.throws(
    () =>
      runVitest(
        ["run"],
        false,
        () => ({
          error: undefined,
          signal: null,
          status: 1,
          stderr: undefined,
          stdout: undefined,
        }),
        {},
        process.platform,
      ),
    /^Error: Vitest coverage command failed with status 1: pnpm(?:\.cmd)? exec vitest run$/u,
  );
});
