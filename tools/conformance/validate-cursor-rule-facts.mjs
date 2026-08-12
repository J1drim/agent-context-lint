#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

export const CURSOR_FACTS_RECORD_VERSION = "cursor-rules/2026-08-02.0";
export const MAX_CURSOR_FACTS_BYTES = 512 * 1024;

const SURFACES = new Set(["cursor-agent/ide", "cursor-agent/cli"]);
const STATES = new Set([
  "documented",
  "conditional",
  "model-selected",
  "unknown",
  "out-of-repository",
  "malformed",
  "profile-requirement",
]);
const MODES = new Set(["always", "auto-attached", "agent-requested", "manual"]);
const TOPICS = new Map([
  ["mdc", ["MDC", 15]],
  ["activation", ["MODE", 15]],
  ["glob", ["GLOB", 11]],
  ["nested", ["NEST", 10]],
  ["reference", ["REF", 10]],
  ["surface", ["SURFACE", 10]],
]);
const SOURCE_LOCATIONS = new Map([
  ["CURSOR-RULES", "https://cursor.com/docs/rules"],
  ["CURSOR-CLI", "https://cursor.com/docs/cli/using"],
  ["CURSOR-CHANGE-045", "https://cursor.com/changelog/0-45-x"],
  ["CURSOR-CHANGE-049", "https://cursor.com/changelog/0-49"],
  ["CURSOR-CLI-CHANGE-2026-01-08", "https://cursor.com/changelog/cli-jan-08-2026"],
  ["LOCAL-CURSOR-2026-08-02", "docs/profiles/cursor/observations/2026-08-02-local-metadata.md"],
]);
const EXPECTED_FACT_IDS = [...TOPICS.values()].flatMap(([prefix, count]) =>
  Array.from(
    { length: count },
    (_, index) => `CURSOR-${prefix}-${String(index + 1).padStart(2, "0")}`,
  ),
);
const EXACT_TOP_LEVEL_KEYS = [
  "canonicalModes",
  "description",
  "facts",
  "observationPolicy",
  "recordKind",
  "recordVersion",
  "retrievedAt",
  "sources",
  "stateVocabulary",
  "surfaces",
  "unresolved",
];

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, location, errors) {
  if (!isObject(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${location} keys must be exactly ${wanted.join(", ")}`);
    return false;
  }
  return true;
}

function string(value, location, errors, { max = 1000, nullable = false } = {}) {
  if (nullable && value === null) return true;
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    errors.push(`${location} must be a non-empty string of at most ${max} characters`);
    return false;
  }
  return true;
}

function array(value, location, errors, { min = 1, max = 100 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    errors.push(`${location} must contain ${min} to ${max} entries`);
    return false;
  }
  return true;
}

function uniqueStrings(value, location, errors, allowed) {
  if (!array(value, location, errors)) return;
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (!string(item, `${location}[${index}]`, errors, { max: 100 })) continue;
    if (seen.has(item)) errors.push(`${location} contains duplicate value ${item}`);
    seen.add(item);
    if (allowed !== undefined && !allowed.has(item)) {
      errors.push(`${location}[${index}] contains unsupported value ${item}`);
    }
  }
}

function validateSurfaces(value, errors, sourceIds) {
  if (!array(value, "facts.surfaces", errors, { min: 2, max: 2 })) return;
  const ids = new Set();
  for (const [index, surface] of value.entries()) {
    const at = `facts.surfaces[${index}]`;
    if (
      !exactKeys(
        surface,
        ["architecture", "clientVersion", "id", "revision", "versionEvidence"],
        at,
        errors,
      )
    )
      continue;
    if (!SURFACES.has(surface.id)) errors.push(`${at}.id is not a Cursor surface`);
    if (ids.has(surface.id)) errors.push(`${at}.id duplicates ${surface.id}`);
    ids.add(surface.id);
    string(surface.clientVersion, `${at}.clientVersion`, errors, { max: 100 });
    string(surface.revision, `${at}.revision`, errors, { max: 100, nullable: true });
    if (surface.architecture !== "arm64") errors.push(`${at}.architecture must be arm64`);
    if (!sourceIds.has(surface.versionEvidence)) {
      errors.push(`${at}.versionEvidence must reference a declared source`);
    }
  }
  for (const surface of SURFACES) {
    if (!ids.has(surface)) errors.push(`facts.surfaces must include ${surface}`);
  }
}

function validateSources(value, errors) {
  if (!array(value, "facts.sources", errors, { min: 6, max: 6 })) return new Set();
  const ids = new Set();
  for (const [index, source] of value.entries()) {
    const at = `facts.sources[${index}]`;
    if (
      !exactKeys(
        source,
        ["id", "kind", "mutableSourceReason", "retrievedAt", "revision", "url"],
        at,
        [],
      )
    ) {
      if (
        !exactKeys(
          source,
          ["id", "kind", "mutableSourceReason", "path", "retrievedAt", "revision"],
          at,
          errors,
        )
      )
        continue;
    }
    string(source.id, `${at}.id`, errors, { max: 100 });
    if (ids.has(source.id)) errors.push(`${at}.id duplicates ${source.id}`);
    ids.add(source.id);
    const expectedLocation = SOURCE_LOCATIONS.get(source.id);
    if (expectedLocation === undefined) {
      errors.push(`${at}.id is not an approved D11 source`);
    } else if ((source.url ?? source.path) !== expectedLocation) {
      errors.push(`${at} must use the approved location for ${source.id}`);
    }
    if (
      !new Set([
        "official-current-documentation",
        "official-versioned-changelog",
        "local-inert-observation",
      ]).has(source.kind)
    )
      errors.push(`${at}.kind is unsupported`);
    if (source.retrievedAt !== "2026-08-02") errors.push(`${at}.retrievedAt must be 2026-08-02`);
    string(source.revision, `${at}.revision`, errors, { max: 100, nullable: true });
    string(source.mutableSourceReason, `${at}.mutableSourceReason`, errors, {
      max: 500,
      nullable: true,
    });
    if (source.kind === "official-current-documentation" && source.revision !== null) {
      errors.push(`${at}.revision must remain null for mutable current documentation`);
    }
    if (source.kind === "official-current-documentation" && source.mutableSourceReason === null) {
      errors.push(`${at}.mutableSourceReason is required for mutable documentation`);
    }
    if (source.kind === "local-inert-observation" && source.path === undefined) {
      errors.push(`${at}.path is required for a local observation`);
    }
  }
  for (const sourceId of SOURCE_LOCATIONS.keys()) {
    if (!ids.has(sourceId)) errors.push(`facts.sources must include ${sourceId}`);
  }
  return ids;
}

function validateVocabulary(value, errors) {
  if (!exactKeys(value, STATES, "facts.stateVocabulary", errors)) return;
  for (const state of STATES) string(value[state], `facts.stateVocabulary.${state}`, errors);
}

function validateModes(value, errors) {
  if (!array(value, "facts.canonicalModes", errors, { min: 4, max: 4 })) return;
  const expected = [
    ["always", "true", "empty", "optional", "documented"],
    ["auto-attached", "false", "non-empty", "optional", "documented"],
    ["agent-requested", "false", "empty", "non-empty", "model-selected"],
    ["manual", "false", "empty", "empty", "documented"],
  ];
  for (const [index, mode] of value.entries()) {
    const at = `facts.canonicalModes[${index}]`;
    if (
      !exactKeys(
        mode,
        ["activation", "alwaysApply", "description", "globs", "id", "state"],
        at,
        errors,
      )
    )
      continue;
    const [id, alwaysApply, globs, description, state] = expected[index];
    if (
      mode.id !== id ||
      mode.alwaysApply !== alwaysApply ||
      mode.globs !== globs ||
      mode.description !== description ||
      mode.state !== state
    )
      errors.push(`${at} must preserve the canonical ${id} tuple`);
    string(mode.activation, `${at}.activation`, errors, { max: 300 });
  }
}

function validateFacts(value, errors, sourceIds) {
  if (!array(value, "facts.facts", errors, { min: 71, max: 71 })) return;
  const seen = new Set();
  for (const [index, fact] of value.entries()) {
    const at = `facts.facts[${index}]`;
    if (
      !exactKeys(
        fact,
        ["activationMode", "claim", "id", "sources", "state", "surfaces", "topic"],
        at,
        errors,
      )
    )
      continue;
    const expectedId = EXPECTED_FACT_IDS[index];
    if (fact.id !== expectedId) errors.push(`${at}.id must be ${expectedId}`);
    if (seen.has(fact.id)) errors.push(`${at}.id duplicates ${fact.id}`);
    seen.add(fact.id);
    const topic =
      typeof fact.id === "string"
        ? [...TOPICS.entries()].find(([, [prefix]]) => fact.id.startsWith(`CURSOR-${prefix}-`))?.[0]
        : undefined;
    if (fact.topic !== topic) errors.push(`${at}.topic does not match ${fact.id}`);
    if (!STATES.has(fact.state)) errors.push(`${at}.state is unsupported`);
    if (fact.activationMode !== null && !MODES.has(fact.activationMode)) {
      errors.push(`${at}.activationMode is unsupported`);
    }
    string(fact.claim, `${at}.claim`, errors, { max: 500 });
    uniqueStrings(fact.surfaces, `${at}.surfaces`, errors, SURFACES);
    uniqueStrings(fact.sources, `${at}.sources`, errors, sourceIds);
    if (fact.state === "model-selected" && fact.activationMode === "always") {
      errors.push(`${at} cannot turn model-selected evidence into Always activation`);
    }
  }
}

function validateUnresolved(value, errors) {
  if (!array(value, "facts.unresolved", errors, { min: 8, max: 8 })) return;
  for (const [index, gap] of value.entries()) {
    const at = `facts.unresolved[${index}]`;
    if (!exactKeys(gap, ["id", "summary"], at, errors)) continue;
    const expectedId = `CURSOR-GAP-${String(index + 1).padStart(3, "0")}`;
    if (gap.id !== expectedId) errors.push(`${at}.id must be ${expectedId}`);
    string(gap.summary, `${at}.summary`, errors, { max: 500 });
  }
}

function validateObservationPolicy(value, errors) {
  if (
    !exactKeys(
      value,
      ["allowedNow", "forbiddenNow", "paidRequestsAuthorized", "plan", "unsettledOutcome"],
      "facts.observationPolicy",
      errors,
    )
  )
    return;
  if (value.plan !== "docs/profiles/cursor/observations/2026-08-02-no-paid-plan.md") {
    errors.push("facts.observationPolicy.plan must reference the reviewed D11 plan");
  }
  if (value.paidRequestsAuthorized !== false) {
    errors.push("facts.observationPolicy.paidRequestsAuthorized must be false");
  }
  if (value.unsettledOutcome !== "blocked-paid-observation") {
    errors.push("facts.observationPolicy.unsettledOutcome must be blocked-paid-observation");
  }
  const requiredForbidden = new Set([
    "model-request",
    "credential-read",
    "repository-command",
    "external-write",
    "upstream-mutation",
  ]);
  uniqueStrings(value.allowedNow, "facts.observationPolicy.allowedNow", errors);
  uniqueStrings(
    value.forbiddenNow,
    "facts.observationPolicy.forbiddenNow",
    errors,
    requiredForbidden,
  );
  const forbiddenNow = Array.isArray(value.forbiddenNow) ? value.forbiddenNow : [];
  for (const item of requiredForbidden) {
    if (!forbiddenNow.includes(item)) {
      errors.push(`facts.observationPolicy.forbiddenNow must include ${item}`);
    }
  }
}

export function validateCursorRuleFacts(value) {
  const errors = [];
  if (!exactKeys(value, EXACT_TOP_LEVEL_KEYS, "facts", errors)) return errors;
  if (value.recordKind !== "research-truth-table") {
    errors.push("facts.recordKind must be research-truth-table");
  }
  if (value.recordVersion !== CURSOR_FACTS_RECORD_VERSION) {
    errors.push(`facts.recordVersion must be ${CURSOR_FACTS_RECORD_VERSION}`);
  }
  if (value.retrievedAt !== "2026-08-02") errors.push("facts.retrievedAt must be 2026-08-02");
  string(value.description, "facts.description", errors, { max: 1000 });
  validateVocabulary(value.stateVocabulary, errors);
  const sourceIds = validateSources(value.sources, errors);
  validateSurfaces(value.surfaces, errors, sourceIds);
  validateModes(value.canonicalModes, errors);
  validateFacts(value.facts, errors, sourceIds);
  validateUnresolved(value.unresolved, errors);
  validateObservationPolicy(value.observationPolicy, errors);
  return errors;
}

export function loadCursorRuleFacts(filePath) {
  const pathStat = fs.lstatSync(filePath, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error("Cursor truth-table input must be an ordinary file");
  }
  if (pathStat.size > BigInt(MAX_CURSOR_FACTS_BYTES)) {
    throw new Error(`Cursor truth-table input exceeds ${MAX_CURSOR_FACTS_BYTES} bytes`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, flags);
  } catch {
    throw new Error("Cursor truth-table input must be an ordinary file");
  }
  let bytes;
  try {
    const openedStat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      openedStat.size !== pathStat.size
    ) {
      throw new Error("Cursor truth-table input changed before it could be read");
    }
    const bounded = Buffer.allocUnsafe(MAX_CURSOR_FACTS_BYTES + 1);
    let length = 0;
    while (length < bounded.length) {
      const read = fs.readSync(descriptor, bounded, length, bounded.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_CURSOR_FACTS_BYTES) {
      throw new Error(`Cursor truth-table input exceeds ${MAX_CURSOR_FACTS_BYTES} bytes`);
    }
    const readStat = fs.fstatSync(descriptor, { bigint: true });
    if (
      readStat.dev !== openedStat.dev ||
      readStat.ino !== openedStat.ino ||
      readStat.size !== openedStat.size ||
      readStat.mtimeNs !== openedStat.mtimeNs ||
      readStat.ctimeNs !== openedStat.ctimeNs ||
      BigInt(length) !== readStat.size
    ) {
      throw new Error("Cursor truth-table input changed while it was read");
    }
    bytes = bounded.subarray(0, length);
  } finally {
    fs.closeSync(descriptor);
  }
  if (bytes.includes(0)) throw new Error("Cursor truth-table input contains NUL bytes");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("Cursor truth-table input must not contain a UTF-8 BOM");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Cursor truth-table input is not valid UTF-8");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cursor truth-table input is malformed JSON: ${error.message}`, {
      cause: error,
    });
  }
  return value;
}

function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write("usage: validate-cursor-rule-facts.mjs <facts.json>\n");
    return 2;
  }
  let value;
  try {
    value = loadCursorRuleFacts(argv[0]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const errors = validateCursorRuleFacts(value);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    return 1;
  }
  process.stdout.write(`validated ${value.facts.length} Cursor facts for ${value.recordVersion}\n`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
