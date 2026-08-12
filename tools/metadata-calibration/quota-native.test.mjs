import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_ASSEMBLY_STAGES,
  runNativeAssemblyPipeline,
  validateEnospcCopyResult,
} from "./quota-native.mjs";

test("native quota accepts only exact ENOSPC with an ordinary partial destination size", () => {
  const enospc = {
    signal: null,
    status: 1,
    stderr: "cp: target: No space left on device\n",
    stdout: "",
  };
  assert.doesNotThrow(() => validateEnospcCopyResult(enospc, 4096, 8192));
  for (const result of [
    { ...enospc, status: 2 },
    { ...enospc, signal: "SIGKILL", status: null },
    { ...enospc, stderr: "cp: target: File too large\n" },
    { ...enospc, stderr: "cp: target: Permission denied\n" },
  ])
    assert.throws(() => validateEnospcCopyResult(result, 4096, 8192), /exact ENOSPC/u);
  for (const size of [0, 8192, 8193])
    assert.throws(() => validateEnospcCopyResult(enospc, size, 8192), /partial destination/u);
});

test("native proof assembler fails closed at every ordered stage", async () => {
  for (const failedStage of NATIVE_ASSEMBLY_STAGES) {
    const calls = [];
    const operations = Object.fromEntries(
      NATIVE_ASSEMBLY_STAGES.map((stage) => [
        stage,
        async (context) => {
          calls.push(stage);
          assert.deepEqual(Object.keys(context), NATIVE_ASSEMBLY_STAGES.slice(0, calls.length - 1));
          if (stage === failedStage) throw new Error(`fixture ${stage}`);
          return { stage };
        },
      ]),
    );
    await assert.rejects(
      runNativeAssemblyPipeline(operations),
      new RegExp(`failed during ${failedStage}$`, "u"),
    );
    assert.deepEqual(
      calls,
      NATIVE_ASSEMBLY_STAGES.slice(0, NATIVE_ASSEMBLY_STAGES.indexOf(failedStage) + 1),
    );
  }
  await assert.rejects(runNativeAssemblyPipeline({}), /lacks its toolchain stage/u);
});
