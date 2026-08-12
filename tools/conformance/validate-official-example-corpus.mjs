#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateGaProfileObservationReview } from "./validate-ga-profile-observations.mjs";
import { validateFixture, validateProfileMap } from "./validate-profile-contract.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;

export const OFFICIAL_CORPUS_KIND = "official-example-conformance-corpus";
export const OFFICIAL_CORPUS_VERSION = "0.1.0";
export const OFFICIAL_CORPUS_MAX_FILE_BYTES = 4 * 1024 * 1024;

const SCHEMA_PATH = "conformance/contracts/official-example-conformance-corpus.v0.schema.json";
const INVENTORY_PATH = "conformance/contracts/profile-surface-map.v0.json";
const OBSERVATION_REVIEW_PATH = "conformance/observations/v0/d16/review.json";
const FIXTURE_DIRECTORY = "conformance/official-examples/v0/fixtures";
const COVERAGE_TAGS = Object.freeze([
  "activation",
  "ambiguity",
  "glob-edge-case",
  "import-behavior",
  "nested-discovery",
  "supported-location",
  "unsupported-field",
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
    if (beforePath.size > BigInt(OFFICIAL_CORPUS_MAX_FILE_BYTES)) {
      errors.push(`${location}.path exceeds ${OFFICIAL_CORPUS_MAX_FILE_BYTES} bytes`);
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
    if (reference.sha256 !== undefined && reference.sha256 !== digest) {
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

function schemaErrors(validator) {
  return (validator.errors ?? []).map(
    (error) => `${error.instancePath || "$"} ${error.message ?? "is invalid"}`,
  );
}

function compileSchema(repositoryRoot, errors) {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    return ajv.compile(JSON.parse(readFileSync(path.join(repositoryRoot, SCHEMA_PATH), "utf8")));
  } catch {
    errors.push("official-example corpus schema could not be compiled");
    return undefined;
  }
}

function capabilityId(surfaceId, formatId) {
  return `${surfaceId.replaceAll("/", ".")}--${formatId}`;
}

function selectedEvidenceStatus(support) {
  if (support.supportStatus !== "supported") return support.supportStatus;
  for (const status of ["contradiction", "model-selected", "conditional", "unknown"]) {
    if (support.evidenceStatus.includes(status)) return status;
  }
  if (support.evidenceStatus.includes("source-derived")) return "source-derived";
  if (support.evidenceStatus.includes("observed")) return "observed";
  return "documented";
}

function positiveExpectedState(support) {
  const status = selectedEvidenceStatus(support);
  if (["conditional", "contradiction", "model-selected", "not-listed", "unknown"].includes(status))
    return "indeterminate";
  if (status === "recognized-unsupported") return "not-selected";
  return "selected";
}

function nextMonthlyDate(value) {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u.exec(value);
  if (match === null) return undefined;
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const lastNextMonthDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastNextMonthDay)))
    .toISOString()
    .slice(0, 10);
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function validateFixtureInventory(root, fixtures, errors) {
  const expected = fixtures.map((fixture) => fixture.path).sort(compareUtf8);
  let actual;
  try {
    actual = readdirSync(path.join(root, ...FIXTURE_DIRECTORY.split("/")), {
      withFileTypes: true,
    })
      .filter((entry) => entry.name.endsWith(".fixture.json"))
      .map((entry) => {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          errors.push(`fixture directory entry ${entry.name} must be an ordinary file`);
        }
        return `${FIXTURE_DIRECTORY}/${entry.name}`;
      })
      .sort(compareUtf8);
  } catch {
    errors.push("official-example fixture directory could not be read safely");
    return;
  }
  if (!sameStringArray(actual, expected)) {
    errors.push("fixture directory contents do not exactly match the manifest");
  }
}

