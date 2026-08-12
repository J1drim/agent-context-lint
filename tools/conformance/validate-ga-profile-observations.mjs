#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  canonicalObservationJson,
  validateRealClientObservationPlan,
} from "./real-client-observation.mjs";
import { validateFixture, validateProfileMap } from "./validate-profile-contract.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;

export const GA_OBSERVATION_REVIEW_KIND = "ga-profile-observation-review";
export const GA_OBSERVATION_REVIEW_VERSION = "0.1.0";
export const GA_OBSERVATION_MAX_FILE_BYTES = 4 * 1024 * 1024;

const OFFICIAL_SOURCE_PREFIXES = new Map([
  ["claude-code", ["https://github.com/anthropics/claude-code/"]],
  ["codex-cli", ["https://github.com/openai/codex/"]],
  ["copilot-cli", ["https://github.com/github/copilot-cli/"]],
  ["copilot-vscode", ["https://github.com/microsoft/vscode-copilot-chat/"]],
  ["cursor-agent", ["https://cursor.com/"]],
  ["gemini-cli", ["https://github.com/google-gemini/gemini-cli/"]],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function canonicalRepositoryPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !path.posix.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    path.posix.normalize(value) === value &&
    value !== "." &&
    !value.startsWith("../")
  );
}

function readStableRepositoryFile(repositoryRoot, reference, location, errors) {
  if (
    reference === null ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    !canonicalRepositoryPath(reference.path)
  ) {
    errors.push(`${location}.path must be a canonical repository-relative path`);
    return undefined;
  }
  const absolute = path.resolve(repositoryRoot, ...reference.path.split("/"));
  const relative = path.relative(repositoryRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    errors.push(`${location}.path escapes the repository root`);
    return undefined;
  }
  let descriptor;
  try {
    const beforePath = lstatSync(absolute, { bigint: true });
    if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
      errors.push(`${location}.path must identify an ordinary non-symbolic-link file`);
      return undefined;
    }
    if (beforePath.size > BigInt(GA_OBSERVATION_MAX_FILE_BYTES)) {
      errors.push(`${location}.path exceeds ${GA_OBSERVATION_MAX_FILE_BYTES} bytes`);
      return undefined;
    }
    descriptor = openSync(absolute, "r");
    const before = fstatSync(descriptor, { bigint: true });
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      errors.push(`${location}.path changed before it was opened`);
      return undefined;
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(absolute, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      afterPath.isSymbolicLink() ||
      afterPath.dev !== before.dev ||
      afterPath.ino !== before.ino
    ) {
      errors.push(`${location}.path changed while it was read`);
      return undefined;
    }
    const digest = sha256(bytes);
    if (reference.sha256 !== digest) {
      errors.push(`${location}.sha256 does not match ${reference.path}`);
      return undefined;
    }
    return { absolute, bytes, digest };
  } catch {
    errors.push(`${location}.path could not be read safely`);
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(file, location, errors) {
  if (file === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
  } catch {
    errors.push(`${location}.path must contain valid UTF-8 JSON`);
    return undefined;
  }
}

function compileSchemas(repositoryRoot, errors) {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const loadSchema = (relative) =>
      JSON.parse(readFileSync(path.join(repositoryRoot, ...relative.split("/")), "utf8"));
    return {
      review: ajv.compile(
        loadSchema("conformance/contracts/ga-profile-observation-review.v0.schema.json"),
      ),
      plan: ajv.compile(
        loadSchema("conformance/contracts/real-client-observation-plan.v0.schema.json"),
      ),
      transcript: ajv.compile(
        loadSchema("conformance/contracts/real-client-observation-transcript.v0.schema.json"),
      ),
    };
  } catch {
    errors.push("observation schemas could not be compiled");
    return undefined;
  }
}

