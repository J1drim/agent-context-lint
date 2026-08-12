import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalWeeklyCheckError,
  parseLocalWeeklyArguments,
  runLocalWeeklyCheck,
} from "./local-weekly-check.mjs";
import { parseCatalogBytes, upstreamCatalogPath } from "./upstream-snapshotter.mjs";

const retrievedAt = Date.UTC(2026, 7, 12, 12);

function defaultStateDirectoryForTest() {
  if (process.platform === "darwin")
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "agent-context-lint",
      "standards",
    );
  if (process.platform === "win32")
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "agent-context-lint",
      "standards",
    );
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "agent-context-lint",
    "standards",
  );
}

function fakeTransport(catalog, getSuffix) {
  return {
    async fetch(source) {
      const suffix = getSuffix();
      const bytes =
        source.format === "html"
          ? Buffer.from(
              `<html><body>${source.sections
                .map(
                  (section) =>
                    `<h${section.level}>${section.heading}</h${section.level}><p>${suffix}</p>`,
                )
                .join("")}</body></html>`,
            )
          : Buffer.from(
              source.sections
                .map((section) => `${"#".repeat(section.level)} ${section.heading}\n\n${suffix}\n`)
                .join(""),
            );
      return {
        bytes,
        mediaType: source.format === "html" ? "text/html" : "text/markdown",
      };
    },
  };
}

async function fixture() {
  const state = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-context-weekly-")));
  const catalog = parseCatalogBytes(await readFile(upstreamCatalogPath));
  let suffix = "stable";
  return {
    catalog,
    getSuffix: () => suffix,
    setSuffix: (value) => {
      suffix = value;
    },
    state,
  };
}

test("weekly arguments require explicit network acknowledgement and separate acceptance", () => {
  assert.deepEqual(parseLocalWeeklyArguments(["check", "--initialize", "--acknowledge-network"]), {
    acknowledgeNetwork: true,
    acceptBaseline: false,
    failOnChange: false,
    format: "terminal",
    initialize: true,
    mode: "check",
    outputDirectory: null,
    stateDirectory: defaultStateDirectoryForTest(),
  });
  assert.equal(
    parseLocalWeeklyArguments(["--", "check", "--acknowledge-network"]).acknowledgeNetwork,
    true,
  );
  assert.throws(
    () => parseLocalWeeklyArguments(["accept", "--acknowledge-network"]),
    (error) => error instanceof LocalWeeklyCheckError && error.code === "usage",
  );
});

test("weekly check initializes, detects changes, and promotes only an explicit baseline", async () => {
  const selected = await fixture();
  const transport = fakeTransport(selected.catalog, selected.getSuffix);
  try {
    const initialized = await runLocalWeeklyCheck({
      acknowledgeNetwork: true,
      initialize: true,
      now: retrievedAt,
      stateDirectory: selected.state,
      transport,
    });
    assert.equal(initialized.status, "baseline-initialized");

    const unchanged = await runLocalWeeklyCheck({
      acknowledgeNetwork: true,
      now: retrievedAt + 86_400_000,
      stateDirectory: selected.state,
      transport,
    });
    assert.equal(unchanged.status, "unchanged");

    selected.setSuffix("changed");
    const changed = await runLocalWeeklyCheck({
      acknowledgeNetwork: true,
      now: retrievedAt + 2 * 86_400_000,
      stateDirectory: selected.state,
      transport,
    });
    assert.equal(changed.status, "changed");
    assert.ok(changed.review.changedSections > 0);
    assert.equal(changed.review.directory, path.join(selected.state, "review"));
    assert.equal((await lstat(path.join(selected.state, "review"))).isDirectory(), true);

    const accepted = await runLocalWeeklyCheck({
      acceptBaseline: true,
      now: retrievedAt + 2 * 86_400_000,
      stateDirectory: selected.state,
    });
    assert.equal(accepted.status, "baseline-accepted");
    const afterAcceptance = await runLocalWeeklyCheck({
      acknowledgeNetwork: true,
      now: retrievedAt + 3 * 86_400_000,
      stateDirectory: selected.state,
      transport,
    });
    assert.equal(afterAcceptance.status, "unchanged");
  } finally {
    await rm(selected.state, { force: true, recursive: true });
  }
});

test("weekly check fails closed before acquisition without a baseline or acknowledgement", async () => {
  const selected = await fixture();
  try {
    await assert.rejects(
      runLocalWeeklyCheck({ stateDirectory: selected.state }),
      (error) => error.code === "network-acknowledgement-required",
    );
    await assert.rejects(
      runLocalWeeklyCheck({
        acknowledgeNetwork: true,
        stateDirectory: selected.state,
        transport: fakeTransport(selected.catalog, selected.getSuffix),
      }),
      (error) => error.code === "baseline-required",
    );
  } finally {
    await rm(selected.state, { force: true, recursive: true });
  }
});

test("weekly check rejects repository-local state and hostile state links", async () => {
  const selected = await fixture();
  try {
    await assert.rejects(
      runLocalWeeklyCheck({
        acknowledgeNetwork: true,
        initialize: true,
        stateDirectory: path.join(process.cwd(), "tmp-weekly-state"),
        transport: fakeTransport(selected.catalog, selected.getSuffix),
      }),
      (error) => error.code === "unsafe-path",
    );
  } finally {
    await rm(selected.state, { force: true, recursive: true });
  }
});
