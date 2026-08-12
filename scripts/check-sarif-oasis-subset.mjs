import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import AjvDraft04 from "ajv-draft-04";
import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

const ROOT = new URL("../", import.meta.url);
const OFFICIAL_SCHEMA = new URL(
  "third_party/oasis-sarif-2.1.0-errata01/sarif-schema-2.1.0.json",
  ROOT,
);
const PROVENANCE = new URL("third_party/oasis-sarif-2.1.0-errata01/provenance.json", ROOT);
const CONTRACTS = [
  {
    name: "legacy product subset v1",
    schema: new URL("packages/core/schemas/sarif-output.v2.1.0.schema.json", ROOT),
    fixture: new URL("packages/core/test/fixtures/sarif-output.v1.valid.json", ROOT),
  },
  {
    name: "product subset v2",
    schema: new URL("packages/core/schemas/sarif-output.v2.1.0-product-v2.schema.json", ROOT),
    fixture: new URL("packages/core/test/fixtures/sarif-output.valid.json", ROOT),
  },
];
const SUBSET_PROFILE = new URL("config/sarif-oasis-2.1.0-errata01-subset.json", ROOT);

function fail(message) {
  throw new Error(`SARIF OASIS compatibility check failed: ${message}`);
}

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function validationFailure(label, errors) {
  const detail = JSON.stringify(errors ?? []);
  fail(`${label} rejected the committed fixture: ${detail}`);
}

function assertSubset(name, localNode, officialNode) {
  const localProperties = Object.keys(localNode.properties ?? {});
  const allowed = new Set(officialNode.allowedProperties);
  for (const property of localProperties) {
    if (!allowed.has(property)) fail(`${name}.${property} is not an official SARIF property`);
  }
  const localRequired = new Set(localNode.required ?? []);
  for (const property of officialNode.required) {
    if (!localRequired.has(property)) fail(`${name} omits official required property ${property}`);
  }
}

const officialBytes = readFileSync(OFFICIAL_SCHEMA);
const provenance = readJson(PROVENANCE);
const digest = createHash("sha256").update(officialBytes).digest("hex");
if (digest !== provenance.sha256) fail("vendored official schema digest differs from provenance");
if (officialBytes.byteLength !== provenance.byteLength)
  fail("vendored official schema byte length differs from provenance");

const officialSchema = JSON.parse(officialBytes.toString("utf8"));
if (officialSchema.$schema !== "http://json-schema.org/draft-04/schema#")
  fail("vendored official schema is not JSON Schema Draft-04");
if (officialSchema.id !== provenance.sourceUrl)
  fail("vendored official schema id differs from its immutable source URL");

const subsetProfile = readJson(SUBSET_PROFILE);
if (
  subsetProfile.source.url !== provenance.sourceUrl ||
  subsetProfile.source.sha256 !== provenance.sha256 ||
  subsetProfile.source.retrievedAt !== provenance.retrievedAt ||
  subsetProfile.source.schemaDialect !== provenance.schemaDialect
)
  fail("independent subset profile provenance differs from the vendored official schema");

// OASIS intentionally places some `required` constraints in `anyOf` branches whose
// `properties` declarations live in their parent schema. Draft-04 permits that form;
// Ajv's non-normative strictRequired lint does not.
const officialAjv = new AjvDraft04({ allErrors: true, strict: true, strictRequired: false });
addFormats(officialAjv);
const validateOfficial = officialAjv.compile(officialSchema);
const localAjv = new Ajv2020({ allErrors: true, strict: true });
for (const contract of CONTRACTS) {
  const fixture = readJson(contract.fixture);
  const localSchema = readJson(contract.schema);
  if (
    fixture.$schema !== provenance.sourceUrl ||
    localSchema.properties.$schema.const !== provenance.sourceUrl
  )
    fail(`${contract.name} must identify the pinned official schema`);
  if (!validateOfficial(fixture))
    validationFailure(
      `${contract.name} under the official OASIS Draft-04 schema`,
      validateOfficial.errors,
    );
  const invalidOfficialFixture = structuredClone(fixture);
  delete invalidOfficialFixture.runs;
  if (validateOfficial(invalidOfficialFixture))
    fail(`official validator accepted the ${contract.name} negative control without runs`);
  const validateLocal = localAjv.compile(localSchema);
  if (!validateLocal(fixture))
    validationFailure(
      `${contract.name} under its closed local Draft 2020-12 subset`,
      validateLocal.errors,
    );

  const run = localSchema.$defs.run;
  const tool = run.properties.tool;
  const driver = tool.properties.driver;
  const rule = localSchema.$defs.rule;
  const result = localSchema.$defs.result;
  const location = localSchema.$defs.location;
  const physical = localSchema.$defs.physicalLocation ?? location.properties.physicalLocation;
  const artifact = physical.properties.artifactLocation;
  const region = physical.properties.region;
  for (const [name, localNode] of [
    ["root", localSchema],
    ["run", run],
    ["tool", tool],
    ["toolComponent", driver],
    ["reportingDescriptor", rule],
    ["result", result],
    ["location", location],
    ["physicalLocation", physical],
    ["artifactLocation", artifact],
    ["region", region],
  ]) {
    assertSubset(name, localNode, subsetProfile.nodes[name]);
  }
  const messages = localSchema.$defs.message
    ? [localSchema.$defs.message]
    : [rule.properties.shortDescription, result.properties.message];
  for (const messageNode of messages) {
    assertSubset("message", messageNode, subsetProfile.nodes.message);
    for (const required of subsetProfile.invariants.multiformatMessageStringRequired) {
      if (!(messageNode.required ?? []).includes(required))
        fail(`message must require ${required}`);
    }
  }
  if (
    localSchema.properties.version.const !== subsetProfile.invariants.versionConst ||
    result.properties.relatedLocations.uniqueItems !==
      subsetProfile.invariants.relatedLocationsUniqueItems
  )
    fail(`${contract.name} differs from pinned OASIS invariants`);
}

process.stdout.write(
  `Committed SARIF v1 and v2 fixtures satisfy the byte-pinned official OASIS Draft-04 schema and local subsets (${digest}).\n`,
);
