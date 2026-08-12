#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { fileURLToPath } from "node:url";

const LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  sources: 128,
  facts: 512,
  gaps: 128,
  stringCodeUnits: 16_384,
});

const TOP_LEVEL_KEYS = new Set([
  "recordKind",
  "contract",
  "recordVersion",
  "retrievedAt",
  "description",
  "provenance",
  "stateVocabulary",
  "sources",
  "facts",
  "gaps",
]);

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value, key, at, errors) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    errors.push(`${at}.${key} must be a data property`);
    return undefined;
  }
  return descriptor.value;
}

function requireRecord(value, at, errors) {
  if (!isPlainRecord(value)) {
    errors.push(`${at} must be a plain object`);
    return false;
  }
  return true;
}

function requireString(value, at, errors, pattern) {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.stringCodeUnits) {
    errors.push(`${at} must be a non-empty bounded string`);
    return false;
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${at} has an invalid format`);
    return false;
  }
  return true;
}

function requireArray(value, at, errors, limit, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    errors.push(`${at} must be an array`);
    return false;
  }
  if (nonEmpty && value.length === 0) errors.push(`${at} must not be empty`);
  if (value.length > limit) errors.push(`${at} exceeds limit ${limit}`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) errors.push(`${at} must be dense`);
  }
  return true;
}

function safeArtifactPath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function validateUniqueIds(items, at, errors, pattern) {
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    if (!requireRecord(item, `${at}[${index}]`, errors)) continue;
    const id = ownData(item, "id", `${at}[${index}]`, errors);
    if (!requireString(id, `${at}[${index}].id`, errors, pattern)) continue;
    if (ids.has(id)) errors.push(`${at} contains duplicate id ${id}`);
    ids.add(id);
  }
  return ids;
}

export function validateGeminiResearch(record, map, fixtures = [], options = {}) {
  const errors = [];
  if (!requireRecord(record, "record", errors)) return errors;

  for (const key of Object.keys(record)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`record contains unknown top-level field ${key}`);
  }
  if (ownData(record, "recordKind", "record", errors) !== "research-truth-table")
    errors.push("record.recordKind must be research-truth-table");
  if (ownData(record, "contract", "record", errors) !== false)
    errors.push("record.contract must be false");

  const recordVersion = ownData(record, "recordVersion", "record", errors);
  requireString(
    recordVersion,
    "record.recordVersion",
    errors,
    /^gemini-cli\/\d{4}-\d{2}-\d{2}\.\d+$/,
  );
  requireString(
    ownData(record, "retrievedAt", "record", errors),
    "record.retrievedAt",
    errors,
    /^\d{4}-\d{2}-\d{2}$/,
  );
  requireString(ownData(record, "description", "record", errors), "record.description", errors);

  const vocabulary = ownData(record, "stateVocabulary", "record", errors);
  const states = new Set();
  if (requireRecord(vocabulary, "record.stateVocabulary", errors)) {
    for (const key of Object.keys(vocabulary)) {
      if (requireString(vocabulary[key], `record.stateVocabulary.${key}`, errors)) states.add(key);
    }
  }

  const sources = ownData(record, "sources", "record", errors);
  let sourceIds = new Set();
  let sourceById = new Map();
  if (requireArray(sources, "record.sources", errors, LIMITS.sources)) {
    sourceIds = validateUniqueIds(sources, "record.sources", errors, /^GEM-[A-Z0-9-]+$/);
    sourceById = new Map(sources.filter(isPlainRecord).map((source) => [source.id, source]));
    for (const [index, source] of sources.entries()) {
      if (!isPlainRecord(source)) continue;
      const at = `record.sources[${index}]`;
      requireString(ownData(source, "kind", at, errors), `${at}.kind`, errors);
      const artifactPath = ownData(source, "artifactPath", at, errors);
      const url = ownData(source, "url", at, errors);
      if (artifactPath !== undefined) {
        if (!safeArtifactPath(artifactPath))
          errors.push(`${at}.artifactPath must be repository-relative`);
      } else if (!requireString(url, `${at}.url`, errors, /^https:\/\//)) {
        errors.push(`${at} must identify an HTTPS source or local artifact`);
      }
    }
  }

  const provenance = ownData(record, "provenance", "record", errors);
  if (requireRecord(provenance, "record.provenance", errors)) {
    for (const key of ["stableSourceSha", "currentSourceSha"]) {
      requireString(
        ownData(provenance, key, "record.provenance", errors),
        `record.provenance.${key}`,
        errors,
        /^[a-f0-9]{40}$/,
      );
    }
    if (provenance.relevantFilesIdenticalAcrossPinnedSources !== true)
      errors.push("record.provenance.relevantFilesIdenticalAcrossPinnedSources must be true");
    if (!safeArtifactPath(provenance.sourceEquivalenceArtifact))
      errors.push("record.provenance.sourceEquivalenceArtifact must be repository-relative");
    if (
      requireRecord(provenance.sourceFileDigests, "record.provenance.sourceFileDigests", errors)
    ) {
      const entries = Object.entries(provenance.sourceFileDigests);
      if (entries.length !== 15)
        errors.push("record.provenance.sourceFileDigests must contain the 15 reviewed files");
      for (const [id, digest] of entries) {
        if (!sourceIds.has(id))
          errors.push(`record.provenance.sourceFileDigests references unknown source ${id}`);
        requireString(
          digest,
          `record.provenance.sourceFileDigests.${id}`,
          errors,
          /^[a-f0-9]{64}$/,
        );
        const sourceUrl = sourceById.get(id)?.url;
        if (
          typeof sourceUrl !== "string" ||
          !sourceUrl.includes(`/blob/${provenance.currentSourceSha}/`)
        ) {
          errors.push(
            `record.provenance.sourceFileDigests.${id} must bind an immutable current-source URL`,
          );
        }
      }
    }
  }

  const facts = ownData(record, "facts", "record", errors);
  let factIds = new Set();
  if (requireArray(facts, "record.facts", errors, LIMITS.facts)) {
    factIds = validateUniqueIds(facts, "record.facts", errors, /^GEM-[A-Z]+-\d{3}$/);
    for (const [index, fact] of facts.entries()) {
      if (!isPlainRecord(fact)) continue;
      const at = `record.facts[${index}]`;
      requireString(fact.topic, `${at}.topic`, errors);
      requireString(fact.claim, `${at}.claim`, errors);
      if (!states.has(fact.state)) errors.push(`${at}.state is not in stateVocabulary`);
      if (requireArray(fact.sources, `${at}.sources`, errors, LIMITS.sources)) {
        for (const source of fact.sources) {
          if (!sourceIds.has(source))
            errors.push(`${at}.sources references unknown source ${source}`);
        }
      }
    }
  }

  const gaps = ownData(record, "gaps", "record", errors);
  const gapIds = new Set();
  if (requireArray(gaps, "record.gaps", errors, LIMITS.gaps)) {
    for (const [index, gap] of gaps.entries()) {
      if (!requireString(gap, `record.gaps[${index}]`, errors, /^GEM-GAP-\d{3}$/)) continue;
      if (gapIds.has(gap)) errors.push(`record.gaps contains duplicate id ${gap}`);
      gapIds.add(gap);
    }
  }

  if (!isPlainRecord(map)) {
    errors.push("map must be a plain object");
  } else if (!map.researchRecords?.some((entry) => entry?.id === recordVersion)) {
    errors.push(`map.researchRecords must include ${String(recordVersion)}`);
  }

  const evidenceIds = new Set([...sourceIds, ...factIds, ...gapIds]);
  for (const [fixtureIndex, fixture] of fixtures.entries()) {
    const at = `fixtures[${fixtureIndex}]`;
    if (!requireRecord(fixture, at, errors)) continue;
    if (fixture.profile?.profileId !== "gemini-cli") errors.push(`${at} must target gemini-cli`);
    if (fixture.profile?.specSnapshotId !== recordVersion)
      errors.push(`${at}.profile.specSnapshotId must equal ${String(recordVersion)}`);
    if (!fixture.provenance?.researchRecordIds?.includes(recordVersion))
      errors.push(`${at}.provenance must include ${String(recordVersion)}`);
    const containers = [
      ...(fixture.expectedGraph?.ambiguities ?? []),
      ...(fixture.expectedGraph?.nodes ?? []),
      ...(fixture.expectedGraph?.edges ?? []),
      ...(fixture.assertions ?? []),
    ];
    for (const [containerIndex, item] of containers.entries()) {
      for (const reference of item?.evidenceRefs ?? []) {
        if (!evidenceIds.has(reference))
          errors.push(
            `${at} evidenceRefs[${containerIndex}] references unknown evidence ${reference}`,
          );
      }
    }
  }

  if (options.workspaceRoot !== undefined) {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const artifactPaths = [
      provenance?.sourceEquivalenceArtifact,
      ...(sources ?? []).map((source) => source?.artifactPath),
    ].filter(Boolean);
    for (const artifactPath of new Set(artifactPaths)) {
      if (!safeArtifactPath(artifactPath)) continue;
      const resolved = path.resolve(workspaceRoot, artifactPath);
      if (!resolved.startsWith(`${workspaceRoot}${path.sep}`) || !fs.existsSync(resolved))
        errors.push(`artifact does not exist inside workspace: ${artifactPath}`);
    }
  }

  return errors;
}

function readJsonBounded(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${filePath}: must be a regular file`);
  if (stat.size > LIMITS.fileBytes)
    throw new Error(`${filePath}: exceeds ${LIMITS.fileBytes} bytes`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const [, , recordPath, mapPath, ...fixturePaths] = process.argv;
  if (!recordPath || !mapPath || fixturePaths.length === 0) {
    console.error("usage: validate-gemini-research.mjs RECORD.json MAP.json FIXTURE.json [...]");
    process.exitCode = 2;
  } else {
    try {
      const record = readJsonBounded(recordPath);
      const map = readJsonBounded(mapPath);
      const fixtures = fixturePaths.map(readJsonBounded);
      const errors = validateGeminiResearch(record, map, fixtures, {
        workspaceRoot: process.cwd(),
      });
      if (errors.length > 0) {
        errors.forEach((error) => console.error(error));
        process.exitCode = 1;
      } else {
        console.log(
          `validated Gemini research ${record.recordVersion} and ${fixtures.length} fixtures`,
        );
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