function schemaErrors(validator) {
  return (validator.errors ?? []).map(
    (error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`,
  );
}

function expectedFixtureManifest(plan) {
  return [...plan.fixtureFiles]
    .map((file) => ({
      markerId: file.markerId,
      path: file.path,
      sha256: sha256(Buffer.from(file.content, "utf8")),
    }))
    .sort((left, right) => compareUtf8(left.path, right.path));
}

function equalCanonical(left, right) {
  return canonicalObservationJson(left) === canonicalObservationJson(right);
}

function validatePlanTranscriptParity(entry, plan, transcript, location, errors) {
  for (const field of [
    "caseId",
    "contractVersion",
    "expectedLoadedSourceSequence",
    "observedAt",
    "operation",
    "profileId",
    "settingSources",
    "surfaceId",
  ]) {
    if (!equalCanonical(plan[field], transcript[field])) {
      errors.push(`${location} plan/transcript ${field} values differ`);
    }
  }
  if (plan.profileId !== entry.profileId || plan.surfaceId !== entry.surfaceId) {
    errors.push(`${location} plan profile/surface does not match the review entry`);
  }
  const manifest = expectedFixtureManifest(plan);
  const planDigest = sha256(Buffer.from(canonicalObservationJson(plan), "utf8"));
  const fixtureDigest = sha256(Buffer.from(canonicalObservationJson(manifest), "utf8"));
  if (transcript.planDigest !== planDigest)
    errors.push(`${location} transcript planDigest is stale`);
  if (transcript.fixtureDigest !== fixtureDigest)
    errors.push(`${location} transcript fixtureDigest is stale`);
  if (!equalCanonical(transcript.fixtureManifest, manifest))
    errors.push(`${location} transcript fixture manifest does not match the plan`);
  if (
    !Array.isArray(transcript.actualLoadedSourceSequence) ||
    transcript.actualLoadedSourceSequence.length !== 0
  ) {
    errors.push(`${location} D15 v0 transcript must not claim behavioral source loading`);
  }

  if (entry.observationScope === "version-metadata-only") {
    if (
      plan.operation !== "version-probe" ||
      transcript.result?.status !== "observed" ||
      transcript.result?.versionMatched !== true ||
      transcript.result?.workspaceUnchanged !== true ||
      entry.behavioralState !== "previously-observed-matching-fixture" ||
      !plan.client?.expectedVersion?.includes(entry.clientPin.version)
    ) {
      errors.push(`${location} metadata observation is not a successful matching version probe`);
    }
  } else if (
    plan.operation !== "blocked-paid-observation" ||
    transcript.result?.status !== "blocked" ||
    entry.behavioralState !== "explicit-unknown"
  ) {
    errors.push(`${location} blocked observation must remain an explicit unknown`);
  }
}

export function validateGaProfileObservationReview(
  review,
  { repositoryRoot = process.cwd() } = {},
) {
  const errors = [];
  let root;
  try {
    root = realpathSync(repositoryRoot);
  } catch {
    return Object.freeze(["repository root could not be resolved"]);
  }
  const validators = compileSchemas(root, errors);
  if (validators === undefined) return Object.freeze(errors);
  if (!validators.review(review)) errors.push(...schemaErrors(validators.review));
  if (errors.length > 0) return Object.freeze(errors);

  const inventoryFile = readStableRepositoryFile(root, review.inventory, "$.inventory", errors);
  const inventory = parseJson(inventoryFile, "$.inventory", errors);
  if (inventory === undefined) return Object.freeze(errors);
  const mapErrors = validateProfileMap(inventory);
  errors.push(...mapErrors.map((error) => `$.inventory ${error}`));
  if (mapErrors.length > 0) return Object.freeze(errors);

  const gaProfiles = new Set(
    inventory.profiles
      .filter((profile) => profile.releaseClass === "ga-required")
      .flatMap((profile) => profile.surfaceIds.map((surfaceId) => `${profile.id}\0${surfaceId}`)),
  );
  const surfaceMap = new Map(inventory.surfaces.map((surface) => [surface.id, surface]));
  const seenEntries = new Set();
  const seenFiles = new Set();

  for (const [index, entry] of review.entries.entries()) {
    const location = `$.entries[${index}]`;
    const pair = `${entry.profileId}\0${entry.surfaceId}`;
    if (!gaProfiles.has(pair)) errors.push(`${location} is not a GA profile/surface pair`);
    if (seenEntries.has(pair))
      errors.push(`${location} duplicates ${entry.profileId}/${entry.surfaceId}`);
    seenEntries.add(pair);
    if (entry.id !== `${entry.profileId}/${entry.surfaceId}`)
      errors.push(`${location}.id must equal the profile/surface pair`);

    const sourcePrefixes = OFFICIAL_SOURCE_PREFIXES.get(entry.profileId) ?? [];
    if (!sourcePrefixes.some((prefix) => entry.clientPin.sourceUrl.startsWith(prefix))) {
      errors.push(`${location}.clientPin.sourceUrl is not an approved first-party source`);
    }
    if (
      Date.parse(entry.clientPin.publishedAt ?? review.reviewedAt) > Date.parse(review.reviewedAt)
    ) {
      errors.push(`${location}.clientPin.publishedAt is after the review`);
    }
    if (entry.clientPin.retrievedAt !== review.reviewedAt.slice(0, 10)) {
      errors.push(`${location}.clientPin.retrievedAt must equal the review date`);
    }
    const mappedVersion = surfaceMap.get(entry.surfaceId)?.version;
    if (mappedVersion !== null && mappedVersion !== entry.clientPin.version) {
      errors.push(`${location}.clientPin.version differs from the canonical surface inventory`);
    }
    if (entry.behavioralState === "explicit-unknown" && entry.unresolvedClaimIds.length === 0) {
      errors.push(`${location}.unresolvedClaimIds must explain an explicit unknown`);
    }
    if (
      entry.behavioralState === "previously-observed-matching-fixture" &&
      entry.unresolvedClaimIds.length !== 0
    ) {
      errors.push(`${location}.unresolvedClaimIds must be empty for a matching fixture`);
    }
    if (entry.fixtureVersionRelation !== "exact" && entry.mismatches.length === 0) {
      errors.push(`${location}.mismatches must document non-exact fixture version evidence`);
    }

    const planFile = readStableRepositoryFile(root, entry.plan, `${location}.plan`, errors);
    const transcriptFile = readStableRepositoryFile(
      root,
      entry.transcript,
      `${location}.transcript`,
      errors,
    );
    const plan = parseJson(planFile, `${location}.plan`, errors);
    const transcript = parseJson(transcriptFile, `${location}.transcript`, errors);
    if (plan !== undefined) {
      if (!validators.plan(plan))
        errors.push(...schemaErrors(validators.plan).map((error) => `${location}.plan ${error}`));
      errors.push(
        ...validateRealClientObservationPlan(plan).map(
          (error) => `${location}.plan security contract: ${error}`,
        ),
      );
    }
    if (transcript !== undefined && !validators.transcript(transcript)) {
      errors.push(
        ...schemaErrors(validators.transcript).map((error) => `${location}.transcript ${error}`),
      );
    }
    if (plan !== undefined && transcript !== undefined) {
      validatePlanTranscriptParity(entry, plan, transcript, location, errors);
    }

    let sawUnpinnedFixture = false;
    for (const [fixtureIndex, reference] of entry.fixtures.entries()) {
      const referenceLocation = `${location}.fixtures[${fixtureIndex}]`;
      const fixtureFile = readStableRepositoryFile(root, reference, referenceLocation, errors);
      const fixture = parseJson(fixtureFile, referenceLocation, errors);
      if (fixture === undefined) continue;
      errors.push(
        ...validateFixture(fixture, inventory).map((error) => `${referenceLocation}: ${error}`),
      );
      if (
        fixture.profile?.profileId !== entry.profileId ||
        fixture.profile?.surfaceId !== entry.surfaceId
      ) {
        errors.push(`${referenceLocation} profile/surface does not match the review entry`);
      }
      if (fixture.profile?.clientVersion === null) sawUnpinnedFixture = true;
      if (
        entry.fixtureVersionRelation === "exact" &&
        fixture.profile?.clientVersion !== entry.clientPin.version
      ) {
        errors.push(`${referenceLocation} client version does not exactly match the pin`);
      }
    }
    if (entry.fixtureVersionRelation === "unpinned" && !sawUnpinnedFixture) {
      errors.push(`${location} claims an unpinned fixture but none has a null client version`);
    }

    for (const [evidenceIndex, reference] of entry.supportingEvidence.entries()) {
      readStableRepositoryFile(
        root,
        reference,
        `${location}.supportingEvidence[${evidenceIndex}]`,
        errors,
      );
    }

    for (const reference of [entry.plan, entry.transcript, ...entry.fixtures]) {
      if (seenFiles.has(reference.path))
        errors.push(`${location} reuses a plan, transcript, or fixture owned by another surface`);
      seenFiles.add(reference.path);
    }
  }

  for (const pair of gaProfiles) {
    if (!seenEntries.has(pair)) {
      const [profileId, surfaceId] = pair.split("\0");
      errors.push(`missing GA observation review for ${profileId}/${surfaceId}`);
    }
  }
  return Object.freeze(errors);
}

function loadReview(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length > GA_OBSERVATION_MAX_FILE_BYTES) throw new Error("review manifest is too large");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const [, , manifestPath, ...extra] = process.argv;
  if (manifestPath === undefined || extra.length > 0) {
    console.error("usage: validate-ga-profile-observations.mjs MANIFEST.json");
    process.exitCode = 2;
  } else {
    try {
      const review = loadReview(manifestPath);
      const errors = validateGaProfileObservationReview(review);
      if (errors.length > 0) {
        for (const error of errors) console.error(`${manifestPath}: ${error}`);
        process.exitCode = 1;
      } else {
        console.log(`valid ${manifestPath}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