export function validateOfficialExampleCorpus(
  corpus,
  { asOf, repositoryRoot = process.cwd() } = {},
) {
  const errors = [];
  let root;
  try {
    root = realpathSync(repositoryRoot);
  } catch {
    return Object.freeze(["repository root could not be resolved"]);
  }
  const schema = compileSchema(root, errors);
  if (schema === undefined) return Object.freeze(errors);
  if (!schema(corpus)) errors.push(...schemaErrors(schema));
  if (errors.length > 0) return Object.freeze(errors);

  const expectedNextReview = nextMonthlyDate(corpus.review.reviewedAt);
  if (corpus.review.nextReviewDue !== expectedNextReview) {
    errors.push("$.review.nextReviewDue must be exactly one calendar month after reviewedAt");
  }
  if (asOf !== undefined) {
    const parsed = new Date(`${asOf}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(asOf) ||
      Number.isNaN(parsed.valueOf()) ||
      parsed.toISOString().slice(0, 10) !== asOf
    ) {
      errors.push("$options.asOf must be a valid YYYY-MM-DD date");
    } else if (asOf > corpus.review.nextReviewDue) {
      errors.push(`monthly review is overdue as of ${asOf}`);
    }
  }
  readStableRepositoryFile(
    root,
    { path: corpus.review.procedurePath },
    "$.review.procedurePath",
    errors,
  );

  if (corpus.inventory.path !== INVENTORY_PATH)
    errors.push(`$.inventory.path must equal ${INVENTORY_PATH}`);
  if (corpus.observationReview.path !== OBSERVATION_REVIEW_PATH)
    errors.push(`$.observationReview.path must equal ${OBSERVATION_REVIEW_PATH}`);
  const inventoryFile = readStableRepositoryFile(root, corpus.inventory, "$.inventory", errors);
  const observationFile = readStableRepositoryFile(
    root,
    corpus.observationReview,
    "$.observationReview",
    errors,
  );
  const inventory = parseJson(inventoryFile, "$.inventory", errors);
  const observationReview = parseJson(observationFile, "$.observationReview", errors);
  if (inventory === undefined || observationReview === undefined) return Object.freeze(errors);
  const mapErrors = validateProfileMap(inventory);
  errors.push(...mapErrors.map((error) => `$.inventory ${error}`));
  if (mapErrors.length > 0) return Object.freeze(errors);
  errors.push(
    ...validateGaProfileObservationReview(observationReview, { repositoryRoot: root }).map(
      (error) => `$.observationReview ${error}`,
    ),
  );

  const gaProfiles = inventory.profiles.filter((profile) => profile.releaseClass === "ga-required");
  const gaSurfaceIds = new Set(gaProfiles.flatMap((profile) => profile.surfaceIds));
  const expectedSupports = inventory.formatSupport.filter((support) =>
    gaSurfaceIds.has(support.surfaceId),
  );
  const surfaceById = new Map(inventory.surfaces.map((surface) => [surface.id, surface]));
  const researchById = new Map(inventory.researchRecords.map((record) => [record.id, record]));
  const fixturesById = new Map();
  const fixturePairs = new Set();
  const fixtureDocuments = new Map();
  validateFixtureInventory(root, corpus.fixtures, errors);

  for (const [index, reference] of corpus.fixtures.entries()) {
    const location = `$.fixtures[${index}]`;
    if (!reference.path.startsWith(`${FIXTURE_DIRECTORY}/`))
      errors.push(`${location}.path must stay inside ${FIXTURE_DIRECTORY}`);
    if (fixturesById.has(reference.id)) errors.push(`${location}.id duplicates ${reference.id}`);
    fixturesById.set(reference.id, reference);
    const pair = `${reference.surfaceId}\0${reference.polarity}`;
    if (fixturePairs.has(pair)) errors.push(`${location} duplicates the surface/polarity pair`);
    fixturePairs.add(pair);
    const file = readStableRepositoryFile(root, reference, location, errors);
    const fixture = parseJson(file, location, errors);
    if (fixture === undefined) continue;
    fixtureDocuments.set(reference.id, fixture);
    errors.push(...validateFixture(fixture, inventory).map((error) => `${location}: ${error}`));
    if (fixture.id !== reference.id) errors.push(`${location}.id does not match fixture.id`);
    if (
      fixture.profile?.profileId !== reference.profileId ||
      fixture.profile?.surfaceId !== reference.surfaceId
    ) {
      errors.push(`${location} profile/surface does not match the fixture`);
    }
    if (fixture.provenance?.derivation !== "official-example")
      errors.push(`${location} must use official-example derivation`);
    const extension = fixture.extensions?.["agent-context-lint.dev/k01"];
    if (extension?.polarity !== reference.polarity)
      errors.push(`${location} K01 polarity does not match the manifest`);
    if (!sameStringArray(extension?.coverageTags, COVERAGE_TAGS))
      errors.push(`${location} K01 coverage tags are incomplete or unordered`);
    const surface = surfaceById.get(reference.surfaceId);
    const allowedRecords = new Set(surface?.researchRecords ?? []);
    for (const recordId of fixture.provenance?.researchRecordIds ?? []) {
      if (!allowedRecords.has(recordId))
        errors.push(`${location} cites research not owned by its surface`);
      const record = researchById.get(recordId);
      if (record === undefined) continue;
      for (const source of fixture.provenance?.sources ?? []) {
        if (!record.primarySources.includes(source.url))
          errors.push(`${location} source URL is not in the canonical research record`);
        if (record.upstreamRevision !== null && source.revision !== record.upstreamRevision)
          errors.push(`${location} immutable source revision differs from the canonical record`);
      }
    }
  }

  for (const surfaceId of gaSurfaceIds) {
    for (const polarity of ["negative", "positive"]) {
      if (!fixturePairs.has(`${surfaceId}\0${polarity}`))
        errors.push(`missing ${polarity} official-example fixture for ${surfaceId}`);
    }
  }

  const supportsByKey = new Map(
    expectedSupports.map((support) => [`${support.surfaceId}\0${support.formatId}`, support]),
  );
  const seenCapabilities = new Set();
  const usedAssertions = new Map([...fixturesById.keys()].map((id) => [id, new Set()]));
  for (const [index, capability] of corpus.capabilities.entries()) {
    const location = `$.capabilities[${index}]`;
    const key = `${capability.surfaceId}\0${capability.formatId}`;
    const expected = supportsByKey.get(key);
    if (expected === undefined) {
      errors.push(`${location} is not a GA surface capability in the canonical inventory`);
      continue;
    }
    if (seenCapabilities.has(key)) errors.push(`${location} duplicates a GA capability`);
    seenCapabilities.add(key);
    const surface = surfaceById.get(capability.surfaceId);
    if (capability.id !== capabilityId(capability.surfaceId, capability.formatId))
      errors.push(`${location}.id is not the canonical capability identifier`);
    if (capability.profileId !== surface?.profileId)
      errors.push(`${location}.profileId does not own the surface`);
    if (capability.supportStatus !== expected.supportStatus)
      errors.push(`${location}.supportStatus differs from the canonical inventory`);
    if (!sameStringArray(capability.evidenceStatus, expected.evidenceStatus))
      errors.push(`${location}.evidenceStatus differs from the canonical inventory`);
    if (!sameStringArray(capability.coverageTags, COVERAGE_TAGS))
      errors.push(`${location}.coverageTags must contain the complete adapter matrix`);

    for (const polarity of ["negative", "positive"]) {
      const caseReference = capability[polarity];
      const caseLocation = `${location}.${polarity}`;
      const fixtureReference = fixturesById.get(caseReference.fixtureId);
      const fixture = fixtureDocuments.get(caseReference.fixtureId);
      if (fixtureReference === undefined || fixture === undefined) {
        errors.push(`${caseLocation}.fixtureId references an unavailable fixture`);
        continue;
      }
      if (
        fixtureReference.polarity !== polarity ||
        fixtureReference.profileId !== capability.profileId ||
        fixtureReference.surfaceId !== capability.surfaceId
      ) {
        errors.push(`${caseLocation}.fixtureId has the wrong polarity or profile owner`);
      }
      const assertion = fixture.assertions.find(
        (candidate) => candidate.id === caseReference.assertionId,
      );
      if (assertion === undefined) {
        errors.push(`${caseLocation}.assertionId does not exist in the fixture`);
        continue;
      }
      const used = usedAssertions.get(caseReference.fixtureId);
      if (used.has(assertion.id)) errors.push(`${caseLocation}.assertionId is reused`);
      used.add(assertion.id);
      const wantedState =
        polarity === "positive" ? positiveExpectedState(expected) : "not-selected";
      if (caseReference.expectedState !== wantedState)
        errors.push(`${caseLocation}.expectedState differs from the canonical support state`);
      if (
        assertion.predicate !== "profile-format-capability-outcome" ||
        assertion.expected?.selection !== wantedState ||
        assertion.expected?.supportStatus !== expected.supportStatus
      ) {
        errors.push(`${caseLocation}.assertionId does not prove the declared capability outcome`);
      }
      const wantedEvidence =
        polarity === "positive" ? selectedEvidenceStatus(expected) : "documented";
      if (assertion.evidenceStatus !== wantedEvidence)
        errors.push(`${caseLocation}.assertionId has the wrong evidence state`);
    }
  }

  for (const [key, support] of supportsByKey) {
    if (!seenCapabilities.has(key))
      errors.push(
        `missing positive and negative coverage for ${support.surfaceId}/${support.formatId}`,
      );
  }
  for (const [fixtureId, fixture] of fixtureDocuments) {
    const used = usedAssertions.get(fixtureId) ?? new Set();
    for (const assertion of fixture.assertions) {
      if (!used.has(assertion.id))
        errors.push(`fixture ${fixtureId} has unowned assertion ${assertion.id}`);
    }
  }
  return Object.freeze(errors);
}

function loadCorpus(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length > OFFICIAL_CORPUS_MAX_FILE_BYTES)
    throw new Error("corpus manifest is too large");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const manifestPath = args[0];
  const asOfIndex = args.indexOf("--as-of");
  const asOf = asOfIndex === -1 ? undefined : args[asOfIndex + 1];
  const expectedLength = asOfIndex === -1 ? 1 : 3;
  if (
    manifestPath === undefined ||
    args.length !== expectedLength ||
    asOfIndex === 0 ||
    (asOfIndex !== -1 && asOf === undefined)
  ) {
    console.error("usage: validate-official-example-corpus.mjs MANIFEST.json [--as-of YYYY-MM-DD]");
    process.exitCode = 2;
  } else {
    try {
      const corpus = loadCorpus(manifestPath);
      const errors = validateOfficialExampleCorpus(corpus, { asOf });
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
