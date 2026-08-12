#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

import {
  canonicalJson,
  selectCalibrationCorpus,
  validateCalibrationCorpus,
  validateCandidateSnapshot,
} from "./contracts.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const MAXIMUM_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_VALUES = 250_000;
const ARTIFACT_PATHS = Object.freeze({
  candidates: "calibration/metadata/v0/candidate-snapshot.json",
  corpus: "calibration/metadata/v0/corpus.json",
});

export async function readBoundedArtifactRecord(repositoryRoot, repositoryPath) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    repositoryPath.length > 1024 ||
    path.posix.isAbsolute(repositoryPath) ||
    path.posix.normalize(repositoryPath) !== repositoryPath ||
    repositoryPath.startsWith("../") ||
    repositoryPath.includes("\\") ||
    repositoryPath.includes("\0")
  )
    throw new Error("artifact path must be canonical and repository-relative");
  const rootReal = await realpath(repositoryRoot);
  const lexical = path.resolve(repositoryRoot, repositoryPath);
  if (!lexical.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`))
    throw new Error("artifact path escaped repository root");
  const parentReal = await realpath(path.dirname(lexical));
  if (!parentReal.startsWith(`${rootReal}${path.sep}`))
    throw new Error("artifact parent escaped repository root");
  const stat = await lstat(lexical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAXIMUM_ARTIFACT_BYTES)
    throw new Error("artifact must be a bounded regular file");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(lexical, fsConstants.O_RDONLY | noFollow);
  let bytes;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== stat.size ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino
    )
      throw new Error("artifact changed during bounded open");
    bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs ||
      afterRead.ctimeMs !== opened.ctimeMs
    )
      throw new Error("artifact changed during bounded read");
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("artifact must be valid UTF-8 JSON");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("artifact must be valid UTF-8 JSON");
  }
  const duplicateCheck = parseDocument(text, { maxAliasCount: 0, uniqueKeys: true });
  if (duplicateCheck.errors.length > 0)
    throw new Error("artifact JSON contains duplicate object keys or invalid structure");
  const pending = [{ depth: 0, value }];
  let values = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    values += 1;
    if (values > MAXIMUM_JSON_VALUES || current.depth > MAXIMUM_JSON_DEPTH)
      throw new Error("artifact JSON exceeds structure limits");
    if (Array.isArray(current.value))
      for (const entry of current.value) pending.push({ depth: current.depth + 1, value: entry });
    else if (current.value !== null && typeof current.value === "object")
      for (const entry of Object.values(current.value))
        pending.push({ depth: current.depth + 1, value: entry });
  }
  if (!text.endsWith("\n")) throw new Error("artifact JSON must end with a newline");
  return Object.freeze({ bytes, value });
}

export async function readBoundedArtifact(repositoryRoot, repositoryPath) {
  return (await readBoundedArtifactRecord(repositoryRoot, repositoryPath)).value;
}

export async function readBoundedPrivateArtifact(absolutePath) {
  if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath))
    throw new Error("private artifact path must be absolute");
  const lexical = path.resolve(absolutePath);
  const temporaryRoot = await realpath(os.tmpdir());
  const parent = await realpath(path.dirname(lexical));
  if (!parent.startsWith(`${temporaryRoot}${path.sep}`) || parent === temporaryRoot)
    throw new Error("private artifact must be in a dedicated operating-system temporary directory");
  const metadata = await lstat(lexical);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAXIMUM_ARTIFACT_BYTES ||
    (metadata.mode & 0o777) !== 0o600 ||
    (uid !== null && metadata.uid !== uid)
  )
    throw new Error("private artifact must be an owned bounded mode-0600 regular file");
  const handle = await open(lexical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size)
      throw new Error("private artifact changed during bounded open");
    bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size ||
      afterRead.mtimeMs !== opened.mtimeMs ||
      afterRead.ctimeMs !== opened.ctimeMs
    )
      throw new Error("private artifact changed during bounded read");
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("private artifact must be valid UTF-8 JSON");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("private artifact must be valid UTF-8 JSON");
  }
  if (parseDocument(text, { maxAliasCount: 0, uniqueKeys: true }).errors.length > 0)
    throw new Error("private artifact JSON contains duplicate object keys");
  const pending = [{ depth: 0, value }];
  let values = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    values += 1;
    if (values > MAXIMUM_JSON_VALUES || current.depth > MAXIMUM_JSON_DEPTH)
      throw new Error("private artifact JSON exceeds structure limits");
    if (Array.isArray(current.value))
      for (const entry of current.value) pending.push({ depth: current.depth + 1, value: entry });
    else if (current.value !== null && typeof current.value === "object")
      for (const entry of Object.values(current.value))
        pending.push({ depth: current.depth + 1, value: entry });
  }
  return value;
}

export async function checkCalibrationArtifacts({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const candidates = await readBoundedArtifact(repositoryRoot, ARTIFACT_PATHS.candidates);
  const corpus = await readBoundedArtifact(repositoryRoot, ARTIFACT_PATHS.corpus);
  const candidateResult = validateCandidateSnapshot(candidates);
  const corpusResult = validateCalibrationCorpus(corpus, candidates);
  const errors = [...candidateResult.errors, ...corpusResult.errors];
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const expectedCorpus = selectCalibrationCorpus(candidates);
  if (canonicalJson(expectedCorpus) !== canonicalJson(corpus))
    throw new Error("selected corpus is stale relative to the frozen candidate snapshot");
  return Object.freeze({
    candidateCount: candidates.candidates.length,
    repositoryCount: corpus.repositories.length,
  });
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: node tools/metadata-calibration/run.mjs\n");
    process.exitCode = 1;
  } else {
    try {
      const result = await checkCalibrationArtifacts();
      process.stdout.write(
        `Metadata calibration artifacts are valid (${String(result.candidateCount)} candidates, ${String(result.repositoryCount)} selected).\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : "metadata calibration check failed"}\n`,
      );
      process.exitCode = 1;
    }
  }
}
