import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { checkK03GateState, formatK03GateState, readK03StatusMarker } from "./gate-state.mjs";

const execFileAsync = promisify(execFile);

test("K03 pending state is closed and remains compatible with the release snapshot", async () => {
  const state = await checkK03GateState();
  assert.equal(state.status, "feature-unavailable");
  assert.deepEqual(state.blockers, [
    "native-darwin-capture",
    "native-darwin-confinement",
    "real-adjudication",
  ]);
  assert.equal(state.sourceReplayAvailable, false);

  const root = await mkdtemp(path.join(os.tmpdir(), "k03-gate-state-"));
  await mkdir(path.join(root, "calibration/metadata/v0"), { recursive: true });
  await mkdir(path.join(root, "calibration/schemas"), { recursive: true });
  await writeFile(
    path.join(root, "calibration/schemas/metadata-calibration-gate-state.v0.schema.json"),
    await readFile("calibration/schemas/metadata-calibration-gate-state.v0.schema.json"),
  );
  await writeFile(
    path.join(root, "calibration/schemas/metadata-calibration-native-proof.v0.schema.json"),
    await readFile("calibration/schemas/metadata-calibration-native-proof.v0.schema.json"),
  );
  await writeFile(
    path.join(root, "calibration/metadata/v0/k03-gate-state.json"),
    await readFile("calibration/metadata/v0/k03-gate-state.json"),
  );
  await writeFile(
    path.join(root, "calibration/metadata/v0/k03-native-proof.json"),
    await readFile("calibration/metadata/v0/k03-native-proof.json"),
  );
  await writeFile(path.join(root, "IMPLEMENTATION_STATUS.md"), "K03 is complete.\n");
  await assert.rejects(
    checkK03GateState({ repositoryRoot: root }),
    /exactly one K03 gate-state status marker/,
  );
});

test("K03 status parity ignores historical prose and requires the exact marker", async () => {
  assert.equal(
    readK03StatusMarker(
      "K03 precision adjudication is next\nK03 gate-state status: `feature-unavailable`\n",
    ),
    "feature-unavailable",
  );
  assert.throws(
    () =>
      readK03StatusMarker(
        "K03 gate-state status: `feature-unavailable`\nK03 gate-state status: `ready`\n",
      ),
    /exactly one K03 gate-state status marker/,
  );
  assert.throws(
    () => readK03StatusMarker("K03 gate-state status: `pending`\n"),
    /unsupported K03 gate-state status: pending/,
  );
});

test("K03 gate state rejects duplicate keys before JSON interpretation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "k03-gate-state-duplicate-"));
  await mkdir(path.join(root, "calibration/metadata/v0"), { recursive: true });
  await mkdir(path.join(root, "calibration/schemas"), { recursive: true });
  for (const name of [
    "metadata-calibration-gate-state.v0.schema.json",
    "metadata-calibration-native-proof.v0.schema.json",
  ])
    await writeFile(
      path.join(root, "calibration/schemas", name),
      await readFile(path.join("calibration/schemas", name)),
    );
  const state = await readFile("calibration/metadata/v0/k03-gate-state.json", "utf8");
  await writeFile(
    path.join(root, "calibration/metadata/v0/k03-gate-state.json"),
    state.replace(
      '"status": "feature-unavailable"',
      '"status": "ready",\n  "status": "feature-unavailable"',
    ),
  );
  await writeFile(
    path.join(root, "calibration/metadata/v0/k03-native-proof.json"),
    await readFile("calibration/metadata/v0/k03-native-proof.json"),
  );
  await writeFile(
    path.join(root, "IMPLEMENTATION_STATUS.md"),
    "K03 precision adjudication is next\nK03 gate-state status: `feature-unavailable`\n",
  );
  await assert.rejects(checkK03GateState({ repositoryRoot: root }), /duplicate object keys/u);
});

test("K03 JSON preflight is a read-only machine-readable state projection", async () => {
  const state = await checkK03GateState();
  const encoded = formatK03GateState(state);
  assert.equal(encoded.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(encoded), state);

  const result = await execFileAsync(
    process.execPath,
    ["tools/metadata-calibration/gate-state.mjs", "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), state);
});

test("K03 preflight rejects unsupported option combinations without reading artifacts", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/metadata-calibration/gate-state.mjs", "--json", "--release"],
      { cwd: process.cwd(), encoding: "utf8" },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Usage: node tools\/metadata-calibration\/gate-state\.mjs/);
      return true;
    },
  );
});
