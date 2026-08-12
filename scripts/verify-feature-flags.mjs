import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const VALID_MANIFEST_KEYS = new Set(["schemaVersion", "flags"]);
const VALID_FLAG_KEYS = new Set([
  "id",
  "kind",
  "releaseScope",
  "maturity",
  "defaultEnabled",
  "owner",
  "targetGate",
  "tickets",
  "rationale",
]);
const VALID_KINDS = new Set(["profile", "rule"]);
const VALID_RELEASE_SCOPES = new Set(["ga", "post-ga"]);
const VALID_MATURITIES = new Set(["experimental", "beta", "stable"]);
const FLAG_ID_PATTERN = /^(?:profile\.[a-z0-9]+(?:-[a-z0-9]+)*|rule\.acl\d{3})$/u;
const OWNER_PATTERN = /^@agent-context-lint\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const GATE_PATTERN = /^G[0-9]$/u;
const TICKET_PATTERN = /^[A-K](?:0[1-9]|1[0-9])$/u;

export class FeatureFlagManifestError extends Error {
  constructor(problems) {
    super(`Invalid feature flag manifest:\n- ${problems.join("\n- ")}`);
    this.name = "FeatureFlagManifestError";
    this.problems = Object.freeze([...problems]);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(record, validKeys) {
  return Object.keys(record).filter((key) => !validKeys.has(key));
}

function validateString(value, path, pattern, problems) {
  if (typeof value !== "string" || !pattern.test(value)) {
    problems.push(`${path} is invalid`);
    return false;
  }
  return true;
}

function validateFlag(flag, index, problems) {
  const path = `flags[${index}]`;
  if (!isRecord(flag)) {
    problems.push(`${path} must be an object`);
    return;
  }

  for (const key of unknownKeys(flag, VALID_FLAG_KEYS)) {
    problems.push(`${path}.${key} is not supported`);
  }

  const hasValidId = validateString(flag.id, `${path}.id`, FLAG_ID_PATTERN, problems);
  if (!VALID_KINDS.has(flag.kind)) {
    problems.push(`${path}.kind must be profile or rule`);
  } else if (hasValidId && !flag.id.startsWith(`${flag.kind}.`)) {
    problems.push(`${path}.kind does not match ${path}.id`);
  }
  if (!VALID_RELEASE_SCOPES.has(flag.releaseScope)) {
    problems.push(`${path}.releaseScope must be ga or post-ga`);
  }
  if (!VALID_MATURITIES.has(flag.maturity)) {
    problems.push(`${path}.maturity must be experimental, beta, or stable`);
  }
  if (typeof flag.defaultEnabled !== "boolean") {
    problems.push(`${path}.defaultEnabled must be a boolean`);
  }
  validateString(flag.owner, `${path}.owner`, OWNER_PATTERN, problems);
  validateString(flag.targetGate, `${path}.targetGate`, GATE_PATTERN, problems);

  if (!Array.isArray(flag.tickets) || flag.tickets.length === 0) {
    problems.push(`${path}.tickets must be a non-empty array`);
  } else {
    const uniqueTickets = new Set();
    for (const [ticketIndex, ticket] of flag.tickets.entries()) {
      if (typeof ticket !== "string" || !TICKET_PATTERN.test(ticket)) {
        problems.push(`${path}.tickets[${ticketIndex}] is invalid`);
      } else if (uniqueTickets.has(ticket)) {
        problems.push(`${path}.tickets contains duplicate ${ticket}`);
      }
      uniqueTickets.add(ticket);
    }
    const sortedTickets = [...flag.tickets].sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(flag.tickets) !== JSON.stringify(sortedTickets)) {
      problems.push(`${path}.tickets must be sorted`);
    }
  }

  if (
    (flag.maturity === "experimental" || flag.maturity === "beta") &&
    (typeof flag.rationale !== "string" || flag.rationale.trim().length === 0)
  ) {
    problems.push(`${path}.rationale is required before stable maturity`);
  }
  if (flag.maturity === "stable" && "rationale" in flag) {
    problems.push(`${path}.rationale must be removed at stable maturity`);
  }
}

export function validateFeatureManifest(manifest, options = {}) {
  const { mode = "development" } = options;
  const problems = [];

  if (mode !== "development" && mode !== "ga") {
    throw new TypeError(`Unsupported feature flag validation mode: ${mode}`);
  }
  if (!isRecord(manifest)) {
    throw new FeatureFlagManifestError(["manifest must be an object"]);
  }
  for (const key of unknownKeys(manifest, VALID_MANIFEST_KEYS)) {
    problems.push(`${key} is not supported`);
  }
  if (manifest.schemaVersion !== 1) {
    problems.push("schemaVersion must be 1");
  }
  if (!Array.isArray(manifest.flags)) {
    problems.push("flags must be an array");
  } else {
    manifest.flags.forEach((flag, index) => validateFlag(flag, index, problems));
    const ids = manifest.flags.map((flag) => flag?.id);
    const seenIds = new Set();
    for (const id of ids) {
      if (typeof id === "string" && seenIds.has(id)) {
        problems.push(`flags contains duplicate id ${id}`);
      }
      seenIds.add(id);
    }
    const sortedIds = [...ids].sort((left, right) =>
      String(left).localeCompare(String(right), "en"),
    );
    if (JSON.stringify(ids) !== JSON.stringify(sortedIds)) {
      problems.push("flags must be sorted by id");
    }

    if (mode === "ga") {
      for (const flag of manifest.flags) {
        if (
          flag?.releaseScope === "ga" &&
          (flag.defaultEnabled !== true || flag.maturity !== "stable")
        ) {
          problems.push(
            `${flag.id ?? "unknown flag"} is committed for GA but is not enabled and stable`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new FeatureFlagManifestError(problems);
  }
  return manifest;
}

export function resolveFeatureFlag(manifest, id, overrides = {}) {
  validateFeatureManifest(manifest);
  if (!isRecord(overrides)) {
    throw new TypeError("Feature flag overrides must be an object");
  }
  const flag = manifest.flags.find((candidate) => candidate.id === id);
  if (flag === undefined) {
    throw new TypeError(`Unknown feature flag: ${id}`);
  }
  const unknownOverrides = Object.keys(overrides).filter(
    (overrideId) => !manifest.flags.some((candidate) => candidate.id === overrideId),
  );
  if (unknownOverrides.length > 0) {
    throw new TypeError(`Unknown feature flag override: ${unknownOverrides[0]}`);
  }
  if (id in overrides && typeof overrides[id] !== "boolean") {
    throw new TypeError(`Feature flag override for ${id} must be a boolean`);
  }

  return Object.freeze({
    id,
    enabled: id in overrides ? overrides[id] : flag.defaultEnabled,
    reason: id in overrides ? "explicit-override" : "manifest-default",
    maturity: flag.maturity,
    releaseScope: flag.releaseScope,
  });
}

export async function readFeatureManifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseArguments(arguments_) {
  let mode = "development";
  let manifestPath = new URL("../config/feature-flags.json", import.meta.url);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--mode") {
      mode = arguments_[index + 1];
      index += 1;
    } else if (argument === "--manifest") {
      manifestPath = arguments_[index + 1];
      index += 1;
    } else {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
  }
  if (mode === undefined || manifestPath === undefined) {
    throw new TypeError("--mode and --manifest require a value");
  }
  return { mode, manifestPath };
}

async function main() {
  const { mode, manifestPath } = parseArguments(process.argv.slice(2));
  const manifest = await readFeatureManifest(manifestPath);
  validateFeatureManifest(manifest, { mode });
  process.stdout.write(
    `Feature flag manifest passed ${mode} validation (${manifest.flags.length} flags).\n`,
  );
}

const entryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
