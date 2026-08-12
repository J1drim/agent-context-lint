import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkCalibrationArtifacts, readBoundedArtifact } from "./run.mjs";

test("offline release check validates frozen artifacts without network", async () => {
  assert.deepEqual(await checkCalibrationArtifacts(), { candidateCount: 70, repositoryCount: 50 });
});

test("bounded artifact reader rejects traversal, symlinks, duplicate keys, and oversized files", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "metadata-calibration-"));
  await mkdir(path.join(temporary, "inside"));
  await writeFile(path.join(temporary, "inside", "valid.json"), '{\n  "ok": true\n}\n');
  assert.deepEqual(await readBoundedArtifact(temporary, "inside/valid.json"), { ok: true });
  await assert.rejects(readBoundedArtifact(temporary, "../outside.json"), /canonical/);
  await symlink(
    path.join(temporary, "inside", "valid.json"),
    path.join(temporary, "inside", "link.json"),
  );
  await assert.rejects(readBoundedArtifact(temporary, "inside/link.json"), /regular file/);
  await writeFile(path.join(temporary, "inside", "duplicate.json"), '{"key":1,"key":2}\n');
  await assert.rejects(
    readBoundedArtifact(temporary, "inside/duplicate.json"),
    /duplicate object keys/,
  );
  await writeFile(path.join(temporary, "inside", "large.json"), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(readBoundedArtifact(temporary, "inside/large.json"), /bounded regular file/);
});

test("offline release check rejects a stale selected corpus", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "metadata-calibration-stale-"));
  const directory = path.join(temporary, "calibration/metadata/v0");
  await mkdir(directory, { recursive: true });
  const candidates = await readFile("calibration/metadata/v0/candidate-snapshot.json");
  const corpus = JSON.parse(await readFile("calibration/metadata/v0/corpus.json", "utf8"));
  [corpus.repositories[0], corpus.repositories[1]] = [
    corpus.repositories[1],
    corpus.repositories[0],
  ];
  await writeFile(path.join(directory, "candidate-snapshot.json"), candidates);
  await writeFile(path.join(directory, "corpus.json"), `${JSON.stringify(corpus, null, 2)}\n`);
  await assert.rejects(checkCalibrationArtifacts({ repositoryRoot: temporary }), /reconstruct/);
});
